// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AnyTool } from "@pancode/sdk/tool";
import {
	ckanSha256,
	ckanTime,
	MAX_SOURCES,
	parseCatalogFile,
} from "../../../hub/packs/plugins/science-data/src/parse.js";
import {
	type CatalogSettings,
	catalogTools,
	MAX_LIMIT,
	MAX_RESOURCES,
} from "../../../hub/packs/plugins/science-data/src/tools.js";
import { ServerUsageError } from "../src/registry.js";
import { catalogFilePath, configure, probe, server } from "../src/servers/catalog/index.js";

/**
 * The catalog server against catalog files this test writes and an HTTP
 * server it starts on 127.0.0.1 that answers CKAN's action API.
 *
 * Inputs: every catalog file and every CKAN document here is constructed.
 * The CKAN documents (`package_search`, `package_show`, `status_show`, and
 * the error envelope) were written from CKAN's action API documentation and
 * then compared field by field with the answers of a public CKAN 2.11.5
 * endpoint: UTC timestamps without a zone, `hash` as an empty string when
 * none is set, `size` as an integer, `num_resources` beside `resources`, and
 * a 404 for a dataset that does not exist. Names, ids and hosts are
 * placeholders.
 *
 * The server runs no program, so there are no stub programs: the test server
 * records every request it receives (path, query and headers), and the tests
 * assert exactly what was asked and that a refused host was never asked.
 */

const context = { signal: new AbortController().signal, log: () => {}, progress: () => {} };
const root = mkdtempSync(join(tmpdir(), "pankit-catalog-"));

function scratch(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// A payload large enough to arrive in several chunks.
const DATA = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251));
const DATA_SHA256 = createHash("sha256").update(DATA).digest("hex");

interface Recorded {
	path: string;
	query: URLSearchParams;
	host: string;
	headers: IncomingMessage["headers"];
}

let ckan: Server;
let port = 0;
const requests: Recorded[] = [];
const held: ServerResponse[] = [];

function pkg(name: string, title: string, notes: string | null, resources: unknown[]) {
	return {
		author: null,
		id: `00000000-0000-4000-8000-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`,
		isopen: true,
		license_id: "cc-by",
		license_title: "Creative Commons Attribution",
		metadata_created: "2025-09-03T07:22:58.757927",
		metadata_modified: "2025-09-03T07:22:59.532764",
		name,
		notes,
		num_resources: resources.length,
		num_tags: 2,
		organization: null,
		private: false,
		state: "active",
		title,
		type: "dataset",
		resources,
		tags: [
			{ display_name: "ocean", id: "t1", name: "ocean", state: "active", vocabulary_id: null },
			{ display_name: "salinity", id: "t2", name: "salinity", state: "active", vocabulary_id: null },
		],
		groups: [],
		extras: [],
	};
}

function resource(id: string, url: string, extra: Record<string, unknown> = {}) {
	return {
		cache_url: null,
		created: "2025-09-03T07:22:59.544883",
		datastore_active: false,
		description: null,
		format: "NetCDF",
		hash: "",
		id,
		last_modified: null,
		metadata_modified: "2025-09-03T07:22:59.540724",
		mimetype: null,
		name: `${id}.nc`,
		package_id: "placeholder",
		position: 0,
		resource_type: null,
		size: DATA.length,
		state: "active",
		url,
		url_type: null,
		...extra,
	};
}

function packages() {
	const base = `http://127.0.0.1:${port}/files`;
	return [
		pkg("ocean-salinity-2023", "Ocean salinity 2023", "Monthly salinity grids.", [
			resource("grid", `${base}/data.bin`, { hash: DATA_SHA256 }),
			resource("grid-md5", `${base}/data.bin`, { hash: "d41d8cd98f00b204e9800998ecf8427e", size: null }),
			resource("chunked", `${base}/chunked.bin`, { size: "200000" }),
			resource("bad-hash", `${base}/data.bin`, { hash: `sha256:${"0".repeat(64)}` }),
			resource("elsewhere", `http://localhost:${port}/files/data.bin`),
			resource("redirect-out", `${base}/redirect-out`),
			resource("redirect-in", `${base}/redirect-in`),
			resource("stall", `${base}/stall`),
			resource("missing", `${base}/missing.bin`),
		]),
		pkg("ocean-temperature", "Ocean temperature", null, []),
		pkg("ocean-currents", "Ocean currents", "Surface currents.", []),
		pkg("ocean-waves", "Ocean waves", "Wave heights.", []),
		pkg("ocean-ice", "Ocean ice", "Sea ice extent.", []),
	];
}

