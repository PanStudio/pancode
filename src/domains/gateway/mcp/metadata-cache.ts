// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Persisted tool catalogs for declared local MCP servers.
 *
 * A server's tool list is machine state, not operator policy: it costs a
 * process launch and a handshake to learn, and it is the same answer every
 * session until the declaration or the server changes. Keeping the last
 * successful listing on disk lets the gateway answer find and describe without
 * launching anything, which is the only way an unrestricted find can stay
 * honest about what a session offers without spawning every trusted server to
 * produce that answer.
 *
 * A catalog is a snapshot and nothing more. It confers no authority: trust is
 * resolved from the trust file on every session, never read back from here, and
 * a call still validates against the live listing. Nothing that runs a server
 * is written here either, so a readable cache file cannot reconstruct a launch.
 */

import path from "node:path";
import { sha256Hex } from "../../../core/hash.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { isRecord } from "../../../core/type-guards.js";
import { pancodeCacheDir } from "../../../core/xdg.js";
import { MCP_INSTRUCTIONS_BYTES, MCP_TOOL_LIST_CAP, type McpToolDescriptor } from "./client.js";
import type { McpServerScope } from "./config.js";
import { readBoundedFileText } from "./config.js";
import { MCP_PROMPT_LIST_CAP } from "./resources.js";

export const MCP_METADATA_CACHE_VERSION = 1;

/**
 * How long a catalog is used before a live listing has to produce it again.
 * A day matches `TARGET_MODEL_CACHE_TTL_MS`, which solves the same problem for
 * provider model lists, and keeps a server that quietly gained or lost tools
 * from staying wrong across a week of sessions. A modern server's own `ttlMs`
 * only marks the catalog stale sooner (`mcpCatalogStale`); it never lengthens this.
 */
export const MCP_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Public decode limits; a file past any of them is a miss, never a partial read. */
export const MCP_METADATA_CACHE_CAPS = Object.freeze({
	/** 500 tools at a generous 2 KiB of schema each, with headroom. */
	fileBytes: 2 * 1024 * 1024,
	tools: MCP_TOOL_LIST_CAP,
	toolNameBytes: 512,
	descriptionBytes: 8 * 1024,
	schemaBytes: 64 * 1024,
	/** The client keeps at most MCP_INSTRUCTIONS_BYTES plus its truncation marker. */
	instructionsBytes: MCP_INSTRUCTIONS_BYTES + 64,
	prompts: MCP_PROMPT_LIST_CAP,
	promptArguments: 32,
	promptTextBytes: 1024,
});

const CACHE_SUBDIRECTORY = "mcp-catalogs";

/**
 * What a catalog belongs to. `mcpServerDigest()` covers the declaration's own
 * fields but a project-scope `cwd` is repository-relative, so two checkouts of
 * one repository produce identical digests for different processes on disk.
 * Binding the canonical project root and the resolved execution directory as
 * well keeps those two checkouts from sharing a catalog.
 */
export interface McpCatalogIdentity {
	projectRoot: string;
	scope: McpServerScope;
	/** The config file that declares the server. */
	declarationPath: string;
	serverId: string;
	/** sha256 of the canonical declaration, from `mcpServerDigest()`. */
	digest: string;
	/** Absolute working directory the server would start in. */
	cwd: string;
}

/** One tool as the gateway needs it offline: enough to list and to describe, never to authorize. */
export interface McpCachedTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, unknown> | null;
}

/** One prompt as a slash command needs it before the server runs: its name, its words and its arguments. */
export interface McpCachedPrompt {
	name: string;
	title?: string;
	description: string;
	arguments: Array<{ name: string; description: string; required: boolean }>;
}

/** The server's prompt list as of the catalog's listing. */
export interface McpCachedPrompts {
	prompts: McpCachedPrompt[];
	truncated: boolean;
	/** The freshness `prompts/list` gave, modern era only; past it the list is stale, never a miss. */
	ttlMs?: number;
}

export interface McpServerCatalog {
	version: typeof MCP_METADATA_CACHE_VERSION;
	projectRoot: string;
	scope: McpServerScope;
	declarationPath: string;
	serverId: string;
	digest: string;
	cwd: string;
	/**
	 * The listing that produced this catalog stopped at the client's tool or
	 * page cap, so the server offers more than is recorded here. Carried so a
	 * known-partial catalog never reads back as a complete one.
	 */
	truncated: boolean;
	observedAt: string;
	/**
	 * The freshness the server gave the listing, modern era only. Absent for a
	 * legacy listing, which is fresh until MCP_METADATA_CACHE_TTL_MS; 0 means
	 * the catalog is stale at once (MCP 2026-07-28 server/utilities/caching).
	 */
	ttlMs?: number;
	/** The server's own guidance, shown as server-written text beside its tools. */
	instructions?: string;
	/** The server declared the resources capability. */
	resources?: true;
	/** How many resources and templates its last resources/list gave. */
	resourceCount?: McpResourceCount;
	/** The server declared the completions capability. */
	completions?: true;
	/** Present when the server declared prompts and listed them. */
	prompts?: McpCachedPrompts;
	tools: McpCachedTool[];
}

