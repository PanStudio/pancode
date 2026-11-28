// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { MiddlewareHookInput } from "../../middleware/types.js";
import { MemoryCommitState } from "../commit-state.js";
import { type InterventionScope, noTokens } from "./scope.js";
import type { MemoryInterventionRegistration } from "./types.js";

export function createInterventionLifecycle(scope: InterventionScope) {
	const { deps } = scope;
	const members: Pick<
		MemoryInterventionRegistration,
		| "captureMemoryAuthority"
		| "bindCommitScope"
		| "notifyContextCommitted"
		| "prepareRestoration"
		| "canAcknowledgeRestoration"
		| "acknowledgeRestoration"
		| "releaseRestoration"
		| "reset"
		| "dispose"
	> = {
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
			if (!scope.commitScope || !scope.settings().enabled) return null;
			return (
				scope.commitState?.prepareRestoration({
					scope: scope.commitScope,
					generation: scope.generation,
					bank: deps.bank.snapshot(),
					currentState,
					maxTokens: Math.min(maxTokens, scope.settings().maxTokens),
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
		reset,
		dispose(): void {
			scope.disposed = true;
			reset();
		},
	};

	return { ...members, observeSession, cancelStoppedTurn };

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
		scope.emitTelemetry(["turn_end"], tier, "silent", "scope_changed", 0, noTokens, noTokens, process.hrtime.bigint());
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
		scope.settleDeliveries(true);
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
}
