// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { performance } from "node:perf_hooks";
import { assistantMessageNeverSent, assistantModelLabel } from "../core/assistant-model.js";
import { sanitizeAssistantProse } from "../core/assistant-prose.js";
import type { OutputStyle } from "../core/defaults.js";
import { isNarrationSummary } from "../core/narration-summary.js";
import { ToolNames } from "../core/tool-names.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import { settledPrefixLength } from "../engine/apis/diffusion-frames.js";
import { type Component, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../lib/call-target/call-target.js";
import {
	holdCutOffText,
	holdUnresolvedStrings,
	holdUnresolvedUserinfo,
	messageStopCompleted,
	redactSecretString,
} from "../lib/secrets/redaction.js";
import type { ChatLoopEvent, RetryStatusPayload } from "../session-control/chat-loop.js";
import {
	classifyTurnEnding,
	endedOnCancelledInterview,
	endedWithFailedChange,
	proseBeforeWrittenCalls,
} from "../session-control/chat-loop-messages.js";
import type { ViewArtifact } from "../session-control/view-artifacts.js";
import type { WorkerEntryState } from "../session-control/worker-stream.js";
import {
	GAP_ROW,
	type LiveSplit,
	renderEntryLines,
	renderUserLines,
	rowsBudget,
	segmentsWalked,
	stacksUnder,
} from "./chat-entry-rows.js";
import { PROSE_GUTTER_WIDTH } from "./chat-ink.js";
import { renderTextSegmentLines } from "./chat-markdown.js";
import {
	changeSettledCall,
	finishedCall,
	type QueuedRows,
	queuedRunRows,
	shownArgs,
	unplacedTasks,
} from "./chat-tool-rows.js";
import {
	appendSegmentText,
	assistantThinkingRedacted,
	detachUnsentModel,
	entryHasRunningTool,
	entryIsStable,
	extractAssistantTerminalError,
	extractAssistantText,
	extractAssistantThinking,
	findToolSegmentOwner,
	type LiveTextRender,
	lastAssistantIndex,
	openThinkingSegment,
	type ReplayBlockRenderer,
	replaceSegmentText,
	reportsCall,
	runCallIds,
	runStartFallback,
	scopeTerminalErrorAfterSuccessfulTool,
	type TextSegment,
	type ToolSegment,
	type TranscriptEntry,
	toolSettlement,
	turnRetryRow,
	type UserTurnStatus,
	type WorkerTranscriptEntry,
	workerGroupKey,
} from "./chat-transcript-model.js";
import { turnEndedWithWorkers } from "./chat-turn-receipt.js";
import { routeFirstOutput } from "./footer/silence-note.js";
import { dateLocal } from "./format-time.js";
import { editPreviewDiff } from "./mutation-preview.js";
import { renderNoticeRow, renderTranscriptNotice } from "./renderers/notice.js";
import {
	type ProviderFailureRoute,
	providerErrorEvidence,
	readProviderFailureRoute,
} from "./renderers/provider-error.js";
import { renderRetryStatus } from "./renderers/retry-status.js";
import { renderSkillSurfaceRow } from "./renderers/skill-rows.js";
import { approvalAxisText } from "./renderers/tool-approval-cards.js";
import type { ToolExecutionFinished } from "./renderers/tool-call-model.js";
import { renderToolExecution, renderToolPreview } from "./renderers/tool-execution.js";
import { isChangeOrCheckCall } from "./renderers/tool-fold.js";
import { toolRowTitle } from "./renderers/tool-subline.js";
import type { WorkerEntryRenderOptions } from "./renderers/worker-entry.js";
import { renderWorkerEntryLines, workerTelemetryDisplay } from "./renderers/worker-entry.js";
import { isGenerationGuardAbort } from "./status/index.js";
import { GLYPH } from "./theme/index.js";
import { modelNickname } from "./theme/labels.js";
import { skinEpoch } from "./theme/tokens.js";
import { type TranscriptDetailPolicy, transcriptDetail } from "./transcript-detail.js";
import {
	type EntryRun,
	EntryRuns,
	entryRows,
	joinRows,
	type PlacedPiece,
	type TranscriptViewport,
	viewportWindow,
} from "./transcript-runs.js";
import { turnHoldsCalls, turnSpend } from "./turn-spend.js";

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

const OUTPUT_STYLE_CYCLE: readonly OutputStyle[] = ["compact", "standard", "detailed"];

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
	/** A retry rebinds a card to a new run on the same state object, so the run id is part of what it shows. */
	const telemetryShown = (state: WorkerEntryState, view: TelemetryView | null): string =>
		`${state.runId}\0${options.fleetOwnsLiveProgress?.() === true ? "1" : "0"}\0${workerTelemetryDisplay(view?.run(state.runId) ?? null)}`;
	const dispatchGroups = new Map<string, WorkerTranscriptEntry[]>();
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
	let dirty = true;
	let renderedSkinEpoch = skinEpoch();
	let runStartedAt: number | undefined;
	// The prompt that opens the next run: its clock starts here, so a compaction the submit runs before the model
	// call is inside the turn's duration, as its calls and tokens are.
	let pendingPrompt: { at: number; status?: () => UserTurnStatus } | undefined;
	/** Why the current run's prompt cache may be cold, from the chat loop's cache notice. */
	let runColdReasons: ReadonlyArray<string> = [];
	/**
	 * Transcript index where the current run's entries begin. A worker block or
	 * a mid-turn notice splits one run across several assistant entries, and
	 * each entry keeps the per-message receipt its last `message_end` gave it;
	 * `agent_end` clears every one of them except the entry that carries the run
	 * total, so a receipt never lands in the middle of a turn.
	 */
	let runStartIndex: number | undefined;
	/** The run's last attempt failed and recovery will send another, so nothing has settled yet. */
	let runAwaitingRetry = false;
	/** Provider attempts this run sent again, kept until its receipt can state them. */
	let runRetries = 0;
	let runProviderWaits = 0;
	let runMovedTo: string | undefined;
	/** The model the newest assistant message came from: the requester of the calls that follow it. */
	let requestingModel: string | undefined;
	/** The operator turn the current run's calls journal under, from its start event or a replayed run end. */
	let runTurnId: string | undefined;
	/**
	 * Receipts still reading the read model. A run can end before the writer's batch holding its last call is folded,
	 * and a worker it started can settle later, so a receipt rereads its turn on every new view until the view holds
	 * the run's own calls and no run of the turn is still going (#434 §11.3).
	 */
	const liveReceipts = new Set<Extract<TranscriptEntry, { role: "assistant" }>>();
	let receiptView: TelemetryView | null = null;
	/** The latest settled receipt eligible for the turn's post-settlement prewarm record. */
	let lastSettledReceipt: Extract<TranscriptEntry, { role: "assistant" }> | null = null;
	let promptRecallReceipt: Extract<TranscriptEntry, { role: "assistant" }> | null = null;
	const forgetPromptRecall = (): void => {
		if (promptRecallReceipt?.turnUsage) {
			delete promptRecallReceipt.turnUsage.promptRecall;
			invalidateEntryCache(promptRecallReceipt);
		}
		promptRecallReceipt = null;
	};
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
	/** The `isLive` of each replay block still reporting live, so the frame after one settles is never a cache hit. */
	const liveReplayBlocks = new Set<() => boolean>();
	/**
	 * Each stable entry keeps its render for the last few layout keys (width,
	 * height budget, style). Alt+O cycles three styles, and holding one render
	 * per entry made every switch re-render the whole transcript, including a
	 * switch back to the style shown a moment earlier.
	 */
	const entryRenderCache = new Map<TranscriptEntry, Map<string, string[]>>();
	const RENDERS_PER_ENTRY = 3;
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
	const entryCacheCapacity = (): number =>
		Math.max(MIN_ENTRY_RENDER_CACHE, Math.min(MAX_ENTRY_RENDER_CACHE, transcript.length));
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
	/** Where the last frame's pieces sit, so a re-layout can find the entries around the viewport. */
	let frameLayout: readonly PlacedPiece[] = [];
	/**
	 * A viewport-first re-layout under way (`deferRelayout`): runs laid out at an earlier key stay on screen while
	 * idle steps lay out each one again at `key`, into `replacements`; the frame after the last one swaps them all
	 * in. A newer key starts over. `building` is the run part way through.
	 */
	let relayout: {
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
	} | null = null;
	const deferRelayout = options.deferRelayout === true && options.scheduleIdle !== undefined;
	const unboundedToolBodies = options.unboundedToolBodies === true;
	const bareFences = options.bareCodeFences === true;
	const copyMarks = options.copyMarks === true && !bareFences;
	/**
	 * Settled entries are rendered ahead, in idle time, in the styles Alt+O
	 * cycles to, into the same per-entry cache a revisit reads. A first visit to
	 * a style used to render every entry on the keystroke: 195 ms at 2,000
	 * entries, against about 1 ms for a style already shown. `next` is the first
	 * entry not yet rendered ahead; an invalidation or an insertion behind it
	 * moves it back. Each step spends at most a few milliseconds, and the
	 * scheduler runs steps only while nothing streams.
	 */
	let prerender: { width: number; terminalRows: number; style: OutputStyle; next: number } | null = null;
	let prerenderScheduled = false;
	const PRERENDER_STEP_MS = 3;

	const markDirty = (): void => {
		dirty = true;
	};
	/**
	 * An edit whose arguments have closed shows the diff it will make before its
	 * result lands. The file is read off the event path; the frame that shows
	 * the diff is requested when it is ready. Replay never reads files: its
	 * calls are settled and carry the tool's own diff.
	 */
	const startEditPreview = (seg: ToolSegment): void => {
		if (seg.previewRequested || seg.finished || seg.name !== ToolNames.Edit || replayStampMs !== undefined) return;
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
	const invalidateEntryCache = (entry: TranscriptEntry): void => {
		entryRenderCache.delete(entry);
		if (runs.list.length === 0 && prerender === null) return;
		// From the end: what changes is nearly always the live tail, and this runs per streamed delta.
		const index = transcript.lastIndexOf(entry);
		if (index >= 0) runs.release(index);
		// A worker row's gap reads the entry above it (`spawnedAtTail`), so a change there lays the worker out again.
		if (index >= 0 && entry.role === "assistant" && transcript[index + 1]?.role === "worker") runs.release(index + 1);
		if (prerender !== null && index >= 0 && index < prerender.next) prerender.next = index;
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
		if (view === receiptView && !fleetOwnedChanged) return;
		receiptView = view;
		for (const entry of workerEntries.values()) {
			const shown = telemetryShown(entry.state, view);
			if (shown === entry.telemetryShown) continue;
			entry.telemetryShown = shown;
			invalidateEntryCache(entry);
			dirty = true;
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
	/** Full drop of both render caches; used by the toggle paths that touch many entries. */
	const clearRenderCaches = (): void => {
		entryRenderCache.clear();
		runs.clear();
		relayout = null;
		if (prerender !== null) prerender.next = 0;
	};
	const syncSkin = (): void => {
		if (renderedSkinEpoch === skinEpoch()) return;
		renderedSkinEpoch = skinEpoch();
		clearRenderCaches();
		dirty = true;
	};
	/**
	 * A mutation is about to land on the tail entry without an explicit
	 * invalidation. If a run covers that entry, the run gives up its rows.
	 */
	const unfreezeTail = (): void => {
		if (transcript.length > 0) runs.release(transcript.length - 1);
	};

	const now = (): number => options.now?.() ?? Date.now();
	/**
	 * When an entry or action happened. Live, that is now; a replay pins it to
	 * the ledger entry being replayed, so `/view` states the age of the act and
	 * not of the resume.
	 */
	let replayStampMs: number | undefined;
	let replayTarget: string | null = null;
	const messageTarget = (): string | null =>
		replayStampMs !== undefined ? replayTarget : (options.getRunTarget?.() ?? null);
	const stamp = (): number => replayStampMs ?? now();
	const currentDetail = (): TranscriptDetailPolicy => transcriptDetail(options.getOutputStyle?.());

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
		const runStart = runStartIndex ?? runStartFallback(transcript, transcript.length);
		for (let entryIndex = transcript.length - 1; entryIndex >= runStart; entryIndex -= 1) {
			const entry = transcript[entryIndex];
			if (entry?.role !== "assistant") continue;
			for (const segment of entry.segments) {
				if (segment.kind === "tool" && segment.id === toolCallId) return { segment, entry };
			}
		}
		return undefined;
	};

	/** The attempts a retry status says went out again. A live run hears of its recovery after its receipt, a replay before. */
	const noteRunRetries = (status: RetryStatusPayload): void => {
		const whole = status.phase === "retrying" || status.phase === "recovered" || status.phase === "exhausted";
		if (whole || status.phase === "cancelled") {
			// A cancel stopped one attempt before it went out, and that attempt is a wait or a retry by what it answered.
			const waits = status.providerWaits ?? 0;
			const unsentWait = status.phase === "cancelled" && status.onProviderWait === true ? 1 : 0;
			const unsentRetry = status.phase === "cancelled" && status.onProviderWait !== true ? 1 : 0;
			runProviderWaits = Math.max(runProviderWaits, waits - unsentWait);
			runRetries = Math.max(runRetries, status.attempt - waits - unsentRetry);
		}
		const receipt = lastSettledReceipt;
		const usage = receipt?.turnUsage;
		if (receipt && usage && (runRetries > (usage.retries ?? 0) || runProviderWaits > (usage.providerWaits ?? 0))) {
			invalidateEntryCache(receipt);
			receipt.turnUsage = {
				...usage,
				...(runRetries > 0 ? { retries: runRetries } : {}),
				...(runProviderWaits > 0 ? { providerWaits: runProviderWaits } : {}),
			};
		}
	};

	/**
	 * Nothing the run left open keeps counting: no tool can still be executing anywhere in the transcript, not just in
	 * the tail entry (a mid-turn notice splits entries). Settle any tool segment whose `tool_execution_end` never arrived
	 * (blocked at admission, or cut off by an abort) so the ledger never leaves a running line counting past the turn's
	 * end, and clear `pending` everywhere so no earlier entry keeps rendering live thinking or status.
	 */
	const closeRunEntries = (aborted: boolean): void => {
		for (const entry of transcript) {
			if (entry.role !== "assistant") continue;
			for (const seg of entry.segments) {
				if (seg.kind === "tool" && !seg.finished) {
					invalidateEntryCache(entry);
					settleUnfinishedToolSegment(seg, aborted ? "aborted" : "orphaned");
				}
			}
			if (entry.pending) {
				invalidateEntryCache(entry);
				// A message that settled closed its own reasoning, so this one never got a stop reason.
				closeOpenThinking(entry, false);
				entry.pending = false;
				entry.messageStartSegmentIndex = undefined;
			}
		}
		// An entry opened for a message that never showed anything renders no rows, yet it would still draw a separator.
		for (let tail = transcript.at(-1); tail?.role === "assistant"; tail = transcript.at(-1)) {
			if (tail.turnUsage !== undefined || tail.models?.length) break;
			if (tail.segments.some((segment) => segment.kind !== "text" || segment.text.trim().length > 0)) break;
			transcript.pop();
			entryRenderCache.delete(tail);
			runs.truncate(transcript.length);
		}
	};

	/**
	 * Give the run its one receipt and close it. It touches many entries, but it names every one it touches: the usage
	 * caption's target, the later entries whose caption it removes, and any entry it settles or un-pends. Each is
	 * invalidated at the point of mutation instead of dropping the whole cache and re-rendering settled history.
	 */
	const settleRun = (run: {
		messages: ReadonlyArray<unknown>;
		turnId: string | undefined;
		replayed?: ReplayedRunFacts | undefined;
		/** The outcome when no message states it: the ladder ended between attempts. */
		outcome?: string;
		always?: boolean;
	}): void => {
		lastSettledReceipt = null;
		runAwaitingRetry = false;
		const { messages, turnId, replayed } = run;
		const ending = run.outcome === undefined ? classifyTurnEnding(messages as ReadonlyArray<AgentMessage>) : null;
		// A provider that reports no usage still owes the operator the news that nothing answered.
		if (
			run.always === true ||
			messages.some(reportsCall) ||
			ending?.kind === "no_answer" ||
			ending?.kind === "call_not_run"
		) {
			// The usage line is a caption on rendered output, so it goes on the
			// last entry that rendered any. A mid-turn notice splits entries, and
			// a turn that stops after one leaves an empty tail entry behind: the
			// run total landed there while the entry above kept its own
			// message_end line, so one turn printed the identical line twice, once
			// on each side of the notice. Entries after the caption rendered
			// nothing and must not carry a second copy.
			// Only this run's rows can carry its receipt. A run cut off before any output has none, and the previous
			// turn's receipt is not this turn's to overwrite: it closes under its own prompt, after any retry row.
			const row = turnRetryRow(transcript);
			const from = Math.max(
				runStartIndex ?? runStartFallback(transcript, transcript.length),
				row === null ? 0 : transcript.lastIndexOf(row) + 1,
			);
			const found = lastAssistantIndex(transcript, { withOutput: true, from }) ?? lastAssistantIndex(transcript, { from });
			if (found === null) {
				transcript.push({ role: "assistant", segments: [], pending: false, isError: false });
			}
			const index = found ?? transcript.length - 1;
			const target = transcript[index];
			if (target?.role === "assistant") {
				invalidateEntryCache(target);
				lastSettledReceipt = target;
				const stop = messages.filter((message) => (message as { role?: unknown }).role === "assistant").at(-1) as
					| { stopReason?: string; pancodeAbortReason?: string }
					| undefined;
				// A replayed run end brings the duration and cold reasons the
				// ledger recorded; a live one measures its own.
				const elapsedMs =
					replayed !== undefined
						? replayed.elapsedMs
						: runStartedAt === undefined
							? undefined
							: Math.max(0, now() - runStartedAt);
				const endedAtMs = replayed !== undefined ? replayed.endedAtMs : now();
				const coldReasons = replayed !== undefined ? (replayed.coldReasons ?? []) : runColdReasons;
				const callIds = runCallIds(messages);
				// Workers a turn detached keep running past its end, so the turn ended but the work is not done. A replay
				// counts the ones its ledger and their receipts place still running then.
				const workersRunning =
					replayed === undefined
						? [...workerEntries.values()].filter((entry) => entry.state.pending).length
						: (replayed.workersRunning ?? 0);
				// Their calls are the workers' own: the receipt's count stays what the turn made by its end (ns:49-50).
				const detachedRunIds =
					replayed === undefined
						? [...workerEntries.values()].flatMap((entry) => (entry.state.pending ? [entry.state.runId] : []))
						: (replayed.workerRunIdsRunning ?? []);
				const humanWaitMs = replayed === undefined ? (options.getHumanWaitMs?.() ?? 0) : (replayed.humanWaitMs ?? 0);
				if (replayed === undefined && elapsedMs !== undefined && turnId !== undefined) {
					options.recordTurnTiming?.({ turnId, elapsedMs, ...(humanWaitMs > 0 ? { humanWaitMs } : {}) });
				}
				target.turnUsage = {
					...(turnId === undefined ? {} : { turnId }),
					...(callIds.length > 0 ? { callIds } : {}),
					...(elapsedMs === undefined ? {} : { elapsedMs }),
					...(endedAtMs === undefined ? {} : { endedAtMs }),
					...(replayed !== undefined ? { replayed: true as const } : {}),
					...(detachedRunIds.length > 0 ? { detachedRunIds } : {}),
					...(humanWaitMs > 0 ? { humanWaitMs } : {}),
					...(coldReasons.length > 0 ? { coldReasons: [...coldReasons] } : {}),
					...(runRetries > 0 ? { retries: runRetries } : {}),
					...(runProviderWaits > 0 ? { providerWaits: runProviderWaits } : {}),
					...(runMovedTo !== undefined ? { movedTo: runMovedTo } : {}),
					...(ending === null ? {} : { ending }),
					outcome:
						run.outcome ??
						(stop?.stopReason === "error"
							? "Failed"
							: stop?.stopReason === "aborted"
								? isGenerationGuardAbort(stop.pancodeAbortReason)
									? "Generation stopped"
									: "Cancelled"
								: stop?.stopReason === "length"
									? "Output limit"
									: ending?.kind === "no_answer"
										? "No answer"
										: endedOnCancelledInterview(messages)
											? "Cancelled"
											: endedWithFailedChange(messages)
												? "Done, last change failed"
												: workersRunning > 0
													? turnEndedWithWorkers(workersRunning)
													: "Done"),
				};
				// Only the newest failure is one ↑ away; a later turn's prompt sits in front of an older one.
				if (promptRecallReceipt?.turnUsage) {
					delete promptRecallReceipt.turnUsage.promptRecall;
					invalidateEntryCache(promptRecallReceipt);
				}
				promptRecallReceipt = null;
				if (replayed === undefined && target.turnUsage.outcome === "Failed") {
					target.turnUsage.promptRecall = true;
					promptRecallReceipt = target;
				}
				trackReceipt(target);
			}
			const firstRunEntry = runStartIndex ?? runStartFallback(transcript, index);
			for (let other = firstRunEntry; other < transcript.length; other += 1) {
				if (other === index) continue;
				const sibling = transcript[other];
				if (sibling?.role !== "assistant") continue;
				if (sibling.turnUsage !== undefined) invalidateEntryCache(sibling);
				delete sibling.turnUsage;
				liveReceipts.delete(sibling);
			}
		}
		runStartIndex = undefined;
		runColdReasons = [];
		runTurnId = undefined;
		runRetries = 0;
		runProviderWaits = 0;
		runMovedTo = undefined;
		const runWasAborted = messages.some(
			(message) =>
				message && typeof message === "object" && (message as { stopReason?: unknown }).stopReason === "aborted",
		);
		closeRunEntries(runWasAborted);
		// An attempt cut off by the cancel leaves its row reading as still underway.
		const row = turnRetryRow(transcript);
		if (row && (row.status.phase === "scheduled" || row.status.phase === "waiting" || row.status.phase === "retrying")) {
			if (runWasAborted) {
				invalidateEntryCache(row);
				row.status = { ...row.status, phase: "cancelled" };
			}
		}
	};

	const insertEntryAt = (at: number, entry: TranscriptEntry): void => {
		transcript.splice(at, 0, entry);
		if (runStartIndex !== undefined && at <= runStartIndex) runStartIndex += 1;
		// Runs are stretches of indices: the ones behind the cut move up by one, and one it lands inside splits there.
		runs.insert(at);
		if (prerender !== null && at < prerender.next) prerender.next = at;
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
			if (before === undefined && replayStampMs === undefined)
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
			dirty = true;
		}
		if (
			!dirty &&
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
		if (!deferring || (relayout !== null && relayout.key !== baseKey)) relayout = null;
		// The entries a re-layout renders in this frame; outside them, a run laid out at an earlier key stays.
		let freshFrom = 0;
		let freshTo = 0;
		let anchor: { entry: number; offset: number; top: number } | null = null;
		const around = (): ReturnType<typeof viewportWindow> =>
			viewportWindow(frameLayout, cachedRegions.rows, transcript.length, viewport ?? { fromEnd: 0, rows: terminalRows });
		if (deferring && relayout === null && runs.list.some((run) => !valid(run))) {
			const window = around();
			anchor = window.anchor;
			freshFrom = window.lo;
			freshTo = window.hi;
			runs.splitAt(freshFrom);
			runs.splitAt(freshTo);
			relayout = {
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
		} else if (relayout?.ready === true) {
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
			if (run !== undefined && run.from === i && relayout !== null && (run.to <= freshFrom || run.from >= freshTo)) {
				const replacement = relayout.ready ? relayout.replacements.get(run) : undefined;
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
		if (relayout !== null) {
			if (!nextRuns.some((run) => !valid(run))) relayout = null;
			else {
				// A run that changed since its replacement was laid out is laid out again.
				relayout.ready = false;
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
		dirty = false;
		options.onRenderMetrics?.({
			durationMs: performance.now() - startedAt,
			cacheHit: false,
			entriesRendered,
			segmentsRendered: segmentsWalked - walkedBefore,
		});
		schedulePrerender(width, terminalRows, detail.style);
		return cachedRegions;
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

	/**
	 * One idle step of a viewport-first re-layout: lay the runs still showing an earlier key out again at the job's,
	 * a few milliseconds at a time, and ask for the frame that swaps them in once every one has its replacement.
	 */
	const relayoutStep = (): boolean => {
		syncSkin();
		refreshReceipts();
		const job = relayout;
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
		dirty = true;
		options.requestRender?.();
		return false;
	};
	const scheduleRelayout = (): void => {
		if (relayout === null || relayout.scheduled || options.scheduleIdle === undefined) return;
		relayout.scheduled = true;
		options.scheduleIdle(relayoutStep);
	};

	const prerenderStep = (): boolean => {
		syncSkin();
		// A card rendered ahead must read the view its cached siblings were checked against.
		refreshReceipts();
		const job = prerender;
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
			prerender === null ||
			prerender.width !== width ||
			prerender.terminalRows !== terminalRows ||
			prerender.style !== style
		) {
			prerender = { width, terminalRows, style, next: 0 };
		} else if (prerender.next >= transcript.length) {
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

	return {
		forgetPromptRecall,
		appendUser(text: string, status?: () => UserTurnStatus, origin?: string): void {
			// A prompt opens the next turn, whose retries are not the last receipt's.
			lastSettledReceipt = null;
			// ↑ now recalls this prompt, so the failed receipt above stops offering its own.
			forgetPromptRecall();
			// A prompt typed while a run is open waits its turn; only one between runs starts the next clock.
			if (runStartIndex === undefined && replayStampMs === undefined)
				pendingPrompt = { at: now(), ...(status ? { status } : {}) };
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
			const artifacts: ViewArtifact[] = [];
			// Secret patterns can consume the start of an ANSI SGR sequence when
			// applied to an already styled row, leaving its `;2;...m` tail visible.
			// Redact the plain row when it contains a secret; keep styling otherwise.
			const redactInspectionRow = (row: string): string => {
				const plain = stripTerminalSequences(row);
				const redacted = redactSecretString(plain);
				return redacted === plain ? row : redacted;
			};
			// A fitted row's marker can outgrow what it replaced, and the TUI throws on a row past the terminal's width.
			const redactFittedRow = (row: string, width: number): string => {
				const redacted = redactInspectionRow(row);
				return redacted === row ? row : truncateToWidth(redacted, width, GLYPH.ellipsis, false);
			};
			// Newest first by the time each act happened; acts stamped in the same
			// millisecond keep their transcript order.
			let previousAt = Number.NEGATIVE_INFINITY;
			const add = (
				title: string,
				at: number,
				lines: () => string[],
				render?: (width: number) => string[],
				extra: Partial<Pick<ViewArtifact, "toolName" | "searchText" | "category">> = {},
			) => {
				const index = artifacts.length;
				const timestamp = Math.max(at, previousAt + 1);
				previousAt = timestamp;
				const clean = redactSecretString(sanitizeCallTargetText(title));
				artifacts.push({
					id: `transcript:${index + 1}`,
					category: extra.category ?? "transcript",
					title: clean,
					timestamp,
					searchText: [clean, ...(extra.searchText ?? []).map((value) => redactSecretString(sanitizeCallTargetText(value)))],
					...(extra.toolName !== undefined ? { toolName: extra.toolName } : {}),
					load: async () => ({
						format: "text",
						lines: lines().map(redactInspectionRow),
						...(render === undefined
							? {}
							: { render: (width: number) => render(width).map((row) => redactFittedRow(row, width)) }),
					}),
				});
			};
			/** A block's first row, plain: how the transcript states it. */
			const firstRow = (rows: readonly string[]): string =>
				rows.map((row) => stripTerminalSequences(row).trim()).find((row) => row.length > 0) ?? "";
			const standard = transcriptDetail("standard");
			for (const entry of transcript) {
				if (entry.role === "assistant") {
					for (const seg of entry.segments) {
						if (seg.kind === "error")
							add("Provider or terminal error", seg.at, () => providerErrorEvidence(seg.text).split("\n"));
						if (seg.kind === "thinking" && seg.text.trim().length > 0) {
							// Whole, because these rows redact one at a time and `--token` can end the line before its value.
							const prose = redactSecretString(
								sanitizeAssistantProse(seg.finalized ? seg.text : holdUnresolvedUserinfo(seg.text)),
							);
							const opening = prose.trim().split("\n", 1)[0] ?? "";
							add(`Thinking ${GLYPH.sep} ${opening}`, seg.at, () => sanitizeMultilineDisplayText(prose).text.split("\n"));
						}
						if (seg.kind === "tool") {
							// Titled by its row as the transcript states it; inspected in full,
							// every argument included, whatever card sits under it.
							const call: ToolExecutionFinished = {
								...finishedCall(seg),
								result: seg.result ?? holdUnresolvedStrings(seg.partialResult),
								cardAttached: undefined,
							};
							const row = seg.finished
								? finishedCall(seg)
								: { toolCallId: seg.id, toolName: seg.name, args: shownArgs(seg), cardAttached: seg.cardAttached };
							add(
								toolRowTitle(row),
								seg.at,
								() => renderToolExecution(call, 120, { unbounded: true, diffStyle: "plain" }),
								(width) => renderToolExecution(call, width, { unbounded: true, diffStyle: "plain" }),
								{
									toolName: seg.name,
									searchText: [seg.name, seg.id],
									...(isChangeOrCheckCall(row) ? { category: "changes" as const } : {}),
								},
							);
						}
					}
				} else if (entry.role === "retryStatus" && entry.status.errorMessage) {
					const status = entry.status;
					add(firstRow(renderRetryStatus(status, 120, standard)), entry.at, () =>
						providerErrorEvidence(status.errorMessage ?? "").split("\n"),
					);
				} else if (entry.role === "worker") {
					const state = entry.state;
					// A council member is titled by its own row, not the round's header.
					const header = firstRow(
						renderWorkerEntryLines(state, 120, {
							detail: standard,
							group: "continues",
							telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
						}),
					);
					add(
						header,
						entry.at,
						() =>
							renderWorkerEntryLines(state, 120, {
								unbounded: true,
								telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
							}),
						(width) =>
							renderWorkerEntryLines(state, width, {
								unbounded: true,
								telemetry: options.getTelemetry?.()?.run(state.runId) ?? null,
							}),
						{ searchText: [state.agentId, state.runId] },
					);
				} else if (entry.role === "replayBlock") {
					const detailed = transcriptDetail("detailed");
					const title = firstRow(entry.renderBlock(120, standard, false));
					if (title.length === 0) continue;
					add(
						title,
						entry.at,
						() => entry.renderBlock(120, detailed, true),
						(width) => entry.renderBlock(width, detailed, true),
					);
				}
			}
			return artifacts;
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
			lastSettledReceipt = null;
			liveReceipts.clear();
			liveReplayBlocks.clear();
			receiptView = null;
			runTurnId = undefined;
			runStartedAt = undefined;
			pendingPrompt = undefined;
			runStartIndex = undefined;
			runAwaitingRetry = false;
			runRetries = 0;
			runProviderWaits = 0;
			runMovedTo = undefined;
			runColdReasons = [];
			workerEntries.clear();
			dispatchGroups.clear();
			clearRenderCaches();
			markDirty();
		},
		replayRoute(targetId: string | null): void {
			replayTarget = targetId;
		},
		replayAt(timestampMs: number | undefined): void {
			if (timestampMs === undefined) replayTarget = null;
			replayStampMs =
				timestampMs !== undefined && Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : undefined;
		},
		markToolReplayed(toolCallId: string): void {
			const owner = findToolSegmentOwner(transcript, toolCallId);
			if (!owner || owner.segment.finished) return;
			invalidateEntryCache(owner.entry);
			owner.segment.replayed = true;
			markDirty();
		},
		applyEvent(event: ChatLoopEvent): void {
			if (event.type === "agent_start") {
				lastSettledReceipt = null;
				// A retry's attempt continues the run it retries: same receipt, same clock.
				if (runAwaitingRetry) {
					runAwaitingRetry = false;
					return;
				}
				runRetries = 0;
				runProviderWaits = 0;
				runMovedTo = undefined;
				// The run's cold-cache reasons arrive just before it starts, as the
				// chat loop consumes them ahead of the prompt, so they are kept here
				// and cleared once the run's receipt has stated them.
				const prompt = pendingPrompt;
				pendingPrompt = undefined;
				runStartedAt = prompt !== undefined && prompt.status?.() !== "refused" ? prompt.at : now();
				runStartIndex = transcript.length;
				runTurnId = (event as { turnId?: string }).turnId;
				return;
			}
			if (event.type === "agent_status") {
				return;
			}
			if (event.type === "notice") {
				// The cache notice lives in the footer; the run keeps its reasons
				// for the Detailed receipt.
				if (event.coldReasons !== undefined) runColdReasons = [...event.coldReasons];
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
				if (event.operatorCancel === true && lastSettledReceipt?.turnUsage?.outcome === "Cancelled") return;
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
					requestingModel = modelNickname(respondedModel);
				const model = assistantModelLabel(event.message, messageTarget());
				assistant.messageStartModel = attachModel(assistant, model) && model !== null ? model : undefined;
				assistant.messageStartSegmentIndex = assistant.segments.length;
				markDirty();
				return;
			}
			if (event.type === "tool_execution_start") {
				const streamedOwner = findToolSegmentOwner(transcript, event.toolCallId);
				if (streamedOwner !== undefined && !streamedOwner.segment.finished && !streamedOwner.segment.executionStarted) {
					invalidateEntryCache(streamedOwner.entry);
					const streamed = streamedOwner.segment;
					streamed.name = event.toolName;
					streamed.args = event.args;
					streamed.executionStarted = true;
					streamed.argsComplete = true;
					streamed.requestedBy = requestingModel;
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
					requestedBy: requestingModel,
					argsComplete: true,
					isError: false,
					startedAtMs: now(),
				});
				markDirty();
				return;
			}
			if (event.type === "tool_approval_state") {
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
				return;
			}
			if (event.type === "tool_execution_update") {
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
				return;
			}
			if (event.type === "tool_execution_end") {
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
					} else if (tool.startedAtMs !== undefined && replayStampMs === undefined) {
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
				if (willRetry) runAwaitingRetry = true;
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
					assistant.turnUsage = runTurnId === undefined ? {} : { turnId: runTurnId };
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
					runMovedTo = status.movedTo?.modelId;
					// The run goes on, and its next start continues this receipt and clock.
					runAwaitingRetry = true;
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
				if ((status.phase === "cancelled" || status.phase === "exhausted") && runAwaitingRetry) {
					// The ladder ended between attempts, so no agent_end is coming to close the turn.
					settleRun({
						messages: [],
						turnId: runTurnId,
						outcome: status.phase === "cancelled" ? "Cancelled" : "Failed",
						always: true,
					});
				}
				markDirty();
				return;
			}
			if (event.type === "agent_end") {
				if (event.retryPending !== undefined) {
					runAwaitingRetry = true;
					// Closing an earlier round's entry would show its interim receipt as a Done the turn has not reached.
					for (const entry of transcript) {
						if (entry.role !== "assistant" || entry.turnUsage === undefined || entry.turnUsage.outcome !== undefined)
							continue;
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
					turnId: (event as { turnId?: string }).turnId ?? runTurnId,
					replayed: (event as { replayed?: ReplayedRunFacts }).replayed,
				});
				markDirty();
			}
		},
		render,
		renderRegions: renderFrame,
		invalidate(): void {
			markDirty();
		},
	};
}
