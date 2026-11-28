// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Streaming a chat turn to the client as ACP `session/update` frames: the
 * per-session and per-prompt state, tool call presentation and wire ids,
 * assistant text chunks, stop reasons, and the chat event handler.
 */

import { randomUUID } from "node:crypto";
import { basename, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { messageCallsForAccounting } from "../../core/message-accounting.js";
import { ToolNames } from "../../core/tool-names.js";
import { displayImageMimeType, toolResultImages, toolResultShotPaths } from "../../core/tool-result-images.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { isRecord } from "../../core/type-guards.js";
import type { ThinkingLevel } from "../../core/views/thinking-levels.js";
import { TOOL_TITLE_MAX_BYTES } from "../../core/views/tool-words.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import {
	messageStopCompleted,
	redactStreamingUrlCredentials,
	redactUrlCredentials,
	UrlCredentialStreamFilter,
} from "../../lib/secrets/redaction.js";
import {
	classifyTurnEnding,
	HOST_STATUS_NOTICE_KEY,
	THINKING_CLAMP_NOTICE_KEY,
	turnCallsNotRunSentence,
	turnNoAnswerSentence,
} from "../../session-control/chat-loop-messages.js";
import { CONTEXT_STATUS_NOTICE_KEY } from "../../session-control/compaction-lines.js";
import { gatewayChainPlan } from "../../tools/gateway-display.js";
import { toolResultPresentationText } from "../../tools/result-disposition.js";
import { effectiveToolCall } from "../../tools/surface.js";
import type { AgentMessage } from "../types.js";
import { clippedArgsCommand } from "../worker-refusals.js";
import { commandResultLines } from "./command-result.js";
import type { AcpConsentAsk } from "./commands.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import type { AcpLiveTelemetry, AcpPromptTurn, PromptUsage } from "./live-telemetry.js";
import {
	boundRawInput,
	boundRawRecord,
	boundString,
	chunkText,
	safeStoredIdentifier,
	safeStoredString,
	utf8Bytes,
} from "./server-bounds.js";
import type { AcpEventRecord, AcpServerEvent } from "./server-options.js";
import { ACP_MAX_PROMPT_IMAGES } from "./server-prompt-input.js";
import type { AcpJsonRpcPeerTransport } from "./transport.js";
import type {
	AcpRequestPermissionResponse,
	AcpSessionUpdateParams,
	AcpToolCallLocation,
	AcpToolCallStatus,
	AcpToolKind,
} from "./types.js";
import {
	ACP_AGENT_META_KEY,
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_MAX_TOOL_CALL_ID_BYTES,
	ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
	ACP_MEMORY_CAPTURE_META_KEY,
	ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
	ACP_NOTICE_META_KEY,
	ACP_TOOL_TIMING_META_KEY,
} from "./types.js";

export interface AcpServerSession {
	id: string;
	cwd: string;
	autonomy: AutonomyLevel;
	autonomySource: "settings" | "session";
	target: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
	createdAt: string;
	activePrompt: ActivePrompt | null;
	/** The client's own session ceiling from `session/new`; the operator's limits sit under it. */
	ceiling?: TurnConstraints;
}

export interface ActivePrompt {
	cancelled: boolean;
	/** The server approval ceiling won; distinct from operator cancellation/denial. */
	permissionExpired: boolean;
	/** The ACP presentation ceiling won before a 129th tool call reached the wire. */
	toolCallLimitReached: boolean;
	/** The loop guard stopped a run of this prompt: an engine abort after it is the guard's, not the client's. */
	guardStopped?: boolean;
	errored: boolean;
	errorMessage?: string;
	/** Machine-readable reason from the first admission notice of this turn. */
	admissionReason?: string;
	/** Agent text sent across the whole prompt; only says whether any text went out. */
	sentAssistantChars: number;
	/** Agent text sent for the current assistant message, the offset its `message_end` tail starts from (x7-6). */
	messageAssistantChars: number;
	/** An assistant message ended after text went out, so the next message's text opens on a blank line (bt-41). */
	textBreakPending: boolean;
	/**
	 * Lines a slash command run inside this prompt already sent as reply notices. Its result repeats what its host
	 * heard, so those lines are not sent a second time (bt-session-res J10). Null outside such a command.
	 */
	commandNoticeLines?: Set<string> | null;
	/** The content index of the current message's last streamed text block; a new one opens on a blank line. */
	messageTextBlock?: number | undefined;
	/** Thinking sent for the current assistant message, reset at its boundaries like `messageAssistantChars`. */
	sentThinkingChars: number;
	/** Chunks only append, so URL credentials are settled before they are sent (#446). */
	textCredentials: UrlCredentialStreamFilter;
	thinkingCredentials: UrlCredentialStreamFilter;
	/** `session/update` notifications emitted for this turn. */
	updatesSent: number;
	/** True once the engine reported a turn end (`message_end` or `agent_end`). */
	sawTurnEnd: boolean;
	stopReason: string;
	/** The operator turns and call attempts the usage block reads from the telemetry read model. */
	turn: AcpPromptTurn;
	/** The usage block the turn's last meter frame carried, which the prompt response repeats. */
	settledUsage?: PromptUsage | null;
	model?: string;
	/** The target that served the turn's newest assistant call. */
	target?: string;
	generationMs?: number;
	timedOutputTokens?: number;
	ttftMs?: number;
	/**
	 * Engine tool-call id -> every wire id it has been given this turn, oldest
	 * first. An engine that reuses one id for two calls gets a second wire id
	 * rather than a second call folded onto the first.
	 */
	toolCallWireIds: Map<string, string[]>;
	/** Every wire id this turn has handed out, literal engine ids and aliases alike. */
	usedWireIds: Set<string>;
	/** Wire ids that received `tool_call` and no terminal `tool_call_update`. */
	openToolCalls: Set<string>;
	/**
	 * Wire ids that have already received a terminal `tool_call_update`, the
	 * cancel/fail sweep included. A client renders the first terminal update it
	 * sees and a second one for the same id either resurrects a finished call or
	 * overwrites its result, so a terminal id is never updated again.
	 */
	terminalToolCalls: Set<string>;
	/**
	 * Wire id -> the exact frame material that id's `tool_call` carried. A
	 * permission request reuses this instead of deriving anything from the
	 * registry's copy of the call: a tool's `prepareAdmissionArguments` may
	 * normalize or wholly replace the arguments before the safety net sees them,
	 * so the two frames legitimately disagreed and a client diffing the call it
	 * rendered against the call it is asked to approve failed closed. One entry
	 * per emitted call, each bounded by the raw-record cap, so the map is bounded
	 * by the turn's tool calls and dies with the turn.
	 */
	toolCallSnapshots: Map<string, AcpToolCallSnapshot>;
	/**
	 * Wire ids reported `in_progress`. A call is announced `pending`, since admission, the safety judge or an approval may
	 * still hold it, and moves to `in_progress` once when its body starts.
	 */
	runningToolCalls: Set<string>;
	/** Engine ids whose body started before their `tool_call` was emitted, so that call is announced running. */
	earlyToolBodies: Set<string>;
	/**
	 * Engine id -> the start of a `finish` call not yet on the wire. The engine announces a call before the completion
	 * protocol decides it, and a finish that protocol refuses is the model's internal retry, not a failed tool, so its
	 * `tool_call` waits for the end that says which (R2-F15). `finish` is pure, so the wait is its own run.
	 */
	heldFinishStarts: Map<string, AcpEventRecord>;
	/** Most recent wire id a `tool_call` was actually emitted for, open or not. */
	lastEmittedToolCallId: string | null;
	toolCallSequence: number;
	/** Opt-in state and per-call counters for the non-terminal progress stream. */
	toolProgress: AcpToolProgressState;
	/**
	 * The run a queue send-now started by interrupting this one. The request
	 * that opened the turn waits for it, so its events stream on the same
	 * subscription and its stop reason is the one this prompt returns.
	 */
	continuation: Promise<void> | null;
	/** False once the request stopped waiting on runs; a send-now then has nothing to ride. */
	acceptsContinuation: boolean;
	/** Set while the prompt's `@path` attachments expand; session/cancel aborts a slow PDF read through it. */
	expansionAbort?: AbortController;
	/**
	 * Set on a scheduled main turn, which no `session/prompt` brackets. The first frame it sends
	 * opens the client's turn through `job.changed`, and releasing the lease closes it (#411).
	 */
	scheduled?: { readonly jobId: string; opened: boolean; open(): void };
}

