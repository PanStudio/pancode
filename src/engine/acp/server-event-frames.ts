// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Payloads of the forwarded `_pancode/event` frames: dispatch run identity,
 * run result facts, job payloads and the byte bounds each field is held to, and
 * the terminal frames a reopened session replays for its historical runs.
 */
import type { JobRecord } from "../../core/job-types.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { renderFact } from "../../core/telemetry/render.js";
import type { RunResultFacts } from "../../domains/dispatch/index.js";
import { readRunResultFacts, readRunResultFactsForReplay, runResultWireFacts } from "../../domains/dispatch/index.js";
import { safeStoredIdentifier, safeStoredString } from "./server-bounds.js";
import type { AcpForwardableEventKind } from "./server-options.js";
import { ACP_REPLAY_META_KEY, ACP_RUN_RESULT_META_KEY } from "./types.js";
import type { AcpJob } from "./types-fleet.js";

/**
 * Sanitized, bounded preview of a dispatched task. The exact task is the
 * operator's own prose and can be arbitrarily long, so what crosses is a
 * control-character-stripped prefix carrying the standard truncation marker;
 * the exact text never leaves the process.
 */
const ACP_MAX_DISPATCH_TASK_PREVIEW_BYTES = 160;

/** Wire bound for the short identifiers a dispatch event carries. */
export const ACP_MAX_DISPATCH_ID_BYTES = 128;
/** Evidence tags are a closed vocabulary of short identifiers; anything wider is not a tag. */
export const ACP_MAX_EVIDENCE_TAGS = 32;
export const ACP_MAX_EVIDENCE_TAG_BYTES = 64;

/**
 * The one forwarded payload field that is a sentence rather than an
 * identifier: the context-window warning is PanCode's own operator copy, so it is
 * bounded to a banner's worth and stripped rather than refused.
 */
export const ACP_MAX_EVENT_TEXT_BYTES = 256;
/** A scope notice is two sentences of host prose, longer than a banner line. */
export const ACP_MAX_SCOPE_NOTICE_BYTES = 1024;

/**
 * Progress events forwarded per run before the stream is capped. One run
 * publishes one progress fact per worker event, which is unbounded; a client
 * only needs enough to know the run is alive, so the cap is announced with a
 * final `truncated` frame rather than by silently going quiet.
 */
export const ACP_MAX_DISPATCH_PROGRESS_EVENTS = 256;

/** Live dispatch runs whose progress counters this server tracks at once. */
const ACP_MAX_TRACKED_DISPATCH_RUNS = 512;

/** Bounds on one `job.changed` frame's prose. The exact prompt and argv never cross; a preview does. */
const ACP_MAX_JOB_PREVIEW_BYTES = 160;
const ACP_MAX_JOB_EVIDENCE_BYTES = 256;

/**
 * The wire projection of one canonical job record, for `_pancode/jobs/list` and
 * the opt-in `job.changed` stream. Every figure is the record's own: counts, the
 * next due time and the deadline are not derived here, `costUsd` stays null when
 * the record says it is unknown, and a job with no recorded run reports no last
 * outcome. `costDisplay` is the job's spend as the telemetry read model words it,
 * the line `/loop status` prints, and is absent when nothing measured one. A
 * client must be able to draw the same truth the terminal prints.
 */
export function jobEventPayload(job: JobRecord, complete: boolean, turn: boolean, spend: string | null): AcpJob | null {
	const jobId = safeStoredIdentifier(job.id, ACP_MAX_DISPATCH_ID_BYTES);
	if (jobId === null) return null;
	const runner = job.spec.runner;
	const last = job.history[job.history.length - 1]?.evidence ?? null;
	const count = (value: number | null): number | null =>
		value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
	return {
		jobId,
		revision: count(job.revision),
		state: job.state,
		reason: job.reason,
		runner: runner.kind,
		taskPreview: safeStoredString(
			runner.kind === "main" ? runner.prompt : runner.argv.join(" "),
			ACP_MAX_JOB_PREVIEW_BYTES,
		).trim(),
		intervalMs: count(job.spec.intervalMs),
		count: count(job.spec.count),
		starts: count(job.starts),
		settled: count(job.settled),
		timeoutMs: count(job.spec.timeoutMs),
		nextDueAt: count(job.nextDueAt),
		deadlineAt: count(job.spec.deadlineAt),
		cancelRequested: job.cancelRequested,
		running: job.active !== null,
		turn,
		pendingReason: job.pendingReason === null ? null : safeStoredString(job.pendingReason, ACP_MAX_JOB_EVIDENCE_BYTES),
		consecutiveFailures: count(job.consecutiveFailures),
		last:
			last === null
				? null
				: {
						outcome: last.outcome,
						summary: safeStoredString(last.summary, ACP_MAX_JOB_EVIDENCE_BYTES),
						truncated: last.truncated,
					},
		delivery: job.delivery === null ? null : { kind: job.delivery.kind, state: job.delivery.state },
		...(spend === null ? {} : { costDisplay: spend }),
		costUsd: job.costUsd !== null && Number.isFinite(job.costUsd) && job.costUsd >= 0 ? job.costUsd : null,
		saved: job.persistenceError === null,
		complete,
	};
}

