// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Explicit trust for project-declared MCP servers. A repository can ship
 * `.pancode/mcp.yaml`, and cloning a repository must not launch anything,
 * so a project server runs only once the operator records a trust decision
 * for that exact declaration. The record binds the project root, the server
 * id, and the declaration digest: change the command, arguments, environment,
 * cwd, or timeout and the record is stale until the operator re-trusts it.
 * A project server that runs files inside the project (`node ./tools/x.mjs`)
 * also binds each entry file's SHA-256, so editing one makes the record stale;
 * files an entry imports are not covered. An entry reached through a symlink
 * also binds where the link points, so repointing it makes the record stale.
 * User-scope declarations are trusted by authorship; they carry no record.
 * A plugin's declarations need the same explicit record as a project's, and
 * their digest covers the plugin's content digest.
 *
 * A record may also carry the operator's network grant for that server's
 * sandboxed process in a fleet worker. The grant sits outside the digest and
 * lasts until untrust or a re-trust without --network replaces the record.
 *
 * Launch trust lets a server start; the tools it then serves need a second
 * approval, the surface digest (surface.ts). A project or plugin record holds
 * it beside launch trust. A user-scope server has no record, since authorship
 * trusts its launch, so its surface sits in a separate list that never reads
 * as launch approval. Both are optional, so a file written before them loads
 * unchanged and its servers read as surface unapproved.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { parseEgressAllowEntry } from "../../core/sandbox/egress/policy.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { isRecord } from "../../core/type-guards.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import {
	loadMcpServerConfig,
	type McpConfigDiagnostic,
	type McpServerDeclaration,
	type McpServerEntryScript,
	type McpToolPathArguments,
	mcpProjectRoot,
	mcpWritePathOnReadTool,
	readBoundedFileText,
} from "./config.js";
import type { McpSurface } from "./surface.js";

export const MCP_TRUST_FILENAME = "mcp-trust.json";
const MCP_TRUST_VERSION = 1;

/**
 * Bounds on the trust file, read on every resolve; a file past either is unusable until repaired. The record
 * cap counts launch records, user-scope surface records and skill approvals together.
 */
export const MCP_TRUST_CAPS = Object.freeze({
	fileBytes: 1024 * 1024,
	records: 256,
});

export const MCP_TRUST_ACTION_CLASSES = ["read", "execute", "destructive", "unknown"] as const;
export type McpTrustActionClass = (typeof MCP_TRUST_ACTION_CLASSES)[number];

export interface McpTrustRecord {
	/** Canonical (realpath) project root the record applies to. */
	projectRoot: string;
	id: string;
	digest: string;
	/** The action class the gateway gives this server's tools. */
	actionClass: McpTrustActionClass;
	trustedAt: string;
	/** Absent unless granted, so version 1 files written before the grant read unchanged. */
	network?: true;
	/** Egress origins a confined server reaches through PanCode's proxy in the main session (P8); absent when none. */
	allow?: string[];
	/** Each bound project entry file's hash at trust time, by path, so a stale reason can name the script. */
	entryScriptHashes?: Record<string, string>;
	/** The tool surface the operator approved; absent until approved, so earlier files read unchanged. */
	surface?: McpApprovedSurface;
}

/** A surface the operator approved, or an attended session recorded on first sight of a user-scope server. */
export interface McpApprovedSurface extends McpSurface {
	approvedAt: string;
}

/**
 * The recorded surface of a user-scope server. It binds the declaration digest
 * it was recorded under and grants nothing about launch, which authorship
 * already decides; a changed declaration has no recorded surface.
 */
export interface McpUserSurfaceRecord {
	id: string;
	digest: string;
	surface: McpApprovedSurface;
}

/**
 * The operator's approval of one version of a skill an MCP server serves. It
 * binds the server's identity (its id and declaration digest, and the project
 * for a project or plugin server), the skill's uri, and the sha256 over the
 * skill's whole manifest; a changed manifest or declaration no longer matches.
 */
export interface McpSkillApproval {
	/** Canonical project root for a project or plugin server; absent for a user-scope server. */
	projectRoot?: string;
	id: string;
	/** The server's declaration digest when approved. */
	digest: string;
	uri: string;
	name: string;
	/** `sha256:<hex>` over the uri, frontmatter and every file's uri, digest and size. */
	manifestDigest: string;
	files: number;
	bytes: number;
	approvedAt: string;
}

export interface McpTrustState {
	version: typeof MCP_TRUST_VERSION;
	records: McpTrustRecord[];
	/** Absent when empty, so a file without user-scope surfaces keeps its earlier shape. */
	surfaces?: McpUserSurfaceRecord[];
	/** Absent when empty, so a file without skill approvals keeps its earlier shape. */
	skills?: McpSkillApproval[];
}

