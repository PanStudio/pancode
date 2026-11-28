// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

export type { ExtensionDiagnostic } from "@pancode/sdk/pack";
export { discoverExtensionPackages } from "./discovery.js";
export {
	disableExtension,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "./state.js";
export type {
	ExtensionListOptions,
	ExtensionReloadCandidate,
	ExtensionReloadCommitted,
	ExtensionReloadPrepareResult,
	ExtensionReloadRejection,
	ExtensionScope,
	ExtensionSnapshot,
	ExtensionSnapshotDiagnostics,
	InstalledExtension,
	LoadableExtension,
} from "./types.js";
export { isLoadableExtension } from "./types.js";
