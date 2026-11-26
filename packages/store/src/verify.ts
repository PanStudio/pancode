// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `verify`: every blob a tag holds or its records name, compared with its latest put record.
 */
import type { StoreBackend } from "./backend/backend.js";
import { compileBlobPattern, StoreRefusal } from "./backend/types.js";
import { hashStoreFile } from "./hash.js";
import { recordsTag } from "./paths/index.js";
import { storeBlobLockKey } from "./recorded.js";
import { appendRecord, currentState, driftOf, readBlobHistory, type StoreRecordProducer } from "./records.js";

const PAGE = 1000;

export type StoreVerifyStatus = "ok" | "changed" | "missing" | "unrecorded";

export interface StoreVerifyResult {
	tag: string;
	counts: Record<StoreVerifyStatus, number>;
	blobs: Array<{
		blob: string;
		status: StoreVerifyStatus;
		hashed: boolean;
		recordedHash?: string;
		/** The `seq` of the put record `recordUnrecorded` appended for this unrecorded blob. */
		recovered?: number;
	}>;
	interrupted: boolean;
}

export interface StoreVerifyOptions {
	pattern?: string;
	/** Also hash blobs whose record omitted the hash, and record the digest as a note. */
	hashLarge?: boolean;
	/** Append a put record, marked `recovered`, for each unrecorded blob. Never implied by anything else. */
	recordUnrecorded?: boolean;
	/** Who writes the notes and recovered records verify appends; default `standalone`. */
	actor?: StoreRecordProducer;
	/** A recovered record omits the sha256 of a blob larger than this unless `hashLarge`; default no limit. */
	hashMaxBytes?: number;
	/** How the command is invoked, for the note `hashLarge` writes; default `pancode store`. */
	command?: string;
	signal?: AbortSignal;
}

export async function allStoreBlobs(backend: StoreBackend, tag: string, pattern?: string): Promise<string[]> {
	const names: string[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const page = await backend.listBlobs(tag, { ...(pattern !== undefined ? { pattern } : {}), offset, limit: PAGE });
		names.push(...page.names);
		if (!page.hasMore) return names;
	}
}

/** Blob names that have at least one record, read from the records tag's names alone. */
export async function recordedStoreBlobNames(backend: StoreBackend, tag: string): Promise<Set<string>> {
	const names = new Set<string>();
	if (!(await backend.tagExists(recordsTag(tag)))) return names;
	for (const name of await allStoreBlobs(backend, recordsTag(tag))) {
		const match = /^(.+)#\d{8}$/u.exec(name);
		if (match?.[1] !== undefined) names.add(match[1]);
	}
	return names;
}

/**
 * Record an unrecorded blob from its bytes as they are now. Under the blob's lock, so a put that recorded it
 * meanwhile wins and nothing is appended; returns the new record's `seq`, or null.
 */
async function recoverRecord(
	backend: StoreBackend,
	tag: string,
	blob: string,
	options: StoreVerifyOptions,
): Promise<number | null> {
	return backend.withLock(storeBlobLockKey(tag, blob), async () => {
		const info = await backend.statBlob(tag, blob);
		const { put } = currentState((await readBlobHistory(backend, tag, blob)).records);
		if (info === null || driftOf(put, info) !== "unrecorded") return null;
		const hashable = options.hashLarge === true || info.bytes <= (options.hashMaxBytes ?? Number.POSITIVE_INFINITY);
		const sha256 = hashable
			? await hashStoreFile((await backend.getBlobAsPath(tag, blob, options.signal)).path, options.signal)
			: null;
		const record = await appendRecord(backend, {
			kind: "put",
			tag,
			blob,
			identity: {
				bytes: info.bytes,
				modifiedMs: info.modifiedMs,
				sha256,
				...(sha256 === null ? { hashOmitted: "too-large" as const } : {}),
			},
			producedBy: options.actor ?? { actor: "standalone" },
			recovered: true,
		});
		return record.seq;
	});
}

/**
 * Compare every blob the tag holds or its records name with its latest `put` record: size and mtime, then
 * sha256 when the record holds one. A blob whose last record is a `remove` and whose bytes are gone is not
 * reported.
 */
export async function verifyStoreTag(
	backend: StoreBackend,
	tag: string,
	options: StoreVerifyOptions = {},
): Promise<StoreVerifyResult> {
	if (!(await backend.tagExists(tag))) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
	const present = await allStoreBlobs(backend, tag, options.pattern);
	const matcher = options.pattern !== undefined ? compileBlobPattern(options.pattern) : null;
	const recorded = [...(await recordedStoreBlobNames(backend, tag))].filter((name) => matcher?.test(name) ?? true);
	const names = [...new Set([...present, ...recorded])].sort();
	const result: StoreVerifyResult = {
		tag,
		counts: { ok: 0, changed: 0, missing: 0, unrecorded: 0 },
		blobs: [],
		interrupted: false,
	};
	for (const blob of names) {
		if (options.signal?.aborted) {
			result.interrupted = true;
			break;
		}
		const info = await backend.statBlob(tag, blob);
		const { put } = currentState((await readBlobHistory(backend, tag, blob)).records);
		const drift = driftOf(put, info);
		if (drift === "none" && info === null) continue;
		let status: StoreVerifyStatus = drift === "none" ? "ok" : drift;
		let hashed = false;
		let recordedHash: string | undefined;
		let recovered: number | null = null;
		try {
			if (status === "unrecorded" && options.recordUnrecorded === true) {
				recovered = await recoverRecord(backend, tag, blob, options);
			}
			if (status === "ok" && info !== null && put !== null) {
				const expected = put.identity?.sha256 ?? null;
				if (expected !== null || options.hashLarge === true) {
					const digest = await hashStoreFile((await backend.getBlobAsPath(tag, blob, options.signal)).path, options.signal);
					hashed = true;
					if (expected !== null) {
						if (digest !== expected) status = "changed";
					} else {
						await appendRecord(backend, {
							kind: "note",
							tag,
							blob,
							identity: { bytes: info.bytes, modifiedMs: info.modifiedMs, sha256: digest },
							producedBy: options.actor ?? { actor: "standalone" },
							note: `sha256 ${digest} (${options.command ?? "pancode store"} verify --hash-large)`,
						});
						recordedHash = digest;
					}
				}
			}
		} catch (error) {
			if (options.signal?.aborted) {
				result.interrupted = true;
				break;
			}
			throw error;
		}
		result.counts[status] += 1;
		result.blobs.push({
			blob,
			status,
			hashed,
			...(recordedHash !== undefined ? { recordedHash } : {}),
			...(recovered !== null ? { recovered } : {}),
		});
	}
	return result;
}
