// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { relativePathEscapes } from "../core/path-containment.js";
import { SAFE_TASK_RUN_ID, TASK_WORKTREE_KIND, TASK_WORKTREE_OWNER_SUFFIX } from "../core/task-worktree-claim.js";
import type { TaskWorktree, TaskWorktreeApply, TaskWorktreeReceipt } from "./task-worktree.js";
import type { TaskWorktreePreview } from "./task-worktree-preview.js";
import { WORKTREE_HEAD_MOVED } from "./task-worktree-reasons.js";
import { git, gitFailureReason, isCanonicalWorktreePathInside } from "./worktree-git.js";
import { diskWorktreeParent } from "./worktree-root.js";

export const SAFE_RUN_ID = SAFE_TASK_RUN_ID;

export const OWNER_FILE_SUFFIX = TASK_WORKTREE_OWNER_SUFFIX;

/** The claim always lives on disk with the repository, wherever the working tree is. */
export function claimPathFor(root: string, runId: string): string {
	return join(diskWorktreeParent(root), `${runId}${OWNER_FILE_SUFFIX}`);
}

export function assertOwnership(worktree: TaskWorktree): void {
	const parent = worktree.parent ?? diskWorktreeParent(worktree.root);
	const expected = join(parent, worktree.runId);
	if (resolve(worktree.path) !== resolve(expected) || !isCanonicalWorktreePathInside(parent, worktree.path)) {
		throw new Error(`task worktree ${worktree.runId} has an invalid ownership path`);
	}
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	if (!existsSync(ownerPath)) throw new Error(`task worktree ${worktree.runId} has no ownership file`);
	let marker: Record<string, unknown>;
	try {
		const value = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
		marker = value as Record<string, unknown>;
	} catch {
		throw new Error(`task worktree ${worktree.runId} has an invalid ownership file`);
	}
	if (
		marker.version !== 2 ||
		marker.kind !== TASK_WORKTREE_KIND ||
		marker.root !== worktree.root ||
		marker.runId !== worktree.runId ||
		marker.branch !== worktree.branch ||
		marker.base !== worktree.base ||
		marker.ownerToken !== worktree.ownerToken ||
		marker.path !== worktree.path
	) {
		throw new Error(`task worktree ${worktree.runId} ownership facts do not match`);
	}
}

function canonicalOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

type TaskHeadCheck = { ok: true; commit: string } | { ok: false; detail: string };

function headMovedDetail(worktree: TaskWorktree, actual: string, candidate: string | null): string {
	return `${WORKTREE_HEAD_MOVED}: task worktree ${worktree.runId} expected HEAD refs/heads/${worktree.branch}, found ${actual}; candidate commit ${candidate ?? "none"}. Nothing was committed or merged; the worktree and its branch are preserved.`;
}

/**
 * Whether the working tree at `worktree.path` is still this run's task
 * worktree with HEAD on its own branch. A worker can switch branches or detach
 * HEAD; committing there put its work on another branch while the receipt
 * reported the untouched task branch as an empty, successful diff (F5). Every
 * git fact is read from the working tree itself, not assumed from the claim.
 */
