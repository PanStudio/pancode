// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { formatCount } from "../core/format-time.js";
import type { FactMetric, FactScope, Quantity } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { COST_NOT_MEASURED } from "../core/telemetry/render.js";
import { usageCoverageLabel } from "../domains/session/usage.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import { type ReasoningUsageView, reasoningFromQuantity } from "./status/reasoning.js";
import { GLYPH } from "./theme/glyphs.js";

/**
 * One operator turn's spend as the read model folds it: the session's own calls and the worker runs the turn
 * referenced, read through the same turn-grouped quantities the footer shows, every string the canonical renderer's
 * (#434 §11.3). An unknown count reads `?` and a partial one `≥`, never a zero nothing measured.
 */
export interface TurnSpend {
	/**
	 * API calls the turn made, its workers' included except those still running when it ended; null when the count is
	 * unknown. With `workers` set, every figure here is the turn's own and the workers' spend is there instead.
	 */
	calls: number | null;
	/** How many of those calls PanCode prepared but never sent. */
	neverSent?: number;
	/** The uncached input, as /usage and the exit card say `in`; `cacheRead` beside it is what the cache served. */
	input: string;
	output: string;
	/** Null when the provider served nothing from its prompt cache. */
	cacheRead: string | null;
	cacheWrite: string | null;
	/** The reasoning the turn's calls journaled, `≈` where PanCode estimated it from the thinking they streamed. */
	reasoning: ReasoningUsageView;
	/** Null when nothing could be charged. */
	cost: string | null;
	/** The calls that reported no usage or never left, or null when every call reported. */
	coverage: string | null;
	/** The same caveat for a one-row receipt, whose full wording lives in the Detailed style and /usage. */
	coverageNote: string | null;
	/** The measured token amounts a one-row receipt states plainly, or null when nothing was measured. */
	tokens: string | null;
	/** The measured prompt-cache read a one-row receipt states, or null when none was measured. */
	cached: string | null;
	/**
	 * The measured prompt-cache write a one-row receipt states, absent when none was measured. Copilot reports nearly
	 * the whole prompt as a cache write, so without it the row read `in 4` for a 19k prompt (bt finding 6).
	 */
	cacheWritten?: string;
	/** One call's own amounts, for a turn whose sum mixes a call that was moved away from with the one that answered. */
	answer?: { tokens: string | null; cached: string | null; cacheWritten?: string };
	/** The worker runs of a turn that ended with some still running, stated apart from its own spend and read live. */
	workers?: TurnWorkerSpend;
}

/** What the worker runs of a turn that left some running spent so far, as the read model folds them. */
export interface TurnWorkerSpend {
	/** Every worker run the turn started. */
	runs: number;
	/** How many of those have not settled. */
	running: number;
	/** Their priced spend, or null when nothing of theirs was priced. */
	cost: string | null;
	/** Their API calls; null when the count is unknown. */
	calls: number | null;
}

/** The known part of a quantity: a measured or estimated value, or a sum's measured and estimated parts. */
function known(quantity: Quantity): number {
	return factKnownValue(quantity.fact);
}

function contributed(quantity: Quantity): boolean {
	const fact = quantity.fact;
	return "kind" in fact
		? fact.kind !== "absent"
		: fact.coverage.measured + fact.coverage.estimated + fact.unknownCount > 0;
}

/** Shown when it holds something other than a measured zero. */
function nonZero(quantity: Quantity): boolean {
	const fact = quantity.fact;
	return (
		contributed(quantity) &&
		("kind" in fact ? fact.kind !== "measured" || fact.value > 0 : known(quantity) > 0 || fact.unknownCount > 0)
	);
}

/**
 * The measured part of a quantity in the footer's narrow form, or null when no call measured it. A one-row receipt states
 * only this: a bound such as `≥~12.9k +?` is true but unreadable on that row, and an estimate of a call that reported
 * nothing is not usage. Detailed and /usage keep the bounds.
 */
/** What a receipt says when no call of the turn measured anything, the footer's words for the same fact. */
export const USAGE_NOT_MEASURED_NOTE = "usage not measured (/usage)";

