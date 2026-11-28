// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { canonicalJson } from "../core/canonical-json.js";
import { isMcpToolName } from "../core/tool-names.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import type { ApprovalAuthority } from "../domains/safety/admission.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import type { GrantExecutionEvent, ToolRegistry } from "../tools/registry/contract.js";
import type { PancodeWorkerEvent } from "./worker-events.js";
import { formatWorkerRefusal, type WorkerRefusal, workerRefusalLimitReason } from "./worker-refusals.js";
import type { WorkerEventEmit } from "./worker-run-types.js";

/** Room left for the frame envelope under the 16 KiB control-lane bound, counted in the UTF-8 bytes the host limit counts. */
export const GRANT_REQUEST_FRAME_BUDGET_BYTES = 14 * 1024;

/** Exact call and enforced permission conditions; never reuse an answer across asking axes. */
/** Bound on the description a grant frame carries; the judge reads fewer characters still. */
const GRANT_MCP_DESCRIPTION_CHARS = 1000;

/** An MCP tool's trust class and registered description for a worker's grant request, else undefined. */
export function workerMcpToolFeatures(
	tool: string,
	spec: { baseActionClass: string; description: string } | undefined,
): { actionClass: string; description: string } | undefined {
	if (!isMcpToolName(tool) || spec === undefined) return undefined;
	const description = spec.description.trim().slice(0, GRANT_MCP_DESCRIPTION_CHARS);
	return description.length === 0 ? undefined : { actionClass: spec.baseActionClass, description };
}

export function workerPermissionCacheKey(call: ClassifierCall, decision: SafetyDecision, axis: string): string {
	return canonicalJson({
		tool: call.tool,
		args: call.args ?? {},
		axis,
		actionClass: decision.classification.actionClass,
		policyReason: decision.policy?.reasonCode,
		policySource: decision.policy?.policySource,
		policyHash: decision.policy?.policyHash,
	});
}

// Exact, byte-stable denial reasons for the deny/fail postures. Escalate
// timeouts and operator denials use their own wording below.
// A refused command leads the sentence so it survives the model-facing
// 300-character line cap (rejection-feedback.ts).
export const denyReason = (
	unattendedEscalation: boolean,
	mainRoutedPermit: boolean,
	tool: string,
	actionClass: string,
	refused?: WorkerRefusal,
): string => {
	const head =
		refused === undefined
			? "permission denied by policy: "
			: `permission denied by policy: ${formatWorkerRefusal(refused)}; `;
	return unattendedEscalation
		? mainRoutedPermit
			? `${head}no operator or granting main agent can answer worker asks for this dispatch (fleet.permissions.mode=main, fallback=deny); ${tool} requires ${actionClass} confirmation`
			: `${head}no operator can answer worker escalations for this dispatch (fleet.permissions.mode=escalate, fallback=deny); ${tool} requires ${actionClass} confirmation`
		: `${head}dispatched workers run non-interactively (fleet.permissions.mode=deny); ${tool} requires ${actionClass} confirmation`;
};

export const failReason = (unattendedEscalation: boolean, tool: string, actionClass: string): string =>
	unattendedEscalation
		? `permission required for ${tool} (${actionClass}); no operator can answer worker escalations for this dispatch and fallback=fail ends this run`
		: `permission required for ${tool} (${actionClass}); fleet.permissions.mode=fail ends this run`;

export interface ActiveEscalation {
	requestId: string;
	tool: string;
	actionClass: ActionClass;
	/** Identity of the exact call and permission conditions for the denial memory. */
	callKey: string;
	/** Who may discharge this ask. Always `operator` outside a main-routed permit. */
	authority: ApprovalAuthority;
	/** Digest a bound decision must name. */
	argDigest: string;
	/**
	 * The refusal a host denial of this main-authority execute ask counts
	 * toward WORKER_REFUSAL_LIMIT, as a deny-posture refusal would: a
	 * granting host that keeps refusing is no route either.
	 */
	refusal?: WorkerRefusal;
	timer: ReturnType<typeof setTimeout>;
	/** Monotonic time the ask was opened, which bounds every hold. */
	openedAt: number;
	/** Monotonic time the timer fires. */
	timerAt: number;
}

/**
 * Count a host-refused main-authority execute ask. At the limit the run
 * ends as permission_required naming every refused command; returns that
 * final reason, or null while the worker may take another route.
 */
export const countHostRefusal = (
	executeRefusals: WorkerRefusal[],
	refusalLimit: number,
	refusal: WorkerRefusal | undefined,
): string | null => {
	if (refusal === undefined) return null;
	executeRefusals.push(refusal);
	return executeRefusals.length >= refusalLimit ? workerRefusalLimitReason(executeRefusals) : null;
};

export const emitGrantExecution = (
	emit: WorkerEventEmit,
	active: ActiveEscalation,
	event: GrantExecutionEvent,
): void => {
	emit({
		type: "pancode_permission_grant_execution",
		payload: {
			requestId: active.requestId,
			tool: active.tool,
			phase: event.phase,
			...(event.phase === "end" ? { outcome: event.outcome } : {}),
			...(event.phase === "not_executed" ? { detail: event.reason } : {}),
		},
	} as PancodeWorkerEvent);
};

/** A decision that does not name this attempt's parked call denies it without consuming anything. */
export const denyUnboundDecision = (
	clearActiveEscalation: () => void,
	emit: WorkerEventEmit,
	registry: ToolRegistry,
	active: ActiveEscalation,
	mismatch: string,
): void => {
	clearActiveEscalation();
	const reason = `permission denied: ${mismatch}, so the parked ${active.tool} call was not executed`;
	emit({
		type: "pancode_permission_resolved",
		payload: {
			tool: active.tool,
			actionClass: active.actionClass,
			mode: "deny",
			source: "binding",
			requestId: active.requestId,
			decision: "denied",
			reason,
			authority: active.authority,
		},
	} as PancodeWorkerEvent);
	registry.cancelParkedCall(active.requestId, reason);
};
