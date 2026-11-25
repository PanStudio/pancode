// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createLocalStoreBackend,
	type StorePlacementRules,
	StoreRefusal,
	type StoreRootSpec,
	storeBlobPath,
	storePlacementPath,
	storeProjectDir,
	storeTagDir,
} from "../src/index.js";

const KEY = "0123456789abcdef";

function fixture() {
	const base = mkdtempSync(join(tmpdir(), "store-placement-"));
	const source = join(base, "source.txt");
	writeFileSync(source, "bytes\n");
	const primary: StoreRootSpec = { name: "main", path: join(base, "main"), durable: true, purge: null };
	const scratch: StoreRootSpec = { name: "scratch", path: join(base, "scratch"), durable: true, purge: "30d" };
	mkdirSync(scratch.path);
	const open = (roots: StoreRootSpec[], placement?: StorePlacementRules) =>
		createLocalStoreBackend({
			roots,
			...(placement !== undefined ? { placement } : {}),
			cacheDir: join(base, "cache"),
			projectKey: KEY,
			projectRoot: join(base, "project"),
		});
	return { base, source, primary, scratch, open };
}

function isUnavailable(error: unknown): boolean {
	return error instanceof StoreRefusal && error.reason === "unavailable";
}

describe("store placement across roots", () => {
	it("keeps a tag placed by class on its root after the rules change", async () => {
		const { source, primary, scratch, open } = fixture();
		const first = open([primary, scratch], { byClass: { cache: "scratch" } });
		strictEqual((await first.getOrCreateTag("tmp", { class: "cache" })).created, true);
		ok(existsSync(join(storeTagDir(storeProjectDir(scratch.path, KEY), "tmp"), "tag.json")));

		const changed = open([primary, scratch], { byClass: { cache: "main" } });
		await changed.getOrCreateTag("tmp", { class: "cache" });
		await changed.putBlobFromFile("tmp", "a.txt", source);
		strictEqual(readFileSync(storeBlobPath(storeProjectDir(scratch.path, KEY), "tmp", "a.txt"), "utf8"), "bytes\n");
		ok(!existsSync(storeTagDir(storeProjectDir(primary.path, KEY), "tmp")));
		deepStrictEqual(await changed.listTags(), ["tmp"]);
		strictEqual((await changed.facts()).roots.length, 2);
	});

	it("puts an unmapped tag on the primary, and one default root keeps the single-root paths", async () => {
		const { base, source, primary, scratch, open } = fixture();
		const backend = open([primary, scratch], { byClass: { cache: "scratch" } });
		await backend.getOrCreateTag("results", { class: "output" });
		await backend.putBlobFromFile("results", "r.txt", source);
		ok(existsSync(storeBlobPath(storeProjectDir(primary.path, KEY), "results", "r.txt")));
		deepStrictEqual(readdirSync(scratch.path), []);

		const single = open([{ name: "default", path: join(base, "only"), durable: true, purge: null }]);
		await single.getOrCreateTag("alpha");
		await single.putBlobFromFile("alpha", "dir/a.txt", source);
		const projectDir = storeProjectDir(join(base, "only"), KEY);
		strictEqual(readFileSync(storeBlobPath(projectDir, "alpha", "dir/a.txt"), "utf8"), "bytes\n");
		strictEqual(
			await single.blobRefOfPath(storeBlobPath(projectDir, "alpha", "dir/a.txt")).then((r) => r?.blob),
			"dir/a.txt",
		);
		deepStrictEqual(JSON.parse(readFileSync(storePlacementPath(projectDir), "utf8")), {
			v: 1,
			tags: { alpha: "default" },
		});
		strictEqual((await single.facts()).tiers, false);
	});

	it("refuses a missing root with unavailable and writes nothing on any other root", async () => {
		const { source, primary, scratch, open } = fixture();
		const backend = open([primary, scratch], { byTag: { big: "scratch" } });
		rmSync(scratch.path, { recursive: true });
		await rejects(backend.getOrCreateTag("big"), isUnavailable);
		ok(!existsSync(primary.path));
		ok(!existsSync(scratch.path));

		mkdirSync(scratch.path);
		await backend.getOrCreateTag("big");
		rmSync(scratch.path, { recursive: true });
		const placementBefore = readFileSync(storePlacementPath(storeProjectDir(primary.path, KEY)), "utf8");
		await rejects(backend.putBlobFromFile("big", "x.bin", source), isUnavailable);
		await rejects(backend.getOrCreateTag("big"), isUnavailable);
		ok(!existsSync(storeTagDir(storeProjectDir(primary.path, KEY), "big")));
		ok(!existsSync(scratch.path));
		strictEqual(readFileSync(storePlacementPath(storeProjectDir(primary.path, KEY)), "utf8"), placementBefore);
		deepStrictEqual(await backend.listTags(), []);
	});
});
