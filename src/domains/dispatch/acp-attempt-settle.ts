// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { readPancodeVersion } from "../../core/package-root.js";
import { spendSumsOf } from "../../core/telemetry/pricing.js";
import type { AcpDelegationRunHandle } from "../../engine/acp/adapter.js";
import { readPiMonoVersion } from "../../engine/pi-mono-names.js";
import { applyTaskWorktree, discardIdleTaskWorktree, settleTaskWorktree } from "../../tools/task-worktree.js";
import type { TaskWorktreePreview } from "../../tools/task-worktree-preview.js";
import { recordOnlyAcpPermit } from "../safety/worker-permit.js";
import type { RunningDelegation } from "./acp-attempt-state.js";
import { acpToolActionClass } from "./admission-scope.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { awaitEventDrain, LOCAL_RUN_NODE, runSettlementReceiptFields, sealRouteDecision } from "./bundle-support.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { classifyFailure, isContextOverflowFailure } from "./failure-classification.js";
import { type GradeContract, type GradeFacts, grade } from "./grading.js";
import { sealedAnswerBudgetBytes } from "./handback.js";
import { resolveObligation } from "./obligation.js";
import {
	type RunTerminationEvidence,
	resolveRunOutcome,
	resolveRunTerminalReason,
	runStatusForOutcome,
} from "./outcome.js";
import { recordRunTimingBestEffort } from "./phase-timing.js";
import { defaultRoutingIntent } from "./routing-intent.js";
import { unobservedRunUsageFacts } from "./run-call-usage.js";
import { createRunResultQuality, deriveRunVerification } from "./run-findings.js";
import {
	assessDispatchFinishContract,
	emitTerminalDispatchEvent,
	type FinalizingRun,
	publishedLineage,
	sealTaskWorktreeReceipt,
	snapshotUnappliedTaskWorktree,
} from "./run-finish.js";
import { hasDurableFinalOutput, MAX_ACP_FAILURE_DETAIL_BYTES } from "./run-outcome-detail.js";
import { receiptPermitSummary } from "./run-receipt-summary.js";
import { receiptAssurance, settleRunResult } from "./run-settlement.js";
import {
	blockedWriteAttempts,
	countToolCalls,
	snapshotToolStats,
	snapshotUnfinishedTools,
	summarizeToolActivity,
} from "./tool-stats.js";
import type {
	RunEnvelope,
	RunOutcome,
	RunResult,
	RunResultDraft,
	RunResultOutput,
	RunStatus,
	RunSteeringProvenance,
} from "./types.js";
import type { SpawnedWorkerResult } from "./worker-spawn.js";

