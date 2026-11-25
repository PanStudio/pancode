// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { processIdentityAlive } from "../../core/process-identity.js";
import type {
	CallFilter,
	CallRowV1,
	CallsReportV1,
	FactMetric,
	ParsedFactRef,
	RunRowV1,
	SessionTelemetryV1,
} from "../../core/telemetry/dto.js";
import { callEconomicsOf } from "../../core/telemetry/economy.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { renderFact } from "../../core/telemetry/render.js";
import type { JournalFold } from "./folds.js";
import {
	type Analysis,
	type Attempt,
	analyze,
	analyzeLineage,
	analyzeRun,
	cacheBreaks,
	header,
	invoked,
	type LifecycleRecord,
	latestContext,
	latestLifecycleRecord,
	noPricing,
	own,
	type Part,
	type PricedBy,
	quantity,
	type Run,
	select,
	textFact,
	unobserved,
	unreadableAncestors,
	type View,
} from "./read-model.js";
import { cacheShares, replayMismatch } from "./read-model-cache.js";
import type { JournalSource, ReadOptions, SessionSource } from "./read-model-sources.js";

export function tokenQuantities(view: View, base: Omit<ParsedFactRef, "metric">) {
	const q = (metric: FactMetric) => quantity(view, { ...base, metric });
	return {
		input: q("input"),
		output: q("output"),
		cacheRead: q("cacheRead"),
		cacheWrite: q("cacheWrite"),
		cacheWrite1h: q("cacheWrite1h"),
		reasoning: q("reasoning"),
		prompt: q("prompt"),
		total: q("total"),
	};
}

export function callCounts(view: View, base: Omit<ParsedFactRef, "metric">) {
	const q = (metric: FactMetric) => quantity(view, { ...base, metric });
	return {
		calls: q("calls"),
		attempts: q("attempts"),
		dispositions: {
			neverSent: q("neverSent"),
			sentUnsettled: q("sentUnsettled"),
			settledNoUsage: q("settledNoUsage"),
			settled: q("settled"),
			incomplete: q("incomplete"),
		},
	};
}

export function pricedByCounts(parts: readonly Part[]): Record<PricedBy, number> {
	const counts = noPricing();
	for (const part of parts) {
		if (part.selection)
			for (const [by, count] of Object.entries(part.selection.pricedBy)) counts[by as PricedBy] += count;
		else
			for (const attempt of part.attempts ?? [])
				if (invoked(attempt) && attempt.settled) counts[attempt.settled.pricing.pricedBy] += 1;
		if (part.run) {
			for (const attempt of part.run.attempts)
				if (invoked(attempt) && attempt.settled) counts[attempt.settled.pricing.pricedBy] += 1;
			if (part.run.fold.aggregate) counts[part.run.fold.aggregate.pricing.pricedBy] += 1;
		}
	}
	return counts;
}

export function journalCoverage(source: JournalSource, fold: Pick<JournalFold, "coverage">) {
	return {
		present: source.present,
		seeding: source.seeding === true,
		records: source.records.length,
		skipped: source.skipped,
		damaged: source.damaged,
		gapRecords: fold.coverage.gapRecords,
		droppedRecords: fold.coverage.droppedRecords,
		duplicateRecords: fold.coverage.duplicateRecords,
		conflictingAttempts: fold.coverage.conflictingAttempts,
	};
}

export function runRow(view: View, run: Run): RunRowV1 {
	const ref = (metric: FactMetric): ParsedFactRef => ({ scope: "run", owner: run.runId, metric });
	return {
		runId: run.runId,
		sessionId: run.sessionId,
		turnId: run.turnId,
		firstAt: run.firstAt,
		lastAt: run.lastAt,
		terminalReason: run.settled?.data.terminalReason ?? null,
		source: run.source.present ? run.fold.source : "unavailable",
		apiCalls: quantity(view, ref("apiCalls")),
		tokens: quantity(view, ref("total")),
		usd: quantity(view, ref("usd")),
	};
}

/**
 * A cheap stamp of what a session's projection reads: its own, its runs' and its ancestors' journal lengths, its quota
 * readings and its ledger. A reader comparing stamps skips building and comparing a projection nothing changed.
 */
