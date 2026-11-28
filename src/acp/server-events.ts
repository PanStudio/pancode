// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's runtime-event and job forwarding: the bus subscriptions that turn engine events into session updates. */

import { readContextOperation } from "../core/context-operation.js";
import { readDispatchScopeNotice } from "../core/dispatch-scope-notice.js";
import type { JobRecord } from "../core/job-types.js";
import type {
	BudgetAlertPayload,
	CompactionPayload,
	ContextWarningPayload,
	DispatchCompletedPayload,
	DispatchEnqueuedPayload,
	DispatchFailedPayload,
	DispatchProgressPayload,
	DispatchStartedPayload,
	EvidenceAssessedPayload,
	LoopBlockedPayload,
	ProviderHealthPayload,
	ToolBudgetExceededPayload,
} from "../core/telemetry/live-events.js";
import { jobIsComplete } from "../domains/scheduling/index.js";
import { budgetBlockFrame } from "./budget-notice.js";
import { ACP_MAX_JOBS } from "./runtime.js";
import { createAcpRuntimeNoticeRelay, subscribeAcpNotices } from "./runtime-notice.js";
import { safeStoredIdentifier, safeStoredString } from "./server-bounds.js";
import type { DispatchRunTrack } from "./server-event-frames.js";
import {
	ACP_MAX_DISPATCH_ID_BYTES,
	ACP_MAX_DISPATCH_PROGRESS_EVENTS,
	ACP_MAX_EVENT_TEXT_BYTES,
	ACP_MAX_EVIDENCE_TAG_BYTES,
	ACP_MAX_EVIDENCE_TAGS,
	ACP_MAX_SCOPE_NOTICE_BYTES,
	dispatchIdentity,
	jobEventPayload,
	lifecycleFrame,
	readResult,
	runResultMeta,
	runTokenCoverage,
	safeCount,
	trackDispatchRun,
} from "./server-event-frames.js";
import { ACP_MAX_SESSION_ID_BYTES } from "./server-guards.js";
import type { AcpForwardableEventKind } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import {
	ACP_MAX_TOOL_CALL_AGENTS,
	ORCHESTRATOR_UPDATE_META,
	openWireIdFor,
	sendUpdate,
	toolCallUpdateMeta,
} from "./server-tool-updates.js";
import type { AcpToolCallStatus } from "./types.js";
import {
	ACP_EGGS_META_KEY,
	ACP_EVENT_NOTIFICATION,
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_MEMORY_META_KEY,
	ACP_NOTICE_META_KEY,
} from "./types.js";

