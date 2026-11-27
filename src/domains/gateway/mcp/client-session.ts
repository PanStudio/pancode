// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Transport and request routing: the lifetime of one MCP client's connection.
 * The session owns the transport, every request in flight and its timeout,
 * the per-request envelope of the modern era, and the routing of each frame
 * the server sends (answers, its own requests, progress, listen and event
 * stream notifications). It also holds the state the other lifetimes share:
 * the settled era, the server's info, and the calls and prompts still open.
 * Teardown lives here because it ends all of them at once.
 */

import { performance } from "node:perf_hooks";
import { boundedExternalDiagnostic } from "../../../core/external-diagnostic.js";
import { readPancodeVersion } from "../../../core/package-root.js";
import { neutralizeFraming } from "../../../core/reminder-framing.js";
import { clampTimerDelayMs } from "../../../core/timers.js";
import { isRecord } from "../../../core/type-guards.js";
import type {
	McpClientStatus,
	McpElicitationHandler,
	McpEventStreamHandlers,
	McpListedPrimitive,
	McpProgressUpdate,
	McpProtocolClientOptions,
	McpServerInfo,
} from "./client.js";
import { mcpEventErrorObject, mcpEventsOffered, parseEventCursor, parseEventOccurrence } from "./events.js";
import {
	MCP_FILES_EXTENSION,
	type McpFileConnection,
	type McpFilesSettings,
	mcpFilesDeclaration,
	mcpFilesOffered,
} from "./files.js";
import type { JsonRpcErrorObject, JsonRpcId, JsonRpcMessage } from "./protocol.js";
import {
	JSON_RPC_METHOD_NOT_FOUND,
	MCP_EVENTS_EXTENSION,
	MCP_META_CLIENT_CAPABILITIES,
	MCP_META_CLIENT_INFO,
	MCP_META_PROTOCOL_VERSION,
	MCP_META_SERVER_INFO,
	MCP_META_SUBSCRIPTION_ID,
	MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_TASKS_EXTENSION,
	MCP_UNSUPPORTED_PROTOCOL_VERSION,
	McpError,
} from "./protocol.js";
import { DEFAULT_RESULT_TEXT_BYTES, type McpElicitationOutcome } from "./tool-results.js";
import type {
	McpOutboundMessage,
	McpParamHeader,
	McpSendOptions,
	McpSendOutcome,
	McpTeardownOutcome,
	McpTransport,
	McpTransportEvents,
} from "./transport.js";

export const MCP_CLIENT_NAME = "pancode";
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Bound for checking server responsiveness after cancelling an in-flight call. */
export const DEFAULT_CANCEL_GRACE_MS = 1_000;
/** Bytes of one server-written text (an error message, its detail, a task status message) an error carries. */
const SERVER_TEXT_BYTES = 2048;
/** Bytes of one progress message passed on to the caller. */
const PROGRESS_MESSAGE_BYTES = 512;

/** The elicitation capability PanCode declares when an operator can answer: both modes (client/elicitation, Capabilities). */
export const ELICITATION_CAPABILITY = { form: {}, url: {} };

export interface PendingRequest {
	method: string;
	sent: boolean;
	resolve(value: unknown): void;
	reject(error: McpError): void;
	abandon(): void;
	/** Stop the request's timeout clock while the operator answers; the returned release starts it again. */
	hold(): () => void;
}

/** A tools/call in flight: the elicitations it went through and the operator time its timeout does not count. */
export interface ActiveCall {
	signal?: AbortSignal;
	outcomes: McpElicitationOutcome[];
	pausedMs: number;
	/** URLs the operator consented to open during this call; asking again shows only the waiting card. */
	consentedUrls: Set<string>;
}

export interface ActiveSubscription {
	acknowledged: boolean;
	acknowledge(honored: Record<string, unknown>): void;
	handler: (method: string, params: unknown) => void;
}

export interface ActiveEventStream {
	handlers: McpEventStreamHandlers;
	/** Any notification of the stream re-arms its silence watchdog. */
	touch(): void;
	/** End the stream from this side with a cause; `cancel` also sends notifications/cancelled. */
	end(error: McpError, cancel: boolean): void;
}

