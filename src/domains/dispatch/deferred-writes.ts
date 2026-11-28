// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Run-state writes that land off the emitter, in the call journal's shape: the caller builds its bytes and returns at
 * once, and one `setImmediate` writes every queued path with async file I/O, one write in flight per path.
 *
 * Two kinds of path. An append path (a run feed, a fleet's event journal) batches its lines into one append under
 * `O_APPEND | O_NOFOLLOW`, through a handle kept open until its owner flushes it, so a row costs no open or close. A record path (a run's owner or grant record) keeps only its latest value, written whole
 * through temp file, fsync and rename, so a reader never sees a torn record and a superseded value is never written.
 *
 * Flush points: a run's end awaits its own paths before its terminal event, shutdown awaits
 * {@link flushDeferredWrites}, and a forced exit drains what is still queued synchronously on `exit`. A path with a
 * write still in flight is left out of that drain, because a synchronous write could land ahead of it: a file is
 * always a whole prefix of what was appended to it, and an exit in that window costs its last lines.
 */

import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { safeResourceWrite, safeResourceWriteAsync } from "../../core/safe-resource-write.js";

const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
const FILE_MODE = 0o600;
/** Append handles held open at once (open, opening, or closing); past this, the least recently used idle one closes. */
const MAX_OPEN_APPENDS = 64;

export interface DeferredAppendOptions {
	onError?: (error: unknown) => void;
	mkdirMode?: number;
	plainDirectories?: readonly string[];
}

export interface DeferredRecordOptions {
	plainDirectories?: readonly string[];
}

type Pending =
	| {
			kind: "append";
			lines: string[];
			onError?: (error: unknown) => void;
			mkdirMode?: number;
			plainDirectories?: readonly string[];
	  }
	| { kind: "record"; contents: string; plainDirectories?: readonly string[] };

const queued = new Map<string, Pending>();
const inFlight = new Map<string, Promise<void>>();
const handles = new Map<string, FileHandle>();
const retiredHandles = new Set<string>();
let opening = 0;
let closing = 0;
let slotWaiters: Array<() => void> = [];
let scheduled: NodeJS.Immediate | undefined;
let exitHooked = false;

function waitForAppendSlot(): Promise<void> {
	return new Promise<void>((resolve) => {
		slotWaiters.push(resolve);
	});
}

function notifyAppendSlot(): void {
	if (slotWaiters.length === 0) return;
	const waiters = slotWaiters;
	slotWaiters = [];
	for (const wake of waiters) wake();
}

function schedule(): void {
	if (!exitHooked) {
		exitHooked = true;
		process.once("exit", () => drainDeferredWritesSync());
	}
	scheduled ??= setImmediate(() => {
		scheduled = undefined;
		void landAll();
	});
}

/** Queue `text` for the end of `path`. A failed write reports once per batch through the latest `onError`. */
export function deferAppend(path: string, text: string, options?: DeferredAppendOptions): void {
	const pending = queued.get(path);
	if (pending?.kind === "append") {
		pending.lines.push(text);
		if (options?.onError !== undefined) pending.onError = options.onError;
		if (options?.mkdirMode !== undefined) pending.mkdirMode = options.mkdirMode;
		if (options?.plainDirectories !== undefined) pending.plainDirectories = options.plainDirectories;
	} else {
		queued.set(path, {
			kind: "append",
			lines: [text],
			...(options?.onError !== undefined ? { onError: options.onError } : {}),
			...(options?.mkdirMode !== undefined ? { mkdirMode: options.mkdirMode } : {}),
			...(options?.plainDirectories !== undefined ? { plainDirectories: options.plainDirectories } : {}),
		});
	}
	schedule();
}

/** Queue `contents` as the whole of `path`, replacing any value not yet written. */
export function deferRecord(path: string, contents: string, options?: DeferredRecordOptions): void {
	queued.set(path, {
		kind: "record",
		contents,
		...(options?.plainDirectories !== undefined ? { plainDirectories: options.plainDirectories } : {}),
	});
	schedule();
}

/** True while `path` has bytes queued or a write in flight. */
export function deferredWritePending(path: string): boolean {
	return queued.has(path) || inFlight.has(path);
}

/** Forget what `path` still has queued, for a file that is being removed. */
export function dropDeferredWrite(path: string): void {
	queued.delete(path);
	if (inFlight.has(path)) {
		retiredHandles.add(path);
		return;
	}
	void closeHandle(path);
}

function closeOpenHandle(handle: FileHandle): Promise<void> {
	closing += 1;
	return handle
		.close()
		.catch(() => undefined)
		.finally(() => {
			closing -= 1;
			notifyAppendSlot();
		});
}

/** Close `path`'s append handle once no write to it is in flight. */
function closeHandle(path: string): Promise<void> {
	const running = inFlight.get(path);
	if (running !== undefined) {
		retiredHandles.add(path);
		return running.then(() => closeHandle(path));
	}
	retiredHandles.delete(path);
	const handle = handles.get(path);
	if (handle === undefined) return Promise.resolve();
	handles.delete(path);
	return closeOpenHandle(handle);
}

async function directoriesArePlainAsync(directories: readonly string[]): Promise<boolean> {
	for (const dir of directories) {
		try {
			const stat = await lstat(dir);
			if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return false;
		}
	}
	return true;
}

function directoriesArePlainSync(directories: readonly string[]): boolean {
	for (const dir of directories) {
		try {
			const stat = lstatSync(dir, { throwIfNoEntry: false });
			if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink())) return false;
		} catch {
			return false;
		}
	}
	return true;
}

