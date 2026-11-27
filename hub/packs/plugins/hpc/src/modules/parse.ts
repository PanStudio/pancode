// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure functions from the text Lmod and Environment Modules print to data.
 * Both tools answer the same questions in different text, so each has its
 * own parser per subcommand, and the parsers for one question return the
 * same shape for both. A parser returns null when the text is not that
 * output at all, and otherwise counts the lines it could not read.
 */

export type ModuleToolKind = "lmod" | "environment-modules";

export const MODULE_NAME_PATTERN_TEXT = "^[A-Za-z0-9][A-Za-z0-9_.+/-]*$";
const MODULE_NAME_PATTERN = new RegExp(MODULE_NAME_PATTERN_TEXT, "u");
export const MAX_MODULE_NAME_LENGTH = 128;

/** Why `value` cannot reach the module tool's argv as a module name, or null when it can. */
export function moduleNameProblem(value: unknown, field: string): string | null {
	if (typeof value !== "string") return `${field} must be a string`;
	if (value.length === 0) return `${field} must not be empty`;
	if (value.startsWith("-")) return `${field} must not begin with -`;
	if (value.length > MAX_MODULE_NAME_LENGTH) return `${field} must be at most ${MAX_MODULE_NAME_LENGTH} characters`;
	if (!MODULE_NAME_PATTERN.test(value)) return `${field} must match ${MODULE_NAME_PATTERN_TEXT}`;
	return null;
}

/** The release `<lmod> bash --version` names: "Modules based on Lua: Version 9.5 ...". */
export function parseLmodVersion(text: string): string | null {
	return /Modules based on Lua: Version (\d[^\s,]*)/u.exec(text)?.[1] ?? null;
}

