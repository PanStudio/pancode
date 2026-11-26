// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `catalog` server: search the dataset catalogs the operator named in a
 * catalog file, describe one dataset, and stage one of its files to a path.
 * The file is the one `--file` names. PanCode ships no sources, so until the
 * operator writes that file the server is unavailable and says which path to
 * create.
 */
import path from "node:path";
import { defineServer } from "@pancode/sdk/tool";
import { type ServerProbe, ServerUsageError } from "../../registry.js";
import { CATALOG_EXAMPLE } from "./example.js";
import { catalogTools, loadCatalog } from "./tools.js";

let configuredFile: string | null = null;

/** The catalog file `--file` named. Throws before `configure` has run. */
export function catalogFilePath(): string {
	if (configuredFile === null) throw new Error("the catalog server was started without --file <path>");
	return configuredFile;
}

export const server = defineServer({
	id: "catalog",
	version: "0.1.0",
	title: "Dataset catalogs",
	tools: catalogTools({ catalogFile: catalogFilePath, requestTimeoutMs: 20_000, stallTimeoutMs: 60_000 }),
});

export const usage = `Options:
  --file <path>  the catalog file to read (required)

The catalog file is {"version": 1, "sources": [...]}. A "local" source needs
id, type and datasets; each dataset needs id and title, and each resource needs
id and an absolute path. A "ckan" source needs id, type and the portal's base
url.
`;

export const example = `A valid catalog file to start from:

${CATALOG_EXAMPLE}`;

/** Takes `--file <path>`, which it requires, resolved against the working directory; any other option is refused. */
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
	if (file === null) throw new ServerUsageError("--file <path> is required");
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
