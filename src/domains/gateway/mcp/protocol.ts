// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * JSON-RPC 2.0 framing for the MCP stdio transport.
 *
 * The transport carries one JSON message per line: UTF-8 text, newline
 * terminated, with no embedded newline. Everything here is pure: the framer
 * accepts byte chunks and yields typed messages or one typed protocol error,
 * and the client decides what to do with either. Invalid UTF-8 is a protocol
 * error rather than a U+FFFD substitution, because a tool result that reached
 * the model with silently replaced bytes would misreport what the server said.
 */

import { isRecord } from "../../../core/type-guards.js";

/** The legacy revision PanCode offers in the initialize handshake. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
/** The oldest legacy revision a server may answer initialize with; anything outside this range is refused. */
export const MCP_OLDEST_PROTOCOL_VERSION = "2024-11-05";
/**
 * The modern revision: no handshake, and every request carries its version,
 * client identity and client capabilities in `_meta`. A server is spoken to in
 * this revision only when a `server/discover` probe lists it.
 */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
/** Extension id of MCP Tasks (modelcontextprotocol/ext-tasks, specification 2026-07-28). */
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const MCP_META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
/** Tags every notification of one `subscriptions/listen` stream with the id of the listen request. */
export const MCP_META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
/**
 * One stdio message line's bound. It holds a `resources/read` of the largest
 * file a skill may have (16 MiB, io.modelcontextprotocol/skills) as base64
 * inside its JSON-RPC envelope.
 */
export const DEFAULT_MAX_LINE_BYTES = 24 * 1024 * 1024;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
/** Legacy resource-not-found; the modern revision answers -32602 instead. */
export const MCP_RESOURCE_NOT_FOUND = -32002;
/** Modern-era error: the request needs a client capability it did not declare, named in `data.requiredCapabilities`. */
export const MCP_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
/** Modern-era error: the server does not serve the requested revision, and names the ones it does. */
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type McpErrorCode = "timeout" | "closed" | "protocol" | "server" | "spawn" | "aborted" | "overload";

/**
 * Every failure the client reports carries one of the codes above. `overload`
 * names an outbound line the client refused to queue: on its own because it
 * exceeds the cap, or fatally because the server stopped reading its stdin.
 */
export class McpError extends Error {
	override readonly name = "McpError";
	readonly code: McpErrorCode;
	readonly data: unknown;