export function sessionRevision(source: SessionSource): string {
	const parts: unknown[] = [
		source.accountQuota?.length ?? 0,
		source.ledger?.endedAt,
		source.ledger?.owner?.pid,
		source.ledger?.owner?.birthToken,
	];
	for (let node: SessionSource | null = source, depth = 0; node && depth < 128; depth += 1) {
		const journal = node.journal;
		parts.push(node.sessionId, journal.records.length, journal.skipped, journal.damaged, journal.seeding === true);
		for (const [runId, run] of node.runs)
			parts.push(runId, run.records.length, run.skipped, run.damaged, run.seeding === true);
		node = node.parent?.source ?? null;
	}
	return parts.join(":");
}

/**
 * The last session DTO each analysis projected, with what it read beyond the analysis. A later source that only
 * carried new quota readings, which the session DTO never reads, reuses it with a fresh header and liveness.
 */
const projections = new WeakMap<Analysis, { inputs: readonly unknown[]; dto: SessionTelemetryV1 }>();

const projectionInputs = (source: SessionSource): readonly unknown[] => [
	source.journal,
	source.ledger,
	source.parent?.sessionId,
	source.parent?.turnId,
	source.parent?.at,
	source.parent?.source,
	...source.runs.values(),
];

export function sessionTelemetry(source: SessionSource, options: ReadOptions = {}): SessionTelemetryV1 {
	const analysis = analyze(source);
	const inputs = projectionInputs(source);
	const projected = projections.get(analysis);
	if (
		projected &&
		projected.inputs.length === inputs.length &&
		projected.inputs.every((input, index) => input === inputs[index])
	) {
		const { dto } = projected;
		const lifetime = { ...dto.lifetime, ...lifecycle(source, options, analysis.growth.span.lifecycle) };
		return { ...dto, ...header(options), lifetime };
	}
	const dto = projectSession(source, analysis, options);
	projections.set(analysis, { inputs, dto });
	return dto;
}

