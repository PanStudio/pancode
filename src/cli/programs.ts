// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	installBrowserComponent,
	PLAYWRIGHT_CORE_PACKAGE,
	PLAYWRIGHT_CORE_VERSION,
	resolveBrowserComponent,
} from "../domains/install/browser-component.js";
import {
	CLAUDE_AGENT_SDK_PACKAGE,
	CLAUDE_AGENT_SDK_VERSION,
	installClaudeAgentSdk,
	resolveClaudeAgentSdkEntry,
} from "../domains/install/claude-sdk-install.js";
import {
	COPILOT_SDK_PACKAGE,
	COPILOT_SDK_VERSION,
	installCopilotSdk,
	resolveCopilotSdkEntry,
} from "../domains/install/copilot-sdk-install.js";
import { describeYaziProfile, inspectCurrentYaziProfile, resetYaziProfile } from "../domains/mux/index.js";
import {
	describeFloorRejection,
	describeResolution,
	findPinnedProgram,
	installedProgramVersions,
	installProgram,
	installRemedy,
	PINNED_PROGRAMS,
	type ProgramStatus,
	programStatus,
	programStatuses,
	removeProgram,
} from "../lib/programs/index.js";
import { formatColumns, printError, printOk } from "./argv.js";
import { writeCliFailure } from "./lib/json-out.js";
import type { ErrorSlug } from "./lib/slugs.js";

const HELP = `pancode programs <command>

Manage the external terminal programs PanCode can drive. Every one of them is
optional: PanCode works without them and only uses one when it is present.
Each is pinned to an exact upstream version and checksum, and a copy already on
PATH wins over PanCode's own as long as it clears the pinned minimum.

Commands:
  pancode programs list [--json]           the pinned table, the components, and where each resolves
  pancode programs status <id> [--json]    one tool or component in detail
  pancode programs reset-profile <id> [--json]  regenerate a tool's PanCode profile on next
                                              open (yazi)
  pancode programs install claude-sdk      provision the separate Claude SDK component
  pancode programs install copilot-sdk     provision the separate GitHub Copilot SDK component
  pancode programs install browser         provision the browser tool's playwright-core and headless shell
  pancode programs install <id> [--force] [--json]  download, verify, and vendor a tool
  pancode programs remove <id>|--all [--json]  delete every vendored version of a tool

Downloads happen only here. Nothing on a startup path fetches anything.

An install keeps one version directory per tool: once the pinned version is in
place, versions it superseded are pruned, along with any staging directory left
by an install that was killed. Removal touches nothing outside <data>/tools/<id>
and needs no confirmation, since every byte under it is re-downloadable from the
checksum-pinned registry. "remove --all" sweeps every tool in the table.
`;

/**
 * What `programs install` provisions besides the pinned programs: an npm package kept apart from PanCode's own
 * dependencies, in one directory per pinned version. `resolve` answers the path a session would load, null when
 * nothing is provisioned, and throws on an install that is present and broken.
 */
const COMPONENTS = [
	{
		id: "claude-sdk",
		package: CLAUDE_AGENT_SDK_PACKAGE,
		version: CLAUDE_AGENT_SDK_VERSION,
		resolve: resolveClaudeAgentSdkEntry,
	},
	{ id: "copilot-sdk", package: COPILOT_SDK_PACKAGE, version: COPILOT_SDK_VERSION, resolve: resolveCopilotSdkEntry },
	{
		id: "browser",
		package: PLAYWRIGHT_CORE_PACKAGE,
		version: PLAYWRIGHT_CORE_VERSION,
		resolve: () => resolveBrowserComponent()?.prefix ?? null,
	},
] as const;

function componentStatus(component: (typeof COMPONENTS)[number]) {
	const base = { id: component.id, kind: "component", package: component.package, version: component.version };
	const remedy = `pancode programs install ${component.id}`;
	try {
		const path = component.resolve();
		return path === null
			? { ...base, installed: false, path: null, remedy, detail: `not installed; run \`${remedy}\`` }
			: { ...base, installed: true, path, remedy: null, detail: path };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ...base, installed: false, path: null, remedy, detail: `broken install: ${reason}` };
	}
}

interface Parsed {
	command?: string;
	positional: string[];
	json: boolean;
	force: boolean;
	all: boolean;
	help: boolean;
}

/**
 * A usage error: the C3 diagnostic on stderr and, under `--json`, the C6
 * failure document on stdout. Every caller returns exit 2, as before.
 */
