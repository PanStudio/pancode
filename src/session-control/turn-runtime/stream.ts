// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * An agent build's transcript stream: each provider request of a turn, from tool-round control and call tracking
 * through the attempt's receipt and send stages to the stream the engine reads, with its settlement on the way back.
 */

import { trackCallFetch } from "../../core/call-failure.js";
import { applyModelAdmission, type ModelAdmissionEvent } from "../../core/model-admission.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { telemetryCaptures } from "../../core/telemetry/producer.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
import type { MiddlewareToolChoiceControl } from "../../domains/middleware/index.js";
import { resolveEffectivePricing } from "../../domains/providers/catalog.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../../domains/telemetry/call-facts.js";
import { enginePinnedPrefix, providerFallbackOf } from "../../engine/agent.js";
import { engineMainStreamSimple } from "../../engine/api-registry.js";
import { anchorContextAtInputTokens } from "../../engine/apis/output-budget.js";
import { withLockedSynthesisDirective } from "../../engine/loop-guard-synthesis.js";
import { MODEL_ADMISSION } from "../../engine/model-admission.js";
import {
	applyToolRounds,
	type ControlledRequest,
	firstToolRoundAttempt,
	streamToolRound,
	type ToolRound,
} from "../../engine/provider-payload.js";
import type { CodexConfiguration } from "../../engine/types.js";
import { terminalFailureFromAssistantMessage } from "../chat-loop-messages.js";
import { prefixBlocksOf } from "../prefix-blocks.js";
import type { ModelRequestFacts } from "../status-types.js";
import type { TurnRuntimeDeps } from "../turn-runtime-types.js";
import { MODEL_SLOTS_SAMPLE_MS, modelRequestSlots } from "../turn-runtime-wait.js";
import type { CallTelemetry } from "./calls.js";
import type { AgentBuildScope } from "./scope.js";
import type { StallWatchdog } from "./watchdog.js";

type MiddlewareChoice = ReturnType<MiddlewareToolChoiceControl["current"]>;

/** An attempt's tool rounds. A locked round has no named tool to require; it is text-only. */
export function attemptToolRounds(synthesisLock: boolean, choice: MiddlewareChoice): (ToolRound | undefined)[] {
	return [
		synthesisLock || choice.kind === "none" ? { kind: "text-only" } : undefined,
		choice.kind === "required" && !synthesisLock ? { kind: "required", toolName: choice.toolName } : undefined,
	];
}

/**
 * `finalize` (SPEC §2.1): the request tail of one invocation, the context it sends. Admission prices it and the send
 * path sends it, so the two cannot disagree (F15). The directive rides the tail, so the prompt prefix never changes. A
 * middleware text lock sent as "none" needs no words and keeps its tail too: a note there would cost the next turn the
 * cached copy of the last tool batch on a block-cached route. Only the "auto" form of that lock carries it.
 */
export function finalizeAttempt(
	request: ControlledRequest,
	synthesisLock: boolean,
	choice: MiddlewareChoice,
): ControlledRequest["context"] {
	return synthesisLock || (choice.kind === "none" && request.options?.toolChoice === "auto")
		? withLockedSynthesisDirective(request.context)
		: request.context;
}

type TranscriptStreamFn = NonNullable<NonNullable<Parameters<TurnRuntimeDeps["createAgent"]>[0]>["transcriptStreamFn"]>;

