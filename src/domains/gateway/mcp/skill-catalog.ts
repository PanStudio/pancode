// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The skills a trusted MCP server listed, recorded so a later session can name
 * them without launching the server. The record lists; it never authorizes and
 * never loads. Activation always asks the live server for the entry again and
 * binds the operator's approval to the manifest it returns, so an old record
 * can only ever cost a refusal, never admit unapproved content.
 *
 * Each skill keeps its identity (the `SKILL.md` uri), its frontmatter, and the
 * digest, file count and byte total of its manifest; the per-file list is not
 * recorded, because nothing reads a file from a record.
 */

import path from "node:path";
import { canonicalJson } from "../../../core/canonical-json.js";
import { boundedExternalDiagnostic } from "../../../core/external-diagnostic.js";
import { sha256Hex } from "../../../core/hash.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { isRecord } from "../../../core/type-guards.js";
import { pancodeCacheDir } from "../../../core/xdg.js";
import { type McpServerScope, readBoundedFileText } from "./config.js";
import { MCP_METADATA_CACHE_TTL_MS, type McpCatalogIdentity } from "./metadata-cache.js";
import {
	MCP_SKILL_FRONTMATTER_BYTES,
	MCP_SKILL_LIST_CAP,
	type McpSkillEntry,
	type McpSkillListing,
	type McpSkillRefusal,
	parseMcpSkillEntry,
} from "./skills.js";

const MCP_SKILL_CATALOG_VERSION = 1;

/** Public decode limits; a file past any of them is a miss, never a partial read. */
const MCP_SKILL_CATALOG_CAPS = Object.freeze({
	fileBytes: 8 * 1024 * 1024,
	entries: MCP_SKILL_LIST_CAP,
	reasonBytes: 1024,
});

const CACHE_SUBDIRECTORY = "mcp-skill-catalogs";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** One listed skill as a record keeps it: enough to name, describe and approve it, never to read it. */
export interface McpRecordedSkill {
	uri: string;
	name: string;
	description: string;
	skillPath: string;
	frontmatter: Record<string, unknown>;
	manifestDigest: string;
	files: number;
	bytes: number;
}

/**
 * One approved skill version a dispatched worker's admission attested. The
 * worker lists exactly these and loads one only while its server still serves
 * this manifest under this declaration; it reads no catalog or approval.
 */
export interface McpAttestedSkill extends McpRecordedSkill {
	serverId: string;
	serverScope: McpServerScope;
	/** The declaration digest the approval binds. */
	digest: string;
	/** The name the recipe binds and the run lists it by, `<server id>:<name>`. */
	displayName: string;
	/** When the server last listed it before admission. */
	observedAt: string;
}

export interface McpSkillCatalog {
	version: typeof MCP_SKILL_CATALOG_VERSION;
	projectRoot: string;
	scope: McpCatalogIdentity["scope"];
	declarationPath: string;
	serverId: string;
	digest: string;
	cwd: string;
	/** The listing stopped at PanCode's cap: the server offers more than is recorded. */
	truncated: boolean;
	/** The `ttlMs` the server sent with the listing, kept so an operator sees how fresh it said it was. */
	ttlMs: number;
	observedAt: string;
	skills: McpRecordedSkill[];
	refused: McpSkillRefusal[];
}

export interface McpSkillCatalogOptions {
	cacheDir?: string;
	nowMs?: number;
	ttlMs?: number;
}

function catalogKey(identity: McpCatalogIdentity): string {
	return sha256Hex(
		JSON.stringify([identity.projectRoot, identity.scope, identity.declarationPath, identity.serverId]),
	).slice(0, 32);
}

/** One file per declared server, beside the tool catalogs and keyed the same way. */
function mcpSkillCatalogPath(identity: McpCatalogIdentity, cacheDir?: string): string {
	return path.join(cacheDir ?? pancodeCacheDir(), CACHE_SUBDIRECTORY, `${catalogKey(identity)}.json`);
}

function mcpRecordedSkill(entry: McpSkillEntry): McpRecordedSkill {
	return {
		uri: entry.uri,
		name: entry.name,
		description: entry.description,
		skillPath: entry.skillPath,
		frontmatter: entry.frontmatter,
		manifestDigest: entry.manifestDigest,
		files: entry.resources.length,
		bytes: entry.totalBytes,
	};
}

/**
 * A recorded skill decodes only when its frontmatter still passes the entry
 * checks a live listing applies: the uri, name, description and skill path are
 * re-derived from them rather than trusted from the file.
 */
function decodeSkill(value: unknown): McpRecordedSkill | null {
	if (!isRecord(value)) return null;
	const { uri, frontmatter, manifestDigest, files, bytes } = value;
	if (typeof uri !== "string" || !isRecord(frontmatter)) return null;
	if (typeof manifestDigest !== "string" || !DIGEST.test(manifestDigest)) return null;
	if (typeof files !== "number" || !Number.isSafeInteger(files) || files < 1) return null;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return null;
	if (Buffer.byteLength(canonicalJson(frontmatter), "utf8") > MCP_SKILL_FRONTMATTER_BYTES) return null;
	// A one-file manifest of the SKILL.md alone runs the live entry checks on everything but the files.
	const verdict = parseMcpSkillEntry({ uri, frontmatter, resources: [{ uri, digest: manifestDigest, size: 0 }] });
	if (!verdict.ok) return null;
	if (value.name !== verdict.entry.name || value.skillPath !== verdict.entry.skillPath) return null;
	return {
		uri,
		name: verdict.entry.name,
		description: verdict.entry.description,
		skillPath: verdict.entry.skillPath,
		frontmatter: verdict.entry.frontmatter,
		manifestDigest,
		files,
		bytes,
	};
}