function send(response: ServerResponse, status: number, body: string, type = "application/json;charset=utf-8") {
	response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
	response.end(body);
}

function action(mode: string, name: string, query: URLSearchParams, response: ServerResponse) {
	const help = `http://127.0.0.1:${port}/api/3/action/help_show?name=${name}`;
	if (mode === "broken") return send(response, 500, "SECRET-BODY Traceback (most recent call last)", "text/plain");
	if (mode === "notjson") return send(response, 200, "<html>down for maintenance</html>", "text/html");
	if (mode === "slow") {
		held.push(response);
		return;
	}
	if (name === "status_show")
		return send(
			response,
			200,
			JSON.stringify({ help, success: true, result: { site_title: "Placeholder", ckan_version: "2.11.5" } }),
		);
	if (name === "package_search") {
		const all = packages();
		const start = Number(query.get("start") ?? 0);
		const rows = Number(query.get("rows") ?? 10);
		const result = {
			count: all.length,
			facets: {},
			results: all.slice(start, start + rows),
			sort: "score desc, metadata_modified desc",
			search_facets: {},
		};
		return send(response, 200, JSON.stringify({ help, success: true, result }));
	}
	if (name === "package_show") {
		const found = packages().find((entry) => entry.name === query.get("id"));
		if (found === undefined)
			return send(
				response,
				404,
				JSON.stringify({ help, success: false, error: { message: "Not found", __type: "Not Found Error" } }),
			);
		return send(response, 200, JSON.stringify({ help, success: true, result: found }));
	}
	return send(response, 400, JSON.stringify({ help, success: false, error: { __type: "Bad request" } }));
}

function files(name: string, response: ServerResponse) {
	if (name === "data.bin") {
		response.writeHead(200, { "content-type": "application/octet-stream", "content-length": DATA.length });
		return response.end(DATA);
	}
	if (name === "chunked.bin") {
		response.writeHead(200, { "content-type": "application/octet-stream" });
		for (let offset = 0; offset < DATA.length; offset += 16_384) response.write(DATA.subarray(offset, offset + 16_384));
		return response.end();
	}
	if (name === "redirect-out") {
		response.writeHead(302, { location: `http://localhost:${port}/files/data.bin` });
		return response.end();
	}
	if (name === "redirect-in") {
		response.writeHead(302, { location: "/files/data.bin?X-Amz-Signature=SECRET-SIGNATURE#part" });
		return response.end();
	}
	if (name === "stall") {
		response.writeHead(200, { "content-type": "application/octet-stream" });
		response.write(DATA.subarray(0, 1000));
		held.push(response);
		return;
	}
	return send(response, 404, "SECRET-BODY not here", "text/plain");
}

before(async () => {
	ckan = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://placeholder");
		requests.push({
			path: url.pathname,
			query: url.searchParams,
			host: request.headers.host ?? "",
			headers: request.headers,
		});
		const parts = url.pathname.split("/").filter((part) => part.length > 0);
		if (parts[0] === "files") return files(parts[1] ?? "", response);
		if (parts[1] === "api" && parts[2] === "3" && parts[3] === "action")
			return action(parts[0] ?? "", parts[4] ?? "", url.searchParams, response);
		return send(response, 404, "{}");
	});
	await new Promise<void>((settle) => ckan.listen(0, "127.0.0.1", settle));
	port = (ckan.address() as AddressInfo).port;
});

after(async () => {
	for (const response of held) response.destroy();
	ckan.closeAllConnections();
	await new Promise<void>((settle) => ckan.close(() => settle()));
	configure([]);
});

