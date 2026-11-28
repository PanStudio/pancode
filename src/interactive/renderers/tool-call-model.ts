// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { formatElapsed } from "../../core/format-time.js";
import { LONG_TOOL_DURATION_MS, type ToolDurationBudget } from "../../core/presentation-tier.js";
import { ToolNames } from "../../core/tool-names.js";
import { isRecord } from "../../core/type-guards.js";
import { displayToolCall, isGatewayChain } from "../../tools/gateway-display.js";
/** The tool-call wire shapes, the card ink, and the field readers every tool row renderer shares. */
import { cardRail } from "../card.js";
import { functionText, GLYPH, pancodeTheme } from "../theme/index.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";

export const theme = pancodeTheme();
export const toolMeta = (text: string): string => theme.fg("toolMetadata", text);
export const red = (text: string): string => theme.fg("error", text);
export const green = (text: string): string => theme.fg("success", text);
export const yellow = (text: string): string => theme.fg("warning", text);
export const informational = (text: string): string => theme.fg("info", text);
export const guidance = (text: string): string => theme.fg("guidance", text);
export const shellMark = (text: string): string => functionText(theme, "shell", text);

// The transcript is a two-cell gutter plus a content column. The action row
// puts `▸` in the gutter; its body nests under it with the rail in the content
// column (`  │ `), so arguments, output, and diffs read as belonging to the row
// above them instead of as more gutter-level blocks. Width budgets and diff
// renderers compute against the visible length, not the styled length, so the
// constant is kept as the plain-text representation.
export const BODY_INDENT_VISIBLE_WIDTH = 4;
/** Hanging indent for a wrapped action row: continuation rows start in the content column. */
export const CONTENT_INDENT = "  ";
export const CONTENT_INDENT_WIDTH = 2;
export const ARG_PREVIEW_LIMIT = 60;
export const FULL_RESULT_PREVIEW_LIMIT = 60_000;
const FULL_RESULT_ROW_LIMIT = 120;
export const STATUS_OK_GLYPH = GLYPH.ok;
export const STATUS_ERROR_GLYPH = GLYPH.error;
/** The fact separator, from the glyph table so ASCII mode replaces it. */
export const SEP = ` ${GLYPH.sep} `;

export const RAIL_NORMAL = (): string => cardRail();
export const RAIL_ERROR = (): string => cardRail(true);

export interface ToolExecutionStart {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** Live elapsed time supplied by the panel for running segments. */
	elapsedMs?: number | undefined;
	/** Pi may stream a tool call's arguments before execution starts. */
	phase?: "forming" | "ready" | "running" | undefined;
	/** Admission's action class, once known; an unknown dynamic tool is classified by it. */
	actionClass?: string | undefined;
	/** Local `!!` bash output is visible to the operator but excluded from model context. */
	excludeFromContext?: boolean | undefined;
	/** Who started this process: the operator directly, or the harness for a model's request. */
	actor?: "operator" | "harness" | undefined;
	/** The model that asked the harness to run this call. */
	requestedBy?: string | undefined;
	/** A stop went out and the process has not exited yet, so the header says `stopping` rather than `running`. */
	stopping?: boolean | undefined;
	/** A worker card sits under this dispatch call and states its task and outcome. */
	cardAttached?: boolean | undefined;
	/** Every worker card under this dispatch call settled cancelled, so the call was stopped, not failed. */
	cardsCancelled?: boolean | undefined;
	/**
	 * The renderer unwrapped a gateway op=call to this capability. Callers pass
	 * the wire call; the renderer sets this itself (see `presentedCall`).
	 */
	viaGateway?: boolean | undefined;
}

