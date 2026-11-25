// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { StoreRefusal } from "@pancode/store/backend";
import { runStoreBackendConformance } from "@pancode/store/testing";
import {
	encodeTagSegment,
	storeProjectDir,
	storeProjectKeyFor,
	storeProjectRoot,
	storeTagDir,
} from "../../src/core/store-paths.js";
import { pancodeCachePath } from "../../src/core/xdg.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

function refusedWith(reason: string) {
	return (error: unknown) => error instanceof StoreRefusal && error.reason === reason;
}

describe("local", () => {
	let restore: () => void = () => {};
	before(async () => {
		restore = (await isolatePancodeEnv("pancode-store-")).restore;
	});
	after(() => restore());
	runStoreBackendConformance("local", openStoreBackend);
});

test("local: no tiers, no blob versions, and get hands back an owner-read-only copy in the cache", async () => {
	const env = await isolatePancodeEnv("pancode-store-facts-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		const facts = await backend.facts();
		strictEqual(facts.tiers, false);
		strictEqual(facts.blobVersions, false);
		const source = join(env.dir, "s");
		writeFileSync(source, "stored");
		await backend.getOrCreateTag("sim/run7");
		strictEqual((await backend.putBlobFromFile("sim/run7", "out/b", source)).version, null);
		const got = await backend.getBlobAsPath("sim/run7", "out/b");
		strictEqual(got.copied, true);
		strictEqual(lstatSync(got.path).mode & 0o777, 0o400);
		strictEqual(
			got.path,
			join(
				pancodeCachePath(),
				"store",
				storeProjectKeyFor(storeProjectRoot(cwd)),
				encodeTagSegment("sim/run7"),
				"out",
				"b",
			),
		);
	} finally {
		env.restore();
	}
});

test("local: an aborted put leaves no temp file beside the blob or its copy", async () => {
	const env = await isolatePancodeEnv("pancode-store-abort-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		await backend.getOrCreateTag("t");
		const source = join(env.dir, "source.bin");
		writeFileSync(source, "kept");
		await backend.putBlobFromFile("t", "b", source);
		writeFileSync(source, "x".repeat(1 << 20));
		await rejects(backend.putBlobFromFile("t", "b", source, AbortSignal.abort()), refusedWith("io"));
		const { path } = await backend.getBlobAsPath("t", "b");
		strictEqual(readFileSync(path, "utf8"), "kept");
		deepStrictEqual(readdirSync(join(path, "..")), ["b"]);
		deepStrictEqual(readdirSync(join(storeTagDir(cwd, "t"), "blobs")), ["b"]);
	} finally {
		env.restore();
	}
});

test("local: listBlobs skips links in the blobs directory", async () => {
	const env = await isolatePancodeEnv("pancode-store-listlinks-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		await backend.getOrCreateTag("t");
		const source = join(env.dir, "s");
		writeFileSync(source, "s");
		await backend.putBlobFromFile("t", "a.txt", source);
		const outside = join(env.dir, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "x.txt"), "x");
		symlinkSync(outside, join(storeTagDir(cwd, "t"), "blobs", "link"));
		writeFileSync(join(env.dir, "y.txt"), "y");
		symlinkSync(join(env.dir, "y.txt"), join(storeTagDir(cwd, "t"), "blobs", "y.txt"));
		deepStrictEqual(await backend.listBlobs("t", { offset: 0, limit: 10 }), { names: ["a.txt"], hasMore: false });
		deepStrictEqual((await backend.listBlobs("t", { pattern: ".*\\.txt", offset: 0, limit: 10 })).names, ["a.txt"]);
	} finally {
		env.restore();
	}
});

