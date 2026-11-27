// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export {
	isPluginId,
	PLUGIN_EXTENSION_KEY,
	PLUGIN_RESOURCE_KINDS,
	PLUGIN_SCHEMA,
	parsePluginManifest,
	pluginResourcePath,
	readPluginManifest,
} from "./discovery.js";
export { passDerived, withPluginDiscoveryPass } from "./discovery-pass.js";
export {
	type DroppedInstallRecord,
	type InstallRecordReport,
	reportInvalidInstallRecordsAsRows,
} from "./install-records.js";
export { pluginContentDigest, pluginContentDigestWithCapture } from "./integrity.js";
export { pluginPromptNames } from "./prompt-names.js";
export {
	buildPluginSnapshot,
	clearPluginSnapshots,
	committedPluginResourceRoots,
	committedPluginSnapshot,
	enabledPluginResourceRoots,
	enabledPluginResourceRootsFor,
	pluginSnapshotFor,
	reloadPluginResources,
} from "./resources.js";
export {
	auditPluginInstallRecords,
	disablePlugin,
	enablePlugin,
	installHubPackage,
	installPlugin,
	listInstalledPlugins,
	newlyBrokenDependents,
	observePluginCopy,
	type PluginDependentBreak,
	PluginWriterRefusal,
	pluginBaseDir,
	pluginStatePath,
	readPluginInstallRecord,
	removePlugin,
	repairPluginInstallRecords,
	resolvePluginPrecedence,
	updatePlugin,
	withPluginScopeLock,
} from "./state.js";
export type {
	ForeignPackageFormat,
	HubPackageInstallInput,
	InstalledPlugin,
	PackageTrust,
	PancodePluginConfiguration,
	PluginCandidate,
	PluginComponent,
	PluginComponentKind,
	PluginDiagnostic,
	PluginDiagnosticCode,
	PluginExpectedCopy,
	PluginExpectedState,
	PluginInstallOptions,
	PluginInstallRecord,
	PluginInstallResult,
	PluginListOptions,
	PluginManifest,
	PluginMutationOptions,
	PluginMutationResult,
	PluginOrigin,
	PluginProvenance,
	PluginResourceKind,
	PluginResourceRoot,
	PluginResources,
	PluginScope,
	PluginSnapshot,
	PluginState,
} from "./types.js";
export { isForeignPluginOrigin } from "./types.js";