export interface ToolExecutionFinished {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result: unknown;
	isError: boolean;
	durationMs?: number | undefined;
	actor?: "operator" | "harness" | undefined;
	requestedBy?: string | undefined;
	/** Persisted summary (bytes, truncated, offloadPath, observation counts). */
	resultSummary?: Record<string, unknown> | undefined;
	/** Honest terminal outcome for synthetic/or permission-blocked calls. */
	outcome?: "blocked" | "aborted" | "orphaned" | undefined;
	/**
	 * An aborted or orphaned call settled before its execution started: the
	 * stream ended inside its arguments, or the turn stopped while it waited
	 * for approval. It reads as not run, like a blocked call; an aborted call
	 * that did start keeps its past-tense verb.
	 */
	notRun?: boolean | undefined;
	/**
	 * A not-run call whose result is the engine's refusal rather than a failure: the output limit cut off the reply
	 * that made it, so its arguments may be cut off too (bt-39 a). Its row reads `not run … output limit`, not `✗`.
	 */
	notRunCause?: "output_limit" | undefined;
	/**
	 * Why admission refused this call, from the registry verdict. A blocked row
	 * that states only that something was refused leaves the operator, and the
	 * model reading the same transcript, to guess at the rule.
	 */
	blockReason?: string | undefined;
	/**
	 * Working-set eviction reason, when the projection has replaced this
	 * result's body for the model. The transcript still renders the full body:
	 * the ledger is what the operator scrolls, the projection is only what the
	 * next request carries. The tag says the two now differ here.
	 */
	evictedReason?: string | undefined;
	/** Structured exit status when the caller has one; without it the text is parsed. */
	exitCode?: number | string | null | undefined;
	/** Local `!!` bash output is visible to the operator but excluded from model context. */
	excludeFromContext?: boolean | undefined;
	/** Admission's action class; an unknown dynamic tool is classified by it. */
	actionClass?: string | undefined;
	/**
	 * The approval axis an operator grant answered before this call ran, as
	 * `approvalAxisText` states it. Live only: it comes from the redacted
	 * approval event, which never reaches the session ledger.
	 */
	operatorGrant?: string | undefined;
	/** Who gave `operatorGrant` when it was not the operator at this terminal, as `attach c2 (apr)`. Live only. */
	grantedBy?: string | undefined;
	autoApproved?: "yolo" | undefined;
	/**
	 * A worker card sits under this dispatch call and states the run's outcome,
	 * so the row does not repeat it.
	 */
	cardAttached?: boolean | undefined;
	/** Every worker card under this dispatch call settled cancelled, so the call was stopped, not failed. */
	cardsCancelled?: boolean | undefined;
	/**
	 * The renderer unwrapped a gateway op=call to this capability. Callers pass
	 * the wire call; the renderer sets this itself (see `presentedCall`).
	 */
	viaGateway?: boolean | undefined;
}

/**
 * A gateway op=call renders as the capability it ran, exactly as a direct call:
 * its label, argument preview, streaming output, exit status and diff. Which door
 * the model used changes nothing the operator reads or can act on, so the row does
 * not say it; exports and the session tree still record `via gateway`. Unwrapping once, at every
 * exported entry point, keeps each helper below keyed on the capability's own
 * name and arguments. A chain, find and describe stay gateway rows.
 */
export function presentedCall<T extends ToolExecutionStart | ToolExecutionFinished>(call: T): T {
	if (call.toolName !== ToolNames.Gateway) return call;
	const details = "result" in call ? detailsOf(call.result) : null;
	const effective = displayToolCall(call.toolName, call.args, details ?? undefined);
	if (!effective.viaGateway) return call;
	return { ...call, toolName: effective.toolName, args: effective.args, viaGateway: true };
}

export function isChainCall(call: ToolExecutionStart | ToolExecutionFinished): boolean {
	return isGatewayChain(call.toolName, call.args, "result" in call ? detailsOf(call.result) : undefined);
}

export interface ToolBodyRenderOptions {
	/**
	 * Render the full tool result body with no middle-elision and no character
	 * truncation. The live view keeps bodies bounded so a single tool cannot
	 * flood the pane; `/export` sets this so the written transcript reproduces
	 * the complete tool output the model actually received.
	 */
	unbounded?: boolean;
	/** Live rows color mutation diffs; replay and export deliberately use plain text. */
	diffStyle?: "color" | "plain";
	detail?: TranscriptDetailPolicy;
	terminalRows?: number;
}

/** Row cap for a tool body: unbounded lifts both the row and char limits. */
export function resultRowLimit(opts: ToolBodyRenderOptions): number {
	return opts.unbounded === true ? Number.POSITIVE_INFINITY : FULL_RESULT_ROW_LIMIT;
}

export function resultCharLimit(opts: ToolBodyRenderOptions): number {
	return opts.unbounded === true ? Number.POSITIVE_INFINITY : FULL_RESULT_PREVIEW_LIMIT;
}

// Counts UTF-16 code units; can split a surrogate pair on non-BMP input. Acceptable for ASCII paths/commands.
export function truncate(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const cut = Math.max(0, limit - GLYPH.ellipsis.length);
	return `${value.slice(0, cut)}${GLYPH.ellipsis}`;
}

