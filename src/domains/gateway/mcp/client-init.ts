// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Session initialization: settling the protocol era once per client. The
 * stdio probe sends `server/discover` first and the legacy handshake beside
 * it after a short grace; Streamable HTTP waits for the probe's answer. A
 * modern server is asked for its list-change stream at once.
 */

import { sleep } from "../../../core/timers.js";
import { isRecord } from "../../../core/type-guards.js";
import type { McpClient, McpServerInfo, McpSubscriptionFilter } from "./client.js";
import {
	ELICITATION_CAPABILITY,
	errorMessage,
	freshnessOf,
	MCP_CLIENT_NAME,
	type McpSession,
	serverIdentity,
	serverText,
} from "./client-session.js";
import { mcpEventsOffered } from "./events.js";
import {
	MCP_HEADER_MISMATCH,
	MCP_META_SERVER_INFO,
	MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_OLDEST_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_UNSUPPORTED_PROTOCOL_VERSION,
	McpError,
} from "./protocol.js";
import { MCP_SKILLS_EXTENSION } from "./skills.js";
import { cutUtf8 } from "./tool-results.js";

/** Silence on the server/discover probe after which the legacy handshake is sent beside it. */
const DISCOVER_PROBE_GRACE_MS = 1_000;
/** Bytes of a server's instructions PanCode keeps and shows. */
export const MCP_INSTRUCTIONS_BYTES = 2048;

function boundedInstructions(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const marker = `\n[instructions truncated at ${MCP_INSTRUCTIONS_BYTES} bytes]`;
	return Buffer.byteLength(value, "utf8") <= MCP_INSTRUCTIONS_BYTES
		? value
		: `${cutUtf8(value, MCP_INSTRUCTIONS_BYTES - Buffer.byteLength(marker, "utf8"))}${marker}`;
}

function parseServerInfo(value: unknown, id: string): McpServerInfo | McpError {
	if (!isRecord(value)) return new McpError("protocol", "initialize result is not an object");
	if (typeof value.protocolVersion !== "string" || value.protocolVersion.length === 0) {
		return new McpError("protocol", "initialize result lacks a protocolVersion string");
	}
	const version = value.protocolVersion;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(version) || version < MCP_OLDEST_PROTOCOL_VERSION || version > MCP_PROTOCOL_VERSION) {
		return new McpError(
			"protocol",
			`mcp server ${id} answered protocolVersion ${serverText(JSON.stringify(version))}; PanCode speaks ${MCP_OLDEST_PROTOCOL_VERSION} through ${MCP_PROTOCOL_VERSION} in the initialize handshake, or ${MCP_MODERN_PROTOCOL_VERSION} through server/discover`,
		);
	}
	return {
		protocolVersion: version,
		serverInfo: serverIdentity(value.serverInfo),
		capabilities: isRecord(value.capabilities) ? value.capabilities : {},
		instructions: boundedInstructions(value.instructions),
	};
}

/**
 * Read a `server/discover` result. Null sends the client down the handshake
 * path: the answer is not a DiscoverResult (a lenient legacy server answering
 * an unknown method), or it lists no modern revision PanCode speaks.
 */
function parseDiscoverResult(value: unknown): McpServerInfo | null {
	if (!isRecord(value) || !Array.isArray(value.supportedVersions)) return null;
	if (!value.supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION)) return null;
	const meta = isRecord(value._meta) ? value._meta : {};
	return {
		protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
		serverInfo: serverIdentity(meta[MCP_META_SERVER_INFO]),
		capabilities: isRecord(value.capabilities) ? value.capabilities : {},
		instructions: boundedInstructions(value.instructions),
		ttlMs: freshnessOf(value.ttlMs),
	};
}

export interface McpInitialization {
	initialize(signal?: AbortSignal): Promise<McpServerInfo>;
	/** Initialize unless the client is already ready. */
	ensureReady(signal?: AbortSignal): Promise<void>;
	/** Run one discovery step under `signal`; aborting it fails and closes the client. */
	withDiscoverySignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T>;
}

