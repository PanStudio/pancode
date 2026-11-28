// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * Assistant text as transcript rows: Markdown layout, table fit, fences and code wrap, and the streaming split of a
 * reply into a settled head rendered once per width and an open tail re-lexed per delta (#428).
 */
import { performance } from "node:perf_hooks";
import { AssistantProseProjection, sanitizeAssistantProse } from "../core/assistant-prose.js";
import { MARKER } from "../core/glyphs.js";
import { escapeTerminalControls } from "../core/terminal-controls.js";
import {
	COPY_JOIN_MARK,
	COPY_TIGHT_MARK,
	copyMark,
	Markdown,
	Marked,
	stripTerminalSequences,
	type Tokens,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import {
	RedactedStringProjection,
	redactStreamingUrlCredentials,
	redactUrlCredentials,
} from "../lib/secrets/redaction.js";
import { SECONDARY } from "./chat-ink.js";
import type { OpenFence, RowMemo, SettledBlocks, TextSegment } from "./chat-transcript-model.js";
import { keepRows, keptRows } from "./kept-rows.js";
import { type CodeInkCarry, codeInk, codeInkLexer } from "./renderers/code-ink.js";
import { holdInlineMath, mathFenceAfter } from "./renderers/inline-math.js";
import { settledMarkdownHead } from "./renderers/markdown-blocks.js";
import { createMermaidMarkdownTransform } from "./renderers/mermaid.js";
import { GLYPH, markdownTheme, pancodeTheme, SGR_RESET, wrapPaths } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

// Every fenced code block, top level or nested in a list or quote, reaches the
// screen through pi-tui's Markdown component, which exposes the
// MarkdownTheme.highlightCode hook: it hands over the raw fence text plus the
// fence's whole info string before pi-tui draws the fence borders and indent.
// Wiring code ink through that hook colors only the ink, and nothing
// post-processes already-rendered output. codeInk matches the language word
// only, so the hook drops the rest of an info string such as `ts title="a.ts"`.
// Pi wraps every rendered row at its spaces, so a long code line came back as
// pieces that dropped the space at each break and could not be rejoined
// exactly. Code ink leaves Pi with no space to break at: each space travels as
// CODE_SPACE, Pi can only cut a long line at full width without dropping
// anything, and `markdownRows` rejoins the pieces, restores the spaces and
// wraps the source line once under its continuation mark. The blank braille
// pattern is one column wide and is not whitespace to Pi's tokenizer.
// The block indent opens with CODE_LINE, a noncharacter that marks where each
// source line starts, so a piece Pi cut off is never mistaken for a new line.
const CODE_SPACE = MARKER.codeSpace;
const CODE_LINE = MARKER.codeLine;
const inkLang = (lang: string | undefined): string | undefined => lang?.trim().split(/\s+/u, 1)[0];
const BASE_MARKDOWN_THEME = markdownTheme(pancodeTheme(), (code, lang) =>
	codeInk(inkLang(lang), code.split("\n")).map((line) => line.replaceAll(" ", CODE_SPACE)),
);
const CHAT_MARKDOWN_THEME = {
	...BASE_MARKDOWN_THEME,
	codeBlockIndent: `${CODE_LINE}${CODE_SPACE}`,
};
// /export writes plain text inside its own fence, so Pi's top-level fence rows
// are noise there and widen that outer fence. Pi gives no switch for them, so
// the export panel's theme tags every fence row it draws with a Unicode
// noncharacter, which valid text never carries, and `exportFenceRow` resolves
// the tags row by row.
const EXPORT_FENCE_MARK = MARKER.exportFence;
const EXPORT_MARKDOWN_THEME = {
	...CHAT_MARKDOWN_THEME,
	codeBlockBorder: (text: string) => `${EXPORT_FENCE_MARK}${CHAT_MARKDOWN_THEME.codeBlockBorder(text)}`,
};
const mermaidTransform = createMermaidMarkdownTransform(pancodeTheme());
const CHAT_MARKDOWN_OPTIONS = {
	transform: (source: string, width: number) => {
		const text = holdInlineMath(source, CODE_SPACE);
		// Both transforms need a lex of the whole answer, so each runs only when the text can use it.
		if (!mayNeedTableFit(text, width)) return /mermaid/iu.test(text) ? mermaidTransform(text, width) : text;
		const tokens = tableParser.lexer(text);
		const fitted = fitMarkdownTables(tokens, width);
		if (!/mermaid/iu.test(fitted.text)) return fitted.text;
		// A rewritten table can change how the text after it parses, so those tokens no longer describe it.
		return mermaidTransform(fitted.text, width, fitted.rewritten ? undefined : tokens);
	},
	renderLatex: true,
} as const;

/**
 * A denoising frame renders in two tones: settled text as it is, the unresolved
 * remainder dim. Frames are few (Mercury settles a block in two or three) and
 * each one rewrites arbitrary positions, so nothing here is cached.
 */
function renderDiffusionFrameLines(seg: TextSegment, settled: number, width: number): string[] {
	// A frame rewrites arbitrary positions, so redaction can move what follows the settled mark. The two tones split where the
	// redacted texts stop agreeing (#446).
	const source = redactStreamingUrlCredentials(escapeTerminalControls(sanitizeAssistantProse(seg.text)));
	const settledText = redactStreamingUrlCredentials(
		escapeTerminalControls(sanitizeAssistantProse(seg.text.slice(0, settled))),
	);
	let shared = 0;
	while (shared < settledText.length && source.charCodeAt(shared) === settledText.charCodeAt(shared)) shared += 1;
	const head = source.slice(0, shared);
	const tail = source.slice(shared);
	const lines: string[] = [];
	const headLines = head.split("\n");
	const tailLines = tail.split("\n");
	// The line the boundary falls on carries both tones.
	const joinLine = `${headLines[headLines.length - 1] ?? ""}${tail.length > 0 ? `${SECONDARY()}${tailLines[0] ?? ""}${SGR_RESET}` : ""}`;
	for (let i = 0; i < headLines.length - 1; i += 1) {
		for (const line of wrapTextWithAnsi(headLines[i] ?? "", width)) lines.push(line);
	}
	for (const line of wrapTextWithAnsi(joinLine, width)) lines.push(line);
	for (let i = 1; i < tailLines.length; i += 1) {
		for (const line of wrapTextWithAnsi(`${SECONDARY()}${tailLines[i] ?? ""}${SGR_RESET}`, width)) lines.push(line);
	}
	return lines.map((line) => pancodeTheme().base("assistantProse", line));
}

// Lexer for fitMarkdownTables, which runs inside Markdown's transform hook.
const tableParser = new Marked();

// Marked's GFM delimiter row. A table has exactly as many columns as this row, so it alone decides the width test.
const TABLE_DELIMITER_ROW = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)$/gmu;

/** Keep Pi's wrapped cells unless borders leave fewer than 12 columns per field. */
function tableFitsWidth(columns: number, width: number): boolean {
	return width >= columns * 15 + 1;
}

/**
 * Whether the grid still reads at this width: every field keeps 12 columns, and the cells' natural widths come
 * to under 1.75 times the room the borders leave. Past that the long fields wrap into tall columns of two or three
 * words a row (an 80-column summary drew a six-row cell per record), and records read better.
 */
function tableGridReads(table: Tokens.Table, width: number): boolean {
	const columns = table.header.length;
	if (!tableFitsWidth(columns, width)) return false;
	const room = width - (columns * 3 + 1);
	let natural = 0;
	for (let index = 0; index < columns; index += 1) {
		let widest = visibleWidth(table.header[index]?.text ?? "");
		for (const row of table.rows) widest = Math.max(widest, visibleWidth(row[index]?.text ?? ""));
		natural += widest;
	}
	return natural <= room * 1.75;
}

/** Whether a lex could find a table to rewrite. A false positive costs one lex; a false negative would keep a table. */
function mayNeedTableFit(text: string, width: number): boolean {
	if (!text.includes("|")) return false;
	// A lex also removes a repeated link definition, which closes up the blank rows around it, so keep it for those.
	const definition = text.indexOf("]:");
	if (definition >= 0 && text.includes("]:", definition + 2)) return true;
	for (const match of text.matchAll(TABLE_DELIMITER_ROW)) {
		const row = match[1] ?? "";
		if (!/[:|]/u.test(row)) continue;
		if (!tableMayRead(text, match.index, row, width)) return true;
	}
	return false;
}

/**
 * Whether the table at this delimiter row surely reads as a grid, judged from its source lines without a lex.
 * Each column's widest raw cell is at least what the lexed cell measures, and the rows are taken up to the next
 * blank line, which is never fewer than Marked takes, so a table this passes also passes tableGridReads.
 * An escaped pipe would shift the split, so a table holding one goes to the lex.
 */
function tableMayRead(text: string, delimiterAt: number, delimiter: string, width: number): boolean {
	const columns = tableCells(delimiter).length;
	if (!tableFitsWidth(columns, width)) return false;
	const headerEnd = delimiterAt - 1;
	if (headerEnd < 0) return false;
	const header = text.slice(text.lastIndexOf("\n", headerEnd - 1) + 1, headerEnd);
	const widest = new Array<number>(columns).fill(0);
	const measure = (line: string): boolean => {
		if (line.includes("\\|")) return false;
		const cells = tableCells(line);
		for (let index = 0; index < columns; index += 1)
			widest[index] = Math.max(widest[index] ?? 0, visibleWidth(cells[index] ?? ""));
		return true;
	};
	if (!measure(header)) return false;
	let start = text.indexOf("\n", delimiterAt);
	while (start >= 0) {
		const end = text.indexOf("\n", start + 1);
		const line = text.slice(start + 1, end < 0 ? undefined : end);
		if (line.trim() === "") break;
		if (!measure(line)) return false;
		start = end;
	}
	const room = width - (columns * 3 + 1);
	return widest.reduce((sum, cell) => sum + cell, 0) <= room * 1.75;
}

/** A table row's cells as Marked splits them: outer pipes dropped, each field trimmed. */
function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\||\|$/gu, "")
		.split("|")
		.map((cell) => cell.trim());
}

