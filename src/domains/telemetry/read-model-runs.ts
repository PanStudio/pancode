// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Value } from "typebox/value";
import { sha256Hex } from "../../core/hash.js";
import type { Quantity, RunRowV1, RunTelemetryV1 } from "../../core/telemetry/dto.js";
import { runEconomicsOf } from "../../core/telemetry/economy.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EventPayload, JournalEventName } from "../../core/telemetry/events.js";
import { EvidenceFindingsObjectSchema } from "../../core/telemetry/evidence-schemas.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import { renderFact } from "../../core/telemetry/render.js";
import { RunResultObjectSchema } from "../../core/telemetry/run-schemas.js";
import type { ObjectRef } from "../../core/telemetry/schemas.js";
import { countsAsToolCall } from "../../core/telemetry/tool-schemas.js";
import { readStoredRunResult } from "./objects.js";
import {
	analyze,
	analyzeRun,
	header,
	localClock,
	localCount,
	POLICY_GAPS,
	quantity,
	type Run,
	unobserved,
	type View,
} from "./read-model.js";
import { callCounts, journalCoverage, runRow, tokenQuantities } from "./read-model-reports.js";
import type { JournalSource, ReadOptions, SessionSource } from "./read-model-sources.js";
import { runSettledDigest } from "./run-digest.js";
import { type SealVerdict, type TelemetryScopeFiles, verifyTelemetryScope } from "./seal.js";

/** One settled code step of a fleet root, with the time its record was journaled. */
export type CodeStepRowV1 = EventPayload<"code_step.settled"> & { at: string };

