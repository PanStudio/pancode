// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The reasoning rail: settled thinking markers and the live thinking stream. */
import { AssistantProseProjection, sanitizeAssistantProse } from "../core/assistant-prose.js";
import { formatCount } from "../core/format-time.js";
import { escapeTerminalControls } from "../core/terminal-controls.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { redactStreamingSecretString } from "../lib/secrets/redaction.js";
import { dimLine, PROSE_GUTTER_WIDTH, REASON_INK, RESET } from "./chat-ink.js";
import { previewRows } from "./renderers/preview.js";
import type { ReasoningUsageView } from "./status/index.js";
import { GLYPH, pancodeTheme, SGR_ITALIC } from "./theme/index.js";

/**
 * Static marker used when thinking is folded. This matches pi-coding-agent's
 * hidden-thinking presentation and avoids previewing reasoning content.
 */
const THINKING_HIDDEN_LABEL = `Thinking ${GLYPH.sep} /view`;
/** Replayed reasoning the target's history dropped: `/view` has nothing to open, so the row offers nothing. */
export const THINKING_NOT_RETAINED_LABEL = `Thinking ${GLYPH.sep} streamed live, not kept`;
/** Reasoning the provider redacted: it sent no text, so `/view` has nothing to open either. */
export const THINKING_PROVIDER_HIDDEN_LABEL = `Thinking ${GLYPH.sep} hidden by provider`;
/** Prose beside a tool call that reached PanCode only as the provider's summary, which the reply then shows. */
export const THINKING_PROVIDER_SUMMARIZED_LABEL = `Thinking ${GLYPH.sep} summarized by provider`;

/**
 * Supplied reasoning owns a quiet structural rail in the gutter, in every style: a
 * folded marker and an excerpt wear the same mark, and no other block uses a
 * gutter rail, so reasoning never reads as tool output. Readable secondary
 * text and italics distinguish the excerpt from the answer.
 */
export const REASON_RAIL = () => `${REASON_INK()}${GLYPH.rail}${RESET} `;

/**
 * A closed thinking stretch's folded marker, in place in the segment order. The
 * turn's count chip rides on the last marker of a settled turn (`view` is
 * unmeasured everywhere else), and comes from the settled usage, never from
 * measuring the excerpt the panel happens to be holding.
 */
export function renderSettledThinkingMarker(view: ReasoningUsageView, width: number): string {
	// The count says how much reasoning the fold holds, `≈` when PanCode estimated it.
	const count =
		view.provenance === "unmeasured" || view.tokens <= 0
			? null
			: `${view.provenance === "provider" ? "" : GLYPH.estimate}${formatCount(view.tokens)} tokens`;
	return `${REASON_RAIL()}${dimLine(
		count === null ? THINKING_HIDDEN_LABEL : `${THINKING_HIDDEN_LABEL} ${GLYPH.sep} ${count}`,
		Math.max(1, width - PROSE_GUTTER_WIDTH),
	)}`;
}

/**
 * Reasoning is markdown (`**Outlining parsing assumptions**` headings), but the
 * rail is already one italic excerpt style, so the markers are dropped rather
 * than rendered (p9/D4). Code spans and glob-like runs (`src/**\/*.ts`) keep
 * their asterisks, and an opener still streaming without its closer is dropped
 * at a line start so the heading does not flicker as the delta lands.
 */
const THINKING_EMPHASIS = /(?<![\p{L}\p{N}_*/\\.])(\*{1,2})(?=[^\s*])([^\n]*?[^\s*\\])\1(?![\p{L}\p{N}*])/gu;
const THINKING_OPEN_BOLD = /^(\s*)\*\*(?=[^\s*])/gmu;

