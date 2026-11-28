// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { AcpDelegationRunHandle } from "../../acp/adapter.js";
import { claudeAuthEnvironment, withClaudeCredential } from "../../core/claude-environment.js";
import { readPancodeVersion } from "../../core/package-root.js";
import { emitApproval } from "../../core/telemetry/approvals.js";
import { isRecord } from "../../core/type-guards.js";
import { isBuiltinClaudeAcp, resolveClaudeLaunchCredential } from "../providers/auth/index.js";
import type { AdmittedDelegation } from "./acp-attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { createWorkerOutputCapture, workerOutputCaptureBytes } from "./event-pump.js";
import { dispatchResultContract } from "./execution-role.js";
import { recordToolCompletion, recordToolFinish, recordToolStart } from "./tool-stats.js";
import type { RunResultUpstreamResponse, RunSteeringProvenance, SafetyBlockedAttempt, ToolCallStat } from "./types.js";
import {
	appendDispatchFinishContractEntry,
	foldAssistantCall,
	foldModelCallEvent,
	foldToolDecision,
	type RunTokenMeter,
} from "./worker-event-fold.js";

export async function spawnAcpPeer(rt: DispatchRuntime, delegation: AdmittedDelegation) {
	const { maybeAgents, monotonicNow, now, safety, startAcpRun } = rt.core;
	const { context } = rt;
	let acp: AcpDelegationRunHandle;
	const {
		askPeerQuestion,
		callUsage,
		closeRunJournal,
		continuation,
		launch,
		lifecycle,
		req,
		runJournal,
		runtimeId,
		targetId,
		telemetryContext,
		timing,
		wireModelId,
	} = delegation;

	try {
		let environment: Record<string, string> | undefined;
		let credentialExpiresAt: number | undefined;
		if (isBuiltinClaudeAcp(lifecycle.agentConfig)) {
			const selected = { ...claudeAuthEnvironment(), ...lifecycle.agentConfig.env };
			const credential = await resolveClaudeLaunchCredential(undefined, selected);
			environment = withClaudeCredential(selected, credential?.apiKey) as Record<string, string>;
			credentialExpiresAt = credential?.expiresAt;
		}
		acp = startAcpRun({
			...(telemetryContext
				? {
						telemetry: {
							context: telemetryContext,
							target: {
								targetId,
								runtimeId,
								api: "acp",
								requestedModel: req.model ?? wireModelId,
								reportedModel: { kind: "unknown" as const, reason: "not-observed" as const },
							},
						},
					}
				: {}),
			agent: lifecycle.agentConfig,
			...(environment ? { environment } : {}),
			...(credentialExpiresAt !== undefined ? { credentialExpiresAt } : {}),
			task: req.task,
			...(req.model !== undefined ? { model: req.model } : {}),
			...(req.thinkingLevel !== undefined ? { thinkingLevel: req.thinkingLevel } : {}),
			systemPrompt: lifecycle.systemPrompt,
			dynamicPromptMessages: lifecycle.dynamicPromptMessages,
			cwd: lifecycle.cwd,
			safety,
			...(req.readOnly === true ? { readOnly: true } : {}),
			clientVersion: readPancodeVersion(),
			now,
			monotonicNow,
			askPeerQuestion,
			...(continuation?.kind === "reopen" ? { reopen: { sessionId: continuation.acpSessionId } } : {}),
		});
	} catch (error) {
		await closeRunJournal();
		await launch.fail(error);
		throw error;
	}
	timing.workerSpawnedAt = new Date(now()).toISOString();

	const tokenMeter: RunTokenMeter = {};
	const safetyDecisionCounts = { allowed: 0, blocked: 0, guardBlocked: 0, permissionRequested: 0 };
	const blockedAttempts: SafetyBlockedAttempt[] = [];
	const guardBlockedAttempts: SafetyBlockedAttempt[] = [];
	const permissionRequestedAttempts: SafetyBlockedAttempt[] = [];
	const toolStats = new Map<string, ToolCallStat>();
	const inFlightTools = new Map<string, number>();
	delegation.toolTelemetryIngestionErrors = 0;
	const upstreamResponses: RunResultUpstreamResponse[] = [];
	const finishContractEntries: unknown[] = [];
	delegation.finishContractAssistantText = "";
	delegation.finishContractAssistantTurnId = null;

	delegation.outcomeCode = null;
	let reportedSpoofedOutcome = false;
	delegation.runIdForPermissionAudit = null;
	// Steering provenance as a native run keeps it: one entry per message the peer took as another prompt, closed
	// once the peer answers that prompt; the prose itself is never kept.
	const steeringProvenance: RunSteeringProvenance[] = [];
	delegation.steeringProvenanceClosed = false;
	const outputCapture = createWorkerOutputCapture({
		maxBytes: workerOutputCaptureBytes(
			dispatchResultContract(req, req.agentId && maybeAgents ? maybeAgents.getSpec(req.agentId) : null),
		),
	});
	const foldAcpEvent = (raw: unknown): void => {
		if (isRecord(raw) && raw.type === "pancode_telemetry") {
			runJournal?.worker(raw);
			if (callUsage && !callUsage.observe(raw)) callUsage.gap();
			const usage = callUsage?.snapshot();
			if (usage) {
				tokenMeter.usage = usage;
				rt.budget.stopRunsAtCostCeiling();
			}
			return;
		}
		outputCapture.observe(raw);
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
			};
			payload?: {
				callIndex?: number;
				model?: unknown;
				responseModel?: unknown;
				responseId?: unknown;
				usage?: unknown;
				tool?: string;
				posture?: string;
				durationMs?: number;
				outcome?: "ok" | "error" | "blocked";
				decision?: "allowed" | "blocked" | "permission_requested";
				actionClass?: string;
				ruleId?: string;
				reasonCode?: string;
				policySource?: string;
				reason?: string;
				requestId?: string;
				mode?: "deny" | "fail" | "escalate";
				source?: "operator" | "timeout" | "policy" | "remembered";
				sequence?: unknown;
			};
		};
		if (event.type === "pancode_steer_received" && !delegation.steeringProvenanceClosed) {
			const pending = steeringProvenance.find(
				(entry) => entry.sequence === event.payload?.sequence && !entry.acknowledged,
			);
			if (pending !== undefined) {
				pending.acknowledged = true;
				pending.acknowledgedAt = new Date().toISOString();
			}
		}
		if (event.type === "pancode_tool_start" && event.payload && typeof event.payload.tool === "string") {
			recordToolStart(inFlightTools, event.payload);
		}
		// ACP is an external protocol peer, never an authority for PanCode's
		// deterministic terminal taxonomy. Ignore even syntactically valid
		// assertions; only a future coordinator-side classifier may set one.
		if (event.type === "pancode_run_outcome" && !reportedSpoofedOutcome) {
			reportedSpoofedOutcome = true;
			reportDispatchDiagnostic("ACP outcome event", new Error("ignored untrusted pancode_run_outcome assertion"));
		}
		if (isRecord(event)) {
			const finishEntry = appendDispatchFinishContractEntry(finishContractEntries, event);
			if (finishEntry !== null) {
				delegation.finishContractAssistantText = finishEntry.assistantText;
				delegation.finishContractAssistantTurnId = finishEntry.assistantTurnId;
			}
		}
		foldModelCallEvent(event, upstreamResponses);
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const errorMessage = foldAssistantCall(event.message, tokenMeter, upstreamResponses, null);
			if (errorMessage !== null) delegation.failureMessage = errorMessage;
		}
		if (event.type === "pancode_permission_resolved" && event.payload && typeof event.payload.tool === "string") {
			const requestId =
				typeof event.payload.requestId === "string" ? event.payload.requestId : `delegation-permission-${Date.now()}`;
			const origin =
				delegation.runIdForPermissionAudit !== null
					? `delegation:${delegation.runIdForPermissionAudit}`
					: "delegation:unknown";
			const actionClass = typeof event.payload.actionClass === "string" ? event.payload.actionClass : "unknown";
			const reason =
				typeof event.payload.reason === "string" ? event.payload.reason : `${event.payload.tool} requires approval`;
			emitApproval(context.bus, "approval.requested", {
				tool: event.payload.tool,
				actionClass,
				requestId,
				...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
				origin,
				requestedBy: delegation.runIdForPermissionAudit ?? undefined,
				rejection: { short: reason, detail: reason, hints: [] },
			});
			emitApproval(context.bus, "approval.resolved", {
				status: "denied",
				tool: event.payload.tool,
				requestId,
				...(req.ownerSessionId ? { sessionId: req.ownerSessionId } : {}),
				origin,
				decidedBy: "policy:no-operator",
				actionClass,
				reason,
				...(delegation.runIdForPermissionAudit !== null ? { requestedBy: delegation.runIdForPermissionAudit } : {}),
			});
		}
		if (event.type === "pancode_tool_finish" && event.payload && typeof event.payload.tool === "string") {
			recordToolCompletion(inFlightTools, event.payload);
			recordToolFinish(toolStats, event.payload);
			foldToolDecision(
				event.payload,
				event.payload.tool,
				safetyDecisionCounts,
				blockedAttempts,
				guardBlockedAttempts,
				permissionRequestedAttempts,
			);
		}
	};
	delegation.acp = acp;
	return {
		tokenMeter,
		safetyDecisionCounts,
		blockedAttempts,
		guardBlockedAttempts,
		permissionRequestedAttempts,
		toolStats,
		inFlightTools,
		upstreamResponses,
		finishContractEntries,
		steeringProvenance,
		outputCapture,
		foldAcpEvent,
	};
}
