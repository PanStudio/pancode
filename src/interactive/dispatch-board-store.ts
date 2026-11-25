// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The dispatch board store: telemetry runs and fleet plans folded into ordered board rows. */
import type { FactMetric } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import { fleetNodeTaskBrief } from "../domains/dispatch/fleet-node-prompt.js";
import type { TelemetryContract, TelemetryRunSummary, TelemetryView } from "../domains/telemetry/contract.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import { withCouncilSiblings } from "./dispatch-board-items.js";
import { planProgressText } from "./dispatch-plan-card.js";
import {
	completedRunFailure,
	type DispatchBoardPhase,
	type DispatchBoardRow,
	type DispatchBoardStatus,
	type DispatchRunUsage,
	isTerminalStatus,
	STATUS_ORDER,
} from "./dispatch-row-model.js";
import { createFleetPlanRuns, type FleetPlanRuns, type FleetPlanRunView } from "./fleet-plan-runs.js";
import { routeFirstOutput } from "./footer/silence-note.js";

/**
 * A run the operator's fleet surfaces show. Helper runs are PanCode's own and stay off them, but a council member runs in
 * the helper audience while answering the operator's own /council question, so it counts: without it a running
 * council left the dock and the rail empty.
 */
function isOperatorFleetRun(row: Pick<DispatchBoardRow, "agentAudience" | "council">): boolean {
	return row.council !== undefined || !isHelperRun(row);
}

/**
 * The live runs a summary surface counts: a running plan already names the steps it is running, so the workers those
 * steps started are its own and not more work beside it. Counted apart they read `+ 2 running` under the plan that
 * listed them.
 */
function summaryFleetRuns(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const operator = rows.filter(isOperatorFleetRun);
	const planLive = operator.some((row) => row.plan !== undefined && !isTerminalStatus(row.status));
	// A step's worker waiting on the operator stays: that wait is the part that blocks the plan.
	const summary = planLive
		? operator.filter(
				(row) => row.plan !== undefined || row.phase === undefined || row.progress?.awaitingApproval === true,
			)
		: operator;
	return summary.sort(
		(a, b) => Number(b.progress?.awaitingApproval === true) - Number(a.progress?.awaitingApproval === true),
	);
}

/**
 * The runs a turn's dispatch wait stands behind: the summary's runs and the helper-audience runs the turn dispatched
 * itself. A shadow recipe such as scout is the model's own worker, so leaving it out read `waiting for a worker` over
 * two running scouts while the footer counted 2 (FX-7b).
 */
export function dispatchWaitRuns(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const summary = summaryFleetRuns(rows);
	const counted = new Set(summary.map((row) => row.runId));
	const dispatched = rows.filter(
		(row) =>
			!counted.has(row.runId) && isHelperRun(row) && row.requestOrigin === "agent" && !isTerminalStatus(row.status),
	);
	return [...summary, ...dispatched];
}