async function appendHandle(path: string, pending: Extract<Pending, { kind: "append" }>): Promise<FileHandle> {
	const held = handles.get(path);
	if (held !== undefined) {
		// Refresh LRU order on reuse so active feeds stay open ahead of quiet ones.
		handles.delete(path);
		handles.set(path, held);
		return held;
	}
	if (pending.plainDirectories !== undefined && !(await directoriesArePlainAsync(pending.plainDirectories))) {
		throw new Error("run state directory is not a regular directory");
	}
	await mkdir(dirname(path), {
		recursive: true,
		...(pending.mkdirMode !== undefined ? { mode: pending.mkdirMode } : {}),
	});
	if (pending.plainDirectories !== undefined && !(await directoriesArePlainAsync(pending.plainDirectories))) {
		throw new Error("run state directory is not a regular directory");
	}
	while (handles.size + opening + closing >= MAX_OPEN_APPENDS) {
		const idle = [...handles.keys()].find((candidate) => candidate !== path && !inFlight.has(candidate));
		if (idle !== undefined) {
			const victim = handles.get(idle);
			handles.delete(idle);
			if (victim !== undefined) await closeOpenHandle(victim);
			continue;
		}
		await waitForAppendSlot();
	}
	opening += 1;
	try {
		const handle = await open(path, APPEND_FLAGS, FILE_MODE);
		handles.set(path, handle);
		return handle;
	} finally {
		opening -= 1;
		notifyAppendSlot();
	}
}

async function writePending(path: string, pending: Pending): Promise<void> {
	if (pending.kind === "record") {
		if (pending.plainDirectories !== undefined && !(await directoriesArePlainAsync(pending.plainDirectories))) return;
		await safeResourceWriteAsync(path, pending.contents, { encoding: "utf8", mode: FILE_MODE });
		return;
	}
	const handle = await appendHandle(path, pending);
	try {
		await handle.writeFile(pending.lines.join(""));
	} catch (error) {
		if (handles.get(path) === handle) handles.delete(path);
		await closeOpenHandle(handle);
		throw error;
	}
}

function writePendingSync(path: string, pending: Pending): void {
	if (pending.kind === "record") {
		if (pending.plainDirectories !== undefined && !directoriesArePlainSync(pending.plainDirectories)) return;
		safeResourceWrite(path, pending.contents, { encoding: "utf8", mode: FILE_MODE });
		return;
	}
	if (pending.plainDirectories !== undefined && !directoriesArePlainSync(pending.plainDirectories)) {
		throw new Error("run state directory is not a regular directory");
	}
	mkdirSync(dirname(path), {
		recursive: true,
		...(pending.mkdirMode !== undefined ? { mode: pending.mkdirMode } : {}),
	});
	if (pending.plainDirectories !== undefined && !directoriesArePlainSync(pending.plainDirectories)) {
		throw new Error("run state directory is not a regular directory");
	}
	const handle = openSync(path, APPEND_FLAGS, FILE_MODE);
	try {
		const buffer = Buffer.from(pending.lines.join(""), "utf8");
		let offset = 0;
		while (offset < buffer.length) offset += writeSync(handle, buffer, offset, buffer.length - offset);
	} finally {
		closeSync(handle);
	}
}

/**
 * Land what `path` has queued, including lines appended while this waits, and close its handle: its owner is done with
 * it until it appends again. Never rejects: a failed write is the writer's to report.
 */
export async function flushDeferredWrite(path: string): Promise<void> {
	while (queued.has(path) || inFlight.has(path)) await land(path);
	await closeHandle(path);
}

function land(path: string): Promise<void> {
	const running = inFlight.get(path);
	if (running !== undefined) return running.then(() => land(path));
	const pending = queued.get(path);
	if (pending === undefined) return Promise.resolve();
	queued.delete(path);
	const write = Promise.resolve().then(async () => {
		try {
			await writePending(path, pending);
		} catch (error: unknown) {
			if (pending.kind === "append") pending.onError?.(error);
		} finally {
			if (retiredHandles.delete(path)) {
				const handle = handles.get(path);
				if (handle !== undefined) {
					handles.delete(path);
					await closeOpenHandle(handle);
				}
			}
			if (inFlight.get(path) === write) inFlight.delete(path);
			notifyAppendSlot();
		}
	});
	inFlight.set(path, write);
	return write;
}

async function landAll(): Promise<void> {
	while (queued.size > 0 || inFlight.size > 0)
		await Promise.all([...new Set([...queued.keys(), ...inFlight.keys()])].map(land));
}

/** Land every queued write, including any queued while this waits, and close every append handle. */
export async function flushDeferredWrites(): Promise<void> {
	await landAll();
	await Promise.all([...handles.keys()].map(closeHandle));
}

/**
 * Write what is still queued now, for a process that exits before the event loop turns again. A path with a write in
 * flight keeps its queue for the next flush, so its lines never land out of order.
 */
export function drainDeferredWritesSync(paths?: Iterable<string>): void {
	for (const path of paths === undefined ? [...queued.keys()] : [...paths]) {
		const pending = queued.get(path);
		if (pending === undefined || inFlight.has(path)) continue;
		queued.delete(path);
		try {
			writePendingSync(path, pending);
		} catch (error) {
			if (pending.kind === "append") pending.onError?.(error);
		}
	}
	if (queued.size === 0 && scheduled !== undefined) {
		clearImmediate(scheduled);
		scheduled = undefined;
	}
}
