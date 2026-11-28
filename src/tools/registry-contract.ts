// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { EgressCallerSettings } from "../core/defaults.js";
import type { ModelRunInfo } from "../core/model-tier.js";
import type { MainSandboxPolicy, YoloScriptSandboxState } from "../core/sandbox/main-session.js";
import type { SandboxEnvPolicy, UnixSocketMode } from "../core/sandbox/types.js";
import type { PendingSkillToolPolicy } from "../core/skill-activation.js";
import type { ToolName } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { MiddlewareContract } from "../domains/middleware/contract.js";
import type {
	MiddlewareEffect,
	MiddlewareHookInput,
	MiddlewareReminderSeverity,
	ToolCallLanding,
} from "../domains/middleware/types.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import type { AdmissionGitContext, AdmissionPrincipal, ApprovalAuthority } from "../domains/safety/admission.js";
import type { OpenDecisionKind } from "../domains/safety/autonomy-window.js";
import type { SafetyContract, SafetyDecision } from "../domains/safety/contract.js";
import type { DecisionPresentation } from "../domains/safety/decision-presentation.js";
import type { ToolDenial } from "../domains/safety/denial.js";
import type { EscapeScope, EscapeScopeLedger } from "../domains/safety/escape-scope.js";
import type { GitHookDriftGuard } from "../domains/safety/hook-drift.js";
import type { FlowRestrictionSet } from "../domains/safety/information-flow.js";
import type { SafetyJudgeSeat } from "../domains/safety/safety-judge.js";
import type { SessionCodeConsent } from "../domains/safety/session-code-consent.js";
import type { WorkspaceSnapshotOutcome, WorkspaceSnapshotRequest } from "../domains/workspace-snapshots/store.js";
import type { AutonomyExposure, AutonomyLevel } from "../lib/autonomy/autonomy.js";
import type { DispatchPlanView } from "./dispatch-plan.js";
import type { ToolResult, ToolSpec } from "./tool-spec.js";

