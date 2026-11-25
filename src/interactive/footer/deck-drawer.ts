// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Hybrid B->A `Alt+U` boxed island deck drawer (`Route`, `Work`, `Context`).
 *
 * Open by default at `detailed` (`Alt+U` still folds it); closed by default at `compact`
 * and `standard` (`Alt+U` opens it). Auto-folds under W1 (< 44 cols), H1 (< 20 rows), or
 * while any modal overlay owns the dock.
 *
 * Strictly zero inline keycaps beside facts, zero `Fleet idle` / `Notices none` filler,
 * light-theme `overOwned` contrast lift on all borders/dividers/tracks over `raisedSurface`,
 * and memoized by `(width, terminalRows, tier, skinEpoch, factsRevision, secondBucket)`.
 */

import type { JobRecord } from "../../core/job-types.js";
import { presentationTier, tierPolicy, tierRevision } from "../../core/presentation-tier.js";
import { COST_NOT_MEASURED, renderUsdLimit } from "../../core/telemetry/render.js";
import { motionEnabled } from "../../core/terminal-preferences.js";
import { autonomyModeReadout, autonomyWindowReadout } from "../../domains/safety/autonomy-readout.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { taskBoardCounts } from "../../domains/session/task-board.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { buildSegmentedContextBar } from "../context-bar.js";
import { contextPercentRole, renderContextMeterBar } from "../context-meter.js";
import { ACTIVE_DISPATCH_STATUSES } from "../footer-panel.js";
import {
	boxIsland,
	formatCount,
	formatElapsed,
	GLYPH,
	onRaisedTheme,
	type PancodeTheme,
	pancodeTheme,
} from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";
import {
	type ContextOccupancyFacts,
	contextBreakdownForBar,
	contextReadingQualifier,
	thinkingRailUnit,
} from "./context-rail.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import {
	activeTaskBrief,
	contextOccupancyFrom,
	elideModelId,
	footerRateSpeed,
	isMainBusy,
	renderPhaseSegment,
} from "./status-line.js";

const DECK_H1_ROWS = 20;
const DECK_W1_CELLS = 44;
const DECK_TWO_COL_MIN = 60;
const DECK_THREE_COL_MIN = 80;
const DECK_WIDE_MIN = 112;
const LOOP_METER_CELLS = 6;

const clean = (value: string): string => sanitizeCallTargetText(redactSecretString(value));

const COMPACT_COUNT = /^(\d+(?:\.\d+)?)([kmgb]?)$/iu;
const COUNT_SCALE: Readonly<Record<string, number>> = { "": 1, k: 1e3, m: 1e6, g: 1e9, b: 1e9 };

function countValue(text: string): number | null {
	const match = COMPACT_COUNT.exec(text.replaceAll(",", ""));
	if (!match) return null;
	const scale = COUNT_SCALE[(match[2] ?? "").toLowerCase()];
	return scale === undefined ? null : Number(match[1]) * scale;
}

function cacheHitPercent(cache: { read: string; write: string; uncached: string } | null | undefined): number | null {
	if (!cache) return null;
	const read = countValue(cache.read);
	const write = countValue(cache.write);
	const uncached = countValue(cache.uncached);
	if (read === null || write === null || uncached === null) return null;
	const total = read + write + uncached;
	return total > 0 ? Math.round((read / total) * 100) : null;
}

function joinParts(theme: PancodeTheme, parts: readonly string[], room: number): string {
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const kept = parts.filter((part) => part.length > 0);
	if (kept.length === 0) return "";
	let out = "";
	for (const part of kept) {
		const candidate = out === "" ? part : `${out}${sep}${part}`;
		if (out !== "" && visibleWidth(candidate) > room) break;
		out = candidate;
	}
	return truncateToWidth(out, Math.max(1, room), GLYPH.ellipsis, false);
}

function formatLoopMeter(theme: PancodeTheme, filled: number): string {
	const clamped = Math.max(0, Math.min(LOOP_METER_CELLS, filled));
	return (
		theme.fg("composerRail", GLYPH.meterFull.repeat(clamped)) +
		theme.fg("meterFree", GLYPH.meterEmpty.repeat(LOOP_METER_CELLS - clamped))
	);
}

