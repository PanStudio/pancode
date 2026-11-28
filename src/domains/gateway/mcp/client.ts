// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The MCP protocol client: one server, reached over one transport. It settles
 * the protocol era, sends requests with their own timeouts, cancels them,
 * lists and calls tools, follows tasks, and reads every answer into a typed
 * result or a typed McpError. The transport underneath owns the bytes and the
 * peer's lifetime; `createMcpStdioClient` pairs this client with a local
 * server process (stdio-transport.ts), and another transport plugs in through
 * `createMcpProtocolClient`.
 *
 * The client never restarts its transport; a server that dies stays dead
 * until the gateway decides to create a new client, which discovers, lists,
 * and subscribes again from scratch.
 *
 * The client is built from one module per lifetime, all sharing one session:
 * transport and request routing (client-session.ts), session initialization
 * (client-init.ts), elicitation (client-elicitation.ts), tool calls and tasks
 * (client-tools.ts), event streams (client-streams.ts), and the plain reads of
 * resources, prompts, completion and skills (client-reads.ts).
 */

import type { MainSandboxPolicy } from "../../../core/sandbox/main-session.js";
import { clampTimerDelayMs } from "../../../core/timers.js";
import { createMcpElicitation } from "./client-elicitation.js";
import { createMcpInitialization } from "./client-init.js";
import { createMcpReads } from "./client-reads.js";
import { createMcpSession } from "./client-session.js";
import { createMcpStreams } from "./client-streams.js";
import { createMcpToolCalls } from "./client-tools.js";
import type { McpElicitationContext, McpElicitationRequest, McpElicitResult } from "./elicitation.js";
import type {
	McpEventErrorObject,
	McpEventListing,
	McpEventOccurrence,
	McpEventPollResult,
	McpEventRequest,
} from "./events.js";
import type { McpFileConnection, McpFilesSettings, McpUploadRequest } from "./files.js";
import { createMcpHttpTransport, type McpHttpServerSpec } from "./http-transport.js";
import { DEFAULT_MAX_LINE_BYTES, McpError } from "./protocol.js";
import type {
	McpCompletion,
	McpCompletionReference,
	McpPromptListing,
	McpPromptResult,
	McpResourceListing,
	McpResourceRead,
} from "./resources.js";
import type { McpSkillsTransport } from "./skills.js";
import { containedCwd, createMcpStdioTransport, type McpStdioServerSpec } from "./stdio-transport.js";
import type { McpToolCallResult, McpToolDescriptor } from "./tool-results.js";
import type { McpTeardownOutcome, McpTransport, McpTransportEvents } from "./transport.js";

export { MCP_INSTRUCTIONS_BYTES } from "./client-init.js";
export { MCP_CLIENT_NAME } from "./client-session.js";
export { MCP_TOOL_LIST_CAP } from "./client-tools.js";

export {
	DEFAULT_RESULT_TEXT_BYTES,
	type McpContentBlock,
	type McpElicitationOutcome,
	type McpToolCallResult,
	type McpToolDescriptor,
	renderMcpContent,
	resourceLinkLine,
} from "./tool-results.js";
export type { McpTeardownOutcome, McpTransportEvents } from "./transport.js";

export const DEFAULT_STDERR_TAIL_BYTES = 16 * 1024;
export const DEFAULT_KILL_GRACE_MS = 3_000;
/** Bytes accepted for the server's stdin but not yet flushed before the client fails with `overload`. */
export const DEFAULT_MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
/** Smallest outbound cap a caller may configure; initialize alone needs a few hundred bytes. */
const MIN_OUTBOUND_BYTES = 4096;
/** How long a teardown waits for a SIGKILLed group to disappear before it gives up and says so. */
export const DEFAULT_TEARDOWN_BOUND_MS = 2_000;

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/**
 * Puts one server elicitation in front of the operator and returns their
 * answer. The context's signal fires when the call that asked is aborted, the
 * server withdraws the request, or the client closes.
 */
export type McpElicitationHandler = (
	request: McpElicitationRequest,
	context: McpElicitationContext,
) => Promise<McpElicitResult>;

