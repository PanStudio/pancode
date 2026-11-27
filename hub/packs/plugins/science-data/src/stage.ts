// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Writing a staged resource. Bytes go to a temporary file beside the
 * destination, hashed as they are written, and the file is put in place only
 * when the transfer finished within `maxBytes` and, where the catalog gave a
 * SHA-256, the hash matched. Any other ending removes the temporary file.
 */
import { createHash, randomBytes } from "node:crypto";
import { link, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const code = (error: unknown): string | undefined =>
	error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** Thrown from a transfer to end it with this message; the partial file is removed. */
export class StageError extends Error {
	override name = "StageError";
}

/** The destination as an absolute path, or why it cannot be written. Checked before any transfer starts. */
export async function checkDestination(destination: string, overwrite: boolean): Promise<string> {
	if (destination.length === 0) throw new StageError("destination must not be empty");
	if (destination.includes("\0")) throw new StageError("destination must not contain a NUL character");
	const absolute = path.resolve(destination);
	const directory = path.dirname(absolute);
	try {
		if (!(await stat(directory)).isDirectory()) throw new StageError(`${directory} is not a directory`);
	} catch (error) {
		if (error instanceof StageError) throw error;
		throw new StageError(`the directory ${directory} cannot be used: ${message(error)}`);
	}
	try {
		const existing = await stat(absolute);
		if (existing.isDirectory()) throw new StageError(`${absolute} is a directory; name a file to write`);
		if (!overwrite) throw new StageError(`${absolute} exists; pass overwrite: true to replace it`);
	} catch (error) {
		if (error instanceof StageError) throw error;
		if (code(error) !== "ENOENT") throw new StageError(`${absolute} cannot be checked: ${message(error)}`);
	}
	return absolute;
}

export interface Staged {
	bytesWritten: number;
	sha256: string;
}

/**
 * Write `chunks` to `destination` through a temporary file beside it, calling
 * `onChunk` with the bytes received so far as each chunk arrives. Stops
 * with a `StageError` past `maxBytes` or on a hash mismatch, and whatever
 * ends the transfer early (an abort, a read error) propagates; in every such
 * case the temporary file is removed and the destination is untouched.
 */
export async function writeStaged(
	chunks: AsyncIterable<Uint8Array>,
	options: { destination: string; overwrite: boolean; maxBytes: number; expectedSha256: string | null },
	onChunk?: (bytesWritten: number) => void,
): Promise<Staged> {
	const { destination } = options;
	const temporary = path.join(
		path.dirname(destination),
		`.${path.basename(destination)}.${randomBytes(6).toString("hex")}.pankit-part`,
	);
	const handle = await open(temporary, "wx");
	let placed = false;
	try {
		const hash = createHash("sha256");
		let bytesWritten = 0;
		for await (const chunk of chunks) {
			bytesWritten += chunk.byteLength;
			onChunk?.(bytesWritten);
			if (bytesWritten > options.maxBytes)
				throw new StageError(`the resource is larger than maxBytes (${options.maxBytes} bytes); nothing was kept`);
			hash.update(chunk);
			await handle.write(chunk);
		}
		await handle.sync();
		await handle.close();
		const sha256 = hash.digest("hex");
		if (options.expectedSha256 !== null && sha256 !== options.expectedSha256) {
			throw new StageError(
				`the SHA-256 of the transferred bytes is ${sha256}, but the catalog gives ${options.expectedSha256}; nothing was kept`,
			);
		}
		await place(temporary, destination, options.overwrite);
		placed = true;
		return { bytesWritten, sha256 };
	} finally {
		if (!placed) {
			await handle.close().catch(() => {
				// Already closed after a finished transfer; closing twice changes nothing.
			});
			await unlink(temporary).catch(() => {
				// Already gone or never fully created; there is nothing left to remove.
			});
		}
	}
}

/**
 * Put the finished file in place. Without `overwrite` a hard link claims the
 * name atomically and fails if something appeared there meanwhile; a file
 * system without hard links falls back to a checked rename.
 */
async function place(temporary: string, destination: string, overwrite: boolean): Promise<void> {
	if (overwrite) {
		await rename(temporary, destination);
		return;
	}
	try {
		await link(temporary, destination);
	} catch (error) {
		if (code(error) === "EEXIST") throw new StageError(`${destination} appeared while staging; nothing was replaced`);
		if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(code(error) ?? "")) throw error;
		try {
			await stat(destination);
			throw new StageError(`${destination} appeared while staging; nothing was replaced`);
		} catch (statError) {
			if (statError instanceof StageError) throw statError;
		}
		await rename(temporary, destination);
		return;
	}
	await unlink(temporary);
}
