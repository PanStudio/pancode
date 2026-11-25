// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `age-horizon`: an age cutoff, recorded instead of destroyed.
 *
 * Every tool-result body older than the protected recent-turn horizon leaves
 * the working set, and every assistant message older than the horizon loses
 * its thinking blocks. The bodies stay in the ledger and come back with
 * `context(scope="recall", ref=...)`.
 *
 * `structural-v1` is the default policy. This one has no target stop on
 * purpose: everything beyond the horizon leaves in one event, and
 * `pressure.target` is ignored.
 *
 * Age is not a quality signal, which is the whole reason `structural-v1`
 * exists: a file read twenty turns ago and never touched since is more useful
 * than a directory listing from two turns ago. Nothing here scores candidates
 * by size or recency beyond that ordering; the only token input is the
 * `minEvictableTokens` floor, which protects low-yield bodies from churn.
 */

import type { EvictionCandidate, PolicyInput, WorkingSetPolicy } from "../contract.js";
import { protectionCutoffIndex } from "../horizon.js";
import { hasThinking, toolResultBodyTokens } from "../payload.js";

export const ageHorizonPolicy: WorkingSetPolicy = {
	id: "age-horizon",
	select(input: PolicyInput): ReadonlyArray<EvictionCandidate> {
		const { entries, view, settings } = input;
		const cutoff = protectionCutoffIndex(entries, settings);
		const candidates: EvictionCandidate[] = [];
		// Newest-safe-first: the entry closest to the protection horizon is the
		// least likely to be re-read, and a caller that stops early has then
		// evicted the oldest nothing and the newest something.
		for (let i = cutoff - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry === undefined || entry.kind !== "message") continue;
			if (view.evicted.has(entry.turnId)) continue;
			if (entry.role === "tool_result") {
				if (toolResultBodyTokens(entry.payload) < settings.minEvictableTokens) continue;
				candidates.push({ ref: { entry: entry.turnId }, reason: "age_horizon" });
				continue;
			}
			// Thinking has no size floor: dropping it costs no marker, so even a
			// short stretch of reasoning is free to remove.
			if (entry.role === "assistant" && hasThinking(entry.payload)) {
				candidates.push({ ref: { entry: entry.turnId }, reason: "thinking_turn_closed" });
			}
		}
		return candidates;
	},
};
