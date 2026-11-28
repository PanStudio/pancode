// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_SETTINGS, type MemoryDeliveryMode, type MemoryLessonsMode } from "../../core/defaults.js";
import { neutralizeFraming } from "../../core/reminder-framing.js";
import { MIDDLEWARE_HOOKS } from "../../core/telemetry/session-vocabulary.js";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../core/tool-surface.js";
import { isRecord } from "../../core/type-guards.js";
import { headForRedaction } from "../../lib/secrets/redact.js";
import { isRefusalToolResultError } from "../../tools/result-disposition.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../middleware/types.js";
import { MEMORY_CONSOLIDATION_SYSTEM_PROMPT } from "../prompts/memory-intervention.js";
import { callChangesTree, checkPassedForCall } from "../safety/run-effects.js";
import { ceilChars } from "../session/context-accounting.js";
import {
	atWorkspaceRoot,
	COMMAND_EVIDENCE_REF_PREFIX,
	type CommandSegment,
	commandSegment,
	commandSegments,
	receiptVouches,
	sameCommandIdentity,
	successfulShellReceipt,
	verifyReceiptCommand,
	verifyRunPassed,
} from "./command-evidence.js";
import { MemoryCommitState } from "./commit-state.js";
import {
	budgetSkipped,
	collapseWhitespace,
	entryRevision,
	type FailedAttempt,
	type InterventionScope,
	NO_EFFECTS,
	noTokens,
	type PendingOffer,
	type ShownRead,
	setBounded,
	type TrajectoryStep,
	YIELDED_REASONS,
} from "./intervention/scope.js";
import { createInterventionTelemetry } from "./intervention/telemetry.js";
import {
	chainChildText,
	documentationChange,
	type PendingToolStep,
	pendingKey,
	prepareToolStep,
	resultDigest,
	verificationGap,
	WORKSPACE_CHANGING_CLASSES,
} from "./intervention-tool-step.js";
import type {
	MemoryDeliveryOutcome,
	MemoryInterventionDeps,
	MemoryInterventionOffer,
	MemoryInterventionRegistration,
	MemoryInterventionSettings,
	MemoryInterventionTriggerReason,
	MemoryPromptedStepInput,
	MemoryPromptedStepResult,
	MemoryStepLaunchOutcome,
} from "./intervention-types.js";
import {
	commandSubject,
	lessonEvidence,
	readInsideRoot,
	recordObservedRead,
	repositoryRelativePath,
} from "./lesson-evidence.js";
import { type KeptLesson, renderKeptLesson } from "./lesson-projection.js";
import type { TaskMemoryTelemetryDecision, TaskMemoryTelemetryTier } from "./memory-events.js";
import { exercisesWork, fixPairOf, type MemoryNoteEvidence } from "./notes.js";
import { sharesInvocationTarget } from "./recipes.js";
import { lessonsForTask } from "./relevance.js";
import { redactForMemoryRoute } from "./secret-text.js";
import { TASK_MEMORY_DEFAULT_PROCEDURAL_CAP, type TaskMemoryEntry } from "./task-bank.js";
import {
	runTaskMemoryPolicy,
	TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
	type TaskMemoryEnvelope,
	type TaskMemoryModelClient,
	type TaskMemoryPolicyReason,
	type TaskMemoryPolicyResult,
	type TaskMemoryRoute,
} from "./task-memory-policy.js";
import { positiveInteger, shortText } from "./util.js";

const MEMORY_INTERVENTION_REGISTRATION_ID = "observer.memory-intervention";
const MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS = 8;
const MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS = 2_000;
const MEMORY_INTERVENTION_DEFAULT_EVERY_N_TOOLS = 10;
/** Two full deadlines are enough evidence to stop spending this session's endpoint. */
const MEMORY_INTERVENTION_TIMEOUT_BACKOFF_THRESHOLD = 2;
/** Recurrences after submission of a failure the reminder was about before it counts as contradicted. */
const MEMORY_DELIVERY_CONTRADICTED_RECURRENCES = 2;
const MEMORY_DELIVERY_WATCH_LIMIT = 16;

/** Reasons that mean the model tier cannot run right now; deterministic rules keep working. */
const UNAVAILABLE_REASONS: ReadonlySet<TaskMemoryPolicyReason> = new Set([
	"no_client",
	"client_error",
	"information_flow_blocked",
	"llm_timeout_backoff",
]);
/**
 * Tool calls since the last lesson pass that make a finished turn worth one.
 * Every other trigger fires mid-turn, so the model never saw how the turn
 * ended: in a live session its last step ran before the passing test and it
 * never learned which of its notes had been right.
 */
const MEMORY_INTERVENTION_TURN_END_MIN_TOOLS = 2;
/** A firing that delivered an approved lesson matched it; the registration's own evidence names a failure recurrence. */
const DURABLE_LESSON_EVIDENCE = "match:durable-lesson@task-memory";
/**
 * Operator wording that asks for the same command to run again. A repeat the
 * operator requested in the current turn is the task, not a repeated mistake
 * (p8/B5), so the failure reminders stay quiet for that turn.
 */
const OPERATOR_REPEAT_REQUEST =
	/\b(?:again|twice|thrice|(?:a|the)\s+(?:second|third)\s+time|second\s+run|once\s+more|one\s+more\s+time|(?:two|three)\s+(?:times|runs))\b/iu;
const OPERATOR_COMMAND_REQUEST =
	/^(?:(?:please|then|and)\s+|(?:can|could|would)\s+you\s+)*(run|execute|invoke|try|re-?run|re-?try|repeat)\b/iu;

