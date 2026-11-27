// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Builtin MCP servers: the PanKit servers PanCode ships, declared by the
 * policy manifest `packages/kit/servers.json` in the installed package. A
 * builtin server is trusted by authorship like the operator's own
 * declarations, and its tools' classes, path arguments and surface are the
 * manifest's: what PanCode ships is the policy, and nothing the server says
 * about itself or an operator approval overrides it. The manifest is read
 * strictly; an unknown field, a bad class or a malformed tool is a diagnostic
 * and contributes no server.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { storeRootOption } from "@pancode/store/paths";
import { sha256Hex } from "../../../core/hash.js";
import { resolvePackageRoot } from "../../../core/package-root.js";
import { isRecord } from "../../../core/type-guards.js";
import { resolvePancodeDirs } from "../../../core/xdg.js";
import {
	type McpConfigDiagnostic,
	type McpConfigLoadResult,
	type McpPathArgumentAccess,
	type McpServerDeclaration,
	type McpToolPathArguments,
	mcpProjectRoot,
	mcpServerDigest,
	mcpWritePathOnReadTool,
	readBoundedFileText,
} from "./config.js";
import { parsePassedVariables } from "./passed-environment.js";
import { type McpSurface, mcpSurface } from "./surface.js";

export const MCP_BUILTIN_MANIFEST_VERSION = 1;

/** A manifest larger than this is refused whole. */
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ID_MAX_CHARS = 64;
const TOOL_CLASSES = new Set(["read", "execute", "destructive"]);

/** Where the builtin servers come from: the policy manifest and the PanKit CLI that serves them. */
export interface McpBuiltinSource {
	manifestPath: string;
	/** The `pankit` entry run with `serve <id>`; a `.ts` entry runs through tsx. */
	entry: string;
}

/** One tool as the manifest ships it. */
export interface McpBuiltinTool {
	name: string;
	title: string;
	actionClass: "read" | "execute" | "destructive";
	pathArguments: Record<string, McpPathArgumentAccess>;
	inputSchema: Record<string, unknown>;
	annotations: Record<string, unknown>;
}

/** The shipped policy of one builtin server. */
export interface McpBuiltinPolicy {
	/** The PanKit server version the manifest was generated from. */
	version: string;
	title: string;
	/** What the server serves as `instructions`, when it has any. */
	instructions?: string;
	/**
	 * The variables the server reads from the environment PanCode runs in: a
	 * name, or a prefix ending in `*`. The launch passes exactly these; the
	 * names are in the declaration digest and the values never are.
	 */
	environment: string[];
	tools: McpBuiltinTool[];
	/** The surface the server must serve for any of its tools to run. */
	surface: McpSurface;
}

/**
 * The installed package's manifest and CLI. A built install runs the bundled
 * `dist/kit/cli.js`; a source run (tests, `pnpm run dev`) runs the TypeScript
 * entry of the checkout this module belongs to.
 */
export function defaultMcpBuiltinSource(): McpBuiltinSource {
	const root = resolvePackageRoot();
	const manifestPath = path.join(root, "packages/kit/servers.json");
	if (!import.meta.url.endsWith(".ts")) return { manifestPath, entry: path.join(root, "dist/kit/cli.js") };
	return { manifestPath, entry: fileURLToPath(new URL("../../../../packages/kit/src/cli.ts", import.meta.url)) };
}

const require = createRequire(import.meta.url);

/**
 * The command that runs the source's PanKit CLI with `argv`, as the builtin
 * scope launches it: this Node with the entry. A TypeScript entry loads
 * through tsx, resolved absolutely and given the checkout's tsconfig so the
 * child's cwd, which is the project, cannot shadow either.
 */