export interface RegistryDeps {
	safety: SafetyContract;
	/**
	 * Hook layer. The loop guard, registered on `before_tool` by both
	 * composition roots (entry/orchestrator.ts and worker-runtime.ts via
	 * engine/loop-guard.ts), observes every call attempt through this contract;
	 * the registry feeds it `metadata.callFingerprint` and runs `before_tool`
	 * for safety-blocked attempts too, so repetition of rejected calls stays
	 * observable.
	 */
	middleware?: MiddlewareContract;
	/**
	 * Provider-routing effects emitted by tool hooks apply to the next model
	 * round. The registry owns those hook calls, so it forwards the complete
	 * effect batch to the composition root after evaluation. Consumers may only
	 * narrow routing (`require_tool` / `lock_tools`); admission still happens
	 * through this registry on the resulting call.
	 */
	onMiddlewareEffects?: (effects: ReadonlyArray<MiddlewareEffect>, input: MiddlewareHookInput) => void;
	/**
	 * Applies the protect_path effects an awaited extension hook returned, which
	 * reach the protected-artifacts guard only through the synchronous chain that
	 * already ran. Returns why the call still in flight must now be refused, else null.
	 */
	absorbAwaitedEffects?: (effects: ReadonlyArray<MiddlewareEffect>, input: MiddlewareHookInput) => string | null;
	/**
	 * Live autonomy level (sd-01 §2.2). Read per admission so hot-reloaded
	 * settings apply to the next call. The orchestrator wires this to current
	 * settings; workers always wire it to default.
	 * Absent means the default operator mode.
	 */
	autonomy?: () => AutonomyLevel;
	/**
	 * Whose calls this registry admits. Worker execute authority comes from
	 * its bound permit, not this autonomy callback. Only its autonomy asks may
	 * later be answered by the main agent. Absent means the main agent.
	 */
	principal?: AdmissionPrincipal;
	workerExecuteAutonomy?: "yolo";
	/**
	 * The operator's `safety.scratchRoots`, read per admission. Only the main
	 * session's registry wires it, and its presence is what marks this registry's
	 * yolo as the operator's own (#419): workers, grants and jobs never carry it.
	 */
	scratchRoots?: () => ReadonlyArray<string>;
	/** How the operator's yolo runs a script on this host, from `safety.sandbox` and the probed backend (#419). */
	scriptSandbox?: () => YoloScriptSandboxState;
	/**
	 * The operator's containment at autonomy default, read per admission:
	 * whether this session's bash and run_script calls run in the main-session
	 * sandbox (`safety.sandbox` not off and a backend present), and whether a
	 * workspace snapshot precedes a destructive call (a git work tree and
	 * `safety.snapshots` on). Only the main session's registry wires it, beside
	 * `scratchRoots`; without it default keeps today's rails. `readOnlySandbox`
	 * says the read-only sandbox runs here (bubblewrap, `safety.sandbox` not
	 * off); a read-only session's shell calls run in it at either level.
	 */
	containment?: () => { sandbox: boolean; snapshots: boolean; readOnlySandbox?: boolean };
	/**
	 * Whether nobody will answer a park, read per call: the operator's contained
	 * yolo (ob-yolo D1). Admission and the safety judge run exactly as at
	 * default; a call the judge neither allowed nor blocked is refused back to
	 * the model instead of parking, and the refusal is remembered so an
	 * identical repeat is refused at once. Only the main session's registry
	 * wires it.
	 */
	unattendedAsks?: () => boolean;
	/**
	 * Whether a person can answer this session's approval cards: false for a
	 * headless run. Absent reads as no operator. With one, a sandbox escape the
	 * judge would block but whose outside target the operator named goes to the card.
	 */
	operatorAttends?: () => boolean;
	/** Observes each call `unattendedAsks` refused, for contained yolo's open decisions (ob-yolo D7); decides nothing. */
	onUnattendedRefusal?: (call: ClassifierCall, decision: SafetyDecision, kind: OpenDecisionKind, rule?: string) => void;
	/**
	 * Observes each ask_user round the operator answered themselves, never one
	 * PanCode answered for an absent operator. The main session reopens the
	 * autonomy window; the safety judge reads the answers from the ledger.
	 */
	onOperatorAnswered?: (
		answers: ReadonlyArray<{ question: string; answer: string }>,
		options?: ToolInvokeOptions,
	) => void;
	/** The main session's id, which names a read-only run's scratch directory. */
	currentSessionId?: () => string | undefined;
	/**
	 * How a contained call's inherited environment is scrubbed: the operator's
	 * `safety.sandboxPassEnv` and the variables PanCode's targets read keys from,
	 * read per call. Absent scrubs with the name and value rules alone.
	 */
	sandboxEnv?: () => SandboxEnvPolicy;
	/** `safety.sandboxUnixSockets`, read per contained call. Absent blocks them. */
	sandboxUnixSockets?: () => UnixSocketMode;
	/**
	 * `safety.egress.main` and `safety.egress.upstreamProxy`, read per contained
	 * call: how the session's contained commands reach the network. Absent
	 * keeps the host network, as for a registry that is not the main session's.
	 */
	sandboxEgress?: () => { main: EgressCallerSettings; upstreamProxy: string | null };
	/**
	 * The loop guard's parent-workspace mutation epoch for a turn. The main
	 * agent's denial memory keys on it, so a refusal is repeated only while
	 * nothing it was decided on has changed. Absent means epoch 0.
	 */
	mutationEpoch?: (turnId: string) => number;
	/** Dispatch-owned restriction, fixed for the lifetime of this run. */
	readOnly?: boolean;
	/**
	 * A worker's shell commands run in an OS sandbox that confines every write
	 * (bubblewrap, no writable root under a read-only permit), so a read-only
	 * run may still run them. Read only when `principal` is worker.
	 */
	readOnlyShellConfined?: () => boolean;
	/** Who can make a turn's host scope read-only here, named by its denial; absent means `pancode run --read-only`. */
	hostReadOnlySource?: HostReadOnlySource;
	/**
	 * The worker's standing Git allowance and attested task worktree (Phase C).
	 * Read only when `principal` is worker; the git tool body receives it too,
	 * so a typed mutation re-attests right before Git runs.
	 */
	git?: AdmissionGitContext;
	/**
	 * The session's information-flow ledger. `carried` is what the context
	 * already holds, judged before a mediated outbound call (web_fetch,
	 * web_read, an MCP tool) runs; `absorb` records what a restricted read
	 * just added, before its result is screened or returned. Absent means an
	 * unrestricted session (a worker passes its own run-scoped ledger).
	 */
	flow?: {
		carried(): FlowRestrictionSet | null;
		/** Why provenance cannot be vouched for (unreadable or unpersisted ledger), or null. */
		refusal(): string | null;
		/** The gateway's pinned launch identity for an MCP tool, when a gateway is attached. */
		mcpTransport?(tool: string): string | null;
		absorb(set: FlowRestrictionSet, origin: { tool?: string; toolCallId?: string }): void;
	};
	/**
	 * The attended session's test-runner consent (#377 follow-up). Read on every
	 * main admission, and granted when the operator approves the consent ask.
	 * The orchestrator passes it on every surface; a headless run's consent is
	 * never pending, so it keeps #377's allow. Workers never consult it.
	 */
	sessionCodeConsent?: Pick<SessionCodeConsent, "pending" | "grant">;
	/**
	 * The session's sandbox-escape scopes (M-7). Only the main session's registry passes it: an escape inside a
	 * scope the operator approved for this session no longer asks, a parked escape carries the scope its
	 * session option offers, and contained yolo offers it to the next ask_user question about the escape.
	 */
	escapeScopes?: EscapeScopeLedger;
	/**
	 * The safety judge. Only the main session's registry passes it: at autonomy
	 * default a call that would park for the operator is first reviewed against
	 * the operator's own messages, and runs, comes back refused, or parks as
	 * before when the judge skips it or gives no verdict. Workers never carry it.
	 */
	safetyJudge?: SafetyJudgeSeat;
	/**
	 * The git hook drift guard. Only the main session's registry passes it: at
	 * autonomy default a git command that would run a hook file added or
	 * changed since the operator's baseline outside the sandbox asks the
	 * operator under `git-hooks-changed`. The operator's allow accepts the
	 * files the card named; an approved or judge-allowed `git-control-file`
	 * write, or an approved `startup-path-confirm` write, refreshes the file
	 * it wrote. Workers never carry it.
	 */
	hookDrift?: GitHookDriftGuard;
	/**
	 * Takes a workspace snapshot before an admitted call's body runs: before the
	 * first mutating call of each turn, and before every destructive, deleting,
	 * git-discarding or branch-deleting call (`workspaceSnapshotTrigger`). Only the main
	 * session's registry wires it; worker registries never snapshot. Resolves
	 * null when snapshots are off or no session is open. An unavailable snapshot
	 * never holds the call: it proceeds and its result says "no snapshot".
	 */
	workspaceSnapshot?: (
		request: WorkspaceSnapshotRequest & { sessionId?: string },
	) => Promise<WorkspaceSnapshotOutcome | null>;
}