/**
 * A receipt figure in the shared count form (`881`, `2.0k`, `151.5k`): `≈` marks an estimate and `≥` a lower bound, which
 * already says calls went unreported, so the line ends on how many calls had no usage data, once (F4). A figure nothing
 * reported is `not measured`, never `?`.
 */
function compactFigure(quantity: Quantity): string {
	const fact = quantity.fact;
	if ("kind" in fact) {
		if (fact.kind === "measured") return formatCount(fact.value);
		if (fact.kind === "estimated") return `${GLYPH.estimate}${formatCount(fact.value)}`;
		return fact.kind === "unknown" ? "not measured" : "n/a";
	}
	const counted = fact.coverage.measured > 0 || fact.coverage.estimated > 0;
	if (!counted && fact.unknownCount === 0 && fact.absentCount > 0) return "n/a";
	const figure = `${fact.coverage.estimated > 0 ? GLYPH.estimate : ""}${formatCount(known(quantity))}`;
	if (fact.unknownCount === 0) return figure;
	return counted ? `${GLYPH.atLeast}${figure}` : "not measured";
}

/** The measured part of a quantity in the footer's narrow form, or null when no call measured it. */
export function measuredCount(quantity: Quantity): string | null {
	const fact = quantity.fact;
	if ("kind" in fact) return fact.kind === "measured" ? formatCount(fact.value) : null;
	return fact.coverage.measured > 0 ? formatCount(fact.measured) : null;
}

/** The measured part of a quantity as a receipt states it, in the shared count form, or null when no call measured it. */
function receiptCount(quantity: Quantity): string | null {
	const fact = quantity.fact;
	if ("kind" in fact) return fact.kind === "measured" ? formatCount(fact.value) : null;
	return fact.coverage.measured > 0 ? formatCount(fact.measured) : null;
}

/** `in 321 · out 12` from what was measured, or null when neither side was. */
function measuredTokens(input: Quantity, output: Quantity): string | null {
	const inMeasured = receiptCount(input);
	const outMeasured = receiptCount(output);
	if (inMeasured === null && outMeasured === null) return null;
	return [inMeasured === null ? null : `in ${inMeasured}`, outMeasured === null ? null : `out ${outMeasured}`]
		.filter(Boolean)
		.join(` ${GLYPH.dot} `);
}

function measuredCached(cacheRead: Quantity): string | null {
	const cached = receiptCount(cacheRead);
	return cached === null || cached === "0" ? null : cached;
}

function measuredCacheWrite(cacheWrite: Quantity): { cacheWritten?: string } {
	const written = measuredCached(cacheWrite);
	return written === null ? {} : { cacheWritten: written };
}

/** What the call that answered reported, which a moved turn's one-row receipt states in place of the sum. */
function answerSpend(view: TelemetryView, turnId: string, callId: string): NonNullable<TurnSpend["answer"]> {
	const usage = view.calls({ turnIds: [turnId] }).calls.find((call) => call.callId === callId)?.usage;
	if (!usage) return { tokens: null, cached: null };
	return {
		tokens: measuredTokens(usage.input, usage.output),
		cached: measuredCached(usage.cacheRead),
		...measuredCacheWrite(usage.cacheWrite),
	};
}

/**
 * The calls the worker runs a turn left running at its end hold under that turn: known and unknown. Their calls belong
 * to the worker's own row and card, so the ended turn's count leaves them out and stays what the turn itself made
 * (ns:49-50). Only a run the turn started counts here; the turn's quantity holds no other.
 */
function detachedCalls(
	view: TelemetryView,
	turnId: string,
	runIds: ReadonlyArray<string>,
): { known: number; unknown: number } {
	const detached = { known: 0, unknown: 0 };
	if (runIds.length === 0) return detached;
	const ids = new Set(runIds);
	for (const run of view.runs()) {
		if (!ids.has(run.runId) || run.turnId !== turnId) continue;
		const fact = run.apiCalls.fact;
		detached.known += known(run.apiCalls);
		detached.unknown += "kind" in fact ? (fact.kind === "unknown" ? 1 : 0) : fact.unknownCount;
	}
	return detached;
}

