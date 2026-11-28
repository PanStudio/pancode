// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionCliPathDeclaration } from "@pancode/sdk/pack";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { readLayeredSettings } from "../core/settings-layers.js";
import { approveOperatorProjectInstall, captureProjectInstallBaseline } from "../core/workspace-trust.js";
import { pancodeConfigDir } from "../core/xdg.js";
import { envelopeReviewLines, reviewExtensionEnvelope } from "../domains/extensions/envelope-review.js";
import { assignExtensionServiceModel, createExtensionHostServices } from "../domains/extensions/host-services.js";
import {
	assignExtensionModel,
	disableExtension,
	discoverExtensionPackages,
	type ExtensionDiagnostic,
	type ExtensionScope,
	enableExtension,
	type InstalledExtension,
	installExtension,
	listInstalledExtensions,
	readExtensionInstallRecord,
	removeExtension,
	syncPackBinaries,
} from "../domains/extensions/index.js";
import { extensionInvocation } from "../domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import type { ResolvedPathGrant } from "../domains/extensions/path-grants.js";
import {
	createWriteRoots,
	PathGrantError,
	releaseCreatedRoots,
	resolvePathGrants,
} from "../domains/extensions/path-grants.js";
import type { ExtensionWorkOptions } from "../domains/extensions/services/work.js";
import { bundledPluginCatalog } from "../domains/plugins/catalog.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { formatColumns, printError, printOk } from "./argv.js";
import { installStopSignals } from "./stop-signals.js";

const HELP = `pancode extensions <command>

Manage PanCode extension packages.

Commands:
  pancode extensions init <id> [--template status|hook|panel|tool|workspace] [--dir <path>]
  pancode extensions validate <path> [--json]
  pancode extensions test <path>
  pancode extensions view --watch <frame-file> [--dock-taps <tap-file>]
  pancode extensions list [--all] [--json] [--user|--project]
  pancode extensions discover <path> [--json]
  pancode extensions run <id> <command> [--json] -- [arguments]
  pancode extensions install <path> [--user|--project] [--force] [--json]
  pancode extensions enable <id> [--user|--project] [--json]
  pancode extensions disable <id> [--user|--project] [--json]
  pancode extensions remove <id> [--user|--project] [--json]
  pancode extensions services <id> [--model <target>/<model> [--session-tokens <n>] | --clear] [--user|--project] [--json]

services shows or sets the model an extension's completions go to. --model records the endpoint the target
resolves to now; a call made after it changes is refused until the model is assigned again. --session-tokens
lowers the token budget the extension declared for one session.
`;

interface Parsed {
	command?: string;
	positional: string[];
	scope?: ExtensionScope;
	json: boolean;
	all: boolean;
	force: boolean;
	help: boolean;
	model?: string;
	sessionTokens?: number;
	clear: boolean;
}

function parse(argv: ReadonlyArray<string>): Parsed {
	const out: Parsed = { positional: [], json: false, all: false, force: false, help: false, clear: false };
	let argumentsOnly = false;
	let valueFor: "--model" | "--session-tokens" | undefined;
	for (const arg of argv) {
		if (valueFor === "--model") {
			out.model = arg;
			valueFor = undefined;
			continue;
		}
		if (valueFor === "--session-tokens") {
			const tokens = Number(arg);
			if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error("--session-tokens takes a positive integer");
			out.sessionTokens = tokens;
			valueFor = undefined;
			continue;
		}
		if (argumentsOnly) {
			out.positional.push(arg);
			continue;
		}
		if (arg === "--") {
			argumentsOnly = true;
			continue;
		}
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--json":
				out.json = true;
				break;
			case "--all":
				out.all = true;
				break;
			case "--force":
			case "-f":
				out.force = true;
				break;
			case "--user":
				if (out.scope && out.scope !== "user") throw new Error("--user and --project are mutually exclusive");
				out.scope = "user";
				break;
			case "--project":
				if (out.scope && out.scope !== "project") throw new Error("--user and --project are mutually exclusive");
				out.scope = "project";
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--model":
			case "--session-tokens":
				valueFor = arg;
				break;
			case "--clear":
				out.clear = true;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
				out.positional.push(arg);
		}
	}
	if (valueFor) throw new Error(`${valueFor} needs a value`);
	return out;
}

