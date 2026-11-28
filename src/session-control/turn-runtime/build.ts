// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * Building a turn runtime's agent: admitting the selected route, reusing a settled agent or constructing a new one with
 * its stream function, watchdog, tool gates, continuation and event handler, and installing it on the chat loop state.
 */

import { performance } from "node:perf_hooks";
import { replySegment } from "../../core/answer-segments.js";
import { outputLimitCutOffToolCallIds } from "../../core/assistant-output.js";
import type { BackendCompletionTimings } from "../../core/cache-telemetry.js";
import { gatewayRoutingObservationFromRecord, gatewayRoutingObservationLabel } from "../../core/gateway-routing.js";
import { isHostAuthored } from "../../core/message-accounting.js";
import { modelRouteGuarded } from "../../core/response-model-id.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../core/tool-surface.js";
import {
	applyModelCapabilityPatch,
	canonicalEndpointKey,
	recordEndpointThroughput,
	refineRuntimeTargetWithModelHints,
} from "../../domains/providers/index.js";
import { readDiffusionFrame } from "../../engine/apis/diffusion-frames.js";
import { setGlobalDefaultMaxOutputTokens } from "../../engine/apis/index.js";
import { hasAssistantGenerationDelta } from "../../engine/generation-delta.js";
import { sanitizeLockedSynthesisMessage } from "../../engine/loop-guard-synthesis.js";
import { createRequestStructures } from "../../engine/request-structure.js";
import type { AgentEvent, AgentMessage, EngineModel, Usage } from "../../engine/types.js";
import type { resolveAgentTools } from "../../tools/agent-tools.js";
import { closeAskUserInterviewOnAssistantTurn } from "../../tools/ask-user.js";
import { completionOfToolResult } from "../../tools/finish.js";
import {
	type AssistantCallTiming,
	type BackendCacheVerdict,
	backendCacheVerdict,
	estimatedUsageForInterruptedTurn,
	extractText,
	extractThinking,
	fallbackIdentityPrompt,
	HOST_STATUS_NOTICE_KEY,
	hasStructuredToolCall,
	isEmptyAbortedAssistantMessage,
	noteWrittenCalls,
	sumRunUsage,
	terminalFailureFromAssistantMessage,
	toolCallLabel,
	toolNamesFromAgentState,
	toolResultSummary,
} from "../chat-loop-messages.js";
import {
	assessDraftLoop,
	assessRepetition,
	assessToolCallFlood,
	repetitionAbortReason,
	shouldAssessRepetition,
	thinkingOverrunReason,
	toolCallFloodAbortReason,
} from "../repetition-detector.js";
import { assessToolProseLoop, runtimeNarratesToolCalls, shouldAssessToolProse } from "../tool-prose-loop.js";
import { stalledRequestEnd } from "../turn-recovery.js";
import type { AgentRuntime, ChatLoopTarget } from "../turn-state.js";
import { createStreamAdmission } from "./admission.js";
import { createCallTelemetry } from "./calls.js";
import { createContinuation } from "./continuation.js";
import { TurnAdmissionError } from "./errors.js";
import type { AgentBuildScope, TurnRuntimeScope } from "./scope.js";
import { createTranscriptStream } from "./stream.js";
import { createToolGates } from "./tool-gates.js";
import { createStallWatchdog } from "./watchdog.js";

function isCollectedBatchResult(toolName: string, result: unknown): boolean {
	const details = (result as { details?: unknown } | undefined)?.details as
		| { mode?: unknown; batchId?: unknown; complete?: unknown; collected?: unknown }
		| undefined;
	return (
		effectiveToolCall(toolName, undefined, details).toolName === ToolNames.Monitor &&
		details?.mode === "collect" &&
		typeof details.batchId === "string" &&
		details.batchId.length > 0 &&
		details.complete === true &&
		details.collected === true
	);
}

