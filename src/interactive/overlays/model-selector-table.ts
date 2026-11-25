// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The model picker's table: which columns a width carries, and the header, rows and selected-row continuation they
 * draw.
 */

import { visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { TableCell, TableColumn } from "../theme/index.js";
import { chip, fitIdentityLabel, GLYPH, padAnsi, pancodeTheme, tableRows } from "../theme/index.js";
import type { ModelRow } from "./model-selector-model.js";
import { RESIDENCY_TONES } from "./model-selector-model.js";

const MODEL_MIN_WIDTH = 14;
/**
 * Every other column pair is separated by an explicit space. The model cell
 * instead relies on its own padding, so a label that fills the column exactly
 * butts straight against the ctx figure. The gutter is reserved inside the
 * model cell, which keeps the header and the rows on the same column stops.
 */
const MODEL_COL_GUTTER = 1;
const CONTEXT_COL_WIDTH = 7;
const CAPS_COL_WIDTH = 5;
const STATE_COL_WIDTH = 8;
const TARGET_COL_WIDTH_NARROW = 8;
const TARGET_COL_WIDTH_WIDE = 12;
const RUNTIME_COL_WIDTH_NARROW = 10;
const RUNTIME_COL_WIDTH_MEDIUM = 14;
const RUNTIME_COL_WIDTH_WIDE = 18;
const TARGET_COL_WIDTH_MAX = 24;
const RUNTIME_COL_WIDTH_MAX = 28;
const SELECTED_PREFIX_WIDTH = 4;

interface ModelLayout {
	modelWidth: number;
	showState: boolean;
	showTarget: boolean;
	showRuntime: boolean;
	targetWidth: number;
	runtimeWidth: number;
}

/** Cells between table columns. */
const MODEL_TABLE_GAP = 2;

/**
 * Which columns a width can carry. The model id is the column the operator
 * reads, so it is sized last from what the fixed columns leave, and runtime,
 * then target, drop whole when it would fall under `MODEL_MIN_WIDTH`.
 */
function modelLayout(
	width: number,
	hasState: boolean,
	content?: { model: number; target: number; runtime: number },
): ModelLayout {
	const fixed = columnLayout(
		width,
		hasState,
		width >= 92 ? TARGET_COL_WIDTH_WIDE : TARGET_COL_WIDTH_NARROW,
		width >= 96 ? RUNTIME_COL_WIDTH_WIDE : width >= 78 ? RUNTIME_COL_WIDTH_MEDIUM : RUNTIME_COL_WIDTH_NARROW,
	);
	if (content === undefined) return fixed;
	// A wide picker cut `offline-audit` to `offline-aud…` with forty idle cells in
	// the model column. When every id still fits whole, the target and runtime
	// columns take the width their own names need instead of a fixed stop.
	const fitted = columnLayout(
		width,
		hasState,
		Math.min(content.target, TARGET_COL_WIDTH_MAX),
		Math.min(content.runtime, RUNTIME_COL_WIDTH_MAX),
	);
	const idsWhole = fitted.modelWidth - MODEL_COL_GUTTER >= Math.max(MODEL_MIN_WIDTH, content.model);
	return fitted.showTarget && fitted.showRuntime && idsWhole ? fitted : fixed;
}

function columnLayout(width: number, hasState: boolean, targetWidth: number, runtimeWidth: number): ModelLayout {
	let showTarget = width >= 58;
	let showRuntime = width >= 68;
	let showState = hasState;
	const modelWidthFor = (): number => {
		let fixed = SELECTED_PREFIX_WIDTH + MODEL_TABLE_GAP + CONTEXT_COL_WIDTH + MODEL_TABLE_GAP + CAPS_COL_WIDTH;
		if (showState) fixed += MODEL_TABLE_GAP + STATE_COL_WIDTH;
		if (showTarget) fixed += MODEL_TABLE_GAP + targetWidth;
		if (showRuntime) fixed += MODEL_TABLE_GAP + runtimeWidth;
		return width - fixed;
	};
	let modelWidth = modelWidthFor();
	if (modelWidth < MODEL_MIN_WIDTH && showRuntime) {
		showRuntime = false;
		modelWidth = modelWidthFor();
	}
	// Whether the pick will wait on a load outlasts which target serves it only once the id itself is at stake.
	if (modelWidth < MODEL_MIN_WIDTH && showTarget) {
		showTarget = false;
		modelWidth = modelWidthFor();
	}
	if (modelWidth < MODEL_MIN_WIDTH && showState) {
		showState = false;
		modelWidth = modelWidthFor();
	}
	return { modelWidth: Math.max(1, modelWidth), showState, showTarget, showRuntime, targetWidth, runtimeWidth };
}

// The active, favorite and recent marks keep one fixed column. Scoped and
// default remain words in the selected row's detail instead of run-origin marks.
function activeMark(row: ModelRow): string {
	const theme = pancodeTheme();
	if (row.active) return theme.fg("selectedOption", GLYPH.ok);
	if (row.favorite) return theme.fg("annotation", GLYPH.favorite);
	if (row.recent) return theme.fg("annotation", GLYPH.recent);
	return " ";
}

/**
 * The model table: cursor and mark lead the model id in one cell, so the id
 * starts on the same column as its header; context and capabilities follow,
 * then the target and runtime the width allows. The id keeps its tail when it
 * must shorten, because the suffix is what tells two builds apart.
 */
export function modelTableLines(rows: ReadonlyArray<ModelRow>, selectedIndex: number, width: number): string[] {
	const theme = pancodeTheme();
	const longest = (values: ReadonlyArray<string>, header: string): number =>
		Math.max(header.length, ...values.map((value) => visibleWidth(value)));
	const layout = modelLayout(
		width,
		rows.some((row) => row.residency != null),
		{
			model: longest(
				rows.map((row) => row.model),
				"model",
			),
			target: longest(
				rows.map((row) => row.target),
				"target",
			),
			runtime: longest(
				rows.map((row) => row.runtimeShortName),
				"runtime",
			),
		},
	);
	const modelColumnWidth = SELECTED_PREFIX_WIDTH + layout.modelWidth;
	const columns: TableColumn[] = [
		{ label: `${" ".repeat(SELECTED_PREFIX_WIDTH)}model`, min: modelColumnWidth, max: modelColumnWidth, priority: 10 },
		{ label: "ctx", align: "right", min: CONTEXT_COL_WIDTH, max: CONTEXT_COL_WIDTH, priority: 4 },
		{ label: "caps", min: CAPS_COL_WIDTH, max: CAPS_COL_WIDTH, priority: 3 },
		...(layout.showState
			? [{ label: "state", min: STATE_COL_WIDTH, max: STATE_COL_WIDTH, priority: 3 } satisfies TableColumn]
			: []),
		...(layout.showTarget
			? [{ label: "target", min: layout.targetWidth, max: layout.targetWidth, priority: 2 } satisfies TableColumn]
			: []),
		...(layout.showRuntime
			? [{ label: "runtime", min: layout.runtimeWidth, max: layout.runtimeWidth, priority: 1 } satisfies TableColumn]
			: []),
	];
	const table = rows.map((row, index): Array<string | TableCell> => {
		const selected = index === selectedIndex;
		const pointer = selected ? theme.style("selectedOption", GLYPH.cursor, { bg: "selectionBackground" }) : " ";
		const label = fitIdentityLabel(
			row.model.length > 0 ? row.model : "(no model ids)",
			Math.max(1, layout.modelWidth - MODEL_COL_GUTTER),
		);
		const model = selected
			? theme.style("selectedOption", label, { bold: true, bg: "selectionBackground" })
			: theme.fg("menuOption", label, row.selectable ? "normal" : "disabled");
		return [
			`${pointer} ${activeMark(row)} ${model}`,
			contextCell(row),
			{ text: row.badges, tone: "muted" },
			...(layout.showState ? [residencyCell(row)] : []),
			...(layout.showTarget ? [theme.fg("modelIdentity", row.target)] : []),
			...(layout.showRuntime ? [{ text: row.runtimeShortName, tone: "muted" } satisfies TableCell] : []),
		];
	});
	const lines = tableRows(theme, { columns, rows: table, header: true, gap: MODEL_TABLE_GAP }, width);
	const chosen = rows[selectedIndex];
	// Header and divider lead; no column wraps, so every row is one line after them.
	const at = 2 + selectedIndex;
	if (chosen === undefined || lines[at] === undefined) return lines;
	// The model column as the table drew it: its natural width, bounded by the layout's.
	const drawnModel = Math.min(
		modelColumnWidth,
		Math.max(visibleWidth(columns[0]?.label ?? ""), ...table.map((cells) => visibleWidth(String(cells[0] ?? "")))),
	);
	const whole = selectedRowLines(chosen, layout, width, drawnModel - SELECTED_PREFIX_WIDTH);
	return whole === null ? lines : [...lines.slice(0, at), ...whole, ...lines.slice(at + 1)];
}

/** The ctx cell: a bare count under its header, `128k`, or `?` for unknown. */
function contextCell(row: ModelRow): string {
	return pancodeTheme().fg(
		row.context === "-" || row.context === "?" || row.context === "?ctx" ? "unknownValue" : "counter",
		row.context.replace(/ctx$/u, ""),
	);
}

function residencyCell(row: ModelRow): string {
	return row.residency ? pancodeTheme().fg(RESIDENCY_TONES[row.residency], row.residency) : "";
}

function alignRight(text: string, width: number): string {
	return `${" ".repeat(Math.max(0, width - visibleWidth(text)))}${text}`;
}

/**
 * The selected row with its model and target printed whole, or null when the table's own row already does. The
 * picker is where the full route is always one key away (Alt+M), so the row the cursor is on never shortens the id
 * or loses the target to a narrow column. It stays one row when it can, giving up runtime and then residency (the
 * status row under the table names the route and its health); ctx and caps keep their place beside the id. When the
 * target still does not fit beside them it moves to a continuation row under the id, and an id wider than the row
 * wraps rather than being cut.
 */
function selectedRowLines(row: ModelRow, layout: ModelLayout, width: number, drawnModelWidth: number): string[] | null {
	const theme = pancodeTheme();
	const id = row.model.length > 0 ? row.model : "(no model ids)";
	const idRoom = Math.max(1, layout.modelWidth - MODEL_COL_GUTTER);
	const idFits = visibleWidth(id) <= idRoom;
	const targetFits = layout.showTarget && visibleWidth(row.target) <= layout.targetWidth;
	if (idFits && targetFits) return null;
	const gap = " ".repeat(MODEL_TABLE_GAP);
	const lead = `${theme.style("selectedOption", GLYPH.cursor, { bg: "selectionBackground" })} ${activeMark(row)} `;
	const model = theme.style("selectedOption", id, { bold: true, bg: "selectionBackground" });
	const target = theme.fg("modelIdentity", row.target);
	// While the id fits its column the row keeps the column stops; past it the cells follow the id at the gap.
	const modelCell = idFits ? padAnsi(model, drawnModelWidth) : `${model}${" ".repeat(MODEL_COL_GUTTER)}`;
	const facts = [
		alignRight(contextCell(row), CONTEXT_COL_WIDTH),
		padAnsi(chip(theme, row.badges, "muted"), CAPS_COL_WIDTH),
	];
	const state = layout.showState ? padAnsi(residencyCell(row), STATE_COL_WIDTH) : null;
	const runtime = layout.showRuntime ? chip(theme, row.runtimeShortName, "muted") : null;
	const fit = (line: string): boolean => visibleWidth(line) <= width;
	const join = (cells: ReadonlyArray<string | null>): string =>
		cells
			.filter((cell): cell is string => cell !== null)
			.join(gap)
			.trimEnd();
	for (const line of [
		join([`${lead}${modelCell}`, ...facts, state, target, runtime]),
		join([`${lead}${modelCell}`, ...facts, state, target]),
		join([`${lead}${modelCell}`, ...facts, target]),
	]) {
		if (fit(line)) return [line];
	}
	const indent = " ".repeat(SELECTED_PREFIX_WIDTH);
	const room = Math.max(1, width - SELECTED_PREFIX_WIDTH);
	const first = join([`${lead}${modelCell}`, ...facts]);
	const idLines = fit(first)
		? [first]
		: wrapTextWithAnsi(model, room).map((part, index) => `${index === 0 ? lead : indent}${part}`);
	return [...idLines, ...wrapTextWithAnsi(target, room).map((part) => `${indent}${part}`)];
}
