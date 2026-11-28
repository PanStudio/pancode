// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../../core/hash.js";
import type { SkillActivation } from "../../core/skill-activation.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { overlayTaskWorktree } from "../../tools/task-worktree-overlay.js";
import { WORKER_PERMISSION_HOLD_VERSION, type WorkerPermissionHoldFrame } from "../../worker/protocol.js";
import type { WorkerDecisionBinding } from "../../worker/stdin-demux.js";
import { INTERNAL_HELPER_RESULT_KINDS, validateStructuredHelperResult } from "../agents/result-contract.js";
import { nodeResultContractFilesystem } from "../agents/result-contract-filesystem.js";
import { mergeFlowRestrictions } from "../safety/information-flow.js";
import { createRunEffectsRecorder } from "../safety/run-effects.js";
import { telemetryRunDirectory } from "../telemetry/index.js";
import { workerHasNetworkPosture } from "./admission-scope.js";
import type { PreparedAttempt } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { DispatchPrefixGroup } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { createWorkerOutputCapture, workerOutputCaptureBytes } from "./event-pump.js";
import { dispatchResultContract } from "./execution-role.js";
import { prepareFleetChangeReturn } from "./fleet-change-return.js";
import {
	claimSharedPrefix,
	claimWorkerCacheLane,
	startAfterPrefixHold,
	waitForPrefixLeader,
} from "./prefix-stagger.js";
import { openRunTelemetry } from "./run-telemetry.js";
import type { InFlightCall, ToolFinishPayload } from "./tool-stats.js";
import {
	type RunOutcomeCode,
	type RunResultUpstreamResponse,
	type RunSteeringProvenance,
	runKindSupportsLiveSteering,
	type ToolCallStat,
} from "./types.js";
import { sharedPrefixSignature } from "./worker-dynamic-prompt.js";
import type { VerifyCallLog } from "./worker-event-fold.js";
import type { SpawnedWorker } from "./worker-spawn.js";

