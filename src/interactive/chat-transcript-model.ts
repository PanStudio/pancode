// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The chat transcript's entries and assistant segments, and the pure reads and edits on them. */
import { outputLimitCutOffToolCallIds } from "../core/assistant-output.js";
import type { AssistantProseProjection } from "../core/assistant-prose.js";
import { messageCallsForAccounting, messageUsageForAccounting } from "../core/message-accounting.js";
import { SKILL_SUGGESTION_PREFIX } from "../core/skill-activation.js";
import type { Markdown } from "../engine/tui.js";
import type { AgentMessage } from "../engine/types.js";
import type { RedactedStringProjection } from "../lib/secrets/redaction.js";
import type { ApprovalRequestView } from "../session-control/approval-request-view.js";
import type { RetryStatusPayload } from "../session-control/chat-loop.js";
import { extractText, isSelfExplainingAbort, type TurnEnding } from "../session-control/chat-loop-messages.js";
import type { WorkerEntryState } from "../session-control/worker-stream.js";
import type { SettledHead } from "./chat-entry-rows.js";
import type { ThinkingStream } from "./chat-thinking-rail.js";
import type { CodeInkCarry, codeInkLexer } from "./renderers/code-ink.js";
import type { LiveToolView } from "./renderers/live-tool-view.js";
import type { ProviderFailureRoute } from "./renderers/provider-error.js";
import type { ToolFoldFamily } from "./renderers/tool-fold.js";
import { type ReasoningUsageView, UNMEASURED_REASONING } from "./status/index.js";
import type { TranscriptDetailPolicy } from "./transcript-detail.js";
import type { TurnSpend } from "./turn-spend.js";

/**
 * An assistant turn is a sequence of text and tool segments interleaved in
 * pi-agent-core event order. A tool turn emits assistant `message_update`
 * events carrying `toolcall_*` formation, then `message_end`, then the
 * `tool_execution_*` lifecycle before the next assistant message. Tool calls
 * therefore sit BETWEEN the assistant's pre-tool narration and the post-tool summary. Storing a flat
 * `text` buffer + `tools[]` array (pre-refactor) collapsed that order: all
 * text across the turn concatenated into one line with every tool block
 * appended at the end. The segment list preserves the stream order instead.
 *
 * Each text segment tracks whether it has been finalized by a `message_end`.
 * Streaming and settled text render through the same Markdown component, so
 * finalizing restyles at most the block that was still open and the rows
 * already streamed stay put.
 */

export interface ChatPanelTurnUsage {
	elapsedMs?: number;
	outcome?: string;
	/** The newest failed turn this run: its prompt is one ↑ away in the composer's history. */
	promptRecall?: boolean;
	/** The operator turn whose spend the receipt reads from the telemetry read model (#434 §11.3). */
	turnId?: string;
	/** The calls the run's own messages settled; the receipt reads the fold until it holds them all. */
	callIds?: ReadonlyArray<string>;
	/** The turn's spend and reasoning as the read model last worded them; absent until a view resolved the turn. */
	spend?: TurnSpend;
	/** Why the run's prompt cache was expected to be cold (`prompt_recompiled`, …). */
	coldReasons?: ReadonlyArray<string>;
	/** Provider attempts the run sent again after a failure. */
	retries?: number;
	/** Provider waits the run sat out, which no retry limit counts. */
	providerWaits?: number;
	/** The model the operator moved the waiting request to, which is the one the turn's answer came from. */
	movedTo?: string;
	/** Of `elapsedMs`, what the run spent waiting on the operator. */
	humanWaitMs?: number;
	/** How a normally stopped run closed when it wrote no answer. */
	ending?: TurnEnding;
	/** Epoch ms the turn ended: live, when it settled; replayed, its terminal ledger entry's timestamp. */
	endedAtMs?: number;
	/** Replayed from the session, so a forked session's copied turn reads the calls its parent journaled. */
	replayed?: true;
	/** Worker runs still going when the turn ended; their calls show on their own cards, never in this receipt's count. */
	detachedRunIds?: ReadonlyArray<string>;
}

/** What one Markdown layout of the open reply cost and how long the reply was then. */
export interface LiveTextRender {
	durationMs: number;
	codeUnits: number;
}

export type RowMemo = {
	width: number;
	bareFences: boolean;
	epoch: number;
	rows: Map<string, string[]>;
	/** Each row's text without terminal sequences, which the fence, code and operator checks read on every frame. */
	plain: Map<string, string>;
};

