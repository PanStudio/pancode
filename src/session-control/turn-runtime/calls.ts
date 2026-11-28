// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * An agent build's model-call telemetry: cache physics on each settlement, settling, abandoning and opening the
 * model call and its journal lease, and the harness cause of a clean stop.
 */

import type { BackendCompletionTimings } from "../../core/cache-telemetry.js";
import { rememberMessageCalls } from "../../core/message-accounting.js";
import { requestedThinking } from "../../core/telemetry/call-effort.js";
import { mainAgent } from "../../core/telemetry/context.js";
import type { FailureCause } from "../../core/telemetry/enums.js";
import { unreportedUsageNotice } from "../../core/telemetry/pricing.js";
import { beginCall } from "../../core/telemetry/producer.js";
import type { CallSettled } from "../../core/telemetry/schemas.js";
import { calculatePricingCostUsd, resolveEffectivePricing } from "../../domains/providers/catalog.js";
import { acceptsImageInput } from "../../domains/providers/image-input.js";
import { journalAccountQuota, quotaReadingFromMessage } from "../../domains/quota/index.js";
import { PROMPT_MANIFEST_VERSION } from "../../domains/session/prompt-manifest.js";
import { cachePhysics, journaledStructure, serverTimedUsage } from "../../domains/telemetry/cache-physics.js";
import {
	callSettlementFromMessage,
	type InterruptedUsageEstimate,
	reportedModelFromMessage,
} from "../../domains/telemetry/call-facts.js";
import type { TelemetrySessionLease } from "../../domains/telemetry/session-journals.js";
import type { AgentMessage } from "../../engine/types.js";
import { type AttemptReceipt, carriedCheckpoints } from "../attempt-receipt.js";
import { backendCacheVerdict } from "../chat-loop-messages.js";
import type { ExpectedColdReason } from "../turn-context.js";
import type { AgentBuildScope } from "./scope.js";