export interface McpClientOptions {
	/** Containment root for the server's cwd; a cwd outside it, by path or by symlink, is refused before spawn. */
	workspaceRoot: string;
	/** Version reported in clientInfo; defaults to the installed PanCode version. */
	clientVersion?: string;
	initializeTimeoutMs?: number;
	requestTimeoutMs?: number;
	stderrTailBytes?: number;
	maxLineBytes?: number;
	/** Cap on the plain-text rendering of one tool result. */
	maxResultTextBytes?: number;
	/** Cap on bytes queued for a server that is not reading its stdin; crossing it fails the client. */
	maxOutboundBytes?: number;
	/** Time allowed for the server to answer ping after a cancellation notification. */
	cancelGraceMs?: number;
	/** Delay between SIGTERM and SIGKILL on close. */
	killGraceMs?: number;
	/** Wait for the group to disappear after SIGKILL before the teardown is reported incomplete. */
	teardownBoundMs?: number;
	/** Notify the connection owner of the first transport failure, including an idle server exit. */
	onFailure?: (error: McpError) => void;
	/** Aborting this signal closes the client. */
	signal?: AbortSignal;
	/** The worker attested the operator's network grant for this server, so its sandboxed process gets network. */
	sandboxNetwork?: boolean;
	/** The operator confined this orchestrator server (`safety.confine`); its stdio process runs under this policy. */
	hostSandbox?: MainSandboxPolicy;
	/**
	 * Answers the server's elicitations. Only its presence declares the
	 * `elicitation` capability; without it the client declares none, so a
	 * session nobody attends is never asked.
	 */
	elicitation?: McpElicitationHandler;
	/** The fetch a remote server is reached with; tests replace it. */
	fetch?: typeof fetch;
	/**
	 * PanCode may move file bytes out of band for this server's calls, so it
	 * declares `upload` and `download` of the files extension; otherwise it
	 * declares the extension inline only.
	 */
	fileTransfers?: boolean;
}

/** The options that belong to the protocol, whatever transport carries it. */
export type McpProtocolClientOptions = Pick<
	McpClientOptions,
	| "clientVersion"
	| "initializeTimeoutMs"
	| "requestTimeoutMs"
	| "maxResultTextBytes"
	| "cancelGraceMs"
	| "onFailure"
	| "signal"
	| "elicitation"
	| "fileTransfers"
>;

export type McpClientStatus = "idle" | "starting" | "ready" | "closed" | "failed";

export type McpClientState = ({ status: Exclude<McpClientStatus, "failed"> } | { status: "failed"; reason: string }) & {
	/** Group members were still present when the post-SIGKILL bound passed; the client stopped waiting for them. */
	cleanupIncomplete: boolean;
	/** The teardown's outcome, null until one has run. Kept alongside an earlier fatal error, never in place of it. */
	teardown: McpTeardownOutcome | null;
};

export interface McpServerInfo {
	/** The negotiated legacy revision, or the modern revision when the `server/discover` probe selected it. */
	protocolVersion: string;
	/** Display only; a modern result's `_meta` refreshes it, and nothing trusts it. */
	serverInfo: { name: string; version: string } | null;
	capabilities: Record<string, unknown>;
	/** Server-written guidance, cut at MCP_INSTRUCTIONS_BYTES. */
	instructions: string | null;
	/** The discover result's freshness hint, modern era only; absent or negative reads as 0. */
	ttlMs?: number;
}

export interface McpToolListing {
	tools: McpToolDescriptor[];
	/** True when the server offered more tools than the cap admits. */
	truncated: boolean;
	/** Modern era: the shortest freshness hint of the discover result and every page; absent or negative reads as 0. */
	ttlMs?: number;
	/** Tools left out because their `x-mcp-header` annotations break the Streamable HTTP rules, with why. */
	dropped?: Array<{ name: string; reason: string }>;
}

export interface McpProgressUpdate {
	/** Increases with every update the caller receives. */
	progress: number;
	total?: number;
	/** Server-written, bounded to one line and unable to open a host frame. */
	message?: string;
}

