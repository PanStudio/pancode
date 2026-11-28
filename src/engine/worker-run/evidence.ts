// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * What a native worker run observed and changed: the read spans and grep lines that ground its
 * result, the workspace effects a mutation report is judged against, the recalls of evicted
 * observations, and the thrash note that tells a stalled run to write or report.
 */

import { telemetryHub } from "../../core/telemetry/hub.js";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../core/tool-surface.js";
import { createRunEffectsRecorder, recordToolExecutionEffects } from "../../domains/safety/run-effects.js";
import type { AgentEvent } from "../types.js";
import {
	chainStepVisibleText,
	type ReadCitationRequest,
	readCitationRequest,
	recordObservedGrep,
	recordObservedRead,
} from "../worker-grounding.js";
import { THRASH_RECALL_LIMIT, thrashHostNote } from "../worker-thrash-note.js";
import { createThrashOutcome } from "../worker-thrash-outcome.js";
import { INTERNAL_HELPER_RESULT_TOOL } from "../worker-tools.js";
import type { WorkerRunScope } from "./scope.js";

export function createWorkerEvidence(scope: WorkerRunScope) {
	const { input, phase, contractCwd, workerSettings, workerCanWrite, workerCanPlan } = scope;
	// CLI-H3: recalls of this run's evictions, the window the last request was fitted to, whether a request reached
	// the thrash share of it, and whether the one host turn has gone out.
	let evictedRecalls = 0;
	const pendingRecallCalls = new Set<string>();
	let thrashNudged = false;
	// X3: the read-only streak a writer worker reached when the read-streak rule handed it the second step, whether
	// the streak note went out, and whether it still stands (no progress since), which holds back the other causes.
	let streakNudged = false;

	/** Read tool call id -> what was asked for, pending that call's result. */
	const pendingReadCitations = new Map<string, ReadCitationRequest>();
	/** Grep call ids, direct or through gateway op=call, pending their results. */
	const pendingGrepCalls = new Set<string>();
	// The write-side equivalent: what this run changed and what it validated,
	// so a mutation report is judged against the run instead of believed. Scratch roots read as the orchestrator's copy
	// reads them, so a check logged under one is output in both recorders (x6-8).
	// X4: the thrash note's settlement, from the request that carries it to the change or report that answers it.
	const thrashOutcome = createThrashOutcome({ context: input.telemetryContext });
	const runEffects = createRunEffectsRecorder(contractCwd, {
		scratchRoots: workerSettings.safety.scratchRoots,
		onWorkspaceChange: (toolCallId) => thrashOutcome.changed(toolCallId),
	});

	/**
	 * The settled children of a chain, folded exactly as the direct calls
	 * would have been. Only a child its own admission ran to success grounds
	 * anything; a child refused by a run bound seals that bound. Pending and
	 * unresolved steps never ran and are never in the receipt list.
	 */
	const observeChainChildren = (toolName: string, result: unknown): void => {
		for (const child of gatewayChainReceipts(toolName, result)) {
			if (child.admission.outcome === "blocked") {
				if (child.admission.blockReason !== undefined) scope.observeBoundReason(child.admission.blockReason);
				continue;
			}
			if (child.admission.outcome !== "ok") continue;
			const visibleText = chainStepVisibleText(child);
			if (child.capability === ToolNames.Read) {
				const request = readCitationRequest(child.args);
				if (request !== null) recordObservedRead(contractCwd, scope.observedReadRanges, request, child.result, visibleText);
			} else if (child.capability === ToolNames.Grep || child.capability === ToolNames.Bash) {
				recordObservedGrep(scope.observedGrepLines, child.result.details, visibleText);
			}
		}
	};

	const onToolEvent = (event: AgentEvent): void => {
		// Read spans this run actually observed. They ground the terminal result
		// (a cited line has to fall inside one) and they are handed back verbatim
		// in a repair round, so re-emitting findings never invites invention.
		// Effects and grounding come from the capability operations that
		// settled: a gateway op=call as the capability it ran, a chain as each
		// admitted child, once each. Provider replay keeps the wire records.
		// The result submission is this run's handoff, never a workspace call, so it opens no write record (C-14).
		if (
			(event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
			!(scope.helperToolAvailable && event.toolName === INTERNAL_HELPER_RESULT_TOOL)
		) {
			recordToolExecutionEffects(runEffects, event);
		}
		// After the effects, so a call that changed the workspace has settled the note under its own id first.
		thrashOutcome.observe(event);
		if (event.type === "tool_execution_start") {
			const call = effectiveToolCall(event.toolName, event.args);
			if (call.toolName === ToolNames.Read) {
				const request = readCitationRequest(call.args);
				if (request !== null) pendingReadCitations.set(event.toolCallId, request);
			} else if (call.toolName === ToolNames.Grep || call.toolName === ToolNames.Bash) {
				// A bash `grep -n` reports the lines it printed as observedLines, as the grep tool does (FL-12).
				pendingGrepCalls.add(event.toolCallId);
			} else if (
				call.toolName === ToolNames.Context &&
				call.args?.scope === "recall" &&
				typeof call.args.ref === "string"
			) {
				pendingRecallCalls.add(event.toolCallId);
			}
		}
		if (event.type === "tool_execution_end") {
			const request = pendingReadCitations.get(event.toolCallId);
			pendingReadCitations.delete(event.toolCallId);
			const grepped = pendingGrepCalls.delete(event.toolCallId);
			if (event.isError !== true) {
				if (request !== undefined) recordObservedRead(contractCwd, scope.observedReadRanges, request, event.result);
				if (grepped) recordObservedGrep(scope.observedGrepLines, (event.result as { details?: unknown } | null)?.details);
			}
			observeChainChildren(event.toolName, event.result);
			// Only a recall that returned an archived observation brings evicted content back.
			if (pendingRecallCalls.delete(event.toolCallId) && event.isError !== true) evictedRecalls += 1;
			// One recall or context host turn per run and one streak turn per run, delivered after this tool batch, never
			// once the run is answering or bound. A standing streak note holds back the other causes until progress.
			const thrashCause =
				evictedRecalls > THRASH_RECALL_LIMIT
					? ("recall" as const)
					: scope.contextPressureCrossed && runEffects.snapshot().mutatedPaths.size === 0
						? ("context" as const)
						: null;
			const cause =
				thrashCause !== null && !thrashNudged && !scope.streakNoteOpen
					? thrashCause
					: scope.readStreakEscalated > 0 && !streakNudged && !thrashNudged
						? ("streak" as const)
						: null;
			if (
				cause !== null &&
				!phase.toolsLocked &&
				!phase.resultForced &&
				phase.sealedBy === null &&
				phase.lastRound === null
			) {
				if (cause === "streak") {
					streakNudged = true;
					scope.streakNoteOpen = true;
				} else thrashNudged = true;
				scope.agent.steer({
					role: "user",
					content: thrashHostNote(
						cause,
						cause === "streak" ? scope.readStreakEscalated : evictedRecalls,
						workerCanWrite,
						input.role !== undefined,
						workerCanPlan,
					),
					timestamp: Date.now(),
				});
				process.stderr.write(
					`[worker] thrash guard: ${cause === "recall" ? `${evictedRecalls} recalls of evicted observations` : cause === "streak" ? `${scope.readStreakEscalated} read-only calls in a row` : "context past the thrash share with no change"}; told the worker to write now or report\n`,
				);
				if (input.telemetryContext)
					telemetryHub().emit(
						"middleware.fired",
						{
							firingId: thrashOutcome.fire(),
							hook: "after_tool",
							phase: "sync",
							ruleId: "worker.thrash",
							effects: ["inject_reminder"],
							severity: "warn",
							evidence:
								cause === "recall"
									? "count:evicted-recall@worker"
									: cause === "streak"
										? "count:read-class-calls@worker"
										: "share:context-window@worker",
							...(cause === "recall" ? { tool: ToolNames.Context } : {}),
						},
						input.telemetryContext,
					);
			}
			// The streak's second step is judged at the tool end that raised it, never carried to a later call.
			scope.readStreakEscalated = 0;
		}
	};

	return { thrashOutcome, runEffects, onToolEvent };
}