export function ensureRuntime(rt: TurnRuntimeScope, options?: { silent?: boolean }): AgentRuntime | null {
	const { deps, state, persistence } = rt;

	const target = rt.readTarget();
	if (!target) return null;
	const targetSettings = JSON.stringify(target.target);
	const sameTargetSettings = rt.runtimeTargetSettings === targetSettings;
	// Preflight and the wire budget share the session's effective settings,
	// including overrides that never reach the saved providers snapshot.
	setGlobalDefaultMaxOutputTokens(deps.getSettings().chat.maxOutputTokens);
	if (!deps.knownTargets().has(target.target.id)) {
		throw new TurnAdmissionError(
			`[PanCode] orchestrator target=${target.target.id} unknown. Run \`pancode targets\` to see configured targets.`,
			"target-unknown",
		);
	}
	const requestedThinkingLevel = target.runtimeResolution.requestedThinkingLevel;
	persistence.appendThinkingLevelChangeEntry(
		requestedThinkingLevel,
		target.runtimeResolution.modelRuntime.thinking.effort ?? target.runtimeResolution.effectiveThinkingLevel,
		target.runtimeResolution.effectiveThinkingLevel,
	);
	if (
		state.runtime &&
		state.runtime.targetId === target.target.id &&
		state.runtime.runtimeId === target.runtime.id &&
		sameTargetSettings &&
		state.runtime.wireModelId === target.wireModelId
	) {
		// Same target+runtime+model. Settings may still have moved
		// thinkingLevel since the last call (the user invoked /thinking
		// or Shift+Tab); reconcile the clamped level so the next prompt
		// dispatches under the current intent without forcing a rebuild.
		rt.ensureReasoningProbe(target);
		const runtimeResolution = refineRuntimeTargetWithModelHints(
			target.runtimeResolution,
			state.runtime.agent.state.model,
			deps.providers.knowledgeBase,
		);
		// The wire adapter reads the existing model, including route controls
		// that fresh metadata may have changed or removed for this same alias.
		applyModelCapabilityPatch(state.runtime.agent.state.model, runtimeResolution.capabilities);
		const desiredLevel = runtimeResolution.effectiveThinkingLevel;
		if (state.runtime.agent.state.thinkingLevel !== desiredLevel) {
			state.runtime.agent.state.thinkingLevel = desiredLevel;
		}
		state.runtime.runtimeResolution = runtimeResolution;
		if (!options?.silent) rt.emitThinkingClampNotice(runtimeResolution);
		return state.runtime;
	}

	// Same target+runtime, new wireModelId: hot-swap the model in place on
	// the live agent. Mirrors the pi-coding-agent setModel pattern (mutate
	// `agent.state.model`, re-clamp thinking level, persist) so the runtime
	// keeps its conversation, subscribers, and pending tool calls.
	// Server-side residency for the new model is reconciled by the engine
	// adapters at the top of the next stream (engine/apis/residency.ts):
	// co-resident when capacity allows, swapping only when a slot must be
	// freed, never evicting protected models.
	if (
		state.runtime &&
		state.runtime.targetId === target.target.id &&
		state.runtime.runtimeId === target.runtime.id &&
		sameTargetSettings &&
		state.runtime.wireModelId !== target.wireModelId
	) {
		const nextModel = rt.synthesizeModel(target);
		state.runtime.agent.state.model = nextModel;
		state.runtime.wireModelId = target.wireModelId;
		const effectiveThinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
		state.runtime.agent.state.thinkingLevel = effectiveThinkingLevel;
		state.runtime.runtimeResolution = target.runtimeResolution;
		if (!options?.silent) rt.emitThinkingClampNotice(target.runtimeResolution);
		persistence.appendModelChangeEntry(target);
		rt.ensureReasoningProbe(target);
		return state.runtime;
	}

	const model = rt.synthesizeModel(target);
	const initialThinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
	const tools: ReturnType<typeof resolveAgentTools> = [];
	// Seed the system prompt with the fallback identity text. The first
	// submit replaces it with the compiled session prompt; the fallback
	// only shows up when the prompts contract is absent (tests, degraded
	// boot).
	const hadPriorRuntime = state.runtime !== null;
	const priorMessages = state.runtime ? [...state.runtime.agent.state.messages] : [...state.replayedContextMessages];
	// Drop any in-flight stream on the prior agent before discarding it.
	if (state.runtime) {
		state.runtime.agent.abort();
		rt.cleanupSessionResources(state.runtime.agent.sessionId);
	}
	return buildAgentRuntime(rt, {
		target,
		model,
		initialThinkingLevel,
		tools,
		priorMessages,
		targetSettings,
		hadPriorRuntime,
		options,
	});
}

/** What ensureRuntime settled before it builds a new agent for the selected route. */
interface AgentBuildInputs {
	readonly target: ChatLoopTarget;
	readonly model: EngineModel;
	readonly initialThinkingLevel: ChatLoopTarget["runtimeResolution"]["effectiveThinkingLevel"];
	readonly tools: ReturnType<typeof resolveAgentTools>;
	readonly priorMessages: AgentMessage[];
	readonly targetSettings: string;
	readonly hadPriorRuntime: boolean;
	readonly options: { silent?: boolean } | undefined;
}

