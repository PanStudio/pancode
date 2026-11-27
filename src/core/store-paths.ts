// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The harness side of the store's names and paths: where this host keeps the
 * store, which project a working directory belongs to, and what a store tool
 * call writes. Names, tag encoding and the layout itself are `@pancode/store/paths`;
 * every function here resolves the store root (`src/core/xdg.ts`) and the
 * project key for `cwd`, then asks the package.
 *
 * Every function here is pure apart from `realpath`, reading `.git` and
 * `commondir`, and, with more than one root, one `stat` of `placement.json`
 * (re-read only when it changed): the safety layer predicts where a store call
 * writes from its arguments alone, the way it predicts the `artifact` default
 * path (`src/core/artifact-paths.ts`). The backend kind, roots and placement
 * rules come from settings through `provideStoreSettings`. A shared store has
 * one root, the folder several hosts mount: its log, pages and objects are the
 * store's bookkeeping, and the only directories a grant or a write reference
 * names are the project's `staging/<key>/<tag>/`. An s3 store has no local roots: a store call writes no path on this host, so every prediction
 * below is empty and the store's own paths refuse.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { StoreTagClass } from "@pancode/store/backend";
import {
	storeBlobPath as blobPathIn,
	storeBookkeepingPaths as bookkeepingPathsIn,
	storeCacheDir as cacheDirIn,
	emptyStorePlacement,
	isRecordsTag,
	parseStorePlacement,
	storeProjectDir as projectDirIn,
	recordsTag,
	resolvePlacement,
	STORE_DEFAULT_ROOT_NAME,
	STORE_PUT_TAG_CLASS,
	STORE_TAG_CLASSES,
	type StorePlacementMap,
	type StorePlacementRules,
	type StoreRootSpec,
	sharedBookkeepingDirs,
	sharedStagingDir,
	storeMainCheckout,
	storePlacementPath,
	storeProjectKey,
	storeProjectKeyForId,
	storeTagDir as tagDirIn,
	validateBlobName,
	validateTagName,
} from "@pancode/store/paths";
import type { StoreBackendSetting, StoreS3Setting, StoreSharedSetting } from "./defaults.js";
import { pancodeProjectRoot } from "./project-root.js";
import { pancodeCachePath, pancodeDataPath } from "./xdg.js";

export {
	decodeTagSegment,
	encodeTagSegment,
	isRecordsTag,
	recordsTag,
	STORE_BLOB_MAX_BYTES,
	STORE_DEFAULT_ROOT_NAME,
	STORE_RECORDS_SUFFIX,
	STORE_TAG_MAX_BYTES,
	validateBlobName,
	validateTagName,
} from "@pancode/store/paths";

/**
 * Set on a `put`'s admission arguments, never by the model, to the size in bytes of the blob it
 * names when that blob already exists: admission judges the put as the replace it is, and the
 * safety judge is told what it replaces.
 */
export const STORE_REPLACES_ARG = "__storeReplaces";

