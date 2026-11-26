// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createScidata, type DataRefusal, isDataRefusal, SCIENTIFIC_READERS } from "@pancode/scidata";
import type { AnyTool } from "@pancode/sdk/tool";
import { configureServer, findServer, loadServer } from "../src/registry.js";
import { configure, probe, server } from "../src/servers/scidata/index.js";
import { readerCacheDir } from "../src/servers/scidata/runtime.js";
import { kitWords, MAX_RESULT_BYTES } from "../src/servers/scidata/tools.js";
import { locateReaderWorker } from "../src/servers/scidata/worker.js";

/**
 * The scidata server against the library it wraps. Every input is
 * constructed by this file, none captured: a CSV, a JSON document, a JSON
 * Lines file, a classic NetCDF (CDF-1) file written byte by byte, a Zarr v2
 * store with one raw float64 array, a SQLite header, and an HDF5 signature.
 * Each tool result is compared with the same call made on `createScidata`
 * directly, bound to the same cache and worker. The server runs no program,
 * so there are no stub programs. No test fetches a reader: the HDF5 case
 * finds a recorded download failure in the cache and refuses at once.
 */

const root = mkdtempSync(join(tmpdir(), "kit-scidata-"));
const cacheDir = join(root, "cache");
configure(["--cache", cacheDir]);

const worker = locateReaderWorker();
const library = createScidata({ cacheDir, ...(worker.url !== undefined ? { workerUrl: worker.url } : {}) });

function tool(name: string): AnyTool {
	const found = server.tools.find((entry) => entry.name === name);
	assert.ok(found, `server lists ${name}`);
	return found;
}

async function call(name: string, args: Record<string, unknown>, signal = new AbortController().signal) {
	return tool(name).run(args as never, { signal, log: () => undefined });
}

function refusalText(operation: string, refusal: DataRefusal): string {
	return `${operation} refused (${refusal.reason}): ${kitWords(refusal.message)}`;
}

/** The library's result with its notes in this server's words. */
function inKitWords(result: unknown): unknown {
	if (result === null || typeof result !== "object" || !("notes" in result) || !Array.isArray(result.notes))
		return result;
	return { ...result, notes: result.notes.map((note: unknown) => (typeof note === "string" ? kitWords(note) : note)) };
}

/**
 * The tool's answer is the library's: the result object as `{ json }`, a
 * refusal as the `data` tool words it, both with PanCode's tool names (op=,
 * run_script, the data tool) in this server's words.
 */
async function assertSame(
	operation: "inspect" | "select" | "stats",
	args: Record<string, unknown>,
	direct: Promise<unknown>,
): Promise<unknown> {
	const got = await call(`scidata_${operation}`, args);
	const expected = await direct;
	if (isDataRefusal(expected)) {
		assert.deepEqual(got, { error: refusalText(operation, expected) });
		assert.doesNotMatch((got as { error: string }).error, /op=|run_script|the data tool/u);
	} else assert.deepEqual(got, { json: inKitWords(expected) });
	return expected;
}

function writeTree(base: string, files: Record<string, Buffer | string>): void {
	for (const [name, body] of Object.entries(files)) {
		const file = join(base, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
	}
}

/** A classic NetCDF (CDF-1) file: dimension x of 4, variable temp(x) as big-endian float64 with a units attribute. */
function classicNetcdf(values: number[]): Buffer {
	const parts: Buffer[] = [];
	const u32 = (value: number): void => {
		const b = Buffer.alloc(4);
		b.writeUInt32BE(value);
		parts.push(b);
	};
	const padded = (bytes: Buffer): void => {
		parts.push(bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4));
	};
	const name = (text: string): void => {
		u32(text.length);
		padded(Buffer.from(text, "latin1"));
	};
	parts.push(Buffer.from("CDF\x01", "latin1"));
	u32(0);
	u32(0x0a);
	u32(1);
	name("x");
	u32(values.length);
	u32(0);
	u32(0);
	u32(0x0b);
	u32(1);
	name("temp");
	u32(1);
	u32(0);
	u32(0x0c);
	u32(1);
	name("units");
	u32(2);
	u32(1);
	padded(Buffer.from("K", "latin1"));
	u32(6);
	u32(values.length * 8);
	const begin = Buffer.alloc(4);
	parts.push(begin);
	begin.writeUInt32BE(parts.reduce((total, part) => total + part.length, 0));
	const data = Buffer.alloc(values.length * 8);
	for (const [index, value] of values.entries()) data.writeDoubleBE(value, index * 8);
	parts.push(data);
	return Buffer.concat(parts);
}

