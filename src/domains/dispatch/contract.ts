// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { FactSum } from "../../core/telemetry/fact.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { PricingSum } from "../../core/telemetry/pricing.js";
import type { QuotaAccess, QuotaOverage, RunUsageFacts } from "../../core/telemetry/schemas.js";
import type { DeclaredCheckKind, GrantExecution } from "../../core/telemetry/session-vocabulary.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import type { NumericTolerance } from "../../tools/verify/numeric.js";
import type { PerfBudgetSpec } from "../../tools/verify/perf.js";
import type { DeclaredReproduce } from "../../tools/verify/reproduce.js";
import type { ResultContract } from "../agents/result-contract-types.js";
import type { AgentAutomationAuthority, AgentSpec, AgentTrait } from "../agents/spec.js";
import type { WorkerContextSeed } from "../context/worker/contract.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { ApprovalAuthority } from "../safety/admission.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import type {
	WorkerMcpAttestation,
	WorkerPermissionDeclaration,
	WorkerPermit,
	WorkerPermitAllowance,
} from "../safety/worker-permit.js";
import type { AssignmentId, DispatchAssignment } from "./assignment.js";
import type { DurableAssignmentRecord } from "./assignment-store.js";
import type { DetachedBatchRecord, RegisterDetachedBatchInput } from "./batch-store.js";
import type { RunToolBudgetEnvelope } from "./budget-envelope.js";
import type { DispatchResultSummaryAllowance, ExecutionRole } from "./execution-role.js";
import type { GrantState } from "./grant-broker.js";
import type { DispatchOwner } from "./ownership.js";
import type { DispatchReservationRecord, ReservationTopology } from "./reservation-store.js";
import type { ApprovedAssignmentRoute } from "./route-approval.js";
import type { RouteDecisionV1 } from "./route-decision.js";
import type { RouteCandidateForecast } from "./route-policy.js";
import type { BreakerState } from "./target-breaker.js";
import type { DispatchRequestOrigin, RunEnvelope, RunLineage, RunNodeIdentity, RunResult, RunStatus } from "./types.js";
import type { DispatchFailoverCandidate, JobSpec } from "./validation.js";
import type { WorkerApprovalWindowView } from "./worker-approval-window.js";
import type { WriteBoundaryAttribution } from "./write-boundary.js";

export interface ResolvedVerificationCheck {
	check: string;
	argv: ReadonlyArray<string>;
	cwd: string;
	timeoutMs: number;
	/** Absent means `command`, the exit-code check. */
	kind?: DeclaredCheckKind;
	/**
	 * Sealed at admission with the reference as an absolute path and the sha256 of its text then; null when it was
	 * absent. Host verification fails the check when the reference no longer matches.
	 * `inputs` are the declared input files as absolute paths, hashed before the run and after it; `provenance`
	 * holds the declared probes. `seed` is passed to every run, and `repeat` is the run count. Each is absent when the
	 * catalog declared none.
	 */
	numeric?: {
		reference: string;
		tolerance: NumericTolerance;
		referenceSha256: string | null;
		inputs?: string[];
		provenance?: string[][];
		seed?: { env: string; value: string };
		repeat?: number;
	};
	/** Sealed at admission with the baseline as an absolute path and its digest, as `numeric` seals its reference. */
	perf?: {
		budget?: PerfBudgetSpec;
		tolerance?: { relative?: number };
	} & ({ baseline: string; baselineSha256: string | null } | { baseline?: never; baselineSha256?: never });
	/**
	 * Sealed at admission with paths kept repository-relative and the declared
	 * cwd beside them, so host verification derives the root from `cwd` and
	 * judges the inputs, digests and reference the catalog declared. A
	 * `compare: {reference}` check also seals the reference's digest, as
	 * `numeric` does; absent for `compare: twice`.
	 */
	reproduce?:
		| {
				spec: DeclaredReproduce & { compare: { mode: "reference" } };
				declaredCwd: string;
				referenceSha256: string | null;
		  }
		| { spec: DeclaredReproduce & { compare: { mode: "twice" } }; declaredCwd: string; referenceSha256?: never };
}

