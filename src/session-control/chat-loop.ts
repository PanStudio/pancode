// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { enterAutonomousCommitScope } from "../core/git-commit-attribution.js";
import { JobClockExpired } from "../core/job-types.js";
import type { SandboxAvailability } from "../core/sandbox/types.js";
import { createConversationEggs } from "../domains/session/easter-eggs.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import type { SealedCompletion } from "../tools/finish.js";
import type {
	MachineTurnProjectionAdmission,
	MachineTurnProjectionHost,
	MachineTurnRequest,
	MachineTurnResult,
} from "./job-turn-types.js";
import type { TurnControlRunner } from "./turn-control-runner.js";

export { runOutOfTurnRound } from "./side-question.js";
export { createTurnControlRunner } from "./turn-control-runner.js";

import type { RouteName, RouteSource } from "../core/route-provenance.js";
import type { LiveBudgetView } from "../domains/context/budget/live-view.js";
import type { WorkerContextSnapshot } from "../domains/context/worker/contract.js";
import { captureWorkerContext } from "../domains/context/worker/snapshot.js";
import type { MemoryInterventionRegistration } from "../domains/memory/intervention-types.js";
import type { MemoryPromptRequest } from "../domains/memory/prompt-cache.js";
import { replaceEngineMessages } from "../engine/agent.js";
/**
 * The chat loop: one turn's state machine.
 *
 * Composition of single-owner turn modules:
 *   - turn-runtime.ts      target resolution, hot-swap, agent + event pipeline
 *   - turn-context.ts      prompt compile cache, snapshots, compaction
 *   - turn-persistence.ts  session-ledger appends
 *   - turn-queues.ts       steer/follow-up mirror, stranded-steer resubmit
 *   - turn-recovery.ts     overflow compact-and-retry, transient retry chain
 *   - turn-middleware.ts   turn hooks and the reminder buffer
 *
 * This file owns the ChatLoop public surface, the submit/cancel state
 * machine, and the shared ChatTurnState the modules coordinate through.
 */

import { realpathSync } from "node:fs";
import type { PancodeSettings } from "../core/config.js";
import {
	evaluateSkillToolSurface,
	type PendingSkillRequest,
	type SkillSurfaceChange,
	skillSurfaceNames,
} from "../core/skill-activation.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { TurnAbortSource } from "../core/telemetry/live-events.js";
import {
	narrowTurnConstraints,
	snapshotTurnConstraints,
	type TurnConstraints,
	toolSurfaceSources,
} from "../core/turn-constraints.js";
import type { TurnOrigin, TurnToolCall } from "../core/turn-origin.js";
import type { NotificationLevel } from "../core/views/notice-words.js";
import type { BudgetInspection } from "../domains/context/budget/inspection.js";
import type { DispatchContract } from "../domains/dispatch/index.js";
import type { PinnedContextBlock } from "../domains/extensions/pinned-context.js";
import {
	type CompletionFact,
	createMiddlewareToolChoiceControl,
	type MiddlewareContract,
	type MiddlewareRegistrar,
	type MiddlewareToolChoiceControl,
} from "../domains/middleware/index.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import type { AutonomyHalt, AutonomyStatus } from "../domains/safety/autonomy-window.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import type { CompactInput, CompactResult } from "../domains/session/compaction/compact.js";
import type { ContextLedger } from "../domains/session/context-ledger.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { protectedArtifactStateFromSessionEntries } from "../domains/session/protected-artifacts.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";
import { createEngineAgent } from "../engine/agent.js";
import type { AgentEvent, AgentMessage, ImageContent } from "../engine/types.js";
import type { AutonomyLevel } from "../lib/autonomy/autonomy.js";
import { ensureDetailLedgerForSession } from "../tools/extension-runtime-tools.js";
import type { AskUserToolPolicy, ToolInvokeOptions, ToolRegistry } from "../tools/registry-contract.js";
import type { VisionSidecar } from "../tools/vision-sidecar.js";
import type { ApprovalRequestView } from "./approval-request-view.js";
import { createChatLoopCancel } from "./chat-loop/cancel.js";
import { createChatLoopContextCommands } from "./chat-loop/context-commands.js";
import { createChatLoopNotices } from "./chat-loop/notices.js";
import { createTurnPreparation } from "./chat-loop/preparation.js";
import { createChatLoopRouteMove } from "./chat-loop/route-move.js";
import { createChatLoopSideRounds } from "./chat-loop/side-rounds.js";
import { createChatLoopToolOptions, toolInvokeOptions } from "./chat-loop/tool-options.js";
import { createChatLoopBus } from "./chat-loop-bus.js";
import { createChatLoopComposition } from "./chat-loop-composition.js";
import type { ChatLoopScope } from "./chat-loop-scope.js";
import { createChatLoopStateMachine } from "./chat-loop-state-machine.js";
import { createChatLoopSteering } from "./chat-loop-steering.js";
import { createChatLoopSubmit } from "./chat-loop-submit.js";
import type { HandoffRepairInput } from "./handoff-round.js";
import { continuityRenderTime } from "./model-session-replay.js";
import type { NoticeSource } from "./notice-source.js";
import type { OperatorMemoryChip, OperatorMemoryCommands, OperatorMemoryStorePort } from "./operator-memory.js";
import { type OutOfTurnRoute, runSideQuestion } from "./side-question.js";
import type { AgentStatusEvent, ModelRequestFacts } from "./status-types.js";
import type { TriageSystemOne } from "./steering-triage.js";
import type { LiveContextUsage, TurnContextDeps } from "./turn-context.js";
import type { TurnOutcomeCollector } from "./turn-outcome-collector.js";
import type { PrewarmOutcome } from "./turn-prewarm.js";
import type {
	QueuedChatMessage,
	QueuedMessageKind,
	QueuedMessagesSnapshot,
	QueueRemovalReason,
	SteeringMode,
} from "./turn-queues.js";
import type { RetryForecast, RetryStatusEvent } from "./turn-recovery.js";
import type { AssistantDeltaEvent } from "./turn-runtime-types.js";
import {
	type AgentRuntime,
	type ChatLoopRunSnapshot,
	createTurnState,
	type TurnPreparationPhase,
	type TurnPreparationStep,
} from "./turn-state.js";

export type { QueuedChatMessage } from "./turn-queues.js";
export type { MovedRoute, RetryStatusPayload, RetryStatusPhase } from "./turn-recovery.js";
export type { ChatLoopRunSnapshot } from "./turn-state.js";

interface QueueUpdateEvent {
	type: "queue_update";
	messages: QueuedChatMessage[];
}

/**
 * A queued steer or follow-up the engine just injected into the run. Emitted
 * at injection time (never at enqueue time) so the transcript shows the user
 * turn exactly when the model sees it, mirroring the pi-coding-agent flow
 * where a pending message leaves the queue panel and enters the chat in the
 * same beat. Enqueue time shows the text only in the steering-queue panel.
 */
interface QueuedUserTurnEvent {
	display?: { text: string; note?: string };
	origin?: string;
	type: "queued_user_turn";
	text: string;
	/** `interrupt` marks a message that cancelled the run and was submitted as a fresh prompt. */
	kind: QueuedChatMessage["kind"] | "interrupt";
}

/**
 * First-class advisory event. `surface` says where the notice belongs:
 * "transcript" notices are turn-adjacent chat lines (cancellations,
 * compaction summaries, configuration errors) and "footer" notices are
 * ambient status (nudge chips). Notices are never assistant messages: they
 * carry no `message_end`, cannot become a headless turn's answer, and never
 * end a run.
 */
export interface ChatNoticeEvent {
	type: "notice";
	level: NotificationLevel;
	surface: "footer" | "transcript";
	text: string;
	key?: string;
	/**
	 * Present only on a notice that reports a turn PanCode refused to start. The
	 * `reason` is a closed-set code, not prose: protocol surfaces (the ACP
	 * server) fail the turn with it instead of returning an empty success, and
	 * every other surface renders the notice exactly as before.
	 */
	admission?: { reason: string };
	/** Present only on the notice that entries wait in a held queue; the TUI names its bound keys. */
	heldQueue?: { count: number };
	/** Present only on the notice that a session change took these operator messages unsent; the TUI returns them to the composer. */
	queueDropped?: { texts: string[] };
	/**
	 * Present only on a notice about the skill tool surface. The TUI transcript
	 * states it as a `§` row (or, for a load that narrows nothing, not at all,
	 * since the load's own row says so); every other surface renders the text.
	 */
	skillSurface?: SkillSurfaceChange;
	/**
	 * Present only on the footer notice that the next response's prompt cache
	 * may be cold, naming why (`prompt_recompiled`, `dispatch`, …). The TUI
	 * transcript keeps them for the run and the Detailed receipt states them.
	 */
	coldReasons?: ReadonlyArray<string>;
	/**
	 * Present only on the transcript notice that closes a turn the operator
	 * cancelled. The level stays `warning` for headless and protocol surfaces;
	 * the TUI transcript marks it cancelled, as the footer verb does.
	 */
	operatorCancel?: true;
	/**
	 * Present only on the answer to a command the operator typed, such as /context compact. The TUI
	 * transcript wraps it whole as it does other command output, where an event keeps one row.
	 */
	commandReply?: true;
	/**
	 * Present only on the transcript notice that closes a turn an interrupt cut
	 * short to deliver a new message, or that a budget roll stopped at its tool
	 * boundary (XR-6): a run follows, so the turn was redirected and a headless
	 * or protocol host waits for that run instead of ending (bt-41).
	 */
	redirect?: true;
	/**
	 * Present only on an advisory, text addressed to the operator. The TUI
	 * transcript frames it under the source's title; every other surface renders
	 * the text. A notice without a source is an event and keeps its gutter row.
	 */
	source?: NoticeSource;
	/**
	 * Present only on the notice that reports an operator memory capture
	 * ("remember that ...", `# ...`, `/remember`). ACP carries it as
	 * `_meta["pancode/memory"]` so a client can draw the chip's actions.
	 */
	memory?: OperatorMemoryChip;
}

