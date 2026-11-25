// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskWorktree, TaskWorktreeReceipt } from "./task-worktree.js";
import { checkTaskWorktreeHead } from "./task-worktree-ownership.js";
import { WORKTREE_DESTINATION_MOVED } from "./task-worktree-reasons.js";
import { leftUncommittedReport } from "./worktree-branch-diff.js";
import {
	GONE_STAMP,
	LEFT_UNCOMMITTED_LIST_LIMIT,
	nullDelimitedPaths,
	untrackedPaths,
	untrackedState,
} from "./worktree-commit.js";
import { git, gitBytes } from "./worktree-git.js";

/**
 * What the host accounted for in a worktree: the pinned commit and the stamp of
 * each untracked file beside it. An operator's preview records it before the
 * card, and an ordinary merge from the post-commit listing behind
 * `leftUncommitted`. Merge lands only the commit, but Discard and the cleanup
 * after Merge remove the worktree with `--force`, so each one refuses once those
 * files are no longer the ones accounted for.
 */
export interface TaskWorktreePreview {
	commit: string;
	untracked: ReadonlyMap<string, string>;
	/** Authored files ignore rules kept out of the commit; the worktree is kept while any of them exists. */
	ignored?: ReadonlyArray<string>;
}

/** What a worktree holds beyond what was accounted for: `detail` finishes "the worktree ...". */
export interface TaskWorktreeDrift {
	detail: string;
	paths: string[];
}

/** Record what an operator is about to be shown for `commit`, before the card that shows it. */
export function previewTaskWorktree(worktree: TaskWorktree, commit: string): TaskWorktreePreview {
	return { commit, untracked: untrackedState(worktree.path).stamps };
}

/**
 * What the worktree holds that `accounted` does not cover. An accounted file
 * that vanished is not drift here: nothing of it is left for a removal to lose.
 */
function heldDrift(
	worktree: TaskWorktree,
	accounted: TaskWorktreePreview,
	head: string,
	listed: string[],
): TaskWorktreeDrift | null {
	if (head !== accounted.commit) return { detail: `is now at ${head}`, paths: [] };
	const tracked = [
		...nullDelimitedPaths(gitBytes(worktree.path, ["diff", "--name-only", "-z", "HEAD"])),
		...nullDelimitedPaths(gitBytes(worktree.path, ["diff", "--cached", "--name-only", "-z", "HEAD"])),
	];
	const { stamps, directories } = untrackedState(worktree.path, listed);
	const changed = [...stamps]
		.filter(([entry, stamp]) => stamp !== GONE_STAMP && accounted.untracked.get(entry) !== stamp)
		.map(([entry]) => entry);
	const ignored = (accounted.ignored ?? []).filter((entry) => existsSync(join(worktree.path, entry)));
	const paths = [...new Set([...tracked, ...directories, ...changed, ...ignored])].sort();
	if (tracked.length > 0) return { detail: "has uncommitted changes", paths };
	const directory = directories[0];
	if (directory !== undefined)
		return { detail: `has untracked directory ${directory}; destructive cleanup refused`, paths };
	if (changed.length > 0) return { detail: "has new or changed untracked files", paths };
	return ignored.length > 0 ? { detail: "holds authored files the repository ignores", paths } : null;
}

/**
 * How a worktree no longer holds exactly what was previewed, or null when it
 * does. An operator chose on that exact listing, so a vanished file counts.
 */
export function previewDrift(
	worktree: TaskWorktree,
	preview: TaskWorktreePreview,
	head: string,
	paths = untrackedPaths(worktree.path),
): string | null {
	const drift = heldDrift(worktree, preview, head, paths);
	if (drift !== null) return drift.detail;
	const listed = new Set(paths);
	return [...preview.untracked.keys()].every((entry) => listed.has(entry)) ? null : "has new or changed untracked files";
}

/**
 * How a held worktree no longer holds exactly what its merge card previewed, or null when it does: the check
 * the gate's own merge makes before it lands a previewed commit.
 */
