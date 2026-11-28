// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The s3 backend: one bucket of an S3-compatible object store, the project's store a fenced change log under
 * `<prefix>projects/<projectKey>/`, so the same project key names the same store from every host. Slot `n` of
 * the log is a proposal at `log/p/<999999999999999 - n>` (so the newest lists first) and a decision at
 * `log/d/<n>`, each made once by a PUT with `If-None-Match: *`; the store's clock is the response's `Date`.
 * Pages are immutable JSON under `pages/`, blob bytes immutable objects under `objects/`.
 *
 * Limits: a blob is one PUT of at most 5 GiB, a put copies (no reflink), blobs carry no versions and there is no
 * free-space figure.
 */
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { StoreBackend } from "../backend/backend.js";
import { StoreRefusal } from "../backend/types.js";
import { hashStoreFile } from "../hash.js";
import { createLogStoreBackend } from "../log/backend.js";
import { type LogMedium, randomId } from "../log/machine.js";
import type { LogWitness } from "../log/types.js";
import { STORE_DEFAULT_ROOT_NAME, validateS3Prefix } from "../paths/index.js";
import { S3Client, type S3ClientOptions } from "./client.js";

export interface S3StoreOptions extends S3ClientOptions {
	/** Prepended to every key; empty, or ending in `/`. */
	prefix: string;
	/** The cache root: `getBlobAsPath` downloads live under `<cacheDir>/store/<projectKey>`. */
	cacheDir: string;
	/** `storeProjectKey` of the project's main checkout, or `storeProjectKeyForId` of its project id. */
	projectKey: string;
	/** The project id its tracked settings give it, kept with the project in the log; absent when it has none. */
	projectId?: string;
	/** The project's main checkout, kept with the project in the log when the store first writes it. */
	projectRoot: string;
}

/** The largest object one S3 PUT stores. */
export const S3_PUT_MAX_BYTES = 5 * 1024 ** 3;
/** How often a request that failed or raced (409, 503) is retried before it refuses. */
const RETRIES = 20;
const SLOT_DIGITS = 15;
const SLOT_MAX = 10 ** SLOT_DIGITS - 1;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether S3 answered "another write to this key is in flight" or "slow down": both are retried. */
function racing(status: number): boolean {
	return status === 409 || status === 503;
}

