// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { type ConfigBundleOptions, createConfigBundle } from "./extension.js";
import { ConfigManifest } from "./manifest.js";

export const ConfigDomainModule: DomainModule<"config"> = {
	manifest: ConfigManifest,
	createExtension: (context) => createConfigBundle(context),
};

/** Bind the one strict startup snapshot without changing other command paths. */
export function createConfigDomainModule(
	initialSettings: Readonly<import("../../core/config.js").PancodeSettings>,
	options: ConfigBundleOptions = {},
): DomainModule<"config"> {
	return {
		manifest: ConfigManifest,
		createExtension: (context) => createConfigBundle(context, initialSettings, options),
	};
}
