// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export const PACKAGE = "@pancode/kit" as const;

export { probeServers, type ServeDefaults, type ServerReport, serveServer } from "./host.js";
export {
	type KitManifest,
	type KitManifestServer,
	type KitManifestTool,
	kitManifest,
	manifestServer,
	manifestText,
} from "./manifest.js";
