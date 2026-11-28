// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { formatElapsed } from "../core/format-time.js";
import { type BoardFact, tierPolicy, tierRevision } from "../core/presentation-tier.js";
import { USAGE_NOT_MEASURED, usageLineFigure } from "../core/views/usage-words.js";
import { foregroundStreamUsage } from "../domains/providers/index.js";
import type { TelemetrySnapshot } from "../domains/telemetry/index.js";
import type { Component } from "../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { sanitizeCallTargetText } from "../lib/call-target/call-target.js";
import { councilGroupBody } from "./council-grid.js";
import {
	type DispatchBoardItem,
	dispatchBoardItems,
	earlierSessionsRule,
	formatRowRoute,
	itemFromEarlierSession,
	selectableBoardRows,
} from "./dispatch-board-items.js";
import {
	actionPhrase,
	boundMark,
	cardUnitsLine,
	cardWrappedValueLines,
	completedRunFailure,
	type DispatchBoardRow,
	deriveRunEvidenceState,
	dispatchUsageText,
	isDispatchBoardRowCancellable,
	isDispatchBoardRowSteerable,
	isTerminalStatus,
	type RunEvidencePresentation,
	runOriginWords,
	SEP,
} from "./dispatch-row-model.js";
import {
	BOARD_GAP,
	councilName,
	liveActivityCell,
	paintedCell,
	type RunTable,
	rowSignature,
	runActivityCell,
	runRuleTitle,
	runStatusCell,
	runTable,
	stripPaint,
} from "./dispatch-run-table.js";
import { dispatchCardBody, evidenceCardLine, progressActionLine, trustCardLines } from "./dispatch-worker-card.js";
import { DOCK_BODY_ROWS_MAX } from "./dock.js";
import {
	centeredWindow,
	cutRowWithEllipsis,
	fitHintEntryList,
	type GrowableBody,
	type HintEntry,
	type RowBudgetedBody,
	windowRows,
} from "./overlay-frame.js";
import { confirmOnceRail } from "./overlays/confirm-once.js";
import type { PancodeTheme } from "./theme/index.js";
import { emptyState, GLYPH, padAnsi, pancodeTheme, positionRow, sectionRule, widthClass } from "./theme/index.js";
import { keyName } from "./theme/labels.js";
import { skinEpoch } from "./theme/tokens.js";
import { compactQuantity, completedRunMark } from "./worker-activity.js";

export { USAGE_NOT_MEASURED } from "../core/views/usage-words.js";
export const USAGE_NO_CALLS = "no calls yet";

/** A route's slots in use and waiting, counted across the board. */
interface EndpointLoad {
	active: number;
	queued: number;
}

/** What the selected run is doing now, or how it ended: its `doing` fact, which no tier leaves out. */
function doingLines(theme: PancodeTheme, row: DispatchBoardRow, width: number, now: number): string[] {
	const live = row.status === "running" || row.status === "stale";
	if (row.progress !== undefined && !isTerminalStatus(row.status)) {
		const line = progressActionLine(theme, row.progress, width, row.routeFirstOutput ?? null);
		if (line !== null) return [line];
	}
	if (row.status === "completed" && row.plan === undefined) {
		const failure = completedRunFailure(row);
		const words =
			failure === null ? theme.fg("body", "finished") : theme.fg(completedRunMark(failure).token, failure.words);
		return [cardUnitsLine(theme, "doing", [words], width)];
	}
	const cell = live ? liveActivityCell(theme, row, undefined, null) : runActivityCell(theme, row, now);
	const text = cell.text.length > 0 ? cell.text : "starting";
	return [cardUnitsLine(theme, "doing", [paintedCell(theme, { ...cell, text })], width)];
}

