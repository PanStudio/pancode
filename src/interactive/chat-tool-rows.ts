// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** Tool segments as transcript rows: forming previews, folded call families and queued dispatch runs. */
import { type RunFacts, runIdentityWidth, runRow } from "../core/run-row.js";
import { rawDurationMs } from "../core/timers.js";
import { ToolNames } from "../core/tool-names.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { holdUnresolvedStrings, redactSecretString } from "../domains/safety/redaction.js";
import { visibleWidth } from "../engine/tui.js";
import type { WorkerEntryState } from "../session-control/worker-stream.js";
import { cardRail } from "./card.js";
import type { AssistantSegment, ToolSegment, WorkerTranscriptEntry } from "./chat-transcript-model.js";
import { LiveToolView } from "./renderers/live-tool-view.js";
import { previewBudget } from "./renderers/preview.js";
import { renderToolAwaitingApproval, renderToolAwaitingJudge } from "./renderers/tool-approval-cards.js";
import type { ToolExecutionFinished } from "./renderers/tool-call-model.js";
import { renderToolExecution, renderToolPreview, stopSentRow } from "./renderers/tool-execution.js";
import { type ToolFoldFamily, toolFoldFamily } from "./renderers/tool-fold.js";
import { GLYPH, pancodeTheme } from "./theme/index.js";
import type { TranscriptDetailPolicy } from "./transcript-detail.js";

export function renderToolSegmentLines(
	seg: ToolSegment,
	width: number,
	nowMs: number,
	unbounded: boolean,
	detail: TranscriptDetailPolicy,
	terminalRows: number,
	stopRequestedAt: number | null = null,
	nameRequester = true,
): string[] {
	const call = {
		toolCallId: seg.id,
		toolName: seg.name,
		args: formingPreviewArgs(seg, width, detail, terminalRows),
		actionClass: seg.actionClass,
		cardAttached: seg.cardAttached,
		elapsedMs: seg.startedAtMs === undefined ? undefined : Math.max(0, rawDurationMs(seg.startedAtMs, nowMs)),
		phase: seg.executionStarted ? ("running" as const) : seg.argsComplete ? ("ready" as const) : ("forming" as const),
	};
	if (!seg.finished && seg.awaitingApproval)
		return renderToolAwaitingApproval(
			call,
			width,
			!detail.evidence || seg.approvalDocked === true ? undefined : seg.approvalView,
		);
	if (!seg.finished && seg.judging === true) return renderToolAwaitingJudge(call, width);
	const finished = {
		...call,
		result: seg.result,
		isError: seg.isError,
		durationMs: seg.durationMs,
		resultSummary: seg.resultSummary,
		outcome: seg.settlement,
		notRun: seg.notRun,
		notRunCause: seg.notRunCause,
		blockReason: seg.blockReason,
		evictedReason: seg.evictedReason,
		...(seg.cardsCancelled === true ? { cardsCancelled: true } : {}),
		operatorGrant: seg.operatorGrant,
		grantedBy: seg.grantedBy,
		autoApproved: seg.autoApproved,
		...shellActor(seg, nameRequester),
	};
	const options = { unbounded, diffStyle: seg.replayed ? ("plain" as const) : ("color" as const) };
	if (unbounded && seg.finished) return renderToolExecution(finished, width, options);
	if (seg.finished) return renderToolPreview(finished, width, detail, { ...options, terminalRows });
	seg.live ??= new LiveToolView();
	// A command the model asked for keeps running until its process exits, so a stop that went out is its own row.
	const stopRow =
		stopRequestedAt !== null && seg.executionStarted && shellActor(seg).actor !== undefined
			? [stopSentRow(Math.max(0, nowMs - stopRequestedAt), width)]
			: [];
	// A started process names who runs it while it runs, as its settled row does, so a stop reads `PanCode is stopping`.
	const running = seg.executionStarted ? { ...call, ...shellActor(seg, nameRequester) } : call;
	const rows = renderToolPreview(stopRow.length > 0 ? { ...running, stopping: true } : running, width, detail, {
		...options,
		terminalRows,
		partialResult: seg.partialResult,
		live: seg.live,
		...(seg.previewDiff !== undefined ? { previewDiff: seg.previewDiff } : {}),
	});
	return [...rows, ...stopRow];
}

/**
 * Shell-class calls say who started the process. Anything else already reads as a named action.
 * The requesting model is named only where the turn's `Reply from` row does not already settle it.
 */
