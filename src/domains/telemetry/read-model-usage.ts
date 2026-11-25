// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { FundingDefinitions } from "../../core/funding-config.js";
import type { FactMetric, ParsedFactRef, RunTelemetryV1 } from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import { freeRuleAgreement, sumFactSums, sumFacts } from "../../core/telemetry/pricing.js";
import { renderCountSum, renderDurationSum, renderFact, renderUsdSum } from "../../core/telemetry/render.js";
import { countsAsToolCall } from "../../core/telemetry/tool-schemas.js";
import { foldDecisions } from "./fact-folds.js";
import {
	analyze,
	attemptFact,
	localClock,
	localCount,
	notApplicable,
	quantity,
	selectionOf,
	unobserved,
	type View,
} from "./read-model.js";
import { cacheReport } from "./read-model-cache.js";
import { costReport, repoCostReport, repoTokenQuantities } from "./read-model-cost.js";
import { sessionTelemetry } from "./read-model-reports.js";
import { accountabilityRecords, sessionJournals } from "./read-model-runs.js";
import {
	type JournalSource,
	parseRepoOwner,
	type RepoSource,
	repoOwner,
	type SessionSource,
} from "./read-model-sources.js";
import { shownCount } from "./read-model-timeline.js";

/** Window facts for the usage surface, folded once from the same sources as its spend (#434). */
export function usageReport(source: RepoSource, from: number, to: number, pools?: Readonly<FundingDefinitions>) {
	const journals = [...source.sessions.flatMap(sessionJournals), ...source.runs.values()];
	const inWindow = (at: string) => Date.parse(at) >= from && Date.parse(at) <= to + 5_000;
	const records = accountabilityRecords(journals).filter((record) => inWindow(record.t));
	const decisions = records
		.filter((record) => record.k === "tool.decided")
		.filter((record) => countsAsToolCall(record.data));
	// A stalled step pipeline settles its run `completed`, so the run count alone reads it as done (bt-20).
	const pipelines = source.sessions
		.flatMap((session) => session.journal.records)
		.filter(
			(record): record is TelemetryRecord<"step_pipeline.settled"> =>
				record.k === "step_pipeline.settled" && inWindow(record.t),
		);
	const decided = foldDecisions(records);
	const approvals = decided.approvals;
	const runs = new Map<string, JournalSource>(source.runs);
	for (const session of source.sessions) for (const [id, journal] of session.runs) runs.set(id, journal);
	const settled = [...runs.values()].filter((journal) =>
		journal.records.some((record) => record.k === "run.settled" && inWindow(record.data.endedAt)),
	);
	const byTool = new Map<string, number>();
	for (const record of decisions) byTool.set(record.data.tool, (byTool.get(record.data.tool) ?? 0) + 1);
	const rate: Fact<number> = approvals.approvalRate === null ? notApplicable : localCount(100 * approvals.approvalRate);
	return {
		sessions: shownCount(source.sessions.filter((session) => session.processId === undefined).length),
		runs: shownCount(settled.length),
		stepPipelines: {
			settled: shownCount(pipelines.length),
			incomplete: shownCount(pipelines.filter((record) => !record.data.done).length),
		},
		decisions: {
			total: shownCount(decisions.length),
			blocked: shownCount(decided.tools.blocked + decided.tools.denied),
			tools: [...byTool]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([tool, count]) => ({ tool, count: shownCount(count) })),
		},
		approvals: {
			requested: shownCount(approvals.requested),
			granted: shownCount(approvals.granted),
			denied: shownCount(approvals.denied),
			expired: shownCount(approvals.expired),
			rate: { fact: rate, display: renderFact(rate, "percent") },
		},
		// The judge's reviews beside the operator's: a call the judge allowed never asked anyone (dogfood F4).
		safetyJudge: {
			reviewed: shownCount(decided.safety.allow + decided.safety.block + decided.safety.escalated + decided.safety.none),
			allowed: shownCount(decided.safety.allow),
			blocked: shownCount(decided.safety.block),
			escalated: shownCount(decided.safety.escalated),
			noVerdict: shownCount(decided.safety.none),
		},
		tokens: repoTokenQuantities(source),
		cost: (["role", "model", "target"] as const).map((groupBy) =>
			repoCostReport(
				source,
				{ repo: parseRepoOwner(source.owner)?.cwdHash ?? "all", days: parseRepoOwner(source.owner)?.days ?? 30 },
				groupBy,
				{ ...(pools ? { pools } : {}), window: { from, to } },
			),
		),
		cache: source.sessions.map((session) => cacheReport(session)),
		performance: operatorPerformance(source),
	};
}

