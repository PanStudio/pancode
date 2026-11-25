// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { updateLayeredSettings, updateProjectLocalSettings } from "../core/settings-layers.js";

/** Writes the one setting to a settings layer. A project write goes to the trust-gated local project file. */
export function writeSystemOneUse(cwd: string, scope: "user" | "project", use: string | string[]): void {
	const write = scope === "user" ? updateLayeredSettings : updateProjectLocalSettings;
	write(cwd, (settings) => {
		settings.systemOne.use = use;
		return settings;
	});
}