export type TextSegment = {
	kind: "text";
	/** Changed only through `appendSegmentText` and `replaceSegmentText`, which keep `unprojected` and `scan` honest. */
	readonly text: string;
	finalized: boolean;
	/**
	 * Text appended since the last projection, so the next frame projects only
	 * that (#428); absent until the first projection and after a replacement,
	 * when the projections compare the whole text.
	 */
	unprojected?: string;
	/** What appends keep current about `text` without reading it whole (#428); absent after a replacement. */
	scan?: TextScan;
	/** Cached prose policy for live, replayed and rewritten model output. */
	prose?: AssistantProseProjection;
	/** URL credentials stay off screen; the segment's own text stays whole for the ledger and the next turn (#446). */
	secrets?: RedactedStringProjection;
	/** The segment's stock Markdown component and the source it last rendered. */
	markdown?: { view: Markdown; source: string; epoch: number };
	/** While the segment streams, its settled leading blocks and its open tail; null once it cannot split (#428). */
	settled?: SettledBlocks | null;
	/** Reuse wrapped rows while another entry streams or its clock advances (#428). */
	rendered?: { source: string; finalized: boolean; epoch: number; layouts: Map<string, string[]> };
	/** The last rows hung under the gutter, so an unchanged row keeps its hung string (#428). */
	hung?: { input: string[]; prefix: string; output: string[] };
	/** The last streamed rows before and after their leading blank rows were dropped. */
	unblanked?: { rows: string[]; lines: string[] };
	/** Fitted rows by Markdown row, so an unchanged row is not measured again on the next delta. Streaming only. */
	rowMemo?: RowMemo | undefined;
	/** Read by the stream renderer to price the next repaint; a new segment starts unpriced. */
	liveRender?: LiveTextRender;
	/**
	 * Live denoising state while a diffusion model streams whole frames. The
	 * text before `settled` agreed between the last two frames and is shown as
	 * settled prose; the rest is still noise and renders dim. Cleared when the
	 * segment finalizes.
	 */
	diffusion?: { progress: number; settled: number };
	/**
	 * A protocol suggestion line and the answer prose beneath it, when the model
	 * opened its reply with both in one segment (which is what the skills prompt
	 * asks for). The answer half is a segment of its own so it keeps its own
	 * Markdown component; it is cached here rather than rebuilt per frame.
	 */
	suggestionSplit?: { suggestion: string; answer: TextSegment };
};
/**
 * A streaming answer as a settled head of whole blocks and the open tail after it (#428). The head grows only at
 * cuts `settledMarkdownHead` vouches for, so its rows at a width never change and render once; each delta lexes and
 * renders only the tail. Rendering the head and the tail apart yields the same rows as the whole.
 */
export type SettledBlocks = {
	/** How long the settled head is: a prefix of the segment's projected prose. */
	length: number;
	/** The head's text cut by cut, read from the projection's tail so the reply is never flattened per frame. */
	pieces: string[];
	/** Where each piece ends in the prose, ascending; the last is `length`. */
	cuts: number[];
	/** Per cut, whether the whole draws a spacing row after it that a head ending there must add. */
	spacing: boolean[];
	/** The redaction projection's restart count the head was cut under; a restart may have changed the head. */
	restarts: number;
	/** How far the prose reached at the last search for a cut. A new cut needs a line completed after that. */
	searched: number;
	/** The head's rows at one layout and how much of the head they cover. */
	layout?: { width: number; bareFences: boolean; epoch: number; rows: string[]; through: number };
	/** The open tail's Markdown component and the source it last rendered. */
	tail?: { view: Markdown; source: string; epoch: number; bareFences: boolean };
	/** The open tail as one top-level fence still open, found at the head length `at`; null when the tail is not one. */
	fence?: { at: number; open: OpenFence | null };
	/**
	 * The rows last returned and how many of them were head rows at which layout, which later rows still lead with;
	 * `fenceRows` more lead with them while the open fence keeps its layout.
	 */
	returned?: {
		layout: NonNullable<SettledBlocks["layout"]>;
		fence: OpenFence["layout"];
		rows: string[];
		headRows: number;
		fenceRows: number;
	};
};
/**
 * A streaming tail that is one fenced code block still open at the top level. Every code line is drawn on its own
 * and inked from the lexer state the lines above leave, so its complete lines render once per layout and a delta
 * renders only the line still open, as the whole fence would draw them.
 */
