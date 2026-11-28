// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's transcript writes: entries placed or appended, the assistant entry a stream
 * writes into, and the thinking, text, tool and error segments each delta lands in.
 */

import { assistantModelLabel } from "../../core/assistant-model.js";
import { ToolNames } from "../../core/tool-names.js";
import { settledPrefixLength } from "../../engine/apis/diffusion-frames.js";
import { holdCutOffText } from "../../lib/secrets/redaction.js";
import {
	appendSegmentText,
	findToolSegmentOwner,
	openThinkingSegment,
	replaceSegmentText,
	type TextSegment,
	type ToolSegment,
	type TranscriptEntry,
} from "../chat-transcript-model.js";
import { editPreviewDiff } from "../mutation-preview.js";
import type { ProviderFailureRoute } from "../renderers/provider-error.js";
import type { ChatPanelScope } from "./scope.js";

export function createChatSegments(scope: ChatPanelScope) {
	const { options, transcript, runs, now, stamp, messageTarget } = scope;
	const { invalidateEntryCache, markDirty, unfreezeTail } = scope.cache;
	const { settleQueuedRows } = scope.workers;
	/**
	 * An edit whose arguments have closed shows the diff it will make before its
	 * result lands. The file is read off the event path; the frame that shows
	 * the diff is requested when it is ready. Replay never reads files: its
	 * calls are settled and carry the tool's own diff.
	 */
	const startEditPreview = (seg: ToolSegment): void => {
		if (seg.previewRequested || seg.finished || seg.name !== ToolNames.Edit || scope.replayStampMs !== undefined) return;
		seg.previewRequested = true;
		void editPreviewDiff(seg.args).then((diff) => {
			if (diff === null || seg.finished) return;
			seg.previewDiff = diff;
			const owner = findToolSegmentOwner(transcript, seg.id);
			if (owner?.segment === seg) invalidateEntryCache(owner.entry);
			markDirty();
			options.requestRender?.();
		});
	};

	/**
	 * Force an in-flight tool segment to a settled error line. A call blocked at
	 * admission (loop guard, safety) or one whose `tool_execution_end` never
	 * arrives (aborted mid-batch, a model that reuses a tool-call id) would
	 * otherwise stay a counting `· N.Ns` running line forever. Settling it with
	 * its OWN elapsed gives it the same visual grammar as any other error
	 * (`✗ · <ms>`), so a blocked call reads like the failure it is.
	 */
	const settleUnfinishedToolSegment = (seg: ToolSegment, settlement: "aborted" | "orphaned" = "orphaned"): void => {
		if (seg.finished) return;
		seg.finished = true;
		settleQueuedRows(seg);
		seg.isError = true;
		seg.settledWithoutResult = true;
		if (seg.durationMs === undefined && seg.startedAtMs !== undefined) {
			seg.durationMs = Math.max(1, now() - seg.startedAtMs);
		}
		if (seg.result === undefined)
			seg.result = "(no result: the call did not complete; execution was aborted, blocked, or orphaned)";
		seg.settlement = settlement;
		seg.notRun = !seg.executionStarted || seg.awaitingApproval === true || seg.judging === true ? true : undefined;
		seg.partialResult = undefined;
		seg.live = undefined;
		seg.previewDiff = undefined;
		seg.awaitingApproval = undefined;
		seg.approvalView = undefined;
		seg.approvalDocked = undefined;
		seg.judging = undefined;
	};

	const insertEntryAt = (at: number, entry: TranscriptEntry): void => {
		transcript.splice(at, 0, entry);
		if (scope.runStartIndex !== undefined && at <= scope.runStartIndex) scope.runStartIndex += 1;
		// Runs are stretches of indices: the ones behind the cut move up by one, and one it lands inside splits there.
		runs.insert(at);
		if (scope.prerender !== null && at < scope.prerender.next) scope.prerender.next = at;
		// The entry behind the new card has a new predecessor, which decides
		// whether it stacks or opens a council group.
		const behind = transcript[at + 1];
		if (behind !== undefined) invalidateEntryCache(behind);
	};

	/**
	 * Add a row that is not part of the reply being written. The next delta lands
	 * on the transcript's tail, so a row pushed under an open message cut the reply
	 * in two and the settling message printed it a third time, whole. That took a
	 * `/run`, a worker's card or any notice arriving during a main stream. The row
	 * goes above the open message instead, which keeps the reply in one piece.
	 */
	const appendRow = (entry: TranscriptEntry): void => {
		const tail = transcript[transcript.length - 1];
		if (tail?.role === "assistant" && tail.pending && tail.messageStartSegmentIndex !== undefined) {
			insertEntryAt(transcript.length - 1, entry);
			return;
		}
		transcript.push(entry);
	};

	const attachModel = (assistant: Extract<TranscriptEntry, { role: "assistant" }>, model: string | null): boolean => {
		if (model === null || assistant.models?.includes(model)) return false;
		if (assistant.models === undefined) {
			const at = transcript.lastIndexOf(assistant);
			let before: string | undefined;
			for (let index = (at < 0 ? transcript.length : at) - 1; index >= 0 && before === undefined; index -= 1) {
				const prior = transcript[index];
				if (prior?.role === "assistant") before = prior.models?.at(-1);
			}
			// With no earlier reply, the route the turn was sent to is what a reply from elsewhere would differ from.
			// A replay has no record of it, so a replayed first reply still names its route.
			if (before === undefined && scope.replayStampMs === undefined)
				before = assistantModelLabel({ model: options.getRunModel?.() }, messageTarget()) ?? undefined;
			assistant.sameModelAsBefore = before === model;
		}
		assistant.models ??= [];
		assistant.models.push(model);
		return true;
	};
	const ensureAssistant = (): Extract<TranscriptEntry, { role: "assistant" }> => {
		const last = transcript[transcript.length - 1];
		if (last && last.role === "assistant") {
			// Callers mutate the returned entry (pending, thinking, segments)
			// without always invalidating; a run covering it would keep
			// serving the settled render of this tail entry.
			unfreezeTail();
			return last;
		}
		const entry: Extract<TranscriptEntry, { role: "assistant" }> = {
			role: "assistant",
			segments: [],
			pending: false,
			isError: false,
		};
		transcript.push(entry);
		return entry;
	};

	/**
	 * Close the thinking stretch at the tail, if one is open. Anything that
	 * follows reasoning in the stream (text, a tool call, the message settling)
	 * ends that stretch; a later `thinking_delta` opens a new segment after it,
	 * so the transcript keeps the order the model actually worked in.
	 */
	const closeOpenThinking = (entry: Extract<TranscriptEntry, { role: "assistant" }>, completed = true): void => {
		const open = openThinkingSegment(entry);
		if (open === null) return;
		open.finalized = true;
		// Display copy only. No later text can resolve what a cut-off stream was holding (#446).
		if (!completed) open.text = holdCutOffText(open.text);
		invalidateEntryCache(entry);
	};

	const appendThinkingDelta = (entry: Extract<TranscriptEntry, { role: "assistant" }>, delta: string): void => {
		if (delta.length === 0) return;
		invalidateEntryCache(entry);
		const open = openThinkingSegment(entry);
		if (open !== null) {
			open.text += delta;
			return;
		}
		entry.segments.push({ kind: "thinking", text: delta, at: stamp(), finalized: false, startedAtMs: now() });
	};

	const appendTextDelta = (entry: Extract<TranscriptEntry, { role: "assistant" }>, delta: string): void => {
		if (delta.length === 0) return;
		invalidateEntryCache(entry);
		closeOpenThinking(entry);
		const tail = entry.segments[entry.segments.length - 1];
		if (tail && tail.kind === "text" && !tail.finalized) {
			appendSegmentText(tail, delta);
			return;
		}
		entry.segments.push({ kind: "text", text: delta, finalized: false });
	};

	/**
	 * Replace this message's live text segment with one whole diffusion frame.
	 * A frame rewrites anywhere in the text; the settled prefix is what the
	 * previous frame and this one agree on.
	 *
	 * The frame targets the message's frame segment wherever it sits, not the
	 * tail. Mercury repeats the whole frame on every chunk that carries a
	 * tool-call delta and sends the resolved text last, after the tool call has
	 * begun, so a preamble's frames keep arriving while a tool segment is the
	 * tail. Replacing only the tail left a noise frame above the tool line and
	 * the resolved text in a second segment below it.
	 */
	const replaceTextFrame = (
		entry: Extract<TranscriptEntry, { role: "assistant" }>,
		text: string,
		progress: number,
	): void => {
		invalidateEntryCache(entry);
		closeOpenThinking(entry);
		const messageStart = Math.min(entry.messageStartSegmentIndex ?? 0, entry.segments.length);
		let live: TextSegment | undefined;
		for (let index = entry.segments.length - 1; index >= messageStart; index -= 1) {
			const segment = entry.segments[index];
			if (segment?.kind === "text" && !segment.finalized && segment.diffusion) {
				live = segment;
				break;
			}
		}
		const tail = entry.segments[entry.segments.length - 1];
		if (!live && tail && tail.kind === "text" && !tail.finalized) live = tail;
		if (live) {
			const settled = progress >= 1 ? text.length : settledPrefixLength(live.text, text);
			replaceSegmentText(live, text);
			live.diffusion = { progress, settled };
			return;
		}
		entry.segments.push({
			kind: "text",
			text,
			finalized: false,
			diffusion: { progress, settled: progress >= 1 ? text.length : 0 },
		});
	};

	/**
	 * Canonicalize the streamed text of a completed assistant message.
	 *
	 * The streamed text is wherever this message put it, not necessarily at the
	 * tail: a message that thinks, writes, and thinks again leaves its text
	 * behind a thinking segment. Looking only at the tail appended the message
	 * text a second time under the reasoning marker, so the answer read twice.
	 *
	 * One streamed segment that is a prefix of the final text (the common case)
	 * is overwritten in place and flipped to finalized so the next render pipes
	 * it through Markdown. Several streamed segments (text split by reasoning)
	 * are each finalized where they stand; the deltas already are the text.
	 * When the message arrived fully formed with no deltas (non-streaming
	 * path, synthetic notices, replay), a fresh finalized segment is appended.
	 * `replaceTail` forces the overwrite for messages the chat loop rewrote
	 * after streaming (locked-turn markup sanitation): the streamed text is dead
	 * there, not a prefix.
	 */
	const canonicalizeMessageText = (
		entry: Extract<TranscriptEntry, { role: "assistant" }>,
		text: string,
		replaceTail = false,
	): void => {
		if (text.length === 0 && !replaceTail) return;
		closeOpenThinking(entry);
		const messageStart = Math.min(entry.messageStartSegmentIndex ?? 0, entry.segments.length);
		const streamed: TextSegment[] = [];
		for (let index = messageStart; index < entry.segments.length; index += 1) {
			const segment = entry.segments[index];
			if (segment?.kind === "text" && !segment.finalized) streamed.push(segment);
		}
		const finalize = (segment: TextSegment, value: string): void => {
			replaceSegmentText(segment, value);
			segment.finalized = true;
			delete segment.diffusion;
		};
		if (replaceTail && streamed.length > 0) {
			const [first, ...rest] = text.length > 0 ? streamed : [undefined, ...streamed];
			if (first) finalize(first, text);
			for (const dead of rest) if (dead) entry.segments.splice(entry.segments.indexOf(dead), 1);
			return;
		}
		if (text.length === 0) return;
		if (streamed.length === 1 && streamed[0] !== undefined) {
			const only = streamed[0];
			// A diffusion frame is the whole text so far, never a slice of it, so
			// the settled message replaces it even when the last frame was noise.
			if (only.diffusion || text.startsWith(only.text)) {
				finalize(only, text);
				return;
			}
		} else if (streamed.length > 1) {
			for (const segment of streamed) finalize(segment, segment.text);
			return;
		}
		entry.segments.push({ kind: "text", text, finalized: true });
	};

	/**
	 * Append the turn's terminal-error marker as its own error segment so the
	 * render path styles it in the error token rather than piping it through
	 * Markdown as prose. Guards against a duplicate when the same marker arrives
	 * twice for one settled turn.
	 */
	const appendErrorSegment = (
		entry: Extract<TranscriptEntry, { role: "assistant" }>,
		text: string,
		route: ProviderFailureRoute | null = null,
	): void => {
		const tail = entry.segments[entry.segments.length - 1];
		if (tail?.kind === "error" && tail.text === text) return;
		entry.segments.push({ kind: "error", text, at: stamp(), ...(route !== null ? { route } : {}) });
	};

	return {
		startEditPreview,
		settleUnfinishedToolSegment,
		insertEntryAt,
		appendRow,
		attachModel,
		ensureAssistant,
		closeOpenThinking,
		appendThinkingDelta,
		appendTextDelta,
		replaceTextFrame,
		canonicalizeMessageText,
		appendErrorSegment,
	};
}
