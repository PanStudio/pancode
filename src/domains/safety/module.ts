// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createSafetyBundle } from "./extension.js";
import { SafetyManifest } from "./manifest.js";

export const SafetyDomainModule: DomainModule<"safety"> = {
	manifest: SafetyManifest,
	createExtension: createSafetyBundle,
};
