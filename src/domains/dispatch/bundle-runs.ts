// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { resolveGuardrail } from "../../core/guardrails.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { sumFactSums, sumRunSpend } from "../../core/telemetry/pricing.js";
import { rawDurationMs } from "../../core/timers.js";
import { type LedgerAssignment, projectLedgerAssignments } from "./agent-ledger.js";
import { settleStoredAssignment } from "./assignment-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { RUN_WRITE_TARGET_HISTORY } from "./bundle-support.js";
import type { ActiveRun } from "./bundle-types.js";
import type { DispatchRequest, DispatchSnapshot } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { agentRoleFactsResolver, agentRunRoles } from "./execution-role.js";
import { classifyHeartbeat, heartbeatMonotonicAt } from "./heartbeat.js";
import { settledRowPatch } from "./orphan-recovery.js";
import { assignmentStatusForOutcome, type ResolvedTerminalReason, runStatusForOutcome } from "./outcome.js";
import { type DispatchPathScope, runLedgerProjection } from "./path-scope.js";
import { unobservedRunUsageFacts } from "./run-call-usage.js";
import { defaultRunEventJournal } from "./run-event-journal.js";
import { attachRunEventJournalBridge, type RunEventJournalBridge } from "./run-event-journal-bridge.js";
import { emitSettledDispatchEvent, type FinalizingRun, publishedLineage } from "./run-finish.js";
import { settleUnfinishedRun } from "./run-settlement.js";
import { type RunTelemetryJournal, runTelemetryJournal } from "./run-telemetry.js";
import { type Ledger, openLedger } from "./state.js";
import type { RunEnvelope, RunOutcome, RunPhaseMarks, RunResult } from "./types.js";
import { meterSpend, meterSums } from "./worker-event-fold.js";
import type { WriteBoundaryAttribution } from "./write-boundary.js";

