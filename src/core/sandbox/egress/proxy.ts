// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net, { isIP } from "node:net";
import tls from "node:tls";
import {
	type EgressGrants,
	type EgressOrigin,
	egressOrigin,
	isDeniedEgressAddress,
	isGrantedEgressOrigin,
	isLiteralEgressHost,
	originKey,
	type ResolvedAddress,
	screenResolvedAddresses,
} from "./policy.js";
import { EGRESS_UNGRANTED } from "./setup.js";

/** One distinct origin a launch tried, and what the proxy answered. No paths, queries, headers or payloads. */
export interface EgressReceipt {
	host: string;
	port: number;
	decision: "allowed" | "denied";
	reason?: string;
	count: number;
}

/** Asks the operator about one origin outside the grants; resolves true to admit it. */
export type EgressAsk = (origin: EgressOrigin) => Promise<boolean>;

export interface EgressProxyOptions {
	grants: EgressGrants;
	/** Attended main shell only. Absent denies every origin outside the grants without asking. */
	ask?: EgressAsk;
	/** What a denial tells the caller to change, appended to the denial reason. */
	denyHint?: string;
	/**
	 * `safety.egress.upstreamProxy`: allowed traffic leaves through this http(s)
	 * proxy, tunnels by CONNECT and plain requests in absolute form. Credentials
	 * in it become a Basic Proxy-Authorization and are never echoed.
	 */
	upstreamProxy?: string;
	lookup?: (host: string) => Promise<ResolvedAddress[]>;
	dial?: (address: string, port: number) => net.Socket;
}

export interface EgressProxy {
	/** Serves one listener received from the sandbox; the proxy owns and closes it. */
	serve(listener: net.Server): void;
	/** Serves one accepted client connection. */
	accept(socket: net.Socket): void;
	receipts(): EgressReceipt[];
	/** Closes the listener and destroys every client and upstream socket. */
	close(): void;
}

const MAX_RECEIPTS = 64;
const MAX_CONNECTIONS = 256;
const DIAL_TIMEOUT_MS = 30_000;
const SOCKS_VERSION = 0x05;

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

class EgressRefusal extends Error {
	readonly status: 403 | 502;
	constructor(status: 403 | 502, message: string) {
		super(message);
		this.status = status;
	}
}

async function defaultLookup(host: string): Promise<ResolvedAddress[]> {
	return await dnsLookup(host, { all: true, verbatim: true });
}

function defaultDial(address: string, port: number): net.Socket {
	return net.connect({ host: address, port });
}

interface UpstreamProxy {
	host: string;
	port: number;
	tls: boolean;
	authorization?: string;
}

