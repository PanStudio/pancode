// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The run table: columns by tier and width, the status and activity cells, and the table rows. */
import { type BoardColumn, tierPolicy } from "../core/presentation-tier.js";
import { USAGE_NOT_MEASURED } from "../core/views/usage-words.js";
import type { CompletedRunCaveat } from "../domains/dispatch/failure-headline.js";
import { workerFailureHeadline } from "../domains/dispatch/failure-headline.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactStreamingSecretString } from "../domains/safety/redaction.js";
import { isStructuredAnswerText } from "../domains/telemetry/worker-progress.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import type { CouncilGroupView } from "./council-grid.js";
import { type DispatchBoardItem, earlierSessionsRule, itemFromEarlierSession } from "./dispatch-board-items.js";
import { planProgressText, planWarnedStepCount } from "./dispatch-plan-card.js";
import {
	actionPhrase,
	agentDisplayLabel,
	boundMark,
	completedRunFailure,
	type DispatchBoardRow,
	dispatchRowPrefix,
	dispatchStatusPresentation,
	dispatchUsageText,
	isTerminalStatus,
	retryCountdown,
	SEP,
	terminalDetail,
} from "./dispatch-row-model.js";
import type { QuotaProviders } from "./quota-view.js";
import { routeWeeklyQuota } from "./quota-view.js";
import type { PancodeTheme } from "./theme/index.js";
import {
	formatCount,
	formatElapsed,
	GLYPH,
	padAnsi,
	pancodeTheme,
	type TableCell,
	type TableColumn,
	tableRows,
	toneRole,
	widthClass,
} from "./theme/index.js";
import { approvalWaitWords, compactQuantity, completedRunMark, workerActivityWords } from "./worker-activity.js";

export interface RunTableOptions {
	/** The run under the cursor; when given, every row reserves the cursor column. */
	selectedRunId?: string | null;
	/** A dashboard page: the fleet phase and node columns stay on the board. */
	compact?: boolean;
	tick?: number;
	now?: number;
	/** Shared account limits, so a run on a metered account names its weekly figure. */
	quota?: QuotaProviders;
	/** A finished run says where its record is, in place of its task. */
	inspectFinished?: boolean;
	/** The seat credits a run debited, its cost where its route priced no USD. */
	creditsOf?: (runId: string) => string | null;
}

/** A table cell with no value yet, or one nothing measured (2.9); the selected run's facts say which, once. */
const NO_VALUE = GLYPH.none;

/**
 * A token figure for a right-aligned column in the count form (`39.4k`), its lower-bound or estimate mark kept. The
 * read model's coverage clause is longer than the column; the run's facts and record carry it.
 */
function tableFigure(display: string): string {
	const figure = compactQuantity(display);
	if (figure === null) return NO_VALUE;
	const match = /^(≥|≈|~|>=)?([\d,]+)$/u.exec(figure);
	if (match?.[2] === undefined) return boundMark(figure);
	return boundMark(`${match[1] ?? ""}${formatCount(Number(match[2].replaceAll(",", "")))}`);
}

function firstLine(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
	return sanitizeCallTargetText(line.trim());
}

/** A council by its size; one whose members are past the board's history reads as a council alone. */
export function councilName(group: Pick<CouncilGroupView, "members">): string {
	return group.members.length === 0 ? "council" : `council of ${group.members.length}`;
}

const NARROW_STATUS_WIDTH = 100;
const COMPACT_CAVEAT_WORD: Readonly<Record<CompletedRunCaveat["kind"], string>> = {
	against: "failed",
	refused: "done",
	"no-tools": "no tools",
};

/** A live run parked on an ask that this session's operator answers: its state is the wait (2.7), not `running`. */
function waitsOnOperator(row: Pick<DispatchBoardRow, "status" | "progress">): boolean {
	if (row.status !== "running" || row.progress?.awaitingApproval !== true) return false;
	const window = row.progress.approvalWindow;
	return window === undefined || (window.decider === "operator" && window.owner === undefined);
}

/**
 * The status cell: the outcome glyph in its tone, then the word, the same pair every surface uses. `glyphOnly` is the
 * one-column form under 44 cells, where running, queued and a clean done keep only their glyph; a failure, a warning
 * and a wait on the operator keep their word at every width (2.7).
 */