export function createRunTable(rt: DispatchRuntime) {
	const { context, options } = rt;
	const {
		agents,
		assignments,
		getEffectiveSettings,
		heartbeatSpec,
		monotonicNow,
		now,
		recordTargetOutcome,
		recordingJournal,
	} = rt.core;
	let ledger: Ledger | null = null;
	const active = new Map<string, ActiveRun>();
	/**
	 * Attribution from each finalized run's successful tool calls, newest last.
	 * An incomplete record retains its paths as a lower bound beside the reasons
	 * it cannot be read as a closed list.
	 *
	 * Held in memory rather than sealed into the receipt: the only reader is the
	 * write boundary closing a window seconds later in this process, and a
	 * per-run path list is run-shaped evidence the receipt schema does not carry.
	 * Bounded because a long session finalizes many runs and none of this is
	 * needed once its window has closed.
	 */
	const runWriteAttributions = new Map<string, WriteBoundaryAttribution>();
	const recordRunWriteAttribution = (runId: string, attribution: WriteBoundaryAttribution): void => {
		runWriteAttributions.set(runId, attribution);
		while (runWriteAttributions.size > RUN_WRITE_TARGET_HISTORY) {
			const oldest = runWriteAttributions.keys().next();
			if (oldest.done === true) break;
			runWriteAttributions.delete(oldest.value);
		}
	};
	const durableWrites = new Set<Promise<unknown>>();

	/** Session-scope totals for the operator snapshot; finalized runs only. */
	let finalizedRuntimeSeconds = 0;
	const finalizedSpends: Array<Pick<RunResult, "spend" | "spendSums">> = [];

	function accumulateFinalizedTotals(receipt: RunResult): void {
		finalizedSpends.push({ spend: receipt.spend, spendSums: receipt.spendSums });
		const startMs = Date.parse(receipt.startedAt);
		const endMs = Date.parse(receipt.endedAt);
		if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
			finalizedRuntimeSeconds += Math.max(0, rawDurationMs(startMs, endMs)) / 1000;
		}
	}

	function trackDurableWrite<T>(operation: Promise<T>): Promise<T> {
		durableWrites.add(operation);
		operation.finally(() => durableWrites.delete(operation)).catch(() => {});
		return operation;
	}

	function persistLedgerInBackground(target: Ledger, runId: string): Promise<void> {
		return trackDurableWrite(target.persist()).catch((error) =>
			reportDispatchDiagnostic(`persist running row for run ${runId}`, error),
		);
	}

	/** A settlement can queue a reservation release as it lands, so loop until none is pending (#428). */
	async function flushDurableWrites(): Promise<void> {
		while (durableWrites.size > 0) await Promise.allSettled([...durableWrites]);
	}

	function persistAssignment(operation: Promise<unknown>, label: string): void {
		trackDurableWrite(operation).catch((error) => reportDispatchDiagnostic(`persist assignment ${label}`, error));
	}

	function settleAssignmentDurably(
		assignmentId: import("./assignment.js").AssignmentId,
		receipt: RunResult,
		status: "succeeded" | "failed" | "canceled",
		outcomeDetail?: string,
	): void {
		void trackDurableWrite(
			(async () => {
				// A failed write is reported, never swapped for the worker's real
				// outcome, and never left holding the capacity slot (#428).
				try {
					await settleStoredAssignment(assignmentId, receipt.runId, status, undefined, outcomeDetail);
				} catch (error) {
					reportDispatchDiagnostic(`persist assignment ${assignmentId}:settle:${status}`, error);
				}
				try {
					await rt.capacity.capacityAdmission.releaseAssignmentAsync(assignmentId);
				} catch (error) {
					reportDispatchDiagnostic(`release capacity for assignment ${assignmentId}`, error);
				}
				// Terminal observers must wait for both directory flushes (#428).
				try {
					assignments.settle(assignmentId, receipt, status, outcomeDetail);
				} catch (error) {
					reportDispatchDiagnostic(`settle assignment ${assignmentId}:${status}`, error);
				}
			})(),
		);
	}

	/**
	 * Finalization failed, so the normal settlement path (completeAssignmentAttempt)
	 * never ran. Settle the durable assignment against the attempt's run id, failed
	 * unless the run's settlement already landed with another outcome, so a later
	 * wait/collect can never observe a stuck "running" record. The in-memory
	 * terminal promise is rejected by the attached finalPromise.catch on the
	 * dispatch/retry handle.
	 */
	function settleAssignmentDurablyWithoutReceipt(
		rootRunId: string,
		attemptRunId: string,
		status: "succeeded" | "failed" | "canceled",
	): void {
		persistAssignment(settleStoredAssignment(rootRunId, attemptRunId, status), `${rootRunId}:finalize-error`);
		rt.capacity.capacityAdmission.releaseAssignment(rootRunId);
	}

	function requireLedger(): Ledger {
		if (!ledger) throw new Error("dispatch: ledger not initialized");
		return ledger;
	}

	function ledgerAssignmentsFor(req: DispatchRequest, scope: DispatchPathScope): ReadonlyArray<LedgerAssignment> {
		if (req.ledger === undefined) return [];
		const runs = requireLedger()
			.list()
			.filter((run) => run.projection?.ledgerId === req.ledger?.id);
		const assignments = [...projectLedgerAssignments(runs, () => null)];
		const id = req.runIdHint ?? req.lineage?.rootRunId;
		if (id !== undefined && !runs.some((run) => run.id === id)) {
			const projection = runLedgerProjection(req, scope);
			assignments.push({
				runId: id,
				assignmentId: req.lineage?.rootRunId ?? id,
				agentId: req.agentId,
				task: req.task,
				readRoots: projection.readRoots,
				writeRoots: projection.writeRoots,
				scopeSource: projection.scopeSource,
				status: "queued",
				outcome: null,
				toolCalls: null,
				grounding: null,
			});
		}
		return assignments;
	}

	/**
	 * Contains a finalization that threw (a worker promise rejection, a ledger or persist failure). Without it the
	 * run row stays "running" forever, no receipt or terminal event exists, and the active entry leaks until restart.
	 * A run whose run.settled already landed keeps that outcome: the row, the assignment and the live event follow
	 * the record, so the journal and every reader agree on how the run ended.
	 */
	async function failFinalization(
		run: FinalizingRun,
		state: {
			ledger: Ledger;
			envelope: RunEnvelope;
			runJournal: RunTelemetryJournal | undefined;
			terminal: ResolvedTerminalReason | undefined;
			timing: RunPhaseMarks;
		},
		error: unknown,
	): Promise<void> {
		const { ledger: ledgerRef, envelope } = state;
		reportDispatchDiagnostic(`finalize run ${envelope.id}`, error);
		const landed = state.runJournal?.landed()?.facts;
		if (landed !== undefined) {
			state.timing.endedAt = landed.endedAt;
			try {
				ledgerRef.update(envelope.id, settledRowPatch(landed));
				await ledgerRef.persist();
			} catch (ledgerError) {
				reportDispatchDiagnostic(`persist settled row for run ${envelope.id}`, ledgerError);
			}
			active.delete(envelope.id);
			settleAssignmentDurablyWithoutReceipt(
				run.lineage.rootRunId,
				envelope.id,
				assignmentStatusForOutcome(landed.outcome),
			);
			const exitCode = landed.exitCode ?? landed.processExitCode ?? 1;
			recordTargetOutcome(
				envelope.id,
				run.targetId,
				run.runtimeId,
				run.wireModelId,
				runStatusForOutcome(landed.outcome),
				exitCode,
				"internal",
			);
			emitSettledDispatchEvent({ context }, run, landed);
			return;
		}
		// The journal still ends with how the worker loop ended, so no reader waits on this run (#425, #434).
		const endedAt = new Date().toISOString();
		state.timing.endedAt = endedAt;
		const detail = `finalization failure: ${error instanceof Error ? error.message : String(error)}`;
		state.runJournal
			?.settle(
				settleUnfinishedRun(ledgerRef.get(envelope.id) ?? envelope, {
					terminal: state.terminal,
					outcome: "failed",
					detail,
					endedAt,
					processExitCode: null,
				}),
			)
			.catch((settleError: unknown) => reportDispatchDiagnostic(`settle run ${envelope.id}`, settleError));
		try {
			ledgerRef.update(envelope.id, {
				status: "failed",
				outcome: "failed",
				outcomeDetail: detail,
				endedAt,
				exitCode: 1,
			});
			await ledgerRef.persist();
		} catch (ledgerError) {
			reportDispatchDiagnostic(`persist failed row for run ${envelope.id}`, ledgerError);
		}
		active.delete(envelope.id);
		settleAssignmentDurablyWithoutReceipt(run.lineage.rootRunId, envelope.id, "failed");
		recordTargetOutcome(envelope.id, run.targetId, run.runtimeId, run.wireModelId, "failed", 1, "internal");
		context.bus.emit("run.failed", {
			runId: envelope.id,
			agentId: run.req.agentId,
			task: run.req.task,
			...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
			requestOrigin: run.requestOrigin,
			targetId: run.targetId,
			wireModelId: run.wireModelId,
			runtimeId: run.runtimeId,
			runtimeKind: run.runtimeKind,
			outcome: "failed" satisfies RunOutcome,
			outcomeDetail: detail,
			reason: "failed",
			lineage: publishedLineage(run.lineage, run.hostRun),
			exitCode: 1,
		});
	}
	let journalBridge: RunEventJournalBridge | null = null;

	/** The journal subscribes before anything can dispatch (start()). */
	function attachJournalBridge(): void {
		journalBridge = attachRunEventJournalBridge(context.bus, {
			acceptRun: (runId) => options?.journalRunEvents === true || recordingJournal.accepts(runId),
			journal: {
				open(id, agent) {
					if (options?.journalRunEvents === true) defaultRunEventJournal().open(id, agent);
				},
				append(id, entry) {
					recordingJournal.append(id, entry);
					if (options?.journalRunEvents === true) defaultRunEventJournal().append(id, entry);
				},
				result(id, result) {
					if (options?.journalRunEvents === true) defaultRunEventJournal().result(id, result);
				},
				terminal(id, outcome, detail) {
					recordingJournal.terminal(id, outcome, detail);
					if (options?.journalRunEvents === true) defaultRunEventJournal().terminal(id, outcome, detail);
				},
			},
		});
	}

	/** After drain(), so the last run's terminal line is written before the bridge stops listening. */
	function detachJournalBridge(): void {
		journalBridge?.stop();
		recordingJournal.stop();
		journalBridge = null;
	}

	function openRunLedger(): Ledger {
		const runLedger = openLedger({
			get maxRuns() {
				return getEffectiveSettings()?.fleet?.history?.maxRuns ?? resolveGuardrail("maxDispatchRuns");
			},
			agentRoles: (agentId) =>
				agentRunRoles(
					agentId,
					agentRoleFactsResolver((id) => agents.getSpec(id)),
				),
		});
		ledger = runLedger;
		return runLedger;
	}

	function emitRunAborted(run: ActiveRun, source: "dispatch_abort" | "dispatch_drain"): void {
		const startedMs = Date.parse(run.startedAt);
		const at = Date.now();
		const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, at - startedMs) : null;
		context.bus.emit(
			"run.aborted",
			{ source, runId: run.runId, startedAt: run.startedAt, elapsedMs, at },
			runContext(run.runId),
		);
	}

	/**
	 * An operator action reaches a run outside its async context, so the record names the run's journal. A run with no
	 * open journal, such as one still queued, falls to the current scope; the payload's runId keeps the target (#434).
	 */
	function runContext(runId: string): TelemetryContext | undefined {
		return runTelemetryJournal(runId)?.context;
	}

	/**
	 * Operator snapshot (Symphony §13.3/§13.4). Pure copy of in-memory state:
	 * no I/O, no locks. A consumer failure cannot affect orchestration because
	 * nothing here mutates dispatch state.
	 */
	function snapshot(): DispatchSnapshot {
		const tickNow = now();
		const tickMonotonic = monotonicNow();
		const running: DispatchSnapshot["running"] = [];
		let runtimeSeconds = finalizedRuntimeSeconds;
		const spends = [...finalizedSpends];
		for (const pending of rt.capacity.pendingCapacity.values()) {
			const startedAt = pending.timing.queuedAt ?? pending.timing.requestedAt ?? new Date(tickNow).toISOString();
			running.push({
				runId: pending.identity.runId,
				agentId: pending.identity.agentId,
				...(pending.identity.task !== undefined ? { task: pending.identity.task } : {}),
				...(pending.identity.budget !== undefined ? { budget: pending.identity.budget } : {}),
				runtimeKind: pending.identity.runtimeKind,
				outcomePhase: "queued",
				heartbeat: "n/a",
				lineage: { parentRunId: null, rootRunId: pending.identity.runId, attempt: 0, depth: 0 },
				startedAt,
				elapsedMs: 0,
				spend: unobservedRunUsageFacts(),
				node: pending.node === null ? null : { ...pending.node },
			});
		}
		for (const run of active.values()) {
			let heartbeat: "alive" | "stale" | "dead" | "n/a" = "n/a";
			if (run.heartbeatAt && Number.isFinite(heartbeatMonotonicAt(run.heartbeatAt))) {
				const heartbeatMonotonic = heartbeatMonotonicAt(run.heartbeatAt);
				if (run.runtimeKind === "acp-delegation") {
					const stallMs = run.stallTimeoutMs;
					if (stallMs !== null && stallMs > 0) {
						heartbeat = tickMonotonic - heartbeatMonotonic > stallMs && run.peerQuestionOpen?.() !== true ? "dead" : "alive";
					}
				} else {
					heartbeat = classifyHeartbeat(heartbeatMonotonic, tickMonotonic, heartbeatSpec);
				}
			}
			const spend = meterSpend(run.meter);
			const startedMs = Date.parse(run.startedAt);
			const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, tickNow - startedMs) : 0;
			running.push({
				runId: run.runId,
				agentId: run.agentId,
				task: run.task,
				...(run.budget !== undefined ? { budget: run.budget } : {}),
				runtimeKind: run.runtimeKind,
				outcomePhase: run.stallKilled ? "terminating" : run.aborted ? "aborting" : "running",
				heartbeat,
				lineage: publishedLineage(run.lineage, run.hostRun),
				startedAt: run.startedAt,
				elapsedMs,
				spend,
				node: run.node !== null ? { ...run.node } : null,
			});
			spends.push({ spend, spendSums: meterSums(run.meter) });
			runtimeSeconds += elapsedMs / 1000;
		}
		const retrying = [...rt.retry.retryQueue.values()].map((entry) => ({
			runId: entry.runId,
			agentId: entry.agentId,
			task: entry.task,
			attempt: entry.attempt,
			dueAt: new Date(entry.dueAt).toISOString(),
			reason: entry.reason,
		}));
		return {
			generatedAt: new Date(tickNow).toISOString(),
			running,
			retrying,
			totals: {
				tokens: sumFactSums(spends.map((run) => run.spendSums.totalTokens)),
				cost: sumRunSpend(spends),
				runtimeSeconds,
			},
		};
	}

	return {
		accumulateFinalizedTotals,
		active,
		attachJournalBridge,
		detachJournalBridge,
		emitRunAborted,
		failFinalization,
		flushDurableWrites,
		get journalBridge() {
			return journalBridge;
		},
		get ledger() {
			return ledger;
		},
		ledgerAssignmentsFor,
		openRunLedger,
		persistAssignment,
		persistLedgerInBackground,
		recordRunWriteAttribution,
		requireLedger,
		runContext,
		runWriteAttributions,
		settleAssignmentDurably,
		snapshot,
		trackDurableWrite,
	};
}
