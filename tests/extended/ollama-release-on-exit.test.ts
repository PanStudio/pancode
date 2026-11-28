// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import { closeServer, editSettingsFile, readRequestBody, section } from "../harness/openai-compat-fixture.js";

const MODEL = "fixture:latest";
const RUN_DEADLINE_HOLD = new URL("../fixtures/run-deadline-hold.mjs", import.meta.url).href;

interface OllamaFixture {
	server: Server;
	url: string;
	resident: Set<string>;
	/** Every `/api/generate` body, which is the only way Ollama releases a model. */
	releases: Array<{ model: string; keep_alive: unknown }>;
	chats: number;
}

/**
 * A recording Ollama server. `stallChat` answers the first chat with a tool
 * call; the chat after the tool result, which proves the run parsed a response
 * and so owns the model it loaded, gets one chunk, writes the file
 * `stallChat` names and then holds the stream open, so a run is mid-turn when
 * it is stopped. `hangRelease` accepts the release request and never answers it.
 */
async function ollamaFixture(options: { stallChat?: string; hangRelease?: boolean } = {}): Promise<OllamaFixture> {
	const state = { chats: 0 };
	const resident = new Set<string>();
	const releases: OllamaFixture["releases"] = [];
	const server = createServer(async (req, res) => {
		const raw = req.method === "POST" ? await readRequestBody(req) : "";
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/ps") {
			res.end(JSON.stringify({ models: [...resident].map((model) => ({ model, name: model })) }));
			return;
		}
		if (req.url === "/api/tags") {
			res.end(JSON.stringify({ models: [{ model: MODEL, name: MODEL }] }));
			return;
		}
		if (req.url === "/api/version") {
			res.end(JSON.stringify({ version: "0.34.0" }));
			return;
		}
		if (req.url === "/api/show") {
			res.end(
				JSON.stringify({
					capabilities: options.stallChat === undefined ? ["completion"] : ["completion", "tools"],
					model_info: { "general.architecture": "fixture", "fixture.context_length": 32768 },
				}),
			);
			return;
		}
		if (req.url === "/api/generate") {
			const body = JSON.parse(raw) as { model: string; keep_alive: unknown };
			releases.push({ model: body.model, keep_alive: body.keep_alive });
			if (options.hangRelease) return;
			resident.delete(body.model);
			res.end(JSON.stringify({ done: true }));
			return;
		}
		if (req.url === "/api/chat") {
			const body = JSON.parse(raw) as { model: string; messages: Array<{ role: string }> };
			state.chats += 1;
			resident.add(body.model);
			if (options.stallChat !== undefined && !body.messages.some((message) => message.role === "tool")) {
				const call = { function: { name: "ls", arguments: { path: "." } } };
				const message = { role: "assistant", content: "", tool_calls: [call] };
				res.end(`${JSON.stringify({ model: body.model, message, done: true, done_reason: "stop" })}\n`);
				return;
			}
			const chunk = { model: body.model, message: { role: "assistant", content: "hello" }, done: false };
			res.write(`${JSON.stringify(chunk)}\n`);
			if (options.stallChat !== undefined) {
				writeFileSync(options.stallChat, "");
				return;
			}
			res.end(
				`${JSON.stringify({ model: body.model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 2 })}\n`,
			);
			return;
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ error: "not found" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		server,
		url,
		resident,
		releases,
		get chats() {
			return state.chats;
		},
	};
}

function seedOllamaOrchestrator(configDir: string, url: string): void {
	editSettingsFile(join(configDir, "settings.yaml"), (settings) => {
		settings.connections = [{ id: "local-ollama", runtime: "ollama", url, defaultModel: MODEL }];
		Object.assign(section(settings, "chat"), { connection: "local-ollama", model: MODEL });
	});
}

describe("pancode run releases the Ollama models it loaded on exit (#379)", () => {
	const servers: Server[] = [];
	const scratches: HeadlessScratch[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => closeServer(server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	function scratchHome(): HeadlessScratch {
		const scratch = headlessScratch("pancode-ollama-release-");
		scratches.push(scratch);
		return scratch;
	}

	/** `deadlineSignal` holds a --timeout deadline until that file exists (tests/fixtures/run-deadline-hold.mjs). */
	async function headlessRun(
		fixture: OllamaFixture,
		flags: ReadonlyArray<string> = [],
		scratch = scratchHome(),
		deadlineSignal?: string,
	) {
		servers.push(fixture.server);
		seedOllamaOrchestrator(scratch.configDir, fixture.url);
		const project = join(scratch.root, "project");
		mkdirSync(project);
		return runCli(["--no-context-files", "--no-skills", "run", ...flags, "say hello"], {
			env: deadlineSignal === undefined ? scratch.env : { ...scratch.env, RUN_DEADLINE_SIGNAL: deadlineSignal },
			cwd: project,
			timeoutMs: 60_000,
			...(deadlineSignal === undefined ? {} : { node: ["--import", RUN_DEADLINE_HOLD] }),
		});
	}

	it("sends keep_alive 0 for a model the run loaded", async () => {
		const fixture = await ollamaFixture();
		const turn = await headlessRun(fixture);
		strictEqual(turn.code, 0, turn.stderr);
		ok(fixture.chats >= 1, "the run must have reached the model");
		deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
		strictEqual(fixture.resident.has(MODEL), false);
	});

	it("leaves a model that was already resident before the run", async () => {
		const fixture = await ollamaFixture();
		fixture.resident.add(MODEL);
		const turn = await headlessRun(fixture);
		strictEqual(turn.code, 0, turn.stderr);
		ok(fixture.chats >= 1, "the run must have reached the model");
		deepStrictEqual(fixture.releases, []);
		strictEqual(fixture.resident.has(MODEL), true);
	});

	it("releases on a --timeout exit and keeps exit 124", async () => {
		// The budget counts from process start, and boot on a loaded host can spend 2s before any model loads; the
		// deadline waits for the stalled second chat, so the run always times out owning the model it loaded.
		const scratch = scratchHome();
		const stalled = join(scratch.root, "chat-stalled");
		const fixture = await ollamaFixture({ stallChat: stalled });
		const turn = await headlessRun(fixture, ["--timeout", "2"], scratch, stalled);
		ok(existsSync(`${stalled}.held`), "the preload must hold the run deadline");
		strictEqual(turn.code, 124, turn.stderr);
		strictEqual(fixture.chats, 2);
		deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
	});

	it("keeps the exit code when the release hangs", async () => {
		const fixture = await ollamaFixture({ hangRelease: true });
		const turn = await headlessRun(fixture);
		strictEqual(turn.code, 0, turn.stderr);
		deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
	});
});

const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "dist", "cli", "index.js");

/** Minimal ACP stdio client: requests in order, updates ignored. */
function acpClient(child: ChildProcessWithoutNullStreams) {
	let buffer = "";
	let stderr = "";
	let nextId = 1;
	const pending = new Map<number, (frame: Record<string, unknown>) => void>();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (text: string) => {
		stderr += text;
	});
	child.stdout.on("data", (text: string) => {
		buffer += text;
		for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const frame = JSON.parse(line) as Record<string, unknown>;
			if (typeof frame.id === "number" && ("result" in frame || "error" in frame)) pending.get(frame.id)?.(frame);
		}
	});
	const exit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
	return {
		exit,
		stderr: () => stderr,
		request<T>(method: string, params: unknown): Promise<T> {
			const id = nextId++;
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr=${stderr}`)), 30_000);
				pending.set(id, (frame) => {
					clearTimeout(timer);
					if (frame.error) reject(new Error(`${method} failed: ${JSON.stringify(frame.error)}`));
					else resolve(frame.result as T);
				});
			});
		},
	};
}

describe("pancode acp releases the Ollama models it loaded on exit (#379)", () => {
	const servers: Server[] = [];
	const scratches: HeadlessScratch[] = [];
	const children: ChildProcessWithoutNullStreams[] = [];
	afterEach(async () => {
		for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
		await Promise.all(servers.splice(0).map((server) => closeServer(server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	async function promptedSession(fixture: OllamaFixture) {
		servers.push(fixture.server);
		const scratch = headlessScratch("pancode-ollama-acp-release-");
		scratches.push(scratch);
		seedOllamaOrchestrator(scratch.configDir, fixture.url);
		const project = join(scratch.root, "project");
		mkdirSync(project);
		const child = spawn(process.execPath, [CLI, "--no-context-files", "--no-skills", "acp", "--cwd", project], {
			cwd: scratch.root,
			env: scratch.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);
		const client = acpClient(child);
		await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "release-test", version: "1" } });
		const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
		const turn = await client.request<{ stopReason: string }>("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "say hello" }],
		});
		strictEqual(turn.stopReason, "end_turn", client.stderr());
		ok(fixture.chats >= 1, "the session must have reached the model");
		return { child, client };
	}

	it("releases a model the session loaded when the client closes stdin", async () => {
		const fixture = await ollamaFixture();
		const { child, client } = await promptedSession(fixture);
		child.stdin.end();
		strictEqual(await client.exit, 0, client.stderr());
		deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
	});

	it("releases a model the session loaded on SIGTERM", async () => {
		const fixture = await ollamaFixture();
		const { child, client } = await promptedSession(fixture);
		child.kill("SIGTERM");
		await client.exit;
		deepStrictEqual(fixture.releases, [{ model: MODEL, keep_alive: 0 }]);
	});
});
