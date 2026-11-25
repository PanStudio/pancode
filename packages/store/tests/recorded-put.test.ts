// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createLocalStoreBackend,
	currentState,
	driftOf,
	isRecordsTag,
	readBlobHistory,
	recordedPut,
	type StoreBackend,
	StoreRefusal,
	verifyStoreTag,
} from "../src/index.js";

function fixture() {
	const base = mkdtempSync(join(tmpdir(), "store-recorded-"));
	const backend = createLocalStoreBackend({
		roots: [{ name: "default", path: join(base, "store"), durable: true, purge: null }],
		cacheDir: join(base, "cache"),
		projectKey: "fedcba9876543210",
		projectRoot: join(base, "project"),
	});
	const file = (name: string, text: string) => {
		const target = join(base, name);
		writeFileSync(target, text);
		return target;
	};
	return { backend, file };
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The same backend, except that every record append fails as a full disk would. */
function failingRecords(backend: StoreBackend): StoreBackend {
	return {
		...backend,
		putRecordIfAbsent: async (tag, blob, data) => {
			if (isRecordsTag(tag)) throw new StoreRefusal("no-space", "injected: no space left for the record");
			return backend.putRecordIfAbsent(tag, blob, data);
		},
	};
}

describe("recorded put", () => {
	it("reports stored bytes whose record failed, and verify --record-unrecorded records them once", async () => {
		const { backend, file } = fixture();
		await backend.getOrCreateTag("sim");
		const result = await recordedPut(failingRecords(backend), {
			tag: "sim",
			blob: "out.dat",
			source: file("out.dat", "payload\n"),
			actor: { actor: "standalone" },
		});
		strictEqual(result.stored, true);
		strictEqual(result.recorded, false);
		ok(!result.recorded && result.reason.includes("injected"));

		const stat = await backend.statBlob("sim", "out.dat");
		const before = currentState((await readBlobHistory(backend, "sim", "out.dat")).records).put;
		strictEqual(driftOf(before, stat), "unrecorded");

		const first = await verifyStoreTag(backend, "sim", { recordUnrecorded: true, actor: { actor: "standalone" } });
		deepStrictEqual(
			first.blobs.map((b) => [b.blob, b.status, b.recovered]),
			[["out.dat", "unrecorded", 1]],
		);
		const { records } = await readBlobHistory(backend, "sim", "out.dat");
		strictEqual(records.length, 1);
		strictEqual(records[0]?.recovered, true);
		strictEqual(records[0]?.producedBy.actor, "standalone");
		strictEqual(records[0]?.identity?.sha256, sha256("payload\n"));
		strictEqual(driftOf(currentState(records).put, await backend.statBlob("sim", "out.dat")), "none");

		const second = await verifyStoreTag(backend, "sim", { recordUnrecorded: true });
		deepStrictEqual(
			second.blobs.map((b) => [b.blob, b.status, b.recovered]),
			[["out.dat", "ok", undefined]],
		);
		strictEqual((await readBlobHistory(backend, "sim", "out.dat")).records.length, 1);
	});

	it("orders two concurrent puts of one blob, each record naming its own bytes", async () => {
		const { backend, file } = fixture();
		await backend.getOrCreateTag("sim");
		const texts = ["first writer\n", "second writer, longer bytes\n"];
		const results = await Promise.all(
			texts.map((text, index) =>
				recordedPut(backend, {
					tag: "sim",
					blob: "shared.txt",
					source: file(`w${index}.txt`, text),
					actor: { actor: "main" },
				}),
			),
		);
		const { records } = await readBlobHistory(backend, "sim", "shared.txt");
		deepStrictEqual(
			records.map((r) => r.seq),
			[1, 2],
		);
		for (const result of results) {
			ok(result.recorded);
			const text = texts.find((t) => sha256(t) === result.put.sha256);
			ok(text !== undefined);
			strictEqual(result.record.identity?.sha256, sha256(text));
			strictEqual(result.record.identity?.bytes, Buffer.byteLength(text));
		}
		deepStrictEqual(new Set(records.map((r) => r.identity?.sha256)), new Set(texts.map(sha256)));
		strictEqual(results.filter((r) => r.replaced).length, 1);
		const last = records[1];
		strictEqual(
			sha256(readFileSync((await backend.getBlobAsPath("sim", "shared.txt")).path, "utf8")),
			last?.identity?.sha256,
		);
	});
});
