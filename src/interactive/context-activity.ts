// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ContextOperationOutcome } from "../core/context-operation.js";
import { formatCount } from "../core/format-time.js";
import { tierPolicy } from "../core/presentation-tier.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type {
	ContextActivityKind,
	ContextActivityPayload,
	ContextActivityPhase,
	ContextActivityStatus,
} from "../core/telemetry/live-events.js";
import type { Component } from "../engine/tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import {
	CONTEXT_KIND_TITLES,
	outcomeTone,
	outcomeWord,
	plain,
	showsContextResult,
	unchangedTokenLead,
} from "./context-operation-view.js";
import { animationStep, formatElapsed, GLYPH, padAnsi, pancodeTheme, spinnerFrame } from "./theme/index.js";

export interface ContextActivitySnapshot {
	operation?: ContextActivityPayload["operation"];
	/** The operation's own conclusion once it has one; stage events never carry it. */
	outcome?: ContextOperationOutcome;
	/** Other operations still running behind the one this snapshot describes. */
	otherRunning?: number;
	kind: ContextActivityKind;
	phase: ContextActivityPhase;
	status: ContextActivityStatus;
	message: string;
	startedAtMs: number;
	phaseStartedAtMs?: number;
	timing?: ContextActivityPayload["timing"];
	updatedAtMs: number;
	completedAtMs: number | null;
	current: number | null;
	total: number | null;
	/** What the counts measure; absent counts items. */
	unit?: "tokens";
	detail: string | null;
	stages?: ReadonlyArray<ContextActivityPhase>;
}

const PHASES: ReadonlyArray<ContextActivityPhase> = ["scan", "codewiki", "generate", "pancode-md", "state", "done"];
const PHASE_LABELS: Record<ContextActivityPhase, string> = {
	scan: "scan",
	codewiki: "index",
	generate: "draft",
	"pancode-md": "handbook",
	state: "save",
	compact: "prepare",
	summarize: "summarize",
	done: "done",
};
const TERMINAL_RETENTION_MS = 6000;
/** More than a handful of concurrent context operations means a leak, not work. */
const MAX_TRACKED_RUNS = 8;

function phasesFor(activity: ContextActivitySnapshot): ReadonlyArray<ContextActivityPhase> {
	if (activity.stages?.length) return activity.stages.filter((phase) => phase !== "done");
	if (activity.kind === "compaction") return ["compact", "summarize", "state"];
	if (activity.kind === "context-clear" || activity.kind === "context-recall" || activity.kind === "context-recover")
		return ["state"];
	if (activity.kind === "context-refresh") return ["codewiki", "state"];
	return PHASES.slice(0, -1);
}

export interface ContextRailOptions {
	/** What Enter does with a message typed right now; shown only while the operation runs. */
	admission?: string | null;
	/** Collapse to a single crisp progress row (compact tier or widths below 72 columns). */
	compact?: boolean;
}

