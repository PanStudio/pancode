// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GLYPH } from "../core/glyphs.js";
import type { RunTelemetryV1 } from "../core/telemetry/dto.js";
import { pancodeStateDir } from "../core/xdg.js";
import type { ExecutionStepResult } from "../domains/dispatch/execution-scheduler.js";
import { fleetNodeTaskBrief } from "../domains/dispatch/fleet-node-prompt.js";
import { openLedger, readFleetRun } from "../domains/dispatch/state.js";
import { WRITE_BOUNDARY_VIOLATION_REASON } from "../domains/dispatch/write-boundary.js";
import { loadRunTelemetrySource } from "../domains/session/telemetry-source.js";
import { type CodeStepRowV1, codeStepsReport, runTelemetry } from "../domains/telemetry/read-model-runs.js";
import { sanitizeCallTargetText } from "../lib/call-target/call-target.js";
import type { fleetInspectionScope } from "./fleet-project-scope.js";
import {
	DEFAULT_WIDTH,
	DETAIL_MAX_WIDTH,
	MIN_WIDTH,
	sanitizeBounded,
	TASK_MAX_WIDTH,
	truncatePlain,
} from "./fleet-view-model.js";
import { wrapViewerValue } from "./fleet-view-render.js";

// ---------------------------------------------------------------------------
// Fleet root index
// ---------------------------------------------------------------------------

/**
 * `fleet run` advertises a root id (`fleet-<hex>`) that names the whole run,
 * while the ledger and this viewer are keyed by the 12-character run id of one
 * dispatched step. An operator who copies the id off the end of `fleet run` was
 * being told "unknown run".
 *
 * The root is not a run and has no ledger row, no run record, and no journal of
 * its own, so it cannot be rendered as one. What it does have is a durable
 * record under `<state>/fleet-runs/<rootId>.json` listing the planned steps and,
 * for each step that settled, the run id it terminated on. That is enough for an
 * index: one line per step naming the run id to view next. Deliberately not a
 * combined transcript. Steps interleave across waves, and splicing several runs
 * into one scroll would invent an ordering the durable record does not have.
 */

/** Fleet root ids are `fleet-` plus hex; see newFleetRootId in src/cli/fleet.ts. */
export const FLEET_ROOT_PREFIX = "fleet-";
/** Visible cap for one sanitized step name before the index elides it. */
const STEP_ID_MAX_WIDTH = 32;

export interface FleetRunStepRow {
	stepId: string;
	/** The run the step terminated on, or null when the step never ran. */
	runId: string | null;
	agentId: string | null;
	outcome: string;
	detail: string | undefined;
	/** The step's task brief from its run's ledger entry; absent when the step never ran or its entry is gone. */
	task?: string;
}

export interface FleetRunViewModel {
	rootId: string;
	fleet: string;
	startedAt: string;
	telemetry?: RunTelemetryV1;
	/** True while the record carries no end stamp. */
	running: boolean;
	resumedFrom: string | null;
	plannedSteps: number;
	recordedSteps: number;
	steps: FleetRunStepRow[];
}

export function fleetRunsDir(): string {
	// Mirrors fleetRunPath() in src/domains/dispatch/state.ts, which is private
	// to that module; only the directory is needed here, for naming the path in
	// a "no such root" message.
	return join(pancodeStateDir(), "fleet-runs");
}

/**
 * Read defensively. A fleet-run record is written by an older or newer build
 * than the one reading it, and a missing field must cost the index one column,
 * never the whole listing.
 */
function stepResultOf(value: unknown): Partial<ExecutionStepResult> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ExecutionStepResult) : {};
}