export function taskWorktreeChangedSincePreview(worktree: TaskWorktree, preview: TaskWorktreePreview): string | null {
	try {
		if (!existsSync(worktree.path)) return "is gone";
		const head = checkTaskWorktreeHead(worktree);
		if (!head.ok) return head.detail;
		return previewDrift(worktree, preview, head.commit);
	} catch (error) {
		return `could not be read: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * What a forced removal would delete beyond `accounted`, or null when it would
 * delete nothing else. A merge leaves the worktree on the commit it pinned, so
 * this reads clean unless something arrived since. A worktree that cannot be
 * read, or a run with no record, reads as drift: only a positive answer removes.
 */
export function taskWorktreePreviewDrift(
	worktree: TaskWorktree,
	accounted: TaskWorktreePreview | undefined,
): TaskWorktreeDrift | null {
	if (accounted === undefined) return { detail: "has contents no commit accounted for", paths: [] };
	try {
		if (!existsSync(worktree.path)) return null;
		const head = checkTaskWorktreeHead(worktree);
		if (!head.ok) return { detail: head.detail, paths: [] };
		return heldDrift(worktree, accounted, head.commit, untrackedPaths(worktree.path));
	} catch (error) {
		return { detail: `could not be read: ${error instanceof Error ? error.message : String(error)}`, paths: [] };
	}
}

/** Why a worktree outlived its automatic cleanup, naming the bounded paths and how to recover them. */
export function keptTaskWorktreeDetail(worktree: TaskWorktree, commit: string, drift: TaskWorktreeDrift): string {
	const named = drift.paths.slice(0, LEFT_UNCOMMITTED_LIST_LIMIT);
	const more = drift.paths.length - named.length;
	const listing = named.length > 0 ? ` (${named.join(", ")}${more > 0 ? ` and ${more} more` : ""})` : "";
	return `kept worktree ${worktree.path} and branch ${worktree.branch}: it ${drift.detail}${listing} beyond commit ${commit.slice(0, 7)}; inspect them, and \`pancode fleet land ${worktree.branch}\` lands what the worktree holds`;
}

/** A merged run's receipt once `drift` kept its worktree. */
export function receiptWithDrift(
	receipt: TaskWorktreeReceipt,
	worktree: TaskWorktree,
	drift: TaskWorktreeDrift,
): TaskWorktreeReceipt {
	const report = leftUncommittedReport(drift.paths);
	const kept = keptTaskWorktreeDetail(worktree, receipt.commit ?? worktree.base, drift);
	return {
		...receipt,
		...(report !== undefined ? { changedAfterCommit: report } : {}),
		detail: receipt.detail !== undefined ? `${receipt.detail}; ${kept}` : kept,
	};
}

/** The branch a merge from this task would land on right now: the source checkout's branch, or `detached HEAD`. */
export function mergeDestination(root: string): string {
	try {
		return git(root, ["branch", "--show-current"]) || "detached HEAD";
	} catch {
		return "an unreadable HEAD";
	}
}

/** Whether `HEAD` of the source checkout has `base` in its history. `unknown` when git could not say. */
function headContainsBase(root: string, base: string): "yes" | "no" | "unknown" {
	try {
		git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
		return "yes";
	} catch (error) {
		// `--is-ancestor` exits 1 for "not an ancestor"; any other status is git failing.
		return (error as { status?: unknown }).status === 1 ? "no" : "unknown";
	}
}

/** Why the source checkout cannot take this task's merge as it stands, or null when it can. */
export function destinationRefusal(worktree: TaskWorktree, destination: string): string | null {
	const kept = `Nothing was merged; the task branch ${worktree.branch} is preserved.`;
	const dispatched = worktree.sourceBranch;
	if (dispatched !== undefined && destination !== dispatched) {
		return `${WORKTREE_DESTINATION_MOVED}: task worktree ${worktree.runId} was dispatched from branch ${dispatched}, but the checkout is now on ${destination}. ${kept} Switch back to ${dispatched} and merge ${worktree.branch}.`;
	}
	const short = worktree.base.slice(0, 7);
	switch (headContainsBase(worktree.root, worktree.base)) {
		case "yes":
			return null;
		case "no":
			return `${WORKTREE_DESTINATION_MOVED}: ${destination} does not contain base ${short} that task branch ${worktree.branch} was cut from${dispatched !== undefined ? ` on ${dispatched}` : ""}, so merging would also land commits the task was never built on. ${kept}`;
		case "unknown":
			return `${WORKTREE_DESTINATION_MOVED}: git could not confirm that ${destination} contains base ${short} of task branch ${worktree.branch}. ${kept}`;
	}
}
