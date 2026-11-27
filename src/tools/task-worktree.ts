// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { stripAuthoredTrailers } from "../core/commit-message.js";
import { sha256Hex } from "../core/hash.js";
import { withoutRepositoryEnv } from "../core/internal-git.js";
import { gitExecFileSync } from "../core/internal-git-run.js";
import { relativePathEscapes } from "../core/path-containment.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { TASK_WORKTREE_KIND } from "../core/task-worktree-claim.js";
import { currentProcessLease } from "./process-lease.js";
import { workHeldBy } from "./task-worktree-claims.js";
import {
	accountedField,
	assertOwnership,
	checkTaskWorktreeHead,
	claimPathFor,
	headMovedReceipt,
	replaceMarker,
	SAFE_RUN_ID,
} from "./task-worktree-ownership.js";
import type { TaskWorktreeDrift, TaskWorktreePreview } from "./task-worktree-preview.js";
import {
	destinationRefusal,
	mergeDestination,
	previewDrift,
	taskWorktreePreviewDrift,
} from "./task-worktree-preview.js";
import {
	WORKTREE_CHANGED_SINCE_PREVIEW,
	WORKTREE_DESTINATION_MOVED,
	WORKTREE_HEAD_MOVED,
} from "./task-worktree-reasons.js";
import {
	leftUncommittedField,
	leftUncommittedReport,
	protectedPathsChangedByWorktreeBranch,
} from "./worktree-branch-diff.js";
import {
	COMMIT_IDENTITY,
	commitWorktreePath,
	GONE_STAMP,
	ignoredAuthoredPaths,
	nullDelimitedPaths,
	untrackedPaths,
	untrackedState,
} from "./worktree-commit.js";
import { git, gitBytes, isCanonicalWorktreePathInside } from "./worktree-git.js";
import { mergeWorktreeBranch } from "./worktree-merge.js";
import { diskWorktreeParent } from "./worktree-root.js";

export type TaskWorktreeApply = "merge" | "preserve";

export interface TaskWorktree {
	root: string;
	runId: string;
	/** `<parent>/<runId>`. */
	path: string;
	/**
	 * Directory the working tree was created in: the project-root location or
	 * the resolved `fleet.worktrees.root`. Absent on a value built before the
	 * root was configurable, which always means the project-root location.
	 */
	parent?: string;
	branch: string;
	base: string;
	/**
	 * Branch the source checkout had checked out at dispatch. A merge lands only
	 * while that branch is still checked out. Absent when HEAD was detached, and
	 * on a value built before this was recorded.
	 */
	sourceBranch?: string;
	ownerToken: string;
}

/**
 * Where a claim stands. `active` is a run in flight, or one whose owner died
 * before it settled. `settled` is a finished run that kept its worktree on
 * purpose (apply mode preserve, a failed run, a merge conflict). `abandoned`
 * is a dead owner's worktree that restart recovery found holding work and
 * kept for the operator; it is reported once at startup and listed by doctor.
 */
export type TaskWorktreeState = "active" | "settled" | "abandoned";

/** A task worktree that outlived its run, as doctor and recovery report it. */
export interface PreservedTaskWorktree {
	runId: string;
	path: string;
	/** The claim file, always under the project root. */
	claimPath: string;
	branch: string;
	base: string;
	state: TaskWorktreeState;
	/** ISO UTC instant the claim was written; null when the claim carries none. */
	createdAt: string | null;
	/** Why recovery kept it rather than removing it. */
	reason: string;
	/**
	 * Its branch and its working tree are both gone, removed by hand, so the
	 * claim file is all that is left and nothing of the run can be lost with it.
	 */
	stale: boolean;
}

export interface TaskWorktreeRecoveryResult {
	removed: string[];
	preserved: PreservedTaskWorktree[];
	failed: Array<{ runId: string; message: string }>;
}

