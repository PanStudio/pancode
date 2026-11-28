// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Retry and failover route planning: the target a request resolves to, the move around a cooling target at
 * admission, the first eligible alternate route, and the route an unmet-obligation or context-overflow retry
 * may take. Lifted from createDispatchBundle; the bundle passes its contracts, breaker and route readers.
 */

import { endpointIdentityHash } from "../../lib/worker-wire/protocol.js";
import type { AgentsContract } from "../agents/contract.js";
import type { ProvidersContract } from "../providers/index.js";
import type { ActiveRun } from "./bundle-types.js";
import type { DispatchRequest } from "./contract.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { failureClassWords, type RetryDecision } from "./failure-classification.js";
import { configuredJointTargets } from "./joint-route-resolver.js";
import type { Obligation } from "./obligation.js";
import * as recovery from "./recovery-candidates.js";
import { firstAvailableRouteCandidate, type RouteAvailability } from "./route-candidates.js";
import type { TargetBreaker } from "./target-breaker.js";
import {
	capabilityInfoForModel,
	readWorkerTargets,
	requiredCapabilityFailureDetail,
	resolveDispatchTarget,
	targetUsabilityProblem,
} from "./target-resolution.js";
import type { DispatchFailoverCandidate, DispatchFailoverMode } from "./validation.js";

/** What retry and failover route planning reads from the dispatch bundle; createDispatchBundle passes its own. */
export interface RetryRouteScope {
	agents: AgentsContract;
	providers: ProvidersContract;
	targetBreaker: TargetBreaker;
	getEffectiveSettings: () => EffectiveSettings;
	failoverModeFor: (req: DispatchRequest) => DispatchFailoverMode;
	cooldownKey: (targetId: string, runtimeId: string, wireModelId: string) => string;
	targetCooldownReason: (targetId: string, runtimeId: string, wireModelId: string) => string | null;
	routeCandidates: (req: DispatchRequest) => ReadonlyArray<DispatchFailoverCandidate>;
	approvedRetryCandidates: (run: ActiveRun, decision: RetryDecision) => DispatchFailoverCandidate[];
	memberRetryAttempt: (run: ActiveRun) => number;
	CONTEXT_OVERFLOW_RETRY: string;
}

/** The target identity a request resolves to, without composing a worker. */
function resolveTargetIdentity(
	{ agents, providers }: Pick<RetryRouteScope, "agents" | "providers">,
	req: DispatchRequest,
	settings: EffectiveSettings,
): { targetId: string; runtimeId: string; wireModelId: string } {
	const recipe = agents.get(req.agentId);
	if (!recipe) throw new Error(`dispatch: unknown agent recipe: ${req.agentId}`);
	const targets = readWorkerTargets(settings);
	const target = resolveDispatchTarget(
		req,
		recipe,
		targets.workerDefault,
		targets.workerProfiles,
		targets.agentBindings,
		targets.targetOrder,
		providers,
	);
	return { targetId: target.target.id, runtimeId: target.runtime.id, wireModelId: target.wireModelId };
}

export function routeAroundCoolingTarget(
	{
		agents,
		cooldownKey,
		failoverModeFor,
		providers,
		routeCandidates,
		targetBreaker,
		targetCooldownReason,
	}: Pick<
		RetryRouteScope,
		| "agents"
		| "cooldownKey"
		| "failoverModeFor"
		| "providers"
		| "routeCandidates"
		| "targetBreaker"
		| "targetCooldownReason"
	>,
	req: DispatchRequest,
	settings: EffectiveSettings,
): DispatchRequest | null {
	if (req.lineage !== undefined || req.delegationAgentId !== undefined) return null;
	const mode = failoverModeFor(req);
	if (mode === "none") return null;
	const resolved = resolveTargetIdentity({ agents, providers }, req, settings);
	const cooling = targetBreaker.blocked(cooldownKey(resolved.targetId, resolved.runtimeId, resolved.wireModelId));
	if (cooling === null) return null;
	const candidates = (mode === "approved" ? (req.allowedCandidates ?? []) : routeCandidates(req)).filter(
		(candidate) => candidate.agentId === req.agentId,
	);
	if (candidates.length < 2) return null;
	const probes: RouteAvailability[] = candidates.map((candidate) => {
		try {
			const identity = resolveTargetIdentity(
				{ agents, providers },
				{ ...req, target: candidate.target, model: candidate.model },
				settings,
			);
			return {
				candidate,
				unavailable: targetCooldownReason(identity.targetId, identity.runtimeId, identity.wireModelId),
			};
		} catch (error) {
			return { candidate, unavailable: error instanceof Error ? error.message : String(error) };
		}
	});
	const next = firstAvailableRouteCandidate(probes);
	if (next === null) return null;
	const rerouted: DispatchRequest = {
		...req,
		agentId: req.agentId,
		target: next.target,
		model: next.model,
		failover: mode,
		...(mode === "approved" ? { node: next.node } : {}),
		routeMove: {
			fromTargetId: resolved.targetId,
			fromModelId: resolved.wireModelId,
			reason:
				cooling.kind === "open"
					? `${resolved.targetId} is cooling down for ${Math.ceil(cooling.remainingMs / 1000)}s after ${failureClassWords(cooling.reason)}`
					: `one probe run is testing ${resolved.targetId} after ${failureClassWords(cooling.reason)}`,
		},
	};
	if (rerouted.plannedNode !== undefined && rerouted.plannedNode.id !== next.node) delete rerouted.plannedNode;
	return rerouted;
}

