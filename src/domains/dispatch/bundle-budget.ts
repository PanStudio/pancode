// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { renderUsdEstimate, renderUsdLimit, renderUsdSpend } from "../../core/telemetry/render.js";
import { resolveAuthTarget, resolveRuntimeAuthTarget } from "../providers/auth/index.js";
import type { EffectivePricing } from "../providers/catalog.js";
import type { RuntimeDescriptor, TargetDescriptor } from "../providers/index.js";
import { DEFAULT_QUOTA_CACHE_TTL_MS } from "../quota/cache.js";
import { buildQuotaProviders, quotaProviderIdForRuntime } from "../quota/registry.js";
import { quotaSharedStatePath, readSharedQuotaState } from "../quota/shared-state.js";
import {
	type BudgetSpendPricing,
	combineBudgetPricing,
	SESSION_COST_CEILING_REASON,
	SessionCostCeilingError,
	sessionCeilingReached,
} from "../scheduling/budget.js";
import { describeProviderQuotaDenial, PROVIDER_QUOTA_DENIED_REASON } from "./admission.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import {
	admissionMaxOutputTokens,
	budgetExemptRoute,
	conservativeRouteAdmissionEstimateUsd,
	SESSION_FORECAST_LIMIT,
} from "./bundle-support.js";
import type { DispatchLifecycleStage } from "./bundle-types.js";
import type { BudgetEconomicsView, DispatchRequest } from "./contract.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { agentRoleFactsResolver, withRunRole } from "./execution-role.js";
import { freshQuotaDenial } from "./quota-denial.js";
import { candidateForecastLines, type RouteCandidateForecast } from "./route-policy.js";
import type { ResolvedTarget } from "./target-resolution.js";
import { meterKnownUsd } from "./worker-event-fold.js";

