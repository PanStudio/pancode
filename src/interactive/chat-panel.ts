import type { OutputStyle } from "../core/defaults.js";
import type { ViewArtifact } from "../domains/session/view-artifacts.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { Component } from "../engine/tui.js";
import type { ChatLoopEvent } from "../session-control/chat-loop.js";
import type { WorkerEntryState } from "../session-control/worker-stream.js";
import { renderUserLines } from "./chat-entry-rows.js";
import { PROSE_GUTTER_WIDTH } from "./chat-ink.js";
import { renderTextSegmentLines } from "./chat-markdown.js";
import { createChatCache } from "./chat-panel/cache.js";
import { createChatEvents } from "./chat-panel/events.js";
import { createChatFrame } from "./chat-panel/frame.js";
import { collectInspectionArtifacts } from "./chat-panel/inspection.js";
import { createChatReceipts } from "./chat-panel/receipts.js";
import { createChatRunSettle } from "./chat-panel/run-settle.js";
import type { ChatPanelScope } from "./chat-panel/scope.js";
import { createChatSegments } from "./chat-panel/segments.js";
import { createChatToolEvents } from "./chat-panel/tool-events.js";
import { createChatWorkers } from "./chat-panel/workers.js";
import { changeSettledCall } from "./chat-tool-rows.js";
import {
	findToolSegmentOwner,
	type LiveTextRender,
	type ReplayBlockRenderer,
	type TranscriptEntry,
	type UserTurnStatus,
	type WorkerTranscriptEntry,
	workerGroupKey,
} from "./chat-transcript-model.js";
import type { ToolExecutionFinished } from "./renderers/tool-call-model.js";
import { renderToolPreview } from "./renderers/tool-execution.js";
import { type TranscriptDetailPolicy, transcriptDetail } from "./transcript-detail.js";
import { EntryRuns, type TranscriptViewport } from "./transcript-runs.js";

/**
 * What a replayed run end knows that a live one measures: the duration from
 * the ledger's timestamps and the cold-cache reasons its first call recorded.
 */
export interface ReplayedRunFacts {
	elapsedMs?: number;
	coldReasons?: ReadonlyArray<string>;
	/** Of `elapsedMs`, what the live run recorded waiting on the operator. */
	humanWaitMs?: number;
	/** Epoch ms of the run's terminal ledger entry; absent when the ledger recorded no usable time. */
	endedAtMs?: number;
	/** Workers whose start entry and receipt place them still running at `endedAtMs`. */
	workersRunning?: number;
	/** The runs of those workers, whose calls the turn's receipt leaves out. */
	workerRunIdsRunning?: ReadonlyArray<string>;
}

export interface ChatPanelRenderMetrics {
	durationMs: number;
	cacheHit: boolean;
	entriesRendered: number;
	/** Assistant segments the frame walked; a live turn's settled head is reused without walking its segments. */
	segmentsRendered: number;
}

/**
 * One transcript frame as row pieces in screen order: a run of settled entries, a live entry's leading gap, a live
 * turn's settled head, its open rows. A piece the frame reused is the very array an earlier frame returned, so a caller
 * that keeps its own row buffer skips a piece it already holds at the same row; a piece rendered for this frame is a
 * new array, which may vouch through `keptRows` for the leading rows it shares with the piece an earlier frame put at
 * that row. No piece is mutated after it is returned, and a frame with nothing new returns the same object.
 */
export interface ChatPanelRegions {
	pieces: readonly (readonly string[])[];
	/** The rows of every piece together. */
	rows: number;
	/**
	 * Set on a frame that re-laid out history around the viewport it was given: how many rows the row at the
	 * viewport's top moved by since the frame before. A view scrolled up moves by as much to keep showing it.
	 */
	shift?: number;
}

