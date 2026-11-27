// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure parsers for what Spack prints: `spack find --json`, `spack spec
 * --json`, `spack find --format`, `spack info`, `spack location`, `spack env
 * status`, `spack env list`, `spack find -r` in an environment, `spack repo
 * list` and the version line of Spack's own Python package. Each takes text
 * and returns data, never throws, and gives null or keeps a section as text
 * rather than guess a value it cannot read.
 */

/** Spack's short hash, as `spack find -l` prints it. */
export const SHORT_HASH_LENGTH = 7;

/** The parameters of a spec node that are compiler flags, not variants. */
const FLAG_PARAMETERS = new Set(["cflags", "cppflags", "cxxflags", "fflags", "ldflags", "ldlibs"]);

/** Virtuals a compiler provides to a node in Spack 1.x, where compilers are dependencies. */
const COMPILER_LANGUAGES = new Set(["c", "cxx", "fortran"]);

const HASH = /^[a-z0-9]{7,64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function shortHash(hash: string): string {
	return hash.slice(0, SHORT_HASH_LENGTH);
}

/**
 * The Spack version a checkout declares in `lib/spack/spack/__init__.py`:
 * `__version__ = "1.2.2"` (0.22 and later) or `spack_version_info = (0, 21, 2)`.
 */
export function parseSpackVersionFile(text: string): string | null {
	const declared = /^__version__\s*=\s*["']([^"'\n]+)["']/mu.exec(text)?.[1];
	const version =
		declared ??
		/^spack_version_info\s*=\s*\(([^)\n]*)\)/mu
			.exec(text)?.[1]
			?.split(",")
			.map((part) => part.trim().replace(/^["']|["']$/gu, ""))
			.filter((part) => part.length > 0)
			.join(".");
	return version !== undefined && /^[0-9]+(\.[0-9A-Za-z]+)*$/u.test(version) ? version : null;
}

/** The major version of a Spack version string, or null. */
export function spackMajorVersion(version: string | null): number | null {
	const major = version === null ? Number.NaN : Number.parseInt(version, 10);
	return Number.isFinite(major) ? major : null;
}

/** The end index (exclusive) of the JSON object or array starting at `start`, or -1. */
function jsonValueEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (char === "\\") index++;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

/**
 * The JSON documents in Spack's stdout, and the lines that are not JSON. Spack
 * prints one document per spec, and on a first run prints `==>` notices (such
 * as its solver bootstrap) on stdout before them.
 */
export function scanJsonDocuments(text: string): { documents: unknown[]; notices: string[] } {
	const documents: unknown[] = [];
	const notices: string[] = [];
	let index = 0;
	while (index < text.length) {
		while (index < text.length && /\s/u.test(text[index] ?? "")) index++;
		if (index >= text.length) break;
		const char = text[index];
		if (char === "{" || char === "[") {
			const end = jsonValueEnd(text, index);
			if (end > 0) {
				try {
					documents.push(JSON.parse(text.slice(index, end)));
					index = end;
					continue;
				} catch {
					// Not JSON after all, such as a `[+]` status; read it as a line.
				}
			}
		}
		const lineEnd = text.indexOf("\n", index);
		const line = text.slice(index, lineEnd < 0 ? text.length : lineEnd).trim();
		if (line.length > 0) notices.push(line);
		index = lineEnd < 0 ? text.length : lineEnd + 1;
	}
	return { documents, notices };
}

export interface SpackArchitecture {
	platform: string | null;
	os: string | null;
	target: string | null;
}

export interface SpackDependencyEdge {
	name: string;
	/** The full hash. */
	hash: string;
	/** Dependency types: build, link, run, test. */
	types: string[];
	/** Virtuals this dependency provides to the node, such as `mpi` or `c`. */
	virtuals: string[];
}

/** One spec node as Spack's JSON records it. */
export interface SpackNode {
	name: string;
	version: string | null;
	/** The full hash. */
	hash: string;
	namespace: string | null;
	architecture: SpackArchitecture | null;
	/** Variant values, compiler flags left out. */
	variants: Record<string, unknown>;
	dependencies: SpackDependencyEdge[];
	/** Where an external spec lives; null for a spec Spack builds. */
	externalPrefix: string | null;
	external: boolean;
	/** The `compiler` field of Spack before 1.0; null when the node has none. */
	compilerField: { name: string; version: string | null } | null;
}

function readArchitecture(value: unknown): SpackArchitecture | null {
	if (!isRecord(value)) return null;
	const target = isRecord(value.target) ? stringOrNull(value.target.name) : stringOrNull(value.target);
	return { platform: stringOrNull(value.platform), os: stringOrNull(value.platform_os), target };
}

function readEdge(value: unknown): SpackDependencyEdge | null {
	if (!isRecord(value)) return null;
	const name = stringOrNull(value.name);
	const hash = stringOrNull(value.hash);
	if (name === null || hash === null) return null;
	const parameters = isRecord(value.parameters) ? value.parameters : {};
	// Before 0.20 the edge carried `type` beside the hash.
	const types = strings(parameters.deptypes ?? value.type);
	return { name, hash, types, virtuals: strings(parameters.virtuals) };
}

/** One record of `spack find --json` or one node of `spack spec --json`, or null when it lacks a name or hash. */
function readNode(value: unknown): SpackNode | null {
	if (!isRecord(value)) return null;
	const name = stringOrNull(value.name);
	const hash = stringOrNull(value.hash);
	if (name === null || hash === null || !HASH.test(hash)) return null;
	const variants: Record<string, unknown> = {};
	if (isRecord(value.parameters)) {
		for (const [key, entry] of Object.entries(value.parameters)) if (!FLAG_PARAMETERS.has(key)) variants[key] = entry;
	}
	const dependencies = Array.isArray(value.dependencies)
		? value.dependencies.map(readEdge).filter((edge): edge is SpackDependencyEdge => edge !== null)
		: [];
	const external = isRecord(value.external) ? value.external : null;
	const compiler = isRecord(value.compiler) ? value.compiler : null;
	const compilerName = compiler === null ? null : stringOrNull(compiler.name);
	return {
		name,
		version: typeof value.version === "string" || typeof value.version === "number" ? String(value.version) : null,
		hash,
		namespace: stringOrNull(value.namespace),
		architecture: readArchitecture(value.arch),
		variants,
		dependencies,
		externalPrefix: external === null ? null : stringOrNull(external.path),
		external: external !== null,
		compilerField:
			compiler === null || compilerName === null ? null : { name: compilerName, version: stringOrNull(compiler.version) },
	};
}

/** `spack find --json`: an array of records. Null when the output holds no such array. */
export function parseFindJson(text: string): { nodes: SpackNode[]; malformedRecords: number } | null {
	const { documents } = scanJsonDocuments(text);
	const records = documents.find((document) => Array.isArray(document));
	if (!Array.isArray(records)) return null;
	const nodes: SpackNode[] = [];
	let malformedRecords = 0;
	for (const record of records) {
		const node = readNode(record);
		if (node === null) malformedRecords++;
		else nodes.push(node);
	}
	return { nodes, malformedRecords };
}

/**
 * `spack spec --json`: one `{"spec": {"nodes": [...]}}` document per root,
 * the root first among its nodes. Nodes shared by several roots are kept once.
 * Null when no document has that shape.
 */
export function parseSpecJson(
	text: string,
): { roots: string[]; nodes: SpackNode[]; malformedNodes: number; notices: string[] } | null {
	const { documents, notices } = scanJsonDocuments(text);
	const roots: string[] = [];
	const nodes: SpackNode[] = [];
	const seen = new Set<string>();
	let malformedNodes = 0;
	let specs = 0;
	for (const document of documents) {
		if (!isRecord(document) || !isRecord(document.spec) || !Array.isArray(document.spec.nodes)) continue;
		specs++;
		document.spec.nodes.forEach((entry: unknown, index: number) => {
			const node = readNode(entry);
			if (node === null) {
				malformedNodes++;
				return;
			}
			if (index === 0) roots.push(node.hash);
			if (seen.has(node.hash)) return;
			seen.add(node.hash);
			nodes.push(node);
		});
	}
	return specs === 0 ? null : { roots, nodes, malformedNodes, notices };
}

export interface SpackCompiler {
	name: string;
	version: string | null;
	/** The languages it compiles for this spec; null before Spack 1.0, which recorded one compiler per spec. */
	languages: string[] | null;
}

/**
 * The compilers a node was built with: the `compiler` field before Spack 1.0,
 * else its build dependencies that provide `c`, `cxx` or `fortran`, with the
 * version read from `byHash` when that node is listed.
 */
export function compilersOf(node: SpackNode, byHash: ReadonlyMap<string, SpackNode>): SpackCompiler[] {
	if (node.compilerField !== null) return [{ ...node.compilerField, languages: null }];
	const compilers: SpackCompiler[] = [];
	for (const edge of node.dependencies) {
		const languages = edge.virtuals.filter((virtual) => COMPILER_LANGUAGES.has(virtual));
		if (languages.length === 0) continue;
		compilers.push({ name: edge.name, version: byHash.get(edge.hash)?.version ?? null, languages });
	}
	return compilers;
}

/** Lines of `spack find --format "{hash} {prefix}"`, in order. */
export function parseHashPrefixLines(text: string): {
	entries: Array<{ hash: string; prefix: string }>;
	malformed: number;
} {
	const entries: Array<{ hash: string; prefix: string }> = [];
	let malformed = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0 || line.startsWith("==>")) continue;
		const match = /^([a-z0-9]{7,64}) (\/.*)$/u.exec(line.trimEnd());
		if (match?.[1] !== undefined && match[2] !== undefined) entries.push({ hash: match[1], prefix: match[2] });
		else malformed++;
	}
	return { entries, malformed };
}

/** Lines of `spack find --format "{hash}"`. */
export function parseHashLines(text: string): { hashes: Set<string>; malformed: number } {
	const hashes = new Set<string>();
	let malformed = 0;
	for (const line of text.split("\n")) {
		const hash = line.trim();
		if (hash.length === 0 || hash.startsWith("==>")) continue;
		if (HASH.test(hash)) hashes.add(hash);
		else malformed++;
	}
	return { hashes, malformed };
}

/** The first `==> Error:` message Spack printed, without the prefix, or the first non-empty line. */
export function spackErrorMessage(text: string): string | null {
	const lines = text.split("\n").map((line) => line.trim());
	const error = lines.find((line) => line.startsWith("==> Error:"));
	if (error !== undefined) return error.slice("==> Error:".length).trim();
	return lines.find((line) => line.length > 0) ?? null;
}

/** Whether Spack's error says a query matched nothing, as `spack find` does. */
export function isNoMatchError(text: string): boolean {
	return /No package matches the query/u.test(text);
}

export interface SpackVersionEntry {
	version: string;
	/** What Spack prints after the version: a URL, or `[git] <url> on branch <b>`. */
	source: string | null;
	deprecated: boolean;
}

export interface SpackVariant {
	name: string;
	default: string;
	values: string[];
	/** The condition under which the variant exists, as Spack prints it. */
	when: string | null;
	description: string | null;
}

export interface SpackPackageDependency {
	/** The dependency as a spec, such as `cmake@3.18:` or `mpi`. */
	spec: string;
	types: string[];
	when: string | null;
}

export interface SpackInfoSection {
	title: string;
	text: string;
	truncated: boolean;
}

export interface SpackInfo {
	/** The package class Spack names in the first line, such as `CMakePackage`; `Package` for a virtual. */
	packageClass: string | null;
	name: string | null;
	description: string | null;
	homepage: string | null;
	preferredVersion: string | null;
	versions: SpackVersionEntry[] | null;
	variants: SpackVariant[] | null;
	dependencies: SpackPackageDependency[] | null;
	licenses: string[] | null;
	/** Sections printed that the parser does not read, as capped text. */
	otherSections: SpackInfoSection[];
}

/** Characters of one section kept as text. */
export const INFO_SECTION_TEXT_CAP = 4096;

interface RawSection {
	title: string;
	inline: string;
	lines: string[];
}

function splitSections(text: string): { header: string | null; sections: RawSection[] } {
	const sections: RawSection[] = [];
	let header: string | null = null;
	let current: RawSection | null = null;
	for (const raw of text.replace(/\r/gu, "").split("\n")) {
		const line = raw.trimEnd();
		const heading = /^([A-Z][A-Za-z ]*?):(?: +(.*))?$/u.exec(line);
		if (heading?.[1] !== undefined && !raw.startsWith(" ")) {
			if (header === null && current === null && /Package$/u.test(heading[1])) {
				header = line;
				continue;
			}
			current = { title: heading[1], inline: (heading[2] ?? "").trim(), lines: [] };
			sections.push(current);
			continue;
		}
		if (current !== null) current.lines.push(line);
	}
	return { header, sections };
}

function sectionText(section: RawSection): SpackInfoSection {
	const body = [section.inline, ...section.lines].filter((line) => line.length > 0).join("\n");
	const truncated = body.length > INFO_SECTION_TEXT_CAP;
	return { title: section.title, text: truncated ? body.slice(0, INFO_SECTION_TEXT_CAP) : body, truncated };
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

function isNone(lines: string[]): boolean {
	const content = lines.filter((line) => line.trim().length > 0);
	return content.length === 1 && content[0]?.trim() === "None";
}

function splitValues(text: string): string[] {
	return text
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

function parseVersionLines(lines: string[], deprecated: boolean): SpackVersionEntry[] | null {
	if (isNone(lines)) return [];
	const entries: SpackVersionEntry[] = [];
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		const match = /^ {4}(\S+)(?: +(.+))?$/u.exec(line);
		if (match?.[1] === undefined) return null;
		entries.push({ version: match[1], source: match[2]?.trim() ?? null, deprecated });
	}
	return entries;
}

interface VariantDraft {
	variant: SpackVariant;
	valuesColumn: number;
	descriptionLines: string[];
}

/** Variants as Spack 0.22 and later print them by name: `name [default]  values`, then `when` and description lines. */
function parseVariantLines(lines: string[]): SpackVariant[] | null {
	if (isNone(lines)) return [];
	const variants: SpackVariant[] = [];
	let draft: VariantDraft | null = null;
	const finish = (open: VariantDraft | null) => {
		if (open === null) return;
		const description = open.descriptionLines.length > 0 ? open.descriptionLines.join(" ") : null;
		variants.push({ ...open.variant, description });
	};
	for (const line of lines) {
		if (line.trim().length === 0) {
			finish(draft);
			draft = null;
			continue;
		}
		const indent = indentOf(line);
		const head = /^ {4}([A-Za-z0-9_][A-Za-z0-9_.-]*) \[([^\]]*)\] +(\S.*)$/u.exec(line);
		if (indent === 4 && head?.[1] !== undefined && head[2] !== undefined && head[3] !== undefined) {
			finish(draft);
			draft = {
				variant: { name: head[1], default: head[2], values: splitValues(head[3]), when: null, description: null },
				valuesColumn: line.length - head[3].length,
				descriptionLines: [],
			};
			continue;
		}
		if (draft === null) return null;
		const describing = draft.descriptionLines.length > 0;
		if (indent === draft.valuesColumn && !describing && draft.variant.when === null) {
			draft.variant.values.push(...splitValues(line));
		} else if (indent === 6 && line.trimStart().startsWith("when ") && !describing) {
			draft.variant.when = line.trim().slice("when ".length);
		} else if (indent === 8) draft.descriptionLines.push(line.trim());
		else return null;
	}
	finish(draft);
	return variants;
}

/** Dependencies as Spack 1.x prints them: `spec  types`, then an optional `when` line. */
function parseDependencyLines(lines: string[]): SpackPackageDependency[] | null {
	if (isNone(lines)) return [];
	const dependencies: SpackPackageDependency[] = [];
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		const indent = indentOf(line);
		const head = /^ {4}(\S.*?) +((?:build|link|run|test)(?:, (?:build|link|run|test))*)$/u.exec(line);
		if (indent === 4 && head?.[1] !== undefined && head[2] !== undefined) {
			dependencies.push({ spec: head[1], types: head[2].split(", "), when: null });
			continue;
		}
		const last = dependencies.at(-1);
		if (indent === 6 && line.trimStart().startsWith("when ") && last !== undefined && last.when === null) {
			last.when = line.trim().slice("when ".length);
			continue;
		}
		return null;
	}
	return dependencies;
}

/** Dependencies as Spack before 1.0 printed them, one section per type, names separated by spaces. */
function parseTypedDependencyLines(lines: string[], type: string): SpackPackageDependency[] | null {
	if (isNone(lines)) return [];
	const dependencies: SpackPackageDependency[] = [];
	for (const line of lines) {
		for (const name of line.trim().split(/\s+/u)) {
			if (name.length === 0) continue;
			if (!/^[a-z0-9][a-z0-9_-]*$/u.test(name)) return null;
			dependencies.push({ spec: name, types: [type], when: null });
		}
	}
	return dependencies;
}

/**
 * `spack info <package>`. Sections it reads: the header, Description,
 * Homepage, Preferred version, Safe versions, Deprecated versions, Variants,
 * Dependencies (or the per-type sections before Spack 1.0) and Licenses. A
 * section it cannot read in full is kept as text under `otherSections`, and
 * its field is null. Null when the text has no section at all.
 */
export function parseSpackInfo(text: string): SpackInfo | null {
	const { header, sections } = splitSections(text);
	if (header === null && sections.length === 0) return null;
	const headerMatch = header === null ? null : /^(\w*Package): +(\S+)$/u.exec(header);
	const info: SpackInfo = {
		packageClass: headerMatch?.[1] ?? null,
		name: headerMatch?.[2] ?? null,
		description: null,
		homepage: null,
		preferredVersion: null,
		versions: null,
		variants: null,
		dependencies: null,
		licenses: null,
		otherSections: [],
	};
	const keep = (section: RawSection) => info.otherSections.push(sectionText(section));
	for (const section of sections) {
		const title = section.title;
		const typed = /^(Build|Link|Run|Test) Dependencies$/u.exec(title)?.[1];
		if (title === "Description") {
			const body = [section.inline, ...section.lines].map((line) => line.trim()).filter((line) => line.length > 0);
			info.description = body.length > 0 ? body.join(" ") : null;
		} else if (title === "Homepage" && section.inline.length > 0) {
			info.homepage = section.inline;
		} else if (title === "Preferred version") {
			const parsed = parseVersionLines(section.lines, false);
			if (parsed === null || parsed.length > 1) keep(section);
			else info.preferredVersion = parsed[0]?.version ?? null;
		} else if (title === "Safe versions" || title === "Deprecated versions") {
			const parsed = parseVersionLines(section.lines, title === "Deprecated versions");
			if (parsed === null) keep(section);
			else info.versions = [...(info.versions ?? []), ...parsed];
		} else if (title === "Variants") {
			const parsed = parseVariantLines(section.lines);
			if (parsed === null) keep(section);
			else info.variants = parsed;
		} else if (title === "Dependencies") {
			const parsed = parseDependencyLines(section.lines);
			if (parsed === null) keep(section);
			else info.dependencies = [...(info.dependencies ?? []), ...parsed];
		} else if (typed !== undefined) {
			const parsed = parseTypedDependencyLines(section.lines, typed.toLowerCase());
			if (parsed === null) keep(section);
			else info.dependencies = [...(info.dependencies ?? []), ...parsed];
		} else if (title === "Licenses") {
			info.licenses = isNone(section.lines)
				? []
				: [section.inline, ...section.lines].map((line) => line.trim()).filter((line) => line.length > 0);
		} else keep(section);
	}
	return info;
}

/** The absolute path `spack location` printed, or null. */
export function parseLocation(text: string): string | null {
	const line = text
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	return line?.startsWith("/") ? line : null;
}

/**
 * Spack's error for a spec that matches several installed specs:
 * `==> Error: <spec> matches multiple packages.` then `Matching packages:`
 * and one `<hash> <spec>` line each. Null for any other text.
 */
export function parseAmbiguousSpecError(
	text: string,
): { spec: string; matches: Array<{ hash: string; spec: string }> } | null {
	const head = /Error: (.+?) matches multiple packages\./u.exec(text);
	if (head?.[1] === undefined) return null;
	const matches: Array<{ hash: string; spec: string }> = [];
	const lines = text.slice(head.index).split("\n");
	const start = lines.findIndex((line) => line.trim() === "Matching packages:");
	if (start < 0) return null;
	for (const line of lines.slice(start + 1)) {
		const match = /^\s+([a-z0-9]{7,64}) +(\S.*)$/u.exec(line);
		if (match?.[1] === undefined || match[2] === undefined) break;
		matches.push({ hash: match[1], spec: match[2].trim() });
	}
	return matches.length > 0 ? { spec: head[1], matches } : null;
}

/**
 * `spack env status`: `No active environment`, `In environment <name>`, or
 * `Using spack.yaml in current directory: <path>`. Null for any other text.
 */
export function parseEnvStatus(text: string): { active: false } | { active: true; environment: string } | null {
	for (const raw of text.split("\n")) {
		const line = raw.replace(/^==> /u, "").trim();
		if (line === "No active environment") return { active: false };
		const named = /^In environment (\S.*)$/u.exec(line)?.[1];
		if (named !== undefined) return { active: true, environment: named.trim() };
		const here = /^Using \S+ in current directory: (\S.*)$/u.exec(line)?.[1];
		if (here !== undefined) return { active: true, environment: here.trim() };
	}
	return null;
}

/** `spack env list` written to a pipe: one name per line, indented. `==>` lines are skipped. */
export function parseEnvList(text: string): { names: string[]; malformed: number } {
	const names: string[] = [];
	let malformed = 0;
	for (const line of text.split("\n")) {
		const name = line.trim();
		if (name.length === 0 || name.startsWith("==>")) continue;
		if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name)) names.push(name);
		else malformed++;
	}
	return { names, malformed };
}

/** Install status of a root spec, from the marker Spack prints before it. */
export type RootStatus = "installed" | "upstream" | "external" | "missing" | "buildcache" | "absent";

const ROOT_MARKERS: Record<string, RootStatus> = {
	"[+]": "installed",
	"[^]": "upstream",
	"[e]": "external",
	"[-]": "missing",
	"[b]": "buildcache",
	"-": "absent",
};

/** Root statuses that mean the root is usable without installing it. */
export const INSTALLED_ROOT_STATUSES: ReadonlySet<RootStatus> = new Set<RootStatus>([
	"installed",
	"upstream",
	"external",
]);

/**
 * `spack find -r` in an environment: `==> In environment <name> (<n> root
 * specs)`, then one `<marker> <spec>` line per root, with `--` group headers
 * in environments that group their roots. Null without the header.
 */
export function parseEnvRoots(text: string): {
	environment: string;
	declaredRoots: number | null;
	roots: Array<{ spec: string; status: RootStatus }>;
	unreadLines: number;
} | null {
	const lines = text.split("\n");
	const headerIndex = lines.findIndex((line) => /^==> In environment /u.test(line));
	if (headerIndex < 0) return null;
	const header = /^==> In environment (\S+)(?: \((no|\d+) root specs?\))?\s*$/u.exec(lines[headerIndex] ?? "");
	if (header?.[1] === undefined) return null;
	const count = header[2];
	const roots: Array<{ spec: string; status: RootStatus }> = [];
	let unreadLines = 0;
	for (const line of lines.slice(headerIndex + 1)) {
		if (line.trim().length === 0 || line.startsWith("--") || line.startsWith("==>")) continue;
		const match = /^(\[[+^eb-]\]| - ) {1,2}(\S.*)$/u.exec(line.trimEnd());
		const status = match?.[1] === undefined ? undefined : ROOT_MARKERS[match[1].trim()];
		if (status === undefined || match?.[2] === undefined) unreadLines++;
		else roots.push({ spec: match[2].trim(), status });
	}
	return {
		environment: header[1],
		declaredRoots: count === undefined ? null : count === "no" ? 0 : Number(count),
		roots,
		unreadLines,
	};
}

export interface SpackRepository {
	name: string;
	/** `installed` when Spack can read it, `uninitialized` for a git repository it has not cloned, `error` otherwise. */
	status: "installed" | "uninitialized" | "error";
	/** The repository's directory, or its git URL while it is uninitialized. */
	location: string | null;
}

/** `spack repo list --json` (Spack 1.2 and later). Null when it is not that JSON. */
export function parseRepoListJson(text: string): SpackRepository[] | null {
	const records = scanJsonDocuments(text).documents.find((document) => Array.isArray(document));
	if (!Array.isArray(records)) return null;
	const repositories: SpackRepository[] = [];
	for (const record of records) {
		if (!isRecord(record)) return null;
		const name = stringOrNull(record.name);
		const status = record.status;
		if (name === null || (status !== "installed" && status !== "uninitialized" && status !== "error")) return null;
		repositories.push({ name, status, location: stringOrNull(record.path) });
	}
	return repositories;
}

/**
 * `spack repo list` as Spack 1.0 and later print it: `[+]` for a repository it
 * read, ` - ` for a git repository not cloned yet, `[-]` for one it could not
 * read, then the name. Null when a line has no such marker.
 */
export function parseRepoListText(text: string): SpackRepository[] | null {
	const repositories: SpackRepository[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const match = /^(\[\+\]| - |\[-\]) (\S+)(?: +(.*))?$/u.exec(line.trimEnd());
		if (match?.[1] === undefined || match[2] === undefined) return null;
		const status = match[1] === "[+]" ? "installed" : match[1] === " - " ? "uninitialized" : "error";
		const rest = match[3]?.trim().split(/\s+/u) ?? [];
		repositories.push({ name: match[2], status, location: rest.at(-1) ?? null });
	}
	return repositories;
}
