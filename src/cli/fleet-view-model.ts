// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { readSettings } from "../core/config.js";
import { GLYPH } from "../core/glyphs.js";
import type { RunTelemetryV1 } from "../core/telemetry/dto.js";
import { pancodeStateDir } from "../core/xdg.js";
import { renderAgentLedgerBoard } from "../domains/dispatch/agent-ledger-store.js";
import { compromisedSuccess } from "../domains/dispatch/gate-verdict.js";
import { type RunFeedLine, readRunFeed, runFeedPath } from "../domains/dispatch/run-feed.js";
import { callReportedModelLabel, responseModelIdWords } from "../domains/dispatch/run-upstream.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { readRunGateIndex, readRunTrust } from "../domains/evidence/run-trust.js";
import { formatTrustSummaryLine } from "../domains/evidence/trust-projection.js";
import { loadRunCallsTelemetrySource } from "../domains/session/telemetry-source.js";
import type { SettledRunRecord } from "../domains/telemetry/index.js";
import { readRunRecord } from "../domains/telemetry/index.js";
import { runAggregateModel } from "../domains/telemetry/read-model-cost.js";
import { runCallsReport } from "../domains/telemetry/read-model-reports.js";
import { runTelemetry } from "../domains/telemetry/read-model-runs.js";
import { truncateToWidth } from "../engine/tui-primitives.js";
import { sanitizeCallTargetText } from "../lib/call-target/call-target.js";
import type { fleetInspectionScope } from "./fleet-project-scope.js";
import { contractReportOf, sealedReportAnswer } from "./run-output.js";

/** Transcript lines kept in the model. Older lines are dropped from the head. */
export const TRANSCRIPT_LIMIT = 400;
/** Visible width cap for one sanitized task line before the renderer wraps it. */
export const TASK_MAX_WIDTH = 400;
/** Visible width cap for one sanitized feed detail. */
export const DETAIL_MAX_WIDTH = 200;
/** Visible width cap for one coalesced prose block. */
export const PROSE_MAX_WIDTH = 2000;
export const DEFAULT_WIDTH = 100;
export const MIN_WIDTH = 40;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface RunViewTranscriptLine {
	at: string;
	label: string;
	detail: string | undefined;
}

export interface RunViewModel {
	agentLedgerBoard?: string;
	runId: string;
	agentId: string;
	model: string;
	target: string;
	node: string;
	phase: string;
	startedAt: string;
	telemetry?: RunTelemetryV1;
	task: string | undefined;
	transcript: RunViewTranscriptLine[];
	/** True when the writer dropped display lines or the reader skipped a head. */
	transcriptTruncated: boolean;
	journalPresent: boolean;
	journalUnavailableReason?: string;
	/** The reported models of the run's own calls, read when its seal carries no upstream observation. */
	callModels?: string;
	/** The session model an ACP delegation's reported usage names, from its run journal. */
	sessionModel?: string;
	journalPath: string;
	/** The run record's trust line, or the reason there is not one. */
	evidence: string;
	/** Present only when the run settled under a seal that verifies. */
	record?: SettledRunRecord;
	/** A succeeded run whose assurance is compromised: `run --agent` exits 1 on it with this cause and message. */
	gate?: RunViewGate;
	outcome: string | null;
	outcomeDetail: string | null;
	/** True once the feed carries its terminal line or the ledger row ended. */
	terminal: boolean;
}

export function sanitizeBounded(value: string, maxWidth: number): string {
	const sanitized = sanitizeCallTargetText(value);
	if (sanitized.length === 0) return "";
	// truncateToWidth appends reset sequences when it elides, so the result goes
	// back through the sanitizer and stays plain text.
	return sanitizeCallTargetText(truncateToWidth(sanitized, maxWidth, GLYPH.ellipsis, false));
}

/** The ANSI-aware TUI truncator appends reset codes; stdout snapshots are plain text. */
export function truncatePlain(value: string, width: number): string {
	return truncateToWidth(value, width, GLYPH.ellipsis, false).replaceAll("\u001B[0m", "");
}

/**
 * Read the run's record and reduce it to one status line in the shared trust vocabulary. Nothing from a record whose
 * seal does not verify reaches the line beyond the reason it could not be trusted (#434).
 */
interface RunViewGate {
	exitCode: 1;
	cause: "verdict_failed";
	verdict: string | null;
	failedChecks: string[];
	message: string;
}

