// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Another agent's MCP server declaration mapped onto PanCode's strict `mcp.yaml`
 * (domains/gateway/mcp/config.ts). A server whose launch cannot be stated
 * exactly in that schema (the 2024 HTTP+SSE transport, `${VAR}` expansion, a
 * shell string, an env pass-through list) is never guessed at: the plan skips
 * it and says why. A Streamable HTTP server's literal header values move into
 * PanCode's credential store, bound to its url's origin, and its declaration
 * names them by key. A user-scope source lands in the user's `<config>/mcp.yaml`;
 * a project source lands in the project's `.pancode/mcp.yaml`, which keeps
 * its own trust record before anything in it launches.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { sha256Hex } from "../../core/hash.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { isRecord } from "../../core/type-guards.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import {
	MCP_CONFIG_CAPS,
	MCP_CONFIG_VERSION,
	MCP_CREDENTIAL_KEY_CHARS,
	type McpConfigLoadResult,
	type McpHeaderCredentialStore,
	mcpConfigPaths,
	mcpHeaderCredentialRef,
	mcpHeaderValueRefusal,
	mcpOriginOf,
	openMcpHeaderCredentialStore,
	parseMcpConfigText,
} from "../gateway/mcp/index.js";
import { inventoryText } from "./inventory.js";
import type { InteropInventoryItem } from "./types.js";

/** One server in the shape PanCode's `mcp.yaml` declares it. Env values stay host-side; plans show keys only. */
export type AdoptedMcpServer = AdoptedStdioServer | AdoptedRemoteServer;

interface AdoptedStdioServer {
	id: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	timeoutMs?: number;
	url?: never;
}

interface AdoptedRemoteServer {
	id: string;
	url: string;
	/** Header name to the full value the source declares; stored, never written to mcp.yaml. */
	headerValues: Record<string, string>;
	timeoutMs?: number;
	command?: never;
}

/** The credential key an adopted header value is stored under: `<id>-<header>`, within the key pattern. */
function adoptedHeaderKey(id: string, header: string): string {
	return `${id}-${header.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-")}`.slice(0, MCP_CREDENTIAL_KEY_CHARS);
}

export type McpAdoptionMapping =
	| { ok: true; server: AdoptedMcpServer; destination: string; digest: string; omittedFields: string[] }
	| { ok: false; reason: string };

function strings(value: unknown): string[] | null {
	if (value === undefined) return [];
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

/** The raw declaration of `item.name` in its source file, re-read on every call. */
function sourceDeclaration(item: InteropInventoryItem): Record<string, unknown> | null {
	const text = inventoryText(item.path);
	if (item.path.endsWith(".toml")) {
		const data = parseToml(text) as Record<string, unknown>;
		const servers = data.mcp_servers;
		const value = isRecord(servers) ? servers[item.name] : undefined;
		return isRecord(value) ? value : null;
	}
	const data: unknown = JSON.parse(text);
	if (!isRecord(data)) return null;
	for (const key of ["mcpServers", "mcp"]) {
		const servers = data[key];
		const value = isRecord(servers) ? servers[item.name] : undefined;
		if (isRecord(value)) return value;
	}
	return null;
}

/** A PanCode server id from a foreign name: lowercase, `[a-z0-9_-]`, at most the schema's cap. */
function serverId(name: string): string {
	const id = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, MCP_CONFIG_CAPS.idChars)
		.replace(/-+$/, "");
	return id.length > 0 ? id : "server";
}

/** Fields each host may set that change nothing about how PanCode launches the server. */
const IGNORED_FIELDS = new Set([
	"type",
	"url",
	"headers",
	"http_headers",
	"command",
	"args",
	"env",
	"environment",
	"cwd",
	"enabled",
	"tool_timeout_sec",
	"startup_timeout_sec",
	"startup_timeout_ms",
]);

const REMOTE_TYPES = new Set([undefined, "http", "streamable-http", "streamableHttp", "remote"]);

