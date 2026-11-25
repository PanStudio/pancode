// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { SIDE_SURFACES, type SurfaceId } from "../../core/side-surfaces.js";
import { telemetryOwner } from "../../core/telemetry/context.js";
import type { AgentRole } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact, FactSum, UnknownReason } from "../../core/telemetry/fact.js";
import { sumFactSums } from "../../core/telemetry/pricing.js";
import type { ObjectRef } from "../../core/telemetry/schemas.js";
import type { SurfaceOutcome } from "../../core/telemetry/surface-schemas.js";
import type { ContextSnapshot } from "../session/context-accounting.js";
import type { SessionPromptCompileRecord } from "../session/prompt-manifest.js";
import {
	addGroup,
	type CallTotals,
	emptyCallTotals,
	emptyFactSum,
	type FoldedAttempt,
	foldCallJournal,
	foldCalls,
} from "./folds.js";
import type { telemetryPromptStructure } from "./objects.js";
import { unknownSum } from "./read-model.js";

/** Session accounting replays only snapshots owned by this session, in journal order (#434). */
export function contextSnapshots(records: readonly TelemetryRecord[], sessionId: string): ContextSnapshot[] {
	return records.flatMap((record) => {
		if (record.k !== "context.snapshotted" || record.ctx.sessionId !== sessionId) return [];
		const data = record.data;
		return [
			{
				snapshotId: data.snapshotId,
				sessionId,
				turnId: record.ctx.turnId ?? "",
				providerId: data.providerId,
				runtimeId: data.runtimeId,
				modelId: data.modelId,
				desiredContextWindow: data.window.desired,
				effectiveContextWindow: data.window.effective,
				contextWindowSource: data.window.source,
				categories: data.categories,
				sources: { total: data.source, splits: data.splits },
				...(data.promptSegments ? { promptSegments: data.promptSegments } : {}),
				...(data.promptHash ? { promptHash: data.promptHash } : {}),
				...(data.toolSignature ? { toolSignature: data.toolSignature } : {}),
				...(data.messageRange ? { messageRange: data.messageRange } : {}),
				...(data.estimatedTokens !== undefined ? { estimatedTokens: data.estimatedTokens } : {}),
				...(data.reconciledTokens !== undefined ? { reconciledTokens: data.reconciledTokens } : {}),
				...(data.divergenceRatio !== undefined ? { divergenceRatio: data.divergenceRatio } : {}),
				...(record.ctx.callId ? { callId: record.ctx.callId } : {}),
				...(record.ctx.attemptId ? { attemptId: record.ctx.attemptId } : {}),
			},
		];
	});
}

/** An idle writer can announce a structure again; the first compile owns its provenance (#434). */
export function promptCompiles(
	records: readonly TelemetryRecord[],
	sessionId: string,
	resolve: (ref: ObjectRef) => ReturnType<typeof telemetryPromptStructure> | null,
): SessionPromptCompileRecord[] {
	const seen = new Set<string>();
	return records.flatMap((record) => {
		if (record.k !== "prompt.compiled" || record.ctx.sessionId !== sessionId || seen.has(record.data.structure.id))
			return [];
		const structure = resolve(record.data.structure);
		if (!structure?.compile) return [];
		seen.add(record.data.structure.id);
		return [
			{
				...structure.compile,
				at: record.data.compiledAt ?? record.t,
				previousHash: record.data.previousHash ?? null,
				sections: structure.sections,
				fragments: structure.fragments.map((fragment) => {
					if (fragment.relPath === undefined) throw new Error("prompt fragment path is unavailable");
					return { ...fragment, relPath: fragment.relPath };
				}),
			},
		];
	});
}

export interface TaskMemorySpendSummary {
	/** Referenced attempts whose journal facts are missing or still incomplete (#434). */
	unresolvedCalls?: number;
	/** Retained llm-tier boundaries, including skipped attempts. Rules-tier rows are excluded. */
	llmSteps: number;
	/** Llm-tier steps whose reminder reached the visible channel. */
	injections: number;
	/** Injections over llm steps, 0 when no llm step has run. */
	hitRate: number;
	inputTokens: FactSum;
	outputTokens: FactSum;
	totalTokens: FactSum;
	/** Cumulative llm-tier step latency. */
	modelMs: number;
	/** Slowest single llm-tier step, which is what a deadline has to answer for. */
	slowestStepMs: number;
	/** Llm-tier steps that spent their whole budget and answered nothing. */
	timeouts: number;
	/** Boundaries skipped because the chat endpoint was serving a turn. */
	endpointBusySkips: number;
	/** Oldest and newest row in the ledger, so a rate is read against a window. */
	firstAt: string | null;
	lastAt: string | null;
	readableFiles: number;
	unreadableFiles: number;
	/** Nonblank rows that could not be parsed as supported telemetry. */
	invalidRows: number;
}

