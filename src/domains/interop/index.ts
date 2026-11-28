// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export type { AdoptionKind, InteropAdoptionPlan } from "./adopt.js";
export {
	ADOPTION_KINDS,
	applyInteropAdoption,
	isAdoptableKind,
	planInteropAdoption,
	renderInteropAdoptionPlan,
} from "./adopt.js";
export {
	acceptInteropAgents,
	declineInteropAgents,
	delegationEntryForKind,
	INHERITED_PROJECT_CONTEXT,
	interopProposals,
	interopUnofferedReasons,
	renderProposalEntry,
} from "./consent.js";
export type { InteropContract } from "./contract.js";
export { detectInteropAgents, resolveOnPath } from "./detect.js";
export type { HubImportApplyResult, HubImportPlan } from "./import.js";
export {
	applyHubImport,
	hubImportPlanSummary,
	planHubImport,
	releaseHubImport,
	renderHubImportPlan,
} from "./import.js";
export { discoverInteropInventory } from "./inventory.js";
export {
	type PeerModeCapability,
	peerModeCapabilities,
} from "./peer-modes.js";
export { foreignAgentDirs, INTEROP_AGENT_KINDS, interopAgentKind } from "./registry.js";
export { readInteropReport } from "./state.js";
export type {
	InteropAgentId,
	InteropPresence,
	InteropProposal,
	InteropReport,
} from "./types.js";
