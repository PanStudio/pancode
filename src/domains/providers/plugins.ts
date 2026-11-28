// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { writeDiagnostic } from "../../core/diagnostics.js";
/**
 * Loads out-of-tree runtime descriptors into the registry. Two surfaces:
 *
 *   1. `~/.config/pancode/runtimes/`: any `.js` file whose default export is a valid
 *      RuntimeDescriptor. Resolved from `pancodeConfigDir()` so PANCODE_HOME /
 *      PANCODE_CONFIG_DIR overrides flow through.
 *   2. npm packages listed under `settings.integrations.providerPackages`.
 *      Each package must export a `pancodeRuntimes: RuntimeDescriptor[]` array.
 *
 * Missing directories, import failures, and descriptor conflicts are logged
 * to stderr but never throw. The providers domain still boots with whatever
 * subset loaded cleanly.
 */

import { join } from "node:path";

import type { PancodeSettings } from "../../core/config.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import { activateExternalPluginApiBridge } from "../../engine/api-registry.js";
import type { RuntimeRegistry } from "./registry.js";

export async function loadPluginRuntimes(
	registry: RuntimeRegistry,
	settings?: Pick<PancodeSettings, "integrations">,
): Promise<ReadonlyArray<string>> {
	const loaded: string[] = [];

	const pluginDir = join(pancodeConfigDir(), "runtimes");
	const packages = settings?.integrations.providerPackages ?? [];
	try {
		const ids = await registry.loadFromDir(pluginDir, activateExternalPluginApiBridge);
		loaded.push(...ids);
	} catch (err) {
		writeDiagnostic(`[providers] loadFromDir ${pluginDir} failed: ${err instanceof Error ? err.message : String(err)}\n`);
	}

	for (const packageName of packages) {
		try {
			const ids = await registry.loadFromPackage(packageName, activateExternalPluginApiBridge);
			loaded.push(...ids);
		} catch (err) {
			writeDiagnostic(
				`[providers] loadFromPackage ${packageName} failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	return loaded;
}