/** The selected run's facts at the tier's `boardFacts`, and how many facts that set left for Enter. */
function boardFactLines(
	theme: PancodeTheme,
	row: DispatchBoardRow,
	width: number,
	facts: readonly BoardFact[] | "all",
	load: EndpointLoad | null,
	evidence: RunEvidencePresentation | undefined,
	now: number,
): { lines: string[]; hidden: number } {
	const usage = dispatchUsageText(row.usage);
	const firstOutput =
		row.ttft !== undefined && row.ttft !== null
			? `first output after ${row.ttft}`
			: row.status === "running"
				? "no output yet"
				: null;
	const task = row.taskSummary
		? cardWrappedValueLines(theme, "task", theme.fg("body", sanitizeCallTargetText(row.taskSummary)), width)
		: [];
	const firstTask = task[0];
	const slots = [
		...(row.endpoint !== undefined && load !== null
			? [
					theme.fg(
						"info",
						`${load.active}/${row.endpoint.limit} ${sanitizeCallTargetText(row.endpoint.label)}${load.queued > 0 ? ` +${load.queued} queued` : ""}`,
					),
				]
			: []),
		...(firstOutput === null ? [] : [theme.fg("body", firstOutput)]),
	];
	const started = runOriginWords(row);
	const measured = row.usage.kind === "ready" && compactQuantity(usage.prompt) !== null;
	const cost = row.usage.kind === "ready" ? compactQuantity(usage.cost) : null;
	const tokenUnits = [
		...(measured && row.usage.kind === "ready"
			? [
					theme.fg("body", `prompt ${boundMark(usageLineFigure(row.usage.prompt))}`),
					theme.fg("body", `out ${boundMark(usageLineFigure(row.usage.output))}`),
				]
			: [theme.fg("body", isTerminalStatus(row.status) ? USAGE_NOT_MEASURED : "none reported yet")]),
		theme.fg("body", cost === null || cost === USAGE_NOT_MEASURED ? "cost not measured on this route" : `cost ${cost}`),
	];
	const proof = evidence === undefined ? null : evidenceCardLine(theme, evidence, width);
	const trailUnits =
		row.progress !== undefined && row.progress.recentActions.length > 0
			? row.progress.recentActions.slice(0, 3).map((action) => actionPhrase(action, "finished"))
			: (row.recentTools ?? []).slice(0, 3).map((tool) => theme.fg("toolCapability", sanitizeCallTargetText(tool)));
	const all: ReadonlyArray<readonly [string, string[]]> = [
		["doing", doingLines(theme, row, width, now)],
		["task", firstTask === undefined ? [] : [task.length > 1 ? cutRowWithEllipsis(firstTask, width) : firstTask]],
		["slots", slots.length === 0 ? [] : [cardUnitsLine(theme, "slots", slots, width)]],
		[
			"started",
			started === null && row.earlier !== true
				? []
				: [
						cardUnitsLine(
							theme,
							"started",
							[
								...(started === null ? [] : [theme.fg("body", started)]),
								...(row.earlier === true ? [theme.fg("annotation", "recorded before this PanCode started")] : []),
							],
							width,
						),
					],
		],
		[
			"target",
			[
				cardUnitsLine(
					theme,
					"connection",
					[
						theme.fg("footerIdentity", formatRowRoute(row)),
						...(row.node === undefined || row.node === "local" ? [] : [theme.fg("body", `on node ${row.node}`)]),
					],
					width,
				),
			],
		],
		["tokens", [cardUnitsLine(theme, "tokens", tokenUnits, width)]],
		["trust", trustCardLines(theme, row, width, false)],
		["trail", trailUnits.length === 0 ? [] : [cardUnitsLine(theme, "trail", trailUnits, width)]],
		["evidence", proof === null ? [] : [proof]],
	];
	const present = all.filter(([, lines]) => lines.length > 0);
	// A settled run's trust verdict is part of its state, which no tier hides (3, invariant 2).
	const settledTrust = isTerminalStatus(row.status);
	const shown =
		facts === "all"
			? present
			: present.filter(([name]) => (facts as readonly string[]).includes(name) || (name === "trust" && settledTrust));
	return { lines: shown.flatMap(([, lines]) => lines), hidden: present.length - shown.length };
}