export type McpTrustStatus =
	| {
			status: "trusted";
			actionClass: McpTrustActionClass;
			/** The operator granted this server's sandboxed process network in fleet workers. */
			network?: true;
			/** `host:port` origins the server reaches through PanCode's proxy when the operator confines it. */
			allow?: string[];
			/**
			 * The approved tool surface; absent when none is recorded. Launch trust
			 * stands either way, and only judgeMcpSurface decides whether calls run.
			 */
			surface?: McpApprovedSurface;
	  }
	| { status: "untrusted"; actionClass: "unknown"; reason: string }
	| { status: "stale"; actionClass: "unknown"; reason: string };

export type ResolvedMcpServer = McpServerDeclaration & {
	trust: McpTrustStatus;
};

export interface McpTrustOptions {
	cwd: string;
	/** Override for the user config directory; defaults to pancodeConfigDir(). */
	configDir?: string;
}

export interface McpTrustReadResult {
	state: McpTrustState;
	/** Non-empty when the file exists but could not be used; the state is then empty. */
	diagnostics: string[];
}

function isActionClass(value: unknown): value is McpTrustActionClass {
	return typeof value === "string" && (MCP_TRUST_ACTION_CLASSES as ReadonlyArray<string>).includes(value);
}

export function mcpTrustPath(configDir?: string): string {
	return path.join(configDir ?? pancodeConfigDir(), MCP_TRUST_FILENAME);
}

/**
 * The project identity a trust record binds to. The metadata cache keys on the
 * same value so a declaration trusted in one checkout cannot be read back as a
 * catalog for a different checkout of the same repository.
 */
