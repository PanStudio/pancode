// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `services.worktrees`: detached git worktrees of the workspace's repository that the host creates for an extension
 * under the project's `.pancode/worktrees/ext-<id>/`, beside task and research worktrees, the few writes an experiment needs in them (checkout, clean, copy, commit), refs under the
 * extension's own `refs/heads/pancode/<id>/` namespace, and read-only git anywhere it may look. Every call goes through
 * the internal git argv, so repository configuration never runs a program, and a worktree the request did not keep is
 * removed when the request ends.
 */
import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ExtensionGitResult, ExtensionWorkPlace, ExtensionWorktree } from "@pancode/sdk/extension";
import { withoutRepositoryEnv } from "../../../core/internal-git.js";
import { gitExecFile } from "../../../core/internal-git-run.js";
import { taskWorktreeClaimParent } from "../../../core/task-worktree-claim.js";
import { excludeProjectWorktreesFromStatus } from "../../../tools/task-worktree.js";
import { hostCommitIdentity } from "../../../tools/worktree-commit.js";
import type { ExtensionRequestScope } from "./scope.js";

export interface ExtensionWorktreeServiceDeps {
	extensionId: string;
	workspace: string;
	gitTimeoutMs?: number;
	readOnly?: () => boolean;
}

export interface ExtensionWorktreeService {
	create(
		options?: { base?: string; copy?: ReadonlyArray<string>; keep?: boolean },
		scope?: ExtensionRequestScope,
	): Promise<ExtensionWorktree>;
	list(): Promise<ExtensionWorktree[]>;
	remove(id: string): Promise<void>;
	git(place: ExtensionWorkPlace, args: ReadonlyArray<string>): Promise<ExtensionGitResult>;
	checkout(id: string, commit: string): Promise<void>;
	clean(id: string, options?: { keep?: ReadonlyArray<string> }): Promise<void>;
	copy(id: string, paths: ReadonlyArray<string>): Promise<void>;
	commit(
		id: string,
		message: string,
		options?: { leaveOut?: ReadonlyArray<string> },
	): Promise<{ head: string; leftOut: string[] }>;
	refs: {
		get(name: string): Promise<string | null>;
		create(name: string, commit: string): Promise<void>;
		swap(name: string, to: string, from: string, message: string): Promise<boolean>;
	};
	/** The directory a place names: `cwd` to work in and `root`, the checkout it lies in. */
	resolvePlace(place: ExtensionWorkPlace): Promise<{ cwd: string; root: string }>;
	/** Remove every worktree this service created and did not keep. */
	dispose(): Promise<void>;
}

export class ExtensionWorktreeError extends Error {
	constructor(
		readonly code: "invalid" | "refused" | "no_repository" | "unknown_worktree" | "git_failed",
		message: string,
	) {
		super(message);
		this.name = "ExtensionWorktreeError";
	}
}

const READ_SUBCOMMANDS = new Set([
	"rev-parse",
	"ls-tree",
	"ls-files",
	"status",
	"diff",
	"log",
	"show",
	"cat-file",
	"merge-base",
]);
/** Options that would write a file, run a program or read outside the repository. */
const REFUSED_OPTION =
	/^(?:--batch|--output|--ext-diff|--textconv|--filters|--exec|--show-signature|--no-index|--open-files-in-pager|-O|-X|--exclude-from|--exclude-per-directory|--resolve-git-dir|--stdin|--pathspec-from-file|--git-dir|--work-tree)/u;
const REVISION = /^(?![-/])(?!.*\.\.)[A-Za-z0-9._/@{}^~:+-]{1,200}$/u;
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const WORKTREE_ID = /^[kt]-[0-9a-f]{16}$/u;
/** What one `create` or `copy` call copies in at most. */
export const MAX_COPY_FILES = 256;
export const MAX_COPY_BYTES = 32 * 1024 * 1024;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

function isWithin(rootReal: string, candidateReal: string): boolean {
	return candidateReal === rootReal || candidateReal.startsWith(`${rootReal}${sep}`);
}

