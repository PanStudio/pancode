// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Names and on-disk layout of a store.
 *
 * A tag is a named container and a blob is a named byte sequence inside one
 * tag. Names stay ASCII so one undecodable name never breaks a whole listing,
 * and a tag never starts with `/`.
 *
 * Every function here is pure apart from the `realpath` in `storeProjectKey` and
 * the `.git` and `commondir` reads that find a project's main checkout.
 * The layout functions take the store root and project key, or the project
 * directory, as arguments; where those live is the caller's choice.
 *
 * A store has one or more roots. The first is the primary: it holds every
 * records tag, the locks and `placement.json`, which names the root each tag
 * was created on. A tag with no entry there is on the primary.
 *
 *   <storeRoot>/projects/<projectKey>/project.json
 *   <storeRoot>/projects/<projectKey>/locks/                (primary only)
 *   <storeRoot>/projects/<projectKey>/placement.json        (primary only)
 *   <storeRoot>/projects/<projectKey>/tags/<encoded tag>/tag.json
 *   <storeRoot>/projects/<projectKey>/tags/<encoded tag>/blobs/<blob>
 *   <cacheDir>/store/<projectKey>/<encoded tag>/<blob>   (the copies `get` hands back)
 *
 * Records for tag `T` are blobs of the sibling tag `recordsTag(T)`.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { StoreTagClass } from "../backend/types.js";

export const STORE_TAG_MAX_BYTES = 200;
export const STORE_BLOB_MAX_BYTES = 480;
export const STORE_RECORDS_SUFFIX = "/.records";

const TAG_CHARS = /^[A-Za-z0-9._/-]+$/u;
// Printable ASCII without `#` (reserved for record names) and `\`.
const BLOB_CHARS = /^[\x20-\x22\x24-\x5b\x5d-\x7e]+$/u;

function pathShapeProblem(kind: string, name: string): string | null {
	if (name.startsWith("/")) return `A ${kind} name must not start with "/".`;
	if (name.endsWith("/")) return `A ${kind} name must not end with "/".`;
	for (const segment of name.split("/")) {
		if (segment === "") return `A ${kind} name must not contain an empty segment ("//").`;
		if (segment === "." || segment === "..") return `A ${kind} name must not contain a "." or ".." segment.`;
	}
	return null;
}

/**
 * null when valid, else a sentence naming the rule broken. Judges names the
 * model or operator supplies; internal callers pass `allowRecords` to also
 * accept `recordsTag(t)` for a valid `t`.
 */
export function validateTagName(tag: string, options: { allowRecords?: boolean } = {}): string | null {
	if (options.allowRecords === true && isRecordsTag(tag))
		return validateTagName(tag.slice(0, -STORE_RECORDS_SUFFIX.length));
	const bytes = Buffer.byteLength(tag, "utf8");
	if (bytes === 0) return "A tag name must not be empty.";
	if (bytes > STORE_TAG_MAX_BYTES) return `A tag name must be at most ${STORE_TAG_MAX_BYTES} bytes.`;
	if (!TAG_CHARS.test(tag)) return "A tag name may contain only letters, digits, '.', '_', '-' and '/'.";
	const shape = pathShapeProblem("tag", tag);
	if (shape !== null) return shape;
	if (tag.split("/").some((segment) => segment.startsWith(".")))
		return 'A tag name segment must not start with "." (reserved for records tags).';
	return null;
}

/** null when valid, else a sentence naming the rule broken. */
export function validateBlobName(blob: string): string | null {
	const bytes = Buffer.byteLength(blob, "utf8");
	if (bytes === 0) return "A blob name must not be empty.";
	if (bytes > STORE_BLOB_MAX_BYTES) return `A blob name must be at most ${STORE_BLOB_MAX_BYTES} bytes.`;
	if (!BLOB_CHARS.test(blob)) return "A blob name may contain only printable ASCII characters other than '#' and '\\'.";
	return pathShapeProblem("blob", blob);
}

