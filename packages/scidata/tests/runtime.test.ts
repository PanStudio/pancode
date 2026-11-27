// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { createScidata, isDataRefusal, type ResolveAsset } from "../src/index.js";

/**
 * The runtime a standalone host gets: an offline cache miss refuses without
 * leaving a partial tree, and an aborted read ends its worker thread.
 */

const require = createRequire(import.meta.url);

/** The package default names only its built worker; a source run loads the TypeScript entry through tsx. */
function sourceWorkerUrl(): URL {
	const loaderApi = pathToFileURL(require.resolve("tsx/esm/api")).href;
	const source = new URL("../src/worker/index.ts", import.meta.url).href;
	return new URL(
		`data:text/javascript,${encodeURIComponent(`const { register } = await import(${JSON.stringify(loaderApi)}); register(); await import(${JSON.stringify(source)});`)}`,
	);
}

const unreachable: ResolveAsset = async (asset) => {
	throw new Error(`could not download ${asset.label} from ${asset.url}: ENOTFOUND (getaddrinfo ENOTFOUND)`);
};

describe("scidata runtime", () => {
	it("refuses an HDF5 read offline with reader-unavailable and leaves the cache empty", async () => {
		const root = mkdtempSync(join(tmpdir(), "scidata-offline-"));
		const file = join(root, "data.h5");
		writeFileSync(file, Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]));
		const result = await createScidata({ cacheDir: join(root, "cache"), resolveAsset: unreachable }).inspectData(file);
		ok(isDataRefusal(result));
		strictEqual(result.reason, "reader-unavailable");
		ok(result.message.includes("ENOTFOUND"), result.message);
		deepStrictEqual(readdirSync(root), ["data.h5"]);
	});

	it("returns aborted when the signal fires during a read and ends the worker thread", async () => {
		const root = mkdtempSync(join(tmpdir(), "scidata-abort-"));
		const file = join(root, "data.nc");
		// Classic NetCDF by signature, so the read goes to a worker without a fetched reader.
		writeFileSync(file, Buffer.concat([Buffer.from("CDF\x01", "latin1"), Buffer.alloc(28)]));
		const scidata = createScidata({
			cacheDir: join(root, "cache"),
			resolveAsset: unreachable,
			workerUrl: sourceWorkerUrl(),
		});
		const workers: Worker[] = [];
		let exited = 0;
		const controller = new AbortController();
		// Abort once the reader worker is running, so the refusal comes from inside the read.
		const onWorker = (message: unknown): void => {
			const worker = (message as { worker: Worker }).worker;
			workers.push(worker);
			worker.once("online", () => controller.abort());
			worker.once("exit", () => {
				exited += 1;
			});
		};
		subscribe("worker_threads", onWorker);
		try {
			const result = await scidata.inspectData(file, { signal: controller.signal });
			ok(isDataRefusal(result));
			strictEqual(result.reason, "aborted");
			strictEqual(result.message, "aborted before the read finished");
		} finally {
			unsubscribe("worker_threads", onWorker);
		}
		strictEqual(workers.length, 1);
		strictEqual(exited, 1);
		strictEqual(workers[0]?.threadId, -1);
	});

	it("reports stats progress and completes even when onProgress throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "scidata-progress-"));
		const store = join(root, "grid.zarr");
		const arr = join(store, "t");
		mkdirSync(arr, { recursive: true });
		writeFileSync(join(store, ".zgroup"), JSON.stringify({ zarr_format: 2 }));
		writeFileSync(
			join(arr, ".zarray"),
			JSON.stringify({
				zarr_format: 2,
				shape: [4],
				chunks: [4],
				dtype: "<f8",
				compressor: null,
				fill_value: null,
				order: "C",
				filters: null,
			}),
		);
		const raw = new Float64Array([1, 2, 3, 4]);
		writeFileSync(join(arr, "0"), Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
		const scidata = createScidata({
			cacheDir: join(root, "cache"),
			resolveAsset: unreachable,
			workerUrl: sourceWorkerUrl(),
		});
		const seen: number[] = [];
		const result = await scidata.statsData(store, {
			variable: "t",
			onProgress: (values) => {
				seen.push(values);
				throw new Error("progress sink failed");
			},
		});
		ok(!isDataRefusal(result));
		strictEqual(result.elementsScanned, 4);
		deepStrictEqual(seen, [4]);
	});
});