function renderLoopLine(theme: PancodeTheme, loops: readonly JobRecord[], now: number, room: number): string | null {
	const active = loops.find((job) => job.state !== "terminal");
	if (!active) return null;
	const counter = active.spec.count === null ? `${active.settled}` : `${active.settled}/${active.spec.count}`;
	const dueAt = active.active === null ? active.nextDueAt : null;
	const filled =
		dueAt !== null && active.spec.intervalMs > 0
			? Math.min(
					LOOP_METER_CELLS,
					Math.max(0, Math.floor((1 - (dueAt - now) / active.spec.intervalMs) * LOOP_METER_CELLS)),
				)
			: 0;
	const meterBar = dueAt !== null ? ` ${formatLoopMeter(theme, filled)}` : "";
	const countdown = dueAt === null ? null : dueAt <= now ? "now" : formatElapsed(dueAt - now);
	const next =
		countdown !== null
			? `${theme.fg("separator", ` ${GLYPH.sep} `)}${theme.fg("annotation", "next")} ${theme.fg("counter", countdown)}`
			: "";
	const full = `${theme.fg("fieldName", "Loop")} ${theme.fg("counter", counter)}${meterBar}${next}`;
	if (visibleWidth(full) <= room) return full;
	const compact = `${theme.fg("fieldName", "Loop")} ${theme.fg("counter", counter)}${next}`;
	return truncateToWidth(compact, Math.max(1, room), GLYPH.ellipsis, false);
}

function renderToolsSummary(
	theme: PancodeTheme,
	state: FooterDashboardRenderState,
	busy: boolean,
	room: number,
	omitCallCount = false,
): string | null {
	const counts = state.toolCounts;
	const entries = Object.entries(counts.tools)
		.filter(([, count]) => count > 0)
		.sort((a, b) => b[1] - a[1]);
	const totalCalls = entries.reduce((sum, [, count]) => sum + count, 0);
	const active = counts.active ?? 0;
	if (busy && active > 0) {
		const parts = [
			`${theme.fg("fieldName", "Tools")} ${theme.fg("counter", `${active}`)} ${theme.fg("annotation", "active")}`,
			...(totalCalls > 0 ? [theme.fg("annotation", `${totalCalls} ${totalCalls === 1 ? "call" : "calls"}`)] : []),
		];
		return joinParts(theme, parts, room);
	}
	if (totalCalls === 0) return null;
	const top = entries
		.slice(0, 2)
		.map(([name, count]) => `${clean(name)} ${count}`)
		.join(` ${GLYPH.sep} `);
	if (omitCallCount && top) {
		return truncateToWidth(
			`${theme.fg("fieldName", "Tools")}  ${theme.fg("metadata", top)}`,
			room,
			GLYPH.ellipsis,
			false,
		);
	}
	const lead = `${theme.fg("fieldName", "Tools")} ${theme.fg("counter", `${totalCalls}`)} ${theme.fg("annotation", totalCalls === 1 ? "call" : "calls")}`;
	return joinParts(theme, [lead, ...(top ? [theme.fg("metadata", top)] : [])], room);
}

function routeMeta(theme: PancodeTheme, state: FooterDashboardRenderState, narrow: boolean): string {
	const autonomy = state.session.autonomy ?? "default";
	if (autonomy === "yolo") {
		const confinement = state.session.yoloConfinement === "unconfined" ? "unconfined" : "contained";
		const osSandbox = state.session.autonomyWindow?.osSandbox !== false;
		const readout = autonomyModeReadout({ confinement, osSandbox, narrow, dot: GLYPH.sep });
		const label = narrow && confinement === "contained" && osSandbox ? "YOLO" : readout.text;
		return theme.style(readout.tone === "warning" ? "warning" : "yoloLabel", label, { bold: true });
	}
	return theme.fg("annotation", clean(autonomy));
}