function hasErrors(diagnostics: ReadonlyArray<ExtensionDiagnostic>): boolean {
	return diagnostics.some((diag) => diag.type === "error");
}

function printDiagnostics(diagnostics: ReadonlyArray<ExtensionDiagnostic>): void {
	for (const diag of diagnostics) {
		const detail = diag.path ? `${diag.message}: ${diag.path}` : diag.message;
		if (diag.type === "error") printError(detail);
		else process.stderr.write(`warning: ${detail}\n`);
	}
}

function toolSummary(extension: InstalledExtension): string {
	// An api-2 extension declares its tools on its runtime, not in capabilities (bt-20 papercut 3).
	const tools = [
		...(extension.capabilities?.tools.map((tool) => tool.name) ?? []),
		...(extension.runtimeV2?.tools.map((tool) => tool.name) ?? []),
	];
	return tools.length > 0 ? [...new Set(tools)].join(",") : "-";
}

function stateLabel(extension: InstalledExtension): string {
	if (!extension.valid) return "invalid";
	if (!extension.compatible) return "incompatible";
	if (!extension.enabled) return "disabled";
	if (extension.trustBlocked) return "untrusted";
	if (!extension.effective) return `shadowed:${extension.overriddenBy ?? "higher"}`;
	return extension.loadable ? "eligible" : "inactive";
}

function printList(items: ReadonlyArray<InstalledExtension>): void {
	if (items.length === 0) {
		process.stdout.write("extensions: none\n");
		return;
	}
	process.stdout.write(
		`${formatColumns([
			["id", "scope", "plugin", "state", "version", "tools", "description"],
			...items.map((extension) => [
				extension.id,
				extension.scope,
				extension.plugin ?? "-",
				stateLabel(extension),
				extension.version,
				toolSummary(extension),
				extension.description,
			]),
		])}\n`,
	);
}

