// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The Streamable HTTP transport (MCP 2026-07-28 basic/transports/streamable-http,
 * and the 2025-03-26 through 2025-11-25 transport a legacy server speaks). Every
 * client message is one POST to the endpoint. A request's answer comes back as
 * a JSON body or on a `text/event-stream` body that may carry notifications and,
 * in the legacy era, server requests before it; the stream is read until the
 * answer arrives. No standalone GET stream is opened, so a legacy server's
 * unsolicited notifications are not heard and a changed tool list is seen at the
 * next listing.
 *
 * Credentials ride in the static headers the declaration names, or as the
 * Bearer token of an OAuth grant. They go to the declared endpoint only: a
 * redirect is followed only within the same origin and only when it keeps the
 * POST (307, 308), a token never follows one out of the resource it was issued
 * for, every value is registered with the report scrub, and no value reaches
 * an error message this transport makes or relays from the server.
 */

import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";
import { rememberResolvedSecret } from "../../core/sandbox/env-scrub.js";
import { isRecord } from "../../core/type-guards.js";
import { encodeMcpHeaderValue, mcpNameSource, mcpParamHeaderValues } from "./http-headers.js";
import { mcpScopeList, parseWwwAuthenticate } from "./oauth.js";
import type { JsonRpcErrorObject, JsonRpcId, JsonRpcMessage } from "./protocol.js";
import { MCP_META_PROTOCOL_VERSION, MCP_META_SUBSCRIPTION_ID, McpError, parseJsonRpcLine } from "./protocol.js";
import { mcpOriginOf } from "./remote.js";
import type {
	McpHttpBinding,
	McpOutboundMessage,
	McpSendOptions,
	McpSendOutcome,
	McpTeardownOutcome,
	McpTransport,
	McpTransportEvents,
} from "./transport.js";

export interface McpHttpServerSpec {
	id: string;
	/** The endpoint, already checked by mcpRemoteEndpoint. */
	url: string;
	/** Header name to the resolved credential value; never logged, never sent to another origin. */
	headers?: Readonly<Record<string, string>>;
	/** The OAuth grant a server without headers is signed in with. */
	authorizer?: McpHttpAuthorizer;
}

/** What the transport needs from an OAuth grant (basic/authorization, Access Token Usage). */
export interface McpHttpAuthorizer {
	/** The access token to send as `Authorization: Bearer`. */
	token(): string;
	/** Whether the token is past its recorded expiry, so it is renewed before it is sent. */
	stale(): boolean;
	/** Whether `url` lies inside the resource the token was issued for. */
	covers(url: URL): boolean;
	/** The resource the token was issued for. */
	resource(): string;
	/** After a 401 for `rejected`: adopt a newer stored token or refresh once; true when another token is ready. */
	renew(rejected: string, signal: AbortSignal): Promise<boolean>;
	/**
	 * A 403 insufficient_scope for `scopes`: record them for the next sign-in.
	 * Permanent when the last sign-in already requested them all, so PanCode
	 * never asks for the same scopes in a loop.
	 */
	insufficientScope(scopes: ReadonlyArray<string>): Promise<{ permanent: boolean }>;
}

export interface McpHttpTransportOptions {
	/** Cap on one inbound JSON-RPC message, whether a JSON body or one SSE event. */
	maxMessageBytes: number;
	/** Cap on one outbound message body. */
	maxOutboundBytes: number;
	/** Bound on the session DELETE a legacy close sends. */
	teardownBoundMs: number;
	fetch?: typeof fetch;
}