function toRow(
	entry: TelemetryRunSummary,
	now: number,
	usage: DispatchRunUsage,
	ttft: string | null,
): DispatchBoardRow {
	const retry = entry.retry;
	const progress = entry.progress;
	return {
		...(progress !== undefined ? { progress } : {}),
		...(entry.resultContract !== undefined ? { resultContract: entry.resultContract } : {}),
		...(entry.commitPlacement !== undefined ? { commitPlacement: { ...entry.commitPlacement } } : {}),
		runId: entry.runId,
		agentId: entry.agentId,
		...(entry.agentAudience !== undefined ? { agentAudience: entry.agentAudience } : {}),
		...(entry.requestOrigin !== undefined ? { requestOrigin: entry.rootRequestOrigin ?? entry.requestOrigin } : {}),
		runtimeKind: entry.runtimeKind ?? "http",
		runtimeId: entry.runtimeId ?? "-",
		targetId: entry.targetId ?? "-",
		wireModelId: entry.modelId ?? "-",
		...(entry.endpoint !== undefined ? { endpoint: { ...entry.endpoint } } : {}),
		...(entry.taskSummary !== undefined ? { taskSummary: fleetNodeTaskBrief(entry.taskSummary) } : {}),
		...(entry.budget !== undefined ? { budget: entry.budget } : {}),
		status: entry.status,
		elapsedMs: entry.durationMs ?? Math.max(0, (entry.finishedAtMs ?? now) - entry.startedAtMs),
		settledAtMs: entry.finishedAtMs ?? entry.startedAtMs,
		usage,
		ttft,
		...(entry.outcomeDetail !== undefined ? { outcomeDetail: entry.outcomeDetail } : {}),
		...(entry.node !== undefined ? { node: entry.node } : {}),
		...(entry.foreign === true ? { foreign: true as const } : {}),
		...(entry.gate !== undefined ? { gate: { ...entry.gate } } : {}),
		...(entry.council !== undefined ? { council: { ...entry.council } } : {}),
		...(entry.hostVerification !== undefined ? { hostVerification: entry.hostVerification } : {}),
		...(entry.trust !== undefined ? { trust: entry.trust } : {}),
		...(entry.validationFailure !== undefined ? { validationFailure: entry.validationFailure } : {}),
		...(entry.reviewFindings !== undefined ? { reviewFindings: entry.reviewFindings } : {}),
		...(entry.completion !== undefined ? { completion: { ...entry.completion } } : {}),
		...(entry.rerouteCount !== undefined ? { rerouteCount: entry.rerouteCount } : {}),
		...(entry.failoverHops !== undefined ? { failoverHops: entry.failoverHops } : {}),
		...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
		lastContextTokens: entry.lastContextTokens ?? null,
		...(entry.runRecordId !== undefined ? { runRecordId: entry.runRecordId } : {}),
		...(entry.phase !== undefined ? { phase: { ...entry.phase } } : {}),
		// Both tool fields are views of the one projection, so the compact card and
		// the expanded detail can never disagree about what is running.
		currentTool: retry ? null : (progress?.currentAction?.tool ?? null),
		recentTools: progress?.recentActions.map((action) => action.tool) ?? [],
		...(retry ? { retry: { ...retry } } : {}),
		...(entry.steerAcknowledgement ? { steerAcknowledgement: { ...entry.steerAcknowledgement } } : {}),
		...(entry.writeRecordDowngrade ? { writeRecordDowngrade: { ...entry.writeRecordDowngrade } } : {}),
	};
}

const UNAVAILABLE: DispatchRunUsage = { kind: "unavailable" };
const PENDING: DispatchRunUsage = { kind: "pending" };
const runUsages = new WeakMap<TelemetryView, Map<string, DispatchRunUsage>>();

/** Each run the bound session references, read once per view: the read model folds, the board only looks up. */
function runUsagesOf(view: TelemetryView): Map<string, DispatchRunUsage> {
	let usages = runUsages.get(view);
	if (usages) return usages;
	usages = new Map();
	for (const run of view.runs()) {
		const quantity = (metric: FactMetric) => view.quantity(factRef({ scope: "run", owner: run.runId, metric }));
		const prompt = quantity("prompt");
		const output = quantity("output");
		usages.set(
			run.runId,
			prompt && output ? { kind: "ready", prompt, output, total: run.tokens, usd: run.usd } : PENDING,
		);
	}
	runUsages.set(view, usages);
	return usages;
}

const runTtfts = new WeakMap<TelemetryView, Map<string, string | null>>();

/**
 * The run's first generated token, send to first token of its earliest attempt that produced one, as the read model
 * folds the run's journal: never an orchestrator clock that also counts the worker's startup, and never hidden by a
 * failed attempt before it (#434). Null until such an attempt settles.
 */
function dispatchRunTtft(view: TelemetryView | null | undefined, runId: string): string | null {
	if (!view) return null;
	let ttfts = runTtfts.get(view);
	if (!ttfts) {
		ttfts = new Map();
		runTtfts.set(view, ttfts);
	}
	if (ttfts.has(runId)) return ttfts.get(runId) ?? null;
	const first = view.quantity(factRef({ scope: "run", owner: runId, metric: "firstToken" }));
	const kind = first && "kind" in first.fact ? first.fact.kind : null;
	const ttft = first && (kind === "measured" || kind === "estimated") ? first.display : null;
	ttfts.set(runId, ttft);
	return ttft;
}

/** A run's usage in one telemetry view: unavailable without a view, pending until the view's session references it. */
export function dispatchRunUsage(view: TelemetryView | null | undefined, runId: string): DispatchRunUsage {
	return view ? (runUsagesOf(view).get(runId) ?? PENDING) : UNAVAILABLE;
}

const FLEET_PLAN_ROW_STATUS: Record<FleetPlanRunView["state"], DispatchBoardStatus> = {
	running: "running",
	cancelling: "cancelling",
	cancelled: "aborted",
	passed: "completed",
	failed: "failed",
	unsettled: "stale",
};

