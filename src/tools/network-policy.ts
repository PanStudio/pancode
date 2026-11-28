// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Process-wide registration switch for the RETRIEVE tool plane (web_fetch).
 * This removes retrieval tools from main and worker registries. It does not
 * restrict bash, hooks, external CLIs, or provider traffic. Hermetic execution
 * requires an OS network sandbox supplied by the operator or an outer harness.
 * The environment setting propagates to child registries without per-run wiring.
 */
const NO_NETWORK_TOOLS_ENV = "PANCODE_DISABLE_RETRIEVE_TOOLS";

/** Not a sandbox: it removes tools, nothing else. */
export function networkToolsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[NO_NETWORK_TOOLS_ENV] === "1";
}

/** Operator process opt-in; never accepted from model arguments or project settings. */
export const WEB_FETCH_ALLOW_PRIVATE_NETWORK_ENV = "PANCODE_WEB_FETCH_ALLOW_PRIVATE_NETWORK";
