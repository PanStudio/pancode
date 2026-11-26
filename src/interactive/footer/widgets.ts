// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { formatCount } from "../../core/format-time.js";
import type { ContextActivityPhase } from "../../core/telemetry/live-events.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { AutonomyStatus } from "../../domains/safety/autonomy-window.js";
import type { LocalCapacity } from "../../domains/scheduling/local-capacity.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import type { DispatchBoardRow } from "../dispatch-row-model.js";
import { fitFooterText } from "../footer-panel.js";
import type { TurnSummary } from "../status/index.js";
import { GLYPH, padAnsi } from "../theme/index.js";

export interface ToolTallySnapshot {
	tools: Readonly<Record<string, number>>;
	errors: number;
	active?: number;
	truncatedResults?: number;
}

/** Live workspace facts. Owned by the footer; the welcome header does not repeat the branch. */
export interface WorkspaceFacts {
	cwd: string;
	branch: string | null;
	/** The first probe has not landed, so a missing branch means unknown rather than no Git. */
	branchPending?: boolean;
	/** HEAD names no branch: the abbreviated commit it sits on, which the footer names instead of `no Git branch`. */
	detachedAt?: string;
	dirty: boolean | null;
	projectType: string | null;
	remote: string | null;
}

export interface SessionFacts {
	name?: string | null;
	target: string | null;
	/** Raw route fields for boundary-aware fitting in the compact footer. */
	targetId?: string | null;
	modelId?: string | null;
	/**
	 * Ctrl+G armed the portable leader and is waiting for the next key. Shown
	 * because the frame between the two keystrokes was otherwise identical to
	 * the idle frame, on the fallback whose users have no working Alt to check
	 * it against.
	 */
	leaderArmed?: boolean;
	/**
	 * A Ctrl+C landed on an idle empty prompt and the APPLICATION_DOUBLE_TAP_MS (3 s) window that quits is
	 * open. A string is the exact line to show, with the time left and what happens to a draft.
	 */
	shutdownArmed?: boolean | string;
	/**
	 * Skills whose tool surface stays armed across turns. Shown on the compact
	 * line while it lasts, so a narrowed tool set is never implicit.
	 */
	duckBadge?: boolean;
	activeSkills?: ReadonlyArray<string>;
	/** Explicit mode remains readable after transient setting feedback expires. */
	autonomy?: string;
	/** The operator's yolo confinement; read only at yolo, absent reads contained. */
	yoloConfinement?: string;
	/** The autonomous window's counts and caps; present only at yolo. */
	autonomyWindow?: AutonomyStatus;
	/** Proactive-memory status; kept as one atomic fact row in the expanded dashboard. */
	memoryIntervention?: {
		enabled: boolean;
		tier: "rules" | "llm";
		size: number;
		stepInFlight?: boolean;
		lastDecision?: string | null;
		/** Always-on guardian state; absent on surfaces that do not run it. */
		guardian?: "off" | "idle" | "reviewing" | "waiting-capacity" | "unavailable";
	} | null;
}

/** Context engine telemetry. */
export interface ContextEngineFacts {
	/** Identifies the published accounting used by the meter; ledger stays diagnostic. */
	budget?: Pick<LiveBudgetView, "revision" | "historical" | "inputSource">;
	label: string | null;
	used: number | null;
	contextWindow: number | null;
	toolSchemaTokens: number | null;
	compactionThreshold: number | null;
	compactionAuto: boolean | null;
	compactionActive?: boolean;
	pancodeMd: string | null;
	memory: string | null;
	extensions: { active: number; installed: number } | null;
	breakdown?: ContextUsageBreakdown | null;
	/** Full categorized ledger; when present the quadrant renders the richer meter. */
	ledger?: ContextLedger | null;
}

