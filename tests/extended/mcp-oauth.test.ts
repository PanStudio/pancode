// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * OAuth 2.1 for remote MCP servers (basic/authorization), against an
 * in-process authorization server and resource reached through an injected
 * fetch: discovery order, the resource and issuer identity rules, PKCE S256,
 * the RFC 9207 response checks, scope choice, refresh, step-up and where the
 * token may go. Nothing leaves the process but the loopback listener the
 * sign-in waits on.
 */
import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	createMcpHttpClient,
	createMcpOAuthAuthorizer,
	discoverMcpAuthorizationServer,
	discoverMcpProtectedResource,
	exchangeMcpAuthorizationCode,
	type McpAuthorizationServer,
	type McpProtectedResource,
	mcpAuthorizationCode,
	mcpOAuthGrantFor,
	mcpOAuthScopes,
	parseWwwAuthenticate,
	storeMcpOAuthGrant,
} from "../../src/domains/mcp/index.js";
import { mcpOAuthLogin } from "../../src/domains/mcp/oauth-login.js";
import { AuthStorage, InMemoryAuthStorageBackend } from "../../src/domains/providers/auth/index.js";

const RS = "https://rs.example";
const AS = "https://as.example";
const ENDPOINT = `${RS}/mcp`;

interface Seen {
	method: string;
	url: string;
	authorization: string | null;
	body: string;
}

type Route = (request: Request, body: string) => Response | Promise<Response> | undefined;

/** A fetch that answers from `routes` (first defined answer wins, else 404) and records every request. */
function fakeFetch(routes: Route[]): { fetch: typeof fetch; seen: Seen[] } {
	const seen: Seen[] = [];
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = request.method === "GET" ? "" : await request.text();
		seen.push({ method: request.method, url: request.url, authorization: request.headers.get("authorization"), body });
		for (const route of routes) {
			const answer = await route(request, body);
			if (answer !== undefined) return answer;
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchFn, seen };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

const at =
	(url: string, answer: (request: Request, body: string) => Response | Promise<Response>): Route =>
	(request, body) =>
		request.url === url ? answer(request, body) : undefined;

const prm = (resource: string, extra: Record<string, unknown> = {}): Response =>
	json({ resource, authorization_servers: [AS], ...extra });

const asMetadata = (extra: Record<string, unknown> = {}): Response =>
	json({
		issuer: AS,
		authorization_endpoint: `${AS}/authorize`,
		token_endpoint: `${AS}/token`,
		registration_endpoint: `${AS}/register`,
		code_challenge_methods_supported: ["S256"],
		authorization_response_iss_parameter_supported: true,
		...extra,
	});

const resource: McpProtectedResource = {
	resource: ENDPOINT,
	authorizationServers: [AS],
	scopesSupported: ["mcp:read", "mcp:write"],
	metadataUrl: `${RS}/.well-known/oauth-protected-resource/mcp`,
};
const server: McpAuthorizationServer = {
	issuer: AS,
	authorizationEndpoint: `${AS}/authorize`,
	tokenEndpoint: `${AS}/token`,
	issParameterSupported: true,
	clientIdMetadataDocumentSupported: false,
	metadataUrl: `${AS}/.well-known/oauth-authorization-server`,
};

const memoryStorage = (): AuthStorage => new AuthStorage(new InMemoryAuthStorageBackend());

function grantIn(storage: AuthStorage, overrides: { access?: string; refresh?: string; requested?: string[] } = {}) {
	const grant = storeMcpOAuthGrant(
		{
			serverId: "docs",
			issuer: AS,
			resource: ENDPOINT,
			tokenEndpoint: `${AS}/token`,
			client: { clientId: "pancode-client", authMethod: "none" },
			access: overrides.access ?? "old-token",
			refresh: overrides.refresh ?? "refresh-1",
			requested: overrides.requested ?? ["mcp:read"],
			challenged: [],
		},
		storage,
	);
	const found = mcpOAuthGrantFor({ id: "docs", url: ENDPOINT }, storage);
	ok(found !== null && found.grant.grantId === grant.grantId);
	return found;
}

/** A modern MCP resource at ENDPOINT that accepts only `valid` tokens and answers tools/call by `call`. */
function mcpResource(valid: () => ReadonlySet<string>, call?: (name: string) => Response | undefined): Route {
	return (request, body) => {
		if (new URL(request.url).origin !== RS || request.method !== "POST") return undefined;
		const token = request.headers.get("authorization")?.replace(/^Bearer /u, "");
		if (token === undefined || !valid().has(token)) {
			return json({ error: "invalid_token" }, 401, {
				"www-authenticate": `Bearer resource_metadata="${RS}/.well-known/oauth-protected-resource/mcp"`,
			});
		}
		const message = JSON.parse(body) as { id: string | number; method: string; params?: { name?: string } };
		const reply = (result: unknown): Response => json({ jsonrpc: "2.0", id: message.id, result });
		if (message.method === "server/discover") {
			return reply({
				resultType: "complete",
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {} },
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-rs", version: "1.0" } },
			});
		}
		if (message.method === "tools/call") {
			const special = call?.(message.params?.name ?? "");
			if (special !== undefined) return special;
			return reply({ resultType: "complete", content: [{ type: "text", text: "ok" }] });
		}
		return reply({ resultType: "complete", tools: [{ name: "read", inputSchema: { type: "object" } }] });
	};
}

