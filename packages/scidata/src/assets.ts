// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractPackageTarball } from "./tar-extract.js";

/**
 * The scientific-format readers are npm packages too large or too rarely used
 * to ship in PanCode's package (h5wasm alone is 3.4 MB). Each is fetched on first
 * use as its exact registry tarball, accepted only when its sha256 matches the
 * pin below, kept in the host's cache directory, and unpacked beside it into a
 * private node_modules tree that the reader worker imports by file URL. Nothing
 * is installed into the project or the host's package, and an air-gapped host
 * can pre-seed the cache by copying the tarball to the path the refusal names.
 */

/** One pinned tarball: fetched from `url`, accepted only when its sha256 matches, kept at `path`. */
export interface ReaderAsset {
	/** Plain name for error text. */
	label: string;
	url: string;
	sha256: string;
	path: string;
}

export interface ResolveAssetOptions {
	/** Bounds one download, connect phase included. */
	timeoutMs: number;
	/** After a failed download, refuse without fetching for this long, across processes. */
	retryAfterMs: number;
}

/**
 * Supplies an asset's bytes, from `asset.path` when a verified copy is there,
 * otherwise by fetching `asset.url`. It throws an Error whose message an
 * operator can act on. The bytes are checked against the pin again after it
 * returns, so a resolver cannot widen what is accepted.
 */
export type ResolveAsset = (asset: ReaderAsset, options: ResolveAssetOptions) => Promise<Uint8Array>;

export interface ReaderAssetOptions {
	/** Directory that holds one `<name>@<version>` directory per pinned reader. */
	cacheDir: string;
	/** Defaults to fetchPinnedAsset. */
	resolveAsset?: ResolveAsset | undefined;
}

export interface ReaderPackage {
	name: string;
	version: string;
	sha256: string;
}

export interface ScientificReader {
	/** Plain name for messages: "HDF5 and NetCDF-4". */
	formats: string;
	main: ReaderPackage;
	/** The module the worker imports, relative to the package root. */
	entry: string;
	/** Packages the entry imports by bare name, unpacked into the same node_modules tree. */
	deps: ReadonlyArray<ReaderPackage>;
	/** What to use instead when the reader cannot be fetched. */
	fallback: string;
}

/** Registry tarballs, pinned by the sha256 of the exact bytes npm serves (cross-checked against npm's sha512 integrity). */
export const SCIENTIFIC_READERS = {
	hdf5: {
		formats: "HDF5 and NetCDF-4",
		main: {
			name: "h5wasm",
			version: "0.10.3",
			sha256: "2a9f35ab25c000c164e9dec5e61a0909d0884163ed5dc793e775603805d9570b",
		},
		entry: "dist/node/hdf5_hl.js",
		deps: [],
		fallback: "run_script with h5py (HDF5) or netCDF4 (NetCDF-4)",
	},
	parquet: {
		formats: "Parquet",
		main: {
			name: "hyparquet",
			version: "1.31.5",
			sha256: "5fb6b118fcbc4575771204acd0aa5cab532f40be92339094b7cc756d79830ab5",
		},
		entry: "src/node.js",
		deps: [],
		fallback: "run_script with pyarrow",
	},
} as const satisfies Record<string, ScientificReader>;

export type ScientificReaderId = keyof typeof SCIENTIFIC_READERS;

/** One tarball download may hold a tool call this long, connect phase included. */
export const READER_FETCH_TIMEOUT_MS = 20_000;

/**
 * After a failed download no process on the host retries that reader for this
 * long, so an air-gapped login node pays the timeout once per window instead
 * of once per data call.
 */
export const READER_FETCH_RETRY_MS = 10 * 60_000;

const MARKER = ".pancode-reader-pins.json";

