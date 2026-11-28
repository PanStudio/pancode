// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Worker URL for a TypeScript worker `source` under test/source execution. That execution changes cwd for hermetic
 * fixtures, so a tiny JavaScript bootstrap imports the absolute TypeScript loader before dynamically loading the
 * source worker; relying on inherited `--import tsx` would resolve `tsx` from the fixture and Node 24 would otherwise
 * strip the entry's types without remapping its internal `.js` specifiers back to `.ts`.
 */
export function sourceWorkerUrl(source: URL): URL {
	const loaderApi = pathToFileURL(require.resolve("tsx/esm/api")).href;
	return new URL(
		`data:text/javascript,${encodeURIComponent(`const { tsImport } = await import(${JSON.stringify(loaderApi)}); await tsImport(${JSON.stringify(source.href)}, import.meta.url);`)}`,
	);
}