/** A full-width, three-row (or single-row compact) transient context-operation progress instrument. */
export function formatContextActivityRailLines(
	activity: ContextActivitySnapshot,
	width: number,
	now = Date.now(),
	tick = animationStep(now),
	options: ContextRailOptions = {},
): string[] {
	if (width <= 0) return [];
	const theme = pancodeTheme();
	const sep = ` ${GLYPH.sep} `;
	const outcome = activity.outcome;
	const settled = activity.completedAtMs !== null;
	// An operation that changed nothing finished no work: a check mark and a full bar read as done work (CLI-P55).
	const unchanged = settled && outcome === "unchanged";
	const done = settled && activity.status === "completed" && !unchanged;
	const cancelled = outcome === "cancelled";
	// A stop reports through the failed status but is the operator's choice, so it wears the cancel mark, not an error's.
	const failed = activity.status === "failed" && !cancelled;
	const stages = phasesFor(activity);
	const index = done ? stages.length : Math.max(0, stages.indexOf(activity.phase));
	const elapsed = formatElapsed(Math.max(0, (activity.completedAtMs ?? now) - activity.startedAtMs));
	const tone = outcome ? outcomeTone(outcome) : failed ? "error" : done ? "success" : "contextAction";
	const glyph = cancelled
		? GLYPH.cancelled
		: failed
			? GLYPH.error
			: unchanged
				? GLYPH.dot
				: done
					? GLYPH.ok
					: spinnerFrame(tick);
	const title = theme.fg(tone, `${glyph} ${CONTEXT_KIND_TITLES[activity.kind]}`);
	const step = settled
		? outcome
			? outcomeWord(outcome)
			: failed
				? "failed"
				: "complete"
		: `${Math.min(stages.length, index + 1)}/${stages.length} ${PHASE_LABELS[activity.phase]}`;
	const measure = !settled ? tokenMeasure(activity) : "";
	const counts =
		activity.unit !== "tokens" && activity.current !== null && activity.total !== null
			? `${sep}${activity.current}/${activity.total}`
			: "";
	const clock = theme.fg("toolMetadata", elapsed);
	if (options.compact === true) {
		const compactSuffix = [
			step,
			...(measure ? [measure] : []),
			...(counts ? [`${activity.current}/${activity.total}`] : []),
			...(!settled && activity.otherRunning ? [`+${activity.otherRunning} more`] : []),
		].join(sep);
		const compactHeader = `${title}${theme.fg("annotation", `${sep}${compactSuffix}`)}`;
		return [
			padAnsi(
				`${padAnsi(compactHeader, Math.max(0, width - visibleWidth(clock) - 1), GLYPH.ellipsis)} ${clock}`,
				width,
				GLYPH.ellipsis,
			),
		];
	}
	let header = `${title}${theme.fg("annotation", `${sep}${step}`)}`;
	if (width >= 72 && !settled) {
		const trail = stages
			.map((phase, position) =>
				// The marks say where the run is without colour or weight; only the hue used to.
				theme.fg(
					position < index ? "success" : position === index ? "contextAction" : "annotation",
					`${position < index ? `${GLYPH.ok} ` : position === index ? `${GLYPH.running} ` : ""}${PHASE_LABELS[phase]}`,
				),
			)
			.join(theme.fg("border", ` ${GLYPH.crumb} `));
		header = `${title}  ${trail}`;
	}
	const rows = [
		padAnsi(
			`${padAnsi(header, Math.max(0, width - visibleWidth(clock) - 1), GLYPH.ellipsis)} ${clock}`,
			width,
			GLYPH.ellipsis,
		),
	];
	// The bar measures the running stage only. Stage position is already in the
	// trail and the step label; weighting stages equally filled 40% of the bar
	// before a four-minute draft began (index finishes in under a second).
	// Known counts fill the bar. Unknown work advances an unfilled marker
	// monotonically within the stage without claiming a percentage (flywheel r4/1).
	// A stage that streams tokens names its measure at the bar's end, or says
	// nothing is measurable yet, so the reading survives a rail too narrow for the message row.
	const barWidth = measure && width - visibleWidth(measure) - 1 >= 12 ? width - visibleWidth(measure) - 1 : width;
	const known = unchanged
		? 0
		: activity.total !== null && activity.total > 0 && activity.current !== null
			? Math.max(0, Math.min(1, activity.current / activity.total))
			: activity.status === "completed"
				? 1
				: null;
	const filled = done ? barWidth : known === null ? 0 : Math.min(barWidth - 1, Math.floor(known * barWidth));
	const stageElapsed = Math.max(
		0,
		(activity.completedAtMs ?? now) - (activity.phaseStartedAtMs ?? activity.startedAtMs),
	);
	const marker =
		known === null && !done && !failed ? Math.floor(((barWidth - 1) * stageElapsed) / (stageElapsed + 30_000)) : filled;
	const remaining = barWidth - marker;
	rows.push(
		theme.fg(tone, GLYPH.barFull.repeat(known === null ? 0 : filled)) +
			theme.fg("meterFree", GLYPH.barEmpty.repeat(known === null ? marker : 0)) +
			(!done && !unchanged ? theme.fg(tone, failed ? GLYPH.error : cancelled ? GLYPH.cancelled : GLYPH.toolHeader) : "") +
			theme.fg("meterFree", GLYPH.barEmpty.repeat(Math.max(0, remaining - (done || unchanged ? 0 : 1)))) +
			(barWidth < width ? ` ${theme.fg("toolMetadata", measure)}` : ""),
	);
	const timing = activity.timing;
	const runSuffix = timing && tierPolicy().provenance ? `${sep}run ${plain(timing.runId)}` : "";
	const detail = timing
		? `${sep}${Math.max(0, Math.floor(((activity.completedAtMs ?? now) - timing.startedAtMs) / 1000))}s / ${Math.round(timing.timeoutMs / 1000)}s limit${runSuffix}`
		: activity.detail
			? `${sep}${plain(activity.detail)}`
			: "";
	const others = !settled && activity.otherRunning ? `${sep}+${activity.otherRunning} more running` : "";
	const size = settled ? unchangedTokenLead(activity.operation) : "";
	const text = `${size}${plain(activity.message)}${counts}${detail}${others}`;
	const message = theme.fg(failed ? tone : "annotation", text);
	if (failed) {
		rows.push(...wrapTextWithAnsi(message, Math.max(1, width)).map((line) => padAnsi(line, width)));
		return rows;
	}
	// The admission hint is the one fact a person typing needs while the harness
	// is busy, so a narrow rail gives it the row before the progress detail.
	const hint = !settled && options.admission ? plain(options.admission) : "";
	const hintRoom = hint ? visibleWidth(hint) + 3 : 0;
	// A cut detail ends on a whole word: `36.6k tokens of sess…` left a fragment where `session history` was.
	const fitted = (room: number): string => padAnsi(theme.fg("annotation", wholeWords(text, room)), room);
	if (hint && width - hintRoom >= 16) {
		rows.push(`${fitted(width - hintRoom)}${theme.fg("separator", sep)}${theme.fg("harnessAction", hint)}`);
	} else if (hint) {
		rows.push(padAnsi(theme.fg("harnessAction", hint), width, GLYPH.ellipsis));
	} else {
		rows.push(fitted(width));
	}
	return rows;
}