function ckanSource(id: string, mode: string, extra: Record<string, unknown> = {}) {
	return { id, type: "ckan", url: `http://127.0.0.1:${port}/${mode}`, allowHttp: true, ...extra };
}

function writeCatalog(dir: string, sources: unknown[]): string {
	const file = join(dir, "catalog.json");
	writeFileSync(file, JSON.stringify({ version: 1, sources }, null, "\t"));
	return file;
}

function tools(file: string, overrides: Partial<CatalogSettings> = {}): Map<string, AnyTool> {
	const settings: CatalogSettings = {
		catalogFile: () => file,
		requestTimeoutMs: 5_000,
		stallTimeoutMs: 5_000,
		...overrides,
	};
	return new Map(catalogTools(settings).map((tool) => [tool.name, tool as unknown as AnyTool]));
}

async function run(set: Map<string, AnyTool>, name: string, args: Record<string, unknown>) {
	const tool = set.get(name);
	assert.ok(tool, name);
	return tool.run(args as never, context);
}

async function json(set: Map<string, AnyTool>, name: string, args: Record<string, unknown>) {
	const result = await run(set, name, args);
	assert.ok("json" in result, JSON.stringify(result));
	return result.json as Record<string, unknown>;
}

async function failure(set: Map<string, AnyTool>, name: string, args: Record<string, unknown>): Promise<string> {
	const result = await run(set, name, args);
	assert.ok("error" in result, JSON.stringify(result));
	return result.error;
}

const LOCAL = {
	id: "site",
	type: "local",
	datasets: [
		{
			id: "climate-2024",
			title: "Regional climate runs 2024",
			description: "Daily fields, 12 km grid.",
			tags: ["climate", "netcdf"],
			resources: [{ id: "tas", name: "tas_day.nc", format: "NetCDF", path: "/placeholder/tas_day.nc", sha256: null }],
		},
	],
};

test("the server lists three tools with the classes and path arguments of its policy", () => {
	assert.equal(server.id, "catalog");
	assert.equal(server.title, "Dataset catalogs");
	assert.equal(server.version, "0.2.0");
	const shape = server.tools.map((tool) => [tool.name, tool.actionClass, tool.pathArguments]);
	assert.deepEqual(shape, [
		["catalog_search", "read", {}],
		["catalog_describe", "read", {}],
		["catalog_stage", "execute", { destination: "write" }],
	]);
});

test("a valid catalog file loads, and each problem is refused with its location", () => {
	const valid = parseCatalogFile(
		JSON.stringify({
			version: 1,
			sources: [
				LOCAL,
				{ id: "open", type: "ckan", url: "https://catalog.example.org/", resourceHosts: ["files.example.org"] },
			],
		}),
	);
	assert.ok(valid.ok, JSON.stringify(valid));
	assert.deepEqual(valid.value.sources[1], {
		id: "open",
		type: "ckan",
		url: "https://catalog.example.org",
		resourceHosts: ["files.example.org"],
		allowHttp: false,
	});

	const refused = (sources: unknown[]): string => {
		const parsed = parseCatalogFile(JSON.stringify({ version: 1, sources }));
		assert.equal(parsed.ok, false, JSON.stringify(sources));
		return parsed.ok ? "" : parsed.error;
	};
	const dataset = LOCAL.datasets[0];
	assert.equal(
		refused([{ ...LOCAL, datasets: [{ ...dataset, colour: "blue" }] }]),
		"sources[0].datasets[0].colour: unknown field",
	);
	assert.equal(
		refused([LOCAL, { id: "site", type: "ckan", url: "https://catalog.example.org" }]),
		"sources[1].id: duplicate source id site",
	);
	assert.equal(
		refused([{ ...LOCAL, datasets: [dataset, { ...dataset, title: "Again" }] }]),
		"sources[0].datasets[1].id: duplicate dataset id climate-2024",
	);
	assert.match(
		refused([{ id: "open", type: "ckan", url: "http://catalog.example.org" }]),
		/^sources\[0\]\.url: .*https.*allowHttp/u,
	);
	assert.ok(
		parseCatalogFile(
			JSON.stringify({
				version: 1,
				sources: [{ id: "open", type: "ckan", url: "http://catalog.example.org", allowHttp: true }],
			}),
		).ok,
	);
	assert.match(refused([{ id: "open", type: "ckan", url: "not a url" }]), /^sources\[0\]\.url: /u);
	assert.match(
		refused([
			{ id: "open", type: "ckan", url: "https://catalog.example.org", resourceHosts: ["https://files.example.org"] },
		]),
		/^sources\[0\]\.resourceHosts\[0\]: /u,
	);
	const many = Array.from({ length: MAX_SOURCES + 1 }, (_, index) => ({ id: `s${index}`, type: "local", datasets: [] }));
	assert.equal(refused(many), `sources: lists ${MAX_SOURCES + 1} sources; at most ${MAX_SOURCES} are allowed`);
	assert.ok(parseCatalogFile(JSON.stringify({ version: 1, sources: many.slice(0, MAX_SOURCES) })).ok);
});

