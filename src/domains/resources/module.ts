// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createResourcesBundle } from "./extension.js";
import type { ResourceLoaderOptions } from "./loader.js";
import { ResourcesManifest } from "./manifest.js";

export const ResourcesDomainModule: DomainModule<"resources"> = {
	manifest: ResourcesManifest,
	createExtension: createResourcesBundle,
};

export function createResourcesDomainModule(options: ResourceLoaderOptions = {}): DomainModule<"resources"> {
	return {
		manifest: ResourcesManifest,
		createExtension: (context) => createResourcesBundle(context, options),
	};
}