export function validateS3Prefix(prefix: string): string | null {
	if (prefix === "") return null;
	if (!prefix.endsWith("/") || prefix.startsWith("/") || prefix.split("/").some((part) => part === "." || part === ".."))
		return "Expected an empty prefix or one ending in '/', without a leading '/' or '.' or '..' segments.";
	return null;
}

export function recordsTag(tag: string): string {
	return `${tag}${STORE_RECORDS_SUFFIX}`;
}

export function isRecordsTag(tag: string): boolean {
	return tag.endsWith(STORE_RECORDS_SUFFIX);
}

export function encodeTagSegment(tag: string): string {
	return encodeURIComponent(tag);
}

export function decodeTagSegment(segment: string): string {
	return decodeURIComponent(segment);
}

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/u;
export const STORE_PROJECT_ID_MAX_LENGTH = 64;

/** null when `id` is a valid project id, else a sentence naming the rule broken. */
export function validateStoreProjectId(id: string): string | null {
	if (id.length === 0 || id.length > STORE_PROJECT_ID_MAX_LENGTH)
		return `A project id must be 1 to ${STORE_PROJECT_ID_MAX_LENGTH} characters.`;
	if (!PROJECT_ID.test(id))
		return "A project id may contain only a-z, 0-9, '.', '_' and '-', and must start with a letter or digit.";
	return null;
}

/** First 16 hex of sha256("project-id:" + id): the key of the project whose settings name it `id`. */
export function storeProjectKeyForId(id: string): string {
	return createHash("sha256").update(`project-id:${id}`).digest("hex").slice(0, 16);
}

/** First 16 hex of sha256(realpath(root)): the key of the project whose main checkout is `root`. */
export function storeProjectKey(root: string): string {
	let physical: string;
	try {
		physical = realpathSync(root);
	} catch {
		physical = resolve(root);
	}
	return createHash("sha256").update(physical).digest("hex").slice(0, 16);
}

/**
 * The main checkout of the repository rooted at `root` when `root` is a linked worktree (its `.git` is a file
 * naming a git dir whose `commondir` is a `.git` directory), else `root`. Every checkout and task worktree of a
 * project derives its store key from the main checkout, so all of them reach one store.
 */
export function storeMainCheckout(root: string): string {
	try {
		const dotGit = join(root, ".git");
		if (!lstatSync(dotGit).isFile()) return root;
		const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, "utf8"))?.[1];
		if (gitdir === undefined) return root;
		const linkedGitDir = resolve(root, gitdir);
		const commonDir = resolve(linkedGitDir, readFileSync(join(linkedGitDir, "commondir"), "utf8").trim());
		if (basename(commonDir) !== ".git") return root;
		return realpathSync(dirname(commonDir));
	} catch {
		// Not a linked worktree, or an unreadable one: the store keys on this checkout.
		return root;
	}
}

/**
 * The project a directory belongs to, for a host that has no project walk of its own: the nearest ancestor of
 * `dir` holding a `.git` entry, else `dir`, then its main checkout. A home directory that is a repository never
 * serves the folders under it. PanCode's own walk ends at the same boundary.
 */
export function storeProjectRootOf(dir: string): string {
	const start = resolve(dir);
	const homes = new Set([resolve(homedir())]);
	try {
		homes.add(realpathSync(homedir()));
	} catch {
		// A home that does not resolve is matched by its plain path only.
	}
	let current = start;
	while (true) {
		if (homes.has(current) && current !== start) return storeMainCheckout(start);
		if (existsSync(join(current, ".git"))) return storeMainCheckout(current);
		const parent = dirname(current);
		if (parent === current) return storeMainCheckout(start);
		current = parent;
	}
}

export function storeProjectDir(storeRoot: string, projectKey: string): string {
	return join(storeRoot, "projects", projectKey);
}

export function storeTagDir(projectDir: string, tag: string): string {
	return join(projectDir, "tags", encodeTagSegment(tag));
}

