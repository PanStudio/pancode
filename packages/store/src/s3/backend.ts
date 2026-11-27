// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The s3 backend: one bucket of an S3-compatible object store, laid out like a local root under a key prefix,
 * so the same project key names the same store from every host. A tag is a key prefix holding `tag.json`, a blob
 * an object under its `blobs/`. Creation and records are conditional PUTs (`If-None-Match: *`), a tag attribute
 * change a read and a PUT with `If-Match`, so no two writers lose each other's change. A lock is a lease object
 * its holder renews; a lease not renewed for 60 seconds by the store's own clock is taken over. A writer renews
 * the leases it holds before each change it makes under them, and a renewal that finds a lease taken over aborts
 * its upload, so a writer that stalled past its lease refuses instead of overwriting the next holder's change.
 *
 * Limits: a blob is one PUT of at most 5 GiB, a put copies (no reflink), blobs carry no versions and there is no
 * free-space figure.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { StoreBackend } from "../backend/backend.js";
import { registerStoreBackend } from "../backend/registry.js";
import {
	compileBlobPattern,
	type StoreBackendFacts,
	type StoreBlobPut,
	type StoreBlobStat,
	type StoreLockInfo,
	StoreRefusal,
	type StoreUsage,
} from "../backend/types.js";
import { writeCacheCopy } from "../cache-copy.js";
import { hashStoreFile } from "../hash.js";
import { fencedSignal, fenceHeldLeases, STORE_LEASE_EXPIRY_MS, withLease } from "../lease.js";
import { storeLockId } from "../lock.js";
import {
	decodeTagSegment,
	encodeTagSegment,
	isRecordsTag,
	STORE_DEFAULT_ROOT_NAME,
	storeCacheDir,
	validateBlobName,
	validateS3Prefix,
	validateTagName,
} from "../paths/index.js";
import { S3Client, type S3ClientOptions } from "./client.js";

export interface S3StoreOptions extends S3ClientOptions {
	/** Prepended to every key; empty, or ending in `/`. */
	prefix: string;
	/** The cache root: `getBlobAsPath` downloads live under `<cacheDir>/store/<projectKey>`. */
	cacheDir: string;
	/** `storeProjectKey` of the project's main checkout, or `storeProjectKeyForId` of its project id. */
	projectKey: string;
	/** The project id its tracked settings give it, written to `project.json`; absent when it has none. */
	projectId?: string;
	/** The project's main checkout, written to `project.json` when the store first creates it. */
	projectRoot: string;
}

/** The largest object one S3 PUT stores. */
export const S3_PUT_MAX_BYTES = 5 * 1024 ** 3;
const LOCK_WAIT_MS = 30 * 1000;
const LOCK_POLL_MS = 200;
/** How often a write racing another on one key (409, 503) is retried before it refuses. */
const RACE_RETRIES = 20;
const PARALLEL_REQUESTS = 8;
const XATTR_KEY_MAX_BYTES = 255;
const XATTR_VALUE_MAX_BYTES = 64 * 1024;
const RECORD_MAX_BYTES = 64 * 1024;
const MTIME_HEADER = "x-amz-meta-pancode-mtime";
const LOCK_NAME = /^([0-9a-f]{32})\.lock$/u;
const RECORD_NAME = /^(.+)#\d{8}$/u;

interface TagFile {
	v: 1;
	tag: string;
	xattrs: Record<string, string>;
	createdAt: string;
}

interface LeaseOwner {
	v: 1;
	key: string;
	pid: number;
	host: string;
	token: string;
	at: string;
	seq: number;
}

function checkLockId(id: string): void {
	if (!/^[0-9a-f]{32}$/u.test(id))
		throw new StoreRefusal("invalid-name", `'${id}' is not a lock id: it is 32 hex characters.`);
}

