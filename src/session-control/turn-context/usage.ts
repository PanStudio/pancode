// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { mainAgent } from "../../core/telemetry/context.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type { BudgetInspection } from "../../domains/context/budget/inspection.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import { compactionBudget, getCatalogModelForRuntime } from "../../domains/providers/catalog.js";
import { isOrchestratorEligibleRuntime } from "../../domains/providers/index.js";
import { DEFAULT_COMPACTION_THRESHOLD, effectiveCompactionThreshold } from "../../domains/session/compaction/auto.js";
import {
	type ContextSnapshot,
	contextUsageSnapshot,
	snapshotInputTokens,
} from "../../domains/session/context-accounting.js";
import { buildContextLedger, type ContextLedger } from "../../domains/session/context-ledger.js";
import { inPrefixRequestRefusal } from "../../engine/in-prefix-summary.js";
import { resolveFitOutputReserve } from "../output-reserve.js";
import type { LiveContextUsage, TurnContext } from "../turn-context.js";
import { tokenCount } from "./helpers.js";
import type { TurnContextScope } from "./scope.js";

const PROMPT_SPLIT_KEYS = [
	"system",
	"tools",
	"agents",
	"skills",
	"memory",
	"project",
	"toolResults",
	"messages",
] as const satisfies ReadonlyArray<keyof ContextSnapshot["categories"]>;

/** `categories` with its prompt split scaled down to sum to `total`; a split already within it is returned as is. */
function splitWithin(categories: ContextSnapshot["categories"], total: number): ContextSnapshot["categories"] {
	const sum = PROMPT_SPLIT_KEYS.reduce((acc, key) => acc + (categories[key] ?? 0), 0);
	if (sum <= total || sum <= 0) return categories;
	const scaled = { ...categories };
	let kept = 0;
	for (const key of PROMPT_SPLIT_KEYS) {
		if (key === "messages") continue;
		scaled[key] = Math.floor((categories[key] ?? 0) * (total / sum));
		kept += scaled[key] ?? 0;
	}
	// The flooring remainder goes to the conversation, as a reconciled split's residual does.
	scaled.messages = Math.max(0, total - kept);
	return scaled;
}

