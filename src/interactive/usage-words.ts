// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The terminal's usage words that read the session's telemetry view: sent and never-sent calls, judged outcomes and
 * the economics receipt. The coverage phrasing they build on lives in core/views/usage-words.ts, shared with the GUI.
 */

import { GLYPH } from "../core/glyphs.js";
import type { EconomyProjection, EconomyQuantities, UnitTotal, UnitTotalRefusal } from "../core/telemetry/economy.js";
import type { AgentRole } from "../core/telemetry/enums.js";
import type { Fact, FactSum } from "../core/telemetry/fact.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { renderCountSum, renderUnitTotal, renderUsdSum } from "../core/telemetry/render.js";
import { expandChainMessages } from "../core/tool-surface.js";
import {
	economyTotalKnown,
	economyTotalUnknown,
	isFactSum,
	USAGE_NOT_MEASURED,
	usageLineFigure,
	usageSaysNothing,
} from "../core/views/usage-words.js";
import {
	countVerifiedOutcomes,
	perVerifiedOutcome,
	runHostVerified,
	type VerifiedOutcomeCount,
} from "../domains/evidence/verified-outcomes.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";

const count = (value: number): string => value.toLocaleString("en-US");

/** Calls that reached the provider or may have; a never-sent attempt asked the model nothing. */
const SENT_DISPOSITIONS = ["sent_unsettled", "settled_no_usage", "settled", "incomplete"] as const;

/**
 * Model calls that went out, counted once per call across its attempts. `/usage` counted the memory guardian's skipped
 * steps as model calls (20) beside an exit card that counted the 11 that were sent; both count this now.
 *
 * A worker run's calls live in its own journal, not among the session's attempts, so they are counted from the run's
 * fold, whose call count is the requests that reached the provider. The Session tab read `worker calls 0 sent · 13
 * more never sent` after workers that ran 13 real rounds, because only the session's own attempts were listed here.
 */
export function sentCallCount(view: TelemetryView, filter: { roles?: AgentRole[]; from?: string } = {}): number {
	try {
		const calls = view.calls({ ...filter, dispositions: [...SENT_DISPOSITIONS] }).calls;
		const own = new Set(calls.map((call) => call.callId)).size;
		if (filter.roles !== undefined && !filter.roles.includes("worker")) return own;
		return own + sentRuns(view, filter.from).reduce((sum, run) => sum + runSentCalls(view, run), 0);
	} catch {
		// A read model that cannot list calls has no sent count to give; the caller shows its own total instead.
		return Number.NaN;
	}
}

/**
 * Model calls PanCode began but never sent since `from`, such as the one a Ctrl+C stopped before its send: a call whose
 * later attempt went out is a sent call. The footer says `8 calls, 1 never sent` of the same turn.
 */
export function neverSentCallCount(view: TelemetryView, filter: { from?: string } = {}): number {
	try {
		const ids = (dispositions: NonNullable<Parameters<TelemetryView["calls"]>[0]>["dispositions"]) =>
			new Set(view.calls({ ...filter, ...(dispositions ? { dispositions } : {}) }).calls.map((call) => call.callId));
		const sent = ids([...SENT_DISPOSITIONS]);
		return [...ids(["never_sent"])].filter((id) => !sent.has(id)).length;
	} catch {
		return 0;
	}
}

/**
 * A run's sent calls: its record's count, or the calls its journal holds when more went out than the record has
 * settled. A worker still waiting on the model when PanCode quit read `0 model calls` beside `1 call had no timing data`.
 */
function runSentCalls(view: TelemetryView, run: ReturnType<TelemetryView["runs"]>[number]): number {
	const journaled = view.calls({ runId: run.runId, dispositions: [...SENT_DISPOSITIONS] }).calls;
	return Math.max(factKnownValue(run.apiCalls.fact), new Set(journaled.map((call) => call.callId)).size);
}

/** The worker runs {@link sentCallCount} counts: every referenced run that began at or after `from`. */
function sentRuns(view: TelemetryView, from: string | undefined) {
	return view.runs().filter((run) => from === undefined || run.firstAt === null || run.firstAt >= from);
}