test("without a catalog file the server is unavailable and every call names the path to create", async () => {
	const config = scratch("no-file-config");
	const saved = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = config;
	try {
		configure([]);
		const expected = join(config, "science-data", "catalog.json");
		assert.equal(catalogFilePath(), expected);
		const probed = await probe();
		assert.equal(probed.available, false);
		assert.deepEqual(probed.sources, [{ name: expected, found: false }]);
		assert.match(
			probed.reason ?? "",
			new RegExp(`no catalog file at ${expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
		);
		const search = server.tools.find((tool) => tool.name === "catalog_search");
		assert.ok(search);
		const result = await search.run({ query: "x" } as never, context);
		assert.ok("error" in result);
		assert.ok(result.error.includes(expected), result.error);

		const given = join(scratch("given-file"), "mine.json");
		configure(["--file", given]);
		assert.equal(catalogFilePath(), given);
		assert.ok(((await probe()).reason ?? "").includes(given));
		writeFileSync(given, JSON.stringify({ version: 1, sources: [LOCAL] }));
		assert.equal((await probe()).available, true);
		writeFileSync(given, JSON.stringify({ version: 1, sources: [LOCAL], extra: true }));
		const invalid = await probe();
		assert.equal(invalid.available, false);
		assert.match(invalid.reason ?? "", /the file\.extra: unknown field/u);
		// An invalid file is there: doctor says found, and the reason says what is wrong with it.
		assert.deepEqual(invalid.sources, [{ name: given, found: true, detail: "not valid" }]);

		assert.throws(() => configure(["--url", "x"]), ServerUsageError);
		assert.throws(() => configure(["--file"]), ServerUsageError);
	} finally {
		configure([]);
		if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = saved;
	}
});

test("local search matches every word over title, description and tags, clips, caps and pages", async () => {
	const dir = scratch("local-search");
	const datasets = [
		{ id: "climate-2024", title: "Regional climate runs 2024", description: "Daily fields.", tags: ["netcdf"] },
		{ id: "tags-only", title: "Runs", description: "Monthly means.", tags: ["Climate"] },
		{ id: "long", title: "Long text", description: `climate ${"x".repeat(700)}` },
		...Array.from({ length: 60 }, (_, index) => ({ id: `bulk-${index}`, title: `Bulk ${index}`, tags: ["bulk"] })),
	];
	const set = tools(writeCatalog(dir, [{ id: "site", type: "local", datasets }]));

	const climate = await json(set, "catalog_search", { query: "climate" });
	const ids = (climate.results as Array<{ id: string }>).map((entry) => entry.id);
	assert.deepEqual(ids, ["climate-2024", "tags-only", "long"]);
	assert.equal(climate.total, 3);
	assert.equal(climate.truncated, false);
	assert.deepEqual(climate.sources, [{ id: "site", type: "local", status: "ok", matches: 3 }]);
	const first = (climate.results as Array<Record<string, unknown>>)[0];
	assert.deepEqual(first, {
		source: "site",
		id: "climate-2024",
		title: "Regional climate runs 2024",
		description: "Daily fields.",
		descriptionClipped: false,
		tags: ["netcdf"],
		tagsTruncated: false,
		resourceCount: 0,
		license: null,
		updated: null,
		unavailable: {
			license: "the catalog file gives no license for this dataset",
			updated: "the catalog file gives no update time for this dataset",
		},
	});
	const long = (climate.results as Array<Record<string, unknown>>)[2];
	assert.equal(Array.from(long?.description as string).length, 500);
	assert.equal(long?.descriptionClipped, true);

	assert.deepEqual(
		((await json(set, "catalog_search", { query: "climate daily" })).results as Array<{ id: string }>).map((e) => e.id),
		["climate-2024"],
	);
	assert.equal((await json(set, "catalog_search", { query: "nothing-matches" })).total, 0);

	const bulk = await json(set, "catalog_search", { query: "bulk", limit: MAX_LIMIT });
	assert.equal((bulk.results as unknown[]).length, MAX_LIMIT);
	assert.equal(bulk.total, 60);
	assert.equal(bulk.truncated, true);
	const rest = await json(set, "catalog_search", { query: "bulk", limit: MAX_LIMIT, offset: MAX_LIMIT });
	assert.deepEqual(
		(rest.results as Array<{ id: string }>).map((entry) => entry.id),
		Array.from({ length: 10 }, (_, index) => `bulk-${MAX_LIMIT + index}`),
	);
	assert.equal(rest.truncated, false);
	assert.equal((await json(set, "catalog_search", { query: "bulk" })).limit, 20);

	assert.match(await failure(set, "catalog_search", { query: "bulk", limit: MAX_LIMIT + 1 }), /limit must be/u);
	assert.match(await failure(set, "catalog_search", { query: "-bulk" }), /query must be/u);
	assert.match(await failure(set, "catalog_search", { query: "a OR b:*" }), /query must be/u);
	assert.match(await failure(set, "catalog_search", { query: "bulk", source: "nope" }), /no source nope/u);
});

test("local describe lists resources with their size, path and hash, and caps the list", async () => {
	const dir = scratch("local-describe");
	const present = join(dir, "present.nc");
	writeFileSync(present, "twelve bytes");
	const resources = [
		{ id: "present", name: "present.nc", format: "NetCDF", path: present, sha256: "A".repeat(64) },
		{ id: "absent", path: join(dir, "absent.nc") },
		...Array.from({ length: MAX_RESOURCES + 5 }, (_, index) => ({ id: `r${index}`, path: present })),
	];
	const set = tools(
		writeCatalog(dir, [
			{
				id: "site",
				type: "local",
				datasets: [{ id: "big", title: "Big", license: "CC-BY-4.0", updated: "2024-05-01T12:00:00Z", resources }],
			},
		]),
	);
	const described = await json(set, "catalog_describe", { source: "site", id: "big" });
	assert.equal(described.resourceCount, MAX_RESOURCES + 7);
	assert.equal((described.resources as unknown[]).length, MAX_RESOURCES);
	assert.equal(described.truncated, true);
	assert.equal(described.license, "CC-BY-4.0");
	assert.equal(described.updated, "2024-05-01T12:00:00Z");
	const [one, two] = described.resources as Array<Record<string, unknown>>;
	assert.deepEqual(one, {
		id: "present",
		name: "present.nc",
		format: "NetCDF",
		sizeBytes: 12,
		path: present,
		sha256: "a".repeat(64),
		unavailable: {},
	});
	assert.equal(two?.sizeBytes, null);
	assert.deepEqual(Object.keys(two?.unavailable as object).sort(), ["format", "name", "sha256", "sizeBytes"]);
	assert.match(await failure(set, "catalog_describe", { source: "site", id: "nope" }), /has no dataset nope/u);
	assert.match(await failure(set, "catalog_describe", { source: "site", id: "../x" }), /id must match/u);
});

test("CKAN search and describe read package_search, package_show and status_show", async () => {
	const dir = scratch("ckan-read");
	const set = tools(writeCatalog(dir, [LOCAL, ckanSource("open", "ok")]));
	const seen = requests.length;
	const found = await json(set, "catalog_search", { query: "ocean", source: "open", limit: 2 });
	assert.equal(found.total, 5);
	assert.equal(found.truncated, true);
	assert.deepEqual(found.sources, [{ id: "open", type: "ckan", status: "ok", matches: 5, ckanVersion: "2.11.5" }]);
	const [salinity, temperature] = found.results as Array<Record<string, unknown>>;
	assert.deepEqual(salinity, {
		source: "open",
		id: "ocean-salinity-2023",
		title: "Ocean salinity 2023",
		description: "Monthly salinity grids.",
		descriptionClipped: false,
		tags: ["ocean", "salinity"],
		tagsTruncated: false,
		resourceCount: 9,
		license: "Creative Commons Attribution",
		updated: "2025-09-03T07:22:59.532764Z",
		unavailable: {},
	});
	assert.equal(temperature?.description, null);
	assert.equal((temperature?.unavailable as Record<string, string>).description, "the CKAN package has no notes");
	const searches = requests.slice(seen).filter((request) => request.path.endsWith("/package_search"));
	assert.equal(searches.length, 1);
	assert.deepEqual(Object.fromEntries(searches[0]?.query ?? []), { q: "ocean", start: "0", rows: "2", facet: "false" });
	for (const request of requests.slice(seen)) {
		assert.equal(request.headers.authorization, undefined);
		assert.equal(request.headers.cookie, undefined);
	}

	// Local matches come first; an offset past them asks CKAN only for the window it covers.
	const both = scratch("ckan-window");
	const local = {
		id: "site",
		type: "local",
		datasets: ["a", "b", "c"].map((id) => ({ id: `ocean-${id}`, title: `Ocean ${id}` })),
	};
	const mixed = tools(writeCatalog(both, [local, ckanSource("open", "ok")]));
	const before = requests.length;
	const page = await json(mixed, "catalog_search", { query: "ocean", offset: 2, limit: 3 });
	assert.deepEqual(
		(page.results as Array<{ source: string; id: string }>).map((entry) => `${entry.source}/${entry.id}`),
		["site/ocean-c", "open/ocean-salinity-2023", "open/ocean-temperature"],
	);
	assert.equal(page.total, 8);
	const windows = requests
		.slice(before)
		.filter((request) => request.path.endsWith("/package_search"))
		.map((request) => `${request.query.get("start")}+${request.query.get("rows")}`);
	assert.deepEqual(windows, ["0+0", "0+2"]);

	const described = await json(set, "catalog_describe", { source: "open", id: "ocean-salinity-2023" });
	assert.equal(described.ckanVersion, "2.11.5");
	assert.equal(described.resourceCount, 9);
	assert.equal(described.truncated, false);
	const resources = described.resources as Array<Record<string, unknown>>;
	assert.deepEqual(resources[0], {
		id: "grid",
		name: "grid.nc",
		format: "NetCDF",
		sizeBytes: DATA.length,
		url: `http://127.0.0.1:${port}/files/data.bin`,
		sha256: DATA_SHA256,
		unavailable: {},
	});
	assert.deepEqual(resources[1]?.unavailable, {
		sizeBytes: "the CKAN resource gives no size in bytes",
		sha256: "the CKAN resource's hash is not a SHA-256",
	});
	assert.equal(resources[2]?.sizeBytes, DATA.length);
	assert.equal(resources[3]?.sha256, "0".repeat(64));
	assert.match(
		await failure(set, "catalog_describe", { source: "open", id: "no-such-dataset" }),
		/package_show answered HTTP 404.*no public dataset no-such-dataset/u,
	);
	assert.equal(ckanTime("2025-09-03T07:22:59"), "2025-09-03T07:22:59Z");
	assert.equal(ckanTime("yesterday"), null);
	assert.equal(ckanSha256(""), null);
});

test("a CKAN source that fails reports its status without its body and leaves the others in place", async () => {
	const dir = scratch("ckan-fail");
	const set = tools(
		writeCatalog(dir, [
			LOCAL,
			ckanSource("broken", "broken"),
			ckanSource("open", "ok"),
			ckanSource("notjson", "notjson"),
			ckanSource("slow", "slow"),
		]),
		{ requestTimeoutMs: 300 },
	);
	const found = await json(set, "catalog_search", { query: "climate" });
	const statuses = found.sources as Array<Record<string, unknown>>;
	assert.deepEqual(
		statuses.map((entry) => [entry.id, entry.status]),
		[
			["site", "ok"],
			["broken", "failed"],
			["open", "ok"],
			["notjson", "failed"],
			["slow", "failed"],
		],
	);
	assert.match(statuses[1]?.error as string, /package_search answered HTTP 500/u);
	assert.match(statuses[3]?.error as string, /not JSON/u);
	assert.equal(statuses[4]?.error, "package_search timed out after 0.3 seconds");
	assert.doesNotMatch(JSON.stringify(found), /SECRET-BODY|Traceback|maintenance/u);
	assert.deepEqual(
		(found.results as Array<{ source: string; id: string }>).map((entry) => `${entry.source}/${entry.id}`),
		[
			"site/climate-2024",
			"open/ocean-salinity-2023",
			"open/ocean-temperature",
			"open/ocean-currents",
			"open/ocean-waves",
			"open/ocean-ice",
		],
	);
	assert.match(
		await failure(set, "catalog_describe", { source: "slow", id: "anything" }),
		/package_show timed out after 0\.3 seconds/u,
	);
});

function leftovers(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.includes("pankit-part"));
}

