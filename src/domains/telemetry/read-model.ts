// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { cacheBreakLoss } from "../../core/telemetry/cache-break.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import {
	type ExplanationV1,
	type FactGroup,
	type FactMetric,
	type FactRef,
	factRef,
	type ParsedFactRef,
	parseFactRef,
	type Quantity,
	TELEMETRY_DTO_VERSION,
} from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EvidenceAssessed } from "../../core/telemetry/evidence-schemas.js";
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import {
	type FreeRule,
	type FreeRuleAgreement,
	freeClaim,
	freeRuleAgreement,
	type Pricing,
	sumFactSums,
	sumFacts,
} from "../../core/telemetry/pricing.js";
import {
	renderCount,
	renderCountSum,
	renderCoverage,
	renderDurationSum,
	renderFact,
	renderShareSum,
	renderTextFact,
	renderUsdFact,
	renderUsdSum,
} from "../../core/telemetry/render.js";
import type { RunSettled } from "../../core/telemetry/run-schemas.js";
import type { CallSettled, CallUsage } from "../../core/telemetry/schemas.js";
import { countsAsToolCall } from "../../core/telemetry/tool-schemas.js";
import { ToolNames } from "../../core/tool-names.js";
import {
	addCallTotals,
	addGroup,
	type CallJournalFolder,
	type CallTotals,
	callJournalFolder,
	componentSubtotal,
	emptyCallTotals,
	emptyFactSum,
	type FoldedAttempt,
	type FoldOptions,
	foldCalls,
	foldRunJournal,
	type JournalFold,
	TELEMETRY_FOLD_VERSION,
} from "./folds.js";
import type { JournalSource, ReadOptions, RepoSource, SessionSource } from "./read-model-sources.js";

export interface Attempt extends FoldedAttempt {
	startedAt: string;
	settledAt: string | null;
	ctx: TelemetryContext | null;
	recordIds: string[];
	/** The tools the attempt's call asked for, as tool.settled recorded them; null when none is recorded. */
	tools: ToolSummary | null;
	/** Where a process's first request on its route departs mid-transcript from the last one journaled there. */
	replay: string | null;
}
/** The tool calls one model call asked for (#434 §12.3, §12.4). */
interface ToolSummary {
	calls: number;
	durationMs: number;
	/** Every tool was bookkeeping: the round re-read its context for no work on the task. */
	bookkeepingOnly: boolean;
}

/**
 * The tools whose rounds the epic counts as bookkeeping: they update the plan or record a decision and do no work on
 * the task, so a round that called only them paid a context re-read for nothing else (#434 §12.4).
 */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([ToolNames.Tasks, ToolNames.Decide]);

function noteTool(tools: Map<string, ToolSummary>, record: TelemetryRecord): string | null {
	if (record.k !== "tool.settled" || record.ctx.callId === undefined || !countsAsToolCall(record.data)) return null;
	const prior = tools.get(record.ctx.callId);
	tools.set(record.ctx.callId, {
		calls: (prior?.calls ?? 0) + 1,
		durationMs: (prior?.durationMs ?? 0) + record.data.durationMs,
		bookkeepingOnly: (prior?.bookkeepingOnly ?? true) && BOOKKEEPING_TOOLS.has(record.data.tool),
	});
	return record.ctx.callId;
}
export interface Run {
	runId: string;
	source: JournalSource;
	/** The session record that referenced the run, which the run's turn and reference time come from. */
	reference: TelemetryRecord | null;
	fold: ReturnType<typeof foldRunJournal>;
	attempts: Attempt[];
	byAttempt: Map<string, Attempt>;
	settled: { at: string; data: RunSettled } | null;
	assessed: { at: string; data: EvidenceAssessed } | null;
	firstAt: string | null;
	lastAt: string | null;
	sessionId: string | null;
	/** The parent turn whose session record referenced the run. */
	turnId: string | null;
	referencedAt: string | null;
	/** Unreadable lines or a damaged segment; the fold cannot see what they held. */
	gap: number;
}
export interface Analysis {
	sessionId: string;
	/** Every attempt in the read model's order; the same array as the whole selection's members. */
	attempts: Attempt[];
	byAttempt: Map<string, Attempt>;
	fold: Pick<JournalFold, "coverage">;
	/** Unknown contributions added to every whole-scope sum: an incomplete read and unattributed aggregates. */
	gap: number;
	runs: Map<string, Run>;
	/**
	 * One running fold per selection a reader asked for, keyed by group; the whole set is `""` and always stays. The
	 * other groups are the {@link SELECTION_CACHE_LIMIT} most recently read, oldest first; a group read again after it
	 * left folds cold to the same sums.
	 */
	selections: Map<string, SelectionState>;
	/** Engine floors and cache breaks, kept as calls land so a live re-projection never rescans the session. */
	cache: CacheState;
	/** Attempts per role, and the main loop's latest settled sent call, for the same reason. */
	roles: Map<Attempt["agent"]["role"], number>;
	latestMain: Attempt | null;
	growth: Growth;
}

/**
 * What a live analysis needs to fold only the records a later read appends (#434 §11). Records fold as `head` then
 * the fixed `tail` (ancestors' records for a lineage), while a cold read folds appended records
 * before the tail; a new record that names an id the tail carries could fold differently, so it rebuilds instead.
 */
interface Growth {
	folder: CallJournalFolder;
	meta: Map<string, AttemptMeta>;
	replays: ReplayRoutes;
	/** Tool calls by the model call that asked for them, and each call's attempts, so a late tool record moves its call. */
	tools: Map<string, ToolSummary>;
	callAttempts: Map<string, Set<string>>;
	/** The first session record referencing each run. */
	references: Map<string, TelemetryRecord>;
	/**
	 * The turn that dispatched each run, from the parent's `run.enqueued`: a dispatched worker's `call.linked` carries the
	 * worker's context, which has no turn, and its parent writes no `run.linked` (D3-b).
	 */
	enqueuedTurns: Map<string, string>;
	/** A gap other than policy was folded. */
	gapRecord: boolean;
	head: readonly TelemetryRecord[];
	/** The earliest and latest record times in `head`, and its latest lifecycle record. */
	span: { first: string | null; last: string | null; lifecycle: LifecycleRecord | null };
	tail: { records: Set<string>; attempts: Set<string>; runs: Set<string> };
	/** A lineage's parent source; null for a session's own analysis. */
	parent: SessionSource | null;
}