function usageFailure(command: string | undefined, slug: ErrorSlug, message: string, json: boolean): number {
	writeCliFailure({ path: command === undefined ? ["programs"] : ["programs", command], slug, message, json });
	return 2;
}

export async function runProgramsCommand(argv: ReadonlyArray<string> = []): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const command = argv.find((arg) => !arg.startsWith("-"));
		return usageFailure(command, "unknown_flag", message, argv.includes("--json"));
	}
	if (parsed.help || parsed.command === undefined) {
		// Bare `tools` keeps its v1 form, help on stdout and exit 2; C2's stderr
		// placement would change stdout.
		process.stdout.write(HELP);
		return parsed.help ? 0 : 2;
	}

	// `--all` belongs to `remove` alone. Silently ignoring it elsewhere would let
	// `programs install --all` read as a request that was honored.
	if (parsed.all && parsed.command !== "remove") {
		return usageFailure(parsed.command, "flag_conflict", "--all is only valid with `programs remove`", parsed.json);
	}

	switch (parsed.command) {
		case "list":
			return listTools(parsed.json);
		case "status":
			return statusTool(parsed.positional[0], parsed.json);
		case "reset-profile":
			if (parsed.force) {
				return usageFailure("reset-profile", "unknown_flag", "reset-profile takes only <id> and --json", parsed.json);
			}
			return resetProfile(parsed.positional, parsed.json);
		case "install":
			if (parsed.positional[0] === "claude-sdk") {
				if (parsed.force || parsed.positional.length !== 1) {
					return usageFailure(
						"install",
						"usage",
						"claude-sdk installation accepts no extra arguments or --force; pinned versions have separate locations.",
						parsed.json,
					);
				}
				try {
					const path = await installClaudeAgentSdk();
					if (parsed.json) process.stdout.write(`${JSON.stringify({ id: "claude-sdk", path })}\n`);
					else printOk(`Claude SDK component available at ${path}`);
					return 0;
				} catch (error) {
					printError(error instanceof Error ? error.message : String(error));
					return 1;
				}
			}
			if (parsed.positional[0] === "copilot-sdk") {
				if (parsed.force || parsed.positional.length !== 1) {
					return usageFailure(
						"install",
						"usage",
						"copilot-sdk installation accepts no extra arguments or --force; pinned versions have separate locations.",
						parsed.json,
					);
				}
				try {
					const path = await installCopilotSdk();
					if (parsed.json) process.stdout.write(`${JSON.stringify({ id: "copilot-sdk", path })}\n`);
					else printOk(`Copilot SDK component available at ${path}`);
					return 0;
				} catch (error) {
					printError(error instanceof Error ? error.message : String(error));
					return 1;
				}
			}
			if (parsed.positional[0] === "browser") {
				if (parsed.force || parsed.positional.length !== 1) {
					return usageFailure(
						"install",
						"usage",
						"browser installation accepts no extra arguments or --force; pinned versions have separate locations.",
						parsed.json,
					);
				}
				try {
					const component = await installBrowserComponent(
						parsed.json ? {} : { onProgress: (message) => process.stderr.write(`  ${message}\n`) },
					);
					if (parsed.json) process.stdout.write(`${JSON.stringify({ id: "browser", path: component.prefix })}\n`);
					else printOk(`Browser component available at ${component.prefix}`);
					return 0;
				} catch (error) {
					printError(error instanceof Error ? error.message : String(error));
					return 1;
				}
			}
			return installOne(parsed.positional[0], parsed.force, parsed.json);
		case "remove":
			return parsed.all ? removeAll(parsed.positional[0], parsed.json) : removeOne(parsed.positional[0], parsed.json);
		default:
			return usageFailure(undefined, "unknown_command", `unknown command: ${parsed.command}`, parsed.json);
	}
}

/**
 * `programs reset-profile <id>`: the state change `programs status --reset-profile`
 * used to make from a read verb (A-06). A new leaf, so it follows C7 from the
 * start: an id the registry does not know is `not_found`, exit 1.
 */
