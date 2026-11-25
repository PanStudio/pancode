// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure functions from text to data for the catalog server: the operator's
 * catalog file, read strictly, and the CKAN action API documents
 * (`package_search`, `package_show`, `status_show`). Nothing here reads a
 * file or opens a connection.
 */

export const CATALOG_FILE_VERSION = 1;
export const MAX_SOURCES = 32;
export const MAX_LOCAL_DATASETS = 5_000;
export const MAX_RESOURCE_HOSTS = 32;
export const DESCRIPTION_CLIP_CHARS = 500;

/** A source id: lowercase letters, digits, `_` and `-`, at most 64 characters. */
export const SOURCE_ID_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";
/** A dataset or resource id: letters, digits, `.`, `_` and `-`, at most 128 characters. */
export const ITEM_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
/** Search words: letters, digits, `.`, `_` and `-`, each starting with a letter or digit, separated by spaces. */
export const QUERY_PATTERN = "^[\\p{L}\\p{N}][\\p{L}\\p{N}._-]*( +[\\p{L}\\p{N}][\\p{L}\\p{N}._-]*)*$";
export const QUERY_MAX_CHARS = 200;

const SOURCE_ID = new RegExp(SOURCE_ID_PATTERN, "u");
const ITEM_ID = new RegExp(ITEM_ID_PATTERN, "u");
const QUERY = new RegExp(QUERY_PATTERN, "u");
const SHA256 = /^[0-9a-f]{64}$/u;
/** ISO 8601 date and time with a zone, as a local dataset's `updated` must be written. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;
/** CKAN's timestamps: ISO 8601 in UTC, written without a zone. */
const CKAN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/u;

export const isSourceId = (value: string): boolean => SOURCE_ID.test(value);
export const isItemId = (value: string): boolean => ITEM_ID.test(value);
export const isQuery = (value: string): boolean => value.length <= QUERY_MAX_CHARS && QUERY.test(value);

export interface LocalResource {
	id: string;
	name: string | null;
	format: string | null;
	path: string;
	sha256: string | null;
}

export interface LocalDataset {
	id: string;
	title: string;
	description: string | null;
	tags: string[];
	license: string | null;
	updated: string | null;
	resources: LocalResource[];
}

export interface LocalSource {
	id: string;
	type: "local";
	datasets: LocalDataset[];
}

export interface CkanSource {
	id: string;
	type: "ckan";
	/** The site root, without a trailing slash: the action API is under `<url>/api/3/action/`. */
	url: string;
	/** Hosts besides the source's own that a resource may be downloaded from, as `host` or `host:port`. */
	resourceHosts: string[];
	allowHttp: boolean;
}

export type CatalogSource = LocalSource | CkanSource;

export interface Catalog {
	version: 1;
	sources: CatalogSource[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

class CatalogError extends Error {}

function fail(location: string, problem: string): never {
	throw new CatalogError(`${location}: ${problem}`);
}

function fields(
	record: Record<string, unknown>,
	location: string,
	required: ReadonlyArray<string>,
	optional: ReadonlyArray<string>,
): void {
	for (const key of Object.keys(record)) {
		if (!required.includes(key) && !optional.includes(key)) fail(`${location}.${key}`, "unknown field");
	}
	for (const key of required) if (!Object.hasOwn(record, key)) fail(location, `missing field ${key}`);
}

function text(value: unknown, location: string): string {
	if (typeof value !== "string" || value.trim().length === 0) fail(location, "must be a non-empty string");
	return value;
}

function optionalText(value: unknown, location: string): string | null {
	if (value === undefined || value === null) return null;
	return text(value, location);
}

function itemId(value: unknown, location: string, pattern: RegExp, source: string): string {
	if (typeof value !== "string" || !pattern.test(value)) fail(location, `must match ${source}`);
	return value;
}

/** A host as `resourceHosts` names it: a lowercase host name or address, with an optional port. */
function hostEntry(value: unknown, location: string): string {
	if (typeof value !== "string" || value.length === 0) fail(location, "must be a host name");
	let parsed: URL | null = null;
	try {
		parsed = new URL(`https://${value}`);
	} catch {
		// Reported below with the value.
	}
	if (
		parsed === null ||
		parsed.host !== value ||
		parsed.pathname !== "/" ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		fail(location, `${JSON.stringify(value)} must be a lowercase host name with an optional port and nothing else`);
	}
	return value;
}

function sourceUrl(value: unknown, location: string, allowHttp: boolean): string {
	if (typeof value !== "string") fail(location, "must be a URL string");
	let parsed: URL | null = null;
	try {
		parsed = new URL(value);
	} catch {
		// Reported below with the value.
	}
	if (parsed === null) fail(location, `${JSON.stringify(value)} is not a URL`);
	if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
		fail(
			location,
			allowHttp
				? `${JSON.stringify(value)} must be an https or http URL`
				: `${JSON.stringify(value)} must be an https URL; set allowHttp: true on the source for a host you trust on plain HTTP`,
		);
	}
	if (parsed.username !== "" || parsed.password !== "") fail(location, "must not carry a user name or password");
	if (parsed.search !== "" || parsed.hash !== "") fail(location, "must not carry a query or a fragment");
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

function sha256Field(value: unknown, location: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !SHA256.test(value.toLowerCase())) fail(location, "must be null or 64 hex digits");
	return value.toLowerCase();
}

function parseResource(value: unknown, location: string): LocalResource {
	if (!isRecord(value)) fail(location, "must be an object");
	fields(value, location, ["id", "path"], ["name", "format", "sha256"]);
	const path = text(value.path, `${location}.path`);
	if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(path)) fail(`${location}.path`, "must be an absolute path");
	return {
		id: itemId(value.id, `${location}.id`, ITEM_ID, ITEM_ID_PATTERN),
		name: optionalText(value.name, `${location}.name`),
		format: optionalText(value.format, `${location}.format`),
		path,
		sha256: sha256Field(value.sha256, `${location}.sha256`),
	};
}

