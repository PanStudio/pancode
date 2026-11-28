// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Add a server to, or remove one from, a user or project `mcp.yaml`. The file
 * is edited as a document, so the operator's comments and order survive, and
 * the result must load cleanly under the strict schema before it is written.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { isRecord } from "../../core/type-guards.js";
import { MCP_CONFIG_VERSION, mcpConfigPaths, parseMcpConfigText } from "./config.js";

export type McpEditScope = "user" | "project";

export interface McpConfigEditOptions {
	cwd: string;
	configDir?: string;
	scope: McpEditScope;
}

/** One server as `mcp add` writes it: a launch vector or a remote endpoint. */
export type McpAddedServer =
	| { id: string; command: string; args: string[] }
	| { id: string; url: string; headers: Record<string, string> };

export type McpConfigEditResult = { ok: true; path: string } | { ok: false; message: string };

function destination(options: McpConfigEditOptions): { path: string; root: string } {
	const paths = mcpConfigPaths({ cwd: options.cwd, ...(options.configDir ? { configDir: options.configDir } : {}) });
	return options.scope === "user"
		? { path: paths.user, root: path.dirname(paths.user) }
		: { path: paths.project, root: path.dirname(path.dirname(paths.project)) };
}

function serverNode(server: McpAddedServer): Record<string, unknown> {
	if ("url" in server) {
		return {
			id: server.id,
			url: server.url,
			...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
		};
	}
	return { id: server.id, command: server.command, ...(server.args.length > 0 ? { args: server.args } : {}) };
}

/** Validate `text` as the file at `target` and write it, owner-readable only. */
function commit(text: string, target: { path: string; root: string }, scope: McpEditScope): McpConfigEditResult {
	const checked = parseMcpConfigText(text, { scope, path: target.path, root: target.root });
	const problems = checked.diagnostics.filter((entry) => entry.severity !== "warning").map((entry) => entry.message);
	if (problems.length > 0) return { ok: false, message: `${target.path} would not load: ${problems.join("; ")}` };
	safeResourceWrite(target.path, text, { mode: 0o600 });
	return { ok: true, path: target.path };
}

/** The servers sequence of an existing file, or why the file cannot be edited. */
function readServers(file: string): { document: ReturnType<typeof parseDocument>; ids: unknown[] } | string {
	const document = parseDocument(readFileSync(file, "utf8"));
	const parsed: unknown = document.errors.length > 0 ? null : document.toJS();
	const servers = isRecord(parsed) && Array.isArray(parsed.servers) ? parsed.servers : null;
	if (servers === null) return `${file} is not a valid PanCode MCP config; fix it first`;
	return { document, ids: servers.map((entry) => (isRecord(entry) ? entry.id : undefined)) };
}

export function addMcpServerDeclaration(options: McpConfigEditOptions, server: McpAddedServer): McpConfigEditResult {
	const target = destination(options);
	if (!existsSync(target.path)) {
		return commit(stringifyYaml({ version: MCP_CONFIG_VERSION, servers: [serverNode(server)] }), target, options.scope);
	}
	const read = readServers(target.path);
	if (typeof read === "string") return { ok: false, message: read };
	if (read.ids.includes(server.id)) {
		return {
			ok: false,
			message: `${target.path} already declares ${server.id}; remove it first with pancode mcp remove ${server.id}`,
		};
	}
	read.document.addIn(["servers"], read.document.createNode(serverNode(server)));
	return commit(read.document.toString(), target, options.scope);
}

export function removeMcpServerDeclaration(options: McpConfigEditOptions, id: string): McpConfigEditResult {
	const target = destination(options);
	if (!existsSync(target.path)) return { ok: false, message: `${target.path} does not exist` };
	const read = readServers(target.path);
	if (typeof read === "string") return { ok: false, message: read };
	const index = read.ids.indexOf(id);
	if (index < 0) return { ok: false, message: `${target.path} declares no server ${id}` };
	read.document.deleteIn(["servers", index]);
	return commit(read.document.toString(), target, options.scope);
}
