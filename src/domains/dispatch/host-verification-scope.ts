// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { taskWorktreeManifestsChanged } from "../../tools/task-worktree-dependencies.js";
import type { DispatchRequest } from "./contract.js";

export type ResolvedCheck = NonNullable<DispatchRequest["resolvedVerification"]>[number];

/**
 * Per-task scoping of lint and format checks.
 *
 * A declared command check is a lint or format check when its command runs a
 * known file-taking linter or formatter (biome, eslint, prettier, ruff, black,
 * stylelint) directly, through `npx`/`bunx`, or through `pnpm|npm|yarn exec`;
 * or when it is exactly `pnpm run <script>` or `npm run <script>` and the
 * package.json script is a single such command with no shell operators,
 * quoting or globs (`biome check .`, not `biome check . && tsc`). The declared
 * id is not used: a name says nothing about how the command takes paths.
 *
 * For a task with a task worktree, such a check runs on the files the task
 * changed relative to its base commit (`git diff <base>` plus untracked files),
 * limited to those under the check's cwd: bare `.` path arguments are dropped
 * and each changed file is appended as `./<path>` (biome also gets
 * `--no-errors-on-unmatched`). A task that changed no such file passes the check
 * without running it. Every other check, typecheck included, runs whole-repo as
 * declared, and a whole-repo check takes the machine's verification slot (see
 * src/domains/dispatch/verification-slot.ts) while a scoped one does not.
 */
const LINT_FORMAT_TOOLS = new Set(["biome", "eslint", "prettier", "ruff", "black", "stylelint"]);