export interface DispatchRequest extends JobSpec {
	/** Canonical outside Scout workspace, derived by admission rather than model-authored (#433). */
	externalReadRoot?: string;
	/**
	 * Canonical directories outside the workspace the worker may read and never write, from absolute
	 * `intent.read_roots`.
	 */
	extraReadRoots?: string[];
	/** One-shot host approval; validation strips it from model-authored job fields (#433). */
	externalReadApproval?: { root: string; requestId: string; requestedBy: string; runId: string };
	/** Opt-in bounded redacted display-event asciicast; never a PTY around worker NDJSON. */
	record?: boolean;
	/** Generated context needs stable local sampling across identical runs. */
	sampling?: "deterministic";
	/**
	 * Bytes of this run's answer the parent sees, fixed by the tool for the whole batch at dispatch (M3). Absent means a
	 * lone run's budget. Never model-authored.
	 */
	answerBudgetBytes?: number;
	/** Epoch ms when exploration ends and the worker must take its terminal round. */
	synthesisAt?: number;
	/** Inherited host policy, outside the model-authored JobSpec. */
	turnConstraints?: TurnConstraints;
	/** Host-captured conversation seed; never accepted from model arguments. */
	contextSeed?: WorkerContextSeed;
	/** Coordinator-owned result contract override for a fleet plan step. */
	resultContractOverride?: ResultContract;
	/** Inline-summary allowance for a mutation-report worker, range-checked at the tool boundary. */
	resultSummary?: DispatchResultSummaryAllowance;
	/** Orchestrator-prepared task worktree state. Model arguments cannot author it. */
	taskWorktree?: {
		root: string;
		runId: string;
		path: string;
		/** Directory the working tree was created in; absent means the project-root location. */
		parent?: string;
		branch: string;
		base: string;
		ownerToken: string;
	};
	/**
	 * A compete candidate's own checkout, the checkout it was cut from, and the commit it started at. Host verification
	 * compares a candidate's failing check against that base, as it does a task worktree's. Set by compete only; never
	 * model-authored.
	 */
	candidateWorktree?: { root: string; path: string; base: string };
	/** Run identity allocated before task worktree creation. Model arguments cannot author it. */
	runIdHint?: string;
	/**
	 * Host-requested permit narrowing; wider than the recipe and settings allow is an admission error. Never model-
	 * authored.
	 */
	permitNarrowing?: WorkerPermissionDeclaration;
	/** The retried attempt's permit allowance, which caps this attempt. Set by retry scheduling only. */
	inheritedPermitAllowance?: WorkerPermitAllowance;
	/** Parent checkout frozen by plan approval for task worktree application. */
	taskWorktreeDestination?: string;
	/**
	 * Admission-resolved checks, so host verification runs exactly what the catalog declared. Model text never enters
	 * argv.
	 */
	resolvedVerification?: ReadonlyArray<ResolvedVerificationCheck>;
	/**
	 * Role of the first attempt, derived once by `execution-role.ts` and never inferred later, because it separates
	 * builder, gate, reconnaissance and recovery route statistics. Never model-authored.
	 */
	executionRole: ExecutionRole;
	/** Concrete baseline plus trusted auto authority; the literal id "auto" never crosses this boundary. */
	agentSelection?: {
		version: 1;
		mode: "auto";
		baselineAgentId: string;
		approvedAuthorities: ReadonlyArray<AgentAutomationAuthority>;
		authorityBasis: "operator-plan-approval" | "yolo-policy" | "harness-read-only";
	};
	systemPrompt?: string;
	/** Trusted side-store lease reference; never serialized into a worker spec or receipt. */
	reservation?: { ownerId: string; memberId: string };
	/** Registry-authenticated active approval; never accepted from model JSON. */
	routeApproval?: ApprovedAssignmentRoute;
	/** Resolver-authored active decision for this approved recovery attempt. */
	routeAttemptDecision?: ApprovedAssignmentRoute["decision"];
	/** The agent ledger concurrent peers coordinate on; absent, the ledger tool is stripped from the run. */
	ledger?: { id: string; sequence: number };
	/**
	 * Absolute root-assignment deadline, preserved through retries. Every dispatched run gets one from its wall clock
	 * (`fleet.limits.runTimeoutMs`, DESIGN 4.5), lowered by an explicit deadline or the call's timeout_ms.
	 */
	assignmentDeadlineAt?: number;
	/** The run's wall clock in ms, stamped by dispatch beside `assignmentDeadlineAt`; never model-authored. */
	runWallMs?: number;
	/**
	 * The dispatch tool call that built this request, republished on DispatchStarted so a transcript nests the worker
	 * under it. Not in JobSpec, so model JSON cannot claim parentage of a call it did not make.
	 */
	parentToolCallId?: string;
	/**
	 * Decision refs (`<interviewId>/<key>`) active on the parent's decision board, sealed by the orchestrator and
	 * copied to the envelope and receipt so a receipt names the decisions it worked under. Never model-authored.
	 */
	decisionRefs?: ReadonlyArray<string>;
	/**
	 * Session the run belongs to, stamped on first entry to `dispatch()` and kept by retries, so an attempt after a
	 * session switch still belongs to the session that asked. Never model-authored.
	 */
	ownerSessionId?: string | null;
	/** Original session directory identity, captured with its id and retained by retries (#434). */
	ownerSessionCwdHash?: string;
	/**
	 * Whether the caller can yield to the main agent for a worker's live-grant ask (Phase D); absent outside the
	 * dispatch tool.
	 */
	mainGrantRoute?: { kind: "yield" } | { kind: "refused"; reason: string };
	/**
	 * The arguments named no target, model or node and no approval sealed the route, so admission chooses it. Set only
	 * by the argument parser and dropped under an authenticated approval; absent means pinned.
	 */
	routeFree?: true;
}

