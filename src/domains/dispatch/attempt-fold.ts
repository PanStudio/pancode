// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { outputLimitCutOffToolCallIds } from "../../core/assistant-output.js";
import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { isSkillActivation } from "../../core/skill-activation.js";
import { emitApproval } from "../../core/telemetry/approvals.js";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../core/tool-surface.js";
import { isRecord } from "../../core/type-guards.js";
import { durableAssistantTextFromEvent } from "../../core/worker-output.js";
import { INTERNAL_HELPER_RESULT_TOOL } from "../../engine/worker-tools.js";
import { WORKER_REFUSAL_LIMIT_PREFIX } from "../../lib/worker-wire/spec-contract.js";
import { isFlowRestrictionSet, mergeFlowRestrictions } from "../safety/information-flow.js";
import type { SpawnedAttempt } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { TOOL_GUARD_REASON_CODE } from "./failure-headline.js";
import { compactDiagnosticText, MAX_WORKER_OUTCOME_DETAIL_BYTES } from "./run-outcome-detail.js";
import {
	recordCallFinish,
	recordCallStart,
	recordToolCompletion,
	recordToolFinish,
	recordToolStart,
	resultNotExecuted,
} from "./tool-stats.js";
import { isRunOutcomeCode } from "./types.js";
import {
	appendDispatchFinishContractEntry,
	foldAssistantCall,
	foldModelCallEvent,
	foldToolDecision,
	readStringArrayOrNull,
	readStringOrNull,
	recordWorkerRunEffect,
	recordWorkerVerifyCall,
} from "./worker-event-fold.js";