function float64le(values: number[]): Buffer {
	const b = Buffer.alloc(values.length * 8);
	for (const [index, value] of values.entries()) b.writeDoubleLE(value, index * 8);
	return b;
}

const csv = join(root, "runs.csv");
writeFileSync(csv, "run,temp,label\n1,280.5,alpha\n2,NA,beta\n3,290.25,gamma\n");
const json = join(root, "config.json");
writeFileSync(json, JSON.stringify({ name: "demo", steps: [1, 2, 3], nested: { on: true, big: 1 } }));
const jsonl = join(root, "events.jsonl");
writeFileSync(jsonl, '{"t":1,"v":0.5}\n{"t":2,"v":null}\n{"t":3,"v":2.5}\n');
const netcdf = join(root, "classic.nc");
writeFileSync(netcdf, classicNetcdf([270, 275.5, 281, 299.75]));
const zarr = join(root, "grid.zarr");
writeTree(zarr, {
	".zgroup": JSON.stringify({ zarr_format: 2 }),
	"field/.zarray": JSON.stringify({
		zarr_format: 2,
		shape: [2, 3],
		chunks: [2, 3],
		dtype: "<f8",
		compressor: null,
		fill_value: -1,
		order: "C",
		filters: null,
	}),
	"field/.zattrs": JSON.stringify({ units: "m", _FillValue: -1 }),
	"field/0.0": float64le([1, 2, 3, 4, 5, -1]),
});

test("the server is scidata 0.1.0 with three read tools that each read path", () => {
	assert.equal(server.id, "scidata");
	assert.equal(server.version, "0.1.0");
	assert.equal(server.title, "Scientific data");
	assert.deepEqual(
		server.tools.map((entry) => [entry.name, entry.actionClass, entry.pathArguments]),
		[
			["scidata_inspect", "read", { path: "read" }],
			["scidata_select", "read", { path: "read" }],
			["scidata_stats", "read", { path: "read" }],
		],
	);
	for (const entry of server.tools) {
		assert.ok(!Object.hasOwn(entry.input.properties ?? {}, "table"), `${entry.name} offers no table`);
		assert.ok(!Object.hasOwn(entry.input.properties ?? {}, "sql"), `${entry.name} offers no sql`);
	}
});

test("CSV: inspect, select and stats answer as the library does", async () => {
	const inspected = (await assertSame(
		"inspect",
		{ path: csv, sample_rows: 2 },
		library.inspectData(csv, { sampleRows: 2 }),
	)) as {
		format: string;
	};
	assert.equal(inspected.format, "csv");
	await assertSame(
		"select",
		{ path: csv, offset: 1, limit: 1, columns: ["temp", 2], header: true },
		library.selectData(csv, { offset: 1, limit: 1, columns: ["temp", 2], header: true }),
	);
	await assertSame("stats", { path: csv }, library.statsData(csv));
});

test("JSON: inspect, select by pointer and stats answer as the library does", async () => {
	await assertSame("inspect", { path: json, max_rows: null }, library.inspectData(json, { maxRows: null }));
	const selected = (await assertSame(
		"select",
		{ path: json, pointer: "/steps" },
		library.selectData(json, { pointer: "/steps" }),
	)) as Record<string, unknown>;
	assert.ok(!isDataRefusal(selected));
	await assertSame("stats", { path: json }, library.statsData(json));
});

test("JSON Lines: inspect, select and stats answer as the library does", async () => {
	await assertSame("inspect", { path: jsonl }, library.inspectData(jsonl));
	await assertSame("select", { path: jsonl, offset: 1, limit: 2 }, library.selectData(jsonl, { offset: 1, limit: 2 }));
	await assertSame("stats", { path: jsonl }, library.statsData(jsonl));
});

test("classic NetCDF: inspect, a hyperslab and stats answer as the library does, through the reader worker", async () => {
	const inspected = (await assertSame("inspect", { path: netcdf }, library.inspectData(netcdf))) as Record<
		string,
		unknown
	>;
	assert.ok(!isDataRefusal(inspected), JSON.stringify(inspected));
	const slab = (await assertSame(
		"select",
		{ path: netcdf, variable: "temp", start: [1], count: [2], stride: [2] },
		library.selectData(netcdf, { variable: "temp", start: [1], count: [2], stride: [2] }),
	)) as Record<string, unknown>;
	assert.deepEqual(slab.values, [275.5, 299.75]);
	const stats = (await assertSame(
		"stats",
		{ path: netcdf, variable: "temp", max_bytes: 1024 },
		library.statsData(netcdf, { variable: "temp", maxBytes: 1024 }),
	)) as Record<string, unknown>;
	assert.equal(stats.min, 270);
	assert.equal(stats.max, 299.75);
});

