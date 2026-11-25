// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attributeCommitMessage } from "../core/commit-attribution.js";
import { autonomousLandAuthorship } from "../core/git-commit-attribution.js";
import { withoutRepositoryEnv } from "../core/internal-git.js";
import { WORKTREE_DESTINATION_BUSY } from "./task-worktree-reasons.js";
import { hostCommitIdentity } from "./worktree-commit.js";
import { git, gitErrorOutput, gitFailureReason } from "./worktree-git.js";

export function mergeWorktreeBranch(
	root: string,
	branch: string,
	identity: string,
	/** Merge commit message; git's default names `branch`, which reads badly when it is a commit id. */
	message?: string,
): { ok: true } | { ok: false; reason: string; code?: typeof WORKTREE_DESTINATION_BUSY } {
	let mergeAttempted = false;
	let targetCommit: string | undefined;
	let mergeHeadPath: string | undefined;
	// Conflict-path reporting parses Git diagnostics, so merge subprocesses need a stable locale.
	const authorship = autonomousLandAuthorship(root);
	const mergeEnv = { ...withoutRepositoryEnv(), ...authorship?.env, LC_ALL: "C", LANGUAGE: "" };
	const mergeMessage =
		authorship === null
			? message
			: attributeCommitMessage(message ?? `Merge branch '${branch}'`, {}, true, { pancodeAuthorFor: authorship.human });
	try {
		targetCommit = git(root, ["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`]);
		const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
		mergeHeadPath = join(gitDir, "MERGE_HEAD");
		// A task must not interrupt the operator's partially completed Git operation.
		const operation = gitOperationInProgress(gitDir);
		if (operation !== null) {
			return {
				ok: false,
				code: WORKTREE_DESTINATION_BUSY,
				reason: `Cannot merge: a ${operation} is already in progress in the destination checkout.`,
			};
		}
		mergeAttempted = true;
		git(
			root,
			[
				...hostCommitIdentity(root, identity),
				// An autostash merges over the operator's WIP, exits 0 and leaves the restore conflicted; refuse instead.
				"-c",
				"merge.autoStash=false",
				"merge",
				"--no-edit",
				"--no-verify",
				...(mergeMessage !== undefined ? ["-m", mergeMessage] : []),
				branch,
			],
			{ env: mergeEnv },
		);
		return { ok: true };
	} catch (error) {
		const stdout = gitErrorOutput(error, "stdout");
		const conflictLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("CONFLICT "));
		const status = error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
		const reportsConflict = mergeAttempted && status === 1 && conflictLines.length > 0;
		let mergeLeftInProgress = false;
		// Exit 128 refuses an operator's merge, including a same-oid merge with unresolved index entries.
		// Only exit 1 can own cleanup, and the pin protects a branch moved before Git runs.
		if (mergeAttempted && targetCommit !== undefined && mergeHeadPath !== undefined) {
			try {
				if (existsSync(mergeHeadPath)) {
					if (status === 128) {
						return {
							ok: false,
							code: WORKTREE_DESTINATION_BUSY,
							reason: gitFailureReason(error, "Cannot merge: a merge is already in progress in the destination checkout."),
						};
					}
					if (status === 1 && readFileSync(mergeHeadPath, "utf8").trim() === targetCommit) {
						git(root, ["merge", "--abort"], { env: mergeEnv });
					} else {
						mergeLeftInProgress = true;
					}
				}
			} catch {
				return {
					ok: false,
					reason: `Git left this task merge in progress; run git merge --abort in ${root}`,
				};
			}
		}
		const reason = reportsConflict
			? `Merge conflict: ${conflictLines.join(" ")}`
			: gitFailureReason(error, "Git could not merge the branch.");
		return {
			ok: false,
			reason: `${reason}${mergeLeftInProgress ? ` ; this task merge was left in progress; run git merge --abort in ${root}` : ""}`,
		};
	}
}

/** The Git operation an operator left in progress in `gitDir`, or null when none is. */
export function gitOperationInProgress(gitDir: string): string | null {
	for (const [marker, operation] of [
		["MERGE_HEAD", "merge"],
		["CHERRY_PICK_HEAD", "cherry-pick"],
		["REVERT_HEAD", "revert"],
		["rebase-merge", "rebase"],
		["rebase-apply", "rebase"],
		["sequencer", "cherry-pick or revert sequence"],
	] as const) {
		if (existsSync(join(gitDir, marker))) return operation;
	}
	return null;
}