function shellActor(seg: ToolSegment, nameRequester = true): { actor?: "harness"; requestedBy?: string } {
	if (seg.name !== ToolNames.Bash && seg.name !== ToolNames.RunScript) return {};
	return {
		actor: "harness",
		...(nameRequester && seg.requestedBy !== undefined ? { requestedBy: seg.requestedBy } : {}),
	};
}

/** A finished call changes only when a late result upgrades it or a worker card attaches to it. */
export function changeSettledCall(seg: ToolSegment): void {
	seg.settledRows = undefined;
	seg.settledFold = undefined;
	seg.settledFamily = undefined;
	seg.settledRevision = (seg.settledRevision ?? 0) + 1;
}

/** Arguments still forming can stop anywhere inside a URL, so they show only what cannot become its userinfo (#446). */
export function shownArgs(seg: ToolSegment): unknown {
	return seg.argsComplete ? seg.args : holdUnresolvedStrings(seg.args);
}

/** Room past the invocation rows' character budget, so redaction and sanitizing near the cut never reach the rows shown. */
const FORMING_ARG_SLACK_CHARS = 4096;
/** Tools whose forming payload renders as a streamed tail (`LiveToolView`), not as the head of an argument. */
const TAIL_PAYLOAD_TOOLS: ReadonlySet<string> = new Set([ToolNames.Write, ToolNames.Edit]);

/**
 * The arguments a forming row paints from. Its preview shows the head of each argument, at most the invocation rows
 * at four characters a cell (`renderToolArguments`), so a long string is cut well past that, exactly as if the stream
 * had stopped there, and the cut is held like any stream end (#446). Redacting and laying out a 130 KB heredoc on
 * every frame cost 25-30 ms; a frame now costs the rows it shows (x6-7b). Settled arguments are never cut.
 */
function formingPreviewArgs(seg: ToolSegment, width: number, detail: TranscriptDetailPolicy, terminalRows: number) {
	if (seg.argsComplete || TAIL_PAYLOAD_TOOLS.has(seg.name)) return shownArgs(seg);
	const cap = 4 * Math.max(1, width) * previewBudget(detail.invocationRows, terminalRows) + FORMING_ARG_SLACK_CHARS;
	return holdUnresolvedStrings(headOfStrings(seg.args, cap));
}

