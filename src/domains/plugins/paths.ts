// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";
import path from "node:path";
import { pancodeProjectRoot } from "../../core/project-root.js";
import { pancodeConfigPath, pancodeDataPath } from "../../core/xdg.js";
import type { PluginScope } from "./types.js";

/** Resolves without creating the config root. */
export function pluginBaseDir(scope: PluginScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(pancodeConfigPath(), "plugins")
		: path.join(pancodeProjectRoot(cwd, path.join("plugins", "state.json")), ".pancode", "plugins");
}

/**
 * The writable data directory of the plugin installed at `rootPath`, `${PLUGIN_DATA}` to its servers: kept across
 * updates, removed with the plugin. A project plugin's directory is keyed by its project's plugin directory, so two
 * projects that install the same id never share one. Resolves without creating it.
 */
export function pluginDataDir(scope: PluginScope, rootPath: string): string {
	const id = path.basename(rootPath);
	const base = path.join(pancodeDataPath(), "plugins", "data");
	if (scope === "user") return path.join(base, "user", id);
	const project = createHash("sha256").update(path.dirname(rootPath)).digest("hex").slice(0, 16);
	return path.join(base, "project", project, id);
}
