// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../../../core/hash.js";
import type { TelemetryContext } from "../../../core/telemetry/context.js";
import type { Fact } from "../../../core/telemetry/fact.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../middleware/types.js";
import { BACKGROUND_SKIP_REASONS, type BackgroundSkipReason } from "../background-budget.js";
import type { CommandSegment } from "../command-evidence.js";
import type { MemoryCommitScope, MemoryCommitState } from "../commit-state.js";
import type { PendingToolStep } from "../intervention-tool-step.js";
import type {
	MemoryInterventionDeps,
	MemoryInterventionOffer,
	MemoryInterventionSettings,
	MemoryInterventionTriggerReason,
	MemoryPromptedStepInput,
	MemoryPromptedStepResult,
} from "../intervention-types.js";
import type { KeptLesson } from "../lesson-projection.js";
import type {
	TaskMemoryTelemetryDecision,
	TaskMemoryTelemetryTier,
	TaskMemoryTelemetryTrigger,
} from "../memory-events.js";
import type { TaskMemoryEntry, TaskMemorySnapshot } from "../task-bank.js";
import type {
	TaskMemoryPolicyReason,
	TaskMemoryPolicyResult,
	TaskMemoryRoute,
	TaskMemoryTrajectoryStep,
} from "../task-memory-policy.js";
import type { TaskMemoryActivityEvent } from "../task-memory-status.js";

export const noTokens: Fact<number> = { kind: "absent", reason: "not-applicable" };

/** Reasons a step yielded to occupancy; its triggers stay pending and it runs again when the endpoint has room. */
export const YIELDED_REASONS: ReadonlySet<TaskMemoryPolicyReason> = new Set(["endpoint_busy", "endpoint_preempted"]);

/**
 * The background budget refused the step before it sent anything (spend,
 * quota or time). Its triggers are not re-armed: the next cadence tick decides
 * again, so a refused step is never retried in a loop.
 */
export function budgetSkipped(reason: TaskMemoryPolicyReason): boolean {
	return !YIELDED_REASONS.has(reason) && BACKGROUND_SKIP_REASONS.has(reason as BackgroundSkipReason);
}
export const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

export type TrajectoryStep = TaskMemoryTrajectoryStep;

/** One read's shown physical lines, 1-based and inclusive, and the file's size and mtime when it was read. */
export interface ShownRead {
	start: number;
	end: number;
	bytes: number;
	mtimeMs: number;
}

export interface DeliveryWatch {
	entries: Array<{ id: string; content: string; entry: TaskMemoryEntry }>;
	/** Tool step at submission; only evidence after it speaks for the reminder. */
	step: number;
	/** Failure episodes the reminder was written about that were still open when it was submitted. */
	fingerprints: Set<string>;
	recurrences: number;
	/** Entries whose own evidence a later receipt satisfied. */
	supported: Set<string>;
	/** Entries already reported held; only a later contradiction is still news. */
	heldReported: Set<string>;
}

export interface FailedAttempt {
	entryId: string;
	attempts: number;
	firstStep: number;
	callDescription: string;
	errorDigest: string;
}

export interface PendingOffer {
	readonly offer: MemoryInterventionOffer;
	readonly generation: number;
	/** Delivery accounting the submission receipt starts, given the offer as registered. */
	readonly onSubmitted: (offer: MemoryInterventionOffer) => void;
	/**
	 * Requests submitted without this text since it was produced. A reminder
	 * rides the next request (an annotation) or the one after the next flush
	 * (a deferred reminder); one that misses more was dropped before it
	 * reached the model, and holding it would keep its lessons from being
	 * offered again for the rest of the session.
	 */
	missedSubmissions: number;
}

/**
 * The shared state of one memory intervention registration.
 *
 * createMemoryInterventionRegistration builds one scope and hands it to the
 * intervention modules. A module reads every binding it does not own as
 * `scope.x` at the use site, so a read sees the value the closure it came from
 * saw at that moment. State lives here as plain fields; the functions one
 * module calls in another are getters over the registration's own bindings.
 */