/**
 * Approval-lifecycle signal for a tool call that pi already started
 * (`tool_execution_start` fires before admission parks the body). The
 * interactive composition root emits it from the registry's
 * permission-required signal ("awaiting-approval") and from the operator's
 * one-shot grant ("resumed") so the chat panel can restyle the exact parked
 * segment instead of leaving a counting running line. Deny/cancel needs no
 * state here: the parked promise resolves blocked and the segment settles
 * through its ordinary `tool_execution_end`.
 */
export type ToolApprovalStateEvent =
	| {
			type: "tool_approval_state";
			toolCallId: string;
			state: "awaiting-approval";
			/**
			 * Already-redacted facts shown by the permission overlay. This payload
			 * exists only on the live event and is never written to the session
			 * ledger; the transcript renderer must not reconstruct safety facts
			 * from raw tool arguments.
			 */
			view: ApprovalRequestView;
			/**
			 * The card for this call is on the dock, so the transcript row keeps
			 * only its head: the dock already shows the target and the reason.
			 */
			docked?: boolean;
	  }
	| {
			type: "tool_approval_state";
			toolCallId: string;
			/**
			 * `judging`: the safety judge holds the call before admission, so it is
			 * not running yet. `resumed`: the call was admitted, by the operator's
			 * grant or the judge's allow, and its body runs from here.
			 */
			state: "judging" | "resumed";
			/** On `resumed`: who allowed it when that was not the operator at this terminal, as `attach c2 (apr)`. */
			grantedBy?: string;
	  };

export type ChatLoopEvent = (
	| AgentEvent
	| AssistantDeltaEvent
	| RetryStatusEvent
	| QueueUpdateEvent
	| QueuedUserTurnEvent
	| ChatNoticeEvent
	| AgentStatusEvent
	| ToolApprovalStateEvent
) & {
	modelTimeMs?: number;
	/**
	 * On a `message_end` or `agent_end` that closes a failed attempt: the attempt recovery will try next. The failure is
	 * then an event of a turn still underway, not that turn's outcome.
	 */
	retryPending?: RetryForecast;
};

export interface PromptSubmitInput {
	/** What the operator typed: the template invocation when one expanded. */
	typed: string;
	/** Who started this turn: an operator prompt, PanCode's continuation of a stopped turn, a job or a peer. */
	origin: TurnOrigin;
	/** What the model would receive. */
	text: string;
}

type PromptSubmitVerdict = { kind: "pass"; text: string } | { kind: "block"; reason: string };

export interface ChatSubmitOptions {
	/** Host-only fresh delivery. Its text never enters steering/editor queues (#411). */
	machineTurn?: {
		preparationToken: object;
		onStarting(): boolean;
		onSettled(result: MachineTurnResult): void;
	};
	/** Explicit host-owned task scope; never parsed from the prompt text. */
	constraints?: TurnConstraints;
	/** Presentation only; never part of the model message or persisted text. */
	display?: { text: string; note?: string };
	/**
	 * Set when this turn was not typed by the operator: who sent it, in words.
	 * Persisted on the user turn and carried through the queue, so the
	 * transcript and any replay attribute it. Never parsed, never sent to the
	 * model.
	 */
	origin?: string;
	/** An `origin` turn whose text the operator wrote (an operator loop's own task); the safety judge reads it. */
	operatorAuthored?: boolean;
	/** Rechecked after admission awaits; a retired peer inbox cannot start a turn. */
	isAdmissionCurrent?: () => boolean;
	/** Host-owned run identity, scoped to this submit and its internal continuations. */
	hostRun?: ToolInvokeOptions["hostRun"];
	images?: ReadonlyArray<ImageContent>;
	/** Files already expanded into this session's working context. */
	workingContextPaths?: ReadonlyArray<string>;
	/** Skill requests parsed by the harness for this turn. Not recorded as loaded until the skill body loads. */
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	/** Internal middleware resubmit; does not reset the per-user-prompt stalled-turn nudge cap. */
	requestContinuation?: boolean;
	/** A yolo continuation of a stopped turn; does not reset the count against its cap (#445). */
	yoloContinuation?: boolean;
	/** That continuation's place against `TURN_CONTINUATION_CAP`, for hooks that read the turn's origin. */
	yoloContinuationAttempt?: number;
	/** The last tool call the stopped turn made, which the continuation's prompt_submit hooks read (WTF-P 0.8.3 B6). */
	continuationToolCall?: TurnToolCall;
	/**
	 * Delivery mode when a run is active; ignored when idle. Defaults to
	 * `next-slot`. `interrupt` cancels the run, waits for it to settle, and
	 * submits the text as a fresh prompt; see {@link ChatLoop.interruptRefusal}
	 * for the two states in which it degrades to `next-slot` instead.
	 */
	steering?: SteeringMode;
	/** The interrupt is triage's, not the operator's: the run it cuts short is redirected, not cancelled (bt-41). */
	triageInterrupt?: boolean;
	/** This prompt is an entry taken off the queue: it returns to the head if the prompt never starts (#447). */
	queued?: QueuedChatMessage;
	/** This prompt is a message taken off the queue by a path that does not return it; its recorded path continues. */
	continuesMessage?: Pick<QueuedChatMessage, "id" | "enqueuedAt">;
	/** Carry the rest of the queue with this prompt's first model call, instead of at its first slot. */
	flushQueue?: boolean;
	/**
	 * While a run is active, queue a constrained submission to start as its own
	 * turn when the run settles instead of refusing it. The interactive Enter
	 * path sets it; a send-now still interrupts, and a caller that needs the
	 * turn's answer (ACP, headless) keeps the refusal.
	 */
	queueConstrainedTurn?: boolean;
	/**
	 * Queue the message at the head of the steering queue instead of the tail:
	 * a send-now the operator chose to wait with, or one the run refused.
	 */
	queueFront?: boolean;
	/**
	 * Commits the presentation of a consumed prompt after preparation opens and
	 * before admission work can make the turn durable. Interactive uses this to
	 * guarantee that even a fast probe or prompt compile paints one pending
	 * frame instead of opening and closing entirely between renderer ticks.
	 */
	onPreparationVisible?: () => Promise<void>;
	/**
	 * Fires when a submission with `constraints` arrives while a turn is live
	 * and is refused instead of queued, so the editor that consumed it can put
	 * the draft back rather than report it as queued.
	 */
	onRefused?: (reason: string) => void;
	/**
	 * Fires once this submit owns the live turn (`isStreaming()` is true) and
	 * the next queued submit may use streaming queue routing. Stage 0 replay
	 * awaits it; the loop's own admission gate releases on it.
	 */
	onAdmitted?: () => void;
}

/**
 * Options for {@link ChatLoop.cancel}. A bare cancel is an operator Esc/Ctrl+C
 * that ends the in-flight turn as an empty aborted message. Passing a `reason`
 * marks the cancel as an explained interrupt (the loop guard, or an operator
 * interrupt-with-message): the chat loop persists a durable, visible assistant
 * turn carrying that reason in place of the empty aborted turn, and tags the
 * `turn.aborted` event with `source`.
 */
/** What the chat loop needs of the autonomous window. */
interface ChatAutonomyWindow {
	halted(): AutonomyHalt | null;
	/** An operator prompt is starting: a fresh window, clearing any halt. */
	operatorSpoke(): void;
	turnStarted(): void;
	turnSettled(): void;
	/** The window's counts for the footer; null below yolo. */
	status?(): AutonomyStatus | null;
}

export interface ChatCancelOptions {
	/** Operator-facing explanation for a system-initiated stop. */
	reason?: string;
	/** Source of the emitted `turn.aborted` event. Defaults to "stream_cancel". */
	source?: TurnAbortSource;
	/** Short reason carried by the live `turn.aborted` payload. Defaults to a source-appropriate phrase. */
	auditReason?: string;
	/**
	 * Stop at the next tool boundary instead of now: a tool batch already
	 * requested runs to settlement, and the turn stops before its next model
	 * request. An extension write aborted mid-call can be left half applied (F-C16).
	 */
	atToolBoundary?: boolean;
}

export interface SideQuestionOptions {
	/** Cancels the round. Esc and Ctrl+C in the overlay abort through it. */
	signal?: AbortSignal;
	/** Streamed answer text so the overlay fills as the provider produces it. */
	onDelta?: (partialText: string) => void;
	/** The route the round was admitted on, before any answer arrives. */
	onRoute?: (route: OutOfTurnRoute) => void;
}

export interface DraftOptions {
	/** Cancels every candidate round. */
	signal?: AbortSignal;
	/** One candidate's streamed text, by index in start order. */
	onCandidate?: (index: number, partialText: string) => void;
	/** The route the candidates were admitted on, before any text arrives. */
	onRoute?: (route: OutOfTurnRoute) => void;
}

/** One `/draft` candidate: its text, or why its round produced none. */
export type DraftCandidate = ({ status: "drafted"; text: string } | { status: "failed"; reason: string }) & {
	route?: OutOfTurnRoute;
};

