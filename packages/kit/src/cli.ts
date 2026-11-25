#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@pancode/sdk/mcp-server";
import { kitManifest, manifestText } from "./manifest.js";
import { configureServer, findServer, loadServer, SERVERS, type ServerProbe, serverIds } from "./registry.js";

const HELP = `pankit: PanKit's MCP tool servers for HPC and science

Usage:
  pankit serve <server> [options...]
                            serve one server over MCP stdio; the options go to
                            that server, and one that takes none refuses them
  pankit serve <server> --help
                            the options one server takes
  pankit list [--json]      the servers, their titles and tool counts
  pankit doctor [--json]    whether each server can run on this host, and why not
  pankit manifest           the policy manifest a host ships for these servers
  pankit catalog --example  a valid catalog file for the catalog server
  pankit --version
  pankit --help

Exit codes: 0 success, 1 operational failure, 2 usage error.
`;

interface Outcome {
	code: number;
	stdout?: string;
	stderr?: string;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The nearest package.json above this file: the kit's own, or the PanCode package that bundles the CLI. */
function version(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
			return typeof parsed.version === "string" ? parsed.version : "unknown";
		}
		const parent = dirname(dir);
		if (parent === dir) return "unknown";
		dir = parent;
	}
}

function knownServers(): string {
	const ids = serverIds();
	return ids.length > 0 ? `servers: ${ids.join(", ")}` : "no servers are registered";
}

function usage(text: string): Outcome {
	return { code: 2, stderr: `pankit: ${text}\nRun pankit --help for usage.\n` };
}

/** Splits `--json` off a command's arguments; anything else is a usage error. */
function jsonFlag(command: string, rest: ReadonlyArray<string>): boolean | Outcome {
	const extra = rest.filter((arg) => arg !== "--json");
	if (extra.length > 0) return usage(`${command} takes no argument ${extra[0]}`);
	return rest.includes("--json");
}

async function list(json: boolean): Promise<Outcome> {
	const rows: Array<{ id: string; title: string; version: string; tools: number }> = [];
	for (const entry of SERVERS) {
		try {
			const { server } = await loadServer(entry);
			rows.push({ id: server.id, title: server.title ?? server.id, version: server.version, tools: server.tools.length });
		} catch (error) {
			return { code: 1, stderr: `pankit list: ${entry.id}: ${message(error)}\n` };
		}
	}
	if (json) return { code: 0, stdout: `${JSON.stringify({ servers: rows }, null, 2)}\n` };
	if (rows.length === 0) return { code: 0, stdout: "no servers are registered\n" };
	const width = Math.max(...rows.map((row) => row.id.length));
	const lines = rows.map(
		(row) => `${row.id.padEnd(width)}  ${row.title} (${row.tools} ${row.tools === 1 ? "tool" : "tools"})`,
	);
	return { code: 0, stdout: `${lines.join("\n")}\n` };
}

async function doctor(json: boolean): Promise<Outcome> {
	const rows: Array<{ id: string } & ServerProbe> = [];
	let failed = false;
	for (const entry of SERVERS) {
		try {
			const probed = await (await loadServer(entry)).probe();
			rows.push({
				id: entry.id,
				available: probed.available === true,
				...(probed.reason !== undefined ? { reason: probed.reason } : {}),
				...(probed.sources !== undefined ? { sources: probed.sources } : {}),
			});
		} catch (error) {
			failed = true;
			rows.push({ id: entry.id, available: false, reason: `the probe failed: ${message(error)}` });
		}
	}
	const code = failed ? 1 : 0;
	if (json) return { code, stdout: `${JSON.stringify({ servers: rows }, null, 2)}\n` };
	if (rows.length === 0) return { code, stdout: "no servers are registered\n" };
	const lines = rows.map((row) => {
		// A reason is a sentence; its full stop would land before the "; sources:" that follows it.
		const reason = row.reason?.replace(/\.$/, "");
		const status = row.available ? "available" : `unavailable${reason ? `: ${reason}` : ""}`;
		const sources = (row.sources ?? []).map((source) => `${source.name} ${source.found ? "found" : "not found"}`);
		return `${row.id}: ${status}${sources.length > 0 ? `; sources: ${sources.join(", ")}` : ""}`;
	});
	return { code, stdout: `${lines.join("\n")}\n` };
}

