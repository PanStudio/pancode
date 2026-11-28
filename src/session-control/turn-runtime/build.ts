// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * Building a turn runtime's agent: admitting the selected route, reusing a settled agent or constructing a new one with
 * its stream function, watchdog, tool gates, continuation and event handler, and installing it on the chat loop state.
 */

import { performance } from "node:perf_hooks";
import { modelRouteGuarded } from "../../core/response-model-id.js";
import { applyModelCapabilityPatch, refineRuntimeTargetWithModelHints } from "../../domains/providers/index.js";
import { setGlobalDefaultMaxOutputTokens } from "../../engine/apis/index.js";
import { createRequestStructures } from "../../engine/request-structure.js";
import type { AgentMessage, EngineModel } from "../../engine/types.js";
import type { resolveAgentTools } from "../../tools/agent-tools.js";
import { fallbackIdentityPrompt } from "../chat-loop-messages.js";
import { stalledRequestEnd } from "../turn-recovery.js";
import type { AgentRuntime, ChatLoopTarget } from "../turn-state.js";
import { createStreamAdmission } from "./admission.js";
import { createCallTelemetry } from "./calls.js";
import { createContinuation } from "./continuation.js";
import { TurnAdmissionError } from "./errors.js";
import { createAgentEventHandler } from "./events.js";
import type { AgentBuildScope, TurnRuntimeScope } from "./scope.js";
import { createTranscriptStream } from "./stream.js";
import { createToolGates } from "./tool-gates.js";
import { createStallWatchdog } from "./watchdog.js";

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
			`[PanCode] orchestrator connection=${target.target.id} unknown. Run \`pancode connections\` to see configured connections.`,
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
	const { deps, state, persistence } = rt;
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
		runIdentity: undefined,
		runFirstCallVerdict: null,
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
	const watchdog = createStallWatchdog(scope);
	const { clearStallTimer, callWait } = watchdog;
	const toolGates = createToolGates(scope);
	rt.clearCurrentWatchdog();
	scope.runIdentity = deps.turnIdentity?.();
	const currentRun = (): boolean => scope.runIdentity === deps.turnIdentity?.();
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

	const onAgentEvent = createAgentEventHandler(scope, calls, watchdog, handle);
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