/** The plan with each agent step's worker run read in, so a step never says less than that run's own row. */
function planWithWorkers(plan: FleetPlanRunView, workers: ReadonlyMap<string, DispatchBoardRow>): FleetPlanRunView {
	if (!plan.steps.some((step) => step.runId !== undefined && workers.has(step.runId))) return plan;
	return {
		...plan,
		steps: plan.steps.map((step) => {
			const row = step.runId === undefined ? undefined : workers.get(step.runId);
			if (row === undefined) return step;
			const caveat = completedRunFailure(row);
			return { ...step, worker: { settled: isTerminalStatus(row.status), caveat: caveat?.words ?? null } };
		}),
	};
}

/** The plan as its settled card reads it, with each step's worker run from these rows. */
export function planWithWorkerRows(plan: FleetPlanRunView, rows: ReadonlyArray<DispatchBoardRow>): FleetPlanRunView {
	return planWithWorkers(plan, new Map(rows.map((row) => [row.runId, row])));
}

function fleetPlanRow(plan: FleetPlanRunView, now: number): DispatchBoardRow {
	return {
		runId: plan.rootId,
		agentId: `plan ${plan.name}`,
		requestOrigin: "user",
		runtimeKind: "http",
		runtimeId: "fleet",
		targetId: "",
		wireModelId: "",
		taskSummary: planProgressText(plan),
		status: FLEET_PLAN_ROW_STATUS[plan.state],
		elapsedMs: (plan.finishedAtMs ?? now) - plan.startedAtMs,
		settledAtMs: plan.finishedAtMs ?? plan.startedAtMs,
		...(plan.earlier === true ? { earlier: true as const } : {}),
		usage: UNAVAILABLE,
		ttft: null,
		lastContextTokens: null,
		plan,
	};
}

/**
 * The board's one order: runs still going first, in the order a person acts on them, then settled runs newest first
 * whatever their outcome. Opening the board puts the cursor on the first row, so that row is the run the operator
 * most likely came for; ordering settled runs by outcome put an old failure above the run that just finished.
 */
function boardOrder(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const live = (row: DispatchBoardRow): boolean => !isTerminalStatus(row.status);
	return [...rows].sort((a, b) => {
		if (live(a) !== live(b)) return live(a) ? -1 : 1;
		// A running plan leads the workers its steps started, so the board reads plan, then its steps' runs.
		if (live(a))
			return (
				STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
				Number(b.plan !== undefined) - Number(a.plan !== undefined) ||
				(b.settledAtMs ?? 0) - (a.settledAtMs ?? 0)
			);
		return (b.settledAtMs ?? 0) - (a.settledAtMs ?? 0);
	});
}