export interface TaskWorktreeReceipt {
	path: string;
	branch: string;
	/** Null when no trustworthy diff exists: an unreadable snapshot, or a worktree whose HEAD moved. */
	diffHash: string | null;
	changedPaths?: string[];
	/** The paths among `changedPaths` the task commit deleted; absent when it deleted none. */
	deletedPaths?: string[];
	/** Absent means the diff is committed on the task branch. */
	snapshot?: "working-tree" | "unavailable";
	/** The task commit pinned at snapshot time; application merges this id, never the mutable branch name (F5). */
	commit?: string;
	apply: TaskWorktreeApply;
	applied: boolean;
	reason?: string;
	/** Human-readable explanation of `reason` when the code alone does not carry it. */
	detail?: string;
	/**
	 * New files the host commit left out because no mutation call of the run
	 * wrote them and the worker did not stage them, or because the repository's
	 * ignore rules match them. `paths` holds at most `LEFT_UNCOMMITTED_LIST_LIMIT`
	 * of the `count`.
	 */
	leftUncommitted?: { count: number; paths: string[] };
	/**
	 * What kept a merged worktree from automatic cleanup: files changed or new
	 * since the commit and `leftUncommitted` accounted for its contents. Bounded
	 * like `leftUncommitted`.
	 */
	changedAfterCommit?: { count: number; paths: string[] };
	/**
	 * Changes the run left outside its declared write roots: tracked files it changed and files it authored there.
	 * Only the roots merge back (fleet M7, ruling 3); these stay in the kept worktree for the operator. Bounded like
	 * `leftUncommitted`.
	 */
	outsideRoots?: { count: number; paths: string[] };
}

function validateRunId(runId: string): void {
	if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..")
		throw new Error(`invalid task worktree run id '${runId}'`);
}

export function gitCheckoutRoot(cwd: string): string | null {
	try {
		return realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
	} catch {
		return null;
	}
}

/**
 * Refusal for a task worktree requested in a repository with no commits. A
 * worktree branches from a commit, and an unborn HEAD has none, so the request
 * is refused before any mode split rather than failing inside `git worktree add`
 * with a raw rev-parse error on one path and not another (D4).
 */
export const WORKTREE_UNBORN_HEAD_MESSAGE =
	"worktree_unborn_head: the repository has no commits, so a task worktree has nothing to branch from. Make an initial commit, or dispatch without worktree.";

/** Whether a checkout's HEAD names no commit yet (`git init` with nothing committed). */
export function gitHeadIsUnborn(root: string): boolean {
	try {
		git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
		return false;
	} catch {
		return true;
	}
}

const CLAIMS_EXCLUDE_PATTERN = "/.pancode/worktrees/";

/**
 * Keep the claim directory out of the operator's `git status`. The claim JSON
 * and any on-disk worktree live under the project root, and an untracked
 * `.pancode/` in the operator's repo is noise PanCode must not create. The
 * checkout's own `info/exclude` is used so no tracked file changes.
 */
export function excludeProjectWorktreesFromStatus(root: string): void {
	try {
		const excludePath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
		const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
		if (current.split(/\r?\n/u).includes(CLAIMS_EXCLUDE_PATTERN)) return;
		safeResourceWrite(
			excludePath,
			`${current}${current.length === 0 || current.endsWith("\n") ? "" : "\n"}${CLAIMS_EXCLUDE_PATTERN}\n`,
		);
	} catch {
		// Best effort: an unwritable info/exclude leaves the claim visible to git status, and the run is unaffected.
	}
}