/** The main session's side of a steer interruption; see {@link ToolInvokeOptions.steerInterrupt}. */
export interface SteerInterruptHost {
	/** One running interruptible call; `end` when it settles. */
	begin(toolName: string): { signal: AbortSignal; fired(): boolean; end(): void };
}

/**
 * Keeps the operator's screen reserved across the rounds of one harness card, so
 * a model question cannot take it between two of them. Created and released by
 * the card's owner, never derived from model arguments.
 */
export interface HarnessHold {
	/** Ends the reservation; later calls do nothing. */
	release(): void;
	/** Runs once when the reservation ends, immediately if it already has. */
	onRelease(listener: () => void): void;
}

export function createHarnessHold(): HarnessHold {
	let released = false;
	const listeners: Array<() => void> = [];
	return {
		release() {
			if (released) return;
			released = true;
			for (const listener of listeners.splice(0)) listener();
		},
		onRelease(listener) {
			if (released) listener();
			else listeners.push(listener);
		},
	};
}

/**
 * What an approval carried over a narrowing rewrite (WX3), so the receipt can
 * link the plan the approver saw to the one that ran.
 */
export interface ApprovalCarry {
	/** Extension whose before_tool rewrite the approval carried over. */
	extension: string;
	/** Hash of the approved call's plan view, when the tool renders one. */
	approvedPlanHash?: string;
}

/** What a headless run's observation pool did with one call (CLI-P42); see `observationPoolEvent`. */
export type ObservationPoolEvent = "refused" | "drained" | "delivered";