test("catalog_stage copies a local resource and downloads a CKAN one, verifying the hash", async () => {
	const dir = scratch("stage-ok");
	const original = join(dir, "original.bin");
	writeFileSync(original, DATA);
	const local = {
		id: "site",
		type: "local",
		datasets: [
			{
				id: "d",
				title: "D",
				resources: [
					{ id: "r", path: original, sha256: DATA_SHA256 },
					{ id: "plain", path: original },
				],
			},
		],
	};
	const set = tools(writeCatalog(dir, [local, ckanSource("open", "ok")]));
	const copy = join(dir, "copy.bin");
	const copied = await json(set, "catalog_stage", { source: "site", dataset: "d", resource: "r", destination: copy });
	assert.deepEqual(copied, {
		source: "site",
		dataset: "d",
		resource: "r",
		destination: copy,
		bytesWritten: DATA.length,
		sha256: DATA_SHA256,
		expectedSha256: DATA_SHA256,
		verified: true,
		from: { path: original },
		unavailable: {},
	});
	assert.deepEqual(readFileSync(copy), DATA);
	const plain = await json(set, "catalog_stage", {
		source: "site",
		dataset: "d",
		resource: "plain",
		destination: join(dir, "plain.bin"),
	});
	assert.equal(plain.verified, false);
	assert.ok((plain.unavailable as Record<string, string>).expectedSha256);

	const downloaded = join(dir, "downloaded.bin");
	const args = { source: "open", dataset: "ocean-salinity-2023", resource: "grid", destination: downloaded };
	const fetched = await json(set, "catalog_stage", args);
	assert.equal(fetched.bytesWritten, DATA.length);
	assert.equal(fetched.sha256, DATA_SHA256);
	assert.equal(fetched.verified, true);
	assert.deepEqual(readFileSync(downloaded), DATA);

	assert.match(await failure(set, "catalog_stage", args), /exists; pass overwrite: true/u);
	writeFileSync(downloaded, "old");
	const replaced = await json(set, "catalog_stage", { ...args, resource: "chunked", overwrite: true });
	assert.equal(replaced.sha256, DATA_SHA256);
	assert.deepEqual(readFileSync(downloaded), DATA);

	const followed = await json(set, "catalog_stage", {
		...args,
		resource: "redirect-in",
		destination: join(dir, "followed.bin"),
	});
	assert.deepEqual(followed.from, {
		url: `http://127.0.0.1:${port}/files/redirect-in`,
		finalUrl: `http://127.0.0.1:${port}/files/data.bin`,
		redirects: 1,
	});
	assert.doesNotMatch(JSON.stringify(followed), /SECRET-SIGNATURE/u);
	assert.deepEqual(leftovers(dir), []);
});