/**
 * What one turn has already streamed for each running tool call. The payload a
 * tool reports is cumulative, so the last text sent is kept as well as the
 * counters: an unchanged snapshot is a re-send of a frame the client already
 * rendered and carries nothing it does not have. Bounded by the turn's tool
 * calls and dies with the turn.
 */
interface AcpToolProgressState {
	enabled: boolean;
	now: () => number;
	calls: Map<string, { frames: number; lastSentAt: number; lastText: string }>;
}

/** What one emitted `tool_call` put on the wire that its permission request must repeat. */
export interface AcpToolCallSnapshot {
	rawInput: Record<string, unknown>;
	locations?: AcpToolCallLocation[];
	/** Exact title and kind this call was announced under, replayed by later updates. */
	title: string;
	kind: AcpToolKind;
	/**
	 * Delegated agents this call spawned, oldest first, bounded by
	 * {@link ACP_MAX_TOOL_CALL_AGENTS}. A dispatch tool that fans out reports one
	 * entry per run, which is what lets a client label the segment with the
	 * agents that actually ran under it rather than with the product name.
	 */
	agents?: AcpAgentAttribution[];
}

/** One `pancode/agent` attribution entry. `role` names where the identity came from. */
interface AcpAgentAttribution {
	version: 1;
	role: "orchestrator" | "worker";
	agentId: string;
	runId?: string;
	node?: string;
}

/** The capture chip's fields, closed sets only, so a client never renders an arbitrary engine object. */
function memoryCaptureMeta(chip: Record<string, unknown>): Record<string, unknown> {
	const pick = (value: unknown, allowed: readonly string[]): string | undefined =>
		typeof value === "string" && allowed.includes(value) ? value : undefined;
	const scope = pick(chip.scope, ["session", "project", "global"]);
	const kind = pick(chip.kind, ["fact", "preference", "rule", "command"]);
	return {
		version: 1,
		captureId: typeof chip.captureId === "string" ? chip.captureId.slice(0, 64) : "",
		action: pick(chip.action, ["remembered", "forgot", "undone", "refused"]) ?? "remembered",
		...(scope !== undefined ? { scope } : {}),
		...(kind !== undefined ? { kind } : {}),
		text: typeof chip.text === "string" ? safeStoredString(chip.text, 1024) : "",
	};
}

export function eventRecord(value: unknown): AcpEventRecord {
	return isRecord(value) ? value : {};
}

export function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

/**
 * Maps PanCode canonical tool names onto the ACP v1 `ToolKind` closed enum. The
 * kind is a UI hint; the human-readable tool name travels in `title`. Anything
 * unrecognised (dynamic/MCP tools) falls back to `other` so the discriminated
 * union always deserialises on strict clients.
 */
const TOOL_KIND_BY_NAME: Record<string, AcpToolKind> = {
	read: "read",
	ls: "read",
	context: "read",
	write: "edit",
	edit: "edit",
	artifact: "edit",
	grep: "search",
	find: "search",
	code_nav: "search",
	bash: "execute",
	verify: "execute",
	web_fetch: "fetch",
	git: "other",
	dispatch: "other",
	monitor: "read",
	steer: "other",
};

/**
 * The admission reasons this server puts on the wire (CONTRACT C001 §4). The
 * engine's runtime-resolution diagnostics are a larger and faster-moving set
 * (`runtime-target-unsupported`, `runtime-use-unsupported`,
 * `required-capability-missing`, …), and a client cannot branch on codes the
 * profile never promised, so anything outside this set is reported as the
 * catch-all rather than leaking an engine-internal identifier.
 */
const ACP_ADMISSION_REASONS = new Set([
	"orchestrator-not-configured",
	"target-unknown",
	"target-not-configured",
	"target-not-found",
	"runtime-not-registered",
	"model-not-configured",
	"chat-unsupported",
	"streaming-unsupported",
	"context-window-exceeded",
	"handoff-skill-refused",
	"admission-failed",
]);

/** A refusal whose notice carries no settings path and tells the client what to do instead, so it crosses the wire as text. */
const ACP_VISIBLE_ADMISSION_REASONS = new Set(["handoff-skill-refused"]);

const ACP_ADMISSION_FALLBACK_REASON = "admission-failed";

/**
 * Host information lines are not reply text: context engine status (working set, the compaction row, the no-gain line)
 * reports PanCode's own housekeeping, the thinking clamp line says the route cannot apply the requested level, and host
 * status lines report the route, model residency, skill surface, image sidecar and project instructions. Their
 * producers tag them by key; the wording is free to change. Warnings, errors and untagged lines stay reply text.
 */
