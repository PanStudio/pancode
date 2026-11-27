// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The few S3 calls the s3 backend makes, signed with AWS Signature Version 4 over `fetch`: object GET, HEAD,
 * PUT (conditional on `If-None-Match: *` or `If-Match`), DELETE and ListObjectsV2. Every failure is a
 * `StoreRefusal`; a failed precondition is an answer, not a failure.
 */
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { StoreRefusal } from "../backend/types.js";

export interface S3ClientOptions {
	/** `http(s)://host[:port]`, without the bucket. */
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Address the bucket as the first path segment instead of the host name's first label. */
	pathStyle: boolean;
}

/** A body the client signs: bytes in memory, or a file whose size and sha256 were taken before the send. */
export type S3Body = Uint8Array | { file: string; bytes: number; sha256: string };

export interface S3Request {
	query?: Record<string, string>;
	headers?: Record<string, string>;
	body?: S3Body;
	signal?: AbortSignal;
}

export interface S3ListPage {
	objects: Array<{ key: string; bytes: number }>;
	prefixes: string[];
	next: string | null;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding, the one SigV4 canonicalizes with. */
function uriEncode(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/gu, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function xmlText(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, entity: string) => {
		if (/^#x/iu.test(entity)) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
		if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
		return XML_ENTITIES[entity.toLowerCase()] ?? "";
	});
}

function xmlField(xml: string, name: string): string | null {
	const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u").exec(xml);
	return match === null ? null : xmlText(match[1] as string);
}

function xmlBlocks(xml: string, name: string): string[] {
	return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "gu"))].map((match) => match[1] as string);
}

/** A key from a listing asked with `encoding-type=url`, where a space comes back as `+`. */
function listedKey(value: string): string {
	return decodeURIComponent(value.replaceAll("+", " "));
}

function messageOf(error: unknown): string {
	const cause = (error as { cause?: unknown } | null)?.cause;
	const base = error instanceof Error ? error.message : String(error);
	return cause instanceof Error ? `${base}: ${cause.message}` : base;
}

export class S3Client {
	readonly bucket: string;
	private readonly endpoint: URL;
	private readonly options: S3ClientOptions;

	constructor(options: S3ClientOptions) {
		let endpoint: URL;
		try {
			endpoint = new URL(options.endpoint);
		} catch {
			throw new StoreRefusal("invalid-name", `The S3 endpoint ${options.endpoint} is not a URL.`);
		}
		if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
			throw new StoreRefusal("invalid-name", `The S3 endpoint ${options.endpoint} is not an http or https URL.`);
		this.endpoint = endpoint;
		this.bucket = options.bucket;
		this.options = options;
	}

	/** The object's name as a receipt and a diagnostic show it. */
	location(key: string): string {
		return `s3://${this.bucket}/${key}`;
	}

	private url(key: string, query: Record<string, string>): URL {
		const path = key.split("/").map(uriEncode).join("/");
		const base = this.options.pathStyle
			? `${this.endpoint.protocol}//${this.endpoint.host}/${this.bucket}/${path}`
			: `${this.endpoint.protocol}//${this.bucket}.${this.endpoint.host}/${path}`;
		const search = Object.keys(query)
			.sort()
			.map((name) => `${uriEncode(name)}=${uriEncode(query[name] as string)}`)
			.join("&");
		return new URL(search.length > 0 ? `${base}?${search}` : base);
	}

