// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type {
	CallRowV1,
	FactMetric,
	RunTimelineEntry,
	RunTimelineV1,
	TimelineEntry,
	TimelineV1,
} from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import { renderCount, renderCountSum, renderFact, renderUsdLimit, renderUsdSum } from "../../core/telemetry/render.js";
import { countsAsToolCall } from "../../core/telemetry/tool-schemas.js";
import {
	type Analysis,
	type Attempt,
	analyze,
	analyzeRun,
	estimatedSum,
	header,
	invoked,
	localClock,
	localCount,
	quantity,
	type View,
} from "./read-model.js";
import type { JournalSource, ReadOptions, SessionSource } from "./read-model-sources.js";

export type BudgetEntry = Extract<TimelineEntry, { kind: "budget" }>;
export type QuotaEntry = Extract<TimelineEntry, { kind: "quota" }>;

/**
 * The spend admission saw at `t`, marked as the session's priced calls settled by then were: estimated when any was,
 * with every sent call it could not price beside it, as admission's own read of the session fold words it (#434 §8).
 */
function spendAt(analysis: Analysis, usd: number, t: string): FactSum {
	let estimated = false;
	let unpriced = 0;
	const visit = (attempt: Attempt) => {
		if (!invoked(attempt) || !attempt.settled || attempt.settledAt === null || attempt.settledAt > t) return;
		const fact = attempt.settled.pricing.usd;
		if (fact.kind === "estimated") estimated = true;
		else if (fact.kind === "unknown") unpriced += 1;
	};
	for (const attempt of analysis.attempts) visit(attempt);
	for (const run of analysis.runs.values()) for (const attempt of run.attempts) visit(attempt);
	return {
		measured: estimated ? 0 : usd,
		estimated: estimated ? usd : 0,
		unknownCount: unpriced,
		absentCount: 0,
		coverage: { measured: estimated ? 0 : 1, estimated: estimated ? 1 : 0, unknown: unpriced },
	};
}

export function budgetEntry(
	analysis: Analysis,
	record: Extract<TelemetryRecord, { k: "budget.crossed" | "budget.held" }>,
): BudgetEntry {
	const data = record.data;
	const wait = record.k === "budget.held" ? record.data : null;
	const waited = wait ? localClock(wait.waitedMs) : null;
	const spend = spendAt(analysis, data.spendUsd, record.t);
	// Admission's own estimate of what the held request re-sends; it names no method, so it reads `~`.
	const context = data.contextTokens === undefined ? null : estimatedSum(data.contextTokens);
	// Counted ahead of its settlement, so it is a projection and reads `~` (#434).
	const projected = data.projectedUsd === undefined ? null : estimatedSum(data.projectedUsd);
	return {
		kind: "budget",
		at: record.t,
		event: wait ? "wait" : "crossing",
		level: data.level,
		callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
		attemptId: (record.ctx.attemptId ?? null) as CallRowV1["attemptId"] | null,
		spend: { fact: spend, display: renderUsdSum(spend, false) },
		projected: projected ? { fact: projected, display: renderUsdSum(projected, false) } : null,
		ceiling: { usd: data.ceilingUsd, display: renderUsdLimit(data.ceilingUsd) },
		contextTokens: context ? { fact: context, display: renderCountSum(context) } : null,
		outcome: wait?.outcome ?? null,
		waited: waited ? { fact: waited, display: renderFact(waited, "duration") } : null,
		raisedTo:
			wait?.raisedToUsd === undefined ? null : { usd: wait.raisedToUsd, display: renderUsdLimit(wait.raisedToUsd) },
		raisedBy: wait?.raisedBy ?? null,
	};
}

export function quotaEntry(record: Extract<TelemetryRecord, { k: "quota.read" }>): QuotaEntry {
	return {
		kind: "quota",
		at: record.t,
		provider: record.data.provider,
		targetId: record.data.targetId,
		source: record.data.source,
		observedAt: record.data.observedAt,
		limitReached: record.data.limitReached ?? null,
		windows: record.data.windows.map((window) => ({
			key: window.key,
			usedPct: { fact: window.usedPct, display: renderFact(window.usedPct, "percent") },
			resetsAt: window.resetsAt ?? null,
		})),
	};
}

function gapEntry(record: Extract<TelemetryRecord, { k: "journal.gap" }>): Extract<TimelineEntry, { kind: "gap" }> {
	const { sink, reason, count } = record.data;
	return { kind: "gap", at: record.t, sink, reason, count, countShown: shownCount(count) };
}

