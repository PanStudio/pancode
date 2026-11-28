// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * An agent build's stream admission: the gate each provider request passes before Pi invokes it (context fit, budget
 * and continuity admission, the session cost ceiling), the moment it is sent, and the credential it is sent with.
 */

import { performance } from "node:perf_hooks";
import { applyModelAdmission } from "../../core/model-admission.js";
import { modelRouteRefusalMessage } from "../../core/response-model-id.js";
import type { BudgetAlertPayload } from "../../core/telemetry/live-events.js";
import { pricesCalls } from "../../core/telemetry/pricing.js";
import { requestFits } from "../../domains/context/budget/request-fit.js";
import { observationTracing, traceObservation } from "../../domains/memory/observation-events.js";
import { targetRequiresAuth } from "../../domains/providers/index.js";
import {
	SessionCostCeilingError,
	sessionCeilingReached,
	suggestedSessionCostCeilingUsd,
} from "../../domains/scheduling/budget.js";
import type { createEngineAgent } from "../../engine/agent.js";
import { setGlobalDefaultMaxOutputTokens } from "../../engine/apis/index.js";
import { estimateInputTokensFromContext } from "../../engine/apis/output-budget.js";
import { resolvedRequestContext } from "../../engine/context.js";
import { applyToolRounds, firstToolRoundAttempt } from "../../engine/provider-payload.js";
import { withSettledHistory } from "../message-list-digest.js";
import { resolveFitOutputReserve, turnAdmissionRemedy } from "../output-reserve.js";
import type { ModelRequestFacts } from "../status-types.js";
import type { AgentBuildScope } from "./scope.js";
import { attemptToolRounds, finalizeAttempt } from "./stream.js";
import type { StallWatchdog } from "./watchdog.js";

const LOCAL_API_KEY_FALLBACK = "pancode-local-target";
type StreamAdmission = NonNullable<NonNullable<Parameters<typeof createEngineAgent>[0]>["beforeStreamRequest"]>;
type AdmissionHold = { waitedOn?: "budget"; inputTokens?: number; anchored?: boolean; outputReserveTokens?: number };

