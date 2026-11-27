// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isAbsolute } from "node:path";
import { DEFAULT_CANCEL_GRACE_MS } from "../../engine/acp/adapter.js";
import { DEFAULT_TERMINATION_GRACE_MS, DEFAULT_TERMINATION_WAIT_MS } from "../../engine/acp/transport.js";
import { asAssignmentId } from "./assignment.js";
import { cancelStoredAssignment, getStoredAssignment, subscribeStoredAssignments } from "./assignment-store.js";
import {
	getDetachedBatch,
	listDetachedBatches,
	markDetachedBatchCollected,
	markDetachedBatchOwnerTold,
	registerDetachedBatch,
} from "./batch-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { DISPATCH_DRAIN_GRACE_MS } from "./bundle-support.js";
import type { DispatchContract } from "./contract.js";
import { sealCouncilSynthesis } from "./council-synthesis.js";
import { dispatchBatch } from "./dispatch-batch.js";
import { decideGrantAsMain } from "./grant-decision.js";
import {
	getDispatchReservation,
	releaseDispatchReservation,
	rollbackDispatchReservation,
	rollbackUnconsumedDispatchReservation,
} from "./reservation-store.js";
import { type RunResult, runKindSupportsLiveSteering } from "./types.js";
import { WORKER_PROCESS_CLEANUP_BOUND_MS } from "./worker-spawn.js";

