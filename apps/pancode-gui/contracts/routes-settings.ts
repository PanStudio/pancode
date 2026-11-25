// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import { Empty, Id } from "./common.js";
import { Accepted } from "./operations.js";
import { defineRoute, get, operationParams, post } from "./route-schema.js";
import { routes as runtimeRoutes } from "./runtime-routes.js";
import { ConfigGraph, SettingsReport } from "./settings.js";
import { SettingsControls, SettingWrite, SettingWritten } from "./settings-controls.js";
import { CliTargets, Routing } from "./targets-cli.js";

const targetParams = Type.Object({ targetId: Id }, { additionalProperties: false });
/** Settings are the user layer alone until a workspace is named; then that project's layers apply too. */
const settingsScope = Type.Object({ workspace: Type.Optional(Id) }, { additionalProperties: false });
/** Targets, routing, settings and the config graph. */
export const settingsRoutes = {
	targetsList: defineRoute({
		...get,
		params: operationParams,
		response: CliTargets,
		summary: "Configured targets through the canonical CLI",
		...runtimeRoutes.targetsList,
	}),
	routing: defineRoute({
		...get,
		params: operationParams,
		response: Routing,
		summary: "Offline models, fleet profiles and agent bindings",
		...runtimeRoutes.routing,
	}),
	targetsProbe: defineRoute({
		...post,
		params: Type.Object({ id: Id, targetId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Probe configured targets and return this target's status",
		...runtimeRoutes.targetsProbe,
	}),
	targetsUse: defineRoute({
		...post,
		params: Type.Object({ id: Id, targetId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Use a target for chat and fleet through the CLI",
		...runtimeRoutes.targetsUse,
	}),
	targetsRemove: defineRoute({
		...post,
		params: Type.Object({ id: Id, targetId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Remove a configured target through the CLI",
		...runtimeRoutes.targetsRemove,
	}),
	targetsSignOut: defineRoute({
		...post,
		params: Type.Object({ id: Id, targetId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Remove the stored credential for a target through the CLI",
		...runtimeRoutes.targetsSignOut,
	}),
	userTargetsList: defineRoute({
		...get,
		response: CliTargets,
		summary: "The user's configured targets with no workspace open",
		...runtimeRoutes.userTargetsList,
	}),
	userRouting: defineRoute({
		...get,
		response: Routing,
		summary: "Offline models, fleet profiles and agent bindings from the user layer alone",
		...runtimeRoutes.userRouting,
	}),
	userTargetsProbe: defineRoute({
		...post,
		params: targetParams,
		response: Accepted,
		summary: "Probe a user-level target with no workspace open",
		...runtimeRoutes.userTargetsProbe,
	}),
	userTargetsUse: defineRoute({
		...post,
		params: targetParams,
		response: Accepted,
		summary: "Use a target for chat and fleet with no workspace open",
		...runtimeRoutes.userTargetsUse,
	}),
	userTargetsRemove: defineRoute({
		...post,
		params: targetParams,
		response: Accepted,
		summary: "Remove a user-level target with no workspace open",
		...runtimeRoutes.userTargetsRemove,
	}),
	userTargetsSignOut: defineRoute({
		...post,
		params: targetParams,
		response: Accepted,
		summary: "Remove the stored credential for a target with no workspace open",
		...runtimeRoutes.userTargetsSignOut,
	}),
	settingsReport: defineRoute({
		...get,
		params: Empty,
		query: settingsScope,
		response: SettingsReport,
		summary: "Effective settings and each leaf's origin layer; without a workspace, the user layer alone",
		...runtimeRoutes.settingsReport,
	}),
	settingsControls: defineRoute({
		...get,
		params: Empty,
		query: settingsScope,
		response: SettingsControls,
		summary:
			"The engine's setting controls with the app's write policy, timing and origin; without a workspace, the user layer alone",
		...runtimeRoutes.settingsControls,
	}),
	writeSetting: defineRoute({
		...post,
		status: 200,
		params: Empty,
		query: settingsScope,
		body: SettingWrite,
		response: SettingWritten,
		summary: "Write one allowlisted setting to the user layer through the engine's cross-field validation",
		...runtimeRoutes.writeSetting,
	}),
	configGraph: defineRoute({
		...get,
		params: operationParams,
		response: ConfigGraph,
		summary: "Read-only customization graph without secrets or hook argv",
		...runtimeRoutes.configGraph,
	}),
	userConfigGraph: defineRoute({
		...get,
		response: ConfigGraph,
		summary: "The same graph with no workspace open: the user layer and defaults, with no project layer",
		...runtimeRoutes.userConfigGraph,
	}),
};