function routeThinkingLine(
	theme: PancodeTheme,
	state: FooterDashboardRenderState,
	detailed: boolean,
	room: number,
): string {
	const thinking = state.thinking;
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const autonomy = state.session.autonomy ?? "default";
	const window = autonomy === "yolo" ? (state.session.autonomyWindow ?? null) : null;

	let thinkPart = "";
	if (thinking && !thinking.quiet && (thinking.hasLevels || thinking.note !== undefined)) {
		const unit = thinkingRailUnit(theme, thinking, "marks");
		if (unit) {
			if (detailed) {
				thinkPart = unit;
			} else {
				const plainUnit = thinkingRailUnit(theme, thinking, "labelled");
				// Avoid doubling "think think low" when marks already fell back to `think <level>` (ASCII / NO_COLOR).
				thinkPart = unit === plainUnit ? unit : `${theme.fg("fieldName", "think")} ${unit}`;
			}
		}
	}

	if (detailed) {
		const confinement = state.session.yoloConfinement === "unconfined" ? "unconfined" : "contained";
		const osSandbox = state.session.autonomyWindow?.osSandbox !== false;
		const sandboxDetail =
			autonomy === "yolo"
				? confinement === "unconfined"
					? theme.fg("warning", "unconfined")
					: osSandbox
						? theme.fg("annotation", "auto in ws")
						: theme.fg("warning", "no OS sandbox")
				: theme.fg("annotation", "auto in ws");
		return joinParts(theme, [thinkPart, sandboxDetail], room);
	}

	if (window !== null) {
		const cap = autonomyWindowReadout(window, { narrow: true, dot: GLYPH.sep, resumeHint: "Enter continues" });
		if (cap !== null) {
			const capStyled = theme.fg(cap.tone === "warning" ? "warning" : "annotation", cap.text);
			if (thinkPart && visibleWidth(`${thinkPart}${sep}${capStyled}`) <= room) {
				return `${thinkPart}${sep}${capStyled}`;
			}
			// Step down thinking to word-only (`low · 0/100 turns`) before clipping the nearest YOLO cap.
			const wordOnly =
				thinking && !thinking.quiet && (thinking.hasLevels || thinking.note !== undefined)
					? thinkingRailUnit(theme, thinking, "word")
					: null;
			if (wordOnly && visibleWidth(`${wordOnly}${sep}${capStyled}`) <= room) {
				return `${wordOnly}${sep}${capStyled}`;
			}
			return truncateToWidth(capStyled, room, GLYPH.ellipsis, false);
		}
	}
	return truncateToWidth(thinkPart, room, GLYPH.ellipsis, false);
}

function renderRouteIsland(
	baseTheme: PancodeTheme,
	state: FooterDashboardRenderState,
	islandWidth: number,
	totalWidth: number,
	detailed: boolean,
): string[] {
	const theme = onRaisedTheme(baseTheme);
	const contentWidth = Math.max(1, islandWidth - 4);
	const rawModel = clean(state.session.modelId ?? state.session.target ?? "not configured");
	const target = state.session.targetId ? clean(state.session.targetId) : null;
	const targetSuffixWidth = target && state.session.modelId ? visibleWidth(target) + 3 : 0;
	const fittedModel = elideModelId(
		rawModel,
		targetSuffixWidth > 0 && contentWidth - targetSuffixWidth >= 12 ? contentWidth - targetSuffixWidth : contentWidth,
	);
	const row1Parts = [
		theme.style("activeModelIdentity", fittedModel, { bold: true }),
		...(target && state.session.modelId ? [theme.fg("footerIdentity", target)] : []),
	];
	const row1 = joinParts(theme, row1Parts, contentWidth);
	const row2 = routeThinkingLine(theme, state, detailed, contentWidth);

	const lines = [row1, row2];
	if (detailed) {
		const autonomy = state.session.autonomy ?? "default";
		const window = autonomy === "yolo" ? (state.session.autonomyWindow ?? null) : null;
		let row3 = "";
		if (window !== null) {
			const cap = autonomyWindowReadout(window, {
				narrow: totalWidth < DECK_WIDE_MIN,
				dot: GLYPH.sep,
				resumeHint: "Enter continues",
			});
			if (cap !== null) {
				row3 = truncateToWidth(
					theme.fg(cap.tone === "warning" ? "warning" : "annotation", cap.text),
					contentWidth,
					GLYPH.ellipsis,
					false,
				);
			}
		} else {
			const parts: string[] = [];
			if (state.context.memory) parts.push(theme.fg("annotation", clean(state.context.memory)));
			const skills = state.session.activeSkills ?? [];
			if (skills.length > 0) {
				const first = clean(skills[0] ?? "");
				parts.push(theme.fg("annotation", skills.length > 1 ? `skill ${first} +${skills.length - 1}` : `skill ${first}`));
			}
			const mcpCount = state.connections?.mcp.length ?? 0;
			if (mcpCount > 0) parts.push(theme.fg("annotation", `mcp ${mcpCount}`));
			for (const fact of state.extensionFacts ?? []) {
				if (fact.trim().length > 0) parts.push(fact);
			}
			row3 = joinParts(theme, parts, contentWidth);
		}
		lines.push(row3);
	}

	return boxIsland(baseTheme, {
		title: "Route",
		rightMeta: routeMeta(theme, state, islandWidth < 30),
		rightMetaRaw: true,
		lines,
		width: islandWidth,
	});
}

