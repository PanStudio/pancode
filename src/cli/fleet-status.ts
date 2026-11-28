// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pancode fleet status [--json] [--all]` answered before src/cli/fleet.ts and its domain graph load, the way
 * fleet-help.ts answers the group help. A status with no ledger rows reads the run ledger's file, the settings (for
 * the warning a settings read prints) and the admission gate. A status with rows also loads the ledger, the project
 * scope and each run's journal through the telemetry domain's light reader (run-journal-read.ts), so it never
 * reaches the telemetry or dispatch domain modules either. Either way it reads the fleet roots whose owning process is
 * still running and the steps each has dispatched and not settled, from the root's event journal: a code step runs no
 * worker and has no ledger row, so this is the only place status sees one running.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../core/process-identity.js";
import type { RunToolBudgetEnvelope } from "../core/run-budget-envelope.js";
import type { FactSum } from "../core/telemetry/fact.js";
import { sumFactSums } from "../core/telemetry/pricing.js";
import { renderCountSum, renderCountSumKnown, renderDurationSum, renderUsdSum } from "../core/telemetry/render.js";
import { pancodeStateDir } from "../core/xdg.js";
import type { CapacityDrain } from "../domains/dispatch/capacity-lease.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";

export type FleetAdmissionStatus =
	| { state: "open" }
	| {
			state: "draining";
			requestedByPid: number;
			requestedAt: string;
			expiresAt: string;
	  };

export function admissionStatus(drain: CapacityDrain | null): FleetAdmissionStatus {
	if (drain === null) return { state: "open" };
	return { state: "draining", ...drain };
}

interface StatusWriter {
	write(chunk: string): unknown;
}

type Displayed = { display: string };
type Counted = { fact: FactSum; display: string };

interface RunningRow {
	runId: string;
	agentId: string;
	budget: RunToolBudgetEnvelope | null;
	runtimeKind: RunEnvelope["runtimeKind"];
	outcomePhase: RunEnvelope["status"];
	heartbeat: "alive" | "stale" | "dead";
	lineage: NonNullable<RunEnvelope["lineage"]>;
	startedAt: string;
	elapsed: Displayed;
	tokens: unknown;
	usd: Displayed;
	node: string;
}

/** One ledger row the totals count. */
interface CountedRunRow {
	runId: string;
	agentId: string;
	/** The sealed outcome once the run ended, else its ledger status. */
	state: string;
	startedAt: string;
	endedAt: string | null;
	elapsed: Displayed;
	usd: Displayed;
	node: string;
}

interface InFlightStepRow {
	stepId: string;
	kind: "agent" | "code";
	/** The worker run of an agent step, the code run of a code step. */
	runId: string;
	agentId: string | null;
	commandId: string | null;
	dispatchedAt: string;
}

interface RunningRootRow {
	rootId: string;
	playbook: string;
	startedAt: string;
	stepCount: number;
	settledStepCount: number;
	inFlight: InFlightStepRow[];
}

interface StatusSnapshot {
	generatedAt: string;
	admission: FleetAdmissionStatus;
	running: RunningRow[];
	roots: RunningRootRow[];
	retrying: Array<Record<string, unknown>>;
	/** Every run the totals count, newest first. */
	runs: CountedRunRow[];
	totals: {
		total: Counted;
		input: Counted;
		output: Counted;
		cacheRead: Counted;
		cacheWrite: Counted;
		usd: Displayed;
		elapsed: Displayed;
	};
}

/**
 * Whether runs.json holds no row by the ledger's own reading (src/domains/dispatch/state.ts readRuns): no file, an
 * empty file, a document that is not an array, or an empty array. A file that does not read or parse answers false,
 * so opening the ledger raises the error it always raised.
 */
