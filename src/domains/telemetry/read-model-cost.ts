// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type {
	CallFilter,
	CostReportV1,
	FactMetric,
	ParsedFactRef,
	Quantity,
	SessionTelemetryV1,
} from "../../core/telemetry/dto.js";
import { callEconomicsOf, type EconomyProjection, runEconomicsOf } from "../../core/telemetry/economy.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import {
	type FreeRule,
	type FreeRuleAgreement,
	freeClaim,
	type PricingSum,
	sumFactSums,
} from "../../core/telemetry/pricing.js";
import { renderCountSum, renderPricingSum } from "../../core/telemetry/render.js";
import { type EconomyContribution, type EconomyFoldOptions, foldEconomy } from "./economy-fold.js";
import {
	type Attempt,
	analyze,
	analyzeRun,
	header,
	modelKey,
	type Part,
	quantity,
	type Run,
	reportsAggregateOnly,
	runGap,
	runModelKey,
	runTargetKey,
	select,
	selectRepo,
	type View,
} from "./read-model.js";
import { matches, pricedByCounts, runAttemptsMatching, tokenQuantities } from "./read-model-reports.js";
import type { JournalSource, ReadOptions, RepoSource, SessionSource } from "./read-model-sources.js";

type GroupBy = CostReportV1["groupBy"];
function groupKeys(runs: readonly Run[], attempts: readonly Attempt[], by: GroupBy): string[] {
	const keys = new Set<string>();
	for (const attempt of attempts)
		keys.add(
			by === "role"
				? attempt.agent.role
				: by === "model"
					? modelKey(attempt.settled?.target ?? attempt.started.target)
					: by === "target"
						? (attempt.settled?.target ?? attempt.started.target).targetId
						: (attempt.ctx?.turnId ?? "-"),
		);
	for (const run of runs) {
		if ((by === "model" || by === "target") && run.fold.source === "calls") {
			for (const key of groupKeys([], run.attempts, by)) keys.add(key);
		} else {
			keys.add(
				by === "role"
					? "worker"
					: by === "model"
						? runModelKey(run)
						: by === "target"
							? runTargetKey(run)
							: (run.turnId ?? "-"),
			);
		}
	}
	return [...keys].sort();
}

function costGroups(view: View, base: Omit<ParsedFactRef, "metric">, keys: readonly string[], by: GroupBy) {
	// A session or repository window splits into its own calls and its worker runs; one run is all worker spend.
	const split = by !== "role" && (base.scope === "session" || base.scope === "repo");
	return keys.map((key) => {
		const ref = (metric: FactMetric, scope = base.scope): ParsedFactRef => ({
			...base,
			scope,
			metric,
			group: { by, key },
		});
		const share = (scope: "own" | "runs") => ({
			calls: quantity(view, ref("calls", scope)),
			tokens: quantity(view, ref("total", scope)),
			usd: quantity(view, ref("usd", scope)),
		});
		return {
			key,
			callShare: quantity(view, ref("callShare")),
			calls: quantity(view, ref("calls")),
			tokens: quantity(view, ref("total")),
			tokenFields: tokenQuantities(view, { ...base, group: { by, key } }),
			cacheShare: quantity(view, ref("cacheShare")),
			usd: quantity(view, ref("usd")),
			pricedBy: pricedByCounts(select(view, ref("usd"))?.parts ?? []),
			audience: split ? { session: share("own"), worker: share("runs") } : null,
		};
	});
}

/** A cost report's read options: the header's clock and the declared funding pools its economy adds fees for. */
export type CostReadOptions = ReadOptions & EconomyFoldOptions;

export function costReport(
	source: SessionSource,
	groupBy: GroupBy = "role",
	options: CostReadOptions = {},
): CostReportV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const base = { scope: "session" as const, owner: source.sessionId };
	return {
		...header(options),
		kind: "cost",
		scope: { sessionId: source.sessionId },
		groupBy,
		total: {
			calls: quantity(view, { ...base, metric: "calls" }),
			tokens: quantity(view, { ...base, metric: "total" }),
			usd: quantity(view, { ...base, metric: "usd" }),
			pricedBy: pricedByCounts(select(view, { ...base, metric: "usd" })?.parts ?? []),
		},
		groups: costGroups(view, base, groupKeys([...analysis.runs.values()], analysis.attempts, groupBy), groupBy),
		economy: economyReport(source, economyOptions(options)),
	};
}

const economyOptions = (options: CostReadOptions): EconomyFoldOptions => ({
	...(options.pools ? { pools: options.pools } : {}),
	...(options.window ? { window: options.window } : {}),
});