/** The error code an answer this transport makes up for a failed exchange carries. */
const HTTP_EXCHANGE_FAILED = -32000;
const DEFAULT_RETRY_DELAYS_MS = [200, 400, 800, 1600] as const;
const MAX_REDIRECTS = 5;
/** Bytes of a non-JSON error body an answer quotes. */
const ERROR_BODY_BYTES = 512;
const ACCEPT = "application/json, text/event-stream";
/** A connection failure before any byte reached the server; the message was not delivered and may be sent again. */
const UNREACHED = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EADDRNOTAVAIL",
	"UND_ERR_CONNECT_TIMEOUT",
]);
const TLS_FAILURE = /CERT|TLS|SSL|ALTNAME|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)/u;
/** A legacy session id: visible ASCII only (2025-11-25 Session Management). */
const SESSION_ID = /^[\x21-\x7e]+$/u;

/** The era each origin answered in, so a reconnect to a legacy origin skips the probe (basic/versioning). */
const eraByOrigin = new Map<string, "modern" | "legacy">();

interface Exchange {
	/** The id the protocol client gave the request. */
	clientId: JsonRpcId;
	/** The id on the wire, which a re-issue changes. */
	wireId: JsonRpcId;
	method: string;
	body: Record<string, unknown>;
	modern: boolean;
	paramHeaders: McpSendOptions["paramHeaders"];
	controller: AbortController;
	/** The answer was delivered; ending the stream afterwards is not a break. */
	answered: boolean;
	/** The protocol client withdrew it, or the transport is closing. */
	withdrawn: boolean;
	reissued: boolean;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The code and message of a fetch rejection's underlying socket or TLS error. */
function fetchFailure(error: unknown): { code: string; message: string } {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
	const code = isRecord(cause) && typeof cause.code === "string" ? cause.code : "";
	return { code, message: errorText(cause) };
}

/** Read a body up to `cap` bytes; null when it is longer. */
async function readBounded(response: Response, cap: number): Promise<Buffer | null> {
	if (response.body === null) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks);
}

/**
 * Incremental `text/event-stream` parsing (WHATWG HTML 9.2.6) of the parts MCP
 * uses: `data` lines joined by newlines make one event, a blank line ends it,
 * and only events of the default `message` type carry JSON-RPC. Comments, `id`
 * and `retry` fields are ignored, since no stream is resumed.
 */
function createSseParser(cap: number): { push(chunk: Uint8Array): Buffer[] | "oversized" } {
	let carry = Buffer.alloc(0);
	let data: Buffer[] = [];
	let dataBytes = 0;
	let eventType = "";
	let sawData = false;
	let skipLf = false;
	const dispatch = (out: Buffer[]): void => {
		if (sawData && (eventType === "" || eventType === "message")) out.push(Buffer.concat(data));
		data = [];
		dataBytes = 0;
		eventType = "";
		sawData = false;
	};
	const line = (bytes: Buffer, out: Buffer[]): boolean => {
		if (bytes.length === 0) {
			dispatch(out);
			return true;
		}
		if (bytes[0] === 0x3a) return true;
		const colon = bytes.indexOf(0x3a);
		const field = (colon === -1 ? bytes : bytes.subarray(0, colon)).toString("utf8");
		let value = colon === -1 ? Buffer.alloc(0) : bytes.subarray(colon + 1);
		if (value[0] === 0x20) value = value.subarray(1);
		if (field === "data") {
			dataBytes += value.length + (sawData ? 1 : 0);
			if (dataBytes > cap) return false;
			if (sawData) data.push(Buffer.from("\n"));
			data.push(Buffer.from(value));
			sawData = true;
		} else if (field === "event") eventType = value.toString("utf8");
		return true;
	};
	return {
		push(chunk) {
			const out: Buffer[] = [];
			let buffer = carry.length === 0 ? Buffer.from(chunk) : Buffer.concat([carry, chunk]);
			if (skipLf && buffer[0] === 0x0a) buffer = buffer.subarray(1);
			skipLf = false;
			let start = 0;
			for (let index = 0; index < buffer.length; index++) {
				const byte = buffer[index];
				if (byte !== 0x0a && byte !== 0x0d) continue;
				if (!line(buffer.subarray(start, index), out)) return "oversized";
				if (byte === 0x0d) {
					if (index + 1 === buffer.length) skipLf = true;
					else if (buffer[index + 1] === 0x0a) index++;
				}
				start = index + 1;
			}
			carry = Buffer.from(buffer.subarray(start));
			if (carry.length > cap + 16) return "oversized";
			return out;
		},
	};
}

