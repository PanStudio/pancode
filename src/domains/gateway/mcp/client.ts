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
	formContentErrors,
	type McpElicitationContext,
	type McpElicitationRequest,
	type McpElicitResult,
	parseElicitationRequest,
} from "./elicitation.js";
import type { JsonRpcErrorObject, JsonRpcId, JsonRpcMessage } from "./protocol.js";
import {
	DEFAULT_MAX_LINE_BYTES,
	JSON_RPC_INVALID_PARAMS,
	JSON_RPC_METHOD_NOT_FOUND,
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
	MCP_URL_ELICITATION_REQUIRED,
	McpError,
} from "./protocol.js";
import { MCP_SKILLS_EXTENSION, type McpSkillsTransport, mcpSkillsSettings } from "./skills.js";
import { containedCwd, createMcpStdioTransport, type McpStdioServerSpec } from "./stdio-transport.js";
import {
	cutUtf8,
	DEFAULT_RESULT_TEXT_BYTES,
	type McpElicitationOutcome,
	type McpToolCallResult,
	type McpToolDescriptor,
	outputSchemaMismatch,
	parseToolCallResult,
	parseToolDescriptor,
} from "./tool-results.js";
import type {
	McpOutboundMessage,
	McpSendOptions,
	McpSendOutcome,
	McpTeardownOutcome,
	McpTransport,
	McpTransportEvents,
} from "./transport.js";

export {
	DEFAULT_RESULT_TEXT_BYTES,
	type McpContentBlock,
	type McpElicitationOutcome,
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
/** Retries of one request that the server keeps answering with input_required (basic/patterns/mrtr). */
export const MCP_INPUT_REQUIRED_ROUNDS = 8;

export type McpServerSpec = McpStdioServerSpec;

/**
 * Puts one server elicitation in front of the operator and returns their
 * answer. The context's signal fires when the call that asked is aborted, the
 * server withdraws the request, or the client closes.
 */
export type McpElicitationHandler = (
	request: McpElicitationRequest,
	context: McpElicitationContext,
) => Promise<McpElicitResult>;

/** The elicitation capability PanCode declares when an operator can answer: both modes (client/elicitation, Capabilities). */
const ELICITATION_CAPABILITY = { form: {}, url: {} };

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
	/**
	 * Answers the server's elicitations. Only its presence declares the
	 * `elicitation` capability; without it the client declares none, so a
	 * session nobody attends is never asked.
	 */
	elicitation?: McpElicitationHandler;
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
}

/** What one `subscriptions/listen` stream asks for (MCP 2026-07-28 basic/patterns/subscriptions). */
export interface McpSubscriptionFilter {
	toolsListChanged?: true;
	promptsListChanged?: true;
	resourcesListChanged?: true;
	resourceSubscriptions?: string[];
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
	/** Stop the request's timeout clock while the operator answers; the returned release starts it again. */
	hold(): () => void;
}

/** A tools/call in flight: the elicitations it went through and the operator time its timeout does not count. */
interface ActiveCall {
	signal?: AbortSignal;
	outcomes: McpElicitationOutcome[];
	pausedMs: number;
	/** URLs the operator consented to open during this call; asking again shows only the waiting card. */
	consentedUrls: Set<string>;
}