export function canonicalProjectRoot(cwd: string): string {
	const resolved = mcpProjectRoot(cwd);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function parseSurface(raw: unknown, where: string): McpApprovedSurface | Error {
	if (!isRecord(raw)) return new Error(`${where} must be an object`);
	if (typeof raw.digest !== "string" || !SHA256_HEX.test(raw.digest)) {
		return new Error(`${where}.digest must be a SHA-256 hex digest`);
	}
	if (typeof raw.approvedAt !== "string" || raw.approvedAt.length === 0) {
		return new Error(`${where}.approvedAt must be a non-empty string`);
	}
	const tools = raw.tools;
	if (
		!isRecord(tools) ||
		Object.values(tools).some((value) => typeof value !== "string" || !/^[0-9a-f]{16}$/u.test(value))
	) {
		return new Error(`${where}.tools must map tool names to 16-character hex digests`);
	}
	return { digest: raw.digest, tools: { ...(tools as Record<string, string>) }, approvedAt: raw.approvedAt };
}

function parseTrustState(text: string): McpTrustState | Error {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		return new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed) || parsed.version !== MCP_TRUST_VERSION) {
		return new Error(`trust state must be a version ${MCP_TRUST_VERSION} object`);
	}
	if (!Array.isArray(parsed.records)) return new Error("trust state records must be an array");
	if (parsed.surfaces !== undefined && !Array.isArray(parsed.surfaces)) {
		return new Error("trust state surfaces must be an array");
	}
	if (parsed.skills !== undefined && !Array.isArray(parsed.skills)) {
		return new Error("trust state skills must be an array");
	}
	const rawSurfaces: unknown[] = parsed.surfaces ?? [];
	const rawSkills: unknown[] = parsed.skills ?? [];
	if (parsed.records.length + rawSurfaces.length + rawSkills.length > MCP_TRUST_CAPS.records) {
		return new Error(`trust state exceeds the ${MCP_TRUST_CAPS.records}-record cap`);
	}
	const records: McpTrustRecord[] = [];
	for (const [index, raw] of parsed.records.entries()) {
		if (!isRecord(raw)) return new Error(`records[${index}] must be an object`);
		for (const field of ["projectRoot", "id", "digest", "trustedAt"] as const) {
			if (typeof raw[field] !== "string" || raw[field].length === 0) {
				return new Error(`records[${index}].${field} must be a non-empty string`);
			}
		}
		if (!isActionClass(raw.actionClass)) {
			return new Error(`records[${index}].actionClass must be one of ${MCP_TRUST_ACTION_CLASSES.join(", ")}`);
		}
		if (raw.network !== undefined && typeof raw.network !== "boolean") {
			return new Error(`records[${index}].network must be true or false`);
		}
		if (
			raw.allow !== undefined &&
			(!Array.isArray(raw.allow) ||
				raw.allow.some((entry) => typeof entry !== "string" || typeof parseEgressAllowEntry(entry) === "string"))
		) {
			return new Error(`records[${index}].allow must list exact host:port origins`);
		}
		const hashes = raw.entryScriptHashes;
		if (
			hashes !== undefined &&
			(!isRecord(hashes) ||
				Object.values(hashes).some((value) => typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)))
		) {
			return new Error(`records[${index}].entryScriptHashes must map paths to SHA-256 hex digests`);
		}
		const surface = raw.surface === undefined ? undefined : parseSurface(raw.surface, `records[${index}].surface`);
		if (surface instanceof Error) return surface;
		records.push({
			projectRoot: raw.projectRoot as string,
			id: raw.id as string,
			digest: raw.digest as string,
			actionClass: raw.actionClass,
			trustedAt: raw.trustedAt as string,
			...(raw.network === true ? { network: true as const } : {}),
			...(Array.isArray(raw.allow) && raw.allow.length > 0 ? { allow: [...(raw.allow as string[])] } : {}),
			...(isRecord(hashes) ? { entryScriptHashes: { ...(hashes as Record<string, string>) } } : {}),
			...(surface !== undefined ? { surface } : {}),
		});
	}
	const surfaces: McpUserSurfaceRecord[] = [];
	for (const [index, raw] of rawSurfaces.entries()) {
		if (!isRecord(raw)) return new Error(`surfaces[${index}] must be an object`);
		for (const field of ["id", "digest"] as const) {
			if (typeof raw[field] !== "string" || raw[field].length === 0) {
				return new Error(`surfaces[${index}].${field} must be a non-empty string`);
			}
		}
		const surface = parseSurface(raw.surface, `surfaces[${index}].surface`);
		if (surface instanceof Error) return surface;
		surfaces.push({ id: raw.id as string, digest: raw.digest as string, surface });
	}
	const skills: McpSkillApproval[] = [];
	for (const [index, raw] of rawSkills.entries()) {
		if (!isRecord(raw)) return new Error(`skills[${index}] must be an object`);
		for (const field of ["id", "digest", "uri", "name", "approvedAt"] as const) {
			if (typeof raw[field] !== "string" || raw[field].length === 0) {
				return new Error(`skills[${index}].${field} must be a non-empty string`);
			}
		}
		if (raw.projectRoot !== undefined && (typeof raw.projectRoot !== "string" || raw.projectRoot.length === 0)) {
			return new Error(`skills[${index}].projectRoot must be a non-empty string`);
		}
		if (typeof raw.manifestDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(raw.manifestDigest)) {
			return new Error(`skills[${index}].manifestDigest must be sha256:<64 lowercase hex>`);
		}
		for (const field of ["files", "bytes"] as const) {
			const value = raw[field];
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
				return new Error(`skills[${index}].${field} must be a non-negative integer`);
			}
		}
		skills.push({
			...(typeof raw.projectRoot === "string" ? { projectRoot: raw.projectRoot } : {}),
			id: raw.id as string,
			digest: raw.digest as string,
			uri: raw.uri as string,
			name: raw.name as string,
			manifestDigest: raw.manifestDigest,
			files: raw.files as number,
			bytes: raw.bytes as number,
			approvedAt: raw.approvedAt as string,
		});
	}
	return {
		version: MCP_TRUST_VERSION,
		records,
		...(surfaces.length > 0 ? { surfaces } : {}),
		...(skills.length > 0 ? { skills } : {}),
	};
}

/**
 * Read the trust file through a bounded read. A missing file is an empty
 * state; an oversized, over-populated, or corrupt one is empty with a
 * diagnostic, and nothing here ever rewrites it.
 */
export function readMcpTrustState(configDir?: string): McpTrustReadResult {
	const filePath = mcpTrustPath(configDir);
	const empty: McpTrustState = { version: MCP_TRUST_VERSION, records: [] };
	const read = readBoundedFileText(filePath, MCP_TRUST_CAPS.fileBytes);
	if (!read.ok) {
		if (read.reason === "missing") return { state: empty, diagnostics: [] };
		return { state: empty, diagnostics: [`${filePath}: ${read.message}`] };
	}
	const parsed = parseTrustState(read.text);
	if (parsed instanceof Error) return { state: empty, diagnostics: [`${filePath}: ${parsed.message}`] };
	return { state: parsed, diagnostics: [] };
}

