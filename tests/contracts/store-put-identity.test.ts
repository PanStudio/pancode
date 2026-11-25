// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readBlobHistory } from "@pancode/store";
import type { StoreBackend } from "@pancode/store/backend";
import { storePut } from "../../src/cli/store.js";
import { sha256Hex } from "../../src/core/hash.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

const WRITERS = 12;
const writerBytes = (n: number) => `writer ${n}\n`;

async function withWorkspace(fn: (root: string, dir: string) => Promise<void>): Promise<void> {
	const env = await isolatePancodeEnv("pancode-store-put-identity-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(root, { recursive: true });
		for (let n = 1; n <= WRITERS; n++) writeFileSync(join(root, `w${n}.txt`), writerBytes(n));
		await fn(root, env.dir);
	} finally {
		env.restore();
	}
}

/** Every put record names the bytes its own writer sent, and the sequence has no gap. */
async function assertEachRecordIsItsWriters(backend: StoreBackend, count: number): Promise<void> {
	const { records } = await readBlobHistory(backend, "results", "shared.txt");
	deepStrictEqual(
		records.map((record) => record.seq),
		Array.from({ length: count }, (_, index) => index + 1),
	);
	for (const record of records) {
		strictEqual(record.kind, "put");
		const n = Number(/^writer (\d+)$/u.exec(record.note ?? "")?.[1]);
		ok(n >= 1 && n <= count, `record ${record.seq} has note ${record.note}`);
		deepStrictEqual(
			[record.identity?.bytes, record.identity?.sha256],
			[Buffer.byteLength(writerBytes(n)), sha256Hex(writerBytes(n))],
			`record ${record.seq} (writer ${n}) names another writer's bytes`,
		);
	}
}

async function concurrentCliPuts(root: string, openBackend: (cwd: string) => Promise<StoreBackend>) {
	return Promise.all(
		Array.from({ length: WRITERS }, (_, index) =>
			storePut(root, "results", `w${index + 1}.txt`, {
				blob: "shared.txt",
				note: `writer ${index + 1}`,
				openBackend,
			}),
		),
	);
}

describe("store put identity under concurrency", () => {
	it("each concurrent local put records the bytes it stored", () =>
		withWorkspace(async (root) => {
			const results = await concurrentCliPuts(root, openStoreBackend);
			for (const [index, result] of results.entries()) {
				strictEqual(result.identity?.sha256, sha256Hex(writerBytes(index + 1)));
				strictEqual(result.bytes, Buffer.byteLength(writerBytes(index + 1)));
			}
			await assertEachRecordIsItsWriters(await openStoreBackend(root), WRITERS);
		}));
});
