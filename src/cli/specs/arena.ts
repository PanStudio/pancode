// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["arena"],
	summary: "run one prompt on 2 to 4 contenders, vote blind, read standings",
	hidden: false,
});
