// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { CacheReportV1, CallRowV1, FactMetric } from "../../core/telemetry/dto.js";
import {
	type Analysis,
	type Attempt,
	analyze,
	cacheBreaks,
	cacheState,
	coldKeys,
	divergence,
	engineFloorCalls,
	engineFloors,
	header,
	invoked,
	own,
	promptParts,
	quantity,
	routeOf,
	textFact,
	type View,
} from "./read-model.js";
import type { ReadOptions, SessionSource } from "./read-model-sources.js";

export function cacheReport(source: SessionSource, options: ReadOptions = {}): CacheReportV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	// A cold state lists the floors in the order their routes first read the cache, as a report always has.
	const cache = cacheState(analysis.attempts);
	const floors = engineFloors(cache);
	const floorCalls = engineFloorCalls(analysis.attempts, floors);
	const verdicts = { hot: 0, partial: 0, cold: 0, small: 0, unknown: 0 };
	for (const attempt of analysis.attempts)
		if (invoked(attempt) && attempt.settled)
			verdicts[floorCalls.has(attempt) ? "hot" : attempt.settled.cache.verdict] += 1;
	const breaks = cacheBreaks(cache);
	const causes = [...new Set(breaks.flatMap(coldKeys))].sort();
	const floorRows = [...floors].flatMap(([route, granularity]) => {
		const calls = [...floorCalls.keys()].filter((attempt) => routeOf(attempt) === route);
		if (calls.length === 0) return [];
		const rePrefilled = calls.reduce((total, attempt) => {
			const settled = attempt.settled;
			const re = settled?.cache.rePrefilledTokens;
			return total + (re?.kind === "measured" ? re.value : (promptParts(attempt)?.input ?? 0));
		}, 0);
		return [{ route, granularity, calls: calls.length, rePrefilled }];
	});
	return {
		...header(options),
		kind: "cache",
		sessionId: id,
		verdicts,
		cacheRead: quantity(view, own(id, "cacheRead")),
		cacheWrite: quantity(view, own(id, "cacheWrite")),
		uncachedPrefill: quantity(view, own(id, "uncachedPrefill")),
		rePrefilled: quantity(view, own(id, "rePrefilled")),
		breakUsd: quantity(view, own(id, "breakUsd")),
		breaks: breaks.map((attempt) => {
			const q = (metric: FactMetric) => quantity(view, own(id, metric, { attemptId: attempt.started.attemptId }));
			return {
				callId: attempt.started.callId as CallRowV1["callId"],
				attemptId: attempt.started.attemptId as CallRowV1["attemptId"],
				at: attempt.settledAt ?? attempt.startedAt,
				verdict: attempt.settled?.cache.verdict ?? "unknown",
				expectedColdReasons: attempt.settled?.cache.expectedColdReasons ?? [],
				firstDivergentSection: textFact(divergence(attempt)),
				rePrefilled: q("rePrefilled"),
				uncachedPrefill: q("uncachedPrefill"),
				breakUsd: q("breakUsd"),
				share: q("cacheShare"),
			};
		}),
		byCause: causes.map((cause) => ({
			cause,
			breaks: breaks.filter((attempt) => coldKeys(attempt).includes(cause)).length,
			rePrefilled: quantity(view, own(id, "rePrefilled", { group: { by: "cold", key: cause } })),
			breakUsd: quantity(view, own(id, "breakUsd", { group: { by: "cold", key: cause } })),
		})),
		...cacheShares(view, analysis, id),
		...replayMismatch(view, id, breaks),
		engineFloor: floorRows,
	};
}

/** The session's cached share and its last turn's, read by `telemetry cache`, the exit summary and ACP alike. */
export function cacheShares(view: View, analysis: Analysis, id: string) {
	let lastTurn: string | undefined;
	for (let index = analysis.attempts.length - 1; index >= 0 && lastTurn === undefined; index -= 1) {
		const attempt = analysis.attempts[index] as Attempt;
		if (invoked(attempt) && attempt.ctx?.turnId) lastTurn = attempt.ctx.turnId;
	}
	return {
		share: quantity(view, own(id, "cacheShare")),
		...(lastTurn === undefined
			? {}
			: { lastTurnShare: quantity(view, own(id, "cacheShare", { group: { by: "turn", key: lastTurn } })) }),
	};
}

/** The cache breaks among `breaks` a resumed transcript caused, read by `telemetry cache`, the exit summary and ACP. */
export function replayMismatch(view: View, id: string, breaks: readonly Attempt[]) {
	const replays = breaks.filter((attempt) => coldKeys(attempt).includes("replay_mismatch"));
	const latest = replays.at(-1);
	if (latest === undefined) return {};
	return {
		replayMismatch: {
			breaks: replays.length,
			rePrefilled: quantity(view, own(id, "rePrefilled", { group: { by: "cold", key: "replay_mismatch" } })),
			firstDivergentSection: textFact(divergence(latest)),
		},
	};
}
