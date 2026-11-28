// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * One run's lifecycle, folded the same way by every surface that shows it: the terminal's worker cards, the share
 * ledger, the telemetry projection, the ACP wire and both GUI folds. Each reader keeps its own detail fields and takes
 * whether a run is queued, live, stopping or over from here, so no surface revives a finished run on a late frame
 * while another shows it done.
 *
 * Events arrive in two vocabularies, the engine's `run.*` and the GUI's `fleet.*` names for the same frames. A run
 * ends on its live terminal event (`run.completed`, `run.failed`) and settles on its `run.settled` record, which the
 * hub publishes once that record is on disk. The record is the run's outcome: it overrides what a live event said,
 * and nothing after it moves the run. Browser-safe: no imports.
 */

export type RunLifecycleKind = "enqueued" | "started" | "progressed" | "aborted" | "ended" | "settled";
export type RunLifecyclePhase = "queued" | "running" | "cancelling" | "ended" | "settled";
/** How a surface draws the run. A stop is not a failure: a canceled run reads `stopped`. */
export type RunLifecycleView = "queued" | "running" | "cancelling" | "done" | "failed" | "stopped";

export interface RunLifecycleEvent {
	readonly kind: RunLifecycleKind;
	readonly runId: string;
	/** The run's outcome on `ended` and `settled`; null on every other kind. */
	readonly outcome: string | null;
}

export interface RunLifecycle {
	readonly runId: string;
	readonly phase: RunLifecyclePhase;
	/** Null until the run ends. */
	readonly outcome: string | null;
	readonly view: RunLifecycleView;
}

const TOPIC_KINDS: ReadonlyMap<string, RunLifecycleKind> = new Map<string, RunLifecycleKind>([
	["run.enqueued", "enqueued"],
	["fleet.enqueued", "enqueued"],
	["run.started", "started"],
	["fleet.started", "started"],
	["run.progressed", "progressed"],
	["fleet.progress", "progressed"],
	["run.aborted", "aborted"],
	["run.completed", "ended"],
	["fleet.completed", "ended"],
	["run.failed", "ended"],
	["fleet.failed", "ended"],
	["run.settled", "settled"],
]);

function nonEmpty(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The lifecycle event a bus or feed frame is, or null for a frame that is not one or names no run. `run.settled`
 * carries no run id of its own; its listener passes the id its context names.
 */
export function runLifecycleEvent(topic: string, payload: unknown): RunLifecycleEvent | null {
	const kind = TOPIC_KINDS.get(topic);
	if (kind === undefined || payload === null || typeof payload !== "object") return null;
	const record = payload as Readonly<Record<string, unknown>>;
	const runId = nonEmpty(record.runId);
	if (runId === null) return null;
	if (kind !== "ended" && kind !== "settled") return { kind, runId, outcome: null };
	const outcome =
		nonEmpty(record.outcome) ?? (topic.endsWith(".completed") ? "succeeded" : (nonEmpty(record.reason) ?? "failed"));
	return { kind, runId, outcome };
}

/** How an ended run with this outcome draws: done, stopped or failed. */
export function runOutcomeView(outcome: string): RunLifecycleView {
	if (outcome === "succeeded") return "done";
	return outcome === "canceled" || outcome === "cancelled" ? "stopped" : "failed";
}

/** Whether the run has not ended: queued, running or being cancelled. */
export function runLifecycleLive(state: RunLifecycle | undefined): boolean {
	return state === undefined || (state.phase !== "ended" && state.phase !== "settled");
}

/**
 * Fold one event into a run's lifecycle. Returns `prev` itself when the event changes nothing, so a reader can tell a
 * late frame from a transition by identity. A finished run is never revived: enqueue, start, progress and abort frames
 * after its end are ignored. An abort marks a live run cancelling; the run ends only on its terminal event. A later
 * live terminal event restates an ended run's outcome until it settles, and the settled record is final.
 */
export function reduceRunLifecycle(prev: RunLifecycle | undefined, event: RunLifecycleEvent): RunLifecycle {
	const next = (phase: RunLifecyclePhase, outcome: string | null, view: RunLifecycleView): RunLifecycle =>
		prev !== undefined && prev.phase === phase && prev.outcome === outcome && prev.view === view
			? prev
			: { runId: event.runId, phase, outcome, view };
	if (prev?.phase === "settled") return prev;
	const outcome = event.outcome ?? "failed";
	switch (event.kind) {
		case "settled":
			return next("settled", outcome, runOutcomeView(outcome));
		case "ended":
			return next("ended", outcome, runOutcomeView(outcome));
		default:
			break;
	}
	if (prev?.phase === "ended") return prev;
	switch (event.kind) {
		case "enqueued":
			return prev ?? next("queued", null, "queued");
		case "started":
		case "progressed":
			return prev?.phase === "cancelling" ? prev : next("running", null, "running");
		case "aborted":
			return next("cancelling", null, "cancelling");
	}
}
