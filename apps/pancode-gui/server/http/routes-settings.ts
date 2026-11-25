// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { SettingsService } from "../services/settings.js";
import { register } from "./validate.js";

export function settingsRoutes(app: Hono, hub: EventHub, settings: SettingsService) {
	register(app, hub, routes.settingsReport, ({ query }) => settings.settings(query.workspace));
	register(app, hub, routes.settingsControls, ({ query }) => settings.controls(query.workspace));
	register(app, hub, routes.writeSetting, ({ query, body }) => settings.write(query.workspace, body));
	register(app, hub, routes.configGraph, ({ params }) => settings.graph(params.id));
	register(app, hub, routes.userConfigGraph, () => settings.graph(null));
}