interface BoardDetail {
	title: string;
	meta: string;
	runId: string;
	body: string[];
	/** Facts the tier left for Enter, named by the fold marker. */
	hidden: number;
	plan: boolean;
}

/**
 * The selected run's titled rule and its body in `room` rows. An open detail pages through the whole record; a folded
 * one shows the tier's facts, then, when `marker`, the row that says how many more Enter opens. A body cut at the
 * budget closes on the row that says where the rest is read.
 */
function detailSection(
	theme: PancodeTheme,
	detail: BoardDetail,
	width: number,
	room: number,
	expanded: boolean,
	budgetKnown: boolean,
	detailWindow: { offset: number },
	marker: boolean,
): string[] {
	const lines = [sectionRule(theme, width, detail.title, { meta: detail.meta })];
	const rest = room - 1;
	const sep = ` ${GLYPH.sep} `;
	const fold =
		marker && !expanded && detail.hidden > 0
			? theme.fg(
					"annotation",
					truncateToWidth(`${GLYPH.ellipsis} ${detail.hidden} more rows${sep}[Enter] detail`, width, GLYPH.ellipsis, false),
				)
			: null;
	if ((expanded && !budgetKnown) || detail.body.length + (fold === null ? 0 : 1) <= rest) {
		lines.push(...detail.body, ...(fold === null ? [] : [fold]));
		return lines;
	}
	if (rest <= 0) return lines;
	if (expanded) {
		const page = Math.max(1, rest - 1);
		const start = Math.min(detailWindow.offset, Math.max(0, detail.body.length - page));
		detailWindow.offset = start;
		lines.push(...detail.body.slice(start, start + page));
		if (rest > 1)
			lines.push(
				positionRow(theme, { start: start + 1, end: start + page, total: detail.body.length, unit: "detail rows" }, width),
			);
		return lines;
	}
	const kept = detail.body.slice(0, Math.max(0, rest - 1));
	const hidden = detail.body.length - kept.length + (marker ? detail.hidden : 0);
	// A fact the cut lands inside of wraps onto the next row, which starts blank under its key; the last row kept
	// then closes with the ellipsis, so `its answer was not in the` never reads as the whole of it.
	const nextRow = detail.body[kept.length];
	const lastKept = kept.at(-1);
	if (lastKept !== undefined && nextRow !== undefined && /^\s/u.test(stripPaint(nextRow)) && nextRow.trim().length > 0) {
		kept[kept.length - 1] = cutRowWithEllipsis(lastKept, width);
	}
	// Pointers drop whole from the end rather than cut, so a `/view` never shows a run id it cannot be typed from.
	// A plan is not a dispatch record; Enter opens its steps, not /view dispatch:<id>.
	const where = [`${hidden} more rows`, "[Enter] detail", ...(detail.plan ? [] : [`/view dispatch:${detail.runId}`])];
	const fits = (): boolean => visibleWidth(`${GLYPH.ellipsis} ${where.join(sep)}`) <= width;
	// The /view handle is the only way to the rows a narrow board cut, so the count shortens and Enter goes first.
	if (!fits() && where.length > 2) where.splice(1, 1);
	if (!fits()) where[0] = `${hidden} more`;
	if (!fits() && where.length > 1) where.shift();
	while (where.length > 1 && !fits()) where.pop();
	lines.push(
		...kept,
		theme.fg("annotation", truncateToWidth(`${GLYPH.ellipsis} ${where.join(sep)}`, width, GLYPH.ellipsis, false)),
	);
	return lines;
}

