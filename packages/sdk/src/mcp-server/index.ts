// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A stdio MCP server for a server made with `defineServer`.
 *
 * The transport is newline-delimited JSON-RPC 2.0: one message per line on
 * stdin, one per line on stdout. Nothing but protocol frames is ever written
 * to stdout; `context.log` and every diagnostic go to stderr. While the server
 * runs on the process's own stdout, the global `console` writes to stderr too,
 * so a stray `console.log` in a tool cannot corrupt the stream.
 *
 * The server answers `initialize`, `ping`, `tools/list` and `tools/call`, and
 * reads the `notifications/initialized` and `notifications/cancelled`
 * notifications. It offers no resources, prompts, sampling or logging.
 *
 * The annotations and `_meta` policy each listed tool carries are hints to the
 * host. PanCode decides a tool's class from the operator's approval or from
 * policy it ships, never from what a running server reports.
 */
import { Console } from "node:console";
import type { Readable, Writable } from "node:stream";
import type { AnyTool, JsonSchema, ToolInputSchema, ToolServer } from "../tool/index.js";

/** MCP revisions this server speaks, newest first. A client asking for another gets the newest. */
export const MCP_PROTOCOL_VERSIONS: ReadonlyArray<string> = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** The largest inbound line the server reads; a longer one is refused with a parse error. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** The `_meta` key under which each listed tool carries its declared policy. */
export const POLICY_META_KEY = "dev.pancode/policy";

/** JSON-RPC error codes the server answers with. `serverNotInitialized` is implementation-defined. */
export const JSON_RPC_ERROR = Object.freeze({
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
	serverNotInitialized: -32002,
});

export interface ServeStdioOptions {
	/** Defaults to `process.stdin`. */
	stdin?: Readable;
	/** Defaults to `process.stdout`. Receives protocol frames only. */
	stdout?: Writable;
	/** Defaults to `process.stderr`. Receives `context.log` lines and diagnostics. */
	stderr?: Writable;
}

type RequestId = string | number;

interface ResponseFrame {
	jsonrpc: "2.0";
	id: RequestId | null;
	result?: unknown;
	error?: { code: number; message: string };
}

interface CallResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: true;
}

interface InFlightCall {
	controller: AbortController;
	cancelled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function idKey(id: RequestId): string {
	return `${typeof id}:${id}`;
}

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	try {
		return String(err);
	} catch {
		return "tool threw a value that cannot be converted to a string";
	}
}

function schemaTypes(schema: JsonSchema | undefined): string[] {
	if (schema === undefined) return [];
	if (typeof schema.type === "string") return [schema.type];
	return Array.isArray(schema.type) ? schema.type.filter((entry): entry is string => typeof entry === "string") : [];
}

function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		default:
			return true;
	}
}

function jsonTypeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && Number.isInteger(value)) return "integer";
	return typeof value;
}

/** Required properties and top-level types only; deeper validation belongs to the tool's `run`. */
function checkArguments(input: ToolInputSchema, args: Record<string, unknown>): string | null {
	for (const name of input.required ?? []) {
		if (!Object.hasOwn(args, name) || args[name] === undefined) return `missing required argument ${name}`;
	}
	const properties = input.properties ?? {};
	for (const [name, value] of Object.entries(args)) {
		if (!Object.hasOwn(properties, name)) continue;
		const types = schemaTypes(properties[name]);
		if (types.length === 0 || types.some((type) => matchesType(type, value))) continue;
		return `argument ${name} must be ${types.join(" or ")}, not ${jsonTypeOf(value)}`;
	}
	return null;
}

function describeTool(tool: AnyTool): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.input,
		annotations: {
			readOnlyHint: tool.readOnly,
			destructiveHint: tool.actionClass === "destructive",
			idempotentHint: tool.idempotent,
		},
		_meta: { [POLICY_META_KEY]: { actionClass: tool.actionClass, pathArguments: { ...tool.pathArguments } } },
	};
}

/**
 * The `tools/list` entry `serveStdio` serves for `tool`. A host that ships a
 * server's policy reads `inputSchema` and `annotations` from here, so what it
 * pins is exactly what the running server lists.
 */
export { describeTool as listedTool };

function errorResult(message: string): CallResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function toCallResult(result: unknown): CallResult {
	if (isRecord(result)) {
		if (typeof result.error === "string") return errorResult(result.error);
		if (typeof result.text === "string") return { content: [{ type: "text", text: result.text }] };
		if (Object.hasOwn(result, "json")) {
			const text = JSON.stringify(result.json) ?? "null";
			const parsed: unknown = JSON.parse(text);
			return { content: [{ type: "text", text }], ...(isRecord(parsed) ? { structuredContent: parsed } : {}) };
		}
	}
	return errorResult("tool returned an invalid result; run must return { text }, { json } or { error }");
}