const ACP_HOST_INFO_NOTICE_KEYS: ReadonlySet<unknown> = new Set([
	CONTEXT_STATUS_NOTICE_KEY,
	THINKING_CLAMP_NOTICE_KEY,
	HOST_STATUS_NOTICE_KEY,
]);

function isHostInfoNotice(level: unknown, noticeKey: unknown): boolean {
	return level === "info" && ACP_HOST_INFO_NOTICE_KEYS.has(noticeKey);
}

function admissionReason(raw: string): string {
	return ACP_ADMISSION_REASONS.has(raw) ? raw : ACP_ADMISSION_FALLBACK_REASON;
}

export function toolKind(name: string | undefined): AcpToolKind {
	if (!name) return "other";
	return TOOL_KIND_BY_NAME[name] ?? "other";
}

/** ACP `ToolCallContent[]`. The `content` variant wraps a regular ContentBlock. */
export function toolCallContent(text: string): Array<{ type: "content"; content: { type: "text"; text: string } }> {
	return [{ type: "content", content: textContent(text) }];
}

/**
 * Image characters one settled tool update may carry. The update is one stdio line and a peer reads at most
 * `ACP_MAX_INPUT_LINE_BYTES`, so images stay well under it; one that does not fit is still named by its file link.
 */
const ACP_MAX_TOOL_IMAGE_CHARS = 256 * 1024;

/**
 * A settled tool call's content: its text, the result's images as ACP image blocks (its inline images, or on a route
 * that took no image the display copies in `details.displayImages`; at most {@link ACP_MAX_PROMPT_IMAGES}, within
 * {@link ACP_MAX_TOOL_IMAGE_CHARS}), and each screenshot file it names as a `resource_link`, so a client sees a
 * screenshot on every route.
 */
export function toolResultContent(
	output: string,
	result: unknown,
): Array<{ type: "content"; content: Record<string, unknown> }> {
	const content: Array<{ type: "content"; content: Record<string, unknown> }> =
		output.length > 0 ? toolCallContent(output) : [];
	let room = ACP_MAX_TOOL_IMAGE_CHARS;
	let images = 0;
	for (const image of toolResultImages(result)) {
		if (images >= ACP_MAX_PROMPT_IMAGES) break;
		if (image.data.length > room) continue;
		content.push({ type: "content", content: { type: "image", mimeType: image.mimeType, data: image.data } });
		room -= image.data.length;
		images += 1;
	}
	for (const path of toolResultShotPaths(result)) {
		const uri = pathToFileURL(path).href;
		if (utf8Bytes(uri) > ACP_MAX_LOCATION_PATH_BYTES) continue;
		content.push({
			type: "content",
			content: {
				type: "resource_link",
				uri,
				name: boundString(basename(path), ACP_MAX_TOOL_TITLE_BYTES),
				mimeType: displayImageMimeType(path) ?? "image/png",
			},
		});
	}
	return content;
}

/**
 * A result for `rawOutput` with image data left out: the image travels once, as a content block. Inline image blocks
 * and the `details.displayImages` copies both keep only their MIME type and `omitted: true`.
 */
export function withoutImageData(result: unknown): unknown {
	if (!isRecord(result)) return result;
	const omitted = (block: unknown) => ({
		type: "image",
		...(isRecord(block) && typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
		omitted: true,
	});
	const content = Array.isArray(result.content) ? result.content : [];
	const inline = content.some((block) => isRecord(block) && block.type === "image");
	const details = isRecord(result.details) ? result.details : null;
	const copies = details !== null && Array.isArray(details.displayImages) ? details.displayImages : null;
	if (!inline && copies === null) return result;
	return {
		...result,
		...(inline
			? { content: content.map((block) => (isRecord(block) && block.type === "image" ? omitted(block) : block)) }
			: {}),
		...(details !== null && copies !== null ? { details: { ...details, displayImages: copies.map(omitted) } } : {}),
	};
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
	if (!isRecord(value)) return "";
	if (value.type === "text" && typeof value.text === "string") return value.text;
	if (Array.isArray(value.content)) return contentText(value.content);
	if (typeof value.content === "string") return value.content;
	return "";
}

/** Frozen bounds for standard ACP tool-call presentation fields. */
const ACP_MAX_LOCATION_PATH_BYTES = 4 * 1024;
/** The tool title bound the GUI card holds its headline to as well. */
export const ACP_MAX_TOOL_TITLE_BYTES = TOOL_TITLE_MAX_BYTES;

/** W001-A1 cardinality bounds for one live prompt and one load replay. */
export const ACP_MAX_LIVE_TOOL_CALLS = 128;

/** Delegated agents recorded against one tool call before further ones are dropped. */
export const ACP_MAX_TOOL_CALL_AGENTS = 16;

/**
 * Attribution for a frame this server produced on the main session. Every live
 * frame carries it, so a client never has to decide whether an unattributed
 * frame means "the orchestrator" or "identity unavailable".
 */
const ORCHESTRATOR_ATTRIBUTION: AcpAgentAttribution = {
	version: 1,
	role: "orchestrator",
	agentId: "orchestrator",
};

export const ORCHESTRATOR_UPDATE_META: Record<string, unknown> = {
	[ACP_AGENT_META_KEY]: [ORCHESTRATOR_ATTRIBUTION],
};

/** Adds the engine's span for the call, when it reported a usable one, to a terminal update's `_meta`. */
function withToolTiming(meta: Record<string, unknown>, durationMs: unknown): Record<string, unknown> {
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return meta;
	return { ...meta, [ACP_TOOL_TIMING_META_KEY]: { durationMs: Math.round(durationMs) } };
}

/** The `_meta` a tool-call frame carries: its own agents when it spawned any, else the orchestrator. */
export function toolCallUpdateMeta(snapshot: AcpToolCallSnapshot | undefined): Record<string, unknown> {
	if (snapshot?.agents === undefined || snapshot.agents.length === 0) return ORCHESTRATOR_UPDATE_META;
	return { [ACP_AGENT_META_KEY]: [ORCHESTRATOR_ATTRIBUTION, ...snapshot.agents] };
}

/**
 * The title of a main-session permission ask: a shell call reads as its command, any other call as its tool and
 * target, and a call that names nothing as its tool.
 */
export function permissionTitle(tool: string, command: string): string {
	if (command.length === 0) return tool;
	return tool === ToolNames.Bash ? command : `${tool}: ${command}`;
}

/** Built-in tools whose first positional argument names a workspace path. */
const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

/**
 * The standard `locations` field for a path-bearing call. The path is resolved
 * against the pinned workspace root but never realpath'ed: an `edit` or `write`
 * target legitimately does not exist yet, and a client that canonicalizes on
 * its own side treats an absent `locations` as "unavailable".
 */
function toolLocations(toolName: string | undefined, args: unknown, cwd: string): AcpToolCallLocation[] | null {
	if (toolName === undefined || !PATH_BEARING_TOOLS.has(toolName)) return null;
	if (!isRecord(args)) return null;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return null;
	// Ahead of resolving, which folds the `//` of a URL the pattern reads (#446).
	return [{ path: boundString(resolvePath(cwd, redactUrlCredentials(path)), ACP_MAX_LOCATION_PATH_BYTES) }];
}

/**
 * The title, kind and locations a client renders for one call, read through the
 * capability a gateway call reaches. The live start and the replayed one both
 * present a call through this, so a reloaded card matches the live one.
 */
export function toolCallPresentation(
	toolName: string | undefined,
	args: unknown,
	cwd: string,
): Pick<AcpToolCallSnapshot, "title" | "kind" | "locations"> {
	const call = toolName === undefined ? undefined : effectiveToolCall(toolName, args);
	const chainSteps = toolName === undefined ? [] : gatewayChainPlan(toolName, args);
	const capability =
		chainSteps.length > 0
			? `gateway chain(${chainSteps.map((step) => step.capability).join(", ")})`
			: (call?.toolName ?? toolName);
	const locations = toolLocations(capability, call?.viaGateway ? call.args : args, cwd);
	// The card reads as the permission ask for the call does: a shell call as its command, any other call as its tool
	// and target, scrubbed and clipped the same way. A chain names its capabilities.
	const named =
		chainSteps.length > 0 || call === undefined
			? (capability ?? "tool")
			: permissionTitle(call.toolName, clippedArgsCommand(call.toolName, call.args));
	return {
		...(locations !== null ? { locations } : {}),
		title: boundString(redactUrlCredentials(named), ACP_MAX_TOOL_TITLE_BYTES),
		kind: toolKind(chainSteps.length > 0 ? toolName : capability),
	};
}

export function createActivePromptState(toolProgress?: { enabled: boolean; now: () => number }): ActivePrompt {
	return {
		cancelled: false,
		permissionExpired: false,
		toolCallLimitReached: false,
		errored: false,
		sentAssistantChars: 0,
		messageAssistantChars: 0,
		textBreakPending: false,
		sentThinkingChars: 0,
		textCredentials: new UrlCredentialStreamFilter(),
		thinkingCredentials: new UrlCredentialStreamFilter(),
		updatesSent: 0,
		sawTurnEnd: false,
		stopReason: "end_turn",
		turn: { turnIds: new Set<string>(), attemptIds: new Set<string>() },
		toolCallWireIds: new Map<string, string[]>(),
		usedWireIds: new Set<string>(),
		openToolCalls: new Set<string>(),
		terminalToolCalls: new Set<string>(),
		toolCallSnapshots: new Map<string, AcpToolCallSnapshot>(),
		runningToolCalls: new Set<string>(),
		earlyToolBodies: new Set<string>(),
		heldFinishStarts: new Map<string, AcpEventRecord>(),
		lastEmittedToolCallId: null,
		toolCallSequence: 0,
		toolProgress: {
			enabled: toolProgress?.enabled === true,
			now: toolProgress?.now ?? Date.now,
			calls: new Map<string, { frames: number; lastSentAt: number; lastText: string }>(),
		},
		continuation: null,
		acceptsContinuation: true,
	};
}

/** Notes the call attempts a message settled, which the turn's usage block waits for the read model to fold. */
function noteSettledCalls(turn: AcpPromptTurn, message: unknown): void {
	for (const call of messageCallsForAccounting(message) ?? []) turn.attemptIds.add(call.attemptId);
}

function assistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant") return "";
	return contentText(message.content);
}