function mapRemoteDeclaration(raw: Record<string, unknown>, name: string): AdoptedMcpServer | string {
	const type = raw.type;
	if (type === "sse") return "uses the 2024 HTTP+SSE transport, which PanCode does not speak; it speaks Streamable HTTP";
	if (!REMOTE_TYPES.has(type as string | undefined))
		return `uses the ${String(type)} transport, which PanCode does not speak`;
	if (raw.bearer_token_env_var !== undefined || raw.env_http_headers !== undefined)
		return "reads its credentials from host environment variables, which PanCode's mcp.yaml cannot state; store them with pancode mcp login";
	const url = raw.url as string;
	const source = raw.headers ?? raw.http_headers;
	const headerValues: Record<string, string> = {};
	if (source !== undefined) {
		if (!isRecord(source)) return "headers is not a mapping";
		for (const [header, value] of Object.entries(source)) {
			if (typeof value !== "string") return `header ${header} is not a string`;
			const refused = mcpHeaderValueRefusal(value);
			if (refused !== null) return `header ${header}'s value ${refused}`;
			headerValues[header] = value;
		}
	}
	const keys = Object.keys(headerValues).map((header) => adoptedHeaderKey(serverId(name), header));
	if (new Set(keys).size !== keys.length) return "names headers that would share one credential key";
	if ([url, ...Object.values(headerValues)].some((value) => /\$\{[^}]*\}/.test(value)))
		return "expands environment variables in its url or headers, which PanCode's mcp.yaml does not do; declare it with pancode mcp add and store its credentials with pancode mcp login";
	const server: AdoptedMcpServer = { id: serverId(name), url, headerValues };
	if (typeof raw.tool_timeout_sec === "number" && raw.tool_timeout_sec > 0)
		server.timeoutMs = Math.min(MCP_CONFIG_CAPS.timeoutMs, Math.round(raw.tool_timeout_sec * 1000));
	return server;
}

function mapDeclaration(raw: Record<string, unknown>, name: string): AdoptedMcpServer | string {
	if (raw.enabled === false) return "disabled in the source configuration";
	const type = raw.type;
	if (typeof raw.url === "string") return mapRemoteDeclaration(raw, name);
	if (type !== undefined && type !== "stdio" && type !== "local")
		return `uses the ${typeof type === "string" ? type : "remote"} transport without a url`;
	if (raw.env_vars !== undefined)
		return "passes host environment variables through by name (env_vars), which PanCode's mcp.yaml cannot state";
	// OpenCode's local servers spell argv as one `command` array.
	const argv = Array.isArray(raw.command) ? strings(raw.command) : null;
	const command = argv ? argv[0] : raw.command;
	const args = argv ? argv.slice(1) : strings(raw.args);
	if (typeof command !== "string" || command.length === 0) return "has no command";
	if (args === null) return "args is not a list of strings";
	const envSource = raw.env ?? raw.environment;
	const env: Record<string, string> = {};
	if (envSource !== undefined) {
		if (!isRecord(envSource)) return "env is not a mapping";
		for (const [key, value] of Object.entries(envSource)) {
			if (typeof value !== "string") return `env ${key} is not a string`;
			env[key] = value;
		}
	}
	const expanded = [command, ...args, ...Object.values(env)].some((value) => /\$\{[^}]*\}/.test(value));
	if (expanded)
		return "expands environment variables in its values, which PanCode's mcp.yaml does not do; declare the literal values by hand";
	const server: AdoptedMcpServer = { id: serverId(name), command, args, env };
	if (typeof raw.cwd === "string" && raw.cwd.length > 0) server.cwd = raw.cwd;
	if (typeof raw.tool_timeout_sec === "number" && raw.tool_timeout_sec > 0)
		server.timeoutMs = Math.min(MCP_CONFIG_CAPS.timeoutMs, Math.round(raw.tool_timeout_sec * 1000));
	return server;
}

function serverNode(server: AdoptedMcpServer): Record<string, unknown> {
	if (server.url !== undefined) {
		const headers = Object.fromEntries(
			Object.keys(server.headerValues)
				.sort()
				.map((header) => [header, adoptedHeaderKey(server.id, header)]),
		);
		return {
			id: server.id,
			url: server.url,
			...(Object.keys(headers).length > 0 ? { headers } : {}),
			...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
		};
	}
	return {
		id: server.id,
		command: server.command,
		...(server.args.length > 0 ? { args: server.args } : {}),
		...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
		...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
		...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
	};
}