/** The header, the rows in `tableBudget` around the cursor, the earlier-sessions rule and the position row. */
function tableWindowLines(
	theme: PancodeTheme,
	table: RunTable,
	items: ReadonlyArray<DispatchBoardItem>,
	selectedIndex: number,
	tableBudget: number,
	width: number,
	detailExpanded: boolean,
): string[] {
	const [start] = centeredWindow(table.rows.length, selectedIndex, tableBudget);
	const { window, position } = windowRows(table.rows, start, tableBudget);
	const lines = [...window];
	// What an earlier PanCode recorded sits under its own rule, so a row from before this process never passes for one
	// of its own at a glance, at any width or without colour. The rule sits above the first earlier row in view, or
	// tops the window when every row in view is earlier.
	const firstEarlier = items.findIndex(itemFromEarlierSession);
	if (firstEarlier >= 0 && firstEarlier < start + window.length) {
		lines.splice(Math.max(0, firstEarlier - start), 0, earlierSessionsRule(theme, items.length - firstEarlier, width));
	}
	if (table.header !== null) lines.unshift(table.header);
	if (position) {
		// An open detail adds only how many runs it is hiding.
		const hidden = position.total - (position.end - position.start + 1);
		const keys = detailExpanded ? [`${hidden} hidden while the detail is open`] : [];
		lines.push(positionRow(theme, { ...position, unit: "runs", keys }, width));
	}
	return lines;
}

/**
 * The board body for `budget` rows (6.5): the run table with its header, windowed around the cursor, then the
 * selected run's facts under a rule that names it and its state. The facts are the tier's `boardFacts`; Enter opens
 * the whole record, paged. From W5 the list and the facts sit side by side, 60 and 40 percent. `budgetKnown` is false
 * before the frame has granted rows; an open detail then renders whole and the frame's cut marks what is missing.
 */