export function kitInvocation(
	source: Pick<McpBuiltinSource, "entry">,
	argv: ReadonlyArray<string>,
): { command: string; args: string[] } {
	const { entry } = source;
	if (!entry.endsWith(".ts")) return { command: process.execPath, args: [entry, ...argv] };
	const loaderApi = pathToFileURL(require.resolve("tsx/esm/api")).href;
	const tsconfig = fileURLToPath(new URL("../../../../tsconfig.json", import.meta.url));
	const register = `const { register } = await import(${JSON.stringify(loaderApi)}); register({ tsconfig: ${JSON.stringify(tsconfig)} });`;
	return {
		command: process.execPath,
		args: ["--import", `data:text/javascript,${encodeURIComponent(register)}`, entry, ...argv],
	};
}

/** The node arguments that run `entry` with `serve <id>`. */
function serveArgs(entry: string, id: string): string[] {
	return kitInvocation({ entry }, ["serve", id]).args;
}

/** What a session gives the builtin servers that take options at launch. */
export interface McpBuiltinLaunchContext {
	/** The session's store, for the `store` server: its roots (primary first), cache, project and writable tags. */
	store?: {
		roots: ReadonlyArray<{ name: string; path: string }>;
		/** The one root is a folder several hosts share (`store.backend: shared`), whose locks are leases. */
		shared?: boolean;
		cache: string;
		project: string;
		/** The project's `store.projectId`, so the server keys the store as the session does. */
		projectId?: string;
		writeTags: ReadonlyArray<string>;
	};
}

/**
 * The catalog file PanCode's builtin `catalog` server reads:
 * `<PanCode config dir>/science-data/catalog.json`. PanCode passes it as `--file`,
 * so a server PanCode launches never falls back to the operator's own
 * `~/.config/science-data/catalog.json` and an isolated PanCode home stays isolated.
 */
function mcpBuiltinCatalogFile(): string {
	return path.join(resolvePancodeDirs().config, "science-data", "catalog.json");
}

/**
 * The reader cache PanCode's builtin `scidata` server keeps:
 * `<PanCode cache dir>/pankit/data-readers`. PanCode passes it as `--cache`,
 * so a server PanCode launches never writes the operator's own
 * `~/.cache/pankit/data-readers`.
 */
function mcpBuiltinScidataCache(): string {
	return path.join(resolvePancodeDirs().cache, "pankit", "data-readers");
}

/**
 * The options one builtin server is started with, appended to its declared
 * args at spawn only. They name this home and this project, so they stay out
 * of the declaration and its digest, which are the same everywhere; an option
 * never changes a server's tool surface. Empty for every server but `store`,
 * `catalog` and `scidata`; the others keep no state of their own.
 */
export function mcpBuiltinLaunchArgs(id: string, context: McpBuiltinLaunchContext): string[] {
	if (id === "catalog") return ["--file", mcpBuiltinCatalogFile()];
	if (id === "scidata") return ["--cache", mcpBuiltinScidataCache()];
	if (id !== "store" || context.store === undefined) return [];
	const { roots, shared, cache, project, projectId, writeTags } = context.store;
	return [
		...roots.flatMap((root, index) => ["--root", storeRootOption(root, index === 0)]),
		...(shared === true ? ["--shared"] : []),
		"--cache",
		cache,
		"--project",
		project,
		...(projectId !== undefined ? ["--project-id", projectId] : []),
		...[...new Set(writeTags)].sort().flatMap((tag) => ["--write-tag", tag]),
	];
}

function unknownFields(record: Record<string, unknown>, allowed: ReadonlyArray<string>): string[] {
	return Object.keys(record)
		.filter((key) => !allowed.includes(key))
		.sort();
}

function missingFields(record: Record<string, unknown>, required: ReadonlyArray<string>): string[] {
	return required.filter((key) => !Object.hasOwn(record, key));
}

function fieldProblem(record: Record<string, unknown>, fields: ReadonlyArray<string>, location: string): string | null {
	const extra = unknownFields(record, fields);
	if (extra.length > 0) return `${location} has unknown field${extra.length === 1 ? "" : "s"} ${extra.join(", ")}`;
	const missing = missingFields(record, fields);
	if (missing.length > 0) return `${location} is missing ${missing.join(", ")}`;
	return null;
}

