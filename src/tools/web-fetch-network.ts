// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, connect as connectTcp, isIP, type Socket } from "node:net";
import type { Transform } from "node:stream";
import { Readable } from "node:stream";
import { connect as connectTls } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { WEB_FETCH_ALLOW_PRIVATE_NETWORK_ENV } from "./network-policy.js";

const blocked = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(address, prefix, "ipv4");
// Permit only global unicast IPv6. Block transition mechanisms that can embed
// an IPv4 destination and local/documentation allocations within that range.
for (const [address, prefix] of [
	["2001::", 32],
	["2001:db8::", 32],
	["2002::", 16],
] as const)
	blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicWebAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !blocked.check(address, "ipv4");
	return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

class WebFetchNetworkError extends Error {
	constructor(message: string) {
		super(`WEB_FETCH_PRIVATE_NETWORK: ${message}`);
		this.name = "WebFetchNetworkError";
	}
}

interface Address {
	address: string;
	family: number;
}
export interface WebFetchNetworkDependencies {
	resolve?: (hostname: string) => Promise<Address[]>;
	request?: (url: URL, init: RequestInit, address: Address) => Promise<Response>;
	allowPrivateNetwork?: boolean;
	/**
	 * Information-flow check for every URL this request connects to, the
	 * requested one and each redirect hop. Returns the block reason or null.
	 * Checked before DNS so a refused hop sends nothing, not even a lookup.
	 */
	admitHop?: (url: URL) => string | null;
}

/** Pin the checked address in the socket lookup while retaining the URL host
 * for Host, TLS SNI and certificate verification. No second DNS resolution,
 * proxy, pooled socket, or automatic redirect can bypass admission. */
function requestPinnedWebUrl(url: URL, init: RequestInit, address: Address): Promise<Response> {
	return requestWebUrl(url, init, {
		agent: false,
		lookup: (_hostname, options, callback) => {
			if (options.all) callback(null, [address]);
			else callback(null, address.address, address.family);
		},
	});
}

/** A CONNECT tunnel by name; the proxy resolves, screens and pins the address. */
async function tunnel(proxy: { host: string; port: number }, url: URL, signal?: AbortSignal | null): Promise<Socket> {
	const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
	const authority = `${url.hostname}:${port}`;
	const socket = connectTcp(proxy.port, proxy.host);
	let settle: { resolve: (head: string) => void; reject: (error: Error) => void } | null = null;
	let buffered = Buffer.alloc(0);
	const onData = (chunk: Buffer): void => {
		buffered = Buffer.concat([buffered, chunk]);
		const end = buffered.indexOf("\r\n\r\n");
		if (end < 0) {
			if (buffered.length > 16_384) settle?.reject(new Error("web_fetch: oversized proxy reply"));
			return;
		}
		const rest = buffered.subarray(end + 4);
		socket.off("data", onData);
		// HTTP and TLS speak first, so nothing follows the reply before the request is written.
		if (rest.length > 0) settle?.reject(new Error("web_fetch: the fetch proxy sent data before the request"));
		else settle?.resolve(buffered.subarray(0, end).toString("latin1"));
	};
	const onError = (error: Error): void => settle?.reject(error);
	const onClose = (): void => settle?.reject(new Error("web_fetch: the fetch proxy closed the connection"));
	const onAbort = (): void => settle?.reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
	try {
		const head = await new Promise<string>((resolve, reject) => {
			settle = { resolve, reject };
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.on("data", onData);
			socket.on("error", onError);
			socket.on("close", onClose);
			socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
		});
		const status = /^HTTP\/1\.[01] (\d{3})/u.exec(head)?.[1];
		if (status !== "200")
			throw new WebFetchNetworkError(`the host refused ${authority} (${head.split("\r\n")[0] ?? "no reply"})`);
		return socket;
	} catch (error) {
		socket.destroy();
		throw error;
	} finally {
		settle = null;
		signal?.removeEventListener("abort", onAbort);
		socket.off("data", onData);
		socket.off("error", onError);
		socket.off("close", onClose);
	}
}

/** One hop through the host's typed-fetch proxy; TLS and certificate checks stay end to end in this process. */
async function requestProxiedWebUrl(
	url: URL,
	init: RequestInit,
	proxy: { host: string; port: number },
): Promise<Response> {
	const socket = await tunnel(proxy, url, init.signal);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const connection =
		url.protocol === "https:"
			? connectTls({ socket, host: hostname, ...(isIP(hostname) === 0 ? { servername: hostname } : {}) })
			: socket;
	return requestWebUrl(url, init, { createConnection: () => connection });
}