/** A count a record states, worded by the renderer. */
export function shownCount(value: number): { fact: Fact<number>; display: string } {
	const fact = localCount(value);
	return { fact, display: renderFact(fact) };
}

/** A reading that says the account cannot send, or a window measured full. */
export const quotaLimited = (entry: QuotaEntry) =>
	entry.limitReached === true ||
	entry.windows.some((window) => window.usedPct.fact.kind === "measured" && window.usedPct.fact.value >= 100);

export function timeline(
	source: SessionSource,
	range: { from: string; to: string } | null = null,
	options: ReadOptions = {},
): TimelineV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	const entries: TimelineEntry[] = analysis.attempts.map((attempt) => callEntry(view, "own", id, attempt));
	const attemptsById = new Map(analysis.attempts.map((attempt) => [attempt.started.attemptId as string, attempt]));
	for (const record of source.accountQuota ?? []) if (record.k === "quota.read") entries.push(quotaEntry(record));
	for (const record of source.journal.records) {
		const at = record.t;
		switch (record.k) {
			case "message.stepped": {
				const data = record.data;
				const since = localClock(Math.max(0, Date.parse(at) - data.submittedAt));
				const carrier = data.attemptId === undefined ? undefined : attemptsById.get(data.attemptId);
				entries.push({
					kind: "message",
					at,
					messageId: data.messageId,
					step: data.step,
					by: data.by ?? null,
					chars: data.chars === undefined ? null : shownCount(data.chars),
					lane: data.lane ?? null,
					changedBy: data.changedBy ?? null,
					why: data.why ?? null,
					slot: data.slot ?? null,
					reason: data.reason ?? null,
					callId: (data.callId ?? null) as CallRowV1["callId"] | null,
					attemptId: (data.attemptId ?? null) as CallRowV1["attemptId"] | null,
					attempt: data.attempt ?? null,
					callDisposition: data.attemptId === undefined ? null : (carrier?.settled?.disposition ?? "incomplete"),
					callFailure: carrier?.settled?.stop.failure ?? null,
					turnId: record.ctx.turnId ?? null,
					sinceSubmit: { fact: since, display: renderFact(since, "duration") },
				});
				break;
			}
			case "turn.settled":
				entries.push({
					kind: "turn",
					at,
					turnId: record.ctx.turnId ?? null,
					stopReason: record.data.stopReason,
					cause: record.data.terminal.cause,
					stage: record.data.terminal.stage,
					retries: record.data.terminal.retries,
					retriesShown: shownCount(record.data.terminal.retries),
					callIds: record.data.terminal.callIds as CallRowV1["callId"][],
				});
				break;
			case "run.linked":
				entries.push({ kind: "run", at, runId: record.data.runId, event: "referenced", terminalReason: null });
				break;
			case "compaction.settled":
				entries.push({
					kind: "compaction",
					at,
					callIds: record.data.callIds as CallRowV1["callId"][],
					outcome: record.data.outcome,
				});
				break;
			case "session.opened":
			case "session.resumed":
				entries.push({ kind: "session", at, event: record.k === "session.opened" ? "opened" : "resumed", detail: null });
				break;
			case "session.forked":
				entries.push({
					kind: "session",
					at,
					event: "forked_from",
					detail: `${record.data.parentSessionId} at ${record.data.parentTurnId}`,
				});
				break;
			case "session.closed":
				entries.push({ kind: "session", at, event: "closed", detail: record.data.reason });
				break;
			case "journal.gap":
				entries.push(gapEntry(record));
				break;
			case "config.snapshotted":
				entries.push({
					kind: "config",
					at,
					event: "snapshot",
					source: null,
					paths: null,
					settings: record.data.settings,
					previous: null,
				});
				break;
			case "config.changed":
				entries.push({
					kind: "config",
					at,
					event: "changed",
					source: record.data.source,
					paths: record.data.paths,
					settings: record.data.after,
					previous: record.data.before,
				});
				break;
			case "budget.crossed":
			case "budget.held":
				entries.push(budgetEntry(analysis, record));
				break;
			case "tool.settled": {
				const data = record.data;
				if (!countsAsToolCall(data)) break;
				const duration = localClock(data.durationMs);
				const parked = data.parkedMs === undefined ? null : localClock(data.parkedMs);
				const bytes = data.resultBytes === undefined ? null : localCount(data.resultBytes);
				entries.push({
					kind: "tool",
					at,
					tool: data.tool,
					outcome: data.outcome,
					blocked: data.blocked ?? null,
					toolCallId: record.ctx.toolCallId ?? null,
					callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
					turnId: record.ctx.turnId ?? null,
					runId: record.ctx.runId ?? null,
					duration: { fact: duration, display: renderFact(duration, "duration") },
					parked: parked ? { fact: parked, display: renderFact(parked, "duration") } : null,
					resultBytes: bytes ? { fact: bytes, display: renderFact(bytes) } : null,
				});
				break;
			}
			case "middleware.fired":
				entries.push({
					kind: "middleware",
					at,
					hook: record.data.hook,
					phase: record.data.phase,
					ruleId: record.data.ruleId,
					effects: record.data.effects,
					severity: record.data.severity ?? null,
					evidence: record.data.evidence ?? null,
					tool: record.data.tool ?? null,
					turnId: record.ctx.turnId ?? null,
				});
				break;
			case "auth.refreshed": {
				const duration = localClock(record.data.durationMs);
				entries.push({
					kind: "auth",
					at,
					provider: record.data.provider,
					trigger: record.data.trigger,
					attempted: record.data.attempted,
					outcome: record.data.outcome,
					wroteCredential: record.data.writerPid !== null,
					duration: { fact: duration, display: renderFact(duration, "duration") },
				});
				break;
			}
			case "prompt.compiled": {
				const tokens: Fact<number> = { kind: "estimated", value: record.data.tokenEstimate, method: "chars/4" };
				entries.push({
					kind: "prompt",
					at,
					structure: record.data.structure,
					layoutVersion: record.data.layoutVersion,
					sections: record.data.sections,
					sectionsShown: shownCount(record.data.sections),
					tokens: { fact: tokens, display: renderFact(tokens) },
					callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
				});
				break;
			}
			case "context.snapshotted": {
				const data = record.data;
				const estimated: Fact<number> | null =
					data.estimatedTokens === undefined ? null : { kind: "estimated", value: data.estimatedTokens, method: "chars/4" };
				const reconciled: Fact<number> | null =
					data.reconciledTokens === undefined
						? null
						: { kind: "measured", value: data.reconciledTokens, source: "provider" };
				entries.push({
					kind: "context",
					at,
					snapshotId: data.snapshotId,
					source: data.source,
					window: {
						...data.window,
						display: { desired: renderCount(data.window.desired), effective: renderCount(data.window.effective) },
					},
					estimated: estimated ? { fact: estimated, display: renderFact(estimated) } : null,
					reconciled: reconciled ? { fact: reconciled, display: renderFact(reconciled) } : null,
					turnId: record.ctx.turnId ?? null,
					callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
				});
				break;
			}
			case "system_one.decided": {
				const data = record.data;
				const latency = localClock(data.latencyMs);
				const deadline = localClock(data.deadlineMs);
				entries.push({
					kind: "system-one",
					at,
					point: data.point,
					set: data.set,
					outcome: data.outcome,
					build: data.build ?? null,
					latency: { fact: latency, display: renderFact(latency, "duration") },
					deadline: { fact: deadline, display: renderFact(deadline, "duration") },
					asked: data.asked,
					abstained: data.abstained,
					routes: data.routes.map((route) => {
						const roundTrip = route.roundTripMs === undefined ? null : localClock(route.roundTripMs);
						return {
							engine: route.engine,
							kind: route.kind,
							profile: route.profile,
							outcome: route.outcome,
							roundTrip: roundTrip ? { fact: roundTrip, display: renderFact(roundTrip, "duration") } : null,
							breaker: route.breaker ?? null,
						};
					}),
					callIds: data.callIds as CallRowV1["callId"][],
				});
				break;
			}
		}
	}
	// A worker's channel failures live in its run journal; the session shows those of the runs it referenced (#425).
	for (const run of analysis.runs.values())
		for (const record of run.source.records)
			if (record.k === "worker.channel_failed")
				entries.push({
					kind: "worker-channel",
					at: record.t,
					runId: run.runId,
					lane: record.data.lane,
					frameType: record.data.frameType,
					errno: record.data.errno,
					afterExit: record.data.afterExit,
					failure: record.data.failure,
				});
	for (const run of analysis.runs.values())
		if (run.settled)
			entries.push({
				kind: "run",
				at: run.settled.at,
				runId: run.runId,
				event: "settled",
				terminalReason: run.settled.data.terminalReason,
			});
	const order: Record<TimelineEntry["kind"], number> = {
		session: 0,
		gap: 1,
		config: 2,
		auth: 3,
		quota: 4,
		budget: 5,
		prompt: 6,
		context: 7,
		"system-one": 8,
		middleware: 9,
		call: 10,
		message: 11,
		tool: 12,
		"worker-channel": 13,
		compaction: 14,
		run: 15,
		turn: 16,
	};
	const within = (at: string) => !range || (at >= range.from && at <= range.to);
	return {
		...header(options),
		kind: "timeline",
		sessionId: id,
		range,
		entries: entries
			.filter((entry) => within(entry.at))
			.sort((a, b) => (a.at === b.at ? order[a.kind] - order[b.kind] : a.at < b.at ? -1 : 1)),
	};
}