function renderDetailedTaskRow(theme: PancodeTheme, state: FooterDashboardRenderState, room: number): string | null {
	const board = state.agent.taskBoard;
	if (!board || board.tasks.length === 0) return null;
	const counts = taskBoardCounts(board);
	if (counts.open === 0) return null;
	const active =
		board.tasks.find((task) => task.status === "active") ?? board.tasks.find((task) => task.status === "blocked");
	const head = `${theme.fg("fieldName", "Tasks")} ${theme.fg("counter", `${counts.completed}/${counts.total}`)}`;
	if (!active) return visibleWidth(head) <= room ? head : null;
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const marker =
		active.status === "blocked" ? theme.fg("warning", GLYPH.phaseBlocked) : theme.fg("activity", GLYPH.running);
	const titleRoom = room - visibleWidth(head) - 5;
	if (titleRoom < 6) return visibleWidth(head) <= room ? head : null;
	const title = truncateToWidth(clean(active.title), titleRoom, GLYPH.ellipsis, false);
	return `${head}${sep}${marker} ${theme.fg("body", title)}`;
}

function renderWorkIsland(
	baseTheme: PancodeTheme,
	state: FooterDashboardRenderState,
	islandWidth: number,
	totalWidth: number,
	detailed: boolean,
): string[] {
	const theme = onRaisedTheme(baseTheme);
	const contentWidth = Math.max(1, islandWidth - 4);
	const busy = isMainBusy(state.status);
	const loops: readonly JobRecord[] = state.loops ?? [];

	let row1: string;
	if (busy) {
		row1 = renderPhaseSegment(theme, state, totalWidth, contentWidth);
	} else if (
		(state.readiness && (!state.readiness.available || state.readiness.health === "down")) ||
		state.readiness?.lastStop === "error" ||
		state.readiness?.lastStop === "no_answer" ||
		(state.status.phase === "ended" && state.status.summary?.stopReason === "error")
	) {
		row1 = renderPhaseSegment(theme, state, totalWidth, contentWidth);
	} else {
		const last = state.agent.lastTurn;
		if (last !== null) {
			const workMs = Math.max(0, last.elapsedMs - (last.humanWaitMs ?? 0));
			// The receipt's model-call count, never the tool tally: the card sat under `✓ Done · 7 calls` saying 6.
			const turn = state.telemetry.kind === "ready" ? state.telemetry.turn : null;
			const calls = turn?.calls ?? 0;
			if (detailed) {
				const parts = [
					`${theme.fg("success", GLYPH.ok)} ${theme.fg("fieldValue", `Last ${formatElapsed(workMs)}`)}`,
					...(calls > 0 ? [theme.fg("annotation", `${calls} ${calls === 1 ? "call" : "calls"}`)] : []),
					...(turn?.input ? [theme.fg("metadata", `in ${turn.input}`)] : []),
					...(turn?.output ? [theme.fg("metadata", `out ${turn.output}`)] : []),
				];
				row1 = joinParts(theme, parts, contentWidth);
			} else {
				const callsSuffix = calls > 0 ? ` (${calls} ${calls === 1 ? "call" : "calls"})` : "";
				const parts = [
					`${theme.fg("success", GLYPH.ok)} ${theme.fg("success", "Ready")}`,
					theme.fg("annotation", `last ${formatElapsed(workMs)}${callsSuffix}`),
				];
				row1 = joinParts(theme, parts, contentWidth);
			}
		} else {
			row1 = `${theme.fg("success", GLYPH.ok)} ${theme.fg("success", "Ready")}`;
		}
	}

	const taskLine = detailed
		? renderDetailedTaskRow(theme, state, contentWidth)
		: activeTaskBrief(theme, state, contentWidth);
	const loopLine = loops.length > 0 ? renderLoopLine(theme, loops, state.now, contentWidth) : null;
	const row1HasCalls =
		detailed &&
		!busy &&
		state.agent.lastTurn !== null &&
		state.telemetry.kind === "ready" &&
		(state.telemetry.turn?.calls ?? 0) > 0;
	const toolsLine = renderToolsSummary(theme, state, busy, contentWidth, row1HasCalls);
	const liveWorkers = state.dispatchRows.filter(
		(row) => row.plan === undefined && ACTIVE_DISPATCH_STATUSES.has(row.status),
	).length;
	const bandOwnsLoop = state.fleetBandVisible === true && (totalWidth >= 80 || liveWorkers === 0);

	let row2 = taskLine ?? "";
	let toolsUsedOnRow2 = false;
	if (!row2 && !detailed && busy && loopLine && !bandOwnsLoop) {
		row2 = loopLine;
	} else if (!row2 && detailed && !busy && toolsLine) {
		row2 = toolsLine;
		toolsUsedOnRow2 = true;
	}

	const lines = [row1, row2];
	if (detailed) {
		const endedCount = (state.endedNotices ?? []).filter(
			(notice) => notice.level === "warning" || notice.level === "error",
		).length;
		let row3 = "";
		if (loopLine) {
			row3 = loopLine;
		} else if (endedCount > 0) {
			row3 = truncateToWidth(
				`${theme.fg("warning", GLYPH.warn)} ${theme.fg("warning", `${endedCount} earlier ${endedCount === 1 ? "alert" : "alerts"}`)}${theme.fg("separator", ` ${GLYPH.sep} `)}${theme.fg("keyboardHint", "/usage")}`,
				contentWidth,
				GLYPH.ellipsis,
				false,
			);
		} else if (!toolsUsedOnRow2 && toolsLine) {
			row3 = toolsLine;
		}
		lines.push(row3);
	}

	const rightMeta =
		busy && state.status.phase !== "cancelling" ? theme.style("warning", "Esc stops", { bold: true }) : "";
	return boxIsland(baseTheme, {
		title: "Work",
		borderToken: busy ? "transcriptRule" : "border",
		rightMeta,
		rightMetaRaw: true,
		lines,
		width: islandWidth,
	});
}