export type OpenFence = {
	/** The opening line, without its line end; the code starts after it. */
	opener: string;
	/** The fence's marker, as long as it opened: a closing line needs at least as many. */
	marker: string;
	/** Where the first line not yet searched for a closing fence starts in the tail. */
	scanned: number;
	/** Code ink's lexer for the fence's language; null when it inks none. */
	lexer: ReturnType<typeof codeInkLexer>;
	/** The fence inline math reads after the opening line, which every piece drawn on its own starts from. */
	mathFence: string | null;
	/**
	 * Whether a line inline math reads as closing that fence, where Pi does not, was searched: past it inline math
	 * may set `$...$` in the whole fence and not in a piece, so a tail holding a `$` renders whole.
	 */
	mathDrift: boolean;
	/** The complete lines' rows at one layout, how far into the tail they reach, and the lexer state there. */
	layout?: {
		width: number;
		bareFences: boolean;
		epoch: number;
		/** How many rows the opening line draws: `rows` opens with them, and every piece drawn after drops them. */
		header: number;
		rows: string[];
		through: number;
		carry: CodeInkCarry | undefined;
	};
};
export type ToolSegment = {
	kind: "tool";
	id: string;
	name: string;
	args: unknown;
	/** When the call formed or started: the event's time live, the ledger's on replay. */
	at: number;
	/** Final result from `tool_execution_end`; undefined while the call is in flight. */
	result?: unknown;
	/** True once `tool_execution_end` has landed (success or error). */
	finished: boolean;
	/** Pi streamed the call row before execution and later starts this same row. */
	executionStarted: boolean;
	/** The model whose request put this call on the harness. */
	requestedBy?: string | undefined;
	/** The assistant stream closed this call's argument block. */
	argsComplete: boolean;
	/**
	 * True when the segment was force-settled without its own end event
	 * (blocked at admission, aborted mid-batch, id reused). A late
	 * `tool_execution_end` may upgrade such a segment with the call's true
	 * result; a segment finished by its own end event is never overwritten.
	 * The explicit `| undefined` allows the upgrade path to clear the flag
	 * under `exactOptionalPropertyTypes: true`.
	 */
	settledWithoutResult?: boolean | undefined;
	/** True when the finished result was an error. Meaningful only after `finished`. */
	isError: boolean;
	/** Wall-clock start time captured by the chat panel for live duration display. */
	startedAtMs?: number;
	/** Completed call duration in milliseconds (event-supplied or measured locally). */
	durationMs?: number;
	/** Persisted result summary (bytes, truncated, offloadPath, observation) from the chat loop. */
	resultSummary?: Record<string, unknown> | undefined;
	/**
	 * Latest cumulative Pi result from `tool_execution_update`, including the
	 * display content and structured progress details. Cleared
	 * back to `undefined` on `tool_execution_end` so the finished `result`
	 * takes over. Only consumed while the call is in flight and its effective
	 * state is expanded. The explicit
	 * `| undefined` is required under `exactOptionalPropertyTypes: true` so
	 * the clear path can re-assign `undefined` without a `delete`.
	 */
	partialResult?: unknown;
	/**
	 * Incremental state of the call's streamed arguments and output while it is
	 * in flight, so a frame paints only the rows in view. Dropped at settlement.
	 */
	live?: LiveToolView | undefined;
	/** An edit's diff computed from the file once its arguments closed; live only, dropped at settlement. */
	previewDiff?: string | undefined;
	/** The edit preview was started for this call, so a later event does not read the file again. */
	previewRequested?: true;
	/**
	 * True while the call is parked at the permission gate. Set/cleared by
	 * `tool_approval_state` events and cleared by any settle so a denied or
	 * resumed call never keeps the awaiting-approval styling. Meaningful only
	 * while `!finished`.
	 */
	awaitingApproval?: boolean | undefined;
	/** The safety judge holds the call before admission; set and cleared by `tool_approval_state` like `awaitingApproval`. */
	judging?: boolean | undefined;
	/** Live, redacted approval facts. Never reconstructed during replay. */
	approvalView?: ApprovalRequestView | undefined;
	/** The call's card is on the dock, which shows its facts; the row keeps only its head. */
	approvalDocked?: true | undefined;
	/** The axis an operator grant answered, kept past settlement (BT-003). Live only, like `approvalView`. */
	operatorGrant?: string | undefined;
	/** Who gave that grant when it was not the operator at this terminal (`attach c2 (apr)`). Live only. */
	grantedBy?: string | undefined;
	autoApproved?: "yolo" | undefined;
	settlement?: "blocked" | "aborted" | "orphaned" | undefined;
	/**
	 * Settled without a result before execution started, or while it still
	 * waited for approval, so the row says the call did not run instead of
	 * claiming a past-tense edit. Cleared when a late end event brings a result.
	 */
	notRun?: boolean | undefined;
	/** Why a settled call did not run when that is no failure: the output limit cut off the reply that made it. */
	notRunCause?: "output_limit" | undefined;
	/**
	 * The admission verdict's short reason, present only on a settlement the
	 * registry actually rejected. A blocked row without it states that something
	 * was refused and leaves the operator no way to learn why.
	 */
	blockReason?: string | undefined;
	/**
	 * Working-set eviction reason for a replayed result whose body the
	 * projection has replaced. Set only on rehydrate, from the folded ledger;
	 * a live call is never evicted while it is still being rendered.
	 */
	evictedReason?: string | undefined;
	/** View-only marker: historical calls render mutation diffs without live color. */
	replayed?: true;
	/**
	 * Admission's action class, from the end event (live) or the persisted
	 * result (replay). An unknown dynamic tool is classified by it.
	 */
	actionClass?: string | undefined;
	/**
	 * A worker card spawned by this call sits in the transcript. The card
	 * states the run's task and outcome, so the call's row does not repeat them.
	 */
	cardAttached?: true;
	/**
	 * Every worker card under this call settled cancelled, so the call was stopped rather than failed: the dispatch
	 * tool reports a cancelled run as an error, and its row read ✗ above a card that read ⊘.
	 */
	cardsCancelled?: true;
	/**
	 * What a finished call rendered to, so a long live turn pays only for its running calls: every settled row
	 * re-rendered on each update cost about 5 MB per frame at 320 calls. A finished call has no clock in its rows.
	 * `changeSettledCall` drops all of this, and the fold over this call sees its revision move.
	 */
	settledRows?: SettledToolRows | undefined;
	/** The fold this finished call heads, valid while its calls and their revisions are the same. */
	settledFold?: (SettledToolRows & { calls: number; revisions: number }) | undefined;
	/** The Compact fold this finished call joins; undefined until asked. */
	settledFamily?: ToolFoldFamily | null | undefined;
	settledRevision?: number;
};
type SettledToolRows = { key: string; lines: string[]; body: boolean };
/**
 * A turn's terminal-error marker (`[error] ...`, `[aborted] ...`,
 * `[stopped: length] ...`) carried as its own segment so it renders in the
 * error token instead of being piped through Markdown as plain prose. Kept
 * distinct from streamed text: the error text is not model output, it is PanCode
 * reporting why the turn ended.
 */