test("catalog_stage keeps nothing on a hash mismatch, past maxBytes, on a stall or on an error status", async () => {
	const dir = scratch("stage-refused");
	const original = join(dir, "original.bin");
	writeFileSync(original, DATA);
	const local = {
		id: "site",
		type: "local",
		datasets: [
			{
				id: "d",
				title: "D",
				resources: [
					{ id: "wrong", path: original, sha256: "f".repeat(64) },
					{ id: "r", path: original },
				],
			},
		],
	};
	const set = tools(writeCatalog(dir, [local, ckanSource("open", "ok")]), { stallTimeoutMs: 300 });
	const target = join(dir, "target.bin");
	const ckanArgs = { source: "open", dataset: "ocean-salinity-2023", destination: target };

	assert.match(
		await failure(set, "catalog_stage", { source: "site", dataset: "d", resource: "wrong", destination: target }),
		/SHA-256 of the transferred bytes is .* but the catalog gives f{64}; nothing was kept/u,
	);
	assert.match(await failure(set, "catalog_stage", { ...ckanArgs, resource: "bad-hash" }), /nothing was kept/u);
	assert.match(
		await failure(set, "catalog_stage", {
			source: "site",
			dataset: "d",
			resource: "r",
			destination: target,
			maxBytes: 1000,
		}),
		/more than maxBytes \(1000\)/u,
	);
	assert.match(
		await failure(set, "catalog_stage", { ...ckanArgs, resource: "grid", maxBytes: 1000 }),
		/is 200000 bytes, more than maxBytes \(1000\)/u,
	);
	assert.match(
		await failure(set, "catalog_stage", { ...ckanArgs, resource: "chunked", maxBytes: 50_000 }),
		/larger than maxBytes \(50000 bytes\); nothing was kept/u,
	);
	assert.match(
		await failure(set, "catalog_stage", { ...ckanArgs, resource: "stall" }),
		/stalled: no data for 0\.3 seconds/u,
	);
	assert.match(await failure(set, "catalog_stage", { ...ckanArgs, resource: "missing" }), /answered HTTP 404/u);
	assert.equal(existsSync(target), false);
	assert.deepEqual(leftovers(dir), []);
});