/**
 * A worker ask routed to the main agent: a bounded preview; the broker keeps the effect descriptor and attempt binding.
 */
export interface WorkerGrantView {
	requestId: string;
	runId: string;
	rootRunId: string;
	attempt: number;
	agentId: string;
	tool: string;
	actionClass: string;
	approvalAuthority: ApprovalAuthority;
	state: GrantState;
	execution: GrantExecution;
	issuer?: "main" | "operator";
	summary: string;
	target?: string;
	reasons: ReadonlyArray<string>;
	createdAt: string;
	deadlineAt: string;
	reason?: string;
	forwardedByMain?: true;
	/** The main session's safety judge decides this request; the main agent does not. */
	reviewer?: "safety-judge";
}

export type MainGrantOutcome =
	| {
			ok: true;
			view: WorkerGrantView;
			decision: "approved" | "denied";
			/** Who decided: the main agent itself, or the operator it asked. */
			decidedBy: "main" | "operator";
			message: string;
	  }
	| { ok: false; message: string; view?: WorkerGrantView };

export interface MainGrantDecisionInput {
	requestId: string;
	/** Run or assignment id the model named; must match the record. */
	runId: string;
	decision: "approve" | "deny";
	/** The deciding main agent's session; a request from another session fails. */
	sessionId: string | null;
	/** The main agent's effective autonomy, as admission runs it: contained yolo reads as default. */
	autonomy: AutonomyLevel;
	/** The operator's own level, so a refusal names contained yolo; it never decides. */
	operatorAutonomy?: AutonomyLevel;
	/** The main turn's host constraints; the delegation ceiling is `delegatedTools ?? allowedTools`. */
	turnConstraints?: TurnConstraints;
	signal?: AbortSignal;
}

/** Live main-agent grants for native worker asks (Phase D). */
export interface WorkerGrantsContract {
	list(filter?: { sessionId?: string | null; runId?: string; pendingOnly?: boolean }): ReadonlyArray<WorkerGrantView>;
	get(requestId: string): WorkerGrantView | null;
	/**
	 * Deny always settles. Approve is the main agent's own call at yolo, else asks the operator, or headless denies
	 * (grant-authority.ts).
	 */
	decideAsMain(input: MainGrantDecisionInput): Promise<MainGrantOutcome>;
	/** Called when a worker parks a main-authority ask; returns the unsubscribe handle. */
	onPending(listener: (view: WorkerGrantView) => void): () => void;
}

/** Internal, non-serializable admission hook for transactional resource owners. */
export interface DispatchAdmissionObserver {
	onAdmitted(run: { runId: string; pid: number | null; runtimeKind: RunEnvelope["runtimeKind"] }): void;
}

