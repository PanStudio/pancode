// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createPluginsBundle } from "./extension.js";
import { PluginsManifest } from "./manifest.js";

export const PluginsDomainModule: DomainModule<"plugins"> = {
	manifest: PluginsManifest,
	createExtension: createPluginsBundle,
};