function fitMarkdownTables(tokens: readonly Tokens.Generic[], width: number): { text: string; rewritten: boolean } {
	let rewritten = false;
	const text = tokens
		.map((token) => {
			if (token.type !== "table") return token.raw;
			const table = token as Tokens.Table;
			if (tableGridReads(table, width) || table.rows.length === 0) {
				return token.raw;
			}
			rewritten = true;
			// Each row becomes one compact record: its first field in bold names it,
			// the other fields follow on hard line breaks, and a blank line parts records.
			return `${table.rows
				.map((row) =>
					row
						.map((cell, index) => {
							const label = table.header[index]?.text.trim() ?? "";
							if (index === 0) return label ? `**${label}: ${cell.text}**` : `**${cell.text}**`;
							return label ? `**${label}:** ${cell.text}` : cell.text;
						})
						.join("\\\n"),
				)
				.join("\n\n")}\n\n`;
		})
		.join("");
	return { text, rewritten };
}

function chatMarkdown(text: string, bareFences: boolean): Markdown {
	return new Markdown(
		text,
		0,
		0,
		bareFences ? EXPORT_MARKDOWN_THEME : CHAT_MARKDOWN_THEME,
		undefined,
		CHAT_MARKDOWN_OPTIONS,
	);
}

/**
 * One row of an export panel's Markdown, with its fence tags resolved. A fence
 * at the top level starts its row with the tag: the opening row becomes the
 * language word as a quiet label and every other fence row is dropped, which is
 * how the export drew a code block before Pi's fence rows reached the transcript.
 * A fence nested in a list or quote carries that block's indent ahead of the
 * tag and keeps Pi's literal row, as it always did.
 */