/** One attempt on a timeline, its quantities under the scope that owns it. */
function callEntry(
	view: View,
	scope: "own" | "run",
	owner: string,
	attempt: Attempt,
): Extract<TimelineEntry, { kind: "call" }> {
	const q = (metric: FactMetric) => quantity(view, { scope, owner, attemptId: attempt.started.attemptId, metric });
	return {
		kind: "call",
		at: attempt.startedAt,
		endAt: attempt.settledAt,
		callId: attempt.started.callId as CallRowV1["callId"],
		attemptId: attempt.started.attemptId as CallRowV1["attemptId"],
		agent: attempt.agent,
		turnId: attempt.ctx?.turnId ?? null,
		runId: attempt.ctx?.runId ?? null,
		disposition: attempt.settled?.disposition ?? "incomplete",
		failure: attempt.settled?.stop.failure ?? null,
		stages: attempt.settled?.stages ?? null,
		timing: { ttft: q("ttft"), modelTime: q("modelTime"), settle: q("settle"), admissionWait: q("admissionWait") },
		tokens: q("total"),
		usd: q("usd"),
		cacheVerdict: attempt.settled?.cache.verdict ?? "unknown",
	};
}

/**
 * One run journal in time order (#434 §11.3): attempts, the bounded run feed, the worker process's start and exit,
 * gaps, the run's lifecycle and the route decisions it journaled. Entries at the same instant keep journal order
 * within a kind, so feed sequence holds.
 */
