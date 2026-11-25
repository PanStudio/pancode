// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The numbers at the top of the Progress view: how long the task has run, how much it has used, and
// how far its plan has come. Pure and defensive, because every field is a reported value that may be
// absent on a replayed turn.

import type { ContextLedger } from "../../contracts/context-ledger.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";

/**
 * Turn count, wall time and whether a turn is running. Tokens and cost are not summed here: the read model folds
 * them and the usage read carries its displays, so a client sum would be a second, lesser accounting (#434).
 */
export interface TaskOverview {
	readonly turns: number;
	readonly elapsedMs: number;
	readonly running: boolean;
}

function at(value: string | null | undefined): number | null {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

export function taskOverview(turns: SessionSnapshot["turns"], nowMs: number): TaskOverview {
	let elapsed = 0;
	let running = false;
	for (const turn of turns) {
		const start = at(turn.startedAt);
		if (start === null) continue;
		const end = at(turn.finishedAt);
		if (end !== null) elapsed += Math.max(0, end - start);
		else if (turn.status === "running") {
			running = true;
			elapsed += nowMs > 0 ? Math.max(0, nowMs - start) : 0;
		}
	}
	return { turns: turns.length, elapsedMs: elapsed, running };
}

export interface ContextMeter {
	/** 0 to 100, clamped for drawing. */
	readonly percent: number;
	/** The share in use as the server worded it, or null when the ledger reports no share. */
	readonly figure: string | null;
	readonly tone: "ok" | "warn" | "full";
	/** "43K of 128K tokens", with "estimated" until the provider reports usage. */
	readonly label: string;
	/** The whole sentence for assistive technology. */
	readonly text: string;
}

/**
 * The window meter on the Progress view, from PanCode's own accounting. Null when the window size is not
 * reported, because a share of an unknown size would be invented.
 */
/** The meter's fill is geometry from the ledger's counts; its words are the server's displays (#434). */
export function contextMeter(
	ledger: Pick<ContextLedger, "usedTokens" | "contextWindow" | "percent" | "measured" | "display">,
): ContextMeter | null {
	const meter = ledger.display.meter;
	if (ledger.contextWindow <= 0 || meter === null) return null;
	const raw = ledger.percent ?? 0;
	const percent = Math.min(100, Math.max(0, raw));
	const tone = percent >= 85 ? "full" : percent >= 65 ? "warn" : "ok";
	const label = `${meter.used} of ${meter.window} tokens${ledger.measured ? "" : ", estimated"}`;
	return {
		percent,
		figure: ledger.display.percent,
		tone,
		label,
		text: `Context window ${ledger.display.percent ?? "share not reported"} used, ${label}`,
	};
}
