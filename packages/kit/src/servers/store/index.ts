// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `store` server: a project's PanStore for any MCP host. It reads every
 * tag of the project the options name and writes only into the tags named
 * with `--write-tag`, through `@pancode/store` alone, so its puts and notes
 * are the records PanCode's own store tool and `pancode store` read. Started
 * without a `--root` it is unavailable and every tool says how to start it.
 */
import { stat } from "node:fs/promises";
import { defineServer } from "@pancode/sdk/tool";
import type { ServerProbe } from "../../registry.js";
import { NO_ROOT_REASON, parseStoreOptions, setStoreConfig, storeConfig, USAGE } from "./options.js";
import { primaryRootProblem, STORE_TOOLS } from "./tools.js";

export const server = defineServer({ id: "store", version: "0.1.0", title: "Project store", tools: STORE_TOOLS });

export const usage = USAGE;

/** Sets the store the tools reach; no `--root` leaves the server unconfigured, which is not an error. */
export function configure(argv: ReadonlyArray<string>): void {
	setStoreConfig(parseStoreOptions(argv, process.cwd()));
}

/** Available when configured and the primary root is a directory; `sources` names each root and whether it exists. */
export async function probe(): Promise<ServerProbe> {
	const config = storeConfig();
	if (config === null) return { available: false, reason: NO_ROOT_REASON };
	const sources = [];
	for (const root of config.roots) {
		let found = false;
		try {
			found = (await stat(root.path)).isDirectory();
		} catch {
			found = false;
		}
		sources.push({ name: `root ${root.name}`, found, detail: root.path });
	}
	const problem = await primaryRootProblem(config);
	return problem === null ? { available: true, sources } : { available: false, reason: problem, sources };
}