export interface McpCatalogOptions {
	/** Override of the PanCode cache directory. */
	cacheDir?: string;
	nowMs?: number;
	ttlMs?: number;
}

/**
 * The file name covers only the parts of the identity that say *which server in
 * which project*. The digest and cwd are verified from the file body instead,
 * so a changed declaration replaces its own catalog rather than stranding the
 * old one on disk forever.
 */
function catalogKey(identity: McpCatalogIdentity): string {
	const canonical = JSON.stringify([identity.projectRoot, identity.scope, identity.declarationPath, identity.serverId]);
	return sha256Hex(canonical).slice(0, 32);
}

/** One file per declared server, so two sessions refreshing different servers never overwrite each other. */
export function mcpCatalogPath(identity: McpCatalogIdentity, cacheDir?: string): string {
	return path.join(cacheDir ?? pancodeCacheDir(), CACHE_SUBDIRECTORY, `${catalogKey(identity)}.json`);
}

function decodeTool(value: unknown): McpCachedTool | null {
	if (!isRecord(value)) return null;
	const { name, description, inputSchema } = value;
	if (typeof name !== "string" || name.length === 0) return null;
	if (Buffer.byteLength(name, "utf8") > MCP_METADATA_CACHE_CAPS.toolNameBytes) return null;
	if (typeof description !== "string") return null;
	if (Buffer.byteLength(description, "utf8") > MCP_METADATA_CACHE_CAPS.descriptionBytes) return null;
	if (!isRecord(inputSchema)) return null;
	if (Buffer.byteLength(JSON.stringify(inputSchema), "utf8") > MCP_METADATA_CACHE_CAPS.schemaBytes) return null;
	const annotations = value.annotations;
	if (annotations !== undefined && annotations !== null && !isRecord(annotations)) return null;
	if (
		isRecord(annotations) &&
		Buffer.byteLength(JSON.stringify(annotations), "utf8") > MCP_METADATA_CACHE_CAPS.schemaBytes
	)
		return null;
	const hints = isRecord(annotations)
		? Object.fromEntries(
				["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].flatMap((key) =>
					typeof annotations[key] === "boolean" ? [[key, annotations[key]]] : [],
				),
			)
		: {};
	return { name, description, inputSchema, ...(Object.keys(hints).length === 0 ? {} : { annotations: hints }) };
}

function boundedText(value: unknown, required: boolean): value is string {
	if (typeof value !== "string") return false;
	if (required && value.length === 0) return false;
	return Buffer.byteLength(value, "utf8") <= MCP_METADATA_CACHE_CAPS.promptTextBytes;
}

function decodePrompt(value: unknown): McpCachedPrompt | null {
	if (!isRecord(value) || !boundedText(value.name, true) || !boundedText(value.description, false)) return null;
	if (value.title !== undefined && !boundedText(value.title, true)) return null;
	if (!Array.isArray(value.arguments) || value.arguments.length > MCP_METADATA_CACHE_CAPS.promptArguments) return null;
	const args: McpCachedPrompt["arguments"] = [];
	for (const entry of value.arguments) {
		if (!isRecord(entry) || !boundedText(entry.name, true) || !boundedText(entry.description, false)) return null;
		if (typeof entry.required !== "boolean") return null;
		args.push({ name: entry.name, description: entry.description, required: entry.required });
	}
	return {
		name: value.name,
		...(typeof value.title === "string" ? { title: value.title } : {}),
		description: value.description,
		arguments: args,
	};
}

function decodePrompts(value: unknown): McpCachedPrompts | null {
	if (!isRecord(value) || typeof value.truncated !== "boolean") return null;
	const { ttlMs } = value;
	if (ttlMs !== undefined && (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < 0)) return null;
	if (!Array.isArray(value.prompts) || value.prompts.length > MCP_METADATA_CACHE_CAPS.prompts) return null;
	const prompts: McpCachedPrompt[] = [];
	const seen = new Set<string>();
	for (const entry of value.prompts) {
		const prompt = decodePrompt(entry);
		if (prompt === null || seen.has(prompt.name)) return null;
		seen.add(prompt.name);
		prompts.push(prompt);
	}
	return { prompts, truncated: value.truncated, ...(ttlMs === undefined ? {} : { ttlMs }) };
}

/** Decode a whole file or reject it. A single bad tool fails the catalog: half a listing is not a listing. */
export interface McpResourceCount {
	resources: number;
	templates: number;
	truncated?: true;
}