function stripThinkingEmphasis(text: string): string {
	return text
		.split(/(`[^`\n]*`)/u)
		.map((part, index) =>
			index % 2 === 1 ? part : part.replace(THINKING_EMPHASIS, "$2").replace(THINKING_OPEN_BOLD, "$1"),
		)
		.join("");
}

/**
 * A settled excerpt opens on a line of the reasoning, not on the end of one, so it never starts with `remain.)`. A live
 * one keeps its rows, because a stream that has not reached a line start yet would otherwise show less of itself.
 */
function settledExcerptLimit(rows: ReadonlyArray<string>, text: string, limit: number): number {
	const lineStarts = new Set(text.split("\n").map((line) => line.trimStart().slice(0, 12)));
	// A paragraph with no line start in reach opens mid-line whatever the cut, so it keeps the rows it streamed with.
	for (let fitted = limit; fitted > 2 && rows.length > fitted; fitted -= 1) {
		const opening = (rows[rows.length - fitted + 1] ?? "").trimStart().slice(0, 12);
		if (lineStarts.has(opening)) return fitted;
	}
	return limit;
}

// Capitalized like the folded marker it replaces and the footer's phase label, so a turn never shows both forms.
const THINKING_LEAD = `Thinking ${GLYPH.sep} `;
/** A cut excerpt hides the row that opened with the lead, so its hint row carries the lead instead (bt-11 i). */
const THINKING_HINT_PREFIX = () => `${REASON_RAIL()}${pancodeTheme().fg("annotation", THINKING_LEAD)}`;
const THINKING_HINT_PREFIX_WIDTH = PROSE_GUTTER_WIDTH + visibleWidth(THINKING_LEAD);

/** Wrap first, then keep the same tail both while streaming and after settlement. */
export function renderThinkingRail(
	thinking: string,
	width: number,
	limit: number,
	unbounded: boolean,
	open: boolean,
): string[] {
	return renderProseThinkingRail(sanitizeAssistantProse(thinking), width, limit, unbounded, open);
}

/** {@link renderThinkingRail} for reasoning already through {@link sanitizeAssistantProse}. */
function renderProseThinkingRail(
	prose: string,
	width: number,
	limit: number,
	unbounded: boolean,
	open: boolean,
): string[] {
	// Reasoning often ends on a newline; wrapped, that became an empty rail row.
	// Presentation only: the provider's signed reasoning stays untouched.
	const text = stripThinkingEmphasis(redactStreamingSecretString(escapeTerminalControls(prose), !open)).replace(
		/^\s*\n|\s+$/gu,
		"",
	);
	if (text.length === 0) return [];
	// One row before an action costs what the bare marker did, so it carries the last paragraph's opening, where
	// reasoning says the step it takes next.
	if (!unbounded && limit === 1) {
		const last = (text.split(/\n\s*\n/u).at(-1) ?? text).replace(/\s+/gu, " ").trim();
		const row = truncateToWidth(`${THINKING_LEAD}${last}`, Math.max(1, width - PROSE_GUTTER_WIDTH), GLYPH.ellipsis);
		return [styleThinkingRow(row, 0)];
	}
	// A bounded excerpt spends no rows on paragraph breaks; /view keeps them. The excerpt opens with the word
	// that says what it is, because the rail alone is the same mark a tool's output wears.
	const wrapped = wrapTextWithAnsi(`${THINKING_LEAD}${text}`, Math.max(1, width - PROSE_GUTTER_WIDTH));
	const kept = unbounded ? wrapped : wrapped.filter((row) => row.trim().length > 0);
	const rows = kept.map((row, index) => styleThinkingRow(row, index));
	if (unbounded) return rows;
	return previewRows(
		rows,
		open ? limit : settledExcerptLimit(kept, text, limit),
		width,
		true,
		THINKING_HINT_PREFIX(),
		THINKING_HINT_PREFIX_WIDTH,
	);
}

function styleThinkingRow(row: string, index: number): string {
	const lead = index === 0 && row.startsWith(THINKING_LEAD) ? THINKING_LEAD : "";
	const body = row.slice(lead.length);
	return `${REASON_RAIL()}${lead ? pancodeTheme().fg("annotation", lead) : ""}${SGR_ITALIC}${pancodeTheme().fg("reasoningExcerpt", body)}${RESET}`;
}

/**
 * An open, bounded rail that streams: the reasoning up to a certified line break is wrapped once and only its last rows
 * are kept, so a delta redacts and wraps the text after that break rather than the whole stretch (Astra r10-1).
 */
export interface ThinkingStream {
	prose: AssistantProseProjection;
	layout: string;
	/** Sanitized reasoning through the certified break, ending in its `\n`; empty before the first. */
	head: string;
	headRows: number;
	/** The head's last kept rows, unstyled, enough for the excerpt and the row its hint replaces. */
	headTail: string[];
	retryAt: number;
}

/** How far text runs past the head before a break is looked for, and again after a look finds none. */
const THINKING_STREAM_STEP = 2048;
const THINKING_STREAM_TRIES = 16;
// A redaction pattern crosses a line break only after a name, flag, `:`, `=`, quote or scheme word leads into a value, or
// from a curl or docker command into the flag on the next line. A break after none of those, ahead of a token that holds no
// `:`, `=` or quote, splits no secret and no match, so the text on each side redacts as it would whole. RAIL_FAMILIES in
// tests/contracts/url-userinfo-hold.test.ts samples every redaction rule and compares each frame with the whole render.
const STREAM_LEAD_TOKEN_RE =
	/^-|[:="'`]|pass|pwd|secret|token|key|auth|credential|bearer|basic|cookie|login|sshpass|docker|curl/iu;
