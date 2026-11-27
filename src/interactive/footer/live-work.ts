// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * What keeps running behind a surface that hides the composer rail: the rail's worker detail and the live run's short
 * state on a focused surface's top rule.
 *
 * A docked overlay draws its own title and keys on the composer's rails, so a run looked like it had stopped for as
 * long as `/settings` or `/fleet` stayed open (F05). The overlay rule now says what runs; the words come from the
 * same status the rail reads, so the two cannot disagree when the rail returns.
 */

import { ToolNames } from "../../core/tool-names.js";
import { visibleWidth } from "../../engine/tui.js";
import { sanitizeCallTargetText } from "../../lib/call-target/call-target.js";
import { COUNCIL_SYNTHESIS_LABEL } from "../../session-control/council.js";
import type { BackgroundCall } from "../background-calls.js";
import type { DispatchBoardRow } from "../dispatch-row-model.js";
import type { AgentStatus } from "../status/index.js";
import { formatElapsed, formatWaitClock, GLYPH } from "../theme/index.js";
import { modelNickname } from "../theme/labels.js";
import type { CompactionRailFacts } from "./widgets.js";

export interface LiveWorkFacts {
	/** The name the composer rail gives the main agent. */
	actor: string;
	/** The target the main turn's requests go to, by its configured name, which the rail names too. */
	target?: string;
	status: AgentStatus;
	/** The running compaction's stage and start, which the rail reads too; null or absent when none runs. */
	compaction?: CompactionRailFacts | null;
	/** Active fleet runs, helpers excluded; only the first is named. */
	workers: ReadonlyArray<DispatchBoardRow>;
	/** How the worker's current action reads on the fleet dock, in the columns its row leaves it. */
	workerActivity: (row: DispatchBoardRow, room: number) => string;
	/** Side-agent model calls in flight, from their journaled start to their settle. */
	background: ReadonlyArray<BackgroundCall>;
	now: number;
}

/** Whole elapsed milliseconds of the current phase; a tool's elapsed is its own call's. */
export function phaseElapsedMs(status: AgentStatus, now: number): number {
	// The phase's own start: `is writing · 23s` once carried the whole turn's time into a reply under a second old.
	const start =
		status.phase === "tool_running"
			? (status.toolStartedAt ?? status.phaseSince ?? status.since)
			: (status.phaseSince ?? status.since);
	return start > 0 ? Math.max(0, now - start) : 0;
}

function workerElapsed(row: DispatchBoardRow): string | null {
	// A plan has no run telemetry of its own; its clock is the board row's, from its start.
	if (row.plan !== undefined) return formatWaitClock(row.elapsedMs);
	const elapsed = row.telemetry?.activity.elapsed.display;
	// Whole seconds, as the rail's own phase counts them: tenths beside it read as a different clock.
	return elapsed && elapsed !== "not available" ? elapsed.replace(/\.\d+(?=s$)/u, "") : null;
}

/**
 * The worker that says the most about what is holding work up: one waiting on
 * the operator, then the main agent's own dispatch over a run the operator
 * started beside it, then a started run over a queued one.
 */
function foregroundWorker(facts: LiveWorkFacts): DispatchBoardRow | undefined {
	const asking = facts.workers.find((row) => row.progress?.awaitingApproval === true);
	if (asking !== undefined) return asking;
	const blocked = facts.status.phase === "dispatching" || facts.status.tool?.toolName === ToolNames.Dispatch;
	return (
		(blocked ? facts.workers.find((row) => row.requestOrigin === "agent") : undefined) ??
		facts.workers.find((row) => row.status !== "enqueued") ??
		facts.workers[0]
	);
}

/** A second worker on the rail says what it is doing in about this much, so it never squeezes the first. */
const SECOND_WORKER_WORDS = 28;

/** The share of a rail the work beside the phase may take by naming a second worker. */
const SECOND_WORKER_RAIL_SHARE = 0.6;
const SECOND_WORKER_MIN_RAIL = 100;

/** `verifier reading README.md · 12s`: which worker, what it is doing, for how long. */
/** A council member goes by the label the operator watches it under, as its notice does, not the recipe all share. */
function workerRailName(row: DispatchBoardRow): string {
	const council = row.council;
	if (council === undefined) return sanitizeCallTargetText(row.agentId);
	return sanitizeCallTargetText(
		council.label === COUNCIL_SYNTHESIS_LABEL ? "council synthesis" : `council member ${council.label}`,
	);
}