export function createAcpServerEvents(scope: AcpServerScope) {
	const { options } = scope;
	let eventSequence = 0;
	/**
	 * Per-run progress counters for the forwarded dispatch stream, insertion
	 * ordered. A terminal event removes its run; the cap evicts the oldest live
	 * run rather than refusing the newest, so a leaked run cannot starve the
	 * board of the run an operator is actually watching.
	 */
	const dispatchProgress = new Map<string, DispatchRunTrack>();
	/** The newest record seen per job, so a turn bracket reuses the controller's own figures. Bounded. */
	const lastJobs = new Map<string, JobRecord>();
	/**
	 * Sends one frame of the opt-in stream. Every forwarded channel goes through
	 * here so the envelope, the sequence, and the opt-in check cannot drift per
	 * channel. Nothing is sent before a session exists: the envelope's
	 * `sessionId` is the client's only way to bind a fact to what it is showing.
	 */
	const forwardEvent = (
		kind: AcpForwardableEventKind,
		turnId: string | null,
		terminal: boolean,
		payload: Record<string, unknown>,
		meta?: Record<string, unknown>,
	): void => {
		const sessionId = scope.activeSessionId ?? scope.boundSessionId;
		if (!scope.handshake.initialized || !scope.handshake.enabledEventKinds.has(kind) || sessionId === null) return;
		eventSequence += 1;
		try {
			options.transport.notify(ACP_EVENT_NOTIFICATION, {
				version: 1,
				workspaceInstanceId: scope.workspaceInstanceId,
				sessionId,
				turnId,
				sequence: eventSequence,
				kind,
				terminal,
				payload,
				...(meta !== undefined ? { _meta: meta } : {}),
			});
		} catch {
			options.diagnostics?.("failed to send an opted-in ACP event");
		}
	};

	const unsubscribeEvents: Array<() => void> = [];
	// Runtime notices cross as session metadata like startup hints, never on stderr, which a client keeps only as a crash tail.
	const runtimeNotices = createAcpRuntimeNoticeRelay((sessionId, notice) =>
		options.transport.notify("session/update", {
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				_meta: { [ACP_NOTICE_META_KEY]: { ...notice, text: safeStoredString(notice.text, ACP_MAX_CHUNK_BYTES) } },
			},
		}),
	);
	if (options.bus !== undefined) {
		const bus = options.bus;
		const noticeSession = () => (scope.handshake.initialized ? (scope.activeSessionId ?? scope.boundSessionId) : null);
		const sessionMeta = (owner: string | null, meta: Record<string, unknown>) => {
			const sessionId = noticeSession();
			if (sessionId === null || owner !== sessionId) return;
			options.transport.notify("session/update", {
				sessionId,
				update: { sessionUpdate: "session_info_update", _meta: meta },
			});
		};
		unsubscribeEvents.push(
			bus.subscribe("context.pruned", () => scope.telemetry.contextFolded()),
			subscribeAcpNotices(bus, runtimeNotices, noticeSession, (sessionId) => scope.commands.announceCommands(sessionId)),
			bus.subscribe("session.eggs_changed", (event) =>
				sessionMeta(event.sessionId, { [ACP_EGGS_META_KEY]: event.active }),
			),
			bus.subscribe("memory.guardian_changed", (event) =>
				sessionMeta(event.sessionId, { [ACP_MEMORY_META_KEY]: { state: event.state } }),
			),
			bus.subscribe("budget.alerted", (payload: BudgetAlertPayload) => {
				// The stop parks the request inside the running prompt, so it crosses
				// as that prompt's notice chunk, figures beside the text (#424). Between
				// prompts nothing is parked and the alert has no turn to belong to.
				const active = scope.activePromptState;
				const sessionId = scope.activeSessionId ?? scope.boundSessionId;
				if (active === null || active.cancelled || sessionId === null) return;
				const frame = budgetBlockFrame(payload);
				if (frame === null) return;
				sendUpdate(options.transport, sessionId, active, frame.update, { ...ORCHESTRATOR_UPDATE_META, ...frame.meta });
			}),
			bus.subscribe("turn.aborted", (payload) => {
				const active = scope.activePromptState;
				if (active !== null && !active.cancelled && payload.source === "loop_guard") active.guardStopped = true;
			}),
			bus.subscribe("safety.loop_blocked", (payload: LoopBlockedPayload) => {
				// Loop blocks describe the turn that is running, so unlike a dispatch
				// run they are meaningless outside one.
				if (scope.activePromptState === null) return;
				if (
					!Number.isSafeInteger(payload.repeatCount) ||
					payload.repeatCount < 1 ||
					!Number.isSafeInteger(payload.blocksThisTurn) ||
					payload.blocksThisTurn < 1 ||
					!Number.isSafeInteger(payload.budget) ||
					payload.budget < 1 ||
					!(["block", "lockout", "stop"] as ReadonlyArray<string>).includes(payload.disposition) ||
					payload.interrupted !== (payload.disposition === "stop")
				) {
					return;
				}
				const tool = safeStoredString(payload.tool, 64).trim();
				if (tool.length === 0) return;
				forwardEvent("safety.loop_blocked", safeStoredIdentifier(payload.turnId, ACP_MAX_SESSION_ID_BYTES), false, {
					toolCallId: null,
					tool,
					repeatCount: payload.repeatCount,
					blocksThisTurn: payload.blocksThisTurn,
					budget: payload.budget,
					disposition: payload.disposition,
					interrupted: payload.interrupted,
					shape: null,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.enqueued", (payload: DispatchEnqueuedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null || !trackDispatchRun(dispatchProgress, lifecycleFrame("enqueued", identity.runId))) return;
				forwardEvent("run.enqueued", null, false, {
					...identity,
					origin: safeStoredIdentifier(payload.requestOrigin, 64),
					attempt: null,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.started", (payload: DispatchStartedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null || !trackDispatchRun(dispatchProgress, lifecycleFrame("started", identity.runId))) return;
				// A run started by a tool call this turn already put on the wire is
				// the one place the harness knows which agent produced a tool
				// segment. Record it and re-announce the call so a client can label
				// the segment while the worker is still running.
				attributeRunToToolCall(payload.parentToolCallId, identity);
				forwardEvent("run.started", null, false, {
					...identity,
					origin: safeStoredIdentifier(payload.requestOrigin, 64),
					attempt: safeCount(payload.attempt),
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.progressed", (payload: DispatchProgressPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				const state = trackDispatchRun(dispatchProgress, lifecycleFrame("progressed", identity.runId));
				if (state === null || state.capped) return;
				state.count += 1;
				const capped = state.count > ACP_MAX_DISPATCH_PROGRESS_EVENTS;
				if (capped) state.capped = true;
				// The worker/ACP event that triggered this crossed a process boundary
				// and is typed `unknown`; none of it goes on the wire. What a board
				// needs is that the run is alive and roughly how much it has done.
				forwardEvent("run.progressed", null, false, {
					runId: identity.runId,
					agentId: identity.agentId,
					progressCount: state.count,
					truncated: capped,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.completed", (payload: DispatchCompletedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				trackDispatchRun(dispatchProgress, lifecycleFrame("ended", identity.runId, payload.outcome));
				forwardEvent(
					"run.completed",
					null,
					true,
					{
						runId: identity.runId,
						agentId: identity.agentId,
						outcome: safeStoredIdentifier(payload.outcome, 64),
						outcomeCode: safeStoredIdentifier(payload.outcomeCode, 64),
						outcomeDetail: safeStoredString(payload.outcomeDetail, 2048) || null,
						durationMs: safeCount(payload.durationMs),
						...runTokenCoverage(payload.spend),
					},
					runResultMeta(identity.runId, readResult(identity.runId, false)),
				);
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.failed", (payload: DispatchFailedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				trackDispatchRun(dispatchProgress, lifecycleFrame("ended", identity.runId, payload.outcome));
				forwardEvent(
					"run.failed",
					null,
					true,
					{
						runId: identity.runId,
						agentId: identity.agentId,
						outcome: safeStoredIdentifier(payload.outcome, 64),
						reason: safeStoredIdentifier(payload.reason, 64),
						outcomeCode: safeStoredIdentifier(payload.outcomeCode, 64),
						outcomeDetail: safeStoredString(payload.outcomeDetail, 2048) || null,
						durationMs: safeCount(payload.durationMs),
						...(payload.spend ? runTokenCoverage(payload.spend) : {}),
					},
					runResultMeta(identity.runId, readResult(identity.runId, false)),
				);
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("evidence.assessed", (payload: EvidenceAssessedPayload) => {
				// The run's journal owner assesses it before sealing, so this arrives ahead of the run's
				// run.completed or run.failed and is not terminal (#434). Only the summary counters cross;
				// the finding prose stays in the run scope, and the tags are filtered to bounded identifiers
				// rather than truncated into new ones.
				const runId = safeStoredIdentifier(payload.runId, ACP_MAX_DISPATCH_ID_BYTES);
				if (runId === null) return;
				const findings = Array.isArray(payload.findings) ? payload.findings : [];
				const tags = [...new Set(findings.map((finding) => finding.tag))]
					.map((tag) => safeStoredIdentifier(tag, ACP_MAX_EVIDENCE_TAG_BYTES))
					.filter((tag): tag is string => tag !== null)
					.slice(0, ACP_MAX_EVIDENCE_TAGS);
				forwardEvent("evidence.assessed", null, false, {
					runId,
					firstPassSuccess: payload.firstPassSuccess === true,
					findingCount: safeCount(findings.length),
					tags,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("context.activity_changed", (payload) => {
				if (
					!payload.operation ||
					payload.operation.sessionId !== scope.boundSessionId ||
					payload.operation.cwd !== scope.canonicalCwd
				)
					return;
				const operation = readContextOperation(payload.operation);
				if (!operation) return;
				scope.contextActivity = {
					kind: payload.kind,
					phase: payload.phase,
					status: payload.status,
					at: payload.at,
					message: safeStoredString(payload.message, 1024),
					operation,
					...(payload.current === undefined ? {} : { current: payload.current }),
					...(payload.total === undefined ? {} : { total: payload.total }),
					...(payload.detail === undefined ? {} : { detail: safeStoredString(payload.detail, 1024) }),
					...(payload.stages === undefined ? {} : { stages: payload.stages }),
					...(payload.timing === undefined ? {} : { timing: payload.timing }),
				};
				forwardEvent("context.activity_changed", null, operation.outcome !== undefined, { ...scope.contextActivity });
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("compaction.ended", (payload: CompactionPayload) => {
				const trigger = safeStoredIdentifier(payload.trigger, 64);
				if (trigger === null) return;
				forwardEvent("compaction.ended", null, false, {
					trigger,
					...(payload.outcome !== undefined ? { outcome: payload.outcome } : {}),
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("context.warning_raised", (payload: ContextWarningPayload) => {
				// Transition-only upstream, so this is a level edge, not a poll:
				// `warning: null` is the clear and has to cross as itself rather than
				// be dropped, or a client's banner never comes down.
				if (payload.warning !== null && typeof payload.warning !== "string") return;
				const warning = payload.warning === null ? null : safeStoredString(payload.warning, ACP_MAX_EVENT_TEXT_BYTES);
				forwardEvent("context.warning_raised", null, false, { warning: warning === "" ? null : warning });
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.scope_notice_raised", (payload) => {
				// The same fields every other surface draws. The message is host-authored
				// prose about what a dispatch's scope entry did, so it crosses bounded;
				// the paths a prose-inferred notice lists stay behind.
				const notice = readDispatchScopeNotice(payload);
				if (notice === null) return;
				forwardEvent("run.scope_notice_raised", null, false, {
					code: notice.code,
					level: notice.level,
					message: safeStoredString(notice.message, ACP_MAX_SCOPE_NOTICE_BYTES),
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("safety.tool_budget_exceeded", (payload: ToolBudgetExceededPayload) => {
				// Bound to the turn that is running, like `safety.loop_blocked`: the
				// budget it names is per-turn and means nothing outside one.
				if (scope.activePromptState === null) return;
				const callsThisTurn = safeCount(payload.callsThisTurn);
				const softBudget = safeCount(payload.softBudget);
				const hardCeiling = safeCount(payload.hardCeiling);
				const tool = safeStoredString(payload.tool, 64).trim();
				if (callsThisTurn === null || softBudget === null || hardCeiling === null || tool.length === 0) return;
				forwardEvent(
					"safety.tool_budget_exceeded",
					safeStoredIdentifier(payload.turnId, ACP_MAX_SESSION_ID_BYTES),
					payload.interrupted === true,
					{ tool, callsThisTurn, softBudget, hardCeiling, interrupted: payload.interrupted === true },
				);
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("provider.health_changed", (payload: ProviderHealthPayload) => {
				// `status.lastError` is provider prose that legitimately quotes URLs,
				// response bodies, and credentials-adjacent detail, so it stays behind
				// exactly as `run.failed`'s `outcomeDetail` does. What crosses is
				// the taxonomy a retry-visibility row needs.
				const targetId = safeStoredIdentifier(payload.id, ACP_MAX_TARGET_ID_BYTES);
				const status = payload.status?.health?.status;
				if (targetId === null || !(["healthy", "degraded", "unknown", "down"] as ReadonlyArray<unknown>).includes(status)) {
					return;
				}
				forwardEvent("provider.health_changed", null, false, {
					targetId,
					status,
					available: payload.status.available === true,
					latencyMs: safeCount(payload.status.health.latencyMs),
				});
			}),
		);
	}
	/** True only while this job's scheduled turn has sent its first frame and not yet released. */
	const jobTurnOpen = (jobId: string): boolean =>
		scope.machineLease !== null &&
		scope.machineLease.jobId === jobId &&
		scope.machineLease.active.scheduled?.opened === true;
	/** Sends one job's canonical record. */
	const forwardJob = (job: JobRecord, complete: boolean): void => {
		const projected = jobEventPayload(job, complete, jobTurnOpen(job.id), options.commands?.jobSpend?.(job.id) ?? null);
		if (projected === null) return;
		forwardEvent("job.changed", null, complete, projected);
	};
	/** Re-sends the held record to open or close the turn bracket; the controller's own change follows when it commits. */
	const forwardJobTurn = (jobId: string): void => {
		const job = lastJobs.get(jobId) ?? options.commands?.jobs?.().find((candidate) => candidate.id === jobId);
		if (job !== undefined) forwardJob(job, jobIsComplete(job));
	};
	if (options.bus !== undefined) {
		unsubscribeEvents.push(
			options.bus.subscribe("job.changed", (payload) => {
				// A job belongs to the session and workspace that created it. The bus is
				// process-wide, so a frame for any other owner is not this client's.
				const owner = payload.job?.owner;
				if (
					owner === undefined ||
					owner.sessionId !== (scope.activeSessionId ?? scope.boundSessionId) ||
					owner.cwd !== scope.canonicalCwd
				) {
					return;
				}
				lastJobs.delete(payload.job.id);
				lastJobs.set(payload.job.id, payload.job);
				for (const oldest of lastJobs.keys()) {
					if (lastJobs.size <= ACP_MAX_JOBS * 2) break;
					lastJobs.delete(oldest);
				}
				forwardJob(payload.job, payload.complete === true);
			}),
		);
	}
	const unsubscribeEventStream = (): void => {
		for (const unsubscribe of unsubscribeEvents) unsubscribe();
		unsubscribeEvents.length = 0;
		dispatchProgress.clear();
		lastJobs.clear();
	};

	/**
	 * Records a delegated agent against the tool call that spawned it and
	 * re-announces that call so the attribution reaches the client while the
	 * worker is running. Nothing is minted here: an id with no open call this
	 * turn binds to nothing, exactly as on the permission path.
	 */
	function attributeRunToToolCall(
		parentToolCallId: string | undefined,
		identity: { runId: string; agentId: string; node: string | null },
	): void {
		const active = scope.activePromptState;
		if (active === null || scope.activeSessionId === null) return;
		if (parentToolCallId === undefined || parentToolCallId.length === 0) return;
		const wireId = openWireIdFor(active, parentToolCallId);
		if (wireId === null) return;
		const snapshot = active.toolCallSnapshots.get(wireId);
		if (snapshot === undefined) return;
		const agents = snapshot.agents ?? [];
		if (agents.length >= ACP_MAX_TOOL_CALL_AGENTS) return;
		if (agents.some((agent) => agent.runId === identity.runId)) return;
		agents.push({
			version: 1,
			role: "worker",
			agentId: identity.agentId,
			runId: identity.runId,
			...(identity.node !== null ? { node: identity.node } : {}),
		});
		snapshot.agents = agents;
		sendUpdate(
			options.transport,
			scope.activeSessionId,
			active,
			{
				sessionUpdate: "tool_call_update",
				toolCallId: wireId,
				title: snapshot.title,
				kind: snapshot.kind,
				status: "in_progress" satisfies AcpToolCallStatus,
			},
			toolCallUpdateMeta(snapshot),
		);
	}
	return { forwardEvent, forwardJobTurn, jobTurnOpen, runtimeNotices, unsubscribeEventStream };
}

export type AcpServerEvents = ReturnType<typeof createAcpServerEvents>;