function checkTag(tag: string): void {
	const problem = validateTagName(tag, { allowRecords: true });
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

function checkBlob(tag: string, blob: string): void {
	const record = isRecordsTag(tag) ? RECORD_NAME.exec(blob) : null;
	const problem = validateBlobName(record?.[1] ?? blob);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof StoreRefusal) throw error;
		throw new StoreRefusal("io", messageOf(error));
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn` over `items`, at most PARALLEL_REQUESTS at a time, results in input order. */
async function mapParallel<T, R>(items: ReadonlyArray<T>, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T);
		}
	};
	const done = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL_REQUESTS, items.length) }, worker));
	for (const result of done) if (result.status === "rejected") throw result.reason;
	return results;
}

function relativePathEscapes(relative: string): boolean {
	return (
		relative === ".." || relative.startsWith("../") || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
	);
}

/** Whether S3 answered "another write to this key is in flight" or "slow down": both are retried. */
function racing(status: number): boolean {
	return status === 409 || status === 503;
}

export function createS3StoreBackend(options: S3StoreOptions): StoreBackend {
	const prefixProblem = validateS3Prefix(options.prefix);
	if (prefixProblem !== null) throw new StoreRefusal("invalid-name", prefixProblem);
	if (options.bucket.length === 0) throw new StoreRefusal("invalid-name", "The S3 bucket name is empty.");
	const client = new S3Client(options);
	const base = `${options.prefix}projects/${options.projectKey}/`;
	const cacheProjectDir = storeCacheDir(options.cacheDir, options.projectKey);
	const tagBase = (tag: string) => `${base}tags/${encodeTagSegment(tag)}/`;
	const tagKey = (tag: string) => `${tagBase(tag)}tag.json`;
	const blobsBase = (tag: string) => `${tagBase(tag)}blobs/`;
	const lockKey = (id: string) => `${base}locks/${id}.lock`;

	async function discard(response: Response): Promise<void> {
		await response.body?.cancel().catch(() => undefined);
	}

	/** HEAD the object: its response, or null when it is not there. */
	async function head(key: string, what: string): Promise<Response | null> {
		const response = await client.send("HEAD", key);
		if (response.status === 404) return null;
		if (response.status !== 200) throw await client.refusal(response, what);
		return response;
	}

	/** GET a small object: its text and ETag, or null when it is not there. */
	async function getText(key: string, what: string): Promise<{ text: string; etag: string; response: Response } | null> {
		const response = await client.send("GET", key);
		if (response.status === 404) {
			await discard(response);
			return null;
		}
		if (response.status !== 200) throw await client.refusal(response, what);
		return { text: await response.text(), etag: response.headers.get("etag") ?? "", response };
	}

	/**
	 * PUT a small object under a condition: `If-None-Match: *` to create it, `If-Match: <etag>` to replace the
	 * version read. Answers the new ETag, or null when the condition failed, including an If-Match on a key
	 * that is gone (404).
	 */
	async function putIf(
		key: string,
		data: Uint8Array,
		condition: { ifNoneMatch: true } | { ifMatch: string },
		what: string,
	): Promise<string | null> {
		const headers = "ifMatch" in condition ? { "if-match": condition.ifMatch } : { "if-none-match": "*" };
		for (let attempt = 0; ; attempt++) {
			const response = await client.send("PUT", key, { headers, body: data });
			if (response.status === 200) {
				await discard(response);
				return response.headers.get("etag") ?? "";
			}
			if (response.status === 412 || (response.status === 404 && "ifMatch" in condition)) {
				await discard(response);
				return null;
			}
			if (racing(response.status) && attempt < RACE_RETRIES) {
				await discard(response);
				await delay(50 + Math.floor(Math.random() * 100));
				continue;
			}
			throw await client.refusal(response, what);
		}
	}

	async function del(key: string, what: string, headers?: Record<string, string>): Promise<void> {
		const response = await client.send("DELETE", key, headers !== undefined ? { headers } : {});
		if (response.status !== 204 && response.status !== 200 && response.status !== 404)
			throw await client.refusal(response, what);
		await discard(response);
	}

	/** Every object under `prefix`, in key order. */
	async function listAll(prefix: string): Promise<Array<{ key: string; bytes: number }>> {
		const objects: Array<{ key: string; bytes: number }> = [];
		let next: string | null = null;
		do {
			const page = await client.list(prefix, { next });
			objects.push(...page.objects);
			next = page.next;
		} while (next !== null);
		return objects;
	}

	async function readTag(tag: string): Promise<{ file: TagFile; etag: string } | null> {
		checkTag(tag);
		const got = await getText(tagKey(tag), `tag ${tag}`);
		if (got === null) return null;
		try {
			return { file: JSON.parse(got.text) as TagFile, etag: got.etag };
		} catch (error) {
			throw new StoreRefusal(
				"io",
				`The tag file of ${tag} (${client.location(tagKey(tag))}) is unreadable: ${messageOf(error)}`,
			);
		}
	}

	async function requireTag(tag: string): Promise<void> {
		checkTag(tag);
		if ((await head(tagKey(tag), `tag ${tag}`)) === null)
			throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
	}

	async function getOrCreateTag(tag: string): Promise<{ created: boolean }> {
		checkTag(tag);
		const tagFile: TagFile = { v: 1, tag, xattrs: {}, createdAt: new Date().toISOString() };
		const made = await putIf(
			tagKey(tag),
			Buffer.from(`${JSON.stringify(tagFile)}\n`),
			{ ifNoneMatch: true },
			`creating tag ${tag}`,
		);
		if (made === null) return { created: false };
		const projectFile = {
			v: 1,
			root: options.projectRoot,
			...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
			createdAt: tagFile.createdAt,
		};
		await putIf(
			`${base}project.json`,
			Buffer.from(`${JSON.stringify(projectFile)}\n`),
			{ ifNoneMatch: true },
			"creating project.json",
		);
		return { created: true };
	}

	/** A blob cannot nest under another blob, nor take the name other blobs are stored under. */
	async function refuseNameConflict(tag: string, blob: string): Promise<void> {
		const segments = blob.split("/");
		for (let index = 1; index < segments.length; index++) {
			const prefix = segments.slice(0, index).join("/");
			if ((await head(`${blobsBase(tag)}${prefix}`, `${tag}:${prefix}`)) !== null)
				throw new StoreRefusal(
					"exists",
					`Refusing blob ${blob} in tag ${tag}: it would nest under the existing blob ${prefix}.`,
				);
		}
		const inside = (await client.list(`${blobsBase(tag)}${blob}/`)).objects[0];
		if (inside !== undefined)
			throw new StoreRefusal(
				"exists",
				`Refusing blob ${blob} in tag ${tag}: existing blobs are stored under that name (for example ${inside.key.slice(blobsBase(tag).length)}).`,
			);
	}

	function statOf(response: Response): StoreBlobStat {
		const stamp = Number(response.headers.get(MTIME_HEADER));
		const fallback = Date.parse(response.headers.get("last-modified") ?? "");
		const modifiedMs = Number.isFinite(stamp) && stamp > 0 ? stamp : Number.isFinite(fallback) ? fallback : 0;
		return { bytes: Number(response.headers.get("content-length") ?? "0"), modifiedMs, version: null };
	}

	async function blobNames(tag: string, start: string): Promise<AsyncGenerator<{ name: string; bytes: number }>> {
		const prefix = blobsBase(tag);
		return (async function* () {
			let next: string | null = null;
			do {
				const page = await client.list(`${prefix}${start}`, { next });
				for (const object of page.objects) {
					const name = object.key.slice(prefix.length);
					// A key ending in '/' is another tool's folder marker, not a blob.
					if (name.length > 0 && !name.endsWith("/")) yield { name, bytes: object.bytes };
				}
				next = page.next;
			} while (next !== null);
		})();
	}

	// Leases.

	/** The lease's state by the store's clock: the response's Date against the object's Last-Modified. */
	function leaseInfo(id: string, text: string | null, response: Response): StoreLockInfo {
		const now = Date.parse(response.headers.get("date") ?? "");
		const renewed = Date.parse(response.headers.get("last-modified") ?? "");
		const expired = Number.isFinite(now) && Number.isFinite(renewed) && now - renewed > STORE_LEASE_EXPIRY_MS;
		let owner: Partial<LeaseOwner> | null = null;
		if (text !== null) {
			try {
				owner = JSON.parse(text) as Partial<LeaseOwner>;
			} catch {
				owner = null;
			}
		}
		const file = client.location(lockKey(id));
		if (owner === null || typeof owner.key !== "string")
			return { id, file, state: "unreadable", key: null, pid: null, host: null, at: null };
		return {
			id,
			file,
			state: expired ? "dead" : "live",
			key: owner.key,
			pid: typeof owner.pid === "number" ? owner.pid : null,
			host: typeof owner.host === "string" ? owner.host : null,
			at: typeof owner.at === "string" ? owner.at : null,
		};
	}

	async function readLease(id: string): Promise<{ info: StoreLockInfo; etag: string } | null> {
		const got = await getText(lockKey(id), `store lock ${id}`);
		if (got === null) return null;
		return { info: leaseInfo(id, got.text, got.response), etag: got.etag };
	}

	function holderRefusal(key: string, info: StoreLockInfo): StoreRefusal {
		const command = `pancode store locks break ${info.id}`;
		if (info.state === "unreadable")
			return new StoreRefusal(
				"unavailable",
				`The store lock for ${key} cannot be read (${info.file}). If no writer holds it, run ${command}.`,
			);
		return new StoreRefusal(
			"unavailable",
			`Another writer holds the store lock for ${key}: pid ${info.pid} on ${info.host} since ${info.at}. Its lease expires ${STORE_LEASE_EXPIRY_MS / 1000} s after its last renewal.`,
		);
	}

	async function acquire(key: string): Promise<{ id: string; owner: LeaseOwner; etag: string }> {
		const id = storeLockId(key);
		const owner: LeaseOwner = {
			v: 1,
			key,
			pid: process.pid,
			host: hostname(),
			token: randomBytes(8).toString("hex"),
			at: new Date().toISOString(),
			seq: 1,
		};
		const body = Buffer.from(JSON.stringify(owner));
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			const made = await putIf(lockKey(id), body, { ifNoneMatch: true }, `taking the store lock for ${key}`);
			if (made !== null) return { id, owner, etag: made };
			const held = await readLease(id);
			if (held === null) continue;
			if (held.info.state === "dead") {
				const taken = await putIf(lockKey(id), body, { ifMatch: held.etag }, `taking over the store lock for ${key}`);
				if (taken !== null) return { id, owner, etag: taken };
				continue;
			}
			if (Date.now() >= deadline) throw holderRefusal(key, held.info);
			await delay(LOCK_POLL_MS);
		}
	}

	async function takeLease<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const lease = await acquire(key);
		return withLease(
			key,
			{
				renew: async () => {
					// Advance seq so each renewal produces a new ETag; a stale takeover against the prior ETag then gets 412.
					const nextSeq = lease.owner.seq + 1;
					const renewed = await putIf(
						lockKey(lease.id),
						Buffer.from(JSON.stringify({ ...lease.owner, seq: nextSeq })),
						{ ifMatch: lease.etag },
						`renewing the store lock for ${key}`,
					);
					if (renewed === null) return false;
					lease.owner.seq = nextSeq;
					lease.etag = renewed;
					return true;
				},
				release: async () => {
					const current = await readLease(lease.id);
					if (current !== null && current.etag === lease.etag)
						await del(lockKey(lease.id), `releasing the store lock for ${key}`, { "if-match": lease.etag });
				},
			},
			fn,
		);
	}

	const backend: StoreBackend = {
		kind: "s3",
		location: client.location(base),

		facts: async (): Promise<StoreBackendFacts> => ({
			kind: "s3",
			mapping: "a tag is a key prefix and a blob is an object under it",
			tiers: false,
			multiNode: true,
			durable: true,
			conditionalPut: "if-absent",
			blobVersions: false,
			freeBytes: null,
			roots: [{ name: STORE_DEFAULT_ROOT_NAME, id: null, durable: true, sharedFs: true, purge: null, freeBytes: null }],
			links: "copy",
		}),

		withLock: (key, fn) => takeLease(key, fn),

		listLocks: () =>
			guarded(async () => {
				const locks: StoreLockInfo[] = [];
				for (const object of await listAll(`${base}locks/`)) {
					const id = LOCK_NAME.exec(object.key.slice(`${base}locks/`.length))?.[1];
					if (id === undefined) continue;
					const lease = await readLease(id);
					if (lease !== null) locks.push(lease.info);
				}
				return locks;
			}),

		readLock: (id) =>
			guarded(async () => {
				checkLockId(id);
				return (await readLease(id))?.info ?? null;
			}),

		breakLock: (id) =>
			guarded(async () => {
				checkLockId(id);
				const lease = await readLease(id);
				if (lease === null) throw new StoreRefusal("not-found", `No store lock ${id} in this project.`);
				if (lease.info.state === "live")
					throw new StoreRefusal(
						"unavailable",
						`Store lock ${id} is held by pid ${lease.info.pid} on ${lease.info.host} and renewed within ${STORE_LEASE_EXPIRY_MS / 1000} s; it is not broken while its writer runs.`,
					);
				const again = await readLease(id);
				if (again === null) return lease.info;
				if (again.etag !== lease.etag || again.info.state === "live")
					throw new StoreRefusal("unavailable", `Store lock ${id} changed while it was being broken; look again.`);
				const response = await client.send("DELETE", lockKey(id), { headers: { "if-match": lease.etag } });
				await discard(response);
				if (response.status === 412)
					throw new StoreRefusal("unavailable", `Store lock ${id} changed while it was being broken; look again.`);
				if (response.status !== 204 && response.status !== 200 && response.status !== 404)
					throw await client.refusal(response, `breaking store lock ${id}`);
				return lease.info;
			}),

		usage: (tag) =>
			guarded(async (): Promise<StoreUsage> => {
				const names =
					tag === undefined ? (await backend.listTags()).filter((name) => validateTagName(name) === null) : [tag];
				const tags: Array<{ tag: string; root: string; blobs: number; bytes: number }> = [];
				for (const name of names) {
					await requireTag(name);
					let blobs = 0;
					let bytes = 0;
					for await (const blob of await blobNames(name, "")) {
						blobs += 1;
						bytes += blob.bytes;
					}
					tags.push({ tag: name, root: STORE_DEFAULT_ROOT_NAME, blobs, bytes });
				}
				return {
					tags,
					roots: [
						{
							name: STORE_DEFAULT_ROOT_NAME,
							tags: tags.length,
							blobs: tags.reduce((sum, entry) => sum + entry.blobs, 0),
							bytes: tags.reduce((sum, entry) => sum + entry.bytes, 0),
							freeBytes: null,
						},
					],
				};
			}),

		getOrCreateTag: (tag) => guarded(() => getOrCreateTag(tag)),

		tagExists: (tag) =>
			guarded(async () => {
				checkTag(tag);
				return (await head(tagKey(tag), `tag ${tag}`)) !== null;
			}),

		listTags: () =>
			guarded(async () => {
				const candidates: string[] = [];
				let next: string | null = null;
				do {
					const page = await client.list(`${base}tags/`, { delimiter: "/", next });
					for (const prefix of page.prefixes) {
						const segment = prefix.slice(`${base}tags/`.length, -1);
						let tag: string;
						try {
							tag = decodeTagSegment(segment);
						} catch {
							// An undecodable prefix is not a tag this store wrote.
							continue;
						}
						if (validateTagName(tag, { allowRecords: true }) === null) candidates.push(tag);
					}
					next = page.next;
				} while (next !== null);
				// A prefix without its tag.json is a tag being deleted, or another tool's keys.
				const present = await mapParallel(candidates, async (tag) => (await head(tagKey(tag), `tag ${tag}`)) !== null);
				return candidates.filter((_, index) => present[index]).sort();
			}),

		delTag: (tag) =>
			guarded(async () => {
				checkTag(tag);
				await fenceHeldLeases();
				// Keep the marker until cleanup succeeds so an interrupted rm-tag can be retried.
				const keys = (await listAll(tagBase(tag))).map((object) => object.key).filter((key) => key !== tagKey(tag));
				await mapParallel(keys, (key) => del(key, `deleting ${client.location(key)}`));
				await del(tagKey(tag), `deleting tag ${tag}`);
			}),

		setTagXattr: (tag, key, value) =>
			guarded(async () => {
				if (key.length === 0 || Buffer.byteLength(key, "utf8") > XATTR_KEY_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A tag attribute key must be 1 to ${XATTR_KEY_MAX_BYTES} bytes.`);
				}
				if (Buffer.byteLength(value, "utf8") > XATTR_VALUE_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A tag attribute value must be at most ${XATTR_VALUE_MAX_BYTES} bytes.`);
				}
				for (let attempt = 0; attempt < RACE_RETRIES; attempt++) {
					const current = await readTag(tag);
					if (current === null) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
					current.file.xattrs = { ...current.file.xattrs, [key]: value };
					const body = Buffer.from(`${JSON.stringify(current.file)}\n`);
					await fenceHeldLeases();
					if ((await putIf(tagKey(tag), body, { ifMatch: current.etag }, `updating tag ${tag}`)) !== null) return;
				}
				throw new StoreRefusal(
					"unavailable",
					`Tag ${tag} kept changing under ${RACE_RETRIES} attribute writes; try again.`,
				);
			}),

		getTagXattrs: (tag) =>
			guarded(async () => {
				const current = await readTag(tag);
				if (current === null) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
				return { ...current.file.xattrs };
			}),

		putBlobFromFile: (tag, blob, source, signal, putOptions) =>
			guarded(async (): Promise<StoreBlobPut> => {
				await requireTag(tag);
				checkBlob(tag, blob);
				let sourceInfo: Awaited<ReturnType<typeof stat>>;
				try {
					sourceInfo = await stat(source);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT")
						throw new StoreRefusal("not-found", `No file at ${source}.`);
					throw error;
				}
				if (!sourceInfo.isFile()) throw new StoreRefusal("not-a-file", `${source} is not a regular file.`);
				if (sourceInfo.size > S3_PUT_MAX_BYTES)
					throw new StoreRefusal(
						"unavailable",
						`The s3 backend stores a blob in one PUT of at most 5 GiB; ${source} is ${sourceInfo.size} bytes.`,
					);
				const aborted = () => new StoreRefusal("io", `The put of ${blob} into ${tag} was aborted.`);
				if (signal?.aborted) throw aborted();
				await refuseNameConflict(tag, blob);
				let sha256: string;
				try {
					sha256 = await hashStoreFile(source, signal);
				} catch (error) {
					if (signal?.aborted) throw aborted();
					throw error;
				}
				const key = `${blobsBase(tag)}${blob}`;
				const previous = putOptions?.ifAbsent ? null : await head(key, `${tag}:${blob}`);
				const etag = previous?.headers.get("etag");
				if (previous !== null && !etag)
					throw new StoreRefusal("unavailable", `The bucket returned no ETag for ${tag}:${blob}; refusing to replace it.`);
				await fenceHeldLeases();
				const modifiedMs = Date.now();
				const fenced = fencedSignal(signal);
				let response: Response;
				try {
					// The signed digest is of the bytes hashed above, so a source changed since is refused by S3.
					response = await client.send("PUT", key, {
						headers: { [MTIME_HEADER]: String(modifiedMs), ...(etag ? { "if-match": etag } : { "if-none-match": "*" }) },
						body: { file: source, bytes: sourceInfo.size, sha256 },
						...(fenced !== undefined ? { signal: fenced } : {}),
					});
				} catch (error) {
					if (signal?.aborted) throw aborted();
					// A lease taken over mid-upload aborted it; the confirmation names the lost lock.
					if (fenced?.aborted) await fenceHeldLeases();
					throw error;
				}
				if (response.status !== 200) {
					if (signal?.aborted) throw aborted();
					if (response.status === 412 || response.status === 409) {
						await discard(response);
						throw new StoreRefusal("exists", `${tag}:${blob} changed before the put committed; inspect it before retrying.`);
					}
					throw await client.refusal(response, `the put of ${blob} into ${tag}`);
				}
				await discard(response);
				return { bytes: sourceInfo.size, modifiedMs, version: null, sha256, link: "copy", key: client.location(key) };
			}),

		getBlobAsPath: (tag, blob, signal) =>
			guarded(async () => {
				checkTag(tag);
				checkBlob(tag, blob);
				const response = await client.send("GET", `${blobsBase(tag)}${blob}`, signal !== undefined ? { signal } : {});
				if (response.status === 404) {
					await discard(response);
					throw new StoreRefusal("not-found", `Tag ${tag} has no blob named ${blob}.`);
				}
				if (response.status !== 200 || response.body === null) throw await client.refusal(response, `${tag}:${blob}`);
				// S3 keys can have components longer than NAME_MAX. '#' cannot start a tag or blob component.
				const segments = [encodeTagSegment(tag), ...blob.split("/")].flatMap((name) => {
					const parts: string[] = [];
					while (name.length > 255) {
						parts.push(`#${name.slice(0, 128)}`);
						name = name.slice(128);
					}
					return [...parts, name];
				});
				const body = response.body;
				try {
					return await writeCacheCopy(options.cacheDir, options.projectKey, segments, (temp) =>
						pipeline(
							Readable.fromWeb(body as WebReadableStream<Uint8Array>),
							createWriteStream(temp, { flags: "wx", mode: 0o600 }),
							...(signal !== undefined ? [{ signal }] : []),
						),
					);
				} finally {
					if (!response.bodyUsed) await discard(response);
				}
			}),

		putRecordIfAbsent: (tag, blob, data) =>
			guarded(async () => {
				if (data.byteLength > RECORD_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A record must be at most ${RECORD_MAX_BYTES} bytes.`);
				}
				// A record in a tag nobody created would be invisible to listTags, so the tag comes first.
				await getOrCreateTag(tag);
				checkBlob(tag, blob);
				await fenceHeldLeases();
				const made = await putIf(`${blobsBase(tag)}${blob}`, data, { ifNoneMatch: true }, `record ${tag}:${blob}`);
				return made === null ? "exists" : "written";
			}),

		getRecord: (tag, blob) =>
			guarded(async () => {
				checkTag(tag);
				checkBlob(tag, blob);
				const response = await client.send("GET", `${blobsBase(tag)}${blob}`);
				if (response.status === 404) {
					await discard(response);
					return null;
				}
				if (response.status !== 200) throw await client.refusal(response, `record ${tag}:${blob}`);
				if (Number(response.headers.get("content-length") ?? "0") > RECORD_MAX_BYTES) {
					await discard(response);
					throw new StoreRefusal("io", `Record ${blob} in tag ${tag} is larger than ${RECORD_MAX_BYTES} bytes.`);
				}
				return new Uint8Array(await response.arrayBuffer());
			}),

		statBlob: (tag, blob) =>
			guarded(async () => {
				checkTag(tag);
				checkBlob(tag, blob);
				const response = await head(`${blobsBase(tag)}${blob}`, `${tag}:${blob}`);
				return response === null ? null : statOf(response);
			}),

		listBlobs: (tag, q) =>
			guarded(async () => {
				await requireTag(tag);
				const matcher = q.pattern !== undefined ? compileBlobPattern(q.pattern) : null;
				const offset = Math.max(0, Math.floor(q.offset));
				const limit = Math.max(0, Math.floor(q.limit));
				const wanted = offset + limit + 1;
				const matches: string[] = [];
				// Keys list in byte order, the order the local backend's walk yields names in.
				for await (const { name } of await blobNames(tag, q.prefix ?? "")) {
					if (matcher === null || matcher.test(name)) matches.push(name);
					if (matches.length >= wanted) break;
				}
				return { names: matches.slice(offset, offset + limit), hasMore: matches.length > offset + limit };
			}),

		delBlob: (tag, blob) =>
			guarded(async () => {
				checkTag(tag);
				checkBlob(tag, blob);
				const key = `${blobsBase(tag)}${blob}`;
				if ((await head(key, `${tag}:${blob}`)) === null) return false;
				await fenceHeldLeases();
				await del(key, `deleting ${tag}:${blob}`);
				return true;
			}),

		blobRefOfPath: async (realPath) => {
			// Only a copy `get` handed out is local: <cache>/store/<projectKey>/<encoded tag>/<blob>, while its blob is stored.
			const resolved = await realpath(cacheProjectDir).catch(() => null);
			if (resolved === null) return null;
			const relative = path.relative(resolved, realPath);
			if (relative === "" || relativePathEscapes(relative)) return null;
			const segments: string[] = [];
			let head = "";
			for (const part of relative.split(path.sep)) {
				if (part.startsWith("#")) head += part.slice(1);
				else {
					segments.push(head + part);
					head = "";
				}
			}
			if (head !== "") return null;
			const [encodedTag, ...rest] = segments;
			if (encodedTag === undefined || rest.length === 0) return null;
			try {
				const ref = { tag: decodeTagSegment(encodedTag), blob: rest.join("/") };
				return (await backend.statBlob(ref.tag, ref.blob)) !== null ? ref : null;
			} catch {
				// A malformed escape, a name the store refuses or an unreachable store names no blob of ours.
				return null;
			}
		},
	};
	return backend;
}

registerStoreBackend("s3", createS3StoreBackend);
