// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainManifest } from "../../core/domain-loader.js";

export const SchedulingManifest: DomainManifest<"scheduling"> = {
	name: "scheduling",
	dependsOn: ["config", "telemetry"],
};
