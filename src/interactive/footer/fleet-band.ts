// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Hybrid B->A transient Fleet & Loop band mounted in the footer stack above the deck/status line.
 *
 * Auto-folds to 0 rows when idle, when `/fleet` overlay is open, at compact tier (which keeps
 * worker/loop counts on its 2-row ceiling), or under H1 (< 20 terminal rows). Collapses to a
 * single quiet summary rule when the Herdr Watch pane is visible.
 */

import type { JobRecord } from "../../core/job-types.js";
import { jobPollFailure } from "../../core/job-types.js";
import { presentationTier, tierPolicy, tierRevision } from "../../core/presentation-tier.js";
import {
	compareRuns,
	type RunApprovalFacts,
	type RunCell,
	type RunFacts,
	type RunIntegrity,
	type RunOrigin,
	type RunValidation,
	runCountBuckets,
	runCountRow,
} from "../../core/run-row.js";
import { reviewFindingsWords, workerFailureHeadline } from "../../domains/dispatch/failure-headline.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import type { Component } from "../../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { isHelperRun } from "../../session-control/worker-stream.js";
import type { DispatchBoardRow } from "../dispatch-row-model.js";
import type { HarnessFactsSource } from "../harness-facts.js";
import { actionKeyLabel } from "../keybinding-manager.js";
import { formatCount, formatElapsed, GLYPH, pancodeTheme } from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";
import {
	approvalWaitWords,
	compactQuantity,
	dockedWorkerApprovalRun,
	workerActivityWords,
} from "../worker-activity.js";

const FLEET_KEY_ACTION = "pancode.dispatchBoard.toggle";
const BAND_MIN_TERMINAL_ROWS = 20;
const MAX_LISTED_WORKERS = 3;
const RULE_MIN_FILL = 3;
const TELEMETRY_WIDE_COLS = 112;

export interface FleetBandDeps {
	/** Shared harness facts source; when supplied, work rows and loops read from it. */
	facts?: Pick<HarnessFactsSource, "work" | "currentRevision">;
	getRows?: () => ReadonlyArray<DispatchBoardRow>;
	/** Settled runs this session; unacknowledged failures stay visible until `/fleet` or the workers dock shows them. */
	getSettledRows?: () => ReadonlyArray<DispatchBoardRow>;
	getLoops?: () => ReadonlyArray<JobRecord>;
	/** True while the Alt+U deck drawer is open (detailed deck's Work island owns Loop). */
	isDeckOpen?: () => boolean;
	/** True while any modal overlay or dock owns the surface; band folds to 0 rows. */
	isDockOpen?: () => boolean;
	/** True while `/fleet` overlay is open, so the band folds and acknowledges settled failures. */
	isFleetBoardOpen?: () => boolean;
	/** True while the Herdr Watch pane is visible; band collapses to a single summary rule. */
	isWatchPaneVisible?: () => boolean;
	getTerminalRows?: () => number;
	now?: () => number;
}

export interface FleetBand extends Component {
	/** O(1) visibility check for coordinating Row 1 worker counts without rendering. */
	isVisible(): boolean;
}

function isTerminal(row: DispatchBoardRow): boolean {
	return row.status === "completed" || row.status === "failed" || row.status === "aborted" || row.status === "dead";
}

function integrityOf(row: DispatchBoardRow): RunIntegrity {
	const state = row.trust?.axes.artifactIntegrity;
	return state === "verified" ? "verified" : state === "failed" ? "compromised" : "unverified";
}

function validationOf(row: DispatchBoardRow): RunValidation {
	// A review's failing verdict is what it found; it checked the work and did not fail as a run.
	if (row.reviewFindings !== undefined && row.hostVerification !== "rejected") return "none";
	if (row.hostVerification === "rejected" || row.validationFailure !== undefined) return "failed";
	switch (row.trust?.axes.validationGrounding) {
		case "validated":
			return "passed";
		case "failed":
			return "failed";
		case "ungrounded":
			return "self-reported";
		case "absent":
			return "none";
		default:
			return "unknown";
	}
}

function settledFailure(row: DispatchBoardRow): boolean {
	if (row.status === "failed" || row.status === "dead") return true;
	return row.status === "completed" && (validationOf(row) === "failed" || integrityOf(row) === "compromised");
}