/**
 * The cumulative time from each attempt's start to its settle over the calls {@link sentCallCount} counts from `from`,
 * worker runs' attempts included, so the time sits beside a count of the same calls. `untimed` counts the calls a run
 * reported with no per-call record to time; the caller says so with the sum's own gap. Null when no call went out.
 */
export function sentCallTime(
	view: TelemetryView,
	from: string,
): { time: ReturnType<TelemetryView["attempts"]>; untimed: number } | null {
	const sent = [...SENT_DISPOSITIONS];
	const attemptIds = view.calls({ from, dispositions: sent }).calls.map((call) => call.attemptId);
	let untimed = 0;
	for (const run of sentRuns(view, from)) {
		const calls = view.calls({ runId: run.runId, dispositions: sent }).calls;
		attemptIds.push(...calls.map((call) => call.attemptId));
		// The run's call count is its sent attempts that reached the provider; one it holds no record of has no timing.
		const recorded = calls.filter((call) => call.disposition !== "incomplete").length;
		untimed += Math.max(0, factKnownValue(run.apiCalls.fact) - recorded);
	}
	if (attemptIds.length === 0 && untimed === 0) return null;
	return { time: view.attempts(attemptIds, "settle"), untimed };
}

/** A single fact as the one-contribution sum it is, so a share of it renders through the sum renderers. */
function asSum(fact: Fact<number> | FactSum): FactSum {
	if (isFactSum(fact)) return fact;
	const value = fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0;
	return {
		measured: fact.kind === "measured" ? value : 0,
		estimated: fact.kind === "estimated" ? value : 0,
		unknownCount: fact.kind === "unknown" ? 1 : 0,
		absentCount: fact.kind === "absent" ? 1 : 0,
		coverage: {
			measured: fact.kind === "measured" ? 1 : 0,
			estimated: fact.kind === "estimated" ? 1 : 0,
			unknown: fact.kind === "unknown" ? 1 : 0,
		},
	};
}

/** What a session's verified outcomes cost, in the words `/usage` and the exit card share. */
export type VerifiedOutcomeWords =
	| { kind: "none"; words: string }
	| {
			kind: "counted";
			/** `3`. */
			count: string;
			/** `2 reproduce or numeric-compare passes`, `1 worker run host-verified`, `1 task done with a passing check`. */
			parts: string[];
			/** Session tokens over the outcomes: `4,115`, `≥4,115`, or `not measured`. */
			tokens: string;
			/** Session cost over the outcomes: `$0.0041`, `~$0.0041 est`, `$0.00 local`, or `not measured`. */
			cost: string;
	  };

/**
 * The session's verified outcomes from its whole ledger and the worker runs its telemetry references. A run's record
 * is read and its seal checked here, so a caller reads this once per render, not per row. A fork counts only what it
 * recorded itself: its `session.forked` row names the parent turn its ledger's copied entries end at.
 */
export function sessionVerifiedOutcomes(view: TelemetryView, entries: ReadonlyArray<unknown>): VerifiedOutcomeCount {
	const forkTurnId = view.session().lineage.parent?.turnId ?? null;
	const verified = new Set<string>();
	try {
		for (const row of view.runs()) if (runHostVerified(view.run(row.runId))) verified.add(row.runId);
	} catch {
		// A read model that cannot list runs leaves the runs out; the ledger's own outcomes still count.
	}
	return countVerifiedOutcomes(expandChainMessages(entries), verified, forkTurnId);
}

/** Command checks such as unit tests are not judged outcomes, and the words say so rather than read as nothing verified. */
export const NO_VERIFIED_OUTCOME = "no judged outcome this session; command checks such as unit tests are not counted";

/** The session's seat credits split over its outcomes, or null when no call measured or estimated a debit. */
function seatCreditShare(view: TelemetryView, outcomes: number): string | null {
	const credits = view.economy().total.seatCredits;
	if ("refused" in credits || !("unit" in credits)) return null;
	if (credits.sum.coverage.measured + credits.sum.coverage.estimated === 0) return null;
	return renderUnitTotal({ unit: credits.unit, sum: perVerifiedOutcome(credits.sum, outcomes) });
}