/** Dynamic agent work: the live action quadrant. */
export interface AgentWorkFacts {
	statusText: string | null;
	dispatchSummary: string | null;
	toolTally: string;
	dispatchRows: ReadonlyArray<DispatchBoardRow>;
	contextActivity?: {
		message: string;
		detail: string | null;
		status: "started" | "running" | "completed" | "failed";
	} | null;
	/** Metrics for the most recent completed turn, surfaced when the agent is idle. */
	lastTurn: TurnSummary | null;
	/** Session task board declared through the tasks tool; null before any plan. */
	taskBoard?: TaskBoardSnapshot | null;
	/** Local node worker limit and what bound it; null when unknown. */
	localCapacity?: LocalCapacity | null;
}

/** What a running compaction reports about itself, read from the operation's own stage events. */
export interface CompactionRailFacts {
	phase: ContextActivityPhase;
	startedAtMs: number;
}

/** How a direct shell line settled, as its card states it. */
export interface ShellSettlement {
	command: string;
	exitCode: number | null;
	cancelled: boolean;
	/** The process ignored the stop and was killed. */
	killed: boolean;
	/** The line never ran, or the runner failed around it. */
	error: boolean;
}

/**
 * The `visibleWidth` guard looks redundant against `truncateToWidth`, which
 * measures internally, but it is not: dropping it pads wide-char truncations
 * with a trailing space and strips a bare ANSI reset at width 0. Both are
 * visible output, so the extra measurement stays.
 */
export function fitDashboardLine(line: string, width: number): string {
	return fitFooterText(line, width, GLYPH.ellipsis);
}

/**
 * Pad or truncate an already styled string to an exact column width. A cut is
 * marked with an ellipsis so a clipped value ("proj 1.", "read 14 · bash 9 ")
 * never reads as a complete fact.
 */
function cell(text: string, width: number): string {
	return padAnsi(text, width, GLYPH.ellipsis);
}

/**
 * The tools row answers two different questions and used to answer only the
 * second: what the model can reach, and what it has called. `registered` is the
 * count of tool schemas sent to the provider this turn, so a session that has
 * only dispatched still reports the tools it holds instead of reading "none",
 * which said the model had no tools at all.
 */
export function formatToolTally(snapshot: ToolTallySnapshot | null | undefined, registered?: number | null): string {
	const available =
		typeof registered === "number" && Number.isFinite(registered) && registered > 0
			? `${Math.floor(registered)} available`
			: null;
	if (!snapshot) return available ?? "none";
	const entries = Object.entries(snapshot.tools)
		.filter(([name, count]) => count > 0 && name.toLowerCase() !== "dispatch")
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([name, count]) => `${name} ${formatCount(count)}`);
	const called = entries.length > 0 ? entries.join(` ${GLYPH.sep} `) : available !== null ? null : "none";
	const prefix = [available, called].filter((part): part is string => part !== null).join(` ${GLYPH.sep} `);
	const active =
		typeof snapshot.active === "number" && snapshot.active > 0
			? ` ${GLYPH.sep} active ${formatCount(snapshot.active)}`
			: "";
	const truncated =
		typeof snapshot.truncatedResults === "number" && snapshot.truncatedResults > 0
			? ` ${GLYPH.sep} trunc ${formatCount(snapshot.truncatedResults)}`
			: "";
	// `1✗` read as a glyph puzzle; a count of failures says what it counts, and none is not worth a chip.
	const failed = snapshot.errors > 0 ? ` ${GLYPH.sep} ${formatCount(snapshot.errors)} failed` : "";
	return `${prefix}${active}${truncated}${failed}`;
}

/**
 * Zip two quadrant blocks into a side-by-side row, padding the shorter block so
 * both columns stay aligned, and clamping each cell to its column width.
 */
export function zipColumns(
	left: string[],
	right: string[],
	leftWidth: number,
	rightWidth: number,
	sep: string,
): string[] {
	left = left.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, leftWidth)));
	right = right.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, rightWidth)));
	const rowCount = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let i = 0; i < rowCount; i += 1) {
		lines.push(`${cell(left[i] ?? "", leftWidth)}${sep}${cell(right[i] ?? "", rightWidth)}`);
	}
	return lines;
}
