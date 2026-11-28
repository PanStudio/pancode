// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../lib/help.js";

export const spec = defineCommandSpec({
	path: ["connections"],
	summary: "list configured connections, health, auth, and capabilities",
	hidden: false,
});