export type ErrorSegment = {
	kind: "error";
	text: string;
	/** Where the failure happened, when a provider route did it. */
	route?: ProviderFailureRoute | undefined;
	at: number;
};
/**
 * One stretch of reasoning, in stream order with the text and tool segments
 * around it. A turn used to hold one `thinking` string, so reasoning could only
 * ever render in one place (above everything or below everything) and a
 * turn that thought, wrote, thought again, called a tool, and thought once more
 * had its reasoning pinned at the tail while the prose streamed in above it.
 * Each stretch is its own segment now: it renders where it happened, and the
 * one still open at the tail is the live indicator.
 */
type ThinkingSegment = {
	kind: "thinking";
	text: string;
	/** When the stretch began: the first delta's time live, the ledger's on replay. */
	at: number;
	/** Closed by the first text, tool, or message_end that follows it. */
	finalized: boolean;
	/** Panel clock when the first delta of this stretch arrived. */
	startedAtMs?: number;
	/** The stretch was streamed live and its target's history did not keep the text, so only the fact can be shown. */
	notRetained?: true;
	/** The provider redacted the reasoning and sent only an opaque payload, so only the fact can be shown. */
	hiddenByProvider?: true;
	/**
	 * The provider sent only its summary of the prose the model wrote beside a tool call. The summary reads as the
	 * message's reply; the fact that it is a summary belongs to this row on the reasoning rail.
	 */
	summarizedByProvider?: true;
};
type ThinkingRender = {
	source: string;
	open: boolean;
	epoch: number;
	layouts: Map<string, string[]>;
	/** An open segment's incremental rail, carried across its deltas (Astra r10-1). */
	stream?: ThinkingStream;
};
export type AssistantSegment = TextSegment | ToolSegment | ErrorSegment | ThinkingSegment;
/**
 * A caller-rendered block receives the frame's transcript detail policy so a
 * block such as the operator's `!` bash row follows the same preset as the panel. Blocks that ignore it are unaffected.
 */
export type ReplayBlockRenderer = (
	width: number,
	detail: TranscriptDetailPolicy,
	unbounded?: boolean,
	terminalRows?: number,
) => string[];

/**
 * Every entry and action carries the time it happened (`at`): the event's time
 * live, the ledger entry's on replay. `/view` states each one's age from it.
 */