test("Zarr: inspect, select and stats answer as the library does", async () => {
	await assertSame("inspect", { path: zarr, variable: "field" }, library.inspectData(zarr, { variable: "field" }));
	const slab = (await assertSame(
		"select",
		{ path: zarr, variable: "field" },
		library.selectData(zarr, { variable: "field" }),
	)) as Record<string, unknown>;
	assert.deepEqual(slab.values, [
		[1, 2, 3],
		[4, 5, -1],
	]);
	const stats = (await assertSame(
		"stats",
		{ path: zarr, variable: "/field", start: [0, 1], count: [2, 2] },
		library.statsData(zarr, { variable: "/field", start: [0, 1], count: [2, 2] }),
	)) as Record<string, unknown>;
	assert.equal(stats.fillCount, 1);
});

test("a missing path, a directory that is no store and a SQLite file are tool errors with the library's reason", async () => {
	const missing = join(root, "absent.csv");
	await assertSame("inspect", { path: missing }, library.inspectData(missing));
	assert.match(
		((await call("scidata_inspect", { path: missing })) as { error: string }).error,
		/^inspect refused \(not-found\): /,
	);

	const plain = join(root, "plain-dir");
	mkdirSync(plain);
	await assertSame("select", { path: plain }, library.selectData(plain));
	assert.match(
		((await call("scidata_select", { path: plain })) as { error: string }).error,
		/^select refused \(not-a-file\): /,
	);

	const sqlite = join(root, "store.sqlite");
	writeFileSync(sqlite, Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(84)]));
	await assertSame("inspect", { path: sqlite }, library.inspectData(sqlite));
	assert.match(
		((await call("scidata_inspect", { path: sqlite })) as { error: string }).error,
		/^inspect refused \(reader-unavailable\): /,
	);
});

test("an HDF5 read whose reader cannot be fetched returns the library's refusal naming the path to pre-seed", async () => {
	const file = join(root, "data.h5");
	writeFileSync(file, Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]));
	const { name, version } = SCIENTIFIC_READERS.hdf5.main;
	const tarball = join(cacheDir, `${name}@${version}`, `${name}-${version}.tgz`);
	// A recorded failure inside the retry window: the library refuses without fetching.
	writeTree(dirname(tarball), {
		[`${name}-${version}.tgz.unavailable.json`]: JSON.stringify({ failedAt: Date.now(), reason: "ENOTFOUND (offline)" }),
	});
	const got = (await call("scidata_inspect", { path: file })) as { error: string };
	assert.match(got.error, /^inspect refused \(reader-unavailable\): /);
	assert.ok(got.error.includes(tarball), got.error);
	await assertSame("inspect", { path: file }, library.inspectData(file));
});

test("a result over 256 KiB of JSON is a tool error naming the argument that narrows it", async () => {
	const wide = join(root, "wide.csv");
	const columns = Array.from({ length: 40 }, (_, index) => `column_${index}`);
	const rows = Array.from({ length: 1000 }, (_, row) => columns.map((_, index) => `${row}.${index}123456`).join(","));
	writeFileSync(wide, `${columns.join(",")}\n${rows.join("\n")}\n`);
	const direct = await library.selectData(wide, { limit: 1000 });
	assert.ok(Buffer.byteLength(JSON.stringify(direct)) > MAX_RESULT_BYTES);
	const got = (await call("scidata_select", { path: wide, limit: 1000 })) as { error: string };
	assert.match(got.error, /^scidata_select: the result is \d+ bytes of JSON, over the 262144 bytes \(256 KiB\)/);
	assert.match(got.error, /narrow it with limit or columns$/);
	assert.ok("json" in (await call("scidata_select", { path: wide, limit: 10 })));
});

