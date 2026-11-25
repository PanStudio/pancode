// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createScidata, type Scidata, type SqliteReader } from "@pancode/scidata";
import { loadPinnedAsset } from "../../core/pinned-asset.js";
import { resolvePancodeDirs } from "../../core/xdg.js";

/**
 * The `data` tool's binding of @pancode/scidata: reader tarballs under
 * PanCode's cache dir, fetched through loadPinnedAsset so proxy handling and
 * the cross-process retry window match every other pinned asset, the SQLite
 * reader that runs through safe-exec, and the reader worker PanCode builds
 * itself.
 */

const require = createRequire(import.meta.url);
let resolvedWorkerUrl: URL | undefined;

function workerUrl(): URL {
	resolvedWorkerUrl ??= readerWorkerUrl();
	return resolvedWorkerUrl;
}

function readerWorkerUrl(): URL {
	if (!import.meta.url.endsWith(".ts")) return new URL("./data/scientific-worker.js", import.meta.url);
	// Source runs (tests, tsx) load the TypeScript entry through tsx's loader, resolved
	// absolutely so a fixture cwd cannot shadow it (the codewiki build worker does the same).
	const loaderApi = pathToFileURL(require.resolve("tsx/esm/api")).href;
	const source = import.meta.resolve("@pancode/scidata/worker");
	return new URL(
		`data:text/javascript,${encodeURIComponent(`const { register } = await import(${JSON.stringify(loaderApi)}); register(); await import(${JSON.stringify(source)});`)}`,
	);
}

// Imported on first use so the data tool never loads the SQLite reader for other formats.
const sqlite: SqliteReader = {
	inspect: async (path, bytes, options) => (await import("./sqlite.js")).inspectSqlite(path, bytes, options),
	select: async (path, bytes, options) => (await import("./sqlite.js")).selectSqlite(path, bytes, options),
};

/** Built per call: the cache dir follows PANCODE_HOME and the XDG overrides as they are at call time. */
function scidata(): Scidata {
	return createScidata({
		cacheDir: join(resolvePancodeDirs().cache, "data-readers"),
		resolveAsset: (asset, options) => loadPinnedAsset(asset, options),
		sqlite,
		workerUrl: workerUrl(),
	});
}

export const inspectData: Scidata["inspectData"] = (path, options) => scidata().inspectData(path, options);
export const selectData: Scidata["selectData"] = (path, options) => scidata().selectData(path, options);
export const validateData: Scidata["validateData"] = (path, options) => scidata().validateData(path, options);
export const statsData: Scidata["statsData"] = (path, options) => scidata().statsData(path, options);
