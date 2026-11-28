// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../lib/help.js";

export const spec = defineCommandSpec({
	path: ["telemetry"],
	summary: "read session and run telemetry (--json for the DTO)",
	hidden: false,
});

/** Nested leaves, each dispatched inside `telemetry` by its own lazy import. */
export const leaves = [
	defineCommandSpec({ path: ["telemetry", "quota"], summary: "provider quota snapshot (--json)", hidden: false }),
	defineCommandSpec({ path: ["telemetry", "health"], summary: "telemetry read-model health (--json)", hidden: false }),
	defineCommandSpec({ path: ["telemetry", "runs"], summary: "the runs a session referenced (--json)", hidden: false }),
] as const;
