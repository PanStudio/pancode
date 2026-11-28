// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Skills over MCP (`io.modelcontextprotocol/skills`, Beta): the entry a server
 * lists for each skill, the checks that decide whether PanCode loads it, and
 * the verification every file read goes through.
 *
 * An entry is a complete manifest: the skill's `SKILL.md` uri, its frontmatter
 * verbatim, and every file as `{uri, digest, size}`. PanCode loads only an
 * entry whose manifest is an array, whose uris all lie in the skill's own
 * directory, and which stays within 512 files and 16 MiB. A `"dynamic"` entry
 * offers no content to bind an approval to and is refused. A file is used only
 * when its byte length and sha256 match the manifest, and a `SKILL.md` only
 * when its frontmatter matches the entry field by field.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { canonicalJson, canonicalJsonStrict } from "../../core/canonical-json.js";
import { sha256Hex } from "../../core/hash.js";
import { neutralizeFraming } from "../../core/reminder-framing.js";
import { isRecord } from "../../core/type-guards.js";
import type { McpResourceRead } from "./resources.js";

export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** The per-skill limits the extension fixes; a host must load a skill up to both. */
export const MCP_SKILL_LIMITS = Object.freeze({
	resources: 512,
	totalBytes: 16 * 1024 * 1024,
});

/** The largest frontmatter PanCode carries, as canonical JSON; it is shown to the operator and recorded. */
export const MCP_SKILL_FRONTMATTER_BYTES = 16 * 1024;

/** Entries kept from one server's listing, and pages read to collect them. */
export const MCP_SKILL_LIST_CAP = 256;
const MCP_SKILL_LIST_PAGES = 64;

const SKILL_FILE = "SKILL.md";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
/** The Agent Skills naming rule: lowercase letters, digits and single hyphens, at most 64 characters. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIRECTORY_MIME_TYPE = "inode/directory";

/** The extension's settings a server declared, once PanCode has decided to enable it. */
export interface McpSkillsSettings {
	directoryRead: boolean;
}

/**
 * The extension's settings from a server's discover or initialize
 * capabilities. Enabled only when the server declares both the extension and
 * `resources`, and only at the initial revision: a `revision` this client does
 * not know means the extension stays off, with the reason.
 */
export function mcpSkillsSettings(
	capabilities: Record<string, unknown>,
): { settings: McpSkillsSettings } | { settings: null; reason: string | null } {
	const extensions = capabilities.extensions;
	const declared = isRecord(extensions) ? extensions[MCP_SKILLS_EXTENSION] : undefined;
	if (declared === undefined) return { settings: null, reason: null };
	if (!isRecord(declared)) {
		return { settings: null, reason: `its ${MCP_SKILLS_EXTENSION} settings are not an object` };
	}
	if (declared.revision !== undefined) {
		return {
			settings: null,
			reason: `it declares ${MCP_SKILLS_EXTENSION} revision ${JSON.stringify(declared.revision)}, which this PanCode does not know`,
		};
	}
	if (!isRecord(capabilities.resources)) {
		return { settings: null, reason: `it declares ${MCP_SKILLS_EXTENSION} without the resources capability` };
	}
	return { settings: { directoryRead: declared.directoryRead === true } };
}

export interface McpSkillResource {
	uri: string;
	/** `sha256:<64 lowercase hex>` of the file's raw bytes. */
	digest: string;
	/** Byte length of the file's raw content. */
	size: number;
}

/** A listed skill PanCode can load. */
export interface McpSkillEntry {
	/** The `SKILL.md` uri; with the server id, the skill's identity. */
	uri: string;
	/** The skill's directory: the uri without `/SKILL.md`. */
	root: string;
	/** The root without its scheme, e.g. `acme/billing/refunds`. */
	skillPath: string;
	name: string;
	description: string;
	/** The frontmatter verbatim, as the server rendered it. */
	frontmatter: Record<string, unknown>;
	/** Every file, sorted by uri, `SKILL.md` included. */
	resources: McpSkillResource[];
	totalBytes: number;
	/** sha256 over the uri, frontmatter and every (uri, digest, size); what an approval binds. */
	manifestDigest: string;
}

/** A listed skill PanCode does not load, with the reason it tells the operator. */
export interface McpSkillRefusal {
	uri: string | null;
	name: string | null;
	kind: "invalid" | "dynamic" | "limit";
	reason: string;
}