function decodeResourceCount(value: unknown): McpResourceCount | null {
	if (!isRecord(value)) return null;
	const { resources, templates, truncated } = value;
	const count = (entry: unknown): entry is number => Number.isSafeInteger(entry) && (entry as number) >= 0;
	if (!count(resources) || !count(templates) || (truncated !== undefined && truncated !== true)) return null;
	return { resources, templates, ...(truncated === true ? { truncated } : {}) };
}

function decodeCatalog(value: unknown): McpServerCatalog | null {
	if (!isRecord(value)) return null;
	if (value.version !== MCP_METADATA_CACHE_VERSION) return null;
	for (const field of ["projectRoot", "declarationPath", "serverId", "digest", "cwd", "observedAt"]) {
		const entry = value[field];
		if (typeof entry !== "string" || entry.length === 0) return null;
	}
	if (value.scope !== "user" && value.scope !== "project" && value.scope !== "plugin" && value.scope !== "builtin")
		return null;
	if (typeof value.truncated !== "boolean") return null;
	if (!Number.isFinite(Date.parse(value.observedAt as string))) return null;
	const { ttlMs, instructions } = value;
	if (ttlMs !== undefined && (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < 0)) return null;
	if (
		instructions !== undefined &&
		(typeof instructions !== "string" ||
			Buffer.byteLength(instructions, "utf8") > MCP_METADATA_CACHE_CAPS.instructionsBytes)
	)
		return null;
	if (value.resources !== undefined && value.resources !== true) return null;
	if (value.completions !== undefined && value.completions !== true) return null;
	const resourceCount = value.resourceCount === undefined ? undefined : decodeResourceCount(value.resourceCount);
	if (resourceCount === null) return null;
	const prompts = value.prompts === undefined ? undefined : decodePrompts(value.prompts);
	if (prompts === null) return null;
	if (!Array.isArray(value.tools) || value.tools.length > MCP_METADATA_CACHE_CAPS.tools) return null;
	const tools: McpCachedTool[] = [];
	const seen = new Set<string>();
	for (const entry of value.tools) {
		const tool = decodeTool(entry);
		if (tool === null || seen.has(tool.name)) return null;
		seen.add(tool.name);
		tools.push(tool);
	}
	return {
		version: MCP_METADATA_CACHE_VERSION,
		projectRoot: value.projectRoot as string,
		scope: value.scope,
		declarationPath: value.declarationPath as string,
		serverId: value.serverId as string,
		digest: value.digest as string,
		cwd: value.cwd as string,
		truncated: value.truncated,
		observedAt: value.observedAt as string,
		...(ttlMs === undefined ? {} : { ttlMs }),
		...(instructions === undefined ? {} : { instructions }),
		...(value.resources === true ? { resources: true as const } : {}),
		...(resourceCount === undefined ? {} : { resourceCount }),
		...(value.completions === true ? { completions: true as const } : {}),
		...(prompts === undefined ? {} : { prompts }),
		tools,
	};
}

/**
 * The last recorded catalog for this exact declaration, or null.
 *
 * Malformed, oversized, version-mismatched, identity-mismatched, future-dated
 * and expired files are all the same answer: a miss. There is no degraded hit,
 * because every caller of a degraded hit would have to decide separately
 * whether to trust it.
 */
export function readMcpServerCatalog(
	identity: McpCatalogIdentity,
	options: McpCatalogOptions = {},
): McpServerCatalog | null {
	let file: string;
	try {
		file = mcpCatalogPath(identity, options.cacheDir);
	} catch {
		// A cache root that cannot be made is a missing catalog, as an unwritable one is a skipped write.
		return null;
	}
	const read = readBoundedFileText(file, MCP_METADATA_CACHE_CAPS.fileBytes);
	if (!read.ok) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.text) as unknown;
	} catch {
		return null;
	}
	const catalog = decodeCatalog(parsed);
	if (catalog === null) return null;
	if (
		catalog.projectRoot !== identity.projectRoot ||
		catalog.scope !== identity.scope ||
		catalog.declarationPath !== identity.declarationPath ||
		catalog.serverId !== identity.serverId ||
		catalog.digest !== identity.digest ||
		catalog.cwd !== identity.cwd
	) {
		return null;
	}
	const observedMs = Date.parse(catalog.observedAt);
	const nowMs = options.nowMs ?? Date.now();
	const ttlMs = options.ttlMs ?? MCP_METADATA_CACHE_TTL_MS;
	if (observedMs > nowMs || nowMs - observedMs >= ttlMs) return null;
	return catalog;
}

/**
 * The server's own `ttlMs` has passed. A stale catalog still answers discovery,
 * labelled stale, because discovery never launches a server to fetch it again;
 * the next live connection lists the tools again, and a call is checked against
 * that live listing, never against this catalog.
 */
