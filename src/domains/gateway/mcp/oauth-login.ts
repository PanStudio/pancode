// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Signing in to a remote MCP server with OAuth 2.1, run only when the
 * operator asks (`pancode mcp login`, `/mcp login`); a session or worker
 * renews a grant but never starts one. The browser returns to a loopback
 * listener on 127.0.0.1, or the operator pastes the URL it landed on; either
 * way the response is held to its state and issuer before its code is used.
 */

import type { RequestListener, Server } from "node:http";
import { listenLoopback, renderPage } from "../../../core/oauth-loopback.js";
import { openBrowser as openPlatformBrowser } from "../../../core/open-browser.js";
import { readPancodeVersion } from "../../../core/package-root.js";
import { type AuthStorage, openAuthStorage } from "../../providers/auth/index.js";
import { MCP_CLIENT_NAME } from "./client.js";
import type { McpOAuthSettings } from "./config.js";
import {
	discoverMcpAuthorizationServer,
	discoverMcpProtectedResource,
	exchangeMcpAuthorizationCode,
	MCP_OAUTH_DEFAULT_REDIRECT_PORT,
	type McpAuthChallenge,
	type McpOAuthClient,
	McpOAuthError,
	mcpAuthorizationCode,
	mcpAuthorizationUrl,
	mcpOAuthRedirectUri,
	mcpOAuthScopes,
	mcpOAuthState,
	mcpPkcePair,
	mcpSecretAuthMethod,
	PANCODE_CLIENT_METADATA_URL,
	parseWwwAuthenticate,
	registerMcpOAuthClient,
} from "./oauth.js";
import {
	type McpOAuthGrant,
	mcpOAuthClientSecret,
	mcpOAuthGrantFor,
	mcpOAuthRegistration,
	removeMcpOAuthGrants,
	storeMcpOAuthGrant,
	storeMcpOAuthRegistration,
} from "./oauth-grants.js";
import {
	MCP_META_CLIENT_CAPABILITIES,
	MCP_META_CLIENT_INFO,
	MCP_META_PROTOCOL_VERSION,
	MCP_MODERN_PROTOCOL_VERSION,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface McpOAuthLoginIO {
	/** One line for the operator: the sign-in URL, and what PanCode waits for. */
	notice(line: string): void;
	/** Open `url` in a local browser; false when there is none. */
	openBrowser?(url: string): boolean;
	/** The URL the browser landed on, pasted by an operator whose browser cannot reach this machine. */
	pasted?(signal: AbortSignal): Promise<string>;
	fetch?: typeof fetch;
	storage?: AuthStorage;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type McpOAuthLoginResult =
	| {
			kind: "signed-in";
			issuer: string;
			resource: string;
			requested: string[];
			granted?: string[];
			client: "configured" | "metadata document" | "registered" | "registered earlier";
			refreshable: boolean;
			expiresAt?: number;
	  }
	| { kind: "not-needed"; detail: string };

/**
 * POST a `server/discover` without credentials and read the Bearer challenge
 * it is refused with, if any. Nothing is sent but the generic client identity.
 */
async function probeChallenge(
	endpoint: string,
	fetchFn: typeof fetch,
	signal: AbortSignal,
): Promise<McpAuthChallenge | null> {
	const response = await fetchFn(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
			"Mcp-Method": "server/discover",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "pancode-sign-in-probe",
			method: "server/discover",
			params: {
				_meta: {
					[MCP_META_PROTOCOL_VERSION]: MCP_MODERN_PROTOCOL_VERSION,
					[MCP_META_CLIENT_INFO]: { name: MCP_CLIENT_NAME, version: readPancodeVersion() },
					[MCP_META_CLIENT_CAPABILITIES]: {},
				},
			},
		}),
		redirect: "manual",
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});
	await response.body?.cancel().catch(() => {});
	if (response.status !== 401) return null;
	const challenge = parseWwwAuthenticate(response.headers.get("www-authenticate"));
	return challenge?.scheme.toLowerCase() === "bearer" ? challenge : null;
}

