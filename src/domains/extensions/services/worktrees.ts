// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `services.worktrees`: detached git worktrees of the workspace's repository that the host creates for an extension
 * under its store directory, the few writes an experiment needs in them (checkout, clean, copy, commit), refs under the
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
import { hostCommitIdentity } from "../../../tools/worktree-commit.js";
import type { ExtensionRequestScope } from "./scope.js";

export interface ExtensionWorktreeServiceDeps {
	extensionId: string;
	workspace: string;
	storeDir: string;
	gitTimeoutMs?: number;
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
	/^(?:--batch|--output|--ext-diff|--textconv|--filters|--exec|--show-signature|--no-index|--open-files-in-pager|-O|--git-dir|--work-tree)/u;
const REVISION = /^(?![-/])(?!.*\.\.)[A-Za-z0-9._/@{}^~:+-]{1,200}$/u;
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const WORKTREE_ID = /^[kt]-[0-9a-f]{16}$/u;
const MAX_COPY_FILES = 256;
const MAX_COPY_BYTES = 32 * 1024 * 1024;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

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
	const parent = join(deps.storeDir, "worktrees");
	const refPrefix = `refs/heads/pancode/${deps.extensionId}/`;
	const identity = `pancode-${deps.extensionId}`;
	const owned = new Set<string>();
	let repository: Promise<{ root: string; prefix: string }> | null = null;

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

	const repo = (): Promise<{ root: string; prefix: string }> => {
		repository ??= (async () => {
			const out = await run(deps.workspace, ["rev-parse", "--show-toplevel", "--show-prefix"]);
			if (out.exitCode !== 0)
				throw new ExtensionWorktreeError("no_repository", "the workspace is not inside a git repository");
			const [root = "", prefix = ""] = out.stdout.split("\n");
			return { root: resolve(root), prefix: prefix.replace(/\/+$/u, "") };
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
		const { root } = await repo();
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

	const removeAt = async (id: string): Promise<void> => {
		const { root } = await repo();
		const path = join(parent, id);
		try {
			if (existsSync(path)) await must(root, ["worktree", "remove", "--force", path]);
		} finally {
			await run(root, ["worktree", "prune"]);
			rmSync(`${path}.owner`, { force: true });
			owned.delete(id);
		}
	};

	/** A worktree a crashed process created and did not keep. */
	const pruneOrphans = async (): Promise<void> => {
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
		const base = realpathSync(path);
		let bytes = 0;
		for (const file of files) {
			const name = inside("copy path", file);
			const source = join(deps.workspace, name);
			const stat = lstatSync(source, { throwIfNoEntry: false });
			if (stat?.isFile() !== true)
				throw new ExtensionWorktreeError("invalid", `copy: ${name} is not a regular file in the workspace`);
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
			if (scope?.signal.aborted === true)
				throw new ExtensionWorktreeError("refused", "worktrees.create: the request has ended");
			const { root } = await repo();
			const sha = await commitOf(root, options.base ?? "HEAD");
			const keep = options.keep === true;
			await pruneOrphans();
			mkdirSync(parent, { recursive: true });
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
			await lookup(id);
			await removeAt(id);
		},

		async git(place, args) {
			if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
				throw new ExtensionWorktreeError("invalid", "git: args must be strings");
			const [subcommand] = args;
			if (subcommand === undefined || !READ_SUBCOMMANDS.has(subcommand))
				throw new ExtensionWorktreeError("refused", `git: ${String(subcommand)} is not a read this service runs`);
			const refused = args.find((arg) => REFUSED_OPTION.test(arg));
			if (refused !== undefined) throw new ExtensionWorktreeError("refused", `git: ${refused} is refused`);
			return run((await service.resolvePlace(place)).cwd, args);
		},

		async checkout(id, commit) {
			const { path } = await lookup(id);
			await must(path, ["checkout", "--quiet", "--detach", await commitOf(path, commit)]);
		},

		async clean(id, options = {}) {
			const { path } = await lookup(id);
			const keep = (options.keep ?? []).map((entry) => inside("keep entry", entry));
			await must(path, ["clean", "-ffdxq", ...keep.flatMap((entry) => ["-e", exactPattern(entry)])]);
		},

		async copy(id, paths) {
			await copyInto((await lookup(id)).path, paths);
		},

		async commit(id, message, options = {}) {
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
				const { root } = await repo();
				const ref = refName(name);
				await must(root, ["update-ref", "-m", `${identity}: create`, ref, await commitOf(root, commit), ""]);
			},
			async swap(name, to, from, message) {
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
			if (typeof place !== "object" || place === null)
				throw new ExtensionWorktreeError("invalid", "a place is 'workspace' or { worktree }");
			const entry = await lookup(place.worktree);
			const { prefix } = await repo();
			const base = prefix.length > 0 ? join(entry.path, prefix) : entry.path;
			return { cwd: place.sub === undefined ? base : join(base, inside("sub", place.sub)), root: entry.path };
		},

		async dispose() {
			for (const id of [...owned]) await removeAt(id).catch(() => undefined);
		},
	};
	return service;
}