test("local: links in a blob's parents and tags resolving outside the project are refused", async () => {
	const env = await isolatePancodeEnv("pancode-store-links-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		const scratch = env.dir;
		await backend.getOrCreateTag("t");
		const source = join(scratch, "s");
		writeFileSync(source, "s");
		const outside = join(scratch, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(storeTagDir(cwd, "t"), "blobs", "dir"));
		await rejects(backend.putBlobFromFile("t", "dir/x", source), refusedWith("is-link"));
		deepStrictEqual(readdirSync(outside), []);
		const tagsDir = join(storeTagDir(cwd, "t"), "..");
		mkdirSync(join(outside, "evil", "blobs"), { recursive: true });
		writeFileSync(join(outside, "evil", "tag.json"), "{}");
		symlinkSync(join(outside, "evil"), join(tagsDir, "evil"));
		await rejects(backend.putBlobFromFile("evil", "x", source), refusedWith("is-link"));
		await rejects(backend.delTag("evil"), refusedWith("is-link"));
	} finally {
		env.restore();
	}
});

test("local: a blob named *.tmp is listed; only the backend's own temp siblings are hidden", async () => {
	const env = await isolatePancodeEnv("pancode-store-tmp-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		const source = join(env.dir, "s");
		writeFileSync(source, "s");
		await backend.getOrCreateTag("t");
		await backend.putBlobFromFile("t", "keep.tmp", source);
		writeFileSync(join(storeTagDir(cwd, "t"), ".keep.tmp.123.0123456789ab.tmp"), "in flight");
		deepStrictEqual((await backend.listBlobs("t", { offset: 0, limit: 10 })).names, ["keep.tmp"]);
	} finally {
		env.restore();
	}
});

test("local: a blob nested under a blob, or named like a blob directory, is refused cleanly", async () => {
	const env = await isolatePancodeEnv("pancode-store-nest-");
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		const source = join(env.dir, "s");
		writeFileSync(source, "s");
		await backend.getOrCreateTag("t");
		await backend.putBlobFromFile("t", "a", source);
		await rejects(
			backend.putBlobFromFile("t", "a/b", source),
			(error: unknown) =>
				error instanceof StoreRefusal &&
				error.reason === "exists" &&
				/blob a\b/u.test(error.message) &&
				!/E(EXIST|NOTDIR|ISDIR)/u.test(error.message),
		);
		await backend.putBlobFromFile("t", "c/d", source);
		await rejects(
			backend.putBlobFromFile("t", "c", source),
			(error: unknown) =>
				error instanceof StoreRefusal &&
				error.reason === "exists" &&
				/c\/d/u.test(error.message) &&
				!/E(EXIST|NOTDIR|ISDIR)/u.test(error.message),
		);
		deepStrictEqual((await backend.listBlobs("t", { offset: 0, limit: 10 })).names, ["a", "c/d"]);
		deepStrictEqual(readdirSync(join(storeTagDir(cwd, "t"), "blobs")).sort(), ["a", "c"]);
		deepStrictEqual(readdirSync(join(storeTagDir(cwd, "t"), "blobs", "c")), ["d"]);
	} finally {
		env.restore();
	}
});

test("local: every store directory is 0700 and every file 0600 under umask 022", async () => {
	const env = await isolatePancodeEnv("pancode-store-modes-");
	const umask = process.umask(0o022);
	try {
		const cwd = join(env.dir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const backend = await openStoreBackend(cwd);
		const source = join(env.dir, "s");
		writeFileSync(source, "s");
		await backend.getOrCreateTag("t");
		await backend.setTagXattr("t", "class", "output");
		await backend.putBlobFromFile("t", "out/a.bin", source);
		await backend.putRecordIfAbsent("t/.records", "r#00000001", Buffer.from("argv"));
		const modes: string[] = [];
		const walk = (dir: string): void => {
			for (const name of readdirSync(dir)) {
				const entry = join(dir, name);
				const stat = lstatSync(entry);
				modes.push(`${(stat.mode & 0o777).toString(8)} ${name}`);
				if (stat.isDirectory()) walk(entry);
			}
		};
		walk(storeProjectDir(cwd));
		ok(modes.some((line) => line.endsWith(" a.bin")));
		deepStrictEqual(
			modes.filter((line) => !line.startsWith("700 ") && !line.startsWith("600 ")),
			[],
		);
		strictEqual(lstatSync(storeProjectDir(cwd)).mode & 0o777, 0o700);
	} finally {
		process.umask(umask);
		env.restore();
	}
});