export function loadFleetRunViewModel(
	rootId: string,
	options: { now?: () => number; scope?: ReturnType<typeof fleetInspectionScope> } = {},
): FleetRunViewModel | null {
	const record = readFleetRun(rootId);
	if (record === null) return null;
	const ledger = openLedger();
	if (options.scope !== undefined && !options.scope.seesRoot(record, (id) => ledger.get(id))) return null;
	const now = options.now ?? (() => Date.now());
	const settled = new Map<string, Partial<ExecutionStepResult>>();
	for (const entry of record.steps ?? []) {
		if (typeof entry?.stepId === "string") settled.set(entry.stepId, stepResultOf(entry.result));
	}
	// Planned order, not settle order: it is the order the operator wrote the
	// fleet in, and a step that never ran still belongs on the index.
	const stepIds = record.stepIds?.length > 0 ? record.stepIds : [...settled.keys()];
	const steps: FleetRunStepRow[] = stepIds.map((stepId) => {
		const result = settled.get(stepId);
		const runId = typeof result?.terminalRunId === "string" ? result.terminalRunId : null;
		if (result === undefined || runId === null) {
			return { stepId, runId: null, agentId: null, outcome: "not run", detail: undefined };
		}
		const envelope = ledger.get(runId);
		// The row is the step's verdict. A run that succeeded can still fail its
		// step (a gate baseline, a write-boundary rollback), and then the run's own
		// "succeeded" is not the step's outcome.
		const runOutcome = envelope?.outcome ?? null;
		const outcome =
			result.succeeded === true
				? (runOutcome ?? "succeeded")
				: runOutcome === null || runOutcome === "succeeded"
					? "failed"
					: runOutcome;
		const detail = result.boundaryViolated === true ? WRITE_BOUNDARY_VIOLATION_REASON : result.failureReason;
		const task = typeof envelope?.task === "string" ? fleetNodeTaskBrief(envelope.task).trim() : "";
		return {
			stepId,
			runId,
			agentId: envelope?.agentId ?? null,
			outcome,
			detail: typeof detail === "string" && detail.length > 0 ? detail : undefined,
			...(task.length > 0 ? { task } : {}),
		};
	});
	const telemetry = runTelemetry(rootId, loadRunTelemetrySource(pancodeStateDir(), rootId), { now: new Date(now()) });
	return {
		rootId: record.id,
		telemetry,
		fleet: record.fleet,
		startedAt: record.startedAt,
		running: record.endedAt === null,
		resumedFrom: record.resumedFrom,
		plannedSteps: stepIds.length,
		recordedSteps: settled.size,
		steps,
	};
}

export const CODE_STEP_PREFIX = "code-";
/** How many trailing lines of a code step's captured log the view prints; the log file keeps all of them. */
const CODE_STEP_LOG_LINES = 200;

interface CodeStepViewModel {
	rootId: string;
	record: CodeStepRowV1;
	logPath: string;
	/** The step's captured output log; null when it was never written or is gone. */
	log: string | null;
}

/**
 * A code step a fleet root lists runs no worker, so it has no ledger row: its record is the root journal's
 * `code_step.settled`, its output the log under the root's code-steps directory (fleet finding 9).
 */
export function loadCodeStepViewModel(
	runId: string,
	scope: ReturnType<typeof fleetInspectionScope>,
): CodeStepViewModel | null {
	// code-step.ts's codeStepDir; that module spawns and sandboxes, so the viewer names the directory itself.
	const stepsDir = join(pancodeStateDir(), "code-steps");
	let roots: string[];
	try {
		roots = readdirSync(stepsDir);
	} catch {
		return null;
	}
	const ledger = openLedger();
	for (const rootId of roots) {
		const root = readFleetRun(rootId);
		if (root === null || !scope.seesRoot(root, (id) => ledger.get(id))) continue;
		if (!(root.steps ?? []).some((entry) => stepResultOf(entry?.result).terminalRunId === runId)) continue;
		const record = codeStepsReport(loadRunTelemetrySource(pancodeStateDir(), rootId)).find((row) => row.runId === runId);
		if (record === undefined) continue;
		const logPath = join(stepsDir, rootId, `${record.stepId}.log`);
		let log: string | null = null;
		try {
			log = readFileSync(logPath, "utf8");
		} catch {
			// A removed log leaves the record; the view says the output is gone.
		}
		return { rootId, record, logPath, log };
	}
	return null;
}

