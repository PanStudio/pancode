// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The out-of-band half of the experimental MCP files extension: sending a
 * call's files to the targets an `upload_required` result names, and fetching
 * the files a result offers for download. Target URLs, headers, form fields
 * and credentials never reach a message this module returns; a reason names
 * the file, the HTTP status, or the storage origin at most.
 */
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, open, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { proxyForUrl } from "../../core/proxy-env.js";
import {
	MCP_FILE_LIMITS,
	type McpDownloadTarget,
	type McpFileInput,
	type McpFileTransferContext,
	type McpResolvedTarget,
	type McpUploadRequest,
	type McpUploadTarget,
	mcpMultipartBody,
	resolveMcpTarget,
} from "../../domains/gateway/mcp/index.js";
import { isPublicWebAddress } from "../web-fetch-network.js";

interface Address {
	address: string;
	family: number;
}

/** How a checked target is reached: the proxy-aware global fetch, or a direct socket pinned to the checked address. */
type Route = { kind: "fetch" } | { kind: "pinned"; address: Address };

interface CheckedTarget {
	resolved: McpResolvedTarget;
	route: Route;
	headers: Array<[string, string]>;
}

/** A file the call holds, by the id its `FileInput` carries. */
export interface McpHeldFile {
	input: McpFileInput;
	bytes: Uint8Array;
}

/** What a transfer is checked against beyond the target rules. */
export interface McpTransferPolicy {
	context: McpFileTransferContext;
	/** The information-flow verdict for a storage URL outside the server's own origin; null admits it. */
	admitTarget: ((url: string) => string | null) | undefined;
	signal: AbortSignal | undefined;
}

const UPLOAD_PUT_RETRIES = 2;
const DOWNLOAD_HEADERS_MS = 30_000;
const DOWNLOAD_TOTAL_MS = 290_000;

function uploadTimeoutMs(bytes: number): number {
	return Math.max(80_000, 30_000 + Math.ceil(bytes / (4 * 1024 * 1024)) * 1000);
}

function downloadBodyMs(bytes: number): number {
	return 30_000 + Math.ceil(bytes / (256 * 1024)) * 1000;
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return pending;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * A listed origin and a path target under an https or loopback MCP address
 * go the way MCP requests go, through any configured proxy. Any other target
 * connects directly to an address checked public; behind a proxy PanCode
 * cannot see the address the proxy connects to, so such a target needs the
 * operator's `fileTargets` entry.
 */
async function routeFor(resolved: McpResolvedTarget, signal: AbortSignal | undefined): Promise<Route | string> {
	if (resolved.listed || resolved.underAddress) return { kind: "fetch" };
	const { url } = resolved;
	if (proxyForUrl(url.href) !== null) {
		return `its storage at ${url.origin} is reached through the configured proxy, which PanCode cannot hold to public addresses; the operator may list that origin in this server's fileTargets`;
	}
	const host = url.hostname.replace(/^\[|\]$/gu, "");
	let addresses: Address[];
	try {
		addresses = isIP(host)
			? [{ address: host, family: isIP(host) }]
			: await abortable(lookup(host, { all: true }), signal);
	} catch (error) {
		signal?.throwIfAborted();
		return `its storage host did not resolve (${errorCode(error)})`;
	}
	const first = addresses[0];
	if (first === undefined) return "its storage host did not resolve";
	if (addresses.some((entry) => !isPublicWebAddress(entry.address))) {
		return `its storage at ${url.origin} is not a public address; the operator may list that origin in this server's fileTargets`;
	}
	return { kind: "pinned", address: first };
}

/** Every rule a target must pass before a byte moves: the target rules, expiry, the flow check, credentials and the address. */
async function checkTarget(
	target: McpUploadTarget | McpDownloadTarget,
	policy: McpTransferPolicy,
	authorization: () => Promise<string | null>,
): Promise<CheckedTarget | string> {
	const resolved = resolveMcpTarget(target, policy.context);
	if (typeof resolved === "string") return resolved;
	if (target.expiresAt !== null && target.expiresAt <= Date.now())
		return "its target expired before PanCode could use it";
	if (!resolved.serverOrigin) {
		const refusal = policy.admitTarget?.(resolved.url.href) ?? null;
		if (refusal !== null) return `the information-flow policy refuses its storage: ${refusal}`;
	}
	const headers = [...target.headers];
	if (resolved.include) {
		const value = await authorization();
		if (value === null) return "it asks for credentials, but PanCode's MCP requests to this server carry none";
		headers.push(["Authorization", value]);
	}
	const route = await routeFor(resolved, policy.signal);
	if (typeof route === "string") return route;
	return { resolved, route, headers };
}

function errorCode(error: unknown): string {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
	const code = (cause as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/u.test(code)) return code;
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timed out";
	return "network error";
}

interface TransferResponse {
	status: number;
	contentEncoding: string | null;
	body: ReadableStream<Uint8Array> | null;
}

/** A request to a pinned address: no second lookup, proxy, pooled socket or redirect. The URL host still sets Host, SNI and the certificate name. */
function pinnedRequest(
	url: URL,
	method: string,
	headers: Array<[string, string]>,
	body: Uint8Array | null,
	address: Address,
	signal: AbortSignal,
): Promise<TransferResponse> {
	return new Promise((resolve, reject) => {
		const outgoing: Record<string, string> = {};
		for (const [name, value] of headers) outgoing[name] = value;
		if (body !== null) outgoing["Content-Length"] = String(body.byteLength);
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{
				method,
				headers: outgoing,
				agent: false,
				signal,
				lookup: (_hostname, options, callback) => {
					if (options.all) callback(null, [address]);
					else callback(null, address.address, address.family);
				},
			},
			(response: IncomingMessage) => {
				const encoding = response.headers["content-encoding"];
				resolve({
					status: response.statusCode ?? 0,
					contentEncoding: typeof encoding === "string" ? encoding : null,
					body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
				});
			},
		);
		request.on("error", reject);
		request.end(body === null ? undefined : Buffer.from(body.buffer, body.byteOffset, body.byteLength));
	});
}

