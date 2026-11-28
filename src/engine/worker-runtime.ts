// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * Worker-subprocess engine boundary.
 *
 * Owns the pi-agent-core Agent instance for a worker run and forwards every
 * AgentEvent to an emit callback (the worker entry serializes events to NDJSON
 * stdout). Post-W5 the surface takes a resolved TargetDescriptor +
 * RuntimeDescriptor + wire model id, not a provider/model pair. HTTP/native
 * runtimes stay pi-agent-backed; sanctioned external runtimes branch to their
 * own worker runners before pi-agent model synthesis.
 */

import { randomUUID } from "node:crypto";
import {
	type AnthropicMessagesCompat,
	type Context,
	getToolStateChanges,
	type OpenAIResponsesCompat,
	type SystemMessage,
	type Tool,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Type } from "typebox";
import { classifyCallFailure, trackCallFetch } from "../core/call-failure.js";
import { isWorkerToolCallCapExceededReason, isWorkerToolCallCapSynthesisReason } from "../core/guardrails.js";
import { createHostPolicyMessage } from "../core/host-policy-message.js";
import { parseJsonObjectPayload } from "../core/json-payload.js";
import { snapshotModelInfo } from "../core/model-tier.js";
import { isProviderAuthRejection } from "../core/provider-auth-error.js";
import { EXPLORATION_TOOL_NAMES } from "../core/read-only-calls.js";
import { type ModelRouteRefusal, modelRouteGuarded, modelRouteRefusalMessage } from "../core/response-model-id.js";
import { isResponseSchemaRejection } from "../core/response-schema.js";
import { requestedThinking } from "../core/telemetry/call-effort.js";
import { observedToolCallOrigin, withTelemetryContext } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { hasTokenUsageCounts, normalizeTokenUsage } from "../core/token-split.js";
import { ToolNames } from "../core/tool-names.js";
import { effectiveToolCall, gatewayChainReceipts } from "../core/tool-surface.js";
import { validateResultContract, validateStructuredHelperResult } from "../domains/agents/result-contract.js";
import { nonBooleanBaselineReason } from "../domains/agents/result-contract-builder-report.js";
import { nodeResultContractFilesystem } from "../domains/agents/result-contract-filesystem.js";
import { gateCitationViolation } from "../domains/agents/result-contract-gate.js";
import {
	RESULT_CONTRACT_REPAIR_LIMIT,
	resultContractReminder,
	resultContractRepairMessages,
	resultContractRepairUserMessage,
	resultContractShape,
} from "../domains/agents/result-contract-repair.js";
import { MUTATION_FAILURE_RULE } from "../domains/agents/result-contract-schema.js";
import {
	resultContractEvidenceShortfall,
	unobservedExplorerReportReason,
} from "../domains/agents/result-contract-scout.js";
import { createWorkerContextGuard, WorkerContextExhaustedError } from "../domains/context/worker/pressure.js";
import { createWorkerObservationStore } from "../domains/context/worker/recall.js";
import { workerEconomicsView } from "../domains/dispatch/economics-view.js";
import { HANDBACK_CONTEXT_SHARE, HANDBACK_NOTE_SHARE, WALL_HANDBACK_SHARE } from "../domains/dispatch/handback.js";
import type { RunRole } from "../domains/dispatch/obligation.js";
import { createReadStreakRegistration } from "../domains/middleware/read-streak.js";
import { createMiddlewareToolChoiceControl } from "../domains/middleware/tool-choice-control.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import type { AuthResolution } from "../domains/providers/auth/storage.js";
import { compactionBudget, resolveEffectivePricing } from "../domains/providers/catalog.js";
import { PROVIDER_PROBE_TIMEOUT_MS } from "../domains/providers/contract.js";
import { acceptsImageInput } from "../domains/providers/image-input.js";
import {
	probedModelOffer,
	resolveModelRuntimeCapabilitiesForModel,
	type ThinkingLevel,
} from "../domains/providers/index.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	flowTransferRefusal,
	mergeFlowRestrictions,
	resolveModelDestination,
} from "../domains/safety/information-flow.js";
import { createProtectedArtifactsRegistration } from "../domains/safety/protected-artifacts-registration.js";
import {
	createRunEffectsRecorder,
	recordToolExecutionEffects,
	sessionChangesTree,
} from "../domains/safety/run-effects.js";
import { estimateAgentMessageTokens } from "../domains/session/context-accounting.js";
import { seededWorkerMessages, seedRecallLineage } from "../lib/worker-wire/context-seed.js";
import { permissionHoldBackstopAt } from "../lib/worker-wire/protocol.js";
import type { WorkerBudget } from "../lib/worker-wire/spec-contract.js";
import { resolveAgentTools, type ToolTelemetry } from "../tools/agent-tools.js";
import { createWorkerGitContext } from "../tools/git-exec.js";
import { runObservationPool } from "../tools/observation.js";
import type { RegistryDeps } from "../tools/registry-contract.js";
import { clearTaskGates, configureWorkerTaskGates, contractDeclaresTaskGates } from "../tools/verify/task-gates.js";
import type { WorkerDecisionBinding } from "../worker/stdin-demux.js";
import { createEngineAgent, type EngineAgentOptions } from "./agent.js";
import { engineStreamSimple } from "./api-registry.js";
import { workerCacheFamilyId } from "./apis/cache-family.js";
import { anchorContextAtInputTokens, requestOutputReserve } from "./apis/output-budget.js";
import { startClaudeSdkWorkerRun } from "./claude/sdk-runtime.js";
import { normalizeContext, resolvedRequestContext } from "./context.js";
import { disableCopilotConversationResume } from "./copilot/session-fs.js";
import { observeExternalWorkerRun } from "./external-call-telemetry.js";
import { startExternalCliWorkerRun } from "./external-cli/connectors.js";
import {
	callRepeatsAsRead,
	createLoopGuardRegistration,
	resolveDeliveryTools,
	workerLoopBlockBudget,
} from "./loop-guard.js";
import { isLoopGuardSynthesisBackstopReason } from "./loop-guard-reasons.js";
import {
	isLockedSynthesisFallbackOnly,
	lockedSynthesisDirective,
	lockedSynthesisRepromptMessages,
	sanitizeLockedSynthesisMessage,
	withLockedSynthesisDirective,
	withRequestTailDirective,
} from "./loop-guard-synthesis.js";
import { registerPancodeOAuthProviders } from "./oauth.js";
import { retryStreamOnceOnAuthRejection } from "./oauth-retry-stream.js";
import { retryStreamOnceOnOverflow } from "./overflow-retry-stream.js";
import {
	applyToolRounds,
	deterministicSampling,
	streamToolRound,
	supportsNamedToolChoice,
} from "./provider-payload.js";
import { createRunPhase, type HandbackTrigger } from "./run-phase.js";
import type { AgentMessage, EngineModel } from "./types.js";
import {
	assistantMessageText,
	hostWrittenExchange,
	isAssistantMessage,
	isTerminalAssistantMessage,
} from "./worker-assistant-reply.js";
import { createWorkerCallTelemetry } from "./worker-call-telemetry.js";
import type { PancodeWorkerEvent } from "./worker-events.js";
import { createWorkerExtensionHookRegistrations } from "./worker-extension-hooks.js";
import {
	chainStepVisibleText,
	groundingRanges,
	observedReadAnchors,
	type ReadCitationRequest,
	readCitationRequest,
	recordObservedGrep,
	recordObservedRead,
} from "./worker-grounding.js";
import { WORKER_REFUSAL_REPORT_BLOCK } from "./worker-refusals.js";
import { boundWorkerResponse } from "./worker-response-stream.js";
import {
	finishedReplyWithoutJsonResult,
	terminalContractViolation,
	withResultContractReminder,
	workerContractResponseFormatFor,
	workerResponseFormatFor,
} from "./worker-result-contract.js";
import { finishWorkerRun, taskMessage } from "./worker-run/finish.js";
import { createWorkerPermissions } from "./worker-run/permissions.js";
import type { WorkerRunScope } from "./worker-run/scope.js";
import { decodeWorkerSpec, prepareNativeWorker, workerProviderSupportsTools } from "./worker-run/spec.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput } from "./worker-run-types.js";
import {
	exhaustedChangesDetail,
	THRASH_CONTEXT_FRACTION,
	THRASH_RECALL_LIMIT,
	thrashHostNote,
} from "./worker-thrash-note.js";
import { createThrashOutcome } from "./worker-thrash-outcome.js";
import { createWorkerToolRegistry, INTERNAL_HELPER_RESULT_TOOL } from "./worker-tools.js";

export { workerProviderSupportsTools };

/**
 * Characters of a refused terminal result sent to the parent, well past the
 * feed's own bound so the parent redacts before anything it keeps is cut.
 */
const REJECTED_HELPER_RESULT_MAX_CHARS = 16 * 1024;

/**
 * APIs whose request renders the reasoning effort ahead of the input, so a locked round there keeps the run's level.
 * On copilot-sdk a changed effort is a setModel on the live session, after which Copilot read none of its cached
 * prefix (M-20).
 */
const REASONING_PREFIX_APIS: ReadonlySet<string> = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"copilot-sdk",
]);

function clampThinkingLevelForModel(model: EngineModel, requested: ThinkingLevel | undefined): ThinkingLevel {
	const level = requested ?? "off";
	return resolveModelRuntimeCapabilitiesForModel(model, level).thinking.effectiveLevel;
}

/** Return the admitted worker specification budget unchanged. */
function resolveWorkerRuntimeBudget(input: Pick<WorkerRunInput, "budget">): WorkerBudget {
	return input.budget;
}

/**
 * Spin up a pi-agent-core Agent for the worker subprocess. Subscribes an event
 * sink that forwards every AgentEvent to `emit`. Starts one run via
 * `agent.prompt(task)`. Returns a handle with the final promise and an abort
 * function; the promise resolves when `agent.waitForIdle()` returns.
 */
