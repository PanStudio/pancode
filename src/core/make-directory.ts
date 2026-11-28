// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { mkdirSync, statSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

/*
 * `mkdir -p` that always returns. Node's own recursive mkdir before 26.12 (nodejs/node#66340) retries ENOENT
 * without a bound: below a directory that was removed while still reachable,
 * such as a bind-mount root whose source is gone or a deleted cwd, the parent answers EEXIST and the child ENOENT
 * forever. The sync form then never returns to the event loop, so SIGTERM and SIGHUP are never handled. Here each
 * level is attempted at most twice, the second time after its parent exists, and a second ENOENT is thrown.
 */

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

function isDirectorySync(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** True once `path` is a directory; false on a first ENOENT when its parent may still be created. */
function attemptSync(path: string, mode: number | undefined, parentMayHelp: boolean): boolean {
	try {
		mkdirSync(path, { mode });
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			if (parentMayHelp) return false;
		} else if (isDirectorySync(path)) return true;
		throw error;
	}
}

async function attempt(path: string, mode: number | undefined, parentMayHelp: boolean): Promise<boolean> {
	try {
		await mkdir(path, { mode });
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			if (parentMayHelp) return false;
		} else if (await isDirectory(path)) return true;
		throw error;
	}
}

/** `mkdirSync(path, { recursive: true, mode })` without Node's unbounded ENOENT retry. */
export function makeDirectorySync(path: string, mode?: number): void {
	const parent = dirname(path);
	if (attemptSync(path, mode, parent !== path)) return;
	makeDirectorySync(parent, mode);
	attemptSync(path, mode, false);
}

/** `mkdir(path, { recursive: true, mode })` without Node's unbounded ENOENT retry. */
export async function makeDirectory(path: string, mode?: number): Promise<void> {
	const parent = dirname(path);
	if (await attempt(path, mode, parent !== path)) return;
	await makeDirectory(parent, mode);
	await attempt(path, mode, false);
}
