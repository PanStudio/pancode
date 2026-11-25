// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isRecord } from "../../core/type-guards.js";
import { reviewDiffStat } from "../../core/views/diff-rows.js";
import { formatSize } from "../../core/views/tool-words.js";
import { sanitizeMultilineDisplayText } from "../../domains/safety/call-target.js";
import { holdUnresolvedUserinfo, redactSecretString } from "../../domains/safety/redaction.js";
import { stripTerminalSequences } from "../../engine/tui.js";
import { toolResultPresentationText } from "../../tools/result-disposition.js";
/** Tool result text: command-status envelopes, killed output, model notes, diffs, and the output blocks. */
import { cardRows } from "../card.js";
import { GLYPH } from "../theme/index.js";
import { shellCommandInk, toolOutputInk } from "./code-ink.js";
import { renderDiffLines } from "./diff.js";
import { groupWrappedRows } from "./preview.js";
import { tryRenderJson, tryRenderXml } from "./structured.js";
import {
	BODY_INDENT_VISIBLE_WIDTH,
	detailsOf,
	FULL_RESULT_PREVIEW_LIMIT,
	jsonStringifySafe,
	RAIL_ERROR,
	RAIL_NORMAL,
	resultCharLimit,
	resultRowLimit,
	SEP,
	shellMark,
	stripShellWrapperForDisplay,
	type ToolBodyRenderOptions,
	theme,
	toolMeta,
	truncate,
} from "./tool-call-model.js";

/**
 * The status line a failed command's error text ends with: `bash: command
 * failed (exit 1)`, `Command exited with code 1`, a timeout or an abort. The
 * row states it as a fact, so the body leaves it out. A status that carries the
 * only diagnosis (`bash: command failed (exit 127): not found`) keeps that
 * diagnosis as the body line.
 */
const COMMAND_STATUS_LINE =
	/^(?:bash: command failed \(exit (?<exit>[^)]+)\)(?:: (?<message>.+))?|Command exited with code (?<code>[0-9?]+)|bash: command (?<timeout>timed out) after \d+ms|bash: this command ran past its own .+ (?<newTimeout>timeout) and was stopped\..*|bash: this command printed nothing and used no CPU for .+ and was stopped as (?<idle>idle) \(.*|bash: command (?<aborted>aborted)(?: after \d+s of its \S+ time limit\. The host ended the run(?:: (?<cause>.+)| and recorded no cause\.))?)$/u;

const VERIFY_TIMEOUT_LINE =
	/^verify: (?:run \d+\/\d+: )?timed out after (?:(?<seconds>\d+(?:\.\d+)?) s|(?<ms>\d+)ms)$/u;

interface CommandStatus {
	/** Index of the status line in the result text's lines. */
	index: number;
	exit: string | null;
	timedOut: boolean;
	/** The command was stopped as idle (safety.limits.bashIdleSeconds), not by its timeout. */
	idle: boolean;
	/** Explicit timeout wording from a verify timeout line (`<N> s`), when present. */
	timeoutSeconds: string | null;
	aborted: boolean;
	/** Text the status line carried beyond the status itself. */
	message: string | null;
	/** Why the run ended under an aborted command, as the host recorded it. */
	cause: string | null;
}

export function formatVerifyTimeoutSeconds(timeoutMs: number): string {
	return `${Number((timeoutMs / 1000).toFixed(3))} s`;
}

