// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A first-party pack references an MCP server by id and tool name in its
 * prose. The hpc and science-data packs ship their own server in `mcp.json`,
 * and every tool their text names is one that `mcp.json` classes; a server
 * the pack does not ship (`scidata`, `store`) is checked against the PanKit
 * manifest `packages/kit/servers.json`. Every input is a tracked repository file.
 */
import { deepStrictEqual, ok } from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PLUGINS = path.join(REPO, "hub/packs/plugins");
const SERVER_OF: Record<string, string> = { hpc: "hpc", "science-data": "catalog" };

const manifest = JSON.parse(readFileSync(path.join(REPO, "packages/kit/servers.json"), "utf8")) as {
	servers: Array<{ id: string; tools: Array<{ name: string }> }>;
};
const toolsOf = new Map(manifest.servers.map((server) => [server.id, new Set(server.tools.map((tool) => tool.name))]));

/** The servers a pack's `mcp.json` declares, each with the tools its `toolActionClasses` names. */
function packServers(pack: string): Map<string, Set<string>> {
	const declared =
		(
			JSON.parse(readFileSync(path.join(PLUGINS, pack, "mcp.json"), "utf8")) as {
				mcpServers?: Record<string, { toolActionClasses?: Record<string, string> }>;
			}
		).mcpServers ?? {};
	return new Map(
		Object.entries(declared).map(([id, server]) => [id, new Set(Object.keys(server.toolActionClasses ?? {}))]),
	);
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const file = path.join(dir, name);
		return statSync(file).isDirectory() ? filesUnder(file) : [file];
	});
}

/** Every `mcp_<id>__<tool>` token in a pack's text files, with the file it came from. */
function capabilityTokens(pack: string): Array<{ file: string; id: string; tool: string }> {
	return filesUnder(path.join(PLUGINS, pack))
		.filter((file) => /\.(md|json|ya?ml|txt)$/u.test(file))
		.flatMap((file) =>
			[...readFileSync(file, "utf8").matchAll(/mcp_([a-z0-9][a-z0-9_-]*?)__([a-z0-9_-]+)/gu)].map((match) => ({
				file: path.relative(REPO, file),
				id: match[1] as string,
				tool: match[2] as string,
			})),
		);
}

describe("first-party packs and their MCP servers", () => {
	it("ship exactly their own server in mcp.json", () => {
		for (const [pack, id] of Object.entries(SERVER_OF)) deepStrictEqual([...packServers(pack).keys()], [id], pack);
	});

	it("name only tools their mcp.json or the PanKit manifest lists, and their own server's tools", () => {
		for (const [pack, own] of Object.entries(SERVER_OF)) {
			const servers = packServers(pack);
			const tokens = capabilityTokens(pack);
			for (const { file, id, tool } of tokens) {
				const listed = servers.get(id) ?? toolsOf.get(id);
				ok(
					listed?.has(tool) === true,
					`${file} names mcp_${id}__${tool}, which neither ${pack}/mcp.json nor servers.json lists`,
				);
			}
			ok(
				tokens.some((token) => token.id === own),
				`${pack} names no ${own} tool`,
			);
		}
	});
});