/** One shared-prefix group of a batch; its later runs hold until the leader's first token. */
export interface DispatchPrefixGroup {
	readonly leaderRunId: string;
	readonly released: Promise<void>;
	release(): void;
	isReleased(): boolean;
}

/** Invocation-owned admission bounds; never serialized into model-authored requests. */
export interface DispatchPreparationOptions {
	turnConstraints?: TurnConstraints;
	/** #425: a detached invocation owns its pending grants even before its batch record is durable. */
	detached?: boolean;
	/** Host ancestry for publication; kept separate from logical assignment/retry identity. */
	hostRun?: { readonly runId: string; readonly lineage: Readonly<RunLineage> };
	signal?: AbortSignal;
	deadlineAt?: number;
	/** A parallel batch's shared-prefix groups, keyed by prefix; absent outside a staggered batch. */
	prefixGroups?: Map<string, DispatchPrefixGroup>;
}

/** Side-effect-free effective routing used to construct a dispatch approval artifact. */
export interface DispatchPlanTaskResolution {
	agentId: string;
	/** Stable identity of the recipe surface this route would execute. */
	specFingerprint: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	/** Canonical inference scheduler identity and its independent request-slot bound. */
	endpoint?: { key: string; label: string; limit: number };
	node: RunNodeIdentity;
	/** Effective thinking control for this route; null when the runtime has none. */
	thinkingLevel: string | null;
	/** Effective tool surface after the runtime narrows it; part of route identity. */
	toolSignature: string;
	endpointIdentityHash: string;
	settingsFingerprint: string;
	/** Conservative effective-pricing estimate; unknown pricing is never zero. */
	costUpperBoundUsd: number;
	/** False when the numeric estimate is only the unknown-pricing admission sentinel. */
	costUpperBoundKnown: boolean;
	/** Required plan projection: null means this task remains shadow/fixed. */
	routeApproval: ApprovedAssignmentRoute | null;
	/** Admission parts only the run can settle, named on the plan card instead of passing silently. */
	checkedAtRun?: ReadonlyArray<string>;
	/**
	 * The bounds that stop this run, as the plan card states them: cost estimate or, unpriced, the timers and tool
	 * ceiling it has.
	 */
	limits?: string;
	/**
	 * Where the run writes, from its envelope (M7): read-only, roots, its own worktree and what merges back, or
	 * workspace.
	 */
	writes?: string;
	/** Which setting chose this route (`fleet default`, a fleet profile, a target named in the call). */
	route?: string;
	/** One line per capability the run's envelope withheld, with why and what would keep it (M7). */
	withheld?: ReadonlyArray<string>;
	/**
	 * Each candidate's forecast as data (R4), the route that runs first: the router's own readiness window read beside
	 * its ranking, never instead of it. Bounded, `omitted` counting the candidates past the bound; absent when the route
	 * universe could not be enumerated.
	 */
	forecasts?: { candidates: ReadonlyArray<RouteCandidateForecast>; omitted: number };
}

/**
 * Capabilities admission derives beyond a request's fields. A narrower write scope can switch an MCP server's network
 * grant on, so whether two requests grant the same authority is judged on these, not the arguments (WX4).
 */
export interface DispatchDerivedGrants {
	requestedActions: ReadonlyArray<ActionClass>;
	/** The MCP attestation after servers whose code the run can write lose their network grant. */
	mcp: WorkerMcpAttestation | null;
	permit: WorkerPermit;
}

export interface DispatchAgentPlanResolution {
	resolution: DispatchPlanTaskResolution;
	decision: RouteDecisionV1;
	agentSpec: AgentSpec;
}

export interface DispatchAgentPlanInput {
	request: DispatchRequest;
	expectedResultContract: ResultContract["kind"];
	requestedAuthority: AgentAutomationAuthority;
	authorization: "operator-plan-approval" | "yolo-policy" | "harness-read-only";
}