/**
 * The session's tokens and cost per verified outcome. The shares divide the read model's own session totals and are
 * drawn by the canonical renderers, so an unpriced route reads `not measured` and a partial total keeps its `≥` or
 * `+?`. With no outcome there is nothing to divide by, and the words say so.
 */
export function verifiedOutcomeWords(view: TelemetryView, outcomes: VerifiedOutcomeCount): VerifiedOutcomeWords {
	if (outcomes.total <= 0) return { kind: "none", words: NO_VERIFIED_OUTCOME };
	const totals = view.session().totals;
	const tokenShare = perVerifiedOutcome(asSum(totals.tokens.fact), outcomes.total);
	const tokens = usageLineFigure({ fact: tokenShare, display: renderCountSum(tokenShare) });
	const priced = view.cost("role").total.pricedBy;
	// A spend every call of which was free reads the same per outcome; its display names the free rule.
	const free = priced.free > 0 && priced.provider + priced["target-rates"] + priced.catalog + priced.none === 0;
	const costShare = perVerifiedOutcome(asSum(totals.usd.fact), outcomes.total);
	const usdCost = free ? totals.usd.display : renderUsdSum(costShare, false);
	// A seat route prices no USD but debits credits, and the cost line above states them, so the share divides those
	// rather than read `cost not measured` under `cost 0.3792 credits` (bt2-6).
	const cost = usdCost === USAGE_NOT_MEASURED ? (seatCreditShare(view, outcomes.total) ?? usdCost) : usdCost;
	const plural = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;
	return {
		kind: "counted",
		count: count(outcomes.total),
		parts: [
			...(outcomes.checks > 0
				? [plural(outcomes.checks, "reproduce or numeric-compare pass", "reproduce or numeric-compare passes")]
				: []),
			...(outcomes.workers > 0 ? [plural(outcomes.workers, "worker run host-verified", "worker runs host-verified")] : []),
			...(outcomes.tasks > 0
				? [plural(outcomes.tasks, "task done with a passing check", "tasks done with a passing check")]
				: []),
		],
		tokens: usageSaysNothing(tokens) ? USAGE_NOT_MEASURED : tokens,
		cost,
	};
}

// ---- the economics receipt (token economy S12) ----

type EconomyTotal = UnitTotal | UnitTotalRefusal;

/** Some contribution fed the total, known or not; a total no contribution fed has nothing to say. */
function totalFed(total: EconomyTotal | FactSum): boolean {
	if ("refused" in total) return true;
	const sum = "sum" in total ? total.sum : total;
	return sum.coverage.measured + sum.coverage.estimated + sum.unknownCount > 0;
}

/** One part of the receipt line and whether it carries an unknown. */
export interface ReceiptPart {
	text: string;
	unknown: boolean;
}

/**
 * The scope's one-line receipt: the binding quota window first when the route draws on a subscription, then the extra
 * cost to the user, any seat credits, and the API equivalent. It folds the calls' economics only, so a declared pool
 * fee, which belongs to its period, never appears on it, whatever scope (a turn or a session) it sums. Every amount is
 * the S10 projection's own display, so a sub-cent amount keeps its digits and never reads as free. A part no call
 * measured or estimated is left out; empty when no call contributed.
 */
export function economyReceipt(total: EconomyQuantities, window: ReceiptPart | null): ReceiptPart[] {
	if (total.contributions === 0) return [];
	return [
		...(window !== null ? [window] : []),
		...(economyTotalKnown(total.marginalCharge)
			? [{ text: total.display.extra, unknown: economyTotalUnknown(total.marginalCharge) }]
			: []),
		// Seat credits read as `N AI credits`, so only a route that debited a seat shows them here; the evidence keeps the rest.
		...(economyTotalKnown(total.seatCredits)
			? [{ text: total.display.seatCredits, unknown: economyTotalUnknown(total.seatCredits) }]
			: []),
		...(economyTotalKnown(total.apiEquivalent)
			? [{ text: total.display.apiEquivalent, unknown: economyTotalUnknown(total.apiEquivalent) }]
			: []),
	];
}

/**
 * The seat credits a scope debited, as its cost where its route priced no USD: `cost not measured` beside `10.6
 * credits` read as no cost and a cost at once (tui-verify 11). Null when no call measured or estimated a debit.
 */