async function send(
	checked: CheckedTarget,
	method: string,
	headers: Array<[string, string]>,
	body: Uint8Array | null,
	signal: AbortSignal,
): Promise<TransferResponse> {
	if (checked.route.kind === "pinned") {
		return pinnedRequest(checked.resolved.url, method, headers, body, checked.route.address, signal);
	}
	const response = await globalThis.fetch(checked.resolved.url, {
		method,
		headers,
		redirect: "manual",
		signal,
		...(body !== null ? { body } : {}),
	});
	return { status: response.status, contentEncoding: response.headers.get("content-encoding"), body: response.body };
}

function statusFailure(status: number): string {
	if (status >= 300 && status < 400) return `storage answered HTTP ${status}, a redirect PanCode does not follow`;
	if (status === 401 || status === 403) return `storage refused it with HTTP ${status}`;
	return `storage answered HTTP ${status}`;
}

function uploadRequestOf(
	target: McpUploadTarget,
	held: McpHeldFile,
	headers: Array<[string, string]>,
): { headers: Array<[string, string]>; body: Uint8Array } {
	if (target.form === null) return { headers, body: held.bytes };
	const { body, contentType } = mcpMultipartBody(target.form, held.input, held.bytes);
	return {
		headers: [...headers.filter(([name]) => name.toLowerCase() !== "content-type"), ["Content-Type", contentType]],
		body,
	};
}

/**
 * Send each pending file to its target. Every target is checked before any
 * byte moves; one bad target, or one failed transfer, stops the whole upload.
 * A PUT is retried twice after a network error or a 5xx; a POST is never
 * sent again. Returns null when every target answered 2xx, else the reason.
 */
export async function transferMcpUploads(
	request: McpUploadRequest,
	files: ReadonlyMap<string, McpHeldFile>,
	policy: McpTransferPolicy,
): Promise<string | null> {
	let authorization: Promise<string | null> | null = null;
	const credential = (): Promise<string | null> => {
		authorization ??= policy.context.authorization(policy.signal);
		return authorization;
	};
	const planned: Array<{ target: McpUploadTarget; held: McpHeldFile; checked: CheckedTarget }> = [];
	for (const target of request.uploads) {
		const held = files.get(target.fileId);
		if (held === undefined) return `the server named a file the call does not hold`;
		const checked = await checkTarget(target, policy, credential);
		if (typeof checked === "string") return `the server's upload target for ${held.input.name} was rejected: ${checked}`;
		planned.push({ target, held, checked });
	}
	for (const { target, held, checked } of planned) {
		const { headers, body } = uploadRequestOf(target, held, checked.headers);
		const attempts = target.method === "PUT" ? UPLOAD_PUT_RETRIES + 1 : 1;
		let failure: string | null = null;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			policy.signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(uploadTimeoutMs(body.byteLength));
			const signal = policy.signal === undefined ? timeout : AbortSignal.any([policy.signal, timeout]);
			try {
				const response = await send(checked, target.method, headers, body, signal);
				await response.body?.cancel().catch(() => undefined);
				if (response.status >= 200 && response.status < 300) {
					failure = null;
					break;
				}
				failure = statusFailure(response.status);
				if (response.status < 500) break;
			} catch (error) {
				policy.signal?.throwIfAborted();
				failure = errorCode(error);
			}
		}
		if (failure !== null) {
			return `the upload of ${held.input.name} failed: ${failure}; the server's storage may already hold some of the call's file bytes`;
		}
	}
	return null;
}

/** A file a result offered, saved under the session's scratch directory. */
export interface McpSavedDownload {
	path: string;
	name: string;
	mimeType: string;
	size: number;
}

