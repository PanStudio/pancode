// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { join } from "node:path";
import type { OutputStyle } from "../core/defaults.js";
import { clockLocal, formatCount, formatElapsed } from "../core/format-time.js";
import { GLYPH } from "../core/glyphs.js";
import { tierPolicy } from "../core/presentation-tier.js";
import { terminalBackground } from "../core/terminal-background.js";
import { type ColorDepth, colorDepth } from "../core/terminal-preferences.js";
import { resolveRole, type SemanticRole } from "../core/theme-roles.js";
import { sgrFor } from "../core/theme-sgr.js";
import { pancodeStateDir } from "../core/xdg.js";
import { type RunFeedLine, readRunFeed } from "../domains/dispatch/run-feed.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { visibleWidth } from "../engine/tui-primitives.js";
import { readWatchRequest } from "./fleet-board-model.js";
import type { fleetInspectionScope } from "./fleet-project-scope.js";
import { DETAIL_MAX_WIDTH, sanitizeBounded, TRANSCRIPT_LIMIT, truncatePlain } from "./fleet-view-model.js";

// ---------------------------------------------------------------------------
// Logs pane (`--follow --pane`)
// ---------------------------------------------------------------------------

/**
 * The logs pane is a host pane beside PanCode, so its rows obey the pane's own width: one row per event, clipped
 * with `…`, never wrapped, holding clock, glyph, object and outcome down to 24 cells. How much it lists follows the
 * TUI's output detail, which the TUI writes as `outputDetail=` into the watch selection file and this pane re-reads
 * on every poll: compact lists tool calls and outcomes, standard adds model replies with their token counts, and
 * detailed adds each event's type and the call's facts.
 */

/** The watch selection file under the state root; mirrors watchSelectionPath in src/interactive/watch-pane.ts. */
const WATCH_SELECTION_FILE = "watch-selection";
/** What `--color-depth` accepts: the depths `colorDepth()` detects. */
export const COLOR_DEPTHS: ReadonlyArray<ColorDepth> = ["truecolor", "256", "16", "none"];
export const PANE_DEFAULT_WIDTH = 40;
/** Header, rule, rule and status around the event rows. */
export const PANE_CHROME_ROWS = 4;
const PANE_SEPARATOR = ` ${GLYPH.sep} `;
const CLOCK_WIDTH = 8;
const TIER_RANK: Readonly<Record<OutputStyle, number>> = { compact: 0, standard: 1, detailed: 2 };
/** Events another row already says, or that carry nothing an operator reads in a log. */
const PANE_QUIET_EVENTS = new Set([
	"text",
	"thinking",
	"agent_start",
	"agent_end",
	"pancode_helper_result",
	"pancode_model_call",
	"pancode_tool_observation",
]);

interface PaneMark {
	glyph: string;
	role: SemanticRole;
}

interface PaneRow {
	/** Operator-local `HH:MM:SS`, empty for a row with no instant of its own. */
	clock: string;
	/** The event type the detailed tier shows in its own column. */
	type: string;
	glyph: PaneMark;
	text: string;
	/** Call facts; detailed only. */
	facts: string | undefined;
	mark: PaneMark | undefined;
	duration: string | undefined;
	/** The lowest tier that lists the row. */
	tier: OutputStyle;
	tool?: string;
	pending?: boolean;
}

interface LogsPaneSource {
	run: RunEnvelope;
	feed: ReturnType<typeof readRunFeed>;
}

export interface LogsPaneView {
	runId: string;
	agentId: string;
	rows: PaneRow[];
	terminal: boolean;
	/** Start to end once the run ended. */
	elapsed: string | undefined;
}

export interface LogsPaneScroll {
	/** First body row shown; null follows the newest event. */
	top: number | null;
	/** What the last render measured, for the scroll keys. */
	maxTop?: number;
}

type PanePaint = (role: SemanticRole, text: string, chrome?: boolean) => string;

/** Roles through the core palette, which this process paints from because it must not load the interactive theme. */
export function createPanePaint(depth: ColorDepth = colorDepth()): PanePaint {
	const background = terminalBackground();
	const codes = new Map<SemanticRole, { open: string; close: string }>();
	return (role, text, chrome = false) => {
		if (text.length === 0) return text;
		let sgr = codes.get(role);
		if (sgr === undefined) {
			const resolved = resolveRole(role);
			const color = sgrFor({ fg: resolved.color }, depth, background);
			const open = [color.open, resolved.bold === true ? "1" : "", chrome && depth === "none" ? "2" : ""].filter(Boolean);
			const close = [color.close, resolved.bold === true || (chrome && depth === "none") ? "22" : ""].filter(Boolean);
			sgr = { open: open.join(";"), close: close.join(";") };
			codes.set(role, sgr);
		}
		return sgr.open.length === 0 ? text : `\u001B[${sgr.open}m${text}\u001B[${sgr.close}m`;
	};
}

