// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** Transcript ink and the prose gutter that every chat row renderer shares. */
import { copyMark, truncateToWidth } from "../engine/tui.js";
import { fgSequence, GLYPH, SGR_RESET } from "./theme/index.js";

// TuiAltScreen uses Pi's OSC 133 prompt-start marker for semantic prompt
// navigation. The sequence is zero-width and stripped before terminal output.
export const OSC133_PROMPT_START = "\x1b]133;A\x07";

// Transcript ownership, reading hierarchy, and outcome sequences share the theme resolver.
export const RESET = SGR_RESET;
export const SECONDARY = () => fgSequence("annotation");
export const GUIDANCE = () => fgSequence("guidance");
export const REASON_INK = () => fgSequence("gutter");
export const RED_CRIT = () => fgSequence("error");
export const GREEN_OK = () => fgSequence("success");
export const AMBER_WARN = () => fgSequence("warning");
export const AGENT_GLYPH = GLYPH.agent;
export const USER_BAR = GLYPH.userBar;

export const PROSE_GUTTER = "  ";
export const PROSE_GUTTER_WIDTH = 2;
/** A fullscreen copy mark for a row whose gutter (a glyph and a space, or two spaces) is not copied (#453). */
export const GUTTER_ROW_MARK = copyMark("row", PROSE_GUTTER_WIDTH);

/**
 * Give transcript prose a fixed two-cell ownership gutter. Callers render the
 * content at `width - 2`, then this function spends those reserved cells on
 * either the turn glyph or a hanging indent. Tool ledgers never pass through
 * here, so their existing full-width grammar remains untouched.
 */
export function hangProseLines(lines: string[], firstPrefix?: string): string[] {
	return lines.map((line, index) => `${index === 0 && firstPrefix !== undefined ? firstPrefix : PROSE_GUTTER}${line}`);
}

export function dimLine(text: string, width: number): string {
	return `${SECONDARY()}${truncateToWidth(text, Math.max(1, width), GLYPH.ellipsis, false)}${RESET}`;
}