function contextHeaderMeta(theme: PancodeTheme, facts: ContextOccupancyFacts): string {
	const used = facts.budget ? facts.used : (facts.ledger?.usedTokens ?? facts.used);
	const win = facts.budget ? facts.contextWindow : (facts.ledger?.contextWindow ?? facts.contextWindow);
	// Before the first measured turn, row 1 already states `window <W>`; leave header meta silent to avoid echoing it.
	if (used === null || !win) return "";
	const pct = (used / win) * 100;
	const whole = Math.round(pct);
	const pctStr = pct > 0 && whole === 0 ? "<1%" : `${whole}%`;
	const role = contextPercentRole(pct);
	const word = pct >= 95 ? " full" : pct >= 80 ? " high" : "";
	return theme.style(role, `${pctStr}${word}`, { bold: true });
}

function contextBarRow(theme: PancodeTheme, facts: ContextOccupancyFacts, room: number): string {
	const used = facts.budget ? facts.used : (facts.ledger?.usedTokens ?? facts.used);
	const win = facts.budget ? facts.contextWindow : (facts.ledger?.contextWindow ?? facts.contextWindow);
	if (used === null) {
		return win ? `${theme.fg("fieldName", "window")} ${theme.fg("counter", formatCount(win))}` : "";
	}
	const qualifier = contextReadingQualifier(facts);
	const qualPrefix =
		qualifier === "" ? "" : `${theme.fg("annotation", qualifier)}${qualifier === GLYPH.estimate ? "" : " "}`;
	const pair = win
		? `${qualPrefix}${theme.fg("counter", formatCount(used))} ${theme.fg("separator", "/")} ${theme.fg("metadata", formatCount(win))}`
		: `${qualPrefix}${theme.fg("counter", `${formatCount(used)} used`)}`;
	const barCells = room >= 30 ? 10 : 6;
	const bar =
		!facts.budget && facts.ledger
			? renderContextMeterBar(facts.ledger, barCells, theme)
			: buildSegmentedContextBar(theme, barCells, facts.contextWindow ?? 0, contextBreakdownForBar(facts), false);
	const combined = `${bar} ${pair}`;
	if (visibleWidth(combined) <= room) return combined;
	const tightPair = win ? `${qualPrefix}${theme.fg("counter", `${formatCount(used)}/${formatCount(win)}`)}` : pair;
	return truncateToWidth(`${bar} ${tightPair}`, room, GLYPH.ellipsis, false);
}

