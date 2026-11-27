// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { relative, resolve as resolvePath } from "node:path";
import { relativePathEscapes } from "../../core/path-containment.js";
import { ToolNames } from "../../core/tool-names.js";
import { contractDeclaresTaskGates, extractTaskGates } from "../../tools/verify/task-gates.js";
import { validateRecipeResult } from "../agents/result-contract.js";
import { builderReportCompletion } from "../agents/result-contract-builder-report.js";
import { nodeResultContractFilesystem } from "../agents/result-contract-filesystem.js";
import type { ActionClass } from "../safety/action-classifier.js";
import { workerHasNetworkPosture } from "./admission-scope.js";
import type { AttemptSettlementState, FinalizingAttempt } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { awaitEventDrain } from "./bundle-support.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { dispatchResultContract } from "./execution-role.js";
import { importFleetChanges } from "./fleet-change-return.js";
import { gateVerdictFactsOf } from "./gate-decisions.js";
import { type GradeContract, type GradeFacts, type GradeVerdict, grade } from "./grading.js";
import { wallHandbackOutcomeDetail } from "./handback.js";
import { resolveObligation } from "./obligation.js";
import { type RunTerminationEvidence, resolveRunOutcome, resultContractWasDue } from "./outcome.js";
import { recordRunTimingBestEffort } from "./phase-timing.js";
import { assessDispatchFinishContract } from "./run-finish.js";
import {
	hasDurableFinalOutput,
	malformedWorkerStdoutLineCount,
	resolveTrustedOutcomeCodes,
} from "./run-outcome-detail.js";
import {
	blockedStateChangingCalls,
	blockedWriteAttempts,
	executedCalls,
	observationCalls,
	snapshotUnfinishedTools,
	summarizeToolActivity,
} from "./tool-stats.js";
import type { RunResultContractFact } from "./types.js";
import {
	describeUngroundedValidations,
	groundClaimedValidations,
	groundGateCheck,
	invalidatesQuality,
	readOnlyObservationNote,
	type ValidationGroundingInput,
} from "./validation-grounding.js";
import { countCheckingCalls } from "./worker-event-fold.js";
import { resolveWriteRootRequest, writeRootRequestDetail, writeRootRequestFromEntries } from "./write-root-requests.js";