export type DraftOutcome =
	| { status: "drafted"; candidates: DraftCandidate[]; aborted: boolean }
	| { status: "refused"; reason: string };

export interface HandoffRoundOptions extends SideQuestionOptions {
	/**
	 * Run the second and last extraction round, quoting the parser's complaint
	 * and what the first round returned. Both rounds are journaled calls under
	 * the handoff agent role (issue #223, #434).
	 */
	repair?: HandoffRepairInput;
}

/**
 * How a `/btw` round ended. `refused` is a round that never started (a turn was
 * in flight, or no orchestrator target is configured); `failed` is a round that
 * started and the provider rejected.
 */
export type SideQuestionOutcome =
	| { status: "answered"; text: string; route?: OutOfTurnRoute }
	| { status: "aborted"; text: string }
	| { status: "refused"; reason: string }
	| { status: "failed"; reason: string };

/**
 * `first-output` and `retry-wait` are the two waits a pick can still move: a request out with nothing back, and no
 * request out between attempts. The rest keep the pick for the next turn. `elsewhere` is everything that is not a model
 * call, such as admission or compaction.
 */
export type RouteMoveWait = "idle" | "first-output" | "retry-wait" | "output" | "tool" | "elsewhere";

export type RouteMoveFit =
	| { kind: "fits" }
	| { kind: "same" }
	| { kind: "too-large"; neededTokens: number; window: number }
	| { kind: "images" }
	| { kind: "unresolved"; reason: string };

export type RouteMoveResult =
	| { kind: "idle" }
	| { kind: "same" }
	| { kind: "moved"; wait: "first-output" | "retry-wait" }
	| { kind: "next-turn"; wait: RouteMoveWait; fit?: Exclude<RouteMoveFit, { kind: "fits" } | { kind: "same" }> };

export interface ChatLoop {
	/** Live operator adapters call this before expansion; internal submits never discover eggs. */
	discoverOperatorEgg?(text: string, ask?: AskUserHandler): Promise<boolean>;
	/** Whether these skill requests are refused in this session, with the notice shown. An install offer asks this first. */
	refuseSkillRequests?(requests: ReadonlyArray<PendingSkillRequest>, inlinedPaths: ReadonlyArray<string>): boolean;
	activeEggs?(): readonly string[];
	eggsCommand?(action: "status" | "off", id?: string): string;
	submit(text: string, options?: ChatSubmitOptions): Promise<void>;
	/** `/remember` and the capture chip's actions: change scope, undo. */
	operatorMemory?: OperatorMemoryCommands;
	submitMachineTurn?(request: MachineTurnRequest): Promise<MachineTurnResult>;
	/** Bound attended hosts project this ordinary turn through their existing lifecycle (#411). */
	bindMachineTurnProjection?(host: MachineTurnProjectionHost): () => void;
	machineTurnAvailable?(): boolean;
	currentTurnConstraints?(): TurnConstraints | undefined;
	/**
	 * Bind a session schema ceiling, or narrow admission for the current prompt
	 * without changing the standing prompt inputs and schemas (#423).
	 */
	setToolCeiling?(
		ceilings: ReadonlyArray<TurnConstraints | undefined>,
		lifetime?: "session" | "prompt",
	): TurnConstraints | undefined;
	/** The effective host limits, including a prompt ceiling, for work started outside a turn (#423). */
	toolLimits?(): TurnConstraints | undefined;
	/** Effective creating/current task and skill ceiling for session-owned jobs (#411). */
	jobConstraints?(): TurnConstraints | undefined;
	/** `display.note` names who sent a steer that is not the operator's own, painted when the engine takes it. */
	steer(text: string, display?: { text: string; note?: string }): boolean;
	queueFollowUp(text: string, display?: { text: string; note?: string }, origin?: string): boolean;
	/** The queued entries still in PanCode's hands, in delivery order. */
	queueEntries(): QueuedChatMessage[];
	/** Remove one queued entry; returns it, or null when it already left the queue. `reason` is recorded, never acted on. */
	removeQueuedEntry(id: string, reason?: QueueRemovalReason): QueuedChatMessage | null;
	/** Move one queued entry up (-1) or down (+1) in delivery order. */
	moveQueuedEntry(id: string, delta: -1 | 1): boolean;
	/** The operator's choice of slot for one entry; pins it against producers. */
	setQueuedEntryKind(id: string, kind: QueuedMessageKind): boolean;
	/**
	 * Why an interrupt would be refused right now, or null when it would
	 * cancel the run. An attached dispatch is refused because the parent's abort
	 * kills the worker's run and discards its work with no receipt; a parked
	 * permission ask is refused because it is already waiting on the operator.
	 * In both cases `submit(text, { steering: "interrupt" })` says so and
	 * queues the text for the next slot instead.
	 */
	interruptRefusal(): string | null;
	/**
	 * Continue a yolo run the autonomous window paused, on the operator's
	 * keypress: a fresh window, then a continuation turn. False when nothing
	 * is paused or a run is active.
	 */
	resumeAutonomy(): boolean;
	/** The autonomous window at yolo, for the footer; null below yolo or when unwired. */
	autonomyStatus(): AutonomyStatus | null;
	/**
	 * `/skill off`: drop the tool surface an activated skill armed, so the next
	 * turn runs with the full surface again. Returns the skill names that were
	 * armed, or an empty list when nothing was.
	 */
	clearSkillSurface(): ReadonlyArray<string>;
	/** Skills whose tool surface is armed across turns right now; the footer shows them. */
	activeSkillSurface(): ReadonlyArray<string>;
	clearQueuedFollowUps(): string[];
	/** The texts {@link clearQueuedFollowUps} would return now, read without draining. */
	restorableQueuedTexts(): string[];
	queuedMessages(): QueuedMessagesSnapshot;
	cancel(options?: ChatCancelOptions): void;
	onEvent(handler: (event: ChatLoopEvent) => void): () => void;
	getSessionId(): string | null;
	captureWorkerContext?(): WorkerContextSnapshot | null;
	lastRunSnapshot?(): ChatLoopRunSnapshot | null;
	/** How the last turn ended as the host sealed it (fleet design 4.3); null before a turn ends. */
	lastTurnCompletion?(): SealedCompletion | null;
	/** How the last step pipeline ended, or null when the last prompt ran none (bt-15). */
	stepPipeline?(): StepPipelineEnd | null;
	isStreaming(): boolean;
	/** Tool calls the run has started and not yet finished. */
	runningToolCalls(): number;
	/**
	 * Where a consumed prompt currently is between the editor and the stream.
	 * The composer and the footer read it so the window in which the prompt has
	 * been taken but the turn has not been admitted is never rendered as idle
	 * (issue #251).
	 */
	turnPreparation(): {
		phase: TurnPreparationPhase;
		since: number;
		stage?: { step: TurnPreparationStep; since: number } | null;
	};
	/** Evidence about the newest model request, for a surface that reports a silent wait. */
	modelRequest(): ModelRequestFacts | null;
	/** What the running turn is waiting on, which decides whether a route pick moves its request. */
	routeMoveWait?(): RouteMoveWait;
	/** Whether the running turn's request could go to this route. */
	routeMoveFit?(route: { target: string; model: string }): RouteMoveFit;
	/** Whether the next request on this route would leave the route the session's cached prefix belongs to (#434). */
	routeLeavesCache?(route: { target: string; model: string }): boolean;
	/** Send the waiting request to the route settings now name, if it still can go. Call after the pick is applied. */
	moveWaitingRequest?(): RouteMoveResult;
	/** Fires on every preparation transition, including back to `idle`. */
	onTurnPreparation(handler: (phase: TurnPreparationPhase) => void): () => void;
	contextUsage(): LiveContextUsage;
	/**
	 * Categorized context-window ledger for the `/context` overlay: where every
	 * occupied token lives (system prompt, tools, agents, skills, memory,
	 * messages), the autocompact reserve, and free space. Composes the live
	 * estimate with the current turn's prompt segment manifest.
	 */
	contextLedger(): ContextLedger;
	/**
	 * The live agent messages and when the operator last spoke, epoch milliseconds, for a
	 * reading of what entered the run since then. Role cannot say: reminders and continuations
	 * are user messages too. Null with no runtime.
	 */
	screenWindow(): { messages: ReadonlyArray<AgentMessage>; since: number } | null;
	/**
	 * The published live budget for the next request: one immutable view with
	 * the effective window, the structural accounting, the real output
	 * reservation, headroom, pressure, and an opaque revision every consumer
	 * quotes. A pure read of what the producer last published; it never rescans
	 * the conversation, calls a model, persists anything, or triggers reduction.
	 */
	liveBudget(): LiveBudgetView;
	inspectLiveBudget(): BudgetInspection;
	/**
	 * Republish the live budget before making a decision from it, for a consumer
	 * that may be observing results appended since the last publication. The
	 * only thing it mutates is the accounting cache.
	 */
	refreshLiveBudget(): LiveBudgetView;
	/**
	 * Force-run the compaction flow for the current session, swap the agent's
	 * in-memory `state.messages` for a single bridge message carrying the
	 * summary, and emit the standard summary notice. Used by `/context compact`
	 * slash command so the next user turn ships only the bridge plus the new
	 * text to the provider. When no session or compaction dependencies are
	 * wired, it skips compaction and emits a user-visible
	 * notice so the `/context compact` handler does not have to mirror the logic.
	 */
	compact(instructions?: string): Promise<void>;
	requestSelfCompact(note: unknown, toolCallId: string, signal?: AbortSignal): Promise<string>;
	recoverHandoff(handoffId: string, action: "reduce" | "deliver"): Promise<void>;
	/**
	 * `/btw`: answer one side question against the session's active target,
	 * model, and compiled message history without starting a turn.
	 *
	 * Nothing this produces reaches the session ledger, the transcript, the
	 * context ledger, or the footer token counters; the message history is read,
	 * never mutated. The round's provider usage is still reported to `/usage`,
	 * labeled as a side question, because money was spent. Refused outright
	 * while a turn is in flight rather than queued.
	 */
	askSideQuestion(question: string, options?: SideQuestionOptions): Promise<SideQuestionOutcome>;
	/**
	 * `/draft`: run `count` candidate rounds for one request in parallel against
	 * the session's active target, each at its own temperature.
	 *
	 * Out of turn exactly as a side question is: the history is read and never
	 * mutated, nothing reaches the session, and each round's usage is billed to
	 * `/usage` as a side question. A round that fails reports why in its slot
	 * rather than failing the others.
	 */
	draftCandidates(request: string, count: number, options?: DraftOptions): Promise<DraftOutcome>;
	/**
	 * `/handoff`: run the extraction round for a goal against the same target,
	 * model, and compiled message history, and return its raw JSON answer.
	 *
	 * Like a side question this is out of turn: no tools are sent, the message
	 * history is read and never mutated, and nothing the round produces reaches
	 * the ledger. Validating, bounding, and reviewing the answer belong to the
	 * caller; this method only owns the provider call. Refused outright while a
	 * turn is in flight rather than queued.
	 */
	extractHandoff(goal: string, options?: HandoffRoundOptions): Promise<SideQuestionOutcome>;
	/**
	 * Drop or replace the chat-loop's in-memory state after a session switch
	 * (/resume, /fork, /new). `leafTurnId` is the id the next user turn
	 * should parent under. `replayMessages` is the provider context rebuilt
	 * from the selected session entries; omit it for a fresh session.
	 */
	resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void;
	/** Synchronous reset barrier, including an empty /new; ordinary first-turn creation does not fire it. */
	onSessionReset?(handler: () => void): () => void;
	/**
	 * Resolves once the queued or in-flight session pre-warm has settled, with
	 * the outcome, or null when none ran. Diagnostics and contracts only: no
	 * turn path waits on a pre-warm.
	 */
	whenPrewarmSettled(): Promise<PrewarmOutcome | null>;
	/**
	 * Resolves once the last navigation has built the route, tools and session prompt its next request would carry
	 * and republished the context view from them, so a reopen reports what live would (SPEC §0). Makes no call.
	 */
	nextRequestReady(): Promise<void>;
	/** Abort the live agent and release pi-ai session-scoped resources before shutdown. */
	dispose(): void;
	/**
	 * Resolves once the in-flight submit (if any) has fully settled, including
	 * the aborted run's tool results and their ledger appends. Shutdown awaits
	 * this after dispose() so domains (the session writer among them) never
	 * stop while the turn is still persisting: `session.append` after session
	 * stop is impossible by ordering.
	 */
	whenSettled(): Promise<void>;
}

