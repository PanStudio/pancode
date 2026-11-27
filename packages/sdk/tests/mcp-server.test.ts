// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { MAX_FRAME_BYTES, serveStdio } from "../src/mcp-server/index.js";
import { defineServer, defineTool, policyManifest, type ToolServer, type ToolSpec } from "../src/tool/index.js";

/**
 * `@pancode/sdk/tool` and `@pancode/sdk/mcp-server`: a defined server served
 * over in-memory stdio, framed and answered the way PanCode's MCP client
 * expects.
 */

interface Frame {
	jsonrpc: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
}

function serve(server: ToolServer) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let written = "";
	let tail = "";
	let errText = "";
	const frames: Frame[] = [];
	let wake: () => void = () => {};
	stdout.setEncoding("utf8");
	stdout.on("data", (chunk: string) => {
		written += chunk;
		const lines = (tail + chunk).split("\n");
		tail = lines.pop() ?? "";
		for (const line of lines) frames.push(JSON.parse(line) as Frame);
		wake();
	});
	stderr.setEncoding("utf8");
	stderr.on("data", (chunk: string) => {
		errText += chunk;
	});
	const served = serveStdio(server, { stdin, stdout, stderr });
	const waitFor = async (match: (frame: Frame) => boolean): Promise<Frame> => {
		for (;;) {
			const found = frames.find(match);
			if (found !== undefined) return found;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	};
	let nextId = 1;
	const request = (method: string, params?: unknown, id: string | number = nextId++): Promise<Frame> => {
		stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
		return waitFor((frame) => frame.id === id);
	};
	const notify = (method: string, params?: unknown): void => {
		stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`);
	};
	return {
		frames,
		request,
		notify,
		waitFor,
		stderr: () => errText,
		/** Every byte written to stdout, unparsed. */
		stdout: () => written,
		writeLine: (line: string) => stdin.write(`${line}\n`),
		async initialize(): Promise<Frame> {
			const answer = await request("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "0" },
			});
			notify("notifications/initialized");
			return answer;
		},
		async close(): Promise<void> {
			stdin.end();
			await served;
		},
	};
}

const echo = defineTool({
	name: "echo",
	title: "Echo",
	description: "Echo the text back.",
	input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	actionClass: "read",
	idempotent: true,
	run: (args: { text: string }) => ({ text: args.text }),
});

const writeNote = defineTool({
	name: "write_note",
	description: "Write a note to a file.",
	input: {
		type: "object",
		properties: { path: { type: "string" }, body: { type: "string" }, count: { type: "integer" } },
		required: ["path"],
	},
	actionClass: "execute",
	pathArguments: { path: "write" },
	run: (args: { path: string }) => ({ json: { wrote: args.path } }),
});

test("initialize, tools/list and tools/call round trip with annotations and the policy _meta", async () => {
	const client = serve(defineServer({ id: "sample", version: "1.2.3", title: "Sample", tools: [echo, writeNote] }));
	const init = await client.initialize();
	assert.deepEqual(init.result, {
		protocolVersion: "2025-06-18",
		capabilities: { tools: {} },
		serverInfo: { name: "sample", version: "1.2.3", title: "Sample" },
	});
	const listed = await client.request("tools/list", {});
	assert.equal(listed.result?.nextCursor, undefined);
	assert.deepEqual(listed.result?.tools, [
		{
			name: "echo",
			title: "Echo",
			description: "Echo the text back.",
			inputSchema: echo.input,
			annotations: {
				title: "Echo",
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			_meta: { "dev.pancode/policy": { actionClass: "read", pathArguments: {} } },
		},
		{
			name: "write_note",
			description: "Write a note to a file.",
			inputSchema: writeNote.input,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
			_meta: { "dev.pancode/policy": { actionClass: "execute", pathArguments: { path: "write" } } },
		},
	]);
	const echoed = await client.request("tools/call", { name: "echo", arguments: { text: "hi" } });
	assert.deepEqual(echoed.result, { content: [{ type: "text", text: "hi" }] });
	const wrote = await client.request("tools/call", { name: "write_note", arguments: { path: "a.txt" } });
	assert.deepEqual(wrote.result, {
		content: [{ type: "text", text: '{"wrote":"a.txt"}' }],
		structuredContent: { wrote: "a.txt" },
	});
	await client.close();
});

test("a request with the 2026-07-28 _meta is served statelessly beside a legacy session, with progress", async () => {
	const counted = defineTool({
		name: "counted",
		description: "Counts to three.",
		input: { type: "object" },
		output: { type: "array", items: { type: "integer" } },
		actionClass: "read",
		run: (_args, { progress }) => {
			progress(1, 3, "one");
			progress(1, 3);
			progress(3, 3);
			return { json: [1, 2, 3] };
		},
	});
	const client = serve(
		defineServer({ id: "modern", version: "1", title: "Modern", instructions: "Counts.", tools: [counted] }),
	);
	const meta = {
		"io.modelcontextprotocol/protocolVersion": "2026-07-28",
		"io.modelcontextprotocol/clientCapabilities": {},
	};
	const serverInfo = { "io.modelcontextprotocol/serverInfo": { name: "modern", version: "1", title: "Modern" } };
	const discover = await client.request("server/discover", { _meta: meta });
	assert.deepEqual(discover.result, {
		resultType: "complete",
		supportedVersions: ["2026-07-28"],
		capabilities: { tools: {} },
		instructions: "Counts.",
		ttlMs: 3_600_000,
		cacheScope: "public",
		_meta: serverInfo,
	});
	const listed = await client.request("tools/list", { _meta: meta });
	assert.equal(listed.result?.resultType, "complete");
	assert.equal(listed.result?.cacheScope, "public");
	assert.deepEqual((listed.result?.tools as Array<Record<string, unknown>>)[0]?.outputSchema, counted.output);
	const called = await client.request("tools/call", {
		name: "counted",
		arguments: {},
		_meta: { ...meta, progressToken: "p1" },
	});
	assert.deepEqual(called.result, {
		resultType: "complete",
		content: [{ type: "text", text: "[1,2,3]" }],
		structuredContent: [1, 2, 3],
		_meta: serverInfo,
	});
	assert.deepEqual(
		client.frames.filter((frame) => frame.method === "notifications/progress").map((frame) => frame.params),
		[
			{ progressToken: "p1", progress: 1, total: 3, message: "one" },
			{ progressToken: "p1", progress: 3, total: 3 },
		],
	);
	const noCapabilities = await client.request("tools/list", {
		_meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
	});
	assert.equal(noCapabilities.error?.code, -32602);
	const future = await client.request("tools/list", {
		_meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
	});
	assert.deepEqual(future.error, {
		code: -32022,
		message: "Unsupported protocol version",
		data: { supported: ["2026-07-28"], requested: "2099-01-01" },
	});
	assert.equal((await client.request("ping", { _meta: meta })).error?.code, -32601);
	// A legacy session on the same process: initialize, then the legacy shapes.
	const init = await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
	assert.equal(init.result?.protocolVersion, "2025-11-25");
	assert.equal(init.result?.instructions, "Counts.");
	const legacyList = await client.request("tools/list", {});
	assert.equal((legacyList.result?.tools as Array<Record<string, unknown>>)[0]?.outputSchema, undefined);
	const legacyCall = await client.request("tools/call", { name: "counted", arguments: {} });
	assert.deepEqual(legacyCall.result, { content: [{ type: "text", text: "[1,2,3]" }] });
	assert.equal((await client.request("tools/list", { _meta: meta })).result?.resultType, "complete");
	await client.close();
});

test("a tool that throws or returns an error is a tool error, and the server answers the next request", async () => {
	const tools: Array<ToolSpec<never>> = [
		{
			name: "boom",
			description: "Throws.",
			input: { type: "object" },
			actionClass: "read",
			run: () => {
				throw new Error("disk on fire");
			},
		},
		{
			name: "boom_value",
			description: "Throws a non-Error.",
			input: { type: "object" },
			actionClass: "read",
			run: async () => {
				throw 42;
			},
		},
		{
			name: "refuse",
			description: "Returns an error.",
			input: { type: "object" },
			actionClass: "read",
			run: () => ({ error: "not today" }),
		},
	];
	const client = serve(defineServer({ id: "errors", version: "1", tools }));
	await client.initialize();
	const thrown = await client.request("tools/call", { name: "boom", arguments: {} });
	assert.deepEqual(thrown.result, { content: [{ type: "text", text: "disk on fire" }], isError: true });
	const thrownValue = await client.request("tools/call", { name: "boom_value" });
	assert.deepEqual(thrownValue.result, { content: [{ type: "text", text: "42" }], isError: true });
	const refused = await client.request("tools/call", { name: "refuse", arguments: {} });
	assert.deepEqual(refused.result, { content: [{ type: "text", text: "not today" }], isError: true });
	assert.deepEqual((await client.request("ping")).result, {});
	await client.close();
	assert.match(client.stderr(), /boom failed: disk on fire/);
});

test("a cancelled call's signal aborts and no response is written for it", async () => {
	let aborted: (reason: unknown) => void = () => {};
	const sawAbort = new Promise<unknown>((resolve) => {
		aborted = resolve;
	});
	const slow = defineTool({
		name: "slow",
		description: "Waits for cancellation.",
		input: { type: "object" },
		actionClass: "read",
		run: (_args, { signal }) =>
			new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted(signal.reason);
					resolve({ text: "finished after cancellation" });
				});
			}),
	});
	const client = serve(defineServer({ id: "cancel", version: "1", tools: [slow, echo] }));
	await client.initialize();
	void client.request("tools/call", { name: "slow", arguments: {} }, "slow-1");
	const concurrent = await client.request("tools/call", { name: "echo", arguments: { text: "meanwhile" } });
	assert.deepEqual(concurrent.result, { content: [{ type: "text", text: "meanwhile" }] });
	client.notify("notifications/cancelled", { requestId: "slow-1", reason: "operator stopped it" });
	const reason = await sawAbort;
	assert.match(reason instanceof Error ? reason.message : String(reason), /operator stopped it/);
	await setImmediate();
	assert.deepEqual((await client.request("ping")).result, {});
	await client.close();
	assert.equal(
		client.frames.some((frame) => frame.id === "slow-1"),
		false,
	);
});

test("bad arguments are tool errors; an unknown tool and an unknown method answer JSON-RPC errors", async () => {
	const client = serve(defineServer({ id: "errors", version: "1", tools: [writeNote] }));
	// Without initialize or the modern _meta, a request has no revision to be served by.
	const early = await client.request("tools/list", {});
	assert.equal(early.error?.code, -32602);
	const discover = await client.request("server/discover", {});
	assert.equal(discover.error?.code, -32602);
	await client.initialize();
	const missing = await client.request("tools/call", { name: "write_note", arguments: { body: "x" } });
	assert.deepEqual(missing.result, {
		content: [{ type: "text", text: "write_note: missing required argument path" }],
		isError: true,
	});
	const wrongType = await client.request("tools/call", { name: "write_note", arguments: { path: 7 } });
	assert.equal(wrongType.result?.isError, true);
	assert.match(JSON.stringify(wrongType.result?.content), /argument path must be string/);
	const wrongInteger = await client.request("tools/call", {
		name: "write_note",
		arguments: { path: "a", count: 1.5 },
	});
	assert.equal(wrongInteger.result?.isError, true);
	const notObject = await client.request("tools/call", { name: "write_note", arguments: ["a"] });
	assert.equal(notObject.error?.code, -32602);
	const unknownTool = await client.request("tools/call", { name: "nope", arguments: {} });
	assert.equal(unknownTool.error?.code, -32602);
	assert.match(unknownTool.error?.message ?? "", /unknown tool: nope/);
	const unknownMethod = await client.request("resources/list", {});
	assert.equal(unknownMethod.error?.code, -32601);
	await client.close();
});

test("a malformed or oversized line answers a parse error and the next valid line is served", async () => {
	const client = serve(defineServer({ id: "parse", version: "1", tools: [echo] }));
	await client.initialize();
	client.writeLine("{not json");
	const parseError = await client.waitFor((frame) => frame.error?.code === -32700);
	assert.equal(parseError.id, null);
	assert.deepEqual((await client.request("ping")).result, {});
	client.writeLine(`{"jsonrpc":"2.0","id":"big","method":"ping","pad":"${"x".repeat(MAX_FRAME_BYTES)}"}`);
	const oversized = await client.waitFor((frame) => /exceeds/.test(frame.error?.message ?? ""));
	assert.equal(oversized.error?.code, -32700);
	assert.equal(oversized.id, null);
	const echoed = await client.request("tools/call", { name: "echo", arguments: { text: "still here" } });
	assert.deepEqual(echoed.result, { content: [{ type: "text", text: "still here" }] });
	await client.close();
	assert.equal(
		client.frames.some((frame) => frame.id === "big"),
		false,
	);
});

test("defineTool and defineServer reject a bad definition when it is made", () => {
	const base = {
		name: "tool",
		description: "A tool.",
		input: { type: "object", properties: { path: { type: "string" }, n: { type: "number" } } },
		run: () => ({ text: "" }),
	} as const;
	assert.throws(() => defineTool({ ...base, actionClass: "write" as never }), /actionClass "write" does not exist/);
	assert.throws(
		() => defineTool({ ...base, actionClass: "execute", readOnly: true }),
		/readOnly may be true only for a "read" tool/,
	);
	assert.throws(
		() => defineTool({ ...base, actionClass: "execute", pathArguments: { file: "write" } }),
		/pathArguments\.file names no property of input/,
	);
	assert.throws(
		() => defineTool({ ...base, actionClass: "execute", pathArguments: { n: "read" } }),
		/pathArguments\.n names input property n, which is not a string/,
	);
	const tool = defineTool({ ...base, actionClass: "read" });
	assert.throws(() => defineServer({ id: "dup", version: "1", tools: [tool, tool] }), /two tools named tool/);
	assert.throws(() => defineServer({ id: "Bad Id", version: "1", tools: [tool] }), /server id must match/);
	assert.throws(() => defineServer({ id: "a".repeat(33), version: "1", tools: [tool] }), /server id exceeds 32/);
});

test("context.log and a stray console.log in run never reach the stdout stream", async () => {
	const chatty = defineTool({
		name: "chatty",
		description: "Logs.",
		input: { type: "object" },
		actionClass: "read",
		run: (_args, { log }) => {
			log("diagnostic for stderr");
			console.log("stray console output");
			return { text: "ok" };
		},
	});
	const client = serve(defineServer({ id: "chatty", version: "1", tools: [chatty] }));
	await client.initialize();
	const answer = await client.request("tools/call", { name: "chatty", arguments: {} });
	assert.deepEqual(answer.result, { content: [{ type: "text", text: "ok" }] });
	await client.close();
	assert.match(client.stderr(), /chatty: diagnostic for stderr/);
	const stdout = client.stdout();
	assert.ok(stdout.endsWith("\n"));
	for (const line of stdout.slice(0, -1).split("\n")) {
		const frame = JSON.parse(line) as Frame;
		assert.equal(frame.jsonrpc, "2.0");
		assert.ok(Object.hasOwn(frame, "id"));
	}
	assert.doesNotMatch(stdout, /diagnostic for stderr|stray console output/);
});

test("policyManifest is plain JSON sorted by tool name and stable across tool order", () => {
	const destroy = defineTool({
		name: "destroy",
		description: "Deletes.",
		input: { type: "object", properties: { target: { type: "string" }, source: { type: "string" } } },
		actionClass: "destructive",
		pathArguments: { target: "write", source: "read" },
		run: () => ({ text: "" }),
	});
	const forward = policyManifest(defineServer({ id: "sample", version: "2.0.0", tools: [writeNote, echo, destroy] }));
	const reverse = policyManifest(defineServer({ id: "sample", version: "2.0.0", tools: [destroy, echo, writeNote] }));
	assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
	assert.equal(
		JSON.stringify(forward),
		JSON.stringify({
			id: "sample",
			version: "2.0.0",
			tools: [
				{
					name: "destroy",
					actionClass: "destructive",
					readOnly: false,
					idempotent: false,
					openWorld: false,
					pathArguments: { source: "read", target: "write" },
				},
				{ name: "echo", actionClass: "read", readOnly: true, idempotent: true, openWorld: false, pathArguments: {} },
				{
					name: "write_note",
					actionClass: "execute",
					readOnly: false,
					idempotent: false,
					openWorld: false,
					pathArguments: { path: "write" },
				},
			],
		}),
	);
});