function exportFenceRow(row: string): string | null {
	const tagAt = row.indexOf(EXPORT_FENCE_MARK);
	if (tagAt < 0) return row;
	if (tagAt > 0) return row.replace(EXPORT_FENCE_MARK, "");
	const lang = stripTerminalSequences(row)
		.slice(EXPORT_FENCE_MARK.length + 3)
		.trim()
		.split(/\s+/u, 1)[0];
	return lang ? pancodeTheme().fg("annotation", lang) : null;
}

/**
 * pi-tui Markdown right-pads every row to the render width, while transcript
 * rows are unpadded for hangProseLines. The padding is trimmed before the
 * width check because wrapping or truncating a padded row costs far more per
 * frame than the same row trimmed first. The regex keeps a trailing no-break
 * space, which Mermaid rows use.
 */
function fitMarkdownRow(padded: string, width: number, bareFences: boolean): string[] {
	// A fence nested in a quote is not rejoined, so its code row still carries CODE_SPACE.
	const trimmed = padded.replace(/ +$/u, "").replace(CODE_LINE, " ").replaceAll(CODE_SPACE, " ");
	const line = bareFences ? exportFenceRow(trimmed) : trimmed;
	if (line === null) return [];
	const parts = visibleWidth(line) > width ? wrapTextWithAnsi(line, width) : [line];
	return parts.map((part) =>
		pancodeTheme().base("assistantProse", visibleWidth(part) > width ? truncateToWidth(part, width, "") : part),
	);
}

