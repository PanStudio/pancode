// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The server's binding of `@pancode/scidata`: the reader cache directory, the
 * reader worker, and no SQLite reader. HDF5 and Parquet readers are fetched
 * into the cache by the library's own resolver on first use.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createScidata, SCIENTIFIC_READERS, type Scidata } from "@pancode/scidata";
import { ServerUsageError } from "../../registry.js";
import { readerWorker } from "./worker.js";

export const USAGE = `Options:
  --cache <dir>  where the HDF5 and Parquet readers are kept
                 (default: <XDG_CACHE_HOME or ~/.cache>/pankit/data-readers)`;

let cacheOverride: string | undefined;

/** The reader cache directory: `--cache` when given, else `<XDG_CACHE_HOME or ~/.cache>/pankit/data-readers`. */
export function readerCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	if (cacheOverride !== undefined) return cacheOverride;
	const xdg = env.XDG_CACHE_HOME;
	// The XDG base directory spec ignores a relative value.
	const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
	return join(base, "pankit", "data-readers");
}

/** Takes `--cache <dir>` (or `--cache=<dir>`); each call replaces what the last one set. */
export function configureScidata(argv: ReadonlyArray<string>): void {
	let cache: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		let value: string | undefined;
		if (arg === "--cache") {
			value = argv[index + 1];
			index += 1;
		} else if (arg.startsWith("--cache=")) value = arg.slice("--cache=".length);
		else throw new ServerUsageError(`unknown option ${arg}`);
		if (value === undefined || value.length === 0 || value.startsWith("-")) {
			throw new ServerUsageError("--cache needs a directory");
		}
		if (cache !== undefined) throw new ServerUsageError("--cache given twice");
		cache = resolve(value);
	}
	cacheOverride = cache;
}

/** The library bound to this server's cache and worker; built per call so `--cache` holds from the first one. */
export function scidata(): Scidata {
	const worker = readerWorker();
	return createScidata({
		cacheDir: readerCacheDir(),
		...(worker.url !== undefined ? { workerUrl: worker.url } : {}),
	});
}

export interface ReaderCacheState {
	name: string;
	found: boolean;
	detail: string;
}

/** Whether each fetched reader is already in `cacheDir`, unpacked or as its tarball, without fetching anything. */
export function readerCacheStates(cacheDir: string): ReaderCacheState[] {
	return Object.values(SCIENTIFIC_READERS).map((reader) => {
		const { name, version } = reader.main;
		const dir = join(cacheDir, `${name}@${version}`);
		const label = `${name} ${version} (${reader.formats} reader)`;
		const tarball = join(dir, `${name}-${version}.tgz`);
		if (existsSync(join(dir, "node_modules", name, reader.entry))) return { name: label, found: true, detail: dir };
		if (existsSync(tarball)) return { name: label, found: true, detail: `${tarball}, unpacked on first use` };
		return {
			name: label,
			found: false,
			detail: `not in ${cacheDir}; fetched from the npm registry on first use, or copy https://registry.npmjs.org/${name}/-/${name}-${version}.tgz to ${tarball}`,
		};
	});
}
