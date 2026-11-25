// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { ExtensionCommandRow } from "../../src/domains/extensions/operator-commands.js";
import type { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { servePancodeAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpServerChat } from "../../src/engine/acp/server-options.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

const refuse = (member: string) =>
	new Proxy(
		{},
		{
			get() {
				throw new Error(`test host: ${member} was reached`);
			},
		},
	);

/**
 * A `/name` line typed into an ACP prompt is screened the way the terminal's
 * editor screens it: a loaded prompt template or plain text goes to the model,
 * a command-shaped token nothing owns is refused, and nothing reaches the model
 * for either refusal. Before this, `/model gpt` and `/tpyo` were sent to the
 * model as prose.
 */
async function peer(extra: Partial<AcpCommandHost> = {}) {
	const submitted: string[] = [];
	const updates: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push(params as Record<string, unknown>);
		},
		onNotification: () => () => {},
		onRequest: (method, handler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const chat: AcpServerChat = {
		submit: async (text) => {
			submitted.push(text);
		},
		whenSettled: async () => {},
		cancel: () => {},
		onEvent: () => () => {},
		isStreaming: () => false,
		getSessionId: () => null,
	};
	const commands = acpCommandControl({
		dispatch: refuse("dispatch") as AcpCommandHost["dispatch"],
		bus: createTelemetryHub(),
		providers: refuse("providers") as AcpCommandHost["providers"],
		runDoctor: async () => ({ level: "info", text: "ok" }),
		listPromptsForDisplay: () => [
			{ name: "review-pr", description: "Review a pull request", argumentHint: "<pr> [focus]", sourceInfo: {} },
			{ name: "cheatsheet", description: "Keys at a glance", displayOnly: true, sourceInfo: {} },
			{ name: "locked", description: "Prompt template", argumentHint: "  ", sourceInfo: {} },
			{
				name: "wtfp:gone",
				description: "Prompt template (unavailable)",
				unavailable: "package wtfp is not installed",
				displayOnly: false,
				sourceInfo: {},
			},
		],
		expandPromptTemplate: (text) => {
			if (text.startsWith("/review-pr")) return { expanded: true };
			if (text.startsWith("/cheatsheet"))
				return { expanded: false, display: { template: { name: "cheatsheet" }, text: "Keys:\nctrl+o opens output" } };
			if (text.startsWith("/locked"))
				return {
					expanded: false,
					refusal: { message: "/locked needs a trusted project before it can expand" },
				};
			return { expanded: false };
		},
		...extra,
	});
	const served = servePancodeAcpAgent({ transport, chat, commands, autonomy: () => "default", cwd: process.cwd() });
	const call = async (method: string, params: unknown) => await handlers.get(method)?.(params);
	await call("initialize", { protocolVersion: 1 });
	const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	const prompt = (text: string) => call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
	return {
		call,
		prompt,
		submitted,
		updates,
		stop: async () => {
			close();
			await served;
		},
	};
}

const refusedWith = (code: string, message: RegExp) => (error: unknown) =>
	error instanceof AcpRequestError && error.detail.code === code && message.test(error.message);

test("an unowned command-shaped token is refused and never reaches the model", async () => {
	const agent = await peer();
	try {
		await assert.rejects(agent.prompt("/tpyo fix the build"), refusedWith("unknown_command", /\/tpyo is not a command/));
		await assert.rejects(
			agent.prompt("/model gpt-5"),
			refusedWith("command_unavailable", /\/model is a terminal command/),
		);
		await assert.rejects(agent.prompt("/locked"), refusedWith("unknown_command", /needs a trusted project/));
		assert.deepEqual(agent.submitted, []);
	} finally {
		await agent.stop();
	}
});

test("templates, escaped slashes and paths still reach the model", async () => {
	const agent = await peer();
	try {
		await agent.prompt("/review-pr 42");
		await agent.prompt("\\/tmp is full again");
		await agent.prompt("/home/user/notes.md explains the layout");
		await agent.prompt("why does this fail?");
		assert.deepEqual(agent.submitted, [
			"/review-pr 42",
			"/tmp is full again",
			"/home/user/notes.md explains the layout",
			"why does this fail?",
		]);
	} finally {
		await agent.stop();
	}
});

test("a display-only template answers the operator and starts no turn", async () => {
	const agent = await peer();
	try {
		const result = (await agent.prompt("/cheatsheet")) as { stopReason: string };
		assert.equal(result.stopReason, "end_turn");
		assert.deepEqual(agent.submitted, []);
		const text = agent.updates
			.map((row) => row.update as { sessionUpdate: string; content?: { text?: string } })
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => update.content?.text ?? "")
			.join("");
		assert.match(text, /\/cheatsheet[\s\S]*ctrl\+o opens output/);
	} finally {
		await agent.stop();
	}
});

