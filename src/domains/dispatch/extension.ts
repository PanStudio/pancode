// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { claudeAuthEnvironment, withClaudeCredential } from "../../core/claude-environment.js";
import { codexAccountScope } from "../../core/codex-account.js";
import { writeHeadlessDiagnostic } from "../../core/diagnostics.js";
import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { routeOutputBound } from "../../core/output-bound.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import { spendSumsOf, sumFactSums, sumRunSpend } from "../../core/telemetry/pricing.js";
import { renderUsdEstimate, renderUsdLimit, renderUsdSpend } from "../../core/telemetry/render.js";
import { readPiMonoVersion } from "../../engine/pi-mono-names.js";
import {
	WORKER_EXTENSION_HOOKS_MAX,
	WORKER_PERMISSION_HOLD_VERSION,
	type WorkerPermissionHoldFrame,
} from "../../worker/protocol.js";
import {
	type AcceptedWorkerSlates,
	bindHostVerificationHypotheses,
	recordAcceptedWorkerSlates,
	recordAgentLedgerDispute,
	recordHostVerificationClaims,
	snapshotAcceptedWorkerSlates,
} from "../claims/index.js";
import { persistWorkerContextSeed } from "../context/worker/store.js";
import { ensureClaudeAgentSdk } from "../lifecycle/claude-sdk-install.js";
import type { CapabilityGate } from "../middleware/capability-gate.js";
import {
	isBuiltinClaudeAcp,
	resolveAuthTarget,
	resolveClaudeLaunchCredential,
	resolveRuntimeAuthTarget,
} from "../providers/auth/index.js";
import type { WorkerFlowPolicyInput } from "../safety/information-flow.js";
import {
	compileWorkerFlowPolicy,
	flowTransferRefusal,
	flowUnmediatedAgentRefusal,
	resolveModelDestination,
} from "../safety/information-flow.js";
import { workspaceStoreTags } from "../store/index.js";
import { assertTurnConstraintCompatibility } from "./tool-constraints.js";
/**
 * Dispatch domain wire-up (post-W5).
 *
 * Resolves a DispatchRequest to an TargetDescriptor + RuntimeDescriptor +
 * wire model id via the providers contract. Gates admission on safety
 * scopes, concurrency, budget, and capability flags. Every admitted runtime
 * kind enters through the native worker subprocess; the worker entry
 * rehydrates the runtime descriptor and delegates runtime-specific execution
 * behind the engine boundary.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { outputLimitCutOffToolCallIds } from "../../core/assistant-output.js";
import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { resolveGuardrail } from "../../core/guardrails.js";
import { sha256Hex } from "../../core/hash.js";
import { readPancodeVersion } from "../../core/package-root.js";
import { asDirectoryPathBoundary } from "../../core/path-boundary.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { runtimeSpeaksResponseSchemaDialect, UnsupportedResponseSchemaError } from "../../core/response-schema.js";
import { requirePricedRefusal } from "../../core/run-overrides.js";
import type { SandboxAvailability } from "../../core/sandbox/types.js";
import { workerMcpNoNetworkNotice, workerSandboxReceipt } from "../../core/sandbox/worker-policy.js";
import { isSkillActivation, type SkillActivation } from "../../core/skill-activation.js";
import { emitApproval } from "../../core/telemetry/approvals.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { workerAgent } from "../../core/telemetry/context.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { DispatchRunIdentity } from "../../core/telemetry/live-events.js";
import { isTestFilePath } from "../../core/test-paths.js";
import { rawDurationMs } from "../../core/timers.js";
import { type ToolName, ToolNames } from "../../core/tool-names.js";
import { snapshotTurnConstraints } from "../../core/turn-constraints.js";
import { isRecord } from "../../core/type-guards.js";
import { pancodeStateDir } from "../../core/xdg.js";
import {
	type AcpDelegationRunHandle,
	type AcpDelegationRunInput,
	type AcpPeerQuestion,
	DEFAULT_CANCEL_GRACE_MS,
	startAcpDelegationRun,
} from "../../engine/acp/adapter.js";
import { DEFAULT_TERMINATION_GRACE_MS, DEFAULT_TERMINATION_WAIT_MS } from "../../engine/acp/transport.js";
import { engineRetryDelayMs, useMainCacheLaneStore } from "../../engine/ai.js";
import { INTERNAL_HELPER_RESULT_TOOL } from "../../engine/worker-tools.js";
import type { AskUserHandler, AskUserQuestion, AskUserResult } from "../../tools/ask-user.js";
import { toolPromptHintsForNames } from "../../tools/builtin-tool-catalog.js";
import {
	addedUntrackedPaths,
	type CheckoutSnapshot,
	changedCheckoutDiff,
	changedCheckoutPaths,
	snapshotCheckoutSince,
	takeCheckoutBaseline,
} from "../../tools/checkout-changes.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../tools/surface.js";
import {
	executeTaskLand,
	heldLandCardPin,
	hostLandRefusal,
	landCardPin,
	landCardPinDrift,
	landHeldTaskBranch,
	planTaskLand,
	type TaskLandPlan,
} from "../../tools/task-land.js";
import {
	applyTaskWorktree,
	cleanupAccountedTaskWorktree,
	createTaskWorktree,
	discardIdleTaskWorktree,
	discardTaskWorktree,
	gitCheckoutRoot,
	settleTaskWorktree,
	taskWorktreeBaseDiff,
	withStrayWrites,
} from "../../tools/task-worktree.js";
import { taskWorktreeHoldsWork } from "../../tools/task-worktree-claims.js";
import {
	overlayTaskWorktree,
	restoreTaskWorktreeOverlay,
	type TaskWorktreeOverlay,
} from "../../tools/task-worktree-overlay.js";
import type { TaskWorktreePreview } from "../../tools/task-worktree-preview.js";
import { keptTaskWorktreeDetail, mergeDestination, previewTaskWorktree } from "../../tools/task-worktree-preview.js";
import { contractDeclaresTaskGates, extractTaskGates } from "../../tools/verify/task-gates.js";
import { protectedPathsChangedByWorktreeBranch } from "../../tools/worktree-branch-diff.js";
import { LEFT_UNCOMMITTED_LIST_LIMIT } from "../../tools/worktree-commit.js";
import {
	allowedWorktreeParents,
	diskWorktreeParent,
	prepareWorktreeParent,
	resolveWorktreeRoot,
} from "../../tools/worktree-root.js";
import {
	WORKER_REFUSAL_LIMIT_PREFIX,
	type WorkerBudget,
	type WorkerGrantBinding,
	type WorkerPromptMessage,
} from "../../worker/spec-contract.js";
import type { WorkerDecisionBinding } from "../../worker/stdin-demux.js";
import type { AgentsContract } from "../agents/contract.js";
import type { AgentRecipe } from "../agents/recipe.js";
import {
	INTERNAL_HELPER_RESULT_KINDS,
	validateRecipeResult,
	validateStructuredHelperResult,
} from "../agents/result-contract.js";
import {
	builderReportCompletion,
	mutationReportFailures,
	resultContractAuthorship,
} from "../agents/result-contract-builder-report.js";
import { nodeResultContractFilesystem } from "../agents/result-contract-filesystem.js";
import { isHoareResultContract } from "../agents/result-contract-types.js";
import {
	type AgentAudience,
	type AgentCapabilityClass,
	type AgentSpec,
	agentHasTrait,
	agentSpecFingerprint,
	isUserVisibleAgent,
	normalizeAgentSpec,
	SHADOW_AGENT_OPERATOR_STAND_IN,
	userOriginAudienceRefusal,
} from "../agents/spec.js";
import type { ConfigContract } from "../config/contract.js";
import { workerHandbookAudience } from "../context/handbook-units.js";
import {
	sisterRepositoryNotice,
	sisterRepositoryPendingNotice,
	sisterRepositoryRoot,
	sisterRepositoryRules,
} from "../context/sister-repository.js";
import type { MiddlewareContract } from "../middleware/contract.js";
import type { PromptsContract } from "../prompts/contract.js";
import type { EffectivePricing } from "../providers/catalog.js";
import { calculatePricingCostUsd } from "../providers/catalog.js";
import {
	type CapabilityFlags,
	canonicalEndpointKey,
	type EndpointCapacity,
	endpointCapacityFor,
	endpointCapacityForStatus,
	type ProvidersContract,
	type RuntimeDescriptor,
	resolveEndpointCapacities,
	runtimeTargetSnapshot,
	type TargetDescriptor,
	targetRequiresAuth,
} from "../providers/index.js";
import { createQuotaCache, DEFAULT_QUOTA_CACHE_TTL_MS, type QuotaCache } from "../quota/cache.js";
import { observedAnthropicQuota, observedCodexQuota, STREAM_QUOTA_TTL_MS } from "../quota/observed.js";
import { buildQuotaProviders, quotaProviderIdForRuntime } from "../quota/registry.js";
import { quotaSharedStatePath, readSharedQuotaState } from "../quota/shared-state.js";
import type { QuotaProvider, UsageSnapshot } from "../quota/types.js";
import { type ActionClass, classify as classifyAction } from "../safety/action-classifier.js";
import { type AutonomyLevel, containedYolo, effectiveYoloConfinement } from "../safety/autonomy.js";
import type { SafetyContract } from "../safety/contract.js";
import type { GitHookDriftGuard } from "../safety/hook-drift.js";
import type { FlowRestrictionSet } from "../safety/information-flow.js";
import { isFlowRestrictionSet, mergeFlowRestrictions } from "../safety/information-flow.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import { createRunEffectsRecorder } from "../safety/run-effects.js";
import type { SafetyJudgeSeat } from "../safety/safety-judge.js";
import type { WorkerMcpAttestation } from "../safety/worker-permit.js";
import {
	mainGrantsUnavailable,
	recordOnlyAcpPermit,
	type WorkerPermit,
	withoutExecuteAutonomy,
	workerPermissionModeForPermit,
} from "../safety/worker-permit.js";
import {
	type BudgetSpendPricing,
	combineBudgetPricing,
	SESSION_COST_CEILING_REASON,
	SessionCostCeilingError,
	sessionCeilingReached,
} from "../scheduling/budget.js";
import type { SchedulingContract } from "../scheduling/contract.js";
import { describeLocalCapacityRefusal, resolveGlobalConcurrency } from "../scheduling/local-capacity.js";
import { ceilChars } from "../session/context-accounting.js";
import { forkParentSessionId } from "../session/fork-journal.js";
import { telemetryBundlePath, telemetryJournalPath, telemetryRunDirectory } from "../telemetry/index.js";
import type { TelemetrySessionLease, TelemetrySessionOrigin } from "../telemetry/session-journals.js";
import { resolveAcpContinuation } from "./acp-continuation.js";
import { resolveAcpDelegationLifecycle } from "./acp-delegation-lifecycle.js";
import {
	approvedRouteObservation,
	consumeActiveRouteApproval,
	planActiveRoute,
	routeValidationProjection,
} from "./active-route-planner.js";
import {
	createCapacityAdmissionController,
	createLeaseSlotGuard,
	describeProviderQuotaDenial,
	PROVIDER_QUOTA_DENIED_REASON,
} from "./admission.js";
import { AdmissionCanceledError, AdmissionTimedOutError } from "./admission-error.js";
import {
	acpToolActionClass,
	assertStoreGrantAdmissible,
	type DispatchAdmissionStage,
	EXTERNAL_READ_APPROVAL_REQUIRED,
	externalReadShapeAdmissible,
	missingStoreTagRefusal,
	remoteStoreGrantRefusal,
	requestOriginFor,
	resolveDispatchAdmissionStage,
	sharedStoreGrantFor,
	storeGrantScopeRefusal,
	withStoreGrantBoundaries,
	workerHasNetworkPosture,
} from "./admission-scope.js";
import { agentRouteCandidates } from "./agent-candidates.js";
import type { LedgerAssignment } from "./agent-ledger.js";
import { projectLedgerAssignments } from "./agent-ledger.js";
import { publishAgentLedgerEntry, subscribeAgentLedger } from "./agent-ledger-hub.js";
import {
	type AgentLedgerAttribution,
	appendAgentLedgerEntry,
	appendAgentLedgerReport,
	MAX_AGENT_LEDGER_POSTS_PER_RUN,
	readAgentLedger,
} from "./agent-ledger-store.js";
import { materializeAgentPlanSelection } from "./agent-plan-adapter.js";
import { AssignmentRegistry, applyActiveRouteSelection, asAssignmentId } from "./assignment.js";
import type { AssignmentAttemptStartEvent } from "./assignment-events.js";
import { reconcileOrphanAssignments } from "./assignment-reconcile.js";
import {
	assignmentProcessOwnerAlive,
	cancelStoredAssignment,
	failQueuedAssignment,
	getStoredAssignment,
	listStoredAssignments,
	recordAssignmentAttempt,
	registerAssignment,
	renameStoredAssignment,
	settleStoredAssignment,
	subscribeStoredAssignments,
	timeoutStoredAssignment,
} from "./assignment-store.js";
import {
	getDetachedBatch,
	listDetachedBatches,
	markDetachedBatchCollected,
	markDetachedBatchOwnerTold,
	registerDetachedBatch,
} from "./batch-store.js";
import type { WorktreeBootRecovery } from "./boot-recovery.js";
import { type RunToolBudgetEnvelope, resolveToolBudgetEnvelope, workerBudgetFromEnvelope } from "./budget-envelope.js";
import { cancelDetail, FLEET_CANCEL_DETAIL, takeRunCancelRequest } from "./cancel-requests.js";
import { assessCapabilityMismatch, type CapabilityMismatch } from "./capability-match.js";
import {
	capacityLeaseUsage,
	capacityLeaseUsageAsync,
	createNodeLeaseUsageReader,
	mainCacheLaneStore,
} from "./capacity-lease.js";
import type {
	AbortReason,
	BudgetEconomicsView,
	BudgetPoolView,
	DispatchAdmissionObserver,
	DispatchContract,
	DispatchDerivedGrants,
	DispatchLandOutcome,
	DispatchPlanTaskResolution,
	DispatchPrefixGroup,
	DispatchPreparationOptions,
	DispatchRequest,
	DispatchSnapshot,
	WorkerGrantView,
} from "./contract.js";
import { sealCouncilSynthesis } from "./council-synthesis.js";
import { createCrossProcessFleet, type ForeignAnswerOrigin } from "./cross-process-fleet.js";
import { dispatchBatch } from "./dispatch-batch.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { budgetPoolView } from "./economics-view.js";
import {
	envelopeForPermit,
	placedInWorktree,
	type WorkerEnvelope,
	withheldLines,
	withStaticHead,
	writeModeLine,
} from "./envelope.js";
import {
	type EffectiveSettings,
	envelopeStaticHeadInput,
	judgeRoutedPermit,
	lifecycleMergeRoots,
	operatorAdmissionAutonomy,
	resolveDispatchEnvelopeStage,
	writeModeInput,
} from "./envelope-stage.js";
import {
	createWorkerOutputCapture,
	durableAssistantTextFromEvent,
	startDispatchEventPump,
	workerOutputCaptureBytes,
} from "./event-pump.js";
import {
	agentRoleFactsResolver,
	agentRunRoles,
	dispatchResultContract,
	requestRunRole,
	routeCorrelationFactsForRun,
	withAttemptRole,
	withRunRole,
} from "./execution-role.js";
import {
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
	type FailureClass,
	failureClassWords,
	honestWorkerSpecSkewText,
	isContextOverflowFailure,
	isInfrastructureFailure,
	nodeComponentRemedy,
	nodeComponentRemedyEvent,
	type RetryDecision,
} from "./failure-classification.js";
import { TOOL_GUARD_REASON_CODE } from "./failure-headline.js";
import {
	cleanupFleetChangeReturn,
	type FleetChangeImport,
	type FleetChangeReturn,
	importFleetChanges,
	prepareFleetChangeReturn,
} from "./fleet-change-return.js";
import { type FleetNodeSandbox, routeFactVerdict } from "./fleet-preflight.js";
import { assertFleetProjectAuthority, verifyFleetProject } from "./fleet-project-verification.js";
import { gateVerdictFactsOf } from "./gate-decisions.js";
import { type GradeContract, type GradeFacts, type GradeVerdict, grade, type RunVerdict } from "./grading.js";
import { createGrantBroker, type GrantRecord, type GrantState } from "./grant-broker.js";
import { decideGrantAsMain, decideJudgedGrant } from "./grant-decision.js";
import { sealedAnswerBudgetBytes, wallHandbackOutcomeDetail } from "./handback.js";
import {
	classifyHeartbeat,
	DEFAULT_HEARTBEAT_SPEC,
	type HeartbeatSpec,
	type HeartbeatStamp,
	type HeartbeatStatus,
	heartbeatMonotonicAt,
} from "./heartbeat.js";
import {
	type BatchVerificationGate,
	compareHostVerificationBase,
	hostVerificationRejection,
	hostVerificationSandbox,
	runHostVerification,
} from "./host-verification.js";
import { architectPlanOutsideWriteRoots } from "./intent-compatibility.js";
import { adaptJointRouteInput } from "./joint-route-adapter.js";
import {
	configuredJointNodes,
	configuredJointTargets,
	type JointRouteResolverInput,
	resolveJointRoute,
} from "./joint-route-resolver.js";
import {
	askLandCard,
	askMergeCard,
	createMergeCardQueue,
	type MergeCardInput,
	type MergeCardOutcome,
	mergeCardCauseNote,
} from "./merge-card.js";
import {
	compromisedCause,
	landCardClause,
	mergeGateVerdict,
	mergeWithheldDetail,
	partialResultDetail,
	preservesPartialResult,
	removedTestCases,
	taskRequestsTestRemoval,
	taskWorktreeCommitMessage,
} from "./merge-gate.js";
import {
	OBLIGATION_RETRY_LIMIT,
	type Obligation,
	type RunRole,
	requestedWriteNone,
	resolveObligation,
} from "./obligation.js";
import { recoverAbandonedRuns } from "./orphan-recovery.js";
import {
	type ResolvedTerminalReason,
	type RunTerminationEvidence,
	resolveRunOutcome,
	resolveRunTerminalReason,
	resultContractWasDue,
	runStatusForOutcome,
} from "./outcome.js";
import { dispatchOwnership, sessionAncestorIds } from "./ownership.js";
import {
	type DispatchPathScope,
	declaredScopeReplacementDiagnostic,
	inferredScopeParentTokenNotice,
	resolveDispatchPathScope,
	runLedgerProjection,
} from "./path-scope.js";
import { type PeerInstructions, peerInstructionsStaleMessage, resolvePeerInstructions } from "./peer-instructions.js";
import { deriveEnvelopePhaseDurations, recordRunTimingBestEffort } from "./phase-timing.js";
import {
	createFleetPlacementPreviewResolver,
	createFleetPlacementResolver,
	type FleetPlacementPreview,
} from "./placement.js";
import {
	claimSharedPrefix,
	claimWorkerCacheLane,
	startAfterPrefixHold,
	waitForPrefixLeader,
} from "./prefix-stagger.js";
import { freshQuotaDenial } from "./quota-denial.js";
import { createRecordingJournal } from "./recording.js";
import * as recovery from "./recovery-candidates.js";
import { collectReproducibilityMetadata } from "./reproducibility.js";
import {
	createDispatchReservation,
	getDispatchReservation,
	planQueueSlot,
	type ReservationCapacitySnapshot,
	rebindDispatchReservationMember,
	releaseDispatchReservation,
	releaseDispatchReservationMemberAsync,
	reservedPlanPeakSlots,
	rollbackDispatchReservation,
	rollbackUnconsumedDispatchReservation,
	sweepDispatchReservationsAtStartup,
} from "./reservation-store.js";
import {
	eligibleAlternateRoute,
	planObligationRetry,
	planOverflowRetry,
	routeAroundCoolingTarget,
} from "./retry-route-plan.js";
import { assertApprovedRecoveryCapability } from "./route-approval.js";
import { ROUTE_CANDIDATE_LIMIT, routeBoundaryRejections } from "./route-candidates.js";
import {
	fixedRouteDecision,
	type RouteDecisionV1,
	type RouteIdentityInput,
	type RouteRoleInput,
	routeCandidateKey,
	toRouteCandidate,
} from "./route-decision.js";
import { createRouteObserver, type RouteObservationHandle, type RouteObserver } from "./route-observer.js";
import { candidateForecastLines, type RouteCandidateForecast } from "./route-policy.js";
import { reduceRouteQuality, routeQualityRun } from "./route-quality.js";
import { defaultRoutingIntent } from "./routing-intent.js";
import type { RunCallUsage } from "./run-call-usage.js";
import { createRunCallUsage, unobservedRunUsageFacts } from "./run-call-usage.js";
import { defaultRunEventJournal } from "./run-event-journal.js";
import { attachRunEventJournalBridge, type RunEventJournalBridge } from "./run-event-journal-bridge.js";
import {
	createRunResultQuality,
	deriveRunVerification,
	typedValidationFactsFromObservedEffects,
	typedValidationFactsFromVerifyCalls,
	unclassifiedAfterLastCheck,
	verificationWithHostVerdict,
} from "./run-findings.js";
import {
	assessDispatchFinishContract,
	emitTerminalDispatchEvent,
	type FinalizingRun,
	publishedLineage,
	sealTaskWorktreeReceipt,
	snapshotUnappliedTaskWorktree,
} from "./run-finish.js";
import { detectRunIdentity } from "./run-identity.js";
import { planCardLimits, resolveRunWall, runWallCapMs } from "./run-limits.js";
import {
	compactDiagnosticText,
	hasDurableFinalOutput,
	idleBuilderOutcome,
	MAX_ACP_FAILURE_DETAIL_BYTES,
	MAX_WORKER_OUTCOME_DETAIL_BYTES,
	malformedWorkerStdoutLineCount,
	mergeRouteWarningDetail,
	mergeWorkerDiagnosticDetail,
	mergeWorkerDiagnosticFailure,
	resolveTrustedOutcomeCodes,
} from "./run-outcome-detail.js";
import {
	protectedArtifactReceiptSummary,
	receiptEnvelopeSummary,
	receiptGrantAudit,
	receiptPermitSummary,
} from "./run-receipt-summary.js";
import { receiptAssurance, settleRunResult, settleUnfinishedRun } from "./run-settlement.js";
import type { RunTelemetryJournal } from "./run-telemetry.js";
import {
	fleetRootTelemetryContext,
	openRunTelemetry,
	runTelemetryJournal,
	sealSettledRunJournal,
	settleOrphanedRunJournal,
} from "./run-telemetry.js";
import {
	assertDenyToolsEnforceable,
	assertFlowHandoffMediated,
	assertMainGrantRoutable,
	assertPlannedNodeIdentity,
	assertPostRuntimeToolCompatibility,
	assertProtectedArtifactsEnforceable,
	assertResponseSchemaEnforceable,
	assertRuntimeCanHonorWorkerPermissionMode,
	assertWriteRootsEnforceable,
	runtimeLimitations,
} from "./runtime-enforceability.js";
import { type Ledger, newRunId, openLedger } from "./state.js";
import { createTargetBreaker, type TargetBreakerBlock } from "./target-breaker.js";
import {
	capabilityInfoForModel,
	enforceCapabilityGate,
	type ResolvedTarget,
	readWorkerTargets,
	resolveDispatchTarget,
	targetToolCapability,
} from "./target-resolution.js";
import {
	blockedStateChangingCalls,
	blockedWriteAttempts,
	countToolCalls,
	executedCalls,
	hasPotentiallyMutatingAttempt,
	type InFlightCall,
	observationCalls,
	recordCallFinish,
	recordCallStart,
	recordToolCompletion,
	recordToolFinish,
	recordToolStart,
	resultNotExecuted,
	snapshotToolStats,
	snapshotUnfinishedTools,
	summarizeToolActivity,
	type ToolFinishPayload,
	zeroSuccessfulToolNote,
} from "./tool-stats.js";
import {
	type DispatchRequestOrigin,
	isRunOutcomeCode,
	RETRYABLE_OUTCOMES,
	type RunBriefingProvenance,
	type RunEnvelope,
	type RunKind,
	type RunLineage,
	type RunNodeIdentity,
	type RunNodeReroute,
	type RunOutcome,
	type RunOutcomeCode,
	type RunPersonaOverride,
	type RunPhaseMarks,
	type RunPipelineProvenance,
	type RunProjectContextProvenance,
	type RunResult,
	type RunResultContractFact,
	type RunResultDraft,
	type RunResultOutput,
	type RunResultUpstreamResponse,
	type RunStatus,
	type RunSteeringProvenance,
	type RunValidationGrounding,
	runKindSupportsLiveSteering,
	type SafetyBlockedAttempt,
	type ToolCallStat,
} from "./types.js";
import { type DispatchFailoverCandidate, type DispatchFailoverMode, validateJobSpec } from "./validation.js";
import {
	describeUngroundedValidations,
	groundClaimedValidations,
	groundGateCheck,
	invalidatesQuality,
	readOnlyObservationNote,
	type ValidationGroundingInput,
} from "./validation-grounding.js";
import {
	HOST_VERIFICATION_EVENT,
	type VerificationSlotEvents,
	type VerificationSlotState,
} from "./verification-slot.js";
import { createWorkerApprovalWindows, workerApprovalCeilingMs } from "./worker-approval-window.js";
import {
	assertWorkerContextRequest,
	briefingProvenanceFor,
	buildDynamicPromptMessages,
	canonicalContextAttached,
	harnessLabel,
	hasCallerPersonaOverride,
	keepsPeerInstructionFiles,
	pancodeOnlyNames,
	personaOverrideFor,
	pipelineProvenanceFor,
	projectContextProvenanceFor,
	promptCompositionHash,
	promptHash,
	readWorkspaceRootFacts,
	sharedPrefixSignature,
	sisterProjectPrompt,
	WORKER_HANDBOOK_MAX_CHARS,
	type WorkerDynamicContext,
	workerPersonaBody,
	workerProjectPrompt,
} from "./worker-dynamic-prompt.js";
import {
	appendDispatchFinishContractEntry,
	countCheckingCalls,
	foldAssistantCall,
	foldModelCallEvent,
	foldToolDecision,
	meterKnownUsd,
	meterSpend,
	meterSums,
	type RunTokenMeter,
	readStringArrayOrNull,
	readStringOrNull,
	recordWorkerRunEffect,
	recordWorkerVerifyCall,
	type VerifyCallLog,
} from "./worker-event-fold.js";
import { type WorkerMcpNetworkWithheld, workerMcpRuntimeRefusal } from "./worker-mcp.js";
import { adoptWorkerModelLoad } from "./worker-model-loads.js";
import { prepareWorkerModelListing, prepareWorkerModelMetadata } from "./worker-model-metadata.js";
import {
	type AgentLedgerBody,
	computeSettingsFingerprint,
	endpointIdentityHash,
	toolSignatureOf,
	type WorkerExtensionHook,
	type WorkerGrantRequestFrame,
	type WorkerHookEffect,
	type WorkerHookRequest,
	type WorkerHookResultFrame,
	type WorkerHookRun,
	type WorkerModelLoad,
} from "./worker-protocol.js";
import {
	type SpawnedWorker,
	type SpawnedWorkerResult,
	spawnNativeWorker,
	WORKER_PROCESS_CLEANUP_BOUND_MS,
	type SpawnOptions as WorkerSpawnOptions,
	type WorkerSpec,
} from "./worker-spawn.js";
import {
	buildDispatchWorkerSpec,
	frozenProtectedArtifactState,
	hookExtensionIds,
	hooksMatchingTools,
	isBlockingHook,
	protectedArtifactStateForRequest,
	resolveEffectiveWorkerBudget,
	unhookedWorkerHooks,
	workerSandboxFor,
	workerSandboxPromptLine,
	workerToolCallHardCap,
} from "./worker-spec.js";
import type { WriteBoundaryAttribution, WriteBoundaryAttributionDowngrade } from "./write-boundary.js";
import {
	createWriteRootPark,
	recordedLimitationsFromEntries,
	resolveWriteRootRequest,
	type WriteRootContinuation,
	writeRootRequestDetail,
	writeRootRequestFromEntries,
} from "./write-root-requests.js";
import { canonicalWriteRoots, joinWriterSet, type WriterSetLease } from "./writer-set.js";

/** How long after a long-lived surface asks for it route history warming begins. */
const ROUTE_HISTORY_WARM_DELAY_MS = 1_500;
/** Candidate forecasts a plan card shows per task, the route that runs included. */
const PREVIEW_FORECAST_LIMIT = 6;
/** Candidate forecasts `context(scope="budget")` shows across every dispatchable agent. */
const SESSION_FORECAST_LIMIT = 12;
/** The longest a budget read waits on a usage poll for a pool with no fresh reading; the poll itself runs on. */
const ROUTE_QUOTA_POLL_WAIT_MS = 3_000;

/** Whether the operator runs contained yolo, which never waits for a person. */
function operatorContainedYolo(settings: Readonly<ReturnType<ConfigContract["get"]>> | undefined | null): boolean {
	return containedYolo(settings?.safety.autonomy ?? "default", effectiveYoloConfinement(settings?.safety));
}

export interface ActiveRun {
	runId: string;
	detached?: boolean;
	/** Original request, kept verbatim so a retry re-passes the full admission chain. */
	req: DispatchRequest;
	abort: () => void;
	/** Hard termination used by the reconciler; for native workers this is the SIGTERM→SIGKILL path. */
	kill: () => void;
	/**
	 * Send operator guidance to a live-input HTTP/SDK worker, or to an ACP peer
	 * that takes it as another prompt (agy). Returns false when the channel is
	 * gone. Absent for single-shot subprocess runs and other ACP peers.
	 */
	steer?: (text: string) => boolean;
	/**
	 * Apply a permission decision to a parked escalation by writing a
	 * `permission_decision` line to the worker's stdin. A live grant carries
	 * its binding (Phase D). Returns false when the channel is gone. Absent for
	 * run kinds without one (ACP).
	 */
	resolvePermission?: (
		requestId: string,
		decision: "approve" | "deny",
		binding?: WorkerDecisionBinding,
		cause?: "timeout",
	) => boolean;
	/** Renew a held ask past the worker's backstop. False unless the worker announced the hold frame and took the line. */
	holdPermission?: (requestId: string, holdMs: number) => boolean;
	promise: Promise<void>;
	recipe: AgentRecipe | null;
	/** The permit this attempt ran under; a retry inherits it as a cap. Absent for ACP delegation. */
	permit?: WorkerPermit;
	startedAt: string;
	timing: RunPhaseMarks;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	agentId: string;
	task: string;
	budget?: RunToolBudgetEnvelope;
	cwd: string;
	/** Fleet node this run was placed on; null when no placement resolved it. */
	node: RunNodeIdentity | null;
	aborted: boolean;
	/** Non-operator abort cause (e.g. a dispatch timeout); null for operator cancels. */
	abortDetail: string | null;
	/** Typed cause behind `abortDetail`; null for an operator cancel (#425). */
	abortCause: AbortReason["cause"] | null;
	/** Set by the reconciler before terminating a dead/stalled worker. */
	stallKilled: boolean;
	/**
	 * The worker is done and its receipt is being written. The terminal row
	 * patch waits for the receipt file (#428), so the heartbeat cannot use
	 * `endedAt` to tell this run from a live one and must skip it.
	 */
	sealing?: boolean;
	/** ACP event-inactivity window; null for native runs (heartbeat spec governs those). */
	stallTimeoutMs: number | null;
	/** An ACP peer's question is parked on the operator, so its silence is not a stall. */
	peerQuestionOpen?: () => boolean;
	/** Internal logical assignment/retry lineage, independent of published host ancestry. */
	lineage: RunLineage;
	hostRun?: DispatchPreparationOptions["hostRun"];
	heartbeatAt: HeartbeatStamp | null;
	heartbeatStatus: HeartbeatStatus;
	/** Set while the finalizer waits on the operator's merge card; the worker is gone, the orchestrator is the live party. */
	awaitingOperator?: boolean;
	/** Budget admission exempted the route (unpriced or zero-rate), so the session cost-ceiling stop leaves it running. */
	budgetExempt?: boolean;
	/** Set when every command the worker spawns runs in its OS sandbox or is refused (`workerRunShellConfined`). */
	shellConfined?: true;
	meter: RunTokenMeter;
	finalPromise: Promise<RunResult>;
}

interface PendingCapacityAdmission {
	identity: DispatchRunIdentity & { requestOrigin: DispatchRequestOrigin };
	timing: RunPhaseMarks;
	node: RunNodeIdentity | null;
}

/** One resolved fleet placement: where the worker runs and how to launch it there. */
export interface DispatchNodePlacement {
	node: RunNodeIdentity;
	/** Transport launch; absent for local placements, which use the bundle's spawnWorker. */
	spawn?: (spec: WorkerSpec, opts?: WorkerSpawnOptions) => SpawnedWorker;
	/** Failover hops that preceded this placement, oldest first. */
	reroutes?: ReadonlyArray<RunNodeReroute>;
	/** An SSH node's recorded OS sandbox, null when it has none; absent for local placement. */
	sandbox?: FleetNodeSandbox | null;
}

export interface DispatchBundleOptions {
	getCapabilityGate?: () => CapabilityGate;
	spawnWorker?: (spec: WorkerSpec, opts?: WorkerSpawnOptions) => SpawnedWorker;
	/** Resolve the attested node and transport before capacity admission; absent means local. */
	resolveNode?: (req: DispatchRequest) => DispatchNodePlacement | null;
	/** Side-effect-free companion to resolveNode, primarily for alternate fleet backends and deterministic tests. */
	previewNode?: (req: DispatchRequest) => FleetPlacementPreview;
	startAcpDelegationRun?: (input: AcpDelegationRunInput) => AcpDelegationRunHandle;
	heartbeatSpec?: HeartbeatSpec;
	heartbeatIntervalMs?: number;
	resilienceCooldownMs?: number;
	now?: () => number;
	/** Monotonic clock for heartbeat age and ACP event-inactivity spans. */
	monotonicNow?: () => number;
	/** Immutable per-attempt session settings view; falls back to the shared snapshot. */
	getSettings?: () => EffectiveSettings;
	/**
	 * PanCode session this process dispatches for, read when a request enters
	 * `dispatch()` and stamped on its run rows and receipts. Absent (the fleet
	 * CLI, tests) means the process has no session and its rows belong to their
	 * project instead.
	 */
	getSessionId?: () => string | null;
	/**
	 * The live session's `parentSessionId`, set when it was forked. The rest of
	 * the chain is read from each ancestor's meta.json, so a fork inherits the
	 * uncollected batches and the runs of every session it descends from.
	 */
	getSessionParentId?: () => string | null;
	getSessionOrigin?: () => TelemetrySessionOrigin | null;
	/** Interactive sessions park paid routes until their session ceiling is raised. */
	budgetWaitForRaise?: boolean;
	/**
	 * The session's api 2 extension tool hooks, which a native worker cannot
	 * run itself. Each dispatched spec carries the declarations; each call
	 * they match comes back here and is answered with the hook's effects.
	 * Absent (the fleet CLI, a session with no extension host) means workers
	 * run unhooked, as before.
	 */
	workerHooks?: {
		declarations(): ReadonlyArray<WorkerExtensionHook>;
		/** Tool hooks past `WORKER_EXTENSION_HOOKS_MAX` that no worker spec carries. */
		dropped?(): ReadonlyArray<WorkerExtensionHook>;
		/** Never rejects: a hook that cannot run answers with its own failure policy. */
		evaluate(request: WorkerHookRequest, run: WorkerHookRun): Promise<ReadonlyArray<WorkerHookEffect>>;
		/** One operator line, where the session reports its extensions' issues. */
		notify?(message: string): void;
	};
	/**
	 * True only when this process shows worker permission escalations to an
	 * operator and answers them through resolveWorkerPermission (the interactive
	 * TUI). Absent or false makes an escalating worker apply its configured
	 * fallback at once instead of waiting out the timeout (F9).
	 */
	workerPermissionResponder?: boolean;
	/**
	 * The main session's safety judge and live autonomy, present only in the
	 * orchestrator. Under fleet.permissions.mode=judge it answers a native local
	 * worker's main-authority asks in this process; without it judge runs as deny.
	 */
	/**
	 * The operator's live autonomy level, an ACP session's mode included. Worker
	 * permits, ask routing and the never-wait rule of contained yolo read it;
	 * absent or undefined, they read default: it is the ceiling on every worker
	 * this process dispatches, and `safety.autonomy` in settings is not a grant.
	 */
	operatorAutonomy?(): AutonomyLevel | undefined;
	workerAskJudge?: {
		seat(): SafetyJudgeSeat | undefined;
		autonomy(): AutonomyLevel;
		/** The main session's git hook drift guard; a worker git call after drift goes to the operator. */
		hookDrift?(): Pick<GitHookDriftGuard, "check" | "accept"> | undefined;
	};
	/**
	 * False when nothing can steer a dispatched worker: a headless session, the
	 * fleet CLI, or `run --agent` without a steer channel. The worker prompt then
	 * leaves out the steering guidance it could never use. Absent means steerable.
	 */
	workerSteering?: boolean;
	/**
	 * The attached operator's ask surface: the interactive TUI, or an ACP client
	 * that advertised interviews. A merge-mode task worktree the gate would
	 * withhold is put to the operator as a merge card when `available()` is true.
	 * Absent in headless runs and in an ACP session without that capability, and
	 * those keep withholding.
	 */
	operatorAsk?: { available(): boolean; ask: AskUserHandler };
	/** Live hard-block state cloned into each mediated worker spec. */
	getProtectedArtifactState?: () => ProtectedArtifactState;
	/**
	 * The parent session's information-flow restrictions at dispatch time, or
	 * null. A worker inherits them with its context so its own model requests
	 * are judged against them; the worker's result returns under the same label.
	 */
	getFlowRestrictions?: () => FlowRestrictionSet | null;
	getFlowPolicy?: () => WorkerFlowPolicyInput;
	/** Git-backed receipt provenance collector; injectable for deterministic tests. */
	collectReproducibility?: typeof collectReproducibilityMetadata;
	/** Observer injection seam. Production constructs the durable observer. */
	routeObserver?: RouteObserver;
	/** Quota adapter injection seam for the budget view's pool. Production builds the registry's adapters. */
	quotaProviders?: () => ReadonlyArray<QuotaProvider>;
	/**
	 * Write the durable run event journal for every run this bundle dispatches.
	 * Off by default and turned on by the three composition roots
	 * (src/entry/orchestrator.ts, src/cli/run.ts, src/cli/fleet.ts), because the
	 * process that owns a bundle also decides who owns the journal file: a
	 * composed process routes `registerAllTools`' event registry to
	 * `journal: null` so a tool-path run is transcribed once, not twice.
	 */
	journalRunEvents?: boolean;
	/**
	 * Restart worktree recovery that boot starts after the first frame. The
	 * ledger scan and every admission wait for it; admission starts it if boot
	 * has not yet. Absent, start() scans the ledger itself before it returns.
	 */
	bootRecovery?: WorktreeBootRecovery;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_RESILIENCE_COOLDOWN_MS = 15_000;
/** The grant broker expires this long before the worker's own escalation timer. */
const GRANT_DEADLINE_MARGIN_MS = 1_000;

/** A half-open route this dispatch was admitted to probe, keyed by its run id. */
interface ProbeClaim {
	key: string;
	owner: string;
}
/** ACP event-inactivity stall window (Symphony §5.3.6 semantics); <= 0 disables. */
const DEFAULT_ACP_STALL_TIMEOUT_MS = 300_000;
/** How often a delegated agent's question retries a screen another card holds; the merge card waits the same. */
const PEER_QUESTION_SCREEN_RETRY_MS = 500;
const ADMISSION_INPUT_TOKEN_ESTIMATE = 4096;
const ACP_TOOL_SIGNATURE = "acp:unobservable";
const ACP_SPEC_FINGERPRINT = "acp:unobservable";
/**
 * An ACP delegation's route tuple names the agent id as its model, a stand-in for
 * the peer's own default. A plan pin or an exact-mode retry stamps that tuple back
 * onto the request, so a model equal to the agent id is dropped here and never asks
 * the peer for a model it does not offer; only the caller's own model survives.
 */
function withoutDelegationStandInModel(req: DispatchRequest, agentId: string): DispatchRequest {
	if (req.model !== agentId) return req;
	const { model: _standIn, ...rest } = req;
	return rest;
}
/**
 * Where the worker process ran when no fleet placement chose a node. This is the
 * worker's own host, never the host serving the model: a run against a remote
 * target from this machine is still a local node. Emitted on every run so a
 * receipt has one node shape, rather than carrying the block only on the paths
 * that happened to have a placement object.
 */
const LOCAL_RUN_NODE: RunNodeIdentity = { id: "local", kind: "local" };

/** v21 receipt fields; call ids are omitted, never empty, when no call telemetry reached the host (#434). */
function runSettlementReceiptFields(
	terminal: ResolvedTerminalReason,
	usage: RunCallUsage | undefined,
): Pick<RunResultDraft, "terminalReason" | "callIds" | "spend" | "spendSums"> {
	// The receipt's spend is the call fold at settlement, the same facts run.settled records (#434).
	return {
		terminalReason: terminal.terminalReason,
		...(usage ? { callIds: [...usage.callIds] } : {}),
		spend: usage?.facts ?? unobservedRunUsageFacts(),
		spendSums: usage?.sums ?? spendSumsOf(unobservedRunUsageFacts()),
	};
}

function sealRouteDecision(draft: RunResultDraft, decision: RouteDecisionV1): RunResultDraft {
	return { ...draft, routeDecision: decision };
}
export const UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD = 1;

/**
 * Output-token figure the admission estimate prices a route against: the
 * route's own output bound (routeOutputBound), so an unset chat.maxOutputTokens
 * prices the model's cap and not one token (M6).
 */
function admissionMaxOutputTokens(settings: EffectiveSettings, capabilities: CapabilityFlags | null): number {
	return routeOutputBound(
		{ contextWindow: capabilities?.contextWindow ?? 0, maxTokens: capabilities?.maxTokens ?? 0 },
		settings?.chat.maxOutputTokens ?? DEFAULT_SETTINGS.chat.maxOutputTokens,
	);
}

/** Unpriced and zero-rate routes pass the session cost ceiling at admission, and the ceiling stop spares them. */
function budgetExemptRoute(pricing: EffectivePricing): boolean {
	return pricing.rates === null || Object.values(pricing.rates).every((rate) => rate === 0);
}

function conservativeRouteAdmissionEstimateUsd(
	pricing: EffectivePricing,
	maxOutputTokens: number,
	req: DispatchRequest,
	prompt?: Pick<DispatchLifecycleStage, "systemPrompt" | "dynamicPromptMessages">,
): number {
	if (pricing.pricedBy === "free") return 0;
	if (pricing.rates === null) return UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD;
	const messages = prompt?.dynamicPromptMessages ?? buildDynamicPromptMessages(req);
	const inputTokens = Math.max(
		ADMISSION_INPUT_TOKEN_ESTIMATE,
		ceilChars(
			req.task.length +
				(prompt?.systemPrompt ?? req.systemPrompt ?? "").length +
				messages.reduce((length, message) => length + message.body.length, 0),
		) + (req.contextSeed?.provenance.mode === "fork" ? req.contextSeed.provenance.estimatedTokens : 0),
	);
	return calculatePricingCostUsd(pricing.rates, { input: inputTokens, output: Math.max(1, maxOutputTokens) });
}

function rootOriginFields(req: DispatchRequest): { rootRequestOrigin?: DispatchRequestOrigin } {
	return req.rootRequestOrigin !== undefined ? { rootRequestOrigin: req.rootRequestOrigin } : {};
}

/** The move a start event names: only one that actually left the route it came from. */
function routeMoveFields(
	req: DispatchRequest,
	targetId: string,
	wireModelId: string,
): { routeMove?: NonNullable<DispatchRequest["routeMove"]> } {
	const move = req.routeMove;
	if (move === undefined || (move.fromTargetId === targetId && move.fromModelId === wireModelId)) return {};
	return { routeMove: move };
}

/**
 * Grace window finalization grants the domain event pump after the worker
 * ends. Token meters, tool stats, finish-contract text, and output capture
 * fold inside the pump, so the receipt waits for it to drain the source
 * stream; the bound exists so a source channel that misbehaves after process
 * exit cannot stall finalization forever.
 */
const DISPATCH_DRAIN_GRACE_MS = 2000;

/**
 * How many finalized runs keep their observed write targets in memory. The
 * write boundary reads a run's record while closing the window it ran in, which
 * is the same wave, so a few hundred runs of headroom is far more than the
 * lookup ever reaches back for.
 */
const RUN_WRITE_TARGET_HISTORY = 512;

async function awaitEventDrain(drained: Promise<void>, graceMs = DISPATCH_DRAIN_GRACE_MS): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<false>((resolve) => {
		// The timer must hold the event loop: it bounds the drain wait, and
		// the finally below clears it.
		timer = setTimeout(() => resolve(false), graceMs);
	});
	try {
		return await Promise.race([drained.then(() => true), grace]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Best-effort diagnostic for failures dispatch deliberately survives. These
 * were previously silent; a swallowed ledger or finalization failure must at
 * least leave a stderr trace for triage. Never throws.
 */
/**
 * Every alternate route a retry tried refused it at admission. The retry never
 * ran, which is a failed recovery, not a policy decision, so it settles in
 * these words rather than as a denial.
 */
class RetryRoutesRefusedError extends Error {}

/** The next route a refused retry moves to, given the routes refused so far, or null when none is left. */
type NextRetryRoute = (
	refused: ReadonlyArray<{ target: string; model: string }>,
) => { target: string; model: string; agentId?: string; node?: string } | null;

/** One refused alternate in words: a down target says so, anything else keeps admission's reason. */
function routeRefusalWords(targetId: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const reason = message
		.replace(/^dispatch: /u, "")
		.replace(/^admission denied: /u, "")
		.replace(/^target '[^']*' unavailable: /u, "");
	return /^health down\b/u.test(reason) ? `${targetId} is down` : `${targetId} could not take it (${reason})`;
}

type PeerPromptComposition = Pick<
	DispatchLifecycleStage,
	"dynamicPromptMessages" | "projectContext" | "compiledPromptHash" | "promptSignature" | "dynamicHash"
>;

interface DispatchLifecycleStage {
	recipe: AgentRecipe | null;
	/** The run's role, resolved once; its handback share, its obligation and its worker spec all read it (M3). */
	runRole: RunRole;
	/** Bytes of the answer the parent sees, fixed at dispatch and told to the worker (M3). */
	answerBudgetBytes: number;
	pathScope: DispatchPathScope;
	admission: DispatchAdmissionStage;
	target: ResolvedTarget;
	cwd: string;
	systemPrompt: string;
	dynamicPromptMessages: ReadonlyArray<WorkerPromptMessage>;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	sessionShellHash: string | null;
	dynamicHash: string | null;
	promptSignature: string | null;
	toolSignature: string;
	apiKey: string | undefined;
	authProfile?: string;
	credentialExpiresAt?: number;
	runtimeKind: RunKind;
	agentAudience: AgentAudience;
	capabilityClass: AgentCapabilityClass;
	requestOrigin: DispatchRequestOrigin;
	runtimeLimitations: string[];
	pipeline: RunPipelineProvenance | null;
	briefing: RunBriefingProvenance | null;
	personaOverride: RunPersonaOverride | null;
	/** Decision refs sealed on the request by the dispatch tool; null when the parent board was empty. */
	decisionRefs: ReadonlyArray<string> | null;
	projectContext: RunProjectContextProvenance;
	/** The run's capability envelope, resolved once; everything after admission reads it (M7). */
	envelope: WorkerEnvelope;
	/** The OS sandbox availability resolved for the worker's placement. */
	placedSandbox: SandboxAvailability;
	/** What to write over a delegated harness's instruction files in the run's task worktree; absent without an overlay. */
	peerOverlay?: ReadonlyArray<{ file: string; content: string }>;
	/** The run's prompt with the rules in the message instead, for when the overlay cannot be written at spawn. */
	peerCoexist?: PeerPromptComposition;
	/** What the operator hears when the harness ends up reading its own files and some of their rules no longer hold. */
	peerStale?: { files: string[]; stale: number; message: string };
	/** Rule ids the worker prompt compiler selected into this run's system prompt; [] when none matched. */
	rulesApplied: string[];
	/** Whether the operator profile rendered non-empty content into this run's system prompt. */
	operatorProfileApplied: boolean;
	/** Read-only recipe admitted against a mutating task; null when the pairing was sound. */
	capabilityMismatch: CapabilityMismatch | null;
	readOnly: boolean;
	/** The immutable permit this attempt was admitted under. */
	permit: WorkerPermit;
	budget: WorkerBudget;
	budgetEnvelope: RunToolBudgetEnvelope;
	settings?: Readonly<ReturnType<ConfigContract["get"]>>;
}

export function createDispatchBundle(
	context: DomainContext,
	options?: DispatchBundleOptions,
): DomainBundle<DispatchContract> {
	const maybeSafety = context.getContract("safety");
	const maybeAgents = context.getContract("agents");
	const maybeProviders = context.getContract("providers");
	const maybeMiddleware = context.getContract("middleware");
	const maybeScheduling = context.getContract("scheduling");
	const maybePrompts = context.getContract("prompts");
	if (!maybeSafety) throw new Error("dispatch domain requires 'safety' contract");
	if (!maybeAgents) throw new Error("dispatch domain requires 'agents' contract");
	if (!maybeProviders) throw new Error("dispatch domain requires 'providers' contract");
	if (!maybeMiddleware) throw new Error("dispatch domain requires 'middleware' contract");
	if (!maybeScheduling) throw new Error("dispatch domain requires 'scheduling' contract");
	if (!maybePrompts) throw new Error("dispatch domain requires 'prompts' contract");
	const safety: SafetyContract = maybeSafety;
	const agents: AgentsContract = maybeAgents;
	const providers: ProvidersContract = maybeProviders;
	const middleware: MiddlewareContract = maybeMiddleware;
	const scheduling: SchedulingContract = maybeScheduling;
	const prompts: PromptsContract = maybePrompts;
	// Main sessions claim their cache lanes in the admission store beside the workers' leases (M-11).
	useMainCacheLaneStore(mainCacheLaneStore);
	const config = context.getContract("config");
	const getEffectiveSettings = (): EffectiveSettings => options?.getSettings?.() ?? config?.get();
	/** The judge-withheld notice is a process fact, so it is raised once, not on every dispatch. */
	let judgeWithheldAnnounced = false;
	// The settings with the operator's live level in place of the configured one,
	// for the autonomy reads alone: an ACP session's mode can differ from settings.
	// The live level is the dispatch ceiling. A dispatcher with no live source (a
	// headless fleet, bootstrap or wiki run) was never granted yolo, so it reads
	// default; settings.yaml alone never lifts a worker above its dispatcher.
	const withLiveAutonomy = <S extends EffectiveSettings | undefined | null>(settings: S): S => {
		const live = options?.operatorAutonomy?.() ?? "default";
		if (!settings || live === settings.safety.autonomy) return settings;
		return { ...settings, safety: { ...settings.safety, autonomy: live } } as S;
	};

	const getProtectedArtifactState = (): ProtectedArtifactState =>
		frozenProtectedArtifactState(options?.getProtectedArtifactState?.());
	// Optional: absent in minimal test bundles. Workers just get no project
	// message when the context domain is not loaded.
	const projectContext = context.getContract("context");
	const spawnWorker = options?.spawnWorker ?? spawnNativeWorker;
	// Each unhooked-runtime notice once per process, however many workers it covers.
	const unhookedNotices = new Set<string>();
	const staleNotices = new Set<string>();
	const fleetRegistry = scheduling.fleet;
	const resolveNode =
		options?.resolveNode ??
		createFleetPlacementResolver({
			getSettings: getEffectiveSettings,
			getSessionId: options?.getSessionId,
			fleet: fleetRegistry,
		});
	const previewNode =
		options?.previewNode ??
		createFleetPlacementPreviewResolver({
			getSettings: getEffectiveSettings,
			getSessionId: options?.getSessionId,
			fleet: fleetRegistry,
		});
	const startAcpRun = options?.startAcpDelegationRun ?? startAcpDelegationRun;
	const collectReproducibility = options?.collectReproducibility ?? collectReproducibilityMetadata;
	const heartbeatSpec = options?.heartbeatSpec ?? DEFAULT_HEARTBEAT_SPEC;
	const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	const getResilienceCooldownMs = (): number => {
		if (options?.resilienceCooldownMs !== undefined) return options.resilienceCooldownMs;
		const settingsVal = getEffectiveSettings()?.fleet?.retry.routeCooldownMs;
		if (settingsVal !== undefined && settingsVal >= 0) return settingsVal;
		return DEFAULT_RESILIENCE_COOLDOWN_MS;
	};
	const now = options?.now ?? (() => Date.now());
	const monotonicNow = options?.monotonicNow ?? (() => performance.now());
	const targetBreaker = createTargetBreaker({
		monotonicNow,
		cooldownMs: getResilienceCooldownMs,
		threshold: () => getEffectiveSettings()?.fleet?.retry.breakerThreshold ?? 1,
	});
	// Durable evidence owner used by shadow observation and active readiness.
	const routeObserver: RouteObserver = options?.routeObserver ?? createRouteObserver({});
	let ledger: Ledger | null = null;
	// The ledger scan and assignment reconcile, after restart worktree recovery (start()).
	let startupRecovery: Promise<void> = Promise.resolve();
	let startupRecovered = false;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	const active = new Map<string, ActiveRun>();
	// Phase D: the trusted broker for worker asks routed to the main agent. It
	// is process-local, like the workers it answers.
	// Contained yolo never waits for the operator, so its worker asks and
	// operator rails are answered as unattended even where a person could be.
	const grantAttended = (): boolean =>
		options?.workerPermissionResponder === true && !operatorContainedYolo(withLiveAutonomy(getEffectiveSettings()));
	// One merge card is on screen at a time. A batch can withhold several
	// members, each waits its turn here while the members that merge cleanly
	// have already landed.
	const mergeCardQueue = createMergeCardQueue();
	const askWithheldMerge = async (run: ActiveRun, input: MergeCardInput): Promise<MergeCardOutcome | null> => {
		const operator = options?.operatorAsk;
		if (operator === undefined || !operator.available()) return null;
		// Contained yolo never waits on a card: the merge stays withheld, its branch preserved, as headless.
		if (operatorContainedYolo(withLiveAutonomy(getEffectiveSettings()))) return null;
		// A run canceled before its turn never shows a card; the watch below polls
		// once a second and would let one flash up first.
		if (run.aborted) return null;
		// The worker has exited and nothing runs on its lease, but the assignment
		// holds a global, node, and endpoint slot until the receipt settles, and an
		// attended card has no deadline. Release it so a lone dispatch is not
		// queued behind a slot nothing uses. Not when a sibling is queued or still
		// active: releasing is what would admit it into this checkout while the
		// operator's Merge lands (the writer lease refuses only an overlapping
		// writer from another dispatch call, never one beside a worktree run, so it
		// would not stop it), and a batch's members share one checkout. They keep
		// today's order, with the slot held until the card settles. The later settle
		// releases by the same assignment id and finds nothing left when released.
		const siblingsShareCheckout =
			pendingCapacity.size > 0 || [...active.values()].some((other) => other.runId !== run.runId);
		if (!siblingsShareCheckout) capacityAdmission.releaseAssignment(run.lineage.rootRunId);
		const canceled = new AbortController();
		const watch = setInterval(() => {
			if (run.aborted) canceled.abort();
		}, 1000);
		watch.unref?.();
		// The worker has exited, so its heartbeat and pid say nothing about this run.
		// Mark the run as waiting on the operator and let the orchestrator vouch for
		// it: the watchdog stops classifying it stale or dead, and a second PanCode on
		// this state directory sees a live pid instead of an abandoned row.
		const workerPid = ledger?.get(run.runId)?.pid ?? null;
		run.awaitingOperator = true;
		const vouch = (): void => {
			ledger?.update(run.runId, {
				status: "running",
				pid: process.pid,
				heartbeatAt: new Date(now()).toISOString(),
				outcomeDetail: "awaiting operator: merge card",
			});
		};
		vouch();
		try {
			return await mergeCardQueue(async () => {
				// A card queued behind others can outlive its run.
				if (run.aborted) return null;
				// An attended operator decides in their own time, like a permission
				// prompt: a card that settled itself after two minutes vanished with
				// no word on screen. Esc and a run cancel still settle on Keep branch.
				return askMergeCard({ ask: operator.ask, signal: canceled.signal }, input);
			});
		} catch (error) {
			// A card that cannot be shown leaves the merge withheld, the same as no operator.
			reportDispatchDiagnostic(`merge card for ${run.runId}`, error);
			return null;
		} finally {
			clearInterval(watch);
			run.awaitingOperator = false;
			ledger?.update(run.runId, { pid: workerPid, outcomeDetail: null });
		}
	};
	// `dispatch land`: the agent asks, the operator answers a Land card, and the
	// host lands the branch with fleet land's checks, so a sandboxed agent never
	// needs a sandbox escape to land a branch the operator approves.
	const landKeptTask = async (input: {
		ref: string;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<DispatchLandOutcome> => {
		const refused = (why: string): DispatchLandOutcome => ({
			outcome: "refused",
			detail: `${why}; nothing landed, and the operator can land it with \`pancode fleet land ${input.ref}\``,
		});
		const operator = options?.operatorAsk;
		if (operator === undefined || !operator.available()) return refused("no operator is attached to answer a Land card");
		if (operatorContainedYolo(withLiveAutonomy(getEffectiveSettings())))
			return refused("contained yolo never waits on a Land card");
		const protectedNow = (): string[] => getProtectedArtifactState().artifacts.map((artifact) => artifact.path);
		const planNow = (): TaskLandPlan =>
			planTaskLand({
				root: input.cwd,
				ref: input.ref,
				mode: "merge",
				allowedParents: allowedWorktreeParents(getEffectiveSettings()?.fleet?.worktrees?.root ?? "disk", input.cwd),
			});
		let plan: TaskLandPlan;
		try {
			plan = planNow();
			const refusal = hostLandRefusal(plan, protectedNow());
			if (refusal !== null) return { ...refused(`cannot land: ${refusal}`), branch: plan.branch };
		} catch (error) {
			return refused(error instanceof Error ? error.message : String(error));
		}
		const shown = landCardPin(plan);
		let card: MergeCardOutcome;
		try {
			card = await mergeCardQueue(() =>
				askLandCard(
					{ ask: operator.ask, ...(input.signal !== undefined ? { signal: input.signal } : {}) },
					{
						branch: plan.branch,
						destination: plan.destination,
						commits: plan.commits,
						changed: plan.changed,
						uncommitted: plan.uncommitted,
					},
				),
			);
		} catch (error) {
			reportDispatchDiagnostic(`land card for ${plan.runId}`, error);
			return { ...refused("the Land card could not be shown"), branch: plan.branch };
		}
		if (card.choice !== "land")
			return {
				outcome: "kept",
				branch: plan.branch,
				detail: `the operator kept ${plan.branch} (${mergeCardCauseNote(card.cause)}); nothing landed`,
			};
		try {
			// The card waits as long as the operator takes, so the branch, its worktree, the destination and
			// protection are all read again here, and Land holds only for what the card showed.
			const landing = planNow();
			const moved = landCardPinDrift(landing, shown);
			if (moved !== null) return { ...refused(`the operator chose Land, but ${moved}`), branch: plan.branch };
			const refusal = hostLandRefusal(landing, protectedNow());
			if (refusal !== null) return { ...refused(`the operator chose Land, but ${refusal}`), branch: plan.branch };
			const result = executeTaskLand(landing);
			return {
				outcome: "landed",
				branch: landing.branch,
				detail: `${result.landed !== null ? `landed ${result.landed.slice(0, 9)} on ${landing.destination}` : `nothing new to land on ${landing.destination}`} on the operator's Land; ${result.detail}`,
			};
		} catch (error) {
			return {
				...refused(`the operator chose Land, but ${error instanceof Error ? error.message : String(error)}`),
				branch: plan.branch,
			};
		}
	};
	const grantRunFallbacks = new Map<string, "deny" | "fail">();
	const grantPendingListeners = new Set<(view: WorkerGrantView) => void>();
	const grantView = (record: GrantRecord): WorkerGrantView => ({
		requestId: record.requestId,
		runId: record.runId,
		rootRunId: record.rootRunId,
		attempt: record.attempt,
		agentId: record.agentId,
		tool: record.tool,
		actionClass: record.actionClass,
		approvalAuthority: record.approvalAuthority,
		state: record.state,
		execution: record.execution,
		...(record.issuer !== undefined ? { issuer: record.issuer } : {}),
		summary: record.summary,
		...(record.target !== undefined ? { target: record.target } : {}),
		reasons: [...record.reasons],
		createdAt: new Date(record.createdAt).toISOString(),
		// A window this process runs ends the request well before its record's ceiling.
		deadlineAt: new Date(
			record.state === "pending"
				? now() + (workerApprovalWindows.read(record.requestId)?.remainingMs ?? record.deadlineAt - now())
				: record.deadlineAt,
		).toISOString(),
		...(record.reason !== undefined ? { reason: record.reason } : {}),
		...(record.forwardedByMain === true ? { forwardedByMain: true as const } : {}),
		...(record.reviewer !== undefined ? { reviewer: record.reviewer } : {}),
	});
	/**
	 * Answers another PanCode process gave through a run's grant records, by request id, until their resolution is
	 * published: the resolution then names that process instead of reading like this process's own card.
	 */
	const answeredElsewhere = new Map<string, ForeignAnswerOrigin>();
	const answeredElsewhereReason = (decision: "approve" | "deny", origin: ForeignAnswerOrigin): string =>
		`${decision === "approve" ? "approved" : "denied"} by the operator in another PanCode process (pid ${origin.pid}${origin.host !== null ? ` on ${origin.host}` : ""})`;
	const publishGrantChange = (record: GrantRecord, previous: GrantState | null): void => {
		const origin = `worker:${record.runId}`;
		const fallback = grantRunFallbacks.get(record.runId) ?? "deny";
		if (record.state !== "pending") workerApprovalWindows.settle(record.requestId);
		const requested = (escalation: boolean): void => {
			emitApproval(context.bus, "approval.requested", {
				tool: record.tool,
				actionClass: record.actionClass,
				...(record.ownerSessionId !== null ? { sessionId: record.ownerSessionId } : {}),
				requestedBy: record.runId,
				requestId: record.requestId,
				origin,
				agentId: record.agentId,
				summary: record.summary,
				...(record.target !== undefined ? { target: record.target } : {}),
				...(record.consequence !== undefined ? { consequence: [...record.consequence] } : {}),
				reasons: [...record.reasons],
				timeoutMs: workerApprovalWindows.read(record.requestId)?.remainingMs ?? Math.max(0, record.deadlineAt - now()),
				fallback,
				escalation,
				// Why a forwarded request reached the operator, such as changed git hooks, leads its reasons.
				...(record.forwardedByMain === true && record.reason !== undefined
					? { reasons: [record.reason, ...record.reasons] }
					: {}),
				approvalAuthority: record.approvalAuthority,
				...(record.forwardedByMain === true ? { forwardedByMain: true } : {}),
				...(record.reviewer !== undefined ? { reviewer: record.reviewer } : {}),
			});
		};
		if (previous === null) {
			// Opened before the card is told, so its first frame already reads this window.
			if (record.windowMs !== undefined) {
				workerApprovalWindows.open({
					runId: record.runId,
					agentId: record.agentId,
					requestId: record.requestId,
					windowMs: record.windowMs,
					fallback,
					decider:
						record.approvalAuthority === "operator" ? "operator" : record.reviewer === "safety-judge" ? "judge" : "main",
					deny: () => {
						grantBroker.expire(record.requestId);
						return true;
					},
					extend: (holdMs) => active.get(record.runId)?.holdPermission?.(record.workerRequestId, holdMs) ?? false,
				});
			}
			// An operator rail goes straight to the operator's card when this
			// process has one; an ordinary ask waits for the main agent, whose
			// dispatch call yields on it.
			requested(record.approvalAuthority === "operator" && grantAttended());
			// The safety judge decides a judge-routed ask, so the main agent is not woken for it.
			if (record.approvalAuthority === "main" && record.reviewer === undefined) {
				const view = grantView(record);
				for (const listener of grantPendingListeners) {
					try {
						listener(view);
					} catch {
						// A listener failure never changes the record; the model still reaches it through monitor.
					}
				}
			}
			return;
		}
		if (previous === "pending" && record.state === "pending") {
			// The main agent approved below yolo: the operator decides, with the
			// main agent's request as provenance.
			if (record.forwardedByMain === true && record.approvalAuthority === "main") {
				// The time so far went to the judge or the main agent, so the person gets the whole window.
				workerApprovalWindows.handToOperator(record.requestId);
				requested(true);
			}
			return;
		}
		if (record.state === previous || record.state === "executing") return;
		const status =
			record.state === "denied" || record.state === "canceled"
				? "denied"
				: record.state === "expired"
					? "expired"
					: record.issuer !== undefined
						? "granted"
						: "denied";
		const decidedBy =
			record.state === "expired"
				? "timeout"
				: record.state === "canceled"
					? "revoked"
					: record.issuer !== undefined
						? record.issuer === "operator" && answeredElsewhere.has(record.requestId)
							? "operator:another-process"
							: record.forwardedByMain === true && record.issuer === "operator"
								? "operator:forwarded-by-main"
								: record.reviewer === "safety-judge" && record.issuer === "main"
									? "safety-judge"
									: record.issuer
						: "worker";
		answeredElsewhere.delete(record.requestId);
		emitApproval(context.bus, "approval.resolved", {
			status,
			tool: record.tool,
			requestId: record.requestId,
			...(record.ownerSessionId !== null ? { sessionId: record.ownerSessionId } : {}),
			origin,
			decidedBy,
			actionClass: record.actionClass,
			...(record.reason !== undefined ? { reason: record.reason } : {}),
			requestedBy: record.runId,
			...(record.state === "expired" ? { fallback } : {}),
			grant: {
				attempt: record.attempt,
				authority: record.approvalAuthority,
				...(record.issuer !== undefined ? { issuer: record.issuer } : {}),
				execution: record.execution,
				state: record.state,
			},
		});
	};
	const grantBroker = createGrantBroker({
		now,
		deliver: (record, decision, reason, cause) => {
			const parked = writeRootPark.deliver(record, decision, reason);
			if (parked !== null) return parked;
			const run = active.get(record.runId);
			if (run?.resolvePermission === undefined) return false;
			return run.resolvePermission(
				record.workerRequestId,
				decision,
				{
					attemptToken: record.attemptToken,
					attempt: record.attempt,
					argDigest: record.argDigest,
					issuer: record.issuer ?? "operator",
					runId: record.runId,
					grantId: record.requestId,
					reason: reason.slice(0, 300),
				},
				cause,
			);
		},
		onChange: (record, previous) => publishGrantChange(record, previous),
	});
	// Cross-process fleet state (M11): run-directory records for this process's runs and asks, and, where a person can
	// answer, the live runs and held asks of other PanCode processes on this state directory.
	const crossProcessFleet = createCrossProcessFleet({
		bus: context.bus,
		isLocalRun: (runId) => active.has(runId) || currentAssignmentRun(runId) !== null,
		grantBinding: (requestId) => {
			const record = grantBroker.get(requestId);
			return record === null ? null : { attempt: record.attempt, argDigest: record.argDigest };
		},
		resolve: (runId, requestId, decision, answeredBy) => {
			answeredElsewhere.set(requestId, answeredBy);
			try {
				contract.resolveWorkerPermission?.(runId, requestId, decision);
			} catch (error) {
				answeredElsewhere.delete(requestId);
				throw error;
			}
		},
		follow: options?.workerPermissionResponder === true,
	});
	/** Asks a fork adopted from the parked session that held them, by request id; a brokered ask's record holds its own. */
	const adoptedAsks = new Map<string, { runId: string; sessionId: string }>();
	/**
	 * The session an ask belongs to when that is not the current one, which alone may answer it, else null. An ask
	 * whose holder is an ancestor of the current session is orphaned: one process runs one session, so the holder is
	 * parked and the ask lives only here. The fork adopts it the way it inherits a collect (bt-11), and from then on
	 * the parent no longer holds it. Steering and cancelling the run stay with the session that dispatched it.
	 */
	function foreignAskOwner(runId: string, requestId: string): string | null {
		const brokered = grantBroker.get(requestId);
		const ownerSessionId =
			brokered?.ownerSessionId ??
			adoptedAsks.get(requestId)?.sessionId ??
			currentAssignmentRun(runId)?.req.ownerSessionId ??
			null;
		const current = contract.owner?.();
		if (ownerSessionId === null || current === undefined || ownerSessionId === current.sessionId) return null;
		if (current.sessionId === null || !dispatchOwnership(current).inherits({ sessionId: ownerSessionId })) {
			return ownerSessionId;
		}
		if (brokered === null) adoptedAsks.set(requestId, { runId, sessionId: current.sessionId });
		else if (grantBroker.adopt(requestId, current.sessionId) === null) return ownerSessionId;
		return null;
	}
	const dropAdoptedAsks = (runId: string): void => {
		for (const [requestId, adopted] of adoptedAsks) if (adopted.runId === runId) adoptedAsks.delete(requestId);
	};
	const heldAskRefusal = (holder: string, runId: string): string =>
		`the ask is held by session ${holder} (run '${runId}'); only that session can answer it. /resume ${holder} to answer it`;
	/** Sessions a fork parked, whose brokered asks wait for the fork's open to adopt or revoke them. */
	const forkParkedSessionIds: Array<string | null> = [];
	/** The current session adopts every brokered ask an ancestor left pending, so its main agent and card see them. */
	const adoptOrphanedGrants = (): void => {
		for (const record of grantBroker.list({ state: "pending" })) foreignAskOwner(record.runId, record.requestId);
	};
	const workerApprovalWindows = createWorkerApprovalWindows({
		now: monotonicNow,
		onChange: ({ runId, agentId, requestId }, view) => {
			const owner = foreignAskOwner(runId, requestId);
			context.bus.emit("run.progressed", {
				runId,
				agentId,
				event: {
					type: "pancode_permission_window",
					payload: {
						requestId,
						held: view.held,
						expiresAt: now() + view.remainingMs,
						fallback: view.fallback,
						decider: view.decider,
						...(owner !== null ? { owner } : {}),
					},
				},
			});
		},
	});
	const grantUnsubscribes: Array<() => void> = [];
	const pendingCapacity = new Map<string, PendingCapacityAdmission>();
	const ownedReservations = new Set<string>();
	/**
	 * Attribution from each finalized run's successful tool calls, newest last.
	 * An incomplete record retains its paths as a lower bound beside the reasons
	 * it cannot be read as a closed list.
	 *
	 * Held in memory rather than sealed into the receipt: the only reader is the
	 * write boundary closing a window seconds later in this process, and a
	 * per-run path list is run-shaped evidence the receipt schema does not carry.
	 * Bounded because a long session finalizes many runs and none of this is
	 * needed once its window has closed.
	 */
	const runWriteAttributions = new Map<string, WriteBoundaryAttribution>();
	const recordRunWriteAttribution = (runId: string, attribution: WriteBoundaryAttribution): void => {
		runWriteAttributions.set(runId, attribution);
		while (runWriteAttributions.size > RUN_WRITE_TARGET_HISTORY) {
			const oldest = runWriteAttributions.keys().next();
			if (oldest.done === true) break;
			runWriteAttributions.delete(oldest.value);
		}
	};
	const capacityAdmission = createCapacityAdmissionController({
		limits: () => {
			const settings = getEffectiveSettings();
			const nodes: Record<string, number> = { local: configuredLocalCapacity(settings) };
			for (const node of settings?.fleet?.nodes ?? []) nodes[node.id] = node.maxWorkers;
			return { global: configuredGlobalCapacity(settings), nodes, endpoints: configuredEndpointLimits() };
		},
		now,
		reservedPlanPeak: (planId) =>
			reservedPlanPeakSlots(planId, (error) => reportDispatchDiagnostic("read reserved plan peak", error)),
		onRenewalError: (error) => reportDispatchDiagnostic("renew capacity leases", error),
		onReleaseError: (leaseId, error) =>
			reportDispatchDiagnostic(`release capacity lease ${leaseId}; retrying at the next heartbeat`, error),
		onLeaseLost: (lease, detail) => {
			reportDispatchDiagnostic("capacity lease lost", new Error(detail));
			stopLostCapacityOwners(lease.assignmentId, detail);
			// A member whose only remaining work was a retry in backoff settles no
			// assignment when that retry is canceled, so with no run left under the
			// lease nothing would ever release it and local admission would stay
			// refused. The store already lacks it; this clears the local record.
			if (![...active.values()].some((run) => run.lineage.rootRunId === lease.assignmentId))
				capacityAdmission.release(lease.leaseId);
		},
	});
	scheduling.fleet?.bindActiveWorkers(
		createNodeLeaseUsageReader({
			now,
			onError: (error) => reportDispatchDiagnostic("read capacity lease usage", error),
		}),
	);

	/**
	 * Every endpoint the configured fleet can reach.
	 *
	 * Deliberately resolved from the configured targets as well as the probed
	 * statuses. A target whose status has not been built yet contributed no key,
	 * an absent key carries no limit, and reservation planning skips a dimension
	 * it has no limit for, so admission against a single-slot server used to fail
	 * open for whoever asked first after boot.
	 */
	function configuredEndpointCapacities(): Readonly<Record<string, EndpointCapacity>> {
		return resolveEndpointCapacities({
			statuses: providers.list(),
			targets: getEffectiveSettings()?.targets ?? [],
			runtimeFor: (runtimeId) => providers.getRuntime(runtimeId),
		});
	}

	function configuredEndpointLimits(): Readonly<Record<string, number>> {
		return Object.fromEntries(Object.entries(configuredEndpointCapacities()).map(([key, value]) => [key, value.limit]));
	}

	/**
	 * Endpoints still bound by the blind one-slot default have never been
	 * probed by any process, or their record expired. A fresh home carried that
	 * bound into its first batch and refused two tasks on a server running
	 * four, until the operator happened to run `targets --probe`. Probe each
	 * such endpoint once per process, in the background and without the
	 * inference-based reasoning check: the slot count is a header read, and the
	 * model's first dispatch call is seconds away at the earliest. The probe
	 * lands in the provider statuses and the durable slot store, which is where
	 * admission already looks.
	 */
	const probedDefaultBoundEndpoints = new Set<string>();
	function probeEndpointsAtDefaultBound(): void {
		const capacities = configuredEndpointCapacities();
		for (const target of getEffectiveSettings()?.targets ?? []) {
			const key = canonicalEndpointKey(target);
			if (key === null || capacities[key]?.source !== "local-native-default") continue;
			if (probedDefaultBoundEndpoints.has(key)) continue;
			probedDefaultBoundEndpoints.add(key);
			void providers.probeTarget(target.id, { reasoning: false }).catch(() => undefined);
		}
	}

	function endpointCapacityForTarget(targetId: string): EndpointCapacity | null {
		const status = providers.list().find((entry) => entry.target.id === targetId);
		const target = status?.target ?? providers.getTarget(targetId);
		if (target === null || target === undefined) return null;
		const endpoint =
			status === undefined
				? endpointCapacityFor({ target, runtime: providers.getRuntime(target.runtime) })
				: endpointCapacityForStatus(status);
		if (endpoint === null) return null;
		return configuredEndpointCapacities()[endpoint.key] ?? endpoint;
	}

	/** Initial plan preparation has a synchronous host contract. */
	function reservationCapacitySnapshotSync(settings: EffectiveSettings): ReservationCapacitySnapshot {
		return reservationCapacitySnapshot(settings, capacityLeaseUsage());
	}

	function reservationCapacitySnapshot(
		settings: EffectiveSettings,
		usage: ReturnType<typeof capacityLeaseUsage>,
	): ReservationCapacitySnapshot {
		// Read budget after the capacity lock wait too; concurrent callbacks may spend.
		const preflight = scheduling.preflight();
		const localCapacity = scheduling.localCapacity?.();
		const localNote = localCapacity === undefined ? null : describeLocalCapacityRefusal(localCapacity);
		const nodes: Record<string, { active: number; limit: number; note?: string }> = {
			local: {
				active: usage.nodes.local ?? 0,
				limit: localCapacity?.limit ?? configuredGlobalCapacity(settings),
				...(localNote === null ? {} : { note: localNote }),
			},
		};
		for (const node of settings?.fleet?.nodes ?? [])
			nodes[node.id] = { active: usage.nodes[node.id] ?? 0, limit: node.maxWorkers };
		const endpoints = Object.fromEntries(
			Object.entries(configuredEndpointLimits()).map(([key, limit]) => [
				key,
				{
					active: usage.endpoints[key] ?? 0,
					limit,
					leases: usage.endpointHolders[key]?.leases ?? 0,
					foregroundStreams: usage.endpointHolders[key]?.foregroundStreams ?? 0,
				},
			]),
		);
		return {
			global: { active: usage.global, limit: configuredGlobalCapacity(settings) },
			nodes,
			endpoints,
			budget: { currentUsd: preflight.currentUsd, ceilingUsd: preflight.ceilingUsd },
		};
	}

	function prepareReservation(input: Parameters<NonNullable<DispatchContract["reservations"]>["prepare"]>[0]) {
		const record = createDispatchReservation({
			topology: input.topology,
			tasks: input.tasks.map((task) => ({
				memberId: task.memberId,
				wave: task.wave,
				nodeId: task.resolution.node.id,
				...(task.resolution.endpoint !== undefined ? { endpointKey: task.resolution.endpoint.key } : {}),
				costUpperBoundUsd: task.resolution.routeApproval?.totalCostUpperBoundUsd ?? task.resolution.costUpperBoundUsd,
			})),
			capacity: reservationCapacitySnapshotSync(getEffectiveSettings()),
			nowMs: now(),
		});
		ownedReservations.add(record.ownerId);
		return record;
	}

	/**
	 * Budget admission preflight denial. The dispatch dies before any worker or
	 * run row exists, so without this denied `tool.decided` record the journal
	 * would carry no trace that the admission gate refused the dispatch.
	 */
	function refuseForBudget(message: string): never {
		safety.decisions.recordToolCall?.({
			tool: "dispatch",
			classification: { actionClass: "dispatch" },
			decision: "denied",
			reasonCode: "budget-ceiling",
		});
		throw new Error(message);
	}

	/**
	 * R3: refuse a route whose quota pool the provider freshly and explicitly denied. Reads only the shared quota cache
	 * file, never the network, and only the reading made with the credential this route would spend now: the quota
	 * adapter reads the runtime's own login, so a target that names another credential is not bound by it, and an
	 * unknown identity on either side never binds. A route with no quota adapter, or with no fresh reading, admits
	 * unchanged.
	 */
	async function assertNoFreshQuotaDenial(
		target: TargetDescriptor,
		runtime: RuntimeDescriptor,
		route: string,
	): Promise<void> {
		const providerId = quotaProviderIdForRuntime(runtime.id);
		if (providerId === null) return;
		if (resolveAuthTarget(target, runtime).providerId !== resolveRuntimeAuthTarget(runtime).providerId) return;
		const nowMs = now();
		const shared = readSharedQuotaState(quotaSharedStatePath(), nowMs);
		const entry = shared.entries.get(providerId);
		if (entry === undefined || entry.storedAtMs <= (shared.cleared.get(providerId) ?? Number.NEGATIVE_INFINITY)) return;
		const denial = freshQuotaDenial(entry.snapshot, nowMs, DEFAULT_QUOTA_CACHE_TTL_MS);
		if (denial === null) return;
		const provider = buildQuotaProviders().find((candidate) => candidate.id === providerId);
		if (provider === undefined) return;
		const scope = provider.credentialScope === undefined ? null : await provider.credentialScope().catch(() => null);
		if (scope === null || entry.scope !== scope) return;
		safety.decisions.recordToolCall?.({
			tool: "dispatch",
			classification: { actionClass: "dispatch" },
			decision: "denied",
			reasonCode: PROVIDER_QUOTA_DENIED_REASON,
		});
		throw new Error(describeProviderQuotaDenial(denial, route));
	}

	function budgetDenialMessage(
		preflight: { currentUsd: number; ceilingUsd: number; pricing?: BudgetSpendPricing },
		routeEstimateUsd: number,
	): string {
		const estimateSuffix =
			routeEstimateUsd > 0 ? ` (includes ${renderUsdEstimate(routeEstimateUsd)} route estimate)` : "";
		return `dispatch: admission denied: budget ceiling crossed: ${renderUsdSpend(preflight.currentUsd, preflight.pricing)} / ${renderUsdLimit(preflight.ceilingUsd)}${estimateSuffix}`;
	}

	/** The route's conservative estimate against the request's own cost bound; named as an estimate (#434 §6.3). */
	function intentCeilingRefusal(req: DispatchRequest, estimateUsd: number): string | null {
		const ceilingUsd = req.routingIntent?.maxCostUsd;
		if (ceilingUsd === null || ceilingUsd === undefined || estimateUsd <= ceilingUsd) return null;
		return budgetDenialMessage(
			{ currentUsd: estimateUsd, ceilingUsd, pricing: { estimated: true, unpriced: false } },
			estimateUsd,
		);
	}

	/** The session ceiling against the spend the read model holds now, plus what running workers have metered. */
	function sessionCeilingRefusal(): SessionCostCeilingError | null {
		const preflight = scheduling.preflight();
		const currentUsd = preflight.currentUsd + inFlightSpendUsd();
		if (!sessionCeilingReached(currentUsd, preflight.ceilingUsd)) return null;
		return new SessionCostCeilingError(
			currentUsd,
			preflight.ceilingUsd,
			undefined,
			undefined,
			combineBudgetPricing(preflight.pricing, inFlightPricing()),
		);
	}

	/**
	 * Priced spend metered by workers still running, beyond what the session's read model already folds from their run
	 * journals. Without it a fan-out admitted every member against settled spend alone; counted whole, a call that
	 * settled into a running worker's journal would count twice, once spent and once projected (#434).
	 */
	function inFlightSpendUsd(): number {
		const telemetry = context.getContract("telemetry");
		let usd = 0;
		for (const [runId, run] of active)
			usd += Math.max(0, meterKnownUsd(run.meter) - (telemetry?.journaledRunUsd(runId) ?? 0));
		return usd;
	}

	/** How the running workers' meters priced their spend, so a stop that counts it marks it (#434 §6.3). */
	function inFlightPricing(): BudgetSpendPricing {
		const pricing = { estimated: false, unpriced: false };
		for (const run of active.values()) {
			const usd = run.meter.usage?.sums.usd;
			if (!usd) continue;
			if (usd.coverage.estimated > 0) pricing.estimated = true;
			if (usd.unknownCount > 0) pricing.unpriced = true;
		}
		return pricing;
	}

	/** The quota adapter that reads the credential a route spends now, or why none does. */
	function routeQuotaProvider(target: TargetDescriptor, runtime: RuntimeDescriptor): QuotaProvider | string {
		const providerId = quotaProviderIdForRuntime(runtime.id);
		if (providerId === null) return `runtime ${runtime.id} reports no quota`;
		if (resolveAuthTarget(target, runtime).providerId !== resolveRuntimeAuthTarget(runtime).providerId)
			return "the route spends a credential the quota reader does not read";
		return (
			(options?.quotaProviders ?? buildQuotaProviders)().find((candidate) => candidate.id === providerId) ??
			`no quota reader for ${providerId} here`
		);
	}

	/** The credential a quota adapter reads now: undefined when it names none, null when it cannot be read. */
	async function quotaCredentialScope(provider: QuotaProvider): Promise<string | null | undefined> {
		return provider.credentialScope === undefined ? undefined : await provider.credentialScope().catch(() => null);
	}

	/**
	 * The shared poll reading of a route's pool, made with the credential that route spends now. The quota adapter reads
	 * the runtime's own login, so a target naming another credential has no reading, and an unknown identity on either
	 * side matches nothing. Reads the shared cache file only, never the network.
	 */
	function sharedRouteQuota(
		provider: QuotaProvider,
		scope: string | null | undefined,
		nowMs: number,
	): BudgetPoolView | string {
		const shared = readSharedQuotaState(quotaSharedStatePath(), nowMs);
		const entry = shared.entries.get(provider.id);
		if (entry === undefined || entry.storedAtMs <= (shared.cleared.get(provider.id) ?? Number.NEGATIVE_INFINITY))
			return "no cached quota reading";
		if (scope === null || scope === undefined || entry.scope !== scope)
			return "no quota reading for the route's current credential";
		const view = budgetPoolView(entry.snapshot, nowMs, DEFAULT_QUOTA_CACHE_TTL_MS, "poll");
		return view.status === "reading" ? view : view.reason;
	}

	/**
	 * The newest quota this process's own requests on the route reported in band, under the credential the route spends
	 * now: a Codex stream event for the request's ChatGPT account, Anthropic headers for the OAuth profile (#423).
	 */
	function streamedRouteQuota(
		target: TargetDescriptor,
		runtime: RuntimeDescriptor,
		nowMs: number,
	): { snapshot: UsageSnapshot; source: BudgetPoolView["source"] } | null {
		if (runtime.id !== "openai-codex" && runtime.id !== "anthropic-max") return null;
		const status = providers.auth.statusForTarget(target, runtime);
		if (runtime.id === "anthropic-max") {
			const profile = status.source === "stored-oauth" ? status.providerId : null;
			const snapshot = observedAnthropicQuota(target.id, nowMs, profile)?.snapshot;
			return snapshot ? { snapshot, source: "response-headers" } : null;
		}
		const stored = status.source === "stored-oauth" ? providers.auth.getStored(status.providerId) : null;
		const scope = stored?.type === "oauth" ? codexAccountScope(stored.access) : null;
		const snapshot = observedCodexQuota(target.id, scope, nowMs)?.snapshot;
		return snapshot ? { snapshot, source: "stream-event" } : null;
	}

	/** The running usage poll per quota adapter and credential, and when it began: its wait bound runs from there. */
	const routeQuotaPolls = new Map<string, { startedAtMs: number; answer: Promise<UsageSnapshot | null> }>();
	let routeQuotaCache: QuotaCache | null = null;
	const routeQuotaPollKey = (provider: QuotaProvider, scope: string | null | undefined): string =>
		JSON.stringify([provider.id, scope ?? null]);

	/**
	 * The usage poll for the credential a route spends now: the one already running for that credential, else one new
	 * read through the shared quota cache, which honours its holds and publishes the reading to every process. Keyed by
	 * credential, so a caller after a login change never joins the previous account's poll.
	 */
	function routeQuotaPoll(
		provider: QuotaProvider,
		scope: string | null | undefined,
	): { startedAtMs: number; answer: Promise<UsageSnapshot | null> } {
		const key = routeQuotaPollKey(provider, scope);
		const running = routeQuotaPolls.get(key);
		if (running !== undefined) return running;
		routeQuotaCache ??= createQuotaCache({
			ttlMs: DEFAULT_QUOTA_CACHE_TTL_MS,
			now,
			sharedStatePath: quotaSharedStatePath(),
		});
		const poll = { startedAtMs: now(), answer: routeQuotaCache.resolve(provider).catch(() => null) };
		routeQuotaPolls.set(key, poll);
		void poll.answer.then(() => {
			if (routeQuotaPolls.get(key) === poll) routeQuotaPolls.delete(key);
		});
		return poll;
	}

	/**
	 * The route's poll answer, waiting only out the rest of its ROUTE_QUOTA_POLL_WAIT_MS bound counted from the poll's
	 * own start, so a poll primed at run start costs a later read nothing and no read waits a second full bound. The
	 * answer counts only while the route still spends the credential the poll read for; the poll runs on past the bound.
	 */
	async function awaitRouteQuotaPoll(
		provider: QuotaProvider,
		scope: string | null | undefined,
	): Promise<UsageSnapshot | string> {
		const poll = routeQuotaPoll(provider, scope);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<"late">((resolve) => {
			timer = setTimeout(() => resolve("late"), Math.max(0, poll.startedAtMs + ROUTE_QUOTA_POLL_WAIT_MS - now()));
			timer.unref?.();
		});
		let answer: UsageSnapshot | null | "late";
		try {
			answer = await Promise.race([poll.answer, late]);
		} finally {
			clearTimeout(timer);
		}
		if (answer === "late") return `the quota poll did not answer within ${ROUTE_QUOTA_POLL_WAIT_MS / 1000}s`;
		if (answer === null) return "the quota poll failed";
		if ((await quotaCredentialScope(provider)) !== scope) return "the route's credential changed during the quota poll";
		return answer;
	}

	/** The chat route by the effective settings, or null when there is none. */
	function chatQuotaRoute(): { target: TargetDescriptor; runtime: RuntimeDescriptor } | null {
		const target = providers.getTarget(getEffectiveSettings()?.chat?.target ?? "");
		const runtime = target === null ? null : providers.getRuntime(target.runtime);
		return target === null || runtime === null ? null : { target, runtime };
	}

	/**
	 * S16: start the chat route's one bounded usage poll off the turn path when its shared reading is not fresh, so a
	 * headless run's first budget read finds the answer held or waits only out the rest of the bound. Never a model call.
	 */
	function primeRouteQuota(): void {
		const route = chatQuotaRoute();
		const provider = route === null ? "no chat route" : routeQuotaProvider(route.target, route.runtime);
		if (typeof provider === "string") return;
		void quotaCredentialScope(provider).then((scope) => {
			const shared = sharedRouteQuota(provider, scope, now());
			if (typeof shared === "string" || !shared.fresh) routeQuotaPoll(provider, scope);
		});
	}

	/**
	 * The chat route's pool as `context(scope="budget")` shows it: a fresh shared poll reading first, else this
	 * process's own fresh in-band reading (a headless run that just heard from the provider, a denial included), and
	 * only with neither the route's usage poll (the one primed at run start, else one started here) within the rest of
	 * its bound. With none fresh, the newest held reading marked not fresh. Age and freshness come from each reading's
	 * own as-of time, never from this read.
	 */
	async function routeQuotaPool(
		target: TargetDescriptor,
		runtime: RuntimeDescriptor,
	): Promise<BudgetPoolView | { status: "none"; reason: string }> {
		const provider = routeQuotaProvider(target, runtime);
		const held: BudgetPoolView[] = [];
		let reason = typeof provider === "string" ? provider : "no quota reading";
		const hold = (view: BudgetPoolView | string): BudgetPoolView | null => {
			if (typeof view === "string") reason = view;
			else if (view.fresh) return view;
			else held.push(view);
			return null;
		};
		const scope = typeof provider === "string" ? undefined : await quotaCredentialScope(provider);
		if (typeof provider !== "string") {
			const shared = hold(sharedRouteQuota(provider, scope, now()));
			if (shared !== null) return shared;
		}
		const streamed = streamedRouteQuota(target, runtime, now());
		if (streamed !== null) {
			const view = budgetPoolView(streamed.snapshot, now(), STREAM_QUOTA_TTL_MS, streamed.source);
			const fresh = hold(view.status === "reading" ? view : view.reason);
			if (fresh !== null) return fresh;
		}
		if (typeof provider !== "string") {
			const answer = await awaitRouteQuotaPoll(provider, scope);
			const view = typeof answer === "string" ? answer : budgetPoolView(answer, now(), DEFAULT_QUOTA_CACHE_TTL_MS, "poll");
			const polled = hold(typeof view === "string" || view.status === "reading" ? view : view.reason);
			if (polled !== null) return polled;
		}
		held.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
		return held[0] ?? { status: "none", reason };
	}

	/**
	 * S16: the session's economics view. Spend is what admission counts, settled journals plus workers still metering,
	 * read after every queued settlement is written, so the model call that asked is counted and priced as the usage
	 * report counts it; unobserved without a telemetry read model rather than a measured zero. The pool is the chat
	 * route's newest fresh quota reading (routeQuotaPool); forecasts are the plan card's lines for every dispatchable
	 * agent's routes, so a caller reads them before it dispatches, asked or not.
	 */
	async function budgetEconomics(): Promise<BudgetEconomicsView> {
		const preflight = scheduling.preflight();
		const telemetry = context.getContract("telemetry");
		const settled = telemetry === undefined ? undefined : await telemetry.settledSessionSpend();
		const pricing = combineBudgetPricing(
			settled === undefined ? preflight.pricing : { estimated: settled.estimated, unpriced: settled.unpriced },
			inFlightPricing(),
		);
		const usd = (settled?.usd ?? preflight.currentUsd) + inFlightSpendUsd();
		const ceilingUsd = preflight.ceilingUsd > 0 ? preflight.ceilingUsd : null;
		const settings = getEffectiveSettings();
		const route = chatQuotaRoute();
		const pool =
			route === null
				? { status: "none" as const, reason: "no chat route" }
				: await routeQuotaPool(route.target, route.runtime);
		const observed = telemetry !== undefined;
		return {
			scope: "session",
			spend: observed
				? {
						usd,
						basis:
							pricing === undefined
								? "unstated"
								: pricing.unpriced
									? "lower-bound"
									: pricing.estimated
										? "estimated"
										: "measured",
						ceilingUsd,
						headroomUsd: ceilingUsd === null ? null : Math.max(0, ceilingUsd - usd),
					}
				: { usd: null, basis: "unobserved", ceilingUsd, headroomUsd: null },
			pool,
			forecasts: sessionForecasts(settings),
		};
	}

	/**
	 * Every dispatchable agent's candidate forecasts as plan-card lines (R4): first the route each agent runs on now, then
	 * the alternatives its router weighs, deduplicated and bounded. Reads route history and settings only; an agent whose
	 * route cannot be previewed is skipped, as its dispatch would report.
	 */
	function sessionForecasts(settings: EffectiveSettings): string[] {
		const roleFacts = agentRoleFactsResolver((id) => agents.getSpec(id));
		const runs: RouteCandidateForecast[] = [];
		const alternatives: RouteCandidateForecast[] = [];
		for (const spec of agents.listSpecs()) {
			if (spec.audience === "internal") continue;
			// Routing reads the agent and intent, never the task text; dispatch requires a non-empty task.
			const req = withRunRole({ agentId: spec.id, task: "forecast preview" }, roleFacts);
			let forecasts: ReturnType<typeof previewForecasts>;
			try {
				forecasts = previewForecasts(req, previewFixed(req, settings), settings);
			} catch {
				continue;
			}
			for (const candidate of forecasts?.candidates ?? []) (candidate.executed ? runs : alternatives).push(candidate);
		}
		const seen = new Set<string>();
		const unique = [...runs, ...alternatives].filter((candidate) => {
			if (seen.has(candidate.route)) return false;
			seen.add(candidate.route);
			return true;
		});
		return candidateForecastLines({
			candidates: unique.slice(0, SESSION_FORECAST_LIMIT),
			omitted: Math.max(0, unique.length - SESSION_FORECAST_LIMIT),
		});
	}

	/**
	 * Admission alone lets running workers spend past the session cost ceiling
	 * (or a `pancode run --max-cost-usd` cap). Every metered worker call
	 * re-checks settled plus in-flight spend and stops each running worker once
	 * the ceiling is reached, so spend passes it only by the calls workers
	 * already had in flight. A ceiling of 0 is off.
	 */
	function stopRunsAtCostCeiling(): void {
		const cap = scheduling.runCostCap?.() ?? undefined;
		const ceilingUsd = getEffectiveSettings()?.safety.limits.sessionCostUsd ?? scheduling.ceilingUsd();
		if (!(ceilingUsd > 0)) return;
		const preflight = scheduling.preflight();
		const currentUsd = preflight.currentUsd + inFlightSpendUsd();
		if (!sessionCeilingReached(currentUsd, ceilingUsd)) return;
		const pricing = combineBudgetPricing(preflight.pricing, inFlightPricing());
		const detail = new SessionCostCeilingError(currentUsd, ceilingUsd, cap, undefined, pricing).message;
		for (const run of active.values()) {
			// A run on its merge card or already sealing has no worker left to stop.
			if (run.aborted || run.stallKilled || run.sealing === true || run.awaitingOperator === true) continue;
			if (run.budgetExempt === true) continue;
			contract.abort(run.runId, { cause: "budget", detail });
		}
	}

	async function assertBudgetAdmitsRoute(
		req: DispatchRequest,
		pricing: EffectivePricing,
		settings: EffectiveSettings,
		prompt: Pick<DispatchLifecycleStage, "systemPrompt" | "dynamicPromptMessages"> & {
			target?: Pick<ResolvedTarget, "modelCapabilities">;
		},
		signal?: AbortSignal,
	): Promise<void> {
		const estimateUsd = conservativeRouteAdmissionEstimateUsd(
			pricing,
			admissionMaxOutputTokens(settings, prompt.target?.modelCapabilities ?? null),
			req,
			prompt,
		);
		const intentRefusal = intentCeilingRefusal(req, estimateUsd);
		if (intentRefusal !== null) refuseForBudget(intentRefusal);
		if (budgetExemptRoute(pricing)) return;
		try {
			if (scheduling.admitPaidRequest) {
				await scheduling.admitPaidRequest({
					waitForRaise: options?.budgetWaitForRaise === true,
					additionalUsd: inFlightSpendUsd,
					additionalPricing: inFlightPricing(),
					getCeilingUsd: () => getEffectiveSettings()?.safety.limits.sessionCostUsd ?? scheduling.ceilingUsd(),
					...(signal ? { signal } : {}),
				});
			} else {
				const refusal = sessionCeilingRefusal();
				if (refusal !== null) throw refusal;
			}
		} catch (error) {
			if (error instanceof SessionCostCeilingError) {
				safety.decisions.recordToolCall?.({
					tool: "dispatch",
					classification: { actionClass: "dispatch" },
					decision: "denied",
					reasonCode: SESSION_COST_CEILING_REASON,
				});
			}
			throw error;
		}
	}

	function configuredGlobalCapacity(settings: EffectiveSettings): number {
		return scheduling.maxWorkers?.() ?? resolveGlobalConcurrency(settings?.fleet.concurrency);
	}

	/** The local node alone follows host facts under `auto`; global and SSH limits do not. */
	function configuredLocalCapacity(settings: EffectiveSettings): number {
		return scheduling.localCapacity?.().limit ?? configuredGlobalCapacity(settings);
	}

	function publishCapacityQueued(
		identity: DispatchRunIdentity & { requestOrigin: DispatchRequestOrigin },
		timing: RunPhaseMarks,
		node: RunNodeIdentity | null,
	): void {
		pendingCapacity.set(identity.runId, { identity, timing, node });
		context.bus.emit("run.enqueued", identity);
	}

	function publishCapacityAdmissionFailure(
		identity: DispatchRunIdentity & { requestOrigin: DispatchRequestOrigin },
		error: unknown,
	): void {
		const detail = error instanceof Error ? error.message : String(error);
		const outcome: RunOutcome =
			error instanceof AdmissionCanceledError
				? "canceled"
				: error instanceof AdmissionTimedOutError
					? "timed_out"
					: "denied_by_policy";
		context.bus.emit("run.failed", {
			...identity,
			outcome,
			outcomeDetail: detail,
			reason: outcome,
		});
	}

	async function admitAssignmentCapacity(
		req: DispatchRequest,
		nodeId: string,
		timing: RunPhaseMarks,
		endpoint?: EndpointCapacity | null,
		signal?: AbortSignal,
	) {
		const queuedAt = now();
		timing.queuedAt = new Date(queuedAt).toISOString();
		const assignmentId =
			req.lineage?.rootRunId ?? req.runIdHint ?? `pending-${queuedAt.toString(36)}-${randomBytes(6).toString("hex")}`;
		const requestedAt = Date.parse(timing.requestedAt ?? timing.queuedAt);
		const deadlineAt =
			req.assignmentDeadlineAt ??
			(req.routingIntent?.deadlineMs === undefined || req.routingIntent.deadlineMs === null
				? undefined
				: requestedAt + req.routingIntent.deadlineMs);
		if (deadlineAt !== undefined) req.assignmentDeadlineAt = deadlineAt;
		if (req.lineage === undefined) await registerAssignment(assignmentId);
		// A plan's queued members keep their wave order and their reserved peak.
		const plan =
			req.reservation === undefined
				? {}
				: planQueueSlot(req.reservation.ownerId, req.reservation.memberId, (error) =>
						reportDispatchDiagnostic("read plan queue identity", error),
					);
		try {
			signal?.throwIfAborted();
			const admitted = await capacityAdmission.admit({
				assignmentId,
				nodeId,
				...(endpoint !== null && endpoint !== undefined ? { endpointKey: endpoint.key } : {}),
				...(deadlineAt === undefined ? {} : { deadlineAt }),
				...plan,
				// A fleet's first attempt carries lineage and still owns the held
				// reservation member that admission must transfer into its lease.
				// Retries carry the same reservation identity after that member was
				// consumed, so they reacquire/rebind the assignment lease normally.
				...(req.reservation !== undefined && (req.lineage === undefined || req.lineage.attempt === 0)
					? { reservation: req.reservation }
					: {}),
				...(req.requestOrigin === "user" ? { operatorStarted: true } : {}),
				// This attempt's own signal; siblings sharing the assignment keep waiting.
				...(signal !== undefined ? { signal } : {}),
			});
			timing.admittedAt = new Date(admitted.admittedAt).toISOString();
			return admitted.lease;
		} catch (error) {
			if (req.lineage === undefined) {
				// Typed errors, not message text: no admission message ever contained
				// "timed_out", so a timed-out wait used to be stored as failed.
				if (error instanceof AdmissionTimedOutError) await timeoutStoredAssignment(assignmentId);
				else if (error instanceof AdmissionCanceledError || signal?.aborted === true)
					await cancelStoredAssignment(assignmentId);
				else await failQueuedAssignment(assignmentId);
			}
			throw error;
		}
	}

	async function rebindReservationSlot(
		req: DispatchRequest,
		nodeId: string,
		endpoint: EndpointCapacity | null,
		costUsd: number,
		settings: EffectiveSettings,
	): Promise<void> {
		if (req.reservation === undefined) return;
		const capacity = reservationCapacitySnapshot(settings, await capacityLeaseUsageAsync());
		const rebind = {
			...req.reservation,
			nodeId,
			...(endpoint !== null ? { endpointKey: endpoint.key } : {}),
			costUpperBoundUsd: Math.max(req.routeApproval?.totalCostUpperBoundUsd ?? 0, costUsd),
			capacity,
			nowMs: now(),
		};
		await rebindDispatchReservationMember(rebind);
	}

	/** Process-local retry queue keyed by finished run; backoff is keyed by member control root. */
	interface RetryQueueEntry {
		runId: string;
		agentId: string;
		task: string;
		attempt: number;
		dueAt: number;
		reason: string;
		excludedRouteParts: RetryDecision["excludedRouteParts"];
		rootRunId: string;
		terminalCandidate: RunResult;
		timer: ReturnType<typeof setTimeout>;
		settleCanceled: () => void;
	}
	const retryQueue = new Map<string, RetryQueueEntry>();
	const writeRootPark = createWriteRootPark<ActiveRun, RunResult>({
		broker: grantBroker,
		now,
		deadlineMs: () =>
			getEffectiveSettings()?.fleet.limits.internalRunTimeoutMs ?? DEFAULT_SETTINGS.fleet.limits.internalRunTimeoutMs,
		isLive: (run) => !draining && retryChainIsLive(run),
		hold: (run, settled) => trackMemberWork(run.runId, settled),
		settle: (run, receipt, status, detail) =>
			settleAssignmentDurably(asAssignmentId(run.lineage.rootRunId), receipt, status, detail),
		continueAttempt: (run, reason, continuation) =>
			executeRetry(
				run,
				run.lineage.attempt + 1,
				reason,
				{ retry: true, excludedRouteParts: [], qualityEscalation: null, reasonCode: "retry-write-roots-widened" },
				[],
				reason,
				continuation,
			),
	});
	/** Delay before the first retry of a member's worker run; each further attempt doubles it. */
	const RETRY_BACKOFF_BASE_MS = 500;
	/** Ceiling the doubled retry delay never exceeds. */
	const RETRY_BACKOFF_CAP_MS = 60_000;
	/** Retry attempts per member control root; the count sets the delay between the base and the cap above. */
	const retryBackoff = new Map<string, number>();
	const retryReasons = new Map<string, string>();
	const assignmentRootsByAttempt = new Map<string, string>();
	// Fleet lineage is shared ancestry, not control ownership. Keep each
	// member's retry chain distinct without changing persisted lineage.
	const controlRootsByAttempt = new Map<string, string>();
	const controlAttempts = new Map<
		string,
		{ lineage: RunLineage; reservation: DispatchRequest["reservation"]; maxRetries: number; receipt?: RunResult }
	>();
	const canceledControlRoots = new Set<string>();
	/** Control roots the dispatching session canceled through the steer tool (ns:61). */
	const steerCanceledRoots = new Set<string>();
	const memberWork = new Map<string, Set<Promise<unknown>>>();
	function trackMemberWork(runId: string, operation: Promise<unknown>): void {
		const root = controlRootsByAttempt.get(runId) ?? runId;
		const work = memberWork.get(root) ?? new Set<Promise<unknown>>();
		memberWork.set(root, work);
		work.add(operation);
		const settled = (): void => {
			work.delete(operation);
			if (work.size === 0) memberWork.delete(root);
		};
		operation.then(settled, settled);
	}

	const assignments = new AssignmentRegistry({
		onStreamError: (error) => reportDispatchDiagnostic("assignment event stream", error),
	});
	const durableWrites = new Set<Promise<unknown>>();
	let draining = false;
	const drainController = new AbortController();
	const dispatching = new Set<Promise<unknown>>();
	let drainPromise: Promise<void> | null = null;
	let stopPromise: Promise<void> | null = null;
	let routeHistoryWarmTimer: ReturnType<typeof setTimeout> | null = null;

	/** Session-scope totals for the operator snapshot; finalized runs only. */
	let finalizedRuntimeSeconds = 0;
	const finalizedSpends: Array<Pick<RunResult, "spend" | "spendSums">> = [];

	function workersMaxRetries(settings: EffectiveSettings = getEffectiveSettings()): number {
		const value = settings?.fleet?.retry.maxRetries;
		return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 2;
	}

	function failoverModeFor(req: DispatchRequest): DispatchFailoverMode {
		return recovery.effectiveFailoverMode(req);
	}

	function assignmentPolicyFor(req: DispatchRequest): import("./assignment.js").AssignmentPolicy {
		return {
			maxRetries: req.routeApproval?.maxAttempts === undefined ? workersMaxRetries() : req.routeApproval.maxAttempts - 1,
			failover: failoverModeFor(req),
			allowedCandidates: req.allowedCandidates?.map((candidate) => ({ ...candidate })) ?? [],
		};
	}

	function lineageFor(req: DispatchRequest, runId: string): RunLineage {
		const lineage = req.lineage ? { ...req.lineage } : { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 };
		assignmentRootsByAttempt.set(runId, lineage.rootRunId);
		const parent = lineage.parentRunId === null ? undefined : controlAttempts.get(lineage.parentRunId);
		// Repair ordinals and fleet ancestry do not establish a retry. Only a
		// known consecutive attempt of the same reservation member can do so.
		const continuesParent =
			parent !== undefined &&
			parent.lineage.rootRunId === lineage.rootRunId &&
			parent.lineage.depth === lineage.depth &&
			parent.lineage.attempt + 1 === lineage.attempt &&
			parent.reservation?.ownerId === req.reservation?.ownerId &&
			parent.reservation?.memberId === req.reservation?.memberId;
		const priorControl =
			continuesParent && lineage.parentRunId !== null ? controlRootsByAttempt.get(lineage.parentRunId) : undefined;
		controlRootsByAttempt.set(runId, priorControl ?? runId);
		controlAttempts.set(runId, {
			lineage,
			reservation: req.reservation,
			maxRetries: continuesParent ? parent.maxRetries : assignmentPolicyFor(req).maxRetries,
		});
		return lineage;
	}

	function accumulateFinalizedTotals(receipt: RunResult): void {
		finalizedSpends.push({ spend: receipt.spend, spendSums: receipt.spendSums });
		const startMs = Date.parse(receipt.startedAt);
		const endMs = Date.parse(receipt.endedAt);
		if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
			finalizedRuntimeSeconds += Math.max(0, rawDurationMs(startMs, endMs)) / 1000;
		}
	}

	function trackDurableWrite<T>(operation: Promise<T>): Promise<T> {
		durableWrites.add(operation);
		operation.finally(() => durableWrites.delete(operation)).catch(() => {});
		return operation;
	}

	function persistLedgerInBackground(target: Ledger, runId: string): Promise<void> {
		return trackDurableWrite(target.persist()).catch((error) =>
			reportDispatchDiagnostic(`persist running row for run ${runId}`, error),
		);
	}

	/** A settlement can queue a reservation release as it lands, so loop until none is pending (#428). */
	async function flushDurableWrites(): Promise<void> {
		while (durableWrites.size > 0) await Promise.allSettled([...durableWrites]);
	}

	function persistAssignment(operation: Promise<unknown>, label: string): void {
		trackDurableWrite(operation).catch((error) => reportDispatchDiagnostic(`persist assignment ${label}`, error));
	}

	function settleAssignmentDurably(
		assignmentId: import("./assignment.js").AssignmentId,
		receipt: RunResult,
		status: "succeeded" | "failed" | "canceled",
		outcomeDetail?: string,
	): void {
		void trackDurableWrite(
			(async () => {
				// A failed write is reported, never swapped for the worker's real
				// outcome, and never left holding the capacity slot (#428).
				try {
					await settleStoredAssignment(assignmentId, receipt.runId, status, undefined, outcomeDetail);
				} catch (error) {
					reportDispatchDiagnostic(`persist assignment ${assignmentId}:settle:${status}`, error);
				}
				try {
					await capacityAdmission.releaseAssignmentAsync(assignmentId);
				} catch (error) {
					reportDispatchDiagnostic(`release capacity for assignment ${assignmentId}`, error);
				}
				// Terminal observers must wait for both directory flushes (#428).
				try {
					assignments.settle(assignmentId, receipt, status, outcomeDetail);
				} catch (error) {
					reportDispatchDiagnostic(`settle assignment ${assignmentId}:${status}`, error);
				}
			})(),
		);
	}

	/**
	 * Finalization failed before an immutable receipt existed, so the normal
	 * settlement path (completeAssignmentAttempt) never ran. Mark the durable
	 * assignment failed against the attempt's run id so a later wait/collect can
	 * never observe a stuck "running" record. The in-memory terminal promise is
	 * rejected by the attached finalPromise.catch on the dispatch/retry handle.
	 */
	function settleAssignmentDurablyWithoutReceipt(rootRunId: string, attemptRunId: string): void {
		persistAssignment(settleStoredAssignment(rootRunId, attemptRunId, "failed"), `${rootRunId}:finalize-error`);
		capacityAdmission.releaseAssignment(rootRunId);
	}

	type RetryScheduleResult = { scheduled: true } | { scheduled: false; settlementDetail?: string };

	function memberRetryAttempt(run: ActiveRun): number {
		const root = controlRootsByAttempt.get(run.runId) ?? run.runId;
		// #231 gives loop repairs the same retry budget without changing the
		// published lineage ordinal used by route observations and the ledger.
		return run.lineage.attempt - (controlAttempts.get(root)?.lineage.attempt ?? 0);
	}

	/** A reserved plan member owns its retry chain independently of the shared fleet root assignment. */
	function retryChainIsLive(run: ActiveRun): boolean {
		if (run.aborted || canceledControlRoots.has(controlRootsByAttempt.get(run.runId) ?? run.lineage.rootRunId))
			return false;
		const reservation = run.req.reservation;
		if (reservation === undefined) return assignments.get(run.lineage.rootRunId)?.status === "running";
		try {
			const record = getDispatchReservation(reservation.ownerId);
			const member = record?.members.find((entry) => entry.memberId === reservation.memberId);
			return record?.status === "active" && member !== undefined && member.status !== "released";
		} catch (error) {
			reportDispatchDiagnostic(`read retry liveness for reservation member ${reservation.memberId}`, error);
			return false;
		}
	}

	function maybeScheduleRetry(
		run: ActiveRun,
		outcome: RunOutcome,
		detail: string | null,
		receipt: RunResult,
		failureClass: FailureClass,
		contextOverflow = false,
		currentRetryReason: string | null = null,
		unmetObligation?: Obligation,
	): RetryScheduleResult {
		if (draining) return { scheduled: false };
		const rootRunId = run.lineage.rootRunId;
		const controlRoot = controlRootsByAttempt.get(run.runId) ?? rootRunId;
		if (!retryChainIsLive(run)) return { scheduled: false };
		if (providers.getRuntime(run.runtimeId)?.externalAgentLoop?.generatingRetry === "forbidden") {
			retryBackoff.delete(controlRoot);
			return {
				scheduled: false,
				settlementDetail:
					"automatic retry suppressed because this external agent loop is one-shot and PanCode cannot prove replay is side-effect-free",
			};
		}
		if (!RETRYABLE_OUTCOMES.has(outcome)) {
			retryBackoff.delete(controlRoot);
			return { scheduled: false };
		}
		// #231 gives each member its own configured retry budget, even when a
		// sibling has already opened an assignment under the shared fleet root.
		const configuredRetries =
			assignments.get(controlRoot)?.policy.maxRetries ??
			controlAttempts.get(controlRoot)?.maxRetries ??
			assignmentPolicyFor(run.req).maxRetries;
		const maxRetries =
			unmetObligation !== undefined ? Math.min(configuredRetries, OBLIGATION_RETRY_LIMIT) : configuredRetries;
		const baseDecision = decideRetry(failureClass, memberRetryAttempt(run), maxRetries);
		let plannedRoutes: DispatchFailoverCandidate[] = [];
		/** An obligation retry may move past a refused route to the next other model. */
		let otherModelFallThrough = false;
		if (unmetObligation !== undefined && baseDecision.retry) {
			const plan = planObligationRetry(
				{ agents, approvedRetryCandidates, failoverModeFor, getEffectiveSettings, providers, targetCooldownReason },
				run,
				unmetObligation,
				baseDecision,
			);
			if ("settlementDetail" in plan) {
				retryBackoff.delete(controlRoot);
				return { scheduled: false, settlementDetail: plan.settlementDetail };
			}
			plannedRoutes = plan.routes;
			otherModelFallThrough = true;
		}
		// An exact manual route may be retried, but no route component may drift.
		let decision = recovery.retryDecisionWithinFailover(baseDecision, failoverModeFor(run.req));
		let overflowReason: string | null = null;
		if (contextOverflow && !decision.retry) {
			const plan = planOverflowRetry(
				{
					CONTEXT_OVERFLOW_RETRY,
					agents,
					failoverModeFor,
					getEffectiveSettings,
					memberRetryAttempt,
					providers,
					targetCooldownReason,
				},
				run,
				currentRetryReason,
				maxRetries,
			);
			if ("settlementDetail" in plan) {
				retryBackoff.delete(controlRoot);
				return { scheduled: false, settlementDetail: plan.settlementDetail };
			}
			plannedRoutes = [plan.route];
			otherModelFallThrough = false;
			overflowReason = plan.reason;
			decision = { retry: true, excludedRouteParts: [], qualityEscalation: null, reasonCode: "retry-context-overflow" };
		}
		if (!decision.retry) {
			retryBackoff.delete(controlRoot);
			// Deterministic outcomes are intentionally not retried. This is a normal
			// policy decision carried by the receipt, not an operational diagnostic
			// that should leak into an embedding command's stderr.
			return { scheduled: false };
		}
		if (receipt.safety?.grants?.some((grant) => grant.execution === "unknown") === true) {
			retryBackoff.delete(controlRoot);
			return {
				scheduled: false,
				settlementDetail:
					"automatic retry suppressed because a granted call may have run before the worker exited, and its outcome is unknown",
			};
		}
		const potentiallyMutated =
			receipt.toolActivity?.mutatingSucceeded === true ||
			hasPotentiallyMutatingAttempt(receipt.toolStats, (tool) => classifyAction({ tool }).actionClass);
		if (potentiallyMutated) {
			retryBackoff.delete(controlRoot);
			return {
				scheduled: false,
				settlementDetail:
					"automatic retry suppressed because the failed attempt executed a potentially state-changing tool call and retries do not yet have isolated workspaces",
			};
		}
		const telemetry = receipt.safety?.toolTelemetry;
		const unfinishedMutation =
			telemetry?.unfinished.some(({ tool, count }) => count > 0 && classifyAction({ tool }).actionClass !== "read") ===
			true;
		const mutationNotRuledOut =
			telemetry === undefined
				? run.runtimeKind === "subprocess" || run.runtimeKind === "acp-delegation"
				: (telemetry.coverage === "unavailable" && (telemetry.workspaceMutationPossible || unfinishedMutation)) ||
					(telemetry.coverage === "partial" &&
						(unfinishedMutation || (telemetry.ingestionErrors > 0 && telemetry.workspaceMutationPossible)));
		if (mutationNotRuledOut) {
			retryBackoff.delete(controlRoot);
			return {
				scheduled: false,
				settlementDetail:
					"automatic retry suppressed because incomplete tool telemetry cannot prove the failed attempt left the shared workspace unchanged",
			};
		}
		const backoffAttempt = (retryBackoff.get(controlRoot) ?? 0) + 1;
		retryBackoff.set(controlRoot, backoffAttempt);
		const backoffDelayMs = engineRetryDelayMs(RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_CAP_MS, backoffAttempt);
		// An in-flight assignment is governed by maxRetries and backoff alone. The
		// target cooldown it just created protects new work, not this chain.
		const delayMs = Math.max(backoffDelayMs, decision.retryAfterMs ?? 0);
		const attempt = run.lineage.attempt + 1;
		const reason = overflowReason ?? (detail !== null ? `${outcome}: ${detail}` : outcome);
		const dueAt = now() + delayMs;
		let settleCanceled!: () => void;
		let rejectContinuation!: (error: unknown) => void;
		const continuation = new Promise<void>((resolve, reject) => {
			settleCanceled = resolve;
			rejectContinuation = reject;
		});
		trackMemberWork(run.runId, continuation);
		const timer = setTimeout(() => {
			retryQueue.delete(run.runId);
			// Ownership starts at scheduling, covering admission before a handle
			// exists and terminal receipt work after the handle arrives.
			executeRetry(
				run,
				attempt,
				reason,
				decision,
				plannedRoutes,
				failureClassWords(failureClass),
				{},
				otherModelFallThrough,
			).then(settleCanceled, rejectContinuation);
		}, delayMs);
		retryQueue.set(run.runId, {
			runId: run.runId,
			agentId: run.agentId,
			task: run.task,
			attempt,
			dueAt,
			reason,
			excludedRouteParts: [...decision.excludedRouteParts],
			rootRunId,
			terminalCandidate: receipt,
			timer,
			settleCanceled,
		});
		context.bus.emit("run.progressed", {
			runId: run.runId,
			agentId: run.agentId,
			task: run.task,
			...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
			...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
			targetId: run.targetId,
			wireModelId: run.wireModelId,
			runtimeId: run.runtimeId,
			runtimeKind: run.runtimeKind,
			event: { type: "retry_scheduled", attempt, dueAt: new Date(dueAt).toISOString(), reason },
		});
		return { scheduled: true };
	}

	const CONTEXT_OVERFLOW_RETRY = "context-overflow";

	function retryReasonKey(rootRunId: string, attempt: number): string {
		return `${rootRunId}:${attempt}`;
	}

	function completeAssignmentAttempt(
		run: ActiveRun,
		receipt: RunResult,
		outcome: RunOutcome,
		detail: string | null,
		failureClass: FailureClass,
		contextOverflow = false,
		unmetObligation?: Obligation,
	): boolean {
		const controlAttempt = controlAttempts.get(run.runId);
		if (controlAttempt !== undefined && run.lineage.depth > 0) controlAttempt.receipt = receipt;
		const assignment = assignments.open(run.lineage.rootRunId, assignmentPolicyFor(run.req));
		persistAssignment(registerAssignment(assignment.id), `${assignment.id}:open`);
		const reasonKey = retryReasonKey(controlRootFor(run.runId), run.lineage.attempt);
		const retryReason = run.lineage.attempt > 0 ? (retryReasons.get(reasonKey) ?? "retry") : null;
		retryReasons.delete(reasonKey);
		assignments.recordAttempt(assignment.id, {
			runId: run.runId,
			attempt: run.lineage.attempt,
			outcome,
			node: run.node,
			runDigest: receipt.digest,
			retryReason,
		});
		persistAssignment(recordAssignmentAttempt(assignment.id, run.runId), `${assignment.id}:attempt:${run.runId}`);
		if (writeRootPark.park(run, receipt)) return true;
		const retry = maybeScheduleRetry(
			run,
			outcome,
			detail,
			receipt,
			failureClass,
			contextOverflow,
			retryReason,
			unmetObligation,
		);
		if (retry.scheduled) return true;
		const currentStatus = assignments.get(assignment.id)?.status;
		const terminalStatus =
			currentStatus === "canceled" || outcome === "canceled"
				? "canceled"
				: outcome === "succeeded"
					? "succeeded"
					: "failed";
		settleAssignmentDurably(assignment.id, receipt, terminalStatus, retry.settlementDetail);
		return false;
	}

	function assertRouteWithinApprovedEnvelope(req: DispatchRequest, effective: DispatchFailoverCandidate): void {
		if (failoverModeFor(req) !== "approved") return;
		const allowed = req.allowedCandidates ?? [];
		if (!allowed.some((candidate) => recovery.sameFailoverCandidate(candidate, effective))) {
			throw new Error(
				`dispatch: admission denied: effective route agent=${effective.agentId} target=${effective.target} model=${effective.model} node=${effective.node} is outside the approved failover envelope`,
			);
		}
	}

	function approvedRetryCandidates(run: ActiveRun, decision: RetryDecision): DispatchFailoverCandidate[] {
		return recovery.selectApprovedRecoveryCandidates({
			current: { agentId: run.agentId, target: run.targetId, model: run.wireModelId, node: run.node?.id ?? "local" },
			allowed: run.req.allowedCandidates ?? [],
			approval: run.req.routeApproval ?? null,
			decision,
		});
	}

	async function executeRetry(
		run: ActiveRun,
		attempt: number,
		reason = "retry",
		decision: RetryDecision = decideRetry("internal", memberRetryAttempt(run), assignmentPolicyFor(run.req).maxRetries),
		/** Routes chosen at scheduling, by a context overflow or an unmet obligation, in the order to try them. */
		plannedRoutes: ReadonlyArray<DispatchFailoverCandidate> = [],
		moveReason = reason,
		continuation: WriteRootContinuation = {},
		/** An obligation retry: a refused route falls through to the next other-model route, never the failed model. */
		otherModelFallThrough = false,
	): Promise<void> {
		if (draining || !retryChainIsLive(run)) return;
		const excludesNode = decision.excludedRouteParts.includes("node");
		// Record the failed node so placement can choose an eligible survivor.
		const rerouteHops =
			excludesNode && run.node !== null
				? [...(run.req.reroutes ?? []), { attempt, fromNode: run.node.id, toNode: "", reason }]
				: run.req.reroutes;
		const retryReq: DispatchRequest = {
			...run.req,
			...continuation,
			...(rerouteHops !== undefined ? { reroutes: rerouteHops } : {}),
			// A retry that moves the target names one, which would otherwise read
			// as an operator pin and freeze every later retry in the chain.
			failover: failoverModeFor(run.req),
			requestOrigin: "internal",
			// Policy reads the stamp above; the board still names who asked for the work.
			rootRequestOrigin: run.req.rootRequestOrigin ?? requestOriginFor(run.req),
			routeMove: { fromTargetId: run.targetId, fromModelId: run.wireModelId, reason: moveReason },
			// A retry starts with no grants and runs no wider than this attempt.
			...(run.permit !== undefined ? { inheritedPermitAllowance: { ...run.permit.allowance } } : {}),
			lineage: {
				parentRunId: run.runId,
				rootRunId: run.lineage.rootRunId,
				attempt,
				depth: run.lineage.depth,
			},
		};
		// Every retry needs a fresh identity before preparation so its worker and
		// settlement share one run journal, independently of assignment lineage (#434).
		retryReq.runIdHint = newRunId();
		let terminal: Promise<RunResult> | undefined;
		/** Set when a refused admission can move the retry on to the next route. */
		let nextRoute: NextRetryRoute | null = null;
		const notRefused =
			(refused: ReadonlyArray<{ target: string; model: string }>) => (candidate: DispatchFailoverCandidate) =>
				!refused.some((entry) => entry.target === candidate.target && entry.model === candidate.model);
		const reasonKey = retryReasonKey(controlRootFor(run.runId), attempt);
		retryReasons.set(reasonKey, reason);
		try {
			if (failoverModeFor(run.req) === "approved") {
				const candidates =
					plannedRoutes.length > 0
						? plannedRoutes.map((candidate) => ({ ...candidate }))
						: approvedRetryCandidates(run, decision);
				if (run.req.routeApproval === undefined) {
					const candidate = candidates[0] as DispatchFailoverCandidate;
					retryReq.agentId = candidate.agentId;
					retryReq.target = candidate.target;
					retryReq.model = candidate.model;
					retryReq.node = candidate.node;
					if (otherModelFallThrough) {
						// The envelope's later other-model candidates, in order, once each.
						let index = 0;
						nextRoute = () => {
							index += 1;
							return candidates[index] ?? null;
						};
					}
				} else {
					const approval = run.req.routeApproval;
					const settings = getEffectiveSettings();
					const approvedEnvelope = retryReq.allowedCandidates as DispatchFailoverCandidate[];
					/** The retry before any selection, so a later candidate starts from the same request. */
					const unselected: DispatchRequest = { ...retryReq };
					let lastError: unknown;
					/** Apply the first candidate from `start` the active resolver and the approval admit; its index, or null. */
					const selectFrom = (start: number): number | null => {
						for (let index = start; index < candidates.length; index += 1) {
							const candidate = candidates[index] as DispatchFailoverCandidate;
							const bounded = {
								...unselected,
								agentId: candidate.agentId,
								target: candidate.target,
								model: candidate.model,
								node: candidate.node,
								allowedCandidates: [candidate],
							};
							try {
								const active = resolveJointRoute(jointRouteInput(bounded, undefined, settings, "active").input).decision;
								assertApprovedRecoveryCapability(approval, active.selected);
								const selected = applyActiveRouteSelection(bounded, active);
								for (const key of Object.keys(retryReq)) {
									if (!Object.hasOwn(unselected, key)) Reflect.deleteProperty(retryReq, key);
								}
								Object.assign(retryReq, unselected);
								retryReq.routeAttemptDecision = active;
								Object.assign(retryReq, selected);
								retryReq.allowedCandidates = approvedEnvelope;
								return index;
							} catch (error) {
								lastError = error;
							}
						}
						return null;
					};
					let selectedIndex = selectFrom(0);
					if (selectedIndex === null) {
						const detail = lastError instanceof Error ? lastError.message : String(lastError);
						throw new Error(`dispatch: approved recovery has no active-eligible route (${detail})`);
					}
					if (otherModelFallThrough) {
						// Admission refused the selected candidate: the next other-model
						// one in the envelope, with its own active decision, once each.
						nextRoute = () => {
							selectedIndex = selectedIndex === null ? null : selectFrom(selectedIndex + 1);
							if (selectedIndex === null || retryReq.target === undefined || retryReq.model === undefined) return null;
							return {
								target: retryReq.target,
								model: retryReq.model,
								agentId: retryReq.agentId,
								...(retryReq.node !== undefined ? { node: retryReq.node } : {}),
							};
						};
					}
				}
				delete retryReq.plannedNode;
			} else {
				// Exact mode freezes the effective first-attempt tuple.
				if (failoverModeFor(run.req) === "none") {
					retryReq.agentId = run.agentId;
					retryReq.target = run.targetId;
					retryReq.model = run.wireModelId;
					retryReq.node = run.node?.id ?? "local";
				}
				const plannedRoute = plannedRoutes[0];
				if (plannedRoute !== undefined) {
					retryReq.target = plannedRoute.target;
					retryReq.model = plannedRoute.model;
					if (otherModelFallThrough) {
						nextRoute = (refused) => {
							const next = eligibleAlternateRoute(
								{ agents, getEffectiveSettings, providers, targetCooldownReason },
								run,
								retryReq,
								undefined,
								notRefused(refused),
								true,
							);
							return next === null ? null : { target: next.target, model: next.model };
						};
					}
				}
				// Automatic placement re-selects only the failed route component.
				if (excludesNode) {
					delete retryReq.node;
					delete retryReq.plannedNode;
				}
				if (decision.excludedRouteParts.includes("target")) {
					const alternate = eligibleAlternateRoute(
						{ agents, getEffectiveSettings, providers, targetCooldownReason },
						run,
						retryReq,
					);
					if (alternate !== null) {
						retryReq.target = alternate.target;
						retryReq.model = alternate.model;
						nextRoute = (refused) => {
							const next = eligibleAlternateRoute(
								{ agents, getEffectiveSettings, providers, targetCooldownReason },
								run,
								retryReq,
								undefined,
								notRefused(refused),
							);
							return next === null ? null : { target: next.target, model: next.model };
						};
					} else {
						// No other route can serve the request, so placement picks again.
						// That is usually the failed route itself, which the chain may
						// retry after backoff because the breaker guards new work only.
						delete retryReq.target;
					}
				}
				// A planned route already moved off the failed model; placement would be free to pick it again.
				if (plannedRoute === undefined && decision.excludedRouteParts.includes("model")) delete retryReq.model;
				if (decision.excludedRouteParts.includes("runtime")) delete retryReq.workerRuntime;
			}
			const handle = await dispatchRetryAcrossAlternates(run, retryReq, nextRoute, moveReason);
			// Cancellation can arrive while retry admission is awaiting a handle.
			if (canceledControlRoots.has(controlRootsByAttempt.get(run.runId) ?? run.lineage.rootRunId)) {
				contract.abort(handle.runId);
			}
			// The assignment folds every attempt into one stream with a reset marker.
			const marker: AssignmentAttemptStartEvent = {
				type: "attempt_start",
				attempt,
				runId: handle.runId,
				previousRunId: run.runId,
				reason,
			};
			assignments.attachAttempt(asAssignmentId(run.lineage.rootRunId), handle.events, marker);
			context.bus.emit("run.progressed", {
				runId: run.lineage.rootRunId,
				agentId: run.agentId,
				task: run.task,
				...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
				...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
				targetId: run.targetId,
				wireModelId: run.wireModelId,
				runtimeId: run.runtimeId,
				runtimeKind: run.runtimeKind,
				event: marker,
			});
			terminal = handle.finalPromise;
			handle.finalPromise.catch((error) => {
				assignments.reject(asAssignmentId(run.lineage.rootRunId), error);
				reportDispatchDiagnostic(`finalize retry run ${handle.runId}`, error);
			});
		} catch (err) {
			retryReasons.delete(reasonKey);
			retryBackoff.delete(controlRootFor(run.runId));
			const message = err instanceof Error ? err.message : String(err);
			const routesRefused = err instanceof RetryRoutesRefusedError;
			const denial = routesRefused ? message : `retry attempt ${attempt} rejected: ${message}`;
			// Keep the denial visible on headless surfaces and assignment state; a
			// terminal owner states it from the run.failed below in its own words.
			writeHeadlessDiagnostic(`[pancode:dispatch] run ${run.runId}: ${denial}\n`);
			// The last completed attempt remains the immutable terminal evidence.
			try {
				const previousReceipt = await run.finalPromise;
				settleAssignmentDurably(asAssignmentId(run.lineage.rootRunId), previousReceipt, "failed", denial);
			} catch (finalizationError) {
				assignments.reject(asAssignmentId(run.lineage.rootRunId), finalizationError);
			}
			context.bus.emit("run.failed", {
				runId: run.runId,
				agentId: run.agentId,
				task: run.task,
				...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
				targetId: run.targetId,
				wireModelId: run.wireModelId,
				runtimeId: run.runtimeId,
				runtimeKind: run.runtimeKind,
				reason: "retry_denied",
				outcome: (routesRefused ? "failed" : "denied_by_policy") satisfies RunOutcome,
				outcomeDetail: denial,
			});
		}
		await terminal;
	}

	/**
	 * Admit a retry, and when admission refuses its route and `nextRoute` names
	 * another, move on to it. Health is often unknown until admission probes a
	 * target, so the first alternate in configured order can be down while a
	 * later one is healthy. Each route is tried once and the retry stays one
	 * attempt. Every refusal is journaled on the assignment and named in the
	 * move's reason.
	 */
	async function dispatchRetryAcrossAlternates(
		run: ActiveRun,
		retryReq: DispatchRequest,
		nextRoute: NextRetryRoute | null,
		moveReason: string,
	): ReturnType<typeof dispatch> {
		const refused: Array<{ target: string; model: string; words: string }> = [];
		for (;;) {
			try {
				return await dispatch(retryReq, undefined, run.hostRun === undefined ? undefined : { hostRun: run.hostRun });
			} catch (error) {
				const target = retryReq.target;
				const model = retryReq.model;
				if (nextRoute === null || target === undefined || model === undefined || draining || !retryChainIsLive(run))
					throw error;
				// A route on the failed target is another model, so the words name the model too.
				const words = routeRefusalWords(target === run.targetId ? `${target}/${model}` : target, error);
				refused.push({ target, model, words });
				context.bus.emit("run.progressed", {
					runId: run.lineage.rootRunId,
					agentId: run.agentId,
					task: run.task,
					...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
					...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
					targetId: run.targetId,
					wireModelId: run.wireModelId,
					runtimeId: run.runtimeId,
					runtimeKind: run.runtimeKind,
					event: {
						type: "route_refused",
						targetId: target,
						modelId: model,
						reason: error instanceof Error ? error.message : String(error),
					},
				});
				const next = nextRoute(refused);
				const skipped = refused.map((entry) => entry.words).join("; ");
				if (next === null) throw new RetryRoutesRefusedError(`no other route would take the retry: ${skipped}`);
				retryReq.target = next.target;
				retryReq.model = next.model;
				if (next.agentId !== undefined) retryReq.agentId = next.agentId;
				if (next.node !== undefined) retryReq.node = next.node;
				retryReq.runIdHint = newRunId();
				retryReq.routeMove = {
					fromTargetId: run.targetId,
					fromModelId: run.wireModelId,
					reason: `${moveReason}; ${skipped}, so ${next.target === run.targetId ? `${next.target}/${next.model}` : next.target} took the retry`,
				};
			}
		}
	}

	function requireLedger(): Ledger {
		if (!ledger) throw new Error("dispatch: ledger not initialized");
		return ledger;
	}

	/** Reap dead-node runs through the retryable stall path. */
	function reapRunsOnDeadNode(nodeId: string, excludeRunId: string): void {
		for (const other of active.values()) {
			if (other.runId === excludeRunId) continue;
			if (other.node?.id !== nodeId || other.aborted || other.stallKilled) continue;
			other.stallKilled = true;
			other.heartbeatStatus = "dead";
			emitHeartbeatStatus(other, "dead");
			try {
				other.kill();
			} catch {
				// channel may already be gone; the finalizer still settles the run
			}
		}
	}

	/**
	 * Per-run channel verdict feeding node classification. Completing the
	 * protocol (even with a failing exit code) proves the channel; stalls,
	 * spawn failures, and ssh exit 255 count against it. Operator cancels and
	 * policy denials are neutral.
	 */
	function recordNodeChannelOutcome(
		run: ActiveRun,
		outcome: RunOutcome,
		failureClass: FailureClass,
		detail: string | null,
	): void {
		if (!fleetRegistry || run.node === null || run.node.kind !== "ssh") return;
		if (failureClass === "node-channel") {
			const state = fleetRegistry.recordChannelFailure(run.node.id, detail ?? outcome);
			if (state === "offline") reapRunsOnDeadNode(run.node.id, run.runId);
			return;
		}
		if (outcome === "succeeded" || isInfrastructureFailure(failureClass)) {
			fleetRegistry.recordChannelSuccess(run.node.id);
		}
	}

	function heartbeatIso(heartbeat: HeartbeatStamp): string {
		return new Date(heartbeat.current).toISOString();
	}

	function heartbeatRunStatus(status: HeartbeatStatus): RunStatus {
		return status === "alive" ? "running" : status;
	}

	function emitHeartbeatStatus(run: ActiveRun, status: HeartbeatStatus): void {
		context.bus.emit("run.progressed", {
			runId: run.runId,
			agentId: run.agentId,
			task: run.task,
			targetId: run.targetId,
			wireModelId: run.wireModelId,
			runtimeId: run.runtimeId,
			runtimeKind: run.runtimeKind,
			...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
			...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
			event: {
				type: "heartbeat_status",
				status,
				heartbeatAt: run.heartbeatAt ? heartbeatIso(run.heartbeatAt) : null,
			},
		});
	}

	/**
	 * Reconciler tick (Symphony §8.1: reconcile before dispatch). Observes
	 * every running entry and acts on the classification: a stale native
	 * worker gets one operator-visible warning per transition, a dead one is
	 * terminated through the SIGTERM→SIGKILL path and finalized as stalled by
	 * the run's own finalizer. ACP delegations have no periodic heartbeat, so
	 * they are bounded by an event-inactivity stall window instead of the
	 * native heartbeat spec. This loop runs on its own timer and never
	 * consults admission gates: a budget ceiling breach cannot prevent the
	 * reconciler from killing a dead worker.
	 */
	/**
	 * A live worker's spend never rewrites runs.json: at the 1000-row cap each rewrite is about 14 MiB fsynced and every
	 * board re-parses it, while every reader in another process folds spend from the run's journal and this process
	 * reads its meters. The tick still carries spend into the in-memory row, which any lifecycle write takes along. Only
	 * a heartbeat transition writes here, so a sibling's `fleet status` sees a stale or dead row (FL-24).
	 */
	let heartbeatLedgerWrite: Promise<void> | null = null;
	let heartbeatTransitionPending = false;

	function checkActiveHeartbeats(): void {
		if (!ledger) return;
		consumeOperatorCancelRequests();
		const tickMonotonic = monotonicNow();
		for (const run of active.values()) {
			if (run.aborted || run.stallKilled || run.sealing === true) continue;
			const row = ledger.peek(run.runId);
			// Finalizers keep active entries while persisting their sealed receipt.
			if (!row || row.endedAt !== null) continue;
			const spend = meterSpend(run.meter);
			const spendSums = meterSums(run.meter);
			if (!isDeepStrictEqual(row.spend, spend) || !isDeepStrictEqual(row.spendSums, spendSums)) {
				ledger.update(run.runId, { spend, spendSums });
			}
			if (run.awaitingOperator === true) {
				// The orchestrator is the live party; keep the row fresh and unclassified.
				ledger.update(run.runId, {
					status: "running",
					pid: process.pid,
					heartbeatAt: new Date(now()).toISOString(),
				});
				continue;
			}
			if (!run.heartbeatAt) continue;
			const heartbeatMonotonic = heartbeatMonotonicAt(run.heartbeatAt);
			if (!Number.isFinite(heartbeatMonotonic) || !Number.isFinite(run.heartbeatAt.current)) continue;
			if (run.runtimeKind === "acp-delegation") {
				ledger.update(run.runId, { heartbeatAt: heartbeatIso(run.heartbeatAt) });
				const stallMs = run.stallTimeoutMs;
				if (stallMs === null || stallMs <= 0 || run.peerQuestionOpen?.() === true) continue;
				if (tickMonotonic - heartbeatMonotonic <= stallMs) continue;
				run.stallKilled = true;
				run.heartbeatStatus = "dead";
				emitHeartbeatStatus(run, "dead");
				try {
					run.kill();
				} catch {
					// peer may have exited between classification and kill
				}
				continue;
			}
			const status = classifyHeartbeat(heartbeatMonotonic, tickMonotonic, heartbeatSpec);
			const patch: Partial<RunEnvelope> = {
				status: heartbeatRunStatus(status),
				heartbeatAt: heartbeatIso(run.heartbeatAt),
			};
			ledger.update(run.runId, patch);
			// Node staleness display feeds off the freshest worker heartbeat.
			if (status === "alive" && run.node !== null && run.node.kind === "ssh") {
				fleetRegistry?.seen(run.node.id);
			}
			if (status === run.heartbeatStatus) continue;
			run.heartbeatStatus = status;
			heartbeatTransitionPending = true;
			emitHeartbeatStatus(run, status);
			if (status !== "dead") continue;
			run.stallKilled = true;
			try {
				run.kill();
			} catch {
				// child may have exited between classification and reap attempt
			}
		}
		// One write covers every run that moved this tick; a transition during a write waits for the next tick. A failed
		// write leaves its rows dirty for the next lifecycle persist rather than retrying every tick (#428).
		if (heartbeatTransitionPending && heartbeatLedgerWrite === null) {
			heartbeatTransitionPending = false;
			heartbeatLedgerWrite = trackDurableWrite(ledger.persist())
				.catch((error: unknown) => reportDispatchDiagnostic("persist heartbeat transition", error))
				.finally(() => {
					heartbeatLedgerWrite = null;
				});
		}
	}

	/**
	 * `fleet cancel` runs in another process and cannot reach this process's
	 * abort handles, so it leaves a request file per run. Only the process
	 * holding the run acts on it, through the same abort an in-process cancel
	 * uses, so the run seals `canceled` with a complete receipt.
	 */
	function consumeOperatorCancelRequests(): void {
		for (const run of [...active.values()]) {
			let request: ReturnType<typeof takeRunCancelRequest>;
			try {
				request = takeRunCancelRequest(run.runId);
			} catch (error) {
				reportDispatchDiagnostic(`read cancel request for run ${run.runId}`, error);
				continue;
			}
			if (request === null || run.aborted || run.stallKilled) continue;
			contract.abort(run.runId, { cause: "operator", detail: cancelDetail(FLEET_CANCEL_DETAIL, request.reason) });
		}
	}

	/**
	 * Every run's deadline (its wall clock, or an earlier one the call set) outlives queue admission and the caller, so a
	 * detached run is stopped too; it seals timed_out through the ordinary abort path (DESIGN 4.5).
	 */
	function watchAssignmentDeadline(run: ActiveRun): void {
		const deadlineAt = run.req.assignmentDeadlineAt;
		if (deadlineAt === undefined) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const check = (): void => {
			if (settled || run.aborted || run.stallKilled) return;
			const remaining = deadlineAt - now();
			if (remaining <= 0) {
				contract.abort(run.runId, { cause: "timeout", detail: "timed out: explicit assignment deadline reached" });
			} else timer = setTimeout(check, Math.min(2_147_483_647, remaining));
		};
		const close = (): void => {
			settled = true;
			clearTimeout(timer);
		};
		void run.promise.then(close, close);
		check();
	}

	function startHeartbeatWatchdog(): void {
		if (heartbeatTimer || heartbeatIntervalMs <= 0) return;
		heartbeatTimer = setInterval(checkActiveHeartbeats, heartbeatIntervalMs);
		heartbeatTimer.unref?.();
	}

	function stopHeartbeatWatchdog(): void {
		if (!heartbeatTimer) return;
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	function cooldownKey(targetId: string, runtimeId: string, wireModelId: string): string {
		return `${targetId}\0${runtimeId}\0${wireModelId}`;
	}

	function describeTargetBlock(targetId: string, block: TargetBreakerBlock | null): string | null {
		if (block === null) return null;
		if (block.kind === "probing") {
			return `target '${targetId}' is cooling down while one probe run tests it after ${block.reason}`;
		}
		return `target '${targetId}' is cooling down for ${Math.ceil(block.remainingMs / 1000)}s after ${block.reason}`;
	}

	/** Read-only cooldown view for route planning; it never claims a half-open probe. */
	function targetCooldownReason(targetId: string, runtimeId: string, wireModelId: string): string | null {
		return describeTargetBlock(targetId, targetBreaker.blocked(cooldownKey(targetId, runtimeId, wireModelId)));
	}

	/**
	 * Admission gate for a top-level run. A half-open route admits this run as
	 * its probe; the claim goes into probeClaims so a dispatch that fails before
	 * its run starts can hand the probe back.
	 */
	function assertTargetNotCoolingDown(
		req: DispatchRequest,
		targetId: string,
		runtimeId: string,
		wireModelId: string,
		probeClaims: ProbeClaim[],
	): void {
		if (req.lineage !== undefined) return;
		const key = cooldownKey(targetId, runtimeId, wireModelId);
		const owner = req.runIdHint;
		const block = owner === undefined ? targetBreaker.blocked(key) : targetBreaker.admit(key, owner);
		const reason = describeTargetBlock(targetId, block);
		if (reason !== null) throw new Error(`dispatch: ${reason}`);
		if (owner !== undefined) probeClaims.push({ key, owner });
	}

	function recordTargetOutcome(
		runId: string,
		targetId: string,
		runtimeId: string,
		wireModelId: string,
		status: RunStatus,
		exitCode: number,
		failureClass: FailureClass,
	): void {
		const outcome =
			status === "completed" && exitCode === 0 ? "success" : affectsTargetBreaker(failureClass) ? "failure" : "neutral";
		targetBreaker.record(cooldownKey(targetId, runtimeId, wireModelId), runId, outcome, failureClass);
	}

	const publishedPathScopeRoots = new Set<string>();

	function ledgerAssignmentsFor(req: DispatchRequest, scope: DispatchPathScope): ReadonlyArray<LedgerAssignment> {
		if (req.ledger === undefined) return [];
		const runs = requireLedger()
			.list()
			.filter((run) => run.projection?.ledgerId === req.ledger?.id);
		const assignments = [...projectLedgerAssignments(runs, () => null)];
		const id = req.runIdHint ?? req.lineage?.rootRunId;
		if (id !== undefined && !runs.some((run) => run.id === id)) {
			const projection = runLedgerProjection(req, scope);
			assignments.push({
				runId: id,
				assignmentId: req.lineage?.rootRunId ?? id,
				agentId: req.agentId,
				task: req.task,
				readRoots: projection.readRoots,
				writeRoots: projection.writeRoots,
				scopeSource: projection.scopeSource,
				status: "queued",
				outcome: null,
				toolCalls: null,
				grounding: null,
			});
		}
		return assignments;
	}

	function publishDispatchPathScope(req: DispatchRequest, pathScope: DispatchPathScope): void {
		const rootRunId = req.lineage?.rootRunId ?? req.runIdHint;
		// Scope provenance remains in receipts; retries must not repeat a generated path inventory.
		if ((req.lineage?.attempt ?? 0) > 0 || (rootRunId !== undefined && publishedPathScopeRoots.has(rootRunId))) return;
		if (rootRunId !== undefined) publishedPathScopeRoots.add(rootRunId);
		const internalOrigin = req.requestOrigin === "internal" || req.requestOrigin === "harness";
		// Context generators embed source paths as evidence under an explicit
		// repository-wide read scope. That expected inventory is retained in the
		// receipt, but warning on it obscures their actual stage progress.
		const replacementDiagnostic = declaredScopeReplacementDiagnostic(pathScope);
		const contextGenerator = agentHasTrait(agents.getSpec(req.agentId), "context-generator");
		if (replacementDiagnostic !== null && internalOrigin && !contextGenerator) {
			reportDispatchDiagnostic("typed scope replacement", new Error(replacementDiagnostic));
		}
		// A reinterpreted "../" token is the one inferred-mode scope fact that earns
		// a notice, so it cannot warn on an ordinary intent-less dispatch. It travels on the bus
		// and in the dispatch plan artifact. Operator stderr stays free of it
		// because the scope it describes adds no authority the operator can act
		// on, and every normal dispatch with a "../" token in its prose hit it.
		const parentTokenNotice = inferredScopeParentTokenNotice(pathScope);
		if (parentTokenNotice !== null) {
			context.bus.emit("run.scope_notice_raised", {
				...parentTokenNotice,
				agentId: req.agentId,
			});
		}
	}

	/**
	 * The default sandbox (auto, no sandboxNetwork) starts admitted MCP servers
	 * with no network and a masked home, so a server that needs either fails
	 * only at its first call. The operator hears it at admission instead.
	 */
	function announceMcpSandboxNoNetwork(
		req: DispatchRequest,
		pathScope: DispatchPathScope,
		envelope: WorkerEnvelope,
		effectiveTools: ReadonlyArray<ToolName>,
		target: ResolvedTarget,
		settings: EffectiveSettings,
		mcp: WorkerMcpAttestation | undefined,
		withheld: ReadonlyArray<WorkerMcpNetworkWithheld>,
		placedSandbox: SandboxAvailability,
	): void {
		const servers = (mcp?.tools ?? []).filter((entry) =>
			effectiveTools.includes(`mcp_${entry.serverId}__${entry.tool}` as ToolName),
		);
		const offeredWithheld = withheld.filter((entry) => servers.some((server) => server.serverId === entry.serverId));
		if (servers.length === 0) return;
		const sandbox = workerSandboxFor({
			runtimeKind: target.runtime.kind,
			req,
			pathScope,
			envelope,
			settings,
		}).spec;
		if (sandbox === undefined) return;
		const message = workerMcpNoNetworkNotice(
			{ mode: sandbox.mode, network: sandbox.network, available: placedSandbox.available },
			servers,
			offeredWithheld,
		);
		if (message === null) return;
		context.bus.emit("run.scope_notice_raised", { code: "mcp_sandbox_no_network", level: "warning", message });
	}

	/**
	 * The user-facing stand-in a shadow refusal may name, or null. The stand-in
	 * is named only when the fixed-route admission preview admits its read-only
	 * run on the same request, so the refusal never suggests a command that is
	 * refused in turn.
	 */
	function admissibleShadowStandIn(req: DispatchRequest, settings: EffectiveSettings): string | null {
		const recipe = agents.get(SHADOW_AGENT_OPERATOR_STAND_IN);
		if (!recipe) return null;
		try {
			if (!isUserVisibleAgent(normalizeAgentSpec(recipe))) return null;
			// The fixed-route admission preview, run for the stand-in on the
			// operator's own request, so the hint can never name a refused route.
			const { delegationAgentId: _delegation, ...rest } = req;
			previewFixed({ ...rest, agentId: recipe.id, readOnly: true }, settings);
			return recipe.id;
		} catch {
			return null;
		}
	}

	/**
	 * Refuses a recipe the request may not run, before any route is resolved, and answers the capability mismatch it
	 * only flags. Dispatch and preview share it, so a plan never shows a run admission refuses.
	 */
	function assertRecipeAdmissible(
		req: DispatchRequest,
		recipe: AgentRecipe,
		settings: EffectiveSettings,
	): { spec: AgentSpec; capabilityMismatch: CapabilityMismatch | null } {
		// Resolve the applied contract once here so a caller's summary allowance
		// on a recipe that carries no summary fails before any model boots.
		dispatchResultContract(req, recipe);
		const spec = normalizeAgentSpec(recipe);
		if (req.requestOrigin === "user" && !isUserVisibleAgent(spec)) {
			throw new Error(userOriginAudienceRefusal(spec, admissibleShadowStandIn(req, settings)));
		}
		if (req.requestOrigin === "harness" && spec.capabilityClass !== "read-only") {
			throw new Error(
				`dispatch: harness-origin runs require a read-only recipe; '${req.agentId}' is ${spec.capabilityClass}`,
			);
		}
		if (hasCallerPersonaOverride(req) && (spec.audience === "shadow" || spec.audience === "internal")) {
			throw new Error(`dispatch: persona overrides are not allowed for ${spec.audience} agent '${req.agentId}'`);
		}
		// A read-only recipe pointed at a mutating task is knowable here and costs
		// a full worker run to discover afterwards. Refuse the pairing the caller
		// chose on purpose; flag the one the classifier may have misread.
		//
		// Gate runs are exempt outright. A reviewer or judge carries the builder's
		// task text so it knows what it is judging, so "document the module" on a
		// verifier is the gate working exactly as designed, not a mismatch.
		const capabilityMismatch =
			req.gate !== undefined
				? null
				: assessCapabilityMismatch({
						agentId: req.agentId,
						capabilityClass: spec.capabilityClass,
						task: req.task,
						autoSelected: req.agentSelection?.mode === "auto",
						resultContractKind: spec.resultContract.kind,
						specs: agents.listSpecs(),
						intent: req.intent ?? null,
					});
		if (capabilityMismatch?.verdict === "refuse") throw new Error(capabilityMismatch.detail);
		const planOutside = architectPlanOutsideWriteRoots(req.agentId, spec.resultContract, req.intent);
		if (planOutside !== null) throw new Error(planOutside);
		return { spec, capabilityMismatch };
	}

	/**
	 * Ruling 3 (M7): a builder whose write roots its placement cannot confine runs in its own task worktree, keeps
	 * bash and verify, and merges back only its roots. Decided from the facts the envelope reads; a request that
	 * cannot be resolved here is left as it is for admission to refuse with its own reason.
	 */
	function placedInOwnWorktree(req: DispatchRequest): boolean {
		if (req.worktree === true || req.taskWorktree !== undefined || req.gate !== undefined) return false;
		try {
			const recipe = agents.get(req.agentId);
			if (!recipe) return false;
			const pathScope = withStoreGrantBoundaries(req, resolveDispatchPathScope(req), () => previewNode(req).node);
			if (pathScope.writeBoundaries.length === 0) return false;
			const settings = getEffectiveSettings();
			const targets = readWorkerTargets(settings);
			const target = resolveDispatchTarget(
				req,
				recipe,
				targets.workerDefault,
				targets.workerProfiles,
				targets.agentBindings,
				targets.targetOrder,
				providers,
			);
			return placedInWorktree(
				writeModeInput({
					req,
					recipe,
					spec: normalizeAgentSpec(recipe),
					pathScope,
					target,
					settings,
					placement: previewNode(req),
				}),
			);
		} catch {
			return false;
		}
	}

	async function resolveLifecycle(
		req: DispatchRequest,
		settings: EffectiveSettings,
		placement: FleetPlacementPreview,
		metadataDeadlineAt: number,
		signal?: AbortSignal,
	): Promise<DispatchLifecycleStage> {
		const recipe = agents.get(req.agentId);
		if (!recipe) {
			throw new Error(`dispatch: unknown agent recipe: ${req.agentId}`);
		}
		const { spec, capabilityMismatch } = assertRecipeAdmissible(req, recipe, settings);
		const pathScope = withStoreGrantBoundaries(req, resolveDispatchPathScope(req), () => placement.node);
		publishDispatchPathScope(req, pathScope);
		const admission = resolveDispatchAdmissionStage(req, recipe, safety, pathScope);
		const targets = readWorkerTargets(settings);
		const resolveTarget = () =>
			resolveDispatchTarget(
				req,
				recipe,
				targets.workerDefault,
				targets.workerProfiles,
				targets.agentBindings,
				targets.targetOrder,
				providers,
			);
		// The route the listing serves is the one resolution would pick now, else the named target.
		const listingTargetId = (): string | null => {
			try {
				return resolveTarget().target.id;
			} catch {
				return req.target ?? null;
			}
		};
		await prepareWorkerModelListing(providers, listingTargetId, metadataDeadlineAt, signal, now);
		let target = resolveTarget();
		// Before the SDK install ask: a runtime that cannot carry the recipe's MCP
		// capabilities is refused whether or not its SDK is present.
		const mcpRuntimeRefusal = workerMcpRuntimeRefusal(req.agentId, admission.allowedTools, target.runtime);
		if (mcpRuntimeRefusal !== null) throw new Error(mcpRuntimeRefusal);
		if (target.runtime.id === "claude-sdk") {
			const operator = options?.operatorAsk;
			await ensureClaudeAgentSdk({
				...(signal ? { signal } : {}),
				// Contained yolo never waits on the install question; the dispatch is refused as it is with no operator.
				...(operator?.available() === true && !operatorContainedYolo(withLiveAutonomy(getEffectiveSettings()))
					? {
							confirm: async (question: string) => {
								const result = await operator.ask(
									[
										{
											question,
											header: "Claude SDK",
											options: [{ label: "Install now" }, { label: "Not now" }],
											defaultOption: 1,
										},
									],
									signal ? { signal } : undefined,
								);
								const answer = result.answers[0];
								return (
									!result.cancelled && (answer?.answer === "Install now" || answer?.options?.includes("Install now") === true)
								);
							},
						}
					: {}),
			});
		}
		assertWorkerContextRequest(req, target.runtime.kind === "http");
		const identity = (resolved: ResolvedTarget): string =>
			JSON.stringify([
				resolved.target.id,
				resolved.runtime.id,
				resolved.wireModelId,
				endpointIdentityHash(resolved.target.url),
			]);
		const selectedIdentity = identity(target);
		await prepareWorkerModelMetadata(providers, target.target.id, metadataDeadlineAt, signal, now);
		target = resolveTarget();
		if (identity(target) !== selectedIdentity) {
			throw new Error("dispatch: worker route changed during model metadata preparation; request a fresh admission");
		}
		enforceCapabilityGate(target.target.id, target.modelCapabilities, req.requiredCapabilities);
		const cwd = req.cwd ?? process.cwd();
		assertDenyToolsEnforceable(target.runtime, req.denyTools);
		const stage = resolveDispatchEnvelopeStage({
			req,
			recipe,
			spec,
			admission,
			target,
			settings,
			liveSettings: withLiveAutonomy(settings),
			pathScope,
			judgeSeated: options?.workerAskJudge !== undefined,
			placement,
		});
		const { envelope, permit, readOnly, judgeWithheld } = stage;
		if (envelope.write.mode === "worktree" && req.taskWorktree === undefined)
			throw new Error("dispatch: the admitted write roots need a task worktree; dispatch again with worktree: true");
		const effectiveTools = stage.tools;
		await assertStoreGrantAdmissible(req, readOnly);
		// A capability the write roots cost this run reaches the parent's dispatch result and the worker's prompt (CLI-H2).
		if (envelope.withheld.some((entry) => entry.reason === "write-roots-unconfined")) {
			context.bus.emit("run.scope_notice_raised", {
				code: "write_roots_checks_withheld",
				level: "warning",
				message:
					"[dispatch scope] Narrow write roots have neither an OS sandbox nor a task worktree binding commands to them, so bash and verify are withheld and the worker cannot run checks. Enable safety.sandbox (auto or required) with a usable bubblewrap backend where the worker runs, or dispatch from a git checkout so the run gets its own worktree.",
			});
		}
		assertPostRuntimeToolCompatibility(req.agentId, spec, envelope, target);
		assertTurnConstraintCompatibility(req, effectiveTools, target.runtime.kind === "http", agents.listSpecs());
		announceMcpSandboxNoNetwork(
			req,
			pathScope,
			envelope,
			effectiveTools,
			target,
			settings,
			admission.mcp,
			admission.mcpNetworkWithheld ?? [],
			stage.placedSandbox,
		);
		if (!judgeRoutedPermit(permit, settings)) assertMainGrantRoutable(req, target.runtime, permit);
		if (judgeWithheld !== null && req.requestOrigin !== "internal" && !judgeWithheldAnnounced) {
			judgeWithheldAnnounced = true;
			context.bus.emit("run.scope_notice_raised", {
				code: "worker_judge_withheld",
				level: "warning",
				message: `[dispatch scope] fleet.permissions.mode is judge, but ${judgeWithheld}, so workers dispatched here run with the deny permit and each ask they raise is denied. The safety judge answers worker asks in an interactive session at autonomy default with safety.judge.enabled on.`,
			});
		}
		const workerPermissionMode = workerPermissionModeForPermit(permit.allowance);
		assertRuntimeCanHonorWorkerPermissionMode(target.runtime, workerPermissionMode);
		const effectiveAdmission: DispatchAdmissionStage = {
			...admission,
			allowedTools: effectiveTools,
		};
		const hasCanonicalContext = canonicalContextAttached(target.runtime, effectiveTools);
		const personaBody = workerPersonaBody(req, recipe, hasCanonicalContext);
		const hasBoundSkills =
			hasCanonicalContext && recipe.skills !== undefined && recipe.skills.length > 0 && req.noSkills !== true;
		// A cwd owned by another repository than the session's (an outside
		// checkout, a submodule or a nested clone; not a linked worktree of the
		// session's own) takes that repository's rules, filtered by its handbook
		// trust, from the cached compile only. Every session runs from its root,
		// so the comparison is with process.cwd(): a task worktree's root is the
		// repository owning the cwd, which for a nested clone is the sister itself.
		const sister = sisterRepositoryRoot(cwd, process.cwd()) === null ? null : sisterRepositoryRules(cwd);
		const sisterNotice =
			sister === null
				? null
				: sister.rules === null
					? { code: "sister_handbook_pending" as const, message: sisterRepositoryPendingNotice(sister) }
					: { code: "sister_handbook_untrusted" as const, message: sisterRepositoryNotice(sister.rules) };
		if (sisterNotice?.message) {
			context.bus.emit("run.scope_notice_raised", {
				code: sisterNotice.code,
				level: "warning",
				message: sisterNotice.message,
			});
		}
		const compiledWorkerPrompt = await prompts.compileWorkerPrompt({
			// The handbook trust pins only the handbook files, so another repository's
			// `.pancode/rules` and project profile never enter, trusted or not.
			...(sister !== null ? { projectCustomization: "operator-only" as const } : {}),
			...(req.turnConstraints ? { turnConstraints: req.turnConstraints } : {}),
			...(readOnly ? { readOnly: true } : {}),
			providerSupportsTools: target.runtime.kind === "subprocess" ? null : targetToolCapability(target),
			toolNames: effectiveTools,
			toolPromptHints: toolPromptHintsForNames(effectiveTools, hasBoundSkills ? "bound-worker" : "worker"),
			hasCanonicalContext,
			hasBoundSkills,
			onPermission: workerPermissionMode,
			permit,
			...(req.taskWorktree !== undefined ? { taskWorktree: true } : {}),
			...(options?.workerSteering === false ? { liveSteering: false } : {}),
			persona: {
				id: `persona.${recipe.id}`,
				relPath: recipe.filepath,
				body: personaBody,
				contentHash: sha256Hex(personaBody),
				dynamic: false,
			},
			cwd,
			workingContextPaths: pathScope.workingContextPaths,
		});
		const systemPrompt = compiledWorkerPrompt.systemPrompt;
		const budgetEnvelope = resolveEffectiveWorkerBudget({
			req,
			recipeId: recipe.id,
			declared: spec.budget,
			allowedTools: effectiveTools,
			settings,
			runtime: target.runtime,
			readOnly,
		});
		// Fetch captured project context only for tiers that receive it, so
		// read-only scouts never pay the PANCODE.md read. The tier is spec policy
		// (capability-class default, recipe frontmatter override).
		const tier = sister !== null ? "bounded" : spec.projectContextTier;
		const projectPrompt =
			sister !== null
				? sisterProjectPrompt(sister.rules)
				: projectContext && tier === "bounded"
					? workerProjectPrompt(projectContext, cwd, req.protectedArtifactRemap)
					: null;
		// A delegated harness also reads its own instruction files; it gets one rule set compiled from both.
		// When that fails the run goes as it did before: the usual project message beside the harness's own files.
		const peer =
			tier === "bounded" && target.runtime.kind === "subprocess"
				? await resolvePeerInstructions({
						declared: target.runtime.repositoryInstructions,
						cwd,
						handbookSources: projectPrompt?.handbookSources ?? [],
						audience: workerHandbookAudience(spec.handbook, spec.capabilityClass),
						workingPaths: pathScope.workingContextPaths,
						maxChars: WORKER_HANDBOOK_MAX_CHARS,
						pancodeNames: pancodeOnlyNames(agents.listSpecs().map((entry) => entry.id)),
						...(req.taskWorktree !== undefined ? { taskWorktree: req.taskWorktree.path } : {}),
						// A run with no write boundary, declared (write root ".") or not, may edit the whole workspace.
						declaredPaths: [
							...(pathScope.writeBoundaries.length === 0 ? ["."] : []),
							...pathScope.workingContextPaths,
							...pathScope.writeBoundaries,
							...pathScope.inferredOnlyPaths,
						],
						keepFiles: keepsPeerInstructionFiles(settings, target.runtime),
					}).catch((error: unknown) => {
						reportDispatchDiagnostic(`compile peer instructions for ${target.runtime.id}`, error);
						return null;
					})
				: null;
		const runRole = envelope.role;
		const answerBudgetBytes = sealedAnswerBudgetBytes(req.answerBudgetBytes);
		const dynamicContext: WorkerDynamicContext = {
			ledgerAssignments: ledgerAssignmentsFor(req, pathScope),
			answerBudgetBytes,
			...(req.runWallMs !== undefined ? { wallClockMs: req.runWallMs } : {}),
			capabilityClass: spec.capabilityClass,
			agentId: recipe.id,
			...(spec.handbook !== undefined ? { handbook: spec.handbook } : {}),
			workingContextPaths: pathScope.workingContextPaths,
			cwd,
			projectContextTier: tier,
			autonomy: "default",
			...workerSandboxPromptLine(
				{
					resultContract: dispatchResultContract(req, recipe) ?? null,
					runtimeKind: target.runtime.kind,
					req,
					pathScope,
					envelope,
					settings,
				},
				stage.placedSandbox,
			),
			onPermission: workerPermissionMode,
			permit,
			...(req.taskWorktree !== undefined ? { taskWorktree: true } : {}),
			projectPrompt,
			projectReadTools:
				target.runtime.kind === "subprocess"
					? null
					: effectiveTools.includes(ToolNames.Read)
						? targetToolCapability(target)
						: false,
			projectExternalReadTools: target.runtime.kind === "subprocess",
			withheld: envelope.withheld,
			ledgerToolAvailable:
				target.runtime.kind === "http" && targetToolCapability(target) && effectiveTools.includes(ToolNames.Ledger),
			workspace: readWorkspaceRootFacts(cwd, req.taskWorktree?.root),
		};
		const composePrompt = (delivered: PeerInstructions | null): PeerPromptComposition => {
			// An overlay reaches the harness through its own file, so the message does not carry the rules twice.
			const peerHandbook = delivered?.overlay !== undefined ? "" : delivered?.text;
			const messages = buildDynamicPromptMessages(req, {
				...dynamicContext,
				...(peerHandbook !== undefined ? { peerHandbook } : {}),
			});
			const text = messages.map((message) => message.body).join("\n\n");
			const hash = promptCompositionHash([
				systemPrompt,
				text,
				...(req.contextSeed ? [req.contextSeed.provenance.contentHash] : []),
			]);
			return {
				dynamicPromptMessages: messages,
				projectContext: projectContextProvenanceFor(tier, messages, delivered),
				compiledPromptHash: hash,
				promptSignature: hash,
				dynamicHash: messages.length > 0 ? sha256Hex(text) : sha256Hex(""),
			};
		};
		const composed = composePrompt(peer);
		const peerStaleMessage =
			peer?.staleFiles !== undefined ? peerInstructionsStaleMessage(harnessLabel(target.runtime), peer.staleFiles) : null;
		const peerStale =
			peer !== null && peerStaleMessage !== null
				? { files: (peer.staleFiles ?? []).map((entry) => entry.file), stale: peer.stale, message: peerStaleMessage }
				: null;
		const { dynamicPromptMessages, compiledPromptHash, dynamicHash } = composed;
		const projectContextProvenance = composed.projectContext;
		const staticCompositionHash = promptHash(systemPrompt);
		const sessionShellHash = staticCompositionHash;
		const personaOverride = personaOverrideFor(req, staticCompositionHash);
		const currentToolSignature = toolSignatureOf(effectiveTools);
		const auth = targetRequiresAuth(target.target, target.runtime)
			? await providers.auth.resolveForTarget(target.target, target.runtime)
			: null;
		const claudeCredential =
			target.runtime.auth === "claude-cli"
				? await resolveClaudeLaunchCredential(target.target.auth, process.env, signal ? { signal } : {})
				: null;
		// pi-ai's openai-completions provider refuses to stream without an apiKey
		// even when the target is a local server that ignores Authorization headers.
		// Match chat-loop's LOCAL_API_KEY_FALLBACK so dispatch-spawned workers can
		// reach openai-compat local endpoints (LM Studio, llama.cpp) without
		// requiring the user to invent a credential.
		const apiKey =
			claudeCredential?.apiKey ??
			auth?.apiKey ??
			(auth === null && target.runtime.kind === "http" ? "pancode-local-target" : undefined);
		const authProfile =
			(claudeCredential && !claudeCredential.profile.startsWith("env:") ? claudeCredential.profile : undefined) ??
			(auth?.credentialType === "oauth" && auth.source === "stored-oauth" ? auth.providerId : undefined);
		const runtimeKind: RunKind = target.runtime.kind;
		const limitations = runtimeLimitations(runtimeKind, target.runtime.id);
		return {
			recipe,
			pathScope,
			admission: effectiveAdmission,
			target,
			cwd,
			systemPrompt,
			dynamicPromptMessages,
			compiledPromptHash,
			staticCompositionHash,
			sessionShellHash,
			dynamicHash,
			promptSignature: compiledPromptHash,
			toolSignature: currentToolSignature,
			apiKey,
			...(authProfile ? { authProfile } : {}),
			...(claudeCredential?.expiresAt !== undefined ? { credentialExpiresAt: claudeCredential.expiresAt } : {}),
			runtimeKind,
			runRole,
			answerBudgetBytes,
			agentAudience: spec.audience,
			capabilityClass: spec.capabilityClass,
			requestOrigin: requestOriginFor(req),
			runtimeLimitations: limitations,
			pipeline: pipelineProvenanceFor(req),
			briefing: briefingProvenanceFor(req),
			personaOverride,
			decisionRefs: req.decisionRefs ?? null,
			projectContext: projectContextProvenance,
			// Sealed over the compiled prompt, so the worker can prove the head it sends is the one admitted (DESIGN 4.4).
			envelope: withStaticHead(envelope, envelopeStaticHeadInput(target, systemPrompt, envelope)),
			placedSandbox: stage.placedSandbox,
			...(peerStale !== null ? { peerStale } : {}),
			...(peer?.overlay !== undefined
				? {
						peerOverlay: peer.overlay,
						peerCoexist: composePrompt({
							delivery: "coexist",
							files: peer.files,
							stale: peer.stale,
							notCarried: peer.notCarried,
							...(peer.text !== undefined ? { text: peer.text } : {}),
						}),
					}
				: {}),
			rulesApplied: compiledWorkerPrompt.rulesApplied ?? [],
			operatorProfileApplied: compiledWorkerPrompt.operatorProfileApplied ?? false,
			capabilityMismatch,
			readOnly,
			permit,
			budget: workerBudgetFromEnvelope(budgetEnvelope),
			budgetEnvelope,
			...(settings ? { settings } : {}),
		};
	}

	/**
	 * Contains a finalization that threw (a worker promise rejection, a ledger or persist failure). Without it the
	 * run row stays "running" forever, no receipt or terminal event exists, and the active entry leaks until restart.
	 */
	async function failFinalization(
		run: FinalizingRun,
		state: {
			ledger: Ledger;
			envelope: RunEnvelope;
			runJournal: RunTelemetryJournal | undefined;
			terminal: ResolvedTerminalReason | undefined;
			timing: RunPhaseMarks;
		},
		error: unknown,
	): Promise<void> {
		const { ledger: ledgerRef, envelope } = state;
		reportDispatchDiagnostic(`finalize run ${envelope.id}`, error);
		// The journal still ends with how the worker loop ended, so no reader waits on this run (#425, #434).
		const endedAt = new Date().toISOString();
		state.timing.endedAt = endedAt;
		const detail = `finalization failure: ${error instanceof Error ? error.message : String(error)}`;
		state.runJournal
			?.settle(
				settleUnfinishedRun(ledgerRef.get(envelope.id) ?? envelope, {
					terminal: state.terminal,
					outcome: "failed",
					detail,
					endedAt,
					processExitCode: null,
				}),
			)
			.catch((settleError: unknown) => reportDispatchDiagnostic(`settle run ${envelope.id}`, settleError));
		try {
			ledgerRef.update(envelope.id, {
				status: "failed",
				outcome: "failed",
				outcomeDetail: detail,
				endedAt,
				exitCode: 1,
			});
			await ledgerRef.persist();
		} catch (ledgerError) {
			reportDispatchDiagnostic(`persist failed row for run ${envelope.id}`, ledgerError);
		}
		active.delete(envelope.id);
		settleAssignmentDurablyWithoutReceipt(run.lineage.rootRunId, envelope.id);
		recordTargetOutcome(envelope.id, run.targetId, run.runtimeId, run.wireModelId, "failed", 1, "internal");
		context.bus.emit("run.failed", {
			runId: envelope.id,
			agentId: run.req.agentId,
			task: run.req.task,
			...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
			requestOrigin: run.requestOrigin,
			targetId: run.targetId,
			wireModelId: run.wireModelId,
			runtimeId: run.runtimeId,
			runtimeKind: run.runtimeKind,
			outcome: "failed" satisfies RunOutcome,
			outcomeDetail: detail,
			reason: "failed",
			lineage: publishedLineage(run.lineage, run.hostRun),
			exitCode: 1,
		});
	}

	async function dispatchAcpDelegation(
		req: DispatchRequest,
		settings: EffectiveSettings,
		timing: RunPhaseMarks,
		routeDecision: RouteDecisionV1,
		probeClaims: ProbeClaim[],
		observer?: DispatchAdmissionObserver,
		hostRun?: DispatchPreparationOptions["hostRun"],
		signal?: AbortSignal,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunResult>;
	}> {
		const lifecycle = resolveAcpDelegationLifecycle(
			{ ledgerAssignmentsFor, maybeAgents, projectContext, safety },
			req,
			settings,
		);
		const estimate = workerToolCallHardCap(settings);
		const budgetEnvelope = resolveToolBudgetEnvelope({
			recipeId: req.agentId,
			policy: { toolCalls: estimate, synthesis: true },
			...(req.budget === undefined ? {} : { request: req.budget }),
			hardCap: estimate,
			retry: (req.lineage?.attempt ?? 0) > 0,
			revision: false,
			enforcement: "external-one-shot",
		});
		publishDispatchPathScope(req, lifecycle.pathScope);
		req = withoutDelegationStandInModel(req, lifecycle.agentConfig.id);
		// continue_run (Phase 3.2): judged before the run takes a slot, so a refusal costs nothing.
		const continuation =
			req.continueRunId === undefined
				? null
				: resolveAcpContinuation({
						runId: req.continueRunId,
						row: requireLedger().get(req.continueRunId),
						agentId: req.agentId,
						ownerSessionId: req.ownerSessionId ?? null,
					});
		const targetId = `delegation:${lifecycle.agentConfig.id}`;
		const runtimeId = "acp";
		const wireModelId = req.model ?? lifecycle.agentConfig.id;
		assertTargetNotCoolingDown(req, targetId, runtimeId, wireModelId, probeClaims);

		if (req.contextSeed) persistWorkerContextSeed(req.contextSeed);
		// ACP delegation has no pricing, so `run --require-priced` refuses it here and the model hears why.
		const delegationUnpriced = requirePricedRefusal("none", `${targetId}/${wireModelId}`);
		if (delegationUnpriced !== undefined) throw new Error(`dispatch: admission denied: ${delegationUnpriced}`);
		await assertBudgetAdmitsRoute(req, { rates: null, pricedBy: "none" }, settings, lifecycle);

		const queuedIdentity =
			req.lineage === undefined && req.runIdHint !== undefined
				? {
						runId: req.runIdHint,
						sessionId: req.ownerSessionId ?? null,
						agentId: req.agentId,
						task: req.task,
						requestOrigin: lifecycle.requestOrigin,
						targetId,
						wireModelId,
						runtimeId,
						runtimeKind: "acp-delegation" as const,
					}
				: null;
		if (queuedIdentity !== null) publishCapacityQueued(queuedIdentity, timing, null);
		let capacityLease: Awaited<ReturnType<typeof admitAssignmentCapacity>>;
		try {
			// The tool's abort signal reaches the queue, so a delegation waiting for
			// a slot can be canceled like a native one.
			capacityLease = await admitAssignmentCapacity(req, "local", timing, null, signal);
		} catch (error) {
			if (queuedIdentity !== null) publishCapacityAdmissionFailure(queuedIdentity, error);
			throw error;
		} finally {
			if (queuedIdentity !== null) pendingCapacity.delete(queuedIdentity.runId);
		}
		const leaseSlot = createLeaseSlotGuard(capacityAdmission, capacityLease.leaseId, req.lineage !== undefined);

		// Resolve the ledger before starting the ACP process: an external agent
		// must never outlive a failure to create its tracking row.
		const ledgerRef = (() => {
			try {
				return requireLedger();
			} catch (error) {
				leaseSlot.release();
				if (req.lineage === undefined)
					persistAssignment(failQueuedAssignment(capacityLease.assignmentId), `${capacityLease.assignmentId}:admission`);
				throw error;
			}
		})();
		const telemetryContext = req.runIdHint
			? {
					sessionId: req.ownerSessionId ?? null,
					runId: req.runIdHint,
					agent: workerAgent(req.runIdHint),
					...(req.lineage?.parentRunId ? { parentRunId: req.lineage.parentRunId } : {}),
				}
			: undefined;
		const callUsage = telemetryContext ? createRunCallUsage(telemetryContext) : undefined;
		let runJournal: RunTelemetryJournal | undefined;
		let parentJournal: TelemetrySessionLease | undefined;
		// How the worker loop ended, once known; a failed finalization still settles the run journal with it.
		let resolvedTerminal: ResolvedTerminalReason | undefined;
		const closeRunJournal = async () => {
			try {
				await runJournal?.close();
			} finally {
				await parentJournal?.release();
			}
		};
		if (telemetryContext) {
			try {
				runJournal = await openRunTelemetry(
					telemetryContext,
					telemetryRunDirectory(pancodeStateDir(), telemetryContext.runId),
				);
				if (req.ownerSessionId && req.ownerSessionCwdHash) {
					parentJournal = await context
						.getContract("telemetry")
						?.acquireTelemetrySession?.({ id: req.ownerSessionId, cwdHash: req.ownerSessionCwdHash }, telemetryContext.agent);
					if (parentJournal) runJournal.linkSession(parentJournal.context);
				}
			} catch (error) {
				reportDispatchDiagnostic("open ACP run telemetry journal", error);
			}
		}
		let acp: AcpDelegationRunHandle;
		// A peer's fixed-choice question (agy interaction_*) goes to a person through the operator's ask surface, the TUI
		// card or an ACP client's interview, under the same gate as worker asks: nobody attached, contained yolo, or
		// fleet.permissions.mode deny or fail answers it cancelled. Only the operator's own pick goes back.
		let peerQuestionsOpen = 0;
		const askPeerQuestion = async (question: AcpPeerQuestion, questionSignal: AbortSignal): Promise<string | null> => {
			const operator = options?.operatorAsk;
			if (operator === undefined || !operator.available()) return null;
			const live = withLiveAutonomy(getEffectiveSettings());
			if (operatorContainedYolo(live)) return null;
			const mode = live?.fleet.permissions.mode;
			if (mode === "deny" || mode === "fail") return null;
			// Labels are what the card returns, so a repeated one is told apart by its optionId, and by a counter when that
			// suffix is itself another option's label; no option is dropped.
			const byLabel = new Map<string, string>();
			for (const option of question.options) {
				let label = option.label;
				for (let n = 1; byLabel.has(label); n++)
					label = n === 1 ? `${option.label} (${option.optionId})` : `${option.label} (${option.optionId} ${n})`;
				byLabel.set(label, option.optionId);
			}
			const warning = question.securityWarning !== undefined ? `\n\nSecurity warning: ${question.securityWarning}` : "";
			const asked: AskUserQuestion = {
				question: `${req.agentId} asks: ${question.question}${warning}`,
				header: "Delegated agent",
				options: [...byLabel.keys()].map((label) => ({ label })),
				fixedChoices: true,
				operator_only: true,
			};
			peerQuestionsOpen += 1;
			try {
				// A harness card, as the merge card asks: the run's end dismisses it, Esc answers only it, and nothing enters
				// the main transcript. A screen another card holds is retried until it frees or the run ends.
				let result: AskUserResult;
				for (;;) {
					if (questionSignal.aborted || !operator.available()) return null;
					result = await operator.ask([asked], { origin: "harness", signal: questionSignal });
					if (questionSignal.aborted) return null;
					if (result.unavailable !== true) break;
					await new Promise<void>((resolve) => {
						const settle = (): void => {
							clearTimeout(wake);
							questionSignal.removeEventListener("abort", settle);
							resolve();
						};
						const wake = setTimeout(settle, PEER_QUESTION_SCREEN_RETRY_MS);
						wake.unref?.();
						questionSignal.addEventListener("abort", settle, { once: true });
						if (questionSignal.aborted) settle();
					});
				}
				const answer = result.answers[0];
				if (result.cancelled === true || answer === undefined || answer.auto === true) return null;
				return byLabel.get(answer.options?.[0] ?? answer.answer) ?? null;
			} finally {
				peerQuestionsOpen -= 1;
			}
		};
		try {
			let environment: Record<string, string> | undefined;
			let credentialExpiresAt: number | undefined;
			if (isBuiltinClaudeAcp(lifecycle.agentConfig)) {
				const selected = { ...claudeAuthEnvironment(), ...lifecycle.agentConfig.env };
				const credential = await resolveClaudeLaunchCredential(undefined, selected);
				environment = withClaudeCredential(selected, credential?.apiKey) as Record<string, string>;
				credentialExpiresAt = credential?.expiresAt;
			}
			acp = startAcpRun({
				...(telemetryContext
					? {
							telemetry: {
								context: telemetryContext,
								target: {
									targetId,
									runtimeId,
									api: "acp",
									requestedModel: req.model ?? wireModelId,
									reportedModel: { kind: "unknown" as const, reason: "not-observed" as const },
								},
							},
						}
					: {}),
				agent: lifecycle.agentConfig,
				...(environment ? { environment } : {}),
				...(credentialExpiresAt !== undefined ? { credentialExpiresAt } : {}),
				task: req.task,
				...(req.model !== undefined ? { model: req.model } : {}),
				...(req.thinkingLevel !== undefined ? { thinkingLevel: req.thinkingLevel } : {}),
				systemPrompt: lifecycle.systemPrompt,
				dynamicPromptMessages: lifecycle.dynamicPromptMessages,
				cwd: lifecycle.cwd,
				safety,
				...(req.readOnly === true ? { readOnly: true } : {}),
				clientVersion: readPancodeVersion(),
				now,
				monotonicNow,
				askPeerQuestion,
				...(continuation?.kind === "reopen" ? { reopen: { sessionId: continuation.acpSessionId } } : {}),
			});
		} catch (error) {
			await closeRunJournal();
			leaseSlot.release();
			if (req.lineage === undefined) await failQueuedAssignment(capacityLease.assignmentId);
			throw error;
		}
		timing.workerSpawnedAt = new Date(now()).toISOString();

		const tokenMeter: RunTokenMeter = {};
		const safetyDecisionCounts = { allowed: 0, blocked: 0, guardBlocked: 0, permissionRequested: 0 };
		const blockedAttempts: SafetyBlockedAttempt[] = [];
		const guardBlockedAttempts: SafetyBlockedAttempt[] = [];
		const permissionRequestedAttempts: SafetyBlockedAttempt[] = [];
		const toolStats = new Map<string, ToolCallStat>();
		const inFlightTools = new Map<string, number>();
		let toolTelemetryIngestionErrors = 0;
		const upstreamResponses: RunResultUpstreamResponse[] = [];
		const finishContractEntries: unknown[] = [];
		let finishContractAssistantText = "";
		let finishContractAssistantTurnId: string | null = null;
		let failureMessage: string | undefined;
		let outcomeCode: RunOutcomeCode | null = null;
		let reportedSpoofedOutcome = false;
		let runIdForPermissionAudit: string | null = null;
		// Steering provenance as a native run keeps it: one entry per message the peer took as another prompt, closed
		// once the peer answers that prompt; the prose itself is never kept.
		const steeringProvenance: RunSteeringProvenance[] = [];
		let steeringProvenanceClosed = false;
		const outputCapture = createWorkerOutputCapture({
			maxBytes: workerOutputCaptureBytes(
				dispatchResultContract(req, req.agentId && maybeAgents ? maybeAgents.getSpec(req.agentId) : null),
			),
		});
		const foldAcpEvent = (raw: unknown): void => {
			if (isRecord(raw) && raw.type === "pancode_telemetry") {
				runJournal?.worker(raw);
				if (callUsage && !callUsage.observe(raw)) callUsage.gap();
				const usage = callUsage?.snapshot();
				if (usage) {
					tokenMeter.usage = usage;
					stopRunsAtCostCeiling();
				}
				return;
			}
			outputCapture.observe(raw);
			const event = raw as {
				type?: string;
				message?: {
					role?: string;
					usage?: unknown;
					failure?: unknown;
					model?: unknown;
					responseModelIdObservation?: unknown;
					responseModel?: unknown;
					responseId?: unknown;
					stopReason?: unknown;
					errorMessage?: unknown;
				};
				payload?: {
					callIndex?: number;
					model?: unknown;
					responseModel?: unknown;
					responseId?: unknown;
					usage?: unknown;
					tool?: string;
					posture?: string;
					durationMs?: number;
					outcome?: "ok" | "error" | "blocked";
					decision?: "allowed" | "blocked" | "permission_requested";
					actionClass?: string;
					ruleId?: string;
					reasonCode?: string;
					policySource?: string;
					reason?: string;
					requestId?: string;
					mode?: "deny" | "fail" | "escalate";
					source?: "operator" | "timeout" | "policy" | "remembered";
					sequence?: unknown;
				};
			};
			if (event.type === "pancode_steer_received" && !steeringProvenanceClosed) {
				const pending = steeringProvenance.find(
					(entry) => entry.sequence === event.payload?.sequence && !entry.acknowledged,
				);
				if (pending !== undefined) {
					pending.acknowledged = true;
					pending.acknowledgedAt = new Date().toISOString();
				}
			}
			if (event.type === "pancode_tool_start" && event.payload && typeof event.payload.tool === "string") {
				recordToolStart(inFlightTools, event.payload);
			}
			// ACP is an external protocol peer, never an authority for PanCode's
			// deterministic terminal taxonomy. Ignore even syntactically valid
			// assertions; only a future coordinator-side classifier may set one.
			if (event.type === "pancode_run_outcome" && !reportedSpoofedOutcome) {
				reportedSpoofedOutcome = true;
				reportDispatchDiagnostic("ACP outcome event", new Error("ignored untrusted pancode_run_outcome assertion"));
			}
			if (isRecord(event)) {
				const finishEntry = appendDispatchFinishContractEntry(finishContractEntries, event);
				if (finishEntry !== null) {
					finishContractAssistantText = finishEntry.assistantText;
					finishContractAssistantTurnId = finishEntry.assistantTurnId;
				}
			}
			foldModelCallEvent(event, upstreamResponses);
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const errorMessage = foldAssistantCall(event.message, tokenMeter, upstreamResponses, null);
				if (errorMessage !== null) failureMessage = errorMessage;
			}
			if (event.type === "pancode_permission_resolved" && event.payload && typeof event.payload.tool === "string") {
				const requestId =
					typeof event.payload.requestId === "string" ? event.payload.requestId : `delegation-permission-${Date.now()}`;
				const origin = runIdForPermissionAudit !== null ? `delegation:${runIdForPermissionAudit}` : "delegation:unknown";
				const actionClass = typeof event.payload.actionClass === "string" ? event.payload.actionClass : "unknown";
				const reason =
					typeof event.payload.reason === "string" ? event.payload.reason : `${event.payload.tool} requires approval`;
				emitApproval(context.bus, "approval.requested", {
					tool: event.payload.tool,
					actionClass,
					requestId,
					...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
					origin,
					requestedBy: runIdForPermissionAudit ?? undefined,
					rejection: { short: reason, detail: reason, hints: [] },
				});
				emitApproval(context.bus, "approval.resolved", {
					status: "denied",
					tool: event.payload.tool,
					requestId,
					...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
					origin,
					decidedBy: "policy:no-operator",
					actionClass,
					reason,
					...(runIdForPermissionAudit !== null ? { requestedBy: runIdForPermissionAudit } : {}),
				});
			}
			if (event.type === "pancode_tool_finish" && event.payload && typeof event.payload.tool === "string") {
				recordToolCompletion(inFlightTools, event.payload);
				recordToolFinish(toolStats, event.payload);
				foldToolDecision(
					event.payload,
					event.payload.tool,
					safetyDecisionCounts,
					blockedAttempts,
					guardBlockedAttempts,
					permissionRequestedAttempts,
				);
			}
		};

		// The ACP process is already live; any failure to establish its tracking
		// row must not leave an orphaned agent holding a concurrency slot.
		let envelope!: RunEnvelope;
		let runningRowPersisted: Promise<void> = Promise.resolve();
		let lineage!: RunLineage;
		let identity!: ReturnType<typeof detectRunIdentity>;
		try {
			envelope = ledgerRef.create({
				projection: runLedgerProjection(req, lifecycle.pathScope),
				...(req.runIdHint !== undefined ? { id: req.runIdHint } : {}),
				agentId: req.agentId,
				executionRole: withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0),
				requestOrigin: lifecycle.requestOrigin,
				...rootOriginFields(req),
				task: req.task,
				...(req.intent !== undefined ? { intent: structuredClone(req.intent) } : {}),
				targetId,
				wireModelId,
				runtimeId,
				runtimeKind: "acp-delegation",
				timing,
				sessionId: req.ownerSessionId ?? null,
				cwd: lifecycle.cwd,
				sessionShellHash: lifecycle.sessionShellHash,
				dynamicHash: lifecycle.dynamicHash,
				promptSignature: lifecycle.promptSignature,
				toolSignature: lifecycle.toolSignature,
			});
			if (req.record === true)
				ledgerRef.update(envelope.id, { recording: recordingJournal.start(envelope.id, LOCAL_RUN_NODE) });
			runIdForPermissionAudit = envelope.id;
			lineage = lineageFor(req, envelope.id);
			if (req.lineage === undefined) {
				if (capacityLease.assignmentId !== lineage.rootRunId) {
					capacityAdmission.rename(capacityLease.leaseId, lineage.rootRunId);
					await renameStoredAssignment(capacityLease.assignmentId, lineage.rootRunId);
				}
				leaseSlot.transferToAssignment();
			}
			identity = detectRunIdentity();
			ledgerRef.update(envelope.id, {
				budget: budgetEnvelope,
				status: "running",
				pid: acp.pid,
				heartbeatAt: heartbeatIso(acp.heartbeatAt),
				lineage: publishedLineage(lineage, hostRun),
				identity,
				node: LOCAL_RUN_NODE,
				...(lifecycle.pipeline ? { pipeline: lifecycle.pipeline } : {}),
				...(lifecycle.briefing ? { briefing: lifecycle.briefing } : {}),
				...(req.contextSeed ? { workerContext: structuredClone(req.contextSeed.provenance) } : {}),
				...(req.gate !== undefined ? { gate: req.gate } : {}),
				...(req.council !== undefined ? { council: req.council } : {}),
				...(req.plan !== undefined ? { plan: req.plan } : {}),
				...(lifecycle.personaOverride ? { personaOverride: lifecycle.personaOverride } : {}),
				...(lifecycle.decisionRefs ? { decisionRefs: lifecycle.decisionRefs } : {}),
			});
			observer?.onAdmitted({
				runId: envelope.id,
				pid: acp.pid,
				runtimeKind: "acp-delegation",
			});
			// One durable write at start so sibling processes (pancode fleet status)
			// can observe the running row; finalization persists the terminal state.
			// Awaited only after `active` holds the run: an fsync wait here kept a
			// spawned retry out of `active`, so snapshot and abort could not see it.
			// A failed write leaves the row dirty for the terminal persist (#428).
			runningRowPersisted = persistLedgerInBackground(ledgerRef, envelope.id);
			if (req.lineage !== undefined) {
				context.bus.emit(
					"run.enqueued",
					{
						runId: envelope.id,
						sessionId: req.ownerSessionId ?? null,
						agentId: req.agentId,
						task: req.task,
						requestOrigin: lifecycle.requestOrigin,
						targetId,
						wireModelId,
						runtimeId,
						runtimeKind: "acp-delegation",
					},
					runJournal?.context,
				);
			}
			context.bus.emit(
				"run.started",
				{
					budget: budgetEnvelope,
					runId: envelope.id,
					sessionId: req.ownerSessionId ?? null,
					agentId: req.agentId,
					task: req.task,
					requestOrigin: lifecycle.requestOrigin,
					...rootOriginFields(req),
					...routeMoveFields(req, targetId, wireModelId),
					targetId,
					wireModelId,
					runtimeId,
					runtimeKind: "acp-delegation",
					pid: acp.pid,
					processCommand: JSON.stringify([lifecycle.agentConfig.command, ...(lifecycle.agentConfig.args ?? [])]),
					assignmentId: lineage.rootRunId,
					attempt: lineage.attempt,
					...(req.parentToolCallId !== undefined ? { parentToolCallId: req.parentToolCallId } : {}),
				},
				runJournal?.context ?? sinklessRunContext(envelope.id, req.ownerSessionId),
			);
		} catch (error) {
			// A capture started above would otherwise keep its manifest at "recording".
			if (envelope !== undefined) recordingJournal.terminal(envelope.id, "failed");
			try {
				acp.kill();
			} catch (killError) {
				reportDispatchDiagnostic("kill orphaned ACP agent after ledger failure", killError);
			}
			await closeRunJournal();
			leaseSlot.release();
			throw error;
		}

		// Domain-owned ingestion starts here, whether or not any external
		// consumer ever iterates the returned stream: meters, tool stats, finish
		// contract state, permission audit events, and output capture fold in
		// the pump; consumers get a bounded replay tee.
		const eventPump = startDispatchEventPump(acp.events, foldAcpEvent, {
			onEvent: (event) => {
				if (isRecord(event) && event.type === "heartbeat") return;
				context.bus.emit("run.progressed", {
					runId: envelope.id,
					agentId: req.agentId,
					task: req.task,
					requestOrigin: lifecycle.requestOrigin,
					targetId,
					wireModelId,
					runtimeId,
					runtimeKind: "acp-delegation",
					event,
				});
			},
			onError: (error) => {
				toolTelemetryIngestionErrors += 1;
				reportDispatchDiagnostic(`ingest events for run ${envelope.id}`, error);
			},
		});

		const startedAt = envelope.startedAt;
		// A peer that takes guidance as another prompt (agy 1.5.0 and later) gets a steer, recorded like a native one.
		const steerAcp =
			(send: (text: string) => boolean) =>
			(text: string): boolean => {
				const canonicalText = text.trim();
				if (steeringProvenanceClosed || canonicalText.length === 0 || !send(canonicalText)) return false;
				steeringProvenance.push({
					sequence: steeringProvenance.length + 1,
					bytes: Buffer.byteLength(canonicalText, "utf8"),
					contentHash: sha256Hex(canonicalText),
					sentAt: new Date().toISOString(),
					acknowledged: false,
				});
				return true;
			};
		let resolveFinal!: (receipt: RunResult) => void;
		let rejectFinal!: (error: unknown) => void;
		const finalPromise = new Promise<RunResult>((res, rej) => {
			resolveFinal = res;
			rejectFinal = rej;
		});
		const activeRun: ActiveRun = {
			budget: budgetEnvelope,
			runId: envelope.id,
			req,
			abort: acp.abort,
			kill: acp.kill,
			...(acp.steer !== undefined ? { steer: steerAcp(acp.steer) } : {}),
			promise: acp.promise.then(
				() => undefined,
				() => undefined,
			),
			recipe: null,
			startedAt,
			timing,
			targetId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
			requestOrigin: lifecycle.requestOrigin,
			agentId: req.agentId,
			task: req.task,
			cwd: lifecycle.cwd,
			node: null,
			aborted: false,
			abortDetail: null,
			abortCause: null,
			stallKilled: false,
			stallTimeoutMs: lifecycle.agentConfig.stallTimeoutMs ?? DEFAULT_ACP_STALL_TIMEOUT_MS,
			peerQuestionOpen: () => peerQuestionsOpen > 0,
			// ACP delegation is admitted as unpriced.
			budgetExempt: true,
			lineage,
			...(hostRun === undefined ? {} : { hostRun }),
			heartbeatAt: acp.heartbeatAt,
			heartbeatStatus: "alive",
			meter: tokenMeter,
			finalPromise,
		};

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
			const finalFailureMessage = result.failureMessage ?? failureMessage;
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
				outcomeCode,
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
				effectiveFailover: failoverModeFor(req),
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
						ingestionErrors: toolTelemetryIngestionErrors,
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
					toolTelemetryIngestionErrors += 1;
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
						assistantText: finishContractAssistantText,
						assistantTurnId: finishContractAssistantTurnId,
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
				steeringProvenanceClosed = true;
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
				outcomeCode = graded.outcomeCode;
				if (graded.messageChanged && graded.detail !== null) failureMessage = graded.detail;
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
					outcomeCode = graded.outcomeCode;
					if (graded.messageChanged && graded.detail !== null) failureMessage = graded.detail;
				}
				if (req.taskWorktree !== undefined && worktreeReceipt === undefined) {
					worktreeReceipt = snapshotUnappliedTaskWorktree(req.taskWorktree, req.apply ?? "merge");
					// An already failed run whose HEAD also moved says so, so the
					// operator knows the preserved branch lacks the work (F5).
					if (worktreeReceipt.detail !== undefined) {
						finalDetail = [finalDetail, worktreeReceipt.detail].filter(Boolean).join("; ");
						failureMessage = finalDetail;
					}
				}
				const status = runStatusForOutcome(finalOutcome);
				const classifiedResult: SpawnedWorkerResult = {
					exitCode: result.exitCode,
					signal: null,
					...(failureMessage ? { stderrTail: failureMessage } : {}),
				};
				const failureClass = classifyFailure(evidence, classifiedResult, finalOutcome, outcomeCode);
				const contextOverflow = isContextOverflowFailure(failureClass, classifiedResult, outcomeCode);
				const receiptDraft = buildReceiptDraft(
					result,
					endedAt,
					status,
					finalOutcome,
					finalDetail,
					capturedOutput,
					steering,
				);
				receiptDraft.verdict = {
					version: 1,
					obligation: gradeContract.obligation,
					rules: graded.rules,
					assurance: receiptAssurance(receiptDraft),
				};
				const terminal = resolveRunTerminalReason(evidence, outcomeCode);
				resolvedTerminal = terminal;
				Object.assign(receiptDraft, runSettlementReceiptFields(terminal, callUsage?.snapshot()));
				worktreeReceipt = sealTaskWorktreeReceipt({ context }, req, envelope.id, worktreeReceipt, accounted, receiptDraft);
				const ledgerPatch: Partial<RunEnvelope> = {
					status,
					outcome: finalOutcome,
					outcomeCode,
					outcomeDetail: finalDetail,
					endedAt,
					exitCode: receiptDraft.exitCode,
					sessionId: receiptDraft.sessionId,
					spend: receiptDraft.spend,
					spendSums: receiptDraft.spendSums,
					...(steering.length > 0 ? { steering: steering.map((entry) => ({ ...entry })) } : {}),
					sessionShellHash: receiptDraft.sessionShellHash ?? null,
					dynamicHash: receiptDraft.dynamicHash ?? null,
					heartbeatAt: heartbeatIso(acp.heartbeatAt),
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
				active.delete(envelope.id);
				recordTargetOutcome(envelope.id, targetId, runtimeId, wireModelId, status, receipt.exitCode, failureClass);
				accumulateFinalizedTotals(receipt);
				// A terminal event's readers show the sealed record, so the seal lands first with the feed's last rows in it.
				journalBridge?.closeFeed(finalOutcome, receipt.outcomeDetail, {
					runId: envelope.id,
					agentId: req.agentId,
					exitCode: receipt.exitCode,
				});
				await closeRunJournal();
				emitTerminalDispatchEvent({ context }, finalizing, receipt, finalOutcome);
				completeAssignmentAttempt(
					activeRun,
					receipt,
					finalOutcome,
					receipt.outcomeDetail ?? finalDetail,
					failureClass,
					contextOverflow,
				);
				return receipt;
			} catch (error) {
				await failFinalization(
					finalizing,
					{ ledger: ledgerRef, envelope, runJournal, terminal: resolvedTerminal, timing },
					error,
				);
				throw error;
			} finally {
				// A terminal seal that did not land fails the run, after its slot is released (#434).
				try {
					await closeRunJournal();
				} finally {
					leaseSlot.release();
				}
			}
		})().then(resolveFinal, rejectFinal);
		active.set(envelope.id, activeRun);
		stopIfCapacityLost(envelope.id, capacityLease.leaseId);
		watchAssignmentDeadline(activeRun);
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

	async function dispatchAttempt(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	): ReturnType<typeof admitDispatchAttempt> {
		const probeClaims: ProbeClaim[] = [];
		try {
			return await admitDispatchAttempt(req, probeClaims, observer, preparation, settlement);
		} catch (error) {
			// A half-open route admitted this dispatch as its probe, but the run never
			// started. Without the release the route would wait on a probe outcome
			// that cannot arrive.
			for (const claim of probeClaims) targetBreaker.release(claim.key, claim.owner);
			throw error;
		}
	}

	async function admitDispatchAttempt(
		req: DispatchRequest,
		probeClaims: ProbeClaim[],
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunResult>;
		effectiveRequest: DispatchRequest;
	}> {
		const hostRun = preparation?.hostRun;
		const requestedAt = new Date(now()).toISOString();
		const timing: RunPhaseMarks = { requestedAt };
		const settings = getEffectiveSettings();
		const isAcpAgent = settings?.integrations.externalAgents?.entries?.some((entry) => entry.id === req.agentId) ?? false;
		if (isAcpAgent && !req.delegationAgentId) {
			req.delegationAgentId = req.agentId;
		}

		const validation = routeValidationProjection(req);
		const validated = validateJobSpec(validation.jobSpec);
		if (!validated.ok) {
			throw new Error(`dispatch: invalid spec: ${validated.errors.join("; ")}`);
		}
		req = validation.restore(validated.spec);
		if (req.externalReadRoot !== undefined) {
			const approval = req.externalReadApproval;
			if (
				!externalReadShapeAdmissible(req, agents.getSpec(req.agentId)) ||
				approval === undefined ||
				approval.root !== req.externalReadRoot ||
				approval.runId !== req.runIdHint
			)
				throw new Error(EXTERNAL_READ_APPROVAL_REQUIRED);
		}
		// Admission never awaits a decision model. Routing classifies the task
		// with the rules, always: a dispatch is the main agent's call, and a
		// decision model that could delay it by up to 3s, or change its route,
		// would be deciding on the agent's behalf.
		// Every attempt needs its identity before spawning so worker telemetry
		// uses the same run id as the eventual ledger row (#434). Top-level runs wait for
		// capacity. The board can then render the assignment as queued and the
		// same id becomes the ledger row once its slot opens.
		if (req.runIdHint === undefined) req = { ...req, runIdHint: newRunId() };
		let activeRouteObservation: RouteObservationHandle | null = null;
		if (req.delegationAgentId === undefined) {
			const recipe = agents.get(req.agentId);
			const activation = consumeActiveRouteApproval({
				request: req,
				settings: settings?.fleet.adaptiveRouting,
				capabilityClass: recipe === null ? null : normalizeAgentSpec(recipe).capabilityClass,
				failover: failoverModeFor(req),
				requestedAt,
				observe: (request, decision) => routeObserver.observe(routeObservationInput(request, decision)),
			});
			if (activation !== null) {
				req = activation.request;
				activeRouteObservation = activation.observation;
			}
		}
		const protectedArtifactState = protectedArtifactStateForRequest(getProtectedArtifactState(), req);

		let routeObservation: RouteObservationHandle;
		const attachRouteObservation = <T extends { finalPromise: Promise<RunResult> }>(handle: T): T => {
			const observation = routeObservation;
			handle.finalPromise
				.then((receipt) => {
					const envelope = ledger?.get(receipt.runId);
					const phases = envelope ? deriveEnvelopePhaseDurations(envelope) : undefined;
					if (envelope === null || envelope === undefined) return;
					const outcome = receipt.outcome ?? (receipt.exitCode === 0 ? "succeeded" : "failed");
					const run = routeQualityRun(receipt);
					const quality = reduceRouteQuality({ subject: run, runs: [run] });
					routeObserver.recordOutcome(observation.id, {
						route: observation.decision.executedRoute,
						outcome,
						qualityLabel: quality.label,
						firstPass: outcome === "succeeded" && (receipt.lineage?.attempt ?? 0) === 0,
						attempt: receipt.lineage?.attempt ?? 0,
						costUsd: factKnownValue(receipt.spendSums.usd),
						endToEndMs: phases?.totalEndToEndMs ?? 0,
						receipt,
						quality,
						phaseTiming: phases,
					});
				})
				.catch(() => {});
			return handle;
		};
		if (req.continueRunId !== undefined && !req.delegationAgentId)
			throw new Error(
				`dispatch: continue_run continues an ACP delegation's peer session; '${req.agentId}' is not an ACP agent`,
			);
		if (req.delegationAgentId) {
			assertAcpDelegationAdmissible(req, req.delegationAgentId, protectedArtifactState);
			await rebindReservationSlot(req, "local", null, UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD, settings);
			routeObservation = observeShadowRoute(req, undefined, settings);
			const delegated = await dispatchAcpDelegation(
				req,
				settings,
				timing,
				routeObservation.decision,
				probeClaims,
				observer,
				hostRun,
				preparation?.signal,
			);
			// An ACP member never runs host verification, so it can only ever leave
			// the barrier. It still edits the checkout, so the barrier has to wait
			// for it; dispatch() releases it when its finalPromise settles.
			settlement?.live(delegated.runId);
			return attachRouteObservation({ ...delegated, effectiveRequest: req });
		}

		req =
			routeAroundCoolingTarget(
				{ agents, cooldownKey, failoverModeFor, providers, routeCandidates, targetBreaker, targetCooldownReason },
				req,
				settings,
			) ?? req;
		const metadataDeadlineAt =
			req.assignmentDeadlineAt ?? Date.parse(requestedAt) + (req.routingIntent?.deadlineMs ?? 60_000);
		const admittedPlacement = previewNode(req);
		const lifecycle = await resolveLifecycle(req, settings, admittedPlacement, metadataDeadlineAt, preparation?.signal);
		preparation?.signal?.throwIfAborted();
		assertResponseSchemaEnforceable(
			lifecycle.target.runtime,
			lifecycle.target.modelCapabilities,
			req.responseSchema,
			lifecycle.admission.allowedTools.length,
		);
		assertTargetNotCoolingDown(
			req,
			lifecycle.target.target.id,
			lifecycle.target.runtime.id,
			lifecycle.target.wireModelId,
			probeClaims,
		);

		// `run --require-priced` (SPEC 6.9): the resolved route, including a model named for this dispatch only.
		const routeUnpriced = requirePricedRefusal(
			lifecycle.target.effectivePricing.pricedBy,
			`${lifecycle.target.target.id}/${lifecycle.target.wireModelId}`,
		);
		if (routeUnpriced !== undefined) throw new Error(`dispatch: admission denied: ${routeUnpriced}`);
		await assertNoFreshQuotaDenial(
			lifecycle.target.target,
			lifecycle.target.runtime,
			`${lifecycle.target.target.id}/${lifecycle.target.wireModelId}`,
		);
		await assertBudgetAdmitsRoute(req, lifecycle.target.effectivePricing, settings, lifecycle, preparation?.signal);

		const placement = resolveNode(req) ?? null;
		const actualNode = placement?.node ?? { id: "local", kind: "local" };
		assertPlannedNodeIdentity(req, actualNode);
		if (
			!isDeepStrictEqual(actualNode, admittedPlacement.node) ||
			(actualNode.kind === "ssh" &&
				lifecycle.runtimeKind === "http" &&
				!isDeepStrictEqual(placement?.sandbox ?? null, admittedPlacement.sandbox ?? null))
		)
			throw new Error(
				`dispatch: node or sandbox changed after admission for '${admittedPlacement.node.id}'; request a fresh dispatch`,
			);
		const remoteStoreGrant = remoteStoreGrantRefusal(req, placement?.node ?? null);
		if (remoteStoreGrant !== null) throw new Error(remoteStoreGrant);
		const sharedStoreGrant = await sharedStoreGrantFor(req, placement?.node ?? null, lifecycle.readOnly);
		let remoteReturn: FleetChangeReturn | undefined;
		let remoteImport: FleetChangeImport | undefined;
		if (placement?.node.kind === "ssh") {
			const node = settings?.fleet.nodes.find((item) => item.id === placement.node.id);
			if (!node) throw new Error("dispatch: node configuration disappeared before project verification");
			const project = await verifyFleetProject(
				node,
				req.taskWorktree?.root ?? req.cwd ?? process.cwd(),
				true,
				lifecycle.readOnly,
			);
			assertFleetProjectAuthority(project, lifecycle.readOnly, req.taskWorktree !== undefined);
			if (project.kind === "independent" && req.taskWorktree) remoteReturn = { node, worktree: req.taskWorktree };
		}
		const effectiveRoute = {
			agentId: req.agentId,
			target: lifecycle.target.target.id,
			model: lifecycle.target.wireModelId,
			node: placement?.node?.id ?? "local",
		};
		const endpoint = endpointCapacityForTarget(lifecycle.target.target.id);
		assertRouteWithinApprovedEnvelope(req, effectiveRoute);
		await rebindReservationSlot(
			req,
			effectiveRoute.node,
			endpoint,
			conservativeRouteAdmissionEstimateUsd(
				lifecycle.target.effectivePricing,
				admissionMaxOutputTokens(settings, lifecycle.target.modelCapabilities),
				req,
				lifecycle,
			),
			settings,
		);
		if (placement?.reroutes !== undefined && placement.reroutes.length > 0) {
			req = { ...req, reroutes: [...placement.reroutes] };
		}
		const placed = placement?.node ?? { id: "local", kind: "local" };
		routeObservation = approvedRouteObservation({
			request: req,
			active: activeRouteObservation,
			actual: () => {
				const role: RouteRoleInput = { executionRole: withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0) };
				if (req.systemPrompt !== undefined) role.personaPrompt = req.systemPrompt;
				return toRouteCandidate({ ...previewFixed(req, settings), nodeId: placed.id }, role);
			},
			shadow: () => observeShadowRoute(req, placed, settings),
		});

		if (req.contextSeed) persistWorkerContextSeed(req.contextSeed);
		const queuedIdentity =
			req.lineage === undefined && req.runIdHint !== undefined
				? {
						runId: req.runIdHint,
						sessionId: req.ownerSessionId ?? null,
						agentId: req.agentId,
						task: req.task,
						agentAudience: lifecycle.agentAudience,
						requestOrigin: lifecycle.requestOrigin,
						targetId: lifecycle.target.target.id,
						wireModelId: lifecycle.target.wireModelId,
						runtimeId: lifecycle.target.runtime.id,
						runtimeKind: lifecycle.runtimeKind,
						budget: lifecycle.budgetEnvelope,
						...(endpoint !== null ? { endpoint: { key: endpoint.key, label: endpoint.label, limit: endpoint.limit } } : {}),
						...(placement !== null ? { node: placement.node.id } : {}),
						...(req.gate !== undefined ? { gate: { role: req.gate.role, cycle: req.gate.cycle } } : {}),
						...(req.council !== undefined ? { council: req.council } : {}),
						...(req.reroutes !== undefined && req.reroutes.length > 0 ? { rerouteCount: req.reroutes.length } : {}),
						...(lifecycle.target.modelCapabilities !== undefined &&
						lifecycle.target.modelCapabilities !== null &&
						lifecycle.target.modelCapabilities.contextWindow > 0
							? { contextWindow: lifecycle.target.modelCapabilities.contextWindow }
							: {}),
					}
				: null;
		if (queuedIdentity !== null) publishCapacityQueued(queuedIdentity, timing, placement?.node ?? null);
		let capacityLease: Awaited<ReturnType<typeof admitAssignmentCapacity>>;
		try {
			capacityLease = await admitAssignmentCapacity(
				req,
				placement?.node.id ?? "local",
				timing,
				endpoint,
				preparation?.signal,
			);
		} catch (error) {
			if (queuedIdentity !== null) publishCapacityAdmissionFailure(queuedIdentity, error);
			throw error;
		} finally {
			if (queuedIdentity !== null) pendingCapacity.delete(queuedIdentity.runId);
		}
		const leaseSlot = createLeaseSlotGuard(capacityAdmission, capacityLease.leaseId, req.lineage !== undefined);
		// The permit was resolved before capacity admission and launch
		// preparation, both of which may wait. A dispatcher that left yolo
		// meanwhile launches its worker without the yolo grant, and every record
		// from then on carries the narrowed permit. Checked here and again right
		// before spawn, after the last wait, against fresh settings: the live
		// level and the live confinement, since contained yolo grants no yolo.
		let specAutonomySettings = withLiveAutonomy(lifecycle.settings);
		const narrowPermitToLiveLevel = (): boolean => {
			if (lifecycle.permit.allowance.executeAutonomy !== "yolo") return false;
			const launch = withLiveAutonomy(getEffectiveSettings() ?? lifecycle.settings);
			if (operatorAdmissionAutonomy(launch) === "yolo") return false;
			lifecycle.permit = withoutExecuteAutonomy(lifecycle.permit);
			specAutonomySettings = launch;
			return true;
		};
		narrowPermitToLiveLevel();

		const ledgerRef = (() => {
			try {
				preparation?.signal?.throwIfAborted();
				return requireLedger();
			} catch (error) {
				leaseSlot.release();
				throw error;
			}
		})();
		const tokenMeter: RunTokenMeter = {};
		const safetyDecisionCounts = { allowed: 0, blocked: 0, guardBlocked: 0, permissionRequested: 0 };
		const escalationCounts = { requested: 0, approved: 0, denied: 0, timedOut: 0 };
		let escalationDeniedBy: "operator" | "main agent" | "safety judge" | undefined;
		const blockedAttempts: SafetyBlockedAttempt[] = [];
		const guardBlockedAttempts: SafetyBlockedAttempt[] = [];
		const permissionRequestedAttempts: SafetyBlockedAttempt[] = [];
		// Phase D: a main-authority permit binds every grant to this attempt.
		// The token is a host secret: it rides the spec and each decision frame
		// and never reaches a model or a display.
		const grantAttempt: WorkerGrantBinding | undefined = mainGrantsUnavailable(lifecycle.permit.allowance)
			? { attemptToken: randomBytes(16).toString("hex"), attempt: req.lineage?.attempt ?? 0 }
			: undefined;
		// Under fleet.permissions.mode=judge this process's safety judge decides
		// the attempt's main-authority asks. It reaches only a worker this process
		// launched itself; any other placement denies them at once.
		const judgeRouted = judgeRoutedPermit(lifecycle.permit, lifecycle.settings);
		const judgeReachable =
			judgeRouted &&
			options?.workerAskJudge !== undefined &&
			(placement === null || (placement.node.kind === "local" && placement.spawn === undefined));
		let spec: WorkerSpec;
		let buildSpec: () => WorkerSpec;
		try {
			if (!judgeRouted) assertMainGrantRoutable(req, lifecycle.target.runtime, lifecycle.permit, placement?.node ?? null);
			if (grantAttempt !== undefined && placement?.spawn !== undefined && !judgeRouted) {
				throw new Error(
					"dispatch: fleet.permissions.mode=main routes worker asks to the main agent, but this placement launches through a remote transport, which cannot carry a bound grant yet; use fleet.permissions.mode escalate or deny for this work",
				);
			}
			const unhooked = assertWorkerHooksCarried(lifecycle.target.runtime, lifecycle.admission.allowedTools);
			if (unhooked.length > 0) {
				const notice = `extension tool hooks of ${hookExtensionIds(unhooked)} do not run for ${lifecycle.target.runtime.id} workers; their tool calls are unhooked`;
				if (!unhookedNotices.has(notice)) {
					unhookedNotices.add(notice);
					options?.workerHooks?.notify?.(notice);
				}
			}
			// Capacity admission may have waited. Resolve the subscription again at
			// launch so a CLI peer never starts with the queued snapshot's old token.
			const claudeLaunch = lifecycle.target.runtime.auth === "claude-cli";
			const launchCredential = claudeLaunch
				? await resolveClaudeLaunchCredential(
						lifecycle.target.target.auth,
						process.env,
						preparation?.signal ? { signal: preparation.signal } : {},
					)
				: null;
			if (claudeLaunch && lifecycle.authProfile && !launchCredential) {
				throw new Error(
					"PanCode's Claude credential changed while this assignment was queued. Submit a new assignment with the intended account.",
				);
			}
			const launchAuthProfile = claudeLaunch
				? launchCredential && !launchCredential.profile.startsWith("env:")
					? launchCredential.profile
					: undefined
				: lifecycle.authProfile;
			buildSpec = () =>
				buildDispatchWorkerSpec(
					{
						req,
						...(sharedStoreGrant !== null ? { sharedStoreGrant } : {}),
						role: lifecycle.runRole,
						pathScope: lifecycle.pathScope,
						target: lifecycle.target,
						admission: lifecycle.admission,
						recipe: lifecycle.recipe,
						systemPrompt: lifecycle.systemPrompt,
						dynamicPromptMessages: lifecycle.dynamicPromptMessages,
						promptSignature: lifecycle.promptSignature,
						toolSignature: lifecycle.toolSignature,
						dynamicHash: lifecycle.dynamicHash,
						middlewareSnapshot: middleware.snapshot(),
						protectedArtifactState,
						flowRestrictions: options?.getFlowRestrictions?.() ?? null,
						...(options?.getFlowPolicy !== undefined ? { flowPolicy: options.getFlowPolicy() } : {}),
						apiKey: claudeLaunch ? launchCredential?.apiKey : lifecycle.apiKey,
						...((placement === null || placement.node.kind === "local") && launchAuthProfile
							? { authProfile: launchAuthProfile }
							: {}),
						...(launchCredential?.expiresAt !== undefined ? { credentialExpiresAt: launchCredential.expiresAt } : {}),
						envelope: envelopeForPermit(lifecycle.envelope, lifecycle.permit),
						...(lifecycle.projectContext?.peerInstructions?.delivery === "single-source"
							? { skipRepositoryInstructions: true }
							: {}),
						budget: lifecycle.budget,
						...(lifecycle.settings ? { settings: lifecycle.settings } : {}),
						workerPermissionResponder:
							options?.workerPermissionResponder === true && !operatorContainedYolo(specAutonomySettings),
						permit: lifecycle.permit,
						...(grantAttempt !== undefined ? { grantAttempt } : {}),
						...(judgeRouted ? { judgeResponder: judgeReachable } : {}),
						mainAutonomy: operatorAdmissionAutonomy(specAutonomySettings),
						...(options?.workerHooks ? { extensionHooks: options.workerHooks.declarations() } : {}),
					},
					config ?? undefined,
				);
			spec = buildSpec();
		} catch (error) {
			leaseSlot.release();
			if (req.lineage === undefined) await failQueuedAssignment(capacityLease.assignmentId);
			throw error;
		}
		// The agent ledger is orchestrator-owned. The worker sends a body and
		// nothing else; every attribution field below is stamped from this
		// process's own admission record, so no worker-supplied value can reach
		// one. Attribution exists only once the run has an envelope, and the
		// worker is already live before that, so a post that lands in the gap is
		// held in order and appended the moment attribution exists. The hold is
		// bounded by the per-run cap, which is what the append would refuse past
		// anyway.
		const agentLedgerId = spec.ledger?.id ?? null;
		let agentLedgerAttribution: AgentLedgerAttribution | null = null;
		let unsubscribeAgentLedger: (() => void) | null = null;
		const heldLedgerPosts: Array<{ body: AgentLedgerBody; flowRestrictions?: FlowRestrictionSet }> = [];
		const appendLedgerPost = (
			attribution: AgentLedgerAttribution,
			body: AgentLedgerBody,
			flowRestrictions?: FlowRestrictionSet,
		): void => {
			if (agentLedgerId === null) return;
			const carried = mergeFlowRestrictions(spec.flowRestrictions, flowRestrictions);
			trustedFlow = mergeFlowRestrictions(trustedFlow, carried);
			void appendAgentLedgerEntry(
				agentLedgerId,
				{ ...attribution, ...(carried ? { flowRestrictions: carried } : {}) },
				body,
			)
				.then(async (result) => {
					if (!result.ok) return;
					publishAgentLedgerEntry(agentLedgerId, result.entry);
					// A failing review outlives this dispatch as a dispute in the project's claims log (#406); the ledger
					// itself is a ring of recent dispatches no later session reads.
					if (result.entry.body.kind === "review" && !result.entry.body.passed)
						await recordAgentLedgerDispute({
							ledgerId: agentLedgerId,
							review: result.entry,
							entries: readAgentLedger(agentLedgerId)?.entries ?? [],
							projectCwd: lifecycle.cwd,
						});
				})
				.catch((error) => reportDispatchDiagnostic(`append agent ledger entry for ${attribution.runId}`, error));
		};
		const onLedgerPost = (body: AgentLedgerBody, flowRestrictions?: FlowRestrictionSet): void => {
			if (agentLedgerId === null) return;
			const attribution = agentLedgerAttribution;
			if (attribution === null) {
				if (heldLedgerPosts.length < MAX_AGENT_LEDGER_POSTS_PER_RUN)
					heldLedgerPosts.push({ body, ...(flowRestrictions ? { flowRestrictions } : {}) });
				return;
			}
			appendLedgerPost(attribution, body, flowRestrictions);
		};
		// A model this worker loaded is this process's to release at exit, and
		// stays out of mid-session eviction until then (#379). The report is
		// checked against the admitted route, and the endpoint comes from this
		// process's own target, so a worker can neither redirect the release nor
		// claim a model it was not dispatched to.
		const onModelLoaded = (load: WorkerModelLoad): void => {
			adoptWorkerModelLoad(load, {
				target: lifecycle.target.target,
				runtime: lifecycle.target.runtime,
				wireModelId: lifecycle.target.wireModelId,
				node: placed,
			});
		};
		// A worker ask routed to the main agent enters the broker here, from the
		// control lane, bound to this attempt. A request the broker refuses is
		// denied at once rather than left to wait out its timeout.
		const onGrantRequest = (request: WorkerGrantRequestFrame): void => {
			if (grantAttempt === undefined) return;
			if (request.attemptToken !== grantAttempt.attemptToken || request.attempt !== grantAttempt.attempt) {
				reportDispatchDiagnostic(
					`run ${runIdForPermissionAudit ?? "pending"}`,
					new Error("dropped a grant request that names another attempt"),
				);
				return;
			}
			const denyAtOnce = (reason: string): void => {
				sendToWorker?.({
					type: "permission_decision",
					requestId: request.requestId,
					decision: "deny",
					binding: { ...grantAttempt, argDigest: request.argDigest, issuer: "operator", reason },
				});
			};
			const runId = runIdForPermissionAudit;
			if (runId === null) {
				denyAtOnce("the run was not registered yet");
				return;
			}
			const opened = grantBroker.open({
				workerRequestId: request.requestId,
				runId,
				rootRunId: lineage.rootRunId,
				attempt: request.attempt,
				attemptToken: grantAttempt.attemptToken,
				ownerSessionId: req.ownerSessionId ?? null,
				agentId: req.agentId,
				...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
				tool: request.tool,
				actionClass: request.actionClass,
				approvalAuthority: request.authority,
				argDigest: request.argDigest,
				effect: request.effect,
				cwd: lifecycle.cwd,
				permitTools: lifecycle.permit.ceiling.tools,
				summary: request.summary,
				...(request.target !== undefined ? { target: request.target } : {}),
				...(request.consequence !== undefined ? { consequence: [...request.consequence] } : {}),
				reasons: request.reasons,
				// A window this process runs ends the request and a hold can reach the
				// ceiling. Otherwise the broker expires a little before the worker's own
				// timer, so the denial it sends is the one that settles the request.
				...(spec.escalation?.backstopMs !== undefined
					? { deadlineAt: now() + workerApprovalCeilingMs(request.timeoutMs), windowMs: request.timeoutMs }
					: { deadlineAt: now() + Math.max(1_000, request.timeoutMs - GRANT_DEADLINE_MARGIN_MS) }),
				...(judgeReachable && request.authority === "main" ? { reviewer: "safety-judge" as const } : {}),
				...(request.mcpTool !== undefined ? { mcpTool: request.mcpTool } : {}),
			});
			if (!opened.ok) {
				denyAtOnce(opened.reason);
				return;
			}
			if (opened.record.reviewer === "safety-judge")
				void decideJudgedGrant({ grantAttended, grantBroker, options, safety }, opened.record, req.turnConstraints);
		};
		// A worker's call waits on its answer, so every request is answered, with
		// the hook's own failure policy when it cannot run.
		let answerHook: ((frame: WorkerHookResultFrame) => boolean) | undefined;
		const workerHooks = options?.workerHooks;
		const onHookRequest = (request: WorkerHookRequest): void => {
			if (workerHooks === undefined) return;
			void workerHooks
				.evaluate(request, {
					runId: runIdForPermissionAudit,
					sessionId: req.ownerSessionId ?? null,
					// A task worktree stands for the checkout it was cut from; any other worker for its dispatch cwd.
					sourceRoot: req.taskWorktree?.root ?? lifecycle.cwd,
				})
				// evaluate never rejects by contract; if it does, the call still gets an
				// answer by the stricter of the dispatched hook's policies, as the
				// worker would decide a lost one, only without waiting out its deadline.
				.catch((error: unknown): ReadonlyArray<WorkerHookEffect> => {
					const hook = spec.extensionHooks?.find((entry) => entry.id === request.hookId);
					if (hook !== undefined && hook.onError !== "block" && hook.onTimeout !== "block") return [];
					const reason = `${request.hookId} could not be evaluated (${error instanceof Error ? error.message : String(error)})`;
					return request.point === "before_tool"
						? [{ kind: "block_tool", reason: `${reason}; the gate fails closed` }]
						: [
								{
									kind: "annotate_tool_result",
									message: `${reason}; the tool already ran, so its result carries this warning`,
									severity: "warn",
								},
							];
				})
				.then((effects) => answerHook?.({ type: "hook_result", requestId: request.requestId, effects }))
				.catch(() => {
					// send reports its own failures as a channel failure; the worker then decides the call by its policy.
				});
		};
		// Every run in the current checkout keeps its measured delta on the receipt, so a tool runtime's worker whose
		// write record is incomplete still counts its edits there and in the exit summary (bt-11). The test-removal
		// check and slate acceptance below keep reading it for a subprocess runtime only.
		// Taken off the event loop and awaited before the worker spawns; runs spawned against this cwd meanwhile share it.
		const checkoutBaselineTaken = req.taskWorktree === undefined ? takeCheckoutBaseline(lifecycle.cwd) : null;
		let checkoutBaseline: CheckoutSnapshot | null = null;
		let worker: SpawnedWorker;
		// A held follower's worker starts after its run row exists; this moves the row onto the real process.
		let heldFollower = false;
		let onFollowerStarted: ((started: SpawnedWorker) => void) | null = null;
		// Kept so a follower released before its run row exists still gets that row's start bookkeeping.
		let followerWorker: SpawnedWorker | null = null;
		// A held follower joins its batch's board once its worker can take deliveries.
		let subscribeHeldBoard: (() => void) | null = null;
		let peerOverlay: TaskWorktreeOverlay | null = null;
		const restorePeerOverlay = (): void => {
			if (peerOverlay === null) return;
			try {
				const discarded = restoreTaskWorktreeOverlay(peerOverlay);
				const context = lifecycle.projectContext;
				if (discarded.length > 0 && context?.peerInstructions !== undefined) {
					lifecycle.projectContext = { ...context, peerInstructions: { ...context.peerInstructions, discarded } };
				}
			} catch (error) {
				// The skip-worktree mark stays on what was not put back, so the landing still leaves it out.
				reportDispatchDiagnostic(`restore peer instructions in task worktree ${req.taskWorktree?.runId}`, error);
			}
			peerOverlay = null;
		};
		const callUsage = spec.telemetryContext ? createRunCallUsage(spec.telemetryContext) : undefined;
		let runJournal: RunTelemetryJournal | undefined;
		let parentJournal: TelemetrySessionLease | undefined;
		// How the worker loop ended, once known; a failed finalization still settles the run journal with it.
		let resolvedTerminal: ResolvedTerminalReason | undefined;
		let prefixLeader: DispatchPrefixGroup | undefined;
		const closeRunJournal = async () => {
			try {
				await runJournal?.close();
			} finally {
				await parentJournal?.release();
			}
		};
		try {
			if (spec.telemetryContext) {
				try {
					runJournal = await openRunTelemetry(
						spec.telemetryContext,
						telemetryRunDirectory(pancodeStateDir(), spec.telemetryContext.runId),
					);
					if (req.ownerSessionId && req.ownerSessionCwdHash) {
						parentJournal = await context
							.getContract("telemetry")
							?.acquireTelemetrySession?.(
								{ id: req.ownerSessionId, cwdHash: req.ownerSessionCwdHash },
								spec.telemetryContext.agent,
							);
						if (parentJournal) runJournal.linkSession(parentJournal.context);
					}
				} catch (error) {
					reportDispatchDiagnostic("open run telemetry journal", error);
				}
			}
			if (checkoutBaselineTaken !== null) checkoutBaseline = await checkoutBaselineTaken;
			preparation?.signal?.throwIfAborted();
			const spawnOptions = {
				cwd: lifecycle.cwd,
				now,
				monotonicNow,
				onModelLoaded,
				onChannelFailure: (fact: EventPayload<"worker.channel_failed">) => runJournal?.channel(fact),
				...(agentLedgerId !== null ? { onLedgerPost } : {}),
				...(grantAttempt !== undefined ? { onGrantRequest } : {}),
				...(spec.extensionHooks !== undefined ? { onHookRequest } : {}),
			};
			const prefixClaim = claimSharedPrefix(
				preparation?.prefixGroups,
				lifecycle.runtimeKind === "http" && lifecycle.promptSignature !== null && req.runIdHint !== undefined
					? sha256Hex(
							JSON.stringify([
								lifecycle.target.target.id,
								lifecycle.target.runtime.id,
								endpoint?.key ?? null,
								lifecycle.target.wireModelId,
								lifecycle.toolSignature,
								sharedPrefixSignature(lifecycle.systemPrompt, lifecycle.dynamicPromptMessages, req),
							]),
						)
					: null,
				req.runIdHint ?? "",
			);
			if (prefixClaim?.role === "leader") prefixLeader = prefixClaim.group;
			if (remoteReturn) await prepareFleetChangeReturn(remoteReturn.node, remoteReturn.worktree);
			preparation?.signal?.throwIfAborted();
			const spawnNow = (): SpawnedWorker => {
				// Nothing waits between here and spawn: the worker launches at the dispatcher's level now.
				if (narrowPermitToLiveLevel()) spec = buildSpec();
				if (lifecycle.peerOverlay !== undefined && lifecycle.peerCoexist !== undefined && req.taskWorktree !== undefined) {
					try {
						if (placement !== null && placement.node.kind !== "local") throw new Error("the worktree is on another node");
						peerOverlay = overlayTaskWorktree(req.taskWorktree, lifecycle.peerOverlay);
					} catch (error) {
						// The harness reads its own files after all, so the rules go in the message and the record says coexist.
						Object.assign(lifecycle, lifecycle.peerCoexist);
						spec = buildSpec();
						reportDispatchDiagnostic(`write peer instructions in task worktree ${req.taskWorktree.runId}`, error);
					}
				}
				// Each live worker of one head takes its own provider session id on its capacity lease, so every process on this
				// state dir sees it; the lane frees with the lease (FL-17, M-11).
				// The head is the system prompt and tool surface alone: the prompt signature also covers each run's task.
				const lane =
					lifecycle.runtimeKind === "http" && lifecycle.systemPrompt.length > 0
						? claimWorkerCacheLane(
								capacityLease.leaseId,
								sha256Hex(
									JSON.stringify([
										lifecycle.target.target.id,
										lifecycle.target.wireModelId,
										lifecycle.toolSignature,
										lifecycle.systemPrompt,
									]),
								),
							)
						: null;
				if (lane === null) return (placement?.spawn ?? spawnWorker)(spec, spawnOptions);
				try {
					const started = (placement?.spawn ?? spawnWorker)({ ...spec, cacheLane: lane.lane }, spawnOptions);
					void started.promise.then(lane.release, lane.release);
					return started;
				} catch (error) {
					lane.release();
					throw error;
				}
			};
			if (prefixClaim?.role === "follower") {
				// The handle returns now; only the worker's start waits for the leader, so a slow leader holds no caller.
				const group = prefixClaim.group;
				heldFollower = true;
				worker = startAfterPrefixHold(
					async (signal) => {
						const hold = await waitForPrefixLeader(group, {
							signal: preparation?.signal ? AbortSignal.any([signal, preparation.signal]) : signal,
						});
						if (hold?.role !== "follower") return;
						timing.prefixHoldMs = hold.heldMs;
						timing.prefixLeaderRunId = hold.leaderRunId;
					},
					() => {
						if (
							canceledControlRoots.has(controlRootsByAttempt.get(req.runIdHint ?? "") ?? capacityLease.assignmentId) ||
							preparation?.signal?.aborted === true
						)
							return null;
						const started = spawnNow();
						timing.workerSpawnedAt = new Date(now()).toISOString();
						return started;
					},
					{ now, monotonicNow },
					// Until the worker exists this process vouches for the run, as it does behind a merge card, so another
					// PanCode on this state directory does not recover a held follower as abandoned.
					process.pid,
					(started) => {
						followerWorker = started;
						onFollowerStarted?.(started);
					},
				);
			} else worker = spawnNow();
		} catch (error) {
			restorePeerOverlay();
			prefixLeader?.release();
			await closeRunJournal();
			leaseSlot.release();
			if (req.lineage === undefined) await failQueuedAssignment(capacityLease.assignmentId);
			throw error;
		}
		if (!heldFollower) timing.workerSpawnedAt = new Date(now()).toISOString();
		// The wall clock and a call's timeout_ms can both stop a run; its worker is stopped once (fleet M8).
		let workerAborted = false;
		const abort = (): void => {
			if (workerAborted) return;
			workerAborted = true;
			worker.abort();
		};
		const sendToWorker = worker.send?.bind(worker);
		answerHook = sendToWorker;
		const steeringProvenance: RunSteeringProvenance[] = [];
		let steeringProvenanceClosed = false;
		const steer =
			sendToWorker && runKindSupportsLiveSteering(lifecycle.runtimeKind)
				? (text: string): boolean => {
						if (steeringProvenanceClosed) return false;
						const canonicalText = text.trim();
						const sequence = steeringProvenance.length + 1;
						if (canonicalText.length === 0 || !sendToWorker({ type: "steer", text: canonicalText, sequence })) return false;
						steeringProvenance.push({
							sequence,
							bytes: Buffer.byteLength(canonicalText, "utf8"),
							contentHash: sha256Hex(canonicalText),
							sentAt: new Date().toISOString(),
							acknowledged: false,
						});
						return true;
					}
				: undefined;
		const acknowledgeSteer = (sequence: unknown): void => {
			if (steeringProvenanceClosed) return;
			if (!Number.isSafeInteger(sequence) || Number(sequence) <= 0) return;
			const pending = steeringProvenance.find((entry) => entry.sequence === sequence && !entry.acknowledged);
			if (pending === undefined) return;
			pending.acknowledged = true;
			pending.acknowledgedAt = new Date().toISOString();
		};
		const snapshotSteeringProvenance = (): ReadonlyArray<RunSteeringProvenance> => {
			steeringProvenanceClosed = true;
			return steeringProvenance.map((entry) => ({ ...entry }));
		};
		const resolvePermission = sendToWorker
			? (requestId: string, decision: "approve" | "deny", binding?: WorkerDecisionBinding, cause?: "timeout") =>
					sendToWorker({
						type: "permission_decision",
						requestId,
						decision,
						...(binding !== undefined ? { binding } : {}),
						...(cause !== undefined ? { cause } : {}),
					})
			: undefined;
		// Only a worker that announced this frame version is sent one: an older one drops the line, and its backstop
		// would then deny a hold this process believes it extended.
		const holdPermission = sendToWorker
			? (requestId: string, holdMs: number): boolean => {
					if (worker.attestation?.()?.permissionHold !== WORKER_PERMISSION_HOLD_VERSION) return false;
					const frame: WorkerPermissionHoldFrame = {
						type: "permission_hold",
						version: WORKER_PERMISSION_HOLD_VERSION,
						requestId,
						holdMs: Math.ceil(holdMs),
					};
					return sendToWorker(frame);
				}
			: undefined;
		const heartbeatAt = worker.heartbeatAt;
		const workerEvents = worker.events;
		// Put the harness's files back before anything reads the worktree's change. A held follower writes its overlay
		// only when it starts, after this line, so the restore is always chained; without an overlay it does nothing.
		const workerDone = worker.promise.finally(restorePeerOverlay);
		if (prefixLeader) {
			const release = prefixLeader.release;
			workerDone.then(release, release);
		}

		const toolStats = new Map<string, ToolCallStat>();
		const inFlightTools = new Map<string, number>();
		// The calls in flight by id, and the ones the host saw running when its abort started: the abort finishes them
		// before the seal, so the stop detail reads this snapshot (M-37).
		const inFlightCalls = new Map<string, InFlightCall>();
		let callsAtAbort: InFlightCall[] | null = null;
		let toolTelemetryIngestionErrors = 0;
		const upstreamResponses: RunResultUpstreamResponse[] = [];
		const skillActivations: SkillActivation[] = [];
		const finishContractEntries: unknown[] = [];
		const verifyCalls: VerifyCallLog = { pending: new Map(), calls: [] };
		const pendingCapabilities = new Map<string, string>();
		// The calls that reached a PanCode tool. A native call the engine refused before that, such as one whose arguments
		// failed the tool's schema, ends in error without a PanCode start or finish, and still counts as an errored call.
		const reachedTool = new Set<string>();
		// A producer without call ids cannot tie a start to its end, so such a stream counts only its PanCode finishes.
		let startsCarryIds = true;
		// The calls of a reply the output token limit cut off. The engine fails each without running it, so they are
		// neither refused nor errored and toolStats leaves them out.
		const outputLimitCalls = new Set<string>();
		// A gateway wrapper's finish waits for its result: a chain's settled steps count as the calls they are, so the
		// wrapper counts only when none settled. Counting both made an N-step chain N + 1 calls (bt-14).
		const gatewayFinishes = new Map<string, ToolFinishPayload>();
		let runIdForPermissionAudit: string | null = null;
		// The worker's own tool calls, folded into what this run changed and what
		// it validated. The sealed mutation-report contract is measured against
		// this, so a reported path the run never touched cannot seal as fact.
		const runEffects = createRunEffectsRecorder(lifecycle.cwd, {
			scratchRoots: lifecycle.settings?.safety.scratchRoots ?? [],
			onWriteRecordDowngraded(downgrade) {
				const runId = runIdForPermissionAudit;
				if (runId === null) return;
				context.bus.emit("run.progressed", {
					runId,
					agentId: req.agentId,
					event: { type: "pancode_write_record_partial", payload: downgrade },
				});
			},
		});
		let finishContractAssistantText = "";
		let finishContractAssistantTurnId: string | null = null;
		let failureMessage: string | undefined;
		let permissionDenialDetail: string | null = null;
		// The worker hit its execute refusal limit, then whether its one report reply arrived.
		let refusalLimit: "reached" | "reported" | null = null;
		let providerErrorMessage: string | null = null;
		let externalTelemetry: RunResultDraft["externalTelemetry"];
		let outcomeCode: RunOutcomeCode | null = null;
		const trustedOutcomeCodes = new Set<RunOutcomeCode>();
		// The native worker's own repair-round count; it stays unreported for every other runtime (C-28).
		let reportedRepairRounds: number | undefined;
		const trustedOutcomeDetails = new Map<RunOutcomeCode, string>();
		// What the run's context carries: the inherited set, grown by the worker's
		// own restricted reads as it reports them. Only a mediated runtime's
		// report is believed; the inherited part is the host's own fact.
		let trustedFlow: FlowRestrictionSet | null = mergeFlowRestrictions(
			spec.flowRestrictions,
			// External runtimes cannot report each restricted read. Their final
			// output conservatively carries every source rule admitted for them.
			lifecycle.runtimeKind === "http" || spec.flowPolicy === undefined
				? null
				: {
						version: 1,
						restrictions: spec.flowPolicy.rules.map((rule) => ({
							ruleId: rule.id,
							policyHash: rule.policyHash,
							sourceRef: `runtime:${lifecycle.target.runtime.id}`,
							recipients: rule.recipients,
						})),
					},
		);
		let reportedUntrustedOutcome = false;
		const acceptsOutcomeCodeEvents =
			lifecycle.runtimeKind === "http" ||
			(lifecycle.runtimeKind === "sdk" && lifecycle.target.runtime.id === "claude-sdk");
		let workerPolicyPermissionCounter = 0;
		// The bound the receipt can seal follows the contract this run will be
		// validated against; a conforming result never arrives clipped.
		const helperContract = dispatchResultContract(req, lifecycle.recipe);
		const outputCapture = createWorkerOutputCapture({
			maxBytes: workerOutputCaptureBytes(helperContract),
			...(spec.helperResult === true &&
			acceptsOutcomeCodeEvents &&
			(helperContract?.kind === "mutation-report" ||
				lifecycle.agentAudience === "shadow" ||
				lifecycle.agentAudience === "internal") &&
			helperContract &&
			(INTERNAL_HELPER_RESULT_KINDS as readonly string[]).includes(helperContract.kind)
				? {
						helperResult: {
							contract: helperContract,
							validate: (data: unknown) =>
								validateStructuredHelperResult({
									contract: helperContract,
									data,
									cwd: lifecycle.cwd,
									networkAllowed: workerHasNetworkPosture(lifecycle.admission),
									observedRunEffects: runEffects.snapshot(),
									filesystem: nodeResultContractFilesystem(),
								}).structured,
						},
					}
				: {}),
		});
		const foldWorkerEvent = (raw: unknown): void => {
			if (raw !== null && typeof raw === "object" && "type" in raw && raw.type === "pancode_telemetry") {
				runJournal?.worker(raw);
				if (callUsage && !callUsage.observe(raw)) callUsage.gap();
				if (callUsage) {
					const usage = callUsage.snapshot();
					if (usage) {
						tokenMeter.usage = usage;
						stopRunsAtCostCeiling();
					}
				}
				return;
			}
			outputCapture.observe(raw);
			if (
				refusalLimit === "reached" &&
				(durableAssistantTextFromEvent(raw).trim().length > 0 || (isRecord(raw) && raw.type === "pancode_helper_result"))
			)
				refusalLimit = "reported";
			if (
				prefixLeader &&
				raw !== null &&
				typeof raw === "object" &&
				"type" in raw &&
				(raw.type === "message_update" ||
					(raw.type === "message_end" &&
						"message" in raw &&
						(raw.message as { role?: unknown } | null)?.role === "assistant"))
			)
				prefixLeader.release();
			const event = raw as {
				type?: string;
				message?: {
					role?: string;
					usage?: unknown;
					failure?: unknown;
					model?: unknown;
					responseModelIdObservation?: unknown;
					responseModel?: unknown;
					responseId?: unknown;
					stopReason?: unknown;
					errorMessage?: unknown;
					content?: unknown;
				};
				payload?: {
					callIndex?: number;
					model?: unknown;
					responseModel?: unknown;
					responseId?: unknown;
					usage?: unknown;
					tool?: string;
					toolCallId?: string;
					action?: unknown;
					sequence?: number;
					outcomeCode?: unknown;
					detail?: unknown;
					posture?: string;
					durationMs?: number;
					outcome?: "ok" | "error" | "blocked";
					decision?: unknown;
					actionClass?: string;
					ruleId?: string;
					reasonCode?: string;
					policySource?: string;
					reason?: string;
					skillActivation?: unknown;
					// Worker permission-escalation fields (pancode_permission_escalated /
					// pancode_permission_resolved escalate path).
					requestId?: string;
					summary?: string;
					target?: string;
					consequence?: unknown;
					axis?: string;
					timeoutMs?: number;
					source?: "operator" | "timeout" | "policy" | "remembered" | "main" | "binding";
					phase?: string;
				};
				toolName?: string;
				toolCallId?: string;
				args?: unknown;
				result?: unknown;
				isError?: boolean;
			};
			if (event.type === "pancode_tool_start" && event.payload && typeof event.payload.tool === "string") {
				recordToolStart(inFlightTools, event.payload);
				recordCallStart(inFlightCalls, event.payload);
				if (typeof event.payload.toolCallId === "string") reachedTool.add(event.payload.toolCallId);
				else startsCarryIds = false;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				for (const id of outputLimitCutOffToolCallIds(event.message)) outputLimitCalls.add(id);
			}
			if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
				pendingCapabilities.set(event.toolCallId, effectiveToolCall(event.toolName, event.args).toolName);
			}
			if (event.type === "pancode_steer_received") acknowledgeSteer(event.payload?.sequence);
			if (event.type === "pancode_repository_instructions") {
				// The harness lacked the switch that skips its files, so it read them; any runtime may only lower the claim.
				const context = lifecycle.projectContext;
				if (context?.peerInstructions?.delivery === "single-source") {
					lifecycle.projectContext = {
						...context,
						peerInstructions: { ...context.peerInstructions, delivery: "coexist", reason: "switch-unsupported" },
					};
				}
			}
			if (event.type === "pancode_flow_restrictions" && acceptsOutcomeCodeEvents) {
				const reported = (event.payload as { set?: unknown } | undefined)?.set;
				if (isFlowRestrictionSet(reported)) trustedFlow = mergeFlowRestrictions(trustedFlow, reported);
			}
			if (event.type === "pancode_repair_rounds_started" && lifecycle.runtimeKind === "http") {
				const started = (event.payload as { started?: unknown } | undefined)?.started;
				if (typeof started === "number" && Number.isSafeInteger(started) && started >= 0)
					reportedRepairRounds = Math.max(reportedRepairRounds ?? 0, started);
			}
			if (
				event.type === "pancode_run_outcome" &&
				isRunOutcomeCode(event.payload?.outcomeCode) &&
				event.payload.outcomeCode !== "result_contract_invalid" &&
				event.payload.outcomeCode !== "host_verification_rejected" &&
				event.payload.outcomeCode !== "merge_withheld"
			) {
				if (acceptsOutcomeCodeEvents) {
					trustedOutcomeCodes.add(event.payload.outcomeCode);
					const detail = event.payload.detail;
					if (
						typeof detail === "string" &&
						detail.trim().length > 0 &&
						!trustedOutcomeDetails.has(event.payload.outcomeCode)
					)
						trustedOutcomeDetails.set(
							event.payload.outcomeCode,
							compactDiagnosticText(boundedExternalDiagnostic(detail, MAX_WORKER_OUTCOME_DETAIL_BYTES)),
						);
				} else if (!reportedUntrustedOutcome) {
					reportedUntrustedOutcome = true;
					reportDispatchDiagnostic(
						`run ${runIdForPermissionAudit ?? "pending"}`,
						new Error(`ignored untrusted outcome assertion from ${lifecycle.runtimeKind} runtime`),
					);
				}
			}
			if (isRecord(event)) {
				const finishEntry = appendDispatchFinishContractEntry(finishContractEntries, event);
				if (finishEntry !== null) {
					finishContractAssistantText = finishEntry.assistantText;
					finishContractAssistantTurnId = finishEntry.assistantTurnId;
				}
				recordWorkerRunEffect(runEffects, event, spec.helperResult === true);
				recordWorkerVerifyCall(verifyCalls, event);
				if (
					event.type === "tool_execution_end" &&
					lifecycle.runtimeKind === "http" &&
					startsCarryIds &&
					event.isError === true &&
					event.toolCallId &&
					!reachedTool.has(event.toolCallId) &&
					!outputLimitCalls.has(event.toolCallId) &&
					event.toolName !== INTERNAL_HELPER_RESULT_TOOL
				) {
					recordToolFinish(toolStats, {
						tool: pendingCapabilities.get(event.toolCallId) ?? String(event.toolName),
						outcome: "error",
					});
					pendingCapabilities.delete(event.toolCallId);
				}
				if (event.type === "tool_execution_end") {
					const children = gatewayChainReceipts(String(event.toolName), event.result);
					const wrapper = gatewayFinishes.get(event.toolCallId ?? "");
					gatewayFinishes.delete(event.toolCallId ?? "");
					if (wrapper !== undefined && children.length === 0) recordToolFinish(toolStats, wrapper);
					for (const child of children) {
						recordToolFinish(toolStats, {
							tool: child.capability,
							outcome: child.admission.outcome,
							notExecuted: resultNotExecuted(child.result),
						});
						const guardBlock =
							child.admission.decision === "blocked" && child.admission.reasonCode === TOOL_GUARD_REASON_CODE;
						const asked = child.admission.decision !== "allowed" && child.admission.decision !== "blocked";
						if (child.admission.decision === "allowed") safetyDecisionCounts.allowed += 1;
						else if (guardBlock) safetyDecisionCounts.guardBlocked += 1;
						else if (asked) safetyDecisionCounts.permissionRequested += 1;
						else safetyDecisionCounts.blocked += 1;
						if (child.admission.outcome === "blocked") {
							(guardBlock ? guardBlockedAttempts : asked ? permissionRequestedAttempts : blockedAttempts).push({
								tool: child.capability,
								actionClass: child.admission.actionClass,
								...(child.admission.ruleId ? { ruleId: child.admission.ruleId } : {}),
								...(child.admission.reasonCode ? { reasonCode: child.admission.reasonCode } : {}),
								...(child.admission.blockReason ? { reason: child.admission.blockReason } : {}),
							});
						}
					}
				}
			}
			if (
				event.type === "pancode_permission_grant_execution" &&
				grantAttempt !== undefined &&
				event.payload &&
				typeof event.payload.requestId === "string" &&
				runIdForPermissionAudit !== null
			) {
				const phase = event.payload.phase;
				if (phase === "start" || phase === "end" || phase === "not_executed") {
					const detail =
						phase === "end"
							? `the granted call ran (${typeof event.payload.outcome === "string" ? event.payload.outcome : "ok"})`
							: typeof event.payload.detail === "string"
								? event.payload.detail.slice(0, 500)
								: undefined;
					grantBroker.markExecution(runIdForPermissionAudit, event.payload.requestId, phase, detail);
				}
			}
			if (
				event.type === "pancode_permission_escalated" &&
				event.payload &&
				typeof event.payload.requestId === "string" &&
				grantAttempt !== undefined
			) {
				// A main-routed ask is presented by the grant broker from the control
				// lane; this display event only counts it.
				escalationCounts.requested += 1;
			} else if (
				event.type === "pancode_permission_escalated" &&
				event.payload &&
				typeof event.payload.requestId === "string"
			) {
				escalationCounts.requested += 1;
				// Opened before the card is told, so its first frame already reads this window.
				const windowMs = spec.escalation?.timeoutMs;
				if (spec.escalation?.backstopMs !== undefined && windowMs !== undefined && resolvePermission !== undefined) {
					const requestId = event.payload.requestId;
					workerApprovalWindows.open({
						runId: runIdForPermissionAudit,
						agentId: req.agentId,
						requestId,
						windowMs,
						fallback: spec.escalation.fallback,
						deny: () => resolvePermission(requestId, "deny", undefined, "timeout"),
						...(holdPermission !== undefined ? { extend: (holdMs: number) => holdPermission(requestId, holdMs) } : {}),
					});
				}
				const ctx = isRecord(event.payload.decision) ? event.payload.decision : null;
				const classification = ctx !== null && isRecord(ctx.classification) ? ctx.classification : null;
				const policy = ctx !== null && isRecord(ctx.policy) ? ctx.policy : null;
				const actionClass =
					readStringOrNull(classification?.actionClass) ??
					readStringOrNull(ctx?.actionClass) ??
					readStringOrNull(event.payload.actionClass) ??
					"unknown";
				const reasons = readStringArrayOrNull(ctx?.reasons) ?? readStringArrayOrNull(classification?.reasons);
				const consequence = readStringArrayOrNull(event.payload.consequence);
				const reasonCode = readStringOrNull(ctx?.reasonCode) ?? readStringOrNull(policy?.reasonCode);
				const ruleId = readStringOrNull(ctx?.ruleId) ?? readStringOrNull(policy?.ruleId);
				const policySource = readStringOrNull(ctx?.policySource) ?? readStringOrNull(policy?.policySource);
				const policyKind = readStringOrNull(policy?.kind);
				const axis =
					readStringOrNull(event.payload.axis) ??
					(ruleId !== null ? `net:${ruleId}` : policyKind === "ask" && reasonCode !== null ? `net:${reasonCode}` : null);
				emitApproval(context.bus, "approval.requested", {
					tool: typeof event.payload.tool === "string" ? event.payload.tool : "unknown",
					actionClass,
					...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
					requestedBy: runIdForPermissionAudit ?? undefined,
					requestId: event.payload.requestId,
					...(runIdForPermissionAudit !== null ? { origin: `worker:${runIdForPermissionAudit}` } : {}),
					...(axis !== null ? { axis } : {}),
					agentId: req.agentId,
					...(typeof event.payload.summary === "string" ? { summary: event.payload.summary } : {}),
					...(typeof event.payload.target === "string" && event.payload.target.length > 0
						? { target: event.payload.target }
						: {}),
					...(consequence !== null ? { consequence } : {}),
					...(reasons !== null ? { reasons } : {}),
					...(reasonCode !== null ? { reasonCode } : {}),
					...(ruleId !== null ? { ruleId } : {}),
					...(policySource !== null ? { policySource } : {}),
					...(typeof event.payload.timeoutMs === "number" ? { timeoutMs: event.payload.timeoutMs } : {}),
					fallback: spec.escalation?.fallback ?? "deny",
					escalation: true,
				});
			}
			foldModelCallEvent(event, upstreamResponses);
			if (event.type === "message_end" && event.message?.role === "assistant") {
				if (lifecycle.runtimeKind === "subprocess") {
					const u = isRecord(event.message.usage) ? event.message.usage : null;
					const evidence = u !== null && isRecord(u.pancodeExternal) ? u.pancodeExternal : null;
					const stopReason = event.message.stopReason;
					externalTelemetry = {
						tokenUsage:
							evidence?.tokenUsage === "provider-reported" || evidence?.tokenUsage === "missing"
								? evidence.tokenUsage
								: "unverified",
						cost:
							evidence?.cost === "provider-reported" || evidence?.cost === "peer-estimated" || evidence?.cost === "missing"
								? evidence.cost
								: "unverified",
						sessionId: readStringOrNull(evidence?.sessionId),
						exitReason: stopReason === "stop" || stopReason === "error" || stopReason === "aborted" ? stopReason : "unknown",
						toolTelemetry: "unavailable",
					};
				}
				const errorMessage = foldAssistantCall(event.message, tokenMeter, upstreamResponses, lifecycle.target.wireModelId);
				if (errorMessage !== null) {
					failureMessage = errorMessage;
					providerErrorMessage = errorMessage;
				}
			}
			if (event.type === "pancode_permission_resolved" && typeof event.payload?.requestId === "string") {
				workerApprovalWindows.settle(event.payload.requestId);
				adoptedAsks.delete(event.payload.requestId);
			}
			if (
				event.type === "pancode_permission_resolved" &&
				// An escalation that timed out under fallback fail ends the run for this reason too; without
				// it the receipt could say only `exit code 3`.
				(event.payload?.source === "policy" ||
					(event.payload?.source === "timeout" && (event.payload as { mode?: unknown }).mode === "fail")) &&
				typeof event.payload.reason === "string"
			) {
				permissionDenialDetail = event.payload.reason;
			}
			if (
				event.type === "pancode_permission_resolved" &&
				typeof event.payload?.reason === "string" &&
				event.payload.reason.startsWith(WORKER_REFUSAL_LIMIT_PREFIX)
			) {
				permissionDenialDetail = event.payload.reason;
				refusalLimit ??= "reached";
			}
			const brokered =
				event.type === "pancode_permission_resolved" &&
				grantAttempt !== undefined &&
				runIdForPermissionAudit !== null &&
				typeof event.payload?.requestId === "string"
					? grantBroker.findByWorker(runIdForPermissionAudit, event.payload.requestId)
					: null;
			if (brokered !== null && event.payload && runIdForPermissionAudit !== null) {
				// The broker owns the audit rows of a brokered request; the worker's
				// resolution only settles a record it has not settled itself.
				const source = event.payload.source;
				const approved = event.payload.decision === "approved";
				if (source === "timeout") escalationCounts.timedOut += 1;
				else if (source === "main" || source === "operator") {
					if (approved) escalationCounts.approved += 1;
					else {
						escalationCounts.denied += 1;
						// A judge or main-agent denial must not read as the person's on the receipt.
						escalationDeniedBy =
							source === "operator" ? "operator" : brokered.reviewer === "safety-judge" ? "safety judge" : "main agent";
					}
				}
				grantBroker.workerResolved(
					runIdForPermissionAudit,
					brokered.workerRequestId,
					approved ? "approved" : "denied",
					typeof event.payload.reason === "string" ? event.payload.reason.slice(0, 500) : "resolved by the worker",
				);
			} else if (event.type === "pancode_permission_resolved" && event.payload && typeof event.payload.tool === "string") {
				// Escalation resolutions already have a request event. Policy
				// deny/fail is non-stalling, so dispatch mints the adjacent pair.
				const source = event.payload.source;
				const granted = (source === "operator" || source === "main") && event.payload.decision === "approved";
				// An answer another PanCode process gave through the run's grant records names that process.
				const elsewhere =
					source === "operator" && typeof event.payload.requestId === "string"
						? answeredElsewhere.get(event.payload.requestId)
						: undefined;
				if (elsewhere !== undefined) answeredElsewhere.delete(event.payload.requestId as string);
				const decidedBy =
					elsewhere !== undefined
						? "operator:another-process"
						: source === "operator"
							? "operator"
							: source === "main"
								? "main"
								: source === "remembered"
									? "remembered-denial"
									: source === "timeout"
										? "timeout"
										: source === "binding"
											? "policy:grant-binding"
											: "policy:no-operator";
				const requestId =
					typeof event.payload.requestId === "string"
						? event.payload.requestId
						: source === "operator" || source === "timeout" || source === "remembered" || source === "main"
							? undefined
							: `worker-permission-${++workerPolicyPermissionCounter}`;
				const origin = runIdForPermissionAudit !== null ? `worker:${runIdForPermissionAudit}` : undefined;
				const actionClass = typeof event.payload.actionClass === "string" ? event.payload.actionClass : "unknown";
				const reason =
					elsewhere !== undefined
						? answeredElsewhereReason(granted ? "approve" : "deny", elsewhere)
						: typeof event.payload.reason === "string"
							? event.payload.reason
							: `${event.payload.tool} requires approval`;
				// A remembered answer never raised an escalation card, so it mints
				// the adjacent request/resolve pair the way policy denials do.
				if (
					(decidedBy === "policy:no-operator" || decidedBy === "policy:grant-binding" || source === "remembered") &&
					requestId &&
					origin
				) {
					emitApproval(context.bus, "approval.requested", {
						tool: event.payload.tool,
						actionClass,
						requestId,
						...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
						origin,
						requestedBy: runIdForPermissionAudit ?? undefined,
						rejection: { short: reason, detail: reason, hints: [] },
					});
				}
				if (source === "operator") {
					if (granted) escalationCounts.approved += 1;
					else escalationCounts.denied += 1;
				} else if (source === "timeout") {
					escalationCounts.timedOut += 1;
				}
				emitApproval(context.bus, "approval.resolved", {
					status: granted ? "granted" : "denied",
					tool: event.payload.tool,
					...(requestId !== undefined ? { requestId } : {}),
					...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
					...(origin !== undefined ? { origin } : {}),
					decidedBy,
					actionClass,
					reason,
					...(source === "timeout" ? { fallback: spec.escalation?.fallback ?? "deny" } : {}),
					...(runIdForPermissionAudit !== null ? { requestedBy: runIdForPermissionAudit } : {}),
				});
			}
			if (event.type === "pancode_tool_finish" && event.payload && typeof event.payload.tool === "string") {
				recordToolCompletion(inFlightTools, event.payload);
				recordCallFinish(inFlightCalls, event.payload);
				const tool = pendingCapabilities.get(event.payload.toolCallId ?? "") ?? event.payload.tool;
				pendingCapabilities.delete(event.payload.toolCallId ?? "");
				if (tool === ToolNames.Gateway && event.payload.toolCallId)
					gatewayFinishes.set(event.payload.toolCallId, { ...event.payload, tool });
				else recordToolFinish(toolStats, { ...event.payload, tool });
				if (isSkillActivation(event.payload.skillActivation)) {
					skillActivations.push(event.payload.skillActivation);
				}
				foldToolDecision(
					event.payload,
					tool,
					safetyDecisionCounts,
					blockedAttempts,
					guardBlockedAttempts,
					permissionRequestedAttempts,
				);
			}
		};

		// The worker is already live; any failure to establish its tracking row
		// must not leave an orphaned subprocess holding a concurrency slot.
		let envelope!: RunEnvelope;
		let runningRowPersisted: Promise<void> = Promise.resolve();
		let lineage!: RunLineage;
		let identity!: ReturnType<typeof detectRunIdentity>;
		try {
			envelope = ledgerRef.create({
				projection: runLedgerProjection(req, lifecycle.pathScope, lifecycle.envelope.withheld),
				...(req.runIdHint !== undefined ? { id: req.runIdHint } : {}),
				agentId: req.agentId,
				executionRole: withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0),
				agentAudience: lifecycle.agentAudience,
				requestOrigin: lifecycle.requestOrigin,
				...rootOriginFields(req),
				task: req.task,
				...(req.intent !== undefined ? { intent: structuredClone(req.intent) } : {}),
				budget: lifecycle.budgetEnvelope,
				targetId: lifecycle.target.target.id,
				wireModelId: lifecycle.target.wireModelId,
				runtimeId: lifecycle.target.runtime.id,
				runtimeKind: lifecycle.runtimeKind,
				timing,
				sessionId: req.ownerSessionId ?? null,
				cwd: lifecycle.cwd,
				sessionShellHash: lifecycle.sessionShellHash,
				dynamicHash: lifecycle.dynamicHash,
				promptSignature: lifecycle.promptSignature,
				toolSignature: lifecycle.toolSignature,
			});
			if (req.record === true)
				ledgerRef.update(envelope.id, {
					recording: recordingJournal.start(envelope.id, placement?.node ?? LOCAL_RUN_NODE),
				});
			runIdForPermissionAudit = envelope.id;
			if (grantAttempt !== undefined) grantRunFallbacks.set(envelope.id, spec.escalation?.fallback ?? "deny");
			lineage = lineageFor(req, envelope.id);
			if (req.lineage === undefined) {
				if (capacityLease.assignmentId !== lineage.rootRunId) {
					capacityAdmission.rename(capacityLease.leaseId, lineage.rootRunId);
					await renameStoredAssignment(capacityLease.assignmentId, lineage.rootRunId);
				}
				leaseSlot.transferToAssignment();
			}
			if (agentLedgerId !== null) {
				const attribution: AgentLedgerAttribution = {
					runId: envelope.id,
					assignmentId: lineage.rootRunId,
					agentId: req.agentId,
					nodeId: placed.id,
				};
				agentLedgerAttribution = attribution;
				// The hub replays the whole board on subscription, so this mirror is
				// complete whatever this run's spawn timing was. A held follower's
				// handle refuses deliveries until its worker exists, and the hub drops a
				// subscriber that refuses one, so that run subscribes when it starts.
				const ledgerId = agentLedgerId;
				const boardRunId = envelope.id;
				const subscribeBoard = (): (() => void) | null =>
					lifecycle.runtimeKind !== "http"
						? null
						: subscribeAgentLedger(ledgerId, boardRunId, (entries) =>
								sendToWorker === undefined
									? false
									: sendToWorker({
											type: "ledger_delta",
											entries: entries.filter((entry) => {
												if ((entry.flowRestrictions?.restrictions.length ?? 0) === 0) return true;
												if (spec.flowPolicy === undefined || lifecycle.runtimeKind !== "http") return false;
												return (
													flowTransferRefusal(
														compileWorkerFlowPolicy(spec.flowPolicy),
														entry.flowRestrictions ?? null,
														resolveModelDestination({
															targetId: lifecycle.target.target.id,
															runtimeId: lifecycle.target.runtime.id,
															url: lifecycle.target.target.url,
															model: lifecycle.target.wireModelId,
														}),
													) === null
												);
											}),
										}),
							);
				if (heldFollower) {
					subscribeHeldBoard = () => {
						unsubscribeAgentLedger = subscribeBoard();
					};
				} else {
					unsubscribeAgentLedger = subscribeBoard();
				}
				for (const post of heldLedgerPosts.splice(0)) appendLedgerPost(attribution, post.body, post.flowRestrictions);
			}
			identity = detectRunIdentity();
			ledgerRef.update(envelope.id, {
				status: "running",
				pid: worker.pid,
				lineage: publishedLineage(lineage, hostRun),
				identity,
				node: placement?.node ?? LOCAL_RUN_NODE,
				...(placement?.reroutes !== undefined && placement.reroutes.length > 0
					? { reroutes: [...placement.reroutes] }
					: {}),
				...(lifecycle.pipeline ? { pipeline: lifecycle.pipeline } : {}),
				...(lifecycle.briefing ? { briefing: lifecycle.briefing } : {}),
				...(req.contextSeed ? { workerContext: structuredClone(req.contextSeed.provenance) } : {}),
				...(req.gate !== undefined ? { gate: req.gate } : {}),
				...(req.council !== undefined ? { council: req.council } : {}),
				...(req.plan !== undefined ? { plan: req.plan } : {}),
				...(lifecycle.personaOverride ? { personaOverride: lifecycle.personaOverride } : {}),
				...(lifecycle.decisionRefs ? { decisionRefs: lifecycle.decisionRefs } : {}),
				...(heartbeatAt ? { heartbeatAt: heartbeatIso(heartbeatAt) } : {}),
			});
			observer?.onAdmitted({
				runId: envelope.id,
				pid: worker.pid,
				runtimeKind: lifecycle.runtimeKind,
			});
			// One durable write at start so sibling processes (pancode fleet status)
			// can observe the running row; finalization persists the terminal state.
			// Awaited only after `active` holds the run: an fsync wait here kept a
			// spawned retry out of `active`, so snapshot and abort could not see it.
			// A failed write leaves the row dirty for the terminal persist (#428).
			runningRowPersisted = persistLedgerInBackground(ledgerRef, envelope.id);

			// Fleet-visibility facts for the board: node placement, gate role,
			// reroute lineage depth, and the model context window for the
			// per-worker meter. All optional so consumers degrade to local/plain.
			const fleetIdentity = {
				sessionId: req.ownerSessionId ?? null,
				...rootOriginFields(req),
				budget: lifecycle.budgetEnvelope,
				...(endpoint !== null ? { endpoint: { key: endpoint.key, label: endpoint.label, limit: endpoint.limit } } : {}),
				...(placement !== undefined && placement !== null ? { node: placement.node.id } : {}),
				...(req.gate !== undefined ? { gate: { role: req.gate.role, cycle: req.gate.cycle } } : {}),
				...(req.council !== undefined ? { council: req.council } : {}),
				...(req.reroutes !== undefined && req.reroutes.length > 0 ? { rerouteCount: req.reroutes.length } : {}),
				...(lifecycle.target.modelCapabilities !== undefined &&
				lifecycle.target.modelCapabilities !== null &&
				lifecycle.target.modelCapabilities.contextWindow > 0
					? { contextWindow: lifecycle.target.modelCapabilities.contextWindow }
					: {}),
			};
			const runId = envelope.id;
			const startedLineage = lineage;
			const journalContext = runJournal?.context ?? sinklessRunContext(runId, req.ownerSessionId);
			const publishStarted = (live: SpawnedWorker): void => {
				context.bus.emit(
					"run.started",
					{
						runId,
						agentId: req.agentId,
						task: req.task,
						agentAudience: lifecycle.agentAudience,
						requestOrigin: lifecycle.requestOrigin,
						targetId: lifecycle.target.target.id,
						wireModelId: lifecycle.target.wireModelId,
						runtimeId: lifecycle.target.runtime.id,
						runtimeKind: lifecycle.runtimeKind,
						pid: live.pid,
						...(live.processCommand !== undefined ? { processCommand: live.processCommand } : {}),
						...fleetIdentity,
						...routeMoveFields(req, lifecycle.target.target.id, lifecycle.target.wireModelId),
						assignmentId: startedLineage.rootRunId,
						attempt: startedLineage.attempt,
						...(req.parentToolCallId !== undefined ? { parentToolCallId: req.parentToolCallId } : {}),
					},
					journalContext,
				);
			};
			// A held follower is admitted with its row, but run.started waits for its child process to be live.
			if (req.lineage !== undefined || heldFollower) {
				context.bus.emit(
					"run.enqueued",
					{
						runId: envelope.id,
						agentId: req.agentId,
						task: req.task,
						agentAudience: lifecycle.agentAudience,
						requestOrigin: lifecycle.requestOrigin,
						targetId: lifecycle.target.target.id,
						wireModelId: lifecycle.target.wireModelId,
						runtimeId: lifecycle.target.runtime.id,
						runtimeKind: lifecycle.runtimeKind,
						...fleetIdentity,
					},
					runJournal?.context,
				);
			}
			if (heldFollower) {
				onFollowerStarted = (started) => {
					try {
						// Replace only this process's own vouch: a row written after the start already names the
						// worker, and one that settled meanwhile keeps what it recorded.
						if (ledgerRef.get(runId)?.pid === process.pid) {
							// The pid goes with the follower's own heartbeat: `fleet cancel` tells a recycled pid from
							// this worker by a heartbeat later than its start, and no spend write refreshes it (FL-24).
							ledgerRef.update(runId, { pid: started.pid, heartbeatAt: heartbeatIso(started.heartbeatAt) });
							void persistLedgerInBackground(ledgerRef, runId);
						}
						subscribeHeldBoard?.();
						publishStarted(started);
					} catch (error) {
						// The worker is already live; its run settles through the worker as any other does.
						reportDispatchDiagnostic("record a held follower's start", error);
					}
				};
				if (followerWorker !== null) onFollowerStarted(followerWorker);
			} else publishStarted(worker);
		} catch (error) {
			// A capture started above would otherwise keep its manifest at "recording".
			if (envelope !== undefined) recordingJournal.terminal(envelope.id, "failed");
			try {
				worker.abort();
			} catch (abortError) {
				reportDispatchDiagnostic("abort orphaned worker after ledger failure", abortError);
			}
			await closeRunJournal();
			leaseSlot.release();
			throw error;
		}

		// Domain-owned ingestion starts here, whether or not any external
		// consumer ever iterates the returned stream: meters, tool stats, finish
		// contract state, permission audit events, and output capture fold in
		// the pump; consumers get a bounded replay tee. Events the worker
		// emitted before this point are still queued in the spawn channel.
		const routeWarnings = [
			...(lifecycle.target.routeWarning !== undefined ? [lifecycle.target.routeWarning] : []),
			...(lifecycle.target.resolutionWarnings ?? []),
		];
		const eventPump = startDispatchEventPump(workerEvents, foldWorkerEvent, {
			...(routeWarnings.length > 0
				? { prelude: routeWarnings.map((message) => ({ type: "route_warning", level: "warning", message })) }
				: {}),
			onEvent: (workerEvent) => {
				// A node worker words its missing-component remedy for its own machine.
				const event =
					placement?.node && placement.node.kind !== "local"
						? nodeComponentRemedyEvent(workerEvent, placement.node.id)
						: workerEvent;
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
					event,
				});
			},
			onError: (error) => {
				toolTelemetryIngestionErrors += 1;
				reportDispatchDiagnostic(`ingest events for run ${envelope.id}`, error);
			},
		});

		const startedAt = envelope.startedAt;

		let resolveFinal!: (receipt: RunResult) => void;
		let rejectFinal!: (error: unknown) => void;
		const finalPromise = new Promise<RunResult>((res, rej) => {
			resolveFinal = res;
			rejectFinal = rej;
		});

		const activeRun: ActiveRun = {
			runId: envelope.id,
			req,
			abort: () => {
				callsAtAbort ??= [...inFlightCalls.values()];
				abort();
			},
			kill: abort,
			...(steer ? { steer } : {}),
			...(resolvePermission ? { resolvePermission } : {}),
			...(holdPermission ? { holdPermission } : {}),
			promise: workerDone.then(
				() => undefined,
				() => undefined,
			),
			recipe: lifecycle.recipe,
			permit: lifecycle.permit,
			...(preparation?.detached ? { detached: true } : {}),
			startedAt,
			timing,
			targetId: lifecycle.target.target.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			agentId: req.agentId,
			task: req.task,
			budget: lifecycle.budgetEnvelope,
			cwd: lifecycle.cwd,
			node: placement?.node ?? null,
			aborted: false,
			abortDetail: null,
			abortCause: null,
			stallKilled: false,
			stallTimeoutMs: null,
			budgetExempt: budgetExemptRoute(lifecycle.target.effectivePricing),
			lineage,
			...(hostRun === undefined ? {} : { hostRun }),
			heartbeatAt,
			heartbeatStatus: "alive",
			// `required` refuses a command it cannot sandbox, and so does a worker whose backend this host saw work.
			...(spec.sandbox !== undefined && (spec.sandbox.mode === "required" || spec.sandbox.backendExpected === true)
				? { shellConfined: true as const }
				: {}),
			meter: tokenMeter,
			finalPromise,
		};

		const toolTelemetryCoverageOf = (
			ingestionErrors: number,
			unfinishedCount: number,
		): "complete" | "partial" | "unavailable" =>
			lifecycle.runtimeKind === "subprocess"
				? "unavailable"
				: ingestionErrors > 0 || unfinishedCount > 0
					? "partial"
					: "complete";
		const telemetryIngestionErrorsOf = (result: SpawnedWorkerResult): number =>
			toolTelemetryIngestionErrors +
			malformedWorkerStdoutLineCount(result) +
			(result.evidenceIncomplete !== undefined ? 1 : 0);

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
			const finalFailureMessage = mergeWorkerDiagnosticFailure(failureMessage, result, includeDiagnostics);
			const safetyMetadata = safety.policy?.metadata() ?? null;
			const protectedArtifacts = protectedArtifactReceiptSummary(spec.protectedArtifactState);
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
				outcomeCode,
				lineage: publishedLineage(lineage, hostRun),
				...(req.intent !== undefined ? { intent: structuredClone(req.intent) } : {}),
				identity,
				node: placement?.node ?? LOCAL_RUN_NODE,
				...(placement?.reroutes !== undefined && placement.reroutes.length > 0
					? { reroutes: [...placement.reroutes] }
					: {}),
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
				...(externalTelemetry ? { externalTelemetry } : {}),
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
				effectiveFailover: failoverModeFor(req),
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
					...(grantAttempt !== undefined ? receiptGrantAudit(grantBroker.list({ runId: envelope.id }), envelope.id) : {}),
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
					...(trustedFlow !== null ? { flowRestrictions: trustedFlow } : {}),
					runtimeLimitations: lifecycle.runtimeLimitations,
					// A remote worker reports its node's recorded sandbox; this host's answer would
					// be a claim about the wrong machine.
					...(lifecycle.target.runtime.kind === "http"
						? {
								sandbox: workerSandboxReceipt(
									lifecycle.settings?.safety.sandbox ?? "auto",
									spec.sandbox,
									lifecycle.placedSandbox,
								),
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
			lineage,
			hostRun,
		};

		// The worker is spawned and its ledger row exists, so from here it can
		// write and the batch barrier has to wait for it. Registered after the
		// try/catch at 4939-5068, which aborts the worker and releases the lease on
		// failure, so a run that never reaches the barrier is never made live.
		// Paired with the abandon in dispatch(), which fires the moment
		// finalPromise settles.
		settlement?.live(envelope.id);

		(async (): Promise<RunResult> => {
			try {
				const result = await workerDone;
				// #425: stop board traffic as soon as the process settles, before receipt work awaits.
				unsubscribeAgentLedger?.();
				unsubscribeAgentLedger = null;
				recordingJournal.gap(envelope.id, result.droppedDisplayFrames ?? 0);
				// The receipt reads meters the domain pump fills. Finalization
				// always waits (bounded by the drain grace) for the pump to finish
				// the source stream, whether or not an external consumer ever
				// subscribed, so a fast worker cannot seal a zero-token receipt.
				const drained = await awaitEventDrain(eventPump.done);
				if (!drained) {
					runJournal?.gap("writer-drop");
					callUsage?.gap();
					recordingJournal.gap(envelope.id, 1);
					toolTelemetryIngestionErrors += 1;
					reportDispatchDiagnostic(`run ${envelope.id}`, new Error("event stream did not drain before run finalization"));
				}
				const malformedFrames = malformedWorkerStdoutLineCount(result);
				const lostCallFrames = malformedFrames + (result.evidenceIncomplete !== undefined ? 1 : 0);
				if (lostCallFrames > 0) {
					// An unparseable line is an invalid record; a trail a signal or an undrained lane cut short dropped
					// whatever the worker still held (#434).
					if (malformedFrames > 0) runJournal?.gap("invalid-record", malformedFrames);
					if (result.evidenceIncomplete !== undefined) runJournal?.gap("writer-drop");
					callUsage?.gap(lostCallFrames);
				}
				// Only a drained stream can show an attempt will never settle; a late frame would settle it twice (#434).
				if (drained) runJournal?.settleCalls(callUsage?.settleOpen("internal") ?? []);
				const finalCallUsage = callUsage?.snapshot();
				if (finalCallUsage) tokenMeter.usage = finalCallUsage;
				workerApprovalWindows.settleRun(envelope.id);
				dropAdoptedAsks(envelope.id);
				// The worker is gone: every grant it held settles now, after its last
				// execution report drained. Retries run as new attempts with new requests.
				if (grantAttempt !== undefined) {
					grantBroker.revokeRun(envelope.id, "the worker exited", { final: true });
					grantRunFallbacks.delete(envelope.id);
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
				if (detail === "permission_required" && permissionDenialDetail !== null) {
					terminationDetail = `${detail}; ${permissionDenialDetail}`;
					failureMessage = permissionDenialDetail;
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
						remoteImport = await importFleetChanges(
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
						assistantText: finishContractAssistantText,
						assistantTurnId: finishContractAssistantTurnId,
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
								runningAtStop: callsAtAbort,
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
				let graded = grade(gradeContract, gradeFacts);
				const applyGrade = (next: GradeVerdict): void => {
					graded = next;
					finalOutcome = next.outcome;
					outcomeCode = next.outcomeCode;
					finalDetail = next.detail;
					if (next.messageChanged && next.detail !== null) failureMessage = next.detail;
				};
				let finalOutcome: RunOutcome = graded.outcome;
				let finalDetail: string | null = graded.detail;
				applyGrade(graded);
				// A write worker that stopped to ask for wider write roots changed
				// nothing; whether the assignment continues is the request's decision.
				let writeRootRequest: string | null = null;
				const askedWriteRoots =
					finalOutcome === "succeeded" && gradeContract.role === "builder" && mutatedPathCount === 0
						? writeRootRequestFromEntries(finishContractEntries)
						: null;
				if (askedWriteRoots !== null) {
					const resolution = resolveWriteRootRequest(req, askedWriteRoots);
					const routable = resolution.ok && req.mainGrantRoute?.kind === "yield" && typeof req.ownerSessionId === "string";
					if (resolution.ok && routable) writeRootPark.stage(envelope.id, resolution.request);
					writeRootRequest = writeRootRequestDetail(askedWriteRoots, resolution, routable);
				}
				// Close steering provenance before taking receipt snapshots. A late
				// acknowledgement after the bounded drain cannot race the sealed facts.
				const steering = snapshotSteeringProvenance();
				const capturedOutput = outputCapture.snapshot();
				const finalText = capturedOutput?.state === "final" ? capturedOutput.text : null;
				const resultContract = validateRecipeResult({
					contract: appliedResultContract,
					reachedTerminalResult: resultContractWasDue(finalOutcome, outcomeCode, refusalLimit === "reported"),
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
						...(escalationDeniedBy !== undefined ? { deniedBy: escalationDeniedBy } : {}),
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
						: validationGrounding !== null &&
								invalidatesQuality(validationGrounding) &&
								resultContract.fact.quality === "pass"
							? { ...resultContract.fact, quality: "unmeasured" }
							: resultContract.fact;
				// FX-19: a run owing evidence it did not gather grades fail, so retry and summaries count it.
				if (graded.qualityFail && sealedResultContractFact !== null)
					sealedResultContractFact = { ...sealedResultContractFact, quality: "fail" };
				if (validationGrounding !== null && validationGrounding.ungrounded.length > 0)
					detailNotes.push(describeUngroundedValidations(validationGrounding));
				if (observationNote !== null && sealedResultContractFact?.quality === "pass") {
					sealedResultContractFact = { ...sealedResultContractFact, quality: "unmeasured" };
					detailNotes.push(observationNote);
				}
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
					workerSuccessful: finalOutcome === "succeeded",
					...(hostVerificationSandboxPolicy !== undefined ? { shellSandbox: hostVerificationSandboxPolicy } : {}),
					onDiagnostic: (error: unknown) =>
						reportDispatchDiagnostic(`write host verification memo for ${envelope.id}`, error),
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
				const checkoutAfter =
					checkoutBaseline === null ? null : await snapshotCheckoutSince(checkoutBaseline, lifecycle.cwd);
				// Refused attempts often leave their probe script behind; the operator learns of it here, not by accident.
				const strayFiles =
					refusalLimit !== null && checkoutBaseline !== null && checkoutAfter !== null
						? addedUntrackedPaths(checkoutBaseline, checkoutAfter)
						: [];
				const strayNote =
					strayFiles.length > 0
						? `untracked files this run left in the checkout: ${strayFiles.slice(0, 5).join(", ")}${strayFiles.length > 5 ? `, and ${strayFiles.length - 5} more` : ""}`
						: null;
				const hostRejection = hostVerificationRejection(hostVerification);
				const workerSucceeded = finalOutcome === "succeeded";
				gradeFacts.host = {
					rejection: hostRejection === null ? null : { code: hostRejection.outcomeCode, detail: hostRejection.detail },
				};
				applyGrade(grade(gradeContract, gradeFacts));
				// A run in the current tree has no merge to withhold, so a change that
				// deletes existing test cases fails the run instead; the edits stay for
				// the operator to judge (flywheel F-D1). A task that asks for the removal is exempt.
				if (checkoutBefore !== null && finalOutcome === "succeeded" && !taskRequestsTestRemoval(req.task)) {
					gradeFacts.removedTests = removedTestCases(
						await changedCheckoutDiff(checkoutBefore, checkoutAfter, (path) => isTestFilePath(path) || path.endsWith(".rs")),
					);
					applyGrade(grade(gradeContract, gradeFacts));
				}
				if (strayNote !== null) {
					detailNotes.push(strayNote);
					failureMessage = [failureMessage, strayNote].filter(Boolean).join("; ");
				}
				// The detail the operator reads so far: the graded words, then the notes beside them.
				const notedDetail = (): string | null => [finalDetail, ...detailNotes].filter(Boolean).join("; ") || null;
				// Assurance is the one value the merge gate, the exit code and a parent's finish contract read (4.8).
				const assuranceQuality = {
					typedValidations: [
						...typedValidationFactsFromVerifyCalls(
							snapshotToolStats(toolStats),
							verifyCalls.calls,
							runEffects.checkFreshness(),
						),
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
					finalOutcome === "succeeded" &&
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
				const assuranceHeld = req.taskWorktree !== undefined && outcomeCode === "assurance_compromised";
				// A merge-mode run the worker finished but host verification rejected
				// keeps its branch like a withheld merge, so its tree is committed there
				// for the operator's one merge command instead of left as loose edits.
				const hostRejectedMerge =
					req.taskWorktree !== undefined && (req.apply ?? "merge") === "merge" && hostRejection !== null && workerSucceeded;
				// A worker stopped at its tool-call cap, or one that reported it did not
				// finish, commits what it changed on its preserved branch as a partial
				// result: never merged, never dropped.
				const cappedPartial =
					!workerSucceeded && preservesPartialResult(outcomeCode, req.taskWorktree !== undefined, finalOutcome);
				let worktreeReceipt: RunResultDraft["worktree"];
				// Set when the operator discarded the branch and worktree from the merge card.
				let worktreeDiscarded = false;
				// What the last apply pass accounted for; automatic cleanup removes nothing beyond it.
				let accounted: TaskWorktreePreview | undefined;
				const onAccounted = (entry: TaskWorktreePreview): void => {
					accounted = entry;
				};
				// Set once the task claim is gone, so the closing settle below does not
				// look for it. A discard that removed the worktree but not the branch
				// releases the claim too: nothing of PanCode's is left to guard.
				let claimReleased = false;
				// Why landing the run's work failed or was held (V6); the grader seals it beside every other rule.
				let landingFailure: { code: RunOutcomeCode | null; detail: string } | null = null;
				// The operator merged a held branch from the card: a person accepted the result (V6).
				let operatorMerged = false;
				const landingAttempted = req.taskWorktree !== undefined;
				if (
					req.taskWorktree !== undefined &&
					(finalOutcome === "succeeded" || hostRejectedMerge || cappedPartial || assuranceHeld)
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
							failureMessage = notedDetail() ?? failureMessage;
						}
					} else if (hostRejectedMerge || assuranceHeld) {
						// Only a commit on the branch makes the command true; a worker that
						// changed nothing leaves the branch at its base.
						if (worktreeReceipt.commit !== undefined && (worktreeReceipt.changedPaths?.length ?? 0) > 0) {
							detailNotes.push(
								`its work is committed on the preserved branch ${req.taskWorktree.branch}, \`pancode fleet land ${req.taskWorktree.branch}\` previews the merge and \`pancode fleet land ${req.taskWorktree.branch} --yes\` lands it if you accept the failed check; ${landCardClause(req.taskWorktree.branch)}`,
							);
							failureMessage = notedDetail() ?? failureMessage;
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
									accounted?.commit === previewedCommit ? accounted : previewTaskWorktree(req.taskWorktree, previewedCommit);
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
								? await askWithheldMerge(activeRun, {
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
								accounted = preview;
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
				finalDetail = landingFailure !== null ? finalDetail : preLandingDetail;
				if (landingFailure !== null) failureMessage = finalDetail ?? failureMessage;
				if (req.taskWorktree !== undefined && worktreeReceipt === undefined) {
					worktreeReceipt = snapshotUnappliedTaskWorktree(req.taskWorktree, req.apply ?? "merge");
					// An already failed run whose HEAD also moved says so, so the
					// operator knows the preserved branch lacks the work (F5).
					if (worktreeReceipt.detail !== undefined) {
						finalDetail = [finalDetail, worktreeReceipt.detail].filter(Boolean).join("; ");
						failureMessage = finalDetail;
					}
				}
				if (graded.qualityGateFailure) evidence.qualityGateFailure = true;
				if (graded.retryObligation !== null) evidence.obligationUnmet = graded.retryObligation;
				const runVerdict: RunVerdict = {
					version: 1,
					obligation: gradeContract.obligation,
					rules: graded.rules,
					assurance,
				};
				const status = runStatusForOutcome(finalOutcome);
				const failureClass = classifyFailure(evidence, result, finalOutcome, outcomeCode, providerErrorMessage);
				const contextOverflow = isContextOverflowFailure(failureClass, result, outcomeCode, providerErrorMessage);
				// A released node's skew refusal asks for a re-dispatch that earns the
				// same refusal; the receipt reports the build skew instead.
				let receiptResult =
					failureClass === "node-version" && typeof result.stderrTail === "string"
						? { ...result, stderrTail: honestWorkerSpecSkewText(result.stderrTail) }
						: result;
				// A node worker missing an SDK component names the install for its own
				// machine; the operator runs the client command that installs it there.
				if (failureClass === "deterministic-task" && placed.kind !== "local") {
					if (failureMessage !== undefined) failureMessage = nodeComponentRemedy(failureMessage, placed.id);
					if (finalDetail !== null) finalDetail = nodeComponentRemedy(finalDetail, placed.id);
					if (typeof receiptResult.stderrTail === "string")
						receiptResult = { ...receiptResult, stderrTail: nodeComponentRemedy(receiptResult.stderrTail, placed.id) };
				}
				const receiptDraft = buildReceiptDraft(
					receiptResult,
					endedAt,
					status,
					finalOutcome,
					finalDetail,
					capturedOutput,
					steering,
					sealedResultContractFact,
					validationGrounding === null ? null : { ...validationGrounding, ungrounded: [...validationGrounding.ungrounded] },
				);
				receiptDraft.verdict = runVerdict;
				// What the run's limitation calls recorded, which its own report can leave out (row 371).
				const recordedLimitationCalls = recordedLimitationsFromEntries(finishContractEntries);
				if (recordedLimitationCalls.length > 0) receiptDraft.recordedLimitations = recordedLimitationCalls;
				const terminal = resolveRunTerminalReason(evidence, outcomeCode);
				resolvedTerminal = terminal;
				Object.assign(receiptDraft, runSettlementReceiptFields(terminal, callUsage?.snapshot()));
				if (checkoutBaseline !== null) {
					if (checkoutAfter !== null && checkoutAfter.root === checkoutBaseline.root) {
						receiptDraft.checkoutChanges = {
							cwd: checkoutBaseline.root,
							changedPaths: changedCheckoutPaths(checkoutBaseline, checkoutAfter),
							attribution: "observed-delta",
						};
					}
				}
				if (hostVerification !== undefined) {
					receiptDraft.hostVerification = hostVerification;
					receiptDraft.verification = verificationWithHostVerdict(receiptDraft.verification, hostVerification);
				}
				if (remoteReturn && worktreeReceipt) {
					// The remote commit's byproducts stay on the node, so the local commit never saw them.
					const remoteLeft = remoteImport?.leftUncommitted;
					const localLeft = worktreeReceipt.leftUncommitted;
					worktreeReceipt = {
						...worktreeReceipt,
						...(remoteLeft !== undefined
							? {
									leftUncommitted: {
										count: remoteLeft.count + (localLeft?.count ?? 0),
										paths: [...remoteLeft.paths, ...(localLeft?.paths ?? [])].slice(0, LEFT_UNCOMMITTED_LIST_LIMIT),
									},
								}
							: {}),
						detail: [
							worktreeReceipt.detail,
							`SSH return from ${placed.id}: branch ${remoteReturn.worktree.branch}, path ${remoteReturn.worktree.path}, commit ${remoteImport?.commit ?? "not imported"}; remote work preserved unless the guarded local application succeeds`,
						]
							.filter(Boolean)
							.join("; "),
					};
				}
				worktreeReceipt = sealTaskWorktreeReceipt({ context }, req, envelope.id, worktreeReceipt, accounted, receiptDraft);
				// The harness read its own files unreconciled; the operator owns them and hears once per process.
				const peerStale = lifecycle.peerStale;
				if (
					peerStale !== undefined &&
					lifecycle.projectContext.peerInstructions?.delivery === "coexist" &&
					!staleNotices.has(peerStale.message)
				) {
					staleNotices.add(peerStale.message);
					context.bus.emit("run.scope_notice_raised", {
						code: "peer_instructions_stale",
						level: "warning",
						agentId: req.agentId,
						runId: envelope.id,
						files: peerStale.files,
						stale: peerStale.stale,
						message: peerStale.message,
					});
				}
				// A hypothesis slate the worker wrote enters the log only once the host accepted the run into the project
				// (#406): a merged task worktree's changed paths, or the observed writes of a run in the checkout that
				// settled succeeded; nothing the worker reported is used. The bytes are read here, in the same synchronous
				// step that accepted the run, and recorded after the receipt is sealed only while the files still hold them.
				let acceptedSlates: AcceptedWorkerSlates = [];
				const checkoutChanges = receiptDraft.checkoutChanges;
				const acceptedPaths =
					finalOutcome !== "succeeded"
						? []
						: req.taskWorktree !== undefined
							? worktreeReceipt?.applied === true
								? (worktreeReceipt.changedPaths ?? []).map((path) => resolvePath(req.taskWorktree?.root ?? lifecycle.cwd, path))
								: []
							: checkoutChanges !== undefined && checkoutBefore !== null
								? checkoutChanges.changedPaths.map((path) => resolvePath(checkoutChanges.cwd, path))
								: [...observedRunEffects.mutatedPaths];
				if (acceptedPaths.some((path) => path.endsWith(".json"))) {
					try {
						acceptedSlates = snapshotAcceptedWorkerSlates({
							projectCwd: req.taskWorktree?.root ?? lifecycle.cwd,
							paths: acceptedPaths,
						});
					} catch (error) {
						reportDispatchDiagnostic(`read hypothesis slates for ${envelope.id}`, error);
					}
				}
				const ledgerPatch: Partial<RunEnvelope> = {
					status,
					outcome: finalOutcome,
					outcomeCode,
					outcomeDetail: receiptDraft.outcomeDetail ?? finalDetail,
					...(steering.length > 0 ? { steering: steering.map((entry) => ({ ...entry })) } : {}),
					endedAt,
					exitCode: receiptDraft.exitCode,
					spend: receiptDraft.spend,
					spendSums: receiptDraft.spendSums,
					sessionShellHash: receiptDraft.sessionShellHash ?? null,
					dynamicHash: receiptDraft.dynamicHash ?? null,
					...(activeRun.heartbeatAt ? { heartbeatAt: heartbeatIso(activeRun.heartbeatAt) } : {}),
				};
				activeRun.sealing = true;
				if (runJournal === undefined) throw new Error(`run ${envelope.id} has no run journal to settle in`);
				const receipt = await settleRunResult(
					ledgerRef,
					envelope.id,
					sealRouteDecision(receiptDraft, routeObservation.decision),
					ledgerPatch,
					runJournal,
					{
						terminal,
						processExitCode: result.exitCode,
						frameType: result.channelFailure ?? null,
						usage: finalCallUsage?.facts,
						...(reportedRepairRounds !== undefined ? { repairRounds: reportedRepairRounds } : {}),
					},
				);
				// Host-verified reproduce and numeric-compare verdicts become claims in the operator's project, keyed by the
				// sealed receipt (#406). Awaited so a headless run cannot exit first; a failed write never fails the run.
				if (receipt.hostVerification !== undefined && receipt.hostVerification.checks.length > 0) {
					try {
						await recordHostVerificationClaims({
							runId: receipt.runId,
							receiptDigest: receipt.digest,
							checks: receipt.hostVerification.checks,
							projectCwd: req.taskWorktree?.root ?? lifecycle.cwd,
							...(hypothesisBindings !== undefined ? { hypotheses: hypothesisBindings } : {}),
						});
					} catch (error) {
						reportDispatchDiagnostic(`record claims for ${envelope.id}`, error);
					}
				}
				if (acceptedSlates.length > 0) {
					try {
						const ingested = await recordAcceptedWorkerSlates({
							runId: receipt.runId,
							receiptDigest: receipt.digest,
							projectCwd: req.taskWorktree?.root ?? lifecycle.cwd,
							slates: acceptedSlates,
						});
						if (ingested.drifted.length > 0)
							reportDispatchDiagnostic(
								`record hypotheses for ${envelope.id}`,
								new Error(
									`not recorded, changed after the host accepted the run: ${ingested.drifted.map((path) => relative(lifecycle.cwd, path) || path).join(", ")}`,
								),
							);
					} catch (error) {
						reportDispatchDiagnostic(`record hypotheses for ${envelope.id}`, error);
					}
				}
				if (lifecycle.runtimeKind !== "http" && agentLedgerId !== null && agentLedgerAttribution !== null) {
					void appendAgentLedgerReport(agentLedgerId, agentLedgerAttribution, receipt)
						.then((posted) => {
							if (posted.ok) publishAgentLedgerEntry(agentLedgerId, posted.entry);
							else reportDispatchDiagnostic(`publish final report for ${envelope.id}`, new Error(posted.reason));
						})
						.catch((error) => reportDispatchDiagnostic(`publish final report for ${envelope.id}`, error));
				}
				// Two independent ways a run's write record can fail to be a closed
				// list, and either one files it as `null` rather than as an empty
				// one. The difference decides whether the write boundary may clear a
				// path it did not see this run touch.
				//
				// The telemetry axis is whether the events were seen at all: a
				// subprocess runtime publishes no tool events, and a partial trail
				// has its holes exactly where an unobserved write would sit.
				//
				// The opacity axis is whether the events that were seen say enough.
				// A run that called bash, verify, dispatch, or steer to a clean exit
				// could have written through a channel no argument names, so nothing
				// in the checkout can be cleared on the strength of its absence from
				// the set. That run's window keeps today's blame-the-whole-diff
				// behaviour; a run that never touched such a tool keeps the
				// protection.
				const toolTelemetryComplete = receipt.safety?.toolTelemetry?.coverage === "complete";
				const downgrades: WriteBoundaryAttributionDowngrade[] = observedRunEffects.writeRecordDowngrades.map((entry) => ({
					reason: entry.reason,
					tool: entry.tool,
					toolCallId: entry.toolCallId,
					runId: envelope.id,
					stepId: null,
				}));
				if (!toolTelemetryComplete) {
					downgrades.push({
						reason: "incomplete_tool_telemetry",
						tool: null,
						toolCallId: null,
						runId: envelope.id,
						stepId: null,
					});
				}
				recordRunWriteAttribution(envelope.id, {
					recorded: [...observedRunEffects.mutatedPaths],
					complete: toolTelemetryComplete && observedRunEffects.writeRecordComplete,
					downgrades,
				});
				await ledgerRef.persist();
				if (worktreeReceipt?.applied === true && req.taskWorktree !== undefined) {
					try {
						if (remoteReturn && remoteImport) await cleanupFleetChangeReturn(remoteReturn, remoteImport);
					} catch (cleanupError) {
						reportDispatchDiagnostic(`clean applied task worktree ${req.taskWorktree.runId}`, cleanupError);
					}
				} else if (req.taskWorktree !== undefined && !claimReleased) {
					// The run is over and its worktree stays for the operator (preserve
					// mode, a failed run, a refused merge). Saying so on the claim keeps
					// restart recovery from reading it as a crash.
					try {
						// A canceled run that never produced work leaves nothing to keep. An idle builder that left its
						// obligation unmet keeps the tree until the retry decision below, since its retry runs in it.
						if (
							!(
								(finalOutcome === "canceled" ||
									(idleBuilderOutcome(outcomeCode) &&
										evidence.obligationUnmet === undefined &&
										!writeRootPark.isStaged(envelope.id))) &&
								discardIdleTaskWorktree(req.taskWorktree)
							)
						) {
							settleTaskWorktree(req.taskWorktree, accounted);
						}
					} catch (settleError) {
						reportDispatchDiagnostic(`settle task worktree ${req.taskWorktree.runId}`, settleError);
					}
				}
				active.delete(envelope.id);
				recordTargetOutcome(
					envelope.id,
					lifecycle.target.target.id,
					lifecycle.target.runtime.id,
					lifecycle.target.wireModelId,
					status,
					receipt.exitCode,
					failureClass,
				);
				recordNodeChannelOutcome(activeRun, finalOutcome, failureClass, finalDetail);
				accumulateFinalizedTotals(receipt);
				// A terminal event's readers show the sealed record, so the seal lands first with the feed's last rows in it.
				journalBridge?.closeFeed(finalOutcome, receipt.outcomeDetail, {
					runId: envelope.id,
					agentId: req.agentId,
					exitCode: receipt.exitCode,
				});
				await closeRunJournal();
				emitTerminalDispatchEvent({ context }, finalizing, receipt, finalOutcome);
				const continues = completeAssignmentAttempt(
					activeRun,
					receipt,
					finalOutcome,
					receipt.outcomeDetail ?? finalDetail,
					failureClass,
					contextOverflow,
					evidence.obligationUnmet,
				);
				// The idle tree kept above goes once no retry will run in it.
				if (
					!continues &&
					idleBuilderOutcome(outcomeCode) &&
					evidence.obligationUnmet !== undefined &&
					req.taskWorktree !== undefined &&
					worktreeReceipt?.applied !== true &&
					!claimReleased
				) {
					try {
						discardIdleTaskWorktree(req.taskWorktree);
					} catch (discardError) {
						reportDispatchDiagnostic(`discard idle task worktree ${req.taskWorktree.runId}`, discardError);
					}
				}
				return receipt;
			} catch (error) {
				await failFinalization(
					finalizing,
					{ ledger: ledgerRef, envelope, runJournal, terminal: resolvedTerminal, timing },
					error,
				);
				throw error;
			} finally {
				// A terminal seal that did not land fails the run, after its slot is released (#434).
				try {
					await closeRunJournal();
				} finally {
					unsubscribeAgentLedger?.();
					leaseSlot.release();
				}
			}
		})().then(resolveFinal, rejectFinal);

		active.set(envelope.id, activeRun);
		stopIfCapacityLost(envelope.id, capacityLease.leaseId);
		watchAssignmentDeadline(activeRun);
		// Same as the ACP path: return the handle once the running row is durable (#428).
		await runningRowPersisted;

		return attachRouteObservation({
			runId: envelope.id,
			events: eventPump.events,
			finalPromise,
			effectiveRequest: req,
		});
	}

	function dispatch(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	): ReturnType<typeof dispatchRequest> {
		if (draining) return Promise.reject(new AdmissionCanceledError());
		const operation = dispatchRequest(
			req,
			observer,
			{
				...preparation,
				signal: preparation?.signal
					? AbortSignal.any([preparation.signal, drainController.signal])
					: drainController.signal,
			},
			settlement,
		);
		dispatching.add(operation);
		operation
			.finally(() => dispatching.delete(operation))
			.catch(() => {
				// The original admission promise retains its error for the caller.
			});
		return operation;
	}

	/** Starts a boot recovery not yet started and settles once restart recovery has finished. */
	async function awaitStartupRecovery(): Promise<void> {
		if (startupRecovered) return;
		void options?.bootRecovery?.start();
		await startupRecovery;
	}

	async function dispatchRequest(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunResult>;
	}> {
		// Restart recovery settles before any run is admitted, so no stale
		// worktree or abandoned lease is reused (boot-recovery.ts).
		await awaitStartupRecovery();
		// A retry re-enters here with the request it was first admitted under, so
		// only a request that has never been stamped takes the current session.
		const sessionOrigin = options?.getSessionOrigin?.();
		if (req.ownerSessionId === undefined)
			req = { ...req, ownerSessionId: sessionOrigin?.id ?? options?.getSessionId?.() ?? null };
		if (req.ownerSessionCwdHash === undefined && sessionOrigin && sessionOrigin.id === req.ownerSessionId)
			req = { ...req, ownerSessionCwdHash: sessionOrigin.cwdHash };
		const constraints = snapshotTurnConstraints(preparation?.turnConstraints ?? req.turnConstraints);
		if (constraints) {
			req = {
				...req,
				turnConstraints: constraints,
				...(constraints.skills === "disabled" ? { noSkills: true } : {}),
				// A worker of a read-only run is read-only too, whatever its recipe.
				...(constraints.readOnly === true ? { readOnly: true } : {}),
			};
			// A task worktree is a checkout and a .git/worktrees entry in the
			// repository, and a host verification check runs a project command
			// unconfined; neither leaves the user's files alone.
			if (constraints.readOnly === true && req.worktree === true && req.taskWorktree === undefined)
				throw new Error(
					"dispatch: this run is read-only, so it cannot create a task worktree; dispatch without worktree: true",
				);
			if (constraints.readOnly === true && (req.resolvedVerification?.length ?? 0) > 0)
				throw new Error(
					"dispatch: this run is read-only, so it cannot run host verification checks; dispatch without intent.verification",
				);
			// Validate before creating worktrees or acquiring writer/capacity leases.
			previewFixed(req);
		}
		// The role is resolved from the request as admitted, a turn's read-only narrowing included, by the rule the
		// envelope applies, so the journal, the route tuple and the receipt carry the envelope's role (DESIGN 4.2). A
		// request that already names the recovery population (a fleet repair step) keeps it.
		if (req.executionRole !== "recovery")
			req = {
				...req,
				executionRole: requestRunRole(
					req,
					agentRoleFactsResolver((id) => agents.getSpec(id)),
				),
			};
		// Every attempt takes its own run identity before the writer lease; retries
		// join the original writer group through lineage.rootRunId (#434).
		if (placedInOwnWorktree(req)) req = { ...req, worktree: true };
		if (req.runIdHint === undefined && req.worktree !== true) req = { ...req, runIdHint: newRunId() };
		// DESIGN 4.5: every run has a wall clock from this call, so time queued for a slot counts; a retry keeps its root's.
		const wallRecipe = agents.get(req.agentId);
		const recipeWallMs = wallRecipe === null ? undefined : normalizeAgentSpec(wallRecipe).budget?.timeoutMs;
		const wallClock = resolveRunWall({
			capMs: runWallCapMs((getEffectiveSettings() ?? DEFAULT_SETTINGS).fleet.limits, req.requestOrigin),
			...(recipeWallMs !== undefined ? { recipeMs: recipeWallMs } : {}),
			startedAt: now(),
			deadlineAt: Math.min(
				req.assignmentDeadlineAt ?? Number.POSITIVE_INFINITY,
				preparation?.deadlineAt ?? Number.POSITIVE_INFINITY,
			),
		});
		let prepared: DispatchRequest = {
			...req,
			assignmentDeadlineAt: wallClock.deadlineAt,
			runWallMs: req.runWallMs ?? wallClock.wallMs,
		};
		let createdWorktree: DispatchRequest["taskWorktree"];
		let writerLease: WriterSetLease | undefined;
		const writerRecipe = agents.get(req.agentId);
		if (writerRecipe !== null && normalizeAgentSpec(writerRecipe).capabilityClass === "workspace-edit") {
			const checkout = req.taskWorktree?.root ?? gitCheckoutRoot(req.cwd ?? process.cwd());
			if (checkout !== null) {
				const roots = canonicalWriteRoots(req);
				const runId = req.runIdHint ?? req.lineage?.rootRunId;
				try {
					// A writer that would overlap a live set queues behind it until its run's deadline (DESIGN 4.5).
					writerLease = await joinWriterSet({
						checkout,
						deadlineAt: wallClock.deadlineAt,
						...(preparation?.signal !== undefined ? { signal: preparation.signal } : {}),
						onQueued: (waitingOn) =>
							reportDispatchDiagnostic(
								`writer set for ${req.agentId}`,
								new Error(`queued behind ${waitingOn}; it starts when that settles`),
							),
						// A read-only run writes nothing, so it carries no holder: the envelope's one definition of read-only.
						...(requestedWriteNone({
							readOnly: req.readOnly,
							capabilityClass: agents.listSpecs().find((spec) => spec.id === req.agentId)?.capabilityClass ?? null,
							hoareContract: false,
						})
							? {}
							: {
									member: {
										// One dispatch call's requests, and their retries, share a group.
										group: req.parentToolCallId ?? req.lineage?.rootRunId ?? req.runIdHint ?? newRunId(),
										roots: roots.length > 0 ? roots : null,
										isolated: req.worktree === true || req.taskWorktree !== undefined,
										agentId: req.agentId,
										...(runId !== undefined ? { runId } : {}),
									},
								}),
					});
				} catch (error) {
					// A refused writer never reaches the attempt below, whose failure
					// path returns the plan's reservation, so return it here.
					if (req.reservation !== undefined && req.lineage === undefined) {
						rollbackDispatchReservation(req.reservation.ownerId, now());
					}
					throw error;
				}
			}
		}
		if (req.worktree === true && req.taskWorktree === undefined) {
			const requestedCwd = resolvePath(req.cwd ?? process.cwd());
			const root = gitCheckoutRoot(requestedCwd);
			if (root === null) throw new Error("worktree_non_git_checkout");
			if (req.taskWorktreeDestination !== undefined && root !== req.taskWorktreeDestination) {
				writerLease?.release();
				throw new Error("dispatch: worktree merge destination differs from the approved execution snapshot");
			}
			// Admission sealed each check's cwd in the source checkout, before any
			// worktree existed. Verifying there judges the operator's tree, not the
			// candidate the worker produced (F6), so each check moves with the
			// worker. Sealed reference and baseline files stay where admission read them.
			const verificationRelatives = (req.resolvedVerification ?? []).map((check) => {
				const rel = relative(root, resolvePath(root, check.cwd));
				if (relativePathEscapes(rel)) {
					writerLease?.release();
					throw new Error(`dispatch: host verification check '${check.check}' runs outside the task worktree's checkout`);
				}
				return rel;
			});
			const runId = newRunId();
			let taskWorktree: NonNullable<DispatchRequest["taskWorktree"]>;
			try {
				// fleet.worktrees.root moves the working tree for local placement
				// only: with fleet nodes the run may land on another host, which
				// reaches the worktree by the project-root path alone.
				const fleetSettings = getEffectiveSettings()?.fleet;
				let worktreeRoot = resolveWorktreeRoot({
					setting: fleetSettings?.worktrees?.root ?? "disk",
					projectRoot: root,
					remoteEligible: (fleetSettings?.nodes?.length ?? 0) > 0,
				});
				const untrusted = prepareWorktreeParent(worktreeRoot);
				if (untrusted !== null) {
					worktreeRoot = {
						parent: diskWorktreeParent(root),
						kind: "disk",
						notice: `${untrusted}; using the project root`,
					};
				}
				if (worktreeRoot.notice !== undefined) {
					reportDispatchDiagnostic(`task worktree root for ${runId}`, new Error(worktreeRoot.notice));
				}
				taskWorktree = createTaskWorktree(root, runId, undefined, req.apply ?? "merge", worktreeRoot.parent);
			} catch (error) {
				writerLease?.release();
				throw error;
			}
			createdWorktree = taskWorktree;
			const cwdRelative = relative(root, requestedCwd);
			const workerCwd = resolvePath(taskWorktree.path, cwdRelative);
			const writeRoots = req.writeRoots?.map((entry) => {
				const rel = relative(root, entry);
				if (relativePathEscapes(rel)) return entry;
				// resolvePath drops the trailing slash that marks a directory root (D2).
				const remapped = resolvePath(taskWorktree.path, rel);
				return entry.endsWith("/") ? asDirectoryPathBoundary(remapped) : remapped;
			});
			const resolvedVerification = req.resolvedVerification?.map((check, index) => ({
				...check,
				argv: [...check.argv],
				cwd: resolvePath(taskWorktree.path, verificationRelatives[index] ?? "."),
			}));
			prepared = {
				...prepared,
				runIdHint: runId,
				taskWorktree,
				cwd: workerCwd,
				protectedArtifactRemap: { sourceRoot: root, workerRoot: taskWorktree.path },
				...(writeRoots === undefined ? {} : { writeRoots }),
				...(resolvedVerification === undefined ? {} : { resolvedVerification }),
			};
		}
		let handle: Awaited<ReturnType<typeof dispatchAttempt>>;
		try {
			preparation?.signal?.throwIfAborted();
			handle = await dispatchAttempt(prepared, observer, preparation, settlement);
			writerLease?.bindRun(handle.runId);
		} catch (error) {
			writerLease?.release();
			if (createdWorktree !== undefined) {
				try {
					// No commit accounted for anything: a fresh worktree holds its base and no untracked file.
					const kept = cleanupAccountedTaskWorktree(createdWorktree, { commit: createdWorktree.base, untracked: new Map() });
					if (kept !== null) {
						reportDispatchDiagnostic(
							`keep task worktree ${createdWorktree.runId} after admission failure`,
							new Error(keptTaskWorktreeDetail(createdWorktree, createdWorktree.base, kept)),
						);
					}
				} catch (cleanupError) {
					reportDispatchDiagnostic(`clean task worktree ${createdWorktree.runId} after admission failure`, cleanupError);
				}
			}
			if (req.reservation !== undefined && req.lineage === undefined) {
				rollbackDispatchReservation(req.reservation.ownerId, now());
			}
			throw error;
		}
		// A finalization that throws before the barrier, and an ACP handle that
		// never reaches it at all, must not park their siblings forever. A member
		// that already arrived is parked and abandon() is a no-op for it, so this
		// fires harmlessly on the normal path.
		if (settlement !== undefined) {
			const release = (): void => settlement.abandon(handle.runId);
			handle.finalPromise.then(release, release);
		}
		// Requests carrying lineage are internal attempts (retry or nested
		// orchestration) and retain the per-attempt handle contract.
		if (req.lineage) {
			const finalPromise = handle.finalPromise.finally(() => writerLease?.release());
			trackMemberWork(handle.runId, finalPromise);
			return { ...handle, finalPromise };
		}

		const assignment = assignments.open(handle.runId, assignmentPolicyFor(handle.effectiveRequest));
		persistAssignment(registerAssignment(assignment.id), `${assignment.id}:open`);
		// Attach before any await so a fast-finishing attempt cannot settle the
		// assignment (and close its stream) before attempt 1's frames are folded.
		assignments.attachAttempt(assignment.id, handle.events);
		// A finalization failure has no immutable receipt to settle with; preserve
		// the attempt error rather than leaving the assignment pending forever.
		handle.finalPromise.catch((error) => assignments.reject(assignment.id, error));
		const reservation = req.reservation;
		const terminal =
			reservation === undefined
				? assignment.terminal.finally(() => writerLease?.release())
				: assignment.terminal.finally(async () => {
						try {
							// Tracked so drain and stop wait for the shared capacity record. A
							// failed release is reported, never turned into a failed run whose
							// receipt already sealed its outcome (#428).
							await trackDurableWrite(releaseDispatchReservationMemberAsync(reservation.ownerId, reservation.memberId, now()));
						} catch (error) {
							reportDispatchDiagnostic(`release reservation member ${reservation.memberId}`, error);
						} finally {
							writerLease?.release();
						}
					});
		return { runId: handle.runId, events: assignment.events, finalPromise: terminal };
	}

	// An external ACP agent runs its own tools where no extension tool hook
	// reaches, so any blocking hook refuses it whatever tools the hook names.
	// Preview shares it so a plan never shows a delegation dispatch refuses.
	/**
	 * Refuses an ACP delegation whose guarantees the external agent cannot keep. Dispatch admission and preview share
	 * it, so a plan never shows a delegation dispatch refuses.
	 */
	function assertAcpDelegationAdmissible(
		req: DispatchRequest,
		agentId: string,
		protectedArtifactState: ProtectedArtifactState,
	): void {
		assertPlannedNodeIdentity(req, { id: "local", kind: "local" });
		assertTurnConstraintCompatibility(req, [], false);
		assertProtectedArtifactsEnforceable("acp-delegation", false, protectedArtifactState);
		const flowPolicy = options?.getFlowPolicy?.();
		if (flowPolicy !== undefined) {
			const refusal = flowUnmediatedAgentRefusal(compileWorkerFlowPolicy(flowPolicy), null);
			if (refusal !== null) throw new Error(refusal);
		}
		assertFlowHandoffMediated("acp-delegation", options?.getFlowRestrictions?.() ?? null);
		assertAcpDelegationUnhooked(agentId);
		if (req.responseSchema !== undefined) {
			throw new UnsupportedResponseSchemaError(
				"dispatch: responseSchema requires the native llamacpp runtime and cannot be enforced by an ACP delegation target",
			);
		}
		// An external ACP agent runs its own tool loop, so PanCode cannot mediate
		// per-tool writes and cannot honor write-root confinement. Fail closed
		// rather than accept a guarantee we cannot keep.
		if (req.writeRoots !== undefined && req.writeRoots.length > 0) {
			throw new Error(
				"dispatch: writeRoots cannot be enforced on an ACP delegation target; the external agent runs its own tool surface. Dispatch to a native or claude-sdk worker.",
			);
		}
	}

	function assertAcpDelegationUnhooked(agentId: string): void {
		const gates = [...(options?.workerHooks?.declarations() ?? []), ...(options?.workerHooks?.dropped?.() ?? [])].filter(
			isBlockingHook,
		);
		if (gates.length > 0)
			throw new Error(
				`dispatch: the ACP agent ${agentId} runs its own tools where no extension tool hook reaches, and the blocking hooks of ${hookExtensionIds(gates)} apply to every worker; dispatch to an http target`,
			);
	}

	/**
	 * Refuses a worker route whose tools a blocking hook gates but the worker
	 * would run past: a gate beyond the spec's hook cap that never reaches the
	 * worker, or one the route's runtime cannot carry. Dispatch, preview and
	 * failover candidates share it, so a refused route is never offered. Answers
	 * the passing hooks the runtime runs without, which dispatch names once.
	 */
	function assertWorkerHooksCarried(
		runtime: RuntimeDescriptor,
		allowedTools: ReadonlyArray<ToolName>,
	): WorkerExtensionHook[] {
		const dropped = options?.workerHooks?.dropped?.() ?? [];
		const droppedGates = hooksMatchingTools(dropped, allowedTools).filter(isBlockingHook);
		if (droppedGates.length > 0)
			throw new Error(
				`dispatch: the blocking tool hooks of ${hookExtensionIds(droppedGates)} fall past the ${WORKER_EXTENSION_HOOKS_MAX} hooks a worker carries and match this worker's tools; reduce the installed tool hooks`,
			);
		const unhooked = unhookedWorkerHooks(
			runtime,
			[...(options?.workerHooks?.declarations() ?? []), ...dropped],
			allowedTools,
		);
		const gates = unhooked.filter(isBlockingHook);
		if (gates.length > 0)
			throw new Error(
				runtime.kind === "subprocess"
					? `dispatch: the ${runtime.id} runtime runs its own tools where no extension tool hook reaches, and the blocking hooks of ${hookExtensionIds(gates)} apply to every worker; route it to an http target`
					: `dispatch: the ${runtime.id} runtime cannot carry extension tool hooks, and the blocking hooks of ${hookExtensionIds(gates)} match this worker's tools; route it to an http target`,
			);
		return unhooked;
	}

	function previewFixed(
		req: DispatchRequest,
		settings: EffectiveSettings = getEffectiveSettings(),
	): DispatchPlanTaskResolution {
		return previewFixedStages(req, settings).resolution;
	}

	/**
	 * The fixed-route preview and the grants admission derives on the way: the
	 * requested actions, the MCP attestation after writable servers lose their
	 * network grant, and the worker permit. Null grants for an ACP delegation,
	 * whose tool surface PanCode cannot observe.
	 */
	function previewFixedStages(
		req: DispatchRequest,
		settings: EffectiveSettings,
	): {
		resolution: DispatchPlanTaskResolution;
		grants: DispatchDerivedGrants | null;
		/** Null for an ACP delegation, whose budget admission prices nothing. */
		pricing: EffectivePricing | null;
	} {
		const isAcpAgent = settings?.integrations.externalAgents?.entries?.some((entry) => entry.id === req.agentId) ?? false;
		if (isAcpAgent && !req.delegationAgentId) req = { ...req, delegationAgentId: req.agentId };
		const validation = routeValidationProjection(req, true);
		const validated = validateJobSpec(validation.jobSpec);
		if (!validated.ok) throw new Error(`dispatch: invalid spec: ${validated.errors.join("; ")}`);
		req = validation.restore(validated.spec);

		if (req.delegationAgentId) {
			assertAcpDelegationAdmissible(
				req,
				req.delegationAgentId,
				protectedArtifactStateForRequest(getProtectedArtifactState(), req),
			);
			const lifecycle = resolveAcpDelegationLifecycle(
				{ ledgerAssignmentsFor, maybeAgents, projectContext, safety },
				req,
				settings,
			);
			const delegationRecipe = agents.get(req.agentId);
			const resolution: DispatchPlanTaskResolution = {
				agentId: req.agentId,
				specFingerprint:
					delegationRecipe !== null ? agentSpecFingerprint(normalizeAgentSpec(delegationRecipe)) : ACP_SPEC_FINGERPRINT,
				targetId: `delegation:${lifecycle.agentConfig.id}`,
				wireModelId: withoutDelegationStandInModel(req, lifecycle.agentConfig.id).model ?? lifecycle.agentConfig.id,
				runtimeId: "acp",
				node: previewNode({ ...req, node: "local" }).node,
				thinkingLevel: null,
				// An external ACP agent runs its own tool loop, so PanCode cannot observe
				// its surface. The named signature is that unknown, stated once.
				toolSignature: ACP_TOOL_SIGNATURE,
				endpointIdentityHash: sha256Hex(`delegation:${lifecycle.agentConfig.id}`),
				settingsFingerprint: computeSettingsFingerprint(settings ?? null),
				costUpperBoundUsd: UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD,
				costUpperBoundKnown: false,
				routeApproval: null,
			};
			return { resolution, grants: null, pricing: null };
		}

		const recipe = agents.get(req.agentId);
		if (!recipe) throw new Error(`dispatch: unknown agent recipe: ${req.agentId}`);
		const { spec: agentSpec } = assertRecipeAdmissible(req, recipe, settings);
		const placement = previewNode(req);
		const pathScope = withStoreGrantBoundaries(req, resolveDispatchPathScope(req), () => placement.node);
		const admission = resolveDispatchAdmissionStage(req, recipe, safety, pathScope);
		const targets = readWorkerTargets(settings);
		const target = resolveDispatchTarget(
			req,
			recipe,
			targets.workerDefault,
			targets.workerProfiles,
			targets.agentBindings,
			targets.targetOrder,
			providers,
		);
		assertWorkerContextRequest(req, target.runtime.kind === "http");
		enforceCapabilityGate(target.target.id, target.modelCapabilities, req.requiredCapabilities);
		const mcpRuntimeRefusal = workerMcpRuntimeRefusal(req.agentId, admission.allowedTools, target.runtime);
		if (mcpRuntimeRefusal !== null) throw new Error(mcpRuntimeRefusal);
		assertDenyToolsEnforceable(target.runtime, req.denyTools);
		// Preview resolves the envelope the run will: one function, so the card shows what the run gets (M7).
		const stage = resolveDispatchEnvelopeStage({
			req,
			recipe,
			spec: agentSpec,
			admission,
			target,
			settings,
			liveSettings: withLiveAutonomy(settings),
			pathScope,
			judgeSeated: options?.workerAskJudge !== undefined,
			placement,
		});
		const effectiveTools = stage.tools;
		const previewPermit = stage.permit;
		assertPostRuntimeToolCompatibility(req.agentId, agentSpec, stage.envelope, target);
		assertTurnConstraintCompatibility(req, effectiveTools, target.runtime.kind === "http", agents.listSpecs());
		if (!judgeRoutedPermit(previewPermit, settings)) assertMainGrantRoutable(req, target.runtime, previewPermit);
		assertRuntimeCanHonorWorkerPermissionMode(target.runtime, workerPermissionModeForPermit(previewPermit.allowance));
		assertResponseSchemaEnforceable(target.runtime, target.modelCapabilities, req.responseSchema, effectiveTools.length);
		assertWriteRootsEnforceable(target.runtime, stage.envelope.write.roots);
		assertProtectedArtifactsEnforceable(
			target.runtime.id,
			target.runtime.kind !== "subprocess",
			getProtectedArtifactState(),
		);
		assertWorkerHooksCarried(target.runtime, effectiveTools);
		const budget = resolveEffectiveWorkerBudget({
			req,
			recipeId: recipe.id,
			declared: agentSpec.budget,
			allowedTools: effectiveTools,
			settings,
			runtime: target.runtime,
			readOnly: stage.readOnly,
		});
		const endpoint = endpointCapacityForTarget(target.target.id);
		const outputBoundTokens = admissionMaxOutputTokens(settings, target.modelCapabilities);
		const costUpperBoundUsd = conservativeRouteAdmissionEstimateUsd(target.effectivePricing, outputBoundTokens, req);
		const costUpperBoundKnown = target.effectivePricing.pricedBy !== "none";
		const resolution: DispatchPlanTaskResolution = {
			agentId: req.agentId,
			specFingerprint: agentSpecFingerprint(agentSpec),
			targetId: target.target.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			...(endpoint !== null ? { endpoint: { key: endpoint.key, label: endpoint.label, limit: endpoint.limit } } : {}),
			node: placement.node,
			thinkingLevel: target.thinkingLevel,
			toolSignature: toolSignatureOf(effectiveTools),
			endpointIdentityHash: endpointIdentityHash(target.target.url),
			settingsFingerprint: computeSettingsFingerprint(settings ?? null),
			costUpperBoundUsd,
			costUpperBoundKnown,
			routeApproval: null,
			limits: planCardLimits({
				priced: costUpperBoundKnown,
				costUpperBoundUsd,
				outputBoundTokens,
				budget,
				nativeWorker: target.runtime.kind === "http",
				responseSeconds: (settings ?? DEFAULT_SETTINGS).safety.limits.workerResponseSeconds,
				wallMs: resolveRunWall({
					capMs: runWallCapMs((settings ?? DEFAULT_SETTINGS).fleet.limits, req.requestOrigin),
					...(agentSpec.budget?.timeoutMs !== undefined ? { recipeMs: agentSpec.budget.timeoutMs } : {}),
					startedAt: 0,
				}).wallMs,
			}),
			writes: writeModeLine(stage.envelope.write),
			...(target.routeSource !== undefined ? { route: target.routeSource } : {}),
			...(stage.envelope.withheld.length > 0 ? { withheld: withheldLines(stage.envelope.withheld) } : {}),
		};
		return {
			resolution,
			grants: {
				requestedActions: admission.requestedActions,
				mcp: admission.mcp ?? null,
				permit: previewPermit,
			},
			pricing: target.effectivePricing,
		};
	}

	function jointRouteInput(
		req: DispatchRequest,
		placedNode?: RunNodeIdentity,
		settings: EffectiveSettings = getEffectiveSettings(),
		mode: JointRouteResolverInput["mode"] = "shadow",
		agentIntent?: Parameters<typeof agentRouteCandidates>[0]["intentOverride"],
	): { input: JointRouteResolverInput; resolution: DispatchPlanTaskResolution } {
		let resolution: DispatchPlanTaskResolution;
		try {
			resolution = previewFixed(req, settings);
		} catch (error) {
			if (placedNode === undefined) throw error;
			resolution = { ...previewFixed({ ...req, node: "local" }, settings), node: placedNode };
		}
		const role: RouteRoleInput = { executionRole: withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0) };
		if (req.systemPrompt !== undefined) role.personaPrompt = req.systemPrompt;
		const identity = (value: DispatchPlanTaskResolution, nodeId: string): RouteIdentityInput => ({ ...value, nodeId });
		const executedRoute = toRouteCandidate(identity(resolution, placedNode?.id ?? resolution.node.id), role);
		const specs = agents.listSpecs();
		const auto = req.agentSelection?.mode === "auto";
		const agentCandidates = agentRouteCandidates({
			...(options?.getCapabilityGate ? { gate: options.getCapabilityGate() } : {}),
			specs,
			request: req,
			mode,
			activeAgentRoles: settings?.fleet.adaptiveRouting.agentRoles ?? [],
			...(agentIntent === undefined ? {} : { intentOverride: agentIntent }),
		});
		const settingsFingerprint = computeSettingsFingerprint(settings ?? null);
		const fixedDelegation = resolution.runtimeId === "acp";
		const fallbackTarget = {
			targetId: resolution.targetId,
			modelId: resolution.wireModelId,
			runtimeId: resolution.runtimeId,
			endpointIdentityHash: resolution.endpointIdentityHash,
		};
		const targets = configuredJointTargets(
			fixedDelegation ? [] : (settings?.targets ?? []),
			fallbackTarget,
			endpointIdentityHash,
		);
		const nodes = configuredJointNodes(
			(settings?.fleet?.nodes ?? []).map((node) => node.id),
			resolution.node.id,
			fixedDelegation,
		);
		const subjectRef = req.gate?.subjects?.[0];
		const subject = subjectRef === undefined ? null : ledger?.get(subjectRef.runId);
		const input = adaptJointRouteInput({
			mode,
			request: req,
			exact: failoverModeFor(req) === "none",
			executedRoute,
			agents: agentCandidates.dimensions,
			agentSelection: {
				request: auto ? "auto" : "explicit",
				baselineAgentId: req.agentSelection?.baselineAgentId ?? req.agentId,
				evaluations: agentCandidates.evaluations,
				authorityBasis: req.agentSelection?.authorityBasis ?? null,
			},
			targets,
			nodes,
			intent: req.routingIntent ?? defaultRoutingIntent(req),
			independenceSubject: subject === null || subject === undefined ? null : routeCorrelationFactsForRun(subject),
			settingsFingerprint,
			readiness: routeObserver.readinessWindow(),
			cooldown: (target) => targetCooldownReason(target.targetId, target.runtimeId, target.modelId),
			facts: (target, node) =>
				routeFactVerdict(
					{
						nodeId: node.nodeId,
						targetId: target.targetId,
						wireModelId: target.modelId,
						endpointIdentityHash: target.endpointIdentityHash,
						requireReachable: true,
						requireRuntimeCompatible: true,
						requireModelAvailable: true,
						requireGpuCount: null,
						requireVramBytes: null,
						mode,
					},
					undefined,
					{ now: now() },
				),
			preview: (agent, target, node) => {
				const candidateRequest = { ...req, agentId: agent.agentId, executionRole: agent.executionRole };
				const probed = previewFixed(
					{ ...candidateRequest, target: target.targetId, model: target.modelId, node: node.nodeId },
					settings,
				);
				const candidateRole: RouteRoleInput = { executionRole: agent.executionRole };
				if (candidateRequest.systemPrompt !== undefined) candidateRole.personaPrompt = candidateRequest.systemPrompt;
				const info = capabilityInfoForModel(providers, probed.targetId, probed.wireModelId);
				return {
					candidate: toRouteCandidate(identity(probed, node.nodeId), candidateRole),
					capabilities:
						info === null
							? []
							: Object.entries(info)
									.filter(([, value]) => value !== false && value !== undefined && value !== 0)
									.map(([name]) => name),
					costUpperBoundUsd: probed.costUpperBoundKnown ? probed.costUpperBoundUsd : null,
				};
			},
			envelopeRejection: (candidate) => {
				if (req.lineage === undefined || req.routeApproval === undefined) return null;
				// This verdict replaces the boundary one, so it keeps an attempt narrowed to part of the approval inside that part.
				const narrowed = routeBoundaryRejections(
					req,
					{
						agentId: candidate.agentId,
						targetId: candidate.targetId,
						modelId: candidate.modelId,
						nodeId: candidate.nodeId,
					},
					false,
				)["approved-envelope"];
				return narrowed ?? recovery.approvedEnvelopeRejection(req.routeApproval, candidate);
			},
		});
		return { input, resolution };
	}

	function preview(
		req: DispatchRequest,
		settings: EffectiveSettings = getEffectiveSettings(),
	): DispatchPlanTaskResolution {
		const fixed = previewFixed(req, settings);
		const recipe = agents.get(req.agentId);
		return planActiveRoute({
			request: req,
			settings: settings?.fleet.adaptiveRouting,
			capabilityClass: recipe === null ? null : normalizeAgentSpec(recipe).capabilityClass,
			failover: failoverModeFor(req),
			fixed,
			maxAttempts: workersMaxRetries(settings) + 1,
			resolveDecision: () => resolveJointRoute(jointRouteInput(req, undefined, settings, "active").input).decision,
			preview: (request) => previewFixed(request, settings),
		});
	}

	/**
	 * The plan-card preview (FL-13): the planned route, then the run's admission checks that can run synchronously,
	 * through the same cores the run uses. Nothing is consumed or recorded. A part only the run can settle (an outside
	 * read approval, a budget hold) is named on the card as checked at run.
	 */
	function previewAdmission(
		req: DispatchRequest,
		settings: EffectiveSettings = getEffectiveSettings(),
	): DispatchPlanTaskResolution {
		return withPreviewAdmission(req, preview(req, settings), settings);
	}

	function withPreviewAdmission(
		req: DispatchRequest,
		resolution: DispatchPlanTaskResolution,
		settings: EffectiveSettings,
	): DispatchPlanTaskResolution {
		const routed: DispatchRequest = { ...req, agentId: resolution.agentId };
		const checkedAtRun: string[] = [];
		if (!externalReadShapeAdmissible(routed, agents.getSpec(routed.agentId)))
			throw new Error(EXTERNAL_READ_APPROVAL_REQUIRED);
		if (routed.externalReadRoot !== undefined)
			checkedAtRun.push(`outside read root ${routed.externalReadRoot}: approval is asked at run`);
		const tags = routed.storeTags ?? [];
		if (tags.length > 0) {
			const recipe = agents.get(routed.agentId);
			const readOnly = requestedWriteNone({
				readOnly: routed.readOnly,
				capabilityClass: recipe === null ? null : normalizeAgentSpec(recipe).capabilityClass,
				hoareContract: recipe !== null && isHoareResultContract(dispatchResultContract(routed, recipe)),
			});
			const scope = storeGrantScopeRefusal(routed, readOnly);
			if (scope !== null) throw new Error(scope);
			const remote = remoteStoreGrantRefusal(routed, resolution.node);
			if (remote !== null) throw new Error(remote);
			if (resolution.node.kind === "ssh" && !readOnly)
				checkedAtRun.push(
					`store tags ${tags.join(", ")} on node ${resolution.node.id}: each root is checked at run and by the node`,
				);
			const listed = workspaceStoreTags(routed.cwd ?? process.cwd());
			const missing = tags.find((tag) => !listed.includes(tag));
			if (missing !== undefined) throw new Error(missingStoreTagRefusal(missing));
		}
		const intent = intentCeilingRefusal(routed, resolution.costUpperBoundUsd);
		if (intent !== null) throw new Error(intent);
		const ceiling = sessionCeilingRefusal();
		if (ceiling !== null && resolution.runtimeId !== "acp") {
			const pinned = previewFixedStages(
				{ ...routed, target: resolution.targetId, model: resolution.wireModelId, node: resolution.node.id },
				settings,
			);
			if (pinned.pricing !== null && !budgetExemptRoute(pinned.pricing)) {
				if (scheduling.admitPaidRequest === undefined || options?.budgetWaitForRaise !== true) throw ceiling;
				checkedAtRun.push("session cost ceiling reached: the run waits for a raise");
			}
		}
		const forecasts = previewForecasts(routed, resolution, settings);
		return {
			...resolution,
			...(checkedAtRun.length === 0 ? {} : { checkedAtRun }),
			...(forecasts === null ? {} : { forecasts }),
		};
	}

	/**
	 * The plan card's per-candidate forecasts (R4): the decision this task runs on, or the shadow one the router would
	 * make, each candidate read from the same readiness window the ranking reads. The route that runs comes first, then
	 * eligible candidates in rank order, then excluded ones with their reason. Reads route history only; null when the
	 * route universe cannot be enumerated, which the run itself reports.
	 */
	function previewForecasts(
		req: DispatchRequest,
		resolution: DispatchPlanTaskResolution,
		settings: EffectiveSettings,
	): NonNullable<DispatchPlanTaskResolution["forecasts"]> | null {
		let decision: RouteDecisionV1;
		try {
			decision =
				resolution.routeApproval?.decision ??
				resolveJointRoute(jointRouteInput(req, undefined, settings, "shadow").input).decision;
		} catch {
			return null;
		}
		const readiness = routeObserver.readinessWindow();
		const executed = routeCandidateKey(decision.executedRoute);
		const rank = (entry: { rejection: string | null; score: number | null }) =>
			entry.rejection === null ? -(entry.score ?? Number.NEGATIVE_INFINITY) : Number.POSITIVE_INFINITY;
		const others = decision.candidateEvaluations
			.filter((entry) => routeCandidateKey(entry.candidate) !== executed)
			.sort((left, right) => rank(left) - rank(right));
		const executedEntry = decision.candidateEvaluations.find((entry) => routeCandidateKey(entry.candidate) === executed);
		const ordered = [{ candidate: decision.executedRoute, rejection: executedEntry?.rejection ?? null }, ...others];
		return {
			candidates: ordered.slice(0, PREVIEW_FORECAST_LIMIT).map(({ candidate, rejection }) => ({
				route: `${candidate.agentId} ${candidate.targetId}/${candidate.modelId}@${candidate.nodeId}`,
				executed: routeCandidateKey(candidate) === executed,
				forecast: {
					...readiness.forRoute(candidate, { costUpperBoundUsd: null, factsFresh: true }).forecast,
					exclusion: rejection,
				},
			})),
			omitted: Math.max(0, ordered.length - PREVIEW_FORECAST_LIMIT),
		};
	}

	const planAgentSelection: DispatchContract["planAgentSelection"] = (input) => {
		const settings = getEffectiveSettings();
		const selection = materializeAgentPlanSelection(input, {
			resolve: (request, mode, intent) =>
				resolveJointRoute(jointRouteInput(request, undefined, settings, mode, intent).input).decision,
			preview: (request) => previewFixed(request, settings),
			getAgentSpec: (agentId) => agents.getSpec(agentId),
		});
		return { ...selection, resolution: withPreviewAdmission(input.request, selection.resolution, settings) };
	};

	function routeCandidates(req: DispatchRequest): ReadonlyArray<DispatchFailoverCandidate> {
		const settings = getEffectiveSettings();
		const planned = preview(req, settings);
		const input = jointRouteInput(req, undefined, settings, "shadow").input;
		const decision = planned.routeApproval?.decision ?? resolveJointRoute(input).decision;
		const ordered = planned.routeApproval
			? [decision.selected, ...decision.approvedFallbacks]
			: [input.executedRoute, decision.selected, ...decision.approvedFallbacks];
		const unique = new Map(ordered.map((candidate) => [routeCandidateKey(candidate), candidate]));
		const candidates = [...unique.values()].filter(
			(candidate) => planned.routeApproval !== null || candidate.agentId === req.agentId,
		);
		return candidates.slice(0, ROUTE_CANDIDATE_LIMIT).map((candidate) => ({
			agentId: candidate.agentId,
			target: candidate.targetId,
			model: candidate.modelId,
			node: candidate.nodeId,
		}));
	}

	/** Build and record a joint shadow decision without feeding it into execution. */
	function observeShadowRoute(
		req: DispatchRequest,
		placedNode?: RunNodeIdentity,
		settings: EffectiveSettings = getEffectiveSettings(),
	): RouteObservationHandle {
		const { input } = jointRouteInput(req, placedNode, settings, "shadow");
		let decision: RouteDecisionV1;
		try {
			const started = process.hrtime.bigint();
			decision = resolveJointRoute(input).decision;
			decision.decisionDurationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
		} catch {
			decision = fixedRouteDecision(input.executedRoute);
		}
		return routeObserver.observe(routeObservationInput(req, decision));
	}

	/**
	 * A context naming the run alone. A run whose journal is not open has no sink under it, so a run-scoped record is
	 * counted unowned rather than written into whichever scope the async context names (#434).
	 */
	function sinklessRunContext(runId: string, sessionId: string | null | undefined): TelemetryContext {
		return { sessionId: sessionId ?? null, runId, agent: workerAgent(runId) };
	}

	/** A fleet step's route belongs to its fleet root; any other dispatch's to the async context that asked (#434). */
	function routeObservationInput(req: DispatchRequest, decision: RouteDecisionV1) {
		const ctx =
			fleetRootTelemetryContext(req.lineage?.rootRunId) ??
			fleetRootTelemetryContext(req.lineage?.parentRunId ?? undefined);
		return { task: req.task, decision, ...(ctx !== undefined ? { ctx } : {}) };
	}

	const recordingJournal = createRecordingJournal();
	let journalBridge: RunEventJournalBridge | null = null;

	const extension: DomainExtension = {
		// Stop drains again and flushes leases, assignments and the ledger, which
		// now wait on fsync off the main thread; give it the drain's allowance (#428).
		stopAllowanceMs: () => contract.drainAllowanceMs?.() ?? 0,
		async start() {
			// The journal subscribes before anything can dispatch. It rides the
			// domain's own progress and terminal channels, so it covers a run
			// whose caller iterates the handle itself (every operator path) as
			// well as one drained by the dispatch tool's event registry.
			journalBridge = attachRunEventJournalBridge(context.bus, {
				acceptRun: (runId) => options?.journalRunEvents === true || recordingJournal.accepts(runId),
				journal: {
					open(id, agent) {
						if (options?.journalRunEvents === true) defaultRunEventJournal().open(id, agent);
					},
					append(id, entry) {
						recordingJournal.append(id, entry);
						if (options?.journalRunEvents === true) defaultRunEventJournal().append(id, entry);
					},
					result(id, result) {
						if (options?.journalRunEvents === true) defaultRunEventJournal().result(id, result);
					},
					terminal(id, outcome, detail) {
						recordingJournal.terminal(id, outcome, detail);
						if (options?.journalRunEvents === true) defaultRunEventJournal().terminal(id, outcome, detail);
					},
				},
			});
			// Phase D revocation: a pending grant never outlives its owner. A
			// session that parks or ends and a main turn the operator cancels
			// revoke what they hold; a run's own exit and abort revoke at the run.
			grantUnsubscribes.push(
				context.bus.subscribe("session.parked", (payload) => {
					// A fork adopts what its parent held (bt-11); the fork's own open, next, revokes only what it did not adopt.
					if (payload.reason === "fork") {
						forkParkedSessionIds.push(payload.sessionId);
						return;
					}
					grantBroker.revokeSession(
						payload.sessionId,
						`the owning session was ${payload.reason === "close" ? "closed" : "parked"}`,
					);
				}),
				// A fork, or a /resume back to the dispatching session, changes who may answer an open ask.
				context.bus.subscribe("session.created", () => {
					adoptOrphanedGrants();
					for (const sessionId of forkParkedSessionIds.splice(0)) {
						grantBroker.revokeSession(sessionId, "the owning session was parked");
					}
					workerApprovalWindows.republish();
				}),
				context.bus.subscribe("session.reattached", () => {
					adoptOrphanedGrants();
					workerApprovalWindows.republish();
				}),
				context.bus.subscribe("session.ended", () => {
					const sessions = new Set(grantBroker.list({ state: "pending" }).map((record) => record.ownerSessionId));
					for (const sessionId of sessions) grantBroker.revokeSession(sessionId, "the owning session ended");
				}),
				context.bus.subscribe("turn.aborted", () => {
					const sessionId = options?.getSessionId?.() ?? null;
					const batches = listDetachedBatches().filter(
						(batch) => batch.sessionId === sessionId && (sessionId !== null || batch.cwd === process.cwd()),
					);
					const detachedAssignments = new Set(batches.flatMap((batch) => batch.runs.map((run) => run.assignmentId)));
					// #425: detached permission requests belong to their assignments, beyond a foreground cancel.
					for (const grant of grantBroker.list({ sessionId, state: "pending" })) {
						if (!detachedAssignments.has(grant.rootRunId) && active.get(grant.runId)?.detached !== true) {
							grantBroker.revokeRun(grant.runId, "the owning main turn was cancelled");
						}
					}
				}),
			);
			// No in-memory executor survives a process restart, so every active
			// side-store lease from an earlier bundle is orphaned and must expire. Boot never waits on the admission lock
			// for it (M-35): a held lock leaves the sweep to the first plan admission.
			sweepDispatchReservationsAtStartup(now());
			const runLedger = openLedger({
				get maxRuns() {
					return getEffectiveSettings()?.fleet?.history?.maxRuns ?? resolveGuardrail("maxDispatchRuns");
				},
				agentRoles: (agentId) =>
					agentRunRoles(
						agentId,
						agentRoleFactsResolver((id) => agents.getSpec(id)),
					),
			});
			ledger = runLedger;
			const recoverRuns = async (): Promise<void> => {
				// The ledger was read before the first frame; a sibling may have settled
				// a run since, and a scan or reconcile against that stale copy would
				// settle the run, or the assignment it answers, as abandoned. A ledger
				// that no longer reads skips both.
				try {
					runLedger.reload();
				} catch (error) {
					reportDispatchDiagnostic("ledger recovery", error);
					return;
				}
				// Symphony P10: restart recovery from durable artifacts. A row whose
				// host died settles from its run's journal, or closes as stalled.
				try {
					const recovery = recoverAbandonedRuns(runLedger, {
						journalUnsealed: (runId) => {
							const directory = telemetryRunDirectory(pancodeStateDir(), runId);
							return existsSync(telemetryJournalPath(directory)) && !existsSync(telemetryBundlePath(directory));
						},
					});
					for (const { runId, settlement } of recovery.unsettled)
						void trackDurableWrite(
							settleOrphanedRunJournal(telemetryRunDirectory(pancodeStateDir(), runId), settlement),
						).catch((error) => reportDispatchDiagnostic(`settle the journal of run ${runId}`, error));
					// A terminal row persisted before its journal's seal landed gets that seal now (#434).
					for (const runId of recovery.unsealed)
						void trackDurableWrite(sealSettledRunJournal(telemetryRunDirectory(pancodeStateDir(), runId))).catch((error) =>
							reportDispatchDiagnostic(`seal the journal of run ${runId}`, error),
						);
					if (recovery.abandoned > 0 || recovery.sealed > 0) {
						await runLedger.persist();
						if (process.env.PANCODE_INTERACTIVE !== "1") {
							process.stderr.write(`[dispatch] ledger recovery: sealed=${recovery.sealed} abandoned=${recovery.abandoned}\n`);
						}
					}
				} catch (error) {
					// Recovery is best-effort; a failed scan never blocks startup.
					reportDispatchDiagnostic("ledger recovery", error);
				}
				// Reconcile durable assignments orphaned in `running` by a crash: the
				// in-memory registry and retry queue do not survive restart, so an
				// orphan can never settle without this pass. Resolves each against
				// durable ledger evidence so wait/collect never hang on it.
				try {
					const reconciled = await reconcileOrphanAssignments({
						listRunning: () => listStoredAssignments().filter((record) => record.status === "running"),
						ownerAlive: assignmentProcessOwnerAlive,
						lookupAttempt: (runId) => {
							const envelope = runLedger.get(runId) ?? null;
							if (!envelope) return null;
							return {
								runId,
								terminal: envelope.status !== "running",
								succeeded: envelope.outcome === "succeeded",
							};
						},
						settle: (assignmentId, terminalRunId, status, owner) =>
							settleStoredAssignment(assignmentId, terminalRunId, status, owner),
					});
					if ((reconciled.recovered > 0 || reconciled.abandoned > 0) && process.env.PANCODE_INTERACTIVE !== "1") {
						process.stderr.write(
							`[dispatch] assignment reconcile: recovered=${reconciled.recovered} abandoned=${reconciled.abandoned}\n`,
						);
					}
				} catch {
					// Reconciliation is best-effort; a failure never blocks startup.
				}
			};
			// Boot starts its worktree recovery after the first frame; the scan
			// follows it, so abandoned rows observe the workers it terminated.
			const bootRecovery = options?.bootRecovery;
			startupRecovery = bootRecovery ? bootRecovery.settled.then(recoverRuns) : recoverRuns();
			void startupRecovery.then(() => {
				startupRecovered = true;
			});
			if (!bootRecovery) await startupRecovery;
			startHeartbeatWatchdog();
			probeEndpointsAtDefaultBound();
		},
		stop() {
			if (stopPromise !== null) return stopPromise;
			if (routeHistoryWarmTimer !== null) clearTimeout(routeHistoryWarmTimer);
			let resolveStop!: () => void;
			let rejectStop!: (error: unknown) => void;
			stopPromise = new Promise<void>((resolve, reject) => {
				resolveStop = resolve;
				rejectStop = reject;
			});
			void (async () => {
				// A recovery already under way finishes before the drain and the final
				// ledger flush; one boot never started stays for the next boot.
				if (options?.bootRecovery?.started !== false) await startupRecovery;
				// Shutdown is process-local. The durable machine-wide drain belongs to
				// the operator: setting it here would deny admission in every sibling
				// PanCode process, and a crash before the clearing write would wedge the
				// machine.
				await drain();
				await capacityAdmission.stop();
				for (const ownerId of ownedReservations) rollbackDispatchReservation(ownerId, now());
				ownedReservations.clear();
				publishedPathScopeRoots.clear();
				await flushDurableWrites();
				// After drain(), so the last run's terminal line is written before the
				// bridge stops listening.
				journalBridge?.stop();
				recordingJournal.stop();
				journalBridge = null;
				for (const unsubscribe of grantUnsubscribes.splice(0)) unsubscribe();
				grantBroker.dispose();
				crossProcessFleet.dispose();
				workerApprovalWindows.dispose();
			})().then(resolveStop, rejectStop);
			return stopPromise;
		},
	};

	function emitRunAborted(run: ActiveRun, source: "dispatch_abort" | "dispatch_drain"): void {
		const startedMs = Date.parse(run.startedAt);
		const at = Date.now();
		const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, at - startedMs) : null;
		context.bus.emit(
			"run.aborted",
			{ source, runId: run.runId, startedAt: run.startedAt, elapsedMs, at },
			runContext(run.runId),
		);
	}

	/**
	 * An operator action reaches a run outside its async context, so the record names the run's journal. A run with no
	 * open journal, such as one still queued, falls to the current scope; the payload's runId keeps the target (#434).
	 */
	function runContext(runId: string): TelemetryContext | undefined {
		return runTelemetryJournal(runId)?.context;
	}

	/**
	 * Operator snapshot (Symphony §13.3/§13.4). Pure copy of in-memory state:
	 * no I/O, no locks. A consumer failure cannot affect orchestration because
	 * nothing here mutates dispatch state.
	 */
	function snapshot(): DispatchSnapshot {
		const tickNow = now();
		const tickMonotonic = monotonicNow();
		const running: DispatchSnapshot["running"] = [];
		let runtimeSeconds = finalizedRuntimeSeconds;
		const spends = [...finalizedSpends];
		for (const pending of pendingCapacity.values()) {
			const startedAt = pending.timing.queuedAt ?? pending.timing.requestedAt ?? new Date(tickNow).toISOString();
			running.push({
				runId: pending.identity.runId,
				agentId: pending.identity.agentId,
				...(pending.identity.task !== undefined ? { task: pending.identity.task } : {}),
				...(pending.identity.budget !== undefined ? { budget: pending.identity.budget } : {}),
				runtimeKind: pending.identity.runtimeKind,
				outcomePhase: "queued",
				heartbeat: "n/a",
				lineage: { parentRunId: null, rootRunId: pending.identity.runId, attempt: 0, depth: 0 },
				startedAt,
				elapsedMs: 0,
				spend: unobservedRunUsageFacts(),
				node: pending.node === null ? null : { ...pending.node },
			});
		}
		for (const run of active.values()) {
			let heartbeat: "alive" | "stale" | "dead" | "n/a" = "n/a";
			if (run.heartbeatAt && Number.isFinite(heartbeatMonotonicAt(run.heartbeatAt))) {
				const heartbeatMonotonic = heartbeatMonotonicAt(run.heartbeatAt);
				if (run.runtimeKind === "acp-delegation") {
					const stallMs = run.stallTimeoutMs;
					if (stallMs !== null && stallMs > 0) {
						heartbeat = tickMonotonic - heartbeatMonotonic > stallMs && run.peerQuestionOpen?.() !== true ? "dead" : "alive";
					}
				} else {
					heartbeat = classifyHeartbeat(heartbeatMonotonic, tickMonotonic, heartbeatSpec);
				}
			}
			const spend = meterSpend(run.meter);
			const startedMs = Date.parse(run.startedAt);
			const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, tickNow - startedMs) : 0;
			running.push({
				runId: run.runId,
				agentId: run.agentId,
				task: run.task,
				...(run.budget !== undefined ? { budget: run.budget } : {}),
				runtimeKind: run.runtimeKind,
				outcomePhase: run.stallKilled ? "terminating" : run.aborted ? "aborting" : "running",
				heartbeat,
				lineage: publishedLineage(run.lineage, run.hostRun),
				startedAt: run.startedAt,
				elapsedMs,
				spend,
				node: run.node !== null ? { ...run.node } : null,
			});
			spends.push({ spend, spendSums: meterSums(run.meter) });
			runtimeSeconds += elapsedMs / 1000;
		}
		const retrying = [...retryQueue.values()].map((entry) => ({
			runId: entry.runId,
			agentId: entry.agentId,
			task: entry.task,
			attempt: entry.attempt,
			dueAt: new Date(entry.dueAt).toISOString(),
			reason: entry.reason,
		}));
		return {
			generatedAt: new Date(tickNow).toISOString(),
			running,
			retrying,
			totals: {
				tokens: sumFactSums(spends.map((run) => run.spendSums.totalTokens)),
				cost: sumRunSpend(spends),
				runtimeSeconds,
			},
		};
	}

	/**
	 * Settle every queued retry deterministically before shutdown. A cleared
	 * retry timer would otherwise leave the assignment (and its attached
	 * finalPromise / durable record) pending forever. The last immutable attempt
	 * receipt becomes the terminal evidence and the assignment settles `canceled`.
	 */
	function settleQueuedAssignmentsForShutdown(): void {
		writeRootPark.revoke(() => true, "the owning session is shutting down");
		for (const [finishedRunId, entry] of retryQueue) {
			clearTimeout(entry.timer);
			entry.settleCanceled();
			if (assignments.get(entry.rootRunId)?.status === "running") {
				settleAssignmentDurably(asAssignmentId(entry.rootRunId), entry.terminalCandidate, "canceled");
			}
			context.bus.emit("run.progressed", {
				runId: finishedRunId,
				agentId: entry.agentId,
				task: entry.task,
				event: { type: "retry_canceled", attempt: entry.attempt },
			});
		}
		retryQueue.clear();
		retryBackoff.clear();
		retryReasons.clear();
	}

	function drain(): Promise<void> {
		if (drainPromise !== null) return drainPromise;
		let resolveDrain!: () => void;
		let rejectDrain!: (error: unknown) => void;
		drainPromise = new Promise<void>((resolve, reject) => {
			resolveDrain = resolve;
			rejectDrain = reject;
		});
		draining = true;
		drainController.abort(new AdmissionCanceledError());
		capacityAdmission.drain();
		stopHeartbeatWatchdog();
		void (async () => {
			settleQueuedAssignmentsForShutdown();
			const canceled = new Set<string>();
			while (active.size > 0 || dispatching.size > 0) {
				const runs = Array.from(active.values());
				for (const run of runs) {
					if (canceled.has(run.runId)) continue;
					canceled.add(run.runId);
					emitRunAborted(run, "dispatch_drain");
					run.aborted = true;
					grantBroker.revokeRun(run.runId, "the owning session is shutting down");
					try {
						run.abort();
					} catch {
						// Await finalization even when the runtime's abort throws.
					}
				}
				await Promise.allSettled([...dispatching, ...runs.map((run) => run.finalPromise)]);
			}
			while (memberWork.size > 0) {
				await Promise.allSettled([...memberWork.values()].flatMap((work) => [...work]));
			}
			await flushDurableWrites();
			// Non-fatal so stop() still releases leases, flushes and closes the
			// journal bridge; the rows stay dirty for any later persist (#428).
			if (ledger) {
				try {
					await ledger.persist();
				} catch (error) {
					reportDispatchDiagnostic("persist ledger at drain", error);
				}
			}
		})().then(
			// Concurrent callers share one drain; a call after it settled runs
			// again, so a ledger change made since then is still persisted. The
			// slot clears before waiters resume so their next call starts fresh.
			() => {
				drainPromise = null;
				resolveDrain();
			},
			(error: unknown) => {
				drainPromise = null;
				rejectDrain(error);
			},
		);
		return drainPromise;
	}

	function assignmentRootFor(id: string): string {
		if (assignments.get(id) !== null) return id;
		const live = active.get(id);
		if (live) return live.lineage.rootRunId;
		const local = assignmentRootsByAttempt.get(id);
		if (local !== undefined) return local;
		// After restart the immutable attempt history identifies the logical
		// assignment; a receipt's root may instead name its main host run.
		const stored = listStoredAssignments().find((record) => record.assignmentId === id || record.attempts.includes(id));
		return stored?.assignmentId ?? ledger?.get(id)?.lineage?.rootRunId ?? id;
	}

	/**
	 * A renewal found an assignment's lease gone from the shared store, so its
	 * slot may already run someone else's worker. Every member that owns the
	 * assignment is stopped through its own control root: the assignment id of
	 * a fleet names several members and `abort` refuses it, while a control
	 * root reaches the member's live attempt, its queued retry and a retry
	 * still in admission, and leaves finalization, receipts and settlement to
	 * their usual owners. A run that starts after this sweep is stopped where
	 * it enters `active`, through `lostLeaseDetail`.
	 */
	function stopLostCapacityOwners(assignmentId: string, detail: string): void {
		const roots = new Set<string>();
		for (const [attempt, root] of assignmentRootsByAttempt) {
			if (root === assignmentId) roots.add(controlRootsByAttempt.get(attempt) ?? attempt);
		}
		for (const run of active.values()) {
			if (run.lineage.rootRunId === assignmentId) roots.add(controlRootsByAttempt.get(run.runId) ?? run.runId);
		}
		for (const root of roots) {
			// An aborted or stall-killed run already carries its own cause and its
			// retries are already refused; a run on its merge card has no worker left.
			// Aborting again would relabel or cancel work that holds no endpoint slot.
			const current = currentAssignmentRun(root);
			if (current !== null && (current.aborted || current.stallKilled || current.awaitingOperator === true)) continue;
			try {
				contract.abort(root, { cause: "capacity", detail });
			} catch (error) {
				reportDispatchDiagnostic(`stop member ${root} after lost capacity`, error);
			}
		}
	}

	/** The run just entered `active`; stop it if its lease was lost while it launched. */
	function stopIfCapacityLost(runId: string, leaseId: string): void {
		const detail = capacityAdmission.lostLeaseDetail(leaseId);
		if (detail === null) return;
		try {
			contract.abort(runId, { cause: "capacity", detail });
		} catch (error) {
			reportDispatchDiagnostic(`stop run ${runId} after lost capacity`, error);
		}
	}

	function controlRootFor(id: string): string {
		const exact = controlRootsByAttempt.get(id);
		if (exact !== undefined) return exact;
		const roots = new Set<string>();
		for (const [attempt, root] of assignmentRootsByAttempt) {
			if (root === id) roots.add(controlRootsByAttempt.get(attempt) ?? root);
		}
		if (roots.size > 1) {
			throw new Error(`dispatch: '${id}' names multiple fleet members; use a concrete member or assignment id`);
		}
		return roots.values().next().value ?? assignmentRootFor(id);
	}

	function currentAssignmentRun(id: string): ActiveRun | null {
		// An exact live attempt is authoritative even if a sibling has a higher
		// attempt ordinal. Completed IDs may follow only their own retry chain.
		const exact = active.get(id);
		if (exact !== undefined) return exact;
		const rootRunId = controlRootFor(id);
		let current: ActiveRun | null = null;
		for (const run of active.values()) {
			if ((controlRootsByAttempt.get(run.runId) ?? run.lineage.rootRunId) !== rootRunId) continue;
			if (current === null || run.lineage.attempt > current.lineage.attempt) current = run;
		}
		return current;
	}

	// A fork's lineage never changes once stamped, so each complete chain is read
	// from disk once; owner() runs on every turn end and wake poll.
	const ancestorChains = new Map<string, string[]>();
	const ownerAncestors = (sessionId: string): string[] => {
		const parentSessionId = options?.getSessionParentId?.() ?? null;
		if (parentSessionId === null) return [];
		const key = `${sessionId}\0${parentSessionId}`;
		const cached = ancestorChains.get(key);
		if (cached !== undefined) return cached;
		// Through a deleted ancestor too, by its telemetry journal's fork record (FL-14).
		const chain = sessionAncestorIds(sessionId, parentSessionId, (id) => forkParentSessionId(pancodeStateDir(), id));
		ancestorChains.set(key, chain);
		return chain;
	};
	const contract: DispatchContract = {
		awaitStartupRecovery,
		agentTraits: (agentId) => agents.getSpec(agentId)?.traits ?? [],
		warmRouteHistory() {
			if (routeHistoryWarmTimer !== null || draining || stopPromise !== null) return;
			// After boot's own burst, so the first keystrokes do not contend with it.
			routeHistoryWarmTimer = setTimeout(() => {
				void routeObserver
					.warmHistory?.(() => draining || stopPromise !== null)
					.catch((error) => {
						reportDispatchDiagnostic("warm route history", error);
					});
			}, ROUTE_HISTORY_WARM_DELAY_MS);
			routeHistoryWarmTimer.unref?.();
		},
		drainAllowanceMs: () =>
			Math.max(
				WORKER_PROCESS_CLEANUP_BOUND_MS,
				DEFAULT_CANCEL_GRACE_MS + DEFAULT_TERMINATION_GRACE_MS + DEFAULT_TERMINATION_WAIT_MS,
			) + DISPATCH_DRAIN_GRACE_MS,
		publishesProgress: true,
		ownsProgressBus: (bus) => bus === context.bus,
		preview: previewAdmission,
		budgetEconomics,
		primeRouteQuota,
		derivedGrants: (req) => previewFixedStages(req, getEffectiveSettings()).grants,
		planAgentSelection,
		routeCandidates,
		reservations: {
			prepare: prepareReservation,
			release: (ownerId) => releaseDispatchReservation(ownerId, now()),
			rollback: (ownerId) => rollbackDispatchReservation(ownerId, now()),
			rollbackUnconsumed: (ownerId) => rollbackUnconsumedDispatchReservation(ownerId, now()),
			get: getDispatchReservation,
		},
		costCeilingUsd: () => scheduling.ceilingUsd(),
		maxWorkers: () => configuredGlobalCapacity(getEffectiveSettings()),
		protectedArtifactState: () => getProtectedArtifactState(),
		landKeptTask,
		dispatch,
		dispatchBatch: (reqs, preparation) => dispatchBatch({ contract, dispatch, getEffectiveSettings }, reqs, preparation),
		sealCouncilSynthesis: (input) =>
			sealCouncilSynthesis({ collectReproducibility, context, requireLedger, sinklessRunContext }, input),
		owner: () => {
			// Only a configured absolute root adds a location ownership cannot derive.
			const worktreeRoot = getEffectiveSettings()?.fleet?.worktrees?.root;
			const sessionId = options?.getSessionId?.() ?? null;
			const ancestorSessionIds = sessionId === null ? [] : ownerAncestors(sessionId);
			return {
				sessionId,
				cwd: process.cwd(),
				...(worktreeRoot !== undefined && isAbsolute(worktreeRoot) ? { worktreeRoot } : {}),
				...(ancestorSessionIds.length > 0 ? { ancestorSessionIds } : {}),
			};
		},
		listRuns(status, where) {
			return requireLedger().list({
				...(status ? { status } : {}),
				...(where ? { where } : {}),
			});
		},
		subscribeChanges(listener) {
			const unsubscribes = [
				context.bus.subscribe("run.enqueued", listener),
				context.bus.subscribe("run.started", listener),
				context.bus.subscribe("run.completed", listener),
				context.bus.subscribe("run.failed", listener),
				context.bus.subscribe("approval.requested", listener),
				context.bus.subscribe("approval.resolved", listener),
			];
			try {
				unsubscribes.push(subscribeStoredAssignments(listener));
			} catch (error) {
				for (const unsubscribe of unsubscribes) unsubscribe();
				throw error;
			}
			return () => {
				for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			};
		},
		getRun(runId) {
			if (!ledger) return null;
			return ledger.get(runId);
		},
		observedRunWrites(runId) {
			// A run this process never finalized, or finalized long enough ago to
			// have been evicted, is unknown rather than silent, so both answer null.
			const attribution = runWriteAttributions.get(runId);
			return attribution?.complete === true ? [...attribution.recorded] : null;
		},
		observedRunWriteAttribution(runId) {
			const attribution = runWriteAttributions.get(runId);
			if (attribution === undefined) return null;
			return {
				recorded: [...attribution.recorded],
				complete: attribution.complete,
				downgrades: attribution.downgrades?.map((entry) => ({ ...entry })) ?? [],
			};
		},
		assignments: {
			get: (id) => assignments.get(assignmentRootFor(id)),
			getStored: (id) => getStoredAssignment(assignmentRootFor(id)),
			flushWrites: flushDurableWrites,
		},
		async drainMember(runId) {
			const root = controlRootFor(runId);
			const errors: unknown[] = [];
			while (true) {
				const pending = [...(memberWork.get(root) ?? [])];
				const live = currentAssignmentRun(runId);
				if (live !== null) pending.push(live.finalPromise);
				if (pending.length === 0) break;
				for (const result of await Promise.allSettled(pending)) {
					if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "dispatch member drain failed", { cause: errors[0] });
		},
		async waitForMember(runId) {
			const root = controlRootFor(runId);
			await contract.drainMember?.(runId);
			const receipts: RunResult[] = [];
			for (const [attemptId, attempt] of controlAttempts) {
				if (controlRootsByAttempt.get(attemptId) === root && attempt.receipt !== undefined) {
					receipts.push(attempt.receipt);
					// #231's owner now holds the evidence; session control metadata
					// must not retain full receipts after the fleet collects them.
					delete attempt.receipt;
				}
			}
			const receipt = receipts.at(-1);
			if (receipt === undefined) throw new Error(`dispatch: member '${runId}' has no terminal run result`);
			return { receipt, receipts };
		},
		abort(runId, reason) {
			// A run another PanCode process owns: its owner takes the durable cancel request and seals it canceled.
			if (currentAssignmentRun(runId) === null && crossProcessFleet.cancelForeign(runId, reason?.detail ?? null)) return;
			const rootRunId = controlRootFor(runId);
			const run = currentAssignmentRun(runId);
			canceledControlRoots.add(rootRunId);
			if (reason?.cause === "steer") steerCanceledRoots.add(rootRunId);
			const queued = pendingCapacity.get(rootRunId);
			if (queued !== undefined && capacityAdmission.cancel(rootRunId)) {
				persistAssignment(cancelStoredAssignment(rootRunId), `${rootRunId}:cancel-queued`);
				context.bus.emit(
					"run.aborted",
					{
						source: "dispatch_abort",
						runId: rootRunId,
						startedAt: null,
						elapsedMs: null,
						reason: reason?.detail ?? "operator abort while waiting for an endpoint slot",
					},
					runContext(rootRunId),
				);
			}
			const assignment = assignments.get(rootRunId);
			if (assignment?.status === "running") {
				assignments.cancel(assignment.id);
				persistAssignment(cancelStoredAssignment(rootRunId), `${rootRunId}:cancel`);
			}
			writeRootPark.revoke(
				(parked) => (controlRootsByAttempt.get(parked.runId) ?? parked.lineage.rootRunId) === rootRunId,
				"the run was cancelled",
			);
			for (const [finishedRunId, retry] of retryQueue) {
				if ((controlRootsByAttempt.get(finishedRunId) ?? retry.rootRunId) !== rootRunId) continue;
				clearTimeout(retry.timer);
				retry.settleCanceled();
				retryQueue.delete(finishedRunId);
				if (retry.rootRunId === rootRunId) {
					settleAssignmentDurably(asAssignmentId(rootRunId), retry.terminalCandidate, "canceled");
				}
				context.bus.emit(
					"run.aborted",
					{
						source: "dispatch_abort",
						runId: finishedRunId,
						startedAt: null,
						elapsedMs: null,
						reason: `scheduled retry ${retry.attempt} cancelled by the operator`,
					},
					runContext(finishedRunId),
				);
				context.bus.emit("run.progressed", {
					runId: finishedRunId,
					agentId: retry.agentId,
					task: retry.task,
					event: { type: "retry_canceled", attempt: retry.attempt },
				});
			}
			if (!run) return;
			emitRunAborted(run, "dispatch_abort");
			run.aborted = true;
			grantBroker.revokeRun(run.runId, "the run was cancelled");
			// A timeout kill rides the abort path but must not launder into an
			// operator abort: record the cause so the receipt names the timeout.
			if (reason) {
				run.abortDetail = reason.detail;
				run.abortCause = reason.cause;
			}
			try {
				run.abort();
			} catch {
				// child may already be gone
			}
		},
		canceledBySteer(runId) {
			try {
				return steerCanceledRoots.has(controlRootFor(runId));
			} catch {
				return false;
			}
		},
		steer(runId, text) {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				throw new Error("steer: empty message");
			}
			const run = currentAssignmentRun(runId);
			if (!run) {
				throw new Error(`steer: run or assignment '${runId}' is not active; only running HTTP/SDK workers accept guidance`);
			}
			if (run.aborted || run.stallKilled) {
				throw new Error(`steer: run '${runId}' is ${run.aborted ? "aborting" : "terminating"} and cannot be steered`);
			}
			if (!run.steer) {
				if (runKindSupportsLiveSteering(run.runtimeKind)) {
					throw new Error(`steer: run '${runId}' (${run.runtimeKind}:${run.runtimeId}) has no input channel`);
				}
				throw new Error(`steer: run '${runId}' (${run.runtimeKind}:${run.runtimeId}) does not support live steering`);
			}
			if (!run.steer(trimmed)) {
				if (run.runtimeKind === "acp-delegation") {
					throw new Error(
						`steer: run '${runId}' (${run.runtimeKind}:${run.runtimeId}) no longer accepts input; the delegated agent has no turn running that takes guidance`,
					);
				}
				throw new Error(`steer: run '${runId}' no longer accepts input; the worker has exited or its stdin is closed`);
			}
		},
		workerPermissionRefusal(runId, requestId) {
			const holder = foreignAskOwner(runId, requestId);
			return holder === null ? null : heldAskRefusal(holder, runId);
		},
		resolveWorkerPermission(runId, requestId, decision) {
			const refusal = contract.workerPermissionRefusal?.(runId, requestId) ?? null;
			if (refusal !== null) throw new Error(`resolveWorkerPermission: ${refusal}`);
			// A brokered request is decided against its record: the operator's
			// answer is bound to the attempt and argument digest the worker parked.
			const brokered = grantBroker.get(requestId);
			if (brokered !== null) {
				const elsewhere = answeredElsewhere.get(requestId);
				const result = grantBroker.decide(requestId, {
					decision,
					issuer: "operator",
					runId,
					...(elsewhere !== undefined ? { reason: answeredElsewhereReason(decision, elsewhere) } : {}),
				});
				if (!result.ok) throw new Error(`resolveWorkerPermission: ${result.reason}`);
				return;
			}
			// An ask another PanCode process holds: the answer goes to its run directory, and that process applies it.
			if (crossProcessFleet.answerForeign(runId, requestId, decision)) return;
			if (workerApprovalWindows.isExpired(requestId)) {
				throw new Error(`resolveWorkerPermission: run '${runId}' no longer accepts input for this ask; its window ended`);
			}
			const run = currentAssignmentRun(runId);
			if (!run) {
				throw new Error(
					`resolveWorkerPermission: run or assignment '${runId}' is not active; only running native workers accept permission decisions`,
				);
			}
			if (run.aborted || run.stallKilled) {
				throw new Error(
					`resolveWorkerPermission: run '${runId}' is ${run.aborted ? "aborting" : "terminating"} and cannot resolve permissions`,
				);
			}
			if (!run.resolvePermission) {
				throw new Error(
					`resolveWorkerPermission: run '${runId}' (${run.runtimeKind}) has no input channel; only native workers accept permission decisions`,
				);
			}
			if (!run.resolvePermission(requestId, decision)) {
				throw new Error(
					`resolveWorkerPermission: run '${runId}' no longer accepts input; the worker has exited or its stdin is closed`,
				);
			}
			// Answered, so the window cannot send a timeout denial after this.
			workerApprovalWindows.settle(requestId);
		},
		workerPermissionWindow: (requestId) => workerApprovalWindows.read(requestId),
		workerRunEndsWithTurn: (runId) => {
			const run = currentAssignmentRun(runId);
			if (run === null || run.requestOrigin !== "agent" || run.detached === true) return false;
			// A dispatch moved to the background belongs to its batch, beyond the turn that started it.
			const assignmentId = run.lineage.rootRunId;
			return !listDetachedBatches().some((batch) => batch.runs.some((entry) => entry.assignmentId === assignmentId));
		},
		holdWorkerPermission: (requestId) => workerApprovalWindows.hold(requestId),
		workerRunShellConfined: (runId) => currentAssignmentRun(runId)?.shellConfined === true,
		restartWorkerPermission: (requestId) => workerApprovalWindows.restart(requestId),
		grants: {
			list(filter = {}) {
				return grantBroker
					.list({
						...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
						...(filter.runId !== undefined ? { runId: filter.runId } : {}),
						...(filter.pendingOnly === true ? { state: "pending" as const } : {}),
					})
					.map(grantView);
			},
			get(requestId) {
				const record = grantBroker.get(requestId);
				return record === null ? null : grantView(record);
			},
			onPending(listener) {
				grantPendingListeners.add(listener);
				return () => {
					grantPendingListeners.delete(listener);
				};
			},
			decideAsMain: (input) =>
				decideGrantAsMain({ foreignAskOwner, grantAttended, grantBroker, grantView, heldAskRefusal, safety }, input),
		},
		detached: {
			register: registerDetachedBatch,
			get: getDetachedBatch,
			list: listDetachedBatches,
			markCollected: markDetachedBatchCollected,
			markOwnerTold: markDetachedBatchOwnerTold,
		},
		snapshot,
		routeBreakers: () =>
			targetBreaker.snapshot().map((route) => {
				const [targetId = "", runtimeId = "", wireModelId = ""] = route.key.split("\0");
				return {
					targetId,
					runtimeId,
					wireModelId,
					state: route.state,
					remainingMs: route.remainingMs,
					reason: route.reason,
					consecutiveFailures: route.consecutiveFailures,
				};
			}),
		drain,
	};

	return { extension, contract };
}
