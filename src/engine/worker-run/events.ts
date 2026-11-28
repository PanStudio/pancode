// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The event stream of a native worker run: one subscriber on the engine agent that completes
 * middleware rounds, opens and settles each model call's telemetry, stamps usage and failure on
 * each answer, hands tool and message events to the evidence and result hooks in a fixed order,
 * and forwards every event to the run's output.
 */

import { classifyCallFailure } from "../../core/call-failure.js";
import { requestedThinking } from "../../core/telemetry/call-effort.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
import type { AgentMessage } from "../types.js";
import { hostWrittenExchange, isAssistantMessage } from "../worker-assistant-reply.js";
import { INTERNAL_HELPER_RESULT_TOOL } from "../worker-tools.js";
import type { WorkerRunScope } from "./scope.js";

export function subscribeWorkerEvents(scope: WorkerRunScope): () => void {
	const {
		emit,
		phase,
		agent,
		model,
		middlewareToolChoice,
		thrashOutcome,
		terminalHandoffActive,
		helperToolAvailable,
		workerResponseFormat,
		effectiveThinkingLevel,
		onAssistantBatch,
		onToolEvent,
		onMessageEnd,
	} = scope;
	const unsubscribe = agent.subscribe(async (event) => {
		if (
			event.type === "message_end" &&
			isAssistantMessage(event.message) &&
			!phase.toolsLocked &&
			phase.sealedBy === null &&
			phase.lastRound === null
		) {
			const reminder = middlewareToolChoice.completeRound(event.message);
			if (reminder !== null) {
				if (!hostWrittenExchange(event.message)) scope.workerTelemetry?.settle(event.message);
				// This answer is a request the thrash note may have ridden, though the round ends here.
				thrashOutcome.observe(event);
				// The middleware round must run before this answer can seal a terminal result (#423).
				const tail: AgentMessage = { role: "user", content: reminder, timestamp: Date.now() };
				if (event.message.content.some((block) => block.type === "toolCall")) agent.steer(tail);
				else agent.followUp(tail);
				emit(event);
				return;
			}
		}
		if (event.type === "turn_start") {
			const choice = middlewareToolChoice.current();
			const handoff = terminalHandoffActive(model.api);
			scope.workerTelemetry?.begin({
				roundKind: handoff
					? "required"
					: phase.toolsLocked
						? "tools-removed"
						: choice.kind === "none"
							? "text-only"
							: choice.kind === "required"
								? "required"
								: "normal",
				toolChoice: handoff
					? { name: INTERNAL_HELPER_RESULT_TOOL }
					: phase.toolsLocked || choice.kind === "none"
						? "none"
						: choice.kind === "required"
							? { name: choice.toolName }
							: "auto",
				// The same predicate streamFn applies to this round's request.
				...(workerResponseFormat !== undefined ||
				(scope.contractResponseFormat !== undefined && phase.toolsLocked && !helperToolAvailable)
					? { responseFormat: "json-schema" as const }
					: {}),
				...requestedThinking(effectiveThinkingLevel),
			});
			scope.callTracking = null;
			scope.callUsageReported = false;
			scope.workerModelRound += 1;
			scope.helperTurnFailure = null;
		}
		if (
			event.type === "message_end" &&
			isAssistantMessage(event.message) &&
			(event.message.usage as unknown as Record<string, unknown>).callInvoked !== false
		) {
			const message = event.message as unknown as Record<string, unknown>;
			const usage = event.message.usage as unknown as Record<string, unknown>;
			const reported = scope.callUsageReported || normalizeTokenUsage(usage).observed;
			const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
			const failure = failed
				? (scope.callTracking?.failure(event.message, event.message.stopReason === "aborted", reported) ??
					classifyCallFailure(event.message, { invoked: false }))
				: undefined;
			if (failure !== undefined) message.failure = failure;
			usage.callInvoked = failure?.invoked ?? true;
			usage.usageReported = reported;
		}
		// A repair exchange PanCode wrote into the conversation reached no provider: the round's attempt belongs to the request
		// that follows it, so it settles no attempt of its own (C-28).
		if (event.type === "message_end" && isAssistantMessage(event.message) && !hostWrittenExchange(event.message))
			scope.workerTelemetry?.settle(event.message);
		onAssistantBatch(event);
		if (event.type === "tool_execution_start" && event.toolName !== INTERNAL_HELPER_RESULT_TOOL) {
			scope.toolExecutionsStarted += 1;
			middlewareToolChoice.toolStarted(event.toolName, event.args);
		}
		onToolEvent(event);
		onMessageEnd(event);
		emit(event);
	});
	return unsubscribe;
}