/** One cost report across a repository's sessions and runs over a window (#434 §11.1); refs use the `repo` scope. */
export function repoCostReport(
	repo: RepoSource,
	scope: { repo: string; days: number },
	groupBy: GroupBy = "role",
	options: CostReadOptions = {},
): CostReportV1 {
	const view: View = { repo };
	const base = { scope: "repo" as const, owner: repo.owner };
	const attempts = repo.sessions.flatMap((session) => analyze(session).attempts);
	const runs = new Map<string, Run>();
	for (const session of repo.sessions)
		for (const run of analyze(session).runs.values()) if (!runs.has(run.runId)) runs.set(run.runId, run);
	for (const [runId, source] of repo.runs) if (!runs.has(runId)) runs.set(runId, analyzeRun(runId, source));
	return {
		...header(options),
		kind: "cost",
		scope: { repo: scope.repo, days: scope.days },
		groupBy,
		total: {
			calls: quantity(view, { ...base, metric: "calls" }),
			tokens: quantity(view, { ...base, metric: "total" }),
			usd: quantity(view, { ...base, metric: "usd" }),
			pricedBy: pricedByCounts(select(view, { ...base, metric: "usd" })?.parts ?? []),
		},
		groups: costGroups(view, base, groupKeys([...runs.values()], attempts, groupBy), groupBy),
		economy: economyReport(repo, economyOptions(options)),
	};
}

/**
 * A fleet root's spend: its own scope and each step run it settled, folded as a repository window folds its runs. A
 * root settles no run of its own, so the root's scope alone reads as zero calls (collectives finding 4/5).
 */
export function fleetRootCostReport(
	rootId: string,
	runs: ReadonlyMap<string, JournalSource>,
	groupBy: GroupBy = "model",
	options: CostReadOptions = {},
): CostReportV1 {
	return {
		...repoCostReport({ owner: rootId, sessions: [], runs }, { repo: rootId, days: 1 }, groupBy, options),
		scope: { fleetRootId: rootId, runIds: [...runs.keys()] },
	};
}

// ---- economics (token economy S10) ----

const runContribution = (run: Run, economics: EconomyContribution["economics"]): EconomyContribution => ({
	ref: { kind: "run", runId: run.runId },
	at: run.settled?.data.endedAt ?? run.lastAt,
	settled: run.settled !== undefined,
	economics,
	cut: { role: "worker", model: runModelKey(run), target: runTargetKey(run) },
});

function attemptContribution(attempt: Attempt): EconomyContribution {
	const target = attempt.settled?.target ?? attempt.started.target;
	return {
		ref: { kind: "attempt", attemptId: attempt.started.attemptId, callId: attempt.started.callId },
		at: attempt.settledAt ?? attempt.startedAt,
		settled: attempt.settled !== null,
		economics: callEconomicsOf(attempt.settled),
		...(attempt.settled?.billing ? { reportedNanoAiu: attempt.settled.billing.nanoAiu } : {}),
		cut: { role: attempt.agent.role, model: modelKey(target), target: target.targetId },
	};
}

/**
 * The contributions a selection counts, each once: an attempt's settlement; a run folded from its calls as those
 * calls; a run that reported an aggregate as its settled economics in place of its constituents (so its fees and energy
 * are not repeated), or, with none recorded or its calls contradicting it, its visible constituents plus one
 * not-captured share for the rest. A run whose calls were already counted adds nothing; a missing journal or an unreadable stretch of one is an
 * unobserved share.
 */
function economyContributions(parts: readonly Part[]): EconomyContribution[] {
	const counted = new Set<string>();
	for (const part of parts)
		for (const attempt of part.attempts ?? (part.run?.fold.source === "calls" ? part.run.attempts : []))
			counted.add(attempt.started.callId);
	const contributions: EconomyContribution[] = [];
	parts.forEach((part, index) => {
		for (let gap = 0; gap < part.gap; gap += 1)
			contributions.push({
				ref: { kind: "gap", scope: `${part.run ? `run:${part.run.runId}` : `part:${index}`}:${gap}` },
				at: null,
				settled: false,
				economics: callEconomicsOf(null),
				cut: { role: "unknown", model: "unknown", target: "unknown" },
			});
		const run = part.run;
		if (!run) {
			contributions.push(...(part.attempts ?? []).map(attemptContribution));
			return;
		}
		if (!run.source.present) {
			contributions.push(runContribution(run, callEconomicsOf(null)));
			return;
		}
		if (run.fold.source === "calls") {
			contributions.push(...run.attempts.map(attemptContribution));
			return;
		}
		// A settlement its own calls contradict is not trusted as an aggregate: its calls count, and the rest is unknown.
		const recorded = run.fold.source === "conflict" ? undefined : run.settled?.data.economics;
		const callIds = run.settled?.data.callIds ?? [];
		if (callIds.length > 0 && callIds.every((callId) => counted.has(callId))) return;
		if (recorded && !callIds.some((callId) => counted.has(callId))) {
			contributions.push(runContribution(run, recorded));
			return;
		}
		contributions.push(...run.attempts.map(attemptContribution), runContribution(run, runEconomicsOf({})));
	});
	return contributions;
}

/**
 * The one economics projection (token economy S10) over a session's own attempts and its runs, or a repository
 * window's: every surface that shows a charge, credits, energy, an API equivalent or a fee reads it here.
 */
