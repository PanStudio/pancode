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

import { closeSync, constants, openSync, writeSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { safeResourceWrite, safeResourceWriteAsync } from "../../core/safe-resource-write.js";

const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
const FILE_MODE = 0o600;
/** Append handles held open at once; past this, the least recently opened idle one closes. */
const MAX_OPEN_APPENDS = 64;

type Pending =
	| { kind: "append"; lines: string[]; onError?: (error: unknown) => void }
	| { kind: "record"; contents: string };

const queued = new Map<string, Pending>();
const inFlight = new Map<string, Promise<void>>();
const handles = new Map<string, FileHandle>();
let scheduled: NodeJS.Immediate | undefined;
let exitHooked = false;

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
export function deferAppend(path: string, text: string, onError?: (error: unknown) => void): void {
	const pending = queued.get(path);
	if (pending?.kind === "append") {
		pending.lines.push(text);
		if (onError !== undefined) pending.onError = onError;
	} else queued.set(path, { kind: "append", lines: [text], ...(onError !== undefined ? { onError } : {}) });
	schedule();
}

/** Queue `contents` as the whole of `path`, replacing any value not yet written. */
export function deferRecord(path: string, contents: string): void {
	queued.set(path, { kind: "record", contents });
	schedule();
}

/** True while `path` has bytes queued or a write in flight. */
export function deferredWritePending(path: string): boolean {
	return queued.has(path) || inFlight.has(path);
}

/** Forget what `path` still has queued, for a file that is being removed. */
export function dropDeferredWrite(path: string): void {
	queued.delete(path);
	void closeHandle(path);
}

/** Close `path`'s append handle once no write to it is in flight. */
function closeHandle(path: string): Promise<void> {
	const running = inFlight.get(path);
	if (running !== undefined) return running.then(() => closeHandle(path));
	const handle = handles.get(path);
	if (handle === undefined) return Promise.resolve();
	handles.delete(path);
	return handle.close().catch(() => undefined);
}

async function appendHandle(path: string): Promise<FileHandle> {
	const held = handles.get(path);
	if (held !== undefined) return held;
	const handle = await open(path, APPEND_FLAGS, FILE_MODE);
	handles.set(path, handle);
	if (handles.size > MAX_OPEN_APPENDS) {
		const idle = [...handles.keys()].find((candidate) => candidate !== path && !inFlight.has(candidate));
		if (idle !== undefined) void closeHandle(idle);
	}
	return handle;
}

async function writePending(path: string, pending: Pending): Promise<void> {
	if (pending.kind === "record") {
		await safeResourceWriteAsync(path, pending.contents, { encoding: "utf8", mode: FILE_MODE });
		return;
	}
	const handle = await appendHandle(path);
	try {
		await handle.writeFile(pending.lines.join(""));
	} catch (error) {
		handles.delete(path);
		await handle.close().catch(() => undefined);
		throw error;
	}
}

function writePendingSync(path: string, pending: Pending): void {
	if (pending.kind === "record") {
		safeResourceWrite(path, pending.contents, { encoding: "utf8", mode: FILE_MODE });
		return;
	}
	const handle = openSync(path, APPEND_FLAGS, FILE_MODE);
	try {
		writeSync(handle, pending.lines.join(""));
	} finally {
		closeSync(handle);
	}
}

/**
 * Land what `path` has queued, after any write already in flight, and close its handle: its owner is done with it
 * until it appends again. Never rejects: a failed write is the writer's to report.
 */
export function flushDeferredWrite(path: string): Promise<void> {
	return land(path).then(() => closeHandle(path));
}

function land(path: string): Promise<void> {
	const running = inFlight.get(path);
	if (running !== undefined) return running.then(() => land(path));
	const pending = queued.get(path);
	if (pending === undefined) return Promise.resolve();
	queued.delete(path);
	const write: Promise<void> = writePending(path, pending)
		.catch((error: unknown) => {
			if (pending.kind === "append") pending.onError?.(error);
		})
		.finally(() => {
			if (inFlight.get(path) === write) inFlight.delete(path);
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