/** Facts an attempt's records give it beyond the fold: when it started and settled, its context and record ids. */
interface AttemptMeta {
	startedAt?: string;
	settledAt?: string;
	ctx?: TelemetryContext;
	ids: Set<string>;
	replay?: string;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
export const notApplicable: Fact<number> = { kind: "absent", reason: "not-applicable" };
export const unobserved = { kind: "unknown", reason: "not-observed" } as const satisfies Fact<number>;
export const localClock = (value: number): Fact<number> => ({ kind: "measured", value, source: "local-clock" });
export const localCount = (value: number): Fact<number> => ({ kind: "measured", value, source: "local-count" });
const counted = (value: number): FactSum => sumFacts([{ kind: "measured", value, source: "local-count" }]);
/** One estimate whose producer named no method; a sum marks it `~` without claiming one (R3). */
export const estimatedSum = (value: number): FactSum => ({
	measured: 0,
	estimated: value,
	unknownCount: 0,
	absentCount: 0,
	coverage: { measured: 0, estimated: 1, unknown: 0 },
});
/** `count` unknown contributions, built directly: a count read from a forged record must not size an allocation. */
export const unknownSum = (count: number): FactSum => ({
	measured: 0,
	estimated: 0,
	unknownCount: count,
	absentCount: 0,
	coverage: { measured: 0, estimated: 0, unknown: count },
});
export const header = (options: ReadOptions) => ({
	v: TELEMETRY_DTO_VERSION as typeof TELEMETRY_DTO_VERSION,
	foldVersion: TELEMETRY_FOLD_VERSION,
	generatedAt: (options.now ?? new Date()).toISOString(),
});

function noteMeta(meta: Map<string, AttemptMeta>, record: TelemetryRecord): void {
	if (record.k !== "call.started" && record.k !== "call.settled") return;
	const entry = meta.get(record.data.attemptId) ?? { ids: new Set<string>() };
	entry.ids.add(record.id);
	entry.ctx ??= record.ctx;
	if (record.k === "call.started") {
		if (entry.startedAt === undefined || record.t < entry.startedAt) entry.startedAt = record.t;
	} else if (entry.settledAt === undefined || record.t < entry.settledAt) entry.settledAt = record.t;
	meta.set(record.data.attemptId, entry);
}

function attemptOf(
	attempt: FoldedAttempt,
	entry: AttemptMeta | undefined,
	tools: ReadonlyMap<string, ToolSummary>,
): Attempt {
	return {
		...attempt,
		startedAt: entry?.startedAt ?? entry?.settledAt ?? EPOCH,
		settledAt: attempt.settled ? (entry?.settledAt ?? null) : null,
		ctx: entry?.ctx ?? null,
		recordIds: [...(entry?.ids ?? [])].sort(),
		tools: tools.get(attempt.started.callId) ?? null,
		replay: entry?.replay ?? null,
	};
}

/** Each route's transcript rebuilt from its requests' structure digests: all journaled, and the last one sent. */
interface ReplayRoutes {
	journaled: Map<string, string[]>;
	sent: Map<string, string[]>;
}
const replayRoutes = (): ReplayRoutes => ({ journaled: new Map(), sent: new Map() });

/**
 * A request with no `base` is a process's first on its route, so it replayed the transcript from the session file:
 * when its entries part from the last request the provider saw there before that request's last entry, the replay
 * sent a different prefix, named by the first entry that differs, `message[7]:tool`. Followed in journal order, the
 * order the runtime settled them in.
 */
function noteReplay(routes: ReplayRoutes, meta: Map<string, AttemptMeta>, record: TelemetryRecord): void {
	if (record.k !== "call.settled") return;
	const structure = record.data.cache.structure;
	if (!structure) return;
	const route = `${record.ctx.agent.id}\u0000${modelKey(record.data.target)}`;
	const previous = routes.sent.get(route);
	const entries =
		structure.base === undefined
			? [...structure.entries]
			: [...(routes.journaled.get(route) ?? []).slice(0, structure.base), ...structure.entries];
	routes.journaled.set(route, entries);
	if (record.data.disposition === "never_sent") return;
	routes.sent.set(route, entries);
	if (structure.base !== undefined || previous === undefined) return;
	const index = previous.findIndex((entry, at) => entries[at] !== entry);
	if (index < 0 || index === previous.length - 1) return;
	const entry = entries[index] ?? previous[index] ?? "";
	const attempt = meta.get(record.data.attemptId);
	if (attempt) attempt.replay = `message[${index}]:${entry.slice(0, entry.indexOf(":"))}`;
}

/** The read model's attempt order, which per-attempt fact sums follow: start time, then attempt id. */
function byStart(a: Attempt, b: Attempt): number {
	return a.startedAt === b.startedAt
		? a.started.attemptId.localeCompare(b.started.attemptId)
		: a.startedAt < b.startedAt
			? -1
			: 1;
}
/** {@link foldCalls}'s order, which keeps every reader's floating-point sums identical (#434). */
const byAttemptId = (a: Attempt, b: Attempt) => a.started.attemptId.localeCompare(b.started.attemptId);

function attemptsOf(records: readonly TelemetryRecord[], attempts: readonly FoldedAttempt[]): Attempt[] {
	const meta = new Map<string, AttemptMeta>();
	const tools = new Map<string, ToolSummary>();
	const routes = replayRoutes();
	for (const record of records) {
		noteMeta(meta, record);
		noteReplay(routes, meta, record);
		noteTool(tools, record);
	}
	return attempts.map((attempt) => attemptOf(attempt, meta.get(attempt.started.attemptId), tools)).sort(byStart);
}

const unavailable: JournalSource = { present: false, records: [], modes: [], skipped: 0, damaged: 0 };
/** Every surface reads an interrupted call's estimate where the provider reported nothing (#430). */
export const READ_MODEL_FOLD: FoldOptions = { interruptedEstimates: true };
export const POLICY_GAPS: ReadonlySet<string> = new Set(["mode-filtered", "research-cap"]);

/** A run journal reads the same until the live model swaps its source, so each source is folded once. */
const runAnalyses = new WeakMap<JournalSource, Run>();
export function analyzeRun(
	runId: string,
	source: JournalSource,
	reference?: TelemetryRecord,
	enqueuedTurnId?: string,
): Run {
	const turnId = reference?.ctx.turnId ?? enqueuedTurnId ?? null;
	const cached = runAnalyses.get(source);
	if (cached && cached.runId === runId && cached.reference === (reference ?? null) && cached.turnId === turnId)
		return cached;
	const fold = foldRunJournal(source.records, READ_MODEL_FOLD);
	const attempts = attemptsOf(source.records, fold.calls.attempts);
	let settled: Run["settled"] = null;
	let assessed: Run["assessed"] = null;
	let firstAt: string | null = null;
	let lastAt: string | null = null;
	for (const record of source.records) {
		if (firstAt === null || record.t < firstAt) firstAt = record.t;
		if (lastAt === null || record.t > lastAt) lastAt = record.t;
		if (record.k === "run.settled" && (!settled || record.t >= settled.at)) settled = { at: record.t, data: record.data };
		if (record.k === "evidence.assessed" && (!assessed || record.t >= assessed.at))
			assessed = { at: record.t, data: record.data };
	}
	const run: Run = {
		runId,
		source,
		reference: reference ?? null,
		fold,
		attempts,
		byAttempt: new Map(attempts.map((attempt) => [attempt.started.attemptId, attempt])),
		settled,
		assessed,
		firstAt,
		lastAt,
		sessionId: source.records[0]?.ctx.sessionId ?? reference?.ctx.sessionId ?? null,
		turnId,
		referencedAt: reference?.t ?? null,
		gap: !source.present || source.skipped > 0 || source.damaged > 0 || source.seeding ? 1 : 0,
	};
	runAnalyses.set(source, run);
	return run;
}

/** Fold one record into the growth state; returns the attempts it may have changed. */
function grow(growth: Growth, record: TelemetryRecord): readonly string[] {
	noteMeta(growth.meta, record);
	noteReplay(growth.replays, growth.meta, record);
	if (record.k === "call.started" || record.k === "call.settled") {
		const attempts = growth.callAttempts.get(record.data.callId) ?? new Set<string>();
		attempts.add(record.data.attemptId);
		growth.callAttempts.set(record.data.callId, attempts);
	}
	// A tool settles after the call that asked for it, so its record changes that call's attempts.
	const toolCall = noteTool(growth.tools, record);
	if (toolCall !== null) return [...(growth.callAttempts.get(toolCall) ?? [])];
	if ((record.k === "run.linked" || record.k === "call.linked") && !growth.references.has(record.data.runId))
		growth.references.set(record.data.runId, record);
	if (record.k === "run.enqueued" && record.ctx.turnId && !growth.enqueuedTurns.has(record.data.runId))
		growth.enqueuedTurns.set(record.data.runId, record.ctx.turnId);
	// A mode-filtered or research-cap gap is policy: only research or content kinds go uncaptured, never
	// accountability, so neither makes a total partial (#434, R10).
	if (record.k === "journal.gap" && !POLICY_GAPS.has(record.data.reason)) growth.gapRecord = true;
	return growth.folder.add(record);
}

function settleRuns(analysis: Analysis, runSources: ReadonlyMap<string, JournalSource>, gap: number): void {
	const growth = analysis.growth;
	analysis.gap = gap + (growth.gapRecord ? 1 : 0);
	const runIds = [...new Set([...growth.references.keys(), ...runSources.keys()])].sort();
	const turnOf = (runId: string, seen: Set<string>): string | undefined => {
		const turnId = growth.references.get(runId)?.ctx.turnId ?? growth.enqueuedTurns.get(runId);
		if (turnId !== undefined || seen.has(runId)) return turnId;
		seen.add(runId);
		// A retry or recovery run is enqueued in its own journal, so it inherits the turn that dispatched its parent.
		const parentRunId = runSources.get(runId)?.records.find((record) => record.ctx.parentRunId)?.ctx.parentRunId;
		return parentRunId === undefined ? undefined : turnOf(parentRunId, seen);
	};
	const runs = new Map<string, Run>();
	for (const runId of runIds)
		runs.set(
			runId,
			analyzeRun(runId, runSources.get(runId) ?? unavailable, growth.references.get(runId), turnOf(runId, new Set())),
		);
	analysis.runs = runs;
}

function buildAnalysis(
	sessionId: string,
	head: readonly TelemetryRecord[],
	tail: readonly (readonly TelemetryRecord[])[],
	runSources: ReadonlyMap<string, JournalSource>,
	gap: number,
	parent: SessionSource | null,
): Analysis {
	const growth: Growth = {
		folder: callJournalFolder(undefined, READ_MODEL_FOLD),
		meta: new Map(),
		replays: replayRoutes(),
		tools: new Map(),
		callAttempts: new Map(),
		references: new Map(),
		enqueuedTurns: new Map(),
		gapRecord: false,
		head,
		span: { first: null, last: null, lifecycle: null },
		tail: { records: new Set(), attempts: new Set(), runs: new Set() },
		parent,
	};
	for (const record of head) {
		grow(growth, record);
		noteSpan(growth.span, record);
	}
	for (const segment of tail)
		for (const record of segment) {
			grow(growth, record);
			growth.tail.records.add(record.id);
			if (record.k === "call.started" || record.k === "call.settled") growth.tail.attempts.add(record.data.attemptId);
			if (record.k === "run.linked" || record.k === "call.linked") growth.tail.runs.add(record.data.runId);
		}
	const attempts = growth.folder
		.attempts()
		.map((attempt) => attemptOf(attempt, growth.meta.get(attempt.started.attemptId), growth.tools))
		.sort(byStart);
	const analysis: Analysis = {
		sessionId,
		attempts,
		byAttempt: new Map(attempts.map((attempt) => [attempt.started.attemptId, attempt])),
		fold: { coverage: growth.folder.coverage },
		gap: 0,
		runs: new Map(),
		selections: new Map([["", selectionState(attempts, () => true)]]),
		cache: cacheState(attempts),
		roles: new Map(),
		latestMain: null,
		growth,
	};
	for (const attempt of attempts) noteAttempt(analysis, undefined, attempt);
	settleRuns(analysis, runSources, gap);
	return analysis;
}

/** Move the per-role counts and the main loop's latest call by one attempt changing. */
function noteAttempt(analysis: Analysis, before: Attempt | undefined, after: Attempt | undefined): void {
	const roles = analysis.roles;
	if (before) {
		const count = (roles.get(before.agent.role) ?? 0) - 1;
		if (count > 0) roles.set(before.agent.role, count);
		else roles.delete(before.agent.role);
	}
	if (after) roles.set(after.agent.role, (roles.get(after.agent.role) ?? 0) + 1);
	const latest = analysis.latestMain;
	if (before && before === latest) {
		analysis.latestMain = null;
		// A late tool record replaces the latest call with itself; only a call that stopped qualifying rescans.
		const kept =
			after?.agent.role === "main" &&
			invoked(after) &&
			after.settledAt !== null &&
			after.settledAt >= (before.settledAt ?? "");
		if (!kept) for (const attempt of analysis.attempts) if (attempt !== before) noteLatestMain(analysis, attempt);
	}
	if (after) noteLatestMain(analysis, after);
}

/** The latest settled main call, and of calls settled together the last in the read model's order. */
function noteLatestMain(analysis: Analysis, attempt: Attempt): void {
	const latest = analysis.latestMain;
	if (attempt.agent.role !== "main" || !invoked(attempt) || attempt.settledAt === null) return;
	if (
		!latest ||
		attempt.settledAt > (latest.settledAt ?? "") ||
		(attempt.settledAt === latest.settledAt && byStart(attempt, latest) >= 0)
	)
		analysis.latestMain = attempt;
}

export type LifecycleRecord = Extract<TelemetryRecord, { k: "session.opened" | "session.resumed" | "session.closed" }>;

function noteSpan(span: Growth["span"], record: TelemetryRecord): void {
	if (span.first === null || record.t < span.first) span.first = record.t;
	if (span.last === null || record.t > span.last) span.last = record.t;
	if (
		(record.k === "session.opened" || record.k === "session.resumed" || record.k === "session.closed") &&
		(!span.lifecycle || record.t >= span.lifecycle.t)
	)
		span.lifecycle = record;
}

export function latestLifecycleRecord(records: readonly TelemetryRecord[]): LifecycleRecord | null {
	const span: Growth["span"] = { first: null, last: null, lifecycle: null };
	for (const record of records) noteSpan(span, record);
	return span.lifecycle;
}

/**
 * Fold only what `head` appends to the records the analysis already holds, moving every running selection fold by
 * the attempts those records changed. False, with nothing changed, when `head` does not extend what was folded.
 */
function extendAnalysis(
	analysis: Analysis,
	head: readonly TelemetryRecord[],
	runSources: ReadonlyMap<string, JournalSource>,
	gap: number,
): boolean {
	const growth = analysis.growth;
	const folded = growth.head.length;
	if (head.length < folded) return false;
	for (let index = 0; index < folded; index += 1) if (head[index] !== growth.head[index]) return false;
	const tail = growth.tail;
	for (let index = folded; index < head.length; index += 1) {
		const record = head[index] as TelemetryRecord;
		if (
			tail.records.has(record.id) ||
			((record.k === "call.started" || record.k === "call.settled") && tail.attempts.has(record.data.attemptId)) ||
			((record.k === "run.linked" || record.k === "call.linked") && tail.runs.has(record.data.runId))
		)
			return false;
	}
	const touched = new Set<string>();
	for (let index = folded; index < head.length; index += 1) {
		const record = head[index] as TelemetryRecord;
		for (const attemptId of grow(growth, record)) touched.add(attemptId);
		noteSpan(growth.span, record);
	}
	growth.head = head;
	// A new call can move its route's engine floor, and with it which earlier calls a cold group holds.
	if (touched.size > 0)
		for (const key of analysis.selections.keys()) if (key.startsWith(COLD_SELECTION)) analysis.selections.delete(key);
	for (const attemptId of touched) {
		const before = analysis.byAttempt.get(attemptId);
		const folded = growth.folder.attempt(attemptId);
		const after = folded ? attemptOf(folded, growth.meta.get(attemptId), growth.tools) : undefined;
		if (after) analysis.byAttempt.set(attemptId, after);
		else analysis.byAttempt.delete(attemptId);
		for (const selection of analysis.selections.values()) updateSelection(selection, before, after);
		noteCache(analysis.cache, before, after);
		noteAttempt(analysis, before, after);
	}
	settleRuns(analysis, runSources, gap);
	return true;
}

const readGap = (journal: JournalSource) => (journal.skipped > 0 || journal.damaged > 0 || journal.seeding ? 1 : 0);

/**
 * Analyses keyed by the source they fold. A live source declared a continuation of an analyzed one takes that
 * analysis over and folds only its appended records; the older source re-folds from scratch if it is read again.
 */
const analyses = new WeakMap<SessionSource, Analysis>();
const lineages = new WeakMap<SessionSource, Analysis>();
const continuations = new WeakMap<
	SessionSource,
	{ own: SessionSource | undefined; lineage: SessionSource | undefined }
>();

/**
 * Declare `next` a later read of `previous`: the same session with its own journal grown only by appending, so
 * analyzing it folds just the appended records (#434 §11). The read model verifies the append before relying on it.
 */
export function continueSource(next: SessionSource, previous: SessionSource): void {
	const prior = continuations.get(previous);
	continuations.set(next, {
		own: analyses.has(previous) ? previous : prior?.own,
		lineage: lineages.has(previous) ? previous : prior?.lineage,
	});
}

export function analyze(source: SessionSource): Analysis {
	let analysis = analyses.get(source);
	if (analysis) return analysis;
	const gap = readGap(source.journal);
	const continuation = continuations.get(source);
	const base = continuation?.own;
	const prior = base ? analyses.get(base) : undefined;
	if (
		base &&
		prior &&
		prior.sessionId === source.sessionId &&
		extendAnalysis(prior, source.journal.records, source.runs, gap)
	) {
		analyses.delete(base);
		analysis = prior;
	} else analysis = buildAnalysis(source.sessionId, source.journal.records, [], source.runs, gap, null);
	if (continuation) continuation.own = undefined;
	analyses.set(source, analysis);
	return analysis;
}

/** A child's journal holds only its own calls; ancestors contribute theirs once, deduplicated by the fold (#434). */
export function analyzeLineage(source: SessionSource): Analysis {
	let analysis = lineages.get(source);
	if (analysis) return analysis;
	const tail: (readonly TelemetryRecord[])[] = [];
	const runs = new Map<string, JournalSource>();
	let gap = 0;
	for (let node: SessionSource | null = source, depth = 0; node && depth < 128; depth += 1) {
		const own = analyze(node);
		if (node !== source) tail.push(node.journal.records);
		for (const [runId, run] of own.runs) if (!runs.has(runId)) runs.set(runId, run.source);
		gap += own.gap;
		if (node.parent && !node.parent.source) gap += 1;
		node = node.parent?.source ?? null;
	}
	const parent = source.parent?.source ?? null;
	const continuation = continuations.get(source);
	const base = continuation?.lineage;
	const prior = base ? lineages.get(base) : undefined;
	if (
		base &&
		prior &&
		prior.sessionId === source.sessionId &&
		prior.growth.parent === parent &&
		extendAnalysis(prior, source.journal.records, runs, gap)
	) {
		lineages.delete(base);
		analysis = prior;
	} else analysis = buildAnalysis(source.sessionId, source.journal.records, tail, runs, gap, parent);
	if (continuation) continuation.lineage = undefined;
	lineages.set(source, analysis);
	return analysis;
}

// ---- running selection folds ----

/** A fold over an ordered list that keeps the value before its last item, so the newest attempt settling refolds nothing. */
interface Fold<S> {
	value: S;
	/** The fold of every item but the last; null once a removal left it unknown. */
	previous: S | null;
	readonly empty: () => S;
	readonly add: (state: S, attempt: Attempt) => void;
	readonly copy: (state: S) => S;
}
/** How an edit moved the end of an ordered list; anything else refolds the list. */
type Edit = "append" | "replace-last" | "drop-last" | "other";

/** Lower bound: the first index whose item does not sort before `item`. */
function locate(items: readonly Attempt[], item: Attempt, order: (a: Attempt, b: Attempt) => number): number {
	let low = 0;
	let high = items.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (order(items[mid] as Attempt, item) < 0) low = mid + 1;
		else high = mid;
	}
	return low;
}

