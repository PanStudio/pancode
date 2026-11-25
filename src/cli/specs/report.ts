// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["report"],
	summary: "preview, then send a report to the maintainers",
	hidden: false,
});

/** Nested leaves, each dispatched inside `report`. */
export const leaves = [
	defineCommandSpec({
		path: ["report", "sweep"],
		summary: "delete this machine's expired report bundles",
		hidden: false,
	}),
] as const;