function bandRuns(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const planLive = rows.some((row) => row.plan !== undefined && !isTerminal(row));
	if (!planLive) return [...rows];
	return rows.filter(
		(row) => row.plan !== undefined || row.phase === undefined || row.progress?.awaitingApproval === true,
	);
}

function originOf(row: DispatchBoardRow): RunOrigin {
	switch (row.requestOrigin) {
		case "agent":
			return "model";
		case "internal":
		case "harness":
			return "harness";
		default:
			return "operator";
	}
}

function compactTokenCount(row: DispatchBoardRow): string | null {
	const display = row.telemetry?.row.tokens.display ?? (row.usage.kind === "ready" ? row.usage.total.display : null);
	const figure = display === null ? null : compactQuantity(display);
	if (figure === null) return null;
	const match = /^(≥|≈|~|>=)?\s*(\d[\d,]*(?:\.\d+)?)$/u.exec(figure);
	const value = Number(match?.[2]?.replaceAll(",", ""));
	if (match === null || !Number.isFinite(value)) return figure;
	// Nothing counted yet says nothing; a count says what it counts, as the deck's `tok` does, so no bare number
	// hangs at the row's right edge (tui-verify 5).
	return value === 0 ? null : `${match[1] ?? ""}${formatCount(value)} tok`;
}

function approvalOf(row: DispatchBoardRow, now: number): RunApprovalFacts | undefined {
	const progress = row.progress;
	if (progress?.awaitingApproval !== true) return undefined;
	const window = progress.approvalWindow;
	return {
		decider: window?.decider ?? "operator",
		...(window?.owner !== undefined ? { owner: window.owner } : {}),
		words: (room) => approvalWaitWords(progress, { now, room, ownerFirst: true }),
		...(dockedWorkerApprovalRun() === row.runId ? { cardDocked: true } : {}),
	};
}

function livePhase(row: DispatchBoardRow, room = 48): string {
	if (row.plan !== undefined) {
		const live = row.plan.steps.filter((step) => step.state === "running").length;
		return live > 0 ? `${live} ${live === 1 ? "step" : "steps"} running` : `${row.plan.steps.length} steps`;
	}
	if (row.status === "enqueued") {
		return row.endpoint
			? `waiting for slot ${GLYPH.sep} ${sanitizeCallTargetText(row.endpoint.label)}`
			: "waiting for slot";
	}
	if (row.status === "retrying") return row.retry ? `retrying ${GLYPH.sep} attempt ${row.retry.attempt}` : "retrying";
	if (row.status === "cancelling") return "stopping";
	if (row.progress === undefined) return "starting";
	return workerActivityWords(row.progress, { room, history: row.routeFirstOutput ?? null });
}

function runFactsOf(row: DispatchBoardRow, now: number): RunFacts {
	const task = row.taskSummary === undefined ? undefined : sanitizeCallTargetText(row.taskSummary);
	const base = {
		agent: sanitizeCallTargetText(row.plan !== undefined ? `plan ${row.plan.name}` : (row.council?.label ?? row.agentId)),
		origin: originOf(row),
		...(isHelperRun(row) && row.council === undefined ? { helper: true } : {}),
		runId: row.runId,
		elapsed: formatElapsed(row.elapsedMs),
		startedAt: now - row.elapsedMs,
		...(task === undefined ? {} : { task }),
	};
	const reason = workerFailureHeadline(row.outcomeDetail?.replace(/^dispatch:\s*/u, "") ?? null) ?? undefined;
	switch (row.status) {
		case "enqueued":
			return { ...base, outcome: "queued", phase: livePhase(row) };
		case "cancelling":
			return { ...base, outcome: "running", phase: "stopping" };
		case "aborted":
			return { ...base, outcome: "cancelled", ...(reason === undefined ? {} : { reason }) };
		case "failed":
		case "dead":
			return { ...base, outcome: "failed", ...(reason === undefined ? {} : { reason }) };
		case "completed":
			return {
				...base,
				outcome: "succeeded",
				validation: validationOf(row),
				integrity: integrityOf(row),
				...(row.reviewFindings === undefined
					? {}
					: {
							task:
								task === undefined
									? reviewFindingsWords(row.reviewFindings)
									: `${reviewFindingsWords(row.reviewFindings)} ${GLYPH.sep} ${task}`,
						}),
				...(row.validationFailure === undefined ? {} : { reason: sanitizeCallTargetText(row.validationFailure) }),
			};
		default: {
			const approval = approvalOf(row, now);
			return {
				...base,
				outcome: "running",
				phase: livePhase(row),
				...(approval === undefined ? {} : { approval }),
			};
		}
	}
}