export function commandStatusLine(result: unknown): CommandStatus | null {
	const text = resultEnvelopeText(result);
	if (typeof text !== "string") return null;
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = (lines[index] ?? "").trim();
		if (line.length === 0) continue;
		const match = COMMAND_STATUS_LINE.exec(line);
		if (match?.groups === undefined) break;
		const exit = match.groups.exit ?? match.groups.code ?? null;
		const message = match.groups.message ?? null;
		return {
			index,
			exit,
			timedOut: match.groups.timeout !== undefined || match.groups.newTimeout !== undefined,
			idle: match.groups.idle !== undefined,
			timeoutSeconds: null,
			aborted: match.groups.aborted !== undefined,
			// `command exited with code 3` after `(exit 3)` restates the row's own fact, so it is no diagnosis.
			message: message !== null && message.trim().toLowerCase() === `command exited with code ${exit}` ? null : message,
			cause: match.groups.cause ?? null,
		};
	}
	for (let index = 0; index < lines.length; index += 1) {
		const line = (lines[index] ?? "").trim();
		if (line.length === 0) continue;
		const match = VERIFY_TIMEOUT_LINE.exec(line);
		if (match?.groups === undefined) return null;
		const timeoutSeconds =
			match.groups.seconds !== undefined
				? `${match.groups.seconds} s`
				: match.groups.ms !== undefined
					? formatVerifyTimeoutSeconds(Number(match.groups.ms))
					: null;
		return {
			index,
			exit: null,
			timedOut: true,
			idle: false,
			timeoutSeconds,
			aborted: false,
			message: null,
			cause: null,
		};
	}
	return null;
}

/**
 * A command stopped as idle rather than by its timeout: the details say so
 * (`timedOut` with `timedOutBy: "idle"`), or, when a bridge dropped the
 * details, the status line bash wrote does (FX-40).
 */
export function stoppedIdle(
	details: Record<string, unknown> | null | undefined,
	status: CommandStatus | null,
): boolean {
	return (details?.timedOut === true && details.timedOutBy === "idle") || status?.idle === true;
}

/** A failed command's output without the status line its row already states. */
export function withoutCommandStatus(result: unknown): unknown {
	const status = commandStatusLine(result);
	const text = unwrapResultEnvelope(result);
	if (status === null || typeof text !== "string") return result;
	const lines = text.split("\n");
	if (status.message !== null) lines[status.index] = status.message;
	else {
		lines.splice(status.index, 1);
		if (status.index === 0) {
			while (lines[0] !== undefined && lines[0].trim().length === 0) lines.shift();
		}
	}
	return lines.join("\n").replace(/\n+$/u, "");
}

/**
 * pi-agent-core wraps tool results in `{ content: [{ type: "text", text }, ...] }`
 * envelopes. Rendering that JSON verbatim hides the actual output and, for a
 * mixed result, can dump a base64 image into the terminal. Text blocks are
 * joined, image blocks become compact MIME/size placeholders, and unknown
 * content blocks are named without serializing their payload.
 */
