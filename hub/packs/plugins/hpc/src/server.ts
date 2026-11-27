// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `hpc` server: four tool groups on one stdio server. `node_*` reads facts
 * about this machine, `modules_*` the site's software modules, `spack_*` a
 * Spack instance and `darshan_*` Darshan logs. A group whose program this host
 * lacks answers every call with the reason; the other groups work.
 */
import { defineServer } from "pancode/sdk/tool";
import { DARSHAN_TOOLS } from "./darshan/tools.js";
import { MODULES_ENVIRONMENT } from "./modules/locate.js";
import { MODULES_TOOLS } from "./modules/tools.js";
import { NODE_TOOLS } from "./node/tools.js";
import { SPACK_ENVIRONMENT } from "./spack/program.js";
import { SPACK_TOOLS } from "./spack/tools.js";

export const server = defineServer({
	id: "hpc",
	version: "0.5.0",
	title: "HPC node, modules, Spack and Darshan",
	instructions:
		"A tool group whose program is missing on this host (the module tool, spack, darshan-parser) answers every call with the reason. The module tool and MODULEPATH come from the login shell the host was started from; where `module avail` does not work in that shell, every modules tool reports the module tool missing. No tool loads a module into the caller's environment: modules_plan writes the `module load` lines for a script.",
	tools: [...NODE_TOOLS, ...MODULES_TOOLS, ...SPACK_TOOLS, ...DARSHAN_TOOLS],
});

/**
 * The variables the modules and spack groups read from the caller's
 * environment: a name, or a prefix of at least four characters ending in `*`.
 * The plugin's `mcp.json` passes them as `envVars`.
 */
export const environment: ReadonlyArray<string> = [...MODULES_ENVIRONMENT, ...SPACK_ENVIRONMENT];
