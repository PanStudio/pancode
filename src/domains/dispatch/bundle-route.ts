// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { type TelemetryContext, workerAgent } from "../../core/telemetry/context.js";
import { endpointIdentityHash } from "../../lib/worker-wire/protocol.js";
import { type CheckoutRootLookup, checkoutRootLookup } from "../../tools/task-worktree.js";
import { isHoareResultContract } from "../agents/result-contract-types.js";
import { normalizeAgentSpec } from "../agents/spec.js";
import { workspaceStoreTags } from "../store/index.js";
import { planActiveRoute } from "./active-route-planner.js";
import {
	EXTERNAL_READ_APPROVAL_REQUIRED,
	externalReadShapeAdmissible,
	missingStoreTagRefusal,
	remoteStoreGrantRefusal,
	storeGrantScopeRefusal,
} from "./admission-scope.js";
import { agentRouteCandidates } from "./agent-candidates.js";
import { materializeAgentPlanSelection } from "./agent-plan-adapter.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { budgetExemptRoute, PREVIEW_FORECAST_LIMIT } from "./bundle-support.js";
import type { DispatchContract, DispatchPlanTaskResolution, DispatchRequest } from "./contract.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { dispatchResultContract, routeCorrelationFactsForRun, withAttemptRole } from "./execution-role.js";
import { routeFactVerdict } from "./fleet-preflight.js";
import { adaptJointRouteInput } from "./joint-route-adapter.js";
import {
	configuredJointNodes,
	configuredJointTargets,
	type JointRouteResolverInput,
	resolveJointRoute,
} from "./joint-route-resolver.js";
import { requestedWriteNone } from "./obligation.js";
import * as recovery from "./recovery-candidates.js";
import { ROUTE_CANDIDATE_LIMIT, routeBoundaryRejections } from "./route-candidates.js";
import {
	fixedRouteDecision,
	type RouteDecisionV1,
	type RouteIdentityInput,
	type RouteRoleInput,
	routeCandidateKey,
	toRouteCandidate,
} from "./route-decision.js";
import type { RouteObservationHandle } from "./route-observer.js";
import { defaultRoutingIntent } from "./routing-intent.js";
import { fleetRootTelemetryContext } from "./run-telemetry.js";
import { computeSettingsFingerprint } from "./settings-fingerprint.js";
import { capabilityInfoForModel } from "./target-resolution.js";
import type { RunNodeIdentity } from "./types.js";
import type { DispatchFailoverCandidate } from "./validation.js";