export async function settleAcpRun(rt: DispatchRuntime, delegation: RunningDelegation) {
	const { collectReproducibility, getProtectedArtifactState, recordTargetOutcome, recordingJournal, safety } = rt.core;
	const { context } = rt;
	const {
		acp,
		activeRun,
		blockedAttempts,
		budgetEnvelope,
		callUsage,
		closeRunJournal,
		continuation,
		envelope,
		eventPump,
		finalPromise,
		finishContractEntries,
		guardBlockedAttempts,
		hostRun,
		identity,
		inFlightTools,
		launch,
		ledgerRef,
		lifecycle,
		lineage,
		outputCapture,
		permissionRequestedAttempts,
		req,
		routeDecision,
		runJournal,
		runningRowPersisted,
		runtimeId,
		safetyDecisionCounts,
		startedAt,
		steeringProvenance,
		targetId,
		timing,
		tokenMeter,
		toolStats,
		upstreamResponses,
		wireModelId,
	} = delegation;

	const buildReceiptDraft = (
		result: Awaited<AcpDelegationRunHandle["promise"]>,
		endedAt: string,
		status: RunStatus,
		outcome: RunOutcome,
		outcomeDetail: string | null,
		capturedOutput: RunResultOutput | undefined,
		steering: ReadonlyArray<RunSteeringProvenance>,
	): RunResultDraft => {
		// The peer's own reports reach the run journal as run.usage_reported, so the call fold is the run's spend;
		// a run whose telemetry never arrived stays unknown (#434).
		const usage = callUsage?.snapshot();
		const spend = usage?.facts ?? unobservedRunUsageFacts();
		const spendSums = usage?.sums ?? spendSumsOf(spend);
		const safetyMetadata = safety.policy?.metadata() ?? null;
		const init = result.delegation.initialize;
		const agentInfo = init?.agentInfo;
		const finalFailureMessage = result.failureMessage ?? delegation.failureMessage;
		const finalToolStats = snapshotToolStats(toolStats);
		const unfinished = snapshotUnfinishedTools(inFlightTools);
		return {
			runId: envelope.id,
			cwd: envelope.cwd,
			agentId: req.agentId,
			executionRole: envelope.executionRole,
			requestOrigin: lifecycle.requestOrigin,
			task: req.task,
			answerBudgetBytes: sealedAnswerBudgetBytes(req.answerBudgetBytes),
			...(req.intent !== undefined ? { intent: structuredClone(req.intent) } : {}),
			targetId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
			outcome,
			outcomeCode: delegation.outcomeCode,
			outcomeDetail,
			lineage: publishedLineage(lineage, hostRun),
			identity,
			// An ACP peer is spawned by this process, so the run's node is this host.
			node: LOCAL_RUN_NODE,
			...(lifecycle.pipeline ? { pipeline: lifecycle.pipeline } : {}),
			...(lifecycle.briefing ? { briefing: lifecycle.briefing } : {}),
			...(req.contextSeed ? { workerContext: structuredClone(req.contextSeed.provenance) } : {}),
			...(steering.length > 0 ? { steering: steering.map((entry) => ({ ...entry })) } : {}),
			...(req.gate !== undefined ? { gate: req.gate } : {}),
			...(req.council !== undefined ? { council: req.council } : {}),
			...(req.plan !== undefined ? { plan: req.plan } : {}),
			...(lifecycle.personaOverride ? { personaOverride: lifecycle.personaOverride } : {}),
			...(lifecycle.decisionRefs ? { decisionRefs: lifecycle.decisionRefs } : {}),
			budget: budgetEnvelope,
			projectContext: lifecycle.projectContext,
			rulesApplied: lifecycle.rulesApplied,
			operatorProfileApplied: lifecycle.operatorProfileApplied,
			startedAt,
			endedAt,
			exitCode:
				status === "dead" || status === "interrupted" || (status === "failed" && result.exitCode === 0)
					? 1
					: result.exitCode,
			...(finalFailureMessage !== undefined ? { failureMessage: finalFailureMessage } : {}),
			spend,
			spendSums,
			...(tokenMeter.toolRounds ? { toolRounds: tokenMeter.toolRounds } : {}),
			...(upstreamResponses.length > 0 ? { upstreamResponses: [...upstreamResponses] } : {}),
			...(capturedOutput !== undefined ? { output: capturedOutput } : {}),
			compiledPromptHash: lifecycle.compiledPromptHash,
			staticCompositionHash: lifecycle.staticCompositionHash,
			sessionShellHash: lifecycle.sessionShellHash,
			dynamicHash: lifecycle.dynamicHash,
			promptSignature: lifecycle.promptSignature,
			toolSignature: lifecycle.toolSignature,
			pancodeVersion: readPancodeVersion(),
			piMonoVersion: readPiMonoVersion(),
			platform: process.platform,
			nodeVersion: process.version,
			toolCalls: countToolCalls(toolStats),
			toolStats: finalToolStats,
			// PanCode-observed telemetry only: an external ACP agent executes its
			// own tools, so no zero-activity note is derived from this record.
			toolActivity: summarizeToolActivity(toolStats, acpToolActionClass),
			verification: deriveRunVerification({ toolStats: finalToolStats }, { acpDelegation: true }),
			routingIntent: req.routingIntent ?? defaultRoutingIntent(req),
			effectiveFailover: rt.retry.failoverModeFor(req),
			quality: createRunResultQuality({ runtimeEnforceable: false, enforcementPassed: null, resultContract: null }),
			autonomy: "default",
			safety: {
				decisions: safetyDecisionCounts,
				blockedAttempts,
				...(guardBlockedAttempts.length > 0 ? { guardBlockedAttempts } : {}),
				...(permissionRequestedAttempts.length > 0 ? { permissionRequestedAttempts } : {}),
				requestedActions: lifecycle.admission.requestedActions,
				...(lifecycle.admission.toolProfile !== undefined ? { toolProfile: lifecycle.admission.toolProfile } : {}),
				...(req.readOnly === true ? { readOnly: true as const } : {}),
				toolTelemetry: {
					coverage: "unavailable",
					ingestionErrors: delegation.toolTelemetryIngestionErrors,
					unfinished,
					workspaceMutationPossible: true,
				},
				runtimeLimitations: lifecycle.runtimeLimitations,
				// PanCode cannot hold a peer to a permit, so the receipt states the
				// intended one and marks it record-only (operator decision).
				permit: receiptPermitSummary(
					recordOnlyAcpPermit({
						readOnly: req.readOnly === true,
						toolGovernance: lifecycle.agentConfig.toolGovernance ?? "pancode-policy",
						trustedUnmediated:
							lifecycle.agentConfig.toolGovernance === "agent-managed" && lifecycle.agentConfig.trustedUnmediated === true,
					}),
				),
			},
			reproducibility: collectReproducibility(lifecycle.cwd, safetyMetadata),
			delegation: {
				agentConfigId: lifecycle.agentConfig.id,
				...(result.delegation.selectedModelId !== undefined ? { selectedModelId: result.delegation.selectedModelId } : {}),
				command: lifecycle.agentConfig.command,
				args: [...(lifecycle.agentConfig.args ?? [])],
				acpSessionId: result.delegation.acpSessionId,
				acpProtocolVersion: typeof init?.protocolVersion === "number" ? init.protocolVersion : null,
				acpAgentName: agentInfo?.title ?? agentInfo?.name ?? null,
				acpAgentVersion: agentInfo?.version ?? null,
				agentCapabilities: init?.agentCapabilities ?? {},
				toolCallsRequested: result.delegation.toolCallsRequested,
				toolCallsApproved: result.delegation.toolCallsApproved,
				toolCallsDenied: result.delegation.toolCallsDenied,
				toolGovernance: lifecycle.agentConfig.toolGovernance ?? "pancode-policy",
				...(lifecycle.agentConfig.toolGovernance === "agent-managed" && lifecycle.agentConfig.trustedUnmediated === true
					? { trustedUnmediated: true as const }
					: {}),
				toolCallLog: acp.toolCallLog(),
				opened: result.delegation.opened,
				...(result.delegation.replayedUpdates !== undefined ? { replayedUpdates: result.delegation.replayedUpdates } : {}),
				...(result.delegation.postSettle !== undefined ? { postSettle: { ...result.delegation.postSettle } } : {}),
				...(continuation !== null
					? {
							continuedFrom: {
								runId: continuation.fromRunId,
								acpSessionId: continuation.acpSessionId,
								...(continuation.kind === "fresh" ? { freshReason: continuation.reason } : {}),
							},
						}
					: {}),
				...(result.delegation.nonResumable !== undefined ? { nonResumable: result.delegation.nonResumable } : {}),
			},
			// The delegate's own ACP session id is recorded above as
			// delegation.acpSessionId. This field names the PanCode session that
			// owns the run, the same as on every other runtime's receipt.
			sessionId: req.ownerSessionId ?? null,
		};
	};

	const finalizing: FinalizingRun = {
		runId: envelope.id,
		req,
		requestOrigin: lifecycle.requestOrigin,
		targetId,
		wireModelId,
		runtimeId,
		runtimeKind: "acp-delegation",
		lineage,
		hostRun,
	};

	(async (): Promise<RunResult> => {
		try {
			const result = await acp.promise;
			// The peer session is what a later continue_run reopens, so the ledger row keeps it with the peer's verdict.
			if (result.delegation.acpSessionId !== null)
				ledgerRef.update(envelope.id, {
					acpSession: {
						sessionId: result.delegation.acpSessionId,
						...(result.delegation.nonResumable !== undefined ? { nonResumable: result.delegation.nonResumable } : {}),
					},
				});
			// The receipt reads meters the domain pump fills. Finalization
			// always waits (bounded by the drain grace) for the pump to finish
			// the source stream, whether or not an external consumer ever
			// subscribed, so a fast peer cannot seal a zero-token receipt.
			if (!(await awaitEventDrain(eventPump.done))) {
				runJournal?.gap("writer-drop");
				callUsage?.gap();
				recordingJournal.gap(envelope.id, 1);
				delegation.toolTelemetryIngestionErrors += 1;
				reportDispatchDiagnostic(`run ${envelope.id}`, new Error("event stream did not drain before run finalization"));
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
				exitCode: result.exitCode,
				abortedByOperator: activeRun.aborted,
				abortDetail: activeRun.abortDetail,
				abortCause: activeRun.abortCause,
				stallKilled: activeRun.stallKilled,
				timedOut: result.timedOut === true,
				permissionFailure: false,
				policyDenied: null,
				stopReason: result.stopReason ?? null,
			};
			const { outcome, detail } = resolveRunOutcome(evidence);
			// A failure the adapter typed (sign-in, an unoffered model or thinking level, a broken channel) settles
			// under its own code, with the adapter's words beside the generic exit detail (C-16).
			const adapterCode = outcome === "failed" ? (result.failureCode ?? null) : null;
			const terminationDetail =
				adapterCode !== null && result.failureMessage !== undefined
					? boundedExternalDiagnostic(
							detail !== null ? `${detail}; ${result.failureMessage}` : result.failureMessage,
							MAX_ACP_FAILURE_DETAIL_BYTES,
						)
					: detail;
			// Same high-rigor completion gate as native dispatch: an external
			// agent is a guest inside PanCode's policy model, not an exemption.
			const finishContract = assessDispatchFinishContract(
				{ safety },
				{
					req,
					runId: envelope.id,
					cwd: lifecycle.cwd,
					entries: finishContractEntries,
					assistantText: delegation.finishContractAssistantText,
					assistantTurnId: delegation.finishContractAssistantTurnId,
				},
			);
			// The same grader as native dispatch (DESIGN 4.8). PanCode did not see the peer's tool lane, so its activity
			// is unobserved and an obligation it would need reads unknown, never unmet. The all-writes-refused rule is
			// judged from the ACP tool kinds PanCode observed and admitted; any run not pinned read-only is a builder.
			const acpRole = req.readOnly === true ? "explorer" : "builder";
			const gradeContract: GradeContract = {
				role: acpRole,
				obligation: resolveObligation(acpRole, null, req.intent?.readRoots ?? []),
				contractKind: null,
				toolLaneObserved: false,
			};
			const capturedOutput = outputCapture.snapshot();
			// Closed before the receipt snapshot, so a late acknowledgement cannot race the sealed facts.
			delegation.steeringProvenanceClosed = true;
			const steering = steeringProvenance.map((entry) => ({ ...entry }));
			const gradeFacts: GradeFacts = {
				termination: { outcome, detail: terminationDetail },
				workerCode: { code: adapterCode },
				finishGateEngaged: finishContract?.rigor === "high" && finishContract.assessment.kind === "engage",
				blockedWrites: blockedWriteAttempts(toolStats, acpToolActionClass),
				handback: { finalOutput: hasDurableFinalOutput(capturedOutput), resultContract: null },
				work: {
					activity: null,
					mutatedPathCount: finishContract?.assessment.mutatedPaths.length ?? null,
					blockedStateChanging: 0,
					escalations: { denied: 0, timedOut: 0 },
					recordedLimitations: [],
					writeRootRequest: null,
					completion: null,
					ungroundedChecks: [],
					gateVerdict: null,
				},
			};
			let graded = grade(gradeContract, gradeFacts);
			if (graded.qualityGateFailure) evidence.qualityGateFailure = true;
			let finalOutcome = graded.outcome;
			let finalDetail = graded.detail;
			delegation.outcomeCode = graded.outcomeCode;
			if (graded.messageChanged && graded.detail !== null) delegation.failureMessage = graded.detail;
			let worktreeReceipt: RunResultDraft["worktree"];
			let accounted: TaskWorktreePreview | undefined;
			if (req.taskWorktree !== undefined && finalOutcome === "succeeded") {
				worktreeReceipt = applyTaskWorktree({
					worktree: req.taskWorktree,
					apply: req.apply ?? "merge",
					protectedPaths: getProtectedArtifactState().artifacts.map((artifact) => artifact.path),
					// ACP delegation keeps no write record, so the host cannot tell the
					// agent's new files from byproducts and commits every untracked file.
					authoredPaths: null,
					onAccounted: (entry) => {
						accounted = entry;
					},
				});
				gradeFacts.landing = {
					failure:
						worktreeReceipt.reason === undefined
							? null
							: { code: null, detail: worktreeReceipt.detail ?? worktreeReceipt.reason },
				};
				graded = grade(gradeContract, gradeFacts);
				finalOutcome = graded.outcome;
				finalDetail = graded.detail;
				delegation.outcomeCode = graded.outcomeCode;
				if (graded.messageChanged && graded.detail !== null) delegation.failureMessage = graded.detail;
			}
			if (req.taskWorktree !== undefined && worktreeReceipt === undefined) {
				worktreeReceipt = snapshotUnappliedTaskWorktree(req.taskWorktree, req.apply ?? "merge");
				// An already failed run whose HEAD also moved says so, so the
				// operator knows the preserved branch lacks the work (F5).
				if (worktreeReceipt.detail !== undefined) {
					finalDetail = [finalDetail, worktreeReceipt.detail].filter(Boolean).join("; ");
					delegation.failureMessage = finalDetail;
				}
			}
			const status = runStatusForOutcome(finalOutcome);
			const classifiedResult: SpawnedWorkerResult = {
				exitCode: result.exitCode,
				signal: null,
				...(delegation.failureMessage ? { stderrTail: delegation.failureMessage } : {}),
			};
			const failureClass = classifyFailure(evidence, classifiedResult, finalOutcome, delegation.outcomeCode);
			const contextOverflow = isContextOverflowFailure(failureClass, classifiedResult, delegation.outcomeCode);
			const receiptDraft = buildReceiptDraft(result, endedAt, status, finalOutcome, finalDetail, capturedOutput, steering);
			receiptDraft.verdict = {
				version: 1,
				obligation: gradeContract.obligation,
				rules: graded.rules,
				assurance: receiptAssurance(receiptDraft),
			};
			const terminal = resolveRunTerminalReason(evidence, delegation.outcomeCode);
			delegation.resolvedTerminal = terminal;
			Object.assign(receiptDraft, runSettlementReceiptFields(terminal, callUsage?.snapshot()));
			worktreeReceipt = sealTaskWorktreeReceipt({ context }, req, envelope.id, worktreeReceipt, accounted, receiptDraft);
			const ledgerPatch: Partial<RunEnvelope> = {
				status,
				outcome: finalOutcome,
				outcomeCode: delegation.outcomeCode,
				outcomeDetail: finalDetail,
				endedAt,
				exitCode: receiptDraft.exitCode,
				sessionId: receiptDraft.sessionId,
				spend: receiptDraft.spend,
				spendSums: receiptDraft.spendSums,
				...(steering.length > 0 ? { steering: steering.map((entry) => ({ ...entry })) } : {}),
				sessionShellHash: receiptDraft.sessionShellHash ?? null,
				dynamicHash: receiptDraft.dynamicHash ?? null,
				heartbeatAt: rt.heartbeat.heartbeatIso(acp.heartbeatAt),
			};
			activeRun.sealing = true;
			if (runJournal === undefined) throw new Error(`run ${envelope.id} has no run journal to settle in`);
			const receipt = await settleRunResult(
				ledgerRef,
				envelope.id,
				sealRouteDecision(receiptDraft, routeDecision),
				ledgerPatch,
				runJournal,
				{ terminal, processExitCode: result.exitCode, frameType: null, usage: callUsage?.snapshot()?.facts },
			);
			await ledgerRef.persist();
			if (worktreeReceipt?.applied !== true && req.taskWorktree !== undefined) {
				try {
					// A canceled run that never produced work leaves nothing to keep.
					if (!(finalOutcome === "canceled" && discardIdleTaskWorktree(req.taskWorktree))) {
						settleTaskWorktree(req.taskWorktree, accounted);
					}
				} catch (settleError) {
					reportDispatchDiagnostic(`settle task worktree ${req.taskWorktree.runId}`, settleError);
				}
			}
			rt.runs.active.delete(envelope.id);
			recordTargetOutcome(envelope.id, targetId, runtimeId, wireModelId, status, receipt.exitCode, failureClass);
			rt.runs.accumulateFinalizedTotals(receipt);
			// A terminal event's readers show the sealed record, so the seal lands first with the feed's last rows in it.
			rt.runs.journalBridge?.closeFeed(finalOutcome, receipt.outcomeDetail, {
				runId: envelope.id,
				agentId: req.agentId,
				exitCode: receipt.exitCode,
			});
			await closeRunJournal();
			emitTerminalDispatchEvent({ context }, finalizing, receipt, finalOutcome);
			rt.retry.completeAssignmentAttempt(
				activeRun,
				receipt,
				finalOutcome,
				receipt.outcomeDetail ?? finalDetail,
				failureClass,
				contextOverflow,
			);
			return receipt;
		} catch (error) {
			await rt.runs.failFinalization(
				finalizing,
				{ ledger: ledgerRef, envelope, runJournal, terminal: delegation.resolvedTerminal, timing },
				error,
			);
			throw error;
		} finally {
			// A terminal seal that did not land fails the run, after its slot is released (#434).
			try {
				await closeRunJournal();
			} finally {
				launch.release();
			}
		}
	})().then(delegation.resolveFinal, delegation.rejectFinal);
	rt.runs.active.set(envelope.id, activeRun);
	rt.capacity.stopIfCapacityLost(envelope.id, launch.lease.leaseId);
	rt.heartbeat.watchAssignmentDeadline(activeRun);
	// The handle goes out once the running row is durable, as it did with the
	// sync writer: a sibling session's steer reads ownership from runs.json,
	// and without the row it fell through to the assignment and let a foreign
	// cancel through (#428).
	await runningRowPersisted;

	return {
		runId: envelope.id,
		events: eventPump.events,
		finalPromise,
	};
}