export function runStatusCell(
	theme: PancodeTheme,
	row: DispatchBoardRow,
	tick: number | undefined,
	width: number,
	glyphOnly = false,
): string {
	// A plan whose worker steps finished with warnings reads as its card does, never as a clean done.
	if (row.plan !== undefined && row.plan.state === "passed" && planWarnedStepCount(row.plan) > 0) {
		return theme.fg("warning", `${GLYPH.warn} ${width >= NARROW_STATUS_WIDTH ? "done with warnings" : "warnings"}`);
	}
	const failure = completedRunFailure(row);
	// The caveat replaces `done` rather than trailing it: the mark already says the run finished, and the status
	// column stays narrow enough that the task beside it still reads.
	if (failure !== null) {
		const mark = completedRunMark(failure);
		// Below a hundred columns the cell keeps the worker card header's one word, so the agent column survives; the
		// detail under the table states the caveat whole.
		const words =
			width >= NARROW_STATUS_WIDTH
				? failure.words
				: failure.kind === "refused"
					? `${row.completion?.refusedCalls ?? 1} ${row.completion?.guardedCalls === row.completion?.refusedCalls ? "guarded" : "refused"}`
					: COMPACT_CAVEAT_WORD[failure.kind];
		return theme.fg(mark.token, `${mark.glyph} ${words}`);
	}
	if (waitsOnOperator(row)) return theme.fg("attention", `${GLYPH.phaseBlocked} needs approval`);
	const full = dispatchStatusPresentation(row.status, {
		...(row.status === "running" && tick !== undefined ? { tick } : {}),
	});
	// A table has room for the whole word; only `completed` shortens, to the word the island uses.
	const presentation = row.status === "completed" ? { ...full, label: "done" } : full;
	const token =
		row.status === "running" && (row.agentAudience === "shadow" || row.agentAudience === "internal")
			? "shadowDispatchAction"
			: presentation.token;
	const glyph = theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph);
	if (glyphOnly && (row.status === "running" || row.status === "enqueued" || row.status === "completed")) return glyph;
	return `${glyph} ${theme.fg(token, presentation.label)}`;
}

/** Share of the worker's window its last reply occupied; warning tone from this share up (CLI-H3). */
const CONTEXT_FILL_WARNING = 0.8;

/** A live worker's context fill ahead of its activity, so a parent sees a run filling up before it hits the wall. */
function withContextFill(theme: PancodeTheme, row: DispatchBoardRow, cell: TableCell): TableCell {
	const window = row.contextWindow ?? 0;
	if (row.lastContextTokens === null || !(window > 0)) return cell;
	const fill = row.lastContextTokens / window;
	const label = theme.fg(
		fill >= CONTEXT_FILL_WARNING ? "warning" : "muted",
		`ctx ${Math.min(100, Math.round(fill * 100))}%`,
	);
	return { ...cell, text: cell.text.length > 0 ? `${label}${SEP}${cell.text}` : label };
}

export function liveActivityCell(
	theme: PancodeTheme,
	row: DispatchBoardRow,
	room: number | undefined,
	task: string | null,
): TableCell {
	const progress = row.progress;
	if (progress) {
		if (progress.awaitingApproval === true) {
			return { text: approvalWaitWords(progress, room === undefined ? {} : { room }), tone: "warning" };
		}
		if (progress.currentAction) return { text: theme.base("body", actionPhrase(progress.currentAction, "running")) };
		const words = sanitizeCallTargetText(workerActivityWords(progress, { history: row.routeFirstOutput ?? null }));
		const line =
			progress.phase === "writing"
				? firstLine(redactStreamingSecretString(progress.tailText, progress.completed === true))
				: "";
		// A worker writing its JSON report says it is writing; the report's first line is not prose.
		const tail = isStructuredAnswerText(line) ? "" : line;
		return { text: `${theme.fg("dispatchAction", words)}${tail ? ` ${theme.fg("assistantProse", tail)}` : ""}` };
	}
	if (row.currentTool) return { text: `${sanitizeCallTargetText(row.currentTool)} running` };
	return { text: task ?? "" };
}