function projectSession(source: SessionSource, analysis: Analysis, options: ReadOptions): SessionTelemetryV1 {
	const view: View = { session: source };
	const id = source.sessionId;
	const ownSelection = select(view, own(id, "usd"));
	const { first: firstAt, last: lastAt, lifecycle: latestLifecycle } = analysis.growth.span;
	const roles = new Set(analysis.roles.keys());
	if (analysis.runs.size > 0) roles.add("worker");
	const latest = analysis.latestMain;
	const session = (metric: FactMetric, extra: Partial<ParsedFactRef> = {}) =>
		quantity(view, { scope: "session", owner: id, metric, ...extra });
	const mainLoop = (metric: FactMetric) => quantity(view, own(id, metric, { group: { by: "role", key: "main" } }));
	return {
		...header(options),
		kind: "session",
		sessionId: id,
		modes: [...new Set(source.journal.modes)],
		journal: journalCoverage(source.journal, analysis.fold),
		lifetime: { firstRecordAt: firstAt, lastRecordAt: lastAt, ...lifecycle(source, options, latestLifecycle) },
		lineage: source.parent
			? {
					parent: { sessionId: source.parent.sessionId, turnId: source.parent.turnId, at: source.parent.at },
					totals: {
						tokens: quantity(view, { scope: "lineage", owner: id, metric: "total" }),
						usd: quantity(view, { scope: "lineage", owner: id, metric: "usd" }),
					},
					unreadableAncestors: unreadableAncestors(source),
				}
			: { parent: null, totals: null, unreadableAncestors: 0 },
		own: {
			counts: callCounts(view, { scope: "own", owner: id }),
			tokens: tokenQuantities(view, { scope: "own", owner: id }),
			cost: { usd: quantity(view, own(id, "usd")), pricedBy: pricedByCounts(ownSelection?.parts ?? []) },
		},
		byRole: [...roles].sort().map((role) => ({
			role,
			calls: session("calls", { group: { by: "role", key: role } }),
			tokens: session("total", { group: { by: "role", key: role } }),
			usd: session("usd", { group: { by: "role", key: role } }),
		})),
		runs: {
			count: analysis.runs.size,
			unresolved: [...analysis.runs.values()].filter((run) => !run.source.present).length,
			apiCalls: quantity(view, { scope: "runs", owner: id, metric: "apiCalls" }),
			tokens: quantity(view, { scope: "runs", owner: id, metric: "total" }),
			usd: quantity(view, { scope: "runs", owner: id, metric: "usd" }),
		},
		totals: { tokens: session("total"), usd: session("usd") },
		context: {
			cache: latest
				? {
						cacheRead: quantity(view, own(id, "cacheRead", { attemptId: latest.started.attemptId })),
						cacheWrite: quantity(view, own(id, "cacheWrite", { attemptId: latest.started.attemptId })),
						input: quantity(view, own(id, "input", { attemptId: latest.started.attemptId })),
						...cacheShares(view, analysis, id),
						...replayMismatch(view, id, cacheBreaks(analysis.cache)),
					}
				: null,
			used: quantity(view, { scope: "context", owner: id, metric: "contextUsed" }),
			window: quantity(view, { scope: "context", owner: id, metric: "contextWindow" }),
			free: quantity(view, { scope: "context", owner: id, metric: "contextFree" }),
			reserve: quantity(view, { scope: "context", owner: id, metric: "contextReserve" }),
			share: quantity(view, { scope: "context", owner: id, metric: "contextShare" }),
			groups: Object.keys(latestContext(source)?.data.categories ?? {}).map((key) => ({
				key,
				tokens: quantity(view, { scope: "context", owner: id, metric: "contextTokens", group: { by: "category", key } }),
				share: quantity(view, { scope: "context", owner: id, metric: "contextShare", group: { by: "category", key } }),
			})),
		},
		overhead: {
			harness: mainLoop("harnessTime"),
			share: quantity(view, { scope: "session", owner: source.sessionId, metric: "harnessShare" }),
			network: mainLoop("networkTime"),
			model: mainLoop("modelTime"),
			tool: mainLoop("toolTime"),
			bookkeepingRounds: mainLoop("bookkeepingRounds"),
			roundTripTax: mainLoop("roundTripTax"),
			prompt: mainLoop("prompt"),
		},
		transport: latest?.settled
			? {
					attemptId: latest.started.attemptId,
					at: latest.settledAt ?? latest.startedAt,
					kind: latest.settled.transport.kind,
					continuation: textFact(latest.settled.transport.continuation),
					sessionPinnedToSse: textFact(latest.settled.transport.sessionPinnedToSse),
					pinReason: latest.settled.transport.pinReason ?? null,
					recovery: latest.settled.transport.recovery ?? null,
					websocketFailures: quantity(view, own(id, "websocketFailures", { group: { by: "role", key: "main" } })),
					sseFallbacks: quantity(view, own(id, "sseFallbacks", { group: { by: "role", key: "main" } })),
				}
			: null,
	};
}

/**
 * Closed when the journal's latest lifecycle record is a close, or the ledger's close postdates the journal's latest
 * open or resume. Otherwise the session's owner decides: the ledger's, else the journal's last segment writer (#434
 * §6.1).
 */
export function lifecycle(
	source: SessionSource,
	options: ReadOptions,
	latest: LifecycleRecord | null = latestLifecycleRecord(source.journal.records),
): Pick<SessionTelemetryV1["lifetime"], "state" | "closed"> {
	if (latest?.k === "session.closed") return { state: "closed", closed: { at: latest.t, reason: latest.data.reason } };
	const ledger = source.ledger;
	// Every reopen clears endedAt on disk before the reopened process writes, so a set endedAt is a close. Facts dated
	// after it are late writes, such as health windows on a writer idling after `/new` or a background call settling;
	// only a journal open or resume says the session reopened.
	if (ledger?.endedAt && (latest === null || ledger.endedAt >= latest.t))
		return { state: "closed", closed: { at: ledger.endedAt, reason: null } };
	// The ledger restamps its owner on every reopen, before a new writer may have written anything.
	const writer = ledger?.owner ?? source.journal.writer ?? null;
	if (!writer) return { state: "unknown", closed: null };
	const alive = (options.alive ?? processIdentityAlive)(writer);
	return { state: alive === null ? "unverifiable" : alive ? "open" : "ended-abnormally", closed: null };
}