function ledgerHasNoRows(): boolean {
	const path = join(pancodeStateDir(), "runs.json");
	try {
		if (!existsSync(path)) return true;
		const raw = readFileSync(path, "utf8").trim();
		if (raw.length === 0) return true;
		const parsed = JSON.parse(raw) as unknown;
		return !Array.isArray(parsed) || parsed.length === 0;
	} catch {
		return false;
	}
}

/** fleetTotals (src/domains/telemetry/read-model-usage.ts) over no runs, from the same sum and render primitives. */
function emptyFleetTotals() {
	const fact = sumFactSums([]);
	const count = () => ({ fact, display: renderCountSum(fact) });
	return {
		input: count(),
		output: count(),
		cacheRead: count(),
		cacheWrite: count(),
		total: count(),
		usd: { fact, display: renderUsdSum(fact, false) },
		elapsed: { fact, display: renderDurationSum(fact) },
	};
}

/**
 * The fleet roots with no end time whose owning process is alive (`fleet list`'s `running`), each with the steps its
 * journal shows dispatched and not settled. Records that all ended answer before the project scope or the assignment
 * store loads.
 */
async function runningRoots(all: boolean): Promise<RunningRootRow[]> {
	const { listFleetRuns } = await import("../domains/dispatch/state.js");
	const open = listFleetRuns().filter((record) => record.endedAt === null);
	if (open.length === 0) return [];
	const [{ fleetInspectionScope }, { assignmentProcessOwnerAlive, getStoredAssignment }, { fleetRootInFlightSteps }] =
		await Promise.all([
			import("./fleet-project-scope.js"),
			import("../domains/dispatch/assignment-store.js"),
			import("../domains/dispatch/fleet-event-journal.js"),
		]);
	const scope = fleetInspectionScope(all);
	return open
		.filter((record) => {
			if (!scope.seesRoot(record)) return false;
			const assignment = getStoredAssignment(record.id);
			return assignment?.status === "running" && assignmentProcessOwnerAlive(assignment);
		})
		.map((record) => ({
			rootId: record.id,
			playbook: record.fleet,
			startedAt: record.startedAt,
			stepCount: record.stepIds.length,
			settledStepCount: record.steps.length,
			inFlight: fleetRootInFlightSteps(record.id).map((step) => ({
				stepId: step.stepId,
				kind: step.kind,
				runId: step.assignmentId,
				agentId: step.agentId ?? null,
				commandId: step.commandId ?? null,
				dispatchedAt: step.at,
			})),
		}));
}

/**
 * The snapshot with no ledger rows: the settings read (a settings warning still prints; the project scope needs the
 * worktree root only to place a run, so a failure is ignored), then the admission gate through its owner, which
 * takes the state lock and clears an expired drain.
 */
async function emptySnapshot(all: boolean, nowMs: number): Promise<StatusSnapshot> {
	// Loaded here, not imported: the settings schema and the admission store share build chunks with provider and
	// session modules, which this leaf's static closure keeps out (instant-shell-import-graph pins it).
	const { readSettings } = await import("../core/config.js");
	try {
		readSettings();
	} catch {
		// A ledger with no rows needs no worktree root.
	}
	const { capacityDrain } = await import("../domains/dispatch/capacity-lease.js");
	return {
		generatedAt: new Date(nowMs).toISOString(),
		admission: admissionStatus(capacityDrain(nowMs)),
		running: [],
		roots: await runningRoots(all),
		retrying: [],
		runs: [],
		totals: emptyFleetTotals(),
	};
}

function rowHeartbeat(row: RunEnvelope): RunningRow["heartbeat"] {
	if (row.status === "stale") return "stale";
	if (row.status === "dead") return "dead";
	return row.pid !== null && processAlive(row.pid) ? "alive" : "dead";
}

/**
 * The snapshot over ledger rows: the project scope (which reads the settings), the ledger, each visible run's
 * journal folded by the read model, then the admission gate. Only the light reader opens a run journal; the session
 * domain's loader would load the telemetry domain module and the dispatch extension behind it.
 */
