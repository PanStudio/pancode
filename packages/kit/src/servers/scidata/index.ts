// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `scidata` server: inspect, select and summarize scientific and tabular
 * data files through `@pancode/scidata`, the library behind PanCode's own
 * `data` tool, so an MCP host gets the answers PanCode gives. It runs no site
 * command; the library reads the files, in a worker thread for the
 * scientific formats.
 */
import { existsSync } from "node:fs";
import { defineServer } from "@pancode/sdk/tool";
import type { ProbeSource, ServerProbe } from "../../registry.js";
import { configureScidata, readerCacheDir, readerCacheStates, USAGE } from "./runtime.js";
import { SCIDATA_TOOLS } from "./tools.js";
import { readerWorker } from "./worker.js";

export const server = defineServer({ id: "scidata", version: "0.2.0", title: "Scientific data", tools: SCIDATA_TOOLS });

export const usage = USAGE;

export function configure(argv: ReadonlyArray<string>): void {
	configureScidata(argv);
}

function workerSource(): ProbeSource {
	const name = "reader worker";
	try {
		const worker = readerWorker();
		if (worker.file === null) {
			return { name, found: false, detail: "@pancode/scidata/worker cannot be resolved beside this server" };
		}
		if (!existsSync(worker.file)) return { name, found: false, detail: `${worker.file} is missing` };
		return { name, found: true, detail: `${worker.file} (${worker.shape})` };
	} catch (error) {
		return { name, found: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Available everywhere: CSV, TSV, JSON and JSON Lines need nothing more. The
 * sources name the reader worker the scientific formats run in, and whether
 * the HDF5 and Parquet readers are already in the cache.
 */
export async function probe(): Promise<ServerProbe> {
	const cacheDir = readerCacheDir();
	return {
		available: true,
		sources: [
			workerSource(),
			...readerCacheStates(cacheDir).map((state) => ({ name: state.name, found: state.found, detail: state.detail })),
		],
	};
}
