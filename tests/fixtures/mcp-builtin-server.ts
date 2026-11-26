// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A stand-in for the PanKit CLI in builtin-scope tests, written with the SDK
 * a PanKit server uses: `serve <id>` serves one of the servers below over
 * stdio. Tests build the injected policy manifest from the same definitions,
 * so the shipped surface matches what this process serves unless a test
 * edits the manifest.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveStdio } from "@pancode/sdk/mcp-server";
import { defineServer, defineTool, type ToolServer } from "@pancode/sdk/tool";
import { type KitManifest, manifestServer, manifestText } from "../../packages/kit/src/manifest.js";
import type { McpBuiltinSource } from "../../src/domains/gateway/mcp/index.js";

const echo = defineTool({
	name: "echo",
	description: "Echo the text back.",
	input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	actionClass: "read",
	idempotent: true,
	run: (args: { text: string }) => ({ text: `echo: ${args.text}` }),
});

const stamp = defineTool({
	name: "stamp",
	description: "Name the file a stamp would be written to.",
	input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	actionClass: "execute",
	pathArguments: { path: "write" },
	run: (args: { path: string }) => ({ json: { stamped: args.path } }),
});

const env = defineTool({
	name: "env",
	description: "Return the value of a named environment variable, or null when it is unset.",
	input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
	actionClass: "read",
	run: (args: { name: string }) => ({ json: { name: args.name, value: process.env[args.name] ?? null } }),
});

const slurmList = defineTool({
	name: "slurm_list",
	description: "List queued jobs.",
	input: { type: "object", properties: {} },
	actionClass: "read",
	run: () => ({ json: { jobs: [] } }),
});

const slurmSubmit = defineTool({
	name: "slurm_submit",
	description: "Submit a batch script.",
	input: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
	actionClass: "execute",
	run: (args: { script: string }) => ({ json: { submitted: args.script, jobId: 42 } }),
});

/** Stands in for PanKit's store server: one put that reports the options it was started with instead of storing. */
const storePut = defineTool({
	name: "store_put",
	description: "Report the argv this server was started with after serve store.",
	input: {
		type: "object",
		properties: { tag: { type: "string" }, source: { type: "string" }, blob: { type: "string" } },
		required: ["tag"],
	},
	actionClass: "execute",
	pathArguments: { source: "read" },
	run: (args: { tag: string; source?: string; blob?: string }) => ({
		json: { argv: process.argv.slice(process.argv.indexOf("serve") + 2), args },
	}),
});

const SERVERS: Record<string, ToolServer> = {
	kitfix: defineServer({ id: "kitfix", version: "0.0.1", title: "Kit fixture", tools: [echo, stamp, env] }),
	slurm: defineServer({ id: "slurm", version: "0.0.1", title: "Slurm fixture", tools: [slurmList, slurmSubmit] }),
	store: defineServer({ id: "store", version: "0.0.1", title: "Store fixture", tools: [storePut] }),
};

/** The fixture server with `id`, or undefined. */
export function builtinFixtureServer(id: string): ToolServer | undefined {
	return Object.hasOwn(SERVERS, id) ? SERVERS[id] : undefined;
}

/**
 * Write a policy manifest for the fixture servers `ids` into `dir` and return
 * the builtin source that serves them from this file. `edit` changes the
 * manifest before it is written, so it can ship a surface the fixture does not
 * serve or give a server the `environment` it is launched with.
 */
export function builtinFixtureSource(
	dir: string,
	ids: ReadonlyArray<string>,
	edit?: (manifest: KitManifest) => void,
): McpBuiltinSource {
	const manifest: KitManifest = {
		version: 1,
		servers: ids.map((id) => {
			const server = builtinFixtureServer(id);
			if (server === undefined) throw new Error(`no fixture server ${id}`);
			return manifestServer(server);
		}),
	};
	edit?.(manifest);
	const manifestPath = join(dir, "servers.json");
	writeFileSync(manifestPath, manifestText(manifest));
	return { manifestPath, entry: fileURLToPath(import.meta.url) };
}

/**
 * A builtin source that ships no server, for tests about other scopes: the
 * default source reads the real manifest, whose servers would join their lists.
 */
export function emptyBuiltinSource(dir: string): McpBuiltinSource {
	return builtinFixtureSource(dir, []);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, id] = process.argv.slice(2);
	const server = id === undefined ? undefined : builtinFixtureServer(id);
	if (command !== "serve" || server === undefined) {
		process.stderr.write(`usage: serve <${Object.keys(SERVERS).join("|")}>\n`);
		process.exit(2);
	}
	await serveStdio(server);
}