function parseDataset(value: unknown, location: string): LocalDataset {
	if (!isRecord(value)) fail(location, "must be an object");
	fields(value, location, ["id", "title"], ["description", "tags", "license", "updated", "resources"]);
	const datasetId = itemId(value.id, `${location}.id`, ITEM_ID, ITEM_ID_PATTERN);
	const tags: string[] = [];
	if (value.tags !== undefined) {
		if (!Array.isArray(value.tags)) fail(`${location}.tags`, "must be an array of strings");
		for (const [index, tag] of value.tags.entries()) tags.push(text(tag, `${location}.tags[${index}]`));
	}
	let updated: string | null = null;
	if (value.updated !== undefined && value.updated !== null) {
		if (
			typeof value.updated !== "string" ||
			!ISO_WITH_ZONE.test(value.updated) ||
			Number.isNaN(Date.parse(value.updated))
		)
			fail(`${location}.updated`, "must be an ISO 8601 date and time with a zone, such as 2024-05-01T12:00:00Z");
		updated = value.updated;
	}
	const resources: LocalResource[] = [];
	if (value.resources !== undefined) {
		if (!Array.isArray(value.resources)) fail(`${location}.resources`, "must be an array");
		const seen = new Set<string>();
		for (const [index, entry] of value.resources.entries()) {
			const resource = parseResource(entry, `${location}.resources[${index}]`);
			if (seen.has(resource.id)) fail(`${location}.resources[${index}].id`, `duplicate resource id ${resource.id}`);
			seen.add(resource.id);
			resources.push(resource);
		}
	}
	return {
		id: datasetId,
		title: text(value.title, `${location}.title`),
		description: optionalText(value.description, `${location}.description`),
		tags,
		license: optionalText(value.license, `${location}.license`),
		updated,
		resources,
	};
}

function parseSource(value: unknown, location: string): CatalogSource {
	if (!isRecord(value)) fail(location, "must be an object");
	if (value.type === "local") {
		fields(value, location, ["id", "type", "datasets"], []);
		const sourceId = itemId(value.id, `${location}.id`, SOURCE_ID, SOURCE_ID_PATTERN);
		if (!Array.isArray(value.datasets)) fail(`${location}.datasets`, "must be an array");
		const datasets: LocalDataset[] = [];
		const seen = new Set<string>();
		for (const [index, entry] of value.datasets.entries()) {
			const dataset = parseDataset(entry, `${location}.datasets[${index}]`);
			if (seen.has(dataset.id)) fail(`${location}.datasets[${index}].id`, `duplicate dataset id ${dataset.id}`);
			seen.add(dataset.id);
			datasets.push(dataset);
		}
		return { id: sourceId, type: "local", datasets };
	}
	if (value.type === "ckan") {
		fields(value, location, ["id", "type", "url"], ["resourceHosts", "allowHttp"]);
		const sourceId = itemId(value.id, `${location}.id`, SOURCE_ID, SOURCE_ID_PATTERN);
		if (value.allowHttp !== undefined && typeof value.allowHttp !== "boolean")
			fail(`${location}.allowHttp`, "must be true or false");
		const allowHttp = value.allowHttp === true;
		const resourceHosts: string[] = [];
		if (value.resourceHosts !== undefined) {
			if (!Array.isArray(value.resourceHosts)) fail(`${location}.resourceHosts`, "must be an array of host names");
			if (value.resourceHosts.length > MAX_RESOURCE_HOSTS)
				fail(`${location}.resourceHosts`, `lists more than ${MAX_RESOURCE_HOSTS} hosts`);
			for (const [index, entry] of value.resourceHosts.entries()) {
				const host = hostEntry(entry, `${location}.resourceHosts[${index}]`);
				if (resourceHosts.includes(host)) fail(`${location}.resourceHosts[${index}]`, `lists ${host} twice`);
				resourceHosts.push(host);
			}
		}
		const url = sourceUrl(value.url, `${location}.url`, allowHttp);
		return { id: sourceId, type: "ckan", url, resourceHosts, allowHttp };
	}
	fail(`${location}.type`, 'must be "local" or "ckan"');
}

