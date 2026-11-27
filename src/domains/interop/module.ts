// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createInteropBundle } from "./extension.js";
import { InteropManifest } from "./manifest.js";

export const InteropDomainModule: DomainModule<"interop"> = {
	manifest: InteropManifest,
	createExtension: createInteropBundle,
};
