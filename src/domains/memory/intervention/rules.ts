// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { headForRedaction } from "../../../lib/secrets/redact.js";
import type { MiddlewareEffect } from "../../middleware/types.js";
import { ceilChars } from "../../session/context-accounting.js";
import { redactForMemoryRoute } from "../secret-text.js";
import { TASK_MEMORY_DEFAULT_PROCEDURAL_CAP, type TaskMemoryEntry } from "../task-bank.js";
import { shortText } from "../util.js";
import {
	entryRevision,
	type FailedAttempt,
	type InterventionScope,
	NO_EFFECTS,
	noTokens,
	setBounded,
	type TrajectoryStep,
} from "./scope.js";
import type { MemoryInterventionOffer, MemoryInterventionRegistration } from "./types.js";

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

export function createInterventionRules(scope: InterventionScope) {
	const { deps } = scope;
	const members: Pick<MemoryInterventionRegistration, "evaluate"> = {
		evaluate(input, context): ReadonlyArray<MiddlewareEffect> {
			scope.observeSession(input);
			if (input.hook === "turn_end" || input.hook === "turn_start") scope.lastLaunchSkipped = false;
			if (input.hook === "turn_end") scope.notifyTurnBoundary("end");
			else if (input.hook === "turn_start" && input.metadata?.requestContinuation !== true)
				scope.notifyTurnBoundary("start");
			if (scope.disposed || !scope.settings().enabled) return NO_EFFECTS;
			try {
				switch (input.hook) {
					case "before_tool":
						scope.observeBeforeTool(input);
						return NO_EFFECTS;
					case "after_tool": {
						scope.lessonDelivered = false;
						const effects = scope.observeAfterTool(input);
						if (scope.lessonDelivered && effects.length > 0) context?.evidence?.(DURABLE_LESSON_EVIDENCE);
						return effects;
					}
					case "turn_end": {
						if (input.metadata?.stopReason === "aborted") {
							scope.cancelStoppedTurn();
							return NO_EFFECTS;
						}
						scope.observeDeclaration(input);
						// Middleware continuations can evaluate turn_end again without any
						// completed tools. They are not new memory boundaries and must not
						// replace the prior operator-visible outcome or emit telemetry.
						if (scope.toolStep <= scope.lastTurnEndStep) return NO_EFFECTS;
						scope.settleDeliveries(false);
						// A mid-turn annotation already reported this boundary's rules-tier
						// outcome. Reporting silence again would double-count one decision.
						const alreadyReported = scope.annotatedSinceTurnEnd;
						scope.annotatedSinceTurnEnd = false;
						const started = process.hrtime.bigint();
						const effects = decideRepeatedFailure();
						if (alreadyReported && effects.length === 0) return effects;
						scope.emitTelemetry(
							[effects.length > 0 ? "repeated_failure" : "turn_end"],
							"rules",
							effects.length > 0 ? "injected" : "silent",
							effects.length > 0 ? "intervened" : "no_repeated_failure",
							scope.citedEntryCount(effects[0]?.kind === "inject_reminder" ? effects[0].message : null),
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
							scope.emitTelemetry(
								["post_compaction"],
								"rules",
								effects.length > 0 ? "injected" : "silent",
								effects.length > 0 ? "intervened" : "bank_empty",
								scope.citedEntryCount(effects[0]?.kind === "inject_reminder" ? effects[0].message : null),
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
	};

	return { ...members, annotateRepeatedFailure, rememberFailure };

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
			scope.settings().maxTokens,
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
		scope.emitTelemetry(
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
					scope.settings().maxTokens,
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
		const maxTokens = scope.settings().maxTokens;
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
		const offer = scope.produceOffer(
			{
				kind: "knowledge",
				tier: "rules",
				content: message,
				cited: cited.map((entry) => ({ id: entry.id, revision: entryRevision(entry) })),
				trigger: { reasons: ["post_compaction"], step: scope.toolStep, failures: [] },
				lessons: [],
			},
			scope.startDeliveryWatch,
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
		return scope.produceOffer(
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
			scope.startDeliveryWatch,
		);
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
