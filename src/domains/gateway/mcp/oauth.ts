// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * OAuth 2.1 for remote MCP servers (MCP 2026-07-28 basic/authorization and
 * its discovery, client-registration and security pages): protected resource
 * metadata and authorization server discovery in the spec's orders, PKCE S256,
 * the `resource` indicator, RFC 9207 `iss` validation, dynamic registration,
 * and the code and refresh grants. Network access goes through an injected
 * fetch; nothing here stores, prompts or opens a browser.
 */

import { createHash, randomBytes } from "node:crypto";
import { isRecord } from "../../../core/type-guards.js";
import { mcpRemoteEndpoint } from "./remote.js";

/** A parsed `WWW-Authenticate` challenge: its scheme and lower-cased parameters. */
export interface McpAuthChallenge {
	scheme: string;
	params: Record<string, string>;
}

/** Validated protected resource metadata (RFC 9728). */
export interface McpProtectedResource {
	/** The resource identifier sent as `resource` on authorize and token requests. */
	resource: string;
	authorizationServers: string[];
	scopesSupported?: string[];
	/** Where it was read. */
	metadataUrl: string;
}

/** Validated authorization server metadata (RFC 8414 or OpenID Connect Discovery). */
export interface McpAuthorizationServer {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	scopesSupported?: string[];
	tokenEndpointAuthMethods?: string[];
	issParameterSupported: boolean;
	clientIdMetadataDocumentSupported: boolean;
	metadataUrl: string;
}

/** A client PanCode authenticates as with one authorization server. */
export interface McpOAuthClient {
	clientId: string;
	clientSecret?: string;
	authMethod: "none" | "client_secret_basic" | "client_secret_post";
}

/** What a token endpoint answered. */
export interface McpTokenResponse {
	access: string;
	refresh?: string;
	expiresAt?: number;
	scope?: string[];
}

/**
 * PanCode's hosted Client ID Metadata Document. Unset: it needs an HTTPS URL
 * PanCode serves, so clients register dynamically until one exists. When set,
 * an authorization server advertising `client_id_metadata_document_supported`
 * is given this URL as the client id.
 */
export const PANCODE_CLIENT_METADATA_URL: string | undefined = undefined;

/** The loopback port the browser returns to unless a declaration sets `oauth.redirectPort`. */
export const MCP_OAUTH_DEFAULT_REDIRECT_PORT = 33418;

const METADATA_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;

export class McpOAuthError extends Error {
	override name = "McpOAuthError";
}

