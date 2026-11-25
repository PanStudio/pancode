// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type {
	StoreBackendFacts,
	StoreBackendKind,
	StoreBlobPut,
	StoreBlobStat,
	StorePutMode,
	StoreTagClass,
	StoreUsage,
} from "./types.js";

/**
 * The store's backend contract. Every method throws `StoreRefusal` for
 * expected failures and nothing else.
 */
export interface StoreBackend {
	readonly kind: StoreBackendKind;
	facts(): Promise<StoreBackendFacts>;
	// Tags.
	/**
	 * `options.class` is the class of a tag this call may create: a backend with several roots places a new
	 * tag by it, once. A tag that already exists stays where it is whatever class is passed.
	 */
	getOrCreateTag(tag: string, options?: { class?: StoreTagClass }): Promise<{ created: boolean }>;
	tagExists(tag: string): Promise<boolean>;
	/** This project's tags, records tags included. */
	listTags(): Promise<string[]>;
	delTag(tag: string): Promise<void>;
	/** Key at most 255 bytes, value at most 64 KiB. */
	setTagXattr(tag: string, key: string, value: string): Promise<void>;
	getTagXattrs(tag: string): Promise<Record<string, string>>;
	// Whole-object data path.
	/** Never re-reads the blob's name to describe the put: a concurrent put may own it by then. */
	putBlobFromFile(
		tag: string,
		blob: string,
		source: string,
		signal?: AbortSignal,
		options?: { mode?: StorePutMode },
	): Promise<StoreBlobPut>;
	/** A read-only local copy whose writes cannot change the stored blob. `copied` is true when the backend materialized bytes for it. */
	getBlobAsPath(tag: string, blob: string, signal?: AbortSignal): Promise<{ path: string; copied: boolean }>;
	// Small records.
	putRecordIfAbsent(tag: string, blob: string, data: Uint8Array): Promise<"written" | "exists">;
	getRecord(tag: string, blob: string): Promise<Uint8Array | null>;
	// Listing and removal.
	statBlob(tag: string, blob: string): Promise<StoreBlobStat | null>;
	/**
	 * `pattern` is a regular expression matched against the whole blob name; names come back sorted.
	 * `prefix` is a literal start every name must have, so a backend can skip the parts of the tag no such name lives in.
	 */
	listBlobs(
		tag: string,
		q: { pattern?: string; prefix?: string; offset: number; limit: number },
	): Promise<{ names: string[]; hasMore: boolean }>;
	delBlob(tag: string, blob: string): Promise<boolean>;
	/**
	 * Bytes and blob counts per tag and per root, found by walking the store: every tag, or the one named.
	 * Records tags are counted as the tags they are.
	 */
	usage(tag?: string): Promise<StoreUsage>;
	/**
	 * Run `fn` holding this project's lock named `key`, the same lock every host of this store takes for that
	 * key. `recordedPut` and `recordedRemove` hold a blob's lock across the change and its record.
	 */
	withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
	/** The blob whose bytes a resolved local path (a `getBlobAsPath` result) holds, else null; provenance names inputs by it. */
	blobRefOfPath(realPath: string): Promise<{ tag: string; blob: string } | null>;
}