/** The size of the blob a put's admission found it replacing, else null. */
export function storeReplacedBytes(args: Readonly<Record<string, unknown>> | undefined): number | null {
	const bytes = args?.[STORE_REPLACES_ARG];
	return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

/**
 * The blob a put's admission found it replacing (its tag, its name, which defaults to the source
 * path's basename like the put's own, and its size), else null. Both the safety judge and the
 * operator's approval line describe a replace from this instead of showing the marker.
 */
export function storeReplacedBlob(
	args: Readonly<Record<string, unknown>> | undefined,
): { tag: string; blob: string; bytes: number } | null {
	if (args?.op !== "put") return null;
	const bytes = storeReplacedBytes(args);
	if (bytes === null) return null;
	const { tag, blob, path } = args;
	const name = typeof blob === "string" && blob.length > 0 ? blob : typeof path === "string" ? basename(path) : "";
	return { tag: String(tag), blob: name, bytes };
}

/**
 * Main checkout for a linked worktree, else `pancodeProjectRoot(cwd)`, so workers
 * in task worktrees key the same store as the session that dispatched them.
 * `storeMainCheckout` is the package's, so the store server's `--project` keys the same way.
 * The same `.git` then `commondir` walk exists in `taskWorktreeOrigin`
 * (`src/core/task-worktree-claim.ts`) and `linkedWorktreeMainRoot`
 * (`src/domains/memory/operations.ts`); each also checks an ownership claim or
 * back link this lookup does not need, so they are not merged here.
 */
export function storeProjectRoot(cwd: string): string {
	return storeMainCheckout(pancodeProjectRoot(cwd));
}

let projectIdProvider: ((root: string) => string | undefined) | null = null;
const projectIdCache = new Map<string, string | null>();

/**
 * Where a project's `store.projectId` comes from: settings register a reader of the tracked project layer
 * at the main checkout (this module cannot read settings itself). Each main checkout is asked once per
 * process, so the key a session starts with is the key it keeps; a changed id takes effect on restart.
 */
export function provideStoreProjectId(provider: ((root: string) => string | undefined) | null): void {
	projectIdProvider = provider;
	projectIdCache.clear();
}

/** The project id the tracked settings of the main checkout `root` give it, or undefined. */
export function storeProjectIdFor(root: string): string | undefined {
	let id = projectIdCache.get(root);
	if (id === undefined) {
		id = projectIdProvider?.(root) ?? null;
		projectIdCache.set(root, id);
	}
	return id ?? undefined;
}

/**
 * The store key of the project whose main checkout is `root`: its project id's key when its tracked
 * settings set one, else the key of its real path. Every harness caller keys the store through this.
 */
export function storeProjectKeyFor(root: string): string {
	const id = storeProjectIdFor(root);
	return id !== undefined ? storeProjectKeyForId(id) : storeProjectKey(root);
}

export function storeRoot(): string {
	return join(pancodeDataPath(), "store");
}

/** The store settings give this host; null for the one local root under the data directory. */
export interface StoreHostSettings {
	/** Default local. */
	backend?: StoreBackendSetting;
	/** The folder, when `backend` is shared. */
	shared?: StoreSharedSetting | null;
	/** The bucket, when `backend` is s3. */
	s3?: StoreS3Setting | null;
	roots: ReadonlyArray<StoreRootSpec>;
	placement: StorePlacementRules;
}

interface HostStore {
	key: string;
	kind: StoreBackendSetting;
	s3: StoreS3Setting | null;
	/** Empty for a store without local roots. */
	roots: StoreRootSpec[];
	rules: StorePlacementRules;
}

let settingsProvider: (() => StoreHostSettings | null) | null = null;
let hostCache: HostStore | null = null;

/**
 * Where store roots come from. Settings register this (this module cannot read settings itself); it is
 * asked once per process and data directory, so admission, grants and the write agree for a whole session.
 */
export function provideStoreSettings(provider: (() => StoreHostSettings | null) | null): void {
	settingsProvider = provider;
	hostCache = null;
}

/** The shared folder; settings validation refuses a shared backend without one before this is asked. */
function sharedRootOf(configured: StoreHostSettings | null): string {
	const root = configured?.shared?.root;
	if (root === undefined) throw new Error("store.backend is shared but store.shared names no root");
	return root;
}

function hostStore(): HostStore {
	const key = storeRoot();
	if (hostCache?.key === key) return hostCache;
	const configured = settingsProvider?.() ?? null;
	const kind = configured?.backend ?? "local";
	const roots =
		kind === "s3"
			? []
			: kind === "shared"
				? [{ name: STORE_DEFAULT_ROOT_NAME, path: sharedRootOf(configured), durable: true, purge: null }]
				: configured !== null && configured.roots.length > 0
					? configured.roots.map((root) => ({ ...root }))
					: [{ name: STORE_DEFAULT_ROOT_NAME, path: key, durable: true, purge: null }];
	hostCache = { key, kind, s3: configured?.s3 ?? null, roots, rules: configured?.placement ?? {} };
	return hostCache;
}

/** The kind of store settings select for this host. */
export function storeBackendKind(): StoreBackendSetting {
	return hostStore().kind;
}

/** The bucket `store.s3` names, or null when user settings configure none. */
export function storeS3Settings(): StoreS3Setting | null {
	return hostStore().s3;
}

/** Whether the store keeps nothing under a path on this host, so no store call writes one. */
function withoutLocalRoots(): boolean {
	return hostStore().roots.length === 0;
}

/** The shared folder when this host's store is shared, else null. */
function sharedFolder(): string | null {
	const { kind, roots } = hostStore();
	return kind === "shared" ? (roots[0] as StoreRootSpec).path : null;
}

/** The roots this host's store keeps tags under; the first is the primary. Empty for an s3 store. */
export function storeRootSpecs(): StoreRootSpec[] {
	return hostStore().roots.map((root) => ({ ...root }));
}

/** The rules that place a new tag on a root. */
export function storePlacementRules(): StorePlacementRules {
	return hostStore().rules;
}

/** The primary root's project directory: records, locks, `project.json` and `placement.json` live here. */
export function storeProjectDir(cwd: string): string {
	return projectDirIn(primaryRoot().path, projectKeyOf(cwd));
}

function primaryRoot(): StoreRootSpec {
	const { kind, roots } = hostStore();
	const primary = roots[0];
	if (primary === undefined) throw new Error(`The ${kind} store has no local root.`);
	return primary;
}

function projectKeyOf(cwd: string): string {
	return storeProjectKeyFor(storeProjectRoot(cwd));
}

let placementCache: { file: string; stamp: string; mapping: StorePlacementMap } | null = null;

/**
 * The project's placement map, re-read only when `placement.json` changed: one `stat` a call. The
 * predictions below skip it with one root, where every reachable tag is on the primary.
 */
export function storePlacement(cwd: string): StorePlacementMap {
	return placementIn(storeProjectDir(cwd));
}

function placementIn(projectDir: string): StorePlacementMap {
	const file = storePlacementPath(projectDir);
	const info = statSync(file, { throwIfNoEntry: false });
	if (info === undefined) return emptyStorePlacement();
	const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
	if (placementCache?.file === file && placementCache.stamp === stamp) return placementCache.mapping;
	let mapping: StorePlacementMap;
	try {
		mapping = parseStorePlacement(readFileSync(file, "utf8"));
	} catch {
		// The backend refuses every call while the map is damaged; until then a prediction names the primary.
		return emptyStorePlacement();
	}
	placementCache = { file, stamp, mapping };
	return mapping;
}

/** The project directory on the named root, or null when that root is not configured. */
function projectDirOn(cwd: string, rootName: string): string | null {
	const root = hostStore().roots.find((candidate) => candidate.name === rootName);
	return root === undefined ? null : projectDirIn(root.path, projectKeyOf(cwd));
}

/**
 * The project directory a tag lives on. `createClass` is set for a call that may create the tag: an
 * unplaced tag then goes where creation would put it (`resolvePlacement` with the same rules).
 */
function tagProjectDir(cwd: string, tag: string, createClass?: StoreTagClass): string {
	const primaryDir = storeProjectDir(cwd);
	const { roots, rules } = hostStore();
	if (roots.length === 1 || isRecordsTag(tag)) return primaryDir;
	const mapping = placementIn(primaryDir);
	const name = resolvePlacement(mapping, createClass === undefined ? null : rules, tag, createClass);
	if (name === null) return primaryDir;
	return projectDirOn(cwd, name) ?? primaryDir;
}

/** A tag's directory; in a shared folder, its staging directory, the only part of the tag a path names. */
export function storeTagDir(cwd: string, tag: string): string {
	const shared = sharedFolder();
	if (shared !== null) return sharedStagingDir(shared, projectKeyOf(cwd), tag);
	return tagDirIn(tagProjectDir(cwd, tag), tag);
}

export function storeBlobPath(cwd: string, tag: string, blob: string): string {
	return blobPathIn(tagProjectDir(cwd, tag), tag, blob);
}

/**
 * Directory boundaries a dispatch grant of `tags` adds to a worker's write
 * scope (M-31): each tag's directory on its root and its records tag on the
 * primary. A tag not created yet gets its directory on every root placement
 * could create it on, since the worker names its class only when it creates it.
 * In a shared folder a grant is each tag's staging directory alone: its records live in the log.
 */
export function storeGrantBoundaries(cwd: string, tags: ReadonlyArray<string>): string[] {
	if (withoutLocalRoots()) return [];
	const shared = sharedFolder();
	if (shared !== null) return tags.map((tag) => `${sharedStagingDir(shared, projectKeyOf(cwd), tag)}/`);
	const primaryDir = storeProjectDir(cwd);
	const { roots, rules } = hostStore();
	const mapping = roots.length === 1 ? emptyStorePlacement() : placementIn(primaryDir);
	return tags.flatMap((tag) => {
		const dirs = new Set<string>();
		if (roots.length === 1 || Object.hasOwn(mapping.tags, tag)) dirs.add(tagProjectDir(cwd, tag));
		else {
			dirs.add(primaryDir);
			for (const tagClass of STORE_TAG_CLASSES) {
				const name = resolvePlacement(mapping, rules, tag, tagClass);
				const dir = name === null ? null : projectDirOn(cwd, name);
				if (dir !== null) dirs.add(dir);
			}
		}
		return [...[...dirs].map((dir) => `${tagDirIn(dir, tag)}/`), `${tagDirIn(primaryDir, recordsTag(tag))}/`];
	});
}

/** True when an absolute path lies inside a store root. */
export function isStorePath(candidate: string): boolean {
	return hostStore().roots.some(({ path: root }) => candidate === root || candidate.startsWith(`${root}/`));
}

/** Where the local backend puts the read-only copies `get` hands back (M-36). */
function storeCacheDir(cwd: string): string {
	return cacheDirIn(pancodeCachePath(), projectKeyOf(cwd));
}

/**
 * This project's directory on every store root, the primary first. One root gives `[storeProjectDir(cwd)]`;
 * a shared folder gives the project's staging directory.
 */
export function storeProjectDirs(cwd: string): string[] {
	const key = projectKeyOf(cwd);
	const shared = sharedFolder();
	if (shared !== null) return [sharedStagingDir(shared, key)];
	return hostStore().roots.map((root) => projectDirIn(root.path, key));
}

/**
 * Trees outside the workspace the model may read: this project's directory on
 * every store root and the cache whose copies `store get` hands back.
 */
export function storeReadRoots(cwd: string): string[] {
	return [...storeProjectDirs(cwd), storeCacheDir(cwd)];
}

/**
 * Every path a store write touches, from tool arguments alone: the primary
 * target `storeWriteTarget` names first, then the blob's records tag (put,
 * remove and note append a record there), `project.json` and `placement.json`
 * (written when a tag or records tag is first created; a tag created on another
 * root writes that root's `project.json` too) and the store lock directory.
 * Empty for read ops and malformed calls. In a shared folder: the target in the
 * tag's staging directory, then the folder's log, pages and objects.
 */
export function storeWriteSet(cwd: string, args: Record<string, unknown> | undefined): string[] {
	const primary = storeWriteTarget(cwd, args);
	if (primary === null) return [];
	const shared = sharedFolder();
	if (shared !== null) return [primary, ...sharedBookkeepingDirs(shared)];
	const tag = String(args?.tag);
	const tagDir = tagProjectDir(cwd, tag, createClassOf(args));
	const primaryDir = storeProjectDir(cwd);
	return [
		...new Set([
			primary,
			...bookkeepingPathsIn(primaryDir, tag),
			storePlacementPath(primaryDir),
			...(tagDir === primaryDir ? [] : [join(tagDir, "project.json")]),
		]),
	];
}

/**
 * What the store itself writes for any write into `tag`, besides the op's
 * own target: the records tag directory itself, `project.json` (on the primary
 * and on each other root a tag can be created on), `placement.json` and the
 * lock directory; in a shared folder, its log, pages and objects. A grant does
 * not add these to a worker's write roots (its shell must not write them); the
 * policy engine admits them with a granted call.
 */
export function storeBookkeepingPaths(cwd: string, tag: string): string[] {
	if (withoutLocalRoots()) return [];
	const shared = sharedFolder();
	if (shared !== null) return sharedBookkeepingDirs(shared);
	const primaryDir = storeProjectDir(cwd);
	const key = projectKeyOf(cwd);
	const others = hostStore()
		.roots.slice(1)
		.map((root) => join(projectDirIn(root.path, key), "project.json"));
	return [...bookkeepingPathsIn(primaryDir, tag), storePlacementPath(primaryDir), ...others];
}

/**
 * Paths strictly inside the call's tag directory and inside its records tag
 * directory. Write roots that cover both hold the grant `storeGrantBoundaries`
 * gives for the tag; in a shared folder, a path inside its staging directory.
 * Empty for read ops and malformed calls.
 */
export function storeGrantProbes(cwd: string, args: Record<string, unknown> | undefined): string[] {
	if (storeWriteTarget(cwd, args) === null) return [];
	const tag = String(args?.tag);
	const shared = sharedFolder();
	if (shared !== null) return [join(sharedStagingDir(shared, projectKeyOf(cwd), tag), ".probe")];
	return [
		join(tagDirIn(tagProjectDir(cwd, tag, createClassOf(args)), tag), "blobs"),
		join(tagDirIn(storeProjectDir(cwd), recordsTag(tag)), "blobs"),
	];
}

/** The class the store tool's `create` gives a tag when the call names none. */
const STORE_TOOL_CREATE_CLASS: StoreTagClass = "output";

/** The class a write op would give the tag it creates; a `remove` or `note` never creates a placed tag. */
function createClassOf(args: Record<string, unknown> | undefined): StoreTagClass | undefined {
	if (args?.op === "create") {
		const named = STORE_TAG_CLASSES.find((tagClass) => tagClass === args.class);
		return named ?? STORE_TOOL_CREATE_CLASS;
	}
	return args?.op === "put" ? STORE_PUT_TAG_CLASS : undefined;
}

/**
 * Where a store write lands, from tool arguments alone; null for read ops and malformed calls. A `put`
 * or `create` that will make its tag lands where creation places it. In a shared folder every op names
 * the tag's staging directory, and a put or remove the blob's name inside it: the store publishes
 * through its log, so no op writes a path a model can name.
 */
export function storeWriteTarget(cwd: string, args: Record<string, unknown> | undefined): string | null {
	if (args === undefined || withoutLocalRoots()) return null;
	const tag = args.tag;
	if (typeof tag !== "string" || validateTagName(tag) !== null) return null;
	const createClass = createClassOf(args);
	const shared = sharedFolder();
	const staging = shared === null ? null : sharedStagingDir(shared, projectKeyOf(cwd), tag);
	const blobTarget = (blob: unknown): string | null =>
		typeof blob !== "string" || validateBlobName(blob) !== null
			? null
			: staging !== null
				? join(staging, blob)
				: blobPathIn(tagProjectDir(cwd, tag, createClass), tag, blob);
	switch (args.op) {
		case "create":
			return staging ?? tagDirIn(tagProjectDir(cwd, tag, createClass), tag);
		case "note":
			return staging ?? tagDirIn(storeProjectDir(cwd), recordsTag(tag));
		case "remove":
			return blobTarget(args.blob);
		case "put":
			// The tool treats an empty blob as absent and stores under the source's basename, so the target does too.
			return blobTarget(
				typeof args.blob === "string" && args.blob.length > 0
					? args.blob
					: typeof args.path === "string"
						? basename(args.path)
						: undefined,
			);
		default:
			return null;
	}
}

/**
 * What a store write changes when `store.backend` is `s3`, from tool arguments alone: the tag or
 * `tag:blob` and the `s3://` prefix of the project's log that publishes it; null for any other backend,
 * read ops, malformed calls, or an unconfigured bucket.
 */
export function storeS3WriteTarget(cwd: string, args: Record<string, unknown> | undefined): string | null {
	if (args === undefined || storeBackendKind() !== "s3") return null;
	const s3 = storeS3Settings();
	if (s3 === null) return null;
	const tag = args.tag;
	if (typeof tag !== "string" || validateTagName(tag) !== null) return null;
	const where = ` in s3://${s3.bucket}/${s3.prefix}projects/${projectKeyOf(cwd)}/`;
	const blobTarget = (blob: unknown): string | null =>
		typeof blob === "string" && validateBlobName(blob) === null ? `${tag}:${blob}${where}` : null;
	switch (args.op) {
		case "create":
			return `${tag}${where}`;
		case "note":
			return `${recordsTag(tag)}${where}`;
		case "remove":
			return blobTarget(args.blob);
		case "put":
			return blobTarget(
				typeof args.blob === "string" && args.blob.length > 0
					? args.blob
					: typeof args.path === "string"
						? basename(args.path)
						: undefined,
			);
		default:
			return null;
	}
}