export type McpSkillEntryVerdict = { ok: true; entry: McpSkillEntry } | ({ ok: false } & McpSkillRefusal);

function sha256Digest(input: string | Uint8Array): string {
	return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

/** The scheme-less path of a uri, or null when it has none to speak of. */
function schemelessPath(uri: string): string | null {
	const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.exec(uri);
	return scheme === null ? null : uri.slice(scheme[0].length);
}

/** Control, bidi, and XML tag/attribute delimiters forbidden in skill URIs and relative paths. */
const UNSAFE_RELATIVE_CHARS = /[?#\\"<>\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** A relative file path with no empty, `.` or `..` segment and nothing unsafe for URIs or framing. */
function cleanRelative(relative: string): boolean {
	if (relative.length === 0 || UNSAFE_RELATIVE_CHARS.test(relative)) return false;
	return relative.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function mcpSkillManifestDigest(entry: {
	uri: string;
	frontmatter: Record<string, unknown>;
	resources: ReadonlyArray<McpSkillResource>;
}): string {
	const resources = [...entry.resources]
		.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))
		.map(({ uri, digest, size }) => ({ uri, digest, size }));
	return sha256Digest(canonicalJson({ uri: entry.uri, frontmatter: entry.frontmatter, resources }));
}

/**
 * Judge one `skills/list` or `skills/get` entry. A missing or mistyped
 * `resources` is invalid and never loaded; `"dynamic"` is a valid entry
 * PanCode declines, because nothing in it can be verified or approved.
 */
export function parseMcpSkillEntry(value: unknown): McpSkillEntryVerdict {
	const refuse = (
		kind: McpSkillRefusal["kind"],
		reason: string,
		uri: string | null = null,
		name: string | null = null,
	): McpSkillEntryVerdict => ({ ok: false, uri, name, kind, reason });
	if (!isRecord(value)) return refuse("invalid", "the entry is not an object");
	const uri = typeof value.uri === "string" && value.uri.length > 0 ? value.uri : null;
	if (uri === null) return refuse("invalid", "the entry has no uri");
	const frontmatter = value.frontmatter;
	const name = isRecord(frontmatter) && typeof frontmatter.name === "string" ? frontmatter.name : null;
	if (!isRecord(frontmatter)) return refuse("invalid", "its frontmatter is not an object", uri);
	if (Buffer.byteLength(canonicalJson(frontmatter), "utf8") > MCP_SKILL_FRONTMATTER_BYTES) {
		return refuse("limit", `its frontmatter is over ${MCP_SKILL_FRONTMATTER_BYTES} bytes`, uri, name);
	}
	if (name === null || name.length === 0) return refuse("invalid", "its frontmatter has no name", uri);
	if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) {
		return refuse("invalid", "its frontmatter has no description", uri, name);
	}
	if (name.length > 64 || !SKILL_NAME.test(name)) {
		return refuse("invalid", `its name ${JSON.stringify(name)} breaks the Agent Skills naming rules`, uri, name);
	}
	if (!uri.endsWith(`/${SKILL_FILE}`)) return refuse("invalid", `its uri does not name a ${SKILL_FILE}`, uri, name);
	const root = uri.slice(0, -`/${SKILL_FILE}`.length);
	const skillPath = schemelessPath(root);
	if (skillPath === null || !cleanRelative(skillPath)) {
		return refuse("invalid", "its uri has no clean skill path", uri, name);
	}
	if (skillPath.split("/").at(-1) !== name) {
		return refuse("invalid", `the last segment of its skill path is not its name ${name}`, uri, name);
	}
	const listed = value.resources;
	if (listed === "dynamic") {
		return refuse(
			"dynamic",
			"its resources are dynamic, so no digest binds its content; PanCode loads only skills that list every file",
			uri,
			name,
		);
	}
	if (!Array.isArray(listed)) return refuse("invalid", "its resources are missing or not a file list", uri, name);
	if (listed.length > MCP_SKILL_LIMITS.resources) {
		return refuse(
			"limit",
			`it lists ${listed.length} files, over the ${MCP_SKILL_LIMITS.resources} a skill may have`,
			uri,
			name,
		);
	}
	const resources: McpSkillResource[] = [];
	const seen = new Set<string>();
	let totalBytes = 0;
	for (const item of listed) {
		if (!isRecord(item) || typeof item.uri !== "string") return refuse("invalid", "a file entry has no uri", uri, name);
		if (typeof item.digest !== "string" || !DIGEST.test(item.digest)) {
			return refuse("invalid", `file ${item.uri} has no sha256:<64 lowercase hex> digest`, uri, name);
		}
		if (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0) {
			return refuse("invalid", `file ${item.uri} has no byte size`, uri, name);
		}
		if (item.uri !== uri && !(item.uri.startsWith(`${root}/`) && cleanRelative(item.uri.slice(root.length + 1)))) {
			return refuse("invalid", `file ${item.uri} lies outside the skill's directory`, uri, name);
		}
		if (seen.has(item.uri)) return refuse("invalid", `file ${item.uri} is listed twice`, uri, name);
		seen.add(item.uri);
		totalBytes += item.size;
		resources.push({ uri: item.uri, digest: item.digest, size: item.size });
	}
	if (!seen.has(uri)) return refuse("invalid", `its resources do not list its own ${SKILL_FILE}`, uri, name);
	if (totalBytes > MCP_SKILL_LIMITS.totalBytes) {
		return refuse(
			"limit",
			`its files total ${totalBytes} bytes, over the ${MCP_SKILL_LIMITS.totalBytes} a skill may have`,
			uri,
			name,
		);
	}
	resources.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
	const verbatim = { ...frontmatter };
	return {
		ok: true,
		entry: {
			uri,
			root,
			skillPath,
			name,
			description: frontmatter.description,
			frontmatter: verbatim,
			resources,
			totalBytes,
			manifestDigest: mcpSkillManifestDigest({ uri, frontmatter: verbatim, resources }),
		},
	};
}

