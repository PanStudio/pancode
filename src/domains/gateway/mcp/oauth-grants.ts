// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The OAuth grants, client registrations and client secrets PanCode keeps
 * for remote MCP servers, in its credential store and never in a config file.
 * A grant belongs to one server id, one authorization server and one
 * resource, and its token is only ever sent inside that resource. A client
 * belongs to one authorization server and is never offered to another.
 */

import { randomUUID } from "node:crypto";
import { sha256Hex } from "../../../core/hash.js";
import { type AuthCredential, type AuthStorage, openAuthStorage } from "../../providers/auth/index.js";
import type { McpHttpAuthorizer } from "./http-transport.js";
import { type McpOAuthClient, mcpCanonicalResource, mcpResourceCovers, refreshMcpAccessToken } from "./oauth.js";

/** One sign-in to one server: the tokens and what they are for. */
export interface McpOAuthGrant {
	/** Minted at sign-in and kept across refreshes; a private catalog binds to it. */
	grantId: string;
	serverId: string;
	issuer: string;
	/** The validated resource the token was requested for and is sent within. */
	resource: string;
	tokenEndpoint: string;
	client: {
		clientId: string;
		authMethod: McpOAuthClient["authMethod"];
		/** Set for a dynamically registered client: the redirect it was registered with. */
		registeredFor?: string;
	};
	access: string;
	refresh?: string;
	/** Epoch ms. */
	expiresAt?: number;
	/** Epoch ms when proactive renewal starts (bounded for short-lived tokens). */
	refreshAt?: number;
	/** What the sign-in asked for. */
	requested: string[];
	/** What the authorization server said it granted, when it said. */
	granted?: string[];
	/** Scopes the server has since asked for with a 403, for the next sign-in. */
	challenged: string[];
}

/** A client registered dynamically with one authorization server for one redirect. */
interface StoredRegistration {
	clientId: string;
	clientSecret?: string;
	authMethod: McpOAuthClient["authMethod"];
}

const GRANT_PREFIX = "mcp-oauth:";
/** Refresh this long before the recorded expiry, for clock skew and request latency. */
const EXPIRY_MARGIN_MS = 60_000;

function mcpOAuthGrantRef(serverId: string, issuer: string, resource: string): string {
	return `${GRANT_PREFIX}${serverId}|${issuer}|${mcpCanonicalResource(resource)}`;
}

function mcpOAuthRegistrationRef(issuer: string, redirectUri: string): string {
	return `mcp-oauth-client:${issuer}|${redirectUri}`;
}

function mcpOAuthClientSecretRef(issuer: string, clientId: string): string {
	return `mcp-oauth-secret:${issuer}|${clientId}`;
}

function apiKeyEntry(value: string): AuthCredential {
	return { type: "api_key", key: value, updatedAt: new Date().toISOString() };
}

function checked(storage: AuthStorage, what: string): void {
	const damage = storage.damageReason();
	if (damage !== null) throw new Error(`the credential store refused ${what}: ${damage}`);
}

