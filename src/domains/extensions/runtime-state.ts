// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionKeyValueHost, KeyValueEntry, KeyValueTable } from "@pancode/sdk/pack";
import { checkKeyValueLimits, createKeyValueHost } from "@pancode/sdk/pack";
import { safeResourceWrite } from "../../core/safe-resource-write.js";

type Entry = KeyValueEntry;
type Table = KeyValueTable;

export interface ExtensionDataPaths {
	/** The directory the manifest's `store` write root names. */
	storeDir: string;
	storeFile: string;
	/** Null when no session exists, as in `extensions run`; state is then held in memory only. */
	stateFile: string | null;
}

export function extensionDataPaths(
	stateDir: string,
	extensionId: string,
	sessionId: string | null,
): ExtensionDataPaths {
	const root = path.join(stateDir, "extensions", extensionId);
	return {
		storeDir: path.join(root, "files"),
		storeFile: path.join(root, "store.json"),
		stateFile: sessionId === null ? null : path.join(root, "sessions", `${encodeURIComponent(sessionId)}.json`),
	};
}

function read(file: string): Table {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		// Absent until the first write.
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		const entries = (parsed as { entries?: unknown } | null)?.entries;
		if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return {};
		const table: Table = {};
		for (const [key, entry] of Object.entries(entries as Record<string, Partial<Entry>>))
			if (Number.isInteger(entry?.version)) table[key] = { value: entry.value, version: entry.version as number };
		return table;
	} catch {
		// A corrupt file reads as empty; the next write keeps its bytes beside the replacement.
		return {};
	}
}

function write(file: string, table: Table): void {
	safeResourceWrite(file, JSON.stringify({ version: 1, entries: table }), { backup: true });
}

/**
 * The values a runtime keeps outside its own process. Session state is this
 * process's alone, so it is read once and written through. The store is
 * shared by every session of the extension on the machine, so it is read
 * again before each use; `ifVersion` is how two sessions avoid overwriting
 * each other, and without it the last writer wins.
 */
export function createExtensionKeyValueHost(
	paths: Pick<ExtensionDataPaths, "storeFile" | "stateFile">,
): ExtensionKeyValueHost {
	let state: Table = paths.stateFile === null ? {} : read(paths.stateFile);
	const table = (scope: "state" | "store"): Table => (scope === "state" ? state : read(paths.storeFile));
	const commit = (scope: "state" | "store", next: Table): void => {
		checkKeyValueLimits(scope, next);
		if (scope === "store") write(paths.storeFile, next);
		else {
			state = next;
			if (paths.stateFile !== null) write(paths.stateFile, next);
		}
	};
	return createKeyValueHost(table, commit);
}