export function startWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	const { mutationResult, helperSchema } = decodeWorkerSpec(input);
	if (input.runtime.id === "claude-sdk") {
		return observeExternalWorkerRun(input, emit, (observedEmit) => startClaudeSdkWorkerRun(input, observedEmit));
	}
	if (input.runtime.kind === "subprocess") return startExternalCliWorkerRun(input, emit);

	const { workerSettings, agentSkillPolicy, activeWorkerTools, model, safety } = prepareNativeWorker(input);
	// The run's phase (DESIGN 4.5): work, then handback, then sealed. Its tool
	// lock, flipped by the loop guard's lockout callback, a handback trigger or
	// the wall clock, is read by streamFn below to force the remaining model
	// rounds text-only by removing the tool declarations (Anthropic, Google and
	// Vertex keep them and send tool choice none instead; see toolsRemovedRound).
	const phase = createRunPhase();
	const scope: WorkerRunScope = {
		input,
		emit,
		phase,
		callTracking: null,
		callUsageReported: false,
		contextPressureWindow: 0,
		contextPressureCrossed: false,
		readStreakEscalated: 0,
		streakNoteOpen: false,
		lastProviderHttpStatus: null,
		workerBoundAborted: false,
		abortWorkerForBound: null,
		workerStopCause: undefined,
		workerModelRound: 0,
		runFlow: null,
		flowBlockReported: false,
		workerMcp: undefined,
		resultContractRepairsQueued: 0,
		resultContractRepairsStarted: 0,
		toolExecutionsStarted: 0,
		evidenceRepairActive: false,
		acceptedHelperResult: null,
		helperExposedThisRound: false,
		helperTerminalRequest: false,
		helperTurnFailure: null,
		observedReadRanges: new Map(),
		observedGrepLines: new Map(),
		runObservationWindow: undefined,
		contractResponseFormat: undefined,
		permissionFailure: false,
		activeEscalation: null,
		get registry() {
			return registry;
		},
		get agent() {
			return agent;
		},
		get safety() {
			return safety;
		},
		get contractCwd() {
			return contractCwd;
		},
		get helperForcedChoiceAvailable() {
			return helperForcedChoiceAvailable;
		},
		get helperSchema() {
			return helperSchema;
		},
		get unsubscribe() {
			return unsubscribe;
		},
		get inheritedCount() {
			return inheritedCount;
		},
		get synthesisTimer() {
			return synthesisTimer;
		},
		get wallTimer() {
			return wallTimer;
		},
		get clearActiveEscalation() {
			return clearActiveEscalation;
		},
		get unsubscribePermission() {
			return unsubscribePermission;
		},
		get thrashOutcome() {
			return thrashOutcome;
		},
		get workerTelemetry() {
			return workerTelemetry;
		},
	};
	const workShare = (role: RunRole): number => input.limits?.context.workShare ?? HANDBACK_CONTEXT_SHARE[role];
	const noteShare = input.limits?.context.noteShare ?? HANDBACK_NOTE_SHARE;
	let responseRound = 0;
	let lockedSynthesisReprompts = 0;

	// CLI-H3: recalls of this run's evictions, the window the last request was fitted to, whether a request reached
	// the thrash share of it, and whether the one host turn has gone out.
	let evictedRecalls = 0;
	const pendingRecallCalls = new Set<string>();
	let thrashNudged = false;
	// X3: the read-only streak a writer worker reached when the read-streak rule handed it the second step, whether
	// the streak note went out, and whether it still stands (no progress since), which holds back the other causes.
	let streakNudged = false;
	// Status of the current round's own attempt; a stale status from an earlier
	// round must not veto the message-based rejection check (#427).
	let roundProviderHttpStatus: number | null = null;
	// The credential the current request carries, so a server rejection refreshes
	// exactly that token under the shared storage lock (#427).
	let lastAuthResolution: AuthResolution | null = null;
	const refreshWorkerOAuthKey = async (): Promise<string | null> => {
		const rejected = lastAuthResolution;
		if (!input.authProfile || rejected?.source !== "stored-oauth" || rejected.apiKey === undefined) return null;
		process.stderr.write(`[worker] refreshing the OAuth credential for target '${input.target.id}' and retrying once\n`);
		const refreshed = await openAuthStorage().forceRefreshApiKey(input.authProfile, rejected.apiKey, input.signal);
		if (!refreshed.available || refreshed.apiKey === undefined) {
			// Reuse the CLI login syntax, and keep refresh-provider diagnostics out of the remedy (#427).
			throw new Error(
				`OAuth credential for target '${input.target.id}' could not be refreshed. Run pancode auth login ${rejected.providerId} again.`,
			);
		}
		lastAuthResolution = refreshed;
		return refreshed.apiKey;
	};
	const workerBudget = resolveWorkerRuntimeBudget(input);
	// The reserve window ends discovery, not the run's own product. An agent that was
	// granted mutation tools delivers by writing, so those stay admitted inside it;
	// a read-only agent has none and ends in synthesis.
	const deliveryTools = resolveDeliveryTools(input.allowedTools, input.product);
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// The model round that may only report: the one after the refusal limit tripped.

	const loopGuardRegistration = createLoopGuardRegistration({
		safety,
		readResultMaxBytes: workerSettings.context.toolResultMaxBytes,
		toolCallCap: workerBudget.hardCap,
		...(workerBudget.ceiling !== undefined ? { toolCallCeiling: workerBudget.ceiling } : {}),
		toolCallSoftLimit: workerBudget.toolCalls,
		// A worker's blocks all land in one run-long bucket, so the bound on
		// them is a statement about this run's length, not about a turn.
		turnBlockBudget: workerLoopBlockBudget(workerBudget.toolCalls),
		...(deliveryTools.length > 0 ? { deliveryTools } : {}),
		turnSynthesisLockout: workerBudget.synthesis,
		// Once locked, the next model round is forced text-only at the
		// request level. The lockout directive alone relies on model compliance.
		onSynthesisLockout: () => {
			if (workerBudget.synthesis) phase.lockTools("tools");
		},
	});
	const seedLineage = seedRecallLineage(input.contextSeed);
	// X3: a writer worker gets the main agent's read-streak rule. Its first note rides the tool result; the second
	// step is this run's thrash host note, with the streak as its cause. Writing means holding edit or write, not
	// merely a delivery tool: an orientation run delivers through code_nav.
	const workerCanWrite =
		input.readOnly !== true && activeWorkerTools.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write);
	const workerCanPlan = activeWorkerTools.includes(ToolNames.Tasks);
	const readStreakRegistration =
		deliveryTools.length > 0 && workerCanWrite
			? createReadStreakRegistration({
					// The worker's configured scratch roots count as scratch, as its run-effects recorder reads them.
					classifiers: { repeatsAsRead: callRepeatsAsRead, changesTree: sessionChangesTree(() => workerSettings) },
					workspaceRoot: () => input.cwd ?? process.cwd(),
					surface: {
						canWrite: true,
						canPlan: workerCanPlan,
						canAsk: activeWorkerTools.includes(ToolNames.AskUser),
					},
					secondStep: (count) => {
						scope.readStreakEscalated = count;
					},
					// A later step of the same call (a chain's edit) that resets the streak withdraws the second step.
					onReset: () => {
						scope.readStreakEscalated = 0;
						scope.streakNoteOpen = false;
					},
					// X7: a worker is never continued by an operator, so a streak past every note meets the decision gate,
					// and its second refused round ends the run as a bound does, with its own outcome code.
					unattended: true,
					stall: (detail) => {
						emit({ type: "pancode_run_outcome", payload: { outcomeCode: "exploration_stalled" } });
						if (scope.workerBoundAborted) return;
						scope.workerBoundAborted = true;
						phase.seal(`exploration_stalled: ${detail}`);
						process.stderr.write(`[worker] read-streak gate: ${detail}; stopped the run\n`);
						scope.abortWorkerForBound?.();
					},
				})
			: null;
	const observations = createWorkerObservationStore(input.telemetryContext?.runId, seedLineage);
	// Run-scoped ledger: the inherited set plus what this run's reads add. It
	// lives in memory only; every growth is reported to the parent at once and
	// sealed in the receipt, so the parent's session ledger absorbs it before
	// any output of this run reaches its context.
	scope.runFlow = input.flowRestrictions ?? null;
	const workerFlow: NonNullable<RegistryDeps["flow"]> = {
		mcpTransport: (tool) => scope.workerMcp?.transportOf(tool) ?? null,
		carried: () => scope.runFlow,
		refusal: () => null,
		absorb: (set) => {
			const before = scope.runFlow?.restrictions.length ?? 0;
			scope.runFlow = mergeFlowRestrictions(scope.runFlow, set);
			// Every growth reaches the parent on the receipt-bearing lane, so the
			// label precedes any output derived from the read.
			if (scope.runFlow !== null && scope.runFlow.restrictions.length > before) {
				emit({ type: "pancode_flow_restrictions", payload: { set: scope.runFlow } } as PancodeWorkerEvent);
			}
		},
	};
	// The protected-artifacts guard starts from the parent-session snapshot
	// and has no persistence sink. It can still absorb worker-local
	// protect_path effects from snapshot rules and the dispatching session's
	// extension hooks for the rest of this run.
	const protectedArtifacts = createProtectedArtifactsRegistration({
		...(input.protectedArtifactState !== undefined
			? { initialState: { artifacts: [...input.protectedArtifactState.artifacts] } }
			: {}),
	});
	// A checker (verifier, debugger) has no shell; the gate commands its task
	// names are what it may run through verify (task-gates.ts). Every other role sees none.
	if (contractDeclaresTaskGates(input.resultContract?.kind)) {
		configureWorkerTaskGates(input.task);
	} else {
		clearTaskGates();
	}
	const registry = createWorkerToolRegistry(
		input.middlewareSnapshot,
		safety,
		{
			...(input.noSkills !== undefined ? { noSkills: input.noSkills } : {}),
			...(input.skillPaths !== undefined ? { skillPaths: [...input.skillPaths] } : {}),
			...(input.trustProjectCompatRoots !== undefined ? { trustProjectCompatRoots: input.trustProjectCompatRoots } : {}),
			...(input.mcp?.attestation.skills !== undefined ? { mcpSkills: input.mcp.attestation.skills } : {}),
		},
		// Workers run unattended, so the loop guard carries the hard tool-call
		// cap in addition to repetition blocking, plus the synthesis lockout:
		// after the loop-block budget the worker is told to report from what it
		// gathered instead of burning the lifetime cap on a retry spiral, and
		// the bounded backstop reason is watched in telemetry.onFinish below to
		// abort a worker that keeps calling tools anyway.
		[
			loopGuardRegistration,
			...(readStreakRegistration !== null ? [readStreakRegistration] : []),
			protectedArtifacts,
			// The dispatching session's extension gates, run there for each call they match.
			...(input.extensionHookHost !== undefined
				? createWorkerExtensionHookRegistrations(input.extensionHookHost.hooks, input.extensionHookHost.request)
				: []),
		],
		input.readOnly,
		(effects) => middlewareToolChoice.apply(effects),
		input.agentLedger === undefined
			? undefined
			: {
					read: () => input.agentLedger?.read() ?? null,
					post: (body) => input.agentLedger?.post(body, scope.runFlow ?? undefined) ?? { ok: false, reason: "no-ledger" },
				},
		observations.recall,
		input.taskGit !== undefined
			? createWorkerGitContext({
					allowance: input.taskGit.allowance,
					executePermitted: input.taskGit.executePermitted,
					cwd: input.cwd ?? process.cwd(),
					...(input.taskGit.taskWorktree !== undefined ? { taskWorktree: input.taskGit.taskWorktree } : {}),
				})
			: undefined,
		input.permitAllowance?.executeAutonomy,
		workerFlow,
		input.mcp !== undefined
			? (registry) => {
					const { attestation: admitted, createSource } = input.mcp as NonNullable<WorkerRunInput["mcp"]>;
					// Declarations and trust are read from the project root admission
					// used, never from a task worktree that holds neither, and nothing
					// this run observes is written back to the operator's catalog. The
					// servers themselves start in this run's tree, under its sandbox:
					// the task worktree's root, never the subdirectory a dispatch from
					// one gives as cwd. Without a task worktree the cwd is already the
					// tree root admission resolved, including a compete candidate's own
					// worktree, whose source checkout lies outside its write roots.
					scope.workerMcp = createSource({
						cwd: admitted.projectRoot,
						launchRoot: input.taskGit?.taskWorktree?.path ?? input.cwd ?? process.cwd(),
						registry,
						persistCatalog: false,
						admitted,
						// A worker reads the store and writes only the tags its dispatch granted.
						store: { writable: false, ...(input.storeGrant !== undefined ? { grant: input.storeGrant } : {}) },
					});
					return scope.workerMcp;
				}
			: undefined,
		(effects, hookInput) => protectedArtifacts.absorbAwaited(hookInput, effects),
		input.storeGrant,
		async () => workerEconomicsView(input.limits),
	);
	const contractCwd = input.cwd ?? process.cwd();
	let zeroToolRepairQueued = false;
	/** A gate verdict that cited none of its evidence packet gets one repair naming the ids (M10); a second passes through. */
	let citationRepairQueued = false;
	// M-31: whether the last terminal handoff arrived while work tools were still open, captured before the handoff
	// locks them, and whether a repair reopened the read tools so the run can gather the evidence its result lacked.
	let handoffFromOpenWork = false;
	const readToolsAdmitted = activeWorkerTools.filter((tool) => EXPLORATION_TOOL_NAMES.has(tool));
	/**
	 * A rejected result the run can still ground by reading: work tools were open when it arrived, the envelope admits
	 * a read-class tool, and either nothing has executed yet or the refusal names missing evidence. Withdrawing the
	 * tools there leaves the model nothing to answer with but an empty result (M-31). A mutation report keeps its own
	 * revision path, and a refusal about the result's form after evidence exists keeps the final-only repair.
	 */
	const evidenceRepairFor = (reason: string, workOpen: boolean): boolean =>
		workOpen &&
		!mutationResult &&
		readToolsAdmitted.length > 0 &&
		phase.lastRound === null &&
		(scope.toolExecutionsStarted === 0 || resultContractEvidenceShortfall(reason));
	const evidenceRepairInstruction = (reason: string, resubmit: string): string =>
		`${reason} No evidence backs this result yet. First read the inputs the assignment names with the admitted read tools (${readToolsAdmitted.join(", ")}); only read-class calls run during this repair. Then ${resubmit}, citing only lines you read.`;
	/**
	 * An explorer report that arrives before any tool ran, while the run could still read, is refused here so the
	 * read-first repair runs; past the repair cap the run fails as the dispatch obligation would have failed it (M-31).
	 */
	const unobservedReportReason = (): string | null =>
		input.resultContract !== undefined &&
		readToolsAdmitted.length > 0 &&
		phase.lastRound === null &&
		(handoffFromOpenWork || (!phase.toolsLocked && !phase.resultForced))
			? unobservedExplorerReportReason(input.resultContract.kind, scope.toolExecutionsStarted)
			: null;

	/** Read tool call id -> what was asked for, pending that call's result. */
	const pendingReadCitations = new Map<string, ReadCitationRequest>();
	/** Grep call ids, direct or through gateway op=call, pending their results. */
	const pendingGrepCalls = new Set<string>();
	// The write-side equivalent: what this run changed and what it validated,
	// so a mutation report is judged against the run instead of believed. Scratch roots read as the orchestrator's copy
	// reads them, so a check logged under one is output in both recorders (x6-8).
	// X4: the thrash note's settlement, from the request that carries it to the change or report that answers it.
	const thrashOutcome = createThrashOutcome({ context: input.telemetryContext });
	const runEffects = createRunEffectsRecorder(contractCwd, {
		scratchRoots: workerSettings.safety.scratchRoots,
		onWorkspaceChange: (toolCallId) => thrashOutcome.changed(toolCallId),
	});
	// A tool route hands execute a schema-coerced copy; the arguments the model sent, by call id, keep a baseline honest.
	const submittedHelperArguments = new Map<string, unknown>();
	const acceptHelperResult = (data: unknown, submitted: unknown = data): string | null => {
		if (!input.resultContract) return "missing helper result contract";
		const coerced = mutationResult ? nonBooleanBaselineReason(submitted) : null;
		if (coerced !== null) return coerced;
		const checked = validateStructuredHelperResult({
			contract: input.resultContract,
			data,
			cwd: contractCwd,
			observedReadRanges: groundingRanges(scope.observedReadRanges, scope.observedGrepLines),
			networkAllowed: true,
			filesystem: nodeResultContractFilesystem(),
			observedRunEffects: runEffects.snapshot(),
		});
		if (checked.structured === null) return checked.validation.reason ?? "invalid helper result";
		const unobserved = unobservedReportReason();
		if (unobserved !== null) return unobserved;
		scope.acceptedHelperResult = checked.structured;
		emit({ type: "pancode_helper_result", payload: checked.structured });
		return null;
	};
	// The refusal reason alone cannot show what the model actually submitted.
	const reportRejectedHelperResult = (submitted: unknown, reason: string): void => {
		let text: string;
		try {
			text = JSON.stringify(submitted) ?? String(submitted);
		} catch {
			text = String(submitted);
		}
		emit({
			type: "pancode_helper_result_rejected",
			payload: { reason, submitted: text.slice(0, REJECTED_HELPER_RESULT_MAX_CHARS) },
		});
	};

	/**
	 * The settled children of a chain, folded exactly as the direct calls
	 * would have been. Only a child its own admission ran to success grounds
	 * anything; a child refused by a run bound seals that bound. Pending and
	 * unresolved steps never ran and are never in the receipt list.
	 */
	const observeChainChildren = (toolName: string, result: unknown): void => {
		for (const child of gatewayChainReceipts(toolName, result)) {
			if (child.admission.outcome === "blocked") {
				if (child.admission.blockReason !== undefined) observeBoundReason(child.admission.blockReason);
				continue;
			}
			if (child.admission.outcome !== "ok") continue;
			const visibleText = chainStepVisibleText(child);
			if (child.capability === ToolNames.Read) {
				const request = readCitationRequest(child.args);
				if (request !== null) recordObservedRead(contractCwd, scope.observedReadRanges, request, child.result, visibleText);
			} else if (child.capability === ToolNames.Grep || child.capability === ToolNames.Bash) {
				recordObservedGrep(scope.observedGrepLines, child.result.details, visibleText);
			}
		}
	};

	/** The run's next round is its handback round; the bound that triggered it is journaled as its kind (M3). */
	const enterHandback = (bound: HandbackTrigger): void => {
		phase.lockTools(bound);
		process.stderr.write(
			`[worker] handback: ${bound} reached the ${input.role ?? "run"}'s share; the next round reports\n`,
		);
		if (input.telemetryContext)
			telemetryHub().emit(
				"middleware.fired",
				{
					hook: "turn_start",
					phase: "sync",
					ruleId: "worker.handback",
					effects: ["lock_tools"],
					severity: "info",
					evidence: `bound:${bound}@worker`,
				},
				input.telemetryContext,
			);
	};
	/**
	 * A refusal whose reason is a run bound. Direct calls reach this through
	 * their blocked finish; a chain child the bound refused reaches it through
	 * the chain's receipt, because the aggregate settles as an ordinary error
	 * and its own finish cannot carry the child's verdict.
	 */
	const observeBoundReason = (reason: string): void => {
		// Lifetime-cap lockout ends tool use before the final report. Writers
		// retain the exhausted outcome; reporting workers can seal their synthesis.
		if (isWorkerToolCallCapSynthesisReason(reason)) {
			if (workerBudget.synthesis && deliveryTools.length === 0) {
				// DF-10: a reporting recipe's cap ends tool use; its sealed synthesis is the product.
				phase.lockTools("tools");
				process.stderr.write(`[worker] ${reason}\n`);
				return;
			}
			emit({ type: "pancode_run_outcome", payload: { outcomeCode: "worker_tool_call_cap_exhausted" } });
			if (phase.sealedBy === null) {
				phase.seal(reason);
				process.stderr.write(`[worker] ${reason}\n`);
			}
			return;
		}
		// Hard bounds: the immediate cap abort (lockout not wired) and
		// the synthesis backstop for a model that keeps emitting tool calls
		// after the lock. Both end the run; the first recorded bound wins the
		// receipt diagnostic.
		if (isWorkerToolCallCapExceededReason(reason) || isLoopGuardSynthesisBackstopReason(reason)) {
			emit({
				type: "pancode_run_outcome",
				payload: {
					outcomeCode: isLoopGuardSynthesisBackstopReason(reason)
						? "loop_guard_tools_disabled_exhausted"
						: "worker_tool_call_cap_exhausted",
				},
			});
			if (scope.workerBoundAborted) return;
			scope.workerBoundAborted = true;
			phase.seal(reason);
			process.stderr.write(`[worker] ${reason}\n`);
			scope.abortWorkerForBound?.();
		}
	};
	const telemetry: ToolTelemetry = {
		onStart(event) {
			emit({ type: "pancode_tool_start", payload: event });
		},
		onFinish(event) {
			if (event.toolCallId !== undefined) runEffects.checkOutcome(event.toolCallId, event.outcome, event.unresolved);
			emit({ type: "pancode_tool_finish", payload: event });
			if (event.outcome !== "blocked" || typeof event.reason !== "string") return;
			observeBoundReason(event.reason);
		},
	};
	const tools = resolveAgentTools({
		registry,
		...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
		telemetry,
		envelopeTools: activeWorkerTools,
		agentId: input.agentId,
		includeInteractiveTools: false,
		invokeOptions: (toolCallId) => ({
			...observedToolCallOrigin(agent.state.messages, toolCallId),
			...(input.telemetryContext === undefined
				? {}
				: {
						runId: input.telemetryContext.runId,
						...(input.telemetryContext.sessionId === null ? {} : { sessionId: input.telemetryContext.sessionId }),
						...(input.telemetryContext.turnId === undefined ? {} : { turnId: input.telemetryContext.turnId }),
					}),
			...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
			correlationId: `worker-model-round-${scope.workerModelRound}`,
			toolResultMaxBytes: workerSettings.context.toolResultMaxBytes,
			// DESIGN 4.5: the run's own observation pool, sized from the usable window the last round measured.
			...(scope.runObservationWindow !== undefined && input.telemetryContext !== undefined
				? { observationRunPool: runObservationPool(scope.runObservationWindow) }
				: {}),
			// The worker's own model, resolved by the orchestrator, so hooks judge the worker by it.
			...(input.runtimeResolution !== undefined ? { model: snapshotModelInfo(input.runtimeResolution) } : {}),
			supportsImages: acceptsImageInput({
				runtimeId: input.runtime.id,
				vision: input.modelCapabilities?.vision,
				modelInput: model.input,
			}),
			// The admitted capability list, so the gateway calls only what the
			// recipe declared: the same bound the attached schemas already honor.
			allowedTools: input.allowedTools,
			...(agentSkillPolicy ? { pendingSkillPolicy: agentSkillPolicy } : {}),
		}),
	});
	const helperToolAvailable = helperSchema !== null && workerProviderSupportsTools(input);
	const helperForcedChoiceAvailable = helperToolAvailable && supportsNamedToolChoice(model.api);
	// Resolved snapshots lose the tool-addition boundaries; retain them so the
	// terminal handoff can reuse the work phase's cached prefix (#423).
	let nativeHelperContext:
		| {
				initial: SystemMessage;
				tools: Tool[];
				protocol: string;
				updates: Array<{ at: number; message: SystemMessage }>;
		  }
		| undefined;
	// Whether the first round's system prompt carried the helper protocol. Off native routes every later round keeps that
	// prompt byte for byte, so the prefix cache survives the handoff; phase notes ride the request tail (FL-16).
	let helperProtocolInPrefix: boolean | undefined;
	// The terminal handoff names its tool in the request, so it keeps the tool
	// surface that a synthesis lock would otherwise remove.
	const terminalHandoffActive = (api: string): boolean =>
		helperToolAvailable && (phase.toolsLocked || phase.resultForced) && supportsNamedToolChoice(api);
	if (helperToolAvailable) {
		tools.push({
			name: INTERNAL_HELPER_RESULT_TOOL,
			label: "Submit helper result",
			description:
				"Submit the final internal result as this tool's arguments. Call alone, after gathering evidence. A validated submission finishes the run; no prose response follows." +
				(mutationResult ? ` ${MUTATION_FAILURE_RULE}` : ""),
			parameters: Type.Unsafe<Record<string, unknown>>(helperSchema),
			async execute(id, args) {
				if (scope.acceptedHelperResult !== null || phase.sealedBy !== null) {
					return {
						content: [{ type: "text", text: "The terminal result is already sealed." }],
						details: { kind: "error" },
						isError: true,
						terminate: true,
					};
				}
				phase.forceResult("result");
				phase.lockTools("result");
				const submitted = submittedHelperArguments.has(id) ? submittedHelperArguments.get(id) : args;
				submittedHelperArguments.delete(id);
				scope.helperTurnFailure = acceptHelperResult(args, submitted);
				if (scope.helperTurnFailure !== null) {
					return { content: [{ type: "text", text: scope.helperTurnFailure }], details: { kind: "error" }, isError: true };
				}
				return { content: [{ type: "text", text: "Internal result accepted." }], details: { kind: "ok" }, terminate: true };
			},
		});
	}
	if (tools.length === 0 && activeWorkerTools.length > 0) {
		process.stderr.write(`[worker] warning: no tools resolved for allowed=[${activeWorkerTools.join(",")}]\n`);
	}
	const effectiveThinkingLevel = clampThinkingLevelForModel(
		model,
		input.runtimeResolution?.effectiveThinkingLevel ?? input.thinkingLevel,
	);

	const inheritedMessages = seededWorkerMessages(input.contextSeed);
	const contextGuard = createWorkerContextGuard(observations.archive, {
		aliasFloor: seedLineage.aliasFloor,
		archivePath: observations.archivePath,
		route: {
			...(input.runtimeResolution?.modelTier !== undefined ? { modelTier: input.runtimeResolution.modelTier } : {}),
			...(input.runtimeResolution?.promptCaching !== undefined
				? { promptCaching: input.runtimeResolution.promptCaching }
				: {}),
		},
		// Every fold decision is journaled under the run and forwarded on its receipt-bearing telemetry frame.
		onDecision: (decision) => {
			if (
				scope.contextPressureWindow > 0 &&
				decision.tokensBefore >= scope.contextPressureWindow * THRASH_CONTEXT_FRACTION
			)
				scope.contextPressureCrossed = true;
			if (input.telemetryContext) telemetryHub().emit("context.fold", decision, input.telemetryContext);
			// A committed fold removed results the loop guard's read coverage counts as shown (X5).
			if (decision.cause === "working_set_evict")
				loopGuardRegistration.evaluate({ hook: "on_compaction", metadata: { stage: "working_set_evict" } });
		},
	});
	// The constraint rides samplingParams, which the completions adapter merges
	// into the body after every named field.
	const workerResponseFormat = workerResponseFormatFor(input);
	// Cleared for the rest of the run when the server refuses the field, so a
	// contract round falls back to its prompt rather than failing.
	scope.contractResponseFormat = workerContractResponseFormatFor(input);
	// The helper protocol names its own terminal tool, so only a prose-parsed contract carries the reminder.
	const contractReminder =
		input.resultContract !== undefined && !helperToolAvailable ? resultContractReminder(input.resultContract) : null;
	/**
	 * Row 384 before the call: a worker holds no target status, so a guarded target that lists live is asked once per
	 * run, and a requested model its answer lacks is refused before any request, as a main turn's is.
	 */
	let modelOffer: Promise<ModelRouteRefusal | null> | null = null;
	const modelOfferRefusal = (signal: AbortSignal | undefined): Promise<ModelRouteRefusal | null> => {
		modelOffer ??= probedModelOffer(input.target, input.runtime, input.wireModelId, {
			credentialsPresent: new Set(),
			httpTimeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
			...(signal ? { signal } : {}),
			...(input.apiKey ? { authToken: input.apiKey } : {}),
		}).then((offer) =>
			offer.kind === "not-offered"
				? {
						code: "model_unavailable",
						target: input.target.id,
						requested: input.wireModelId,
						available: offer.available,
					}
				: null,
		);
		return modelOffer;
	};
	const options: EngineAgentOptions = {
		// Row 384 backstop: a provider that accepts the id and serves another model is refused at its first response.
		refuseServedModelMismatch: () => modelRouteGuarded(input.runtime),
		// The run's restrictions are judged against the target as configured for
		// this run before each request, the same verdict the parent would reach.
		beforeStreamRequest: async ({ options: streamOptions }) => {
			const unavailable = await modelOfferRefusal(streamOptions?.signal);
			if (unavailable !== null)
				return { block: true, reason: modelRouteRefusalMessage(unavailable), modelRouteRefusal: unavailable };
			workerTelemetry?.stage("admission", "start");
			const reason = flowTransferRefusal(
				safety.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
				scope.runFlow,
				resolveModelDestination({
					targetId: input.target.id,
					runtimeId: input.runtime.id,
					url: input.target.url ?? null,
					model: input.wireModelId,
				}),
			);
			workerTelemetry?.stage("admission", "end");
			if (reason === null) return { block: false };
			// A retry or failover on this target carries the same labels and meets
			// the same refusal, so the parent must not spend another attempt on it.
			if (!scope.flowBlockReported) {
				scope.flowBlockReported = true;
				emit({ type: "pancode_run_outcome", payload: { outcomeCode: "information_flow_blocked", detail: reason } });
			}
			return { block: true, reason };
		},
		beforeToolCall: async ({ assistantMessage, toolCall }) => {
			if (toolCall.name === INTERNAL_HELPER_RESULT_TOOL) submittedHelperArguments.set(toolCall.id, toolCall.arguments);
			if (phase.lastRound !== null && toolCall.name !== INTERNAL_HELPER_RESULT_TOOL)
				return { block: true, reason: WORKER_REFUSAL_REPORT_BLOCK };
			// The evidence repair reopened reading, not the whole work surface (M-31).
			if (
				scope.evidenceRepairActive &&
				toolCall.name !== INTERNAL_HELPER_RESULT_TOOL &&
				!callRepeatsAsRead(toolCall.name, toolCall.arguments, () => undefined)
			)
				return {
					block: true,
					reason: "Only read-class tools run during this evidence repair. Read the inputs, then submit the result.",
				};
			if (helperSchema === null) return undefined;
			if (scope.acceptedHelperResult !== null || phase.sealedBy !== null)
				return { block: true, reason: "The helper result is sealed.", terminate: true };
			if (mutationResult && toolCall.name === INTERNAL_HELPER_RESULT_TOOL && !scope.helperExposedThisRound) {
				scope.helperTurnFailure = "The terminal handoff is unavailable during work. Finish the work phase first.";
				return { block: true, reason: scope.helperTurnFailure };
			}
			const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
			if (calls.some((call) => call.name === INTERNAL_HELPER_RESULT_TOOL) && calls.length !== 1) {
				scope.helperTurnFailure =
					"Submit exactly one terminal handoff, alone; mixed or duplicate handoff batches are rejected without executing work.";
				return { block: true, reason: scope.helperTurnFailure };
			}
			if ((phase.resultForced || phase.toolsLocked) && toolCall.name !== INTERNAL_HELPER_RESULT_TOOL) {
				scope.helperTurnFailure = "Work tools are disabled. Submit only the internal terminal result.";
				return { block: true, reason: scope.helperTurnFailure };
			}
			return undefined;
		},
		// Pi decides the turn boundary here, before `turn_end` is emitted, so a
		// terminal-handoff repair that exhausts its budget must run here too.
		// Run from a `turn_end` subscriber, the exhausted bound arrived after the
		// decision and cost one extra provider request.
		finishTurn: ({ message, toolResults }) => {
			if (phase.lastRound !== null && scope.workerModelRound >= phase.lastRound) return { action: "end" };
			if (
				helperSchema !== null &&
				scope.acceptedHelperResult === null &&
				toolResults.length > 0 &&
				(toolResults.some((result) => result.toolName === INTERNAL_HELPER_RESULT_TOOL) ||
					(scope.helperTerminalRequest && scope.helperTurnFailure !== null)) &&
				(phase.resultForced || phase.toolsLocked)
			) {
				const error = toolResults.find((result) => result.isError);
				const reason =
					scope.helperTurnFailure ??
					error?.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n") ??
					"The terminal handoff was not accepted.";
				// Every refused handoff, whether the contract, the tool schema or the batch rule refused it.
				for (const block of message.content) {
					if (block.type === "toolCall" && block.name === INTERNAL_HELPER_RESULT_TOOL)
						reportRejectedHelperResult(block.arguments, reason);
				}
				repairHelperResult(reason);
			}
			return helperSchema !== null && (scope.acceptedHelperResult !== null || phase.sealedBy !== null)
				? { action: "end" }
				: undefined;
		},
		// Each round sends through engineStreamSimple, whose guard sees the evicted request.
		delegateGuardsToolArguments: true,
		streamFn: (currentModel, transcript, streamOptions) => {
			if (scope.resultContractRepairsQueued > scope.resultContractRepairsStarted) {
				scope.resultContractRepairsStarted += 1;
				emit({ type: "pancode_repair_rounds_started", payload: { started: scope.resultContractRepairsStarted } });
			}
			const round = ++responseRound;
			const resolvedContext = resolvedRequestContext(transcript);
			const anthropicCompat =
				currentModel.api === "anthropic-messages"
					? (currentModel.compat as AnthropicMessagesCompat | undefined)
					: undefined;
			const codexCompat =
				currentModel.api === "openai-codex-responses"
					? (currentModel.compat as OpenAIResponsesCompat | undefined)
					: undefined;
			const codexToolChanges =
				helperToolAvailable &&
				codexCompat?.supportsMidConvoSystemMessages === true &&
				codexCompat.supportsAdditionalTools === true;
			// Pi needs an active initial tool to anchor native additions (#423).
			const nativeToolChanges =
				(codexToolChanges && (resolvedContext.tools ?? []).some((tool) => tool.name !== INTERNAL_HELPER_RESULT_TOOL)) ||
				(anthropicCompat?.supportsMidConvoSystemMessages === true &&
					anthropicCompat.supportsMidConvoToolChanges === true &&
					(!mutationResult || (resolvedContext.tools ?? []).some((tool) => tool.name !== INTERNAL_HELPER_RESULT_TOOL)));
			const helperDeclaredFromStart =
				helperToolAvailable && currentModel.api === "anthropic-messages" && !nativeToolChanges;
			const helperProtocol = `Return the result by calling ${INTERNAL_HELPER_RESULT_TOOL} alone with the result object as arguments. Successful submission ends the run; no narrative report is needed.`;
			const withProtocol = (note: string) =>
				`${resolvedContext.systemPrompt ?? ""}\n\n# Internal helper protocol\n${helperProtocol}${note ? ` ${note}` : ""}`;
			// The lock decides the round's tool surface, prompt, tail and directive. A context handback flips the lock after
			// the guard, so the round is shaped again then and the crossing request carries the handoff helper or the
			// locked-synthesis directive like any locked round (M3).
			const shapeRound = () => {
				scope.helperTerminalRequest = phase.toolsLocked || phase.resultForced;
				scope.helperExposedThisRound =
					helperToolAvailable &&
					((!mutationResult && !codexToolChanges) || phase.toolsLocked || phase.resultForced) &&
					(!(phase.toolsLocked || phase.resultForced) || helperForcedChoiceAvailable);
				// Native additions hide the helper until handoff without rewriting the
				// initial schemas. Older Anthropic models declare it early; the host
				// still rejects premature submission during the work phase (#423).
				// A locked round that cannot name the helper keeps it declared when the work phase declared it: the
				// Copilot SDK keeps a locked round's tools, so dropping it alone changed the session's tool set and missed
				// the cached prefix (M-31). An API that can name it already exposes it here, so only such rounds change.
				const helperDeclaredInWork = helperToolAvailable && !mutationResult && !codexToolChanges;
				const currentContext = {
					...resolvedContext,
					tools: (resolvedContext.tools ?? []).filter(
						(tool) =>
							tool.name !== INTERNAL_HELPER_RESULT_TOOL ||
							scope.helperExposedThisRound ||
							helperDeclaredFromStart ||
							helperDeclaredInWork,
					),
				};
				const helperOnRequest = scope.helperExposedThisRound || helperDeclaredFromStart;
				const helperLockedNote =
					!helperDeclaredFromStart && (phase.toolsLocked || phase.resultForced)
						? "Work tools are disabled. Earlier tool-use instructions apply only to the completed work phase; only the terminal handoff remains available. Do not invent missing evidence."
						: "";
				helperProtocolInPrefix ??= helperOnRequest;
				// Native routes slice the protocol back out of this prompt into a mid-conversation section below; every other
				// route keeps the first round's prompt and carries a protocol or note that arrived later on the tail.
				const systemPrompt = nativeToolChanges
					? helperOnRequest
						? withProtocol(helperLockedNote)
						: currentContext.systemPrompt
					: helperProtocolInPrefix
						? withProtocol("")
						: currentContext.systemPrompt;
				const helperTail =
					nativeToolChanges || !helperOnRequest
						? ""
						: [helperProtocolInPrefix ? "" : `Internal helper protocol: ${helperProtocol}`, helperLockedNote]
								.filter((part) => part.length > 0)
								.join(" ");
				// A synthesis lock without the helper handoff carries its directive on the
				// request tail, so the system prompt keeps the work phase's bytes and a
				// prefix cache survives the lock.
				const synthesisDirective =
					phase.toolsLocked && !helperOnRequest
						? { requiredResult: input.resultContract ? resultContractShape(input.resultContract) : undefined }
						: undefined;
				// Priced with the tail directive the round will carry; only the estimate sees it here.
				const pricedSystemPrompt =
					synthesisDirective !== undefined
						? `${systemPrompt ?? ""}\n\n${lockedSynthesisDirective(synthesisDirective.requiredResult)}`
						: helperTail
							? `${systemPrompt ?? ""}\n\n${helperTail}`
							: (systemPrompt ?? "");
				return { currentContext, systemPrompt, helperTail, synthesisDirective, pricedSystemPrompt };
			};
			let shape = shapeRound();
			const window = input.runtimeResolution?.capabilities.contextWindow ?? currentModel.contextWindow;
			const { reminders } = withResultContractReminder(
				resolvedContext.messages,
				contractReminder,
				inheritedMessages.length,
			);
			const pressureFor = ({ currentContext, pricedSystemPrompt }: ReturnType<typeof shapeRound>) => ({
				messages: currentContext.messages,
				overheadTokens: reminders.reduce((sum, reminder) => sum + estimateAgentMessageTokens(reminder as AgentMessage), 0),
				systemPrompt: pricedSystemPrompt,
				tools: currentContext.tools ?? [],
				contextWindow: window,
				threshold: compactionBudget(
					window,
					workerSettings.context.compaction.threshold,
					workerSettings.context.compaction.maxTokens,
					currentModel,
				).threshold,
				target: workerSettings.context.workingSet.target,
				rearmFraction: workerSettings.context.workingSet.rearmFraction,
				autoEvict: workerSettings.context.compaction.auto && workerSettings.context.workingSet.enabled,
				outputReserve: (inputTokens: number) =>
					requestOutputReserve(currentModel, currentModel.maxTokens, window, inputTokens),
				unanchoredInputTokens: (history: ReadonlyArray<AgentMessage>) => {
					const context = normalizeContext({
						systemPrompt: pricedSystemPrompt,
						...(currentContext.tools !== undefined ? { tools: currentContext.tools } : {}),
						messages: withResultContractReminder([...history], contractReminder, inheritedMessages.length)
							.messages as Context["messages"],
					});
					// The same anchor rule `request` re-pins through: with one, Pi reads the guard's own count.
					return anchorContextAtInputTokens(context, 1) === context ? estimateContextTokens(context).tokens : 0;
				},
			});
			let pressure = pressureFor(shape);
			let messages: AgentMessage[];
			scope.contextPressureWindow = window;
			try {
				messages = contextGuard(pressure);
			} catch (error) {
				if (error instanceof WorkerContextExhaustedError) {
					phase.sealOver(error.message);
					// The parent seals this with the run's last narration, so a run that dies at the wall still hands back
					// what it changed (CLI-H3).
					emit({
						type: "pancode_run_outcome",
						payload: {
							outcomeCode: "worker_context_exhausted",
							detail: exhaustedChangesDetail(runEffects.snapshot().mutatedPaths, contractCwd),
						},
					});
				}
				throw error;
			}
			// A request admitted without a fold reports no decision, so the thrash share reads the admitted count too.
			if (window > 0 && contextGuard.inputTokens >= window * THRASH_CONTEXT_FRACTION) scope.contextPressureCrossed = true;
			let handbackSurfaceTokens = 0;
			if (window > 0) {
				scope.runObservationWindow = {
					usableTokens:
						window - requestOutputReserve(currentModel, currentModel.maxTokens, window, contextGuard.inputTokens),
					workShare: input.role !== undefined ? workShare(input.role) : (input.limits?.context.workShare ?? 1),
					inputTokens: contextGuard.inputTokens,
				};
			}
			// M3: a run with a role hands back at its role's share of the usable window instead of dying at the wall.
			if (window > 0 && input.role !== undefined && !phase.toolsLocked) {
				const usable =
					window - requestOutputReserve(currentModel, currentModel.maxTokens, window, contextGuard.inputTokens);
				if (contextGuard.inputTokens >= usable * noteShare) scope.contextPressureCrossed = true;
				if (contextGuard.inputTokens >= usable * workShare(input.role)) {
					enterHandback("context");
					const surfaceTokens = ({ currentContext, pricedSystemPrompt }: ReturnType<typeof shapeRound>) =>
						estimateContextTokens(
							normalizeContext({ systemPrompt: pricedSystemPrompt, tools: currentContext.tools ?? [], messages: [] }),
						).tokens;
					const unlocked = shape;
					shape = shapeRound();
					pressure = pressureFor(shape);
					// The guard admitted the history under the work phase's surface; the handoff's helper and directive add to it.
					handbackSurfaceTokens = Math.max(0, surfaceTokens(shape) - surfaceTokens(unlocked));
				}
			}
			const { currentContext, systemPrompt, helperTail, synthesisDirective } = shape;
			// Stable sampling applies to every context-generation round, terminal
			// repairs included. It merges over the caller's options so it beats quirk
			// profiles and run overrides, which the adapters apply underneath.
			const sampling =
				input.sampling === "deterministic" ? deterministicSampling(currentModel, input.runtime.id) : undefined;
			// A final-only round (synthesis lock or final-only repair) ships no tools,
			// so a contract's schema can bind it without meeting a tool grammar.
			const contractFormat =
				scope.contractResponseFormat !== undefined && phase.toolsLocked && !helperToolAvailable
					? scope.contractResponseFormat
					: undefined;
			const optionsWith = (responseFormat: Record<string, unknown> | undefined) =>
				sampling === undefined && responseFormat === undefined
					? streamOptions
					: {
							...streamOptions,
							...sampling,
							samplingParams: {
								...streamOptions?.samplingParams,
								...sampling?.samplingParams,
								...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
							},
						};
			let requestOptions = optionsWith(workerResponseFormat ?? contractFormat);
			// Routed per attempt: the lock and the middleware choice can flip between
			// the first call and the overflow retry. The terminal handoff comes first
			// because it names its tool and keeps the surface a lock would remove. A
			// locked round has no declarations left, so neither middleware round
			// applies to it.
			// A refreshed credential replaces the one Pi resolved for this round; the
			// next round resolves its own through getApiKey (#427).
			let roundApiKey: string | undefined;
			// `inputTokens` is the count the guard admitted `history` at; admission and the clamp size it from that.
			const request = (history: AgentMessage[], inputTokens: number) => {
				const projected = withResultContractReminder(history, contractReminder, inheritedMessages.length).messages;
				const middlewareChoice = middlewareToolChoice.current();
				// Codex retains the work phase's parallel setting for WS deltas;
				// beforeToolCall still rejects mixed or duplicate handoffs (#423).
				const controlled = applyToolRounds(
					currentModel,
					{
						...currentContext,
						...(systemPrompt !== undefined ? { systemPrompt } : {}),
						messages: projected as typeof currentContext.messages,
					},
					roundApiKey === undefined ? requestOptions : { ...requestOptions, apiKey: roundApiKey },
					[
						terminalHandoffActive(currentModel.api)
							? { kind: "required", toolName: INTERNAL_HELPER_RESULT_TOOL, handoff: !codexToolChanges }
							: undefined,
						phase.toolsLocked ? { kind: "tools-removed" } : undefined,
						middlewareChoice.kind === "none" && !phase.toolsLocked ? { kind: "text-only" } : undefined,
						middlewareChoice.kind === "required" && !phase.toolsLocked
							? { kind: "required", toolName: middlewareChoice.toolName }
							: undefined,
					],
					input.target.id,
				);
				let requestContext: Context = controlled.context;
				if (helperToolAvailable && nativeToolChanges) {
					const basePrompt = currentContext.systemPrompt ?? "";
					// An evidence repair reopens the read tools by policy, never by erasing history (#423).
					const protocol =
						codexToolChanges && scope.evidenceRepairActive && !scope.helperTerminalRequest
							? "The host reopened the read-class tools for an evidence repair. Read the inputs the assignment names, then begin the terminal handoff again."
							: (systemPrompt ?? "").slice(basePrompt.length);
					// Codex can append declarations but cannot replay removals without
					// collapsing them into the leading item. Execution remains gated by
					// beforeToolCall even though the work declarations stay in history (#423).
					const requestTools = codexToolChanges
						? [
								...new Map(
									[...(nativeHelperContext?.tools ?? []), ...(currentContext.tools ?? [])].map((tool) => [tool.name, tool]),
								).values(),
							]
						: (resolvedRequestContext(controlled.context).tools ?? []);
					if (nativeHelperContext === undefined || nativeHelperContext.initial.content !== basePrompt) {
						nativeHelperContext = {
							initial: {
								role: "system",
								content: basePrompt,
								sections: { helper: protocol },
								toolsAdded: requestTools,
								timestamp: 0,
							},
							tools: requestTools,
							protocol,
							updates: [],
						};
					} else {
						const changes = getToolStateChanges(nativeHelperContext.tools, requestTools);
						if (
							changes.toolsAdded.length > 0 ||
							changes.toolsRemoved.length > 0 ||
							nativeHelperContext.protocol !== protocol
						) {
							const policy = codexToolChanges
								? (createHostPolicyMessage(
										`worker-handoff-${nativeHelperContext.updates.length}`,
										protocol,
										0,
									) as SystemMessage)
								: { role: "system" as const, content: "", sections: { helper: protocol }, timestamp: 0 };
							nativeHelperContext.updates.push({
								at: projected.length,
								message: { ...policy, ...changes },
							});
							nativeHelperContext.tools = requestTools;
							nativeHelperContext.protocol = protocol;
						}
					}
					const nativeMessages: Context["messages"] = [nativeHelperContext.initial];
					let start = 0;
					for (const update of nativeHelperContext.updates) {
						nativeMessages.push(...projected.slice(start, update.at), update.message);
						start = update.at;
					}
					nativeMessages.push(...projected.slice(start));
					requestContext = { messages: nativeMessages };
				}
				// Pi's SDK adapters report onResponse only for a 2xx answer, so the
				// status is read at the fetch boundary every adapter routes through.
				return streamToolRound(
					currentModel,
					{ ...controlled, context: requestContext },
					(attempt) => {
						const roundKind = attempt.toolRounds?.[0]?.kind ?? "normal";
						const choice = attempt.options?.toolChoice;
						const toolName = attempt.toolRounds?.[0]?.toolName;
						workerTelemetry?.attempt({
							roundKind,
							toolChoice: choice === "auto" || choice === "none" ? choice : toolName ? { name: toolName } : "auto",
							...(attempt.options?.samplingParams?.response_format !== undefined
								? { responseFormat: "json-schema" as const }
								: {}),
							...requestedThinking(effectiveThinkingLevel),
						});
						// Every attempt of a locked round carries the same tail directive, as does the "auto" form of a
						// middleware text lock; the system prompt and earlier messages keep their bytes.
						// The guard projected this history without invalidating the usage Pi anchors on, so the
						// provider-bound copy is re-anchored at the guard's count (A2c).
						const attemptContext = anchorContextAtInputTokens(
							synthesisDirective !== undefined
								? withLockedSynthesisDirective(attempt.context, synthesisDirective.requiredResult)
								: helperTail
									? withRequestTailDirective(attempt.context, helperTail)
									: middlewareChoice.kind === "none" && attempt.options?.toolChoice === "auto"
										? withLockedSynthesisDirective(attempt.context)
										: attempt.context,
							inputTokens,
						);
						const fetchImpl = attempt.options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
						const tracking = trackCallFetch(fetchImpl);
						scope.callTracking = tracking;
						scope.callUsageReported = false;
						roundProviderHttpStatus = null;
						tracking.start(currentModel.api, attempt.options?.transport);
						const lockedRound = phase.toolsLocked || phase.resultForced;
						const attemptOptions = { ...attempt.options, pancodeInputTokens: inputTokens };
						const { reasoning: _reasoning, thinkingBudgets: _thinkingBudgets, ...thinkingOffOptions } = attemptOptions;
						// Responses APIs render the reasoning effort ahead of the whole input, and Pi sends the model's off effort
						// (and no encrypted reasoning) when the level is dropped, so a locked round there keeps the run's level:
						// dropping it made a Codex round miss every cached token and turned thinking off mid-run (FL-16). On copilot-sdk
						// the dropped level became a setModel on the live session, which read none of its cached prefix (M-20).
						const source = boundWorkerResponse(
							currentModel,
							attemptContext,
							lockedRound && !REASONING_PREFIX_APIS.has(currentModel.api) ? thinkingOffOptions : attemptOptions,
							{
								locked: lockedRound,
								responseSeconds:
									input.limits !== undefined
										? input.limits.time.responseMs / 1000
										: workerSettings.safety.limits.workerResponseSeconds,
								round,
								onLimit: (outcomeCode, detail) => {
									phase.seal(detail);
									emit({ type: "pancode_run_outcome", payload: { outcomeCode, detail } });
								},
							},
							(boundedOptions) =>
								engineStreamSimple(currentModel, attemptContext, {
									...boundedOptions,
									fetch: async (url, init) => {
										const response = await tracking.fetch(url, init);
										scope.lastProviderHttpStatus = response.status;
										roundProviderHttpStatus = response.status;
										// Pi retries a retryable status inside one attempt; the response that opens the stream is
										// the first byte (#434).
										if (response.ok) workerTelemetry?.mark("firstByte");
										return response;
									},
									onProviderStreamEvent: async (data, eventModel) => {
										// Wire-field presence distinguishes reported zero from SDK placeholders (#434).
										if (data !== null && typeof data === "object") {
											const frame = data as Record<string, unknown>;
											for (const value of [frame, frame.message, frame.response]) {
												if (value === null || typeof value !== "object") continue;
												const usage = (value as Record<string, unknown>).usage;
												if (usage === null || typeof usage !== "object") continue;
												scope.callUsageReported ||= hasTokenUsageCounts(usage as Record<string, unknown>);
											}
										}
										await boundedOptions?.onProviderStreamEvent?.(data, eventModel);
									},
								}),
						);
						return (
							workerTelemetry?.observe(source, (message) => {
								const aborted = input.signal?.aborted || (message as { stopReason?: unknown } | null)?.stopReason === "aborted";
								const failure = tracking.failure(message, aborted, scope.callUsageReported);
								const harness = aborted
									? (scope.workerStopCause ?? (input.signal?.aborted ? "parent_cancel" : undefined))
									: undefined;
								return harness ? { ...failure, stage: "harness", errorClass: harness } : failure;
							}) ?? source
						);
					},
					input.target.id,
				);
			};
			// A token the server rejects as expired earns one locked refresh and one
			// retry of the same request, as the main turn does; a failed refresh ends
			// the round with the login remedy (#427).
			const admitted = contextGuard.inputTokens + handbackSurfaceTokens;
			const authRetried = retryStreamOnceOnAuthRejection(
				request(messages, admitted),
				(error) => isProviderAuthRejection(error.errorMessage, roundProviderHttpStatus ?? undefined),
				async () => {
					const apiKey = await refreshWorkerOAuthKey();
					if (apiKey === null) return null;
					roundApiKey = apiKey;
					return request(messages, admitted);
				},
			);
			// A server that refuses the contract's schema before answering gets the
			// same round once without it; the prompt and validator still hold the
			// contract, and later rounds stop sending the field.
			const first =
				contractFormat === undefined
					? authRetried
					: retryStreamOnceOnAuthRejection(
							authRetried,
							(error) => isResponseSchemaRejection(error.errorMessage),
							async () => {
								scope.contractResponseFormat = undefined;
								requestOptions = optionsWith(workerResponseFormat);
								return request(messages, admitted);
							},
						);
			// The server is the authority on its own limit. An unreported window, a
			// window that changed since it was resolved, or a server tokenizer that
			// counts above PanCode's estimate all surface as a server overflow. It earns
			// one reversible eviction and one retry; a second overflow is final.
			return retryStreamOnceOnOverflow(first, () => {
				const projected = contextGuard.recover(pressure);
				return projected ? request(projected, contextGuard.inputTokens) : null;
			});
		},
		initialState: {
			systemPrompt: input.systemPrompt,
			model,
			thinkingLevel: effectiveThinkingLevel,
			tools,
			messages: inheritedMessages,
		},
		getApiKey: async () => {
			workerTelemetry?.stage("transform", "end");
			// A key the parent handed over needs no resolution, so the call has no auth stage (#434).
			if (!input.authProfile) return input.apiKey;
			workerTelemetry?.stage("auth", "start");
			let refreshed: boolean | undefined;
			try {
				registerPancodeOAuthProviders();
				const resolved = await openAuthStorage().resolveApiKey(input.authProfile, {
					includeFallback: false,
					...(input.signal ? { signal: input.signal } : {}),
				});
				refreshed = resolved.refreshed;
				if (!resolved.available || !resolved.apiKey) {
					throw new Error(resolved.detail ?? `Credential '${input.authProfile}' is unavailable. Log in again.`);
				}
				lastAuthResolution = resolved;
				return resolved.apiKey;
			} finally {
				workerTelemetry?.stage("auth", "end", refreshed === undefined ? {} : { refreshed });
			}
		},
	};
	// Providers derive prompt-cache affinity (openai-codex prompt_cache_key,
	// session headers) from the session ID. Without one every worker call
	// landed cold: captured Luna workers read 48% of input from cache against
	// the main agent's 89%. One opaque ID per invocation keeps it out of the
	// prompt, so prompt and tool attestation hashes are unchanged. Where the
	// backend routes to its cache by that ID, workers with one stable head and
	// cache lane take the same one, so a later worker reads the head an earlier
	// one wrote (FL-17).
	options.sessionId =
		input.sessionId ||
		workerCacheFamilyId({
			api: model.api,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: effectiveThinkingLevel,
			systemPrompt: input.systemPrompt,
			tools,
			lane: input.cacheLane ?? 0,
		}) ||
		randomUUID();
	// That id may be the parent's: a worker leaves the parent's resumable Copilot conversation alone (bt-10).
	disableCopilotConversationResume();

	const { agent } = createEngineAgent(options);
	// Pi adds a leading prompt/tool declaration; exclude the entire inherited baseline.
	const inheritedCount = agent.state.messages.length;
	// The result-contract repair queues a call/result pair that must land in
	// one drain, or the provider sees a lone assistant tool call. Operator
	// steers batch the same way the main agent's do: all at the next slot.
	agent.followUpMode = "all";
	agent.steeringMode = "all";
	scope.abortWorkerForBound = () => {
		scope.workerStopCause ??= "loop_guard";
		agent.abort();
	};
	// Qwopus 3.8 explored context init's whole 240 s ceiling one read at a time and was
	// aborted before submitting. A host deadline ends exploration while the terminal round fits.
	const synthesisTimer =
		input.synthesisAt === undefined
			? undefined
			: setTimeout(
					() => {
						phase.lockTools("synthesis");
					},
					Math.max(0, input.synthesisAt - Date.now()),
				);
	synthesisTimer?.unref();
	// DESIGN 4.5: at 85% of the wall clock the next round is the handback round, and the host stops the run at the
	// wall. A run the wall clock moved to handback seals timed_out with what it reports (fleet M8).
	const wallLimits = input.limits?.time;
	const wallTimer =
		wallLimits === undefined
			? undefined
			: setTimeout(
					() => {
						if (phase.sealedBy !== null) return;
						enterHandback("time");
						emit({
							type: "pancode_run_outcome",
							payload: {
								outcomeCode: "worker_run_timeout",
								detail: `worker_run_timeout: the run reached ${Math.round(WALL_HANDBACK_SHARE * 100)}% of its ${Math.round(wallLimits.wallMs / 1000)} s wall clock; its tools are withdrawn and its next round is its report`,
							},
						});
					},
					Math.max(0, wallLimits.handbackAt - Date.now()),
				);
	wallTimer?.unref();
	const repairHelperResult = (reason: string): void => {
		const workOpen = handoffFromOpenWork || (!phase.toolsLocked && !phase.resultForced);
		handoffFromOpenWork = false;
		if (!input.resultContract || scope.acceptedHelperResult !== null || phase.sealedBy !== null) return;
		if (phase.lastRound !== null) return;
		phase.forceResult("result");
		phase.lockTools("result");
		if (scope.resultContractRepairsStarted >= RESULT_CONTRACT_REPAIR_LIMIT) {
			phase.sealOver(`result contract failed after ${RESULT_CONTRACT_REPAIR_LIMIT} bounded repair rounds: ${reason}`);
			emit({
				type: "pancode_run_outcome",
				payload: { outcomeCode: "result_contract_exhausted", detail: phase.sealedBy ?? "" },
			});
			return;
		}
		// #425: rejected sibling handoffs share one repair request; queuing it is not running it.
		if (scope.resultContractRepairsQueued > scope.resultContractRepairsStarted) return;
		scope.resultContractRepairsQueued += 1;
		// M-31: a result rejected for missing evidence, or before anything ran, is repaired by reading. The round keeps
		// the work phase's declarations and request shape, so the cached prefix survives; admission narrows it to reads.
		const readFirst = evidenceRepairFor(reason, workOpen);
		if (readFirst) {
			scope.evidenceRepairActive = true;
			phase.releaseResult();
			phase.unlockTools();
		}
		const revisionToolsAvailable = !phase.toolsLocked;
		const instruction = readFirst
			? evidenceRepairInstruction(reason, `submit the result again with ${INTERNAL_HELPER_RESULT_TOOL}`)
			: helperForcedChoiceAvailable && !revisionToolsAvailable
				? `${reason} Work tools remain disabled. Repair the result by calling ${INTERNAL_HELPER_RESULT_TOOL} exactly once, alone, with the complete result object. Do not emit prose.`
				: reason;
		for (const message of resultContractRepairMessages(
			{
				contract: input.resultContract,
				reason: instruction,
				attempt: scope.resultContractRepairsQueued,
				anchors: observedReadAnchors(contractCwd, scope.observedReadRanges),
				toolsAvailable: revisionToolsAvailable,
			},
			{ provider: model.provider, api: model.api, model: model.id },
		)) {
			const repairMessage =
				helperForcedChoiceAvailable && !mutationResult && !revisionToolsAvailable && message.role === "toolResult"
					? {
							...message,
							content: [
								{
									type: "text" as const,
									text: `${instruction}\nRequired arguments schema: ${JSON.stringify(helperSchema)}\nObserved read ranges: ${observedReadAnchors(contractCwd, scope.observedReadRanges).join(", ") || "none"}`,
								},
							],
						}
					: message;
			// A reopened round continues on the rejected handoff's tool result, so its instruction rides the steering
			// queue, which lands before that request; a follow-up would wait for the run to stop (M-31).
			if (readFirst) agent.steer(repairMessage as unknown as AgentMessage);
			else agent.followUp(repairMessage as unknown as AgentMessage);
		}
	};
	const unsubscribe = agent.subscribe(async (event) => {
		if (
			event.type === "message_end" &&
			isAssistantMessage(event.message) &&
			!phase.toolsLocked &&
			phase.sealedBy === null &&
			phase.lastRound === null
		) {
			const reminder = middlewareToolChoice.completeRound(event.message);
			if (reminder !== null) {
				if (!hostWrittenExchange(event.message)) workerTelemetry?.settle(event.message);
				// This answer is a request the thrash note may have ridden, though the round ends here.
				thrashOutcome.observe(event);
				// The middleware round must run before this answer can seal a terminal result (#423).
				const tail: AgentMessage = { role: "user", content: reminder, timestamp: Date.now() };
				if (event.message.content.some((block) => block.type === "toolCall")) agent.steer(tail);
				else agent.followUp(tail);
				emit(event);
				return;
			}
		}
		if (event.type === "turn_start") {
			const choice = middlewareToolChoice.current();
			const handoff = terminalHandoffActive(model.api);
			workerTelemetry?.begin({
				roundKind: handoff
					? "required"
					: phase.toolsLocked
						? "tools-removed"
						: choice.kind === "none"
							? "text-only"
							: choice.kind === "required"
								? "required"
								: "normal",
				toolChoice: handoff
					? { name: INTERNAL_HELPER_RESULT_TOOL }
					: phase.toolsLocked || choice.kind === "none"
						? "none"
						: choice.kind === "required"
							? { name: choice.toolName }
							: "auto",
				// The same predicate streamFn applies to this round's request.
				...(workerResponseFormat !== undefined ||
				(scope.contractResponseFormat !== undefined && phase.toolsLocked && !helperToolAvailable)
					? { responseFormat: "json-schema" as const }
					: {}),
				...requestedThinking(effectiveThinkingLevel),
			});
			scope.callTracking = null;
			scope.callUsageReported = false;
			scope.workerModelRound += 1;
			scope.helperTurnFailure = null;
		}
		if (
			event.type === "message_end" &&
			isAssistantMessage(event.message) &&
			(event.message.usage as unknown as Record<string, unknown>).callInvoked !== false
		) {
			const message = event.message as unknown as Record<string, unknown>;
			const usage = event.message.usage as unknown as Record<string, unknown>;
			const reported = scope.callUsageReported || normalizeTokenUsage(usage).observed;
			const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
			const failure = failed
				? (scope.callTracking?.failure(event.message, event.message.stopReason === "aborted", reported) ??
					classifyCallFailure(event.message, { invoked: false }))
				: undefined;
			if (failure !== undefined) message.failure = failure;
			usage.callInvoked = failure?.invoked ?? true;
			usage.usageReported = reported;
		}
		// A repair exchange PanCode wrote into the conversation reached no provider: the round's attempt belongs to the request
		// that follows it, so it settles no attempt of its own (C-28).
		if (event.type === "message_end" && isAssistantMessage(event.message) && !hostWrittenExchange(event.message))
			workerTelemetry?.settle(event.message);
		// Detect the whole terminal batch before any call is prepared/executed.
		// beforeToolCall rejects every sibling, regardless of ordering or parallelism.
		if (helperSchema !== null && event.type === "message_end" && isAssistantMessage(event.message)) {
			const calls = event.message.content.filter((block) => block.type === "toolCall");
			if (calls.some((call) => call.name === INTERNAL_HELPER_RESULT_TOOL)) {
				handoffFromOpenWork = !phase.toolsLocked && !phase.resultForced;
				phase.forceResult("result");
				phase.lockTools("result");
				if (calls.length !== 1)
					scope.helperTurnFailure =
						"Submit exactly one terminal handoff, alone; mixed or duplicate batches cannot execute work.";
			}
		}
		if (event.type === "tool_execution_start" && event.toolName !== INTERNAL_HELPER_RESULT_TOOL) {
			scope.toolExecutionsStarted += 1;
			middlewareToolChoice.toolStarted(event.toolName, event.args);
		}
		// Read spans this run actually observed. They ground the terminal result
		// (a cited line has to fall inside one) and they are handed back verbatim
		// in a repair round, so re-emitting findings never invites invention.
		// Effects and grounding come from the capability operations that
		// settled: a gateway op=call as the capability it ran, a chain as each
		// admitted child, once each. Provider replay keeps the wire records.
		// The result submission is this run's handoff, never a workspace call, so it opens no write record (C-14).
		if (
			(event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
			!(helperToolAvailable && event.toolName === INTERNAL_HELPER_RESULT_TOOL)
		) {
			recordToolExecutionEffects(runEffects, event);
		}
		// After the effects, so a call that changed the workspace has settled the note under its own id first.
		thrashOutcome.observe(event);
		if (event.type === "tool_execution_start") {
			const call = effectiveToolCall(event.toolName, event.args);
			if (call.toolName === ToolNames.Read) {
				const request = readCitationRequest(call.args);
				if (request !== null) pendingReadCitations.set(event.toolCallId, request);
			} else if (call.toolName === ToolNames.Grep || call.toolName === ToolNames.Bash) {
				// A bash `grep -n` reports the lines it printed as observedLines, as the grep tool does (FL-12).
				pendingGrepCalls.add(event.toolCallId);
			} else if (
				call.toolName === ToolNames.Context &&
				call.args?.scope === "recall" &&
				typeof call.args.ref === "string"
			) {
				pendingRecallCalls.add(event.toolCallId);
			}
		}
		if (event.type === "tool_execution_end") {
			const request = pendingReadCitations.get(event.toolCallId);
			pendingReadCitations.delete(event.toolCallId);
			const grepped = pendingGrepCalls.delete(event.toolCallId);
			if (event.isError !== true) {
				if (request !== undefined) recordObservedRead(contractCwd, scope.observedReadRanges, request, event.result);
				if (grepped) recordObservedGrep(scope.observedGrepLines, (event.result as { details?: unknown } | null)?.details);
			}
			observeChainChildren(event.toolName, event.result);
			// Only a recall that returned an archived observation brings evicted content back.
			if (pendingRecallCalls.delete(event.toolCallId) && event.isError !== true) evictedRecalls += 1;
			// One recall or context host turn per run and one streak turn per run, delivered after this tool batch, never
			// once the run is answering or bound. A standing streak note holds back the other causes until progress.
			const thrashCause =
				evictedRecalls > THRASH_RECALL_LIMIT
					? ("recall" as const)
					: scope.contextPressureCrossed && runEffects.snapshot().mutatedPaths.size === 0
						? ("context" as const)
						: null;
			const cause =
				thrashCause !== null && !thrashNudged && !scope.streakNoteOpen
					? thrashCause
					: scope.readStreakEscalated > 0 && !streakNudged && !thrashNudged
						? ("streak" as const)
						: null;
			if (
				cause !== null &&
				!phase.toolsLocked &&
				!phase.resultForced &&
				phase.sealedBy === null &&
				phase.lastRound === null
			) {
				if (cause === "streak") {
					streakNudged = true;
					scope.streakNoteOpen = true;
				} else thrashNudged = true;
				agent.steer({
					role: "user",
					content: thrashHostNote(
						cause,
						cause === "streak" ? scope.readStreakEscalated : evictedRecalls,
						workerCanWrite,
						input.role !== undefined,
						workerCanPlan,
					),
					timestamp: Date.now(),
				});
				process.stderr.write(
					`[worker] thrash guard: ${cause === "recall" ? `${evictedRecalls} recalls of evicted observations` : cause === "streak" ? `${scope.readStreakEscalated} read-only calls in a row` : "context past the thrash share with no change"}; told the worker to write now or report\n`,
				);
				if (input.telemetryContext)
					telemetryHub().emit(
						"middleware.fired",
						{
							firingId: thrashOutcome.fire(),
							hook: "after_tool",
							phase: "sync",
							ruleId: "worker.thrash",
							effects: ["inject_reminder"],
							severity: "warn",
							evidence:
								cause === "recall"
									? "count:evicted-recall@worker"
									: cause === "streak"
										? "count:read-class-calls@worker"
										: "share:context-window@worker",
							...(cause === "recall" ? { tool: ToolNames.Context } : {}),
						},
						input.telemetryContext,
					);
			}
			// The streak's second step is judged at the tool end that raised it, never carried to a later call.
			scope.readStreakEscalated = 0;
		}
		// Synthesis-locked run: the round ships no tool surface, so a model that
		// calls a tool anyway lands its chat template's tool-call syntax in the
		// reply as plain text. Sanitize the finished message in place before it
		// hits stdout; pi stores this same object in agent state, so the NDJSON
		// event, the dispatch consumer's answer reconstruction, and any later
		// provider round all see the same text.
		// A markup-only locked reply re-prompted this round; the result-contract
		// check below stands aside so the round costs the one re-prompt, not one
		// of the contract's bounded repair slots (on ornith both were queued for
		// the same message and the run then ran out of repairs on a later
		// grounding violation).
		let repromptedThisMessage = false;
		if (
			phase.sealedBy === null &&
			phase.lastRound === null &&
			phase.toolsLocked &&
			!helperToolAvailable &&
			event.type === "message_end"
		) {
			const stripped = sanitizeLockedSynthesisMessage(event.message);
			// A model that calls a tool anyway hands its markup back as text and
			// the sanitizer leaves only the fallback notice: the training habit
			// survives the strip (Qwen3.8 did it in 1 of 5 stripped runs). One
			// re-prompt, delivered as a tool exchange like the result-contract
			// repair, asks for the required result format; a second markup-only reply
			// keeps the notice.
			if (stripped && lockedSynthesisReprompts < 1 && isLockedSynthesisFallbackOnly(event.message)) {
				lockedSynthesisReprompts += 1;
				repromptedThisMessage = true;
				process.stderr.write(
					"[worker] synthesis lock: reply was tool-call markup only; re-prompting once for the required final format\n",
				);
				const directive = lockedSynthesisRepromptMessages(
					lockedSynthesisReprompts,
					{ provider: model.provider, api: model.api, model: model.id },
					input.resultContract ? resultContractShape(input.resultContract) : undefined,
				).find((message) => message.role === "toolResult");
				if (directive?.role === "toolResult") {
					agent.followUp({ role: "user", content: directive.content, timestamp: Date.now() } as AgentMessage);
				}
			}
		}
		// Bounded terminal-contract repair, on whichever message ends the run.
		// A worker that finishes inside its budget never trips the synthesis
		// lock, so gating this on the lock would skip repair on exactly the
		// well-behaved runs it exists to save. The orchestrator validates the
		// same contract against the sealed receipt; this is the only point at
		// which the model can still act on the validator's reason.
		// The report after the refusal limit gets no repair round; dispatch judges it as it stands.
		const contract = phase.lastRound === null ? input.resultContract : undefined;
		if (
			helperSchema !== null &&
			!mutationResult &&
			contract &&
			!repromptedThisMessage &&
			event.type === "message_end" &&
			isTerminalAssistantMessage(event.message)
		) {
			const text = assistantMessageText(event.message);
			let submitted: unknown;
			let reason: string | null;
			let refused = false;
			try {
				submitted = JSON.parse(text ?? "");
				reason = acceptHelperResult(submitted);
				refused = reason !== null;
			} catch {
				reason = "The internal result must be a JSON object conforming to the declared contract.";
			}
			if (refused && reason !== null) reportRejectedHelperResult(submitted, reason);
			if (reason !== null) repairHelperResult(reason);
		}
		if (
			(helperSchema === null || mutationResult) &&
			scope.acceptedHelperResult === null &&
			contract &&
			!repromptedThisMessage &&
			event.type === "message_end" &&
			isTerminalAssistantMessage(event.message)
		) {
			// A file-scoped coder sometimes ends its first reply with no tool call and a
			// report that it has no edit tool or cannot find the file (p8/S1, p9/C3),
			// then does the same work when asked again. The orchestrator fails every
			// zero-call edit run as obligation_unmet, so one repair round costs nothing
			// the run had left. A second empty reply passes through to that outcome.
			const zeroToolViolation =
				scope.toolExecutionsStarted === 0 &&
				!zeroToolRepairQueued &&
				contract.kind === "mutation-report" &&
				input.readOnly !== true &&
				!phase.toolsLocked &&
				activeWorkerTools.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write)
					? `no tool was called, so none of the assignment was done. The admitted tools are ${activeWorkerTools.join(", ")}, and they include ${activeWorkerTools.filter((tool) => tool === ToolNames.Edit || tool === ToolNames.Write).join(" and ")}. Inspect the workspace and do the assignment with them. If a tool refuses a call, report that refusal as the limitation.`
					: null;
			// A second no-work reply belongs to obligation_unmet, even when its
			// report is malformed. The p8/S1 recovery must not spend shape repairs.
			const contractViolation =
				zeroToolRepairQueued && scope.toolExecutionsStarted === 0
					? null
					: (zeroToolViolation ??
						terminalContractViolation(
							contract,
							event.message,
							contractCwd,
							groundingRanges(scope.observedReadRanges, scope.observedGrepLines),
							runEffects.snapshot(),
						) ??
						(mutationResult ? null : unobservedReportReason()));
			// A well-formed gate verdict that cites none of its packet is asked once, with the ids that exist (M10). The
			// grader still seals a second uncited verdict exhausted, so this round never stands in for that rule.
			const citationViolation =
				contractViolation === null &&
				!citationRepairQueued &&
				!(zeroToolRepairQueued && scope.toolExecutionsStarted === 0) &&
				scope.resultContractRepairsQueued < RESULT_CONTRACT_REPAIR_LIMIT
					? gateCitationViolation(contract, assistantMessageText(event.message))
					: null;
			if (citationViolation !== null) citationRepairQueued = true;
			const violation = contractViolation ?? citationViolation;
			const formatFailure =
				mutationResult &&
				violation !== null &&
				zeroToolViolation === null &&
				validateResultContract({
					contract,
					output: assistantMessageText(event.message),
					cwd: contractCwd,
					networkAllowed: true,
					filesystem: nodeResultContractFilesystem(),
				}).conformance === "fail";
			if (helperSchema !== null && zeroToolRepairQueued && scope.toolExecutionsStarted === 0) {
				// An unsealed helper would otherwise hide the parent's no-work classification behind a generic failed exit.
				// Without a helper the worker exits clean and the parent's grader seals obligation_unmet from the empty tool activity.
				phase.sealOver("obligation change-or-declared unmet: worker executed no tools, so it did none of its assignment");
				emit({
					type: "pancode_run_outcome",
					payload: { outcomeCode: "obligation_unmet", detail: phase.sealedBy ?? "" },
				});
			} else if (violation === null && helperSchema !== null) {
				const parsed = parseJsonObjectPayload(assistantMessageText(event.message) ?? "");
				if (parsed.ok) {
					const reason = acceptHelperResult(parsed.value);
					if (reason !== null) reportRejectedHelperResult(parsed.value, reason);
					if (reason !== null && !(zeroToolRepairQueued && scope.toolExecutionsStarted === 0)) repairHelperResult(reason);
				}
			} else if (violation !== null && formatFailure) {
				repairHelperResult(violation);
			} else if (violation !== null) {
				if (zeroToolViolation !== null || scope.resultContractRepairsStarted < RESULT_CONTRACT_REPAIR_LIMIT) {
					if (zeroToolViolation !== null) zeroToolRepairQueued = true;
					else scope.resultContractRepairsQueued += 1;
					// M-31: missing evidence is repaired by reading, so it never takes the final-only route below.
					const readFirst = zeroToolViolation === null && evidenceRepairFor(violation, !phase.toolsLocked);
					if (readFirst) scope.evidenceRepairActive = true;
					// A finished answer in prose needs no more work, only its form. Where
					// the runtime can bind that form, the repair round goes final-only so
					// the schema can ride it; tools there would keep it unconstrained.
					const constrainedRepair =
						!readFirst &&
						scope.contractResponseFormat !== undefined &&
						zeroToolViolation === null &&
						finishedReplyWithoutJsonResult(event.message);
					if (constrainedRepair) phase.lockTools("result");
					const revisionToolsAvailable = readFirst || !phase.toolsLocked;
					if (!revisionToolsAvailable) phase.lockTools("result");
					// A repair with tools retains the paired tool exchange. Final-only
					// repair starts a fresh user turn to break local tool-call fixation. Templates
					// that key history rendering off the last `user` message re-render
					// every earlier assistant turn when one is appended mid-run, which
					// invalidates the whole prompt cache: Nemotron reprocessed 11,352
					// tokens for this directive as `user` against 407 for the same
					// bytes as a tool result (#55). The synthetic assistant call gives
					// the result a real tool_call_id for strict endpoints (#62).
					const repairInput = {
						contract,
						reason: readFirst ? evidenceRepairInstruction(violation, "emit the required result again") : violation,
						attempt: zeroToolViolation !== null ? 1 : scope.resultContractRepairsQueued,
						anchors: observedReadAnchors(contractCwd, scope.observedReadRanges),
						toolsAvailable: revisionToolsAvailable,
					};
					const repair = revisionToolsAvailable
						? resultContractRepairMessages(repairInput, { provider: model.provider, api: model.api, model: model.id })
						: [resultContractRepairUserMessage(repairInput)];
					for (const message of repair) agent.followUp(message as unknown as AgentMessage);
				} else if (phase.sealedBy === null) {
					phase.seal(`result contract failed after ${RESULT_CONTRACT_REPAIR_LIMIT} bounded repair rounds: ${violation}`);
					emit({
						type: "pancode_run_outcome",
						payload: { outcomeCode: "result_contract_exhausted", detail: phase.sealedBy ?? "" },
					});
				}
			}
		}
		emit(event);
	});

	const {
		escalationConfig,
		clearActiveEscalation,
		resolveEscalation,
		resolveDecision,
		denyActiveEscalationOnAbort,
		unsubscribePermission,
	} = createWorkerPermissions(scope);

	const workerTelemetry = input.telemetryContext
		? createWorkerCallTelemetry(
				input.telemetryContext,
				{
					targetId: input.target.id,
					runtimeId: input.runtime.id,
					api: model.api,
					requestedModel: model.id,
					reportedModel: { kind: "unknown", reason: "not-observed" },
				},
				resolveEffectivePricing(input.target, input.runtime, input.wireModelId),
				emit,
			)
		: undefined;
	// The run's identity scopes its tool and middleware records, so the host accepts them as this run's (#434).
	const runScoped = <T>(work: () => T): T =>
		input.telemetryContext ? withTelemetryContext(input.telemetryContext, work) : work();
	const promise = runScoped(() => finishWorkerRun(scope));

	return {
		promise,
		abort: (cause) => {
			// Under escalate a parked call would otherwise keep waitForIdle from
			// returning, so cancel it before aborting. cancelParkedCalls is a
			// no-op when nothing is parked, so deny/fail abort stays unchanged.
			if (escalationConfig) {
				const reason =
					cause === "owner_channel_closed"
						? "permission request expired: the session that owns this worker exited or disconnected; re-run the work from a live session"
						: "run aborted while a permission escalation was pending";
				denyActiveEscalationOnAbort(reason);
				registry.cancelParkedCalls(reason);
			}
			scope.workerStopCause ??= cause === "internal" ? "internal" : "parent_cancel";
			agent.abort();
		},
		steer: (text: string) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) return false;
			// A worker reports no turn_start, so its operator's steer is where the read streak starts over.
			readStreakRegistration?.resetStreak();
			agent.steer(taskMessage(trimmed));
			return true;
		},
		resolvePermission: (
			requestId: string,
			decision: "approve" | "deny",
			binding?: WorkerDecisionBinding,
			cause?: "timeout",
		) => resolveDecision(requestId, decision, binding, cause),
		holdPermission: (requestId: string, holdMs: number) => {
			const active = scope.activeEscalation;
			// Without a backstop the worker's own timer is the window, and no parent may stretch it.
			if (active === null || active.requestId !== requestId || escalationConfig?.backstopMs === undefined) return false;
			const at = performance.now();
			const timerAt = permissionHoldBackstopAt({ openedAt: active.openedAt, now: at, holdMs, currentAt: active.timerAt });
			if (timerAt === active.timerAt) return true;
			clearTimeout(active.timer);
			active.timerAt = timerAt;
			active.timer = setTimeout(() => resolveEscalation(requestId, "deny", "timeout"), timerAt - at);
			return true;
		},
	};
}