/**
 * First configured route on another target that can serve a retry: it
 * resolves to that target, carries every required capability, and its
 * breaker is neither open nor probing. With minContextWindow the route may
 * also be another model on the failed target, and its effective context
 * window must be strictly larger than minContextWindow. allowed narrows the
 * routes further, as an approved envelope does. otherModel instead admits
 * any target, failed one included, whose route resolves to another model.
 */
export function eligibleAlternateRoute(
	{
		agents,
		getEffectiveSettings,
		providers,
		targetCooldownReason,
	}: Pick<RetryRouteScope, "agents" | "getEffectiveSettings" | "providers" | "targetCooldownReason">,
	run: ActiveRun,
	req: DispatchRequest,
	minContextWindow?: number,
	allowed?: (candidate: DispatchFailoverCandidate) => boolean,
	otherModel = false,
): (DispatchFailoverCandidate & { contextWindow: number }) | null {
	const settings = getEffectiveSettings();
	const failed = {
		targetId: run.targetId,
		modelId: run.wireModelId,
		runtimeId: run.runtimeId,
		endpointIdentityHash: "",
	};
	const routes = configuredJointTargets(settings?.connections ?? [], failed, endpointIdentityHash).filter((route) =>
		otherModel
			? route.modelId !== run.wireModelId
			: minContextWindow === undefined
				? route.targetId !== run.targetId
				: route.targetId !== run.targetId || route.modelId !== run.wireModelId,
	);
	const windows = new Map<string, number>();
	const probes: RouteAvailability[] = routes.map((route) => {
		const candidate = { agentId: req.agentId, target: route.targetId, model: route.modelId, node: req.node ?? "local" };
		if (allowed !== undefined && !allowed(candidate)) {
			return { candidate, unavailable: "route is outside the approved failover envelope" };
		}
		try {
			const identity = resolveTargetIdentity(
				{ agents, providers },
				{ ...req, target: route.targetId, model: route.modelId },
				settings,
			);
			if (identity.targetId !== route.targetId) {
				return { candidate, unavailable: `route resolved to connection '${identity.targetId}'` };
			}
			if (identity.targetId === run.targetId && identity.wireModelId === run.wireModelId) {
				return { candidate, unavailable: "route resolved to the failed route" };
			}
			if (otherModel && identity.wireModelId === run.wireModelId) {
				return { candidate, unavailable: "route resolved to the failed model" };
			}
			// Admission refuses a target that is down or unusable, so choosing one spent the retry on a refusal
			// while a healthy alternate sat later in the configured order.
			const usability = targetUsabilityProblem(providers.list().find((entry) => entry.target.id === identity.targetId));
			if (usability !== null) return { candidate, unavailable: usability };
			const capabilities = capabilityInfoForModel(providers, identity.targetId, identity.wireModelId);
			const contextWindow = capabilities?.contextWindow ?? 0;
			windows.set(`${route.targetId}\0${route.modelId}`, contextWindow);
			const tooSmall =
				minContextWindow !== undefined && contextWindow <= minContextWindow
					? contextWindow > 0
						? `context window ${contextWindow} is not larger than ${minContextWindow}`
						: `context window is unknown, so it is not shown to be larger than ${minContextWindow}`
					: null;
			return {
				candidate,
				unavailable:
					tooSmall ??
					requiredCapabilityFailureDetail(identity.targetId, capabilities, req.requiredCapabilities) ??
					targetCooldownReason(identity.targetId, identity.runtimeId, identity.wireModelId),
			};
		} catch (error) {
			return { candidate, unavailable: error instanceof Error ? error.message : String(error) };
		}
	});
	const chosen = firstAvailableRouteCandidate(probes);
	return chosen === null ? null : { ...chosen, contextWindow: windows.get(`${chosen.target}\0${chosen.model}`) ?? 0 };
}

/**
 * Ruling 5 retries an unmet obligation once, and only on another model:
 * the routes that retry may run on, in order, or why there is none. A
 * route the caller pinned, or a plan or approval sealed, never moves.
 * Admission seals failover none on every request, so only `routeFree`,
 * recorded before admission stamped the tuple, lets that default move the
 * one retry to the first eligible route with a different wire model on any
 * target. A model the caller named is a pin too, though only a target or
 * node pin turns the request's failover to none; a route the domain moved
 * around a cooling target is not. An approved plan moves only inside its
 * envelope, in envelope order.
 */