function decodeRefusal(value: unknown): McpSkillRefusal | null {
	if (!isRecord(value)) return null;
	const { uri, name, kind, reason } = value;
	if (uri !== null && typeof uri !== "string") return null;
	if (name !== null && typeof name !== "string") return null;
	if (kind !== "invalid" && kind !== "dynamic" && kind !== "limit") return null;
	if (typeof reason !== "string" || Buffer.byteLength(reason, "utf8") > MCP_SKILL_CATALOG_CAPS.reasonBytes) {
		return null;
	}
	return { uri, name, kind, reason };
}

function decodeCatalog(value: unknown): McpSkillCatalog | null {
	if (!isRecord(value) || value.version !== MCP_SKILL_CATALOG_VERSION) return null;
	for (const field of ["projectRoot", "declarationPath", "serverId", "digest", "cwd", "observedAt"]) {
		const entry = value[field];
		if (typeof entry !== "string" || entry.length === 0) return null;
	}
	if (value.scope !== "user" && value.scope !== "project" && value.scope !== "plugin") return null;
	if (typeof value.truncated !== "boolean") return null;
	const ttlMs = value.ttlMs;
	if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < 0) return null;
	if (!Number.isFinite(Date.parse(value.observedAt as string))) return null;
	if (!Array.isArray(value.skills) || !Array.isArray(value.refused)) return null;
	if (value.skills.length + value.refused.length > MCP_SKILL_CATALOG_CAPS.entries) return null;
	const skills: McpRecordedSkill[] = [];
	const seen = new Set<string>();
	for (const raw of value.skills) {
		const skill = decodeSkill(raw);
		if (skill === null || seen.has(skill.uri)) return null;
		seen.add(skill.uri);
		skills.push(skill);
	}
	const refused: McpSkillRefusal[] = [];
	for (const raw of value.refused) {
		const refusal = decodeRefusal(raw);
		if (refusal === null) return null;
		refused.push(refusal);
	}
	return {
		version: MCP_SKILL_CATALOG_VERSION,
		projectRoot: value.projectRoot as string,
		scope: value.scope,
		declarationPath: value.declarationPath as string,
		serverId: value.serverId as string,
		digest: value.digest as string,
		cwd: value.cwd as string,
		truncated: value.truncated,
		ttlMs,
		observedAt: value.observedAt as string,
		skills,
		refused,
	};
}

/**
 * The last recorded skills of this exact declaration, or null. As with the
 * tool catalog, a malformed, oversized, mismatched, future-dated or expired
 * file is a miss. The record stays listable for a day whatever `ttlMs` the
 * server sent: a record is never a reason to launch the server, so expiring it
 * at a short `ttlMs` would hide the skills until something else did.
 */
export function readMcpSkillCatalog(
	identity: McpCatalogIdentity,
	options: McpSkillCatalogOptions = {},
): McpSkillCatalog | null {
	const read = readBoundedFileText(mcpSkillCatalogPath(identity, options.cacheDir), MCP_SKILL_CATALOG_CAPS.fileBytes);
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
	if (observedMs > nowMs || nowMs - observedMs >= (options.ttlMs ?? MCP_METADATA_CACHE_TTL_MS)) return null;
	return catalog;
}

/** Replace one server's recorded skills atomically; false rather than a throw, so a listing never fails on its record. */
export function writeMcpSkillCatalog(
	identity: McpCatalogIdentity,
	listing: McpSkillListing,
	options: Pick<McpSkillCatalogOptions, "cacheDir" | "nowMs"> = {},
): boolean {
	const catalog: McpSkillCatalog = {
		version: MCP_SKILL_CATALOG_VERSION,
		projectRoot: identity.projectRoot,
		scope: identity.scope,
		declarationPath: identity.declarationPath,
		serverId: identity.serverId,
		digest: identity.digest,
		cwd: identity.cwd,
		truncated: listing.truncated,
		ttlMs: listing.ttlMs,
		observedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
		skills: listing.skills.slice(0, MCP_SKILL_CATALOG_CAPS.entries).map(mcpRecordedSkill),
		refused: listing.refused
			.slice(0, Math.max(0, MCP_SKILL_CATALOG_CAPS.entries - listing.skills.length))
			.map((refusal) => ({
				...refusal,
				reason: boundedExternalDiagnostic(refusal.reason, MCP_SKILL_CATALOG_CAPS.reasonBytes),
			})),
	};
	const text = `${JSON.stringify(catalog, null, 2)}\n`;
	if (Buffer.byteLength(text, "utf8") > MCP_SKILL_CATALOG_CAPS.fileBytes) return false;
	try {
		safeResourceWrite(mcpSkillCatalogPath(identity, options.cacheDir), text, { encoding: "utf8", mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}
