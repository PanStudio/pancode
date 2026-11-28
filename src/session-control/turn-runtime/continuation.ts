// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * An agent build's continuation hooks: what lands between a tool batch and the next request of the same run (host
 * inserts, a required-tool reminder, an in-run continuation, the post-tool guard), and whether the run's turn ends or
 * carries on at finishTurn.
 */

import { performance } from "node:perf_hooks";
import { ToolNames } from "../../core/tool-names.js";
import type { HostInsertSource } from "../../domains/session/entries.js";
import type { AgentMessage } from "../../engine/types.js";
import { FINISH_DECLARATION_REMINDER, finishRoundDue } from "../../tools/finish.js";
import {
	claimToolMarkupReprompt,
	classifyTurnEnding,
	endedOnCancelledInterview,
	hasStructuredToolCall,
	noAnswerReprompt,
	rebaseToolMarkupReprompt,
	type ToolMarkupRepromptBudget,
} from "../chat-loop-messages.js";
import { withSettledHistory } from "../message-list-digest.js";
import { OVERSIZED_RESULT_STOP } from "../turn-context.js";
import type { AgentRuntime } from "../turn-state.js";
import type { AgentBuildScope } from "./scope.js";

type AgentHook<K extends "prepareNextTurnWithContext" | "finishTurn"> = NonNullable<AgentRuntime["agent"][K]>;

