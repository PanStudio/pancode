// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * How long before a scan a change must have happened for the scan to be trusted. File timestamps come from a
 * coarse kernel clock, so a change in the same tick as the scan can leave the entry count and the newest time
 * as they were; an index built that close to its newest change is answered from once and rescanned next time.
 */
export const STORE_INDEX_RACY_MS = 2000;

export interface StoreFingerprint {
	/** `<entries>:<newest>:<digest>`; any difference means rescan. */
	value: string;
	/** Newest mtime or ctime seen, in ms; 0 when nothing exists. */
	newestMs: number;
}

/** One watched path: `deep` walks every entry under a directory, else only the directory's own entries. */
export interface WatchedPath {
	path: string;
	deep: boolean;
	/** For a shallow directory, also stat this file inside each entry (a tag's `tag.json`). */
	child?: string;
}

function errnoOf(error: unknown): string {
	return (error as NodeJS.ErrnoException | null)?.code ?? "error";
}

/**
 * The stat of every watched entry: count, newest mtime or ctime, and a digest of each entry's name, type, inode,
 * size, mtime and ctime. ctime cannot be set back, so a restored mtime still moves it. Nothing is read.
 */
export async function storeFingerprint(watched: ReadonlyArray<WatchedPath>): Promise<StoreFingerprint> {
	const hash = createHash("sha256");
	let entries = 0;
	let newestMs = 0;
	const visit = async (target: string, depth: "deep" | "shallow" | "leaf", child?: string): Promise<void> => {
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(target);
		} catch (error) {
			hash.update(`${target}\0${errnoOf(error)}\n`);
			return;
		}
		entries++;
		newestMs = Math.max(newestMs, info.mtimeMs, info.ctimeMs);
		const type = info.isDirectory() ? "d" : info.isFile() ? "f" : info.isSymbolicLink() ? "l" : "o";
		hash.update(`${target}\0${type}\0${info.ino}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\n`);
		if (type !== "d" || depth === "leaf") return;
		let names: string[];
		try {
			names = (await readdir(target)).sort();
		} catch (error) {
			hash.update(`${target}\0readdir\0${errnoOf(error)}\n`);
			return;
		}
		for (const name of names) {
			const inner = path.join(target, name);
			if (depth === "deep") {
				await visit(inner, "deep");
			} else {
				await visit(inner, "leaf");
				if (child !== undefined) await visit(path.join(inner, child), "leaf");
			}
		}
	};
	for (const watch of watched) await visit(watch.path, watch.deep ? "deep" : "shallow", watch.child);
	return { value: `${entries}:${newestMs}:${hash.digest("hex")}`, newestMs };
}
