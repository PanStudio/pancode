// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The store's host-local index (N8): `<cache>/store/index/<projectKey>.db`, a node:sqlite cache of what listing and
 * lineage display read, so they need not read every record file again. It is only a cache. Before every answer
 * each scope it answers from is fingerprinted by stat (entry count, newest mtime and ctime, and a digest of every
 * entry's stat), and a scope whose fingerprint differs from the indexed one is rescanned through the backend.
 * Nothing that writes, checks a grant or decides whether a tag or blob exists reads it, and every method answers
 * null when the index cannot answer, so the caller scans the store as it would without one; the store works with
 * the database deleted.
 */
import path from "node:path";
import type { StoreBackend } from "../backend/backend.js";
import { compileBlobPattern, StoreRefusal, type StoreRefusalReason } from "../backend/types.js";
import {
	recordsTag,
	type StoreRootSpec,
	storePlacementPath,
	storeProjectDir,
	storeTagDir,
	validateTagName,
} from "../paths/index.js";
import type { StoreRecord } from "../records.js";
import { allStoreBlobs } from "../verify.js";
import { type IndexRow, type IndexStatement, type IndexValue, runIndexStatements } from "./child.js";
import { STORE_INDEX_RACY_MS, storeFingerprint, type WatchedPath } from "./fingerprint.js";

export interface StoreIndexOptions {
	/** The backend a rescan reads; it must be the local backend over exactly these roots and this project key. */
	backend: StoreBackend;
	roots: ReadonlyArray<StoreRootSpec>;
	cacheDir: string;
	projectKey: string;
	/** How recent a change must be for a scan to be rescanned once more; tests shorten it. */
	racyMs?: number;
}

export interface StoreIndexTag {
	tag: string;
	xattrs: Record<string, string>;
	blobs: number;
	bytes: number;
}

export interface StoreIndexBlob {
	blob: string;
	bytes: number | null;
	modifiedMs: number | null;
	/** Whether any record names the blob, from every record name the tag has. */
	recorded: boolean;
}

export interface StoreIndex {
	/** `listTags` without records tags, each with its attributes and its blob count and bytes. */
	tags(): Promise<StoreIndexTag[] | null>;
	/** Every blob of `tag` whose whole name matches `pattern`, in listing order. */
	blobs(tag: string, pattern?: string): Promise<StoreIndexBlob[] | null>;
	/** `readBlobHistory(backend, tag, blob)`. */
	history(tag: string, blob: string): Promise<{ records: StoreRecord[]; skipped: number } | null>;
}

/** Where the index of one project lives: host-local, beside the store cache, never on a store root. */
export function storeIndexPath(cacheDir: string, projectKey: string): string {
	return path.join(cacheDir, "store", "index", `${projectKey}.db`);
}

const LIST_SCOPE = "list";
const RECORD_NAME = /^(.+)#(\d{8})$/u;

function tagScope(tag: string): string {
	return `tag:${tag}`;
}

interface Scope {
	scope: string;
	watched: WatchedPath[];
	/** Rescans through the backend and returns the statements that replace this scope's rows. */
	rescan: (reuse: Map<string, ReusableRecord>) => Promise<IndexStatement[]>;
	/** The tag whose record bodies a rescan may reuse. */
	recordsOf?: string;
}

interface ReusableRecord {
	bytes: number;
	mtime: number;
	body: string;
}

function refusalText(error: StoreRefusal): string {
	return JSON.stringify({ reason: error.reason, message: error.message });
}

function refusalOf(text: IndexValue | undefined): StoreRefusal | null {
	if (typeof text !== "string") return null;
	const parsed = JSON.parse(text) as { reason: StoreRefusalReason; message: string };
	return new StoreRefusal(parsed.reason, parsed.message);
}

/** A backend refusal is part of the answer, kept as the scan met it; anything else is not ours to keep. */
async function attempt<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; refusal: null } | { value: null; refusal: string }> {
	try {
		return { value: await fn(), refusal: null };
	} catch (error) {
		if (error instanceof StoreRefusal) return { value: null, refusal: refusalText(error) };
		throw error;
	}
}