describe("discovery", () => {
	it("tries the 401's resource_metadata, else the path then the root well-known PRM", async () => {
		const pointed = fakeFetch([at(`${RS}/meta`, () => prm(RS))]);
		const named = await discoverMcpProtectedResource(
			ENDPOINT,
			{ scheme: "Bearer", params: { resource_metadata: `${RS}/meta` } },
			pointed.fetch,
		);
		strictEqual(named.resource, RS, "a PRM the server pointed to may name its origin");
		deepStrictEqual(
			pointed.seen.map((entry) => entry.url),
			[`${RS}/meta`],
		);
		const queried = fakeFetch([at(`${RS}/meta`, () => prm(`${ENDPOINT}?login`))]);
		const pointer = { scheme: "Bearer", params: { resource_metadata: `${RS}/meta` } };
		strictEqual(
			(await discoverMcpProtectedResource(`${ENDPOINT}?login`, pointer, queried.fetch)).resource,
			`${ENDPOINT}?login`,
		);
		await rejects(discoverMcpProtectedResource(`${ENDPOINT}?other`, pointer, queried.fetch), /PanCode does not use it/u);

		const probed = fakeFetch([at(`${RS}/.well-known/oauth-protected-resource`, () => prm(RS))]);
		await discoverMcpProtectedResource(ENDPOINT, null, probed.fetch);
		deepStrictEqual(
			probed.seen.map((entry) => entry.url),
			[`${RS}/.well-known/oauth-protected-resource/mcp`, `${RS}/.well-known/oauth-protected-resource`],
		);
	});

	it("uses a probed PRM only when it names exactly the resource it was probed for", async () => {
		const wrongPath = fakeFetch([at(`${RS}/.well-known/oauth-protected-resource/mcp`, () => prm(RS))]);
		await rejects(discoverMcpProtectedResource(ENDPOINT, null, wrongPath.fetch), /is for https:\/\/rs\.example, not/u);
		const otherOrigin = fakeFetch([at(`${RS}/meta`, () => prm("https://elsewhere.example/mcp"))]);
		await rejects(
			discoverMcpProtectedResource(
				ENDPOINT,
				{ scheme: "Bearer", params: { resource_metadata: `${RS}/meta` } },
				otherOrigin.fetch,
			),
			/PanCode does not use it/u,
		);
	});

	it("reads AS metadata path-aware, RFC 8414 before OpenID Connect", async () => {
		const issuer = `${AS}/tenant`;
		const { fetch, seen } = fakeFetch([]);
		await rejects(discoverMcpAuthorizationServer(issuer, fetch), /publishes no metadata/u);
		deepStrictEqual(
			seen.map((entry) => entry.url),
			[
				`${AS}/.well-known/oauth-authorization-server/tenant`,
				`${AS}/.well-known/openid-configuration/tenant`,
				`${AS}/tenant/.well-known/openid-configuration`,
			],
		);
	});

	it("refuses metadata for another issuer and an AS without PKCE S256", async () => {
		const wellKnown = `${AS}/.well-known/oauth-authorization-server`;
		const mismatch = fakeFetch([at(wellKnown, () => asMetadata({ issuer: "https://evil.example" }))]);
		await rejects(discoverMcpAuthorizationServer(AS, mismatch.fetch), /names issuer "https:\/\/evil\.example"/u);
		const plain = fakeFetch([at(wellKnown, () => asMetadata({ code_challenge_methods_supported: ["plain"] }))]);
		await rejects(discoverMcpAuthorizationServer(AS, plain.fetch), /only with PKCE S256/u);
	});
});

