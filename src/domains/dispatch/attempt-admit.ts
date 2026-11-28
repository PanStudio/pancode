// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { requirePricedRefusal } from "../../core/run-overrides.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import type { WorkerGrantBinding } from "../../worker/spec-contract.js";
import { isHoareResultContract } from "../agents/result-contract-types.js";
import { normalizeAgentSpec } from "../agents/spec.js";
import { persistWorkerContextSeed } from "../context/worker/store.js";
import { mainGrantsUnavailable, withoutExecuteAutonomy } from "../safety/worker-permit.js";
import {
	approvedRouteObservation,
	consumeActiveRouteApproval,
	routeValidationProjection,
} from "./active-route-planner.js";
import {
	EXTERNAL_READ_APPROVAL_REQUIRED,
	externalReadShapeAdmissible,
	remoteStoreGrantRefusal,
	sharedStoreGrantFor,
} from "./admission-scope.js";
import type { NativeAttemptState, OpenedAttempt } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import {
	admissionMaxOutputTokens,
	conservativeRouteAdmissionEstimateUsd,
	UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD,
} from "./bundle-support.js";
import type { ProbeClaim } from "./bundle-types.js";
import type { DispatchAdmissionObserver, DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import { judgeRoutedPermit, operatorAdmissionAutonomy } from "./envelope-stage.js";
import { dispatchResultContract, withAttemptRole } from "./execution-role.js";
import type { FleetChangeReturn } from "./fleet-change-return.js";
import { assertFleetProjectAuthority, verifyFleetProject } from "./fleet-project-verification.js";
import type { BatchVerificationGate } from "./host-verification.js";
import { deriveEnvelopePhaseDurations } from "./phase-timing.js";
import { routeAroundCoolingTarget } from "./retry-route-plan.js";
import { type RouteRoleInput, toRouteCandidate } from "./route-decision.js";
import type { RouteObservationHandle } from "./route-observer.js";
import { reduceRouteQuality, routeQualityRun } from "./route-quality.js";
import { assertPlannedNodeIdentity, assertResponseSchemaEnforceable } from "./runtime-enforceability.js";
import { newRunId } from "./state.js";
import type { RunPhaseMarks, RunResult, SafetyBlockedAttempt } from "./types.js";
import { validateJobSpec } from "./validation.js";
import type { RunTokenMeter } from "./worker-event-fold.js";
import { protectedArtifactStateForRequest } from "./worker-spec.js";

export function openAttemptAdmission(
	rt: DispatchRuntime,
	attempt: NativeAttemptState,
	req: DispatchRequest,
	probeClaims: ProbeClaim[],
	observer?: DispatchAdmissionObserver,
	preparation?: DispatchPreparationOptions,
	settlement?: BatchVerificationGate,
) {
	const { agents, getEffectiveSettings, getProtectedArtifactState, now, routeObserver } = rt.core;

	const hostRun = preparation?.hostRun;
	const requestedAt = new Date(now()).toISOString();
	const timing: RunPhaseMarks = { requestedAt };
	const settings = getEffectiveSettings();
	const isAcpAgent = settings?.integrations.externalAgents?.entries?.some((entry) => entry.id === req.agentId) ?? false;
	if (isAcpAgent && !req.delegationAgentId) {
		req.delegationAgentId = req.agentId;
	}

	const validation = routeValidationProjection(req);
	const validated = validateJobSpec(validation.jobSpec);
	if (!validated.ok) {
		throw new Error(`dispatch: invalid spec: ${validated.errors.join("; ")}`);
	}
	req = validation.restore(validated.spec);
	if (req.externalReadRoot !== undefined) {
		const approval = req.externalReadApproval;
		if (
			!externalReadShapeAdmissible(req, agents.getSpec(req.agentId)) ||
			approval === undefined ||
			approval.root !== req.externalReadRoot ||
			approval.runId !== req.runIdHint
		)
			throw new Error(EXTERNAL_READ_APPROVAL_REQUIRED);
	}
	// Admission never awaits a decision model. Routing classifies the task
	// with the rules, always: a dispatch is the main agent's call, and a
	// decision model that could delay it by up to 3s, or change its route,
	// would be deciding on the agent's behalf.
	// Every attempt needs its identity before spawning so worker telemetry
	// uses the same run id as the eventual ledger row (#434). Top-level runs wait for
	// capacity. The board can then render the assignment as queued and the
	// same id becomes the ledger row once its slot opens.
	if (req.runIdHint === undefined) req = { ...req, runIdHint: newRunId() };
	let activeRouteObservation: RouteObservationHandle | null = null;
	if (req.delegationAgentId === undefined) {
		const recipe = agents.get(req.agentId);
		const activation = consumeActiveRouteApproval({
			request: req,
			settings: settings?.fleet.adaptiveRouting,
			capabilityClass: recipe === null ? null : normalizeAgentSpec(recipe).capabilityClass,
			failover: rt.retry.failoverModeFor(req),
			requestedAt,
			observe: (request, decision) => routeObserver.observe(rt.route.routeObservationInput(request, decision)),
		});
		if (activation !== null) {
			req = activation.request;
			activeRouteObservation = activation.observation;
		}
	}
	const protectedArtifactState = protectedArtifactStateForRequest(getProtectedArtifactState(), req);

	const attachRouteObservation = <T extends { finalPromise: Promise<RunResult> }>(handle: T): T => {
		const observation = attempt.routeObservation;
		handle.finalPromise
			.then((receipt) => {
				const envelope = rt.runs.ledger?.get(receipt.runId);
				const phases = envelope ? deriveEnvelopePhaseDurations(envelope) : undefined;
				if (envelope === null || envelope === undefined) return;
				const outcome = receipt.outcome ?? (receipt.exitCode === 0 ? "succeeded" : "failed");
				const run = routeQualityRun(receipt);
				const quality = reduceRouteQuality({ subject: run, runs: [run] });
				routeObserver.recordOutcome(observation.id, {
					route: observation.decision.executedRoute,
					outcome,
					qualityLabel: quality.label,
					firstPass: outcome === "succeeded" && (receipt.lineage?.attempt ?? 0) === 0,
					attempt: receipt.lineage?.attempt ?? 0,
					costUsd: factKnownValue(receipt.spendSums.usd),
					endToEndMs: phases?.totalEndToEndMs ?? 0,
					receipt,
					quality,
					phaseTiming: phases,
				});
			})
			.catch(() => {});
		return handle;
	};
	if (req.continueRunId !== undefined && !req.delegationAgentId)
		throw new Error(
			`dispatch: continue_run continues an ACP delegation's peer session; '${req.agentId}' is not an ACP agent`,
		);
	attempt.req = req;
	attempt.probeClaims = probeClaims;
	attempt.observer = observer;
	attempt.preparation = preparation;
	attempt.settlement = settlement;
	attempt.activeRouteObservation = activeRouteObservation;
	return { hostRun, requestedAt, timing, settings, protectedArtifactState, attachRouteObservation };
}

export async function delegateToAcpPeer(rt: DispatchRuntime, attempt: OpenedAttempt) {
	const {
		attachRouteObservation,
		hostRun,
		observer,
		preparation,
		probeClaims,
		protectedArtifactState,
		req,
		settings,
		settlement,
		timing,
	} = attempt;

	if (req.delegationAgentId) {
		rt.preview.assertAcpDelegationAdmissible(req, req.delegationAgentId, protectedArtifactState);
		await rt.capacity.rebindReservationSlot(req, "local", null, UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD, settings);
		attempt.routeObservation = rt.route.observeShadowRoute(req, undefined, settings);
		const delegated = await rt.acp.dispatchAcpDelegation(
			req,
			settings,
			timing,
			attempt.routeObservation.decision,
			probeClaims,
			observer,
			hostRun,
			preparation?.signal,
		);
		// An ACP member never runs host verification, so it can only ever leave
		// the barrier. It still edits the checkout, so the barrier has to wait
		// for it; dispatch() releases it when its finalPromise settles.
		settlement?.live(delegated.runId);
		return attachRouteObservation({ ...delegated, effectiveRequest: req });
	}
}

export async function admitAttemptRoute(rt: DispatchRuntime, attempt: OpenedAttempt) {
	const {
		agents,
		assertTargetNotCoolingDown,
		cooldownKey,
		getEffectiveSettings,
		previewNode,
		providers,
		resolveNode,
		targetBreaker,
		targetCooldownReason,
		withLiveAutonomy,
	} = rt.core;
	const { options } = rt;
	let req = attempt.req;
	const { activeRouteObservation, checkoutRoot, preparation, probeClaims, requestedAt, settings, timing } = attempt;

	req =
		routeAroundCoolingTarget(
			{
				agents,
				cooldownKey,
				failoverModeFor: rt.retry.failoverModeFor,
				providers,
				routeCandidates: rt.route.routeCandidates,
				targetBreaker,
				targetCooldownReason,
			},
			req,
			settings,
		) ?? req;
	const metadataDeadlineAt =
		req.assignmentDeadlineAt ?? Date.parse(requestedAt) + (req.routingIntent?.deadlineMs ?? 60_000);
	const admittedPlacement = previewNode(req);
	const lifecycle = await rt.lifecycle.resolveLifecycle(
		req,
		settings,
		admittedPlacement,
		metadataDeadlineAt,
		preparation?.signal,
		checkoutRoot,
	);
	preparation?.signal?.throwIfAborted();
	assertResponseSchemaEnforceable(
		lifecycle.target.runtime,
		lifecycle.target.modelCapabilities,
		req.responseSchema,
		lifecycle.admission.allowedTools.length,
	);
	assertTargetNotCoolingDown(
		req,
		lifecycle.target.target.id,
		lifecycle.target.runtime.id,
		lifecycle.target.wireModelId,
		probeClaims,
	);

	// `run --require-priced` (SPEC 6.9): the resolved route, including a model named for this dispatch only.
	const routeUnpriced = requirePricedRefusal(
		lifecycle.target.effectivePricing.pricedBy,
		`${lifecycle.target.target.id}/${lifecycle.target.wireModelId}`,
	);
	if (routeUnpriced !== undefined) throw new Error(`dispatch: admission denied: ${routeUnpriced}`);
	await rt.budget.assertNoFreshQuotaDenial(
		lifecycle.target.target,
		lifecycle.target.runtime,
		`${lifecycle.target.target.id}/${lifecycle.target.wireModelId}`,
	);
	await rt.budget.assertBudgetAdmitsRoute(
		req,
		lifecycle.target.effectivePricing,
		settings,
		lifecycle,
		preparation?.signal,
	);

	const placement = resolveNode(req) ?? null;
	const actualNode = placement?.node ?? { id: "local", kind: "local" };
	assertPlannedNodeIdentity(req, actualNode);
	if (
		!isDeepStrictEqual(actualNode, admittedPlacement.node) ||
		(actualNode.kind === "ssh" &&
			lifecycle.runtimeKind === "http" &&
			(settings?.safety.sandbox !== "off" || isHoareResultContract(dispatchResultContract(req, lifecycle.recipe))) &&
			!isDeepStrictEqual(placement?.sandbox ?? null, admittedPlacement.sandbox ?? null))
	)
		throw new Error(
			`dispatch: node or sandbox changed after admission for '${admittedPlacement.node.id}'; request a fresh dispatch`,
		);
	const remoteStoreGrant = remoteStoreGrantRefusal(req, placement?.node ?? null);
	if (remoteStoreGrant !== null) throw new Error(remoteStoreGrant);
	const sharedStoreGrant = await sharedStoreGrantFor(req, placement?.node ?? null, lifecycle.readOnly);
	let remoteReturn: FleetChangeReturn | undefined;

	if (placement?.node.kind === "ssh") {
		const node = settings?.fleet.nodes.find((item) => item.id === placement.node.id);
		if (!node) throw new Error("dispatch: node configuration disappeared before project verification");
		const project = await verifyFleetProject(
			node,
			req.taskWorktree?.root ?? req.cwd ?? process.cwd(),
			true,
			lifecycle.readOnly,
		);
		assertFleetProjectAuthority(project, lifecycle.readOnly, req.taskWorktree !== undefined);
		if (project.kind === "independent" && req.taskWorktree) remoteReturn = { node, worktree: req.taskWorktree };
	}
	const effectiveRoute = {
		agentId: req.agentId,
		target: lifecycle.target.target.id,
		model: lifecycle.target.wireModelId,
		node: placement?.node?.id ?? "local",
	};
	const endpoint = rt.capacity.endpointCapacityForTarget(lifecycle.target.target.id);
	rt.retryRun.assertRouteWithinApprovedEnvelope(req, effectiveRoute);
	await rt.capacity.rebindReservationSlot(
		req,
		effectiveRoute.node,
		endpoint,
		conservativeRouteAdmissionEstimateUsd(
			lifecycle.target.effectivePricing,
			admissionMaxOutputTokens(settings, lifecycle.target.modelCapabilities),
			req,
			lifecycle,
		),
		settings,
	);
	if (placement?.reroutes !== undefined && placement.reroutes.length > 0) {
		req = { ...req, reroutes: [...placement.reroutes] };
	}
	const placed = placement?.node ?? { id: "local", kind: "local" };
	attempt.routeObservation = approvedRouteObservation({
		request: req,
		active: activeRouteObservation,
		actual: () => {
			const role: RouteRoleInput = { executionRole: withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0) };
			if (req.systemPrompt !== undefined) role.personaPrompt = req.systemPrompt;
			return toRouteCandidate({ ...rt.preview.previewFixed(req, settings, checkoutRoot), nodeId: placed.id }, role);
		},
		shadow: () => rt.route.observeShadowRoute(req, placed, settings, checkoutRoot),
	});

	if (req.contextSeed) persistWorkerContextSeed(req.contextSeed);
	const queuedIdentity =
		req.lineage === undefined && req.runIdHint !== undefined
			? {
					runId: req.runIdHint,
					sessionId: req.ownerSessionId ?? null,
					agentId: req.agentId,
					task: req.task,
					agentAudience: lifecycle.agentAudience,
					requestOrigin: lifecycle.requestOrigin,
					targetId: lifecycle.target.target.id,
					wireModelId: lifecycle.target.wireModelId,
					runtimeId: lifecycle.target.runtime.id,
					runtimeKind: lifecycle.runtimeKind,
					budget: lifecycle.budgetEnvelope,
					...(endpoint !== null ? { endpoint: { key: endpoint.key, label: endpoint.label, limit: endpoint.limit } } : {}),
					...(placement !== null ? { node: placement.node.id } : {}),
					...(req.gate !== undefined ? { gate: { role: req.gate.role, cycle: req.gate.cycle } } : {}),
					...(req.council !== undefined ? { council: req.council } : {}),
					...(req.reroutes !== undefined && req.reroutes.length > 0 ? { rerouteCount: req.reroutes.length } : {}),
					...(lifecycle.target.modelCapabilities !== undefined &&
					lifecycle.target.modelCapabilities !== null &&
					lifecycle.target.modelCapabilities.contextWindow > 0
						? { contextWindow: lifecycle.target.modelCapabilities.contextWindow }
						: {}),
				}
			: null;
	const launch = await rt.capacity.acquireDispatchLaunch(
		req,
		queuedIdentity,
		placement?.node ?? null,
		timing,
		endpoint,
		preparation?.signal,
	);
	const ledgerRef = launch.ledger;
	// The permit was resolved before capacity admission and launch
	// preparation, both of which may wait. A dispatcher that left yolo
	// meanwhile launches its worker without the yolo grant, and every record
	// from then on carries the narrowed permit. Checked here and again right
	// before spawn, after the last wait, against fresh settings: the live
	// level and the live confinement, since contained yolo grants no yolo.
	attempt.specAutonomySettings = withLiveAutonomy(lifecycle.settings);
	const narrowPermitToLiveLevel = (): boolean => {
		if (lifecycle.permit.allowance.executeAutonomy !== "yolo") return false;
		const live = withLiveAutonomy(getEffectiveSettings() ?? lifecycle.settings);
		if (operatorAdmissionAutonomy(live) === "yolo") return false;
		lifecycle.permit = withoutExecuteAutonomy(lifecycle.permit);
		attempt.specAutonomySettings = live;
		return true;
	};
	narrowPermitToLiveLevel();
	const tokenMeter: RunTokenMeter = {};
	const safetyDecisionCounts = { allowed: 0, blocked: 0, guardBlocked: 0, permissionRequested: 0 };
	const escalationCounts = { requested: 0, approved: 0, denied: 0, timedOut: 0 };

	const blockedAttempts: SafetyBlockedAttempt[] = [];
	const guardBlockedAttempts: SafetyBlockedAttempt[] = [];
	const permissionRequestedAttempts: SafetyBlockedAttempt[] = [];
	// Phase D: a main-authority permit binds every grant to this attempt.
	// The token is a host secret: it rides the spec and each decision frame
	// and never reaches a model or a display.
	const grantAttempt: WorkerGrantBinding | undefined = mainGrantsUnavailable(lifecycle.permit.allowance)
		? { attemptToken: randomBytes(16).toString("hex"), attempt: req.lineage?.attempt ?? 0 }
		: undefined;
	// Under fleet.permissions.mode=judge this process's safety judge decides
	// the attempt's main-authority asks. It reaches only a worker this process
	// launched itself; any other placement denies them at once.
	const judgeRouted = judgeRoutedPermit(lifecycle.permit, lifecycle.settings);
	const judgeReachable =
		judgeRouted &&
		options?.workerAskJudge !== undefined &&
		(placement === null || (placement.node.kind === "local" && placement.spawn === undefined));

	attempt.req = req;
	attempt.remoteReturn = remoteReturn;
	return {
		lifecycle,
		placement,
		sharedStoreGrant,
		endpoint,
		placed,
		launch,
		ledgerRef,
		narrowPermitToLiveLevel,
		tokenMeter,
		safetyDecisionCounts,
		escalationCounts,
		blockedAttempts,
		guardBlockedAttempts,
		permissionRequestedAttempts,
		grantAttempt,
		judgeRouted,
		judgeReachable,
	};
}