export type TranscriptEntry =
	| { role: "user"; text: string; at: number; status?: () => UserTurnStatus; origin?: string }
	| { role: "retryStatus"; status: RetryStatusPayload; at: number }
	| {
			role: "assistant";
			models?: string[];
			/** The turn's first model is the one the turn before it ended on, so its row would repeat it. */
			sameModelAsBefore?: boolean;
			segments: AssistantSegment[];
			reasoningRenders?: Map<number, ThinkingRender>;
			/** The joined rows of a live turn's settled leading segments; see `settledHeadFor`. */
			settledHead?: SettledHead | undefined;
			/**
			 * `segments.length` when the current model call began, so `message_end`
			 * can tell which segments belong to the message it is settling. A
			 * provider that delivers thinking only in the final message (no
			 * `thinking_delta`) gets its thinking segment inserted here, ahead of
			 * the text the same message produced, rather than at the tail.
			 */
			messageStartSegmentIndex?: number | undefined;
			/** The model the open message's start added to `models`, held back if the message turns out never sent. */
			messageStartModel?: string | undefined;
			pending: boolean;
			isError: boolean;
			turnUsage?: ChatPanelTurnUsage;
	  }
	/**
	 * A dispatched worker's attributed block. `state` is the live object the worker-stream reducer mutates, so
	 * a streaming delta reaches the screen without copying the entry per frame.
	 * The panel is told when that happened through `applyWorkerState`.
	 */
	| { role: "worker"; state: WorkerEntryState; at: number; telemetryShown: string }
	/**
	 * A block the caller renders itself. Most are settled the moment they are
	 * appended, but a few (the operator's `!` bash row) keep mutating the state
	 * their closure reads until the work behind them finishes. Such a block
	 * declares `isLive`, which keeps it out of the entry runs and keeps the
	 * panel's time-keyed tick running while it is unsettled.
	 */
	| {
			role: "replayBlock";
			renderBlock: ReplayBlockRenderer;
			at: number;
			isLive?: (() => boolean) | undefined;
	  };

export type WorkerTranscriptEntry = Extract<TranscriptEntry, { role: "worker" }>;

/**
 * Whether a painted operator turn exists in the ledger yet. `pending` is the
 * window between the editor being consumed and admission; `refused` is a
 * submit that never reached the durable append.
 */
export type UserTurnStatus = "pending" | "committed" | "refused";

/**
 * An abort reaches the registry as a rejection, so it arrives here as a block
 * whose reason names it (`run aborted before the operator decided`). Matching
 * that is safe in a way that matching the tool's own output is not: this string
 * is composed by PanCode, never by the command that ran.
 */
const ABORTED_REASON_RE = /\babort(?:ed)?\b/i;

/**
 * Classify a finished tool call from the registry's admission verdict, which
 * the turn runtime stamps onto the event as `outcome`. Only a call the registry
 * refused settles as blocked; a call that executed and failed is an ordinary
 * error and carries no settlement. Events with no verdict (replayed history, a
 * surface that resolves tools without telemetry) settle as nothing rather than
 * guessing.
 */
export function toolSettlement(event: {
	outcome?: unknown;
	blockReason?: unknown;
}): { settlement: "blocked" | "aborted"; reason?: string } | undefined {
	if (event.outcome !== "blocked") return undefined;
	const reason = typeof event.blockReason === "string" && event.blockReason.trim().length > 0 ? event.blockReason : null;
	const settlement = reason !== null && ABORTED_REASON_RE.test(reason) ? "aborted" : "blocked";
	return reason === null ? { settlement } : { settlement, reason };
}

export function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return "";
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

export function extractAssistantThinking(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return "";
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter(
			(item): item is { type: "thinking"; thinking: string } =>
				item?.type === "thinking" && typeof item.thinking === "string" && item.redacted !== true,
		)
		.map((item) => item.thinking)
		.join("");
}

/** Whether the provider redacted some of the message's reasoning; its text is a placeholder, never the reasoning. */
export function assistantThinkingRedacted(message: unknown): boolean {
	const content = (message as { content?: unknown } | null)?.content;
	return Array.isArray(content) && content.some((item) => item?.type === "thinking" && item.redacted === true);
}

/**
 * Whether an assistant message settled a call its turn's receipt reports: one with recorded usage, one that never
 * left, or one whose usage went unreported. The receipt's figures are the read model's, not this message's.
 */
export function reportsCall(message: unknown): boolean {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return false;
	if ((messageCallsForAccounting(message)?.length ?? 0) > 0) return true;
	return (message as { callInvoked?: boolean }).callInvoked === false || messageUsageForAccounting(message) !== null;
}

/** The call ids a run's own messages settled, which the read model must hold before the receipt stops reading it. */
export function runCallIds(messages: ReadonlyArray<unknown>): string[] {
	return [
		...new Set(messages.flatMap((message) => (messageCallsForAccounting(message) ?? []).map((call) => call.callId))),
	];
}

/** The reasoning the turn's journaled calls hold, unmeasured until a view resolved the turn. */
export function reasoningFromTurnUsage(usage: ChatPanelTurnUsage | undefined): ReasoningUsageView {
	return usage?.spend?.reasoning ?? UNMEASURED_REASONING;
}

