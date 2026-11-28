// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["models"],
	summary: "list models for configured connections",
	hidden: false,
});
