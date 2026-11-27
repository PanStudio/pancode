// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pancode mcp add|remove|login|logout`: declare a server without editing
 * YAML, and keep a remote server's header credentials in PanCode's
 * credential store, each bound to the origin it was entered for.
 */

import { createInterface } from "node:readline";
import { escapeTerminalControls } from "../core/terminal-controls.js";
import {
	addMcpServerDeclaration,
	type McpAddedServer,
	type McpEditScope,
	removeMcpServerDeclaration,
} from "../domains/gateway/mcp/config-edit.js";
import {
	type McpTrustOptions,
	mcpCredentialRoutes,
	mcpHeaderBindings,
	mcpHeaderCredentialRef,
	mcpHeaderValueRefusal,
	mcpOriginOf,
	openMcpHeaderCredentialStore,
	resolveMcpServers,
} from "../domains/gateway/mcp/index.js";
import type { McpCommandOutput } from "./mcp.js";

type Fail = (code: number, message: string) => McpCommandOutput;

const ADD_USAGE =
	"usage: pancode mcp add <id> [--scope user|project] (--url <url> [--header <Name>=<key>]... | -- <command> [args...])";
const REMOVE_USAGE = "usage: pancode mcp remove <id> [--scope user|project]";

function parseScope(value: string | undefined): McpEditScope | null {
	return value === "user" || value === "project" ? value : null;
}

/** `add` and `remove`: edit the user or project mcp.yaml, validated before it is written. */
export function mcpEditOutput(argv: ReadonlyArray<string>, options: McpTrustOptions, fail: Fail): McpCommandOutput {
	const [command, id, ...rest] = argv;
	const usage = command === "add" ? ADD_USAGE : REMOVE_USAGE;
	if (id === undefined || id.startsWith("-")) return fail(2, usage);
	let scope: McpEditScope | undefined;
	let url: string | undefined;
	const headers: Record<string, string> = {};
	let launch: string[] | undefined;
	for (let index = 0; index < rest.length; index += 1) {
		const flag = rest[index] as string;
		if (flag === "--" && command === "add" && url === undefined) {
			launch = rest.slice(index + 1);
			break;
		}
		const value = rest[index + 1];
		index += 1;
		if (flag === "--scope" && scope === undefined) {
			const parsed = parseScope(value);
			if (parsed === null) return fail(2, `--scope takes user or project; ${usage}`);
			scope = parsed;
		} else if (flag === "--url" && command === "add" && url === undefined && value !== undefined) {
			url = value;
		} else if (flag === "--header" && command === "add" && value !== undefined) {
			const split = value.indexOf("=");
			if (split <= 0 || split === value.length - 1) return fail(2, `--header takes <Name>=<key>; ${usage}`);
			const name = value.slice(0, split);
			if (Object.keys(headers).some((existing) => existing.toLowerCase() === name.toLowerCase()))
				return fail(2, `--header ${name} is given twice`);
			headers[name] = value.slice(split + 1);
		} else return fail(2, usage);
	}
	const editOptions = {
		cwd: options.cwd,
		...(options.configDir ? { configDir: options.configDir } : {}),
		scope: scope ?? "user",
	};
	if (command === "remove") {
		const declared = resolveMcpServers(options).servers.find((entry) => entry.id === id);
		const removed = removeMcpServerDeclaration(
			{
				...editOptions,
				scope: scope ?? (declared?.scope === "project" ? "project" : "user"),
			},
			id,
		);
		if (!removed.ok) return fail(1, removed.message);
		const kept =
			declared?.url !== undefined && Object.keys(declared.headers).length > 0
				? ` (the credentials it named stay stored for ${mcpOriginOf(declared.url)}; a server declared again with the same keys and origin uses them)`
				: "";
		return { code: 0, text: `mcp: removed ${id} from ${removed.path}${kept}`, data: { ok: true, path: removed.path } };
	}
	if ((url === undefined) === (launch === undefined)) return fail(2, ADD_USAGE);
	if (launch !== undefined && launch.length === 0) return fail(2, ADD_USAGE);
	if (url === undefined && Object.keys(headers).length > 0)
		return fail(2, "--header applies only to a server added with --url");
	const server: McpAddedServer =
		url !== undefined ? { id, url, headers } : { id, command: launch?.[0] as string, args: (launch ?? []).slice(1) };
	const added = addMcpServerDeclaration(editOptions, server);
	if (!added.ok) return fail(1, added.message);
	const next: string[] = [];
	if ("url" in server && Object.keys(server.headers).length > 0) next.push(`pancode mcp login ${id}`);
	if (editOptions.scope === "project") next.push(`pancode mcp trust ${id}`);
	const lines = [
		`mcp: added ${id} to ${added.path}`,
		...("url" in server ? mcpCredentialRoutes(server.url, server.headers).map((route) => `  ${route}`) : []),
		...(next.length > 0 ? [`next: ${next.join(", then ")}`] : []),
	];
	return { code: 0, text: lines.join("\n"), data: { ok: true, path: added.path, id } };
}