export function runExtensionsCommand(argv: ReadonlyArray<string>): number | Promise<number> {
	if (argv[0] === "view") {
		return viewCommand(argv.slice(1));
	}
	if (argv[0] === "init" || argv[0] === "validate" || argv[0] === "test") return authoringCommand(argv);
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	// A bare `pancode extensions` is a missing required argument, which the
	// exit-code contract puts at 2 with the usage on stderr. It used to print the
	// same help `--help` prints and exit 0, so a CI step gated on it went on to
	// the next line; `memory`, `evidence`, and `usage` all already answered 2
	// here.
	if (!parsed.command) {
		process.stderr.write(HELP);
		return 2;
	}
	const scopeOptions = { ...(parsed.scope ? { scope: parsed.scope } : {}) };
	switch (parsed.command) {
		case "run":
			return runOperatorCommand(parsed);
		case "services":
			return servicesCommand(parsed);
		case "list": {
			const items = listInstalledExtensions(process.cwd(), { ...scopeOptions, all: parsed.all });
			if (parsed.json) process.stdout.write(`${JSON.stringify({ extensions: items }, null, 2)}\n`);
			else {
				printList(items);
				for (const item of items) printDiagnostics(item.diagnostics);
			}
			return 0;
		}
		case "discover": {
			const root = parsed.positional[0];
			if (!root || parsed.positional.length !== 1) {
				process.stderr.write("usage: pancode extensions discover <path>\n");
				return 2;
			}
			const candidates = discoverExtensionPackages(resolve(root));
			if (parsed.json) process.stdout.write(`${JSON.stringify({ candidates }, null, 2)}\n`);
			else {
				for (const candidate of candidates) {
					const label = candidate.manifest ? `${candidate.manifest.id}@${candidate.manifest.version}` : candidate.path;
					process.stdout.write(`${candidate.valid ? "ok" : "invalid"}  ${label}  ${candidate.path}\n`);
					printDiagnostics(candidate.diagnostics);
				}
			}
			return candidates.some((candidate) => !candidate.valid) ? 1 : 0;
		}
		case "install": {
			const root = parsed.positional[0];
			if (!root || parsed.positional.length !== 1) {
				process.stderr.write("usage: pancode extensions install <path> [--user|--project] [--force]\n");
				return 2;
			}
			const baseline = parsed.scope === "project" ? captureProjectInstallBaseline(process.cwd(), "extensions") : null;
			// Read from the manifest before the commit, so the operator sees what the package may do
			// ahead of the write. A package with no api 2 runtime has no envelope to show.
			const review = (() => {
				try {
					return reviewExtensionEnvelope(resolve(root));
				} catch {
					// An unreadable manifest is reported by the install itself.
					return null;
				}
			})();
			if (review && !parsed.json) {
				process.stdout.write(`${review.id} ${review.version} would be allowed to:\n`);
				for (const line of envelopeReviewLines(review)) process.stdout.write(`  ${line}\n`);
			}
			// The install applies the envelope just shown, or none when the package declares none.
			const result = installExtension(resolve(root), {
				...scopeOptions,
				force: parsed.force,
				expectedEnvelopeDigest: review?.digest ?? null,
			});
			const approved =
				baseline !== null &&
				result.extension !== undefined &&
				result.contentDigest !== undefined &&
				approveOperatorProjectInstall(process.cwd(), baseline, [
					{ id: result.extension.id, contentDigest: result.contentDigest },
				]);
			if (parsed.json)
				process.stdout.write(
					`${JSON.stringify(review ? { ...result, envelope: review.envelope, envelopeDigest: review.digest } : result, null, 2)}\n`,
				);
			else {
				printDiagnostics(result.diagnostics);
				if (result.extension) {
					printOk(`installed ${result.extension.id} (${result.extension.scope})`);
					if (approved)
						process.stdout.write(
							"Project extensions were new or already approved here, so your install keeps them approved. Changes made outside your installs need pancode config trust extensions.\n",
						);
					else if (result.extension.scope === "project")
						process.stdout.write(
							"Project extensions are not approved for this workspace; review them with pancode config trust extensions.\n",
						);
				}
			}
			const code = hasErrors(result.diagnostics) ? 1 : 0;
			return result.extension ? withPackBinaries(result.extension.id, code, parsed.json) : code;
		}
		case "enable":
		case "disable": {
			const id = parsed.positional[0];
			if (!id || parsed.positional.length !== 1) {
				process.stderr.write(`usage: pancode extensions ${parsed.command} <id> [--user|--project]\n`);
				return 2;
			}
			const result = parsed.command === "enable" ? enableExtension(id, scopeOptions) : disableExtension(id, scopeOptions);
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (result.extension) printOk(`${parsed.command}d ${result.extension.id} (${result.extension.scope})`);
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		}
		case "remove": {
			const id = parsed.positional[0];
			if (!id || parsed.positional.length !== 1) {
				process.stderr.write("usage: pancode extensions remove <id> [--user|--project]\n");
				return 2;
			}
			const result = removeExtension(id, scopeOptions);
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (result.removed) printOk(`removed ${result.removed.id} (${result.removed.scope})`);
			}
			const code = hasErrors(result.diagnostics) ? 1 : 0;
			return result.removed ? withPackBinaries(result.removed.id, code, parsed.json) : code;
		}
		default:
			printError(`unknown extensions command: ${parsed.command}`);
			process.stderr.write(HELP);
			return 2;
	}
}

/** The committed install or removal stands; a pinned program that did not download fails the command. */
async function withPackBinaries(id: string, code: number, json: boolean): Promise<number> {
	const failures = await syncPackBinaries(id, process.cwd(), {
		onProgress: (message) => {
			if (!json) process.stderr.write(`${message}\n`);
		},
	});
	for (const failure of failures) printError(`a pinned program did not download: ${failure}`);
	return failures.length > 0 ? 1 : code;
}

