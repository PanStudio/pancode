// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Every route the server serves, in the order the OpenAPI document lists them. Each group is defined beside the
 * routes of its concern; the table spreads them in sequence so the document's path order does not move.
 */

import { fleetRoutes } from "./routes-fleet.js";
import { hubRoutes } from "./routes-hub.js";
import { installationRoutes } from "./routes-installation.js";
import { reportRoutes } from "./routes-reports.js";
import { serverRoutes } from "./routes-server.js";
import { sessionRoutes, sessionSnapshotRoutes, sessionWorkRoutes } from "./routes-sessions.js";
import { settingsRoutes } from "./routes-settings.js";
import { telemetryMetricRoutes, telemetryRoutes } from "./routes-telemetry.js";
import { workspaceRoutes, workspaceTrustRoutes } from "./routes-workspaces.js";

export const routes = {
	...telemetryMetricRoutes,
	...installationRoutes,
	...hubRoutes,
	...reportRoutes,
	...fleetRoutes,
	...settingsRoutes,
	...sessionWorkRoutes,
	...workspaceRoutes,
	...sessionRoutes,
	...telemetryRoutes,
	...serverRoutes,
	...sessionSnapshotRoutes,
	...workspaceTrustRoutes,
};