function renderContextIsland(
	baseTheme: PancodeTheme,
	state: FooterDashboardRenderState,
	islandWidth: number,
	totalWidth: number,
	detailed: boolean,
): string[] {
	const theme = onRaisedTheme(baseTheme);
	const contentWidth = Math.max(1, islandWidth - 4);
	const facts = contextOccupancyFrom(state);
	const row1 = contextBarRow(theme, facts, contentWidth);

	const speed = footerRateSpeed(state);
	const telemetry = state.telemetry;
	const rawCost = telemetry.kind === "ready" ? telemetry.cost : null;
	const hasMeasuredCost = rawCost !== null && rawCost !== COST_NOT_MEASURED;
	const cachePct = telemetry.kind === "ready" ? cacheHitPercent(telemetry.promptCache) : null;
	const ttft = telemetry.kind === "ready" ? (telemetry.speed?.ttft ?? null) : null;

	const lines = [row1];
	if (detailed) {
		const neverSent = telemetry.kind === "ready" ? telemetry.neverSent : null;
		const unknownUsage = telemetry.kind === "ready" && telemetry.tokens !== null && telemetry.measuredTokens === null;
		const sessionTokens =
			telemetry.kind === "ready"
				? telemetry.measuredTokens !== null
					? telemetry.measuredTokens
					: telemetry.tokens === null && neverSent !== null
						? "0"
						: null
				: null;
		const ceiling =
			typeof state.costCeilingUsd === "number" && Number.isFinite(state.costCeilingUsd) && state.costCeilingUsd > 0
				? renderUsdLimit(state.costCeilingUsd)
				: null;
		const costPart = hasMeasuredCost
			? ceiling
				? `${theme.fg("counter", rawCost)} ${theme.fg("metadata", `/ ${ceiling}`)}`
				: theme.fg("counter", rawCost)
			: sessionTokens !== null && neverSent === null
				? theme.fg("metadata", "unpriced")
				: "";
		const tokenLabel =
			sessionTokens !== null
				? neverSent && visibleWidth(`session ${sessionTokens} tokens ${GLYPH.sep} ${neverSent}`) > contentWidth
					? `${theme.fg("counter", `${sessionTokens} tok`)}`
					: `${theme.fg("fieldName", "session")} ${theme.fg("counter", `${sessionTokens} tokens`)}`
				: "";
		const row2Parts = [
			...(unknownUsage ? [theme.fg("unknownValue", "usage not measured")] : tokenLabel ? [tokenLabel] : []),
			...(costPart ? [costPart] : []),
			...(neverSent ? [theme.fg("warning", neverSent)] : []),
		];
		const row2 = joinParts(theme, row2Parts, contentWidth);
		lines.push(row2);

		const neverSentPlaced = neverSent === null || row2.includes(neverSent);
		const row3Parts = [
			...(!neverSentPlaced && neverSent ? [theme.fg("warning", neverSent)] : []),
			...(speed ? [theme.fg("counter", speed)] : []),
			...(ttft ? [`${theme.fg("fieldName", "ttft")} ${theme.fg("counter", ttft)}`] : []),
			...(cachePct !== null ? [theme.fg("annotation", `${cachePct}% hit`)] : []),
		];
		lines.push(joinParts(theme, row3Parts, contentWidth));
	} else {
		const row2Parts = [
			...(speed ? [theme.fg("counter", speed)] : []),
			...(hasMeasuredCost ? [theme.fg("counter", rawCost)] : []),
			...(cachePct !== null ? [theme.fg("annotation", `${cachePct}% cache`)] : []),
		];
		lines.push(joinParts(theme, row2Parts, contentWidth));
	}

	const title = detailed && totalWidth >= DECK_WIDE_MIN ? "Context & Spend" : "Context";
	return boxIsland(baseTheme, {
		title,
		rightMeta: contextHeaderMeta(theme, facts),
		rightMetaRaw: true,
		lines,
		width: islandWidth,
	});
}

