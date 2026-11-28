// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainManifest } from "../../core/domain-loader.js";

export const InteropManifest: DomainManifest<"interop"> = {
	name: "interop",
	dependsOn: ["config", "middleware"],
};
