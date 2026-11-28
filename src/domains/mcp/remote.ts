// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The rules a remote MCP server's declaration is held to, shared by the
 * config loader, the trust display, the CLI and the HTTP transport: which
 * endpoint URLs PanCode connects to, which header names a declaration may set,
 * and how a stored header credential is bound to the one origin it was
 * entered for. Pure; the credential store itself is in remote-credentials.ts.
 */

import { isHttpToken } from "./http-headers.js";

/** Hosts reached over plain http; every other endpoint needs TLS. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A credential key as the operator names it in `headers`. */
const MCP_CREDENTIAL_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/u;
export const MCP_CREDENTIAL_KEY_CHARS = 64;

/**
 * Headers the transport writes itself, so a declaration can never replace
 * them: the content negotiation, the MCP metadata headers a server validates
 * against the body, the legacy session, and the connection framing.
 */
const RESERVED_HEADERS = new Set([
	"accept",
	"connection",
	"content-length",
	"content-type",
	"host",
	"keep-alive",
	"last-event-id",
	"mcp-method",
	"mcp-name",
	"mcp-protocol-version",
	"mcp-session-id",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

/**
 * The endpoint a remote declaration names, or why PanCode refuses it: an
 * absolute http(s) URL without user info or fragment, over TLS unless the host
 * is this machine's loopback.
 */
export function mcpRemoteEndpoint(raw: string): URL | string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "is not an absolute URL";
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return "must be an http or https URL";
	if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
		return "must use https; plain http is allowed only for localhost, 127.0.0.1 and [::1]";
	}
	if (url.username !== "" || url.password !== "") {
		return "must not carry a user name or password; name a header credential instead";
	}
	if (url.hash !== "") return "must not carry a fragment";
	return url;
}

/** `scheme://host[:port]`, the unit a header credential is bound to and an era is cached for. */
export function mcpOriginOf(url: URL | string): string {
	return (typeof url === "string" ? new URL(url) : url).origin;
}

/** Why `name` cannot be a declared header, or null. */
export function mcpDeclaredHeaderRefusal(name: string): string | null {
	if (!isHttpToken(name)) return "is not an HTTP header name";
	const folded = name.toLowerCase();
	if (RESERVED_HEADERS.has(folded) || folded.startsWith("mcp-param-")) {
		return "is a header PanCode's MCP transport sets itself";
	}
	return null;
}

/** Why `key` cannot name a stored header credential, or null. */
export function mcpCredentialKeyRefusal(key: string): string | null {
	if (key.length === 0 || key.length > MCP_CREDENTIAL_KEY_CHARS || !MCP_CREDENTIAL_KEY_PATTERN.test(key)) {
		return `must match ${MCP_CREDENTIAL_KEY_PATTERN.source} in at most ${MCP_CREDENTIAL_KEY_CHARS} characters`;
	}
	return null;
}

/**
 * The credential store entry holding header credential `key` for `origin`.
 * The origin is part of the entry's identity, so a declaration that names the
 * same key for another origin finds no value to send there.
 */
export function mcpHeaderCredentialRef(key: string, origin: string): string {
	return `mcp-header:${key}@${origin}`;
}

/** The key and origin of a header credential entry, or null for any other entry. */
export function parseMcpHeaderCredentialRef(ref: string): { key: string; origin: string } | null {
	const match = /^mcp-header:([a-z0-9][a-z0-9_.-]*)@(https?:\/\/.+)$/u.exec(ref);
	return match === null ? null : { key: match[1] as string, origin: match[2] as string };
}

/** What the trust display says about each header credential a remote declaration sends. */
export function mcpCredentialRoutes(url: string, headers: Readonly<Record<string, string>>): string[] {
	const origin = mcpOriginOf(url);
	return Object.keys(headers)
		.sort()
		.map((header) => `sends credential ${headers[header]} as ${header} to ${origin}`);
}
