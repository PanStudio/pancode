// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A first-party pack references a PanKit server by id and tool name in its
 * prose and never ships an `mcp.json` entry for a builtin id. Every input is
 * a tracked repository file: the packs under `hub/packs/plugins/` and the
 * generated manifest `packages/kit/servers.json`.
 */
import { deepStrictEqual, ok } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PLUGINS = path.join(REPO, "hub/packs/plugins");
const PACKS = ["hpc", "science-data"];

const manifest = JSON.parse(readFileSync(path.join(REPO, "packages/kit/servers.json"), "utf8")) as {
	servers: Array<{ id: string; tools: Array<{ name: string }> }>;
};
const toolsOf = new Map(manifest.servers.map((server) => [server.id, new Set(server.tools.map((tool) => tool.name))]));

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

describe("first-party packs and the builtin PanKit servers", () => {
	it("ship no mcp.json in hpc or science-data, and no pack declares a builtin id", () => {
		for (const pack of PACKS) ok(!existsSync(path.join(PLUGINS, pack, "mcp.json")), `${pack} ships mcp.json`);
		for (const pack of readdirSync(PLUGINS)) {
			const file = path.join(PLUGINS, pack, "mcp.json");
			if (!existsSync(file)) continue;
			const declared = Object.keys(
				(JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {},
			);
			deepStrictEqual(
				declared.filter((id) => toolsOf.has(id)),
				[],
				`${pack}/mcp.json declares a builtin server id`,
			);
		}
	});

	it("name only tools the manifest lists, and the servers each pack relies on", () => {
		const named = new Map<string, Set<string>>();
		for (const pack of PACKS) {
			const tokens = capabilityTokens(pack);
			for (const { file, id, tool } of tokens) {
				ok(toolsOf.get(id)?.has(tool) === true, `${file} names mcp_${id}__${tool}, which servers.json does not list`);
			}
			named.set(pack, new Set(tokens.map((token) => token.id)));
		}
		for (const id of ["modules", "spack", "darshan"]) ok(named.get("hpc")?.has(id), `hpc names no ${id} tool`);
		ok(named.get("science-data")?.has("catalog"), "science-data names no catalog tool");
	});
});