	constructor(code: McpErrorCode, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: unknown;
	error?: JsonRpcErrorObject;
}

export type JsonRpcMessage =
	| { kind: "request"; message: JsonRpcRequest }
	| { kind: "notification"; message: JsonRpcNotification }
	| { kind: "response"; message: JsonRpcResponse };

export type ProtocolFrame = { kind: "message"; message: JsonRpcMessage } | { kind: "error"; error: McpError };

function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

// Transport-only metadata cannot be supplied by a server field. The result
// object remains the key until its pending request reaches the tool decoder.
const structuredJson = new WeakMap<object, string>();

export function structuredContentJson(result: object): string | undefined {
	return structuredJson.get(result);
}

/** Classify one decoded JSON value as a request, notification, or response, or name why it is none of them. */
export function classifyJsonRpcMessage(value: unknown): JsonRpcMessage | McpError {
	if (!isRecord(value)) return new McpError("protocol", "message is not a JSON object");
	if (value.jsonrpc !== "2.0") return new McpError("protocol", 'message lacks jsonrpc: "2.0"');
	if (typeof value.method === "string") {
		if (value.id === undefined || value.id === null) {
			const notification: JsonRpcNotification = { jsonrpc: "2.0", method: value.method };
			if (value.params !== undefined) notification.params = value.params;
			return { kind: "notification", message: notification };
		}
		if (!isJsonRpcId(value.id)) return new McpError("protocol", "request id must be a string or a finite number");
		const request: JsonRpcRequest = { jsonrpc: "2.0", id: value.id, method: value.method };
		if (value.params !== undefined) request.params = value.params;
		return { kind: "request", message: request };
	}
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	if (!hasResult && !hasError) return new McpError("protocol", "message has neither method, result, nor error");
	if (hasResult && hasError) return new McpError("protocol", "response carries both result and error");
	if (value.id !== null && !isJsonRpcId(value.id)) {
		return new McpError("protocol", "response id must be a string, a finite number, or null");
	}
	const response: JsonRpcResponse = {
		jsonrpc: "2.0",
		id: value.id === undefined ? null : (value.id as JsonRpcId | null),
	};
	if (hasResult) response.result = value.result;
	if (hasError) {
		const error = value.error;
		if (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") {
			return new McpError("protocol", "response error must carry a numeric code and a message");
		}
		const errorObject: JsonRpcErrorObject = { code: error.code, message: error.message };
		if (error.data !== undefined) errorObject.data = error.data;
		response.error = errorObject;
	}
	return { kind: "response", message: response };
}

/**
 * Canonical decimal form of a JSON number literal (sign, trimmed significant
 * digits, decimal exponent) so pure notation differences like 0.0, 1.0, 2.50,
 * or 1e5 compare equal to JS's shortest round-trip serialization.
 */
function canonicalDecimal(literal: string): string | null {
	const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(literal);
	if (match === null) return null;
	const intDigits = match[2] ?? "";
	const fracDigits = match[3] ?? "";
	let digits = (intDigits + fracDigits).replace(/^0+/u, "");
	if (digits.length === 0) return "0";
	const rawExp = Number(match[4] ?? "0");
	if (!Number.isSafeInteger(rawExp)) return null;
	let exponent = rawExp - fracDigits.length;
	const trimmed = digits.replace(/0+$/u, "");
	exponent += digits.length - trimmed.length;
	digits = trimmed;
	return `${match[1] === "-" ? "-" : ""}${digits}e${exponent}`;
}

/**
 * True when storing a JSON number token as a plain JS number would lose value
 * or sign (overflow, underflow, -0, unsafe integers, >17 significant digits, or
 * inexact decimals), not when only the notation differs (e.g. 0.0, 1.0, 2.50).
 */
function needsNumericLiteralTag(source: string, value: number): boolean {
	if (!Number.isFinite(value) || Object.is(value, -0)) return true;
	const canonical = canonicalDecimal(source);
	if (canonical === null) return true;
	if (value === 0) return canonical !== "0";
	return canonical !== canonicalDecimal(String(value));
}

/** Decode one complete line (without its terminator) into a message or a protocol error. */
export function parseJsonRpcLine(line: Buffer): JsonRpcMessage | McpError {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(line);
	} catch {
		return new McpError("protocol", "message line is not valid UTF-8");
	}
	let parsed: unknown;
	try {
		// Node >=22.19 supports source-aware revivers and rawJSON. Keep numeric
		// source tokens without changing protocol IDs, schemas, or other fields.
		const sources = new WeakMap<object, Map<string, string>>();
		parsed = JSON.parse(text, function (this: object, key: string, value: unknown, context?: { source: string }) {
			if (typeof value === "number") {
				if (context?.source === undefined) throw new Error("JSON numeric source tokens are unavailable");
				let entries = sources.get(this);
				if (entries === undefined) {
					entries = new Map();
					sources.set(this, entries);
				}
				entries.set(key, context.source);
			}
			return value;
		}) as unknown;
		// A completed task carries its tool result one level down (`tasks/get`
		// result.result), and that result needs the same exact numeric evidence.
		const toolResult = !isRecord(parsed)
			? undefined
			: isRecord(parsed.result) && parsed.result.status === "completed" && isRecord(parsed.result.result)
				? parsed.result.result
				: parsed.result;
		// structuredContent may be any JSON value (2026-07-28 server/tools), so a
		// bare number at the top keeps its token the same way a nested one does.
		if (isRecord(toolResult) && Object.hasOwn(toolResult, "structuredContent")) {
			const content = toolResult.structuredContent;
			const topSource = sources.get(toolResult)?.get("structuredContent");
			// The replacer sees a top-level scalar under key "" of a wrapper the reviver never saw.
			const sourceOf = (holder: object, key: string, value: unknown): string | undefined =>
				sources.get(holder)?.get(key) ??
				(key === "" && typeof value === "number" && !sources.has(holder) ? topSource : undefined);
			// ES2022 typings predate this supported Node runtime API. No custom
			// tokenizer is needed, and the existing incoming-line cap bounds it.
			const rawJSON = (JSON as JSON & { rawJSON(source: string): unknown }).rawJSON;
			const exact = JSON.stringify(content, function (this: object, key: string, value: unknown) {
				const source = sourceOf(this, key, value);
				return source === undefined ? value : rawJSON(source);
			});
			// Plain JSON evidence must survive cloning and serialization as well.
			// Tag only tokens whose numeric value or sign JS cannot hold without loss,
			// keeping ordinary floats such as 0.0, 1.0, or 2.50 as plain numbers.
			toolResult.structuredContent = JSON.parse(
				JSON.stringify(content, function (this: object, key: string, value: unknown) {
					const source = sourceOf(this, key, value);
					return source !== undefined && typeof value === "number" && needsNumericLiteralTag(source, value)
						? { $literal: source }
						: value;
				}),
			) as unknown;
			structuredJson.set(toolResult, exact);
		}
	} catch (error) {
		return new McpError(
			"protocol",
			`message line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return classifyJsonRpcMessage(parsed);
}

/** Serialize one outbound message as a newline-terminated line. JSON.stringify escapes every newline inside strings. */
export function encodeJsonRpcMessage(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): Buffer {
	return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export interface LineFramer {
	/** Accept one chunk and return every frame it completed. After an error frame the framer yields nothing more. */
	push(chunk: Buffer): ProtocolFrame[];
	/** Flush a final unterminated line at end of stream. */
	flush(): ProtocolFrame[];
	/** Bytes held for the line still being assembled. */
	readonly pendingBytes: number;
	/** True once an error frame has been produced. */
	readonly failed: boolean;
}

/**
 * Split a byte stream into newline-delimited messages. A line longer than the
 * cap is refused as soon as its bytes exceed it, before any newline arrives,
 * so an unterminated flood cannot grow the buffer without bound. Blank lines
 * are skipped; a trailing carriage return is tolerated.
 */
export function createLineFramer(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES): LineFramer {
	const pending: Buffer[] = [];
	let pendingBytes = 0;
	let failed = false;

	const fail = (message: string): ProtocolFrame[] => {
		failed = true;
		pending.length = 0;
		pendingBytes = 0;
		return [{ kind: "error", error: new McpError("protocol", message) }];
	};

	const frameLine = (line: Buffer): ProtocolFrame | null => {
		const trimmed = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
		if (trimmed.length === 0) return null;
		const decoded = parseJsonRpcLine(trimmed);
		if (decoded instanceof McpError) return { kind: "error", error: decoded };
		return { kind: "message", message: decoded };
	};

	return {
		get pendingBytes() {
			return pendingBytes;
		},
		get failed() {
			return failed;
		},
		push(chunk) {
			if (failed) return [];
			const frames: ProtocolFrame[] = [];
			let start = 0;
			for (;;) {
				const newline = chunk.indexOf(0x0a, start);
				if (newline === -1) break;
				const tail = chunk.subarray(start, newline);
				const lineBytes = pendingBytes + tail.length;
				if (lineBytes > maxLineBytes) return fail(`message line exceeds ${maxLineBytes} bytes`);
				const line = pending.length === 0 ? tail : Buffer.concat([...pending, tail], lineBytes);
				pending.length = 0;
				pendingBytes = 0;
				const frame = frameLine(line);
				if (frame !== null) {
					frames.push(frame);
					if (frame.kind === "error") {
						failed = true;
						return frames;
					}
				}
				start = newline + 1;
			}
			if (start < chunk.length) {
				const rest = chunk.subarray(start);
				if (pendingBytes + rest.length > maxLineBytes) {
					frames.push(...fail(`message line exceeds ${maxLineBytes} bytes`));
					return frames;
				}
				pending.push(Buffer.from(rest));
				pendingBytes += rest.length;
			}
			return frames;
		},
		flush() {
			if (failed || pendingBytes === 0) return [];
			const line = Buffer.concat(pending, pendingBytes);
			pending.length = 0;
			pendingBytes = 0;
			const frame = frameLine(line);
			if (frame === null) return [];
			if (frame.kind === "error") failed = true;
			return [frame];
		},
	};
}