/** A server-given name reduced to one safe path segment, or empty. */
function safeBaseName(name: string | null): string {
	const base = (name ?? "").split(/[/\\]/u).at(-1) ?? "";
	return base
		.replace(/[^A-Za-z0-9._-]/gu, "_")
		.replace(/^\.+/u, "")
		.slice(-96);
}

function savedName(name: string | null): string {
	const safe = safeBaseName(name);
	return `${randomBytes(6).toString("hex")}-${safe.length > 0 ? safe : "download"}`;
}

/** Stream a response body to a new file, stopping once it passes `size`; the sha-256 of what was written. */
async function writeBody(
	body: ReadableStream<Uint8Array>,
	path: string,
	size: number,
): Promise<{ written: number; digest: string } | string> {
	const handle = await open(path, "wx", 0o600);
	const hash = createHash("sha256");
	let written = 0;
	try {
		for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
			written += chunk.byteLength;
			if (written > size) return `storage sent more than the ${size} bytes the server declared`;
			hash.update(chunk);
			await handle.write(chunk);
		}
	} finally {
		await handle.close();
	}
	return { written, digest: hash.digest("base64url") };
}

/**
 * Fetch each offered file into `dir`, a directory only PanCode writes, under
 * a new name that never replaces a file. A target that breaks a rule, or a
 * file whose size or digest does not match, is dropped with its reason; the
 * others still save. Bytes and time are bounded per result.
 */
export async function saveMcpDownloads(
	targets: ReadonlyArray<McpDownloadTarget>,
	dir: string,
	policy: McpTransferPolicy,
): Promise<{ saved: McpSavedDownload[]; dropped: string[] }> {
	const saved: McpSavedDownload[] = [];
	const dropped: string[] = [];
	if (targets.length === 0) return { saved, dropped };
	let authorization: Promise<string | null> | null = null;
	const credential = (): Promise<string | null> => {
		authorization ??= policy.context.authorization(policy.signal);
		return authorization;
	};
	const deadline = AbortSignal.timeout(DOWNLOAD_TOTAL_MS);
	let budget = MCP_FILE_LIMITS.downloadBytesPerResult;
	await mkdir(dir, { recursive: true, mode: 0o700 });
	for (const [index, target] of targets.entries()) {
		const shown = safeBaseName(target.name);
		const label = `download ${index + 1}${shown.length > 0 ? ` (${shown})` : ""}`;
		policy.signal?.throwIfAborted();
		if (deadline.aborted) {
			dropped.push(`${label}: past PanCode's ${DOWNLOAD_TOTAL_MS / 1000}s bound for one result's downloads`);
			continue;
		}
		if (target.size > budget) {
			dropped.push(`${label}: past PanCode's bound of ${MCP_FILE_LIMITS.downloadBytesPerResult} bytes per result`);
			continue;
		}
		const checked = await checkTarget(target, policy, credential);
		if (typeof checked === "string") {
			dropped.push(`${label}: ${checked}`);
			continue;
		}
		budget -= target.size;
		const path = join(dir, savedName(target.name));
		const outcome = await download(target, checked, path, policy.signal, deadline);
		if (typeof outcome === "string") {
			await rm(path, { force: true });
			policy.signal?.throwIfAborted();
			dropped.push(`${label}: ${outcome}`);
			continue;
		}
		saved.push({ path, name: safeBaseName(target.name) || "download", mimeType: target.mimeType, size: target.size });
	}
	return { saved, dropped };
}

async function download(
	target: McpDownloadTarget,
	checked: CheckedTarget,
	path: string,
	cancel: AbortSignal | undefined,
	deadline: AbortSignal,
): Promise<true | string> {
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	const signals = [deadline, ...(cancel !== undefined ? [cancel] : [])];
	for (const signal of signals) signal.addEventListener("abort", stop, { once: true });
	let timer = setTimeout(stop, DOWNLOAD_HEADERS_MS);
	try {
		const headers: Array<[string, string]> = [...checked.headers, ["Accept-Encoding", "identity"]];
		const response = await send(checked, "GET", headers, null, controller.signal);
		clearTimeout(timer);
		timer = setTimeout(stop, downloadBodyMs(target.size));
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => undefined);
			return statusFailure(response.status);
		}
		if (response.contentEncoding !== null && response.contentEncoding.toLowerCase() !== "identity") {
			await response.body?.cancel().catch(() => undefined);
			return "storage sent an encoded body, which PanCode does not decode";
		}
		const body = response.body ?? new ReadableStream<Uint8Array>({ start: (stream) => stream.close() });
		const written = await writeBody(body, path, target.size);
		if (typeof written === "string") return written;
		if (written.written !== target.size) {
			return `storage sent ${written.written} bytes, not the ${target.size} the server declared`;
		}
		if (target.digest !== null && written.digest !== target.digest) {
			return "its bytes do not match the digest the server declared";
		}
		return true;
	} catch (error) {
		cancel?.throwIfAborted();
		return errorCode(error);
	} finally {
		clearTimeout(timer);
		for (const signal of signals) signal.removeEventListener("abort", stop);
	}
}
