// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createTelemetryBundle, type TelemetryBundleOptions } from "./extension.js";
import { TelemetryManifest } from "./manifest.js";

/** The telemetry module for a composition that hands the daily sweep its retention passes. */
export function createTelemetryDomainModule(options: TelemetryBundleOptions = {}): DomainModule<"telemetry"> {
	return {
		manifest: TelemetryManifest,
		createExtension: (context) => {
			const { extension, contract } = createTelemetryBundle(context, options);
			return { extension, contract };
		},
	};
}

export const TelemetryDomainModule: DomainModule<"telemetry"> = createTelemetryDomainModule();

export { createTelemetryDomain } from "./extension.js";