export function extractAssistantTerminalError(message: unknown): string {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return "";
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason !== "error" && stopReason !== "aborted" && stopReason !== "length") return "";
	if (stopReason === "length") {
		// A cut with calls in it is stated once, by the output-limit notice and its "not run" rows (bt-39 a).
		if (outputLimitCutOffToolCallIds(message).length > 0) return "";
		return "[stopped: length] Model connection hit its generation/output limit before a complete response. This is not a safety denial. Continue with a shorter answer or lower thinking; use /context compact if the context meter is also near full.";
	}
	const raw = (message as { errorMessage?: unknown }).errorMessage;
	if (isSelfExplainingAbort({ stopReason, errorMessage: raw, text: extractText(message as AgentMessage) })) return "";
	const reason = typeof raw === "string" && raw.length > 0 ? raw : "unknown error";
	return stopReason === "aborted" ? `[aborted] ${reason}` : `[error] ${reason}`;
}

export function scopeTerminalErrorAfterSuccessfulTool(
	entry: Extract<TranscriptEntry, { role: "assistant" }>,
	terminalError: string,
): string {
	if (!terminalError.startsWith("[error] ")) return terminalError;
	const successfulTools = entry.segments.filter(
		(segment): segment is ToolSegment => segment.kind === "tool" && segment.finished && !segment.isError,
	);
	if (successfulTools.length === 0) return terminalError;

	const reason = terminalError.slice("[error] ".length);
	const timedOut = /\b(?:timed?\s*out|timeout)\b/i.test(reason);
	const modelFailure = timedOut
		? `main model response timed out after successful tool result: ${reason}`
		: `main model response failed after successful tool result: ${reason}`;
	const detachedDispatchSucceeded = successfulTools.some(
		(segment) =>
			segment.name === "dispatch" &&
			segment.args !== null &&
			typeof segment.args === "object" &&
			(segment.args as { detach?: unknown }).detach === true,
	);
	return `[error] ${modelFailure}${detachedDispatchSucceeded ? "; detached runs continue" : ""}`;
}

/** The thinking segment still receiving deltas, which is always the tail. */
export function openThinkingSegment(entry: Extract<TranscriptEntry, { role: "assistant" }>): ThinkingSegment | null {
	const tail = entry.segments[entry.segments.length - 1];
	return tail?.kind === "thinking" && !tail.finalized ? tail : null;
}

export function hasVisibleOutput(entry: Extract<TranscriptEntry, { role: "assistant" }>): boolean {
	for (const seg of entry.segments) {
		if (seg.kind === "tool") return true;
		if (seg.kind === "text" && seg.text.trim().length > 0) return true;
		if (seg.kind === "error" && seg.text.trim().length > 0) return true;
		// A round that only reasoned still drew rows, and the receipt closes the turn beneath them.
		if (
			seg.kind === "thinking" &&
			(seg.text.trim().length > 0 || seg.notRetained || seg.hiddenByProvider || seg.summarizedByProvider)
		)
			return true;
	}
	return false;
}

/** Index of the newest assistant entry, optionally restricted to ones that rendered something. */
export function lastAssistantIndex(
	transcript: ReadonlyArray<TranscriptEntry>,
	options: { withOutput?: boolean; from?: number } = {},
): number | null {
	for (let index = transcript.length - 1; index >= (options.from ?? 0); index -= 1) {
		const entry = transcript[index];
		if (entry?.role !== "assistant") continue;
		if (options.withOutput === true && !hasVisibleOutput(entry)) continue;
		return index;
	}
	return null;
}

/**
 * Locate the skill-suggestion protocol line inside a reply.
 *
 * The prompt asks the model to begin its reply with the line, but a model
 * that narrates its work first puts the line at the end of the final message
 * about half the time (round-4 skill batches: 1/2 and 0/2 opened, 2/2 fired).
 * The line is recognized at the start of any line, provided it is complete
 * (a newline follows it, or the segment is finalized), so a partially
 * streamed line stays ordinary prose until it is whole. Returns the line's
 * byte range or null.
 */
export function findSkillSuggestionLine(seg: TextSegment): { start: number; end: number } | null {
	if (!textScan(seg).suggestion) return null;
	const text = seg.text;
	let at = text.startsWith(SKILL_SUGGESTION_PREFIX) ? 0 : text.indexOf(`\n${SKILL_SUGGESTION_PREFIX}`);
	if (at < 0) return null;
	if (at > 0) at += 1;
	const lineEnd = text.indexOf("\n", at);
	if (lineEnd < 0) return seg.finalized ? { start: at, end: text.length } : null;
	return { start: at, end: lineEnd };
}

