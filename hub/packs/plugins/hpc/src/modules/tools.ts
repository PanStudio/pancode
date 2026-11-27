// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The modules server's six tools. Each asks the site's module tool (Lmod or
 * Environment Modules) a question and returns the answer in one shape for
 * both. None of them loads a module: a process cannot change its caller's
 * environment, and a later shell command starts from PanCode's own
 * environment, so `modules_plan` writes the `module load` lines a batch
 * script needs instead.
 */
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { defineTool, type ToolResult } from "pancode/sdk/tool";
import {
	findModuleTool,
	type ModuleTool,
	moduleToolVersion,
	runModuleTool,
	SPIDER_TIMEOUT_MS,
	type ToolVersion,
} from "./locate.js";
import {
	type AvailParse,
	MAX_MODULE_NAME_LENGTH,
	MODULE_NAME_PATTERN_TEXT,
	type ModuleDirectives,
	markDefaults,
	moduleNameProblem,
	parseLmodShow,
	parseLmodSpiderDetail,
	parseLmodTerseAvail,
	parseLmodTerseList,
	parseLmodTerseNames,
	parseLmodTerseSpider,
	parseModulesJsonAvail,
	parseModulesJsonList,
	parseModulesJsonSavelist,
	parseModulesSaveshow,
	parseModulesShow,
	type ShowParse,
	type SpiderDetail,
	versionAtLeast,
} from "./parse.js";

export const MAX_LISTED = 500;
export const MAX_MODULEFILE_BYTES = 64 * 1024;
export const MAX_PLAN_MODULES = 20;
export const PLAN_DEPTH = 5;
/** `show` runs one plan makes at most, its modules and their needs together. */
export const MAX_PLAN_SHOWS = 100;
const READ_TIMEOUT_MS = 5_000;
/** Lmod pads its spider page to the terminal width; a fixed width keeps it the same everywhere. */
const LMOD_WIDTH = "--width=300";

const NAME_SCHEMA = {
	type: "string",
	pattern: MODULE_NAME_PATTERN_TEXT,
	maxLength: MAX_MODULE_NAME_LENGTH,
} as const;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Session {
	tool: ModuleTool;
	version: ToolVersion;
	/** The fields every result opens with. */
	header: { tool: ModuleTool["kind"]; program: string; version: string | null };
	unavailable: Record<string, string>;
}

/** Find the tool and ask its version, or the tool error that names what is missing. */
async function begin(toolName: string, signal: AbortSignal): Promise<Session | { error: string }> {
	const located = findModuleTool();
	if (!located.ok) return { error: `${toolName}: ${located.reason}` };
	const version = await moduleToolVersion(located.tool, signal);
	const unavailable: Record<string, string> = {};
	if (version.version === null) unavailable.version = version.reason;
	return {
		tool: located.tool,
		version,
		header: { tool: located.tool.kind, program: located.tool.program, version: version.version },
		unavailable,
	};
}

/** Environment Modules prints JSON from 4.5 on; an older release named by its version is refused. */
function needsJson(toolName: string, session: Session): string | null {
	if (session.tool.kind !== "environment-modules" || session.version.version === null) return null;
	if (versionAtLeast(session.version.version, [4, 5]) !== false) return null;
	return `${toolName}: Environment Modules ${session.version.version} (${session.tool.program}) has no JSON output, which this tool reads; it needs Environment Modules 4.5 or later`;
}

function checkName(toolName: string, value: unknown, field: string): string | null {
	const problem = moduleNameProblem(value, field);
	return problem === null ? null : `${toolName}: ${problem}`;
}

const unreadable = (toolName: string, session: Session, what: string): ToolResult => ({
	error: `${toolName}: ${session.tool.program} printed text the server could not read as ${what}`,
});