/** A fence row as Pi draws it, export-tagged or not; a list or a quote nests it behind its own indent. */
const FENCE_ROW = /^( *)\uFDD0?```/u;

/**
 * The opening fence as a quiet `╌╌ python` label in the supporting role, at the fence's own indent. A fence that names
 * no language, or names `text`, says nothing a reader needs, so it draws no label row (null).
 */
function fenceLabelRow(plain: string, fenceEnd: number, indent: string): string | null {
	const lang = plain.slice(fenceEnd).trim().split(/\s+/u, 1)[0] ?? "";
	if (lang.length === 0 || lang.toLowerCase() === "text") return null;
	return `${indent}${pancodeTheme().fg("annotation", `${GLYPH.innerDivider}${GLYPH.innerDivider} ${lang}`)}`;
}

/**
 * One source line of a fenced code block, rejoined from the pieces Pi cut it
 * into. A line that fits prints as it is; a longer one wraps once at its spaces,
 * and each wrapped piece keeps the block's indent behind a mark that says it
 * continues the line above, so it never reads as prose or a separate statement.
 * With `marks`, each row opens with a copy mark (#453): the block's indent and
 * the `↪` are decoration, and a wrapped piece joins the one above it with the
 * space the wrap consumed, or with nothing when the wrap broke inside a token.
 */
function fitCodeLine(line: string, fenceIndent: string, width: number, bareFences: boolean, marks = false): string[] {
	const theme = pancodeTheme();
	const text = line.replace(CODE_LINE, " ").replaceAll(CODE_SPACE, " ").replace(/ +$/u, "");
	const lead = `${fenceIndent}  `;
	if (visibleWidth(text) <= width) {
		const row = theme.base("assistantProse", text);
		if (!marks) return [row];
		const plain = stripTerminalSequences(text);
		return [`${copyMark("row", Math.min(lead.length, plain.length - plain.trimStart().length))}${row}`];
	}
	const body = text.startsWith(lead) ? text.slice(lead.length) : text.replace(/^ +/u, "");
	const mark = bareFences ? lead : `${lead}${theme.fg("annotation", GLYPH.codeWrap)} `;
	const room = Math.max(1, width - visibleWidth(mark));
	const parts = wrapPaths(body, room);
	const rows = parts.map((part, index) => theme.base("assistantProse", `${index === 0 ? lead : mark}${part}`));
	if (!marks) return rows;
	const source = stripTerminalSequences(body);
	const markWidth = visibleWidth(mark);
	let at = 0;
	return rows.map((row, index) => {
		const piece = stripTerminalSequences(parts[index] ?? "");
		const found = source.indexOf(piece, at);
		const spaced = found !== at;
		at = found < 0 ? at : found + piece.length;
		if (index === 0) return `${copyMark("row", visibleWidth(lead))}${row}`;
		return `${copyMark(spaced ? "join" : "tight", markWidth)}${row}`;
	});
}

/** A list bullet as Pi draws it at the start of an item's first row. */
const LIST_BULLET = /^(?:[-*+]|\d{1,9}[.)]) /u;
/** Table, quote and rule rows start with box drawing, and their rows never join. */
const BOX_ROW = /^[\u2500-\u259F]/u;
/** The letters Pi's wrap takes one at a time, so it can break between two of them with no space in the source. */
const CJK_BREAK =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
/** Hangul separates words with spaces, so a break beside it says nothing about whether one sat there. */
const HANGUL = /\p{Script_Extensions=Hangul}/u;
/** CJK and fullwidth punctuation, which sits against the letters around it with no space. */
const FULLWIDTH_PUNCTUATION = /[\u3000-\u303F\uFF00-\uFFEF]/u;
const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/]/gu;

/** The text a run of rows was wrapped from, and how far the rows above have read into it. */
interface WrapSource {
	readonly text: string;
	at: number;
}

/**
 * Whether the source held whitespace where Pi broke between `aboveText` and `text`, read from the next place past the
 * last break where the end of one meets the start of the other; undefined when the source does not hold them, as
 * where inline Markdown sits at the break.
 */
function spacedInSource(source: WrapSource, aboveText: string, text: string): boolean | undefined {
	const literal = (part: string): string => part.replace(REGEXP_SYNTAX, "\\$&");
	const tail = Array.from(aboveText.trimEnd()).slice(-4).join("");
	const head = Array.from(text).slice(0, 4).join("");
	const seam = new RegExp(`${literal(tail)}(\\s*)${literal(head)}`, "gu");
	seam.lastIndex = source.at;
	const found = seam.exec(source.text);
	if (found === null) return undefined;
	source.at = found.index + tail.length;
	return (found[1] ?? "").length > 0;
}

/** Pi's next token: one CJK letter, or the run up to a space or a CJK letter. */
function firstToken(text: string): string {
	let token = "";
	for (const char of text) {
		if (char === " " || (token.length > 0 && CJK_BREAK.test(char))) break;
		token += char;
		if (CJK_BREAK.test(char)) break;
	}
	return token;
}

/**
 * How a prose row joins the row above it when fullscreen copies a selection (#453): as a wrapped continuation of the
 * same paragraph or list item, as the rest of a word too long for one row, or not at all. `above` and `row` are plain
 * text. Pi wraps greedily, so a row continues the one above only when it starts at the column the text above starts
 * at, past a bullet, and its first word would not have fit on the row above. Pi also breaks beside any CJK letter with
 * no space, and there the rows alone cannot tell whether the wrap consumed one, so `source` decides when it can.
 */
export function continuationMark(above: string | null, row: string, width: number, source?: WrapSource): string {
	if (above === null) return "";
	const lead = row.length - row.trimStart().length;
	const text = row.slice(lead);
	const aboveLead = above.length - above.trimStart().length;
	const aboveText = above.slice(aboveLead);
	if (text.length === 0 || aboveText.length === 0) return "";
	if (LIST_BULLET.test(text) || BOX_ROW.test(text) || BOX_ROW.test(aboveText)) return "";
	const bullet = LIST_BULLET.exec(aboveText)?.[0].length ?? 0;
	if (lead !== aboveLead + bullet) return "";
	const fromSource = (): string | undefined => {
		const spaced = source === undefined ? undefined : spacedInSource(source, aboveText, text);
		return spaced === undefined ? undefined : spaced ? COPY_JOIN_MARK : COPY_TIGHT_MARK;
	};
	const aboveWidth = visibleWidth(above);
	if (aboveWidth >= width && !/\s/u.test(aboveText.slice(bullet))) return fromSource() ?? COPY_TIGHT_MARK;
	// Beside a CJK letter the row above ends short of the width when the token below did not fit.
	const last = Array.from(aboveText.trimEnd()).at(-1) ?? "";
	const first = Array.from(text)[0] ?? "";
	if ((CJK_BREAK.test(last) || CJK_BREAK.test(first)) && aboveWidth + visibleWidth(firstToken(text)) > width) {
		const decided = fromSource();
		if (decided !== undefined) return decided;
		const tight = (char: string): boolean =>
			FULLWIDTH_PUNCTUATION.test(char) || (CJK_BREAK.test(char) && !HANGUL.test(char));
		if (tight(last) && tight(first)) return COPY_TIGHT_MARK;
	}
	const word = text.split(" ", 1)[0] ?? "";
	return aboveWidth + 1 + visibleWidth(word) > width ? COPY_JOIN_MARK : "";
}

/**
 * The transcript rows of a Markdown component. `exit`, when given, learns whether the rows end with a fence still
 * open, which a caller that renders a text in pieces needs: the fence state runs on into the next piece. `source`,
 * the Markdown the component holds, settles how copy marks join a row wrapped beside a CJK letter.
 */
function markdownRows(
	md: Markdown,
	width: number,
	bareFences: boolean,
	memo?: RowMemo,
	exit?: { fenceOpen: boolean },
	marks = false,
	source?: string,
): string[] {
	const padded = md.render(width);
	const wrapSource = source === undefined ? undefined : { text: source, at: 0 };
	const rows: string[] = [];
	let fenceIndent: string | null = null;
	// With copy marks, the plain text of the last prose row, which the next row may continue; null past code (#453).
	let above: string | null = null;
	// The code line being rejoined: its first row from Pi, then each piece Pi cut off it.
	let code: string | null = null;
	const codeKeys: string[] = [];
	const plainRow = (row: string): string => {
		let text = memo?.plain.get(row);
		if (text === undefined) {
			text = stripTerminalSequences(row);
			memo?.plain.set(row, text);
		}
		return text;
	};
	const flushCode = (): void => {
		if (code === null) return;
		const key = `\0code${marks ? "\0m" : ""}\0${code}`;
		codeKeys.push(key);
		let parts = memo?.rows.get(key);
		if (parts === undefined) {
			parts = fitCodeLine(code, fenceIndent ?? "", width, bareFences, marks);
			memo?.rows.set(key, parts);
		}
		for (const part of parts) rows.push(part);
		code = null;
	};
	for (const row of padded) {
		const fence = row.includes("```") ? FENCE_ROW.exec(plainRow(row)) : null;
		if (fence !== null || fenceIndent !== null) above = null;
		if (fence !== null) {
			flushCode();
			fenceIndent = fenceIndent === null ? (fence[1] ?? "") : null;
			if (!bareFences) {
				// The reader needs where code starts and what language it is, not the Markdown that said so: the
				// opening fence becomes the language as a quiet label and the closing fence draws nothing.
				const label = fenceIndent === null ? null : fenceLabelRow(plainRow(row), fence[0].length, fenceIndent);
				if (label !== null) rows.push(label);
				continue;
			}
		} else if (fenceIndent !== null) {
			const trimmed = row.replace(/ +$/u, "");
			if (plainRow(row).startsWith(`${fenceIndent}${CODE_LINE}`) || code === null) {
				flushCode();
				code = trimmed;
			} else {
				code += trimmed.replace(/^ +/u, "");
			}
			continue;
		}
		let parts = memo?.rows.get(row);
		if (parts === undefined) {
			parts = fitMarkdownRow(row, width, bareFences);
			memo?.rows.set(row, parts);
		}
		if (!marks) {
			for (const part of parts) rows.push(part);
			continue;
		}
		for (const part of parts) {
			const plain = parts.length === 1 ? plainRow(row).replace(/ +$/u, "") : stripTerminalSequences(part);
			rows.push(continuationMark(above, plain, width, wrapSource) + part);
			above = plain;
		}
	}
	flushCode();
	if (exit !== undefined) exit.fenceOpen = fenceIndent !== null;
	// Each delta strands the old tail rows. Keep the live ones, so eviction never costs a re-measure.
	if (memo !== undefined && memo.rows.size > padded.length * 2 + 256) {
		const live = new Map<string, string[]>();
		for (const key of [...padded, ...codeKeys]) {
			const parts = memo.rows.get(key);
			if (parts !== undefined) live.set(key, parts);
		}
		memo.rows = live;
		const plain = new Map<string, string>();
		for (const key of padded) {
			const text = memo.plain.get(key);
			if (text !== undefined) plain.set(key, text);
		}
		memo.plain = plain;
	}
	return rows;
}