export interface CreateChatLoopDeps {
	eggAsk?: AskUserHandler;
	turnControl?: TurnControlRunner;
	/** Already registered by the caller; without one the loop registers its own through `middlewareRegistrar`. */
	turnOutcomeCollector?: TurnOutcomeCollector;
	/** Facts the host seals on an ended turn beside the middleware's, such as the finish contract's on a declared partly_done. */
	hostCompletionFacts?: () => ReadonlyArray<CompletionFact>;
	/** The registration capability the loop's own outcome collector needs; only its constructor holds it. */
	middlewareRegistrar?: Pick<MiddlewareRegistrar, "registerHook">;
	getTaskEstablished?: () => boolean;
	outcomeDispatch?: Pick<DispatchContract, "getRun">;
	memoryCommitBridge?: MemoryInterventionRegistration | undefined;
	interactiveGuidance?: boolean;
	/** An ACP client that advertised interviews: the prompt offers ask_user without the TUI-only guidance. */
	operatorInterviews?: boolean;
	/**
	 * The session's standing tool limits (`pancode --allow-tools`, `pancode acp
	 * --allow-tools`). Every turn's constraints are narrowed by them, and the
	 * tool surface holds them between turns, so a prewarmed runtime and a
	 * continuation see the same limit.
	 */
	sessionToolLimits?: TurnConstraints;
	/**
	 * True for a headless `pancode run`. Its permission listener denies every
	 * approval ask, so the session prompt says so instead of promising a pause.
	 */
	headless?: boolean;
	/** False when no operator message can arrive mid-run (a headless run without a steer channel). */
	liveSteering?: boolean;
	/** How long a queued steer lets an interruptible tool call run before it ends it (FX-32); contracts shorten it. */
	steerInterruptGraceMs?: number;
	/** This host's sandbox backend; absent, the session prompt claims no sandbox. */
	sandboxAvailability?: () => SandboxAvailability;
	scheduling?: SchedulingContract;
	getSettings: () => Readonly<PancodeSettings>;
	/**
	 * The same effective autonomy level registry admission resolves, so the
	 * skill-activation gate and the tool gate can never disagree. Absent falls
	 * back to the settings value.
	 */
	getAutonomy?: () => AutonomyLevel;
	/**
	 * The autonomous window (ob-yolo D6). While it holds a halt every turn PanCode
	 * would send itself is refused; an operator prompt reopens it.
	 */
	autonomy?: ChatAutonomyWindow;
	providers: ProvidersContract;
	/** Optional independent image model, bound to fleet.profiles.vision. */
	visionSidecar?: VisionSidecar;
	/**
	 * Whitelist of target ids that the chat-loop is allowed to drive. The
	 * orchestrator composes this from `providers.list()` so an unknown
	 * `settings.chat.target` surfaces a configuration error before
	 * the agent is constructed.
	 */
	knownTargets: () => ReadonlySet<string>;
	session?: SessionContract;
	/**
	 * Prompt compiler. When wired, the session system prompt is compiled once
	 * per session and applied to Pi’s system transcript baseline; recompiles happen
	 * only on explicit events (model/target change, safety-level change,
	 * config hot-reload, session switch).
	 *
	 * Optional so unit tests can inject stubs and a degraded boot (prompts
	 * failed to load) still runs with the built-in identity fallback below.
	 * In production this is always wired by `entry/orchestrator.ts`.
	 */
	prompts?: PromptsContract;
	createAgent?: typeof createEngineAgent;
	/**
	 * The `/btw` round. Defaults to the real provider call; contracts inject a
	 * stub so they can assert what a side question does to the session without
	 * standing up a provider, exactly as `createAgent` does for a turn.
	 */
	runSideQuestion?: typeof runSideQuestion;
	/**
	 * Return the current session's entries for token estimation. The chat-loop
	 * calls this on every submit so the auto-compaction threshold sees the
	 * latest transcript. Returns an empty array when there is no current
	 * session or when the session contract is absent.
	 */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/**
	 * Information-flow admission of each model request; see TurnRuntimeDeps.admitFlow. It also admits
	 * /btw, /draft, /handoff and the pre-warm, which send the live runtime's history.
	 */
	admitFlow?: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	/** Labels the information-flow sources that `@file` references inlined into a submitted prompt. */
	labelReferencedPaths?: (paths: ReadonlyArray<string>) => void;
	/** Why an operator's context-handoff request, with the `@file` paths it inlines, may not run in this session, or null. */
	refuseHandoffSkill?: (inlinedPaths: ReadonlyArray<string>) => string | null;
	/**
	 * Run the compaction flow end-to-end (read entries, resolve model,
	 * summarize, persist a compactionSummary entry) and return the result,
	 * or null when the flow is a legitimate no-op (no entries or no cut
	 * crossed). Configuration, provider, read, and persistence failures reject
	 * so the activity path can report them as failures. Chat-loop invokes this from two sites:
	 *   1. Before every agent.prompt when the threshold is crossed or
	 *      PANCODE_FORCE_COMPACT=1 is set.
	 *   2. After catching a ContextOverflowError, as the first half of the
	 *      one-shot compact-and-retry recovery path.
	 * Both sites share an AutoCompactionTrigger so two fires in the same tick
	 * coalesce onto one summarization call.
	 */
	autoCompact?: (
		instructions?: string,
		trigger?: CompactionTrigger,
		budget?: Pick<
			CompactInput,
			| "providerCompaction"
			| "livePrefix"
			| "providerFallbackReason"
			| "providerReplayFallback"
			| "keepRecentTokens"
			| "preserveUserTurnId"
			| "skillContextState"
			| "signal"
			| "beforeSummaryCall"
			| "onSummaryOutput"
			| "checkpointForSummary"
			| "checkpointTokenFigures"
		>,
	) => Promise<CompactResult | null>;
	/** Optional telemetry sink for orchestrator chat token usage. */
	telemetry?: TelemetryContract;
	/**
	 * Production tool admission path. When wired, every agent-facing tool runs
	 * through `ToolRegistry.invoke(...)` so safety classification and
	 * confirmation admission happen on the actual execution path.
	 */
	toolRegistry?: ToolRegistry;
	/**
	 * Middleware hook surface. When wired, the chat-loop fires `turn_start`
	 * when a prompt is accepted (flushing accumulated `inject_reminder`
	 * effects into the request as a system-reminder block) and `turn_end`
	 * when the final assistant message of a run lands (finish contract,
	 * tool-prose loop). Optional so unit tests that exercise neither stay
	 * minimal.
	 */
	middleware?: MiddlewareContract;
	/**
	 * The awaited prompt_submit gate of extension runtime hooks, present only
	 * where a surface hosts their runtimes. It runs once per submission that
	 * starts a fresh turn, sees the line the operator typed rather than an
	 * expanded template body, and may refuse the turn or, when nothing
	 * expanded the line, rewrite it.
	 */
	promptSubmit?: (input: PromptSubmitInput) => Promise<PromptSubmitVerdict>;
	/**
	 * Shared next-round provider routing. The registry applies effects emitted
	 * by before_tool/after_tool; the chat loop applies turn hooks and consumes
	 * the resulting choice when it builds each request.
	 */
	middlewareToolChoice?: MiddlewareToolChoiceControl;
	/**
	 * Protected-artifact state handle, backed by the protected-artifacts hook
	 * registration at the composition root. The chat-loop replaces the state
	 * wholesale on session switch so protections follow the active session.
	 */
	protectedArtifacts?: {
		replace(state: ProtectedArtifactState): void;
		markDegraded(reason: string): void;
	};
	/**
	 * Shared event bus. When wired, `cancel()` emits `turn.aborted` with
	 * `source: "stream_cancel"`, journaled in the session for every
	 * Esc-on-stream / Ctrl+C cancel.
	 * Optional so unit tests that drive chat-loop in isolation do not need
	 * to construct a bus.
	 */
	bus?: TelemetryHub;
	/**
	 * Build the approved-memory prompt section for the current turn. Returns
	 * the empty string when no approved, evidence-linked, in-scope memory
	 * applies; otherwise returns a compact markdown section that the prompt
	 * compiler injects via the memory dynamic fragment. Optional so unit
	 * tests omit it when memory is irrelevant.
	 */
	getMemorySection?: (request: MemoryPromptRequest) => string;
	memoryEnabled?: () => boolean;
	/** Runs before any turn is written, so a ledger fact can precede the text it describes. */
	beforeTurnRecorded?: (session: SessionContract) => void;
	getMemoryRecordStatuses?: TurnContextDeps["getMemoryRecordStatuses"];
	/**
	 * The memory store an operator's "remember that ..." writes, lent by the
	 * memory runtime. Absent, typed memory keywords reach the model unchanged.
	 */
	operatorMemory?: OperatorMemoryStorePort;
	/** Told when an operator submits a task, before anything else about the turn runs. Never told about a continuation. */
	onOperatorTurn?: (input: { task: string }) => void;
	/** The operator request the run is working on, for the steering triage round. Absent, triage sends no task. */
	currentOperatorTask?: () => string;
	/** Typed steering triage when a route is bound. Absent or unbound, triage is the side-model round. */
	systemOne?: TriageSystemOne;
	getReadySkillCount?: () => number;
	/** The api 2 extensions' pinned context blocks; only a main session supplies them, so workers never see one. */
	pinnedContext?: () => ReadonlyArray<PinnedContextBlock>;
	/** Live source of each active route for the attended prompt (DF-7). */
	getRouteSources?: () => Readonly<Record<RouteName, RouteSource>>;
	/** Structured, redacted task-bank export supplied only to an explicit context-handoff skill request. */
	getTaskMemoryHandoffSource?: () => string;
	/**
	 * Hand the composition root a delivery path for reminders that background
	 * observers produce after their turn boundary closed. Called once during
	 * composition; the loop owns the buffer the reminder lands in.
	 */
	registerDeferredReminderSink?: (sink: (message: string, isCurrent?: () => boolean) => void) => void;
	onMemoryRequestSubmitted?: ((messages: readonly AgentMessage[], systemPrompt?: string) => void) | undefined;
	/**
	 * The same seam for findings that are for the operator rather than the model.
	 * The watchdog uses it: its run settles after the turn it reviewed, and its
	 * blockers become one transcript notice that never enters model context.
	 */
	registerDeferredNoticeSink?: (sink: (text: string) => void) => void;
	/**
	 * Host-finalizer seam for branch-anchored interview snapshots. Called once,
	 * after the ask-user host finalizer has settled the policy and its transcript.
	 */
	onAskUserFinalized?: (policy: AskUserToolPolicy) => void;
	/**
	 * True while an attached `dispatch` call is running. An interrupt is refused
	 * in that state; the composition root wires this from the dispatch
	 * background registry, which holds exactly the attached calls.
	 */
	hasAttachedDispatch?: () => boolean;
	/**
	 * True on a surface where a person is about to type the next turn. The
	 * orchestrator wires this false for headless `run`: the pre-warm buys latency
	 * that an unattended run never spends. Defaults to true.
	 */
	isLatencySurface?: () => boolean;
	/** An editor draft already owns the next foreground request. */
	isPrewarmBusy?: () => boolean;
	/**
	 * Claim one in-flight request on the pre-warm's endpoint for the duration of
	 * the round. Wired from the endpoint-capacity registry once #250 lands, so a
	 * pre-warm counts against the same per-endpoint bound the orchestrator's
	 * streaming turn does; see `registerEndpointSlot` in `turn-prewarm.ts`.
	 */
	registerPrewarmEndpointSlot?: (runtime: AgentRuntime) => (() => void) | null;
}