export interface ChatPanel extends Component {
	/**
	 * Paint an operator turn. `status`, when given, is read every frame while it
	 * reports anything but `committed`, so the row the transcript shows before
	 * admission is visibly not the durable turn it will become.
	 */
	appendUser(text: string, status?: () => UserTurnStatus, origin?: string): void;
	/** Something else was submitted since the last failed turn, so ↑ no longer recalls that turn's prompt. */
	forgetPromptRecall(): void;
	/**
	 * Append a caller-rendered block. Pass `isLive` when the closure reads state
	 * that keeps changing after the append, so the panel keeps re-rendering it
	 * instead of treating the first frame as final.
	 */
	appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean): void;
	applyEvent(event: ChatLoopEvent): void;
	/** The target a replay's next messages ran on, from the ledger's own route changes. */
	replayRoute?(targetId: string | null): void;
	/** Mark a just-rehydrated tool segment so its mutation diff remains plain. */
	markToolReplayed?(toolCallId: string): void;
	/**
	 * Stamp what a replay appends with the time of the ledger entry it replays;
	 * undefined returns to the live clock. `/view` states each act's age from it.
	 */
	replayAt?(timestampMs: number | undefined): void;
	/**
	 * Place or refresh a worker's block. The first call for an assignment
	 * inserts the entry (agent origin nests under the tool segment named by
	 * `state.parentToolCallId`, everything else appends); later calls only
	 * invalidate the render, because the reducer mutates the same state object.
	 */
	applyWorkerState(state: WorkerEntryState): void;
	/**
	 * Every worker block on the transcript, oldest first, live or replayed.
	 * `/share` selects from this rather than from the reducer's routing table,
	 * so what the operator can share is exactly what the operator can see.
	 */
	workerStates(): ReadonlyArray<WorkerEntryState>;
	inspectionArtifacts(): ViewArtifact[];
	/** Whether the current preset shows supplied reasoning, for stream pacing. */
	isThinkingExpanded(): boolean;
	/** The newest layout of the reply's open text segment; null once it settles or before its first frame. */
	liveTextRender(): LiveTextRender | null;
	/** The frame `render` would return, as the row pieces it is made of, laid out first around `viewport`. */
	renderRegions(width: number, viewport?: TranscriptViewport): ChatPanelRegions;
	/** Clears the visible transcript. /new uses this after rotating the session. */
	reset(): void;
}

export interface ChatPanelOptions {
	getTerminalRows?: () => number;
	/** When the operator asked the running turn to stop, on the panel's clock; null while no stop is pending. */
	getStopRequestedAt?: () => number | null;
	/** The target the running turn was sent to, which the wire protocol on its messages does not say. */
	getRunTarget?: () => string | null;
	/** The model the running turn was sent to; a first reply from that route needs no `Reply from` row. */
	getRunModel?: () => string | null;
	/** What the current turn has spent on an operator-owned wait, which its receipt keeps apart from work. */
	getHumanWaitMs?: () => number;
	/** Keeps a settled run's measured duration and operator wait in the session, so its resumed receipt reads the same. */
	recordTurnTiming?: (fields: { turnId: string; elapsedMs: number; humanWaitMs?: number }) => void;
	/** True while the transient Fleet band or visible Watch pane owns live per-worker progress. */
	fleetOwnsLiveProgress?: () => boolean;
	/** The telemetry read model's live view, whose turn quantities each turn's receipt reads (#434 §11.3). */
	getTelemetry?: () => TelemetryView | null;
	/** Live transcript detail mode. Settings changes take effect on the next frame. */
	getOutputStyle?: () => OutputStyle;
	/** Receives measured panel render cost; no FPS claim is made by the panel. */
	onRenderMetrics?: (metrics: ChatPanelRenderMetrics) => void;
	/** Clock injection for deterministic duration tests. Defaults to Date.now. */
	now?: () => number;
	/**
	 * Render every expanded tool body in full, without the live view's
	 * middle-elision or character truncation. `/export` builds a throwaway panel
	 * with this set so the written transcript reproduces the complete tool output
	 * instead of the terminal's bounded view.
	 */
	unboundedToolBodies?: boolean;
	/**
	 * Draw a top-level fenced code block as its language word over its code rows,
	 * without the literal fence rows Pi's Markdown adds, which the live transcript
	 * keeps. `/export` sets it so the written file carries no fence rows of its own
	 * to close its outer fence early or show as border characters in HTML.
	 */
	bareCodeFences?: boolean;
	/**
	 * Mark each answer row with an invisible copy mark that says whether it
	 * continues the row above, so a fullscreen selection copies a wrapped
	 * paragraph as one line without the turn glyph or the gutter (#453). Only the
	 * fullscreen renderer reads and strips the marks; the regular screen, where
	 * the terminal owns selection, never gets them.
	 */
	copyMarks?: boolean;
	/**
	 * Run `step` when the process is otherwise idle, again after each call that
	 * returns true. The panel uses it to render settled entries in the two
	 * output styles it is not showing, a few milliseconds at a time, so the
	 * first Alt+O into a style is as cheap as a return to one. Omitted, nothing
	 * is rendered ahead.
	 */
	scheduleIdle?: (step: () => boolean) => void;
	/**
	 * Re-lay out history viewport-first when the width, height budget or output style changes: the entries within a
	 * screen of the viewport render in that frame, every other settled row keeps its old layout, and idle steps
	 * through `scheduleIdle` re-lay out the rest, swapped in together, with the viewport kept on its row. Without it,
	 * or without `scheduleIdle`, a layout change renders every entry in its frame.
	 */
	deferRelayout?: boolean;
	/** Ask for a frame when the panel changes outside an event, as when an edit's diff finishes computing. */
	requestRender?: () => void;
	/**
	 * The live card this process still streams for a run a replay finds underway. A fork or resume taken while a worker
	 * runs replays its card from the ledger, which knows only that it started; the live one keeps streaming and settles.
	 */
	adoptLiveWorker?: (runId: string) => WorkerEntryState | undefined;
}