function edit(
	items: Attempt[],
	order: (a: Attempt, b: Attempt) => number,
	before: Attempt | undefined,
	after: Attempt | undefined,
): Edit {
	let wasLast = false;
	if (before) {
		const at = locate(items, before, order);
		if (items[at] !== before) {
			// Not where its key says; fall back to identity so the list never keeps a stale attempt.
			const index = items.indexOf(before);
			if (index !== -1) items.splice(index, 1);
			if (after) items.splice(locate(items, after, order), 0, after);
			return "other";
		}
		wasLast = at === items.length - 1;
		items.splice(at, 1);
	}
	if (!after) return wasLast ? "drop-last" : "other";
	const at = locate(items, after, order);
	items.splice(at, 0, after);
	if (at !== items.length - 1) return "other";
	return before === undefined ? "append" : wasLast ? "replace-last" : "other";
}

function refold<S>(fold: Fold<S>, items: readonly Attempt[]): void {
	const state = fold.empty();
	const last = items.length - 1;
	for (let index = 0; index < last; index += 1) fold.add(state, items[index] as Attempt);
	if (last < 0) {
		fold.previous = null;
		fold.value = state;
		return;
	}
	fold.previous = fold.copy(state);
	fold.add(state, items[last] as Attempt);
	fold.value = state;
}

/** Values already handed to a DTO are never mutated: every step folds into a copy. */
function advance<S>(fold: Fold<S>, change: Edit, after: Attempt | undefined, items: readonly Attempt[]): void {
	if (change === "append" && after) {
		const next = fold.copy(fold.value);
		fold.add(next, after);
		fold.previous = fold.value;
		fold.value = next;
	} else if (change === "replace-last" && after && fold.previous) {
		const next = fold.copy(fold.previous);
		fold.add(next, after);
		fold.value = next;
	} else if (change === "drop-last" && fold.previous) {
		fold.value = fold.previous;
		fold.previous = null;
	} else refold(fold, items);
}

const copySum = (sum: FactSum): FactSum => ({ ...sum, coverage: { ...sum.coverage } });
function copyTotals(totals: CallTotals): CallTotals {
	return {
		...totals,
		usage: {
			input: copySum(totals.usage.input),
			output: copySum(totals.usage.output),
			cacheRead: copySum(totals.usage.cacheRead),
			cacheWrite: copySum(totals.usage.cacheWrite),
			cacheWrite1h: copySum(totals.usage.cacheWrite1h),
			reasoning: copySum(totals.usage.reasoning),
		},
		promptTokens: copySum(totals.promptTokens),
		totalTokens: copySum(totals.totalTokens),
		usd: copySum(totals.usd),
	};
}

export type PricedBy = CallSettled["pricing"]["pricedBy"];
export const noPricing = (): Record<PricedBy, number> => ({
	provider: 0,
	"target-rates": 0,
	catalog: 0,
	free: 0,
	none: 0,
});

/**
 * One selection's attempts and their sums, kept current as batches land. The call fold follows attemptId order and
 * per-attempt fact folds follow the read model's order, exactly as a cold fold of the same members would (#434).
 */
interface SelectionState {
	readonly matches: (attempt: Attempt) => boolean;
	readonly members: Attempt[];
	readonly byId: Attempt[];
	readonly calls: Fold<CallTotals>;
	readonly facts: Map<FactMetric, Fold<FactSum>>;
	/** The cached share's parts, folded once a reader asks for them. */
	share: Fold<ShareParts> | null;
	/** Members per call id, for the distinct call count. */
	readonly callIds: Map<string, number>;
	/** Invoked members whose token total is unknown. */
	missing: number;
	/** Invoked members by what priced them. */
	readonly pricedBy: Record<PricedBy, number>;
	totals: CallTotals | null;
}

function tokensUnknown(attempt: Attempt): boolean {
	const totals = emptyCallTotals();
	addCallTotals(totals, attempt.settled);
	return totals.totalTokens.unknownCount > 0;
}

function tallyMember(selection: SelectionState, attempt: Attempt, sign: 1 | -1): void {
	const callId = attempt.started.callId;
	const members = (selection.callIds.get(callId) ?? 0) + sign;
	if (members > 0) selection.callIds.set(callId, members);
	else selection.callIds.delete(callId);
	if (invoked(attempt) && attempt.settled) {
		selection.pricedBy[attempt.settled.pricing.pricedBy] += sign;
		if (tokensUnknown(attempt)) selection.missing += sign;
	}
}

/** `members` must already be in the read model's order; the selection owns the array from here on. */
function selectionState(members: Attempt[], matches: (attempt: Attempt) => boolean): SelectionState {
	const selection: SelectionState = {
		matches,
		members,
		byId: [...members].sort(byAttemptId),
		calls: {
			value: emptyCallTotals(),
			previous: null,
			empty: emptyCallTotals,
			add: (totals, attempt) => addCallTotals(totals, attempt.settled),
			copy: copyTotals,
		},
		facts: new Map(),
		share: null,
		callIds: new Map(),
		missing: 0,
		pricedBy: noPricing(),
		totals: null,
	};
	for (const attempt of members) tallyMember(selection, attempt, 1);
	refold(selection.calls, selection.byId);
	return selection;
}

function updateSelection(selection: SelectionState, before: Attempt | undefined, after: Attempt | undefined): void {
	const leaving = before && selection.matches(before) ? before : undefined;
	const joining = after && selection.matches(after) ? after : undefined;
	if (!leaving && !joining) return;
	if (leaving) tallyMember(selection, leaving, -1);
	if (joining) tallyMember(selection, joining, 1);
	const started = edit(selection.members, byStart, leaving, joining);
	for (const fold of selection.facts.values()) advance(fold, started, joining, selection.members);
	if (selection.share) advance(selection.share, started, joining, selection.members);
	advance(selection.calls, edit(selection.byId, byAttemptId, leaving, joining), joining, selection.byId);
	selection.totals = null;
}

