// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readBlobHistory, storeLockId, storeProjectKey, storeProjectKeyForId } from "@pancode/store";
import {
	storePut as cliPut,
	storeAdopt,
	storeCommandResult,
	storeRemoveTag,
	storeTags,
	storeVerify,
	storeWhere,
} from "../../src/cli/store.js";
import "../../src/core/config.js";
import { storeBlobPath, storeProjectDir, storeProjectRoot, storeRoot } from "../../src/core/store-paths.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { createStoreTool } from "../../src/tools/store/store-tool.js";
import { headlessScratch, runCli } from "../harness/headless-run.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

/** Puts into a tag created beforehand, so a test isolates put from tag creation. */
async function storePut(root: string, tag: string, file: string) {
	await (await openStoreBackend(root)).getOrCreateTag(tag);
	return cliPut(root, tag, file);
}

async function withWorkspace(fn: (root: string, dir: string) => Promise<void>): Promise<void> {
	const env = await isolatePancodeEnv("pancode-store-cli-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(root, { recursive: true });
		await fn(root, env.dir);
	} finally {
		env.restore();
	}
}

function plantLocks(root: string, at: string) {
	const dir = join(storeProjectDir(root), "locks");
	mkdirSync(dir, { recursive: true });
	const bootFile = "/proc/sys/kernel/random/boot_id";
	const bootId = existsSync(bootFile) ? readFileSync(bootFile, "utf8").trim() : undefined;
	const keys = { live: "blob:live", dead: "blob:dead", remote: "blob:remote", unreadable: "blob:unreadable" };
	const owner = (key: string, pid: number, host: string) =>
		JSON.stringify({ v: 2, key, pid, host, ...(bootId !== undefined ? { bootId } : {}), token: "0".repeat(16), at });
	const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 0;
	writeFileSync(join(dir, `${storeLockId(keys.live)}.lock`), owner(keys.live, process.pid, hostname()));
	writeFileSync(join(dir, `${storeLockId(keys.dead)}.lock`), owner(keys.dead, deadPid, hostname()));
	writeFileSync(join(dir, `${storeLockId(keys.remote)}.lock`), owner(keys.remote, 4242, "other-node"));
	writeFileSync(join(dir, `${storeLockId(keys.unreadable)}.lock`), "{not json");
	return keys;
}

