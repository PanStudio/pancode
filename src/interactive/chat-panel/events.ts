// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's event intake: each chat loop event applied to the transcript, from a run's
 * start through its streamed text, thinking and tool calls to its settlement.
 */

import { assistantMessageNeverSent, assistantModelLabel } from "../../core/assistant-model.js";
import { isNarrationSummary } from "../../core/narration-summary.js";
import { wrapTextWithAnsi } from "../../engine/tui.js";
import { holdCutOffText, holdUnresolvedStrings, messageStopCompleted } from "../../lib/secrets/redaction.js";
import type { ChatLoopEvent } from "../../session-control/chat-loop.js";
import { proseBeforeWrittenCalls } from "../../session-control/chat-loop-messages.js";
import type { ReplayedRunFacts } from "../chat-panel.js";
import {
	assistantThinkingRedacted,
	detachUnsentModel,
	extractAssistantTerminalError,
	extractAssistantText,
	extractAssistantThinking,
	findToolSegmentOwner,
	replaceSegmentText,
	reportsCall,
	scopeTerminalErrorAfterSuccessfulTool,
	turnRetryRow,
} from "../chat-transcript-model.js";
import { renderNoticeRow, renderTranscriptNotice } from "../renderers/notice.js";
import { readProviderFailureRoute } from "../renderers/provider-error.js";
import { renderSkillSurfaceRow } from "../renderers/skill-rows.js";
import { modelNickname } from "../theme/labels.js";
import type { ChatPanelScope } from "./scope.js";