const modulesList = defineTool({
	name: "modules_list",
	title: "Loaded modules",
	description: `Returns the software modules loaded in the environment this server was started from, in load order (at most ${MAX_LISTED}), each with its name and version: that is the session's starting environment, not the state after some later shell command, and no tool can load or unload a module for the session. Prefer it over running module list in a shell: it answers in the same fields from Lmod and Environment Modules, and says when the list was cut.`,
	input: { type: "object", properties: {} },
	actionClass: "read",
	idempotent: true,
	async run(_args, context) {
		const session = await begin("modules_list", context.signal);
		if ("error" in session) return session;
		const json = needsJson("modules_list", session);
		if (json !== null) return { error: json };
		const lmod = session.tool.kind === "lmod";
		const output = await runModuleTool(session.tool, lmod ? ["-t", "list"] : ["list", "-j"], context);
		if (!output.ok) return { error: `modules_list: ${output.error}` };
		const parsed = lmod ? parseLmodTerseList(output.text) : parseModulesJsonList(output.text);
		if (parsed === null) return unreadable("modules_list", session, "a module list");
		return {
			json: {
				...session.header,
				modules: parsed.modules.slice(0, MAX_LISTED),
				total: parsed.modules.length,
				cap: MAX_LISTED,
				truncated: parsed.modules.length > MAX_LISTED,
				malformedLines: parsed.malformedLines,
				warnings: output.warnings,
				note:
					"These are the modules loaded when this server started. A module loaded later in some shell is not seen here, and no tool can load a module into the session.",
				unavailable: session.unavailable,
			},
		};
	},
});

const modulesAvail = defineTool({
	name: "modules_avail",
	title: "Available modules",
	description: `Returns the modules this site offers on the current MODULEPATH (at most ${MAX_LISTED}), optionally only those whose full name starts with or contains name, each with its name, version, the MODULEPATH directory it comes from and whether it is the default that module load <name> picks. Prefer it over running module avail in a shell: the answer has the same fields from Lmod and Environment Modules and says when the list was cut; it lists modules and cannot load one for the session.`,
	input: {
		type: "object",
		properties: {
			name: { ...NAME_SCHEMA, description: "Only modules whose full name (name/version) matches this, case-sensitively." },
			match: {
				type: "string",
				enum: ["prefix", "contains"],
				description: "Whether name must start the full name or may appear anywhere in it. Default prefix.",
			},
		},
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { name?: string; match?: string }, context) {
		if (args.name !== undefined) {
			const problem = checkName("modules_avail", args.name, "name");
			if (problem !== null) return { error: problem };
		}
		const match = args.match ?? "prefix";
		if (match !== "prefix" && match !== "contains") return { error: "modules_avail: match must be prefix or contains" };
		const session = await begin("modules_avail", context.signal);
		if ("error" in session) return session;
		const json = needsJson("modules_avail", session);
		if (json !== null) return { error: json };
		const lmod = session.tool.kind === "lmod";
		// Both tools are asked for every module containing name, and the server applies prefix or contains itself.
		const filter = args.name === undefined ? [] : lmod ? [args.name] : ["-C", args.name];
		const listing = async (
			defaults: boolean,
		): Promise<{ parsed: AvailParse; warnings: string[] } | { error: string }> => {
			const argv = lmod
				? ["-t", ...(defaults ? ["-d"] : []), "avail", ...filter]
				: ["avail", ...(defaults ? ["-d"] : []), "-j", ...filter];
			const output = await runModuleTool(session.tool, argv, { signal: context.signal });
			if (!output.ok) return { error: `modules_avail: ${output.error}` };
			const parsed = lmod ? parseLmodTerseAvail(output.text) : parseModulesJsonAvail(output.text);
			if (parsed === null)
				return { error: `modules_avail: ${session.tool.program} printed text the server could not read as a module list` };
			return { parsed, warnings: output.warnings };
		};
		const all = await listing(false);
		if ("error" in all) return all;
		const defaults = await listing(true);
		const unavailable = { ...session.unavailable };
		if ("error" in defaults) unavailable.isDefault = defaults.error;
		const name = args.name;
		const keep = (fullName: string): boolean =>
			name === undefined || (match === "prefix" ? fullName.startsWith(name) : fullName.includes(name));
		const rows = all.parsed.modules.filter((row) => keep(row.fullName));
		const marked = markDefaults(rows, "error" in defaults ? [] : defaults.parsed.modules);
		const modules = marked
			.slice(0, MAX_LISTED)
			.map((row) => ({ ...row, isDefault: "error" in defaults ? null : row.isDefault }));
		if (modules.some((row) => row.version === null))
			unavailable["modules[].version"] = "a module whose full name has no / names no version";
		return {
			json: {
				...session.header,
				...(name !== undefined ? { name, match } : {}),
				modules,
				total: rows.length,
				cap: MAX_LISTED,
				truncated: rows.length > MAX_LISTED,
				malformedLines: all.parsed.malformedLines,
				warnings: all.warnings,
				unavailable,
			},
		};
	},
});