function selectionTotals(selection: SelectionState): CallTotals {
	selection.totals ??= { ...selection.calls.value, logicalCalls: selection.callIds.size };
	return selection.totals;
}

function selectionFacts(selection: SelectionState, metric: FactMetric): FactSum {
	let fold = selection.facts.get(metric);
	if (!fold) {
		fold = {
			value: emptyFactSum(),
			previous: null,
			empty: emptyFactSum,
			add: (sum, attempt) => addGroup(sum, [attemptFact(attempt, metric)]),
			copy: copySum,
		};
		refold(fold, selection.members);
		selection.facts.set(metric, fold);
	}
	return fold.value;
}

function selectionShare(selection: SelectionState): ShareParts {
	if (!selection.share) {
		selection.share = {
			value: emptyShare(),
			previous: null,
			empty: emptyShare,
			add: addShare,
			copy: (parts) => ({ ...parts }),
		};
		refold(selection.share, selection.members);
	}
	return selection.share.value;
}

/**
 * Group selections kept running besides the whole set. Every turn's receipt reads its own `turn` group, so an
 * unbounded cache grew per turn and every new attempt walked all of them.
 */
const SELECTION_CACHE_LIMIT = 64;

export function selectionOf(analysis: Analysis, group: { by: FactGroup; key: string } | undefined): SelectionState {
	const key = group ? `${group.by}\u0000${group.key}` : "";
	const selections = analysis.selections;
	let selection = selections.get(key);
	if (selection) {
		if (key !== "") {
			selections.delete(key);
			selections.set(key, selection);
		}
		return selection;
	}
	const matches = (attempt: Attempt) => (group ? attemptInGroup(attempt, group) : true);
	selection = selectionState(
		group ? groupAttempts(analysis.attempts, group, analysis.cache) : analysis.attempts,
		matches,
	);
	selections.set(key, selection);
	if (selections.size > SELECTION_CACHE_LIMIT + 1)
		for (const oldest of selections.keys())
			if (oldest !== "") {
				selections.delete(oldest);
				break;
			}
	return selection;
}

/** How many selections a source's own analysis keeps running, the whole set included. */
export function runningSelectionsForTesting(source: SessionSource): number {
	return analyze(source).selections.size;
}

export function unreadableAncestors(source: SessionSource): number {
	let count = 0;
	for (let node: SessionSource | null = source, depth = 0; node && depth < 128; depth += 1) {
		if (node.parent && !node.parent.source) count += 1;
		node = node.parent?.source ?? null;
	}
	return count;
}

// ---- selection ----

export const invoked = (attempt: Attempt) => attempt.settled !== null && attempt.settled.disposition !== "never_sent";
export function modelKey(target: CallSettled["target"]): string {
	const model = target.reportedModel.kind === "measured" ? target.reportedModel.value : target.requestedModel;
	return `${target.targetId}/${model}`;
}
export function runModelKey(run: Run): string {
	const target = run.fold.aggregate?.target ?? run.attempts[0]?.settled?.target ?? run.attempts[0]?.started.target;
	return target ? modelKey(target) : "unknown/unknown";
}
export function runTargetKey(run: Run): string {
	return (
		run.fold.aggregate?.target.targetId ??
		run.attempts[0]?.settled?.target.targetId ??
		run.attempts[0]?.started.target.targetId ??
		"unknown"
	);
}
/**
 * A cache break re-prefilled what the cache had served past the shared band: more than 1,024 tokens and a tenth of the
 * previous request's prefix, which is what this call read plus what it prefilled again. A server whose usage omits
 * its read but whose timings measured the uncached prefill read the prompt less that prefill. An unknown re-prefill
 * breaks on a call whose verdict says the cache missed. `partial` also labels an ordinary call that appended a tool
 * result to a warm prefix, and the band absorbs the tokens such an append loses at cache boundaries (#423, #434).
 */
function isBreak(attempt: Attempt): boolean {
	const settled = attempt.settled;
	if (!settled || settled.disposition === "never_sent") return false;
	const re = settled.cache.rePrefilledTokens;
	if (re.kind === "measured" || re.kind === "estimated") {
		const known = (fact: Fact<number> | undefined) =>
			fact && (fact.kind === "measured" || fact.kind === "estimated") ? fact.value : null;
		const prompt = known(settled.usage?.input);
		const uncached = known(settled.cache.uncachedPrefillTokens);
		const served =
			known(settled.usage?.cacheRead) ?? (prompt !== null && uncached !== null ? Math.max(0, prompt - uncached) : 0);
		return cacheBreakLoss(re.value, served + re.value);
	}
	return re.kind === "unknown" && (settled.cache.verdict === "cold" || settled.cache.verdict === "partial");
}
export function coldKeys(attempt: Attempt): string[] {
	const reasons = attempt.settled?.cache.expectedColdReasons ?? [];
	if (reasons.length > 0) return [...new Set(reasons)];
	return [attempt.replay === null ? "unattributed" : "replay_mismatch"];
}

/** The journaled divergence, or a replay's when the process had no earlier request to compare against. */
export function divergence(attempt: Attempt): Fact<string | null> {
	const fact = attempt.settled?.cache.firstDivergentSection ?? unobserved;
	return attempt.replay !== null && fact.kind === "unknown"
		? { kind: "measured", value: attempt.replay, source: "local-count" }
		: fact;
}

const COLD_SELECTION = "cold\u0000";

/** A group's attempts; a cold group holds breaks only, so a call that hit its route's engine floor is in none. */
function groupAttempts(
	attempts: readonly Attempt[],
	group: { by: FactGroup; key: string },
	cache?: CacheState,
): Attempt[] {
	if (group.by !== "cold") return attempts.filter((attempt) => attemptInGroup(attempt, group));
	return cacheBreaks(cache ?? cacheState(attempts)).filter((attempt) => coldKeys(attempt).includes(group.key));
}

function attemptInGroup(attempt: Attempt, group: { by: FactGroup; key: string }): boolean {
	const settled = attempt.settled;
	switch (group.by) {
		case "role":
			return attempt.agent.role === group.key;
		case "model":
			return modelKey(settled?.target ?? attempt.started.target) === group.key;
		case "target":
			return (settled?.target ?? attempt.started.target).targetId === group.key;
		case "session":
			return attempt.ctx?.sessionId === group.key;
		case "turn":
			return (attempt.ctx?.turnId ?? "-") === group.key;
		case "cause":
			return settled?.stop.failure === group.key;
		case "wait":
			return settled?.stages.admission?.waitedOn === group.key;
		case "cold":
			return isBreak(attempt) && coldKeys(attempt).includes(group.key);
		case "run":
		case "category":
		case "turns":
			return false;
	}
}
function runInGroup(run: Run, group: { by: FactGroup; key: string }): boolean {
	switch (group.by) {
		case "role":
			return group.key === "worker";
		case "model":
			return runModelKey(run) === group.key;
		case "target":
			return runTargetKey(run) === group.key;
		case "session":
			return run.sessionId === group.key;
		case "turn":
			return (run.turnId ?? "-") === group.key;
		case "run":
			return run.runId === group.key;
		default:
			return false;
	}
}

export interface Part {
	attempts?: Attempt[];
	/** The running fold `attempts` belong to, when the selection keeps one. */
	selection?: SelectionState;
	run?: Run;
	gap: number;
}
interface Selection {
	parts: Part[];
	attempt?: Attempt;
	describe: string;
}

export type View = { session: SessionSource } | { run: Run } | { repo: RepoSource } | { process: Run };
/** An absent run journal is already one unknown contribution; a damaged one adds its own. */
export const runGap = (run: Run) => (run.source.present ? run.gap : 0);

/** A run that reported one aggregate and journaled no call of its own, as an ACP delegation does. */
export const reportsAggregateOnly = (run: Run) => run.fold.source === "aggregate" && run.attempts.length === 0;

function groupedRunParts(run: Run, group: { by: FactGroup; key: string } | undefined): Part[] {
	if (group && (group.by === "model" || group.by === "target") && run.fold.source === "calls") {
		const attempts = run.attempts.filter((attempt) => attemptInGroup(attempt, group));
		return attempts.length || runGap(run) > 0 ? [{ attempts, gap: runGap(run) }] : [];
	}
	return !group || runInGroup(run, group) ? [{ run, gap: runGap(run) }] : [];
}

export function select(view: View, ref: ParsedFactRef): Selection | null {
	const group = ref.group;
	if ("repo" in view)
		return (ref.scope === "repo" || ref.scope === "own" || ref.scope === "runs") &&
			view.repo.owner === ref.owner &&
			!ref.attemptId
			? selectRepo(view.repo, group, ref.scope)
			: null;
	if (ref.scope === "repo") return null;
	// A process journal folds as a run's does: its calls are whole attempts with no session to split them by (#434).
	if ("process" in view || ref.scope === "process") {
		if (!("process" in view) || ref.scope !== "process" || view.process.runId !== ref.owner) return null;
		const owned = view.process;
		if (ref.attemptId) {
			const attempt = owned.byAttempt.get(ref.attemptId);
			return attempt ? { parts: [{ attempts: [attempt], gap: 0 }], attempt, describe: "one process attempt" } : null;
		}
		const attempts = group ? groupAttempts(owned.attempts, group) : owned.attempts;
		return {
			parts: [{ attempts, gap: owned.gap }],
			describe: `the process journal's attempts${group ? ` where ${group.by}=${group.key}` : ""}`,
		};
	}
	if (ref.scope === "run") {
		const run =
			"run" in view ? (view.run.runId === ref.owner ? view.run : undefined) : analyze(view.session).runs.get(ref.owner);
		if (!run) return null;
		if (ref.attemptId) {
			const attempt = run.byAttempt.get(ref.attemptId);
			return attempt ? { parts: [{ attempts: [attempt], gap: 0 }], attempt, describe: "one run attempt" } : null;
		}
		if (!group || (group.by === "role" && group.key === "worker"))
			return { parts: [{ run, gap: runGap(run) }], describe: "the run's journal fold (calls, or its reported aggregate)" };
		// An aggregate-only run is one contribution: it falls wholly in the group its reported target names, as a
		// session's report places it (#434).
		if (reportsAggregateOnly(run))
			return {
				parts: groupedRunParts(run, group),
				describe: `the run's reported aggregate where ${group.by}=${group.key}`,
			};
		// An aggregate over calls of its own, or a conflicting one, cannot be split by group; its share stays unknown (#434).
		const aggregate = run.fold.source === "calls" ? 0 : 1;
		return {
			parts: [{ attempts: groupAttempts(run.attempts, group), gap: run.gap + aggregate }],
			describe: `the run's attempts where ${group.by}=${group.key}`,
		};
	}
	if ("run" in view) return null;
	if (view.session.sessionId !== ref.owner) return null;
	const analysis = ref.scope === "lineage" ? analyzeLineage(view.session) : analyze(view.session);
	if (ref.attemptId) {
		if (ref.scope !== "own" && ref.scope !== "lineage") return null;
		const attempt = analysis.byAttempt.get(ref.attemptId);
		return attempt ? { parts: [{ attempts: [attempt], gap: 0 }], attempt, describe: "one attempt" } : null;
	}
	if (group?.by === "turns") {
		const keys = new Set(group.key === "-" ? [] : group.key.split(","));
		const parts: Part[] = [...keys].map((key) => {
			const selection = selectionOf(analysis, { by: "turn", key });
			return { attempts: selection.members, selection, gap: 0 };
		});
		if (parts[0]) parts[0].gap = analysis.gap;
		for (const run of analysis.runs.values()) if (keys.has(run.turnId ?? "-")) parts.push({ run, gap: runGap(run) });
		return { parts, describe: "the prompt's operator turns and referenced runs" };
	}
	const parts: Part[] = [];
	const described: string[] = [];
	if (ref.scope !== "runs") {
		const selection = selectionOf(analysis, group);
		parts.push({ attempts: selection.members, selection, gap: analysis.gap });
		described.push(`${ref.scope === "lineage" ? "the lineage's" : "the session's own"} attempts`);
	}
	if (ref.scope !== "own") {
		for (const run of analysis.runs.values()) parts.push(...groupedRunParts(run, group));
		described.push("each referenced run's journal fold");
	}
	return {
		parts,
		describe: `${described.join(" + ")}${group ? ` where ${group.by}=${group.key}` : ""}`,
	};
}

