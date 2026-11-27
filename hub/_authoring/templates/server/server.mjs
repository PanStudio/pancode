// A minimal MCP server over stdio: one JSON-RPC message per line, no dependencies.
import { createInterface } from "node:readline";

const TOOL = {
	name: "count_text",
	description: "Count the lines, words and characters of a text.",
	inputSchema: {
		type: "object",
		properties: { text: { type: "string", description: "The text to count." } },
		required: ["text"],
	},
};

function count(text) {
	return {
		lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
		words: text.split(/\s+/).filter(Boolean).length,
		characters: [...text].length,
	};
}

function answer(method, params) {
	if (method === "initialize")
		return {
			protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "text-stats", version: "1.0.0" },
		};
	if (method === "ping") return {};
	if (method === "tools/list") return { tools: [TOOL] };
	if (method === "tools/call") {
		if (params?.name !== TOOL.name) throw { code: -32602, message: `unknown tool ${params?.name}` };
		const text = params.arguments?.text;
		if (typeof text !== "string") throw { code: -32602, message: "text must be a string" };
		return { content: [{ type: "text", text: JSON.stringify(count(text)) }] };
	}
	throw { code: -32601, message: `method not found: ${method}` };
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.trim().length === 0) return;
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		send({ id: null, error: { code: -32700, message: "parse error" } });
		return;
	}
	// A notification has no id and gets no answer.
	if (request.id === undefined) return;
	try {
		send({ id: request.id, result: answer(request.method, request.params) });
	} catch (error) {
		send({ id: request.id, error: { code: error.code ?? -32603, message: error.message ?? String(error) } });
	}
});