export function createMcpInitialization(session: McpSession, subscribe: McpClient["subscribe"]): McpInitialization {
	const {
		id,
		transport,
		pending,
		initializeTimeoutMs,
		elicitationHandler,
		clientVersion,
		request,
		send,
		fail,
		close,
		closedError,
		noteListChanged,
	} = session;
	let initializePromise: Promise<McpServerInfo> | null = null;

	const withDiscoverySignal = async <T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
		const onAbort = (): void => {
			fail(new McpError("aborted", "MCP discovery aborted"));
			void close();
		};
		if (signal?.aborted) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal?.aborted) throw closedError();
			const result = await run();
			if (signal?.aborted) throw closedError();
			return result;
		} catch (error) {
			if (signal?.aborted) await close();
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	const initialize = (signal?: AbortSignal): Promise<McpServerInfo> =>
		withDiscoverySignal(signal, () => initializeOnce(signal));

	/**
	 * The stdio backward-compatibility probe of MCP 2026-07-28 (basic/transports/stdio):
	 * `server/discover` goes first. A DiscoverResult listing the modern revision
	 * makes the server modern. A recognized modern error means a modern server
	 * PanCode cannot speak to, and the spec forbids falling back to initialize then.
	 * Any other error answer, or silence until the initialize timeout, means a
	 * legacy server, and null sends the client down the handshake path.
	 */
	const discoverEra = async (
		signal?: AbortSignal,
		onId?: (requestId: number) => void,
	): Promise<McpServerInfo | null> => {
		let result: unknown;
		try {
			result = await request("server/discover", {}, initializeTimeoutMs, signal, onId);
		} catch (error) {
			const cause = error instanceof McpError ? error : new McpError("protocol", errorMessage(error));
			const answered = cause.code === "server" && isRecord(cause.data) ? cause.data : null;
			if (answered?.code === MCP_UNSUPPORTED_PROTOCOL_VERSION) {
				const data = isRecord(answered.data) ? answered.data : {};
				const supported = Array.isArray(data.supported) ? data.supported.map(String).join(", ") : "none listed";
				fail(
					new McpError(
						"protocol",
						`initialize failed: mcp server ${id} does not support MCP ${MCP_MODERN_PROTOCOL_VERSION} (it supports ${serverText(supported)})`,
						answered,
					),
				);
				await close();
				throw closedError();
			}
			// basic/versioning: these two are modern answers too, so a fallback to initialize is forbidden.
			if (answered?.code === MCP_MISSING_REQUIRED_CLIENT_CAPABILITY || answered?.code === MCP_HEADER_MISMATCH) {
				fail(
					new McpError(
						"protocol",
						`initialize failed: mcp server ${id} speaks MCP ${MCP_MODERN_PROTOCOL_VERSION} but refused server/discover: ${cause.message}`,
						answered,
					),
				);
				await close();
				throw closedError();
			}
			if (answered !== null || cause.code === "timeout") return null;
			fail(new McpError(cause.code, `initialize failed: ${cause.message}`, cause.data));
			await close();
			throw closedError();
		}
		return parseDiscoverResult(result);
	};

	/**
	 * A modern server is asked for the change stream at once, for each of
	 * tools, prompts and resources whose capability announces listChanged
	 * (MCP 2026-07-28 basic/patterns/subscriptions). The stream lives as long
	 * as this client; a restarted server gets a new client, which listens again.
	 */
	const listenForListChanges = (capabilities: Record<string, unknown>): void => {
		const announces = (key: string): boolean => isRecord(capabilities[key]) && capabilities[key].listChanged === true;
		const filter: McpSubscriptionFilter = {
			...(announces("tools") ? { toolsListChanged: true } : {}),
			...(announces("prompts") ? { promptsListChanged: true } : {}),
			...(announces("resources") ? { resourcesListChanged: true } : {}),
			...(mcpEventsOffered(capabilities)?.listChanged === true ? { eventsListChanged: true } : {}),
		};
		if (Object.keys(filter).length === 0) return;
		const stream = subscribe(filter, noteListChanged);
		stream.acknowledged.catch(() => {
			// A server that refuses or ends the stream still serves calls; the next discovery lists again.
		});
	};

	const initializeOnce = (signal?: AbortSignal): Promise<McpServerInfo> => {
		if (session.status === "closed" || session.status === "failed") return Promise.reject(closedError());
		if (initializePromise !== null) return initializePromise;
		initializePromise = (async () => {
			session.status = "starting";
			const started = await transport.start();
			if (!started) {
				await close();
				throw closedError();
			}
			let probeId: number | null = null;
			let handshakeId: number | null = null;
			const http = transport.http;
			const becomeModern = (discovered: McpServerInfo): McpServerInfo => {
				session.era = "modern";
				http?.settleEra("modern", MCP_MODERN_PROTOCOL_VERSION);
				session.info = discovered;
				if (session.status === "starting") session.status = "ready";
				listenForListChanges(discovered.capabilities);
				return discovered;
			};
			const handshake = (): Promise<unknown> =>
				request(
					"initialize",
					{
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: {
							extensions: { [MCP_SKILLS_EXTENSION]: {} },
							...(elicitationHandler !== undefined ? { elicitation: ELICITATION_CAPABILITY } : {}),
						},
						clientInfo: { name: MCP_CLIENT_NAME, version: clientVersion },
					},
					initializeTimeoutMs,
					signal,
					(assigned) => {
						handshakeId = assigned;
					},
				);
			if (http !== undefined) {
				// basic/transports/streamable-http, Backward Compatibility: the modern
				// request is answered before anything else is sent, and only an answer
				// that is not a recognized modern one sends the client to initialize.
				// An origin already found legacy in this process is not probed again.
				const cachedLegacy = http.cachedEra() === "legacy";
				const discovered = cachedLegacy ? null : await discoverEra(signal);
				if (discovered !== null) return becomeModern(discovered);
				let result: unknown;
				try {
					result = await handshake();
				} catch (error) {
					if (cachedLegacy) http.forgetEra();
					const cause = error instanceof McpError ? error : new McpError("protocol", errorMessage(error));
					fail(new McpError(cause.code, `initialize failed: ${cause.message}`, cause.data));
					await close();
					throw closedError();
				}
				const parsed = parseServerInfo(result, id);
				if (parsed instanceof McpError) {
					if (cachedLegacy) http.forgetEra();
					fail(new McpError("protocol", `initialize failed: ${parsed.message}`));
					await close();
					throw closedError();
				}
				session.info = parsed;
				// Every later POST carries the negotiated revision and the session, the initialized notification included.
				http.settleEra("legacy", parsed.protocolVersion);
				send({ jsonrpc: "2.0", method: "notifications/initialized" });
				if (session.status === "starting") session.status = "ready";
				return parsed;
			}
			// Many legacy servers drop an unknown method without answering, and
			// waiting out the whole initialize timeout for each of them would slow
			// every start. After a short grace the handshake goes out beside the
			// pending probe and the first decisive answer picks the era. Servers
			// read stdin in order, so a modern server that is merely slow to start
			// still answers the probe it read first.
			const probe = discoverEra(signal, (assigned) => {
				probeId = assigned;
			});
			probe.catch(() => {
				// Observed through the races below; a fatal probe has already failed the client.
			});
			const grace = new AbortController();
			const early = await Promise.race([
				probe.then((found) => ({ answered: true as const, found })),
				sleep(Math.min(DISCOVER_PROBE_GRACE_MS, initializeTimeoutMs), grace.signal).then(
					() => ({ answered: false as const, found: null }),
					() => ({ answered: false as const, found: null }),
				),
			]);
			grace.abort();
			let pendingHandshake: Promise<unknown> | null = null;
			let discovered = early.found;
			if (!early.answered) {
				const sent = handshake();
				pendingHandshake = sent;
				sent.catch(() => {
					// Awaited below when the server turns out to be legacy.
				});
				discovered = await Promise.race([
					probe,
					sent.then(
						() => null,
						() => probe,
					),
				]);
			}
			if (discovered !== null) {
				if (handshakeId !== null) pending.get(handshakeId)?.abandon();
				return becomeModern(discovered);
			}
			if (probeId !== null) pending.get(probeId)?.abandon();
			let result: unknown;
			try {
				result = await (pendingHandshake ?? handshake());
			} catch (error) {
				const cause = error instanceof McpError ? error : new McpError("protocol", errorMessage(error));
				fail(new McpError(cause.code, `initialize failed: ${cause.message}`, cause.data));
				await close();
				throw closedError();
			}
			const parsed = parseServerInfo(result, id);
			if (parsed instanceof McpError) {
				fail(new McpError("protocol", `initialize failed: ${parsed.message}`));
				await close();
				throw closedError();
			}
			session.info = parsed;
			send({ jsonrpc: "2.0", method: "notifications/initialized" });
			if (session.status === "starting") session.status = "ready";
			return parsed;
		})();
		return initializePromise;
	};

	const ensureReady = async (signal?: AbortSignal): Promise<void> => {
		if (session.status === "ready") return;
		await initialize(signal);
	};

	return { initialize, ensureReady, withDiscoverySignal };
}
