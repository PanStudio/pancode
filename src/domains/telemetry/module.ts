// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createTelemetryBundle } from "./extension.js";
import { TelemetryManifest } from "./manifest.js";

export const TelemetryDomainModule: DomainModule<"telemetry"> = {
	manifest: TelemetryManifest,
	createExtension: (context) => {
		const { extension, contract } = createTelemetryBundle(context);
		return { extension, contract };
	},
};

export { createTelemetryDomain } from "./extension.js";