export function createAttemptFold(rt: DispatchRuntime, attempt: SpawnedAttempt) {
	const { context } = rt;
	const {
		acceptsOutcomeCodeEvents,
		acknowledgeSteer,
		blockedAttempts,
		callUsage,
		escalationCounts,
		finishContractEntries,
		gatewayFinishes,
		grantAttempt,
		guardBlockedAttempts,
		holdPermission,
		inFlightCalls,
		inFlightTools,
		lifecycle,
		outputCapture,
		outputLimitCalls,
		pendingCapabilities,
		permissionRequestedAttempts,
		prefixLeader,
		reachedTool,
		req,
		resolvePermission,
		runEffects,
		safetyDecisionCounts,
		skillActivations,
		tokenMeter,
		toolStats,
		trustedOutcomeCodes,
		trustedOutcomeDetails,
		upstreamResponses,
		verifyCalls,
	} = attempt;

	const foldWorkerEvent = (raw: unknown): void => {
		if (raw !== null && typeof raw === "object" && "type" in raw && raw.type === "pancode_telemetry") {
			attempt.runJournal?.worker(raw);
			if (callUsage && !callUsage.observe(raw)) callUsage.gap();
			if (callUsage) {
				const usage = callUsage.snapshot();
				if (usage) {
					tokenMeter.usage = usage;
					rt.budget.stopRunsAtCostCeiling();
				}
			}
			return;
		}
		outputCapture.observe(raw);
		if (
			attempt.refusalLimit === "reached" &&
			(durableAssistantTextFromEvent(raw).trim().length > 0 || (isRecord(raw) && raw.type === "pancode_helper_result"))
		)
			attempt.refusalLimit = "reported";
		if (
			prefixLeader &&
			raw !== null &&
			typeof raw === "object" &&
			"type" in raw &&
			(raw.type === "message_update" ||
				(raw.type === "message_end" &&
					"message" in raw &&
					(raw.message as { role?: unknown } | null)?.role === "assistant"))
		)
			prefixLeader.release();
		const event = raw as {
			type?: string;
			message?: {
				role?: string;
				usage?: unknown;
				failure?: unknown;
				model?: unknown;
				responseModelIdObservation?: unknown;
				responseModel?: unknown;
				responseId?: unknown;
				stopReason?: unknown;
				errorMessage?: unknown;
				content?: unknown;
			};
			payload?: {
				callIndex?: number;
				model?: unknown;
				responseModel?: unknown;
				responseId?: unknown;
				usage?: unknown;
				tool?: string;
				toolCallId?: string;
				action?: unknown;
				sequence?: number;
				outcomeCode?: unknown;
				detail?: unknown;
				posture?: string;
				durationMs?: number;
				outcome?: "ok" | "error" | "blocked";
				decision?: unknown;
				actionClass?: string;
				ruleId?: string;
				reasonCode?: string;
				policySource?: string;
				reason?: string;
				skillActivation?: unknown;
				// Worker permission-escalation fields (pancode_permission_escalated /
				// pancode_permission_resolved escalate path).
				requestId?: string;
				summary?: string;
				target?: string;
				consequence?: unknown;
				axis?: string;
				timeoutMs?: number;
				source?: "operator" | "timeout" | "policy" | "remembered" | "main" | "binding";
				phase?: string;
			};
			toolName?: string;
			toolCallId?: string;
			args?: unknown;
			result?: unknown;
			isError?: boolean;
		};
		if (event.type === "pancode_tool_start" && event.payload && typeof event.payload.tool === "string") {
			recordToolStart(inFlightTools, event.payload);
			recordCallStart(inFlightCalls, event.payload);
			if (typeof event.payload.toolCallId === "string") reachedTool.add(event.payload.toolCallId);
			else attempt.startsCarryIds = false;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			for (const id of outputLimitCutOffToolCallIds(event.message)) outputLimitCalls.add(id);
		}
		if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
			pendingCapabilities.set(event.toolCallId, effectiveToolCall(event.toolName, event.args).toolName);
		}
		if (event.type === "pancode_steer_received") acknowledgeSteer(event.payload?.sequence);
		if (event.type === "pancode_repository_instructions") {
			// The harness lacked the switch that skips its files, so it read them; any runtime may only lower the claim.
			const context = lifecycle.projectContext;
			if (context?.peerInstructions?.delivery === "single-source") {
				lifecycle.projectContext = {
					...context,
					peerInstructions: { ...context.peerInstructions, delivery: "coexist", reason: "switch-unsupported" },
				};
			}
		}
		if (event.type === "pancode_flow_restrictions" && acceptsOutcomeCodeEvents) {
			const reported = (event.payload as { set?: unknown } | undefined)?.set;
			if (isFlowRestrictionSet(reported)) attempt.trustedFlow = mergeFlowRestrictions(attempt.trustedFlow, reported);
		}
		if (event.type === "pancode_repair_rounds_started" && lifecycle.runtimeKind === "http") {
			const started = (event.payload as { started?: unknown } | undefined)?.started;
			if (typeof started === "number" && Number.isSafeInteger(started) && started >= 0)
				attempt.reportedRepairRounds = Math.max(attempt.reportedRepairRounds ?? 0, started);
		}
		if (
			event.type === "pancode_run_outcome" &&
			isRunOutcomeCode(event.payload?.outcomeCode) &&
			event.payload.outcomeCode !== "result_contract_invalid" &&
			event.payload.outcomeCode !== "host_verification_rejected" &&
			event.payload.outcomeCode !== "merge_withheld"
		) {
			if (acceptsOutcomeCodeEvents) {
				trustedOutcomeCodes.add(event.payload.outcomeCode);
				const detail = event.payload.detail;
				if (typeof detail === "string" && detail.trim().length > 0 && !trustedOutcomeDetails.has(event.payload.outcomeCode))
					trustedOutcomeDetails.set(
						event.payload.outcomeCode,
						compactDiagnosticText(boundedExternalDiagnostic(detail, MAX_WORKER_OUTCOME_DETAIL_BYTES)),
					);
			} else if (!attempt.reportedUntrustedOutcome) {
				attempt.reportedUntrustedOutcome = true;
				reportDispatchDiagnostic(
					`run ${attempt.runIdForPermissionAudit ?? "pending"}`,
					new Error(`ignored untrusted outcome assertion from ${lifecycle.runtimeKind} runtime`),
				);
			}
		}
		if (isRecord(event)) {
			const finishEntry = appendDispatchFinishContractEntry(finishContractEntries, event);
			if (finishEntry !== null) {
				attempt.finishContractAssistantText = finishEntry.assistantText;
				attempt.finishContractAssistantTurnId = finishEntry.assistantTurnId;
			}
			recordWorkerRunEffect(runEffects, event, attempt.spec.helperResult === true);
			recordWorkerVerifyCall(verifyCalls, event);
			if (
				event.type === "tool_execution_end" &&
				lifecycle.runtimeKind === "http" &&
				attempt.startsCarryIds &&
				event.isError === true &&
				event.toolCallId &&
				!reachedTool.has(event.toolCallId) &&
				!outputLimitCalls.has(event.toolCallId) &&
				event.toolName !== INTERNAL_HELPER_RESULT_TOOL
			) {
				recordToolFinish(toolStats, {
					tool: pendingCapabilities.get(event.toolCallId) ?? String(event.toolName),
					outcome: "error",
				});
				pendingCapabilities.delete(event.toolCallId);
			}
			if (event.type === "tool_execution_end") {
				const children = gatewayChainReceipts(String(event.toolName), event.result);
				const wrapper = gatewayFinishes.get(event.toolCallId ?? "");
				gatewayFinishes.delete(event.toolCallId ?? "");
				if (wrapper !== undefined && children.length === 0) recordToolFinish(toolStats, wrapper);
				for (const child of children) {
					recordToolFinish(toolStats, {
						tool: child.capability,
						outcome: child.admission.outcome,
						notExecuted: resultNotExecuted(child.result),
					});
					const guardBlock = child.admission.decision === "blocked" && child.admission.reasonCode === TOOL_GUARD_REASON_CODE;
					const asked = child.admission.decision !== "allowed" && child.admission.decision !== "blocked";
					if (child.admission.decision === "allowed") safetyDecisionCounts.allowed += 1;
					else if (guardBlock) safetyDecisionCounts.guardBlocked += 1;
					else if (asked) safetyDecisionCounts.permissionRequested += 1;
					else safetyDecisionCounts.blocked += 1;
					if (child.admission.outcome === "blocked") {
						(guardBlock ? guardBlockedAttempts : asked ? permissionRequestedAttempts : blockedAttempts).push({
							tool: child.capability,
							actionClass: child.admission.actionClass,
							...(child.admission.ruleId ? { ruleId: child.admission.ruleId } : {}),
							...(child.admission.reasonCode ? { reasonCode: child.admission.reasonCode } : {}),
							...(child.admission.blockReason ? { reason: child.admission.blockReason } : {}),
						});
					}
				}
			}
		}
		if (
			event.type === "pancode_permission_grant_execution" &&
			grantAttempt !== undefined &&
			event.payload &&
			typeof event.payload.requestId === "string" &&
			attempt.runIdForPermissionAudit !== null
		) {
			const phase = event.payload.phase;
			if (phase === "start" || phase === "end" || phase === "not_executed") {
				const detail =
					phase === "end"
						? `the granted call ran (${typeof event.payload.outcome === "string" ? event.payload.outcome : "ok"})`
						: typeof event.payload.detail === "string"
							? event.payload.detail.slice(0, 500)
							: undefined;
				rt.grants.grantBroker.markExecution(attempt.runIdForPermissionAudit, event.payload.requestId, phase, detail);
			}
		}
		if (
			event.type === "pancode_permission_escalated" &&
			event.payload &&
			typeof event.payload.requestId === "string" &&
			grantAttempt !== undefined
		) {
			// A main-routed ask is presented by the grant broker from the control
			// lane; this display event only counts it.
			escalationCounts.requested += 1;
		} else if (
			event.type === "pancode_permission_escalated" &&
			event.payload &&
			typeof event.payload.requestId === "string"
		) {
			escalationCounts.requested += 1;
			// Opened before the card is told, so its first frame already reads this window.
			const windowMs = attempt.spec.escalation?.timeoutMs;
			if (attempt.spec.escalation?.backstopMs !== undefined && windowMs !== undefined && resolvePermission !== undefined) {
				const requestId = event.payload.requestId;
				rt.grants.workerApprovalWindows.open({
					runId: attempt.runIdForPermissionAudit,
					agentId: req.agentId,
					requestId,
					windowMs,
					fallback: attempt.spec.escalation.fallback,
					deny: () => resolvePermission(requestId, "deny", undefined, "timeout"),
					...(holdPermission !== undefined ? { extend: (holdMs: number) => holdPermission(requestId, holdMs) } : {}),
				});
			}
			const ctx = isRecord(event.payload.decision) ? event.payload.decision : null;
			const classification = ctx !== null && isRecord(ctx.classification) ? ctx.classification : null;
			const policy = ctx !== null && isRecord(ctx.policy) ? ctx.policy : null;
			const actionClass =
				readStringOrNull(classification?.actionClass) ??
				readStringOrNull(ctx?.actionClass) ??
				readStringOrNull(event.payload.actionClass) ??
				"unknown";
			const reasons = readStringArrayOrNull(ctx?.reasons) ?? readStringArrayOrNull(classification?.reasons);
			const consequence = readStringArrayOrNull(event.payload.consequence);
			const reasonCode = readStringOrNull(ctx?.reasonCode) ?? readStringOrNull(policy?.reasonCode);
			const ruleId = readStringOrNull(ctx?.ruleId) ?? readStringOrNull(policy?.ruleId);
			const policySource = readStringOrNull(ctx?.policySource) ?? readStringOrNull(policy?.policySource);
			const policyKind = readStringOrNull(policy?.kind);
			const axis =
				readStringOrNull(event.payload.axis) ??
				(ruleId !== null ? `net:${ruleId}` : policyKind === "ask" && reasonCode !== null ? `net:${reasonCode}` : null);
			emitApproval(context.bus, "approval.requested", {
				tool: typeof event.payload.tool === "string" ? event.payload.tool : "unknown",
				actionClass,
				...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
				requestedBy: attempt.runIdForPermissionAudit ?? undefined,
				requestId: event.payload.requestId,
				...(attempt.runIdForPermissionAudit !== null ? { origin: `worker:${attempt.runIdForPermissionAudit}` } : {}),
				...(axis !== null ? { axis } : {}),
				agentId: req.agentId,
				...(typeof event.payload.summary === "string" ? { summary: event.payload.summary } : {}),
				...(typeof event.payload.target === "string" && event.payload.target.length > 0
					? { target: event.payload.target }
					: {}),
				...(consequence !== null ? { consequence } : {}),
				...(reasons !== null ? { reasons } : {}),
				...(reasonCode !== null ? { reasonCode } : {}),
				...(ruleId !== null ? { ruleId } : {}),
				...(policySource !== null ? { policySource } : {}),
				...(typeof event.payload.timeoutMs === "number" ? { timeoutMs: event.payload.timeoutMs } : {}),
				fallback: attempt.spec.escalation?.fallback ?? "deny",
				escalation: true,
			});
		}
		foldModelCallEvent(event, upstreamResponses);
		if (event.type === "message_end" && event.message?.role === "assistant") {
			if (lifecycle.runtimeKind === "subprocess") {
				const u = isRecord(event.message.usage) ? event.message.usage : null;
				const evidence = u !== null && isRecord(u.pancodeExternal) ? u.pancodeExternal : null;
				const stopReason = event.message.stopReason;
				attempt.externalTelemetry = {
					tokenUsage:
						evidence?.tokenUsage === "provider-reported" || evidence?.tokenUsage === "missing"
							? evidence.tokenUsage
							: "unverified",
					cost:
						evidence?.cost === "provider-reported" || evidence?.cost === "peer-estimated" || evidence?.cost === "missing"
							? evidence.cost
							: "unverified",
					sessionId: readStringOrNull(evidence?.sessionId),
					exitReason: stopReason === "stop" || stopReason === "error" || stopReason === "aborted" ? stopReason : "unknown",
					toolTelemetry: "unavailable",
				};
			}
			const errorMessage = foldAssistantCall(event.message, tokenMeter, upstreamResponses, lifecycle.target.wireModelId);
			if (errorMessage !== null) {
				attempt.failureMessage = errorMessage;
				attempt.providerErrorMessage = errorMessage;
			}
		}
		if (event.type === "pancode_permission_resolved" && typeof event.payload?.requestId === "string") {
			rt.grants.workerApprovalWindows.settle(event.payload.requestId);
			rt.grants.adoptedAsks.delete(event.payload.requestId);
		}
		if (
			event.type === "pancode_permission_resolved" &&
			// An escalation that timed out under fallback fail ends the run for this reason too; without
			// it the receipt could say only `exit code 3`.
			(event.payload?.source === "policy" ||
				(event.payload?.source === "timeout" && (event.payload as { mode?: unknown }).mode === "fail")) &&
			typeof event.payload.reason === "string"
		) {
			attempt.permissionDenialDetail = event.payload.reason;
		}
		if (
			event.type === "pancode_permission_resolved" &&
			typeof event.payload?.reason === "string" &&
			event.payload.reason.startsWith(WORKER_REFUSAL_LIMIT_PREFIX)
		) {
			attempt.permissionDenialDetail = event.payload.reason;
			attempt.refusalLimit ??= "reached";
		}
		const brokered =
			event.type === "pancode_permission_resolved" &&
			grantAttempt !== undefined &&
			attempt.runIdForPermissionAudit !== null &&
			typeof event.payload?.requestId === "string"
				? rt.grants.grantBroker.findByWorker(attempt.runIdForPermissionAudit, event.payload.requestId)
				: null;
		if (brokered !== null && event.payload && attempt.runIdForPermissionAudit !== null) {
			// The broker owns the audit rows of a brokered request; the worker's
			// resolution only settles a record it has not settled itself.
			const source = event.payload.source;
			const approved = event.payload.decision === "approved";
			if (source === "timeout") escalationCounts.timedOut += 1;
			else if (source === "main" || source === "operator") {
				if (approved) escalationCounts.approved += 1;
				else {
					escalationCounts.denied += 1;
					// A judge or main-agent denial must not read as the person's on the receipt.
					attempt.escalationDeniedBy =
						source === "operator" ? "operator" : brokered.reviewer === "safety-judge" ? "safety judge" : "main agent";
				}
			}
			rt.grants.grantBroker.workerResolved(
				attempt.runIdForPermissionAudit,
				brokered.workerRequestId,
				approved ? "approved" : "denied",
				typeof event.payload.reason === "string" ? event.payload.reason.slice(0, 500) : "resolved by the worker",
			);
		} else if (event.type === "pancode_permission_resolved" && event.payload && typeof event.payload.tool === "string") {
			// Escalation resolutions already have a request event. Policy
			// deny/fail is non-stalling, so dispatch mints the adjacent pair.
			const source = event.payload.source;
			const granted = (source === "operator" || source === "main") && event.payload.decision === "approved";
			// An answer another PanCode process gave through the run's grant records names that process.
			const elsewhere =
				source === "operator" && typeof event.payload.requestId === "string"
					? rt.grants.answeredElsewhere.get(event.payload.requestId)
					: undefined;
			if (elsewhere !== undefined) rt.grants.answeredElsewhere.delete(event.payload.requestId as string);
			const decidedBy =
				elsewhere !== undefined
					? "operator:another-process"
					: source === "operator"
						? "operator"
						: source === "main"
							? "main"
							: source === "remembered"
								? "remembered-denial"
								: source === "timeout"
									? "timeout"
									: source === "binding"
										? "policy:grant-binding"
										: "policy:no-operator";
			const requestId =
				typeof event.payload.requestId === "string"
					? event.payload.requestId
					: source === "operator" || source === "timeout" || source === "remembered" || source === "main"
						? undefined
						: `worker-permission-${++attempt.workerPolicyPermissionCounter}`;
			const origin = attempt.runIdForPermissionAudit !== null ? `worker:${attempt.runIdForPermissionAudit}` : undefined;
			const actionClass = typeof event.payload.actionClass === "string" ? event.payload.actionClass : "unknown";
			const reason =
				elsewhere !== undefined
					? rt.grants.answeredElsewhereReason(granted ? "approve" : "deny", elsewhere)
					: typeof event.payload.reason === "string"
						? event.payload.reason
						: `${event.payload.tool} requires approval`;
			// A remembered answer never raised an escalation card, so it mints
			// the adjacent request/resolve pair the way policy denials do.
			if (
				(decidedBy === "policy:no-operator" || decidedBy === "policy:grant-binding" || source === "remembered") &&
				requestId &&
				origin
			) {
				emitApproval(context.bus, "approval.requested", {
					tool: event.payload.tool,
					actionClass,
					requestId,
					...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
					origin,
					requestedBy: attempt.runIdForPermissionAudit ?? undefined,
					rejection: { short: reason, detail: reason, hints: [] },
				});
			}
			if (source === "operator") {
				if (granted) escalationCounts.approved += 1;
				else escalationCounts.denied += 1;
			} else if (source === "timeout") {
				escalationCounts.timedOut += 1;
			}
			emitApproval(context.bus, "approval.resolved", {
				status: granted ? "granted" : "denied",
				tool: event.payload.tool,
				...(requestId !== undefined ? { requestId } : {}),
				...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
				...(origin !== undefined ? { origin } : {}),
				decidedBy,
				actionClass,
				reason,
				...(source === "timeout" ? { fallback: attempt.spec.escalation?.fallback ?? "deny" } : {}),
				...(attempt.runIdForPermissionAudit !== null ? { requestedBy: attempt.runIdForPermissionAudit } : {}),
			});
		}
		if (event.type === "pancode_tool_finish" && event.payload && typeof event.payload.tool === "string") {
			recordToolCompletion(inFlightTools, event.payload);
			recordCallFinish(inFlightCalls, event.payload);
			const tool = pendingCapabilities.get(event.payload.toolCallId ?? "") ?? event.payload.tool;
			pendingCapabilities.delete(event.payload.toolCallId ?? "");
			if (tool === ToolNames.Gateway && event.payload.toolCallId)
				gatewayFinishes.set(event.payload.toolCallId, { ...event.payload, tool });
			else recordToolFinish(toolStats, { ...event.payload, tool });
			if (isSkillActivation(event.payload.skillActivation)) {
				skillActivations.push(event.payload.skillActivation);
			}
			foldToolDecision(
				event.payload,
				tool,
				safetyDecisionCounts,
				blockedAttempts,
				guardBlockedAttempts,
				permissionRequestedAttempts,
			);
		}
	};
	return { foldWorkerEvent };
}
