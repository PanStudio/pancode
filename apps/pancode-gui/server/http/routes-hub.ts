// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { Supervisor } from "../acp/supervisor.js";
import type { EventHub } from "../services/event-hub.js";
import type { HubService } from "../services/hub.js";
import { register } from "./validate.js";
export function hubRoutes(app: Hono, hub: EventHub, hubService: HubService, supervisor?: Supervisor) {
	register(app, hub, routes.hub, ({ params }) => hubService.read(params.id, "inventory", routes.hub.response));
	register(app, hub, routes.hubExtensions, ({ params }) =>
		hubService.read(params.id, "extensions", routes.hubExtensions.response),
	);
	register(app, hub, routes.hubPlan, ({ params, body }) => hubService.plan(params.id, body));
	// A committed change reaches the project's open conversations by asking each to reload, as
	// /hub reload does in a terminal; the response says which did.
	register(app, hub, routes.hubPlanApply, async ({ params }) => {
		const result = await hubService.apply(params.id, params.planId);
		if (result.committed === 0 || supervisor === undefined) return result;
		return { ...result, refresh: await supervisor.reloadHub(params.id) };
	});
	register(app, hub, routes.hubPlanRelease, ({ params }) => hubService.release(params.id, params.planId));
	register(app, hub, routes.installationHub, () => hubService.read(null, "inventory", routes.installationHub.response));
	register(app, hub, routes.installationHubExtensions, () =>
		hubService.read(null, "extensions", routes.installationHubExtensions.response),
	);
	register(app, hub, routes.installationHubAgents, () => hubService.agents(null));
	register(app, hub, routes.installationHubPlan, ({ body }) => hubService.plan(null, body));
	// With no workspace open, a user-scope change reaches every open conversation, whatever its project.
	register(app, hub, routes.installationHubPlanApply, async ({ params }) => {
		const result = await hubService.apply(null, params.planId);
		if (result.committed === 0 || supervisor === undefined) return result;
		return { ...result, refresh: await supervisor.reloadHub(null) };
	});
	register(app, hub, routes.installationHubPlanRelease, ({ params }) => hubService.release(null, params.planId));
	register(app, hub, routes.hubAgents, ({ params }) => hubService.agents(params.id));
	register(app, hub, routes.hubVerifiers, ({ params }) => hubService.verifiers(params.id));
}