/** The tier the TUI last wrote; standard when the file or its line is absent. */
export function paneTier(): OutputStyle {
	return readWatchRequest(join(pancodeStateDir(), WATCH_SELECTION_FILE))?.outputDetail ?? "standard";
}

function toolMark(outcome: "ok" | "error" | "blocked" | undefined): PaneMark | undefined {
	if (outcome === "ok") return { glyph: GLYPH.ok, role: "success" };
	if (outcome === "error") return { glyph: GLYPH.error, role: "error" };
	if (outcome === "blocked") return { glyph: GLYPH.phaseBlocked, role: "warning" };
	return undefined;
}

function runMark(outcome: string): PaneMark {
	if (outcome === "succeeded" || outcome === "completed") return { glyph: GLYPH.ok, role: "success" };
	if (outcome === "cancelled") return { glyph: GLYPH.cancelled, role: "annotation" };
	return { glyph: GLYPH.error, role: "error" };
}

function callFactsText(line: Extract<RunFeedLine, { kind: "event" }>): string | undefined {
	const parts: string[] = [];
	if (line.verb !== undefined) parts.push(sanitizeBounded(line.verb, 32));
	const facts = line.callFacts;
	if (facts !== undefined) {
		if (typeof facts.startLine === "number" && typeof facts.endLine === "number")
			parts.push(`L${facts.startLine}-${facts.endLine}`);
		if (facts.returnedBytes !== undefined) parts.push(`${formatCount(facts.returnedBytes)}B`);
		if (facts.truncated === true) parts.push("truncated");
	}
	if (line.notExecuted === "observation_budget") parts.push("not run: observation budget");
	if (line.callIndex !== undefined) parts.push(`call ${line.callIndex}`);
	const text = parts.filter((part) => part.length > 0).join(PANE_SEPARATOR);
	return text.length > 0 ? text : undefined;
}

function typeName(type: string): string {
	return sanitizeBounded(type.startsWith("pancode_") ? type.slice("pancode_".length) : type, 32);
}

function elapsedBetween(from: string, to: string): string | undefined {
	const ms = Date.parse(to) - Date.parse(from);
	return Number.isFinite(ms) ? formatElapsed(ms) : undefined;
}

function lastPending(rows: ReadonlyArray<PaneRow>, tool: string): PaneRow | undefined {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const row = rows[index];
		if (row?.pending === true && row.tool === tool) return row;
	}
	return undefined;
}