/** Persist the state, or name why it would not be readable again under the caps. */
function writeTrustState(state: Omit<McpTrustState, "version">, configDir?: string): string | null {
	const { records, surfaces, skills } = state;
	if (records.length + (surfaces?.length ?? 0) + (skills?.length ?? 0) > MCP_TRUST_CAPS.records) {
		return `trust state would exceed the ${MCP_TRUST_CAPS.records}-record cap; untrust servers you no longer use first`;
	}
	const sorted = [...records].sort(
		(left, right) => left.projectRoot.localeCompare(right.projectRoot) || left.id.localeCompare(right.id),
	);
	const sortedSurfaces = [...(surfaces ?? [])].sort(
		(left, right) => left.id.localeCompare(right.id) || left.digest.localeCompare(right.digest),
	);
	const sortedSkills = [...(skills ?? [])].sort(
		(left, right) =>
			(left.projectRoot ?? "").localeCompare(right.projectRoot ?? "") ||
			left.id.localeCompare(right.id) ||
			left.uri.localeCompare(right.uri),
	);
	const text = `${JSON.stringify(
		{
			version: MCP_TRUST_VERSION,
			records: sorted,
			...(sortedSurfaces.length > 0 ? { surfaces: sortedSurfaces } : {}),
			...(sortedSkills.length > 0 ? { skills: sortedSkills } : {}),
		},
		null,
		2,
	)}\n`;
	if (Buffer.byteLength(text, "utf8") > MCP_TRUST_CAPS.fileBytes) {
		return `trust state would exceed the ${MCP_TRUST_CAPS.fileBytes}-byte cap; untrust servers you no longer use first`;
	}
	safeResourceWrite(mcpTrustPath(configDir), text, { mode: 0o600 });
	return null;
}

function unreadableEntry(entries: ReadonlyArray<McpServerEntryScript>): { path: string; error: string } | undefined {
	for (const entry of entries) if ("error" in entry) return entry;
	return undefined;
}

function entryPathList(entries: ReadonlyArray<McpServerEntryScript>): string {
	return entries.map((entry) => `'${entry.path}'`).join(", ");
}

function unreadableEntryMessage(id: string, entry: { path: string; error: string }): string {
	return `project-scope server '${id}' runs entry script '${entry.path}', which cannot be read to bind its trust (${entry.error})`;
}

function trustStatusFor(server: McpServerDeclaration, projectRoot: string, state: McpTrustState): McpTrustStatus {
	if (server.scope === "user") {
		const recorded = state.surfaces?.find((item) => item.id === server.id && item.digest === server.digest)?.surface;
		return {
			status: "trusted",
			actionClass: server.actionClass,
			...(server.network === true ? { network: true } : {}),
			...(server.allow !== undefined ? { allow: server.allow } : {}),
			...(recorded !== undefined ? { surface: recorded } : {}),
		};
	}
	const entries = server.entryScripts ?? [];
	const unreadable = unreadableEntry(entries);
	if (unreadable !== undefined) {
		return { status: "untrusted", actionClass: "unknown", reason: unreadableEntryMessage(server.id, unreadable) };
	}
	const record = state.records.find((item) => item.projectRoot === projectRoot && item.id === server.id);
	const origin = server.plugin !== undefined ? ` from plugin ${server.plugin.id}` : "";
	if (server.plugin?.core === true && record?.digest !== server.digest) {
		// The files are the ones PanCode ships pinned; per-tool classes come from its mcp.json.
		const recorded = state.surfaces?.find((item) => item.id === server.id && item.digest === server.digest)?.surface;
		return { status: "trusted", actionClass: "unknown", ...(recorded !== undefined ? { surface: recorded } : {}) };
	}
	if (record === undefined) {
		return {
			status: "untrusted",
			actionClass: "unknown",
			reason: `${server.scope}-scope server '${server.id}'${origin} requires explicit trust: pancode mcp trust ${server.id}`,
		};
	}
	if (record.digest !== server.digest) {
		if (entries.length > 0 && record.digest === server.digestWithoutEntryScript) {
			// Trusted before entry binding (386f1fea6): nothing changed but what the trust covers.
			return {
				status: "stale",
				actionClass: "unknown",
				reason: `trust of '${server.id}' now also covers the entry script${entries.length === 1 ? "" : "s"} ${entryPathList(entries)}; review ${entries.length === 1 ? "it" : "them"} and run pancode mcp trust ${server.id} again`,
			};
		}
		const hashes = record.entryScriptHashes;
		const changed =
			hashes === undefined
				? undefined
				: entries.find(
						(entry) => "sha256" in entry && Object.hasOwn(hashes, entry.path) && hashes[entry.path] !== entry.sha256,
					);
		if (changed !== undefined) {
			return {
				status: "stale",
				actionClass: "unknown",
				reason: `entry script '${changed.path}' of '${server.id}' changed since it was trusted (trust covers that file, not what it imports); review it and run pancode mcp trust ${server.id} again`,
			};
		}
		return {
			status: "stale",
			actionClass: "unknown",
			reason: `declaration of '${server.id}'${origin} changed (${server.url !== undefined ? "url, headers" : "command, args, env, cwd"}, timeout, ${server.plugin !== undefined ? "tool action classes, or the plugin's content" : entries.length > 0 ? "tool action classes, or entry scripts" : "or tool action classes"}) since it was trusted; review it and run pancode mcp trust ${server.id} again`,
		};
	}
	return {
		status: "trusted",
		actionClass: record.actionClass,
		...(record.network === true ? { network: true } : {}),
		...(record.allow !== undefined ? { allow: record.allow } : {}),
		...(record.surface !== undefined ? { surface: record.surface } : {}),
	};
}