function buildAgentRuntime(rt: TurnRuntimeScope, inputs: AgentBuildInputs): AgentRuntime | null {
	const { deps, state, context, persistence, middleware, middlewareToolChoice } = rt;
	const { target, model, initialThinkingLevel, tools, priorMessages, targetSettings, hadPriorRuntime, options } = inputs;

	const gatewaySessionId = target.runtime.id === "litellm" ? deps.sessionId?.() : undefined;
	const scope: AgentBuildScope = {
		rt,
		modelCall: undefined,
		journalLease: undefined,
		settledAttempts: [],
		attemptRequest: undefined,
		guardStopCause: null,
		runTurnId: null,
		apiCallStartedAt: null,
		apiCallFirstDeltaAt: null,
		cutStalledRequest: null,
		requestSerial: 0,
		retiredThrough: 0,
		outputHeld: false,
		preInvocationStage: "transform",
		lastActivityAt: 0,
		toolsInFlight: 0,
		stallSuspendDepth: 0,
		stallTimer: null,
		callTracking: null,
		admittedCursor: null,
		pinnedInputTokens: null,
		placeholderKeySent: false,
		unsettledSpendUsd: 0,
		admittedMessages: [],
		admittedSystemPrompt: "",
		getCurrentAgentSignal: () => undefined,
		requiredToolReminder: null,
		turnEndFiredFor: null,
		pendingTerminalToolResult: null,
		get requestStructure() {
			return requestStructure;
		},
		get currentRun() {
			return currentRun;
		},
		get localRuntime() {
			return localRuntime;
		},
	};
	const requestStructure = createRequestStructures();
	const calls = createCallTelemetry(scope);
	const { stampCallFailure, settleModelCall, abandonModelCall, openModelCall } = calls;
	const watchdog = createStallWatchdog(scope);
	const { clearStallTimer, armStallTimer, callWait, noteFirstOutput, firstOutputMs } = watchdog;
	const toolGates = createToolGates(scope);
	rt.clearCurrentWatchdog();
	let runIdentity = deps.turnIdentity?.();
	const currentRun = (): boolean => runIdentity === deps.turnIdentity?.();
	const streamAdmission = createStreamAdmission(scope, watchdog);
	// Everything below reads the route when it is used: a hot swap or a moved request changes it under this agent.
	const handle = deps.createAgent({
		// Row 384 backstop: a provider that accepts the id and serves another model is refused at its first response.
		refuseServedModelMismatch: () => modelRouteGuarded(localRuntime.runtimeResolution.runtime),
		transcriptStreamFn: createTranscriptStream(scope, calls, watchdog),
		initialState: {
			systemPrompt: fallbackIdentityPrompt(),
			model,
			thinkingLevel: initialThinkingLevel,
			tools,
			messages: priorMessages,
		},
		maxRetryDelayMs: deps.retrySettings().maxDelayMs,
		// Everything PanCode hands over at a slot lands before one model call, as
		// separate user messages; Pi's default would spend one call per message.
		steeringMode: "all",
		followUpMode: "all",
		...(gatewaySessionId ? { sessionId: gatewaySessionId } : {}),
		beforeToolBatch: toolGates.beforeToolBatch,
		beforeToolCall: toolGates.beforeToolCall,
		afterToolCall: toolGates.afterToolCall,
		beforeStreamRequest: streamAdmission.beforeStreamRequest,
		onStreamInvocation: streamAdmission.onStreamInvocation,
		authResolvedByHost: true,
		getApiKey: streamAdmission.getApiKey,
	});
	scope.getCurrentAgentSignal = () => handle.agent.signal;
	// The stream Pi's loop reads for each request of a run. Only a request under the run's own signal can be cut: a
	// prewarm sends through the same function without it (MD11).
	const runStream = handle.agent.streamFunction;
	handle.agent.streamFunction = async (requestModel, requestContext, requestOptions) => {
		const stream = await runStream(requestModel, requestContext, requestOptions);
		const runSignal = handle.agent.signal;
		if (runSignal !== undefined && requestOptions?.signal === runSignal)
			scope.cutStalledRequest = (reason) => stream.push(stalledRequestEnd(requestModel, reason));
		return stream;
	};

	// Build the runtime object before subscribing so the callback closes
	// over the same heap object the hot-swap path mutates. Reading
	// `localRuntime.targetId` / `localRuntime.wireModelId` at event time
	// instead of the captured `target` guarantees per-turn observability
	// rows are tagged with whatever model is active right now, not the
	// model this agent was originally built with.
	const localRuntime: AgentRuntime = {
		agent: handle.agent,
		targetId: target.target.id,
		runtimeId: target.runtime.id,
		wireModelId: target.wireModelId,
		runtimeResolution: target.runtimeResolution,
	};
	if (!options?.silent) rt.emitThinkingClampNotice(target.runtimeResolution);

	// The stall watchdog measures idle from here.
	scope.lastActivityAt = performance.now();
	rt.clearCurrentWatchdog = clearStallTimer;
	rt.callWait = callWait;

	const continuation = createContinuation(scope);
	handle.agent.prepareNextTurnWithContext = continuation.prepareNextTurnWithContext;
	handle.agent.finishTurn = continuation.finishTurn;

	// First call of the run is the one whose verdict says whether the
	// backend reused the session prefix; later calls in a tool loop are
	// trivially warm.
	let runFirstCallVerdict: BackendCacheVerdict | null = null;
	// Per streamed assistant message: how far each block was last checked for repetition. The prose filter
	// hands every delta a fresh partial object, so the counters reset on the message lifecycle, not identity.
	const repetitionCheck = { text: 0, thinking: 0 };
	const onAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "agent_start") {
			runIdentity = deps.turnIdentity?.();
			scope.runTurnId = state.activeUserTurnId;
			// The last run's request says nothing about this one until this one is sent.
			state.modelRequest = null;
		}
		if (event.type === "agent_end") await abandonModelCall();
		if (!currentRun()) {
			if (event.type === "message_end" && event.message.role === "assistant") await settleModelCall(event.message);
			clearStallTimer();
			return;
		}
		// The run's own events, before any reader of this one: an attempt is one run (agent_start to agent_end).
		if (event.type === "agent_start") state.runEvidence.beginAttempt();
		if (event.type === "message_end") state.runEvidence.record(event.message);
		if (event.type === "turn_start") {
			// The last request's facts say nothing about this turn's until its own request goes out.
			state.modelRequest = null;
			await abandonModelCall();
			scope.settledAttempts = [];
			scope.attemptRequest = undefined;
			await openModelCall();
		}
		// Every span below is measured on the monotonic frame, so an NTP
		// correction mid-turn cannot corrupt a tool duration or a TTFT.
		const eventClock = performance.now();
		scope.lastActivityAt = eventClock;
		let enrichedEvent = event;
		if (event.type === "message_end" && event.message.role === "assistant") {
			scope.requiredToolReminder = middlewareToolChoice.completeRound(event.message);
			const cutOff = outputLimitCutOffToolCallIds(event.message);
			for (const id of cutOff) rt.cutOffToolCalls.add(id);
			// One line states the limit where it applies, instead of one failed call per call (bt-39 a).
			if (cutOff.length > 0)
				deps.emitNotice(
					`[PanCode] the response hit the output token limit with ${cutOff.length} tool call${cutOff.length === 1 ? "" : "s"} in it; none ran, since their arguments may be cut off, and the model is asked to re-issue them.`,
					"warning",
				);
		}
		if (event.type === "tool_execution_start") {
			scope.toolsInFlight += 1;
			middlewareToolChoice.toolStarted(event.toolName, event.args);
			deps.toolStartTimes.set(event.toolCallId, eventClock);
			state.turnToolCalls += 1;
			// Turn-end detectors (#184 skill wait) reason about the capability
			// that ran, which for the coordinator is usually behind gateway op=call.
			const effective = effectiveToolCall(event.toolName, event.args);
			state.turnToolNames.push(effective.toolName);
			if (effective.toolName !== ToolNames.Finish) state.turnCalledWork = true;
			rt.startedCallLabels.set(event.toolCallId, toolCallLabel(effective.toolName, effective.args));
		} else if (event.type === "tool_execution_end") {
			scope.toolsInFlight = Math.max(0, scope.toolsInFlight - 1);
			const startedAt = deps.toolStartTimes.get(event.toolCallId);
			deps.toolStartTimes.delete(event.toolCallId);
			// Carry the registry's verdict alongside the engine's result. The
			// panel classifies settlement from `outcome`; without it the only
			// available signal is result text, and grepping that text for
			// "blocked"/"cancelled" labels every failing `node --test` run
			// (which prints `cancelled 0`) a permission block.
			const admission = rt.toolOutcomes.get(event.toolCallId);
			rt.toolOutcomes.delete(event.toolCallId);
			const notRun = rt.cutOffToolCalls.delete(event.toolCallId);
			const protocolRetry = rt.protocolRetryCalls.delete(event.toolCallId);
			const callLabel = rt.startedCallLabels.get(event.toolCallId);
			rt.startedCallLabels.delete(event.toolCallId);
			if (callLabel !== undefined && !notRun && !event.isError) state.turnCallsDone.push(callLabel);
			if (
				(!event.isError && isCollectedBatchResult(event.toolName, event.result)) ||
				gatewayChainReceipts(event.toolName, event.result).some(
					(step) => step.admission.outcome === "ok" && isCollectedBatchResult(step.capability, step.result),
				)
			)
				state.turnCollectedDetachedBatch = true;
			// The registry's own span is the one that means "how long the tool
			// took": the engine's start-to-end frame also covers the operator,
			// because a call awaiting a permission decision is parked between
			// those two events. Approving `wc -l src/*.ts | sort -n` after 25
			// seconds of reading rendered it as a 31-second command.
			const engineSpan = startedAt === undefined ? undefined : Math.round(Math.max(0, eventClock - startedAt));
			const durationMs = admission?.durationMs ?? engineSpan;
			enrichedEvent = {
				...event,
				...(durationMs !== undefined ? { durationMs } : {}),
				resultSummary: toolResultSummary(event.result),
				...(notRun ? { notRun: "output_limit" } : {}),
				...(protocolRetry ? { protocolRetry: true } : {}),
				...(admission === undefined
					? {}
					: {
							outcome: admission.outcome,
							// The registry's per-call classification and admission
							// decision. Headless receipts count safety decisions and
							// tell a successful write from any other success with
							// these, the same facts a worker's receipt is built from.
							...(admission.actionClass === undefined ? {} : { actionClass: admission.actionClass }),
							...(admission.decision === undefined ? {} : { decision: admission.decision }),
							...(admission.deniedPark === true ? { deniedPark: true } : {}),
							...(admission.redundantRepeat === true ? { redundantRepeat: true } : {}),
							...(admission.ruleId === undefined ? {} : { ruleId: admission.ruleId }),
							...(admission.reasonCode === undefined ? {} : { reasonCode: admission.reasonCode }),
							...(admission.policySource === undefined ? {} : { policySource: admission.policySource }),
							...(admission.autoApproved === undefined ? {} : { autoApproved: admission.autoApproved }),
							...(admission.reason === undefined ? {} : { blockReason: admission.reason }),
							...(admission.denial === undefined ? {} : { denial: admission.denial }),
							// A verify call naming a check that does not exist ran nothing; a headless receipt must not seal it as a failed check.
							...(admission.unresolved === true ? { unresolved: true } : {}),
						}),
			} as typeof event;
		} else if (event.type === "agent_end") {
			// The engine's failure path (an abort or a thrown provider error)
			// replaces the run's message window with one synthetic zero-usage
			// failure message, which zeroed token usage, tool counts, and cache
			// records for every aborted turn. Rebuild the real window from the
			// run evidence log, which holds all of this run's messages plus that
			// failure message.
			const runMessages = state.runEvidence.attempt();
			if (runMessages.length > event.messages.length) {
				enrichedEvent = { ...event, messages: runMessages } as typeof event;
			}
		} else if (event.type === "message_end" && state.synthesisToolLock) {
			// Synthesis-locked turn: a model that ignores tool_choice none emits
			// its chat template's tool-call syntax as plain text. Sanitize the
			// message in place (pi stores this same object in agent state, so
			// the emitted event, ledger persistence below, and later provider
			// rounds all see the sanitized text) and mark the event so the
			// panel replaces its streamed markup tail instead of appending.
			if (sanitizeLockedSynthesisMessage(event.message)) {
				enrichedEvent = { ...event, lockedSynthesisSanitized: true } as typeof event;
			}
		}
		// Same object again, so the ledger row below and every reader of the settled run see the stamp.
		if (event.type === "message_end" && event.message.role === "assistant") {
			noteWrittenCalls(event.message, (tool) => {
				const attached = toolNamesFromAgentState(localRuntime.agent.state.tools);
				if (attached.includes(tool)) return true;
				return attached.includes("gateway") && (deps.gatewayCapabilityNames?.().includes(tool) ?? false);
			});
			// CLI-P49: the turn has replied exactly when the headless answer has a segment, read by the same typed
			// predicate after the written-calls stamp: no narration beside a work call, failed message or dead markup.
			if (replySegment(event.message) !== null) state.turnReplied = true;
		}
		// Every user message starts the turn whose replies are the answer, as the headless reader counts it (CLI-P43), so
		// a continuation's prompt clears the reply the bare-finish check reads too.
		if (event.type === "message_end" && event.message.role === "user") state.turnReplied = false;
		// The run's start and end name the operator turn its calls journal under, so the transcript receipt reads
		// that turn's spend from the read model (#434 §11.3).
		if ((enrichedEvent.type === "agent_start" || enrichedEvent.type === "agent_end") && state.activeUserTurnId)
			enrichedEvent = { ...enrichedEvent, turnId: state.activeUserTurnId } as unknown as typeof enrichedEvent;
		let publicEvent = enrichedEvent;
		let journalAccounted = false;
		if (enrichedEvent.type === "message_end" && enrichedEvent.message?.role === "assistant") {
			const message = enrichedEvent.message;
			const usage = (message.usage ?? {}) as unknown as Record<string, unknown>;

			const observed = normalizeTokenUsage(usage).observed;
			const responseId = (message as { responseId?: unknown }).responseId;
			const responseObserved = observed || (typeof responseId === "string" && responseId.length > 0);
			const terminal = terminalFailureFromAssistantMessage(message);
			if (terminal) {
				stampCallFailure(message, terminal, responseObserved);
			} else {
				Object.assign(message, { callInvoked: scope.apiCallStartedAt !== null || responseObserved });
			}
			const pricedBy = !observed
				? "none"
				: (usage.pancodeExternal as { cost?: string } | undefined)?.cost === "provider-reported"
					? "provider"
					: localRuntime.runtimeResolution.pricedBy;
			const freeRule = pricedBy === "free" ? localRuntime.runtimeResolution.freeRule : undefined;
			Object.assign(message, {
				callAccounting: {
					usageObserved: observed,
					pricedBy,
					...(freeRule !== undefined ? { freeRule } : {}),
					targetId: localRuntime.targetId,
				},
			});
			const gatewayRouting = gatewayRoutingObservationFromRecord(
				enrichedEvent.message as unknown as Record<string, unknown>,
			);
			if (
				gatewayRouting !== null &&
				((gatewayRouting.attemptedFallbacks ?? 0) > 0 || (gatewayRouting.attemptedRetries ?? 0) > 0)
			) {
				deps.emitNotice(`[PanCode] ${gatewayRoutingObservationLabel(gatewayRouting)}`, "info", HOST_STATUS_NOTICE_KEY);
			}
			// The estimate goes to the call's settlement, where the read model folds it; it never rides on the message,
			// so no reader sums it beside the provider's usage (#423, #430, #434).
			journalAccounted = await settleModelCall(
				enrichedEvent.message,
				estimatedUsageForInterruptedTurn(enrichedEvent.message, context.promptSideTokens()),
			);
			// A reply PanCode wrote into the prompt, such as the loop guard's recovery pair, settles the call opened at
			// turn_start as never sent, as its ledger row counts it; the model's own reply gets a call of its own (#434).
			if (isHostAuthored(message)) await openModelCall();
		}

		if (
			publicEvent?.type === "message_end" &&
			publicEvent.message.role === "assistant" &&
			scope.apiCallStartedAt !== null
		) {
			publicEvent = {
				...publicEvent,
				modelTimeMs: Math.round(Math.max(0, eventClock - scope.apiCallStartedAt)),
				ttftMs: firstOutputMs(),
			} as typeof publicEvent;
		}
		if (publicEvent?.type === "message_end" && publicEvent.message.role === "assistant") scope.cutStalledRequest = null;
		if (publicEvent?.type === "agent_start") {
			scope.turnEndFiredFor = null;
			scope.cutStalledRequest = null;
			state.continuation.clearInRun();
			scope.apiCallStartedAt = null;
			scope.apiCallFirstDeltaAt = null;
			scope.preInvocationStage = "transform";
			scope.placeholderKeySent = false;
			runFirstCallVerdict = null;
			scope.pendingTerminalToolResult = null;
			clearStallTimer();
			scope.toolsInFlight = 0;
			scope.stallSuspendDepth = 0;
			state.streamStallReason = null;
			state.streamStallStage = null;
			const stallMs = deps.retrySettings().streamStallMs;
			if (stallMs > 0) armStallTimer(stallMs);
		}
		// The engine runs the whole tool batch to settlement before it emits
		// `turn_end`, so nothing from this turn can still be executing here.
		// A call whose `tool_execution_end` was never emitted (a crashed
		// mediator, a dropped frame) therefore stops suspending the watchdog
		// at the turn that issued it instead of for the rest of the run.
		if (publicEvent?.type === "turn_end") scope.toolsInFlight = 0;
		if (publicEvent?.type === "message_update") {
			const hasDelta = hasAssistantGenerationDelta(publicEvent.assistantMessageEvent);
			if (hasDelta && scope.apiCallFirstDeltaAt === null) noteFirstOutput(eventClock);
		}
		if (enrichedEvent.type === "agent_end") {
			context.noteRunCacheSummary(enrichedEvent.messages, runFirstCallVerdict);
		}
		if (enrichedEvent.type === "message_end" && enrichedEvent.message.role === "assistant") {
			const completed = sumRunUsage([enrichedEvent.message]);
			// A call no journal holds is counted against the ceiling for the rest of its run only (#434).
			const priced = factKnownValue(completed.cost.usd);
			if ((!deps.telemetry || !journalAccounted) && completed.hadUsage && Number.isFinite(priced) && priced > 0) {
				scope.unsettledSpendUsd += priced;
			}
		}
		if (enrichedEvent.type === "agent_end") scope.unsettledSpendUsd = 0;
		// Suppress the hollow transcript event while its closing turn keeps the call's accounting (#430).
		if (
			state.activeInterruptReason !== null &&
			enrichedEvent.type === "message_end" &&
			isEmptyAbortedAssistantMessage(enrichedEvent.message)
		) {
			persistence.appendAssistantTurn(
				enrichedEvent.message,
				scope.apiCallStartedAt === null
					? null
					: {
							ttftMs: firstOutputMs(),
							apiMs: Math.round(Math.max(0, eventClock - scope.apiCallStartedAt)),
						},
			);
			return;
		}
		if (publicEvent) deps.emit(publicEvent);
		if (enrichedEvent.type === "message_start") {
			repetitionCheck.text = 0;
			repetitionCheck.thinking = 0;
		}
		if (publicEvent?.type === "message_update") {
			const assistantEvent = publicEvent.assistantMessageEvent as {
				type: string;
				contentIndex?: number;
				delta?: string;
				partial?: AgentMessage;
			};
			if (
				(assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") &&
				state.repetitionAbortReason === null &&
				state.activeInterruptReason === null
			) {
				const thinking = assistantEvent.type === "thinking_delta";
				const streamed = thinking ? extractThinking(assistantEvent.partial) : extractText(assistantEvent.partial);
				// A replacement-style diffusion frame can shorten the text; measure growth from what it now holds.
				if (thinking) repetitionCheck.thinking = Math.min(repetitionCheck.thinking, streamed.length);
				else repetitionCheck.text = Math.min(repetitionCheck.text, streamed.length);
				if (shouldAssessRepetition(streamed.length, thinking ? repetitionCheck.thinking : repetitionCheck.text)) {
					if (thinking) repetitionCheck.thinking = streamed.length;
					else repetitionCheck.text = streamed.length;
					const repetition = assessRepetition(streamed);
					const drafting = thinking && repetition.kind === "ok" ? assessDraftLoop(streamed) : repetition;
					// Reasoning only: no text or call yet, on a route whose server enforces no thinking budget (bt-25).
					const blocks: ReadonlyArray<{ type?: unknown }> = Array.isArray(assistantEvent.partial?.content)
						? assistantEvent.partial.content
						: [];
					const overrun =
						thinking &&
						localRuntime.runtimeResolution.modelRuntime.thinking.budgetEnforcement !== "enforced" &&
						blocks.every((block) => block.type === "thinking")
							? thinkingOverrunReason(streamed.length, localRuntime.agent.state.model.maxTokens)
							: null;
					const stop = drafting.kind === "repeating" ? repetitionAbortReason(drafting) : overrun;
					if (stop !== null) {
						state.repetitionAbortReason = stop;
						deps.emitNotice(state.repetitionAbortReason, "warning");
						localRuntime.agent.abort();
					}
				}
			}
			// Some adapters end every call block only when the stream ends, so the calls before a starting one are judged
			// at its start: their arguments are complete by then, and the stop lands while the flood is still streaming.
			// A call still marked as streaming its arguments (copilot-sdk's `partialJson`) is skipped until they are final.
			if (
				(assistantEvent.type === "toolcall_start" || assistantEvent.type === "toolcall_end") &&
				state.repetitionAbortReason === null &&
				state.activeInterruptReason === null
			) {
				const completeBlocks = (assistantEvent.contentIndex ?? 0) + (assistantEvent.type === "toolcall_end" ? 1 : 0);
				const flood = assessToolCallFlood(assistantEvent.partial, completeBlocks);
				if (flood.kind === "flooding") {
					state.repetitionAbortReason = toolCallFloodAbortReason(flood);
					deps.emitNotice(state.repetitionAbortReason, "warning");
					localRuntime.agent.abort();
				}
			}
			if (assistantEvent.type === "text_delta") {
				const partialText = extractText(assistantEvent.partial);
				const frame = readDiffusionFrame(assistantEvent);
				if (frame) {
					deps.emit({
						type: "text_frame",
						contentIndex: assistantEvent.contentIndex ?? 0,
						text: frame.text,
						progress: frame.progress,
					});
				} else {
					deps.emit({
						type: "text_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialText,
					});
				}
				const localToolRuntime = runtimeNarratesToolCalls(localRuntime.runtimeResolution.runtimeTier);
				if (
					localToolRuntime &&
					state.toolProseAbortReason === null &&
					shouldAssessToolProse(partialText.length, state.toolProseAssessedChars)
				) {
					state.toolProseAssessedChars = partialText.length;
					const activeToolNames = toolNamesFromAgentState(localRuntime.agent.state.tools);
					const assessment = assessToolProseLoop({
						text: partialText,
						activeToolNames,
						...(activeToolNames.includes("gateway") && deps.gatewayCapabilityNames
							? { gatewayToolNames: deps.gatewayCapabilityNames() }
							: {}),
						hasStructuredToolCall: hasStructuredToolCall(assistantEvent.partial),
					});
					if (assessment.kind === "loop") {
						state.toolProseAbortReason = `[PanCode] aborted local model turn: ${assessment.reason}.`;
						localRuntime.agent.abort();
						deps.emitNotice(state.toolProseAbortReason);
					}
				}
			}
			if (assistantEvent.type === "thinking_delta") {
				deps.emit({
					type: "thinking_delta",
					contentIndex: assistantEvent.contentIndex ?? 0,
					delta: assistantEvent.delta ?? "",
					partialThinking: extractThinking(assistantEvent.partial),
				});
			}
		}
		if (enrichedEvent.type === "message_end") {
			persistence.appendQueuedUserTurn(enrichedEvent.message);
			const isAssistant = enrichedEvent.message?.role === "assistant";
			if (isAssistant) scope.pendingTerminalToolResult = null;
			const timing: AssistantCallTiming | null =
				isAssistant && scope.apiCallStartedAt !== null
					? {
							ttftMs: firstOutputMs(),
							apiMs: Math.round(Math.max(0, eventClock - scope.apiCallStartedAt)),
						}
					: null;
			const correlationId = event.type === "message_end" ? handle.requestCorrelationId(event.message) : undefined;
			const persistedId = persistence.appendAssistantTurn(enrichedEvent.message, timing, correlationId);
			await deps.continuity?.response(persistedId, correlationId);
			if (!currentRun()) return;
			if (isAssistant) {
				scope.apiCallStartedAt = null;
				scope.preInvocationStage = "transform";
				if (state.currentAskUserPolicy) {
					const sessionId = deps.sessionId?.();
					const turnId = state.activeUserTurnId ?? undefined;
					await closeAskUserInterviewOnAssistantTurn(state.currentAskUserPolicy, enrichedEvent.message, {
						...(sessionId ? { sessionId } : {}),
						...(turnId ? { turnId } : {}),
					});
				}
			}
			const usage = (enrichedEvent.message as { usage?: Usage }).usage;
			if (isAssistant && usage && typeof usage === "object" && runFirstCallVerdict === null) {
				const input = typeof usage.input === "number" ? usage.input : 0;
				const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
				const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
				const backendTimings = (enrichedEvent.message as { backendTimings?: BackendCompletionTimings }).backendTimings;
				runFirstCallVerdict = backendCacheVerdict(input, cacheRead, cacheWrite, backendTimings, usage.cacheReadField);
			}
			// The background memory budget sizes a local step's deadline from the
			// speed this endpoint measured on the operator's own turns.
			if (isAssistant) {
				recordEndpointThroughput(
					canonicalEndpointKey(localRuntime.runtimeResolution.target),
					(enrichedEvent.message as { backendTimings?: BackendCompletionTimings }).backendTimings,
				);
			}
			if (usage) {
				const origin = enrichedEvent.message as { callId?: unknown; attemptId?: unknown };
				context.reconcileUsage(
					usage,
					typeof origin.callId === "string" && typeof origin.attemptId === "string"
						? { callId: origin.callId, attemptId: origin.attemptId }
						: undefined,
				);
			}
		}
		if (enrichedEvent.type === "tool_execution_start") {
			persistence.appendToolCallTurn(enrichedEvent);
		}
		if (enrichedEvent.type === "tool_execution_end") {
			persistence.appendToolResultTurn(enrichedEvent);
			// The typed completion declaration (fleet design 4.3): read from the settled result, never from reply text.
			const completion = enrichedEvent.isError
				? null
				: completionOfToolResult(enrichedEvent.toolName, enrichedEvent.result);
			if (completion !== null) state.turnCompletion = completion;
			scope.pendingTerminalToolResult =
				(enrichedEvent.result as { terminate?: boolean } | undefined)?.terminate === true
					? { toolCallId: enrichedEvent.toolCallId, toolName: enrichedEvent.toolName }
					: null;
		}
		if (enrichedEvent.type === "agent_end") {
			await deps.continuity?.pause();
			clearStallTimer();
			if (!currentRun()) return;
			const terminal = scope.pendingTerminalToolResult;
			scope.pendingTerminalToolResult = null;
			if (terminal) {
				persistence.appendTerminalToolAssistantTurn(terminal);
			}
			context.flushReconciledSnapshot();
			const finalAssistant = [...enrichedEvent.messages].reverse().find((message) => message.role === "assistant");
			if (terminal !== null || finalAssistant === undefined || finalAssistant !== scope.turnEndFiredFor) {
				await middleware.fireTurnEnd(localRuntime, enrichedEvent.messages, terminal ?? undefined);
			}
			scope.turnEndFiredFor = null;
		}
	};
	handle.agent.subscribe((event) => {
		const settled = onAgentEvent(event);
		// Pi awaits this promise and fails the prompt on a rejection, which the
		// chat loop reports. An emitter that drops it must not turn the same
		// fault into an unhandled rejection that kills a headless run before
		// its receipt and events are written (#428).
		settled.catch(() => {});
		return settled;
	});

	state.runtime = localRuntime;
	rt.runtimeTargetSettings = targetSettings;
	// Append a modelChange marker only when this rebuild replaces a prior
	// runtime, which is the cross-target swap case (mid-session change of
	// target or runtime id). On the initial build, the session header's
	// `meta.model` (written by `session.create()` in submit()) captures
	// the first model and a marker would be redundant.
	if (hadPriorRuntime) persistence.appendModelChangeEntry(target);
	rt.ensureReasoningProbe(target);
	return state.runtime;
}
