// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * An agent build's event handler: every engine event of the agent passes through it, in order, to settle calls, stamp
 * the run's evidence and timings, write the ledger and hand the event on to the turn's readers.
 */

import { performance } from "node:perf_hooks";
import { replySegment } from "../../core/answer-segments.js";
import { outputLimitCutOffToolCallIds } from "../../core/assistant-output.js";
import type { BackendCompletionTimings } from "../../core/cache-telemetry.js";
import { gatewayRoutingObservationFromRecord, gatewayRoutingObservationLabel } from "../../core/gateway-routing.js";
import { isHostAuthored } from "../../core/message-accounting.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../core/tool-surface.js";
import { canonicalEndpointKey, recordEndpointThroughput } from "../../domains/providers/index.js";
import { readDiffusionFrame } from "../../engine/apis/diffusion-frames.js";
import { hasAssistantGenerationDelta } from "../../engine/generation-delta.js";
import { sanitizeLockedSynthesisMessage } from "../../engine/loop-guard-synthesis.js";
import type { AgentEvent, AgentMessage, Usage } from "../../engine/types.js";
import { closeAskUserInterviewOnAssistantTurn } from "../../tools/ask-user.js";
import { completionOfToolResult } from "../../tools/finish.js";
import {
	type AssistantCallTiming,
	backendCacheVerdict,
	estimatedUsageForInterruptedTurn,
	extractText,
	extractThinking,
	HOST_STATUS_NOTICE_KEY,
	hasStructuredToolCall,
	isEmptyAbortedAssistantMessage,
	noteWrittenCalls,
	sumRunUsage,
	terminalFailureFromAssistantMessage,
	toolCallLabel,
	toolNamesFromAgentState,
	toolResultSummary,
} from "../chat-loop-messages.js";
import {
	assessDraftLoop,
	assessRepetition,
	assessToolCallFlood,
	repetitionAbortReason,
	shouldAssessRepetition,
	thinkingOverrunReason,
	toolCallFloodAbortReason,
} from "../repetition-detector.js";
import { assessToolProseLoop, runtimeNarratesToolCalls, shouldAssessToolProse } from "../tool-prose-loop.js";
import type { TurnRuntimeDeps } from "../turn-runtime-types.js";
import type { CallTelemetry } from "./calls.js";
import type { AgentBuildScope } from "./scope.js";
import type { StallWatchdog } from "./watchdog.js";

function isCollectedBatchResult(toolName: string, result: unknown): boolean {
	const details = (result as { details?: unknown } | undefined)?.details as
		| { mode?: unknown; batchId?: unknown; complete?: unknown; collected?: unknown }
		| undefined;
	return (
		effectiveToolCall(toolName, undefined, details).toolName === ToolNames.Monitor &&
		details?.mode === "collect" &&
		typeof details.batchId === "string" &&
		details.batchId.length > 0 &&
		details.complete === true &&
		details.collected === true
	);
}

