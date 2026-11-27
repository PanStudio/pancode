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
 */

import { performance } from "node:perf_hooks";
import { boundedExternalDiagnostic } from "../../../core/external-diagnostic.js";
import { readPancodeVersion } from "../../../core/package-root.js";
import { neutralizeFraming } from "../../../core/reminder-framing.js";
import { clampTimerDelayMs, sleep } from "../../../core/timers.js";
import { isRecord } from "../../../core/type-guards.js";
import {
	MCP_EVENT_LIST_CAP,
	MCP_EVENT_LIST_PAGE_CAP,
	type McpEventErrorObject,
	type McpEventListing,
	type McpEventOccurrence,
	type McpEventPollResult,
	type McpEventRequest,
	mcpEventErrorObject,
	mcpEventsOffered,
	parseEventCursor,
	parseEventDescriptor,
	parseEventOccurrence,
	parseEventPollResult,
} from "./events.js";
import { mcpParamHeaders } from "./http-headers.js";
import { createMcpHttpTransport, type McpHttpServerSpec } from "./http-transport.js";
import type { JsonRpcErrorObject, JsonRpcId, JsonRpcMessage } from "./protocol.js";
import {
	DEFAULT_MAX_LINE_BYTES,
	JSON_RPC_METHOD_NOT_FOUND,
	MCP_EVENTS_EXTENSION,
	MCP_HEADER_MISMATCH,
	MCP_META_CLIENT_CAPABILITIES,
	MCP_META_CLIENT_INFO,
	MCP_META_PROTOCOL_VERSION,
	MCP_META_SERVER_INFO,
	MCP_META_SUBSCRIPTION_ID,
	MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_OLDEST_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_TASKS_EXTENSION,
	MCP_UNSUPPORTED_PROTOCOL_VERSION,
	McpError,
} from "./protocol.js";
import { MCP_SKILLS_EXTENSION, type McpSkillsTransport, mcpSkillsSettings } from "./skills.js";
import { containedCwd, createMcpStdioTransport, type McpStdioServerSpec } from "./stdio-transport.js";
import {
	cutUtf8,
	DEFAULT_RESULT_TEXT_BYTES,
	type McpToolCallResult,
	type McpToolDescriptor,
	outputSchemaMismatch,
	parseToolCallResult,
	parseToolDescriptor,
} from "./tool-results.js";
import type {
	McpOutboundMessage,
	McpParamHeader,
	McpSendOptions,
	McpSendOutcome,
	McpTeardownOutcome,
	McpTransport,
	McpTransportEvents,
} from "./transport.js";

export {
	DEFAULT_RESULT_TEXT_BYTES,
	type McpContentBlock,
	type McpToolCallResult,
	type McpToolDescriptor,
	renderMcpContent,
} from "./tool-results.js";
export type { McpTeardownOutcome, McpTransport, McpTransportEvents } from "./transport.js";

export const MCP_CLIENT_NAME = "pancode";
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_STDERR_TAIL_BYTES = 16 * 1024;
export const DEFAULT_KILL_GRACE_MS = 3_000;
/** Bound for checking server responsiveness after cancelling an in-flight call. */
export const DEFAULT_CANCEL_GRACE_MS = 1_000;
/** Bytes accepted for the server's stdin but not yet flushed before the client fails with `overload`. */
export const DEFAULT_MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;
/** Tools accepted from one server before pagination stops. */
export const MCP_TOOL_LIST_CAP = 500;
/** Pages followed before a cursor that never ends is abandoned. */
const MCP_TOOL_LIST_PAGE_CAP = 100;
/** Smallest outbound cap a caller may configure; initialize alone needs a few hundred bytes. */
const MIN_OUTBOUND_BYTES = 4096;
/** How long a teardown waits for a SIGKILLed group to disappear before it gives up and says so. */
export const DEFAULT_TEARDOWN_BOUND_MS = 2_000;
/** Poll interval for a task whose server suggests none. */
export const DEFAULT_TASK_POLL_INTERVAL_MS = 1_000;
/** Bounds on a server-suggested poll interval: a zero cannot spin the server, a huge one cannot stall the call. */
export const MIN_TASK_POLL_INTERVAL_MS = 250;
export const MAX_TASK_POLL_INTERVAL_MS = 30_000;
/** Silence on the server/discover probe after which the legacy handshake is sent beside it. */
const DISCOVER_PROBE_GRACE_MS = 1_000;
/** Bytes of one server-written text (an error message, its detail, a task status message) an error carries. */
const SERVER_TEXT_BYTES = 2048;
/** Bytes of a server's instructions PanCode keeps and shows. */
export const MCP_INSTRUCTIONS_BYTES = 2048;
/** Bytes of one progress message passed on to the caller. */
const PROGRESS_MESSAGE_BYTES = 512;
/** Retries of one request that the server keeps answering with input_required and only a requestState. */
export const MCP_INPUT_REQUIRED_ROUNDS = 8;

export type { McpHttpServerSpec } from "./http-transport.js";
export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

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
	/** The fetch a remote server is reached with; tests replace it. */
	fetch?: typeof fetch;
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
	/** Resolves with the teardown outcome; an incomplete teardown is flagged there and in state(), not thrown. */
	close(): Promise<McpTeardownOutcome>;
	/** Synchronous exit backstop. Signals only a currently owned group; use close() for awaited teardown. */
	killOwnedOnExit(): void;
	state(): McpClientState;
	serverInfo(): McpServerInfo | null;
	/** Set by `notifications/tools/list_changed`, legacy or on a listen stream; cleared by acknowledgeToolsChanged. */
	toolsChanged(): boolean;
	acknowledgeToolsChanged(): void;
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
}

interface PendingRequest {
	method: string;
	sent: boolean;
	resolve(value: unknown): void;
	reject(error: McpError): void;
	abandon(): void;
}

interface ActiveSubscription {
	acknowledged: boolean;
	acknowledge(honored: Record<string, unknown>): void;
	handler: (method: string, params: unknown) => void;
}

interface ActiveEventStream {
	handlers: McpEventStreamHandlers;
	/** Any notification of the stream re-arms its silence watchdog. */
	touch(): void;
	/** End the stream from this side with a cause; `cancel` also sends notifications/cancelled. */
	end(error: McpError, cancel: boolean): void;
}

interface ProgressRoute {
	last: number;
	onProgress: (update: McpProgressUpdate) => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Text a server wrote, redacted and clipped before it enters an error the model and the operator read. */
function serverText(text: string): string {
	return boundedExternalDiagnostic(text, SERVER_TEXT_BYTES);
}

function boundedInstructions(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const marker = `\n[instructions truncated at ${MCP_INSTRUCTIONS_BYTES} bytes]`;
	return Buffer.byteLength(value, "utf8") <= MCP_INSTRUCTIONS_BYTES
		? value
		: `${cutUtf8(value, MCP_INSTRUCTIONS_BYTES - Buffer.byteLength(marker, "utf8"))}${marker}`;
}

/** A freshness hint as the caching rules read it: a missing, negative or malformed value is 0. */
function freshnessOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function serverIdentity(value: unknown): McpServerInfo["serverInfo"] {
	if (!isRecord(value)) return null;
	return {
		name: typeof value.name === "string" ? value.name : "",
		version: typeof value.version === "string" ? value.version : "",
	};
}

function parseServerInfo(value: unknown, id: string): McpServerInfo | McpError {
	if (!isRecord(value)) return new McpError("protocol", "initialize result is not an object");
	if (typeof value.protocolVersion !== "string" || value.protocolVersion.length === 0) {
		return new McpError("protocol", "initialize result lacks a protocolVersion string");
	}
	const version = value.protocolVersion;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(version) || version < MCP_OLDEST_PROTOCOL_VERSION || version > MCP_PROTOCOL_VERSION) {
		return new McpError(
			"protocol",
			`mcp server ${id} answered protocolVersion ${serverText(JSON.stringify(version))}; PanCode speaks ${MCP_OLDEST_PROTOCOL_VERSION} through ${MCP_PROTOCOL_VERSION} in the initialize handshake, or ${MCP_MODERN_PROTOCOL_VERSION} through server/discover`,
		);
	}
	return {
		protocolVersion: version,
		serverInfo: serverIdentity(value.serverInfo),
		capabilities: isRecord(value.capabilities) ? value.capabilities : {},
		instructions: boundedInstructions(value.instructions),
	};
}