async function runOperatorCommand(parsed: Parsed): Promise<number> {
	const [id, command, ...args] = parsed.positional;
	if (!id || !command || parsed.scope || parsed.force || parsed.all || parsed.model || parsed.clear) {
		process.stderr.write("usage: pancode extensions run <id> <command> [--json] -- [arguments]\n");
		return 2;
	}
	const selected = listInstalledExtensions(process.cwd(), { all: true }).find(
		(entry) => entry.id === id && entry.loadable,
	);
	if (!selected?.runtimeV2?.commands.some((entry) => entry.name === command)) {
		printError(`extension ${id} has no eligible operator command '${command}'`);
		return 1;
	}
	return runHeadlessCommand(id, command, args, { workspace: process.cwd(), wrap: parsed.json });
}

/** A top-level verb an installed extension declares, resolved only after every built-in command name missed. */
interface PackVerb {
	verb: string;
	extensionId: string;
	command: string;
	/** The flags whose values the operator grants the command as paths. */
	paths: ReadonlyArray<ExtensionCliPathDeclaration>;
}

/** The verbs installed, loadable extensions declare; a verb two extensions both claim is left out of both. */
function installedPackVerbs(workspace: string): { verbs: PackVerb[]; contested: Map<string, string[]> } {
	const claimed = new Map<string, PackVerb[]>();
	for (const entry of listInstalledExtensions(workspace, { all: true })) {
		if (!entry.loadable || !entry.runtimeV2?.cli) continue;
		for (const verb of entry.runtimeV2.cli) {
			const list = claimed.get(verb.verb) ?? [];
			list.push({ verb: verb.verb, extensionId: entry.id, command: verb.command, paths: verb.paths ?? [] });
			claimed.set(verb.verb, list);
		}
	}
	const verbs: PackVerb[] = [];
	const contested = new Map<string, string[]>();
	for (const [verb, list] of claimed) {
		if (list.length === 1 && list[0]) verbs.push(list[0]);
		else
			contested.set(
				verb,
				list.map((entry) => entry.extensionId),
			);
	}
	return { verbs: verbs.sort((a, b) => a.verb.localeCompare(b.verb)), contested };
}

/**
 * `--cwd <dir>` or `--cwd=<dir>` before `--`: the workspace a verb runs in, as every built-in command reads it. The
 * argument stays in the command's argv. Null when absent; a value that is no directory is an error.
 */
function verbWorkspace(argv: ReadonlyArray<string>): { dir: string } | { error: string } | null {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--") return null;
		const value = arg === "--cwd" ? argv[i + 1] : arg.startsWith("--cwd=") ? arg.slice("--cwd=".length) : undefined;
		if (value === undefined) continue;
		if (value.trim().length === 0) return { error: "--cwd requires a directory" };
		const dir = resolve(value);
		return statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true
			? { dir }
			: { error: `--cwd ${value}: not a directory` };
	}
	return null;
}

/**
 * `pancode <verb> [arguments]` for a verb an installed extension declares: its arguments, `--json` and `--help`
 * included, reach the command as `ctx.argv`, and its `text` and `stderr` reach standard output and standard error
 * as they are. Returns null when no extension declares the verb, so the caller reports an unknown subcommand.
 */
