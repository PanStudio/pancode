// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

export { runtimeEnforcement } from "../../core/runtime-enforcement.js";
export type {
	AuthResolution,
	AuthStatus,
} from "./auth/index.js";
export {
	applyTargetCredentialPlan,
	planTargetCredentialRemoval,
	resolveAuthTarget,
	resolveRuntimeAuthTarget,
	targetRequiresAuth,
} from "./auth/index.js";
export { prepareBackgroundModelMetadata } from "./background-model-metadata.js";
export {
	type CacheDeploymentObservation,
	observeCacheDeployment,
	type WarmableBackend,
	warmableBackend,
} from "./cache-deployment.js";
export { AGENT_ROLE_TOOLS_REQUIRED_REASON, mergeCapabilities, supportsAgentRoleTools } from "./capabilities.js";
export { resolveEffectivePricing } from "./catalog.js";
export type { ProvidersContract, TargetHealth, TargetHealthStatus, TargetStatus } from "./contract.js";
export { isOrchestratorEligibleRuntime, isTargetEligibleRuntime } from "./eligibility.js";
export {
	backgroundMemoryAdmissionLimit,
	backgroundSlotKey,
	canonicalEndpointKey,
	type EndpointCapacity,
	endpointCapacitiesForStatuses,
	endpointCapacityFor,
	endpointCapacityForStatus,
	foregroundStreamUsage,
	gatewayEndpointKey,
	modelEndpointKey,
	modelStreamUsage,
	registerBackgroundStream,
	registerForegroundStream,
	resolveEndpointCapacities,
} from "./endpoint-capacity.js";
export { endpointThroughput, recordEndpointThroughput } from "./endpoint-throughput.js";
export { acceptsImageInput } from "./image-input.js";
export {
	applyModelCapabilityPatch,
	probeCapabilitiesForModel,
	resolveModelCapabilities,
} from "./model-capabilities.js";
export {
	canonicalizeWireModelId,
	chatModelCandidatesForStatus,
	hasLiveModelCatalog,
	modelCandidatesForStatus,
	modelIdsForStatus,
	modelListNoteForStatus,
	modelOfferForStatus,
	modelResidencyForStatus,
	offeredAsChatModel,
	type ProviderModelSource,
	probedModelOffer,
	runtimeListsModelsLive,
	unverifiedModelListNote,
} from "./model-discovery.js";
export { modelLineage } from "./model-lineage.js";
export { newerModelNotice } from "./model-recency.js";
export {
	type AppliedThinking,
	type ResolvedThinkingCapability,
	resolveModelRuntimeCapabilitiesForModel,
	resolveModelRuntimeCapabilitiesForProviders,
	thinkingEffectNote,
	thinkingLevelDisplayWord,
	thinkingLevelFromChoiceLabel,
} from "./model-runtime-capabilities.js";
export { getRuntimeRegistry } from "./registry.js";
export {
	type ResolvedModelRef,
	resolveModelReference,
} from "./resolver.js";
export {
	type ContextWindowDetails,
	type ContextWindowSource,
	firstRuntimeResolutionError,
	type ResolvedRuntimeTarget,
	type RuntimeCapabilityDecision,
	type RuntimeResolutionDiagnostic,
	type RuntimeTargetSnapshot,
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
	runtimeResolutionWarnings,
	runtimeResolutionWarningsBesideThinkingNotice,
	runtimeTargetSnapshot,
	synthesizeTargetModel,
} from "./runtime-resolution.js";
export { isCopilotTransientFailure } from "./runtimes/copilot/transient-failure.js";
export { LOCAL_API_KEY_FALLBACK, resolveSideCallAuth } from "./side-call-auth.js";
export {
	buildProviderSupportEntry,
	configuredTargetsForRuntime,
	describeRuntimeModels,
	listKnownModelsForRuntime,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	type ResolvedProviderReference,
	resolveProviderReference,
	supportGroupLabel,
} from "./support.js";
export { recordTargetCheck } from "./target-check-record.js";
export {
	readTargetModelSnapshot,
	recordProbedModelSnapshot,
	recordTargetModelSnapshot,
	targetModelSnapshotPath,
} from "./target-model-cache.js";
export type {
	CapabilityFlags,
	ThinkingLevel,
} from "./types/capability-flags.js";
export {
	EMPTY_CAPABILITIES,
	THINKING_LEVELS,
} from "./types/capability-flags.js";
export { type ContextWindowSlots, formatContextWindowSlots } from "./types/context-window-slots.js";
export type {
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeEnforcement,
	RuntimeKind,
	RuntimeTier,
} from "./types/runtime-descriptor.js";
export type { TargetDescriptor } from "./types/target-descriptor.js";
export { copilotContextTierLabel, copilotContextTierOf } from "./types/target-descriptor.js";