export function storeBlobPath(projectDir: string, tag: string, blob: string): string {
	return join(storeTagDir(projectDir, tag), "blobs", blob);
}

/** Where the local backend puts the read-only copies `get` hands back. */
export function storeCacheDir(cacheDir: string, projectKey: string): string {
	return join(cacheDir, "store", projectKey);
}

/** The directory holding the project's lock files. */
export function storeLocksDir(projectDir: string): string {
	return join(projectDir, "locks");
}

/**
 * Directory boundaries a grant of `tags` adds to a writer's scope: each tag's
 * directory and its records tag's directory.
 */
export function storeGrantBoundaries(projectDir: string, tags: ReadonlyArray<string>): string[] {
	return tags.flatMap((tag) => [`${storeTagDir(projectDir, tag)}/`, `${storeTagDir(projectDir, recordsTag(tag))}/`]);
}

/**
 * What the store itself writes for any write into `tag`, besides the op's
 * own target: the records tag directory, `project.json` and the lock
 * directory.
 */
export function storeBookkeepingPaths(projectDir: string, tag: string): string[] {
	return [storeTagDir(projectDir, recordsTag(tag)), join(projectDir, "project.json"), storeLocksDir(projectDir)];
}

/** One directory a store keeps tags under. */
export interface StoreRootSpec {
	name: string;
	/** Absolute. */
	path: string;
	/** False for scratch space a site may purge: only tags of class `cache` are written there. */
	durable: boolean;
	/** The site's purge policy in its own words, or null. Reported, never enforced. */
	purge: string | null;
}

/** Where a new tag goes: its `byTag` root, else its class's `byClass` root, else the primary. */
export interface StorePlacementRules {
	byTag?: Readonly<Record<string, string>>;
	byClass?: Readonly<Partial<Record<StoreTagClass, string>>>;
}

/** The contents of `placement.json`: the root each tag was created on, by root name. */
export interface StorePlacementMap {
	v: 1;
	tags: Readonly<Record<string, string>>;
}

/** The root name a host gives its single root when none is configured. */
export const STORE_DEFAULT_ROOT_NAME = "default";

/** The class a command's `put` gives a tag it creates; predicting where such a put writes uses the same class. */
export const STORE_PUT_TAG_CLASS: StoreTagClass = "input";

export const STORE_TAG_CLASSES: ReadonlyArray<StoreTagClass> = ["input", "output", "cache", "archive"];

const ROOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** null when the root list is usable, else a sentence naming the first problem. */
export function validateStoreRoots(roots: ReadonlyArray<StoreRootSpec>): string | null {
	if (roots.length === 0) return "A store needs at least one root.";
	const names = new Set<string>();
	for (const root of roots) {
		if (!ROOT_NAME.test(root.name)) {
			return `Store root name ${JSON.stringify(root.name)} must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit.`;
		}
		if (names.has(root.name)) return `Store root name ${root.name} appears twice.`;
		names.add(root.name);
		if (!isAbsolute(root.path)) return `Store root ${root.name} has a path that is not absolute: ${root.path}`;
	}
	const primary = roots[0] as StoreRootSpec;
	if (!primary.durable) return `The first store root, ${primary.name}, holds records and locks, so it must be durable.`;
	return null;
}

/** null when every rule names a configured root, a valid tag and a known class, else the first problem. */
export function validatePlacementRules(rules: StorePlacementRules, rootNames: ReadonlyArray<string>): string | null {
	const known = new Set(rootNames);
	for (const [tag, root] of Object.entries(rules.byTag ?? {})) {
		const problem = validateTagName(tag);
		if (problem !== null) return `placement.byTag ${tag}: ${problem}`;
		if (!known.has(root)) return `placement.byTag ${tag} names root ${root}, which is not configured.`;
	}
	for (const [tagClass, root] of Object.entries(rules.byClass ?? {})) {
		if (!(STORE_TAG_CLASSES as ReadonlyArray<string>).includes(tagClass)) {
			return `placement.byClass ${tagClass} is not a tag class (${STORE_TAG_CLASSES.join(", ")}).`;
		}
		if (root !== undefined && !known.has(root)) {
			return `placement.byClass ${tagClass} names root ${root}, which is not configured.`;
		}
	}
	return null;
}