function paintCells(cells: readonly RunCell[]): string {
	const theme = pancodeTheme();
	let out = "";
	for (const cell of cells) {
		const body = `${cell.glyph === undefined ? "" : GLYPH[cell.glyph]}${cell.text}`;
		out += `${cell.lead}${body.length === 0 ? "" : theme.fg(cell.role, body)}`;
	}
	return out;
}

function fleetKeyLabel(): string {
	return actionKeyLabel(FLEET_KEY_ACTION) ?? "Alt+W";
}

function loopStateSummary(job: JobRecord, now: number) {
	const delivery = job.delivery?.state;
	const pollFailure = job.state === "active" ? jobPollFailure(job) : null;
	const running = job.active !== null || delivery === "running";
	const state =
		job.persistenceError !== null
			? "not saved"
			: job.cancelRequested
				? "stopping"
				: delivery === "running" || delivery === "pending"
					? `${job.delivery?.kind === "main_turn" ? "analysis" : "notice"} ${delivery === "running" ? "running" : "waiting"}`
					: job.state === "paused"
						? "paused"
						: pollFailure !== null
							? "failing"
							: running
								? "running"
								: job.state === "terminal"
									? "settling"
									: "waiting";
	const warn = job.cancelRequested || job.state === "paused" || job.persistenceError !== null || pollFailure !== null;
	const counter = job.spec.count === null ? `${job.settled}` : `${job.settled}/${job.spec.count}`;
	const dueAt = (state === "waiting" || state === "failing") && !running ? job.nextDueAt : null;
	const filled =
		dueAt !== null ? Math.min(6, Math.max(0, Math.floor((1 - (dueAt - now) / job.spec.intervalMs) * 6))) : 0;
	const countdown = dueAt === null ? null : dueAt <= now ? "now" : formatElapsed(dueAt - now);
	return { state, warn, counter, dueAt, filled, countdown };
}

function loopMeter(filled: number): string {
	const theme = pancodeTheme();
	return (
		theme.fg("meterFill", GLYPH.meterFull.repeat(filled)) + theme.fg("meterFree", GLYPH.meterEmpty.repeat(6 - filled))
	);
}

/** Inline Loop segment for the Fleet header rule (`>= 80` cols, omitted when detailed deck owns Loop). */
function headerLoopSegment(loops: readonly JobRecord[], width: number, now: number): string | null {
	const job = loops[0];
	if (!job || width < 80) return null;
	const theme = pancodeTheme();
	const summary = loopStateSummary(job, now);
	const tone = summary.warn ? "warning" : "annotation";
	const parts = [`Loop ${summary.counter}`];
	if (width >= 96 && summary.dueAt !== null) parts.push(loopMeter(summary.filled));
	if (summary.countdown !== null) parts.push(theme.fg("counter", summary.countdown));
	else parts.push(theme.fg(tone, summary.state));
	return theme.base(tone, parts.join(" "));
}

/** Standalone Loop-only row when 0 workers are live and >= 1 loop is active (copy.md section 8). */
function renderLoopOnlyRow(loops: readonly JobRecord[], width: number, now: number): string {
	const job = loops[0];
	if (!job) return "";
	const theme = pancodeTheme();
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const summary = loopStateSummary(job, now);
	const tone = summary.warn ? "warning" : "annotation";
	const lead =
		width >= 80 && summary.dueAt !== null
			? `${theme.fg(tone, `Loop ${summary.state}`)} ${loopMeter(summary.filled)}`
			: theme.fg(tone, `Loop ${summary.state}`);
	const parts = [lead, theme.fg("counter", summary.counter)];
	if (summary.countdown !== null) {
		const when =
			summary.countdown === "now" ? "due now" : width >= 96 ? `next in ${summary.countdown}` : summary.countdown;
		parts.push(theme.fg("counter", when));
	}
	if (loops.length > 1) parts.push(theme.fg("metadata", `+${loops.length - 1} loops`));
	return truncateToWidth(parts.join(sep), Math.max(1, width), GLYPH.ellipsis, false);
}