export function emptyTaskMemorySpendSummary(): TaskMemorySpendSummary {
	return {
		llmSteps: 0,
		injections: 0,
		hitRate: 0,
		inputTokens: emptyFactSum(),
		outputTokens: emptyFactSum(),
		totalTokens: emptyFactSum(),
		modelMs: 0,
		slowestStepMs: 0,
		timeouts: 0,
		endpointBusySkips: 0,
		firstAt: null,
		lastAt: null,
		readableFiles: 0,
		unreadableFiles: 0,
		invalidRows: 0,
	};
}

/**
 * One side surface's calls as its journal holds them: every attempt by disposition, each usage field with its unknown
 * count as coverage, and the summed service time of its settled attempts (memory design 4.1).
 */
export interface SideSurfaceFold {
	surface: SurfaceId;
	role: AgentRole;
	/** Attempts that reached a model: sent, whatever came back. */
	exercised: number;
	/**
	 * `unexercised` when no attempt reached a model, which is never a pass; `unsupported` when, in addition, the route the
	 * caller named cannot exercise the surface at all.
	 */
	status: "exercised" | "unexercised" | "unsupported";
	/** A never-sent attempt's usage counts as unknown in every sum here, never as zero or not applicable. */
	totals: CallTotals;
	/** Attempts whose usage is unknown, by why: the fact's own reason, or what became of the request. */
	unknownUsage: Partial<Record<SideUsageGap, number>>;
	/** Summed attempt service time; overlapping calls each count, so this is never time saved. */
	serviceMs: number;
}

/** Why an attempt's usage is unknown. */
export type SideUsageGap = UnknownReason | "never-sent" | "sent-unsettled" | "not-settled";

/** The route a fold is read for, as its caller knows it: what its runtime can exercise decides `unsupported`. */
export interface SideSurfaceRoute {
	runtimeId: string;
}

export interface SideSurfacesFold {
	/** One row per `SIDE_SURFACES` entry, in table order. */
	surfaces: SideSurfaceFold[];
	/** Side-agent calls journaled with no purpose, by role: what attribution has not reached yet. */
	residual: Array<{ role: AgentRole; totals: CallTotals }>;
	/** The `/memory` spend line: its steps from `memory.step_decided`, its tokens from every memory-role call. */
	memory: TaskMemorySpendSummary;
	/** Every surface that fired, with how its settling firings settled (memory design 4.1, 4.6). */
	ledger: SurfaceLedgerRow[];
}

/**
 * One surface's firings and their settlements: a middleware rule by its registration id, or a host surface such as
 * `triage`. A rule none of whose firings settle is count-only: it fires and never settles.
 */
export interface SurfaceLedgerRow {
	surface: string;
	/** Firing rows: each `middleware.fired` of the rule, or each settlement of a host surface that has no firing row. */
	fired: number;
	/** Firings that carry an id because one of their effects settles. */
	settling: number;
	/** Settled firings a request carried. */
	admitted: number;
	outcomes: Partial<Record<SurfaceOutcome, number>>;
	/** Settling firings with no settlement in these records: still open, or a session that never closed. */
	unsettled: number;
	/**
	 * Settling firings a worker drew under its run and left unsettled: no outcome ledger runs in a worker, so only a
	 * firing the run settles itself (`worker.thrash`, exploration design 3.4) ever settles there.
	 */
	unledgered: number;
	/** Settlements beyond the first for one firing; any is a ledger defect, since each firing settles once. */
	duplicates: number;
}