function measuredTiming(fact: Fact<number>): number | null {
	return fact.kind === "measured" ? fact.value : null;
}

function latencyStats(values: readonly (number | null)[]) {
	const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
	const duration = (value: number | undefined) => {
		const fact = value === undefined ? unobserved : localClock(value);
		return { fact, display: renderFact(fact, "duration") };
	};
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length
		? sorted.length % 2
			? sorted[middle]
			: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: undefined;
	return {
		p50: duration(median),
		p95: duration(sorted[Math.ceil(sorted.length * 0.95) - 1]),
		measured: shownCount(sorted.length),
		missing: shownCount(values.length - sorted.length),
	};
}

/** Content-free operator measurements, rebuilt from the existing journals, never a second metrics store. */
function operatorPerformance(source: RepoSource, windowed = true) {
	const unique = new Map<string, JournalSource>();
	for (const session of source.sessions) {
		unique.set(`session:${session.sessionId}`, session.journal);
		for (const [id, journal] of session.runs) unique.set(`run:${id}`, journal);
	}
	for (const [id, journal] of source.runs) unique.set(`run:${id}`, journal);
	const journals = [...unique.values()];
	const records = new Map<string, TelemetryRecord>();
	for (const journal of journals)
		for (const record of journal.records) if (!records.has(record.id)) records.set(record.id, record);
	const ordered = [...records.values()].sort((a, b) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id));
	const tools = new Map<string, { ok: number; errors: number; blocked: number; durations: number[] }>();
	for (const record of ordered) {
		if (record.k !== "tool.settled" || !countsAsToolCall(record.data)) continue;
		const row = tools.get(record.data.tool) ?? { ok: 0, errors: 0, blocked: 0, durations: [] };
		if (record.data.outcome === "ok") row.ok++;
		else if (record.data.outcome === "error") row.errors++;
		else row.blocked++;
		if (record.data.outcome !== "blocked") row.durations.push(record.data.durationMs);
		tools.set(record.data.tool, row);
	}
	const compactions = ordered.filter((record) => record.k === "compaction.settled");
	// Totals count the model's calls only, like the per-tool and per-session rows (C-9).
	const settledCalls = ordered
		.filter((record) => record.k === "tool.settled")
		.filter((record) => countsAsToolCall(record.data));
	const outcomes = { committed: 0, discarded: 0, failed: 0, unresolved: 0 };
	for (const record of compactions) outcomes[record.data.outcome]++;
	const sessions = source.sessions
		.filter((session) => session.processId === undefined)
		.map((session) => {
			const telemetry = sessionTelemetry(session);
			const view: View = windowed ? { repo: source } : { session };
			const base: Omit<ParsedFactRef, "metric"> = windowed
				? { scope: "repo", owner: source.owner, group: { by: "session", key: session.sessionId } }
				: { scope: "session", owner: session.sessionId };
			const q = (metric: FactMetric) => quantity(view, { ...base, metric });
			const calls = selectionOf(analyze(session), { by: "role", key: "main" }).members;
			const ownRecords = new Map<string, TelemetryRecord>();
			for (const journal of sessionJournals(session))
				for (const record of journal.records) ownRecords.set(record.id, record);
			const observed = [...ownRecords.values()];
			const settledTools = observed
				.filter((record) => record.k === "tool.settled")
				.filter((record) => countsAsToolCall(record.data));
			return {
				sessionId: session.sessionId,
				startedAt: telemetry.lifetime.firstRecordAt,
				lastAt: telemetry.lifetime.lastRecordAt,
				calls: q("calls"),
				tokens: q("total"),
				usd: q("usd"),
				cacheShare: q("cacheShare"),
				ttft: latencyStats(calls.map((call) => measuredTiming(attemptFact(call, "ttft")))),
				modelTime: latencyStats(calls.map((call) => measuredTiming(attemptFact(call, "modelTime")))),
				trend: calls.slice(-32).map((call) => measuredTiming(attemptFact(call, "ttft"))),
				toolCalls: shownCount(settledTools.length),
				toolErrors: shownCount(settledTools.filter((record) => record.data.outcome === "error").length),
				compactions: shownCount(observed.filter((record) => record.k === "compaction.settled").length),
				journal: telemetry.journal,
			};
		})
		.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.sessionId.localeCompare(b.sessionId));
	return {
		coverage: {
			journals: journals.length,
			unavailable: journals.filter((journal) => !journal.present).length,
			gaps: [...unique.values()].reduce(
				(sum, journal) =>
					sum + journal.skipped + journal.damaged + journal.records.filter((record) => record.k === "journal.gap").length,
				0,
			),
		},
		totals: {
			toolCalls: shownCount(settledCalls.length),
			toolErrors: shownCount(settledCalls.filter((record) => record.data.outcome === "error").length),
			toolBlocked: shownCount(settledCalls.filter((record) => record.data.outcome === "blocked").length),
			compactions: shownCount(compactions.length),
		},
		tools: [...tools]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([tool, row]) => {
				const attempts = row.ok + row.errors;
				const success: Fact<number> = attempts ? localCount((100 * row.ok) / attempts) : unobserved;
				return {
					tool,
					calls: shownCount(attempts + row.blocked),
					ok: shownCount(row.ok),
					errors: shownCount(row.errors),
					blocked: shownCount(row.blocked),
					success: { fact: success, display: renderFact(success, "percent") },
					latency: latencyStats(row.durations),
				};
			}),
		compactionOutcomes: {
			committed: shownCount(outcomes.committed),
			discarded: shownCount(outcomes.discarded),
			failed: shownCount(outcomes.failed),
			unresolved: shownCount(outcomes.unresolved),
		},
		compactions: compactions
			.slice(-24)
			.reverse()
			.map((record) => ({
				recordId: record.id,
				at: record.t,
				sessionId: record.ctx.sessionId ?? null,
				runId: record.ctx.runId ?? null,
				outcome: record.data.outcome,
				checkpointTurnId: record.data.checkpointTurnId,
			})),
		sessions: sessions.slice(-80),
		sessionCount: sessions.length,
	};
}

