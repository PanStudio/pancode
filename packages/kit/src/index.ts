// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export const PACKAGE = "@pancode/kit" as const;

export {
	type KitManifest,
	type KitManifestServer,
	type KitManifestTool,
	kitManifest,
	manifestServer,
	manifestText,
} from "./manifest.js";
export { type PankitAddedServer, type PankitHost, type PankitOutcome, runPankit } from "./pankit.js";