export interface McpCallToolOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Receives the server's `notifications/progress` for this call, in increasing order, until it settles. */
	onProgress?: (update: McpProgressUpdate) => void;
	/**
	 * Called after a `-32020 HeaderMismatch` re-list before retrying `tools/call`.
	 * Returning a non-null refusal message aborts the retry without sending the
	 * second call (used by the gateway to preserve surface-approval boundaries).
	 */
	onHeaderMismatchRelist?: (listing: McpToolListing) => string | null;
	/** The files this call sends under the files extension. */
	files?: McpCallFiles;
}

/** What a call that sends files gives the client to answer `upload_required`. */
export interface McpCallFiles {
	/** The ids of the non-empty files the call sent without `data`. */
	pending: ReadonlySet<string>;
	/**
	 * Send each file to its target. Resolves with null once every target
	 * answered 2xx, or with why the transfer stopped; it never rejects.
	 */
	upload(
		request: McpUploadRequest,
		connection: McpFileConnection,
		signal: AbortSignal | undefined,
	): Promise<string | null>;
}

/** What one `subscriptions/listen` stream asks for (MCP 2026-07-28 basic/patterns/subscriptions). */
export interface McpSubscriptionFilter {
	toolsListChanged?: true;
	promptsListChanged?: true;
	resourcesListChanged?: true;
	resourceSubscriptions?: string[];
	/** MCP Events: `notifications/events/list_changed`, asked for only of a server whose events settings say listChanged. */
	eventsListChanged?: true;
}

export interface McpSubscription {
	/** The listen request's id, which tags every notification of the stream; null when it was never sent. */
	readonly id: number | null;
	/** The subset of the filter the server honours, from `notifications/subscriptions/acknowledged`. */
	readonly acknowledged: Promise<Record<string, unknown>>;
	/** Settles when the stream ends: the server answered the listen request, the client closed, or cancel(). */
	readonly ended: Promise<void>;
	/** Stop the stream with `notifications/cancelled`. */
	cancel(): void;
}

/** What one `events/stream` subscription reports while it is open (MCP Events, push delivery on stdio). */
export interface McpEventStreamHandlers {
	/** `notifications/events/active`: first, and again mid-stream when a gap opens (`truncated`). */
	onActive(cursor: string | null, truncated: boolean): void;
	onEvent(occurrence: McpEventOccurrence): void;
	/** `notifications/events/heartbeat`: the cursor advances through quiet periods. */
	onHeartbeat(cursor: string | null): void;
	/** `notifications/events/error`: one event failed; the stream stays open. */
	onError(error: McpEventErrorObject): void;
}

export interface McpEventStreamOptions {
	/** Requested heartbeat interval the server may honour. */
	heartbeatMs?: number;
	/**
	 * End the stream with a timeout when nothing arrives for this long. Off by
	 * default: on stdio a dead stream is a dead server, which EOF reports.
	 * A transport whose stream can stall silently (Streamable HTTP) sets it to
	 * three heartbeat intervals.
	 */
	silenceMs?: number;
}

export interface McpEventStream {
	/** The stream request's id, which tags every notification of the stream; null until it is sent. */
	readonly id: number | null;
	/**
	 * Settles when the stream ends: null when the server completed it or cancel()
	 * ended it, the error otherwise (an error answer, a terminated notification,
	 * a server cancel, a closed client, a protocol violation, silence).
	 */
	readonly ended: Promise<McpError | null>;
	/** Stop the stream with `notifications/cancelled`. */
	cancel(): void;
}

