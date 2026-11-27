// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { pancodeProjectRoot } from "../../core/project-root.js";
import { pancodeConfigPath } from "../../core/xdg.js";
import type { PluginScope } from "./types.js";

/** Resolves without creating the config root. */
export function pluginBaseDir(scope: PluginScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(pancodeConfigPath(), "plugins")
		: path.join(pancodeProjectRoot(cwd, path.join("plugins", "state.json")), ".pancode", "plugins");
}
