// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TASK_WORKTREE_KIND } from "../core/task-worktree-claim.js";
import type { ProcessLease } from "./process-lease.js";
import { ownerIsAlive, validProcessLease } from "./process-lease.js";
import type {
	PreservedTaskWorktree,
	TaskWorktree,
	TaskWorktreeRecoveryResult,
	TaskWorktreeState,
} from "./task-worktree.js";
import { restoreRecordedOverlay } from "./task-worktree-overlay.js";
import { claimAccounted, OWNER_FILE_SUFFIX, replaceMarker, SAFE_RUN_ID } from "./task-worktree-ownership.js";
import type { TaskWorktreePreview } from "./task-worktree-preview.js";
import { git, gitFailureReason, isCanonicalWorktreePathInside } from "./worktree-git.js";
import { diskWorktreeParent } from "./worktree-root.js";

export interface TaskClaim {
	runId: string;
	path: string;
	ownerPath: string;
	marker: Record<string, unknown>;
	branch: string;
	base: string;
	state: TaskWorktreeState;
	createdAt: string | null;
	owner: ProcessLease | null;
}

/**
 * Every task claim under the root whose facts are internally consistent: the
 * marker names this root, its own run id, the canonical branch, and a path
 * that is exactly `<parent>/<runId>` under an allowed parent. Anything else is not provably ours and
 * is never returned, so recovery never touches it.
 */
function readTaskClaims(canonical: string, allowedParents: ReadonlyArray<string>): TaskClaim[] {
	const parent = diskWorktreeParent(canonical);
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return [];
	}
	const claims: TaskClaim[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(OWNER_FILE_SUFFIX)) continue;
		const runId = name.slice(0, -OWNER_FILE_SUFFIX.length);
		if (!SAFE_RUN_ID.test(runId)) continue;
		const ownerPath = join(parent, name);
		let marker: Record<string, unknown>;
		try {
			const value = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			marker = value as Record<string, unknown>;
		} catch {
			continue;
		}
		// The claim names where its working tree is. It is believed only when
		// that is `<allowed parent>/<runId>`; recovery runs git and rm on it.
		if (typeof marker.path !== "string") continue;
		const path = marker.path;
		const pathParent = allowedParents.find((allowed) => resolve(allowed) === resolve(dirname(path)));
		if (pathParent === undefined || basename(path) !== runId) continue;
		if (
			marker.version !== 2 ||
			marker.kind !== TASK_WORKTREE_KIND ||
			marker.root !== canonical ||
			marker.runId !== runId ||
			marker.branch !== `pancode/task/${runId}` ||
			typeof marker.base !== "string" ||
			!/^[0-9a-f]{40,64}$/u.test(marker.base) ||
			(existsSync(path) && !isCanonicalWorktreePathInside(pathParent, path))
		) {
			continue;
		}
		const state: TaskWorktreeState = marker.state === "settled" || marker.state === "abandoned" ? marker.state : "active";
		claims.push({
			runId,
			path,
			ownerPath,
			marker,
			branch: marker.branch,
			base: marker.base,
			state,
			createdAt: typeof marker.createdAt === "string" ? marker.createdAt : null,
			owner: validProcessLease(marker.owner) ? marker.owner : null,
		});
	}
	return claims;
}

/**
 * Why a dead owner's worktree must be kept, or null when it holds nothing: no
 * commit beyond its base and no modified, staged, or untracked file. Any git
 * failure is a reason to keep it.
 */
export function workHeldBy(canonical: string, claim: Pick<TaskClaim, "base" | "branch" | "path">): string | null {
	try {
		const commits = Number.parseInt(git(canonical, ["rev-list", "--count", `${claim.base}..${claim.branch}`]), 10);
		if (!Number.isSafeInteger(commits)) return "its commits could not be counted";
		if (commits > 0) {
			return existsSync(claim.path)
				? `${commits} commit(s) beyond its base`
				: `${commits} commit(s) beyond its base (its working tree is gone)`;
		}
		// Gone with a tmpfs root at reboot: whatever was uncommitted went with it.
		if (!existsSync(claim.path)) return null;
		const dirty = git(claim.path, ["status", "--porcelain", "--untracked-files=all"]);
		return dirty.length > 0 ? `${dirty.split("\n").length} uncommitted path(s)` : null;
	} catch (error) {
		return `git could not inspect it: ${gitFailureReason(error, "Git inspection failed.")}`;
	}
}

/**
 * Whether a finished run's worktree holds anything to land: a commit beyond its base, or any modified, staged
 * or untracked file. Fails toward true, so an unreadable tree keeps every gate that would have applied to it.
 */
export function taskWorktreeHoldsWork(worktree: TaskWorktree): boolean {
	return workHeldBy(worktree.root, worktree) !== null;
}

function preservedView(
	claim: TaskClaim,
	state: TaskWorktreeState,
	reason: string,
	canonical: string,
): PreservedTaskWorktree {
	return {
		runId: claim.runId,
		path: claim.path,
		claimPath: claim.ownerPath,
		branch: claim.branch,
		base: claim.base,
		state,
		createdAt: claim.createdAt,
		reason,
		stale: claimIsStale(canonical, claim),
	};
}

/**
 * A claim whose branch and working tree are both gone. Either one surviving
 * may hold the run's only copy of its work, and a git failure is not proof of
 * absence, so both count as not stale.
 */