interface ActiveSubscription {
	acknowledged: boolean;
	acknowledge(honored: Record<string, unknown>): void;
	handler: (method: string, params: unknown) => void;
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
	/** The outstanding server-to-client requests of an input_required task. */
	inputRequests: Record<string, unknown> | null;
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
		inputRequests: isRecord(value.inputRequests) ? value.inputRequests : null,
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

export function createMcpStdioClient(spec: McpServerSpec, options: McpClientOptions): McpClient {
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
	const progressRoutes = new Map<string, ProgressRoute>();
	const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
	/** The outputSchema of each tool in the latest listing, which its structuredContent is checked against. */
	let outputSchemas = new Map<string, Record<string, unknown>>();
	let notifications = 0;
	let toolsChangedFlag = false;
	const elicitationHandler = options.elicitation;
	/** Aborted when the client closes or fails, which ends every prompt still open for this server. */
	const lifetime = new AbortController();
	const activeCalls = new Set<ActiveCall>();
	/** Legacy `elicitation/create` requests being answered, by request id, so `notifications/cancelled` can withdraw one. */
	const serverElicitations = new Map<JsonRpcId, AbortController>();
	/** URL elicitations of a -32042 error being waited on, by elicitationId, which `notifications/elicitation/complete` finishes. */
	const urlCompletions = new Map<string, AbortController>();

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
		lifetime.abort();
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
			// A legacy server asks for input with a request of its own (2025-11-25 client/elicitation);
			// a modern one asks through input_required, so its requests stay unknown.
			if (request.method === "elicitation/create" && elicitationHandler !== undefined && era === "legacy") {
				void answerServerElicitation(request.id as JsonRpcId, request.params);
				return;
			}
			reply({
				jsonrpc: "2.0",
				id: request.id as JsonRpcId,
				error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${request.method}` },
			});
			return;
		}
		notifications += 1;
		const { method, params } = frame.message;
		const meta = isRecord(params) && isRecord(params._meta) ? params._meta : null;
		if (method === "notifications/cancelled" && isRecord(params)) {
			const withdrawn = serverElicitations.get(params.requestId as JsonRpcId);
			if (withdrawn !== undefined) {
				withdrawn.abort();
				return;
			}
		}
		if (method === "notifications/elicitation/complete") {
			// An unknown or already finished id is ignored (2025-11-25 client/elicitation, Completion Notifications).
			if (isRecord(params) && typeof params.elicitationId === "string") urlCompletions.get(params.elicitationId)?.abort();
			return;
		}
		// On stdio, a server terminates a subscriptions/listen stream with
		// notifications/cancelled referencing the listen request's id (2026-07-28 basic/patterns/cancellation).
		if (method === "notifications/cancelled") {
			const targetId =
				isRecord(params) && typeof params.requestId === "number"
					? params.requestId
					: meta !== null && typeof meta[MCP_META_SUBSCRIPTION_ID] === "number"
						? meta[MCP_META_SUBSCRIPTION_ID]
						: null;
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
			routeSubscription(meta[MCP_META_SUBSCRIPTION_ID], method, params);
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
	const withEnvelope = (method: string, params: unknown): unknown => {
		if (era !== "modern" && method !== "server/discover") return params;
		const base = isRecord(params) ? params : {};
		const meta = isRecord(base._meta) ? base._meta : {};
		const extensions: Record<string, Record<string, never>> = {};
		const drivesTasks = method === "tools/call" || method.startsWith("tasks/");
		if (drivesTasks) extensions[MCP_TASKS_EXTENSION] = {};
		if ((method.startsWith("skills/") || method.startsWith("resources/")) && skillsSettings() !== null) {
			extensions[MCP_SKILLS_EXTENSION] = {};
		}
		// Elicitation is declared only on requests that actually handle input_required (basic/patterns/mrtr).
		const asksInput = elicitationHandler !== undefined && drivesTasks;
		return {
			...base,
			_meta: {
				...meta,
				[MCP_META_PROTOCOL_VERSION]: MCP_MODERN_PROTOCOL_VERSION,
				[MCP_META_CLIENT_INFO]: { name: MCP_CLIENT_NAME, version: clientVersion },
				[MCP_META_CLIENT_CAPABILITIES]: {
					...(Object.keys(extensions).length > 0 ? { extensions } : {}),
					...(asksInput ? { elicitation: ELICITATION_CAPABILITY } : {}),
				},
			},
		};
	};

	/** Answer a server's request, failing the client when the answer cannot be queued. */
	const reply = (message: McpOutboundMessage): void => {
		const outcome = send(message);
		if (outcome.kind === "oversized") {
			fail(
				new McpError(
					"overload",
					`mcp server ${id} sent a request whose ${outcome.bytes}-byte reply exceeds the ${outcome.cap}-byte outbound cap`,
				),
			);
			void close();
		}
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
			let remainingMs = timeoutMs;
			let armedAt = 0;
			let holds = 0;
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
			const arm = (): void => {
				armedAt = performance.now();
				timer = setTimeout(
					() => cancel(new McpError("timeout", `${method} timed out after ${timeoutMs}ms`)),
					Math.max(1, Math.ceil(remainingMs)),
				);
			};
			pending.set(requestId, {
				method,
				sent: false,
				resolve: (value) => settle(() => resolve(value)),
				reject: (error) => settle(() => reject(error)),
				abandon: () => settle(() => {}),
				hold: () => {
					if (timeoutMs <= 0 || cancelling || !pending.has(requestId)) return () => {};
					if (holds++ === 0 && timer !== null) {
						clearTimeout(timer);
						timer = null;
						remainingMs -= performance.now() - armedAt;
					}
					let released = false;
					return () => {
						if (released) return;
						released = true;
						if (--holds === 0 && !cancelling && pending.has(requestId)) arm();
					};
				},
			});
			onId?.(requestId);
			if (timeoutMs > 0) arm();
			signal?.addEventListener("abort", onAbort, { once: true });
			const outcome = send(
				{ jsonrpc: "2.0", id: requestId, method, ...(params === undefined ? {} : { params }) },
				{
					requestId,
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
		if (!isRecord(capabilities.tools) || capabilities.tools.listChanged !== true) return;
		const stream = subscribe({ toolsListChanged: true }, (method) => {
			if (method === "notifications/tools/list_changed") toolsChangedFlag = true;
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
			const handshake = (): Promise<unknown> =>
				request(
					"initialize",
					{
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: {
							extensions: { [MCP_SKILLS_EXTENSION]: {} },
							...(elicitationHandler !== undefined ? { elicitation: ELICITATION_CAPABILITY } : {}),
						},
						clientInfo: { name: MCP_CLIENT_NAME, version: clientVersion },
					},
					initializeTimeoutMs,
					signal,
					(assigned) => {
						handshakeId = assigned;
					},
				);
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
				era = "modern";
				info = discovered;
				if (status === "starting") status = "ready";
				listenForToolChanges(discovered.capabilities);
				return discovered;
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

	const listTools = (signal?: AbortSignal): Promise<McpToolListing> =>
		withDiscoverySignal(signal, async () => {
			await ensureReady(signal);
			const tools: McpToolDescriptor[] = [];
			let cursor: string | undefined;
			let pages = 0;
			// Each page carries its own freshness; the listing is as fresh as its stalest part.
			let ttlMs = era === "modern" ? (info?.ttlMs ?? 0) : undefined;
			const finish = (truncated: boolean): McpToolListing => {
				outputSchemas = new Map(tools.flatMap((tool) => (tool.outputSchema ? [[tool.name, tool.outputSchema]] : [])));
				return { tools, truncated, ...(ttlMs !== undefined ? { ttlMs } : {}) };
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
					tools.push(descriptor);
				}
				const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
				if (next === undefined) return finish(false);
				if (tools.length >= MCP_TOOL_LIST_CAP || pages >= MCP_TOOL_LIST_PAGE_CAP) return finish(true);
				cursor = next;
			}
		});

	/** Route this call's progress notifications to its caller while the call runs (basic/utilities/progress). */
	const trackProgress = (onProgress: (update: McpProgressUpdate) => void): { token: string; release(): void } => {
		const token = `pancode-${nextProgressToken++}`;
		progressRoutes.set(token, { last: Number.NEGATIVE_INFINITY, onProgress });
		return { token, release: () => progressRoutes.delete(token) };
	};

	/**
	 * Put one elicitation in front of the operator and read the answer into the
	 * ElicitResult the server is sent. A request PanCode will not show (a field
	 * asking for a secret, a schema richer than a flat form, a link it would not
	 * open) is declined for the operator with the reason, and an accepted form
	 * is checked against its schema before it leaves (client/elicitation, Form
	 * Mode Security). `paused` receives the time the operator took, which no
	 * timeout counts. `invalid` is a request that breaks the protocol.
	 */
	const elicit = async (
		params: unknown,
		legacy: boolean,
		signal: AbortSignal,
		calls: readonly ActiveCall[],
		awaitCompletion: boolean,
	): Promise<{ result: McpElicitResult; outcome: McpElicitationOutcome } | { invalid: string }> => {
		const parsed = parseElicitationRequest(params, legacy);
		if (parsed.kind === "invalid") return { invalid: parsed.reason };
		if (parsed.kind === "declined")
			return { result: { action: "decline" }, outcome: { mode: parsed.mode, action: "decline", reason: parsed.reason } };
		if (elicitationHandler === undefined) return { invalid: "PanCode declared no elicitation capability" };
		const asked = parsed.request;
		const url = asked.mode === "url" ? asked.url : null;
		const completion =
			awaitCompletion && asked.mode === "url" && asked.elicitationId !== undefined ? new AbortController() : null;
		if (completion !== null && asked.mode === "url" && asked.elicitationId !== undefined)
			urlCompletions.set(asked.elicitationId, completion);
		const context: McpElicitationContext = {
			signal,
			awaitCompletion,
			consented: awaitCompletion && url !== null && calls.some((call) => call.consentedUrls.has(url)),
			...(completion !== null ? { completed: completion.signal } : {}),
		};
		const cancelled = (reason: string) => ({
			result: { action: "cancel" as const },
			outcome: { mode: asked.mode, action: "cancel" as const, reason },
		});
		const began = performance.now();
		let answer: McpElicitResult;
		try {
			answer = await elicitationHandler(asked, context);
		} catch (error) {
			if (signal.aborted) throw new McpError("aborted", "elicitation aborted");
			return cancelled(`the prompt failed: ${errorMessage(error)}`);
		} finally {
			const pausedMs = performance.now() - began;
			for (const call of calls) call.pausedMs += pausedMs;
			if (asked.mode === "url" && asked.elicitationId !== undefined) urlCompletions.delete(asked.elicitationId);
		}
		if (signal.aborted) throw new McpError("aborted", "elicitation aborted");
		if (answer.action === "decline" || answer.action === "cancel")
			return { result: { action: answer.action }, outcome: { mode: asked.mode, action: answer.action } };
		if (answer.action !== "accept") return cancelled("the prompt returned no action");
		if (asked.mode === "url") {
			for (const call of calls) call.consentedUrls.add(asked.url);
			return { result: { action: "accept" }, outcome: { mode: "url", action: "accept" } };
		}
		const content = answer.content ?? {};
		const errors = formContentErrors(asked, content);
		if (errors.length > 0) return cancelled(`the answer did not fit the form: ${errors.join("; ")}`);
		return { result: { action: "accept", content }, outcome: { mode: "form", action: "accept" } };
	};

	/**
	 * Fulfil the `inputRequests` of an input_required result or task
	 * (basic/patterns/mrtr), each in turn. Elicitation is the only capability
	 * PanCode declares, so a request for anything else (sampling, roots) breaks
	 * the protocol and fails the call before the operator is asked anything.
	 */
	const fulfilInputRequests = async (
		method: string,
		entries: ReadonlyArray<[string, unknown]>,
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<Record<string, McpElicitResult>> => {
		const methods = [
			...new Set(entries.map(([, entry]) => (isRecord(entry) && typeof entry.method === "string" ? entry.method : "?"))),
		];
		if (elicitationHandler === undefined) {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required asking for ${serverText(methods.join(", "))}, but PanCode declared no client capabilities, so a server must not ask it for input`,
			);
		}
		const foreign = methods.filter((name) => name !== "elicitation/create");
		if (foreign.length > 0) {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required asking for ${serverText(foreign.join(", "))}, but PanCode declared only elicitation, so a server must not ask it for that`,
			);
		}
		const responses: Record<string, McpElicitResult> = {};
		for (const [key, entry] of entries) {
			const answered = await elicit(isRecord(entry) ? entry.params : undefined, false, signal, [call], true);
			if ("invalid" in answered) {
				throw new McpError(
					"protocol",
					`mcp server ${id} answered ${method} with an elicitation PanCode cannot read: ${serverText(answered.invalid)}`,
				);
			}
			responses[key] = answered.result;
			call.outcomes.push(answered.outcome);
		}
		return responses;
	};

	/**
	 * The one place an `input_required` answer (MCP 2026-07-28
	 * basic/patterns/mrtr) is handled; it returns the params of the retry: the
	 * original params with `inputResponses` keyed exactly as the server asked,
	 * and its `requestState` echoed verbatim, or none when it sent none.
	 */
	const answerInputRequired = async (
		method: string,
		params: Record<string, unknown>,
		result: Record<string, unknown>,
		round: number,
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<Record<string, unknown>> => {
		if (result.inputRequests !== undefined && !isRecord(result.inputRequests)) {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required whose inputRequests is not an object`,
			);
		}
		const asked = isRecord(result.inputRequests) ? Object.entries(result.inputRequests) : [];
		if (asked.length === 0 && typeof result.requestState !== "string") {
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
		const inputResponses = asked.length > 0 ? await fulfilInputRequests(method, asked, signal, call) : null;
		const { requestState: _previous, inputResponses: _answered, ...base } = params;
		return {
			...base,
			...(inputResponses !== null ? { inputResponses } : {}),
			...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}),
		};
	};

	/** The URL elicitations a legacy server's -32042 error asks for before its request is retried, or null. */
	const urlElicitationsRequired = (error: unknown): unknown[] | null => {
		if (elicitationHandler === undefined || era !== "legacy") return null;
		if (!(error instanceof McpError) || error.code !== "server" || !isRecord(error.data)) return null;
		const { code, data } = error.data;
		if (code !== MCP_URL_ELICITATION_REQUIRED || !isRecord(data) || !Array.isArray(data.elicitations)) return null;
		return data.elicitations.length > 0 ? data.elicitations : null;
	};

	/**
	 * Put each URL of a -32042 error in front of the operator (2025-11-25
	 * client/elicitation, URL Elicitation Required Error); null means every one
	 * is done and the request is retried. A URL the operator turns down ends
	 * the call with the server's error, there being no request to answer.
	 */
	const answerUrlElicitationsRequired = async (
		error: McpError,
		elicitations: unknown[],
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<McpToolCallResult | null> => {
		for (const entry of elicitations) {
			const answered =
				isRecord(entry) && entry.mode === "url"
					? await elicit(entry, true, signal, [call], true)
					: { invalid: "an elicitation it lists is not URL mode" };
			if ("invalid" in answered) {
				throw new McpError(
					"protocol",
					`mcp server ${id} answered tools/call with a URL-elicitation-required error PanCode cannot read: ${serverText(answered.invalid)}`,
				);
			}
			call.outcomes.push(answered.outcome);
			if (answered.result.action !== "accept") {
				const text = cutUtf8(error.message, DEFAULT_RESULT_TEXT_BYTES);
				return { content: [{ type: "text", text }], isError: true, text, textTruncated: false };
			}
		}
		return null;
	};

	/**
	 * A legacy server's own `elicitation/create` request (2025-11-25
	 * client/elicitation). It belongs to the tools/call in flight, whose
	 * timeout stops while the operator answers; with none in flight nobody
	 * can tell what asked, so it is cancelled unseen. A malformed request or
	 * an undeclared mode gets -32602.
	 */
	const answerServerElicitation = async (requestId: JsonRpcId, params: unknown): Promise<void> => {
		const calls = [...activeCalls];
		if (calls.length === 0) {
			reply({ jsonrpc: "2.0", id: requestId, result: { action: "cancel" } });
			return;
		}
		const withdrawn = new AbortController();
		serverElicitations.set(requestId, withdrawn);
		const signal = AbortSignal.any([
			withdrawn.signal,
			lifetime.signal,
			...calls.flatMap((call) => (call.signal ? [call.signal] : [])),
		]);
		const releases = [...pending.values()].filter((entry) => entry.method === "tools/call").map((entry) => entry.hold());
		try {
			const answered = await elicit(params, true, signal, calls, false);
			if ("invalid" in answered) {
				reply({ jsonrpc: "2.0", id: requestId, error: { code: JSON_RPC_INVALID_PARAMS, message: answered.invalid } });
				return;
			}
			for (const call of calls) call.outcomes.push(answered.outcome);
			reply({ jsonrpc: "2.0", id: requestId, result: answered.result });
		} catch {
			// The asking call was aborted: it is told the operator dismissed the prompt. A
			// withdrawn request or a closed client is owed nothing.
			if (!withdrawn.signal.aborted && !lifetime.signal.aborted)
				reply({ jsonrpc: "2.0", id: requestId, result: { action: "cancel" } });
		} finally {
			serverElicitations.delete(requestId);
			for (const release of releases) release();
		}
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
		const call: ActiveCall = {
			...(signal !== undefined ? { signal } : {}),
			outcomes: [],
			pausedMs: 0,
			consentedUrls: new Set(),
		};
		const promptSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
		const finished = (result: McpToolCallResult): McpToolCallResult =>
			call.outcomes.length > 0 ? { ...result, elicitations: [...call.outcomes] } : result;
		let params: Record<string, unknown> = { name, arguments: args };
		let urlRetried = false;
		activeCalls.add(call);
		try {
			for (let round = 1; ; round += 1) {
				let budget = timeoutMs;
				if (round > 1 && timeoutMs > 0) {
					// The operator's time answering an elicitation is not the server's time.
					budget = Math.ceil(startedAt + call.pausedMs + timeoutMs - performance.now());
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
						const elicitations = urlElicitationsRequired(error);
						if (elicitations === null || urlRetried) throw error;
						const declined = await answerUrlElicitationsRequired(error as McpError, elicitations, promptSignal, call);
						if (declined !== null) return finished(declined);
						// One retry once every URL is done; a second -32042 for the call is its error.
						urlRetried = true;
						continue;
					}
					if (era === "modern" && isRecord(result) && result.resultType !== undefined && result.resultType !== "complete") {
						if (result.resultType === "task")
							return finished(await awaitTask(name, result, startedAt, timeoutMs, signal, call, promptSignal));
						if (result.resultType === "input_required") {
							params = await answerInputRequired("tools/call", params, result, round, promptSignal, call);
							continue;
						}
						throw new McpError(
							"protocol",
							`tools/call returned resultType ${serverText(JSON.stringify(result.resultType))}, which this client does not handle`,
						);
					}
					return finished(await finishToolResult(name, result));
				} finally {
					progress?.release();
				}
			}
		} finally {
			activeCalls.delete(call);
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
	 * asks for input this client cannot give. An input_required task's
	 * elicitations are put to the operator once per key and answered with
	 * tasks/update; the operator's time does not count against the call.
	 */
	const awaitTask = async (
		name: string,
		created: Record<string, unknown>,
		startedAt: number,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		call: ActiveCall,
		promptSignal: AbortSignal,
	): Promise<McpToolCallResult> => {
		const first = parseTaskState(created, "tools/call", null);
		if (first instanceof McpError) throw first;
		const taskId = first.taskId;
		const deadlineAt = (): number => (timeoutMs > 0 ? startedAt + call.pausedMs + timeoutMs : Number.POSITIVE_INFINITY);
		/** Keys answered over the task's lifetime, which the server never reuses (Tasks, Input Requests). */
		const answered = new Set<string>();
		// The ttl counts from the server's creation; the local receipt time is a
		// conservative stand-in that no clock skew between the two can stretch.
		const expiresAt = first.ttlMs === null ? Number.POSITIVE_INFINITY : performance.now() + first.ttlMs;
		const timedOut = (): McpError => new McpError("timeout", `tools/call timed out after ${timeoutMs}ms`);
		const aborted = (): McpError => new McpError("aborted", "tools/call aborted");
		/** A tasks/* request within what is left of the call's time, failing as the call would. */
		const taskRequest = async (method: string, taskParams: Record<string, unknown>): Promise<unknown> => {
			const left = deadlineAt() - performance.now();
			if (left <= 0) throw timedOut();
			try {
				return await request(method, taskParams, Number.isFinite(left) ? Math.max(1, Math.ceil(left)) : 0, signal);
			} catch (error) {
				if (error instanceof McpError && error.code === "timeout") throw timedOut();
				if (error instanceof McpError && error.code === "aborted") throw aborted();
				throw error;
			}
		};
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
					case "input_required": {
						if (elicitationHandler === undefined) {
							await cancelTask(taskId, new McpError("server", `tools/call: task ${taskId} required input`));
							throw new McpError(
								"server",
								`tools/call: task ${taskId} asked for client input (elicitation or sampling), which this client does not provide; the task was cancelled`,
							);
						}
						// A poll repeats every outstanding request; each key is put to the operator once.
						const fresh = Object.entries(task.inputRequests ?? {}).filter(([key]) => !answered.has(key));
						if (fresh.length === 0) break;
						let inputResponses: Record<string, McpElicitResult>;
						try {
							inputResponses = await fulfilInputRequests("tasks/get", fresh, promptSignal, call);
						} catch (error) {
							if (error instanceof McpError && error.code === "protocol") await cancelTask(taskId, error);
							throw error;
						}
						for (const [key] of fresh) answered.add(key);
						await taskRequest("tasks/update", { taskId, inputResponses });
						break;
					}
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
				const remaining = deadlineAt() - now;
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
				const polled = await taskRequest("tasks/get", { taskId });
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
			lifetime.abort();
			if (transport.started() && transport.endReported() === null) {
				for (const streamId of subscriptions.keys()) {
					send({
						jsonrpc: "2.0",
						method: "notifications/cancelled",
						params: { requestId: streamId, reason: "client closed" },
					});
				}
			}
			subscriptions.clear();
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
		skills,
	};
}
