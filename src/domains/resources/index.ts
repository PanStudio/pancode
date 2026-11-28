// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export type { ResourceDiagnostic, ResourceScope, ResourceSourceInfo } from "./collision.js";
export { resolveResourceCollisions } from "./collision.js";
export type { ResourceList, ResourcesContract } from "./contract.js";
export {
	classifyHubRequirements,
	commitHubInstallPlan,
	confirmHubRemote,
	discoverHub,
	type HubCommandRunner,
	type HubDiscoveryResult,
	type HubEntry,
	type HubInstallPlan,
	type HubRequirementStatus,
	hubEntryDrift,
	hubEntryInstalled,
	hubEntryPin,
	hubEntryRef,
	hubInstallPath,
	installHubPlan,
	pinHubEntry,
	planHubInstall,
	planHubUpdate,
	releaseHubPlan,
	resolveHubPackage,
	resolveHubRequirements,
	syncHub,
} from "./hub.js";
export {
	applyHubLifecycle,
	HUB_OPERATIONS,
	type HubApplyResult,
	type HubExpectedCopy,
	type HubExtensionRefresh,
	type HubLifecyclePlan,
	type HubLifecycleRequest,
	type HubOperation,
	type HubPackageIdentity,
	type HubPlanStep,
	type HubRefreshHost,
	type HubRefreshResult,
	type HubRefreshTouch,
	type HubStepOutcome,
	type HubStepReview,
	type HubStepStatus,
	type HubStepVerification,
	hubImportOutcome,
	hubRefreshTouch,
	planHubLifecycle,
	releaseHubLifecycle,
	retryHubRefresh,
	syncHubPackBinaries,
	verifyHubStep,
} from "./hub-actions.js";
export {
	classifyHubOrigin,
	HUB_INVENTORY_LIMITS,
	type HubComponent,
	type HubComponentAvailability,
	type HubComponentKeyParts,
	type HubComponentSourceClass,
	type HubCopy,
	type HubCopyInspection,
	type HubCopyState,
	type HubCopyUpdate,
	type HubInventory,
	type HubInventoryOptions,
	type HubOrigin,
	type HubOriginEvidence,
	type HubPackageRecord,
	hubComponentKey,
	hubCopyState,
	hubQueryMatches,
	inactiveCopyRemedy,
	inactiveHubCopies,
	inspectHubCopy,
	parseHubResourceKey,
	readHubInventory,
} from "./hub-inventory.js";
export {
	describeHubPair,
	type HubPair,
	type HubPairs,
	hubPairsFrom,
	readHubPairs,
} from "./hub-pairing.js";
export {
	HUB_COMPONENT_KINDS,
	type HubAuditState,
	type HubCategory,
	type HubComponentKind,
	type HubProvidedResource,
	isHubAuditState,
	isHubComponentKind,
} from "./hub-types.js";
export {
	type HubComponentValidationRecord,
	type HubPackageValidation,
	type HubPackageValidationResult,
	type HubValidationDiagnostic,
	type HubValidationPrerequisite,
	type HubValidationSeverity,
	validateHubPackage,
} from "./hub-validation.js";
export { createResourcesLoader, type ResourceLoaderOptions } from "./loader.js";
export { ResourcesManifest } from "./manifest.js";
export {
	expandPromptTemplateInput,
	loadPromptTemplates,
	type PromptTemplate,
	type PromptTemplateExpansion,
	type PromptTemplateList,
	type PromptTemplateRoot,
	promptTemplateDisplayText,
} from "./prompts/loader.js";
export {
	SKILL_BODY_LINE_BUDGET,
	type SkillVerification,
	skillAuthoringDiagnostics,
	skillVerification,
} from "./skills/authoring-check.js";
export { installedSkillNames, installedSkillPackages } from "./skills/availability.js";
export {
	bareSkillRemedy,
	isBareSkillDirectory,
	packageBareSkill,
} from "./skills/bare-skill.js";
export {
	buildSkillCatalogView,
	type SkillCatalogPackage,
	type SkillCatalogRow,
	type SkillCatalogRowKind,
	type SkillCatalogView,
	type SkillCatalogViewInput,
} from "./skills/catalog-view.js";
export { normalizedSkillHash } from "./skills/content-hash.js";
export { type LexicalMatchMode, lexicalMatches } from "./skills/lexical-match.js";
export {
	defaultSkillRoots,
	type LoadSkillsInput,
	loadSkills,
	mcpSkillToolSurface,
	modelVisibleSkills,
	parsePendingSkillRequests,
	parseSkillCommand,
	SKILL_SURFACE_CLEAR_ARG,
	type Skill,
	type SkillCatalogInvalidReason,
	type SkillCatalogValidity,
	type SkillList,
	type SkillMcpOrigin,
	type SkillProvenance,
	type SkillRoot,
	type SkillSource,
	skillCatalogValidity,
	suggestableSkills,
} from "./skills/loader.js";
export {
	type DiscoverMarketplaceOptions,
	discoverMarketplaceSkills,
	getMarketplaceSkills,
	type HubEntryKind,
	type HubRequirementRef,
	type InstallSkillInput,
	type InstallSkillResult,
	installSkill,
	knownSkillNames,
	MARKETPLACE_UNCONFIGURED,
	type MarketplaceDiscoveryResult,
	type MarketplaceSkill,
	type MarketplaceSkillOrigin,
	type MarketplaceStatus,
} from "./skills/marketplace.js";
export {
	checkSkillDrift,
	checkSkillDriftBatch,
	type SkillDriftSubject,
	type SkillDriftVerdict,
	type SkillPinEntry,
} from "./skills/provenance-pin.js";