/** The S3 calls the change log makes, under the project's prefix. */
function s3Medium(client: S3Client, base: string): LogMedium {
	const proposalKey = (slot: number) => `${base}log/p/${String(SLOT_MAX - slot).padStart(SLOT_DIGITS, "0")}`;
	const decisionKey = (slot: number) => `${base}log/d/${String(slot).padStart(SLOT_DIGITS, "0")}`;
	const pageKey = (id: string) => `${base}pages/${id}`;
	const objectKey = (id: string) => `${base}objects/${id}`;

	async function discard(response: Response): Promise<void> {
		await response.body?.cancel().catch(() => undefined);
	}

	/** The store's clock at the response: `Date` has whole seconds, so the true time is within the second after. */
	function witnessOf(response: Response): LogWitness {
		const date = Date.parse(response.headers.get("date") ?? "");
		if (!Number.isFinite(date))
			throw new StoreRefusal(
				"unavailable",
				`The S3 store answered without a Date header; its clock decides lock expiry, so it cannot be used.`,
			);
		return { lo: date, hi: date + 1000 };
	}

	async function getText(key: string, what: string): Promise<{ text: string; response: Response } | null> {
		for (let attempt = 0; ; attempt++) {
			const response = await client.send("GET", key);
			if (response.status === 404) {
				await discard(response);
				return null;
			}
			if (response.status === 200) return { text: await response.text(), response };
			if (racing(response.status) && attempt < RETRIES) {
				await discard(response);
				await delay(50 + Math.random() * 100);
				continue;
			}
			throw await client.refusal(response, what);
		}
	}

	/**
	 * Create `key` once with `text`. Answers the response that made it, or null when the key already exists. A
	 * reply lost on the way is answered by reading the key back: `mine` tells this writer's text from another's.
	 */
	async function create(
		key: string,
		text: string,
		what: string,
		mine: (existing: string) => boolean,
	): Promise<{ made: true; response: Response } | { made: false }> {
		const body = Buffer.from(text);
		let lastError: unknown = null;
		for (let attempt = 0; attempt < RETRIES; attempt++) {
			let response: Response | null = null;
			try {
				response = await client.send("PUT", key, { headers: { "if-none-match": "*" }, body });
			} catch (error) {
				lastError = error;
			}
			if (response?.status === 200) {
				await discard(response);
				return { made: true, response };
			}
			if (response !== null && response.status !== 412 && !racing(response.status) && response.status < 500)
				throw await client.refusal(response, what);
			if (response !== null) {
				if (response.status >= 500 || racing(response.status)) lastError = await client.refusal(response, what);
				else await discard(response);
			}
			// 412, or an answer that may hide a create that did happen: the key itself says who made it.
			const existing = await getText(key, what).catch(() => undefined);
			if (existing === null && response?.status === 412) continue;
			if (existing !== undefined && existing !== null)
				return mine(existing.text) ? { made: true, response: existing.response } : { made: false };
			await delay(50 + Math.random() * 100 * Math.min(attempt + 1, 10));
		}
		throw lastError instanceof StoreRefusal
			? lastError
			: new StoreRefusal("unavailable", `S3 did not complete ${what} after ${RETRIES} tries.`);
	}

	async function* listed(prefix: string): AsyncGenerator<{ key: string; bytes: number; modifiedMs: number }> {
		let next: string | null = null;
		do {
			const page = await client.list(prefix, { next });
			yield* page.objects;
			next = page.next;
		} while (next !== null);
	}

	async function del(key: string, what: string): Promise<void> {
		const response = await client.send("DELETE", key);
		if (response.status !== 204 && response.status !== 200 && response.status !== 404)
			throw await client.refusal(response, what);
		await discard(response);
	}

	return {
		async qualify() {
			// The log needs a create that fails when the key exists, a listing in key order and the store's clock.
			const probe = `${base}log/probe/${randomId()}/`;
			const refuse = (why: string) =>
				new StoreRefusal("unavailable", `The S3 store at ${client.location(base)} cannot keep the store's log: ${why}.`);
			try {
				const first = await client.send("PUT", `${probe}b`, { headers: { "if-none-match": "*" }, body: Buffer.from("b") });
				await discard(first);
				if (first.status !== 200) throw await client.refusal(first, "the store's write probe");
				witnessOf(first);
				const second = await client.send("PUT", `${probe}b`, { headers: { "if-none-match": "*" }, body: Buffer.from("x") });
				await discard(second);
				if (second.status !== 412)
					throw refuse(`a PUT with If-None-Match: * over an existing key answered ${second.status}, not 412`);
				const third = await client.send("PUT", `${probe}a`, { headers: { "if-none-match": "*" }, body: Buffer.from("a") });
				await discard(third);
				if (third.status !== 200) throw await client.refusal(third, "the store's write probe");
				const page = await client.list(probe, { maxKeys: 1 });
				if (page.objects[0]?.key !== `${probe}a`) throw refuse("a listing does not return keys in order");
			} finally {
				await del(`${probe}a`, "the store's write probe").catch(() => undefined);
				await del(`${probe}b`, "the store's write probe").catch(() => undefined);
			}
		},

		async newestProposal() {
			const page = await client.list(`${base}log/p/`, { maxKeys: 1 });
			const key = page.objects[0]?.key;
			if (key === undefined) return 0;
			const inverted = key.slice(`${base}log/p/`.length);
			if (!/^\d{15}$/u.test(inverted))
				throw new StoreRefusal("io", `${client.location(key)} is not a slot of the store's log.`);
			return SLOT_MAX - Number(inverted);
		},

		async readProposal(slot) {
			const got = await getText(proposalKey(slot), `slot ${slot} of the store's log`);
			return got === null ? null : { text: got.text, witness: witnessOf(got.response) };
		},

		async claimProposal(slot, id, text) {
			const made = await create(proposalKey(slot), text, `slot ${slot} of the store's log`, (existing) => {
				try {
					return (JSON.parse(existing) as { id?: unknown }).id === id;
				} catch {
					return false;
				}
			});
			return made.made ? { won: true, witness: witnessOf(made.response) } : { won: false };
		},

		async readDecision(slot) {
			return (await getText(decisionKey(slot), `the decision of slot ${slot}`))?.text ?? null;
		},

		async claimDecision(slot, text) {
			await create(decisionKey(slot), text, `the decision of slot ${slot}`, () => false);
		},

		async witness() {
			const response = await client.send("HEAD", `${base}log/clock`);
			await discard(response);
			if (response.status !== 404 && response.status !== 200) throw await client.refusal(response, "the store's clock");
			return witnessOf(response);
		},

		async putPage(id, text) {
			const made = await create(pageKey(id), text, `page ${id}`, (existing) => existing === text);
			if (!made.made) throw new StoreRefusal("io", `Page ${id} already exists with different bytes.`);
		},

		async getPage(id) {
			return (await getText(pageKey(id), `page ${id}`))?.text ?? null;
		},

		async stagePayload(source, options) {
			const info = await stat(source);
			const aborted = () => new StoreRefusal("io", `Staging ${source} into the store was aborted.`);
			let sha256: string;
			try {
				sha256 = await hashStoreFile(source, options.signal);
			} catch (error) {
				if (options.signal?.aborted) throw aborted();
				throw error;
			}
			const id = randomId();
			let response: Response;
			try {
				// The signed digest is of the bytes hashed above, so a source changed since is refused by S3.
				response = await client.send("PUT", objectKey(id), {
					headers: { "if-none-match": "*" },
					body: { file: source, bytes: info.size, sha256 },
					...(options.signal !== undefined ? { signal: options.signal } : {}),
				});
			} catch (error) {
				if (options.signal?.aborted) throw aborted();
				throw error;
			}
			if (response.status === 412) {
				// A retry after the server accepted our unique signed PUT answers 412: confirm our size landed.
				await discard(response);
				const head = await client.send(
					"HEAD",
					objectKey(id),
					options.signal !== undefined ? { signal: options.signal } : {},
				);
				await discard(head);
				if (head.status === 200 && Number(head.headers.get("content-length")) === info.size)
					return { id, bytes: info.size, sha256, link: "copy" };
				throw new StoreRefusal(
					"io",
					`S3 refused staging ${source} (unexpected existing object at ${client.location(objectKey(id))}).`,
				);
			}
			if (response.status !== 200) throw await client.refusal(response, `staging ${source}`);
			await discard(response);
			return { id, bytes: info.size, sha256, link: "copy" };
		},

		async readPayload(id, target, signal) {
			const response = await client.send("GET", objectKey(id), signal !== undefined ? { signal } : {});
			if (response.status !== 200 || response.body === null)
				throw await client.refusal(response, `payload ${client.location(objectKey(id))}`);
			try {
				await pipeline(
					Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
					createWriteStream(target, { flags: "wx", mode: 0o600 }),
					...(signal !== undefined ? [{ signal }] : []),
				);
			} finally {
				if (!response.bodyUsed) await discard(response);
			}
		},

		payloadKey: (id) => client.location(objectKey(id)),

		async *listStored() {
			for await (const object of listed(`${base}pages/`))
				yield {
					kind: "page" as const,
					id: object.key.slice(`${base}pages/`.length),
					bytes: object.bytes,
					modifiedMs: object.modifiedMs,
				};
			for await (const object of listed(`${base}objects/`))
				yield {
					kind: "payload" as const,
					id: object.key.slice(`${base}objects/`.length),
					bytes: object.bytes,
					modifiedMs: object.modifiedMs,
				};
		},

		async deleteStored(kind, id) {
			const key = kind === "page" ? pageKey(id) : objectKey(id);
			await del(key, `deleting ${client.location(key)}`);
		},
	};
}

