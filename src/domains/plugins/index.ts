// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export { bundledPluginCatalog } from "./catalog.js";
export {
	PLUGIN_EXTENSION_KEY,
	PLUGIN_SCHEMA,
	parsePluginManifest,
	pluginResourcePath,
	readPluginManifest,
} from "./discovery.js";
export { passDerived, withPluginDiscoveryPass } from "./discovery-pass.js";
export { pluginContentDigest } from "./integrity.js";
export { pluginDataDir } from "./paths.js";
export { pluginPromptNames } from "./prompt-names.js";
export {
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
	updatePlugin,
	withPluginScopeLock,
} from "./state.js";
export type {
	InstalledPlugin,
	PluginCandidate,
	PluginDiagnostic,
	PluginExpectedCopy,
	PluginExpectedState,
	PluginInstallRecord,
	PluginListOptions,
	PluginManifest,
	PluginMutationResult,
	PluginResourceKind,
	PluginScope,
	PluginSnapshot,
	PluginState,
} from "./types.js";