export interface ResolvedMcpServers {
	servers: ResolvedMcpServer[];
	diagnostics: McpConfigDiagnostic[];
	/** Trust-file problems, separate from config diagnostics. */
	trustDiagnostics: string[];
}

/** Every declared server with its trust status; the gateway launches only `trusted` entries. */
export function resolveMcpServers(options: McpTrustOptions): ResolvedMcpServers {
	const loaded = loadMcpServerConfig(options);
	const trust = readMcpTrustState(options.configDir);
	const projectRoot = canonicalProjectRoot(options.cwd);
	return {
		servers: loaded.servers.map((server) => ({ ...server, trust: trustStatusFor(server, projectRoot, trust.state) })),
		diagnostics: loaded.diagnostics,
		trustDiagnostics: trust.diagnostics,
	};
}

/**
 * The surface approval the trust state holds now for `server` as this caller
 * resolved it, or undefined when there is none or its launch is no longer
 * trusted. A session reads it again before refusing a call, so an approval
 * the operator records mid-session counts from the next call.
 */
export function currentMcpSurfaceApproval(
	server: McpServerDeclaration,
	options: McpTrustOptions,
): McpApprovedSurface | undefined {
	const trust = readMcpTrustState(options.configDir);
	const status = trustStatusFor(server, canonicalProjectRoot(options.cwd), trust.state);
	return status.status === "trusted" ? status.surface : undefined;
}

export interface TrustMcpServerOptions extends McpTrustOptions {
	id: string;
	actionClass?: McpTrustActionClass;
	/** Grant the server's sandboxed process network in fleet workers; omitting it records no grant. */
	network?: boolean;
	/** `host:port` origins the server reaches through PanCode's proxy when the operator confines it; empty records none. */
	allow?: ReadonlyArray<string>;
	now?: () => Date;
}

export type TrustMcpServerResult =
	/**
	 * `entry` lists the project files the record binds; empty when it pins none.
	 * `entryScripts` carries each binding's real path and hash for display, and
	 * `toolActionClasses` the per-tool classes the trusted declaration carries,
	 * and `toolPathArguments` the path arguments it declares.
	 */
	| {
			ok: true;
			record: McpTrustRecord;
			entry: string[];
			entryScripts: McpServerEntryScript[];
			toolActionClasses: Record<string, McpTrustActionClass>;
			toolPathArguments: McpToolPathArguments;
	  }
	| { ok: false; message: string };

/** Record trust for one project-declared server at its current digest. */
export function trustMcpServer(options: TrustMcpServerOptions): TrustMcpServerResult {
	return withStateFileLockSync(mcpTrustPath(options.configDir), () => trustMcpServerLocked(options));
}