/**
 * Each session's own attempts and its runs, a run two sessions reference counted once, then the scope's own runs.
 * `own` keeps only the sessions' attempts and `runs` only the runs, the window's session and worker audiences.
 */
export function selectRepo(
	repo: RepoSource,
	group: { by: FactGroup; key: string } | undefined,
	scope: "repo" | "own" | "runs",
): Selection {
	if (group?.by === "session") {
		return selectRepo(
			{
				...repo,
				sessions: repo.sessions.filter((session) => session.sessionId === group.key),
				runs: new Map([...repo.runs].filter(([id, source]) => analyzeRun(id, source).sessionId === group.key)),
			},
			undefined,
			scope,
		);
	}
	const parts: Part[] = [];
	const counted = new Set<string>();
	const addRun = (run: Run) => {
		if (scope === "own" || counted.has(run.runId)) return;
		counted.add(run.runId);
		parts.push(...groupedRunParts(run, group));
	};
	for (const session of repo.sessions) {
		const analysis = analyze(session);
		if (scope !== "runs") {
			const selection = selectionOf(analysis, group);
			parts.push({ attempts: selection.members, selection, gap: analysis.gap });
		}
		for (const run of analysis.runs.values()) addRun(run);
	}
	if (scope !== "own")
		for (const [runId, source] of [...repo.runs].sort(([a], [b]) => a.localeCompare(b)))
			addRun(analyzeRun(runId, source));
	const described = [
		...(scope !== "runs" ? [`${renderCount(repo.sessions.length)} sessions' attempts`] : []),
		...(scope !== "own" ? ["each run's journal fold"] : []),
	];
	return { parts, describe: `${described.join(" + ")}${group ? ` where ${group.by}=${group.key}` : ""}` };
}

// ---- measurement ----