export interface ToolInvokeOptions {
	/**
	 * Host-owned, ask_user only: the session-scope option the registry offers for the escape contained yolo just
	 * refused (M-7). Never taken from model arguments.
	 */
	escapeScopeOffer?: { label: string; description: string; accept(): void };
	/** An invocation the harness runner makes on its own decision; never derived from model arguments. */
	origin?: "harness";
	/**
	 * A slash command the operator typed (`/council`, `/poll`); never derived from model arguments.
	 * Its runs record who asked as `rootRequestOrigin: "user"`, which every surface displays, while
	 * admission keeps reading `requestOrigin`.
	 */
	operatorStarted?: true;
	/** With `origin: "harness"`, the card whose rounds this is. */
	harnessHold?: HarnessHold;
	/** Display and drafts for harness interviews only; never taken from model arguments. */
	harnessInterview?: {
		title: string;
		step: number;
		total?: number;
		intro?: (width: number) => string[];
		initial?: ReadonlyArray<{ selected?: readonly number[]; text?: string }>;
	};
	/** Host-owned task scope, preserved on nested gateway calls. */
	turnConstraints?: TurnConstraints;
	/** Why the host ended this run, read once `signal` has fired; the engine's abort carries no reason (#445). */
	abortCause?: () => string | null;
	/**
	 * Host-owned, main session only: lets a queued operator steer end a `steerInterruptible` call (FX-32). The
	 * agent-tool seam begins one interruption per call and never hands this to the tool.
	 */
	steerInterrupt?: SteerInterruptHost;
	/**
	 * Set by the agent-tool seam: true when a queued steer alone ended this call, false when the run was cancelled too.
	 * Read once, when the call settles; the first read decides the stop cause for the tool and the seam alike.
	 */
	steerInterrupted?: () => boolean;
	/** Main session: `safety.limits.bashIdleSeconds` in ms. A foreground bash call idle this long ends as timed out. */
	bashIdleMs?: number;
	/** Registry-owned filter bound to the active compiled safety policy. */
	allowsObservationPath?: (path: string) => boolean;
	/** Registry-owned write-root check the typed mutation seam repeats right before it publishes (F3). */
	writeTargetViolation?: (target: string) => string | null;
	/** Registry-owned worker Git context; the git tool re-attests a typed mutation with it. */
	gitContext?: AdmissionGitContext;
	/**
	 * Registry-owned landing the awaited extension hooks were shown. A path
	 * tool refuses when its own resolution differs, so a link swapped while a
	 * hook ran cannot point the body at a file the hook never judged.
	 */
	hookLanding?: ToolCallLanding;
	/**
	 * Registry-owned information-flow check for every URL a fetch actually
	 * connects to, redirect hops included. Returns the block reason or null.
	 * Present only while the session carries restricted content.
	 */
	flowAdmitsUrl?: (url: string) => string | null;
	/**
	 * Registry-owned information-flow check for each storage URL an MCP call
	 * sends its files to, judged with the files' own labels. Returns the block
	 * reason or null. Present only when the session has an information-flow ledger.
	 */
	flowAdmitsFileTarget?: (url: string) => string | null;
	/** Trusted submitting host identity for nested dispatch; never model arguments. */
	hostRun?: import("../domains/dispatch/contract.js").DispatchPreparationOptions["hostRun"];
	/**
	 * Set by the main session's registry while it admits at yolo (#419), so a
	 * tool's own workspace confinement (a bash or run_script cwd) can follow the
	 * admission that passed. Never taken from a caller.
	 */
	operatorYolo?: true;
	/**
	 * Set by the main session's registry when admission decided the call runs
	 * contained: a bash or run_script call at autonomy default with a sandbox
	 * backend, or a script under the operator's yolo with `safety.sandbox:
	 * required` (#419). The tool spawns it in the main-session sandbox with this
	 * policy, and a cwd outside the workspace is allowed inside it. Never taken
	 * from a caller.
	 */
	shellSandbox?: MainSandboxPolicy;
	/** Trusted resolved model capability; never read from tool arguments. */
	supportsImages?: boolean;
	/** Trusted effective context window in tokens; sizes the per-turn observation pool. */
	contextWindow?: number;
	/**
	 * Dispatched workers only (DESIGN 4.5): the run's observation pool, keyed by `runId` instead of a turn and sized from
	 * the usable window's work share; `resultCapBytes` caps one result at what the work share has left.
	 * `runObservationPool` in `observation.ts` sizes it.
	 */
	observationRunPool?: { limitBytes: number; resultCapBytes: number };
	/** What the shared per-call cap of a multi-path `read` has left for this one path; set only by the registry. */
	readCapBytes?: number;
	/** Trusted model the call runs on, as tool hooks receive it; the worker's own model in a worker. */
	model?: ModelRunInfo;
	signal?: AbortSignal;
	runId?: string;
	sessionId?: string;
	turnId?: string;
	toolCallId?: string;
	/** Provider request identity observed on the assistant message that supplied this tool block (#434). */
	callId?: string;
	attemptId?: string;
	correlationId?: string;
	/** Calls in the model response named by `correlationId`; the loop guard judges the batch whole at the turn budget. */
	batchSize?: number;
	/** Whether a turn the per-turn tool budget ends now continues without the operator; the soft refusal says so. */
	turnBudgetContinues?: boolean;
	/** Main session only: the route's measured width multiplier for the per-turn budgets (`turn-budget-width.ts`). */
	turnBudgetScale?: number;
	/**
	 * Main session only, when a continuation follows: an exhausted observation pool asks the chat loop to roll the
	 * turn at its tool boundary instead of asking the model to re-plan (XR-6).
	 */
	observationBudgetRoll?: () => void;
	/**
	 * Headless runs only (CLI-P42): the observation pool this call charges after the run's pool rolled; absent or 0 is
	 * the turn's own pool. `createHeadlessObservationPool` in `observation.ts` sets it with `observationPoolEvent`.
	 */
	observationPoolEpoch?: number;
	/**
	 * Headless runs only (CLI-P42): what the pool did with this call. `refused` (the pool was spent before it), `drained`
	 * (it returned and left less than a slice) or `delivered` (it returned its result). Present, a spent pool rolls at
	 * the next tool batch and a refusal tells the model to make the call again there.
	 */
	observationPoolEvent?: (event: ObservationPoolEvent) => void;
	/**
	 * One model tool call's identity for the observation pool's refusal count (C-17): set once per call by the agent
	 * tool runner, and spread by a gateway chain into each step, so its sequential steps count as that call refused
	 * again while parallel siblings each carry their own.
	 */
	observationCall?: object;
	/** Session-effective ceiling for one tool result, read again before every invocation. */
	toolResultMaxBytes?: number;
	pendingSkillPolicy?: PendingSkillToolPolicy;
	askUserPolicy?: AskUserToolPolicy;
	/** Host-derived display copy for an ask_user round. It has no admission authority. */
	decisionPresentation?: DecisionPresentation;
	/**
	 * Set by the ask_user tool alone: the surface may close a round nobody
	 * answers within `safety.unattendedAfterSeconds` and report it as
	 * `timedOut`, and the tool chooses for the operator (#421). A harness card
	 * or a settings confirmation never carries it, so those still wait.
	 */
	unattendedFallback?: true;
	/** Registry-authenticated one-shot operator approval for this execution. */
	approval?: {
		requestId: string;
		requestedBy: string;
		actionClass: ActionClass;
		issuer?: ApprovalAuthority;
		/** Set when the approval carried over a before_tool rewrite of the approved call (WX3). */
		carriedOver?: ApprovalCarry;
	};
	/**
	 * True for an invocation a tool body makes on the model's behalf (the
	 * gateway calling the capability it was asked for). The nested call keeps
	 * its own admission, hooks, and evidence; the flag only tells the loop
	 * guard that the model's one call has already been counted.
	 */
	nested?: boolean;
	/**
	 * Set by the gateway on the capability a call or chain step runs under the
	 * model's call. Its tool.decided and tool.settled rows carry `inner` so each
	 * decision has its own settlement and counters count the model's call (C-9).
	 */
	gatewayInner?: true;
	/**
	 * The capability surface this run was admitted to, when the run is
	 * narrower than the registry (a worker). The gateway refuses to call any
	 * capability outside it, so a recipe's declared tools bound the gateway
	 * exactly as they bound the attached schemas.
	 */
	allowedTools?: ReadonlyArray<ToolName>;
	/**
	 * How long this call sat parked awaiting an operator decision, or the safety
	 * judge's review, reported when each wait ends. A caller timing the invocation is measuring the tool,
	 * and the park is the operator, so the two have to be separable: without
	 * this a `npm test` approved after a minute of reading was recorded as a
	 * one-minute test run in the transcript, the receipt, and toolStats.
	 */
	onParked?: (parkedMs: number) => void;
	/**
	 * Wall time each before_tool or after_tool middleware run took, reported as
	 * it ends. A command hook blocks the event loop and an extension hook is
	 * awaited, both inside this invocation, so a caller timing the tool
	 * subtracts it: a 1.8 s hook on `read` is not a 1.8 s read.
	 */
	onHookTime?: (hookMs: number) => void;
	/**
	 * Display-only cumulative progress supplied by pi-agent-core's
	 * `AgentToolUpdateCallback`. Tool bodies may report the result snapshot the
	 * operator should see while the call runs. Admission, final result shaping,
	 * telemetry, and ledger persistence continue to consume only the terminal
	 * return value.
	 */
	onUpdate?: (partialResult: ToolResult) => void;
}