/**
 * A settled text segment renders through one stock Markdown component.
 * Markdown renders each top-level block independently and caches by
 * (text, width), so a regular-screen terminal does not redraw the transcript
 * when the answer finalizes. setText always invalidates that cache, so it runs
 * only when the projected text changed. A streaming segment renders its
 * settled head and open tail apart (`renderSettledSplit`), which yields the
 * same rows.
 */
export function renderTextSegmentLines(seg: TextSegment, width: number, bareFences: boolean, marks = false): string[] {
	if (!seg.finalized && seg.diffusion) {
		return renderDiffusionFrameLines(seg, seg.diffusion.settled, width);
	}
	const epoch = skinEpoch();
	if (seg.rendered?.source !== seg.text || seg.rendered.finalized !== seg.finalized || seg.rendered.epoch !== epoch) {
		seg.rendered = { source: seg.text, finalized: seg.finalized, epoch, layouts: new Map() };
	}
	const key = `${width}|${bareFences}`;
	const cached = seg.rendered.layouts.get(key);
	if (cached !== undefined) return cached;
	const startedAt = seg.finalized ? 0 : performance.now();
	seg.prose ??= new AssistantProseProjection();
	// A per-character map, so it composes with the projection's appends.
	seg.secrets ??= new RedactedStringProjection((text) => redactUrlCredentials(escapeTerminalControls(text)));
	// While text only grows, both projections take just what was appended; neither reads the whole reply (#428).
	const added = seg.unprojected === undefined ? null : seg.prose.append(seg.text, seg.unprojected, seg.finalized);
	if (added === null) seg.secrets.project(seg.prose.project(seg.text, seg.finalized), seg.finalized);
	else seg.secrets.append(seg.prose.projected, added, seg.finalized);
	seg.unprojected = "";
	let memo = seg.rowMemo;
	if (memo?.width !== width || memo.bareFences !== bareFences || memo.epoch !== epoch)
		memo = seg.finalized ? undefined : { width, bareFences, epoch, rows: new Map(), plain: new Map() };
	// A settled segment can last the whole session, so it keeps only its layouts.
	seg.rowMemo = seg.finalized ? undefined : memo;
	let rows =
		seg.settled !== undefined || !seg.finalized ? renderSettledSplit(seg, width, bareFences, memo, marks) : null;
	if (seg.finalized) delete seg.settled;
	if (rows === null) {
		const prose = seg.secrets.textFrom(0);
		if (seg.markdown === undefined || seg.markdown.epoch !== epoch)
			seg.markdown = { view: chatMarkdown(prose, bareFences), source: prose, epoch };
		else if (seg.markdown.source !== prose) {
			seg.markdown.view.setText(prose);
			seg.markdown.source = prose;
		}
		rows = markdownRows(seg.markdown.view, width, bareFences, memo, undefined, marks, prose);
	}
	const lines = withoutLeadingBlanks(rows);
	// Dropping the same leading blanks as last time keeps what the split vouched for, one row per blank fewer.
	const previous = seg.unblanked;
	if (lines !== rows && previous !== undefined && previous.rows !== previous.lines) {
		const dropped = rows.length - lines.length;
		if (previous.rows.length - previous.lines.length === dropped)
			keepRows(lines, previous.lines, keptRows(rows, previous.rows) - dropped);
	}
	if (seg.finalized) delete seg.unblanked;
	else seg.unblanked = { rows, lines };
	if (!seg.finalized) seg.liveRender = { durationMs: performance.now() - startedAt, codeUnits: seg.text.length };
	seg.rendered.layouts.set(key, lines);
	if (seg.rendered.layouts.size > 3) {
		const oldest = seg.rendered.layouts.keys().next().value;
		if (oldest !== undefined) seg.rendered.layouts.delete(oldest);
	}
	return lines;
}