/**
 * What the transcript asks of a text segment on every frame, kept as text is
 * appended so a streaming reply is never read whole for it (#428): where its
 * visible text starts and ends, and whether a skill-suggestion line may start
 * in it. `carry` is the end of the text behind a leading newline, so a line
 * start that straddles two appends is still found.
 */
type TextScan = { length: number; first: number; end: number; carry: string; suggestion: boolean };
const SUGGESTION_LINE = `\n${SKILL_SUGGESTION_PREFIX}`;

function textScan(seg: TextSegment): TextScan {
	if (seg.scan !== undefined && seg.scan.length === seg.text.length) return seg.scan;
	const scan: TextScan = { length: 0, first: -1, end: -1, carry: "\n", suggestion: false };
	scanAppended(scan, seg.text);
	seg.scan = scan;
	return scan;
}

function scanAppended(scan: TextScan, delta: string): void {
	const window = scan.carry + delta;
	if (!scan.suggestion && window.includes(SUGGESTION_LINE)) scan.suggestion = true;
	scan.carry = window.slice(-SKILL_SUGGESTION_PREFIX.length);
	const first = /\S/u.exec(delta);
	if (first !== null) {
		if (scan.first < 0) scan.first = scan.length + first.index;
		const last = /\S(?=\s*$)/u.exec(delta);
		if (last !== null) scan.end = scan.length + last.index + last[0].length;
	}
	scan.length += delta.length;
}

export function appendSegmentText(seg: TextSegment, delta: string): void {
	(seg as { text: string }).text = seg.text + delta;
	if (seg.unprojected !== undefined) seg.unprojected += delta;
	if (seg.scan !== undefined) scanAppended(seg.scan, delta);
}

export function replaceSegmentText(seg: TextSegment, text: string): void {
	(seg as { text: string }).text = text;
	delete seg.unprojected;
	delete seg.scan;
}

/** `isStrayFragment` for a text segment, which reads the text only when at most three visible marks remain. */
export function isStraySegment(seg: TextSegment): boolean {
	const scan = textScan(seg);
	return scan.first >= 0 && scan.end - scan.first <= 3 && isStrayFragment(seg.text);
}

/** Text with no letter or digit and at most three visible marks: punctuation a model left between actions. */
function isStrayFragment(text: string): boolean {
	const visible = text.trim();
	return visible.length > 0 && visible.length <= 3 && !/[\p{L}\p{N}]/u.test(visible);
}

/** Another segment of the turn that shows the operator something: an action, an error, or words. */
export function carriesOutput(other: AssistantSegment, self: AssistantSegment): boolean {
	if (other === self) return false;
	if (other.kind === "tool" || other.kind === "error") return true;
	return other.kind === "text" && other.text.trim().length > 0 && !isStrayFragment(other.text);
}

/**
 * Split a reply that carries the skill-suggestion protocol line into that
 * line and the answer around it.
 *
 * The usual shape is one segment holding both. Classifying that whole segment
 * as advisory left the turn with no voice glyph at all: the suggestion did not
 * claim it and the answer never got the chance. The suggestion renders first
 * wherever the model put it, and the answer is the rest of the segment with
 * that line removed. Returns null when the segment is only a suggestion,
 * which stays advisory in full.
 */
export function skillSuggestionSplit(seg: TextSegment): { suggestion: string; answer: TextSegment } | null {
	const found = findSkillSuggestionLine(seg);
	if (!found) return null;
	const before = seg.text.slice(0, found.start).replace(/\n+$/, "");
	const after = seg.text.slice(found.end + 1).replace(/^\n+/, "");
	// A model that puts a blank line between the suggestion and the answer left
	// the remainder opening with a newline, so the first rendered row was empty
	// and took the glyph the answer's own text row was owed.
	const answerText = before.length > 0 && after.length > 0 ? `${before}\n${after}` : before + after;
	if (answerText.trim().length === 0) return null;
	const split = seg.suggestionSplit ?? {
		suggestion: "",
		answer: { kind: "text", text: answerText, finalized: seg.finalized } as TextSegment,
	};
	seg.suggestionSplit = split;
	split.suggestion = seg.text.slice(found.start, found.end).replace(/\r$/, "");
	const answer = split.answer;
	if (answer.text === answerText && answer.finalized === seg.finalized) return split;
	replaceSegmentText(answer, answerText);
	answer.finalized = seg.finalized;
	return split;
}

/**
 * The cards that render as one group: one dispatch call's, or for the operator's `/council`, whose dispatch has no
 * tool call id, one council's. Without it those members rendered as lone cards and no member's change reached the
 * row its round's header is cached on.
 */
