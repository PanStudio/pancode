// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { AsyncLocalStorage } from "node:async_hooks";
import { withToolTelemetryContext } from "../../core/telemetry/context.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import type { ToolDenial } from "../../domains/safety/denial.js";
import type { ToolResult } from "../tool-spec.js";
import type { ExecutionProvenance, RegistryVerdict, ToolInvokeOptions } from "./contract.js";

/** Delegated execution evidence stays in process, never in model-visible result fields. */
/** Whether the invocation in progress is a capability the gateway runs under the model's call (C-9). */
export const gatewayInnerScope = new AsyncLocalStorage<boolean>();

/** The telemetry scope of one invocation, with whether its decisions are a gateway call's inner rows. */
export function withRegistryScope<T>(options: ToolInvokeOptions | undefined, work: () => T): T {
	return gatewayInnerScope.run(options?.gatewayInner === true, () => withToolTelemetryContext(options ?? {}, work));
}

export const nestedExecutions = new WeakMap<ToolResult, { decision: SafetyDecision; execution: ExecutionProvenance }>();

export const nestedChainResults = new WeakMap<ToolResult, ExecutionProvenance>();

const nestedBlockedExecutions = new WeakMap<object, ExecutionProvenance>();

export function recordedExecution(verdict: ExecutionProvenance & { decision: SafetyDecision }): ExecutionProvenance {
	return verdict.executionStarted === true
		? { executionStarted: true, executionDecisions: verdict.executionDecisions ?? [verdict.decision] }
		: {};
}

/** Mark a gateway chain's combined result, whose step notes the nested calls recorded. */
export function nestedChainResult(result: ToolResult, steps: ReadonlyArray<ToolResult>): ToolResult {
	const decisions = steps.flatMap((step) => {
		const blocked = nestedBlockedVerdict(step);
		const execution = blocked === null ? nestedExecutions.get(step)?.execution : recordedExecution(blocked);
		return execution?.executionDecisions ?? [];
	});
	nestedChainResults.set(result, decisions.length > 0 ? { executionStarted: true, executionDecisions: decisions } : {});
	return result;
}

/** Carry trusted in-process delegation authority without adding model-visible metadata. */
export function nestedExecutedResult(
	result: ToolResult,
	verdict: Extract<RegistryVerdict, { kind: "ok" }>,
): ToolResult {
	nestedExecutions.set(result, { decision: verdict.decision, execution: recordedExecution(verdict) });
	return result;
}

const NESTED_BLOCKED_DETAIL = "nestedBlockedVerdict";

interface NestedBlockedMarker {
	reason: string;
	decision: SafetyDecision;
	deniedPark?: true;
	redundantRepeat?: true;
	denial?: ToolDenial;
}

/**
 * The result a tool body returns when a nested `invoke` it made on the model's
 * behalf came back blocked. The gateway uses it so a capability the registry
 * refused (denied at read-only, not approved, guarded) refuses the gateway
 * call identically instead of dressing the refusal as a tool error.
 */
export function nestedBlockedResult(verdict: Extract<RegistryVerdict, { kind: "blocked" }>): ToolResult {
	const marker: NestedBlockedMarker = {
		reason: verdict.reason,
		decision: verdict.decision,
		...(verdict.deniedPark === true ? { deniedPark: true } : {}),
		...(verdict.redundantRepeat === true ? { redundantRepeat: true } : {}),
		...(verdict.denial !== undefined ? { denial: verdict.denial } : {}),
	};
	nestedBlockedExecutions.set(marker, recordedExecution(verdict));
	return { kind: "error", message: verdict.reason, details: { [NESTED_BLOCKED_DETAIL]: marker } };
}

export function nestedBlockedVerdict(result: ToolResult): Extract<RegistryVerdict, { kind: "blocked" }> | null {
	if (result.kind !== "error") return null;
	const marker = result.details?.[NESTED_BLOCKED_DETAIL];
	if (typeof marker !== "object" || marker === null) return null;
	const { reason, decision, deniedPark, redundantRepeat, denial } = marker as Partial<NestedBlockedMarker>;
	if (
		typeof reason !== "string" ||
		typeof decision !== "object" ||
		decision === null ||
		typeof decision.kind !== "string" ||
		typeof decision.classification !== "object"
	) {
		return null;
	}
	return {
		kind: "blocked",
		reason,
		decision,
		...(deniedPark === true ? { deniedPark: true } : {}),
		...(redundantRepeat === true ? { redundantRepeat: true } : {}),
		...(denial !== undefined ? { denial } : {}),
		...nestedBlockedExecutions.get(marker),
	};
}