/**
 * A summary's written size, in the footer's units, against the output cap it
 * fills toward. Without a cap it is a count and the bar stays indeterminate;
 * before the first token nothing is measurable, and the rail says so.
 */
function tokenMeasure(activity: ContextActivitySnapshot): string {
	if (activity.unit !== "tokens") return "";
	if (activity.current === null) return "no output yet";
	const written = formatCount(activity.current);
	if (activity.total !== null && activity.total > 0) {
		// Padded to the cap's own width, so the bar keeps its length as the count grows.
		const cap = formatCount(activity.total);
		return `${written.padStart(cap.length)} of ${cap} tokens`;
	}
	return `${written} ${activity.current === 1 ? "token" : "tokens"}, no limit`;
}

/** `text` within `room` cells, cut after a whole word when one ends in the last third of the room. */
function wholeWords(text: string, room: number): string {
	if (visibleWidth(text) <= room) return text;
	const cut = truncateToWidth(text, Math.max(1, room - (visibleWidth(GLYPH.ellipsis) - 1)), "", false);
	const space = cut.lastIndexOf(" ");
	if (space < Math.ceil(room * 0.66)) return truncateToWidth(text, Math.max(1, room), GLYPH.ellipsis, false);
	return `${cut.slice(0, space).replace(/[\s·:;,]+$/u, "")}${GLYPH.ellipsis}`;
}

export function createContextProgressRail(
	getActivity: () => ContextActivitySnapshot | null,
	getAdmission?: (activity: ContextActivitySnapshot) => string | null,
): Component {
	return {
		render(width) {
			const activity = getActivity();
			// Fold away immediately once settled; compact tier or widths below 72 cols render a single crisp row.
			if (!activity || activity.completedAtMs !== null) return [];
			const admission = getAdmission?.(activity) ?? null;
			const compact = !tierPolicy().evidence || width < 72;
			return formatContextActivityRailLines(activity, width, Date.now(), animationStep(Date.now()), {
				admission,
				compact,
			});
		},
		invalidate() {},
	};
}

/**
 * Tracks every context operation the harness reports for this session and
 * folder. Runs are keyed by operation id so a late event from an older
 * operation never overwrites a newer one.
 */