export function createTaskWorktree(
	root: string,
	runId: string,
	base?: string,
	apply: TaskWorktreeApply = "merge",
	/** Resolved `fleet.worktrees.root` parent; the project-root location when absent. */
	worktreeParent?: string,
): TaskWorktree {
	validateRunId(runId);
	const canonical = realpathSync(root);
	if (base === undefined && gitHeadIsUnborn(canonical)) throw new Error(WORKTREE_UNBORN_HEAD_MESSAGE);
	const resolvedBase = base ?? git(canonical, ["rev-parse", "HEAD"]);
	const sourceBranch = git(canonical, ["branch", "--show-current"]);
	const claimParent = diskWorktreeParent(canonical);
	const parent = worktreeParent ?? claimParent;
	const path = join(parent, runId);
	const branch = `pancode/task/${runId}`;
	mkdirSync(claimParent, { recursive: true });
	excludeProjectWorktreesFromStatus(canonical);
	// Off the project root the directory may sit on a filesystem other users
	// share (/dev/shm), so it is ours alone.
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (!isCanonicalWorktreePathInside(parent, path))
		throw new Error(`task worktree path escapes its parent for run ${runId}`);
	// Bound checkout parallelism for off-disk tasks: fleet workers already compete for CPUs.
	git(canonical, [
		...(parent !== claimParent ? ["-c", "checkout.workers=4"] : []),
		"worktree",
		"add",
		"-b",
		branch,
		path,
		resolvedBase,
	]);
	// Git config outlives the claim, so a branch kept after its claim is
	// released still names where it was cut and which branch it lands on.
	// `git branch -D` removes the section with the branch.
	try {
		git(canonical, ["config", `branch.${branch}.pancode-base`, resolvedBase]);
		if (sourceBranch.length > 0) git(canonical, ["config", `branch.${branch}.pancode-source`, sourceBranch]);
	} catch {
		// Only `fleet land` of a claimless branch reads these; the claim carries the same facts.
	}
	const ownerToken = randomBytes(16).toString("hex");
	writeFileSync(
		claimPathFor(canonical, runId),
		`${JSON.stringify(
			{
				version: 2,
				kind: TASK_WORKTREE_KIND,
				root: canonical,
				runId,
				branch,
				base: resolvedBase,
				...(sourceBranch.length > 0 ? { sourceBranch } : {}),
				ownerToken,
				// What restart recovery needs to tell a crashed run from a live one.
				state: "active" satisfies TaskWorktreeState,
				apply,
				createdAt: new Date().toISOString(),
				owner: currentProcessLease(),
				path,
			},
			null,
			2,
		)}\n`,
		{ encoding: "utf8", flag: "wx" },
	);
	return {
		root: canonical,
		runId,
		path,
		parent,
		branch,
		base: resolvedBase,
		...(sourceBranch.length > 0 ? { sourceBranch } : {}),
		ownerToken,
	};
}

function taskWorktreeDiffHash(worktree: Pick<TaskWorktree, "root" | "base">, commit: string): string {
	const bytes = gitBytes(worktree.root, ["diff", `${worktree.base}..${commit}`]);
	return sha256Hex(bytes);
}

/** Preserve failure evidence without committing a peer's incomplete edits. */
export function snapshotTaskWorktree(worktree: TaskWorktree, apply: TaskWorktreeApply): TaskWorktreeReceipt {
	// A diff against a foreign HEAD would describe another branch's state (F5).
	const head = checkTaskWorktreeHead(worktree);
	if (!head.ok) return headMovedReceipt(worktree, apply, head.detail);
	// Against the base, not HEAD: commits the worker made on its task branch
	// (Phase C) are part of what it produced, alongside uncommitted edits.
	const tracked = gitBytes(worktree.path, ["diff", "--binary", worktree.base]);
	const untracked = nullDelimitedPaths(gitBytes(worktree.path, ["ls-files", "--others", "--exclude-standard", "-z"]));
	const changedPaths = [
		...new Set([
			...nullDelimitedPaths(gitBytes(worktree.path, ["diff", "--name-only", "-z", worktree.base])),
			...untracked,
		]),
	].sort();
	const hash = createHash("sha256").update("working-tree\0").update(tracked);
	for (const name of untracked) {
		const candidate = join(worktree.path, name);
		const stat = lstatSync(candidate);
		hash.update(name).update("\0").update(String(stat.mode)).update("\0");
		if (stat.isSymbolicLink()) hash.update(readlinkSync(candidate));
		else if (stat.isFile()) {
			const descriptor = openSync(candidate, "r");
			try {
				const buffer = Buffer.allocUnsafe(64 * 1024);
				for (;;) {
					const count = readSync(descriptor, buffer, 0, buffer.length, null);
					if (count === 0) break;
					hash.update(buffer.subarray(0, count));
				}
			} finally {
				closeSync(descriptor);
			}
		}
	}
	return {
		path: worktree.path,
		branch: worktree.branch,
		diffHash: hash.digest("hex"),
		changedPaths,
		snapshot: "working-tree",
		apply,
		applied: false,
	};
}

const BASE_DIFF_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Zero-context text diff of the worktree's tracked changes against its base,
 * for the merge gate to read removed lines from. Null when git cannot produce
 * it within the byte bound, so a huge or unreadable diff never blocks a run.
 */
export function taskWorktreeBaseDiff(worktree: TaskWorktree): string | null {
	try {
		return gitExecFileSync(["-C", worktree.path, "diff", "--no-color", "-U0", worktree.base], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: BASE_DIFF_MAX_BYTES,
			env: withoutRepositoryEnv(),
		}).toString("utf8");
	} catch {
		// Fail open: the gate is an extra signal, and its other checks still run.
		return null;
	}
}

