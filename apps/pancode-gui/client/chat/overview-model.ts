// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The numbers at the top of the Progress view: how long the task has run, how much it has used, and
// how far its plan has come. Pure and defensive, because every field is a reported value that may be
// absent on a replayed turn.

import type { ContextLedger } from "../../contracts/context-ledger.js";
import type { SessionWorkspace } from "../../contracts/session-telemetry.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { formatDuration } from "../api/clock.js";
import type { ActiveWork } from "../shell/shell-model.js";
import type { PaneSession } from "./pane-model.js";
import { isStoppedEarly, turnEnding } from "./turns.js";

/**
 * Turn count, wall time and whether a turn is running. Tokens and cost are not summed here: the read model folds
 * them and the usage read carries its displays, so a client sum would be a second, lesser accounting (#434).
 */
export interface TaskOverview {
	readonly turns: number;
	readonly elapsedMs: number;
	readonly running: boolean;
}

function at(value: string | null | undefined): number | null {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

export function taskOverview(turns: SessionSnapshot["turns"], nowMs: number): TaskOverview {
	let elapsed = 0;
	let running = false;
	for (const turn of turns) {
		const start = at(turn.startedAt);
		if (start === null) continue;
		const end = at(turn.finishedAt);
		if (end !== null) elapsed += Math.max(0, end - start);
		else if (turn.status === "running") {
			running = true;
			elapsed += nowMs > 0 ? Math.max(0, nowMs - start) : 0;
		}
	}
	return { turns: turns.length, elapsedMs: elapsed, running };
}

export interface ContextMeter {
	/** 0 to 100, clamped for drawing. */
	readonly percent: number;
	/** The share in use as the server worded it, or null when the ledger reports no share. */
	readonly figure: string | null;
	readonly tone: "ok" | "warn" | "full";
	/** "43K of 128K tokens", with "estimated" until the provider reports usage. */
	readonly label: string;
	/** The whole sentence for assistive technology. */
	readonly text: string;
}

/**
 * The window meter on the Progress view, from PanCode's own accounting. Null when the window size is not
 * reported, because a share of an unknown size would be invented.
 */
/** The meter's fill is geometry from the ledger's counts; its words are the server's displays (#434). */
export function contextMeter(
	ledger: Pick<ContextLedger, "usedTokens" | "contextWindow" | "percent" | "measured" | "display">,
): ContextMeter | null {
	const meter = ledger.display.meter;
	if (ledger.contextWindow <= 0 || meter === null) return null;
	const raw = ledger.percent ?? 0;
	const percent = Math.min(100, Math.max(0, raw));
	const tone = percent >= 85 ? "full" : percent >= 65 ? "warn" : "ok";
	const label = `${meter.used} of ${meter.window} tokens${ledger.measured ? "" : ", estimated"}`;
	return {
		percent,
		figure: ledger.display.percent,
		tone,
		label,
		text: `Context window ${ledger.display.percent ?? "share not reported"} used, ${label}`,
	};
}

const count = (value: number, one: string, many = `${one}s`): string => `${value} ${value === 1 ? one : many}`;

/** The Task card's state word: a pause or context work first, then the running turn, then how the last turn ended. */
export function taskStateWord(session: Pick<PaneSession, "state" | "contextWork" | "turns">, running: boolean): string {
	if (session.state === "parked") return "Paused";
	if (session.contextWork?.active && session.state === "open") return "Context work";
	if (running) return "Working";
	const last = session.turns.at(-1);
	if (!last) return "Not started";
	if (last.queued) return "Waiting for a slot";
	if (last.status === "failed") return "Failed";
	if (last.status === "cancelled") return "Stopped";
	return isStoppedEarly(turnEnding(last)) ? "Stopped early" : "Complete";
}

/** "3 turns · 2m 10s". The time shows once it reaches a second. */
export function turnsLine(overview: TaskOverview): string {
	const time = overview.elapsedMs >= 1000 ? formatDuration(overview.elapsedMs) : null;
	return [count(overview.turns, "turn"), time].filter(Boolean).join(" · ");
}

export function healthSummary(health: { readonly attention: boolean; readonly rows: readonly unknown[] }): string {
	return health.attention ? "Needs attention" : count(health.rows.length, "report");
}

export function moreSteps(total: number, shown: number): string {
	const more = total - shown;
	return `${more} more ${more === 1 ? "step" : "steps"} in the full plan.`;
}

/** "2 tasks of yours · 1 decision", or null when there is neither. */
export function boardLine(openTasks: number, decisions: number): string | null {
	if (openTasks === 0 && decisions === 0) return null;
	return [
		openTasks > 0 ? `${count(openTasks, "task")} of yours` : null,
		decisions > 0 ? count(decisions, "decision") : null,
	]
		.filter(Boolean)
		.join(" · ");
}

export function agentsLine(live: number, runs: number): string {
	return `${live > 0 ? `${live} live · ` : ""}${count(runs, "run")}`;
}

/** Run records when there are any, else evidence bundles. */
export function evidenceLine(records: number, bundles: number): string {
	return records > 0 ? count(records, "record") : count(bundles, "bundle");
}

export function findingsText(findings: number | null): string {
	return findings === null ? "findings not reported" : count(findings, "finding");
}

export function forkPointsLine(branchPoints: number): string {
	return count(branchPoints, "fork point");
}

/** "2 working · 1 queued · 1 need approval"; the approval part shows only when one waits. */
export function activityLine(work: Pick<ActiveWork<unknown>, "working" | "queued" | "approval">): string {
	return `${work.working} working · ${work.queued} queued${work.approval > 0 ? ` · ${work.approval} need approval` : ""}`;
}

/** The workspace's Git state in one line: branch, working tree, then how far it is from its upstream. */
export function gitLine(workspace: Pick<SessionWorkspace, "isGit" | "branch" | "dirty" | "ahead" | "behind">): string {
	if (!workspace.isGit) return "No Git repository";
	return [
		workspace.branch ?? "Detached HEAD",
		workspace.dirty === null
			? "Working tree not reported"
			: workspace.dirty
				? "Uncommitted changes"
				: "Clean working tree",
		workspace.ahead ? `${workspace.ahead} ahead` : null,
		workspace.behind ? `${workspace.behind} behind` : null,
	]
		.filter(Boolean)
		.join(" · ");
}
