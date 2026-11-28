// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * In-process mock OpenAI-compatible provider for smoke tests that drive the
 * built binary against a fake fleet endpoint, plus the settings.yaml seeders
 * that point a scratch config at it. Extracted from cli.test.ts so any
 * binary-driving test can reuse the same fixture.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export async function closeServer(server: Server | null): Promise<void> {
	if (!server) return;
	// undici keeps idle keep-alive sockets open after a 404 (a residency probe
	// that fell through /api/v1/models), and close() waits for them.
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		// Pi's Codex adapter zstd-compresses its request bodies when the runtime can.
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			resolve((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(body) : body).toString("utf8"));
		});
	});
}

/**
 * Scripts one OpenAI `tool_calls` round trip out of the fixture. The first
 * streaming completion of a turn answers with a single function tool call and
 * `finish_reason:"tool_calls"`; every completion that already carries a tool
 * result answers with the fixture's plain text reply, so a turn always
 * terminates after exactly one tool call no matter how the agent loop is
 * scheduled.
 */
export interface OpenAICompatToolCallScript {
	/** Tool name the model asks for. */
	name: string;
	/** Arguments object; serialized into the `function.arguments` delta verbatim. */
	arguments: Record<string, unknown>;
	/** Wire id for the call. Defaults to `call-pancode-tool-1`. */
	id?: string;
	/** Sent as the `function.arguments` string instead of `arguments`, so a test can send malformed JSON. */
	rawArguments?: string;
	/** Reply text streamed in the same response, before the call. */
	text?: string;
}

export interface OpenAICompatFixtureOptions {
	models?: Array<Record<string, unknown> & { id: string }>;
	/** Explicit wire usage for accounting regressions; defaults retain existing fixtures. */
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		prompt_tokens_details?: { cached_tokens: number };
		completion_tokens_details?: { reasoning_tokens: number };
	};
	/** Fail the first streaming requests before following the normal script. */
	initialErrors?: { count: number; status: number; message: string };
	/** Split a text reply into provider-visible SSE deltas for pacing/ordering tests. */
	replyChunks?: readonly string[];
	/** Optional deterministic delay between text chunks. */
	chunkDelayMs?: number;
	/** Delay response headers for each streaming request; omitted entries have no delay. */
	responseHeaderDelaysMs?: readonly number[];
	/**
	 * When set, answer the tool-free completion of every turn with this tool
	 * call instead of text. Absent, the fixture behaves exactly as before.
	 * A function is asked on every streaming request, tool exchange or not,
	 * so a script can drive a multi-step turn (dispatch, then artifact) and
	 * answer a worker's conversation differently from the main agent's.
	 * Returning null falls through to the text reply.
	 */
	toolCall?: OpenAICompatToolCallScript | ((request: Record<string, unknown>) => OpenAICompatToolCallScript | null);
	/**
	 * Reasoning text streamed before the reply, one SSE delta per chunk, under
	 * `reasoningField`. LM Studio spells the field `reasoning` for gpt-oss and
	 * `reasoning_content` for the rest; llama.cpp always `reasoning_content`.
	 */
	reasoningChunks?: readonly string[];
	reasoningField?: "reasoning" | "reasoning_content" | "reasoning_text";
}

/** True once a request's message history carries a tool result or a tool call. */
export function hasToolExchange(request: Record<string, unknown>): boolean {
	const messages = request.messages;
	if (!Array.isArray(messages)) return false;
	return messages.some((message) => {
		if (typeof message !== "object" || message === null) return false;
		const record = message as Record<string, unknown>;
		if (record.role === "tool") return true;
		return Array.isArray(record.tool_calls) && record.tool_calls.length > 0;
	});
}

export interface OpenAICompatFixture {
	server: Server;
	url: string;
	requests: Array<Record<string, unknown>>;
}

/**
 * Start a mock OpenAI-compat server that answers `GET /v1/models` and both
 * streaming and non-streaming `POST /v1/chat/completions` with a fixed reply,
 * recording every chat request for assertions. Listens on an ephemeral port.
 */