/** A file's path inside its skill, as the model names it: `SKILL.md`, `scripts/run.py`. */
export function mcpSkillRelativePath(entry: Pick<McpSkillEntry, "root">, uri: string): string {
	return uri.slice(entry.root.length + 1);
}

/**
 * The manifest file a path inside the skill names, or null when the held
 * manifest does not list it. A read the manifest does not list is a changed
 * skill, so the caller treats null as a verification failure.
 */
export function mcpSkillFile(entry: McpSkillEntry, relative: string): McpSkillResource | null {
	const trimmed = relative.trim().replace(/^\.\//u, "");
	if (!cleanRelative(trimmed)) return null;
	const uri = `${entry.root}/${trimmed}`;
	return entry.resources.find((resource) => resource.uri === uri) ?? null;
}

/** Why `bytes` is not the file the manifest lists, or null when it is. Size first: a wrong length is a mismatch. */
function mcpSkillFileMismatch(file: McpSkillResource, bytes: Uint8Array): string | null {
	if (bytes.byteLength !== file.size) {
		return `${file.uri} is ${bytes.byteLength} bytes, but its manifest lists ${file.size}`;
	}
	const digest = sha256Digest(bytes);
	if (digest !== file.digest) return `${file.uri} hashes to ${digest}, but its manifest lists ${file.digest}`;
	return null;
}

/**
 * Why a fetched `SKILL.md`'s frontmatter differs from the entry's, or null
 * when every field matches. The comparison is field by field over the parsed
 * YAML, so what an operator approved from the entry is what the model reads.
 */
export function mcpSkillFrontmatterMismatch(entry: McpSkillEntry, text: string): string | null {
	const opening = /^---\r?\n/u.exec(text);
	if (opening === null) return `${entry.uri} has no YAML frontmatter`;
	const closing = /\r?\n---(?:\r?\n|$)/gu;
	closing.lastIndex = opening[0].length;
	const end = closing.exec(text);
	if (end === null) return `${entry.uri} frontmatter has no closing delimiter`;
	let parsed: unknown;
	try {
		parsed = parseYaml(text.slice(opening[0].length, end.index));
	} catch (error) {
		return `${entry.uri} frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (!isRecord(parsed)) return `${entry.uri} frontmatter is not a YAML object`;
	const fields = [...new Set([...Object.keys(parsed), ...Object.keys(entry.frontmatter)])].sort();
	for (const field of fields) {
		if (!(field in parsed)) return `${entry.uri} frontmatter has no ${field}, which its entry lists`;
		if (!(field in entry.frontmatter)) return `${entry.uri} frontmatter has ${field}, which its entry does not list`;
		let parsedJson: string;
		let entryJson: string;
		try {
			parsedJson = canonicalJsonStrict(parsed[field]);
			entryJson = canonicalJsonStrict(entry.frontmatter[field]);
		} catch {
			return `${entry.uri} frontmatter ${field} contains a non-JSON value`;
		}
		if (parsedJson !== entryJson) {
			return `${entry.uri} frontmatter ${field} differs from its entry`;
		}
	}
	return null;
}

/** The body of a verified `SKILL.md`: everything after its frontmatter. */
export function mcpSkillBody(text: string): string {
	const opening = /^---\r?\n/u.exec(text);
	if (opening === null) return text;
	const closing = /\r?\n---(?:\r?\n|$)/gu;
	closing.lastIndex = opening[0].length;
	const end = closing.exec(text);
	return end === null ? text : text.slice(end.index + end[0].length);
}

/**
 * The requests a skill needs from one connected server. A server that did not
 * declare the extension, or declared a revision PanCode does not know, has no
 * `settings` and is never asked; `readDirectory` is never called unless
 * `settings.directoryRead` is true.
 */
export interface McpSkillsTransport {
	settings: McpSkillsSettings | null;
	/** One `skills/list` page; the raw result. */
	listSkills(cursor: string | undefined, signal?: AbortSignal): Promise<unknown>;
	/** `skills/get {uri}`; the raw result. */
	getSkill(uri: string, signal?: AbortSignal): Promise<unknown>;
	/** The client's `resources/read {uri}`, declaring the skills extension. */
	readResource(uri: string, signal?: AbortSignal): Promise<McpResourceRead>;
	/** One `resources/directory/read` page; the raw result. */
	readDirectory(uri: string, cursor: string | undefined, signal?: AbortSignal): Promise<unknown>;
}

export interface McpSkillListing {
	skills: McpSkillEntry[];
	refused: McpSkillRefusal[];
	/** The server had more skills than PanCode keeps from one listing. */
	truncated: boolean;
	/** The shortest `ttlMs` any page carried, 0 when one carried none: how long the server says the listing stays current. */
	ttlMs: number;
}

/** Page through `skills/list`. An entry PanCode cannot load is kept as a refusal so the operator sees why. */
export async function listMcpSkills(transport: McpSkillsTransport, signal?: AbortSignal): Promise<McpSkillListing> {
	const skills: McpSkillEntry[] = [];
	const refused: McpSkillRefusal[] = [];
	const seen = new Set<string>();
	let ttlMs: number | null = null;
	let cursor: string | undefined;
	for (let page = 0; page < MCP_SKILL_LIST_PAGES; page += 1) {
		const result = await transport.listSkills(cursor, signal);
		if (!isRecord(result) || !Array.isArray(result.skills)) {
			throw new Error("skills/list returned no skills array");
		}
		// An absent, negative or malformed hint is 0: list again at the next access.
		const pageTtl =
			typeof result.ttlMs === "number" && Number.isSafeInteger(result.ttlMs) && result.ttlMs > 0 ? result.ttlMs : 0;
		ttlMs = ttlMs === null ? pageTtl : Math.min(ttlMs, pageTtl);
		for (const item of result.skills) {
			if (skills.length + refused.length >= MCP_SKILL_LIST_CAP)
				return { skills, refused, truncated: true, ttlMs: ttlMs ?? 0 };
			const verdict = parseMcpSkillEntry(item);
			if (!verdict.ok) {
				const { ok: _ok, ...refusal } = verdict;
				refused.push(refusal);
				continue;
			}
			if (seen.has(verdict.entry.uri)) {
				refused.push({
					uri: verdict.entry.uri,
					name: verdict.entry.name,
					kind: "invalid",
					reason: "the listing carries it twice",
				});
				continue;
			}
			seen.add(verdict.entry.uri);
			skills.push(verdict.entry);
		}
		const next = result.nextCursor;
		if (typeof next !== "string" || next.length === 0) return { skills, refused, truncated: false, ttlMs: ttlMs ?? 0 };
		cursor = next;
	}
	return { skills, refused, truncated: true, ttlMs: ttlMs ?? 0 };
}

/** `skills/get` for one uri: the entry, or the refusal that keeps it from loading. */
export async function getMcpSkill(
	transport: McpSkillsTransport,
	uri: string,
	signal?: AbortSignal,
): Promise<McpSkillEntryVerdict> {
	const result = await transport.getSkill(uri, signal);
	if (!isRecord(result) || !isRecord(result.skill)) {
		return { ok: false, uri, name: null, kind: "invalid", reason: "skills/get returned no skill" };
	}
	const verdict = parseMcpSkillEntry(result.skill);
	if (verdict.ok && verdict.entry.uri !== uri) {
		return {
			ok: false,
			uri,
			name: verdict.entry.name,
			kind: "invalid",
			reason: `skills/get answered for ${verdict.entry.uri}`,
		};
	}
	return verdict;
}

/** The raw bytes `resources/read` returned for exactly `uri`: text as UTF-8, a blob as base64. */
function mcpResourceBytes(read: McpResourceRead, uri: string): Buffer | string {
	const matching = read.contents.filter((item) => item.uri === uri);
	const content = matching[0];
	if (matching.length !== 1 || content === undefined) {
		return `resources/read returned ${matching.length} contents for ${uri}`;
	}
	if ("text" in content) return Buffer.from(content.text, "utf8");
	if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(content.blob)) return `resources/read returned a malformed blob for ${uri}`;
	return Buffer.from(content.blob, "base64");
}

/** Read one manifest file and verify it. A string is the verification failure, never partial content. */
export async function readMcpSkillFile(
	transport: McpSkillsTransport,
	file: McpSkillResource,
	signal?: AbortSignal,
): Promise<Buffer | string> {
	const bytes = mcpResourceBytes(await transport.readResource(file.uri, signal), file.uri);
	if (typeof bytes === "string") return bytes;
	return mcpSkillFileMismatch(file, bytes) ?? bytes;
}

export interface McpSkillDirectoryEntry {
	uri: string;
	directory: boolean;
	/** Whether the held manifest lists it; an unlisted file is never readable. */
	listed: boolean;
}

/**
 * The direct children `resources/directory/read` reports for a directory of
 * the skill. The listing informs; it never extends the manifest, so each child
 * says whether the held entry lists it.
 */
export async function readMcpSkillDirectory(
	transport: McpSkillsTransport,
	entry: McpSkillEntry,
	uri: string,
	signal?: AbortSignal,
): Promise<McpSkillDirectoryEntry[]> {
	if (transport.settings?.directoryRead !== true) throw new Error("the server does not declare directoryRead");
	if (uri !== entry.root && !uri.startsWith(`${entry.root}/`)) throw new Error(`${uri} lies outside the skill`);
	const listed = new Set(entry.resources.map((resource) => resource.uri));
	const children: McpSkillDirectoryEntry[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MCP_SKILL_LIST_PAGES; page += 1) {
		const result = await transport.readDirectory(uri, cursor, signal);
		if (!isRecord(result) || !Array.isArray(result.resources)) {
			throw new Error("resources/directory/read returned no resources array");
		}
		for (const item of result.resources) {
			if (!isRecord(item) || typeof item.uri !== "string") continue;
			if (children.length >= MCP_SKILL_LIMITS.resources) return children;
			children.push({
				uri: item.uri,
				directory: item.mimeType === DIRECTORY_MIME_TYPE,
				listed: listed.has(item.uri),
			});
		}
		const next = result.nextCursor;
		if (typeof next !== "string" || next.length === 0) break;
		cursor = next;
	}
	return children;
}

/**
 * The name each skill of one server goes by in PanCode: `<id>:<name>`, or
 * `<id>:<skill path>` for skills whose names collide within the server, so a
 * listing that repeats a name keeps every skill reachable and distinct.
 */
export function mcpSkillDisplayNames(
	serverId: string,
	entries: ReadonlyArray<Pick<McpSkillEntry, "uri" | "name" | "skillPath">>,
): Map<string, string> {
	const byName = new Map<string, number>();
	for (const entry of entries) byName.set(entry.name, (byName.get(entry.name) ?? 0) + 1);
	const local = (entry: Pick<McpSkillEntry, "uri" | "name" | "skillPath">): string => {
		if ((byName.get(entry.name) ?? 0) <= 1) return entry.name;
		return DISPLAY_PATH.test(entry.skillPath) ? entry.skillPath : uriTagged(entry);
	};
	const firstPass = entries.map((entry) => [entry.uri, local(entry)] as const);
	const counts = new Map<string, number>();
	for (const [, name] of firstPass) counts.set(name, (counts.get(name) ?? 0) + 1);
	// Two uris that differ only in scheme share a skill path; the uri itself then tells them apart.
	return new Map(
		firstPass.map(([uri, name], index) => {
			const entry = entries[index];
			const unique = (counts.get(name) ?? 0) > 1 && entry !== undefined ? uriTagged(entry) : name;
			return [uri, `${serverId}:${unique}`];
		}),
	);
}

const DISPLAY_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

function uriTagged(entry: Pick<McpSkillEntry, "uri" | "name">): string {
	return `${entry.name}@${sha256Hex(entry.uri).slice(0, 8)}`;
}

/**
 * The server id of `<id>:<name>`, the form an MCP skill is named by outside a
 * session (a recipe's skills), or null for any other skill name.
 */
export function mcpSkillReferenceServer(reference: string): string | null {
	const match = /^([a-z0-9][a-z0-9_-]*):./u.exec(reference);
	return match?.[1] ?? null;
}

/**
 * Server-written text as one line PanCode shows a person: framing neutralized,
 * control and bidi characters and runs of whitespace collapsed to one space,
 * cut at `maxBytes` with the full length named.
 */
export function boundedMcpSkillText(text: string, maxBytes = 1024): string {
	const neutral = neutralizeFraming(text)
		.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const bytes = Buffer.from(neutral, "utf8");
	if (bytes.byteLength <= maxBytes) return neutral;
	return `${bytes
		.subarray(0, maxBytes)
		.toString("utf8")
		.replace(/\uFFFD+$/u, "")}... (${bytes.byteLength} bytes)`;
}

/**
 * The one skill of server `serverId` an operator named: by uri, by the name
 * PanCode shows it under (with or without the `<id>:` prefix), or by its bare
 * name when only one skill carries it.
 */
export function findMcpSkill<T extends Pick<McpSkillEntry, "uri" | "name" | "skillPath">>(
	serverId: string,
	entries: ReadonlyArray<T>,
	query: string,
): { entry: T; displayName: string } | { entry: null; reason: string } {
	const displays = mcpSkillDisplayNames(serverId, entries);
	const found = (entry: T) => ({ entry, displayName: displays.get(entry.uri) ?? `${serverId}:${entry.name}` });
	const byUri = entries.find((entry) => entry.uri === query);
	if (byUri !== undefined) return found(byUri);
	const local = query.startsWith(`${serverId}:`) ? query.slice(serverId.length + 1) : query;
	const byDisplay = entries.find((entry) => displays.get(entry.uri) === `${serverId}:${local}`);
	if (byDisplay !== undefined) return found(byDisplay);
	const named = entries.filter((entry) => entry.name === local);
	const [only] = named;
	if (only !== undefined && named.length === 1) return found(only);
	const shown = (values: ReadonlyArray<string>) =>
		`${values
			.slice(0, 20)
			.map((value) => boundedMcpSkillText(value, 256))
			.join(", ")}${values.length > 20 ? `, and ${values.length - 20} more` : ""}`;
	if (named.length > 1) {
		return {
			entry: null,
			reason: `MCP server '${serverId}' serves ${named.length} skills named ${boundedMcpSkillText(local, 256)}; name one by its uri: ${shown(named.map((entry) => entry.uri))}`,
		};
	}
	return {
		entry: null,
		reason: `MCP server '${serverId}' serves no skill named ${boundedMcpSkillText(local, 256)}${entries.length > 0 ? `; it serves ${shown([...displays.values()])}` : ""}`,
	};
}

/**
 * The skills transport a connected client offers, or null with the reason it
 * offers none. A client exposes one as `skills()` only toward a server whose
 * capabilities enable the extension.
 */
export function mcpClientSkills(
	client: object,
	capabilities: Record<string, unknown> | undefined,
): { transport: McpSkillsTransport } | { transport: null; reason: string } {
	const verdict = mcpSkillsSettings(capabilities ?? {});
	if (verdict.settings === null) {
		return { transport: null, reason: verdict.reason ?? `it does not declare ${MCP_SKILLS_EXTENSION}` };
	}
	const accessor = (client as { skills?: unknown }).skills;
	const transport = typeof accessor === "function" ? (accessor.call(client) as McpSkillsTransport | null) : null;
	if (transport === null || transport.settings === null) {
		return { transport: null, reason: `this PanCode's MCP client cannot request ${MCP_SKILLS_EXTENSION}` };
	}
	return { transport };
}
