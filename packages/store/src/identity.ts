// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The two identities a store shared across hosts rests on.
 *
 * A project id is a name the project's tracked settings give it. Its key
 * replaces the path key, so checkouts at different real paths on different
 * hosts reach one project directory. Without an id the key stays the path key.
 * Its rule and key live with the other path rules in `paths/`.
 *
 * A root id is a random UUID kept in `<root>/root.json`. Mount paths may differ
 * between hosts; the id says two paths are the same root.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { StoreRefusal } from "./backend/types.js";

export const STORE_ROOT_FILE = "root.json";

interface RootFile {
	v: 1;
	id: string;
	createdAt: string;
}

const ROOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

function parseRootFile(file: string, text: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new StoreRefusal("io", `${file} is not valid JSON.`);
	}
	const record = parsed as Partial<RootFile> | null;
	if (record === null || typeof record !== "object" || Array.isArray(record))
		throw new StoreRefusal("io", `${file} is not a JSON object.`);
	if (record.v !== 1) throw new StoreRefusal("io", `${file} has version ${String(record.v)}; this store reads 1.`);
	if (typeof record.id !== "string" || !ROOT_ID.test(record.id))
		throw new StoreRefusal("io", `${file} has no valid id.`);
	return record.id;
}

/** The id in `<rootPath>/root.json`; null when the file is absent. Refuses a malformed file or another version. */
export async function readStoreRootId(rootPath: string): Promise<string | null> {
	const file = path.join(rootPath, STORE_ROOT_FILE);
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR") return null;
		throw error;
	}
	return parseRootFile(file, text);
}

/**
 * The root's id, creating `root.json` when it is absent. The file is written
 * under a temporary name beside it and `link()`ed into place, so a reader
 * never sees it partial and, of two creators, the one that loses the link
 * reads and answers the winner's id.
 */
export async function ensureStoreRootId(rootPath: string): Promise<string> {
	const existing = await readStoreRootId(rootPath);
	if (existing !== null) return existing;
	await mkdir(rootPath, { recursive: true, mode: 0o700 });
	const file = path.join(rootPath, STORE_ROOT_FILE);
	const temp = path.join(rootPath, `.${STORE_ROOT_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	const body: RootFile = { v: 1, id: randomUUID(), createdAt: new Date().toISOString() };
	try {
		const handle = await open(temp, "wx", 0o644);
		try {
			await handle.writeFile(`${JSON.stringify(body)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temp, file);
			return body.id;
		} catch (error) {
			if (errnoOf(error) !== "EEXIST") throw error;
		}
	} finally {
		await rm(temp, { force: true });
	}
	const winner = await readStoreRootId(rootPath);
	if (winner === null) throw new StoreRefusal("unavailable", `${file} vanished while it was being created.`);
	return winner;
}