function renderMergedRouteContextIsland(
	baseTheme: PancodeTheme,
	state: FooterDashboardRenderState,
	islandWidth: number,
	detailed: boolean,
): string[] {
	const theme = onRaisedTheme(baseTheme);
	const contentWidth = Math.max(1, islandWidth - 4);
	const facts = contextOccupancyFrom(state);
	const thinkWord =
		state.thinking && !state.thinking.quiet && state.thinking.hasLevels
			? thinkingRailUnit(theme, state.thinking, "word")
			: null;
	const thinkReserve = thinkWord ? visibleWidth(thinkWord) + 3 : 0;
	const model = elideModelId(
		clean(state.session.modelId ?? state.session.target ?? "not configured"),
		contentWidth - thinkReserve,
	);
	const row1 = joinParts(
		theme,
		[theme.style("activeModelIdentity", model, { bold: true }), ...(thinkWord ? [thinkWord] : [])],
		contentWidth,
	);
	const row2 = contextBarRow(theme, facts, contentWidth);
	const lines = [row1, row2];
	if (detailed) {
		const speed = footerRateSpeed(state);
		const rawCost = state.telemetry.kind === "ready" ? state.telemetry.cost : null;
		const cost = rawCost && rawCost !== COST_NOT_MEASURED ? rawCost : null;
		lines.push(
			joinParts(
				theme,
				[...(speed ? [theme.fg("counter", speed)] : []), ...(cost ? [theme.fg("counter", cost)] : [])],
				contentWidth,
			),
		);
	}
	const nonDefaultAutonomy = (state.session.autonomy ?? "default") !== "default";
	const ctxMeta = contextHeaderMeta(theme, facts);
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const rightMeta = nonDefaultAutonomy ? [routeMeta(theme, state, true), ctxMeta].filter(Boolean).join(sep) : ctxMeta;
	const title = nonDefaultAutonomy && islandWidth < 36 ? "Route" : "Route & Context";
	return boxIsland(baseTheme, {
		title,
		rightMeta,
		rightMetaRaw: true,
		lines,
		width: islandWidth,
	});
}

function renderStackedCompactDeck(baseTheme: PancodeTheme, state: FooterDashboardRenderState, width: number): string[] {
	const theme = onRaisedTheme(baseTheme);
	const contentWidth = Math.max(1, width - 4);
	const thinkWord =
		state.thinking && !state.thinking.quiet && state.thinking.hasLevels
			? thinkingRailUnit(theme, state.thinking, "word")
			: null;
	const thinkReserve = thinkWord ? visibleWidth(thinkWord) + 3 : 0;
	const model = elideModelId(
		clean(state.session.modelId ?? state.session.target ?? "not configured"),
		contentWidth - thinkReserve,
	);
	const row1 = joinParts(
		theme,
		[theme.style("activeModelIdentity", model, { bold: true }), ...(thinkWord ? [thinkWord] : [])],
		contentWidth,
	);
	const row2 = renderPhaseSegment(theme, state, width, contentWidth);
	const facts = contextOccupancyFrom(state);
	const row3 = joinParts(
		theme,
		[contextBarRow(theme, facts, contentWidth), contextHeaderMeta(theme, facts)],
		contentWidth,
	);
	return boxIsland(baseTheme, {
		title: "Details",
		rightMeta: routeMeta(theme, state, true),
		rightMetaRaw: true,
		lines: [row1, row2, row3],
		width,
	});
}

