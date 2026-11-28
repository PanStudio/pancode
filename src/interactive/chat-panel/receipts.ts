// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's turn receipts: each one rereads its turn's spend from the read model on every
 * new view until the view holds the run's own calls, and worker cards refresh their telemetry.
 */

import type { TelemetryView } from "../../domains/telemetry/contract.js";
import type { TranscriptEntry } from "../chat-transcript-model.js";
import { turnHoldsCalls, turnSpend } from "../turn-spend.js";
import type { ChatPanelScope } from "./scope.js";

export function createChatReceipts(scope: ChatPanelScope) {
	const { options, workerEntries, liveReceipts } = scope;
	const { invalidateEntryCache, markDirty } = scope.cache;
	const { telemetryShown } = scope.workers;
	const forgetPromptRecall = (): void => {
		if (scope.promptRecallReceipt?.turnUsage) {
			delete scope.promptRecallReceipt.turnUsage.promptRecall;
			invalidateEntryCache(scope.promptRecallReceipt);
		}
		scope.promptRecallReceipt = null;
	};
	/** Read one receipt's turn from the view; it stays live until the view holds all of the turn's spend. */
	const readReceipt = (entry: Extract<TranscriptEntry, { role: "assistant" }>, view: TelemetryView): void => {
		const usage = entry.turnUsage;
		if (usage?.turnId === undefined) {
			liveReceipts.delete(entry);
			return;
		}
		// The answer closes the run, so the moved turn's answering call is the run's last.
		const spend = turnSpend(
			view,
			usage.turnId,
			usage.movedTo === undefined ? undefined : usage.callIds?.at(-1),
			usage.replayed === true ? "lineage" : "session",
			usage.detachedRunIds,
		);
		if (spend === null) return;
		if (JSON.stringify(spend) !== JSON.stringify(usage.spend)) {
			invalidateEntryCache(entry);
			entry.turnUsage = { ...usage, spend };
			markDirty();
		}
		if (!runningTurns(view).has(usage.turnId) && turnHoldsCalls(view, usage.turnId, usage.callIds ?? []))
			liveReceipts.delete(entry);
	};
	/** The turns with a referenced run still going, built once per view: a replay reads one view for every receipt. */
	const runningTurnsByView = new WeakMap<TelemetryView, ReadonlySet<string>>();
	const runningTurns = (view: TelemetryView): ReadonlySet<string> => {
		let running = runningTurnsByView.get(view);
		if (running === undefined) {
			running = new Set(
				view.runs().flatMap((run) => (run.terminalReason === null && run.turnId !== null ? [run.turnId] : [])),
			);
			runningTurnsByView.set(view, running);
		}
		return running;
	};
	let lastFleetOwned = options.fleetOwnsLiveProgress?.() === true;
	const refreshReceipts = (): void => {
		const fleetOwned = options.fleetOwnsLiveProgress?.() === true;
		const fleetOwnedChanged = fleetOwned !== lastFleetOwned;
		lastFleetOwned = fleetOwned;
		const view = options.getTelemetry?.() ?? null;
		if (view === scope.receiptView && !fleetOwnedChanged) return;
		scope.receiptView = view;
		for (const entry of workerEntries.values()) {
			const shown = telemetryShown(entry.state, view);
			if (shown === entry.telemetryShown) continue;
			entry.telemetryShown = shown;
			invalidateEntryCache(entry);
			scope.dirty = true;
		}
		// A view still merging its cold read holds a partial session; its turns are read once it has merged.
		if (view === null || view.seeding) return;
		for (const entry of liveReceipts) readReceipt(entry, view);
	};
	/** A receipt the run just gave a turn: read now, and again on each new view while it is live. */
	const trackReceipt = (entry: Extract<TranscriptEntry, { role: "assistant" }>): void => {
		liveReceipts.add(entry);
		const view = options.getTelemetry?.() ?? null;
		if (view !== null && !view.seeding) readReceipt(entry, view);
	};

	return { forgetPromptRecall, refreshReceipts, trackReceipt };
}