function trustMcpServerLocked(options: TrustMcpServerOptions): TrustMcpServerResult {
	const actionClass = options.actionClass ?? "unknown";
	if (!isActionClass(actionClass)) {
		return { ok: false, message: `actionClass must be one of ${MCP_TRUST_ACTION_CLASSES.join(", ")}` };
	}
	const loaded = loadMcpServerConfig(options);
	const server = loaded.servers.find((entry) => entry.id === options.id);
	if (server === undefined) {
		const problems = loaded.diagnostics.map((entry) => `${entry.path}: ${entry.message}`);
		return {
			ok: false,
			message:
				`no declared MCP server with id '${options.id}'` +
				(problems.length > 0 ? `; config diagnostics: ${problems.join("; ")}` : ""),
		};
	}
	if (server.scope === "user") {
		return { ok: false, message: `server '${options.id}' is a user-scope declaration; it is trusted by authorship` };
	}
	const contradiction = mcpWritePathOnReadTool(server, actionClass);
	if (contradiction !== null) {
		return {
			ok: false,
			message: `server '${server.id}' declares write path argument '${contradiction.argument}' for tool ${contradiction.tool}, which action class ${actionClass} would class read; a read tool writes nothing, so give that tool another class in toolActionClasses or trust another class`,
		};
	}
	const entries = server.entryScripts ?? [];
	const unreadable = unreadableEntry(entries);
	if (unreadable !== undefined) return { ok: false, message: unreadableEntryMessage(server.id, unreadable) };
	const trust = readMcpTrustState(options.configDir);
	if (trust.diagnostics.length > 0) {
		return { ok: false, message: `trust state is unusable; repair or remove it first: ${trust.diagnostics.join("; ")}` };
	}
	const projectRoot = canonicalProjectRoot(options.cwd);
	const hashes = Object.fromEntries(entries.flatMap((entry) => ("sha256" in entry ? [[entry.path, entry.sha256]] : [])));
	// A surface approval judges what the process serves, which a re-trust does not change, so it carries over.
	const previous = trust.state.records.find((entry) => entry.projectRoot === projectRoot && entry.id === server.id);
	const coreSurface =
		previous?.surface === undefined && server.plugin?.core === true
			? trust.state.surfaces?.find((entry) => entry.id === server.id && entry.digest === server.digest)?.surface
			: undefined;
	const carriedSurface = previous?.surface ?? coreSurface;
	const record: McpTrustRecord = {
		projectRoot,
		id: server.id,
		digest: server.digest,
		actionClass,
		trustedAt: (options.now?.() ?? new Date()).toISOString(),
		...(options.network === true ? { network: true as const } : {}),
		...(options.allow !== undefined && options.allow.length > 0 ? { allow: [...new Set(options.allow)] } : {}),
		...(Object.keys(hashes).length > 0 ? { entryScriptHashes: hashes } : {}),
		...(carriedSurface !== undefined ? { surface: carriedSurface } : {}),
	};
	const records = trust.state.records.filter((entry) => !(entry.projectRoot === projectRoot && entry.id === server.id));
	records.push(record);
	const refused = writeTrustState({ ...trust.state, records }, options.configDir);
	if (refused !== null) return { ok: false, message: refused };
	return {
		ok: true,
		record,
		entry: entries.map((entry) => entry.path),
		entryScripts: entries,
		toolActionClasses: { ...server.toolActionClasses },
		toolPathArguments: { ...server.toolPathArguments },
	};
}

export type UntrustMcpServerResult = { ok: true; removed: boolean } | { ok: false; message: string };

/** Remove the trust record for one server in this project, whether or not it is still declared. */
export function untrustMcpServer(options: McpTrustOptions & { id: string }): UntrustMcpServerResult {
	return withStateFileLockSync(mcpTrustPath(options.configDir), () => untrustMcpServerLocked(options));
}

function untrustMcpServerLocked(options: McpTrustOptions & { id: string }): UntrustMcpServerResult {
	const trust = readMcpTrustState(options.configDir);
	if (trust.diagnostics.length > 0) {
		return { ok: false, message: `trust state is unusable; repair or remove it first: ${trust.diagnostics.join("; ")}` };
	}
	const projectRoot = canonicalProjectRoot(options.cwd);
	const records = trust.state.records.filter((entry) => !(entry.projectRoot === projectRoot && entry.id === options.id));
	const beforeSkills = trust.state.skills ?? [];
	// Untrusting a server also drops its skill approvals in this project so re-trusting never revives old approvals.
	const skills = beforeSkills.filter((entry) => !(entry.projectRoot === projectRoot && entry.id === options.id));
	const removed = records.length !== trust.state.records.length || skills.length !== beforeSkills.length;
	if (removed) {
		const refused = writeTrustState({ ...trust.state, records, skills }, options.configDir);
		if (refused !== null) return { ok: false, message: refused };
	}
	return { ok: true, removed };
}

/** Remove the recorded surface and skill approvals of one user-scope server, whether or not it is still declared. */
export function revokeMcpUserTrust(options: McpTrustOptions & { id: string }): UntrustMcpServerResult {
	return withStateFileLockSync(mcpTrustPath(options.configDir), () => {
		const trust = readMcpTrustState(options.configDir);
		if (trust.diagnostics.length > 0) {
			return {
				ok: false,
				message: `trust state is unusable; repair or remove it first: ${trust.diagnostics.join("; ")}`,
			};
		}
		const beforeSurfaces = trust.state.surfaces ?? [];
		const surfaces = beforeSurfaces.filter((entry) => entry.id !== options.id);
		const beforeSkills = trust.state.skills ?? [];
		const skills = beforeSkills.filter((entry) => !(entry.projectRoot === undefined && entry.id === options.id));
		const removed = surfaces.length !== beforeSurfaces.length || skills.length !== beforeSkills.length;
		if (removed) {
			const refused = writeTrustState({ ...trust.state, surfaces, skills }, options.configDir);
			if (refused !== null) return { ok: false, message: refused };
		}
		return { ok: true, removed };
	});
}

export interface ApproveMcpSurfaceOptions extends McpTrustOptions {
	id: string;
	/** The surface the server serves now, as the operator reviewed it. */
	surface: McpSurface;
	/** Refuse unless the served surface hashes to this reviewed digest. */
	expectedDigest?: string;
	now?: () => Date;
}