function committedReceipt(worktree: TaskWorktree, commit: string, apply: TaskWorktreeApply): TaskWorktreeReceipt {
	const range = `${worktree.base}..${commit}`;
	const deletedPaths = nullDelimitedPaths(
		gitBytes(worktree.root, ["diff", "--name-only", "-z", "--diff-filter=D", range]),
	);
	return {
		path: worktree.path,
		branch: worktree.branch,
		diffHash: taskWorktreeDiffHash(worktree, commit),
		changedPaths: nullDelimitedPaths(gitBytes(worktree.root, ["diff", "--name-only", "-z", range])),
		...(deletedPaths.length > 0 ? { deletedPaths } : {}),
		commit,
		apply,
		applied: false,
	};
}

export function applyTaskWorktree(input: {
	worktree: TaskWorktree;
	apply: TaskWorktreeApply;
	protectedPaths?: ReadonlyArray<string>;
	/** The worker's validated `commitMessage`; a merge lands it on the operator's branch. */
	commitMessage?: string | null;
	/**
	 * Absolute paths the run's successful mutation calls wrote, as the host
	 * observed them. The only untracked files the settle commit takes beside
	 * what the worker staged, or null when the run has no complete write record;
	 * see `commitWorktreePath`.
	 */
	authoredPaths: Iterable<string> | null;
	/** The run's write boundaries when only they merge back (fleet M7); see `commitWorktreePath`. */
	mergeRoots?: ReadonlyArray<string>;
	/**
	 * Merge exactly the commit an earlier pass pinned and an operator was shown,
	 * instead of committing the working tree again. Refused unless the branch
	 * still names it and the tree holds nothing newer, so a window between the
	 * preview and the merge cannot land work nobody saw.
	 */
	preview?: TaskWorktreePreview;
	/**
	 * Receives what this pass accounted for: the preview it merged, or the commit
	 * it pinned with the post-commit listing behind `leftUncommitted`. Automatic
	 * cleanup compares the worktree with it. Kept off the receipt, which is sealed.
	 */
	onAccounted?: (accounted: TaskWorktreePreview) => void;
}): TaskWorktreeReceipt {
	const { worktree } = input;
	const before = checkTaskWorktreeHead(worktree);
	if (!before.ok) return headMovedReceipt(worktree, input.apply, before.detail);
	let commit: string;
	let leftUncommitted: string[];
	let ignoredAuthored: string[];
	let accounted: TaskWorktreePreview;
	let outsideRoots: string[] = [];
	if (input.preview !== undefined) {
		commit = input.preview.commit;
		// Nothing is committed now, so every untracked file stays out of this merge.
		leftUncommitted = untrackedPaths(worktree.path);
		const found = previewDrift(worktree, input.preview, before.commit, leftUncommitted);
		if (found !== null) {
			const drift = `${WORKTREE_CHANGED_SINCE_PREVIEW}: task worktree ${worktree.runId} ${found} since commit ${commit} was offered for merge. Nothing was merged; the branch ${worktree.branch} is preserved.`;
			return {
				...committedReceipt(worktree, commit, input.apply),
				...leftUncommittedField(leftUncommitted),
				reason: WORKTREE_CHANGED_SINCE_PREVIEW,
				detail: drift,
			};
		}
		ignoredAuthored = ignoredAuthoredPaths(worktree.path, input.authoredPaths);
		accounted = ignoredAuthored.length > 0 ? { ...input.preview, ignored: ignoredAuthored } : input.preview;
	} else {
		const taskLine = `PanCode task ${worktree.runId}`;
		// The validated message is already stripped; this is the sink, and only
		// PanCode's managed hook may write trailers onto the operator's branch.
		const authored =
			input.commitMessage === undefined || input.commitMessage === null
				? undefined
				: stripAuthoredTrailers(input.commitMessage);
		const committed = commitWorktreePath(
			worktree.path,
			COMMIT_IDENTITY,
			authored !== undefined && authored.length > 0 ? `${authored}\n\n${taskLine}` : taskLine,
			{ authoredPaths: input.authoredPaths, ...(input.mergeRoots !== undefined ? { mergeRoots: input.mergeRoots } : {}) },
		);
		leftUncommitted = committed.leftUncommitted;
		outsideRoots = committed.outsideRoots;
		ignoredAuthored = committed.ignoredAuthored;
		// Pin the commit the snapshot produced. Everything after this reads and
		// merges that immutable id, so a branch moved later cannot swap it (F5).
		const pinned = checkTaskWorktreeHead(worktree);
		if (!pinned.ok) return headMovedReceipt(worktree, input.apply, pinned.detail);
		if (pinned.commit !== committed.accounted.commit)
			return headMovedReceipt(worktree, input.apply, "HEAD changed after the host commit");
		commit = committed.accounted.commit;
		accounted = committed.accounted;
	}
	input.onAccounted?.(accounted);
	const outsideReport = leftUncommittedReport(outsideRoots);
	const receipt: TaskWorktreeReceipt = {
		...committedReceipt(worktree, commit, input.apply),
		...leftUncommittedField([...new Set([...leftUncommitted, ...ignoredAuthored])].sort()),
		...(outsideReport !== undefined
			? {
					outsideRoots: outsideReport,
					detail: `changes outside the write roots stay uncommitted in worktree ${worktree.path}, which is kept: ${outsideReport.paths.join(", ")}${outsideReport.count > outsideReport.paths.length ? ` and ${outsideReport.count - outsideReport.paths.length} more` : ""}`,
				}
			: {}),
	};
	if (input.apply === "preserve") return receipt;
	const protectedChanges = protectedPathsChangedByWorktreeBranch(worktree.root, commit, input.protectedPaths ?? []);
	if (protectedChanges.length > 0) return { ...receipt, reason: "protected_artifact_changed" };
	// Right before mutating the source checkout, the branch and HEAD must still
	// name the pinned commit; otherwise the merge would apply what nobody hashed.
	const beforeMerge = checkTaskWorktreeHead(worktree);
	if (!beforeMerge.ok) return { ...headMovedReceipt(worktree, input.apply, beforeMerge.detail), commit };
	let branchTip: string | null = null;
	try {
		branchTip = git(worktree.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}^{commit}`]);
	} catch {
		// A deleted branch is reported as the mismatch below.
	}
	if (branchTip !== commit || beforeMerge.commit !== commit) {
		const detail = `${WORKTREE_HEAD_MOVED}: task branch refs/heads/${worktree.branch} moved from pinned commit ${commit} to ${branchTip ?? "nothing"} before merge; candidate commit ${commit}. Nothing was merged; the worktree and its branch are preserved.`;
		return { ...headMovedReceipt(worktree, input.apply, detail), commit };
	}
	const destinationBranch = mergeDestination(worktree.root);
	// The merge lands on whatever the source checkout has checked out now, and
	// a card can wait indefinitely while the operator or the main agent keeps
	// working, so the branch may have changed since dispatch.
	const stranded = destinationRefusal(worktree, destinationBranch);
	if (stranded !== null) return { ...receipt, reason: WORKTREE_DESTINATION_MOVED, detail: stranded };
	const merged = mergeWorktreeBranch(worktree.root, commit, COMMIT_IDENTITY, `Merge branch '${worktree.branch}'`);
	if (!merged.ok) {
		return {
			...receipt,
			reason: merged.code ?? "worktree_merge_conflict",
			detail: `${merged.reason}; its work is committed on the preserved branch ${worktree.branch}, and \`pancode fleet land ${worktree.branch}\` lands it once that is resolved`,
		};
	}
	const landedCommit = git(worktree.root, ["rev-parse", "HEAD"]);
	if ((receipt.changedPaths?.length ?? 0) === 0) {
		// Merging a branch at its base moves nothing, so the destination's own head is not this run's landing.
		return {
			...receipt,
			applied: true,
			detail: `nothing merged: the task branch holds no change beyond its base${receipt.detail !== undefined ? `; ${receipt.detail}` : ""}`,
		};
	}
	const ignoredNote =
		ignoredAuthored.length === 0
			? ""
			: `; ${ignoredAuthored.length} authored ${ignoredAuthored.length === 1 ? "file is" : "files are"} ignored by .gitignore and stay${ignoredAuthored.length === 1 ? "s" : ""} in the worktree`;
	return {
		...receipt,
		applied: true,
		detail: `merged ${landedCommit.slice(0, 7)} onto ${destinationBranch}${ignoredNote}${receipt.detail !== undefined ? `; ${receipt.detail}` : ""}`,
	};
}

