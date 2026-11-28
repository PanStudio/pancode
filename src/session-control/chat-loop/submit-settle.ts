// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { TURN_CONTINUATION_CAP } from "../../core/job-types.js";
import type { PendingSkillToolPolicy } from "../../core/skill-activation.js";
import { reduceTurnOutcome } from "../../lib/turn-control/index.js";
import { finalizeAskUserInterviewForHost } from "../../tools/ask-user.js";
import type { AskUserToolPolicy } from "../../tools/registry-contract.js";
import type { ChatSubmitOptions, StepPipelineEnd } from "../chat-loop.js";
import {
	classifyTurnEnding,
	detectTerminalFailureFromState,
	extractText,
	noticeMessage,
	sumRunUsage,
	terminalFailureFromAssistantMessage,
} from "../chat-loop-messages.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import { lastAssistantText } from "../chat-loop-steering.js";
import { lastToolCallOf } from "../continuation-tool-call.js";
import type { SubmitEvidence } from "../run-evidence.js";
import { type StepRun, stepTurnOutcome } from "../step-start.js";
import type { ChatLoopSubmitState } from "../turn-state.js";
import { type AgentRuntime, clearActiveInterrupt, takeInterruptedCall } from "../turn-state.js";
import { noOutcomeUsage } from "../worker-receipts.js";
import { isRedirectReason, type SubmitTurn } from "./submit-turn.js";

export function stepPipelineEnd(
	policy: { stepTool: string; template?: string },
	run: StepRun,
	capSpent: boolean,
	settledCleanly: boolean,
	ended: "cancel" | "failure" | null,
): StepPipelineEnd {
	// A cancel or a failure is what ended the pipeline, at the cap or below it.
	const stoppedBy =
		ended !== null
			? ended
			: !capSpent
				? ("turn" as const)
				: run.carried === true && settledCleanly
					? ("unreported" as const)
					: ("cap" as const);
	return {
		stepTool: policy.stepTool,
		...(policy.template === undefined ? {} : { template: policy.template }),
		done: run.pipelineDone,
		...(run.pipelineDone ? {} : { stoppedBy }),
	};
}

/** What `submit` hands its settlement: the turn's admission facts, fixed once its prompt has run. */
export interface SubmitSettleInput {
	options: ChatSubmitOptions;
	owner: AbortController | null;
	generation: number;
	admissionCurrent: () => boolean;
	submittedAt: number;
	agentRuntime: AgentRuntime;
	askUserPolicy: AskUserToolPolicy | undefined;
	userTurnId: string | null;
	turnIndex: number;
	priorPendingSkillPolicy: PendingSkillToolPolicy | undefined;
	priorAskUserPolicy: AskUserToolPolicy | undefined;
	pendingSkillPolicy: PendingSkillToolPolicy | undefined;
	skillsLoadedBeforeTurn: Set<string>;
	evidence: SubmitEvidence;
}

/**
 * Settles one submitted turn on every exit path of its prompt run: the interrupt notice, the turn outcome, the
 * machine turn's result, the step pipeline and any continuation. Resolves true when a newer submit superseded
 * this one part way; `submit` then returns from its finally, so a superseded submit's error still belongs to a
 * turn nobody owns now.
 */