function tarballUrl(pkg: ReaderPackage): string {
	return `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
}

function readerDir(reader: ScientificReader, cacheDir: string): string {
	return join(cacheDir, `${reader.main.name}@${reader.main.version}`);
}

function tarballAsset(reader: ScientificReader, pkg: ReaderPackage, cacheDir: string): ReaderAsset {
	return {
		label: `${pkg.name} ${pkg.version} (the ${reader.formats} reader)`,
		url: tarballUrl(pkg),
		sha256: pkg.sha256,
		path: join(cacheDir, `${pkg.name}@${pkg.version}`, `${pkg.name}-${pkg.version}.tgz`),
	};
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function failurePath(asset: ReaderAsset): string {
	return `${asset.path}.unavailable.json`;
}

/** Write through a sibling temporary file and one rename, so a reader never sees a torn file. */
function writeAtomically(path: string, data: Uint8Array | string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		writeFileSync(temporary, data);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** The persisted reason the last download failed, while its retry window is open. */
function recentFailure(asset: ReaderAsset, retryAfterMs: number): string | null {
	try {
		const record = JSON.parse(readFileSync(failurePath(asset), "utf8")) as { failedAt?: unknown; reason?: unknown };
		if (typeof record.failedAt !== "number" || typeof record.reason !== "string") return null;
		const age = Date.now() - record.failedAt;
		return age >= 0 && age < retryAfterMs ? record.reason : null;
	} catch {
		// No record, or one torn by a concurrent writer: either way, try the download.
		return null;
	}
}

/** Undici reports every network failure as "fetch failed"; the cause carries the code worth showing. */
function fetchFailure(error: unknown, timeoutMs: number): string {
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return `no complete response within ${Math.round(timeoutMs / 1000)}s`;
	}
	const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
	if (cause instanceof Error) {
		const code = (cause as Error & { code?: unknown }).code;
		return typeof code === "string" ? `${code} (${cause.message})` : cause.message;
	}
	return error instanceof Error ? error.message : String(error);
}

async function download(asset: ReaderAsset, timeoutMs: number): Promise<Buffer> {
	const failed = (detail: string): Error => new Error(`could not download ${asset.label} from ${asset.url}: ${detail}`);
	const signal = AbortSignal.timeout(timeoutMs);
	let response: Response;
	try {
		response = await fetch(asset.url, { signal });
	} catch (error) {
		throw failed(fetchFailure(error, timeoutMs));
	}
	if (!response.ok) throw failed(`HTTP ${response.status}`);
	let bytes: Buffer;
	try {
		bytes = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw failed(fetchFailure(error, timeoutMs));
	}
	if (sha256Hex(bytes) !== asset.sha256) {
		throw new Error(`${asset.label} downloaded from ${asset.url} does not match its pinned sha256`);
	}
	return bytes;
}

/**
 * The default ResolveAsset: the cached copy when its sha256 matches the pin,
 * otherwise one download of the exact registry tarball bounded by
 * `timeoutMs`, verified, then written atomically to `asset.path`. A failure is
 * recorded beside that path, and every process on the host refuses without
 * fetching until `retryAfterMs` has passed.
 */
export async function fetchPinnedAsset(asset: ReaderAsset, options: ResolveAssetOptions): Promise<Uint8Array> {
	if (existsSync(asset.path)) {
		const cached = readFileSync(asset.path);
		if (sha256Hex(cached) === asset.sha256) return cached;
	}
	const reason = recentFailure(asset, options.retryAfterMs);
	if (reason !== null) throw new Error(reason);
	try {
		const bytes = await download(asset, options.timeoutMs);
		writeAtomically(asset.path, bytes);
		rmSync(failurePath(asset), { force: true });
		return bytes;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			writeAtomically(failurePath(asset), `${JSON.stringify({ failedAt: Date.now(), reason: message })}\n`);
		} catch {
			// An unwritable cache dir only costs the next process another bounded attempt.
		}
		throw error;
	}
}

function expectedMarker(reader: ScientificReader): string {
	return JSON.stringify([reader.main, ...reader.deps].map((pkg) => `${pkg.name}@${pkg.version}#${pkg.sha256}`));
}

/** Raised when a reader is neither cached nor fetchable; the message is the whole operator-facing story. */
export class ReaderUnavailableError extends Error {
	constructor(reader: ScientificReader, pkg: ReaderPackage, reason: string, cacheDir: string) {
		const asset = tarballAsset(reader, pkg, cacheDir);
		super(
			`PanCode reads ${reader.formats} with ${pkg.name} ${pkg.version}, which it downloads once on first use and caches, and that download is not available: ${reason}. ` +
				`No process on this host retries it for ${Math.round(READER_FETCH_RETRY_MS / 60_000)} minutes after a failure. ` +
				`On an offline host, copy ${asset.url} (sha256 ${pkg.sha256}) to ${asset.path}, or use ${reader.fallback}.`,
		);
		this.name = "ReaderUnavailableError";
	}
}

/**
 * The absolute path of the reader's entry module, fetching and unpacking the
 * pinned tarballs on first use. The unpacked tree appears by one rename with
 * its pin marker inside, so a concurrent process sees either nothing or a
 * complete tree for exactly these pins.
 */
export async function ensureScientificReader(reader: ScientificReader, options: ReaderAssetOptions): Promise<string> {
	const { cacheDir } = options;
	const resolveAsset = options.resolveAsset ?? fetchPinnedAsset;
	const dir = readerDir(reader, cacheDir);
	const modules = join(dir, "node_modules");
	const entry = join(modules, reader.main.name, reader.entry);
	const marker = expectedMarker(reader);
	const current = (): boolean => {
		try {
			return readFileSync(join(modules, MARKER), "utf8") === marker && existsSync(entry);
		} catch {
			// No marker yet: the tree is absent or was never completed.
			return false;
		}
	};
	if (current()) return entry;
	const tarballs: Array<[ReaderPackage, Uint8Array]> = [];
	for (const pkg of [reader.main, ...reader.deps]) {
		const asset = tarballAsset(reader, pkg, cacheDir);
		let bytes: Uint8Array;
		try {
			bytes = await resolveAsset(asset, { timeoutMs: READER_FETCH_TIMEOUT_MS, retryAfterMs: READER_FETCH_RETRY_MS });
		} catch (error) {
			throw new ReaderUnavailableError(reader, pkg, error instanceof Error ? error.message : String(error), cacheDir);
		}
		if (sha256Hex(bytes) !== pkg.sha256) {
			throw new ReaderUnavailableError(reader, pkg, `${asset.label} does not match its pinned sha256`, cacheDir);
		}
		tarballs.push([pkg, bytes]);
	}
	const staging = join(dir, `node_modules.tmp-${process.pid}-${Date.now().toString(36)}`);
	try {
		for (const [pkg, bytes] of tarballs) extractPackageTarball(bytes, join(staging, pkg.name));
		writeFileSync(join(staging, MARKER), marker);
		if (existsSync(modules) && !current()) rmSync(modules, { recursive: true, force: true });
		try {
			renameSync(staging, modules);
		} catch (error) {
			// Another process finished the same extraction first; its tree carries the same pins.
			if (!current()) throw error;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	if (!current()) throw new Error(`unpacked ${reader.main.name} ${reader.main.version} but ${entry} is missing`);
	return entry;
}