function parseGrant(credential: AuthCredential | undefined): McpOAuthGrant | null {
	if (credential?.type !== "api_key") return null;
	try {
		const parsed = JSON.parse(credential.key) as McpOAuthGrant;
		return typeof parsed.access === "string" && typeof parsed.resource === "string" && typeof parsed.grantId === "string"
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** Every grant stored for `serverId`. */
function mcpOAuthGrants(
	serverId: string,
	storage: AuthStorage = openAuthStorage(),
): Array<{ ref: string; grant: McpOAuthGrant }> {
	return storage.listStored().flatMap(({ providerId }) => {
		if (!providerId.startsWith(`${GRANT_PREFIX}${serverId}|`)) return [];
		const grant = parseGrant(storage.get(providerId));
		return grant !== null && grant.serverId === serverId ? [{ ref: providerId, grant }] : [];
	});
}

/**
 * The grant to send to `server`: one stored for its id whose resource covers
 * its url, from its declared issuer when it names one; the most specific
 * resource wins.
 */
export function mcpOAuthGrantFor(
	server: { id: string; url: string; oauth?: { issuer?: string } },
	storage: AuthStorage = openAuthStorage(),
): { ref: string; grant: McpOAuthGrant } | null {
	const issuer = server.oauth?.issuer;
	const usable = mcpOAuthGrants(server.id, storage)
		.filter(({ grant }) => mcpResourceCovers(grant.resource, server.url))
		.filter(({ grant }) => issuer === undefined || grant.issuer === issuer)
		.sort((a, b) => b.grant.resource.length - a.grant.resource.length);
	return usable[0] ?? null;
}

export function storeMcpOAuthGrant(
	grant: Omit<McpOAuthGrant, "grantId">,
	storage: AuthStorage = openAuthStorage(),
): McpOAuthGrant {
	const stored: McpOAuthGrant = { ...grant, grantId: randomUUID() };
	storage.set(mcpOAuthGrantRef(grant.serverId, grant.issuer, grant.resource), apiKeyEntry(JSON.stringify(stored)));
	checked(storage, "the sign-in");
	return stored;
}

/**
 * Remove every grant for `serverId`; returns how many. With `registrations`, a
 * dynamic registration a removed grant used goes too unless another server's
 * grant still uses it, so a registration the authorization server has
 * forgotten does not outlive a sign-out.
 */
export function removeMcpOAuthGrants(
	serverId: string,
	storage: AuthStorage = openAuthStorage(),
	registrations = false,
): number {
	const grants = mcpOAuthGrants(serverId, storage);
	for (const { ref } of grants) storage.remove(ref);
	if (registrations) {
		const inUse = new Set(
			storage
				.listStored()
				.flatMap(({ providerId }) => (providerId.startsWith(GRANT_PREFIX) ? [parseGrant(storage.get(providerId))] : []))
				.flatMap((grant) =>
					grant?.client.registeredFor !== undefined
						? [mcpOAuthRegistrationRef(grant.issuer, grant.client.registeredFor)]
						: [],
				),
		);
		for (const { grant } of grants) {
			if (grant.client.registeredFor === undefined) continue;
			const ref = mcpOAuthRegistrationRef(grant.issuer, grant.client.registeredFor);
			if (!inUse.has(ref)) storage.remove(ref);
		}
	}
	if (grants.length > 0) checked(storage, "the removal");
	return grants.length;
}

export function mcpOAuthRegistration(
	issuer: string,
	redirectUri: string,
	storage: AuthStorage = openAuthStorage(),
): McpOAuthClient | null {
	const credential = storage.get(mcpOAuthRegistrationRef(issuer, redirectUri));
	if (credential?.type !== "api_key") return null;
	try {
		const parsed = JSON.parse(credential.key) as StoredRegistration;
		if (typeof parsed.clientId !== "string") return null;
		return {
			clientId: parsed.clientId,
			authMethod: parsed.authMethod,
			...(typeof parsed.clientSecret === "string" ? { clientSecret: parsed.clientSecret } : {}),
		};
	} catch {
		return null;
	}
}

export function storeMcpOAuthRegistration(
	issuer: string,
	redirectUri: string,
	client: McpOAuthClient,
	storage: AuthStorage = openAuthStorage(),
): void {
	const record: StoredRegistration = {
		clientId: client.clientId,
		authMethod: client.authMethod,
		...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}),
	};
	storage.set(mcpOAuthRegistrationRef(issuer, redirectUri), apiKeyEntry(JSON.stringify(record)));
	checked(storage, "the client registration");
}

export function mcpOAuthClientSecret(
	issuer: string,
	clientId: string,
	storage: AuthStorage = openAuthStorage(),
): string | undefined {
	const credential = storage.get(mcpOAuthClientSecretRef(issuer, clientId));
	return credential?.type === "api_key" ? credential.key : undefined;
}

export function storeMcpOAuthClientSecret(
	issuer: string,
	clientId: string,
	secret: string,
	storage: AuthStorage = openAuthStorage(),
): void {
	storage.set(mcpOAuthClientSecretRef(issuer, clientId), apiKeyEntry(secret));
	checked(storage, "the client secret");
}

/** The client a grant refreshes as, with its secret read from where it is kept. */
function grantClient(grant: McpOAuthGrant, storage: AuthStorage): McpOAuthClient {
	const { clientId, authMethod, registeredFor } = grant.client;
	const secret =
		authMethod === "none"
			? undefined
			: registeredFor !== undefined
				? mcpOAuthRegistration(grant.issuer, registeredFor, storage)?.clientSecret
				: mcpOAuthClientSecret(grant.issuer, clientId, storage);
	return { clientId, authMethod, ...(secret !== undefined ? { clientSecret: secret } : {}) };
}

