// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createDispatchBundle, type DispatchBundleOptions } from "./extension.js";
import { DispatchManifest } from "./manifest.js";

export function createDispatchDomainModule(options: DispatchBundleOptions = {}): DomainModule<"dispatch"> {
	return {
		manifest: DispatchManifest,
		createExtension: (context) => createDispatchBundle(context, options),
	};
}
