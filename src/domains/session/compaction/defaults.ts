// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Compaction engine constants. The settings type, `DurableCompactionSettings`,
 * lives in `src/core/defaults.ts` alongside the rest of the settings tree so
 * core code stays free of a backward domain dependency.
 */

/**
 * Tokens held in reserve for the summary response. Ported from
 * pi-coding-agent's `DEFAULT_COMPACTION_SETTINGS.reserveTokens`; kept as an
 * engine-level constant rather than a setting.
 */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * Minimum tokens of recent context the cut-point must keep. The estimator
 * walks backwards until it has accumulated at least this many tokens, then
 * cuts at the nearest valid boundary.
 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
