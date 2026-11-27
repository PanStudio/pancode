// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../../core/hash.js";
import { isRecord } from "../../core/type-guards.js";
import type { SpawnedDelegation } from "./acp-attempt-state.js";
import { renameStoredAssignment } from "./assignment-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { DEFAULT_ACP_STALL_TIMEOUT_MS, LOCAL_RUN_NODE, rootOriginFields, routeMoveFields } from "./bundle-support.js";
import type { ActiveRun } from "./bundle-types.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { startDispatchEventPump } from "./event-pump.js";
import { withAttemptRole } from "./execution-role.js";
import { runLedgerProjection } from "./path-scope.js";
import { publishedLineage } from "./run-finish.js";
import { detectRunIdentity } from "./run-identity.js";
import type { RunEnvelope, RunLineage, RunResult } from "./types.js";

export async function openAcpRun(rt: DispatchRuntime, delegation: SpawnedDelegation) {
	const { recordingJournal } = rt.core;
	const { context } = rt;
	const {
		acp,
		budgetEnvelope,
		closeRunJournal,
		foldAcpEvent,
		hostRun,
		launch,
		ledgerRef,
		lifecycle,
		observer,
		req,
		runJournal,
		runtimeId,
		steeringProvenance,
		targetId,
		timing,
		tokenMeter,
		wireModelId,
	} = delegation;

	// The ACP process is already live; any failure to establish its tracking
	// row must not leave an orphaned agent holding a concurrency slot.
	let envelope!: RunEnvelope;
	let runningRowPersisted: Promise<void> = Promise.resolve();
	let lineage!: RunLineage;
	let identity!: ReturnType<typeof detectRunIdentity>;
	try {
		envelope = ledgerRef.create({
			projection: runLedgerProjection(req, lifecycle.pathScope),
			...(req.runIdHint !== undefined ? { id: req.runIdHint } : {}),
			agentId: req.agentId,
			executionRole: withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0),
			requestOrigin: lifecycle.requestOrigin,
			...rootOriginFields(req),
			task: req.task,
			...(req.intent !== undefined ? { intent: structuredClone(req.intent) } : {}),
			targetId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
			timing,
			sessionId: req.ownerSessionId ?? null,
			cwd: lifecycle.cwd,
			sessionShellHash: lifecycle.sessionShellHash,
			dynamicHash: lifecycle.dynamicHash,
			promptSignature: lifecycle.promptSignature,
			toolSignature: lifecycle.toolSignature,
		});
		if (req.record === true)
			ledgerRef.update(envelope.id, { recording: recordingJournal.start(envelope.id, LOCAL_RUN_NODE) });
		delegation.runIdForPermissionAudit = envelope.id;
		lineage = rt.control.lineageFor(req, envelope.id);
		if (req.lineage === undefined) {
			if (launch.lease.assignmentId !== lineage.rootRunId) {
				rt.capacity.capacityAdmission.rename(launch.lease.leaseId, lineage.rootRunId);
				await renameStoredAssignment(launch.lease.assignmentId, lineage.rootRunId);
			}
			launch.adopt(lineage.rootRunId);
		}
		identity = detectRunIdentity();
		ledgerRef.update(envelope.id, {
			budget: budgetEnvelope,
			status: "running",
			pid: acp.pid,
			heartbeatAt: rt.heartbeat.heartbeatIso(acp.heartbeatAt),
			lineage: publishedLineage(lineage, hostRun),
			identity,
			node: LOCAL_RUN_NODE,
			...(lifecycle.pipeline ? { pipeline: lifecycle.pipeline } : {}),
			...(lifecycle.briefing ? { briefing: lifecycle.briefing } : {}),
			...(req.contextSeed ? { workerContext: structuredClone(req.contextSeed.provenance) } : {}),
			...(req.gate !== undefined ? { gate: req.gate } : {}),
			...(req.council !== undefined ? { council: req.council } : {}),
			...(req.plan !== undefined ? { plan: req.plan } : {}),
			...(lifecycle.personaOverride ? { personaOverride: lifecycle.personaOverride } : {}),
			...(lifecycle.decisionRefs ? { decisionRefs: lifecycle.decisionRefs } : {}),
		});
		observer?.onAdmitted({
			runId: envelope.id,
			pid: acp.pid,
			runtimeKind: "acp-delegation",
		});
		// One durable write at start so sibling processes (pancode fleet status)
		// can observe the running row; finalization persists the terminal state.
		// Awaited only after `active` holds the run: an fsync wait here kept a
		// spawned retry out of `active`, so snapshot and abort could not see it.
		// A failed write leaves the row dirty for the terminal persist (#428).
		runningRowPersisted = rt.runs.persistLedgerInBackground(ledgerRef, envelope.id);
		if (req.lineage !== undefined) {
			context.bus.emit(
				"run.enqueued",
				{
					runId: envelope.id,
					sessionId: req.ownerSessionId ?? null,
					agentId: req.agentId,
					task: req.task,
					requestOrigin: lifecycle.requestOrigin,
					targetId,
					wireModelId,
					runtimeId,
					runtimeKind: "acp-delegation",
				},
				runJournal?.context,
			);
		}
		context.bus.emit(
			"run.started",
			{
				budget: budgetEnvelope,
				runId: envelope.id,
				sessionId: req.ownerSessionId ?? null,
				agentId: req.agentId,
				task: req.task,
				requestOrigin: lifecycle.requestOrigin,
				...rootOriginFields(req),
				...routeMoveFields(req, targetId, wireModelId),
				targetId,
				wireModelId,
				runtimeId,
				runtimeKind: "acp-delegation",
				pid: acp.pid,
				processCommand: JSON.stringify([lifecycle.agentConfig.command, ...(lifecycle.agentConfig.args ?? [])]),
				assignmentId: lineage.rootRunId,
				attempt: lineage.attempt,
				...(req.parentToolCallId !== undefined ? { parentToolCallId: req.parentToolCallId } : {}),
			},
			runJournal?.context ?? rt.route.sinklessRunContext(envelope.id, req.ownerSessionId),
		);
	} catch (error) {
		// A capture started above would otherwise keep its manifest at "recording".
		if (envelope !== undefined) recordingJournal.terminal(envelope.id, "failed");
		try {
			acp.kill();
		} catch (killError) {
			reportDispatchDiagnostic("kill orphaned ACP agent after ledger failure", killError);
		}
		await closeRunJournal();
		await launch.fail(error);
		throw error;
	}

	// Domain-owned ingestion starts here, whether or not any external
	// consumer ever iterates the returned stream: meters, tool stats, finish
	// contract state, permission audit events, and output capture fold in
	// the pump; consumers get a bounded replay tee.
	const eventPump = startDispatchEventPump(acp.events, foldAcpEvent, {
		onEvent: (event) => {
			if (isRecord(event) && event.type === "heartbeat") return;
			context.bus.emit("run.progressed", {
				runId: envelope.id,
				agentId: req.agentId,
				task: req.task,
				requestOrigin: lifecycle.requestOrigin,
				targetId,
				wireModelId,
				runtimeId,
				runtimeKind: "acp-delegation",
				event,
			});
		},
		onError: (error) => {
			delegation.toolTelemetryIngestionErrors += 1;
			reportDispatchDiagnostic(`ingest events for run ${envelope.id}`, error);
		},
	});

	const startedAt = envelope.startedAt;
	// A peer that takes guidance as another prompt (agy 1.5.0 and later) gets a steer, recorded like a native one.
	const steerAcp =
		(send: (text: string) => boolean) =>
		(text: string): boolean => {
			const canonicalText = text.trim();
			if (delegation.steeringProvenanceClosed || canonicalText.length === 0 || !send(canonicalText)) return false;
			steeringProvenance.push({
				sequence: steeringProvenance.length + 1,
				bytes: Buffer.byteLength(canonicalText, "utf8"),
				contentHash: sha256Hex(canonicalText),
				sentAt: new Date().toISOString(),
				acknowledged: false,
			});
			return true;
		};

	const finalPromise = new Promise<RunResult>((res, rej) => {
		delegation.resolveFinal = res;
		delegation.rejectFinal = rej;
	});
	const activeRun: ActiveRun = {
		budget: budgetEnvelope,
		runId: envelope.id,
		req,
		abort: acp.abort,
		kill: acp.kill,
		...(acp.steer !== undefined ? { steer: steerAcp(acp.steer) } : {}),
		promise: acp.promise.then(
			() => undefined,
			() => undefined,
		),
		recipe: null,
		startedAt,
		timing,
		targetId,
		wireModelId,
		runtimeId,
		runtimeKind: "acp-delegation",
		requestOrigin: lifecycle.requestOrigin,
		agentId: req.agentId,
		task: req.task,
		cwd: lifecycle.cwd,
		node: null,
		aborted: false,
		abortDetail: null,
		abortCause: null,
		stallKilled: false,
		stallTimeoutMs: lifecycle.agentConfig.stallTimeoutMs ?? DEFAULT_ACP_STALL_TIMEOUT_MS,
		peerQuestionOpen: () => delegation.peerQuestionsOpen > 0,
		// ACP delegation is admitted as unpriced.
		budgetExempt: true,
		lineage,
		...(hostRun === undefined ? {} : { hostRun }),
		heartbeatAt: acp.heartbeatAt,
		heartbeatStatus: "alive",
		meter: tokenMeter,
		finalPromise,
	};
	delegation.envelope = envelope;
	delegation.runningRowPersisted = runningRowPersisted;
	delegation.lineage = lineage;
	delegation.identity = identity;
	return { eventPump, startedAt, finalPromise, activeRun };
}
