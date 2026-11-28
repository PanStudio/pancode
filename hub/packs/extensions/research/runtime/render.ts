// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Money as PanCode renders it, so a campaign's spend and caps read the same as in the rest of PanCode. */

/** The USD amount alone, with enough digits that a sub-cent call never reads as zero. */
function renderUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value < 0.00000001) return `$${value.toExponential(2)}`;
	const digits = value < 0.01 ? Math.min(8, Math.max(4, Math.ceil(-Math.log10(value)))) : 2;
	return `$${value.toFixed(digits)}`;
}

/** A configured limit, never spend; a zero limit reads as `$0.00`. */
export function renderUsdLimit(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? renderUsd(value) : "not set";
}

/** A spend, marked as it was priced: estimated parts and unpriced calls stay visible. */
export function renderUsdSpend(usd: number, priced: { estimated: boolean; unpriced: boolean } | undefined): string {
	if (priced?.unpriced === true) return usd > 0 ? `${priced.estimated ? "~" : ""}${renderUsd(usd)} +?` : "not measured";
	if (priced?.estimated === true) return `~${renderUsd(usd)} est`;
	return renderUsd(usd);
}
