// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isDeepStrictEqual } from "node:util";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { ActiveRun } from "./bundle-types.js";
import { cancelDetail, FLEET_CANCEL_DETAIL, takeRunCancelRequest } from "./cancel-requests.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { type FailureClass, isInfrastructureFailure } from "./failure-classification.js";
import { classifyHeartbeat, type HeartbeatStamp, type HeartbeatStatus, heartbeatMonotonicAt } from "./heartbeat.js";
import type { RunEnvelope, RunOutcome, RunStatus } from "./types.js";
import { meterSpend, meterSums } from "./worker-event-fold.js";

export function createHeartbeatWatch(rt: DispatchRuntime) {
	const { context } = rt;
	const { fleetRegistry, heartbeatIntervalMs, heartbeatSpec, monotonicNow, now } = rt.core;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	/** Reap dead-node runs through the retryable stall path. */
	function reapRunsOnDeadNode(nodeId: string, excludeRunId: string): void {
		for (const other of rt.runs.active.values()) {
			if (other.runId === excludeRunId) continue;
			if (other.node?.id !== nodeId || other.aborted || other.stallKilled) continue;
			other.stallKilled = true;
			other.heartbeatStatus = "dead";
			emitHeartbeatStatus(other, "dead");
			try {
				other.kill();
			} catch {
				// channel may already be gone; the finalizer still settles the run
			}
		}
	}

	/**
	 * Per-run channel verdict feeding node classification. Completing the
	 * protocol (even with a failing exit code) proves the channel; stalls,
	 * spawn failures, and ssh exit 255 count against it. Operator cancels and
	 * policy denials are neutral.
	 */
	function recordNodeChannelOutcome(
		run: ActiveRun,
		outcome: RunOutcome,
		failureClass: FailureClass,
		detail: string | null,
	): void {
		if (!fleetRegistry || run.node === null || run.node.kind !== "ssh") return;
		if (failureClass === "node-channel") {
			const state = fleetRegistry.recordChannelFailure(run.node.id, detail ?? outcome);
			if (state === "offline") reapRunsOnDeadNode(run.node.id, run.runId);
			return;
		}
		if (outcome === "succeeded" || isInfrastructureFailure(failureClass)) {
			fleetRegistry.recordChannelSuccess(run.node.id);
		}
	}

	function heartbeatIso(heartbeat: HeartbeatStamp): string {
		return new Date(heartbeat.current).toISOString();
	}

	function heartbeatRunStatus(status: HeartbeatStatus): RunStatus {
		return status === "alive" ? "running" : status;
	}

	function emitHeartbeatStatus(run: ActiveRun, status: HeartbeatStatus): void {
		context.bus.emit("run.progressed", {
			runId: run.runId,
			agentId: run.agentId,
			task: run.task,
			targetId: run.targetId,
			wireModelId: run.wireModelId,
			runtimeId: run.runtimeId,
			runtimeKind: run.runtimeKind,
			...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
			...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
			event: {
				type: "heartbeat_status",
				status,
				heartbeatAt: run.heartbeatAt ? heartbeatIso(run.heartbeatAt) : null,
			},
		});
	}

	/**
	 * Reconciler tick (Symphony §8.1: reconcile before dispatch). Observes
	 * every running entry and acts on the classification: a stale native
	 * worker gets one operator-visible warning per transition, a dead one is
	 * terminated through the SIGTERM→SIGKILL path and finalized as stalled by
	 * the run's own finalizer. ACP delegations have no periodic heartbeat, so
	 * they are bounded by an event-inactivity stall window instead of the
	 * native heartbeat spec. This loop runs on its own timer and never
	 * consults admission gates: a budget ceiling breach cannot prevent the
	 * reconciler from killing a dead worker.
	 */
	/**
	 * A live worker's spend never rewrites runs.json: at the 1000-row cap each rewrite is about 14 MiB fsynced and every
	 * board re-parses it, while every reader in another process folds spend from the run's journal and this process
	 * reads its meters. The tick still carries spend into the in-memory row, which any lifecycle write takes along. Only
	 * a heartbeat transition writes here, so a sibling's `fleet status` sees a stale or dead row (FL-24).
	 */
	let heartbeatLedgerWrite: Promise<void> | null = null;
	let heartbeatTransitionPending = false;

	function checkActiveHeartbeats(): void {
		if (!rt.runs.ledger) return;
		consumeOperatorCancelRequests();
		const tickMonotonic = monotonicNow();
		for (const run of rt.runs.active.values()) {
			if (run.aborted || run.stallKilled || run.sealing === true) continue;
			const row = rt.runs.ledger.peek(run.runId);
			// Finalizers keep active entries while persisting their sealed receipt.
			if (!row || row.endedAt !== null) continue;
			const spend = meterSpend(run.meter);
			const spendSums = meterSums(run.meter);
			if (!isDeepStrictEqual(row.spend, spend) || !isDeepStrictEqual(row.spendSums, spendSums)) {
				rt.runs.ledger.update(run.runId, { spend, spendSums });
			}
			if (run.awaitingOperator === true) {
				// The orchestrator is the live party; keep the row fresh and unclassified.
				rt.runs.ledger.update(run.runId, {
					status: "running",
					pid: process.pid,
					heartbeatAt: new Date(now()).toISOString(),
				});
				continue;
			}
			if (!run.heartbeatAt) continue;
			const heartbeatMonotonic = heartbeatMonotonicAt(run.heartbeatAt);
			if (!Number.isFinite(heartbeatMonotonic) || !Number.isFinite(run.heartbeatAt.current)) continue;
			if (run.runtimeKind === "acp-delegation") {
				rt.runs.ledger.update(run.runId, { heartbeatAt: heartbeatIso(run.heartbeatAt) });
				const stallMs = run.stallTimeoutMs;
				if (stallMs === null || stallMs <= 0 || run.peerQuestionOpen?.() === true) continue;
				if (tickMonotonic - heartbeatMonotonic <= stallMs) continue;
				run.stallKilled = true;
				run.heartbeatStatus = "dead";
				emitHeartbeatStatus(run, "dead");
				try {
					run.kill();
				} catch {
					// peer may have exited between classification and kill
				}
				continue;
			}
			const status = classifyHeartbeat(heartbeatMonotonic, tickMonotonic, heartbeatSpec);
			const patch: Partial<RunEnvelope> = {
				status: heartbeatRunStatus(status),
				heartbeatAt: heartbeatIso(run.heartbeatAt),
			};
			rt.runs.ledger.update(run.runId, patch);
			// Node staleness display feeds off the freshest worker heartbeat.
			if (status === "alive" && run.node !== null && run.node.kind === "ssh") {
				fleetRegistry?.seen(run.node.id);
			}
			if (status === run.heartbeatStatus) continue;
			run.heartbeatStatus = status;
			heartbeatTransitionPending = true;
			emitHeartbeatStatus(run, status);
			if (status !== "dead") continue;
			run.stallKilled = true;
			try {
				run.kill();
			} catch {
				// child may have exited between classification and reap attempt
			}
		}
		// One write covers every run that moved this tick; a transition during a write waits for the next tick. A failed
		// write leaves its rows dirty for the next lifecycle persist rather than retrying every tick (#428).
		if (heartbeatTransitionPending && heartbeatLedgerWrite === null) {
			heartbeatTransitionPending = false;
			heartbeatLedgerWrite = rt.runs
				.trackDurableWrite(rt.runs.ledger.persist())
				.catch((error: unknown) => reportDispatchDiagnostic("persist heartbeat transition", error))
				.finally(() => {
					heartbeatLedgerWrite = null;
				});
		}
	}

	/**
	 * `fleet cancel` runs in another process and cannot reach this process's
	 * abort handles, so it leaves a request file per run. Only the process
	 * holding the run acts on it, through the same abort an in-process cancel
	 * uses, so the run seals `canceled` with a complete receipt.
	 */
	function consumeOperatorCancelRequests(): void {
		for (const run of [...rt.runs.active.values()]) {
			let request: ReturnType<typeof takeRunCancelRequest>;
			try {
				request = takeRunCancelRequest(run.runId);
			} catch (error) {
				reportDispatchDiagnostic(`read cancel request for run ${run.runId}`, error);
				continue;
			}
			if (request === null || run.aborted || run.stallKilled) continue;
			rt.contract.contract.abort(run.runId, {
				cause: "operator",
				detail: cancelDetail(FLEET_CANCEL_DETAIL, request.reason),
			});
		}
	}

	/**
	 * Every run's deadline (its wall clock, or an earlier one the call set) outlives queue admission and the caller, so a
	 * detached run is stopped too; it seals timed_out through the ordinary abort path (DESIGN 4.5).
	 */
	function watchAssignmentDeadline(run: ActiveRun): void {
		const deadlineAt = run.req.assignmentDeadlineAt;
		if (deadlineAt === undefined) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const check = (): void => {
			if (settled || run.aborted || run.stallKilled) return;
			const remaining = deadlineAt - now();
			if (remaining <= 0) {
				rt.contract.contract.abort(run.runId, {
					cause: "timeout",
					detail: "timed out: explicit assignment deadline reached",
				});
			} else timer = setTimeout(check, Math.min(2_147_483_647, remaining));
		};
		const close = (): void => {
			settled = true;
			clearTimeout(timer);
		};
		void run.promise.then(close, close);
		check();
	}

	function startHeartbeatWatchdog(): void {
		if (heartbeatTimer || heartbeatIntervalMs <= 0) return;
		heartbeatTimer = setInterval(checkActiveHeartbeats, heartbeatIntervalMs);
		heartbeatTimer.unref?.();
	}

	function stopHeartbeatWatchdog(): void {
		if (!heartbeatTimer) return;
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	return {
		heartbeatIso,
		recordNodeChannelOutcome,
		startHeartbeatWatchdog,
		stopHeartbeatWatchdog,
		watchAssignmentDeadline,
	};
}