async function requestWebUrl(
	url: URL,
	init: RequestInit,
	connection: Pick<import("node:http").RequestOptions, "agent" | "lookup" | "createConnection">,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const headers = new Headers(init.headers);
		headers.delete("host");
		const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{
				method: init.method ?? "GET",
				headers: Object.fromEntries(headers),
				...connection,
				...(init.signal ? { signal: init.signal } : {}),
			},
			(response) => {
				let decoder: Transform | null = null;
				try {
					const status = response.statusCode ?? 500;
					if (status < 200 || status > 599) throw new Error(`unsupported HTTP status ${status}`);
					const responseHeaders = new Headers();
					for (const [key, value] of Object.entries(response.headers)) {
						if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
					}
					let stream: Readable = response;
					const encoding = responseHeaders.get("content-encoding");
					decoder =
						encoding === "gzip"
							? createGunzip()
							: encoding === "br"
								? createBrotliDecompress()
								: encoding === "deflate"
									? createInflate()
									: null;
					if (decoder) {
						response.on("error", (error) => decoder?.destroy(error));
						decoder.on("close", () => response.destroy());
						stream = response.pipe(decoder);
						responseHeaders.delete("content-encoding");
						responseHeaders.delete("content-length");
					}
					const noBody = init.method === "HEAD" || [204, 205, 304].includes(status);
					if (noBody) response.resume();
					const result = new Response(noBody ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>), {
						status,
						statusText: response.statusMessage ?? "",
						headers: responseHeaders,
					});
					Object.defineProperty(result, "url", { value: url.toString() });
					resolve(result);
				} catch (error) {
					decoder?.destroy();
					response.destroy();
					reject(error);
				}
			},
		);
		request.on("error", reject);
		request.end(typeof init.body === "string" ? init.body : undefined);
	});
}

/** DNS lookup itself is not cancellable; stop awaiting it on turn cancellation. */
async function abortableLookup(
	pending: Promise<Address[]>,
	signal: AbortSignal | null | undefined,
): Promise<Address[]> {
	if (!signal) return pending;
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

let hostFetchProxy: { host: string; port: number } | null = null;

/**
 * Sends every typed fetch through the host's loopback fetch proxy (D14): the isolated worker has no DNS and no route
 * out, so the host resolves, screens and pins each hop. Null restores direct pinned fetches.
 */
export function routeWebFetchThroughHost(port: number | null): void {
	if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535))
		throw new Error(`web_fetch: invalid fetch proxy port ${port}`);
	hostFetchProxy = port === null ? null : { host: "127.0.0.1", port };
}

/** Every hop, including helper URLs, resolves and validates before connecting. */
export async function fetchWebUrl(
	input: string | URL,
	initial: RequestInit = {},
	dependencies: WebFetchNetworkDependencies = {},
): Promise<Response> {
	let url = new URL(input);
	const init = { ...initial, headers: new Headers(initial.headers) };
	const allowPrivate = dependencies.allowPrivateNetwork ?? process.env[WEB_FETCH_ALLOW_PRIVATE_NETWORK_ENV] === "1";
	// An isolated worker has no DNS and no route out; the host resolves and screens each hop instead.
	const proxy = dependencies.resolve === undefined && dependencies.request === undefined ? hostFetchProxy : null;
	for (let hop = 0; hop <= 10; hop++) {
		init.signal?.throwIfAborted();
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
			throw new Error("web_fetch: unsupported URL scheme or embedded credentials");
		const hopViolation = dependencies.admitHop?.(url) ?? null;
		if (hopViolation !== null) throw new WebFetchNetworkError(hopViolation);
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		if (proxy !== null && isIP(hostname) !== 0 && !isPublicWebAddress(hostname))
			throw new WebFetchNetworkError(
				`destination ${url.hostname} is not public; an isolated worker reaches public addresses only`,
			);
		const response =
			proxy !== null
				? await requestProxiedWebUrl(url, init, proxy)
				: await fetchPinnedHop(url, init, hostname, allowPrivate, dependencies);
		const location = response.headers.get("location");
		if (![301, 302, 303, 307, 308].includes(response.status) || location === null) return response;
		await response.body?.cancel();
		if (hop === 10) throw new Error("web_fetch: too many redirects");
		const next = new URL(location, url);
		if (next.origin !== url.origin) {
			// Custom headers can carry credentials too. A cross-origin redirect gets
			// no caller headers; the target still receives the ordinary Host header.
			init.headers = new Headers();
		}
		if (
			(response.status === 303 && init.method !== "HEAD") ||
			([301, 302].includes(response.status) && init.method === "POST")
		) {
			init.method = "GET";
			delete init.body;
			init.headers.delete("content-type");
			init.headers.delete("content-length");
		}
		url = next;
	}
	throw new Error("web_fetch: too many redirects");
}

async function fetchPinnedHop(
	url: URL,
	init: RequestInit,
	hostname: string,
	allowPrivate: boolean,
	dependencies: WebFetchNetworkDependencies,
): Promise<Response> {
	const addresses = isIP(hostname)
		? [{ address: hostname, family: isIP(hostname) }]
		: await abortableLookup((dependencies.resolve ?? ((host) => lookup(host, { all: true })))(hostname), init.signal);
	init.signal?.throwIfAborted();
	const address = addresses[0];
	if (address === undefined) throw new Error("web_fetch: DNS returned no addresses");
	if (!allowPrivate && addresses.some((address) => !isPublicWebAddress(address.address)))
		throw new WebFetchNetworkError(
			`destination ${url.hostname} is not public; operator opt-in ${WEB_FETCH_ALLOW_PRIVATE_NETWORK_ENV}=1 is required`,
		);
	return await (dependencies.request ?? requestPinnedWebUrl)(url, init, address);
}
