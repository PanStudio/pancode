// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Inputs are constructed: hand-written owner files for this host, another host ("other-node") and garbage.
import { ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { StoreRefusal, storeLockId, withStoreLock } from "../src/index.js";
import { storeLocksDir } from "../src/paths/index.js";

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
});