/** The release `modulecmd bash --version` names: "Modules Release 5.7.0 (...)", or "VERSION=3.2.10" before 4.0. */
export function parseModulesVersion(text: string): string | null {
	return /Modules Release (\d[^\s(]*)/u.exec(text)?.[1] ?? /^VERSION=(\d\S*)/mu.exec(text)?.[1] ?? null;
}

/** Whether a dotted version is at least `minimum`, or null when it does not start with a number. */
export function versionAtLeast(version: string, minimum: ReadonlyArray<number>): boolean | null {
	const parts = /^\d+(?:\.\d+)*/u.exec(version)?.[0].split(".").map(Number);
	if (parts === undefined) return null;
	for (let index = 0; index < minimum.length; index++) {
		const have = parts[index] ?? 0;
		const want = minimum[index] ?? 0;
		if (have !== want) return have > want;
	}
	return true;
}

export interface ModuleRef {
	fullName: string;
	name: string;
	/** Null when the full name has no version part. */
	version: string | null;
}

/** Split a full name at its last `/`, or after `knownName` when the tool said where the name ends. */
export function moduleRef(fullName: string, knownName?: string): ModuleRef {
	if (knownName !== undefined && fullName.startsWith(`${knownName}/`) && fullName.length > knownName.length + 1)
		return { fullName, name: knownName, version: fullName.slice(knownName.length + 1) };
	const slash = fullName.lastIndexOf("/");
	if (slash <= 0 || slash === fullName.length - 1) return { fullName, name: fullName, version: null };
	return { fullName, name: fullName.slice(0, slash), version: fullName.slice(slash + 1) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const lines = (text: string): string[] => text.split(/\r?\n/u);

/** A terse line that names one module or collection: no space, no decoration. */
const MODULE_TOKEN = /^[^\s()<>:]+$/u;

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// list ----------------------------------------------------------------------

export interface ListParse {
	modules: ModuleRef[];
	malformedLines: number;
}

/** `<lmod> bash -t list`: one full name per line in load order, or "No modules loaded". */
export function parseLmodTerseList(text: string): ListParse | null {
	const modules: ModuleRef[] = [];
	let malformedLines = 0;
	let none = false;
	for (const raw of lines(text)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		if (/^No modules (?:are )?loaded\.?$/u.test(line)) none = true;
		else if (MODULE_TOKEN.test(line)) modules.push(moduleRef(line));
		else malformedLines++;
	}
	if (modules.length === 0 && !none) return null;
	return { modules, malformedLines };
}

/** `modulecmd bash list -j`: an object keyed by full name, in load order. */
export function parseModulesJsonList(text: string): ListParse | null {
	const parsed = parseJson(text);
	if (!isRecord(parsed)) return null;
	const modules: ModuleRef[] = [];
	let malformedLines = 0;
	for (const [key, value] of Object.entries(parsed)) {
		if (isRecord(value) && value.name === key) modules.push(moduleRef(key));
		else malformedLines++;
	}
	return { modules, malformedLines };
}

// avail ---------------------------------------------------------------------

export interface AvailRow extends ModuleRef {
	/** The `MODULEPATH` directory the module comes from. */
	modulepath: string;
}

export interface AvailParse {
	modules: AvailRow[];
	malformedLines: number;
}

/**
 * `<lmod> bash -t avail [name]`: a `MODULEPATH` directory line ending in `:`,
 * a `name/` line before each name's versions, then full names. With `-d` it
 * lists only the default of each name.
 */
export function parseLmodTerseAvail(text: string): AvailParse | null {
	const modules: AvailRow[] = [];
	let malformedLines = 0;
	let modulepath: string | null = null;
	let currentName: string | undefined;
	let content = 0;
	for (const raw of lines(text)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		content++;
		if (line.startsWith("/") && line.endsWith(":")) {
			modulepath = line.slice(0, -1);
			currentName = undefined;
		} else if (modulepath === null || !MODULE_TOKEN.test(line)) malformedLines++;
		else if (line.endsWith("/")) currentName = line.slice(0, -1);
		else modules.push({ ...moduleRef(line, currentName), modulepath });
	}
	if (content > 0 && content === malformedLines) return null;
	return { modules, malformedLines };
}

/**
 * `modulecmd bash avail -j [name]`: an object keyed by `MODULEPATH`
 * directory, each an object keyed by full name. Aliases and bare directories
 * are not modules and are left out.
 */
export function parseModulesJsonAvail(text: string): AvailParse | null {
	const parsed = parseJson(text);
	if (!isRecord(parsed)) return null;
	const modules: AvailRow[] = [];
	let malformedLines = 0;
	for (const [modulepath, entries] of Object.entries(parsed)) {
		if (!isRecord(entries)) {
			malformedLines++;
			continue;
		}
		for (const [key, value] of Object.entries(entries)) {
			if (!isRecord(value) || value.name !== key) malformedLines++;
			else if (value.type !== "alias" && value.type !== "directory") modules.push({ ...moduleRef(key), modulepath });
		}
	}
	return { modules, malformedLines };
}

export interface AvailModule extends AvailRow {
	/** Whether `module load <name>` picks this one. */
	isDefault: boolean;
}

/**
 * Mark the default of each name from `defaults`, the same listing made with
 * `-d`. Environment Modules lists a default per directory and the first
 * `MODULEPATH` directory holding a name wins, as `module load <name>`
 * resolves it; Lmod already lists one per name.
 */
export function markDefaults(modules: ReadonlyArray<AvailRow>, defaults: ReadonlyArray<AvailRow>): AvailModule[] {
	const firstDirectory = new Map<string, string>();
	for (const row of [...modules, ...defaults])
		if (!firstDirectory.has(row.name)) firstDirectory.set(row.name, row.modulepath);
	const chosen = new Set(
		defaults
			.filter((row) => firstDirectory.get(row.name) === row.modulepath)
			.map((row) => `${row.modulepath}\0${row.fullName}`),
	);
	return modules.map((row) => ({ ...row, isDefault: chosen.has(`${row.modulepath}\0${row.fullName}`) }));
}

// show ----------------------------------------------------------------------

export interface PathChange {
	/** The variable, such as `PATH` or `MODULEPATH`. */
	name: string;
	value: string;
}

/** What a modulefile declares, as the module tool displayed it. */
export interface ModuleDirectives {
	setenv: Array<{ name: string; value: string }>;
	unsetenv: string[];
	prependPath: PathChange[];
	appendPath: PathChange[];
	removePath: PathChange[];
	/** Modules it loads itself when it is loaded. */
	loads: string[];
	/** Modules that must be loaded before it; one of each `anyOf` is enough. */
	requires: Array<{ anyOf: string[] }>;
	conflicts: string[];
	families: string[];
	whatis: string[];
}

export interface ShowParse {
	/** The modulefile the tool read. */
	modulefile: string;
	directives: ModuleDirectives;
	/** Directive lines the server could not read. */
	unreadLines: number;
}

function emptyDirectives(): ModuleDirectives {
	return {
		setenv: [],
		unsetenv: [],
		prependPath: [],
		appendPath: [],
		removePath: [],
		loads: [],
		requires: [],
		conflicts: [],
		families: [],
		whatis: [],
	};
}

const DASHES = /^-{10,}$/u;

type DirectiveKind =
	| "setenv"
	| "unsetenv"
	| "prepend"
	| "append"
	| "remove"
	| "load"
	| "requireEach"
	| "requireAny"
	| "conflict"
	| "family"
	| "whatis"
	| "ignore";

/** Record one directive; false when its arguments are not what it takes. */
function recordDirective(directives: ModuleDirectives, kind: DirectiveKind, args: string[]): boolean {
	const [first, second] = args;
	switch (kind) {
		case "setenv":
			if (first === undefined || second === undefined) return false;
			directives.setenv.push({ name: first, value: second });
			return true;
		case "unsetenv":
			if (first === undefined) return false;
			directives.unsetenv.push(first);
			return true;
		case "prepend":
		case "append":
		case "remove": {
			if (first === undefined || args.length < 2) return false;
			const list =
				kind === "prepend" ? directives.prependPath : kind === "append" ? directives.appendPath : directives.removePath;
			for (const value of args.slice(1)) list.push({ name: first, value });
			return true;
		}
		case "load":
			if (args.length === 0) return false;
			directives.loads.push(...args);
			return true;
		case "requireEach":
			if (args.length === 0) return false;
			for (const name of args) directives.requires.push({ anyOf: [name] });
			return true;
		case "requireAny":
			if (args.length === 0) return false;
			directives.requires.push({ anyOf: args });
			return true;
		case "conflict":
			if (args.length === 0) return false;
			directives.conflicts.push(...args);
			return true;
		case "family":
			if (first === undefined) return false;
			directives.families.push(first);
			return true;
		case "whatis":
			if (args.length === 0) return false;
			directives.whatis.push(args.join(" "));
			return true;
		case "ignore":
			return true;
	}
}

/** The modulefile path in a show header (the first line that is an absolute path ending in `:`) and where the body starts. */
function showHeader(all: string[]): { path: string; start: number } | null {
	for (let index = 0; index < Math.min(all.length, 6); index++) {
		const line = (all[index] ?? "").trim();
		if (!line.startsWith("/") || !line.endsWith(":")) continue;
		let start = index + 1;
		while (start < all.length && /^(?:-{10,})?$/u.test((all[start] ?? "").trim())) start++;
		return { path: line.slice(0, -1), start };
	}
	return null;
}

const LMOD_FUNCTIONS: Readonly<Record<string, DirectiveKind>> = {
	setenv: "setenv",
	pushenv: "setenv",
	unsetenv: "unsetenv",
	prepend_path: "prepend",
	append_path: "append",
	remove_path: "remove",
	load: "load",
	always_load: "load",
	depends_on: "load",
	try_load: "load",
	prereq: "requireEach",
	prereq_any: "requireAny",
	conflict: "conflict",
	family: "family",
	whatis: "whatis",
	help: "ignore",
};

/** The string arguments of a Lua call's argument text; keyword arguments such as `delim=":"` are skipped. */
function luaStrings(body: string): string[] | null {
	const out: string[] = [];
	let index = 0;
	while (index < body.length) {
		const rest = body.slice(index);
		const char = rest[0] ?? "";
		if (/[\s,]/u.test(char)) {
			index++;
			continue;
		}
		const quoted = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/su.exec(rest);
		if (quoted !== null) {
			out.push((quoted[1] ?? quoted[2] ?? "").replace(/\\(.)/gsu, (_, next: string) => (next === "n" ? "\n" : next)));
			index += quoted[0].length;
			continue;
		}
		const long = /^\[(=*)\[([\s\S]*?)\]\1\]/u.exec(rest);
		if (long !== null) {
			out.push((long[2] ?? "").replace(/^\n/u, ""));
			index += long[0].length;
			continue;
		}
		const keyword = /^[A-Za-z_]\w*\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]*)/u.exec(rest);
		if (keyword !== null) {
			index += keyword[0].length;
			continue;
		}
		return null;
	}
	return out;
}

/** Whether one Lua call, possibly over several lines, is a directive the server reads; records it when it is. */
function readLuaCall(directives: ModuleDirectives, text: string): boolean {
	const call = /^([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\)|(\{[\s\S]*\}))$/u.exec(text.trim());
	if (call === null) return false;
	const kind = LMOD_FUNCTIONS[call[1] ?? ""];
	const body = call[2] ?? (call[3] ?? "").slice(1, -1);
	const args = luaStrings(body);
	return kind !== undefined && args !== null && recordDirective(directives, kind, args);
}

/** `<lmod> bash show <name>`: a dashed header naming the modulefile, then one Lua call per directive. */
export function parseLmodShow(text: string): ShowParse | null {
	const all = lines(text);
	const header = showHeader(all);
	if (header === null) return null;
	const directives = emptyDirectives();
	let unreadLines = 0;
	for (let index = header.start; index < all.length; index++) {
		const line = (all[index] ?? "").trim();
		if (line.length === 0 || DASHES.test(line)) continue;
		// A long string ([[ ... ]]) may run over several lines: read the call up to where it closes.
		const opened = /\[(=*)\[/u.exec(line);
		let end = index;
		if (opened !== null && !line.slice(opened.index + opened[0].length).includes(`]${opened[1]}]`)) {
			const close = `]${opened[1]}]`;
			while (end + 1 < all.length && !(all[end + 1] ?? "").includes(close)) end++;
			end = Math.min(end + 1, all.length - 1);
		}
		const call = all.slice(index, end + 1).join("\n");
		if (!readLuaCall(directives, call)) unreadLines += end - index + 1;
		index = end;
	}
	return { modulefile: header.path, directives, unreadLines };
}

/** Split one Tcl command line into words: braces, double quotes and backslashes. Null when a brace or quote is left open. */
export function tclWords(line: string): string[] | null {
	const words: string[] = [];
	let index = 0;
	while (index < line.length) {
		const char = line[index] ?? "";
		if (char === " " || char === "\t") {
			index++;
			continue;
		}
		if (char === "{") {
			let depth = 1;
			let end = index + 1;
			for (; end < line.length && depth > 0; end++) {
				if (line[end] === "\\") end++;
				else if (line[end] === "{") depth++;
				else if (line[end] === "}") depth--;
			}
			if (depth > 0) return null;
			words.push(line.slice(index + 1, end - 1));
			index = end;
			continue;
		}
		const quoted = char === '"';
		if (quoted) index++;
		let word = "";
		while (index < line.length) {
			const current = line[index] ?? "";
			if (quoted ? current === '"' : current === " " || current === "\t") break;
			if (current === "\\" && index + 1 < line.length) {
				word += line[index + 1];
				index += 2;
			} else {
				word += current;
				index++;
			}
		}
		if (quoted) {
			if (line[index] !== '"') return null;
			index++;
		}
		words.push(word);
	}
	return words;
}

const withoutOptions = (words: ReadonlyArray<string>): string[] => words.filter((word) => !word.startsWith("-"));

/** A path command's words without its options (`--delim :`, `-d :`, `--duplicates`, `--index`). */
function pathWords(words: ReadonlyArray<string>): string[] {
	const out: string[] = [];
	for (let index = 0; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "--delim" || word === "-d") index++;
		else if (!word.startsWith("-")) out.push(word);
	}
	return out;
}

const MODULES_COMMANDS: Readonly<Record<string, [DirectiveKind, (words: string[]) => string[]]>> = {
	setenv: ["setenv", withoutOptions],
	pushenv: ["setenv", withoutOptions],
	unsetenv: ["unsetenv", withoutOptions],
	"prepend-path": ["prepend", pathWords],
	"append-path": ["append", pathWords],
	"remove-path": ["remove", pathWords],
	"depends-on": ["load", withoutOptions],
	"always-load": ["load", withoutOptions],
	prereq: ["requireAny", withoutOptions],
	"prereq-any": ["requireAny", withoutOptions],
	"prereq-all": ["requireEach", withoutOptions],
	conflict: ["conflict", withoutOptions],
	family: ["family", (words) => words],
	"module-whatis": ["whatis", (words) => words],
};

function readModulesLine(directives: ModuleDirectives, words: string[]): boolean {
	const [command = "", ...rest] = words;
	if (command === "module") {
		const [sub = "", ...names] = rest;
		if (sub === "load" || sub === "add" || sub === "try-load")
			return recordDirective(directives, "load", withoutOptions(names));
		if (sub === "load-any") return recordDirective(directives, "requireAny", withoutOptions(names));
		if (sub === "use") {
			const append = names.includes("-a") || names.includes("--append");
			return recordDirective(directives, append ? "append" : "prepend", ["MODULEPATH", ...withoutOptions(names)]);
		}
		return false;
	}
	const known = MODULES_COMMANDS[command];
	return known !== undefined && recordDirective(directives, known[0], known[1](rest));
}

/** `modulecmd bash show <name>`: dashes, the modulefile path ending in `:`, one Tcl command per line, dashes. */
export function parseModulesShow(text: string): ShowParse | null {
	const all = lines(text);
	const header = showHeader(all);
	if (header === null) return null;
	const directives = emptyDirectives();
	let unreadLines = 0;
	for (const raw of all.slice(header.start)) {
		const line = raw.trim();
		if (line.length === 0 || DASHES.test(line)) continue;
		const words = tclWords(line);
		if (words === null || !readModulesLine(directives, words)) unreadLines++;
	}
	return { modulefile: header.path, directives, unreadLines };
}

// spider (Lmod) -------------------------------------------------------------

export interface SpiderModule {
	name: string;
	versions: string[];
}

export interface SpiderParse {
	modules: SpiderModule[];
	malformedLines: number;
}

/** `<lmod> bash -t spider [name]`: full names one per line, with a `name/` line before a name's versions when it prints one. */
export function parseLmodTerseSpider(text: string): SpiderParse | null {
	const byName = new Map<string, string[]>();
	let malformedLines = 0;
	let content = 0;
	let currentName: string | undefined;
	for (const raw of lines(text)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		content++;
		if (!MODULE_TOKEN.test(line)) {
			malformedLines++;
			continue;
		}
		if (line.endsWith("/")) {
			currentName = line.slice(0, -1);
			if (!byName.has(currentName)) byName.set(currentName, []);
			continue;
		}
		const ref = moduleRef(line, currentName);
		const versions = byName.get(ref.name) ?? [];
		if (ref.version !== null && !versions.includes(ref.version)) versions.push(ref.version);
		byName.set(ref.name, versions);
	}
	if (content > 0 && content === malformedLines) return null;
	return { modules: [...byName].map(([name, versions]) => ({ name, versions })), malformedLines };
}

export interface SpiderDetail {
	fullName: string;
	/** True when it loads with nothing loaded first; null when the page says neither. */
	loadableDirectly: boolean | null;
	/** Each entry is one way to make it loadable: the modules to load first, in order. Null when the page lists none. */
	loadFirst: string[][] | null;
}

/** `<lmod> bash spider <name/version>`: the page for one version, titled `name: name/version`. */
export function parseLmodSpiderDetail(text: string): SpiderDetail | null {
	const all = lines(text);
	let fullName: string | null = null;
	let loadableDirectly: boolean | null = null;
	let loadFirst: string[][] | null = null;
	for (let index = 0; index < all.length; index++) {
		const line = (all[index] ?? "").trim();
		const title = /^([^\s:]+): (\S+)$/u.exec(line);
		if (fullName === null && title !== null && MODULE_TOKEN.test(title[2] ?? "")) fullName = title[2] ?? null;
		if (line.startsWith("This module can be loaded directly")) {
			loadableDirectly = true;
			loadFirst = [];
		} else if (line.startsWith("You will need to load all module(s) on any one of the lines below")) {
			loadableDirectly = false;
			const options: string[][] = [];
			for (let next = index + 1; next < all.length; next++) {
				const option = (all[next] ?? "").trim();
				if (option.length === 0) {
					if (options.length > 0) break;
					continue;
				}
				const names = option.split(/\s+/u);
				if (!names.every((word) => MODULE_TOKEN.test(word))) break;
				options.push(names);
			}
			loadFirst = options.length > 0 ? options : null;
		}
	}
	if (fullName === null) return null;
	return { fullName, loadableDirectly, loadFirst };
}

// collections ---------------------------------------------------------------

export interface NamesParse {
	names: string[];
	malformedLines: number;
}

/** `<lmod> bash -t savelist`, or `-t describe <name>`: one name per line. */
export function parseLmodTerseNames(text: string): NamesParse | null {
	const names: string[] = [];
	let malformedLines = 0;
	for (const raw of lines(text)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		if (MODULE_TOKEN.test(line)) names.push(line);
		else malformedLines++;
	}
	if (names.length === 0 && malformedLines > 0) return null;
	return { names, malformedLines };
}

/** `modulecmd bash savelist -j`: an object keyed by collection name. */
export function parseModulesJsonSavelist(text: string): NamesParse | null {
	const parsed = parseJson(text);
	if (!isRecord(parsed)) return null;
	const names: string[] = [];
	let malformedLines = 0;
	for (const [key, value] of Object.entries(parsed)) {
		if (isRecord(value) && value.name === key) names.push(key);
		else malformedLines++;
	}
	return { names, malformedLines };
}

export interface CollectionParse {
	modules: string[];
	/** The directories the collection puts on `MODULEPATH`. */
	modulepath: string[];
	unreadLines: number;
}

/** `modulecmd bash saveshow <name>`: the collection file's path, then `module use` and `module load` lines between dashes. */
export function parseModulesSaveshow(text: string): CollectionParse | null {
	const all = lines(text);
	const header = showHeader(all);
	if (header === null) return null;
	const modules: string[] = [];
	const modulepath: string[] = [];
	let unreadLines = 0;
	for (const raw of all.slice(header.start)) {
		const line = raw.trim();
		if (line.length === 0 || DASHES.test(line)) continue;
		const [command, sub, ...rest] = tclWords(line) ?? [];
		const names = withoutOptions(rest);
		if (command === "module" && sub === "load" && names.length > 0) modules.push(...names);
		else if (command === "module" && sub === "use" && names.length > 0) modulepath.push(...names);
		else unreadLines++;
	}
	return { modules, modulepath, unreadLines };
}
