// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { MIDDLEWARE_HOOKS } from "../../core/telemetry/session-vocabulary.js";
import type { MiddlewareHookInput } from "../middleware/types.js";
import type { CommandSegment } from "./command-evidence.js";
import { MemoryCommitState } from "./commit-state.js";
import { createInterventionDeliveries } from "./intervention/deliveries.js";
import { createInterventionEvidence } from "./intervention/evidence.js";
import { createInterventionLaunch } from "./intervention/launch.js";
import { createInterventionLessons } from "./intervention/lessons.js";
import { createInterventionOffers } from "./intervention/offers.js";
import { createInterventionPromptedStep } from "./intervention/prompted-step.js";
import { createInterventionRules } from "./intervention/rules.js";
import {
	type FailedAttempt,
	type InterventionScope,
	noTokens,
	type PendingOffer,
	type ShownRead,
} from "./intervention/scope.js";
import { createInterventionTelemetry } from "./intervention/telemetry.js";
import { createInterventionToolSteps } from "./intervention/tool-steps.js";
import type { PendingToolStep } from "./intervention-tool-step.js";
import type {
	MemoryInterventionDeps,
	MemoryInterventionRegistration,
	MemoryInterventionSettings,
	MemoryInterventionTriggerReason,
} from "./intervention-types.js";
import { TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS } from "./task-memory-policy.js";
import { positiveInteger } from "./util.js";

const MEMORY_INTERVENTION_REGISTRATION_ID = "observer.memory-intervention";
const MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS = 8;
const MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS = 2_000;
const MEMORY_INTERVENTION_DEFAULT_EVERY_N_TOOLS = 10;

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
	const { runPromptedStep } = createInterventionPromptedStep(scope);
	const { evaluateAsync, pendingWork, owesBoundaryStep, runIdleStep, signalLoop, notifyTurnBoundary } =
		createInterventionLaunch(scope);

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
		evaluateAsync,
		runPromptedStep,
		pendingWork,
		owesBoundaryStep,
		runIdleStep,
		signalLoop,
		lastDecision: () => scope.lastDecision,
		recentActivity: () => [...scope.activity],
		stepInFlight: () => scope.promptedStepInFlight,
		whenIdle: () => scope.outstandingStep,
	};

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
}