function claimIsStale(canonical: string, claim: Pick<TaskClaim, "branch" | "path">): boolean {
	if (existsSync(claim.path)) return false;
	try {
		git(canonical, ["rev-parse", "--verify", "--quiet", `refs/heads/${claim.branch}`]);
		return false;
	} catch (error) {
		// `--verify --quiet` exits 1 with no output for a missing ref; any other
		// failure leaves the question open.
		return (error as { status?: unknown }).status === 1;
	}
}

/**
 * Remove a stale claim file for `doctor --fix`, after checking again that its
 * branch and working tree are still gone. Returns whether it was removed.
 */
export function clearStaleTaskClaim(root: string, entry: PreservedTaskWorktree): boolean {
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return false;
	}
	const claim = readTaskClaims(canonical, [dirname(entry.path)]).find((candidate) => candidate.runId === entry.runId);
	if (claim === undefined || claim.ownerPath !== entry.claimPath || !claimIsStale(canonical, claim)) return false;
	rmSync(claim.ownerPath, { force: true });
	return true;
}

/**
 * Restart recovery for `worktree: true` dispatch. A crash used to leave the
 * worktree, its branch, and its claim under `.pancode/worktrees/` forever.
 * Only an `active` claim whose owner is provably gone is acted on: one that
 * holds no work is removed with its branch, and one that holds commits or
 * uncommitted files becomes `abandoned` and is returned for the startup
 * report. It is never merged and never deleted. A live owner, an owner on
 * another host, a claim without a lease, and a settled or already abandoned
 * claim are left exactly as they are.
 */
export function recoverTaskWorktrees(
	root: string,
	/** Defaults to the project-root location; pass allowedWorktreeParents() to cover a configured root. */
	allowedParents?: ReadonlyArray<string>,
): TaskWorktreeRecoveryResult {
	const result: TaskWorktreeRecoveryResult = { removed: [], preserved: [], failed: [] };
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return result;
	}
	for (const claim of readTaskClaims(canonical, allowedParents ?? [diskWorktreeParent(canonical)])) {
		if (claim.state !== "active" || claim.owner === null || ownerIsAlive(claim.owner)) continue;
		try {
			restoreRecordedOverlay(claim);
			const held = workHeldBy(canonical, claim);
			if (held !== null) {
				replaceMarker(claim.ownerPath, { ...claim.marker, state: "abandoned" satisfies TaskWorktreeState });
				result.preserved.push(preservedView(claim, "abandoned", held, canonical));
				continue;
			}
			if (existsSync(claim.path)) git(canonical, ["worktree", "remove", "--force", claim.path]);
			else git(canonical, ["worktree", "prune"]);
			git(canonical, ["branch", "-D", claim.branch]);
			rmSync(claim.ownerPath, { force: true });
			result.removed.push(claim.runId);
		} catch (error) {
			result.failed.push({ runId: claim.runId, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}

/**
 * A finished run's task worktree as `fleet land` needs it, ownership token
 * included so landing can release the claim. A claim whose owner is alive is a
 * run in flight whose worker may still write, so it is reported as running.
 */
export function loadKeptTaskWorktree(
	root: string,
	runId: string,
	allowedParents?: ReadonlyArray<string>,
): { kind: "kept"; worktree: TaskWorktree; accounted?: TaskWorktreePreview } | { kind: "running" } | null {
	if (!SAFE_RUN_ID.test(runId)) return null;
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return null;
	}
	const claim = readTaskClaims(canonical, allowedParents ?? [diskWorktreeParent(canonical)]).find(
		(candidate) => candidate.runId === runId,
	);
	if (claim === undefined || typeof claim.marker.ownerToken !== "string") return null;
	if (claim.state === "active" && claim.owner !== null && ownerIsAlive(claim.owner)) return { kind: "running" };
	const sourceBranch = typeof claim.marker.sourceBranch === "string" ? claim.marker.sourceBranch : undefined;
	const accounted = claimAccounted(claim.marker);
	return {
		kind: "kept",
		worktree: {
			root: canonical,
			runId,
			path: claim.path,
			parent: dirname(claim.path),
			branch: claim.branch,
			base: claim.base,
			...(sourceBranch !== undefined && sourceBranch.length > 0 ? { sourceBranch } : {}),
			ownerToken: claim.marker.ownerToken,
		},
		...(accounted !== undefined ? { accounted } : {}),
	};
}

/**
 * The task worktrees that outlived their run, for doctor: settled ones kept on
 * purpose, abandoned ones recovery kept, and claims too old to carry a lease.
 * A claim whose owner is still alive is a run in flight and is not listed.
 */
export function listPreservedTaskWorktrees(
	root: string,
	allowedParents?: ReadonlyArray<string>,
): PreservedTaskWorktree[] {
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return [];
	}
	const out: PreservedTaskWorktree[] = [];
	for (const claim of readTaskClaims(canonical, allowedParents ?? [diskWorktreeParent(canonical)])) {
		if (claim.state === "settled") out.push(preservedView(claim, "settled", "kept by its run", canonical));
		else if (claim.state === "abandoned")
			out.push(preservedView(claim, "abandoned", "its owner died holding work", canonical));
		else if (claim.owner === null)
			out.push(preservedView(claim, "active", "its claim names no readable owner", canonical));
		else if (!ownerIsAlive(claim.owner))
			out.push(preservedView(claim, "active", "its owner is gone; the next start recovers it", canonical));
	}
	return out;
}
