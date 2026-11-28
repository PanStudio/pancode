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
import type { ChatPanelOptions } from "../chat-panel.js";
import type { TranscriptEntry } from "../chat-transcript-model.js";
import type { TranscriptDetailPolicy } from "../transcript-detail.js";
import type { EntryRun, EntryRuns } from "../transcript-runs.js";
import type { createChatCache } from "./cache.js";

export interface ChatPanelScope {
	readonly options: ChatPanelOptions;
	readonly transcript: TranscriptEntry[];
	readonly entryRenderCache: Map<TranscriptEntry, Map<string, string[]>>;
	readonly runs: EntryRuns;
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
	readonly cache: ReturnType<typeof createChatCache>;
}
