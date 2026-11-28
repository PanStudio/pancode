// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isWorkerToolCallCapExceededReason } from "../../core/guardrails.js";
import type { ToolName } from "../../core/tool-names.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import { confirmationRuleOf } from "../../domains/safety/decision-events.js";
import type { RegistryVerdict, ToolInvokeOptions } from "./contract.js";
import { firstBlockToolEffect } from "./hook-effects.js";
import { gatewayInnerScope } from "./nested-calls.js";
import type { RegistryScope } from "./scope.js";
import { blockedVerdict, GUARD_BLOCK_REASON_CODE } from "./verdicts.js";

/**
 * How a registry records a call's admission disposition and observes its blocked and rejected attempts, and
 * the tool guard's block.
 */
export function createRegistryAttempts(reg: RegistryScope) {
	const { deps, tools } = reg;
	const recordRegistryDisposition = (
		call: ClassifierCall,
		decision: SafetyDecision,
		auditDecision: "allowed" | "blocked" | "permission_requested" | "denied",
		overrides?: { reasonCode?: string; requestId?: string },
	): void => {
		// Evaluation records nothing: admission keeps the final disposition and the classification together (#434).
		deps.safety.decisions.recordToolCall?.({
			tool: call.tool,
			classification: decision.classification,
			decision: auditDecision,
			...(gatewayInnerScope.getStore() === true ? { inner: true as const } : {}),
			...(overrides?.requestId !== undefined ? { requestId: overrides.requestId } : {}),
			...(decision.policy !== undefined ? { policy: decision.policy } : {}),
			...(overrides?.reasonCode !== undefined ? { reasonCode: overrides.reasonCode } : {}),
			...confirmationRuleOf(decision),
		});
	};

	/**
	 * Loop-observe a safety-blocked attempt. The verdict stands and every
	 * effect is discarded; this exists so the before_tool loop guard sees
	 * rejected attempts too. Without it, a model repeating an identical
	 * blocked call would never trip the detector (the former worker guard sat
	 * in front of admission and had this coverage).
	 */
	const observeBlockedAttempt = (
		call: ClassifierCall,
		verdict: RegistryVerdict,
		options?: ToolInvokeOptions,
	): RegistryVerdict | null => {
		if (verdict.kind !== "blocked") return null;
		return guardOverrideForRejectedAttempt(
			call,
			verdict.decision,
			observeRejectedAttempt(call, verdict.decision, options),
		);
	};

	/**
	 * Run before_tool hooks for an attempt that will not execute, so repetition
	 * detectors see it. Most effects do not change the rejection itself; the
	 * worker tool-call cap is the exception, because it is the deterministic
	 * run bound for denied-call spirals. The returned value is the first
	 * block_tool reason (the loop guard's actionable feedback), which the
	 * park-denial path substitutes for its generic reason so a model retrying a
	 * denied call learns to stop instead of looping until the run times out.
	 */
	const observeRejectedAttempt = (
		call: ClassifierCall,
		decision: SafetyDecision,
		options?: ToolInvokeOptions,
	): string | null => {
		if (!deps.middleware) return null;
		const spec = tools.get(call.tool as ToolName);
		if (!spec) return null;
		const effects = reg.runToolHook("before_tool", spec, call, decision, options);
		return firstBlockToolEffect(effects)?.reason ?? null;
	};

	const guardOverrideForRejectedAttempt = (
		call: ClassifierCall,
		decision: SafetyDecision,
		reason: string | null,
	): RegistryVerdict | null => {
		if (reason === null || !isWorkerToolCallCapExceededReason(reason)) return null;
		return guardBlocked(call, decision, reason);
	};

	/**
	 * Terminal blocked verdict for a before_tool guard block (loop guard,
	 * protected artifacts, dispatch dedup, declarative block rules) on a call
	 * whose admission already passed. The decision is re-shaped as a block, and
	 * the carried policy's net-pass reasonCode is replaced with the guard axis,
	 * so downstream consumers (worker finish events, dispatch receipts, audit)
	 * count a blocked safety decision instead of repeating the admission's allow.
	 * The ledger records the re-shaped decision.
	 */
	const guardBlocked = (
		call: ClassifierCall,
		decision: SafetyDecision,
		reason: string,
		ruleId?: string,
	): Extract<RegistryVerdict, { kind: "blocked" }> => {
		const verdict = blockedVerdict(decision, `${call.tool} blocked: tool guard`, reason, {
			reasonCode: GUARD_BLOCK_REASON_CODE,
			...(ruleId !== undefined ? { ruleId } : {}),
		});
		recordRegistryDisposition(call, verdict.decision, "blocked", { reasonCode: GUARD_BLOCK_REASON_CODE });
		return verdict;
	};
	return {
		recordRegistryDisposition,
		observeBlockedAttempt,
		observeRejectedAttempt,
		guardOverrideForRejectedAttempt,
		guardBlocked,
	};
}
