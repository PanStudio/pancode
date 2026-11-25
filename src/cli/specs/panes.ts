// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["panes"],
	summary: "repair PanCode's pane host (herdr) or print PanCode's theme as a herdr block",
	hidden: false,
});
