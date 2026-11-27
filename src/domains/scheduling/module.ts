// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createSchedulingBundle, type SchedulingBundleOptions } from "./extension.js";
import { SchedulingManifest } from "./manifest.js";

export const SchedulingDomainModule: DomainModule<"scheduling"> = {
	manifest: SchedulingManifest,
	createExtension: createSchedulingBundle,
};

export function createSchedulingDomainModule(options: SchedulingBundleOptions): DomainModule<"scheduling"> {
	return {
		manifest: SchedulingManifest,
		createExtension: (context) => createSchedulingBundle(context, options),
	};
}
