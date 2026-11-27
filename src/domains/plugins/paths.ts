// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pancodeProjectRoot } from "../../core/project-root.js";
import { pancodeConfigPath, pancodeDataPath } from "../../core/xdg.js";
import type { PluginScope } from "./types.js";

function canonicalDir(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

/** Resolves without creating the config root. */
export function pluginBaseDir(scope: PluginScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(pancodeConfigPath(), "plugins")
		: path.join(pancodeProjectRoot(cwd, path.join("plugins", "state.json")), ".pancode", "plugins");
}

/**
 * The writable data directory of the plugin installed at `rootPath`, `${PLUGIN_DATA}` to its servers: kept across
 * updates, removed with the plugin. A project plugin's directory is keyed by its project's canonical plugin directory,
 * so two projects that install the same id never share one and launch and removal resolve the same path across symlinks.
 * Resolves without creating it.
 */
export function pluginDataDir(scope: PluginScope, rootPath: string): string {
	const resolved = path.resolve(rootPath);
	const id = path.basename(resolved);
	const base = path.join(pancodeDataPath(), "plugins", "data");
	if (scope === "user") return path.join(base, "user", id);
	const project = createHash("sha256")
		.update(canonicalDir(path.dirname(resolved)))
		.digest("hex")
		.slice(0, 16);
	return path.join(base, "project", project, id);
}
