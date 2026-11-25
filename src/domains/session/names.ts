// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { SessionMeta } from "./contract.js";
import type { SessionEntry } from "./entries.js";
import { operatorTextOfUserPayload } from "./history.js";

const AMBIGUOUS_IDS_SHOWN = 8;

/** ID lookups retain precedence over names, including ambiguous ID prefixes (#443). */
export function resolveSessionTarget(
	sessions: ReadonlyArray<Pick<SessionMeta, "id" | "name">>,
	target: string,
): { id: string } | { miss: string } {
	// Every id starts with the empty string, so a blank selector (an unset shell variable) would pick the sole session.
	if (target.trim().length === 0) return { miss: "a session selector cannot be empty" };
	if (sessions.some((session) => session.id === target)) return { id: target };
	const prefixes = sessions.filter((session) => session.id.startsWith(target));
	const matches = prefixes.length > 0 ? prefixes : sessions.filter((session) => session.name === target);
	if (matches.length === 1 && matches[0]) return { id: matches[0].id };
	if (matches.length === 0) return { miss: `no session matches ${target}` };
	// The ids let the caller retype a longer prefix at once, as run --resume lists them.
	const shown = matches.slice(0, AMBIGUOUS_IDS_SHOWN).map((session) => session.id);
	const more = matches.length > shown.length ? `, and ${matches.length - shown.length} more` : "";
	return { miss: `${target} matches ${matches.length} sessions: ${shown.join(", ")}${more}` };
}

/** A bounded title from operator text only; no provider or model is involved (#443). */
export function suggestSessionName(entries: ReadonlyArray<SessionEntry>): string | null {
	for (const entry of entries) {
		if (entry.kind !== "message" || entry.role !== "user") continue;
		const text = operatorTextOfUserPayload(entry.payload);
		if (!text) continue;
		const words = text
			.replace(/[^\p{L}\p{N}\s._-]/gu, " ")
			.trim()
			.split(/\s+/u)
			.filter(Boolean);
		const name = Array.from(words.slice(0, 7).join(" ")).slice(0, 60).join("").trim();
		if (name) return name;
	}
	return null;
}