describe("authorization response (RFC 9207)", () => {
	const expected = { state: "s1", issuer: AS, issParameterSupported: true };
	const judge = (query: string, options = expected) => mcpAuthorizationCode(new URLSearchParams(query), options);

	it("checks state, then iss, before any error or code", () => {
		match((judge("state=other&code=c&iss=https%3A%2F%2Fas.example") as { refused: string }).refused, /state/u);
		const forged = judge("state=s1&iss=https%3A%2F%2Fevil.example&error=x&error_description=click%20here") as {
			refused: string;
		};
		match(forged.refused, /names issuer "https:\/\/evil\.example"/u);
		ok(!forged.refused.includes("click here"), "an iss mismatch never shows the response's error fields");
		match((judge("state=s1&code=c") as { refused: string }).refused, /carries no iss although/u);
		deepStrictEqual(judge("state=s1&code=c", { ...expected, issParameterSupported: false }), { code: "c" });
		match(
			(judge("state=s1&iss=https%3A%2F%2Fas.example&error=access_denied") as { refused: string }).refused,
			/refused the sign-in: access_denied/u,
		);
		deepStrictEqual(judge("state=s1&iss=https%3A%2F%2Fas.example&code=c"), { code: "c" });
	});
});

describe("scope choice", () => {
	it("requests the challenge's scopes with the configured ones, else the PRM's; offline_access only when listed", () => {
		const challenge = { scheme: "Bearer", params: { scope: "mcp:read" } };
		deepStrictEqual(mcpOAuthScopes({ configured: ["files"], challenge, resource, server }), ["mcp:read", "files"]);
		deepStrictEqual(mcpOAuthScopes({ configured: ["files"], challenge: null, resource, server }), ["files"]);
		deepStrictEqual(mcpOAuthScopes({ challenge, resource, server }), ["mcp:read"]);
		deepStrictEqual(mcpOAuthScopes({ challenge: null, resource, server }), ["mcp:read", "mcp:write"]);
		deepStrictEqual(mcpOAuthScopes({ challenge: null, resource: { ...resource, scopesSupported: [] }, server }), []);
		deepStrictEqual(
			mcpOAuthScopes({ challenge, resource, server: { ...server, scopesSupported: ["mcp:read", "offline_access"] } }),
			["mcp:read", "offline_access"],
		);
	});
});