function formatDispatchBoardBody(
	rows: ReadonlyArray<DispatchBoardRow>,
	width: number,
	budget: number,
	telemetry: TelemetrySnapshot | undefined,
	selectedRunId: string | null,
	detailExpanded: boolean,
	budgetKnown: boolean,
	detailWindow = { offset: 0 },
): string[] {
	const theme = pancodeTheme();
	if (rows.length === 0) {
		return emptyState(theme, "No runs in this session.", width, {
			remedy: `/run <agent> <task> starts one ${GLYPH.sep} PanCode lists the workers it starts here.`,
		});
	}
	const now = Date.now();
	const endpointActive: Record<string, number> = { ...foregroundStreamUsage() };
	const endpointQueued: Record<string, number> = {};
	for (const row of rows) {
		if (row.endpoint === undefined) continue;
		if (row.status === "enqueued") endpointQueued[row.endpoint.key] = (endpointQueued[row.endpoint.key] ?? 0) + 1;
		else if (row.status === "running" || row.status === "stale" || row.status === "cancelling")
			endpointActive[row.endpoint.key] = (endpointActive[row.endpoint.key] ?? 0) + 1;
	}
	// A council is one question asked of several members, so its rows fold into
	// one table row and one detail block rather than unrelated neighbours.
	const items = dispatchBoardItems(rows, selectedRunId);
	const selectedIndex = Math.max(
		0,
		items.findIndex((item) =>
			item.kind === "run" ? item.row.runId === selectedRunId : item.group.selectedRunId !== undefined,
		),
	);
	const split = widthClass(width) === "W5";
	const listWidth = split ? Math.floor((width - BOARD_GAP) * 0.6) : width;
	const factsWidth = split ? width - listWidth - BOARD_GAP : width;
	const table = runTable(items, listWidth, { selectedRunId });
	const head = table.header === null ? 0 : 1;
	// On a short stacked board the note would cost the selected run's status row, which says more than which columns left.
	const notes = table.note === null || (!split && budget < 10) ? [] : [table.note];
	const dividerRows = items.some(itemFromEarlierSession) ? 1 : 0;
	const item = items[selectedIndex];
	const detail = ((): BoardDetail | null => {
		if (item === undefined) return null;
		if (item.kind === "council") {
			return {
				title: `${councilName(item.group)}${item.group.task === undefined ? "" : ` ${GLYPH.sep} ${item.group.task}`}`,
				meta: item.group.round > 1 ? `round ${item.group.round} ${GLYPH.sep} ${item.group.elapsed}` : item.group.elapsed,
				runId: item.group.selectedRunId ?? item.group.members[0]?.runId ?? "",
				// The table keeps its selected row and position row, and the detail its rule, whatever the council's size.
				body: councilGroupBody(theme, item.group, factsWidth, Math.max(3, budget - notes.length - dividerRows - head - 3)),
				hidden: 0,
				plan: false,
			};
		}
		const row = item.row;
		const evidence = deriveRunEvidenceState(telemetry, row.runId);
		const load =
			row.endpoint === undefined
				? null
				: { active: endpointActive[row.endpoint.key] ?? 0, queued: endpointQueued[row.endpoint.key] ?? 0 };
		const folded =
			detailExpanded || row.plan !== undefined
				? {
						lines: dispatchCardBody(row, factsWidth, evidence, {
							expanded: detailExpanded,
							detailKey: "Enter",
							...(load !== null ? { endpointActive: load.active, endpointQueued: load.queued } : {}),
						}),
						hidden: 0,
					}
				: boardFactLines(theme, row, factsWidth, tierPolicy().boardFacts, load, evidence, now);
		return {
			title: runRuleTitle(row),
			meta: `${stripPaint(runStatusCell(theme, row, undefined, factsWidth))} ${GLYPH.sep} ${row.telemetry?.activity.elapsed.display ?? formatElapsed(row.elapsedMs)}`,
			runId: row.runId,
			body: folded.lines,
			hidden: folded.hidden,
			plan: row.plan !== undefined,
		};
	})();
	if (split) {
		// Side by side, the list keeps every row the budget holds and the facts need no fold marker.
		const listRows = Math.max(1, budget - head - notes.length - dividerRows);
		const tableBudget = table.rows.length <= listRows ? table.rows.length : Math.max(1, listRows - 1);
		const list = [
			...tableWindowLines(theme, table, items, selectedIndex, tableBudget, listWidth, detailExpanded),
			...notes,
		];
		const facts =
			detail === null
				? []
				: detailSection(theme, detail, factsWidth, budget, detailExpanded, budgetKnown, detailWindow, false);
		const height = Math.max(list.length, facts.length);
		return Array.from(
			{ length: height },
			(_, index) => `${padAnsi(list[index] ?? "", listWidth)}${" ".repeat(BOARD_GAP)}${facts[index] ?? ""}`,
		);
	}
	// An open detail leaves the table what its body and rule do not need, and never less than the selected row. A
	// table that cannot show every run spends one more row on the position row that counts the rest.
	const detailRows =
		(detail === null ? 0 : detail.body.length + 1 + (detail.hidden > 0 ? 1 : 0)) + notes.length + dividerRows + head;
	const tableBudget = detailExpanded
		? table.rows.length + detailRows <= budget
			? table.rows.length
			: Math.max(1, Math.min(table.rows.length - 1, budget - detailRows - 1))
		: Math.min(
				table.rows.length,
				Math.max(
					1,
					Math.min(
						Math.max(3, Math.floor(budget / 2) - dividerRows - head),
						// The selected run keeps its rule, its first rows and the pointer to the rest, however short the board.
						budget - head - dividerRows - notes.length - 1 - (detail === null ? 0 : Math.min(2, detail.body.length) + 2),
					),
				),
			);
	const lines = [...tableWindowLines(theme, table, items, selectedIndex, tableBudget, width, detailExpanded), ...notes];
	if (detail === null) return lines;
	lines.push(
		...detailSection(theme, detail, width, budget - lines.length, detailExpanded, budgetKnown, detailWindow, true),
	);
	return lines;
}

