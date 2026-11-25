// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainManifest } from "../../core/domain-loader.js";

export const DispatchManifest: DomainManifest<"dispatch"> = {
	name: "dispatch",
	dependsOn: ["config", "safety", "agents", "providers", "middleware", "prompts", "scheduling"],
};