function parseUpstreamProxy(value: string | undefined): UpstreamProxy | null {
	if (value === undefined) return null;
	const url = new URL(value);
	const secure = url.protocol === "https:";
	const user = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	return {
		host: url.hostname.replace(/^\[|\]$/gu, ""),
		port: Number(url.port || (secure ? 443 : 80)),
		tls: secure,
		...(user !== "" || password !== ""
			? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` }
			: {}),
	};
}

/** Waits for a dialled socket, or rejects as the proxy's 502 for `what`. */
function connected(socket: net.Socket, what: string, event: "connect" | "secureConnect" = "connect"): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new EgressRefusal(502, `PanCode egress could not reach ${what}: timed out`));
		}, DIAL_TIMEOUT_MS);
		socket.once(event, () => {
			clearTimeout(timer);
			resolve();
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(new EgressRefusal(502, `PanCode egress could not reach ${what}: ${error.message}`));
		});
	});
}

/** Reads the upstream proxy's answer to a CONNECT; any bytes after its head go back on the socket. */
function connectReply(socket: net.Socket, what: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let head = Buffer.alloc(0);
		const timer = setTimeout(() => fail("timed out"), DIAL_TIMEOUT_MS);
		const onClose = (): void => fail("connection closed");
		function fail(reason: string): void {
			clearTimeout(timer);
			socket.removeListener("data", onData);
			socket.removeListener("close", onClose);
			socket.destroy();
			reject(new EgressRefusal(502, `PanCode egress could not reach ${what} through the upstream proxy: ${reason}`));
		}
		function onData(chunk: Buffer): void {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n\r\n");
			if (end === -1) {
				if (head.length > 16_384) fail("oversized reply");
				return;
			}
			clearTimeout(timer);
			socket.removeListener("data", onData);
			socket.removeListener("close", onClose);
			socket.pause();
			const status = /^HTTP\/1\.[01] (\d{3})/u.exec(head.subarray(0, end).toString("latin1"))?.[1];
			if (status === undefined || !status.startsWith("2")) {
				fail(status === undefined ? "malformed reply" : `it answered ${status}`);
				return;
			}
			const rest = head.subarray(end + 4);
			if (rest.length > 0) socket.unshift(rest);
			resolve();
		}
		socket.on("data", onData);
		socket.once("close", onClose);
	});
}

/** Splits a CONNECT or SOCKS authority into an origin. */
function parseAuthority(authority: string): EgressOrigin | null {
	const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/u.exec(authority);
	if (match === null) return null;
	return egressOrigin(match[1] ?? "", Number(match[2]));
}

/** Splits an HTTP Host header into an origin, using `defaultPort` when no port is given. */
function parseHostHeader(header: string, defaultPort: number): EgressOrigin | null {
	const match = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d{1,5}))?$/u.exec(header.trim());
	if (match === null) return null;
	return egressOrigin(match[1] ?? "", match[2] === undefined ? defaultPort : Number(match[2]));
}

/** True when `Host` is absent or names the same canonical origin that was authorized. */
function hostHeaderMatches(header: string | undefined, origin: EgressOrigin, defaultPort: number): boolean {
	if (header === undefined) return true;
	const parsed = parseHostHeader(header, defaultPort);
	return parsed !== null && originKey(parsed) === originKey(origin);
}

/** Canonical Host header value for a plain HTTP origin. */
function canonicalHttpHost(origin: EgressOrigin): string {
	if (origin.port === 80) return origin.host.includes(":") ? `[${origin.host}]` : origin.host;
	return originKey(origin);
}

/**
 * The per-launch egress proxy. It answers HTTP CONNECT, absolute-form plain
 * HTTP and SOCKS5 CONNECT on one listener (the first byte tells them apart),
 * authorizes every tunnel and every plain request on its own against the
 * launch's grants, resolves a granted name once and dials the screened address.
 */
export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
	const lookup = options.lookup ?? defaultLookup;
	const dial = options.dial ?? defaultDial;
	const receipts = new Map<string, EgressReceipt>();
	const sockets = new Set<net.Socket>();
	const listeners = new Set<net.Server>();
	/** Origins the operator admitted or refused during this launch, so concurrent connections share one ask. */
	const decided = new Map<string, Promise<boolean>>();
	let closed = false;

	const track = (socket: net.Socket): net.Socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		return socket;
	};

	const record = (origin: EgressOrigin, decision: EgressReceipt["decision"], reason?: string): void => {
		const key = `${originKey(origin)} ${decision}`;
		const existing = receipts.get(key);
		if (existing !== undefined) existing.count += 1;
		else if (receipts.size < MAX_RECEIPTS)
			receipts.set(key, { host: origin.host, port: origin.port, decision, ...(reason ? { reason } : {}), count: 1 });
	};

	const deny = (origin: EgressOrigin, reason: string, grantable: boolean): never => {
		record(origin, "denied", reason);
		const hint = grantable && options.denyHint !== undefined ? `; ${options.denyHint}` : "";
		throw new EgressRefusal(403, `PanCode egress denied ${originKey(origin)}: ${reason}${hint}`);
	};

	const admitted = async (origin: EgressOrigin): Promise<boolean> => {
		if (isGrantedEgressOrigin(options.grants, origin)) return true;
		const ask = options.ask;
		if (ask === undefined) return false;
		const key = originKey(origin);
		let pending = decided.get(key);
		if (pending === undefined) {
			pending = ask(origin).catch(() => false);
			decided.set(key, pending);
		}
		return await pending;
	};

	const upstreamProxy = parseUpstreamProxy(options.upstreamProxy);
	const proxyLabel = upstreamProxy === null ? "" : `${upstreamProxy.host}:${upstreamProxy.port}`;

	const dialUpstreamProxy = async (): Promise<net.Socket> => {
		if (upstreamProxy === null) throw new EgressRefusal(502, "PanCode egress has no upstream proxy");
		const socket = upstreamProxy.tls
			? tls.connect({
					host: upstreamProxy.host,
					port: upstreamProxy.port,
					...(isIP(upstreamProxy.host) === 0 ? { servername: upstreamProxy.host } : {}),
				})
			: dial(upstreamProxy.host, upstreamProxy.port);
		track(socket);
		await connected(socket, `the upstream proxy ${proxyLabel}`, upstreamProxy.tls ? "secureConnect" : "connect");
		return socket;
	};

	/**
	 * Authorizes one origin and returns a connected socket: to the origin, or to
	 * the upstream proxy. A tunnel through the upstream proxy is already open;
	 * a plain request (`tunnel` false) goes to it in absolute form (`viaProxy`).
	 */
	const open = async (origin: EgressOrigin, tunnel: boolean): Promise<{ upstream: net.Socket; viaProxy: boolean }> => {
		// A local or private literal is refused unasked; only an explicit grant names one.
		if (
			isLiteralEgressHost(origin.host) &&
			isDeniedEgressAddress(origin.host) &&
			!isGrantedEgressOrigin(options.grants, origin)
		)
			return deny(origin, "a local or private address, reachable only through an explicit grant", true);
		if (!(await admitted(origin))) return deny(origin, EGRESS_UNGRANTED, true);
		let address: string;
		let unresolved = false;
		if (isLiteralEgressHost(origin.host)) address = origin.host;
		else {
			let answers: ResolvedAddress[];
			try {
				answers = await lookup(origin.host);
			} catch {
				answers = [];
			}
			// Behind an upstream proxy the host may resolve no public names at all; the upstream does, and the
			// name check above already admitted the origin. A name that does resolve here is still screened.
			if (answers.length === 0 && upstreamProxy !== null) {
				address = origin.host;
				unresolved = true;
			} else {
				const screened = screenResolvedAddresses(answers);
				if (!screened.ok) return deny(origin, screened.reason, false);
				address = screened.address.address;
			}
		}
		if (closed) throw new EgressRefusal(502, "PanCode egress proxy closed");
		const note = unresolved ? "not resolvable here; sent by name to the upstream proxy" : undefined;
		if (upstreamProxy !== null) {
			const socket = await dialUpstreamProxy();
			if (tunnel) {
				// By name, so the upstream proxy applies its own policy to what was asked for.
				const authority = originKey(origin);
				socket.write(
					`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${
						upstreamProxy.authorization !== undefined ? `Proxy-Authorization: ${upstreamProxy.authorization}\r\n` : ""
					}\r\n`,
				);
				await connectReply(socket, authority);
			}
			record(origin, "allowed", note);
			return { upstream: socket, viaProxy: !tunnel };
		}
		const upstream = track(dial(address, origin.port));
		await connected(upstream, originKey(origin));
		record(origin, "allowed");
		return { upstream, viaProxy: false };
	};

	const splice = (client: net.Socket, upstream: net.Socket): void => {
		client.pipe(upstream);
		upstream.pipe(client);
		client.once("close", () => upstream.destroy());
		upstream.once("close", () => client.destroy());
	};

	const httpServer = http.createServer();
	httpServer.requestTimeout = 0;
	httpServer.headersTimeout = 60_000;

	httpServer.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
		const origin = parseAuthority(req.url ?? "");
		if (origin === null || !hostHeaderMatches(req.headers.host, origin, origin.port)) {
			client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			return;
		}
		client.pause();
		open(origin, true).then(
			({ upstream }) => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length > 0) upstream.write(head);
				splice(client, upstream);
				client.resume();
			},
			(error: unknown) => {
				const refusal = error instanceof EgressRefusal ? error : new EgressRefusal(502, String(error));
				const body = `${refusal.message}\n`;
				client.end(
					`HTTP/1.1 ${refusal.status} ${refusal.status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
				);
			},
		);
	});

	httpServer.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
		let url: URL;
		try {
			url = new URL(req.url ?? "");
		} catch {
			res
				.writeHead(400, { "content-type": "text/plain", connection: "close" })
				.end("PanCode egress proxy: expected an absolute http:// URL\n");
			return;
		}
		const origin = url.protocol === "http:" ? egressOrigin(url.hostname, Number(url.port || 80)) : null;
		if (origin === null) {
			res
				.writeHead(400, { "content-type": "text/plain", connection: "close" })
				.end("PanCode egress proxy: only http:// requests and CONNECT tunnels\n");
			return;
		}
		if (!hostHeaderMatches(req.headers.host, origin, 80)) {
			res
				.writeHead(400, { "content-type": "text/plain", connection: "close" })
				.end("PanCode egress proxy: Host header does not match request URL\n");
			return;
		}
		const canonicalHost = canonicalHttpHost(origin);
		req.pause();
		open(origin, false).then(
			({ upstream, viaProxy }) => {
				const headers: http.OutgoingHttpHeaders = {};
				for (const [name, value] of Object.entries(req.headers)) {
					if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
				}
				if (req.headers["transfer-encoding"] !== undefined) headers["transfer-encoding"] = req.headers["transfer-encoding"];
				headers.host = canonicalHost;
				headers.connection = "close";
				if (viaProxy && upstreamProxy?.authorization !== undefined)
					headers["proxy-authorization"] = upstreamProxy.authorization;
				const forward = http.request({
					method: req.method,
					path: viaProxy ? `http://${canonicalHost}${url.pathname}${url.search}` : `${url.pathname}${url.search}`,
					headers,
					setHost: false,
					createConnection: () => upstream,
				});
				forward.on("response", (response) => {
					const out: http.OutgoingHttpHeaders = {};
					for (const [name, value] of Object.entries(response.headers)) {
						if (!HOP_BY_HOP.has(name) && value !== undefined) out[name] = value;
					}
					res.writeHead(response.statusCode ?? 502, response.statusMessage, out);
					response.pipe(res);
				});
				forward.on("error", (error) => {
					if (!res.headersSent)
						res.writeHead(502, { "content-type": "text/plain" }).end(`PanCode egress: ${error.message}\n`);
					else res.destroy();
				});
				req.pipe(forward);
				req.resume();
			},
			(error: unknown) => {
				const refusal = error instanceof EgressRefusal ? error : new EgressRefusal(502, String(error));
				res.writeHead(refusal.status, { "content-type": "text/plain" }).end(`${refusal.message}\n`);
				req.resume();
			},
		);
	});

	httpServer.on("clientError", (_error, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		else socket.destroy();
	});

	/** SOCKS5, no authentication, CONNECT only. */
	const socks = (client: net.Socket, first: Buffer): void => {
		let buffer = first;
		let stage: "greeting" | "request" | "done" = "greeting";
		const reply = (code: number): void => {
			client.write(Buffer.from([SOCKS_VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
		};
		const fail = (code: number): void => {
			stage = "done";
			client.removeListener("data", onData);
			reply(code);
			client.end();
		};
		const step = (): void => {
			if (stage === "greeting") {
				if (buffer.length < 2) return;
				const methods = buffer[1] ?? 0;
				if (buffer.length < 2 + methods) return;
				const offered = buffer.subarray(2, 2 + methods);
				buffer = buffer.subarray(2 + methods);
				if (!offered.includes(0x00)) {
					stage = "done";
					client.end(Buffer.from([SOCKS_VERSION, 0xff]));
					return;
				}
				client.write(Buffer.from([SOCKS_VERSION, 0x00]));
				stage = "request";
			}
			if (stage !== "request" || buffer.length < 5) return;
			const [version, command, , type] = buffer;
			if (version !== SOCKS_VERSION) {
				fail(0x01);
				return;
			}
			let host: string;
			let end: number;
			if (type === 0x01) {
				end = 4 + 4;
				if (buffer.length < end + 2) return;
				host = [...buffer.subarray(4, 8)].join(".");
			} else if (type === 0x04) {
				end = 4 + 16;
				if (buffer.length < end + 2) return;
				const groups: string[] = [];
				for (let i = 4; i < end; i += 2) groups.push(buffer.readUInt16BE(i).toString(16));
				host = groups.join(":");
			} else if (type === 0x03) {
				const length = buffer[4] ?? 0;
				end = 5 + length;
				if (buffer.length < end + 2) return;
				host = buffer.subarray(5, end).toString("utf8");
			} else {
				fail(0x08);
				return;
			}
			const port = buffer.readUInt16BE(end);
			const rest = buffer.subarray(end + 2);
			// UDP ASSOCIATE and BIND would carry traffic the proxy cannot authorize per origin.
			if (command !== 0x01) {
				fail(0x07);
				return;
			}
			const origin = egressOrigin(host, port);
			if (origin === null) {
				fail(0x04);
				return;
			}
			stage = "done";
			client.removeListener("data", onData);
			client.pause();
			open(origin, true).then(
				({ upstream }) => {
					reply(0x00);
					if (rest.length > 0) upstream.write(rest);
					splice(client, upstream);
					client.resume();
				},
				(error: unknown) => {
					const status = error instanceof EgressRefusal ? error.status : 502;
					reply(status === 403 ? 0x02 : 0x05);
					client.end();
				},
			);
		};
		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > 600) {
				fail(0x01);
				return;
			}
			step();
		};
		client.on("data", onData);
		step();
	};

	const accept = (socket: net.Socket): void => {
		if (closed || sockets.size >= MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		track(socket);
		socket.once("readable", () => {
			const chunk = socket.read() as Buffer | null;
			if (chunk === null || chunk.length === 0) {
				socket.destroy();
				return;
			}
			if (chunk[0] === SOCKS_VERSION) socks(socket, chunk);
			else {
				socket.unshift(chunk);
				httpServer.emit("connection", socket);
			}
		});
	};

	return {
		serve(listener) {
			if (closed) {
				listener.close();
				return;
			}
			listeners.add(listener);
			listener.on("connection", accept);
			listener.on("error", () => listener.close());
		},
		accept,
		receipts: () => [...receipts.values()].map((receipt) => ({ ...receipt })),
		close() {
			if (closed) return;
			closed = true;
			for (const listener of listeners) listener.close();
			listeners.clear();
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			httpServer.close();
		},
	};
}
