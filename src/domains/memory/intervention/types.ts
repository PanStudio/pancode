// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { MemoryDeliveryMode, MemorySurfaceSettings } from "../../../core/defaults.js";
import type { MiddlewareHookEvaluationContext, MiddlewareHookRegistration } from "../../middleware/runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../middleware/types.js";
import type { CommandSegment } from "../command-evidence.js";
import type {
	MemoryCommitScope,
	MemoryCommitVerdict,
	MemoryContentStamp,
	MemoryRestorationOffer,
	SuccessfulMemoryContextCommit,
} from "../commit-state.js";
import type { MemoryObservationCommands } from "../contract.js";
import type { KeptLesson } from "../lesson-projection.js";
import type { TaskMemoryTelemetrySink, TaskMemoryTelemetryTrigger } from "../memory-events.js";
import type { MemoryNoteArgs, MemoryNoteEvidence } from "../notes.js";
import type { MemoryRestorationInput } from "../restoration.js";
import type { TaskMemoryBank, TaskMemoryEntry } from "../task-bank.js";
import type { TaskMemoryEnvelope, TaskMemoryModelClient, TaskMemoryPolicyResult } from "../task-memory-policy.js";
import type { TaskMemoryActivityEvent } from "../task-memory-status.js";

/**
 * What the session saw after an llm-tier reminder reached the action agent.
 * This is the only evidence the durable store's approval gate reads, so it is
 * reported once per delivery and only when it is decided.
 */
export interface MemoryDeliveryOutcome {
	/**
	 * The entries as they read when the reminder was delivered. Entry ids are
	 * reused across rewrites, so the content is what binds an outcome to the
	 * fact it is about: an id alone let a late contradiction of a rewritten
	 * entry land on the fact that replaced it.
	 */
	entries: ReadonlyArray<{ id: string; content: string }>;
	kind: "held" | "contradicted";
}

/**
 * One reminder memory produced for the action agent, bound to what it cites
 * and why it was produced. Producing or buffering it proves nothing: delivery
 * accounting, deduplication and outcome watches start only when the host
 * reports that `content` entered an admitted request (`acknowledgeSubmission`).
 * Submission proves inclusion, never that the agent followed it.
 */
export interface MemoryInterventionOffer {
	readonly id: string;
	readonly kind: "corrective" | "knowledge" | "durable_lesson";
	readonly tier: "rules" | "llm";
	/** Exact text that must appear in the admitted request. */
	readonly content: string;
	/** Bank entries or durable records cited, each with the content revision the text was written from. */
	readonly cited: ReadonlyArray<{ readonly id: string; readonly revision: string }>;
	readonly trigger: {
		readonly reasons: ReadonlyArray<string>;
		/** Tool step at production. */
		readonly step: number;
		/** Failure episodes open when the reminder was produced; a corrective one is stale once all are resolved. */
		readonly failures: ReadonlyArray<{
			readonly fingerprint: string;
			readonly firstStep: number;
			/** The procedural entry that records the episode. */
			readonly entryId: string;
		}>;
	};
	/** Durable lessons with their applicability and provenance, as rendered. */
	readonly lessons: ReadonlyArray<
		Pick<KeptLesson, "id" | "revision" | "appliesWhen" | "avoidWhen" | "approval" | "evidenceRefs">
	>;
	/** Workspace the reminder's paths and evidence were checked against. */
	readonly workspaceRoot: string;
}

export type MemoryInterventionTriggerReason =
	| "interval"
	| "tool_error_streak"
	| "loop_signal"
	| "turn_end"
	| "idle_review";

/** What one detached step launch came to, for the idle guardian's scheduling. */
export type MemoryStepLaunchOutcome =
	/** The model tier answered or timed out; new pending work is up to the next boundary. */
	| "ran"
	/** Occupancy refused or preempted the step; its triggers stay pending. */
	| "yielded"
	/** The model tier cannot run; rules keep working. */
	| "unavailable"
	/** The background budget refused the step; the next cadence tick decides again. */
	| "skipped"
	/** Nothing to do, or the scope changed under the step. */
	| "none";