/**
 * Read a `server/discover` result. Null sends the client down the handshake
 * path: the answer is not a DiscoverResult (a lenient legacy server answering
 * an unknown method), or it lists no modern revision PanCode speaks.
 */
function parseDiscoverResult(value: unknown): McpServerInfo | null {
	if (!isRecord(value) || !Array.isArray(value.supportedVersions)) return null;
	if (!value.supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION)) return null;
	const meta = isRecord(value._meta) ? value._meta : {};
	return {
		protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
		serverInfo: serverIdentity(meta[MCP_META_SERVER_INFO]),
		capabilities: isRecord(value.capabilities) ? value.capabilities : {},
		instructions: boundedInstructions(value.instructions),
		ttlMs: freshnessOf(value.ttlMs),
	};
}

type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/** One observed state of an MCP Tasks task: a CreateTaskResult or a tasks/get result. */
interface McpTaskState {
	taskId: string;
	status: McpTaskStatus;
	statusMessage: string | null;
	ttlMs: number | null;
	pollIntervalMs: number | null;
	result: unknown;
	error: unknown;
}

const TASK_STATUSES: ReadonlySet<string> = new Set(["working", "input_required", "completed", "failed", "cancelled"]);

function parseTaskState(value: unknown, method: string, expectedId: string | null): McpTaskState | McpError {
	if (!isRecord(value)) return new McpError("protocol", `${method} result is not an object`);
	if (typeof value.taskId !== "string" || value.taskId.length === 0) {
		return new McpError("protocol", `${method} result lacks a taskId`);
	}
	if (expectedId !== null && value.taskId !== expectedId) {
		return new McpError("protocol", `${method} answered for task ${value.taskId}, not ${expectedId}`);
	}
	if (typeof value.status !== "string" || !TASK_STATUSES.has(value.status)) {
		return new McpError("protocol", `${method} result has an unknown task status ${JSON.stringify(value.status)}`);
	}
	const finite = (field: unknown): number | null =>
		typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : null;
	return {
		taskId: value.taskId,
		status: value.status as McpTaskStatus,
		statusMessage: typeof value.statusMessage === "string" ? serverText(value.statusMessage) : null,
		ttlMs: finite(value.ttlMs),
		pollIntervalMs: finite(value.pollIntervalMs),
		result: value.result,
		error: value.error,
	};
}

/**
 * The client capabilities a -32021 MissingRequiredClientCapability answer
 * names in `data.requiredCapabilities`: `sampling`, `roots`, `elicitation`, or
 * `extension <id>` for each extension. Empty when the server named none.
 */
export function mcpRequiredCapabilities(data: unknown): string[] {
	const required = isRecord(data) && isRecord(data.requiredCapabilities) ? data.requiredCapabilities : null;
	if (required === null) return [];
	const names: string[] = [];
	for (const [key, value] of Object.entries(required)) {
		if (key === "extensions" && isRecord(value)) names.push(...Object.keys(value).map((id) => `extension ${id}`));
		else names.push(key);
	}
	return names.map((name) => serverText(name));
}

/** What PanCode can say about each capability a server required and the client did not declare. */
function missingCapabilityRemedy(names: ReadonlyArray<string>): string {
	if (names.length === 0) return "the server named no capability, so PanCode cannot tell what it needs";
	return names
		.map((name) =>
			name === `extension ${MCP_TASKS_EXTENSION}`
				? `PanCode declares ${MCP_TASKS_EXTENSION} only on tools/call and tasks/* requests`
				: `PanCode does not offer ${name}`,
		)
		.join("; ");
}

/**
 * A JSON-RPC error answer, for every method. A server explains a refusal in
 * `data.detail` or a string `data` (AutoTLDR names the refused path there), and
 * the bare message alone ("Invalid params") left the model guessing, so the
 * explanation follows the code. The whole error object stays on `data`.
 */
function serverAnswerError(method: string, error: JsonRpcErrorObject): McpError {
	if (error.code === MCP_MISSING_REQUIRED_CLIENT_CAPABILITY) {
		const names = mcpRequiredCapabilities(error.data);
		return new McpError(
			"server",
			`${method}: the server requires client capabilities PanCode did not declare${names.length > 0 ? `: ${names.join(", ")}` : ""} (code ${error.code}); ${missingCapabilityRemedy(names)}`,
			error,
		);
	}
	const { data } = error;
	const detail = typeof data === "string" ? data : isRecord(data) && typeof data.detail === "string" ? data.detail : "";
	const explained = detail.trim().length > 0 ? `: ${serverText(detail)}` : "";
	return new McpError("server", `${method}: ${serverText(error.message)} (code ${error.code})${explained}`, error);
}