export function createMcpHttpTransport(
	spec: McpHttpServerSpec,
	options: McpHttpTransportOptions,
	events: McpTransportEvents,
): McpTransport {
	const endpoint = new URL(spec.url);
	const origin = mcpOriginOf(endpoint);
	const doFetch = options.fetch ?? globalThis.fetch;
	const retryDelays = DEFAULT_RETRY_DELAYS_MS;
	const credentialHeaders = Object.entries(spec.headers ?? {});
	const authorizer = spec.authorizer;
	/** The MCP address the latest request reached, after the same-origin redirects it followed. */
	let address = endpoint;
	/** Each credential, and the token after an auth scheme, as text a server could echo back. */
	const secrets = credentialHeaders
		.flatMap(([, value]) => [value.trim(), value.trim().split(/\s+/u).at(-1) ?? ""])
		.filter((value) => value.length >= 4)
		.sort((a, b) => b.length - a.length);
	for (const value of secrets) rememberResolvedSecret(value);
	/** The current Bearer token, scrubbed like a header credential from the first time it is sent. */
	const bearer = (): string | null => {
		if (authorizer === undefined) return null;
		const token = authorizer.token();
		if (token.length >= 4 && !secrets.includes(token)) {
			secrets.push(token);
			secrets.sort((a, b) => b.length - a.length);
			rememberResolvedSecret(token);
		}
		return token;
	};

	const exchanges = new Map<JsonRpcId, Exchange>();
	let isStarted = false;
	let stopped = false;
	let closePromise: Promise<McpTeardownOutcome> | null = null;
	let teardownOutcome: McpTeardownOutcome | null = null;
	let settled: { era: "modern" | "legacy"; protocolVersion: string } | null = null;
	let sessionId: string | null = null;
	let reissues = 0;

	const scrub = (text: string): string => {
		let out = text;
		for (const value of secrets) out = out.split(value).join("[redacted]");
		return out;
	};
	const scrubDeep = (value: unknown): unknown => {
		if (typeof value === "string") return scrub(value);
		if (Array.isArray(value)) return value.map(scrubDeep);
		if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item)]));
		return value;
	};

	const fatal = (error: McpError): void => {
		if (stopped) return;
		stopped = true;
		for (const exchange of exchanges.values()) {
			exchange.withdrawn = true;
			exchange.controller.abort();
		}
		exchanges.clear();
		events.fatal(new McpError(error.code, scrub(error.message), error.data), false);
	};

	const deliver = (frame: JsonRpcMessage): void => {
		if (stopped) return;
		if (frame.kind === "response" && frame.message.error !== undefined && secrets.length > 0) {
			frame.message.error = scrubDeep(frame.message.error) as JsonRpcErrorObject;
		}
		events.message(frame);
	};

	/** Answer a request with an error this transport makes up; the protocol client words it like any server error. */
	const failExchange = (exchange: Exchange, message: string): void => {
		if (exchange.answered || exchange.withdrawn) return;
		exchange.answered = true;
		exchanges.delete(exchange.clientId);
		deliver({
			kind: "response",
			message: { jsonrpc: "2.0", id: exchange.clientId, error: { code: HTTP_EXCHANGE_FAILED, message: scrub(message) } },
		});
	};

	/** Map a frame read on an exchange's stream back to the protocol client's ids. */
	const fromWire = (exchange: Exchange | null, frame: JsonRpcMessage): JsonRpcMessage => {
		if (exchange === null || exchange.wireId === exchange.clientId) return frame;
		if (frame.kind === "response" && frame.message.id === exchange.wireId) {
			return { kind: "response", message: { ...frame.message, id: exchange.clientId } };
		}
		if (frame.kind !== "notification" || !isRecord(frame.message.params)) return frame;
		const params = frame.message.params;
		if (frame.message.method === "notifications/cancelled" && params.requestId === exchange.wireId) {
			return { kind: "notification", message: { ...frame.message, params: { ...params, requestId: exchange.clientId } } };
		}
		if (isRecord(params._meta) && params._meta[MCP_META_SUBSCRIPTION_ID] === exchange.wireId) {
			const meta = { ...params._meta, [MCP_META_SUBSCRIPTION_ID]: exchange.clientId };
			return { kind: "notification", message: { ...frame.message, params: { ...params, _meta: meta } } };
		}
		return frame;
	};

	/** Deliver one inbound message; true once it was this exchange's answer. */
	const accept = (exchange: Exchange | null, parsed: JsonRpcMessage | McpError): boolean => {
		if (parsed instanceof McpError) {
			fatal(new McpError("protocol", `protocol error from mcp server ${spec.id}: ${parsed.message}`));
			return true;
		}
		const frame = fromWire(exchange, parsed);
		const isAnswer = exchange !== null && frame.kind === "response" && frame.message.id === exchange.clientId;
		if (isAnswer) {
			if (exchange.answered || exchange.withdrawn) return true;
			exchange.answered = true;
			exchanges.delete(exchange.clientId);
		}
		deliver(frame);
		return isAnswer;
	};

	const headersFor = (body: Record<string, unknown>, modern: boolean, exchange: Exchange | null): Headers => {
		const headers = new Headers();
		for (const [name, value] of credentialHeaders) headers.set(name, value);
		headers.set("Content-Type", "application/json");
		headers.set("Accept", ACCEPT);
		const method = typeof body.method === "string" ? body.method : null;
		const params = isRecord(body.params) ? body.params : undefined;
		if (modern) {
			const meta = isRecord(params?._meta) ? params._meta : {};
			const version = meta[MCP_META_PROTOCOL_VERSION];
			headers.set("MCP-Protocol-Version", typeof version === "string" ? version : (settled?.protocolVersion ?? ""));
			if (method !== null) {
				headers.set("Mcp-Method", method);
				const name = mcpNameSource(method, params);
				if (name !== null) headers.set("Mcp-Name", encodeMcpHeaderValue(name));
			}
			if (method === "tools/call" && exchange?.paramHeaders !== undefined) {
				for (const [name, value] of mcpParamHeaderValues(params?.arguments, exchange.paramHeaders)) {
					headers.set(name, value);
				}
			}
			return headers;
		}
		if (settled?.era === "legacy") headers.set("MCP-Protocol-Version", settled.protocolVersion);
		if (sessionId !== null) headers.set("Mcp-Session-Id", sessionId);
		return headers;
	};

	/**
	 * POST one body, following same-origin 307 and 308 redirects and retrying a
	 * connection the server never accepted. Null means the exchange ended
	 * without a response the caller should read: aborted, or already failed.
	 */
	const post = async (
		body: Record<string, unknown>,
		modern: boolean,
		exchange: Exchange | null,
		signal: AbortSignal,
	): Promise<Response | null | { broken: string }> => {
		const payload = JSON.stringify(body);
		let target = endpoint;
		let redirects = 0;
		let attempt = 0;
		let renewed = false;
		if (authorizer?.stale() === true) {
			renewed = true;
			await authorizer.renew(authorizer.token(), signal).catch(() => false);
		}
		for (;;) {
			if (stopped || signal.aborted) return null;
			let response: Response;
			const token = bearer();
			const headers = headersFor(body, modern, exchange);
			if (token !== null) headers.set("Authorization", `Bearer ${token}`);
			try {
				response = await doFetch(target, {
					method: "POST",
					headers,
					body: payload,
					redirect: "manual",
					signal,
				});
			} catch (error) {
				if (stopped || signal.aborted) return null;
				const failure = fetchFailure(error);
				if (TLS_FAILURE.test(failure.code)) {
					fatal(new McpError("closed", `cannot reach mcp server ${spec.id} at ${origin}: TLS failed (${failure.message})`));
					return null;
				}
				if (UNREACHED.has(failure.code)) {
					const delay = retryDelays[attempt];
					if (delay === undefined) {
						fatal(
							new McpError(
								"closed",
								`cannot reach mcp server ${spec.id} at ${origin} after ${attempt + 1} attempts: ${failure.message}`,
							),
						);
						return null;
					}
					attempt++;
					const waited = await new Promise<boolean>((resolve) => {
						if (signal.aborted) {
							resolve(false);
							return;
						}
						const onAbort = (): void => {
							clearTimeout(timer);
							resolve(false);
						};
						const timer = setTimeout(() => {
							signal.removeEventListener("abort", onAbort);
							resolve(true);
						}, delay);
						signal.addEventListener("abort", onAbort, { once: true });
					});
					if (!waited) return null;
					continue;
				}
				return { broken: failure.message };
			}
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => {});
				const location = response.headers.get("location");
				let next: URL | null = null;
				try {
					next = location === null ? null : new URL(location, target);
				} catch {
					next = null;
				}
				if (next === null || next.origin !== origin) {
					fatal(
						new McpError(
							"closed",
							`mcp server ${spec.id} answered HTTP ${response.status} with a redirect ${next === null ? "PanCode cannot read" : `to another origin, ${next.origin}`}; PanCode does not follow it, so its credentials stay with ${origin}`,
						),
					);
					return null;
				}
				if (authorizer !== undefined && !authorizer.covers(next)) {
					fatal(
						new McpError(
							"closed",
							`mcp server ${spec.id} redirected to ${next.origin}${next.pathname}, outside the resource its sign-in is for; PanCode does not send the token there`,
						),
					);
					return null;
				}
				if (response.status !== 307 && response.status !== 308) {
					fatal(
						new McpError(
							"closed",
							`mcp server ${spec.id} answered HTTP ${response.status}, a redirect that turns the POST into a GET; set its url to the endpoint itself`,
						),
					);
					return null;
				}
				if (++redirects > MAX_REDIRECTS) {
					fatal(new McpError("closed", `mcp server ${spec.id} redirected more than ${MAX_REDIRECTS} times`));
					return null;
				}
				target = next;
				address = next;
				continue;
			}
			// basic/authorization, Token Refresh: one renewal per request, then the 401 stands.
			if (response.status === 401 && authorizer !== undefined && token !== null && !renewed) {
				renewed = true;
				await response.body?.cancel().catch(() => {});
				let ready = false;
				try {
					ready = await authorizer.renew(token, signal);
				} catch {
					ready = false;
				}
				if (ready) continue;
				if (stopped || signal.aborted) return null;
				fatal(
					new McpError(
						"auth",
						`mcp server ${spec.id} at ${origin} no longer accepts PanCode's sign-in (HTTP 401) and it could not be renewed; sign in again with pancode mcp login ${spec.id}`,
						{ status: 401 },
					),
				);
				return null;
			}
			return response;
		}
	};

	/**
	 * Handle a status PanCode cannot carry on from; true when it ended the
	 * exchange. A server without header credentials is told to sign in; a
	 * 403 for scopes the last sign-in already asked for fails only the call.
	 */
	const refuseStatus = async (response: Response, exchange: Exchange | null): Promise<boolean> => {
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel().catch(() => {});
			const challenge = parseWwwAuthenticate(response.headers.get("www-authenticate"));
			const bearerChallenge = challenge?.scheme.toLowerCase() === "bearer" ? challenge : null;
			if (credentialHeaders.length === 0) {
				const scopes = mcpScopeList(bearerChallenge?.params.scope);
				const stepUp = response.status === 403 && bearerChallenge?.params.error === "insufficient_scope";
				if (stepUp && authorizer !== undefined) {
					const { permanent } = await authorizer.insufficientScope(scopes);
					if (permanent && exchange !== null) {
						failExchange(
							exchange,
							`mcp server ${spec.id} needs scope ${scopes.join(" ") || "(unnamed)"} for ${exchange.method}, which the last sign-in already asked for and was not granted; PanCode does not ask again`,
						);
						return true;
					}
				}
				const reason = stepUp
					? `needs more access${scopes.length > 0 ? ` (scope ${scopes.join(" ")})` : ""} than PanCode's sign-in grants (HTTP 403); sign in again with pancode mcp login ${spec.id}, which asks for it`
					: authorizer !== undefined
						? `refused PanCode's sign-in (HTTP ${response.status}); sign in again with pancode mcp login ${spec.id}`
						: `needs sign-in (HTTP ${response.status}); sign in with pancode mcp login ${spec.id}`;
				fatal(
					new McpError("auth", `mcp server ${spec.id} at ${origin} ${reason}`, {
						status: response.status,
						...(challenge !== null ? { challenge } : {}),
					}),
				);
				return true;
			}
			const why = response.status === 401 ? "refused PanCode's credentials" : "refused access with its credentials";
			fatal(
				new McpError(
					"auth",
					`mcp server ${spec.id} at ${origin} ${why} (HTTP ${response.status}); the operator stores its credentials with pancode mcp login ${spec.id}`,
					{ status: response.status, ...(challenge !== null ? { challenge } : {}) },
				),
			);
			return true;
		}
		if (response.status === 404 && sessionId !== null) {
			sessionId = null;
			await response.body?.cancel().catch(() => {});
			fatal(
				new McpError("closed", `mcp server ${spec.id} ended its session (HTTP 404); the next call starts a new session`),
			);
			return true;
		}
		return false;
	};

	const reissue = (exchange: Exchange, why: string): void => {
		if (exchange.answered || exchange.withdrawn || stopped) return;
		if (!exchange.modern || exchange.reissued) {
			failExchange(exchange, `the HTTP exchange with mcp server ${spec.id} broke before it answered: ${why}`);
			return;
		}
		// basic/transports/streamable-http: a request whose stream broke is sent
		// again under a new id, since no stream is resumed in the modern era.
		exchange.reissued = true;
		exchange.wireId = `pancode-reissue-${++reissues}`;
		exchange.body = { ...exchange.body, id: exchange.wireId };
		exchange.controller = new AbortController();
		void run(exchange);
	};

	/** Read a 2xx body; true once the exchange's answer arrived. */
	const readAnswer = async (exchange: Exchange | null, response: Response): Promise<boolean> => {
		const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
		if (type === "text/event-stream" && response.body !== null) {
			const parser = createSseParser(options.maxMessageBytes);
			const reader = response.body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return false;
					const events = parser.push(value);
					if (events === "oversized") {
						fatal(
							new McpError(
								"protocol",
								`protocol error from mcp server ${spec.id}: an event exceeds the ${options.maxMessageBytes}-byte message cap`,
							),
						);
						return true;
					}
					for (const data of events) {
						if (data.length === 0) continue;
						if (accept(exchange, parseJsonRpcLine(data))) {
							await reader.cancel().catch(() => {});
							return true;
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
		}
		const body = await readBounded(response, options.maxMessageBytes);
		if (body === null) {
			fatal(
				new McpError(
					"protocol",
					`protocol error from mcp server ${spec.id}: a response exceeds the ${options.maxMessageBytes}-byte message cap`,
				),
			);
			return true;
		}
		if (body.toString("utf8").trim().length === 0) return false;
		return accept(exchange, parseJsonRpcLine(body));
	};

	/** The answer an error status carries: its JSON-RPC error when the body is one, else the status itself. */
	const answerFromStatus = async (exchange: Exchange, response: Response): Promise<void> => {
		const body = await readBounded(response, options.maxMessageBytes).catch(() => null);
		const parsed = body === null ? null : parseJsonRpcLine(body);
		if (parsed !== null && !(parsed instanceof McpError) && parsed.kind === "response" && parsed.message.error) {
			if (exchange.answered || exchange.withdrawn) return;
			exchange.answered = true;
			exchanges.delete(exchange.clientId);
			deliver({ kind: "response", message: { ...parsed.message, id: exchange.clientId } });
			return;
		}
		const text = body === null ? "" : boundedExternalDiagnostic(scrub(body.toString("utf8")), ERROR_BODY_BYTES);
		const detail = text.replace(/\s+/gu, " ").trim();
		failExchange(
			exchange,
			`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${detail ? `: ${detail}` : ""}`,
		);
	};

	const run = async (exchange: Exchange): Promise<void> => {
		const { signal } = exchange.controller;
		let response: Response | null | { broken: string };
		try {
			response = await post(exchange.body, exchange.modern, exchange, signal);
		} catch (error) {
			response = { broken: errorText(error) };
		}
		if (response === null) return;
		if (!(response instanceof Response)) {
			reissue(exchange, response.broken);
			return;
		}
		if (exchange.method === "initialize" && response.ok) {
			const id = response.headers.get("mcp-session-id");
			if (id !== null) {
				if (!SESSION_ID.test(id)) {
					fatal(new McpError("protocol", `mcp server ${spec.id} set a session id that is not visible ASCII`));
					return;
				}
				sessionId = id;
			}
		}
		if (await refuseStatus(response, exchange)) return;
		if (!response.ok) {
			await answerFromStatus(exchange, response);
			return;
		}
		if (response.status === 202 || response.status === 204) {
			failExchange(
				exchange,
				`mcp server ${spec.id} accepted ${exchange.method} (HTTP ${response.status}) without answering it`,
			);
			return;
		}
		let answered: boolean;
		try {
			answered = await readAnswer(exchange, response);
		} catch (error) {
			if (stopped || exchange.withdrawn || exchange.answered) return;
			reissue(exchange, errorText(error));
			return;
		}
		if (!answered) reissue(exchange, "the response ended without an answer");
	};

	/** POST a notification or an answer to a server request; the 202 carries nothing back. */
	const postOneWay = async (
		body: Record<string, unknown>,
		modern: boolean,
		sendOptions: McpSendOptions,
	): Promise<void> => {
		const controller = new AbortController();
		let response: Response | null | { broken: string };
		try {
			response = await post(body, modern, null, controller.signal);
		} catch (error) {
			response = { broken: errorText(error) };
		}
		if (response === null) return;
		if (!(response instanceof Response)) {
			sendOptions.onError?.(new Error(scrub(response.broken)));
			return;
		}
		if (await refuseStatus(response, null)) return;
		sendOptions.onSent?.();
		if (response.ok && response.status !== 202 && response.status !== 204) {
			await readAnswer(null, response).catch(() => {});
			return;
		}
		await response.body?.cancel().catch(() => {});
	};

	const isModernShaped = (body: Record<string, unknown>): boolean => {
		if (settled !== null) return settled.era === "modern";
		const params = body.params;
		return isRecord(params) && isRecord(params._meta) && typeof params._meta[MCP_META_PROTOCOL_VERSION] === "string";
	};

	const send = (message: McpOutboundMessage, sendOptions: McpSendOptions = {}): McpSendOutcome => {
		const body = message as unknown as Record<string, unknown>;
		const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
		if (bytes > options.maxOutboundBytes) return { kind: "oversized", bytes, cap: options.maxOutboundBytes };
		if (stopped) {
			queueMicrotask(() => sendOptions.onError?.(new Error(`mcp server ${spec.id} is closed`)));
			return { kind: "queued" };
		}
		const isRequest = "method" in message && "id" in message;
		const method = "method" in message ? message.method : null;
		if (method === "notifications/cancelled" && isRecord(body.params)) {
			const target = exchanges.get(body.params.requestId as JsonRpcId);
			// basic/transports/streamable-http: a modern request is cancelled by
			// ending its HTTP exchange; there is no cancellation message to send.
			if (target?.modern === true || settled?.era === "modern") {
				if (target !== undefined) {
					target.withdrawn = true;
					exchanges.delete(target.clientId);
					target.controller.abort();
				}
				queueMicrotask(() => sendOptions.onSent?.());
				return { kind: "queued" };
			}
		}
		const modern = isModernShaped(body);
		if (!isRequest || method === null) {
			void postOneWay(body, modern, sendOptions);
			return { kind: "queued" };
		}
		const clientId = (message as { id: JsonRpcId }).id;
		const exchange: Exchange = {
			clientId,
			wireId: clientId,
			method,
			body,
			modern,
			paramHeaders: sendOptions.paramHeaders,
			controller: new AbortController(),
			answered: false,
			withdrawn: false,
			reissued: false,
		};
		exchanges.set(clientId, exchange);
		// The body leaves with the POST; the client's cancellation path needs it marked sent.
		queueMicrotask(() => sendOptions.onSent?.());
		void run(exchange);
		return { kind: "queued" };
	};

	const withdraw = (requestId: number): void => {
		const exchange = exchanges.get(requestId);
		if (exchange === undefined) return;
		exchanges.delete(requestId);
		exchange.withdrawn = true;
		exchange.controller.abort();
	};

	const endSession = async (): Promise<void> => {
		if (sessionId === null) return;
		const headers = new Headers();
		for (const [name, value] of credentialHeaders) headers.set(name, value);
		const token = bearer();
		if (token !== null) headers.set("Authorization", `Bearer ${token}`);
		headers.set("Mcp-Session-Id", sessionId);
		if (settled?.era === "legacy") headers.set("MCP-Protocol-Version", settled.protocolVersion);
		sessionId = null;
		try {
			const response = await doFetch(endpoint, {
				method: "DELETE",
				headers,
				redirect: "manual",
				signal: AbortSignal.timeout(Math.max(1, options.teardownBoundMs)),
			});
			await response.body?.cancel().catch(() => {});
		} catch {
			// A server that cannot be reached, or refuses DELETE with 405, ends the session itself.
		}
	};

	const close = (): Promise<McpTeardownOutcome> => {
		closePromise ??= (async () => {
			stopped = true;
			for (const exchange of exchanges.values()) {
				exchange.withdrawn = true;
				exchange.controller.abort();
			}
			exchanges.clear();
			if (isStarted) await endSession();
			teardownOutcome = { complete: true };
			return teardownOutcome;
		})();
		return closePromise;
	};

	const http: McpHttpBinding = {
		cachedEra: () => eraByOrigin.get(origin) ?? null,
		settleEra: (era, protocolVersion) => {
			settled = { era, protocolVersion };
			eraByOrigin.set(origin, era);
		},
		forgetEra: () => {
			eraByOrigin.delete(origin);
		},
		address: () => new URL(address.href),
		credentialOrigin: () => (authorizer !== undefined ? new URL(authorizer.resource()).origin : address.origin),
		authorization: async (signal) => {
			if (authorizer !== undefined) {
				if (authorizer.stale()) {
					await authorizer.renew(authorizer.token(), signal ?? new AbortController().signal).catch(() => false);
				}
				const token = bearer();
				return token === null ? null : `Bearer ${token}`;
			}
			const header = credentialHeaders.find(([name]) => name.toLowerCase() === "authorization");
			return header === undefined ? null : header[1];
		},
	};

	return {
		pid: undefined,
		http,
		start: async () => {
			isStarted = true;
			return true;
		},
		started: () => isStarted,
		endReported: () => null,
		send,
		withdraw,
		close,
		killOwnedOnExit: () => {
			stopped = true;
			for (const exchange of exchanges.values()) exchange.controller.abort();
			exchanges.clear();
		},
		teardown: () => teardownOutcome,
		stderrTail: () => "",
	};
}
