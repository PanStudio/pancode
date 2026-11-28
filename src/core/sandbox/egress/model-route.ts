// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import { MODEL_ROUTE_REFRESH_PATH, type ModelRouteRefreshOutcome } from "./model-route-client.js";

/**
 * The host side of one worker launch's model route (D14, sandbox-p10 design 2.2). The worker's dispatcher
 * (`model-route-client.ts`) sends its connections to the provider origin here instead, so its provider client speaks
 * plain HTTP/1.1 to this route with a per-launch surrogate where its API key would be; the route checks the
 * surrogate, replaces it with the real credential, and relays the request to the one admitted origin over TLS from
 * this process. Response bytes (JSON, SSE, a WebSocket after 101) pass through unchanged and unbuffered, so
 * streaming and a client abort behave as a direct call does. The route is no proxy: an absolute-form request, a
 * CONNECT and any surrogate other than the launch's are refused before anything is dialed.
 */

/** Headers that may carry a credential. Each is dropped from the worker's request; the one holding the surrogate is rewritten. */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "api-key"] as const;
const STRIPPED_REQUEST_HEADERS = new Set([
	"host",
	"connection",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"cookie",
	...CREDENTIAL_HEADERS,
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const MAX_RECEIPTS = 64;
const DEFAULT_MAX_CONNECTIONS = 16;
const ROUTE_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** What the route injects on one request; `headers` are the target's own `auth.headers`, set over the worker's. */
export interface ModelRouteCredential {
	apiKey: string;
	headers?: Readonly<Record<string, string>>;
}

export interface ModelRouteOptions {
	/** The admitted origin, `scheme://host[:port]`; every request goes there with its path unchanged. */
	origin: string;
	/** The launch's surrogate, as `modelRouteSurrogate` shaped it. */
	surrogate: string;
	/**
	 * The credential for the next request, resolved by the caller (proactive OAuth refresh included). With
	 * `rejectedApiKey` the caller force-refreshes that key first. Throws when no credential is available; the
	 * message reaches the worker as the 401 body.
	 */
	resolve(rejectedApiKey?: string): Promise<ModelRouteCredential>;
	maxConnections?: number;
}

export interface ModelRouteReceipt {
	at: string;
	method: string;
	/** Path without the query. */
	path: string;
	/** Upstream status; 0 when the route answered itself. */
	status: number;
	upgrade?: true;
	/** Why the route answered itself. */
	refused?: string;
	/** A refresh the worker asked for, and its outcome. */
	refresh?: ModelRouteRefreshOutcome;
}

export interface ModelRoute {
	/** Serves one listener: a host loopback one, or the one a sandboxed launch hands over. The route owns and closes it. */
	serve(listener: net.Server): void;
	/**
	 * Force-refreshes the credential the upstream last rejected (else the one last injected: a WebSocket refuses in
	 * band). Concurrent calls for one rejected credential share one refresh.
	 */
	refresh(): Promise<ModelRouteRefreshOutcome>;
	receipts(): ModelRouteReceipt[];
	/** Closes every listener and destroys every client and upstream connection. */
	close(): void;
}

type Undici = typeof import("undici");
let undici: Promise<Undici> | null = null;
const loadUndici = (): Promise<Undici> => {
	undici ??= import("undici");
	return undici;
};

/** The surrogate a request carries, read from the first credential header that has one. */
function presentedToken(headers: http.IncomingHttpHeaders): { header: string; token: string; bearer: boolean } | null {
	for (const header of CREDENTIAL_HEADERS) {
		const raw = headers[header];
		if (typeof raw !== "string" || raw.length === 0) continue;
		const bearer = /^bearer\s+/iu.test(raw);
		return { header, token: bearer ? raw.replace(/^bearer\s+/iu, "") : raw, bearer };
	}
	return null;
}

function sameSecret(presented: string, expected: Buffer): boolean {
	const bytes = Buffer.from(presented, "utf8");
	return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

/**
 * The upstream request headers: the worker's own minus hop-by-hop and every credential-shaped header, then the real
 * credential in the header and scheme the surrogate came in, then the target's `auth.headers`.
 */
function upstreamHeaders(
	inbound: http.IncomingHttpHeaders,
	presented: { header: string; bearer: boolean },
	credential: ModelRouteCredential,
): Record<string, string | string[]> {
	const injected = Object.keys(credential.headers ?? {}).map((name) => name.toLowerCase());
	const out: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(inbound)) {
		if (value === undefined || STRIPPED_REQUEST_HEADERS.has(name) || injected.includes(name)) continue;
		out[name] = value;
	}
	out[presented.header] = presented.bearer ? `Bearer ${credential.apiKey}` : credential.apiKey;
	for (const [name, value] of Object.entries(credential.headers ?? {})) out[name.toLowerCase()] = value;
	return out;
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
		out[name] = value;
	}
	return out;
}

function errorText(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	return typeof code === "string" && !message.includes(code) ? `${message} (${code})` : message;
}

export function createModelRoute(options: ModelRouteOptions): ModelRoute {
	const origin = new URL(options.origin);
	if ((origin.protocol !== "https:" && origin.protocol !== "http:") || origin.origin !== options.origin)
		throw new Error(`model route: '${options.origin}' is not an http(s) origin`);
	const surrogate = Buffer.from(options.surrogate, "utf8");
	const listeners = new Set<net.Server>();
	const sockets = new Set<Duplex>();
	const aborts = new Set<AbortController>();
	const receipts: ModelRouteReceipt[] = [];
	let lastInjected: string | null = null;
	let lastRejected: string | null = null;
	const refreshing = new Map<string, Promise<ModelRouteRefreshOutcome>>();
	let closed = false;

	const record = (receipt: Omit<ModelRouteReceipt, "at">): void => {
		receipts.push({ at: new Date().toISOString(), ...receipt });
		if (receipts.length > MAX_RECEIPTS) receipts.shift();
	};
	const track = <T extends Duplex>(socket: T): T => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		if (closed) socket.destroy();
		return socket;
	};
	const pathOf = (url: string | undefined): string => (url ?? "").split("?")[0] ?? "";

	/** Admits one request, or says why not; nothing is dialed before this passes. */
	const admit = (
		req: http.IncomingMessage,
	):
		| { ok: true; url: URL; presented: { header: string; bearer: boolean } }
		| { ok: false; status: number; reason: string } => {
		if (closed) return { ok: false, status: 503, reason: "the model route is closed" };
		const raw = req.url ?? "";
		if (!raw.startsWith("/") || raw.startsWith("//"))
			return { ok: false, status: 421, reason: "only origin-form requests reach the model route" };
		// Only the worker's own dispatcher names the route this way; a rebound DNS name from a browser does not.
		const host = (req.headers.host ?? "").replace(/:\d+$/u, "").toLowerCase();
		if (!ROUTE_HOSTS.has(host)) return { ok: false, status: 421, reason: "the request did not address the model route" };
		const presented = presentedToken(req.headers);
		if (presented === null || !sameSecret(presented.token, surrogate))
			return { ok: false, status: 401, reason: "credential mismatch" };
		const url = new URL(raw, origin);
		if (url.origin !== origin.origin) return { ok: false, status: 421, reason: "the request left the admitted origin" };
		return { ok: true, url, presented };
	};

	const credentialFor = async (): Promise<ModelRouteCredential> => {
		const credential = await options.resolve();
		lastInjected = credential.apiKey;
		return credential;
	};

	const refresh = (): Promise<ModelRouteRefreshOutcome> => {
		const rejected = lastRejected ?? lastInjected;
		if (closed || rejected === null) return Promise.resolve("failed");
		const pending = refreshing.get(rejected);
		if (pending !== undefined) return pending;
		const outcome = (async (): Promise<ModelRouteRefreshOutcome> => {
			try {
				const credential = await options.resolve(rejected);
				lastInjected = credential.apiKey;
				return credential.apiKey === rejected ? "unchanged" : "refreshed";
			} catch {
				return "failed";
			}
		})();
		refreshing.set(rejected, outcome);
		void outcome.finally(() => refreshing.delete(rejected));
		return outcome;
	};

	const answerRefresh = (req: http.IncomingMessage, res: http.ServerResponse): void => {
		req.resume();
		if (req.method !== "POST") {
			record({ method: req.method ?? "GET", path: MODEL_ROUTE_REFRESH_PATH, status: 0, refused: "refresh requires POST" });
			res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "POST", connection: "close" });
			res.end("PanCode model route: refresh requires POST\n");
			return;
		}
		void refresh().then((outcome) => {
			record({ method: "POST", path: MODEL_ROUTE_REFRESH_PATH, status: 200, refresh: outcome });
			if (res.destroyed || res.writableEnded) return;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ outcome }));
		});
	};

	const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
		const admitted = admit(req);
		const method = req.method ?? "GET";
		if (!admitted.ok) {
			record({ method, path: pathOf(req.url), status: 0, refused: admitted.reason });
			req.resume();
			res.writeHead(admitted.status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
			res.end(`PanCode model route: ${admitted.reason}\n`);
			return;
		}
		if (admitted.url.pathname === MODEL_ROUTE_REFRESH_PATH) {
			answerRefresh(req, res);
			return;
		}
		const abort = new AbortController();
		aborts.add(abort);
		const finish = (): void => {
			aborts.delete(abort);
		};
		// A worker abort closes its socket before the response ends; the upstream request goes with it.
		res.once("close", () => {
			if (!res.writableFinished) abort.abort();
			finish();
		});
		void (async () => {
			let credential: ModelRouteCredential;
			try {
				credential = await credentialFor();
			} catch (error) {
				record({ method, path: admitted.url.pathname, status: 0, refused: "no credential" });
				req.resume();
				if (!res.headersSent) res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
				res.end(`PanCode model route: ${errorText(error)}\n`);
				return;
			}
			try {
				const { request } = await loadUndici();
				const bodyless = method === "GET" || method === "HEAD";
				const upstream = await request(admitted.url, {
					method: method as "GET",
					headers: upstreamHeaders(req.headers, admitted.presented, credential),
					...(bodyless ? {} : { body: req }),
					signal: abort.signal,
					// The worker's own timeouts govern; an abort on its side reaches here as a closed socket.
					headersTimeout: 0,
					bodyTimeout: 0,
				});
				record({ method, path: admitted.url.pathname, status: upstream.statusCode });
				if (upstream.statusCode === 401 || upstream.statusCode === 403) lastRejected = credential.apiKey;
				// A later worker asking after the retry succeeded must not rotate the working credential.
				else if (upstream.statusCode < 400 && credential.apiKey !== lastRejected) lastRejected = null;
				res.writeHead(upstream.statusCode, responseHeaders(upstream.headers));
				upstream.body.on("error", () => res.destroy());
				upstream.body.pipe(res);
			} catch (error) {
				if (abort.signal.aborted) return;
				record({ method, path: admitted.url.pathname, status: 0, refused: "upstream unreachable" });
				if (res.headersSent) {
					res.destroy();
					return;
				}
				res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				res.end(`PanCode model route: ${origin.origin} unreachable: ${errorText(error)}\n`);
			}
		})();
	};

	const refuseSocket = (socket: Duplex, status: number, reason: string): void => {
		socket.end(
			`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Refused"}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nPanCode model route: ${reason}\n`,
		);
		socket.destroy();
	};

	/** A WebSocket handshake is relayed as one; after 101 both sockets are spliced and no frame is read. */
	const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
		track(socket);
		const admitted = admit(req);
		if (!admitted.ok) {
			record({ method: req.method ?? "GET", path: pathOf(req.url), status: 0, upgrade: true, refused: admitted.reason });
			refuseSocket(socket, admitted.status, admitted.reason);
			return;
		}
		if (admitted.url.pathname === MODEL_ROUTE_REFRESH_PATH) {
			record({ method: "GET", path: MODEL_ROUTE_REFRESH_PATH, status: 0, upgrade: true, refused: "not relayed" });
			refuseSocket(socket, 400, "the refresh path takes no upgrade");
			return;
		}
		const abort = new AbortController();
		aborts.add(abort);
		socket.once("close", () => {
			abort.abort();
			aborts.delete(abort);
		});
		void (async () => {
			try {
				const credential = await credentialFor();
				const { upgrade } = await loadUndici();
				const headers = upstreamHeaders(req.headers, admitted.presented, credential);
				const protocol = typeof req.headers.upgrade === "string" ? req.headers.upgrade : "websocket";
				const upstream = await upgrade(admitted.url, {
					method: "GET",
					headers,
					protocol,
					signal: abort.signal,
				});
				track(upstream.socket);
				record({ method: "GET", path: admitted.url.pathname, status: 101, upgrade: true });
				const lines = ["HTTP/1.1 101 Switching Protocols"];
				for (const [name, value] of Object.entries(upstream.headers)) {
					if (value === undefined) continue;
					for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
				}
				socket.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head.length > 0) upstream.socket.write(head);
				socket.pipe(upstream.socket);
				upstream.socket.pipe(socket);
				socket.once("close", () => upstream.socket.destroy());
				upstream.socket.once("close", () => socket.destroy());
				socket.on("error", () => upstream.socket.destroy());
				upstream.socket.on("error", () => socket.destroy());
			} catch (error) {
				if (abort.signal.aborted) return;
				// The client falls back to its HTTP transport when the handshake fails before any frame.
				record({ method: "GET", path: admitted.url.pathname, status: 0, upgrade: true, refused: "upgrade failed" });
				refuseSocket(socket, 502, `${origin.origin} refused the upgrade: ${errorText(error)}`);
			}
		})();
	};

	const server = http.createServer();
	server.requestTimeout = 0;
	server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
	server.on("request", onRequest);
	server.on("upgrade", onUpgrade);
	server.on("connect", (_req: http.IncomingMessage, socket: Duplex) => {
		track(socket);
		record({ method: "CONNECT", path: "", status: 0, refused: "CONNECT is not served" });
		refuseSocket(socket, 405, "CONNECT is not served; this is a model route, not a proxy");
	});
	server.on("connection", (socket: net.Socket) => {
		track(socket);
		socket.on("error", () => socket.destroy());
	});
	server.on("clientError", (_error, socket) => socket.destroy());

	return {
		serve(listener) {
			if (closed) {
				listener.close();
				return;
			}
			listeners.add(listener);
			listener.on("connection", (socket: net.Socket) => {
				if (closed || sockets.size >= server.maxConnections) {
					socket.destroy();
					return;
				}
				server.emit("connection", socket);
			});
		},
		refresh,
		receipts: () => receipts.map((receipt) => ({ ...receipt })),
		close() {
			if (closed) return;
			closed = true;
			for (const listener of listeners) listener.close();
			listeners.clear();
			for (const abort of aborts) abort.abort();
			aborts.clear();
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			server.close();
		},
	};
}

