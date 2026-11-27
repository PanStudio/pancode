// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

export type { ExtensionDiagnostic, PancodeExtensionManifest } from "@pancode/sdk/pack";
export {
	discoverExtensionPackages,
	findExtensionManifestPath,
	parseExtensionManifest,
} from "./discovery.js";
export { extensionBaseDir, type InstalledExtensionRecord } from "./listing.js";
export { extensionSnapshotFor } from "./snapshot-access.js";
export {
	disableExtension,
	enableExtension,
	installExtension,
	listInstalledExtensionRecords,
	listInstalledExtensions,
	removeExtension,
} from "./state.js";
export type {
	ExtensionCandidate,
	ExtensionHookSource,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionLoadScope,
	ExtensionMutationResult,
	ExtensionProvenance,
	ExtensionReloadCandidate,
	ExtensionReloadCommitted,
	ExtensionReloadPrepareResult,
	ExtensionReloadRejection,
	ExtensionReloadRejectionReason,
	ExtensionReloadResult,
	ExtensionScope,
	ExtensionSnapshot,
	ExtensionSnapshotDiagnostics,
	ExtensionState,
	InstalledExtension,
	LoadableExtension,
} from "./types.js";
export { isLoadableExtension } from "./types.js";