/** Listen for the browser's return on 127.0.0.1 (and ::1) at the fixed port; a taken port names the setting that moves it. */
async function listenForReturn(
	port: number,
	serverId: string,
	accept: (params: URLSearchParams) => { ok: boolean; message: string },
): Promise<Server[]> {
	const handler: RequestListener = (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const send = (status: number, ok: boolean, message: string): void => {
			response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(renderPage(ok, message));
		};
		if (request.method !== "GET" || url.pathname !== "/callback") {
			send(404, false, "Callback route not found.");
			return;
		}
		const verdict = accept(url.searchParams);
		send(verdict.ok ? 200 : 400, verdict.ok, verdict.message);
	};
	try {
		return await listenLoopback(port, handler);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EADDRINUSE" || code === "EACCES") {
			throw new McpOAuthError(
				`port ${port} on 127.0.0.1, where the browser returns after sign-in, is taken; free it or set oauth.redirectPort for server ${serverId}`,
			);
		}
		throw error;
	}
}

/** The parameters of a pasted redirect URL, or of a bare query string. */
function pastedParams(input: string): URLSearchParams {
	const text = input.trim();
	try {
		return new URL(text).searchParams;
	} catch {
		return new URLSearchParams(text.startsWith("?") ? text.slice(1) : text);
	}
}

