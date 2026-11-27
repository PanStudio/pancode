// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { StoreRefusal } from "./backend/types.js";

/** Publish a read-only copy without following links in the store's cache or discarding unrelated copies. */
export async function writeCacheCopy(
	cacheDir: string,
	projectKey: string,
	segments: string[],
	write: (temp: string) => Promise<void>,
): Promise<{ path: string; copied: true }> {
	const parts = ["store", projectKey, ...segments];
	if (parts.some((part) => !part || part === "." || part === ".." || path.basename(part) !== part))
		throw new StoreRefusal("invalid-name", "Invalid store cache path.");
	let dir = cacheDir;
	await mkdir(dir, { recursive: true, mode: 0o700 });
	for (const [index, part] of parts.slice(0, -1).entries()) {
		dir = path.join(dir, part);
		try {
			await mkdir(dir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const info = await lstat(dir);
			if (info.isSymbolicLink()) throw new StoreRefusal("is-link", `Refusing a link in the store cache: ${dir}.`);
			if (info.isDirectory()) continue;
			// A former blob may now be the parent of a new blob.
			if (index < 3 || !info.isFile()) throw error;
			await rm(dir);
			await mkdir(dir, { mode: 0o700 });
		}
	}
	const copy = path.join(dir, parts[parts.length - 1] as string);
	const temp = path.join(dir, `.copy.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		await write(temp);
		await chmod(temp, 0o400);
		try {
			await rename(temp, copy);
		} catch (error) {
			if (!["ENOTEMPTY", "EISDIR", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			if (!(await lstat(copy)).isDirectory()) throw error;
			await rm(copy, { recursive: true });
			await rename(temp, copy);
		}
		return { path: copy, copied: true };
	} finally {
		await rm(temp, { force: true });
	}
}
