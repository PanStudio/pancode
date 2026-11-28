// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Payload→notice formatters for bus channels the interactive layer renders
 * as operator notices. Validation lives here so malformed payloads are
 * dropped in one place and the index.ts subscribers stay wiring-only.
 * Returning null means "ignore the event".
 */

import type { PermissionRequestedPayload, SafetyBlockedPayload } from "../core/telemetry/live-events.js";
import { actionClassWords, safetyNetRailText } from "../core/views/approval-words.js";
import { askAxis } from "../domains/safety/approval-axis.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { describeBudgetBlock, readBudgetBlock } from "../domains/scheduling/budget.js";
import type { NoticeSource } from "../session-control/notice-source.js";

export interface BusNotice {
	level: "warn" | "error";
	text: string;
	/**
	 * The advisory source of a multi-sentence notice, chosen by the formatter that
	 * wrote it. A one-line notice has none and keeps its gutter row.
	 */
	source?: NoticeSource;
}

export function budgetAlertNotice(payload: unknown): BusNotice | null {
	const block = readBudgetBlock(payload);
	if (block === null) return null;
	// One formatter for the live alert, the replayed ledger entry and the ACP frame (#424).
	return { ...describeBudgetBlock(block), source: "budget" };
}

function isSafetyBlockedPayload(value: unknown): value is SafetyBlockedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (typeof p.tool !== "string" || p.tool.length === 0) return false;
	if (typeof p.actionClass !== "string" || p.actionClass.length === 0) return false;
	if (p.ruleId !== undefined && typeof p.ruleId !== "string") return false;
	if (typeof p.policySource !== "string" || p.policySource.length === 0) return false;
	if (typeof p.reasonCode !== "string" || p.reasonCode.length === 0) return false;
	return true;
}

function isWorkerEscalationPayload(value: unknown): value is PermissionRequestedPayload {
	if (!value || typeof value !== "object") return false;
	const p = value as Record<string, unknown>;
	if (typeof p.requestId !== "string" || p.requestId.length === 0) return false;
	if (typeof p.tool !== "string" || p.tool.length === 0) return false;
	if (typeof p.actionClass !== "string" || p.actionClass.length === 0) return false;
	if (p.origin !== undefined) {
		if (typeof p.origin !== "string" || !p.origin.startsWith("worker:")) return false;
	} else if (typeof p.requestedBy !== "string" || p.requestedBy.length === 0) {
		return false;
	}
	if (p.agentId !== undefined && typeof p.agentId !== "string") return false;
	if (p.axis !== undefined && typeof p.axis !== "string") return false;
	if (p.ruleId !== undefined && typeof p.ruleId !== "string") return false;
	if (p.reasonCode !== undefined && typeof p.reasonCode !== "string") return false;
	return true;
}

function workerRunId(payload: PermissionRequestedPayload): string {
	if (payload.origin?.startsWith("worker:")) return payload.origin.slice("worker:".length);
	return payload.requestedBy ?? "worker";
}

function workerEscalationAxis(
	payload: PermissionRequestedPayload,
): { kind: "net"; ruleId: string } | { kind: "autonomy"; level: string } | null {
	if (payload.axis?.startsWith("net:")) {
		const ruleId = payload.axis.slice("net:".length);
		return ruleId.length > 0 ? { kind: "net", ruleId } : null;
	}
	if (payload.axis?.startsWith("autonomy:")) {
		const level = payload.axis.slice("autonomy:".length);
		return level.length > 0 ? { kind: "autonomy", level } : null;
	}
	if (payload.ruleId !== undefined && payload.ruleId.length > 0) {
		return { kind: "net", ruleId: payload.ruleId };
	}
	return null;
}

export { middlewareHookFailedSessionNotice } from "../session-control/session-notices.js";
export { WATCHDOG_NOTICE_CHECK_LIMIT, watchdogBlockersNotice } from "../session-control/watchdog-notice.js";

/**
 * A tool call parked for one-shot approval (sd-01 §3.3). The text names the
 * axis that produced the ask: a safety-net rail asks at every level, the System
 * One gate asks only about an unrecognized command yolo would have run, and an
 * autonomy ask exists only because of the current level and can be widened in
 * .pancode/safety.yaml when it is an execute action.
 */
export function approvalParkedNotice(tool: string, decision: SafetyDecision, autonomy: string): BusNotice {
	const actionClass = decision.classification.actionClass;
	const axis = askAxis(decision);
	if (axis.kind === "net") {
		const asker = safetyNetRailText(axis.ruleId);
		return {
			level: "warn",
			text: `${tool} waits on you because it ${actionClassWords(actionClass)}: ${asker} asks for confirmation. Approve once, or Esc denies this call.`,
			source: "approval",
		};
	}
	const widen =
		actionClass === "execute"
			? " Approve once, or add it to .pancode/safety.yaml commands."
			: " Approve once, or Esc denies this call.";
	return {
		level: "warn",
		text: `${tool} waits on you because it ${actionClassWords(actionClass)}: autonomy ${autonomy} asks.${widen}`,
		source: "approval",
	};
}

export function workerEscalationNotice(payload: unknown): BusNotice | null {
	if (!isWorkerEscalationPayload(payload)) return null;
	const axis = workerEscalationAxis(payload);
	if (axis === null) return null;
	const agentId = payload.agentId ?? "worker";
	const runId = workerRunId(payload);
	if (axis.kind === "net") {
		return {
			level: "warn",
			text: `Worker ${agentId} asks to run ${payload.tool}, which ${actionClassWords(payload.actionClass)}: ${safetyNetRailText(axis.ruleId)} asks for confirmation. Approve once, or Esc denies this call. /view dispatch:${runId}`,
			source: "fleet",
		};
	}
	return {
		level: "warn",
		text: `Worker ${agentId} asks to run ${payload.tool}, which ${actionClassWords(payload.actionClass)}: autonomy ${axis.level} asks. Approve once, or Esc denies this call. /view dispatch:${runId}`,
		source: "fleet",
	};
}

/**
 * The blocked call's transcript row states the refusal and its body the
 * rejection the model received, the rule included, so this notice passes
 * through the footer's notice slot with the policy dimension: which rule
 * fired and from which policy source. The closing sentence states that these
 * gates are level-independent, so the notice never reads as a contradiction of
 * the autonomy level shown in the dashboards (sd-01).
 */
export function safetyBlockedNotice(payload: unknown): BusNotice | null {
	if (!isSafetyBlockedPayload(payload)) return null;
	return {
		level: "warn",
		text: `PanCode's safety net blocked ${payload.tool} because it ${actionClassWords(payload.actionClass)}. This gate applies at every autonomy level, and /view names the rule.`,
		source: "safety",
	};
}
