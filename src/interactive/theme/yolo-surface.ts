// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { extractAnsiCode } from "../../engine/tui.js";
import { padAnsi } from "./rules.js";
import {
	type PancodeTheme,
	projectsYolo,
	type SemanticRole,
	SGR_RESET,
	sgrResetsForeground,
	skinEpoch,
	withThemeContext,
} from "./tokens.js";

/** Preserve explicit selection/diff backgrounds and their own text colors. */
function inlineBackgroundAfter(code: string, previous: boolean): boolean {
	const values = code.slice(2, -1).split(";").map(Number);
	let active = previous;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (value === 0 || value === 49) active = false;
		else if ((value !== undefined && value >= 40 && value <= 47) || (value !== undefined && value >= 100 && value <= 107))
			active = true;
		else if (value === 38 || value === 48 || value === 58) {
			if (value === 48) active = true;
			index += values[index + 1] === 2 ? 4 : values[index + 1] === 5 ? 2 : 0;
		}
	}
	return active;
}

/** A static composer surface; cached rows preserve inline colors and explicit backgrounds. */
export function createComposerSurfacePainter(
	theme: PancodeTheme,
	width: number,
	baseRole: SemanticRole = "inputText",
): (line: string) => string {
	const context = theme.context;
	let background = "";
	let foreground = "";
	let paintedEpoch = -1;
	const rows = new Map<string, string>();
	return (line: string): string => {
		if (paintedEpoch !== skinEpoch()) {
			paintedEpoch = skinEpoch();
			rows.clear();
			withThemeContext(context, () => {
				background = projectsYolo(context) ? theme.bg("composerSurface", "").replace(SGR_RESET, "") : "";
				foreground = theme.fgSequence(baseRole);
			});
		}
		if (!foreground && !background) return line;
		const cached = rows.get(line);
		if (cached !== undefined) return cached;
		const fitted = padAnsi(line, width);
		let output = `${background}${foreground}`;
		let inlineBackground = false;
		for (let index = 0; index < fitted.length; ) {
			const ansi = extractAnsiCode(fitted, index);
			if (ansi) {
				const code = ansi.code;
				output += code;
				if (code.startsWith("\u001b[") && code.endsWith("m")) {
					inlineBackground = inlineBackgroundAfter(code, inlineBackground);
					if (sgrResetsForeground(code)) output += foreground;
					if (!inlineBackground) output += background;
				}
				index += ansi.length;
				continue;
			}
			const nextEscape = fitted.indexOf("\u001b", index + 1);
			const end = nextEscape < 0 ? fitted.length : nextEscape;
			output += fitted.slice(index, end);
			index = end;
		}
		const painted = `${output}${SGR_RESET}`;
		if (rows.size >= 64) rows.clear();
		rows.set(line, painted);
		return painted;
	};
}

function resetsBackground(code: string): boolean {
	if (code === SGR_RESET || code === "\u001b[m" || code === "\u001b[49m") return true;
	if (!code.startsWith("\u001b[") || !code.endsWith("m")) return false;
	// Extended colour arguments are skipped: the badge's black `38;2;0;0;0` once read as a reset, and the surface
	// then painted its own background over the badge's green.
	const values = code.slice(2, -1).split(";").map(Number);
	let reset = false;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (value === 0 || value === 49) reset = true;
		else if (value === 38 || value === 48 || value === 58) {
			if (value === 48) reset = false;
			index += values[index + 1] === 2 ? 4 : values[index + 1] === 5 ? 2 : 0;
		} else if (value !== undefined && ((value >= 40 && value <= 47) || (value >= 100 && value <= 107))) reset = false;
	}
	return reset;
}

/**
 * Wrap `theme` so every foreground span painted inside a `raisedSurface` region declares
 * `bg: "raisedSurface"`, engaging `tokens.ts`'s `overOwned` contrast lift on light themes
 * for borders, separators, dividers, and empty meter cells.
 */
export function onRaisedTheme(theme: PancodeTheme): PancodeTheme {
	return {
		...theme,
		fg: (token, text, state) =>
			theme.paint(text, { fg: token, bg: "raisedSurface", ...(state === undefined ? {} : { state }) }),
		style: (token, text, mods = {}) => theme.paint(text, { ...mods, fg: token, bg: "raisedSurface" }),
	};
}

/** Paint a `raisedSurface` span of exact `width` cells (no extra side margin), preserving inline foregrounds. */
export function paintRaisedSurfaceSpan(theme: PancodeTheme, line: string, width: number, ellipsis = ""): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const fitted = padAnsi(line, safeWidth, ellipsis);
	const bg = theme.bg("raisedSurface", "").replace(SGR_RESET, "");
	if (!bg) return fitted;
	let out = bg;
	for (let index = 0; index < fitted.length; ) {
		const ansi = extractAnsiCode(fitted, index);
		if (ansi) {
			out += ansi.code;
			if (resetsBackground(ansi.code)) out += bg;
			index += ansi.length;
			continue;
		}
		const next = fitted.indexOf("\u001b", index + 1);
		const end = next < 0 ? fitted.length : next;
		out += fitted.slice(index, end);
		index = end;
	}
	return `${out}${SGR_RESET}`;
}

/** Paint a full-width `raisedSurface` bar with 1-cell side padding, preserving inline foreground colors across resets. */
export function paintRaisedSurfaceRow(theme: PancodeTheme, inner: string, width: number, ellipsis = ""): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const padded = safeWidth >= 4 ? ` ${padAnsi(inner, safeWidth - 2, ellipsis)} ` : padAnsi(inner, safeWidth, ellipsis);
	return paintRaisedSurfaceSpan(theme, padded, safeWidth, ellipsis);
}
