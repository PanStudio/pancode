// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomBytes } from "node:crypto";
import type { DispatchRunIdentity } from "../../core/telemetry/live-events.js";
import {
	canonicalEndpointKey,
	type EndpointCapacity,
	endpointCapacityFor,
	endpointCapacityForStatus,
	resolveEndpointCapacities,
} from "../providers/index.js";
import { describeLocalCapacityRefusal, resolveGlobalConcurrency } from "../scheduling/local-capacity.js";
import { createCapacityAdmissionController } from "./admission.js";
import { AdmissionCanceledError, AdmissionTimedOutError } from "./admission-error.js";
import { registerAssignment } from "./assignment-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { PendingCapacityAdmission } from "./bundle-types.js";
import { capacityLeaseUsage, capacityLeaseUsageAsync, createNodeLeaseUsageReader } from "./capacity-lease.js";
import type { DispatchContract, DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { acquireLaunch, type LaunchAcquisition, settleUnstartedAssignment } from "./launch-acquisition.js";
import {
	createDispatchReservation,
	planQueueSlot,
	type ReservationCapacitySnapshot,
	rebindDispatchReservationMember,
	reservedPlanPeakSlots,
	rollbackDispatchReservation,
} from "./reservation-store.js";
import type { DispatchRequestOrigin, RunNodeIdentity, RunOutcome, RunPhaseMarks } from "./types.js";

export function createCapacityMachine(rt: DispatchRuntime) {
	const { context } = rt;
	const { getEffectiveSettings, now, providers, scheduling } = rt.core;
	const pendingCapacity = new Map<string, PendingCapacityAdmission>();
	const ownedReservations = new Set<string>();
	const capacityAdmission = createCapacityAdmissionController({
		limits: () => {
			const settings = getEffectiveSettings();
			const nodes: Record<string, number> = { local: configuredLocalCapacity(settings) };
			for (const node of settings?.fleet?.nodes ?? []) nodes[node.id] = node.maxWorkers;
			return { global: configuredGlobalCapacity(settings), nodes, endpoints: configuredEndpointLimits() };
		},
		now,
		reservedPlanPeak: (planId) =>
			reservedPlanPeakSlots(planId, (error) => reportDispatchDiagnostic("read reserved plan peak", error)),
		onRenewalError: (error) => reportDispatchDiagnostic("renew capacity leases", error),
		onReleaseError: (leaseId, error) =>
			reportDispatchDiagnostic(`release capacity lease ${leaseId}; retrying at the next heartbeat`, error),
		onLeaseLost: (lease, detail) => {
			reportDispatchDiagnostic("capacity lease lost", new Error(detail));
			rt.control.stopLostCapacityOwners(lease.assignmentId, detail);
			// A member whose only remaining work was a retry in backoff settles no
			// assignment when that retry is canceled, so with no run left under the
			// lease nothing would ever release it and local admission would stay
			// refused. The store already lacks it; this clears the local record.
			if (![...rt.runs.active.values()].some((run) => run.lineage.rootRunId === lease.assignmentId))
				capacityAdmission.release(lease.leaseId);
		},
	});
	scheduling.fleet?.bindActiveWorkers(
		createNodeLeaseUsageReader({
			now,
			onError: (error) => reportDispatchDiagnostic("read capacity lease usage", error),
		}),
	);

	/**
	 * Every endpoint the configured fleet can reach.
	 *
	 * Deliberately resolved from the configured targets as well as the probed
	 * statuses. A target whose status has not been built yet contributed no key,
	 * an absent key carries no limit, and reservation planning skips a dimension
	 * it has no limit for, so admission against a single-slot server used to fail
	 * open for whoever asked first after boot.
	 */
	function configuredEndpointCapacities(): Readonly<Record<string, EndpointCapacity>> {
		return resolveEndpointCapacities({
			statuses: providers.list(),
			targets: getEffectiveSettings()?.targets ?? [],
			runtimeFor: (runtimeId) => providers.getRuntime(runtimeId),
		});
	}

	function configuredEndpointLimits(): Readonly<Record<string, number>> {
		return Object.fromEntries(Object.entries(configuredEndpointCapacities()).map(([key, value]) => [key, value.limit]));
	}

	/**
	 * Endpoints still bound by the blind one-slot default have never been
	 * probed by any process, or their record expired. A fresh home carried that
	 * bound into its first batch and refused two tasks on a server running
	 * four, until the operator happened to run `connections --probe`. Probe each
	 * such endpoint once per process, in the background and without the
	 * inference-based reasoning check: the slot count is a header read, and the
	 * model's first dispatch call is seconds away at the earliest. The probe
	 * lands in the provider statuses and the durable slot store, which is where
	 * admission already looks.
	 */
	const probedDefaultBoundEndpoints = new Set<string>();
	function probeEndpointsAtDefaultBound(): void {
		const capacities = configuredEndpointCapacities();
		for (const target of getEffectiveSettings()?.targets ?? []) {
			const key = canonicalEndpointKey(target);
			if (key === null || capacities[key]?.source !== "local-native-default") continue;
			if (probedDefaultBoundEndpoints.has(key)) continue;
			probedDefaultBoundEndpoints.add(key);
			void providers.probeTarget(target.id, { reasoning: false }).catch(() => undefined);
		}
	}

	function endpointCapacityForTarget(targetId: string): EndpointCapacity | null {
		const status = providers.list().find((entry) => entry.target.id === targetId);
		const target = status?.target ?? providers.getTarget(targetId);
		if (target === null || target === undefined) return null;
		const endpoint =
			status === undefined
				? endpointCapacityFor({ target, runtime: providers.getRuntime(target.runtime) })
				: endpointCapacityForStatus(status);
		if (endpoint === null) return null;
		return configuredEndpointCapacities()[endpoint.key] ?? endpoint;
	}

	/** Initial plan preparation has a synchronous host contract. */
	function reservationCapacitySnapshotSync(settings: EffectiveSettings): ReservationCapacitySnapshot {
		return reservationCapacitySnapshot(settings, capacityLeaseUsage());
	}

	function reservationCapacitySnapshot(
		settings: EffectiveSettings,
		usage: ReturnType<typeof capacityLeaseUsage>,
	): ReservationCapacitySnapshot {
		// Read budget after the capacity lock wait too; concurrent callbacks may spend.
		const preflight = scheduling.preflight();
		const localCapacity = scheduling.localCapacity?.();
		const localNote = localCapacity === undefined ? null : describeLocalCapacityRefusal(localCapacity);
		const nodes: Record<string, { active: number; limit: number; note?: string }> = {
			local: {
				active: usage.nodes.local ?? 0,
				limit: localCapacity?.limit ?? configuredGlobalCapacity(settings),
				...(localNote === null ? {} : { note: localNote }),
			},
		};
		for (const node of settings?.fleet?.nodes ?? [])
			nodes[node.id] = { active: usage.nodes[node.id] ?? 0, limit: node.maxWorkers };
		const endpoints = Object.fromEntries(
			Object.entries(configuredEndpointLimits()).map(([key, limit]) => [
				key,
				{
					active: usage.endpoints[key] ?? 0,
					limit,
					leases: usage.endpointHolders[key]?.leases ?? 0,
					foregroundStreams: usage.endpointHolders[key]?.foregroundStreams ?? 0,
				},
			]),
		);
		return {
			global: { active: usage.global, limit: configuredGlobalCapacity(settings) },
			nodes,
			endpoints,
			budget: { currentUsd: preflight.currentUsd, ceilingUsd: preflight.ceilingUsd },
		};
	}

	function prepareReservation(input: Parameters<NonNullable<DispatchContract["reservations"]>["prepare"]>[0]) {
		const record = createDispatchReservation({
			topology: input.topology,
			tasks: input.tasks.map((task) => ({
				memberId: task.memberId,
				wave: task.wave,
				nodeId: task.resolution.node.id,
				...(task.resolution.endpoint !== undefined ? { endpointKey: task.resolution.endpoint.key } : {}),
				costUpperBoundUsd: task.resolution.routeApproval?.totalCostUpperBoundUsd ?? task.resolution.costUpperBoundUsd,
			})),
			capacity: reservationCapacitySnapshotSync(getEffectiveSettings()),
			nowMs: now(),
		});
		ownedReservations.add(record.ownerId);
		return record;
	}

	function configuredGlobalCapacity(settings: EffectiveSettings): number {
		return scheduling.maxWorkers?.() ?? resolveGlobalConcurrency(settings?.fleet.concurrency);
	}

	/** The local node alone follows host facts under `auto`; global and SSH limits do not. */
	function configuredLocalCapacity(settings: EffectiveSettings): number {
		return scheduling.localCapacity?.().limit ?? configuredGlobalCapacity(settings);
	}

	function publishCapacityQueued(
		identity: DispatchRunIdentity & { requestOrigin: DispatchRequestOrigin },
		timing: RunPhaseMarks,
		node: RunNodeIdentity | null,
	): void {
		pendingCapacity.set(identity.runId, { identity, timing, node });
		context.bus.emit("run.enqueued", identity);
	}

	function publishCapacityAdmissionFailure(
		identity: DispatchRunIdentity & { requestOrigin: DispatchRequestOrigin },
		error: unknown,
		signal?: AbortSignal,
	): void {
		const detail = error instanceof Error ? error.message : String(error);
		const outcome: RunOutcome =
			error instanceof AdmissionTimedOutError
				? "timed_out"
				: error instanceof AdmissionCanceledError || signal?.aborted === true
					? "canceled"
					: "denied_by_policy";
		context.bus.emit("run.failed", {
			...identity,
			outcome,
			outcomeDetail: detail,
			reason: outcome,
		});
	}

	async function admitAssignmentCapacity(
		req: DispatchRequest,
		nodeId: string,
		timing: RunPhaseMarks,
		endpoint?: EndpointCapacity | null,
		signal?: AbortSignal,
	) {
		const queuedAt = now();
		timing.queuedAt = new Date(queuedAt).toISOString();
		const assignmentId =
			req.lineage?.rootRunId ?? req.runIdHint ?? `pending-${queuedAt.toString(36)}-${randomBytes(6).toString("hex")}`;
		const requestedAt = Date.parse(timing.requestedAt ?? timing.queuedAt);
		const deadlineAt =
			req.assignmentDeadlineAt ??
			(req.routingIntent?.deadlineMs === undefined || req.routingIntent.deadlineMs === null
				? undefined
				: requestedAt + req.routingIntent.deadlineMs);
		if (deadlineAt !== undefined) req.assignmentDeadlineAt = deadlineAt;
		if (req.lineage === undefined) await registerAssignment(assignmentId);
		// A plan's queued members keep their wave order and their reserved peak.
		const plan =
			req.reservation === undefined
				? {}
				: planQueueSlot(req.reservation.ownerId, req.reservation.memberId, (error) =>
						reportDispatchDiagnostic("read plan queue identity", error),
					);
		try {
			signal?.throwIfAborted();
			const admitted = await capacityAdmission.admit({
				assignmentId,
				nodeId,
				...(endpoint !== null && endpoint !== undefined ? { endpointKey: endpoint.key } : {}),
				...(deadlineAt === undefined ? {} : { deadlineAt }),
				...plan,
				// A fleet's first attempt carries lineage and still owns the held
				// reservation member that admission must transfer into its lease.
				// Retries carry the same reservation identity after that member was
				// consumed, so they reacquire/rebind the assignment lease normally.
				...(req.reservation !== undefined && (req.lineage === undefined || req.lineage.attempt === 0)
					? { reservation: req.reservation }
					: {}),
				...(req.requestOrigin === "user" ? { operatorStarted: true } : {}),
				// This attempt's own signal; siblings sharing the assignment keep waiting.
				...(signal !== undefined ? { signal } : {}),
			});
			timing.admittedAt = new Date(admitted.admittedAt).toISOString();
			return admitted.lease;
		} catch (error) {
			if (req.lineage === undefined) {
				try {
					await settleUnstartedAssignment(assignmentId, error, signal);
				} catch (settleError) {
					reportDispatchDiagnostic(`persist assignment ${assignmentId}:admission`, settleError);
				}
			}
			throw error;
		}
	}

	/** Native and ACP launches both queue, admit and resolve the ledger here; `fail` settles any later launch failure. */
	function acquireDispatchLaunch(
		req: DispatchRequest,
		queuedIdentity: (DispatchRunIdentity & { requestOrigin: DispatchRequestOrigin }) | null,
		node: RunNodeIdentity | null,
		timing: RunPhaseMarks,
		endpoint: EndpointCapacity | null,
		signal: AbortSignal | undefined,
	): Promise<LaunchAcquisition> {
		return acquireLaunch({
			admit: async () => {
				if (queuedIdentity !== null) publishCapacityQueued(queuedIdentity, timing, node);
				try {
					return await admitAssignmentCapacity(req, node?.id ?? "local", timing, endpoint, signal);
				} catch (error) {
					if (queuedIdentity !== null) publishCapacityAdmissionFailure(queuedIdentity, error, signal);
					throw error;
				} finally {
					if (queuedIdentity !== null) pendingCapacity.delete(queuedIdentity.runId);
				}
			},
			controller: capacityAdmission,
			requireLedger: rt.runs.requireLedger,
			ownsAssignment: req.lineage === undefined,
			signal,
		});
	}

	async function rebindReservationSlot(
		req: DispatchRequest,
		nodeId: string,
		endpoint: EndpointCapacity | null,
		costUsd: number,
		settings: EffectiveSettings,
	): Promise<void> {
		if (req.reservation === undefined) return;
		const capacity = reservationCapacitySnapshot(settings, await capacityLeaseUsageAsync());
		const rebind = {
			...req.reservation,
			nodeId,
			...(endpoint !== null ? { endpointKey: endpoint.key } : {}),
			costUpperBoundUsd: Math.max(req.routeApproval?.totalCostUpperBoundUsd ?? 0, costUsd),
			capacity,
			nowMs: now(),
		};
		await rebindDispatchReservationMember(rebind);
	}

	async function releaseCapacityAtStop(): Promise<void> {
		await capacityAdmission.stop();
		for (const ownerId of ownedReservations) rollbackDispatchReservation(ownerId, now());
		ownedReservations.clear();
	}

	/** The run just entered `active`; stop it if its lease was lost while it launched. */
	function stopIfCapacityLost(runId: string, leaseId: string): void {
		const detail = capacityAdmission.lostLeaseDetail(leaseId);
		if (detail === null) return;
		try {
			rt.contract.contract.abort(runId, { cause: "capacity", detail });
		} catch (error) {
			reportDispatchDiagnostic(`stop run ${runId} after lost capacity`, error);
		}
	}

	return {
		acquireDispatchLaunch,
		capacityAdmission,
		configuredGlobalCapacity,
		endpointCapacityForTarget,
		pendingCapacity,
		prepareReservation,
		probeEndpointsAtDefaultBound,
		rebindReservationSlot,
		releaseCapacityAtStop,
		stopIfCapacityLost,
	};
}
