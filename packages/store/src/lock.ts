// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type FileHandle, link, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { type StoreLockInfo, type StoreLockState, StoreRefusal } from "./backend/types.js";
import { STORE_LEASE_EXPIRY_MS, withLease } from "./lease.js";
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
 *
 * On a store several hosts share as one folder the lock is a lease: its holder
 * rewrites the lock file every 10 seconds, and a lock whose file the file
 * server last changed more than 60 seconds ago, by the file server's clock, is
 * taken over from any host. The holder confirms its lease before each change
 * it makes under it (`fenceHeldLeases`), so a writer that stalled past its
 * lease refuses instead of overwriting the next holder's change.
 */

const LOCK_WAIT_MS = 30 * 1000;
const LOCK_POLL_MS = 25;
/** A lease contender polls slower: each look writes a clock probe on the shared file system. */
const LEASE_POLL_MS = 200;
/** Only for the `.break` turn file a breaker left when it died; a local lock itself never ages out. */
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

/**
 * A lease is live until the file server's clock passes its last renewal by STORE_LEASE_EXPIRY_MS; a holder
 * known gone from this host is dead at once.
 */
function leaseStateOf(owner: LockOwner | null, seen: SeenLock, now: number): StoreLockState {
	if (owner === null) return "unreadable";
	if (owner.host === hostname() && (owner.bootId !== bootId() || !pidAlive(owner.pid))) return "dead";
	return now - seen.mtimeMs > STORE_LEASE_EXPIRY_MS ? "dead" : "live";
}

/** A lock file as read once: its text, and the inode and modification time it had when opened. */
interface SeenLock {
	text: string;
	ino: number;
	mtimeMs: number;
}

/**
 * The lock file as it is now, or null when it is gone. Opening it first makes an NFS client fetch its
 * attributes afresh (close-to-open), so a renewal another host just made is seen.
 */
async function readLockSeen(file: string): Promise<SeenLock | null> {
	let handle: FileHandle;
	try {
		handle = await open(file, "r");
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return null;
		throw error;
	}
	try {
		const info = await handle.stat();
		return { text: await handle.readFile("utf8"), ino: info.ino, mtimeMs: info.mtimeMs };
	} finally {
		await handle.close();
	}
}

/**
 * The time now by the clock of the file system `dir` is on: the modification time of a file written there and
 * removed. A file server sets that time itself, so hosts whose clocks differ judge a lease alike.
 */
async function storeNow(dir: string): Promise<number> {
	const probe = path.join(dir, `.clock.${process.pid}.${randomBytes(6).toString("hex")}`);
	const handle = await open(probe, "wx", 0o600);
	try {
		await handle.write("t");
		await handle.datasync();
		return (await handle.stat()).mtimeMs;
	} finally {
		await handle.close();
		await rm(probe, { force: true });
	}
}

/** How locks in one project are judged: a lease mode judges by age against `now`, the file server's clock. */
type Judge = { lease: false } | { lease: true; now: number };

async function judgeFor(dir: string, lease: boolean): Promise<Judge> {
	return lease ? { lease: true, now: await storeNow(dir) } : { lease: false };
}

function infoOf(id: string, file: string, seen: SeenLock, judge: Judge): StoreLockInfo {
	const owner = parseOwner(seen.text);
	return {
		id,
		file,
		state: judge.lease ? leaseStateOf(owner, seen, judge.now) : stateOf(owner),
		key: owner?.key ?? null,
		pid: owner?.pid ?? null,
		host: owner?.host ?? null,
		at: owner?.at ?? null,
	};
}

/** Serialize a break with other breaks and shared-owner changes; null means another turn is in progress. */
async function withLockTurn(file: string, now: number, change: () => Promise<boolean>): Promise<boolean | null> {
	const breaker = `${file}.break`;
	try {
		await (await open(breaker, "wx", 0o600)).close();
	} catch (error) {
		if (errnoOf(error) !== "EEXIST") throw error;
		try {
			if (now - (await stat(breaker)).mtimeMs > BREAK_STALE_MS) await rm(breaker, { force: true });
		} catch (statError) {
			if (errnoOf(statError) !== "ENOENT") throw statError;
		}
		return null;
	}
	try {
		return await change();
	} finally {
		await rm(breaker, { force: true });
	}
}