/**
 * The text of an assistant message that its deltas did not carry. `streamed` counts delta characters, without the
 * blank lines put between blocks, so the tail starts where the deltas stopped (x8-3). A block the deltas never
 * reached opens on a blank line after earlier text, as a streamed one does (bt-acp-tail).
 */
function assistantTextTail(message: unknown, streamed: number): string {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content))
		return assistantText(message).slice(streamed);
	let offset = 0;
	let tail = "";
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || block.text.length === 0) continue;
		const start = offset;
		offset += block.text.length;
		if (offset <= streamed) continue;
		tail += start >= streamed && start > 0 ? `\n\n${block.text}` : block.text.slice(streamed - start);
	}
	return tail;
}

/** A failed load. A format error says how to fix it, less the session's path: an ACP message carries none. */
export function loadFailure(error: unknown): AcpRequestError {
	const message = acpErrorMessage(
		String(error instanceof Error ? error.message : error).replace(/\): .*\. (?=Upgrade|Remove)/su, "). "),
	);
	if (/format version/u.test(message)) return new AcpRequestError(-32602, message, { code: "session_format" });
	return new AcpRequestError(-32603, "session could not be loaded", { code: "internal_error" });
}

/**
 * The text blocks of one message, a blank line between them as the live stream sends them (bt-acp-tail). `afterText`
 * says an earlier message of the same turn already sent text, so the first block opens on a blank line too, as
 * `sendAssistantText` parts two live messages (bt-session-res J9).
 */
export function separatedTextBlocks(blocks: ReadonlyArray<string>, afterText = false): string[] {
	return blocks
		.filter((text) => text.length > 0)
		.map((text, index) => (index === 0 && !afterText ? text : `\n\n${text}`));
}

function eventContentIndex(event: AcpEventRecord): number | undefined {
	const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
	const index = event.contentIndex ?? assistantEvent?.contentIndex;
	return typeof index === "number" ? index : undefined;
}