/**
 * Live dispatch-board component. The table renders at the width the TUI
 * grants and the body at the rows the dock grants, so a narrow terminal drops
 * columns rather than clipping telemetry mid-token and a short one windows the
 * table around the cursor rather than cutting the board at the second card.
 * Rows and the telemetry snapshot are read per render and the body is
 * memoized on what they show, so a ticker repaint that changed nothing costs
 * the frame its identity check and no more. The only local state is the
 * selected run id, kept stable across lifecycle-driven reorders, and whether
 * its detail is expanded.
 */
export interface DispatchBoardView extends Component, RowBudgetedBody, GrowableBody {
	selectedRow(): DispatchBoardRow | null;
	selectPrevious(): void;
	selectNext(): void;
	resetSelection(): void;
	/** Open or close the selected row's worker-progress detail. */
	toggleDetail(): void;
	scrollDetail(direction: -1 | 1): void;
	detailExpanded(): boolean;
	/** Whether a first `x` asked about the selected run; a second `x` on it cancels. */
	cancelArmed(): boolean;
	/** Arm the selected run for cancel, or disarm. */
	armCancel(on: boolean): void;
	/** Whether `w` can open the watch pane on the selected run. */
	canWatch(): boolean;
	/** Say which rows `w` takes to the watch pane; only a session with a pane host has any. */
	setWatchable(predicate: (row: DispatchBoardRow) => boolean): void;
}

/**
 * The keys Fleet Runs offers for the selected row, without the way out the frame adds. The rail and the board's own
 * key row read this one list, so a key the rail has no room for is named in the body rather than lost (cards r1).
 */
export function dispatchBoardHintEntries(
	board: Pick<DispatchBoardView, "selectedRow" | "detailExpanded" | "canWatch"> &
		Partial<Pick<DispatchBoardView, "cancelArmed">>,
): HintEntry[] {
	const row = board.selectedRow();
	if (row === null) return [];
	if (board.cancelArmed?.() === true && isDispatchBoardRowCancellable(row))
		return confirmOnceRail("x", "cancel", row.agentId);
	const entries: HintEntry[] = [{ key: GLYPH.upDown, verb: "select" }];
	const steerable = isDispatchBoardRowSteerable(row);
	if (board.detailExpanded()) entries.push({ key: "PgUp/PgDn", verb: "detail", critical: true });
	if (row.plan === undefined) {
		// A run that can take a message leads with steer and cancel; otherwise detail is what is left to read. A
		// council's detail is its members' answers, which want the rows the table holds.
		// The watch pane splits the terminal, so it says so before the key is pressed. It is listed ahead of Enter
		// because a narrow rail keeps its later keys first, and the run's detail matters more than a split pane.
		if (row.council === undefined && board.canWatch())
			entries.push({ key: "w", verb: "watch in a pane", short: "watch" });
		entries.push({ key: "Enter", verb: board.detailExpanded() ? "hide detail" : "detail", critical: !steerable });
	} else entries.push({ key: "Enter", verb: board.detailExpanded() ? "hide detail" : "detail", critical: true });
	if (steerable) entries.push({ key: "m", verb: "steer", critical: true });
	if (isDispatchBoardRowCancellable(row)) entries.push({ key: "x", verb: "cancel", critical: true });
	return entries;
}

/**
 * Esc by the shared rule: an open run detail is a layer, so Esc folds it and
 * the board stays; from the table Esc closes the board.
 */
export function dispatchBoardEscapeEntry(board: { detailExpanded(): boolean }): HintEntry {
	// Enter already says `hide detail`; Esc names where it lands, so the two keys never read as one verb.
	return board.detailExpanded() ? { key: "Esc", verb: "back to runs", short: "back" } : { key: "Esc", verb: "close" };
}