/** The board keeps display order and reads every run fact from telemetry; tokens and cost from its read model. */
export function createDispatchBoardStore(
	projection: Pick<TelemetryContract, "snapshot" | "subscribe" | "reconcileRuns" | "setFleetPhase" | "read">,
	readDurablePlans?: () => ReadonlyArray<FleetPlanRunView>,
	/** The earlier runs loaded so far; read on every call until `complete`, then held. */
	readDurableRuns?: () => { rows: ReadonlyArray<DispatchBoardRow>; complete: boolean },
	/** A settled run's usage from its own record, for a run this session's journal never referenced, such as a plan step. */
	readRecordedUsage?: (runId: string) => DispatchRunUsage,
): {
	rows(): ReadonlyArray<DispatchBoardRow>;
	activeRows(): ReadonlyArray<DispatchBoardRow>;
	/** What the fleet card shows: plans running now, then the active workers. */
	liveRows(): ReadonlyArray<DispatchBoardRow>;
	/**
	 * Every worker run the board shows, without the plan rows, in the board's order: this process's, then the ones an
	 * earlier PanCode recorded. What a count or usage of workers reads.
	 */
	workerRows(): ReadonlyArray<DispatchBoardRow>;
	/** This process's worker runs only, live and settled: what the footer band's unacknowledged failures read. */
	sessionWorkerRows(): ReadonlyArray<DispatchBoardRow>;
	reconcile(): void;
	setFleetPhase(runId: string, phase: DispatchBoardPhase): void;
	/** Plans this session started and the durable ones before it; their rows join `rows()` but never `activeRows()`. */
	plans: FleetPlanRuns;
	unsubscribe(): void;
} {
	let current = projection.snapshot();
	const plans = createFleetPlanRuns(Date.now, readDurablePlans);
	const unsubscribe = projection.subscribe((snapshot) => {
		current = snapshot;
	});
	// Settled workers from before this process, held once complete like the durable plans; until then a paint shows
	// what has loaded. A run this process folds outranks its earlier row.
	let earlierRuns: ReadonlyArray<DispatchBoardRow> | null = null;
	const historyRows = (): ReadonlyArray<DispatchBoardRow> => {
		let loaded = earlierRuns;
		if (loaded === null) {
			try {
				const read = readDurableRuns?.() ?? { rows: [], complete: true };
				loaded = read.rows;
				if (read.complete) earlierRuns = loaded;
			} catch {
				// An unreadable ledger costs the history, never the board.
				earlierRuns = loaded = [];
			}
		}
		const live = new Set(current.runs.map((run) => run.runId));
		const view = projection.read?.live() ?? null;
		return loaded
			.filter((row) => !live.has(row.runId))
			.map((row) => {
				const telemetry = view?.run(row.runId) ?? null;
				return telemetry === null
					? row
					: { ...row, usage: dispatchRunUsage(view, row.runId), ttft: dispatchRunTtft(view, row.runId), telemetry };
			});
	};
	// Read once per settled run: its record no longer changes, and a repaint must not read the disk.
	const recorded = new Map<string, DispatchRunUsage>();
	const settledUsage = (runId: string, usage: DispatchRunUsage): DispatchRunUsage => {
		if (usage.kind !== "pending" || readRecordedUsage === undefined) return usage;
		let found = recorded.get(runId);
		if (found === undefined) {
			try {
				found = readRecordedUsage(runId);
			} catch {
				// An unreadable record leaves the usage pending, which the row already words.
				found = usage;
			}
			recorded.set(runId, found);
		}
		return found.kind === "ready" ? found : usage;
	};
	const projectRows = (activeOnly: boolean): ReadonlyArray<DispatchBoardRow> => {
		const view = projection.read?.live() ?? null;
		return [...current.runs]
			.reverse()
			.sort(
				(a, b) =>
					STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
					(b.finishedAtMs ?? b.startedAtMs) - (a.finishedAtMs ?? a.startedAtMs),
			)
			.map((run) => {
				const live = dispatchRunUsage(view, run.runId);
				const usage = isTerminalStatus(run.status) ? settledUsage(run.runId, live) : live;
				const row = toRow(run, current.generatedAt, usage, dispatchRunTtft(view, run.runId));
				return {
					...row,
					telemetry: view?.run(run.runId) ?? null,
					...(row.status === "running"
						? { routeFirstOutput: routeFirstOutput(view, row.targetId, row.wireModelId, "worker") }
						: {}),
				};
			})
			.filter((row) => !activeOnly || !isTerminalStatus(row.status));
	};
	const emptyRows: ReadonlyArray<DispatchBoardRow> = [];
	return {
		plans,
		rows() {
			const workers = projectRows(false);
			const byRun = new Map(workers.map((row) => [row.runId, row]));
			const planRows = plans.runs().map((plan) => fleetPlanRow(planWithWorkers(plan, byRun), Date.now()));
			const earlier = historyRows();
			if (planRows.length === 0 && earlier.length === 0) return boardOrder(workers);
			// This process's runs lead; what an earlier PanCode recorded follows as its own section, newest first.
			return [
				...boardOrder([...workers, ...planRows.filter((row) => row.earlier !== true)]),
				...boardOrder([...planRows.filter((row) => row.earlier === true), ...earlier]),
			];
		},
		activeRows: () => (current.runs.length === 0 ? emptyRows : projectRows(true)),
		liveRows: () => {
			// Fast path when no runs or plans are active: avoids sorting and projecting on every keystroke.
			const live = plans.live();
			if (current.runs.length === 0 && live.length === 0) return emptyRows;
			// One projection per frame: the active rows and their settled council siblings are both read from it.
			const all = projectRows(false);
			const workers = withCouncilSiblings(
				all.filter((row) => !isTerminalStatus(row.status)),
				all,
			);
			if (live.length === 0) return workers;
			const byRun = new Map(all.map((row) => [row.runId, row]));
			return [...live.map((plan) => fleetPlanRow(planWithWorkers(plan, byRun), Date.now())), ...workers];
		},
		workerRows: () => [...boardOrder(projectRows(false)), ...boardOrder(historyRows())],
		sessionWorkerRows: () => boardOrder(projectRows(false)),
		reconcile() {
			projection.reconcileRuns();
			current = projection.snapshot();
		},
		setFleetPhase(runId, phase) {
			projection.setFleetPhase(runId, phase);
			current = projection.snapshot();
		},
		unsubscribe,
	};
}