const WARM_ANSWER = [
	"## Warm",
	"",
	"A paragraph with **bold**, `code`, a [link](https://example.com) and $x^2$.",
	"",
	"- one item",
	"- another item",
	"",
	"```ts",
	'export const answer = 42; // "warm"',
	"```",
].join("\n");

/**
 * Render one representative answer and one action row of each common kind
 * through the transcript's own renderers, in every output style, and throw the
 * rows away. The first Markdown render in a process pays for the lexer, the
 * LaTeX extension, code ink and the compiler: 13 to 17 ms measured in a fresh
 * process, against 0.06 ms warm. Paid mid-stream, that was a stall in the
 * first paragraph of the first answer, and the p99 streamed frame of a short
 * session. Call once after the first hydrated frame, never while streaming.
 */
export function warmTranscriptRender(width: number): void {
	const safeWidth = Math.max(20, Math.floor(width));
	renderUserLines("Warm the transcript.", safeWidth, "committed");
	renderTextSegmentLines({ kind: "text", text: WARM_ANSWER, finalized: true }, safeWidth - PROSE_GUTTER_WIDTH, false);
	const calls: ToolExecutionFinished[] = [
		{
			toolCallId: "warm-read",
			toolName: "read",
			args: { path: "src/index.ts" },
			result: { content: [{ type: "text", text: "1  export const a = 1;" }], details: {} },
			isError: false,
			durationMs: 4,
		},
		{
			toolCallId: "warm-bash",
			toolName: "bash",
			args: { command: "pnpm test" },
			result: { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } },
			isError: false,
			durationMs: 900,
		},
		{
			toolCallId: "warm-edit",
			toolName: "edit",
			args: { path: "src/index.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] },
			result: {
				content: [{ type: "text", text: "Edited src/index.ts" }],
				details: { diff: "-1 export const a = 1;\n+1 export const a = 2;" },
			},
			isError: false,
			durationMs: 6,
		},
	];
	for (const style of ["standard", "compact", "detailed"] as const) {
		const detail = transcriptDetail(style);
		for (const call of calls) renderToolPreview(call, safeWidth, detail);
	}
}

