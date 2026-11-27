// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createProvidersBundle, type ProvidersBundleOptions } from "./extension.js";
import { ProvidersManifest } from "./manifest.js";

export const ProvidersDomainModule: DomainModule<"providers"> = {
	manifest: ProvidersManifest,
	createExtension: (context) => createProvidersBundle(context),
};

/** A providers module bound to a composition root's session view; see ProvidersBundleOptions. */
export function createProvidersDomainModule(options: ProvidersBundleOptions): DomainModule<"providers"> {
	return {
		manifest: ProvidersManifest,
		createExtension: (context) => createProvidersBundle(context, options),
	};
}