export async function gradeAttemptResult(
	rt: DispatchRuntime,
	attempt: FinalizingAttempt,
	settling: AttemptSettlementState,
) {
	const { getProtectedArtifactState, recordingJournal, safety } = rt.core;
	const {
		activeRun,
		callUsage,
		envelope,
		escalationCounts,
		eventPump,
		finishContractEntries,
		grantAttempt,
		inFlightTools,
		ledgerRef,
		lifecycle,
		outputCapture,
		placed,
		remoteReturn,
		req,
		runEffects,
		snapshotSteeringProvenance,
		telemetryIngestionErrorsOf,
		timing,
		tokenMeter,
		toolStats,
		toolTelemetryCoverageOf,
		trustedOutcomeCodes,
		trustedOutcomeDetails,
		verifyCalls,
		workerDone,
	} = attempt;

	const result = await workerDone;
	// #425: stop board traffic as soon as the process settles, before receipt work awaits.
	attempt.unsubscribeAgentLedger?.();
	attempt.unsubscribeAgentLedger = null;
	recordingJournal.gap(envelope.id, result.droppedDisplayFrames ?? 0);
	// The receipt reads meters the domain pump fills. Finalization
	// always waits (bounded by the drain grace) for the pump to finish
	// the source stream, whether or not an external consumer ever
	// subscribed, so a fast worker cannot seal a zero-token receipt.
	const drained = await awaitEventDrain(eventPump.done);
	if (!drained) {
		attempt.runJournal?.gap("writer-drop");
		callUsage?.gap();
		recordingJournal.gap(envelope.id, 1);
		attempt.toolTelemetryIngestionErrors += 1;
		reportDispatchDiagnostic(`run ${envelope.id}`, new Error("event stream did not drain before run finalization"));
	}
	const malformedFrames = malformedWorkerStdoutLineCount(result);
	const lostCallFrames = malformedFrames + (result.evidenceIncomplete !== undefined ? 1 : 0);
	if (lostCallFrames > 0) {
		// An unparseable line is an invalid record; a trail a signal or an undrained lane cut short dropped
		// whatever the worker still held (#434).
		if (malformedFrames > 0) attempt.runJournal?.gap("invalid-record", malformedFrames);
		if (result.evidenceIncomplete !== undefined) attempt.runJournal?.gap("writer-drop");
		callUsage?.gap(lostCallFrames);
	}
	// Only a drained stream can show an attempt will never settle; a late frame would settle it twice (#434).
	if (drained) attempt.runJournal?.settleCalls(callUsage?.settleOpen("internal") ?? []);
	const finalCallUsage = callUsage?.snapshot();
	if (finalCallUsage) tokenMeter.usage = finalCallUsage;
	rt.grants.workerApprovalWindows.settleRun(envelope.id);
	rt.grants.dropAdoptedAsks(envelope.id);
	// The worker is gone: every grant it held settles now, after its last
	// execution report drained. Retries run as new attempts with new requests.
	if (grantAttempt !== undefined) {
		rt.grants.grantBroker.revokeRun(envelope.id, "the worker exited", { final: true });
		rt.grants.grantRunFallbacks.delete(envelope.id);
	}
	if (eventPump.droppedEvents() > 0) {
		reportDispatchDiagnostic(
			`run ${envelope.id}`,
			new Error(`${eventPump.droppedEvents()} event(s) dropped from the bounded consumer tee`),
		);
	}
	const endedAt = new Date().toISOString();
	timing.endedAt = endedAt;
	recordRunTimingBestEffort(
		() => ledgerRef.update(envelope.id, { timing: { ...timing } }),
		(error) => reportDispatchDiagnostic(`record final timing for run ${envelope.id}`, error),
	);
	const evidence: RunTerminationEvidence = {
		exitCode: result.exitCode ?? null,
		abortedByOperator: activeRun.aborted,
		abortDetail: activeRun.abortDetail,
		abortCause: activeRun.abortCause,
		channelFailure: result.channelFailure ?? null,
		stallKilled: activeRun.stallKilled,
		timedOut: false,
		permissionFailure: false,
		policyDenied: null,
		stopReason: null,
	};
	const { outcome, detail } = resolveRunOutcome(evidence);
	// The process's end, then one grader over what the host observed (DESIGN 4.8, fleet M9).
	let terminationDetail = detail;
	if (detail === "permission_required" && attempt.permissionDenialDetail !== null) {
		terminationDetail = `${detail}; ${attempt.permissionDenialDetail}`;
		attempt.failureMessage = attempt.permissionDenialDetail;
	}
	// The stream drained above, so this is the run's whole write record.
	const observedRunEffects = runEffects.snapshot();
	// The commit keeps byproducts out only on the strength of a complete
	// tool trail. A subprocess runtime publishes no tool events and a
	// partial trail has holes where a write would sit, so either one cannot
	// tell a file the worker made from a byproduct and commits every
	// untracked file instead of dropping the worker's own. The remote
	// commit of an independent SSH checkout and the local task commit
	// both take this one answer.
	const authoredPaths =
		toolTelemetryCoverageOf(telemetryIngestionErrorsOf(result), snapshotUnfinishedTools(inFlightTools).length) ===
		"complete"
			? observedRunEffects.mutatedPaths
			: null;
	let changeReturnFailure: string | null = null;
	if (remoteReturn && outcome === "succeeded") {
		try {
			attempt.remoteImport = await importFleetChanges(
				remoteReturn,
				authoredPaths,
				lifecycle.pathScope.writeBoundaries,
				getProtectedArtifactState().artifacts.map((artifact) => {
					const root = remoteReturn.worktree.root;
					const rel = relative(root, artifact.path);
					return relativePathEscapes(rel) ? artifact.path : resolvePath(remoteReturn.worktree.path, rel);
				}),
			);
		} catch (error) {
			changeReturnFailure = `SSH change return failed: ${error instanceof Error ? error.message : String(error)}. Remote ${placed.id} branch ${remoteReturn.worktree.branch} at ${remoteReturn.worktree.path} is preserved.`;
		}
	}
	const finishContract = assessDispatchFinishContract(
		{ safety },
		{
			req,
			runId: envelope.id,
			cwd: lifecycle.cwd,
			entries: finishContractEntries,
			assistantText: attempt.finishContractAssistantText,
			assistantTurnId: attempt.finishContractAssistantTurnId,
		},
	);
	const resolvedOutcomeCode = resolveTrustedOutcomeCodes(trustedOutcomeCodes);
	// Words appended to the graded detail: they inform the operator and decide nothing.
	const detailNotes: string[] = [];
	if (resolvedOutcomeCode.conflict !== null) {
		reportDispatchDiagnostic(`run ${envelope.id}`, new Error(resolvedOutcomeCode.conflict));
		detailNotes.push(resolvedOutcomeCode.conflict);
	}
	// The exit code alone says a contract ran out of repairs, not why.
	// The worker's own reason is what separates a model that cannot
	// meet a grounding rule from a prompt that asks for the impossible.
	const workerCodeDetail =
		resolvedOutcomeCode.code === null ? undefined : trustedOutcomeDetails.get(resolvedOutcomeCode.code);
	// DESIGN 4.5 (fleet M8): the host, not the worker's line written at the handback, says whether a report came back.
	const wallHandback =
		resolvedOutcomeCode.code === "worker_run_timeout"
			? wallHandbackOutcomeDetail({
					reported: hasDurableFinalOutput(outputCapture.snapshot()),
					unfinishedTools: snapshotUnfinishedTools(inFlightTools),
					runningAtStop: attempt.callsAtAbort,
					hostStopped: activeRun.aborted && activeRun.abortCause === "timeout",
					hostSignals: result.hostSignals ?? [],
					exitCode: result.exitCode ?? null,
					signal: result.signal ?? null,
				})
			: undefined;
	const appliedResultContract = dispatchResultContract(req, lifecycle.recipe) ?? null;
	const classifyTool = (tool: string): ActionClass => safety.classify({ tool }).actionClass;
	const mutatedPathCount = finishContract?.assessment.mutatedPaths.length ?? null;
	// DESIGN 4.8: what the result must rest on, from the run's role. A gate's read roots are what it may read.
	const gradeContract: GradeContract = {
		role: lifecycle.runRole,
		obligation: resolveObligation(lifecycle.runRole, appliedResultContract?.kind ?? null, req.intent?.readRoots ?? []),
		contractKind: appliedResultContract?.kind ?? null,
		toolLaneObserved: lifecycle.runtimeKind !== "subprocess",
		...(req.gate?.packet !== undefined ? { packet: req.gate.packet.ids } : {}),
		...(req.gate?.packet?.verified !== undefined ? { verifiedChecks: req.gate.packet.verified } : {}),
	};
	const gradeFacts: GradeFacts = {
		termination: { outcome, detail: terminationDetail },
		changeReturnFailure,
		workerCode: {
			code: resolvedOutcomeCode.code,
			...(workerCodeDetail !== undefined ? { detail: workerCodeDetail } : {}),
		},
		...(wallHandback !== undefined ? { wallHandback } : {}),
		finishGateEngaged: finishContract?.rigor === "high" && finishContract.assessment.kind === "engage",
		blockedWrites: blockedWriteAttempts(toolStats, classifyTool, mutatedPathCount),
	};
	settling.graded = grade(gradeContract, gradeFacts);
	const applyGrade = (next: GradeVerdict): void => {
		settling.graded = next;
		settling.finalOutcome = next.outcome;
		attempt.outcomeCode = next.outcomeCode;
		settling.finalDetail = next.detail;
		if (next.messageChanged && next.detail !== null) attempt.failureMessage = next.detail;
	};
	settling.finalOutcome = settling.graded.outcome;
	settling.finalDetail = settling.graded.detail;
	applyGrade(settling.graded);
	// A write worker that stopped to ask for wider write roots changed
	// nothing; whether the assignment continues is the request's decision.
	let writeRootRequest: string | null = null;
	const askedWriteRoots =
		settling.finalOutcome === "succeeded" && gradeContract.role === "builder" && mutatedPathCount === 0
			? writeRootRequestFromEntries(finishContractEntries)
			: null;
	if (askedWriteRoots !== null) {
		const resolution = resolveWriteRootRequest(req, askedWriteRoots);
		const routable = resolution.ok && req.mainGrantRoute?.kind === "yield" && typeof req.ownerSessionId === "string";
		if (resolution.ok && routable) rt.retry.writeRootPark.stage(envelope.id, resolution.request);
		writeRootRequest = writeRootRequestDetail(askedWriteRoots, resolution, routable);
	}
	// Close steering provenance before taking receipt snapshots. A late
	// acknowledgement after the bounded drain cannot race the sealed facts.
	const steering = snapshotSteeringProvenance();
	const capturedOutput = outputCapture.snapshot();
	const finalText = capturedOutput?.state === "final" ? capturedOutput.text : null;
	const resultContract = validateRecipeResult({
		contract: appliedResultContract,
		reachedTerminalResult: resultContractWasDue(
			settling.finalOutcome,
			attempt.outcomeCode,
			attempt.refusalLimit === "reported",
		),
		output: finalText,
		outputTruncated: capturedOutput?.truncated === true,
		cwd: lifecycle.cwd,
		networkAllowed:
			workerHasNetworkPosture(lifecycle.admission) ||
			lifecycle.target.runtime.externalAgentLoop?.network === "externally-governed-unobserved",
		observedRunEffects,
		filesystem: nodeResultContractFilesystem(),
	});
	const resultValidation = resultContract?.applicable === true ? resultContract.validation : null;
	// Same grounding E7 applied to mutatedPaths, one field over. The
	// typed validators derive quality from the report's own words: the
	// verifier's from its verdict alone, the mutation report's from
	// whether *any* command ran rather than the named one. A claim with
	// no matching execution is not correctness evidence, so it seals
	// unmeasured and says which claim it was.
	const groundingInput: ValidationGroundingInput = {
		contractKind: appliedResultContract?.kind ?? null,
		output: finalText,
		// The wider set, matching the wider vocabulary the claim side reads
		// under. A run that verified with `git diff` or `npx vitest` did
		// check something, and calling that claim ungrounded is the same
		// false-confidence defect pointed the other way. The strict set
		// stays where a match opens a gate, in the result contract's
		// measured judgement above.
		executedCommands: observedRunEffects.verificationCommands,
		unattributableCommands: observedRunEffects.unattributableVerificationCommands,
		// Only verify runs on the final tree ground a claim by check id or resolved command (bt-9, bt-27c).
		verifyRuns: runEffects.checkFreshness().verifyRuns,
		executedCheckingCalls: countCheckingCalls(toolStats, verifyCalls.calls),
		toolLaneObserved: gradeContract.toolLaneObserved,
		// The worker derived the same gates from the same task text.
		...(contractDeclaresTaskGates(appliedResultContract?.kind) ? { taskGates: extractTaskGates(req.task).gates } : {}),
		readOnly: lifecycle.readOnly,
	};
	const validationGrounding = groundClaimedValidations(groundingInput);
	const observationNote = readOnlyObservationNote(groundingInput, validationGrounding);
	const activity = summarizeToolActivity(toolStats, classifyTool);
	// A limitation the run recorded is a typed declaration whether or not the finish contract kept its words: an
	// assessment of a run that changed nothing carries no evidence, and an empty list is not "none recorded".
	const limitationSummaries =
		finishContract?.assessment.evidence
			.filter((item) => item.kind === "limitation")
			.map((item) => item.summary.trim())
			.filter((summary) => summary.length > 0) ?? [];
	const recordedLimitations =
		(toolStats.get(ToolNames.Limitation)?.ok ?? 0) > 0
			? limitationSummaries.length > 0
				? limitationSummaries
				: ["a limitation was recorded"]
			: [];
	gradeFacts.handback = {
		finalOutput: hasDurableFinalOutput(capturedOutput),
		resultContract:
			resultContract === null
				? null
				: resultValidation === null
					? { conformance: "not-reached", reason: null }
					: { conformance: resultValidation.conformance, reason: resultValidation.reason ?? null },
	};
	gradeFacts.work = {
		activity:
			lifecycle.runtimeKind === "subprocess"
				? null
				: {
						executed: executedCalls(activity),
						observations: observationCalls(toolStats, classifyTool),
						mutatingSucceeded: activity.mutatingSucceeded,
						storeWritten: activity.storeWritten === true,
					},
		mutatedPathCount,
		blockedStateChanging: blockedStateChangingCalls(toolStats, classifyTool),
		escalations: {
			denied: escalationCounts.denied,
			...(attempt.escalationDeniedBy !== undefined ? { deniedBy: attempt.escalationDeniedBy } : {}),
			timedOut: escalationCounts.timedOut,
		},
		recordedLimitations: recordedLimitations.length > 0 ? recordedLimitations : [],
		writeRootRequest,
		completion: builderReportCompletion(appliedResultContract, finalText),
		// A claim is unmet evidence only when no checking call ran at all; a name that matched no command lowers quality.
		ungroundedChecks:
			validationGrounding !== null && invalidatesQuality(validationGrounding) ? validationGrounding.ungrounded : [],
		gateVerdict: gateVerdictFactsOf(appliedResultContract, finalText, (claim) =>
			groundGateCheck(
				{
					executedCommands: observedRunEffects.verificationCommands,
					verifyRuns: runEffects.checkFreshness().verifyRuns,
				},
				claim,
			),
		),
	};
	applyGrade(grade(gradeContract, gradeFacts));
	let sealedResultContractFact: RunResultContractFact | null =
		resultContract === null
			? null
			: validationGrounding !== null && invalidatesQuality(validationGrounding) && resultContract.fact.quality === "pass"
				? { ...resultContract.fact, quality: "unmeasured" }
				: resultContract.fact;
	// FX-19: a run owing evidence it did not gather grades fail, so retry and summaries count it.
	if (settling.graded.qualityFail && sealedResultContractFact !== null)
		sealedResultContractFact = { ...sealedResultContractFact, quality: "fail" };
	if (validationGrounding !== null && validationGrounding.ungrounded.length > 0)
		detailNotes.push(describeUngroundedValidations(validationGrounding));
	if (observationNote !== null && sealedResultContractFact?.quality === "pass") {
		sealedResultContractFact = { ...sealedResultContractFact, quality: "unmeasured" };
		detailNotes.push(observationNote);
	}
	settling.sealedResultContractFact = sealedResultContractFact;
	return {
		result,
		finalCallUsage,
		endedAt,
		evidence,
		observedRunEffects,
		authoredPaths,
		detailNotes,
		appliedResultContract,
		gradeContract,
		gradeFacts,
		applyGrade,
		steering,
		capturedOutput,
		finalText,
		resultValidation,
		validationGrounding,
	};
}