/** What a run is doing, or how it ended, in one clause the row may clip. `room` picks an approval wait's form. */
export function runActivityCell(theme: PancodeTheme, row: DispatchBoardRow, now: number, room?: number): TableCell {
	if (row.plan !== undefined) {
		return { text: planProgressText(row.plan, true), ...(row.plan.state === "failed" ? { tone: "error" as const } : {}) };
	}
	const task = row.taskSummary ? sanitizeCallTargetText(row.taskSummary) : null;
	switch (row.status) {
		case "running":
		case "stale":
			return withContextFill(theme, row, liveActivityCell(theme, row, room, task));
		case "cancelling":
			// The worker is being stopped; its last phase would read as work finishing normally.
			return { text: "waiting for it to exit", tone: "warning" };
		case "retrying":
			return row.retry
				? {
						text: `attempt ${row.retry.attempt}${SEP}${retryCountdown(row.retry, now)}${row.retry.reason ? `${SEP}${sanitizeCallTargetText(row.retry.reason)}` : ""}`,
						tone: "warning",
					}
				: { text: task ?? "retrying", tone: "warning" };
		case "enqueued":
			// The wait's cause outranks the task, which the card under the table still states.
			return {
				text: row.endpoint
					? `waiting for a slot on ${sanitizeCallTargetText(row.endpoint.label)}`
					: "waiting for a worker slot",
				tone: "muted",
			};
		case "failed":
		case "dead":
			return { text: workerFailureHeadline(terminalDetail(row)) ?? task ?? "", tone: "error" };
		case "aborted":
			return { text: workerFailureHeadline(terminalDetail(row)) ?? task ?? "", tone: "muted" };
		case "completed":
			return { text: task ?? "", tone: "muted" };
	}
}

/** Board columns in the order they print. */
const BOARD_COLUMN_ORDER: readonly BoardColumn[] = [
	"state",
	"agent",
	"time",
	"in",
	"out",
	"cost",
	"node",
	"account",
	"text",
];

const BOARD_HEADER: Readonly<Record<BoardColumn, string>> = {
	state: "state",
	agent: "agent",
	time: "time",
	in: "in",
	out: "out",
	cost: "cost",
	node: "node",
	account: "account",
	text: `now ${GLYPH.sep} task`,
};

/** The order columns leave when the width cannot hold them, first to go first (6.5); a column absent never drops. */
const BOARD_DROP_RANK: Readonly<Partial<Record<BoardColumn, number>>> = {
	account: 1,
	node: 2,
	cost: 3,
	in: 4,
	out: 5,
	time: 6,
};

/** What a column dropped for width holds, in the words the selected run's facts use. */
const BOARD_COLUMN_FACT: Readonly<Partial<Record<BoardColumn, string>>> = {
	time: "time",
	in: "tokens",
	out: "tokens",
	cost: "cost",
	node: "node",
	account: "account",
};

const RIGHT_ALIGNED: ReadonlySet<BoardColumn> = new Set(["time", "in", "out", "cost"]);

/**
 * The text column keeps twelve cells in a W2 table and three tenths of the row from W3, so a quieter column drops
 * before the text is cut to a stub: at 76 cells a node or an account leaves before the task does.
 */
function boardTextMin(width: number): number {
	return widthClass(width) === "W2" ? 12 : Math.max(12, Math.ceil(width * 0.3));
}
export const BOARD_GAP = 2;
/** Under sixty cells one long state (`✗ stopped responding`) would set the column for every row. */
const NARROW_STATE_MAX = 14;

/**
 * The columns the tier offers at the measured width's class (6.5, 2.3): time from W2, the telemetry columns from W3,
 * and optional columns (`cost`, `node`, `account`) only when at least one listed row carries a real value.
 * W1 is one column and has no header.
 */
function boardColumns(width: number, anyNode: boolean, anyAccount: boolean, anyCost: boolean): BoardColumn[] {
	const offered = new Set(tierPolicy().boardColumns);
	const measured = widthClass(width);
	return BOARD_COLUMN_ORDER.filter((column) => {
		if (!offered.has(column)) return false;
		if (column === "state" || column === "agent" || column === "text") return true;
		if (column === "time") return measured !== "W1";
		if (column === "cost" && !anyCost) return false;
		if (column === "node" && !anyNode) return false;
		if (column === "account" && !anyAccount) return false;
		return measured !== "W1" && measured !== "W2";
	});
}