export function createChatPanel(options: ChatPanelOptions = {}): ChatPanel {
	const transcript: TranscriptEntry[] = [];
	/** Assignment to its placed block, in placement order, so a streaming delta is O(1) to route. */
	const workerEntries = new Map<string, WorkerTranscriptEntry>();
	const dispatchGroups = new Map<string, WorkerTranscriptEntry[]>();
	/**
	 * Receipts still reading the read model. A run can end before the writer's batch holding its last call is folded,
	 * and a worker it started can settle later, so a receipt rereads its turn on every new view until the view holds
	 * the run's own calls and no run of the turn is still going (#434 §11.3).
	 */
	const liveReceipts = new Set<Extract<TranscriptEntry, { role: "assistant" }>>();
	/** The `isLive` of each replay block still reporting live, so the frame after one settles is never a cache hit. */
	const liveReplayBlocks = new Set<() => boolean>();
	/**
	 * Each stable entry keeps its render for the last few layout keys (width,
	 * height budget, style). Alt+O cycles three styles, and holding one render
	 * per entry made every switch re-render the whole transcript, including a
	 * switch back to the style shown a moment earlier.
	 */
	const entryRenderCache = new Map<TranscriptEntry, Map<string, string[]>>();
	/**
	 * Per-entry row regions: every stretch of settled entries between two live ones is joined once into a run, which
	 * a frame hands on by identity, so a dirty frame renders only the live entries and walks one step per run. A live
	 * entry anywhere (a worker card still running near the top of a long session) ends a run without stopping the
	 * runs behind it, and an invalidated entry gives up only its own rows. A live turn's settled head (#428) is its own
	 * piece, the same array while the head stands, so a turn streaming thousands of messages hands on only its open
	 * rows. Renderers still receive every row: the regular screen keeps all of them in `previousLines`, and the
	 * fullscreen ScrollView lays out and searches the whole document; the pieces let both skip what they hold.
	 */
	const runs = new EntryRuns();

	const now = (): number => options.now?.() ?? Date.now();
	const messageTarget = (): string | null =>
		scope.replayStampMs !== undefined ? scope.replayTarget : (options.getRunTarget?.() ?? null);
	const stamp = (): number => scope.replayStampMs ?? now();
	const currentDetail = (): TranscriptDetailPolicy => transcriptDetail(options.getOutputStyle?.());
	const scope: ChatPanelScope = {
		options,
		transcript,
		entryRenderCache,
		runs,
		dirty: true,
		relayout: null,
		prerender: null,
		dispatchGroups,
		runStartIndex: undefined,
		get cache() {
			return cache;
		},
		workerEntries,
		liveReceipts,
		receiptView: null,
		promptRecallReceipt: null,
		get workers() {
			return workers;
		},
		now,
		replayStampMs: undefined,
		replayTarget: null,
		messageTarget,
		stamp,
		currentDetail,
		get receipts() {
			return receipts;
		},
		requestingModel: undefined,
		get segments() {
			return segments;
		},
		runStartedAt: undefined,
		runColdReasons: [],
		runAwaitingRetry: false,
		runRetries: 0,
		runProviderWaits: 0,
		runMovedTo: undefined,
		runTurnId: undefined,
		lastSettledReceipt: null,
		get toolEvents() {
			return toolEvents;
		},
		liveReplayBlocks,
		get runSettle() {
			return runSettle;
		},
		pendingPrompt: undefined,
		get frame() {
			return frame;
		},
		get events() {
			return events;
		},
	};
	const cache = createChatCache(scope);
	const { markDirty, invalidateEntryCache, clearRenderCaches } = cache;
	const workers = createChatWorkers(scope);
	const { telemetryShown, markCancelledDispatch, findSpawningCall, workerInsertionIndex } = workers;
	const receipts = createChatReceipts(scope);
	const { forgetPromptRecall } = receipts;
	const segments = createChatSegments(scope);
	const { insertEntryAt, appendRow } = segments;
	const toolEvents = createChatToolEvents(scope);
	const runSettle = createChatRunSettle(scope);
	const frame = createChatFrame(scope);
	const { renderFrame, render } = frame;
	const events = createChatEvents(scope);
	const { applyEvent } = events;

	return {
		forgetPromptRecall,
		appendUser(text: string, status?: () => UserTurnStatus, origin?: string): void {
			// A prompt opens the next turn, whose retries are not the last receipt's.
			scope.lastSettledReceipt = null;
			// ↑ now recalls this prompt, so the failed receipt above stops offering its own.
			forgetPromptRecall();
			// A prompt typed while a run is open waits its turn; only one between runs starts the next clock.
			if (scope.runStartIndex === undefined && scope.replayStampMs === undefined)
				scope.pendingPrompt = { at: now(), ...(status ? { status } : {}) };
			appendRow({
				role: "user",
				text,
				at: stamp(),
				...(status ? { status } : {}),
				...(origin !== undefined ? { origin } : {}),
			});
			markDirty();
		},
		appendReplayBlock(renderBlock: ReplayBlockRenderer, isLive?: () => boolean): void {
			if (isLive !== undefined) liveReplayBlocks.add(isLive);
			appendRow({ role: "replayBlock", renderBlock, at: stamp(), isLive });
			markDirty();
		},
		applyWorkerState(placed: WorkerEntryState): void {
			const state = placed.result?.stillRunning === true ? (options.adoptLiveWorker?.(placed.runId) ?? placed) : placed;
			const existing = workerEntries.get(state.assignmentId);
			if (existing !== undefined) {
				// The reducer mutated the same state object this entry already holds,
				// so nothing is re-linked; only the cached render is now stale.
				invalidateEntryCache(existing);
				const key = workerGroupKey(state);
				const group = key === undefined ? [] : (dispatchGroups.get(key) ?? []);
				const lead = group[0];
				if (lead !== undefined && lead !== existing) invalidateEntryCache(lead);
				// A council round's header reads every member of the round, whichever card it sits on.
				const council = state.council;
				if (council !== undefined)
					for (const member of group)
						if (member !== existing && member.state.council?.round === council.round) invalidateEntryCache(member);
				markCancelledDispatch(state.parentToolCallId);
				markDirty();
				return;
			}
			const entry: WorkerTranscriptEntry = {
				role: "worker",
				state,
				at: stamp(),
				telemetryShown: telemetryShown(state, options.getTelemetry?.() ?? null),
			};
			workerEntries.set(state.assignmentId, entry);
			const groupKey = workerGroupKey(state);
			if (groupKey !== undefined) {
				const siblings = dispatchGroups.get(groupKey) ?? [];
				for (const sibling of siblings) invalidateEntryCache(sibling);
				siblings.push(entry);
				dispatchGroups.set(groupKey, siblings);
			}
			// The card is the run's row from here on: the call that spawned it drops
			// the task and outcome it would otherwise state. A helper's `↳` row is
			// the run's row too when a dispatch started it (the model's shadow
			// scout); under any other call it stays beside that call's own output.
			const parent = state.parentToolCallId === undefined ? undefined : findSpawningCall(state.parentToolCallId);
			const attaches = state.helper !== true || parent?.segment.name === "dispatch";
			if (parent !== undefined && attaches && parent.segment.cardAttached !== true) {
				parent.segment.cardAttached = true;
				changeSettledCall(parent.segment);
				invalidateEntryCache(parent.entry);
			}
			const at = workerInsertionIndex(state);
			if (at === null) appendRow(entry);
			else insertEntryAt(at, entry);
			markDirty();
		},
		workerStates(): ReadonlyArray<WorkerEntryState> {
			return [...workerEntries.values()].map((entry) => entry.state);
		},
		inspectionArtifacts(): ViewArtifact[] {
			return collectInspectionArtifacts(scope);
		},
		isThinkingExpanded(): boolean {
			return currentDetail().reasoningRows > 0;
		},
		liveTextRender(): LiveTextRender | null {
			for (let index = transcript.length - 1; index >= 0; index -= 1) {
				const entry = transcript[index];
				if (entry?.role !== "assistant") continue;
				const tail = entry.segments[entry.segments.length - 1];
				return tail?.kind === "text" && !tail.finalized ? (tail.liveRender ?? null) : null;
			}
			return null;
		},
		reset(): void {
			transcript.length = 0;
			scope.lastSettledReceipt = null;
			liveReceipts.clear();
			liveReplayBlocks.clear();
			scope.receiptView = null;
			scope.runTurnId = undefined;
			scope.runStartedAt = undefined;
			scope.pendingPrompt = undefined;
			scope.runStartIndex = undefined;
			scope.runAwaitingRetry = false;
			scope.runRetries = 0;
			scope.runProviderWaits = 0;
			scope.runMovedTo = undefined;
			scope.runColdReasons = [];
			workerEntries.clear();
			dispatchGroups.clear();
			clearRenderCaches();
			markDirty();
		},
		replayRoute(targetId: string | null): void {
			scope.replayTarget = targetId;
		},
		replayAt(timestampMs: number | undefined): void {
			if (timestampMs === undefined) scope.replayTarget = null;
			scope.replayStampMs =
				timestampMs !== undefined && Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : undefined;
		},
		markToolReplayed(toolCallId: string): void {
			const owner = findToolSegmentOwner(transcript, toolCallId);
			if (!owner || owner.segment.finished) return;
			invalidateEntryCache(owner.entry);
			owner.segment.replayed = true;
			markDirty();
		},
		applyEvent,
		render,
		renderRegions: renderFrame,
		invalidate(): void {
			markDirty();
		},
	};
}