/** One row per event, a call's start and finish folded into the one row its finish completes. */
function foldPaneRows(lines: ReadonlyArray<RunFeedLine>, truncated: boolean, startedAt: string): PaneRow[] {
	const rows: PaneRow[] = [];
	const pending = new Map<string, PaneRow>();
	const dropped = (clock: string): PaneRow => ({
		clock,
		type: "truncated",
		glyph: { glyph: GLYPH.ellipsis, role: "warning" },
		text: "earlier events dropped",
		facts: undefined,
		mark: undefined,
		duration: undefined,
		tier: "compact",
	});
	let marked = false;
	for (const line of lines) {
		const clock = clockLocal(line.at);
		if (line.kind === "journal_truncated") {
			marked = true;
			rows.push(dropped(clock));
			continue;
		}
		if (line.kind === "terminal") {
			const outcome = sanitizeBounded(line.outcome, 32);
			const detail = line.detail === undefined ? "" : sanitizeBounded(line.detail, DETAIL_MAX_WIDTH);
			const took = elapsedBetween(startedAt, line.at);
			rows.push({
				clock,
				type: "terminal",
				glyph: runMark(line.outcome),
				text: [`${outcome}${detail.length > 0 ? `: ${detail}` : ""}`, took].filter(Boolean).join(PANE_SEPARATOR),
				facts: undefined,
				mark: undefined,
				duration: undefined,
				tier: "compact",
			});
			continue;
		}
		if (line.kind !== "event" || PANE_QUIET_EVENTS.has(line.type)) continue;
		const type = typeName(line.type);
		const detail = line.detail === undefined ? "" : sanitizeBounded(line.detail, DETAIL_MAX_WIDTH);
		const tool = line.tool === undefined ? "" : sanitizeBounded(line.tool, 64);
		const reason = line.reason === undefined ? "" : sanitizeBounded(line.reason, DETAIL_MAX_WIDTH);
		const withReason = (text: string): string => (reason.length > 0 ? `${text}: ${reason}` : text);
		const base = { clock, type, facts: callFactsText(line), mark: undefined, duration: undefined };
		switch (line.type) {
			case "pancode_tool_start": {
				if (tool.length === 0) break;
				const row: PaneRow = {
					...base,
					glyph: { glyph: GLYPH.phaseTool, role: "annotation" },
					text: [tool, detail].filter(Boolean).join(" "),
					mark: { glyph: GLYPH.running, role: "annotation" },
					tier: "compact",
					tool,
					pending: true,
				};
				rows.push(row);
				if (line.callId !== undefined) pending.set(line.callId, row);
				break;
			}
			case "pancode_tool_finish": {
				if (tool.length === 0) break;
				let row = line.callId === undefined ? undefined : pending.get(line.callId);
				if (line.callId !== undefined) pending.delete(line.callId);
				row ??= lastPending(rows, tool);
				if (row === undefined) {
					row = {
						...base,
						glyph: { glyph: GLYPH.phaseTool, role: "annotation" },
						text: [tool, detail].filter(Boolean).join(" "),
						tier: "compact",
						tool,
					};
					rows.push(row);
				}
				row.pending = false;
				row.type = type;
				row.text = line.outcome === "ok" ? row.text : withReason(row.text);
				row.mark = toolMark(line.outcome);
				row.duration = line.durationMs === undefined ? undefined : formatElapsed(line.durationMs);
				row.facts = base.facts ?? row.facts;
				break;
			}
			case "message_end":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.agent, role: "fieldValue" },
					text: ["reply", line.tokens === undefined ? "" : `${formatCount(line.tokens)} tok`]
						.filter(Boolean)
						.join(PANE_SEPARATOR),
					tier: "standard",
				});
				break;
			case "pancode_permission_escalated":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.phaseBlocked, role: "warning" },
					text: ["approval", tool, detail].filter(Boolean).join(" "),
					tier: "compact",
				});
				break;
			case "pancode_permission_resolved":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.phaseBlocked, role: "annotation" },
					text: withReason(["approval", tool, detail].filter(Boolean).join(" ")),
					mark: toolMark(line.outcome ?? "blocked"),
					tier: "compact",
				});
				break;
			case "pancode_run_outcome":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.error, role: "error" },
					text: withReason(detail.length > 0 ? detail : "run outcome"),
					tier: "compact",
				});
				break;
			case "pancode_helper_result_rejected":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.error, role: "error" },
					text: withReason("result rejected"),
					facts: detail.length > 0 ? `submitted ${detail}` : undefined,
					tier: "compact",
				});
				break;
			case "pancode_steer_received":
				rows.push({
					...base,
					glyph: { glyph: GLYPH.next, role: "annotation" },
					text: "steering received",
					facts: detail.length > 0 ? detail : undefined,
					tier: "standard",
				});
				break;
			default:
				if (detail.length === 0) break;
				rows.push({ ...base, glyph: { glyph: GLYPH.dot, role: "annotation" }, text: detail, tier: "standard" });
		}
	}
	if (truncated && !marked) rows.unshift(dropped(""));
	return rows;
}

export function loadLogsPane(
	runId: string,
	scope: ReturnType<typeof fleetInspectionScope>,
	ledger?: () => ReadonlyArray<RunEnvelope>,
): LogsPaneSource | null {
	const run = ledger !== undefined ? (ledger().find((row) => row.id === runId) ?? null) : openLedger().get(runId);
	if (run === null || !scope.seesRun(run)) return null;
	return { run, feed: readRunFeed(runId, { maxLines: TRANSCRIPT_LIMIT }) };
}

/** The view of one read; `previous` is reused when the feed and the ledger row did not move. */
export function logsPaneView(
	source: LogsPaneSource,
	previous: { key: string; view: LogsPaneView } | null,
): { key: string; view: LogsPaneView } {
	const { run, feed } = source;
	const last = feed.lines[feed.lines.length - 1];
	const key = `${feed.bytes}|${feed.lines.length}|${last?.seq ?? -1}|${run.endedAt ?? ""}|${run.agentId}`;
	if (previous !== null && previous.key === key) return previous;
	let end: string | null = run.endedAt;
	for (const line of feed.lines) if (line.kind === "terminal") end = line.at;
	const terminal = feed.terminal !== null || run.endedAt !== null;
	return {
		key,
		view: {
			runId: run.id,
			agentId: sanitizeBounded(run.agentId, 64),
			rows: foldPaneRows(feed.lines, feed.truncated, run.startedAt),
			terminal,
			elapsed: terminal && end !== null ? elapsedBetween(run.startedAt, end) : undefined,
		},
	};
}