async function ledgerSnapshot(all: boolean, nowMs: number): Promise<StatusSnapshot> {
	const [{ fleetInspectionScope }, { openLedger }, { readRunCallsJournalSource }, { runTelemetry }, { fleetTotals }] =
		await Promise.all([
			import("./fleet-project-scope.js"),
			import("../domains/dispatch/state.js"),
			import("../domains/telemetry/run-journal-read.js"),
			import("../domains/telemetry/read-model-runs.js"),
			import("../domains/telemetry/read-model-usage.js"),
		]);
	const scope = fleetInspectionScope(all);
	const stateDir = pancodeStateDir();
	const now = new Date(nowMs);
	const records = openLedger()
		.list()
		.filter(scope.seesRun)
		.map((row) => ({ row, telemetry: runTelemetry(row.id, readRunCallsJournalSource(stateDir, row.id), { now }) }));
	const { capacityDrain } = await import("../domains/dispatch/capacity-lease.js");
	return {
		generatedAt: now.toISOString(),
		admission: admissionStatus(capacityDrain(nowMs)),
		running: records
			.filter(({ row }) => row.endedAt === null && (row.status === "running" || row.status === "stale"))
			.map(({ row, telemetry }) => ({
				runId: row.id,
				agentId: row.agentId,
				budget: row.budget ?? null,
				runtimeKind: row.runtimeKind,
				outcomePhase: row.status,
				heartbeat: rowHeartbeat(row),
				lineage: row.lineage ?? { parentRunId: null, rootRunId: row.id, attempt: 0, depth: 0 },
				startedAt: row.startedAt,
				elapsed: telemetry.activity.elapsed,
				tokens: telemetry.tokens,
				usd: telemetry.row.usd,
				node: row.node?.id ?? "local",
			})),
		roots: await runningRoots(all),
		retrying: [],
		runs: records.map(({ row, telemetry }) => ({
			runId: row.id,
			agentId: row.agentId,
			state: (row.endedAt !== null ? row.outcome : null) ?? row.status,
			startedAt: row.startedAt,
			endedAt: row.endedAt,
			elapsed: telemetry.activity.elapsed,
			usd: telemetry.row.usd,
			node: row.node?.id ?? "local",
		})),
		totals: fleetTotals(records.map(({ telemetry }) => telemetry)),
	};
}

/**
 * The token total and its parts. When every part misses the same calls the total does, the unknown calls are named
 * once after the parts; parts that miss different calls each keep their own count (fleet finding 17).
 */
function tokensText(t: StatusSnapshot["totals"]): string {
	const parts = [
		["in", t.input],
		["cached", t.cacheRead],
		["cacheWrite", t.cacheWrite],
		["out", t.output],
	] as const;
	const gap = t.total.fact.unknownCount;
	if (gap > 0 && parts.every(([, part]) => part.fact.unknownCount === gap)) {
		const known = parts.map(([label, part]) => `${label}=${renderCountSumKnown(part.fact)}`).join(" ");
		return `${renderCountSumKnown(t.total.fact)} (${known}; ${gap} ${gap === 1 ? "call" : "calls"} unknown)`;
	}
	return `${t.total.display} (${parts.map(([label, part]) => `${label}=${part.display}`).join(" ")})`;
}