export interface MemoryInterventionSettings {
	enabled: boolean;
	everyNTools: number;
	windowSteps: number;
	maxTokens: number;
	timeoutMs: number;
	/**
	 * `context.memory.surfaces`: `model` arms the model step on its triggers; `rules` (the default) leaves that surface
	 * to the deterministic tier. `correct` owns `tool_error_streak` and `loop_signal`, `bank` owns `interval`.
	 * `lessons` owns rules capture (every value but `off`) and the side-model lesson pass (`side` only).
	 */
	surfaces?: Pick<MemorySurfaceSettings, "correct" | "bank"> & Partial<Pick<MemorySurfaceSettings, "lessons">>;
}

export interface MemoryKnowledgeReview {
	/** Lessons kept on a later look that also quote a command this session saw succeed. */
	kept: ReadonlyArray<TaskMemoryEntry>;
	withdrawn: ReadonlyArray<TaskMemoryEntry>;
	/** Lessons kept on a later look with nothing observed to ground them; filed, never evidence. */
	ungrounded: ReadonlyArray<TaskMemoryEntry>;
	/** Ids of kept lessons grounded by their own command succeeding, not only by a quote. */
	commandVerified?: ReadonlySet<string>;
}

export interface MemoryInterventionDeps {
	onContentCancelled?: () => void;
	deferBoundaryPolicy?: () => boolean;
	bank: TaskMemoryBank;
	enabled?: boolean;
	windowSteps?: number;
	maxTokens?: number;
	timeoutMs?: number;
	everyNTools?: number;
	/** The model-tier switches when no live settings are read; absent fields take the shipped defaults. */
	surfaces?: Partial<Pick<MemorySurfaceSettings, "correct" | "bank" | "lessons">>;
	/**
	 * Rules capture (DESIGN 4.4): a lone shell invocation failed and a later success of the same program and operands
	 * changed only its options, with no success of the failed argv between. The owner files the pair as a fix note.
	 */
	onFixPair?: (pair: { failed: CommandSegment; fixed: CommandSegment }) => void;
	/** Unpromoted fix notes earlier sessions wrote; a failed call matching a note's failed pattern carries it. */
	getFixNotes?: () => readonly KeptLesson[];
	/** Lazily resolves the dedicated memory route or the active chat route. Null means rules-only. */
	getModelClient?: () => TaskMemoryModelClient | null;
	/** One alternative route after a client error; never used after timeout, cancellation or model output. */
	getFallbackModelClient?: () => TaskMemoryModelClient | null;
	/** Completion budget derived from the resolved background model capability. */
	getModelMaxTokens?: (configuredMaxTokens: number) => number;
	/**
	 * True when known endpoint occupancy exhausts the resolved capacity bound.
	 * A shared gateway URL alone is not evidence that its request slots are full.
	 */
	backgroundEndpointBusy?: () => boolean;
	/**
	 * Bank entries an llm-tier reminder cited, once the host reported the
	 * reminder inside an admitted request. The owner proposes them into the
	 * durable memory store, which is what connects the session bank to the
	 * records `/memory` and `pancode memory` read. Best effort and
	 * content-bearing, exactly like `onEnvelope`.
	 */
	onInjectedEntries?: (entries: ReadonlyArray<TaskMemoryEntry>) => void;
	/**
	 * Decided outcomes for entries `onInjectedEntries` reported earlier. `final`
	 * marks the last call for this session scope: deliveries still undecided at
	 * that point are abandoned, and the entry ids may be reused afterwards.
	 */
	onDeliveryOutcomes?: (outcomes: ReadonlyArray<MemoryDeliveryOutcome>, final: boolean) => void;
	/**
	 * What one answered model step did to knowledge it had already written.
	 * `kept` entries were shown to the model again and left unchanged, which is
	 * the model reaffirming a fact with a newer trajectory in front of it;
	 * `withdrawn` entries were deleted or rewritten. A live session on a local
	 * 27B wrote the one fact worth keeping on its first step and stayed silent
	 * on all three, so a capture path that waits for a delivered reminder
	 * recorded nothing.
	 */
	onKnowledgeReview?: (review: MemoryKnowledgeReview) => void;
	/**
	 * Lessons still in the bank when its session scope ends, with the session
	 * they were written in. A lesson filed on a session's last step never gets a
	 * second look, so it is handed over to be filed as pending instead of being
	 * cleared with the bank.
	 */
	/**
	 * Approved lessons for the active workspace's repository, with conditions and
	 * provenance. Action reminders select from all of them before any item limit;
	 * the turn-end pass is shown a bounded subset so it does not rewrite them.
	 */
	getKeptLessons?: () => readonly KeptLesson[];
	/** `context.memory.surfaces.delivery`, read at each decision point; absent means the default, `decision`. */
	getDelivery?: () => MemoryDeliveryMode;
	/** Kept lessons the turn-end pass deleted because the turn showed them wrong. */
	onKeptLessonsRetired?: (memoryIds: ReadonlyArray<string>) => void;
	onScopeEnd?: (scope: { sessionId: string | undefined; lessons: ReadonlyArray<TaskMemoryEntry> }) => void;
	/** Live next-turn settings view; individual fields above remain test-friendly fallbacks. */
	getSettings?: () => Readonly<MemoryInterventionSettings>;
	/** Best-effort content-free telemetry; sink failures never affect intervention. */
	telemetry?: TaskMemoryTelemetrySink;
	/**
	 * Opt-in raw-envelope observer. Content-bearing: it records only under
	 * research capture with consent (#434).
	 */
	onEnvelope?: (envelope: TaskMemoryEnvelope) => void;
	/** Asked per step before an envelope is built; absent means `onEnvelope` always wants one. */
	tracesEnvelopes?: () => boolean;
	/**
	 * Delivery channel for a reminder produced after its turn boundary already
	 * closed. The composition root buffers it into the next submitted turn, which
	 * is where a synchronous turn_end reminder would have landed anyway.
	 */
	onDeferredReminder?: (message: string, isCurrent?: () => boolean) => void;
	/**
	 * False when no further turn will be submitted in this process. A background
	 * step is detached from the boundary that triggered it and a local route
	 * measures in tens of seconds, so a headless run exits long before the step
	 * lands: its reminder has no turn to ride into and its bank is discarded with
	 * the process. Starting one only spends a model call to throw the result away.
	 */
	deliversDeferredReminders?: boolean;
	/** Turn lifecycle wake signal for the idle guardian. Synchronous and cheap; it never runs a step. */
	onTurnBoundary?: (kind: "start" | "end") => void;
	/** A detached step started or settled, so read-only status surfaces can refresh. */
	onStepActivity?: () => void;
	/** Checkout source evidence is verified against; defaults to the process workspace. */
	workspaceRoot?: () => string;
	/**
	 * Approved lessons whose reminder entered an admitted request (`delivered`),
	 * and those whose recommended command this session then ran successfully,
	 * exactly, after that submission (`held`). Ids only; the owner records them
	 * on the durable records.
	 */
	onDurableLessonOutcomes?: (input: {
		sessionId: string | undefined;
		delivered: ReadonlyArray<string>;
		held: ReadonlyArray<string>;
	}) => void;
}

