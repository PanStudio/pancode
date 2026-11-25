// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["semantic"],
	summary: "configure, qualify, manage inboxes, refresh, reembed, search, or inspect the semantic index (beta)",
	hidden: false,
});