/** Fold firing rows and settlements by surface; a firing id is unique within the session or run that drew it. */
function foldSurfaceLedger(records: readonly TelemetryRecord[]): SurfaceLedgerRow[] {
	const rows = new Map<string, SurfaceLedgerRow>();
	const row = (surface: string): SurfaceLedgerRow => {
		let found = rows.get(surface);
		if (found === undefined) {
			found = { surface, fired: 0, settling: 0, admitted: 0, outcomes: {}, unsettled: 0, unledgered: 0, duplicates: 0 };
			rows.set(surface, found);
		}
		return found;
	};
	const firings = new Map<string, string>();
	const settled = new Set<string>();
	for (const record of records) {
		if (record.k === "middleware.fired") {
			const target = row(record.data.ruleId);
			target.fired += 1;
			if (record.data.firingId === undefined) continue;
			target.settling += 1;
			firings.set(`${telemetryOwner(record.ctx)}/${record.data.firingId}`, record.data.ruleId);
		}
	}
	for (const record of records) {
		if (record.k !== "surface.settled") continue;
		const key = `${telemetryOwner(record.ctx)}/${record.data.firingId}`;
		const target = row(record.data.surface);
		if (settled.has(key)) {
			target.duplicates += 1;
			continue;
		}
		settled.add(key);
		if (!firings.has(key)) {
			// A host surface fires and settles in one step; its settlement is its firing row.
			target.fired += 1;
			target.settling += 1;
		}
		if (record.data.admittedIn !== null) target.admitted += 1;
		target.outcomes[record.data.outcome] = (target.outcomes[record.data.outcome] ?? 0) + 1;
	}
	// A worker's open firing is labelled, never counted as a session firing left open.
	for (const [key, surface] of firings) {
		if (settled.has(key)) continue;
		if (key.startsWith("run:")) row(surface).unledgered += 1;
		else row(surface).unsettled += 1;
	}
	return [...rows.values()].sort((a, b) => a.surface.localeCompare(b.surface));
}

const NOT_SIDE_ROLES: ReadonlySet<AgentRole> = new Set(["main", "coordinator", "worker"]);
const NOT_OBSERVED: Fact<number> = { kind: "unknown", reason: "not-observed" };

/**
 * A surface's call totals with never-sent usage read as unknown: the request never left, so what it would have cost is
 * not known, and a side fold must not read it as zero (memory design MD1). The rest follows `addCallTotals`.
 */
function sideCallTotals(attempts: readonly FoldedAttempt[]): {
	totals: CallTotals;
	unknownUsage: Partial<Record<SideUsageGap, number>>;
} {
	const totals = foldCalls(attempts);
	const fresh = emptyCallTotals();
	totals.usage = fresh.usage;
	totals.promptTokens = fresh.promptTokens;
	totals.totalTokens = fresh.totalTokens;
	const unknownUsage: Partial<Record<SideUsageGap, number>> = {};
	for (const { settled } of attempts) {
		const neverSent = settled?.disposition === "never_sent";
		const fact = (field: keyof CallTotals["usage"]): Fact<number> =>
			neverSent ? NOT_OBSERVED : (settled?.usage?.[field] ?? NOT_OBSERVED);
		const bound = settled?.disposition === "sent_unsettled" ? [NOT_OBSERVED] : [];
		for (const field of Object.keys(totals.usage) as Array<keyof CallTotals["usage"]>)
			addGroup(totals.usage[field], [fact(field), ...bound]);
		const prompt = [fact("input"), fact("cacheRead"), fact("cacheWrite")];
		addGroup(totals.promptTokens, [...prompt, ...bound]);
		const total = neverSent ? undefined : settled?.usage?.total;
		addGroup(totals.totalTokens, [...(total ? [total] : [...prompt, fact("output")]), ...bound]);
		const output = fact("output");
		const gap: SideUsageGap | undefined = neverSent
			? "never-sent"
			: settled === null
				? "not-settled"
				: settled.disposition === "sent_unsettled"
					? "sent-unsettled"
					: output.kind === "unknown"
						? output.reason
						: undefined;
		if (gap !== undefined) unknownUsage[gap] = (unknownUsage[gap] ?? 0) + 1;
	}
	return { totals, unknownUsage };
}

/**
 * The record kinds {@link foldSideSurfaces} reads: the call fold's own, the memory steps and the surface ledger. A reader
 * may read a journal filtered to these (`readCallJournal`'s `wanted`) and fold the same result.
 */
export const SIDE_SURFACE_RECORD_KINDS = [
	"call.started",
	"call.settled",
	"call.linked",
	"journal.gap",
	"memory.step_decided",
	"middleware.fired",
	"surface.settled",
] as const;

/**
 * Fold every side call and the memory decisions they serve from the same journal records (#434, memory design 4.1).
 * `route` is the caller's: without it no surface can read `unsupported`, only `unexercised`.
 */