const KILLED_OUTCOMES: ReadonlySet<unknown> = new Set(["abort", "aborted", "timeout", "timed-out", "output-cap"]);
const KILLED_STATUS_RE =
	/^(?:bash: command (?:aborted|timed out|output exceeded)\b|(?:bash: command failed \(exit |Command exited with code )(?:124|1(?:2[89]|[3-9]\d)|2\d\d)\b)/u;
const TAIL_NOTE_PREFIX = "[Output tail-truncated";
const STDOUT_TAIL_MARK = "--- stdout tail ---";
const STDERR_TAIL_MARK = "--- stderr tail ---";

/**
 * A process killed below the shell still gives the shell an exit code: `timeout` exits 124 and a signal death reads as
 * 128 plus the signal. Exit 1 is a process that finished and said so (#446).
 */
export function exitMeansKilled(code: unknown): boolean {
	return typeof code === "number" && (code === 124 || code >= 128);
}

/**
 * Whether a result is the output of a process that did not exit on its own, or of one still running under a tool that
 * reports each stream's tail. A row without details is judged by the status paragraph the tool wrote (#446).
 */
function killedWithOpenOutput(result: unknown, text: string): boolean {
	const details = detailsOf(result);
	if (details?.outputEndsOpen === false) return false;
	if (details === null) return KILLED_STATUS_RE.test(text.slice(text.lastIndexOf("\n\n") + 2));
	if (KILLED_OUTCOMES.has(details.outcome) || isRecord(details.progress)) return true;
	// Process results carry both flags. A monitor or pane wait reports only a timeout of its own wait, and a monitor's
	// exit code is its worker's, so neither says this text was cut (#446).
	if ("aborted" in details && "timedOut" in details) {
		return (
			details.aborted === true ||
			details.timedOut === true ||
			typeof details.signal === "string" ||
			exitMeansKilled(details.exitCode)
		);
	}
	if ("outcome" in details) return false;
	return KILLED_STATUS_RE.test(text.slice(text.lastIndexOf("\n\n") + 2));
}

/**
 * Where a killed process's output ends depends on the tool. run_script lists each stream's tail. A running one ends its
 * text with its stderr, whose last line is what can still grow. A finished one follows stderr with trailing lines not
 * marked apart from it, so every stderr line holds. bash ends its output in the paragraph before its status line, and
 * past the cap before the tail note too. A single paragraph ends in the output itself.
 */
function holdKilledOutput(text: string, running: boolean): string {
	const lines = text.split("\n");
	const stderr = lines.lastIndexOf(STDERR_TAIL_MARK);
	if (stderr > 0 && lines.includes(STDOUT_TAIL_MARK)) {
		lines[stderr - 1] = holdUnresolvedUserinfo(lines[stderr - 1] ?? "");
		for (let index = running ? lines.length - 1 : stderr + 1; index < lines.length; index += 1) {
			lines[index] = holdUnresolvedUserinfo(lines[index] ?? "");
		}
		return lines.join("\n");
	}
	const paragraphs = text.split("\n\n");
	if (paragraphs.length === 1) return holdUnresolvedUserinfo(text);
	const notes = paragraphs.at(-1)?.startsWith(TAIL_NOTE_PREFIX) ? 2 : 1;
	const output = paragraphs.length - 1 - notes;
	if (output < 0) return text;
	paragraphs[output] = holdUnresolvedUserinfo(paragraphs[output] ?? "");
	return paragraphs.join("\n\n");
}

export function unwrapResultEnvelope(result: unknown): unknown {
	const unwrapped = resultEnvelopeText(result);
	return typeof unwrapped === "string" && killedWithOpenOutput(result, unwrapped)
		? holdKilledOutput(unwrapped, isRecord(detailsOf(result)?.progress))
		: unwrapped;
}

function resultEnvelopeText(result: unknown): unknown {
	if (typeof result === "string" || result === null || result === undefined) return result;
	const presentationText = toolResultPresentationText(result);
	if (presentationText !== null) return presentationText;
	const blocks = Array.isArray(result)
		? result
		: isRecord(result) && Array.isArray(result.content)
			? result.content
			: null;
	if (blocks === null) return result;
	const parts: string[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) return result;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "image" && typeof block.data === "string") {
			const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/unknown";
			const padding = block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0;
			const bytes = Math.max(0, Math.floor((block.data.length * 3) / 4) - padding);
			parts.push(`[image ${mimeType}${SEP}${formatSize(bytes)}]`);
			continue;
		}
		if (typeof block.type === "string") {
			parts.push(`[${block.type} content]`);
			continue;
		}
		return result;
	}
	if (parts.length === 0) return result;
	return parts.join("\n");
}

function isEmptyResult(result: unknown): boolean {
	if (result === null || result === undefined) return true;
	if (typeof result === "string" && result.length === 0) return true;
	return false;
}

/**
 * Tool output is untrusted terminal input. Cursor movement, backspaces and
 * carriage returns inside a row break the diff renderer's one-row-per-line
 * accounting, so everything but the line structure is neutralized here.
 */
/**
 * Lines middleware attaches to a tool result for the model (`[middleware:info]
 * …`), split from the output they lead or trail. Only whole lines at the start
 * or the end of the text count, so output that merely quotes the tag stays put.
 */
const MODEL_NOTE_LINE = /^\[middleware:[a-z-]+\] (.+)$/u;

