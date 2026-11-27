// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isTestFilePath } from "../../core/test-paths.js";
import { addedUntrackedPaths, changedCheckoutDiff, snapshotCheckoutSince } from "../../tools/checkout-changes.js";
import { taskWorktreeBaseDiff } from "../../tools/task-worktree.js";
import { taskWorktreeHoldsWork } from "../../tools/task-worktree-claims.js";
import type { TaskWorktreePreview } from "../../tools/task-worktree-preview.js";
import { bindHostVerificationHypotheses } from "../claims/index.js";
import type { FinalizingAttempt, GradedSettlement } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { grade } from "./grading.js";
import {
	compareHostVerificationBase,
	hostVerificationRejection,
	hostVerificationSandbox,
	runHostVerification,
} from "./host-verification.js";
import {
	compromisedCause,
	mergeGateVerdict,
	mergeWithheldDetail,
	preservesPartialResult,
	removedTestCases,
	taskRequestsTestRemoval,
} from "./merge-gate.js";
import {
	deriveRunVerification,
	typedValidationFactsFromObservedEffects,
	typedValidationFactsFromVerifyCalls,
	verificationWithHostVerdict,
} from "./run-findings.js";
import { receiptAssurance } from "./run-settlement.js";
import { snapshotToolStats } from "./tool-stats.js";
import type { RunOutcomeCode } from "./types.js";
import {
	HOST_VERIFICATION_EVENT,
	type VerificationSlotEvents,
	type VerificationSlotState,
} from "./verification-slot.js";

