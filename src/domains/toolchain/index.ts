// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export type { ToolFetcher, ToolInstallOptions, ToolInstallResult } from "./install.js";
export { installPinnedTool, installTool, mirroredSources, toolchainMirror } from "./install.js";
export { toolchainRoot, toolVersionDir, vendoredBinaryPath } from "./paths.js";
export {
	currentToolPlatform,
	findPinnedTool,
	findPinnedToolByBinary,
	PINNED_TOOLS,
	packageManagerInstallHints,
} from "./registry.js";
export type { ToolRemoveOptions, ToolRemoveResult } from "./remove.js";
export { installedToolVersions, removeTool, STALE_STAGING_MS } from "./remove.js";
export {
	describeFloorRejection,
	describeResolution,
	installRemedy,
	pinnedToolMissing,
	resolveEntryBinary,
	resolvePinnedEntryBinary,
	resolveToolBinary,
	resolveVendoredBinary,
	toolStatus,
	toolStatuses,
} from "./resolve.js";
export type {
	PinnedTool,
	PinnedToolDocument,
	PinnedToolDownload,
	ToolArchiveKind,
	ToolPathCandidate,
	ToolPlatform,
	ToolResolution,
	ToolSource,
	ToolStatus,
} from "./types.js";
export { compareVersions, parseVersion, satisfiesMinimum } from "./version.js";
