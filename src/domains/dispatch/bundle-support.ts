// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { routeOutputBound } from "../../core/output-bound.js";
import { spendSumsOf } from "../../core/telemetry/pricing.js";
import { containedYolo, effectiveYoloConfinement } from "../../lib/autonomy/autonomy.js";
import type { ConfigContract } from "../config/contract.js";
import { calculatePricingCostUsd, type EffectivePricing } from "../providers/catalog.js";
import type { CapabilityFlags } from "../providers/index.js";
import { ceilChars } from "../session/context-accounting.js";
import type { DispatchLifecycleStage } from "./bundle-types.js";
import type { DispatchRequest } from "./contract.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import type { ResolvedTerminalReason } from "./outcome.js";
import type { RouteDecisionV1 } from "./route-decision.js";
import { type RunCallUsage, unobservedRunUsageFacts } from "./run-call-usage.js";
import type { DispatchRequestOrigin, RunNodeIdentity, RunResultDraft } from "./types.js";
import { buildDynamicPromptMessages } from "./worker-dynamic-prompt.js";

/** How long after a long-lived surface asks for it route history warming begins. */
export const ROUTE_HISTORY_WARM_DELAY_MS = 1_500;
/** Candidate forecasts a plan card shows per task, the route that runs included. */
export const PREVIEW_FORECAST_LIMIT = 6;
/** Candidate forecasts `context(scope="budget")` shows across every dispatchable agent. */
export const SESSION_FORECAST_LIMIT = 12;
/** The longest a budget read waits on a usage poll for a pool with no fresh reading; the poll itself runs on. */
export const ROUTE_QUOTA_POLL_WAIT_MS = 3_000;