function operatorRequestsCommandRepeat(text: string): boolean {
	// p8/B5 applies to affirmative command requests. A task about a retry
	// handler or a prohibition on running again must retain failure warnings.
	return text.split(/[\n!?;,]+|\.(?:\s+|$)/u).some((clause) => {
		const request = clause.trim();
		const command = OPERATOR_COMMAND_REQUEST.exec(request)?.[1];
		return (
			command !== undefined &&
			(/^(?:re-?run|re-?try|repeat)$/iu.test(command) || OPERATOR_REPEAT_REQUEST.test(request)) &&
			!/\b(?:not|never|avoid|stop|without)\b|\bdon['’]?t\b/iu.test(request)
		);
	});
}

const TURN_LOG_LIMIT = 40;
/** Produced reminders awaiting submission; the oldest is released first. */
const PENDING_OFFER_LIMIT = 32;
/** Requests a produced reminder may miss before it is treated as dropped and released. */
const OFFER_MISSED_SUBMISSION_LIMIT = 3;
/** Kept lessons the turn-end pass is shown so it does not rewrite them. */
const KEPT_LESSONS_FOR_PASS = 10;
const SUBMITTED_CONTENT_LIMIT = 128;
const TURN_LOG_CALL_MAX_CHARS = 300;
const VERIFIED_COMMAND_LIMIT = 256;
/** Line ranges kept per read path, and paths kept, for binding a `memory_note` quote to what a read showed. */
const SHOWN_READS_PER_PATH = 8;
const SHOWN_READ_PATHS = 256;
const TURN_LOG_READ_EXCERPT_CHARS = 240;

/** Reasons that mean the model never produced a usable answer, so the bank it left says nothing. */
const UNANSWERED_REASONS: ReadonlySet<TaskMemoryPolicyReason> = new Set([
	"unparseable",
	"all_operations_invalid",
	"deadline",
	"timed_out",
	"endpoint_busy",
	"endpoint_preempted",
	"cost_ceiling",
	"quota_unknown",
	"quota_window",
	"quota_retry",
	"time_budget",
	"side_share",
	"client_error",
	"information_flow_blocked",
	"no_client",
	"no_consumer",
	"step_in_flight",
	"llm_timeout_backoff",
	"scope_changed",
]);

/**
 * Rules-only proactive-memory policy. It observes bounded tool history and
 * emits only cited, advisory reminders through the existing visible channel.
 */
export function createMemoryInterventionRegistration(deps: MemoryInterventionDeps): MemoryInterventionRegistration {
	const scope: InterventionScope = {
		deps,
		generation: 0,
		stepContext: undefined,
		commitState: null,
		commitScope: null,
		commitBridgeEnabled: false,
		generationController: new AbortController(),
		observedSessionId: undefined,
		disposed: false,
		pending: new Map<string, PendingToolStep>(),
		trajectory: [],
		failures: new Map<string, FailedAttempt>(),
		deliveries: [],
		turnLog: [],
		succeededCommands: new Set<string>(),
		succeededSegments: new Map<string, CommandSegment>(),
		unpassedVerifyChecks: new Map<string, string>(),
		observedReads: new Map<string, string[]>(),
		failedForFix: new Map<string, { segment: CommandSegment; step: number }>(),
		shownReads: new Map<string, ShownRead[]>(),
		armsSinceLessonPass: 0,
		armsInScope: 0,
		checkStepThisTurn: 0,
		lastTreeChangeStep: 0,
		evidenceSequence: 0,
		turnSequence: 0,
		lessonPassTurn: -1,
		toolStep: 0,
		lastTurnEndStep: 0,
		lastWorkspaceChangeStep: 0,
		reactivateAfterCompaction: false,
		lastInjectedOperationFingerprint: null,
		currentTask: "(current task unavailable)",
		toolsSinceMemoryStep: 0,
		toolsSinceLessonPass: 0,
		shellStepsSinceLessonPass: 0,
		lastLaunchYielded: false,
		lastLaunchUnavailable: false,
		lastLaunchSkipped: false,
		lessonDelivered: false,
		consecutiveErrors: 0,
		lastPromptedBoundary: null,
		lastInjectedMessage: null,
		lastDecision: null,
		pendingTriggers: new Set<MemoryInterventionTriggerReason>(),
		activity: [],
		annotatedThisTurn: new Set<string>(),
		operatorAskedRepeat: false,
		telemetryBankSnapshot: deps.bank.snapshot(),
		promptedStepInFlight: false,
		promptedStepTier: "rules",
		outstandingStep: Promise.resolve(),
		rulesInjectedSincePromptedStep: false,
		annotatedSinceTurnEnd: false,
		consecutiveLlmTimeouts: 0,
		contextLostAt: null,
		durableLessonsChecked: false,
		durableWatch: new Map<string, ReadonlyArray<string>>(),
		deliveredLessons: new Set<string>(),
		offeredLessons: new Set<string>(),
		pendingOffers: new Map<string, PendingOffer>(),
		submittedContents: new Set<string>(),
		sectionCarries: () => false,
		get captureContentGuard() {
			return captureContentGuard;
		},
		get workspaceRoot() {
			return workspaceRoot;
		},
		get produceOffer() {
			return produceOffer;
		},
		get releaseOffer() {
			return releaseOffer;
		},
		get offerCurrent() {
			return offerCurrent;
		},
		get citedStillHolds() {
			return citedStillHolds;
		},
		get openFailureEpisodes() {
			return openFailureEpisodes;
		},
		get keptLessons() {
			return keptLessons;
		},
		get sideLessonArmed() {
			return sideLessonArmed;
		},
		get idleLessonWorth() {
			return idleLessonWorth;
		},
		get observeDeclaration() {
			return observeDeclaration;
		},
		get noteCheckOrChange() {
			return noteCheckOrChange;
		},
		get noteFailedForFix() {
			return noteFailedForFix;
		},
		get fixNotes() {
			return fixNotes;
		},
		get notifyTurnBoundary() {
			return notifyTurnBoundary;
		},
		get observeSession() {
			return observeSession;
		},
		get cancelStoppedTurn() {
			return cancelStoppedTurn;
		},
		get settings() {
			return settings;
		},
		get runPromptedStep() {
			return runPromptedStep;
		},
		get emitTelemetry() {
			return emitTelemetry;
		},
		get citedEntries() {
			return citedEntries;
		},
		get citedEntryCount() {
			return citedEntryCount;
		},
		get startDeliveryWatch() {
			return startDeliveryWatch;
		},
		get keptLessonsForPass() {
			return keptLessonsForPass;
		},
		get reviewKnowledge() {
			return reviewKnowledge;
		},
		get settleDeliveries() {
			return settleDeliveries;
		},
		get noteCommandEvidence() {
			return noteCommandEvidence;
		},
		get noteReadEvidence() {
			return noteReadEvidence;
		},
		get recordShownRead() {
			return recordShownRead;
		},
		get observeBeforeTool() {
			return observeBeforeTool;
		},
		get observeAfterTool() {
			return observeAfterTool;
		},
		get rememberSucceededCommand() {
			return rememberSucceededCommand;
		},
		get noteVerifyRun() {
			return noteVerifyRun;
		},
		get surfaceDurableLessons() {
			return surfaceDurableLessons;
		},
		get surfaceForVerificationGap() {
			return surfaceForVerificationGap;
		},
		get surfaceForSubject() {
			return surfaceForSubject;
		},
		get surfaceRecipeForFailure() {
			return surfaceRecipeForFailure;
		},
		get settleDurableLessons() {
			return settleDurableLessons;
		},
		get annotateRepeatedFailure() {
			return annotateRepeatedFailure;
		},
		get rememberFailure() {
			return rememberFailure;
		},
	};
	const captureContentGuard = (content?: string): (() => boolean) => {
		const capturedGeneration = scope.generation;
		const owner = scope.commitState;
		const capturedScope = scope.commitScope;
		const stamp = owner?.capture();
		const offer = content === undefined ? undefined : offerForContent(content);
		return () =>
			!scope.disposed &&
			// A reminder buffered before memory went off is not sent after it.
			settings().enabled &&
			scope.generation === capturedGeneration &&
			scope.commitState === owner &&
			(!owner || (!!stamp && !!capturedScope && owner.isCurrent(stamp, capturedScope))) &&
			(offer === undefined || offerCurrent(offer));
	};
	const workspaceRoot = (): string => {
		try {
			return deps.workspaceRoot?.() ?? process.cwd();
		} catch {
			return process.cwd();
		}
	};
	const groundingOf = (entry: TaskMemoryEntry) =>
		lessonEvidence(entry, {
			succeededCommands: scope.succeededCommands,
			observedReads: scope.observedReads,
			workspaceRoot: workspaceRoot(),
		});
	let offerSequence = 0;
	const { emitTelemetry, citedEntries, citedEntryCount } = createInterventionTelemetry(scope);

	return {
		captureMemoryAuthority: () =>
			scope.commitScope && scope.commitState
				? { scope: { ...scope.commitScope }, stamp: scope.commitState.capture() }
				: null,
		bindCommitScope(next) {
			scope.commitBridgeEnabled = true;
			if (
				scope.commitScope?.sessionId === next.sessionId &&
				scope.commitScope.branchAnchorTurnId === next.branchAnchorTurnId &&
				scope.commitState
			)
				return;
			if (scope.commitState) reset();
			scope.commitScope = { ...next };
			scope.commitState = new MemoryCommitState(next, scope.generation);
			scope.observedSessionId = next.sessionId;
			scope.stepContext = { sessionId: next.sessionId, agent: { role: "memory", id: next.sessionId } };
		},
		notifyContextCommitted(input) {
			return scope.commitState?.notifyContextCommitted(input, scope.generation);
		},
		prepareRestoration(currentState, maxTokens) {
			if (!scope.commitScope || !settings().enabled) return null;
			return (
				scope.commitState?.prepareRestoration({
					scope: scope.commitScope,
					generation: scope.generation,
					bank: deps.bank.snapshot(),
					currentState,
					maxTokens: Math.min(maxTokens, settings().maxTokens),
				}) ?? null
			);
		},
		canAcknowledgeRestoration(offer) {
			return (
				!!scope.commitScope && !!scope.commitState?.canAcknowledgeRestoration(offer, scope.commitScope, scope.generation)
			);
		},
		acknowledgeRestoration(offer) {
			if (!scope.commitScope || !scope.commitState?.acknowledgeRestoration(offer, scope.commitScope, scope.generation))
				return false;
			deps.bank.recordInjection(offer.citedEntryIds);
			return true;
		},
		releaseRestoration(offer) {
			return !!scope.commitScope && !!scope.commitState?.releaseRestoration(offer, scope.commitScope, scope.generation);
		},
		isContentCurrent: captureContentGuard,
		hasPendingOffers: () => !scope.disposed && scope.pendingOffers.size > 0,
		acknowledgeSubmission(texts) {
			if (scope.disposed || scope.pendingOffers.size === 0) return [];
			const acknowledged: MemoryInterventionOffer[] = [];
			for (const [id, pending] of [...scope.pendingOffers]) {
				if (!texts.some((text) => text.includes(pending.offer.content))) {
					pending.missedSubmissions += 1;
					if (pending.missedSubmissions >= OFFER_MISSED_SUBMISSION_LIMIT) releaseOffer(id);
					continue;
				}
				scope.pendingOffers.delete(id);
				if (pending.generation !== scope.generation) continue;
				rememberSubmittedContent(pending.offer.content);
				try {
					pending.onSubmitted(pending.offer);
				} catch {
					// Delivery bookkeeping never fails the request that carried the reminder.
				}
				acknowledged.push(pending.offer);
			}
			return acknowledged;
		},
		offerLessonsForTask(task, carried) {
			scope.sectionCarries = carried;
			if (scope.disposed || !settings().enabled) return "";
			try {
				const lessons = lessonsForTask(
					task,
					keptLessons().filter((lesson) => !carried(lesson.id)),
				);
				const [effect] = deliverDurableLessons("durable_lesson_task", lessons);
				return effect?.kind === "annotate_tool_result" ? effect.message : "";
			} catch {
				// The section and memory_recall still stand; a turn never fails on this.
				return "";
			}
		},
		noteEvidence(args) {
			if (args.command !== undefined && args.path !== undefined)
				return { refused: "give command or path, not both: one note binds one piece of evidence" };
			const root = workspaceRoot();
			if (args.command !== undefined) {
				const claim = commandSegment(args.command, root);
				const ran = claim === null ? undefined : scope.succeededSegments.get(claim.key);
				if (ran === undefined) {
					const check = claim === null ? undefined : scope.unpassedVerifyChecks.get(claim.key);
					return {
						refused:
							check === undefined
								? `\`${args.command}\` has not succeeded from the workspace root in this session; run it first, or leave command out`
								: `\`${args.command}\` ran through verify${check ? ` check \`${check}\`` : ""} in this session and did not pass, so it is no evidence; fix it and run it again, or leave command out`,
					};
				}
				if (!exercisesWork(ran))
					return {
						refused: `\`${args.command}\` is a help, version or always-succeeding command, so it is no evidence; leave command out`,
					};
				return { kind: "command", segment: ran };
			}
			if (args.path !== undefined) return shownQuote(args.note, args.path, root);
			return null;
		},
		sideArmCount: () => scope.armsInScope,
		reset,
		dispose(): void {
			scope.disposed = true;
			reset();
		},
		id: MEMORY_INTERVENTION_REGISTRATION_ID,
		description: "maintain bounded task execution memory and selectively remind after repeated failures or compaction",
		hooks: MIDDLEWARE_HOOKS,
		evidence: "count:failure-recurrence@task-memory",
		evaluate(input, context): ReadonlyArray<MiddlewareEffect> {
			observeSession(input);
			if (input.hook === "turn_end" || input.hook === "turn_start") scope.lastLaunchSkipped = false;
			if (input.hook === "turn_end") notifyTurnBoundary("end");
			else if (input.hook === "turn_start" && input.metadata?.requestContinuation !== true) notifyTurnBoundary("start");
			if (scope.disposed || !settings().enabled) return NO_EFFECTS;
			try {
				switch (input.hook) {
					case "before_tool":
						observeBeforeTool(input);
						return NO_EFFECTS;
					case "after_tool": {
						scope.lessonDelivered = false;
						const effects = observeAfterTool(input);
						if (scope.lessonDelivered && effects.length > 0) context?.evidence?.(DURABLE_LESSON_EVIDENCE);
						return effects;
					}
					case "turn_end": {
						if (input.metadata?.stopReason === "aborted") {
							cancelStoppedTurn();
							return NO_EFFECTS;
						}
						observeDeclaration(input);
						// Middleware continuations can evaluate turn_end again without any
						// completed tools. They are not new memory boundaries and must not
						// replace the prior operator-visible outcome or emit telemetry.
						if (scope.toolStep <= scope.lastTurnEndStep) return NO_EFFECTS;
						settleDeliveries(false);
						// A mid-turn annotation already reported this boundary's rules-tier
						// outcome. Reporting silence again would double-count one decision.
						const alreadyReported = scope.annotatedSinceTurnEnd;
						scope.annotatedSinceTurnEnd = false;
						const started = process.hrtime.bigint();
						const effects = decideRepeatedFailure();
						if (alreadyReported && effects.length === 0) return effects;
						emitTelemetry(
							[effects.length > 0 ? "repeated_failure" : "turn_end"],
							"rules",
							effects.length > 0 ? "injected" : "silent",
							effects.length > 0 ? "intervened" : "no_repeated_failure",
							citedEntryCount(effects[0]?.kind === "inject_reminder" ? effects[0].message : null),
							noTokens,
							noTokens,
							started,
						);
						return effects;
					}
					case "on_compaction":
						// Recall grows the working set; it is an observability point, not
						// context loss that should reactivate compacted task memory.
						if (input.metadata?.stage === "working_set_recall") return NO_EFFECTS;
						scope.contextLostAt = new Date().toISOString();
						if (!scope.commitBridgeEnabled) scope.reactivateAfterCompaction = true;
						return NO_EFFECTS;
					case "turn_start": {
						if (input.metadata?.requestContinuation !== true) {
							scope.operatorAskedRepeat = false;
							scope.turnLog.length = 0;
							scope.turnSequence += 1;
							scope.checkStepThisTurn = 0;
						}
						if (input.text?.trim()) {
							// Bounded first: this runs synchronously at turn start on a prompt of any length.
							scope.currentTask = shortText(redactForMemoryRoute(headForRedaction(input.text, 16_384)), 2_000);
							scope.operatorAskedRepeat = operatorRequestsCommandRepeat(input.text);
						}
						// Mid-turn annotations are spent per turn, not per session: the same
						// command failing again in a later turn is news again.
						scope.annotatedThisTurn.clear();
						const shouldReactivate = scope.reactivateAfterCompaction;
						const started = process.hrtime.bigint();
						const effects = reactivateKnowledge();
						if (shouldReactivate) {
							emitTelemetry(
								["post_compaction"],
								"rules",
								effects.length > 0 ? "injected" : "silent",
								effects.length > 0 ? "intervened" : "bank_empty",
								citedEntryCount(effects[0]?.kind === "inject_reminder" ? effects[0].message : null),
								noTokens,
								noTokens,
								started,
							);
						}
						return effects;
					}
				}
			} catch {
				return NO_EFFECTS;
			}
		},
		/**
		 * Kicks off the background memory step and returns immediately. The pi
		 * agent does not go idle until every `agent_end` listener settles, so
		 * awaiting a local memory model here would stall the visible turn for its
		 * full latency. Small local models measure in tens of seconds, which is far
		 * past any tolerable end-of-turn pause and past the policy timeout itself.
		 * The reminder is delivered through `onDeferredReminder` instead, landing
		 * at the next native tool-batch boundary or the next submitted turn.
		 */
		async evaluateAsync(input, context): Promise<ReadonlyArray<MiddlewareEffect>> {
			observeSession(input);
			if (input.hook === "turn_end" && input.metadata?.stopReason === "aborted") {
				cancelStoppedTurn();
				return NO_EFFECTS;
			}
			const boundaryHook =
				input.hook === "turn_end" || (input.hook === "after_tool" && input.metadata?.stage === "tool_batch_end");
			if (input.hook === "turn_end" && !scope.disposed && settings().enabled && sideLessonArmed())
				scope.pendingTriggers.add("turn_end");
			if (scope.disposed || !settings().enabled || !boundaryHook || scope.pendingTriggers.size === 0) return NO_EFFECTS;
			const boundary = input.turnId ?? input.metadata?.userTurnId?.toString() ?? `tool-step:${scope.toolStep}`;
			if (boundary === scope.lastPromptedBoundary) return NO_EFFECTS;
			// One row rather than none, so a headless operator reading the log sees
			// why the tier never ran instead of finding nothing and guessing.
			if (deps.deliversDeferredReminders === false) {
				emitTelemetry(
					[...scope.pendingTriggers],
					"rules",
					"silent",
					"no_consumer",
					0,
					noTokens,
					noTokens,
					process.hrtime.bigint(),
				);
				scope.pendingTriggers.clear();
				return NO_EFFECTS;
			}
			if (deps.deferBoundaryPolicy?.()) return NO_EFFECTS;
			// A step slower than the turns that trigger it must not queue: dropping
			// this boundary keeps at most one background call alive per session. The
			// drop is recorded, because a starved cadence and a quiet one are
			// otherwise indistinguishable in the telemetry log. Triggers stay pending
			// so the next free boundary still runs for them.
			if (scope.promptedStepInFlight) {
				emitTelemetry(
					[...scope.pendingTriggers],
					scope.promptedStepTier,
					"dropped",
					"step_in_flight",
					0,
					noTokens,
					noTokens,
					process.hrtime.bigint(),
				);
				return NO_EFFECTS;
			}
			if (scope.lastLaunchYielded && endpointStillBusy()) return NO_EFFECTS;
			if (scope.lastLaunchUnavailable && input.hook !== "turn_end") return NO_EFFECTS;
			scope.lastPromptedBoundary = boundary;
			// The rules tier may already have spoken for this boundary, either as a
			// turn_end reminder in prior effects or as a mid-turn tool annotation.
			const priorRulesReminder =
				context?.priorEffects.some((effect) => effect.kind === "inject_reminder" && effect.message.startsWith("Memory:")) ??
				false;
			void launchPromptedStep(priorRulesReminder);
			return NO_EFFECTS;
		},
		runPromptedStep,
		pendingWork(): boolean {
			if (scope.disposed || !settings().enabled) return false;
			return scope.pendingTriggers.size > 0 || idleLessonWorth();
		},
		owesBoundaryStep(): boolean {
			return (
				!scope.disposed &&
				settings().enabled &&
				deps.deliversDeferredReminders !== false &&
				!scope.promptedStepInFlight &&
				!scope.lastLaunchUnavailable &&
				!scope.lastLaunchSkipped &&
				scope.pendingTriggers.size > 0
			);
		},
		async runIdleStep(): Promise<MemoryStepLaunchOutcome> {
			if (scope.disposed || !settings().enabled || scope.promptedStepInFlight) return "none";
			if (deps.deliversDeferredReminders === false) return "none";
			// Checked before arming `idle_review`, which would otherwise wait for the
			// next tool boundary and run a lesson pass mid-turn.
			if (scope.lastLaunchSkipped) return "skipped";
			if (scope.pendingTriggers.size === 0) {
				if (!idleLessonWorth()) return "none";
				scope.pendingTriggers.add("idle_review");
			}
			if (scope.lastLaunchYielded && endpointStillBusy()) return "yielded";
			scope.lastPromptedBoundary = `idle:${scope.toolStep}`;
			return launchPromptedStep(false);
		},
		signalLoop(): void {
			if (!scope.disposed && settings().enabled && settings().surfaces.correct === "model")
				scope.pendingTriggers.add("loop_signal");
		},
		lastDecision: () => scope.lastDecision,
		recentActivity: () => [...scope.activity],
		stepInFlight: () => scope.promptedStepInFlight,
		whenIdle: () => scope.outstandingStep,
	};

	/**
	 * Register a produced reminder. Returns null when the same text was already
	 * submitted in this scope: the agent has it in context, and a second copy
	 * would also make the submission receipt ambiguous.
	 */
	function produceOffer(
		spec: Omit<MemoryInterventionOffer, "id" | "workspaceRoot"> & { workspaceRoot?: string },
		onSubmitted: (offer: MemoryInterventionOffer) => void,
	): MemoryInterventionOffer | null {
		// The registry holds the text as the host frame delivers it, so the submission receipt still finds it.
		const content = neutralizeFraming(spec.content.trim());
		if (content.length === 0 || scope.submittedContents.has(content)) return null;
		for (const pending of scope.pendingOffers.values())
			if (pending.offer.content === content && pending.generation === scope.generation) return pending.offer;
		const offer: MemoryInterventionOffer = Object.freeze({
			...spec,
			id: `mo-${(++offerSequence).toString(36)}`,
			content,
			workspaceRoot: spec.workspaceRoot ?? workspaceRoot(),
		});
		scope.pendingOffers.set(offer.id, { offer, generation: scope.generation, onSubmitted, missedSubmissions: 0 });
		while (scope.pendingOffers.size > PENDING_OFFER_LIMIT) {
			const [oldest] = scope.pendingOffers.keys();
			if (oldest === undefined) break;
			releaseOffer(oldest);
		}
		return offer;
	}

	function releaseOffer(id: string): void {
		const pending = scope.pendingOffers.get(id);
		scope.pendingOffers.delete(id);
		for (const lesson of pending?.offer.lessons ?? []) scope.offeredLessons.delete(lesson.id);
		// The first-change surfacing never reached the model; leaving the check
		// spent would hide those lessons for the rest of the session.
		if (pending?.offer.trigger.reasons.includes("durable_lesson")) scope.durableLessonsChecked = false;
	}

	function rememberSubmittedContent(content: string): void {
		scope.submittedContents.add(content);
		if (scope.submittedContents.size > SUBMITTED_CONTENT_LIMIT)
			scope.submittedContents.delete(scope.submittedContents.values().next().value ?? content);
	}

	function offerForContent(content: string): MemoryInterventionOffer | undefined {
		const text = neutralizeFraming(content.trim());
		for (const pending of scope.pendingOffers.values()) if (text.includes(pending.offer.content)) return pending.offer;
		return undefined;
	}

	/**
	 * Revalidate the facts a reminder was produced from, at enqueue and again at
	 * submission. A cited entry deleted or rewritten (other than a still-open
	 * failure counting its repeat), a durable lesson no longer approved as
	 * written, or a correction whose failure episodes all resolved makes it
	 * stale. Unrelated activity in between changes none of these.
	 */
	function offerCurrent(offer: MemoryInterventionOffer): boolean {
		const pending = scope.pendingOffers.get(offer.id);
		if (scope.disposed || (pending !== undefined && pending.generation !== scope.generation)) return false;
		if (offer.kind === "durable_lesson") {
			const live = new Map([...keptLessons(), ...fixNotes()].map((lesson) => [lesson.id, lesson.revision]));
			return offer.lessons.every((lesson) => live.get(lesson.id) === lesson.revision);
		}
		const snapshot = deps.bank.snapshot();
		// The post-compaction restoration cites the status line too; leaving it
		// out would make that reminder stale the moment it was produced.
		const entries = new Map(
			[...(snapshot.status === null ? [] : [snapshot.status]), ...snapshot.knowledge, ...snapshot.procedural].map(
				(entry) => [entry.id, entry],
			),
		);
		for (const cited of offer.cited) {
			const entry = entries.get(cited.id);
			if (entry === undefined || !citedStillHolds(offer, cited, entry)) return false;
		}
		if (offer.trigger.failures.length === 0) return true;
		const open = offer.trigger.failures.filter(
			(episode) => scope.failures.get(episode.fingerprint)?.firstStep === episode.firstStep,
		);
		// A correction about failures that all resolved is stale; one cited
		// failure resolving also makes the text claim something no longer true.
		if (offer.kind === "corrective") return open.length > 0;
		const citedEpisodes = offer.trigger.failures.filter((episode) =>
			offer.cited.some((cited) => cited.id === episode.entryId),
		);
		return citedEpisodes.every((episode) => open.includes(episode));
	}

	/**
	 * A cited entry still says what the reminder was written from. A repeat of
	 * a still-open failure rewrites its procedural entry only to count the
	 * attempt and keep the latest error, which leaves a correction about that
	 * episode true; without this, the agent repeating the failure would be the
	 * very thing that dropped the correction.
	 */
	function citedStillHolds(
		offer: MemoryInterventionOffer,
		cited: MemoryInterventionOffer["cited"][number],
		entry: TaskMemoryEntry,
	): boolean {
		if (entryRevision(entry) === cited.revision) return true;
		return offer.trigger.failures.some(
			(episode) =>
				episode.entryId === cited.id && scope.failures.get(episode.fingerprint)?.firstStep === episode.firstStep,
		);
	}

	/** Failure episodes still open, as the reminder about to be produced sees them. */
	function openFailureEpisodes(
		fingerprints?: ReadonlySet<string>,
	): Array<{ fingerprint: string; firstStep: number; entryId: string }> {
		return [...scope.failures]
			.filter(([fingerprint]) => fingerprints === undefined || fingerprints.has(fingerprint))
			.map(([fingerprint, failure]) => ({ fingerprint, firstStep: failure.firstStep, entryId: failure.entryId }));
	}

	function keptLessons(): ReadonlyArray<KeptLesson> {
		if (!settings().enabled) return [];
		try {
			return deps.getKeptLessons?.() ?? [];
		} catch {
			// An unreadable store surfaces nothing; the session continues without it.
			return [];
		}
	}

	/**
	 * Start one detached step for every pending trigger. A step that yielded to
	 * endpoint occupancy puts its triggers back, so the work resumes at the next
	 * boundary or idle wake instead of being lost with the boundary that
	 * started it.
	 */
	function launchPromptedStep(priorRulesReminder: boolean): Promise<MemoryStepLaunchOutcome> {
		const triggers = [...scope.pendingTriggers];
		scope.pendingTriggers.clear();
		const priorToolsSinceMemoryStep = scope.toolsSinceMemoryStep;
		const priorToolsSinceLessonPass = scope.toolsSinceLessonPass;
		const priorShellStepsSinceLessonPass = scope.shellStepsSinceLessonPass;
		const consolidates = triggers.includes("turn_end") || triggers.includes("idle_review");
		const priorArms = scope.armsSinceLessonPass;
		const priorLessonPassTurn = scope.lessonPassTurn;
		scope.toolsSinceMemoryStep = 0;
		if (consolidates) {
			scope.toolsSinceLessonPass = 0;
			scope.shellStepsSinceLessonPass = 0;
			scope.armsSinceLessonPass = 0;
			scope.lessonPassTurn = scope.turnSequence;
		}
		scope.consecutiveErrors = 0;
		const rulesAlreadySpoke = scope.rulesInjectedSincePromptedStep || priorRulesReminder;
		scope.rulesInjectedSincePromptedStep = false;
		const stepGeneration = scope.generation;
		const contentCurrent = captureContentGuard();
		scope.promptedStepInFlight = true;
		notifyStepActivity();
		let outcome: MemoryStepLaunchOutcome = "none";
		const settled = runPromptedStep({
			deterministicTrigger: triggers.some(
				(trigger) => trigger !== "interval" && trigger !== "turn_end" && trigger !== "idle_review",
			),
			suppressIntervention: rulesAlreadySpoke,
			triggerReasons: triggers,
		})
			.then((result) => {
				if (!contentCurrent()) return;
				if (budgetSkipped(result.reason)) {
					// Nothing was reviewed. The lesson counters come back so the next turn
					// end still covers this work; the triggers and the interval count do
					// not, so the cadence decides again instead of every tool step.
					if (consolidates) {
						scope.toolsSinceLessonPass += priorToolsSinceLessonPass;
						scope.shellStepsSinceLessonPass += priorShellStepsSinceLessonPass;
						scope.armsSinceLessonPass += priorArms;
						scope.lessonPassTurn = priorLessonPassTurn;
					}
					scope.lastLaunchYielded = false;
					scope.lastLaunchUnavailable = false;
					scope.lastLaunchSkipped = true;
					outcome = "skipped";
					return;
				}
				scope.lastLaunchSkipped = false;
				const yielded = YIELDED_REASONS.has(result.reason);
				const unavailable = UNAVAILABLE_REASONS.has(result.reason);
				if (yielded || unavailable) {
					// Nothing was reviewed: restore the work the step claimed so a later
					// step reviews it. A yielded step retries once the endpoint has room;
					// an unavailable one parks until a turn end or recovery wake.
					for (const trigger of triggers) scope.pendingTriggers.add(trigger);
					scope.toolsSinceMemoryStep += priorToolsSinceMemoryStep;
					if (consolidates) {
						scope.toolsSinceLessonPass += priorToolsSinceLessonPass;
						scope.shellStepsSinceLessonPass += priorShellStepsSinceLessonPass;
						scope.armsSinceLessonPass += priorArms;
						scope.lessonPassTurn = priorLessonPassTurn;
					}
					scope.lastPromptedBoundary = null;
					scope.lastLaunchYielded = yielded;
					scope.lastLaunchUnavailable = unavailable;
					outcome = yielded ? "yielded" : "unavailable";
					return;
				}
				scope.lastLaunchYielded = false;
				scope.lastLaunchUnavailable = false;
				outcome = "ran";
				// A rules-only reminder can win the visible boundary while the optional
				// background route resolves to null. Preserve the operator-visible
				// injected outcome instead of overwriting it with that no-client silence.
				if (rulesAlreadySpoke && result.decision === "silent") scope.lastDecision = "injected";
				const offer = result.offer;
				if (result.reminder === null || offer === undefined) return;
				deps.onDeferredReminder?.(offer.content, () => contentCurrent() && offerCurrent(offer));
			})
			.catch(() => {
				// runPromptedStep already resolves failures to silence; this only
				// covers a throwing delivery sink, which must not surface anywhere.
			})
			.finally(() => {
				if (stepGeneration === scope.generation) scope.promptedStepInFlight = false;
				notifyStepActivity();
			});
		scope.outstandingStep = settled;
		return settled.then(() => outcome);
	}

	/**
	 * The side-model lesson pass is an opt-in (`lessons: side`) armed by evidence, not activity (DESIGN 4.4): a fix
	 * pair, or a `finish` declaration of `done` in an operator turn with a passed check (MD14), since the last pass, and
	 * at most one pass per operator turn, whether it runs at the turn's end or idle.
	 */
	function sideLessonArmed(): boolean {
		return (
			lessonsMode() === "side" &&
			scope.armsSinceLessonPass > 0 &&
			scope.lessonPassTurn !== scope.turnSequence &&
			scope.toolsSinceLessonPass >= MEMORY_INTERVENTION_TURN_END_MIN_TOOLS
		);
	}

	function idleLessonWorth(): boolean {
		return sideLessonArmed();
	}

	function lessonsMode(): MemoryLessonsMode {
		return settings().surfaces.lessons ?? DEFAULT_SETTINGS.context.memory.surfaces.lessons;
	}

	/**
	 * A turn's typed `finish` declaration, never its reply text (MD14). The bank's status becomes the declared state and
	 * its `remaining` items, the progress a compaction hands back. Under `lessons: side` a declared `done` in an operator
	 * turn whose check passed is an evidence arm; a `done` without one arms nothing.
	 */
	function observeDeclaration(input: MiddlewareHookInput): void {
		const state = input.metadata?.completionState;
		if (state !== "done" && state !== "partly_done" && state !== "not_done") return;
		const remaining = input.metadata?.completionRemaining;
		const items = typeof remaining === "string" ? remaining.split("\n").filter((item) => item.length > 0) : [];
		// The model's own words reach the bank, its file and a restored context only through the memory route's redaction.
		const open = items.length > 0 ? redactForMemoryRoute(headForRedaction(items.join("; "), 4_096)) : "";
		deps.bank.updateStatus(`declared ${state}${open.length > 0 ? `; remaining: ${open}` : ""}`);
		if (state !== "done" || scope.checkStepThisTurn <= scope.lastTreeChangeStep || lessonsMode() !== "side") return;
		scope.checkStepThisTurn = 0;
		scope.armsSinceLessonPass += 1;
		scope.armsInScope += 1;
	}

	/**
	 * A call that settled ok and passed a check that speaks for it (the safety domain's reader) is this turn's latest
	 * check; any other call that ran and changed the tree, a shell mutation included, is the latest change. A refused or
	 * blocked call ran nothing and changes nothing. A chain's steps count each as its own call, in order: every leaf call
	 * takes the next number of one sequence, so an edit then a check in one chain leaves the check standing.
	 */
	function noteCheckOrChange(
		toolName: string,
		rawArgs: Record<string, unknown> | undefined,
		details: MiddlewareHookInput["toolResultDetails"],
		settled: { ok: boolean; ran: boolean; actionClass: string | undefined },
	): void {
		const children = gatewayChainReceipts(toolName, { details });
		if (children.length > 0) {
			for (const child of children) {
				const childDetails = isRecord(child.result.details) ? child.result.details : {};
				const admitted = child.admission.decision === "allowed" && child.admission.outcome !== "blocked";
				const ok = admitted && child.admission.outcome === "ok" && childDetails.kind === "ok";
				const ran = ok || (admitted && !isRefusalToolResultError({ kind: "error", details: childDetails }));
				noteCheckOrChange(child.capability, child.args, childDetails, {
					ok,
					ran,
					actionClass: child.admission.actionClass,
				});
			}
			return;
		}
		const call = effectiveToolCall(toolName, rawArgs, details);
		const args = call.args === undefined ? undefined : { ...call.args };
		const root = workspaceRoot();
		if (settled.ok && checkPassedForCall(call.toolName, args, details, root)) {
			scope.evidenceSequence += 1;
			scope.checkStepThisTurn = scope.evidenceSequence;
			return;
		}
		if (!settled.ran) return;
		if (
			(settled.ok && WORKSPACE_CHANGING_CLASSES.has(String(settled.actionClass))) ||
			callChangesTree(call.toolName, args, root)
		) {
			scope.evidenceSequence += 1;
			scope.lastTreeChangeStep = scope.evidenceSequence;
		}
	}

	/** A lone shell invocation failed from the workspace root: it waits for a success that fixes it. */
	function noteFailedForFix(command: string, cwd: unknown): void {
		if (lessonsMode() === "off") return;
		const root = workspaceRoot();
		const at = typeof cwd === "string" ? cwd : undefined;
		// A failed chain does not say which segment failed, so only a lone invocation is a failed pattern.
		const segments = atWorkspaceRoot(root, at) ? commandSegments(command, root, at) : [];
		const [segment] = segments;
		if (segments.length !== 1 || segment === undefined || !exercisesWork(segment)) return;
		const subject = commandSubject(segment.argv, root);
		if (subject === null) return;
		scope.failedForFix.delete(subject.key);
		scope.failedForFix.set(subject.key, { segment, step: scope.toolStep });
		if (scope.failedForFix.size > VERIFIED_COMMAND_LIMIT)
			scope.failedForFix.delete(scope.failedForFix.keys().next().value ?? subject.key);
	}

	/**
	 * A succeeded segment closes its subject's waiting failure: by succeeding itself, or as the fix of a pair. A help,
	 * version or trivial call closes nothing. A workspace change since the failure voids it, as it voids a repeated
	 * failure's annotation: the edit, not the options, may be what fixed it.
	 */
	function pairFix(segment: CommandSegment): void {
		if (!exercisesWork(segment)) return;
		const subject = commandSubject(segment.argv, workspaceRoot());
		const waiting = subject === null ? undefined : scope.failedForFix.get(subject.key);
		if (subject === null || waiting === undefined) return;
		if (waiting.step <= scope.lastWorkspaceChangeStep) {
			scope.failedForFix.delete(subject.key);
			return;
		}
		const failed = waiting.segment;
		if (failed.key !== segment.key && !fixPairOf(failed, segment)) return;
		scope.failedForFix.delete(subject.key);
		if (failed.key === segment.key || lessonsMode() === "off") return;
		scope.armsSinceLessonPass += 1;
		scope.armsInScope += 1;
		try {
			deps.onFixPair?.({ failed, fixed: segment });
		} catch {
			// Filing is the owner's; a failure there never reaches the turn.
		}
	}

	function fixNotes(): ReadonlyArray<KeptLesson> {
		if (!settings().enabled) return [];
		try {
			return (deps.getFixNotes?.() ?? []).filter((note) => note.failed !== undefined);
		} catch {
			return [];
		}
	}

	function endpointStillBusy(): boolean {
		try {
			return deps.backgroundEndpointBusy?.() === true;
		} catch {
			// Unreadable occupancy fails closed: stay yielded rather than pile on.
			return true;
		}
	}

	function notifyTurnBoundary(kind: "start" | "end"): void {
		try {
			deps.onTurnBoundary?.(kind);
		} catch {
			// A wake signal never affects the turn it was raised from.
		}
	}

	function notifyStepActivity(): void {
		try {
			deps.onStepActivity?.();
		} catch {
			// Status refresh is observability; it never steers a step.
		}
	}

	function observeSession(input: MiddlewareHookInput): void {
		if (input.sessionId !== undefined) {
			if (scope.observedSessionId !== undefined && scope.observedSessionId !== input.sessionId) reset();
			scope.observedSessionId = input.sessionId;
		}
		const sessionId = input.sessionId ?? (input.runId === undefined ? scope.observedSessionId : undefined);
		if (sessionId === undefined && input.runId === undefined) return;
		const owner =
			sessionId !== undefined
				? { sessionId, ...(input.runId === undefined ? {} : { runId: input.runId }) }
				: { sessionId: null, runId: input.runId as string };
		const sameOwner = scope.stepContext?.sessionId === owner.sessionId && scope.stepContext?.runId === owner.runId;
		const turnId = input.turnId ?? (sameOwner ? scope.stepContext?.turnId : undefined);
		scope.stepContext = {
			...owner,
			agent: { role: "memory", id: owner.sessionId ?? (input.runId as string) },
			...(turnId === undefined ? {} : { turnId }),
		};
	}

	function cancelStoppedTurn(): void {
		if (!scope.promptedStepInFlight && scope.pendingTriggers.size === 0 && scope.toolStep <= scope.lastTurnEndStep) {
			// Nothing of this registration's is pending, so no generation bump or telemetry row;
			// the owner still drops its own in-flight content work.
			deps.onContentCancelled?.();
			return;
		}
		const tier = scope.promptedStepInFlight ? scope.promptedStepTier : "rules";
		// Retain completed bank entries, but revoke pending content and delivery
		// authority. Late provider usage still belongs to its captured origin.
		scope.generation += 1;
		scope.pendingOffers.clear();
		scope.offeredLessons.clear();
		scope.commitState?.cancel(scope.generation);
		deps.onContentCancelled?.();
		scope.generationController.abort();
		scope.generationController = new AbortController();
		scope.promptedStepInFlight = false;
		scope.outstandingStep = Promise.resolve();
		scope.pendingTriggers.clear();
		scope.toolsSinceMemoryStep = 0;
		scope.consecutiveErrors = 0;
		scope.lastTurnEndStep = scope.toolStep;
		scope.rulesInjectedSincePromptedStep = false;
		scope.annotatedSinceTurnEnd = false;
		scope.lastDecision = "silent";
		emitTelemetry(["turn_end"], tier, "silent", "scope_changed", 0, noTokens, noTokens, process.hrtime.bigint());
	}

	function reset(): void {
		scope.pendingOffers.clear();
		scope.submittedContents.clear();
		scope.offeredLessons.clear();
		scope.sectionCarries = () => false;
		try {
			const lessons = deps.bank.snapshot().knowledge.filter((entry) => entry.durable === true);
			if (lessons.length > 0) deps.onScopeEnd?.({ sessionId: scope.observedSessionId, lessons });
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
		settleDeliveries(true);
		scope.commitState?.dispose();
		scope.commitState = null;
		scope.commitScope = null;
		scope.generation += 1;
		scope.generationController.abort();
		scope.generationController = new AbortController();
		deps.bank.clear();
		scope.pending.clear();
		scope.turnLog.length = 0;
		scope.succeededCommands.clear();
		scope.succeededSegments.clear();
		scope.unpassedVerifyChecks.clear();
		scope.observedReads.clear();
		scope.failedForFix.clear();
		scope.shownReads.clear();
		scope.armsSinceLessonPass = 0;
		scope.armsInScope = 0;
		scope.checkStepThisTurn = 0;
		scope.lastTreeChangeStep = 0;
		scope.evidenceSequence = 0;
		scope.turnSequence = 0;
		scope.lessonPassTurn = -1;
		scope.trajectory.length = 0;
		scope.failures.clear();
		scope.toolStep = 0;
		scope.lastTurnEndStep = 0;
		scope.lastWorkspaceChangeStep = 0;
		scope.reactivateAfterCompaction = false;
		scope.lastInjectedOperationFingerprint = null;
		scope.currentTask = "(current task unavailable)";
		scope.toolsSinceMemoryStep = 0;
		scope.toolsSinceLessonPass = 0;
		scope.shellStepsSinceLessonPass = 0;
		scope.lastLaunchYielded = false;
		scope.lastLaunchUnavailable = false;
		scope.lastLaunchSkipped = false;
		scope.consecutiveErrors = 0;
		scope.lastPromptedBoundary = null;
		scope.lastInjectedMessage = null;
		scope.lastDecision = null;
		scope.pendingTriggers.clear();
		scope.activity.length = 0;
		scope.annotatedThisTurn.clear();
		scope.operatorAskedRepeat = false;
		scope.telemetryBankSnapshot = deps.bank.snapshot();
		scope.promptedStepInFlight = false;
		scope.promptedStepTier = "rules";
		scope.outstandingStep = Promise.resolve();
		scope.rulesInjectedSincePromptedStep = false;
		scope.annotatedSinceTurnEnd = false;
		scope.consecutiveLlmTimeouts = 0;
		scope.durableLessonsChecked = false;
		scope.durableWatch.clear();
		scope.deliveredLessons.clear();
		scope.contextLostAt = null;
		scope.observedSessionId = undefined;
		scope.stepContext = undefined;
	}

	function carriedBySection(id: string): boolean {
		try {
			return scope.sectionCarries(id);
		} catch {
			return false;
		}
	}

	function deliveryMode(): MemoryDeliveryMode {
		try {
			return deps.getDelivery?.() ?? "decision";
		} catch {
			return "decision";
		}
	}

	function settings(): Required<MemoryInterventionSettings> {
		const live = deps.getSettings?.();
		return {
			enabled: live?.enabled ?? deps.enabled ?? true,
			everyNTools: Math.max(
				2,
				positiveInteger(live?.everyNTools ?? deps.everyNTools, MEMORY_INTERVENTION_DEFAULT_EVERY_N_TOOLS),
			),
			windowSteps: positiveInteger(live?.windowSteps ?? deps.windowSteps, MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS),
			maxTokens: positiveInteger(live?.maxTokens ?? deps.maxTokens, MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS),
			timeoutMs: positiveInteger(live?.timeoutMs ?? deps.timeoutMs, TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS),
			surfaces: {
				correct: live?.surfaces?.correct ?? deps.surfaces?.correct ?? DEFAULT_SETTINGS.context.memory.surfaces.correct,
				bank: live?.surfaces?.bank ?? deps.surfaces?.bank ?? DEFAULT_SETTINGS.context.memory.surfaces.bank,
				lessons: live?.surfaces?.lessons ?? deps.surfaces?.lessons ?? DEFAULT_SETTINGS.context.memory.surfaces.lessons,
			},
		};
	}

	async function runPromptedStep(input: MemoryPromptedStepInput): Promise<MemoryPromptedStepResult> {
		const silent = (reason: TaskMemoryPolicyReason): MemoryPromptedStepResult => ({
			decision: "silent",
			reason,
			bankOperations: 0,
			droppedOperations: 0,
			reminder: null,
			inputTokens: { kind: "absent", reason: "not-applicable" },
			outputTokens: { kind: "absent", reason: "not-applicable" },
			usage: null,
			presentedEntries: [],
			effects: NO_EFFECTS,
		});
		const live = settings();
		// A detached answer keeps the turn that launched it, even if the foreground advances (#434).
		const launchContext = scope.stepContext;
		const isCurrent = captureContentGuard();
		// The workspace and the failure episodes this step is reasoning about are
		// captured with its authority: paths are checked against the session's
		// workspace, never the process directory, and a correction is bound to
		// the episodes that were open when it was asked for.
		const launchRoot = workspaceRoot();
		const launchFailures = openFailureEpisodes(
			new Set(scope.trajectory.filter((step) => step.outcome === "error").map((step) => step.operationFingerprint)),
		);
		if (scope.disposed || !live.enabled) {
			const result = silent("no_client");
			scope.lastDecision = result.decision;
			return result;
		}
		const started = process.hrtime.bigint();
		let attemptStarted = started;
		// The route of the attempt the next telemetry row describes. Fallback swaps it
		// with the client, so a row names the target that actually served the step.
		let attemptRoute: TaskMemoryRoute | undefined;
		const triggers = input.triggerReasons?.length ? input.triggerReasons : ["manual" as const];
		// A finished turn gets the lesson pass in place of bank maintenance: one
		// call either way, and the mid-turn steps already kept the bank current.
		const consolidate =
			input.triggerReasons?.includes("turn_end") === true || input.triggerReasons?.includes("idle_review") === true;
		let tier: TaskMemoryTelemetryTier = "rules";
		scope.promptedStepTier = tier;
		let promptedResult: TaskMemoryPolicyResult;
		// A boundary that never reached the model is a skipped boundary rather than
		// a policy decision, and `dropped` is the telemetry outcome for exactly
		// that. The returned decision stays `silent`, since no reminder was
		// produced and the policy vocabulary has no value for a step that never ran.
		let telemetryDecision: TaskMemoryTelemetryDecision | null = null;
		try {
			if (scope.consecutiveLlmTimeouts >= MEMORY_INTERVENTION_TIMEOUT_BACKOFF_THRESHOLD) {
				promptedResult = silent("llm_timeout_backoff");
			} else {
				const client = deps.getModelClient?.() ?? null;
				if (client === null) {
					promptedResult = silent("no_client");
				} else if (deps.backgroundEndpointBusy?.() === true) {
					tier = "llm";
					scope.promptedStepTier = tier;
					attemptRoute = client.route;
					promptedResult = silent("endpoint_busy");
					telemetryDecision = "dropped";
				} else {
					tier = "llm";
					scope.promptedStepTier = tier;
					const runClient = (selected: TaskMemoryModelClient, timeoutMs: number) => {
						attemptRoute = selected.route;
						return runTaskMemoryPolicy(deps.bank, selected, {
							purpose: consolidate ? "memory.lesson" : input.deterministicTrigger ? "memory.correct" : "memory.bank",
							isCurrent,
							signal: scope.generationController.signal,
							task: input.task?.trim() || scope.currentTask,
							trajectory: [...scope.trajectory],
							workspaceRoot: launchRoot,
							deterministicTrigger: input.deterministicTrigger,
							maxTokens: live.maxTokens,
							modelMaxTokens: positiveInteger(deps.getModelMaxTokens?.(live.maxTokens), live.maxTokens),
							...(input.suppressIntervention === undefined ? {} : { suppressIntervention: input.suppressIntervention }),
							...(consolidate
								? {
										pass: {
											systemPrompt: MEMORY_CONSOLIDATION_SYSTEM_PROMPT,
											trajectoryText: scope.turnLog.join("\n"),
											keptLessons: keptLessonsForPass(),
										},
									}
								: {}),
							previousReminder: scope.lastInjectedMessage,
							contextLostAt: scope.contextLostAt,
							timeoutMs,
							...(deps.onEnvelope === undefined || deps.tracesEnvelopes?.() === false
								? {}
								: {
										onEnvelope: (envelope: TaskMemoryEnvelope) => {
											if (isCurrent()) deps.onEnvelope?.(envelope);
										},
									}),
						});
					};
					const remainingMs = () => Math.floor(live.timeoutMs - Number(process.hrtime.bigint() - started) / 1_000_000);
					const initialTimeoutMs = remainingMs();
					promptedResult =
						initialTimeoutMs <= 0
							? { ...silent("deadline"), decision: "timeout" }
							: await runClient(client, initialTimeoutMs);
					if (
						(promptedResult.reason === "client_error" || promptedResult.reason === "information_flow_blocked") &&
						isCurrent() &&
						remainingMs() > 0
					) {
						let fallback: TaskMemoryModelClient | null = null;
						let fallbackReady = false;
						try {
							fallback = deps.getFallbackModelClient?.() ?? null;
							fallbackReady = fallback !== null && deps.backgroundEndpointBusy?.() !== true;
						} catch {
							/* Fail closed and preserve the original call if routing or capacity is unreadable. */
						}
						const fallbackTimeoutMs = remainingMs();
						if (fallback !== null && fallbackReady && isCurrent() && fallbackTimeoutMs > 0) {
							// Each attempted call keeps its own telemetry and origin usage.
							// The returned policy result describes the final attempt only.
							emitTelemetry(
								triggers,
								tier,
								promptedResult.decision,
								promptedResult.reason,
								0,
								promptedResult.inputTokens,
								promptedResult.outputTokens,
								started,
								{
									...(promptedResult.calls === undefined ? {} : { calls: promptedResult.calls }),
									bankOperations: promptedResult.bankOperations,
									droppedOperations: promptedResult.droppedOperations,
									...(promptedResult.refusalReason === undefined ? {} : { refusalReason: promptedResult.refusalReason }),
								},
								attemptRoute,
								launchContext ?? null,
							);
							attemptStarted = process.hrtime.bigint();
							promptedResult = await runClient(fallback, fallbackTimeoutMs);
						}
					}
				}
			}
		} catch (error) {
			// runTaskMemoryPolicy resolves its own failures, so reaching here means
			// resolving the client itself threw. That is still a broken route.
			promptedResult = silent("client_error");
			if (isCurrent() && deps.tracesEnvelopes?.() !== false)
				deps.onEnvelope?.({
					systemPrompt: "",
					userPrompt: "",
					response: "",
					decision: "silent",
					reason: "client_error",
					bankOperations: 0,
					droppedOperations: 0,
					reminder: null,
					error: error instanceof Error ? error.message : "resolving the background model client failed",
				});
		}
		if (!isCurrent()) return { ...promptedResult, reminder: null, effects: NO_EFFECTS };
		if (YIELDED_REASONS.has(promptedResult.reason) || budgetSkipped(promptedResult.reason)) telemetryDecision = "dropped";
		if (tier === "llm" && promptedResult.decision === "timeout") scope.consecutiveLlmTimeouts += 1;
		else if (tier === "llm" && telemetryDecision !== "dropped") scope.consecutiveLlmTimeouts = 0;
		let offer: MemoryInterventionOffer | undefined;
		if (promptedResult.decision === "injected" && promptedResult.reminder !== null) {
			const cited = citedEntries(promptedResult.reminder);
			const produced = produceOffer(
				{
					kind:
						input.deterministicTrigger || cited.some((entry) => entry.kind === "procedural") ? "corrective" : "knowledge",
					tier: "llm",
					content: promptedResult.reminder,
					cited: cited.map((entry) => ({ id: entry.id, revision: entryRevision(entry) })),
					trigger: { reasons: triggers, step: scope.toolStep, failures: launchFailures },
					lessons: [],
					workspaceRoot: launchRoot,
				},
				startDeliveryWatch,
			);
			if (produced === null) {
				promptedResult = { ...promptedResult, decision: "silent", reason: "duplicate_reminder", reminder: null };
			} else if (!offerCurrent(produced)) {
				// Evidence moved while the model was answering: the failure it was
				// asked about resolved, or a fact it cites was rewritten.
				releaseOffer(produced.id);
				promptedResult = { ...promptedResult, decision: "gated", reason: "resolved_failure", reminder: null };
			} else {
				offer = produced;
				scope.lastInjectedMessage = produced.content;
			}
		}
		scope.lastDecision = promptedResult.decision;
		// Exactly the entries the answered call's prompt was rendered from. An
		// entry cut for budget was never put in front of the model, so its silence
		// about it says nothing.
		if (tier === "llm" && !UNANSWERED_REASONS.has(promptedResult.reason)) {
			reviewKnowledge(promptedResult.presentedEntries.filter((entry) => entry.kind === "knowledge"));
		}
		if (promptedResult.retiredLessonIds !== undefined) {
			try {
				deps.onKeptLessonsRetired?.(promptedResult.retiredLessonIds);
			} catch {
				// Same contract as onInjectedEntries: the store's failure is not the session's.
			}
		}
		emitTelemetry(
			triggers,
			tier,
			telemetryDecision ?? promptedResult.decision,
			promptedResult.reason,
			citedEntryCount(promptedResult.reminder),
			promptedResult.inputTokens,
			promptedResult.outputTokens,
			attemptStarted,
			{
				...(promptedResult.calls === undefined ? {} : { calls: promptedResult.calls }),
				bankOperations: promptedResult.bankOperations,
				droppedOperations: promptedResult.droppedOperations,
				...(promptedResult.refusalReason === undefined ? {} : { refusalReason: promptedResult.refusalReason }),
				...(promptedResult.resumeAt === undefined ? {} : { resumeAt: promptedResult.resumeAt }),
			},
			attemptRoute,
			launchContext ?? null,
		);
		return {
			...promptedResult,
			...(offer === undefined ? {} : { offer }),
			effects:
				offer === undefined
					? NO_EFFECTS
					: [
							{
								kind: "inject_reminder",
								message: offer.content,
								severity: "advisory",
								source: "memory",
								audience: "model",
							},
						],
		};
	}

	/**
	 * Start delivery accounting for a reminder the host submitted: the cited
	 * entries' injection counts, and for the model tier the durable proposal and
	 * an outcome watch.
	 *
	 * Only the model tier proposes. A rules-tier reminder cites an entry this
	 * middleware wrote itself out of one repeated tool failure, and proposing
	 * every one of those as a durable lesson would fill the operator's review
	 * queue with rows nobody asked for (#229).
	 */
	function startDeliveryWatch(offer: MemoryInterventionOffer): void {
		const snapshot = deps.bank.snapshot();
		const entries = [...snapshot.knowledge, ...snapshot.procedural].filter((entry) =>
			offer.cited.some((cited) => cited.id === entry.id && citedStillHolds(offer, cited, entry)),
		);
		if (entries.length > 0) deps.bank.recordInjection(entries.map((entry) => entry.id));
		if (offer.tier !== "llm" || entries.length === 0 || deps.onInjectedEntries === undefined) return;
		try {
			deps.onInjectedEntries(entries);
		} catch {
			// A failing store is the owner's problem to report, never a reason to
			// fail the request that carried the reminder.
			return;
		}
		scope.deliveries.push({
			entries: entries.map((entry) => ({ id: entry.id, content: entry.content, entry })),
			step: scope.toolStep,
			fingerprints: new Set(
				offer.trigger.failures
					.filter((episode) => scope.failures.get(episode.fingerprint)?.firstStep === episode.firstStep)
					.map((episode) => episode.fingerprint),
			),
			recurrences: 0,
			supported: new Set(),
			heldReported: new Set(),
		});
		if (scope.deliveries.length > MEMORY_DELIVERY_WATCH_LIMIT) scope.deliveries.shift();
	}

	function keptLessonsForPass(): ReadonlyArray<{ id: string; text: string }> {
		return keptLessons()
			.slice(0, KEPT_LESSONS_FOR_PASS)
			.map((lesson) => ({ id: lesson.id, text: lesson.text }));
	}

	function reviewKnowledge(before: ReadonlyArray<TaskMemoryEntry>): void {
		if (deps.onKnowledgeReview === undefined) return;
		const after = new Map(deps.bank.snapshot().knowledge.map((entry) => [entry.id, entry]));
		// Only entries the model filed as lessons. Plain knowledge is a fact about
		// the task in hand and goes stale with it.
		const lessons = before.filter((entry) => entry.durable === true);
		if (lessons.length === 0) return;
		const unchanged = lessons.filter((entry) => after.get(entry.id)?.content === entry.content);
		// Grounding reads the live entry: the evidence command is part of what the
		// model kept, and it has to equal a command the host ran.
		const commandVerified = new Set<string>();
		const kept = unchanged.filter((entry) => {
			const live = after.get(entry.id);
			const kind = live === undefined ? null : groundingOf(live);
			if (kind === "command") commandVerified.add(entry.id);
			return kind !== null;
		});
		const ungrounded = unchanged.filter((entry) => !kept.includes(entry));
		const withdrawn = lessons.filter((entry) => after.get(entry.id)?.content !== entry.content);
		try {
			deps.onKnowledgeReview({ kept, withdrawn, ungrounded, commandVerified });
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
	}

	/**
	 * Report deliveries whose outcome is decided. A reminder is contradicted when
	 * a failure it was written about keeps recurring after it was submitted. An
	 * entry holds only when a later receipt satisfies that entry's own evidence:
	 * its exact command succeeded, or a read showed its quoted source. Quiet
	 * steps and unrelated successes decide nothing. A held entry stays watched,
	 * so the same failure returning later still contradicts it; an undecided
	 * delivery is dropped at scope end rather than guessed at.
	 */
	function settleDeliveries(final: boolean): void {
		const outcomes: MemoryDeliveryOutcome[] = [];
		const bank = new Map(deps.bank.snapshot().knowledge.map((entry) => [entry.id, entry]));
		for (let index = scope.deliveries.length - 1; index >= 0; index -= 1) {
			const watch = scope.deliveries[index];
			if (watch === undefined) continue;
			if (watch.recurrences >= MEMORY_DELIVERY_CONTRADICTED_RECURRENCES) {
				scope.deliveries.splice(index, 1);
				outcomes.push({ entries: watch.entries.map(({ id, content }) => ({ id, content })), kind: "contradicted" });
				continue;
			}
			const held = watch.entries.filter(
				(delivered) =>
					watch.recurrences === 0 &&
					watch.supported.has(delivered.id) &&
					!watch.heldReported.has(delivered.id) &&
					bank.get(delivered.id)?.content === delivered.content,
			);
			for (const delivered of held) watch.heldReported.add(delivered.id);
			if (held.length > 0) outcomes.push({ entries: held.map(({ id, content }) => ({ id, content })), kind: "held" });
		}
		if (final) scope.deliveries.length = 0;
		if (outcomes.length === 0 && !final) return;
		try {
			deps.onDeliveryOutcomes?.(outcomes, final);
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
	}

	/** A successful receipt segment satisfies a delivered lesson whose evidence command has that identity. */
	function noteCommandEvidence(segment: CommandSegment): void {
		const root = workspaceRoot();
		for (const watch of scope.deliveries)
			for (const delivered of watch.entries) {
				if (delivered.entry.durable !== true || delivered.entry.evidenceCommand === undefined) continue;
				const claim = commandSegment(delivered.entry.evidenceCommand, root);
				if (claim !== null && receiptVouches(claim, segment)) watch.supported.add(delivered.id);
			}
	}

	/** A successful read that showed a delivered lesson's quoted source, which the checkout still holds. */
	function noteReadEvidence(path: string, excerpt: string, root: string): void {
		const shown = collapseWhitespace(excerpt);
		for (const watch of scope.deliveries)
			for (const delivered of watch.entries) {
				const source = delivered.entry.evidenceSource;
				if (delivered.entry.durable !== true || source === undefined) continue;
				const quote = collapseWhitespace(source.quote);
				if (quote.length === 0 || repositoryRelativePath(source.path, [root]) !== path || !shown.includes(quote)) continue;
				const current = readInsideRoot(root, path);
				if (current !== null && collapseWhitespace(current).includes(quote)) watch.supported.add(delivered.id);
			}
	}

	/** Keep the lines a read showed, from the read tool's own range and file identity; a partial line shows no line. */
	function recordShownRead(path: string, details: Readonly<Record<string, unknown>> | undefined): void {
		const range = details?.readRange as { startLine?: unknown; endLine?: unknown; partialLine?: unknown } | undefined;
		const file = details?.file as { bytes?: unknown; mtimeMs?: unknown } | undefined;
		const { startLine: start, endLine: end } = range ?? {};
		if (typeof start !== "number" || typeof end !== "number" || end < start || range?.partialLine === true) return;
		if (typeof file?.bytes !== "number" || typeof file.mtimeMs !== "number") return;
		const ranges = scope.shownReads.get(path) ?? [];
		scope.shownReads.delete(path);
		ranges.push({ start, end, bytes: file.bytes, mtimeMs: file.mtimeMs });
		if (ranges.length > SHOWN_READS_PER_PATH) ranges.splice(0, ranges.length - SHOWN_READS_PER_PATH);
		scope.shownReads.set(path, ranges);
		if (scope.shownReads.size > SHOWN_READ_PATHS) scope.shownReads.delete(scope.shownReads.keys().next().value ?? path);
	}

	/**
	 * The quote a `memory_note` path binds: the note's longest backticked span, after every backticked span other than
	 * the path itself was found in lines a read of that file showed in this session, with the file unchanged since. A
	 * span the session never saw refuses the note; nothing is ever substituted for it. Only the quote is hashed.
	 */
	function shownQuote(note: string, pathArg: string, root: string): MemoryNoteEvidence | { refused: string } {
		const path = repositoryRelativePath(pathArg, [root]);
		const shown = path === null ? [] : (scope.shownReads.get(path) ?? []);
		if (path === null || shown.length === 0)
			return { refused: `${pathArg} was not read in this session; read it first, or leave path out` };
		let size: { bytes: number; mtimeMs: number } | null = null;
		try {
			const info = statSync(resolve(root, path));
			size = { bytes: info.size, mtimeMs: info.mtimeMs };
		} catch {
			size = null;
		}
		const content = size === null ? null : readInsideRoot(root, path);
		const current = shown.filter((read) => read.bytes === size?.bytes && read.mtimeMs === size.mtimeMs);
		if (content === null || current.length === 0)
			return { refused: `${path} changed since this session read it; read it again first` };
		const lines = content.split("\n");
		const seen = current.map((read) => collapseWhitespace(lines.slice(read.start - 1, read.end).join("\n")));
		const spans = [...note.matchAll(/`([^`\n]+)`/gu)]
			.map((match) => collapseWhitespace(match[1] ?? ""))
			.filter((span) => span.length > 0 && span !== path && span !== collapseWhitespace(pathArg));
		if (spans.length === 0)
			return { refused: `quote in backticks the text from ${path} the note relies on, as the read showed it` };
		const unseen = spans.find((span) => !seen.some((text) => text.includes(span)));
		if (unseen !== undefined)
			return {
				refused: `\`${unseen}\` is not in the lines of ${path} this session read; quote only what the read showed`,
			};
		const quote = [...spans].sort((a, b) => b.length - a.length)[0] ?? "";
		return { kind: "source", path, quote };
	}

	function observeBeforeTool(input: MiddlewareHookInput): void {
		const prepared = prepareToolStep(input);
		if (prepared === null) return;
		setBounded(scope.pending, pendingKey(input, prepared.operationFingerprint), prepared, settings().windowSteps);
	}

	function observeAfterTool(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
		const fallback = prepareToolStep(input);
		if (fallback === null) return NO_EFFECTS;
		const key = pendingKey(input, fallback.operationFingerprint);
		const prepared = scope.pending.get(key) ?? fallback;
		scope.pending.delete(key);
		const outcome = input.metadata?.resultKind === "error" ? "error" : "ok";
		scope.toolStep += 1;
		scope.toolsSinceMemoryStep += 1;
		scope.toolsSinceLessonPass += 1;
		if (prepared.toolName === ToolNames.Bash) scope.shellStepsSinceLessonPass += 1;
		const live = settings();
		// The model tiers of bank maintenance and correction run only when their surface says `model`; the rules tier below
		// (failure entries, repeated-failure annotation and reminder) runs either way.
		if (live.surfaces.bank === "model" && scope.toolsSinceMemoryStep >= live.everyNTools)
			scope.pendingTriggers.add("interval");
		if (outcome === "error") {
			for (const watch of scope.deliveries) {
				if (watch.fingerprints.has(prepared.operationFingerprint)) watch.recurrences += 1;
			}
			scope.consecutiveErrors += 1;
			if (live.surfaces.correct === "model" && scope.consecutiveErrors >= 2 && !scope.operatorAskedRepeat)
				scope.pendingTriggers.add("tool_error_streak");
		} else {
			scope.consecutiveErrors = 0;
		}
		const digest = resultDigest(input, outcome);
		const step: TrajectoryStep = {
			...prepared,
			step: scope.toolStep,
			outcome,
			resultDigest: digest.text,
			resultDigestProvenance: digest.provenance,
		};
		// The registry passes whatever arguments the model sent, so a `command`
		// field on a read or a write proves nothing ran. Only the shell tool's own
		// success receipt does: its name, an ok result, and a zero exit it reported.
		const command =
			prepared.toolName === ToolNames.Bash && typeof input.toolArgs?.command === "string" ? input.toolArgs.command : null;
		if (command !== null && successfulShellReceipt(input.metadata?.resultKind === "ok", input.toolResultDetails))
			rememberSucceededCommand(command, input.toolArgs?.cwd);
		if (prepared.toolName === ToolNames.Verify)
			noteVerifyRun(input.metadata?.resultKind === "ok", input.toolResultDetails);
		{
			const kind = input.metadata?.resultKind;
			noteCheckOrChange(input.toolName ?? "", input.toolArgs, input.toolResultDetails, {
				ok: kind === "ok",
				ran: kind === "ok" || (kind === "error" && !isRefusalToolResultError({ kind, details: input.toolResultDetails })),
				actionClass: typeof input.metadata?.actionClass === "string" ? input.metadata.actionClass : undefined,
			});
		}
		const root = workspaceRoot();
		const readPath =
			prepared.toolName === ToolNames.Read && outcome === "ok" && typeof input.toolArgs?.path === "string"
				? repositoryRelativePath(input.toolArgs.path, [root])
				: null;
		// A successful read carries a bounded excerpt of what it returned, so the
		// lesson pass can quote the source a fact came from. The excerpt is also
		// the only text that read can later vouch for.
		const readExcerpt =
			readPath === null ? "" : shortText(redactForMemoryRoute(digest.text), TURN_LOG_READ_EXCERPT_CHARS);
		if (readPath !== null) {
			recordObservedRead(scope.observedReads, readPath, readExcerpt);
			noteReadEvidence(readPath, readExcerpt, root);
			recordShownRead(readPath, input.toolResultDetails);
		}
		const excerpt =
			outcome === "error"
				? ` => ${shortText(redactForMemoryRoute(digest.text), 160)}`
				: readExcerpt
					? ` => ${readExcerpt}`
					: "";
		scope.turnLog.push(
			`${scope.toolStep}. ${outcome === "ok" ? "ok" : "FAILED"}: ${shortText(redactForMemoryRoute(command ?? prepared.callDescription), TURN_LOG_CALL_MAX_CHARS)}${excerpt}`,
		);
		observeChainSteps(prepared.toolName, input);
		while (scope.turnLog.length > TURN_LOG_LIMIT) scope.turnLog.shift();
		scope.trajectory.push(step);
		if (scope.trajectory.length > live.windowSteps)
			scope.trajectory.splice(0, scope.trajectory.length - live.windowSteps);
		if (outcome === "ok" && WORKSPACE_CHANGING_CLASSES.has(String(input.metadata?.actionClass))) {
			scope.lastWorkspaceChangeStep = scope.toolStep;
		}
		if (input.metadata?.resultKind === "ok") {
			// Only an explicit receipt for this exact operation closes its failure
			// episode. Keep the bank entry and trajectory as history; this does not
			// verify the surrounding task or reinterpret tool exit classifications.
			scope.failures.delete(step.operationFingerprint);
			scope.annotatedThisTurn.delete(step.operationFingerprint);
			if (scope.lastInjectedOperationFingerprint === step.operationFingerprint)
				scope.lastInjectedOperationFingerprint = null;
		}
		if (outcome !== "error") {
			if (outcome !== "ok") return NO_EFFECTS;
			if (prepared.toolName === ToolNames.Verify && verificationGap(input.toolResultDetails)) {
				const answered = surfaceForVerificationGap();
				if (answered.length > 0) return answered;
			}
			const touched = surfaceForSubject(prepared.toolName, input.toolArgs);
			if (touched.length > 0) return touched;
			return WORKSPACE_CHANGING_CLASSES.has(String(input.metadata?.actionClass)) && !documentationChange(input.toolArgs)
				? surfaceDurableLessons(input.toolArgs)
				: NO_EFFECTS;
		}
		rememberFailure(step);
		if (command !== null) noteFailedForFix(command, input.toolArgs?.cwd);
		const recipe = command === null ? NO_EFFECTS : surfaceRecipeForFailure(command);
		return recipe.length > 0 ? recipe : annotateRepeatedFailure(step);
	}

	/**
	 * The complete command, and the evidence identity of each segment it vouches
	 * for: one simple command, or each of a pure `&&` chain run from the
	 * workspace root, since exit 0 proves every segment finished with exit 0.
	 * Nothing else is derived; `echo 'a && npm test'` and `true # && npm test`
	 * both succeed without running `npm test`, and a call whose own cwd is not
	 * the root vouches for nothing.
	 */
	function rememberSucceededCommand(command: string, cwd: unknown): void {
		const root = workspaceRoot();
		const at = typeof cwd === "string" ? cwd : undefined;
		if (!atWorkspaceRoot(root, at)) return;
		const segments = commandSegments(command, root, at);
		for (const form of new Set([command, ...segments.map((segment) => segment.text)])) {
			scope.succeededCommands.add(form);
			if (scope.succeededCommands.size > VERIFIED_COMMAND_LIMIT) {
				scope.succeededCommands.delete(scope.succeededCommands.values().next().value ?? form);
			}
		}
		for (const segment of segments) {
			scope.succeededSegments.delete(segment.key);
			scope.succeededSegments.set(segment.key, segment);
			if (scope.succeededSegments.size > VERIFIED_COMMAND_LIMIT) {
				scope.succeededSegments.delete(scope.succeededSegments.keys().next().value ?? segment.key);
			}
			noteCommandEvidence(segment);
			settleDurableLessons(segment);
			pairFix(segment);
		}
	}

	/**
	 * A verify run is a receipt for the argv it executed from the root (CLI-P52): a pass vouches for that command as a
	 * successful shell receipt of it would. A run that did not pass vouches for nothing; it is kept only so a later
	 * memory_note naming its command can say why it is refused.
	 */
	function noteVerifyRun(settledOk: boolean, details: unknown): void {
		const root = workspaceRoot();
		const command = verifyReceiptCommand(details, root);
		if (command === null) return;
		const keys = commandSegments(command, root).map((segment) => segment.key);
		if (verifyRunPassed(settledOk, details)) {
			for (const key of keys) scope.unpassedVerifyChecks.delete(key);
			rememberSucceededCommand(command, undefined);
			return;
		}
		// A run that never launched (an unavailable runner) did not run the command, so the refusal does not name it.
		if (!isRecord(details) || details.launched === false) return;
		if (isRecord(details.judgement) && details.judgement.execution === "unavailable") return;
		const check = typeof details.check === "string" ? details.check : "";
		for (const key of keys) setBounded(scope.unpassedVerifyChecks, key, check, VERIFIED_COMMAND_LIMIT);
	}

	/**
	 * Show an earlier session's approved lessons next to the action they are about.
	 *
	 * The prompt's memory section already lists approved lessons, and a live
	 * Dynamo session still rediscovered the validator its approved lesson named,
	 * step for step: the decision about how to validate is made right after an
	 * edit, far from the system prompt. So the first workspace change of a
	 * session surfaces, once, the approved repository lessons whose recommended
	 * command this session has not yet run successfully, those about the
	 * changed file first. No model call, no cadence.
	 */
	function surfaceDurableLessons(args: Readonly<Record<string, unknown>> | undefined): ReadonlyArray<MiddlewareEffect> {
		// The first-change broadcast is an opt-in (`delivery: broadcast`): it repeats the section, and none of the
		// lane broadcasts settled (DESIGN 5).
		if (scope.durableLessonsChecked || !settings().enabled || deliveryMode() !== "broadcast") return NO_EFFECTS;
		scope.durableLessonsChecked = true;
		const changed = new Set(touchedPaths(ToolNames.Write, args));
		const pending = commandLessons().filter((lesson) => !lesson.commands.recommended.some(commandSucceeded));
		return deliverDurableLessons("durable_lesson", [
			...pending.filter((lesson) => lesson.paths.some((path) => changed.has(path))),
			...pending.filter((lesson) => !lesson.paths.some((path) => changed.has(path))),
		]);
	}

	/**
	 * PanCode's own verification route reported no declared or derivable check: the
	 * session is asking how this repository validates. Approved lessons whose
	 * recommended command it has not yet run successfully are that answer.
	 */
	function surfaceForVerificationGap(): ReadonlyArray<MiddlewareEffect> {
		return deliverDurableLessons(
			"durable_lesson_verify",
			commandLessons().filter((lesson) => !lesson.commands.recommended.some(commandSucceeded)),
		);
	}

	/**
	 * The session read, changed or ran a repository file an approved lesson is about: a source lesson an operator
	 * approved that quotes or names it, or a command lesson whose recommended command names it (DESIGN 4.4 channel
	 * table). A quote no operator reviewed never rides this channel.
	 */
	function surfaceForSubject(
		toolName: string,
		args: Readonly<Record<string, unknown>> | undefined,
	): ReadonlyArray<MiddlewareEffect> {
		const touched = new Set(touchedPaths(toolName, args));
		if (touched.size === 0) return NO_EFFECTS;
		const root = workspaceRoot();
		// A command names a path as an argument or as an option's value (`--config=scripts/cfg.json`).
		const names = (lesson: KeptLesson): boolean =>
			(commandEvidence(lesson) &&
				lesson.commands.recommended.some((command) =>
					command.split(/[\s=]+/u).some((word) => touched.has(repositoryRelativePath(word, [root]) ?? "")),
				)) ||
			(lesson.approval === "operator" &&
				lesson.sourcePaths.length > 0 &&
				[...lesson.paths, ...lesson.sourcePaths].some((path) => touched.has(path)));
		return deliverDurableLessons(
			"durable_lesson_subject",
			// A lesson whose recommended command already succeeded here has nothing left to say.
			keptLessons().filter((lesson) => names(lesson) && !lesson.commands.recommended.some(commandSucceeded)),
		);
	}

	function touchedPaths(toolName: string, args: Readonly<Record<string, unknown>> | undefined): string[] {
		const root = workspaceRoot();
		const named =
			typeof args?.path === "string"
				? [args.path]
				: typeof args?.file_path === "string"
					? [args.file_path]
					: toolName === ToolNames.Bash && typeof args?.command === "string"
						? args.command.split(/\s+/u)
						: [];
		return named.flatMap((token) => repositoryRelativePath(token, [root]) ?? []);
	}

	/** Approved repository lessons that recommend at least one command. */
	function commandLessons(): KeptLesson[] {
		return keptLessons().filter((lesson) => lesson.commands.recommended.length > 0);
	}

	/**
	 * A failed command that runs the same repository file through the same
	 * program as a command an approved lesson recommends, or that is exactly a
	 * failed example the lesson quotes: the session is on the trap that lesson's
	 * recipe fixes. It rides back on the failed result. A fix claim reaches the
	 * failed call only when its failed pattern is that call's evidence identity.
	 */
	function surfaceRecipeForFailure(command: string): ReadonlyArray<MiddlewareEffect> {
		const root = workspaceRoot();
		const failedCall = commandSegment(command, root);
		return deliverDurableLessons(
			"durable_lesson_variant",
			// Fix notes ride this one channel, labelled unverified, and only on their own failed pattern (DESIGN 4.4).
			[...keptLessons(), ...fixNotes()].filter((lesson) =>
				lesson.failed !== undefined
					? failedCall !== null && receiptVouches(lesson.failed, failedCall, [tmpdir()])
					: lesson.commands.recommended.some(
							(quoted) => !sameCommandIdentity(quoted, command, root) && sharesInvocationTarget(command, quoted, root),
						) ||
						(lesson.commands.recommended.length > 0 &&
							lesson.commands.examples.some((quoted) => sameCommandIdentity(quoted, command, root))),
			),
		);
	}

	/**
	 * Whole lessons, each at most once per session, while they fit the memory
	 * reminder budget the operator configured; nothing is cut mid-lesson.
	 * Relevance was decided by the caller over every eligible lesson, so the
	 * budget only bounds what is shown. Delivery is recorded when the host
	 * submits the annotation, not here.
	 */
	function deliverDurableLessons(
		trigger:
			| "durable_lesson"
			| "durable_lesson_variant"
			| "durable_lesson_verify"
			| "durable_lesson_subject"
			| "durable_lesson_task",
		candidates: ReadonlyArray<KeptLesson>,
	): ReadonlyArray<MiddlewareEffect> {
		// The broadcast opens only under `broadcast`, every other reminder from `decision` up (DESIGN 4.1).
		const mode = deliveryMode();
		if (mode === "off" || mode === "section" || (trigger === "durable_lesson" && mode !== "broadcast")) return NO_EFFECTS;
		const budget = settings().maxTokens * 4;
		const chosen: KeptLesson[] = [];
		let lines: string[] = [];
		for (const lesson of candidates) {
			if (scope.deliveredLessons.has(lesson.id) || scope.offeredLessons.has(lesson.id)) continue;
			if (carriedBySection(lesson.id)) continue;
			if (!channelCarries(trigger, lesson)) continue;
			const next = [...lines, renderKeptLesson(lesson)];
			if (next.join("\n").length > budget) continue;
			lines = next;
			chosen.push(lesson);
		}
		if (chosen.length === 0) return NO_EFFECTS;
		const offer = produceOffer(
			{
				kind: "durable_lesson",
				tier: "rules",
				content: lines.join("\n"),
				cited: chosen.map((lesson) => ({ id: lesson.id, revision: lesson.revision })),
				trigger: { reasons: [trigger], step: scope.toolStep, failures: [] },
				lessons: chosen.map(({ id, revision, appliesWhen, avoidWhen, approval, evidenceRefs }) => ({
					id,
					revision,
					appliesWhen,
					avoidWhen,
					approval,
					evidenceRefs,
				})),
			},
			() => {
				for (const lesson of chosen) {
					scope.offeredLessons.delete(lesson.id);
					scope.deliveredLessons.add(lesson.id);
					scope.durableWatch.set(lesson.id, lesson.commands.recommended);
				}
				reportDurableLessons(
					chosen.map((lesson) => lesson.id),
					[],
				);
			},
		);
		if (offer === null) return NO_EFFECTS;
		for (const lesson of chosen) scope.offeredLessons.add(lesson.id);
		scope.lastDecision = "injected";
		emitTelemetry(
			[trigger],
			"rules",
			"injected",
			"intervened",
			chosen.length,
			noTokens,
			noTokens,
			process.hrtime.bigint(),
		);
		scope.lessonDelivered = true;
		return [{ kind: "annotate_tool_result", message: offer.content, severity: "info" }];
	}

	/**
	 * A submitted lesson holds in this session once a receipt segment with the
	 * evidence identity of its recommended command succeeds. Failures, other
	 * commands that merely mention it, and its quoted failed examples prove
	 * nothing about it.
	 */
	function settleDurableLessons(segment: CommandSegment): void {
		if (scope.durableWatch.size === 0) return;
		const root = workspaceRoot();
		const held = [...scope.durableWatch]
			.filter(([, commands]) =>
				commands.some((quoted) => {
					const claim = commandSegment(quoted, root);
					return claim !== null && receiptVouches(claim, segment);
				}),
			)
			.map(([id]) => id);
		if (held.length === 0) return;
		for (const id of held) scope.durableWatch.delete(id);
		reportDurableLessons([], held);
	}

	/** This session ran a command with that evidence identity successfully. */
	function commandSucceeded(quoted: string): boolean {
		const claim = commandSegment(quoted, workspaceRoot());
		if (claim === null) return false;
		for (const segment of scope.succeededSegments.values()) if (receiptVouches(claim, segment)) return true;
		return false;
	}

	function reportDurableLessons(delivered: ReadonlyArray<string>, held: ReadonlyArray<string>): void {
		try {
			deps.onDurableLessonOutcomes?.({ sessionId: scope.observedSessionId, delivered, held });
		} catch {
			// Same contract as onInjectedEntries: the store's failure is not the session's.
		}
	}

	/**
	 * A gateway chain ran real steps under one outer call. Its settled, admitted
	 * children (the canonical receipts every other ledger reader expands) add
	 * their own lesson-log lines and evidence: a shell child's exact command when
	 * it reported success with exit 0, a read child's excerpt as shown. The
	 * outer call keeps its single trajectory step, failure episode and
	 * reminder semantics; a failed or blocked child is logged and proves nothing.
	 */
	function observeChainSteps(toolName: string, input: MiddlewareHookInput): void {
		const children = gatewayChainReceipts(toolName, { details: input.toolResultDetails });
		for (const child of children) {
			const details = isRecord(child.result.details) ? child.result.details : {};
			const settled = child.admission.outcome === "ok" && child.admission.decision === "allowed" && details.kind === "ok";
			const label = `${scope.toolStep}.${child.id}`;
			if (child.capability === ToolNames.Bash && typeof child.args.command === "string") {
				scope.shellStepsSinceLessonPass += 1;
				// The same receipt rule a direct shell call meets.
				const succeeded = successfulShellReceipt(settled, details);
				if (succeeded) rememberSucceededCommand(child.args.command, child.args.cwd);
				scope.turnLog.push(
					`${label} ${succeeded ? "ok" : "FAILED"}: ${shortText(redactForMemoryRoute(child.args.command), TURN_LOG_CALL_MAX_CHARS)}`,
				);
				continue;
			}
			// The same verify rule a direct call meets: the run's own judgement decides, never the chain's wrapper.
			if (child.capability === ToolNames.Verify)
				noteVerifyRun(child.admission.outcome === "ok" && child.admission.decision === "allowed", details);
			const path =
				settled && child.capability === ToolNames.Read && typeof child.args.path === "string"
					? repositoryRelativePath(child.args.path, [workspaceRoot()])
					: null;
			const excerpt =
				path === null ? "" : shortText(redactForMemoryRoute(chainChildText(child.result)), TURN_LOG_READ_EXCERPT_CHARS);
			if (path !== null) {
				recordObservedRead(scope.observedReads, path, excerpt);
				noteReadEvidence(path, excerpt, workspaceRoot());
			}
			scope.turnLog.push(
				`${label} ${settled ? "ok" : "FAILED"}: ${shortText(`${child.capability}${path === null ? "" : ` ${path}`}`, TURN_LOG_CALL_MAX_CHARS)}${excerpt ? ` => ${excerpt}` : ""}`,
			);
		}
	}

	/**
	 * The turn-end reminder channel cannot reach a model that is still mid-turn,
	 * and a long agentic turn is exactly where a repeated failure burns its
	 * budget. A second identical failure therefore rides back on the tool result
	 * itself, which the model reads on its very next round.
	 */
	function annotateRepeatedFailure(step: TrajectoryStep): ReadonlyArray<MiddlewareEffect> {
		if (scope.operatorAskedRepeat || scope.annotatedThisTurn.has(step.operationFingerprint)) return NO_EFFECTS;
		const failure = scope.failures.get(step.operationFingerprint);
		if (failure === undefined) return NO_EFFECTS;
		const occurrences = scope.trajectory.filter(
			(candidate) =>
				candidate.outcome === "error" &&
				candidate.operationFingerprint === step.operationFingerprint &&
				// The same command failing differently is progress, not a repeat: a
				// live session reran its tests after generating a missing module, got an
				// assertion failure instead of a load error, and was told it had already
				// tried that.
				candidate.resultDigest === step.resultDigest &&
				candidate.step >= failure.firstStep &&
				candidate.step > scope.lastWorkspaceChangeStep,
		).length;
		if (occurrences < 2) return NO_EFFECTS;
		const message = boundedReminder(
			`Memory: [${failure.entryId}] you already tried ${failure.callDescription} at step ${failure.firstStep} and it failed with ${failure.errorDigest} (${failure.attempts} failed attempts). Change the approach rather than repeating it.`,
			settings().maxTokens,
		);
		if (message.length === 0) return NO_EFFECTS;
		const offer = correctiveOffer(failure, step.operationFingerprint, message, "repeated_failure");
		if (offer === null) return NO_EFFECTS;
		scope.annotatedThisTurn.add(step.operationFingerprint);
		// Claim the turn-end channel too, so one repeated failure is surfaced once.
		scope.lastInjectedOperationFingerprint = step.operationFingerprint;
		scope.lastDecision = "injected";
		scope.rulesInjectedSincePromptedStep = true;
		scope.annotatedSinceTurnEnd = true;
		emitTelemetry(
			["repeated_failure"],
			"rules",
			"injected",
			"intervened",
			1,
			noTokens,
			noTokens,
			process.hrtime.bigint(),
		);
		return [{ kind: "annotate_tool_result", message: offer.content, severity: "warn" }];
	}

	function rememberFailure(step: TrajectoryStep): void {
		const previous = scope.failures.get(step.operationFingerprint);
		const attempts = (previous?.attempts ?? 0) + 1;
		const firstStep = previous?.firstStep ?? step.step;
		const content = proceduralContent(step.callDescription, attempts, firstStep, step.resultDigest);
		let entryId: string;
		if (previous === undefined) {
			entryId = deps.bank.saveProcedural(content).id;
		} else {
			try {
				entryId = deps.bank.saveProcedural(content, { id: previous.entryId }).id;
			} catch {
				entryId = deps.bank.saveProcedural(content).id;
			}
		}
		setBounded(
			scope.failures,
			step.operationFingerprint,
			{
				entryId,
				attempts,
				firstStep,
				callDescription: step.callDescription,
				errorDigest: step.resultDigest,
			},
			TASK_MEMORY_DEFAULT_PROCEDURAL_CAP,
		);
	}

	function decideRepeatedFailure(): ReadonlyArray<MiddlewareEffect> {
		try {
			if (scope.operatorAskedRepeat) {
				scope.lastDecision = "silent";
				return NO_EFFECTS;
			}
			for (let index = scope.trajectory.length - 1; index >= 0; index -= 1) {
				const step = scope.trajectory[index];
				if (
					step === undefined ||
					step.outcome !== "error" ||
					step.step <= scope.lastTurnEndStep ||
					step.operationFingerprint === scope.lastInjectedOperationFingerprint
				) {
					continue;
				}
				const failure = scope.failures.get(step.operationFingerprint);
				if (failure === undefined || step.step < failure.firstStep) continue;
				const occurrences = scope.trajectory.filter(
					(candidate) =>
						candidate.outcome === "error" &&
						candidate.operationFingerprint === step.operationFingerprint &&
						candidate.resultDigest === step.resultDigest &&
						candidate.step >= failure.firstStep &&
						candidate.step > scope.lastWorkspaceChangeStep,
				).length;
				if (occurrences < 2) continue;
				const message = boundedReminder(
					`Memory: [${failure.entryId}] you already tried ${failure.callDescription} at step ${failure.firstStep} and it failed with ${failure.errorDigest} (${failure.attempts} failed attempts).`,
					settings().maxTokens,
				);
				if (message.length === 0) return NO_EFFECTS;
				const offer = correctiveOffer(failure, step.operationFingerprint, message, "turn_end");
				if (offer === null) return NO_EFFECTS;
				scope.lastInjectedOperationFingerprint = step.operationFingerprint;
				scope.lastInjectedMessage = offer.content;
				scope.lastDecision = "injected";
				scope.rulesInjectedSincePromptedStep = true;
				return [
					{ kind: "inject_reminder", message: offer.content, severity: "advisory", source: "memory", audience: "model" },
				];
			}
			scope.lastDecision = "silent";
			return NO_EFFECTS;
		} finally {
			scope.lastTurnEndStep = scope.toolStep;
		}
	}

	function reactivateKnowledge(): ReadonlyArray<MiddlewareEffect> {
		if (!scope.reactivateAfterCompaction) return NO_EFFECTS;
		scope.reactivateAfterCompaction = false;
		const prefix = "Memory: execution state restored after compaction:\n";
		const maxTokens = settings().maxTokens;
		const prefixTokens = ceilChars(prefix.length);
		const rendered = deps.bank.renderRestoredState(Math.max(0, maxTokens - prefixTokens));
		if (rendered.length === 0) {
			scope.lastDecision = "silent";
			return NO_EFFECTS;
		}
		const message = boundedReminder(`${prefix}${rendered}`, maxTokens);
		if (message.length === 0) {
			scope.lastDecision = "silent";
			return NO_EFFECTS;
		}
		const snapshot = deps.bank.snapshot();
		const cited = [snapshot.status, ...snapshot.knowledge, ...snapshot.procedural].filter(
			(entry): entry is TaskMemoryEntry => entry !== null && message.includes(`[${entry.id}]`),
		);
		const offer = produceOffer(
			{
				kind: "knowledge",
				tier: "rules",
				content: message,
				cited: cited.map((entry) => ({ id: entry.id, revision: entryRevision(entry) })),
				trigger: { reasons: ["post_compaction"], step: scope.toolStep, failures: [] },
				lessons: [],
			},
			startDeliveryWatch,
		);
		if (offer === null) {
			scope.lastDecision = "silent";
			return NO_EFFECTS;
		}
		scope.lastInjectedMessage = offer.content;
		scope.lastDecision = "injected";
		return [
			{ kind: "inject_reminder", message: offer.content, severity: "advisory", source: "memory", audience: "model" },
		];
	}

	/** A rules-tier correction bound to the one failure episode it describes. */
	function correctiveOffer(
		failure: FailedAttempt,
		fingerprint: string,
		message: string,
		reason: string,
	): MemoryInterventionOffer | null {
		const entry = deps.bank.snapshot().procedural.find((candidate) => candidate.id === failure.entryId);
		return produceOffer(
			{
				kind: "corrective",
				tier: "rules",
				content: message,
				cited: entry === undefined ? [] : [{ id: entry.id, revision: entryRevision(entry) }],
				trigger: {
					reasons: [reason],
					step: scope.toolStep,
					failures: [{ fingerprint, firstStep: failure.firstStep, entryId: failure.entryId }],
				},
				lessons: [],
			},
			startDeliveryWatch,
		);
	}
}

/** A lesson carries command evidence: a `command:` ref, which only a succeeded receipt writes. */
function commandEvidence(lesson: Pick<KeptLesson, "evidenceRefs">): boolean {
	return lesson.evidenceRefs.some((ref) => ref.startsWith(COMMAND_EVIDENCE_REF_PREFIX));
}

/**
 * The evidence each reminder channel requires (DESIGN 4.4 channel table). A failed call and a verification gap take
 * command evidence; the broadcast and the task reminder repeat the section's rule, command evidence or an operator's
 * approval; a touched file's own rule is applied by its caller, which knows the path.
 */
function channelCarries(
	trigger:
		| "durable_lesson"
		| "durable_lesson_variant"
		| "durable_lesson_verify"
		| "durable_lesson_subject"
		| "durable_lesson_task",
	lesson: KeptLesson,
): boolean {
	switch (trigger) {
		case "durable_lesson_variant":
		case "durable_lesson_verify":
			return commandEvidence(lesson);
		case "durable_lesson_subject":
			return commandEvidence(lesson) || (lesson.approval === "operator" && lesson.sourcePaths.length > 0);
		case "durable_lesson":
		case "durable_lesson_task":
			return commandEvidence(lesson) || lesson.approval === "operator";
	}
}

function proceduralContent(call: string, attempts: number, firstStep: number, error: string): string {
	return `${call} failed ${attempts} time${attempts === 1 ? "" : "s"}; first observed at step ${firstStep}: ${error}.`;
}

function boundedReminder(message: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (maxChars <= 0) return "";
	const normalized = message.replace(/[^\S\n]+/gu, " ").trim();
	return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars).trimEnd();
}
