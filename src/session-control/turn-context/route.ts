// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../../core/config.js";
import { foldTriggerReserve } from "../../domains/context/fold/pressure.js";
import { compactionBudget } from "../../domains/providers/catalog.js";
import {
	type ContextWindowDetails,
	type ContextWindowSource,
	type ResolvedRuntimeTarget,
	resolveModelReference,
	resolveRuntimeTarget,
	synthesizeTargetModel,
} from "../../domains/providers/index.js";
import {
	DEFAULT_COMPACTION_THRESHOLD,
	effectiveCompactionThreshold,
	shouldCompact,
} from "../../domains/session/compaction/auto.js";
import { summaryOutputReserve } from "../../domains/session/compaction/summary-output.js";
import { resolveSummaryOutputCap, resolveTurnOutputReserve } from "../output-reserve.js";
import type { CompactionRouteView } from "../turn-context.js";
import type { TurnContextScope } from "./scope.js";

export function createTurnContextRoute(shared: TurnContextScope) {
	const resolveTargetWithoutRuntime = (): ResolvedRuntimeTarget | null => {
		const settings = shared.deps.getSettings();
		const targetId = settings.chat?.target?.trim();
		const wireModelId = settings.chat?.model?.trim();
		if (!targetId || !wireModelId) return null;
		const resolved = resolveRuntimeTarget(shared.deps.providers, {
			targetId,
			wireModelId,
			requestedThinkingLevel: settings.chat?.thinkingLevel ?? "off",
			use: "orchestrator",
			requireTools: false,
			requireOutputBudget: true,
		});
		return resolved.ok ? resolved.target : null;
	};

	/**
	 * Window facts while no runtime exists come only from the current route's
	 * provider status. A resumed snapshot retains historical accounting, but
	 * cannot claim its old loaded window is still serving.
	 */
	const windowWithoutRuntime = (): {
		contextWindow: number;
		contextWindowSource: ContextWindowSource | null;
		contextWindowSlots: ContextWindowDetails["contextWindowSlots"];
	} => {
		const details = resolveTargetWithoutRuntime()?.contextWindowDetails;
		if (details) {
			return {
				contextWindow: details.effectiveContextWindow,
				contextWindowSource: details.contextWindowSource,
				contextWindowSlots: details.contextWindowSlots,
			};
		}
		return { contextWindow: 0, contextWindowSource: null, contextWindowSlots: null };
	};

	/**
	 * Between turns the next request goes out on the route in settings, and the runtime or publication on hand may
	 * still describe the last one until a rebuild lands. A read then states the picked route's window from the frame
	 * the route changed. A turn in flight stays on the route it started with.
	 */
	const routeSuperseded = (targetId: string | null | undefined, modelId: string | null | undefined): boolean => {
		const route = shared.deps.getSettings().chat;
		const target = route?.target?.trim();
		const model = route?.model?.trim();
		if (!target || !model || shared.state.streaming || shared.deps.isTurnActive?.() === true) return false;
		return targetId !== target || modelId !== model;
	};

	/**
	 * Whether the compaction summary is written on the chat route, as it is unless `context.compaction.model` names
	 * another one. A reference that resolves to nothing reads as the chat route, the larger reserve.
	 */
	const summaryOnChatRoute = (
		agentRuntime: CompactionRouteView,
		compactionModel: string | null | undefined,
	): boolean => {
		if (!compactionModel) return true;
		const key = JSON.stringify([compactionModel, agentRuntime.targetId, agentRuntime.wireModelId]);
		if (shared.summaryRouteMemo?.key === key) return shared.summaryRouteMemo.onChatRoute;
		let onChatRoute = true;
		try {
			const { ref } = resolveModelReference(compactionModel, shared.deps.providers, { use: "chat" });
			if (ref) onChatRoute = ref.target === agentRuntime.targetId && ref.model === agentRuntime.wireModelId;
		} catch {
			// An invalid reference fails the summary itself; the trigger keeps the chat route's reserve.
		}
		shared.summaryRouteMemo = { key, onChatRoute };
		return onChatRoute;
	};

	/**
	 * The route's compaction budget and trigger. The summary's output shares the window with the context it reads,
	 * so every trigger check counts its reserve; the reserve is resolved on first use and then held. On a known
	 * window the trigger also counts the turn's own output reserve, the one admission checks, so it fires before
	 * the next request would be refused (bt-13).
	 */
	const routeCompaction = (agentRuntime: CompactionRouteView, settings: Readonly<PancodeSettings>) => {
		const cfg = settings.context.compaction;
		const model = agentRuntime.agent.state.model;
		const economic = compactionBudget(
			agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow,
			cfg?.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
			cfg?.maxTokens,
			model,
		);
		let reserve: number | undefined;
		// A chat-route summary under its A5 cap reserves reasoning room only when it thinks (CTX-3). It may ride the live
		// prefix at the turn's thinking or go portable with thinking off, which resolves no higher, so the turn's level
		// holds the larger. Every other reserve keys on the model, as ContextFold pins.
		const summaryReserve = (): number => {
			if (reserve !== undefined) return reserve;
			const onChatRoute = summaryOnChatRoute(agentRuntime, cfg?.model);
			const capped = onChatRoute && resolveSummaryOutputCap(agentRuntime) !== undefined;
			reserve = summaryOutputReserve(model, {
				summaryOnChatRoute: onChatRoute,
				...(capped ? { capped: { thinking: agentRuntime.runtimeResolution.effectiveThinkingLevel } } : {}),
			});
			return reserve;
		};
		const triggerReserve = (tokens: number): number =>
			foldTriggerReserve({
				window: agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow,
				summaryReserve,
				turnReserve: () => resolveTurnOutputReserve(agentRuntime, tokens),
			});
		/** The fraction of the trigger window at which the automatic trigger fires, counting the reserve for `tokens`. */
		const triggerFraction = (tokens: number): number =>
			effectiveCompactionThreshold(economic.threshold, economic.triggerWindow, triggerReserve(tokens));
		return {
			economic,
			triggerReserve,
			triggerFraction,
			shouldCompact: (tokens: number) =>
				shouldCompact(tokens, economic.threshold, economic.triggerWindow, triggerReserve(tokens)),
			/** The context size at which the automatic trigger fires, counting the reserve for `tokens`. */
			triggerTokens: (tokens: number) => Math.floor(triggerFraction(tokens) * economic.triggerWindow),
		};
	};

	/**
	 * The compaction trigger of the route in settings before a runtime is built on it, from the model the runtime will
	 * synthesize, so the threshold named before the first turn is the one that turn fires at.
	 */
	const previewCompactionRoute = (
		window: number,
		settings: Readonly<PancodeSettings>,
	): ReturnType<typeof routeCompaction> | null => {
		const resolved = resolveTargetWithoutRuntime();
		if (!resolved) return null;
		let synthesized: ReturnType<typeof synthesizeTargetModel>;
		try {
			synthesized = synthesizeTargetModel(resolved, shared.deps.providers.knowledgeBase);
		} catch {
			// A read never fails on a preview; the ledger then names the configured threshold.
			return null;
		}
		const { model, runtimeResolution } = synthesized;
		return routeCompaction(
			{
				targetId: resolved.target.id,
				wireModelId: resolved.wireModelId,
				runtimeResolution: {
					...runtimeResolution,
					contextWindowDetails: { ...runtimeResolution.contextWindowDetails, effectiveContextWindow: window },
				},
				agent: { state: { model } },
			},
			settings,
		);
	};
	return {
		windowWithoutRuntime,
		routeSuperseded,
		summaryOnChatRoute,
		routeCompaction,
		previewCompactionRoute,
	};
}