/**
 * Serve `server` over MCP stdio. Resolves once stdin has ended and every call
 * still in flight has answered; a call the client cancelled is not waited for.
 */
export function serveStdio(server: ToolServer, options: ServeStdioOptions = {}): Promise<void> {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const tools = new Map<string, AnyTool>(server.tools.map((tool) => [tool.name, tool]));
	const listed = server.tools.map(describeTool);
	const inFlight = new Map<string, InFlightCall>();
	let initialized = false;
	let inputEnded = false;
	let stdoutBroken = false;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let discarding = false;

	const diagnose = (message: string): void => {
		try {
			stderr.write(`${server.id}: ${message}\n`);
		} catch {
			// stderr is gone; there is nowhere left to report.
		}
	};

	const send = (frame: ResponseFrame): void => {
		if (stdoutBroken) return;
		let line: string;
		try {
			line = `${JSON.stringify(frame)}\n`;
		} catch (err) {
			line = `${JSON.stringify({
				jsonrpc: "2.0",
				id: frame.id,
				error: { code: JSON_RPC_ERROR.internalError, message: `response not serializable: ${messageOf(err)}` },
			})}\n`;
		}
		try {
			stdout.write(line);
		} catch (err) {
			stdoutBroken = true;
			diagnose(`stdout write failed: ${messageOf(err)}`);
		}
	};
	const reply = (id: RequestId, result: unknown): void => send({ jsonrpc: "2.0", id, result });
	const refuse = (id: RequestId | null, code: number, message: string): void =>
		send({ jsonrpc: "2.0", id, error: { code, message } });

	const runCall = async (tool: AnyTool, args: Record<string, unknown>, signal: AbortSignal): Promise<CallResult> => {
		const log = (message: string): void => {
			diagnose(`${tool.name}: ${String(message)}`);
		};
		try {
			return toCallResult(await tool.run(args as never, { signal, log }));
		} catch (err) {
			const message = messageOf(err);
			diagnose(`${tool.name} failed: ${message}`);
			return errorResult(message);
		}
	};

	const call = (id: RequestId, params: unknown) => {
		if (!isRecord(params) || typeof params.name !== "string") {
			return refuse(id, JSON_RPC_ERROR.invalidParams, "tools/call params must name a tool");
		}
		const tool = tools.get(params.name);
		if (tool === undefined) return refuse(id, JSON_RPC_ERROR.invalidParams, `unknown tool: ${params.name}`);
		const args = params.arguments === undefined ? {} : params.arguments;
		if (!isRecord(args)) return refuse(id, JSON_RPC_ERROR.invalidParams, `${tool.name}: arguments must be an object`);
		const problem = checkArguments(tool.input, args);
		if (problem !== null) return refuse(id, JSON_RPC_ERROR.invalidParams, `${tool.name}: ${problem}`);
		const key = idKey(id);
		if (inFlight.has(key)) {
			return refuse(id, JSON_RPC_ERROR.invalidRequest, `request id ${JSON.stringify(id)} is already in flight`);
		}
		const entry: InFlightCall = { controller: new AbortController(), cancelled: false };
		inFlight.set(key, entry);
		void runCall(tool, args, entry.controller.signal).then((result) => {
			if (!entry.cancelled) reply(id, result);
			if (inFlight.get(key) === entry) inFlight.delete(key);
			maybeFinish();
		});
	};

	const initializeResult = (params: unknown): Record<string, unknown> => {
		const requested = isRecord(params) ? params.protocolVersion : undefined;
		const protocolVersion =
			typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
		return {
			protocolVersion,
			capabilities: { tools: {} },
			serverInfo: {
				name: server.id,
				version: server.version,
				...(server.title !== undefined ? { title: server.title } : {}),
			},
		};
	};

	const handleRequest = (id: RequestId, method: string, params: unknown) => {
		switch (method) {
			case "initialize":
				initialized = true;
				return reply(id, initializeResult(params));
			case "ping":
				return reply(id, {});
			case "tools/list":
			case "tools/call":
				if (!initialized) {
					return refuse(id, JSON_RPC_ERROR.serverNotInitialized, `${method} before initialize`);
				}
				return method === "tools/list" ? reply(id, { tools: listed }) : call(id, params);
			default:
				return refuse(id, JSON_RPC_ERROR.methodNotFound, `method not found: ${method}`);
		}
	};

	const handleNotification = (method: string, params: unknown) => {
		if (method !== "notifications/cancelled" || !isRecord(params) || !isRequestId(params.requestId)) return;
		const key = idKey(params.requestId);
		const entry = inFlight.get(key);
		if (entry === undefined) return;
		entry.cancelled = true;
		inFlight.delete(key);
		const reason = typeof params.reason === "string" && params.reason.length > 0 ? `: ${params.reason}` : "";
		entry.controller.abort(new Error(`cancelled by the client${reason}`));
		maybeFinish();
	};

	const handleMessage = (value: unknown) => {
		if (!isRecord(value)) {
			const what = Array.isArray(value) ? "batch messages are not supported" : "message is not a JSON object";
			return refuse(null, JSON_RPC_ERROR.invalidRequest, what);
		}
		const id = isRequestId(value.id) ? value.id : null;
		if (value.jsonrpc !== "2.0") return refuse(id, JSON_RPC_ERROR.invalidRequest, 'message lacks jsonrpc: "2.0"');
		if (typeof value.method !== "string") {
			// A response: this server sends no requests, so there is nothing to match it to.
			if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) return;
			return refuse(id, JSON_RPC_ERROR.invalidRequest, "message has no method");
		}
		if (value.id === undefined || value.id === null) return handleNotification(value.method, value.params);
		if (id === null) {
			return refuse(null, JSON_RPC_ERROR.invalidRequest, "request id must be a string or a finite number");
		}
		handleRequest(id, value.method, value.params);
	};

	const decoder = new TextDecoder("utf-8", { fatal: true });
	const handleLine = (raw: Buffer) => {
		const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
		let text: string;
		try {
			text = decoder.decode(line);
		} catch {
			return refuse(null, JSON_RPC_ERROR.parseError, "parse error: line is not valid UTF-8");
		}
		if (text.trim().length === 0) return;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (err) {
			return refuse(null, JSON_RPC_ERROR.parseError, `parse error: ${messageOf(err)}`);
		}
		handleMessage(value);
	};

	const refuseOversize = (): void => {
		pending = [];
		pendingBytes = 0;
		refuse(null, JSON_RPC_ERROR.parseError, `parse error: message line exceeds ${MAX_FRAME_BYTES} bytes`);
	};

	const onData = (chunk: Buffer | string): void => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		let start = 0;
		for (;;) {
			const newline = bytes.indexOf(0x0a, start);
			if (newline === -1) break;
			const tail = bytes.subarray(start, newline);
			start = newline + 1;
			if (discarding) {
				discarding = false;
				continue;
			}
			if (pendingBytes + tail.length > MAX_FRAME_BYTES) {
				refuseOversize();
				continue;
			}
			const line = pending.length === 0 ? tail : Buffer.concat([...pending, tail]);
			pending = [];
			pendingBytes = 0;
			handleLine(line);
		}
		if (start >= bytes.length || discarding) return;
		const rest = bytes.subarray(start);
		if (pendingBytes + rest.length > MAX_FRAME_BYTES) {
			// Refuse as soon as the cap is passed and drop the rest of the line, so a flood cannot grow the buffer.
			refuseOversize();
			discarding = true;
			return;
		}
		pending.push(Buffer.from(rest));
		pendingBytes += rest.length;
	};

	const onStdoutError = (err: unknown): void => {
		stdoutBroken = true;
		diagnose(`stdout failed: ${messageOf(err)}`);
	};

	const originalConsole = globalThis.console;
	const quietConsole = stdout === process.stdout ? new Console({ stdout: stderr, stderr }) : null;
	if (quietConsole !== null) globalThis.console = quietConsole;

	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let finished = false;
	function maybeFinish(): void {
		if (finished || !inputEnded || inFlight.size > 0) return;
		finished = true;
		stdin.off("data", onData);
		stdin.off("end", onEnd);
		stdin.off("close", onEnd);
		stdin.off("error", onInputError);
		stdout.off("error", onStdoutError);
		if (quietConsole !== null && globalThis.console === quietConsole) globalThis.console = originalConsole;
		finish();
	}
	function onEnd(): void {
		if (inputEnded) return;
		inputEnded = true;
		if (!discarding && pendingBytes > 0) {
			const line = Buffer.concat(pending, pendingBytes);
			pending = [];
			pendingBytes = 0;
			handleLine(line);
		}
		maybeFinish();
	}
	function onInputError(err: unknown): void {
		diagnose(`stdin failed: ${messageOf(err)}`);
		onEnd();
	}

	stdout.on("error", onStdoutError);
	stdin.on("error", onInputError);
	stdin.on("end", onEnd);
	stdin.on("close", onEnd);
	stdin.on("data", onData);
	return done;
}
