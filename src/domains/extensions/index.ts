// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { PackBinaryInstallOptions } from "./services/binaries.js";

export type {
	ExtensionContentAccess,
	ExtensionEffect,
	ExtensionHookEvent,
	ExtensionToolHookLanding,
} from "@pancode/sdk/extension";
export type { ExtensionCapabilityEnvelope, ExtensionHookDeclaration } from "@pancode/sdk/pack";
export {
	capabilityEnvelope,
	type ExtensionDiagnostic,
	envelopeDigest,
	extensionToolName,
	RUNTIME_V2_LIMITS,
} from "@pancode/sdk/pack";
export type { ExtensionsContract } from "./contract.js";
export { discoverExtensionPackages, loadManifestFromRoot } from "./discovery.js";
export { ENVELOPE_SEAT_BELT, envelopeLines, reviewExtensionEnvelope } from "./envelope-review.js";
export type { McpToolOwnerLookup } from "./hook-tool-match.js";
export { extensionHookToolMatcher } from "./hook-tool-match.js";
export {
	type DroppedInstallRecord,
	type InstallRecordReport,
	reportInvalidInstallRecordsAsRows,
} from "./install-store.js";
export { extensionBaseDir } from "./listing.js";
export {
	createExtensionRuntimeHookBridge,
	type ExtensionRuntimeHookBridge,
	type ExtensionRuntimeHookExecutor,
} from "./runtime-hook-bridge.js";
export {
	disableExtension,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "./state.js";
export {
	type ExtensionReloadCandidate,
	type ExtensionReloadCommitted,
	type ExtensionReloadPrepareResult,
	type ExtensionReloadRejection,
	type ExtensionScope,
	type ExtensionSnapshot,
	type ExtensionSnapshotDiagnostics,
	type InstalledExtension,
	isLoadableExtension,
	type LoadableExtension,
} from "./types.js";
/** Brings one extension's vendored binaries in line with its installed copies; loaded on demand off the barrel path. */
export async function syncPackBinaries(
	extensionId: string,
	cwd: string,
	options?: PackBinaryInstallOptions,
): Promise<string[]> {
	const { syncPackBinaries: sync } = await import("./services/binaries.js");
	return sync(extensionId, cwd, options);
}
export { EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP } from "./snapshot.js";
export {
	assignExtensionModel,
	auditExtensionInstallRecords,
	installedExtensionClaims,
	readExtensionInstallRecord,
	repairExtensionInstallRecords,
} from "./state.js";
