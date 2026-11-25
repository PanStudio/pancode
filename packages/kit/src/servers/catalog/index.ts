// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `catalog` server: search the dataset catalogs the operator named in a
 * catalog file, describe one dataset, and stage one of its files to a path.
 * The file is `<XDG_CONFIG_HOME or ~/.config>/pankit/catalog.json`, or the
 * path `--file` gives. PanKit ships no sources, so without the file the
 * server is unavailable and says which path to create.
 */
import os from "node:os";
import path from "node:path";
import { defineServer } from "@pancode/sdk/tool";
import { type ServerProbe, ServerUsageError } from "../../registry.js";
import { catalogTools, loadCatalog } from "./tools.js";

let configuredFile: string | null = null;

/** The catalog file this server reads: `--file` when given, else the default under the configuration directory. */
export function catalogFilePath(): string {
	if (configuredFile !== null) return configuredFile;
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
	return path.join(base, "pankit", "catalog.json");
}

export const server = defineServer({
	id: "catalog",
	version: "0.1.0",
	title: "Dataset catalogs",
	tools: catalogTools({ catalogFile: catalogFilePath, requestTimeoutMs: 20_000, stallTimeoutMs: 60_000 }),
});

export const usage = `Options:
  --file <path>  the catalog file to read, instead of
                 <XDG_CONFIG_HOME or ~/.config>/pankit/catalog.json

The catalog file is {"version": 1, "sources": [...]}. A "local" source needs
id, type and datasets; each dataset needs id and title, and each resource needs
id and an absolute path. A "ckan" source needs id, type and the portal's base
url. pankit catalog --example prints a valid file to start from.
`;

/** Takes `--file <path>`, resolved against the working directory; any other option is refused. */
export function configure(argv: ReadonlyArray<string>): void {
	let file: string | null = null;
	for (let index = 0; index < argv.length; index++) {
		const option = argv[index];
		if (option !== "--file") throw new ServerUsageError(`unknown option ${option}`);
		if (file !== null) throw new ServerUsageError("--file is given twice");
		const value = argv[index + 1];
		if (value === undefined || value.length === 0) throw new ServerUsageError("--file needs a path");
		file = path.resolve(value);
		index++;
	}
	configuredFile = file;
}

/** Available when the catalog file exists and is valid; reads the file and contacts no source. */
export async function probe(): Promise<ServerProbe> {
	const file = catalogFilePath();
	const loaded = await loadCatalog(file);
	if (!loaded.ok) {
		// An invalid or unreadable file is there: the reason says what is wrong with it, the source only whether it exists.
		const source =
			loaded.file === "missing"
				? { name: file, found: false }
				: { name: file, found: true, detail: loaded.file === "invalid" ? "not valid" : "cannot be read" };
		return { available: false, reason: loaded.error, sources: [source] };
	}
	const counts = loaded.catalog.sources.map((source) => `${source.id} (${source.type})`);
	return {
		available: true,
		sources: [
			{ name: file, found: true, detail: counts.length > 0 ? `sources: ${counts.join(", ")}` : "lists no source" },
		],
	};
}