function workerSummary(facts: LiveWorkFacts, width: number, cap = width): string | null {
	const first = foregroundWorker(facts);
	if (first === undefined) return null;
	const name = workerRailName(first);
	const elapsed = workerElapsed(first);
	// A queued run is held up and a running one is not, so `+1 more` must not stand for both.
	const rest = facts.workers.filter((row) => row !== first);
	const queued = rest.filter((row) => row.status === "enqueued").length;
	const others = rest.length - queued;
	const trail = [elapsed, others > 0 ? `+${others} more` : null, queued > 0 ? `+${queued} queued` : null].filter(
		Boolean,
	);
	const taken = visibleWidth(name) + 1 + trail.reduce((sum, part) => sum + visibleWidth(part as string) + 3, 0);
	const doing = sanitizeCallTargetText(facts.workerActivity(first, width - taken));
	// With room, the second running worker is named too, because `+1 more` sends the reader to /fleet to learn who.
	const second = rest.find((row) => row.status !== "enqueued");
	if (second !== undefined) {
		const secondElapsed = workerElapsed(second);
		const named = [
			`${name} ${doing}`,
			elapsed,
			`${workerRailName(second)} ${sanitizeCallTargetText(facts.workerActivity(second, SECOND_WORKER_WORDS))}`,
			secondElapsed,
			others > 1 ? `+${others - 1} more` : null,
			queued > 0 ? `+${queued} queued` : null,
		]
			.filter(Boolean)
			.join(` ${GLYPH.sep} `);
		if (visibleWidth(named) <= cap) return named;
	}
	return [`${name} ${doing}`, ...trail].join(` ${GLYPH.sep} `);
}

/** `memory review on Qwopus3.8 · 3s`, shedding the route first when the room is short. */
function backgroundSummary(facts: LiveWorkFacts, width: number): string | null {
	const call = facts.background[0];
	if (call === undefined) return null;
	const elapsed = formatElapsed(Math.max(0, facts.now - call.startedAt));
	const others = facts.background.length - 1;
	return [
		width >= 60 ? `${call.purpose} on ${modelNickname(call.model)}` : call.purpose,
		elapsed,
		others > 0 ? `+${others} more` : null,
	]
		.filter(Boolean)
		.join(` ${GLYPH.sep} `);
}

function isMainActive(status: AgentStatus): boolean {
	return status.phase !== "idle" && status.phase !== "ended";
}

/**
 * What runs beside the main phase, for the rail to say after it. A finished turn
 * keeps reading finished; this only adds what is still going and whether a prompt
 * can go in now, which it can unless the turn itself is waiting on this work.
 */
export function railDetail(facts: LiveWorkFacts, width: number): string | null {
	// An 80-column rail cannot hold two workers and the main phase's name and clock, and those come first.
	const worker = workerSummary(
		facts,
		width,
		width >= SECOND_WORKER_MIN_RAIL ? Math.floor(width * SECOND_WORKER_RAIL_SHARE) : 0,
	);
	const background = backgroundSummary(facts, width);
	if (worker === null && background === null) return null;
	const waiting = facts.background.some((call) => call.blocksTurn);
	const consequence = waiting ? "the turn waits" : isMainActive(facts.status) ? null : "you can send";
	// A worker the turn is blocked on reads straight after `is waiting for a worker`
	// and leads whatever else is going; the consequence goes first on a short rail.
	return [worker, background, width >= 60 ? consequence : null].filter(Boolean).join(` ${GLYPH.sep} `);
}

/**
 * Whether the main turn is working on its own while a card holds the rail. An ask from anyone blocks the status, so
 * the phase alone says nothing: the caller knows whether a run is streaming and whether it parked a call of its own.
 */
function mainKeepsRunning(status: AgentStatus, turn: { streaming: boolean; parked: boolean }): boolean {
	if (!turn.streaming || turn.parked || status.tool?.toolName === ToolNames.AskUser) return false;
	return status.phase !== "cancelling" && status.phase !== "dispatching" && status.tool?.toolName !== ToolNames.Dispatch;
}

/**
 * What goes on beside the card holding the rail: the card foregrounds the decision, and this says what it is not holding
 * up. Null when nothing is, or when the room cannot state it whole.
 */
export function besideCardDetail(
	facts: LiveWorkFacts,
	room: number,
	turn: { streaming: boolean; parked: boolean },
): string | null {
	const main = mainKeepsRunning(facts.status, turn) ? "the main turn keeps running" : null;
	const free = facts.workers.filter((row) => row.progress?.awaitingApproval !== true);
	const workers = free.length === 0 ? null : workerSummary({ ...facts, workers: free }, room);
	const both = main !== null && workers !== null ? `${main} ${GLYPH.sep} ${workers}` : null;
	return [both, workers, main].find((text) => text !== null && visibleWidth(text) <= room) ?? null;
}