export function runTimeline(runId: string, source: JournalSource, options: ReadOptions = {}): RunTimelineV1 {
	const run = analyzeRun(runId, source);
	const view: View = { run };
	const entries: RunTimelineEntry[] = run.attempts.map((attempt) => callEntry(view, "run", runId, attempt));
	for (const record of source.records) {
		const at = record.t;
		switch (record.k) {
			case "run.feed_appended": {
				const body = record.data.body;
				const ms = body.kind === "event" ? body.durationMs : undefined;
				const fact = ms === undefined ? null : localClock(ms);
				entries.push({
					kind: "feed",
					at,
					seq: record.data.seq,
					body,
					duration: fact ? { fact, display: renderFact(fact, "duration") } : null,
				});
				break;
			}
			case "process.started":
				entries.push({ kind: "process", at, event: "started", exitCode: null });
				break;
			case "process.exited":
				entries.push({ kind: "process", at, event: "exited", exitCode: record.data.exitCode });
				break;
			case "journal.gap":
				entries.push(gapEntry(record));
				break;
			// A retry or fleet step's run.enqueued can land in an ancestor's journal; only this run's own counts here.
			case "run.enqueued":
				if (record.data.runId === runId) entries.push({ kind: "run", at, runId, event: "enqueued", terminalReason: null });
				break;
			case "run.started":
				entries.push({ kind: "run", at, runId, event: "started", terminalReason: null });
				break;
			case "run.sealed":
				entries.push({ kind: "run", at, runId, event: "sealed", terminalReason: null });
				break;
			case "route.decided":
				entries.push({
					kind: "route",
					at,
					mode: record.data.mode,
					posture: record.data.posture,
					decisionHash: record.data.decisionHash,
					executed: {
						agentId: record.data.executed.agentId,
						targetId: record.data.executed.targetId,
						modelId: record.data.executed.modelId,
						runtimeId: record.data.executed.runtimeId,
						nodeId: record.data.executed.nodeId,
					},
					differs: record.data.verdict.differs,
					executedAdmissible: record.data.verdict.executedAdmissible,
				});
				break;
		}
	}
	if (run.settled)
		entries.push({
			kind: "run",
			at: run.settled.at,
			runId,
			event: "settled",
			terminalReason: run.settled.data.terminalReason,
		});
	const order: Record<RunTimelineEntry["kind"], number> = { route: 0, process: 1, gap: 2, call: 3, feed: 4, run: 5 };
	return {
		...header(options),
		kind: "run-timeline",
		runId,
		sessionId: run.sessionId,
		entries: entries.sort((a, b) => (a.at === b.at ? order[a.kind] - order[b.kind] : a.at < b.at ? -1 : 1)),
	};
}
