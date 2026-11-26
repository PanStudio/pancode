// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ToolServer } from "@pancode/sdk/tool";

/** An optional program or file a server reads when the host has it. */
export interface ProbeSource {
	name: string;
	found: boolean;
	/** Where it was found, or why it was not. */
	detail?: string;
}

/**
 * Whether a server can run on this host and, when it cannot, why. `sources`
 * names the optional programs and files it found; a probe looks them up
 * (`resolveProgram` for a program) and never runs one.
 */
export interface ServerProbe {
	available: boolean;
	reason?: string;
	sources?: ProbeSource[];
}

/**
 * What `configure` throws for an option it refuses. `pancode mcp serve` prints
 * its message and the module's `usage` on stderr and exits 2.
 */
export class ServerUsageError extends Error {
	override name = "ServerUsageError";
}

/**
 * What `./servers/<id>/index.js` exports. Its top level only defines: loading
 * it must not run a command, read site state or open a connection, so the
 * manifest generator (`pnpm kit:manifest`) can load every server on any host.
 * Touching the system is for a tool's `run` and for `probe`.
 *
 * A server's tool definitions never depend on its options: the manifest
 * PanCode ships is generated from the unconfigured module, so the surface the
 * server serves is the one the manifest records whatever options it is given.
 * Options decide what a call may reach, never which tools exist.
 */
export interface ServerModule {
	server: ToolServer;
	probe(): Promise<ServerProbe>;
	/**
	 * The variables the server reads from its caller's environment, which a
	 * host must pass through for it to work (an MCP host launches servers with
	 * a minimal environment). An entry is a name such as `SPACK_ROOT`, or a
	 * prefix of at least four characters followed by `*` (`LMOD_*`) for every
	 * variable whose name starts with it. The manifest lists them; never
	 * name a credential.
	 */
	environment?: ReadonlyArray<string>;
	/**
	 * Takes the options after `pancode mcp serve <server>`, once, before the server
	 * serves. Throws a `ServerUsageError` for an option it refuses. A server
	 * without it refuses every option.
	 */
	configure?(argv: ReadonlyArray<string>): void;
	/** The options `configure` takes, printed when it refuses one. */
	usage?: string;
	/** What `pancode mcp serve <server> --help` prints after the options, such as a sample input file. */
	example?: string;
}

export interface RegistryEntry {
	/** The server id, equal to the loaded `server.id`. */
	id: string;
	load(): Promise<ServerModule>;
}

/**
 * Every built-in MCP server, in the order `pancode mcp` lists them. Adding one
 * is an entry here, `{ id: "x", load: () => import("./servers/x/index.js") },`
 * on a line of its own, and its directory under `src/servers/`.
 *
 * The order is fixed: node, modules, spack, darshan, scidata, catalog, store.
 * Put a new entry at its place in that order.
 */
// biome-ignore format: one entry per line, so servers added in parallel merge cleanly
export const SERVERS: ReadonlyArray<RegistryEntry> = [
	{ id: "node", load: () => import("./servers/node/index.js") },
	{ id: "modules", load: () => import("./servers/modules/index.js") },
	{ id: "darshan", load: () => import("./servers/darshan/index.js") },
	{ id: "spack", load: () => import("./servers/spack/index.js") },
	{ id: "scidata", load: () => import("./servers/scidata/index.js") },
	{ id: "catalog", load: () => import("./servers/catalog/index.js") },
	{ id: "store", load: () => import("./servers/store/index.js") },
];

export function serverIds(): string[] {
	return SERVERS.map((entry) => entry.id);
}

export function findServer(id: string): RegistryEntry | undefined {
	return SERVERS.find((entry) => entry.id === id);
}

/** Load one server's module and check that its id is the one the registry names. */
export async function loadServer(entry: RegistryEntry): Promise<ServerModule> {
	const loaded = await entry.load();
	if (loaded.server.id !== entry.id)
		throw new Error(`registry entry ${entry.id} loaded a server whose id is ${loaded.server.id}`);
	return loaded;
}

/**
 * Hand a loaded server the options that followed `pancode mcp serve <id>`. Null
 * when it took them (or there were none), else the usage error text: a server
 * without `configure` refuses any option, and a `ServerUsageError` becomes its
 * message followed by the module's `usage`. Any other error propagates.
 */
export function configureServer(id: string, loaded: ServerModule, argv: ReadonlyArray<string>): string | null {
	if (loaded.configure === undefined) {
		return argv.length === 0 ? null : `server ${id} takes no options, got ${argv[0]}`;
	}
	try {
		loaded.configure(argv);
		return null;
	} catch (error) {
		if (!(error instanceof ServerUsageError)) throw error;
		const usage = loaded.usage?.trimEnd();
		return `${error.message}${usage !== undefined && usage.length > 0 ? `\n${usage}` : ""}`;
	}
}