function resetProfile(positional: ReadonlyArray<string>, json: boolean): number {
	const [id, extra] = positional;
	if (id === undefined) return usageFailure("reset-profile", "usage", "name a tool: programs reset-profile <id>", json);
	if (extra !== undefined) return usageFailure("reset-profile", "usage", `unexpected argument: ${extra}`, json);
	if (findPinnedProgram(id) === null) {
		writeCliFailure({
			path: ["programs", "reset-profile"],
			slug: "not_found",
			message: `unknown tool: ${id} (known: ${PINNED_PROGRAMS.map((row) => row.id).join(", ")})`,
			json,
		});
		return 1;
	}
	if (id !== "yazi") return usageFailure("reset-profile", "usage", `${id} has no PanCode profile; only yazi does`, json);
	resetYaziProfile();
	const profile = inspectCurrentYaziProfile();
	if (json) {
		process.stdout.write(`${JSON.stringify({ version: 1, id, profileReset: true, profile })}\n`);
		return 0;
	}
	printOk("yazi profile reset; next open regenerates it");
	process.stdout.write(`  profile     ${describeYaziProfile(profile)}\n`);
	return 0;
}

function parse(argv: ReadonlyArray<string>): Parsed {
	const out: Parsed = { positional: [], json: false, force: false, all: false, help: false };
	for (const arg of argv) {
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--json":
				out.json = true;
				break;
			case "--force":
			case "-f":
				out.force = true;
				break;
			case "--all":
				out.all = true;
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
				out.positional.push(arg);
		}
	}
	return out;
}

function listTools(json: boolean): number {
	const statuses = programStatuses();
	const components = COMPONENTS.map(componentStatus);
	if (json) {
		process.stdout.write(`${JSON.stringify([...statuses.map(jsonShape), ...components], null, 2)}\n`);
		return 0;
	}
	const rows = statuses.map((status) => [
		status.id,
		status.version,
		status.license,
		status.resolution.source,
		describeResolution(status),
	]);
	process.stdout.write(formatColumns([["TOOL", "PIN", "LICENSE", "SOURCE", "RESOLVED"], ...rows]));
	process.stdout.write(
		`\n${formatColumns([
			["COMPONENT", "PIN", "PACKAGE", "RESOLVED"],
			...components.map((component) => [component.id, component.version, component.package, component.detail]),
		])}`,
	);
	return 0;
}

/**
 * The one refusal an unknown id gets, from every verb.
 *
 * It names the tools that do exist, because the whole error an operator makes
 * here is a name: `programs remove herd` and `programs remove tmux` want different
 * answers, and the registry list gives both of them one. The slug is
 * not_found, but the existing verbs keep exit 2 (v1 kept; C7's exit 1 needs a
 * versioned opt-in).
 */
function unknownTool(command: string, id: string, json: boolean): number {
	// Only the verbs that take a component name it among the ids that exist.
	const known = [...PINNED_PROGRAMS, ...(command === "remove" ? [] : COMPONENTS)].map((row) => row.id);
	writeCliFailure({
		path: ["programs", command],
		slug: "not_found",
		message: `unknown tool: ${id} (known: ${known.join(", ")})`,
		json,
	});
	return 2;
}

function statusTool(id: string | undefined, json: boolean): number {
	if (id === undefined) return usageFailure("status", "usage", "name a tool: programs status <id>", json);
	const entry = findPinnedProgram(id);
	if (entry === null) {
		const component = COMPONENTS.find((row) => row.id === id);
		if (component === undefined) return unknownTool("status", id, json);
		const found = componentStatus(component);
		if (json) process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
		else
			process.stdout.write(
				`${component.id} ${component.version}\n  package     ${component.package}\n  resolves to ${found.detail}\n`,
			);
		return 0;
	}
	const status = programStatus(entry);
	const profile = id === "yazi" ? inspectCurrentYaziProfile() : null;
	if (json) {
		process.stdout.write(`${JSON.stringify({ ...jsonShape(status), ...(profile ? { profile } : {}) }, null, 2)}\n`);
		return 0;
	}
	const rejection = describeFloorRejection(status);
	const installedVersions = installedProgramVersions(entry.id);
	const lines = [
		`${entry.id} ${entry.version} (${entry.license})`,
		`  ${entry.summary}`,
		`  homepage    ${entry.homepage}`,
		`  binaries    ${entry.binaries.join(", ")}`,
		`  PATH floor  ${entry.minimumVersion}`,
		`  platform    ${status.platform ?? `${process.platform}-${process.arch}`}${status.supported ? "" : " (no pinned asset)"}`,
		`  vendor dir  ${status.installDir}${status.installed ? "" : " (not installed)"}`,
		`  vendored    ${installedVersions.length === 0 ? "nothing" : installedVersions.join(", ")}`,
		`  resolves to ${describeResolution(status)}`,
		// Spelled out on its own line as well as inside the resolution sentence,
		// because a rejected PATH copy is the one thing an operator reads this
		// command to understand and the sentence above may be about something else.
		...(rejection === null
			? []
			: [
					`  floor       rejected: ${rejection}`,
					...(status.resolution.source === "none" && status.supported ? [`  remedy      ${installRemedy(entry.id)}`] : []),
				]),
		...(profile ? [`  profile     ${describeYaziProfile(profile)}`] : []),
	];
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

async function installOne(id: string | undefined, force: boolean, json: boolean): Promise<number> {
	if (id === undefined) return usageFailure("install", "usage", "name a tool: programs install <id>", json);
	if (findPinnedProgram(id) === null) {
		return unknownTool("install", id, json);
	}
	const result = await installProgram(id, {
		force,
		...(json ? {} : { onProgress: (message: string) => process.stderr.write(`  ${message}\n`) }),
	});
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return result.ok ? 0 : 1;
	}
	if (!result.ok) {
		printError(result.message);
		return 1;
	}
	printOk(result.message);
	for (const path of result.documents) process.stdout.write(`  license  ${path}\n`);
	return 0;
}

