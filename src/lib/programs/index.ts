// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export type { ToolFetcher, ToolInstallResult } from "./install.js";
export { installPinnedTool, installTool } from "./install.js";
export { toolchainRoot, toolVersionDir } from "./paths.js";
export {
	currentToolPlatform,
	findPinnedTool,
	PINNED_TOOLS,
} from "./registry.js";
export { installedToolVersions, removeTool } from "./remove.js";
export {
	describeFloorRejection,
	describeResolution,
	installRemedy,
	pinnedToolMissing,
	resolvePinnedEntryBinary,
	resolveToolBinary,
	resolveVendoredBinary,
	toolStatus,
	toolStatuses,
} from "./resolve.js";
export type {
	PinnedTool,
	PinnedToolDownload,
	ToolPlatform,
	ToolResolution,
	ToolStatus,
} from "./types.js";