/**
 * Only yolo admits a task worker's write outside its worktree, which a local model does when it takes the checkout for
 * its root. That work reaches no branch, so a plain "nothing merged" beside a worker's success would hide edits sitting
 * in the operator's tree.
 */
export function withStrayWrites<Receipt extends { detail?: string }>(
	receipt: Receipt,
	worktree: Pick<TaskWorktree, "path">,
	mutatedPaths: Iterable<string>,
): Receipt {
	const stray = [...mutatedPaths].filter((target) => {
		const inside = relative(worktree.path, target);
		return relativePathEscapes(inside);
	});
	if (stray.length === 0) return receipt;
	const named = `${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ", ..." : ""}`;
	const note = `the worker also wrote outside its task worktree, so these changes are on no branch: ${named}`;
	return { ...receipt, detail: receipt.detail === undefined ? note : `${receipt.detail}; ${note}` };
}

function removeWorktreeDirectory(worktree: TaskWorktree): void {
	try {
		git(worktree.root, ["worktree", "remove", "--force", worktree.path]);
	} catch {
		if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
		git(worktree.root, ["worktree", "prune"]);
	}
}

export function cleanupTaskWorktree(worktree: TaskWorktree, deleteBranch: boolean): void {
	assertOwnership(worktree);
	removeWorktreeDirectory(worktree);
	if (deleteBranch) git(worktree.root, ["branch", "-D", worktree.branch]);
	rmSync(claimPathFor(worktree.root, worktree.runId), { force: true });
}