describe("runtime grant", () => {
	it("refreshes once on a 401, bound to the same resource, and adopts a token another process stored", async () => {
		const storage = memoryStorage();
		const { ref, grant } = grantIn(storage);
		let valid = new Set(["new-token"]);
		const { fetch, seen } = fakeFetch([
			at(`${AS}/token`, () =>
				json({ access_token: "new-token", token_type: "Bearer", refresh_token: "refresh-2", expires_in: 3600 }),
			),
			mcpResource(() => valid),
		]);
		const authorizer = createMcpOAuthAuthorizer(ref, grant, fetch, storage);
		const client = createMcpHttpClient({ id: "docs", url: ENDPOINT, authorizer }, { workspaceRoot: "/", fetch });
		try {
			await client.initialize();
		} finally {
			await client.close();
		}
		const refreshes = seen.filter((entry) => entry.url === `${AS}/token`);
		strictEqual(refreshes.length, 1);
		const form = new URLSearchParams(refreshes[0]?.body);
		strictEqual(form.get("grant_type"), "refresh_token");
		strictEqual(form.get("resource"), ENDPOINT);
		const renewed = mcpOAuthGrantFor({ id: "docs", url: ENDPOINT }, storage)?.grant;
		strictEqual(renewed?.access, "new-token");
		strictEqual(renewed?.grantId, grant.grantId);
		strictEqual(renewed?.resource, ENDPOINT);

		// Another process signed in again meanwhile: the stale holder adopts its token without a refresh.
		storage.set(ref, { type: "api_key", key: JSON.stringify({ ...renewed, access: "newest" }), updatedAt: "" });
		valid = new Set(["newest"]);
		const before = seen.length;
		ok(await authorizer.renew("new-token", AbortSignal.timeout(5000)));
		strictEqual(authorizer.token(), "newest");
		strictEqual(seen.slice(before).filter((entry) => entry.url === `${AS}/token`).length, 0);
	});

	it("needs a sign-in after one failed refresh, without retrying", async () => {
		const storage = memoryStorage();
		const { ref, grant } = grantIn(storage);
		const { fetch, seen } = fakeFetch([
			at(`${AS}/token`, () => json({ error: "invalid_grant" }, 400)),
			mcpResource(() => new Set()),
		]);
		const client = createMcpHttpClient(
			{ id: "docs", url: ENDPOINT, authorizer: createMcpOAuthAuthorizer(ref, grant, fetch, storage) },
			{ workspaceRoot: "/", fetch },
		);
		try {
			await rejects(client.initialize(), /pancode mcp login docs/u);
		} finally {
			await client.close();
		}
		strictEqual(seen.filter((entry) => entry.url === `${AS}/token`).length, 1);
	});

	it("records challenged scopes for the next sign-in and stops at scopes it already asked for", async () => {
		const storage = memoryStorage();
		const { ref, grant } = grantIn(storage, { access: "t", requested: ["mcp:read"] });
		const stepUp = (scope: string) =>
			json({ error: "insufficient_scope" }, 403, {
				"www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
			});
		const { fetch } = fakeFetch([
			mcpResource(
				() => new Set(["t"]),
				(name) => (name === "write" ? stepUp("mcp:read mcp:write") : name === "again" ? stepUp("mcp:read") : undefined),
			),
		]);
		const client = createMcpHttpClient(
			{ id: "docs", url: ENDPOINT, authorizer: createMcpOAuthAuthorizer(ref, grant, fetch, storage) },
			{ workspaceRoot: "/", fetch },
		);
		try {
			await client.initialize();
			await rejects(client.callTool("write", {}), /mcp:write/u);
			deepStrictEqual(mcpOAuthGrantFor({ id: "docs", url: ENDPOINT }, storage)?.grant.challenged, [
				"mcp:read",
				"mcp:write",
			]);
		} finally {
			await client.close();
		}

		// The bound: a refusal for scopes the sign-in already requested fails that call and leaves the server up.
		const bounded = createMcpHttpClient(
			{ id: "docs", url: ENDPOINT, authorizer: createMcpOAuthAuthorizer(ref, grant, fetch, storage) },
			{ workspaceRoot: "/", fetch },
		);
		try {
			await bounded.initialize();
			await rejects(bounded.callTool("again", {}));
			strictEqual((await bounded.callTool("read", {})).content[0]?.type, "text");
		} finally {
			await bounded.close();
		}
	});

	it("never sends the token outside the resource it was issued for", async () => {
		const storage = memoryStorage();
		const { ref, grant } = grantIn(storage, { access: "t" });
		strictEqual(mcpOAuthGrantFor({ id: "docs", url: `${RS}/other` }, storage), null);
		strictEqual(mcpOAuthGrantFor({ id: "other", url: ENDPOINT }, storage), null);
		const { fetch, seen } = fakeFetch([
			(request) =>
				request.url === ENDPOINT && seen.length > 1
					? new Response(null, { status: 307, headers: { location: `${RS}/admin` } })
					: undefined,
			mcpResource(() => new Set(["t"])),
		]);
		const client = createMcpHttpClient(
			{ id: "docs", url: ENDPOINT, authorizer: createMcpOAuthAuthorizer(ref, grant, fetch, storage) },
			{ workspaceRoot: "/", fetch },
		);
		try {
			await client.initialize();
			await rejects(client.callTool("read", {}), /outside the resource its sign-in is for/u);
		} finally {
			await client.close();
		}
		deepStrictEqual(
			seen.filter((entry) => !entry.url.startsWith(ENDPOINT) && entry.authorization !== null),
			[],
		);
	});
});