export interface McpClient {
	readonly id: string;
	readonly pid: number | undefined;
	initialize(signal?: AbortSignal): Promise<McpServerInfo>;
	listTools(signal?: AbortSignal): Promise<McpToolListing>;
	callTool(name: string, args: Record<string, unknown>, options?: McpCallToolOptions): Promise<McpToolCallResult>;
	/** `resources/list` and `resources/templates/list`, paged, sharing MCP_RESOURCE_LIST_CAP. */
	listResources(signal?: AbortSignal): Promise<McpResourceListing>;
	/**
	 * `resources/read` for one uri. `extensions` names the client extensions
	 * this one read declares in its envelope (modern era); a plain read declares none.
	 */
	readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceRead>;
	listPrompts(signal?: AbortSignal): Promise<McpPromptListing>;
	getPrompt(name: string, args: Record<string, string>, options?: McpRequestOptions): Promise<McpPromptResult>;
	/** `completion/complete`; `context` carries the arguments already chosen. */
	complete(
		ref: McpCompletionReference,
		argument: { name: string; value: string },
		context?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<McpCompletion>;
	/** Resolves with the teardown outcome; an incomplete teardown is flagged there and in state(), not thrown. */
	close(): Promise<McpTeardownOutcome>;
	/** Synchronous exit backstop. Signals only a currently owned group; use close() for awaited teardown. */
	killOwnedOnExit(): void;
	state(): McpClientState;
	serverInfo(): McpServerInfo | null;
	/** Set by `notifications/tools/list_changed`, legacy or on a listen stream; cleared by acknowledgeToolsChanged. */
	toolsChanged(): boolean;
	acknowledgeToolsChanged(): void;
	/** Set by a prompts or resources list_changed, legacy or on the listen stream; cleared by acknowledgeListChanged. */
	listChanged(primitive: McpListedPrimitive): boolean;
	acknowledgeListChanged(primitive: McpListedPrimitive): void;
	/** Called on each prompts or resources list_changed, in either era. Returns the unregister. */
	onListChanged(handler: (primitive: McpListedPrimitive) => void): () => void;
	notificationCount(): number;
	/**
	 * Receive every notification of one method that no listen stream claims,
	 * such as a legacy server's untagged list_changed. Returns the unregister.
	 */
	onNotification(method: string, handler: (params: unknown) => void): () => void;
	/** Open a `subscriptions/listen` stream; its notifications reach `handler` after the server acknowledges it. */
	subscribe(filter: McpSubscriptionFilter, handler: (method: string, params: unknown) => void): McpSubscription;
	/** Bounded tail of everything the server wrote to stderr. */
	stderrTail(): string;
	/** The server's MCP Events settings, or null when it is legacy or does not advertise the extension. */
	eventsOffered(): { listChanged: boolean } | null;
	/** `events/list`, every page up to MCP_EVENT_LIST_CAP; refused toward a server that does not offer events. */
	listEvents(signal?: AbortSignal): Promise<McpEventListing>;
	/** One `events/poll`; a gap is `truncated` in the result, never an error. */
	pollEvents(request: McpEventRequest & { maxEvents?: number }, signal?: AbortSignal): Promise<McpEventPollResult>;
	/** Open one `events/stream` (push); it has no request timeout and lives until it ends or cancel(). */
	streamEvents(
		request: McpEventRequest,
		handlers: McpEventStreamHandlers,
		options?: McpEventStreamOptions,
	): McpEventStream;
	/** Set by `notifications/events/list_changed` on the listen stream; cleared by acknowledgeEventsChanged. */
	eventsChanged(): boolean;
	acknowledgeEventsChanged(): void;
	/**
	 * The `io.modelcontextprotocol/skills` requests toward this server, or null
	 * before discovery and when its capabilities do not enable the extension.
	 */
	skills(): McpSkillsTransport | null;
	/** The server's files extension settings, or null when it is legacy or does not advertise the extension. */
	filesOffered(): McpFilesSettings | null;
	/** The connection a file target of this server resolves against. */
	fileConnection(): McpFileConnection;
}

export type McpListedPrimitive = "prompts" | "resources";

export interface McpRequestOptions {
	signal?: AbortSignal;
	/** Client extensions declared on this one request (modern era), such as a skills read. */
	extensions?: Record<string, unknown>;
}

/** The client for a declaration: Streamable HTTP when it names a url, stdio otherwise. */
export function createMcpClient(spec: McpServerSpec, options: McpClientOptions): McpClient {
	return "url" in spec ? createMcpHttpClient(spec, options) : createMcpStdioClient(spec, options);
}

export function createMcpHttpClient(spec: McpHttpServerSpec, options: McpClientOptions): McpClient {
	return createMcpProtocolClient(
		spec.id,
		(events) =>
			createMcpHttpTransport(
				spec,
				{
					maxMessageBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
					maxOutboundBytes: Math.max(MIN_OUTBOUND_BYTES, options.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES),
					teardownBoundMs: clampTimerDelayMs(options.teardownBoundMs ?? DEFAULT_TEARDOWN_BOUND_MS),
					...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
				},
				events,
			),
		options,
	);
}

export function createMcpStdioClient(spec: McpStdioServerSpec, options: McpClientOptions): McpClient {
	const initialCwd = containedCwd(spec, options.workspaceRoot);
	if (initialCwd instanceof Error) throw new McpError("spawn", `mcp server ${spec.id}: ${initialCwd.message}`);
	return createMcpProtocolClient(
		spec.id,
		(events) =>
			createMcpStdioTransport(
				spec,
				{
					workspaceRoot: options.workspaceRoot,
					stderrTailBytes: Math.max(0, options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES),
					maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
					maxOutboundBytes: Math.max(MIN_OUTBOUND_BYTES, options.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES),
					killGraceMs: clampTimerDelayMs(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS),
					teardownBoundMs: clampTimerDelayMs(options.teardownBoundMs ?? DEFAULT_TEARDOWN_BOUND_MS),
					sandboxNetwork: options.sandboxNetwork === true,
					...(options.hostSandbox !== undefined ? { hostSandbox: options.hostSandbox } : {}),
				},
				events,
			),
		options,
	);
}

/**
 * The protocol client over any transport. `openTransport` is called once, at
 * creation, with the events the transport reports; nothing is sent until the
 * first initialize starts it.
 */
export function createMcpProtocolClient(
	id: string,
	openTransport: (events: McpTransportEvents) => McpTransport,
	options: McpProtocolClientOptions,
): McpClient {
	const session = createMcpSession(id, openTransport, options, {
		serverElicitation: (requestId, params) => {
			void elicitation.answerServerElicitation(requestId, params);
		},
	});
	const elicitation = createMcpElicitation(session);
	const streams = createMcpStreams(session, () => initialization.ensureReady);
	const initialization = createMcpInitialization(session, streams.subscribe);
	const tools = createMcpToolCalls(session, initialization, elicitation);
	const reads = createMcpReads(session, initialization, elicitation);
	const { transport, primitivesChanged, listChangedHandlers } = session;

	return {
		id,
		get pid() {
			return transport.pid;
		},
		initialize: initialization.initialize,
		listTools: tools.listTools,
		callTool: tools.callTool,
		listResources: reads.listResources,
		readResource: reads.readResource,
		listPrompts: reads.listPrompts,
		getPrompt: reads.getPrompt,
		complete: reads.complete,
		close: session.close,
		killOwnedOnExit: () => transport.killOwnedOnExit(),
		state: () => {
			const teardown = transport.teardown();
			const cleanup = { cleanupIncomplete: teardown?.complete === false, teardown };
			return session.status === "failed"
				? { status: session.status, reason: session.failure?.message ?? `mcp server ${id} failed`, ...cleanup }
				: { status: session.status, ...cleanup };
		},
		serverInfo: () => session.info,
		toolsChanged: () => session.toolsChangedFlag,
		acknowledgeToolsChanged: () => {
			session.toolsChangedFlag = false;
		},
		listChanged: (primitive) => primitivesChanged.has(primitive),
		acknowledgeListChanged: (primitive) => {
			primitivesChanged.delete(primitive);
		},
		notificationCount: () => session.notifications,
		onNotification: session.onNotification,
		onListChanged: (handler) => {
			listChangedHandlers.add(handler);
			return () => {
				listChangedHandlers.delete(handler);
			};
		},
		subscribe: streams.subscribe,
		stderrTail: () => transport.stderrTail(),
		eventsOffered: session.eventsOffered,
		filesOffered: session.filesOffered,
		fileConnection: session.fileConnection,
		listEvents: streams.listEvents,
		pollEvents: streams.pollEvents,
		streamEvents: streams.streamEvents,
		eventsChanged: () => session.eventsChangedFlag,
		acknowledgeEventsChanged: () => {
			session.eventsChangedFlag = false;
		},
		skills: reads.skills,
	};
}