export function sessionOperatorMetrics(source: SessionSource) {
	return {
		cost: (["model", "target"] as const).map((by) => costReport(source, by)),
		performance: operatorPerformance({ owner: repoOwner(null, 30), sessions: [source], runs: new Map() }, false),
	};
}

/** Fleet totals over run DTOs, preserving unknown contributions from unreadable runs (#434). */
export function fleetTotals(runs: readonly RunTelemetryV1[]) {
	const free = runs.length > 0 && runs.every((run) => run.settled?.pricing.pricedBy === "free");
	const agreement = free ? freeRuleAgreement(runs.map((run) => run.settled?.pricing)) : undefined;
	const sum = (facts: Array<Fact<number> | FactSum>, unit: "count" | "usd" | "duration") => {
		const fact = sumFactSums(facts.map((fact) => ("kind" in fact ? sumFacts([fact]) : fact)));
		return {
			fact,
			display:
				unit === "usd"
					? renderUsdSum(fact, free, agreement?.rule, agreement?.mixed)
					: unit === "duration"
						? renderDurationSum(fact)
						: renderCountSum(fact),
		};
	};
	return {
		input: sum(
			runs.map((run) => run.tokens.input.fact),
			"count",
		),
		output: sum(
			runs.map((run) => run.tokens.output.fact),
			"count",
		),
		cacheRead: sum(
			runs.map((run) => run.tokens.cacheRead.fact),
			"count",
		),
		cacheWrite: sum(
			runs.map((run) => run.tokens.cacheWrite.fact),
			"count",
		),
		total: sum(
			runs.map((run) => run.row.tokens.fact),
			"count",
		),
		usd: sum(
			runs.map((run) => run.row.usd.fact),
			"usd",
		),
		elapsed: sum(
			runs.map((run) => run.activity.elapsed.fact),
			"duration",
		),
	};
}