/** A JSON-RPC error carried in a task or a reply, worded like a direct error answer to `tools/call`. */
function serverErrorFrom(method: string, error: unknown, fallback: string): McpError {
	if (isRecord(error) && typeof error.code === "number" && typeof error.message === "string") {
		const object: JsonRpcErrorObject = { code: error.code, message: error.message };
		if (error.data !== undefined) object.data = error.data;
		return serverAnswerError(method, object);
	}
	return new McpError("server", `${method}: ${fallback}`);
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
	const initializeTimeoutMs = clampTimerDelayMs(options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
	const requestTimeoutMs = clampTimerDelayMs(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
	const maxResultTextBytes = Math.max(64, options.maxResultTextBytes ?? DEFAULT_RESULT_TEXT_BYTES);
	const clientVersion = options.clientVersion ?? readPancodeVersion();

	let status: McpClientStatus = "idle";
	let failure: McpError | null = null;
	let initializePromise: Promise<McpServerInfo> | null = null;
	let closePromise: Promise<McpTeardownOutcome> | null = null;
	let info: McpServerInfo | null = null;
	/**
	 * Which protocol era the server speaks, settled once by the discovery probe.
	 * Legacy keeps the initialize session and sends every request unchanged;
	 * modern stamps each request with the version, identity and capabilities.
	 */
	let era: "legacy" | "modern" = "legacy";
	let nextId = 1;
	let nextProgressToken = 1;
	const pending = new Map<number, PendingRequest>();
	const subscriptions = new Map<number, ActiveSubscription>();
	const eventStreams = new Map<number, ActiveEventStream>();
	const progressRoutes = new Map<string, ProgressRoute>();
	const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
	/** The outputSchema of each tool in the latest listing, which its structuredContent is checked against. */
	let outputSchemas = new Map<string, Record<string, unknown>>();
	/** The `x-mcp-header` parameters of each tool in the latest listing, mirrored into an HTTP call's headers. */
	let paramHeaders = new Map<string, McpParamHeader[]>();
	let notifications = 0;
	let toolsChangedFlag = false;
	let eventsChangedFlag = false;

	/** The error every later request gets once the client cannot serve it. */
	const closedError = (): McpError => failure ?? new McpError("closed", `mcp server ${id} is closed`);

	const rejectAllPending = (error: McpError): void => {
		for (const entry of [...pending.values()]) entry.reject(error);
	};

	/** Record the first fatal error; later ones never overwrite the cause a caller sees. */
	const fail = (error: McpError): void => {
		if (status === "closed" || status === "failed") return;
		status = "failed";
		options.signal?.removeEventListener("abort", onParentAbort);
		failure = error;
		rejectAllPending(error);
		options.onFailure?.(error);
	};

	const transport = openTransport({
		message: (frame) => {
			if (status === "closed" || status === "failed") return;
			dispatch(frame);
		},
		fatal: (error, ended) => {
			fail(error);
			if (!ended) void close();
		},
	});

	const send = (message: McpOutboundMessage, sendOptions?: McpSendOptions): McpSendOutcome =>
		transport.send(message, sendOptions);

	/** A modern result's `_meta` names the server again; the latest name is the one shown. */
	const refreshServerInfo = (result: unknown): void => {
		if (era !== "modern" || info === null || !isRecord(result) || !isRecord(result._meta)) return;
		const reported = serverIdentity(result._meta[MCP_META_SERVER_INFO]);
		if (reported !== null) info = { ...info, serverInfo: reported };
	};

	/**
	 * -32022 on a request other than the probe means the server stopped
	 * serving the revision this client settled on. Nothing it answers can be
	 * trusted until the era is settled again, which a restart does.
	 */
	const unsupportedVersionError = (method: string, error: JsonRpcErrorObject): McpError => {
		const data = isRecord(error.data) ? error.data : {};
		const supported = Array.isArray(data.supported) ? serverText(data.supported.map(String).join(", ")) : "none listed";
		const requested = typeof data.requested === "string" ? serverText(data.requested) : (info?.protocolVersion ?? "?");
		return new McpError(
			"closed",
			`mcp server ${id} answered ${method} with UnsupportedProtocolVersion (code ${error.code}): it supports ${supported}, and PanCode sent ${requested}; PanCode closed it, and its next start negotiates the revision again`,
			error,
		);
	};

	const routeProgress = (params: unknown): void => {
		if (!isRecord(params)) return;
		const token = params.progressToken;
		if (typeof token !== "string" && typeof token !== "number") return;
		const route = progressRoutes.get(String(token));
		const progress = params.progress;
		if (route === undefined || typeof progress !== "number" || !Number.isFinite(progress) || progress <= route.last) {
			return;
		}
		route.last = progress;
		const update: McpProgressUpdate = { progress };
		if (typeof params.total === "number" && Number.isFinite(params.total)) update.total = params.total;
		if (typeof params.message === "string") {
			const line = neutralizeFraming(
				boundedExternalDiagnostic(params.message.replace(/\s+/g, " "), PROGRESS_MESSAGE_BYTES),
			).trim();
			if (line.length > 0) update.message = line;
		}
		try {
			route.onProgress(update);
		} catch {
			// A caller's display failure never reaches the protocol.
		}
	};

	const routeSubscription = (subscriptionId: unknown, method: string, params: unknown): void => {
		if (typeof subscriptionId !== "number") return;
		const subscription = subscriptions.get(subscriptionId);
		if (subscription === undefined) return;
		if (method === "notifications/subscriptions/acknowledged") {
			if (subscription.acknowledged) return;
			subscription.acknowledged = true;
			subscription.acknowledge(isRecord(params) && isRecord(params.notifications) ? params.notifications : {});
			return;
		}
		// The acknowledgement comes first; anything before it belongs to no stream the client has seen open.
		if (!subscription.acknowledged) return;
		try {
			subscription.handler(method, params);
		} catch {
			// A subscriber's failure never reaches the protocol.
		}
	};

	/** One notification of an `events/stream` subscription (MCP Events, push delivery). */
	const routeEventStream = (streamId: number, method: string, params: unknown): void => {
		const stream = eventStreams.get(streamId);
		if (stream === undefined) return;
		stream.touch();
		const body = isRecord(params) ? params : {};
		try {
			switch (method) {
				case "notifications/events/active": {
					const cursor = parseEventCursor(body.cursor, "notifications/events/active");
					if (cursor instanceof McpError) {
						stream.end(cursor, true);
						return;
					}
					stream.handlers.onActive(cursor, body.truncated === true);
					return;
				}
				case "notifications/events/event": {
					const occurrence = parseEventOccurrence(body, "notifications/events/event");
					if (occurrence instanceof McpError) {
						stream.end(occurrence, true);
						return;
					}
					stream.handlers.onEvent(occurrence);
					return;
				}
				case "notifications/events/heartbeat": {
					const cursor = parseEventCursor(body.cursor, "notifications/events/heartbeat");
					if (cursor instanceof McpError) {
						stream.end(cursor, true);
						return;
					}
					stream.handlers.onHeartbeat(cursor);
					return;
				}
				case "notifications/events/error": {
					const error = mcpEventErrorObject(body.error);
					if (error !== null) stream.handlers.onError(error);
					return;
				}
				case "notifications/events/terminated": {
					const error = mcpEventErrorObject(body.error);
					const answer: JsonRpcErrorObject = error ?? { code: 0, message: "terminated without an error object" };
					const cause = serverAnswerError("events/stream", answer);
					stream.end(new McpError("server", `terminated: ${cause.message}`, answer), false);
					return;
				}
			}
		} catch {
			// A subscriber's failure never reaches the protocol.
		}
	};

	const dispatch = (frame: JsonRpcMessage): void => {
		if (frame.kind === "response") {
			const responseId = frame.message.id;
			if (typeof responseId !== "number") return;
			const entry = pending.get(responseId);
			if (entry === undefined) return;
			const error = frame.message.error;
			if (error !== undefined) {
				if (
					error.code === MCP_UNSUPPORTED_PROTOCOL_VERSION &&
					entry.method !== "server/discover" &&
					entry.method !== "initialize"
				) {
					fail(unsupportedVersionError(entry.method, error));
					void close();
					return;
				}
				entry.reject(serverAnswerError(entry.method, error));
				return;
			}
			refreshServerInfo(frame.message.result);
			entry.resolve(frame.message.result);
			return;
		}
		if (frame.kind === "request") {
			const request = frame.message;
			const outcome = send({
				jsonrpc: "2.0",
				id: request.id as JsonRpcId,
				error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${request.method}` },
			});
			if (outcome.kind === "oversized") {
				fail(
					new McpError(
						"overload",
						`mcp server ${id} sent a request whose ${outcome.bytes}-byte reply exceeds the ${outcome.cap}-byte outbound cap`,
					),
				);
				void close();
			}
			return;
		}
		notifications += 1;
		const { method, params } = frame.message;
		const meta = isRecord(params) && isRecord(params._meta) ? params._meta : null;
		// On stdio, a server terminates a subscriptions/listen stream with
		// notifications/cancelled referencing the listen request's id (2026-07-28 basic/patterns/cancellation).
		if (method === "notifications/cancelled") {
			const targetId =
				isRecord(params) && typeof params.requestId === "number"
					? params.requestId
					: meta !== null && typeof meta[MCP_META_SUBSCRIPTION_ID] === "number"
						? meta[MCP_META_SUBSCRIPTION_ID]
						: null;
			if (targetId !== null && eventStreams.has(targetId)) {
				const reason =
					isRecord(params) && typeof params.reason === "string" && params.reason.trim().length > 0
						? `: ${serverText(params.reason)}`
						: "";
				eventStreams
					.get(targetId)
					?.end(new McpError("server", `mcp server ${id} cancelled event stream ${targetId}${reason}`), false);
				return;
			}
			if (targetId !== null && subscriptions.has(targetId)) {
				const reason =
					isRecord(params) && typeof params.reason === "string" && params.reason.trim().length > 0
						? `: ${serverText(params.reason)}`
						: "";
				subscriptions.delete(targetId);
				pending
					.get(targetId)
					?.reject(new McpError("server", `mcp server ${id} cancelled subscription ${targetId}${reason}`));
				return;
			}
		}
		if (meta !== null && Object.hasOwn(meta, MCP_META_SUBSCRIPTION_ID)) {
			const tagged = meta[MCP_META_SUBSCRIPTION_ID];
			if (typeof tagged === "number" && eventStreams.has(tagged)) {
				routeEventStream(tagged, method, params);
				return;
			}
			routeSubscription(tagged, method, params);
			return;
		}
		if (method === "notifications/tools/list_changed") toolsChangedFlag = true;
		if (method === "notifications/progress") routeProgress(params);
		for (const handler of notificationHandlers.get(method) ?? []) {
			try {
				handler(params);
			} catch {
				// A listener's failure never reaches the protocol.
			}
		}
	};

	/**
	 * The modern per-request envelope. The tasks extension is declared only on
	 * requests whose task this client drives to a terminal state (`tools/call`
	 * and the `tasks/*` methods), so a server never hands a task to a request
	 * that cannot follow it. The skills extension is declared on `skills/*` and
	 * `resources/*` requests to a server whose capabilities enable it. Nothing
	 * is added on the legacy path, where initialize declared the skills
	 * extension once.
	 */
	const tasksRevisionUnknown = (): boolean => {
		const extensions = isRecord(info?.capabilities?.extensions) ? info.capabilities.extensions : null;
		if (extensions === null || !Object.hasOwn(extensions, MCP_TASKS_EXTENSION)) return false;
		const declared = extensions[MCP_TASKS_EXTENSION];
		return !isRecord(declared) || declared.revision !== undefined;
	};

	const withEnvelope = (method: string, params: unknown): unknown => {
		if (era !== "modern" && method !== "server/discover") return params;
		const base = isRecord(params) ? params : {};
		const meta = isRecord(base._meta) ? base._meta : {};
		const extensions: Record<string, Record<string, never>> = {};
		if ((method === "tools/call" || method.startsWith("tasks/")) && !tasksRevisionUnknown()) {
			extensions[MCP_TASKS_EXTENSION] = {};
		}
		if ((method.startsWith("skills/") || method.startsWith("resources/")) && skillsSettings() !== null) {
			extensions[MCP_SKILLS_EXTENSION] = {};
		}
		// MCP Events is declared on events/* and on the listen stream that opts into its list changes.
		if (
			eventsOffered() !== null &&
			(method.startsWith("events/") ||
				(method === "subscriptions/listen" &&
					isRecord(base.notifications) &&
					base.notifications.eventsListChanged === true))
		) {
			extensions[MCP_EVENTS_EXTENSION] = {};
		}
		return {
			...base,
			_meta: {
				...meta,
				[MCP_META_PROTOCOL_VERSION]: MCP_MODERN_PROTOCOL_VERSION,
				[MCP_META_CLIENT_INFO]: { name: MCP_CLIENT_NAME, version: clientVersion },
				[MCP_META_CLIENT_CAPABILITIES]: Object.keys(extensions).length > 0 ? { extensions } : {},
			},
		};
	};

	const request = (
		method: string,
		rawParams: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		onId?: (requestId: number) => void,
	): Promise<unknown> =>
		new Promise<unknown>((resolve, reject) => {
			const params = withEnvelope(method, rawParams);
			if (signal?.aborted) {
				reject(new McpError("aborted", `${method} aborted before it was sent`));
				return;
			}
			if (!transport.started() || status === "closed" || status === "failed") {
				reject(closedError());
				return;
			}
			const ended = transport.endReported();
			if (ended !== null) {
				// The server is gone and its exit error is about to be the failure; that, not a write error, answers.
				void ended.then(() => reject(closedError()));
				return;
			}
			const requestId = nextId++;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const settle = (finish: () => void): void => {
				if (!pending.has(requestId)) return;
				pending.delete(requestId);
				transport.withdraw(requestId);
				if (timer !== null) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				finish();
			};
			let cancelling = false;
			const cancel = (error: McpError): void => {
				const entry = pending.get(requestId);
				if (entry === undefined || cancelling) return;
				cancelling = true;
				if (timer !== null) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (method !== "tools/call" || !entry.sent) {
					settle(() => reject(error));
					return;
				}
				const stop = (): void => {
					settle(() => {
						fail(error);
						void close().then(() => reject(error));
					});
				};
				// Timeouts still terminate work that exceeded its execution bound.
				if (error.code !== "aborted") {
					stop();
					return;
				}
				// Cancellation has no required acknowledgement. A terminal response
				// or a bounded liveness request confirms a usable transport; neither
				// retries the cancelled tool, which may already have produced side
				// effects. The modern revision removed ping, so it asks server/discover.
				entry.resolve = () => settle(() => reject(error));
				entry.reject = () => settle(() => reject(error));
				send({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId, reason: error.message },
				});
				void request(
					era === "modern" ? "server/discover" : "ping",
					undefined,
					Math.max(1, options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS),
				).then(
					() => settle(() => reject(error)),
					() => stop(),
				);
			};
			const onAbort = (): void => cancel(new McpError("aborted", `${method} aborted`));
			pending.set(requestId, {
				method,
				sent: false,
				resolve: (value) => settle(() => resolve(value)),
				reject: (error) => settle(() => reject(error)),
				abandon: () => settle(() => {}),
			});
			onId?.(requestId);
			if (timeoutMs > 0) {
				timer = setTimeout(() => cancel(new McpError("timeout", `${method} timed out after ${timeoutMs}ms`)), timeoutMs);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			const mirrored =
				method === "tools/call" && isRecord(params) && typeof params.name === "string"
					? paramHeaders.get(params.name)
					: undefined;
			const outcome = send(
				{ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) },
				{
					requestId,
					...(mirrored !== undefined ? { paramHeaders: mirrored } : {}),
					onSent: () => {
						const entry = pending.get(requestId);
						if (entry !== undefined) entry.sent = true;
					},
					onError: (error) => {
						settle(() => reject(failure ?? new McpError("closed", `write to mcp server ${id} failed: ${error.message}`)));
					},
				},
			);
			if (outcome.kind === "oversized") {
				settle(() =>
					reject(
						new McpError(
							"overload",
							`${method} request of ${outcome.bytes} bytes exceeds the ${outcome.cap}-byte outbound cap`,
						),
					),
				);
			}
			// An overloaded queue already failed the client, which rejected this request with the cause.
		});

	const withDiscoverySignal = async <T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
		const onAbort = (): void => {
			fail(new McpError("aborted", "MCP discovery aborted"));
			void close();
		};
		if (signal?.aborted) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal?.aborted) throw closedError();
			const result = await run();
			if (signal?.aborted) throw closedError();
			return result;
		} catch (error) {
			if (signal?.aborted) await close();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	const initialize = (signal?: AbortSignal): Promise<McpServerInfo> =>
		withDiscoverySignal(signal, () => initializeOnce(signal));

	/**
	 * The stdio backward-compatibility probe of MCP 2026-07-28 (basic/transports/stdio):
	 * `server/discover` goes first. A DiscoverResult listing the modern revision
	 * makes the server modern. A recognized modern error means a modern server
	 * PanCode cannot speak to, and the spec forbids falling back to initialize then.
	 * Any other error answer, or silence until the initialize timeout, means a
	 * legacy server, and null sends the client down the handshake path.
	 */
	const discoverEra = async (
		signal?: AbortSignal,
		onId?: (requestId: number) => void,
	): Promise<McpServerInfo | null> => {
		let result: unknown;
		try {
			result = await request("server/discover", {}, initializeTimeoutMs, signal, onId);
		} catch (error) {
			const cause = error instanceof McpError ? error : new McpError("protocol", errorMessage(error));
			const answered = cause.code === "server" && isRecord(cause.data) ? cause.data : null;
			if (answered?.code === MCP_UNSUPPORTED_PROTOCOL_VERSION) {
				const data = isRecord(answered.data) ? answered.data : {};
				const supported = Array.isArray(data.supported) ? data.supported.map(String).join(", ") : "none listed";
				fail(
					new McpError(
						"protocol",
						`initialize failed: mcp server ${id} does not support MCP ${MCP_MODERN_PROTOCOL_VERSION} (it supports ${serverText(supported)})`,
						answered,
					),
				);
				await close();
				throw closedError();
			}
			// basic/versioning: these two are modern answers too, so a fallback to initialize is forbidden.
			if (answered?.code === MCP_MISSING_REQUIRED_CLIENT_CAPABILITY || answered?.code === MCP_HEADER_MISMATCH) {
				fail(
					new McpError(
						"protocol",
						`initialize failed: mcp server ${id} speaks MCP ${MCP_MODERN_PROTOCOL_VERSION} but refused server/discover: ${cause.message}`,
						answered,
					),
				);
				await close();
				throw closedError();
			}
			if (answered !== null || cause.code === "timeout") return null;
			fail(new McpError(cause.code, `initialize failed: ${cause.message}`, cause.data));
			await close();
			throw closedError();
		}
		return parseDiscoverResult(result);
	};

	/**
	 * A modern server that announces tools.listChanged is asked for the change
	 * stream at once (MCP 2026-07-28 basic/patterns/subscriptions). The stream
	 * lives as long as this client; a restarted server gets a new client, which
	 * listens again.
	 */
	const listenForToolChanges = (capabilities: Record<string, unknown>): void => {
		const filter: McpSubscriptionFilter = {};
		if (isRecord(capabilities.tools) && capabilities.tools.listChanged === true) filter.toolsListChanged = true;
		if (mcpEventsOffered(capabilities)?.listChanged === true) filter.eventsListChanged = true;
		if (Object.keys(filter).length === 0) return;
		const stream = subscribe(filter, (method) => {
			if (method === "notifications/tools/list_changed") toolsChangedFlag = true;
			if (method === "notifications/events/list_changed") eventsChangedFlag = true;
		});
		stream.acknowledged.catch(() => {
			// A server that refuses or ends the stream still serves calls; the next discovery lists again.
		});
	};

	const initializeOnce = (signal?: AbortSignal): Promise<McpServerInfo> => {
		if (status === "closed" || status === "failed") return Promise.reject(closedError());
		if (initializePromise !== null) return initializePromise;
		initializePromise = (async () => {
			status = "starting";
			const started = await transport.start();
			if (!started) {
				await close();
				throw closedError();
			}
			let probeId: number | null = null;
			let handshakeId: number | null = null;
			const http = transport.http;
			const becomeModern = (discovered: McpServerInfo): McpServerInfo => {
				era = "modern";
				http?.settleEra("modern", MCP_MODERN_PROTOCOL_VERSION);
				info = discovered;
				if (status === "starting") status = "ready";
				listenForToolChanges(discovered.capabilities);
				return discovered;
			};
			const handshake = (): Promise<unknown> =>
				request(
					"initialize",
					{
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { extensions: { [MCP_SKILLS_EXTENSION]: {} } },
						clientInfo: { name: MCP_CLIENT_NAME, version: clientVersion },
					},
					initializeTimeoutMs,
					signal,
					(assigned) => {
						handshakeId = assigned;
					},
				);
			if (http !== undefined) {
				// basic/transports/streamable-http, Backward Compatibility: the modern
				// request is answered before anything else is sent, and only an answer
				// that is not a recognized modern one sends the client to initialize.
				// An origin already found legacy in this process is not probed again.
				const cachedLegacy = http.cachedEra() === "legacy";
				const discovered = cachedLegacy ? null : await discoverEra(signal);
				if (discovered !== null) return becomeModern(discovered);
				let result: unknown;
				try {
					result = await handshake();
				} catch (error) {
					if (cachedLegacy) http.forgetEra();
					const cause = error instanceof McpError ? error : new McpError("protocol", errorMessage(error));
					fail(new McpError(cause.code, `initialize failed: ${cause.message}`, cause.data));
					await close();
					throw closedError();
				}
				const parsed = parseServerInfo(result, id);
				if (parsed instanceof McpError) {
					if (cachedLegacy) http.forgetEra();
					fail(new McpError("protocol", `initialize failed: ${parsed.message}`));
					await close();
					throw closedError();
				}
				info = parsed;
				// Every later POST carries the negotiated revision and the session, the initialized notification included.
				http.settleEra("legacy", parsed.protocolVersion);
				send({ jsonrpc: "2.0", method: "notifications/initialized" });
				if (status === "starting") status = "ready";
				return parsed;
			}
			// Many legacy servers drop an unknown method without answering, and
			// waiting out the whole initialize timeout for each of them would slow
			// every start. After a short grace the handshake goes out beside the
			// pending probe and the first decisive answer picks the era. Servers
			// read stdin in order, so a modern server that is merely slow to start
			// still answers the probe it read first.
			const probe = discoverEra(signal, (assigned) => {
				probeId = assigned;
			});
			probe.catch(() => {
				// Observed through the races below; a fatal probe has already failed the client.
			});
			const grace = new AbortController();
			const early = await Promise.race([
				probe.then((found) => ({ answered: true as const, found })),
				sleep(Math.min(DISCOVER_PROBE_GRACE_MS, initializeTimeoutMs), grace.signal).then(
					() => ({ answered: false as const, found: null }),
					() => ({ answered: false as const, found: null }),
				),
			]);
			grace.abort();
			let pendingHandshake: Promise<unknown> | null = null;
			let discovered = early.found;
			if (!early.answered) {
				const sent = handshake();
				pendingHandshake = sent;
				sent.catch(() => {
					// Awaited below when the server turns out to be legacy.
				});
				discovered = await Promise.race([
					probe,
					sent.then(
						() => null,
						() => probe,
					),
				]);
			}
			if (discovered !== null) {
				if (handshakeId !== null) pending.get(handshakeId)?.abandon();
				return becomeModern(discovered);
			}
			if (probeId !== null) pending.get(probeId)?.abandon();
			let result: unknown;
			try {
				result = await (pendingHandshake ?? handshake());
			} catch (error) {
				const cause = error instanceof McpError ? error : new McpError("protocol", errorMessage(error));
				fail(new McpError(cause.code, `initialize failed: ${cause.message}`, cause.data));
				await close();
				throw closedError();
			}
			const parsed = parseServerInfo(result, id);
			if (parsed instanceof McpError) {
				fail(new McpError("protocol", `initialize failed: ${parsed.message}`));
				await close();
				throw closedError();
			}
			info = parsed;
			send({ jsonrpc: "2.0", method: "notifications/initialized" });
			if (status === "starting") status = "ready";
			return parsed;
		})();
		return initializePromise;
	};

	const ensureReady = async (signal?: AbortSignal): Promise<void> => {
		if (status === "ready") return;
		await initialize(signal);
	};

	const skillsSettings = () => (info === null ? null : mcpSkillsSettings(info.capabilities).settings);

	/** One skills-extension request; a modern answer must be complete, since nothing here follows a task or input round. */
	const skillsRequest = async (
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> => {
		await ensureReady(signal);
		const result = await request(method, params, requestTimeoutMs, signal);
		if (era === "modern" && isRecord(result) && result.resultType !== undefined && result.resultType !== "complete") {
			throw new McpError(
				"protocol",
				`${method} returned resultType ${serverText(JSON.stringify(result.resultType))}, which this client does not handle`,
			);
		}
		return result;
	};

	const skills = (): McpSkillsTransport | null => {
		const settings = skillsSettings();
		if (settings === null) return null;
		return {
			settings,
			listSkills: (cursor, signal) => skillsRequest("skills/list", cursor === undefined ? {} : { cursor }, signal),
			getSkill: (uri, signal) => skillsRequest("skills/get", { uri }, signal),
			readResource: (uri, signal) => skillsRequest("resources/read", { uri }, signal),
			readDirectory: (uri, cursor, signal) =>
				settings.directoryRead
					? skillsRequest("resources/directory/read", cursor === undefined ? { uri } : { uri, cursor }, signal)
					: Promise.reject(new McpError("protocol", `mcp server ${id} did not declare directoryRead`)),
		};
	};

	/**
	 * Over Streamable HTTP in the modern era, a tool whose `x-mcp-header`
	 * annotations break the Schema Extension rules is left out of the listing
	 * (basic/transports/streamable-http, Custom Headers from Tool Parameters).
	 */
	const mirrorsHeaders = (): boolean => transport.http !== undefined && era === "modern";

	const listToolsOnce = async (signal?: AbortSignal): Promise<McpToolListing> => {
		await ensureReady(signal);
		const tools: McpToolDescriptor[] = [];
		const dropped: Array<{ name: string; reason: string }> = [];
		const mirrored = new Map<string, McpParamHeader[]>();
		let cursor: string | undefined;
		let pages = 0;
		// Each page carries its own freshness; the listing is as fresh as its stalest part.
		let ttlMs = era === "modern" ? (info?.ttlMs ?? 0) : undefined;
		const finish = (truncated: boolean): McpToolListing => {
			outputSchemas = new Map(tools.flatMap((tool) => (tool.outputSchema ? [[tool.name, tool.outputSchema]] : [])));
			paramHeaders = mirrored;
			return {
				tools,
				truncated,
				...(ttlMs !== undefined ? { ttlMs } : {}),
				...(dropped.length > 0 ? { dropped } : {}),
			};
		};
		for (;;) {
			pages += 1;
			const result = await request("tools/list", cursor === undefined ? {} : { cursor }, requestTimeoutMs, signal);
			if (!isRecord(result) || !Array.isArray(result.tools)) {
				throw new McpError("protocol", "tools/list result lacks a tools array");
			}
			if (ttlMs !== undefined) ttlMs = Math.min(ttlMs, freshnessOf(result.ttlMs));
			for (const entry of result.tools) {
				if (tools.length >= MCP_TOOL_LIST_CAP) return finish(true);
				const descriptor = parseToolDescriptor(entry);
				if (descriptor instanceof McpError) throw descriptor;
				if (mirrorsHeaders()) {
					const headers = mcpParamHeaders(descriptor.inputSchema);
					if (typeof headers === "string") {
						dropped.push({ name: descriptor.name, reason: serverText(headers) });
						continue;
					}
					if (headers.length > 0) mirrored.set(descriptor.name, headers);
				}
				tools.push(descriptor);
			}
			const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
			if (next === undefined) return finish(false);
			if (tools.length >= MCP_TOOL_LIST_CAP || pages >= MCP_TOOL_LIST_PAGE_CAP) return finish(true);
			cursor = next;
		}
	};

	const listTools = (signal?: AbortSignal): Promise<McpToolListing> =>
		withDiscoverySignal(signal, () => listToolsOnce(signal));

	/** Route this call's progress notifications to its caller while the call runs (basic/utilities/progress). */
	const trackProgress = (onProgress: (update: McpProgressUpdate) => void): { token: string; release(): void } => {
		const token = `pancode-${nextProgressToken++}`;
		progressRoutes.set(token, { last: Number.NEGATIVE_INFINITY, onProgress });
		return { token, release: () => progressRoutes.delete(token) };
	};

	/**
	 * The one place an `input_required` answer (MCP 2026-07-28
	 * basic/patterns/mrtr) is handled; it returns the params of the retry.
	 * PanCode declares no client capability a server could ask for through
	 * `inputRequests`, so a server that asks anyway breaks the protocol, and
	 * a bare `requestState` is echoed back verbatim under a new request id.
	 */
	const answerInputRequired = (
		method: string,
		params: Record<string, unknown>,
		result: Record<string, unknown>,
		round: number,
	): Record<string, unknown> => {
		const asked = isRecord(result.inputRequests) ? Object.values(result.inputRequests) : [];
		if (asked.length > 0) {
			const methods = [
				...new Set(asked.map((entry) => (isRecord(entry) && typeof entry.method === "string" ? entry.method : "?"))),
			];
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required asking for ${serverText(methods.join(", "))}, but PanCode declared no client capabilities, so a server must not ask it for input`,
			);
		}
		if (typeof result.requestState !== "string") {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required carrying neither inputRequests nor a requestState`,
			);
		}
		if (round > MCP_INPUT_REQUIRED_ROUNDS) {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required ${round} times in a row; PanCode stops retrying after ${MCP_INPUT_REQUIRED_ROUNDS}`,
			);
		}
		const { requestState: _previous, ...base } = params;
		return { ...base, requestState: result.requestState };
	};

	/** Read a final tools/call answer and check its structuredContent against the tool's outputSchema. */
	const finishToolResult = async (name: string, value: unknown): Promise<McpToolCallResult> => {
		const parsed = parseToolCallResult(value, maxResultTextBytes);
		if (parsed instanceof McpError) throw parsed;
		const schema = outputSchemas.get(name);
		if (parsed.isError || schema === undefined || parsed.structuredContent === undefined) return parsed;
		const mismatch = await outputSchemaMismatch(schema, parsed.structuredContent, parsed.structuredContentJson);
		if (mismatch === null) return parsed;
		return { ...parsed, isError: true, outputSchemaMismatch: serverText(`mcp server ${id}, tool ${name}: ${mismatch}`) };
	};

	const callTool = async (
		name: string,
		args: Record<string, unknown>,
		callOptions: McpCallToolOptions = {},
	): Promise<McpToolCallResult> => {
		const signal = callOptions.signal;
		if (signal?.aborted) throw new McpError("aborted", "tools/call aborted before it was sent");
		await ensureReady(signal);
		const timeoutMs = clampTimerDelayMs(callOptions.timeoutMs ?? requestTimeoutMs);
		const startedAt = performance.now();
		let params: Record<string, unknown> = { name, arguments: args };
		let relisted = false;
		for (let round = 1; ; round += 1) {
			let budget = timeoutMs;
			if (round > 1 && timeoutMs > 0) {
				budget = Math.ceil(startedAt + timeoutMs - performance.now());
				if (budget <= 0) throw new McpError("timeout", `tools/call timed out after ${timeoutMs}ms`);
			}
			// Each request round gets its own progressToken so a retry under MRTR starts with a fresh counter.
			const progress = callOptions.onProgress === undefined ? null : trackProgress(callOptions.onProgress);
			try {
				const sent = progress === null ? params : { ...params, _meta: { progressToken: progress.token } };
				let result: unknown;
				try {
					result = await request("tools/call", sent, budget, signal);
				} catch (error) {
					// A HeaderMismatch means the listing PanCode mirrored from is stale:
					// list again and send the call once more (streamable-http, Server Behavior).
					const answered = error instanceof McpError && error.code === "server" && isRecord(error.data);
					if (!answered || relisted || !mirrorsHeaders() || error.data.code !== MCP_HEADER_MISMATCH) throw error;
					relisted = true;
					toolsChangedFlag = true;
					const listing = await listToolsOnce(signal);
					if (!listing.tools.some((entry) => entry.name === name)) {
						const dropped = listing.dropped?.find((entry) => entry.name === name);
						throw new McpError(
							"server",
							dropped !== undefined
								? `tools/call (${name}) refused after HeaderMismatch relist: tool dropped (${dropped.reason})`
								: `tools/call (${name}) refused after HeaderMismatch relist: server no longer lists tool ${name}`,
							error.data,
						);
					}
					const refusal = callOptions.onHeaderMismatchRelist?.(listing) ?? null;
					if (refusal !== null) throw new McpError("server", refusal, error.data);
					round -= 1;
					continue;
				}
				if (era === "modern" && isRecord(result) && result.resultType !== undefined && result.resultType !== "complete") {
					if (result.resultType === "task") return await awaitTask(name, result, startedAt, timeoutMs, signal);
					if (result.resultType === "input_required") {
						params = answerInputRequired("tools/call", params, result, round);
						continue;
					}
					throw new McpError(
						"protocol",
						`tools/call returned resultType ${serverText(JSON.stringify(result.resultType))}, which this client does not handle`,
					);
				}
				return await finishToolResult(name, result);
			} finally {
				progress?.release();
			}
		}
	};

	/**
	 * Ask the server to stop a task PanCode is abandoning. The ack is cooperative
	 * and bounded by the cancel grace; a server that cannot even acknowledge
	 * within it is treated like a wedged direct call and the client is closed.
	 */
	const cancelTask = async (taskId: string, cause: McpError): Promise<void> => {
		try {
			await request("tasks/cancel", { taskId }, Math.max(1, options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS));
		} catch (error) {
			// A JSON-RPC error answer (for example a task that already finished) still proves a live transport.
			if (error instanceof McpError && error.code === "server") return;
			fail(cause);
			await close();
		}
	};

	/**
	 * Follow a task the server created for `tools/call` to its terminal state
	 * (MCP Tasks extension, specification 2026-07-28). The whole task is the one
	 * tool call the gateway admitted: polling shares the call's timeout and abort
	 * signal, and the completed task yields the same McpToolCallResult a direct
	 * answer would. Polling waits the server's pollIntervalMs, held between
	 * MIN_TASK_POLL_INTERVAL_MS and MAX_TASK_POLL_INTERVAL_MS, between tasks/get
	 * requests, stops at a terminal status, and sends tasks/cancel when the turn
	 * aborts, the call times out, the task outlives its ttlMs, or the server
	 * asks for input this client cannot give.
	 */
	const awaitTask = async (
		name: string,
		created: Record<string, unknown>,
		startedAt: number,
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<McpToolCallResult> => {
		const first = parseTaskState(created, "tools/call", null);
		if (first instanceof McpError) throw first;
		const taskId = first.taskId;
		const deadline = timeoutMs > 0 ? startedAt + timeoutMs : Number.POSITIVE_INFINITY;
		// The ttl counts from the server's creation; the local receipt time is a
		// conservative stand-in that no clock skew between the two can stretch.
		const expiresAt = first.ttlMs === null ? Number.POSITIVE_INFINITY : performance.now() + first.ttlMs;
		const timedOut = (): McpError => new McpError("timeout", `tools/call timed out after ${timeoutMs}ms`);
		const aborted = (): McpError => new McpError("aborted", "tools/call aborted");
		let task = first;
		try {
			for (;;) {
				switch (task.status) {
					case "completed":
						return await finishToolResult(name, task.result);
					case "failed":
						throw serverErrorFrom(
							"tools/call",
							task.error,
							`task ${taskId} failed${task.statusMessage ? `: ${task.statusMessage}` : ""}`,
						);
					case "cancelled":
						throw new McpError(
							"server",
							`tools/call: task ${taskId} was cancelled by the server${task.statusMessage ? `: ${task.statusMessage}` : ""}`,
						);
					case "input_required":
						await cancelTask(taskId, new McpError("server", `tools/call: task ${taskId} required input`));
						throw new McpError(
							"server",
							`tools/call: task ${taskId} asked for client input (elicitation or sampling), which this client does not provide; the task was cancelled`,
						);
					case "working":
						break;
				}
				const now = performance.now();
				if (now >= expiresAt) {
					const expired = new McpError(
						"server",
						`tools/call: task ${taskId} did not finish within its ${first.ttlMs}ms lifetime`,
					);
					await cancelTask(taskId, expired);
					throw expired;
				}
				const remaining = deadline - now;
				if (remaining <= 0) throw timedOut();
				const interval = Math.min(
					MAX_TASK_POLL_INTERVAL_MS,
					Math.max(MIN_TASK_POLL_INTERVAL_MS, task.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS),
				);
				try {
					await sleep(Math.min(interval, remaining, expiresAt - now), signal);
				} catch {
					throw aborted();
				}
				const left = deadline - performance.now();
				if (left <= 0) throw timedOut();
				let polled: unknown;
				try {
					polled = await request("tasks/get", { taskId }, Number.isFinite(left) ? Math.max(1, Math.ceil(left)) : 0, signal);
				} catch (error) {
					if (error instanceof McpError && error.code === "timeout") throw timedOut();
					if (error instanceof McpError && error.code === "aborted") throw aborted();
					throw error;
				}
				const next = parseTaskState(polled, "tasks/get", taskId);
				if (next instanceof McpError) throw next;
				task = next;
			}
		} catch (error) {
			if (error instanceof McpError && (error.code === "aborted" || error.code === "timeout")) {
				await cancelTask(taskId, error);
			}
			throw error;
		}
	};

	const onNotification = (method: string, handler: (params: unknown) => void): (() => void) => {
		let handlers = notificationHandlers.get(method);
		if (handlers === undefined) {
			handlers = new Set();
			notificationHandlers.set(method, handlers);
		}
		handlers.add(handler);
		return () => {
			notificationHandlers.get(method)?.delete(handler);
		};
	};

	/**
	 * Open one listen stream. The request has no timeout: it is answered only
	 * when the server ends the stream, and close() or cancel() ends it from
	 * this side with `notifications/cancelled`. Over stdio every stream shares
	 * one pipe, so each notification is routed by the subscription id the
	 * server tags it with, which is the listen request's id.
	 */
	const subscribe = (
		filter: McpSubscriptionFilter,
		handler: (method: string, params: unknown) => void,
	): McpSubscription => {
		let streamId: number | null = null;
		let acknowledge: (honored: Record<string, unknown>) => void = () => {};
		let refuse: (error: McpError) => void = () => {};
		const acknowledged = new Promise<Record<string, unknown>>((resolve, reject) => {
			acknowledge = resolve;
			refuse = reject;
		});
		acknowledged.catch(() => {
			// A caller that never awaits the acknowledgement is not told about an ended stream.
		});
		const controller = new AbortController();
		const listening = request("subscriptions/listen", { notifications: filter }, 0, controller.signal, (assigned) => {
			streamId = assigned;
			subscriptions.set(assigned, { acknowledged: false, acknowledge, handler });
		});
		const ended = listening.then(
			() => {
				refuse(new McpError("server", `mcp server ${id} ended the subscription before acknowledging it`));
			},
			(error: unknown) => {
				refuse(error instanceof McpError ? error : new McpError("protocol", errorMessage(error)));
			},
		);
		void ended.finally(() => {
			if (streamId !== null) subscriptions.delete(streamId);
		});
		return {
			get id() {
				return streamId;
			},
			acknowledged,
			ended: ended.then(() => undefined),
			cancel: () => {
				if (streamId === null || !subscriptions.delete(streamId)) return;
				send({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: streamId, reason: "subscription closed by the client" },
				});
				controller.abort();
			},
		};
	};

	const eventsOffered = (): { listChanged: boolean } | null =>
		era === "modern" && info !== null ? mcpEventsOffered(info.capabilities) : null;

	/** The extension's fallback rule: no events/* request goes to a server that did not advertise it. */
	const eventsRefusal = (method: string): McpError | null =>
		eventsOffered() === null
			? new McpError("protocol", `mcp server ${id} does not offer ${MCP_EVENTS_EXTENSION}; PanCode sends it no ${method}`)
			: null;

	/** A modern result PanCode reads only when complete; no events/* method defines another resultType. */
	const completeResult = (method: string, result: unknown): Record<string, unknown> => {
		if (!isRecord(result)) throw new McpError("protocol", `${method} result is not an object`);
		if (result.resultType !== undefined && result.resultType !== "complete") {
			throw new McpError(
				"protocol",
				`${method} returned resultType ${serverText(JSON.stringify(result.resultType))}, which this client does not handle`,
			);
		}
		return result;
	};

	const listEvents = async (signal?: AbortSignal): Promise<McpEventListing> => {
		await ensureReady(signal);
		const refused = eventsRefusal("events/list");
		if (refused !== null) throw refused;
		const events: McpEventListing["events"] = [];
		let cursor: string | undefined;
		for (let pages = 1; ; pages += 1) {
			const result = completeResult(
				"events/list",
				await request("events/list", cursor === undefined ? {} : { cursor }, requestTimeoutMs, signal),
			);
			if (!Array.isArray(result.events)) throw new McpError("protocol", "events/list result lacks an events array");
			for (const entry of result.events) {
				if (events.length >= MCP_EVENT_LIST_CAP) return { events, truncated: true };
				const descriptor = parseEventDescriptor(entry);
				if (descriptor instanceof McpError) throw descriptor;
				if (!events.some((known) => known.name === descriptor.name)) events.push(descriptor);
			}
			const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
			if (next === undefined) return { events, truncated: false };
			if (pages >= MCP_EVENT_LIST_PAGE_CAP) return { events, truncated: true };
			cursor = next;
		}
	};

	const eventParams = (req: McpEventRequest): Record<string, unknown> => ({
		name: req.name,
		arguments: req.arguments,
		cursor: req.cursor,
		// maxAgeMs bounds replay from a stored cursor; with a null cursor there is nothing to bound.
		...(req.cursor !== null && req.maxAgeMs !== undefined ? { maxAgeMs: req.maxAgeMs } : {}),
	});

	const pollEvents = async (
		req: McpEventRequest & { maxEvents?: number },
		signal?: AbortSignal,
	): Promise<McpEventPollResult> => {
		await ensureReady(signal);
		const refused = eventsRefusal("events/poll");
		if (refused !== null) throw refused;
		const params = { ...eventParams(req), ...(req.maxEvents !== undefined ? { maxEvents: req.maxEvents } : {}) };
		const result = completeResult("events/poll", await request("events/poll", params, requestTimeoutMs, signal));
		const parsed = parseEventPollResult(result);
		if (parsed instanceof McpError) throw parsed;
		return parsed;
	};

	/**
	 * Open one push subscription. Over stdio every notification of the stream
	 * carries the stream request's id as its subscription id. The request has
	 * no timeout: the server answers it only when the stream ends, and cancel()
	 * ends it from this side with `notifications/cancelled`.
	 */
	const streamEvents = (
		req: McpEventRequest,
		handlers: McpEventStreamHandlers,
		streamOptions: McpEventStreamOptions = {},
	): McpEventStream => {
		let streamId: number | null = null;
		let cancelled = false;
		let watchdog: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		let endCause: McpError | null = null;
		const silenceMs = streamOptions.silenceMs !== undefined ? clampTimerDelayMs(streamOptions.silenceMs) : 0;
		const sendCancel = (requestId: number, reason: string): void => {
			if (transport.endReported() !== null) return;
			send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason } });
		};
		const end = (error: McpError, cancel: boolean): void => {
			if (streamId === null || !eventStreams.delete(streamId)) return;
			if (watchdog !== null) clearTimeout(watchdog);
			endCause = error;
			if (cancel) sendCancel(streamId, error.message);
			pending.get(streamId)?.reject(error);
		};
		const touch = (): void => {
			if (silenceMs <= 0) return;
			if (watchdog !== null) clearTimeout(watchdog);
			watchdog = setTimeout(
				() => end(new McpError("timeout", `events/stream went silent for ${silenceMs}ms`), true),
				silenceMs,
			);
			watchdog.unref?.();
		};
		const ended = (async (): Promise<McpError | null> => {
			await ensureReady(controller.signal);
			const refused = eventsRefusal("events/stream");
			if (refused !== null) throw refused;
			const params = {
				...eventParams(req),
				...(streamOptions.heartbeatMs !== undefined ? { heartbeatMs: streamOptions.heartbeatMs } : {}),
			};
			const result = await request("events/stream", params, 0, controller.signal, (assigned) => {
				streamId = assigned;
				eventStreams.set(assigned, { handlers, touch, end });
				touch();
			});
			completeResult("events/stream", result);
			return null;
		})().then(
			(value) => value,
			(error: unknown) => {
				if (cancelled) return null;
				return endCause ?? (error instanceof McpError ? error : new McpError("protocol", errorMessage(error)));
			},
		);
		void ended.finally(() => {
			if (watchdog !== null) clearTimeout(watchdog);
			if (streamId !== null) eventStreams.delete(streamId);
		});
		return {
			get id() {
				return streamId;
			},
			ended,
			cancel: () => {
				if (cancelled) return;
				cancelled = true;
				if (watchdog !== null) clearTimeout(watchdog);
				if (streamId !== null && eventStreams.delete(streamId)) sendCancel(streamId, "subscription closed by the client");
				controller.abort();
			},
		};
	};

	/**
	 * End the server: every open listen stream is cancelled, every pending
	 * request rejected, and the transport closed, which runs (or joins) its
	 * teardown.
	 */
	const close = (): Promise<McpTeardownOutcome> => {
		if (closePromise !== null) return closePromise;
		closePromise = (async () => {
			options.signal?.removeEventListener("abort", onParentAbort);
			if (status !== "failed") status = "closed";
			if (transport.started() && transport.endReported() === null) {
				for (const streamId of [...subscriptions.keys(), ...eventStreams.keys()]) {
					send({
						jsonrpc: "2.0",
						method: "notifications/cancelled",
						params: { requestId: streamId, reason: "client closed" },
					});
				}
			}
			subscriptions.clear();
			for (const stream of [...eventStreams.values()]) stream.end(closedError(), false);
			rejectAllPending(closedError());
			return await transport.close();
		})();
		return closePromise;
	};

	const onParentAbort = (): void => {
		void close();
	};

	if (options.signal !== undefined) {
		if (options.signal.aborted) void close();
		else options.signal.addEventListener("abort", onParentAbort, { once: true });
	}

	return {
		id,
		get pid() {
			return transport.pid;
		},
		initialize,
		listTools,
		callTool,
		close,
		killOwnedOnExit: () => transport.killOwnedOnExit(),
		state: () => {
			const teardown = transport.teardown();
			const cleanup = { cleanupIncomplete: teardown?.complete === false, teardown };
			return status === "failed"
				? { status, reason: failure?.message ?? `mcp server ${id} failed`, ...cleanup }
				: { status, ...cleanup };
		},
		serverInfo: () => info,
		toolsChanged: () => toolsChangedFlag,
		acknowledgeToolsChanged: () => {
			toolsChangedFlag = false;
		},
		notificationCount: () => notifications,
		onNotification,
		subscribe,
		stderrTail: () => transport.stderrTail(),
		eventsOffered,
		listEvents,
		pollEvents,
		streamEvents,
		eventsChanged: () => eventsChangedFlag,
		acknowledgeEventsChanged: () => {
			eventsChangedFlag = false;
		},
		skills,
	};
}
