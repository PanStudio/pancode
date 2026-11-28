// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's render caches: each entry's rows for its last few layout keys, the dirty flag a
 * mutation raises, and the drops that a change to an entry, the skin, or the tail calls for.
 */

import type { TranscriptEntry } from "../chat-transcript-model.js";
import { skinEpoch } from "../theme/tokens.js";
import type { ChatPanelScope } from "./scope.js";

export const RENDERS_PER_ENTRY = 3;
/**
 * The cache follows the transcript instead of stopping at a fixed 256
 * entries, which re-rendered everything past the cap on every dirty frame
 * (10 ms/frame at 800 entries). The ceiling bounds worst-case memory at
 * roughly 4096 rendered entries; past it, the excess only re-renders on
 * full-rebuild events (width or style change), which the entry runs
 * below make rare rather than per-frame.
 */
const MIN_ENTRY_RENDER_CACHE = 256;
const MAX_ENTRY_RENDER_CACHE = 4096;

export function createChatCache(scope: ChatPanelScope) {
	const { transcript, entryRenderCache, runs } = scope;
	let renderedSkinEpoch = skinEpoch();
	const entryCacheCapacity = (): number =>
		Math.max(MIN_ENTRY_RENDER_CACHE, Math.min(MAX_ENTRY_RENDER_CACHE, transcript.length));

	const markDirty = (): void => {
		scope.dirty = true;
	};
	const invalidateEntryCache = (entry: TranscriptEntry): void => {
		entryRenderCache.delete(entry);
		if (runs.list.length === 0 && scope.prerender === null) return;
		// From the end: what changes is nearly always the live tail, and this runs per streamed delta.
		const index = transcript.lastIndexOf(entry);
		if (index >= 0) runs.release(index);
		// A worker row's gap reads the entry above it (`spawnedAtTail`), so a change there lays the worker out again.
		if (index >= 0 && entry.role === "assistant" && transcript[index + 1]?.role === "worker") runs.release(index + 1);
		if (scope.prerender !== null && index >= 0 && index < scope.prerender.next) scope.prerender.next = index;
	};
	/** Full drop of both render caches; used by the toggle paths that touch many entries. */
	const clearRenderCaches = (): void => {
		entryRenderCache.clear();
		runs.clear();
		scope.relayout = null;
		if (scope.prerender !== null) scope.prerender.next = 0;
	};
	const syncSkin = (): void => {
		if (renderedSkinEpoch === skinEpoch()) return;
		renderedSkinEpoch = skinEpoch();
		clearRenderCaches();
		scope.dirty = true;
	};
	/**
	 * A mutation is about to land on the tail entry without an explicit
	 * invalidation. If a run covers that entry, the run gives up its rows.
	 */
	const unfreezeTail = (): void => {
		if (transcript.length > 0) runs.release(transcript.length - 1);
	};

	/** Keep `rows` as `entry`'s render at `key`, within the cache's bounds. */
	const rememberRender = (entry: TranscriptEntry, key: string, rows: string[]): void => {
		const renders = entryRenderCache.get(entry);
		const byKey = renders ?? new Map<string, string[]>();
		byKey.set(key, rows);
		if (byKey.size > RENDERS_PER_ENTRY) {
			const oldestKey = byKey.keys().next().value;
			if (oldestKey !== undefined) byKey.delete(oldestKey);
		}
		if (renders === undefined) entryRenderCache.set(entry, byKey);
		const capacity = entryCacheCapacity();
		while (entryRenderCache.size > capacity) {
			const oldest = entryRenderCache.keys().next().value;
			if (oldest === undefined) break;
			entryRenderCache.delete(oldest);
		}
	};

	return {
		entryCacheCapacity,
		markDirty,
		invalidateEntryCache,
		clearRenderCaches,
		syncSkin,
		unfreezeTail,
		rememberRender,
	};
}
