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
import { snapshotModelInfo } from "../core/model-tier.js";
import { modelRouteGuarded } from "../core/response-model-id.js";
import { observedToolCallOrigin, withTelemetryContext } from "../core/telemetry/context.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import type { AuthResolution } from "../domains/providers/auth/storage.js";
import { resolveEffectivePricing } from "../domains/providers/catalog.js";
import { acceptsImageInput } from "../domains/providers/image-input.js";
import { permissionHoldBackstopAt } from "../lib/worker-wire/protocol.js";
import { resolveAgentTools, type ToolTelemetry } from "../tools/agent-tools.js";
import { runObservationPool } from "../tools/observation.js";
import type { WorkerDecisionBinding } from "../worker/stdin-demux.js";
import { createEngineAgent, type EngineAgentOptions } from "./agent.js";
import { workerCacheFamilyId } from "./apis/cache-family.js";
import { startClaudeSdkWorkerRun } from "./claude/sdk-runtime.js";
import { disableCopilotConversationResume } from "./copilot/session-fs.js";
import { observeExternalWorkerRun } from "./external-call-telemetry.js";
import { startExternalCliWorkerRun } from "./external-cli/connectors.js";
import { registerPancodeOAuthProviders } from "./oauth.js";
import { supportsNamedToolChoice } from "./provider-payload.js";
import { createRunPhase } from "./run-phase.js";
import { createWorkerCallTelemetry } from "./worker-call-telemetry.js";
import { createWorkerBounds } from "./worker-run/bounds.js";
import { subscribeWorkerEvents } from "./worker-run/events.js";
import { createWorkerEvidence } from "./worker-run/evidence.js";
import { finishWorkerRun, taskMessage } from "./worker-run/finish.js";
import { createWorkerGating } from "./worker-run/gating.js";
import { createWorkerPermissions } from "./worker-run/permissions.js";
import { createWorkerResult } from "./worker-run/result.js";
import { createWorkerRound } from "./worker-run/round.js";
import type { WorkerRunScope } from "./worker-run/scope.js";
import { decodeWorkerSpec, prepareNativeWorker, workerProviderSupportsTools } from "./worker-run/spec.js";
import { createWorkerStreamFn } from "./worker-run/stream.js";
import type { WorkerEventEmit, WorkerRunHandle, WorkerRunInput } from "./worker-run-types.js";

export { workerProviderSupportsTools };

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
		get workerSettings() {
			return workerSettings;
		},
		get workerCanWrite() {
			return workerCanWrite;
		},
		get workerCanPlan() {
			return workerCanPlan;
		},
		get helperToolAvailable() {
			return helperToolAvailable;
		},
		get observeBoundReason() {
			return observeBoundReason;
		},
		get mutationResult() {
			return mutationResult;
		},
		get activeWorkerTools() {
			return activeWorkerTools;
		},
		get model() {
			return model;
		},
		get runEffects() {
			return runEffects;
		},
		get middlewareToolChoice() {
			return middlewareToolChoice;
		},
		get terminalHandoffActive() {
			return terminalHandoffActive;
		},
		get workerResponseFormat() {
			return workerResponseFormat;
		},
		get effectiveThinkingLevel() {
			return effectiveThinkingLevel;
		},
		get onAssistantBatch() {
			return onAssistantBatch;
		},
		get onToolEvent() {
			return onToolEvent;
		},
		get onMessageEnd() {
			return onMessageEnd;
		},
		get contractReminder() {
			return contractReminder;
		},
		get inheritedMessages() {
			return inheritedMessages;
		},
		get contextGuard() {
			return contextGuard;
		},
		get workShare() {
			return workShare;
		},
		get noteShare() {
			return noteShare;
		},
		get enterHandback() {
			return enterHandback;
		},
		get refreshWorkerOAuthKey() {
			return refreshWorkerOAuthKey;
		},
		get tools() {
			return tools;
		},
		get observations() {
			return observations;
		},
		get seedLineage() {
			return seedLineage;
		},
		get loopGuardRegistration() {
			return loopGuardRegistration;
		},
		get workerBudget() {
			return workerBudget;
		},
		get deliveryTools() {
			return deliveryTools;
		},
	};

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
	const {
		workerBudget,
		deliveryTools,
		middlewareToolChoice,
		loopGuardRegistration,
		seedLineage,
		workerCanWrite,
		workerCanPlan,
		readStreakRegistration,
		observations,
		registry,
	} = createWorkerGating(scope);
	const contractCwd = input.cwd ?? process.cwd();

	const { thrashOutcome, runEffects, onToolEvent } = createWorkerEvidence(scope);
	const { terminalHandoffActive, pushHelperTool, beforeToolCall, finishTurn, onAssistantBatch, onMessageEnd } =
		createWorkerResult(scope);

	const { enterHandback, observeBoundReason, startTimers } = createWorkerBounds(scope);
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
	pushHelperTool(tools);
	if (tools.length === 0 && activeWorkerTools.length > 0) {
		process.stderr.write(`[worker] warning: no tools resolved for allowed=[${activeWorkerTools.join(",")}]\n`);
	}
	const {
		workShare,
		noteShare,
		effectiveThinkingLevel,
		inheritedMessages,
		contextGuard,
		workerResponseFormat,
		contractReminder,
		beforeStreamRequest,
		initialState,
	} = createWorkerRound(scope);
	const streamFn = createWorkerStreamFn(scope);
	const options: EngineAgentOptions = {
		// Row 384 backstop: a provider that accepts the id and serves another model is refused at its first response.
		refuseServedModelMismatch: () => modelRouteGuarded(input.runtime),
		beforeStreamRequest,
		beforeToolCall,
		finishTurn,
		// Each round sends through engineStreamSimple, whose guard sees the evicted request.
		delegateGuardsToolArguments: true,
		streamFn,
		initialState,
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
	const { synthesisTimer, wallTimer } = startTimers();
	const unsubscribe = subscribeWorkerEvents(scope);

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
