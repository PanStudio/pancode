// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { toContextOverflowError } from "../../domains/providers/errors.js";
import { classifyRecoveryFailure, isRetryableRecoveryFailure } from "../../domains/session/retry.js";
import { isLockedSynthesisFallbackOnly, lockedSynthesisRepromptMessages } from "../../engine/loop-guard-synthesis.js";
import type { AgentMessage, ImageContent } from "../../engine/types.js";
import type { ChatSubmitOptions } from "../chat-loop.js";
import {
	detectOverflowFromState,
	detectTerminalFailureFromState,
	isThinkingOnlyLengthStop,
	THINKING_LENGTH_STOP_REASON,
} from "../chat-loop-messages.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { PathMessage } from "../message-path.js";
import {
	REPETITION_REPROMPT_NOTICE_KEY,
	repetitionRecoveryStage,
	repetitionRepromptMessages,
} from "../repetition-detector.js";
import {
	lowerThinkingLevel,
	THINKING_LENGTH_RECOVERY_NOTICE_KEY,
	THINKING_LENGTH_STOP_NOTICE_KEY,
	thinkingLengthRecoveryMessages,
} from "../thinking-length-recovery.js";
import { reclassifyStallAbort, recoveryAttemptHasOutput } from "../turn-recovery.js";
import type { AgentRuntime, ChatLoopSubmitState } from "../turn-state.js";
import type { SubmitTurn } from "./submit-turn.js";

const ENGINE_ACTIVE_PROMPT_ERROR =
	"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.";

const ACTIVE_PROMPT_NOTICE =
	"[PanCode] another response was already active, so this response could not start. Wait for it to finish, then submit again.";

function operatorFacingEngineError(message: string): string {
	return message.includes(ENGINE_ACTIVE_PROMPT_ERROR) ? ACTIVE_PROMPT_NOTICE : message;
}

/** What `submit` hands its prompt run: the admitted turn's runtime and the prompt it sends. */
export interface SubmitRunInput {
	options: ChatSubmitOptions;
	admissionCurrent: () => boolean;
	pathMessage: PathMessage | null;
	agentRuntime: AgentRuntime;
	userTurnId: string | null;
	runtimePromptText: string;
	images: ImageContent[] | undefined;
}

/**
 * Runs one admitted turn's prompt and its in-turn recoveries: the locked-synthesis answer, the repetition and
 * thinking-length re-prompts, compact-and-retry on overflow and the transient retry chain, whether the engine
 * settled on a failure or threw. Every exit returns into `submit`'s settlement.
 */
