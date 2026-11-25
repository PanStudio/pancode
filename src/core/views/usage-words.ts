// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * One way to say measured versus unknown usage on every surface that shows a sum of calls (F4, WO06), in the terminal
 * and in the browser alike.
 *
 * The read model's display carries its coverage clause on every figure (`≥999 (3 calls unknown)`), so a line of five
 * figures said the same gap five times and the honest unknown became noise. Here a figure keeps only its `≥` mark,
 * a figure nothing reported reads `not measured`, and the line states its coverage once, as its last unit:
 * `3 calls had no usage data`.
 *
 * Browser-safe: type-only imports, no Node builtins.
 */

import type { UnitTotal, UnitTotalRefusal } from "../telemetry/economy.js";
import type { Fact, FactSum } from "../telemetry/fact.js";
import { countNoun } from "./count-words.js";

export const USAGE_NOT_MEASURED = "not measured";

/** The read-model quantity shape: a fact or a sum of facts, and its canonical display. */
export interface UsageQuantity {
	fact: Fact<number> | FactSum;
	display: string;
}

const count = (value: number): string => value.toLocaleString("en-US");

/** Whether a quantity's fact is a sum of contributions rather than one fact. */
export function isFactSum(fact: Fact<number> | FactSum): fact is FactSum {
	return !("kind" in fact);
}

/** Calls the quantity had no figure from: a sum's unknown contributions, or one for a single unknown fact. */
export function usageGap(quantity: Pick<UsageQuantity, "fact"> | null | undefined): number {
	if (!quantity) return 0;
	const fact = quantity.fact;
	return isFactSum(fact) ? fact.unknownCount : fact.kind === "unknown" ? 1 : 0;
}

/** Whether nothing behind the quantity reported a figure, so no lower bound exists to show. */
export function usageUnmeasured(quantity: Pick<UsageQuantity, "fact"> | null | undefined): boolean {
	if (!quantity) return true;
	const fact = quantity.fact;
	if (!isFactSum(fact)) return fact.kind === "unknown";
	return fact.unknownCount > 0 && fact.coverage.measured + fact.coverage.estimated === 0;
}

/** A display without its coverage clause, for callers holding only the read model's string. */
export function stripUsageClause(display: string): string {
	const figure = display.replace(/ \([^()]*\bunknown\)$/u, "");
	return /^unknown\b/u.test(figure) ? USAGE_NOT_MEASURED : figure;
}

/**
 * The read model's display where a figure stands alone, its coverage clause kept (`≥999 (3 calls unknown)`), except
 * that a figure nothing reported reads `not measured` rather than `unknown (provider omitted)`.
 */
export function usageDisplay(quantity: UsageQuantity | null | undefined): string {
	return !quantity || usageUnmeasured(quantity) ? USAGE_NOT_MEASURED : quantity.display;
}

/** The figure alone: `≥999` keeps saying it is a lower bound, and a figure nothing reported is `not measured`. */
export function usageFigure(quantity: UsageQuantity | null | undefined): string {
	if (!quantity || usageUnmeasured(quantity)) return USAGE_NOT_MEASURED;
	return stripUsageClause(quantity.display);
}

/**
 * The figure with one mark at most, for a line that states its gaps and estimates once in words: `≥999` still says it
 * is a lower bound, while `≥~999` stacked a second qualifier on every number of the line (E1). The estimate moves to
 * `usageEstimates`, which says it once for the whole line.
 */
export function usageLineFigure(quantity: UsageQuantity | null | undefined): string {
	const figure = usageFigure(quantity);
	if (figure === USAGE_NOT_MEASURED) return figure;
	// A single estimated fact's display names its method in parentheses; the line's estimate clause says it instead.
	return figure.replace(/^(≥?)~/u, "$1").replace(/ \([^()]*\)$/u, "");
}

/** Calls whose figure PanCode estimated because the provider did not report one. */
export function usageEstimatedCalls(quantity: Pick<UsageQuantity, "fact"> | null | undefined): number {
	if (!quantity) return 0;
	const fact = quantity.fact;
	return isFactSum(fact) ? fact.coverage.estimated : fact.kind === "estimated" ? 1 : 0;
}

/** `PanCode estimated usage for 3 calls`, or null when no figure was estimated. Pairs with `usageLineFigure`. */
export function usageEstimates(calls: number, data = "usage"): string | null {
	if (calls <= 0) return null;
	return `PanCode estimated ${data} for ${countNoun(calls, "call")}`;
}

/** A figure that says nothing a reader can use: unmeasured, or a lower bound of zero. */
export function usageSaysNothing(figure: string): boolean {
	return figure === USAGE_NOT_MEASURED || figure === "≥0" || figure === "≥~0";
}

/** `1 call still running`: a call that has not settled yet, so its figures are still to come. */
export function usageStillRunning(running: number): string {
	return `${countNoun(running, "call")} still running`;
}

/** `3 calls had no usage data`, or null when every call reported. The noun names what was missing. */
export function usageCoverage(gap: number, data = "usage data"): string | null {
	if (gap <= 0) return null;
	return `${countNoun(gap, "call")} had no ${data}`;
}