export async function startOpenAICompatFixture(
	reply: string | ((request: Record<string, unknown>) => string),
	options: OpenAICompatFixtureOptions = {},
): Promise<OpenAICompatFixture> {
	const models = options.models ?? [{ id: "mock-model", object: "model" }];
	const requests: Array<Record<string, unknown>> = [];
	let streamingRequests = 0;
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: models }));
			return;
		}
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const raw = await readRequestBody(req);
		const request = JSON.parse(raw) as Record<string, unknown>;
		requests.push(request);
		const responseText = typeof reply === "function" ? reply(request) : reply;
		if (request.stream === false) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "chatcmpl-pancode-probe",
					object: "chat.completion",
					model: request.model ?? "mock-model",
					choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
				}),
			);
			return;
		}
		streamingRequests += 1;
		if (options.initialErrors !== undefined && streamingRequests <= options.initialErrors.count) {
			res.writeHead(options.initialErrors.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: options.initialErrors.message, type: "fixture_error" } }));
			return;
		}
		const headerDelayMs = options.responseHeaderDelaysMs?.[streamingRequests - 1] ?? 0;
		if (headerDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, headerDelayMs));
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const script =
			typeof options.toolCall === "function"
				? options.toolCall(request)
				: options.toolCall !== undefined && !hasToolExchange(request)
					? options.toolCall
					: null;
		if (script !== null) {
			if (script.text !== undefined)
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-pancode-tool",
						object: "chat.completion.chunk",
						created: 1,
						model: "mock-model",
						choices: [{ index: 0, delta: { role: "assistant", content: script.text } }],
					})}\n\n`,
				);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-pancode-tool",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: script.id ?? "call-pancode-tool-1",
										type: "function",
										function: { name: script.name, arguments: script.rawArguments ?? JSON.stringify(script.arguments) },
									},
								],
							},
						},
					],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-pancode-tool",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					usage: options.usage ?? { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
			return;
		}
		for (const chunk of options.reasoningChunks ?? []) {
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-pancode-print",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: { [options.reasoningField ?? "reasoning_content"]: chunk } }],
				})}\n\n`,
			);
		}
		const replyChunks = options.replyChunks ?? [responseText];
		for (let index = 0; index < replyChunks.length; index += 1) {
			const chunk = replyChunks[index] ?? "";
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-pancode-print",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-model",
					choices: [{ index: 0, delta: { content: chunk } }],
				})}\n\n`,
			);
			if ((options.chunkDelayMs ?? 0) > 0 && index + 1 < replyChunks.length) {
				await new Promise<void>((resolve) => setTimeout(resolve, options.chunkDelayMs));
			}
		}
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-pancode-print",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: options.usage ?? { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${addr.port}`, requests };
}

export type SettingsDocument = Record<string, unknown>;
export type Section = Record<string, unknown>;

/**
 * Edit a scratch settings.yaml as a document, so a seed sets its keys whether the file holds the short scaffold a new
 * home starts with or a full set of sections.
 */
export function editSettingsFile(path: string, change: (settings: SettingsDocument) => void): void {
	const settings = (parseYaml(readFileSync(path, "utf8")) ?? {}) as SettingsDocument;
	change(settings);
	writeFileSync(path, stringifyYaml(settings), "utf8");
}

function editSettings(configDir: string, change: (settings: SettingsDocument) => void): void {
	editSettingsFile(join(configDir, "settings.yaml"), change);
}

/** A settings section as an object, created when the file leaves it out. */
export function section(settings: SettingsDocument, key: string): Section {
	const existing = settings[key];
	if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) return existing as Section;
	const created: Section = {};
	settings[key] = created;
	return created;
}

function mockChatTarget(url: string, capabilities: Section): Section {
	return {
		id: "mock-chat",
		runtime: "openai-compat",
		url,
		defaultModel: "mock-model",
		auth: { apiKeyEnvVar: "PANCODE_TEST_OPENAI_KEY" },
		capabilities,
		wireModels: ["mock-model"],
	};
}

const TOOL_CAPABILITIES: Section = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	vision: true,
	contextWindow: 32768,
	maxTokens: 4096,
};

export function seedOpenAICompatOrchestrator(configDir: string, url: string): void {
	editSettings(configDir, (settings) => {
		settings.targets = [mockChatTarget(url, { vision: true })];
		Object.assign(section(settings, "chat"), { target: "mock-chat", model: "mock-model" });
	});
}

/**
 * The orchestrator seed above plus the capability keys a tool-calling turn
 * needs, and an optional saved autonomy level written to `safety.autonomy`
 * (tests/contracts/tool-orchestrator-seed.test.ts pins that the level reaches the session).
 */
export function seedOpenAICompatToolOrchestrator(configDir: string, url: string, autonomy?: string): void {
	editSettings(configDir, (settings) => {
		settings.targets = [mockChatTarget(url, { ...TOOL_CAPABILITIES })];
		Object.assign(section(settings, "chat"), { target: "mock-chat", model: "mock-model" });
		if (autonomy !== undefined) section(settings, "safety").autonomy = autonomy;
	});
}

export function seedOpenAICompatFleetDefault(configDir: string): void {
	editSettings(configDir, (settings) => {
		const fleet = section(settings, "fleet");
		Object.assign(section(fleet, "default"), { target: "mock-chat", model: "mock-model" });
		const targets = Array.isArray(settings.targets) ? (settings.targets as Section[]) : [];
		const chat = targets.find((target) => target.id === "mock-chat");
		if (chat)
			chat.capabilities = { chat: true, tools: true, toolCallFormat: "openai", ...(chat.capabilities as Section) };
	});
}