export async function runPackVerb(
	verb: string,
	argv: ReadonlyArray<string>,
	unhonoredBootFlagMessage?: string | null,
): Promise<number | null> {
	const cwd = verbWorkspace(argv);
	const workspace = cwd !== null && "dir" in cwd ? cwd.dir : process.cwd();
	const { verbs, contested } = installedPackVerbs(workspace);
	const owners = contested.get(verb);
	if (owners) {
		printError(
			`extensions ${owners.join(", ")} all declare the verb '${verb}'`,
			`pancode extensions run <id> <command> runs one of them.`,
		);
		return 2;
	}
	const found = verbs.find((entry) => entry.verb === verb);
	if (!found) {
		const absent = absentPackVerb(verb, workspace);
		if (absent === null) return null;
		process.stderr.write(`pancode ${verb}: ${absent}\n`);
		return 2;
	}
	if (unhonoredBootFlagMessage) {
		printError(unhonoredBootFlagMessage);
		return 2;
	}
	if (cwd !== null && "error" in cwd) {
		process.stderr.write(`pancode ${verb}: ${cwd.error}\nsee: pancode ${verb} --help\n`);
		return 2;
	}
	if (found.paths.length === 0)
		return runHeadlessCommand(found.extensionId, found.command, [...argv], { workspace, wrap: false, verb });
	let grants: ResolvedPathGrant[];
	let created: string[];
	try {
		grants = resolvePathGrants(found.paths, argv, workspace);
		created = createWriteRoots(grants);
	} catch (error) {
		if (!(error instanceof PathGrantError)) throw error;
		process.stderr.write(
			`pancode ${verb}: ${error.flag} ${error.value}: ${error.message}\nsee: pancode ${verb} --help\n`,
		);
		return 2;
	}
	try {
		return await runHeadlessCommand(found.extensionId, found.command, [...argv], {
			workspace,
			wrap: false,
			verb,
			grants,
		});
	} finally {
		releaseCreatedRoots(created);
	}
}

/**
 * Why a verb a known extension declares does not run: its installed copy is disabled or does not load, or the bundled
 * The hub index lists it and it is not installed. Null when no extension PanCode knows declares the verb.
 */
function absentPackVerb(verb: string, workspace: string): string | null {
	const installed = listInstalledExtensions(workspace, { all: true }).find((entry) =>
		entry.runtimeV2?.cli?.some((declared) => declared.verb === verb),
	);
	if (installed !== undefined)
		return installed.enabled
			? `extension:${installed.id} is installed but does not load; pancode extensions list shows why`
			: `extension:${installed.id} is disabled; pancode extensions enable ${installed.id} enables it`;
	const row = bundledPluginCatalog([]).find((entry) => entry.kind === "extension" && entry.verbs?.includes(verb));
	return row !== undefined
		? `extension:${row.name} is not installed; pancode hub install extension:${row.name} installs it`
		: null;
}

const withNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);

/**
 * Run one extension operator command with no session. Progress from a long command goes to stderr, one line
 * each; the output's exit code, when it sets one, becomes the process exit status. `wrap` prints the answer as
 * `extensions run --json` does. For a `verb`, the first SIGINT, SIGTERM or SIGHUP aborts the command's `ctx.signal`
 * and its answer is still printed before the process exits 130, 143 or 129; a second one stops waiting.
 */
