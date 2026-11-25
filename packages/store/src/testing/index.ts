// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The contract every store backend must pass, through the `StoreBackend` interface alone: no assertion about
 * a backend's facts and no look at how it lays the store out. A backend's own layout tests live beside it.
 */
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StoreBackend } from "../backend/backend.js";
import { StoreRefusal } from "../backend/types.js";

function refusedWith(reason: string) {
	return (error: unknown) => error instanceof StoreRefusal && error.reason === reason;
}

/**
 * Register the conformance cases for one backend. `make` receives a fresh, empty workspace directory per case
 * and returns the backend for it; source files live in a sibling scratch directory removed after the case.
 */
export function runStoreBackendConformance(name: string, make: (cwd: string) => Promise<StoreBackend>): void {
	async function withBackend(fn: (backend: StoreBackend, scratch: string) => Promise<void>) {
		const scratch = mkdtempSync(join(tmpdir(), "pancode-store-conformance-"));
		try {
			const cwd = join(scratch, "workspace");
			mkdirSync(cwd, { recursive: true });
			await fn(await make(cwd), scratch);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	test(`${name}: a put replaces the whole blob and never touches the source`, () =>
		withBackend(async (backend, scratch) => {
			deepStrictEqual(await backend.getOrCreateTag("sim/run7"), { created: true });
			deepStrictEqual(await backend.getOrCreateTag("sim/run7"), { created: false });
			const source = join(scratch, "source.bin");
			writeFileSync(source, "first version, longer");
			const first = await backend.putBlobFromFile("sim/run7", "out/data.bin", source);
			strictEqual(first.bytes, 21);
			const { path } = await backend.getBlobAsPath("sim/run7", "out/data.bin");
			strictEqual(readFileSync(path, "utf8"), "first version, longer");
			writeFileSync(source, "second");
			await backend.putBlobFromFile("sim/run7", "out/data.bin", source);
			const again = await backend.getBlobAsPath("sim/run7", "out/data.bin");
			strictEqual(readFileSync(again.path, "utf8"), "second");
			strictEqual(readFileSync(source, "utf8"), "second");
		}));

	test(`${name}: get hands back a path whose writes cannot change the stored blob`, () =>
		withBackend(async (backend, scratch) => {
			await backend.getOrCreateTag("t");
			const source = join(scratch, "source.bin");
			writeFileSync(source, "stored");
			await backend.putBlobFromFile("t", "b", source);
			const got = await backend.getBlobAsPath("t", "b");
			try {
				writeFileSync(got.path, "tampered");
			} catch {
				// A read-only path refuses the write outright.
			}
			const fresh = await backend.getBlobAsPath("t", "b");
			strictEqual(readFileSync(fresh.path, "utf8"), "stored");
		}));

	test(`${name}: an aborted put leaves no change and no temp file`, () =>
		withBackend(async (backend, scratch) => {
			await backend.getOrCreateTag("t");
			const source = join(scratch, "source.bin");
			writeFileSync(source, "kept");
			await backend.putBlobFromFile("t", "b", source);
			writeFileSync(source, "x".repeat(1 << 20));
			await rejects(backend.putBlobFromFile("t", "b", source, AbortSignal.abort()), refusedWith("io"));
			const { path } = await backend.getBlobAsPath("t", "b");
			strictEqual(readFileSync(path, "utf8"), "kept");
			deepStrictEqual(await backend.listBlobs("t", { offset: 0, limit: 10 }), { names: ["b"], hasMore: false });
		}));

	test(`${name}: put-if-absent has exactly one winner`, () =>
		withBackend(async (backend) => {
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, i) => backend.putRecordIfAbsent("t/.records", "r#00000001", Buffer.from(`w${i}`))),
			);
			strictEqual(results.filter((result) => result === "written").length, 1);
			ok((await backend.getRecord("t/.records", "r#00000001")) !== null);
		}));

	test(`${name}: listBlobs pages in order and full-matches the pattern`, () =>
		withBackend(async (backend, scratch) => {
			await backend.getOrCreateTag("t");
			const source = join(scratch, "s");
			writeFileSync(source, "s");
			for (const blob of ["a/b", "a-c", "b.txt", "c.txt", "d/e.txt", "keep.tmp"])
				await backend.putBlobFromFile("t", blob, source);
			deepStrictEqual(await backend.listBlobs("t", { offset: 0, limit: 2 }), { names: ["a-c", "a/b"], hasMore: true });
			deepStrictEqual(await backend.listBlobs("t", { offset: 2, limit: 4 }), {
				names: ["b.txt", "c.txt", "d/e.txt", "keep.tmp"],
				hasMore: false,
			});
			deepStrictEqual(await backend.listBlobs("t", { pattern: ".*\\.txt", offset: 0, limit: 10 }), {
				names: ["b.txt", "c.txt", "d/e.txt"],
				hasMore: false,
			});
			deepStrictEqual((await backend.listBlobs("t", { pattern: "txt", offset: 0, limit: 10 })).names, []);
			deepStrictEqual((await backend.listBlobs("t", { pattern: "[(]a+", offset: 0, limit: 10 })).names, []);
			await rejects(backend.listBlobs("t", { pattern: "(", offset: 0, limit: 1 }), refusedWith("invalid-name"));
			for (const pattern of ["(a+)+", "(.*x)*", "((a+))+", "((?:a+)x)*", "(a(b+))+", "(a)\\1", "a".repeat(257)]) {
				await rejects(backend.listBlobs("t", { pattern, offset: 0, limit: 1 }), refusedWith("invalid-name"));
			}
		}));

	test(`${name}: tag attributes keep their size limits`, () =>
		withBackend(async (backend) => {
			await backend.getOrCreateTag("t");
			await backend.setTagXattr("t", "class", "output");
			await backend.setTagXattr("t", "k".repeat(255), "v".repeat(64 * 1024));
			strictEqual((await backend.getTagXattrs("t")).class, "output");
			await rejects(backend.setTagXattr("t", "k".repeat(256), "v"), refusedWith("invalid-name"));
			await rejects(backend.setTagXattr("t", "k", "v".repeat(64 * 1024 + 1)), refusedWith("invalid-name"));
		}));
}