const SCRIPT_UNSAFE_RE = /[&|;<>`$()'"\\\n*?{}]/u;

const SCOPED_PATHS_MAX = 1_000;

/** Scoped checks whose task changed no file under them; they pass without running. */
export const nothingChanged = new WeakSet<ResolvedCheck>();

/** Checks narrowed to a task's changed files; they run without the verification slot. */
export const scopedToTask = new WeakSet<ResolvedCheck>();

/** Index of the linter or formatter in `argv`, or -1. */
function lintFormatToolIndex(argv: ReadonlyArray<string>): number {
	const head = basename(argv[0] ?? "");
	let index = 0;
	if (head === "npx" || head === "bunx") index = 1;
	else if ((head === "pnpm" || head === "npm" || head === "yarn") && argv[1] === "exec") index = 2;
	while (index > 0 && argv[index]?.startsWith("-") === true) index += 1;
	const tool = argv[index];
	return tool !== undefined && LINT_FORMAT_TOOLS.has(basename(tool)) ? index : -1;
}

/** The command a lint or format check runs when it can take paths, or null when it is not one. */
export function lintFormatScopeArgv(check: Pick<ResolvedCheck, "argv" | "cwd" | "kind">): string[] | null {
	if (check.kind !== undefined && check.kind !== "command") return null;
	if (lintFormatToolIndex(check.argv) >= 0) return [...check.argv];
	const [runner, verb, name, ...rest] = check.argv;
	const runnerName = basename(runner ?? "");
	if (runner === undefined || (runnerName !== "pnpm" && runnerName !== "npm") || verb !== "run") return null;
	if (name === undefined || rest.length > 0) return null;
	const segments = lintScriptSegments(check.cwd, name);
	if (segments === null) return null;
	return [runner, "exec", ...(runnerName === "npm" ? ["--"] : []), ...(segments[0] ?? [])];
}

/**
 * A package script's `&&`-joined commands as token lists when its first command
 * runs a known linter or formatter, else null. `biome check . && node --import
 * tsx scripts/check-hygiene.ts` yields the Biome run and the hygiene check.
 */
function lintScriptSegments(cwd: string, name: string): string[][] | null {
	let script: unknown;
	try {
		const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
			scripts?: Record<string, unknown>;
		};
		script = manifest.scripts?.[name];
	} catch {
		return null;
	}
	if (typeof script !== "string") return null;
	const parts = script.split("&&").map((part) => part.trim());
	if (parts.some((part) => part === "" || SCRIPT_UNSAFE_RE.test(part))) return null;
	const segments = parts.map((part) => part.split(/\s+/u));
	if (!LINT_FORMAT_TOOLS.has(segments[0]?.[0] ?? "")) return null;
	return segments;
}

/**
 * The whole-repo commands a package lint script runs after its linter, such
 * as the repository hygiene check, as checks of their own. Scoping narrows the
 * linter to the task's files; these still run on the whole task worktree and
 * are compared with the base like any whole-repo check.
 */
export function lintScriptFollowUpChecks(check: ResolvedCheck): ResolvedCheck[] {
	if (check.kind !== undefined && check.kind !== "command") return [];
	const [runner, verb, name, ...rest] = check.argv;
	const runnerName = basename(runner ?? "");
	if ((runnerName !== "pnpm" && runnerName !== "npm") || verb !== "run" || name === undefined || rest.length > 0)
		return [];
	const segments = lintScriptSegments(check.cwd, name);
	return (segments ?? []).slice(1).map((argv) => ({ ...check, check: `${check.check}: ${argv.join(" ")}`, argv }));
}

/** Absolute paths of the files a task worktree changed against its base, or null when Git cannot say. */
function taskChangedPaths(worktree: { path: string; base: string }): string[] | null {
	const git = (args: string[]) =>
		execFileSync("git", internalGitArgv(["-C", worktree.path, ...args]), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	try {
		const names = [
			...git(["diff", "--name-only", "--no-renames", "-z", worktree.base, "--"]).split("\0"),
			...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
		];
		const paths = new Set<string>();
		for (const name of names) {
			if (name === "") continue;
			const path = resolve(worktree.path, name);
			// A deleted file has nothing left to lint.
			if (statSync(path, { throwIfNoEntry: false })?.isFile() === true) paths.add(path);
		}
		return [...paths].sort();
	} catch {
		return null;
	}
}

/** The check to run for this task: a lint or format check narrowed to `changed`, else the check as declared. */
function scopeCheckToTask(check: ResolvedCheck, changed: ReadonlyArray<string> | null): ResolvedCheck {
	if (changed === null) return check;
	const argv = lintFormatScopeArgv(check);
	if (argv === null) return check;
	const inside = changed.flatMap((path) => {
		const rel = relative(check.cwd, path);
		return rel === "" || relativePathEscapes(rel) ? [] : [`./${rel}`];
	});
	if (inside.length > SCOPED_PATHS_MAX) return check;
	if (inside.length === 0) {
		const scoped = { ...check, argv: [...check.argv] };
		nothingChanged.add(scoped);
		return scoped;
	}
	const toolIndex = lintFormatToolIndex(argv);
	const scopedArgv = argv.filter((arg, index) => index <= toolIndex || (arg !== "." && arg !== "./"));
	if (basename(argv[toolIndex] ?? "") === "biome" && !scopedArgv.includes("--no-errors-on-unmatched"))
		scopedArgv.push("--no-errors-on-unmatched");
	const scoped = { ...check, argv: [...scopedArgv, ...inside] };
	scopedToTask.add(scoped);
	return scoped;
}

/** A request's declared checks as this task runs them; see {@link scopeCheckToTask}. */
export function taskChecks(request: Pick<DispatchRequest, "resolvedVerification" | "taskWorktree">): ResolvedCheck[] {
	const checks = request.resolvedVerification ?? [];
	const worktree = request.taskWorktree;
	if (worktree === undefined || !checks.some((check) => lintFormatScopeArgv(check) !== null)) return [...checks];
	// Scoping and the follow-up steps come from the worktree's package scripts, which the
	// worker can edit; once a manifest or package-manager config differs from the base,
	// every check runs exactly as declared.
	if (taskWorktreeManifestsChanged(worktree)) return [...checks];
	const changed = taskChangedPaths(worktree);
	return checks.flatMap((check) => {
		const scoped = scopeCheckToTask(check, changed);
		return scoped === check ? [check] : [scoped, ...lintScriptFollowUpChecks(check)];
	});
}
