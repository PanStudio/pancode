// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The shared state of one chat panel.
 *
 * createChatPanel builds one scope per panel and hands it to the chat-panel
 * modules. A module reads every value it does not own as `scope.x` at the use
 * site, so a read sees the same value at the same moment the closure it came
 * from did. Mutable panel state lives here as plain fields; each module's
 * output is a getter over the panel's own binding.
 */

import type { OutputStyle } from "../../core/defaults.js";
import type { TelemetryView } from "../../domains/telemetry/contract.js";
import type { ChatPanelOptions } from "../chat-panel.js";
import type { TranscriptEntry, WorkerTranscriptEntry } from "../chat-transcript-model.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import type { EntryRun, EntryRuns } from "../transcript-runs.js";
import type { createChatCache } from "./cache.js";
import type { createChatFrame } from "./frame.js";
import type { createChatReceipts } from "./receipts.js";
import type { createChatRunSettle } from "./run-settle.js";
import type { createChatSegments } from "./segments.js";
import type { createChatToolEvents } from "./tool-events.js";
import type { createChatWorkers } from "./workers.js";

export interface ChatPanelScope {
	readonly options: ChatPanelOptions;
	readonly transcript: TranscriptEntry[];
	readonly entryRenderCache: Map<TranscriptEntry, Map<string, string[]>>;
	readonly runs: EntryRuns;
	readonly workerEntries: Map<string, WorkerTranscriptEntry>;
	readonly dispatchGroups: Map<string, WorkerTranscriptEntry[]>;
	readonly liveReceipts: Set<Extract<TranscriptEntry, { role: "assistant" }>>;
	receiptView: TelemetryView | null;
	promptRecallReceipt: Extract<TranscriptEntry, { role: "assistant" }> | null;
	/**
	 * Transcript index where the current run's entries begin. A worker block or
	 * a mid-turn notice splits one run across several assistant entries, and
	 * each entry keeps the per-message receipt its last `message_end` gave it;
	 * `agent_end` clears every one of them except the entry that carries the run
	 * total, so a receipt never lands in the middle of a turn.
	 */
	runStartIndex: number | undefined;
	runStartedAt: number | undefined;
	/** Why the current run's prompt cache may be cold, from the chat loop's cache notice. */
	runColdReasons: ReadonlyArray<string>;
	/** The run's last attempt failed and recovery will send another, so nothing has settled yet. */
	runAwaitingRetry: boolean;
	/** Provider attempts this run sent again, kept until its receipt can state them. */
	runRetries: number;
	runProviderWaits: number;
	runMovedTo: string | undefined;
	/** The operator turn the current run's calls journal under, from its start event or a replayed run end. */
	runTurnId: string | undefined;
	/** The latest settled receipt eligible for the turn's post-settlement prewarm record. */
	lastSettledReceipt: Extract<TranscriptEntry, { role: "assistant" }> | null;
	readonly liveReplayBlocks: Set<() => boolean>;
	dirty: boolean;
	/**
	 * A viewport-first re-layout under way (`deferRelayout`): runs laid out at an earlier key stay on screen while
	 * idle steps lay out each one again at `key`, into `replacements`; the frame after the last one swaps them all
	 * in. A newer key starts over. `building` is the run part way through.
	 */
	relayout: {
		key: string;
		heightKey: string;
		width: number;
		terminalRows: number;
		detail: TranscriptDetailPolicy;
		replacements: Map<EntryRun, EntryRun>;
		building: {
			run: EntryRun;
			next: number;
			parts: (readonly string[])[];
			starts: number[];
			rows: number;
			key: string;
		} | null;
		ready: boolean;
		scheduled: boolean;
	} | null;
	/**
	 * Settled entries are rendered ahead, in idle time, in the styles Alt+O
	 * cycles to, into the same per-entry cache a revisit reads. A first visit to
	 * a style used to render every entry on the keystroke: 195 ms at 2,000
	 * entries, against about 1 ms for a style already shown. `next` is the first
	 * entry not yet rendered ahead; an invalidation or an insertion behind it
	 * moves it back. Each step spends at most a few milliseconds, and the
	 * scheduler runs steps only while nothing streams.
	 */
	prerender: { width: number; terminalRows: number; style: OutputStyle; next: number } | null;
	readonly now: () => number;
	/**
	 * When an entry or action happened. Live, that is now; a replay pins it to
	 * the ledger entry being replayed, so `/view` states the age of the act and
	 * not of the resume.
	 */
	replayStampMs: number | undefined;
	replayTarget: string | null;
	readonly messageTarget: () => string | null;
	/** The model the newest assistant message came from: the requester of the calls that follow it. */
	requestingModel: string | undefined;
	readonly stamp: () => number;
	readonly currentDetail: () => TranscriptDetailPolicy;
	readonly cache: ReturnType<typeof createChatCache>;
	readonly workers: ReturnType<typeof createChatWorkers>;
	readonly receipts: ReturnType<typeof createChatReceipts>;
	readonly segments: ReturnType<typeof createChatSegments>;
	readonly toolEvents: ReturnType<typeof createChatToolEvents>;
	readonly runSettle: ReturnType<typeof createChatRunSettle>;
	readonly frame: ReturnType<typeof createChatFrame>;
}