export const workerGroupKey = (state: WorkerEntryState): string | undefined =>
	state.parentToolCallId ?? (state.council === undefined ? undefined : `council\u0000${state.council.group}`);

/**
 * First entry of the run that owns `target` when no `agent_start` marked it
 * (a replayed turn): the entry after the operator prompt that opened it.
 */
export const runStartFallback = (transcript: TranscriptEntry[], target: number | null): number => {
	if (target === null) return 0;
	for (let index = target - 1; index >= 0; index -= 1) {
		if (transcript[index]?.role === "user") return index + 1;
	}
	return 0;
};

/**
 * Locate the most recent tool segment with this call id anywhere in the
 * transcript. A mid-turn notice entry (safety-net block, approval parked,
 * context-engine notice) splits the transcript, so an in-flight call's
 * segment can live in an earlier assistant entry than the tail. Unfinished
 * segments win over finished ones so an id the model reuses binds to the
 * live call, not the settled one. Among finished segments only a
 * force-settled one (no end event of its own) is returned: a late true
 * result may upgrade the synthetic settle, but a segment that finished
 * with its own result is never rewritten after the fact.
 */
export const findToolSegmentOwner = (
	transcript: TranscriptEntry[],
	toolCallId: string,
): { segment: ToolSegment; entry: TranscriptEntry } | undefined => {
	let settledMatch: { segment: ToolSegment; entry: TranscriptEntry } | undefined;
	for (let entryIndex = transcript.length - 1; entryIndex >= 0; entryIndex -= 1) {
		const entry = transcript[entryIndex];
		if (entry?.role !== "assistant") continue;
		for (let segIndex = entry.segments.length - 1; segIndex >= 0; segIndex -= 1) {
			const seg = entry.segments[segIndex];
			if (seg?.kind !== "tool" || seg.id !== toolCallId) continue;
			if (!seg.finished) return { segment: seg, entry };
			if (seg.settledWithoutResult === true) settledMatch ??= { segment: seg, entry };
		}
	}
	return settledMatch;
};

/** The retry row of the turn on screen: attempts after the newest prompt share it. */
export const turnRetryRow = (
	transcript: TranscriptEntry[],
): Extract<TranscriptEntry, { role: "retryStatus" }> | null => {
	for (let index = transcript.length - 1; index >= 0; index -= 1) {
		const entry = transcript[index];
		// A move closed that row: the attempts on the new route open their own.
		if (entry?.role === "retryStatus") return entry.status.phase === "moved" ? null : entry;
		if (entry?.role === "user") return null;
	}
	return null;
};

/**
 * `Reply from` names routes that answered. A call PanCode never sent, such as one whose admission could not load its
 * model, got no reply, so the model its start named comes back off the row (a residency refusal printed
 * `Reply from mock-router · cold-b` above `cannot load 'cold-b'`).
 */
export const detachUnsentModel = (assistant: Extract<TranscriptEntry, { role: "assistant" }>): void => {
	const model = assistant.messageStartModel;
	if (model === undefined || assistant.models?.at(-1) !== model) return;
	assistant.models.pop();
	if (assistant.models.length === 0) {
		delete assistant.models;
		delete assistant.sameModelAsBefore;
	}
};

/** True when the entry renders at least one counting elapsed line this frame. */
export const entryHasRunningTool = (entry: TranscriptEntry): boolean =>
	(entry.role === "assistant" &&
		(entry.segments.some(
			(segment) => segment.kind === "tool" && !segment.finished && segment.startedAtMs !== undefined,
			// The live reasoning line counts its own elapsed, so a turn that is
			// only thinking still needs the time-keyed render key.
		) ||
			(entry.pending && openThinkingSegment(entry)?.startedAtMs !== undefined))) ||
	(entry.role === "worker" && entry.state.pending && entry.state.startedAtMs !== undefined) ||
	(entry.role === "replayBlock" && entry.isLive?.() === true) ||
	(entry.role === "user" && (entry.status?.() ?? "committed") !== "committed");

/**
 * Settled entries whose render is a pure function of the base key. A live
 * worker block is excluded for the same reason a running tool is: the
 * reducer mutates its state object in place, so a cached render would keep
 * serving the answer as it looked several deltas ago. A replay block that
 * declares itself live is excluded on the same grounds.
 */
export const entryIsStable = (entry: TranscriptEntry): boolean =>
	(entry.role === "user" && (entry.status?.() ?? "committed") === "committed") ||
	(entry.role === "replayBlock" && entry.isLive?.() !== true) ||
	entry.role === "retryStatus" ||
	(entry.role === "worker" && !entry.state.pending) ||
	(entry.role === "assistant" &&
		!entry.pending &&
		!entry.segments.some((segment) => segment.kind === "tool" && !segment.finished));