/**
 * The turn's worker runs, read apart from its own calls, when it left one of `detachedRunIds` running and the view holds
 * that run. Null otherwise, and for a turn whose own calls this session's journal does not hold (a fork's copied turn
 * journaled them under its parent), which keeps the turn's figures whole (f-m-turn-row ruling).
 */
function turnWorkers(
	view: TelemetryView,
	turnId: string,
	detachedRunIds: ReadonlyArray<string>,
): TurnWorkerSpend | null {
	if (detachedRunIds.length === 0) return null;
	const detached = new Set(detachedRunIds);
	const runs = view.runs().filter((run) => run.turnId === turnId);
	if (!runs.some((run) => detached.has(run.runId))) return null;
	const read = (scope: FactScope, metric: FactMetric) =>
		view.quantity(factRef({ scope, owner: view.sessionId, metric, group: { by: "turn", key: turnId } }));
	const ownCalls = read("own", "calls");
	const calls = read("runs", "calls");
	const usd = read("runs", "usd");
	if (!ownCalls || !contributed(ownCalls) || !calls || !usd) return null;
	return {
		runs: runs.length,
		running: runs.filter((run) => run.terminalReason === null).length,
		cost: contributed(usd) && usd.display !== COST_NOT_MEASURED ? usd.display : null,
		calls: "kind" in calls.fact || calls.fact.unknownCount === 0 ? known(calls) : null,
	};
}

/**
 * The receipt's worker fact: how many runs, how many still run, then what they spent, `workers 1 running $0.05`. It
 * settles as they do, to `workers 1 done $0.12`; a run's own card says how it ended.
 */
export function turnWorkersFact(workers: TurnWorkerSpend): string {
	const state =
		workers.running === 0
			? `workers ${workers.runs} done`
			: workers.running === workers.runs
				? `workers ${workers.runs} running`
				: `workers ${workers.runs}, ${workers.running} running`;
	if (workers.cost !== null) return `${state} ${workers.cost}`;
	return workers.calls !== null && workers.calls > 0
		? `${state}, ${workers.calls} ${workers.calls === 1 ? "call" : "calls"}`
		: state;
}

/**
 * One of the turn's quantities as its receipt and Work card read it. A /compact between turns is charged to the latest
 * turn, so /usage keeps its calls under that turn; they ran after its last main call settled and the compaction states
 * them on its own row. The live receipt froze before they existed, so this reader leaves them out and a replay of the
 * same journal says what the live turn said.
 */
export function turnQuantityReader(
	view: TelemetryView,
	turnId: string,
	scope: FactScope,
): (metric: FactMetric) => Quantity | null {
	const ref = (metric: FactMetric) =>
		factRef({ scope, owner: view.sessionId, metric, group: { by: "turn", key: turnId } });
	// A fork's copied turn journaled its calls under the parent, so its late compaction is found in the lineage.
	const lineage = scope === "lineage" ? "lineage" : "session";
	const own = view.calls({ turnIds: [turnId] }, lineage).calls;
	const lastMain = own.reduce<string | null>(
		(last, call) =>
			call.agent.role === "main" && call.settledAt !== null && (last === null || call.settledAt > last)
				? call.settledAt
				: last,
		null,
	);
	const late = new Set(
		lastMain === null
			? []
			: own.filter((call) => call.agent.role === "compaction" && call.startedAt >= lastMain).map((call) => call.attemptId),
	);
	if (late.size === 0) return (metric) => view.quantity(ref(metric));
	const attemptIds = [
		...own.flatMap((call) => (late.has(call.attemptId) ? [] : [call.attemptId])),
		...(scope === "own"
			? []
			: view
					.runs()
					.filter((run) => run.turnId === turnId)
					.flatMap((run) => view.calls({ runId: run.runId }).calls.map((call) => call.attemptId))),
	];
	return (metric) => {
		const sum = view.attempts(attemptIds, metric, lineage);
		return { fact: sum.fact, display: sum.display, ref: ref(metric) };
	};
}