export function createBudgetGate(rt: DispatchRuntime) {
	const { context, options } = rt;
	const { agents, getEffectiveSettings, now, safety, scheduling } = rt.core;

	/**
	 * Budget admission preflight denial. The dispatch dies before any worker or
	 * run row exists, so without this denied `tool.decided` record the journal
	 * would carry no trace that the admission gate refused the dispatch.
	 */
	function refuseForBudget(message: string): never {
		safety.decisions.recordToolCall?.({
			tool: "dispatch",
			classification: { actionClass: "dispatch" },
			decision: "denied",
			reasonCode: "budget-ceiling",
		});
		throw new Error(message);
	}

	/**
	 * R3: refuse a route whose quota pool the provider freshly and explicitly denied. Reads only the shared quota cache
	 * file, never the network, and only the reading made with the credential this route would spend now: the quota
	 * adapter reads the runtime's own login, so a target that names another credential is not bound by it, and an
	 * unknown identity on either side never binds. A route with no quota adapter, or with no fresh reading, admits
	 * unchanged.
	 */
	async function assertNoFreshQuotaDenial(
		target: TargetDescriptor,
		runtime: RuntimeDescriptor,
		route: string,
	): Promise<void> {
		const providerId = quotaProviderIdForRuntime(runtime.id);
		if (providerId === null) return;
		if (resolveAuthTarget(target, runtime).providerId !== resolveRuntimeAuthTarget(runtime).providerId) return;
		const nowMs = now();
		const shared = readSharedQuotaState(quotaSharedStatePath(), nowMs);
		const entry = shared.entries.get(providerId);
		if (entry === undefined || entry.storedAtMs <= (shared.cleared.get(providerId) ?? Number.NEGATIVE_INFINITY)) return;
		const denial = freshQuotaDenial(entry.snapshot, nowMs, DEFAULT_QUOTA_CACHE_TTL_MS);
		if (denial === null) return;
		const provider = buildQuotaProviders().find((candidate) => candidate.id === providerId);
		if (provider === undefined) return;
		const scope = provider.credentialScope === undefined ? null : await provider.credentialScope().catch(() => null);
		if (scope === null || entry.scope !== scope) return;
		safety.decisions.recordToolCall?.({
			tool: "dispatch",
			classification: { actionClass: "dispatch" },
			decision: "denied",
			reasonCode: PROVIDER_QUOTA_DENIED_REASON,
		});
		throw new Error(describeProviderQuotaDenial(denial, route));
	}

	function budgetDenialMessage(
		preflight: { currentUsd: number; ceilingUsd: number; pricing?: BudgetSpendPricing },
		routeEstimateUsd: number,
	): string {
		const estimateSuffix =
			routeEstimateUsd > 0 ? ` (includes ${renderUsdEstimate(routeEstimateUsd)} route estimate)` : "";
		return `dispatch: admission denied: budget ceiling crossed: ${renderUsdSpend(preflight.currentUsd, preflight.pricing)} / ${renderUsdLimit(preflight.ceilingUsd)}${estimateSuffix}`;
	}

	/** The route's conservative estimate against the request's own cost bound; named as an estimate (#434 §6.3). */
	function intentCeilingRefusal(req: DispatchRequest, estimateUsd: number): string | null {
		const ceilingUsd = req.routingIntent?.maxCostUsd;
		if (ceilingUsd === null || ceilingUsd === undefined || estimateUsd <= ceilingUsd) return null;
		return budgetDenialMessage(
			{ currentUsd: estimateUsd, ceilingUsd, pricing: { estimated: true, unpriced: false } },
			estimateUsd,
		);
	}

	/** The session ceiling against the spend the read model holds now, plus what running workers have metered. */
	function sessionCeilingRefusal(): SessionCostCeilingError | null {
		const preflight = scheduling.preflight();
		const currentUsd = preflight.currentUsd + inFlightSpendUsd();
		if (!sessionCeilingReached(currentUsd, preflight.ceilingUsd)) return null;
		return new SessionCostCeilingError(
			currentUsd,
			preflight.ceilingUsd,
			undefined,
			undefined,
			combineBudgetPricing(preflight.pricing, inFlightPricing()),
		);
	}

	/**
	 * Priced spend metered by workers still running, beyond what the session's read model already folds from their run
	 * journals. Without it a fan-out admitted every member against settled spend alone; counted whole, a call that
	 * settled into a running worker's journal would count twice, once spent and once projected (#434).
	 */
	function inFlightSpendUsd(): number {
		const telemetry = context.getContract("telemetry");
		let usd = 0;
		for (const [runId, run] of rt.runs.active)
			usd += Math.max(0, meterKnownUsd(run.meter) - (telemetry?.journaledRunUsd(runId) ?? 0));
		return usd;
	}

	/** How the running workers' meters priced their spend, so a stop that counts it marks it (#434 §6.3). */
	function inFlightPricing(): BudgetSpendPricing {
		const pricing = { estimated: false, unpriced: false };
		for (const run of rt.runs.active.values()) {
			const usd = run.meter.usage?.sums.usd;
			if (!usd) continue;
			if (usd.coverage.estimated > 0) pricing.estimated = true;
			if (usd.unknownCount > 0) pricing.unpriced = true;
		}
		return pricing;
	}

	/**
	 * S16: the session's economics view. Spend is what admission counts, settled journals plus workers still metering,
	 * read after every queued settlement is written, so the model call that asked is counted and priced as the usage
	 * report counts it; unobserved without a telemetry read model rather than a measured zero. The pool is the chat
	 * route's newest fresh quota reading (routeQuotaPool); forecasts are the plan card's lines for every dispatchable
	 * agent's routes, so a caller reads them before it dispatches, asked or not.
	 */
	async function budgetEconomics(): Promise<BudgetEconomicsView> {
		const preflight = scheduling.preflight();
		const telemetry = context.getContract("telemetry");
		const settled = telemetry === undefined ? undefined : await telemetry.settledSessionSpend();
		const pricing = combineBudgetPricing(
			settled === undefined ? preflight.pricing : { estimated: settled.estimated, unpriced: settled.unpriced },
			inFlightPricing(),
		);
		const usd = (settled?.usd ?? preflight.currentUsd) + inFlightSpendUsd();
		const ceilingUsd = preflight.ceilingUsd > 0 ? preflight.ceilingUsd : null;
		const settings = getEffectiveSettings();
		const route = rt.quota.chatQuotaRoute();
		const pool =
			route === null
				? { status: "none" as const, reason: "no chat route" }
				: await rt.quota.routeQuotaPool(route.target, route.runtime);
		const observed = telemetry !== undefined;
		return {
			scope: "session",
			spend: observed
				? {
						usd,
						basis:
							pricing === undefined
								? "unstated"
								: pricing.unpriced
									? "lower-bound"
									: pricing.estimated
										? "estimated"
										: "measured",
						ceilingUsd,
						headroomUsd: ceilingUsd === null ? null : Math.max(0, ceilingUsd - usd),
					}
				: { usd: null, basis: "unobserved", ceilingUsd, headroomUsd: null },
			pool,
			forecasts: sessionForecasts(settings),
		};
	}

	/**
	 * Every dispatchable agent's candidate forecasts as plan-card lines (R4): first the route each agent runs on now, then
	 * the alternatives its router weighs, deduplicated and bounded. Reads route history and settings only; an agent whose
	 * route cannot be previewed is skipped, as its dispatch would report.
	 */
	function sessionForecasts(settings: EffectiveSettings): string[] {
		const roleFacts = agentRoleFactsResolver((id) => agents.getSpec(id));
		const runs: RouteCandidateForecast[] = [];
		const alternatives: RouteCandidateForecast[] = [];
		for (const spec of agents.listSpecs()) {
			if (spec.audience === "internal") continue;
			// Routing reads the agent and intent, never the task text; dispatch requires a non-empty task.
			const req = withRunRole({ agentId: spec.id, task: "forecast preview" }, roleFacts);
			let forecasts: ReturnType<typeof rt.route.previewForecasts>;
			try {
				forecasts = rt.route.previewForecasts(req, rt.preview.previewFixed(req, settings), settings);
			} catch {
				continue;
			}
			for (const candidate of forecasts?.candidates ?? []) (candidate.executed ? runs : alternatives).push(candidate);
		}
		const seen = new Set<string>();
		const unique = [...runs, ...alternatives].filter((candidate) => {
			if (seen.has(candidate.route)) return false;
			seen.add(candidate.route);
			return true;
		});
		return candidateForecastLines({
			candidates: unique.slice(0, SESSION_FORECAST_LIMIT),
			omitted: Math.max(0, unique.length - SESSION_FORECAST_LIMIT),
		});
	}

	/**
	 * Admission alone lets running workers spend past the session cost ceiling
	 * (or a `pancode run --max-cost-usd` cap). Every metered worker call
	 * re-checks settled plus in-flight spend and stops each running worker once
	 * the ceiling is reached, so spend passes it only by the calls workers
	 * already had in flight. A ceiling of 0 is off.
	 */
	function stopRunsAtCostCeiling(): void {
		const cap = scheduling.runCostCap?.() ?? undefined;
		const ceilingUsd = getEffectiveSettings()?.safety.limits.sessionCostUsd ?? scheduling.ceilingUsd();
		if (!(ceilingUsd > 0)) return;
		const preflight = scheduling.preflight();
		const currentUsd = preflight.currentUsd + inFlightSpendUsd();
		if (!sessionCeilingReached(currentUsd, ceilingUsd)) return;
		const pricing = combineBudgetPricing(preflight.pricing, inFlightPricing());
		const detail = new SessionCostCeilingError(currentUsd, ceilingUsd, cap, undefined, pricing).message;
		for (const run of rt.runs.active.values()) {
			// A run on its merge card or already sealing has no worker left to stop.
			if (run.aborted || run.stallKilled || run.sealing === true || run.awaitingOperator === true) continue;
			if (run.budgetExempt === true) continue;
			rt.contract.contract.abort(run.runId, { cause: "budget", detail });
		}
	}

	async function assertBudgetAdmitsRoute(
		req: DispatchRequest,
		pricing: EffectivePricing,
		settings: EffectiveSettings,
		prompt: Pick<DispatchLifecycleStage, "systemPrompt" | "dynamicPromptMessages"> & {
			target?: Pick<ResolvedTarget, "modelCapabilities">;
		},
		signal?: AbortSignal,
	): Promise<void> {
		const estimateUsd = conservativeRouteAdmissionEstimateUsd(
			pricing,
			admissionMaxOutputTokens(settings, prompt.target?.modelCapabilities ?? null),
			req,
			prompt,
		);
		const intentRefusal = intentCeilingRefusal(req, estimateUsd);
		if (intentRefusal !== null) refuseForBudget(intentRefusal);
		if (budgetExemptRoute(pricing)) return;
		try {
			if (scheduling.admitPaidRequest) {
				await scheduling.admitPaidRequest({
					waitForRaise: options?.budgetWaitForRaise === true,
					additionalUsd: inFlightSpendUsd,
					additionalPricing: inFlightPricing(),
					getCeilingUsd: () => getEffectiveSettings()?.safety.limits.sessionCostUsd ?? scheduling.ceilingUsd(),
					...(signal ? { signal } : {}),
				});
			} else {
				const refusal = sessionCeilingRefusal();
				if (refusal !== null) throw refusal;
			}
		} catch (error) {
			if (error instanceof SessionCostCeilingError) {
				safety.decisions.recordToolCall?.({
					tool: "dispatch",
					classification: { actionClass: "dispatch" },
					decision: "denied",
					reasonCode: SESSION_COST_CEILING_REASON,
				});
			}
			throw error;
		}
	}

	return {
		assertBudgetAdmitsRoute,
		assertNoFreshQuotaDenial,
		budgetEconomics,
		intentCeilingRefusal,
		sessionCeilingRefusal,
		stopRunsAtCostCeiling,
	};
}