/** `logout <id>`: remove each header credential the server sends, for its own origin only. */
export function mcpLogoutOutput(
	id: string | undefined,
	rest: ReadonlyArray<string>,
	options: McpTrustOptions,
	fail: Fail,
): McpCommandOutput {
	if (id === undefined || id.startsWith("-") || rest.length > 0) return fail(2, "usage: pancode mcp logout <id>");
	const server = resolveMcpServers(options).servers.find((entry) => entry.id === id);
	if (server === undefined) return fail(1, `no declared MCP server with id '${id}'`);
	if (server.url === undefined) return fail(1, `server '${id}' is a local server; it holds no stored credentials`);
	const store = openMcpHeaderCredentialStore();
	const removed: string[] = [];
	for (const binding of mcpHeaderBindings(server, store)) {
		if (!binding.stored) continue;
		store.remove(mcpHeaderCredentialRef(binding.key, binding.origin));
		removed.push(binding.key);
	}
	const origin = mcpOriginOf(server.url);
	return {
		code: 0,
		text:
			removed.length > 0
				? `mcp: removed ${removed.join(", ")} for ${origin}`
				: `mcp: no credential of ${id} is stored for ${origin}`,
		data: { ok: true, removed, origin },
	};
}

/** Every line of a piped stdin; a terminal never reaches this. */
async function stdinLines(): Promise<string[]> {
	const lines: string[] = [];
	const rl = createInterface({ input: process.stdin, terminal: false });
	for await (const line of rl) lines.push(line);
	return lines;
}

/**
 * `login <id>`: read each header's full value, at a terminal with typing
 * hidden, otherwise one line per header from stdin in header-name order, and
 * store it for the server's origin. Nothing is stored unless every value is.
 */
export async function mcpLoginOutput(argv: ReadonlyArray<string>): Promise<McpCommandOutput> {
	const fail: Fail = (code, message) => ({ code, text: message, data: { ok: false, message } });
	const [, id, ...rest] = argv;
	if (id === undefined || id.startsWith("-") || rest.length > 0) return fail(2, "usage: pancode mcp login <id>");
	const server = resolveMcpServers({ cwd: process.cwd() }).servers.find((entry) => entry.id === id);
	if (server === undefined) return fail(1, `no declared MCP server with id '${id}'`);
	if (server.url === undefined) return fail(1, `server '${id}' is a local server; it takes no credentials`);
	const store = openMcpHeaderCredentialStore();
	const bindings = mcpHeaderBindings(server, store);
	if (bindings.length === 0)
		return fail(1, `server '${id}' declares no headers; add one with --header <Name>=<key> when declaring it`);
	const values: string[] = [];
	if (process.stdin.isTTY === true) {
		const { readApiKey } = await import("./auth.js");
		for (const binding of bindings) {
			const value = await readApiKey(
				`Full ${binding.header} header value for ${id} (credential ${binding.key}, sent only to ${binding.origin})`,
			);
			if (value === null) return fail(1, "login cancelled; nothing was stored");
			values.push(value);
		}
	} else {
		const lines = await stdinLines();
		if (lines.length < bindings.length)
			return fail(
				1,
				`stdin held ${lines.length} line(s); ${id} needs one per header, in this order: ${bindings.map((binding) => binding.header).join(", ")}`,
			);
		values.push(...lines.slice(0, bindings.length).map((line) => line.trim()));
	}
	for (const [index, binding] of bindings.entries()) {
		const refusal = mcpHeaderValueRefusal(values[index] as string);
		if (refusal !== null) return fail(1, `the value for ${binding.header} ${refusal}; nothing was stored`);
	}
	try {
		for (const [index, binding] of bindings.entries()) {
			store.set(mcpHeaderCredentialRef(binding.key, binding.origin), values[index] as string);
		}
	} catch (error) {
		return fail(1, escapeTerminalControls(error instanceof Error ? error.message : String(error)));
	}
	return {
		code: 0,
		text: [
			`mcp: stored ${bindings.map((binding) => binding.key).join(", ")} for ${bindings[0]?.origin}`,
			...bindings.map((binding) => `  sends credential ${binding.key} as ${binding.header} to ${binding.origin}`),
		].join("\n"),
		data: { ok: true, stored: bindings.map(({ header, key, origin }) => ({ header, key, origin })) },
	};
}
