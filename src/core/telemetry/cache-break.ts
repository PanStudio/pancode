// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The one cache-break band every surface counts by (#423, #434). Healthy appends lose 91 to 849 tokens at a provider's
 * 128-token cache boundaries, so a call broke the cache only when it prefilled again more than 1,024 tokens and more
 * than a tenth of the prefix the previous request sent.
 */
const CACHE_BREAK_MIN_TOKENS = 1_024;
const CACHE_BREAK_MIN_SHARE = 0.1;

/** `lostTokens` of `previousPrefixTokens` were prefilled again instead of read from the cache. */
export function cacheBreakLoss(lostTokens: number, previousPrefixTokens: number): boolean {
	return lostTokens > CACHE_BREAK_MIN_TOKENS && lostTokens > CACHE_BREAK_MIN_SHARE * previousPrefixTokens;
}