/** `Fleet ─── ● 2 running [· Loop 3/10 ▰▰▰▱▱▱ 42s] · Alt+W detail ─` (no keycap brackets). */
function renderHeaderRule(
	facts: readonly RunFacts[],
	loops: readonly JobRecord[],
	width: number,
	now: number,
	options: { watchPaneVisible: boolean; hideLoop: boolean },
): string {
	const theme = pancodeTheme();
	const title = `${theme.style("activity", "Fleet", { bold: true })} `;
	const tail = ` ${theme.fg("divider", GLYPH.rule)}`;
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const key = fleetKeyLabel();
	// With the workers dock up the rows live there, so the key names the dock it hides, not the band.
	const actionWord = options.watchPaneVisible ? "hide dock" : "detail";
	const actionFull = theme.fg("keyboardHint", `${key} ${actionWord}`);
	const actionShort = theme.fg("keyboardHint", key);
	const loopText = options.hideLoop ? null : headerLoopSegment(loops, width, now);

	const tryBuild = (action: string, includeLoop: boolean): string | null => {
		const rightParts = [...(includeLoop && loopText ? [loopText] : []), action];
		const rightText = rightParts.join(sep);
		const roomForCounts =
			width - visibleWidth(title) - RULE_MIN_FILL - 1 - visibleWidth(rightText) - 3 - visibleWidth(tail);
		const counts = roomForCounts > 0 ? runCountRow(runCountBuckets(facts), roomForCounts) : [];
		const meta = counts.length > 0 ? `${paintCells(counts)}${sep}${rightText}` : rightText;
		const fill = width - visibleWidth(title) - 1 - visibleWidth(meta) - visibleWidth(tail);
		if (fill < RULE_MIN_FILL) return null;
		return `${title}${theme.fg("divider", GLYPH.rule.repeat(fill))} ${meta}${tail}`;
	};

	return (
		tryBuild(actionFull, true) ??
		tryBuild(actionFull, false) ??
		tryBuild(actionShort, false) ??
		truncateToWidth(
			`${title}${paintCells(runCountRow(runCountBuckets(facts), width))} ${actionShort}`,
			width,
			GLYPH.ellipsis,
			false,
		)
	);
}

function padRightVisible(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, GLYPH.ellipsis, false);
	const pad = Math.max(0, width - visibleWidth(clipped));
	return `${clipped}${" ".repeat(pad)}`;
}

function padLeftVisible(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", false);
	const pad = Math.max(0, width - visibleWidth(clipped));
	return `${" ".repeat(pad)}${clipped}`;
}