/**
 * Null when the view cannot resolve the turn's references. `answeringCallId` also reads that one call's own amounts.
 * A replayed turn reads the `lineage` scope: a forked session's copied turns journaled their calls under its parent.
 * `detachedRunIds` names the worker runs still going when the turn ended. Their turn reads its own calls, tokens and cost
 * with every worker run's spend in `workers`; without the runs in view, the count alone leaves their calls out.
 */
export function turnSpend(
	view: TelemetryView,
	turnId: string,
	answeringCallId?: string,
	scope: "session" | "lineage" = "session",
	detachedRunIds: ReadonlyArray<string> = [],
): TurnSpend | null {
	const workers = turnWorkers(view, turnId, detachedRunIds);
	const read = turnQuantityReader(view, turnId, workers === null ? scope : "own");
	const calls = read("calls");
	// `in` is the uncached input on every surface, with the cache read beside it: the receipt's whole prompt read
	// `in 150k` beside /usage's `input 27k · cache read 123k` for the same calls (bt-11).
	const input = read("input");
	const output = read("output");
	const cacheRead = read("cacheRead");
	const cacheWrite = read("cacheWrite");
	const reasoning = read("reasoning");
	const usd = read("usd");
	const total = read("total");
	const neverSent = read("neverSent");
	if (!calls || !input || !output || !cacheRead || !cacheWrite || !usd || !total || !neverSent) return null;
	const unknownCalls = "kind" in total.fact ? (total.fact.kind === "unknown" ? 1 : 0) : total.fact.unknownCount;
	const skipped = known(neverSent);
	const tokens = measuredTokens(input, output);
	const neverSentNote = skipped > 0 ? `${skipped} ${skipped === 1 ? "call" : "calls"} never sent` : null;
	const detached = workers === null ? detachedCalls(view, turnId, detachedRunIds) : { known: 0, unknown: 0 };
	return {
		calls:
			"kind" in calls.fact || calls.fact.unknownCount - detached.unknown <= 0
				? Math.max(0, known(calls) - detached.known)
				: null,
		...(skipped > 0 ? { neverSent: skipped } : {}),
		input: compactFigure(input),
		output: compactFigure(output),
		cacheRead: nonZero(cacheRead) ? compactFigure(cacheRead) : null,
		cacheWrite: nonZero(cacheWrite) ? compactFigure(cacheWrite) : null,
		reasoning: reasoningFromQuantity(reasoning),
		// A turn nothing priced makes no cost claim, so the receipt names none rather than "not measured".
		cost: contributed(usd) && usd.display !== COST_NOT_MEASURED ? usd.display : null,
		coverage: unknownCalls > 0 || skipped > 0 ? usageCoverageLabel(unknownCalls, skipped) : null,
		// `usage not measured` only when no call measured anything; a call cancelled in its first-token wait is one of those.
		coverageNote:
			tokens !== null || (unknownCalls === 0 && !contributed(input) && !contributed(output))
				? neverSentNote
				: USAGE_NOT_MEASURED_NOTE,
		tokens,
		cached: measuredCached(cacheRead),
		...measuredCacheWrite(cacheWrite),
		...(answeringCallId === undefined ? {} : { answer: answerSpend(view, turnId, answeringCallId) }),
		...(workers === null ? {} : { workers }),
	};
}

/**
 * Whether the view's fold holds every call a run settled, amounts included. Compared by id, not by count: the turn's other runs, such
 * as one an auth refresh continues, and its side calls journal under the same turn, so the turn's count can reach the
 * run's before the run's last call lands (#434 §11.3).
 */
export function turnHoldsCalls(view: TelemetryView, turnId: string, callIds: ReadonlyArray<string>): boolean {
	const { calls } = view.calls({ turnIds: [turnId] });
	// A started call is in the fold before its amounts are. A receipt that stopped reading then kept `usage unknown` for good.
	if (calls.some((call) => call.settledAt === null)) return false;
	const held = new Set(calls.map((call) => call.callId));
	return callIds.every((callId) => held.has(callId));
}
