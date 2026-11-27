// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `catalog` server: search the dataset catalogs the operator named in a
 * catalog file, describe one dataset, and stage one of its files to a path.
 * The file is `<XDG_CONFIG_HOME or ~/.config>/science-data/catalog.json`. The
 * server ships no sources, so without the file every tool names the path to
 * create.
 */
import os from "node:os";
import path from "node:path";
import { defineServer, type ToolServer } from "pancode/sdk/tool";
import { catalogTools } from "./tools.js";

/** The catalog file under the configuration directory, read at each call so a file written later is seen. */
export function defaultCatalogFile(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
	return path.join(base, "science-data", "catalog.json");
}

/** The server reading the catalog file `catalogFile` names at each call. */
export function catalogServer(catalogFile: () => string): ToolServer {
	return defineServer({
		id: "catalog",
		version: "0.2.0",
		title: "Dataset catalogs",
		instructions:
			"The datasets are the sources listed in one catalog file the operator writes; without that file every tool fails and names the path it looked for. A local source lists files on this host; a ckan source is a public CKAN portal reached over https, and downloads go only to its own host or the hosts its resourceHosts entry lists.",
		tools: catalogTools({ catalogFile, requestTimeoutMs: 20_000, stallTimeoutMs: 60_000 }),
	});
}

export const server = catalogServer(defaultCatalogFile);
