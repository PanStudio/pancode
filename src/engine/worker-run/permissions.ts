// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * A native worker run's permission handling: the non-stall policy for a tool call that needs
 * permission, the escalation to the operator or to the main agent's grant broker, and the
 * decisions, holds and timeouts that settle a parked call.
 */

import { homedir } from "node:os";
import { type ToolName, ToolNames } from "../../core/tool-names.js";
import type { ApprovalAuthority } from "../../domains/safety/admission.js";
import { describeBashCallConsequences } from "../../domains/safety/command-consequence.js";
import { confirmationRuleOf } from "../../domains/safety/decision-events.js";
import { grantEffectDescriptor, grantEffectDigest } from "../../domains/safety/grant-effect.js";
import { describeCallTarget, WORKER_CALL_TARGET_MAX_CHARS } from "../../lib/call-target/call-target.js";
import type { WorkerGrantRequestFrame } from "../../lib/worker-wire/protocol.js";
import {
	DEFAULT_ESCALATION_FALLBACK,
	DEFAULT_ESCALATION_TIMEOUT_MS,
	WORKER_REFUSAL_LIMIT,
	type WorkerEscalationConfig,
} from "../../lib/worker-wire/spec-contract.js";
import { isTaskGateCall } from "../../tools/verify/task-gates.js";
import type { WorkerDecisionBinding } from "../../worker/stdin-demux.js";
import {
	countHostRefusal,
	denyReason,
	denyUnboundDecision,
	emitGrantExecution,
	failReason,
	GRANT_REQUEST_FRAME_BUDGET_BYTES,
	workerMcpToolFeatures,
	workerPermissionCacheKey,
} from "../worker-escalation.js";
import type { PancodeWorkerEvent } from "../worker-events.js";
import {
	countsTowardRefusalLimit,
	describeWorkerRefusal,
	outsideWorkspaceHint,
	type WorkerRefusal,
	workerRefusalLimitReason,
	workerRefusalReportDirective,
} from "../worker-refusals.js";
import { INTERNAL_HELPER_RESULT_TOOL } from "../worker-tools.js";
import type { WorkerRunScope } from "./scope.js";

