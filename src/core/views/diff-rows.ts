// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The edit diff's grammar, one source for its producer (src/tools/edit-diff.ts), the terminal renderer and the GUI
 * diff card. Pure and browser-safe: the GUI client imports this module directly, so it imports nothing.
 *
 * The producer emits a line-numbered review format, not a unified diff: a sign column (`+`, `-` or a space), the
 * line number right-aligned to the widest number in the file, one space, then the text. An elided run of unchanged
 * lines is a row whose number column is blank and whose text is `...`.
 */

/** Appended on its own line when the engine cuts a diff at its byte backstop. */
export const DIFF_TRUNCATION_MARKER = "… diff truncated (details capped)";
/** Appended by the ACP wire to any string it cuts at its byte cap, `details.diff` included. */
export const WIRE_TRUNCATION_SUFFIX = "…[truncated]";
/** Added to a mutation's result text when either side of the file is too large to diff. */
export const DIFF_SKIPPED_NOTE = "diff skipped because the previous or new file exceeds 1 MiB";
/** Widest diff line the producer keeps; the rest of a longer line is counted, not shown. */
export const MAX_DIFF_LINE_CHARS = 500;

const LINE_CAP = /… \(\+\d+ chars\)$/u;
const REVIEW_ROW = /^([+\- ])( *\d+| +) (.*)$/u;

/** One diff line held to MAX_DIFF_LINE_CHARS, its cut tail named by length. */
export function capDiffLine(text: string): string {
	if (text.length <= MAX_DIFF_LINE_CHARS) return text;
	return `${text.slice(0, MAX_DIFF_LINE_CHARS)}… (+${text.length - MAX_DIFF_LINE_CHARS} chars)`;
}

/** True when the producer cut this line at MAX_DIFF_LINE_CHARS. */
export function isCappedDiffLine(text: string): boolean {
	return LINE_CAP.test(text);
}

export interface ReviewDiffRow {
	readonly sign: "+" | "-" | " ";
	/** The number column as written, padding kept so a gutter can reuse it; all blanks on an elision row. */
	readonly numberField: string;
	readonly text: string;
}

/** One row of the review format, or null for a line that is not one (a note, a truncation marker). */
export function parseReviewDiffRow(line: string): ReviewDiffRow | null {
	const match = REVIEW_ROW.exec(line);
	if (match === null) return null;
	return { sign: match[1] as ReviewDiffRow["sign"], numberField: match[2] ?? "", text: match[3] ?? "" };
}

/** True when the engine or the wire cut the diff short, so it is not the whole change. */
function diffWasCut(diff: string): boolean {
	return diff.endsWith(WIRE_TRUNCATION_SUFFIX) || diff.includes(DIFF_TRUNCATION_MARKER);
}

/**
 * Added and removed line counts of a review-format diff. A diff cut short is partial, so it states nothing rather
 * than a low count, and so does one with no change rows.
 */
export function reviewDiffStat(diff: string): { added: number; removed: number } | null {
	if (diffWasCut(diff)) return null;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		const row = parseReviewDiffRow(line);
		if (row === null || !/\d/u.test(row.numberField)) continue;
		if (row.sign === "+") added += 1;
		else if (row.sign === "-") removed += 1;
	}
	return added + removed > 0 ? { added, removed } : null;
}
