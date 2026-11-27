// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The catalog server's three tools over the operator's catalog file: search
 * every source, describe one dataset, stage one resource to a path. Local
 * sources are read from the file; CKAN sources through their action API,
 * public endpoints only, with no credential read or sent. A field a source
 * does not give is null with its reason under `unavailable`.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { defineTool, type Tool } from "pancode/sdk/tool";
import { ckanAction, Deadline, discard, fetchChecked } from "./net.js";
import {
	type Catalog,
	type CatalogSource,
	type CkanPackage,
	type CkanSource,
	clip,
	DESCRIPTION_CLIP_CHARS,
	ITEM_ID_PATTERN,
	isItemId,
	isQuery,
	isSourceId,
	type LocalDataset,
	matchLocal,
	parseCatalogFile,
	parseCkanPackage,
	parseCkanSearch,
	parseCkanStatus,
	QUERY_MAX_CHARS,
	QUERY_PATTERN,
	queryTokens,
	SOURCE_ID_PATTERN,
} from "./parse.js";
import { checkDestination, StageError, writeStaged } from "./stage.js";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MAX_OFFSET = 10_000;
export const MAX_RESOURCES = 200;
export const MAX_TAGS = 50;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** The largest catalog file the server reads. */
const MAX_CATALOG_FILE_BYTES = 16 * 1024 * 1024;