async function writeStatusText(out: StatusWriter, snapshot: StatusSnapshot): Promise<void> {
	const admission = snapshot.admission;
	out.write(`dispatch status @ ${snapshot.generatedAt} (ledger: ${pancodeStateDir()})\n`);
	out.write(
		admission.state === "draining"
			? `admission: draining until ${admission.expiresAt} (requested by pid ${admission.requestedByPid} at ${admission.requestedAt})\n`
			: "admission: open\n",
	);
	// An agent step's worker is a ledger row already; a code step has none, so it is listed from its root.
	const codeSteps = snapshot.roots.flatMap((root) =>
		root.inFlight.filter((step) => step.kind === "code").map((step) => ({ root, step })),
	);
	const nowMs = Date.parse(snapshot.generatedAt);
	if (snapshot.running.length === 0 && codeSteps.length === 0) {
		out.write("running: none\n");
	} else {
		const budgets = snapshot.running.some((row) => row.budget !== null)
			? await import("../core/run-budget-envelope.js")
			: null;
		out.write("running:\n");
		for (const row of snapshot.running) {
			const lineage = row.lineage;
			out.write(
				`  ${row.runId}  ${row.agentId}  node=${row.node}  ${row.heartbeat}  attempt=${lineage.attempt} depth=${lineage.depth}  ${row.elapsed.display}  ${row.usd.display}\n`,
			);
			const budget = row.budget === null || budgets === null ? undefined : budgets.cloneRunToolBudgetEnvelope(row.budget);
			if (budget !== undefined && budgets !== null) {
				out.write(`    recipe policy: ${budgets.formatBudgetPolicy(budget)}\n`);
				out.write(`    requested envelope: ${budgets.formatBudgetRequest(budget)}\n`);
				out.write(`    effective envelope: ${budgets.formatEffectiveBudget(budget)}\n`);
				out.write(`    clamp or escalation reason: ${budgets.formatBudgetReasons(budget)}\n`);
			}
		}
		for (const { root, step } of codeSteps) {
			const elapsed = Math.max(0, Math.round((nowMs - Date.parse(step.dispatchedAt)) / 1000));
			out.write(
				`  ${step.runId}  code step ${step.stepId}  command=${step.commandId ?? "?"}  root=${root.rootId}  ${elapsed}s\n`,
			);
		}
	}
	if (snapshot.roots.length > 0) {
		out.write("fleet roots running:\n");
		for (const root of snapshot.roots) {
			const steps = root.inFlight.map((step) => step.stepId).join(", ");
			out.write(
				`  ${root.rootId}  ${root.playbook}  ${root.settledStepCount}/${root.stepCount} steps settled  in flight: ${steps.length > 0 ? steps : "none"}\n`,
			);
		}
	}
	if (snapshot.retrying.length === 0) {
		out.write("retrying: none (retry queue is in-memory and only visible in the owning process)\n");
	} else {
		out.write("retrying:\n");
		for (const row of snapshot.retrying) {
			out.write(`  ${row.runId}  ${row.agentId}  attempt=${row.attempt} due=${row.dueAt}  ${row.reason}\n`);
		}
	}
	if (snapshot.runs.length === 0) {
		out.write("runs: none\n");
	} else {
		out.write(`runs (${snapshot.runs.length}, newest first; fleet view <run id> reads one):\n`);
		for (const row of snapshot.runs) {
			out.write(
				`  ${row.runId}  ${row.agentId}  ${row.state}  node=${row.node}  ${row.startedAt}  ${row.elapsed.display}  ${row.usd.display}\n`,
			);
		}
	}
	out.write(
		`totals: tokens=${tokensText(snapshot.totals)} cost=${snapshot.totals.usd.display} runtime=${snapshot.totals.elapsed.display}\n`,
	);
}

/** `fleet status` with the arguments after `status`; src/cli/index.ts and fleet.ts both answer it here. */
export async function runFleetStatus(
	flags: ReadonlyArray<string>,
	stdout: StatusWriter = process.stdout,
	stderr: StatusWriter = process.stderr,
): Promise<number> {
	const unknown = flags.find((arg) => arg !== "--json" && arg !== "--all");
	if (unknown) {
		stderr.write(`pancode fleet: status: unknown flag: ${unknown}\n`);
		return 2;
	}
	const nowMs = Date.now();
	const all = flags.includes("--all");
	const snapshot = ledgerHasNoRows() ? await emptySnapshot(all, nowMs) : await ledgerSnapshot(all, nowMs);
	if (flags.includes("--json")) {
		stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return 0;
	}
	await writeStatusText(stdout, snapshot);
	return 0;
}