export function checkTaskWorktreeHead(worktree: TaskWorktree): TaskHeadCheck {
	assertOwnership(worktree);
	let headCommit: string | null = null;
	try {
		headCommit = git(worktree.path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	} catch {
		// An unreadable HEAD is reported as a mismatch below rather than thrown.
	}
	const candidate = headCommit !== null && headCommit !== worktree.base ? headCommit : null;
	const moved = (actual: string): TaskHeadCheck => ({ ok: false, detail: headMovedDetail(worktree, actual, candidate) });
	try {
		const top = git(worktree.path, ["rev-parse", "--show-toplevel"]);
		if (canonicalOrResolved(top) !== canonicalOrResolved(worktree.path)) return moved(`a working tree rooted at ${top}`);
		const common = git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const rootCommon = git(worktree.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		if (canonicalOrResolved(common) !== canonicalOrResolved(rootCommon))
			return moved(`a checkout of another repository (${common})`);
	} catch (error) {
		return moved(`no readable git checkout (${gitFailureReason(error, "Git could not inspect the checkout.")})`);
	}
	let symbolic = "";
	try {
		symbolic = git(worktree.path, ["symbolic-ref", "-q", "HEAD"]);
	} catch {
		// symbolic-ref exits nonzero on a detached HEAD, reported below.
	}
	if (symbolic.length === 0) return moved(`detached HEAD at ${headCommit ?? "unknown"}`);
	if (symbolic !== `refs/heads/${worktree.branch}`) return moved(symbolic);
	if (headCommit === null) return moved(`${symbolic} with no commit`);
	return { ok: true, commit: headCommit };
}

/**
 * Attest, at call time, that a Git command run in `cwd` acts on this run's own
 * task worktree with HEAD on its task branch (Phase C). The cwd must sit
 * inside the worktree and resolve to the worktree's own top level, so a nested
 * repository or a `.git` file the worker planted in a subdirectory cannot
 * redirect a commit elsewhere. Never throws: any failure is a refusal.
 */
export function attestTaskWorktreeCwd(
	worktree: TaskWorktree,
	cwd: string,
): { ok: true } | { ok: false; detail: string } {
	try {
		const top = canonicalOrResolved(worktree.path);
		const at = canonicalOrResolved(cwd);
		const rel = relative(top, at);
		if (relativePathEscapes(rel)) {
			return { ok: false, detail: `cwd ${cwd} is outside task worktree ${worktree.path}` };
		}
		const cwdTop = canonicalOrResolved(git(at, ["rev-parse", "--show-toplevel"]));
		if (cwdTop !== top) return { ok: false, detail: `cwd ${cwd} belongs to the working tree ${cwdTop}, not ${top}` };
		const head = checkTaskWorktreeHead(worktree);
		return head.ok ? { ok: true } : { ok: false, detail: head.detail };
	} catch (error) {
		return {
			ok: false,
			detail: `task worktree ${worktree.runId} could not be attested: ${gitFailureReason(error, "Git could not inspect the checkout.")}`,
		};
	}
}

export function headMovedReceipt(
	worktree: TaskWorktree,
	apply: TaskWorktreeApply,
	detail: string,
): TaskWorktreeReceipt {
	return {
		path: worktree.path,
		branch: worktree.branch,
		diffHash: null,
		snapshot: "unavailable",
		apply,
		applied: false,
		reason: WORKTREE_HEAD_MOVED,
		detail,
	};
}

export function replaceMarker(ownerPath: string, marker: Record<string, unknown>): void {
	const temporary = `${ownerPath}.${randomBytes(6).toString("hex")}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	renameSync(temporary, ownerPath);
}

export function accountedField(accounted: TaskWorktreePreview): {
	accounted: { commit: string; untracked: object; ignored?: ReadonlyArray<string> };
} {
	return {
		accounted: {
			commit: accounted.commit,
			untracked: Object.fromEntries(accounted.untracked),
			...(accounted.ignored !== undefined && accounted.ignored.length > 0 ? { ignored: accounted.ignored } : {}),
		},
	};
}

/** The snapshot a settled claim recorded; anything malformed reads as no record, which lands every untracked file. */
export function claimAccounted(marker: Record<string, unknown>): TaskWorktreePreview | undefined {
	const accounted = marker.accounted;
	if (typeof accounted !== "object" || accounted === null) return undefined;
	const { commit, untracked, ignored } = accounted as { commit?: unknown; untracked?: unknown; ignored?: unknown };
	if (typeof commit !== "string" || typeof untracked !== "object" || untracked === null) return undefined;
	const entries = Object.entries(untracked);
	if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return undefined;
	const held = Array.isArray(ignored) ? ignored.filter((entry): entry is string => typeof entry === "string") : [];
	return { commit, untracked: new Map(entries), ...(held.length > 0 ? { ignored: held } : {}) };
}