function parseTool(value: unknown, location: string): McpBuiltinTool | string {
	if (!isRecord(value)) return `${location} must be an object`;
	const problem = fieldProblem(
		value,
		["name", "title", "actionClass", "pathArguments", "inputSchema", "annotations"],
		location,
	);
	if (problem !== null) return problem;
	const { name, title, actionClass, pathArguments, inputSchema, annotations } = value;
	if (typeof name !== "string" || name.length === 0) return `${location}.name must be a non-empty string`;
	if (typeof title !== "string" || title.length === 0) return `${location}.title must be a non-empty string`;
	if (typeof actionClass !== "string" || !TOOL_CLASSES.has(actionClass)) {
		return `${location}.actionClass must be one of read, execute, destructive`;
	}
	if (!isRecord(pathArguments)) return `${location}.pathArguments must be an object`;
	for (const [argument, access] of Object.entries(pathArguments)) {
		if (access !== "read" && access !== "write") {
			return `${location}.pathArguments.${argument} must be read or write`;
		}
	}
	if (!isRecord(inputSchema)) return `${location}.inputSchema must be an object`;
	if (!isRecord(annotations)) return `${location}.annotations must be an object`;
	return {
		name,
		title,
		actionClass: actionClass as McpBuiltinTool["actionClass"],
		pathArguments: pathArguments as Record<string, McpPathArgumentAccess>,
		inputSchema,
		annotations,
	};
}

interface ManifestServer {
	id: string;
	version: string;
	title: string;
	instructions?: string;
	environment: string[];
	tools: McpBuiltinTool[];
}

function parseServer(value: unknown, location: string): ManifestServer | string {
	if (!isRecord(value)) return `${location} must be an object`;
	const { instructions, ...required } = value;
	const problem = fieldProblem(required, ["id", "version", "title", "environment", "tools"], location);
	if (problem !== null) return problem;
	const { id, version, title, tools } = value;
	if (typeof id !== "string" || id.length > ID_MAX_CHARS || !ID_PATTERN.test(id)) {
		return `${location}.id must match /^[a-z0-9][a-z0-9_-]*$/ within ${ID_MAX_CHARS} characters`;
	}
	if (typeof version !== "string" || version.length === 0) return `${location}.version must be a non-empty string`;
	if (typeof title !== "string" || title.length === 0) return `${location}.title must be a non-empty string`;
	if (instructions !== undefined && (typeof instructions !== "string" || instructions.length === 0)) {
		return `${location}.instructions must be a non-empty string`;
	}
	const environment = parsePassedVariables(value.environment, `${location}.environment`);
	if (typeof environment === "string") return environment;
	if (!Array.isArray(tools)) return `${location}.tools must be an array`;
	const parsed: McpBuiltinTool[] = [];
	const names = new Set<string>();
	for (const [index, entry] of tools.entries()) {
		const tool = parseTool(entry, `${location}.tools[${index}]`);
		if (typeof tool === "string") return tool;
		if (names.has(tool.name)) return `${location} lists tool ${tool.name} twice`;
		names.add(tool.name);
		parsed.push(tool);
	}
	return { id, version, title, ...(instructions !== undefined ? { instructions } : {}), environment, tools: parsed };
}