/**
 * The coverage unit for a line of figures: the gap most of them share, then any figure that missed more calls named
 * once after it, so a cache figure most providers never send does not pass for complete beside a small usage gap.
 */
export function usageLineCoverage(
	figures: ReadonlyArray<{ label: string; quantity: UsageQuantity | null | undefined }>,
	data = "usage data",
	running = 0,
): string | null {
	// A call still out has not reported yet, which is not the same as a call that never will.
	const gaps = figures.map((entry) => ({ label: entry.label, gap: Math.max(0, usageGap(entry.quantity) - running) }));
	const base = gaps[0]?.gap ?? 0;
	const wider = gaps.filter((entry) => entry.gap > base && !usageUnmeasured(figureOf(figures, entry.label)));
	const lead = usageCoverage(base, data);
	// `4 no out` read as a stray fragment beside the lead clause; the extra gap is a sentence of its own words.
	const extra = wider.map((entry) => `${count(entry.gap)} had no ${entry.label} figure`);
	if (lead === null && extra.length === 0) return null;
	if (lead === null)
		return wider.map((entry) => `${countNoun(entry.gap, "call")} had no ${entry.label} figure`).join(", ");
	return extra.length > 0 ? `${lead}, ${extra.join(", ")}` : lead;
}

function figureOf(
	figures: ReadonlyArray<{ label: string; quantity: UsageQuantity | null | undefined }>,
	label: string,
): UsageQuantity | null | undefined {
	return figures.find((entry) => entry.label === label)?.quantity;
}

/** `cache read, cache write or reasoning`. */
function listWords(words: ReadonlyArray<string>): string {
	return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/**
 * What a line of token figures leaves out, said once: the kinds no call reported (`no cache read or reasoning data`),
 * then the calls that reported nothing. The first two figures are the amounts every surface shows; the rest are said
 * only when they have something to say. The exit card and /usage read their notes here, so a session's gaps read the
 * same on both (U1, U5).
 */
export function usageLineNotes(
	figures: ReadonlyArray<{ label: string; quantity: UsageQuantity | null | undefined }>,
	running = 0,
): {
	shown: ReadonlyArray<{ label: string; quantity: UsageQuantity | null | undefined }>;
	notes: string[];
} {
	const [input, output, ...optional] = figures;
	const unmeasured = optional.filter((entry) => usageUnmeasured(entry.quantity)).map((entry) => entry.label);
	const shown = optional.filter((entry) => {
		const figure = usageLineFigure(entry.quantity);
		return figure !== "0" && !usageSaysNothing(figure);
	});
	const coverage = usageLineCoverage(
		[input, output, ...shown].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
		"usage data",
		running,
	);
	return {
		shown,
		notes: [
			...(unmeasured.length > 0 ? [`no ${listWords(unmeasured)} data`] : []),
			...(coverage !== null ? [coverage] : []),
			...(running > 0 ? [usageStillRunning(running)] : []),
		],
	};
}

/** A total a surface can state: some contribution measured or estimated it, or it was refused for a reason. */
export function economyTotalKnown(total: UnitTotal | UnitTotalRefusal | FactSum): boolean {
	if ("refused" in total) return true;
	const sum = "sum" in total ? total.sum : total;
	return sum.coverage.measured + sum.coverage.estimated > 0;
}

/** A total with an unknown or refused part, which a surface draws in the neutral unknown tone, never as a fault. */
export function economyTotalUnknown(total: UnitTotal | UnitTotalRefusal | FactSum): boolean {
	if ("refused" in total) return true;
	return ("sum" in total ? total.sum : total).unknownCount > 0;
}

/** The reported number behind a quantity, or null when no part of it was measured or estimated. */
export function usageKnownAmount(quantity: { fact: Fact<number> | FactSum } | null | undefined): number | null {
	if (!quantity) return null;
	const fact = quantity.fact;
	if (isFactSum(fact))
		return fact.coverage.measured + fact.coverage.estimated > 0 ? fact.measured + fact.estimated : null;
	return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : null;
}

/** A session's token quantities by field, as the read model folds its own calls. */
export interface SessionTokenQuantities {
	input: UsageQuantity | null | undefined;
	output: UsageQuantity | null | undefined;
	cacheRead: UsageQuantity | null | undefined;
	cacheWrite: UsageQuantity | null | undefined;
	reasoning: UsageQuantity | null | undefined;
	total: UsageQuantity | null | undefined;
}

/**
 * What a session's token figures leave out, said once: the fields no call reported, the calls with no usage data, the
 * calls still out and the calls PanCode estimated. `/usage` and the GUI usage pane read the same notes here.
 */
export function sessionUsageNotes(tokens: SessionTokenQuantities, running = 0): string[] {
	const { notes } = usageLineNotes(
		[
			{ label: "in", quantity: tokens.input },
			{ label: "out", quantity: tokens.output },
			{ label: "cache read", quantity: tokens.cacheRead },
			{ label: "cache write", quantity: tokens.cacheWrite },
			{ label: "reasoning", quantity: tokens.reasoning },
		],
		running,
	);
	const estimates = usageEstimates(usageEstimatedCalls(tokens.total));
	return [...notes, ...(estimates !== null ? [estimates] : [])];
}