export function storePlacementPath(projectDir: string): string {
	return join(projectDir, "placement.json");
}

export function emptyStorePlacement(): StorePlacementMap {
	return { v: 1, tags: Object.create(null) as Record<string, string> };
}

/**
 * Parse `placement.json`. Throws on a file that is not one, so a damaged mapping is never read as
 * "every tag on the primary". Tag names are copied onto a prototype-free object: `constructor` is a
 * valid tag name.
 */
export function parseStorePlacement(text: string): StorePlacementMap {
	const parsed = JSON.parse(text) as { v?: unknown; tags?: unknown } | null;
	if (parsed === null || typeof parsed !== "object" || parsed.v !== 1) {
		throw new Error("placement.json is not a version 1 placement map");
	}
	const tags = Object.create(null) as Record<string, string>;
	if (parsed.tags !== undefined) {
		if (parsed.tags === null || typeof parsed.tags !== "object" || Array.isArray(parsed.tags)) {
			throw new Error("placement.json tags is not an object");
		}
		for (const [tag, root] of Object.entries(parsed.tags as Record<string, unknown>)) {
			if (typeof root !== "string") throw new Error(`placement.json gives tag ${tag} a root that is not a name`);
			tags[tag] = root;
		}
	}
	return { v: 1, tags };
}

/** The mapping with `tag` placed on `root` (or unplaced when `root` is null), serialized for `placement.json`. */
export function serializeStorePlacement(mapping: StorePlacementMap, tag: string, root: string | null): string {
	const tags = Object.create(null) as Record<string, string>;
	for (const [name, placed] of Object.entries(mapping.tags)) if (name !== tag) tags[name] = placed;
	if (root !== null) tags[tag] = root;
	const sorted = Object.create(null) as Record<string, string>;
	for (const name of Object.keys(tags).sort()) sorted[name] = tags[name] as string;
	return `${JSON.stringify({ v: 1, tags: sorted })}\n`;
}

/**
 * The root name a tag lives on, or null for the primary. One answer for both questions:
 *
 * - Where is this tag: pass `rules` null. A tag with an entry is on that root; one without, and every
 *   records tag, is on the primary.
 * - Where would this tag be created: pass the rules and the new tag's class. A tag with an entry
 *   still answers with it (placement never moves); otherwise `byTag`, then `byClass`, then the primary.
 */
export function resolvePlacement(
	mapping: StorePlacementMap | null,
	rules: StorePlacementRules | null,
	tag: string,
	tagClass?: StoreTagClass,
): string | null {
	if (isRecordsTag(tag)) return null;
	if (mapping !== null && Object.hasOwn(mapping.tags, tag)) return mapping.tags[tag] as string;
	if (rules === null) return null;
	if (rules.byTag !== undefined && Object.hasOwn(rules.byTag, tag)) return rules.byTag[tag] as string;
	if (tagClass !== undefined && rules.byClass !== undefined && Object.hasOwn(rules.byClass, tagClass)) {
		return rules.byClass[tagClass] ?? null;
	}
	return null;
}

/** Where a project's staging lives in a shared folder: a worker's grant for a tag is its directory under it. */
export function sharedStagingDir(root: string, projectKey: string, tag?: string): string {
	const dir = join(root, "staging", projectKey);
	return tag === undefined ? dir : join(dir, encodeTagSegment(tag));
}

/** The parts of a shared folder that are the store itself: never a write grant's, never a file to edit. */
export function sharedBookkeepingDirs(root: string): string[] {
	return [join(root, "log"), join(root, "pages"), join(root, "objects")];
}