test("arguments outside the schema are refused before the library is called", async () => {
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{}, /^scidata_inspect: path is required$/],
		[{ path: csv, table: "t" }, /^scidata_inspect: unknown argument table$/],
		[{ path: csv, format: "sqlite" }, /^scidata_inspect: format must be one of csv, /],
		[{ path: csv, sample_rows: -1 }, /^scidata_inspect: sample_rows must be an integer >= 0$/],
		[{ path: csv, max_rows: 1.5 }, /^scidata_inspect: max_rows must be an integer >= 1 or null$/],
		[{ path: csv, header: "yes" }, /^scidata_inspect: header must be true, false or "auto"$/],
	];
	for (const [args, expected] of cases) {
		const got = (await call("scidata_inspect", args)) as { error?: string };
		assert.match(got.error ?? "", expected, JSON.stringify(args));
	}
	const slab = (await call("scidata_select", { path: netcdf, variable: "temp", count: [0] })) as { error?: string };
	assert.equal(slab.error, "scidata_select: count must be a non-empty array of integers >= 1");
});

test("the call's signal reaches the library: an aborted call is the library's aborted refusal", async () => {
	const controller = new AbortController();
	controller.abort();
	const got = (await call("scidata_inspect", { path: netcdf }, controller.signal)) as { error?: string };
	assert.match(got.error ?? "", /^inspect refused \(aborted\): /);
});

test("configure takes --cache <dir> and refuses anything else as a usage error", async () => {
	const loaded = await loadServer(findServer("scidata") as NonNullable<ReturnType<typeof findServer>>);
	try {
		assert.equal(configureServer("scidata", loaded, ["--cache", "relative/readers"]), null);
		assert.equal(readerCacheDir(), resolve("relative/readers"));
		assert.equal(configureServer("scidata", loaded, [`--cache=${cacheDir}`]), null);
		assert.equal(readerCacheDir(), cacheDir);
		for (const argv of [["--bogus"], ["--cache"], ["--cache", "--bogus"], ["--cache", "a", "--cache", "b"], ["extra"]]) {
			const refused = configureServer("scidata", loaded, argv);
			assert.ok(refused !== null, `refuses ${argv.join(" ")}`);
			assert.ok(refused.includes("--cache <dir>"), refused);
		}
		// PanCode names the cache; the server has no default of its own.
		assert.match(configureServer("scidata", loaded, []) ?? "", /--cache <dir> is required/u);
	} finally {
		configure(["--cache", cacheDir]);
	}
});

test("probe is available and says whether each reader is in the cache", async () => {
	const first = await probe();
	assert.equal(first.available, true);
	const readers = (first.sources ?? []).filter((source) => source.name !== "reader worker");
	assert.deepEqual(
		readers.map((source) => [source.name, source.found]),
		[
			["h5wasm 0.10.3 (HDF5 and NetCDF-4 reader)", false],
			["hyparquet 1.31.5 (Parquet reader)", false],
		],
	);
	const { name, version } = SCIENTIFIC_READERS.parquet.main;
	writeTree(join(cacheDir, `${name}@${version}`), { [`${name}-${version}.tgz`]: "seeded" });
	const seeded = (await probe()).sources?.find((source) => source.name.startsWith("hyparquet"));
	assert.equal(seeded?.found, true);
});

test("the worker of a source run is the TypeScript entry loaded through tsx", async () => {
	assert.equal(worker.shape, "source");
	assert.equal(worker.url?.protocol, "data:");
	const entry = fileURLToPath(new URL("../../scidata/src/worker/index.ts", import.meta.url));
	assert.equal(worker.file, entry);
	assert.ok(decodeURIComponent(worker.url?.href ?? "").includes(pathToFileURL(entry).href));
	const source = (await probe()).sources?.find((entry) => entry.name === "reader worker");
	assert.deepEqual(source, { name: "reader worker", found: true, detail: `${entry} (source)` });
	// The bundled and packaged shapes, from their layouts: PanCode's dist/data worker, else the library's default.
	const bundled = locateReaderWorker("file:///opt/pancode/dist/chunk-abc.js", (url) =>
		url.href.endsWith("/dist/data/scientific-worker.js"),
	);
	assert.deepEqual([bundled.shape, bundled.url?.href], ["bundle", "file:///opt/pancode/dist/data/scientific-worker.js"]);
	const fromKitCli = locateReaderWorker(
		"file:///opt/pancode/dist/kit/cli.js",
		(url) => url.href === "file:///opt/pancode/dist/data/scientific-worker.js",
	);
	assert.equal(fromKitCli.shape, "bundle");
	const packaged = locateReaderWorker("file:///opt/site/node_modules/@pancode/kit/dist/cli.js", () => false);
	assert.deepEqual([packaged.shape, packaged.url], ["package", undefined]);
});