export interface CatalogSettings {
	/** The catalog file's path, decided when a call runs. */
	catalogFile(): string;
	/** Bound on one search or describe request. */
	requestTimeoutMs: number;
	/** How long a download may go without receiving a byte. */
	stallTimeoutMs: number;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorCode = (error: unknown): string | undefined =>
	error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** The catalog, or the error a call reports: no file names the path to create; a bad file names the location. */
export async function loadCatalog(
	file: string,
): Promise<{ ok: true; catalog: Catalog } | { ok: false; error: string; file: "missing" | "unreadable" | "invalid" }> {
	let content: string;
	try {
		const info = await stat(file);
		if (!info.isFile()) return { ok: false, error: `the catalog file ${file} is not a regular file`, file: "unreadable" };
		if (info.size > MAX_CATALOG_FILE_BYTES)
			return {
				ok: false,
				error: `the catalog file ${file} is larger than ${MAX_CATALOG_FILE_BYTES} bytes`,
				file: "unreadable",
			};
		content = await readFile(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT")
			return {
				ok: false,
				error: `no catalog file at ${file}: the catalog server needs one naming the sources to search. It ships no sources; create ${file} (the science-data plugin's README has a valid file to start from).`,
				file: "missing",
			};
		return { ok: false, error: `the catalog file ${file} cannot be read: ${message(error)}`, file: "unreadable" };
	}
	const parsed = parseCatalogFile(content);
	if (!parsed.ok)
		return {
			ok: false,
			error: `the catalog file ${file} is not valid: ${parsed.error}. The server serves nothing until the file is fixed; the science-data plugin's README has a valid file.`,
			file: "invalid",
		};
	return { ok: true, catalog: parsed.value };
}

/** Successful `status_show` answers by source URL; a failure is asked again on the next call. */
const ckanVersions = new Map<string, string>();

async function ckanVersion(
	source: CkanSource,
	options: { catalogFile: string; timeoutMs: number; signal: AbortSignal },
): Promise<{ version: string | null; reason?: string }> {
	const known = ckanVersions.get(source.url);
	if (known !== undefined) return { version: known };
	const answer = await ckanAction(source, "status_show", {}, options);
	if (!answer.ok) return { version: null, reason: answer.error };
	const parsed = parseCkanStatus(answer.text);
	if (!parsed.ok) return { version: null, reason: parsed.error };
	ckanVersions.set(source.url, parsed.value);
	return { version: parsed.value };
}

function sourceIdProblem(tool: string, value: unknown): string | null {
	if (typeof value !== "string" || !isSourceId(value)) return `${tool}: source must match ${SOURCE_ID_PATTERN}`;
	return null;
}

function itemIdProblem(tool: string, name: string, value: unknown): string | null {
	if (typeof value !== "string" || !isItemId(value)) return `${tool}: ${name} must match ${ITEM_ID_PATTERN}`;
	return null;
}

function findSource(catalog: Catalog, id: string, tool: string, file: string): CatalogSource | string {
	const source = catalog.sources.find((entry) => entry.id === id);
	if (source !== undefined) return source;
	const ids = catalog.sources.map((entry) => entry.id);
	return `${tool}: no source ${id} in ${file}${ids.length > 0 ? `; its sources are ${ids.join(", ")}` : "; it lists no source"}`;
}

interface SearchItem {
	source: string;
	id: string;
	title: string | null;
	description: string | null;
	descriptionClipped: boolean;
	tags: string[];
	tagsTruncated: boolean;
	resourceCount: number;
	license: string | null;
	updated: string | null;
	unavailable: Record<string, string>;
}

function item(
	source: string,
	fields: Omit<SearchItem, "source" | "description" | "descriptionClipped" | "tags" | "tagsTruncated" | "unavailable">,
	description: string | null,
	tags: ReadonlyArray<string>,
	reasons: { title: string; description: string; license: string; updated: string },
): SearchItem {
	const clipped = description === null ? null : clip(description, DESCRIPTION_CLIP_CHARS);
	const unavailable: Record<string, string> = {};
	if (fields.title === null) unavailable.title = reasons.title;
	if (description === null) unavailable.description = reasons.description;
	if (fields.license === null) unavailable.license = reasons.license;
	if (fields.updated === null) unavailable.updated = reasons.updated;
	return {
		source,
		...fields,
		description: clipped?.text ?? null,
		descriptionClipped: clipped?.clipped ?? false,
		tags: tags.slice(0, MAX_TAGS),
		tagsTruncated: tags.length > MAX_TAGS,
		unavailable,
	};
}

const LOCAL_REASONS = {
	title: "the catalog file gives no title",
	description: "the catalog file gives no description for this dataset",
	license: "the catalog file gives no license for this dataset",
	updated: "the catalog file gives no update time for this dataset",
};

const CKAN_REASONS = {
	title: "the CKAN package has no title",
	description: "the CKAN package has no notes",
	license: "the CKAN package names no license",
	updated: "the CKAN package has no metadata_modified time the server could read",
};

const localItem = (source: string, dataset: LocalDataset): SearchItem =>
	item(
		source,
		{
			id: dataset.id,
			title: dataset.title,
			resourceCount: dataset.resources.length,
			license: dataset.license,
			updated: dataset.updated,
		},
		dataset.description,
		dataset.tags,
		LOCAL_REASONS,
	);

const ckanItem = (source: string, pkg: CkanPackage): SearchItem =>
	item(
		source,
		{ id: pkg.id, title: pkg.title, resourceCount: pkg.resourceCount, license: pkg.license, updated: pkg.updated },
		pkg.description,
		pkg.tags,
		CKAN_REASONS,
	);

type SourceSearch =
	| { status: "ok"; source: CatalogSource; count: number; items: SearchItem[]; covered: number }
	| { status: "failed"; source: CatalogSource; error: string };

async function ckanSearch(
	source: CkanSource,
	query: string,
	start: number,
	rows: number,
	options: { catalogFile: string; timeoutMs: number; signal: AbortSignal },
): Promise<{ ok: true; count: number; items: SearchItem[] } | { ok: false; error: string }> {
	const answer = await ckanAction(
		source,
		"package_search",
		{ q: query, start: String(start), rows: String(rows), facet: "false" },
		options,
	);
	if (!answer.ok) return answer;
	const parsed = parseCkanSearch(answer.text);
	if (!parsed.ok) return parsed;
	return { ok: true, count: parsed.value.count, items: parsed.value.packages.map((pkg) => ckanItem(source.id, pkg)) };
}

function createSearch(settings: CatalogSettings): Tool<Record<string, unknown>> {
	return defineTool({
		name: "catalog_search",
		title: "Search dataset catalogs",
		description: `Returns datasets matching every word of query across the catalog sources the operator named (or one source): source and dataset id, title, description clipped to ${DESCRIPTION_CLIP_CHARS} characters, tags (at most ${MAX_TAGS}), resource count, license and last update, at most ${MAX_LIMIT} per call (limit, default ${DEFAULT_LIMIT}, with offset), plus each source's own status so one source that is down does not hide the others. Prefer it over fetching catalog APIs with curl: it reads only the operator's sources, merges them in one bounded list, and says when the list was cut.`,
		input: {
			type: "object",
			properties: {
				query: {
					type: "string",
					pattern: QUERY_PATTERN,
					maxLength: QUERY_MAX_CHARS,
					description:
						"Words that must all appear in a dataset's title, description or tags; letters, digits, '.', '_' and '-', separated by spaces.",
				},
				source: {
					type: "string",
					pattern: SOURCE_ID_PATTERN,
					description: "Search only this source id from the catalog file. Default: every source.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_LIMIT,
					description: `How many datasets to return, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`,
				},
				offset: {
					type: "integer",
					minimum: 0,
					maximum: MAX_OFFSET,
					description: `How many matches to skip, in source order then each source's ranking. Default 0, at most ${MAX_OFFSET}.`,
				},
			},
			required: ["query"],
		},
		actionClass: "read",
		idempotent: true,
		openWorld: true,
		async run(args, context) {
			const { query } = args;
			if (typeof query !== "string" || !isQuery(query))
				return {
					error: `catalog_search: query must be words of letters, digits, '.', '_' and '-' separated by spaces, at most ${QUERY_MAX_CHARS} characters, matching ${QUERY_PATTERN}`,
				};
			if (args.source !== undefined) {
				const problem = sourceIdProblem("catalog_search", args.source);
				if (problem !== null) return { error: problem };
			}
			const limit = args.limit ?? DEFAULT_LIMIT;
			const offset = args.offset ?? 0;
			if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
				return { error: `catalog_search: limit must be an integer from 1 to ${MAX_LIMIT}` };
			if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET)
				return { error: `catalog_search: offset must be an integer from 0 to ${MAX_OFFSET}` };
			const file = settings.catalogFile();
			const loaded = await loadCatalog(file);
			if (!loaded.ok) return { error: `catalog_search: ${loaded.error}` };
			let sources = loaded.catalog.sources;
			if (typeof args.source === "string") {
				const found = findSource(loaded.catalog, args.source, "catalog_search", file);
				if (typeof found === "string") return { error: found };
				sources = [found];
			}
			const options = { catalogFile: file, timeoutMs: settings.requestTimeoutMs, signal: context.signal };
			const tokens = queryTokens(query);
			// With offset 0 every source's first `limit` matches cover whatever it can contribute,
			// so one request each answers; past that the counts decide which window to ask for next.
			const firstRows = offset === 0 ? limit : 0;
			const versions = new Map<string, Promise<{ version: string | null; reason?: string }>>();
			const searched = await Promise.all(
				sources.map(async (source): Promise<SourceSearch> => {
					if (source.type === "local") {
						const items = matchLocal(source.datasets, tokens).map((dataset) => localItem(source.id, dataset));
						return { status: "ok", source, count: items.length, items, covered: items.length };
					}
					versions.set(source.id, ckanVersion(source, options));
					const answer = await ckanSearch(source, tokens.join(" "), 0, firstRows, options);
					if (!answer.ok) return { status: "failed", source, error: answer.error };
					return { status: "ok", source, count: answer.count, items: answer.items, covered: answer.items.length };
				}),
			);
			let before = 0;
			const windows = searched.map((entry) => {
				if (entry.status !== "ok") return null;
				const start = Math.max(0, offset - before);
				const end = Math.min(entry.count, offset + limit - before);
				before += entry.count;
				return start < end ? { start, end } : null;
			});
			const failures = new Map<string, string>();
			const pages = await Promise.all(
				searched.map(async (entry, index): Promise<SearchItem[]> => {
					const window = windows[index];
					if (entry.status !== "ok" || window == null) return [];
					if (window.end <= entry.covered) return entry.items.slice(window.start, window.end);
					if (entry.source.type !== "ckan") return entry.items.slice(window.start, window.end);
					const answer = await ckanSearch(entry.source, tokens.join(" "), window.start, window.end - window.start, options);
					if (!answer.ok) {
						failures.set(entry.source.id, answer.error);
						return [];
					}
					return answer.items;
				}),
			);
			const results = pages.flat().slice(0, limit);
			const statuses = await Promise.all(
				searched.map(async (entry) => {
					const failed = entry.status === "failed" ? entry.error : failures.get(entry.source.id);
					const base = { id: entry.source.id, type: entry.source.type };
					const version = versions.get(entry.source.id);
					const versionFields =
						version === undefined
							? {}
							: await version.then((found) => ({
									ckanVersion: found.version,
									...(found.reason !== undefined ? { unavailable: { ckanVersion: found.reason } } : {}),
								}));
					if (failed !== undefined) return { ...base, status: "failed", error: failed, ...versionFields };
					return { ...base, status: "ok", matches: entry.status === "ok" ? entry.count : 0, ...versionFields };
				}),
			);
			const total = searched.reduce((sum, entry) => sum + (entry.status === "ok" ? entry.count : 0), 0);
			return {
				json: {
					query,
					offset,
					limit,
					total,
					results,
					cap: MAX_LIMIT,
					truncated: offset + results.length < total,
					sources: statuses,
				},
			};
		},
	});
}

interface DescribedResource {
	id: string;
	name: string | null;
	format: string | null;
	sizeBytes: number | null;
	url?: string | null;
	path?: string;
	sha256: string | null;
	unavailable: Record<string, string>;
}

async function localResources(dataset: LocalDataset): Promise<DescribedResource[]> {
	return Promise.all(
		dataset.resources.slice(0, MAX_RESOURCES).map(async (resource) => {
			const unavailable: Record<string, string> = {};
			let sizeBytes: number | null = null;
			try {
				const info = await stat(resource.path);
				if (info.isFile()) sizeBytes = info.size;
				else unavailable.sizeBytes = `${resource.path} is not a regular file`;
			} catch (error) {
				unavailable.sizeBytes = `${resource.path} cannot be read: ${message(error)}`;
			}
			if (resource.name === null) unavailable.name = "the catalog file gives no name for this resource";
			if (resource.format === null) unavailable.format = "the catalog file gives no format for this resource";
			if (resource.sha256 === null) unavailable.sha256 = "the catalog file gives no SHA-256 for this resource";
			return {
				id: resource.id,
				name: resource.name,
				format: resource.format,
				sizeBytes,
				path: resource.path,
				sha256: resource.sha256,
				unavailable,
			};
		}),
	);
}

function ckanResources(pkg: CkanPackage): DescribedResource[] {
	return pkg.resources.slice(0, MAX_RESOURCES).map((resource) => {
		const unavailable: Record<string, string> = {};
		if (resource.name === null) unavailable.name = "the CKAN resource has no name";
		if (resource.format === null) unavailable.format = "the CKAN resource names no format";
		if (resource.sizeBytes === null) unavailable.sizeBytes = "the CKAN resource gives no size in bytes";
		if (resource.url === null) unavailable.url = "the CKAN resource has no URL";
		if (resource.sha256 === null)
			unavailable.sha256 = resource.hashGiven
				? "the CKAN resource's hash is not a SHA-256"
				: "the CKAN resource gives no hash";
		return {
			id: resource.id,
			name: resource.name,
			format: resource.format,
			sizeBytes: resource.sizeBytes,
			url: resource.url,
			sha256: resource.sha256,
			unavailable,
		};
	});
}

/** A redirect target without its query and fragment, which may carry a signed, short-lived credential. */
function withoutQuery(href: string): string {
	const url = new URL(href);
	return `${url.origin}${url.pathname}`;
}

async function ckanShow(
	source: CkanSource,
	dataset: string,
	options: { catalogFile: string; timeoutMs: number; signal: AbortSignal },
): Promise<{ ok: true; pkg: CkanPackage } | { ok: false; error: string }> {
	const answer = await ckanAction(source, "package_show", { id: dataset }, options);
	if (!answer.ok && answer.status === 404)
		return { ok: false, error: `source ${source.id}: ${answer.error}: no public dataset ${dataset} on this source` };
	if (!answer.ok) return { ok: false, error: `source ${source.id}: ${answer.error}` };
	const parsed = parseCkanPackage(answer.text);
	if (!parsed.ok) return { ok: false, error: `source ${source.id}: ${parsed.error}` };
	return { ok: true, pkg: parsed.value };
}

function createDescribe(settings: CatalogSettings): Tool<Record<string, unknown>> {
	return defineTool({
		name: "catalog_describe",
		title: "Describe a catalog dataset",
		description: `Returns one dataset from a catalog source by source and id: its full description, tags, license, last update, and every resource (at most ${MAX_RESOURCES}) with id, name, format, size in bytes when known, URL or path, and SHA-256 when the catalog gives one. Prefer it over fetching the catalog's API with curl: it reads the operator's named source, answers in typed fields, and says when the resource list was cut.`,
		input: {
			type: "object",
			properties: {
				source: { type: "string", pattern: SOURCE_ID_PATTERN, description: "The source id from the catalog file." },
				id: {
					type: "string",
					pattern: ITEM_ID_PATTERN,
					description: "The dataset id, as catalog_search returns it.",
				},
			},
			required: ["source", "id"],
		},
		actionClass: "read",
		idempotent: true,
		openWorld: true,
		async run(args, context) {
			const problem = sourceIdProblem("catalog_describe", args.source) ?? itemIdProblem("catalog_describe", "id", args.id);
			if (problem !== null) return { error: problem };
			const sourceId = args.source as string;
			const datasetId = args.id as string;
			const file = settings.catalogFile();
			const loaded = await loadCatalog(file);
			if (!loaded.ok) return { error: `catalog_describe: ${loaded.error}` };
			const source = findSource(loaded.catalog, sourceId, "catalog_describe", file);
			if (typeof source === "string") return { error: source };
			if (source.type === "local") {
				const dataset = source.datasets.find((entry) => entry.id === datasetId);
				if (dataset === undefined) return { error: `catalog_describe: source ${sourceId} has no dataset ${datasetId}` };
				const unavailable: Record<string, string> = {};
				if (dataset.description === null) unavailable.description = LOCAL_REASONS.description;
				if (dataset.license === null) unavailable.license = LOCAL_REASONS.license;
				if (dataset.updated === null) unavailable.updated = LOCAL_REASONS.updated;
				return {
					json: {
						source: sourceId,
						type: "local",
						id: dataset.id,
						title: dataset.title,
						description: dataset.description,
						tags: dataset.tags,
						license: dataset.license,
						updated: dataset.updated,
						resourceCount: dataset.resources.length,
						resources: await localResources(dataset),
						cap: MAX_RESOURCES,
						truncated: dataset.resources.length > MAX_RESOURCES,
						unavailable,
					},
				};
			}
			const options = { catalogFile: file, timeoutMs: settings.requestTimeoutMs, signal: context.signal };
			const [shown, version] = await Promise.all([ckanShow(source, datasetId, options), ckanVersion(source, options)]);
			if (!shown.ok) return { error: `catalog_describe: ${shown.error}` };
			const { pkg } = shown;
			const unavailable: Record<string, string> = {};
			if (pkg.title === null) unavailable.title = CKAN_REASONS.title;
			if (pkg.description === null) unavailable.description = CKAN_REASONS.description;
			if (pkg.license === null) unavailable.license = CKAN_REASONS.license;
			if (pkg.updated === null) unavailable.updated = CKAN_REASONS.updated;
			if (version.reason !== undefined) unavailable.ckanVersion = version.reason;
			const listed = Math.max(pkg.resourceCount, pkg.resources.length);
			return {
				json: {
					source: sourceId,
					type: "ckan",
					id: pkg.id,
					title: pkg.title,
					description: pkg.description,
					tags: pkg.tags,
					license: pkg.license,
					updated: pkg.updated,
					resourceCount: listed,
					resources: ckanResources(pkg),
					cap: MAX_RESOURCES,
					truncated: listed > Math.min(MAX_RESOURCES, pkg.resources.length),
					ckanVersion: version.version,
					unavailable,
				},
			};
		},
	});
}

function createStage(settings: CatalogSettings): Tool<Record<string, unknown>> {
	return defineTool({
		name: "catalog_stage",
		title: "Stage a catalog resource",
		description: `Copies one resource of a catalog dataset to destination and returns the bytes written and the SHA-256 the server computed, checked against the catalog's SHA-256 when it gives one; a local resource is copied from its path, a CKAN resource is downloaded over https only from the source's own host or a host in its resourceHosts, following at most 5 redirects that pass the same check. Prefer it over curl or cp: an existing destination is kept unless overwrite is true, the file appears only when complete and verified, and transfers stop at maxBytes (default ${DEFAULT_MAX_BYTES} bytes) leaving nothing behind.`,
		input: {
			type: "object",
			properties: {
				source: { type: "string", pattern: SOURCE_ID_PATTERN, description: "The source id from the catalog file." },
				dataset: { type: "string", pattern: ITEM_ID_PATTERN, description: "The dataset id." },
				resource: {
					type: "string",
					pattern: ITEM_ID_PATTERN,
					description: "The resource id, as catalog_describe returns it.",
				},
				destination: {
					type: "string",
					description: "The file to write, relative to the server's working directory; its directory must exist.",
				},
				overwrite: { type: "boolean", description: "Replace an existing destination file. Default false." },
				maxBytes: {
					type: "integer",
					minimum: 1,
					maximum: DEFAULT_MAX_BYTES,
					description: `Stop and keep nothing past this many bytes. Default and most ${DEFAULT_MAX_BYTES}.`,
				},
			},
			required: ["source", "dataset", "resource", "destination"],
		},
		actionClass: "execute",
		openWorld: true,
		pathArguments: { destination: "write" },
		async run(args, context) {
			const problem =
				sourceIdProblem("catalog_stage", args.source) ??
				itemIdProblem("catalog_stage", "dataset", args.dataset) ??
				itemIdProblem("catalog_stage", "resource", args.resource);
			if (problem !== null) return { error: problem };
			if (typeof args.destination !== "string") return { error: "catalog_stage: destination must be a string" };
			if (args.overwrite !== undefined && typeof args.overwrite !== "boolean")
				return { error: "catalog_stage: overwrite must be true or false" };
			const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
			if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES)
				return { error: `catalog_stage: maxBytes must be an integer from 1 to ${DEFAULT_MAX_BYTES}` };
			const sourceId = args.source as string;
			const datasetId = args.dataset as string;
			const resourceId = args.resource as string;
			const overwrite = args.overwrite === true;
			const file = settings.catalogFile();
			const loaded = await loadCatalog(file);
			if (!loaded.ok) return { error: `catalog_stage: ${loaded.error}` };
			const source = findSource(loaded.catalog, sourceId, "catalog_stage", file);
			if (typeof source === "string") return { error: source };
			let destination: string;
			try {
				destination = await checkDestination(args.destination, overwrite);
			} catch (error) {
				return { error: `catalog_stage: ${message(error)}` };
			}
			const target = { destination, overwrite, maxBytes };
			const done = (staged: { bytesWritten: number; sha256: string }, expected: string | null, from: object) => ({
				json: {
					source: sourceId,
					dataset: datasetId,
					resource: resourceId,
					destination,
					bytesWritten: staged.bytesWritten,
					sha256: staged.sha256,
					expectedSha256: expected,
					verified: expected !== null,
					from,
					unavailable:
						expected === null
							? { expectedSha256: "the catalog gives no SHA-256 for this resource, so the copy was not verified" }
							: {},
				},
			});

			if (source.type === "local") {
				const dataset = source.datasets.find((entry) => entry.id === datasetId);
				if (dataset === undefined) return { error: `catalog_stage: source ${sourceId} has no dataset ${datasetId}` };
				const resource = dataset.resources.find((entry) => entry.id === resourceId);
				if (resource === undefined) return { error: `catalog_stage: dataset ${datasetId} has no resource ${resourceId}` };
				let size: number;
				try {
					const info = await stat(resource.path);
					size = info.size;
					if (!info.isFile()) return { error: `catalog_stage: ${resource.path} is not a regular file` };
					if (info.size > maxBytes)
						return {
							error: `catalog_stage: ${resource.path} is ${info.size} bytes, more than maxBytes (${maxBytes}); nothing was written`,
						};
				} catch (error) {
					return { error: `catalog_stage: the resource path ${resource.path} cannot be read: ${message(error)}` };
				}
				try {
					const staged = await writeStaged(
						createReadStream(resource.path, { signal: context.signal }),
						{ ...target, expectedSha256: resource.sha256 },
						(bytes) => context.progress(bytes, size, `${bytes} of ${size} bytes copied`),
					);
					return done(staged, resource.sha256, { path: resource.path });
				} catch (error) {
					if (context.signal.aborted) return { error: "catalog_stage: cancelled; nothing was kept" };
					return { error: `catalog_stage: ${message(error)}` };
				}
			}

			const options = { catalogFile: file, timeoutMs: settings.requestTimeoutMs, signal: context.signal };
			const shown = await ckanShow(source, datasetId, options);
			if (!shown.ok) return { error: `catalog_stage: ${shown.error}` };
			const resource = shown.pkg.resources.find((entry) => entry.id === resourceId);
			if (resource === undefined)
				return { error: `catalog_stage: dataset ${datasetId} of source ${sourceId} has no resource ${resourceId}` };
			if (resource.url === null) return { error: `catalog_stage: resource ${resourceId} has no URL to download` };
			const stall = new Deadline(settings.stallTimeoutMs);
			const signal = AbortSignal.any([context.signal, stall.signal]);
			const stalled = () =>
				`the download stalled: no data for ${settings.stallTimeoutMs / 1000} seconds; nothing was kept`;
			try {
				const fetched = await fetchChecked(resource.url, source, file, signal, { "accept-encoding": "identity" });
				if (!fetched.ok) {
					if (stall.fired) return { error: `catalog_stage: ${stalled()}` };
					return { error: `catalog_stage: ${fetched.refused ? "refused: " : ""}${fetched.error}` };
				}
				const { response } = fetched;
				if (!response.ok) {
					await discard(response);
					return {
						error: `catalog_stage: the download answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
					};
				}
				const rawLength = response.headers.get("content-length")?.trim();
				const length = rawLength !== undefined && /^\d+$/.test(rawLength) ? Number(rawLength) : Number.NaN;
				if (Number.isFinite(length) && length > maxBytes) {
					await discard(response);
					return {
						error: `catalog_stage: the resource is ${length} bytes, more than maxBytes (${maxBytes}); nothing was written`,
					};
				}
				stall.touch();
				const body = response.body ?? (async function* () {})();
				const total = Number.isFinite(length) && length > 0 ? length : undefined;
				const staged = await writeStaged(body, { ...target, expectedSha256: resource.sha256 }, (bytes) => {
					stall.touch();
					context.progress(bytes, total, `${bytes}${total !== undefined ? ` of ${total}` : ""} bytes downloaded`);
				});
				return done(staged, resource.sha256, {
					url: resource.url,
					finalUrl: fetched.redirects === 0 ? resource.url : withoutQuery(fetched.url),
					redirects: fetched.redirects,
				});
			} catch (error) {
				if (error instanceof StageError) return { error: `catalog_stage: ${error.message}` };
				if (stall.fired) return { error: `catalog_stage: ${stalled()}` };
				if (context.signal.aborted) return { error: "catalog_stage: cancelled; nothing was kept" };
				return { error: `catalog_stage: the download failed: ${message(error)}; nothing was kept` };
			} finally {
				stall.clear();
			}
		},
	});
}

/** The three tools, reading the catalog file `settings` names when each call runs. */
export function catalogTools(settings: CatalogSettings): Array<Tool<Record<string, unknown>>> {
	return [createSearch(settings), createDescribe(settings), createStage(settings)];
}