type AskUserInterviewStatus = "idle" | "active" | "complete" | "cancelled";

/**
 * Where an operator answer written ahead came from: the `pancode run
 * --answers` file and the entry of it that matched (WTF-P 0.8.3 B1). The
 * answer is the operator's, recorded so a reader can tell it from one typed
 * live and from one PanCode chose when nobody answered.
 */
export interface ScriptedAnswerSource {
	file: string;
	rule: string;
}

export interface AskUserTranscriptQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multi_select?: boolean;
	/** The question was the operator's own choice; nobody could answer it for them. */
	operator_only?: true;
}

export interface AskUserTranscriptAnswer {
	question: string;
	/** The whole answer on one line: the chosen labels, then the typed text. */
	answer: string;
	/**
	 * The option labels the operator chose, in list order. Absent when they only
	 * typed. Present with no {@link value} is a label-only answer.
	 */
	options?: string[];
	/**
	 * The operator's typed text, exactly as submitted. Absent when they only
	 * chose. Recording an option label without this is what lost the figures in
	 * issue #228.
	 */
	value?: string;
	/** PanCode chose this answer because nobody answered within the unattended window (#421). */
	auto?: true;
	/** The answer came from the operator's `run --answers` file. */
	scripted?: ScriptedAnswerSource;
}

