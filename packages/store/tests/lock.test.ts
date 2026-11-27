// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Inputs are constructed: hand-written owner files for this host, another host ("other-node") and garbage.
import { ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSharedStoreBackend, StoreRefusal, storeLockId, withStoreLock } from "../src/index.js";
import { storeLocksDir } from "../src/paths/index.js";
import { S3Client } from "../src/s3/client.js";

const WAIT = { waitMs: 150 };

function project(): string {
	const dir = mkdtempSync(join(tmpdir(), "store-lock-"));
	mkdirSync(storeLocksDir(dir), { recursive: true });
	return dir;
}

function plant(dir: string, key: string, body: string, ageMs = 0): string {
	const file = join(storeLocksDir(dir), `${storeLockId(key)}.lock`);
	writeFileSync(file, body);
	if (ageMs > 0) utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
	return file;
}

function owner(fields: Record<string, unknown>): string {
	return JSON.stringify({ v: 2, token: "0000000000000000", at: new Date().toISOString(), ...fields });
}

const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid ?? 0;
const ran = async (dir: string, key: string): Promise<boolean> => withStoreLock(dir, key, async () => true, WAIT);

describe("store locks", () => {
	it("takes over a lock whose holder on this host is dead and never one from another host, however old", async () => {
		const dir = project();
		const mine = plant(dir, "blob:a", owner({ key: "blob:a", pid: deadPid(), host: hostname() }));
		strictEqual(await ran(dir, "blob:a"), true);
		strictEqual(existsSync(mine), false);
		const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		const remote = plant(dir, "blob:b", owner({ key: "blob:b", pid: 1, host: "other-node", at }), 60 * 60 * 1000);
		await rejects(ran(dir, "blob:b"), StoreRefusal);
		ok(existsSync(remote));
	});

	it("takes over a lock from another boot of this host and never an unreadable one", async () => {
		const dir = project();
		const rebooted = plant(
			dir,
			"blob:a",
			owner({ key: "blob:a", pid: process.pid, host: hostname(), bootId: "another-boot" }),
		);
		strictEqual(await ran(dir, "blob:a"), true);
		strictEqual(existsSync(rebooted), false);
		const garbage = plant(dir, "blob:b", "{not json", 60 * 60 * 1000);
		await rejects(ran(dir, "blob:b"), /cannot be read.*pancode store locks break [0-9a-f]{32}\./u);
		strictEqual(readFileSync(garbage, "utf8"), "{not json");
	});

	it("names the holder's key, pid, host and time and the break command when the wait runs out", async () => {
		const dir = project();
		const at = "2026-01-02T03:04:05.000Z";
		plant(dir, "blob:c", owner({ key: "blob:c", pid: 4242, host: "other-node", at }));
		await rejects(ran(dir, "blob:c"), (error: Error) => {
			strictEqual(
				error.message,
				`Another writer holds the store lock for blob:c: pid 4242 on other-node since ${at}. If that writer is gone, run pancode store locks break ${storeLockId("blob:c")}.`,
			);
			return true;
		});
	});

	it("refuses shared backend calls on a missing folder without creating it", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "store-shared-missing-"));
		const missing = join(scratch, "unmounted");
		const backend = createSharedStoreBackend({
			root: missing,
			cacheDir: join(scratch, "cache"),
			projectKey: "0123456789abcdef",
			projectRoot: scratch,
		});
		const unavailable = (error: unknown) => error instanceof StoreRefusal && error.reason === "unavailable";
		await rejects(
			backend.withLock("tag\0sim", async () => "ok"),
			unavailable,
		);
		await rejects(backend.listTags(), unavailable);
		await rejects(backend.tagExists("sim"), unavailable);
		await rejects(backend.delTag("sim"), unavailable);
		await rejects(backend.listLocks(), unavailable);
		strictEqual(existsSync(missing), false);
	});

	it("retries S3 requests dropped on a stale keep-alive socket on a fresh connection", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "store-s3-retry-"));
		const payload = Buffer.from("staged file payload\n");
		const file = join(dir, "payload.bin");
		writeFileSync(file, payload);
		const sha256 = createHash("sha256").update(payload).digest("hex");
		let attempts = 0;
		let drops = 2;
		const server = http.createServer((req, res) => {
			attempts++;
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				if (req.method === "PUT" && drops > 0) {
					drops--;
					req.socket.destroy();
					return;
				}
				res.writeHead(200, { Date: new Date().toUTCString() });
				res.end(`${req.method}:${Buffer.concat(chunks).length}`);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(() => {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		});
		const { port } = server.address() as AddressInfo;
		const client = new S3Client({
			endpoint: `http://127.0.0.1:${port}`,
			region: "us-east-1",
			bucket: "b",
			accessKeyId: "k",
			secretAccessKey: "s",
			pathStyle: true,
		});
		const bufRes = await client.send("PUT", "k1", { headers: { "if-none-match": "*" }, body: Buffer.from("hello") });
		strictEqual(bufRes.status, 200);
		strictEqual(await bufRes.text(), "PUT:5");
		const fileRes = await client.send("PUT", "k2", {
			headers: { "if-none-match": "*" },
			body: { file, bytes: payload.length, sha256 },
		});
		strictEqual(fileRes.status, 200);
		strictEqual(await fileRes.text(), `PUT:${payload.length}`);
		strictEqual(attempts, 4);
	});
});