describe("pancode store", () => {
	it("verify classifies ok, changed, missing and unrecorded blobs", () =>
		withWorkspace(async (root) => {
			for (const name of ["a.dat", "b.dat", "c.dat"]) {
				writeFileSync(join(root, name), `${name} bytes\n`);
				await storePut(root, "sim", name);
			}
			const backend = await openStoreBackend(root);
			// `get` hands out a read-only copy, so edit the stored file itself.
			const b = storeBlobPath(root, "sim", "b.dat");
			// Same size, new bytes and mtime: edited behind PanCode.
			writeFileSync(b, "B.DAT BYTES\n");
			utimesSync(b, new Date(), new Date(Date.now() + 5000));
			rmSync(storeBlobPath(root, "sim", "c.dat"));
			writeFileSync(join(root, "d.dat"), "dropped\n");
			await backend.putBlobFromFile("sim", "d.dat", join(root, "d.dat"));

			const result = await storeVerify(root, "sim");
			deepStrictEqual(result.counts, { ok: 1, changed: 1, missing: 1, unrecorded: 1 });
			deepStrictEqual(
				result.blobs.map((blob) => [blob.blob, blob.status]),
				[
					["a.dat", "ok"],
					["b.dat", "changed"],
					["c.dat", "missing"],
					["d.dat", "unrecorded"],
				],
			);
		}));

	it("rm-tag deletes nothing without --yes", () =>
		withWorkspace(async (root) => {
			writeFileSync(join(root, "a.dat"), "12345");
			await storePut(root, "sim", "a.dat");
			deepStrictEqual(await storeRemoveTag(root, "sim", false), {
				tag: "sim",
				blobs: 1,
				bytes: 5,
				records: true,
				deleted: false,
			});
			strictEqual((await storeTags(root)).tags.length, 1);
			strictEqual((await storeRemoveTag(root, "sim", true)).deleted, true);
			const backend = await openStoreBackend(root);
			deepStrictEqual(await backend.listTags(), []);
		}));

	it("put creates a missing tag as an input tag", () =>
		withWorkspace(async (root) => {
			writeFileSync(join(root, "a.dat"), "x");
			const result = await cliPut(root, "fresh", "a.dat");
			strictEqual(result.createdTag, true);
			const backend = await openStoreBackend(root);
			strictEqual(await backend.tagExists("fresh"), true);
		}));

	it("put --link reports copy where the file system cannot clone, stores identical bytes, and usage counts them", () =>
		withWorkspace(async (root) => {
			const bytes = "linked bytes\n".repeat(64);
			writeFileSync(join(root, "a.dat"), bytes);
			const result = await cliPut(root, "sim", "a.dat", { link: true });
			const backend = await openStoreBackend(root);
			const links = (await backend.facts()).links;
			strictEqual(result.link, links);
			// The data directory of these tests is on ext4 or tmpfs, neither of which clones files.
			if (links === "copy") strictEqual(result.link, "copy");
			strictEqual(readFileSync(storeBlobPath(root, "sim", "a.dat"), "utf8"), bytes);
			strictEqual(result.identity?.sha256, createHash("sha256").update(bytes).digest("hex"));
			const usage = await backend.usage("sim");
			deepStrictEqual(usage.tags, [{ tag: "sim", root: "default", blobs: 1, bytes: Buffer.byteLength(bytes) }]);
			deepStrictEqual(
				usage.roots.map((r) => [r.name, r.tags, r.blobs, r.bytes]),
				[["default", 1, 1, Buffer.byteLength(bytes)]],
			);
		}));

	it("records the shell's put and remove as standalone and the session tool's put as main", () =>
		withWorkspace(async (root) => {
			writeFileSync(join(root, "a.dat"), "first\n");
			await cliPut(root, "sim", "a.dat");
			writeFileSync(join(root, "a.dat"), "second\n");
			const tool = createStoreTool({ getCwd: () => root, writable: true });
			strictEqual((await tool.run({ op: "put", tag: "sim", path: "a.dat" })).kind, "ok");
			strictEqual((await storeCommandResult(["remove", "sim:a.dat", "--yes"], root)).code, 0);
			const { records } = await readBlobHistory(await openStoreBackend(root), "sim", "a.dat");
			deepStrictEqual(
				records.map((record) => [record.kind, record.producedBy?.actor]),
				[
					["put", "standalone"],
					["put", "main"],
					["remove", "standalone"],
				],
			);
		}));

	it("remove-tag dry run exits 0 and a missing tag exits non-zero", () =>
		withWorkspace(async (root) => {
			writeFileSync(join(root, "a.dat"), "x");
			await storePut(root, "sim", "a.dat");
			strictEqual((await storeCommandResult(["remove-tag", "sim"], root)).code, 0);
			await rejects(storeCommandResult(["remove-tag", "absent"], root), /no tag named absent/u);
		}));

	it("remove removes one blob only with --yes", () =>
		withWorkspace(async (root) => {
			for (const name of ["a.dat", "b.dat"]) {
				writeFileSync(join(root, name), name);
				await storePut(root, "sim", name);
			}
			const backend = await openStoreBackend(root);
			strictEqual((await storeCommandResult(["remove", "sim:a.dat"], root)).code, 0);
			ok((await backend.statBlob("sim", "a.dat")) !== null);
			strictEqual((await storeCommandResult(["remove", "sim:a.dat", "--yes"], root)).code, 0);
			strictEqual(await backend.statBlob("sim", "a.dat"), null);
			ok((await backend.statBlob("sim", "b.dat")) !== null);
			await rejects(storeCommandResult(["remove", "sim:a.dat"], root), /not in the store/u);
		}));

	// Constructed: a trusted tracked settings file with a project id and a store left under the path key.
	it("where --json prints the project id, each root's id and the previous path key while its directory exists", () =>
		withWorkspace(async (root) => {
			mkdirSync(join(root, ".git"));
			mkdirSync(join(root, ".pancode"));
			writeFileSync(join(root, ".pancode", "settings.yaml"), "store:\n  projectId: where-proof\n");
			const snapshot = captureProjectSurface(root, "settings");
			if (!snapshot.contentHash) throw new Error("missing project settings hash");
			recordProjectSurfaceTrust(root, "settings", snapshot.contentHash);
			const pathKey = storeProjectKey(storeProjectRoot(root));
			mkdirSync(join(storeRoot(), "projects", pathKey), { recursive: true });
			writeFileSync(join(root, "a.dat"), "data");
			await storePut(root, "sim", "a.dat");
			const where = await storeWhere(root);
			strictEqual(where.projectId, "where-proof");
			strictEqual(where.projectKey, storeProjectKeyForId("where-proof"));
			strictEqual(where.previousKey, pathKey);
			strictEqual(where.roots.length, 1);
			ok(/^[0-9a-f-]{36}$/u.test(where.roots[0]?.id ?? ""), String(where.roots[0]?.id));
		}));

	// Constructed owner files: this process (live), an exited child (dead), "other-node" (remote) and garbage.
	it("locks --json lists live, dead, remote and unreadable locks with their keys", () =>
		withWorkspace(async (root) => {
			const at = "2026-01-02T03:04:05.000Z";
			const keys = plantLocks(root, at);
			const { data } = await storeCommandResult(["locks", "--json"], root);
			const locks = (data as { locks: Array<{ id: string; key: string | null; state: string }> }).locks;
			deepStrictEqual(
				locks.map((lock) => [lock.state, lock.key]).sort(),
				[
					["dead", keys.dead],
					["live", keys.live],
					["remote", keys.remote],
					["unreadable", null],
				].sort(),
			);
			ok(locks.every((lock) => lock.id.length === 32));
		}));

	it("locks break refuses a live lock, previews without a terminal and removes with --yes", () =>
		withWorkspace(async (root) => {
			const keys = plantLocks(root, new Date().toISOString());
			await rejects(storeCommandResult(["locks", "break", storeLockId(keys.live)], root), /alive on this host/u);
			const dead = storeLockId(keys.dead);
			const file = join(storeProjectDir(root), "locks", `${dead}.lock`);
			const preview = await storeCommandResult(["locks", "break", dead], root);
			strictEqual(preview.code, 0);
			ok(preview.text.startsWith("Would remove lock"), preview.text);
			ok(existsSync(file));
			const broken = await storeCommandResult(["locks", "break", dead, "--yes"], root);
			strictEqual(broken.code, 0);
			strictEqual(existsSync(file), false);
			ok(existsSync(join(storeProjectDir(root), "locks", `${storeLockId(keys.live)}.lock`)));
		}));

	it("adopt moves a moved repository's store and refuses a clash", () =>
		withWorkspace(async (oldRoot, dir) => {
			writeFileSync(join(oldRoot, "a.dat"), "data");
			await storePut(oldRoot, "sim", "a.dat");
			const oldKey = (await storeWhere(oldRoot)).projectKey;
			const newRoot = join(dir, "moved");
			renameSync(oldRoot, newRoot);

			const listed = await storeAdopt(newRoot);
			ok(!listed.adopted && listed.orphans.some((orphan) => orphan.key === oldKey));
			const adopted = await storeAdopt(newRoot, oldKey);
			ok(adopted.adopted);
			deepStrictEqual(
				(await storeTags(newRoot)).tags.map((tag) => tag.tag),
				["sim"],
			);

			mkdirSync(oldRoot);
			writeFileSync(join(oldRoot, "b.dat"), "other");
			await storePut(oldRoot, "other", "b.dat");
			rmSync(oldRoot, { recursive: true });
			await rejects(storeAdopt(newRoot, oldKey), /already has a store/u);
		}));
});