describe("sign-in", () => {
	it("registers, sends PKCE S256 and the resource, and requests the union after a step-up", async () => {
		const storage = memoryStorage();
		const authorizations: URL[] = [];
		const { fetch, seen } = fakeFetch([
			at(ENDPOINT, () => json({}, 401, { "www-authenticate": `Bearer resource_metadata="${RS}/meta", scope="mcp:read"` })),
			at(`${RS}/meta`, () => prm(ENDPOINT, { scopes_supported: ["mcp:read", "mcp:write"] })),
			at(`${AS}/.well-known/oauth-authorization-server`, () => asMetadata()),
			at(`${AS}/register`, () => json({ client_id: "dcr-client", token_endpoint_auth_method: "none" }, 201)),
			at(`${AS}/token`, () => json({ access_token: "a", token_type: "bearer", expires_in: 60 })),
		]);
		const signIn = () =>
			mcpOAuthLogin(
				{ id: "docs", url: ENDPOINT, oauth: { redirectPort: 0 } },
				{
					notice: () => {},
					storage,
					fetch,
					openBrowser: (url) => {
						authorizations.push(new URL(url));
						return true;
					},
					pasted: async () => {
						const state = authorizations.at(-1)?.searchParams.get("state");
						return `http://127.0.0.1/callback?code=the-code&state=${state}&iss=${encodeURIComponent(AS)}`;
					},
				},
			);

		const first = await signIn();
		strictEqual(first.kind, "signed-in");
		const authorize = authorizations[0];
		strictEqual(authorize?.searchParams.get("code_challenge_method"), "S256");
		strictEqual(authorize?.searchParams.get("client_id"), "dcr-client");
		strictEqual(authorize?.searchParams.get("resource"), ENDPOINT);
		strictEqual(authorize?.searchParams.get("scope"), "mcp:read");
		const exchange = new URLSearchParams(seen.find((entry) => entry.url === `${AS}/token`)?.body);
		strictEqual(exchange.get("resource"), ENDPOINT);
		strictEqual(
			createHash("sha256")
				.update(exchange.get("code_verifier") ?? "")
				.digest("base64url"),
			authorize?.searchParams.get("code_challenge"),
		);

		const held = mcpOAuthGrantFor({ id: "docs", url: ENDPOINT }, storage);
		ok(held !== null);
		const authorizer = createMcpOAuthAuthorizer(held.ref, held.grant, fetch, storage);
		strictEqual(authorizer.stale(), false, "a 60s token is not immediately stale");
		await authorizer.insufficientScope(["mcp:write"]);
		await signIn();
		strictEqual(authorizations[1]?.searchParams.get("scope"), "mcp:read mcp:write");
		strictEqual(seen.filter((entry) => entry.url === `${AS}/register`).length, 1, "the registration is reused");
	});

	it("parses multi-challenge WWW-Authenticate, rejects loopback SSRF/fragments/duplicates, accepts null registration_endpoint, and encodes Basic per RFC 6749", async () => {
		const multi = parseWwwAuthenticate(
			`DPoP algs="ES256", Bearer resource_metadata="${RS}/meta", scope="mcp:read", Basic realm="other", error="insufficient_scope"`,
		);
		strictEqual(multi?.scheme, "Bearer");
		deepStrictEqual(multi?.params, { resource_metadata: `${RS}/meta`, scope: "mcp:read" });

		const afterToken68 = parseWwwAuthenticate(`Negotiate YII123==, Bearer error="insufficient_scope", scope="mcp:write"`);
		strictEqual(afterToken68?.scheme, "Bearer");
		deepStrictEqual(afterToken68?.params, { error: "insufficient_scope", scope: "mcp:write" });

		await rejects(
			discoverMcpProtectedResource(
				ENDPOINT,
				{ scheme: "Bearer", params: { resource_metadata: "http://127.0.0.1:9999/admin" } },
				fakeFetch([]).fetch,
			),
			/non-loopback/u,
		);
		await rejects(
			discoverMcpProtectedResource(
				ENDPOINT,
				{ scheme: "Bearer", params: { resource_metadata: `${RS}/meta` } },
				fakeFetch([at(`${RS}/meta`, () => prm(`${ENDPOINT}#frag`))]).fetch,
			),
			/fragment/u,
		);
		await rejects(
			discoverMcpProtectedResource(
				ENDPOINT,
				{ scheme: "Bearer", params: { resource_metadata: `${RS}/meta` } },
				fakeFetch([at(`${RS}/meta`, () => prm(ENDPOINT, { authorization_servers: ["http://127.0.0.1:9999"] }))]).fetch,
			),
			/non-loopback/u,
		);

		const asWithNullReg = await discoverMcpAuthorizationServer(
			AS,
			fakeFetch([at(`${AS}/.well-known/oauth-authorization-server`, () => asMetadata({ registration_endpoint: null }))])
				.fetch,
		);
		strictEqual(asWithNullReg.registrationEndpoint, undefined);

		const dup = mcpAuthorizationCode(new URLSearchParams("code=a&state=s&state=s2"), {
			state: "s",
			issuer: AS,
			issParameterSupported: false,
		});
		ok("refused" in dup);
		match(dup.refused, /repeats the state parameter/u);

		const ansiErr = mcpAuthorizationCode(
			new URLSearchParams(`state=s&error=access_denied&error_description=${encodeURIComponent("bad\u001b[31mred")}`),
			{ state: "s", issuer: AS, issParameterSupported: false },
		);
		ok("refused" in ansiErr);
		strictEqual(ansiErr.refused.includes("\u001b"), false);

		const { fetch: tokenFetch, seen: tokenSeen } = fakeFetch([
			at(`${AS}/token`, () => json({ access_token: "tok", token_type: "bearer", expires_in: 300 })),
		]);
		await exchangeMcpAuthorizationCode(
			{
				tokenEndpoint: `${AS}/token`,
				client: { clientId: "id!*", clientSecret: "sec'()", authMethod: "client_secret_basic" },
				code: "c",
				verifier: "v",
				redirectUri: "http://127.0.0.1:33418/callback",
				resource: ENDPOINT,
			},
			tokenFetch,
		);
		strictEqual(tokenSeen[0]?.authorization, `Basic ${Buffer.from("id%21%2A:sec%27%28%29").toString("base64")}`);
	});
});