/** Resolve `target` through its nearest existing ancestor so symlinks cannot escape `rootReal`. */
function realThroughAncestor(target: string): string {
	const pending: string[] = [];
	let cursor = resolve(target);
	for (;;) {
		try {
			const real = realpathSync(cursor);
			return pending.length === 0 ? real : join(real, ...pending.reverse());
		} catch {
			const parent = resolve(cursor, "..");
			if (parent === cursor) return resolve(target);
			pending.push(relative(parent, cursor));
			cursor = parent;
		}
	}
}

/** Refuse any git path argument that names an absolute path, traverses past `realRoot`, or follows a symlink out of it. */
function assertGitPathInCheckout(raw: string, realCwd: string, realRoot: string): void {
	// Strip git pathspec magic like `:(top,literal)foo` or `:/foo`.
	let pathPart = raw;
	if (pathPart.startsWith(":(")) {
		const close = pathPart.indexOf(")");
		if (close < 0) throw new ExtensionWorktreeError("refused", `git: malformed pathspec '${raw}'`);
		pathPart = pathPart.slice(close + 1);
	} else if (pathPart.startsWith(":/")) {
		pathPart = pathPart.slice(2);
	}
	if (pathPart.length === 0) return;
	if (
		pathPart.includes("\0") ||
		isAbsolute(pathPart) ||
		pathPart.startsWith("/") ||
		pathPart.startsWith("~") ||
		/^[A-Za-z]:[\\/]/u.test(pathPart)
	)
		throw new ExtensionWorktreeError("refused", `git: path '${raw}' lies outside the repository`);
	const base = raw.startsWith(":/") || /^:\([^)]*\btop\b/u.test(raw) ? realRoot : realCwd;
	const resolved = resolve(base, pathPart);
	if (!isWithin(realRoot, resolved) || !isWithin(realRoot, realThroughAncestor(resolved)))
		throw new ExtensionWorktreeError("refused", `git: path '${raw}' lies outside the repository`);
}

function revision(field: string, value: unknown): string {
	if (typeof value !== "string" || !REVISION.test(value))
		throw new ExtensionWorktreeError("invalid", `${field} must be a revision`);
	return value;
}