/** Operator snapshot from in-memory state and the ledger mirror; no I/O, never needed for correctness. */
export interface DispatchSnapshot {
	generatedAt: string;
	running: Array<{
		runId: string;
		agentId: string;
		task?: string;
		runtimeKind: string;
		outcomePhase: string;
		heartbeat: "alive" | "stale" | "dead" | "n/a";
		lineage: RunLineage;
		budget?: RunToolBudgetEnvelope;
		startedAt: string;
		/** Execution-only elapsed time retained for runtime monitoring. */
		elapsedMs: number;
		/** The run's spend so far, as its call telemetry folds it; unknown until the first frame arrives (#434). */
		spend: RunUsageFacts;
		/** Fleet node this run was placed on; null means the local node. */
		node: RunNodeIdentity | null;
	}>;
	retrying: Array<{ runId: string; agentId: string; task?: string; attempt: number; dueAt: string; reason: string }>;
	/** Finalized and running runs together, one contribution per run. */
	totals: { tokens: FactSum; cost: PricingSum; runtimeSeconds: number };
}

/**
 * Why a run is aborted, so its receipt names the real cause rather than "operator abort"; absent means an operator
 * cancel. `timeout`: dispatch `timeout_ms`. `operator`: a cancel from another process (`fleet cancel`). `capacity`:
 * a renewal found the lease gone. `parent`: the dispatching tool call was canceled (#425). `steer`: the dispatching
 * session asked, so a headless run does not count it undelivered (ns:61).
 */
export interface AbortReason {
	cause: "timeout" | "operator" | "budget" | "capacity" | "parent" | "steer";
	detail: string;
}

/**
 * Detached-batch grouping and collection state, persisted in `batches.json` so a barrier collect works after session
 * exit and completion nudges stay suppressed once a batch is collected.
 */
export interface DetachedBatchesContract {
	register(input: RegisterDetachedBatchInput): Promise<DetachedBatchRecord>;
	get(batchId: string): DetachedBatchRecord | null;
	list(opts?: { includeCollected?: boolean }): ReadonlyArray<DetachedBatchRecord>;
	/** Marks the batch collected; the collector's session id is kept from the first collection. */
	markCollected(batchId: string, collectorSessionId?: string | null): Promise<DetachedBatchRecord | null>;
	/** Records that the dispatching session learned another session collected the batch. */
	markOwnerTold?(batchId: string): Promise<void>;
}

/**
 * One route's in-process circuit breaker. `remainingMs` is read from a monotonic clock for rendering; never persist it.
 */
export interface RouteBreakerView {
	targetId: string;
	runtimeId: string;
	wireModelId: string;
	state: BreakerState;
	remainingMs: number;
	reason: string;
	consecutiveFailures: number;
}

/** What `dispatch land` did: landed the branch, kept it on the operator's answer, or refused before any card. */
export interface DispatchLandOutcome {
	outcome: "landed" | "kept" | "refused";
	branch?: string;
	detail: string;
}

/**
 * The money and quota facts `context(scope="budget")` shows its caller (S16), bounded to the caller's own scope and
 * read from held state; only a pool with no fresh reading spends one bounded usage poll, never a model call. A field
 * the caller may not see reads withheld, never zero; no credential, account identity, plan or pool the caller's route
 * does not draw on appears.
 */
export type BudgetEconomicsView =
	| {
			scope: "session";
			/** The session's spend as dispatch admission counts it: settled journals plus workers still metering. */
			spend:
				| {
						usd: number;
						/**
						 * Measured, estimated, a lower bound because some calls went unpriced, or unstated by the spend
						 * fold.
						 */
						basis: "measured" | "estimated" | "lower-bound" | "unstated";
						ceilingUsd: number | null;
						/** Ceiling less spend; null without a ceiling. Never a forecast of what the next call costs. */
						headroomUsd: number | null;
				  }
				/** No telemetry read model observes this session's spend: unknown, never a measured zero. */
				| { usd: null; basis: "unobserved"; ceilingUsd: number | null; headroomUsd: null };
			/**
			 * The chat route's quota pool: the fresh shared poll reading, else this process's own newest in-band reading, else
			 * one bounded usage poll; with none fresh, the newest held reading marked not fresh, or why there is none.
			 */
			pool: BudgetPoolView | { status: "none"; reason: string };
			/**
			 * Per-candidate forecasts (R4), the plan card's own lines for every dispatchable agent: the route each runs on
			 * now first, then the alternatives its router weighs; bounded, a last line counting those omitted.
			 */
			forecasts: ReadonlyArray<string>;
	  }
	| {
			scope: "worker";
			/** This run's own sealed envelope; nothing about the session or any pool. */
			envelope: {
				toolCalls: number;
				retries: number;
				wallMs: number;
				deadlineAt: string;
				responseMs: number;
			} | null;
			spend: "withheld";
			pool: "withheld";
	  };

