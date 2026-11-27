// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { engineRetryDelayMs } from "../../engine/ai.js";
import { classify as classifyAction } from "../safety/action-classifier.js";
import { asAssignmentId } from "./assignment.js";
import { recordAssignmentAttempt, registerAssignment } from "./assignment-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { ActiveRun, RetryQueueEntry, RetryScheduleResult } from "./bundle-types.js";
import type { DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { decideRetry, type FailureClass, failureClassWords } from "./failure-classification.js";
import { OBLIGATION_RETRY_LIMIT, type Obligation } from "./obligation.js";
import { assignmentStatusForOutcome } from "./outcome.js";
import * as recovery from "./recovery-candidates.js";
import { getDispatchReservation } from "./reservation-store.js";
import { planObligationRetry, planOverflowRetry } from "./retry-route-plan.js";
import { hasPotentiallyMutatingAttempt } from "./tool-stats.js";
import { RETRYABLE_OUTCOMES, type RunOutcome, type RunResult } from "./types.js";
import type { DispatchFailoverCandidate, DispatchFailoverMode } from "./validation.js";
import { createWriteRootPark } from "./write-root-requests.js";

export function createRetryMachine(rt: DispatchRuntime) {
	const { context } = rt;
	const { agents, assignments, getEffectiveSettings, now, providers, targetCooldownReason } = rt.core;
	const retryQueue = new Map<string, RetryQueueEntry>();
	const writeRootPark = createWriteRootPark<ActiveRun, RunResult>({
		broker: rt.grants.grantBroker,
		now,
		deadlineMs: () =>
			getEffectiveSettings()?.fleet.limits.internalRunTimeoutMs ?? DEFAULT_SETTINGS.fleet.limits.internalRunTimeoutMs,
		isLive: (run) => !rt.drain.draining && retryChainIsLive(run),
		hold: (run, settled) => rt.control.trackMemberWork(run.runId, settled),
		settle: (run, receipt, status, detail) =>
			rt.runs.settleAssignmentDurably(asAssignmentId(run.lineage.rootRunId), receipt, status, detail),
		continueAttempt: (run, reason, continuation) =>
			rt.retryRun.executeRetry(
				run,
				run.lineage.attempt + 1,
				reason,
				{ retry: true, excludedRouteParts: [], qualityEscalation: null, reasonCode: "retry-write-roots-widened" },
				[],
				reason,
				continuation,
			),
	});
	/** Delay before the first retry of a member's worker run; each further attempt doubles it. */
	const RETRY_BACKOFF_BASE_MS = 500;
	/** Ceiling the doubled retry delay never exceeds. */
	const RETRY_BACKOFF_CAP_MS = 60_000;
	/** Retry attempts per member control root; the count sets the delay between the base and the cap above. */
	const retryBackoff = new Map<string, number>();
	const retryReasons = new Map<string, string>();

	function workersMaxRetries(settings: EffectiveSettings = getEffectiveSettings()): number {
		const value = settings?.fleet?.retry.maxRetries;
		return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 2;
	}

	function failoverModeFor(req: DispatchRequest): DispatchFailoverMode {
		return recovery.effectiveFailoverMode(req);
	}

	function assignmentPolicyFor(req: DispatchRequest): import("./assignment.js").AssignmentPolicy {
		return {
			maxRetries: req.routeApproval?.maxAttempts === undefined ? workersMaxRetries() : req.routeApproval.maxAttempts - 1,
			failover: failoverModeFor(req),
			allowedCandidates: req.allowedCandidates?.map((candidate) => ({ ...candidate })) ?? [],
		};
	}

	function memberRetryAttempt(run: ActiveRun): number {
		const root = rt.control.controlRootsByAttempt.get(run.runId) ?? run.runId;
		// #231 gives loop repairs the same retry budget without changing the
		// published lineage ordinal used by route observations and the ledger.
		return run.lineage.attempt - (rt.control.controlAttempts.get(root)?.lineage.attempt ?? 0);
	}

	/** A reserved plan member owns its retry chain independently of the shared fleet root assignment. */
	function retryChainIsLive(run: ActiveRun): boolean {
		if (
			run.aborted ||
			rt.control.canceledControlRoots.has(rt.control.controlRootsByAttempt.get(run.runId) ?? run.lineage.rootRunId)
		)
			return false;
		const reservation = run.req.reservation;
		if (reservation === undefined) return assignments.get(run.lineage.rootRunId)?.status === "running";
		try {
			const record = getDispatchReservation(reservation.ownerId);
			const member = record?.members.find((entry) => entry.memberId === reservation.memberId);
			return record?.status === "active" && member !== undefined && member.status !== "released";
		} catch (error) {
			reportDispatchDiagnostic(`read retry liveness for reservation member ${reservation.memberId}`, error);
			return false;
		}
	}

	function maybeScheduleRetry(
		run: ActiveRun,
		outcome: RunOutcome,
		detail: string | null,
		receipt: RunResult,
		failureClass: FailureClass,
		contextOverflow = false,
		currentRetryReason: string | null = null,
		unmetObligation?: Obligation,
	): RetryScheduleResult {
		if (rt.drain.draining) return { scheduled: false };
		const rootRunId = run.lineage.rootRunId;
		const controlRoot = rt.control.controlRootsByAttempt.get(run.runId) ?? rootRunId;
		if (!retryChainIsLive(run)) return { scheduled: false };
		if (providers.getRuntime(run.runtimeId)?.externalAgentLoop?.generatingRetry === "forbidden") {
			retryBackoff.delete(controlRoot);
			return {
				scheduled: false,
				settlementDetail:
					"automatic retry suppressed because this external agent loop is one-shot and PanCode cannot prove replay is side-effect-free",
			};
		}
		if (!RETRYABLE_OUTCOMES.has(outcome)) {
			retryBackoff.delete(controlRoot);
			return { scheduled: false };
		}
		// #231 gives each member its own configured retry budget, even when a
		// sibling has already opened an assignment under the shared fleet root.
		const configuredRetries =
			assignments.get(controlRoot)?.policy.maxRetries ??
			rt.control.controlAttempts.get(controlRoot)?.maxRetries ??
			assignmentPolicyFor(run.req).maxRetries;
		const maxRetries =
			unmetObligation !== undefined ? Math.min(configuredRetries, OBLIGATION_RETRY_LIMIT) : configuredRetries;
		const baseDecision = decideRetry(failureClass, memberRetryAttempt(run), maxRetries);
		let plannedRoutes: DispatchFailoverCandidate[] = [];
		/** An obligation retry may move past a refused route to the next other model. */
		let otherModelFallThrough = false;
		if (unmetObligation !== undefined && baseDecision.retry) {
			const plan = planObligationRetry(
				{
					agents,
					approvedRetryCandidates: rt.retryRun.approvedRetryCandidates,
					failoverModeFor,
					getEffectiveSettings,
					providers,
					targetCooldownReason,
				},
				run,
				unmetObligation,
				baseDecision,
			);
			if ("settlementDetail" in plan) {
				retryBackoff.delete(controlRoot);
				return { scheduled: false, settlementDetail: plan.settlementDetail };
			}
			plannedRoutes = plan.routes;
			otherModelFallThrough = true;
		}
		// An exact manual route may be retried, but no route component may drift.
		let decision = recovery.retryDecisionWithinFailover(baseDecision, failoverModeFor(run.req));
		let overflowReason: string | null = null;
		if (contextOverflow && !decision.retry) {
			const plan = planOverflowRetry(
				{
					CONTEXT_OVERFLOW_RETRY,
					agents,
					failoverModeFor,
					getEffectiveSettings,
					memberRetryAttempt,
					providers,
					targetCooldownReason,
				},
				run,
				currentRetryReason,
				maxRetries,
			);
			if ("settlementDetail" in plan) {
				retryBackoff.delete(controlRoot);
				return { scheduled: false, settlementDetail: plan.settlementDetail };
			}
			plannedRoutes = [plan.route];
			otherModelFallThrough = false;
			overflowReason = plan.reason;
			decision = { retry: true, excludedRouteParts: [], qualityEscalation: null, reasonCode: "retry-context-overflow" };
		}
		if (!decision.retry) {
			retryBackoff.delete(controlRoot);
			// Deterministic outcomes are intentionally not retried. This is a normal
			// policy decision carried by the receipt, not an operational diagnostic
			// that should leak into an embedding command's stderr.
			return { scheduled: false };
		}
		if (receipt.safety?.grants?.some((grant) => grant.execution === "unknown") === true) {
			retryBackoff.delete(controlRoot);
			return {
				scheduled: false,
				settlementDetail:
					"automatic retry suppressed because a granted call may have run before the worker exited, and its outcome is unknown",
			};
		}
		const potentiallyMutated =
			receipt.toolActivity?.mutatingSucceeded === true ||
			hasPotentiallyMutatingAttempt(receipt.toolStats, (tool) => classifyAction({ tool }).actionClass);
		if (potentiallyMutated) {
			retryBackoff.delete(controlRoot);
			return {
				scheduled: false,
				settlementDetail:
					"automatic retry suppressed because the failed attempt executed a potentially state-changing tool call and retries do not yet have isolated workspaces",
			};
		}
		const telemetry = receipt.safety?.toolTelemetry;
		const unfinishedMutation =
			telemetry?.unfinished.some(({ tool, count }) => count > 0 && classifyAction({ tool }).actionClass !== "read") ===
			true;
		const mutationNotRuledOut =
			telemetry === undefined
				? run.runtimeKind === "subprocess" || run.runtimeKind === "acp-delegation"
				: (telemetry.coverage === "unavailable" && (telemetry.workspaceMutationPossible || unfinishedMutation)) ||
					(telemetry.coverage === "partial" &&
						(unfinishedMutation || (telemetry.ingestionErrors > 0 && telemetry.workspaceMutationPossible)));
		if (mutationNotRuledOut) {
			retryBackoff.delete(controlRoot);
			return {
				scheduled: false,
				settlementDetail:
					"automatic retry suppressed because incomplete tool telemetry cannot prove the failed attempt left the shared workspace unchanged",
			};
		}
		const backoffAttempt = (retryBackoff.get(controlRoot) ?? 0) + 1;
		retryBackoff.set(controlRoot, backoffAttempt);
		const backoffDelayMs = engineRetryDelayMs(RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_CAP_MS, backoffAttempt);
		// An in-flight assignment is governed by maxRetries and backoff alone. The
		// target cooldown it just created protects new work, not this chain.
		const delayMs = Math.max(backoffDelayMs, decision.retryAfterMs ?? 0);
		const attempt = run.lineage.attempt + 1;
		const reason = overflowReason ?? (detail !== null ? `${outcome}: ${detail}` : outcome);
		const dueAt = now() + delayMs;
		let settleCanceled!: () => void;
		let rejectContinuation!: (error: unknown) => void;
		const continuation = new Promise<void>((resolve, reject) => {
			settleCanceled = resolve;
			rejectContinuation = reject;
		});
		rt.control.trackMemberWork(run.runId, continuation);
		const timer = setTimeout(() => {
			retryQueue.delete(run.runId);
			// Ownership starts at scheduling, covering admission before a handle
			// exists and terminal receipt work after the handle arrives.
			rt.retryRun
				.executeRetry(
					run,
					attempt,
					reason,
					decision,
					plannedRoutes,
					failureClassWords(failureClass),
					{},
					otherModelFallThrough,
				)
				.then(settleCanceled, rejectContinuation);
		}, delayMs);
		retryQueue.set(run.runId, {
			runId: run.runId,
			agentId: run.agentId,
			task: run.task,
			attempt,
			dueAt,
			reason,
			excludedRouteParts: [...decision.excludedRouteParts],
			rootRunId,
			terminalCandidate: receipt,
			timer,
			settleCanceled,
		});
		context.bus.emit("run.progressed", {
			runId: run.runId,
			agentId: run.agentId,
			task: run.task,
			...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
			...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
			targetId: run.targetId,
			wireModelId: run.wireModelId,
			runtimeId: run.runtimeId,
			runtimeKind: run.runtimeKind,
			event: { type: "retry_scheduled", attempt, dueAt: new Date(dueAt).toISOString(), reason },
		});
		return { scheduled: true };
	}

	const CONTEXT_OVERFLOW_RETRY = "context-overflow";

	function retryReasonKey(rootRunId: string, attempt: number): string {
		return `${rootRunId}:${attempt}`;
	}

	function completeAssignmentAttempt(
		run: ActiveRun,
		receipt: RunResult,
		outcome: RunOutcome,
		detail: string | null,
		failureClass: FailureClass,
		contextOverflow = false,
		unmetObligation?: Obligation,
	): boolean {
		const controlAttempt = rt.control.controlAttempts.get(run.runId);
		if (controlAttempt !== undefined && run.lineage.depth > 0) controlAttempt.receipt = receipt;
		const assignment = assignments.open(run.lineage.rootRunId, assignmentPolicyFor(run.req));
		rt.runs.persistAssignment(registerAssignment(assignment.id), `${assignment.id}:open`);
		const reasonKey = retryReasonKey(rt.control.controlRootFor(run.runId), run.lineage.attempt);
		const retryReason = run.lineage.attempt > 0 ? (retryReasons.get(reasonKey) ?? "retry") : null;
		retryReasons.delete(reasonKey);
		assignments.recordAttempt(assignment.id, {
			runId: run.runId,
			attempt: run.lineage.attempt,
			outcome,
			node: run.node,
			runDigest: receipt.digest,
			retryReason,
		});
		rt.runs.persistAssignment(recordAssignmentAttempt(assignment.id, run.runId), `${assignment.id}:attempt:${run.runId}`);
		if (writeRootPark.park(run, receipt)) return true;
		const retry = maybeScheduleRetry(
			run,
			outcome,
			detail,
			receipt,
			failureClass,
			contextOverflow,
			retryReason,
			unmetObligation,
		);
		if (retry.scheduled) return true;
		const currentStatus = assignments.get(assignment.id)?.status;
		const terminalStatus = currentStatus === "canceled" ? "canceled" : assignmentStatusForOutcome(outcome);
		rt.runs.settleAssignmentDurably(assignment.id, receipt, terminalStatus, retry.settlementDetail);
		return false;
	}

	/**
	 * Settle every queued retry deterministically before shutdown. A cleared
	 * retry timer would otherwise leave the assignment (and its attached
	 * finalPromise / durable record) pending forever. The last immutable attempt
	 * receipt becomes the terminal evidence and the assignment settles `canceled`.
	 */
	function settleQueuedAssignmentsForShutdown(): void {
		writeRootPark.revoke(() => true, "the owning session is shutting down");
		for (const [finishedRunId, entry] of retryQueue) {
			clearTimeout(entry.timer);
			entry.settleCanceled();
			if (assignments.get(entry.rootRunId)?.status === "running") {
				rt.runs.settleAssignmentDurably(asAssignmentId(entry.rootRunId), entry.terminalCandidate, "canceled");
			}
			context.bus.emit("run.progressed", {
				runId: finishedRunId,
				agentId: entry.agentId,
				task: entry.task,
				event: { type: "retry_canceled", attempt: entry.attempt },
			});
		}
		retryQueue.clear();
		retryBackoff.clear();
		retryReasons.clear();
	}

	return {
		assignmentPolicyFor,
		completeAssignmentAttempt,
		failoverModeFor,
		memberRetryAttempt,
		retryBackoff,
		retryChainIsLive,
		retryQueue,
		retryReasonKey,
		retryReasons,
		settleQueuedAssignmentsForShutdown,
		workersMaxRetries,
		writeRootPark,
	};
}
