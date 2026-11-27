// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createSessionBundle } from "./extension.js";
import { SessionManifest } from "./manifest.js";

export const SessionDomainModule: DomainModule<"session"> = {
	manifest: SessionManifest,
	createExtension: createSessionBundle,
};
