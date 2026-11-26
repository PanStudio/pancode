// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { listedTool } from "@pancode/sdk/mcp-server";
import { policyManifest, type ToolActionClass, type ToolPathAccess, type ToolServer } from "@pancode/sdk/tool";
import { loadServer, SERVERS } from "./registry.js";

export interface KitManifestTool {
	name: string;
	actionClass: ToolActionClass;
	pathArguments: Record<string, ToolPathAccess>;
	/** Exactly what the server lists in `tools/list`. */
	inputSchema: Record<string, unknown>;
	annotations: Record<string, unknown>;
}

export interface KitManifestServer {
	id: string;
	version: string;
	title: string;
	/** The variables the server reads from its caller's environment, sorted; a host passes exactly these through. */
	environment: string[];
	tools: KitManifestTool[];
}

/** The policy PanCode ships for its built-in MCP servers: every server's tools with their class, path arguments and listed surface. */
export interface KitManifest {
	version: 1;
	servers: KitManifestServer[];
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The environment entries sorted, or an error naming the first that is not a name or a prefix of four or more characters and `*`. */
function environmentEntries(id: string, environment: ReadonlyArray<string>): string[] {
	for (const entry of environment) {
		const name = entry.endsWith("*") ? entry.slice(0, -1) : entry;
		if (!ENVIRONMENT_NAME.test(name) || (name !== entry && name.length < 4)) {
			throw new Error(
				`server ${id}: environment entry ${JSON.stringify(entry)} is not a variable name or a prefix of at least four characters followed by *`,
			);
		}
	}
	if (new Set(environment).size !== environment.length)
		throw new Error(`server ${id}: environment lists an entry twice`);
	return [...environment].sort();
}

/** One server's manifest entry, tools sorted by name and `environment` the names it reads from its caller. */
export function manifestServer(server: ToolServer, environment: ReadonlyArray<string> = []): KitManifestServer {
	const byName = new Map(server.tools.map((tool) => [tool.name, tool]));
	const tools = policyManifest(server).tools.map((policy): KitManifestTool => {
		const tool = byName.get(policy.name);
		if (tool === undefined) throw new Error(`server ${server.id}: no tool named ${policy.name}`);
		const listed = listedTool(tool);
		return {
			name: policy.name,
			actionClass: policy.actionClass,
			pathArguments: policy.pathArguments,
			inputSchema: listed.inputSchema as Record<string, unknown>,
			annotations: listed.annotations as Record<string, unknown>,
		};
	});
	return {
		id: server.id,
		version: server.version,
		title: server.title ?? server.id,
		environment: environmentEntries(server.id, environment),
		tools,
	};
}

/** The manifest for every registered server, loading each one's definitions and calling nothing. */
export async function kitManifest(): Promise<KitManifest> {
	const servers: KitManifestServer[] = [];
	for (const entry of SERVERS) {
		const loaded = await loadServer(entry);
		servers.push(manifestServer(loaded.server, loaded.environment ?? []));
	}
	return { version: 1, servers };
}

/** The manifest as `servers.json` stores it. */
export function manifestText(manifest: KitManifest): string {
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}