/** Settled blocks render in runs of at least this many code units, so a resize does not build a component per block. */
const SETTLED_RUN_CODE_UNITS = 8_192;

/**
 * The rows of a streaming segment as its settled head, rendered once per
 * width, followed by its open tail (#428). Null when the segment cannot split,
 * and the caller renders the whole text as one component. A finalized segment
 * renders through the split it streamed with one last time, so finalizing
 * re-renders only the tail.
 */
function renderSettledSplit(
	seg: TextSegment,
	width: number,
	bareFences: boolean,
	memo: RowMemo | undefined,
	marks: boolean,
): string[] | null {
	const secrets = seg.secrets;
	if (seg.settled === null || secrets === undefined) return null;
	let settled = seg.settled;
	// The head lies within the redaction's settled text, which only a restart rewrites: a cut-off hold, a
	// diffusion frame or a replaced message. Comparing the head itself would cost a pass over the reply per frame.
	const restarts = secrets.restarts;
	if (settled === undefined || settled.restarts !== restarts)
		settled = { length: 0, pieces: [], cuts: [], spacing: [], restarts, searched: 0 };
	seg.settled = settled;
	// Everything after the head, read from the projection's pieces rather than sliced off the whole prose.
	const from = settled.length;
	let region = secrets.textFrom(from);
	// A cut needs a line completed since the last search. A reference definition, which always holds `]:`, is
	// looked for on every frame it may be in the tail, since it changes how links in the head resolve.
	// An open fence holds no cut, and searching it would lex the whole fence again on every line.
	const fence = openFence(settled, region);
	if (fence === null && (region.indexOf("\n", Math.max(0, settled.searched - from)) >= 0 || region.includes("]:"))) {
		settled.searched = from + region.length;
		const limit = secrets.settledLength - from;
		const head = limit > 0 ? settledMarkdownHead(region, CODE_SPACE, limit) : { length: 0, spacing: false };
		if (head === null) {
			seg.settled = null;
			return null;
		}
		if (head.length > 0) {
			settled.pieces.push(region.slice(0, head.length));
			settled.length = from + head.length;
			settled.cuts.push(settled.length);
			settled.spacing.push(head.spacing);
			region = region.slice(head.length);
		}
	}
	const epoch = skinEpoch();
	let layout = settled.layout;
	if (layout?.width !== width || layout.bareFences !== bareFences || layout.epoch !== epoch) {
		layout = { width, bareFences, epoch, rows: [], through: 0 };
		settled.layout = layout;
	}
	const last = settled.cuts.length - 1;
	let runStart = -1;
	for (let index = 0; index <= last; index += 1) {
		const cut = settled.cuts[index] ?? 0;
		if (cut <= layout.through) continue;
		if (runStart < 0) runStart = index;
		if (cut - layout.through < SETTLED_RUN_CODE_UNITS && index !== last) continue;
		const exit = { fenceOpen: false };
		// A run that ends where the next block follows with no blank line draws the spacing row the whole would.
		const run = settled.pieces.slice(runStart, index + 1).join("") + (settled.spacing[index] ? "\n" : "");
		const rows = markdownRows(chatMarkdown(run, bareFences), width, bareFences, undefined, exit, marks, run);
		// The transcript's fence tracking misread a row as a fence and would carry it into the next run.
		if (exit.fenceOpen) {
			seg.settled = null;
			return null;
		}
		for (const row of rows) layout.rows.push(row);
		layout.through = cut;
		runStart = -1;
	}
	const fenceRows = fence === null ? null : openFenceRows(fence, region, width, bareFences, epoch, memo);
	let rows: string[];
	if (fenceRows !== null && fence?.layout !== undefined) {
		rows = layout.rows.concat(fence.layout.rows, fenceRows);
	} else {
		let tail = settled.tail;
		if (tail === undefined || tail.epoch !== epoch || tail.bareFences !== bareFences) {
			tail = { view: chatMarkdown(region, bareFences), source: region, epoch, bareFences };
			settled.tail = tail;
		} else if (tail.source !== region) {
			tail.view.setText(region);
			tail.source = region;
		}
		rows = layout.rows.concat(markdownRows(tail.view, width, bareFences, memo, undefined, marks, region));
	}
	// A layout's head rows only grow, and so do an open fence's settled rows, so every such row the last frame
	// returned still leads in place.
	const fenceLayout = fenceRows === null ? undefined : fence?.layout;
	const returned = settled.returned;
	if (returned?.layout === layout) {
		const held = returned.fence !== undefined && returned.fence === fenceLayout ? returned.fenceRows : 0;
		keepRows(rows, returned.rows, returned.headRows + held);
	}
	settled.returned = {
		layout,
		fence: fenceLayout,
		rows,
		headRows: layout.rows.length,
		fenceRows: fenceLayout?.rows.length ?? 0,
	};
	return rows;
}