export type ApproveMcpSurfaceResult = { ok: true; surface: McpApprovedSurface } | { ok: false; message: string };

/**
 * Record the operator's approval of the surface a launch-trusted server serves.
 * A project or plugin server must hold current launch trust; the approval is
 * written onto that record and grants nothing about launch. A user-scope
 * server's surface, and that of a core plugin trusted without a record, goes
 * into the separate surface list under its declaration digest.
 */
export function approveMcpSurface(options: ApproveMcpSurfaceOptions): ApproveMcpSurfaceResult {
	return withStateFileLockSync(mcpTrustPath(options.configDir), () => approveMcpSurfaceLocked(options));
}

function approveMcpSurfaceLocked(options: ApproveMcpSurfaceOptions): ApproveMcpSurfaceResult {
	if (options.expectedDigest !== undefined && options.expectedDigest !== options.surface.digest) {
		return {
			ok: false,
			message: `the tool surface of '${options.id}' changed since review: it serves ${options.surface.digest}, not ${options.expectedDigest}; inspect it again before approving`,
		};
	}
	const trust = readMcpTrustState(options.configDir);
	if (trust.diagnostics.length > 0) {
		return { ok: false, message: `trust state is unusable; repair or remove it first: ${trust.diagnostics.join("; ")}` };
	}
	const loaded = loadMcpServerConfig(options);
	const server = loaded.servers.find((entry) => entry.id === options.id);
	if (server === undefined) return { ok: false, message: `no declared MCP server with id '${options.id}'` };
	const projectRoot = canonicalProjectRoot(options.cwd);
	const status = trustStatusFor(server, projectRoot, trust.state);
	if (status.status !== "trusted") {
		return {
			ok: false,
			message: `server '${options.id}' is ${status.status} (${status.reason}); approve its launch first`,
		};
	}
	const approved: McpApprovedSurface = {
		digest: options.surface.digest,
		tools: { ...options.surface.tools },
		approvedAt: (options.now?.() ?? new Date()).toISOString(),
	};
	let records = trust.state.records;
	let surfaces = trust.state.surfaces ?? [];
	const onRecord = records.some(
		(entry) => entry.projectRoot === projectRoot && entry.id === server.id && entry.digest === server.digest,
	);
	if (server.scope === "user" || (server.plugin?.core === true && !onRecord)) {
		surfaces = [
			...surfaces.filter((entry) => entry.id !== server.id),
			{ id: server.id, digest: server.digest, surface: approved },
		];
	} else {
		records = records.map((entry) =>
			entry.projectRoot === projectRoot && entry.id === server.id ? { ...entry, surface: approved } : entry,
		);
	}
	const refused = writeTrustState({ ...trust.state, records, surfaces }, options.configDir);
	if (refused !== null) return { ok: false, message: refused };
	return { ok: true, surface: approved };
}

/** Whether one served version of a skill is the version the operator approved. */
export type McpSkillApprovalStatus =
	| { status: "approved"; approval: McpSkillApproval }
	| { status: "unapproved" }
	| { status: "changed"; approval: McpSkillApproval; reason: string };

/** The project a skill approval binds to: a project or plugin server's checkout, none for a user-scope server. */
function skillApprovalRoot(server: McpServerDeclaration, projectRoot: string): string | undefined {
	return server.scope === "project" || server.scope === "plugin" ? projectRoot : undefined;
}

function findSkillApproval(
	state: McpTrustState,
	server: McpServerDeclaration,
	projectRoot: string,
	uri: string,
): McpSkillApproval | undefined {
	const root = skillApprovalRoot(server, projectRoot);
	return state.skills?.find((entry) => entry.id === server.id && entry.uri === uri && entry.projectRoot === root);
}

/**
 * Judge a served skill version against an approval. The approval holds only
 * for the declaration it was given under and the exact manifest it bound.
 */
export function judgeMcpSkillApproval(
	approval: McpSkillApproval | undefined,
	server: Pick<McpServerDeclaration, "id" | "digest">,
	served: { uri: string; name: string; manifestDigest: string },
): McpSkillApprovalStatus {
	if (approval === undefined) return { status: "unapproved" };
	const remedy = `pancode mcp trust ${server.id} --skill ${served.name}`;
	if (approval.digest !== server.digest) {
		return {
			status: "changed",
			approval,
			reason: `the declaration of MCP server '${server.id}' changed since skill ${served.name} was approved; review it and run ${remedy}`,
		};
	}
	if (approval.manifestDigest !== served.manifestDigest) {
		return {
			status: "changed",
			approval,
			reason: `skill ${served.name} of MCP server '${server.id}' changed since it was approved: it serves manifest ${served.manifestDigest}, not the approved ${approval.manifestDigest}; review it and run ${remedy}`,
		};
	}
	return { status: "approved", approval };
}