function renderWorkerRow(row: DispatchBoardRow, fact: RunFacts, width: number, showTelemetry: boolean): string {
	const theme = pancodeTheme();
	const agentWidth = width >= 80 ? 9 : 8;
	const originGlyph = fact.origin === "operator" ? GLYPH.workerHuman : GLYPH.workerAgent;
	const isFailed = fact.outcome === "failed" || fact.validation === "failed" || fact.integrity === "compromised";
	const isWaiting = fact.approval !== undefined;
	const glyphTone = isFailed ? "error" : isWaiting ? "warning" : "workerIdentity";
	const agentText = theme.fg("workerIdentity", padRightVisible(fact.agent, agentWidth));
	const timeText = theme.fg("counter", padLeftVisible(fact.elapsed ?? "", 5));
	const lead = `  ${theme.fg(glyphTone, originGlyph)} ${agentText} ${timeText}  `;
	const leadWidth = visibleWidth(lead);
	const remaining = Math.max(1, width - leadWidth);

	let rightText = "";
	if (showTelemetry) {
		const sep = theme.fg("separator", ` ${GLYPH.sep} `);
		const tokens = compactTokenCount(row);
		const calls = row.progress?.toolCalls ?? row.completion?.toolCalls;
		const rightParts = [
			...(tokens ? [tokens] : []),
			...(calls !== undefined && calls > 0 ? [`${calls} ${calls === 1 ? "call" : "calls"}`] : []),
		];
		if (rightParts.length > 0) {
			const candidate = theme.fg("annotation", rightParts.join(sep));
			if (remaining - visibleWidth(candidate) - 2 >= 20) rightText = candidate;
		}
	}

	const phaseRoom = rightText ? remaining - visibleWidth(rightText) - 2 : remaining;
	let phaseText: string;
	if (isFailed) {
		const headline = fact.reason ?? "failed";
		phaseText = theme.fg("error", truncateToWidth(`${GLYPH.error} ${headline}`, phaseRoom, GLYPH.ellipsis, false));
	} else if (isWaiting && fact.approval) {
		const waitWords = fact.approval.words(Math.max(1, phaseRoom - 2));
		phaseText = theme.fg(
			"warning",
			truncateToWidth(`${GLYPH.phaseBlocked} ${waitWords}`, phaseRoom, GLYPH.ellipsis, false),
		);
	} else if (fact.outcome === "cancelled") {
		phaseText = theme.fg("annotation", truncateToWidth(fact.reason ?? "stopping", phaseRoom, GLYPH.ellipsis, false));
	} else {
		const phase = livePhase(row, phaseRoom);
		const phaseStyled = theme.fg(
			fact.outcome === "running" ? "activity" : "body",
			truncateToWidth(phase, phaseRoom, GLYPH.ellipsis, false),
		);
		const taskBrief = width >= 80 && fact.task ? fact.task.trim() : "";
		const briefRoom = taskBrief ? phaseRoom - visibleWidth(phaseStyled) - 3 : 0;
		if (taskBrief && briefRoom >= 16) {
			phaseText = `${phaseStyled}${theme.fg("separator", ` ${GLYPH.sep} `)}${theme.fg("annotation", truncateToWidth(taskBrief, briefRoom, GLYPH.ellipsis, false))}`;
		} else {
			phaseText = phaseStyled;
		}
	}

	if (!rightText) return `${lead}${phaseText}`;
	const gap = Math.max(2, remaining - visibleWidth(phaseText) - visibleWidth(rightText));
	return `${lead}${phaseText}${" ".repeat(gap)}${rightText}`;
}