// Constructed: a scratch home whose settings name one store root and a git checkout whose tracked settings set an id.
describe("pancode store, as installed", () => {
	it("keys the store by the configured roots and the trusted project id", async () => {
		const scratch = headlessScratch("pancode-store-cli-built-");
		try {
			const root = join(scratch.root, "shared-root");
			writeFileSync(
				join(scratch.configDir, "settings.yaml"),
				`version: 2\nstore:\n  roots:\n    - { name: shared, path: ${JSON.stringify(root)} }\n`,
			);
			const project = join(scratch.root, "project");
			mkdirSync(join(project, ".git"), { recursive: true });
			mkdirSync(join(project, ".pancode"));
			writeFileSync(join(project, ".pancode", "settings.yaml"), "store:\n  projectId: built-proof\n");
			const cli = (...args: string[]) => runCli(args, { env: scratch.env, cwd: project });
			const preview = await cli("config", "trust", "settings", "--json");
			const hash = (JSON.parse(preview.stdout) as { contentHash: string }).contentHash;
			strictEqual((await cli("config", "trust", "settings", "--hash", hash)).code, 0);
			const where = await cli("store", "where", "--json");
			strictEqual(where.code, 0, where.stderr);
			const data = JSON.parse(where.stdout) as {
				projectId: string;
				projectKey: string;
				roots: { name: string; path: string }[];
			};
			strictEqual(data.projectId, "built-proof");
			strictEqual(data.projectKey, storeProjectKeyForId("built-proof"));
			deepStrictEqual(
				data.roots.map((entry) => [entry.name, entry.path]),
				[["shared", root]],
			);
		} finally {
			scratch.cleanup();
		}
	});
});
