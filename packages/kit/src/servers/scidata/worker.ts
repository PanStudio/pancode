// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Where the scientific reader worker is. `@pancode/scidata` starts its reads
 * in a worker thread from a module URL, and that module has three homes:
 *
 * - `source`: a checkout run through tsx. The worker is TypeScript, so it
 *   loads through tsx's loader, registered from a `data:` module.
 * - `bundle`: PanCode's own build, which inlines the library. The worker is
 *   `dist/data/scientific-worker.js`; this module lands either in a shared
 *   chunk at `dist/` or in `dist/kit/cli.js`.
 * - `package`: the kit installed with `@pancode/scidata` as a dependency. The
 *   library's default, its own `dist/worker/index.js`, is right.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export type WorkerShape = "source" | "bundle" | "package";

export interface WorkerLocation {
	shape: WorkerShape;
	/** What to pass as `workerUrl`; undefined leaves the library's default. */
	url: URL | undefined;
	/** The worker file this resolves to, or null when it cannot be named. */
	file: string | null;
}

const BUNDLED_WORKER = ["./data/scientific-worker.js", "../data/scientific-worker.js"];

function fileExists(url: URL): boolean {
	return existsSync(url);
}

/** The worker for a module at `moduleUrl`; `exists` is injectable so each shape can be checked without its layout. */
export function locateReaderWorker(
	moduleUrl: string = import.meta.url,
	exists: (url: URL) => boolean = fileExists,
): WorkerLocation {
	if (moduleUrl.endsWith(".ts")) {
		const require = createRequire(moduleUrl);
		const loaderApi = pathToFileURL(require.resolve("tsx/esm/api")).href;
		const source = import.meta.resolve("@pancode/scidata/worker");
		const url = new URL(
			`data:text/javascript,${encodeURIComponent(`const { register } = await import(${JSON.stringify(loaderApi)}); register(); await import(${JSON.stringify(source)});`)}`,
		);
		return { shape: "source", url, file: source.startsWith("file:") ? fileURLToPath(source) : null };
	}
	for (const candidate of BUNDLED_WORKER) {
		const url = new URL(candidate, moduleUrl);
		if (exists(url)) return { shape: "bundle", url, file: fileURLToPath(url) };
	}
	let file: string | null = null;
	try {
		const resolved = import.meta.resolve("@pancode/scidata/worker");
		if (resolved.startsWith("file:")) file = fileURLToPath(resolved);
	} catch {
		// Not installed beside the kit: the probe reports the worker as missing.
	}
	return { shape: "package", url: undefined, file };
}

let located: WorkerLocation | undefined;

/** This module's worker, found on first use and kept. */
export function readerWorker(): WorkerLocation {
	located ??= locateReaderWorker();
	return located;
}