/** A relative path that stays where it is put: no absolute path, no `..`, no empty name. */
function inside(field: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0"))
		throw new ExtensionWorktreeError("invalid", `${field} must be a relative path`);
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	const normalized = normalize(trimmed);
	if (isAbsolute(trimmed) || normalized.split(sep).includes("..") || normalized === ".")
		throw new ExtensionWorktreeError("invalid", `${field} must be a relative path inside the checkout`);
	return value;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** An exclude pattern that matches exactly one repository-relative entry. */
function exactPattern(entry: string): string {
	return `/${entry.replace(/[\\*?[\]]/gu, (char) => `\\${char}`)}`;
}

export function createExtensionWorktreeService(deps: ExtensionWorktreeServiceDeps): ExtensionWorktreeService {
	const timeout = deps.gitTimeoutMs ?? 60_000;
	const refPrefix = `refs/heads/pancode/${deps.extensionId}/`;
	const identity = `pancode-${deps.extensionId}`;
	const owned = new Set<string>();
	const removing = new Map<string, Promise<void>>();
	const assertWritable = (): void => {
		if (deps.readOnly?.() === true)
			throw new ExtensionWorktreeError("refused", "worktree writes are refused in a read-only session");
	};
	// Under the project, not PanCode's state: a run in a worktree writes there, and the safety floor refuses any
	// write into PanCode's own trees.
	let repository: Promise<{ root: string; prefix: string; parent: string }> | null = null;

	const run = (cwd: string, args: ReadonlyArray<string>): Promise<ExtensionGitResult> =>
		new Promise((done) => {
			gitExecFile(
				["-C", cwd, ...args],
				{ timeout, maxBuffer: MAX_GIT_OUTPUT, env: withoutRepositoryEnv(), encoding: "utf8" },
				(error, stdout, stderr) => {
					const code = (error as { code?: unknown } | null)?.code;
					done({
						exitCode: error === null ? 0 : typeof code === "number" ? code : 1,
						stdout,
						stderr: error !== null && stderr.length === 0 ? error.message : stderr,
					});
				},
			);
		});

	const must = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
		const result = await run(cwd, args);
		if (result.exitCode !== 0) {
			const line = result.stderr.split(/\r?\n/u).find((entry) => entry.trim().length > 0) ?? "failed";
			throw new ExtensionWorktreeError("git_failed", `git ${args[0]}: ${line.trim()}`);
		}
		return result.stdout;
	};

	const repo = (): Promise<{ root: string; prefix: string; parent: string }> => {
		repository ??= (async () => {
			const out = await run(deps.workspace, ["rev-parse", "--show-toplevel", "--show-prefix"]);
			if (out.exitCode !== 0)
				throw new ExtensionWorktreeError("no_repository", "the workspace is not inside a git repository");
			const [top = "", prefix = ""] = out.stdout.split("\n");
			const root = resolve(top);
			return {
				root,
				prefix: prefix.replace(/\/+$/u, ""),
				parent: join(taskWorktreeClaimParent(root), `ext-${deps.extensionId}`),
			};
		})();
		repository.catch(() => {
			repository = null;
		});
		return repository;
	};

	const describe = async (id: string, path: string, head?: string): Promise<ExtensionWorktree> => {
		const { prefix } = await repo();
		return {
			id,
			path,
			cwd: prefix.length > 0 ? join(path, prefix) : path,
			head: head ?? (await must(path, ["rev-parse", "HEAD"])).trim(),
			kept: id.startsWith("k-"),
		};
	};

	/** Worktrees of this repository under the extension's directory, by id. */
	const registered = async (): Promise<Map<string, { path: string; head: string }>> => {
		const { root, parent } = await repo();
		const found = new Map<string, { path: string; head: string }>();
		if (!existsSync(parent)) return found;
		const real = realpathSync(parent);
		let path: string | null = null;
		for (const line of (await must(root, ["worktree", "list", "--porcelain"])).split("\n")) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
			else if (line.startsWith("HEAD ") && path !== null) {
				const id = relative(real, existsSync(path) ? realpathSync(path) : path);
				if (WORKTREE_ID.test(id)) found.set(id, { path: join(parent, id), head: line.slice(5) });
				path = null;
			}
		}
		return found;
	};

	const lookup = async (id: unknown): Promise<{ path: string; head: string }> => {
		if (typeof id !== "string" || !WORKTREE_ID.test(id) || (id.startsWith("t-") && !owned.has(id)))
			throw new ExtensionWorktreeError("unknown_worktree", `no worktree ${String(id)}`);
		const entry = (await registered()).get(id);
		if (entry === undefined) throw new ExtensionWorktreeError("unknown_worktree", `no worktree ${id}`);
		return entry;
	};

	const removeAt = (id: string): Promise<void> => {
		const active = removing.get(id);
		if (active !== undefined) return active;
		const task = (async () => {
			const { root, parent } = await repo();
			const path = join(parent, id);
			try {
				if (existsSync(path)) await must(root, ["worktree", "remove", "--force", path]);
			} finally {
				await run(root, ["worktree", "prune"]);
				rmSync(`${path}.owner`, { force: true });
				owned.delete(id);
			}
		})();
		removing.set(id, task);
		void task.finally(() => removing.delete(id));
		return task;
	};

	/** A worktree a crashed process created and did not keep. */
	const pruneOrphans = async (): Promise<void> => {
		const { parent } = await repo();
		if (!existsSync(parent)) return;
		for (const name of readdirSync(parent)) {
			if (!name.endsWith(".owner")) continue;
			const id = name.slice(0, -".owner".length);
			if (!WORKTREE_ID.test(id) || owned.has(id)) continue;
			const pid = Number(readFileSync(join(parent, name), "utf8"));
			if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
			await removeAt(id).catch(() => undefined);
		}
	};

	const copyInto = async (path: string, files: ReadonlyArray<string>): Promise<void> => {
		if (!Array.isArray(files) || files.length > MAX_COPY_FILES)
			throw new ExtensionWorktreeError("invalid", `copy takes at most ${MAX_COPY_FILES} paths`);
		const { prefix } = await repo();
		const workspaceReal = realpathSync(deps.workspace);
		const base = realpathSync(path);
		let bytes = 0;
		for (const file of files) {
			const name = inside("copy path", file);
			const source = join(deps.workspace, name);
			const stat = lstatSync(source, { throwIfNoEntry: false });
			if (stat?.isFile() !== true)
				throw new ExtensionWorktreeError("invalid", `copy: ${name} is not a regular file in the workspace`);
			if (!isWithin(workspaceReal, realpathSync(source)))
				throw new ExtensionWorktreeError("refused", `copy: ${name} resolves outside the workspace`);
			bytes += stat.size;
			if (bytes > MAX_COPY_BYTES) throw new ExtensionWorktreeError("invalid", "copy: more than 32 MiB");
			const parts = normalize(join(prefix, name))
				.split(sep)
				.filter((part) => part.length > 0);
			const leaf = parts.pop() as string;
			let dir = base;
			for (const part of parts) {
				dir = join(dir, part);
				const existing = lstatSync(dir, { throwIfNoEntry: false });
				if (existing === undefined) mkdirSync(dir);
				else if (!existing.isDirectory())
					throw new ExtensionWorktreeError("refused", `copy: ${relative(base, dir)} is not a directory`);
			}
			const target = join(dir, leaf);
			if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) unlinkSync(target);
			writeFileSync(target, readFileSync(source), { flag: "wx" });
		}
	};

	const refName = (name: unknown): string => {
		if (typeof name !== "string" || !REF_NAME.test(name) || name.endsWith(".lock") || name.length > 200)
			throw new ExtensionWorktreeError("invalid", "ref name must be slash-separated words");
		return `${refPrefix}${name}`;
	};

	const commitOf = async (cwd: string, rev: string): Promise<string> =>
		(await must(cwd, ["rev-parse", "--verify", "--quiet", `${revision("commit", rev)}^{commit}`])).trim();

	const service: ExtensionWorktreeService = {
		async create(options = {}, scope) {
			assertWritable();
			if (scope?.signal.aborted === true)
				throw new ExtensionWorktreeError("refused", "worktrees.create: the request has ended");
			const { root, parent } = await repo();
			const sha = await commitOf(root, options.base ?? "HEAD");
			const keep = options.keep === true;
			await pruneOrphans();
			mkdirSync(parent, { recursive: true });
			excludeProjectWorktreesFromStatus(root);
			const id = `${keep ? "k" : "t"}-${randomBytes(8).toString("hex")}`;
			const path = join(parent, id);
			if (!keep) {
				writeFileSync(`${path}.owner`, String(process.pid));
				owned.add(id);
				scope?.defer(() => removeAt(id));
			}
			try {
				await must(root, ["worktree", "add", "--detach", "--quiet", path, sha]);
				if (options.copy !== undefined) await copyInto(path, options.copy);
			} catch (error) {
				await removeAt(id).catch(() => undefined);
				throw error;
			}
			return describe(id, path, sha);
		},

		async list() {
			const out: ExtensionWorktree[] = [];
			for (const [id, entry] of await registered())
				if (id.startsWith("k-") || owned.has(id)) out.push(await describe(id, entry.path, entry.head));
			return out;
		},

		async remove(id) {
			assertWritable();
			await lookup(id);
			await removeAt(id);
		},

		async git(place, args) {
			if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
				throw new ExtensionWorktreeError("invalid", "git: args must be strings");
			const [subcommand] = args;
			if (subcommand === undefined || !READ_SUBCOMMANDS.has(subcommand))
				throw new ExtensionWorktreeError("refused", `git: ${String(subcommand)} is not a read this service runs`);
			const resolvedPlace = await service.resolvePlace(place);
			const checkoutRoot = place === "workspace" ? (await repo()).root : resolvedPlace.root;
			const realRoot = realpathSync(checkoutRoot);
			const realCwd = realThroughAncestor(resolvedPlace.cwd);
			let afterDoubleDash = false;
			for (const arg of args.slice(1)) {
				if (!afterDoubleDash && arg === "--") {
					afterDoubleDash = true;
					continue;
				}
				if (!afterDoubleDash && REFUSED_OPTION.test(arg))
					throw new ExtensionWorktreeError("refused", `git: ${arg} is refused`);
				// After `--` every argument is a pathspec; for `diff`, external non-option args silently enable `--no-index`.
				if (afterDoubleDash || (subcommand === "diff" && !arg.startsWith("-")))
					assertGitPathInCheckout(arg, realCwd, realRoot);
			}
			return run(resolvedPlace.cwd, args);
		},

		async checkout(id, commit) {
			assertWritable();
			const { path } = await lookup(id);
			await must(path, ["checkout", "--quiet", "--detach", await commitOf(path, commit)]);
		},

		async clean(id, options = {}) {
			assertWritable();
			const { path } = await lookup(id);
			const keep = (options.keep ?? []).map((entry) => inside("keep entry", entry));
			await must(path, ["clean", "-ffdxq", ...keep.flatMap((entry) => ["-e", exactPattern(entry)])]);
		},

		async copy(id, paths) {
			assertWritable();
			await copyInto((await lookup(id)).path, paths);
		},

		async commit(id, message, options = {}) {
			assertWritable();
			const { path } = await lookup(id);
			if (typeof message !== "string" || message.trim().length === 0 || message.length > 64 * 1024)
				throw new ExtensionWorktreeError("invalid", "commit: message must be non-empty text");
			const entries = new Set((options.leaveOut ?? []).map((entry) => inside("leaveOut entry", entry)));
			const leftOut = (await must(path, ["ls-files", "--others", "--exclude-standard", "-z"]))
				.split("\0")
				.filter(
					(file) =>
						file.length > 0 &&
						(entries.has(file) || [...entries].some((entry) => entry.endsWith("/") && file.startsWith(entry))),
				);
			await must(path, ["add", "--all"]);
			if (leftOut.length > 0) await must(path, ["reset", "--quiet", "--", ...leftOut.map((file) => `:(literal)${file}`)]);
			if ((await must(path, ["diff", "--cached", "--name-only"])).trim().length > 0)
				await must(path, [...hostCommitIdentity(path, identity), "commit", "--quiet", "--no-verify", "-m", message]);
			return { head: (await must(path, ["rev-parse", "HEAD"])).trim(), leftOut };
		},

		refs: {
			async get(name) {
				const { root } = await repo();
				const result = await run(root, ["rev-parse", "--verify", "--quiet", `${refName(name)}^{commit}`]);
				return result.exitCode === 0 ? result.stdout.trim() : null;
			},
			async create(name, commit) {
				assertWritable();
				const { root } = await repo();
				const ref = refName(name);
				await must(root, ["update-ref", "-m", `${identity}: create`, ref, await commitOf(root, commit), ""]);
			},
			async swap(name, to, from, message) {
				assertWritable();
				const { root } = await repo();
				const ref = refName(name);
				const result = await run(root, [
					"update-ref",
					"-m",
					typeof message === "string" && message.length > 0 ? message.slice(0, 500) : `${identity}: move`,
					ref,
					await commitOf(root, to),
					await commitOf(root, from),
				]);
				return result.exitCode === 0;
			},
		},

		async resolvePlace(place) {
			if (place === "workspace") return { cwd: deps.workspace, root: deps.workspace };
			if (typeof place !== "object" || place === null || !("worktree" in place))
				throw new ExtensionWorktreeError("invalid", "a place here is 'workspace' or { worktree }");
			const entry = await lookup(place.worktree);
			const { prefix } = await repo();
			const rootReal = realpathSync(entry.path);
			const base = prefix.length > 0 ? join(entry.path, prefix) : entry.path;
			const cwd = place.sub === undefined ? base : join(base, inside("sub", place.sub));
			if (!isWithin(rootReal, realThroughAncestor(cwd)))
				throw new ExtensionWorktreeError("refused", "place resolves outside the worktree");
			return { cwd, root: entry.path };
		},

		async dispose() {
			for (const id of [...owned]) await removeAt(id).catch(() => undefined);
		},
	};
	return service;
}
