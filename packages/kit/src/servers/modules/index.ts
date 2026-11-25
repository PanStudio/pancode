// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `modules` server: the site's software modules, read through Lmod or
 * Environment Modules. It lists, shows and plans; it never loads a module,
 * since no process can change the environment of the session that called it.
 */
import { defineServer } from "@pancode/sdk/tool";
import type { ServerProbe } from "../../registry.js";
import { findModuleTool, MODULES_ENVIRONMENT } from "./locate.js";
import { MODULES_TOOLS } from "./tools.js";

export const server = defineServer({
	id: "modules",
	version: "0.1.0",
	title: "Software modules",
	tools: MODULES_TOOLS,
});

/** The login shell's module variables, which the tool needs to find modulefiles and the loaded list. */
export const environment = MODULES_ENVIRONMENT;

/** Available where LMOD_CMD, MODULES_CMD or modulecmd names the tool; looks it up without running it. */
export async function probe(): Promise<ServerProbe> {
	const located = findModuleTool();
	return located.ok
		? { available: true, sources: located.sources }
		: { available: false, reason: located.reason, sources: located.sources };
}