/** The approval the trust state holds now for one skill of `server`, read fresh so a mid-session approval counts. */
export function currentMcpSkillApproval(
	server: McpServerDeclaration,
	uri: string,
	options: McpTrustOptions,
): McpSkillApproval | undefined {
	const trust = readMcpTrustState(options.configDir);
	return findSkillApproval(trust.state, server, canonicalProjectRoot(options.cwd), uri);
}

/** Every skill approval recorded for `server` in this project, whichever version it binds. */
export function mcpSkillApprovalsFor(server: McpServerDeclaration, options: McpTrustOptions): McpSkillApproval[] {
	const trust = readMcpTrustState(options.configDir);
	const root = skillApprovalRoot(server, canonicalProjectRoot(options.cwd));
	return (trust.state.skills ?? []).filter((entry) => entry.id === server.id && entry.projectRoot === root);
}

export interface ApproveMcpSkillOptions extends McpTrustOptions {
	id: string;
	/** The skill version the operator reviewed. */
	skill: { uri: string; name: string; manifestDigest: string; files: number; bytes: number };
	now?: () => Date;
}

export type ApproveMcpSkillResult = { ok: true; approval: McpSkillApproval } | { ok: false; message: string };

/**
 * Record the operator's approval of one skill version a launch-trusted server
 * serves, replacing any approval of an earlier version of the same skill.
 */
export function approveMcpSkill(options: ApproveMcpSkillOptions): ApproveMcpSkillResult {
	return withStateFileLockSync(mcpTrustPath(options.configDir), () => approveMcpSkillLocked(options));
}

function approveMcpSkillLocked(options: ApproveMcpSkillOptions): ApproveMcpSkillResult {
	const trust = readMcpTrustState(options.configDir);
	if (trust.diagnostics.length > 0) {
		return { ok: false, message: `trust state is unusable; repair or remove it first: ${trust.diagnostics.join("; ")}` };
	}
	const server = loadMcpServerConfig(options).servers.find((entry) => entry.id === options.id);
	if (server === undefined) return { ok: false, message: `no declared MCP server with id '${options.id}'` };
	const projectRoot = canonicalProjectRoot(options.cwd);
	const status = trustStatusFor(server, projectRoot, trust.state);
	if (status.status !== "trusted") {
		return {
			ok: false,
			message: `server '${options.id}' is ${status.status} (${status.reason}); approve its launch first`,
		};
	}
	const root = skillApprovalRoot(server, projectRoot);
	const approval: McpSkillApproval = {
		...(root !== undefined ? { projectRoot: root } : {}),
		id: server.id,
		digest: server.digest,
		uri: options.skill.uri,
		name: options.skill.name,
		manifestDigest: options.skill.manifestDigest,
		files: options.skill.files,
		bytes: options.skill.bytes,
		approvedAt: (options.now?.() ?? new Date()).toISOString(),
	};
	const skills = [
		...(trust.state.skills ?? []).filter(
			(entry) => !(entry.id === server.id && entry.uri === approval.uri && entry.projectRoot === root),
		),
		approval,
	];
	const refused = writeTrustState({ ...trust.state, skills }, options.configDir);
	if (refused !== null) return { ok: false, message: refused };
	return { ok: true, approval };
}

/** Withdraw the approval of one skill of server `id` in this project, whether or not the server is still declared. */
export function revokeMcpSkill(options: McpTrustOptions & { id: string; uri: string }): UntrustMcpServerResult {
	return withStateFileLockSync(mcpTrustPath(options.configDir), () => {
		const trust = readMcpTrustState(options.configDir);
		if (trust.diagnostics.length > 0) {
			return {
				ok: false,
				message: `trust state is unusable; repair or remove it first: ${trust.diagnostics.join("; ")}`,
			};
		}
		const server = loadMcpServerConfig(options).servers.find((entry) => entry.id === options.id);
		const projectRoot = canonicalProjectRoot(options.cwd);
		const before = trust.state.skills ?? [];
		const skills = before.filter(
			(entry) =>
				!(
					entry.id === options.id &&
					entry.uri === options.uri &&
					(server === undefined || entry.projectRoot === skillApprovalRoot(server, projectRoot)) &&
					(entry.projectRoot === undefined || entry.projectRoot === projectRoot)
				),
		);
		const removed = skills.length !== before.length;
		if (removed) {
			const refused = writeTrustState({ ...trust.state, skills }, options.configDir);
			if (refused !== null) return { ok: false, message: refused };
		}
		return { ok: true, removed };
	});
}