export function callRow(view: View, scope: "own" | "lineage" | "run", owner: string, attempt: Attempt): CallRowV1 {
	const settled = attempt.settled;
	const target = settled?.target ?? attempt.started.target;
	const q = (metric: FactMetric) => quantity(view, { scope, owner, attemptId: attempt.started.attemptId, metric });
	const toolChoice = attempt.started.toolChoice;
	return {
		callId: attempt.started.callId as CallRowV1["callId"],
		attemptId: attempt.started.attemptId as CallRowV1["attemptId"],
		attempt: attempt.started.attempt,
		agent: attempt.agent,
		owner: {
			sessionId: attempt.ctx?.sessionId ?? null,
			...(attempt.ctx?.runId !== undefined ? { runId: attempt.ctx.runId } : {}),
			...(attempt.ctx?.turnId !== undefined ? { turnId: attempt.ctx.turnId } : {}),
		},
		startedAt: attempt.startedAt,
		settledAt: attempt.settledAt,
		target: {
			targetId: target.targetId,
			runtimeId: target.runtimeId,
			api: target.api,
			requestedModel: target.requestedModel,
			reportedModel: textFact(target.reportedModel),
		},
		roundKind: attempt.started.roundKind,
		toolChoice: typeof toolChoice === "string" ? toolChoice : `tool:${toolChoice.name}`,
		disposition: settled?.disposition ?? "incomplete",
		stop: settled ? settled.stop : null,
		usage:
			settled?.disposition === "never_sent"
				? null
				: tokenQuantities(view, { scope, owner, attemptId: attempt.started.attemptId }),
		usd: q("usd"),
		pricedBy: settled?.pricing.pricedBy ?? "none",
		stages: settled?.stages ?? null,
		timing: {
			ttft: q("ttft"),
			modelTime: q("modelTime"),
			settle: q("settle"),
			admissionWait: q("admissionWait"),
			harness: q("harnessTime"),
			network: q("networkTime"),
			tool: q("toolTime"),
		},
		admission: settled?.stages.admission?.waitedOn ?? null,
		transport: {
			kind: settled?.transport.kind ?? "unknown",
			continuation: textFact(settled?.transport.continuation ?? unobserved),
			requestBytes: q("requestBytes"),
			sessionPinnedToSse: textFact(settled?.transport.sessionPinnedToSse ?? unobserved),
			connectionReused: textFact(settled?.transport.connectionReused ?? unobserved),
			session: textFact(settled?.transport.session ?? unobserved),
			websocketFailures: q("websocketFailures"),
			sseFallbacks: q("sseFallbacks"),
			pinReason: settled?.transport.pinReason ?? null,
			recovery: settled?.transport.recovery ?? null,
		},
		cache: {
			verdict: settled?.cache.verdict ?? "unknown",
			expectedColdReasons: settled?.cache.expectedColdReasons ?? [],
			firstDivergentSection: textFact(settled?.cache.firstDivergentSection ?? unobserved),
			rePrefilled: q("rePrefilled"),
			uncachedPrefill: q("uncachedPrefill"),
			breakUsd: q("breakUsd"),
		},
		quota: settled?.quota ?? null,
		responseId: settled?.responseId ?? null,
		billing: settled?.billing
			? {
					provider: settled.billing.provider,
					premiumRequests: seatUnit(settled.billing.premiumRequests, "units"),
					nanoAiu: seatUnit(settled.billing.nanoAiu),
					modelCalls: seatUnit(settled.billing.modelCalls),
					...(settled.billing.discrepancy ? { discrepancy: settled.billing.discrepancy } : {}),
				}
			: null,
		economics: callEconomicsOf(settled),
	};
}

function seatUnit(fact: Fact<number>, as: "count" | "units" = "count") {
	return { fact, display: renderFact(fact, as) };
}