/**
 * The identity every dispatch frame carries. The exact task never crosses:
 * what goes on the wire is a control-character-stripped, byte-bounded prefix
 * carrying the standard truncation marker, so a client can label a run
 * without receiving the operator's prose. A run whose id or agent cannot be
 * represented safely is dropped rather than forwarded under a repaired
 * identity, because a board keyed on a rewritten id merges distinct runs.
 */
export const dispatchIdentity = (payload: {
	runId: string;
	agentId: string;
	task?: string | undefined;
	node?: string | undefined;
}): { runId: string; agentId: string; taskPreview: string | null; node: string | null } | null => {
	const runId = safeStoredIdentifier(payload.runId, ACP_MAX_DISPATCH_ID_BYTES);
	const agentId = safeStoredIdentifier(payload.agentId, ACP_MAX_DISPATCH_ID_BYTES);
	if (runId === null || agentId === null) return null;
	const preview =
		payload.task === undefined ? "" : safeStoredString(payload.task, ACP_MAX_DISPATCH_TASK_PREVIEW_BYTES).trim();
	return {
		runId,
		agentId,
		taskPreview: preview.length === 0 ? null : preview,
		node: safeStoredIdentifier(payload.node, ACP_MAX_DISPATCH_ID_BYTES),
	};
};

/** Forgets a run's progress counter and keeps the live map inside its cap. */
export const trackDispatchRun = (
	dispatchProgress: Map<string, { count: number; capped: boolean }>,
	runId: string,
): { count: number; capped: boolean } => {
	const existing = dispatchProgress.get(runId);
	if (existing !== undefined) return existing;
	if (dispatchProgress.size >= ACP_MAX_TRACKED_DISPATCH_RUNS) {
		const oldest = dispatchProgress.keys().next();
		if (!oldest.done) dispatchProgress.delete(oldest.value);
	}
	const created = { count: 0, capped: false };
	dispatchProgress.set(runId, created);
	return created;
};

export const safeCount = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * The sealed run record's facts for a terminal dispatch frame, projected by the
 * same readers the TUI footer uses. The domain seals the run before it
 * publishes the terminal event, so a live read finds it; a missing or
 * unreadable one reports `unavailable: true` rather than failing the frame.
 */
export const readResult = (runId: string, replay: boolean): RunResultFacts | null => {
	try {
		return replay ? readRunResultFactsForReplay(runId) : readRunResultFacts(runId);
	} catch {
		// The readers already swallow I/O and parse errors; anything else still
		// must not take down the frame, and null reads as unavailable.
		return null;
	}
};

/**
 * A terminal fleet frame's token and call facts as the run settled them, null where the run recorded none, beside the
 * canonical wording of the total, so a board never shows an unknown run as a counted one (#434).
 */
export const runTokenCoverage = (spend: {
	totalTokens?: Fact<number>;
	apiCalls?: Fact<number>;
}): { totalTokens: Fact<number> | null; apiCalls: Fact<number> | null; tokenDisplay: string | null } => ({
	totalTokens: spend.totalTokens ?? null,
	apiCalls: spend.apiCalls ?? null,
	tokenDisplay: spend.totalTokens ? renderFact(spend.totalTokens) : null,
});

export const runResultMeta = (runId: string, facts: RunResultFacts | null): Record<string, unknown> => ({
	[ACP_RUN_RESULT_META_KEY]: runResultWireFacts(runId, facts),
});

/**
 * A reopened session's historical runs, replayed as the terminal dispatch
 * frames a live client would have received, with the same run-result facts the
 * TUI's replayed footers read (#ACP-02). A run the ledger still shows open
 * in another process has no terminal frame yet, so it is skipped.
 */
export const replayDispatchTerminals = (
	forwardEvent: (
		kind: AcpForwardableEventKind,
		turnId: string | null,
		terminal: boolean,
		payload: Record<string, unknown>,
		meta?: Record<string, unknown>,
	) => void,
	runs: ReadonlyArray<{ runId: string; agentId: string }>,
): void => {
	const seen = new Set<string>();
	for (const run of runs) {
		if (seen.has(run.runId)) continue;
		seen.add(run.runId);
		const identity = dispatchIdentity(run);
		if (identity === null) continue;
		const facts = readResult(identity.runId, true);
		if (facts?.stillRunning === true) continue;
		const outcome = facts === null ? null : safeStoredIdentifier(facts.outcome, 64);
		const common = {
			runId: identity.runId,
			agentId: identity.agentId,
			outcome,
			outcomeCode: safeStoredIdentifier(facts?.outcomeCode, 64),
			outcomeDetail: safeStoredString(facts?.failureMessage ?? facts?.abandonedDetail, 2048) || null,
			durationMs: safeCount(facts?.durationMs),
		};
		const replayMeta = { ...runResultMeta(identity.runId, facts), [ACP_REPLAY_META_KEY]: { run: true } };
		// The run result's call coverage words its token count exactly as the live frame did (#434).
		const tokens = runTokenCoverage({
			...(facts?.tokens ? { totalTokens: facts.tokens } : {}),
			...(facts?.apiCalls !== undefined
				? { apiCalls: { kind: "measured" as const, value: facts.apiCalls, source: "local-count" as const } }
				: {}),
		});
		if (outcome === "succeeded") {
			forwardEvent("run.completed", null, true, { ...common, ...tokens }, replayMeta);
		} else {
			forwardEvent("run.failed", null, true, { ...common, reason: outcome, ...(facts?.tokens ? tokens : {}) }, replayMeta);
		}
	}
};