/** The scale of every `usedPct` and `creditsUsedPct` in a pool view, as the provider reports them. */
export const BUDGET_USED_PCT_UNIT = "percent used, 0 to 100: 1 means 1% used, 100 means full";

/** One quota pool as the provider last reported it; its own verdict, not PanCode's guess. */
export interface BudgetPoolView {
	status: "reading";
	provider: string;
	/** The provider's deny status for the pool (S5b); unknown when it gave none, never read as allowed. */
	access: QuotaAccess;
	/** Whether credits or overage can pay past a full window; permission, not authority to grant it. */
	overage: QuotaOverage;
	/** States the scale before the numbers a model reads: a reader once took `usedPct: 1` for a full window. */
	usedPctUnit: typeof BUDGET_USED_PCT_UNIT;
	/**
	 * Each window as reported; `usedPct` is null when the provider gave no percentage, as for an unlimited allowance.
	 */
	windows: ReadonlyArray<{
		label: string;
		usedPct: number | null;
		unlimited?: true;
		resetsAt: string | null;
		access: QuotaAccess | null;
	}>;
	/** Credit pool use as a percentage; null when the provider reported none. */
	creditsUsedPct: number | null;
	/**
	 * How the reading arrived: a usage poll (the shared cache or this call's own bounded poll), or the quota this
	 * process's own requests on the route reported in band (a Codex stream event, Anthropic response headers).
	 */
	source: "poll" | "stream-event" | "response-headers";
	/** The instant the provider reported the reading; `ageMs` and `fresh` are measured from it, never from the read. */
	observedAt: string;
	ageMs: number;
	/**
	 * Inside the reading's freshness window, not served stale and not stamped after the read. A stale reading is shown,
	 * never acted on.
	 */
	fresh: boolean;
}

/** Host-owned read of the caller's economics view (S16). */
export type BudgetEconomicsPort = () => Promise<BudgetEconomicsView>;

export interface DispatchContract {
	/** True when the domain event pump publishes DispatchProgress itself. */
	readonly publishesProgress?: boolean;
	/** The traits a recipe declares, so readers of a run never branch on its recipe id; empty when unknown. */
	agentTraits?(agentId: string): ReadonlyArray<AgentTrait>;
	/**
	 * Settles once restart recovery (compete workers, task worktrees, the ledger scan) has finished, starting it if
	 * needed.
	 */
	awaitStartupRecovery?(): Promise<void>;
	/** Whether `bus` is the same bus already owned by the domain progress pump. */
	ownsProgressBus?(bus: TelemetryHub | undefined): boolean;
	/**
	 * Resolve the effective route without launching or taking a slot. Callers pin it into the approved request, so a
	 * later placement failure aborts rather than choosing an unapproved node.
	 */
	preview?(req: DispatchRequest): DispatchPlanTaskResolution;
	/**
	 * The session's economics view for `context(scope="budget")`; held reads and at most one bounded usage poll (S16).
	 */
	budgetEconomics?: BudgetEconomicsPort;
	/**
	 * The grants preview derives on the fixed route; null for an ACP delegation, whose tool surface PanCode cannot
	 * observe.
	 */
	derivedGrants?(req: DispatchRequest): DispatchDerivedGrants | null;
	/** One shared joint-resolver proposal for a typed Scout successor; never a second agent selector. */
	planAgentSelection(input: DispatchAgentPlanInput): DispatchAgentPlanResolution;
	/**
	 * The resolved route, then eligible alternates; plan approval seals the list so failover stays inside what the
	 * operator saw.
	 */
	routeCandidates?(req: DispatchRequest): ReadonlyArray<DispatchFailoverCandidate>;
	/** Durable transactional reservations prepared before a plan can be approved. */
	readonly reservations?: {
		prepare(input: {
			topology: ReservationTopology;
			tasks: ReadonlyArray<{ memberId: string; wave: number; resolution: DispatchPlanTaskResolution }>;
		}): DispatchReservationRecord;
		release(ownerId: string): DispatchReservationRecord | null;
		rollback(ownerId: string): DispatchReservationRecord | null;
		rollbackUnconsumed(ownerId: string): DispatchReservationRecord | null;
		get(ownerId: string): DispatchReservationRecord | null;
	};
	/** Session scheduling ceiling captured in the same immutable approval artifact. */
	costCeilingUsd?(): number;
	/** Configured global worker capacity, shared with durable reservation admission. */
	maxWorkers?(): number;
	/** Current trusted hard-block state for coordinator-side merge validation. */
	protectedArtifactState?(): ProtectedArtifactState;
	/**
	 * Land a kept task branch as the operator's own action: on a Land card answer the host runs `pancode fleet land`'s
	 * checks outside any agent sandbox. Refuses when no operator can answer a card.
	 */
	landKeptTask?(input: { ref: string; cwd: string; signal?: AbortSignal }): Promise<DispatchLandOutcome>;
	/** Validate, admit and spawn a native worker. */
	dispatch(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunResult>;
	}>;

