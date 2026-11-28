// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { type AgentsBundleOptions, createAgentsBundle } from "./extension.js";
import { AgentsManifest } from "./manifest.js";

/** The agents domain module, bound to the skill catalog reader its composition root passes in. */
export function createAgentsDomainModule(options: AgentsBundleOptions): DomainModule<"agents"> {
	return { manifest: AgentsManifest, createExtension: (context) => createAgentsBundle(context, options) };
}