/**
 * A fence's opening line at the very start of a tail, by marked's fence rule: at most three spaces, a marker, then
 * an info string that holds no backtick after a backtick marker. A carriage return leaves the tail to the whole view.
 */
const FENCE_OPENER = /^ {0,3}(`{3,}(?=[^`\r\n]*\n)|~{3,})([^\r\n]*)\n/u;
// Marked unescapes backslash-escaped punctuation in the info string it hands on as the fence's language.
const INFO_ESCAPE = /\\([\p{P}\p{S}])/gu;

/**
 * The tail as one fenced code block still open at the top level, or null. A tail starts at a top-level block
 * boundary, so a marker opening its first line opens a top-level fence. Each line is searched for a closing fence
 * once, as it completes.
 */
function openFence(settled: SettledBlocks, region: string): OpenFence | null {
	let found = settled.fence;
	if (found?.at !== settled.length) {
		const opener = FENCE_OPENER.exec(region);
		// Until its first line completes, the tail may still open with anything.
		if (opener === null && region.indexOf("\n") < 0) return null;
		const lang = opener === null ? undefined : inkLang(opener[2]?.trim().replace(INFO_ESCAPE, "$1"));
		// A Mermaid fence becomes a diagram drawn from its whole source.
		const open =
			opener === null || lang?.toLowerCase() === "mermaid"
				? null
				: {
						opener: opener[0].slice(0, -1),
						marker: opener[1] ?? "```",
						scanned: opener[0].length,
						lexer: codeInkLexer(lang),
						mathFence: mathFenceAfter(opener[0].slice(0, -1), null),
						mathDrift: false,
					};
		found = { at: settled.length, open };
		settled.fence = found;
	}
	const open = found.open;
	if (open === null) return null;
	for (let end = region.indexOf("\n", open.scanned); end >= 0; end = region.indexOf("\n", open.scanned)) {
		const line = region.slice(open.scanned, end);
		open.scanned = end + 1;
		// Marked reads a carriage return as a line end of its own, which the pieces here do not cut at.
		if (line.includes("\r") || closesFence(line, open.marker)) {
			found.open = null;
			return null;
		}
		if (mathFenceAfter(line, open.mathFence) !== open.mathFence) open.mathDrift = true;
	}
	if (open.mathDrift && region.includes("$")) {
		found.open = null;
		return null;
	}
	return open;
}