/** Whether the operator runs contained yolo, which never waits for a person. */
export function operatorContainedYolo(
	settings: Readonly<ReturnType<ConfigContract["get"]>> | undefined | null,
): boolean {
	return containedYolo(settings?.safety.autonomy ?? "default", effectiveYoloConfinement(settings?.safety));
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
export const DEFAULT_RESILIENCE_COOLDOWN_MS = 15_000;
/** The grant broker expires this long before the worker's own escalation timer. */
export const GRANT_DEADLINE_MARGIN_MS = 1_000;
/** ACP event-inactivity stall window (Symphony §5.3.6 semantics); <= 0 disables. */
export const DEFAULT_ACP_STALL_TIMEOUT_MS = 300_000;
/** How often a delegated agent's question retries a screen another card holds; the merge card waits the same. */
export const PEER_QUESTION_SCREEN_RETRY_MS = 500;
const ADMISSION_INPUT_TOKEN_ESTIMATE = 4096;
export const ACP_TOOL_SIGNATURE = "acp:unobservable";
export const ACP_SPEC_FINGERPRINT = "acp:unobservable";
/**
 * An ACP delegation's route tuple names the agent id as its model, a stand-in for
 * the peer's own default. A plan pin or an exact-mode retry stamps that tuple back
 * onto the request, so a model equal to the agent id is dropped here and never asks
 * the peer for a model it does not offer; only the caller's own model survives.
 */
export function withoutDelegationStandInModel(req: DispatchRequest, agentId: string): DispatchRequest {
	if (req.model !== agentId) return req;
	const { model: _standIn, ...rest } = req;
	return rest;
}
/**
 * Where the worker process ran when no fleet placement chose a node. This is the
 * worker's own host, never the host serving the model: a run against a remote
 * target from this machine is still a local node. Emitted on every run so a
 * receipt has one node shape, rather than carrying the block only on the paths
 * that happened to have a placement object.
 */
export const LOCAL_RUN_NODE: RunNodeIdentity = { id: "local", kind: "local" };

/** v21 receipt fields; call ids are omitted, never empty, when no call telemetry reached the host (#434). */
export function runSettlementReceiptFields(
	terminal: ResolvedTerminalReason,
	usage: RunCallUsage | undefined,
): Pick<RunResultDraft, "terminalReason" | "callIds" | "spend" | "spendSums"> {
	// The receipt's spend is the call fold at settlement, the same facts run.settled records (#434).
	return {
		terminalReason: terminal.terminalReason,
		...(usage ? { callIds: [...usage.callIds] } : {}),
		spend: usage?.facts ?? unobservedRunUsageFacts(),
		spendSums: usage?.sums ?? spendSumsOf(unobservedRunUsageFacts()),
	};
}

export function sealRouteDecision(draft: RunResultDraft, decision: RouteDecisionV1): RunResultDraft {
	return { ...draft, routeDecision: decision };
}
export const UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD = 1;

/**
 * Output-token figure the admission estimate prices a route against: the
 * route's own output bound (routeOutputBound), so an unset chat.maxOutputTokens
 * prices the model's cap and not one token (M6).
 */
export function admissionMaxOutputTokens(settings: EffectiveSettings, capabilities: CapabilityFlags | null): number {
	return routeOutputBound(
		{ contextWindow: capabilities?.contextWindow ?? 0, maxTokens: capabilities?.maxTokens ?? 0 },
		settings?.chat.maxOutputTokens ?? DEFAULT_SETTINGS.chat.maxOutputTokens,
	);
}

/** Unpriced and zero-rate routes pass the session cost ceiling at admission, and the ceiling stop spares them. */
export function budgetExemptRoute(pricing: EffectivePricing): boolean {
	return pricing.rates === null || Object.values(pricing.rates).every((rate) => rate === 0);
}

export function conservativeRouteAdmissionEstimateUsd(
	pricing: EffectivePricing,
	maxOutputTokens: number,
	req: DispatchRequest,
	prompt?: Pick<DispatchLifecycleStage, "systemPrompt" | "dynamicPromptMessages">,
): number {
	if (pricing.pricedBy === "free") return 0;
	if (pricing.rates === null) return UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD;
	const messages = prompt?.dynamicPromptMessages ?? buildDynamicPromptMessages(req);
	const inputTokens = Math.max(
		ADMISSION_INPUT_TOKEN_ESTIMATE,
		ceilChars(
			req.task.length +
				(prompt?.systemPrompt ?? req.systemPrompt ?? "").length +
				messages.reduce((length, message) => length + message.body.length, 0),
		) + (req.contextSeed?.provenance.mode === "fork" ? req.contextSeed.provenance.estimatedTokens : 0),
	);
	return calculatePricingCostUsd(pricing.rates, { input: inputTokens, output: Math.max(1, maxOutputTokens) });
}

export function rootOriginFields(req: DispatchRequest): { rootRequestOrigin?: DispatchRequestOrigin } {
	return req.rootRequestOrigin !== undefined ? { rootRequestOrigin: req.rootRequestOrigin } : {};
}

/** The move a start event names: only one that actually left the route it came from. */
export function routeMoveFields(
	req: DispatchRequest,
	targetId: string,
	wireModelId: string,
): { routeMove?: NonNullable<DispatchRequest["routeMove"]> } {
	const move = req.routeMove;
	if (move === undefined || (move.fromTargetId === targetId && move.fromModelId === wireModelId)) return {};
	return { routeMove: move };
}

/**
 * Grace window finalization grants the domain event pump after the worker
 * ends. Token meters, tool stats, finish-contract text, and output capture
 * fold inside the pump, so the receipt waits for it to drain the source
 * stream; the bound exists so a source channel that misbehaves after process
 * exit cannot stall finalization forever.
 */
export const DISPATCH_DRAIN_GRACE_MS = 2000;

/**
 * How many finalized runs keep their observed write targets in memory. The
 * write boundary reads a run's record while closing the window it ran in, which
 * is the same wave, so a few hundred runs of headroom is far more than the
 * lookup ever reaches back for.
 */
export const RUN_WRITE_TARGET_HISTORY = 512;

export async function awaitEventDrain(drained: Promise<void>, graceMs = DISPATCH_DRAIN_GRACE_MS): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const grace = new Promise<false>((resolve) => {
		// The timer must hold the event loop: it bounds the drain wait, and
		// the finally below clears it.
		timer = setTimeout(() => resolve(false), graceMs);
	});
	try {
		return await Promise.race([drained.then(() => true), grace]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Best-effort diagnostic for failures dispatch deliberately survives. These
 * were previously silent; a swallowed ledger or finalization failure must at
 * least leave a stderr trace for triage. Never throws.
 */
/**
 * Every alternate route a retry tried refused it at admission. The retry never
 * ran, which is a failed recovery, not a policy decision, so it settles in
 * these words rather than as a denial.
 */
export class RetryRoutesRefusedError extends Error {}

/** One refused alternate in words: a down target says so, anything else keeps admission's reason. */
export function routeRefusalWords(targetId: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const reason = message
		.replace(/^dispatch: /u, "")
		.replace(/^admission denied: /u, "")
		.replace(/^target '[^']*' unavailable: /u, "");
	return /^health down\b/u.test(reason) ? `${targetId} is down` : `${targetId} could not take it (${reason})`;
}
