// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent, constants as fsConstants } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	statfs,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { StoreBackend } from "./backend/backend.js";
import { registerStoreBackend } from "./backend/registry.js";
import {
	compileBlobPattern,
	type StoreBackendFacts,
	type StoreBlobPut,
	StoreRefusal,
	type StoreTagClass,
	type StoreUsage,
} from "./backend/types.js";
import { fsyncDirectoryAsync, safeResourceWriteAsync } from "./durable-write.js";
import { hashStoreFile } from "./hash.js";
import { ensureStoreRootId, readStoreRootId } from "./identity.js";
import { breakStoreLock, listStoreLocks, readStoreLock, withStoreLock } from "./lock.js";
import {
	decodeTagSegment,
	emptyStorePlacement,
	encodeTagSegment,
	isRecordsTag,
	parseStorePlacement,
	resolvePlacement,
	type StorePlacementMap,
	type StorePlacementRules,
	type StoreRootSpec,
	serializeStorePlacement,
	storeBlobPath,
	storeCacheDir,
	storePlacementPath,
	storeProjectDir,
	storeTagDir,
	validateBlobName,
	validatePlacementRules,
	validateStoreRoots,
	validateTagName,
} from "./paths/index.js";

/** Where a local store lives and how it orders its writers. */
export interface LocalStoreOptions {
	/**
	 * Non-empty. Project directories live under `<root.path>/projects/<projectKey>`; the first root is the
	 * primary and must be durable.
	 */
	roots: ReadonlyArray<StoreRootSpec>;
	/** Where new tags go. Changing the rules never moves a tag that exists. */
	placement?: StorePlacementRules;
	/** The cache root: `getBlobAsPath` copies live under `<cacheDir>/store/<projectKey>`. */
	cacheDir: string;
	/** `storeProjectKey` of the project's main checkout, or `storeProjectKeyForId` of its project id. */
	projectKey: string;
	/** The project id its tracked settings give it, written to `project.json`; absent when it has none. */
	projectId?: string;
	/** The project's main checkout, written to `project.json` when the store first creates it. */
	projectRoot: string;
	/**
	 * Runs before `getOrCreateTag` makes its first directory, and only there, so reads never create
	 * anything: a host creates its data root here with that root's own mode and marker.
	 */
	prepareRoot?: () => void;
	/**
	 * Orders writers of one file in this process; the store lock orders them across processes.
	 * Default: run `fn` directly.
	 */
	serialize?: <T>(path: string, fn: () => Promise<T>) => Promise<T>;
}

/** The tag attribute holding a tag's class, written by the host that created the tag. */
export const STORE_CLASS_XATTR = "pancode.class";

const XATTR_KEY_MAX_BYTES = 255;
const XATTR_VALUE_MAX_BYTES = 64 * 1024;
const RECORD_MAX_BYTES = 64 * 1024;

function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Every method throws StoreRefusal and nothing else, so OS errors are mapped here. */
function refusalFrom(error: unknown): StoreRefusal {
	if (error instanceof StoreRefusal) return error;
	if (errnoOf(error) === "ENOSPC") {
		return new StoreRefusal("no-space", `The store's file system is full: ${messageOf(error)}`);
	}
	return new StoreRefusal("io", messageOf(error));
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw refusalFrom(error);
	}
}

/** A records tag (`<tag>/.records`) is valid when its base tag is; validateTagName reserves the dot for it. */
function tagProblem(tag: string): string | null {
	return validateTagName(tag, { allowRecords: true });
}

