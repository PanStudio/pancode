// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { SetupService } from "../services/setup.js";
import type { TargetsService } from "../services/targets-cli.js";
import { idempotencyKey, register } from "./validate.js";

export function targetsRoutes(app: Hono, hub: EventHub, targets: TargetsService, setup: SetupService) {
	register(app, hub, routes.setupStatus, ({ query }) => setup.status(query.workspace));
	register(app, hub, routes.setupStart, ({ body }, context) => setup.start(body, idempotencyKey(context)));
	register(app, hub, routes.setupState, ({ params }) => setup.snapshot(params.id));
	register(app, hub, routes.setupAnswer, ({ params, body }, context) =>
		setup.answer(params.id, body, idempotencyKey(context)),
	);
	register(app, hub, routes.setupCancel, ({ params }) => setup.cancel(params.id));
	register(app, hub, routes.targetsList, ({ params }, context) => targets.list(params.id, context.req.raw.signal));
	register(app, hub, routes.routing, ({ params }) => targets.routing(params.id));
	// The user's own connections are readable and changeable before any workspace is open.
	register(app, hub, routes.userTargetsList, (_input, context) => targets.list(null, context.req.raw.signal));
	register(app, hub, routes.userRouting, () => targets.routing(null));
	const actions = [
		["probe", routes.targetsProbe, routes.userTargetsProbe],
		["use", routes.targetsUse, routes.userTargetsUse],
		["signout", routes.targetsSignOut, routes.userTargetsSignOut],
		["remove", routes.targetsRemove, routes.userTargetsRemove],
	] as const;
	for (const [action, scoped, user] of actions) {
		register(app, hub, scoped, async ({ params }, context) => ({
			operationId: await targets.mutate(params.id, params.connectionId, action, idempotencyKey(context)),
		}));
		register(app, hub, user, async ({ params }, context) => ({
			operationId: await targets.mutate(null, params.connectionId, action, idempotencyKey(context)),
		}));
	}
}