function serverDigest(server: AdoptedMcpServer): string {
	if (server.url !== undefined) {
		// The values are hashed, so a review binds them without the plan showing them.
		const headers = Object.entries(server.headerValues).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return sha256Hex(JSON.stringify([server.id, server.url, headers, server.timeoutMs ?? null]));
	}
	const canonical = [
		server.id,
		server.command,
		server.args,
		Object.entries(server.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		server.cwd ?? null,
		server.timeoutMs ?? null,
	];
	return sha256Hex(JSON.stringify(canonical));
}

/** The PanCode config file a source of this scope adopts into. */
function destinationOf(scope: "user" | "project", cwd: string): { path: string; root: string } {
	const paths = mcpConfigPaths({ cwd, configDir: pancodeConfigDir() });
	return scope === "user"
		? { path: paths.user, root: path.dirname(paths.user) }
		: { path: paths.project, root: path.dirname(path.dirname(paths.project)) };
}

function strictCheck(
	text: string,
	scope: "user" | "project",
	destination: { path: string; root: string },
): McpConfigLoadResult {
	return parseMcpConfigText(text, { scope, path: destination.path, root: destination.root });
}

function errorsOf(result: McpConfigLoadResult): string[] {
	return result.diagnostics.filter((d) => d.severity !== "warning").map((d) => d.message);
}

/** Map one inventory MCP item, validated through PanCode's own config schema. */
export function mapForeignMcpServer(item: InteropInventoryItem, cwd: string): McpAdoptionMapping {
	let raw: Record<string, unknown> | null;
	try {
		raw = sourceDeclaration(item);
	} catch (error) {
		return { ok: false, reason: `Cannot read ${item.path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (raw === null) return { ok: false, reason: `Not found in ${item.path}.` };
	const mapped = mapDeclaration(raw, item.name);
	if (typeof mapped === "string") return { ok: false, reason: `Not adoptable: the server ${mapped}.` };
	const destination = destinationOf(item.scope, cwd);
	const alone = strictCheck(
		JSON.stringify({ version: MCP_CONFIG_VERSION, servers: [serverNode(mapped)] }),
		item.scope,
		destination,
	);
	const problems = errorsOf(alone);
	if (problems.length > 0)
		return { ok: false, reason: `Not adoptable under PanCode's mcp.yaml: ${problems.join("; ")}.` };
	return {
		ok: true,
		server: mapped,
		destination: destination.path,
		digest: serverDigest(mapped),
		omittedFields: Object.keys(raw).filter((key) => !IGNORED_FIELDS.has(key)),
	};
}

/** Why the destination already settles this server, or null when it can be added. */
export function mcpDestinationConflict(server: AdoptedMcpServer, destination: string): string | null {
	if (!existsSync(destination)) return null;
	let text: string;
	try {
		text = inventoryText(destination);
	} catch (error) {
		return `Cannot read ${destination}: ${error instanceof Error ? error.message : String(error)}`;
	}
	const document = parseDocument(text);
	const parsed: unknown = document.errors.length > 0 ? null : document.toJS();
	const servers = isRecord(parsed) && Array.isArray(parsed.servers) ? parsed.servers : null;
	if (servers === null) return `${destination} is not a valid PanCode MCP config; fix it before adopting servers.`;
	const existing = servers.find((entry) => isRecord(entry) && entry.id === server.id);
	if (!isRecord(existing)) return null;
	const same = JSON.stringify(existing) === JSON.stringify(serverNode(server));
	return same
		? "Already declared: same server in the PanCode config."
		: `Server id collision: ${server.id} is already declared in ${destination}; existing content will not be replaced.`;
}

/** Append one reviewed server to its destination, re-checking the source and the merged file. */
export function applyMcpAdoption(
	item: InteropInventoryItem,
	cwd: string,
	reviewedDigest: string,
	credentials: () => McpHeaderCredentialStore = openMcpHeaderCredentialStore,
): { ok: true; destination: string; id: string } | { ok: false; reason: string } {
	const current = mapForeignMcpServer(item, cwd);
	if (!current.ok) return current;
	if (current.digest !== reviewedDigest)
		return { ok: false, reason: "Source changed after review; inspect a new plan." };
	const conflict = mcpDestinationConflict(current.server, current.destination);
	if (conflict !== null) return { ok: false, reason: conflict };
	let text: string;
	if (existsSync(current.destination)) {
		// Edited as a document so the operator's comments and order survive.
		const document = parseDocument(inventoryText(current.destination));
		document.addIn(["servers"], document.createNode(serverNode(current.server)));
		text = document.toString();
	} else text = stringifyYaml({ version: MCP_CONFIG_VERSION, servers: [serverNode(current.server)] });
	const destination = destinationOf(item.scope, cwd);
	const problems = errorsOf(strictCheck(text, item.scope, destination));
	if (problems.length > 0) return { ok: false, reason: `Merged config would be invalid: ${problems.join("; ")}.` };
	const adopted = current.server;
	if (adopted.url !== undefined && Object.keys(adopted.headerValues).length > 0) {
		// Stored before the declaration that names them, so the server never loads without its credentials.
		try {
			const store = credentials();
			const origin = mcpOriginOf(adopted.url);
			for (const [header, value] of Object.entries(adopted.headerValues)) {
				store.set(mcpHeaderCredentialRef(adoptedHeaderKey(adopted.id, header), origin), value);
			}
		} catch (error) {
			return { ok: false, reason: `Credentials not stored: ${error instanceof Error ? error.message : String(error)}.` };
		}
	}
	// Env values can be credentials: the file is the operator's own and readable only by them.
	safeResourceWrite(current.destination, text, { mode: 0o600 });
	return { ok: true, destination: current.destination, id: current.server.id };
}