export function matches(attempt: Attempt, filter: CallFilter): boolean {
	if (filter.roles && !filter.roles.includes(attempt.agent.role)) return false;
	if (filter.dispositions && !filter.dispositions.includes(attempt.settled?.disposition ?? "incomplete")) return false;
	if (filter.turnIds && !filter.turnIds.includes(attempt.ctx?.turnId ?? "")) return false;
	if (filter.from && attempt.startedAt < filter.from) return false;
	if (filter.to && attempt.startedAt > filter.to) return false;
	return true;
}

/**
 * The referenced runs' attempts a filter naming the `worker` role reaches: every call a dispatched run made counts as
 * the worker's, whatever role its own journal gave it, so the role filter reads the run rather than the attempt.
 */
export function runAttemptsMatching(analysis: Analysis, filter: CallFilter): Array<{ run: Run; attempt: Attempt }> {
	if (!filter.roles?.includes("worker")) return [];
	const { roles: _worker, ...rest } = filter;
	return [...analysis.runs.values()].flatMap((run) =>
		run.attempts.filter((attempt) => matches(attempt, rest)).map((attempt) => ({ run, attempt })),
	);
}

/**
 * The journal records of the session's own attempts the filter matches, and, for a filter naming the `worker` role,
 * those of the referenced runs' attempts, for a fold that needs each fact's provenance rather than its quantity, such
 * as the run.settled of a headless main-agent run (#434). `runId` and `limit` are ignored.
 */
export function callRecords(source: SessionSource, filter: CallFilter = {}): TelemetryRecord[] {
	const analysis = analyze(source);
	const ids = new Set(analysis.attempts.flatMap((attempt) => (matches(attempt, filter) ? attempt.recordIds : [])));
	const own = source.journal.records.filter((record) => ids.has(record.id));
	const byRun = new Map<Run, Set<string>>();
	for (const { run, attempt } of runAttemptsMatching(analysis, filter)) {
		const runIds = byRun.get(run) ?? new Set<string>();
		for (const id of attempt.recordIds) runIds.add(id);
		byRun.set(run, runIds);
	}
	return [
		...own,
		...[...byRun].flatMap(([run, runIds]) => run.source.records.filter((record) => runIds.has(record.id))),
	];
}

/** A session's own attempts, or one referenced run's with `filter.runId`; `limit` keeps the newest rows. */
/** `lineage` also reads a fork's ancestors' attempts, as a replayed copied turn needs. */
export function callsReport(
	source: SessionSource,
	filter: CallFilter = {},
	options: ReadOptions = {},
	scope: "session" | "lineage" = "session",
): CallsReportV1 {
	const view: View = { session: source };
	const analysis = scope === "lineage" ? analyzeLineage(source) : analyze(source);
	const run = filter.runId === undefined ? undefined : analysis.runs.get(filter.runId);
	const attempts = (filter.runId === undefined ? analysis.attempts : (run?.attempts ?? [])).filter((attempt) =>
		matches(attempt, filter),
	);
	const shown = filter.limit === undefined ? attempts : attempts.slice(-filter.limit);
	return {
		...header(options),
		kind: "calls",
		sessionId: source.sessionId,
		runId: filter.runId ?? null,
		filter,
		calls: shown.map((attempt) =>
			run
				? callRow(view, "run", run.runId, attempt)
				: callRow(view, scope === "lineage" ? "lineage" : "own", source.sessionId, attempt),
		),
		matched: attempts.length,
	};
}

export function runCallsReport(
	runId: string,
	source: JournalSource,
	filter: CallFilter = {},
	options: ReadOptions = {},
): CallsReportV1 {
	const run = analyzeRun(runId, source);
	const view: View = { run };
	const attempts = run.attempts.filter((attempt) => matches(attempt, filter));
	const shown = filter.limit === undefined ? attempts : attempts.slice(-filter.limit);
	return {
		...header(options),
		kind: "calls",
		sessionId: run.sessionId,
		runId,
		filter: { ...filter, runId },
		calls: shown.map((attempt) => callRow(view, "run", runId, attempt)),
		matched: attempts.length,
	};
}