export async function spawnAttemptWorker(rt: DispatchRuntime, attempt: PreparedAttempt) {
	const { context } = rt;
	const { monotonicNow, now, spawnWorker } = rt.core;
	let checkoutBaseline = attempt.checkoutBaseline;
	let worker: SpawnedWorker;
	let heldFollower = attempt.heldFollower;
	let prefixLeader: DispatchPrefixGroup | undefined;
	const {
		agentLedgerId,
		buildSpec,
		checkoutBaselineTaken,
		closeRunJournal,
		endpoint,
		grantAttempt,
		launch,
		lifecycle,
		narrowPermitToLiveLevel,
		onGrantRequest,
		onHookRequest,
		onLedgerPost,
		onModelLoaded,
		placement,
		preparation,
		remoteReturn,
		req,
		restorePeerOverlay,
		timing,
	} = attempt;

	try {
		if (attempt.spec.telemetryContext) {
			try {
				attempt.runJournal = await openRunTelemetry(
					attempt.spec.telemetryContext,
					telemetryRunDirectory(pancodeStateDir(), attempt.spec.telemetryContext.runId),
				);
				if (req.ownerSessionId && req.ownerSessionCwdHash) {
					attempt.parentJournal = await context
						.getContract("telemetry")
						?.acquireTelemetrySession?.(
							{ id: req.ownerSessionId, cwdHash: req.ownerSessionCwdHash },
							attempt.spec.telemetryContext.agent,
						);
					if (attempt.parentJournal) attempt.runJournal.linkSession(attempt.parentJournal.context);
				}
			} catch (error) {
				reportDispatchDiagnostic("open run telemetry journal", error);
			}
		}
		if (checkoutBaselineTaken !== null) checkoutBaseline = await checkoutBaselineTaken;
		preparation?.signal?.throwIfAborted();
		const spawnOptions = {
			cwd: lifecycle.cwd,
			now,
			monotonicNow,
			onModelLoaded,
			onChannelFailure: (fact: EventPayload<"worker.channel_failed">) => attempt.runJournal?.channel(fact),
			...(agentLedgerId !== null ? { onLedgerPost } : {}),
			...(grantAttempt !== undefined ? { onGrantRequest } : {}),
			...(attempt.spec.extensionHooks !== undefined ? { onHookRequest } : {}),
		};
		const prefixClaim = claimSharedPrefix(
			preparation?.prefixGroups,
			lifecycle.runtimeKind === "http" && lifecycle.promptSignature !== null && req.runIdHint !== undefined
				? sha256Hex(
						JSON.stringify([
							lifecycle.target.target.id,
							lifecycle.target.runtime.id,
							endpoint?.key ?? null,
							lifecycle.target.wireModelId,
							lifecycle.toolSignature,
							sharedPrefixSignature(lifecycle.systemPrompt, lifecycle.dynamicPromptMessages, req),
						]),
					)
				: null,
			req.runIdHint ?? "",
		);
		if (prefixClaim?.role === "leader") prefixLeader = prefixClaim.group;
		if (remoteReturn) await prepareFleetChangeReturn(remoteReturn.node, remoteReturn.worktree);
		preparation?.signal?.throwIfAborted();
		const spawnNow = (): SpawnedWorker => {
			// Nothing waits between here and spawn: the worker launches at the dispatcher's level now.
			if (narrowPermitToLiveLevel()) attempt.spec = buildSpec();
			if (lifecycle.peerOverlay !== undefined && lifecycle.peerCoexist !== undefined && req.taskWorktree !== undefined) {
				try {
					if (placement !== null && placement.node.kind !== "local") throw new Error("the worktree is on another node");
					attempt.peerOverlay = overlayTaskWorktree(req.taskWorktree, lifecycle.peerOverlay);
				} catch (error) {
					// The harness reads its own files after all, so the rules go in the message and the record says coexist.
					Object.assign(lifecycle, lifecycle.peerCoexist);
					attempt.spec = buildSpec();
					reportDispatchDiagnostic(`write peer instructions in task worktree ${req.taskWorktree.runId}`, error);
				}
			}
			// Each live worker of one head takes its own provider session id on its capacity lease, so every process on this
			// state dir sees it; the lane frees with the lease (FL-17, M-11).
			// The head is the system prompt and tool surface alone: the prompt signature also covers each run's task.
			const lane =
				lifecycle.runtimeKind === "http" && lifecycle.systemPrompt.length > 0
					? claimWorkerCacheLane(
							launch.lease.leaseId,
							sha256Hex(
								JSON.stringify([
									lifecycle.target.target.id,
									lifecycle.target.wireModelId,
									lifecycle.toolSignature,
									lifecycle.systemPrompt,
								]),
							),
						)
					: null;
			if (lane === null) return (placement?.spawn ?? spawnWorker)(attempt.spec, spawnOptions);
			try {
				const started = (placement?.spawn ?? spawnWorker)({ ...attempt.spec, cacheLane: lane.lane }, spawnOptions);
				void started.promise.then(lane.release, lane.release);
				return started;
			} catch (error) {
				lane.release();
				throw error;
			}
		};
		if (prefixClaim?.role === "follower") {
			// The handle returns now; only the worker's start waits for the leader, so a slow leader holds no caller.
			const group = prefixClaim.group;
			heldFollower = true;
			worker = startAfterPrefixHold(
				async (signal) => {
					const hold = await waitForPrefixLeader(group, {
						signal: preparation?.signal ? AbortSignal.any([signal, preparation.signal]) : signal,
					});
					if (hold?.role !== "follower") return;
					timing.prefixHoldMs = hold.heldMs;
					timing.prefixLeaderRunId = hold.leaderRunId;
				},
				() => {
					if (
						rt.control.canceledControlRoots.has(
							rt.control.controlRootsByAttempt.get(req.runIdHint ?? "") ?? launch.lease.assignmentId,
						) ||
						preparation?.signal?.aborted === true
					)
						return null;
					const started = spawnNow();
					timing.workerSpawnedAt = new Date(now()).toISOString();
					return started;
				},
				{ now, monotonicNow },
				// Until the worker exists this process vouches for the run, as it does behind a merge card, so another
				// PanCode on this state directory does not recover a held follower as abandoned.
				process.pid,
				(started) => {
					attempt.followerWorker = started;
					attempt.onFollowerStarted?.(started);
				},
			);
		} else worker = spawnNow();
	} catch (error) {
		attempt.modelRoute?.close();
		restorePeerOverlay();
		prefixLeader?.release();
		await closeRunJournal();
		await launch.fail(error);
		throw error;
	}
	if (!heldFollower) timing.workerSpawnedAt = new Date(now()).toISOString();
	const { modelRoute } = attempt;
	if (modelRoute !== null) {
		const closeRoute = (): void => modelRoute.close();
		void worker.promise.then(closeRoute, closeRoute);
	}
	// The wall clock and a call's timeout_ms can both stop a run; its worker is stopped once (fleet M8).
	let workerAborted = false;
	const abort = (): void => {
		if (workerAborted) return;
		workerAborted = true;
		worker.abort();
	};
	const sendToWorker = worker.send?.bind(worker);
	attempt.sendToWorker = sendToWorker;
	attempt.answerHook = sendToWorker;
	const steeringProvenance: RunSteeringProvenance[] = [];
	let steeringProvenanceClosed = false;
	const steer =
		sendToWorker && runKindSupportsLiveSteering(lifecycle.runtimeKind)
			? (text: string): boolean => {
					if (steeringProvenanceClosed) return false;
					const canonicalText = text.trim();
					const sequence = steeringProvenance.length + 1;
					if (canonicalText.length === 0 || !sendToWorker({ type: "steer", text: canonicalText, sequence })) return false;
					steeringProvenance.push({
						sequence,
						bytes: Buffer.byteLength(canonicalText, "utf8"),
						contentHash: sha256Hex(canonicalText),
						sentAt: new Date().toISOString(),
						acknowledged: false,
					});
					return true;
				}
			: undefined;
	const acknowledgeSteer = (sequence: unknown): void => {
		if (steeringProvenanceClosed) return;
		if (!Number.isSafeInteger(sequence) || Number(sequence) <= 0) return;
		const pending = steeringProvenance.find((entry) => entry.sequence === sequence && !entry.acknowledged);
		if (pending === undefined) return;
		pending.acknowledged = true;
		pending.acknowledgedAt = new Date().toISOString();
	};
	const snapshotSteeringProvenance = (): ReadonlyArray<RunSteeringProvenance> => {
		steeringProvenanceClosed = true;
		return steeringProvenance.map((entry) => ({ ...entry }));
	};
	const resolvePermission = sendToWorker
		? (requestId: string, decision: "approve" | "deny", binding?: WorkerDecisionBinding, cause?: "timeout") =>
				sendToWorker({
					type: "permission_decision",
					requestId,
					decision,
					...(binding !== undefined ? { binding } : {}),
					...(cause !== undefined ? { cause } : {}),
				})
		: undefined;
	// Only a worker that announced this frame version is sent one: an older one drops the line, and its backstop
	// would then deny a hold this process believes it extended.
	const holdPermission = sendToWorker
		? (requestId: string, holdMs: number): boolean => {
				if (worker.attestation?.()?.permissionHold !== WORKER_PERMISSION_HOLD_VERSION) return false;
				const frame: WorkerPermissionHoldFrame = {
					type: "permission_hold",
					version: WORKER_PERMISSION_HOLD_VERSION,
					requestId,
					holdMs: Math.ceil(holdMs),
				};
				return sendToWorker(frame);
			}
		: undefined;
	const heartbeatAt = worker.heartbeatAt;
	const workerEvents = worker.events;
	// Put the harness's files back before anything reads the worktree's change. A held follower writes its overlay
	// only when it starts, after this line, so the restore is always chained; without an overlay it does nothing.
	const workerDone = worker.promise.finally(restorePeerOverlay);
	if (prefixLeader) {
		const release = prefixLeader.release;
		workerDone.then(release, release);
	}

	const toolStats = new Map<string, ToolCallStat>();
	const inFlightTools = new Map<string, number>();
	// The calls in flight by id, and the ones the host saw running when its abort started: the abort finishes them
	// before the seal, so the stop detail reads this snapshot (M-37).
	const inFlightCalls = new Map<string, InFlightCall>();
	attempt.callsAtAbort = null;
	attempt.toolTelemetryIngestionErrors = 0;
	const upstreamResponses: RunResultUpstreamResponse[] = [];
	const skillActivations: SkillActivation[] = [];
	const finishContractEntries: unknown[] = [];
	const verifyCalls: VerifyCallLog = { pending: new Map(), calls: [] };
	const pendingCapabilities = new Map<string, string>();
	// The calls that reached a PanCode tool. A native call the engine refused before that, such as one whose arguments
	// failed the tool's schema, ends in error without a PanCode start or finish, and still counts as an errored call.
	const reachedTool = new Set<string>();
	// A producer without call ids cannot tie a start to its end, so such a stream counts only its PanCode finishes.
	attempt.startsCarryIds = true;
	// The calls of a reply the output token limit cut off. The engine fails each without running it, so they are
	// neither refused nor errored and toolStats leaves them out.
	const outputLimitCalls = new Set<string>();
	// A gateway wrapper's finish waits for its result: a chain's settled steps count as the calls they are, so the
	// wrapper counts only when none settled. Counting both made an N-step chain N + 1 calls (bt-14).
	const gatewayFinishes = new Map<string, ToolFinishPayload>();
	attempt.runIdForPermissionAudit = null;
	// The worker's own tool calls, folded into what this run changed and what
	// it validated. The sealed mutation-report contract is measured against
	// this, so a reported path the run never touched cannot seal as fact.
	const runEffects = createRunEffectsRecorder(lifecycle.cwd, {
		scratchRoots: lifecycle.settings?.safety.scratchRoots ?? [],
		onWriteRecordDowngraded(downgrade) {
			const runId = attempt.runIdForPermissionAudit;
			if (runId === null) return;
			context.bus.emit("run.progressed", {
				runId,
				agentId: req.agentId,
				event: { type: "pancode_write_record_partial", payload: downgrade },
			});
		},
	});
	attempt.finishContractAssistantText = "";
	attempt.finishContractAssistantTurnId = null;

	attempt.permissionDenialDetail = null;
	// The worker hit its execute refusal limit, then whether its one report reply arrived.
	attempt.refusalLimit = null;
	attempt.providerErrorMessage = null;

	attempt.outcomeCode = null;
	const trustedOutcomeCodes = new Set<RunOutcomeCode>();
	// The native worker's own repair-round count; it stays unreported for every other runtime (C-28).

	const trustedOutcomeDetails = new Map<RunOutcomeCode, string>();
	// What the run's context carries: the inherited set, grown by the worker's
	// own restricted reads as it reports them. Only a mediated runtime's
	// report is believed; the inherited part is the host's own fact.
	attempt.trustedFlow = mergeFlowRestrictions(
		attempt.spec.flowRestrictions,
		// External runtimes cannot report each restricted read. Their final
		// output conservatively carries every source rule admitted for them.
		lifecycle.runtimeKind === "http" || attempt.spec.flowPolicy === undefined
			? null
			: {
					version: 1,
					restrictions: attempt.spec.flowPolicy.rules.map((rule) => ({
						ruleId: rule.id,
						policyHash: rule.policyHash,
						sourceRef: `runtime:${lifecycle.target.runtime.id}`,
						recipients: rule.recipients,
					})),
				},
	);
	attempt.reportedUntrustedOutcome = false;
	const acceptsOutcomeCodeEvents =
		lifecycle.runtimeKind === "http" || (lifecycle.runtimeKind === "sdk" && lifecycle.target.runtime.id === "claude-sdk");
	attempt.workerPolicyPermissionCounter = 0;
	// The bound the receipt can seal follows the contract this run will be
	// validated against; a conforming result never arrives clipped.
	const helperContract = dispatchResultContract(req, lifecycle.recipe);
	const outputCapture = createWorkerOutputCapture({
		maxBytes: workerOutputCaptureBytes(helperContract),
		...(attempt.spec.helperResult === true &&
		acceptsOutcomeCodeEvents &&
		(helperContract?.kind === "mutation-report" ||
			lifecycle.agentAudience === "shadow" ||
			lifecycle.agentAudience === "internal") &&
		helperContract &&
		(INTERNAL_HELPER_RESULT_KINDS as readonly string[]).includes(helperContract.kind)
			? {
					helperResult: {
						contract: helperContract,
						validate: (data: unknown) =>
							validateStructuredHelperResult({
								contract: helperContract,
								data,
								cwd: lifecycle.cwd,
								networkAllowed: workerHasNetworkPosture(lifecycle.admission),
								observedRunEffects: runEffects.snapshot(),
								filesystem: nodeResultContractFilesystem(),
							}).structured,
					},
				}
			: {}),
	});
	attempt.checkoutBaseline = checkoutBaseline;
	attempt.worker = worker;
	attempt.heldFollower = heldFollower;
	attempt.prefixLeader = prefixLeader;
	return {
		abort,
		steer,
		acknowledgeSteer,
		snapshotSteeringProvenance,
		resolvePermission,
		holdPermission,
		heartbeatAt,
		workerEvents,
		workerDone,
		toolStats,
		inFlightTools,
		inFlightCalls,
		upstreamResponses,
		skillActivations,
		finishContractEntries,
		verifyCalls,
		pendingCapabilities,
		reachedTool,
		outputLimitCalls,
		gatewayFinishes,
		runEffects,
		trustedOutcomeCodes,
		trustedOutcomeDetails,
		acceptsOutcomeCodeEvents,
		outputCapture,
	};
}
