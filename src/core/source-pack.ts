// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { resolvePackageRoot } from "./package-root.js";
import { relativePathEscapes } from "./path-containment.js";

/**
 * The installed package carries most of its TypeScript source, under `src/` and
 * each workspace package's `packages/<name>/src/`, as one file instead of
 * ~1,700 loose ones, so PanCode can still read its own code without
 * the tarball paying an entry per file. A checkout never has this file in its
 * source tree and always reads the real files.
 *
 * Layout (written by scripts/build-source-pack.ts): the 8-byte magic, a u32 LE
 * index length, the UTF-8 JSON index, then each member as its own brotli
 * stream. One member decompresses alone, so a
 * read inflates one file and never the corpus.
 */
export const SOURCE_PACK_RELATIVE_PATH = join("dist", "assets", "source.pack");
const MAGIC = "PANSRC01";
const HEADER_BYTES = MAGIC.length + 4;
/**
 * Package-relative POSIX paths the pack may answer for: `src` and
 * `packages/<name>/src` with everything under them, plus `packages` and
 * `packages/<name>`, which in an installed package exist only to hold packed
 * source.
 */
const SOURCE_PATH = /^(?:src(?:\/.*)?|packages(?:\/[^/]+(?:\/src(?:\/.*)?)?)?)$/u;

/** Where one member sits, relative to the end of the index. */
export interface SourcePackEntry {
	path: string;
	offset: number;
	length: number;
	size: number;
}

interface SourcePackIndex {
	version: 1;
	files: SourcePackEntry[];
}

interface LoadedPack {
	file: string;
	bytes: number;
	mtimeMs: number;
	dataStart: number;
	byPath: Map<string, SourcePackEntry>;
	/** Every directory that holds a member (`src/...`, `packages/<name>/src/...` and their parents), so a directory gone from disk still reads as one. */
	directories: Set<string>;
	/** Whether the members are absent on disk, so the pack is what serves them. */
	serving: boolean;
}

let loaded: LoadedPack | null = null;

function readAt(fd: number, position: number, length: number): Buffer {
	const buffer = Buffer.alloc(length);
	let filled = 0;
	while (filled < length) {
		const got = readSync(fd, buffer, filled, length - filled, position + filled);
		if (got === 0) throw new Error(`source pack truncated at byte ${position + filled}`);
		filled += got;
	}
	return buffer;
}

/** The pack's index, read once per process and again only if the file changes underneath. */
function loadPack(packageRoot: string): LoadedPack | null {
	const file = sourcePackPath(packageRoot);
	let stats: { size: number; mtimeMs: number };
	try {
		stats = statSync(file);
	} catch {
		return null;
	}
	if (loaded?.file === file && loaded.bytes === stats.size && loaded.mtimeMs === stats.mtimeMs) return loaded;
	const fd = openSync(file, "r");
	try {
		const header = readAt(fd, 0, HEADER_BYTES);
		if (header.toString("latin1", 0, MAGIC.length) !== MAGIC) throw new Error(`not a source pack: ${file}`);
		const indexLength = header.readUInt32LE(MAGIC.length);
		const index = JSON.parse(readAt(fd, HEADER_BYTES, indexLength).toString("utf8")) as SourcePackIndex;
		if (index.version !== 1 || !Array.isArray(index.files)) throw new Error(`unsupported source pack: ${file}`);
		const first = index.files[0]?.path;
		const directories = new Set<string>();
		for (const entry of index.files) {
			for (let cut = entry.path.lastIndexOf("/"); cut > 0; cut = entry.path.lastIndexOf("/", cut - 1)) {
				const dir = entry.path.slice(0, cut);
				if (directories.has(dir)) break;
				directories.add(dir);
			}
		}
		loaded = {
			file,
			bytes: stats.size,
			mtimeMs: stats.mtimeMs,
			dataStart: HEADER_BYTES + indexLength,
			byPath: new Map(index.files.map((entry) => [entry.path, entry])),
			directories,
			serving: first !== undefined && !existsSync(join(packageRoot, first)),
		};
		return loaded;
	} finally {
		closeSync(fd);
	}
}

function sourcePackPath(packageRoot: string = resolvePackageRoot()): string {
	return join(packageRoot, SOURCE_PACK_RELATIVE_PATH);
}

/**
 * True when this package's source is served from the pack: the pack exists and
 * its members are absent on disk. A built checkout has a pack too, but its real
 * files win, so it answers false and a deleted checkout file stays deleted.
 */