export function createContextActivityStore(
	bus: TelemetryHub,
	getSessionId?: () => string | null,
): {
	current(now?: number): ContextActivitySnapshot | null;
	active(now?: number): boolean;
	unsubscribe(): void;
} {
	// Map order is start order: `set` on an existing key keeps its position.
	const runs = new Map<string, ContextActivitySnapshot>();
	const owned = (operation: ContextActivitySnapshot["operation"]): boolean =>
		!operation ||
		(operation.cwd === process.cwd() && (getSessionId === undefined || operation.sessionId === getSessionId()));
	const snapshot = (now = Date.now()): ContextActivitySnapshot | null => {
		// A settled run whose transcript card shows is said once, by the card: a
		// 9 ms `/context reset` read as a box, a check line, a bar and a finish line.
		for (const [key, run] of runs) {
			if (
				!owned(run.operation) ||
				(run.completedAtMs !== null &&
					((run.operation !== undefined && showsContextResult(run.operation)) ||
						now - run.completedAtMs > TERMINAL_RETENTION_MS))
			)
				runs.delete(key);
		}
		const running = [...runs.values()].filter((run) => run.completedAtMs === null);
		const chosen =
			running[0] ??
			[...runs.values()].reduce<ContextActivitySnapshot | null>(
				(latest, run) => (latest === null || (run.completedAtMs ?? 0) >= (latest.completedAtMs ?? 0) ? run : latest),
				null,
			);
		if (!chosen) return null;
		return { ...chosen, ...(running.length > 1 && chosen === running[0] ? { otherRunning: running.length - 1 } : {}) };
	};
	const unsubscribe = bus.subscribe("context.activity_changed", (raw: ContextActivityPayload) => {
		if (
			!raw ||
			!Object.hasOwn(CONTEXT_KIND_TITLES, raw.kind) ||
			!Object.hasOwn(PHASE_LABELS, raw.phase) ||
			!["started", "running", "completed", "failed"].includes(raw.status) ||
			typeof raw.message !== "string" ||
			!Number.isFinite(raw.at)
		)
			return;
		if (!raw.operation || !owned(raw.operation)) return;
		const key = raw.operation.id;
		const previous = runs.get(key);
		const stages = Array.isArray(raw.stages)
			? [...new Set(raw.stages.filter((phase) => Object.hasOwn(PHASE_LABELS, phase) && phase !== "done"))]
			: undefined;
		const outcome = raw.operation.outcome;
		const terminal =
			outcome !== undefined || (raw.phase === "done" && raw.status === "completed") || raw.status === "failed";
		const next: ContextActivitySnapshot = {
			operation: raw.operation,
			...(outcome ? { outcome } : {}),
			kind: raw.kind,
			phase: raw.phase,
			status: raw.status,
			message: raw.message,
			startedAtMs: previous ? previous.startedAtMs : raw.at,
			phaseStartedAtMs:
				!previous || previous.phase !== raw.phase ? raw.at : (previous.phaseStartedAtMs ?? previous.startedAtMs),
			updatedAtMs: raw.at,
			completedAtMs: terminal ? raw.at : null,
			current: typeof raw.current === "number" && Number.isFinite(raw.current) ? raw.current : null,
			total: typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : null,
			...(raw.unit === "tokens" ? { unit: "tokens" as const } : {}),
			detail: typeof raw.detail === "string" && raw.detail.length > 0 ? raw.detail : null,
			...(raw.timing &&
			Number.isFinite(raw.timing.startedAtMs) &&
			Number.isFinite(raw.timing.timeoutMs) &&
			typeof raw.timing.runId === "string"
				? { timing: { ...raw.timing } }
				: {}),
			...(stages?.length ? { stages } : previous?.stages ? { stages: previous.stages } : {}),
		};
		runs.set(key, next);
		while (runs.size > MAX_TRACKED_RUNS) {
			const oldest = runs.keys().next().value;
			if (oldest === undefined) break;
			runs.delete(oldest);
		}
	});
	// A switched session or branch owns none of these runs.
	const clears = (["session.parked", "session.reattached", "session.turn_switched"] as const).map((channel) =>
		bus.subscribe(channel, () => runs.clear()),
	);
	return {
		current: snapshot,
		active: (now = Date.now()) => snapshot(now) !== null,
		unsubscribe: () => {
			unsubscribe();
			for (const clear of clears) clear();
		},
	};
}