function assistantThinking(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.map((block) => {
			if (!isRecord(block)) return "";
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			if (block.type === "thinking" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("");
}

/**
 * Collapses pi-agent / PanCode message stop reasons onto the ACP v1 StopReason
 * closed enum (end_turn | max_tokens | max_turn_requests | refusal | cancelled).
 * Tool-driven or unknown reasons ("stop", "toolUse", "length"…) map to
 * "end_turn"; "error" is a sentinel that the prompt handler converts into a
 * JSON-RPC error, since ACP has no error StopReason.
 */
export function mapAcpStopReason(raw: unknown): string {
	switch (raw) {
		case "aborted":
		case "cancelled":
			return "cancelled";
		case "error":
			return "error";
		case "refusal":
			return "refusal";
		case "length":
		case "max_tokens":
		case "maxTokens":
			return "max_tokens";
		case "max_turn_requests":
		case "maxTurnRequests":
			return "max_turn_requests";
		default:
			return "end_turn";
	}
}

/** Applies a message's stop reason to the active prompt, tracking the error sentinel. */
function applyStopReason(active: ActivePrompt, message: unknown): void {
	const mapped = mapAcpStopReason(isRecord(message) ? message.stopReason : undefined);
	if (mapped === "error") {
		active.errored = true;
		const explicit = isRecord(message) && typeof message.errorMessage === "string" ? message.errorMessage : "";
		const text = explicit.length > 0 ? explicit : assistantText(message);
		if (text.length > 0) active.errorMessage = text;
		return;
	}
	active.errored = false;
	// ACP has no stop reason for a harness limit other than max_turn_requests; cancelled is the client's.
	active.stopReason = mapped === "cancelled" && active.guardStopped === true ? "max_turn_requests" : mapped;
}

export function outputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	const presentationText = toolResultPresentationText(value);
	if (presentationText !== null) return presentationText;
	if (Array.isArray(value.content)) return contentText(value.content);
	if (typeof value.output === "string") return value.output;
	if (typeof value.text === "string") return value.text;
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

function toolStatus(event: AcpEventRecord): string {
	return toolFailed(event) ? "failed" : "completed";
}

/** The output limit cut the call off before it ran: no error, and the client is told it never ran (bt-39 a). */
function toolNotRun(event: AcpEventRecord): string | undefined {
	return typeof event.notRun === "string" ? event.notRun : undefined;
}

function toolFailed(event: AcpEventRecord): boolean {
	return event.isError === true && toolNotRun(event) === undefined;
}

function eventString(event: AcpEventRecord, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = event[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function eventTextDelta(event: AcpEventRecord): string {
	const direct = eventString(event, "delta", "text");
	if (direct !== undefined) return direct;
	const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
	if (assistantEvent) {
		const nested = assistantEvent.delta;
		if (typeof nested === "string") return nested;
	}
	return "";
}

/**
 * The next unused `pancode-tool-<n>`. The counter alone is not enough: an engine
 * that names its own calls `pancode-tool-1` would otherwise collide with an alias
 * this server minted, and two different calls sharing one wire id is the exact
 * failure aliasing exists to prevent.
 */
function nextAliasToolCallId(active: ActivePrompt): string {
	for (;;) {
		active.toolCallSequence += 1;
		const alias = `pancode-tool-${active.toolCallSequence}`;
		if (active.usedWireIds.has(alias)) continue;
		active.usedWireIds.add(alias);
		return alias;
	}
}

/** Records `wireId` as the newest wire id this engine id speaks under. */
function pushWireId(active: ActivePrompt, engineId: string, wireId: string): string {
	const existing = active.toolCallWireIds.get(engineId);
	if (existing === undefined) active.toolCallWireIds.set(engineId, [wireId]);
	else existing.push(wireId);
	return wireId;
}

/**
 * The first wire id an engine id gets. The engine's own id is used when it fits
 * the wire bound and no other call in this turn has claimed it; otherwise the
 * call travels under a per-prompt alias.
 */
function mintWireId(active: ActivePrompt, engineId: string): string {
	const usable = utf8Bytes(engineId) <= ACP_MAX_TOOL_CALL_ID_BYTES && !active.usedWireIds.has(engineId);
	if (usable) active.usedWireIds.add(engineId);
	return pushWireId(active, engineId, usable ? engineId : nextAliasToolCallId(active));
}

/**
 * The id a starting tool call travels under. An engine id this turn has already
 * used gets a fresh alias rather than the wire id of the earlier call: engines
 * that number their calls per request legitimately repeat an id, and reusing the
 * wire id merged two distinct calls into one on the client, so the second call's
 * arguments overwrote the first and one of the two ends was lost.
 */
export function startToolCallId(active: ActivePrompt, engineId: string | undefined): string {
	if (engineId === undefined || engineId.length === 0) return nextAliasToolCallId(active);
	if (active.toolCallWireIds.has(engineId)) return pushWireId(active, engineId, nextAliasToolCallId(active));
	return mintWireId(active, engineId);
}

/**
 * The most recently opened wire id for this engine id, or null when it names no
 * call that is still open. "Open" is the client's own view: a `tool_call` was
 * emitted and no terminal `tool_call_update` followed it.
 */
export function openWireIdFor(active: ActivePrompt, engineId: string): string | null {
	const wireIds = active.toolCallWireIds.get(engineId);
	if (wireIds === undefined) return null;
	for (let index = wireIds.length - 1; index >= 0; index -= 1) {
		const wireId = wireIds[index];
		if (wireId !== undefined && active.openToolCalls.has(wireId)) return wireId;
	}
	return null;
}

/**
 * The most recently opened wire id this turn still has running, or null when
 * nothing is open. `openToolCalls` is insertion-ordered and only ever loses
 * members, so the last one standing is the newest call the client has been shown
 * and not yet seen finish.
 */
export function newestOpenToolCallId(active: ActivePrompt): string | null {
	let newest: string | null = null;
	for (const wireId of active.openToolCalls) newest = wireId;
	return newest;
}

/**
 * The wire id an ending tool call travels under, or null when this turn has no
 * call it could belong to. Nothing here mints: an end is an update to a call the
 * client already rendered, and a fresh id announced a `tool_call_update` for a
 * `tool_call` that was never sent, which a client either drops or renders as a
 * tool that finished without ever starting.
 *
 * An end that names an engine id is confined to that engine id's own calls. It
 * closes them newest first, which is the order a nested or retried call finishes
 * in, and when they are all finished it still resolves to that id's last wire id
 * so the caller can drop the end as the duplicate it is. An engine id this turn
 * emitted nothing for binds to nothing: borrowing another call's wire id
 * reported one tool's result under another tool's identity and closed a call
 * that was still running.
 *
 * An end with no engine id belongs to the newest call still running, which is
 * what makes nested lifecycles work. With A and B open and B already ended, the
 * next unidentified end is A's. With nothing open it falls back to the last call
 * the client actually saw, so the caller drops it as a duplicate rather than
 * inventing an identity for it.
 */
export function endToolCallId(active: ActivePrompt, engineId: string | undefined): string | null {
	if (engineId === undefined || engineId.length === 0) {
		return newestOpenToolCallId(active) ?? active.lastEmittedToolCallId;
	}
	const open = openWireIdFor(active, engineId);
	if (open !== null) return open;
	const wireIds = active.toolCallWireIds.get(engineId);
	if (wireIds === undefined) return null;
	return wireIds[wireIds.length - 1] ?? null;
}

/** How long a report waits for the client to allow a diagnostic bundle before it attaches nothing. */
const REPORT_CONSENT_TIMEOUT_MS = 5 * 60_000;

/**
 * `/report --bundle` consent over ACP: the client is shown the consent text through `session/request_permission`.
 * Only `allow-once` attaches; a reject, a cancel, an error or a client without the method attaches nothing.
 */
export function reportConsentAsk(transport: AcpJsonRpcPeerTransport, sessionId: string): AcpConsentAsk {
	return async (title, consent) => {
		const response = await transport.request<AcpRequestPermissionResponse>(
			"session/request_permission",
			{
				sessionId,
				toolCall: {
					toolCallId: `report-bundle-${randomUUID()}`,
					title,
					kind: "other",
					status: "pending",
					rawInput: { consent },
					content: [{ type: "content", content: { type: "text", text: consent.join("\n") } }],
				},
				options: [
					{ optionId: "allow-once", name: "Attach the bundle", kind: "allow_once" },
					{ optionId: "reject-once", name: "Do not attach it", kind: "reject_once" },
				],
			},
			REPORT_CONSENT_TIMEOUT_MS,
		);
		return response?.outcome?.outcome === "selected" && response.outcome.optionId === "allow-once";
	};
}

export function sendUpdate(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	update: Record<string, unknown>,
	meta: Record<string, unknown> = ORCHESTRATOR_UPDATE_META,
): void {
	const params: AcpSessionUpdateParams = { sessionId, update, _meta: meta };
	if (active.scheduled !== undefined && !active.scheduled.opened) active.scheduled.open();
	active.updatesSent += 1;
	transport.notify("session/update", params);
}

export function sendTextChunks(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
	text: string,
): void {
	for (const chunk of chunkText(text, ACP_MAX_CHUNK_BYTES)) {
		sendUpdate(transport, sessionId, active, { sessionUpdate, content: textContent(chunk) });
	}
}

function sendSafeChunks(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
	text: string,
): void {
	if (text.length > 0) sendTextChunks(transport, sessionId, active, sessionUpdate, text);
}

/** Agent text for the wire only: the separator between two messages never enters the model's history. */
function sendAssistantText(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	text: string,
): void {
	const lead = active.textBreakPending ? "\n\n" : "";
	active.textBreakPending = false;
	sendSafeChunks(transport, sessionId, active, "agent_message_chunk", active.textCredentials.push(lead + text));
}

/** Send what the filters still hold. A message that did not complete keeps its open URL back. */
export function flushChunkCredentials(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	completed: boolean,
): void {
	sendSafeChunks(transport, sessionId, active, "agent_thought_chunk", active.thinkingCredentials.end(completed));
	sendSafeChunks(transport, sessionId, active, "agent_message_chunk", active.textCredentials.end(completed));
}

/**
 * Closes out every tool call that never received a terminal update. A client
 * that renders a running spinner per `tool_call` otherwise keeps spinning after
 * the turn settled, since ACP has no "the turn is over, drop what is open"
 * signal beyond the prompt response itself.
 */
export function settleOpenToolCalls(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	text: string,
): void {
	for (const toolCallId of active.openToolCalls) {
		sendUpdate(
			transport,
			sessionId,
			active,
			{
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "failed" satisfies AcpToolCallStatus,
				content: toolCallContent(text),
			},
			toolCallUpdateMeta(active.toolCallSnapshots.get(toolCallId)),
		);
		// The sweep is a terminal update like any other, so a late end for a swept
		// id cannot reopen the call the client has already seen fail.
		active.terminalToolCalls.add(toolCallId);
	}
	active.openToolCalls.clear();
}

/**
 * Streams one running tool's cumulative output as a non-terminal
 * `tool_call_update`. Nothing here mints a wire id: a frame is an update to a
 * call the client already rendered, so an event naming a call that was never
 * emitted or has already finished is dropped rather than announcing progress
 * for a `tool_call` the client has no row for.
 *
 * The three refusals below are the whole cost control. The tool's own throttle
 * bounds the rate but not the total, the payload is cumulative so a repeat
 * carries nothing new, and a client is holding per-call state that a long
 * stream would otherwise grow without a stated end.
 */
function sendToolProgress(
	event: AcpEventRecord,
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
): void {
	const progress = active.toolProgress;
	if (!progress.enabled) return;
	const engineId = eventString(event, "toolCallId");
	const toolCallId = engineId === undefined ? null : openWireIdFor(active, engineId);
	if (toolCallId === null) return;
	// Each frame replaces the last, so the hold can release later, and the bound runs after it could cut a password (#446).
	const text = boundString(redactStreamingUrlCredentials(outputText(event.partialResult)), ACP_MAX_CHUNK_BYTES);
	if (text.length === 0) return;
	const sent = progress.calls.get(toolCallId);
	const sentAt = progress.now();
	if (sent !== undefined) {
		if (sent.frames >= ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL) return;
		if (text === sent.lastText) return;
		if (sentAt - sent.lastSentAt < ACP_MIN_TOOL_PROGRESS_INTERVAL_MS) return;
	}
	progress.calls.set(toolCallId, { frames: (sent?.frames ?? 0) + 1, lastSentAt: sentAt, lastText: text });
	active.runningToolCalls.add(toolCallId);
	sendUpdate(
		transport,
		sessionId,
		active,
		{
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "in_progress" satisfies AcpToolCallStatus,
			content: toolCallContent(text),
		},
		toolCallUpdateMeta(active.toolCallSnapshots.get(toolCallId)),
	);
}

/** Kinds that only look; any other settled call may have moved the branch or the worktree. */
const READ_ONLY_TOOL_KINDS: ReadonlySet<AcpToolKind> = new Set<AcpToolKind>(["read", "search", "fetch"]);

export function observeTelemetry(telemetry: AcpLiveTelemetry, rawEvent: AcpServerEvent, active: ActivePrompt): void {
	if (active.permissionExpired || active.toolCallLimitReached) return;
	const event = eventRecord(rawEvent);
	if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
		telemetry.modelResponded();
	} else if (event.type === "tool_execution_end" && event.protocolRetry !== true) {
		telemetry.toolSettled(!READ_ONLY_TOOL_KINDS.has(toolKind(eventString(event, "toolName"))));
	}
}

/** Puts one call's `tool_call` on the wire; false once the turn reached ACP's live tool call ceiling. */
function projectToolStart(
	event: AcpEventRecord,
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	cwd: string,
	onToolCallLimitReached: () => void,
): boolean {
	// Tool starts are emitted before registry validation/admission, so PanCode's
	// configurable execution guard is not a wire-cardinality guarantee. Stop
	// before minting or emitting the 129th id; the prompt handler resolves with
	// ACP's standard max_turn_requests reason after the underlying run unwinds.
	if (active.usedWireIds.size >= ACP_MAX_LIVE_TOOL_CALLS) {
		active.toolCallLimitReached = true;
		onToolCallLimitReached();
		return false;
	}
	const toolName = eventString(event, "toolName");
	const engineId = eventString(event, "toolCallId");
	const toolCallId = startToolCallId(active, engineId);
	active.openToolCalls.add(toolCallId);
	active.lastEmittedToolCallId = toolCallId;
	const running = engineId !== undefined && active.earlyToolBodies.delete(engineId);
	if (running) active.runningToolCalls.add(toolCallId);
	// Clients render kind, title and locations per capability, and the
	// coordinator reaches most capabilities through gateway op=call.
	// Built once and kept: the permission request for this call must send the
	// same objects rather than recompute them from a copy of the arguments that
	// may since have been normalized.
	const snapshot: AcpToolCallSnapshot = {
		rawInput: boundRawInput(event.args),
		...toolCallPresentation(toolName, event.args, cwd),
	};
	active.toolCallSnapshots.set(toolCallId, snapshot);
	sendUpdate(transport, sessionId, active, {
		sessionUpdate: "tool_call",
		toolCallId,
		name: redactUrlCredentials(toolName ?? "tool"),
		title: snapshot.title,
		kind: snapshot.kind,
		status: (running ? "in_progress" : "pending") satisfies AcpToolCallStatus,
		rawInput: snapshot.rawInput,
		...(snapshot.locations !== undefined ? { locations: snapshot.locations } : {}),
	});
	return true;
}

export function handleChatEvent(
	rawEvent: AcpServerEvent,
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	cwd: string,
	diagnostics: ((line: string) => void) | undefined,
	onToolCallLimitReached: () => void,
): void {
	const event = eventRecord(rawEvent);
	// Once the approval ceiling wins, the prompt is terminal. Registry
	// cancellation may still make engine promises unwind and emit ordinary tool
	// or assistant events; none of those are part of a continuing model turn.
	if (active.permissionExpired || active.toolCallLimitReached) return;
	if (event.type === "text_delta") {
		const text = eventTextDelta(event);
		if (text.length === 0) return;
		const block = eventContentIndex(event);
		const newBlock =
			block !== undefined &&
			active.messageTextBlock !== undefined &&
			block !== active.messageTextBlock &&
			active.messageAssistantChars > 0;
		if (block !== undefined) active.messageTextBlock = block;
		active.sentAssistantChars += text.length;
		active.messageAssistantChars += text.length;
		sendAssistantText(transport, sessionId, active, newBlock ? `\n\n${text}` : text);
		return;
	}
	if (event.type === "thinking_delta") {
		const text = eventTextDelta(event);
		if (text.length === 0) return;
		active.sentThinkingChars += text.length;
		sendSafeChunks(transport, sessionId, active, "agent_thought_chunk", active.thinkingCredentials.push(text));
		return;
	}
	if (event.type === "notice") {
		const admission = isRecord(event.admission) ? event.admission : null;
		const reason = admission !== null && typeof admission.reason === "string" ? admission.reason : "";
		if (reason.length > 0 && active.admissionReason === undefined) active.admissionReason = admissionReason(reason);
		// An admission notice is the evidence that PanCode refused to start the turn:
		// the prompt fails with its reason code, and its text names the settings
		// path, which stays off the wire. Every other transcript notice is projected.
		if (
			(reason.length === 0 || ACP_VISIBLE_ADMISSION_REASONS.has(reason)) &&
			event.surface === "transcript" &&
			typeof event.text === "string" &&
			event.text.length > 0
		) {
			// A host information line crosses the way startup notices do, so a client that ignores `_meta` shows a reply
			// carrying only the model's text.
			if (isHostInfoNotice(event.level, event.key)) {
				const notice = { level: "info", text: safeStoredString(event.text, ACP_MAX_CHUNK_BYTES) };
				sendUpdate(transport, sessionId, active, {
					sessionUpdate: "session_info_update",
					_meta: { [ACP_NOTICE_META_KEY]: notice },
				});
				return;
			}
			const shown = safeStoredString(event.text, ACP_MAX_CHUNK_BYTES - 2);
			// The notice crosses on one line (a control character becomes a space) while the result holds its lines apart,
			// each cut to the result's line bound: when the notice carried its whole text, its lines are kept as the result
			// holds them, so a long or multi-line notice still matches the result lines that repeat it.
			if (active.commandNoticeLines && shown === safeStoredString(event.text, Number.MAX_SAFE_INTEGER))
				for (const line of commandResultLines(event.text)) active.commandNoticeLines.add(line);
			sendUpdate(
				transport,
				sessionId,
				active,
				{
					sessionUpdate: "agent_message_chunk",
					content: textContent(`${shown}\n`),
				},
				{
					...ORCHESTRATOR_UPDATE_META,
					// The key names what the notice reports, so a client can place a turn's own continuation in its transcript.
					[ACP_NOTICE_META_KEY]: { level: event.level, ...(typeof event.key === "string" ? { key: event.key } : {}) },
					...(isRecord(event.memory) ? { [ACP_MEMORY_CAPTURE_META_KEY]: memoryCaptureMeta(event.memory) } : {}),
				},
			);
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		const engineId = eventString(event, "toolCallId");
		const toolName = eventString(event, "toolName");
		if (
			engineId !== undefined &&
			toolName !== undefined &&
			effectiveToolCall(toolName, event.args).toolName === ToolNames.Finish
		) {
			active.heldFinishStarts.set(engineId, event);
			return;
		}
		projectToolStart(event, transport, sessionId, active, cwd, onToolCallLimitReached);
		return;
	}
	if (event.type === "tool_execution_update") {
		sendToolProgress(event, transport, sessionId, active);
		return;
	}
	if (event.type === "tool_execution_end") {
		const toolName = eventString(event, "toolName");
		const engineId = eventString(event, "toolCallId");
		const held = engineId === undefined ? undefined : active.heldFinishStarts.get(engineId);
		if (engineId !== undefined && held !== undefined) {
			active.heldFinishStarts.delete(engineId);
			if (event.protocolRetry === true) return;
			if (!projectToolStart(held, transport, sessionId, active, cwd, onToolCallLimitReached)) return;
		}
		const toolCallId = endToolCallId(active, engineId);
		// This turn put no `tool_call` on the wire, so there is no call an update
		// could name. The event is reported on the stderr tail instead.
		if (toolCallId === null) {
			diagnostics?.("dropped tool_execution_end with no tool call to update");
			return;
		}
		// The client has already been told how this call ended. A second terminal
		// update either resurrects a finished call or overwrites its result with a
		// later one, so the duplicate goes to the stderr tail and not the wire.
		if (active.terminalToolCalls.has(toolCallId)) {
			diagnostics?.(`dropped duplicate terminal update for ${toolCallId}`);
			return;
		}
		active.openToolCalls.delete(toolCallId);
		active.terminalToolCalls.add(toolCallId);
		// Redacted before the bound, which could otherwise cut a password into a piece nothing recognizes (#446).
		const output = boundString(redactUrlCredentials(outputText(event.result)), ACP_MAX_CHUNK_BYTES);
		const content = toolResultContent(output, event.result);
		const started = active.toolCallSnapshots.get(toolCallId);
		sendUpdate(
			transport,
			sessionId,
			active,
			{
				sessionUpdate: "tool_call_update",
				toolCallId,
				title: started?.title ?? boundString(redactUrlCredentials(toolName ?? "tool"), ACP_MAX_TOOL_TITLE_BYTES),
				kind: started?.kind ?? toolKind(toolName),
				status: toolStatus(event),
				...(content.length > 0 ? { content } : {}),
				rawOutput: boundRawRecord({
					result: withoutImageData(event.result),
					isError: toolFailed(event),
					...(toolNotRun(event) !== undefined ? { notRun: toolNotRun(event) } : {}),
				}),
			},
			withToolTiming(toolCallUpdateMeta(active.toolCallSnapshots.get(toolCallId)), event.durationMs),
		);
		return;
	}
	// A steer or follow-up the engine drained into this prompt's run is the operator's own message, sent at its place
	// in the turn as replay sends it. Before the run's first message ends the event is the prompt itself (a scheduled
	// turn's opening), which the client already holds.
	if (event.type === "queued_user_turn") {
		if ((event.kind === "steer" || event.kind === "follow-up") && active.sawTurnEnd && typeof event.text === "string")
			sendSafeChunks(transport, sessionId, active, "user_message_chunk", event.text);
		return;
	}
	if (event.type === "message_start") {
		active.messageAssistantChars = 0;
		active.messageTextBlock = undefined;
		active.sentThinkingChars = 0;
		return;
	}
	if (event.type === "message_end") {
		const message = event.message;
		if (isRecord(message) && message.role === "assistant") {
			const model = safeStoredIdentifier(message.model, ACP_MAX_MODEL_ID_BYTES);
			if (model) active.model = model;
			const accounting = isRecord(message.callAccounting) ? message.callAccounting : undefined;
			const target = safeStoredIdentifier(accounting?.targetId, ACP_MAX_TARGET_ID_BYTES);
			if (target) active.target = target;
			const apiMs = event.modelTimeMs;
			const ttftMs = event.ttftMs;
			const output = isRecord(message.usage) ? message.usage.output : undefined;
			if (typeof ttftMs === "number" && Number.isFinite(ttftMs) && ttftMs >= 0) {
				if (active.ttftMs === undefined) active.ttftMs = ttftMs;
				if (
					typeof apiMs === "number" &&
					Number.isFinite(apiMs) &&
					apiMs > ttftMs &&
					typeof output === "number" &&
					output > 0
				) {
					active.generationMs = (active.generationMs ?? 0) + apiMs - ttftMs;
					active.timedOutputTokens = (active.timedOutputTokens ?? 0) + output;
				}
			}
		}
		active.sawTurnEnd = true;
		noteSettledCalls(active.turn, message);
		applyStopReason(active, message);
		const thinking = assistantThinking(message);
		if (thinking.length > active.sentThinkingChars) {
			const tail = thinking.slice(active.sentThinkingChars);
			active.sentThinkingChars = thinking.length;
			sendSafeChunks(transport, sessionId, active, "agent_thought_chunk", active.thinkingCredentials.push(tail));
		}
		const tail = assistantTextTail(message, active.messageAssistantChars);
		if (tail.length > 0) {
			active.sentAssistantChars += tail.length;
			sendAssistantText(transport, sessionId, active, tail);
		}
		flushChunkCredentials(
			transport,
			sessionId,
			active,
			messageStopCompleted((message as { stopReason?: unknown })?.stopReason),
		);
		if (isRecord(message) && message.role === "assistant") {
			// A runtime that emits no message_start still opens the next message at offset zero.
			active.messageAssistantChars = 0;
			active.messageTextBlock = undefined;
			active.sentThinkingChars = 0;
			if (active.sentAssistantChars > 0) active.textBreakPending = true;
		}
		return;
	}
	if (event.type === "agent_start" || event.type === "agent_end") {
		// A run names the operator turn its calls journal under at both ends; a steer may move it in between (#434 §11.3).
		const turnId = eventString(event, "turnId");
		if (turnId) active.turn.turnIds.add(turnId);
	}
	if (event.type === "agent_end") {
		active.sawTurnEnd = true;
		const messages = Array.isArray(event.messages) ? event.messages : [];
		for (const message of messages) noteSettledCalls(active.turn, message);
		const last = [...messages].reverse().find((message) => isRecord(message) && message.role === "assistant");
		if (last !== undefined) applyStopReason(active, last);
		// ACP has no stop reason for this, so end_turn stands and the client reads why as a notice.
		const ending = classifyTurnEnding(messages as ReadonlyArray<AgentMessage>);
		// The answer of a `call_not_run` turn already streamed and stands; the notice states only the calls it ended on.
		const notice =
			ending?.kind === "no_answer"
				? `The turn ended without an answer. ${turnNoAnswerSentence(ending)}`
				: ending?.kind === "call_not_run"
					? `\n\n${turnCallsNotRunSentence(ending)}`
					: null;
		if (notice !== null) {
			sendUpdate(
				transport,
				sessionId,
				active,
				{ sessionUpdate: "agent_message_chunk", content: textContent(`${notice}\n`) },
				{ ...ORCHESTRATOR_UPDATE_META, [ACP_NOTICE_META_KEY]: { level: "warning" } },
			);
		}
		return;
	}
	// PanCode lifecycle events (agent_start, retry_status, pancode_plan_update) have
	// no ACP v1 SessionUpdate equivalent. The prompt turn is bounded by the
	// session/prompt response, so emitting non-spec `progress` updates would
	// break strict clients. They are intentionally dropped here; a client that
	// opted in to `pancode/readouts` sees retries as `readouts.retry` on the
	// `_pancode/session/readouts` notification instead. The same protocol
	// gap applies to routing advisories (external settings divergence, active
	// target removed): ACP v1 has no agent-initiated advisory channel, so the
	// orchestrator records those as `custom` session-ledger entries
	// (customType "pancode.routing-notice") instead of inventing update kinds.
}
