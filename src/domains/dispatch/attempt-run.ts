// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { detectRunIdentity } from "../../core/run-identity.js";
import { compileWorkerFlowPolicy, flowTransferRefusal, resolveModelDestination } from "../safety/information-flow.js";
import { subscribeAgentLedger } from "./agent-ledger-hub.js";
import type { AgentLedgerAttribution } from "./agent-ledger-store.js";
import { renameStoredAssignment } from "./assignment-store.js";
import type { FoldingAttempt } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { budgetExemptRoute, LOCAL_RUN_NODE, rootOriginFields, routeMoveFields } from "./bundle-support.js";
import type { ActiveRun } from "./bundle-types.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { startDispatchEventPump } from "./event-pump.js";
import { withAttemptRole } from "./execution-role.js";
import { nodeComponentRemedyEvent } from "./failure-classification.js";
import { runLedgerProjection } from "./path-scope.js";
import { publishedLineage } from "./run-finish.js";
import { malformedWorkerStdoutLineCount } from "./run-outcome-detail.js";
import type { RunEnvelope, RunResult } from "./types.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "./worker-spawn.js";

export async function openAttemptRun(rt: DispatchRuntime, attempt: FoldingAttempt) {
	const { recordingJournal } = rt.core;
	const { context } = rt;
	let subscribeHeldBoard = attempt.subscribeHeldBoard;
	const {
		abort,
		agentLedgerId,
		appendLedgerPost,
		closeRunJournal,
		endpoint,
		foldWorkerEvent,
		grantAttempt,
		heartbeatAt,
		heldFollower,
		heldLedgerPosts,
		holdPermission,
		hostRun,
		inFlightCalls,
		launch,
		ledgerRef,
		lifecycle,
		observer,
		placed,
		placement,
		preparation,
		req,
		resolvePermission,
		steer,
		timing,
		tokenMeter,
		worker,
		workerDone,
		workerEvents,
	} = attempt;

	// The worker is already live; any failure to establish its tracking row
	// must not leave an orphaned subprocess holding a concurrency slot.
	let envelope!: RunEnvelope;
	let runningRowPersisted: Promise<void> = Promise.resolve();

	let identity!: ReturnType<typeof detectRunIdentity>;
	try {
		envelope = ledgerRef.create({
			projection: runLedgerProjection(req, lifecycle.pathScope, lifecycle.envelope.withheld),
			...(req.runIdHint !== undefined ? { id: req.runIdHint } : {}),
			agentId: req.agentId,
			executionRole: withAttemptRole(req.executionRole, req.lineage?.attempt ?? 0),
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			...rootOriginFields(req),
			task: req.task,
			...(req.intent !== undefined ? { intent: structuredClone(req.intent) } : {}),
			budget: lifecycle.budgetEnvelope,
			targetId: lifecycle.target.target.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			timing,
			sessionId: req.ownerSessionId ?? null,
			cwd: lifecycle.cwd,
			sessionShellHash: lifecycle.sessionShellHash,
			dynamicHash: lifecycle.dynamicHash,
			promptSignature: lifecycle.promptSignature,
			toolSignature: lifecycle.toolSignature,
		});
		if (req.record === true)
			ledgerRef.update(envelope.id, {
				recording: recordingJournal.start(envelope.id, placement?.node ?? LOCAL_RUN_NODE),
			});
		attempt.runIdForPermissionAudit = envelope.id;
		if (grantAttempt !== undefined)
			rt.grants.grantRunFallbacks.set(envelope.id, attempt.spec.escalation?.fallback ?? "deny");
		attempt.lineage = rt.control.lineageFor(req, envelope.id);
		if (req.lineage === undefined) {
			if (launch.lease.assignmentId !== attempt.lineage.rootRunId) {
				rt.capacity.capacityAdmission.rename(launch.lease.leaseId, attempt.lineage.rootRunId);
				await renameStoredAssignment(launch.lease.assignmentId, attempt.lineage.rootRunId);
			}
			launch.adopt(attempt.lineage.rootRunId);
		}
		if (agentLedgerId !== null) {
			const attribution: AgentLedgerAttribution = {
				runId: envelope.id,
				assignmentId: attempt.lineage.rootRunId,
				agentId: req.agentId,
				nodeId: placed.id,
			};
			attempt.agentLedgerAttribution = attribution;
			// The hub replays the whole board on subscription, so this mirror is
			// complete whatever this run's spawn timing was. A held follower's
			// handle refuses deliveries until its worker exists, and the hub drops a
			// subscriber that refuses one, so that run subscribes when it starts.
			const ledgerId = agentLedgerId;
			const boardRunId = envelope.id;
			const subscribeBoard = (): (() => void) | null =>
				lifecycle.runtimeKind !== "http"
					? null
					: subscribeAgentLedger(ledgerId, boardRunId, (entries) =>
							attempt.sendToWorker === undefined
								? false
								: attempt.sendToWorker({
										type: "ledger_delta",
										entries: entries.filter((entry) => {
											if ((entry.flowRestrictions?.restrictions.length ?? 0) === 0) return true;
											if (attempt.spec.flowPolicy === undefined || lifecycle.runtimeKind !== "http") return false;
											return (
												flowTransferRefusal(
													compileWorkerFlowPolicy(attempt.spec.flowPolicy),
													entry.flowRestrictions ?? null,
													resolveModelDestination({
														targetId: lifecycle.target.target.id,
														runtimeId: lifecycle.target.runtime.id,
														url: lifecycle.target.target.url,
														model: lifecycle.target.wireModelId,
													}),
												) === null
											);
										}),
									}),
						);
			if (heldFollower) {
				subscribeHeldBoard = () => {
					attempt.unsubscribeAgentLedger = subscribeBoard();
				};
			} else {
				attempt.unsubscribeAgentLedger = subscribeBoard();
			}
			for (const post of heldLedgerPosts.splice(0)) appendLedgerPost(attribution, post.body, post.flowRestrictions);
		}
		identity = detectRunIdentity();
		ledgerRef.update(envelope.id, {
			status: "running",
			pid: worker.pid,
			lineage: publishedLineage(attempt.lineage, hostRun),
			identity,
			node: placement?.node ?? LOCAL_RUN_NODE,
			...(placement?.reroutes !== undefined && placement.reroutes.length > 0 ? { reroutes: [...placement.reroutes] } : {}),
			...(lifecycle.pipeline ? { pipeline: lifecycle.pipeline } : {}),
			...(lifecycle.briefing ? { briefing: lifecycle.briefing } : {}),
			...(req.contextSeed ? { workerContext: structuredClone(req.contextSeed.provenance) } : {}),
			...(req.gate !== undefined ? { gate: req.gate } : {}),
			...(req.council !== undefined ? { council: req.council } : {}),
			...(req.plan !== undefined ? { plan: req.plan } : {}),
			...(lifecycle.personaOverride ? { personaOverride: lifecycle.personaOverride } : {}),
			...(lifecycle.decisionRefs ? { decisionRefs: lifecycle.decisionRefs } : {}),
			...(heartbeatAt ? { heartbeatAt: rt.heartbeat.heartbeatIso(heartbeatAt) } : {}),
		});
		observer?.onAdmitted({
			runId: envelope.id,
			pid: worker.pid,
			runtimeKind: lifecycle.runtimeKind,
		});
		// One durable write at start so sibling processes (pancode fleet status)
		// can observe the running row; finalization persists the terminal state.
		// Awaited only after `active` holds the run: an fsync wait here kept a
		// spawned retry out of `active`, so snapshot and abort could not see it.
		// A failed write leaves the row dirty for the terminal persist (#428).
		runningRowPersisted = rt.runs.persistLedgerInBackground(ledgerRef, envelope.id);

		// Fleet-visibility facts for the board: node placement, gate role,
		// reroute lineage depth, and the model context window for the
		// per-worker meter. All optional so consumers degrade to local/plain.
		const fleetIdentity = {
			sessionId: req.ownerSessionId ?? null,
			...rootOriginFields(req),
			budget: lifecycle.budgetEnvelope,
			...(endpoint !== null ? { endpoint: { key: endpoint.key, label: endpoint.label, limit: endpoint.limit } } : {}),
			...(placement !== undefined && placement !== null ? { node: placement.node.id } : {}),
			...(req.gate !== undefined ? { gate: { role: req.gate.role, cycle: req.gate.cycle } } : {}),
			...(req.council !== undefined ? { council: req.council } : {}),
			...(req.reroutes !== undefined && req.reroutes.length > 0 ? { rerouteCount: req.reroutes.length } : {}),
			...(lifecycle.target.modelCapabilities !== undefined &&
			lifecycle.target.modelCapabilities !== null &&
			lifecycle.target.modelCapabilities.contextWindow > 0
				? { contextWindow: lifecycle.target.modelCapabilities.contextWindow }
				: {}),
		};
		const runId = envelope.id;
		const startedLineage = attempt.lineage;
		const journalContext = attempt.runJournal?.context ?? rt.route.sinklessRunContext(runId, req.ownerSessionId);
		const publishStarted = (live: SpawnedWorker): void => {
			context.bus.emit(
				"run.started",
				{
					runId,
					agentId: req.agentId,
					task: req.task,
					agentAudience: lifecycle.agentAudience,
					requestOrigin: lifecycle.requestOrigin,
					targetId: lifecycle.target.target.id,
					wireModelId: lifecycle.target.wireModelId,
					runtimeId: lifecycle.target.runtime.id,
					runtimeKind: lifecycle.runtimeKind,
					pid: live.pid,
					...(live.processCommand !== undefined ? { processCommand: live.processCommand } : {}),
					...fleetIdentity,
					...routeMoveFields(req, lifecycle.target.target.id, lifecycle.target.wireModelId),
					assignmentId: startedLineage.rootRunId,
					attempt: startedLineage.attempt,
					...(req.parentToolCallId !== undefined ? { parentToolCallId: req.parentToolCallId } : {}),
				},
				journalContext,
			);
		};
		// A held follower is admitted with its row, but run.started waits for its child process to be live.
		if (req.lineage !== undefined || heldFollower) {
			context.bus.emit(
				"run.enqueued",
				{
					runId: envelope.id,
					agentId: req.agentId,
					task: req.task,
					agentAudience: lifecycle.agentAudience,
					requestOrigin: lifecycle.requestOrigin,
					targetId: lifecycle.target.target.id,
					wireModelId: lifecycle.target.wireModelId,
					runtimeId: lifecycle.target.runtime.id,
					runtimeKind: lifecycle.runtimeKind,
					...fleetIdentity,
				},
				attempt.runJournal?.context,
			);
		}
		if (heldFollower) {
			attempt.onFollowerStarted = (started) => {
				try {
					// Replace only this process's own vouch: a row written after the start already names the
					// worker, and one that settled meanwhile keeps what it recorded.
					if (ledgerRef.get(runId)?.pid === process.pid) {
						// The pid goes with the follower's own heartbeat: `fleet cancel` tells a recycled pid from
						// this worker by a heartbeat later than its start, and no spend write refreshes it (FL-24).
						ledgerRef.update(runId, { pid: started.pid, heartbeatAt: rt.heartbeat.heartbeatIso(started.heartbeatAt) });
						void rt.runs.persistLedgerInBackground(ledgerRef, runId);
					}
					subscribeHeldBoard?.();
					publishStarted(started);
				} catch (error) {
					// The worker is already live; its run settles through the worker as any other does.
					reportDispatchDiagnostic("record a held follower's start", error);
				}
			};
			if (attempt.followerWorker !== null) attempt.onFollowerStarted(attempt.followerWorker);
		} else publishStarted(worker);
	} catch (error) {
		// A capture started above would otherwise keep its manifest at "recording".
		if (envelope !== undefined) recordingJournal.terminal(envelope.id, "failed");
		try {
			worker.abort();
		} catch (abortError) {
			reportDispatchDiagnostic("abort orphaned worker after ledger failure", abortError);
		}
		await closeRunJournal();
		await launch.fail(error);
		throw error;
	}

	// Domain-owned ingestion starts here, whether or not any external
	// consumer ever iterates the returned stream: meters, tool stats, finish
	// contract state, permission audit events, and output capture fold in
	// the pump; consumers get a bounded replay tee. Events the worker
	// emitted before this point are still queued in the spawn channel.
	const routeWarnings = [
		...(lifecycle.target.routeWarning !== undefined ? [lifecycle.target.routeWarning] : []),
		...(lifecycle.target.resolutionWarnings ?? []),
	];
	const eventPump = startDispatchEventPump(workerEvents, foldWorkerEvent, {
		...(routeWarnings.length > 0
			? { prelude: routeWarnings.map((message) => ({ type: "route_warning", level: "warning", message })) }
			: {}),
		onEvent: (workerEvent) => {
			// A node worker words its missing-component remedy for its own machine.
			const event =
				placement?.node && placement.node.kind !== "local"
					? nodeComponentRemedyEvent(workerEvent, placement.node.id)
					: workerEvent;
			context.bus.emit("run.progressed", {
				runId: envelope.id,
				agentId: req.agentId,
				task: req.task,
				agentAudience: lifecycle.agentAudience,
				requestOrigin: lifecycle.requestOrigin,
				targetId: lifecycle.target.target.id,
				wireModelId: lifecycle.target.wireModelId,
				runtimeId: lifecycle.target.runtime.id,
				runtimeKind: lifecycle.runtimeKind,
				event,
			});
		},
		onError: (error) => {
			attempt.toolTelemetryIngestionErrors += 1;
			reportDispatchDiagnostic(`ingest events for run ${envelope.id}`, error);
		},
	});

	const startedAt = envelope.startedAt;

	const finalPromise = new Promise<RunResult>((res, rej) => {
		attempt.resolveFinal = res;
		attempt.rejectFinal = rej;
	});

	const activeRun: ActiveRun = {
		runId: envelope.id,
		req,
		abort: () => {
			attempt.callsAtAbort ??= [...inFlightCalls.values()];
			abort();
		},
		kill: abort,
		...(steer ? { steer } : {}),
		...(resolvePermission ? { resolvePermission } : {}),
		...(holdPermission ? { holdPermission } : {}),
		promise: workerDone.then(
			() => undefined,
			() => undefined,
		),
		recipe: lifecycle.recipe,
		permit: lifecycle.permit,
		...(preparation?.detached ? { detached: true } : {}),
		startedAt,
		timing,
		targetId: lifecycle.target.target.id,
		wireModelId: lifecycle.target.wireModelId,
		runtimeId: lifecycle.target.runtime.id,
		runtimeKind: lifecycle.runtimeKind,
		agentAudience: lifecycle.agentAudience,
		requestOrigin: lifecycle.requestOrigin,
		agentId: req.agentId,
		task: req.task,
		budget: lifecycle.budgetEnvelope,
		cwd: lifecycle.cwd,
		node: placement?.node ?? null,
		aborted: false,
		abortDetail: null,
		abortCause: null,
		stallKilled: false,
		stallTimeoutMs: null,
		budgetExempt: budgetExemptRoute(lifecycle.target.effectivePricing),
		lineage: attempt.lineage,
		...(hostRun === undefined ? {} : { hostRun }),
		heartbeatAt,
		heartbeatStatus: "alive",
		// A worker refuses a command it cannot sandbox unless admission allowed it to run unconfined.
		...(attempt.spec.sandbox !== undefined && attempt.spec.sandbox.unconfined !== true
			? { shellConfined: true as const }
			: {}),
		meter: tokenMeter,
		finalPromise,
	};

	const toolTelemetryCoverageOf = (
		ingestionErrors: number,
		unfinishedCount: number,
	): "complete" | "partial" | "unavailable" =>
		lifecycle.runtimeKind === "subprocess"
			? "unavailable"
			: ingestionErrors > 0 || unfinishedCount > 0
				? "partial"
				: "complete";
	const telemetryIngestionErrorsOf = (result: SpawnedWorkerResult): number =>
		attempt.toolTelemetryIngestionErrors +
		malformedWorkerStdoutLineCount(result) +
		(result.evidenceIncomplete !== undefined ? 1 : 0);
	attempt.envelope = envelope;
	attempt.runningRowPersisted = runningRowPersisted;
	attempt.identity = identity;
	return { eventPump, startedAt, finalPromise, activeRun, toolTelemetryCoverageOf, telemetryIngestionErrorsOf };
}
