// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The two durable-write helpers the local backend needs, mirroring
 * `fsyncDirectoryAsync` and the plain path of `safeResourceWriteAsync` in the
 * harness's `src/core/safe-resource-write.ts` (no backup, no rename hook), so
 * the package runs without the harness and writes the same files the same way.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

let resourceWriteSequence = 0;

/**
 * Flush a directory entry so a completed rename survives a crash. Best effort:
 * directory fsync is not supported on every file system, and a rejection there
 * is not a failed write.
 */
export async function fsyncDirectoryAsync(dir: string): Promise<void> {
	let fd: Awaited<ReturnType<typeof open>> | undefined;
	try {
		fd = await open(dir, "r");
		await fd.sync();
	} catch {
		// Directory fsync is unsupported here, and that is not evidence the write failed.
	} finally {
		await fd?.close();
	}
}

function tempPathFor(targetPath: string): string {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	const suffix = `${process.pid}-${Date.now()}-${++resourceWriteSequence}-${randomBytes(6).toString("hex")}`;
	return path.join(dir, `.${base}.tmp-${suffix}`);
}

/** Replace `targetPath` with `contents` through a synced temp file and a rename, so no reader sees a torn file. */
export async function safeResourceWriteAsync(
	targetPath: string,
	contents: string,
	options: { mode: number },
): Promise<void> {
	const dir = path.dirname(targetPath);
	const buffer = Buffer.from(contents, "utf8");
	await mkdir(dir, { recursive: true });
	const tempPath = tempPathFor(targetPath);
	let tempExists = false;
	try {
		const fd = await open(tempPath, "wx", options.mode);
		tempExists = true;
		try {
			await fd.writeFile(buffer);
			await fd.sync();
		} finally {
			await fd.close();
		}
		await rename(tempPath, targetPath);
		tempExists = false;
		await fsyncDirectoryAsync(dir);
	} catch (error) {
		if (tempExists) await rm(tempPath, { force: true });
		throw error;
	}
}
