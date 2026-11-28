// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { CallRowV1, WhyStoppedV1 } from "../../core/telemetry/dto.js";
import type { TurnNoAnswerCause } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { renderCount, renderUpperBound } from "../../core/telemetry/render.js";
import type { CallSettled } from "../../core/telemetry/schemas.js";
import { analyze, header, own, quantity, type View } from "./read-model.js";
import { callRow, lifecycle } from "./read-model-reports.js";
import type { ReadOptions, SessionSource } from "./read-model-sources.js";
import { type BudgetEntry, budgetEntry, type QuotaEntry, quotaEntry, quotaLimited } from "./read-model-timeline.js";

/**
 * The finding for a step pipeline that ended before its step tool reported `pipelineDone` (bt-20): every turn of it
 * can end normally, so without this the last turn's normal end reads as the pipeline's. Null for a finished pipeline.
 */
function stepPipelineIncomplete(end: NonNullable<WhyStoppedV1["stepPipeline"]>): string | null {
	if (end.done) return null;
	const named = end.template ? `prompt template ${end.template}` : "the step template";
	switch (end.stoppedBy) {
		case "cap":
			return `The step pipeline of ${named} stopped at the continuation cap with a step still running, before ${end.stepTool} reported pipelineDone; the pipeline did not finish.`;
		case "cancel":
			return `The step pipeline of ${named} was cancelled before ${end.stepTool} reported pipelineDone; the pipeline did not finish.`;
		case "failure":
			return `The step pipeline of ${named} stopped on a failed turn before ${end.stepTool} reported pipelineDone; the pipeline did not finish.`;
		case "unreported":
			return `The step pipeline of ${named} ended on a turn that made no ${end.stepTool} call; ${end.stepTool} never reported pipelineDone, so whether every step ran is not known.`;
		default:
			return `The step pipeline of ${named} ended with a turn nothing continued, before ${end.stepTool} reported pipelineDone; the pipeline did not finish.`;
	}
}

/** Causes where PanCode or its operator stopped the call; why-stopped words them as stops, never failures (bt-26 N2b). */
const HARNESS_STOP_CAUSES: ReadonlySet<string> = new Set([
	"operator_cancel",
	"parent_cancel",
	"route_moved",
	"triage_stop",
	"autonomy_stop",
	"job_clock",
	"repetition",
	"generation_guard",
	"turn_timeout",
	"output_cap",
	"loop_guard",
	"oversized_tool_result",
	"shutdown",
]);

/** What a turn that stopped normally yet answered nothing did instead, by its journaled cause (bt-session-res J1). */
const NO_ANSWER_FINDINGS: Record<TurnNoAnswerCause, string> = {
	tool_call_as_text: "the model wrote its tool call as plain text (tool-call markup), so nothing ran",
	tool_call_announced:
		"the model said what it would do next and wrote the call as plain text (tool-call markup), so nothing ran",
	tool_call_in_reasoning: "the model wrote its tool call into its reasoning (tool-call markup), so nothing ran",
	reasoning_only: "the model reasoned but wrote no reply and made no tool call",
	empty: "the model returned no reply and no tool call",
};