export interface AskUserTranscriptDecision {
	key: string;
	value: string;
	label?: string;
	/** The chosen labels behind {@link value}, when the answer had any. Harness-derived. */
	options?: string[];
	/** The typed text behind {@link value}, when the answer had any. Harness-derived. */
	text?: string;
	source_question?: string;
	/**
	 * `agent` when PanCode chose the answer because nobody answered in time
	 * (#421), with the options it passed over and why. Harness-derived; the
	 * decision board records it as PanCode's decision, not the operator's.
	 */
	source?: "agent";
	alternatives?: string[];
	rationale?: string;
	/**
	 * The operator's own answer to an `operator_only` question: the one record
	 * of a choice only they may make. Harness-derived, never model-supplied, and
	 * never set on an answer PanCode chose for an absent operator.
	 */
	operator_choice?: true;
	/** The operator's answer came from a `run --answers` file; never set with `source: "agent"`. */
	scripted?: ScriptedAnswerSource;
}

interface AskUserTranscriptRound {
	round: number;
	requestedAt: string;
	answeredAt?: string;
	questions: AskUserTranscriptQuestion[];
	answers: AskUserTranscriptAnswer[];
	cancelled?: boolean;
}

export interface AskUserToolPolicy {
	planOnly?: boolean;
	/** A plan card was answered with anything but keeping the plan: work or a revision follows and may still need the operator. */
	asksAfterClose?: boolean;
	/** The interview the same operator prompt closed before this continuation turn began (C-25). */
	closedEarlier?: AskUserToolPolicy;
	id: string;
	status: AskUserInterviewStatus;
	startedAt: string;
	updatedAt: string;
	endedAt?: string;
	sessionId?: string;
	turnId?: string;
	transcriptPath?: string;
	/** Monotonic exposure fact for live presentation and durable replay. */
	exposure?: AutonomyExposure;
	summary?: string;
	rounds: AskUserTranscriptRound[];
	decisions: AskUserTranscriptDecision[];
	inFlight: boolean;
	cancelled: boolean;
	answerCount: number;
	callCount: number;
	maxCalls: number;
	askedQuestionKeys: Set<string>;
}

/**
 * One-shot elevation grant. The interactive layer issues this when the user
 * confirms a single parked tool call without changing persistent posture.
 * The registry consumes the grant on the next `resumeParkedCalls` pass so
 * exactly one parked call receives elevated admission; subsequent calls go
 * back through the normal safety gate.
 */
export interface OneShotGrant {
	/** Parked action class approved for this single admission pass. */
	actionClass: ActionClass;
	/** Parked approval request approved for this single admission pass. */
	requestId?: string;
	/**
	 * Surface that released the call: `tool:one_shot` (TUI card), `gui:operator`
	 * (PanCode GUI card), `acp-client` (any other ACP client), `escalation:operator`
	 * or `grant:main`. It is carried into audit
	 * and decides the wording of the note the model reads (`approval-note.ts`).
	 * It is audit text, never authority: the issuer below decides what clears.
	 */
	requestedBy: string;
	/**
	 * Who issued the grant. Absent means the operator, which every current
	 * surface is. A `main` grant can discharge only an ask whose approval
	 * authority is `main`; an operator rail stays parked under it.
	 */
	issuer?: ApprovalAuthority;
	/** The operator picked the parked escape's session option: its `escapeScope` is granted for the session first (M-7). */
	sessionScope?: true;
	/**
	 * Observes the one parked call a `requestId` grant selected: it started,
	 * it finished, or it was not executed. A live grant reports execution
	 * separately from the decision (Phase D); "decision delivered" is not
	 * "tool executed".
	 */
	onExecution?: (event: GrantExecutionEvent) => void;
}

export type GrantExecutionEvent =
	| { phase: "start" }
	| { phase: "end"; outcome: "ok" | "error" | "blocked" }
	| { phase: "not_executed"; reason: string };

