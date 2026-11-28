// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's tool call events: a call starting, parking on and leaving the approval card,
 * streaming progress, and settling with its result and the chat loop's verdict.
 */

import type { ChatLoopEvent } from "../../session-control/chat-loop.js";
import { changeSettledCall } from "../chat-tool-rows.js";
import { findToolSegmentOwner, toolSettlement } from "../chat-transcript-model.js";
import { approvalAxisText } from "../renderers/tool-approval-cards.js";
import type { ChatPanelScope } from "./scope.js";

export function createChatToolEvents(scope: ChatPanelScope) {
	const { transcript, now, stamp } = scope;
	const { invalidateEntryCache, markDirty } = scope.cache;
	const { settleQueuedRows } = scope.workers;
	const { startEditPreview, settleUnfinishedToolSegment, ensureAssistant, closeOpenThinking } = scope.segments;
	const onToolExecutionStart = (event: Extract<ChatLoopEvent, { type: "tool_execution_start" }>): void => {
		const streamedOwner = findToolSegmentOwner(transcript, event.toolCallId);
		if (streamedOwner !== undefined && !streamedOwner.segment.finished && !streamedOwner.segment.executionStarted) {
			invalidateEntryCache(streamedOwner.entry);
			const streamed = streamedOwner.segment;
			streamed.name = event.toolName;
			streamed.args = event.args;
			streamed.executionStarted = true;
			streamed.argsComplete = true;
			streamed.requestedBy = scope.requestingModel;
			streamed.startedAtMs = now();
			startEditPreview(streamed);
			markDirty();
			return;
		}
		// A model that reuses a tool-call id across calls would leave the
		// prior same-id segment unsettled (its end matches the first segment
		// on lookup). Settle any such orphan now, wherever it lives, so it
		// does not linger as a counting running line while this call runs.
		for (const entry of transcript) {
			if (entry.role !== "assistant") continue;
			for (const seg of entry.segments) {
				if (seg.kind === "tool" && seg.id === event.toolCallId && !seg.finished) settleUnfinishedToolSegment(seg);
			}
		}
		const assistant = ensureAssistant();
		// No fold is stored here: the segment's effective state is resolved
		// per frame from the transcript detail policy and the tool's
		// registered presentation, with the operator's override on top.
		assistant.pending = true;
		closeOpenThinking(assistant);
		assistant.segments.push({
			kind: "tool",
			id: event.toolCallId,
			name: event.toolName,
			args: event.args,
			at: stamp(),
			finished: false,
			executionStarted: true,
			requestedBy: scope.requestingModel,
			argsComplete: true,
			isError: false,
			startedAtMs: now(),
		});
		markDirty();
	};

	const onToolApprovalState = (event: Extract<ChatLoopEvent, { type: "tool_approval_state" }>): void => {
		// Only the entry that owns the segment can change. Clearing the whole
		// 256-entry cache re-rendered every settled turn in the transcript;
		// on a 400-turn session that was 26.7 ms per event, and
		// tool_execution_update fires on every output tick of a running command.
		const owner = findToolSegmentOwner(transcript, event.toolCallId);
		if (owner) invalidateEntryCache(owner.entry);
		const tool = owner?.segment;
		if (tool && !tool.finished) {
			// Only the grant path resumes a parked call; a denial settles it blocked.
			if (event.state === "resumed" && tool.approvalView !== undefined) {
				tool.operatorGrant = approvalAxisText(tool.approvalView);
				tool.grantedBy = event.grantedBy;
			}
			// Time on the card is not time running: an allowed command starts its clock now.
			if (event.state === "resumed") tool.startedAtMs = now();
			tool.awaitingApproval = event.state === "awaiting-approval" ? true : undefined;
			tool.judging = event.state === "judging" ? true : undefined;
			tool.approvalView = event.state === "awaiting-approval" ? event.view : undefined;
			tool.approvalDocked = event.state === "awaiting-approval" && event.docked === true ? true : undefined;
			markDirty();
		}
	};

	const onToolExecutionUpdate = (event: Extract<ChatLoopEvent, { type: "tool_execution_update" }>): void => {
		// pi-agent emits `partialResult` as a cumulative AgentToolResult.
		// Preserve that full envelope so the renderer can use structured
		// progress details as well as content. Replace rather than append:
		// Pi's update semantics are cumulative, and appending would duplicate
		// every earlier snapshot.
		const owner = findToolSegmentOwner(transcript, event.toolCallId);
		if (owner) invalidateEntryCache(owner.entry);
		const tool = owner?.segment;
		if (tool && !tool.finished) {
			tool.partialResult = event.partialResult;
		}
		markDirty();
	};

	const onToolExecutionEnd = (event: Extract<ChatLoopEvent, { type: "tool_execution_end" }>): void => {
		const owner = findToolSegmentOwner(transcript, event.toolCallId);
		if (owner) invalidateEntryCache(owner.entry);
		// A finish the completion protocol refused is the model's internal retry, not work: its row leaves the
		// transcript, and the session record and the model's context keep the refusal (R2-F15).
		if (owner?.entry.role === "assistant" && (event as { protocolRetry?: unknown }).protocolRetry === true) {
			const index = owner.entry.segments.indexOf(owner.segment);
			if (index >= 0) owner.entry.segments.splice(index, 1);
			markDirty();
			return;
		}
		const tool = owner?.segment;
		if (tool) {
			changeSettledCall(tool);
			tool.result = event.result;
			tool.isError = event.isError;
			// The chat loop enriches tool_execution_end with durationMs, the
			// persisted resultSummary (bytes, truncated, offloadPath,
			// observation counts), and the registry's admission verdict;
			// carry them so the ledger line and replay render identical facts.
			const enriched = event as {
				durationMs?: unknown;
				resultSummary?: unknown;
				outcome?: unknown;
				blockReason?: unknown;
				evictedReason?: unknown;
				actionClass?: unknown;
				autoApproved?: unknown;
			};
			if (typeof enriched.actionClass === "string" && enriched.actionClass.length > 0) {
				tool.actionClass = enriched.actionClass;
			}
			tool.autoApproved = enriched.autoApproved === "yolo" ? "yolo" : undefined;
			// Replay-only: the rehydrator reads the working-set fold and tags
			// the rows whose bodies the projection has replaced for the model.
			tool.evictedReason =
				typeof enriched.evictedReason === "string" && enriched.evictedReason.length > 0
					? enriched.evictedReason
					: undefined;
			// Settlement is that verdict, never an inference from result text.
			// The text of a tool result is the tool's own output: `node --test`
			// prints `cancelled 0` on every run and a linter can print
			// "blocked" for its own reasons, so matching those words there
			// labelled ordinary command failures as permission blocks and
			// suppressed the output that would have explained them.
			const settled = toolSettlement(enriched);
			tool.settlement = settled?.settlement;
			tool.blockReason = settled?.reason;
			tool.finished = true;
			settleQueuedRows(tool);
			// The true result replaces a synthetic settle; from here on the
			// segment is model-finished and immutable to later end events.
			tool.settledWithoutResult = undefined;
			// A call the output limit cut off reads as not run, not as a failed call (bt-39 a).
			const cutOff = (enriched as { notRun?: unknown }).notRun === "output_limit";
			tool.notRun = cutOff ? true : undefined;
			tool.notRunCause = cutOff ? "output_limit" : undefined;
			if (typeof enriched.durationMs === "number" && Number.isFinite(enriched.durationMs)) {
				tool.durationMs = enriched.durationMs;
			} else if (tool.startedAtMs !== undefined && scope.replayStampMs === undefined) {
				// A replay has only the ledger's duration; wall-clock elapsed here
				// would measure rehydration, not the tool.
				const elapsed = Math.max(0, now() - tool.startedAtMs);
				if (elapsed > 0) tool.durationMs = elapsed;
			}
			if (
				enriched.resultSummary !== null &&
				typeof enriched.resultSummary === "object" &&
				!Array.isArray(enriched.resultSummary)
			) {
				tool.resultSummary = enriched.resultSummary as Record<string, unknown>;
			}
			// Drop the streaming buffer once the final result has landed; the
			// expanded render switches to `renderToolExecution` and stays
			// stable instead of churning through partial-frame layout. A
			// denied park settles here too, so the awaiting styling must go.
			tool.partialResult = undefined;
			tool.live = undefined;
			tool.previewDiff = undefined;
			tool.awaitingApproval = undefined;
			tool.approvalView = undefined;
			tool.approvalDocked = undefined;
			tool.judging = undefined;
		}
		markDirty();
	};

	return { onToolExecutionStart, onToolApprovalState, onToolExecutionUpdate, onToolExecutionEnd };
}