export function sourceIsPacked(packageRoot: string = resolvePackageRoot()): boolean {
	try {
		return loadPack(packageRoot)?.serving === true;
	} catch {
		// An unreadable pack serves nothing, so the source is not packed.
		return false;
	}
}

/**
 * The package-relative POSIX path of `absolutePath` when it names the package's
 * own source (`src/...`, `packages/<name>/src/...`) or a directory above a
 * workspace package's source, else null.
 */
function packMemberPath(absolutePath: string, packageRoot: string): string | null {
	const rel = relative(packageRoot, absolutePath);
	if (rel.length === 0 || relativePathEscapes(rel)) return null;
	const member = rel.split(sep).join("/");
	return SOURCE_PATH.test(member) ? member : null;
}

/**
 * The packed bytes of `absolutePath`, or null when it is not a member or the
 * pack is not serving. Callers reach for this only after the real file was not
 * found, so a checkout and any file kept loose always read from disk.
 */
export function readPackedSource(
	absolutePath: string,
	packageRoot: string = resolvePackageRoot(),
): { bytes: Buffer; mtimeMs: number } | null {
	const member = packMemberPath(absolutePath, packageRoot);
	if (member === null) return null;
	const pack = loadPack(packageRoot);
	const entry = pack?.serving ? pack.byPath.get(member) : undefined;
	if (!pack || !entry) return null;
	const fd = openSync(pack.file, "r");
	try {
		const bytes = brotliDecompressSync(readAt(fd, pack.dataStart + entry.offset, entry.length));
		if (bytes.length !== entry.size) throw new Error(`source pack member ${member} inflated to the wrong size`);
		return { bytes, mtimeMs: pack.mtimeMs };
	} finally {
		closeSync(fd);
	}
}

/**
 * The pack's mtime when `absolutePath` names a directory that exists only in
 * the serving pack (`src/interactive` or `packages/store/src` of an installed
 * package), else null.
 * Like readPackedSource, callers ask only after the path was not found on disk.
 */
export function packedSourceDirectory(
	absolutePath: string,
	packageRoot: string = resolvePackageRoot(),
): { mtimeMs: number } | null {
	const member = packMemberPath(absolutePath, packageRoot);
	if (member === null) return null;
	const pack = loadPack(packageRoot);
	return pack?.serving && pack.directories.has(member) ? { mtimeMs: pack.mtimeMs } : null;
}

/**
 * What the serving pack holds under `absoluteDir`, for listings that walk the
 * disk: packed files and the directories that exist only to hold them, as
 * POSIX paths relative to `absoluteDir` (directories end in "/"). Only the
 * package root, its `src/`, `packages/`, each `packages/<name>/src/` and the
 * directories on the way to or under them qualify, so a checkout, a non-serving pack and any other tree answer null before the pack
 * is opened. `depth` 1 keeps immediate children only.
 */
export function packedSourcePathsUnder(
	absoluteDir: string,
	options: { depth?: number } = {},
	packageRoot: string = resolvePackageRoot(),
): { files: string[]; directories: string[]; mtimeMs: number } | null {
	const rel = relative(packageRoot, absoluteDir);
	if (relativePathEscapes(rel)) return null;
	const posixRel = rel.split(sep).join("/");
	if (posixRel.length > 0 && !SOURCE_PATH.test(posixRel)) return null;
	const prefix = posixRel.length === 0 ? "" : `${posixRel}/`;
	let pack: LoadedPack | null;
	try {
		pack = loadPack(packageRoot);
	} catch {
		return null;
	}
	if (!pack?.serving) return null;
	const depth = options.depth ?? Number.POSITIVE_INFINITY;
	const within = (path: string): string | null => {
		if (!path.startsWith(prefix)) return null;
		const rest = path.slice(prefix.length);
		return rest.length > 0 && rest.split("/").length <= depth ? rest : null;
	};
	const files: string[] = [];
	for (const member of pack.byPath.keys()) {
		const rest = within(member);
		if (rest !== null) files.push(rest);
	}
	const directories: string[] = [];
	for (const dir of pack.directories) {
		const rest = within(dir);
		if (rest !== null) directories.push(`${rest}/`);
	}
	return { files: files.sort(), directories: directories.sort(), mtimeMs: pack.mtimeMs };
}

/** Every packed member as a package-relative path (`src/...`, `packages/<name>/src/...`), sorted, whether or not the pack is serving. */
export function listPackedSources(packageRoot: string = resolvePackageRoot()): string[] {
	const pack = loadPack(packageRoot);
	return pack ? [...pack.byPath.keys()] : [];
}