export function createDispatchContractSurface(rt: DispatchRuntime) {
	const { context, options } = rt;
	const {
		agents,
		assignments,
		collectReproducibility,
		getEffectiveSettings,
		getProtectedArtifactState,
		now,
		safety,
		scheduling,
		targetBreaker,
	} = rt.core;
	const contract: DispatchContract = {
		awaitStartupRecovery: rt.recovery.awaitStartupRecovery,
		agentTraits: (agentId) => agents.getSpec(agentId)?.traits ?? [],
		warmRouteHistory: rt.host.warmRouteHistory,
		drainAllowanceMs: () =>
			Math.max(
				WORKER_PROCESS_CLEANUP_BOUND_MS,
				DEFAULT_CANCEL_GRACE_MS + DEFAULT_TERMINATION_GRACE_MS + DEFAULT_TERMINATION_WAIT_MS,
			) + DISPATCH_DRAIN_GRACE_MS,
		publishesProgress: true,
		ownsProgressBus: (bus) => bus === context.bus,
		preview: rt.route.previewAdmission,
		budgetEconomics: rt.budget.budgetEconomics,
		primeRouteQuota: rt.quota.primeRouteQuota,
		derivedGrants: (req) => rt.preview.previewFixedStages(req, getEffectiveSettings()).grants,
		planAgentSelection: rt.route.planAgentSelection,
		routeCandidates: rt.route.routeCandidates,
		reservations: {
			prepare: rt.capacity.prepareReservation,
			release: (ownerId) => releaseDispatchReservation(ownerId, now()),
			rollback: (ownerId) => rollbackDispatchReservation(ownerId, now()),
			rollbackUnconsumed: (ownerId) => rollbackUnconsumedDispatchReservation(ownerId, now()),
			get: getDispatchReservation,
		},
		costCeilingUsd: () => scheduling.ceilingUsd(),
		maxWorkers: () => rt.capacity.configuredGlobalCapacity(getEffectiveSettings()),
		protectedArtifactState: () => getProtectedArtifactState(),
		landKeptTask: rt.grants.landKeptTask,
		dispatch: rt.drain.dispatch,
		dispatchBatch: (reqs, preparation) =>
			dispatchBatch({ contract, dispatch: rt.drain.dispatch, getEffectiveSettings }, reqs, preparation),
		sealCouncilSynthesis: (input) =>
			sealCouncilSynthesis(
				{
					collectReproducibility,
					context,
					requireLedger: rt.runs.requireLedger,
					sinklessRunContext: rt.route.sinklessRunContext,
				},
				input,
			),
		owner: () => {
			// Only a configured absolute root adds a location ownership cannot derive.
			const worktreeRoot = getEffectiveSettings()?.fleet?.worktrees?.root;
			const sessionId = options?.getSessionId?.() ?? null;
			const ancestorSessionIds = sessionId === null ? [] : rt.control.ownerAncestors(sessionId);
			return {
				sessionId,
				cwd: process.cwd(),
				...(worktreeRoot !== undefined && isAbsolute(worktreeRoot) ? { worktreeRoot } : {}),
				...(ancestorSessionIds.length > 0 ? { ancestorSessionIds } : {}),
			};
		},
		listRuns(status, where) {
			return rt.runs.requireLedger().list({
				...(status ? { status } : {}),
				...(where ? { where } : {}),
			});
		},
		subscribeChanges(listener) {
			const unsubscribes = [
				context.bus.subscribe("run.enqueued", listener),
				context.bus.subscribe("run.started", listener),
				context.bus.subscribe("run.completed", listener),
				context.bus.subscribe("run.failed", listener),
				context.bus.subscribe("approval.requested", listener),
				context.bus.subscribe("approval.resolved", listener),
			];
			try {
				unsubscribes.push(subscribeStoredAssignments(listener));
			} catch (error) {
				for (const unsubscribe of unsubscribes) unsubscribe();
				throw error;
			}
			return () => {
				for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			};
		},
		getRun(runId) {
			if (!rt.runs.ledger) return null;
			return rt.runs.ledger.get(runId);
		},
		observedRunWrites(runId) {
			// A run this process never finalized, or finalized long enough ago to
			// have been evicted, is unknown rather than silent, so both answer null.
			const attribution = rt.runs.runWriteAttributions.get(runId);
			return attribution?.complete === true ? [...attribution.recorded] : null;
		},
		observedRunWriteAttribution(runId) {
			const attribution = rt.runs.runWriteAttributions.get(runId);
			if (attribution === undefined) return null;
			return {
				recorded: [...attribution.recorded],
				complete: attribution.complete,
				downgrades: attribution.downgrades?.map((entry) => ({ ...entry })) ?? [],
			};
		},
		assignments: {
			get: (id) => assignments.get(rt.control.assignmentRootFor(id)),
			getStored: (id) => getStoredAssignment(rt.control.assignmentRootFor(id)),
			flushWrites: rt.runs.flushDurableWrites,
		},
		async drainMember(runId) {
			const root = rt.control.controlRootFor(runId);
			const errors: unknown[] = [];
			while (true) {
				const pending = [...(rt.control.memberWork.get(root) ?? [])];
				const live = rt.control.currentAssignmentRun(runId);
				if (live !== null) pending.push(live.finalPromise);
				if (pending.length === 0) break;
				for (const result of await Promise.allSettled(pending)) {
					if (result.status === "rejected" && !errors.includes(result.reason)) errors.push(result.reason);
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "dispatch member drain failed", { cause: errors[0] });
		},
		async waitForMember(runId) {
			const root = rt.control.controlRootFor(runId);
			await contract.drainMember?.(runId);
			const receipts: RunResult[] = [];
			for (const [attemptId, attempt] of rt.control.controlAttempts) {
				if (rt.control.controlRootsByAttempt.get(attemptId) === root && attempt.receipt !== undefined) {
					receipts.push(attempt.receipt);
					// #231's owner now holds the evidence; session control metadata
					// must not retain full receipts after the fleet collects them.
					delete attempt.receipt;
				}
			}
			const receipt = receipts.at(-1);
			if (receipt === undefined) throw new Error(`dispatch: member '${runId}' has no terminal run result`);
			return { receipt, receipts };
		},
		abort(runId, reason) {
			// A run another PanCode process owns: its owner takes the durable cancel request and seals it canceled.
			if (
				rt.control.currentAssignmentRun(runId) === null &&
				rt.grants.crossProcessFleet.cancelForeign(runId, reason?.detail ?? null)
			)
				return;
			const rootRunId = rt.control.controlRootFor(runId);
			const run = rt.control.currentAssignmentRun(runId);
			rt.control.canceledControlRoots.add(rootRunId);
			if (reason?.cause === "steer") rt.control.steerCanceledRoots.add(rootRunId);
			const queued = rt.capacity.pendingCapacity.get(rootRunId);
			if (queued !== undefined && rt.capacity.capacityAdmission.cancel(rootRunId)) {
				rt.runs.persistAssignment(cancelStoredAssignment(rootRunId), `${rootRunId}:cancel-queued`);
				context.bus.emit(
					"run.aborted",
					{
						source: "dispatch_abort",
						runId: rootRunId,
						startedAt: null,
						elapsedMs: null,
						reason: reason?.detail ?? "operator abort while waiting for an endpoint slot",
					},
					rt.runs.runContext(rootRunId),
				);
			}
			const assignment = assignments.get(rootRunId);
			if (assignment?.status === "running") {
				assignments.cancel(assignment.id);
				rt.runs.persistAssignment(cancelStoredAssignment(rootRunId), `${rootRunId}:cancel`);
			}
			rt.retry.writeRootPark.revoke(
				(parked) => (rt.control.controlRootsByAttempt.get(parked.runId) ?? parked.lineage.rootRunId) === rootRunId,
				"the run was cancelled",
			);
			for (const [finishedRunId, retry] of rt.retry.retryQueue) {
				if ((rt.control.controlRootsByAttempt.get(finishedRunId) ?? retry.rootRunId) !== rootRunId) continue;
				clearTimeout(retry.timer);
				retry.settleCanceled();
				rt.retry.retryQueue.delete(finishedRunId);
				if (retry.rootRunId === rootRunId) {
					rt.runs.settleAssignmentDurably(asAssignmentId(rootRunId), retry.terminalCandidate, "canceled");
				}
				context.bus.emit(
					"run.aborted",
					{
						source: "dispatch_abort",
						runId: finishedRunId,
						startedAt: null,
						elapsedMs: null,
						reason: `scheduled retry ${retry.attempt} cancelled by the operator`,
					},
					rt.runs.runContext(finishedRunId),
				);
				context.bus.emit("run.progressed", {
					runId: finishedRunId,
					agentId: retry.agentId,
					task: retry.task,
					event: { type: "retry_canceled", attempt: retry.attempt },
				});
			}
			if (!run) return;
			rt.runs.emitRunAborted(run, "dispatch_abort");
			run.aborted = true;
			rt.grants.grantBroker.revokeRun(run.runId, "the run was cancelled");
			// A timeout kill rides the abort path but must not launder into an
			// operator abort: record the cause so the receipt names the timeout.
			if (reason) {
				run.abortDetail = reason.detail;
				run.abortCause = reason.cause;
			}
			try {
				run.abort();
			} catch {
				// child may already be gone
			}
		},
		canceledBySteer(runId) {
			try {
				return rt.control.steerCanceledRoots.has(rt.control.controlRootFor(runId));
			} catch {
				return false;
			}
		},
		steer(runId, text) {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				throw new Error("steer: empty message");
			}
			const run = rt.control.currentAssignmentRun(runId);
			if (!run) {
				throw new Error(`steer: run or assignment '${runId}' is not active; only running HTTP/SDK workers accept guidance`);
			}
			if (run.aborted || run.stallKilled) {
				throw new Error(`steer: run '${runId}' is ${run.aborted ? "aborting" : "terminating"} and cannot be steered`);
			}
			if (!run.steer) {
				if (runKindSupportsLiveSteering(run.runtimeKind)) {
					throw new Error(`steer: run '${runId}' (${run.runtimeKind}:${run.runtimeId}) has no input channel`);
				}
				throw new Error(`steer: run '${runId}' (${run.runtimeKind}:${run.runtimeId}) does not support live steering`);
			}
			if (!run.steer(trimmed)) {
				if (run.runtimeKind === "acp-delegation") {
					throw new Error(
						`steer: run '${runId}' (${run.runtimeKind}:${run.runtimeId}) no longer accepts input; the delegated agent has no turn running that takes guidance`,
					);
				}
				throw new Error(`steer: run '${runId}' no longer accepts input; the worker has exited or its stdin is closed`);
			}
		},
		workerPermissionRefusal(runId, requestId) {
			const holder = rt.grants.foreignAskOwner(runId, requestId);
			return holder === null ? null : rt.grants.heldAskRefusal(holder, runId);
		},
		resolveWorkerPermission(runId, requestId, decision) {
			const refusal = contract.workerPermissionRefusal?.(runId, requestId) ?? null;
			if (refusal !== null) throw new Error(`resolveWorkerPermission: ${refusal}`);
			// A brokered request is decided against its record: the operator's
			// answer is bound to the attempt and argument digest the worker parked.
			const brokered = rt.grants.grantBroker.get(requestId);
			if (brokered !== null) {
				const elsewhere = rt.grants.answeredElsewhere.get(requestId);
				const result = rt.grants.grantBroker.decide(requestId, {
					decision,
					issuer: "operator",
					runId,
					...(elsewhere !== undefined ? { reason: rt.grants.answeredElsewhereReason(decision, elsewhere) } : {}),
				});
				if (!result.ok) throw new Error(`resolveWorkerPermission: ${result.reason}`);
				return;
			}
			// An ask another PanCode process holds: the answer goes to its run directory, and that process applies it.
			if (rt.grants.crossProcessFleet.answerForeign(runId, requestId, decision)) return;
			if (rt.grants.workerApprovalWindows.isExpired(requestId)) {
				throw new Error(`resolveWorkerPermission: run '${runId}' no longer accepts input for this ask; its window ended`);
			}
			const run = rt.control.currentAssignmentRun(runId);
			if (!run) {
				throw new Error(
					`resolveWorkerPermission: run or assignment '${runId}' is not active; only running native workers accept permission decisions`,
				);
			}
			if (run.aborted || run.stallKilled) {
				throw new Error(
					`resolveWorkerPermission: run '${runId}' is ${run.aborted ? "aborting" : "terminating"} and cannot resolve permissions`,
				);
			}
			if (!run.resolvePermission) {
				throw new Error(
					`resolveWorkerPermission: run '${runId}' (${run.runtimeKind}) has no input channel; only native workers accept permission decisions`,
				);
			}
			if (!run.resolvePermission(requestId, decision)) {
				throw new Error(
					`resolveWorkerPermission: run '${runId}' no longer accepts input; the worker has exited or its stdin is closed`,
				);
			}
			// Answered, so the window cannot send a timeout denial after this.
			rt.grants.workerApprovalWindows.settle(requestId);
		},
		workerPermissionWindow: (requestId) => rt.grants.workerApprovalWindows.read(requestId),
		workerRunEndsWithTurn: (runId) => {
			const run = rt.control.currentAssignmentRun(runId);
			if (run === null || run.requestOrigin !== "agent" || run.detached === true) return false;
			// A dispatch moved to the background belongs to its batch, beyond the turn that started it.
			const assignmentId = run.lineage.rootRunId;
			return !listDetachedBatches().some((batch) => batch.runs.some((entry) => entry.assignmentId === assignmentId));
		},
		holdWorkerPermission: (requestId) => rt.grants.workerApprovalWindows.hold(requestId),
		workerRunShellConfined: (runId) => rt.control.currentAssignmentRun(runId)?.shellConfined === true,
		restartWorkerPermission: (requestId) => rt.grants.workerApprovalWindows.restart(requestId),
		grants: {
			list(filter = {}) {
				return rt.grants.grantBroker
					.list({
						...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
						...(filter.runId !== undefined ? { runId: filter.runId } : {}),
						...(filter.pendingOnly === true ? { state: "pending" as const } : {}),
					})
					.map(rt.grants.grantView);
			},
			get(requestId) {
				const record = rt.grants.grantBroker.get(requestId);
				return record === null ? null : rt.grants.grantView(record);
			},
			onPending(listener) {
				rt.grants.grantPendingListeners.add(listener);
				return () => {
					rt.grants.grantPendingListeners.delete(listener);
				};
			},
			decideAsMain: (input) =>
				decideGrantAsMain(
					{
						foreignAskOwner: rt.grants.foreignAskOwner,
						grantAttended: rt.grants.grantAttended,
						grantBroker: rt.grants.grantBroker,
						grantView: rt.grants.grantView,
						heldAskRefusal: rt.grants.heldAskRefusal,
						safety,
					},
					input,
				),
		},
		detached: {
			register: registerDetachedBatch,
			get: getDetachedBatch,
			list: listDetachedBatches,
			markCollected: markDetachedBatchCollected,
			markOwnerTold: markDetachedBatchOwnerTold,
		},
		snapshot: rt.runs.snapshot,
		routeBreakers: () =>
			targetBreaker.snapshot().map((route) => {
				const [targetId = "", runtimeId = "", wireModelId = ""] = route.key.split("\0");
				return {
					targetId,
					runtimeId,
					wireModelId,
					state: route.state,
					remainingMs: route.remainingMs,
					reason: route.reason,
					consecutiveFailures: route.consecutiveFailures,
				};
			}),
		drain: rt.drain.drain,
	};

	return {
		contract,
	};
}