async function removeIfUnchanged(file: string, expected: SeenLock, now: number): Promise<boolean> {
	return (
		(await withLockTurn(file, now, async () => {
			const seen = await readLockSeen(file);
			if (seen === null || seen.text !== expected.text || seen.ino !== expected.ino || seen.mtimeMs !== expected.mtimeMs)
				return false;
			await rm(file, { force: true });
			return true;
		})) === true
	);
}

/** The id of the lock for `key`: the file name under the project's locks directory, without `.lock`. */
export function storeLockId(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function lockFile(projectDir: string, key: string): string {
	return path.join(storeLocksDir(projectDir), `${storeLockId(key)}${LOCK_SUFFIX}`);
}

function holderRefusal(key: string, info: StoreLockInfo, lease: boolean): StoreRefusal {
	const command = `pancode store locks break ${info.id}`;
	if (info.state === "unreadable")
		return new StoreRefusal(
			"unavailable",
			`The store lock for ${key} cannot be read (${info.file}). If no writer holds it, run ${command}.`,
		);
	return new StoreRefusal(
		"unavailable",
		`Another writer holds the store lock for ${key}: pid ${info.pid} on ${info.host} since ${info.at}. ${
			lease
				? `Its lease expires ${STORE_LEASE_EXPIRY_MS / 1000} s after its last renewal.`
				: `If that writer is gone, run ${command}.`
		}`,
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

/** A lock this process took: its token, and for a lease the open lock file it renews and its bytes. */
interface HeldLock {
	token: string;
	handle: FileHandle;
	ino: number;
	body: string;
}

async function acquire(file: string, key: string, waitMs: number, lease: boolean): Promise<HeldLock> {
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
	const body = JSON.stringify(owner);
	const temp = path.join(path.dirname(file), `.${id}.${process.pid}.${token}.tmp`);
	// A lease keeps its file open to renew it; any other lock closes it once linked.
	const handle = await open(temp, "wx", 0o600);
	let held: HeldLock | null = null;
	try {
		await handle.writeFile(body);
		await handle.sync();
		const ino = (await handle.stat()).ino;
		const deadline = performance.now() + waitMs;
		for (;;) {
			try {
				await link(temp, file);
				held = { token, handle, ino, body };
				return held;
			} catch (error) {
				if (errnoOf(error) !== "EEXIST") throw error;
				if (await linkedAnyway(temp)) {
					held = { token, handle, ino, body };
					return held;
				}
			}
			const seen = await readLockSeen(file);
			if (seen === null) continue;
			const judge = await judgeFor(path.dirname(file), lease);
			const info = infoOf(id, file, seen, judge);
			if (info.state === "dead" && (await removeIfUnchanged(file, seen, judge.lease ? judge.now : Date.now()))) continue;
			if (performance.now() >= deadline) throw holderRefusal(key, info, lease);
			await new Promise((resolve) => setTimeout(resolve, lease ? LEASE_POLL_MS : LOCK_POLL_MS));
		}
	} finally {
		await rm(temp, { force: true });
		if (held === null || !lease) await handle.close();
	}
}

/** Whether the lock at `file` is still the one `held` took. */
async function stillHeld(file: string, held: HeldLock): Promise<boolean> {
	const seen = await readLockSeen(file);
	return seen !== null && seen.ino === held.ino && parseOwner(seen.text)?.token === held.token;
}

/** The breaker and owner take the same turn before changing the current lease. An expired owner cannot revive it. */
async function changeHeldLease(file: string, held: HeldLock, release: boolean): Promise<boolean> {
	const dir = path.dirname(file);
	const deadline = performance.now() + LOCK_WAIT_MS;
	for (;;) {
		const changed = await withLockTurn(file, await storeNow(dir), async () => {
			const seen = await readLockSeen(file);
			if (seen === null || seen.ino !== held.ino || seen.text !== held.body) return false;
			if ((await storeNow(dir)) - seen.mtimeMs > STORE_LEASE_EXPIRY_MS) return false;
			if (release) await rm(file);
			else {
				await held.handle.write(held.body, 0, "utf8");
				await held.handle.datasync();
			}
			return true;
		});
		if (changed !== null) return changed;
		if (performance.now() >= deadline)
			throw new StoreRefusal("unavailable", `Timed out waiting to update lease ${file}.`);
		await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
	}
}

async function release(file: string, held: HeldLock): Promise<void> {
	try {
		// A lock broken by an operator or taken over may belong to another writer now.
		if (await stillHeld(file, held)) await rm(file, { force: true });
	} catch {
		// Already gone, or unreadable: nothing of ours to release.
	}
}

export interface StoreLockOptions {
	/** How long to wait for a holder before refusing; 30 seconds by default. */
	waitMs?: number;
	/**
	 * The lock is a lease on a store several hosts share: renewed while held, and taken over from any host once
	 * not renewed for STORE_LEASE_EXPIRY_MS.
	 */
	lease?: boolean;
}

/** How a project's existing locks are read: `lease` as `StoreLockOptions` gives it. */
export interface StoreLockReadOptions {
	lease?: boolean;
}

/** Run fn while holding the store lock for key in the project whose store directory is `projectDir`. */
export async function withStoreLock<T>(
	projectDir: string,
	key: string,
	fn: () => Promise<T>,
	options: StoreLockOptions = {},
): Promise<T> {
	const file = lockFile(projectDir, key);
	const lease = options.lease === true;
	const held = await acquire(file, key, options.waitMs ?? LOCK_WAIT_MS, lease);
	if (!lease) {
		try {
			return await fn();
		} finally {
			await release(file, held);
		}
	}
	try {
		return await withLease(
			key,
			{
				renew: () => changeHeldLease(file, held, false),
				release: async () => {
					await changeHeldLease(file, held, true);
				},
			},
			fn,
		);
	} finally {
		await held.handle.close();
	}
}

/** Every lock of the project, in id order. */
export async function listStoreLocks(projectDir: string, options: StoreLockReadOptions = {}): Promise<StoreLockInfo[]> {
	const dir = storeLocksDir(projectDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return [];
		throw error;
	}
	const locks: StoreLockInfo[] = [];
	let judge: Judge | null = null;
	for (const name of names.sort()) {
		if (!name.endsWith(LOCK_SUFFIX)) continue;
		const id = name.slice(0, -LOCK_SUFFIX.length);
		if (!LOCK_ID.test(id)) continue;
		const file = path.join(dir, name);
		const seen = await readLockSeen(file);
		judge ??= await judgeFor(dir, options.lease === true);
		if (seen !== null) locks.push(infoOf(id, file, seen, judge));
	}
	return locks;
}

/** The lock with this id, or null when there is none. */
export async function readStoreLock(
	projectDir: string,
	id: string,
	options: StoreLockReadOptions = {},
): Promise<StoreLockInfo | null> {
	return (await seeStoreLock(projectDir, id, options.lease === true))?.info ?? null;
}

async function seeStoreLock(
	projectDir: string,
	id: string,
	lease: boolean,
): Promise<{ info: StoreLockInfo; seen: SeenLock; judge: Judge } | null> {
	if (!LOCK_ID.test(id)) throw new StoreRefusal("invalid-name", `'${id}' is not a lock id: it is 32 hex characters.`);
	const dir = storeLocksDir(projectDir);
	const file = path.join(dir, `${id}${LOCK_SUFFIX}`);
	const seen = await readLockSeen(file);
	if (seen === null) return null;
	const judge = await judgeFor(dir, lease);
	return { info: infoOf(id, file, seen, judge), seen, judge };
}

/**
 * Remove one lock an operator named. A live lock is refused. The lock is
 * removed only if its file still holds what was judged, through the same
 * `.break` turn writers use; no blob or record is touched.
 */
export async function breakStoreLock(
	projectDir: string,
	id: string,
	options: StoreLockReadOptions = {},
): Promise<StoreLockInfo> {
	const lease = options.lease === true;
	const found = await seeStoreLock(projectDir, id, lease);
	if (found === null) throw new StoreRefusal("not-found", `No store lock ${id} in this project.`);
	const { info, seen, judge } = found;
	if (info.state === "live")
		throw new StoreRefusal(
			"unavailable",
			lease
				? `Store lock ${id} is held by pid ${info.pid} on ${info.host} and renewed within ${STORE_LEASE_EXPIRY_MS / 1000} s; it is not broken while its writer runs.`
				: `Store lock ${id} is held by pid ${info.pid}, alive on this host; it is not broken while its writer runs.`,
		);
	if (
		!(await removeIfUnchanged(info.file, seen, judge.lease ? judge.now : Date.now())) &&
		(await readLockSeen(info.file)) !== null
	)
		throw new StoreRefusal("unavailable", `Store lock ${id} changed while it was being broken; look again.`);
	return info;
}