/**
 * Delete a tool's vendored install.
 *
 * The two answers an operator can act on are "there was nothing there" and
 * "these versions are gone", and both are exit 0: the state they asked for
 * holds either way. Only an id the registry does not know is a usage error,
 * because that is the one case where nothing was inspected at all.
 */
function removeOne(id: string | undefined, json: boolean): number {
	if (id === undefined) return usageFailure("remove", "usage", "name a tool: programs remove <id>, or --all", json);
	if (COMPONENTS.some((row) => row.id === id))
		return usageFailure(
			"remove",
			"usage",
			`${id} is a component under <data>/components; programs remove deletes vendored programs only`,
			json,
		);
	if (findPinnedProgram(id) === null) return unknownTool("remove", id, json);
	const result = removeProgram(id);
	if (json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return result.ok ? 0 : 1;
	}
	if (!result.ok) {
		printError(result.message);
		return 1;
	}
	printOk(result.message);
	if (result.removed.length > 0) {
		process.stdout.write(`  reinstall with \`${installRemedy(id)}\`\n`);
	}
	return 0;
}

/**
 * Delete every pinned tool's vendored install.
 *
 * Each tool is swept independently and the exit code is the worst of them, so
 * one directory that resists deletion does not hide the two that came off
 * cleanly. Tools that had nothing installed are counted rather than listed:
 * on the machine this verb is for, most of the registry is usually absent, and
 * three lines of "nothing to remove" would bury the one line that matters.
 */
function removeAll(id: string | undefined, json: boolean): number {
	if (id !== undefined) {
		return usageFailure(
			"remove",
			"flag_conflict",
			"`programs remove --all` takes no tool id; drop the id or drop --all",
			json,
		);
	}
	const results = PINNED_PROGRAMS.map((entry) => removeProgram(entry.id));
	if (json) {
		process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
		return results.every((result) => result.ok) ? 0 : 1;
	}
	for (const result of results) {
		if (!result.ok) printError(result.message);
		else if (result.removed.length > 0 || result.staleStaging.length > 0) printOk(result.message);
	}
	const touched = results.filter((result) => result.ok && result.removed.length > 0);
	const untouched = results.filter((result) => result.ok && result.removed.length === 0);
	if (touched.length > 0) {
		process.stdout.write(`  reinstall with \`pancode programs install <id>\`\n`);
	}
	if (untouched.length > 0) {
		process.stdout.write(`  ${untouched.length} of ${results.length} had nothing vendored\n`);
	}
	return results.every((result) => result.ok) ? 0 : 1;
}

/** The JSON surface, flattened so a script does not have to walk the resolution. */
function jsonShape(status: ProgramStatus): Record<string, unknown> {
	return {
		id: status.id,
		kind: "program",
		version: status.version,
		license: status.license,
		platform: status.platform,
		supported: status.supported,
		installed: status.installed,
		installDir: status.installDir,
		source: status.resolution.source,
		binaryPath: status.resolution.binaryPath,
		foundVersion: status.resolution.version,
		minimumVersion: status.resolution.entry?.minimumVersion ?? null,
		pathCandidate: status.resolution.pathCandidate,
		// A script deciding whether to warn about a floor rejection should not have
		// to parse `detail` for it, so the rejection and the command that answers
		// it are their own fields. `remedy` is null exactly where installing would
		// change nothing: already vendored, or no asset for this platform.
		floorRejection: describeFloorRejection(status),
		remedy: status.resolution.source === "none" && status.supported ? installRemedy(status.id) : null,
		installedVersions: installedProgramVersions(status.id),
		detail: describeResolution(status),
	};
}