export function createTranscriptStream(
	scope: AgentBuildScope,
	calls: CallTelemetry,
	watchdog: StallWatchdog,
): TranscriptStreamFn {
	const { deps, state, context, middlewareToolChoice } = scope.rt;
	const { withCachePhysics, carryRelabelledReasons, recordSettledCall } = calls;
	const { clearStallTimer, armStallTimer } = watchdog;

	return (currentModel, currentContext, options) => {
		const middlewareChoice = middlewareToolChoice.current();
		const controlled = applyToolRounds(
			currentModel,
			currentContext,
			options,
			attemptToolRounds(state.synthesisToolLock, middlewareChoice),
			scope.localRuntime.targetId,
		);
		delete scope.localRuntime.lastProviderStatus;
		const tracking = trackCallFetch(controlled.options?.fetch);
		scope.callTracking = tracking;
		tracking.start(currentModel.api, controlled.options?.transport);
		let invokedAttempt = false;
		const pinnedPrefix = enginePinnedPrefix(scope.localRuntime.agent);
		// The payload layer's own decision, read before it acts on it: a compliance-first round is held until done.
		scope.outputHeld = firstToolRoundAttempt(currentModel, controlled, scope.localRuntime.targetId) !== controlled;
		if (scope.outputHeld && scope.stallTimer !== null) {
			const stallMs = deps.retrySettings().streamStallMs;
			clearStallTimer();
			if (stallMs > 0) armStallTimer(stallMs);
		}
		return streamToolRound(
			currentModel,
			controlled,
			(request) => {
				const serial = ++scope.requestSerial;
				const retry = invokedAttempt;
				if (retry && scope.modelCall)
					scope.modelCall =
						scope.modelCall.nextAttempt({ toolChoice: request.options?.toolChoice === "none" ? "none" : "auto" }) ??
						scope.modelCall;
				invokedAttempt = true;
				const attempt = scope.modelCall;
				// The first attempt's send opened at onStreamInvocation; a #426 retry opens its own here.
				attempt?.stage("send", "start");
				deps.onModelRequestSent?.(
					attempt && scope.journalLease
						? {
								callId: attempt.callId,
								attemptId: attempt.attemptId,
								attempt: attempt.attempt,
								context: scope.journalLease.context,
							}
						: null,
				);
				const facts: ModelRequestFacts = {
					sentAt: Date.now(),
					modelId: currentModel.id,
					firstByteAt: null,
					bytesObservable: tracking.observesResponses(),
				};
				if (
					scope.rt.coldAtProbe?.modelId === currentModel.id &&
					scope.rt.coldAtProbe.targetId === scope.localRuntime.targetId
				) {
					facts.probedResidency = scope.rt.coldAtProbe.state;
				}
				state.modelRequest = facts;
				let slotsReadAt = 0;
				state.refreshModelRequest = () => {
					if (state.modelRequest !== facts || facts.firstByteAt !== null || facts.admission) return;
					if (Date.now() - slotsReadAt < MODEL_SLOTS_SAMPLE_MS) return;
					slotsReadAt = Date.now();
					facts.slots = modelRequestSlots(scope.localRuntime.runtimeResolution, deps.providers);
				};
				// #423: fingerprint the control this attempt sends, including a #426 recovery retry.
				context.noteCacheRequestToolChoice?.(JSON.stringify(request.options?.toolChoice ?? "auto"), retry);
				context.noteCacheRequestSystemPrompt?.(retry);
				delete scope.localRuntime.lastProviderStatus;
				const requestOptions = {
					...request.options,
					fetch: tracking.fetch,
					...(pinnedPrefix ? { pancodePinnedPrefix: pinnedPrefix } : {}),
					// A load is this request's own wait, so its report lands on these facts and no other's.
					[MODEL_ADMISSION]: (event: ModelAdmissionEvent) => applyModelAdmission(facts, event, Date.now()),
					onResponse: async (...args: Parameters<NonNullable<NonNullable<typeof request.options>["onResponse"]>>) => {
						// A request the first-token watchdog retired answers no one: its late status and first byte would
						// otherwise land on the retry's classification and facts (MD11).
						if (serial <= scope.retiredThrough) return;
						// Pi can discard HTTP 401 when rendering the body's friendly message (#427).
						scope.localRuntime.lastProviderStatus = args[0].status;
						// Pi retries a retryable status inside one attempt; the first byte is the response that
						// opens the stream. Transports that never report a response leave it unobserved (#434).
						if (args[0].status >= 200 && args[0].status < 300) {
							attempt?.mark("firstByte");
							if (state.modelRequest === facts) facts.firstByteAt ??= Date.now();
							scope.rt.coldAtProbe = null;
						}
						await request.options?.onResponse?.(...args);
					},
				};
				const sent = finalizeAttempt(request, state.synthesisToolLock, middlewareChoice);
				if (attempt) {
					const fallback = providerFallbackOf(request.options);
					const codex = (request.options as { codexConfiguration?: CodexConfiguration } | undefined)?.codexConfiguration;
					scope.attemptRequest = {
						// A portable fallback wrote its record after admission; the request renders through it.
						cursor: fallback !== undefined ? (deps.requestCursor?.() ?? scope.admittedCursor) : scope.admittedCursor,
						receipt: {
							toolChoice: JSON.stringify(request.options?.toolChoice ?? "auto"),
							tail: sent === request.context ? "none" : "synthesis_directive",
							...(fallback !== undefined ? { fallback } : {}),
							...(codex ? { codex: { initialEffort: codex.initialEffort, updates: [...codex.updates] } } : {}),
						},
						model: currentModel,
						context: sent,
						compiled: context.compiledSessionPrompt?.() ?? null,
						coldReasons: [...new Set([...scope.rt.carriedColdReasons, ...(context.takeCallColdReasons?.() ?? [])])],
					};
					scope.rt.carriedColdReasons = [];
					// Research capture: the prefix exactly as this attempt sends it, hashed (#423, #434).
					attempt.withContext(() => {
						if (!telemetryCaptures("prompt.prefix_captured")) return;
						const blocks = prefixBlocksOf(context.compiledSessionPrompt?.() ?? null, sent);
						if (blocks) telemetryHub().emit("prompt.prefix_captured", blocks);
					});
				}
				// This attempt carries the host inserts that render on its session's branch; none needs re-issuing after a later cut.
				deps.hostInserts?.dispatched();
				// The provider stream runs inside the attempt's context, so the engine seam and every observer below it
				// find this call; the seam's marks agree with the ones taken here because each keeps its first (#434).
				// Only the provider-bound copy carries the pin; telemetry and the keepalive replay keep the request as built.
				const pin = scope.pinnedInputTokens;
				const providerContext = pin === null ? sent : anchorContextAtInputTokens(sent, pin);
				const providerOptions = pin === null ? requestOptions : { ...requestOptions, pancodeInputTokens: pin };
				const stream = attempt
					? attempt.withContext(() => engineMainStreamSimple(currentModel, providerContext, providerOptions))
					: engineMainStreamSimple(currentModel, providerContext, providerOptions);
				// send.end is the handoff to Pi's provider, which owns serialization and the socket under
				// transport option B. The journal's TTFT is firstToken minus this mark (#434).
				attempt?.stage("send", "end");
				// #423: a cache keepalive replays exactly this request, without this turn's call tracker or status hook.
				const { fetch: _tracked, onResponse: _status, [MODEL_ADMISSION]: _admission, ...replayed } = requestOptions;
				deps.noteMainRequest?.(
					scope.localRuntime,
					{
						model: currentModel,
						context: sent,
						options: {
							...replayed,
							...(request.options?.fetch ? { fetch: request.options.fetch } : {}),
							...(request.options?.onResponse ? { onResponse: request.options.onResponse } : {}),
						},
					},
					stream,
				);
				return stream;
			},
			scope.localRuntime.targetId,
			(message) => {
				if (!scope.modelCall) return;
				const terminal = terminalFailureFromAssistantMessage(message);
				const reported = normalizeTokenUsage((message.usage ?? {}) as unknown as Record<string, unknown>).observed;
				const failure = terminal
					? tracking.failure(terminal.errorMessage, terminal.stopReason === "aborted", reported)
					: undefined;
				const resolution = scope.localRuntime.runtimeResolution;
				const { rates } = resolveEffectivePricing(resolution.target, resolution.runtime, resolution.wireModelId);
				const settlement = withCachePhysics(
					callSettlementFromMessage({ ...message, ...(failure ? { failure } : {}) }, { ...resolution, rates }),
					message,
					scope.modelCall.attemptId,
				);
				const facts = scope.modelCall.settle(settlement, reportedModelFromMessage(message));
				carryRelabelledReasons(settlement, facts);
				recordSettledCall(facts, scope.journalLease?.context);
			},
		);
	};
}
