// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { GLYPH } from "./glyphs.js";
import { rule } from "./rules.js";
import type { PancodeTheme } from "./tokens.js";

/**
 * Presentational primitives for the welcome/footer dashboards. These keep raw
 * ANSI inside the theme module: every colored separator, chip, and section tag
 * is produced here so interactive render code only ever composes already-styled
 * strings. Helpers are pure and width-agnostic; callers fit/truncate with the
 * engine helpers after composition.
 */

/**
 * The mark as a tile: the for-all sign in the on-accent ink over the brand green, between two half blocks in that green. Where
 * the theme cannot fill a cell with the brand colour (ASCII, no colour, 16 colours, an unknown background) the three
 * cells stay text in the wordmark ink.
 */
export function brandMark(theme: PancodeTheme): string {
	const [left, initial, right] = [...GLYPH.brand];
	const tile = { fg: "onSelection", bg: "selectionBadge", bold: true } as const;
	if (left !== "▐" || initial === undefined || right === undefined || !theme.sgr(tile).open.includes("48;"))
		return theme.fg("wordmark", GLYPH.brand);
	return `${theme.fg("wordmark", left)}${theme.paint(initial, tile)}${theme.fg("wordmark", right)}`;
}

/** The name as live text: Pan in the brand green, Code in the secondary azure, as the wordmark sets it. */
export function wordmarkName(theme: PancodeTheme): string {
	return `${theme.style("wordmark", "Pan", { bold: true })}${theme.style("wordmarkCode", "Code", { bold: true })}`;
}

/** Quiet structural middot used to separate chips inside a single section. */
export function dotSep(theme: PancodeTheme): string {
	return theme.fg("separator", ` ${GLYPH.dot} `);
}

/** Frame-colored vertical bar used to separate sections on one row. */
export function barSep(theme: PancodeTheme): string {
	return theme.fg("border", ` ${GLYPH.rail} `);
}

/** Machine sections use the stronger harness-heading role. */
export function screenTitle(theme: PancodeTheme, label: string): string {
	return theme.style("heading", label, { bold: true });
}

/** A list-group heading on the section-rule form: `running (1) ─────`, the label bold and a light rule to the edge. */
export function listGroupHeader(theme: PancodeTheme, label: string, width: number): string {
	return rule(theme, width, { left: label, leftToken: "groupHeading" });
}