export function createTurnContextUsage(shared: TurnContextScope) {
	const methods: Required<
		Pick<
			TurnContext,
			"inspectLiveBudget" | "promptSideTokens" | "contextUsage" | "contextLedger" | "journalResumedBudget"
		>
	> = {
		inspectLiveBudget(): BudgetInspection {
			const targetId = shared.deps.getSettings().chat?.connection;
			const target = !shared.state.runtime && targetId ? shared.deps.providers.getTarget(targetId) : null;
			const runtime =
				shared.state.runtime?.runtimeResolution.runtime ??
				(target ? shared.deps.providers.getRuntime(target.runtime) : null);
			if (runtime && (!isOrchestratorEligibleRuntime(runtime) || runtime.externalAgentLoop))
				return {
					status: "unsupported",
					reason: "The external agent owns its context; native request accounting is unavailable.",
				};
			if (!runtime)
				return {
					status: "unavailable",
					reason: "No native runtime descriptor is resolved. Inspection does not initialize a runtime.",
				};
			const live = shared.state.runtime;
			return {
				status: "available",
				capability: "native",
				view: shared.refreshLiveBudget(),
				...(live
					? {
							outputReserveAt: (tokens: number) => resolveFitOutputReserve(live, tokens),
							priceAt: (tokens: number) => {
								const ratio = shared.routeTokenRatio(live);
								return ratio === 1 ? tokens : Math.ceil(tokens * ratio);
							},
							// The checks the fold's `livePrefix` port runs before rebuilding the transcript (MD9).
							livePrefixSummary: () =>
								shared.summaryOnChatRoute(live, shared.deps.getSettings().context.compaction?.model) &&
								inPrefixRequestRefusal(
									live.agent.state.model,
									shared.state.lastMainRequest?.runtime === live ? shared.state.lastMainRequest.record : undefined,
									{ free: live.runtimeResolution.pricedBy === "free" },
								) === null,
						}
					: {}),
				...(shared.sessionPrompt
					? {
							promptSections: shared.sessionPrompt.sections.map((section) => ({
								id: section.id,
								tokenEstimate: section.tokenEstimate,
							})),
						}
					: {}),
			};
		},
		promptSideTokens(): number {
			return shared.currentContextSnapshot ? snapshotInputTokens(shared.currentContextSnapshot) : 0;
		},
		contextUsage(): LiveContextUsage {
			// Footer reads project the last publication. They never rescan the
			// ledger or add streaming output to the next-request message estimate.
			const view = shared.budgetProducer.current() ?? shared.refreshLiveBudget();
			// Occupancy includes the active response. Admission still reads the
			// published next-request input, so generated output is not charged a
			// second time when it becomes settled history.
			const tokens =
				view.inputTokens === null
					? null
					: view.inputTokens + (shared.state.streaming ? shared.liveStreamingOutputTokens() : 0);
			const window = shared.routeSuperseded(view.targetId, view.modelId)
				? shared.windowWithoutRuntime().contextWindow
				: view.effectiveWindow;
			return {
				...contextUsageSnapshot(tokens, window, view.breakdown ?? undefined),
				revision: view.revision,
				inputSource: view.inputSource,
				historical: view.historical,
				breakdownSource: view.breakdownSource,
			};
		},
		contextLedger(): ContextLedger {
			const settings = shared.deps.getSettings();
			// Without a runtime (before the first turn of this process, /resume
			// included) the window comes from the live resolution or the resumed
			// snapshot, and the token facts from the snapshot: the resumed
			// messages are the ones it measured.
			const routed =
				shared.state.runtime && !shared.routeSuperseded(shared.state.runtime.targetId, shared.state.runtime.wireModelId)
					? shared.state.runtime
					: null;
			const window = routed
				? {
						contextWindow: routed.runtimeResolution.contextWindowDetails.effectiveContextWindow,
						contextWindowSource: routed.runtimeResolution.contextWindowDetails.contextWindowSource,
						contextWindowSlots: routed.runtimeResolution.contextWindowDetails.contextWindowSlots,
					}
				: shared.windowWithoutRuntime();
			const compactionThreshold = window.contextWindow > 0 ? (settings.context.compaction?.threshold ?? null) : null;
			const compactionAuto = settings.context.compaction?.auto !== false;
			const route = routed
				? shared.routeCompaction(routed, settings)
				: window.contextWindow > 0
					? shared.previewCompactionRoute(window.contextWindow, settings)
					: null;
			const economic =
				route?.economic ??
				compactionBudget(
					window.contextWindow,
					compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
					settings.context.compaction.maxTokens,
					getCatalogModelForRuntime(
						(shared.state.runtime ? undefined : shared.currentContextSnapshot?.runtimeId) ??
							settings.connections.find((target) => target.id === settings.chat.connection)?.runtime ??
							"",
						settings.chat.model ?? "",
					),
				);
			const compactionCeilingTokens = economic.ceilingTokens;
			// The trigger counts the reserve the threshold's headroom does not cover, so the
			// ledger names the fraction it actually fires at (F-C2).
			const ledgerThreshold =
				compactionThreshold === null
					? null
					: route
						? effectiveCompactionThreshold(
								economic.threshold,
								economic.triggerWindow,
								route.triggerReserve(economic.threshold * economic.triggerWindow),
							)
						: economic.threshold;
			const provider = routed?.targetId ?? settings.chat?.connection ?? null;
			const model = routed?.wireModelId ?? settings.chat?.model ?? null;
			const liveToolCount = shared.state.runtime?.agent.state.tools.length ?? 0;
			// The total is the published view's, the figure the footer and admission read; the capture only splits it.
			const view = shared.budgetProducer.current() ?? shared.refreshLiveBudget();
			const streamingOutput = shared.liveStreamingOutputTokens();
			// Settled output is already history in the view, so only a response in flight is added, as the footer does.
			const totalUsed = view.inputTokens === null ? 0 : view.inputTokens + (shared.state.streaming ? streamingOutput : 0);
			const measured = view.historical
				? shared.currentContextSnapshot?.sources.total === "reconciled"
				: view.anchoredInputTokens !== null;

			if (!shared.currentContextSnapshot) {
				return buildContextLedger({
					provider,
					model,
					...window,
					toolCount: liveToolCount,
					compactionThreshold: ledgerThreshold,
					compactionCeilingTokens,
					compactionAuto,
					streamingTokens: streamingOutput,
					liveTotalTokens: totalUsed > 0 ? totalUsed : null,
					measured,
					lastCompaction: shared.lastCompactionEvent,
					promptCache: shared.lastPromptCache,
					prewarm: shared.lastPrewarm,
				});
			}

			const pendingTokens = shared.pendingUserInputTokens();
			// An unreconciled capture (the one a compaction publishes) is a raw chars/4 split, while the view prices
			// the same request at the route's token ratio. The view's total wins, so the split scales to it rather
			// than outvoting it with a larger figure than the compaction reported.
			const split =
				view.historical || view.inputTokens === null || shared.currentContextSnapshot.sources.total === "reconciled"
					? shared.currentContextSnapshot.categories
					: splitWithin(shared.currentContextSnapshot.categories, Math.max(0, view.inputTokens - pendingTokens));

			return buildContextLedger({
				provider,
				model,
				...window,
				compactionThreshold: ledgerThreshold,
				compactionCeilingTokens,
				compactionAuto,
				systemPromptTokens: split.system,
				toolSchemaTokens: split.tools,
				// Persisted snapshots strip the captured schemas; fall back to
				// the live agent state after a session resume.
				toolCount: shared.currentContextSnapshot.activeToolSchemas?.length ?? liveToolCount,
				messageTokens: split.messages,
				toolResultTokens: split.toolResults ?? 0,
				agentsTokens: split.agents,
				skillsTokens: split.skills,
				memoryTokens: split.memory,
				projectTokens: split.project,
				projectPreload: shared.sessionPrompt?.projectPreload?.label ?? null,
				projectHandbookFiles: shared.sessionPrompt?.projectHandbookFiles ?? null,
				// A session switch keeps the outgoing prompt object until the next compile; only the hash is cleared.
				priorSessionFact: shared.sessionPromptHash === null ? null : (shared.sessionPrompt?.priorSessionFact ?? null),
				pendingTokens,
				streamingTokens: streamingOutput,
				liveTotalTokens: totalUsed > 0 ? totalUsed : null,
				measured,
				lastCompaction: shared.lastCompactionEvent,
				promptCache: shared.lastPromptCache,
				prewarm: shared.lastPrewarm,
			});
		},
		journalResumedBudget(view: LiveBudgetView): void {
			const resumed = shared.resumedBudget;
			shared.resumedBudget = null;
			if (!resumed || view.historical || view.inputTokens === null) return;
			if (shared.deps.session?.current()?.id !== resumed.sessionId) return;
			telemetryHub().emit(
				"context.resumed",
				{
					...(resumed.priorTokens !== null ? { priorTokens: tokenCount(resumed.priorTokens) } : {}),
					projectedTokens: tokenCount(view.inputTokens),
					...(view.estimatedInputTokens !== null ? { estimatedTokens: tokenCount(view.estimatedInputTokens) } : {}),
					inputSource: view.inputSource,
				},
				{ sessionId: resumed.sessionId, agent: mainAgent(resumed.sessionId) },
			);
		},
	};
	return {
		methods,
	};
}