export function planObligationRetry(
	{
		agents,
		approvedRetryCandidates,
		failoverModeFor,
		getEffectiveSettings,
		providers,
		targetCooldownReason,
	}: Pick<
		RetryRouteScope,
		| "agents"
		| "approvedRetryCandidates"
		| "failoverModeFor"
		| "getEffectiveSettings"
		| "providers"
		| "targetCooldownReason"
	>,
	run: ActiveRun,
	obligation: Obligation,
	decision: RetryDecision,
): { routes: DispatchFailoverCandidate[] } | { settlementDetail: string } {
	const unmet = (because: string) => ({
		settlementDetail: `obligation ${obligation} unmet, not retried because ${because}`,
	});
	const failedRoute = `${run.targetId}/${run.wireModelId}`;
	const mode = failoverModeFor(run.req);
	const callerPin = mode === "automatic" && run.req.routeMove === undefined && run.req.model !== undefined;
	if ((mode === "none" && run.req.routeFree !== true) || callerPin) {
		return unmet(`the route is explicitly pinned to ${failedRoute}`);
	}
	const node = run.node?.id ?? "local";
	if (mode === "approved") {
		let candidates: DispatchFailoverCandidate[] = [];
		try {
			candidates = approvedRetryCandidates(run, decision);
		} catch {
			// An envelope with no next candidate has no other model either.
		}
		const routes = candidates.filter((candidate) => candidate.model !== run.wireModelId);
		return routes.length > 0
			? { routes }
			: unmet(`the approved failover envelope has no model other than ${run.wireModelId}, which left it unmet`);
	}
	const route = eligibleAlternateRoute(
		{ agents, getEffectiveSettings, providers, targetCooldownReason },
		run,
		run.req,
		undefined,
		undefined,
		true,
	);
	return route !== null
		? { routes: [{ agentId: route.agentId, target: route.target, model: route.model, node }] }
		: unmet(`there is no other eligible model (${failedRoute} left it unmet)`);
}

/**
 * A context overflow is a verdict on the prompt against one window, so it
 * earns one retry, and only onto a route whose window is strictly larger.
 * Exact failover never moves, an approved plan moves only inside its
 * envelope, and an overflow retry that overflows again is final.
 */
export function planOverflowRetry(
	{
		CONTEXT_OVERFLOW_RETRY,
		agents,
		failoverModeFor,
		getEffectiveSettings,
		memberRetryAttempt,
		providers,
		targetCooldownReason,
	}: Pick<
		RetryRouteScope,
		| "CONTEXT_OVERFLOW_RETRY"
		| "agents"
		| "failoverModeFor"
		| "getEffectiveSettings"
		| "memberRetryAttempt"
		| "providers"
		| "targetCooldownReason"
	>,
	run: ActiveRun,
	currentRetryReason: string | null,
	maxRetries: number,
): { route: DispatchFailoverCandidate; reason: string } | { settlementDetail: string } {
	const mode = failoverModeFor(run.req);
	if (mode === "none") {
		return { settlementDetail: "context overflow not retried because failover is none, which pins the route" };
	}
	if (currentRetryReason?.startsWith(`${CONTEXT_OVERFLOW_RETRY}:`) === true) {
		return { settlementDetail: "context overflow not retried again because this attempt was already an overflow retry" };
	}
	if (maxRetries <= 0 || memberRetryAttempt(run) >= maxRetries) {
		return { settlementDetail: "context overflow not retried because the retry budget is spent" };
	}
	const failedWindow = capabilityInfoForModel(providers, run.targetId, run.wireModelId)?.contextWindow ?? 0;
	const failedRoute = `${run.targetId}/${run.wireModelId}`;
	if (failedWindow <= 0) {
		return {
			settlementDetail: `context overflow not retried because the context window of ${failedRoute} is unknown`,
		};
	}
	const node = run.node?.id ?? "local";
	const envelope = run.req.allowedCandidates ?? [];
	const route = eligibleAlternateRoute(
		{ agents, getEffectiveSettings, providers, targetCooldownReason },
		run,
		run.req,
		failedWindow,
		mode === "approved"
			? (candidate) => envelope.some((entry) => recovery.sameFailoverCandidate(entry, { ...candidate, node }))
			: undefined,
	);
	if (route === null) {
		return {
			settlementDetail: `context overflow not retried because no eligible route has a context window larger than ${failedWindow} on ${failedRoute}`,
		};
	}
	return {
		route: { agentId: route.agentId, target: route.target, model: route.model, node },
		reason: `${CONTEXT_OVERFLOW_RETRY}: ${failedWindow} -> ${route.contextWindow} on ${route.target}/${route.model}`,
	};
}