/**
 * Whether `line` closes a fence opened with `marker`, as marked reads it once Pi turns each tab into three spaces:
 * at most three spaces, the marker itself, any more marker characters of either kind, then spaces.
 */
function closesFence(line: string, marker: string): boolean {
	const plain = line.replaceAll("\t", "   ");
	let at = 0;
	while (at < 3 && plain.charCodeAt(at) === 32) at += 1;
	return plain.startsWith(marker, at) && /^[`~]* *$/u.test(plain.slice(at + marker.length));
}

/** Whether Pi trims `line` as a closing fence still being typed when it ends a code block opened with `marker`. */
function trimmedAsCloser(line: string, marker: string): boolean {
	return line.length > 0 && line.length < marker.length && line === marker.charAt(0).repeat(line.length);
}

/** A fence's code drawn from `carry`: the lexer state the lines above it leave. */
function fenceMarkdown(text: string, bareFences: boolean, open: OpenFence, carry: CodeInkCarry | undefined): Markdown {
	const theme = bareFences ? EXPORT_MARKDOWN_THEME : CHAT_MARKDOWN_THEME;
	const lexer = open.lexer;
	if (lexer === null || carry === undefined) return new Markdown(text, 0, 0, theme, undefined, CHAT_MARKDOWN_OPTIONS);
	const highlightCode = (code: string): string[] =>
		lexer.ink(code.split("\n"), carry).map((line) => line.replaceAll(" ", CODE_SPACE));
	return new Markdown(text, 0, 0, { ...theme, highlightCode }, undefined, CHAT_MARKDOWN_OPTIONS);
}

/**
 * The rows of an open fence's line still open, after its complete lines are rendered into `open.layout`. Null when
 * this frame must render the whole tail: a width too narrow to count the opening line's rows, or a last line that
 * may close the fence or that Pi trims as a partial closing fence.
 */
function openFenceRows(
	open: OpenFence,
	region: string,
	width: number,
	bareFences: boolean,
	epoch: number,
	memo: RowMemo | undefined,
): string[] | null {
	if (width < 8) return null;
	const lineStart = region.lastIndexOf("\n") + 1;
	const openLine = region.slice(lineStart);
	if (openLine.includes("\r") || /^ {0,3}[`~]/u.test(openLine.replaceAll("\t", "   "))) return null;
	let layout = open.layout;
	if (layout?.width !== width || layout.bareFences !== bareFences || layout.epoch !== epoch) {
		// The opening line and one short code line draw the opening line's rows and one more.
		const rows = markdownRows(chatMarkdown(`${open.opener}\nx`, bareFences), width, bareFences);
		const header = rows.length - 1;
		const start = open.opener.length + 1;
		layout = { width, bareFences, epoch, header, rows: rows.slice(0, header), through: start, carry: open.lexer?.start };
		open.layout = layout;
	}
	// Lines settle through the last complete line that is neither blank, since Pi drops a fence's trailing line end,
	// nor trimmed as a closing fence being typed, which Pi does only to a code block's last line.
	let settleTo = lineStart;
	while (settleTo - 1 > layout.through) {
		const start = Math.max(layout.through, region.lastIndexOf("\n", settleTo - 2) + 1);
		const line = region.slice(start, settleTo - 1);
		if (line !== "" && !trimmedAsCloser(line, open.marker)) break;
		settleTo = start;
	}
	if (settleTo - 1 > layout.through) {
		const code = region.slice(layout.through, settleTo - 1);
		const md = fenceMarkdown(`${open.opener}\n${code}`, bareFences, open, layout.carry);
		const rows = markdownRows(md, width, bareFences);
		for (let index = layout.header; index < rows.length; index += 1) layout.rows.push(rows[index] ?? "");
		const lexer = open.lexer;
		if (lexer !== null && layout.carry !== undefined) {
			let carry = layout.carry;
			for (const line of code.split("\n")) carry = lexer.advance(line, carry);
			layout.carry = carry;
		}
		layout.through = settleTo;
	}
	const rest = region.slice(layout.through);
	if (rest.length === 0) return [];
	return markdownRows(
		fenceMarkdown(`${open.opener}\n${rest}`, bareFences, open, layout.carry),
		width,
		bareFences,
		memo,
	).slice(layout.header);
}

/**
 * Blank lines a model opens its reply with render as blank rows, and the
 * first row of a prose block carries the voice glyph: it landed on an empty
 * row above the answer.
 */
function withoutLeadingBlanks(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length - 1 && (lines[start] ?? "").length === 0) start += 1;
	return start === 0 ? lines : lines.slice(start);
}