export function createCallTelemetry(scope: AgentBuildScope) {
	const { deps, state, context, middlewareToolChoice } = scope.rt;

	/**
	 * Cache physics against the previous request on the same key. Every attempt the provider saw advances the
	 * baseline, hidden #426 retries included, so the ledger's #423 shortfall, which only persisted replies
	 * advance, can differ from rePrefilledTokens until the ledger copy retires (#434).
	 */
	const withCachePhysics = (
		settlement: ReturnType<typeof callSettlementFromMessage>,
		message: AgentMessage,
		attemptId: string | undefined,
	): ReturnType<typeof callSettlementFromMessage> => {
		const request = scope.attemptRequest;
		scope.attemptRequest = undefined;
		const sent = settlement.disposition !== "never_sent";
		// A cooldown reset closed the Codex socket before this call, so its own full frame rebuilt the continuation;
		// an auth reset closed it after, so the next call's does. The SSE pin has no measured reset behind it (#423).
		const recovery = settlement.transport.recovery?.action;
		const reasons: ExpectedColdReason[] = [
			...new Set([
				...(request?.coldReasons ?? []),
				...(recovery === "cooldown_reset" ? ["transport_reset" as const] : []),
			]),
		];
		if (!sent) scope.rt.carriedColdReasons = [...new Set([...scope.rt.carriedColdReasons, ...reasons])];
		if (recovery === "auth_reset")
			scope.rt.carriedColdReasons = [...new Set([...scope.rt.carriedColdReasons, "transport_reset" as const])];
		const generation = context.cacheGeneration?.() ?? 0;
		if (generation !== scope.rt.cacheBaselineGeneration) {
			scope.rt.cacheBaselines.clear();
			scope.rt.cacheBaselineGeneration = generation;
		}
		const resolution = scope.localRuntime.runtimeResolution;
		const key = JSON.stringify([
			scope.localRuntime.targetId,
			request?.model.api ?? scope.localRuntime.agent.state.model.api,
			scope.localRuntime.wireModelId,
		]);
		let structure: ReturnType<typeof scope.requestStructure> | undefined;
		try {
			structure = request ? scope.requestStructure(request.model, request.context, request.compiled) : undefined;
		} catch {
			// A request PanCode cannot digest leaves its cache facts unobserved; telemetry never fails the call (#434).
		}
		const backend = (message as { backendTimings?: BackendCompletionTimings }).backendTimings;
		// A server whose usage omits cache reads its own timings report is judged by those timings (#434).
		const timed = serverTimedUsage(settlement, backend);
		const physics = cachePhysics({
			settlement: timed ? { ...settlement, usage: timed } : settlement,
			structure,
			previous: scope.rt.cacheBaselines.get(key),
			pricing: resolveEffectivePricing(resolution.target, resolution.runtime, resolution.wireModelId),
		});
		if (physics.baseline) scope.rt.cacheBaselines.set(key, physics.baseline);
		else scope.rt.cacheBaselines.delete(key);
		const journalKey = JSON.stringify([deps.sessionId?.() ?? null, key]);
		const prior = scope.rt.journaledStructures.get(journalKey);
		const journaled = structure ? journaledStructure(structure, prior?.structure, prior?.attemptId) : undefined;
		if (structure) scope.rt.journaledStructures.set(journalKey, { structure, ...(attemptId ? { attemptId } : {}) });
		// The receipt is taken at send, beside the structure, for an attempt the provider saw (F14).
		const receipt: AttemptReceipt | undefined =
			sent && request?.cursor && journaled
				? {
						cursor: { hwm: request.cursor.hwm, leaf: request.cursor.leaf },
						...(request.cursor.owner ? { owner: request.cursor.owner } : {}),
						route: {
							...(resolution.modelTier !== undefined ? { modelTier: resolution.modelTier } : {}),
							...(resolution.promptCaching !== undefined ? { promptCaching: resolution.promptCaching } : {}),
							images: acceptsImageInput({ modelInput: request.model.input }),
							midConversation:
								(request.model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)
									?.supportsMidConvoSystemMessages === true,
						},
						...request.receipt,
						...(request.cursor.continuityAtMs !== undefined ? { continuityAtMs: request.cursor.continuityAtMs } : {}),
						records: request.cursor.records,
						checkpoints: carriedCheckpoints(request.context),
					}
				: undefined;
		const usage = (message as { usage?: Record<string, unknown> }).usage ?? {};
		const verdict =
			settlement.disposition === "settled" && typeof usage.input === "number" && typeof usage.cacheRead === "number"
				? backendCacheVerdict(
						usage.input,
						usage.cacheRead,
						typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
						backend,
						usage.cacheReadField === "sent" || usage.cacheReadField === "omitted" ? usage.cacheReadField : undefined,
					)
				: "unknown";
		return {
			...settlement,
			cache: {
				...settlement.cache,
				...physics.cache,
				...(timed ? { uncachedPrefillTokens: timed.input } : {}),
				expectedColdReasons: sent ? reasons : [],
				verdict,
				...(journaled ? { structure: journaled } : {}),
				...(receipt ? { receipt } : {}),
			},
		};
	};
	// A call the producer relabels never sent, because its stages never reached the send, leaves its expected cold
	// reasons to the next call the provider sees, as one the runtime already knew was unsent does (#434).
	const carryRelabelledReasons = (
		settlement: ReturnType<typeof callSettlementFromMessage>,
		facts: CallSettled | undefined,
	): void => {
		if (facts?.disposition === "never_sent" && settlement.disposition !== "never_sent")
			scope.rt.carriedColdReasons = [
				...new Set([...scope.rt.carriedColdReasons, ...settlement.cache.expectedColdReasons]),
			];
	};
	const recordSettledCall = (
		facts: CallSettled | undefined,
		owner: TelemetrySessionLease["context"] | undefined,
	): void => {
		if (facts) {
			scope.settledAttempts.push(facts);
			deps.onModelCallSettled?.(facts);
		}
		if (!facts || !deps.telemetry || owner?.sessionId !== deps.sessionOrigin?.()?.id) return;
		// A call belongs to the turn its lease was taken for, never to whichever turn is active when it settles,
		// including a stream that settles after its run ended (#434).
		const turnId = owner?.turnId && (scope.rt.steeredTurns.get(owner.turnId) ?? owner.turnId);
		if (turnId) scope.rt.turnCalls.set(turnId, [...(scope.rt.turnCalls.get(turnId) ?? []), facts]);
		if (!scope.currentRun()) return;
	};
	// Who stopped an aborted reply when the route did not: its message and its call settlement name the same cause.
	// An actor flag counts only while its reason is live, so a later harness stop never inherits an earlier Esc (x7-3).
	const harnessAbortCause = (): FailureCause | undefined =>
		state.routeMove !== null
			? "route_moved"
			: state.activeInterruptReason !== null && state.activeInterruptByOperator
				? "operator_cancel"
				: state.activeInterruptReason !== null && state.activeInterruptByTriage
					? "triage_stop"
					: state.activeInterruptReason !== null && state.activeInterruptByAutonomy
						? "autonomy_stop"
						: state.activeInterruptReason !== null && state.activeInterruptByJobClock
							? "job_clock"
							: state.activeInterruptReason !== null && state.activeInterruptByLoopGuard
								? "loop_guard"
								: state.repetitionAbortReason !== null
									? "repetition"
									: scope.rt.disposed
										? "shutdown"
										: undefined;
	const settleModelCall = async (
		message: AgentMessage,
		unreported: InterruptedUsageEstimate | null = null,
	): Promise<boolean> => {
		const call = scope.modelCall;
		const lease = scope.journalLease;
		scope.modelCall = undefined;
		scope.journalLease = undefined;
		if (call) {
			Object.assign(message, { callId: call.callId, attemptId: call.attemptId });
			// Under a cap, a call with no reported usage is priced from its request size at the route's rates, so the cap
			// still trips; an uncapped session prices nothing extra.
			const capped = deps.getSettings().safety.limits.sessionCostUsd > 0;
			const aborted = (message as { stopReason?: unknown }).stopReason === "aborted";
			let interrupted = capped || aborted ? unreported : null;
			const resolution = scope.localRuntime.runtimeResolution;
			const { rates } = resolveEffectivePricing(resolution.target, resolution.runtime, resolution.wireModelId);
			if (unreported && capped && rates) interrupted = { ...unreported, usd: calculatePricingCostUsd(rates, unreported) };
			const quota = quotaReadingFromMessage(message, scope.localRuntime.runtimeId, scope.localRuntime.targetId);
			const settlement = withCachePhysics(
				callSettlementFromMessage(
					message,
					{ ...resolution, rates },
					message.role === "assistant" && message.stopReason === "aborted" ? harnessAbortCause() : undefined,
					interrupted,
				),
				message,
				call.attemptId,
			);
			const facts = call.settle(
				{
					...settlement,
					...(quota ? { quota: { provider: quota.provider, windows: quota.windows, source: quota.source } } : {}),
				},
				reportedModelFromMessage(message),
			);
			carryRelabelledReasons(settlement, facts);
			if (
				settlement.pricing.usd.kind === "estimated" &&
				settlement.pricing.usd.method === "prompt-side-only" &&
				capped &&
				// PanCode cut an aborted call short, so its missing usage is no provider's omission (bt-deep 11).
				!aborted &&
				!scope.rt.unreportedUsageSessions.has(deps.sessionOrigin?.()?.id ?? "")
			) {
				scope.rt.unreportedUsageSessions.add(deps.sessionOrigin?.()?.id ?? "");
				deps.emitNotice(unreportedUsageNotice(scope.localRuntime.targetId), "warning");
			}
			recordSettledCall(facts, lease?.context);
			if (quota && facts) journalAccountQuota(quota);
			rememberMessageCalls(message, scope.settledAttempts);
		}
		await lease?.release();
		// A minted call id is not accounting: only a journal that opened holds the call's spend, so a call under a
		// lease that failed to open stays under the in-run cost guard (#434).
		return call !== undefined && lease?.journaled === true;
	};
	// A round the loop moves past without an assistant message still settles its attempt, so no call.started stays
	// open and no lease is held past the run (#434, R9). It has no ledger row, so a never-sent one is counted here.
	const abandonModelCall = async (): Promise<void> => {
		const call = scope.modelCall;
		const lease = scope.journalLease;
		scope.modelCall = undefined;
		scope.journalLease = undefined;
		scope.attemptRequest = undefined;
		if (call) {
			recordSettledCall(
				call.abandon(
					state.activeInterruptReason !== null && state.activeInterruptByOperator
						? "operator_cancel"
						: state.activeInterruptReason !== null && state.activeInterruptByTriage
							? "triage_stop"
							: state.activeInterruptReason !== null && state.activeInterruptByAutonomy
								? "autonomy_stop"
								: state.activeInterruptReason !== null && state.activeInterruptByJobClock
									? "job_clock"
									: state.activeInterruptReason !== null && state.activeInterruptByLoopGuard
										? "loop_guard"
										: "internal",
				),
				lease?.context,
			);
		}
		await lease?.release();
	};
	// The journal's call for the next model response of this run (#434).
	const openModelCall = async (): Promise<void> => {
		const origin = deps.sessionOrigin?.();
		if (!origin || !deps.telemetry?.acquireTelemetrySession) return;
		const leaseTurnId = state.activeUserTurnId;
		if (scope.runTurnId !== null && leaseTurnId !== null && leaseTurnId !== scope.runTurnId)
			scope.rt.steeredTurns.set(leaseTurnId, scope.rt.steeredTurns.get(scope.runTurnId) ?? scope.runTurnId);
		scope.journalLease = await deps.telemetry.acquireTelemetrySession(
			origin,
			mainAgent(origin.id),
			leaseTurnId ?? undefined,
		);
		const compiled = context.compiledSessionPrompt?.();
		const compile = context.promptCompileRecord?.();
		const objects = await scope.journalLease.storeRequestObjects?.({
			...(compiled ? { prompt: { ...compiled, ...(compile ? { compile } : {}) } } : {}),
			tools: scope.localRuntime.agent.state.tools.map(({ name, description, parameters }) => ({
				name,
				description,
				parameters,
			})),
		});
		const choice = middlewareToolChoice.current();
		const textOnly = state.synthesisToolLock || choice.kind === "none";
		scope.modelCall = beginCall(
			{
				...(objects && Object.keys(objects).length > 0 ? { objects } : {}),
				target: {
					targetId: scope.localRuntime.targetId,
					runtimeId: scope.localRuntime.runtimeId,
					api: scope.localRuntime.agent.state.model.api,
					requestedModel: scope.localRuntime.wireModelId,
					reportedModel: { kind: "unknown", reason: "not-observed" },
				},
				roundKind: textOnly ? "text-only" : choice.kind === "required" ? "required" : "normal",
				toolChoice: textOnly ? "none" : choice.kind === "required" ? { name: choice.toolName } : "auto",
				...requestedThinking(scope.localRuntime.agent.state.thinkingLevel),
			},
			scope.journalLease.context,
		);
		if (objects?.promptStructure && compiled)
			scope.journalLease.recordPromptCompiled?.(
				objects.promptStructure,
				{
					layoutVersion: PROMPT_MANIFEST_VERSION,
					tokenEstimate: Math.max(0, Math.round(compiled.tokenEstimate)),
					sections: compiled.sections.length,
					...(compile ? { compiledAt: compile.at, previousHash: compile.previousHash } : {}),
					...(scope.localRuntime.agent.state.thinkingLevel
						? { thinkingLevel: String(scope.localRuntime.agent.state.thinkingLevel) }
						: {}),
				},
				{ ...scope.journalLease.context, callId: scope.modelCall.callId, attemptId: scope.modelCall.attemptId },
			);
		scope.modelCall.stage("transform", "start");
	};

	return {
		withCachePhysics,
		carryRelabelledReasons,
		recordSettledCall,
		harnessAbortCause,
		settleModelCall,
		abandonModelCall,
		openModelCall,
	};
}