async function manifest(): Promise<Outcome> {
	try {
		return { code: 0, stdout: manifestText(await kitManifest()) };
	} catch (error) {
		return { code: 1, stderr: `pankit manifest: ${message(error)}\n` };
	}
}

/** Every command but `serve`, which owns stdout for protocol frames. */
async function pankit(argv: ReadonlyArray<string>): Promise<Outcome> {
	const [command, ...rest] = argv;
	if (command === undefined) return { code: 2, stderr: HELP };
	if (command === "--help" || command === "-h" || command === "help") return { code: 0, stdout: HELP };
	if (command === "--version" || command === "-v") return { code: 0, stdout: `${version()}\n` };
	if (command === "list" || command === "doctor") {
		const json = jsonFlag(command, rest);
		if (typeof json !== "boolean") return json;
		return command === "list" ? list(json) : doctor(json);
	}
	if (command === "manifest") {
		if (rest.length > 0) return usage(`manifest takes no argument ${rest[0]}`);
		return manifest();
	}
	if (command === "catalog") {
		if (rest.length !== 1 || rest[0] !== "--example") return usage("usage: pankit catalog --example");
		const { CATALOG_EXAMPLE } = await import("./servers/catalog/example.js");
		return { code: 0, stdout: CATALOG_EXAMPLE };
	}
	return usage(`unknown command ${command}`);
}

const isHelp = (arg: string | undefined): boolean => arg === "--help" || arg === "-h";

const SERVE_HELP = `Usage: pankit serve <server> [options...]

Serves one server over MCP stdio until its client closes the connection. The
options go to that server; pankit serve <server> --help lists them.
`;

/** What `pankit serve <id> --help` prints: the server's title and the options it takes. */
function serverHelp(id: string, loaded: Awaited<ReturnType<typeof loadServer>>): string {
	const title = loaded.server.title ?? id;
	const options = loaded.usage?.trimEnd();
	if (loaded.configure === undefined || options === undefined || options.length === 0) {
		return `Usage: pankit serve ${id}\n\n${title}. This server takes no options.\n`;
	}
	return `Usage: pankit serve ${id} [options...]\n\n${title}.\n\n${options}\n`;
}

async function serve(rest: ReadonlyArray<string>): Promise<number> {
	const [id, ...options] = rest;
	if (isHelp(id)) {
		process.stdout.write(`${SERVE_HELP}\n${knownServers()}\n`);
		return 0;
	}
	if (id === undefined || id.startsWith("-")) {
		process.stderr.write(`pankit: usage: pankit serve <server> [options...]\n${knownServers()}\n`);
		return 2;
	}
	const entry = findServer(id);
	if (entry === undefined) {
		process.stderr.write(`pankit: unknown server ${id}\n${knownServers()}\n`);
		return 2;
	}
	let loaded: Awaited<ReturnType<typeof loadServer>>;
	try {
		loaded = await loadServer(entry);
	} catch (error) {
		process.stderr.write(`pankit serve ${id}: ${message(error)}\n`);
		return 1;
	}
	if (options.some(isHelp)) {
		process.stdout.write(serverHelp(id, loaded));
		return 0;
	}
	let refused: string | null;
	try {
		refused = configureServer(id, loaded, options);
	} catch (error) {
		process.stderr.write(`pankit serve ${id}: ${message(error)}\n`);
		return 1;
	}
	if (refused !== null) {
		process.stderr.write(`pankit serve ${id}: ${refused}\n`);
		return 2;
	}
	await serveStdio(loaded.server);
	return 0;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
	if (argv[0] === "serve") return serve(argv.slice(1));
	const outcome = await pankit(argv);
	if (outcome.stdout !== undefined) process.stdout.write(outcome.stdout);
	if (outcome.stderr !== undefined) process.stderr.write(outcome.stderr);
	return outcome.code;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`pankit: ${message(error)}\n`);
		process.exitCode = 1;
	},
);