async function runHeadlessCommand(
	id: string,
	command: string,
	args: string[],
	options: { workspace: string; wrap: boolean; verb?: string; grants?: ReadonlyArray<ResolvedPathGrant> },
): Promise<number> {
	const { workspace, verb, grants } = options;
	const services = cliServiceDomains();
	const runtime = new OperatorExtensions({
		...(grants !== undefined && grants.length > 0 ? { grants, work: { homes: await runHomes() } } : {}),
		services: createExtensionHostServices({ providers: services.providers }),
		// The layered read keeps a broken user file from failing the command; the key is user-layer only.
		sandboxUnixSockets: () => readLayeredSettings(workspace).settings.safety.sandboxUnixSockets,
		context: () => ({ workspace, sessionId: null, mode: "headless" }),
		isIdle: () => true,
		onlyId: id,
		onDiagnostic: (line) => process.stderr.write(`pancode: ${line}\n`),
	});
	const controller = new AbortController();
	const cancel = (): void => {
		controller.abort();
		void runtime.dispose();
	};
	const interrupt = new AbortController();
	const stops = verb !== undefined ? installStopSignals(interrupt, undefined, cancel) : undefined;
	if (stops === undefined) {
		process.once("SIGINT", cancel);
		process.once("SIGTERM", cancel);
	}
	try {
		const reload = await runtime.reload("startup");
		if (reload.status !== "committed") throw new Error(reload.message);
		const provenance = runtime.entries().find((entry) => entry.id === id && entry.state === "ready")?.provenance;
		const output = await runtime.invoke(
			extensionInvocation(id, command),
			args.join(" "),
			[],
			controller.signal,
			(text) => process.stderr.write(verb !== undefined ? `pancode ${verb}: ${text}\n` : `${text}\n`),
			{ argv: args, interrupt: interrupt.signal },
		);
		if (!provenance) throw new Error("extension result has no activated provenance");
		if (output.stderr) process.stderr.write(withNewline(output.stderr));
		if (options.wrap) {
			const generation = runtime.entries().find((entry) => entry.id === id)?.generation ?? reload.generation;
			process.stdout.write(`${JSON.stringify({ extensionId: id, command, generation, provenance, output })}\n`);
		} else if (verb !== undefined) {
			if (output.text.length > 0) process.stdout.write(withNewline(output.text));
		} else process.stdout.write(`${output.text}\n`);
		if (stops?.received() != null) return stops.exitCode();
		return output.exitCode ?? 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return stops?.received() != null ? stops.exitCode() : 1;
	} finally {
		stops?.dispose();
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
		await runtime.dispose();
		await services.stop();
	}
}

/**
 * How a run the command starts gets its own home: data, state and cache under it, beside the operator's config, and
 * the operator's installed components and vendored tools, which it reads and never installs into. Loaded only for a
 * verb the operator granted paths, since the readers pull in the session domain.
 */
export async function runHomes(): Promise<NonNullable<ExtensionWorkOptions["homes"]>> {
	const [
		{ OPERATOR_COMPONENTS_ENV, operatorComponentsDir },
		{ OPERATOR_PROGRAMS_ENV, operatorProgramsRoot },
		{ loadRunDigest },
	] = await Promise.all([
		import("../domains/install/components.js"),
		import("../lib/programs/paths.js"),
		import("../domains/session/run-digest.js"),
	]);
	return {
		env: (home) => ({
			PANCODE_CONFIG_DIR: pancodeConfigDir(),
			PANCODE_DATA_DIR: join(home, "data"),
			PANCODE_STATE_DIR: join(home, "state"),
			PANCODE_CACHE_DIR: join(home, "cache"),
			[OPERATOR_COMPONENTS_ENV]: operatorComponentsDir(),
			[OPERATOR_PROGRAMS_ENV]: operatorProgramsRoot(),
		}),
		digest: loadRunDigest,
	};
}

/** The domains a model call from a shell needs, loaded on first use: config, routes and the process journal. */
function cliServiceDomains(): { providers: () => Promise<ProvidersContract>; stop(): Promise<void> } {
	let loaded: Promise<LoadResult> | undefined;
	return {
		providers: async () => {
			loaded ??= (async () => {
				const [
					{ ConfigDomainModule },
					{ ProvidersDomainModule },
					{ SessionDomainModule },
					{ TelemetryDomainModule },
					{ ensurePancodeState },
				] = await Promise.all([
					import("../domains/config/module.js"),
					import("../domains/providers/module.js"),
					import("../domains/session/module.js"),
					import("../domains/telemetry/module.js"),
					import("../domains/install/index.js"),
				]);
				ensurePancodeState();
				return loadDomains([ConfigDomainModule, ProvidersDomainModule, SessionDomainModule, TelemetryDomainModule]);
			})();
			const providers = (await loaded).getContract("providers");
			if (!providers) throw new Error("model routes are unavailable: the providers domain did not load");
			return providers;
		},
		stop: async () => {
			if (loaded) await (await loaded).stop();
		},
	};
}