export interface InterventionScope {
	readonly deps: MemoryInterventionDeps;
	generation: number;
	stepContext: TelemetryContext | undefined;
	commitState: MemoryCommitState | null;
	commitScope: MemoryCommitScope | null;
	commitBridgeEnabled: boolean;
	generationController: AbortController;
	observedSessionId: string | undefined;
	disposed: boolean;
	readonly pending: Map<string, PendingToolStep>;
	readonly trajectory: TrajectoryStep[];
	readonly failures: Map<string, FailedAttempt>;
	readonly deliveries: DeliveryWatch[];
	/** This turn's calls in order, for the turn-end lesson pass. */
	readonly turnLog: string[];
	/**
	 * Complete commands this session scope executed successfully, each exactly
	 * as the shell tool received it and taken only from that tool's own success
	 * receipt. A lesson is grounded by equality with one of these and by nothing
	 * else.
	 */
	readonly succeededCommands: Set<string>;
	/** The evidence identity of every segment those receipts vouch for, by key; nothing else satisfies a command claim. */
	readonly succeededSegments: Map<string, CommandSegment>;
	/** Keys of commands a verify run executed from the root without passing, to the check id that ran them (CLI-P52). */
	readonly unpassedVerifyChecks: Map<string, string>;
	/**
	 * Excerpts of successful read results, by repository-relative path, exactly
	 * as the turn log showed them to the lesson pass. A source-cited lesson is
	 * grounded only by a quote inside one of these that the current checkout
	 * still holds (`lessonEvidence`).
	 */
	readonly observedReads: Map<string, string[]>;
	/** The last lone failed shell invocation per command subject, waiting for a success that fixes it. */
	readonly failedForFix: Map<string, { segment: CommandSegment; step: number }>;
	/**
	 * The line ranges each successful read showed, with the file's size and mtime as the read saw them, per path. A
	 * `memory_note` quote is checked against exactly these lines while the file is unchanged.
	 */
	readonly shownReads: Map<string, ShownRead[]>;
	/** Evidence arms (fix pairs, verified declared `done`s) since the last side lesson pass, and in the whole scope. */
	armsSinceLessonPass: number;
	armsInScope: number;
	/** A check passed in this operator turn: a declared `done` beside it is the third side arm (DESIGN 4.4, MD14). */
	/**
	 * The step of this operator turn's last passed check, and of the session's last change of the tree: a declared
	 * `done` beside a check no change came after is the third side arm (DESIGN 4.4, MD14).
	 */
	checkStepThisTurn: number;
	lastTreeChangeStep: number;
	/** Orders every check and change those two record, a gateway chain's steps included. */
	evidenceSequence: number;
	/** Operator turns in this scope, and the one the last side lesson pass ran in: at most one pass per turn. */
	turnSequence: number;
	lessonPassTurn: number;
	toolStep: number;
	lastTurnEndStep: number;
	/**
	 * Step of the last call that changed the workspace. A failure before it
	 * belongs to an older tree: rerunning the same check after an edit is the
	 * verification the finish contract asks for, not a repeat.
	 */
	lastWorkspaceChangeStep: number;
	reactivateAfterCompaction: boolean;
	lastInjectedOperationFingerprint: string | null;
	currentTask: string;
	toolsSinceMemoryStep: number;
	// Counted apart from the maintenance cadence: an interval step that fired on
	// a turn's last tools left nothing "since the last step" and starved the pass.
	toolsSinceLessonPass: number;
	// Shell steps since the last lesson pass. One shell command is enough for an
	// idle lesson pass; reads alone need as many tools as the turn-end pass does.
	shellStepsSinceLessonPass: number;
	// The last launch yielded to occupancy. Until the endpoint has room, a new
	// boundary keeps its triggers pending instead of recording another drop.
	lastLaunchYielded: boolean;
	// The last launch found the model tier unavailable. Mid-turn boundaries keep
	// their triggers pending; a turn end or the guardian's recovery wake retries.
	lastLaunchUnavailable: boolean;
	// The budget refused the last launch. The guardian's idle wake must not ask
	// again before the next turn boundary, or a refused step would loop.
	lastLaunchSkipped: boolean;
	/** The current after_tool evaluation delivered approved lessons, so its firing names that match (C-32). */
	lessonDelivered: boolean;
	consecutiveErrors: number;
	lastPromptedBoundary: string | null;
	lastInjectedMessage: string | null;
	lastDecision: TaskMemoryPolicyResult["decision"] | null;
	readonly pendingTriggers: Set<MemoryInterventionTriggerReason>;
	readonly activity: TaskMemoryActivityEvent[];
	readonly annotatedThisTurn: Set<string>;
	operatorAskedRepeat: boolean;
	telemetryBankSnapshot: TaskMemorySnapshot;
	promptedStepInFlight: boolean;
	// The tier of the step currently holding the single in-flight slot, so a
	// dropped boundary can name what it was starved by.
	promptedStepTier: TaskMemoryTelemetryTier;
	outstandingStep: Promise<void>;
	rulesInjectedSincePromptedStep: boolean;
	annotatedSinceTurnEnd: boolean;
	consecutiveLlmTimeouts: number;
	/** Last compaction or working-set reduction in this scope; cadence reminders must cite a fact older than it. */
	contextLostAt: string | null;
	// Approved lessons are looked up once per session scope, at its first workspace change.
	durableLessonsChecked: boolean;
	/** Surfaced lesson id to the commands it quotes, until one of them succeeds in this session. */
	readonly durableWatch: Map<string, ReadonlyArray<string>>;
	/** Approved lessons whose reminder this session submitted, by any trigger. */
	readonly deliveredLessons: Set<string>;
	/** Approved lessons with a produced reminder not yet submitted; not offered again meanwhile. */
	readonly offeredLessons: Set<string>;
	/** Produced reminders awaiting the host's submission receipt, oldest first. */
	readonly pendingOffers: Map<string, PendingOffer>;
	/** Exact contents already submitted this scope; the same text is never offered again. */
	readonly submittedContents: Set<string>;
	/**
	 * Whether this session's `# Memory` section (or a `# Memory update` it was sent) already carries a lesson, as the
	 * host last reported it with the turn's task. No reminder repeats a fact the section carries (DESIGN 4.4).
	 */
	sectionCarries: (id: string) => boolean;
	readonly captureContentGuard: (content?: string) => () => boolean;
	readonly workspaceRoot: () => string;
	readonly produceOffer: (
		spec: Omit<MemoryInterventionOffer, "id" | "workspaceRoot"> & { workspaceRoot?: string },
		onSubmitted: (offer: MemoryInterventionOffer) => void,
	) => MemoryInterventionOffer | null;
	readonly releaseOffer: (id: string) => void;
	readonly offerCurrent: (offer: MemoryInterventionOffer) => boolean;
	readonly citedStillHolds: (
		offer: MemoryInterventionOffer,
		cited: MemoryInterventionOffer["cited"][number],
		entry: TaskMemoryEntry,
	) => boolean;
	readonly openFailureEpisodes: (
		fingerprints?: ReadonlySet<string>,
	) => Array<{ fingerprint: string; firstStep: number; entryId: string }>;
	readonly keptLessons: () => ReadonlyArray<KeptLesson>;
	readonly sideLessonArmed: () => boolean;
	readonly idleLessonWorth: () => boolean;
	readonly observeDeclaration: (input: MiddlewareHookInput) => void;
	readonly noteCheckOrChange: (
		toolName: string,
		rawArgs: Record<string, unknown> | undefined,
		details: MiddlewareHookInput["toolResultDetails"],
		settled: { ok: boolean; ran: boolean; actionClass: string | undefined },
	) => void;
	readonly noteFailedForFix: (command: string, cwd: unknown) => void;
	readonly fixNotes: () => ReadonlyArray<KeptLesson>;
	readonly notifyTurnBoundary: (kind: "start" | "end") => void;
	readonly observeSession: (input: MiddlewareHookInput) => void;
	readonly cancelStoppedTurn: () => void;
	readonly settings: () => Required<MemoryInterventionSettings>;
	readonly runPromptedStep: (input: MemoryPromptedStepInput) => Promise<MemoryPromptedStepResult>;
	readonly emitTelemetry: (
		triggerReasons: ReadonlyArray<TaskMemoryTelemetryTrigger>,
		tier: TaskMemoryTelemetryTier,
		decision: TaskMemoryTelemetryDecision,
		reason: TaskMemoryPolicyReason,
		citedEntries: number,
		inputTokens: Fact<number>,
		outputTokens: Fact<number>,
		started: bigint,
		operations?: {
			calls?: TaskMemoryPolicyResult["calls"];
			bankOperations: number;
			droppedOperations: number;
			refusalReason?: string;
			resumeAt?: string;
		},
		route?: TaskMemoryRoute,
		context?: TelemetryContext | null | undefined,
	) => void;
	readonly citedEntries: (message: string | null) => TaskMemoryEntry[];
	readonly citedEntryCount: (message: string | null) => number;
	readonly startDeliveryWatch: (offer: MemoryInterventionOffer) => void;
	readonly keptLessonsForPass: () => ReadonlyArray<{ id: string; text: string }>;
	readonly reviewKnowledge: (before: ReadonlyArray<TaskMemoryEntry>) => void;
	readonly settleDeliveries: (final: boolean) => void;
	readonly noteCommandEvidence: (segment: CommandSegment) => void;
	readonly noteReadEvidence: (path: string, excerpt: string, root: string) => void;
	readonly recordShownRead: (path: string, details: Readonly<Record<string, unknown>> | undefined) => void;
	readonly observeBeforeTool: (input: MiddlewareHookInput) => void;
	readonly observeAfterTool: (input: MiddlewareHookInput) => ReadonlyArray<MiddlewareEffect>;
	readonly rememberSucceededCommand: (command: string, cwd: unknown) => void;
	readonly noteVerifyRun: (settledOk: boolean, details: unknown) => void;
	readonly surfaceDurableLessons: (
		args: Readonly<Record<string, unknown>> | undefined,
	) => ReadonlyArray<MiddlewareEffect>;
	readonly surfaceForVerificationGap: () => ReadonlyArray<MiddlewareEffect>;
	readonly surfaceForSubject: (
		toolName: string,
		args: Readonly<Record<string, unknown>> | undefined,
	) => ReadonlyArray<MiddlewareEffect>;
	readonly surfaceRecipeForFailure: (command: string) => ReadonlyArray<MiddlewareEffect>;
	readonly settleDurableLessons: (segment: CommandSegment) => void;
	readonly annotateRepeatedFailure: (step: TrajectoryStep) => ReadonlyArray<MiddlewareEffect>;
	readonly rememberFailure: (step: TrajectoryStep) => void;
}

/** The content revision a reminder cites; a rewrite under the same id is a different fact. */
export function entryRevision(entry: Pick<TaskMemoryEntry, "content">): string {
	return sha256Hex(entry.content).slice(0, 16);
}

export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
	if (!map.has(key) && map.size >= capacity) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}