export function splitModelNotes(text: string): { body: string; notes: string[] } {
	const lines = text.split("\n");
	const leading: string[] = [];
	while (lines.length > 0) {
		const note = MODEL_NOTE_LINE.exec(lines[0] ?? "")?.[1];
		if (note === undefined) break;
		leading.push(note);
		lines.shift();
		while (lines.length > 0 && (lines[0] ?? "").trim().length === 0) lines.shift();
	}
	const trailing: string[] = [];
	while (lines.length > 0) {
		const note = MODEL_NOTE_LINE.exec(lines[lines.length - 1] ?? "")?.[1];
		if (note === undefined) break;
		trailing.unshift(note);
		lines.pop();
	}
	if (trailing.length > 0) while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length === 0) lines.pop();
	return { body: lines.join("\n"), notes: [...leading, ...trailing] };
}

export function resultText(result: unknown, limit = FULL_RESULT_PREVIEW_LIMIT): string {
	const text = typeof result === "string" ? result : jsonStringifySafe(result);
	// Only what can be shown is sanitized: a 2 MB result cost most of a second per
	// first render when the whole of it went through the sanitizer before the cut.
	// Twice the limit leaves room for the escapes the sanitizer removes.
	const window = Number.isFinite(limit) ? limit * 2 : Number.POSITIVE_INFINITY;
	if (text.length <= window) return truncate(sanitizeMultilineDisplayText(text).text, limit);
	const shown = sanitizeMultilineDisplayText(text.slice(0, window)).text;
	return shown.length > limit ? truncate(shown, limit) : `${shown}${GLYPH.ellipsis}`;
}

function truncateRowsMiddle(rows: ReadonlyArray<string>, rowLimit: number, isError: boolean): string[] {
	if (rows.length <= rowLimit) return [...rows];
	if (rowLimit <= 1)
		return [
			`${isError ? RAIL_ERROR() : RAIL_NORMAL()}${theme.fg("foldedHint", `${GLYPH.ellipsis} ${rows.length} lines hidden`)}`,
		];
	const available = rowLimit - 1;
	const head = Math.floor(available / 2);
	const tail = available - head;
	const hidden = Math.max(0, rows.length - head - tail);
	return [
		...rows.slice(0, head),
		`${isError ? RAIL_ERROR() : RAIL_NORMAL()}${theme.fg("foldedHint", `${GLYPH.ellipsis} ${hidden} lines hidden`)}`,
		...rows.slice(-tail),
	];
}

function renderOutputRows(text: string, width: number, isError: boolean, rowLimit: number): string[] {
	const rows: string[] = [];
	for (const raw of toolOutputInk(text)) {
		rows.push(...cardRows(raw, width, isError));
	}
	return truncateRowsMiddle(rows, rowLimit, isError);
}

function renderStructuredOutputRows(
	value: unknown,
	width: number,
	isError: boolean,
	rowLimit: number,
): string[] | null {
	const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
	const unwrapped = unwrapResultEnvelope(value);
	const structured =
		typeof unwrapped === "string"
			? (tryRenderJson(unwrapped, bodyWidth, { lineLimit: rowLimit }) ??
				tryRenderXml(unwrapped, bodyWidth, { lineLimit: rowLimit }))
			: tryRenderJson(unwrapped, bodyWidth, { lineLimit: rowLimit });
	if (!structured) return null;
	const out: string[] = [];
	for (const row of structured) out.push(...cardRows(row, width, isError));
	return out;
}

function highlightBashCommand(command: string): string {
	return shellCommandInk(sanitizeMultilineDisplayText(command).text).join("\n");
}