/** `key=value` and `key="value"` parameters of a WWW-Authenticate challenge (RFC 9110 11.6.1). */
export function parseWwwAuthenticate(header: string | null): McpAuthChallenge | null {
	if (header === null) return null;
	const scheme = /^\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)/u.exec(header)?.[1];
	if (scheme === undefined) return null;
	const params: Record<string, string> = {};
	const pattern = /([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gu;
	for (const match of header.slice(header.indexOf(scheme) + scheme.length).matchAll(pattern)) {
		const key = (match[1] as string).toLowerCase();
		if (!Object.hasOwn(params, key)) params[key] = match[2]?.replace(/\\(.)/gu, "$1") ?? match[3] ?? "";
	}
	return { scheme, params };
}

/** The scope tokens of a space-separated `scope` value; malformed tokens are dropped. */
export function mcpScopeList(value: unknown): string[] {
	if (typeof value !== "string") return [];
	return [...new Set(value.split(" ").filter((token) => SCOPE_TOKEN.test(token)))];
}

/**
 * A URL in the form resource identifiers are compared in: parsed (so scheme
 * and host are lower case), no fragment, and no trailing slash unless a query
 * follows (basic/authorization, Canonical Server URI).
 */
export function mcpCanonicalResource(url: string | URL): string {
	const parsed = new URL(url);
	parsed.hash = "";
	const href = parsed.href;
	return parsed.search === "" && href.endsWith("/") ? href.slice(0, -1) : href;
}

/**
 * Whether a token for `resource` may go to `endpoint`: the same origin, and
 * the endpoint's path is the resource's path or lies under it. A grant is
 * only ever sent where this holds, so a token never reaches another resource.
 */
export function mcpResourceCovers(resource: string, endpoint: string): boolean {
	let base: URL;
	let target: URL;
	try {
		base = new URL(resource);
		target = new URL(endpoint);
	} catch {
		return false;
	}
	if (base.origin !== target.origin || base.search !== "") return false;
	const prefix = base.pathname.replace(/\/+$/u, "");
	const path = target.pathname.replace(/\/+$/u, "");
	return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** An https URL, or http on loopback: where every authorization endpoint must live (security considerations). */
function securedUrl(raw: unknown, what: string): string {
	if (typeof raw !== "string" || raw.length === 0) throw new McpOAuthError(`${what} is missing`);
	const checked = mcpRemoteEndpoint(raw);
	if (typeof checked === "string") throw new McpOAuthError(`${what} ${raw} ${checked}`);
	return checked.href;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function readText(response: Response): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > METADATA_BYTES) {
			await reader.cancel().catch(() => {});
			throw new McpOAuthError(
				`a response from ${response.url || "the authorization server"} exceeds ${METADATA_BYTES} bytes`,
			);
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** GET a metadata document; null for any answer other than a 200 JSON object. Redirects are not followed. */
async function getMetadata(
	fetchFn: typeof fetch,
	url: string,
	signal: AbortSignal | undefined,
): Promise<Record<string, unknown> | null> {
	let response: Response;
	try {
		response = await fetchFn(url, {
			method: "GET",
			headers: { Accept: "application/json" },
			redirect: "manual",
			signal: withTimeout(signal),
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new McpOAuthError(`cannot read ${url}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(await readText(response));
		return isRecord(parsed) ? parsed : null;
	} catch (error) {
		if (error instanceof McpOAuthError) throw error;
		return null;
	}
}

/**
 * Protected resource metadata for `endpoint` (authorization-server-discovery):
 * the `resource_metadata` a 401 named, else the well-known URI at the
 * endpoint's path, then at the root. RFC 9728 3.3: a document found by probing
 * must name exactly the resource its well-known URI was built from; one the
 * server pointed to may name the endpoint or a same-origin path above it,
 * since servers commonly name their origin.
 */
export async function discoverMcpProtectedResource(
	endpoint: string,
	challenge: McpAuthChallenge | null,
	fetchFn: typeof fetch,
	signal?: AbortSignal,
): Promise<McpProtectedResource> {
	const target = new URL(endpoint);
	const pointed = challenge?.params.resource_metadata;
	const candidates: Array<{ url: string; expect: string | null }> = [];
	if (pointed !== undefined && pointed.length > 0) {
		let resolved: string;
		try {
			resolved = new URL(pointed, target).href;
		} catch {
			throw new McpOAuthError(`the server's resource_metadata ${JSON.stringify(pointed)} is not a URL`);
		}
		candidates.push({ url: securedUrl(resolved, "the server's resource_metadata"), expect: null });
	} else {
		const path = target.pathname.replace(/\/+$/u, "");
		if (path !== "") {
			candidates.push({
				url: `${target.origin}/.well-known/oauth-protected-resource${path}`,
				expect: mcpCanonicalResource(`${target.origin}${path}`),
			});
		}
		candidates.push({ url: `${target.origin}/.well-known/oauth-protected-resource`, expect: target.origin });
	}
	for (const candidate of candidates) {
		const document = await getMetadata(fetchFn, candidate.url, signal);
		if (document === null) {
			if (candidate.expect === null) {
				throw new McpOAuthError(`the protected resource metadata the server named, ${candidate.url}, could not be read`);
			}
			continue;
		}
		if (typeof document.resource !== "string") {
			throw new McpOAuthError(`the protected resource metadata at ${candidate.url} names no resource`);
		}
		let named: string;
		try {
			named = mcpCanonicalResource(document.resource);
		} catch {
			throw new McpOAuthError(`the protected resource metadata at ${candidate.url} names a resource that is not a URL`);
		}
		if (candidate.expect !== null ? named !== candidate.expect : !mcpResourceCovers(named, endpoint)) {
			throw new McpOAuthError(
				`the protected resource metadata at ${candidate.url} is for ${document.resource}, not ${candidate.expect ?? endpoint}; PanCode does not use it`,
			);
		}
		const servers = stringList(document.authorization_servers)?.filter((server) => server.length > 0) ?? [];
		if (servers.length === 0) {
			throw new McpOAuthError(`the protected resource metadata at ${candidate.url} lists no authorization server`);
		}
		const scopes = stringList(document.scopes_supported)?.filter((scope) => SCOPE_TOKEN.test(scope));
		return {
			resource: document.resource,
			authorizationServers: servers,
			...(scopes !== undefined ? { scopesSupported: scopes } : {}),
			metadataUrl: candidate.url,
		};
	}
	throw new McpOAuthError(
		`${target.origin} publishes no protected resource metadata (tried ${candidates.map((candidate) => candidate.url).join(", ")})`,
	);
}

/**
 * Authorization server metadata for `issuer`, tried in the spec's order (RFC
 * 8414 then OpenID Connect, path-aware), held to RFC 8414 3.3: a document
 * whose `issuer` is not identical is never used. PKCE S256 must be listed.
 */
export async function discoverMcpAuthorizationServer(
	issuer: string,
	fetchFn: typeof fetch,
	signal?: AbortSignal,
): Promise<McpAuthorizationServer> {
	const base = new URL(securedUrl(issuer, "the authorization server issuer"));
	if (base.search !== "") throw new McpOAuthError(`the authorization server issuer ${issuer} carries a query`);
	const path = base.pathname.replace(/\/+$/u, "");
	const urls =
		path === ""
			? [`${base.origin}/.well-known/oauth-authorization-server`, `${base.origin}/.well-known/openid-configuration`]
			: [
					`${base.origin}/.well-known/oauth-authorization-server${path}`,
					`${base.origin}/.well-known/openid-configuration${path}`,
					`${base.origin}${path}/.well-known/openid-configuration`,
				];
	for (const url of urls) {
		const document = await getMetadata(fetchFn, url, signal);
		if (document === null) continue;
		if (document.issuer !== issuer) {
			throw new McpOAuthError(
				`the metadata at ${url} names issuer ${JSON.stringify(document.issuer)}, not ${issuer}; PanCode does not use it`,
			);
		}
		const methods = stringList(document.code_challenge_methods_supported);
		if (methods === undefined || !methods.includes("S256")) {
			throw new McpOAuthError(
				`authorization server ${issuer} does not list S256 in code_challenge_methods_supported; PanCode signs in only with PKCE S256`,
			);
		}
		const scopes = stringList(document.scopes_supported);
		const authMethods = stringList(document.token_endpoint_auth_methods_supported);
		return {
			issuer,
			authorizationEndpoint: securedUrl(document.authorization_endpoint, `${issuer}'s authorization_endpoint`),
			tokenEndpoint: securedUrl(document.token_endpoint, `${issuer}'s token_endpoint`),
			...(document.registration_endpoint !== undefined
				? { registrationEndpoint: securedUrl(document.registration_endpoint, `${issuer}'s registration_endpoint`) }
				: {}),
			...(scopes !== undefined ? { scopesSupported: scopes } : {}),
			...(authMethods !== undefined ? { tokenEndpointAuthMethods: authMethods } : {}),
			issParameterSupported: document.authorization_response_iss_parameter_supported === true,
			clientIdMetadataDocumentSupported: document.client_id_metadata_document_supported === true,
			metadataUrl: url,
		};
	}
	throw new McpOAuthError(`authorization server ${issuer} publishes no metadata (tried ${urls.join(", ")})`);
}

/**
 * The scopes to request (Scope Selection Strategy, Step-Up Authorization
 * Flow): the challenge's scopes are authoritative and always requested, with
 * the operator's added; without either, every scope the resource lists, else
 * none. Joined with what an earlier sign-in requested and what the server has
 * since challenged for. `offline_access` is added only when the authorization
 * server lists it.
 */
export function mcpOAuthScopes(input: {
	configured?: ReadonlyArray<string>;
	challenge: McpAuthChallenge | null;
	resource: McpProtectedResource;
	server: McpAuthorizationServer;
	previous?: ReadonlyArray<string>;
}): string[] {
	const challenged = mcpScopeList(input.challenge?.params.scope);
	const fallback = input.configured ?? (challenged.length > 0 ? [] : (input.resource.scopesSupported ?? []));
	const scopes = new Set([...challenged, ...fallback, ...(input.previous ?? [])]);
	if (input.server.scopesSupported?.includes("offline_access") === true) scopes.add("offline_access");
	return [...scopes];
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function mcpPkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function mcpOAuthState(): string {
	return randomBytes(24).toString("base64url");
}

/** `http://127.0.0.1:<port>/callback`, the redirect PanCode registers and listens on. */
export function mcpOAuthRedirectUri(port: number): string {
	return `http://127.0.0.1:${port}/callback`;
}

/**
 * Dynamic client registration (RFC 7591) as a native application that may
 * refresh. A refusal names the authorization server's reason and the
 * pre-registered alternative.
 */
export async function registerMcpOAuthClient(
	server: McpAuthorizationServer,
	redirectUri: string,
	fetchFn: typeof fetch,
	signal?: AbortSignal,
): Promise<McpOAuthClient> {
	if (server.registrationEndpoint === undefined) {
		throw new McpOAuthError(
			`authorization server ${server.issuer} offers no dynamic registration; register a client with it and declare oauth.issuer and oauth.clientId`,
		);
	}
	const response = await fetchFn(server.registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_name: "PanCode",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			application_type: "native",
		}),
		redirect: "manual",
		signal: withTimeout(signal),
	});
	const text = await readText(response);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	if (response.status !== 200 && response.status !== 201) {
		const reason = isRecord(body) ? oauthErrorText(body) : `HTTP ${response.status}`;
		throw new McpOAuthError(
			`authorization server ${server.issuer} refused PanCode's registration (${reason}); register a client with it and declare oauth.issuer and oauth.clientId`,
		);
	}
	if (!isRecord(body) || typeof body.client_id !== "string" || body.client_id.length === 0) {
		throw new McpOAuthError(`authorization server ${server.issuer} answered the registration without a client_id`);
	}
	const secret =
		typeof body.client_secret === "string" && body.client_secret.length > 0 ? body.client_secret : undefined;
	const method = body.token_endpoint_auth_method;
	return {
		clientId: body.client_id,
		...(secret !== undefined ? { clientSecret: secret } : {}),
		authMethod:
			secret === undefined ? "none" : method === "client_secret_post" ? "client_secret_post" : "client_secret_basic",
	};
}

/** How a pre-registered client with a secret authenticates at the token endpoint. */
export function mcpSecretAuthMethod(server: McpAuthorizationServer): "client_secret_basic" | "client_secret_post" {
	const methods = server.tokenEndpointAuthMethods;
	return methods === undefined || methods.includes("client_secret_basic") ? "client_secret_basic" : "client_secret_post";
}

/** The authorization request URL: code flow, PKCE S256, state and resource always; scope when there is one. */
export function mcpAuthorizationUrl(input: {
	server: McpAuthorizationServer;
	client: McpOAuthClient;
	redirectUri: string;
	codeChallenge: string;
	state: string;
	resource: string;
	scopes: ReadonlyArray<string>;
}): string {
	const url = new URL(input.server.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", input.client.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("code_challenge", input.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", input.state);
	url.searchParams.set("resource", input.resource);
	if (input.scopes.length > 0) url.searchParams.set("scope", input.scopes.join(" "));
	return url.href;
}

function oauthErrorText(body: Record<string, unknown>): string {
	const error = typeof body.error === "string" ? body.error : "error";
	const description = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
	return `${error}${description}`.slice(0, 300);
}

/**
 * The code from an authorization response, validated before any token
 * request (basic/authorization, Authorization Response Validation): the state
 * must match; a present `iss` must equal the recorded issuer by simple string
 * comparison; an absent one is refused only when the server advertises it.
 * On an `iss` mismatch the response's error fields are never acted on or shown.
 */
export function mcpAuthorizationCode(
	params: URLSearchParams,
	expected: { state: string; issuer: string; issParameterSupported: boolean },
): { code: string } | { refused: string } {
	if (params.get("state") !== expected.state) {
		return { refused: "the authorization response carries another sign-in's state; PanCode discarded it" };
	}
	const iss = params.get("iss");
	if (iss !== null && iss !== expected.issuer) {
		return {
			refused: `the authorization response names issuer ${JSON.stringify(iss)}, not ${expected.issuer}; PanCode discarded it and sent the code nowhere`,
		};
	}
	if (iss === null && expected.issParameterSupported) {
		return {
			refused: `the authorization response carries no iss although ${expected.issuer} advertises it; PanCode discarded it`,
		};
	}
	const error = params.get("error");
	if (error !== null) {
		const description = params.get("error_description");
		return {
			refused:
				`authorization server ${expected.issuer} refused the sign-in: ${error}${description ? `: ${description}` : ""}`.slice(
					0,
					400,
				),
		};
	}
	const code = params.get("code");
	if (code === null || code.length === 0) return { refused: "the authorization response carries no code" };
	return { code };
}

/** A token endpoint request: the grant's own fields, the resource, and the client's authentication. */
async function tokenRequest(
	tokenEndpoint: string,
	client: McpOAuthClient,
	fields: Record<string, string>,
	fetchFn: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<McpTokenResponse> {
	const body = new URLSearchParams(fields);
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
	if (client.authMethod === "client_secret_basic" && client.clientSecret !== undefined) {
		const encode = (value: string): string => encodeURIComponent(value).replace(/%20/gu, "+");
		headers.Authorization = `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret)}`).toString("base64")}`;
	} else {
		body.set("client_id", client.clientId);
		if (client.authMethod === "client_secret_post" && client.clientSecret !== undefined) {
			body.set("client_secret", client.clientSecret);
		}
	}
	const response = await fetchFn(tokenEndpoint, {
		method: "POST",
		headers,
		body: body.toString(),
		redirect: "manual",
		signal: withTimeout(signal),
	});
	const text = await readText(response);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	if (response.status !== 200) {
		throw new McpOAuthError(
			`the token endpoint refused the ${fields.grant_type} grant (${isRecord(parsed) ? oauthErrorText(parsed) : `HTTP ${response.status}`})`,
		);
	}
	if (!isRecord(parsed) || typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
		throw new McpOAuthError("the token endpoint answered without an access_token");
	}
	if (typeof parsed.token_type !== "string" || parsed.token_type.toLowerCase() !== "bearer") {
		throw new McpOAuthError(
			`the token endpoint issued a ${String(parsed.token_type)} token; PanCode sends only Bearer tokens`,
		);
	}
	const expiresIn = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : undefined;
	const scope = typeof parsed.scope === "string" ? mcpScopeList(parsed.scope) : undefined;
	return {
		access: parsed.access_token,
		...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
			? { refresh: parsed.refresh_token }
			: {}),
		...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
		...(scope !== undefined ? { scope } : {}),
	};
}

export function exchangeMcpAuthorizationCode(
	input: {
		tokenEndpoint: string;
		client: McpOAuthClient;
		code: string;
		verifier: string;
		redirectUri: string;
		resource: string;
	},
	fetchFn: typeof fetch,
	signal?: AbortSignal,
): Promise<McpTokenResponse> {
	return tokenRequest(
		input.tokenEndpoint,
		input.client,
		{
			grant_type: "authorization_code",
			code: input.code,
			redirect_uri: input.redirectUri,
			code_verifier: input.verifier,
			resource: input.resource,
		},
		fetchFn,
		signal,
	);
}

/** A refresh grant, bound to the same resource the token was issued for. */
export function refreshMcpAccessToken(
	input: { tokenEndpoint: string; client: McpOAuthClient; refresh: string; resource: string },
	fetchFn: typeof fetch,
	signal?: AbortSignal,
): Promise<McpTokenResponse> {
	return tokenRequest(
		input.tokenEndpoint,
		input.client,
		{ grant_type: "refresh_token", refresh_token: input.refresh, resource: input.resource },
		fetchFn,
		signal,
	);
}