function mcpOAuthGrantExpired(grant: McpOAuthGrant, now = Date.now()): boolean {
	if (typeof grant.refreshAt === "number" && Number.isFinite(grant.refreshAt)) {
		return now >= grant.refreshAt;
	}
	return grant.expiresAt !== undefined && now + EXPIRY_MARGIN_MS >= grant.expiresAt;
}

/**
 * Renew a grant under the store's lock: adopt a token another process stored
 * since `rejected` was read, else spend the refresh token once. The renewed
 * grant keeps its id, resource and issuer. Null when it cannot be renewed.
 */
async function renewMcpOAuthGrant(
	ref: string,
	rejected: string,
	fetchFn: typeof fetch,
	storage: AuthStorage,
	signal?: AbortSignal,
): Promise<McpOAuthGrant | null> {
	let renewed: McpOAuthGrant | null = null;
	await storage.modifyLocked(
		ref,
		async (current) => {
			const grant = parseGrant(current);
			if (grant === null) return null;
			if (grant.access !== rejected && !mcpOAuthGrantExpired(grant)) {
				renewed = grant;
				return null;
			}
			if (grant.refresh === undefined) return null;
			const response = await refreshMcpAccessToken(
				{
					tokenEndpoint: grant.tokenEndpoint,
					client: grantClient(grant, storage),
					refresh: grant.refresh,
					resource: grant.resource,
				},
				fetchFn,
				signal,
			);
			const next: McpOAuthGrant = {
				...grant,
				access: response.access,
				// A server that rotates refresh tokens sends a new one; one that does not keeps the old valid.
				...(response.refresh !== undefined ? { refresh: response.refresh } : {}),
				...(response.scope !== undefined ? { granted: response.scope } : {}),
			};
			if (response.expiresAt !== undefined) next.expiresAt = response.expiresAt;
			else delete next.expiresAt;
			if (response.refreshAt !== undefined) next.refreshAt = response.refreshAt;
			else delete next.refreshAt;
			renewed = next;
			return apiKeyEntry(JSON.stringify(next));
		},
		signal,
	);
	return renewed;
}

/** The transport's view of a stored grant. Never starts a sign-in: a grant that cannot be renewed needs one. */
export function createMcpOAuthAuthorizer(
	ref: string,
	grant: McpOAuthGrant,
	fetchFn: typeof fetch = globalThis.fetch,
	storage: AuthStorage = openAuthStorage(),
): McpHttpAuthorizer {
	let current = grant;
	return {
		token: () => current.access,
		stale: () => mcpOAuthGrantExpired(current),
		covers: (url) => mcpResourceCovers(current.resource, url.href),
		renew: async (rejected, signal) => {
			try {
				const next = await renewMcpOAuthGrant(ref, rejected, fetchFn, storage, signal);
				if (next === null || next.access === rejected) return false;
				current = next;
				return true;
			} catch {
				return false;
			}
		},
		insufficientScope: async (scopes) => {
			const permanent = scopes.length > 0 && scopes.every((scope) => current.requested.includes(scope));
			if (!permanent && scopes.length > 0) {
				try {
					await storage.modifyLocked(ref, async (stored) => {
						const held = parseGrant(stored);
						if (held === null || held.grantId !== current.grantId) return null;
						const challenged = [...new Set([...held.challenged, ...scopes])];
						if (challenged.length === held.challenged.length) return null;
						current = { ...held, challenged };
						return apiKeyEntry(JSON.stringify(current));
					});
				} catch {
					// The scopes are named in the refusal either way; recording them only saves typing them.
				}
			}
			return { permanent };
		},
	};
}

/** What a remote server's private catalog binds to when it is signed in: the grant, not its rotating tokens. */
export function mcpOAuthCatalogBinding(
	server: { id: string; url: string; oauth?: { issuer?: string } },
	storage: AuthStorage = openAuthStorage(),
): string | null {
	const found = mcpOAuthGrantFor(server, storage);
	return found === null ? null : sha256Hex(JSON.stringify(["oauth", found.grant.issuer, found.grant.grantId]));
}