function checkTag(tag: string): void {
	const problem = validateTagName(tag);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

export function openStoreIndex(options: StoreIndexOptions): StoreIndex {
	const { backend, projectKey } = options;
	const racyMs = options.racyMs ?? STORE_INDEX_RACY_MS;
	const dbPath = storeIndexPath(options.cacheDir, projectKey);
	const projectDirs = options.roots.map((root) => storeProjectDir(root.path, projectKey));
	const placement: WatchedPath = { path: storePlacementPath(projectDirs[0] ?? ""), deep: false };

	const listScope: Scope = {
		scope: LIST_SCOPE,
		watched: [placement, ...projectDirs.map((dir) => ({ path: path.join(dir, "tags"), deep: false, child: "tag.json" }))],
		rescan: async () => {
			const rows: IndexValue[][] = [];
			for (const [ord, tag] of (await backend.listTags()).entries()) {
				const xattrs = validateTagName(tag) === null ? JSON.stringify(await backend.getTagXattrs(tag)) : null;
				rows.push([ord, tag, xattrs]);
			}
			return [{ sql: "DELETE FROM tags" }, { sql: "INSERT INTO tags (ord, tag, xattrs) VALUES (?, ?, ?)", rows }];
		},
	};

	function scopeOfTag(tag: string): Scope {
		return {
			scope: tagScope(tag),
			recordsOf: tag,
			watched: [
				placement,
				...projectDirs.flatMap((dir) => [
					{ path: storeTagDir(dir, tag), deep: true },
					{ path: storeTagDir(dir, recordsTag(tag)), deep: true },
				]),
			],
			rescan: async (reuse) => {
				const blobRows: IndexValue[][] = [];
				const { refusal: blobsRefusal } = await attempt(async () => {
					for (const [ord, name] of (await allStoreBlobs(backend, tag)).entries()) {
						const stat = await backend.statBlob(tag, name);
						blobRows.push([tag, ord, name, stat?.bytes ?? null, stat?.modifiedMs ?? null]);
					}
				});
				if (blobsRefusal !== null) blobRows.length = 0;
				const recordRows: IndexValue[][] = [];
				const records = recordsTag(tag);
				const { refusal: recordsRefusal } = await attempt(async () => {
					if (!(await backend.tagExists(records))) return;
					for (const name of await allStoreBlobs(backend, records)) {
						const parsed = RECORD_NAME.exec(name);
						const stat = (await attempt(() => backend.statBlob(records, name))).value;
						const prior = reuse.get(name);
						// Records are write-once: the same name, size and mtime is the same record.
						const read =
							prior !== undefined && stat !== null && prior.bytes === stat.bytes && prior.mtime === stat.modifiedMs
								? { value: prior.body, refusal: null }
								: await attempt(async () => {
										const data = await backend.getRecord(records, name);
										return data === null ? null : Buffer.from(data).toString("utf8");
									});
						recordRows.push([
							tag,
							name,
							parsed?.[1] ?? null,
							parsed?.[2] !== undefined ? Number(parsed[2]) : null,
							stat?.bytes ?? null,
							stat?.modifiedMs ?? null,
							read.value,
							read.refusal,
						]);
					}
				});
				if (recordsRefusal !== null) recordRows.length = 0;
				return [
					{ sql: "DELETE FROM blobs WHERE tag = ?", params: [tag] },
					{ sql: "DELETE FROM records WHERE tag = ?", params: [tag] },
					{ sql: "INSERT INTO blobs (tag, ord, name, bytes, mtime) VALUES (?, ?, ?, ?, ?)", rows: blobRows },
					{
						sql: "INSERT INTO records (tag, name, blob, seq, bytes, mtime, body, refusal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
						rows: recordRows,
					},
					{
						sql: "UPDATE scopes SET blobs_refusal = ?, records_refusal = ? WHERE scope = ?",
						params: [blobsRefusal, recordsRefusal, tagScope(tag)],
					},
				];
			},
		};
	}

	/**
	 * The rows of `queries`, answered from scopes that are fresh: one child run when every scope's fingerprint
	 * matches, else a rescan of the stale ones written in the same transaction the queries then read.
	 */
	async function answer(scopes: Scope[], queries: IndexStatement[]): Promise<Array<IndexRow[] | null> | null> {
		const fingerprints = new Map<string, { value: string; trusted: boolean }>();
		for (const scope of scopes) {
			const startMs = Date.now();
			const print = await storeFingerprint(scope.watched);
			fingerprints.set(scope.scope, { value: print.value, trusted: print.newestMs < startMs - racyMs });
		}
		const first = await runIndexStatements(
			dbPath,
			[{ sql: "SELECT scope, fingerprint, trusted FROM scopes", all: true }, ...queries],
			{ write: false },
		);
		if (first === null) return null;
		const stored = new Map((first[0] ?? []).map((row) => [row.scope, row]));
		const stale = scopes.filter((scope) => {
			const row = stored.get(scope.scope);
			return row === undefined || row.trusted !== 1 || row.fingerprint !== fingerprints.get(scope.scope)?.value;
		});
		if (stale.length === 0) return first.slice(1);
		const withRecords = stale.filter((scope) => scope.recordsOf !== undefined && stored.has(scope.scope));
		const reusable = new Map<string, Map<string, ReusableRecord>>();
		if (withRecords.length > 0) {
			const prior = await runIndexStatements(
				dbPath,
				withRecords.map((scope) => ({
					sql: "SELECT name, bytes, mtime, body FROM records WHERE tag = ? AND refusal IS NULL AND body IS NOT NULL AND bytes IS NOT NULL",
					params: [scope.recordsOf as string],
					all: true,
				})),
				{ write: false },
			);
			withRecords.forEach((scope, index) => {
				const rows = prior?.[index] ?? [];
				reusable.set(
					scope.scope,
					new Map(
						rows.map((row) => [
							row.name as string,
							{ bytes: row.bytes as number, mtime: row.mtime as number, body: row.body as string },
						]),
					),
				);
			});
		}
		const writes: IndexStatement[] = [];
		for (const scope of stale) {
			const print = fingerprints.get(scope.scope) as { value: string; trusted: boolean };
			// The fingerprint was taken before the rescan, so a change during it shows as a difference next time.
			writes.push({
				sql: "INSERT OR REPLACE INTO scopes (scope, fingerprint, trusted) VALUES (?, ?, ?)",
				params: [scope.scope, print.value, print.trusted ? 1 : 0],
			});
			writes.push(...(await scope.rescan(reusable.get(scope.scope) ?? new Map())));
		}
		const written = await runIndexStatements(dbPath, [...writes, ...queries], { write: true });
		return written === null ? null : written.slice(writes.length);
	}

	return {
		async tags() {
			const listed = await answer([listScope], [{ sql: "SELECT tag, xattrs FROM tags ORDER BY ord", all: true }]);
			if (listed === null) return null;
			const tags = (listed[0] ?? []).filter((row) => validateTagName(row.tag as string) === null);
			const names = tags.map((row) => row.tag as string);
			if (names.length === 0) return [];
			const totals = await answer(
				names.map(scopeOfTag),
				names.flatMap((tag) => [
					{ sql: "SELECT blobs_refusal FROM scopes WHERE scope = ?", params: [tagScope(tag)], all: true },
					{
						sql: "SELECT count(*) AS blobs, coalesce(sum(bytes), 0) AS bytes FROM blobs WHERE tag = ?",
						params: [tag],
						all: true,
					},
				]),
			);
			if (totals === null) return null;
			return tags.map((row, index) => {
				const refusal = refusalOf(totals[index * 2]?.[0]?.blobs_refusal);
				if (refusal !== null) throw refusal;
				const sums = totals[index * 2 + 1]?.[0];
				return {
					tag: row.tag as string,
					xattrs: JSON.parse((row.xattrs as string | null) ?? "{}") as Record<string, string>,
					blobs: Number(sums?.blobs ?? 0),
					bytes: Number(sums?.bytes ?? 0),
				};
			});
		},

		async blobs(tag, pattern) {
			checkTag(tag);
			const rows = await answer(
				[scopeOfTag(tag)],
				[
					{ sql: "SELECT blobs_refusal, records_refusal FROM scopes WHERE scope = ?", params: [tagScope(tag)], all: true },
					{ sql: "SELECT name, bytes, mtime FROM blobs WHERE tag = ? ORDER BY ord", params: [tag], all: true },
					{ sql: "SELECT DISTINCT blob FROM records WHERE tag = ? AND blob IS NOT NULL", params: [tag], all: true },
				],
			);
			if (rows === null) return null;
			const scope = rows[0]?.[0];
			const blobsRefusal = refusalOf(scope?.blobs_refusal);
			if (blobsRefusal !== null) throw blobsRefusal;
			const matcher = pattern !== undefined ? compileBlobPattern(pattern) : null;
			const recordsRefusal = refusalOf(scope?.records_refusal);
			if (recordsRefusal !== null) throw recordsRefusal;
			const recorded = new Set((rows[2] ?? []).map((row) => row.blob as string));
			return (rows[1] ?? [])
				.filter((row) => matcher === null || matcher.test(row.name as string))
				.map((row) => ({
					blob: row.name as string,
					bytes: row.bytes as number | null,
					modifiedMs: row.mtime as number | null,
					recorded: recorded.has(row.name as string),
				}));
		},

		async history(tag, blob) {
			checkTag(tag);
			const rows = await answer(
				[scopeOfTag(tag)],
				[
					{ sql: "SELECT records_refusal FROM scopes WHERE scope = ?", params: [tagScope(tag)], all: true },
					{
						sql: "SELECT body, refusal FROM records WHERE tag = ? AND blob = ? ORDER BY seq DESC",
						params: [tag, blob],
						all: true,
					},
				],
			);
			if (rows === null) return null;
			const refusal = refusalOf(rows[0]?.[0]?.records_refusal);
			if (refusal !== null) throw refusal;
			// The same walk as readBlobHistory: newest first, a vanished record left out, an unparseable one counted.
			const records: StoreRecord[] = [];
			let skipped = 0;
			for (const row of rows[1] ?? []) {
				const readRefusal = refusalOf(row.refusal);
				if (readRefusal !== null) throw readRefusal;
				if (typeof row.body !== "string") continue;
				try {
					const parsed = JSON.parse(row.body) as Partial<StoreRecord> | null;
					if (parsed?.v === 1 && typeof parsed.seq === "number" && typeof parsed.kind === "string") {
						records.push(parsed as StoreRecord);
					} else {
						skipped++;
					}
				} catch {
					skipped++;
				}
			}
			records.sort((a, b) => a.seq - b.seq);
			return { records, skipped };
		},
	};
}