export function createContinuation(scope: AgentBuildScope) {
	const { deps, state, context, persistence, middleware, middlewareToolChoice } = scope.rt;

	const prepareNextTurnWithContext: AgentHook<"prepareNextTurnWithContext"> = async (
		_completed,
		signal?: AbortSignal,
	) => {
		scope.stallSuspendDepth += 1;
		scope.guardStopCause = null;
		// Host messages queued during the tool batch (X6). Taken now, so a cancel, a throw or an early return below
		// drops them unrecorded; they enter the ledger only where they enter the outgoing context.
		const hostMessages = deps.queueHandOver?.takeHostMessages?.() ?? [];
		try {
			if (!scope.currentRun() || signal?.aborted || state.activeInterruptReason !== null) return undefined;
			if (deps.hasQueuedSteering?.()) await deps.continuity?.pause();
			const handoffChanged = (await deps.continuity?.settle(signal)) ?? false;
			if (!scope.currentRun() || signal?.aborted || state.activeInterruptReason !== null) return undefined;
			const continued = await deliverInRunContinuation(signal);
			const requirementChanged = scope.requiredToolReminder !== null;
			if (scope.requiredToolReminder !== null) {
				// Context-only host tails preserve task authority and the cached prefix (#423).
				pushHostInsert("required-tool", { role: "user", content: scope.requiredToolReminder, timestamp: Date.now() });
				scope.requiredToolReminder = null;
			}
			const contextChanged =
				(await middleware.prepareToolContinuation(scope.localRuntime, signal)) ||
				handoffChanged ||
				continued ||
				requirementChanged;
			// Retracting or installing only replaces or appends messages, so the install's publications read the history the
			// guard's last publication checked: the guard runs it in that settled stretch (SC-6).
			let restored = false as boolean;
			const update = await context
				.postToolContinuationGuard(scope.localRuntime, signal, contextChanged, () => {
					if (!scope.currentRun() || signal?.aborted || state.activeInterruptReason !== null) return;
					restored = withSettledHistory(() => context.installMemoryRestoration(scope.localRuntime));
				})
				.catch((error: unknown) => {
					// PanCode's guard, not the route, ended the turn (CLI-3).
					if (error instanceof Error && error.name === OVERSIZED_RESULT_STOP) scope.guardStopCause = "oversized_tool_result";
					throw error;
				});
			if (!scope.currentRun() || signal?.aborted || state.activeInterruptReason !== null) return undefined;
			// A tool hook changed a pinned block, or the guard's compaction dropped one: it rides the next request.
			const pinned = context.appendPinnedContext(scope.localRuntime);
			// Last, nearest the next request, and recorded as they are pushed, so a rebuild replays the order sent.
			for (const host of hostMessages)
				pushHostInsert(
					host.source,
					{ role: "user", content: host.text, timestamp: Date.now() },
					host.rule !== undefined ? { rule: host.rule } : undefined,
				);
			const tail = pinned || hostMessages.length > 0;
			// Preparation can be long (compaction). A message typed during it is
			// handed over now so Pi's poll right after this hook takes it.
			deps.queueHandOver?.afterPrepareNextTurn();
			// Compaction owns any replacement snapshot. Without one, publish the
			// already-accounted reminder through context, not message events that
			// would manufacture a new operator turn and reset task authority.
			const messages = {
				messages: [...scope.localRuntime.agent.state.messages],
				tools: [...scope.localRuntime.agent.state.tools],
			};
			if (!restored && update !== undefined) return tail ? { ...update, context: messages } : update;
			return contextChanged || restored || tail ? { context: messages } : undefined;
		} finally {
			scope.stallSuspendDepth -= 1;
			scope.lastActivityAt = performance.now();
		}
	};

	// The run's final turn is where turn_end fires, so a middleware
	// request_continuation (stalled turn, open tasks, finish contract,
	// detached batches, skill wait) carries the run on inside it instead of
	// resubmitting a fresh prompt after the turn rendered Done, which showed
	// the operator two completions for one request. agent_end fires turn_end
	// only for a final message this hook never saw: an engine that does not
	// call finishTurn, or its thrown-failure path.
	const finishTurn: AgentHook<"finishTurn"> = async (turn) => {
		// The tool batch has settled and no request has left for the next round.
		if (scope.currentRun() && deps.stopAtToolBoundary?.() === true) return { action: "end" };
		// A tool batch that did not terminate, or an operator message already
		// queued, carries the run on: this is not its final turn.
		const final = !hasStructuredToolCall(turn.message) || scope.pendingTerminalToolResult !== null;
		// Operator messages waiting in PanCode's queue reach the engine here, after
		// the tool batch and before Pi's steering poll, so the check below sees
		// them and the run carries on with them instead of ending around them.
		// An errored or aborted turn hands nothing over; the settle path decides.
		if (
			turn.message.stopReason !== "error" &&
			turn.message.stopReason !== "aborted" &&
			state.activeInterruptReason === null
		) {
			deps.queueHandOver?.atFinishTurn(final);
		}
		// A declared turn still settles before a queued message carries the run on: its terminal row, turn_end and seal
		// belong to it, and the returns after turn_end below hand the queue over (FX-38).
		if (!final || (scope.localRuntime.agent.hasQueuedMessages?.() === true && state.turnCompletion === null))
			return undefined;
		// `finish` is turn-terminal (fleet design 4.3, FX-38): a required tool still pending after a declared completion
		// asks for nothing more.
		if (state.turnCompletion !== null) scope.requiredToolReminder = null;
		if (scope.requiredToolReminder !== null && scope.currentRun() && state.activeInterruptReason === null) {
			return { action: "continue" };
		}
		// A call the model only wrote out never ran, and an empty reply answered nothing. One more round through normal
		// admission lets it make the call or answer, and PanCode never parses or runs the markup itself. A guard's lock
		// already told it tools are off, and an interview the operator dismissed is theirs to follow up.
		const reprompt =
			turn.message.stopReason === "stop" &&
			!endedOnCancelledInterview(scope.localRuntime.agent.state.messages.filter((message) => message !== turn.message))
				? noAnswerReprompt(classifyTurnEnding([turn.message]), state.turnCallsDone)
				: null;
		const repromptBudget: ToolMarkupRepromptBudget | null =
			reprompt !== null &&
			scope.currentRun() &&
			state.activeInterruptReason === null &&
			!state.synthesisToolLock &&
			!state.toolBudgetLock &&
			state.activeUserTurnId !== null
				? claimToolMarkupReprompt(state.toolMarkupReprompt, state.activeUserTurnId, state.turnToolCalls)
				: null;
		if (repromptBudget !== null && reprompt !== null) {
			state.toolMarkupReprompt = repromptBudget;
			scope.requiredToolReminder = reprompt.reminder;
			deps.emitNotice(reprompt.notice, "warning", reprompt.noticeKey);
			return { action: "continue" };
		}
		const terminal = scope.pendingTerminalToolResult;
		scope.pendingTerminalToolResult = null;
		if (terminal) persistence.appendTerminalToolAssistantTurn(terminal);
		context.flushReconciledSnapshot();
		scope.turnEndFiredFor = turn.message;
		scope.stallSuspendDepth += 1;
		// Fleet design 4.3: an unattended turn that did work and ended undeclared gets one round pinned to finish. A
		// zero-tool turn the stalled-turn nudge flags counts as work there, the nudge yielding to it (memory design MD14).
		const finishRoundFor = (calledWork: boolean): boolean =>
			finishRoundDue({
				headless: deps.headless === true,
				origin: state.currentTurnOrigin?.origin,
				promptOrigin: state.promptOrigin,
				declared: state.turnCompletion !== null,
				calledWork,
				spent: state.finishRoundSpent,
				toolsLocked: state.synthesisToolLock || state.toolBudgetLock,
				endedOnTerminalTool: terminal !== null,
				finishAttached: scope.localRuntime.agent.state.tools.some((tool) => tool.name === ToolNames.Finish),
			});
		let stalledYield = false;
		try {
			stalledYield = await middleware.fireTurnEnd(
				scope.localRuntime,
				scope.localRuntime.agent.state.messages,
				terminal ?? undefined,
				() => finishRoundFor(true),
			);
		} finally {
			scope.stallSuspendDepth -= 1;
			scope.lastActivityAt = performance.now();
		}
		if (!scope.currentRun() || state.activeInterruptReason !== null) return undefined;
		if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return undefined;
		// `finish` is turn-terminal (fleet design 4.3): a declared turn takes no further round, whatever asked.
		if (state.turnCompletion !== null) return undefined;
		if (!state.continuation.requested) {
			if (!finishRoundFor(state.turnCalledWork || stalledYield)) return undefined;
			state.finishRoundSpent = true;
			middlewareToolChoice.apply([{ kind: "require_tool", toolName: ToolNames.Finish }]);
			scope.requiredToolReminder = FINISH_DECLARATION_REMINDER;
			return { action: "continue" };
		}
		state.continuation.carryIntoRun();
		return { action: "continue" };
	};
	// What the post-settle resubmit did between runs, done inside this one:
	// a fresh per-turn tool count, the turn controller's collection, a
	// turn_start marked as a continuation, and the buffered continuation
	// reminders as model-only context.
	const pushHostInsert = (source: HostInsertSource, message: AgentMessage, options?: { rule: string }): void => {
		if (deps.hostInserts) deps.hostInserts.insert(scope.localRuntime, source, [message], options);
		else scope.localRuntime.agent.state.messages.push(message);
	};
	const deliverInRunContinuation = async (signal?: AbortSignal): Promise<boolean> => {
		if (!state.continuation.takeInRun()) return false;
		state.turnToolCalls = 0;
		state.toolMarkupReprompt = rebaseToolMarkupReprompt(state.toolMarkupReprompt);
		state.turnToolNames = [];
		state.turnCallsDone = [];
		state.turnCollectedDetachedBatch = false;
		middlewareToolChoice.reset();
		let block: string | null = null;
		try {
			block = (await deps.prepareInRunContinuation?.(signal)) ?? null;
		} catch {
			// Collection is best effort; the continuation reminder still goes out.
		}
		if (!scope.currentRun() || signal?.aborted || state.activeInterruptReason !== null) return false;
		middleware.fireTurnStart(scope.localRuntime, "", 0, true);
		// The reminder block leads: only a block opening the message is host
		// framing, and the orientation block quotes scout findings.
		// Buffered reminders wait for the next unlocked request: they may ask for a tool.
		const locked = state.synthesisToolLock || state.toolBudgetLock;
		const content = [locked ? "" : middleware.flushPendingReminders(), block]
			.filter((part): part is string => part !== null && part.length > 0)
			.join("\n\n");
		if (content.length === 0) return false;
		pushHostInsert("continuation", { role: "user", content, timestamp: Date.now() });
		persistence.appendInRunContinuation();
		return true;
	};

	return { prepareNextTurnWithContext, finishTurn };
}