export async function settleSubmittedTurn(
	loop: ChatLoopScope,
	state: ChatLoopSubmitState,
	turn: SubmitTurn,
	input: SubmitSettleInput,
): Promise<boolean> {
	const {
		armSkillSurface,
		context,
		continueStoppedTurn,
		currentToolInvokeOptions,
		currentTurnFailure,
		deps,
		emit,
		emitNotice,
		outcomeCollector,
		persistence,
		queues,
		recordStepPipelineSettled,
		recovery,
		stepPipeline,
		stepStarts,
		workerReceipts,
		writeTurnOutcome,
		yoloContinuationDue,
	} = loop;
	const {
		options,
		owner,
		generation,
		admissionCurrent,
		submittedAt,
		agentRuntime,
		askUserPolicy,
		userTurnId,
		turnIndex,
		priorPendingSkillPolicy,
		priorAskUserPolicy,
		pendingSkillPolicy,
		skillsLoadedBeforeTurn,
		evidence,
	} = input;
	const overtaken = state.routeMove;
	state.routeMove = null;
	state.routeMoveSeat = false;
	loop.moveForeground = null;
	if (overtaken !== null) {
		state.streamStallReason = null;
		// The stop lost the race to the reply it was stopping, and that reply is the one on screen.
		if (generation === loop.submitGeneration && state.activeInterruptReason === null && !owner?.signal.aborted)
			emitNotice(
				`The answer arrived before the request could move, so ${overtaken.wireModelId} takes over from the next turn.`,
				"info",
				"route-move.overtaken",
			);
	}
	recovery.settleOpenForecast();
	const canceled = state.activeInterruptReason !== null && state.activeInterruptByOperator;
	const autonomyStopped = state.activeInterruptReason !== null && state.activeInterruptByAutonomy;
	const jobClockStopped = state.activeInterruptReason !== null && state.activeInterruptByJobClock;
	// Esc on an interview resolves it as cancelled and the tool ends the turn
	// itself, so no interrupt is raised and `canceled` stays false. The turn
	// still ended on the operator's say-so, which the outcome has to show.
	const interviewDismissed = askUserPolicy?.status === "cancelled";
	turn.releaseForeground();
	deps.autonomy?.turnSettled();
	if (generation !== loop.submitGeneration) return true;
	if (askUserPolicy) {
		try {
			await finalizeAskUserInterviewForHost(
				askUserPolicy,
				"turn_finished",
				currentToolInvokeOptions(),
				deps.onAskUserFinalized,
			);
		} catch (error) {
			emitNotice(
				`[PanCode] interview decisions could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
				`decision-ledger:${askUserPolicy.id}`,
			);
		}
	}
	if (generation !== loop.submitGeneration) return true;
	// Only a submit that still owns this generation hands its interview on, so a turn superseded while the
	// decisions persisted never answers another session's continuation (C-25).
	if (askUserPolicy?.status === "complete" && askUserPolicy.rounds.length > 0) loop.promptInterview = askUserPolicy;
	// A turn that ended without its turn_end hook (a throw or an abort before any reply) ended here, while this
	// submit still owns the stream and its lease: a resubmit below can take ownership and return before its turn_start.
	if (turn.promptStarted && loop.submitOwner === owner) outcomeCollector.endTurn();
	state.streaming = false;
	// A run that ended without reaching its tool boundary has nothing left to stop.
	loop.boundaryStop = null;
	if (state.activeInterruptReason !== null) {
		const reason = state.activeInterruptReason;
		state.activeInterruptReason = null;
		// A partial response already closed with the cancellation reason.
		// Only a hollow abort needs a synthetic assistant, after all tool
		// results have landed. Publish its notice after settlement too, so
		// it cannot split the entry the provider's message_end finalizes.
		if (state.interruptedAssistantMessage === null) {
			const closing = noticeMessage(reason);
			const interrupted = takeInterruptedCall(state);
			if (interrupted !== null) {
				Object.assign(closing, interrupted.message, noticeMessage(reason));
				delete (closing as { errorMessage?: string }).errorMessage;
			}
			persistence.appendAssistantTurn(closing, interrupted?.timing, undefined, {
				operatorCancel: state.activeInterruptByOperator,
			});
			emit({
				type: "notice",
				level: "warning",
				surface: "transcript",
				text: reason,
				key: "turn.interrupted",
				...(state.activeInterruptByOperator ? { operatorCancel: true as const } : {}),
				...(isRedirectReason(reason) || (loop.budgetRoll !== null && !state.activeInterruptByOperator)
					? { redirect: true as const }
					: {}),
			});
		}
		state.interruptedAssistantMessage = null;
		state.interruptedCall = null;
		clearActiveInterrupt(state);
	}
	// A continuation writes its outcome too: the streak that gates the next
	// turn's direction workflow resets on a turn that used a tool, and a
	// continuation is exactly where an answered interview does. Without its
	// row the streak stayed at the operator turn's value, in memory and on
	// resume.
	if (userTurnId !== null && deps.session?.current()) {
		try {
			const continuation = options.requestContinuation === true;
			const collected = outcomeCollector.take(userTurnId, state.activeUserTurnId);
			const finalMessage = [...agentRuntime.agent.state.messages]
				.reverse()
				.find((message) => message.role === "assistant");
			const finalEntry = deps.readSessionEntries?.().find((entry) => entry.turnId === state.lastTurnId);
			const finalPayload =
				finalEntry?.kind === "message" && finalEntry.role === "assistant"
					? (finalEntry.payload as { text?: unknown; stopReason?: unknown })
					: undefined;
			const finalAssistantText =
				typeof finalPayload?.text === "string" ? finalPayload.text : finalMessage ? extractText(finalMessage) : "";
			const workerRunIds = [...collected.dispatches.flatMap((item) => item.runIds), ...collected.harness.runIds];
			const missingReceipts = canceled ? await workerReceipts.awaitSeal(workerRunIds) : [];
			if (generation !== loop.submitGeneration) return true;
			const failure = terminalFailureFromAssistantMessage(finalMessage)?.failure ?? currentTurnFailure();
			const record = reduceTurnOutcome({
				...collected,
				turnId: userTurnId,
				turnIndex,
				continuation,
				finalAssistantText,
				taskEstablished: deps.getTaskEstablished?.() ?? false,
				canceled,
				interviewDismissed,
				...(failure ? { failure: { ...failure, retryAttempts: loop.turnRetryAttempts + loop.providerRetryAttempts } } : {}),
				tokens: {
					coordinator: persistence.turnUsage(userTurnId) ?? noOutcomeUsage(),
					workers: workerReceipts.usage(workerRunIds),
				},
				stopReason:
					typeof finalPayload?.stopReason === "string"
						? finalPayload.stopReason
						: typeof finalMessage?.stopReason === "string"
							? finalMessage.stopReason
							: canceled
								? "aborted"
								: "error",
				durationMs: Math.max(0, performance.now() - submittedAt),
			});
			// The reading every surface fails the run on, so why-stopped names it too (bt-session-res J1).
			const ending = canceled ? null : classifyTurnEnding(agentRuntime.agent.state.messages);
			await writeTurnOutcome(record, {
				stopReason: record.stopReason,
				retries: loop.turnRetryAttempts + loop.providerRetryAttempts,
				// The post-tool guard stops between calls, so no call carries its cause; the ledger reply does (CLI-3).
				// A loop-guard or turn-budget-roll stop is the guard's, read off the owner it aborted (C-10).
				cause: canceled
					? "operator_cancel"
					: autonomyStopped
						? "autonomy_stop"
						: jobClockStopped
							? "job_clock"
							: owner !== null && owner === loop.guardStoppedOwner
								? "loop_guard"
								: failure?.stage === "harness" && failure.errorClass === "oversized_tool_result"
									? "oversized_tool_result"
									: undefined,
				noAnswer: ending?.kind === "no_answer" ? ending.cause : undefined,
				runIds: workerRunIds,
				missing: missingReceipts,
			});
			// A continuation extends the operator turn it followed, so the gap the
			// next operator message reports runs from the end of the whole chain.
		} catch {
			// Measurement must not change turn settlement when a ledger or receipt is unavailable.
		}
	}
	state.currentPendingSkillPolicy = priorPendingSkillPolicy;
	state.currentAskUserPolicy = priorAskUserPolicy;
	armSkillSurface(pendingSkillPolicy, skillsLoadedBeforeTurn);
	// Safety net for thrown paths where agent_end never delivered;
	// no-op when the agent_end flush already ran.
	context.flushReconciledSnapshot();
	// The guard, not a person and not a newer submit, aborted this owner.
	const guardStopped =
		owner !== null &&
		owner === loop.guardStoppedOwner &&
		loop.submitOwner === owner &&
		!loop.disposed &&
		options.isAdmissionCurrent?.() !== false;
	// Runs on every exit path (normal settle, catch-arm returns) so
	// a steer the engine never drained still reaches the model.
	if (options.machineTurn !== undefined) {
		const messages = evidence.messages();
		const finalMessage = [...messages].reverse().find((message) => message.role === "assistant");
		const failure = detectTerminalFailureFromState(agentRuntime.agent);
		const usage = sumRunUsage(messages);
		// An exhausted ladder prunes its failure, so an earlier round's text must not read as success (#445).
		const stop = state.continuation.stop as { reason: string; retryAfterMs?: number } | null;
		// A failure stop outranks a budget crossing in the same turn, so a failing turn cannot escape the cap on one.
		const guardStop =
			stop !== null
				? undefined
				: guardStopped || state.synthesisToolLock
					? "loop_guard"
					: state.toolBudgetLock
						? "tool_budget"
						: undefined;
		options.machineTurn.onSettled({
			status:
				(!admissionCurrent() && !guardStopped) || canceled || interviewDismissed
					? "canceled"
					: failure || stop || guardStopped || !finalMessage
						? "failed"
						: "succeeded",
			turnId: userTurnId,
			...(failure || stop ? { reason: failure?.errorMessage ?? stop?.reason ?? "" } : {}),
			...(guardStop === undefined ? {} : { stoppedBy: guardStop }),
			...(stop?.retryAfterMs === undefined ? {} : { retryAfterMs: stop.retryAfterMs }),
			...(finalMessage ? { text: extractText(finalMessage) } : {}),
			usage: { tokens: usage.totals.totalTokens, cost: usage.cost },
		});
	}
	state.activeUserTurnId = null;
	const guardFailure = loop.loopGuardFailure;
	loop.loopGuardFailure = null;
	const stepStop = loop.stepPolicyStop;
	loop.stepPolicyStop = null;
	const stepPolicy = state.currentTurnConstraints?.turnPolicy;
	loop.stepTurnScope = null;
	const stepRun = stepPipeline.settle(
		stepPolicy?.stepTool,
		stepPolicy ? stepTurnOutcome(evidence.messages(), stepPolicy.stepTool) : null,
		options.yoloContinuation === true,
		userTurnId,
	);
	// Only a step turn that ended on its own text, or that its step policy ended, leaves a state summary
	// the next step can start from. A failed turn, a loop-guard stop or a real budget crossing stopped
	// mid-step, so its continuation keeps the full history (WTF-P 0.8.3 C5).
	// A submit a session reset superseded settles nothing: the chain now belongs to the new session.
	if (generation === loop.submitGeneration)
		stepStarts.settle(
			state.currentTurnConstraints,
			lastAssistantText(evidence.messages()),
			!canceled &&
				!interviewDismissed &&
				state.continuation.stop === null &&
				!guardStopped &&
				!state.synthesisToolLock &&
				(!state.toolBudgetLock || stepStop !== null) &&
				detectTerminalFailureFromState(agentRuntime.agent) === null,
			{ sessionId: deps.session?.current()?.id ?? null, leafTurnId: state.lastTurnId },
			userTurnId,
		);
	const continuation =
		options.machineTurn === undefined && !canceled && !interviewDismissed && (admissionCurrent() || guardStopped)
			? yoloContinuationDue(guardStopped, guardFailure, stepStop, stepRun)
			: null;
	loop.budgetRoll = null;
	if (options.machineTurn === undefined && generation === loop.submitGeneration && continuation === null) {
		const capSpent = state.continuation.yoloContinuations >= TURN_CONTINUATION_CAP;
		// A last turn that made no step call and ended on its own summary did not stop mid-pipeline (N1).
		const settledCleanly =
			!canceled &&
			!interviewDismissed &&
			state.continuation.stop === null &&
			!guardStopped &&
			!state.synthesisToolLock &&
			!state.toolBudgetLock;
		loop.lastStepPipeline =
			stepPolicy && stepRun !== null
				? stepPipelineEnd(
						stepPolicy,
						stepRun,
						capSpent,
						settledCleanly,
						canceled ? "cancel" : detectTerminalFailureFromState(agentRuntime.agent) !== null ? "failure" : null,
					)
				: null;
		const named = loop.lastStepPipeline?.template ? `prompt template ${loop.lastStepPipeline.template}` : "this template";
		if (loop.lastStepPipeline?.stoppedBy === "cap")
			emitNotice(
				`The step pipeline of ${named} stopped at the continuation cap (${TURN_CONTINUATION_CAP}) with a step still running, before ${loop.lastStepPipeline.stepTool} said it was done.`,
				"warning",
				"step.incomplete",
			);
		else if (loop.lastStepPipeline?.stoppedBy === "unreported")
			emitNotice(
				`The step pipeline of ${named} ended on a turn that made no ${loop.lastStepPipeline.stepTool} call; the step tool never reported pipelineDone, so whether every step ran is not known.`,
				"info",
				"step.unreported",
			);
		if (loop.lastStepPipeline !== null && userTurnId !== null)
			await recordStepPipelineSettled(userTurnId, loop.lastStepPipeline);
	}
	if (
		!loop.disposed &&
		generation === loop.submitGeneration &&
		options.machineTurn === undefined &&
		!(await queues.resubmitStranded())
	) {
		if (state.continuation.requested) await queues.resubmitRequestContinuation();
		else if (continuation !== null) {
			// Read before the resubmit appends anything: the stopped turn's own last call.
			const lastToolCall = lastToolCallOf(evidence.messages());
			await continueStoppedTurn(continuation, generation, options.constraints, lastToolCall, userTurnId);
		}
	}
	return false;
}
