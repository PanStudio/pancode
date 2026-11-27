// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The recorded put and remove: the one sequence every host uses to change a blob. Each holds the blob's lock
 * across the change and its record, so no other writer's change lands between them.
 */
import type { StoreBackend } from "./backend/backend.js";
import { type StoreBlobPut, type StorePutMode, StoreRefusal } from "./backend/types.js";
import {
	appendRecord,
	currentState,
	readBlobHistory,
	type StoreRecord,
	type StoreRecordBody,
	type StoreRecordProducer,
} from "./records.js";

/** The lock a blob's put, remove and recovery take; hosts that lock a blob themselves use the same key. */
export function storeBlobLockKey(tag: string, blob: string): string {
	return `blob\0${tag}\0${blob}`;
}

/** What a host adds to a put record. Unset identity and receipt come from what the put observed. */
export type StorePutRecordFields = Partial<
	Pick<StoreRecordBody, "identity" | "receipt" | "source" | "generatedBy" | "used" | "note" | "labels">
>;

export interface RecordedPutOptions {
	tag: string;
	blob: string;
	/** The file whose bytes are stored. */
	source: string;
	actor: StoreRecordProducer;
	/** Provenance, computed by the host from what the put stored. */
	record?: StorePutRecordFields | ((stored: StoreBlobPut) => StorePutRecordFields | Promise<StorePutRecordFields>);
	/** `link` shares the source's blocks by a reflink where the file system can, else copies; default `copy`. */
	mode?: StorePutMode;
	/** The tool was admitted to create this blob, not to replace it. */
	ifAbsent?: boolean;
	signal?: AbortSignal;
}

/**
 * `recorded: false` means the bytes are in the store and their record is not: `stat` reports the blob's drift
 * as `unrecorded`, and `verify --record-unrecorded` can record it later.
 */
export type RecordedPutResult = { stored: true; put: StoreBlobPut; replaced: boolean } & (
	| { recorded: true; record: StoreRecord }
	| { recorded: false; reason: string }
);

export type RecordedRemoveResult = { removed: true } & (
	| { recorded: true; record: StoreRecord }
	| { recorded: false; reason: string }
);

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Store `source` as `tag:blob` and append its put record. A failure before the bytes commit throws; a failure
 * after returns `recorded: false` with the reason and never throws.
 */
export async function recordedPut(backend: StoreBackend, options: RecordedPutOptions): Promise<RecordedPutResult> {
	const { tag, blob } = options;
	return backend.withLock(storeBlobLockKey(tag, blob), async (): Promise<RecordedPutResult> => {
		const replaced = (await backend.statBlob(tag, blob)) !== null;
		if (replaced && options.ifAbsent)
			throw new StoreRefusal("exists", `${tag}:${blob} exists; submit the put again to have the replacement admitted.`);
		const put = await backend.putBlobFromFile(tag, blob, options.source, options.signal, {
			...(options.mode !== undefined ? { mode: options.mode } : {}),
			...(options.ifAbsent ? { ifAbsent: true } : {}),
		});
		// From here the bytes are in the store. The record names what this put streamed; the blob is never
		// re-read, as a later writer may own its name by then.
		try {
			const fields = typeof options.record === "function" ? await options.record(put) : (options.record ?? {});
			const body: StoreRecordBody = {
				kind: "put",
				tag,
				blob,
				identity: fields.identity ?? { bytes: put.bytes, modifiedMs: put.modifiedMs, sha256: put.sha256 },
				receipt: fields.receipt ?? { backend: backend.kind, key: put.key, version: put.version },
				...(fields.source !== undefined ? { source: fields.source } : {}),
				producedBy: options.actor,
				...(fields.generatedBy !== undefined ? { generatedBy: fields.generatedBy } : {}),
				...(fields.used !== undefined ? { used: fields.used } : {}),
				...(fields.note !== undefined ? { note: fields.note } : {}),
				...(fields.labels !== undefined ? { labels: fields.labels } : {}),
			};
			return { stored: true, put, replaced, recorded: true, record: await appendRecord(backend, body) };
		} catch (error) {
			return { stored: true, put, replaced, recorded: false, reason: reasonOf(error) };
		}
	});
}

/**
 * Delete `tag:blob` and append its remove record, which carries the identity of the last put. A missing blob
 * refuses `not-found`; a record that fails after the delete returns `recorded: false`. A crash between the two
 * leaves the last put record over a missing blob, which `stat` reports as drift `missing`.
 */
export async function recordedRemove(
	backend: StoreBackend,
	options: { tag: string; blob: string; actor: StoreRecordProducer },
): Promise<RecordedRemoveResult> {
	const { tag, blob } = options;
	return backend.withLock(storeBlobLockKey(tag, blob), async (): Promise<RecordedRemoveResult> => {
		const last = currentState((await readBlobHistory(backend, tag, blob)).records).put;
		if (!(await backend.delBlob(tag, blob))) {
			throw new StoreRefusal("not-found", `${tag}:${blob} is not in the store.`);
		}
		try {
			const record = await appendRecord(backend, {
				kind: "remove",
				tag,
				blob,
				producedBy: options.actor,
				...(last?.identity !== undefined ? { identity: last.identity } : {}),
			});
			return { removed: true, recorded: true, record };
		} catch (error) {
			return { removed: true, recorded: false, reason: reasonOf(error) };
		}
	});
}
