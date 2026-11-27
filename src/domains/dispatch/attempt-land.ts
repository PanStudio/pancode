// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { relative } from "node:path";
import { heldLandCardPin, landHeldTaskBranch } from "../../tools/task-land.js";
import {
	applyTaskWorktree,
	discardTaskWorktree,
	settleTaskWorktree,
	withStrayWrites,
} from "../../tools/task-worktree.js";
import { mergeDestination, previewTaskWorktree, type TaskWorktreePreview } from "../../tools/task-worktree-preview.js";
import { protectedPathsChangedByWorktreeBranch } from "../../tools/worktree-branch-diff.js";
import { mutationReportFailures, resultContractAuthorship } from "../agents/result-contract-builder-report.js";
import type { FinalizingAttempt, VerifiedSettlement } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { lifecycleMergeRoots } from "./envelope-stage.js";
import { grade } from "./grading.js";
import { mergeCardCauseNote } from "./merge-card.js";
import { landCardClause, partialResultDetail, taskWorktreeCommitMessage } from "./merge-gate.js";
import { snapshotUnappliedTaskWorktree } from "./run-finish.js";
import type { RunResultDraft } from "./types.js";

export async function landAttemptWorktree(
	rt: DispatchRuntime,
	attempt: FinalizingAttempt,
	settling: VerifiedSettlement,
) {
	const { getProtectedArtifactState } = rt.core;
	const { options } = rt;
	let worktreeReceipt: RunResultDraft["worktree"];
	let worktreeDiscarded = settling.worktreeDiscarded;
	let claimReleased = settling.claimReleased;
	let landingFailure = settling.landingFailure;
	let operatorMerged = settling.operatorMerged;
	const { activeRun, lifecycle, req } = attempt;
	const {
		appliedResultContract,
		applyGrade,
		assuranceFact,
		assuranceHeld,
		authoredPaths,
		cappedPartial,
		capturedOutput,
		detailNotes,
		gradeContract,
		gradeFacts,
		hostRejectedMerge,
		hostVerification,
		landingAttempted,
		mergeGateInput,
		mergeWithheld,
		notedDetail,
		observedRunEffects,
		onAccounted,
		resultValidation,
		withheldDetail,
		withheldVerdict,
	} = settling;

	if (
		req.taskWorktree !== undefined &&
		(settling.finalOutcome === "succeeded" || hostRejectedMerge || cappedPartial || assuranceHeld)
	) {
		const authorship =
			appliedResultContract !== null && resultValidation?.conformance === "pass"
				? resultContractAuthorship(appliedResultContract, capturedOutput?.state === "final" ? capturedOutput.text : null)
				: null;
		// A report without a commitMessage still lands a readable subject: the
		// worker's summary, else the task it was given, never only the run id.
		const taskCommitMessage = taskWorktreeCommitMessage({
			task: req.task,
			partial: cappedPartial,
			commitMessage: authorship?.commitMessage ?? null,
			summary: authorship?.summary ?? null,
		});
		const protectedPaths = getProtectedArtifactState().artifacts.map((artifact) => artifact.path);
		worktreeReceipt = applyTaskWorktree({
			worktree: req.taskWorktree,
			apply: mergeWithheld || hostRejectedMerge || cappedPartial || assuranceHeld ? "preserve" : (req.apply ?? "merge"),
			protectedPaths,
			commitMessage: taskCommitMessage,
			authoredPaths,
			...lifecycleMergeRoots(lifecycle.envelope),
			onAccounted,
		});
		worktreeReceipt = withStrayWrites(worktreeReceipt, req.taskWorktree, observedRunEffects.mutatedPaths);
		if (worktreeReceipt.reason !== undefined) {
			landingFailure = {
				code: null,
				detail:
					hostRejectedMerge || cappedPartial || assuranceHeld
						? [notedDetail(), worktreeReceipt.detail ?? worktreeReceipt.reason].filter(Boolean).join("; ")
						: (worktreeReceipt.detail ?? worktreeReceipt.reason),
			};
		} else if (cappedPartial) {
			if (worktreeReceipt.commit !== undefined && (worktreeReceipt.changedPaths?.length ?? 0) > 0) {
				detailNotes.push(partialResultDetail(req.taskWorktree.branch));
				attempt.failureMessage = notedDetail() ?? attempt.failureMessage;
			}
		} else if (hostRejectedMerge || assuranceHeld) {
			// Only a commit on the branch makes the command true; a worker that
			// changed nothing leaves the branch at its base.
			if (worktreeReceipt.commit !== undefined && (worktreeReceipt.changedPaths?.length ?? 0) > 0) {
				detailNotes.push(
					`its work is committed on the preserved branch ${req.taskWorktree.branch}, \`pancode fleet land ${req.taskWorktree.branch}\` previews the merge and \`pancode fleet land ${req.taskWorktree.branch} --yes\` lands it if you accept the failed check; ${landCardClause(req.taskWorktree.branch)}`,
				);
				attempt.failureMessage = notedDetail() ?? attempt.failureMessage;
			}
		} else if (mergeWithheld) {
			// An attached operator may overrule the gate for this one branch. The
			// tree is already committed and pinned above, so Merge re-enters the
			// same guarded path (head attestation, protected paths, pinned
			// commit) rather than a second implementation of it.
			let discardFailed = false;
			let branchKept = false;
			let discardChanged: string | null = null;
			// The commit the card describes and the untracked files beside it,
			// recorded before the card shows. Merge lands this id or nothing, and
			// neither choice removes a worktree that changed since.
			const previewedCommit = worktreeReceipt.commit;
			let preview: TaskWorktreePreview | undefined;
			if (previewedCommit !== undefined) {
				try {
					// The apply pass's own post-commit snapshot is what the receipt reports; a fresh
					// one taken now would silently cover a file that arrived in between (D12).
					preview =
						settling.accounted?.commit === previewedCommit
							? settling.accounted
							: previewTaskWorktree(req.taskWorktree, previewedCommit);
				} catch (previewError) {
					// Without the record no card is built, so nothing can remove the worktree unguarded.
					reportDispatchDiagnostic(`preview task worktree ${req.taskWorktree.runId}`, previewError);
				}
			}
			// The preserve pass does not look at protected paths, only the merge
			// does, so the card learns of them here and withholds Merge. A surface
			// with no operator never builds a card, so it pays for no git call.
			const worktreeRoot = req.taskWorktree.root;
			let previewedProtected: string[] | null = null;
			if (previewedCommit !== undefined && options?.operatorAsk?.available() === true) {
				try {
					previewedProtected = protectedPathsChangedByWorktreeBranch(worktreeRoot, previewedCommit, protectedPaths).map(
						(path) => relative(worktreeRoot, path) || path,
					);
				} catch (protectedError) {
					// Without the check a Merge offer could land a protected path.
					reportDispatchDiagnostic(`protected paths of ${req.taskWorktree.runId}`, protectedError);
				}
			}
			// What the card shows is what Land is bound to: this tip, onto this destination at this head.
			const asksCard =
				withheldVerdict !== null &&
				preview !== undefined &&
				previewedProtected !== null &&
				(worktreeReceipt.changedPaths?.length ?? 0) > 0;
			const landPin =
				asksCard && previewedCommit !== undefined ? heldLandCardPin(req.taskWorktree.root, previewedCommit) : null;
			const card =
				asksCard && withheldVerdict !== null && previewedProtected !== null
					? await rt.grants.askWithheldMerge(activeRun, {
							branch: req.taskWorktree.branch,
							destination: landPin?.destination ?? mergeDestination(req.taskWorktree.root),
							changedPaths: worktreeReceipt.changedPaths ?? [],
							reason: withheldVerdict.reason,
							workerFailedChecks: mutationReportFailures(
								mergeGateInput?.contract ?? null,
								mergeGateInput?.output ?? null,
								mergeGateInput?.notRunChecks,
							),
							...(hostVerification !== undefined ? { hostVerification } : {}),
							protectedPaths: previewedProtected,
						})
					: null;
			// The card waits as long as the operator takes, once for each card queued
			// ahead of it, and protection is live state that throws while it is degraded. Merge reads it again here and
			// withholds when it cannot, never on the list from before the wait.
			let landProtectedPaths: string[] | null = null;
			if (card?.choice === "land") {
				try {
					landProtectedPaths = getProtectedArtifactState().artifacts.map((artifact) => artifact.path);
				} catch (protectedError) {
					reportDispatchDiagnostic(`protected artifacts at land of ${req.taskWorktree.runId}`, protectedError);
				}
			}
			const heldReason = withheldVerdict?.reason ?? "of its report";
			if (card?.choice === "land" && (landProtectedPaths === null || preview === undefined || landPin === null)) {
				const reason = `${landProtectedPaths === null ? "protected artifact state" : "the previewed branch and destination"} could not be read when the operator chose Land; nothing was merged and branch ${req.taskWorktree.branch} is preserved`;
				worktreeReceipt = {
					...worktreeReceipt,
					reason: "protected_state_unavailable",
					detail: `operator land refused: ${reason}`,
				};
				landingFailure = {
					code: "merge_withheld",
					detail: `merge withheld: ${withheldVerdict?.reason ?? "its report"}; operator land refused: ${reason}`,
				};
			} else if (card?.choice === "land" && landProtectedPaths !== null && preview !== undefined && landPin !== null) {
				// Land is the operator's own action, carried out here on the host with
				// fleet land's checks, so no sandboxed agent ever needs to run it.
				try {
					// A live claim reads as a running task to fleet land; the closing settle repeats this harmlessly.
					settleTaskWorktree(req.taskWorktree, preview);
					const landed = landHeldTaskBranch({
						worktree: req.taskWorktree,
						preview,
						shown: landPin,
						protectedPaths: landProtectedPaths,
					});
					settling.accounted = preview;
					operatorMerged = true;
					worktreeReceipt = {
						...worktreeReceipt,
						apply: "merge",
						applied: true,
						detail: `${landed.landed !== null ? `merged ${landed.landed.slice(0, 7)} onto ${landed.destination}` : `nothing merged: ${landed.destination} already holds it`}; operator land accepted after the gate held it because ${heldReason}`,
					};
				} catch (landError) {
					const refused = landError instanceof Error ? landError.message : String(landError);
					worktreeReceipt = { ...worktreeReceipt, detail: `operator land refused: ${refused}` };
					// Not the withheld detail's fleet land command alone: the branch may hold work nobody previewed.
					landingFailure = {
						code: "merge_withheld",
						detail: `merge withheld: ${withheldVerdict?.reason ?? "its report"}; operator land refused: ${refused}. Branch ${req.taskWorktree.branch} is preserved; inspect it before landing.`,
					};
				}
			} else if (card?.choice === "discard") {
				const discard = discardTaskWorktree(req.taskWorktree, preview);
				if (discard.outcome === "discarded") {
					worktreeDiscarded = true;
					claimReleased = discard.claimReleased;
				} else if (discard.outcome === "changed") {
					// Nothing was removed, so this settles as a keep that says why.
					discardChanged = discard.detail;
				} else {
					reportDispatchDiagnostic(`discard task worktree ${req.taskWorktree.runId}`, discard.error);
					// Either nothing was removed and this settles as a keep, or the
					// worktree is gone and only the branch remains.
					branchKept = discard.outcome === "branch_kept";
					discardFailed = !branchKept;
					if (discard.outcome === "branch_kept") claimReleased = discard.claimReleased;
				}
			}
			if (card?.choice !== "land") {
				let withheld = withheldDetail ?? notedDetail() ?? "merge withheld";
				if (worktreeDiscarded) {
					withheld = `merge withheld: ${withheldVerdict?.reason ?? "its report"}; the operator discarded branch ${req.taskWorktree.branch} and its worktree`;
					worktreeReceipt = {
						...worktreeReceipt,
						reason: "operator_discarded",
						detail: "operator discard: deleted the branch and its worktree on the merge card",
					};
				} else if (branchKept) {
					withheld = `${withheld}; the operator discarded the worktree but deleting branch ${req.taskWorktree.branch} failed, so the branch remains and \`git branch -D ${req.taskWorktree.branch}\` finishes the discard`;
					worktreeReceipt = {
						...worktreeReceipt,
						detail: `operator discard: removed the worktree, but deleting branch ${req.taskWorktree.branch} failed; the branch is preserved`,
					};
				} else if (discardChanged !== null) {
					// Not the withheld detail: its `pancode fleet land` command would land work
					// nobody previewed.
					withheld = `merge withheld: ${withheldVerdict?.reason ?? "its report"}; operator discard refused: ${discardChanged}. Branch ${req.taskWorktree.branch} and its worktree are preserved; inspect them before merging or discarding.`;
					worktreeReceipt = {
						...worktreeReceipt,
						detail: `operator keep: discard refused because the worktree changed after the preview (${discardChanged}); branch and worktree preserved`,
					};
				} else if (card !== null) {
					worktreeReceipt = {
						...worktreeReceipt,
						detail: `operator keep: ${discardFailed ? "the discard failed; branch and worktree preserved" : `${mergeCardCauseNote(card.cause)}; branch preserved`}`,
					};
				}
				landingFailure = { code: "merge_withheld", detail: withheld };
			}
		}
	}
	// The landing is the last rule: its words already carry the notes made before it.
	const preLandingDetail = notedDetail();
	if (landingAttempted) {
		if (mergeGateInput !== null)
			gradeFacts.assurance = { ...assuranceFact, ...(operatorMerged ? { operatorAccepted: true } : {}) };
		gradeFacts.landing = { failure: landingFailure };
		applyGrade(grade(gradeContract, gradeFacts));
	}
	settling.finalDetail = landingFailure !== null ? settling.finalDetail : preLandingDetail;
	if (landingFailure !== null) attempt.failureMessage = settling.finalDetail ?? attempt.failureMessage;
	if (req.taskWorktree !== undefined && worktreeReceipt === undefined) {
		worktreeReceipt = snapshotUnappliedTaskWorktree(req.taskWorktree, req.apply ?? "merge");
		// An already failed run whose HEAD also moved says so, so the
		// operator knows the preserved branch lacks the work (F5).
		if (worktreeReceipt.detail !== undefined) {
			settling.finalDetail = [settling.finalDetail, worktreeReceipt.detail].filter(Boolean).join("; ");
			attempt.failureMessage = settling.finalDetail;
		}
	}
	settling.worktreeReceipt = worktreeReceipt;
	settling.claimReleased = claimReleased;
}
