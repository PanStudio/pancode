// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * PanCode-owned browser sign-in for the OpenAI and Anthropic subscription flows.
 *
 * pi-ai answers the loopback redirect with its own branded page from a server
 * PanCode cannot configure, and pi-ai ships as an external dependency, so a
 * dependency patch would never reach npm installs. PanCode serves the redirect
 * itself instead. The OpenAI flow keeps pi's login and hands it the redirect;
 * the Anthropic browser flow runs here because pi's version falls back to a
 * free port PanCode cannot hold. Token refresh stays pi's for both.
 */

import { createHash, randomBytes } from "node:crypto";
import type { RequestListener } from "node:http";
import type { AuthPrompt, OAuthCredentials, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { listenLoopback, renderPage } from "../core/oauth-loopback.js";

interface OAuthCallback {
	redirectUri: string;
	/** Resolves with the redirect URL once the browser returns a code carrying the expected state. */
	wait(): Promise<string>;
	close(): void;
}

async function startOAuthCallback(options: {
	providerName: string;
	port: number;
	path: string;
	/** Undefined until the authorize URL exists; every callback is refused until then. */
	expectedState: () => string | undefined;
	signal: AbortSignal;
}): Promise<OAuthCallback> {
	const { providerName, signal } = options;
	if (signal.aborted) throw new Error("Login cancelled");
	let settled = false;
	let redirectUri = "";
	let resolveWait: (url: string) => void = () => {};
	let rejectWait: (error: Error) => void = () => {};
	const waitPromise = new Promise<string>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	// A login finished through the pasted URL never observes this wait.
	waitPromise.catch(() => undefined);
	const fail = (error: Error): void => {
		if (settled) return;
		settled = true;
		rejectWait(error);
	};
	const handler: RequestListener = (request, response) => {
		const send = (status: number, html: string): void => {
			response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(html);
		};
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method !== "GET" || url.pathname !== options.path) {
			send(404, renderPage(false, "Callback route not found."));
			return;
		}
		const expected = options.expectedState();
		if (expected === undefined || url.searchParams.get("state") !== expected) {
			send(400, renderPage(false, "State mismatch."));
			return;
		}
		if (settled) {
			send(409, renderPage(false, "This sign-in has already been handled."));
			return;
		}
		const error = url.searchParams.get("error");
		if (error) {
			const description = url.searchParams.get("error_description") ?? error;
			send(400, renderPage(false, `${providerName} authorization failed.`, description));
			fail(new Error(`${providerName} authorization failed: ${description}`));
			return;
		}
		if (!url.searchParams.get("code")) {
			send(400, renderPage(false, "Missing authorization code."));
			return;
		}
		settled = true;
		send(200, renderPage(true, `Signed in to ${providerName}. You can close this tab and return to PanCode.`));
		resolveWait(`${redirectUri}${url.search}`);
	};
	const servers = await listenLoopback(options.port, handler);
	const address = servers[0]?.address();
	if (!address || typeof address === "string") {
		for (const server of servers) server.close();
		throw new Error("OAuth callback server did not bind to TCP");
	}
	redirectUri = `http://localhost:${address.port}${options.path}`;
	const onAbort = (): void => fail(new Error("Login cancelled"));
	signal.addEventListener("abort", onAbort, { once: true });
	for (const server of servers) server.on("error", (error) => fail(error));
	return {
		redirectUri,
		wait: () => waitPromise,
		close: () => {
			signal.removeEventListener("abort", onAbort);
			fail(new Error("OAuth callback server closed"));
			for (const server of servers) {
				server.close();
				// A browser keep-alive socket would otherwise hold a one-shot CLI login open.
				server.closeIdleConnections();
			}
		},
	};
}

/** Whichever arrives first wins; Promise.race observes the loser, so its later rejection stays handled. */
function callbackOrPasted(
	interaction: ProviderAuthInteraction,
	callback: OAuthCallback | undefined,
	prompt: Extract<AuthPrompt, { type: "manual_code" }>,
): Promise<string> {
	const pasted = interaction.prompt(prompt);
	return callback ? Promise.race([callback.wait(), pasted]) : pasted;
}

/**
 * OpenAI's Codex client accepts only the fixed http://localhost:1455/auth/callback
 * redirect, and pi-ai 1.5.2 continues through its pasted-URL prompt when it
 * cannot bind that port. PanCode binds it first, once the operator picks browser
 * login, and answers that prompt with the redirect; pi still checks the state
 * and exchanges the code. Recheck this handoff on every Pi upgrade.
 */
