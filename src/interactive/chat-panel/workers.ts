// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's worker cards: where a new card is placed, the call that spawned it, the
 * telemetry and siblings it renders with, and the queued rows a live dispatch draws.
 */

import type { TelemetryView } from "../../domains/telemetry/contract.js";
import type { WorkerEntryState } from "../../session-control/worker-stream.js";
import { changeSettledCall, type QueuedRows, queuedRunRows, unplacedTasks } from "../chat-tool-rows.js";
import {
	findToolSegmentOwner,
	runStartFallback,
	type ToolSegment,
	type TranscriptEntry,
	workerGroupKey,
} from "../chat-transcript-model.js";
import { routeFirstOutput } from "../footer/silence-note.js";
import { type WorkerEntryRenderOptions, workerTelemetryDisplay } from "../renderers/worker-entry.js";
import type { ChatPanelScope } from "./scope.js";

export function createChatWorkers(scope: ChatPanelScope) {
	const { options, transcript, dispatchGroups } = scope;
	const { invalidateEntryCache } = scope.cache;
	/** A retry rebinds a card to a new run on the same state object, so the run id is part of what it shows. */
	const telemetryShown = (state: WorkerEntryState, view: TelemetryView | null): string =>
		`${state.runId}\0${options.fleetOwnsLiveProgress?.() === true ? "1" : "0"}\0${workerTelemetryDisplay(view?.run(state.runId) ?? null)}`;
	/** A dispatch call whose every card settled cancelled reads as stopped on its own row too. */
	const markCancelledDispatch = (toolCallId: string | undefined): void => {
		if (toolCallId === undefined) return;
		const cards = dispatchGroups.get(toolCallId) ?? [];
		if (cards.length === 0 || !cards.every((card) => card.state.result?.outcome === "canceled")) return;
		const parent = findSpawningCall(toolCallId);
		if (parent === undefined || parent.segment.cardsCancelled === true) return;
		parent.segment.cardsCancelled = true;
		changeSettledCall(parent.segment);
		invalidateEntryCache(parent.entry);
	};
	const workerRenderOptions = (
		entry: TranscriptEntry,
	): Pick<
		WorkerEntryRenderOptions,
		"siblings" | "showGroupHeader" | "telemetry" | "routeFirstOutput" | "fleetOwnsLiveProgress"
	> => {
		if (entry.role !== "worker") return {};
		const view = options.getTelemetry?.() ?? null;
		const telemetry = view?.run(entry.state.runId) ?? null;
		const key = workerGroupKey(entry.state);
		const siblings = key === undefined ? undefined : dispatchGroups.get(key);
		const route = entry.state.runtime;
		const fleetOwns = options.fleetOwnsLiveProgress?.() === true;
		return {
			telemetry,
			...(fleetOwns ? { fleetOwnsLiveProgress: true } : {}),
			...(entry.state.pending
				? { routeFirstOutput: routeFirstOutput(view, route.targetId, route.wireModelId, "worker") }
				: {}),
			...(siblings ? { siblings: siblings.map((sibling) => sibling.state), showGroupHeader: siblings[0] === entry } : {}),
		};
	};
	/**
	 * A live dispatch's tasks that no worker has started yet. Compact shows no live worker row (6.2), so they draw at
	 * standard and detailed only: under the call's row until its first worker is placed, then under its last card.
	 */
	const queuedRows: QueuedRows = {
		call: (seg, width, detail) =>
			!detail.evidence || (dispatchGroups.get(seg.id)?.length ?? 0) > 0
				? []
				: queuedRunRows(unplacedTasks(seg, []), width),
		card: (entry, width, detail) => {
			const parent = entry.state.parentToolCallId;
			if (!detail.evidence || parent === undefined) return [];
			const group = dispatchGroups.get(parent);
			if (group === undefined || group[group.length - 1] !== entry) return [];
			const call = findSpawningCall(parent)?.segment;
			return call === undefined
				? []
				: queuedRunRows(
						unplacedTasks(
							call,
							group.map((card) => card.state),
						),
						width,
					);
		},
	};
	/** A settled dispatch draws no queued rows, so the card that drew them under it renders again. */
	const settleQueuedRows = (seg: ToolSegment): void => {
		if (seg.name !== "dispatch") return;
		for (const card of dispatchGroups.get(seg.id) ?? []) invalidateEntryCache(card);
	};

	/**
	 * The call a worker card belongs under: the one that spawned it, running or
	 * settled. A dispatch that returns before its worker's first event (a
	 * detached batch) has settled by the time the card arrives, and the card is
	 * still that call's run, so a settled call of the current run takes it too.
	 * A call from an earlier turn keeps its own row, and the card appends at
	 * the tail.
	 */
	const findSpawningCall = (toolCallId: string): { segment: ToolSegment; entry: TranscriptEntry } | undefined => {
		const live = findToolSegmentOwner(transcript, toolCallId);
		if (live !== undefined) return live;
		const runStart = scope.runStartIndex ?? runStartFallback(transcript, transcript.length);
		for (let entryIndex = transcript.length - 1; entryIndex >= runStart; entryIndex -= 1) {
			const entry = transcript[entryIndex];
			if (entry?.role !== "assistant") continue;
			for (const segment of entry.segments) {
				if (segment.kind === "tool" && segment.id === toolCallId) return { segment, entry };
			}
		}
		return undefined;
	};

	/**
	 * Where a newly seen worker block belongs. An agent-origin run nests under
	 * the assistant entry holding the tool call that spawned it, behind any
	 * sibling blocks the same call already placed, so a fan-out reads top to
	 * bottom in spawn order. Everything else, including a run whose parent call
	 * is no longer in the transcript (a detached collect landing turns later),
	 * appends at the tail. null means "append".
	 */
	const workerInsertionIndex = (state: WorkerEntryState): number | null => {
		const parentToolCallId = state.parentToolCallId;
		if (parentToolCallId === undefined) return null;
		const owner = findSpawningCall(parentToolCallId);
		if (owner === undefined) return null;
		const parentIndex = transcript.indexOf(owner.entry);
		if (parentIndex < 0) return null;
		let index = parentIndex + 1;
		while (transcript[index]?.role === "worker") index += 1;
		return index >= transcript.length ? null : index;
	};

	return {
		telemetryShown,
		markCancelledDispatch,
		workerRenderOptions,
		queuedRows,
		settleQueuedRows,
		findSpawningCall,
		workerInsertionIndex,
	};
}
