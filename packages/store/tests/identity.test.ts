// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Inputs are constructed: scratch roots and a hand-written malformed root.json.
import { ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createLocalStoreBackend, ensureStoreRootId, readStoreRootId, StoreRefusal } from "../src/index.js";

it("concurrent ensureStoreRootId calls on one root agree on one id, the backend reports it, and a malformed root.json refuses", async () => {
	const base = mkdtempSync(join(tmpdir(), "store-identity-"));
	const root = join(base, "root");
	strictEqual(await readStoreRootId(root), null);
	const ids = await Promise.all(Array.from({ length: 8 }, () => ensureStoreRootId(root)));
	strictEqual(new Set(ids).size, 1);
	strictEqual(await readStoreRootId(root), ids[0]);
	ok(
		readdirSync(root).every((name) => !name.endsWith(".tmp")),
		"no temporary file is left",
	);

	const backend = createLocalStoreBackend({
		roots: [{ name: "default", path: root, durable: true, purge: null }],
		cacheDir: join(base, "cache"),
		projectKey: "0123456789abcdef",
		projectRoot: join(base, "project"),
	});
	await backend.getOrCreateTag("sim");
	strictEqual((await backend.facts()).roots[0]?.id, ids[0]);

	const malformed = join(base, "malformed");
	await ensureStoreRootId(malformed);
	writeFileSync(join(malformed, "root.json"), '{"v":1,"id":"not-a-uuid"}\n');
	await rejects(readStoreRootId(malformed), StoreRefusal);
	await rejects(ensureStoreRootId(malformed), StoreRefusal);
});
