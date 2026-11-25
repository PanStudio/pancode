// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const HASH_CHUNK_BYTES = 1024 * 1024;

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted.");
}

/** The sha256 of a file, read in chunks and stopping when `signal` aborts. */
export async function hashStoreFile(file: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw abortError(signal);
	const hash = createHash("sha256");
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		for (;;) {
			if (signal?.aborted) throw abortError(signal);
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}