export function createRouteSelection(rt: DispatchRuntime) {
	const { options } = rt;
	const { agents, getEffectiveSettings, now, providers, routeObserver, scheduling, targetCooldownReason } = rt.core;

	function jointRouteInput(
		req: DispatchRequest,
		placedNode?: RunNodeIdentity,
		settings: EffectiveSettings = getEffectiveSettings(),
		mode: JointRouteResolverInput["mode"] = "shadow",
		agentIntent?: Parameters<typeof agentRouteCandidates>[0]["intentOverride"],
		checkoutRoot: CheckoutRootLookup = checkoutRootLookup(),
	): { input: JointRouteResolverInput; resolution: DispatchPlanTaskResolution } {
		let resolution: DispatchPlanTaskResolution;
		try {
			resolution = rt.preview.previewFixed(req, settings, checkoutRoot);
		} catch (error) {
			if (placedNode === undefined) throw error;
			resolution = { ...rt.preview.previewFixed({ ...req, node: "local" }, settings, checkoutRoot), node: placedNode };
		}
		const role: RouteRoleInput = { executionRole: withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0) };
		if (req.systemPrompt !== undefined) role.personaPrompt = req.systemPrompt;
		const identity = (value: DispatchPlanTaskResolution, nodeId: string): RouteIdentityInput => ({ ...value, nodeId });
		const executedRoute = toRouteCandidate(identity(resolution, placedNode?.id ?? resolution.node.id), role);
		const specs = agents.listSpecs();
		const auto = req.agentSelection?.mode === "auto";
		const agentCandidates = agentRouteCandidates({
			...(options?.getCapabilityGate ? { gate: options.getCapabilityGate() } : {}),
			specs,
			request: req,
			mode,
			activeAgentRoles: settings?.fleet.adaptiveRouting.agentRoles ?? [],
			...(agentIntent === undefined ? {} : { intentOverride: agentIntent }),
		});
		const settingsFingerprint = computeSettingsFingerprint(settings ?? null);
		const fixedDelegation = resolution.runtimeId === "acp";
		const fallbackTarget = {
			targetId: resolution.targetId,
			modelId: resolution.wireModelId,
			runtimeId: resolution.runtimeId,
			endpointIdentityHash: resolution.endpointIdentityHash,
		};
		const targets = configuredJointTargets(
			fixedDelegation ? [] : (settings?.targets ?? []),
			fallbackTarget,
			endpointIdentityHash,
		);
		const nodes = configuredJointNodes(
			(settings?.fleet?.nodes ?? []).map((node) => node.id),
			resolution.node.id,
			fixedDelegation,
		);
		const subjectRef = req.gate?.subjects?.[0];
		const subject = subjectRef === undefined ? null : rt.runs.ledger?.get(subjectRef.runId);
		const input = adaptJointRouteInput({
			mode,
			request: req,
			exact: rt.retry.failoverModeFor(req) === "none",
			executedRoute,
			agents: agentCandidates.dimensions,
			agentSelection: {
				request: auto ? "auto" : "explicit",
				baselineAgentId: req.agentSelection?.baselineAgentId ?? req.agentId,
				evaluations: agentCandidates.evaluations,
				authorityBasis: req.agentSelection?.authorityBasis ?? null,
			},
			targets,
			nodes,
			intent: req.routingIntent ?? defaultRoutingIntent(req),
			independenceSubject: subject === null || subject === undefined ? null : routeCorrelationFactsForRun(subject),
			settingsFingerprint,
			readiness: routeObserver.readinessWindow(),
			cooldown: (target) => targetCooldownReason(target.targetId, target.runtimeId, target.modelId),
			facts: (target, node) =>
				routeFactVerdict(
					{
						nodeId: node.nodeId,
						targetId: target.targetId,
						wireModelId: target.modelId,
						endpointIdentityHash: target.endpointIdentityHash,
						requireReachable: true,
						requireRuntimeCompatible: true,
						requireModelAvailable: true,
						requireGpuCount: null,
						requireVramBytes: null,
						mode,
					},
					undefined,
					{ now: now() },
				),
			preview: (agent, target, node) => {
				const candidateRequest = { ...req, agentId: agent.agentId, executionRole: agent.executionRole };
				const probed = rt.preview.previewFixed(
					{ ...candidateRequest, target: target.targetId, model: target.modelId, node: node.nodeId },
					settings,
					checkoutRoot,
				);
				const candidateRole: RouteRoleInput = { executionRole: agent.executionRole };
				if (candidateRequest.systemPrompt !== undefined) candidateRole.personaPrompt = candidateRequest.systemPrompt;
				const info = capabilityInfoForModel(providers, probed.targetId, probed.wireModelId);
				return {
					candidate: toRouteCandidate(identity(probed, node.nodeId), candidateRole),
					capabilities:
						info === null
							? []
							: Object.entries(info)
									.filter(([, value]) => value !== false && value !== undefined && value !== 0)
									.map(([name]) => name),
					costUpperBoundUsd: probed.costUpperBoundKnown ? probed.costUpperBoundUsd : null,
				};
			},
			envelopeRejection: (candidate) => {
				if (req.lineage === undefined || req.routeApproval === undefined) return null;
				// This verdict replaces the boundary one, so it keeps an attempt narrowed to part of the approval inside that part.
				const narrowed = routeBoundaryRejections(
					req,
					{
						agentId: candidate.agentId,
						targetId: candidate.targetId,
						modelId: candidate.modelId,
						nodeId: candidate.nodeId,
					},
					false,
				)["approved-envelope"];
				return narrowed ?? recovery.approvedEnvelopeRejection(req.routeApproval, candidate);
			},
		});
		return { input, resolution };
	}

	function preview(
		req: DispatchRequest,
		settings: EffectiveSettings = getEffectiveSettings(),
		checkoutRoot: CheckoutRootLookup = checkoutRootLookup(),
	): DispatchPlanTaskResolution {
		const fixed = rt.preview.previewFixed(req, settings, checkoutRoot);
		const recipe = agents.get(req.agentId);
		return planActiveRoute({
			request: req,
			settings: settings?.fleet.adaptiveRouting,
			capabilityClass: recipe === null ? null : normalizeAgentSpec(recipe).capabilityClass,
			failover: rt.retry.failoverModeFor(req),
			fixed,
			maxAttempts: rt.retry.workersMaxRetries(settings) + 1,
			resolveDecision: () =>
				resolveJointRoute(jointRouteInput(req, undefined, settings, "active", undefined, checkoutRoot).input).decision,
			preview: (request) => rt.preview.previewFixed(request, settings, checkoutRoot),
		});
	}

	/**
	 * The plan-card preview (FL-13): the planned route, then the run's admission checks that can run synchronously,
	 * through the same cores the run uses. Nothing is consumed or recorded. A part only the run can settle (an outside
	 * read approval, a budget hold) is named on the card as checked at run.
	 */
	function previewAdmission(
		req: DispatchRequest,
		settings: EffectiveSettings = getEffectiveSettings(),
	): DispatchPlanTaskResolution {
		const checkoutRoot = checkoutRootLookup();
		return withPreviewAdmission(req, preview(req, settings, checkoutRoot), settings, checkoutRoot);
	}

	function withPreviewAdmission(
		req: DispatchRequest,
		resolution: DispatchPlanTaskResolution,
		settings: EffectiveSettings,
		checkoutRoot: CheckoutRootLookup = checkoutRootLookup(),
	): DispatchPlanTaskResolution {
		const routed: DispatchRequest = { ...req, agentId: resolution.agentId };
		const checkedAtRun: string[] = [];
		if (!externalReadShapeAdmissible(routed, agents.getSpec(routed.agentId)))
			throw new Error(EXTERNAL_READ_APPROVAL_REQUIRED);
		if (routed.externalReadRoot !== undefined)
			checkedAtRun.push(`outside read root ${routed.externalReadRoot}: approval is asked at run`);
		const tags = routed.storeTags ?? [];
		if (tags.length > 0) {
			const recipe = agents.get(routed.agentId);
			const readOnly = requestedWriteNone({
				readOnly: routed.readOnly,
				capabilityClass: recipe === null ? null : normalizeAgentSpec(recipe).capabilityClass,
				hoareContract: recipe !== null && isHoareResultContract(dispatchResultContract(routed, recipe)),
			});
			const scope = storeGrantScopeRefusal(routed, readOnly);
			if (scope !== null) throw new Error(scope);
			const remote = remoteStoreGrantRefusal(routed, resolution.node);
			if (remote !== null) throw new Error(remote);
			if (resolution.node.kind === "ssh" && !readOnly)
				checkedAtRun.push(
					`store tags ${tags.join(", ")} on node ${resolution.node.id}: each root is checked at run and by the node`,
				);
			const listed = workspaceStoreTags(routed.cwd ?? process.cwd());
			const missing = tags.find((tag) => !listed.includes(tag));
			if (missing !== undefined) throw new Error(missingStoreTagRefusal(missing));
		}
		const intent = rt.budget.intentCeilingRefusal(routed, resolution.costUpperBoundUsd);
		if (intent !== null) throw new Error(intent);
		const ceiling = rt.budget.sessionCeilingRefusal();
		if (ceiling !== null && resolution.runtimeId !== "acp") {
			const pinned = rt.preview.previewFixedStages(
				{ ...routed, target: resolution.targetId, model: resolution.wireModelId, node: resolution.node.id },
				settings,
				checkoutRoot,
			);
			if (pinned.pricing !== null && !budgetExemptRoute(pinned.pricing)) {
				if (scheduling.admitPaidRequest === undefined || options?.budgetWaitForRaise !== true) throw ceiling;
				checkedAtRun.push("session cost ceiling reached: the run waits for a raise");
			}
		}
		const forecasts = previewForecasts(routed, resolution, settings, checkoutRoot);
		return {
			...resolution,
			...(checkedAtRun.length === 0 ? {} : { checkedAtRun }),
			...(forecasts === null ? {} : { forecasts }),
		};
	}

	/**
	 * The plan card's per-candidate forecasts (R4): the decision this task runs on, or the shadow one the router would
	 * make, each candidate read from the same readiness window the ranking reads. The route that runs comes first, then
	 * eligible candidates in rank order, then excluded ones with their reason. Reads route history only; null when the
	 * route universe cannot be enumerated, which the run itself reports.
	 */
	function previewForecasts(
		req: DispatchRequest,
		resolution: DispatchPlanTaskResolution,
		settings: EffectiveSettings,
		checkoutRoot: CheckoutRootLookup = checkoutRootLookup(),
	): NonNullable<DispatchPlanTaskResolution["forecasts"]> | null {
		let decision: RouteDecisionV1;
		try {
			decision =
				resolution.routeApproval?.decision ??
				resolveJointRoute(jointRouteInput(req, undefined, settings, "shadow", undefined, checkoutRoot).input).decision;
		} catch {
			return null;
		}
		const readiness = routeObserver.readinessWindow();
		const executed = routeCandidateKey(decision.executedRoute);
		const rank = (entry: { rejection: string | null; score: number | null }) =>
			entry.rejection === null ? -(entry.score ?? Number.NEGATIVE_INFINITY) : Number.POSITIVE_INFINITY;
		const others = decision.candidateEvaluations
			.filter((entry) => routeCandidateKey(entry.candidate) !== executed)
			.sort((left, right) => rank(left) - rank(right));
		const executedEntry = decision.candidateEvaluations.find((entry) => routeCandidateKey(entry.candidate) === executed);
		const ordered = [{ candidate: decision.executedRoute, rejection: executedEntry?.rejection ?? null }, ...others];
		return {
			candidates: ordered.slice(0, PREVIEW_FORECAST_LIMIT).map(({ candidate, rejection }) => ({
				route: `${candidate.agentId} ${candidate.targetId}/${candidate.modelId}@${candidate.nodeId}`,
				executed: routeCandidateKey(candidate) === executed,
				forecast: {
					...readiness.forRoute(candidate, { costUpperBoundUsd: null, factsFresh: true }).forecast,
					exclusion: rejection,
				},
			})),
			omitted: Math.max(0, ordered.length - PREVIEW_FORECAST_LIMIT),
		};
	}

	const planAgentSelection: DispatchContract["planAgentSelection"] = (input) => {
		const settings = getEffectiveSettings();
		const checkoutRoot = checkoutRootLookup();
		const selection = materializeAgentPlanSelection(input, {
			resolve: (request, mode, intent) =>
				resolveJointRoute(jointRouteInput(request, undefined, settings, mode, intent, checkoutRoot).input).decision,
			preview: (request) => rt.preview.previewFixed(request, settings, checkoutRoot),
			getAgentSpec: (agentId) => agents.getSpec(agentId),
		});
		return {
			...selection,
			resolution: withPreviewAdmission(input.request, selection.resolution, settings, checkoutRoot),
		};
	};

	function routeCandidates(req: DispatchRequest): ReadonlyArray<DispatchFailoverCandidate> {
		const settings = getEffectiveSettings();
		const checkoutRoot = checkoutRootLookup();
		const planned = preview(req, settings, checkoutRoot);
		const input = jointRouteInput(req, undefined, settings, "shadow", undefined, checkoutRoot).input;
		const decision = planned.routeApproval?.decision ?? resolveJointRoute(input).decision;
		const ordered = planned.routeApproval
			? [decision.selected, ...decision.approvedFallbacks]
			: [input.executedRoute, decision.selected, ...decision.approvedFallbacks];
		const unique = new Map(ordered.map((candidate) => [routeCandidateKey(candidate), candidate]));
		const candidates = [...unique.values()].filter(
			(candidate) => planned.routeApproval !== null || candidate.agentId === req.agentId,
		);
		return candidates.slice(0, ROUTE_CANDIDATE_LIMIT).map((candidate) => ({
			agentId: candidate.agentId,
			target: candidate.targetId,
			model: candidate.modelId,
			node: candidate.nodeId,
		}));
	}

	/** Build and record a joint shadow decision without feeding it into execution. */
	function observeShadowRoute(
		req: DispatchRequest,
		placedNode?: RunNodeIdentity,
		settings: EffectiveSettings = getEffectiveSettings(),
		checkoutRoot: CheckoutRootLookup = checkoutRootLookup(),
	): RouteObservationHandle {
		const { input } = jointRouteInput(req, placedNode, settings, "shadow", undefined, checkoutRoot);
		let decision: RouteDecisionV1;
		try {
			const started = process.hrtime.bigint();
			decision = resolveJointRoute(input).decision;
			decision.decisionDurationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
		} catch {
			decision = fixedRouteDecision(input.executedRoute);
		}
		return routeObserver.observe(routeObservationInput(req, decision));
	}

	/**
	 * A context naming the run alone. A run whose journal is not open has no sink under it, so a run-scoped record is
	 * counted unowned rather than written into whichever scope the async context names (#434).
	 */
	function sinklessRunContext(runId: string, sessionId: string | null | undefined): TelemetryContext {
		return { sessionId: sessionId ?? null, runId, agent: workerAgent(runId) };
	}

	/** A fleet step's route belongs to its fleet root; any other dispatch's to the async context that asked (#434). */
	function routeObservationInput(req: DispatchRequest, decision: RouteDecisionV1) {
		const ctx =
			fleetRootTelemetryContext(req.lineage?.rootRunId) ??
			fleetRootTelemetryContext(req.lineage?.parentRunId ?? undefined);
		return { task: req.task, decision, ...(ctx !== undefined ? { ctx } : {}) };
	}

	return {
		jointRouteInput,
		observeShadowRoute,
		planAgentSelection,
		previewAdmission,
		previewForecasts,
		routeCandidates,
		routeObservationInput,
		sinklessRunContext,
	};
}