export function resultDiff(result: unknown): string | null {
	const value = detailsOf(result)?.diff;
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Added and removed line counts of a mutation, read from the diff the tool
 * returned. These are the change facts a folded row carries in every style,
 * which is what lets Compact describe a change without its payload.
 */
export function changeStat(result: unknown): { added: number; removed: number } | null {
	const diff = resultDiff(result);
	return diff === null ? null : reviewDiffStat(diff);
}

const DIFF_CHANGE_ROW = new RegExp(`^[\\s${GLYPH.rail}]*[-+]\\s*\\d`, "u");
const DIFF_CONTINUATION_ROW = new RegExp(`^[\\s${GLYPH.rail}]*[-+ ]\\s*${GLYPH.codeWrap} `, "u");

/**
 * A preview too short for the whole diff opens at the first changed line: at 40 columns the leading context
 * filled the rows and the change itself sat behind the marker.
 */
export function fromFirstChange(rows: readonly string[]): readonly string[] {
	const first = rows.findIndex((row) => DIFF_CHANGE_ROW.test(stripTerminalSequences(row)));
	return first > 0 ? rows.slice(first) : rows;
}

/** A diff's rows as file lines: a wrapped line's continuation rows belong to the line above them. */
export function diffLines(rows: readonly string[]): string[][] {
	return groupWrappedRows(rows, (row) => DIFF_CONTINUATION_ROW.test(stripTerminalSequences(row)));
}

export function renderMutationDiffBlock(diff: string, width: number, color: boolean): string[] {
	const bodyWidth = Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH);
	return renderDiffLines(diff, bodyWidth, { color }).map((line) => `${RAIL_NORMAL()}${line}`);
}

interface BashArgs {
	command: string;
}

/**
 * Defensive shape check: bash-tool args must carry a string `command` for the
 * `$ <cmd>` echo line to render. Anything else falls through to the standard
 * result block so the dispatch is opportunistic and never throws.
 */
export function asBashArgs(args: unknown): BashArgs | null {
	if (!isRecord(args)) return null;
	const command = args.command;
	if (typeof command !== "string") return null;
	return { command: redactSecretString(command) };
}

export function resultLineCount(result: unknown): number {
	const unwrapped = unwrapResultEnvelope(result);
	if (typeof unwrapped !== "string" || unwrapped.length === 0) return 0;
	// A note to the model is not output, so it adds no lines to what the command printed.
	const normalized = splitModelNotes(unwrapped).body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const withoutTerminator = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
	return withoutTerminator.split("\n").length;
}

/**
 * Bash subrenderer: emits `$ <cmd>` (full command) on its own line under the
 * rail, then the unwrapped output via the same chain as `renderResultBlock`.
 * Mirrors pi-coding-agent's bash component shape so users see exactly what
 * was executed before the output. Failures use the same command and output
 * body while the caller selects the red rail and error status.
 */
export function renderBashResultBlock(
	args: BashArgs,
	result: unknown,
	width: number,
	isError: boolean,
	opts: ToolBodyRenderOptions = {},
): string[] {
	const out: string[] = [];
	const commandLine = `${shellMark("$")} ${highlightBashCommand(stripShellWrapperForDisplay(args.command))}`;
	out.push(...cardRows(commandLine, width, isError));
	const unwrapped = unwrapResultEnvelope(result);
	if (isEmptyResult(unwrapped)) {
		out.push(...cardRows(toolMeta("(no output)"), width, isError));
		return out;
	}
	out.push(...renderOutputRows(resultText(unwrapped, resultCharLimit(opts)), width, isError, resultRowLimit(opts)));
	return out;
}

export function renderResultBlock(
	result: unknown,
	isError: boolean,
	width: number,
	opts: ToolBodyRenderOptions = {},
): string[] {
	const unwrapped = unwrapResultEnvelope(result);
	if (isEmptyResult(unwrapped)) {
		return cardRows(toolMeta("(no output)"), width, isError);
	}
	const structured = renderStructuredOutputRows(unwrapped, width, isError, resultRowLimit(opts));
	if (structured) return structured;
	return renderOutputRows(resultText(unwrapped, resultCharLimit(opts)), width, isError, resultRowLimit(opts));
}