test("the command list describes the prompt templates a composer can accept as the terminal's palette does", async () => {
	const agent = await peer();
	try {
		const listed = (await agent.call("_pancode/commands/list", {})) as { prompts?: unknown };
		assert.deepEqual(listed.prompts, [
			{ name: "review-pr", description: "Review a pull request", input: { hint: "<pr> [focus]" } },
			{ name: "cheatsheet", description: "Keys at a glance", _meta: { "pancode/prompt": { displayOnly: true } } },
			{ name: "locked", description: "Prompt template" },
			{
				name: "wtfp:gone",
				description: "Prompt template (unavailable)",
				_meta: { "pancode/prompt": { unavailable: "package wtfp is not installed" } },
			},
		]);
	} finally {
		await agent.stop();
	}
});

test("gui-fix5: the announcement lists the same prompt rows, marks included, as the command list", async () => {
	// Before, the announcement read the verified listing and the command list the display one, so an unavailable
	// template could be in one and not the other, and neither carried the terminal palette's marks.
	const agent = await peer({ listPrompts: () => [] });
	try {
		const listed = (await agent.call("_pancode/commands/list", {})) as { prompts?: Array<{ name: string }> };
		const names = new Set(listed.prompts?.map((prompt) => prompt.name));
		const announced = agent.updates
			.map((entry) => entry.update as { sessionUpdate: string; availableCommands?: Array<{ name: string }> })
			.filter((update) => update.sessionUpdate === "available_commands_update")
			.flatMap((update) => update.availableCommands ?? [])
			.filter((command) => names.has(command.name));
		assert.deepEqual(announced, listed.prompts);
	} finally {
		await agent.stop();
	}
});

test("WTF-P F04/F05: extension commands and takeovers run in the runtime, and the palette lists them with the prompts", async () => {
	const row = (invocation: string, more: Partial<ExtensionCommandRow> = {}): ExtensionCommandRow => ({
		origin: "extension",
		invocation,
		extensionId: "desk",
		scope: "user",
		description: `${invocation} help`,
		generation: 1,
		available: true,
		...more,
	});
	const invoked: string[] = [];
	const runtime = {
		commands: () => [
			row("ext:desk:validate"),
			row("ext:desk:progress"),
			row("desk:progress", { replaces: "prompt" }),
			row("ext:desk:broken", { available: false, reason: "runtime not ready; reload extensions" }),
		],
		invoke: async (token: string, args: string) => {
			invoked.push(`${token}|${args}`);
			return { api: 2, text: `${token} answered ${args}`.trim() };
		},
		entries: () => [],
	} as unknown as OperatorExtensions;
	const prompts = [
		{ name: "desk:progress", description: "Paper progress", sourceInfo: { source: "plugin:user:desk" } },
		{ name: "review-pr", description: "Review a pull request", argumentHint: "<pr>", sourceInfo: {} },
	];
	const agent = await peer({
		operatorExtensions: () => runtime,
		listPrompts: () => prompts,
		listPromptsForDisplay: () => prompts,
	});
	try {
		const rows = agent.updates
			.map((entry) => entry.update as { sessionUpdate: string; availableCommands?: Array<{ name: string }> })
			.filter((update) => update.sessionUpdate === "available_commands_update")
			.flatMap((update) => update.availableCommands ?? []);
		// gui-fix4: a template's row carries its argument hint; a takeover runs the extension, which declares none.
		assert.deepEqual(
			rows.filter((command) => command.name === "review-pr" || command.name === "desk:progress"),
			[
				{ name: "desk:progress", description: "desk:progress help" },
				{ name: "review-pr", description: "Review a pull request", input: { hint: "<pr>" } },
			],
		);
		const announced = agent.updates
			.map((entry) => entry.update as { sessionUpdate: string; availableCommands?: Array<{ name: string }> })
			.filter((update) => update.sessionUpdate === "available_commands_update")
			.flatMap((update) => update.availableCommands?.map((command) => command.name) ?? []);
		for (const name of ["desk:progress", "review-pr", "ext:desk:validate"]) assert.ok(announced.includes(name), name);
		assert.ok(!announced.includes("ext:desk:broken"));
		// gui-fix6: the command list serves the same extension rows, so the GUI palette can list them.
		const listed = (await agent.call("_pancode/commands/list", {})) as { extensionCommands?: Array<{ name: string }> };
		assert.deepEqual(
			listed.extensionCommands?.map((command) => command.name),
			["ext:desk:validate", "ext:desk:progress", "desk:progress"],
		);
		await agent.prompt("/ext:desk:validate all");
		await agent.prompt("/desk:progress");
		await assert.rejects(agent.prompt("/ext:desk:broken"), refusedWith("command_unavailable", /runtime not ready/));
		assert.deepEqual(invoked, ["ext:desk:validate|all", "desk:progress|"]);
		assert.deepEqual(agent.submitted, []);
		const text = agent.updates
			.map((entry) => entry.update as { sessionUpdate: string; content?: { text?: string } })
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => update.content?.text ?? "")
			.join("\n");
		assert.match(text, /ext:desk:validate answered all/);
		assert.match(text, /desk:progress answered/);
	} finally {
		await agent.stop();
	}
});