/** The code steps a fleet root's journal settled, oldest start first (#434). */
export function codeStepsReport(source: JournalSource): CodeStepRowV1[] {
	return source.records
		.flatMap((record) => (record.k === "code_step.settled" ? [{ ...record.data, at: record.t }] : []))
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** The safety and lifecycle decisions a scope journals (#434). */
export const ACCOUNTABILITY_EVENTS = [
	"tool.decided",
	"approval.requested",
	"approval.resolved",
	"run.aborted",
	"turn.aborted",
	"job.clock_resumed",
	"turn.continued",
	"agent.status_changed",
	"completion.evaluated",
	"safety.judged",
	"session.resumed",
	"session.closed",
	"autonomy.entered",
	"autonomy.open_decision",
	"autonomy.cap_reached",
	"autonomy.resumed",
	"autonomy.ended",
] as const satisfies readonly JournalEventName[];
export type AccountabilityEventName = (typeof ACCOUNTABILITY_EVENTS)[number];
export type AccountabilityRecord = TelemetryRecord<AccountabilityEventName>;

const accountabilityKinds: ReadonlySet<string> = new Set(ACCOUNTABILITY_EVENTS);

function isAccountabilityRecord(record: TelemetryRecord): record is AccountabilityRecord {
	return accountabilityKinds.has(record.k);
}

/**
 * The accountability records of the given journals, oldest first and each once: a run journal a session and a repo
 * both reference is read once (#434).
 */
export function accountabilityRecords(journals: Iterable<JournalSource>): AccountabilityRecord[] {
	const seen = new Set<string>();
	const out: AccountabilityRecord[] = [];
	for (const journal of journals) {
		for (const record of journal.records) {
			if (!isAccountabilityRecord(record) || seen.has(record.id)) continue;
			seen.add(record.id);
			out.push(record);
		}
	}
	return out.sort((a, b) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id));
}

/** A session's own journal and the run journals its records reference. */
export function sessionJournals(source: SessionSource): JournalSource[] {
	return [source.journal, ...source.runs.values()];
}

/** The runs a session's own records reference, in run id order. */
export function runsReport(source: SessionSource): RunRowV1[] {
	const view: View = { session: source };
	return [...analyze(source).runs.values()].map((run) => runRow(view, run));
}

/** The agent and route a run was enqueued under. */
export interface EnqueuedRun {
	agentId: string;
	targetId: string;
	wireModelId: string;
	node: string | null;
}

/** A run's newest enqueue record; a retry's can land in an ancestor run's journal, so every journal is read. */
export function runEnqueued(source: SessionSource, runId: string): EnqueuedRun | null {
	let at = "";
	let enqueued: EnqueuedRun | null = null;
	for (const journal of sessionJournals(source))
		for (const record of journal.records)
			if (record.k === "run.enqueued" && record.data.runId === runId && record.t >= at) {
				at = record.t;
				const { agentId, targetId, wireModelId, node } = record.data;
				enqueued = { agentId, targetId, wireModelId, node: node ?? null };
			}
	return enqueued;
}

/** One run as a list row: the row `runTelemetry` reports, without the per-run detail (#434 §11.3). */
export function runRowTelemetry(runId: string, source: JournalSource): RunRowV1 {
	const run = analyzeRun(runId, source);
	return runRow({ run }, run);
}

/** An object a run record names, from the scope's own files; `missing` when they do not hold it intact. */
function scopeObject<T>(
	ref: ObjectRef,
	scope: TelemetryScopeFiles,
	check: (value: unknown) => value is T,
): { state: "resolved"; value: T } | { state: "missing" } {
	const file = scope.objects.find((object) => object.name === `${ref.id}.json`);
	if (file === undefined || sha256Hex(file.bytes) !== ref.id.slice("obj_".length)) return { state: "missing" };
	try {
		const parsed: unknown = JSON.parse(file.bytes.toString("utf8"));
		const value = ref.subject === "run-result" ? readStoredRunResult(parsed) : parsed;
		return check(value) ? { state: "resolved", value } : { state: "missing" };
	} catch {
		// Bytes that hash to the id but do not parse were never a stored object.
		return { state: "missing" };
	}
}

/** A run's elapsed time and output rate at `options.now`: the only run quantities that move while its journal is quiet. */
function runClock(
	run: Run,
	output: Quantity["fact"],
	options: ReadOptions,
): Pick<RunTelemetryV1["activity"], "elapsed" | "outputPerSecond"> {
	const started = run.settled?.data.startedAt ?? run.firstAt;
	const terminal = run.source.records.at(-1);
	const sealedAt = terminal?.k === "run.sealed" || terminal?.k === "share.sealed" ? terminal.t : null;
	const ended = run.settled?.data.endedAt ?? sealedAt ?? (options.now ?? new Date()).toISOString();
	const elapsed = started === null ? unobserved : localClock(Math.max(0, Date.parse(ended) - Date.parse(started)));
	const measured =
		"kind" in output
			? output.kind === "measured"
			: output.unknownCount === 0 && output.coverage.estimated === 0 && output.coverage.measured > 0;
	const rate =
		measured && elapsed.kind === "measured" && elapsed.value > 100
			? localCount(factKnownValue(output) / (elapsed.value / 1000))
			: unobserved;
	return {
		elapsed: { fact: elapsed, display: renderFact(elapsed, "duration") },
		outputPerSecond: { fact: rate, display: renderFact(rate) },
	};
}

/** Live and settled run quantities, from journal clocks and tool settlements (#434). */
function runActivity(run: Run, output: Quantity["fact"], options: ReadOptions): RunTelemetryV1["activity"] {
	const toolIds = new Set<string>();
	for (const record of run.source.records) {
		if (record.k === "tool.settled" && countsAsToolCall(record.data)) toolIds.add(record.ctx.toolCallId ?? record.id);
		if (
			record.k === "run.feed_appended" &&
			record.data.body.kind === "event" &&
			record.data.body.type === "pancode_tool_finish"
		)
			toolIds.add(record.data.body.callId ?? record.id);
	}
	const tools = run.settled
		? localCount(run.settled.data.toolCalls)
		: run.source.present &&
				run.gap === 0 &&
				!run.source.records.some((record) => record.k === "journal.gap" && !POLICY_GAPS.has(record.data.reason))
			? localCount(toolIds.size)
			: unobserved;
	const latest = [...run.attempts].reverse().find((attempt) => attempt.settled?.usage != null);
	return {
		contextTokens: latest
			? quantity({ run }, { scope: "run", owner: run.runId, attemptId: latest.started.attemptId, metric: "total" })
			: null,
		...runClock(run, output, options),
		toolCalls: { fact: tools, display: renderFact(tools) },
	};
}

function runResultOf(settled: Run["settled"], scope: TelemetryScopeFiles | null): RunTelemetryV1["result"] {
	if (settled === null || scope === null) return null;
	return scopeObject(settled.data.result, scope, (value) => Value.Check(RunResultObjectSchema, value));
}

function runAssessmentOf(assessed: Run["assessed"], scope: TelemetryScopeFiles | null): RunTelemetryV1["assessment"] {
	if (assessed === null) return null;
	return {
		...assessed.data,
		at: assessed.at,
		content:
			scope === null
				? null
				: scopeObject(assessed.data.text, scope, (value) => Value.Check(EvidenceFindingsObjectSchema, value)),
	};
}

/**
 * One run's DTO: its fold, its run.settled facts, and, given the run scope's own files (`readTelemetryScopeFiles`),
 * the seal verdict and the result object the settlement names (#434 §11.1). `sealVerdict` is `scope`'s verdict when
 * the caller already verified it.
 */
export function runTelemetry(
	runId: string,
	source: JournalSource,
	options: ReadOptions = {},
	scope: TelemetryScopeFiles | null = null,
	sealVerdict: SealVerdict | null = scope === null ? null : verifyTelemetryScope(scope),
): RunTelemetryV1 {
	const run = analyzeRun(runId, source);
	const view: View = { run };
	const base = { scope: "run" as const, owner: runId };
	const settled = run.settled;
	const tokens = tokenQuantities(view, base);
	return {
		...header(options),
		kind: "run",
		activity: runActivity(run, tokens.output.fact, options),
		row: runRow(view, run),
		journal: journalCoverage(source, run.fold.calls),
		counts: callCounts(view, base),
		tokens,
		unmeteredCalls: quantity(view, { ...base, metric: "unmeteredCalls" }),
		settled: settled
			? {
					...settled.data,
					at: settled.at,
					digest: runSettledDigest(settled.data),
					boundKind: settled.data.boundKind ?? null,
					repairRounds: quantity(view, { ...base, metric: "repairRounds" }),
					economics: runEconomicsOf(settled.data),
				}
			: null,
		seal: sealVerdict,
		result: runResultOf(settled, scope),
		assessment: runAssessmentOf(run.assessed, scope),
	};
}

/**
 * `telemetry`, which `runTelemetry` built from this same `source`, read again at `options.now`. Only the header's time,
 * the elapsed time and the output rate read the clock, so a card polling a quiet open run refolds nothing else.
 */
export function runTelemetryAt(
	runId: string,
	source: JournalSource,
	telemetry: RunTelemetryV1,
	options: ReadOptions = {},
): RunTelemetryV1 {
	return {
		...telemetry,
		...header(options),
		activity: { ...telemetry.activity, ...runClock(analyzeRun(runId, source), telemetry.tokens.output.fact, options) },
	};
}