function headOfStrings(value: unknown, cap: number, depth = 0): unknown {
	if (typeof value === "string") {
		if (value.length <= cap) return value;
		const code = value.charCodeAt(cap - 1);
		return value.slice(0, code >= 0xd800 && code <= 0xdbff ? cap - 1 : cap);
	}
	if (depth > 8 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => headOfStrings(item, cap, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = headOfStrings(item, cap, depth + 1);
	return out;
}

/** A settled tool segment as the renderers read a finished call. */
export function finishedCall(seg: ToolSegment, nameRequester = true): ToolExecutionFinished {
	return {
		toolCallId: seg.id,
		toolName: seg.name,
		args: shownArgs(seg),
		result: seg.result,
		isError: seg.isError,
		durationMs: seg.durationMs,
		outcome: seg.settlement,
		notRun: seg.notRun,
		notRunCause: seg.notRunCause,
		blockReason: seg.blockReason,
		evictedReason: seg.evictedReason,
		resultSummary: seg.resultSummary,
		actionClass: seg.actionClass,
		cardAttached: seg.cardAttached,
		...(seg.cardsCancelled === true ? { cardsCancelled: true } : {}),
		operatorGrant: seg.operatorGrant,
		grantedBy: seg.grantedBy,
		autoApproved: seg.autoApproved,
		...shellActor(seg, nameRequester),
	};
}

/**
 * The Compact fold a settled tool segment joins, or null when it keeps its own row. Only clean reads fold: a failed,
 * blocked or not-run call keeps its row and its reason, an operator-granted call keeps the grant a fold row cannot
 * name, and a change is news rather than exploration, so a fold row only ever counts clean calls and ends in `✓`.
 */
export function foldFamily(seg: AssistantSegment | undefined): ToolFoldFamily | null {
	if (seg?.kind !== "tool" || !seg.finished) return null;
	if (
		seg.operatorGrant !== undefined ||
		seg.isError ||
		seg.settlement !== undefined ||
		seg.blockReason !== undefined ||
		seg.notRun === true
	)
		return null;
	if (seg.settledFamily === undefined) seg.settledFamily = toolFoldFamily(finishedCall(seg));
	return seg.settledFamily === "mutate" ? null : seg.settledFamily;
}

/**
 * Whether a tool block opens a blank row on both sides. Compact stacks every tool row. Elsewhere a body (arguments,
 * output, a diff) opens a gap, except a failure's own reason rows, which belong to its row as its wrap does.
 */
export function toolBlockGap(
	body: boolean,
	lines: readonly string[],
	failed: boolean,
	detail: TranscriptDetailPolicy,
): boolean {
	if (!body || !detail.evidence) return false;
	if (!failed) return true;
	const rail = cardRail();
	return lines.some((line) => line.startsWith(rail));
}

/** A settled call that failed or was refused, whose reason rows hang under its row. */
export function failedCall(seg: ToolSegment): boolean {
	return seg.finished && (seg.isError || seg.settlement !== undefined || seg.blockReason !== undefined);
}

/** A task a dispatch call names, for its row before its worker exists. */
type DispatchTask = { agent: string; task: string };
/** Modes whose workers are the call's tasks one for one; compete, council and review add or merge runs. */
const ONE_RUN_PER_TASK: ReadonlySet<unknown> = new Set([undefined, "parallel", "sequential", "pipeline"]);
/** Rows nested under a dispatch header indent 2 cells (2.2). */
const NESTED_INDENT = "  ";

/** The tasks a dispatch call's arguments name, in order, or none when their shape says nothing certain. */
function dispatchTasks(seg: ToolSegment): DispatchTask[] {
	const args = seg.args;
	if (seg.name !== "dispatch" || args === null || typeof args !== "object") return [];
	const record = args as Record<string, unknown>;
	if (!ONE_RUN_PER_TASK.has(record.mode) || record.review !== undefined) return [];
	const shared = typeof record.agent === "string" ? record.agent : undefined;
	const items: unknown[] = Array.isArray(record.tasks)
		? record.tasks
		: typeof record.task === "string" && record.task.length > 0
			? [record.task]
			: [];
	const tasks: DispatchTask[] = [];
	for (const item of items) {
		const fields = item !== null && typeof item === "object" ? (item as { agent?: unknown; task?: unknown }) : null;
		const task = typeof item === "string" ? item : typeof fields?.task === "string" ? fields.task : null;
		if (task === null) return [];
		const agent = typeof fields?.agent === "string" ? fields.agent : shared;
		tasks.push({ agent: agent === undefined || agent === "auto" ? "worker" : agent, task });
	}
	return tasks;
}

/**
 * The call's tasks no placed worker answers for yet, while the call is past admission and still running: matched by
 * task text, and never more than the tasks named minus the workers placed, so a task never shows as queued beside its
 * own row. A call that is denied, fails or ends draws none.
 */
export function unplacedTasks(seg: ToolSegment, placed: ReadonlyArray<WorkerEntryState>): DispatchTask[] {
	if (
		seg.name !== "dispatch" ||
		seg.finished ||
		!seg.executionStarted ||
		!seg.argsComplete ||
		seg.awaitingApproval === true ||
		seg.judging === true
	)
		return [];
	const tasks = dispatchTasks(seg);
	const open = [...tasks];
	for (const state of placed) {
		const at = open.findIndex((candidate) => candidate.task === state.task);
		if (at >= 0) open.splice(at, 1);
	}
	return open.slice(0, Math.max(0, tasks.length - placed.length));
}

/** Queued run rows for tasks whose workers have not started, in the run row grammar the worker rows use (6.1). */
export function queuedRunRows(tasks: ReadonlyArray<DispatchTask>, width: number): string[] {
	if (tasks.length === 0) return [];
	const theme = pancodeTheme();
	const room = Math.max(1, width - NESTED_INDENT.length);
	const facts: RunFacts[] = tasks.map((task) => ({
		agent: sanitizeCallTargetText(task.agent),
		origin: "model",
		outcome: "queued",
		task: `queued ${GLYPH.dot} ${redactSecretString(sanitizeCallTargetText(task.task)).replace(/\s+/gu, " ").trim()}`,
	}));
	const identityWidth = runIdentityWidth(facts, visibleWidth);
	return facts.map(
		(fact) =>
			`${NESTED_INDENT}${runRow(fact, { width: room, identityWidth, measure: visibleWidth })
				.cells.map(
					(cell) => `${cell.lead}${theme.fg(cell.role, `${cell.glyph === undefined ? "" : GLYPH[cell.glyph]}${cell.text}`)}`,
				)
				.join("")}`,
	);
}

/** Where a live dispatch's queued rows go: under its row until a worker is placed, then under the group's last card. */
export type QueuedRows = {
	call(seg: ToolSegment, width: number, detail: TranscriptDetailPolicy): string[];
	card(entry: WorkerTranscriptEntry, width: number, detail: TranscriptDetailPolicy): string[];
};
