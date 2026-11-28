// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * How a native worker run authenticates its model requests: the key each request resolves, and
 * the single refresh after a provider rejects it, through the stored OAuth credential or the
 * model route (D14).
 */

import { requestModelRouteRefresh } from "../../core/sandbox/egress/model-route-client.js";
import { openAuthStorage } from "../../domains/providers/auth/index.js";
import type { AuthResolution } from "../../domains/providers/auth/storage.js";
import type { EngineAgentOptions } from "../agent.js";
import { registerPancodeOAuthProviders } from "../oauth.js";
import type { WorkerRunInput } from "../worker-run-types.js";
import type { WorkerRunScope } from "./scope.js";

/**
 * The key to retry with after a provider rejection under the model route (D14), else null. The worker holds no
 * credential to refresh: the route refreshes the one the provider rejected. `refreshed` earns the #427 retry with the
 * same surrogate; `unchanged` (an API key) earns none.
 */
async function routed(
	input: Pick<WorkerRunInput, "modelRoute" | "signal" | "target" | "runtime">,
): Promise<string | null> {
	if (input.modelRoute === undefined) return null;
	const outcome = await requestModelRouteRefresh(input.modelRoute, input.signal);
	if (outcome === "unchanged") return null;
	if (outcome === "failed") {
		throw new Error(
			`The credential for connection '${input.target.id}' could not be refreshed. Run pancode auth login ${input.runtime.id} again.`,
		);
	}
	process.stderr.write(
		`[worker] the host refreshed the credential for connection '${input.target.id}'; retrying once\n`,
	);
	return input.modelRoute.surrogate;
}

export function createWorkerAuth(scope: WorkerRunScope) {
	const { input } = scope;
	// The credential the current request carries, so a server rejection refreshes
	// exactly that token under the shared storage lock (#427).
	let lastAuthResolution: AuthResolution | null = null;
	const refreshWorkerOAuthKey = async (): Promise<string | null> => {
		const rejected = lastAuthResolution;
		if (!input.authProfile || rejected?.source !== "stored-oauth" || rejected.apiKey === undefined) return routed(input);
		process.stderr.write(
			`[worker] refreshing the OAuth credential for connection '${input.target.id}' and retrying once\n`,
		);
		const refreshed = await openAuthStorage().forceRefreshApiKey(input.authProfile, rejected.apiKey, input.signal);
		if (!refreshed.available || refreshed.apiKey === undefined) {
			// Reuse the CLI login syntax, and keep refresh-provider diagnostics out of the remedy (#427).
			throw new Error(
				`OAuth credential for connection '${input.target.id}' could not be refreshed. Run pancode auth login ${rejected.providerId} again.`,
			);
		}
		lastAuthResolution = refreshed;
		return refreshed.apiKey;
	};

	const getApiKey: NonNullable<EngineAgentOptions["getApiKey"]> = async () => {
		scope.workerTelemetry?.stage("transform", "end");
		// A key the parent handed over needs no resolution, so the call has no auth stage (#434).
		if (!input.authProfile) return input.apiKey;
		scope.workerTelemetry?.stage("auth", "start");
		let refreshed: boolean | undefined;
		try {
			registerPancodeOAuthProviders();
			const resolved = await openAuthStorage().resolveApiKey(input.authProfile, {
				includeFallback: false,
				...(input.signal ? { signal: input.signal } : {}),
			});
			refreshed = resolved.refreshed;
			if (!resolved.available || !resolved.apiKey) {
				throw new Error(resolved.detail ?? `Credential '${input.authProfile}' is unavailable. Sign in again.`);
			}
			lastAuthResolution = resolved;
			return resolved.apiKey;
		} finally {
			scope.workerTelemetry?.stage("auth", "end", refreshed === undefined ? {} : { refreshed });
		}
	};

	return { refreshWorkerOAuthKey, getApiKey };
}