/** The keys the frame's rail drops at this width, as rows under the table; the arrows are on the position row. */
function droppedKeyRows(entries: ReadonlyArray<HintEntry>, width: number, esc: HintEntry): string[] {
	const all: HintEntry[] = [...entries, esc];
	// The frame fits its rail into the body's width less one cell.
	const { kept } = fitHintEntryList(all, width - 1);
	// Splitting off a watch pane from a terminal this narrow leaves two unreadable halves, so the key goes unadvertised
	// there and the keys that act on the run fit one row.
	const dropped = all.filter(
		(entry) => !kept.includes(entry) && entry.key !== GLYPH.upDown && !(entry.key === "w" && width < 50),
	);
	if (dropped.length === 0) return [];
	const theme = pancodeTheme();
	// Keys wrap between entries, never inside one, so a narrow board names every key it takes. Each row sits flush
	// right, over the rail's own keys, so the two read as one key rail in two rows rather than as loose body text.
	const room = Math.max(1, width - 1);
	const rows: string[] = [];
	let current = "";
	for (const entry of dropped) {
		const unit = `[${keyName(entry.key)}] ${entry.short ?? entry.verb}`;
		const joined = current.length === 0 ? unit : `${current}${SEP}${unit}`;
		if (current.length > 0 && visibleWidth(joined) > room) {
			rows.push(current);
			current = unit;
		} else current = joined;
	}
	if (current.length > 0) rows.push(current);
	return rows.map((row) => {
		const shown = truncateToWidth(row, room, GLYPH.ellipsis, false);
		return `${" ".repeat(Math.max(0, room - visibleWidth(shown)))}${theme.fg("keyboardHint", shown)}`;
	});
}