export interface PermissionRequiredMeta {
	requestId: string;
	axis: string;
	/**
	 * Who may answer this park. Every safety-net rail and tool confirmation is
	 * `operator`; only a worker's autonomy ask is `main`.
	 */
	approvalAuthority: ApprovalAuthority;
	sessionId?: string;
	turnId?: string;
	/**
	 * Provider tool-call id carried on the parked call's invoke options, when
	 * one exists. The interactive layer uses it to correlate the park to its
	 * transcript tool segment so a parked call renders as awaiting approval
	 * instead of running. Purely descriptive: park/resume semantics never
	 * read it.
	 */
	toolCallId?: string;
	/**
	 * The plan admission rendered for a dispatch call, the same view whose hash
	 * a plan-scale run seals. Carried so a surface shows the operator what
	 * admission judged rather than re-rendering it from the arguments.
	 */
	dispatchPlan?: DispatchPlanView;
	/**
	 * Set when the safety judge handed this call to the operator, to the reason it gave.
	 */
	gateReason?: string;
	/** The build that gave `gateReason`, which the card drops from a reason that repeats it. */
	gateBuild?: string;
	/**
	 * Set on an external read-root ask raised for a dispatch call: the dispatched task that will read the
	 * root, its 1-based position and the call's task count. Model-authored; a card attributes it to the
	 * dispatch, never to the operator (CLI-P35).
	 */
	dispatchTask?: DispatchReadRootTask;
	/**
	 * The scope a session option offers for a parked sandbox escape (M-7), as the harness read it from the call.
	 * A surface shows its label beside the one-call approval; picking it grants the scope before the call re-admits.
	 */
	escapeScope?: EscapeScope;
	/** What the call does beyond its own arguments that the operator should see, such as the files it sends off the host. */
	consequence?: string[];
}

/** The dispatched task an external read-root approval serves. */
export interface DispatchReadRootTask {
	text: string;
	position: number;
	count: number;
}

/** One host command a tool runs on its caller's behalf, as the direct call it stands for. */
export interface HostEffectCall {
	/** Operator-facing name for the effect, used in the refusal text. */
	label: string;
	call: ClassifierCall;
}

/** One file a call sends off the host. */
export interface OutboundFile {
	/** Operator-facing line for the approval, such as `sends ./a.pdf (2.1 MB) to mcp server docs and storage it names`. */
	consequence: string;
	/** The read that yields the file's bytes, whose information-flow labels the call carries out. */
	source: ClassifierCall;
}

export interface ToolRegistry {
	/** Host-only, one-shot consent for one external Scout root (#433). */
	requestReadRootApproval?(
		root: string,
		options?: ToolInvokeOptions,
		task?: DispatchReadRootTask,
	): Promise<{ requestId: string; requestedBy: string } | null>;
	register(spec: ToolSpec): void;
	/** Remove a session scoped dynamic capability after its owner closes. */
	unregister?(name: ToolName): void;
	/** Direct-placed tools: the ones whose schemas the model sees attached. */
	listVisible(): ReadonlyArray<ToolSpec>;
	/** Tools registered overall, direct and gateway. For /audit, /doctor, and the bootstrap policy assertion. */
	listAll(): ReadonlyArray<ToolSpec>;
	/** Lookup by tool id, whatever its placement. */
	get(name: ToolName): ToolSpec | undefined;
	/** Names of the direct-placed tools, in registration order. */
	listRegistered(): ReadonlyArray<ToolName>;
	/** Gateway-placed tools: reachable through `gateway` find/describe/call, never attached. */
	listGateway(): ReadonlyArray<ToolSpec>;
	/**
	 * Admission point. Classifies, evaluates safety, and either runs or
	 * returns a rejection. Never throws on safety rejections. When the
	 * a safety ask or confirmable action is encountered, the returned promise
	 * stays pending until a resume or cancel method resolves it.
	 */
	invoke(call: ClassifierCall, options?: ToolInvokeOptions): Promise<RegistryVerdict>;
	/**
	 * Admission's read-only denial of a registered call, decided without running it: the shared evaluator's
	 * disposition, rendered by the same denial path `invoke` uses (text, hints, remedy, reason code) and audited as
	 * denied. Null when the call is not registered or admission would not deny it as read-only, so a caller can never
	 * mistake an admitted call for a refused one. Nothing executes either way.
	 */
	readOnlyRefusal?(
		call: ClassifierCall,
		options?: ToolInvokeOptions,
	): Extract<RegistryVerdict, { kind: "blocked" }> | null;
	/**
	 * True while at least one call awaits operator confirmation. The interactive
	 * layer reads this from `closeOverlay()` to re-open the confirmation overlay
	 * whenever an unrelated overlay closes with a parked call still pending.
	 */
	hasParkedCalls(): boolean;
	/** Number of calls currently waiting for operator confirmation. */
	parkedCount(): number;
	/** Whether this approval request is still parked, so a late timer can tell it from one already settled. */
	isParked(requestId: string): boolean;
	/**
	 * Re-fire the permission-required signal for the oldest parked call without
	 * changing queue order or resolving anything.
	 */
	renotifyHead(): void;
	/**
	 * Re-run admission for every parked call. When `grant` is provided the
	 * grant covers one parked action class. Calls admitted on retry
	 * execute and their original promise resolves with the result. Calls still
	 * waiting for confirmation stay parked.
	 */
	resumeParkedCalls(grant?: OneShotGrant): Promise<void>;
	/**
	 * Forget the main agent's remembered refusals, for a host whose policy or
	 * settings reloaded: what decided them may have changed.
	 */
	forgetRefusals(): void;
	/**
	 * Resolve one parked call with a `blocked` verdict carrying `reason`.
	 * Returns true when the request was found. `denied` marks an answer that
	 * refused the call, which alone carries an operator-approval refusal
	 * account; a stop, an expiry or a shutdown only cancels the ask.
	 */
	cancelParkedCall(requestId: string, reason: string, options?: ParkCancelOptions): boolean;
	/**
	 * Resolve every parked call with a `blocked` verdict carrying `reason`.
	 * Used when the confirmation overlay is cancelled so the agent loop sees a
	 * clean rejection instead of an indefinitely pending tool call.
	 */
	cancelParkedCalls(reason: string, options?: ParkCancelOptions): void;
	/**
	 * Subscribe to the signal fired when a call is parked awaiting permission
	 * confirmation. Returns an unsubscribe handle.
	 */
	onPermissionRequired(
		listener: (call: ClassifierCall, decision: SafetyDecision, meta: PermissionRequiredMeta) => void,
	): () => void;
	/**
	 * Subscribe to the safety judge's hold on a started call: `judging` when a
	 * review that asks a model begins, `admitted` when its allow lets the body
	 * run. A park answers with `onPermissionRequired` and a block settles the
	 * call, so neither needs a state here. Returns an unsubscribe handle.
	 */
	onAdmissionReview?(listener: (event: AdmissionReviewEvent) => void): () => void;
	/**
	 * Subscribe to the moment an admitted call's body starts, keyed by the engine's tool call id: past admission, the
	 * safety judge and any approval. Returns an unsubscribe handle.
	 */
	onToolBodyStart?(listener: (toolCallId: string) => void): () => void;
	/**
	 * Subscribe to the reminders synchronous after_tool middleware emitted for a call, for the session that delivers
	 * them at the tool-batch boundary. Returns an unsubscribe handle.
	 */
	onToolBoundaryReminders?(
		listener: (reminders: ReadonlyArray<ToolBoundaryReminder>, input: MiddlewareHookInput) => void,
	): () => void;
}