function declarationOf(server: ManifestServer, source: McpBuiltinSource, root: string): McpServerDeclaration | string {
	const args = serveArgs(source.entry, server.id);
	const toolActionClasses = Object.fromEntries(server.tools.map((tool) => [tool.name, tool.actionClass]));
	const toolPathArguments: McpToolPathArguments = Object.fromEntries(
		server.tools.flatMap((tool) =>
			Object.keys(tool.pathArguments).length > 0 ? [[tool.name, { ...tool.pathArguments }]] : [],
		),
	);
	const contradiction = mcpWritePathOnReadTool({ toolActionClasses, toolPathArguments }, "unknown");
	if (contradiction !== null) {
		return `server ${server.id} gives read tool ${contradiction.tool} write path argument ${contradiction.argument}`;
	}
	const surface = mcpSurface(server.tools);
	const declared = mcpServerDigest({
		id: server.id,
		command: process.execPath,
		args,
		cwd: null,
		env: {},
		timeoutMs: null,
		toolActionClasses,
		toolPathArguments,
	});
	// The declaration digest covers the classes and path arguments; the surface
	// digest covers each tool's schema and annotations. The environment is the
	// names alone, so a session with other values attests the same digest.
	const digest = sha256Hex(
		JSON.stringify({
			declared,
			version: server.version,
			title: server.title,
			...(server.instructions !== undefined ? { instructions: server.instructions } : {}),
			environment: server.environment,
			surface: surface.digest,
		}),
	);
	return {
		id: server.id,
		scope: "builtin",
		path: source.manifestPath,
		command: process.execPath,
		args,
		cwd: root,
		cwdRoot: root,
		env: {},
		timeoutMs: null,
		actionClass: "unknown",
		toolActionClasses,
		...(Object.keys(toolPathArguments).length > 0 ? { toolPathArguments } : {}),
		actionClassExplicit: true,
		digest,
		builtin: {
			version: server.version,
			title: server.title,
			...(server.instructions !== undefined ? { instructions: server.instructions } : {}),
			environment: server.environment,
			tools: server.tools,
			surface,
		},
	};
}

/**
 * The builtin servers the manifest declares, each starting in the project
 * root of `cwd`. An absent manifest declares none; a malformed one declares
 * none and says why, and a malformed server entry drops that server alone.
 */
export function loadMcpBuiltinServers(cwd: string, source: McpBuiltinSource): McpConfigLoadResult {
	const fail = (message: string): McpConfigDiagnostic => ({ scope: "builtin", path: source.manifestPath, message });
	const read = readBoundedFileText(source.manifestPath, MANIFEST_MAX_BYTES);
	if (!read.ok) {
		return read.reason === "missing"
			? { servers: [], diagnostics: [] }
			: { servers: [], diagnostics: [fail(read.message)] };
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(read.text);
	} catch (error) {
		return { servers: [], diagnostics: [fail(`not JSON (${error instanceof Error ? error.message : String(error)})`)] };
	}
	if (!isRecord(manifest)) return { servers: [], diagnostics: [fail("the manifest must be an object")] };
	const problem = fieldProblem(manifest, ["version", "servers"], "the manifest");
	if (problem !== null) return { servers: [], diagnostics: [fail(problem)] };
	if (manifest.version !== MCP_BUILTIN_MANIFEST_VERSION) {
		return { servers: [], diagnostics: [fail(`version must be ${MCP_BUILTIN_MANIFEST_VERSION}`)] };
	}
	if (!Array.isArray(manifest.servers)) return { servers: [], diagnostics: [fail("servers must be an array")] };
	const projectRoot = mcpProjectRoot(cwd);
	let root: string;
	try {
		root = realpathSync(projectRoot);
	} catch {
		root = projectRoot;
	}
	const servers: McpServerDeclaration[] = [];
	const diagnostics: McpConfigDiagnostic[] = [];
	const ids = new Set<string>();
	for (const [index, entry] of manifest.servers.entries()) {
		const parsed = parseServer(entry, `servers[${index}]`);
		if (typeof parsed === "string") {
			diagnostics.push(fail(`${parsed}; the server is not declared`));
			continue;
		}
		if (ids.has(parsed.id)) {
			diagnostics.push(fail(`servers[${index}] repeats id ${parsed.id}; the later entry is not declared`));
			continue;
		}
		ids.add(parsed.id);
		const declaration = declarationOf(parsed, source, root);
		if (typeof declaration === "string") {
			diagnostics.push(fail(`${declaration}; the server is not declared`));
			continue;
		}
		servers.push(declaration);
	}
	return { servers, diagnostics };
}