export interface ProgressRoute {
	last: number;
	onProgress: (update: McpProgressUpdate) => void;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Text a server wrote, redacted and clipped before it enters an error the model and the operator read. */
export function serverText(text: string): string {
	return boundedExternalDiagnostic(text, SERVER_TEXT_BYTES);
}

/** A freshness hint as the caching rules read it: a missing, negative or malformed value is 0. */
export function freshnessOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function serverIdentity(value: unknown): McpServerInfo["serverInfo"] {
	if (!isRecord(value)) return null;
	return {
		name: typeof value.name === "string" ? value.name : "",
		version: typeof value.version === "string" ? value.version : "",
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
export function serverAnswerError(method: string, error: JsonRpcErrorObject): McpError {
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

/** The state every lifetime of one client reads and moves forward. */
export interface McpSessionState {
	status: McpClientStatus;
	failure: McpError | null;
	info: McpServerInfo | null;
	/**
	 * Which protocol era the server speaks, settled once by the discovery probe.
	 * Legacy keeps the initialize session and sends every request unchanged;
	 * modern stamps each request with the version, identity and capabilities.
	 */
	era: "legacy" | "modern";
	nextId: number;
	nextProgressToken: number;
	closePromise: Promise<McpTeardownOutcome> | null;
	readonly pending: Map<number, PendingRequest>;
	readonly subscriptions: Map<number, ActiveSubscription>;
	readonly eventStreams: Map<number, ActiveEventStream>;
	readonly progressRoutes: Map<string, ProgressRoute>;
	readonly notificationHandlers: Map<string, Set<(params: unknown) => void>>;
	/** The outputSchema of each tool in the latest listing, which its structuredContent is checked against. */
	outputSchemas: Map<string, Record<string, unknown>>;
	/** The `x-mcp-header` parameters of each tool in the latest listing, mirrored into an HTTP call's headers. */
	paramHeaders: Map<string, McpParamHeader[]>;
	notifications: number;
	toolsChangedFlag: boolean;
	eventsChangedFlag: boolean;
	/** Aborted when the client closes or fails, which ends every prompt still open for this server. */
	readonly lifetime: AbortController;
	readonly activeCalls: Set<ActiveCall>;
	/** Legacy `elicitation/create` requests being answered, by request id, so `notifications/cancelled` can withdraw one. */
	readonly serverElicitations: Map<JsonRpcId, AbortController>;
	/** URL elicitations of a -32042 error being waited on, by elicitationId, which `notifications/elicitation/complete` finishes. */
	readonly urlCompletions: Map<string, AbortController>;
	/** Prompts or resources the server said changed since the gateway last acknowledged them. */
	readonly primitivesChanged: Set<McpListedPrimitive>;
	readonly listChangedHandlers: Set<(primitive: McpListedPrimitive) => void>;
}

/** One client's connection: its settings, its shared state, and the requests every other lifetime sends through it. */
export interface McpSession extends McpSessionState {
	readonly id: string;
	readonly options: McpProtocolClientOptions;
	readonly initializeTimeoutMs: number;
	readonly requestTimeoutMs: number;
	readonly maxResultTextBytes: number;
	readonly clientVersion: string;
	readonly elicitationHandler: McpElicitationHandler | undefined;
	readonly fileTransfers: boolean;
	readonly transport: McpTransport;
	/** The error every later request gets once the client cannot serve it. */
	closedError(): McpError;
	/** Record the first fatal error; later ones never overwrite the cause a caller sees. */
	fail(error: McpError): void;
	close(): Promise<McpTeardownOutcome>;
	send(message: McpOutboundMessage, sendOptions?: McpSendOptions): McpSendOutcome;
	/** Answer a server's request, failing the client when the answer cannot be queued. */
	reply(message: McpOutboundMessage): void;
	request(
		method: string,
		rawParams: unknown,
		timeoutMs: number,
		signal?: AbortSignal,
		onId?: (requestId: number) => void,
		extensions?: Record<string, unknown>,
	): Promise<unknown>;
	noteListChanged(method: string): void;
	trackProgress(onProgress: (update: McpProgressUpdate) => void): { token: string; release(): void };
	onNotification(method: string, handler: (params: unknown) => void): () => void;
	filesOffered(): McpFilesSettings | null;
	fileConnection(): McpFileConnection;
	eventsOffered(): { listChanged: boolean } | null;
}

/** What the session hands to the other lifetimes it routes frames for. */
export interface McpSessionHooks {
	/** A legacy server's own `elicitation/create` request, answered by the elicitation lifetime. */
	serverElicitation(requestId: JsonRpcId, params: unknown): void;
}

/**
 * Open the session. `openTransport` is called once, here, with the events the
 * transport reports; nothing is sent until the first initialize starts it.
 */
export function createMcpSession(
	id: string,
	openTransport: (events: McpTransportEvents) => McpTransport,
	options: McpProtocolClientOptions,
	hooks: McpSessionHooks,
): McpSession {
	const initializeTimeoutMs = clampTimerDelayMs(options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS);
	const requestTimeoutMs = clampTimerDelayMs(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
	const maxResultTextBytes = Math.max(64, options.maxResultTextBytes ?? DEFAULT_RESULT_TEXT_BYTES);
	const clientVersion = options.clientVersion ?? readPancodeVersion();
	const elicitationHandler = options.elicitation;
	const fileTransfers = options.fileTransfers === true;
	const session: McpSessionState = {
		status: "idle",
		failure: null,
		info: null,
		era: "legacy",
		nextId: 1,
		nextProgressToken: 1,
		closePromise: null,
		pending: new Map(),
		subscriptions: new Map(),
		eventStreams: new Map(),
		progressRoutes: new Map(),
		notificationHandlers: new Map(),
		outputSchemas: new Map(),
		paramHeaders: new Map(),
		notifications: 0,
		toolsChangedFlag: false,
		eventsChangedFlag: false,
		lifetime: new AbortController(),
		activeCalls: new Set(),
		serverElicitations: new Map(),
		urlCompletions: new Map(),
		primitivesChanged: new Set(),
		listChangedHandlers: new Set(),
	};
	const {
		pending,
		subscriptions,
		eventStreams,
		progressRoutes,
		notificationHandlers,
		lifetime,
		serverElicitations,
		urlCompletions,
		primitivesChanged,
		listChangedHandlers,
	} = session;

	const declaresListChanged = (key: "tools" | "prompts" | "resources"): boolean =>
		session.info !== null &&
		isRecord(session.info.capabilities[key]) &&
		session.info.capabilities[key].listChanged === true;

	const noteListChanged = (method: string): void => {
		if (method === "notifications/tools/list_changed") {
			if (declaresListChanged("tools")) session.toolsChangedFlag = true;
			return;
		}
		if (method === "notifications/events/list_changed") {
			if (session.info !== null && mcpEventsOffered(session.info.capabilities)?.listChanged === true)
				session.eventsChangedFlag = true;
			return;
		}
		const primitive: McpListedPrimitive | null =
			method === "notifications/prompts/list_changed"
				? "prompts"
				: method === "notifications/resources/list_changed"
					? "resources"
					: null;
		if (primitive === null || !declaresListChanged(primitive)) return;
		primitivesChanged.add(primitive);
		for (const handler of listChangedHandlers) {
			try {
				handler(primitive);
			} catch {
				// A listener's failure never reaches the protocol.
			}
		}
	};

	/** The error every later request gets once the client cannot serve it. */
	const closedError = (): McpError => session.failure ?? new McpError("closed", `mcp server ${id} is closed`);

	const rejectAllPending = (error: McpError): void => {
		for (const entry of [...pending.values()]) entry.reject(error);
	};

	/** Record the first fatal error; later ones never overwrite the cause a caller sees. */
	const fail = (error: McpError): void => {
		if (session.status === "closed" || session.status === "failed") return;
		session.status = "failed";
		options.signal?.removeEventListener("abort", onParentAbort);
		session.failure = error;
		lifetime.abort();
		rejectAllPending(error);
		options.onFailure?.(error);
	};

	const transport = openTransport({
		message: (frame) => {
			if (session.status === "closed" || session.status === "failed") return;
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
		if (session.era !== "modern" || session.info === null || !isRecord(result) || !isRecord(result._meta)) return;
		const reported = serverIdentity(result._meta[MCP_META_SERVER_INFO]);
		if (reported !== null) session.info = { ...session.info, serverInfo: reported };
	};

	/**
	 * -32022 on a request other than the probe means the server stopped
	 * serving the revision this client settled on. Nothing it answers can be
	 * trusted until the era is settled again, which a restart does.
	 */
	const unsupportedVersionError = (method: string, error: JsonRpcErrorObject): McpError => {
		const data = isRecord(error.data) ? error.data : {};
		const supported = Array.isArray(data.supported) ? serverText(data.supported.map(String).join(", ")) : "none listed";
		const requested =
			typeof data.requested === "string" ? serverText(data.requested) : (session.info?.protocolVersion ?? "?");
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
			// A legacy server asks for input with a request of its own (2025-11-25 client/elicitation);
			// a modern one asks through input_required, so its requests stay unknown.
			if (request.method === "elicitation/create" && elicitationHandler !== undefined && session.era === "legacy") {
				hooks.serverElicitation(request.id as JsonRpcId, request.params);
				return;
			}
			reply({
				jsonrpc: "2.0",
				id: request.id as JsonRpcId,
				error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${request.method}` },
			});
			return;
		}
		session.notifications += 1;
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
		// Modern list_changed arrives only on an acknowledged subscriptions/listen stream (MCP 2026-07-28).
		if (session.era === "legacy") noteListChanged(method);
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
	 * that cannot follow it. Other extensions come from the one request that
	 * declares them, such as the skills extension on a skill's `skills/*` and
	 * resource reads, never on a generic read. Nothing is added on the legacy
	 * path, where initialize declared the skills extension once.
	 */
	const tasksRevisionUnknown = (): boolean => {
		const extensions = isRecord(session.info?.capabilities?.extensions) ? session.info.capabilities.extensions : null;
		if (extensions === null || !Object.hasOwn(extensions, MCP_TASKS_EXTENSION)) return false;
		const declared = extensions[MCP_TASKS_EXTENSION];
		return !isRecord(declared) || declared.revision !== undefined;
	};

	const withEnvelope = (method: string, params: unknown, declared?: Record<string, unknown>): unknown => {
		if (session.era !== "modern" && method !== "server/discover") return params;
		const base = isRecord(params) ? params : {};
		const meta = isRecord(base._meta) ? base._meta : {};
		const extensions: Record<string, unknown> = { ...declared };
		const drivesTasks = method === "tools/call" || method.startsWith("tasks/");
		if (drivesTasks && !tasksRevisionUnknown()) {
			extensions[MCP_TASKS_EXTENSION] = {};
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
		// The files extension rides on the listing and on every request of a logical call (files, Capabilities).
		if (filesOffered() !== null && (method === "tools/list" || drivesTasks)) {
			extensions[MCP_FILES_EXTENSION] = mcpFilesDeclaration(fileTransfers);
		}
		// Elicitation is declared only on requests that actually handle input_required (basic/patterns/mrtr).
		const asksInput =
			elicitationHandler !== undefined && (drivesTasks || method === "resources/read" || method === "prompts/get");
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
		extensions?: Record<string, unknown>,
	): Promise<unknown> =>
		new Promise<unknown>((resolve, reject) => {
			const params = withEnvelope(method, rawParams, extensions);
			if (signal?.aborted) {
				reject(new McpError("aborted", `${method} aborted before it was sent`));
				return;
			}
			if (!transport.started() || session.status === "closed" || session.status === "failed") {
				reject(closedError());
				return;
			}
			const ended = transport.endReported();
			if (ended !== null) {
				// The server is gone and its exit error is about to be the failure; that, not a write error, answers.
				void ended.then(() => reject(closedError()));
				return;
			}
			const requestId = session.nextId++;
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
					session.era === "modern" ? "server/discover" : "ping",
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
			const mirrored =
				method === "tools/call" && isRecord(params) && typeof params.name === "string"
					? session.paramHeaders.get(params.name)
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
						settle(() =>
							reject(session.failure ?? new McpError("closed", `write to mcp server ${id} failed: ${error.message}`)),
						);
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

	/** Route this call's progress notifications to its caller while the call runs (basic/utilities/progress). */
	const trackProgress = (onProgress: (update: McpProgressUpdate) => void): { token: string; release(): void } => {
		const token = `pancode-${session.nextProgressToken++}`;
		progressRoutes.set(token, { last: Number.NEGATIVE_INFINITY, onProgress });
		return { token, release: () => progressRoutes.delete(token) };
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

	const filesOffered = (): McpFilesSettings | null =>
		session.era === "modern" && session.info !== null ? mcpFilesOffered(session.info.capabilities) : null;

	const fileConnection = (): McpFileConnection => {
		const http = transport.http;
		return http === undefined
			? { address: null, credentialOrigin: null, authorization: async () => null }
			: {
					address: http.address(),
					credentialOrigin: http.credentialOrigin(),
					authorization: (signal) => http.authorization(signal),
				};
	};

	const eventsOffered = (): { listChanged: boolean } | null =>
		session.era === "modern" && session.info !== null ? mcpEventsOffered(session.info.capabilities) : null;

	/**
	 * End the server: every open listen stream is cancelled, every pending
	 * request rejected, and the transport closed, which runs (or joins) its
	 * teardown.
	 */
	const close = (): Promise<McpTeardownOutcome> => {
		if (session.closePromise !== null) return session.closePromise;
		session.closePromise = (async () => {
			options.signal?.removeEventListener("abort", onParentAbort);
			if (session.status !== "failed") session.status = "closed";
			lifetime.abort();
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
		return session.closePromise;
	};

	const onParentAbort = (): void => {
		void close();
	};

	if (options.signal !== undefined) {
		if (options.signal.aborted) void close();
		else options.signal.addEventListener("abort", onParentAbort, { once: true });
	}

	return Object.assign(session, {
		id,
		options,
		initializeTimeoutMs,
		requestTimeoutMs,
		maxResultTextBytes,
		clientVersion,
		elicitationHandler,
		fileTransfers,
		transport,
		closedError,
		fail,
		close,
		send,
		reply,
		request,
		noteListChanged,
		trackProgress,
		onNotification,
		filesOffered,
		fileConnection,
		eventsOffered,
	});
}