export interface MemoryPromptedStepInput {
	deterministicTrigger: boolean;
	/** Overrides the most recent turn-start task text when supplied. */
	task?: string;
	/** Keep phase-one writes but yield the visible channel to a synchronous reminder. */
	suppressIntervention?: boolean;
	/** Internal attribution; direct callers default to `manual`. */
	triggerReasons?: ReadonlyArray<TaskMemoryTelemetryTrigger>;
}

export interface MemoryPromptedStepResult extends TaskMemoryPolicyResult {
	effects: ReadonlyArray<MiddlewareEffect>;
	/** The offer the reminder was produced as; its validity is rechecked until submission. */
	offer?: MemoryInterventionOffer;
}

export interface MemoryInterventionRegistration extends MiddlewareHookRegistration {
	readonly observations?: MemoryObservationCommands;
	captureMemoryAuthority(): { scope: MemoryCommitScope; stamp: MemoryContentStamp } | null;
	bindCommitScope(scope: MemoryCommitScope): void;
	notifyContextCommitted(input: SuccessfulMemoryContextCommit): MemoryCommitVerdict | undefined;
	prepareRestoration(
		currentState: MemoryRestorationInput["currentState"],
		maxTokens: number,
	): MemoryRestorationOffer | null;
	/** Read-only: whether acknowledging this offer now would succeed. */
	canAcknowledgeRestoration(offer: MemoryRestorationOffer): boolean;
	acknowledgeRestoration(offer: MemoryRestorationOffer): boolean;
	/** Clear an offer the model already holds earlier restoration text for; no injection, no delivery event. */
	releaseRestoration(offer: MemoryRestorationOffer): boolean;
	/** Journal a restoration install an earlier process wrote: it stays as delivered text and nothing is acknowledged. */
	noteInheritedRestoration?(commitId: string, citedEntryIds: ReadonlyArray<string>): void;
	/**
	 * Content authority for buffered memory text. Given the text, the guard also
	 * revalidates that offer's cited revisions and triggering failures, so a
	 * correction whose failure resolved while it waited is never submitted.
	 */
	isContentCurrent(content?: string): () => boolean;
	/**
	 * The host framed these texts (reminder blocks, tool-result notes) in a
	 * request it admitted and submitted. Offers whose exact content appears
	 * start delivery accounting now; the rest stay pending until they are
	 * submitted or go stale.
	 */
	acknowledgeSubmission(texts: ReadonlyArray<string>): ReadonlyArray<MemoryInterventionOffer>;
	/** Produced reminders are waiting for a submission receipt. */
	hasPendingOffers(): boolean;
	/**
	 * Reminder text for approved lessons this turn's task plainly asks about and
	 * the prompt does not carry, or "" when there are none. It is a typed offer:
	 * delivery accounting starts when the text appears in an admitted request.
	 */
	offerLessonsForTask(task: string, carried: (id: string) => boolean): string;
	/**
	 * What a `memory_note` call's command or path binds to in this session scope: a segment with that evidence
	 * identity that succeeded here, or the latest excerpt a successful read of that path showed the model. Neither
	 * given is null; one given that binds to nothing is refused with the reason.
	 */
	noteEvidence(args: Pick<MemoryNoteArgs, "note" | "command" | "path">): MemoryNoteEvidence | { refused: string };
	/**
	 * Evidence arms rules capture saw in this session scope (fix pairs, and a declared `done` with a passed check);
	 * completion retention under `lessons: side` is armed by one.
	 */
	sideArmCount(): number;
	/** Invalidate pending content and discard all transient session/branch state. */
	reset(): void;
	/** Invalidate immediately without waiting for the model; refuse further work. */
	dispose(): void;
	evaluateAsync(
		input: MiddlewareHookInput,
		context?: MiddlewareHookEvaluationContext,
	): Promise<ReadonlyArray<MiddlewareEffect>>;
	/** Serialized model step; the composition root decides which awaited boundary invokes it. */
	runPromptedStep(input: MemoryPromptedStepInput): Promise<MemoryPromptedStepResult>;
	/** Consume the orchestrator loop guard's already-computed verdict. */
	signalLoop(): void;
	/** Most recent completed memory-policy outcome for read-only operator surfaces. */
	lastDecision(): TaskMemoryPolicyResult["decision"] | null;
	/** Bounded newest-first memory-step history for read-only operator surfaces. */
	recentActivity(): ReadonlyArray<TaskMemoryActivityEvent>;
	/** True while a detached background memory step is still running. */
	stepInFlight(): boolean;
	/**
	 * Completed activity no step has reviewed yet: pending triggers, including
	 * ones that yielded to occupancy, or shell work since the last lesson pass.
	 */
	pendingWork(): boolean;
	/**
	 * A boundary already raised triggers (a finished turn, a cadence step, one
	 * that yielded to occupancy) that a step can serve now: the model tier is
	 * neither parked unavailable nor refused by the budget. Idle-only lesson
	 * work does not count.
	 */
	owesBoundaryStep(): boolean;
	/**
	 * Run pending work between turns: yielded triggers first, otherwise a lesson
	 * pass over completed activity the turn-end pass did not cover. Detached
	 * from any visible turn; the idle guardian decides when to call it.
	 */
	runIdleStep(): Promise<MemoryStepLaunchOutcome>;
	/**
	 * Resolves when this generation's detached policy settles. Reset/shutdown
	 * release the policy immediately; an abort-ignoring transport can still
	 * finish later, with authority only to report its originating usage.
	 */
	whenIdle(): Promise<void>;
}
