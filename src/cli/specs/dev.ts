// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["dev"],
	summary: "PanCode's own components, change manifests and intake store; run 'pancode dev' for the list",
	hidden: false,
});
