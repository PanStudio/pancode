// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { homedir } from "node:os";
import { listInstalledExtensions } from "../../../../../src/domains/extensions/manager.js";
import { readHubInventory } from "../../../../../src/domains/resources/hub-inventory.js";

/**
 * The home to pin for compatibility roots, or none so the loaders resolve it as they do for the CLI and TUI.
 *
 * `os.homedir()` inside a worker thread reads the process's real environment, not the environment the
 * worker was started with, so a worker whose own `HOME` differs (the scratch home under test) pins it.
 * A pinned home bypasses PANCODE_INTEROP_HOME and each agent's own home variable, so it is pinned only then:
 * in normal use the two homes agree and `PANCODE_INTEROP_HOME=none` keeps the host's skills out of PanHub.
 */
function workerHome(): string | undefined {
	const home = process.env.HOME || process.env.USERPROFILE || undefined;
	if (home === undefined || home === homedir() || process.env.PANCODE_INTEROP_HOME?.trim()) return undefined;
	return home;
}

export function readHub(input: { cwd: string; kind: "inventory" | "extensions" }) {
	const home = workerHome();
	if (input.kind === "inventory") return readHubInventory({ cwd: input.cwd, ...(home ? { home } : {}) });
	return {
		extensions: listInstalledExtensions(input.cwd, { all: true }).map((row) => ({
			id: row.id,
			name: row.name,
			version: row.version,
			description: row.description,
			scope: row.scope,
			enabled: row.enabled,
			valid: row.valid,
			compatible: row.compatible,
			effective: row.effective,
			loadable: row.loadable,
			capabilities: row.capabilities ?? null,
			runtime: row.runtimeV2 ?? null,
			provenance: row.provenance ?? null,
			diagnostics: row.diagnostics,
		})),
	};
}
