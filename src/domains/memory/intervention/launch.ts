// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { MiddlewareEffect } from "../../middleware/types.js";
import type { MemoryInterventionRegistration, MemoryStepLaunchOutcome } from "../intervention-types.js";
import type { TaskMemoryPolicyReason } from "../task-memory-policy.js";
import { budgetSkipped, type InterventionScope, NO_EFFECTS, noTokens, YIELDED_REASONS } from "./scope.js";

/** Reasons that mean the model tier cannot run right now; deterministic rules keep working. */
const UNAVAILABLE_REASONS: ReadonlySet<TaskMemoryPolicyReason> = new Set([
	"no_client",
	"client_error",
	"information_flow_blocked",
	"llm_timeout_backoff",
]);

export function createInterventionLaunch(scope: InterventionScope) {
	const { deps } = scope;
	const members: Pick<
		MemoryInterventionRegistration,
		"evaluateAsync" | "pendingWork" | "owesBoundaryStep" | "runIdleStep" | "signalLoop"
	> = {
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
			scope.observeSession(input);
			if (input.hook === "turn_end" && input.metadata?.stopReason === "aborted") {
				scope.cancelStoppedTurn();
				return NO_EFFECTS;
			}
			const boundaryHook =
				input.hook === "turn_end" || (input.hook === "after_tool" && input.metadata?.stage === "tool_batch_end");
			if (input.hook === "turn_end" && !scope.disposed && scope.settings().enabled && scope.sideLessonArmed())
				scope.pendingTriggers.add("turn_end");
			if (scope.disposed || !scope.settings().enabled || !boundaryHook || scope.pendingTriggers.size === 0)
				return NO_EFFECTS;
			const boundary = input.turnId ?? input.metadata?.userTurnId?.toString() ?? `tool-step:${scope.toolStep}`;
			if (boundary === scope.lastPromptedBoundary) return NO_EFFECTS;
			// One row rather than none, so a headless operator reading the log sees
			// why the tier never ran instead of finding nothing and guessing.
			if (deps.deliversDeferredReminders === false) {
				scope.emitTelemetry(
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
				scope.emitTelemetry(
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
		pendingWork(): boolean {
			if (scope.disposed || !scope.settings().enabled) return false;
			return scope.pendingTriggers.size > 0 || scope.idleLessonWorth();
		},
		owesBoundaryStep(): boolean {
			return (
				!scope.disposed &&
				scope.settings().enabled &&
				deps.deliversDeferredReminders !== false &&
				!scope.promptedStepInFlight &&
				!scope.lastLaunchUnavailable &&
				!scope.lastLaunchSkipped &&
				scope.pendingTriggers.size > 0
			);
		},
		async runIdleStep(): Promise<MemoryStepLaunchOutcome> {
			if (scope.disposed || !scope.settings().enabled || scope.promptedStepInFlight) return "none";
			if (deps.deliversDeferredReminders === false) return "none";
			// Checked before arming `idle_review`, which would otherwise wait for the
			// next tool boundary and run a lesson pass mid-turn.
			if (scope.lastLaunchSkipped) return "skipped";
			if (scope.pendingTriggers.size === 0) {
				if (!scope.idleLessonWorth()) return "none";
				scope.pendingTriggers.add("idle_review");
			}
			if (scope.lastLaunchYielded && endpointStillBusy()) return "yielded";
			scope.lastPromptedBoundary = `idle:${scope.toolStep}`;
			return launchPromptedStep(false);
		},
		signalLoop(): void {
			if (!scope.disposed && scope.settings().enabled && scope.settings().surfaces.correct === "model")
				scope.pendingTriggers.add("loop_signal");
		},
	};

	return { ...members, notifyTurnBoundary };

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
		const contentCurrent = scope.captureContentGuard();
		scope.promptedStepInFlight = true;
		notifyStepActivity();
		let outcome: MemoryStepLaunchOutcome = "none";
		const settled = scope
			.runPromptedStep({
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
				deps.onDeferredReminder?.(offer.content, () => contentCurrent() && scope.offerCurrent(offer));
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
}
