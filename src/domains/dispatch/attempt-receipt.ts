// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { readPancodeVersion } from "../../core/package-root.js";
import { runtimeSpeaksResponseSchemaDialect } from "../../core/response-schema.js";
import { workerSandboxReceipt } from "../../core/sandbox/worker-policy.js";
import { readPiMonoVersion } from "../../engine/pi-mono-names.js";
import { runtimeTargetSnapshot } from "../providers/index.js";
import { classify as classifyAction } from "../safety/action-classifier.js";
import type { RunningAttempt } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { LOCAL_RUN_NODE } from "./bundle-support.js";
import { envelopeForPermit } from "./envelope.js";
import { defaultRoutingIntent } from "./routing-intent.js";
import {
	createRunResultQuality,
	deriveRunVerification,
	typedValidationFactsFromObservedEffects,
	typedValidationFactsFromVerifyCalls,
	unclassifiedAfterLastCheck,
} from "./run-findings.js";
import { type FinalizingRun, publishedLineage } from "./run-finish.js";
import {
	mergeRouteWarningDetail,
	mergeWorkerDiagnosticDetail,
	mergeWorkerDiagnosticFailure,
} from "./run-outcome-detail.js";
import {
	protectedArtifactReceiptSummary,
	receiptEnvelopeSummary,
	receiptGrantAudit,
	receiptPermitSummary,
} from "./run-receipt-summary.js";
import {
	countToolCalls,
	recordToolFinish,
	snapshotToolStats,
	snapshotUnfinishedTools,
	summarizeToolActivity,
	zeroSuccessfulToolNote,
} from "./tool-stats.js";
import type {
	RunOutcome,
	RunResultContractFact,
	RunResultDraft,
	RunResultOutput,
	RunStatus,
	RunSteeringProvenance,
	RunValidationGrounding,
} from "./types.js";
import { meterSpend, meterSums } from "./worker-event-fold.js";
import type { SpawnedWorkerResult } from "./worker-spawn.js";