export async function runSubmittedTurn(
	loop: ChatLoopScope,
	state: ChatLoopSubmitState,
	turn: SubmitTurn,
	input: SubmitRunInput,
): Promise<void> {
	const { context, emitNotice, messagePath, queues, recordRecovery, recovery } = loop;
	const { options, admissionCurrent, pathMessage, agentRuntime, userTurnId, runtimePromptText, images } = input;
	try {
		if (!admissionCurrent()) return;
		await queues.markPersistedUserEcho(runtimePromptText, () => {
			if (!admissionCurrent()) return Promise.resolve();
			// A flushed queue rides Pi's opening poll, so it lands with this
			// prompt's first model call; a held queue waits for the first slot.
			turn.promptStarted = true;
			loop.queueSessionId = loop.api.getSessionId();
			if (pathMessage) messagePath.prompted(pathMessage);
			queues.handOverBeforePrompt(agentRuntime.agent, {
				keepOperatorHold:
					options.machineTurn !== undefined || options.origin !== undefined || options.requestContinuation === true,
			});
			if (userTurnId) context.commitSessionPosture(agentRuntime, userTurnId);
			state.routeMoveSeat = true;
			return agentRuntime.agent.prompt(runtimePromptText, images);
		});
		state.routeMoveSeat = false;
		if (
			admissionCurrent() &&
			state.synthesisToolLock &&
			state.activeInterruptReason === null &&
			isLockedSynthesisFallbackOnly(agentRuntime.agent.state.messages.at(-1))
		) {
			// Deliver the pair atomically. The normal follow-up queue drains one
			// message at a time; queuing these separately creates an extra round
			// with an unanswered synthetic tool call.
			emitNotice("[PanCode] Recovering a final answer once; tools remain disabled.");
			const model = agentRuntime.agent.state.model;
			await agentRuntime.agent.prompt(
				recordRecovery(
					"synthesis-recovery",
					lockedSynthesisRepromptMessages(1, {
						provider: model.provider,
						api: model.api,
						model: model.id,
					}),
				),
			);
		}
		// The repetition check stopped a looping stream. The stopped reply is replaced by a nudge and the model
		// runs again, at most twice per operator turn (`repetitionRecoveryStage`): a plain nudge that keeps the
		// request, then, when that run is stopped too, a changed request with a firmer instruction and thinking one
		// step lower (SC-5). An operator's Esc in the same window wins. The stopped reply already carries the
		// reason (turn-runtime), so a stop with no recovery left ends the turn on it.
		for (
			let stage = repetitionRecoveryStage(state);
			stage !== null && admissionCurrent();
			stage = repetitionRecoveryStage(state)
		) {
			const turnId = state.activeUserTurnId;
			const stoppedFor = state.repetitionAbortReason;
			if (turnId === null || stoppedFor === null) break;
			state.repetitionRepromptStages = stage;
			state.repetitionRepromptTurnId = turnId;
			state.repetitionAbortReason = null;
			const last = agentRuntime.agent.state.messages.at(-1);
			// The looping reply is in the ledger; replaying it would resend the loop.
			const stopped =
				last?.role === "assistant" && (last as { stopReason?: unknown }).stopReason === "aborted" ? last : undefined;
			if (stopped) agentRuntime.agent.state.messages = agentRuntime.agent.state.messages.slice(0, -1);
			const priorLevel = agentRuntime.agent.state.thinkingLevel;
			const recoveryLevel =
				stage === 1 ? priorLevel : lowerThinkingLevel(priorLevel, agentRuntime.runtimeResolution.modelRuntime.thinking);
			emitNotice(
				stage === 1
					? "[PanCode] Asking the model to act or answer instead of repeating."
					: recoveryLevel === priorLevel
						? "[PanCode] The model repeated itself again; asking once more with a firmer instruction."
						: // The operator's level, not the route's clamp of it, as the thinking-length recovery says.
							`[PanCode] The model repeated itself again; asking once more with a firmer instruction, with thinking ${recoveryLevel} instead of ${agentRuntime.runtimeResolution.requestedThinkingLevel}.`,
				"warning",
				REPETITION_REPROMPT_NOTICE_KEY,
			);
			if (recoveryLevel !== priorLevel && !context.thinkingUsesConfigurationUpdate())
				context.noteColdReason("thinking_change");
			const model = agentRuntime.agent.state.model;
			agentRuntime.agent.state.thinkingLevel = recoveryLevel;
			try {
				await agentRuntime.agent.prompt(
					recordRecovery(
						"repetition-recovery",
						repetitionRepromptMessages({ provider: model.provider, api: model.api, model: model.id }, stoppedFor, stage),
						stopped,
					),
				);
			} finally {
				agentRuntime.agent.state.thinkingLevel = priorLevel;
			}
		}
		// The output cap ran out while the model was still thinking. Once per
		// operator turn the cut-off reply is replaced by a reminder and the
		// model runs again one thinking step lower; a second such stop ends
		// the turn naming the cause and the fix.
		if (
			admissionCurrent() &&
			state.activeInterruptReason === null &&
			isThinkingOnlyLengthStop(agentRuntime.agent.state.messages.at(-1))
		) {
			const turnId = state.activeUserTurnId;
			if (turnId !== null && state.thinkingLengthRecoveryTurnId !== turnId) {
				state.thinkingLengthRecoveryTurnId = turnId;
				// The cut-off reply is in the ledger; replaying it would resend the deliberation.
				const stopped = agentRuntime.agent.state.messages.at(-1);
				agentRuntime.agent.state.messages = agentRuntime.agent.state.messages.slice(0, -1);
				const priorLevel = agentRuntime.agent.state.thinkingLevel;
				const recoveryLevel = lowerThinkingLevel(priorLevel, agentRuntime.runtimeResolution.modelRuntime.thinking);
				emitNotice(
					recoveryLevel === priorLevel
						? "[PanCode] The model ran out of output while thinking; asking it once to act or answer."
						: // The operator's level, not the route's clamp of it: an on/off route runs "high" as "low".
							`[PanCode] The model ran out of output while thinking; asking it once to act or answer, with thinking ${recoveryLevel} instead of ${agentRuntime.runtimeResolution.requestedThinkingLevel}.`,
					"warning",
					THINKING_LENGTH_RECOVERY_NOTICE_KEY,
				);
				if (recoveryLevel !== priorLevel && !context.thinkingUsesConfigurationUpdate())
					context.noteColdReason("thinking_change");
				const model = agentRuntime.agent.state.model;
				agentRuntime.agent.state.thinkingLevel = recoveryLevel;
				try {
					await agentRuntime.agent.prompt(
						recordRecovery(
							"thinking-length-recovery",
							thinkingLengthRecoveryMessages({ provider: model.provider, api: model.api, model: model.id }),
							stopped,
						),
					);
				} finally {
					agentRuntime.agent.state.thinkingLevel = priorLevel;
				}
			}
			if (
				admissionCurrent() &&
				state.activeInterruptReason === null &&
				isThinkingOnlyLengthStop(agentRuntime.agent.state.messages.at(-1))
			)
				emitNotice(THINKING_LENGTH_STOP_REASON, "error", THINKING_LENGTH_STOP_NOTICE_KEY);
		}
		// pi-agent-core does NOT throw on provider failures:
		// it pushes an assistant message with stopReason="error" and
		// errorMessage="<provider text>" onto state.messages, sets
		// state.errorMessage, emits agent_end, and resolves normally.
		// The overflow-recovery heuristic must inspect the state after
		// a resolve, not only the catch arm.
		if (!admissionCurrent()) return;
		const overflowPostResolve = detectOverflowFromState(agentRuntime.agent);
		if (overflowPostResolve) {
			await recovery.runCompactAndRetry(agentRuntime, runtimePromptText, overflowPostResolve, images);
		} else {
			const settled = detectTerminalFailureFromState(agentRuntime.agent);
			if (settled) {
				if (state.toolProseAbortReason && settled.message) {
					(settled.message as { errorMessage?: string }).errorMessage = state.toolProseAbortReason;
				}
				// A stalled stream settles here, not in the catch arm: the engine's
				// runWithLifecycle swallows the abort and resolves with an aborted
				// assistant message. Reclassify before the ladder's gate so the
				// watchdog's abort retries and an operator cancel still does not.
				const failure = reclassifyStallAbort(state, settled);
				recovery.ensureFailureVisibleAndPersisted(failure);
				await recovery.runTransientRetryChain(agentRuntime, runtimePromptText, failure, state.runEvidence.attempt());
			}
		}
	} catch (err) {
		if (!admissionCurrent()) return;
		// Genuine throws (network, abort, pre-stream bugs) still land
		// here. The heuristic is the same so a thrown overflow from
		// an older pi-agent-core still routes through compact-retry.
		const overflow = toContextOverflowError(err);
		if (!overflow) {
			const message = state.toolProseAbortReason ?? (err instanceof Error ? err.message : String(err));
			const classification = classifyRecoveryFailure({
				message,
				runtimeId: agentRuntime.runtimeId,
				contextOverflow: false,
				hasAttemptOutput: recoveryAttemptHasOutput(state.runEvidence.attempt()),
				cause: err,
				...(typeof err === "object" && err !== null && "status" in err ? { status: err.status } : {}),
			});
			if (
				isRetryableRecoveryFailure(classification) ||
				classification.kind === "auth" ||
				recovery.waitsOutRateLimit(classification)
			) {
				const failureMessage = {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "error",
					errorMessage: message,
					timestamp: Date.now(),
				} as AgentMessage;
				const handled = await recovery.runTransientRetryChain(
					agentRuntime,
					runtimePromptText,
					{
						stopReason: "error",
						errorMessage: message,
						message: failureMessage,
					},
					undefined,
					classification,
				);
				if (handled) return;
			}
			emitNotice(operatorFacingEngineError(message));
			return;
		}
		await recovery.runCompactAndRetry(agentRuntime, runtimePromptText, overflow, images);
	}
}
