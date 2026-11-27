// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createShareBundle } from "./extension.js";
import { ShareManifest } from "./manifest.js";

export const ShareDomainModule: DomainModule<"share"> = {
	manifest: ShareManifest,
	createExtension: createShareBundle,
};