test("catalog_stage refuses a host the source does not allow, before any request to it and after a redirect", async () => {
	const dir = scratch("stage-hosts");
	const set = tools(writeCatalog(dir, [ckanSource("open", "ok")]));
	const target = join(dir, "target.bin");
	const args = { source: "open", dataset: "ocean-salinity-2023", destination: target };
	const seen = requests.length;
	const refused = await failure(set, "catalog_stage", { ...args, resource: "elsewhere" });
	assert.equal(
		refused,
		`catalog_stage: refused: host localhost:${port} is not allowed for source open; to allow it, add "localhost:${port}" to the resourceHosts of source open in ${join(dir, "catalog.json")}`,
	);
	assert.deepEqual(
		requests.slice(seen).map((request) => request.path),
		["/ok/api/3/action/package_show"],
	);

	const hop = requests.length;
	const redirected = await failure(set, "catalog_stage", { ...args, resource: "redirect-out" });
	assert.match(redirected, /a redirect was refused: host localhost:\d+ is not allowed for source open/u);
	assert.deepEqual(
		requests.slice(hop).map((request) => request.path),
		["/ok/api/3/action/package_show", "/files/redirect-out"],
	);
	assert.ok(requests.every((request) => !request.host.startsWith("localhost")));

	// With the host listed in resourceHosts the same resource is fetched from it.
	const allowed = tools(writeCatalog(dir, [ckanSource("open", "ok", { resourceHosts: [`localhost:${port}`] })]));
	const fetched = await json(allowed, "catalog_stage", { ...args, resource: "elsewhere" });
	assert.equal(fetched.sha256, DATA_SHA256);
	assert.deepEqual(readFileSync(target), DATA);
	assert.deepEqual(leftovers(dir), []);
});