export function createAgentEventHandler(
	scope: AgentBuildScope,
	calls: CallTelemetry,
	watchdog: StallWatchdog,
	handle: ReturnType<TurnRuntimeDeps["createAgent"]>,
) {
	const { deps, state, context, persistence, middleware, middlewareToolChoice } = scope.rt;
	const { stampCallFailure, settleModelCall, abandonModelCall, openModelCall } = calls;
	const { clearStallTimer, armStallTimer, noteFirstOutput, firstOutputMs } = watchdog;

	// Per streamed assistant message: how far each block was last checked for repetition. The prose filter
	// hands every delta a fresh partial object, so the counters reset on the message lifecycle, not identity.
	const repetitionCheck = { text: 0, thinking: 0 };
	const onAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "agent_start") {
			scope.runIdentity = deps.turnIdentity?.();
			scope.runTurnId = state.activeUserTurnId;
			// The last run's request says nothing about this one until this one is sent.
			state.modelRequest = null;
		}
		if (event.type === "agent_end") await abandonModelCall();
		if (!scope.currentRun()) {
			if (event.type === "message_end" && event.message.role === "assistant") await settleModelCall(event.message);
			clearStallTimer();
			return;
		}
		// The run's own events, before any reader of this one: an attempt is one run (agent_start to agent_end).
		if (event.type === "agent_start") state.runEvidence.beginAttempt();
		if (event.type === "message_end") state.runEvidence.record(event.message);
		if (event.type === "turn_start") {
			// The last request's facts say nothing about this turn's until its own request goes out.
			state.modelRequest = null;
			await abandonModelCall();
			scope.settledAttempts = [];
			scope.attemptRequest = undefined;
			await openModelCall();
		}
		// Every span below is measured on the monotonic frame, so an NTP
		// correction mid-turn cannot corrupt a tool duration or a TTFT.
		const eventClock = performance.now();
		scope.lastActivityAt = eventClock;
		let enrichedEvent = event;
		if (event.type === "message_end" && event.message.role === "assistant") {
			scope.requiredToolReminder = middlewareToolChoice.completeRound(event.message);
			const cutOff = outputLimitCutOffToolCallIds(event.message);
			for (const id of cutOff) scope.rt.cutOffToolCalls.add(id);
			// One line states the limit where it applies, instead of one failed call per call (bt-39 a).
			if (cutOff.length > 0)
				deps.emitNotice(
					`[PanCode] the response hit the output token limit with ${cutOff.length} tool call${cutOff.length === 1 ? "" : "s"} in it; none ran, since their arguments may be cut off, and the model is asked to re-issue them.`,
					"warning",
				);
		}
		if (event.type === "tool_execution_start") {
			scope.toolsInFlight += 1;
			middlewareToolChoice.toolStarted(event.toolName, event.args);
			deps.toolStartTimes.set(event.toolCallId, eventClock);
			state.turnToolCalls += 1;
			// Turn-end detectors (#184 skill wait) reason about the capability
			// that ran, which for the coordinator is usually behind gateway op=call.
			const effective = effectiveToolCall(event.toolName, event.args);
			state.turnToolNames.push(effective.toolName);
			if (effective.toolName !== ToolNames.Finish) state.turnCalledWork = true;
			scope.rt.startedCallLabels.set(event.toolCallId, toolCallLabel(effective.toolName, effective.args));
		} else if (event.type === "tool_execution_end") {
			scope.toolsInFlight = Math.max(0, scope.toolsInFlight - 1);
			const startedAt = deps.toolStartTimes.get(event.toolCallId);
			deps.toolStartTimes.delete(event.toolCallId);
			// Carry the registry's verdict alongside the engine's result. The
			// panel classifies settlement from `outcome`; without it the only
			// available signal is result text, and grepping that text for
			// "blocked"/"cancelled" labels every failing `node --test` run
			// (which prints `cancelled 0`) a permission block.
			const admission = scope.rt.toolOutcomes.get(event.toolCallId);
			scope.rt.toolOutcomes.delete(event.toolCallId);
			const notRun = scope.rt.cutOffToolCalls.delete(event.toolCallId);
			const protocolRetry = scope.rt.protocolRetryCalls.delete(event.toolCallId);
			const callLabel = scope.rt.startedCallLabels.get(event.toolCallId);
			scope.rt.startedCallLabels.delete(event.toolCallId);
			if (callLabel !== undefined && !notRun && !event.isError) state.turnCallsDone.push(callLabel);
			if (
				(!event.isError && isCollectedBatchResult(event.toolName, event.result)) ||
				gatewayChainReceipts(event.toolName, event.result).some(
					(step) => step.admission.outcome === "ok" && isCollectedBatchResult(step.capability, step.result),
				)
			)
				state.turnCollectedDetachedBatch = true;
			// The registry's own span is the one that means "how long the tool
			// took": the engine's start-to-end frame also covers the operator,
			// because a call awaiting a permission decision is parked between
			// those two events. Approving `wc -l src/*.ts | sort -n` after 25
			// seconds of reading rendered it as a 31-second command.
			const engineSpan = startedAt === undefined ? undefined : Math.round(Math.max(0, eventClock - startedAt));
			const durationMs = admission?.durationMs ?? engineSpan;
			enrichedEvent = {
				...event,
				...(durationMs !== undefined ? { durationMs } : {}),
				resultSummary: toolResultSummary(event.result),
				...(notRun ? { notRun: "output_limit" } : {}),
				...(protocolRetry ? { protocolRetry: true } : {}),
				...(admission === undefined
					? {}
					: {
							outcome: admission.outcome,
							// The registry's per-call classification and admission
							// decision. Headless receipts count safety decisions and
							// tell a successful write from any other success with
							// these, the same facts a worker's receipt is built from.
							...(admission.actionClass === undefined ? {} : { actionClass: admission.actionClass }),
							...(admission.decision === undefined ? {} : { decision: admission.decision }),
							...(admission.deniedPark === true ? { deniedPark: true } : {}),
							...(admission.redundantRepeat === true ? { redundantRepeat: true } : {}),
							...(admission.ruleId === undefined ? {} : { ruleId: admission.ruleId }),
							...(admission.reasonCode === undefined ? {} : { reasonCode: admission.reasonCode }),
							...(admission.policySource === undefined ? {} : { policySource: admission.policySource }),
							...(admission.autoApproved === undefined ? {} : { autoApproved: admission.autoApproved }),
							...(admission.reason === undefined ? {} : { blockReason: admission.reason }),
							...(admission.denial === undefined ? {} : { denial: admission.denial }),
							// A verify call naming a check that does not exist ran nothing; a headless receipt must not seal it as a failed check.
							...(admission.unresolved === true ? { unresolved: true } : {}),
						}),
			} as typeof event;
		} else if (event.type === "agent_end") {
			// The engine's failure path (an abort or a thrown provider error)
			// replaces the run's message window with one synthetic zero-usage
			// failure message, which zeroed token usage, tool counts, and cache
			// records for every aborted turn. Rebuild the real window from the
			// run evidence log, which holds all of this run's messages plus that
			// failure message.
			const runMessages = state.runEvidence.attempt();
			if (runMessages.length > event.messages.length) {
				enrichedEvent = { ...event, messages: runMessages } as typeof event;
			}
		} else if (event.type === "message_end" && state.synthesisToolLock) {
			// Synthesis-locked turn: a model that ignores tool_choice none emits
			// its chat template's tool-call syntax as plain text. Sanitize the
			// message in place (pi stores this same object in agent state, so
			// the emitted event, ledger persistence below, and later provider
			// rounds all see the sanitized text) and mark the event so the
			// panel replaces its streamed markup tail instead of appending.
			if (sanitizeLockedSynthesisMessage(event.message)) {
				enrichedEvent = { ...event, lockedSynthesisSanitized: true } as typeof event;
			}
		}
		// Same object again, so the ledger row below and every reader of the settled run see the stamp.
		if (event.type === "message_end" && event.message.role === "assistant") {
			noteWrittenCalls(event.message, (tool) => {
				const attached = toolNamesFromAgentState(scope.localRuntime.agent.state.tools);
				if (attached.includes(tool)) return true;
				return attached.includes("gateway") && (deps.gatewayCapabilityNames?.().includes(tool) ?? false);
			});
			// CLI-P49: the turn has replied exactly when the headless answer has a segment, read by the same typed
			// predicate after the written-calls stamp: no narration beside a work call, failed message or dead markup.
			if (replySegment(event.message) !== null) state.turnReplied = true;
		}
		// Every user message starts the turn whose replies are the answer, as the headless reader counts it (CLI-P43), so
		// a continuation's prompt clears the reply the bare-finish check reads too.
		if (event.type === "message_end" && event.message.role === "user") state.turnReplied = false;
		// The run's start and end name the operator turn its calls journal under, so the transcript receipt reads
		// that turn's spend from the read model (#434 §11.3).
		if ((enrichedEvent.type === "agent_start" || enrichedEvent.type === "agent_end") && state.activeUserTurnId)
			enrichedEvent = { ...enrichedEvent, turnId: state.activeUserTurnId } as unknown as typeof enrichedEvent;
		let publicEvent = enrichedEvent;
		let journalAccounted = false;
		if (enrichedEvent.type === "message_end" && enrichedEvent.message?.role === "assistant") {
			const message = enrichedEvent.message;
			const usage = (message.usage ?? {}) as unknown as Record<string, unknown>;

			const observed = normalizeTokenUsage(usage).observed;
			const responseId = (message as { responseId?: unknown }).responseId;
			const responseObserved = observed || (typeof responseId === "string" && responseId.length > 0);
			const terminal = terminalFailureFromAssistantMessage(message);
			if (terminal) {
				stampCallFailure(message, terminal, responseObserved);
			} else {
				Object.assign(message, { callInvoked: scope.apiCallStartedAt !== null || responseObserved });
			}
			const pricedBy = !observed
				? "none"
				: (usage.pancodeExternal as { cost?: string } | undefined)?.cost === "provider-reported"
					? "provider"
					: scope.localRuntime.runtimeResolution.pricedBy;
			const freeRule = pricedBy === "free" ? scope.localRuntime.runtimeResolution.freeRule : undefined;
			Object.assign(message, {
				callAccounting: {
					usageObserved: observed,
					pricedBy,
					...(freeRule !== undefined ? { freeRule } : {}),
					targetId: scope.localRuntime.targetId,
				},
			});
			const gatewayRouting = gatewayRoutingObservationFromRecord(
				enrichedEvent.message as unknown as Record<string, unknown>,
			);
			if (
				gatewayRouting !== null &&
				((gatewayRouting.attemptedFallbacks ?? 0) > 0 || (gatewayRouting.attemptedRetries ?? 0) > 0)
			) {
				deps.emitNotice(`[PanCode] ${gatewayRoutingObservationLabel(gatewayRouting)}`, "info", HOST_STATUS_NOTICE_KEY);
			}
			// The estimate goes to the call's settlement, where the read model folds it; it never rides on the message,
			// so no reader sums it beside the provider's usage (#423, #430, #434).
			journalAccounted = await settleModelCall(
				enrichedEvent.message,
				estimatedUsageForInterruptedTurn(enrichedEvent.message, context.promptSideTokens()),
			);
			// A reply PanCode wrote into the prompt, such as the loop guard's recovery pair, settles the call opened at
			// turn_start as never sent, as its ledger row counts it; the model's own reply gets a call of its own (#434).
			if (isHostAuthored(message)) await openModelCall();
		}

		if (
			publicEvent?.type === "message_end" &&
			publicEvent.message.role === "assistant" &&
			scope.apiCallStartedAt !== null
		) {
			publicEvent = {
				...publicEvent,
				modelTimeMs: Math.round(Math.max(0, eventClock - scope.apiCallStartedAt)),
				ttftMs: firstOutputMs(),
			} as typeof publicEvent;
		}
		if (publicEvent?.type === "message_end" && publicEvent.message.role === "assistant") scope.cutStalledRequest = null;
		if (publicEvent?.type === "agent_start") {
			scope.turnEndFiredFor = null;
			scope.cutStalledRequest = null;
			state.continuation.clearInRun();
			scope.apiCallStartedAt = null;
			scope.apiCallFirstDeltaAt = null;
			scope.preInvocationStage = "transform";
			scope.placeholderKeySent = false;
			scope.runFirstCallVerdict = null;
			scope.pendingTerminalToolResult = null;
			clearStallTimer();
			scope.toolsInFlight = 0;
			scope.stallSuspendDepth = 0;
			state.streamStallReason = null;
			state.streamStallStage = null;
			const stallMs = deps.retrySettings().streamStallMs;
			if (stallMs > 0) armStallTimer(stallMs);
		}
		// The engine runs the whole tool batch to settlement before it emits
		// `turn_end`, so nothing from this turn can still be executing here.
		// A call whose `tool_execution_end` was never emitted (a crashed
		// mediator, a dropped frame) therefore stops suspending the watchdog
		// at the turn that issued it instead of for the rest of the run.
		if (publicEvent?.type === "turn_end") scope.toolsInFlight = 0;
		if (publicEvent?.type === "message_update") {
			const hasDelta = hasAssistantGenerationDelta(publicEvent.assistantMessageEvent);
			if (hasDelta && scope.apiCallFirstDeltaAt === null) noteFirstOutput(eventClock);
		}
		if (enrichedEvent.type === "agent_end") {
			context.noteRunCacheSummary(enrichedEvent.messages, scope.runFirstCallVerdict);
		}
		if (enrichedEvent.type === "message_end" && enrichedEvent.message.role === "assistant") {
			const completed = sumRunUsage([enrichedEvent.message]);
			// A call no journal holds is counted against the ceiling for the rest of its run only (#434).
			const priced = factKnownValue(completed.cost.usd);
			if ((!deps.telemetry || !journalAccounted) && completed.hadUsage && Number.isFinite(priced) && priced > 0) {
				scope.unsettledSpendUsd += priced;
			}
		}
		if (enrichedEvent.type === "agent_end") scope.unsettledSpendUsd = 0;
		// Suppress the hollow transcript event while its closing turn keeps the call's accounting (#430).
		if (
			state.activeInterruptReason !== null &&
			enrichedEvent.type === "message_end" &&
			isEmptyAbortedAssistantMessage(enrichedEvent.message)
		) {
			persistence.appendAssistantTurn(
				enrichedEvent.message,
				scope.apiCallStartedAt === null
					? null
					: {
							ttftMs: firstOutputMs(),
							apiMs: Math.round(Math.max(0, eventClock - scope.apiCallStartedAt)),
						},
			);
			return;
		}
		if (publicEvent) deps.emit(publicEvent);
		if (enrichedEvent.type === "message_start") {
			repetitionCheck.text = 0;
			repetitionCheck.thinking = 0;
		}
		if (publicEvent?.type === "message_update") {
			const assistantEvent = publicEvent.assistantMessageEvent as {
				type: string;
				contentIndex?: number;
				delta?: string;
				partial?: AgentMessage;
			};
			if (
				(assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") &&
				state.repetitionAbortReason === null &&
				state.activeInterruptReason === null
			) {
				const thinking = assistantEvent.type === "thinking_delta";
				const streamed = thinking ? extractThinking(assistantEvent.partial) : extractText(assistantEvent.partial);
				// A replacement-style diffusion frame can shorten the text; measure growth from what it now holds.
				if (thinking) repetitionCheck.thinking = Math.min(repetitionCheck.thinking, streamed.length);
				else repetitionCheck.text = Math.min(repetitionCheck.text, streamed.length);
				if (shouldAssessRepetition(streamed.length, thinking ? repetitionCheck.thinking : repetitionCheck.text)) {
					if (thinking) repetitionCheck.thinking = streamed.length;
					else repetitionCheck.text = streamed.length;
					const repetition = assessRepetition(streamed);
					const drafting = thinking && repetition.kind === "ok" ? assessDraftLoop(streamed) : repetition;
					// Reasoning only: no text or call yet, on a route whose server enforces no thinking budget (bt-25).
					const blocks: ReadonlyArray<{ type?: unknown }> = Array.isArray(assistantEvent.partial?.content)
						? assistantEvent.partial.content
						: [];
					const overrun =
						thinking &&
						scope.localRuntime.runtimeResolution.modelRuntime.thinking.budgetEnforcement !== "enforced" &&
						blocks.every((block) => block.type === "thinking")
							? thinkingOverrunReason(streamed.length, scope.localRuntime.agent.state.model.maxTokens)
							: null;
					const stop = drafting.kind === "repeating" ? repetitionAbortReason(drafting) : overrun;
					if (stop !== null) {
						state.repetitionAbortReason = stop;
						deps.emitNotice(state.repetitionAbortReason, "warning");
						scope.localRuntime.agent.abort();
					}
				}
			}
			// Some adapters end every call block only when the stream ends, so the calls before a starting one are judged
			// at its start: their arguments are complete by then, and the stop lands while the flood is still streaming.
			// A call still marked as streaming its arguments (copilot-sdk's `partialJson`) is skipped until they are final.
			if (
				(assistantEvent.type === "toolcall_start" || assistantEvent.type === "toolcall_end") &&
				state.repetitionAbortReason === null &&
				state.activeInterruptReason === null
			) {
				const completeBlocks = (assistantEvent.contentIndex ?? 0) + (assistantEvent.type === "toolcall_end" ? 1 : 0);
				const flood = assessToolCallFlood(assistantEvent.partial, completeBlocks);
				if (flood.kind === "flooding") {
					state.repetitionAbortReason = toolCallFloodAbortReason(flood);
					deps.emitNotice(state.repetitionAbortReason, "warning");
					scope.localRuntime.agent.abort();
				}
			}
			if (assistantEvent.type === "text_delta") {
				const partialText = extractText(assistantEvent.partial);
				const frame = readDiffusionFrame(assistantEvent);
				if (frame) {
					deps.emit({
						type: "text_frame",
						contentIndex: assistantEvent.contentIndex ?? 0,
						text: frame.text,
						progress: frame.progress,
					});
				} else {
					deps.emit({
						type: "text_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialText,
					});
				}
				const localToolRuntime = runtimeNarratesToolCalls(scope.localRuntime.runtimeResolution.runtimeTier);
				if (
					localToolRuntime &&
					state.toolProseAbortReason === null &&
					shouldAssessToolProse(partialText.length, state.toolProseAssessedChars)
				) {
					state.toolProseAssessedChars = partialText.length;
					const activeToolNames = toolNamesFromAgentState(scope.localRuntime.agent.state.tools);
					const assessment = assessToolProseLoop({
						text: partialText,
						activeToolNames,
						...(activeToolNames.includes("gateway") && deps.gatewayCapabilityNames
							? { gatewayToolNames: deps.gatewayCapabilityNames() }
							: {}),
						hasStructuredToolCall: hasStructuredToolCall(assistantEvent.partial),
					});
					if (assessment.kind === "loop") {
						state.toolProseAbortReason = `[PanCode] aborted local model turn: ${assessment.reason}.`;
						scope.localRuntime.agent.abort();
						deps.emitNotice(state.toolProseAbortReason);
					}
				}
			}
			if (assistantEvent.type === "thinking_delta") {
				deps.emit({
					type: "thinking_delta",
					contentIndex: assistantEvent.contentIndex ?? 0,
					delta: assistantEvent.delta ?? "",
					partialThinking: extractThinking(assistantEvent.partial),
				});
			}
		}
		if (enrichedEvent.type === "message_end") {
			persistence.appendQueuedUserTurn(enrichedEvent.message);
			const isAssistant = enrichedEvent.message?.role === "assistant";
			if (isAssistant) scope.pendingTerminalToolResult = null;
			const timing: AssistantCallTiming | null =
				isAssistant && scope.apiCallStartedAt !== null
					? {
							ttftMs: firstOutputMs(),
							apiMs: Math.round(Math.max(0, eventClock - scope.apiCallStartedAt)),
						}
					: null;
			const correlationId = event.type === "message_end" ? handle.requestCorrelationId(event.message) : undefined;
			const persistedId = persistence.appendAssistantTurn(enrichedEvent.message, timing, correlationId);
			await deps.continuity?.response(persistedId, correlationId);
			if (!scope.currentRun()) return;
			if (isAssistant) {
				scope.apiCallStartedAt = null;
				scope.preInvocationStage = "transform";
				if (state.currentAskUserPolicy) {
					const sessionId = deps.sessionId?.();
					const turnId = state.activeUserTurnId ?? undefined;
					await closeAskUserInterviewOnAssistantTurn(state.currentAskUserPolicy, enrichedEvent.message, {
						...(sessionId ? { sessionId } : {}),
						...(turnId ? { turnId } : {}),
					});
				}
			}
			const usage = (enrichedEvent.message as { usage?: Usage }).usage;
			if (isAssistant && usage && typeof usage === "object" && scope.runFirstCallVerdict === null) {
				const input = typeof usage.input === "number" ? usage.input : 0;
				const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
				const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
				const backendTimings = (enrichedEvent.message as { backendTimings?: BackendCompletionTimings }).backendTimings;
				scope.runFirstCallVerdict = backendCacheVerdict(input, cacheRead, cacheWrite, backendTimings, usage.cacheReadField);
			}
			// The background memory budget sizes a local step's deadline from the
			// speed this endpoint measured on the operator's own turns.
			if (isAssistant) {
				recordEndpointThroughput(
					canonicalEndpointKey(scope.localRuntime.runtimeResolution.target),
					(enrichedEvent.message as { backendTimings?: BackendCompletionTimings }).backendTimings,
				);
			}
			if (usage) {
				const origin = enrichedEvent.message as { callId?: unknown; attemptId?: unknown };
				context.reconcileUsage(
					usage,
					typeof origin.callId === "string" && typeof origin.attemptId === "string"
						? { callId: origin.callId, attemptId: origin.attemptId }
						: undefined,
				);
			}
		}
		if (enrichedEvent.type === "tool_execution_start") {
			persistence.appendToolCallTurn(enrichedEvent);
		}
		if (enrichedEvent.type === "tool_execution_end") {
			persistence.appendToolResultTurn(enrichedEvent);
			// The typed completion declaration (fleet design 4.3): read from the settled result, never from reply text.
			const completion = enrichedEvent.isError
				? null
				: completionOfToolResult(enrichedEvent.toolName, enrichedEvent.result);
			if (completion !== null) state.turnCompletion = completion;
			scope.pendingTerminalToolResult =
				(enrichedEvent.result as { terminate?: boolean } | undefined)?.terminate === true
					? { toolCallId: enrichedEvent.toolCallId, toolName: enrichedEvent.toolName }
					: null;
		}
		if (enrichedEvent.type === "agent_end") {
			await deps.continuity?.pause();
			clearStallTimer();
			if (!scope.currentRun()) return;
			const terminal = scope.pendingTerminalToolResult;
			scope.pendingTerminalToolResult = null;
			if (terminal) {
				persistence.appendTerminalToolAssistantTurn(terminal);
			}
			context.flushReconciledSnapshot();
			const finalAssistant = [...enrichedEvent.messages].reverse().find((message) => message.role === "assistant");
			if (terminal !== null || finalAssistant === undefined || finalAssistant !== scope.turnEndFiredFor) {
				await middleware.fireTurnEnd(scope.localRuntime, enrichedEvent.messages, terminal ?? undefined);
			}
			scope.turnEndFiredFor = null;
		}
	};
	return onAgentEvent;
}