type FileText = { text: string; bytes: number; truncated: boolean } | { reason: string };

/** The first `MAX_MODULEFILE_BYTES` of a modulefile, bounded in time so a hung file system answers with a reason. */
async function readModulefile(path: string): Promise<FileText> {
	if (!isAbsolute(path)) return { reason: `the module tool named ${path}, which is not an absolute path` };
	const reading = (async (): Promise<FileText> => {
		const handle = await open(path, "r");
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) return { reason: `${path} is not a regular file` };
			const buffer = Buffer.alloc(MAX_MODULEFILE_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, MAX_MODULEFILE_BYTES, 0);
			return {
				text: buffer.subarray(0, bytesRead).toString("utf8"),
				bytes: stats.size,
				truncated: stats.size > bytesRead,
			};
		} finally {
			await handle.close();
		}
	})().catch((error: unknown): FileText => ({ reason: `${path} could not be read: ${message(error)}` }));
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<FileText>((settle) => {
		timer = setTimeout(
			() => settle({ reason: `${path} could not be read within ${READ_TIMEOUT_MS / 1000} seconds` }),
			READ_TIMEOUT_MS,
		);
		timer.unref();
	});
	try {
		return await Promise.race([reading, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

type Shown = { ok: true; show: ShowParse; warnings: string[] } | { ok: false; error: string };

async function showModule(
	session: Session,
	name: string,
	signal: AbortSignal,
	env?: Record<string, string>,
): Promise<Shown> {
	const output = await runModuleTool(session.tool, ["show", name], { signal, ...(env !== undefined ? { env } : {}) });
	if (!output.ok) return output;
	const show = session.tool.kind === "lmod" ? parseLmodShow(output.text) : parseModulesShow(output.text);
	if (show === null)
		return { ok: false, error: `${session.tool.program} printed text the server could not read as a modulefile display` };
	return { ok: true, show, warnings: output.warnings };
}

const modulesShow = defineTool({
	name: "modules_show",
	title: "Show a module",
	description: `Returns one module's modulefile path, its text (at most ${MAX_MODULEFILE_BYTES / 1024} KiB), and the directives the module tool displays for it (variables it sets, path prepends and appends, modules it loads or requires, conflicts, family, what-is text), with a count of lines the server could not read. Prefer it over running module show in a shell: the directives come back as fields from Lmod and Environment Modules alike, and nothing is loaded, since no tool can change the session's environment.`,
	input: {
		type: "object",
		properties: { name: { ...NAME_SCHEMA, description: "The module, as name or name/version." } },
		required: ["name"],
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { name: string }, context) {
		const problem = checkName("modules_show", args.name, "name");
		if (problem !== null) return { error: problem };
		const session = await begin("modules_show", context.signal);
		if ("error" in session) return session;
		const shown = await showModule(session, args.name, context.signal);
		if (!shown.ok) return { error: `modules_show: ${shown.error}` };
		const file = await readModulefile(shown.show.modulefile);
		const unavailable = { ...session.unavailable };
		if ("reason" in file) {
			unavailable.text = file.reason;
			unavailable.textBytes = file.reason;
		}
		return {
			json: {
				...session.header,
				name: args.name,
				modulefile: shown.show.modulefile,
				text: "reason" in file ? null : file.text,
				textBytes: "reason" in file ? null : file.bytes,
				textTruncated: "reason" in file ? false : file.truncated,
				textCap: MAX_MODULEFILE_BYTES,
				directives: shown.show.directives,
				unreadLines: shown.show.unreadLines,
				warnings: shown.warnings,
				note:
					"The directives are what the module tool displays when it reads the modulefile without loading it; conditionals took the branch they take in this environment.",
				unavailable,
			},
		};
	},
});

const modulesSpider = defineTool({
	name: "modules_spider",
	title: "Search all modules",
	description: `Lmod only: returns every module in the whole module hierarchy whose name matches name, with its versions (at most ${MAX_LISTED} names), and for a name/version the modules that must be loaded first to make it available. Prefer it over running module spider in a shell when a module is missing from modules_avail because it sits behind a compiler or MPI module; on Environment Modules it is unavailable, so use modules_avail there.`,
	input: {
		type: "object",
		properties: {
			name: {
				...NAME_SCHEMA,
				description: "A name, or part of one, to list its versions; or name/version to also get the modules to load first.",
			},
		},
		required: ["name"],
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { name: string }, context) {
		const problem = checkName("modules_spider", args.name, "name");
		if (problem !== null) return { error: problem };
		const located = findModuleTool();
		if (located.ok && located.tool.kind === "environment-modules")
			return {
				error: `modules_spider: this site's module tool is Environment Modules (${located.tool.program}), and modules_spider reads Lmod's module hierarchy; use modules_avail to list the modules Environment Modules offers`,
			};
		const session = await begin("modules_spider", context.signal);
		if ("error" in session) return session;
		const slash = args.name.lastIndexOf("/");
		const versioned = slash > 0 && slash < args.name.length - 1;
		const search = versioned ? args.name.slice(0, slash) : args.name;
		const output = await runModuleTool(session.tool, ["-t", "spider", search], {
			signal: context.signal,
			timeoutMs: SPIDER_TIMEOUT_MS,
		});
		if (!output.ok) return { error: `modules_spider: ${output.error}` };
		const parsed = parseLmodTerseSpider(output.text);
		if (parsed === null) return unreadable("modules_spider", session, "a spider listing");
		const unavailable = { ...session.unavailable };
		let detail: SpiderDetail | null = null;
		if (!versioned) unavailable.detail = "name names no version; give name/version for the modules to load first";
		else {
			const page = await runModuleTool(session.tool, [LMOD_WIDTH, "spider", args.name], {
				signal: context.signal,
				timeoutMs: SPIDER_TIMEOUT_MS,
			});
			if (!page.ok) unavailable.detail = page.error;
			else {
				detail = parseLmodSpiderDetail(page.text);
				if (detail === null)
					unavailable.detail = `${session.tool.program} printed text the server could not read as the spider page for ${args.name}`;
				else if (detail.loadFirst === null)
					unavailable["detail.loadFirst"] = "the spider page says neither that it loads directly nor what to load first";
			}
		}
		return {
			json: {
				...session.header,
				name: args.name,
				modules: parsed.modules.slice(0, MAX_LISTED),
				total: parsed.modules.length,
				cap: MAX_LISTED,
				truncated: parsed.modules.length > MAX_LISTED,
				malformedLines: parsed.malformedLines,
				detail,
				warnings: output.warnings,
				unavailable,
			},
		};
	},
});

interface PlannedModule {
	name: string;
	found: boolean;
	modulefile: string | null;
	directives: ModuleDirectives | null;
	unreadLines: number | null;
	error?: string;
}

interface PlannedNeed extends PlannedModule {
	/** The module that declares it, and how. */
	neededBy: string;
	how: "loads" | "requires";
	/** Set when the requirement is one of several alternatives. */
	anyOf?: string[];
	depth: number;
}

const PLAN_NOTE =
	"declaredOnly: nothing was loaded. Each entry is what the modulefile declares as module show displays it, in this server's starting environment. Conflicts, family swaps and conditionals are decided only when a module is really loaded, so the real result can differ. Neither this server nor a later shell command can load modules into the session: put commands in a batch script, where they take effect for that script.";

/** Whether `emitted` already covers the module a requirement names (gcc covers gcc/12.3.0 and the reverse). */
function covers(emitted: ReadonlyArray<string>, wanted: string): boolean {
	return emitted.some((name) => name === wanted || name.startsWith(`${wanted}/`) || wanted.startsWith(`${name}/`));
}

const modulesPlan = defineTool({
	name: "modules_plan",
	title: "Plan module loads",
	description: `For an ordered list of 1 to ${MAX_PLAN_MODULES} modules, returns each one's declared changes from module show, the modules it declares it needs to a depth of ${PLAN_DEPTH} (at most ${MAX_PLAN_SHOWS} modules read in all), and commands, the module load lines to put in a batch script; declaredOnly is always true because it never runs module load. Use it to write correct module load lines into a script: neither this server nor a later shell command can load modules into the session, and conflicts, family swaps and conditionals are decided only when a module is really loaded.`,
	input: {
		type: "object",
		properties: {
			modules: {
				type: "array",
				minItems: 1,
				maxItems: MAX_PLAN_MODULES,
				items: NAME_SCHEMA,
				description: "The modules to load, in the order they should be loaded.",
			},
		},
		required: ["modules"],
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { modules: string[] }, context) {
		if (!Array.isArray(args.modules) || args.modules.length < 1 || args.modules.length > MAX_PLAN_MODULES)
			return { error: `modules_plan: modules must be a list of 1 to ${MAX_PLAN_MODULES} module names` };
		for (const [index, name] of args.modules.entries()) {
			const problem = checkName("modules_plan", name, `modules[${index}]`);
			if (problem !== null) return { error: problem };
		}
		const session = await begin("modules_plan", context.signal);
		if ("error" in session) return session;

		// A module that extends MODULEPATH (a compiler in an Lmod hierarchy) makes the next ones visible:
		// later shows see the directories earlier modules declare, without anything being loaded.
		const baseModulepath = (process.env.MODULEPATH ?? "").split(":").filter((dir) => dir.length > 0);
		const prepended: string[] = [];
		const appended: string[] = [];
		let shows = 0;
		let truncated = false;
		const read = async (name: string): Promise<PlannedModule> => {
			shows++;
			const env =
				prepended.length + appended.length > 0
					? { MODULEPATH: [...prepended, ...baseModulepath, ...appended].join(":") }
					: undefined;
			const shown = await showModule(session, name, context.signal, env);
			if (!shown.ok)
				return {
					name,
					found: false,
					modulefile: null,
					directives: null,
					unreadLines: null,
					error:
						session.tool.kind === "lmod"
							? `${shown.error} (a module behind a compiler or MPI module is found after that module in modules; modules_spider ${name} names what to load first)`
							: shown.error,
				};
			for (const change of shown.show.directives.prependPath)
				if (change.name === "MODULEPATH") prepended.unshift(...change.value.split(":").filter((dir) => dir.length > 0));
			for (const change of shown.show.directives.appendPath)
				if (change.name === "MODULEPATH") appended.push(...change.value.split(":").filter((dir) => dir.length > 0));
			return {
				name,
				found: true,
				modulefile: shown.show.modulefile,
				directives: shown.show.directives,
				unreadLines: shown.show.unreadLines,
			};
		};

		const modules: PlannedModule[] = [];
		for (const name of args.modules) {
			if (context.signal.aborted) return { error: "modules_plan: the call was cancelled" };
			modules.push(await read(name));
		}

		const byName = new Map<string, PlannedModule>(modules.map((entry) => [entry.name, entry]));
		const needs: PlannedNeed[] = [];
		let depthLimitReached = false;
		let frontier: Array<{ entry: PlannedModule; depth: number }> = modules.map((entry) => ({ entry, depth: 0 }));
		while (frontier.length > 0) {
			const next: typeof frontier = [];
			for (const { entry, depth } of frontier) {
				const directives = entry.directives;
				if (directives === null) continue;
				const declared = [
					...directives.loads.map((name) => ({ name, how: "loads" as const, anyOf: undefined })),
					...directives.requires.flatMap((group) =>
						group.anyOf.map((name) => ({
							name,
							how: "requires" as const,
							anyOf: group.anyOf.length > 1 ? group.anyOf : undefined,
						})),
					),
				];
				if (declared.length > 0 && depth + 1 > PLAN_DEPTH) {
					depthLimitReached = true;
					continue;
				}
				for (const need of declared) {
					if (byName.has(need.name)) continue;
					if (shows >= MAX_PLAN_SHOWS) {
						truncated = true;
						continue;
					}
					if (context.signal.aborted) return { error: "modules_plan: the call was cancelled" };
					const planned = await read(need.name);
					byName.set(need.name, planned);
					needs.push({
						...planned,
						neededBy: entry.name,
						how: need.how,
						...(need.anyOf !== undefined ? { anyOf: need.anyOf } : {}),
						depth: depth + 1,
					});
					next.push({ entry: planned, depth: depth + 1 });
				}
			}
			frontier = next;
		}

		// Each requested module in order, after the first alternative of each requirement nothing earlier covers.
		// What a module loads itself needs no line of its own.
		const commands: string[] = [];
		const emitted: string[] = [];
		const added: string[] = [];
		const emit = (name: string, depth: number, requested: boolean): void => {
			if (covers(emitted, name) && !requested) return;
			if (emitted.includes(name)) return;
			const requires = byName.get(name)?.directives?.requires ?? [];
			if (depth < PLAN_DEPTH)
				for (const group of requires) {
					const first = group.anyOf[0];
					if (first !== undefined && !group.anyOf.some((alternative) => covers(emitted, alternative)))
						emit(first, depth + 1, false);
				}
			emitted.push(name);
			commands.push(`module load ${name}`);
			if (!requested) added.push(name);
		};
		for (const name of args.modules) emit(name, 0, true);

		return {
			json: {
				...session.header,
				declaredOnly: true,
				note: PLAN_NOTE,
				modules,
				needs,
				commands,
				addedForRequirements: added,
				modulepathAdded: [...prepended, ...appended],
				depthLimit: PLAN_DEPTH,
				depthLimitReached,
				showCap: MAX_PLAN_SHOWS,
				showsRun: shows,
				truncated,
				unavailable: session.unavailable,
			},
		};
	},
});

const modulesCollections = defineTool({
	name: "modules_collections",
	title: "Module collections",
	description: `Returns the names of the user's saved module collections (at most ${MAX_LISTED}), or with name the modules one collection loads, in order. Prefer it over running module savelist or module describe in a shell: the answer has the same fields from Lmod and Environment Modules; it does not restore a collection, which no tool can do for the session.`,
	input: {
		type: "object",
		properties: { name: { ...NAME_SCHEMA, description: "A collection to list the modules of." } },
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { name?: string }, context) {
		if (args.name !== undefined) {
			const problem = checkName("modules_collections", args.name, "name");
			if (problem !== null) return { error: problem };
		}
		const session = await begin("modules_collections", context.signal);
		if ("error" in session) return session;
		const lmod = session.tool.kind === "lmod";
		if (args.name === undefined) {
			const json = needsJson("modules_collections", session);
			if (json !== null) return { error: json };
			const output = await runModuleTool(session.tool, lmod ? ["-t", "savelist"] : ["savelist", "-j"], context);
			if (!output.ok) return { error: `modules_collections: ${output.error}` };
			const parsed = lmod ? parseLmodTerseNames(output.text) : parseModulesJsonSavelist(output.text);
			if (parsed === null) return unreadable("modules_collections", session, "a collection list");
			return {
				json: {
					...session.header,
					collections: parsed.names.slice(0, MAX_LISTED),
					total: parsed.names.length,
					cap: MAX_LISTED,
					truncated: parsed.names.length > MAX_LISTED,
					malformedLines: parsed.malformedLines,
					warnings: output.warnings,
					unavailable: session.unavailable,
				},
			};
		}
		if (lmod) {
			// Lmod's terse describe prints nothing for a collection that does not exist, so ask for the names first.
			const saved = await runModuleTool(session.tool, ["-t", "savelist"], context);
			if (!saved.ok) return { error: `modules_collections: ${saved.error}` };
			const names = parseLmodTerseNames(saved.text);
			if (names === null) return unreadable("modules_collections", session, "a collection list");
			if (!names.names.includes(args.name))
				return { error: `modules_collections: there is no saved collection named ${args.name}` };
		}
		const output = await runModuleTool(
			session.tool,
			lmod ? ["-t", "describe", args.name] : ["saveshow", args.name],
			context,
		);
		if (!output.ok) return { error: `modules_collections: ${output.error}` };
		const unavailable = { ...session.unavailable };
		let modules: string[];
		let modulepath: string[] | null = null;
		let unreadLines: number;
		if (lmod) {
			const parsed = parseLmodTerseNames(output.text);
			if (parsed === null || (parsed.names.length === 0 && output.warnings.length > 0))
				return {
					error: `modules_collections: ${output.warnings[0] ?? `${session.tool.program} printed text the server could not read as a collection`}`,
				};
			modules = parsed.names;
			unreadLines = parsed.malformedLines;
			unavailable.modulepath = "Lmod's describe does not report the directories a collection puts on MODULEPATH";
		} else {
			const parsed = parseModulesSaveshow(output.text);
			if (parsed === null) return unreadable("modules_collections", session, "a collection");
			modules = parsed.modules;
			modulepath = parsed.modulepath;
			unreadLines = parsed.unreadLines;
		}
		return {
			json: {
				...session.header,
				name: args.name,
				modules: modules.slice(0, MAX_LISTED),
				total: modules.length,
				cap: MAX_LISTED,
				truncated: modules.length > MAX_LISTED,
				modulepath,
				unreadLines,
				warnings: output.warnings,
				unavailable,
			},
		};
	},
});

export const MODULES_TOOLS = [modulesList, modulesAvail, modulesShow, modulesSpider, modulesPlan, modulesCollections];
