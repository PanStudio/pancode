// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The seam between the MCP protocol client and the channel that carries its
 * JSON-RPC messages. The protocol client owns ids, timeouts, the version
 * envelope and every MCP method; a transport owns the bytes, the peer's
 * lifetime and its teardown. The stdio transport runs a local server process;
 * the Streamable HTTP transport (http-transport.ts) reaches a remote one.
 */

import type { encodeJsonRpcMessage, JsonRpcMessage, McpError } from "./protocol.js";

export type McpOutboundMessage = Parameters<typeof encodeJsonRpcMessage>[0];

/**
 * How the process-group teardown ended. `complete: false` means members of
 * the group were still present when the post-SIGKILL bound passed; the id was
 * released all the same (see GroupPhase), so `pgid` is for the operator's
 * report, never for another signal.
 */
export type McpTeardownOutcome =
	| { complete: true }
	| { complete: false; reason: "group-survived-sigkill"; pgid: number; boundMs: number };

export type McpSendOutcome =
	| { kind: "queued" }
	/** The one message is larger than the outbound cap; nothing was queued and the transport is unharmed. */
	| { kind: "oversized"; bytes: number; cap: number }
	/** The peer stopped reading; the transport has already reported the fatal overload. */
	| { kind: "overloaded" };

/** One tool parameter a Streamable HTTP request mirrors into an `Mcp-Param-{name}` header (`x-mcp-header`). */
export interface McpParamHeader {
	/** The `{name}` part of the header, as the tool's inputSchema spells it. */
	name: string;
	/** The chain of `properties` keys from the arguments root to the parameter. */
	path: ReadonlyArray<string>;
}

export interface McpSendOptions {
	/** The request this message carries, so a request that settles unsent can be withdrawn. */
	requestId?: number;
	/** A `tools/call` request's mirrored parameters; only an HTTP transport reads them. */
	paramHeaders?: ReadonlyArray<McpParamHeader>;
	/** The message left this process for the peer. */
	onSent?: () => void;
	onError?: (error: Error) => void;
}

export interface McpTransportEvents {
	/** One inbound JSON-RPC message, in arrival order. */
	message(frame: JsonRpcMessage): void;
	/**
	 * The first error that ends the transport's usefulness: a spawn failure, an
	 * unbidden exit, a framing error, or a peer that stopped reading. `ended`
	 * says the peer is already gone, so the client need not close the transport
	 * to stop it.
	 */
	fatal(error: McpError, ended: boolean): void;
}

/**
 * What the protocol client settles with a transport that carries HTTP. Its
 * presence changes three things: the era is probed by waiting for the modern
 * request's answer rather than racing the handshake beside it, tools with an
 * invalid `x-mcp-header` are dropped from the listing, and a HeaderMismatch
 * answer is retried once after listing again.
 */
export interface McpHttpBinding {
	/** The era this server's origin answered in earlier in this process, or null when it must be probed. */
	cachedEra(): "modern" | "legacy" | null;
	/** The era the client settled on; the legacy era also names the revision the handshake negotiated. */
	settleEra(era: "modern" | "legacy", protocolVersion: string): void;
	/** The cached era proved wrong, so the next connection to the origin probes again. */
	forgetEra(): void;
}

export interface McpTransport {
	readonly pid: number | undefined;
	/** Set by a transport that carries HTTP; absent on stdio. */
	readonly http?: McpHttpBinding;
	/** Open the channel. False means it could not, and `fatal` has already said why. */
	start(): Promise<boolean>;
	/** True once start() has been called and got as far as creating the channel. */
	started(): boolean;
	/** Settles once an unbidden end has been reported through `fatal`; null while the peer has not ended on its own. */
	endReported(): Promise<void> | null;
	send(message: McpOutboundMessage, options?: McpSendOptions): McpSendOutcome;
	/** Drop a request's message if it is still waiting to be sent. */
	withdraw(requestId: number): void;
	/** Resolves with the teardown outcome; repeated calls share the first. */
	close(): Promise<McpTeardownOutcome>;
	/** Synchronous exit backstop. */
	killOwnedOnExit(): void;
	/** The teardown's outcome, null until one has run. */
	teardown(): McpTeardownOutcome | null;
	/** Bounded tail of what the peer wrote to its diagnostic channel. */
	stderrTail(): string;
}