export function createWorkerPermissions(scope: WorkerRunScope) {
	const { input, emit, phase, registry, agent, safety, contractCwd, helperForcedChoiceAvailable } = scope;
	const refusalLimit = input.limits?.refusals ?? WORKER_REFUSAL_LIMIT;
	// Non-stall guarantee (Symphony §10.5): a dispatched worker has no
	// operator by default, so a permission-requiring tool call must never park
	// forever. "deny" resolves the parked call as a structured denial and the
	// run continues; "fail" denies it and aborts the run, which then exits with
	// the dedicated permission-required code so the orchestrator can resolve
	// the outcome as failed/permission_required without racing the event
	// stream; "escalate" parks the call, hands the decision up to the operator
	// or, under a main-authority permit, to the main agent's grant broker over
	// the event/stdin channels, and applies the configured deny/fail fallback
	// on timeout so the run still cannot hang forever.
	// An escalation nobody can answer only waits out its timeout and then
	// applies the fallback. When the dispatching process says it has no
	// responder, the worker applies that fallback at once (F9).
	const unattendedEscalation = input.onPermission === "escalate" && input.escalation?.responder === "none";
	const onPermission = unattendedEscalation
		? (input.escalation?.fallback ?? DEFAULT_ESCALATION_FALLBACK)
		: (input.onPermission ?? "deny");
	const escalationConfig: WorkerEscalationConfig | null =
		onPermission === "escalate"
			? {
					timeoutMs: input.escalation?.timeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS,
					fallback: input.escalation?.fallback ?? DEFAULT_ESCALATION_FALLBACK,
					...(input.escalation?.backstopMs !== undefined ? { backstopMs: input.escalation.backstopMs } : {}),
				}
			: null;
	// Present only when the permit routes asks to the main agent with main
	// authority (Phase D): every decision must then name this attempt, the
	// parked request and its argument digest.
	const grantBinding = escalationConfig !== null ? input.escalation?.grant : undefined;
	const operatorUnattended = input.escalation?.operatorResponder === "none";
	const mainRoutedPermit = input.permitAllowance?.asks === "main" && input.permitAllowance.approvalAuthority === "main";
	const executeRefusals: WorkerRefusal[] = [];

	// Denied escalations, keyed by the exact call and permission conditions. A
	// worker that re-issues the identical call after it was denied gets the
	// same answer without a new card: a live coder re-asked one bash approval
	// eight times after its edits were done (#79). Approvals are never
	// remembered: each new call, identical or not, needs its own decision, so
	// one grant executes at most one call (F8).
	const deniedEscalations = new Map<string, { requestId: string; source: "operator" | "timeout" | "main" }>();
	// Requests a delivered approval already consumed. If admission still parks
	// such a call, the call is denied rather than escalated a second time.
	const consumedRequestIds = new Set<string>();
	const clearActiveEscalation = (): void => {
		if (scope.activeEscalation) {
			clearTimeout(scope.activeEscalation.timer);
			scope.activeEscalation = null;
		}
	};
	/**
	 * The run still exits permission_required, but finished work keeps its report: the next model round may only
	 * reply (beforeToolCall refuses every tool), and finishTurn ends the run after it. A helper-result worker reports
	 * only through its result tool, so that round is its terminal handoff, with the tool exposed and named (x2-3).
	 */
	const endAtRefusalLimit = (reason: string): void => {
		scope.permissionFailure = true;
		phase.endAfterRound(scope.workerModelRound + 1);
		if (helperForcedChoiceAvailable) phase.forceResult("refusals");
		const directive = workerRefusalReportDirective(helperForcedChoiceAvailable ? INTERNAL_HELPER_RESULT_TOOL : null);
		registry.cancelParkedCalls(`${reason}\n${directive}`);
		process.stderr.write(`[worker] ${reason}\n`);
	};

	// One escalation is outstanding at a time. A call that parks while a prior
	// escalation awaits a decision is re-notified after the active one resolves
	// (registry.resumeParkedCalls re-fires onPermissionRequired for the next
	// parked call), so it never gets lost and the requestId->parked-call
	// mapping stays unambiguous.
	const resolveEscalation = (
		requestId: string,
		decision: "approve" | "deny",
		source: "operator" | "timeout" | "main",
		hostReason?: string,
	): boolean => {
		const active = scope.activeEscalation;
		if (!active || active.requestId !== requestId) return false;
		clearActiveEscalation();
		const authority = grantBinding !== undefined ? { authority: active.authority } : {};
		if (decision === "approve") {
			consumedRequestIds.add(requestId);
			const issuer: ApprovalAuthority = source === "main" ? "main" : "operator";
			emit({
				type: "pancode_permission_resolved",
				payload: {
					tool: active.tool,
					actionClass: active.actionClass,
					mode: "escalate",
					source,
					requestId,
					decision: "approved",
					reason:
						issuer === "main"
							? `main agent granted ${active.tool} (${active.actionClass}) once`
							: `operator approved permission escalation for ${active.tool} (${active.actionClass})`,
					...authority,
				},
			} as PancodeWorkerEvent);
			void registry.resumeParkedCalls({
				actionClass: active.actionClass,
				requestId,
				requestedBy: issuer === "main" ? "grant:main" : `escalation:${source}`,
				issuer,
				onExecution: (event) => emitGrantExecution(emit, active, event),
			});
			return true;
		}
		deniedEscalations.set(active.callKey, { requestId, source });
		// A denial resolves to the effective posture: a timeout with fallback
		// "fail" ends the run like posture fail; every other denial mirrors
		// posture deny, so the structured tool denial the model sees (including
		// the "permission denied" reason) is identical to the deny posture.
		const effectiveFail = source === "timeout" && escalationConfig?.fallback === "fail";
		const mode: "deny" | "fail" = effectiveFail ? "fail" : "deny";
		const decider = source === "main" ? "main agent" : "operator";
		const denialContext = source === "timeout" ? "nobody answered in time" : `${decider} denied`;
		const deniedReason = effectiveFail
			? `permission required for ${active.tool} (${active.actionClass}); ${denialContext}, and the fleet's fail fallback ends this run`
			: hostReason !== undefined
				? `permission denied: ${hostReason}; ${active.tool} requires ${active.actionClass} confirmation`
				: `permission denied by ${source === "timeout" ? "escalation timeout fallback" : decider}: ${active.tool} requires ${active.actionClass} confirmation`;
		const limitReason =
			source === "main" && !effectiveFail ? countHostRefusal(executeRefusals, refusalLimit, active.refusal) : null;
		const reason = limitReason ?? deniedReason;
		emit({
			type: "pancode_permission_resolved",
			payload: {
				tool: active.tool,
				actionClass: active.actionClass,
				mode,
				source,
				requestId,
				decision: "denied",
				reason,
				...authority,
			},
		} as PancodeWorkerEvent);
		if (effectiveFail) {
			scope.permissionFailure = true;
			registry.cancelParkedCalls(reason);
			agent.abort();
			return true;
		}
		if (limitReason !== null) {
			endAtRefusalLimit(limitReason);
			return true;
		}
		if (source === "timeout") registry.cancelParkedCalls(reason);
		else registry.cancelParkedCall(requestId, reason);
		return true;
	};

	const resolveDecision = (
		requestId: string,
		decision: "approve" | "deny",
		binding: WorkerDecisionBinding | undefined,
		cause: "timeout" | undefined,
	): boolean => {
		const active = scope.activeEscalation;
		if (!active || active.requestId !== requestId) return false;
		// The parent's window ran out: the same denial this worker's own timer gives,
		// so fallback fail still ends the run.
		if (cause === "timeout" && decision === "deny") return resolveEscalation(requestId, "deny", "timeout");
		if (grantBinding === undefined) return resolveEscalation(requestId, decision, "operator");
		const mismatch =
			binding === undefined
				? "the decision carries no grant binding"
				: binding.attemptToken !== grantBinding.attemptToken || binding.attempt !== grantBinding.attempt
					? "the decision names another attempt"
					: binding.argDigest !== active.argDigest
						? "the decision names different arguments than the parked call"
						: decision === "approve" && binding.issuer === "main" && active.authority !== "main"
							? "the main agent cannot grant an operator-authority ask"
							: null;
		if (mismatch !== null || binding === undefined) {
			denyUnboundDecision(
				clearActiveEscalation,
				emit,
				registry,
				active,
				mismatch ?? "the decision carries no grant binding",
			);
			return true;
		}
		return resolveEscalation(requestId, decision, binding.issuer === "main" ? "main" : "operator", binding.reason);
	};

	const denyActiveEscalationOnAbort = (reason: string): void => {
		const active = scope.activeEscalation;
		if (!active) return;
		emit({
			type: "pancode_permission_resolved",
			payload: {
				tool: active.tool,
				actionClass: active.actionClass,
				mode: "escalate",
				source: "operator",
				requestId: active.requestId,
				decision: "denied",
				reason,
				...(grantBinding !== undefined ? { authority: active.authority } : {}),
			},
		} as PancodeWorkerEvent);
		clearActiveEscalation();
	};

	const unsubscribePermission = registry.onPermissionRequired((call, decision, meta) => {
		const actionClass = decision.classification.actionClass;
		const recordPermissionDecision = (disposition: "denied" | "permission_requested", rule?: string): void => {
			safety.decisions.recordToolCall?.({
				tool: call.tool,
				classification: decision.classification,
				decision: disposition,
				...(decision.policy !== undefined ? { policy: decision.policy } : {}),
				...(disposition === "permission_requested" ? { requestId: meta.requestId } : {}),
				...(rule !== undefined ? { ruleId: rule, reasonCode: rule, policySource: "fleet-permissions" } : {}),
				...confirmationRuleOf(decision),
			});
		};
		if (escalationConfig) {
			const callKey = workerPermissionCacheKey(call, decision, meta.axis);
			if (consumedRequestIds.has(meta.requestId)) {
				recordPermissionDecision("denied", "approval:consumed");
				// The approval was delivered and consumed; admission still refused the
				// call, so it is denied here instead of asking a second time.
				const reason = `permission denied: the approval for ${call.tool} did not admit the call under the worker's permit, and it was not executed`;
				emit({
					type: "pancode_permission_resolved",
					payload: {
						tool: call.tool,
						actionClass,
						mode: "deny",
						source: "binding",
						requestId: meta.requestId,
						decision: "denied",
						reason,
					},
				} as PancodeWorkerEvent);
				registry.cancelParkedCall(meta.requestId, reason);
				return;
			}
			const remembered = deniedEscalations.get(callKey);
			if (remembered !== undefined) {
				recordPermissionDecision("denied", "approval:remembered-denial");
				const decider =
					remembered.source === "timeout"
						? "escalation timeout fallback"
						: remembered.source === "main"
							? "main agent"
							: "operator";
				const limitReason =
					remembered.source === "main" && countsTowardRefusalLimit(decision)
						? countHostRefusal(executeRefusals, refusalLimit, describeWorkerRefusal(call, decision))
						: null;
				const reason =
					limitReason ??
					`permission denied by ${decider}: an identical ${call.tool} call under the same permission conditions was already denied earlier in this run (request ${remembered.requestId}); the answer stands, so do not repeat this call`;
				emit({
					type: "pancode_permission_resolved",
					payload: {
						tool: call.tool,
						actionClass,
						mode: "escalate",
						source: "remembered",
						requestId: meta.requestId,
						decision: "denied",
						reason,
					},
				} as PancodeWorkerEvent);
				if (limitReason !== null) endAtRefusalLimit(limitReason);
				else registry.cancelParkedCall(meta.requestId, reason);
				return;
			}
			if (scope.activeEscalation !== null) return;
			const requestId = meta.requestId;
			const authority: ApprovalAuthority = grantBinding === undefined ? "operator" : meta.approvalAuthority;
			if (isTaskGateCall(call.tool, call.args)) {
				recordPermissionDecision("denied", "approval:task-gate");
				// A decider would see a check id, not the argv the task wrote.
				const reason = `permission denied by policy: ${call.tool} task gate needs ${actionClass} confirmation and a task gate never asks; report it unverified with this reason`;
				emit({
					type: "pancode_permission_resolved",
					payload: { tool: call.tool, actionClass, mode: "deny", source: "policy", requestId, reason, authority },
				} as PancodeWorkerEvent);
				registry.cancelParkedCall(requestId, reason);
				return;
			}
			if (grantBinding !== undefined && authority === "operator" && operatorUnattended) {
				recordPermissionDecision("denied", "approval:operator-unavailable");
				// Only a person clears an operator rail, and nobody can answer here.
				const reason = `permission denied by policy: ${call.tool} raised an operator-authority ask and no operator can answer worker asks for this dispatch; ${call.tool} requires ${actionClass} confirmation${outsideWorkspaceHint(call.args, contractCwd)}`;
				emit({
					type: "pancode_permission_resolved",
					payload: { tool: call.tool, actionClass, mode: "deny", source: "policy", requestId, reason, authority },
				} as PancodeWorkerEvent);
				registry.cancelParkedCall(requestId, reason);
				return;
			}
			const effect = grantEffectDescriptor(call.tool, call.args);
			const argDigest = grantEffectDigest(effect);
			// The timer must hold the event loop: its firing is what denies an
			// escalation the orchestrator never resolves. clearActiveEscalation
			// clears it on every resolution path. A parent that owns the window
			// answers first, so under one this is only the backstop.
			const openedAt = performance.now();
			const timerMs = escalationConfig.backstopMs ?? escalationConfig.timeoutMs;
			const timer = setTimeout(() => resolveEscalation(requestId, "deny", "timeout"), timerMs);
			scope.activeEscalation = {
				requestId,
				tool: call.tool,
				actionClass,
				callKey,
				authority,
				argDigest,
				...(grantBinding !== undefined && authority === "main" && countsTowardRefusalLimit(decision)
					? { refusal: describeWorkerRefusal(call, decision) }
					: {}),
				timer,
				openedAt,
				timerAt: openedAt + timerMs,
			};
			// The decider sees this exact call through a sanitized allowlisted
			// preview of its object. Unlisted fields cross only as type-and-size
			// summaries on this display event; the effect descriptor a grant is
			// evaluated against rides the control lane below.
			// A verify check's policy names the argv the tool would run, as the main card's resolution does (R2-F20).
			const resolved =
				call.tool === ToolNames.Verify && decision.policy?.command !== undefined
					? { command: decision.policy.command }
					: undefined;
			const target = describeCallTarget(call.tool, call.args, resolved, WORKER_CALL_TARGET_MAX_CHARS);
			// Composed here because only the worker holds the whole command: `target`
			// is one flattened, cut line. Display text only, never read by a decision.
			const consequence = describeBashCallConsequences(call.tool, call.args, { home: homedir });
			const summary = `${call.tool} requires ${actionClass} confirmation`;
			emit({
				type: "pancode_permission_escalated",
				payload: {
					requestId,
					tool: call.tool,
					summary,
					...(target.length > 0 ? { target } : {}),
					...(consequence.length > 0 ? { consequence } : {}),
					axis: meta.axis,
					decision: {
						actionClass,
						reasons: decision.classification.reasons,
						...(decision.policy?.reasonCode ? { reasonCode: decision.policy.reasonCode } : {}),
						...(decision.policy?.ruleId ? { ruleId: decision.policy.ruleId } : {}),
						...(decision.policy?.policySource ? { policySource: decision.policy.policySource } : {}),
					},
					timeoutMs: escalationConfig.timeoutMs,
					...(grantBinding !== undefined ? { authority, argDigest } : {}),
				},
			} as PancodeWorkerEvent);
			if (grantBinding !== undefined) {
				const frame: WorkerGrantRequestFrame = {
					requestId,
					attemptToken: grantBinding.attemptToken,
					attempt: grantBinding.attempt,
					tool: call.tool,
					actionClass,
					authority,
					argDigest,
					effect,
					summary,
					...(target.length > 0 ? { target } : {}),
					reasons: decision.classification.reasons.slice(0, 8),
					axis: meta.axis,
					timeoutMs: escalationConfig.timeoutMs,
					...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
				};
				// A descriptor too large for the control frame crosses as its digest
				// alone; the host then refuses a main grant and only the operator decides.
				const fits = Buffer.byteLength(JSON.stringify(frame), "utf8") <= GRANT_REQUEST_FRAME_BUDGET_BYTES;
				// The display sentences ride along only when they leave the frame inside
				// the budget, so card text can never be what drops a grant's effect.
				const within = (candidate: WorkerGrantRequestFrame): boolean =>
					Buffer.byteLength(JSON.stringify(candidate), "utf8") <= GRANT_REQUEST_FRAME_BUDGET_BYTES;
				// An MCP tool's class and description are what the main session's judge
				// reads the call by; they ride before the card text, under the same rule.
				const mcpTool = workerMcpToolFeatures(call.tool, registry.get(call.tool as ToolName));
				const withMcpTool = mcpTool !== undefined && within({ ...frame, mcpTool }) ? { ...frame, mcpTool } : frame;
				const withConsequence = consequence.length > 0 ? { ...withMcpTool, consequence } : withMcpTool;
				input.emitGrantRequest?.(
					fits ? (within(withConsequence) ? withConsequence : withMcpTool) : { ...frame, effect: null },
				);
			}
			recordPermissionDecision("permission_requested");
			return;
		}
		// The policy's own reasons name the remedy ("one command per bash call",
		// "only through the typed git tool"). Without them a worker saw only
		// "bash requires execute confirmation" and retried respelled variants.
		const policyDetail = [
			...new Set(
				[
					...(decision.policy?.reasons ?? []),
					...(decision.kind === "allow" ? [] : decision.rejection.detail.split("\n").slice(1)),
					...decision.classification.reasons,
				]
					.map((entry) => entry.replace(/^-\s+/u, "").trim())
					.filter((entry) => entry.length > 0 && !entry.startsWith("rule:")),
			),
		]
			.slice(0, 3)
			.join(" ");
		// A refused command reaches the model as a tool result and the turn goes
		// on, so it can take another route (P1 mode B ended at its first refused
		// verify). Changing the command still cannot create an absent execute
		// approval route, so the third refusal ends the work: one last reply may
		// report, then the run exits permission_required.
		const refusal =
			onPermission !== "fail" && countsTowardRefusalLimit(decision) ? describeWorkerRefusal(call, decision) : null;
		if (refusal !== null) executeRefusals.push(refusal);
		// The refusal names the command and its rule: "outside the no-prompt set"
		// alone left the model and the receipt guessing which call was refused.
		const deniedHead = denyReason(unattendedEscalation, mainRoutedPermit, call.tool, actionClass, refusal ?? undefined);
		const deniedReason =
			onPermission === "fail"
				? failReason(unattendedEscalation, call.tool, actionClass)
				: policyDetail.length > 0
					? `${deniedHead}. ${policyDetail}`
					: deniedHead;
		const refusalLimitReached = executeRefusals.length >= refusalLimit;
		const reason = refusalLimitReached ? workerRefusalLimitReason(executeRefusals) : deniedReason;
		recordPermissionDecision("denied", `fleet.permissions.mode:${onPermission}`);
		emit({
			type: "pancode_permission_resolved",
			payload: {
				tool: call.tool,
				actionClass,
				mode: onPermission,
				source: "policy",
				requestId: meta.requestId,
				reason,
			},
		} as PancodeWorkerEvent);
		if (onPermission === "fail") {
			scope.permissionFailure = true;
			registry.cancelParkedCalls(reason);
			process.stderr.write(`[worker] ${reason}\n`);
			agent.abort();
			return;
		}
		if (refusalLimitReached) endAtRefusalLimit(reason);
		else registry.cancelParkedCalls(reason);
	});
	return {
		escalationConfig,
		clearActiveEscalation,
		resolveEscalation,
		resolveDecision,
		denyActiveEscalationOnAbort,
		unsubscribePermission,
	};
}