export async function verifyAttemptOnHost(rt: DispatchRuntime, attempt: FinalizingAttempt, settling: GradedSettlement) {
	const { context } = rt;
	const { checkoutBaseline, envelope, lifecycle, req, runEffects, settlement, toolStats, verifyCalls } = attempt;
	const {
		appliedResultContract,
		applyGrade,
		detailNotes,
		finalText,
		gradeContract,
		gradeFacts,
		observedRunEffects,
		sealedResultContractFact,
		validationGrounding,
	} = settling;

	const hostVerificationSandboxPolicy =
		(req.resolvedVerification?.length ?? 0) > 0
			? hostVerificationSandbox(lifecycle.settings, req.taskWorktree ?? req.candidateWorktree ?? lifecycle.cwd)
			: undefined;
	// The worker has ended, so the card's phase is the run's own: a check queued behind the machine's one
	// verification slot says so instead of reading as a worker waiting for its model.
	let hostVerificationPhase: VerificationSlotState | null = null;
	const publishHostVerificationPhase = (message: VerificationSlotState): void => {
		if (hostVerificationPhase === message) return;
		hostVerificationPhase = message;
		context.bus.emit("run.progressed", {
			runId: envelope.id,
			agentId: req.agentId,
			task: req.task,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			targetId: lifecycle.target.target.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			event: { type: HOST_VERIFICATION_EVENT, message },
		});
	};
	const hostVerificationSlot: VerificationSlotEvents = {
		onWaiting: () => publishHostVerificationPhase("waiting for a verification slot"),
		onTaken: () => publishHostVerificationPhase("running host checks"),
		onUnavailable: (error) => reportDispatchDiagnostic(`take the verification slot for ${envelope.id}`, error),
	};
	const hostVerificationInput = {
		runId: envelope.id,
		request: req,
		workerSuccessful: settling.finalOutcome === "succeeded",
		...(hostVerificationSandboxPolicy !== undefined ? { shellSandbox: hostVerificationSandboxPolicy } : {}),
		onDiagnostic: (error: unknown) => reportDispatchDiagnostic(`write host verification memo for ${envelope.id}`, error),
		slot: hostVerificationSlot,
	};
	// The hypotheses each declared check tests are bound now, before any of them starts (#406): a check-start
	// record per bound check enters the project's log, so a slate that lands while they run is not credited.
	let hypothesisBindings: ReadonlyMap<string, ReadonlyArray<string>> | undefined;
	if ((req.resolvedVerification?.length ?? 0) > 0) {
		try {
			hypothesisBindings = await bindHostVerificationHypotheses(
				req.taskWorktree?.root ?? lifecycle.cwd,
				envelope.id,
				(req.resolvedVerification ?? []).map((check) => check.check),
			);
		} catch (error) {
			reportDispatchDiagnostic(`bind hypotheses for ${envelope.id}`, error);
		}
	}
	// This await is the batch barrier. It already sits before
	// buildReceiptDraft below, which is why batch settlement needs no
	// receipt restructuring: every member parks here with its outcome
	// resolved and nothing sealed.
	const hostVerification =
		settlement === undefined
			? await runHostVerification(hostVerificationInput)
			: await settlement.arrive(hostVerificationInput);
	await compareHostVerificationBase({ verification: hostVerification, request: req, slot: hostVerificationSlot });
	// One settle snapshot serves the test-removal check and the receipt; nothing between them writes the checkout.
	const checkoutBefore = lifecycle.runtimeKind === "subprocess" ? checkoutBaseline : null;
	const checkoutAfter = checkoutBaseline === null ? null : await snapshotCheckoutSince(checkoutBaseline, lifecycle.cwd);
	// Refused attempts often leave their probe script behind; the operator learns of it here, not by accident.
	const strayFiles =
		attempt.refusalLimit !== null && checkoutBaseline !== null && checkoutAfter !== null
			? addedUntrackedPaths(checkoutBaseline, checkoutAfter)
			: [];
	const strayNote =
		strayFiles.length > 0
			? `untracked files this run left in the checkout: ${strayFiles.slice(0, 5).join(", ")}${strayFiles.length > 5 ? `, and ${strayFiles.length - 5} more` : ""}`
			: null;
	const hostRejection = hostVerificationRejection(hostVerification);
	const workerSucceeded = settling.finalOutcome === "succeeded";
	gradeFacts.host = {
		rejection: hostRejection === null ? null : { code: hostRejection.outcomeCode, detail: hostRejection.detail },
	};
	applyGrade(grade(gradeContract, gradeFacts));
	// A run in the current tree has no merge to withhold, so a change that
	// deletes existing test cases fails the run instead; the edits stay for
	// the operator to judge (flywheel F-D1). A task that asks for the removal is exempt.
	if (checkoutBefore !== null && settling.finalOutcome === "succeeded" && !taskRequestsTestRemoval(req.task)) {
		gradeFacts.removedTests = removedTestCases(
			await changedCheckoutDiff(checkoutBefore, checkoutAfter, (path) => isTestFilePath(path) || path.endsWith(".rs")),
		);
		applyGrade(grade(gradeContract, gradeFacts));
	}
	if (strayNote !== null) {
		detailNotes.push(strayNote);
		attempt.failureMessage = [attempt.failureMessage, strayNote].filter(Boolean).join("; ");
	}
	// The detail the operator reads so far: the graded words, then the notes beside them.
	const notedDetail = (): string | null => [settling.finalDetail, ...detailNotes].filter(Boolean).join("; ") || null;
	// Assurance is the one value the merge gate, the exit code and a parent's finish contract read (4.8).
	const assuranceQuality = {
		typedValidations: [
			...typedValidationFactsFromVerifyCalls(snapshotToolStats(toolStats), verifyCalls.calls, runEffects.checkFreshness()),
			...typedValidationFactsFromObservedEffects(observedRunEffects),
		],
		resultContract: sealedResultContractFact,
	};
	const assuranceVerification = deriveRunVerification(
		{ toolStats: snapshotToolStats(toolStats), typedValidations: assuranceQuality.typedValidations },
		{ capabilityClass: lifecycle.capabilityClass, checkFreshness: runEffects.checkFreshness() },
	);
	const assurance = receiptAssurance({
		quality: assuranceQuality,
		validationGrounding:
			validationGrounding === null ? null : { ...validationGrounding, ungrounded: [...validationGrounding.ungrounded] },
		...(hostVerification !== undefined ? { hostVerification } : {}),
		verification:
			hostVerification === undefined
				? assuranceVerification
				: verificationWithHostVerdict(assuranceVerification, hostVerification),
	});
	// What lowered it, in the merge gate's words: the checks this run executed that failed on its final tree.
	const failedChecks = assuranceQuality.typedValidations
		.filter((fact) => !fact.passed)
		.map((fact) => fact.sourceId.replace(/^[\w-]+:/u, ""));
	const assuranceFact = {
		value: assurance,
		...compromisedCause(appliedResultContract, finalText, failedChecks, observedRunEffects.notRunChecks),
	};
	// A worker whose own report lists a failing check does not land on the
	// operator's branch unless host verification passed. With no declared
	// check the merge used to rest on the exit status alone, and a Git
	// Master's `npm test: exit 1` commit merged onto main (flywheel s5r2).
	// The tree is still committed to its preserved branch, so a failure the
	// operator knows was already there costs one merge command.
	// A worktree that holds nothing has no merge to withhold. Gating it failed a read-only run over a
	// "no check needed" line in the worker's report and left an empty branch behind; without the gate it
	// takes the ordinary applied path, which removes the worktree and its branch.
	const mergeGateInput =
		req.taskWorktree !== undefined &&
		(req.apply ?? "merge") === "merge" &&
		settling.finalOutcome === "succeeded" &&
		taskWorktreeHoldsWork(req.taskWorktree)
			? {
					assurance,
					failedChecks,
					notRunChecks: observedRunEffects.notRunChecks,
					contract: appliedResultContract,
					output: finalText,
					branch: req.taskWorktree.branch,
					// Removal the task asked for is what was asked (flywheel F-D1).
					removedTests: taskRequestsTestRemoval(req.task)
						? []
						: removedTestCases(taskWorktreeBaseDiff(req.taskWorktree) ?? ""),
				}
			: null;
	const withheldDetail = mergeGateInput === null ? null : mergeWithheldDetail(mergeGateInput);
	const withheldVerdict = mergeGateInput === null ? null : mergeGateVerdict(mergeGateInput);
	const mergeWithheld = withheldDetail !== null;
	// One grade (4.8): a builder whose assurance is compromised is not delivered. A merge-mode branch with work is
	// held by the merge gate, which reads the same assurance, and graded with its landing below.
	if (mergeGateInput === null) {
		gradeFacts.assurance = assuranceFact;
		applyGrade(grade(gradeContract, gradeFacts));
	}
	// Its branch is kept like a host-rejected one, committed for the operator's one land command.
	const assuranceHeld = req.taskWorktree !== undefined && attempt.outcomeCode === "assurance_compromised";
	// A merge-mode run the worker finished but host verification rejected
	// keeps its branch like a withheld merge, so its tree is committed there
	// for the operator's one merge command instead of left as loose edits.
	const hostRejectedMerge =
		req.taskWorktree !== undefined && (req.apply ?? "merge") === "merge" && hostRejection !== null && workerSucceeded;
	// A worker stopped at its tool-call cap, or one that reported it did not
	// finish, commits what it changed on its preserved branch as a partial
	// result: never merged, never dropped.
	const cappedPartial =
		!workerSucceeded &&
		preservesPartialResult(attempt.outcomeCode, req.taskWorktree !== undefined, settling.finalOutcome);

	// Set when the operator discarded the branch and worktree from the merge card.
	const worktreeDiscarded = false;
	// What the last apply pass accounted for; automatic cleanup removes nothing beyond it.

	const onAccounted = (entry: TaskWorktreePreview): void => {
		settling.accounted = entry;
	};
	// Set once the task claim is gone, so the closing settle below does not
	// look for it. A discard that removed the worktree but not the branch
	// releases the claim too: nothing of PanCode's is left to guard.
	const claimReleased = false;
	// Why landing the run's work failed or was held (V6); the grader seals it beside every other rule.
	const landingFailure: { code: RunOutcomeCode | null; detail: string } | null = null;
	// The operator merged a held branch from the card: a person accepted the result (V6).
	const operatorMerged = false;
	const landingAttempted = req.taskWorktree !== undefined;
	settling.hypothesisBindings = hypothesisBindings;
	settling.worktreeDiscarded = worktreeDiscarded;
	settling.claimReleased = claimReleased;
	settling.landingFailure = landingFailure;
	settling.operatorMerged = operatorMerged;
	return {
		hostVerification,
		checkoutBefore,
		checkoutAfter,
		notedDetail,
		assurance,
		assuranceFact,
		mergeGateInput,
		withheldDetail,
		withheldVerdict,
		mergeWithheld,
		assuranceHeld,
		hostRejectedMerge,
		cappedPartial,
		onAccounted,
		landingAttempted,
	};
}
