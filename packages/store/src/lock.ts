// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { StoreRefusal } from "./backend/types.js";
import { storeLocksDir } from "./paths/index.js";

/**
 * A cross-process lock for one store key (a blob, or a tag's metadata), held
 * across a write and the record that describes it, so a second writer in
 * another process, or on another host sharing the root, cannot slip its bytes
 * between the two. The owner file is written under a temporary name and
 * `link()`ed to the lock name, which is atomic on NFS as on a local file
 * system, so a lock file is never partial. A lock is taken over only when its
 * holder ran on this host and is gone: its pid is not alive, or the host has
 * booted since. A lock from another host, or one that cannot be read, is never
 * broken here; an operator clears it with `pancode store locks break <id>`.
 */

const LOCK_WAIT_MS = 30 * 1000;
const LOCK_POLL_MS = 25;
/** Only for the `.break` turn file a breaker left when it died; locks themselves never age out. */
const BREAK_STALE_MS = 10 * 1000;
const LOCK_SUFFIX = ".lock";
const LOCK_ID = /^[0-9a-f]{32}$/u;

interface LockOwner {
	v: 2;
	key: string;
	pid: number;
	host: string;
	bootId?: string;
	token: string;
	at: string;
}

/** `live`: this host, pid alive, same boot. `dead`: this host, pid gone or another boot. */
export type StoreLockState = "live" | "dead" | "remote" | "unreadable";

export interface StoreLockInfo {
	/** The lock file's name without `.lock`. */
	id: string;
	file: string;
	state: StoreLockState;
	key: string | null;
	pid: number | null;
	host: string | null;
	at: string | null;
}

function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

let cachedBootId: string | null | undefined;

/** This host's boot id on Linux; undefined elsewhere. */
function bootId(): string | undefined {
	if (cachedBootId === undefined) {
		try {
			cachedBootId =
				process.platform === "linux" ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null : null;
		} catch {
			// No boot id to compare: the pid alone judges this host's locks.
			cachedBootId = null;
		}
	}
	return cachedBootId ?? undefined;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errnoOf(error) === "EPERM";
	}
}

function parseOwner(text: string): LockOwner | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const owner = value as Partial<LockOwner>;
	if (
		owner.v !== 2 ||
		typeof owner.key !== "string" ||
		!Number.isSafeInteger(owner.pid) ||
		typeof owner.host !== "string" ||
		typeof owner.token !== "string" ||
		typeof owner.at !== "string" ||
		(owner.bootId !== undefined && typeof owner.bootId !== "string")
	)
		return null;
	return owner as LockOwner;
}

function stateOf(owner: LockOwner | null): StoreLockState {
	if (owner === null) return "unreadable";
	if (owner.host !== hostname()) return "remote";
	if (owner.bootId !== bootId()) return "dead";
	return pidAlive(owner.pid) ? "live" : "dead";
}

/** The lock file's text, or null when it is gone. */
async function readLockText(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return null;
		throw error;
	}
}

function infoOf(id: string, file: string, text: string): StoreLockInfo {
	const owner = parseOwner(text);
	return {
		id,
		file,
		state: stateOf(owner),
		key: owner?.key ?? null,
		pid: owner?.pid ?? null,
		host: owner?.host ?? null,
		at: owner?.at ?? null,
	};
}

/**
 * Remove the lock at `file` only while it still holds `expected`. A verdict
 * reached without holding anything can be out of date by the time it acts:
 * another breaker may already have replaced the lock with its own. So breakers
 * take turns through an O_EXCL `.break` file and compare the lock again while
 * they hold it. A `.break` file left by a breaker that died is cleared after
 * BREAK_STALE_MS.
 */
async function removeIfUnchanged(file: string, expected: string): Promise<boolean> {
	const breaker = `${file}.break`;
	try {
		await (await open(breaker, "wx", 0o600)).close();
	} catch (error) {
		if (errnoOf(error) !== "EEXIST") throw error;
		try {
			if (Date.now() - (await stat(breaker)).mtimeMs > BREAK_STALE_MS) await rm(breaker, { force: true });
		} catch (statError) {
			if (errnoOf(statError) !== "ENOENT") throw statError;
		}
		return false;
	}
	try {
		if ((await readLockText(file)) !== expected) return false;
		await rm(file, { force: true });
		return true;
	} finally {
		await rm(breaker, { force: true });
	}
}

