// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// A constructed MCP server over stdio for the store reference tests: one
// JSON-RPC message per line, plain Node, no dependencies. It reads and writes
// the paths its arguments name, and appends each tool it is called with to
// calls.log in its working directory, so a test can tell a call the gateway
// refused from one the server received.
import { appendFileSync, copyFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const write = (message) => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
const text = (value, isError = false) => ({
	content: [{ type: "text", text: value }],
	...(isError ? { isError } : {}),
});

const TOOLS = [
	{
		name: "copy_file",
		description: "Copy the file at input to output.",
		inputSchema: {
			type: "object",
			properties: { input: { type: "string" }, output: { type: "string" } },
			required: ["input", "output"],
		},
	},
	{
		name: "write_text",
		description: "Write text to output; fail writes it and then reports an error, skip writes nothing.",
		inputSchema: {
			type: "object",
			properties: {
				output: { type: "string" },
				text: { type: "string" },
				fail: { type: "boolean" },
				skip: { type: "boolean" },
			},
			required: ["output", "text"],
		},
	},
];

function callTool(name, args) {
	appendFileSync("calls.log", `${name}\n`);
	try {
		if (name === "copy_file") {
			copyFileSync(args.input, args.output);
			return text(`copied ${args.input} to ${args.output}`);
		}
		if (name === "write_text") {
			if (args.skip === true) return text("wrote nothing");
			writeFileSync(args.output, String(args.text));
			return args.fail === true ? text("wrote the bytes, then failed", true) : text(`wrote ${args.output}`);
		}
		return text(`unknown tool ${name}`, true);
	} catch (error) {
		return text(error instanceof Error ? error.message : String(error), true);
	}
}

function handleMessage(message) {
	if (typeof message.method !== "string" || message.id === undefined) return;
	switch (message.method) {
		case "ping":
			reply(message.id, {});
			return;
		case "initialize":
			reply(message.id, {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "files", version: "1.0" },
			});
			return;
		case "tools/list":
			reply(message.id, { tools: TOOLS });
			return;
		case "tools/call":
			reply(message.id, callTool(message.params?.name, message.params?.arguments ?? {}));
			return;
		default:
			replyError(message.id, -32601, `method not found: ${message.method}`);
	}
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
	if (line.trim().length === 0) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		// A line that is not JSON is not a request; the server keeps reading.
		return;
	}
	handleMessage(message);
});
lines.on("close", () => process.exit(0));