export function createAttemptReceiptDraft(rt: DispatchRuntime, attempt: RunningAttempt) {
	const { collectReproducibility, safety } = rt.core;
	const {
		blockedAttempts,
		envelope,
		escalationCounts,
		gatewayFinishes,
		grantAttempt,
		guardBlockedAttempts,
		hostRun,
		identity,
		inFlightTools,
		lifecycle,
		permissionRequestedAttempts,
		placement,
		req,
		runEffects,
		safetyDecisionCounts,
		settlement,
		skillActivations,
		startedAt,
		telemetryIngestionErrorsOf,
		tokenMeter,
		toolStats,
		toolTelemetryCoverageOf,
		upstreamResponses,
		verifyCalls,
	} = attempt;

	const buildReceiptDraft = (
		result: SpawnedWorkerResult,
		endedAt: string,
		status: RunStatus,
		outcome: RunOutcome,
		outcomeDetail: string | null,
		capturedOutput: RunResultOutput | undefined,
		steering: ReadonlyArray<RunSteeringProvenance>,
		resultContract: RunResultContractFact | null,
		validationGrounding: RunValidationGrounding | null,
	): RunResultDraft => {
		// A canceled run seals status "interrupted" and must not report exit 0:
		// the terminal state disagrees with a success code. This mirrors the ACP
		// receipt builder, which already coerces "interrupted" to nonzero.
		const receiptExitCode =
			status === "dead" || status === "interrupted" || (status === "failed" && result.exitCode === 0)
				? 1
				: (result.exitCode ?? 1);
		// A wrapper whose result never arrived still counts once.
		for (const wrapper of gatewayFinishes.values()) recordToolFinish(toolStats, wrapper);
		gatewayFinishes.clear();
		const toolActivity = summarizeToolActivity(toolStats, (tool) => safety.classify({ tool }).actionClass);
		// A run that exits 0 with zero successful tool calls keeps its
		// succeeded outcome (the harness cannot judge semantic completion),
		// but the receipt must not stay silent about the empty trail.
		const activityNote = outcome === "succeeded" ? zeroSuccessfulToolNote(toolActivity) : null;
		// An operator cancel already names its reason; the abort the worker logged on its way out is not a diagnosis.
		const includeDiagnostics = outcome !== "succeeded" && outcome !== "canceled";
		const routeOutcomeDetail = mergeRouteWarningDetail(lifecycle.target.routeWarning, outcomeDetail ?? activityNote);
		const finalOutcomeDetail = mergeWorkerDiagnosticDetail(routeOutcomeDetail, result, includeDiagnostics);
		const finalFailureMessage = mergeWorkerDiagnosticFailure(attempt.failureMessage, result, includeDiagnostics);
		const safetyMetadata = safety.policy?.metadata() ?? null;
		const protectedArtifacts = protectedArtifactReceiptSummary(attempt.spec.protectedArtifactState);
		const finalToolStats = snapshotToolStats(toolStats);
		const checkFreshness = runEffects.checkFreshness();
		const typedValidations = [
			...typedValidationFactsFromVerifyCalls(finalToolStats, verifyCalls.calls, checkFreshness),
			...typedValidationFactsFromObservedEffects(runEffects.snapshot()),
		];
		const unclassified = unclassifiedAfterLastCheck(runEffects.snapshot());
		const unfinished = snapshotUnfinishedTools(inFlightTools);
		const telemetryIngestionErrors = telemetryIngestionErrorsOf(result);
		const workspaceMutationPossible =
			lifecycle.runtimeKind === "subprocess"
				? !["claude-code", "codex-cli", "pi-cli"].includes(lifecycle.target.runtime.id) || !lifecycle.readOnly
				: lifecycle.admission.allowedTools.some((tool) => classifyAction({ tool }).actionClass !== "read");
		const toolTelemetryCoverage = toolTelemetryCoverageOf(telemetryIngestionErrors, unfinished.length);
		return {
			runId: envelope.id,
			cwd: envelope.cwd,
			agentId: req.agentId,
			executionRole: envelope.executionRole,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			task: req.task,
			budget: lifecycle.budgetEnvelope,
			answerBudgetBytes: lifecycle.answerBudgetBytes,
			targetId: lifecycle.target.target.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			outcome,
			outcomeCode: attempt.outcomeCode,
			lineage: publishedLineage(attempt.lineage, hostRun),
			...(req.intent !== undefined ? { intent: structuredClone(req.intent) } : {}),
			identity,
			node: placement?.node ?? LOCAL_RUN_NODE,
			...(placement?.reroutes !== undefined && placement.reroutes.length > 0 ? { reroutes: [...placement.reroutes] } : {}),
			...(lifecycle.pipeline ? { pipeline: lifecycle.pipeline } : {}),
			...(lifecycle.briefing ? { briefing: lifecycle.briefing } : {}),
			...(req.contextSeed ? { workerContext: structuredClone(req.contextSeed.provenance) } : {}),
			...(steering.length > 0 ? { steering: steering.map((entry) => ({ ...entry })) } : {}),
			...(req.gate !== undefined ? { gate: req.gate } : {}),
			...(req.council !== undefined ? { council: req.council } : {}),
			...(req.plan !== undefined ? { plan: req.plan } : {}),
			...(lifecycle.personaOverride ? { personaOverride: lifecycle.personaOverride } : {}),
			...(lifecycle.decisionRefs ? { decisionRefs: lifecycle.decisionRefs } : {}),
			projectContext: lifecycle.projectContext,
			rulesApplied: lifecycle.rulesApplied,
			operatorProfileApplied: lifecycle.operatorProfileApplied,
			...(validationGrounding !== null ? { validationGrounding } : {}),
			...(unclassified !== null ? { unclassifiedAfterLastCheck: unclassified } : {}),
			...(lifecycle.capabilityMismatch !== null
				? {
						capabilityMismatch: {
							agentId: lifecycle.capabilityMismatch.agentId,
							capabilityClass: lifecycle.capabilityMismatch.capabilityClass,
							taskType: lifecycle.capabilityMismatch.taskType,
							suggestedAgentId: lifecycle.capabilityMismatch.suggestedAgentId,
						},
					}
				: {}),
			startedAt,
			endedAt,
			exitCode: receiptExitCode,
			outcomeDetail: finalOutcomeDetail,
			...(finalFailureMessage !== undefined ? { failureMessage: finalFailureMessage } : {}),
			spend: meterSpend(tokenMeter),
			spendSums: meterSums(tokenMeter),
			...(tokenMeter.toolRounds ? { toolRounds: tokenMeter.toolRounds } : {}),
			...(upstreamResponses.length > 0 ? { upstreamResponses: [...upstreamResponses] } : {}),
			...(capturedOutput !== undefined ? { output: capturedOutput } : {}),
			...(attempt.externalTelemetry ? { externalTelemetry: attempt.externalTelemetry } : {}),
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
			toolActivity,
			verification: deriveRunVerification(
				{ toolStats: finalToolStats, typedValidations },
				{ capabilityClass: lifecycle.capabilityClass, checkFreshness },
			),
			routingIntent: req.routingIntent ?? defaultRoutingIntent(req),
			effectiveFailover: rt.retry.failoverModeFor(req),
			quality: createRunResultQuality({
				...(req.responseSchema === undefined ? {} : { responseSchema: req.responseSchema }),
				runtimeEnforceable:
					runtimeSpeaksResponseSchemaDialect(lifecycle.target.runtime) &&
					lifecycle.target.modelCapabilities?.structuredOutputs === "json-schema",
				enforcementPassed:
					req.responseSchema === undefined ? null : outcome === "succeeded" && capturedOutput?.state === "final",
				typedValidations,
				resultContract,
			}),
			...(skillActivations.length > 0 ? { skillActivations: [...skillActivations] } : {}),
			autonomy: "default",
			safety: {
				// Escalation tallies fold in only when an ask escalated, so deny and fail receipts stay byte-identical.
				decisions:
					escalationCounts.requested > 0
						? {
								...safetyDecisionCounts,
								escalationRequested: escalationCounts.requested,
								escalationApproved: escalationCounts.approved,
								escalationDenied: escalationCounts.denied,
								escalationTimedOut: escalationCounts.timedOut,
							}
						: safetyDecisionCounts,
				blockedAttempts,
				...(guardBlockedAttempts.length > 0 ? { guardBlockedAttempts } : {}),
				...(permissionRequestedAttempts.length > 0 ? { permissionRequestedAttempts } : {}),
				...(grantAttempt !== undefined
					? receiptGrantAudit(rt.grants.grantBroker.list({ runId: envelope.id }), envelope.id)
					: {}),
				requestedActions: lifecycle.admission.requestedActions,
				...(lifecycle.admission.toolProfile !== undefined ? { toolProfile: lifecycle.admission.toolProfile } : {}),
				...(lifecycle.readOnly ? { readOnly: true as const } : {}),
				...(req.externalReadApproval !== undefined ? { externalReadApproval: { ...req.externalReadApproval } } : {}),
				permit: receiptPermitSummary(lifecycle.permit, lifecycle.admission.mcpNetworkWithheld),
				envelope: receiptEnvelopeSummary(envelopeForPermit(lifecycle.envelope, lifecycle.permit)),
				toolTelemetry: {
					coverage: toolTelemetryCoverage,
					ingestionErrors: telemetryIngestionErrors,
					unfinished,
					workspaceMutationPossible,
				},
				...(protectedArtifacts !== undefined ? { protectedArtifacts } : {}),
				...(attempt.trustedFlow !== null ? { flowRestrictions: attempt.trustedFlow } : {}),
				runtimeLimitations: lifecycle.runtimeLimitations,
				// A remote worker reports its node's recorded sandbox; this host's answer would
				// be a claim about the wrong machine.
				...(lifecycle.target.runtime.kind === "http"
					? {
							sandbox: {
								...workerSandboxReceipt(attempt.spec.sandbox, lifecycle.placedSandbox, attempt.spec.limits.resources),
								...(attempt.runJournal !== undefined ? { observed: attempt.runJournal.sandboxLaunches() } : {}),
							},
						}
					: {}),
			},
			reproducibility: collectReproducibility(lifecycle.cwd, safetyMetadata),
			runtimeResolution: runtimeTargetSnapshot(lifecycle.target.runtimeResolution),
			sessionId: req.ownerSessionId ?? null,
		};
	};

	const finalizing: FinalizingRun = {
		runId: envelope.id,
		req,
		agentAudience: lifecycle.agentAudience,
		requestOrigin: lifecycle.requestOrigin,
		targetId: lifecycle.target.target.id,
		wireModelId: lifecycle.target.wireModelId,
		runtimeId: lifecycle.target.runtime.id,
		runtimeKind: lifecycle.runtimeKind,
		lineage: attempt.lineage,
		hostRun,
	};

	// The worker is spawned and its ledger row exists, so from here it can
	// write and the batch barrier has to wait for it. Registered after
	// openAttemptRun's try/catch, which aborts the worker and releases the
	// lease on failure, so a run that never reaches the barrier is never made live.
	// Paired with the abandon in dispatch(), which fires the moment
	// finalPromise settles.
	settlement?.live(envelope.id);
	return { buildReceiptDraft, finalizing };
}