/** The hidden rows by state, `+N more running` for one state, `+N more (2 running · 1 failed)` for a mix. */
function overflowCountText(hidden: readonly { fact: RunFacts }[]): string {
	const counts = new Map<string, number>();
	for (const { fact } of hidden) {
		const state =
			fact.outcome === "failed" || fact.validation === "failed" || fact.integrity === "compromised"
				? "failed"
				: fact.approval !== undefined
					? "waiting"
					: fact.outcome;
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	const [only] = counts.keys();
	if (counts.size === 1 && only !== undefined) return `+${hidden.length} more ${only}`;
	return `+${hidden.length} more (${[...counts].map(([state, n]) => `${n} ${state}`).join(` ${GLYPH.sep} `)})`;
}

function renderOverflowRow(hidden: readonly { row: DispatchBoardRow; fact: RunFacts }[], width: number): string {
	const theme = pancodeTheme();
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const count = theme.fg("annotation", `  ${overflowCountText(hidden)}`);
	const next = hidden[0];
	if (!next || width < 80) return truncateToWidth(count, Math.max(1, width), GLYPH.ellipsis, false);
	const nextDetail =
		width >= 96
			? `${next.fact.agent} (${next.fact.reason ?? livePhase(next.row, 24)} ${GLYPH.sep} ${next.fact.elapsed})`
			: `${next.fact.agent} (${next.fact.elapsed})`;
	return truncateToWidth(`${count}${sep}${theme.fg("metadata", nextDetail)}`, Math.max(1, width), GLYPH.ellipsis, false);
}

interface FleetBandMemo {
	key: string;
	lines: string[];
}

const EMPTY_BAND_LINES: string[] = [];

export function createFleetBand(deps: FleetBandDeps): FleetBand {
	const acknowledged = new Set<string>();
	let memo: FleetBandMemo | null = null;

	const watchPaneVisible = (): boolean =>
		deps.isWatchPaneVisible !== undefined
			? deps.isWatchPaneVisible() === true
			: deps.facts?.work().watchPaneVisible === true;

	/** The band's runs; a failure `/fleet` or the workers dock has shown the operator stops pinning the band. */
	const currentFeed = (shown: boolean): { runs: DispatchBoardRow[]; loops: ReadonlyArray<JobRecord> } => {
		const work = deps.facts?.work();
		const live = deps.getRows?.() ?? work?.liveRows ?? [];
		const failed = (deps.getSettledRows?.() ?? work?.settledWorkerRows ?? []).filter(settledFailure);
		if (shown) for (const row of failed) acknowledged.add(row.runId);
		const listed = new Set(live.map((row) => row.runId));
		const kept = failed.filter((row) => !acknowledged.has(row.runId) && !listed.has(row.runId));
		const runs = bandRuns(kept.length === 0 ? live : [...live, ...kept]);
		const loops = deps.getLoops?.() ?? work?.loops ?? [];
		return { runs, loops };
	};

	const isVisible = (): boolean => {
		const policy = tierPolicy(presentationTier());
		if (!policy.hintRow) return false;
		const terminalRows = deps.getTerminalRows?.() ?? 40;
		if (terminalRows < BAND_MIN_TERMINAL_ROWS) return false;
		if (deps.isDockOpen?.() === true || deps.isFleetBoardOpen?.() === true) return false;
		const { runs, loops } = currentFeed(watchPaneVisible());
		if (runs.length > 0) return true;
		const deckOpen = deps.isDeckOpen?.() === true;
		return loops.length > 0 && !(deckOpen && policy.provenance);
	};

	return {
		isVisible,
		render(width) {
			const policy = tierPolicy(presentationTier());
			const terminalRows = deps.getTerminalRows?.() ?? 40;
			const boardOpen = deps.isFleetBoardOpen?.() === true;
			const dockOpen = deps.isDockOpen?.() === true || boardOpen;
			if (!policy.hintRow || terminalRows < BAND_MIN_TERMINAL_ROWS || dockOpen) {
				if (boardOpen) currentFeed(true);
				memo = null;
				return EMPTY_BAND_LINES;
			}
			const watchPaneShown = watchPaneVisible();
			const { runs, loops } = currentFeed(watchPaneShown);
			const deckOpen = deps.isDeckOpen?.() === true;
			if (runs.length === 0 && (loops.length === 0 || (deckOpen && policy.provenance))) {
				memo = null;
				return EMPTY_BAND_LINES;
			}

			const safeWidth = Math.max(1, Math.floor(width));
			const now = deps.now?.() ?? Date.now();
			const secondBucket = Math.floor(now / 1000);
			const factsRev = deps.facts?.currentRevision;

			const memoKey =
				factsRev !== undefined
					? [
							safeWidth,
							terminalRows,
							policy.tier,
							tierRevision(),
							skinEpoch(),
							factsRev,
							secondBucket,
							watchPaneShown ? 1 : 0,
							deckOpen ? 1 : 0,
						].join("|")
					: null;
			if (memoKey !== null && memo !== null && memo.key === memoKey) return memo.lines;

			let lines: string[];
			if (runs.length === 0) {
				lines = [renderLoopOnlyRow(loops, safeWidth, now)];
			} else {
				// Live workers hold the listed rows; a settled failure waiting for `/fleet` follows them (fleet finding 14).
				const ordered = runs
					.map((row) => ({ row, fact: runFactsOf(row, now) }))
					.sort((a, b) => Number(isTerminal(a.row)) - Number(isTerminal(b.row)) || compareRuns(a.fact, b.fact));
				const facts = ordered.map((entry) => entry.fact);
				const header = renderHeaderRule(facts, loops, safeWidth, now, {
					watchPaneVisible: watchPaneShown,
					hideLoop: watchPaneShown || (deckOpen && policy.provenance),
				});
				if (watchPaneShown) {
					lines = [header];
				} else {
					const showTelemetry = policy.provenance || safeWidth >= TELEMETRY_WIDE_COLS;
					const listed = ordered.slice(0, MAX_LISTED_WORKERS);
					const hidden = ordered.slice(MAX_LISTED_WORKERS);
					lines = [
						header,
						...listed.map((entry) => renderWorkerRow(entry.row, entry.fact, safeWidth, showTelemetry)),
						...(hidden.length > 0 ? [renderOverflowRow(hidden, safeWidth)] : []),
					];
				}
			}

			if (memoKey !== null) memo = { key: memoKey, lines };
			return lines;
		},
		invalidate() {
			memo = null;
		},
	};
}
