// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../lib/help.js";

export const spec = defineCommandSpec({
	path: ["agents"],
	summary: "list discovered agent recipes",
	hidden: false,
});

/** Nested leaves added in 0.8.5; `agents list` is the same read as bare `agents` (C14). */
export const leaves = [
	defineCommandSpec({ path: ["agents", "list"], summary: "list discovered agent recipes (--json)", hidden: false }),
] as const;
