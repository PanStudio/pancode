// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { GLYPH, pancodeTheme } from "../theme/index.js";

/**
 * Count terminal rows after wrapping, including the inspection hint. A block
 * that nests under a gutter glyph passes the rail its rows carry as `prefix`
 * so the hint sits inside the block instead of reading as a new one.
 */
export function previewRows(
	rows: readonly string[],
	limit: number,
	width: number,
	tail = false,
	prefix = "",
	prefixWidth = 0,
	hiddenWords: (hidden: readonly string[]) => string = (hidden) => `${hidden.length} rows`,
): string[] {
	if (rows.length <= limit) return [...rows];
	if (limit <= 0) return [];
	const count = Math.max(0, limit - 1);
	const hidden = tail ? rows.slice(0, rows.length - count) : rows.slice(count);
	const hint = `${prefix}${pancodeTheme().fg(
		"toolMetadata",
		truncateToWidth(`${GLYPH.ellipsis} ${hiddenWords(hidden)} ${GLYPH.sep} /view`, Math.max(1, width - prefixWidth)),
	)}`;
	return tail ? [hint, ...rows.slice(rows.length - count)] : [...rows.slice(0, count), hint];
}

/**
 * A preview of logical lines, each already wrapped to its rows. It keeps whole
 * lines only, so a wrapped line is never cut between its rows, and the hint
 * counts the lines it holds back rather than rows: `14 lines` over a hidden
 * count of 25 wrapped rows read as a contradiction. A single line taller than
 * the room still shows the rows that fit.
 */
export function previewLines(
	lines: ReadonlyArray<readonly string[]>,
	limit: number,
	width: number,
	tail = false,
	prefix = "",
	prefixWidth = 0,
	pinned?: (index: number) => boolean,
): string[] {
	const total = lines.reduce((sum, line) => sum + line.length, 0);
	if (total <= limit) return lines.flat();
	if (limit <= 0) return [];
	const room = Math.max(0, limit - 1);
	if (tail && pinned !== undefined) {
		const pinnedTail = pinnedTailLines(lines, room, pinned);
		if (pinnedTail !== null)
			return [previewHint(lines.length - pinnedTail.length, true, width, prefix, prefixWidth), ...pinnedTail.flat()];
	}
	const ordered = tail ? [...lines].reverse() : [...lines];
	const kept: Array<readonly string[]> = [];
	let used = 0;
	for (const line of ordered) {
		if (used + line.length > room) break;
		kept.push(line);
		used += line.length;
	}
	const first = ordered[0] ?? [];
	// A line taller than the room shows what fits, and an ellipsis says where its rows were cut.
	const cut = kept.length === 0 && room > 0 ? (tail ? first.slice(-room) : first.slice(0, room)) : [];
	const partial = cut.map((row, index) =>
		index === cut.length - 1 && !tail
			? `${truncateToWidth(row, Math.max(1, width - visibleWidth(GLYPH.ellipsis)), "", false)}${GLYPH.ellipsis}`
			: row,
	);
	const hidden = lines.length - kept.length - (partial.length > 0 ? 1 : 0);
	const hint = previewHint(hidden, tail, width, prefix, prefixWidth);
	const shown = (tail ? kept.reverse() : kept).flat();
	return tail ? [hint, ...partial, ...shown] : [...shown, ...partial, hint];
}

function previewHint(hidden: number, tail: boolean, width: number, prefix: string, prefixWidth: number): string {
	// Only the cut line held back: `0 more lines` read as nothing left to see.
	const words = hidden === 0 ? "full line" : `${hidden} ${tail ? "earlier" : "more"} ${hidden === 1 ? "line" : "lines"}`;
	return `${prefix}${pancodeTheme().fg(
		"toolMetadata",
		truncateToWidth(`${GLYPH.ellipsis} ${words} ${GLYPH.sep} /view`, Math.max(1, width - prefixWidth)),
	)}`;
}

/**
 * A tail preview that keeps the pinned lines first, newest first, then fills what room is left with the last lines,
 * all in their printed order. Null when no pinned line fits or every one already sits in the plain tail.
 */
function pinnedTailLines(
	lines: ReadonlyArray<readonly string[]>,
	room: number,
	pinned: (index: number) => boolean,
): Array<readonly string[]> | null {
	const keep = new Set<number>();
	let used = 0;
	const take = (index: number): void => {
		const size = lines[index]?.length ?? 0;
		if (keep.has(index) || size === 0 || used + size > room) return;
		keep.add(index);
		used += size;
	};
	for (let index = lines.length - 1; index >= 0; index--) if (pinned(index)) take(index);
	if (keep.size === 0) return null;
	for (let index = lines.length - 1; index >= 0; index--) {
		if (keep.has(index)) continue;
		if (used + (lines[index]?.length ?? 0) > room) break;
		take(index);
	}
	// Every kept line is in the plain tail, so pinning changed nothing.
	if ([...keep].every((index) => index >= lines.length - keep.size)) return null;
	return lines.filter((_line, index) => keep.has(index));
}

/** Rows grouped into the logical lines they wrap: a continuation row joins the line above it. */
export function groupWrappedRows(rows: readonly string[], continues: (row: string) => boolean): string[][] {
	const lines: string[][] = [];
	for (const row of rows) {
		const last = lines.at(-1);
		if (last && continues(row)) last.push(row);
		else lines.push([row]);
	}
	return lines;
}

/** Leave room for the composer and action identity in a short terminal. */
export function previewBudget(limit: number, terminalRows = 40): number {
	return Math.min(limit, Math.max(2, Math.floor((terminalRows - 8) / 2)));
}

/**
 * Text a preview shows, before its row budget applies: leading and trailing blank lines removed and each run of blank
 * lines collapsed to one, so no preview opens or closes on an empty row or spends its budget on a gap.
 */
export function tidyPreviewText(text: string): string {
	return text
		.replace(/^(?:[ \t]*\r?\n)+/u, "")
		.replace(/(?:\r?\n[ \t]*)+$/u, "")
		.replace(/\r?\n(?:[ \t]*\r?\n){2,}/gu, "\n\n");
}