export function isEmptyArgs(args: unknown): boolean {
	if (args === undefined || args === null) return true;
	if (isRecord(args) && Object.keys(args).length === 0) return true;
	return false;
}

export function jsonStringifySafe(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		return typeof text === "string" ? text : String(value);
	} catch {
		return String(value);
	}
}

function unquoteShellScript(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const quote = trimmed.charAt(0);
	if ((quote !== "'" && quote !== '"') || trimmed.charAt(trimmed.length - 1) !== quote) return trimmed;
	const inner = trimmed.slice(1, -1);
	if (quote === "'") return inner.replace(/'\\''/g, "'");
	return inner.replace(/\\"/g, '"').replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\\/g, "\\");
}

export function stripShellWrapperForDisplay(command: string): string {
	const trimmed = command.trim();
	const match = /^(?:(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh))\s+-lc\s+([\s\S]+)$/u.exec(trimmed);
	if (!match?.[1]) return command;
	return unquoteShellScript(match[1]);
}

/**
 * Optional-duration guard around the single duration formatter. formatElapsed
 * is the one formatter for elapsed time, but these call sites carry a
 * `number | undefined` that may be missing, non-finite, or negative and must
 * then omit the ` · <dur>` segment entirely. Returns null in those cases and
 * delegates every real value to formatElapsed, so durations render as
 * `860ms`, `4.2s`, `42s`, and `1m36s` with no zero padding on the seconds.
 */
export function optionalCompactMs(durationMs: number | undefined): string | null {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
	return formatElapsed(durationMs);
}

/**
 * A settled call's duration under its tier's `toolDurations` budget: never, from one second, or always. Without a
 * budget (inspection, export) every duration shows.
 */
export function budgetedDuration(durationMs: number | undefined, budget: ToolDurationBudget = "always"): string | null {
	if (budget === "never") return null;
	if (budget === "long" && (durationMs ?? 0) < LONG_TOOL_DURATION_MS) return null;
	return optionalCompactMs(durationMs);
}

/**
 * A live call's ticking elapsed time. Live work always ticks (2.8), but a sub-second figure shows only where the tier
 * states every duration, so a quick call does not flash a figure its settled row then drops.
 */
export function liveElapsed(elapsedMs: number | undefined, budget: ToolDurationBudget = "always"): string | null {
	if (budget !== "always" && (elapsedMs ?? 0) < LONG_TOOL_DURATION_MS) return null;
	return optionalCompactMs(elapsedMs);
}

export function detailsOf(result: unknown): Record<string, unknown> | null {
	if (!isRecord(result)) return null;
	return isRecord(result.details) ? result.details : null;
}

export function observationOf(finished: ToolExecutionFinished): Record<string, unknown> | null {
	const fromDetails = detailsOf(finished.result)?.observation;
	if (isRecord(fromDetails)) return fromDetails;
	const fromSummary = finished.resultSummary?.observation;
	return isRecord(fromSummary) ? fromSummary : null;
}

export function numberField(record: Record<string, unknown> | null, key: string): number | null {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringField(record: Record<string, unknown> | null, key: string): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Observation units are plural nouns (`entries`, `lines`); one of them is singular. */
function unitFor(count: number, unit: string): string {
	if (count !== 1) return unit;
	if (unit.endsWith("ies")) return `${unit.slice(0, -3)}y`;
	if (/(?:ch|sh|x|ss)es$/u.test(unit)) return unit.slice(0, -2);
	return unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

export function countSummary(observation: Record<string, unknown>): string | null {
	const unit = stringField(observation, "unit") ?? "results";
	const shown = numberField(observation, "shownCount");
	if (shown === null) return null;
	const total = numberField(observation, "totalCount");
	if (total === null) return `${shown}+ ${unit}`;
	if (total === shown) return `${shown} ${unitFor(shown, unit)}`;
	return `${shown}/${total} ${unitFor(total, unit)}`;
}

/**
 * A call blocked at admission never executed, so its row must not claim it
 * did: its verb is `blocked`, and the ledger byte count is suppressed because
 * those bytes are the denial text, not output.
 */
export function didNotRun(finished: Pick<ToolExecutionFinished, "outcome" | "notRun"> | null | undefined): boolean {
	return finished?.outcome === "blocked" || finished?.notRun === true;
}

export function contentWidth(width: number): number {
	return Math.max(1, width - CONTENT_INDENT_WIDTH);
}
