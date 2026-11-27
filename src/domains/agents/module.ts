// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createAgentsBundle } from "./extension.js";
import { AgentsManifest } from "./manifest.js";

export const AgentsDomainModule: DomainModule<"agents"> = {
	manifest: AgentsManifest,
	createExtension: createAgentsBundle,
};