/**
 * The forced removal of a finished worktree, unless it holds more than
 * `accounted`. A kept worktree settles as preserved so restart recovery does not
 * read it as a crash, and the drift that kept it comes back for the receipt.
 * Call before sealing that receipt so the cleanup and its report agree.
 */
export function cleanupAccountedTaskWorktree(
	worktree: TaskWorktree,
	accounted: TaskWorktreePreview | undefined,
): TaskWorktreeDrift | null {
	assertOwnership(worktree);
	const drift = taskWorktreePreviewDrift(worktree, accounted);
	if (drift === null) cleanupTaskWorktree(worktree, true);
	else settleTaskWorktree(worktree, accounted);
	return drift;
}

function branchExists(worktree: TaskWorktree): boolean {
	try {
		git(worktree.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`]);
		return true;
	} catch {
		return false;
	}
}

/** What an operator's discard of a task worktree actually removed. */
export type TaskWorktreeDiscard =
	/** The worktree and the branch are gone; `claimReleased` is false only when the claim file could not be removed. */
	| { outcome: "discarded"; claimReleased: boolean }
	/** The worktree is gone but the branch is not; `claimReleased` says whether the ownership claim went with it. */
	| { outcome: "branch_kept"; claimReleased: boolean; error: unknown }
	/** Nothing was removed. */
	| { outcome: "kept"; error: unknown }
	/** The worktree no longer holds the previewed commit, so nothing was removed. `detail` says how. */
	| { outcome: "changed"; detail: string };

/**
 * Remove a task worktree and its branch for an operator who chose to, and report
 * what each step actually did. The outcome is read from the steps, never
 * inferred from the one that failed: a claim that cannot be removed after the
 * branch is deleted is still a discard, and a branch that is already gone needs
 * no `git branch -D`. With `preview`, nothing is removed unless the worktree
 * still holds exactly what it recorded. A worktree gone with its branch kept releases the claim,
 * because nothing of PanCode's is left to guard and the operator holds the branch.
 */
export function discardTaskWorktree(worktree: TaskWorktree, preview?: TaskWorktreePreview): TaskWorktreeDiscard {
	try {
		assertOwnership(worktree);
		// `worktree remove --force` and `branch -D` delete whatever was added after
		// the preview, so a previewed discard applies the same drift check as Merge.
		if (preview !== undefined) {
			const head = checkTaskWorktreeHead(worktree);
			if (!head.ok) return { outcome: "changed", detail: head.detail };
			const found = previewDrift(worktree, preview, head.commit);
			if (found !== null) {
				return {
					outcome: "changed",
					detail: `task worktree ${worktree.runId} ${found} since commit ${preview.commit} was offered for discard`,
				};
			}
		}
		try {
			removeWorktreeDirectory(worktree);
		} catch (error) {
			// A failed prune after the directory went leaves nothing on disk to keep.
			if (existsSync(worktree.path)) return { outcome: "kept", error };
		}
	} catch (error) {
		return { outcome: "kept", error };
	}
	let branchKept: { error: unknown } | null = null;
	try {
		git(worktree.root, ["branch", "-D", worktree.branch]);
	} catch (error) {
		if (branchExists(worktree)) branchKept = { error };
	}
	let claimReleased = true;
	try {
		rmSync(claimPathFor(worktree.root, worktree.runId), { force: true });
	} catch {
		// The claim stays; the closing settle or restart recovery reads it.
		claimReleased = false;
	}
	return branchKept === null
		? { outcome: "discarded", claimReleased }
		: { outcome: "branch_kept", claimReleased, error: branchKept.error };
}

/**
 * The cancel-path twin of restart recovery's rule: a canceled run whose worktree
 * has no commit beyond its base and no modified, staged, or untracked file is
 * removed with its branch and claim; one that holds work is left for the
 * caller to settle. Returns whether it was removed. Esc in the TUI and
 * `fleet cancel` both seal through the dispatch finalizer, so they share this.
 */
export function discardIdleTaskWorktree(worktree: TaskWorktree): boolean {
	assertOwnership(worktree);
	if (workHeldBy(worktree.root, worktree) !== null) return false;
	// workHeldBy counts base..branch only. A worker that detached HEAD or moved to
	// another branch and committed there holds work the branch count cannot see,
	// and deleting the worktree would orphan it. A gone working tree has no HEAD
	// to read, so workHeldBy's verdict stands.
	if (existsSync(worktree.path)) {
		if (!checkTaskWorktreeHead(worktree).ok) return false;
		try {
			const strayed = Number.parseInt(git(worktree.path, ["rev-list", "--count", `${worktree.branch}..HEAD`]), 10);
			if (strayed !== 0) return false;
		} catch {
			// A git failure means HEAD cannot be shown to hold nothing, so keep it.
			return false;
		}
	}
	cleanupTaskWorktree(worktree, true);
	return true;
}

/**
 * Record that a run ended and kept its worktree on purpose, so restart
 * recovery does not read the claim as a crash.
 */
export function settleTaskWorktree(worktree: TaskWorktree, accounted?: TaskWorktreePreview): void {
	assertOwnership(worktree);
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	const marker = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
	replaceMarker(ownerPath, {
		...marker,
		state: "settled" satisfies TaskWorktreeState,
		...(accounted !== undefined ? accountedField(accounted) : {}),
	});
}

/**
 * Take a kept worktree back for a run that continues in it (a resumed isolated fleet): the claim is active again and
 * names this process, so `fleet land` reports it running and restart recovery reads a crash honestly.
 */
export function reopenTaskWorktree(worktree: TaskWorktree): void {
	assertOwnership(worktree);
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	const marker = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
	replaceMarker(ownerPath, { ...marker, state: "active" satisfies TaskWorktreeState, owner: currentProcessLease() });
}

/**
 * Move a kept worktree's record onto a commit a landing just made. The landing
 * can still be refused or keep the worktree, and a retry against the old commit
 * would read the left-out files as never accounted for and land them.
 */
export function recordTaskWorktreeAccounted(worktree: TaskWorktree, accounted: TaskWorktreePreview): void {
	assertOwnership(worktree);
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	const marker = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
	replaceMarker(ownerPath, { ...marker, ...accountedField(accounted) });
}

/**
 * The untracked files a landing leaves behind: those the run's own commit left
 * out and that have not changed since. Its stamps let the landing's cleanup
 * remove them with the worktree, and a file that arrived or changed later is
 * not here, so it lands.
 */
export function leftOutOfLanding(
	path: string,
	head: string,
	accounted: TaskWorktreePreview | undefined,
): Map<string, string> {
	const leftOut = new Map<string, string>();
	if (accounted === undefined || accounted.commit !== head) return leftOut;
	for (const [entry, stamp] of untrackedState(path).stamps) {
		if (stamp !== GONE_STAMP && accounted.untracked.get(entry) === stamp) leftOut.set(entry, stamp);
	}
	return leftOut;
}

/** The untracked files of the worktree at `path` outside `leftOut`, as the absolute paths `commitWorktreePath` takes. */
export function landedUntrackedPaths(path: string, leftOut: ReadonlyMap<string, string>): string[] {
	return untrackedPaths(path)
		.filter((entry) => !leftOut.has(entry))
		.map((entry) => join(path, entry));
}
