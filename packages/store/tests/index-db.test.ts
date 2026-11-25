// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type StoreCliContext, storeCliResult } from "../src/cli/index.js";
import {
	appendRecord,
	createLocalStoreBackend,
	readBlobHistory,
	recordedPut,
	recordsTag,
	type StoreBackend,
	StoreRefusal,
} from "../src/index.js";
import { openStoreIndex, storeIndexPath } from "../src/index-db/index.js";

const KEY = "0123456789abcdef";

function fixture() {
	const base = mkdtempSync(join(tmpdir(), "store-index-"));
	const roots = [{ name: "default", path: join(base, "store"), durable: true, purge: null }];
	const cacheDir = join(base, "cache");
	const projectRoot = join(base, "project");
	mkdirSync(projectRoot);
	const backend = createLocalStoreBackend({ roots, cacheDir, projectKey: KEY, projectRoot });
	const context = (cache: string): StoreCliContext => ({
		cwd: projectRoot,
		roots,
		cacheDir: cache,
		projectRoot,
		projectKey: KEY,
		actor: { actor: "standalone" },
		command: "panstore",
	});
	// A cache directory under a regular file: the index cannot open, so every verb answers by a full scan.
	writeFileSync(join(base, "no-cache"), "");
	const put = async (tag: string, blob: string, text: string) => {
		const source = join(base, `${tag}-${blob}`);
		writeFileSync(source, text);
		await recordedPut(backend, { tag, blob, source, actor: { actor: "standalone" } });
	};
	return {
		base,
		backend,
		roots,
		cacheDir,
		put,
		indexed: context(cacheDir),
		scanned: context(join(base, "no-cache", "c")),
	};
}

async function populate(
	backend: StoreBackend,
	put: (tag: string, blob: string, text: string) => Promise<void>,
	base: string,
) {
	await backend.getOrCreateTag("sim", { class: "output" });
	await backend.setTagXattr("sim", "pancode.description", "simulation outputs");
	await put("sim", "a.dat", "first\n");
	await put("sim", "a.dat", "second, longer\n");
	await put("sim", "b.log", "log\n");
	await appendRecord(backend, {
		kind: "note",
		tag: "sim",
		blob: "a.dat",
		producedBy: { actor: "standalone" },
		note: "ok",
	});
	await backend.putRecordIfAbsent(recordsTag("sim"), "a.dat#00000099", Buffer.from("not json"));
	const loose = join(base, "loose");
	writeFileSync(loose, "no record\n");
	await backend.putBlobFromFile("sim", "c.dat", loose);
	await backend.getOrCreateTag("empty");
}

/** What a verb reports, without the backend facts `tags` appends: free space moves between two calls. */
async function verb(context: StoreCliContext, argv: string[]): Promise<unknown> {
	const { data } = await storeCliResult(argv, context);
	return argv[0] === "tags" ? (data as { tags: unknown }).tags : data;
}

const VERBS = [
	["tags"],
	["ls", "sim"],
	["ls", "sim", "a\\..*"],
	["ls", "empty"],
	["history", "sim:a.dat"],
	["history", "sim:nope"],
];

/** A backend that counts every call, to show when an answer read the store. */
function counting(backend: StoreBackend): { backend: StoreBackend; calls: () => number } {
	let calls = 0;
	const wrapped = new Proxy(backend, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				calls++;
				return value.apply(target, args);
			};
		},
	});
	return { backend: wrapped, calls: () => calls };
}

describe("store index", () => {
	it("answers every listing and history verb exactly as a full scan does", async () => {
		const { base, backend, put, indexed, scanned, cacheDir } = fixture();
		await populate(backend, put, base);
		for (const argv of VERBS) deepStrictEqual(await verb(indexed, argv), await verb(scanned, argv), argv.join(" "));
		ok(existsSync(storeIndexPath(cacheDir, KEY)));
		const history = (await verb(indexed, ["history", "sim:a.dat"])) as { records: unknown[]; skipped: number };
		strictEqual(history.records.length, 3);
		strictEqual(history.skipped, 1);
		const listed = (await verb(indexed, ["ls", "sim"])) as { blobs: Array<{ blob: string; recorded: boolean }> };
		deepStrictEqual(
			listed.blobs.map((b) => [b.blob, b.recorded]),
			[
				["a.dat", true],
				["b.log", true],
				["c.dat", false],
			],
		);
		// A tag the store does not have is refused the same way, by the store, with or without the index.
		for (const context of [indexed, scanned]) {
			await rejects(storeCliResult(["ls", "missing"], context), (error) => error instanceof StoreRefusal);
		}
	});

	it("answers a fresh index without reading the store and rescans what changed", async () => {
		const { base, backend: raw, put, roots, cacheDir } = fixture();
		await populate(raw, put, base);
		const { backend, calls } = counting(raw);
		const index = openStoreIndex({ backend, roots, cacheDir, projectKey: KEY, racyMs: 0 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const first = await index.blobs("sim");
		ok(calls() > 0);
		const before = calls();
		deepStrictEqual(await index.blobs("sim"), first);
		strictEqual(calls(), before, "a fresh index answers from its rows alone");

		await put("sim", "d.dat", "new\n");
		await appendRecord(raw, {
			kind: "note",
			tag: "sim",
			blob: "a.dat",
			producedBy: { actor: "standalone" },
			note: "again",
		});
		const after = await index.blobs("sim");
		deepStrictEqual(
			after?.map((b) => b.blob),
			["a.dat", "b.log", "c.dat", "d.dat"],
		);
		const history = await index.history("sim", "a.dat");
		deepStrictEqual(history, await readBlobHistory(raw, "sim", "a.dat"));
		strictEqual(history?.records.at(-1)?.note, "again");
	});

	it("keeps answering when its database is deleted or corrupt", async () => {
		const { base, backend, put, indexed, scanned, cacheDir } = fixture();
		await populate(backend, put, base);
		const db = storeIndexPath(cacheDir, KEY);
		const expected = [];
		for (const argv of VERBS) expected.push(await verb(scanned, argv));
		for (const damage of [
			() => rmSync(db),
			() => writeFileSync(db, "this is not a database"),
			() => rmSync(join(cacheDir, "store"), { recursive: true }),
		]) {
			await verb(indexed, ["tags"]);
			damage();
			const answers = [];
			for (const argv of VERBS) answers.push(await verb(indexed, argv));
			deepStrictEqual(answers, expected);
			ok(existsSync(db), "the index is rebuilt");
		}
	});
});
