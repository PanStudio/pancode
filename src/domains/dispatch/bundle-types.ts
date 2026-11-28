// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { SandboxAvailability } from "../../core/sandbox/types.js";
import type { DispatchRunIdentity } from "../../core/telemetry/live-events.js";
import type { AcpDelegationRunHandle, AcpDelegationRunInput } from "../../engine/acp/adapter.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import type { AskUserHandler } from "../../tools/ask-user.js";
import type { WorkerBudget, WorkerPromptMessage } from "../../worker/spec-contract.js";
import type { WorkerDecisionBinding } from "../../worker/stdin-demux.js";
import type { AgentRecipe } from "../agents/recipe.js";
import type { AgentAudience, AgentCapabilityClass } from "../agents/spec.js";
import type { ConfigContract } from "../config/contract.js";
import type { CapabilityGate } from "../middleware/capability-gate.js";
import type { QuotaProvider } from "../quota/types.js";
import type { GitHookDriftGuard } from "../safety/hook-drift.js";
import type { FlowRestrictionSet, WorkerFlowPolicyInput } from "../safety/information-flow.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import type { SafetyJudgeSeat } from "../safety/safety-judge.js";
import type { WorkerPermit } from "../safety/worker-permit.js";
import type { TelemetrySessionOrigin } from "../telemetry/session-journals.js";
import type { DispatchAdmissionStage } from "./admission-scope.js";
import type { WorktreeBootRecovery } from "./boot-recovery.js";
import type { RunToolBudgetEnvelope } from "./budget-envelope.js";
import type { CapabilityMismatch } from "./capability-match.js";
import type { AbortReason, DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import type { WorkerEnvelope } from "./envelope.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import type { RetryDecision } from "./failure-classification.js";
import type { FleetNodeSandbox } from "./fleet-preflight.js";
import type { HeartbeatSpec, HeartbeatStamp, HeartbeatStatus } from "./heartbeat.js";
import type { RunRole } from "./obligation.js";
import type { DispatchPathScope } from "./path-scope.js";
import type { FleetPlacementPreview } from "./placement.js";
import type { collectReproducibilityMetadata } from "./reproducibility.js";
import type { RouteObserver } from "./route-observer.js";
import type { ResolvedTarget } from "./target-resolution.js";
import type {
	DispatchRequestOrigin,
	RunBriefingProvenance,
	RunKind,
	RunLineage,
	RunNodeIdentity,
	RunNodeReroute,
	RunPersonaOverride,
	RunPhaseMarks,
	RunPipelineProvenance,
	RunProjectContextProvenance,
	RunResult,
} from "./types.js";
import type { RunTokenMeter } from "./worker-event-fold.js";
import type { WorkerExtensionHook, WorkerHookEffect, WorkerHookRequest, WorkerHookRun } from "./worker-protocol.js";
import type { SpawnedWorker, SpawnOptions as WorkerSpawnOptions, WorkerSpec } from "./worker-spawn.js";

export interface ActiveRun {
	runId: string;
	detached?: boolean;
	/** Original request, kept verbatim so a retry re-passes the full admission chain. */
	req: DispatchRequest;
	abort: () => void;
	/** Hard termination used by the reconciler; for native workers this is the SIGTERM→SIGKILL path. */
	kill: () => void;
	/**
	 * Send operator guidance to a live-input HTTP/SDK worker, or to an ACP peer
	 * that takes it as another prompt (agy). Returns false when the channel is
	 * gone. Absent for single-shot subprocess runs and other ACP peers.
	 */
	steer?: (text: string) => boolean;
	/**
	 * Apply a permission decision to a parked escalation by writing a
	 * `permission_decision` line to the worker's stdin. A live grant carries
	 * its binding (Phase D). Returns false when the channel is gone. Absent for
	 * run kinds without one (ACP).
	 */
	resolvePermission?: (
		requestId: string,
		decision: "approve" | "deny",
		binding?: WorkerDecisionBinding,
		cause?: "timeout",
	) => boolean;
	/** Renew a held ask past the worker's backstop. False unless the worker announced the hold frame and took the line. */
	holdPermission?: (requestId: string, holdMs: number) => boolean;
	promise: Promise<void>;
	recipe: AgentRecipe | null;
	/** The permit this attempt ran under; a retry inherits it as a cap. Absent for ACP delegation. */
	permit?: WorkerPermit;
	startedAt: string;
	timing: RunPhaseMarks;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	agentId: string;
	task: string;
	budget?: RunToolBudgetEnvelope;
	cwd: string;
	/** Fleet node this run was placed on; null when no placement resolved it. */
	node: RunNodeIdentity | null;
	aborted: boolean;
	/** Non-operator abort cause (e.g. a dispatch timeout); null for operator cancels. */
	abortDetail: string | null;
	/** Typed cause behind `abortDetail`; null for an operator cancel (#425). */
	abortCause: AbortReason["cause"] | null;
	/** Set by the reconciler before terminating a dead/stalled worker. */
	stallKilled: boolean;
	/**
	 * The worker is done and its receipt is being written. The terminal row
	 * patch waits for the receipt file (#428), so the heartbeat cannot use
	 * `endedAt` to tell this run from a live one and must skip it.
	 */
	sealing?: boolean;
	/** ACP event-inactivity window; null for native runs (heartbeat spec governs those). */
	stallTimeoutMs: number | null;
	/** An ACP peer's question is parked on the operator, so its silence is not a stall. */
	peerQuestionOpen?: () => boolean;
	/** Internal logical assignment/retry lineage, independent of published host ancestry. */
	lineage: RunLineage;
	hostRun?: DispatchPreparationOptions["hostRun"];
	heartbeatAt: HeartbeatStamp | null;
	heartbeatStatus: HeartbeatStatus;
	/** Set while the finalizer waits on the operator's merge card; the worker is gone, the orchestrator is the live party. */
	awaitingOperator?: boolean;
	/** Budget admission exempted the route (unpriced or zero-rate), so the session cost-ceiling stop leaves it running. */
	budgetExempt?: boolean;
	/** Set when every command the worker spawns runs in its OS sandbox or is refused (`workerRunShellConfined`). */
	shellConfined?: true;
	meter: RunTokenMeter;
	finalPromise: Promise<RunResult>;
}

export interface PendingCapacityAdmission {
	identity: DispatchRunIdentity & { requestOrigin: DispatchRequestOrigin };
	timing: RunPhaseMarks;
	node: RunNodeIdentity | null;
}

/** One resolved fleet placement: where the worker runs and how to launch it there. */
export interface DispatchNodePlacement {
	node: RunNodeIdentity;
	/** Transport launch; absent for local placements, which use the bundle's spawnWorker. */
	spawn?: (spec: WorkerSpec, opts?: WorkerSpawnOptions) => SpawnedWorker;
	/** Failover hops that preceded this placement, oldest first. */
	reroutes?: ReadonlyArray<RunNodeReroute>;
	/** An SSH node's recorded OS sandbox, null when it has none; absent for local placement. */
	sandbox?: FleetNodeSandbox | null;
}

export interface DispatchBundleOptions {
	getCapabilityGate?: () => CapabilityGate;
	spawnWorker?: (spec: WorkerSpec, opts?: WorkerSpawnOptions) => SpawnedWorker;
	/** Resolve the attested node and transport before capacity admission; absent means local. */
	resolveNode?: (req: DispatchRequest) => DispatchNodePlacement | null;
	/** Side-effect-free companion to resolveNode, primarily for alternate fleet backends and deterministic tests. */
	previewNode?: (req: DispatchRequest) => FleetPlacementPreview;
	startAcpDelegationRun?: (input: AcpDelegationRunInput) => AcpDelegationRunHandle;
	heartbeatSpec?: HeartbeatSpec;
	heartbeatIntervalMs?: number;
	resilienceCooldownMs?: number;
	now?: () => number;
	/** Monotonic clock for heartbeat age and ACP event-inactivity spans. */
	monotonicNow?: () => number;
	/** Immutable per-attempt session settings view; falls back to the shared snapshot. */
	getSettings?: () => EffectiveSettings;
	/**
	 * PanCode session this process dispatches for, read when a request enters
	 * `dispatch()` and stamped on its run rows and receipts. Absent (the fleet
	 * CLI, tests) means the process has no session and its rows belong to their
	 * project instead.
	 */
	getSessionId?: () => string | null;
	/**
	 * The live session's `parentSessionId`, set when it was forked. The rest of
	 * the chain is read from each ancestor's meta.json, so a fork inherits the
	 * uncollected batches and the runs of every session it descends from.
	 */
	getSessionParentId?: () => string | null;
	getSessionOrigin?: () => TelemetrySessionOrigin | null;
	/** Interactive sessions park paid routes until their session ceiling is raised. */
	budgetWaitForRaise?: boolean;
	/**
	 * The session's api 2 extension tool hooks, which a native worker cannot
	 * run itself. Each dispatched spec carries the declarations; each call
	 * they match comes back here and is answered with the hook's effects.
	 * Absent (the fleet CLI, a session with no extension host) means workers
	 * run unhooked, as before.
	 */
	workerHooks?: {
		declarations(): ReadonlyArray<WorkerExtensionHook>;
		/** Tool hooks past `WORKER_EXTENSION_HOOKS_MAX` that no worker spec carries. */
		dropped?(): ReadonlyArray<WorkerExtensionHook>;
		/** Never rejects: a hook that cannot run answers with its own failure policy. */
		evaluate(request: WorkerHookRequest, run: WorkerHookRun): Promise<ReadonlyArray<WorkerHookEffect>>;
		/** One operator line, where the session reports its extensions' issues. */
		notify?(message: string): void;
	};
	/**
	 * True only when this process shows worker permission escalations to an
	 * operator and answers them through resolveWorkerPermission (the interactive
	 * TUI). Absent or false makes an escalating worker apply its configured
	 * fallback at once instead of waiting out the timeout (F9).
	 */
	workerPermissionResponder?: boolean;
	/**
	 * The main session's safety judge and live autonomy, present only in the
	 * orchestrator. Under fleet.permissions.mode=judge it answers a native local
	 * worker's main-authority asks in this process; without it judge runs as deny.
	 */
	/**
	 * The operator's live autonomy level, an ACP session's mode included. Worker
	 * permits, ask routing and the never-wait rule of contained yolo read it;
	 * absent or undefined, they read default: it is the ceiling on every worker
	 * this process dispatches, and `safety.autonomy` in settings is not a grant.
	 */
	operatorAutonomy?(): AutonomyLevel | undefined;
	workerAskJudge?: {
		seat(): SafetyJudgeSeat | undefined;
		autonomy(): AutonomyLevel;
		/** The main session's git hook drift guard; a worker git call after drift goes to the operator. */
		hookDrift?(): Pick<GitHookDriftGuard, "check" | "accept"> | undefined;
	};
	/**
	 * False when nothing can steer a dispatched worker: a headless session, the
	 * fleet CLI, or `run --agent` without a steer channel. The worker prompt then
	 * leaves out the steering guidance it could never use. Absent means steerable.
	 */
	workerSteering?: boolean;
	/**
	 * The attached operator's ask surface: the interactive TUI, or an ACP client
	 * that advertised interviews. A merge-mode task worktree the gate would
	 * withhold is put to the operator as a merge card when `available()` is true.
	 * Absent in headless runs and in an ACP session without that capability, and
	 * those keep withholding.
	 */
	operatorAsk?: { available(): boolean; ask: AskUserHandler };
	/** Live hard-block state cloned into each mediated worker spec. */
	getProtectedArtifactState?: () => ProtectedArtifactState;
	/**
	 * The parent session's information-flow restrictions at dispatch time, or
	 * null. A worker inherits them with its context so its own model requests
	 * are judged against them; the worker's result returns under the same label.
	 */
	getFlowRestrictions?: () => FlowRestrictionSet | null;
	getFlowPolicy?: () => WorkerFlowPolicyInput;
	/** Git-backed receipt provenance collector; injectable for deterministic tests. */
	collectReproducibility?: typeof collectReproducibilityMetadata;
	/** Observer injection seam. Production constructs the durable observer. */
	routeObserver?: RouteObserver;
	/** Quota adapter injection seam for the budget view's pool. Production builds the registry's adapters. */
	quotaProviders?: () => ReadonlyArray<QuotaProvider>;
	/**
	 * Write the durable run event journal for every run this bundle dispatches.
	 * Off by default and turned on by the three composition roots
	 * (src/entry/orchestrator.ts, src/cli/run.ts, src/cli/fleet.ts), because the
	 * process that owns a bundle also decides who owns the journal file: a
	 * composed process routes `registerAllTools`' event registry to
	 * `journal: null` so a tool-path run is transcribed once, not twice.
	 */
	journalRunEvents?: boolean;
	/**
	 * Restart worktree recovery that boot starts after the first frame. The
	 * ledger scan and every admission wait for it; admission starts it if boot
	 * has not yet. Absent, start() scans the ledger itself before it returns.
	 */
	bootRecovery?: WorktreeBootRecovery;
}

/** A half-open route this dispatch was admitted to probe, keyed by its run id. */
export interface ProbeClaim {
	key: string;
	owner: string;
}

/** The next route a refused retry moves to, given the routes refused so far, or null when none is left. */
export type NextRetryRoute = (
	refused: ReadonlyArray<{ target: string; model: string }>,
) => { target: string; model: string; agentId?: string; node?: string } | null;

export type PeerPromptComposition = Pick<
	DispatchLifecycleStage,
	"dynamicPromptMessages" | "projectContext" | "compiledPromptHash" | "promptSignature" | "dynamicHash"
>;

export interface DispatchLifecycleStage {
	recipe: AgentRecipe | null;
	/** The run's role, resolved once; its handback share, its obligation and its worker spec all read it (M3). */
	runRole: RunRole;
	/** Bytes of the answer the parent sees, fixed at dispatch and told to the worker (M3). */
	answerBudgetBytes: number;
	pathScope: DispatchPathScope;
	admission: DispatchAdmissionStage;
	target: ResolvedTarget;
	cwd: string;
	systemPrompt: string;
	dynamicPromptMessages: ReadonlyArray<WorkerPromptMessage>;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	sessionShellHash: string | null;
	dynamicHash: string | null;
	promptSignature: string | null;
	toolSignature: string;
	apiKey: string | undefined;
	authProfile?: string;
	credentialExpiresAt?: number;
	runtimeKind: RunKind;
	agentAudience: AgentAudience;
	capabilityClass: AgentCapabilityClass;
	requestOrigin: DispatchRequestOrigin;
	runtimeLimitations: string[];
	pipeline: RunPipelineProvenance | null;
	briefing: RunBriefingProvenance | null;
	personaOverride: RunPersonaOverride | null;
	/** Decision refs sealed on the request by the dispatch tool; null when the parent board was empty. */
	decisionRefs: ReadonlyArray<string> | null;
	projectContext: RunProjectContextProvenance;
	/** The run's capability envelope, resolved once; everything after admission reads it (M7). */
	envelope: WorkerEnvelope;
	/** The OS sandbox availability resolved for the worker's placement. */
	placedSandbox: SandboxAvailability;
	/** What to write over a delegated harness's instruction files in the run's task worktree; absent without an overlay. */
	peerOverlay?: ReadonlyArray<{ file: string; content: string }>;
	/** The run's prompt with the rules in the message instead, for when the overlay cannot be written at spawn. */
	peerCoexist?: PeerPromptComposition;
	/** What the operator hears when the harness ends up reading its own files and some of their rules no longer hold. */
	peerStale?: { files: string[]; stale: number; message: string };
	/** Rule ids the worker prompt compiler selected into this run's system prompt; [] when none matched. */
	rulesApplied: string[];
	/** Whether the operator profile rendered non-empty content into this run's system prompt. */
	operatorProfileApplied: boolean;
	/** Read-only recipe admitted against a mutating task; null when the pairing was sound. */
	capabilityMismatch: CapabilityMismatch | null;
	readOnly: boolean;
	/** The immutable permit this attempt was admitted under. */
	permit: WorkerPermit;
	budget: WorkerBudget;
	budgetEnvelope: RunToolBudgetEnvelope;
	settings?: Readonly<ReturnType<ConfigContract["get"]>>;
}

/** Process-local retry queue keyed by finished run; backoff is keyed by member control root. */
export interface RetryQueueEntry {
	runId: string;
	agentId: string;
	task: string;
	attempt: number;
	dueAt: number;
	reason: string;
	excludedRouteParts: RetryDecision["excludedRouteParts"];
	rootRunId: string;
	terminalCandidate: RunResult;
	timer: ReturnType<typeof setTimeout>;
	settleCanceled: () => void;
}

export type RetryScheduleResult = { scheduled: true } | { scheduled: false; settlementDetail?: string };
