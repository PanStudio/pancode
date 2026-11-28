// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { MIDDLEWARE_HOOKS } from "../../core/telemetry/session-vocabulary.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../middleware/types.js";
import { MEMORY_CONSOLIDATION_SYSTEM_PROMPT } from "../prompts/memory-intervention.js";
import type { CommandSegment } from "./command-evidence.js";
import { MemoryCommitState } from "./commit-state.js";
import { createInterventionDeliveries } from "./intervention/deliveries.js";
import { createInterventionEvidence } from "./intervention/evidence.js";
import { createInterventionLessons } from "./intervention/lessons.js";
import { createInterventionOffers } from "./intervention/offers.js";
import { createInterventionRules } from "./intervention/rules.js";
import {
	budgetSkipped,
	entryRevision,
	type FailedAttempt,
	type InterventionScope,
	NO_EFFECTS,
	noTokens,
	type PendingOffer,
	type ShownRead,
	YIELDED_REASONS,
} from "./intervention/scope.js";
import { createInterventionTelemetry } from "./intervention/telemetry.js";
import { createInterventionToolSteps } from "./intervention/tool-steps.js";
import type { PendingToolStep } from "./intervention-tool-step.js";
import type {
	MemoryInterventionDeps,
	MemoryInterventionOffer,
	MemoryInterventionRegistration,
	MemoryInterventionSettings,
	MemoryInterventionTriggerReason,
	MemoryPromptedStepInput,
	MemoryPromptedStepResult,
	MemoryStepLaunchOutcome,
} from "./intervention-types.js";
import type { TaskMemoryTelemetryDecision, TaskMemoryTelemetryTier } from "./memory-events.js";
import {
	runTaskMemoryPolicy,
	TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
	type TaskMemoryEnvelope,
	type TaskMemoryModelClient,
	type TaskMemoryPolicyReason,
	type TaskMemoryPolicyResult,
	type TaskMemoryRoute,
} from "./task-memory-policy.js";
import { positiveInteger } from "./util.js";

const MEMORY_INTERVENTION_REGISTRATION_ID = "observer.memory-intervention";
const MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS = 8;
const MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS = 2_000;
const MEMORY_INTERVENTION_DEFAULT_EVERY_N_TOOLS = 10;
/** Two full deadlines are enough evidence to stop spending this session's endpoint. */
const MEMORY_INTERVENTION_TIMEOUT_BACKOFF_THRESHOLD = 2;

/** Reasons that mean the model tier cannot run right now; deterministic rules keep working. */
const UNAVAILABLE_REASONS: ReadonlySet<TaskMemoryPolicyReason> = new Set([
	"no_client",
	"client_error",
	"information_flow_blocked",
	"llm_timeout_backoff",
]);

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
	const workspaceRoot = (): string => {
		try {
			return deps.workspaceRoot?.() ?? process.cwd();
		} catch {
			return process.cwd();
		}
	};
	const { emitTelemetry, citedEntries, citedEntryCount } = createInterventionTelemetry(scope);
	const {
		isContentCurrent,
		hasPendingOffers,
		acknowledgeSubmission,
		captureContentGuard,
		produceOffer,
		releaseOffer,
		offerCurrent,
		citedStillHolds,
		openFailureEpisodes,
	} = createInterventionOffers(scope);
	const { startDeliveryWatch, reviewKnowledge, settleDeliveries, noteCommandEvidence, noteReadEvidence } =
		createInterventionDeliveries(scope);
	const {
		offerLessonsForTask,
		keptLessons,
		fixNotes,
		keptLessonsForPass,
		surfaceDurableLessons,
		surfaceForVerificationGap,
		surfaceForSubject,
		surfaceRecipeForFailure,
		settleDurableLessons,
	} = createInterventionLessons(scope);
	const {
		noteEvidence,
		sideArmCount,
		sideLessonArmed,
		idleLessonWorth,
		observeDeclaration,
		noteCheckOrChange,
		noteFailedForFix,
		recordShownRead,
		rememberSucceededCommand,
		noteVerifyRun,
	} = createInterventionEvidence(scope);
	const { observeBeforeTool, observeAfterTool } = createInterventionToolSteps(scope);
	const { evaluate, annotateRepeatedFailure, rememberFailure } = createInterventionRules(scope);

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
		isContentCurrent,
		hasPendingOffers,
		acknowledgeSubmission,
		offerLessonsForTask,
		noteEvidence,
		sideArmCount,
		reset,
		dispose(): void {
			scope.disposed = true;
			reset();
		},
		id: MEMORY_INTERVENTION_REGISTRATION_ID,
		description: "maintain bounded task execution memory and selectively remind after repeated failures or compaction",
		hooks: MIDDLEWARE_HOOKS,
		evidence: "count:failure-recurrence@task-memory",
		evaluate,
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
}