	/** Send one signed request; the caller reads or discards the body. A network failure refuses `unavailable`. */
	async send(method: string, key: string, request: S3Request = {}): Promise<Response> {
		const url = this.url(key, request.query ?? {});
		const body = request.body;
		const payload = body === undefined ? EMPTY_SHA256 : body instanceof Uint8Array ? sha256Hex(body) : body.sha256;
		const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/gu, "");
		const day = amzDate.slice(0, 8);
		const signed: Record<string, string> = {
			host: url.host,
			"x-amz-content-sha256": payload,
			"x-amz-date": amzDate,
		};
		for (const [name, value] of Object.entries(request.headers ?? {})) signed[name.toLowerCase()] = value.trim();
		const names = Object.keys(signed).sort();
		const canonical = [
			method,
			url.pathname,
			url.search.slice(1),
			names.map((name) => `${name}:${signed[name]}\n`).join(""),
			names.join(";"),
			payload,
		].join("\n");
		const scope = `${day}/${this.options.region}/s3/aws4_request`;
		const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
		const signingKey = hmac(
			hmac(hmac(hmac(`AWS4${this.options.secretAccessKey}`, day), this.options.region), "s3"),
			"aws4_request",
		);
		const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
		const headers: Record<string, string> = { ...signed };
		delete headers.host;
		headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
		const init: RequestInit & { duplex?: "half" } = { method, headers };
		if (body instanceof Uint8Array) init.body = body;
		else if (body !== undefined) {
			// The length is fixed up front, so the bytes go as one plain body; S3 refuses a chunked one.
			headers["content-length"] = String(body.bytes);
			init.body = createReadStream(body.file) as unknown as NonNullable<RequestInit["body"]>;
			init.duplex = "half";
		}
		if (request.signal !== undefined) init.signal = request.signal;
		try {
			return await fetch(url, init);
		} catch (error) {
			if (request.signal?.aborted) throw new StoreRefusal("io", `The S3 request for ${this.location(key)} was aborted.`);
			throw new StoreRefusal(
				"unavailable",
				`The S3 store at ${this.endpoint.origin} cannot be reached: ${messageOf(error)}`,
			);
		}
	}

	/** The refusal for a response the caller did not expect, with S3's own code and message. */
	async refusal(response: Response, what: string): Promise<StoreRefusal> {
		const text = await response.text().catch(() => "");
		const code = xmlField(text, "Code");
		const detail = xmlField(text, "Message");
		const said = code === null ? `HTTP ${response.status}` : `${code}${detail === null ? "" : `: ${detail}`}`;
		if (code === "NoSuchBucket")
			return new StoreRefusal("unavailable", `The S3 bucket ${this.bucket} does not exist (${said}).`);
		if (response.status === 401 || response.status === 403)
			return new StoreRefusal("unavailable", `S3 refused ${what} with the configured credentials (${said}).`);
		if (response.status >= 500) return new StoreRefusal("unavailable", `S3 could not serve ${what} (${said}).`);
		return new StoreRefusal("io", `S3 refused ${what} (${said}).`);
	}

	/** One ListObjectsV2 page under `prefix`, keys decoded; `delimiter` groups the rest of a key into `prefixes`. */
	async list(
		prefix: string,
		options: { delimiter?: string; next?: string | null; startAfter?: string } = {},
	): Promise<S3ListPage> {
		const query: Record<string, string> = { "list-type": "2", prefix, "encoding-type": "url" };
		if (options.delimiter !== undefined) query.delimiter = options.delimiter;
		if (options.next !== undefined && options.next !== null) query["continuation-token"] = options.next;
		else if (options.startAfter !== undefined) query["start-after"] = options.startAfter;
		const response = await this.send("GET", "", { query });
		if (response.status !== 200) throw await this.refusal(response, `the listing of ${this.location(prefix)}`);
		const xml = await response.text();
		return {
			objects: xmlBlocks(xml, "Contents").map((block) => ({
				key: listedKey(xmlField(block, "Key") ?? ""),
				bytes: Number(xmlField(block, "Size") ?? "0"),
			})),
			prefixes: xmlBlocks(xml, "CommonPrefixes").map((block) => listedKey(xmlField(block, "Prefix") ?? "")),
			next: xmlField(xml, "IsTruncated") === "true" ? xmlField(xml, "NextContinuationToken") : null,
		};
	}
}