export function creditCost(total: EconomyQuantities): string | null {
	const credits = total.seatCredits;
	return "refused" in credits || !economyTotalKnown(credits) ? null : total.display.seatCredits;
}

/** The receipt as plain words, for a surface that draws it without tones. */
export function receiptLine(parts: readonly ReceiptPart[]): string {
	return parts.map((part) => part.text).join(` ${GLYPH.sep} `);
}

/** One evidence row: label, value, an optional note, and whether the value carries an unknown. */
export type EvidenceRow = readonly [label: string, value: string, note: string | undefined, unknown: boolean];

/** Whose word the seat-credit debit is: the provider's report wins over the listing estimate, call by call. */
function seatCreditsNote(total: EconomyQuantities["seatCredits"]): string | undefined {
	if ("refused" in total) return undefined;
	const { measured, estimated } = total.sum.coverage;
	if (measured > 0 && estimated > 0) return `${measured} provider-reported, ${estimated} estimated debits`;
	if (measured > 0) return "provider-reported debit";
	return estimated > 0 ? "estimated debit" : undefined;
}

/**
 * What the receipt stands on, for the expanded view: each additive fact and the comparison, the reference rows it was
 * priced from, each declared fee once per pool and period, the period cash, and the sources it was folded from. A
 * session's projection carries no declared fee, which belongs to its pool's period, so it shows no period cash and
 * points at the report that has them.
 */
export function economyEvidence(economy: EconomyProjection, scope: "session" | "period" = "period"): EvidenceRow[] {
	const total = economy.total;
	if (total.contributions === 0 && economy.fees.length === 0) return [];
	const row = (label: string, value: string, note: string | undefined, unknown: boolean): EvidenceRow => [
		label,
		value,
		note,
		unknown,
	];
	const sources = economy.sources;
	return [
		row(
			"extra cost",
			total.display.extra,
			"actual only with a provider or statement assertion",
			economyTotalUnknown(total.marginalCharge),
		),
		...(totalFed(total.providerCharge)
			? [row("provider charge", total.display.providerCharge, undefined, economyTotalUnknown(total.providerCharge))]
			: []),
		...(totalFed(total.seatCredits)
			? [
					row(
						"seat credits",
						total.display.seatCredits,
						seatCreditsNote(total.seatCredits),
						economyTotalUnknown(total.seatCredits),
					),
				]
			: []),
		...(totalFed(total.apiEquivalent)
			? [
					row(
						"API equivalent",
						renderUnitTotal(total.apiEquivalent),
						"public list price, never cash",
						economyTotalUnknown(total.apiEquivalent),
					),
				]
			: []),
		...economy.references.map((reference) =>
			row(
				"priced from",
				`${reference.referenceRowId} as of ${reference.asOf}`,
				`${reference.basis} ${GLYPH.sep} ${reference.contributions} ${reference.contributions === 1 ? "call" : "calls"}`,
				false,
			),
		),
		...(totalFed(total.energyKwh)
			? [
					row(
						"electricity",
						total.display.energy,
						undefined,
						economyTotalUnknown(total.energyKwh) || economyTotalUnknown(total.energyCost),
					),
				]
			: []),
		...economy.fees.map((fee) =>
			row(
				"fee",
				fee.display,
				`pool ${fee.poolId} ${GLYPH.sep} from ${fee.period.start.slice(0, 10)} ${GLYPH.sep} paid by ${fee.payer} ${GLYPH.sep} once per period`,
				fee.payer === "unknown",
			),
		),
		scope === "session" && economy.fees.length === 0
			? row("declared fees", "per pool and period", "pancode usage report lists each once", false)
			: row(
					"period cash",
					economy.cash.display,
					"personal fees, extra charges, electricity",
					economy.cash.unknownCount > 0,
				),
		row(
			"sources",
			[
				`${sources.attempts} ${sources.attempts === 1 ? "call" : "calls"}`,
				`${sources.runs} ${sources.runs === 1 ? "run" : "runs"}`,
				...(sources.gaps > 0 ? [`${sources.gaps} unreadable`] : []),
			].join(` ${GLYPH.sep} `),
			undefined,
			sources.gaps > 0,
		),
	];
}