export function createChatEvents(scope: ChatPanelScope) {
	const { transcript, liveReceipts, now, stamp, messageTarget } = scope;
	const { markDirty, invalidateEntryCache } = scope.cache;
	const { trackReceipt } = scope.receipts;
	const {
		startEditPreview,
		appendRow,
		ensureAssistant,
		closeOpenThinking,
		appendTextDelta,
		replaceTextFrame,
		appendThinkingDelta,
		attachModel,
		canonicalizeMessageText,
		appendErrorSegment,
	} = scope.segments;
	const { onToolExecutionStart, onToolApprovalState, onToolExecutionUpdate, onToolExecutionEnd } = scope.toolEvents;
	const { noteRunRetries, closeRunEntries, settleRun } = scope.runSettle;

	const applyEvent = (event: ChatLoopEvent): void => {
		if (event.type === "agent_start") {
			scope.lastSettledReceipt = null;
			// A retry's attempt continues the run it retries: same receipt, same clock.
			if (scope.runAwaitingRetry) {
				scope.runAwaitingRetry = false;
				return;
			}
			scope.runRetries = 0;
			scope.runProviderWaits = 0;
			scope.runMovedTo = undefined;
			// The run's cold-cache reasons arrive just before it starts, as the
			// chat loop consumes them ahead of the prompt, so they are kept here
			// and cleared once the run's receipt has stated them.
			const prompt = scope.pendingPrompt;
			scope.pendingPrompt = undefined;
			scope.runStartedAt = prompt !== undefined && prompt.status?.() !== "refused" ? prompt.at : now();
			scope.runStartIndex = transcript.length;
			scope.runTurnId = (event as { turnId?: string }).turnId;
			return;
		}
		if (event.type === "agent_status") {
			return;
		}
		if (event.type === "notice") {
			// The cache notice lives in the footer; the run keeps its reasons
			// for the Detailed receipt.
			if (event.coldReasons !== undefined) scope.runColdReasons = [...event.coldReasons];
			// Transcript notices are first-class advisory blocks, not assistant
			// messages: a level mark in the gutter, the text hanging beside it,
			// exactly as replay renders the persisted ones.
			if (event.surface !== "transcript") return;
			// A change to the armed skill surface is a `§` state row; a load that
			// narrowed nothing already has its own row and adds none.
			const skillSurface = event.skillSurface;
			if (skillSurface !== undefined) {
				if (skillSurface.state === "loaded") return;
				appendRow({
					role: "replayBlock",
					renderBlock: (width) => renderSkillSurfaceRow(skillSurface, width),
					at: stamp(),
				});
				markDirty();
				return;
			}
			// The Esc cancel is reported once. A settled run that already carries the
			// Cancelled outcome has said so; the row below is only for a hollow abort
			// that left no receipt to carry it.
			if (event.operatorCancel === true && scope.lastSettledReceipt?.turnUsage?.outcome === "Cancelled") return;
			const text = event.text;
			const mark = event.operatorCancel === true ? "cancelled" : event.level;
			const source = event.source;
			// The answer to a command the operator typed wraps whole, as command output does.
			const commandReply = event.commandReply === true && source === undefined;
			appendRow({
				role: "replayBlock",
				renderBlock: (width, _detail, unbounded) =>
					commandReply
						? renderNoticeRow(text, mark, width)
						: renderTranscriptNotice(text, mark, width, source, unbounded === true),
				at: stamp(),
			});
			markDirty();
			return;
		}
		if (event.type === "queued_user_turn") {
			// A queued steer or follow-up the engine just injected. Rendering it
			// here, at injection time, keeps the transcript in the order the
			// model saw: enqueue time shows the text only in the queue panel.
			transcript.push({
				role: "user",
				text: event.display?.text ?? event.text,
				at: stamp(),
				...(event.origin !== undefined ? { origin: event.origin } : {}),
			});
			const note = event.display?.note;
			if (note !== undefined && note !== event.origin) {
				transcript.push({
					role: "replayBlock",
					renderBlock: (width) => wrapTextWithAnsi(`  ${note}`, width),
					at: stamp(),
				});
			}
			markDirty();
			return;
		}
		if (event.type === "message_update") {
			const assistantEvent = event.assistantMessageEvent as {
				type?: unknown;
				contentIndex?: unknown;
				partial?: { content?: unknown };
			};
			if (
				assistantEvent.type !== "toolcall_start" &&
				assistantEvent.type !== "toolcall_delta" &&
				assistantEvent.type !== "toolcall_end"
			) {
				return;
			}
			const index = typeof assistantEvent.contentIndex === "number" ? assistantEvent.contentIndex : -1;
			const content = Array.isArray(assistantEvent.partial?.content) ? assistantEvent.partial.content : [];
			const block = content[index];
			if (block === null || typeof block !== "object" || Array.isArray(block)) return;
			const streamed = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
			if (streamed.type !== "toolCall" || typeof streamed.id !== "string" || streamed.id.length === 0) return;
			const owner = findToolSegmentOwner(transcript, streamed.id);
			const existing = owner?.segment;
			if (existing && !existing.finished && !existing.executionStarted) {
				if (owner) invalidateEntryCache(owner.entry);
				existing.name = typeof streamed.name === "string" && streamed.name.length > 0 ? streamed.name : existing.name;
				existing.args = streamed.arguments ?? existing.args;
				existing.argsComplete = assistantEvent.type === "toolcall_end";
				if (existing.argsComplete) startEditPreview(existing);
			} else if (existing === undefined) {
				const assistant = ensureAssistant();
				assistant.pending = true;
				closeOpenThinking(assistant);
				assistant.segments.push({
					kind: "tool",
					id: streamed.id,
					name: typeof streamed.name === "string" && streamed.name.length > 0 ? streamed.name : "tool",
					args: streamed.arguments ?? {},
					at: stamp(),
					finished: false,
					executionStarted: false,
					argsComplete: assistantEvent.type === "toolcall_end",
					isError: false,
				});
			}
			markDirty();
			return;
		}
		if (event.type === "text_delta") {
			const assistant = ensureAssistant();
			assistant.pending = true;
			appendTextDelta(assistant, event.delta);
			markDirty();
			return;
		}
		if (event.type === "text_frame") {
			const assistant = ensureAssistant();
			assistant.pending = true;
			replaceTextFrame(assistant, event.text, event.progress);
			markDirty();
			return;
		}
		if (event.type === "thinking_delta") {
			// The text itself is never rendered unless the operator expands it;
			// the segment is what keeps reasoning in its place in the stream.
			const assistant = ensureAssistant();
			assistant.pending = true;
			appendThinkingDelta(assistant, event.delta);
			markDirty();
			return;
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			const assistant = ensureAssistant();
			assistant.pending = true;
			const respondedModel = (event.message as { model?: unknown }).model;
			if (typeof respondedModel === "string" && respondedModel.length > 0)
				scope.requestingModel = modelNickname(respondedModel);
			const model = assistantModelLabel(event.message, messageTarget());
			assistant.messageStartModel = attachModel(assistant, model) && model !== null ? model : undefined;
			assistant.messageStartSegmentIndex = assistant.segments.length;
			markDirty();
			return;
		}
		if (event.type === "tool_execution_start") {
			onToolExecutionStart(event);
			return;
		}
		if (event.type === "tool_approval_state") {
			onToolApprovalState(event);
			return;
		}
		if (event.type === "tool_execution_update") {
			onToolExecutionUpdate(event);
			return;
		}
		if (event.type === "tool_execution_end") {
			onToolExecutionEnd(event);
			return;
		}
		if (event.type === "message_end") {
			const current = transcript[transcript.length - 1];
			let completedStreamedArgs = false;
			if (current?.role === "assistant") {
				for (const segment of current.segments) {
					if (segment.kind !== "tool" || segment.finished || segment.executionStarted || segment.argsComplete) continue;
					if (!messageStopCompleted((event.message as { stopReason?: unknown }).stopReason)) {
						segment.args = holdUnresolvedStrings(segment.args);
					}
					segment.argsComplete = true;
					completedStreamedArgs = true;
				}
				if (completedStreamedArgs) invalidateEntryCache(current);
			}
			// The model this message's start named leaves `Reply from` when the call never went out, retried or not.
			const unsent = assistantMessageNeverSent(event.message);
			if (current?.role === "assistant") {
				if (unsent && current.messageStartModel !== undefined) {
					detachUnsentModel(current);
					invalidateEntryCache(current);
				}
				current.messageStartModel = undefined;
			}
			const text = extractAssistantText(event.message);
			const thinking = extractAssistantThinking(event.message);
			// A failure recovery will retry is stated once, on the retry row; only the turn's real outcome reads as one.
			const willRetry = event.retryPending !== undefined;
			if (willRetry) scope.runAwaitingRetry = true;
			const extractedTerminalError = willRetry ? "" : extractAssistantTerminalError(event.message);
			const terminalError =
				current?.role === "assistant"
					? scopeTerminalErrorAfterSuccessfulTool(current, extractedTerminalError)
					: extractedTerminalError;
			const reports = !willRetry && reportsCall(event.message);
			const notRetained =
				(event.message as { pancodeReasoningNotRetained?: unknown }).pancodeReasoningNotRetained === true;
			const hiddenByProvider = thinking.length === 0 && assistantThinkingRedacted(event.message);
			const content = (event.message as { content?: unknown }).content;
			const summarizedByProvider = Array.isArray(content) && content.some(isNarrationSummary);
			if (
				text.length === 0 &&
				thinking.length === 0 &&
				!notRetained &&
				!hiddenByProvider &&
				terminalError.length === 0 &&
				!reports
			) {
				if (completedStreamedArgs) markDirty();
				return;
			}
			const assistant = ensureAssistant();
			// message_end rewrites exactly one entry: the assistant it lands on.
			invalidateEntryCache(assistant);
			attachModel(assistant, assistantModelLabel(event.message, messageTarget()));
			// Until its run ends, an entry's receipt reads the turn so far.
			if (reports) {
				assistant.turnUsage = scope.runTurnId === undefined ? {} : { turnId: scope.runTurnId };
				trackReceipt(assistant);
			}
			if (terminalError.length > 0) assistant.isError = true;
			// The message is settled, so whatever reasoning it streamed is closed.
			// A message that carried thinking the panel never saw as deltas (a
			// non-streaming provider, a replayed message) gets one segment at the
			// point this message began, ahead of the text the same message
			// produced, rather than a marker dangling after the answer.
			const messageCompleted = messageStopCompleted((event.message as { stopReason?: unknown }).stopReason);
			closeOpenThinking(assistant, messageCompleted);
			if (thinking.length > 0 || notRetained || hiddenByProvider) {
				const messageStart = Math.min(assistant.messageStartSegmentIndex ?? 0, assistant.segments.length);
				const streamedThisMessage = assistant.segments
					.slice(messageStart)
					.some((segment) => segment.kind === "thinking" && segment.text.length > 0);
				if (!streamedThisMessage) {
					assistant.segments.splice(messageStart, 0, {
						kind: "thinking",
						// A replay reaches here too, so an aborted message hides what its live view hid (#446).
						text: messageCompleted ? thinking : holdCutOffText(thinking),
						at: stamp(),
						finalized: true,
						...(hiddenByProvider
							? { hiddenByProvider: true as const }
							: thinking.length === 0
								? { notRetained: true as const }
								: {}),
					});
				}
			}
			if (summarizedByProvider) {
				const messageStart = Math.min(assistant.messageStartSegmentIndex ?? 0, assistant.segments.length);
				const own = assistant.segments.slice(messageStart);
				if (!own.some((segment) => segment.kind === "thinking" && segment.summarizedByProvider)) {
					const firstText = own.findIndex((segment) => segment.kind === "text");
					assistant.segments.splice(firstText < 0 ? assistant.segments.length : messageStart + firstText, 0, {
						kind: "thinking",
						text: "",
						at: stamp(),
						finalized: true,
						summarizedByProvider: true,
					});
				}
			}
			assistant.messageStartSegmentIndex = undefined;
			// The chat loop marks messages it sanitized after streaming (dead
			// tool-call markup on a synthesis-locked turn); the streamed tail
			// must be replaced, not kept alongside a duplicate segment.
			const sanitized = (event as { lockedSynthesisSanitized?: unknown }).lockedSynthesisSanitized === true;
			// A call the reply only wrote out leaves the prose, and the receipt or the re-prompt notice says it did not run.
			const prose = proseBeforeWrittenCalls(event.message, text);
			if (text.length > 0) canonicalizeMessageText(assistant, prose, sanitized || prose !== text);
			if (!messageCompleted) {
				// Display copy only. No later text can resolve what a cut-off stream was holding (#446).
				const messageStart = Math.min(assistant.messageStartSegmentIndex ?? 0, assistant.segments.length);
				for (const segment of assistant.segments.slice(messageStart))
					if (segment.kind === "text") replaceSegmentText(segment, holdCutOffText(segment.text));
				invalidateEntryCache(assistant);
			}
			if (terminalError.length > 0) {
				// An operator's cancel is not a route failure, and no route change fixes it.
				const failed = (event.message as { stopReason?: unknown }).stopReason === "error";
				const route = failed ? readProviderFailureRoute((event.message as { failureRoute?: unknown }).failureRoute) : null;
				appendErrorSegment(assistant, terminalError, route);
			}
			markDirty();
			return;
		}
		if (event.type === "retry_status") {
			const status = event.status;
			const row = turnRetryRow(transcript);
			if (status.phase === "moved") {
				scope.runMovedTo = status.movedTo?.modelId;
				// The run goes on, and its next start continues this receipt and clock.
				scope.runAwaitingRetry = true;
				if (row) {
					// An open countdown ends here, so the row that promised the retry becomes the one that says it did not happen.
					invalidateEntryCache(row);
					row.status = status;
				} else {
					transcript.push({ role: "retryStatus", status, at: stamp() });
				}
				markDirty();
				return;
			}
			if (row) {
				// One turn's attempts share one row. A retry row is stable, so it caches and can
				// freeze; a new phase or countdown must drop that render first.
				invalidateEntryCache(row);
				const reason = status.errorMessage ?? row.status.errorMessage;
				// The last attempt's own error block already states why the ladder ran out.
				const tail = transcript[transcript.length - 1];
				const stated =
					status.phase === "exhausted" &&
					tail?.role === "assistant" &&
					tail.segments.some((segment) => segment.kind === "error");
				const { errorMessage: _reason, ...rest } = status;
				row.status = { ...rest, ...(reason !== undefined && !stated ? { errorMessage: reason } : {}) };
			} else {
				transcript.push({ role: "retryStatus", status, at: stamp() });
			}
			noteRunRetries(status);
			if ((status.phase === "cancelled" || status.phase === "exhausted") && scope.runAwaitingRetry) {
				// The ladder ended between attempts, so no agent_end is coming to close the turn.
				settleRun({
					messages: [],
					turnId: scope.runTurnId,
					outcome: status.phase === "cancelled" ? "Cancelled" : "Failed",
					always: true,
				});
			}
			markDirty();
			return;
		}
		if (event.type === "agent_end") {
			if (event.retryPending !== undefined) {
				scope.runAwaitingRetry = true;
				// Closing an earlier round's entry would show its interim receipt as a Done the turn has not reached.
				for (const entry of transcript) {
					if (entry.role !== "assistant" || entry.turnUsage === undefined || entry.turnUsage.outcome !== undefined) continue;
					invalidateEntryCache(entry);
					delete entry.turnUsage;
					liveReceipts.delete(entry);
				}
				closeRunEntries(false);
				markDirty();
				return;
			}
			settleRun({
				messages: Array.isArray(event.messages) ? event.messages : [],
				turnId: (event as { turnId?: string }).turnId ?? scope.runTurnId,
				replayed: (event as { replayed?: ReplayedRunFacts }).replayed,
			});
			markDirty();
		}
	};

	return { applyEvent };
}