/** An `inject_reminder` emitted at after_tool, with the rule that emitted it. */
export interface ToolBoundaryReminder {
	message: string;
	ruleId: string;
	severity?: MiddlewareReminderSeverity;
	audience?: "model";
}

/** One step of the safety judge's hold on a started call, keyed by the engine's tool call id. */
export interface AdmissionReviewEvent {
	toolCallId: string;
	state: "judging" | "admitted";
}

/** How a parked call ended without an approval. */
export interface ParkCancelOptions {
	/** Someone answered the ask and refused the call. Absent means the ask was cancelled unanswered. */
	denied?: boolean;
	/**
	 * With `denied`: nobody answered within `safety.unattendedAfterSeconds`, so
	 * PanCode refused the call itself (#421). Like a headless refusal, nobody
	 * could approve an identical call later in the turn, so the registry
	 * remembers it and refuses the repeat without parking it again.
	 */
	unattended?: boolean;
}

export interface ExecutionProvenance {
	executionStarted?: true;
	/** Actual delegated admissions, not the gateway envelope's read-class admission. */
	executionDecisions?: ReadonlyArray<SafetyDecision>;
}

export type RegistryVerdict =
	| ({ kind: "ok"; result: ToolResult; decision: SafetyDecision } & ExecutionProvenance)
	| ({
			kind: "blocked";
			reason: string;
			decision: SafetyDecision;
			/**
			 * The call parked for approval and the park was answered without one:
			 * denied (by an operator, or by a headless run that has none) or
			 * cancelled. Set by `parkAnsweredBlockedVerdict` only. Consumers key on
			 * this instead of the reason text, which the loop guard replaces on a
			 * repeated denied call.
			 */
			deniedPark?: true;
			/** The guard withheld a duplicate of a call that already succeeded (`block_tool.redundantRepeat`). */
			redundantRepeat?: true;
			/**
			 * Which layer refused the call and what would allow it. Set on the main
			 * agent's refusals that an identical repeat cannot change; the registry
			 * refuses that repeat in the same turn without running or asking again.
			 */
			denial?: ToolDenial;
	  } & ExecutionProvenance)
	| { kind: "not_visible"; reason: string };

export type HostReadOnlySource = "run" | "acp-server" | "acp-ceiling";