/** The catalog file, checked strictly: any problem is an error naming its location, and nothing is served. */
export function parseCatalogFile(content: string): Parsed<Catalog> {
	let document: unknown;
	try {
		document = JSON.parse(content);
	} catch (error) {
		return { ok: false, error: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		if (!isRecord(document)) fail("the file", "must be a JSON object");
		fields(document, "the file", ["version", "sources"], []);
		if (document.version !== CATALOG_FILE_VERSION) fail("version", `must be ${CATALOG_FILE_VERSION}`);
		if (!Array.isArray(document.sources)) fail("sources", "must be an array");
		if (document.sources.length > MAX_SOURCES)
			fail("sources", `lists ${document.sources.length} sources; at most ${MAX_SOURCES} are allowed`);
		const sources: CatalogSource[] = [];
		let datasets = 0;
		for (const [index, entry] of document.sources.entries()) {
			const source = parseSource(entry, `sources[${index}]`);
			if (sources.some((other) => other.id === source.id))
				fail(`sources[${index}].id`, `duplicate source id ${source.id}`);
			if (source.type === "local") {
				datasets += source.datasets.length;
				if (datasets > MAX_LOCAL_DATASETS)
					fail(`sources[${index}].datasets`, `the file lists more than ${MAX_LOCAL_DATASETS} local datasets`);
			}
			sources.push(source);
		}
		return { ok: true, value: { version: 1, sources } };
	} catch (error) {
		if (error instanceof CatalogError) return { ok: false, error: error.message };
		throw error;
	}
}

/** The query's words, lowercased. */
export function queryTokens(query: string): string[] {
	return query
		.toLowerCase()
		.split(/ +/u)
		.filter((token) => token.length > 0);
}

/**
 * Local datasets that contain every query word in their title, description or
 * tags, best first: a word in the title counts 3, in a tag 2, in the
 * description 1, and equal scores keep the file's order.
 */
export function matchLocal(datasets: ReadonlyArray<LocalDataset>, tokens: ReadonlyArray<string>): LocalDataset[] {
	const scored: Array<{ dataset: LocalDataset; score: number; index: number }> = [];
	for (const [index, dataset] of datasets.entries()) {
		const title = dataset.title.toLowerCase();
		const description = (dataset.description ?? "").toLowerCase();
		const tags = dataset.tags.map((tag) => tag.toLowerCase());
		let score = 0;
		let every = true;
		for (const token of tokens) {
			const inTitle = title.includes(token);
			const inTags = tags.some((tag) => tag.includes(token));
			const inDescription = description.includes(token);
			if (!inTitle && !inTags && !inDescription) {
				every = false;
				break;
			}
			score += (inTitle ? 3 : 0) + (inTags ? 2 : 0) + (inDescription ? 1 : 0);
		}
		if (every) scored.push({ dataset, score, index });
	}
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	return scored.map((entry) => entry.dataset);
}

/** `text` cut to `max` characters (whole code points), and whether it was cut. */
export function clip(text: string, max: number): { text: string; clipped: boolean } {
	const points = Array.from(text);
	if (points.length <= max) return { text, clipped: false };
	return { text: points.slice(0, max).join(""), clipped: true };
}

/** A CKAN timestamp (UTC, written without a zone) as ISO 8601 with a zone; one with a zone is kept. */
export function ckanTime(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (CKAN_TIMESTAMP.test(value)) return Number.isNaN(Date.parse(`${value}Z`)) ? null : `${value}Z`;
	if (ISO_WITH_ZONE.test(value)) return Number.isNaN(Date.parse(value)) ? null : value;
	return null;
}

/** A CKAN `hash` that is a SHA-256, written bare or as `sha256:<hex>`; any other hash is null. */
export function ckanSha256(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const bare = value
		.trim()
		.toLowerCase()
		.replace(/^sha-?256:/u, "");
	return SHA256.test(bare) ? bare : null;
}

/** A CKAN resource `size`: a non-negative integer, or the digits of one; anything else is null. */
export function ckanSize(value: unknown): number | null {
	if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
	if (typeof value === "string" && /^\d{1,15}$/u.test(value.trim())) return Number(value.trim());
	return null;
}

const nonEmpty = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export interface CkanResource {
	id: string;
	name: string | null;
	format: string | null;
	url: string | null;
	sizeBytes: number | null;
	sha256: string | null;
	/** Whether the catalog gave a hash at all, so a null `sha256` can say why. */
	hashGiven: boolean;
}

export interface CkanPackage {
	/** The package's URL name, which `package_show` takes as its id. */
	id: string;
	uuid: string | null;
	title: string | null;
	description: string | null;
	tags: string[];
	license: string | null;
	updated: string | null;
	resourceCount: number;
	resources: CkanResource[];
}

function ckanResource(value: unknown): CkanResource | null {
	if (!isRecord(value)) return null;
	const resourceId = nonEmpty(value.id);
	if (resourceId === null) return null;
	return {
		id: resourceId,
		name: nonEmpty(value.name),
		format: nonEmpty(value.format),
		url: nonEmpty(value.url),
		sizeBytes: ckanSize(value.size),
		sha256: ckanSha256(value.hash),
		hashGiven: nonEmpty(value.hash) !== null,
	};
}

function ckanPackage(value: unknown): CkanPackage | null {
	if (!isRecord(value)) return null;
	const name = nonEmpty(value.name) ?? nonEmpty(value.id);
	if (name === null) return null;
	const tags = Array.isArray(value.tags)
		? value.tags.flatMap((tag) => {
				const tagName = isRecord(tag) ? (nonEmpty(tag.display_name) ?? nonEmpty(tag.name)) : nonEmpty(tag);
				return tagName === null ? [] : [tagName];
			})
		: [];
	const resources = Array.isArray(value.resources)
		? value.resources.flatMap((entry) => {
				const resource = ckanResource(entry);
				return resource === null ? [] : [resource];
			})
		: [];
	const count =
		typeof value.num_resources === "number" && Number.isSafeInteger(value.num_resources) ? value.num_resources : null;
	return {
		id: name,
		uuid: nonEmpty(value.id),
		title: nonEmpty(value.title),
		description: nonEmpty(value.notes),
		tags,
		license: nonEmpty(value.license_title) ?? nonEmpty(value.license_id),
		updated: ckanTime(value.metadata_modified),
		resourceCount: count ?? resources.length,
		resources,
	};
}

/** The `result` of a CKAN action response, or why there is none. */
function ckanResult(content: string, action: string): Parsed<unknown> {
	let document: unknown;
	try {
		document = JSON.parse(content);
	} catch {
		return { ok: false, error: `${action} answered with a body that is not JSON` };
	}
	if (!isRecord(document) || typeof document.success !== "boolean")
		return { ok: false, error: `${action} answered with JSON that is not a CKAN action response` };
	if (!document.success) {
		const error = isRecord(document.error) ? document.error : {};
		const kind = nonEmpty(error.__type) ?? "error";
		const said = nonEmpty(error.message);
		return { ok: false, error: `${action} failed: ${kind}${said !== null ? `: ${said.slice(0, 200)}` : ""}` };
	}
	return { ok: true, value: document.result };
}

/** A `package_search` response: the total match count and the packages it returned. */
export function parseCkanSearch(content: string): Parsed<{ count: number; packages: CkanPackage[] }> {
	const result = ckanResult(content, "package_search");
	if (!result.ok) return result;
	const value = result.value;
	if (!isRecord(value) || typeof value.count !== "number" || !Array.isArray(value.results))
		return { ok: false, error: "package_search answered without a count and a results list" };
	const packages = value.results.flatMap((entry) => {
		const parsed = ckanPackage(entry);
		return parsed === null ? [] : [parsed];
	});
	return { ok: true, value: { count: value.count, packages } };
}

/** A `package_show` response: one package with its resources. */
export function parseCkanPackage(content: string): Parsed<CkanPackage> {
	const result = ckanResult(content, "package_show");
	if (!result.ok) return result;
	const parsed = ckanPackage(result.value);
	return parsed === null ? { ok: false, error: "package_show answered without a package" } : { ok: true, value: parsed };
}

/** The CKAN version a `status_show` response reports, or why there is none. */
export function parseCkanStatus(content: string): Parsed<string> {
	const result = ckanResult(content, "status_show");
	if (!result.ok) return result;
	const version = isRecord(result.value) ? nonEmpty(result.value.ckan_version) : null;
	return version === null ? { ok: false, error: "status_show reports no ckan_version" } : { ok: true, value: version };
}
