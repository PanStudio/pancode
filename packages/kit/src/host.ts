// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Serving and probing PanCode's built-in MCP servers. `pancode mcp serve` and
 * the entry a session's builtin scope launches (`cli.ts`) both serve through
 * `serveServer`; `pancode doctor` probes through that entry's `doctor`.
 */
import { serveStdio } from "@pancode/sdk/mcp-server";
import { configureServer, findServer, loadServer, SERVERS, type ServerProbe, serverIds } from "./registry.js";

const COMMAND = "pancode mcp serve";

/** The options a host adds to the ones a server was given: each it needs that the caller left out. */
export type ServeDefaults = (id: string, options: ReadonlyArray<string>) => string[];

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isHelp = (arg: string | undefined): boolean => arg === "--help" || arg === "-h";

function knownServers(): string {
	return `servers: ${serverIds().join(", ")}`;
}

const SERVE_HELP = `Usage: ${COMMAND} <server> [options...]

Serves one of PanCode's built-in MCP servers over stdio until its client closes
the connection. The options go to that server; ${COMMAND} <server> --help
lists them.
`;

/** What `pancode mcp serve <id> --help` prints: the server's title, the options it takes and what the host adds. */
function serverHelp(id: string, loaded: Awaited<ReturnType<typeof loadServer>>, added: ReadonlyArray<string>): string {
	const title = loaded.server.title ?? id;
	const options = loaded.usage?.trimEnd();
	if (loaded.configure === undefined || options === undefined || options.length === 0) {
		return `Usage: ${COMMAND} ${id}\n\n${title}. This server takes no options.\n`;
	}
	const defaults =
		added.length > 0 ? `\n\nPanCode adds each of these the command line leaves out:\n  ${added.join(" ")}` : "";
	const example = loaded.example !== undefined ? `\n\n${loaded.example.trimEnd()}` : "";
	return `Usage: ${COMMAND} ${id} [options...]\n\n${title}.\n\n${options}${defaults}${example}\n`;
}

/**
 * Serves `argv[0]` with the options after it, plus `defaults` for those left
 * out, until the client closes stdin. Stdout carries protocol frames only;
 * every message goes to stderr. Exit 0 served, 1 operational failure, 2 usage.
 */
export async function serveServer(argv: ReadonlyArray<string>, defaults: ServeDefaults = () => []): Promise<number> {
	const [id, ...given] = argv;
	if (isHelp(id)) {
		process.stdout.write(`${SERVE_HELP}\n${knownServers()}\n`);
		return 0;
	}
	if (id === undefined || id.startsWith("-")) {
		process.stderr.write(`usage: ${COMMAND} <server> [options...]\n${knownServers()}\n`);
		return 2;
	}
	const entry = findServer(id);
	if (entry === undefined) {
		process.stderr.write(`${COMMAND}: unknown server ${id}\n${knownServers()}\n`);
		return 2;
	}
	let loaded: Awaited<ReturnType<typeof loadServer>>;
	try {
		loaded = await loadServer(entry);
	} catch (error) {
		process.stderr.write(`${COMMAND} ${id}: ${message(error)}\n`);
		return 1;
	}
	let refused: string | null;
	try {
		if (given.some(isHelp)) {
			process.stdout.write(
				serverHelp(
					id,
					loaded,
					defaults(
						id,
						given.filter((arg) => !isHelp(arg)),
					),
				),
			);
			return 0;
		}
		refused = configureServer(id, loaded, [...given, ...defaults(id, given)]);
	} catch (error) {
		process.stderr.write(`${COMMAND} ${id}: ${message(error)}\n`);
		return 1;
	}
	if (refused !== null) {
		process.stderr.write(`${COMMAND} ${id}: ${refused}\n`);
		return 2;
	}
	await serveStdio(loaded.server);
	return 0;
}

export type ServerReport = { id: string } & ServerProbe;

/**
 * Whether each server can run on this host and why not, each configured with
 * `options[id]` (none when absent) as a session would start it. Code 1 when a
 * probe failed or a server refused its options.
 */
export async function probeServers(
	options: Readonly<Record<string, ReadonlyArray<string>>>,
): Promise<{ code: number; servers: ServerReport[] }> {
	const servers: ServerReport[] = [];
	let failed = false;
	for (const entry of SERVERS) {
		try {
			const loaded = await loadServer(entry);
			const refused = configureServer(entry.id, loaded, options[entry.id] ?? []);
			if (refused !== null) throw new Error(refused.split("\n")[0]);
			const probed = await loaded.probe();
			servers.push({
				id: entry.id,
				available: probed.available === true,
				...(probed.reason !== undefined ? { reason: probed.reason } : {}),
				...(probed.sources !== undefined ? { sources: probed.sources } : {}),
			});
		} catch (error) {
			failed = true;
			servers.push({ id: entry.id, available: false, reason: `the probe failed: ${message(error)}` });
		}
	}
	return { code: failed ? 1 : 0, servers };
}
