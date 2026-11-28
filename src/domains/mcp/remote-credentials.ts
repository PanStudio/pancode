// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The header credentials a remote MCP server is sent, kept in PanCode's
 * credential store and never in a config file. Each value is stored for the
 * one origin it was entered for (remote.ts mcpHeaderCredentialRef): a
 * declaration, trusted or not, that names the same key for any other origin
 * finds no value, so a repository cannot route a stored token elsewhere.
 */

import { sha256Hex } from "../../core/hash.js";
import { type AuthStorage, openAuthStorage } from "../providers/auth/index.js";
import { mcpOAuthCatalogBinding } from "./oauth-grants.js";
import { mcpHeaderCredentialRef, mcpOriginOf, parseMcpHeaderCredentialRef } from "./remote.js";

/** Cap on one stored header value. */
const MCP_HEADER_VALUE_BYTES = 8192;

/** The part of the credential store the MCP header credentials use. */
export interface McpHeaderCredentialStore {
	get(ref: string): string | undefined;
	set(ref: string, value: string): void;
	remove(ref: string): void;
	refs(): string[];
}

export function openMcpHeaderCredentialStore(storage: AuthStorage = openAuthStorage()): McpHeaderCredentialStore {
	return {
		get: (ref) => {
			const credential = storage.get(ref);
			return credential?.type === "api_key" ? credential.key : undefined;
		},
		set: (ref, value) => {
			storage.set(ref, { type: "api_key", key: value, updatedAt: new Date().toISOString() });
			const damage = storage.damageReason();
			if (damage !== null) throw new Error(`the credential store refused the write: ${damage}`);
		},
		remove: (ref) => {
			storage.remove(ref);
			const damage = storage.damageReason();
			if (damage !== null) throw new Error(`the credential store refused the removal: ${damage}`);
		},
		refs: () => storage.listStored().map((entry) => entry.providerId),
	};
}

/** Why `value` cannot be sent as a header value, or null. */
export function mcpHeaderValueRefusal(value: string): string | null {
	if (value.trim().length === 0) return "is empty";
	if (Buffer.byteLength(value, "utf8") > MCP_HEADER_VALUE_BYTES) {
		return `exceeds the ${MCP_HEADER_VALUE_BYTES}-byte cap`;
	}
	// RFC 9110 field-value: visible ASCII, spaces and tabs; no line breaks or controls.
	if (!/^[\t\x20-\x7e\x80-\xff]+$/u.test(value)) return "holds a line break or control character";
	return null;
}

/** One header a remote declaration sends, and the credential it is read from. */
export interface McpHeaderBinding {
	header: string;
	key: string;
	origin: string;
	/** Set when the value is stored for this origin. */
	stored: boolean;
	/** Other origins this key holds a value for, none of which is ever sent here. */
	elsewhere: string[];
}

export function mcpHeaderBindings(
	server: { url: string; headers: Readonly<Record<string, string>> },
	store: McpHeaderCredentialStore,
): McpHeaderBinding[] {
	const origin = mcpOriginOf(server.url);
	const refs = store.refs().flatMap((ref) => {
		const parsed = parseMcpHeaderCredentialRef(ref);
		return parsed === null ? [] : [parsed];
	});
	return Object.keys(server.headers)
		.sort()
		.map((header) => {
			const key = server.headers[header] as string;
			return {
				header,
				key,
				origin,
				stored: refs.some((ref) => ref.key === key && ref.origin === origin),
				elsewhere: refs.filter((ref) => ref.key === key && ref.origin !== origin).map((ref) => ref.origin),
			};
		});
}

/** Why a header's credential cannot be sent, naming the remedy and never a value. */
function missingCredentialText(id: string, binding: McpHeaderBinding): string {
	const elsewhere =
		binding.elsewhere.length > 0
			? `; the stored ${binding.key} was entered for ${binding.elsewhere.join(", ")}, and a credential is never sent to an origin it was not entered for`
			: "";
	return `mcp server ${id} sends credential ${binding.key} as ${binding.header} to ${binding.origin}, but no value of ${binding.key} is stored for ${binding.origin}${elsewhere}; the operator stores it with pancode mcp login ${id}`;
}

/**
 * The header values to send to a remote server, read for its own origin
 * only, or the first missing credential's explanation.
 */
export function resolveMcpHeaders(
	server: { id: string; url: string; headers: Readonly<Record<string, string>> },
	store: McpHeaderCredentialStore,
): { headers: Record<string, string> } | { missing: string } {
	const headers: Record<string, string> = {};
	for (const binding of mcpHeaderBindings(server, store)) {
		const value = binding.stored ? store.get(mcpHeaderCredentialRef(binding.key, binding.origin)) : undefined;
		if (value === undefined) return { missing: missingCredentialText(server.id, { ...binding, stored: false }) };
		headers[binding.header] = value;
	}
	return { headers };
}

/**
 * The digest a server's recorded catalog is bound to. A remote server's tool
 * listing may be private to the credentials that fetched it (MCP 2026-07-28
 * server/utilities/caching, `cacheScope`), so its catalog also binds the header
 * values in use: another credential, or none, reads no catalog and the next
 * live listing replaces it. A signed-in server's binds its OAuth grant, which
 * a refresh keeps and another sign-in replaces. A stdio server's catalog, and
 * an anonymous remote one's, binds its declaration only.
 */
export function mcpCatalogDigest(
	server: {
		id: string;
		digest: string;
		url?: string;
		headers?: Readonly<Record<string, string>>;
		oauth?: { issuer?: string };
	},
	store: () => McpHeaderCredentialStore = openMcpHeaderCredentialStore,
	grants: () => AuthStorage = openAuthStorage,
): string {
	if (server.url === undefined || server.headers === undefined) return server.digest;
	if (Object.keys(server.headers).length === 0) {
		const binding = mcpOAuthCatalogBinding(
			{ id: server.id, url: server.url, ...(server.oauth !== undefined ? { oauth: server.oauth } : {}) },
			grants(),
		);
		return binding === null ? server.digest : sha256Hex(JSON.stringify([server.digest, binding]));
	}
	const resolved = resolveMcpHeaders({ id: server.id, url: server.url, headers: server.headers }, store());
	const values =
		"headers" in resolved ? Object.entries(resolved.headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : null;
	return sha256Hex(JSON.stringify([server.digest, values]));
}