export function createStreamAdmission(scope: AgentBuildScope, watchdog: StallWatchdog) {
	const { deps, state, context, persistence, middlewareToolChoice } = scope.rt;
	const { firstTokenLimitMs, clearStallTimer, armStallTimer } = watchdog;

	// One span covers Pi's whole pre-invocation gate; `waitedOn` names the ceiling that held it, so a
	// budget wait reads as admission and never as a stall (#424, #434).
	const stageAdmission =
		(admit: (request: Parameters<StreamAdmission>[0], hold: AdmissionHold) => ReturnType<StreamAdmission>) =>
		async (request: Parameters<StreamAdmission>[0]): Promise<Awaited<ReturnType<StreamAdmission>>> => {
			const call = scope.modelCall;
			const hold: AdmissionHold = {};
			call?.stage("admission", "start");
			try {
				return await admit(request, hold);
			} finally {
				call?.stage("admission", "end", hold);
			}
		};
	const beforeStreamRequest = stageAdmission(async ({ model, context: request, options: streamOptions }, hold) => {
		setGlobalDefaultMaxOutputTokens(deps.getSettings().chat.maxOutputTokens);
		scope.callTracking = null;
		delete scope.localRuntime.lastProviderStatus;
		if (!scope.currentRun() || state.activeInterruptReason !== null || state.runtime !== scope.localRuntime) {
			return { block: true, reason: "Request ownership changed before invocation." };
		}
		const unavailable = await scope.rt.modelOfferRefusal(
			scope.localRuntime.targetId,
			scope.localRuntime.wireModelId,
			streamOptions?.signal,
		);
		if (unavailable !== null)
			return { block: true, reason: modelRouteRefusalMessage(unavailable), modelRouteRefusal: unavailable };
		const flowViolation =
			deps.admitFlow?.({
				targetId: scope.localRuntime.targetId,
				runtimeId: scope.localRuntime.runtimeId,
				wireModelId: scope.localRuntime.wireModelId,
			}) ?? null;
		if (flowViolation !== null) {
			if (state.lastRunSnapshot) state.lastRunSnapshot.outcomeCode = "information_flow_blocked";
			return { block: true, reason: flowViolation };
		}
		if (state.lastRunSnapshot) delete state.lastRunSnapshot.outcomeCode;
		if (deps.hasQueuedSteering?.() && deps.continuity?.admission().block === false) {
			const handoff = deps.continuity.admission();
			if (!handoff.block && handoff.correlationId)
				return { block: true, reason: "Operator steering arrived during handoff preparation; handoff paused." };
		}
		// One settled stretch (SC-6): nothing from the view to the anchored count edits a message in place, so the
		// anchored count reads the history the view just checked instead of walking every message again.
		const { view, resolved, actual, anchored } = withSettledHistory(() => {
			const view = context.refreshLiveBudget();
			const resolved = resolvedRequestContext(request);
			scope.admittedCursor = deps.requestCursor?.() ?? null;
			// The first invocation as the send path builds it; a #426 retry after a rejection is not re-admitted.
			const middlewareChoice = middlewareToolChoice.current();
			const controlled = applyToolRounds(
				model,
				request,
				streamOptions,
				attemptToolRounds(state.synthesisToolLock, middlewareChoice),
				scope.localRuntime.targetId,
			);
			const actual = finalizeAttempt(
				firstToolRoundAttempt(model, controlled, scope.localRuntime.targetId),
				state.synthesisToolLock,
				middlewareChoice,
			);
			// The view is the one count: after an overflow fold that fit it publishes the A4 count, otherwise the live
			// estimate. Admission sizes the request on it, and the provider-bound copy hands Pi's clamp the same figure
			// on every main request, so Pi never refuses what admission passed (SPEC §0; cf-x6 r2 m3a residual).
			context.takeOverflowInputPin?.();
			// With a measured anchor on this route the anchored count replaces the chars/4 floor, and what finalize
			// added to the request (a synthesis directive) rides on it at chars/4 (bt3 drv-rv5).
			const anchored = context.anchoredInputTokens?.(scope.localRuntime) ?? null;
			return { view, resolved, actual, anchored };
		});
		const counted = estimateInputTokensFromContext(actual);
		const input =
			anchored === null
				? Math.max(counted, view.inputTokens ?? 0)
				: anchored + Math.max(0, counted - estimateInputTokensFromContext(request));
		scope.pinnedInputTokens = input;
		hold.inputTokens = input;
		hold.anchored = anchored !== null;
		const output = resolveFitOutputReserve(scope.localRuntime, input);
		hold.outputReserveTokens = output;
		if (view.effectiveWindow !== null && !requestFits(input, output, view.effectiveWindow))
			return {
				block: true,
				reason: `Context window exceeded: input ${input} + output ${output}, window ${view.effectiveWindow ?? "unknown"}. ${turnAdmissionRemedy(scope.localRuntime, input)}`,
			};
		if (
			deps.scheduling &&
			// A provider that reports its own per-call cost reaches the ceiling even with no rates to project.
			(pricesCalls(scope.localRuntime.runtimeResolution.pricedBy) ||
				scope.localRuntime.runtimeResolution.runtime.reportsCallCost === true)
		) {
			const recordBlock = (block: BudgetAlertPayload): void => {
				hold.waitedOn = "budget";
				persistence.appendBudgetBlock({
					...block,
					raiseToUsd: suggestedSessionCostCeilingUsd(block.currentUsd + (block.projectedUsd ?? 0), block.ceilingUsd),
					setting: "safety.limits.sessionCostUsd",
				});
			};
			try {
				if (deps.scheduling.admitPaidRequest) {
					// A ceiling wait is the operator's decision, not a silent provider.
					// The watchdog re-arms through it as it does through a running
					// tool, so a budget stop is never aborted and retried as a stream
					// stall (#423).
					scope.preInvocationStage = "budget admission";
					scope.stallSuspendDepth += 1;
					// Parked at the ceiling this is PanCode's queue, and no provider has heard of the request.
					let parked: ModelRequestFacts | null = null;
					try {
						await deps.scheduling.admitPaidRequest({
							waitForRaise: deps.headless !== true,
							additionalUsd: () => scope.unsettledSpendUsd,
							getCeilingUsd: () => deps.getSettings().safety.limits.sessionCostUsd,
							contextTokens: input,
							onBlocked: (block) => {
								recordBlock(block);
								parked = {
									sentAt: Date.now(),
									modelId: scope.localRuntime.wireModelId,
									firstByteAt: null,
									bytesObservable: false,
								};
								applyModelAdmission(
									parked,
									{
										stage: "ceiling",
										spentUsd: block.currentUsd + (block.projectedUsd ?? 0),
										ceilingUsd: block.ceilingUsd,
										...(block.pricing ? { pricing: block.pricing } : {}),
									},
									Date.now(),
								);
								state.modelRequest = parked;
							},
							...(scope.modelCall && scope.journalLease
								? {
										telemetry: {
											...scope.journalLease.context,
											callId: scope.modelCall.callId,
											attemptId: scope.modelCall.attemptId,
										},
									}
								: {}),
							...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
						});
					} finally {
						scope.stallSuspendDepth -= 1;
						scope.lastActivityAt = performance.now();
						if (parked !== null) (parked as ModelRequestFacts).admission = null;
					}
				} else {
					const { currentUsd, ceilingUsd, pricing } = deps.scheduling.preflight();
					if (sessionCeilingReached(currentUsd + scope.unsettledSpendUsd, ceilingUsd)) {
						recordBlock({
							level: currentUsd + scope.unsettledSpendUsd > ceilingUsd ? "over" : "at",
							currentUsd,
							...(scope.unsettledSpendUsd > 0 ? { projectedUsd: scope.unsettledSpendUsd } : {}),
							ceilingUsd,
							contextTokens: input,
							...(pricing ? { pricing } : {}),
						});
						throw new SessionCostCeilingError(currentUsd + scope.unsettledSpendUsd, ceilingUsd, undefined, input, pricing);
					}
				}
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
		}
		if (state.activeInterruptReason !== null || state.runtime !== scope.localRuntime) {
			return { block: true, reason: "Request ownership changed while waiting for budget approval." };
		}
		if (observationTracing())
			traceObservation("actor-input", {
				sessionId: deps.sessionId?.() ?? null,
				target: scope.localRuntime.targetId,
				model: scope.localRuntime.wireModelId,
				window: view.effectiveWindow,
				inputTokens: input,
				outputTokens: output,
				context: resolved,
			});
		scope.preInvocationStage = "admission";
		const admission = deps.continuity?.admission() ?? { block: false };
		// Counted only here, once nothing else blocks: the request is about to be sent.
		const capRefusal = admission.block ? undefined : deps.runCaps?.admitRequest();
		if (capRefusal !== undefined) return { block: true, reason: capRefusal };
		scope.admittedMessages = admission.block ? [] : resolved.messages;
		scope.admittedSystemPrompt = admission.block ? "" : (resolved.systemPrompt ?? "");
		return admission;
	});
	const onStreamInvocation = (): void => {
		deps.onMemoryRequestSubmitted?.(scope.admittedMessages, scope.admittedSystemPrompt);
		setGlobalDefaultMaxOutputTokens(deps.getSettings().chat.maxOutputTokens);
		// This ttftMs counts from here, so it includes PanCode's request shaping and any provider-replay
		// rebuild; the journal's TTFT starts at send.end, the handoff to Pi's provider (#434).
		scope.apiCallStartedAt = performance.now();
		scope.apiCallFirstDeltaAt = null;
		scope.outputHeld = false;
		scope.modelCall?.stage("send", "start");
		// The request is out, so its first token is held to the route's first-token limit from now; the run's
		// timer was armed for the mid-stream window, which a calibrated hosted route undercuts (MD11).
		const retry = deps.retrySettings();
		const firstTokenMs = retry.streamStallMs > 0 ? firstTokenLimitMs(retry) : null;
		if (firstTokenMs !== null && firstTokenMs < retry.streamStallMs) {
			clearStallTimer();
			armStallTimer(firstTokenMs);
		}
	};
	const getApiKey = async () => {
		// Pi converts the conversation between turn_start and this call; that is the transform stage (#434).
		const call = scope.modelCall;
		call?.stage("transform", "end");
		scope.placeholderKeySent = !targetRequiresAuth(
			scope.localRuntime.runtimeResolution.target,
			scope.localRuntime.runtimeResolution.runtime,
		);
		if (scope.placeholderKeySent) return LOCAL_API_KEY_FALLBACK;
		scope.preInvocationStage = "auth";
		call?.stage("auth", "start");
		let refreshed: boolean | undefined;
		try {
			const signal = scope.getCurrentAgentSignal();
			const resolved = await deps.providers.auth.resolveForTarget(
				scope.localRuntime.runtimeResolution.target,
				scope.localRuntime.runtimeResolution.runtime,
				signal ? { signal } : undefined,
			);
			refreshed = resolved.refreshed;
			if (!scope.currentRun() || signal?.aborted)
				throw new Error("Request ownership changed while resolving authentication.");
			scope.localRuntime.lastAuthResolution = resolved;
			// A refusal is not "no credential": Pi's "No API key" error would hide why, and the engine's env fallback must not run.
			if (resolved.refused)
				throw new Error(
					resolved.detail ?? `PanCode refuses to send a credential to connection '${scope.localRuntime.targetId}'.`,
				);
			// A failed OAuth refresh carries its remedy in detail; Pi's own "No API key" error would drop it.
			if (
				resolved.apiKey === undefined &&
				resolved.source === "stored-oauth" &&
				resolved.detail &&
				resolved.detail !== resolved.providerId
			)
				throw new Error(resolved.detail);
			return resolved.apiKey;
		} finally {
			call?.stage("auth", "end", refreshed === undefined ? {} : { refreshed });
		}
	};

	return { beforeStreamRequest, onStreamInvocation, getApiKey };
}
