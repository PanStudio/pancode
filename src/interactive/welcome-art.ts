// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { GLYPH } from "./theme/glyphs.js";
import type { PancodeTheme } from "./theme/tokens.js";
import { paintHex, roleRgb } from "./theme/tokens.js";

/** A font written with `#` for a filled cell, drawn in the mode's full block. */
function inked(font: Record<string, readonly string[]>): Record<string, readonly string[]> {
	return Object.fromEntries(
		Object.entries(font).map(([letter, rows]) => [letter, rows.map((row) => row.replaceAll("#", GLYPH.barFull))]),
	);
}

/** Five-row solid block lettering: two-cell stems, one-cell counters, no shading. `#` is a filled cell. */
const LETTERS: Record<string, readonly string[]> = inked({
	P: ["#### ", "## ##", "#### ", "##   ", "##   "],
	A: [" ### ", "## ##", "#####", "## ##", "## ##"],
	N: ["##  #", "### #", "## ##", "##  #", "##  #"],
	C: [" ####", "##   ", "##   ", "##   ", " ####"],
	O: [" ### ", "## ##", "## ##", "## ##", " ### "],
	D: ["#### ", "## ##", "## ##", "## ##", "#### "],
	E: ["#####", "##   ", "#### ", "##   ", "#####"],
});

const WIDE_LETTERS: Record<string, readonly string[]> = inked({
	P: ["###### ", "##   ##", "###### ", "##     ", "##     "],
	A: [" ###### ", "##    ##", "########", "##    ##", "##    ##"],
	N: ["###   ##", "####  ##", "## ## ##", "##  ####", "##   ###"],
	C: [" ######", "##     ", "##     ", "##     ", " ######"],
	O: [" ###### ", "##    ##", "##    ##", "##    ##", " ###### "],
	D: ["###### ", "##   ##", "##   ##", "##   ##", "###### "],
	E: ["#######", "##     ", "#####  ", "##     ", "#######"],
});
function stacked(font: Record<string, readonly string[]>): string[] {
	const word = (text: string) =>
		Array.from({ length: 5 }, (_, row) => [...text].map((letter) => font[letter]?.[row] ?? "").join(" "));
	const pan = word("PAN");
	const code = word("CODE");
	const width = Math.max(pan[0]?.length ?? 0, code[0]?.length ?? 0);
	const centre = (line: string) => line.padStart(line.length + Math.floor((width - line.length) / 2)).padEnd(width);
	return [...pan.map(centre), " ".repeat(width), ...code.map(centre)];
}

export const WELCOME_WORDMARK = stacked(LETTERS);
export const WELCOME_WORDMARK_WIDE = stacked(WIDE_LETTERS);
/** Rows of the stacked wordmark that spell PAN; a blank row and CODE follow. */
const STACKED_PAN_ROWS = 5;
const BAND_GAP = "   ";
/** Cells of PAN on the one band, before the gap and CODE. */
const BAND_PAN_WIDTH = [..."PAN"].map((letter) => LETTERS[letter]?.[0] ?? "").join(" ").length;
/** The compact letters on one band, PAN then CODE, for panels too narrow to set the art beside the details. */
export const WELCOME_WORDMARK_ROW: readonly string[] = Array.from({ length: 5 }, (_, row) =>
	["PAN", "CODE"].map((text) => [...text].map((letter) => LETTERS[letter]?.[row] ?? "").join(" ")).join(BAND_GAP),
);

type Rgb = readonly [number, number, number];

/** The brand green at 0 and the secondary azure at 1, mixed in RGB so the bridge between them stays a clean teal. */
function rampHex(start: Rgb, end: Rgb, t: number): string {
	return `#${start
		.map((value, channel) =>
			Math.round(value + ((end[channel] ?? value) - value) * t)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/** The one-band mark runs from green PAN at left to azure CODE at right; below truecolor the two words are two flat tones. */
export function paintWelcomeRowWordmark(theme: PancodeTheme): string[] {
	if (theme.depth === "none") return [...WELCOME_WORDMARK_ROW];
	const start = roleRgb(theme, "wordmark");
	const end = roleRgb(theme, "wordmarkCode");
	if (!theme.truecolor || start === null || end === null)
		return WELCOME_WORDMARK_ROW.map(
			(line) =>
				`${theme.fg("wordmark", line.slice(0, BAND_PAN_WIDTH))}${BAND_GAP}${theme.fg("wordmarkCode", line.slice(BAND_PAN_WIDTH + BAND_GAP.length))}`,
		);
	return WELCOME_WORDMARK_ROW.map((line) =>
		[...line]
			.map((glyph, column) =>
				glyph === " "
					? glyph
					: paintHex(glyph, rampHex(start, end, column / Math.max(1, line.length - 1)), { truecolor: true }),
			)
			.join(""),
	);
}

/** One vertical green-to-azure ramp: PAN above, CODE below. Below truecolor the two words are two flat tones. */
export function paintWelcomeWordmark(lines: readonly string[], theme: PancodeTheme): string[] {
	if (theme.depth === "none") return [...lines];
	if (lines === WELCOME_WORDMARK_ROW) return paintWelcomeRowWordmark(theme);
	const start = roleRgb(theme, "wordmark");
	const end = roleRgb(theme, "wordmarkCode");
	return lines.map((line, row) => {
		if (line.trim() === "") return line;
		if (!theme.truecolor || start === null || end === null)
			return theme.fg(row < STACKED_PAN_ROWS ? "wordmark" : "wordmarkCode", line);
		return paintHex(line, rampHex(start, end, row / Math.max(1, lines.length - 1)), { truecolor: true });
	});
}