function evidenceLine(run: RunEnvelope): { text: string; record?: SettledRunRecord } {
	let record: RunTelemetryV1 | null = null;
	try {
		record = readRunRecord(pancodeStateDir(), run.id);
	} catch (error) {
		return { text: `run record unavailable: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (record?.settled == null)
		return {
			text: run.endedAt === null ? "run pending; it has not settled" : "run record unavailable; it never settled",
		};
	// The same reader `evidence inspect` uses, so the two surfaces cannot disagree on a run's trust (bt-20).
	const { integrity, trust } = readRunTrust(record, readRunGateIndex(pancodeStateDir())(run.id));
	if (integrity.state === "failed")
		return { text: `RUN SEAL FAILED: ${integrity.reason}; its settled facts are untrusted` };
	if (integrity.state === "unsealed")
		return { text: `run record unsealed: ${integrity.reason}; its settled facts are not yet vouched for` };
	return { text: formatTrustSummaryLine(trust), record: record as SettledRunRecord };
}

/**
 * The requested model next to what the provider reported on the run's calls, each distinct report once. The route a
 * run was dispatched on is configuration; only the providers' responses say what served it.
 */
export function modelObservationText(
	settled: SettledRunRecord["settled"],
	callModels: string | null,
	sessionModel: string | null,
): string {
	// An ACP delegation's route names the agent; the model its session ran is the one its reported usage names.
	const model = sessionModel ?? settled.route.wireModelId;
	const requested = `requested ${sanitizeBounded(model, 128)}`;
	const reported = responseModelIdWords(settled.upstream.responseModelIds ?? callModels, model);
	return reported === null
		? `${requested} ${GLYPH.sep} no provider response recorded`
		: `${requested} ${GLYPH.sep} ${sanitizeBounded(reported.text, 512)}`;
}

/**
 * A feed line in words. The structured facts the workers dashboard reads say
 * the same thing here in one line: a call as its tool and descriptor with its
 * outcome, coalesced prose as the assistant's.
 */
function eventTranscriptLine(line: Extract<RunFeedLine, { kind: "event" }>): RunViewTranscriptLine {
	const detail = line.detail === undefined ? undefined : sanitizeBounded(line.detail, DETAIL_MAX_WIDTH);
	const tool = line.tool === undefined ? "" : sanitizeBounded(line.tool, 64);
	const call = [line.verb === undefined ? "" : sanitizeBounded(line.verb, 32), detail ?? ""].filter(Boolean).join(" ");
	switch (line.type) {
		case "text":
			return { at: line.at, label: "assistant", detail };
		case "thinking":
			return { at: line.at, label: "thinking", detail: undefined };
		case "pancode_tool_start":
			if (tool.length > 0) return { at: line.at, label: `${tool} started`, detail: call || undefined };
			break;
		case "pancode_tool_finish": {
			if (tool.length === 0) break;
			const took = line.durationMs === undefined ? "" : ` in ${line.durationMs}ms`;
			// A refusal names every refused command, so a blocked call keeps its whole reason (fleet finding 6).
			const reason =
				line.reason === undefined
					? ""
					: sanitizeBounded(line.reason, line.outcome === "blocked" ? PROSE_MAX_WIDTH : DETAIL_MAX_WIDTH);
			return {
				at: line.at,
				label: `${tool} ${line.outcome ?? "finished"}${took}`,
				// A blocked call's descriptor can be empty; the reason then stands alone, never after a bare colon.
				detail: [call, reason].filter((part) => part.length > 0).join(": ") || undefined,
			};
		}
		case "pancode_helper_result_rejected": {
			// The reason leads; the feed row keeps the whole submission.
			const words = [line.reason, line.detail === undefined ? undefined : `submitted ${line.detail}`]
				.filter((part) => part !== undefined)
				.join(` ${GLYPH.sep} `);
			return { at: line.at, label: "result rejected", detail: sanitizeBounded(words, DETAIL_MAX_WIDTH) || undefined };
		}
	}
	return { at: line.at, label: sanitizeBounded(eventWords(line.type), 64), detail };
}

/** An event type without its namespace, in words: `pancode_peer_question` reads `peer question`. */
function eventWords(type: string): string {
	return (type.startsWith("pancode_") ? type.slice("pancode_".length) : type).replaceAll("_", " ");
}

/**
 * Events the snapshot does not list: lifecycle markers another line already says, a result submission the prose row
 * it follows turns into `result submitted`, and bookkeeping an operator reads nothing from (dogfood F2).
 */
const SNAPSHOT_QUIET_EVENTS: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"message_start",
	"message_update",
	"message_end",
	"turn_start",
	"turn_end",
	"pancode_helper_result",
	"pancode_model_call",
	"pancode_tool_observation",
	"pancode_repair_rounds_started",
	"pancode_telemetry",
]);

/** Rows that end a prose block, matching the feed writer's own reading (src/domains/dispatch/run-feed.ts). */
function endsProse(line: RunFeedLine): boolean {
	if (line.kind !== "event") return line.kind === "result" || line.kind === "terminal";
	return (
		line.type === "thinking" ||
		line.type === "attempt_start" ||
		line.type === "message_end" ||
		line.type === "agent_end" ||
		line.type === "pancode_tool_start" ||
		line.type === "pancode_tool_finish" ||
		line.type === "pancode_tool_observation"
	);
}

function isJsonObject(text: string): boolean {
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value);
	} catch {
		return false;
	}
}

/**
 * The feed as transcript lines. The writer streams one prose block in several rows and lets a row that says nothing
 * about the prose pass the held-back words (#446), so a later row can carry an earlier block's tail. The block is one
 * `assistant` line at its first row's time, placed before the rows that passed it, so the timeline stays in order
 * and a JSON report is never split mid-value (dogfood F2).
 */
function transcriptOf(
	lines: ReadonlyArray<RunFeedLine>,
	contract?: { sourceId: string; conformance: string } | null,
): RunViewTranscriptLine[] {
	const out: RunViewTranscriptLine[] = [];
	// Held in an object: TypeScript does not see the closures below reassign a plain `let`.
	const open: { prose: { entry: RunViewTranscriptLine; raw: string; report: boolean } | null } = { prose: null };
	const settle = () => {
		const prose = open.prose;
		if (prose === null) return;
		const raw = prose.raw.trim();
		if (prose.report && isJsonObject(raw)) {
			// The run record states the accepted report; its JSON would repeat it.
			prose.entry.label = "result submitted";
			prose.entry.detail = undefined;
		} else if (contractReportOf(raw, contract) !== undefined) {
			// A reply that is the run's contract report, which a failed run never sealed: its words, not its JSON.
			prose.entry.detail = sanitizeBounded(sealedReportAnswer(raw, contractReportOf(raw, contract)), PROSE_MAX_WIDTH);
		} else {
			prose.entry.detail = sanitizeBounded(raw, PROSE_MAX_WIDTH) || undefined;
		}
		open.prose = null;
	};
	const append = (at: string, text: string) => {
		if (open.prose === null) {
			const entry: RunViewTranscriptLine = { at, label: "assistant", detail: undefined };
			out.push(entry);
			open.prose = { entry, raw: "", report: false };
		}
		open.prose.raw += text;
	};
	for (const line of lines) {
		if (line.kind === "event" && line.type === "text") {
			if (line.detail !== undefined && line.detail.length > 0) append(line.at, line.detail);
			continue;
		}
		if (line.kind === "event" && line.type === "message_end" && line.detail !== undefined && line.detail.length > 0) {
			// Only a message that streamed no prose carries its text here (an ACP peer).
			append(line.at, line.detail);
		}
		if (line.kind === "event" && line.type === "pancode_helper_result" && open.prose !== null) open.prose.report = true;
		if (endsProse(line)) settle();
		if (line.kind === "event" && SNAPSHOT_QUIET_EVENTS.has(line.type)) continue;
		const rendered = transcriptLine(line);
		if (rendered !== null) out.push(rendered);
	}
	settle();
	return out;
}

function transcriptLine(line: RunFeedLine): RunViewTranscriptLine | null {
	switch (line.kind) {
		case "open":
			return { at: line.at, label: `run opened (${sanitizeBounded(line.agentId, 64)})`, detail: undefined };
		case "event":
			return eventTranscriptLine(line);
		case "journal_truncated":
			return { at: line.at, label: "journal truncated", detail: sanitizeBounded(line.reason, 64) };
		case "result":
			return {
				at: line.at,
				label: `result (${sanitizeBounded(line.outcome, 32)}, exit ${line.exitCode ?? "unknown"})`,
				detail: undefined,
			};
		case "terminal":
			return {
				at: line.at,
				label: `terminal (${sanitizeBounded(line.outcome, 32)})`,
				detail: line.detail === undefined ? undefined : sanitizeBounded(line.detail, PROSE_MAX_WIDTH),
			};
		default:
			return null;
	}
}

export interface LoadRunViewOptions {
	now?: () => number;
	scope?: ReturnType<typeof fleetInspectionScope>;
	/** The ledger rows a poller keeps; absent, the run's row is read from runs.json. */
	ledger?: () => ReadonlyArray<RunEnvelope>;
}

/**
 * Resolve a run id the way `fleet status` prints them: an exact ledger id
 * first, then a unique prefix. An ambiguous prefix resolves to nothing so the
 * caller can say which ids it matched.
 */
export function resolveRunId(
	runId: string,
	scope: ReturnType<typeof fleetInspectionScope>,
): { runId: string } | { candidates: string[] } {
	const ledger = openLedger();
	const exact = ledger.get(runId);
	if (exact !== null && scope.seesRun(exact)) return { runId };
	const candidates = ledger
		.list()
		.filter((run) => run.id.startsWith(runId) && scope.seesRun(run))
		.map((run) => run.id);
	if (candidates.length === 1 && candidates[0] !== undefined) return { runId: candidates[0] };
	return { candidates };
}

/** A main run streams to its session, not to a run feed; its transcript is the session's (fleet finding 3). */
function mainRunFeedReason(run: RunEnvelope): string | null {
	if (run.agentId !== "main-agent" || run.sessionId == null) return null;
	return `a main run records no display feed; its turns are in its session: pancode session show ${run.sessionId} --transcript`;
}

function journalUnavailableReason(): string {
	try {
		if (!readSettings().fleet.history.journal) {
			return "event journaling is currently disabled (fleet.history.journal=false); enable it to record future runs.";
		}
	} catch {
		// A settings read failure cannot establish why a historical file is missing.
	}
	return "the feed file is missing; this run's recording settings and any later removal are not recorded.";
}

/** The shared ledger's board, only when a peer posted to it; an empty ledger says nothing about this run. */
function agentLedgerBoardOf(ledgerId: string | null | undefined): { agentLedgerBoard?: string } {
	const board = ledgerId === undefined || ledgerId === null ? null : renderAgentLedgerBoard(ledgerId);
	return board === null ? {} : { agentLedgerBoard: board };
}

export function loadRunViewModel(runId: string, options: LoadRunViewOptions = {}): RunViewModel | null {
	const run =
		options.ledger !== undefined ? (options.ledger().find((row) => row.id === runId) ?? null) : openLedger().get(runId);
	if (run === null || (options.scope !== undefined && !options.scope.seesRun(run))) return null;
	const now = options.now ?? (() => Date.now());
	const journal = readRunFeed(runId, { maxLines: TRANSCRIPT_LIMIT });
	const evidence = evidenceLine(run);
	const transcript = transcriptOf(journal.lines, evidence.record?.settled.quality?.resultContract);
	// A main run's calls settle in its session journal; the run reads them with its seal, as `telemetry calls --run` does.
	const source = loadRunCallsTelemetrySource(pancodeStateDir(), runId);
	const telemetry = runTelemetry(runId, source, { now: new Date(now()) });
	const callModels =
		evidence.record !== undefined && evidence.record.settled.upstream.responseModelIds === null
			? callReportedModelLabel(
					runCallsReport(runId, source)
						.calls.filter((call) => call.disposition !== "never_sent" && call.disposition !== "incomplete")
						.map((call) =>
							call.target.reportedModel.fact.kind === "measured" ? String(call.target.reportedModel.fact.value) : null,
						),
				)
			: null;
	const sessionModel = runAggregateModel(runId, source);
	const task = sanitizeBounded(run.task, TASK_MAX_WIDTH);
	return {
		runId: run.id,
		telemetry,
		agentId: run.agentId,
		model: run.wireModelId,
		target: run.targetId,
		node: run.node?.id ?? "local",
		phase: run.outcome ?? run.status,
		startedAt: run.startedAt,
		task: task.length > 0 ? task : undefined,
		transcript,
		transcriptTruncated: journal.truncated,
		journalPresent: journal.present,
		...(!journal.present ? { journalUnavailableReason: mainRunFeedReason(run) ?? journalUnavailableReason() } : {}),
		...(callModels !== null ? { callModels } : {}),
		...(sessionModel !== null ? { sessionModel } : {}),
		journalPath: runFeedPath(runId),
		evidence: evidence.text,
		...(evidence.record === undefined ? {} : { record: evidence.record }),
		...gateOf(evidence.record),
		...agentLedgerBoardOf(run.projection?.ledgerId),
		outcome: journal.terminal?.outcome ?? run.outcome ?? null,
		outcomeDetail: journal.terminal?.detail ?? run.outcomeDetail ?? null,
		terminal: journal.terminal !== null || run.endedAt !== null,
	};
}

/**
 * A succeeded run's compromised gate, read from its settled record by the helper `run --agent` reads its receipt with,
 * so the exit and cause it gives and this view agree (fleet finding 13).
 */
function gateOf(record: SettledRunRecord | undefined): { gate?: RunViewGate } {
	if (record === undefined) return {};
	const settled = record.settled;
	const gate = compromisedSuccess({
		exitCode: settled.exitCode,
		verdict: settled.verdict ?? null,
		quality: settled.quality,
		output: record.result?.state === "resolved" ? record.result.value.output : null,
	});
	return gate === null ? {} : { gate: { exitCode: 1, cause: "verdict_failed", ...gate } };
}