function reloadProtectedArtifactsForSession(
	protectedArtifacts: NonNullable<CreateChatLoopDeps["protectedArtifacts"]>,
	readSessionEntries: (() => ReadonlyArray<SessionEntry>) | undefined,
): void {
	try {
		const entries = readSessionEntries ? readSessionEntries() : [];
		protectedArtifacts.replace(protectedArtifactStateFromSessionEntries(entries));
	} catch (error) {
		protectedArtifacts.markDegraded(
			`session protection history could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * How the last step pipeline ended, for a headless caller: `done` when its step
 * tool said `pipelineDone`; otherwise `stoppedBy` says whether the yolo
 * continuation cap (`cap`), a cancel (`cancel`), a terminal failure
 * (`failure`) or the end of a turn nothing continued (`turn`, such as
 * autonomy below yolo) stopped it (bt-15, SC-3). `unreported`
 * is a pipeline whose last turn, at the cap, made no step call and ended on
 * its own summary: no step was cut off, but the step tool never said
 * `pipelineDone`, so whether every step ran is unknown (N1).
 */
export interface StepPipelineEnd {
	stepTool: string;
	template?: string;
	done: boolean;
	stoppedBy?: "cap" | "turn" | "cancel" | "failure" | "unreported";
}

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const sessionResetListeners = new Set<() => void>();
	const createAgent = deps.createAgent ?? createEngineAgent;
	const sideQuestionRound = deps.runSideQuestion ?? runSideQuestion;
	const middlewareToolChoice = deps.middlewareToolChoice ?? createMiddlewareToolChoiceControl();
	const state = createTurnState();
	const noteTurnControlCollection = ({ block, record }: Awaited<ReturnType<TurnControlRunner["run"]>>): void => {
		if (block !== null && record.decision.kind === "collect" && record.executed && "blockChars" in record.executed)
			state.turnCollectedDetachedBatch = true;
	};
	const operatorToolLimits = snapshotTurnConstraints(deps.sessionToolLimits);
	let sessionToolLimits = operatorToolLimits;
	let promptToolLimits = sessionToolLimits;
	state.currentTurnConstraints = sessionToolLimits;
	const eggs = createConversationEggs({
		identity: () => deps.session?.current()?.id ?? null,
		ensureConversation: () => {
			if (!deps.session || deps.session.current()) return;
			const settings = deps.getSettings();
			deps.session.create({
				cwd: process.cwd(),
				...(settings.chat.target ? { target: settings.chat.target } : {}),
				...(settings.chat.model ? { model: settings.chat.model } : {}),
			});
		},
		notice: (text) => emitNotice(text),
		changed: (active) =>
			deps.bus?.emit("session.eggs_changed", { sessionId: deps.session?.current()?.id ?? null, active }),
	});
	const toolStartTimes = new Map<string, number>();
	let lastHistoricalImageNoticeKey: string | null = null;

	const unsubscribeEggSession = deps.bus?.subscribe("session.parked", () => eggs.reset());
	const {
		preparationListeners,
		setTurnPreparation,
		markPreparationStep,
		enterPreparation,
		leavePreparation,
		endPreparationCompaction,
		preparingSubmits,
	} = createTurnPreparation(state);

	const { emit, refuseSkillRequests, emitFooterNotice, emitNotice, armSkillSurface, emitAdmissionNotice } =
		createChatLoopNotices(deps, state, listeners);

	const {
		visionModelOptions,
		nullRuntimeAdmissionReason,
		retrySettings,
		hostRunContext,
		headlessObservation,
		missingOutputs,
	} = createChatLoopToolOptions(deps, state);

	const loop: ChatLoopScope = {
		deps,
		createAgent,
		middlewareToolChoice,
		noteTurnControlCollection,
		toolStartTimes,
		setTurnPreparation,
		markPreparationStep,
		endPreparationCompaction,
		emit,
		refuseSkillRequests,
		emitFooterNotice,
		emitNotice,
		armSkillSurface,
		emitAdmissionNotice,
		visionModelOptions,
		nullRuntimeAdmissionReason,
		retrySettings,
		headlessObservation,
		missingOutputs,
		hostRunContext,
		sideQuestionRound,
		enterPreparation,
		leavePreparation,
		currentToolInvokeOptions: (toolCallId) => toolInvokeOptions(loop, state, toolCallId),
		get sessionToolLimits() {
			return sessionToolLimits;
		},
		set sessionToolLimits(value) {
			sessionToolLimits = value;
		},
		get promptToolLimits() {
			return promptToolLimits;
		},
		set promptToolLimits(value) {
			promptToolLimits = value;
		},
		get lastHistoricalImageNoticeKey() {
			return lastHistoricalImageNoticeKey;
		},
		set lastHistoricalImageNoticeKey(value) {
			lastHistoricalImageNoticeKey = value;
		},
		operatorSpokeAt: 0,
		// The session whose run the queue was typed behind; a reset within it keeps the operator's entries (#447).
		queueSessionId: null,
		submitOwner: null,
		// The owner a loop guard stop aborted. The guard ended that run, not the operator's request, so yolo may still continue it (#450).
		guardStoppedOwner: null,
		submitGeneration: 0,
		disposed: false,
		terminalTurnFailure: undefined,
		turnRetryAttempts: 0,
		providerRetryAttempts: 0,
		/** Moves the running turn's foreground slot, which belongs to the endpoint it is using, along with its request. */
		moveForeground: null,
		/** A stop waiting for the running round's tool batch to settle (F-C16); cleared when the submit settles. */
		boundaryStop: null,
		/**
		 * The budget that rolls the running turn into a continuation at its tool boundary (XR-6): set when a turn a
		 * continuation follows crosses its per-turn call or observation budget, read and cleared as the turn settles.
		 */
		budgetRoll: null,
		/** The interview this operator prompt closed, carried into its continuations so a complete there is already_complete (C-25). */
		promptInterview: undefined,
		/** The failed call behind this turn's loop lockout or stop; read once as the turn settles. */
		loopGuardFailure: null,
		/** The prompt template whose step policy ended this turn; read once as the turn settles. */
		stepPolicyStop: null,
		lastStepPipeline: null,
		/** The running submit's runtime, where its own messages start, and whether it is a yolo continuation. */
		stepTurnScope: null,
		// Settlement tracking for whenSettled(): every submit still going, coerced
		// to never reject so shutdown ordering cannot throw. `priorSubmit` is what
		// `activeSubmit` held before the latest submit joined it, which is the run an
		// interrupt has to wait out.
		activeSubmit: Promise.resolve(),
		priorSubmit: Promise.resolve(),
		sessionResetSettlement: Promise.resolve(),
		machinePreparation: null,
		machineTurnRunning: null,
		pendingMachineCancellation: null,
		machineHostDisposed: false,
		nextRequestPrepared: Promise.resolve(),
		nextRequestNavigation: 0,
		// A submit owns the turn state machine from the moment it starts running,
		// which is well before `state.streaming` flips: the probe, auto-compaction,
		// and the prompt compile all happen first. The pre-warm reads this flag, not
		// `streaming`, so it can never be the request the operator's turn queues
		// behind.
		turnActive: false,
		pendingPreTurnRead: null,
		pendingVisionSidecar: null,
		pendingCompactionPaint: null,
		/**
		 * The last operator turn that settled and has not yet been followed by another
		 * operator message. The next submit reports how it was followed, once.
		 */

		// Operator turns the session already holds, for the outcome row's `turnIndex`.
		// Reparsing the whole ledger every turn made the row cost grow with the session,
		// so it is counted once per session and advanced as turns are appended;
		// `resetForSession` clears it for /new, /resume, /fork and a park.
		operatorTurnsBefore: null,
		get messagePath() {
			return messagePath;
		},
		get queues() {
			return queues;
		},
		get middleware() {
			return middleware;
		},
		get operatorMemory() {
			return operatorMemory;
		},
		get context() {
			return context;
		},
		get persistence() {
			return persistence;
		},
		get outcomeCollector() {
			return outcomeCollector;
		},
		get recordRecovery() {
			return recordRecovery;
		},
		get currentTurnFailure() {
			return currentTurnFailure;
		},
		get recovery() {
			return recovery;
		},
		get requestBudgetRoll() {
			return requestBudgetRoll;
		},
		get turnRuntime() {
			return turnRuntime;
		},
		get steerInterrupter() {
			return steerInterrupter;
		},
		get withEndpointSlot() {
			return withEndpointSlot;
		},
		get prepareOutOfTurnRound() {
			return prepareOutOfTurnRound;
		},
		get routeMoveWait() {
			return routeMoveWait;
		},
		get routeFit() {
			return routeFit;
		},
		get continuity() {
			return continuity;
		},
		get stepStarts() {
			return stepStarts;
		},
		get stepPipeline() {
			return stepPipeline;
		},
		get yoloContinuationDue() {
			return yoloContinuationDue;
		},
		get stepTurnEnd() {
			return stepTurnEnd;
		},
		get submittedTurnOrigin() {
			return submittedTurnOrigin;
		},
		get continueStoppedTurn() {
			return continueStoppedTurn;
		},
		get interruptRefusalReason() {
			return interruptRefusalReason;
		},
		get sideCallAdmission() {
			return sideCallAdmission;
		},
		get withEndpointKeySlot() {
			return withEndpointKeySlot;
		},
		get sideCallJournal() {
			return sideCallJournal;
		},
		get prepareCompactionPaint() {
			return prepareCompactionPaint;
		},
		get operatorTurnIndex() {
			return operatorTurnIndex;
		},
		get workerReceipts() {
			return workerReceipts;
		},
		get recordStepPipelineSettled() {
			return recordStepPipelineSettled;
		},
		get writeTurnOutcome() {
			return writeTurnOutcome;
		},
		get recordCanceledBeforeAdmission() {
			return recordCanceledBeforeAdmission;
		},
		get keepalive() {
			return keepalive;
		},
		get queuedForTriage() {
			return queuedForTriage;
		},
		get api() {
			return api;
		},
		get submitTracked() {
			return submitTracked;
		},
	};

	const {
		context,
		continuity,
		currentTurnFailure,
		detachBoundaryReminders,
		detachOutcomeLedger,
		messagePath,
		middleware,
		operatorMemory,
		outcomeCollector,
		persistence,
		queues,
		recordRecovery,
		recovery,
		requestBudgetRoll,
		routeFit,
		routeMoveWait,
		steerInterrupter,
		turnRuntime,
	} = createChatLoopComposition(loop, state);

	const {
		stepPipeline,
		stepStarts,
		unsubscribeConfigNextTurn,
		unsubscribeConfigReload,
		unsubscribePluginsReload,
		unsubscribeSynthesisLock,
		unsubscribeToolBudgetLock,
	} = createChatLoopBus(loop, state);

	// --- the state machine --------------------------------------------------

	let machineTurnOwner: object | null = null;
	let machineProjectionBinding: { host: MachineTurnProjectionHost } | null = null;
	let machineProjectionRequired = false;
	const {
		continueStoppedTurn,
		interruptRefusalReason,
		keepalive,
		operatorTurnIndex,
		prepareCompactionPaint,
		prepareNextRequest,
		prepareOutOfTurnRound,
		prewarm,
		recordCanceledBeforeAdmission,
		recordStepPipelineSettled,
		restorableQueuedText,
		sideCallAdmission,
		sideCallJournal,
		stepTurnEnd,
		submittedTurnOrigin,
		unsubscribePrewarmCompaction,
		withEndpointKeySlot,
		withEndpointSlot,
		workerReceipts,
		writeTurnOutcome,
		yoloContinuationDue,
	} = createChatLoopStateMachine(loop, state);

	const { cancelTriage, queuedForTriage } = createChatLoopSteering(loop, state);

	const api: ChatLoop = {
		operatorMemory,
		steer: (text, display) => queuedForTriage(queues.steer(text, display)),
		queueFollowUp: (text, display, origin) =>
			queuedForTriage(queues.queueFollowUp(text, display, origin === undefined ? undefined : { origin })),
		queueEntries: () => queues.entries(),
		removeQueuedEntry: (id, reason) => queues.removeEntry(id, reason),
		moveQueuedEntry: (id, delta) => queues.moveEntry(id, delta),
		setQueuedEntryKind: (id, kind) => queues.setEntryKind(id, kind),
		interruptRefusal: () => (state.streaming ? interruptRefusalReason() : null),
		resumeAutonomy: () => {
			const autonomy = deps.autonomy;
			if (autonomy === undefined || autonomy.halted() === null) return false;
			if (loop.disposed || state.streaming || state.activeUserTurnId !== null) return false;
			autonomy.operatorSpoke();
			void api.submit(
				"[PanCode] The operator resumed yolo after it paused. Continue from where the previous turn stopped, and if the work is already finished, say so and stop.",
				{ origin: "yolo resume", yoloContinuation: true },
			);
			return true;
		},
		autonomyStatus: () => deps.autonomy?.status?.() ?? null,
		clearSkillSurface: () => {
			const cleared = skillSurfaceNames(state.activeSkillSurface);
			armSkillSurface(undefined, undefined, true);
			return cleared;
		},
		activeSkillSurface: () => skillSurfaceNames(state.activeSkillSurface),
		activeEggs: eggs.active,
		eggsCommand: eggs.command,
		discoverOperatorEgg: (text, ask) =>
			deps.headless ? Promise.resolve(false) : eggs.discover(text, ask ?? deps.eggAsk),
		refuseSkillRequests,
		// A queued template turn returns as the line the operator typed; its text is the expanded body.
		clearQueuedFollowUps: () => queues.clearQueuedMirror().map(restorableQueuedText),
		restorableQueuedTexts: () => queues.restorableQueued().map(restorableQueuedText),
		queuedMessages: () => queues.queuedMessages(),

		submit: createChatLoopSubmit(loop, state),

		...createChatLoopCancel(loop, state),

		onEvent(handler: (event: ChatLoopEvent) => void): () => void {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},

		captureWorkerContext(): WorkerContextSnapshot | null {
			const meta = deps.session?.current();
			if (!meta) return null;
			return captureWorkerContext(
				{ sessionId: meta.id, leafTurnId: state.lastTurnId, cwd: meta.cwd },
				state.runtime?.agent.state.messages ?? state.replayedContextMessages,
				deps.readSessionEntries?.(),
			);
		},

		getSessionId(): string | null {
			return deps.session?.current()?.id ?? null;
		},

		lastRunSnapshot(): ChatLoopRunSnapshot | null {
			return state.lastRunSnapshot ? structuredClone(state.lastRunSnapshot) : null;
		},
		lastTurnCompletion(): SealedCompletion | null {
			return state.turnSealedCompletion ? structuredClone(state.turnSealedCompletion) : null;
		},
		stepPipeline(): StepPipelineEnd | null {
			return loop.lastStepPipeline === null ? null : { ...loop.lastStepPipeline };
		},

		isStreaming(): boolean {
			return state.streaming;
		},
		runningToolCalls(): number {
			return toolStartTimes.size;
		},

		modelRequest() {
			state.refreshModelRequest?.();
			return state.modelRequest;
		},

		routeMoveWait,

		...createChatLoopRouteMove(loop, state),

		turnPreparation() {
			return { phase: state.turnPreparation, since: state.turnPreparationSince, stage: state.turnPreparationStage };
		},

		onTurnPreparation(handler) {
			preparationListeners.add(handler);
			return () => {
				preparationListeners.delete(handler);
			};
		},

		contextUsage: () => context.contextUsage(),
		currentTurnConstraints: () => state.currentTurnConstraints,
		setToolCeiling(ceilings, lifetime = "session") {
			const limits = snapshotTurnConstraints(
				ceilings.reduce(narrowTurnConstraints, lifetime === "session" ? operatorToolLimits : sessionToolLimits),
			);
			if (lifetime === "session") sessionToolLimits = limits;
			promptToolLimits = limits;
			// A run in flight keeps the scope it was admitted under (#423).
			if (!state.streaming) state.currentTurnConstraints = promptToolLimits;
			return limits;
		},
		toolLimits: () => promptToolLimits,
		jobConstraints: () => {
			const constraints = state.currentTurnConstraints;
			const policy = state.currentPendingSkillPolicy ?? state.activeSkillSurface;
			if (!policy) return snapshotTurnConstraints(constraints);
			const allowedTools = (deps.toolRegistry?.listAll() ?? [])
				.map((tool) => tool.name)
				.filter(
					(name) =>
						evaluateSkillToolSurface(policy, name) === null &&
						(constraints?.allowedTools === undefined || constraints.allowedTools.includes(name)),
				);
			// The skill surface narrows the job, so a refusal must name it rather than
			// blame a wider scope that still admits the tool.
			return snapshotTurnConstraints({
				...constraints,
				allowedTools,
				toolSurfaceSources: [
					...toolSurfaceSources(constraints),
					{
						tools: allowedTools,
						source: `active skill tool surface (${skillSurfaceNames(policy).join(", ")})`,
						remedy: "Unload the narrowing skill or widen its allowed-tools, then recreate the job.",
					},
				],
			});
		},
		contextLedger: () => context.contextLedger(),
		screenWindow: () =>
			state.runtime ? { messages: state.runtime.agent.state.messages, since: loop.operatorSpokeAt } : null,
		liveBudget: () => context.liveBudget(),
		inspectLiveBudget: () => context.inspectLiveBudget(),
		refreshLiveBudget: () => context.refreshLiveBudget(),
		whenSettled: () => loop.activeSubmit,
		whenPrewarmSettled: () => prewarm.settled(),
		nextRequestReady: () => loop.nextRequestPrepared,
		onSessionReset(handler): () => void {
			sessionResetListeners.add(handler);
			return () => {
				sessionResetListeners.delete(handler);
			};
		},

		resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void {
			loop.submitOwner?.abort();
			loop.submitGeneration += 1;
			// An interview another session or branch closed never answers this one's continuations (C-25).
			loop.promptInterview = undefined;
			turnRuntime.cancelRunWatchdog();
			loop.sessionResetSettlement = loop.activeSubmit;
			state.streaming = false;
			loop.pendingPreTurnRead?.abort();
			context.cancelCompaction();
			for (const listener of sessionResetListeners) {
				try {
					listener();
				} catch {
					// A host observer must not interrupt canonical replay and state cleanup.
				}
			}
			// Local shell completion and tree navigation also refresh the same transcript.
			eggs.syncConversation();
			loop.operatorTurnsBefore = null;
			lastHistoricalImageNoticeKey = null;
			loop.pendingVisionSidecar?.abort();
			loop.pendingCompactionPaint?.abort();
			continuity.cancel();
			void continuity.pause();
			state.currentTurnConstraints = sessionToolLimits;
			// The leaf being left is still `state.lastTurnId`; a navigation clears the chain there.
			stepStarts.reset({ sessionId: deps.session?.current()?.id ?? null, leafTurnId: state.lastTurnId }, leafTurnId);
			state.activeSkillSurface = undefined;
			state.currentPendingSkillPolicy = undefined;
			if (state.runtime) {
				state.runtime.agent.abort();
				(state.runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				turnRuntime.cleanupSessionResources(state.runtime.agent.sessionId);
			}
			recovery.cancelRetryCountdown();
			cancelTriage();
			const sessionId = api.getSessionId();
			if (deps.toolRegistry) ensureDetailLedgerForSession(deps.toolRegistry, sessionId);
			queues.reset({ keepOperator: sessionId !== null && sessionId === loop.queueSessionId });
			loop.queueSessionId = sessionId;
			middleware.clearPendingReminders();
			// The turn the reset cut off never reaches its turn_end hook: what its requests carried settles with it now.
			outcomeCollector.closeSession();
			middlewareToolChoice.reset();
			state.lastTurnId = leafTurnId;
			state.lastRunSnapshot = null;
			// In place before the context resets, so it republishes on the history of the leaf arrived at.
			state.replayedContextMessages = replayMessages ? [...replayMessages] : [];
			state.continuityAtMs = continuityRenderTime(replayMessages) ?? null;
			if (state.runtime) replaceEngineMessages(state.runtime.agent, [...state.replayedContextMessages]);
			// The incoming leaf is the advisory branch identity for the new session.
			// Ordinary appends advance `state.lastTurnId` from here without re-arming
			// an advisory; arriving here at all is the navigation that does.
			context.resetForSession(leafTurnId);
			loop.nextRequestNavigation += 1;
			loop.nextRequestPrepared =
				replayMessages && replayMessages.length > 0 ? prepareNextRequest(loop.nextRequestNavigation) : Promise.resolve();
			// The resumed ledger renders before the first new turn (issue #189),
			// and the window it renders against should be the probed one rather
			// than the catalog's, so the live capability probe the first submit
			// would run runs now, under the same TTL; the footer refreshes on the
			// provider-health event the probe publishes.
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel().catch(() => {});
			if (deps.protectedArtifacts) {
				reloadProtectedArtifactsForSession(deps.protectedArtifacts, deps.readSessionEntries);
			}
			// A resume replays a history the backend has never seen; a fresh session
			// replays nothing but still compiles a prompt and a tool surface. Both
			// leave a prefix the next turn will pay for unless it is sent now.
			prewarm.schedule(replayMessages && replayMessages.length > 0 ? "resume" : "session-start");
		},

		dispose(): void {
			loop.disposed = true;
			steerInterrupter.dispose();
			loop.submitOwner?.abort();
			loop.pendingPreTurnRead?.abort();
			loop.machineHostDisposed = true;
			sessionResetListeners.clear();
			unsubscribeEggSession?.();
			eggs.reset();
			loop.pendingVisionSidecar?.abort();
			loop.pendingCompactionPaint?.abort();
			turnRuntime.dispose();
			workerReceipts.dispose();
			unsubscribeConfigReload?.();
			unsubscribeConfigNextTurn?.();
			unsubscribePluginsReload?.();
			unsubscribeSynthesisLock?.();
			unsubscribeToolBudgetLock?.();
			detachOutcomeLedger?.();
			detachBoundaryReminders?.();
			unsubscribePrewarmCompaction();
			prewarm.dispose();
			keepalive.dispose();
			context.dispose();
			if (state.runtime) {
				state.runtime.agent.abort();
				(state.runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				turnRuntime.cleanupSessionResources(state.runtime.agent.sessionId);
			}
			recovery.cancelRetryCountdown();
			cancelTriage();
			queues.reset();
			middlewareToolChoice.reset();
		},

		...createChatLoopSideRounds(loop),

		requestSelfCompact: (note, toolCallId, signal) => continuity.request(note, toolCallId, signal),
		...createChatLoopContextCommands(loop, state),
	};

	const submitInner = api.submit.bind(api);
	const submitTracked: ChatLoop["submit"] = (text, options) => {
		loop.priorSubmit = loop.activeSubmit;
		const preparationToken = options?.machineTurn?.preparationToken;
		loop.machinePreparation = preparationToken === undefined ? null : { token: preparationToken, runtime: null };
		// The flag brackets the whole submit, including the early returns an
		// admission failure takes, so a refused turn does not leave the pre-warm
		// believing a turn is still running.
		loop.turnActive = true;
		const run = submitInner(text, options).finally(() => {
			if (loop.machinePreparation?.token === preparationToken) loop.machinePreparation = null;
			loop.turnActive = false;
			keepalive.cancel();
		});
		// A steer during a run is a submit that returns at once. Replacing the record with it forgot the
		// live run, so an interrupt's wait for the cancel to settle returned early and shutdown could stop the writer
		// under a persisting turn. The record covers every submit still going.
		loop.activeSubmit = Promise.all([loop.priorSubmit, run.catch(() => {})]).then(() => {});
		return run;
	};

	// FIFO admission gate. Between entry and `state.streaming = true` a fresh
	// submit awaits the target probe, auto-compaction, and the session prompt
	// compile; a second submit arriving in that window used to run the same
	// pipeline concurrently, skip the probe the first one was still awaiting,
	// append its user turn first, and leave the first to fail on the engine's
	// active-prompt invariant after its turn was already in the ledger. Each
	// submit now waits for the previous one to either own the stream or return,
	// then re-evaluates `state.streaming`, so a prompt typed during boot lands
	// as the next steer or follow-up in the order it was typed. The gate is
	// released at admission, not settlement, so steering stays immediate.
	let admissionTail: Promise<void> | null = null;
	api.submit = (text, options = {}) => {
		const constraints = snapshotTurnConstraints(options.constraints);
		options = { ...options, ...(constraints === undefined ? {} : { constraints }) };
		// Capture before admission can await. Internal resubmits inherit the
		// async scope; every independent public submit explicitly starts its own.
		const hostRun = options.hostRun === undefined ? undefined : structuredClone(options.hostRun);
		// The operator owns the slot from the keystroke, not from admission. The
		// prefix the pre-warm already pushed through stays in it either way, so
		// aborting here costs nothing and stops the real turn from queueing behind
		// a request nobody is waiting on.
		prewarm.cancel();
		keepalive.cancel();
		const previous = admissionTail;
		let release: () => void = () => {};
		const ticket = new Promise<void>((resolve) => {
			release = resolve;
		});
		admissionTail = ticket;
		const releaseTicket = (): void => {
			release();
			if (admissionTail === ticket) admissionTail = null;
		};
		// The window opens here, not at admission: the caller has already cleared
		// the editor and painted the prompt, and a submit that queues behind the
		// FIFO gate is still a prompt PanCode is holding. It closes once, at
		// whichever of admission and settlement comes first, so a refused probe
		// and a blocked overflow preflight close it as reliably as a turn that
		// reaches the stream.
		enterPreparation();
		let leftPreparation = false;
		const leaveOnce = (): void => {
			if (leftPreparation) return;
			leftPreparation = true;
			leavePreparation();
		};
		const start = async (): Promise<void> => {
			const { onPreparationVisible, ...submitOptions } = options;
			try {
				await onPreparationVisible?.();
			} catch {
				// A presentation observer cannot refuse a turn after the editor has
				// consumed it. The ordinary render path can recover on its next tick.
			}
			if (options.isAdmissionCurrent?.() === false) {
				releaseTicket();
				return;
			}
			return hostRunContext
				.run(hostRun, () =>
					submitTracked(text, {
						...submitOptions,
						onAdmitted: () => {
							releaseTicket();
							leaveOnce();
							options.onAdmitted?.();
						},
					}),
				)
				.finally(releaseTicket);
		};
		const run = previous ? previous.then(start) : start();
		return run.finally(leaveOnce);
	};

	api.bindMachineTurnProjection = (host) => {
		const binding = { host };
		machineProjectionRequired = true;
		machineProjectionBinding = binding;
		return () => {
			if (machineProjectionBinding === binding) machineProjectionBinding = null;
		};
	};
	api.machineTurnAvailable = () =>
		!loop.machineHostDisposed &&
		(!machineProjectionRequired || machineProjectionBinding !== null) &&
		machineTurnOwner === null &&
		!state.streaming &&
		preparingSubmits() === 0 &&
		!loop.turnActive &&
		!state.currentAskUserPolicy?.inFlight &&
		deps.toolRegistry?.hasParkedCalls() !== true &&
		queues.entries().length === 0;
	api.submitMachineTurn = async (request) => {
		const refused = (reason: string): MachineTurnResult => ({ status: "refused", turnId: null, reason });
		if (machineProjectionRequired && machineProjectionBinding === null)
			return refused(
				"The attended turn projection is detached; delivery remains with its job controller until the host is available.",
			);
		const paused = deps.autonomy?.halted() ?? null;
		if (paused !== null)
			return refused(`Yolo is paused for the operator (${paused.detail}); delivery remains with its job controller.`);
		if (!api.machineTurnAvailable?.())
			return refused("The main conversation is busy; delivery remains with its job controller.");
		const current = (): boolean =>
			!loop.machineHostDisposed &&
			!request.signal.aborted &&
			request.sessionId === api.getSessionId() &&
			request.isAdmissionCurrent();
		if (!current()) return refused("The job's originating session or generation is no longer current.");
		const token = {};
		machineTurnOwner = token;
		let settled: MachineTurnResult | null = null;
		let ownedUserTurnId: string | null = null;
		let ownedRuntime: AgentRuntime | null = null;
		let projectionLease: Extract<MachineTurnProjectionAdmission, { status: "ready" }> | null = null;
		// A scheduled job's turn is autonomous: its commits name PanCode as author under `auto`.
		const autonomousCommits: { release: (() => void) | null } = { release: null };
		const cancel = (): void => {
			if (
				machineTurnOwner === token &&
				loop.machinePreparation?.token === token &&
				!state.streaming &&
				state.activeUserTurnId === null
			) {
				// This preparation still owns the FIFO slot; cancel its ports without aborting a successor runtime (#411).
				loop.pendingPreTurnRead?.abort();
				loop.pendingVisionSidecar?.abort();
				loop.pendingCompactionPaint?.abort();
				if (loop.machinePreparation.runtime !== null && state.runtime === loop.machinePreparation.runtime)
					context.cancelCompaction();
				return;
			}
			if (
				loop.machineTurnRunning === token &&
				ownedUserTurnId !== null &&
				state.activeUserTurnId === ownedUserTurnId &&
				state.runtime === ownedRuntime &&
				request.sessionId === api.getSessionId()
			) {
				loop.pendingMachineCancellation = token;
				// The controller's abort reason says what ended it; a timed-out occurrence is not a cancelled one (#445).
				const cause = request.signal.reason;
				const ended = cause instanceof Error ? cause.message : String(cause);
				try {
					api.cancel({
						reason: `Scheduled job occurrence ended: ${ended}.`,
						auditReason: `job occurrence ended: ${ended}`,
						...(cause instanceof JobClockExpired ? { source: "job_clock" as const } : {}),
					});
				} finally {
					loop.pendingMachineCancellation = null;
				}
			}
		};
		request.signal.addEventListener("abort", cancel, { once: true });
		try {
			const binding = machineProjectionBinding;
			if (binding !== null) {
				const meta = deps.session?.current();
				if (!meta || meta.id !== request.sessionId)
					return refused("The projection's conversation is no longer bound to this machine turn.");
				const projection = binding.host.acquire({
					jobId: request.jobId,
					executionId: request.executionId,
					text: request.text,
					origin: request.origin,
					sessionId: request.sessionId,
					cwd: realpathSync(meta.cwd),
					signal: request.signal,
				});
				if (projection.status === "deferred") return refused(projection.reason);
				projectionLease = projection;
				if (!current() || machineProjectionBinding !== binding)
					return refused("The attended projection host changed during machine-turn admission.");
			}
			await api.submit(request.text, {
				origin: request.origin,
				...(request.operatorAuthored === true ? { operatorAuthored: true } : {}),
				...(request.constraints === undefined ? {} : { constraints: request.constraints }),
				isAdmissionCurrent: current,
				machineTurn: {
					preparationToken: token,
					onStarting: request.onStarting,
					onSettled: (result) => {
						settled = result;
						if (loop.machineTurnRunning === token) loop.machineTurnRunning = null;
					},
				},
				onAdmitted: () => {
					if (loop.machinePreparation?.token === token) loop.machinePreparation = null;
					loop.machineTurnRunning = token;
					autonomousCommits.release ??= enterAutonomousCommitScope();
					ownedUserTurnId = state.activeUserTurnId;
					ownedRuntime = state.runtime;
					emit({
						type: "queued_user_turn",
						text: request.text,
						kind: "follow-up",
						origin: request.origin,
					});
					if (request.notice !== undefined) emitNotice(request.notice, "warning", "job.clock-resumed");
					if (request.signal.aborted) cancel();
				},
			});
			return (
				settled ??
				refused(
					request.signal.aborted
						? "Scheduled delivery cancelled before execution."
						: "The fresh turn was refused during ordinary admission.",
				)
			);
		} catch (error) {
			return {
				status: request.signal.aborted ? "canceled" : "failed",
				turnId: null,
				reason: error instanceof Error ? error.message : String(error),
			};
		} finally {
			request.signal.removeEventListener("abort", cancel);
			autonomousCommits.release?.();
			if (loop.machineTurnRunning === token) loop.machineTurnRunning = null;
			try {
				projectionLease?.release();
			} catch (error) {
				emitNotice(
					`Machine turn projection release failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			if (machineTurnOwner === token) machineTurnOwner = null;
			// Successor prompts have their own lifetime and must never extend this occurrence (#411).
			if (settled !== null && !loop.machineHostDisposed)
				void queues
					.resubmitStranded()
					.then(async (submitted) => {
						if (!submitted) await queues.resubmitRequestContinuation();
					})
					.catch((error: unknown) => emitNotice(error instanceof Error ? error.message : String(error), "error"));
		}
	};
	return api;
}