export function economyReport(
	source: SessionSource | RepoSource,
	options: EconomyFoldOptions = {},
	filter?: CallFilter,
): EconomyProjection {
	// A call filter reads the attempts `callRecords` does, so a run's usage and economics fold one set.
	if (filter !== undefined && !("owner" in source)) {
		const analysis = analyze(source);
		// A run filter reads that referenced run's calls alone, whatever role its journal gave them.
		const run = filter.runId === undefined ? undefined : analysis.runs.get(filter.runId);
		const attempts =
			filter.runId !== undefined
				? (run?.attempts.filter((attempt) => matches(attempt, filter)) ?? [])
				: [
						...analysis.attempts.filter((attempt) => matches(attempt, filter)),
						...runAttemptsMatching(analysis, filter).map(({ attempt }) => attempt),
					];
		return foldEconomy(attempts.map(attemptContribution), options);
	}
	const selection =
		"owner" in source
			? selectRepo(source, undefined, "repo")
			: select({ session: source }, { scope: "session", owner: source.sessionId, metric: "usd" });
	return foldEconomy(economyContributions(selection?.parts ?? []), options);
}

/** A token field over many runs, each run's calls its contributions (#434 §11.3). */
export interface RunsTotal {
	/** The known part. */
	known: number;
	/** Contributions that left the field unknown. */
	unknownRuns: number;
	display: string;
}

/**
 * A token field over runs the read model holds no journal fold for, such as the run ledger `fleet status` lists, where
 * reading every run journal costs seconds. Each run's sum over its calls is added as it is, so an unknown call leaves
 * the total a lower bound beside the count of such contributions, never a sum that took it for zero.
 */
export function runsTotal(sums: readonly FactSum[]): RunsTotal {
	const sum = sumFactSums(sums);
	return { known: sum.measured + sum.estimated, unknownRuns: sum.unknownCount, display: renderCountSum(sum, "run") };
}

/**
 * A cost over runs the read model holds no journal fold for, each run's priced sum added as it is, worded by the
 * canonical renderer: an estimated part marks the whole `~`, and an unpriced call leaves it a lower bound (§11.3).
 */
export function runsCost(pricings: readonly PricingSum[]): { fact: FactSum; display: string } {
	const free = pricings.length > 0 && pricings.every((pricing) => pricing.free);
	let seen: FreeRule | undefined;
	let sawMissing = false;
	let sawDifferent = false;
	if (free) {
		for (const pricing of pricings) {
			if (pricing.freeRuleMixed) {
				sawDifferent = true;
				continue;
			}
			if (pricing.freeRule === undefined) {
				sawMissing = true;
				continue;
			}
			if (seen !== undefined && seen !== pricing.freeRule) {
				sawDifferent = true;
				continue;
			}
			seen = pricing.freeRule;
		}
	}
	const agreement: FreeRuleAgreement = sawDifferent
		? { mixed: true }
		: !sawMissing && seen !== undefined
			? { rule: seen, mixed: false }
			: { mixed: false };
	const sum: PricingSum = { usd: sumFactSums(pricings.map((pricing) => pricing.usd)), ...freeClaim(free, agreement) };
	return { fact: sum.usd, display: renderPricingSum(sum) };
}

/** A repository window's token fields: the session view's token quantities over the `repo` scope (#434 §11.1). */
/**
 * One quantity over a process journal: the calls its process made with no session or run, such as System One outside a
 * session or a startup warm (#434).
 */
export function processQuantity(processId: string, source: JournalSource, metric: FactMetric): Quantity {
	return quantity({ process: analyzeRun(processId, source) }, { scope: "process", owner: processId, metric });
}

export function repoTokenQuantities(repo: RepoSource): SessionTelemetryV1["own"]["tokens"] {
	return tokenQuantities({ repo }, { scope: "repo", owner: repo.owner });
}

/**
 * The model a run's reported aggregate names when the run journaled no call of its own: an ACP delegation's session
 * model, which its cost report groups by. Null for a run whose calls name their own models.
 */
export function runAggregateModel(runId: string, source: JournalSource): string | null {
	const run = analyzeRun(runId, source);
	return reportsAggregateOnly(run) ? (run.fold.aggregate?.target.requestedModel ?? null) : null;
}

export function runCostReport(
	runId: string,
	source: JournalSource,
	groupBy: GroupBy = "model",
	options: CostReadOptions = {},
): CostReportV1 {
	const run = analyzeRun(runId, source);
	const view: View = { run };
	const base = { scope: "run" as const, owner: runId };
	const keys = new Set<string>(reportsAggregateOnly(run) ? groupKeys([run], [], groupBy) : []);
	for (const attempt of run.attempts)
		keys.add(
			groupBy === "role"
				? attempt.agent.role
				: groupBy === "model"
					? modelKey(attempt.settled?.target ?? attempt.started.target)
					: (attempt.ctx?.turnId ?? "-"),
		);
	return {
		...header(options),
		kind: "cost",
		scope: { runId },
		groupBy,
		total: {
			calls: quantity(view, { ...base, metric: "calls" }),
			tokens: quantity(view, { ...base, metric: "total" }),
			usd: quantity(view, { ...base, metric: "usd" }),
			pricedBy: pricedByCounts([{ run, gap: runGap(run) }]),
		},
		groups: costGroups(view, base, [...keys].sort(), groupBy),
		economy: foldEconomy(economyContributions([{ run, gap: runGap(run) }]), economyOptions(options)),
	};
}
