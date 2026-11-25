// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createExtensionsBundle } from "./extension.js";
import { ExtensionsManifest } from "./manifest.js";

export const ExtensionsDomainModule: DomainModule<"extensions"> = {
	manifest: ExtensionsManifest,
	createExtension: createExtensionsBundle,
};

export type {
	ExtensionContentAccess,
	ExtensionEffect,
	ExtensionHookEvent,
	ExtensionToolHookLanding,
} from "@pancode/sdk/extension";
export type { ExtensionCapabilityEnvelope, ExtensionHookDeclaration } from "@pancode/sdk/pack";
export { capabilityEnvelope, envelopeDigest, extensionToolName, RUNTIME_V2_LIMITS } from "@pancode/sdk/pack";
export type { ExtensionsContract } from "./contract.js";
export { loadManifestFromRoot } from "./discovery.js";
export { reviewExtensionEnvelope } from "./envelope-review.js";
export type { McpToolOwnerLookup } from "./hook-tool-match.js";
export { extensionHookToolMatcher } from "./hook-tool-match.js";
export {
	disableExtension,
	discoverExtensionPackages,
	type ExtensionDiagnostic,
	type ExtensionReloadCandidate,
	type ExtensionReloadCommitted,
	type ExtensionReloadPrepareResult,
	type ExtensionReloadRejection,
	type ExtensionScope,
	type ExtensionSnapshot,
	type ExtensionSnapshotDiagnostics,
	enableExtension,
	type InstalledExtension,
	installExtension,
	isLoadableExtension,
	type LoadableExtension,
	listInstalledExtensions,
	removeExtension,
} from "./manager.js";
export {
	createExtensionRuntimeHookBridge,
	type ExtensionRuntimeHookBridge,
	type ExtensionRuntimeHookExecutor,
} from "./runtime-hook-bridge.js";
export { EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP } from "./snapshot.js";
export {
	assignExtensionModel,
	auditExtensionInstallRecords,
	extensionBaseDir,
	installedExtensionClaims,
	readExtensionInstallRecord,
	repairExtensionInstallRecords,
} from "./state.js";
