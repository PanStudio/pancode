/**
 * The token, cost and column wording the arena shows, in the same words PanCode's own renderer uses for a folded
 * sum. A partial sum is never a total, an unpriced one is never `$0.00`, and an estimate keeps its `~`.
 */

/** A folded sum of facts: measured and estimated parts, and how many contributions were unknown or absent. */
export interface FactSum {
	measured: number;
	estimated: number;
	unknownCount: number;
	absentCount: number;
	coverage: { measured: number; estimated: number; unknown: number };
}

export type FreeRule = "local-native" | "declared" | "zero-rates";

export interface PricingSum {
	usd: FactSum;
	free: boolean;
	freeRule?: FreeRule;
	freeRuleMixed?: boolean;
}

const COUNT_UNITS: ReadonlyArray<{ size: number; suffix: string }> = [
	{ size: 1e3, suffix: "k" },
	{ size: 1e6, suffix: "M" },
	{ size: 1e9, suffix: "G" },
];

/** `881`, `2.4k`, `15.2k`, `272k`, `1.2M`; rounding comes first, so 999.6 is `1.0k`. */
function formatCount(n: number): string {
	if (!Number.isFinite(n)) return "—";
	const sign = n < 0 ? "-" : "";
	const whole = Math.round(Math.abs(n));
	if (whole < 1000) return `${sign}${whole}`;
	for (const [index, unit] of COUNT_UNITS.entries()) {
		const scaled = whole / unit.size;
		const tenths = Math.round(scaled * 10);
		if (tenths < 1000) return `${sign}${(tenths / 10).toFixed(1)}${unit.suffix}`;
		const rounded = Math.round(scaled);
		if (rounded < 1000 || index === COUNT_UNITS.length - 1) return `${sign}${rounded}${unit.suffix}`;
	}
	return `${sign}${whole}`;
}

/** The USD amount alone, with enough digits that a sub-cent call never reads as zero. */
function renderUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value < 0.00000001) return `$${value.toExponential(2)}`;
	const digits = value < 0.01 ? Math.min(8, Math.max(4, Math.ceil(-Math.log10(value)))) : 2;
	return `$${value.toFixed(digits)}`;
}

const NOT_MEASURED = "not measured";

function renderFreeUsd(freeRule: FreeRule | undefined, mixed = false): string {
	if (freeRule === "local-native") return "$0.00 local";
	if (freeRule === "declared") return "$0.00 free (declared)";
	if (freeRule === "zero-rates") return "$0.00 free (zero-rates)";
	return mixed ? "$0.00 free (mixed)" : "$0.00 free";
}

/** Contributions that carry a value or a gap; an absent contribution (a never-sent call) is neither. */
function contributions(sum: FactSum): number {
	return sum.coverage.measured + sum.coverage.estimated + sum.unknownCount;
}

const allAbsent = (sum: FactSum) => contributions(sum) === 0 && sum.absentCount > 0;

/** A token sum in its narrow form (`12.3k`): `~` for an estimate, `≥ +?` for a partial sum, `?` when unknown. */
export function renderCompactCount(sum: FactSum): string {
	if (allAbsent(sum)) return "n/a";
	const known = `${sum.coverage.estimated > 0 ? "~" : ""}${formatCount(sum.measured + sum.estimated)}`;
	if (sum.unknownCount === 0) return known;
	return sum.coverage.measured + sum.coverage.estimated === 0 ? "?" : `≥${known} +?`;
}

/** A folded USD sum; `free` is true when every priced call was a free target's measured zero. */
export function renderUsdSum(sum: FactSum, free: boolean, freeRule?: FreeRule, freeRuleMixed?: boolean): string {
	if (allAbsent(sum)) return "n/a";
	if (contributions(sum) === 0) return NOT_MEASURED;
	const known = sum.measured + sum.estimated;
	const estimated = sum.coverage.estimated > 0;
	const unpriced = sum.unknownCount > 0;
	if (free && !unpriced && !estimated) return renderFreeUsd(freeRule, freeRuleMixed);
	if (unpriced) return known > 0 ? `${estimated ? "~" : ""}${renderUsd(known)} +?` : NOT_MEASURED;
	if (estimated) return `~${renderUsd(known)} est`;
	return renderUsd(known);
}

/** Left-aligned columns two spaces apart; the last column is not padded. */
export function formatColumns(rows: ReadonlyArray<ReadonlyArray<string>>, gap = 2): string {
	if (rows.length === 0) return "";
	const widths: number[] = [];
	for (const row of rows) for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length);
	const line = (row: ReadonlyArray<string>) =>
		row
			.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd((widths[index] ?? cell.length) + gap)))
			.join("")
			.trimEnd();
	return `${rows.map(line).join("\n")}\n`;
}
