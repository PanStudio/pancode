// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { AcpContextLedger } from "./types-views.js";

export { ACP_CONTEXT_LEDGER_METHOD, ACP_CONTEXT_META_KEY } from "./types.js";

/**
 * `_pancode/context/ledger`: the terminal's `/context` window view as one
 * bounded projection of `chat.contextLedger()`.
 *
 * The ledger is PanCode's own accounting: which categories fill the window,
 * how much is held in reserve for compaction, whether the total is measured by
 * the provider or estimated, and what the prompt cache reused. This projection
 * reads it and nothing else, so a client shows the same numbers the terminal
 * does and cannot recompute them differently. Unknown stays unknown: a window
 * of 0 and a null percentage travel as they are.
 */

import type { ContextLedger } from "../../domains/session/context-ledger.js";
import { boundedText } from "./server-bounds.js";

const MAX_GROUPS = 32;
const MAX_HANDBOOK_FILES = 16;
const MAX_COLD_REASONS = 16;
const MAX_TEXT_BYTES = 256;

const optional = (text: string | null | undefined) =>
	text === null || text === undefined ? null : boundedText(text, MAX_TEXT_BYTES);
const count = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const duration = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
const nullableCount = (value: number | null | undefined) =>
	value === null || value === undefined || !Number.isFinite(value) ? null : Math.max(0, Math.round(value));

export function projectContextLedger(ledger: ContextLedger): AcpContextLedger {
	const slots = ledger.contextWindowSlots;
	const cache = ledger.promptCache;
	return {
		version: 1,
		provider: optional(ledger.provider),
		model: optional(ledger.model),
		contextWindow: count(ledger.contextWindow),
		contextWindowSource: optional(ledger.contextWindowSource),
		contextWindowSlots: slots === null ? null : { slots: count(slots.slots), totalTokens: count(slots.totalContextSize) },
		usedTokens: count(ledger.usedTokens),
		reserveTokens: count(ledger.reserveTokens),
		freeTokens: count(ledger.freeTokens),
		percent: ledger.percent === null || !Number.isFinite(ledger.percent) ? null : Math.max(0, ledger.percent),
		measured: ledger.measured,
		compactionThreshold:
			ledger.compactionThreshold === null || !Number.isFinite(ledger.compactionThreshold)
				? null
				: ledger.compactionThreshold,
		compactionAuto: ledger.compactionAuto,
		projectPreload: optional(ledger.projectPreload),
		projectHandbookFiles:
			ledger.projectHandbookFiles === null
				? null
				: ledger.projectHandbookFiles.slice(0, MAX_HANDBOOK_FILES).map((text) => boundedText(text, MAX_TEXT_BYTES)),
		toolCount: count(ledger.toolCount),
		groups: ledger.groups.slice(0, MAX_GROUPS).map((group) => ({
			category: group.category,
			label: boundedText(group.label, MAX_TEXT_BYTES),
			tokens: count(group.tokens),
			percent: group.percent === null || !Number.isFinite(group.percent) ? null : Math.max(0, group.percent),
		})),
		lastCompaction:
			ledger.lastCompaction === null || ledger.lastCompaction === undefined
				? null
				: {
						stage: boundedText(ledger.lastCompaction.stage, MAX_TEXT_BYTES),
						tokensBefore: count(ledger.lastCompaction.tokensBefore),
						tokensAfter: count(ledger.lastCompaction.tokensAfter),
						trigger: boundedText(ledger.lastCompaction.trigger, MAX_TEXT_BYTES),
					},
		promptCache:
			cache === null
				? null
				: {
						shellReused: cache.shellReused,
						cacheReadTokens: nullableCount(cache.cacheReadTokens),
						cacheWriteTokens: nullableCount(cache.cacheWriteTokens),
						uncachedInputTokens: nullableCount(cache.uncachedInputTokens),
						backendVerdict: cache.backendVerdict,
						// The three facts /context reads for its divergence warning, so a client can show it too (#434).
						expectedColdReasons: (cache.expectedColdReasons ?? [])
							.slice(0, MAX_COLD_REASONS)
							.map((text) => boundedText(text, MAX_TEXT_BYTES)),
						backend:
							cache.backend === null
								? null
								: {
										promptTokens: count(cache.backend.promptTokens),
										cachedTokens: nullableCount(cache.backend.cachedTokens),
										predictedTokens: count(cache.backend.predictedTokens),
										promptMs: duration(cache.backend.promptMs),
										predictedMs: duration(cache.backend.predictedMs),
										source: cache.backend.source,
									},
						uncachedPrefillTokens: nullableCount(cache.uncachedPrefillTokens),
					},
	};
}