/** Leading segments that fit, joined by the separator; the first is clipped when even it does not. */
function fitSegments(segments: ReadonlyArray<string>, width: number): string {
	let line = ` ${segments[0] ?? ""}`;
	for (const segment of segments.slice(1)) {
		const next = `${line}${PANE_SEPARATOR}${segment}`;
		if (visibleWidth(next) > width) break;
		line = next;
	}
	return truncatePlain(line, width);
}

function paneRowLine(row: PaneRow, tier: OutputStyle, typeWidth: number, width: number, paint: PanePaint): string {
	const clock = row.clock.length > 0 ? row.clock : " ".repeat(CLOCK_WIDTH);
	const type = tierPolicy(tier).provenance ? truncatePlain(row.type, typeWidth).padEnd(typeWidth) : "";
	const text =
		tierPolicy(tier).provenance && row.facts !== undefined ? `${row.text}${PANE_SEPARATOR}${row.facts}` : row.text;
	const tail = [row.mark?.glyph, row.duration].filter((part) => part !== undefined && part.length > 0).join(" ");
	const head = ` ${clock} ${type.length > 0 ? `${type} ` : ""}`;
	const fixed = visibleWidth(head) + visibleWidth(row.glyph.glyph) + 1 + (tail.length > 0 ? 1 + visibleWidth(tail) : 0);
	const room = width - fixed;
	if (room < 1) {
		return paint("body", truncatePlain(`${head}${row.glyph.glyph} ${text}${tail.length > 0 ? ` ${tail}` : ""}`, width));
	}
	const shown = truncatePlain(text, room);
	const mark = row.mark === undefined ? "" : paint(row.mark.role, row.mark.glyph);
	const duration = row.duration === undefined ? "" : paint("metadata", row.duration, true);
	return [
		` ${paint("metadata", clock, true)} `,
		type.length > 0 ? `${paint("annotation", type, true)} ` : "",
		paint(row.glyph.role, row.glyph.glyph),
		` ${paint("body", shown)}`,
		tail.length > 0 ? ` ${[mark, duration].filter(Boolean).join(" ")}` : "",
	].join("");
}

/**
 * The pane as lines at one width and tier. Pure. `height` null is the unbounded frame a pipe gets; otherwise the
 * event rows fill the rows between the header pair and the status pair, following the newest event unless scrolled.
 */
export function renderLogsPane(
	view: LogsPaneView,
	scroll: LogsPaneScroll,
	width: number,
	height: number | null,
	tier: OutputStyle,
	paint: PanePaint,
): string[] {
	const columns = Math.max(1, width);
	const rule = paint("annotation", GLYPH.rule.repeat(columns), true);
	const paused = scroll.top !== null;
	const state = paused ? "paused" : view.terminal ? "finished" : "following";
	const identity = [`${view.agentId} ${view.runId}`, view.runId];
	const header =
		identity
			.map((who) => ` logs${PANE_SEPARATOR}${who}${PANE_SEPARATOR}${state}`)
			.find((line) => visibleWidth(line) <= columns) ??
		truncatePlain(` logs${PANE_SEPARATOR}${view.runId}${PANE_SEPARATOR}${state}`, columns);
	const scrollKeys = `[${GLYPH.up}${GLYPH.down}] scroll`;
	const status = paused
		? fitSegments(["paused", "[f] follow", "[q] hide"], columns)
		: view.terminal
			? fitSegments(["run finished", view.elapsed ?? "time not recorded", "[q] hide"], columns)
			: fitSegments([scrollKeys, "[f] follow", "[q] hide"], columns);
	const shown = view.rows.filter((row) => TIER_RANK[row.tier] <= TIER_RANK[tier]);
	const typeCap = columns >= 48 ? 14 : columns >= 36 ? 11 : 6;
	const typeWidth = Math.min(typeCap, Math.max(1, ...shown.map((row) => visibleWidth(row.type))));
	const bodyHeight = height === null ? shown.length : Math.max(1, height - PANE_CHROME_ROWS);
	const maxTop = Math.max(0, shown.length - bodyHeight);
	scroll.maxTop = maxTop;
	const top = scroll.top === null ? maxTop : Math.min(scroll.top, maxTop);
	const body =
		shown.length === 0
			? [
					paint(
						"emptyState",
						view.terminal
							? fitSegments(["no events were recorded for this run"], columns)
							: fitSegments(["no events yet", "the pane follows the newest run"], columns),
					),
				]
			: shown.slice(top, top + bodyHeight).map((row) => paneRowLine(row, tier, typeWidth, columns, paint));
	if (height !== null) while (body.length < bodyHeight) body.push("");
	const statusRole: SemanticRole = paused ? "warning" : "annotation";
	return [paint("groupHeading", header), rule, ...body, rule, paint(statusRole, status, !paused)];
}
