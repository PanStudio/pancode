// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * What every model round of a native worker run starts from: the handback shares, the thinking
 * level the model can run, the inherited messages and the context guard that fits them, the
 * response formats and contract reminder, the admission check before each request, and the
 * agent's initial state.
 */

import { type ModelRouteRefusal, modelRouteRefusalMessage } from "../../core/response-model-id.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { resultContractReminder } from "../../domains/agents/result-contract-repair.js";
import { createWorkerContextGuard } from "../../domains/context/worker/pressure.js";
import { HANDBACK_CONTEXT_SHARE, HANDBACK_NOTE_SHARE } from "../../domains/dispatch/handback.js";
import type { RunRole } from "../../domains/dispatch/obligation.js";
import { PROVIDER_PROBE_TIMEOUT_MS } from "../../domains/providers/contract.js";
import {
	probedModelOffer,
	resolveModelRuntimeCapabilitiesForModel,
	type ThinkingLevel,
} from "../../domains/providers/index.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	flowTransferRefusal,
	resolveModelDestination,
} from "../../domains/safety/information-flow.js";
import { seededWorkerMessages } from "../../lib/worker-wire/context-seed.js";
import type { EngineAgentOptions } from "../agent.js";
import type { EngineModel } from "../types.js";
import { workerContractResponseFormatFor, workerResponseFormatFor } from "../worker-result-contract.js";
import { THRASH_CONTEXT_FRACTION } from "../worker-thrash-note.js";
import type { WorkerRunScope } from "./scope.js";

function clampThinkingLevelForModel(model: EngineModel, requested: ThinkingLevel | undefined): ThinkingLevel {
	const level = requested ?? "off";
	return resolveModelRuntimeCapabilitiesForModel(model, level).thinking.effectiveLevel;
}

export function createWorkerRound(scope: WorkerRunScope) {
	const { input, emit, model, safety, tools, observations, seedLineage, loopGuardRegistration, helperToolAvailable } =
		scope;
	const workShare = (role: RunRole): number => input.limits?.context.workShare ?? HANDBACK_CONTEXT_SHARE[role];
	const noteShare = input.limits?.context.noteShare ?? HANDBACK_NOTE_SHARE;
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

	// The run's restrictions are judged against the target as configured for
	// this run before each request, the same verdict the parent would reach.
	const beforeStreamRequest: NonNullable<EngineAgentOptions["beforeStreamRequest"]> = async ({
		options: streamOptions,
	}) => {
		const unavailable = await modelOfferRefusal(streamOptions?.signal);
		if (unavailable !== null)
			return { block: true, reason: modelRouteRefusalMessage(unavailable), modelRouteRefusal: unavailable };
		scope.workerTelemetry?.stage("admission", "start");
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
		scope.workerTelemetry?.stage("admission", "end");
		if (reason === null) return { block: false };
		// A retry or failover on this target carries the same labels and meets
		// the same refusal, so the parent must not spend another attempt on it.
		if (!scope.flowBlockReported) {
			scope.flowBlockReported = true;
			emit({ type: "pancode_run_outcome", payload: { outcomeCode: "information_flow_blocked", detail: reason } });
		}
		return { block: true, reason };
	};

	const initialState: EngineAgentOptions["initialState"] = {
		systemPrompt: input.systemPrompt,
		model,
		thinkingLevel: effectiveThinkingLevel,
		tools,
		messages: inheritedMessages,
	};

	return {
		workShare,
		noteShare,
		effectiveThinkingLevel,
		inheritedMessages,
		contextGuard,
		workerResponseFormat,
		contractReminder,
		beforeStreamRequest,
		initialState,
	};
}