function checkTag(tag: string): void {
	const problem = tagProblem(tag);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

const RECORD_NAME = /^(.+)#\d{8}$/u;

/** In a records tag a blob is named `<blob>#<8-digit seq>` (M-23), the one place `#` is allowed. */
function checkBlob(tag: string, blob: string): void {
	const record = isRecordsTag(tag) ? RECORD_NAME.exec(blob) : null;
	const problem = validateBlobName(record?.[1] ?? blob);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

async function lstatOrNull(target: string) {
	try {
		return await lstat(target);
	} catch (error) {
		if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR") return null;
		throw error;
	}
}

/** realpath of the deepest existing ancestor, with the missing tail joined back on. */
async function resolveDeepest(target: string): Promise<string> {
	const tail: string[] = [];
	let current = path.resolve(target);
	for (;;) {
		try {
			return path.join(await realpath(current), ...tail.reverse());
		} catch (error) {
			if (errnoOf(error) !== "ENOENT" && errnoOf(error) !== "ENOTDIR") throw error;
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(target);
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

/** tempSibling's name shape, so list hides only the backend's own temps and still lists a blob named `*.tmp`. */
const TEMP_SIBLING = /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/u;

function tempSibling(target: string): string {
	const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
	return path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
}

async function fsyncFile(filePath: string): Promise<void> {
	// Windows FlushFileBuffers requires a handle opened with write access.
	const handle = await open(filePath, process.platform === "win32" ? "r+" : "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Create target with data exactly once. The bytes go to a private temp name
 * first and link() publishes them, so a crash never leaves a short file under
 * the real name, and link's EEXIST picks one winner as open("wx") would.
 */
async function createExclusive(target: string, data: Uint8Array | string): Promise<boolean> {
	await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const temp = tempSibling(target);
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temp, target);
		} catch (error) {
			if (errnoOf(error) === "EEXIST") return false;
			throw error;
		}
		await fsyncDirectoryAsync(path.dirname(target));
		return true;
	} finally {
		await rm(temp, { force: true });
	}
}

interface TagFile {
	v: 1;
	tag: string;
	xattrs: Record<string, string>;
	createdAt: string;
}

/** Directories sort as `name/`, so a depth-first walk yields full names in sorted order. */
function walkKey(entry: Dirent): string {
	return entry.isDirectory() ? `${entry.name}/` : entry.name;
}

/**
 * True when a `path.relative` result leaves its base: exactly `..`, a `..` segment followed by a
 * separator, or another root. A private copy of the harness's `src/core/path-containment.ts`.
 */
function relativePathEscapes(relative: string): boolean {
	return (
		relative === ".." || relative.startsWith("../") || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
	);
}

const runDirectly = <T>(_path: string, fn: () => Promise<T>): Promise<T> => fn();

/** statfs magic numbers of file systems that are local to this host on Linux. */
const LOCAL_FS_TYPES = new Set([
	0xef53, // ext2, ext3, ext4
	0x58465342, // xfs
	0x9123683e, // btrfs
	0x01021994, // tmpfs
	0xf2f52010, // f2fs
	0x2fc12fc1, // zfs
]);

/**
 * Clone `source` to the new file `target` by reflink. False when the file system cannot (or across file
 * systems), with nothing left at `target`; the caller then copies.
 */
async function cloneInto(source: string, target: string): Promise<boolean> {
	try {
		await copyFile(source, target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE);
		return true;
	} catch (error) {
		const code = errnoOf(error);
		if (code === "EEXIST" || code === "ENOENT" || code === "EACCES" || code === "ENOSPC") throw error;
		// EOPNOTSUPP, EXDEV, ENOSYS, EINVAL and the like: no clone here. A partial target is not ours to keep.
		await rm(target, { force: true });
		return false;
	}
}

interface PlacedTag {
	root: StoreRootSpec;
	/** `<root>/projects/<key>`: where the tag's own directory lives. */
	projectDir: string;
}

/**
 * The local backend: one host, plain directories, no replication, no blob versions. Its roots are
 * directories; each tag lives under the root it was created on, and records, locks and the placement
 * map live under the primary.
 */
export function createLocalStoreBackend(options: LocalStoreOptions): StoreBackend {
	const { projectRoot, projectId } = options;
	const rootProblem = validateStoreRoots(options.roots);
	if (rootProblem !== null) throw new StoreRefusal("invalid-name", rootProblem);
	const roots = options.roots.map((root) => ({ ...root }));
	const rules: StorePlacementRules = options.placement ?? {};
	const ruleProblem = validatePlacementRules(
		rules,
		roots.map((root) => root.name),
	);
	if (ruleProblem !== null) throw new StoreRefusal("invalid-name", ruleProblem);
	const primary = roots[0] as StoreRootSpec;
	const serialize = options.serialize ?? runDirectly;
	const projectDir = storeProjectDir(primary.path, options.projectKey);
	const cacheProjectDir = storeCacheDir(options.cacheDir, options.projectKey);
	const placementFile = storePlacementPath(projectDir);
	const onPrimary: PlacedTag = { root: primary, projectDir };
	let placementCache: { stamp: string; mapping: StorePlacementMap } | null = null;

	/** The placement map, re-read only when `placement.json` changed. */
	async function readPlacement(): Promise<StorePlacementMap> {
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(placementFile);
		} catch (error) {
			if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR") return emptyStorePlacement();
			throw error;
		}
		const stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
		if (placementCache?.stamp === stamp) return placementCache.mapping;
		let mapping: StorePlacementMap;
		try {
			mapping = parseStorePlacement(await readFile(placementFile, "utf8"));
		} catch (error) {
			if (errnoOf(error) === "ENOENT") return emptyStorePlacement();
			throw new StoreRefusal("io", `The store's placement map ${placementFile} is unreadable: ${messageOf(error)}`);
		}
		placementCache = { stamp, mapping };
		return mapping;
	}

	function rootNamed(name: string): StoreRootSpec | undefined {
		return roots.find((root) => root.name === name);
	}

	/**
	 * Refuse `unavailable` unless the root's directory is there, and writable for a write. The primary is
	 * exempt: it is created on first write.
	 */
	async function requireRoot(root: StoreRootSpec, write: boolean): Promise<void> {
		if (root === primary) return;
		let problem: string | null = null;
		try {
			if (!(await stat(root.path)).isDirectory()) problem = "is not a directory";
			else if (write) await access(root.path, fsConstants.W_OK);
		} catch (error) {
			problem = errnoOf(error) === "ENOENT" ? "is missing" : write ? "is not writable" : messageOf(error);
		}
		if (problem !== null) {
			throw new StoreRefusal("unavailable", `Store root ${root.name} (${root.path}) ${problem}.`);
		}
	}

	function placedOn(root: StoreRootSpec): PlacedTag {
		return root === primary ? onPrimary : { root, projectDir: storeProjectDir(root.path, options.projectKey) };
	}

	/** Where an existing tag lives, through the placement map alone. */
	async function placeOf(tag: string, write: boolean): Promise<PlacedTag> {
		const name = resolvePlacement(await readPlacement(), null, tag);
		if (name === null) return onPrimary;
		const root = rootNamed(name);
		if (root === undefined) {
			throw new StoreRefusal(
				"unavailable",
				`Tag ${tag} was created on store root ${name}, which is no longer configured; add the root back to reach it.`,
			);
		}
		await requireRoot(root, write);
		return placedOn(root);
	}

	async function assertUnder(place: PlacedTag, target: string): Promise<void> {
		const root = await resolveDeepest(place.projectDir);
		const resolved = await resolveDeepest(target);
		if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
			throw new StoreRefusal("is-link", `Refusing a store path that resolves outside this project's store: ${target}`);
		}
	}

	async function requireTag(tag: string, write = false): Promise<{ dir: string; place: PlacedTag }> {
		checkTag(tag);
		const place = await placeOf(tag, write);
		const dir = storeTagDir(place.projectDir, tag);
		await assertUnder(place, dir);
		const info = await lstatOrNull(path.join(dir, "tag.json"));
		if (!info?.isFile()) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
		return { dir, place };
	}

	/** Refuse when the blob, or any existing directory between `blobs/` and it, is a symbolic link. */
	async function blobTarget(tag: string, blob: string, write = false): Promise<{ target: string; place: PlacedTag }> {
		checkTag(tag);
		checkBlob(tag, blob);
		const place = await placeOf(tag, write);
		const target = storeBlobPath(place.projectDir, tag, blob);
		const blobsDir = path.join(storeTagDir(place.projectDir, tag), "blobs");
		await assertUnder(place, blobsDir);
		let current = blobsDir;
		for (const segment of blob.split("/")) {
			current = path.join(current, segment);
			const info = await lstatOrNull(current);
			if (info === null) break;
			if (info.isSymbolicLink()) {
				throw new StoreRefusal("is-link", `Refusing blob ${blob} in tag ${tag}: ${current} is a symbolic link.`);
			}
		}
		await assertUnder(place, target);
		return { target, place };
	}

	/** A blob cannot nest under another blob, nor take the name of a directory holding blobs. */
	async function refuseNameConflict(place: PlacedTag, tag: string, blob: string): Promise<void> {
		const blobsDir = path.join(storeTagDir(place.projectDir, tag), "blobs");
		const segments = blob.split("/");
		let current = blobsDir;
		for (const [index, segment] of segments.entries()) {
			current = path.join(current, segment);
			const info = await lstatOrNull(current);
			if (info === null) return;
			const prefix = segments.slice(0, index + 1).join("/");
			if (index < segments.length - 1 && !info.isDirectory()) {
				throw new StoreRefusal(
					"exists",
					`Refusing blob ${blob} in tag ${tag}: it would nest under the existing blob ${prefix}.`,
				);
			}
			if (index === segments.length - 1 && info.isDirectory()) {
				const inside = (await readdir(current)).find((name) => !TEMP_SIBLING.test(name));
				const example = inside === undefined ? "" : ` (for example ${blob}/${inside})`;
				throw new StoreRefusal(
					"exists",
					`Refusing blob ${blob} in tag ${tag}: existing blobs are stored under that name${example}.`,
				);
			}
		}
	}

	async function readTagFile(tag: string): Promise<TagFile> {
		const { dir } = await requireTag(tag);
		return JSON.parse(await readFile(path.join(dir, "tag.json"), "utf8")) as TagFile;
	}

	/** A root that is not durable takes writes only into a tag of class `cache`. */
	async function requireDurableOrCache(place: PlacedTag, tag: string, tagClass: string | undefined): Promise<void> {
		if (place.root.durable || tagClass === "cache") return;
		throw new StoreRefusal(
			"unavailable",
			`Store root ${place.root.name} is not durable, so it takes only tags of class cache; ${tag} is ${
				tagClass === undefined ? "of no recorded class" : `class ${tagClass}`
			}.`,
		);
	}

	/** Make the tag's directories and files on its root; `project.json` goes on the primary and on that root. */
	async function materializeTag(place: PlacedTag, tag: string): Promise<{ created: boolean }> {
		const dir = storeTagDir(place.projectDir, tag);
		await assertUnder(place, dir);
		await ensureStoreRootId(primary.path);
		if (place !== onPrimary) await ensureStoreRootId(place.root.path);
		await mkdir(path.join(dir, "blobs"), { recursive: true, mode: 0o700 });
		await assertUnder(place, path.join(dir, "blobs"));
		const createdAt = new Date().toISOString();
		const projectFile = `${JSON.stringify({ v: 1, root: projectRoot, ...(projectId !== undefined ? { projectId } : {}), createdAt })}\n`;
		await createExclusive(path.join(projectDir, "project.json"), projectFile);
		if (place !== onPrimary) await createExclusive(path.join(place.projectDir, "project.json"), projectFile);
		const tagFile: TagFile = { v: 1, tag, xattrs: {}, createdAt };
		return { created: await createExclusive(path.join(dir, "tag.json"), `${JSON.stringify(tagFile)}\n`) };
	}

	/**
	 * The primary's `tags` directory is the project's tag-list clock: a tag made or removed on another root
	 * moves its time too, so a host watching the tag list stats one directory however many roots there are.
	 */
	async function tickTagList(place: PlacedTag): Promise<void> {
		if (place === onPrimary) return;
		const tagsDir = path.join(projectDir, "tags");
		await mkdir(tagsDir, { recursive: true, mode: 0o700 });
		const now = new Date();
		await utimes(tagsDir, now, now);
	}

	/** Where a tag the map does not name would be created, refusing a root that cannot take it. */
	async function chooseRoot(mapping: StorePlacementMap, tag: string, tagClass?: StoreTagClass): Promise<PlacedTag> {
		const existing = Object.hasOwn(mapping.tags, tag) ? await placeOf(tag, true) : null;
		if (existing !== null) return existing;
		const name = resolvePlacement(mapping, rules, tag, tagClass) ?? primary.name;
		const root = rootNamed(name);
		if (root === undefined) {
			throw new StoreRefusal("unavailable", `Placement names store root ${name}, which is not configured.`);
		}
		await requireRoot(root, true);
		const place = placedOn(root);
		await requireDurableOrCache(place, tag, tagClass);
		return place;
	}

	async function getOrCreateTag(tag: string, tagClass?: StoreTagClass): Promise<{ created: boolean }> {
		checkTag(tag);
		// Blobs and records hold workspace bytes, argv and session ids, so the store is owner-only;
		// the host's prepareRoot gives a missing data root its own mode and marker first.
		options.prepareRoot?.();
		// Records tags live on the primary and never have an entry, so they skip the placement lock.
		if (isRecordsTag(tag)) return materializeTag(onPrimary, tag);
		// Refuse an unreachable root before the lock, which itself writes under the primary.
		await chooseRoot(await readPlacement(), tag, tagClass);
		return withStoreLock(projectDir, "placement.json", async () => {
			const mapping = await readPlacement();
			if (Object.hasOwn(mapping.tags, tag)) {
				const existing = await placeOf(tag, true);
				const present = (await lstatOrNull(path.join(storeTagDir(existing.projectDir, tag), "tag.json")))?.isFile();
				if (present !== true) await requireDurableOrCache(existing, tag, tagClass);
				return materializeTag(existing, tag);
			}
			const place = await chooseRoot(mapping, tag, tagClass);
			const root = place.root;
			// The decision is written down before the tag exists, so no reader ever finds the tag on a root
			// the map does not name.
			await mkdir(projectDir, { recursive: true, mode: 0o700 });
			await safeResourceWriteAsync(placementFile, serializeStorePlacement(mapping, tag, root.name), { mode: 0o600 });
			const made = await materializeTag(place, tag);
			await tickTagList(place);
			return made;
		});
	}

	/** Give the put's own temp file its blob name; the stat is of the temp, before a concurrent put can take the name. */
	async function finishPut(
		temp: string,
		target: string,
		put: {
			bytes: number;
			sha256: string;
			link: StoreBlobPut["link"];
			signal?: AbortSignal | undefined;
			tag: string;
			blob: string;
		},
	): Promise<StoreBlobPut> {
		await fsyncFile(temp);
		if (put.signal?.aborted) throw new StoreRefusal("io", `The put of ${put.blob} into ${put.tag} was aborted.`);
		const modifiedMs = (await lstat(temp)).mtimeMs;
		await rename(temp, target);
		await fsyncDirectoryAsync(path.dirname(target));
		return { bytes: put.bytes, modifiedMs, version: null, sha256: put.sha256, link: put.link, key: target };
	}

	let linksProbe: Promise<StoreBackendFacts["links"]> | null = null;

	/** Whether the primary root clones files, tried once with two scratch files that are removed after. */
	function primaryLinks(): Promise<StoreBackendFacts["links"]> {
		linksProbe ??= (async () => {
			if (!(await lstatOrNull(primary.path))?.isDirectory()) {
				linksProbe = null;
				return "copy" as const;
			}
			const probe = path.join(primary.path, `.reflink-probe-${randomBytes(6).toString("hex")}`);
			try {
				await writeFile(probe, "p", { flag: "wx", mode: 0o600 });
				return (await cloneInto(probe, `${probe}.clone`)) ? ("reflink" as const) : ("copy" as const);
			} catch {
				// A root this process cannot write to cannot be asked; a put there copies or refuses on its own.
				linksProbe = null;
				return "copy" as const;
			} finally {
				await rm(probe, { force: true });
				await rm(`${probe}.clone`, { force: true });
			}
		})();
		return linksProbe;
	}

	async function blobTotals(dir: string): Promise<{ blobs: number; bytes: number }> {
		const totals = { blobs: 0, bytes: 0 };
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (errnoOf(error) === "ENOENT") return totals;
			throw error;
		}
		for (const entry of entries) {
			if (TEMP_SIBLING.test(entry.name)) continue;
			const child = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				const inner = await blobTotals(child);
				totals.blobs += inner.blobs;
				totals.bytes += inner.bytes;
			} else if (entry.isFile()) {
				totals.blobs += 1;
				totals.bytes += (await lstat(child)).size;
			}
		}
		return totals;
	}

	async function freeBytesOf(dir: string): Promise<number | null> {
		try {
			const info = await statfs(dir);
			return Number(info.bavail) * Number(info.bsize);
		} catch {
			// No root yet, or a file system without statfs: null is the honest answer.
			return null;
		}
	}

	async function sharedFsOf(dir: string): Promise<false | "unverified"> {
		if (process.platform !== "linux") return "unverified";
		try {
			return LOCAL_FS_TYPES.has(Number((await statfs(dir)).type)) ? false : "unverified";
		} catch {
			// A root that cannot be examined is not known to be local.
			return "unverified";
		}
	}

	/** Tags whose directories are under `place` and whose placement names that root. */
	async function tagsOn(place: PlacedTag, mapping: StorePlacementMap): Promise<string[]> {
		const tagsDir = path.join(place.projectDir, "tags");
		let entries: string[];
		try {
			entries = await readdir(tagsDir);
		} catch (error) {
			if (errnoOf(error) === "ENOENT") return [];
			throw error;
		}
		const tags: string[] = [];
		for (const segment of entries) {
			let tag: string;
			try {
				tag = decodeTagSegment(segment);
			} catch {
				// An undecodable directory name is not a tag this store wrote.
				continue;
			}
			if (tagProblem(tag) !== null) continue;
			if ((resolvePlacement(mapping, null, tag) ?? primary.name) !== place.root.name) continue;
			try {
				JSON.parse(await readFile(path.join(tagsDir, segment, "tag.json"), "utf8"));
				tags.push(tag);
			} catch {
				// Without a readable tag.json the directory is not a tag (a crashed create, or a stray).
			}
		}
		return tags;
	}

	const backend: StoreBackend = {
		kind: "local",
		location: projectDir,

		facts: () =>
			guarded(async (): Promise<StoreBackendFacts> => {
				const rootFacts = [];
				for (const root of roots) {
					rootFacts.push({
						name: root.name,
						id: await readStoreRootId(root.path),
						durable: root.durable,
						sharedFs: await sharedFsOf(root.path),
						purge: root.purge,
						freeBytes: await freeBytesOf(root.path),
					});
				}
				return {
					kind: "local",
					mapping: "a tag is a directory and a blob is a regular file under it",
					tiers:
						rootFacts.length === 1
							? false
							: rootFacts.map((root, index) => ({
									name: root.name,
									score: rootFacts.length - index,
									freeBytes: root.freeBytes,
								})),
					multiNode: false,
					durable: true,
					conditionalPut: "if-absent",
					blobVersions: false,
					freeBytes: rootFacts[0]?.freeBytes ?? null,
					roots: rootFacts,
					links: await primaryLinks(),
				};
			}),

		withLock: (key, fn) => withStoreLock(projectDir, key, fn),

		listLocks: () => guarded(() => listStoreLocks(projectDir)),

		readLock: (id) => guarded(() => readStoreLock(projectDir, id)),

		breakLock: (id) => guarded(() => breakStoreLock(projectDir, id)),

		usage: (tag) =>
			guarded(async (): Promise<StoreUsage> => {
				const mapping = await readPlacement();
				// Each tag's `.records` provenance directory is metadata, not a user tag; `tags` skips it too.
				const names =
					tag === undefined ? (await backend.listTags()).filter((name) => validateTagName(name) === null) : [tag];
				const tags: Array<{ tag: string; root: string; blobs: number; bytes: number }> = [];
				for (const name of names) {
					const { dir, place } = await requireTag(name);
					tags.push({ tag: name, root: place.root.name, ...(await blobTotals(path.join(dir, "blobs"))) });
				}
				const placed = new Set(Object.values(mapping.tags));
				const rootUsage = [];
				for (const root of roots) {
					if (root !== primary && !placed.has(root.name) && tag === undefined) {
						rootUsage.push({ name: root.name, tags: 0, blobs: 0, bytes: 0, freeBytes: await freeBytesOf(root.path) });
						continue;
					}
					const mine = tags.filter((entry) => entry.root === root.name);
					rootUsage.push({
						name: root.name,
						tags: mine.length,
						blobs: mine.reduce((sum, entry) => sum + entry.blobs, 0),
						bytes: mine.reduce((sum, entry) => sum + entry.bytes, 0),
						freeBytes: await freeBytesOf(root.path),
					});
				}
				return { tags, roots: rootUsage };
			}),

		getOrCreateTag: (tag, createOptions) => guarded(() => getOrCreateTag(tag, createOptions?.class)),

		tagExists: (tag) =>
			guarded(async () => {
				try {
					await requireTag(tag);
					return true;
				} catch (error) {
					if (error instanceof StoreRefusal && error.reason === "not-found") return false;
					throw error;
				}
			}),

		listTags: () =>
			guarded(async () => {
				const mapping = await readPlacement();
				const tags = await tagsOn(onPrimary, mapping);
				const placedRoots = new Set(Object.values(mapping.tags));
				for (const root of roots) {
					// A root no tag was placed on holds none of this project's tags; an unreachable one lists none.
					if (root === primary || !placedRoots.has(root.name)) continue;
					try {
						await requireRoot(root, false);
					} catch {
						// An unavailable root's tags refuse by name when used; the listing shows what can be reached.
						continue;
					}
					tags.push(...(await tagsOn(placedOn(root), mapping)));
				}
				return tags.sort();
			}),

		delTag: (tag) =>
			guarded(async () => {
				checkTag(tag);
				const place = await placeOf(tag, true);
				const dir = storeTagDir(place.projectDir, tag);
				await assertUnder(place, dir);
				await rm(dir, { recursive: true, force: true });
				if (isRecordsTag(tag) || !Object.hasOwn((await readPlacement()).tags, tag)) return;
				// A deleted tag gives up its placement: a tag created later under the same name is a new tag.
				await withStoreLock(projectDir, "placement.json", async () => {
					const mapping = await readPlacement();
					if (!Object.hasOwn(mapping.tags, tag)) return;
					await safeResourceWriteAsync(placementFile, serializeStorePlacement(mapping, tag, null), { mode: 0o600 });
				});
				await tickTagList(place);
			}),

		setTagXattr: (tag, key, value) =>
			guarded(async () => {
				if (key.length === 0 || Buffer.byteLength(key, "utf8") > XATTR_KEY_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A tag attribute key must be 1 to ${XATTR_KEY_MAX_BYTES} bytes.`);
				}
				if (Buffer.byteLength(value, "utf8") > XATTR_VALUE_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A tag attribute value must be at most ${XATTR_VALUE_MAX_BYTES} bytes.`);
				}
				const file = path.join((await requireTag(tag, true)).dir, "tag.json");
				// The queue orders writers in this process; the store lock orders them across processes.
				await serialize(file, () =>
					withStoreLock(projectDir, `tag.json\0${tag}`, async () => {
						const current = await readTagFile(tag);
						current.xattrs = { ...current.xattrs, [key]: value };
						await safeResourceWriteAsync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
					}),
				);
			}),

		getTagXattrs: (tag) => guarded(async () => ({ ...(await readTagFile(tag)).xattrs })),

		putBlobFromFile: (tag, blob, source, signal, putOptions) =>
			guarded(async (): Promise<StoreBlobPut> => {
				const { place } = await requireTag(tag, true);
				if (!place.root.durable)
					await requireDurableOrCache(place, tag, (await readTagFile(tag)).xattrs[STORE_CLASS_XATTR]);
				const { target } = await blobTarget(tag, blob, true);
				let sourceInfo: Awaited<ReturnType<typeof stat>>;
				try {
					sourceInfo = await stat(source);
				} catch (error) {
					if (errnoOf(error) === "ENOENT") throw new StoreRefusal("not-found", `No file at ${source}.`);
					throw error;
				}
				if (!sourceInfo.isFile()) throw new StoreRefusal("not-a-file", `${source} is not a regular file.`);
				if (signal?.aborted) throw new StoreRefusal("io", `The put of ${blob} into ${tag} was aborted.`);
				await refuseNameConflict(place, tag, blob);
				await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
				// A link may have been planted between the check and mkdir; judge the path again.
				await blobTarget(tag, blob, true);
				const temp = tempSibling(target);
				const hash = createHash("sha256");
				let bytes = 0;
				let transfer: StoreBlobPut["link"] = "copy";
				try {
					if (putOptions?.mode === "link" && (await cloneInto(source, temp))) {
						transfer = "reflink";
						// The digest and size are of the clone this put made, as for a copy.
						const digest = await hashStoreFile(temp, signal);
						bytes = (await lstat(temp)).size;
						return await finishPut(temp, target, { bytes, sha256: digest, link: transfer, signal, tag, blob });
					}
					await pipeline(
						createReadStream(source),
						async function* (chunks: AsyncIterable<Buffer>) {
							for await (const chunk of chunks) {
								hash.update(chunk);
								bytes += chunk.byteLength;
								yield chunk;
							}
						},
						createWriteStream(temp, { flags: "wx", mode: 0o600 }),
						...(signal !== undefined ? [{ signal }] : []),
					);
					return await finishPut(temp, target, { bytes, sha256: hash.digest("hex"), link: transfer, signal, tag, blob });
				} catch (error) {
					await rm(temp, { force: true });
					if (signal?.aborted) throw new StoreRefusal("io", `The put of ${blob} into ${tag} was aborted.`);
					throw error;
				}
			}),

		getBlobAsPath: (tag, blob) =>
			guarded(async () => {
				const { target } = await blobTarget(tag, blob);
				const info = await lstatOrNull(target);
				if (info === null) throw new StoreRefusal("not-found", `Tag ${tag} has no blob named ${blob}.`);
				if (!info.isFile()) throw new StoreRefusal("not-a-file", `Blob ${blob} in tag ${tag} is not a regular file.`);
				// The stored file backs the records, so `get` hands out a read-only copy under the store cache
				// (one of storeReadRoots); a write to it cannot change the blob.
				const tagCache = path.join(cacheProjectDir, encodeTagSegment(tag));
				const copy = path.join(tagCache, blob);
				try {
					await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
				} catch {
					// A stale entry blocks the blob's parents ("d" cached as a file, "d/e" wanted); the cache is disposable.
					await rm(tagCache, { recursive: true, force: true });
					await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
				}
				const temp = tempSibling(copy);
				try {
					await copyFile(target, temp);
					await chmod(temp, 0o400);
					await rm(copy, { recursive: true, force: true });
					await rename(temp, copy);
				} catch (error) {
					await rm(temp, { force: true });
					throw error;
				}
				return { path: copy, copied: true };
			}),

		putRecordIfAbsent: (tag, blob, data) =>
			guarded(async () => {
				if (data.byteLength > RECORD_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A record must be at most ${RECORD_MAX_BYTES} bytes.`);
				}
				// A record in a tag nobody created would be invisible to listTags, so the tag comes first.
				await getOrCreateTag(tag);
				const { target } = await blobTarget(tag, blob, true);
				return (await createExclusive(target, data)) ? "written" : "exists";
			}),

		getRecord: (tag, blob) =>
			guarded(async () => {
				const { target } = await blobTarget(tag, blob);
				const info = await lstatOrNull(target);
				if (info === null) return null;
				if (!info.isFile()) throw new StoreRefusal("not-a-file", `Record ${blob} in tag ${tag} is not a regular file.`);
				if (info.size > RECORD_MAX_BYTES) {
					throw new StoreRefusal("io", `Record ${blob} in tag ${tag} is larger than ${RECORD_MAX_BYTES} bytes.`);
				}
				return new Uint8Array(await readFile(target));
			}),

		statBlob: (tag, blob) =>
			guarded(async () => {
				const info = await lstatOrNull((await blobTarget(tag, blob)).target);
				if (!info?.isFile()) return null;
				return { bytes: info.size, modifiedMs: info.mtimeMs, version: null };
			}),

		listBlobs: (tag, q) =>
			guarded(async () => {
				const blobsDir = path.join((await requireTag(tag)).dir, "blobs");
				const matcher = q.pattern !== undefined ? compileBlobPattern(q.pattern) : null;
				const offset = Math.max(0, Math.floor(q.offset));
				const limit = Math.max(0, Math.floor(q.limit));
				const wanted = offset + limit + 1;
				const matches: string[] = [];
				const start = q.prefix ?? "";
				// A directory is entered only when a name under it can start with `start`.
				const reachable = (key: string): boolean => key.startsWith(start) || start.startsWith(key);
				const walk = async (dir: string, prefix: string): Promise<void> => {
					let entries: Dirent[];
					try {
						entries = await readdir(dir, { withFileTypes: true });
					} catch (error) {
						if (errnoOf(error) === "ENOENT") return;
						throw error;
					}
					entries.sort((a, b) => {
						const left = walkKey(a);
						const right = walkKey(b);
						return left < right ? -1 : left > right ? 1 : 0;
					});
					for (const entry of entries) {
						if (matches.length >= wanted) return;
						const name = `${prefix}${entry.name}`;
						// Dirent types come from lstat, so a link is neither a directory nor a file here.
						if (entry.isDirectory()) {
							if (reachable(`${name}/`)) await walk(path.join(dir, entry.name), `${name}/`);
						} else if (entry.isFile() && !TEMP_SIBLING.test(entry.name) && name.startsWith(start)) {
							if (matcher === null || matcher.test(name)) matches.push(name);
						}
					}
				};
				await walk(blobsDir, "");
				return { names: matches.slice(offset, offset + limit), hasMore: matches.length > offset + limit };
			}),

		delBlob: (tag, blob) =>
			guarded(async () => {
				const { target, place } = await blobTarget(tag, blob, true);
				const info = await lstatOrNull(target);
				if (!info?.isFile()) return false;
				await unlink(target);
				const blobsDir = path.join(storeTagDir(place.projectDir, tag), "blobs");
				let dir = path.dirname(target);
				while (dir.startsWith(`${blobsDir}${path.sep}`)) {
					try {
						await rmdir(dir);
					} catch {
						// Not empty, or already gone: either way the walk up stops here.
						break;
					}
					dir = path.dirname(dir);
				}
				return true;
			}),

		blobRefOfPath: async (realPath) => {
			const segmentsUnder = async (root: string): Promise<string[] | null> => {
				const resolved = await realpath(root).catch(() => null);
				if (resolved === null) return null;
				const relative = path.relative(resolved, realPath);
				if (relative === "" || relativePathEscapes(relative)) return null;
				return relative.split(path.sep);
			};
			for (const root of roots) {
				const stored = await segmentsUnder(placedOn(root).projectDir);
				if (stored === null) continue;
				const [tags, encodedTag, blobs, ...rest] = stored;
				if (tags !== "tags" || encodedTag === undefined || blobs !== "blobs" || rest.length === 0) return null;
				try {
					const tag = decodeTagSegment(encodedTag);
					// A directory on a root the tag is not placed on is a stray, not the tag.
					if ((resolvePlacement(await readPlacement(), null, tag) ?? primary.name) !== root.name) return null;
					return { tag, blob: rest.join("/") };
				} catch {
					// A malformed escape, or a placement map that cannot be read, names no blob of ours.
					return null;
				}
			}
			// The copy `get` handed out sits at <cache>/store/<projectKey>/<encoded tag>/<blob> and names its blob
			// while that blob is still stored.
			const cached = await segmentsUnder(cacheProjectDir);
			if (cached === null) return null;
			const [encodedTag, ...rest] = cached;
			if (encodedTag === undefined || rest.length === 0) return null;
			try {
				const ref = { tag: decodeTagSegment(encodedTag), blob: rest.join("/") };
				return (await lstatOrNull((await blobTarget(ref.tag, ref.blob)).target))?.isFile() === true ? ref : null;
			} catch {
				// A malformed escape or a name the store refuses is no blob of ours.
				return null;
			}
		},
	};
	return backend;
}

registerStoreBackend("local", createLocalStoreBackend);