export function foldSideSurfaces(records: readonly TelemetryRecord[], route?: SideSurfaceRoute): SideSurfacesFold {
	const folded = foldCallJournal(records).attempts;
	// The journal fold keeps a start's request identity only; purpose is read from the records that carry it.
	const purposes = new Map<string, SurfaceId>();
	for (const record of records)
		if ((record.k === "call.started" || record.k === "call.settled") && record.data.purpose !== undefined)
			purposes.set(record.data.attemptId, record.data.purpose);
	const bySurface = new Map<SurfaceId, FoldedAttempt[]>();
	const unpurposed = new Map<AgentRole, FoldedAttempt[]>();
	for (const attempt of folded) {
		if (NOT_SIDE_ROLES.has(attempt.agent.role)) continue;
		const purpose = purposes.get(attempt.started.attemptId);
		if (purpose === undefined)
			unpurposed.set(attempt.agent.role, [...(unpurposed.get(attempt.agent.role) ?? []), attempt]);
		else bySurface.set(purpose, [...(bySurface.get(purpose) ?? []), attempt]);
	}
	const surfaces = SIDE_SURFACES.map(({ id, role, runtimes }): SideSurfaceFold => {
		const attempts = bySurface.get(id) ?? [];
		const exercised = attempts.filter(({ settled }) => settled !== null && settled.disposition !== "never_sent").length;
		const unsupported = route !== undefined && runtimes !== undefined && !runtimes.includes(route.runtimeId);
		return {
			surface: id,
			role,
			exercised,
			status: exercised > 0 ? "exercised" : unsupported ? "unsupported" : "unexercised",
			...sideCallTotals(attempts),
			serviceMs: attempts.reduce((sum, { settled }) => sum + (settled?.stages.settle ?? 0), 0),
		};
	});
	const residual = [...unpurposed]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([role, attempts]) => ({ role, totals: sideCallTotals(attempts).totals }));
	return { surfaces, residual, memory: foldMemorySpend(records, folded), ledger: foldSurfaceLedger(records) };
}

/** Memory decisions and their call facts; a memory-role call no decision links is still spent, so it is counted too. */
function foldMemorySpend(
	records: readonly TelemetryRecord[],
	folded: readonly FoldedAttempt[],
): TaskMemorySpendSummary {
	const summary = emptyTaskMemorySpendSummary();
	const attempts = new Map<string, FoldedAttempt>();
	for (const attempt of folded) attempts.set(attempt.started.attemptId, attempt);
	const seen = new Set<string>();
	const linkedAttempts = new Set<string>();
	const value = (fact: Fact<number>) => (fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0);
	for (const row of records) {
		if (row.k !== "memory.step_decided") continue;
		const record = row.data;
		const at = row.t;
		if (summary.firstAt === null || at < summary.firstAt) summary.firstAt = at;
		if (summary.lastAt === null || at > summary.lastAt) summary.lastAt = at;
		if (record.reason === "endpoint_busy") summary.endpointBusySkips += 1;
		if (record.tier !== "llm") continue;
		summary.llmSteps += 1;
		if (record.decision === "injected") summary.injections += 1;
		if (record.decision === "timeout") summary.timeouts += 1;
		if (record.calls?.length) {
			const linked: FoldedAttempt[] = [];
			for (const ref of record.calls) {
				linkedAttempts.add(ref.attemptId);
				const key = `${telemetryOwner(row.ctx)}/${ref.attemptId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const attempt = attempts.get(ref.attemptId);
				if (attempt?.started.callId === ref.callId) linked.push(attempt);
				else {
					summary.inputTokens = sumFactSums([summary.inputTokens, unknownSum(1)]);
					summary.outputTokens = sumFactSums([summary.outputTokens, unknownSum(1)]);
					summary.totalTokens = sumFactSums([summary.totalTokens, unknownSum(1)]);
				}
				if (!attempt || attempt.started.callId !== ref.callId || attempt.settled === null)
					summary.unresolvedCalls = (summary.unresolvedCalls ?? 0) + 1;
			}
			const totals = foldCalls(linked);
			summary.inputTokens = sumFactSums([summary.inputTokens, totals.usage.input]);
			summary.outputTokens = sumFactSums([summary.outputTokens, totals.usage.output]);
			summary.totalTokens = sumFactSums([summary.totalTokens, totals.totalTokens]);
		} else {
			addGroup(summary.inputTokens, [record.inputTokens]);
			addGroup(summary.outputTokens, [record.outputTokens]);
			addGroup(summary.totalTokens, [record.inputTokens, record.outputTokens]);
		}
		summary.modelMs += value(record.latencyMs);
		summary.slowestStepMs = Math.max(summary.slowestStepMs, value(record.latencyMs));
	}
	// Observation, reflection, retention and classification calls decide no step, and were missing from this line.
	const unlinked = foldCalls(
		folded.filter((attempt) => attempt.agent.role === "memory" && !linkedAttempts.has(attempt.started.attemptId)),
	);
	summary.inputTokens = sumFactSums([summary.inputTokens, unlinked.usage.input]);
	summary.outputTokens = sumFactSums([summary.outputTokens, unlinked.usage.output]);
	summary.totalTokens = sumFactSums([summary.totalTokens, unlinked.totalTokens]);
	summary.hitRate = summary.llmSteps === 0 ? 0 : summary.injections / summary.llmSteps;
	return summary;
}
