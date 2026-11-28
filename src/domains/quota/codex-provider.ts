// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Quota adapter for the `openai-codex` runtime, the ChatGPT account PanCode
 * itself spends when it runs a native Codex turn.
 *
 * The credential is the OAuth record PanCode's own auth storage persists under
 * the `openai-codex` provider id, so this adapter reads no other agent's
 * files and stays registered in a relocated home. It reads the stored
 * credential without triggering a refresh, because a quota read must never
 * mutate an authentication record. The Codex CLI's login is a separate
 * credential that `codex-cli-provider.ts` reads under the interop rules (#434).
 */

import { arch, platform, release } from "node:os";
import { readPancodeVersion } from "../../core/package-root.js";
import { isRecord } from "../../core/type-guards.js";
import { openAuthStorage } from "../providers/auth/index.js";
import type { CodexAccountToken } from "./codex-usage.js";
import { fetchCodexUsage } from "./codex-usage.js";
import { asNumber, snapshotFactory } from "./provider-common.js";
import type { QuotaProvider, UsageSnapshot } from "./types.js";
import { credentialFingerprint } from "./types.js";

export const CODEX_QUOTA_PROVIDER_ID = "codex";

/** The provider id PanCode's auth storage files an OpenAI Codex OAuth credential under. */
const AUTH_PROVIDER_ID = "openai-codex";
const DISPLAY_NAME = "OpenAI Codex";
const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_AGAIN = "Run pancode auth login openai-codex again";

/** The subset of PanCode's stored OAuth credential this adapter needs. */
export interface CodexCredentials extends CodexAccountToken {
	/** Epoch milliseconds the access token expires, or null when the record omits it. */
	expiresAtMs: number | null;
	hasRefreshToken: boolean;
}

export interface CodexQuotaOptions {
	/** Replace credential reading entirely, which is how tests supply a token. */
	readCredentials?: () => Promise<CodexCredentials | null>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => Date;
}

/** Shape a stored auth credential into the fields a usage read needs. */
function parseStoredCodexCredential(raw: unknown): CodexCredentials | null {
	if (!isRecord(raw) || raw.type !== "oauth") return null;
	const access = raw.access;
	if (typeof access !== "string" || access.length === 0) return null;
	const accountId = raw.accountId;
	const refresh = raw.refresh;
	return {
		accessToken: access,
		accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : null,
		expiresAtMs: asNumber(raw.expires),
		hasRefreshToken: typeof refresh === "string" && refresh.length > 0,
	};
}

/**
 * Read PanCode's stored OpenAI Codex credential.
 *
 * `AuthStorage.get` is the accessor that does no refresh, unlike
 * `resolveApiKey`, which renews an expiring credential as a side effect.
 */
async function readStoredCredential(): Promise<CodexCredentials | null> {
	try {
		return parseStoredCodexCredential(openAuthStorage().get(AUTH_PROVIDER_ID));
	} catch {
		// An unreadable credential store reads as no login; the snapshot says so.
		return null;
	}
}

/** Build the read-only `codex` quota adapter. */
export function createCodexQuotaProvider(options: CodexQuotaOptions = {}): QuotaProvider {
	const readCredentials = options.readCredentials ?? readStoredCredential;
	const doFetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());

	const snapshot = snapshotFactory(CODEX_QUOTA_PROVIDER_ID, DISPLAY_NAME, now);

	return {
		id: CODEX_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,

		async credentialScope(): Promise<string | null> {
			const credentials = await readCredentials();
			return credentials === null ? null : credentialFingerprint(CODEX_QUOTA_PROVIDER_ID, credentials.accessToken);
		},

		async detect(): Promise<boolean> {
			return (await readCredentials()) !== null;
		},

		async fetch(): Promise<UsageSnapshot> {
			const credentials = await readCredentials();
			if (credentials === null) {
				return snapshot("no_credentials", "PanCode holds no OpenAI Codex OAuth credential");
			}
			if (credentials.expiresAtMs !== null && credentials.expiresAtMs <= now().getTime()) {
				return snapshot(
					"expired",
					credentials.hasRefreshToken ? "PanCode's OpenAI Codex token expired; the next turn refreshes it" : LOGIN_AGAIN,
				);
			}

			// The read names PanCode as the client, as the native Codex transport does.
			const usage = await fetchCodexUsage(credentials, {
				fetch: doFetch,
				timeoutMs,
				identity: {
					originator: "pancode",
					"User-Agent": `pancode/${readPancodeVersion()} (${platform()} ${release()}; ${arch()})`,
				},
			});
			if (usage.status !== "ok") {
				return snapshot(usage.status, usage.message ?? LOGIN_AGAIN, { retryAfterSeconds: usage.retryAfterSeconds });
			}
			return snapshot("ok", null, { windows: usage.windows, credits: usage.credits, plan: usage.plan, ...usage.pool });
		},
	};
}