	/** Spawn a group of dispatches and expose one merged batch event stream. */
	dispatchBatch(
		reqs: ReadonlyArray<DispatchRequest>,
		preparation?: DispatchPreparationOptions,
	): Promise<{
		batchId: string;
		/** Logical work ids, one per request in admission order. */
		assignmentIds: ReadonlyArray<string>;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<ReadonlyArray<RunResult>>;
	}>;

	/** Seal a coordinator-only council synthesis receipt without invoking a model. */
	sealCouncilSynthesis?(input: {
		group: string;
		round: number;
		kind: "none" | "vote" | "judge";
		text: string;
		subjects: ReadonlyArray<{ runId: string; digest: string | null }>;
		template: RunResult;
		/** Who asked for the council, for display; the synthesis files under the template's `requestOrigin`. */
		rootRequestOrigin?: DispatchRequestOrigin;
	}): Promise<RunResult>;

	/**
	 * The session and workspace this process dispatches for; ledger, batch and gate rows are machine-wide, so readers
	 * filter on it.
	 */
	owner?(): DispatchOwner;

	/** List runs from the ledger. Machine-wide: filter through ownership before surfacing rows. */
	listRuns(status?: RunStatus, where?: (run: Readonly<RunEnvelope>) => boolean): ReadonlyArray<RunEnvelope>;

	/** Run/assignment state changes; subscribe before reading, and unsubscribe after observation. */
	subscribeChanges?(listener: () => void): () => void;

	/** Get a specific immutable attempt envelope. */
	getRun(runId: string): RunEnvelope | null;

	/**
	 * Absolute paths this run's successful tool calls aimed a mutation at, observed rather than inferred from the
	 * checkout, so the write boundary can tell what a step changed from what changed under it. Null when no usable
	 * record exists (unknown run, no or incomplete telemetry, a tool that writes paths its arguments do not name);
	 * null is not "wrote nothing".
	 */
	observedRunWrites?(runId: string): ReadonlyArray<string> | null;

	/** Full write-record witness with durable downgrade causes; observedRunWrites is its paths-or-null view. */
	observedRunWriteAttribution?(runId: string): WriteBoundaryAttribution | null;

	/** In-memory logical assignment state and complete finalized-attempt history. */
	readonly assignments?: {
		/** Live assignment, including its terminal promise and detailed attempt refs. */
		get(id: AssignmentId | string): DispatchAssignment | null;
		/** Durable status/history, available after process restart. */
		getStored(id: AssignmentId | string): DurableAssignmentRecord | null;
		/**
		 * Resolve once in-flight assignment writes land, so a detached caller's immediate collect sees the assignment.
		 */
		flushWrites?(): Promise<void>;
	};