const STREAM_LEAD_LINE_RE = /curl|docker/iu;
const STREAM_HEAD_TOKEN_RE = /[:="']/u;

function certifiedThinkingBreak(before: string, after: string): boolean {
	const body = before.trimEnd();
	if (body.length === 0) return false;
	const line = body.slice(body.lastIndexOf("\n") + 1);
	const token = escapeTerminalControls(line.slice(line.search(/\S+$/u)));
	if (STREAM_LEAD_TOKEN_RE.test(token) || STREAM_LEAD_LINE_RE.test(escapeTerminalControls(line))) return false;
	// The next token must be whole, since one still growing may yet gain a `:`.
	const next = /^\s*(\S+)\s/u.exec(after);
	return next?.[1] !== undefined && !STREAM_HEAD_TOKEN_RE.test(escapeTerminalControls(next[1]));
}

function thinkingStreamRows(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width - PROSE_GUTTER_WIDTH)).filter((row) => row.trim().length > 0);
}

/** Move the head to the latest certified break in `tail`, the sanitized text after it. */
function advanceThinkingStream(stream: ThinkingStream, tail: string, width: number, limit: number): void {
	let at = tail.length;
	for (let tries = 0; tries < THINKING_STREAM_TRIES; tries += 1) {
		at = tail.lastIndexOf("\n", at - 1);
		if (at < 0) return;
		const chunk = tail.slice(0, at + 1);
		if (tail.charAt(at - 1) === "\r" || !/\S/u.test(chunk) || !certifiedThinkingBreak(chunk, tail.slice(at + 1)))
			continue;
		let text = stripThinkingEmphasis(redactStreamingSecretString(escapeTerminalControls(chunk), false));
		if (stream.head.length === 0) text = `${THINKING_LEAD}${text.replace(/^\s*\n/u, "")}`;
		if (!text.endsWith("\n") || text.endsWith("\r\n")) continue;
		const rows = thinkingStreamRows(text.slice(0, -1), width);
		stream.head += chunk;
		stream.headRows += rows.length;
		stream.headTail = [...stream.headTail, ...rows].slice(-(limit + 1));
		return;
	}
}

/** The rail {@link renderThinkingRail} draws for open, bounded reasoning, reusing what earlier deltas certified. */
export function streamThinkingRail(
	stream: ThinkingStream,
	thinking: string,
	width: number,
	limit: number,
	step = THINKING_STREAM_STEP,
): string[] {
	const prose = stream.prose.project(thinking, false, true);
	const layout = `${width}|${limit}`;
	if (stream.layout !== layout || !prose.startsWith(stream.head)) {
		stream.layout = layout;
		stream.head = "";
		stream.headRows = 0;
		stream.headTail = [];
		stream.retryAt = 0;
	}
	if (prose.length - stream.head.length >= step && prose.length >= stream.retryAt) {
		const before = stream.head.length;
		advanceThinkingStream(stream, prose.slice(before), width, limit);
		stream.retryAt = stream.head.length === before ? prose.length + step : 0;
	}
	if (stream.head.length === 0) return renderProseThinkingRail(prose, width, limit, false, true);
	const rest = escapeTerminalControls(prose.slice(stream.head.length));
	const redacted = redactStreamingSecretString(rest, false);
	const tail = stripThinkingEmphasis(redacted).replace(/\s+$/u, "");
	// A held value can leave the tail blank, and then the whole text's trim reaches back into the head.
	if (tail.length === 0) return renderProseThinkingRail(prose, width, limit, false, true);
	const tailRows = thinkingStreamRows(tail, width);
	const total = stream.headRows + tailRows.length;
	const shown = [...stream.headTail, ...tailRows].slice(-(limit + 1));
	const first = total - shown.length;
	return previewRows(
		shown.map((row, index) => styleThinkingRow(row, first + index)),
		limit,
		width,
		true,
		THINKING_HINT_PREFIX(),
		THINKING_HINT_PREFIX_WIDTH,
		() => `${total - (limit - 1)} rows`,
	);
}

/**
 * An open, bounded rail fed the reasoning so far on each call: what {@link streamThinkingRail} draws, what
 * {@link renderThinkingRail} draws from the whole text, and how much of it the stream has certified. A short `step` looks
 * for a break far more often than a live rail does, so a short text puts many breaks to the certification.
 */
export function openThinkingRailForTesting(
	width: number,
	limit: number,
	step: number,
): (thinking: string) => { streamed: string[]; whole: () => string[]; head: number } {
	const stream: ThinkingStream = {
		prose: new AssistantProseProjection(),
		layout: "",
		head: "",
		headRows: 0,
		headTail: [],
		retryAt: 0,
	};
	return (thinking) => ({
		streamed: streamThinkingRail(stream, thinking, width, limit, step),
		whole: () => renderThinkingRail(thinking, width, limit, false, true),
		head: stream.head.length,
	});
}