function joinIslandsHorizontal(islands: readonly (readonly string[])[]): string[] {
	const height = Math.max(0, ...islands.map((island) => island.length));
	const out: string[] = [];
	for (let row = 0; row < height; row += 1) {
		out.push(islands.map((island) => island[row] ?? "").join(" "));
	}
	return out;
}

export interface DeckDrawerOptions {
	readonly themeOverride?: PancodeTheme;
	/** Optional idle Capabilities map box lines (rendered below the islands when `!busy`). */
	readonly capabilityMapLines?: readonly string[];
	/** Stable cache key for `capabilityMapLines` so memoization stays O(1). */
	readonly capabilityMapKey?: string;
}

interface DeckMemo {
	key: string;
	lines: string[];
}

let lastDeckMemo: DeckMemo | null = null;

/**
 * Render the Hybrid B->A boxed island deck drawer.
 * Returns `[]` when auto-folded (W1 < 44 cols, H1 < 20 rows, or modal overlay owns dock).
 */
export function renderDeckDrawer(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows = Number.POSITIVE_INFINITY,
	options: DeckDrawerOptions = {},
): string[] {
	const w = Math.max(1, Math.floor(width));
	if (w < DECK_W1_CELLS || terminalRows < DECK_H1_ROWS) return [];
	if (state.keyContext === "surface" || state.fleetBoardOpen === true) return [];

	const policy = tierPolicy(state.outputStyle ?? presentationTier());
	const detailed = policy.provenance;
	const busy = isMainBusy(state.status);
	const capLines = !busy && options.capabilityMapLines ? options.capabilityMapLines : [];

	const animating = busy && state.status.phase !== "tool_blocked" && motionEnabled();
	const timed = busy || (state.loops?.length ?? 0) > 0 || (state.background?.length ?? 0) > 0;
	const timeKey = animating
		? `${Math.floor(state.now / 1000)}:${state.tick}`
		: timed
			? `${Math.floor(state.now / 1000)}`
			: "0";
	const memoKey =
		options.themeOverride === undefined && state.factsRevision !== undefined
			? [
					w,
					terminalRows,
					policy.tier,
					tierRevision(),
					skinEpoch(),
					state.factsRevision,
					options.capabilityMapKey ?? capLines.length,
					state.extensionFacts?.join("\x1f") ?? "",
					timeKey,
				].join("|")
			: null;
	if (memoKey !== null && lastDeckMemo !== null && lastDeckMemo.key === memoKey) return lastDeckMemo.lines;

	const theme = options.themeOverride ?? pancodeTheme();
	let islandRows: string[];
	if (w >= DECK_WIDE_MIN) {
		const w1 = 35;
		const w2 = 49;
		const w3 = w - w1 - w2 - 2;
		islandRows = joinIslandsHorizontal([
			renderRouteIsland(theme, state, w1, w, detailed),
			renderWorkIsland(theme, state, w2, w, detailed),
			renderContextIsland(theme, state, w3, w, detailed),
		]);
	} else if (w >= DECK_THREE_COL_MIN) {
		const inner = w - 2;
		const w1 = Math.max(24, Math.round((inner * 27) / 94));
		const w3 = Math.max(23, Math.round((inner * 27) / 94));
		const w2 = inner - w1 - w3;
		islandRows = joinIslandsHorizontal([
			renderRouteIsland(theme, state, w1, w, detailed),
			renderWorkIsland(theme, state, w2, w, detailed),
			renderContextIsland(theme, state, w3, w, detailed),
		]);
	} else if (w >= DECK_TWO_COL_MIN) {
		const w1 = Math.floor((w - 1) / 2);
		const w2 = w - 1 - w1;
		islandRows = joinIslandsHorizontal([
			renderMergedRouteContextIsland(theme, state, w1, detailed),
			renderWorkIsland(theme, state, w2, w, detailed),
		]);
	} else {
		islandRows = renderStackedCompactDeck(theme, state, w);
	}

	const lines = capLines.length > 0 ? [...islandRows, ...capLines] : islandRows;
	if (memoKey !== null) lastDeckMemo = { key: memoKey, lines };
	return lines;
}