type Family = "count" | "usd" | "duration" | "percent";
const FAMILY: Record<FactMetric, Family> = {
	calls: "count",
	attempts: "count",
	neverSent: "count",
	sentUnsettled: "count",
	settledNoUsage: "count",
	settled: "count",
	incomplete: "count",
	input: "count",
	output: "count",
	cacheRead: "count",
	cacheWrite: "count",
	cacheWrite1h: "count",
	reasoning: "count",
	prompt: "count",
	total: "count",
	usd: "usd",
	apiCalls: "count",
	unmeteredCalls: "count",
	ttft: "duration",
	firstToken: "duration",
	modelTime: "duration",
	settle: "duration",
	admissionWait: "duration",
	requestBytes: "count",
	websocketFailures: "count",
	sseFallbacks: "count",
	rePrefilled: "count",
	uncachedPrefill: "count",
	breakUsd: "usd",
	repairRounds: "count",
	runs: "count",
	contextUsed: "count",
	contextWindow: "count",
	contextFree: "count",
	contextReserve: "count",
	contextShare: "percent",
	contextTokens: "count",
	runRecords: "count",
	toolCalls: "count",
	toolErrors: "count",
	harnessShare: "percent",
	callShare: "percent",
	cacheShare: "percent",
	harnessTime: "duration",
	networkTime: "duration",
	toolTime: "duration",
	bookkeepingRounds: "count",
	roundTripTax: "count",
};
const RULES: Record<FactMetric, string> = {
	contextUsed: "latest context snapshot (reconciledTokens or estimatedTokens) + categories.streaming",
	contextWindow: "latest context snapshot effective window",
	contextFree: "latest context snapshot free tokens",
	contextReserve: "latest context snapshot reserve tokens",
	contextShare: "100 × context tokens / effective window",
	contextTokens: "latest context snapshot category tokens",
	runRecords: "sealed evidence run records",
	toolCalls: "sealed evidence tool calls",
	toolErrors: "sealed evidence tool errors",
	harnessShare: "100 × harnessTime / (harnessTime + networkTime + modelTime + toolTime), main-loop calls only",
	callShare: "100 × group calls / whole-scope calls; unknown when model groups overlap",
	cacheShare:
		"100 × cache-read tokens / prompt tokens of the sent calls; ≥ while a call's read went unreported, ~ when a read was derived from the uncached prefill",
	calls: "count(distinct callId); a run contributes its API calls",
	attempts: "count(attempts)",
	neverSent: "count(attempts where disposition=never_sent)",
	sentUnsettled: "count(attempts where disposition=sent_unsettled)",
	settledNoUsage: "count(attempts where disposition=settled_no_usage)",
	settled: "count(attempts where disposition=settled)",
	incomplete: "count(attempts with no trustworthy settlement)",
	input: "sum(usage.input)",
	output: "sum(usage.output), reasoning included",
	cacheRead: "sum(usage.cacheRead)",
	cacheWrite: "sum(usage.cacheWrite)",
	cacheWrite1h: "sum(usage.cacheWrite1h), a cacheWrite subfield",
	reasoning: "sum(usage.reasoning), already inside output",
	prompt: "sum(usage.input + usage.cacheRead + usage.cacheWrite)",
	total: "sum(usage.total where reported, else input + cacheRead + cacheWrite + output)",
	usd: "sum(pricing.usd)",
	apiCalls: "count(attempts that reached the provider)",
	unmeteredCalls: "count(sent attempts whose token usage is unknown)",
	ttft: "stages.firstToken − stages.send.end, per attempt",
	firstToken:
		"ttft of the earliest attempt that measured or estimated one (for a prompt, among its main-agent responses), so a failed attempt before it never hides it",
	modelTime: "stages.settle − stages.firstToken, per attempt",
	settle: "stages.settle, per attempt",
	admissionWait: "stages.admission.end − stages.admission.start, per attempt",
	requestBytes: "transport.requestBytes",
	websocketFailures: "transport.websocketFailures, where the call's connection counters were attributable",
	sseFallbacks: "transport.sseFallbacks, where the call's connection counters were attributable",
	rePrefilled: "cache.rePrefilledTokens (each an upper bound on what the call prefilled again)",
	uncachedPrefill: "cache.uncachedPrefillTokens",
	breakUsd:
		"rePrefilledTokens × (input rate − cache-read rate), as each call records it (an upper bound, like rePrefilledTokens)",
	repairRounds: "run.settled.repairRounds",
	runs: "count(referenced runs)",
	harnessTime: "stages.send.start − (stages.admission.end − stages.admission.start): PanCode's own work before sending",
	networkTime: "(stages.connect.end − stages.connect.start) + (stages.firstByte − stages.send.end)",
	toolTime: "sum(tool.settled.durationMs) over the tools the call asked for, approval parks excluded",
	bookkeepingRounds: `count(main attempts whose every tool was ${[...BOOKKEEPING_TOOLS].join(" or ")})`,
	roundTripTax: `sum(prompt tokens of main attempts whose every tool was ${[...BOOKKEEPING_TOOLS].join(" or ")})`,
};
const USAGE_FIELDS = new Set<FactMetric>(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning"]);
/** Metrics one attempt states as a single fact; the rest are folds even over one attempt (prompt, total, counts). */
const ATTEMPT_FACTS = new Set<FactMetric>([
	...USAGE_FIELDS,
	"usd",
	"ttft",
	"modelTime",
	"settle",
	"admissionWait",
	"requestBytes",
	"websocketFailures",
	"sseFallbacks",
	"rePrefilled",
	"uncachedPrefill",
	"breakUsd",
	"harnessTime",
	"networkTime",
	"toolTime",
	"bookkeepingRounds",
	"roundTripTax",
]);

/** One attempt's own fact for a per-attempt metric; never_sent reached nothing, so it is not applicable (R2). */
export function attemptFact(attempt: Attempt, metric: FactMetric): Fact<number> {
	const settled = attempt.settled;
	if (metric === "admissionWait") {
		const admission = settled?.stages.admission;
		return admission ? localClock(admission.end - admission.start) : unobserved;
	}
	if (settled?.disposition === "never_sent") return notApplicable;
	if (!settled) return unobserved;
	if (USAGE_FIELDS.has(metric)) return settled.usage?.[metric as keyof CallUsage] ?? unobserved;
	const stages = settled.stages;
	const noFirstToken = settled.disposition === "settled" ? unobserved : notApplicable;
	switch (metric) {
		case "usd":
			return settled.pricing.usd;
		case "ttft":
			if (stages.settle === null || !stages.send) return unobserved;
			return stages.firstToken === undefined ? noFirstToken : localClock(Math.max(0, stages.firstToken - stages.send.end));
		case "modelTime":
			if (stages.settle === null) return unobserved;
			return stages.firstToken === undefined ? noFirstToken : localClock(Math.max(0, stages.settle - stages.firstToken));
		case "settle":
			return stages.settle === null ? unobserved : localClock(stages.settle);
		case "requestBytes":
			return settled.transport.requestBytes;
		case "websocketFailures":
			return settled.transport.websocketFailures ?? unobserved;
		case "sseFallbacks":
			return settled.transport.sseFallbacks ?? unobserved;
		case "rePrefilled":
			return settled.cache.rePrefilledTokens;
		case "uncachedPrefill":
			return settled.cache.uncachedPrefillTokens;
		case "breakUsd":
			// Fixed at settle from the call's own rates; a call settled before cache physics has none (#434 P2.4).
			return settled.cache.bill?.usd ?? unobserved;
		case "harnessTime": {
			if (!stages.send) return unobserved;
			const held = stages.admission ? stages.admission.end - stages.admission.start : 0;
			return localClock(Math.max(0, stages.send.start - held));
		}
		case "networkTime":
			// Pi owns the provider socket, so a call that recorded no connect span cannot split network from the wait for
			// the model (option B, #434).
			if (!stages.connect || stages.firstByte === undefined || !stages.send)
				return { kind: "unknown", reason: "unsupported" };
			return localClock(stages.connect.end - stages.connect.start + Math.max(0, stages.firstByte - stages.send.end));
		case "toolTime":
			if (settled.stop.reason !== "toolUse") return localClock(0);
			return attempt.tools ? localClock(attempt.tools.durationMs) : unobserved;
		case "bookkeepingRounds":
		case "roundTripTax":
			return roundTrip(attempt, metric);
		default:
			return unobserved;
	}
}

/**
 * A main-loop round whose every tool was bookkeeping re-read its whole context for no work on the task (#434 §12.4).
 * A round that asked for no tool is no such round; one whose tools went unrecorded is unknown.
 */
function roundTrip(attempt: Attempt, metric: "bookkeepingRounds" | "roundTripTax"): Fact<number> {
	const settled = attempt.settled;
	if (attempt.agent.role !== "main" || !settled) return notApplicable;
	if (settled.stop.reason !== "toolUse") return localCount(0);
	if (!attempt.tools) return unobserved;
	if (!attempt.tools.bookkeepingOnly) return localCount(0);
	if (metric === "bookkeepingRounds") return localCount(1);
	const totals = emptyCallTotals();
	addCallTotals(totals, settled);
	const prompt = totals.promptTokens;
	if (prompt.unknownCount > 0) return unobserved;
	if (prompt.coverage.estimated === 0) return { kind: "measured", value: prompt.measured, source: "provider" };
	// The prompt is estimated by the method its estimated counts name (R3).
	const usage = settled.usage;
	const method = [usage?.input, usage?.cacheRead, usage?.cacheWrite].find((fact) => fact?.kind === "estimated");
	return method?.kind === "estimated"
		? { kind: "estimated", value: prompt.measured + prompt.estimated, method: method.method }
		: unobserved;
}

function attemptsSum(attempts: readonly Attempt[], metric: FactMetric): FactSum {
	return callSum(
		() => foldCalls(attempts),
		metric,
		() => foldCalls(attempts.filter(invoked)).totalTokens.unknownCount,
		() => sumFacts(attempts.map((attempt) => attemptFact(attempt, metric))),
	);
}

function selectionSum(selection: SelectionState, metric: FactMetric): FactSum {
	return callSum(
		() => selectionTotals(selection),
		metric,
		() => selection.missing,
		() => selectionFacts(selection, metric),
	);
}

function callSum(totals: () => CallTotals, metric: FactMetric, missing: () => number, facts: () => FactSum): FactSum {
	switch (metric) {
		case "calls":
			return counted(totals().logicalCalls);
		case "attempts":
			return counted(totals().attempts);
		case "neverSent":
		case "sentUnsettled":
		case "settledNoUsage":
		case "settled":
		case "incomplete":
			return counted(totals()[metric]);
		case "input":
		case "output":
		case "cacheRead":
		case "cacheWrite":
		case "cacheWrite1h":
		case "reasoning":
			return totals().usage[metric];
		case "prompt":
			return totals().promptTokens;
		case "total":
			return totals().totalTokens;
		case "usd":
			return totals().usd;
		case "apiCalls": {
			const all = totals();
			return counted(all.settled + all.settledNoUsage + all.sentUnsettled);
		}
		case "unmeteredCalls":
			return counted(missing());
		case "runs":
			return counted(0);
		case "repairRounds":
			return sumFacts([]);
		default:
			return facts();
	}
}

function runSum(run: Run, metric: FactMetric): FactSum {
	if (!run.source.present) return unknownSum(1);
	const fold = run.fold;
	const aggregateOnly = fold.source !== "calls";
	const counts = (value: number) => (aggregateOnly ? sumFactSums([counted(value), unknownSum(1)]) : counted(value));
	switch (metric) {
		case "input":
		case "output":
		case "cacheRead":
		case "cacheWrite":
		case "cacheWrite1h":
		case "reasoning":
			return fold.usage[metric];
		case "prompt":
			// An aggregate states its input and cache parts, so its prompt is their lower bound as its total is (#434).
			return aggregateOnly
				? componentSubtotal([fold.usage.input, fold.usage.cacheRead, fold.usage.cacheWrite])
				: fold.calls.totals.promptTokens;
		case "total":
			return fold.totalTokens;
		case "usd":
			return fold.usd;
		case "calls":
		case "apiCalls":
			return fold.apiCalls;
		case "unmeteredCalls":
			return fold.unmeteredCalls;
		case "attempts":
			return counts(fold.calls.totals.attempts);
		case "neverSent":
		case "sentUnsettled":
		case "settledNoUsage":
		case "settled":
		case "incomplete":
			return counts(fold.calls.totals[metric]);
		case "runs":
			return counted(1);
		case "repairRounds":
			return run.settled ? sumFacts([run.settled.data.repairRounds]) : unknownSum(1);
		default:
			return sumFacts(run.attempts.map((attempt) => attemptFact(attempt, metric)));
	}
}

function withGap(sum: FactSum, gap: number): FactSum {
	return gap > 0 ? sumFactSums([sum, unknownSum(gap)]) : sum;
}

/** A free price is a measured local zero; one priced contribution elsewhere makes the claim a dollar claim. */
function allFree(parts: readonly Part[]): boolean {
	let any = false;
	for (const part of parts) {
		if (part.run) {
			if (!part.run.source.present) return false;
			if (part.run.fold.allKnownFree) any = true;
			else if (
				part.run.fold.usd.coverage.measured + part.run.fold.usd.coverage.estimated + part.run.fold.usd.unknownCount >
				0
			)
				return false;
		}
		if (part.selection) {
			const counts = part.selection.pricedBy;
			const free = counts.free;
			if (counts.provider + counts["target-rates"] + counts.catalog + counts.none > 0) return false;
			if (free > 0) any = true;
			continue;
		}
		for (const attempt of part.attempts ?? []) {
			if (!invoked(attempt)) continue;
			if (attempt.settled?.pricing.pricedBy !== "free") return false;
			any = true;
		}
	}
	return any;
}

/** The free-rule agreement across every priced contribution of the parts, which a free cost's wording names. */
function partsFreeRule(parts: readonly Part[]): FreeRuleAgreement {
	const pricings: Array<Pick<Pricing, "pricedBy" | "freeRule">> = [];
	const add = (attempts: readonly Attempt[]) => {
		for (const attempt of attempts) if (invoked(attempt) && attempt.settled) pricings.push(attempt.settled.pricing);
	};
	for (const part of parts) {
		if (part.run) {
			if (part.run.fold.source === "aggregate") {
				const pricing = part.run.fold.aggregate?.pricing ?? part.run.settled?.data.pricing;
				if (pricing) pricings.push(pricing);
			} else if (part.run.fold.source === "parts") {
				const latestByPart = new Map<string, TelemetryRecord<"run.usage_reported">["data"]>();
				for (const record of part.run.source.records) {
					if (record.k !== "run.usage_reported" || record.data.partId === undefined) continue;
					const prior = latestByPart.get(record.data.partId);
					if (!prior || record.data.revision >= prior.revision) latestByPart.set(record.data.partId, record.data);
				}
				for (const entry of latestByPart.values()) pricings.push(entry.pricing);
			} else {
				add(part.run.attempts);
			}
		}
		add(part.attempts ?? []);
	}
	return freeRuleAgreement(pricings);
}

function display(
	metric: FactMetric,
	fact: Fact<number> | FactSum,
	free: boolean,
	pricedBy = "none",
	freeRule?: FreeRule,
	freeRuleMixed?: boolean,
): string {
	const family = FAMILY[metric];
	if ("kind" in fact) {
		if (family === "usd") return renderUsdFact(fact, pricedBy, freeRule);
		return renderFact(fact, family === "duration" ? "duration" : family === "percent" ? "percent" : "count");
	}
	if (family === "usd") return renderUsdSum(fact, free, freeRule, freeRuleMixed);
	if (family === "duration") return renderDurationSum(fact);
	if (family === "percent") return renderShareSum(fact);
	return renderCountSum(fact);
}

interface Measurement {
	quantity: Quantity;
	selection: Selection;
}

const latestContexts = new WeakMap<
	SessionSource,
	{ length: number; record: TelemetryRecord<"context.snapshotted"> | null }
>();
export function latestContext(source: SessionSource): TelemetryRecord<"context.snapshotted"> | null {
	const cached = latestContexts.get(source);
	if (cached?.length === source.journal.records.length) return cached.record;
	let latest: TelemetryRecord<"context.snapshotted"> | null = null;
	for (let index = source.journal.records.length - 1; index >= 0; index--) {
		const record = source.journal.records[index];
		if (record?.k === "context.snapshotted") {
			latest = record;
			break;
		}
	}
	latestContexts.set(source, { length: source.journal.records.length, record: latest });
	return latest;
}

function measure(view: View, ref: ParsedFactRef): Measurement | null {
	// A prompt's first token is its first main-agent response; other scopes take the earliest attempt below (#434).
	if (ref.metric === "firstToken" && "session" in view && ref.scope === "session") {
		if (ref.owner !== view.session.sessionId || ref.attemptId) return null;
		if (ref.group && ref.group.by !== "turns" && ref.group.by !== "turn") return null;
		const analysis = analyze(view.session);
		const turns = ref.group?.by === "turns" ? new Set(ref.group.key === "-" ? [] : ref.group.key.split(",")) : null;
		const first = analysis.attempts.find(
			(attempt) =>
				attempt.agent.role === "main" &&
				(turns ? turns.has(attempt.ctx?.turnId ?? "-") : !ref.group || attemptInGroup(attempt, ref.group)) &&
				(attempt.settled?.disposition === "settled" ||
					attempt.settled?.disposition === "settled_no_usage" ||
					attempt.settled?.stages.firstToken !== undefined),
		);
		// A missing earlier record could own the first response, so a journal gap cannot establish this fact (#434).
		const fact: Fact<number> =
			analysis.gap > 0 ? { kind: "unknown", reason: "writer-gap" } : first ? attemptFact(first, "ttft") : unobserved;
		return {
			quantity: { fact, display: display(ref.metric, fact, false), ref: factRef(ref) },
			selection: {
				parts: [{ attempts: first ? [first] : [], gap: analysis.gap }],
				describe: "the prompt's first main-agent response, excluding follow-up calls and worker runs",
			},
		};
	}
	if (ref.scope === "context") {
		if (
			!["contextUsed", "contextWindow", "contextFree", "contextReserve", "contextShare", "contextTokens"].includes(
				ref.metric,
			)
		)
			return null;
		if (!("session" in view) || view.session.sessionId !== ref.owner) return null;
		const snapshot = latestContext(view.session);
		const data = snapshot?.k === "context.snapshotted" ? snapshot.data : null;
		const category = ref.group?.by === "category" ? ref.group.key : null;
		const promptTokens = data?.reconciledTokens ?? data?.estimatedTokens;
		const tokens = data
			? category
				? data.categories[category as keyof typeof data.categories]
				: promptTokens === undefined
					? undefined
					: promptTokens + data.categories.streaming
			: undefined;
		const value = !data
			? undefined
			: ref.metric === "contextWindow"
				? data.window.effective
				: ref.metric === "contextFree"
					? data.categories.free
					: ref.metric === "contextReserve"
						? data.categories.reserve
						: ref.metric === "contextShare"
							? tokens === undefined || data.window.effective <= 0
								? undefined
								: (100 * tokens) / data.window.effective
							: tokens;
		const measured =
			data?.reconciledTokens !== undefined &&
			category === null &&
			(ref.metric === "contextUsed" || ref.metric === "contextShare");
		const fact: Fact<number> =
			value === undefined
				? unobserved
				: ref.metric === "contextWindow"
					? localCount(value)
					: measured && !category
						? { kind: "measured", value, source: "provider" }
						: { kind: "estimated", value, method: "chars/4" };
		return {
			quantity: {
				fact,
				display: renderFact(fact, ref.metric === "contextShare" ? "percent" : "count"),
				ref: factRef(ref),
			},
			selection: { parts: [], describe: "the latest journaled context snapshot" },
		};
	}

	if (ref.metric === "cacheShare") {
		const selection = select(view, ref);
		if (!selection) return null;
		const fact = shareFact(selectedShare(selection));
		return { quantity: { fact, display: display(ref.metric, fact, false), ref: factRef(ref) }, selection };
	}

	if (ref.metric === "harnessShare" || ref.metric === "callShare") {
		const base = ref.metric === "harnessShare" ? { ...ref, group: { by: "role" as const, key: "main" } } : ref;
		const selection = select(view, base);
		if (!selection) return null;
		const read = (metric: FactMetric, group = base.group) =>
			measure(view, { ...base, metric, ...(group ? { group } : {}) })?.quantity;
		const exact = (q: Quantity | undefined): number | null => {
			if (!q) return null;
			const f = q.fact;
			if ("kind" in f) return f.kind === "measured" ? f.value : null;
			return f.unknownCount === 0 && f.coverage.estimated === 0 ? f.measured : null;
		};
		let value: number | null = null;
		if (ref.metric === "harnessShare") {
			const values = ["harnessTime", "networkTime", "modelTime", "toolTime"].map((metric) =>
				exact(read(metric as FactMetric)),
			);
			if (values.every((part) => part !== null)) {
				const total = values.reduce<number>((sum, part) => sum + (part ?? 0), 0);
				if (total > 0) value = (100 * (values[0] ?? 0)) / total;
			}
		} else {
			const numerator = exact(read("calls"));
			const wholeRef = { ...ref, metric: "calls" as const };
			delete wholeRef.group;
			const denominator = exact(measure(view, wholeRef)?.quantity);
			// A call can fail over between models; overlapping groups do not partition a pie (#434).
			const groupParts = ref.group?.by === "model" || ref.group?.by === "target" ? selection.parts : [];
			const selectedIds = new Set(
				groupParts.flatMap((part) => part.attempts ?? part.run?.attempts ?? []).map((attempt) => attempt.started.callId),
			);
			const all = select(view, wholeRef);
			const outside = all?.parts
				.flatMap((part) => part.attempts ?? part.run?.attempts ?? [])
				.some(
					(attempt) =>
						selectedIds.has(attempt.started.callId) && ref.group !== undefined && !attemptInGroup(attempt, ref.group),
				);
			if (!outside && numerator !== null && denominator !== null && denominator > 0)
				value = (100 * numerator) / denominator;
		}
		const fact: Fact<number> = value === null ? { kind: "unknown", reason: "not-observed" } : localCount(value);
		return { quantity: { fact, display: renderFact(fact, "percent"), ref: factRef(ref) }, selection };
	}

	const selection = select(view, ref);
	if (!selection) return null;
	const encoded = factRef(ref);
	if (ref.metric === "firstToken") {
		const fact = firstTokenFact(
			selection.attempt
				? [selection.attempt]
				: selection.parts.flatMap((part) => part.attempts ?? part.run?.attempts ?? []),
		);
		return { quantity: { fact, display: display("ttft", fact, false), ref: encoded }, selection };
	}
	const attempt = selection.attempt;
	if (attempt) {
		const metric = ref.metric;
		const fact: Fact<number> | FactSum = ATTEMPT_FACTS.has(metric)
			? attemptFact(attempt, metric)
			: attemptsSum([attempt], metric);
		// A cache-break bill names the rates it was priced by, which a free call's local zero depends on.
		const priced = metric === "breakUsd" ? attempt.settled?.cache.bill : attempt.settled?.pricing;
		const pricedBy = priced?.pricedBy;
		return {
			quantity: { fact, display: display(metric, fact, pricedBy === "free", pricedBy, priced?.freeRule), ref: encoded },
			selection,
		};
	}
	const sums = selection.parts.map((part) => partSum(part, ref.metric));
	const fact = sums.length === 1 && sums[0] ? sums[0] : sumFactSums(sums);
	const free = allFree(selection.parts);
	const agreement = free ? partsFreeRule(selection.parts) : undefined;
	return {
		quantity: {
			fact,
			display: display(ref.metric, fact, free, "none", agreement?.rule, agreement?.mixed),
			ref: encoded,
		},
		selection,
	};
}

/**
 * The first generated token of a selection: the TTFT of its earliest attempt that has one. A retry after a failed
 * request still shows when the work first produced output (#434).
 */
function firstTokenFact(attempts: readonly Attempt[]): Fact<number> {
	const ordered = [...attempts].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
	for (const attempt of ordered) {
		const fact = attemptFact(attempt, "ttft");
		if (fact.kind === "measured" || fact.kind === "estimated") return fact;
	}
	return unobserved;
}

function partSum(part: Part, metric: FactMetric): FactSum {
	return withGap(
		part.run
			? runSum(part.run, metric)
			: part.selection
				? selectionSum(part.selection, metric)
				: attemptsSum(part.attempts ?? [], metric),
		part.gap,
	);
}

/** Several turns read as one; see {@link turnsSum}. */
export interface TurnsSum {
	fact: FactSum;
	display: string;
	/** Every priced call among the turns was free, which the cost display's free claim rests on. */
	free: boolean;
	/** The free rule every one of those calls states, when they agree. */
	freeRule?: FreeRule;
	/** True only when two or more different recorded free rules appeared among the turns. */
	freeRuleMixed?: boolean;
}

/**
 * Several of a session's operator turns read as one, such as the turns one ACP prompt ran: each turn's own attempts
 * and the runs it referenced, the session's read gap counted once. One turn sums exactly as its `@turn=` quantity
 * does. Prompt quantities name this same selection with the `turns` group (#434 §11.3).
 */
export function turnsSum(source: SessionSource, turnIds: readonly string[], metric: FactMetric): TurnsSum {
	const analysis = analyze(source);
	const keys = new Set(turnIds);
	const parts: Part[] = [];
	for (const key of keys) {
		const selection = selectionOf(analysis, { by: "turn", key });
		parts.push({ attempts: selection.members, selection, gap: 0 });
	}
	for (const run of analysis.runs.values()) if (keys.has(run.turnId ?? "-")) parts.push({ run, gap: runGap(run) });
	const fact = withGap(sumFactSums(parts.map((part) => partSum(part, metric))), keys.size > 0 ? analysis.gap : 0);
	const free = allFree(parts);
	const agreement = free ? partsFreeRule(parts) : undefined;
	return {
		fact,
		display: display(metric, fact, free, "none", agreement?.rule, agreement?.mixed),
		...freeClaim(free, agreement),
	};
}

/**
 * Some of a session's attempts read as one, such as the calls one agent segment of a headless run made, or a visit's
 * calls with its workers'. An id resolves among the session's own attempts, then its referenced runs'; a run that gave
 * one adds its own read gap. An id no journal holds yet is one unknown contribution, so the sum is partial rather than
 * short (#434).
 */
export function attemptsTotal(
	source: SessionSource,
	attemptIds: readonly string[],
	metric: FactMetric,
	scope: "session" | "lineage" = "session",
): TurnsSum {
	const analysis = scope === "lineage" ? analyzeLineage(source) : analyze(source);
	const wanted = new Set(attemptIds);
	const attempts = analysis.attempts.filter((attempt) => wanted.has(attempt.started.attemptId));
	const found = new Set(attempts.map((attempt) => attempt.started.attemptId));
	let runsGap = 0;
	for (const run of analysis.runs.values()) {
		const before = attempts.length;
		for (const attempt of run.attempts)
			if (wanted.has(attempt.started.attemptId) && !found.has(attempt.started.attemptId)) {
				found.add(attempt.started.attemptId);
				attempts.push(attempt);
			}
		if (attempts.length > before) runsGap += runGap(run);
	}
	const missing = wanted.size - found.size;
	const fact = withGap(attemptsSum(attempts, metric), missing + runsGap + (wanted.size > 0 ? analysis.gap : 0));
	const part: Part = { attempts, gap: 0 };
	const free = allFree([part]);
	const agreement = free ? partsFreeRule([part]) : undefined;
	return {
		fact,
		display: display(metric, fact, free, "none", agreement?.rule, agreement?.mixed),
		...freeClaim(free, agreement),
	};
}

export function quantity(view: View, ref: ParsedFactRef): Quantity {
	const measured = measure(view, ref);
	if (!measured) throw new Error(`read model cannot resolve its own reference ${factRef(ref)}`);
	return measured.quantity;
}

// ---- DTO builders ----

export const own = (sessionId: string, metric: FactMetric, extra: Partial<ParsedFactRef> = {}): ParsedFactRef => ({
	scope: "own",
	owner: sessionId,
	metric,
	...extra,
});

export function textFact(fact: Fact<string | boolean | null>) {
	return { fact, display: renderTextFact(fact) };
}

const knownCount = (fact: Fact<number> | undefined): number | null =>
	fact && (fact.kind === "measured" || fact.kind === "estimated") ? fact.value : null;

/**
 * One sent call's cache read, cache write and uncached input, or null when its read went unreported: an omitted read
 * is never a zero read. A server that omits the read from usage but timed its uncached prefill read the rest (#434).
 */
export function promptParts(attempt: Attempt): { read: number; write: number; input: number } | null {
	const settled = attempt.settled;
	if (!invoked(attempt) || !settled?.usage) return null;
	const input = knownCount(settled.usage.input);
	if (input === null) return null;
	const write = knownCount(settled.usage.cacheWrite) ?? 0;
	const read = knownCount(settled.usage.cacheRead);
	if (read !== null) return { read, write, input };
	const uncached = knownCount(settled.cache.uncachedPrefillTokens);
	return uncached === null || uncached > input ? null : { read: input - uncached, write, input: uncached };
}

/** A cached share's tokens and the sent calls behind them: read, derived from the uncached prefill, or unreported. */
interface ShareParts {
	read: number;
	total: number;
	measured: number;
	derived: number;
	unknown: number;
}
const emptyShare = (): ShareParts => ({ read: 0, total: 0, measured: 0, derived: 0, unknown: 0 });
/**
 * An unreported read adds the call's known prompt tokens and no read, so the share stays a lower bound: a read it
 * missed can only raise it.
 */
function addShare(share: ShareParts, attempt: Attempt): void {
	if (!invoked(attempt)) return;
	const parts = promptParts(attempt);
	if (parts) {
		share.read += parts.read;
		share.total += parts.read + parts.write + parts.input;
		if (knownCount(attempt.settled?.usage?.cacheRead) === null) share.derived += 1;
		else share.measured += 1;
		return;
	}
	const usage = attempt.settled?.usage;
	const input = usage ? knownCount(usage.input) : null;
	if (usage && input !== null) share.total += input + (knownCount(usage.cacheWrite) ?? 0);
	share.unknown += 1;
}
function mergeShare(share: ShareParts, add: ShareParts): void {
	share.read += add.read;
	share.total += add.total;
	share.measured += add.measured;
	share.derived += add.derived;
	share.unknown += add.unknown;
}

function shareOf(attempts: readonly Attempt[]): ShareParts {
	const share = emptyShare();
	for (const attempt of attempts) addShare(share, attempt);
	return share;
}

/** A selection's share; a run that kept no calls, or none at all, is one call whose read is unknown. */
function selectedShare(selection: Selection): ShareParts {
	if (selection.attempt) return shareOf([selection.attempt]);
	const share = emptyShare();
	for (const part of selection.parts) {
		if (part.selection) mergeShare(share, selectionShare(part.selection));
		else if (part.run) {
			if (part.run.source.present && part.run.fold.source === "calls") mergeShare(share, shareOf(part.run.attempts));
			else share.unknown += 1;
		} else mergeShare(share, shareOf(part.attempts ?? []));
		share.unknown += part.gap;
	}
	return share;
}

/**
 * C-05: the cached share of the prompts the calls sent. It reads `~` when a read was derived from the server's
 * uncached prefill and `≥` while some call's read went unreported, never a bare measured figure for either (R1, R3).
 */
function shareFact(share: ShareParts): Fact<number> | FactSum {
	if (share.total <= 0) return share.unknown > 0 ? unknownSum(share.unknown) : unobserved;
	const percent = (100 * share.read) / share.total;
	const derived = share.derived > 0;
	return {
		measured: derived ? 0 : percent,
		estimated: derived ? percent : 0,
		unknownCount: share.unknown,
		absentCount: 0,
		coverage: { measured: share.measured, estimated: share.derived, unknown: share.unknown },
	};
}

export const routeOf = (attempt: Attempt) => modelKey(attempt.settled?.target ?? attempt.started.target);

/**
 * C-05: per route, the block size its engine resumes a prefix at, learned from at least three cached counts that are
 * all multiples of one power of two of 256 or more (Radiance resumes at 2,048-token blocks less one). The largest
 * common power of two, not the gcd: repeated equal counts would otherwise learn the count itself.
 */
const ENGINE_FLOOR_MIN_CALLS = 3;
const ENGINE_FLOOR_MIN_TOKENS = 256;
/**
 * What the engine floors and cache breaks need of a session's calls, moved by each call that lands so a live read
 * never rescans the session: copying every route's reads on each call made a long session quadratic.
 */
interface CacheState {
	/** Per route, its cached reads counted by the exponent of the largest power of two dividing each. */
	readonly reads: Map<string, number[]>;
	/** The calls `isBreak` holds for, in the read model's order; a route's engine floor clears some of them. */
	readonly candidates: Attempt[];
	/** The candidates past the floors last read, and the candidates that moved since. */
	breaks: { floors: string; attempts: Attempt[]; pending: [Attempt | undefined, Attempt | undefined][] } | null;
}

export function cacheState(attempts: readonly Attempt[]): CacheState {
	const state: CacheState = { reads: new Map(), candidates: [], breaks: null };
	for (const attempt of attempts) noteCache(state, undefined, attempt);
	return state;
}

function noteCache(state: CacheState, before: Attempt | undefined, after: Attempt | undefined): void {
	for (const [attempt, sign] of [
		[before, -1],
		[after, 1],
	] as const) {
		const read = attempt ? (promptParts(attempt)?.read ?? 0) : 0;
		if (!attempt || read <= 0 || !Number.isSafeInteger(read)) continue;
		const route = routeOf(attempt);
		const slots = state.reads.get(route) ?? [];
		const exponent = lowestExponent(read);
		slots[exponent] = (slots[exponent] ?? 0) + sign;
		state.reads.set(route, slots);
	}
	const leaving = before && isBreak(before) ? before : undefined;
	const joining = after && isBreak(after) ? after : undefined;
	if (!leaving && !joining) return;
	edit(state.candidates, byStart, leaving, joining);
	const breaks = state.breaks;
	if (!breaks) return;
	breaks.pending.push([leaving, joining]);
	if (breaks.pending.length > state.candidates.length) state.breaks = null;
}

export function engineFloors(state: CacheState): Map<string, number> {
	const floors = new Map<string, number>();
	for (const [route, slots] of state.reads) {
		let calls = 0;
		let lowest = -1;
		for (let exponent = 0; exponent < slots.length; exponent += 1) {
			const count = slots[exponent] ?? 0;
			calls += count;
			if (count > 0 && lowest < 0) lowest = exponent;
		}
		const granularity = 2 ** lowest;
		if (lowest >= 0 && calls >= ENGINE_FLOOR_MIN_CALLS && granularity >= ENGINE_FLOOR_MIN_TOKENS)
			floors.set(route, granularity);
	}
	return floors;
}
/** The exponent of the largest power of two dividing a positive integer. */
const lowestExponent = (value: number): number => {
	let exponent = 0;
	while (value % 2 ** (exponent + 1) === 0) exponent += 1;
	return exponent;
};

/** Each call that hit its route's engine floor, with that floor. */
export function engineFloorCalls(
	attempts: readonly Attempt[],
	floors: ReadonlyMap<string, number>,
): Map<Attempt, number> {
	const calls = new Map<Attempt, number>();
	for (const attempt of attempts) {
		const granularity = floorGranularity(attempt, floors);
		if (granularity !== null) calls.set(attempt, granularity);
	}
	return calls;
}

/**
 * The cache breaks `telemetry cache`, the exit summary and the session DTO all count: an engine-floor call is hot.
 * While the floors hold, only the candidates that moved since the last read are filtered again. Callers must not keep
 * the list past the next batch.
 */
export function cacheBreaks(state: CacheState): readonly Attempt[] {
	const floors = engineFloors(state);
	const key = [...floors].join(";");
	const memo = state.breaks;
	if (memo?.floors === key) {
		const kept = (attempt: Attempt | undefined) =>
			attempt && floorGranularity(attempt, floors) === null ? attempt : undefined;
		for (const [leaving, joining] of memo.pending) edit(memo.attempts, byStart, kept(leaving), kept(joining));
		memo.pending = [];
		return memo.attempts;
	}
	const attempts = state.candidates.filter((attempt) => floorGranularity(attempt, floors) === null);
	state.breaks = { floors: key, attempts, pending: [] };
	return attempts;
}

/** A partial call that read whole blocks and fell short by under two of them hit the engine's floor, not a break. */
function floorGranularity(attempt: Attempt, floors: ReadonlyMap<string, number>): number | null {
	if (attempt.settled?.cache.verdict !== "partial") return null;
	const granularity = floors.get(routeOf(attempt));
	const parts = promptParts(attempt);
	if (granularity === undefined || !parts || parts.read <= 0 || parts.read % granularity !== 0) return null;
	return parts.input + parts.write < 2 * granularity ? granularity : null;
}

/** One quantity by reference, measured exactly as every DTO measures it; null when the source cannot see the ref. */
/** Fold a source now, so the first reader after a live seed finds its analysis built (#434 §11). */
export function prepareSource(source: SessionSource): void {
	analyze(source);
	if (source.parent) analyzeLineage(source);
}

export function quantityOf(ref: FactRef, source: SessionSource): Quantity | null {
	const parsed = parseFactRef(ref);
	return parsed ? (measure({ session: source }, parsed)?.quantity ?? null) : null;
}

const EXPLAIN_CAP = 500;

/** Resolve a reference against a session (any scope it can see) or a standalone run. */
export function explain(
	ref: FactRef,
	source: { session: SessionSource } | { runId: string; run: JournalSource } | { repo: RepoSource },
	options: ReadOptions = {},
): ExplanationV1 | null {
	const parsed = parseFactRef(ref);
	if (!parsed) return null;
	const view: View =
		"session" in source
			? { session: source.session }
			: "repo" in source
				? { repo: source.repo }
				: { run: analyzeRun(source.runId, source.run) };
	const measured = measure(view, parsed);
	if (!measured) return null;
	const attempts = measured.selection.parts.flatMap((part) => part.attempts ?? part.run?.attempts ?? []);
	const runIds = measured.selection.parts.flatMap((part) => (part.run ? [part.run.runId] : []));
	const gaps = measured.selection.parts.reduce(
		(total, part) => total + part.gap + (part.run && !part.run.source.present ? 1 : 0),
		0,
	);
	const contextRecord = parsed.scope === "context" && "session" in source ? latestContext(source.session) : null;
	const listed = attempts.slice(0, EXPLAIN_CAP);
	return {
		...header(options),
		kind: "explanation",
		ref: factRef(parsed),
		value: measured.quantity,
		coverage: renderCoverage(measured.quantity.fact),
		rule: `${RULES[parsed.metric]} over ${measured.selection.describe}; ${
			parsed.metric === "firstToken"
				? "never_sent attempts are excluded (R2); missing timing or an unreadable journal keeps the value unknown"
				: "a never_sent attempt contributes nothing (R2), and unknown, unsettled or unreadable contributions keep the sum partial"
		}${gaps > 0 ? ` (${renderCount(gaps)} unreadable or unattributed ${gaps === 1 ? "source" : "sources"})` : ""}`,
		from: {
			callIds: [...new Set(listed.map((attempt) => attempt.started.callId))].sort() as ExplanationV1["from"]["callIds"],
			attemptIds: listed.map((attempt) => attempt.started.attemptId).sort() as ExplanationV1["from"]["attemptIds"],
			runIds: [...new Set(runIds)].sort(),
			recordIds: [
				...new Set([...listed.flatMap((attempt) => attempt.recordIds), ...(contextRecord ? [contextRecord.id] : [])]),
			].sort(),
			omitted: attempts.length - listed.length,
		},
	};
}
