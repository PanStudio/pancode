// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Empty } from "./common.js";
import {
	HubAgents,
	HubApplyResult,
	HubExtensions,
	HubInventory,
	HubPlan,
	HubPlanParams,
	HubPlanReleased,
	HubPlanRequest,
	HubVerifiers,
	InstallationHubPlanParams,
} from "./hub.js";
import { defineRoute, get, operationParams, post } from "./route-schema.js";
import { routes as runtimeRoutes } from "./runtime-routes.js";

/** The hub: its extension, agent and verifier catalogs and the plans that install from them. */
export const hubRoutes = {
	hub: defineRoute({
		...get,
		params: operationParams,
		response: HubInventory,
		summary: "Canonical packs, installed copies and recipe resources",
		...runtimeRoutes.hub,
	}),
	hubPlan: defineRoute({
		...post,
		status: 200,
		params: operationParams,
		body: HubPlanRequest,
		response: HubPlan,
		summary: "Stage one reviewed hub lifecycle plan; writes nothing",
		...runtimeRoutes.hubPlan,
	}),
	hubPlanApply: defineRoute({
		...post,
		status: 200,
		params: HubPlanParams,
		response: HubApplyResult,
		summary: "Apply the exact plan that was reviewed and report per-package outcomes",
		...runtimeRoutes.hubPlanApply,
	}),
	hubPlanRelease: defineRoute({
		...post,
		status: 200,
		params: HubPlanParams,
		response: HubPlanReleased,
		summary: "Cancel a staged plan and release its sources",
		...runtimeRoutes.hubPlanRelease,
	}),
	hubExtensions: defineRoute({
		...get,
		params: operationParams,
		response: HubExtensions,
		summary: "Installed extensions and admission state",
		...runtimeRoutes.hubExtensions,
	}),
	hubAgents: defineRoute({
		...get,
		params: operationParams,
		response: HubAgents,
		summary: "Resolved user-facing agent specifications",
		...runtimeRoutes.hubAgents,
	}),
	hubVerifiers: defineRoute({
		...get,
		params: operationParams,
		response: HubVerifiers,
		summary: "Verifier discovery without executing checks",
		...runtimeRoutes.hubVerifiers,
	}),
	installationHub: defineRoute({
		...get,
		response: HubInventory,
		summary: "The same hub inventory with no workspace open; only user and built-in layers apply",
		...runtimeRoutes.installationHub,
	}),
	installationHubPlan: defineRoute({
		...post,
		status: 200,
		params: Empty,
		body: HubPlanRequest,
		response: HubPlan,
		summary: "Stage a reviewed user-scope hub plan with no workspace open; writes nothing",
		...runtimeRoutes.installationHubPlan,
	}),
	installationHubPlanApply: defineRoute({
		...post,
		status: 200,
		params: InstallationHubPlanParams,
		response: HubApplyResult,
		summary: "Apply a reviewed user-scope plan staged with no workspace open",
		...runtimeRoutes.installationHubPlanApply,
	}),
	installationHubPlanRelease: defineRoute({
		...post,
		status: 200,
		params: InstallationHubPlanParams,
		response: HubPlanReleased,
		summary: "Cancel a plan staged with no workspace open and release its sources",
		...runtimeRoutes.installationHubPlanRelease,
	}),
	installationHubExtensions: defineRoute({
		...get,
		response: HubExtensions,
		summary: "Installed user extensions and admission state with no workspace open",
		...runtimeRoutes.installationHubExtensions,
	}),
	installationHubAgents: defineRoute({
		...get,
		response: HubAgents,
		summary: "Resolved user-facing agent specifications with no workspace open",
		...runtimeRoutes.installationHubAgents,
	}),
};
