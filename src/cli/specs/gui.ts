// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../lib/help.js";

export const spec = defineCommandSpec({
	path: ["gui"],
	summary: "open the alpha graphical application; 'gui background restart' after an upgrade",
	hidden: false,
});