export function createS3StoreBackend(options: S3StoreOptions): StoreBackend {
	const prefixProblem = validateS3Prefix(options.prefix);
	if (prefixProblem !== null) throw new StoreRefusal("invalid-name", prefixProblem);
	if (options.bucket.length === 0) throw new StoreRefusal("invalid-name", "The S3 bucket name is empty.");
	const client = new S3Client(options);
	const base = `${options.prefix}projects/${options.projectKey}/`;
	return createLogStoreBackend({
		kind: "s3",
		location: client.location(base),
		logName: `s3\0${options.endpoint}\0${client.location(base)}`,
		medium: s3Medium(client, base),
		cacheDir: options.cacheDir,
		projectKey: options.projectKey,
		projectRoot: options.projectRoot,
		...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
		checkSource: (source, bytes) => {
			if (bytes > S3_PUT_MAX_BYTES)
				throw new StoreRefusal(
					"unavailable",
					`The s3 backend stores a blob in one PUT of at most 5 GiB; ${source} is ${bytes} bytes.`,
				);
		},
		facts: async () => ({
			kind: "s3",
			mapping: "the project's tags and blobs are a change log under its key prefix; a blob's bytes are an object",
			tiers: false,
			multiNode: true,
			durable: true,
			conditionalPut: "if-absent",
			blobVersions: false,
			freeBytes: null,
			roots: [{ name: STORE_DEFAULT_ROOT_NAME, id: null, durable: true, sharedFs: true, purge: null, freeBytes: null }],
			links: "copy",
		}),
	});
}
