// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createExtensionsBundle } from "./extension.js";
import { ExtensionsManifest } from "./manifest.js";

export const ExtensionsDomainModule: DomainModule<"extensions"> = {
	manifest: ExtensionsManifest,
	createExtension: createExtensionsBundle,
};
