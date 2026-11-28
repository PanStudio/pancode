// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { MEMORY_CONSOLIDATION_SYSTEM_PROMPT } from "../../prompts/memory-intervention.js";
import type { TaskMemoryTelemetryDecision, TaskMemoryTelemetryTier } from "../memory-events.js";
import {
	runTaskMemoryPolicy,
	type TaskMemoryEnvelope,
	type TaskMemoryModelClient,
	type TaskMemoryPolicyReason,
	type TaskMemoryPolicyResult,
	type TaskMemoryRoute,
} from "../task-memory-policy.js";
import { positiveInteger } from "../util.js";
import { budgetSkipped, entryRevision, type InterventionScope, NO_EFFECTS, YIELDED_REASONS } from "./scope.js";
import type {
	MemoryInterventionOffer,
	MemoryInterventionRegistration,
	MemoryPromptedStepInput,
	MemoryPromptedStepResult,
} from "./types.js";

/** Two full deadlines are enough evidence to stop spending this session's endpoint. */
const MEMORY_INTERVENTION_TIMEOUT_BACKOFF_THRESHOLD = 2;

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

export function createInterventionPromptedStep(scope: InterventionScope) {
	const { deps } = scope;
	const members: Pick<MemoryInterventionRegistration, "runPromptedStep"> = {
		runPromptedStep,
	};

	return { ...members };

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
		const live = scope.settings();
		// A detached answer keeps the turn that launched it, even if the foreground advances (#434).
		const launchContext = scope.stepContext;
		const isCurrent = scope.captureContentGuard();
		// The workspace and the failure episodes this step is reasoning about are
		// captured with its authority: paths are checked against the session's
		// workspace, never the process directory, and a correction is bound to
		// the episodes that were open when it was asked for.
		const launchRoot = scope.workspaceRoot();
		const launchFailures = scope.openFailureEpisodes(
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
											keptLessons: scope.keptLessonsForPass(),
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
							scope.emitTelemetry(
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
			const cited = scope.citedEntries(promptedResult.reminder);
			const produced = scope.produceOffer(
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
				scope.startDeliveryWatch,
			);
			if (produced === null) {
				promptedResult = { ...promptedResult, decision: "silent", reason: "duplicate_reminder", reminder: null };
			} else if (!scope.offerCurrent(produced)) {
				// Evidence moved while the model was answering: the failure it was
				// asked about resolved, or a fact it cites was rewritten.
				scope.releaseOffer(produced.id);
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
			scope.reviewKnowledge(promptedResult.presentedEntries.filter((entry) => entry.kind === "knowledge"));
		}
		if (promptedResult.retiredLessonIds !== undefined) {
			try {
				deps.onKeptLessonsRetired?.(promptedResult.retiredLessonIds);
			} catch {
				// Same contract as onInjectedEntries: the store's failure is not the session's.
			}
		}
		scope.emitTelemetry(
			triggers,
			tier,
			telemetryDecision ?? promptedResult.decision,
			promptedResult.reason,
			scope.citedEntryCount(promptedResult.reminder),
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
