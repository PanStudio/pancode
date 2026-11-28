// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's run settlement: the retries and waits a run's receipt states, the entries an
 * ending run closes, and the receipt the run's last assistant entry carries.
 */

import type { AgentMessage } from "../../engine/types.js";
import type { RetryStatusPayload } from "../../session-control/chat-loop.js";
import {
	classifyTurnEnding,
	endedOnCancelledInterview,
	endedWithFailedChange,
} from "../../session-control/chat-loop-messages.js";
import type { ReplayedRunFacts } from "../chat-panel.js";
import {
	lastAssistantIndex,
	reportsCall,
	runCallIds,
	runStartFallback,
	turnRetryRow,
} from "../chat-transcript-model.js";
import { turnEndedWithWorkers } from "../chat-turn-receipt.js";
import { isGenerationGuardAbort } from "../status/index.js";
import type { ChatPanelScope } from "./scope.js";

export function createChatRunSettle(scope: ChatPanelScope) {
	const { options, transcript, entryRenderCache, runs, workerEntries, liveReceipts, now } = scope;
	const { invalidateEntryCache } = scope.cache;
	const { settleUnfinishedToolSegment, closeOpenThinking } = scope.segments;
	const { trackReceipt } = scope.receipts;
	/** The attempts a retry status says went out again. A live run hears of its recovery after its receipt, a replay before. */
	const noteRunRetries = (status: RetryStatusPayload): void => {
		const whole = status.phase === "retrying" || status.phase === "recovered" || status.phase === "exhausted";
		if (whole || status.phase === "cancelled") {
			// A cancel stopped one attempt before it went out, and that attempt is a wait or a retry by what it answered.
			const waits = status.providerWaits ?? 0;
			const unsentWait = status.phase === "cancelled" && status.onProviderWait === true ? 1 : 0;
			const unsentRetry = status.phase === "cancelled" && status.onProviderWait !== true ? 1 : 0;
			scope.runProviderWaits = Math.max(scope.runProviderWaits, waits - unsentWait);
			scope.runRetries = Math.max(scope.runRetries, status.attempt - waits - unsentRetry);
		}
		const receipt = scope.lastSettledReceipt;
		const usage = receipt?.turnUsage;
		if (
			receipt &&
			usage &&
			(scope.runRetries > (usage.retries ?? 0) || scope.runProviderWaits > (usage.providerWaits ?? 0))
		) {
			invalidateEntryCache(receipt);
			receipt.turnUsage = {
				...usage,
				...(scope.runRetries > 0 ? { retries: scope.runRetries } : {}),
				...(scope.runProviderWaits > 0 ? { providerWaits: scope.runProviderWaits } : {}),
			};
		}
	};

	/**
	 * Nothing the run left open keeps counting: no tool can still be executing anywhere in the transcript, not just in
	 * the tail entry (a mid-turn notice splits entries). Settle any tool segment whose `tool_execution_end` never arrived
	 * (blocked at admission, or cut off by an abort) so the ledger never leaves a running line counting past the turn's
	 * end, and clear `pending` everywhere so no earlier entry keeps rendering live thinking or status.
	 */
	const closeRunEntries = (aborted: boolean): void => {
		for (const entry of transcript) {
			if (entry.role !== "assistant") continue;
			for (const seg of entry.segments) {
				if (seg.kind === "tool" && !seg.finished) {
					invalidateEntryCache(entry);
					settleUnfinishedToolSegment(seg, aborted ? "aborted" : "orphaned");
				}
			}
			if (entry.pending) {
				invalidateEntryCache(entry);
				// A message that settled closed its own reasoning, so this one never got a stop reason.
				closeOpenThinking(entry, false);
				entry.pending = false;
				entry.messageStartSegmentIndex = undefined;
			}
		}
		// An entry opened for a message that never showed anything renders no rows, yet it would still draw a separator.
		for (let tail = transcript.at(-1); tail?.role === "assistant"; tail = transcript.at(-1)) {
			if (tail.turnUsage !== undefined || tail.models?.length) break;
			if (tail.segments.some((segment) => segment.kind !== "text" || segment.text.trim().length > 0)) break;
			transcript.pop();
			entryRenderCache.delete(tail);
			runs.truncate(transcript.length);
		}
	};

	/**
	 * Give the run its one receipt and close it. It touches many entries, but it names every one it touches: the usage
	 * caption's target, the later entries whose caption it removes, and any entry it settles or un-pends. Each is
	 * invalidated at the point of mutation instead of dropping the whole cache and re-rendering settled history.
	 */
	const settleRun = (run: {
		messages: ReadonlyArray<unknown>;
		turnId: string | undefined;
		replayed?: ReplayedRunFacts | undefined;
		/** The outcome when no message states it: the ladder ended between attempts. */
		outcome?: string;
		always?: boolean;
	}): void => {
		scope.lastSettledReceipt = null;
		scope.runAwaitingRetry = false;
		const { messages, turnId, replayed } = run;
		const ending = run.outcome === undefined ? classifyTurnEnding(messages as ReadonlyArray<AgentMessage>) : null;
		// A provider that reports no usage still owes the operator the news that nothing answered.
		if (
			run.always === true ||
			messages.some(reportsCall) ||
			ending?.kind === "no_answer" ||
			ending?.kind === "call_not_run"
		) {
			// The usage line is a caption on rendered output, so it goes on the
			// last entry that rendered any. A mid-turn notice splits entries, and
			// a turn that stops after one leaves an empty tail entry behind: the
			// run total landed there while the entry above kept its own
			// message_end line, so one turn printed the identical line twice, once
			// on each side of the notice. Entries after the caption rendered
			// nothing and must not carry a second copy.
			// Only this run's rows can carry its receipt. A run cut off before any output has none, and the previous
			// turn's receipt is not this turn's to overwrite: it closes under its own prompt, after any retry row.
			const row = turnRetryRow(transcript);
			const from = Math.max(
				scope.runStartIndex ?? runStartFallback(transcript, transcript.length),
				row === null ? 0 : transcript.lastIndexOf(row) + 1,
			);
			const found = lastAssistantIndex(transcript, { withOutput: true, from }) ?? lastAssistantIndex(transcript, { from });
			if (found === null) {
				transcript.push({ role: "assistant", segments: [], pending: false, isError: false });
			}
			const index = found ?? transcript.length - 1;
			const target = transcript[index];
			if (target?.role === "assistant") {
				invalidateEntryCache(target);
				scope.lastSettledReceipt = target;
				const stop = messages.filter((message) => (message as { role?: unknown }).role === "assistant").at(-1) as
					| { stopReason?: string; pancodeAbortReason?: string }
					| undefined;
				// A replayed run end brings the duration and cold reasons the
				// ledger recorded; a live one measures its own.
				const elapsedMs =
					replayed !== undefined
						? replayed.elapsedMs
						: scope.runStartedAt === undefined
							? undefined
							: Math.max(0, now() - scope.runStartedAt);
				const endedAtMs = replayed !== undefined ? replayed.endedAtMs : now();
				const coldReasons = replayed !== undefined ? (replayed.coldReasons ?? []) : scope.runColdReasons;
				const callIds = runCallIds(messages);
				// Workers a turn detached keep running past its end, so the turn ended but the work is not done. A replay
				// counts the ones its ledger and their receipts place still running then.
				const workersRunning =
					replayed === undefined
						? [...workerEntries.values()].filter((entry) => entry.state.pending).length
						: (replayed.workersRunning ?? 0);
				// Their calls are the workers' own: the receipt's count stays what the turn made by its end (ns:49-50).
				const detachedRunIds =
					replayed === undefined
						? [...workerEntries.values()].flatMap((entry) => (entry.state.pending ? [entry.state.runId] : []))
						: (replayed.workerRunIdsRunning ?? []);
				const humanWaitMs = replayed === undefined ? (options.getHumanWaitMs?.() ?? 0) : (replayed.humanWaitMs ?? 0);
				if (replayed === undefined && elapsedMs !== undefined && turnId !== undefined) {
					options.recordTurnTiming?.({ turnId, elapsedMs, ...(humanWaitMs > 0 ? { humanWaitMs } : {}) });
				}
				target.turnUsage = {
					...(turnId === undefined ? {} : { turnId }),
					...(callIds.length > 0 ? { callIds } : {}),
					...(elapsedMs === undefined ? {} : { elapsedMs }),
					...(endedAtMs === undefined ? {} : { endedAtMs }),
					...(replayed !== undefined ? { replayed: true as const } : {}),
					...(detachedRunIds.length > 0 ? { detachedRunIds } : {}),
					...(humanWaitMs > 0 ? { humanWaitMs } : {}),
					...(coldReasons.length > 0 ? { coldReasons: [...coldReasons] } : {}),
					...(scope.runRetries > 0 ? { retries: scope.runRetries } : {}),
					...(scope.runProviderWaits > 0 ? { providerWaits: scope.runProviderWaits } : {}),
					...(scope.runMovedTo !== undefined ? { movedTo: scope.runMovedTo } : {}),
					...(ending === null ? {} : { ending }),
					outcome:
						run.outcome ??
						(stop?.stopReason === "error"
							? "Failed"
							: stop?.stopReason === "aborted"
								? isGenerationGuardAbort(stop.pancodeAbortReason)
									? "Generation stopped"
									: "Cancelled"
								: stop?.stopReason === "length"
									? "Output limit"
									: ending?.kind === "no_answer"
										? "No answer"
										: endedOnCancelledInterview(messages)
											? "Cancelled"
											: endedWithFailedChange(messages)
												? "Done, last change failed"
												: workersRunning > 0
													? turnEndedWithWorkers(workersRunning)
													: "Done"),
				};
				// Only the newest failure is one ↑ away; a later turn's prompt sits in front of an older one.
				if (scope.promptRecallReceipt?.turnUsage) {
					delete scope.promptRecallReceipt.turnUsage.promptRecall;
					invalidateEntryCache(scope.promptRecallReceipt);
				}
				scope.promptRecallReceipt = null;
				if (replayed === undefined && target.turnUsage.outcome === "Failed") {
					target.turnUsage.promptRecall = true;
					scope.promptRecallReceipt = target;
				}
				trackReceipt(target);
			}
			const firstRunEntry = scope.runStartIndex ?? runStartFallback(transcript, index);
			for (let other = firstRunEntry; other < transcript.length; other += 1) {
				if (other === index) continue;
				const sibling = transcript[other];
				if (sibling?.role !== "assistant") continue;
				if (sibling.turnUsage !== undefined) invalidateEntryCache(sibling);
				delete sibling.turnUsage;
				liveReceipts.delete(sibling);
			}
		}
		scope.runStartIndex = undefined;
		scope.runColdReasons = [];
		scope.runTurnId = undefined;
		scope.runRetries = 0;
		scope.runProviderWaits = 0;
		scope.runMovedTo = undefined;
		const runWasAborted = messages.some(
			(message) =>
				message && typeof message === "object" && (message as { stopReason?: unknown }).stopReason === "aborted",
		);
		closeRunEntries(runWasAborted);
		// An attempt cut off by the cancel leaves its row reading as still underway.
		const row = turnRetryRow(transcript);
		if (row && (row.status.phase === "scheduled" || row.status.phase === "waiting" || row.status.phase === "retrying")) {
			if (runWasAborted) {
				invalidateEntryCache(row);
				row.status = { ...row.status, phase: "cancelled" };
			}
		}
	};

	return { noteRunRetries, closeRunEntries, settleRun };
}