export function whyStopped(source: SessionSource, options: ReadOptions = {}): WhyStoppedV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	let last: { at: string; record: Extract<TelemetryRecord, { k: "turn.settled" }> } | null = null;
	// The session DTO's lifecycle, so a close the ledger recorded reads closed here too (#434 §6.1).
	const life = lifecycle(source, options);
	const budget: BudgetEntry[] = [];
	const latestQuota = new Map<string, QuotaEntry>();
	let autonomy: NonNullable<WhyStoppedV1["autonomy"]> | undefined;
	const decisionKinds = new Map<NonNullable<WhyStoppedV1["autonomy"]>["kinds"][number]["kind"], number>();
	let pipeline: { at: string; data: NonNullable<WhyStoppedV1["stepPipeline"]> } | null = null;
	for (const record of source.journal.records) {
		if (record.k === "turn.settled" && (!last || record.t >= last.at)) last = { at: record.t, record };
		if (record.k === "step_pipeline.settled" && (!pipeline || record.t >= pipeline.at))
			pipeline = { at: record.t, data: record.data };
		if (record.k === "budget.crossed" || record.k === "budget.held") budget.push(budgetEntry(analysis, record));
		if (record.k.startsWith("autonomy.")) autonomy ??= { halt: null, ended: null, openDecisions: 0, kinds: [] };
		if (autonomy === undefined) continue;
		if (record.k === "autonomy.cap_reached")
			autonomy.halt = {
				at: record.t,
				kind: record.data.kind,
				...(record.data.limit !== undefined ? { limit: record.data.limit } : {}),
			};
		else if (record.k === "autonomy.resumed" || record.k === "autonomy.entered") autonomy.halt = null;
		else if (record.k === "autonomy.ended") autonomy.ended = { at: record.t, reason: record.data.reason };
		else if (record.k === "autonomy.open_decision") {
			autonomy.openDecisions += 1;
			decisionKinds.set(record.data.kind, (decisionKinds.get(record.data.kind) ?? 0) + 1);
		}
	}
	if (autonomy !== undefined) autonomy.kinds = [...decisionKinds].map(([kind, n]) => ({ kind, count: n }));
	for (const record of source.accountQuota ?? []) {
		if (record.k === "quota.read") {
			const account = `${record.data.provider}\u0000${record.data.targetId}`;
			const entry = quotaEntry(record);
			const prior = latestQuota.get(account);
			if (!prior || entry.observedAt >= prior.observedAt) latestQuota.set(account, entry);
		}
	}
	budget.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	const quota = [...latestQuota.values()].sort(
		(a, b) =>
			Number(quotaLimited(b)) - Number(quotaLimited(a)) ||
			a.provider.localeCompare(b.provider) ||
			a.targetId.localeCompare(b.targetId),
	);
	const terminal = last?.record.data;
	// The pipeline record follows its last turn's turn.settled; one older than the last turn belongs to an earlier turn.
	const stepPipeline = pipeline !== null && last !== null && pipeline.at >= last.at ? pipeline.data : null;
	const lastCallIds = new Set(terminal?.terminal.callIds ?? []);
	const lastCalls = analysis.attempts
		.filter((attempt) => lastCallIds.has(attempt.started.callId))
		.map((attempt) => callRow(view, "own", id, attempt));
	const causes = new Map<string, string>();
	const waits = new Set<NonNullable<NonNullable<CallSettled["stages"]["admission"]>["waitedOn"]>>();
	for (const attempt of analysis.attempts) {
		const settled = attempt.settled;
		const failure = settled?.stop.failure;
		const at = attempt.settledAt ?? attempt.startedAt;
		if (failure && (causes.get(failure) ?? "") < at) causes.set(failure, at);
		const waitedOn = settled?.stages.admission?.waitedOn;
		if (waitedOn) waits.add(waitedOn);
	}
	const state: WhyStoppedV1["state"] =
		life.state === "closed"
			? "closed"
			: !terminal
				? "no-turns"
				: terminal.stopReason === "error" || terminal.terminal.noAnswer !== undefined
					? "turn-failed"
					: terminal.stopReason === "aborted"
						? "turn-cancelled"
						: "turn-completed";
	const causeRows = [...causes.entries()]
		.sort(([, a], [, b]) => (a < b ? 1 : -1))
		.map(([cause, lastAt]) => ({
			cause: cause as NonNullable<CallSettled["stop"]["failure"]>,
			calls: quantity(view, own(id, "attempts", { group: { by: "cause", key: cause } })),
			lastAt,
		}));
	const waitRows = [...waits].sort().map((on) => ({
		on,
		calls: quantity(view, own(id, "attempts", { group: { by: "wait", key: on } })),
		waited: quantity(view, own(id, "admissionWait", { group: { by: "wait", key: on } })),
	}));
	const spend = {
		tokens: quantity(view, { scope: "session", owner: id, metric: "total" }),
		usd: quantity(view, { scope: "session", owner: id, metric: "usd" }),
	};
	const cache = {
		rePrefilled: quantity(view, own(id, "rePrefilled")),
		breakUsd: quantity(view, own(id, "breakUsd")),
	};
	const main = { group: { by: "role" as const, key: "main" } };
	const roundTrips = {
		rounds: quantity(view, own(id, "bookkeepingRounds", main)),
		tax: quantity(view, own(id, "roundTripTax", main)),
	};
	const findings: string[] = [];
	const workerStops: NonNullable<WhyStoppedV1["workerStops"]> = [];
	if (state === "no-turns") findings.push("No turn has settled in this session's journal.");
	else if (terminal) {
		const reached = terminal.terminal.stage;
		// A call that produced output was cut off mid-stream, not at a gate.
		// A stop with no stage after a reply that asked for tools landed at that round's tool boundary (bt-26 N2f). The
		// turn itself settles aborted under a harness stop, so the final call's own stop reason decides (bt-26 N2g).
		const finalCallId = terminal.terminal.callIds.at(-1);
		const finalCall = analysis.attempts
			.filter((attempt) => attempt.started.callId === finalCallId && attempt.settled)
			.at(-1)?.settled;
		const stage =
			reached === "streaming"
				? " while streaming"
				: reached
					? ` at ${reached}`
					: terminal.stopReason === "toolUse" || (terminal.terminal.cause && finalCall?.stop.reason === "toolUse")
						? " at the tool boundary"
						: "";
		const retries =
			terminal.terminal.retries > 0
				? ` after ${renderCount(terminal.terminal.retries)} ${terminal.terminal.retries === 1 ? "retry" : "retries"}`
				: "";
		// A model that ended its answer reached every stage; naming the last one reads as where a failure struck (bt-20).
		const normalEnd = !terminal.terminal.cause && (terminal.stopReason === "stop" || terminal.stopReason === "toolUse");
		const noAnswer = terminal.terminal.noAnswer;
		findings.push(
			terminal.terminal.cause
				? `The last turn stopped (${terminal.stopReason}) on ${terminal.terminal.cause}${stage}${retries}.`
				: noAnswer !== undefined
					? `The last turn failed without an answer (${terminal.stopReason}, ${noAnswer}): ${NO_ANSWER_FINDINGS[noAnswer]}${retries}.`
					: normalEnd
						? `The last turn ended normally (${terminal.stopReason})${retries}.`
						: `The last turn stopped (${terminal.stopReason})${stage}${retries}.`,
		);
		// A worker that turn dispatched settles in its own run journal, so its stop is named here too (cf1h-D3).
		const lastTurnId = last?.record.ctx.turnId;
		for (const run of analysis.runs.values()) {
			const stop =
				lastTurnId !== undefined && run.turnId === lastTurnId
					? run.attempts.filter((attempt) => attempt.settled).at(-1)?.settled?.stop
					: null;
			if (!stop?.failure) continue;
			workerStops.push({ runId: run.runId, cause: stop.failure });
			findings.push(
				`Worker run ${run.runId} ${HARNESS_STOP_CAUSES.has(stop.failure) ? "stopped" : "failed"}: ${stop.failure}.`,
			);
		}
	}
	const incomplete = stepPipeline !== null ? stepPipelineIncomplete(stepPipeline) : null;
	if (incomplete) findings.push(incomplete);
	if (autonomy?.halt)
		findings.push(
			autonomy.halt.kind === "judge"
				? `YOLO ended the run at ${autonomy.halt.at}: the safety judge blocked too many calls (judge-streak).`
				: autonomy.halt.kind === "exploration"
					? `YOLO ended the run at ${autonomy.halt.at}: the read-streak decision gate refused two rounds of reads after every note (exploration_stalled).`
					: `YOLO paused at ${autonomy.halt.at} on its ${autonomy.halt.limit !== undefined ? `${renderCount(autonomy.halt.limit)}-` : ""}${autonomy.halt.kind === "calls" ? "call" : autonomy.halt.kind === "minutes" ? "minute" : "token"} cap (autonomous-cap).`,
		);
	if (autonomy && autonomy.openDecisions > 0)
		findings.push(
			`YOLO left ${renderCount(autonomy.openDecisions)} open ${autonomy.openDecisions === 1 ? "decision" : "decisions"} for the operator: ${autonomy.kinds.map((row) => `${renderCount(row.count)} ${row.kind}`).join(", ")}.`,
		);
	if (life.closed)
		findings.push(`The session closed at ${life.closed.at}${life.closed.reason ? ` (${life.closed.reason})` : ""}.`);
	else if (life.state === "ended-abnormally") findings.push("The session's process ended without closing it.");
	const crossing = budget.filter((entry) => entry.event === "crossing").at(-1);
	if (crossing)
		findings.push(
			`Priced spend ${crossing.level === "over" ? "passed" : "reached"} the ${crossing.ceiling.display} ceiling at ${crossing.at}: ${crossing.spend.display}.`,
		);
	const held = budget.filter((entry) => entry.event === "wait");
	const release = held.at(-1);
	if (release)
		findings.push(
			`${renderCount(held.length)} paid ${held.length === 1 ? "request was" : "requests were"} held at a ceiling; the last ${
				release.outcome === "raised" || release.outcome === "removed" || release.outcome === "cleared"
					? `was released (${release.outcome}${release.raisedTo ? ` to ${release.raisedTo.display}` : ""}${release.raisedBy ? ` by ${release.raisedBy}` : ""})`
					: `ended ${release.outcome ?? "unreleased"}`
			} after ${release.waited?.display ?? "an unrecorded wait"}.`,
		);
	for (const entry of quota.filter(quotaLimited))
		findings.push(
			`${entry.provider} reported the account limited at ${entry.observedAt}: ${entry.windows.map((window) => `${window.key} ${window.usedPct.display}`).join(", ")}.`,
		);
	for (const row of waitRows)
		findings.push(`Admission held on ${row.on}: ${row.calls.display} attempt(s), ${row.waited.display} waited.`);
	for (const row of causeRows)
		findings.push(
			`${HARNESS_STOP_CAUSES.has(row.cause) ? "Stopped" : "Failed"} on ${row.cause}: ${row.calls.display} attempt(s), the last at ${row.lastAt}.`,
		);
	findings.push(`Spend: ${spend.usd.display} over ${spend.tokens.display} tokens.`);
	findings.push(
		`Re-prefilled tokens: ${renderUpperBound(cache.rePrefilled.fact, cache.rePrefilled.display)}; cache-break bill: ${renderUpperBound(cache.breakUsd.fact, cache.breakUsd.display)}.`,
	);
	const rounds = roundTrips.rounds.fact;
	if ("kind" in rounds ? rounds.kind !== "measured" || rounds.value > 0 : rounds.measured > 0 || rounds.unknownCount > 0)
		findings.push(
			`Bookkeeping-only rounds: ${roundTrips.rounds.display}, re-reading ${roundTrips.tax.display} prompt tokens.`,
		);
	return {
		...header(options),
		kind: "why-stopped",
		sessionId: id,
		state,
		lastTurn: last
			? {
					at: last.at,
					turnId: last.record.ctx.turnId ?? null,
					stopReason: last.record.data.stopReason,
					cause: last.record.data.terminal.cause,
					stage: last.record.data.terminal.stage,
					retries: last.record.data.terminal.retries,
					callIds: last.record.data.terminal.callIds as CallRowV1["callId"][],
					...(last.record.data.terminal.noAnswer !== undefined ? { noAnswer: last.record.data.terminal.noAnswer } : {}),
				}
			: null,
		lastCalls,
		...(workerStops.length > 0 ? { workerStops } : {}),
		...(autonomy !== undefined ? { autonomy } : {}),
		...(stepPipeline !== null ? { stepPipeline } : {}),
		causes: causeRows,
		waits: waitRows,
		cache,
		roundTrips,
		spend,
		budget,
		quota,
		findings,
	};
}