/** A random token, base64url. */
function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}

/** Standard base64 with no padding, which both pi-ai's `atob` and a base64url decoder read. */
function jwtSegment(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64").replace(/=+$/u, "");
}

/** The ChatGPT account claim of a Codex access token, which the provider client sends as a header. Not a secret. */
function codexAccountId(token: string): string | null {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
		} | null;
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

/**
 * A per-launch surrogate in the shape the API's client checks before sending: a Codex token is a JWT whose account
 * claim the client reads, an Anthropic OAuth token keeps its `sk-ant-oat` prefix (pi-ai picks the OAuth header mode
 * by it), any other is opaque. It authorizes nothing outside its own route. Null when the real credential lacks
 * what the shape needs.
 */
export function modelRouteSurrogate(api: string, realApiKey: string): string | null {
	if (api === "openai-codex-responses") {
		const account = codexAccountId(realApiKey);
		if (account === null) return null;
		const header = jwtSegment({ alg: "none", typ: "JWT" });
		const payload = jwtSegment({ "https://api.openai.com/auth": { chatgpt_account_id: account }, pancode: "route" });
		return `${header}.${payload}.${randomToken()}`;
	}
	if (api === "anthropic-messages" && realApiKey.includes("sk-ant-oat"))
		return `sk-ant-oat01-pancode-route-${randomToken()}`;
	return `pancode-route-${randomToken()}`;
}
