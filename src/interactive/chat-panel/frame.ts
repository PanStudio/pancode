// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The chat panel's frame: the transcript laid out as row pieces, the last frame kept until a
 * mutation or the layout key changes it, and the idle re-layout and render-ahead steps.
 */

import { performance } from "node:perf_hooks";
import type { OutputStyle } from "../../core/defaults.js";
import {
	GAP_ROW,
	type LiveSplit,
	renderEntryLines,
	rowsBudget,
	segmentsWalked,
	stacksUnder,
} from "../chat-entry-rows.js";
import type { ChatPanelRegions } from "../chat-panel.js";
import { entryHasRunningTool, entryIsStable, type TranscriptEntry } from "../chat-transcript-model.js";
import { dateLocal } from "../format-time.js";
import { type TranscriptDetailPolicy, transcriptDetail } from "../transcript-detail.js";
import {
	type EntryRun,
	entryRows,
	joinRows,
	type PlacedPiece,
	type TranscriptViewport,
	viewportWindow,
} from "../transcript-runs.js";
import { RENDERS_PER_ENTRY } from "./cache.js";
import type { ChatPanelScope } from "./scope.js";

const OUTPUT_STYLE_CYCLE: readonly OutputStyle[] = ["compact", "standard", "detailed"];

export function createChatFrame(scope: ChatPanelScope) {
	const { options, transcript, entryRenderCache, runs, liveReplayBlocks, now, currentDetail } = scope;
	const { entryCacheCapacity, syncSkin, rememberRender } = scope.cache;
	const { workerRenderOptions, queuedRows } = scope.workers;
	const { refreshReceipts } = scope.receipts;
	let cachedWidth: number | undefined;
	let cachedRegions: ChatPanelRegions = { pieces: [], rows: 0 };
	/** The last frame concatenated, built on first request; null until someone asks for it. */
	let cachedLines: string[] | null = [];
	let cachedDetail: TranscriptDetailPolicy | undefined;
	let cachedTick = 0;
	let cachedDay = "";
	let cachedTerminalRows = 0;
	/**
	 * Did the last executed render put a counting elapsed line on screen? It is
	 * what decides whether the render key carries a time tick at all, so a
	 * transcript with nothing running keeps the old mutation-only invalidation.
	 */
	let renderedRunningTool = false;
	/** Where the last frame's pieces sit, so a re-layout can find the entries around the viewport. */
	let frameLayout: readonly PlacedPiece[] = [];
	const deferRelayout = options.deferRelayout === true && options.scheduleIdle !== undefined;
	const unboundedToolBodies = options.unboundedToolBodies === true;
	const bareFences = options.bareCodeFences === true;
	const copyMarks = options.copyMarks === true && !bareFences;
	let prerenderScheduled = false;
	const PRERENDER_STEP_MS = 3;

	/**
	 * One frame: every row the transcript shows, as row pieces. Each run of settled entries is one piece, handed on
	 * as the same array until an entry in it changes or the layout key does, so a streamed token renders and joins
	 * only the live entries, wherever they sit.
	 */
	const renderFrame = (width: number, viewport?: TranscriptViewport): ChatPanelRegions => {
		syncSkin();
		refreshReceipts();
		const startedAt = performance.now();
		const detail = currentDetail();
		const terminalRows = options.getTerminalRows?.() ?? 40;
		const nowMs = now();
		// `dirty` is set on mutation and never on a tick, so without time in the
		// key a running tool's elapsed counter advanced only when something
		// unrelated invalidated the panel. The tick is the same 100 ms bucket
		// dispatch-board.ts uses for running rows, taken off the injectable
		// clock so a fixed clock still produces byte-stable output, and it is
		// pinned to 0 whenever nothing is counting so a settled transcript
		// re-renders no more often than it did before.
		const tick = renderedRunningTool ? Math.floor(nowMs / 100) : 0;
		// A receipt reads its end time bare on the day it ended and dated after, so a settled transcript
		// renders again once the local day turns; a receipt cached across midnight kept reading as today.
		const day = dateLocal(nowMs);
		// A live block that settled since the last frame changed what it renders, which no mutation marked: a `!false`
		// that exited inside one 100 ms tick kept reading `you are running` beside a rail reading `exited 1`.
		for (const live of liveReplayBlocks) {
			if (live()) continue;
			liveReplayBlocks.delete(live);
			scope.dirty = true;
		}
		if (
			!scope.dirty &&
			cachedWidth === width &&
			cachedTerminalRows === terminalRows &&
			cachedDetail === detail &&
			cachedTick === tick &&
			cachedDay === day
		) {
			options.onRenderMetrics?.({
				durationMs: performance.now() - startedAt,
				cacheHit: true,
				entriesRendered: 0,
				segmentsRendered: 0,
			});
			return cachedRegions;
		}
		// Stable entries cache by width, height budget, and preset; a replay block and a run holding one by height too.
		const baseKey = `${width}|${rowsBudget(detail, terminalRows)}|${detail.style}|${day}`;
		const heightKey = `${baseKey}|${terminalRows}`;
		const capacity = entryCacheCapacity();
		const valid = (run: EntryRun): boolean => run.key === baseKey || run.key === heightKey;
		// The one switch for a layout change: viewport-first while idle steps can catch the rest up, else every entry.
		const deferring = deferRelayout && !unboundedToolBodies;
		if (!deferring || (scope.relayout !== null && scope.relayout.key !== baseKey)) scope.relayout = null;
		// The entries a re-layout renders in this frame; outside them, a run laid out at an earlier key stays.
		let freshFrom = 0;
		let freshTo = 0;
		let anchor: { entry: number; offset: number; top: number } | null = null;
		const around = (): ReturnType<typeof viewportWindow> =>
			viewportWindow(frameLayout, cachedRegions.rows, transcript.length, viewport ?? { fromEnd: 0, rows: terminalRows });
		if (deferring && scope.relayout === null && runs.list.some((run) => !valid(run))) {
			const window = around();
			anchor = window.anchor;
			freshFrom = window.lo;
			freshTo = window.hi;
			runs.splitAt(freshFrom);
			runs.splitAt(freshTo);
			scope.relayout = {
				key: baseKey,
				heightKey,
				width,
				terminalRows,
				detail,
				replacements: new Map(),
				building: null,
				ready: false,
				scheduled: false,
			};
		} else if (scope.relayout?.ready === true) {
			// The swap: every row above the viewport takes its new layout at once.
			anchor = around().anchor;
		}
		const pieces: (readonly string[])[] = [];
		const layout: PlacedPiece[] = [];
		let total = 0;
		const emit = (rows: readonly string[], from: number, run?: EntryRun): void => {
			if (rows.length === 0) return;
			layout.push(
				run === undefined ? { start: total, rows: rows.length, from } : { start: total, rows: rows.length, from, run },
			);
			pieces.push(rows);
			total += rows.length;
		};
		const nextRuns: EntryRun[] = [];
		// The settled entries since the last live one, as the runs reused and the entries rendered that make them up.
		let stretch: {
			from: number;
			parts: (readonly string[])[];
			rows: number;
			/** Per run reused or entry rendered, the row of the stretch it starts at. */
			members: Array<{ at: number; run?: EntryRun }>;
			key: string;
		} | null = null;
		const openStretch = (from: number): NonNullable<typeof stretch> => {
			stretch ??= { from, parts: [], rows: 0, members: [], key: baseKey };
			return stretch;
		};
		const closeStretch = (to: number): void => {
			if (stretch === null) return;
			const only = stretch.members.length === 1 ? stretch.members[0]?.run : undefined;
			if (only !== undefined) {
				// One run reused whole: the same array as the frame before.
				nextRuns.push(only);
				emit(only.rows, only.from, only);
			} else {
				const starts = stretch.members.flatMap((member) =>
					member.run === undefined ? [member.at] : member.run.starts.map((start) => start + member.at),
				);
				const run: EntryRun = {
					from: stretch.from,
					to,
					rows: joinRows(stretch.parts, stretch.rows),
					starts,
					key: stretch.key,
				};
				nextRuns.push(run);
				emit(run.rows, run.from, run);
			}
			stretch = null;
		};
		let entriesRendered = 0;
		const walkedBefore = segmentsWalked;
		// Entries inside a run are settled, so only the entries this frame walks can hold a running tool.
		let sawRunningTool = false;
		const held = runs.list;
		let runAt = 0;
		const reuse = (run: EntryRun): void => {
			const into = openStretch(run.from);
			into.members.push({ at: into.rows, run });
			into.parts.push(run.rows);
			into.rows += run.rows.length;
			if (run.key === heightKey) into.key = heightKey;
		};
		for (let i = 0; i < transcript.length; ) {
			while (runAt < held.length && (held[runAt] as EntryRun).to <= i) runAt += 1;
			const run = held[runAt];
			if (run !== undefined && run.from === i && valid(run)) {
				reuse(run);
				i = run.to;
				continue;
			}
			if (run !== undefined && run.from === i && scope.relayout !== null && (run.to <= freshFrom || run.from >= freshTo)) {
				const replacement = scope.relayout.ready ? scope.relayout.replacements.get(run) : undefined;
				if (replacement !== undefined && valid(replacement)) {
					reuse(replacement);
				} else {
					// Laid out at an earlier key, away from the viewport: shown as it was until the idle steps catch up.
					closeStretch(i);
					nextRuns.push(run);
					emit(run.rows, run.from, run);
				}
				i = run.to;
				continue;
			}
			const entry = transcript[i] as TranscriptEntry;
			if (!sawRunningTool && entryHasRunningTool(entry)) sawRunningTool = true;
			// Cards of one council round, of one fan-out, and helper rows are a
			// list, not a series of blocks, and so is every run of cards in
			// Compact. Anything else keeps the blank line between entries.
			const previous = i > 0 ? transcript[i - 1] : undefined;
			const separated = i > 0 && !stacksUnder(entry, previous, detail);
			const split: LiveSplit = { head: undefined };
			const renders = entryRenderCache.get(entry);
			const renderKey =
				entry.role === "replayBlock"
					? heightKey
					: entry.role === "worker" && entryHasRunningTool(entry)
						? `${baseKey}|${tick}`
						: baseKey;
			const cached = renders?.get(renderKey);
			// A replay block that is not live is a pure function of the render key,
			// so it caches like any settled entry. Excluding every replay block made
			// a long session's notices and `!` commands re-render on each rebuild:
			// 1,400 of them turned a 0.7 ms warm Alt+O revisit into 45 ms.
			// Worker mutations invalidate their own entry; only elapsed time needs a tick (#428).
			const cacheable = i >= transcript.length - capacity && (entryIsStable(entry) || entry.role === "worker");
			let rows: string[];
			if (cacheable && cached !== undefined) {
				rows = cached;
			} else {
				entriesRendered += 1;
				rows = renderEntryLines(
					entry,
					width,
					nowMs,
					unboundedToolBodies,
					bareFences,
					copyMarks,
					detail,
					terminalRows,
					previous,
					workerRenderOptions(entry),
					options.getStopRequestedAt?.() ?? null,
					split,
					queuedRows,
				);
				if (cacheable) rememberRender(entry, renderKey, rows);
			}
			const head = split.head;
			// An entry with nothing to show draws no gap either.
			const gap = separated && (rows.length > 0 || (head?.length ?? 0) > 0);
			if (head === undefined && entryIsStable(entry)) {
				const into = openStretch(i);
				into.members.push({ at: into.rows });
				if (gap) into.parts.push(GAP_ROW);
				into.parts.push(rows);
				into.rows += (gap ? 1 : 0) + rows.length;
				if (entry.role === "replayBlock") into.key = heightKey;
			} else {
				closeStretch(i);
				if (gap) emit(GAP_ROW, i);
				// The settled head is the same array while it stands, so a caller holding it skips its rows (#428).
				if (head !== undefined) emit(head, i);
				emit(rows, i);
			}
			i += 1;
		}
		closeStretch(transcript.length);
		runs.replace(nextRuns);
		let shift: number | undefined;
		if (anchor !== null) {
			const span = entryRows(layout, anchor.entry);
			if (span !== null) shift = span.start + Math.min(anchor.offset, Math.max(0, span.end - span.start - 1)) - anchor.top;
		}
		if (scope.relayout !== null) {
			if (!nextRuns.some((run) => !valid(run))) scope.relayout = null;
			else {
				// A run that changed since its replacement was laid out is laid out again.
				scope.relayout.ready = false;
				scheduleRelayout();
			}
		}
		frameLayout = layout;
		cachedRegions = { pieces, rows: total, ...(shift !== undefined ? { shift } : {}) };
		cachedLines = null;
		cachedWidth = width;
		cachedDetail = detail;
		cachedTerminalRows = terminalRows;
		cachedTick = tick;
		cachedDay = day;
		renderedRunningTool = sawRunningTool;
		scope.dirty = false;
		options.onRenderMetrics?.({
			durationMs: performance.now() - startedAt,
			cacheHit: false,
			entriesRendered,
			segmentsRendered: segmentsWalked - walkedBefore,
		});
		schedulePrerender(width, terminalRows, detail.style);
		return cachedRegions;
	};

	/**
	 * One idle step of a viewport-first re-layout: lay the runs still showing an earlier key out again at the job's,
	 * a few milliseconds at a time, and ask for the frame that swaps them in once every one has its replacement.
	 */
	const relayoutStep = (): boolean => {
		syncSkin();
		refreshReceipts();
		const job = scope.relayout;
		if (job === null) return false;
		const deadline = performance.now() + PRERENDER_STEP_MS;
		const stale = (run: EntryRun): boolean => run.key !== job.key && run.key !== job.heightKey;
		const capacity = entryCacheCapacity();
		for (const run of runs.list) {
			if (!stale(run) || job.replacements.has(run)) continue;
			if (job.building?.run !== run) job.building = { run, next: run.from, parts: [], starts: [], rows: 0, key: job.key };
			const building = job.building;
			for (; building.next < run.to; building.next += 1) {
				if (performance.now() >= deadline) return true;
				const index = building.next;
				const entry = transcript[index] as TranscriptEntry;
				const previous = index > 0 ? transcript[index - 1] : undefined;
				const key = entry.role === "replayBlock" ? job.heightKey : job.key;
				let rows = entryRenderCache.get(entry)?.get(key);
				if (rows === undefined) {
					rows = renderEntryLines(
						entry,
						job.width,
						now(),
						unboundedToolBodies,
						bareFences,
						copyMarks,
						job.detail,
						job.terminalRows,
						previous,
						workerRenderOptions(entry),
						null,
						undefined,
						queuedRows,
					);
					if (index >= transcript.length - capacity) rememberRender(entry, key, rows);
				}
				const gap = index > 0 && rows.length > 0 && !stacksUnder(entry, previous, job.detail);
				building.starts.push(building.rows);
				if (gap) building.parts.push(GAP_ROW);
				building.parts.push(rows);
				building.rows += (gap ? 1 : 0) + rows.length;
				if (entry.role === "replayBlock") building.key = job.heightKey;
			}
			job.replacements.set(run, {
				from: run.from,
				to: run.to,
				rows: joinRows(building.parts, building.rows),
				starts: building.starts,
				key: building.key,
			});
			job.building = null;
		}
		job.ready = true;
		job.scheduled = false;
		scope.dirty = true;
		options.requestRender?.();
		return false;
	};
	const scheduleRelayout = (): void => {
		if (scope.relayout === null || scope.relayout.scheduled || options.scheduleIdle === undefined) return;
		scope.relayout.scheduled = true;
		options.scheduleIdle(relayoutStep);
	};

	const prerenderStep = (): boolean => {
		syncSkin();
		// A card rendered ahead must read the view its cached siblings were checked against.
		refreshReceipts();
		const job = scope.prerender;
		if (job === null) {
			prerenderScheduled = false;
			return false;
		}
		const deadline = performance.now() + PRERENDER_STEP_MS;
		let index = Math.max(job.next, transcript.length - entryCacheCapacity());
		let blocked = false;
		for (; index < transcript.length; index += 1) {
			if (performance.now() >= deadline) break;
			const entry = transcript[index];
			if (entry === undefined) continue;
			// Resume here once the entry settles; stepping past it would leave
			// every streamed answer out of the styles rendered ahead.
			if (!entryIsStable(entry)) {
				blocked = true;
				break;
			}
			const aheadMs = now();
			const day = dateLocal(aheadMs);
			for (const style of OUTPUT_STYLE_CYCLE) {
				if (style === job.style) continue;
				const detail = transcriptDetail(style);
				// The same key the frame renders by, local day included.
				const key = `${job.width}|${rowsBudget(detail, job.terminalRows)}|${style}|${day}${entry.role === "replayBlock" ? `|${job.terminalRows}` : ""}`;
				const renders = entryRenderCache.get(entry);
				if (renders?.has(key)) continue;
				const lines = renderEntryLines(
					entry,
					job.width,
					aheadMs,
					unboundedToolBodies,
					bareFences,
					copyMarks,
					detail,
					job.terminalRows,
					transcript[index - 1],
					workerRenderOptions(entry),
					null,
					undefined,
					queuedRows,
				);
				const byKey = renders ?? new Map<string, string[]>();
				byKey.set(key, lines);
				if (byKey.size > RENDERS_PER_ENTRY) {
					const oldestKey = byKey.keys().next().value;
					if (oldestKey !== undefined) byKey.delete(oldestKey);
				}
				if (renders === undefined) entryRenderCache.set(entry, byKey);
			}
		}
		job.next = index;
		const more = !blocked && index < transcript.length;
		if (!more) prerenderScheduled = false;
		return more;
	};
	const schedulePrerender = (width: number, terminalRows: number, style: OutputStyle): void => {
		if (options.scheduleIdle === undefined || unboundedToolBodies) return;
		if (
			scope.prerender === null ||
			scope.prerender.width !== width ||
			scope.prerender.terminalRows !== terminalRows ||
			scope.prerender.style !== style
		) {
			scope.prerender = { width, terminalRows, style, next: 0 };
		} else if (scope.prerender.next >= transcript.length) {
			return;
		}
		if (prerenderScheduled) return;
		prerenderScheduled = true;
		options.scheduleIdle(prerenderStep);
	};

	/**
	 * The whole frame as one array, built once per changed frame with a single
	 * exact-size copy. A cache hit returns the same array, which callers use as
	 * the signal that nothing moved.
	 */
	const render = (width: number): string[] => {
		const regions = renderFrame(width);
		cachedLines ??=
			regions.pieces.length === 1 ? (regions.pieces[0] as string[]) : joinRows(regions.pieces, regions.rows);
		return cachedLines;
	};

	return { renderFrame, render };
}