export function renderCodeStepView(model: CodeStepViewModel, width: number = DEFAULT_WIDTH): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = GLYPH.rule.repeat(columns);
	const { record } = model;
	const exit = record.timedOut
		? "timed out"
		: record.signal !== null
			? `signal ${sanitizeBounded(record.signal, 16)}`
			: `exit ${record.exitCode}`;
	const lines = [
		truncatePlain(
			`code step ${record.runId}  ${sanitizeBounded(record.stepId, STEP_ID_MAX_WIDTH)}  root ${model.rootId}`,
			columns,
		),
		truncatePlain(
			`command ${sanitizeBounded(record.commandId, 64)}  ${exit}  duration ${record.durationMs}ms  started ${record.startedAt}`,
			columns,
		),
		rule,
	];
	if (model.log === null) {
		lines.push("the step's output log is gone.");
	} else {
		const logLines = model.log.replace(/\n$/u, "").split("\n");
		if (logLines.length > CODE_STEP_LOG_LINES)
			lines.push(`${GLYPH.ellipsis} ${logLines.length - CODE_STEP_LOG_LINES} earlier lines in the log file`);
		for (const line of logLines.slice(-CODE_STEP_LOG_LINES))
			lines.push(truncatePlain(sanitizeCallTargetText(line), columns));
	}
	if (record.outputTruncated) lines.push(`output capped at ${record.outputBytes} bytes`);
	lines.push(rule);
	lines.push(...wrapViewerValue("log ", model.logPath, columns));
	return lines;
}

/**
 * The step index as lines. Pure, for the same reason {@link renderRunView} is:
 * asserting the strings is asserting what an operator sees.
 */
export function renderFleetRunView(model: FleetRunViewModel, width: number = DEFAULT_WIDTH): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = GLYPH.rule.repeat(columns);
	const lines: string[] = [];
	lines.push(truncatePlain(`fleet ${sanitizeBounded(model.fleet, 64)}  root ${model.rootId}`, columns));
	const resumed = model.resumedFrom === null ? "" : `  resumed from ${sanitizeBounded(model.resumedFrom, 64)}`;
	lines.push(
		truncatePlain(
			`started ${model.startedAt}  elapsed ${model.telemetry?.activity.elapsed.display ?? "not available"}  ${model.recordedSteps} of ${model.plannedSteps} steps recorded${model.running ? "  (running)" : ""}${resumed}`,
			columns,
		),
	);
	lines.push(rule);
	if (model.steps.length === 0) {
		lines.push("no steps recorded for this fleet run.");
	} else {
		const rows = model.steps.map((step) => ({
			step: sanitizeBounded(step.stepId, STEP_ID_MAX_WIDTH),
			runId: step.runId ?? "-",
			outcome: sanitizeBounded(step.outcome, 32),
			tail: [step.agentId, step.detail].filter((part) => part !== null && part !== undefined).join(": "),
			task: step.task,
		}));
		const stepWidth = Math.max(...rows.map((row) => row.step.length));
		const runWidth = Math.max(...rows.map((row) => row.runId.length));
		const outcomeWidth = Math.max(...rows.map((row) => row.outcome.length));
		for (const row of rows) {
			const head = `${row.step.padEnd(stepWidth)}  ${row.runId.padEnd(runWidth)}  ${row.outcome.padEnd(outcomeWidth)}`;
			const text = row.tail.length === 0 ? head : `${head}  ${sanitizeBounded(row.tail, DETAIL_MAX_WIDTH)}`;
			lines.push(truncatePlain(text.trimEnd(), columns));
			// Row 362: the index says what each step was asked to do, not only which run to open next.
			if (row.task !== undefined)
				lines.push(truncatePlain(`  task ${sanitizeBounded(row.task, TASK_MAX_WIDTH)}`, columns));
		}
	}
	lines.push(rule);
	lines.push("pancode fleet view <run id> for one step's transcript, run record, and ledger entry");
	return lines;
}