export async function withCodexCallbackHandoff(
	interaction: ProviderAuthInteraction,
	login: (interaction: ProviderAuthInteraction) => Promise<OAuthCredentials>,
): Promise<OAuthCredentials> {
	let callback: OAuthCallback | undefined;
	let state: string | undefined;
	const handoff: ProviderAuthInteraction = {
		signal: interaction.signal,
		notify(event) {
			if (event.type === "auth_url") state = new URL(event.url).searchParams.get("state") ?? undefined;
			interaction.notify(event);
		},
		async prompt(prompt) {
			if (prompt.type === "manual_code") return callbackOrPasted(interaction, callback, prompt);
			const answer = await interaction.prompt(prompt);
			if (prompt.type === "select" && answer === "browser" && !callback) {
				// When the Codex CLI holds the port, pi cannot bind it either and asks for the pasted URL.
				callback = await startOAuthCallback({
					providerName: "OpenAI",
					port: 1455,
					path: "/auth/callback",
					expectedState: () => state,
					signal: interaction.signal,
				}).catch(() => undefined);
			}
			return answer;
		},
	};
	try {
		return await login(handoff);
	} finally {
		callback?.close();
	}
}

// Mirrors pi-ai 1.5.2 dist/auth/oauth/anthropic.js. Recheck these on every Pi upgrade.
const ANTHROPIC_CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_CALLBACK_PORT = 53692;
const ANTHROPIC_CALLBACK_PATH = "/callback";
const ANTHROPIC_SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	let params: URLSearchParams | undefined;
	try {
		params = new URL(value).searchParams;
	} catch {
		// Not a URL; the pasted value may be code#state, a query string or a bare code.
	}
	if (!params && value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
	}
	if (!params && value.includes("code=")) params = new URLSearchParams(value);
	if (!params) return { code: value };
	const code = params.get("code");
	const state = params.get("state");
	return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
}

async function exchangeAnthropicCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: ANTHROPIC_CLIENT_ID,
			code,
			state,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`Anthropic token exchange failed (${response.status}): ${body}`);
	const token = JSON.parse(body) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
	if (
		typeof token.access_token !== "string" ||
		typeof token.refresh_token !== "string" ||
		typeof token.expires_in !== "number"
	) {
		throw new Error("Anthropic token exchange response is missing access_token, refresh_token or expires_in");
	}
	return {
		type: "oauth",
		refresh: token.refresh_token,
		access: token.access_token,
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_SKEW_MS,
	};
}

async function loginAnthropicBrowser(interaction: ProviderAuthInteraction): Promise<OAuthCredentials> {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	// pi reuses the verifier as state; a separate value keeps the verifier out of the redirect.
	const state = randomBytes(32).toString("base64url");
	const start = (port: number): Promise<OAuthCallback> =>
		startOAuthCallback({
			providerName: "Anthropic",
			port,
			path: ANTHROPIC_CALLBACK_PATH,
			expectedState: () => state,
			signal: interaction.signal,
		});
	// Anthropic accepts any loopback port; the preferred one can be forwarded into containers or over SSH.
	const callback = await start(ANTHROPIC_CALLBACK_PORT)
		.catch(() => start(0))
		.catch(() => undefined);
	const redirectUri = callback?.redirectUri ?? `http://localhost:${ANTHROPIC_CALLBACK_PORT}${ANTHROPIC_CALLBACK_PATH}`;
	try {
		const params = new URLSearchParams({
			code: "true",
			client_id: ANTHROPIC_CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: ANTHROPIC_SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
		});
		interaction.notify({
			type: "auth_url",
			url: `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});
		const input = await callbackOrPasted(interaction, callback, {
			type: "manual_code",
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			placeholder: redirectUri,
		});
		const parsed = parseAuthorizationInput(input);
		if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
		if (!parsed.code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAnthropicCode(parsed.code, parsed.state ?? state, verifier, redirectUri, interaction.signal);
	} finally {
		callback?.close();
	}
}

/**
 * Pi asks for the login method first. Browser login is taken over before pi
 * starts its own server; every other method, such as pasting the code
 * Anthropic shows, stays pi's.
 */
export async function withPancodeAnthropicBrowserLogin(
	interaction: ProviderAuthInteraction,
	login: (interaction: ProviderAuthInteraction) => Promise<OAuthCredentials>,
): Promise<OAuthCredentials> {
	const takeover = new Error("browser login taken over by PanCode");
	try {
		return await login({
			signal: interaction.signal,
			notify: (event) => interaction.notify(event),
			async prompt(prompt) {
				const answer = await interaction.prompt(prompt);
				if (prompt.type === "select" && answer === "browser") throw takeover;
				return answer;
			},
		});
	} catch (error) {
		if (error !== takeover) throw error;
	}
	return loginAnthropicBrowser(interaction);
}