export function createDispatchBoardView(
	rows: () => ReadonlyArray<DispatchBoardRow>,
	telemetry: () => TelemetrySnapshot | undefined,
): DispatchBoardView {
	let armedCancelRunId: string | null = null;
	let selectedRunId: string | null = null;
	// Until the operator moves the cursor, the pick is the board's own, so a live run that registers after the board
	// opened takes it over from a finished one.
	let chosen = false;
	// Detail is a property of the operator's attention, not of a run, so it follows the cursor rather than pinning to
	// the row it was opened on. The board opens folded at every tier, so Esc from the list closes it in one press.
	let expanded = false;
	const detailWindow = { offset: 0 };
	const detailExpanded = (): boolean => expanded && rows().length > 0;
	let watchable: (row: DispatchBoardRow) => boolean = () => false;
	let bodyRows = 0;
	let memo: { key: string; lines: string[] } | null = null;

	const normalizeSelection = (
		currentRows: ReadonlyArray<DispatchBoardRow>,
		visibleRows = selectableBoardRows(currentRows),
	): DispatchBoardRow | null => {
		if (visibleRows.length === 0) {
			selectedRunId = null;
			return null;
		}
		const previous = currentRows.find((row) => row.runId === selectedRunId);
		const held = visibleRows.find((row) => row.runId === selectedRunId);
		const live =
			chosen || (held !== undefined && isDispatchBoardRowCancellable(held))
				? undefined
				: visibleRows.find(isDispatchBoardRowCancellable);
		const selected =
			live ??
			held ??
			visibleRows.find(
				(row) =>
					previous?.council !== undefined &&
					row.council?.group === previous.council.group &&
					row.council.label === previous.council.label,
			) ??
			visibleRows[0] ??
			null;
		if (selectedRunId !== selected?.runId) detailWindow.offset = 0;
		selectedRunId = selected?.runId ?? null;
		return selected;
	};

	const moveSelection = (delta: -1 | 1): void => {
		const currentRows = rows();
		const visibleRows = selectableBoardRows(currentRows);
		const selected = normalizeSelection(currentRows, visibleRows);
		if (!selected || visibleRows.length < 2) return;
		const index = visibleRows.findIndex((row) => row.runId === selected.runId);
		const nextIndex = (index + delta + visibleRows.length) % visibleRows.length;
		selectedRunId = visibleRows[nextIndex]?.runId ?? selected.runId;
		chosen = true;
		detailWindow.offset = 0;
	};

	const view: DispatchBoardView = {
		render(width: number): string[] {
			const currentRows = rows();
			normalizeSelection(currentRows);
			const snapshot = telemetry();
			const safeWidth = Math.max(1, width);
			const budget = bodyRows > 0 ? bodyRows : DOCK_BODY_ROWS_MAX;
			// A waiting retry counts down by the second, so its row is keyed on the second.
			const clock = currentRows.some((row) => row.retry !== undefined) ? Math.floor(Date.now() / 1000) : 0;
			const evidence =
				snapshot?.runs
					.filter((run) => run.evidence)
					.map((run) => run.runId)
					.join(",") ?? "";
			const entries = dispatchBoardHintEntries(view);
			const esc = dispatchBoardEscapeEntry(view);
			let keyRows = droppedKeyRows(entries, safeWidth, esc);
			const key = `${safeWidth}|${budget}|${selectedRunId}|${detailExpanded()}|${detailWindow.offset}|${tierRevision()}|${skinEpoch()}|${clock}|${evidence}|${keyRows.join("/")}|${currentRows.map(rowSignature).join(";")}`;
			if (memo?.key === key) return memo.lines;
			const bodyAt = (rows: number): string[] =>
				formatDispatchBoardBody(
					currentRows,
					safeWidth,
					Math.max(1, budget - rows),
					snapshot,
					selectedRunId,
					detailExpanded(),
					bodyRows > 0,
					detailWindow,
				);
			let body = bodyAt(keyRows.length);
			// The detail's fold marker already names Enter, so the dropped-key row does not name it again (fleet finding 20).
			const namesEnter = (lines: ReadonlyArray<string>): boolean =>
				lines.some((line) => stripPaint(line).includes("[Enter] detail"));
			if (namesEnter(body) && namesEnter(keyRows)) {
				const fewer = droppedKeyRows(
					entries.filter((entry) => entry.key !== "Enter"),
					safeWidth,
					esc,
				);
				const roomier = bodyAt(fewer.length);
				if (namesEnter(roomier)) {
					keyRows = fewer;
					body = roomier;
				}
			}
			const lines = currentRows.length === 0 ? body : [...body, ...keyRows];
			memo = { key, lines };
			return lines;
		},
		setBodyRows(next: number): void {
			bodyRows = Math.max(0, Math.floor(next));
		},
		selectedRow(): DispatchBoardRow | null {
			return normalizeSelection(rows());
		},
		selectPrevious(): void {
			moveSelection(-1);
		},
		selectNext(): void {
			moveSelection(1);
		},
		resetSelection(): void {
			selectedRunId = null;
			chosen = false;
			expanded = false;
			detailWindow.offset = 0;
			normalizeSelection(rows());
		},
		toggleDetail(): void {
			const row = normalizeSelection(rows());
			if (row === null) return;
			expanded = !detailExpanded();
			detailWindow.offset = 0;
		},
		scrollDetail(direction): void {
			if (detailExpanded())
				detailWindow.offset = Math.max(
					0,
					detailWindow.offset + direction * Math.max(1, (bodyRows || DOCK_BODY_ROWS_MAX) - 6),
				);
		},
		detailExpanded,
		cancelArmed(): boolean {
			const row = normalizeSelection(rows());
			return row !== null && armedCancelRunId === row.runId;
		},
		armCancel(on: boolean): void {
			const next = on ? (normalizeSelection(rows())?.runId ?? null) : null;
			if (next === armedCancelRunId) return;
			armedCancelRunId = next;
			memo = null;
		},
		wantsGrowth(): boolean {
			return detailExpanded() || tierPolicy().boardFacts === "all";
		},
		canWatch(): boolean {
			const row = normalizeSelection(rows());
			return row !== null && watchable(row);
		},
		setWatchable(predicate: (row: DispatchBoardRow) => boolean): void {
			watchable = predicate;
			memo = null;
		},
		invalidate(): void {
			memo = null;
		},
	};
	return view;
}