/** The id of the lock for `key`: the file name under the project's locks directory, without `.lock`. */
export function storeLockId(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function lockFile(projectDir: string, key: string): string {
	return path.join(storeLocksDir(projectDir), `${storeLockId(key)}${LOCK_SUFFIX}`);
}

function holderRefusal(key: string, info: StoreLockInfo): StoreRefusal {
	const command = `pancode store locks break ${info.id}`;
	if (info.state === "unreadable")
		return new StoreRefusal(
			"unavailable",
			`The store lock for ${key} cannot be read (${info.file}). If no writer holds it, run ${command}.`,
		);
	return new StoreRefusal(
		"unavailable",
		`Another writer holds the store lock for ${key}: pid ${info.pid} on ${info.host} since ${info.at}. If that writer is gone, run ${command}.`,
	);
}

/** Whether `temp` is now linked as the lock: after a lost reply on NFS, `link` can fail although it succeeded. */
async function linkedAnyway(temp: string): Promise<boolean> {
	try {
		return (await stat(temp)).nlink === 2;
	} catch {
		// A temp file that cannot be examined proves nothing.
		return false;
	}
}

async function acquire(file: string, key: string, waitMs: number): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const token = randomBytes(8).toString("hex");
	const id = path.basename(file, LOCK_SUFFIX);
	const boot = bootId();
	const owner: LockOwner = {
		v: 2,
		key,
		pid: process.pid,
		host: hostname(),
		...(boot !== undefined ? { bootId: boot } : {}),
		token,
		at: new Date().toISOString(),
	};
	const temp = path.join(path.dirname(file), `.${id}.${process.pid}.${token}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify(owner));
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		const deadline = Date.now() + waitMs;
		for (;;) {
			try {
				await link(temp, file);
				return token;
			} catch (error) {
				if (errnoOf(error) !== "EEXIST") throw error;
				if (await linkedAnyway(temp)) return token;
			}
			const text = await readLockText(file);
			if (text === null) continue;
			const info = infoOf(id, file, text);
			if (info.state === "dead" && (await removeIfUnchanged(file, text))) continue;
			if (Date.now() >= deadline) throw holderRefusal(key, info);
			await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
		}
	} finally {
		await rm(temp, { force: true });
	}
}

async function release(file: string, token: string): Promise<void> {
	try {
		const owner = parseOwner(await readFile(file, "utf8"));
		// A lock broken by an operator may belong to another writer now.
		if (owner?.token === token) await rm(file, { force: true });
	} catch {
		// Already gone, or unreadable: nothing of ours to release.
	}
}

export interface StoreLockOptions {
	/** How long to wait for a holder before refusing; 30 seconds by default. */
	waitMs?: number;
}

/** Run fn while holding the store lock for key in the project whose store directory is `projectDir`. */
export async function withStoreLock<T>(
	projectDir: string,
	key: string,
	fn: () => Promise<T>,
	options: StoreLockOptions = {},
): Promise<T> {
	const file = lockFile(projectDir, key);
	const token = await acquire(file, key, options.waitMs ?? LOCK_WAIT_MS);
	try {
		return await fn();
	} finally {
		await release(file, token);
	}
}

/** Every lock of the project, in id order. */
export async function listStoreLocks(projectDir: string): Promise<StoreLockInfo[]> {
	const dir = storeLocksDir(projectDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return [];
		throw error;
	}
	const locks: StoreLockInfo[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(LOCK_SUFFIX)) continue;
		const id = name.slice(0, -LOCK_SUFFIX.length);
		if (!LOCK_ID.test(id)) continue;
		const file = path.join(dir, name);
		const text = await readLockText(file);
		if (text !== null) locks.push(infoOf(id, file, text));
	}
	return locks;
}

/** The lock with this id, or null when there is none. */
export async function readStoreLock(projectDir: string, id: string): Promise<StoreLockInfo | null> {
	if (!LOCK_ID.test(id)) throw new StoreRefusal("invalid-name", `'${id}' is not a lock id: it is 32 hex characters.`);
	const file = path.join(storeLocksDir(projectDir), `${id}${LOCK_SUFFIX}`);
	const text = await readLockText(file);
	return text === null ? null : infoOf(id, file, text);
}

/**
 * Remove one lock an operator named. A live lock is refused. The lock is
 * removed only if its file still holds what was judged, through the same
 * `.break` turn writers use; no blob or record is touched.
 */
export async function breakStoreLock(projectDir: string, id: string): Promise<StoreLockInfo> {
	const info = await readStoreLock(projectDir, id);
	if (info === null) throw new StoreRefusal("not-found", `No store lock ${id} in this project.`);
	if (info.state === "live")
		throw new StoreRefusal(
			"unavailable",
			`Store lock ${id} is held by pid ${info.pid}, alive on this host; it is not broken while its writer runs.`,
		);
	const text = await readLockText(info.file);
	if (text === null) return info;
	if (infoOf(id, info.file, text).state === "live" || !(await removeIfUnchanged(info.file, text)))
		throw new StoreRefusal("unavailable", `Store lock ${id} changed while it was being broken; look again.`);
	return info;
}