export function mcpCatalogStale(catalog: McpServerCatalog, nowMs: number = Date.now()): boolean {
	return catalog.ttlMs !== undefined && nowMs - Date.parse(catalog.observedAt) >= catalog.ttlMs;
}

/** The prompt list's own `ttlMs` has passed: still the list the slash menu shows, labelled stale. */
export function mcpPromptsStale(catalog: McpServerCatalog, nowMs: number = Date.now()): boolean {
	const ttlMs = catalog.prompts?.ttlMs;
	return ttlMs !== undefined && nowMs - Date.parse(catalog.observedAt) >= ttlMs;
}

function cappedTtl(ttlMs: number | undefined): { ttlMs?: number } {
	return ttlMs === undefined ? {} : { ttlMs: Math.min(MCP_METADATA_CACHE_TTL_MS, Math.max(0, Math.floor(ttlMs))) };
}

/** A prompt as the writer takes it: a live descriptor, or the recorded one carried over. */
interface McpPromptRecord {
	name: string;
	title?: string | null;
	description: string;
	arguments: ReadonlyArray<{ name: string; description: string; required: boolean }>;
}

/** A prompt the decoder would reject is dropped and the list marked truncated, as with tools. */
function encodePrompts(listing: {
	prompts: ReadonlyArray<McpPromptRecord>;
	truncated: boolean;
	ttlMs?: number;
}): McpCachedPrompts {
	const prompts: McpCachedPrompt[] = [];
	const seen = new Set<string>();
	for (const prompt of listing.prompts.slice(0, MCP_METADATA_CACHE_CAPS.prompts)) {
		const encoded = decodePrompt({
			name: prompt.name,
			...(typeof prompt.title === "string" ? { title: prompt.title } : {}),
			description: prompt.description,
			arguments: prompt.arguments.map((entry) => ({
				name: entry.name,
				description: entry.description,
				required: entry.required,
			})),
		});
		if (encoded === null || seen.has(encoded.name)) continue;
		seen.add(encoded.name);
		prompts.push(encoded);
	}
	return {
		prompts,
		truncated: listing.truncated || prompts.length !== listing.prompts.length,
		...cappedTtl(listing.ttlMs),
	};
}

/**
 * Replace one server's catalog atomically. Returns false rather than throwing:
 * a cache that cannot be written must never fail the live tool listing that
 * produced it.
 */
export function writeMcpServerCatalog(
	identity: McpCatalogIdentity,
	listing: {
		tools: ReadonlyArray<McpToolDescriptor>;
		truncated: boolean;
		ttlMs?: number;
		instructions?: string | null;
		resources?: boolean;
		resourceCount?: McpResourceCount | null;
		completions?: boolean;
		prompts?: { prompts: ReadonlyArray<McpPromptRecord>; truncated: boolean; ttlMs?: number } | null;
	},
	options: Pick<McpCatalogOptions, "cacheDir" | "nowMs"> = {},
): boolean {
	if (listing.tools.length > MCP_METADATA_CACHE_CAPS.tools) return false;
	const tools: McpCachedTool[] = [];
	for (const tool of listing.tools) {
		const encoded = decodeTool({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
		});
		// A tool the decoder would reject on the way back in is dropped rather
		// than written, so a round trip is never the thing that invalidates a file.
		if (encoded !== null) tools.push(encoded);
	}
	const catalog: McpServerCatalog = {
		version: MCP_METADATA_CACHE_VERSION,
		projectRoot: identity.projectRoot,
		scope: identity.scope,
		declarationPath: identity.declarationPath,
		serverId: identity.serverId,
		digest: identity.digest,
		cwd: identity.cwd,
		// A tool dropped above is as much missing catalog as one the client's cap cut.
		truncated: listing.truncated || tools.length !== listing.tools.length,
		observedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
		...cappedTtl(listing.ttlMs),
		...(typeof listing.instructions === "string" &&
		Buffer.byteLength(listing.instructions, "utf8") <= MCP_METADATA_CACHE_CAPS.instructionsBytes
			? { instructions: listing.instructions }
			: {}),
		...(listing.resources === true ? { resources: true as const } : {}),
		...(listing.resources === true && listing.resourceCount ? { resourceCount: listing.resourceCount } : {}),
		...(listing.completions === true ? { completions: true as const } : {}),
		...(listing.prompts ? { prompts: encodePrompts(listing.prompts) } : {}),
		tools,
	};
	const text = `${JSON.stringify(catalog, null, 2)}\n`;
	if (Buffer.byteLength(text, "utf8") > MCP_METADATA_CACHE_CAPS.fileBytes) return false;
	try {
		safeResourceWrite(mcpCatalogPath(identity, options.cacheDir), text, { encoding: "utf8", mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