export async function mcpOAuthLogin(
	server: { id: string; url: string; oauth?: McpOAuthSettings },
	io: McpOAuthLoginIO,
): Promise<McpOAuthLoginResult> {
	const fetchFn = io.fetch ?? globalThis.fetch;
	const storage = io.storage ?? openAuthStorage();
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new McpOAuthError("the sign-in timed out")),
		io.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	const signal = io.signal === undefined ? controller.signal : AbortSignal.any([io.signal, controller.signal]);
	let servers: Server[] = [];
	try {
		const challenge = await probeChallenge(server.url, fetchFn, signal);
		let resource: Awaited<ReturnType<typeof discoverMcpProtectedResource>>;
		try {
			resource = await discoverMcpProtectedResource(server.url, challenge, fetchFn, signal);
		} catch (error) {
			if (challenge === null && error instanceof McpOAuthError) {
				return {
					kind: "not-needed",
					detail: `mcp server ${server.id} at ${new URL(server.url).origin} asked for no sign-in and publishes no protected resource metadata; PanCode connects to it without credentials`,
				};
			}
			throw error;
		}
		const issuer = server.oauth?.issuer ?? resource.authorizationServers[0];
		if (issuer === undefined || !resource.authorizationServers.includes(issuer)) {
			throw new McpOAuthError(
				`oauth.issuer ${issuer} is not one of the authorization servers ${resource.resource} names (${resource.authorizationServers.join(", ")})`,
			);
		}
		const as = await discoverMcpAuthorizationServer(issuer, fetchFn, signal);
		const port = server.oauth?.redirectPort ?? MCP_OAUTH_DEFAULT_REDIRECT_PORT;
		const redirectUri = mcpOAuthRedirectUri(port);

		const state = mcpOAuthState();
		const pkce = mcpPkcePair();
		let settle: (outcome: { code: string } | { refused: string }) => void = () => {};
		const returned = new Promise<{ code: string } | { refused: string }>((resolve) => {
			settle = resolve;
		});
		let finished = false;
		const judge = (params: URLSearchParams): { code: string } | { refused: string } =>
			mcpAuthorizationCode(params, { state, issuer, issParameterSupported: as.issParameterSupported });
		servers = await listenForReturn(port, server.id, (params) => {
			if (finished) return { ok: false, message: "This sign-in has already been handled." };
			// Another sign-in's state is a stale tab, not this one's answer: refuse it and keep waiting.
			if (params.get("state") !== state) return { ok: false, message: "This is not the sign-in PanCode is waiting for." };
			const outcome = judge(params);
			finished = true;
			settle(outcome);
			return "code" in outcome
				? { ok: true, message: `Signed in to ${server.id}. You can close this tab and return to PanCode.` }
				: { ok: false, message: outcome.refused };
		});

		let client: McpOAuthClient;
		let clientKind: "configured" | "metadata document" | "registered" | "registered earlier";
		let registeredFor: string | undefined;
		if (server.oauth?.clientId !== undefined) {
			const secret = mcpOAuthClientSecret(issuer, server.oauth.clientId, storage);
			client = {
				clientId: server.oauth.clientId,
				authMethod: secret === undefined ? "none" : mcpSecretAuthMethod(as),
				...(secret !== undefined ? { clientSecret: secret } : {}),
			};
			clientKind = "configured";
		} else if (PANCODE_CLIENT_METADATA_URL !== undefined && as.clientIdMetadataDocumentSupported) {
			client = { clientId: PANCODE_CLIENT_METADATA_URL, authMethod: "none" };
			clientKind = "metadata document";
		} else {
			const earlier = mcpOAuthRegistration(issuer, redirectUri, storage);
			if (earlier !== null) {
				client = earlier;
				clientKind = "registered earlier";
			} else {
				client = await registerMcpOAuthClient(as, redirectUri, fetchFn, signal);
				storeMcpOAuthRegistration(issuer, redirectUri, client, storage);
				clientKind = "registered";
			}
			registeredFor = redirectUri;
		}

		const prior = mcpOAuthGrantFor(server, storage)?.grant;
		const scopes = mcpOAuthScopes({
			...(server.oauth?.scopes !== undefined ? { configured: server.oauth.scopes } : {}),
			challenge,
			resource,
			server: as,
			...(prior !== undefined && prior.issuer === issuer ? { previous: [...prior.requested, ...prior.challenged] } : {}),
		});
		const authorizeUrl = mcpAuthorizationUrl({
			server: as,
			client,
			redirectUri,
			codeChallenge: pkce.challenge,
			state,
			resource: resource.resource,
			scopes,
		});
		const opened = (io.openBrowser ?? openPlatformBrowser)(authorizeUrl);
		io.notice(
			opened
				? `Opened the sign-in for ${server.id} at ${issuer} in your browser. If it did not appear, open: ${authorizeUrl}`
				: `Open this URL in a browser to sign in to ${server.id} at ${issuer}: ${authorizeUrl}`,
		);
		const aborted = new Promise<never>((_, reject) => {
			const fail = (): void =>
				reject(signal.reason instanceof Error ? signal.reason : new McpOAuthError("the sign-in was cancelled"));
			if (signal.aborted) fail();
			else signal.addEventListener("abort", fail, { once: true });
		});
		aborted.catch(() => {});
		const candidates: Array<Promise<{ code: string } | { refused: string }>> = [returned, aborted];
		if (io.pasted !== undefined) {
			const pasted = io.pasted(signal).then((input) => {
				if (finished) return new Promise<never>(() => {});
				finished = true;
				return judge(pastedParams(input));
			});
			pasted.catch(() => {});
			candidates.push(pasted);
		}
		const outcome = await Promise.race(candidates);
		if ("refused" in outcome) throw new McpOAuthError(outcome.refused);

		const tokens = await exchangeMcpAuthorizationCode(
			{
				tokenEndpoint: as.tokenEndpoint,
				client,
				code: outcome.code,
				verifier: pkce.verifier,
				redirectUri,
				resource: resource.resource,
			},
			fetchFn,
			signal,
		);
		removeMcpOAuthGrants(server.id, storage);
		const grant: Omit<McpOAuthGrant, "grantId"> = {
			serverId: server.id,
			issuer,
			resource: resource.resource,
			tokenEndpoint: as.tokenEndpoint,
			client: {
				clientId: client.clientId,
				authMethod: client.authMethod,
				...(registeredFor !== undefined ? { registeredFor } : {}),
			},
			access: tokens.access,
			...(tokens.refresh !== undefined ? { refresh: tokens.refresh } : {}),
			...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
			requested: scopes,
			...(tokens.scope !== undefined ? { granted: tokens.scope } : {}),
			challenged: [],
		};
		storeMcpOAuthGrant(grant, storage);
		return {
			kind: "signed-in",
			issuer,
			resource: resource.resource,
			requested: scopes,
			...(tokens.scope !== undefined ? { granted: tokens.scope } : {}),
			client: clientKind,
			refreshable: tokens.refresh !== undefined,
			...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
		};
	} finally {
		clearTimeout(timer);
		for (const listener of servers) {
			listener.close();
			listener.closeIdleConnections();
		}
	}
}
