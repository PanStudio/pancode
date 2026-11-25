// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { AssistantProseProjection } from "../core/assistant-prose.js";
/**
 * One transcript entry as rows: operator prompts, error segments, and the turn layout that joins thinking, tool, text
 * and receipt blocks under the prose gutter.
 */
import { UNICODE_GLYPH } from "../core/glyphs.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../domains/safety/call-target.js";
import {
	COPY_TIGHT_MARK,
	copyMark,
	leadingCopyMark,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import {
	AGENT_GLYPH,
	dimLine,
	GUIDANCE,
	GUTTER_ROW_MARK,
	hangProseLines,
	OSC133_PROMPT_START,
	PROSE_GUTTER,
	PROSE_GUTTER_WIDTH,
	RED_CRIT,
	RESET,
	SECONDARY,
	USER_BAR,
} from "./chat-ink.js";
import { continuationMark, renderTextSegmentLines } from "./chat-markdown.js";
import {
	REASON_RAIL,
	renderSettledThinkingMarker,
	renderThinkingRail,
	streamThinkingRail,
	THINKING_NOT_RETAINED_LABEL,
	THINKING_PROVIDER_HIDDEN_LABEL,
	THINKING_PROVIDER_SUMMARIZED_LABEL,
} from "./chat-thinking-rail.js";
import {
	failedCall,
	finishedCall,
	foldFamily,
	type QueuedRows,
	renderToolSegmentLines,
	toolBlockGap,
} from "./chat-tool-rows.js";
import {
	type AssistantSegment,
	carriesOutput,
	type ErrorSegment,
	findSkillSuggestionLine,
	hasVisibleOutput,
	isStraySegment,
	reasoningFromTurnUsage,
	skillSuggestionSplit,
	type TextSegment,
	type ToolSegment,
	type TranscriptEntry,
	type UserTurnStatus,
	type WorkerTranscriptEntry,
} from "./chat-transcript-model.js";
import { renderTurnUsageLine } from "./chat-turn-receipt.js";
import { keepRows, keptPieceRows, keptRows, type RowPiece } from "./kept-rows.js";
import { renderNoticeRow } from "./renderers/notice.js";
import { previewBudget, previewRows } from "./renderers/preview.js";
import {
	presentProviderError,
	providerErrorEvidence,
	providerFailureAdvice,
	providerFailureEvidence,
	providerFailureHeadline,
} from "./renderers/provider-error.js";
import { renderRetryStatus } from "./renderers/retry-status.js";
import { renderSkillSuggestionRow } from "./renderers/skill-rows.js";
import { hasToolBody, renderFoldedGroup } from "./renderers/tool-fold.js";
import type { WorkerEntryRenderOptions } from "./renderers/worker-entry.js";
import { renderWorkerEntryLines } from "./renderers/worker-entry.js";
import { UNMEASURED_REASONING } from "./status/index.js";
import { GLYPH, pancodeTheme, SGR_BOLD, SGR_BOLD_OFF } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";
import type { TranscriptDetailPolicy } from "./transcript-detail.js";

/**
 * Render a terminal-error segment in the error token. Terminal markers such as
 * `[error] ...`, `[aborted] ...`, and `[stopped: length] ...` render as red
 * message text rather than plain markdown, so a failed turn is visibly a
 * failure. Each source line wraps to width and carries the error color.
 */
function renderErrorSegmentLines(seg: ErrorSegment, width: number, unbounded: boolean): string[] {
	const out: string[] = [];
	const headline = !unbounded && seg.route ? providerFailureHeadline(seg.route) : null;
	if (seg.route && headline !== null) {
		// The plain sentence and the way out read first; the row fold takes what the provider said before either.
		for (const wrapped of wrapTextWithAnsi(headline, width)) out.push(`${RED_CRIT()}${wrapped}${RESET}`);
		for (const row of [providerFailureAdvice(seg.route, seg.text), providerFailureEvidence(seg.route, seg.text)])
			for (const wrapped of wrapTextWithAnsi(row, width)) out.push(`${SECONDARY()}${wrapped}${RESET}`);
		return out;
	}
	// The row's ✗ already says it failed; `✗ [error] cannot load…` said it twice in the store's own marker. /view keeps it.
	const shown = unbounded
		? providerErrorEvidence(seg.text)
		: presentProviderError(seg.text, { remedyStated: seg.route !== undefined && seg.route !== null }).replace(
				/^\[error\] /u,
				"",
			);
	for (const line of shown.split("\n")) {
		for (const wrapped of wrapTextWithAnsi(line, width)) {
			out.push(`${RED_CRIT()}${wrapped}${RESET}`);
		}
	}
	if (seg.route) {
		for (const wrapped of wrapTextWithAnsi(providerFailureAdvice(seg.route, seg.text), width))
			out.push(`${SECONDARY()}${wrapped}${RESET}`);
	}
	return out;
}

const PANCODE_PREFIX = () => `${GUIDANCE()}${AGENT_GLYPH}${RESET} `;
/** PanCode wrote this about a failure, so it never wears the mark of something the model said. */
const PANCODE_PREFIX_ERROR = () => `${RED_CRIT()}${GLYPH.error}${RESET} `;
/**
 * Operator prompts wear the accent bar on every row and bold text, so the
 * operator's words are never the same weight as the agent prose beneath them.
 */
const USER_PREFIX = () => `${GUIDANCE()}${USER_BAR}${RESET} `;
/**
 * A prompt PanCode has taken but not yet committed. The bar is dim rather than
 * the accent, the text is not bold, and the row says so, because the transcript used
 * to paint an uncommitted prompt exactly like a durable user turn while the
 * ledger still had no entry for it (issue #251).
 */
const USER_PREFIX_PENDING = () => `${SECONDARY()}${USER_BAR}${RESET} `;
/**
 * The uncommitted-row tails, stored as plain text so their width can be spent
 * against the row's budget before the dim codes go on. Both begin with the
 * separating space they carry when they ride on the end of a body line.
 */
const USER_PENDING_TAIL = ` ${GLYPH.sep} preparing`;
const USER_REFUSED_TAIL = ` ${GLYPH.sep} not sent`;

/**
 * A text segment's rows under the gutter, keeping the hung row of every row
 * that has not changed since the last frame (#428). A streaming answer's rows
 * above its open tail are the same strings frame to frame, and building a new
 * string for each of them cost more than rendering the tail, then cost the
 * terminal renderer again to flatten and compare them.
 */
function hangSegmentLines(seg: TextSegment, lines: string[], firstPrefix: string, marks: boolean): string[] {
	const memo = seg.hung;
	if (memo?.input === lines && memo.prefix === firstPrefix) return memo.output;
	// The unchanged rows lead: find where they end, copy their hung rows in one native slice, and hang the rest.
	// The rows the layers below vouch for are not compared again (#428).
	let same = 0;
	if (memo?.prefix === firstPrefix) {
		const limit = Math.min(lines.length, memo.input.length);
		same = keptRows(lines, memo.input);
		while (same < limit && memo.input[same] === lines[same]) same += 1;
	}
	const hung = (index: number): string => {
		const prefix = index === 0 ? firstPrefix : PROSE_GUTTER;
		const line = lines[index] ?? "";
		if (!marks) return `${prefix}${line}`;
		// Every hung row is marked ahead of its gutter, so fullscreen copy drops the glyph and the gutter cells (#453).
		const mark = leadingCopyMark(line);
		return mark === undefined
			? `${GUTTER_ROW_MARK}${prefix}${line}`
			: `${copyMark(mark.kind, mark.cells + PROSE_GUTTER_WIDTH)}${prefix}${line.slice(mark.length)}`;
	};
	let output: string[];
	if (same > 0 && memo !== undefined) {
		// One exact-size copy: a reply's rows are a large array, and a slice grown by a push allocated it twice.
		const base = memo.output;
		if (lines.length <= base.length) output = base.slice(0, lines.length);
		else {
			const added: string[] = [];
			for (let index = base.length; index < lines.length; index += 1) added.push(hung(index));
			output = base.concat(added);
		}
		for (let index = same; index < Math.min(lines.length, base.length); index += 1) output[index] = hung(index);
	} else {
		output = [];
		for (let index = 0; index < lines.length; index += 1) output.push(hung(index));
	}
	if (memo !== undefined) keepRows(output, memo.output, same);
	seg.hung = { input: lines, prefix: firstPrefix, output };
	return output;
}

/**
 * Put an uncommitted row's status tail on the row without letting it push a
 * line past the terminal. The tail used to be concatenated onto the last
 * rendered line unconditionally, so a body that had already folded near the
 * content width came out up to 12 cells past the terminal, and pi-tui's
 * `doRender` throws on an overlong line and kills the process. A `/share` of
 * a worker answer is the ordinary way to hit that: a `research-report` body is
 * JSON with no space to fold at, so an 80-column pane died on any shared body
 * over 58 columns (#257).
 *
 * The tail rides on the last body line when that line has room for it, and
 * drops to its own hanging row when it does not, so it stays whole either way
 * rather than breaking between `·` and the word.
 */
function appendUserRowTail(rendered: string[], tail: string, width: number): void {
	const last = rendered.length - 1;
	const lastLine = rendered[last];
	if (lastLine !== undefined && visibleWidth(lastLine) + tail.length <= width) {
		rendered[last] = `${lastLine}${SECONDARY()}${tail}${RESET}`;
		return;
	}
	rendered.push(`${USER_PREFIX_PENDING()}${dimLine(tail.trimStart(), Math.max(1, width - PROSE_GUTTER_WIDTH))}`);
}

/**
 * An operator prompt: the bar on every row, the text bold once committed. The
 * bar is what separates the operator's words from the agent's, so it does not
 * stop at the first row the way a voice glyph does.
 */
const SKILL_INVOCATION = /^\/skill\s+\S+/u;
const LOOP_LABEL_CHARS = 32;

export function renderUserLines(
	text: string,
	width: number,
	status: UserTurnStatus,
	origin?: string,
	marks = false,
): string[] {
	const contentWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	const scheduled = /^job (\S+) (\S+)$/u.exec(origin ?? "");
	if (scheduled !== null) {
		const task = sanitizeMultilineDisplayText(text).text;
		const flat = task.replace(/\s+/gu, " ").trim();
		const label =
			flat.length <= LOOP_LABEL_CHARS
				? flat
				: `${flat.slice(0, LOOP_LABEL_CHARS - visibleWidth(GLYPH.ellipsis)).trimEnd()}${GLYPH.ellipsis}`;
		// Two loops can run at once, so the row says which one fired. A task the label holds whole needs no second row.
		const header = `${GLYPH.scheduled} Scheduled loop "${label}" ${GLYPH.sep} /loop status`;
		return [
			...wrapTextWithAnsi(pancodeTheme().fg("annotation", header), width),
			...(label === flat ? [] : hangProseLines(wrapTextWithAnsi(pancodeTheme().fg("annotation", task), contentWidth))),
		];
	}
	const committed = status === "committed";
	const prefix = committed ? USER_PREFIX() : USER_PREFIX_PENDING();
	const rendered: string[] = [];
	const sourceLines = text.split("\n");
	// A `/skill <name>` prompt leads with the command in the slash-command
	// accent, so an explicit skill invocation reads as one rather than as prose.
	const invocation = SKILL_INVOCATION.exec(sourceLines[0] ?? "");
	if (invocation?.[0] !== undefined) {
		sourceLines[0] = `${pancodeTheme().style("guidance", invocation[0], { bold: committed })}${committed ? SGR_BOLD : ""}${(sourceLines[0] ?? "").slice(invocation[0].length)}`;
	}
	for (const sourceLine of sourceLines) {
		// With copy marks, the bar is not copied and a wrapped prompt line copies as the one line it was typed as (#453).
		let above: string | null = null;
		const wrapSource = { text: stripTerminalSequences(sourceLine), at: 0 };
		for (const row of wrapTextWithAnsi(sourceLine, contentWidth)) {
			const line = `${prefix}${pancodeTheme().base("userProse", committed && row.length > 0 ? `${SGR_BOLD}${row}${SGR_BOLD_OFF}` : row)}`;
			if (!marks) {
				rendered.push(line);
				continue;
			}
			const plain = stripTerminalSequences(row);
			const kind =
				above === null
					? "row"
					: continuationMark(above, plain, contentWidth, wrapSource) === COPY_TIGHT_MARK
						? "tight"
						: "join";
			rendered.push(`${copyMark(kind, PROSE_GUTTER_WIDTH)}${line}`);
			above = plain;
		}
	}
	if (rendered[0] !== undefined) rendered[0] = `${OSC133_PROMPT_START}${rendered[0]}`;
	if (!committed) appendUserRowTail(rendered, status === "pending" ? USER_PENDING_TAIL : USER_REFUSED_TAIL, width);
	if (origin) rendered.push(...wrapTextWithAnsi(`  ${sanitizeCallTargetText(origin)}`, width));
	return rendered;
}

/**
 * One visual unit of an assistant turn: a stretch of reasoning, a prose
 * paragraph run, one action (or a Compact group of observations), or the
 * terminal error. Segments render into blocks first so spacing is decided in
 * one place, by what sits on either side, instead of by each renderer.
 */
interface TurnBlock {
	kind: "thinking" | "prose" | "tool" | "error" | "receipt";
	lines: string[];
	/** An action with nested rows under its action row. */
	body?: boolean;
}

/**
 * Blocks of different kinds are separated by one blank row, so the agent's
 * words, its reasoning, and the actions between them never run together.
 * Consecutive body-less actions stack as a single run, the way a list of reads
 * reads as one step, even when a narrow terminal wraps one of their rows; an
 * action with a body (arguments, output, a diff) opens a gap on both sides so
 * its body cannot be mistaken for its neighbor's.
 */
function joinTurnBlocks(
	blocks: readonly TurnBlock[],
	memo?: JoinedRows,
	after?: Pick<TurnBlock, "kind" | "body">,
): string[] {
	const parts: (readonly string[])[] = [];
	const pieces: RowPiece[] = [];
	// Rows joined to follow rows already joined, such as a live turn's settled head, open with the gap after `after`.
	let previous: Pick<TurnBlock, "kind" | "body"> | undefined = after;
	for (const block of blocks) {
		// Markdown can open or close a block on an empty row; the gap between
		// blocks is decided here, so a block's own blank edges would double it.
		const lines = block.lines;
		let start = 0;
		let end = lines.length;
		while (start < end && isBlankRow(lines[start] ?? "")) start += 1;
		while (end > start && isBlankRow(lines[end - 1] ?? "")) end -= 1;
		if (start === end) continue;
		if (previous !== undefined) {
			const stacked = previous.kind === "tool" && block.kind === "tool" && !previous.body && !block.body;
			if (!stacked) {
				parts.push(GAP_ROW);
				pieces.push({ rows: GAP_ROW, start: 0, end: 1 });
			}
		}
		parts.push(start === 0 && end === lines.length ? lines : lines.slice(start, end));
		pieces.push({ rows: lines, start, end });
		previous = block;
	}
	// One native concat: a streaming answer's block is the whole reply, and a row-by-row copy of it showed in
	// the frame time (#428). The result is a new array, which callers may keep, except for a streaming turn of one
	// whole prose block: its rows are returned as they are, since copying a reply's rows cost more than the rest of the
	// join, and the panel only reads them.
	const only = parts.length === 1 ? blocks.find((block) => block.lines === parts[0]) : undefined;
	const output = memo !== undefined && only?.kind === "prose" ? only.lines : NO_ROW_LIST.concat(...parts);
	if (memo !== undefined) {
		if (memo.output !== undefined) keepRows(output, memo.output, keptPieceRows(pieces, memo.pieces));
		memo.pieces = pieces;
		memo.output = output;
	}
	return output;
}

/** A turn's last joined rows and the stretches of block rows they were joined from. */
type JoinedRows = { pieces: RowPiece[]; output?: string[] };
/** Per streaming turn, so a frame knows how many of its rows lead unchanged from the turn's last frame. */
const joinedTurns = new WeakMap<object, JoinedRows>();

export const GAP_ROW: readonly string[] = [""];
const NO_ROW_LIST: readonly string[] = [];

function isBlankRow(line: string): boolean {
	return stripTerminalSequences(line).trim().length === 0;
}

/**
 * Where a worker card sits in a group of cards: `continues` when it follows a
 * card of the same council round, so the council header is not repeated.
 */
function workerGroupPosition(
	entry: WorkerTranscriptEntry,
	previous: TranscriptEntry | undefined,
): "leads" | "continues" {
	const council = entry.state.council;
	if (council === undefined || previous?.role !== "worker") return "leads";
	const before = previous.state.council;
	return before !== undefined && before.group === council.group && before.round === council.round
		? "continues"
		: "leads";
}

/**
 * Whether a worker card stacks directly under the entry before it, with no
 * blank row: a card of the same council round, a sibling from the same
 * fan-out, a helper row after a helper row, and any card after a card in
 * Compact, where cards are a list.
 */
export function stacksUnder(
	entry: TranscriptEntry,
	previous: TranscriptEntry | undefined,
	detail: TranscriptDetailPolicy,
): boolean {
	if (entry.role !== "worker") return false;
	// A dispatch's worker rows nest under the call that spawned them: the header and its rows are one card.
	if (previous?.role === "assistant") return spawnedAtTail(entry, previous);
	if (previous?.role !== "worker") return false;
	if (!detail.evidence) return true;
	if (workerGroupPosition(entry, previous) === "continues") return true;
	const parent = entry.state.parentToolCallId;
	if (parent !== undefined && parent === previous.state.parentToolCallId) return true;
	return !detail.provenance && entry.state.helper === true && previous.state.helper === true;
}

/**
 * Whether a worker entry's spawning call is the last thing its assistant entry shows, so the worker's row reads as the
 * next row of that call's card. Text after the call, or a receipt closing the entry, separates them again.
 */
function spawnedAtTail(
	entry: WorkerTranscriptEntry,
	previous: Extract<TranscriptEntry, { role: "assistant" }>,
): boolean {
	const parent = entry.state.parentToolCallId;
	if (parent === undefined || (!previous.pending && previous.turnUsage !== undefined)) return false;
	for (let index = previous.segments.length - 1; index >= 0; index -= 1) {
		const seg = previous.segments[index];
		if (seg === undefined || seg.kind === "thinking" || (seg.kind === "text" && seg.text.trim().length === 0)) continue;
		return seg.kind === "tool" && seg.id === parent;
	}
	return false;
}

/**
 * A live turn's leading segments that can no longer change how they render, joined once. A turn that streams
 * thousands of messages re-rendered and re-joined every one of them on each delta; a frame now starts after the
 * head. The head ends only after a finalized text block: reasoning is flushed there and no Compact fold reaches
 * across non-empty text, so nothing after it changes the blocks before it.
 */
export type SettledHead = {
	key: string;
	/** Per covered segment (`segments[0, marks.length)`), the facts its rows are a function of. */
	marks: SegmentMark[];
	rows: string[];
	/** The head's last visible block, which decides the gap before the next one. */
	last: Pick<TurnBlock, "kind" | "body">;
	reasoningIndex: number;
};
/** A segment's identity and the one field a settled segment of its kind can still change by. */
type SegmentMark = { seg: AssistantSegment; text: string | undefined; revision: number | undefined };

function segmentMark(seg: AssistantSegment): SegmentMark {
	return {
		seg,
		text: seg.kind === "tool" ? undefined : seg.text,
		revision: seg.kind === "tool" ? seg.settledRevision : undefined,
	};
}

/** A settled segment renders the same rows until its text or revision moves; `segmentSettled` holds for the head. */
function segmentSettled(seg: AssistantSegment): boolean {
	if (seg.kind === "text" || seg.kind === "thinking") return seg.finalized;
	if (seg.kind === "tool") return seg.finished;
	return true;
}

function settledHeadFor(entry: Extract<TranscriptEntry, { role: "assistant" }>, key: string): SettledHead | undefined {
	const head = entry.settledHead;
	if (head === undefined) return undefined;
	let valid = head.key === key && head.marks.length <= entry.segments.length;
	for (let index = 0; valid && index < head.marks.length; index += 1) {
		const seg = entry.segments[index];
		const mark = head.marks[index] as SegmentMark;
		valid =
			seg === mark.seg &&
			segmentSettled(seg) &&
			(seg.kind === "tool" ? seg.settledRevision === mark.revision : seg.text === mark.text);
	}
	if (!valid) entry.settledHead = undefined;
	return valid ? head : undefined;
}

/**
 * Asks `renderEntryLines` for a live turn's rows apart from its settled head: `head` is set to the head's rows when
 * the turn has one, and the rows returned are the ones after it, so a caller can keep the head without copying it.
 */
export type LiveSplit = { head: string[] | undefined };

/** Segments walked by `renderEntryLines`; a panel frame counts its own as the rise across the frame. */
export let segmentsWalked = 0;

/**
 * The height a built-in row reads. Each bounds its rows with `previewBudget(limit, terminalRows)` for a limit of the
 * style's policy, so this budget for the policy's largest limit renders every one alike, and a terminal taller than
 * that renders them as the last one did. A caller-rendered replay block gets the raw height instead.
 */
export function rowsBudget(detail: TranscriptDetailPolicy, terminalRows: number): number {
	let ceiling = 0;
	for (const value of Object.values(detail)) if (typeof value === "number" && value > ceiling) ceiling = value;
	return previewBudget(ceiling, terminalRows);
}

export function renderEntryLines(
	entry: TranscriptEntry,
	width: number,
	nowMs: number,
	unboundedToolBodies: boolean,
	bareFences: boolean,
	copyMarks: boolean,
	detail: TranscriptDetailPolicy,
	terminalRows: number,
	previous?: TranscriptEntry,
	workerOptions?: Pick<
		WorkerEntryRenderOptions,
		"siblings" | "showGroupHeader" | "telemetry" | "routeFirstOutput" | "fleetOwnsLiveProgress"
	>,
	stopRequestedAt: number | null = null,
	split?: LiveSplit,
	queued?: QueuedRows,
): string[] {
	if (split !== undefined) split.head = undefined;
	if (entry.role === "replayBlock") {
		return entry.renderBlock(width, detail, unboundedToolBodies, terminalRows);
	}
	if (entry.role === "user") {
		return renderUserLines(entry.text, width, entry.status?.() ?? "committed", entry.origin, copyMarks);
	}
	if (entry.role === "retryStatus") {
		return renderRetryStatus(entry.status, width, detail, unboundedToolBodies, terminalRows);
	}
	if (entry.role === "worker") {
		const rows = renderWorkerEntryLines(entry.state, width, {
			...workerOptions,
			detail,
			terminalRows,
			unbounded: unboundedToolBodies,
			nowMs,
			group: workerGroupPosition(entry, previous),
		});
		const waiting = queued?.card(entry, width, detail) ?? [];
		return waiting.length === 0 ? rows : [...rows, ...waiting];
	}
	// A settled assistant entry that rendered nothing at all contributes nothing.
	// A mid-turn notice splits the transcript, so the events after it open a
	// fresh entry that a stopped turn never fills; that entry used to reach the
	// tail below and print a lone agent bubble under the notice.
	if (!entry.pending && entry.turnUsage === undefined && !hasVisibleOutput(entry) && entry.segments.length === 0) {
		return [];
	}
	const blocks: TurnBlock[] = [];
	// The model row says which model answered when that changed: the first turn,
	// a switch, or a failover inside the turn. Repeating it on every turn cost a
	// row per answer and said nothing new.
	if (entry.models?.length && !(entry.models.length === 1 && entry.sameModelAsBefore === true))
		blocks.push({
			kind: "prose",
			lines: renderNoticeRow(
				// The recorded label joins provider and model with `·`; the chrome draws it in the mode's separator.
				`Reply from ${entry.models.map((model) => model.replace(` ${UNICODE_GLYPH.sep} `, ` ${GLYPH.sep} `)).join(` ${GLYPH.right} `)}`,
				"info",
				width,
			),
		});
	const proseWidth = Math.max(1, width - PROSE_GUTTER_WIDTH);
	// One model answered the whole turn, so its shell rows need not each name it;
	// after a failover the row says which of the turn's models asked for it.
	const nameRequester = (entry.models?.length ?? 0) > 1;
	const settledKey = `${width}|${rowsBudget(detail, terminalRows)}|${detail.style}|${unboundedToolBodies}|${nameRequester}|${skinEpoch()}`;
	// Reasoning stays between the prose and actions that surround it, one block
	// per run of it: stretches that nothing visible separates read as one. A run
	// is held until the block after it is known, because what follows decides
	// its shape: Standard shows the bounded tail of the reasoning behind PanCode's
	// words, and the marker for the reasoning behind an action.
	let reasoning = "";
	let reasoningOpen = false;
	let reasoningIndex = 0;
	let lastMarker: TurnBlock | undefined;
	// Only a live turn keeps a head: a settled one renders once into the panel's entry cache, and its last
	// reasoning marker is rewritten from the receipt below.
	const headKey = entry.pending
		? `${settledKey}|${bareFences}|${detail.reasoningRows}|${detail.reasoningBeforeActionRows}|${detail.invocationRows}|${detail.errorRows}|${entry.models?.join("\u0000") ?? ""}|${entry.sameModelAsBefore === true}`
		: undefined;
	let start = 0;
	const head = headKey === undefined ? undefined : settledHeadFor(entry, headKey);
	if (head !== undefined) {
		blocks.length = 0;
		blocks.push({
			kind: head.last.kind,
			lines: head.rows,
			...(head.last.body === undefined ? {} : { body: head.last.body }),
		});
		start = head.marks.length;
		reasoningIndex = head.reasoningIndex;
	}
	// Where a longer head could end: every segment before it settled, and a finalized text block last.
	let headable = true;
	let cut: { through: number; blocks: number; reasoningIndex: number } | undefined;
	const flushReasoning = (next: "action" | "words"): void => {
		const text = reasoning;
		reasoning = "";
		if (text.trim().length === 0) return;
		const index = reasoningIndex++;
		const rows = next === "action" ? detail.reasoningBeforeActionRows : detail.reasoningRows;
		if (rows > 0 || unboundedToolBodies) {
			// A running tool's clock must not re-filter or re-wrap earlier reasoning (#428).
			entry.reasoningRenders ??= new Map();
			let cached = entry.reasoningRenders.get(index);
			if (cached?.source !== text || cached.open !== reasoningOpen || cached.epoch !== skinEpoch()) {
				const stream = reasoningOpen ? cached?.stream : undefined;
				cached = { source: text, open: reasoningOpen, epoch: skinEpoch(), layouts: new Map() };
				if (stream !== undefined) cached.stream = stream;
				entry.reasoningRenders.set(index, cached);
			}
			const limit = previewBudget(rows, terminalRows);
			const key = `${width}|${limit}|${unboundedToolBodies}`;
			let lines = cached.layouts.get(key);
			if (lines === undefined) {
				if (reasoningOpen && !unboundedToolBodies && limit > 1) {
					cached.stream ??= {
						prose: new AssistantProseProjection(),
						layout: "",
						head: "",
						headRows: 0,
						headTail: [],
						retryAt: 0,
					};
					lines = streamThinkingRail(cached.stream, text, width, limit);
				} else lines = renderThinkingRail(text, width, limit, unboundedToolBodies, reasoningOpen);
				cached.layouts.set(key, lines);
				if (cached.layouts.size > 3) {
					const oldest = cached.layouts.keys().next().value;
					if (oldest !== undefined) cached.layouts.delete(oldest);
				}
			}
			blocks.push({ kind: "thinking", lines });
			return;
		}
		lastMarker = { kind: "thinking", lines: [renderSettledThinkingMarker(UNMEASURED_REASONING, width)] };
		blocks.push(lastMarker);
	};
	for (let segIndex = start; segIndex < entry.segments.length; segIndex += 1) {
		const seg = entry.segments[segIndex];
		if (seg === undefined) continue;
		segmentsWalked += 1;
		if (headable && !segmentSettled(seg)) headable = false;
		if (seg.kind === "thinking") {
			if (seg.notRetained || seg.hiddenByProvider || seg.summarizedByProvider) {
				flushReasoning("words");
				const label = seg.hiddenByProvider
					? THINKING_PROVIDER_HIDDEN_LABEL
					: seg.summarizedByProvider
						? THINKING_PROVIDER_SUMMARIZED_LABEL
						: THINKING_NOT_RETAINED_LABEL;
				blocks.push({
					kind: "thinking",
					lines: [`${REASON_RAIL()}${dimLine(label, Math.max(1, width - PROSE_GUTTER_WIDTH))}`],
				});
				continue;
			}
			reasoning = joinReasoning(reasoning, seg.text);
			reasoningOpen = !seg.finalized;
			continue;
		}
		if (seg.kind === "tool") {
			// Compact folds a run of one fold family (explorations, knowledge
			// lookups, changes) into one row; every other act keeps its own. A
			// thinking model reasons before nearly every call, so the fold spans
			// that reasoning, and the reasoning inside the fold joins the marker
			// ahead of it rather than splitting the run into one-call folds.
			const family = !detail.evidence && !unboundedToolBodies ? foldFamily(seg) : null;
			const grouped: ToolSegment[] = [seg];
			let end = segIndex;
			let absorbed = "";
			if (family) {
				let between = "";
				for (let next = segIndex + 1; next < entry.segments.length; next += 1) {
					const candidate = entry.segments[next];
					if (candidate?.kind === "thinking") {
						between = joinReasoning(between, candidate.text);
						continue;
					}
					if (candidate?.kind === "text" && candidate.text.length === 0) continue;
					if (candidate?.kind !== "tool" || foldFamily(candidate) !== family) break;
					grouped.push(candidate);
					end = next;
					absorbed = joinReasoning(absorbed, between);
					between = "";
				}
			}
			if (family) {
				reasoning = joinReasoning(reasoning, absorbed);
				flushReasoning("action");
				let revisions = 0;
				for (const call of grouped) revisions += call.settledRevision ?? 0;
				let fold = seg.settledFold;
				if (
					fold === undefined ||
					fold.key !== settledKey ||
					fold.calls !== grouped.length ||
					fold.revisions !== revisions
				) {
					const lines = renderFoldedGroup(
						family,
						grouped.map((member) => finishedCall(member, nameRequester)),
						width,
						previewBudget(detail.invocationRows, terminalRows),
					);
					fold = {
						key: settledKey,
						lines: markActionLead(lines, copyMarks),
						body: hasToolBody(lines),
						calls: grouped.length,
						revisions,
					};
					seg.settledFold = fold;
				}
				blocks.push({ kind: "tool", lines: fold.lines, body: toolBlockGap(fold.body, fold.lines, false, detail) });
				for (let member = segIndex + 1; headable && member <= end; member += 1) {
					const covered = entry.segments[member];
					if (covered !== undefined && !segmentSettled(covered)) headable = false;
				}
				segmentsWalked += end - segIndex;
				segIndex = end;
			} else {
				flushReasoning("action");
				let rows = seg.finished && seg.settledRows?.key === settledKey ? seg.settledRows : undefined;
				if (rows === undefined) {
					const lines = renderToolSegmentLines(
						seg,
						width,
						nowMs,
						unboundedToolBodies,
						detail,
						terminalRows,
						seg.finished ? null : stopRequestedAt,
						nameRequester,
					);
					rows = { key: settledKey, lines: markActionLead(lines, copyMarks), body: hasToolBody(lines) };
					if (seg.finished) seg.settledRows = rows;
				}
				// A live dispatch lists every task from its first frame: the ones no worker has started read as queued.
				const waiting = seg.finished ? [] : (queued?.call(seg, width, detail) ?? []);
				blocks.push({
					kind: "tool",
					lines: waiting.length === 0 ? rows.lines : [...rows.lines, ...waiting],
					body: toolBlockGap(rows.body, rows.lines, failedCall(seg), detail),
				});
			}
			continue;
		}
		// Every prose block carries the agent glyph on its first row, so narration
		// that resumes after a run of actions reads as the agent speaking again
		// rather than as a caption of the action above it. A skill-suggestion
		// protocol line is advisory rather than the answer: it renders in place
		// without claiming the glyph.
		if (seg.kind === "text" && seg.text.length === 0) continue;
		// A stray mark between actions (`.` or `)` left over when a model ends its
		// words in a tool call) carries nothing to read, and as its own bubble it
		// looked like a reply. A turn whose only output is that mark keeps it.
		if (seg.kind === "text" && isStraySegment(seg)) {
			if (entry.segments.some((other) => carriesOutput(other, seg))) continue;
			// Kept only while nothing else carries output, which a later segment can change.
			headable = false;
		}
		// A skill suggestion is advice for the operator, not the answer: it reads
		// `§ suggests /skill <name>` as its own row, ahead of the answer wherever
		// the model put it.
		const split = seg.kind === "text" ? skillSuggestionSplit(seg) : null;
		if (split) {
			flushReasoning("words");
			blocks.push({
				kind: "tool",
				lines: markActionLead(renderSkillSuggestionRow(split.suggestion, width), copyMarks),
				body: false,
			});
			const answerLines = renderTextSegmentLines(split.answer, proseWidth, bareFences, copyMarks);
			if (answerLines.length > 0)
				blocks.push({ kind: "prose", lines: hangSegmentLines(split.answer, answerLines, PANCODE_PREFIX(), copyMarks) });
			if (headable) cut = { through: segIndex + 1, blocks: blocks.length, reasoningIndex };
			continue;
		}
		const suggestionOnly = seg.kind === "text" ? findSkillSuggestionLine(seg) : null;
		if (seg.kind === "text" && suggestionOnly !== null) {
			flushReasoning("words");
			blocks.push({
				kind: "tool",
				lines: markActionLead(
					renderSkillSuggestionRow(seg.text.slice(suggestionOnly.start, suggestionOnly.end), width),
					copyMarks,
				),
				body: false,
			});
			continue;
		}
		let rendered =
			seg.kind === "text"
				? renderTextSegmentLines(seg, proseWidth, bareFences, copyMarks)
				: renderErrorSegmentLines(seg, proseWidth, unboundedToolBodies);
		if (seg.kind === "error" && !unboundedToolBodies) {
			rendered = previewRows(rendered, previewBudget(detail.errorRows, terminalRows), proseWidth);
		}
		if (rendered.length === 0) continue;
		flushReasoning("words");
		if (seg.kind === "error") blocks.push({ kind: "error", lines: hangProseLines(rendered, PANCODE_PREFIX_ERROR()) });
		else blocks.push({ kind: "prose", lines: hangSegmentLines(seg, rendered, PANCODE_PREFIX(), copyMarks) });
		if (headable) cut = { through: segIndex + 1, blocks: blocks.length, reasoningIndex };
	}
	if (headKey !== undefined && cut !== undefined && cut.through > (head?.marks.length ?? 0)) {
		const headBlocks = blocks.slice(0, cut.blocks);
		const rows = joinTurnBlocks(headBlocks);
		const last = [...headBlocks].reverse().find((block) => block.lines.some((line) => !isBlankRow(line)));
		if (last !== undefined && rows.length > 0) {
			const marks = head?.marks.slice() ?? [];
			for (let index = marks.length; index < cut.through; index += 1) {
				const seg = entry.segments[index];
				if (seg !== undefined) marks.push(segmentMark(seg));
			}
			entry.settledHead = {
				key: headKey,
				marks,
				rows,
				last: { kind: last.kind, ...(last.body === undefined ? {} : { body: last.body }) },
				reasoningIndex: cut.reasoningIndex,
			};
		}
	}
	// Reasoning at the tail is either still streaming or the turn's last word.
	flushReasoning("words");
	// A settled turn's last marker states how much reasoning its folds hold.
	if (lastMarker !== undefined && !entry.pending && detail.reasoningRows === 0) {
		lastMarker.lines = [renderSettledThinkingMarker(reasoningFromTurnUsage(entry.turnUsage), width)];
	}
	if (entry.turnUsage && !entry.pending) {
		blocks.push({ kind: "receipt", lines: renderTurnUsageLine(entry.turnUsage, width, detail.receipt, nowMs) });
	}
	let joined: JoinedRows | undefined;
	if (entry.pending) {
		joined = joinedTurns.get(entry);
		if (joined === undefined) {
			joined = { pieces: [] };
			joinedTurns.set(entry, joined);
		}
	}
	if (head !== undefined && split !== undefined) {
		split.head = head.rows;
		return joinTurnBlocks(blocks.slice(1), joined, head.last);
	}
	return joinTurnBlocks(blocks, joined);
}

/**
 * An action row's glyph and the space after it sit in the gutter, so a fullscreen copy of the row starts at its words
 * (#453). Rows that do not open with a one-cell glyph keep the stock copy.
 */
function markActionLead(lines: string[], marks: boolean): string[] {
	const first = lines[0];
	if (!marks || first === undefined) return lines;
	const glyph = /^(\S) /u.exec(stripTerminalSequences(first))?.[1];
	if (glyph === undefined || visibleWidth(glyph) !== 1) return lines;
	return [`${GUTTER_ROW_MARK}${first}`, ...lines.slice(1)];
}

/** Two stretches of one run of reasoning, as one text. */
function joinReasoning(before: string, next: string): string {
	if (next.length === 0) return before;
	return before.length === 0 ? next : `${before}\n${next}`;
}