async function servicesCommand(parsed: Parsed): Promise<number> {
	const [id] = parsed.positional;
	if (
		!id ||
		parsed.positional.length !== 1 ||
		parsed.all ||
		parsed.force ||
		(parsed.clear && parsed.model !== undefined) ||
		(parsed.sessionTokens !== undefined && parsed.model === undefined)
	) {
		process.stderr.write(
			"usage: pancode extensions services <id> [--model <target>/<model> [--session-tokens <n>] | --clear] [--user|--project]\n",
		);
		return 2;
	}
	const cwd = process.cwd();
	const extension = listInstalledExtensions(cwd, { all: true }).find(
		(entry) => entry.id === id && (parsed.scope ? entry.scope === parsed.scope : entry.effective),
	);
	if (!extension || extension.scope === "dev") {
		printError(`extension ${id} is not installed${parsed.scope ? ` in ${parsed.scope} scope` : ""}`);
		return 1;
	}
	const declared = extension.runtimeV2?.services?.model;
	const location = { cwd, scope: extension.scope };
	if (parsed.model !== undefined) {
		const slash = parsed.model.indexOf("/");
		if (slash <= 0 || slash === parsed.model.length - 1) {
			printError("--model takes <target>/<model>");
			return 2;
		}
		if (!declared) {
			printError(`extension ${id} declares no runtime.services.model`);
			return 1;
		}
		const domains = cliServiceDomains();
		try {
			const result = assignExtensionServiceModel(
				await domains.providers(),
				{
					id,
					target: parsed.model.slice(0, slash),
					model: parsed.model.slice(slash + 1),
					declared: declared.sessionTokens,
					...(parsed.sessionTokens !== undefined ? { sessionTokens: parsed.sessionTokens } : {}),
				},
				location,
			);
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (!hasErrors(result.diagnostics))
					printOk(
						`${id} completions go to ${parsed.model} at ${result.endpoint}, up to ${parsed.sessionTokens ?? declared.sessionTokens} tokens a session`,
					);
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		} catch (error) {
			printError(error instanceof Error ? error.message : String(error));
			return 1;
		} finally {
			await domains.stop();
		}
	}
	if (parsed.clear) {
		const result = assignExtensionModel(id, null, location);
		if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else {
			printDiagnostics(result.diagnostics);
			if (!hasErrors(result.diagnostics)) printOk(`${id} has no model assigned; its completions are refused`);
		}
		return hasErrors(result.diagnostics) ? 1 : 0;
	}
	const assigned = readExtensionInstallRecord(id, location)?.services?.model;
	const store = extension.runtimeV2?.services?.store;
	if (parsed.json) {
		process.stdout.write(
			`${JSON.stringify({ id, scope: extension.scope, model: declared ?? null, assigned: assigned ?? null, store: store ?? null }, null, 2)}\n`,
		);
		return 0;
	}
	process.stdout.write(
		`${[
			`embedding: ${extension.runtimeV2?.services?.embedding ? "declared" : "not declared"}`,
			declared
				? assigned
					? `model: ${assigned.target}/${assigned.model} at ${assigned.endpoint}, up to ${Math.min(declared.sessionTokens, assigned.sessionTokens ?? declared.sessionTokens)} tokens a session, ${declared.maxOutputTokens} a reply (assigned ${assigned.assignedAt})`
					: `model: none assigned, so its completions are refused; assign one with pancode extensions services ${id} --model <target>/<model>`
				: "model: not declared",
			store
				? `store: reads ${[...store.read, ...store.write].join(", ")}; writes ${store.write.join(", ") || "none"}`
				: "store: not declared",
		].join("\n")}\n`,
	);
	return 0;
}

async function viewCommand(argv: ReadonlyArray<string>): Promise<number> {
	const { runExtensionsView } = await import("./extensions-view.js");
	return runExtensionsView(argv);
}

async function authoringCommand(argv: ReadonlyArray<string>): Promise<number> {
	const { runExtensionsAuthoring } = await import("./extensions-authoring.js");
	return runExtensionsAuthoring(argv);
}