function listWords(words: readonly string[]): string {
	return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** The one supporting row that names the columns this width dropped and where their facts are read. */
function droppedColumnsNote(theme: PancodeTheme, dropped: readonly BoardColumn[], width: number): string | null {
	if (dropped.length === 0) return null;
	const columns = BOARD_COLUMN_ORDER.filter((column) => dropped.includes(column));
	const names = `${listWords(columns.map((column) => BOARD_HEADER[column]))} column${columns.length === 1 ? "" : "s"} hidden`;
	const facts = listWords([...new Set(columns.map((column) => BOARD_COLUMN_FACT[column] ?? column))]);
	const sep = ` ${GLYPH.sep} `;
	const forms = [`${names}${sep}widen the window, or [Enter] for the run's ${facts}`, `${names}${sep}widen the window`];
	const fitted =
		forms.find((form) => visibleWidth(form) <= width) ?? truncateToWidth(names, width, GLYPH.ellipsis, false);
	return theme.fg("annotation", fitted);
}

type BoardCells = Partial<Record<BoardColumn, string | TableCell>>;

interface BoardCellContext {
	cursor: boolean;
	selectedRunId: string | null | undefined;
	width: number;
	now: number;
	tick: number | undefined;
	quota: QuotaProviders;
	anyAccount: boolean;
	inspectFinished: boolean;
	glyphOnly: boolean;
	creditsOf: ((runId: string) => string | null) | undefined;
}

function cursorLead(theme: PancodeTheme, context: BoardCellContext, selected: boolean): string {
	if (!context.cursor) return "";
	return `${selected ? theme.fg("selectedOption", GLYPH.cursor) : " "} `;
}

/** A run's text: live rows say what they are doing, then the task (6.1); every other state reads as its cell says. */
function runTextCell(theme: PancodeTheme, row: DispatchBoardRow, context: BoardCellContext): TableCell {
	if (context.inspectFinished && isTerminalStatus(row.status) && row.plan === undefined)
		return { text: `/view dispatch:${row.runId}`, tone: "muted" };
	const cell = runActivityCell(theme, row, context.now);
	const live = row.status === "running" || row.status === "stale";
	const task = row.taskSummary ? sanitizeCallTargetText(row.taskSummary) : null;
	if (!live || row.plan !== undefined || task === null || row.progress?.awaitingApproval === true) return cell;
	// The phase words, then the task; a run with no phase yet reads as its task alone.
	const words = liveActivityCell(theme, row, undefined, null).text;
	const text = words.length === 0 ? task : `${words}${theme.fg("separator", ` ${GLYPH.sep} `)}${theme.fg("body", task)}`;
	return withContextFill(theme, row, { text });
}

function itemCells(theme: PancodeTheme, item: DispatchBoardItem, context: BoardCellContext): BoardCells {
	if (item.kind === "council") {
		const group = item.group;
		const selected = group.selectedRunId !== undefined;
		// The group id is the record's; a person knows the council by its size and its question.
		const name = councilName(group);
		return {
			state: `${cursorLead(theme, context, selected)}${theme.fg(group.status.glyphToken ?? group.status.token, group.status.glyph)} ${theme.fg(group.status.token, group.status.label)}`,
			agent: selected ? theme.style("selectedOption", name, { bold: true }) : theme.fg("dispatchAction", name),
			time: group.elapsed,
			text: {
				// A one-round council has no round worth naming; a synthesis is the council's own answer, so it says so.
				text: [
					...(group.task === undefined ? [] : [group.task]),
					...(group.round > 1 ? [`round ${group.round}`] : []),
					...(group.synthesis === null ? [] : ["with a synthesis"]),
				].join(` ${GLYPH.sep} `),
				tone: "muted",
			},
		};
	}
	const row = item.row;
	const selected = context.cursor && row.runId === context.selectedRunId;
	const prefix = dispatchRowPrefix(theme, row);
	const label = agentDisplayLabel(row);
	// A plan step's worker carries its step on its name, `coder · map-stats`, so two workers of one plan never read
	// the same when the table is narrow.
	const step =
		row.phase === undefined || row.plan !== undefined
			? ""
			: theme.fg("info", ` ${GLYPH.sep} ${sanitizeCallTargetText(row.phase.stepId)}`);
	const cells: BoardCells = {
		state: `${cursorLead(theme, context, selected)}${runStatusCell(theme, row, context.tick, context.width, context.glyphOnly)}`,
		agent: `${prefix.text}${selected ? theme.style("selectedOption", label, { bold: true }) : theme.fg("workerIdentity", label)}${step}`,
		time: row.telemetry?.activity.elapsed.display ?? (row.status === "enqueued" ? "" : formatElapsed(row.elapsedMs)),
		node: row.node ?? "local",
		text: runTextCell(theme, row, context),
	};
	if (row.plan !== undefined) {
		// A plan's workers have their own rows, so its row sums nothing a reader could mistake for measured.
		cells.cost = { text: row.plan.costText ?? NO_VALUE, tone: "muted" };
		cells.node = "";
		return cells;
	}
	const usage = dispatchUsageText(row.usage);
	const figure = (display: string): TableCell =>
		row.usage.kind === "ready" ? { text: tableFigure(display) } : { text: NO_VALUE, tone: "muted" };
	cells.in = figure(usage.prompt);
	cells.out = figure(usage.output);
	// A cost nothing measured is the dash; the selected run's facts say why, once.
	const usd = row.usage.kind === "ready" ? compactQuantity(usage.cost) : null;
	const cost = usd === null || usd === USAGE_NOT_MEASURED ? (context.creditsOf?.(row.runId) ?? null) : usd;
	cells.cost = cost === null ? { text: NO_VALUE, tone: "muted" } : { text: cost };
	const weekly = context.anyAccount ? routeWeeklyQuota(row, context.quota) : null;
	if (weekly !== null)
		cells.account = {
			text: weekly.label,
			tone: weekly.severity === "critical" ? "error" : weekly.severity === "normal" ? "muted" : "warning",
		};
	return cells;
}

export function paintedCell(theme: PancodeTheme, cell: string | TableCell | undefined): string {
	if (cell === undefined) return "";
	if (typeof cell === "string") return cell;
	return cell.text.includes("\u001b") ? cell.text : theme.fg(toneRole(cell.tone ?? "neutral"), cell.text);
}

export interface RunTable {
	/** The column labels, absent under 44 cells where the table is one column. */
	header: string | null;
	/** One row per item, in item order. */
	rows: string[];
	/** The supporting row naming columns dropped for width. */
	note: string | null;
}

/**
 * The run table (6.5): columns from the tier's `boardColumns` and the measured width's class, a header at every tier,
 * the text column taking the rest and clipping, and quieter columns dropping in their fixed order before the text
 * would fall under its floor, named once by a supporting row. Under 44 cells it is one column.
 */
export function runTable(items: ReadonlyArray<DispatchBoardItem>, width: number, options: RunTableOptions): RunTable {
	const theme = pancodeTheme();
	const safe = Math.max(1, Math.floor(width));
	const runs = items.flatMap((item) => (item.kind === "run" ? [item.row] : []));
	const quota = options.quota ?? [];
	const anyNode = options.compact !== true && runs.some((row) => row.node !== undefined && row.node !== "local");
	const anyAccount = runs.some((row) => routeWeeklyQuota(row, quota) !== null);
	const oneColumn = widthClass(safe) === "W1";
	const context: BoardCellContext = {
		cursor: options.selectedRunId !== undefined,
		selectedRunId: options.selectedRunId,
		width: safe,
		now: options.now ?? Date.now(),
		tick: options.tick,
		quota,
		anyAccount,
		inspectFinished: options.inspectFinished === true,
		glyphOnly: oneColumn,
		creditsOf: options.creditsOf,
	};
	const cells = items.map((item) => itemCells(theme, item, context));
	const anyCost = cells.some((cell) => {
		const raw = cell.cost;
		if (raw === undefined) return false;
		const plain = stripPaint(typeof raw === "string" ? raw : raw.text).trim();
		return plain.length > 0 && plain !== NO_VALUE;
	});
	if (oneColumn) {
		// State, identity and text flow in one column; identities pad to one width so the text starts together.
		const identities = cells.map((cell) => paintedCell(theme, cell.agent));
		const identityWidth = Math.max(0, ...identities.map((identity) => visibleWidth(identity)));
		const rows = cells.map((cell, index) => {
			const line = `${paintedCell(theme, cell.state)} ${padAnsi(identities[index] ?? "", identityWidth)}  ${paintedCell(theme, cell.text)}`;
			return visibleWidth(line) <= safe ? line : truncateToWidth(line, safe, GLYPH.ellipsis, false);
		});
		return { header: null, rows, note: null };
	}
	const label = (column: BoardColumn): string =>
		column === "state" && context.cursor ? `  ${BOARD_HEADER.state}` : BOARD_HEADER[column];
	const cap = (column: BoardColumn): number =>
		column === "state" && safe < 60
			? NARROW_STATE_MAX + (context.cursor ? 2 : 0)
			: column === "agent"
				? 30
				: column === "node"
					? 12
					: Number.POSITIVE_INFINITY;
	const natural = (column: BoardColumn): number =>
		Math.min(
			cap(column),
			Math.max(visibleWidth(label(column)), ...cells.map((cell) => visibleWidth(paintedCell(theme, cell[column])))),
		);
	let kept = boardColumns(safe, anyNode, anyAccount, anyCost).filter((column) => column !== "text");
	const dropped: BoardColumn[] = [];
	const used = (): number => kept.reduce((sum, column) => sum + natural(column) + BOARD_GAP, 0);
	while (used() + boardTextMin(safe) > safe) {
		const next = kept
			.filter((column) => BOARD_DROP_RANK[column] !== undefined)
			.sort((a, b) => (BOARD_DROP_RANK[a] ?? 0) - (BOARD_DROP_RANK[b] ?? 0))[0];
		if (next === undefined) break;
		kept = kept.filter((column) => column !== next);
		dropped.push(next);
	}
	const textRoom = Math.max(1, safe - used());
	// An approval wait is what its run is blocked on, so it is worded for the room the text column has.
	items.forEach((item, index) => {
		const cell = cells[index];
		if (item.kind !== "run" || item.row.plan !== undefined || cell === undefined) return;
		if (item.row.progress?.awaitingApproval !== true || isTerminalStatus(item.row.status)) return;
		cell.text = runActivityCell(theme, item.row, context.now, textRoom);
	});
	const order: BoardColumn[] = [...kept, "text"];
	const columns: TableColumn[] = order.map((column) => ({
		label: label(column),
		min: 1,
		max: column === "text" ? textRoom : natural(column),
		priority: 10,
		...(RIGHT_ALIGNED.has(column) ? { align: "right" as const } : {}),
		...(column === "time" ? { tone: "muted" as const } : {}),
	}));
	const lines = tableRows(
		theme,
		{ columns, rows: cells.map((cell) => order.map((column) => cell[column] ?? "")), header: true },
		safe,
	);
	// The header row stands alone over the runs; the table primitive's underline is not part of the board (6.5).
	return {
		header: lines[0] ?? null,
		rows: lines.slice(2, 2 + items.length),
		note: droppedColumnsNote(theme, dropped, safe),
	};
}

/**
 * One row per run (a council is one row), the shape every list of runs shares (6.5): a header naming the columns,
 * the rows, then one supporting row when the width dropped a column the tier offers. The tier comes from
 * `tierPolicy()`.
 */
export function runTableRows(
	items: ReadonlyArray<DispatchBoardItem>,
	width: number,
	options: RunTableOptions = {},
): string[] {
	const table = runTable(items, width, options);
	const rows = [...table.rows];
	// What an earlier PanCode recorded sits under the board's own rule here too, so a list of runs reads as the board does.
	const firstEarlier = items.findIndex(itemFromEarlierSession);
	if (firstEarlier >= 0) {
		const safe = Math.max(1, Math.floor(width));
		rows.splice(firstEarlier, 0, earlierSessionsRule(pancodeTheme(), items.length - firstEarlier, safe));
	}
	return [...(table.header === null ? [] : [table.header]), ...rows, ...(table.note === null ? [] : [table.note])];
}

/** The run identity the board's detail rule names: the agent and its run id. */
export function runRuleTitle(row: DispatchBoardRow): string {
	// A plan is known by its name; its root id is for the shell command its detail gives.
	if (row.plan !== undefined) return agentDisplayLabel(row);
	return `${agentDisplayLabel(row)}${SEP}${row.runId}`;
}

export function rowSignature(row: DispatchBoardRow): string {
	return [
		row.runId,
		row.status,
		row.telemetry?.activity.elapsed.display ?? row.elapsedMs,
		row.usage.kind === "ready" ? `${row.usage.total.display}/${row.usage.usd.display}` : row.usage.kind,
		row.ttft,
		row.progress ? `${row.progress.phase}:${row.progress.tailText.length}:${row.progress.recentActions.length}` : "",
		row.currentTool ?? "",
		row.recentTools?.length ?? 0,
		row.retry ? `${row.retry.attempt}@${row.retry.dueAtMs}` : "",
		row.steerAcknowledgement?.receivedAtMs ?? "",
		row.trust?.verdict ?? "",
		row.hostVerification ?? "",
		row.outcomeDetail ?? "",
		row.phase ? `${row.phase.wave}/${row.phase.stepId}` : "",
		row.node ?? "",
		row.taskSummary?.length ?? 0,
		row.plan ? row.plan.steps.map((step) => step.state).join(",") : "",
	].join("|");
}

/** A painted row's text, for reading its shape. */
export function stripPaint(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: only the row's escape sequences are removed.
	return text.replace(/\u001b\[[0-9;]*m/gu, "");
}