	/**
	 * Abort an assignment (its current attempt, suppressing retries) or one attempt. The outcome is `canceled`;
	 * `reason` names a non-operator cause in outcomeDetail, which otherwise reads "operator abort".
	 */
	abort(runId: string, reason?: AbortReason): void;
	/**
	 * Whether this process aborted the run's assignment with the steer cause. A
	 * cancel during a scheduled retry leaves the last attempt sealed failed, so
	 * only this marker says the dispatching session canceled it.
	 */
	canceledBySteer?(runId: string): boolean;

	/** Wait for one member's attempts and retries to settle, without cancelling; owners abort first when stopping. */
	drainMember?(runId: string): Promise<void>;

	/**
	 * The member's terminal receipt after automatic retries, with every completed attempt's receipt in execution order.
	 * Only nested lineage attempts retain receipts, and collection releases them.
	 */
	waitForMember?(runId: string): Promise<{ receipt: RunResult; receipts: ReadonlyArray<RunResult> }>;

	/**
	 * Queue operator guidance on a running worker (an assignment id addresses its current attempt): a stdin JSON line
	 * injected at the next loop boundary and acked by `pancode_steer_received`, or another `session/prompt` for an ACP
	 * peer that takes one (agy 1.5.0+). Throws an operator-facing message when the run is unknown or inactive, has no
	 * such channel, or its stdin is gone.
	 */
	steer(runId: string, text: string): void;

	/**
	 * Apply an operator's decision to a native worker's parked escalation (onPermission="escalate") as a
	 * `permission_decision` stdin line, acked by `pancode_permission_resolved`. Human-only: no model-facing
	 * tool reaches it. Throws as `steer` does.
	 */
	resolveWorkerPermission?(runId: string, requestId: string, decision: "approve" | "deny"): void;

	/**
	 * Why this session may not answer a worker's ask, or null when it may. Like cancel and steer, an approval answer
	 * belongs to the exact session that dispatched the run: a fork that inherits its parent's history still leaves the
	 * parent's worker asks to the parent. resolveWorkerPermission refuses with the same words.
	 */
	workerPermissionRefusal?(runId: string, requestId: string): string | null;

	/** The window this process runs for a worker's ask; null for a main-routed or settled ask, which cannot be held. */
	workerPermissionWindow?(requestId: string): WorkerApprovalWindowView | null;
	/** The main turn is waiting on this run, so cancelling the turn stops the worker too. */
	workerRunEndsWithTurn?(runId: string): boolean;
	/** Every command the worker spawns, approved shell calls included, runs inside its OS sandbox or is refused. */
	workerRunShellConfined?(runId: string): boolean;
	/** The person is at this ask's card: it waits until its ceiling, then the fallback applies. */
	holdWorkerPermission?(requestId: string): boolean;
	/** The person is present and this ask is queued behind another card: its window starts again. */
	restartWorkerPermission?(requestId: string): boolean;

	/** Live main-agent grants for native worker asks; absent in minimal bundles. */
	grants?: WorkerGrantsContract;

	/** Durable detached-batch records for async fan-out + collect. */
	detached?: DetachedBatchesContract;

	/** Read-only runtime snapshot for operator surfaces. */
	snapshot(): DispatchSnapshot;

	/** Every route breaker not closed or with failures counted; never claims a probe. */
	routeBreakers?(): ReadonlyArray<RouteBreakerView>;

	/**
	 * Fold retained route history in the background, shortly after the call, so
	 * a later first dispatch pays only for what is still cold. Only a long-lived
	 * surface (the terminal, ACP) asks: a one-shot process would spend the fold's
	 * CPU while its own turn runs and exits before any dispatch could reuse it.
	 */
	warmRouteHistory?(): void;

	/**
	 * Start the chat route's one bounded no-inference usage poll off the turn path when the shared quota reading is
	 * stale, so a headless run's first `context(scope="budget")` read finds it done or waits only out the rest of its
	 * bound (S16). A one-shot run asks at run start; nothing else polls on the run's behalf.
	 */
	primeRouteQuota?(): void;

	/** Local cleanup and event-drain allowance; accepted durable writes follow settlement. */
	drainAllowanceMs?(): number;

	/** Drain active runs on shutdown (SIGTERM + grace + SIGKILL). */
	drain(): Promise<void>;
}
