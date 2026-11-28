// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../lib/help.js";

export const spec = defineCommandSpec({
	path: ["fleet"],
	summary: "run playbooks on the fleet; inspect, verify, land, stop, or cancel runs; admission control",
	hidden: false,
});
