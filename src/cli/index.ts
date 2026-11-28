#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The process table is the only place an integrator can identify a running PanCode
// without sniffing script paths, and the bin name never reaches it because
// the entry is a node script. Set it before anything can fail so `--version` and
// a crashed boot are both legible to `ps`, `pgrep -f`, and htop. The title
// carries the version and build commit (`pancode 0.8.0-dev@67b3247`), so an
// orchestrator can verify which build a pane runs from outside the process.
process.title = "pancode";
try {
	process.title = pancodeProcessTitle();
} catch {
	// An unreadable package.json fails the boot below with its own message.
}

/**
 * A reader that closes early (`pancode agents | head -1`) ends the command with SIGPIPE status instead of
 * an unhandled EPIPE stack trace. Without a listener the same error would crash the process anyway, so this
 * changes only how it ends. `acp` and `worker` own their stdout errors; `run` handles them in `runPancodeRun`
 * (`handleRunStdoutErrors`), which cancels the turn and settles the session before exiting the same way.
 * `fleet run` alone among the fleet leaves guards its own pipe (`createFleetReporter`) so it can seal the run.
 */
function ownsStdoutErrors(command: string, subArgs: ReadonlyArray<string>): boolean {
	if (command === "acp" || command === "worker" || command === "run") return true;
	return command === "fleet" && subArgs.find((arg) => !arg.startsWith("-")) === "run";
}

/**
 * The run output format from a lexical argv scan, read before any parser loads: `--output-format json|stream-json`
 * makes the run's failures JSON documents, so their usage errors stay with run.js. Words after `--` are task text.
 */
function runWantsJsonOutput(args: ReadonlyArray<string>): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (arg === "--") return false;
		const format = arg === "--output-format" ? args[i + 1] : arg.startsWith("--output-format=") ? arg.slice(16) : null;
		if (format === "json" || format === "stream-json") return true;
	}
	return false;
}

function installHumanStdoutHandler(command: string, subArgs: ReadonlyArray<string>): void {
	if (ownsStdoutErrors(command, subArgs)) return;
	process.stdout.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") process.exit(141);
		throw error;
	});
}

import { markPancodeAgentProcess } from "../core/agent-environment.js";
import { pancodeProcessTitle } from "../core/build-info.js";

// Pi and other agent-aware developer tools use this generic marker to
// attribute subprocess activity without knowing PanCode-specific variables.
// Set it unconditionally so every child inherits the actual spawning agent.
// The inherited value is kept for lifecycle receipts before it is overwritten.
markPancodeAgentProcess();

// Only argument parsing and boot tracing load statically. Every subcommand is
// imported dynamically through the command registry (see `dispatch`), so a bare `pancode`
// (interactive) or `pancode --version` pays for its own module graph and nothing
// else — this is the highest-value cut of the cold module-load tax. Code
// splitting (tsup.config.ts) keeps each command's transitive heavy externals in
// its own chunk.
import { traceBoot } from "../core/boot-trace.js";
import { incompleteInstallationAdvice } from "../core/incomplete-installation.js";
import { installProxyFromEnv } from "../core/proxy-env.js";
import { extractGlobalFlags, parseFlags, printError } from "./argv.js";
import { didYouMean } from "./lib/did-you-mean.js";

const HELP = `PanCode command line

Systems software for coding agents.

Usage:
  pancode [options]            start interactive repository chat (options below)
  pancode run [flags] <task>   run one headless main-agent turn
  pancode acp                  serve PanCode as an ACP v1 agent over stdio
  pancode help [<command>] [--json]  one command's help, or the command manifest as JSON
  pancode schema <name>        print one published JSON schema
  pancode version [--json]     print the PanCode version (also --version, -v)

Sessions and fleet runs:
  pancode session <verb>       list, show, export, fork, compact, rename, rm or terminate sessions
  pancode fleet <verb>         run playbooks; list, wait on, verify, land or cancel runs; admission
  pancode playbook <verb>      list, author, validate, and graph playbooks
  pancode evidence list|inspect <runId>  list runs or inspect one run's sealed evidence
  pancode telemetry <verb>     read session and run telemetry, cost, quota and health

Setup:
  pancode configure            guided setup for targets, models and settings
  pancode targets              list configured targets, health, auth, and capabilities
  pancode models [search]      list models for configured targets
  pancode auth <verb>          list, check, log in to or log out of targets and runtimes
  pancode config inspect [--json]  inspect effective customization and provenance
  pancode doctor [--fix]       diagnose state; --fix creates or repairs it
  pancode paths|reset|uninstall|upgrade  directories, state recovery, removal, upgrade
  pancode gui                  open the alpha graphical application

Project and hub:
  pancode context <verb>       PANCODE.md, codemap, wiki and working set for this project
  pancode agents|tasks|verifiers|memory|claims|store  recipes, tasks, checks, memory, claims, store
  pancode hub|extensions|mcp|share  packs, extension authoring, MCP servers, archives
  pancode programs|interop|panes  pinned programs, external coding agents, the pane host
  pancode semantic             search
  pancode report|usage         reports to the maintainers, cross-session usage facts
  pancode <verb> [--json]      a verb an installed extension declares; built-in names always win

Interactive options:
  --resume, -r [id]  --continue, -c  --fork  --session-file <path>  --demo|--no-demo  --with-panes
  --autonomy default|yolo  --allow-tools|--deny-tools|--delegate-tools <names>  --max-context-tokens <N>
  --target <id>  --model <ref>  --api-key <key>  --skill <path>  --no-skills  --no-context-files, -nc

Run 'pancode <command> --help' for one command, 'pancode --help --all' for every command path.
`;

/** Commands that answer a question about PanCode itself rather than about the user's own work; only `dev` reaches them. */
const DEV_COMMANDS: ReadonlyArray<{ name: string; summary: string; run: (subArgs: string[]) => Promise<number> }> = [
	{
		name: "components",
		summary: "list, snapshot, or diff PanCode components",
		run: async (subArgs) => (await import("./components.js")).runComponentsCommand(subArgs),
	},
	{
		name: "evolve",
		summary: "create, validate, or summarize change manifests",
		run: async (subArgs) => (await import("./evolve.js")).runEvolveCommand(subArgs),
	},
	{
		name: "flywheel",
		summary: "sweep or forget bundles in the maintainers' local intake store",
		run: async (subArgs) => (await import("./flywheel.js")).runFlywheelCommand(subArgs),
	},
];

const DEV_HELP = `PanCode developer commands: its own components, change manifests and intake store

Usage:
${DEV_COMMANDS.map((entry) => `  pancode dev ${entry.name.padEnd(20)}${entry.summary}`).join("\n")}
`;

/**
 * `--help --all`: the root help, then every non-hidden command path, read from the light specs and the manifest
 * alone so it loads no command implementation.
 */
async function fullHelpText(): Promise<string> {
	const [{ COMMAND_SPECS }, { NESTED_LEAVES, TOP_LEVEL_USAGE }] = await Promise.all([
		import("./specs/table.js"),
		import("./specs/manifest.js"),
	]);
	const nested = new Map<string, { summary: string; usage: string }>();
	for (const [path, summary, usage] of NESTED_LEAVES) nested.set(path, { summary, usage });
	const listed: string[] = [];
	for (const [name, load] of Object.entries(COMMAND_SPECS)) {
		const module: { spec: { summary: string; hidden: boolean } } & Record<string, unknown> = await load();
		if (module.spec.hidden) continue;
		for (const list of [module.leaves, module.leafSpecs]) {
			if (!Array.isArray(list)) continue;
			for (const leaf of list as Array<{ path: string[]; summary: string; usage?: string }>) {
				const key = leaf.path.join(" ");
				nested.set(key, { summary: leaf.summary, usage: leaf.usage ?? nested.get(key)?.usage ?? key });
			}
		}
		const entries = [{ path: name, summary: module.spec.summary, usage: TOP_LEVEL_USAGE[name] ?? name }];
		for (const [path, leaf] of [...nested].sort(([a], [b]) => a.localeCompare(b))) {
			const words = path.split(" ");
			if (words[0] !== name) continue;
			entries.push({ path, summary: leaf.summary, usage: leaf.usage.length > 0 ? leaf.usage : path });
		}
		// A group and its leaves can share one usage line (`config inspect`, `tasks hand|done|drop`); print it once.
		const printed = new Set<string>();
		for (const entry of entries) {
			if (printed.has(entry.usage)) continue;
			printed.add(entry.usage);
			listed.push(...wrapUsage(`  pancode ${entry.usage}`));
			if (entry.summary.length > 0) listed.push(`      ${entry.summary}`);
		}
	}
	return `${HELP}\nEvery command path:\n${listed.join("\n")}\n`;
}

const HELP_ALL_WIDTH = 100;

/** Breaks a long synopsis before a flag or bracket group so lines stay within HELP_ALL_WIDTH; continuations indent. */
function wrapUsage(line: string): string[] {
	if (line.length <= HELP_ALL_WIDTH) return [line];
	// A unit is a flag with its value, or a whole bracket group; a line only breaks between units.
	const units: string[] = [];
	let depth = 0;
	for (const word of line.trimStart().split(" ")) {
		if (units.length > 0 && depth === 0 && /^[[(-]/u.test(word)) units.push(word);
		else if (units.length > 0) units[units.length - 1] += ` ${word}`;
		else units.push(word);
		for (const char of word) {
			if (char === "[" || char === "(") depth += 1;
			else if ((char === "]" || char === ")") && depth > 0) depth -= 1;
		}
	}
	const lines: string[] = [];
	let current = "  ";
	for (const unit of units) {
		if (current.trim().length > 0 && current.length + 1 + unit.length > HELP_ALL_WIDTH) {
			lines.push(current);
			current = `          ${unit}`;
		} else current = current.trim().length > 0 ? `${current} ${unit}` : `${current}${unit}`;
	}
	lines.push(current);
	return lines;
}

/** Engines floor from package.json; npm only warns on EBADENGINE, so the CLI
 * states the requirement itself instead of failing with an arbitrary syntax
 * or API error on old Node versions. */
const MIN_NODE = [22, 19, 0] as const;

interface CliBootOptions {
	apiKey?: string;
	noContextFiles?: boolean;
	noSkills?: boolean;
	skillPaths?: string[];
	panes?: "with";
}

/**
 * Commands whose handler reads the boot options. Every other command used to
 * receive them and drop them, so `pancode --api-key K fleet run` ran on the
 * configured key with no word said. The panes flag belongs to the interactive
 * session alone: neither `run` nor `acp` reads them.
 */
const BOOT_OPTION_COMMANDS: ReadonlySet<string> = new Set(["run", "acp"]);
const PANES_FLAGS: ReadonlySet<string> = new Set(["--with-panes"]);

function formatUnhonoredBootFlag(command: string, bootFlags: ReadonlyArray<string>): string | null {
	for (const flag of bootFlags) {
		if (PANES_FLAGS.has(flag)) {
			return `${flag} applies only to the interactive session; pancode ${command} does not honor it.`;
		}
		if (!BOOT_OPTION_COMMANDS.has(command)) {
			return `${flag} applies only to the interactive session, pancode run, and pancode acp; pancode ${command} does not honor it.`;
		}
	}
	return null;
}

/** The refusal for the first boot flag `command` cannot honor, or null when it honors them all. */
function unhonoredBootFlag(command: string | undefined, bootFlags: ReadonlyArray<string>): string | null {
	if (command === undefined || !COMMAND_HANDLERS.has(command) || command === "dev") return null;
	return formatUnhonoredBootFlag(command, bootFlags);
}

type CommandHandler = (subArgs: string[], bootOptions: CliBootOptions) => Promise<number>;

function nodeVersionError(): { message: string; detail: string } | null {
	const parts = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
	for (let i = 0; i < MIN_NODE.length; i += 1) {
		const actual = parts[i] ?? 0;
		const wanted = MIN_NODE[i] ?? 0;
		if (actual > wanted) return null;
		if (actual < wanted) {
			return {
				message: `PanCode requires Node.js >=${MIN_NODE.join(".")}; this is ${process.versions.node}.`,
				detail:
					"Distro and cluster module Node builds are often older. Install PanCode with its own Node, no root needed: curl -fsSL https://pancode.dev/install.sh | sh. Or set PANCODE_NODE to a Node 22.19+ binary, or install one with nvm, fnm or conda-forge and reinstall with its npm.",
			};
		}
	}
	return null;
}

async function main(argv: string[]): Promise<number> {
	// First application statement after the static import graph resolved: the
	// elapsed here is the cold module-load tax (see PANCODE_TRACE_BOOT).
	traceBoot("cli entry");
	const versionError = nodeVersionError();
	if (versionError !== null) {
		printError(versionError.message, versionError.detail);
		return 1;
	}
	await installProxyFromEnv();
	const {
		apiKey,
		noContextFiles,
		noSkills,
		skillPaths,
		panes,
		demo,
		autonomy,
		toolLimits,
		sessionFile,
		maxContextTokens,
		resume,
		route,
		bootFlags,
		rootFlags,
		rest,
		error: globalFlagError,
	} = extractGlobalFlags(argv, isCommandToken);
	if (globalFlagError) {
		printError(globalFlagError);
		return 2;
	}
	const { positional } = parseFlags(rest);
	const subcommand = positional[0];
	const subcommandIndex = rest.findIndex((arg) => !arg.startsWith("-"));
	// Only flags before the subcommand are global: `run -- -v` is a prompt and
	// `paths -v` is the command's own unknown flag, not a version request.
	const root = new Set(rootFlags);
	// The root answers write before `dispatch`, so they guard their own pipe; `help` reaches this path in a child.
	if (root.has("--help") || root.has("-h")) {
		installHumanStdoutHandler("help", []);
		process.stdout.write(root.has("--all") ? await fullHelpText() : HELP);
		return 0;
	}
	if (root.has("--version") || root.has("-v")) {
		installHumanStdoutHandler("version", []);
		const { runVersionCommand } = await import("./version.js");
		return runVersionCommand();
	}

	const subArgs = subcommandIndex === -1 ? [] : rest.slice(subcommandIndex + 1);
	const bootOptions = {
		...(apiKey === undefined ? {} : { apiKey }),
		...(noContextFiles ? { noContextFiles: true } : {}),
		...(noSkills ? { noSkills: true } : {}),
		...(skillPaths.length > 0 ? { skillPaths } : {}),
		...(panes === undefined ? {} : { panes }),
	};
	if (demo !== undefined && subcommand) {
		printError("--demo and --no-demo apply to interactive sessions only; start pancode without a subcommand.");
		return 2;
	}
	if (autonomy !== undefined && subcommand) {
		// Silently dropping a safety level would be worse than refusing it.
		printError(
			subcommand === "acp"
				? `--autonomy before a subcommand applies to the interactive session only; pass it after it: pancode acp --autonomy ${autonomy}`
				: `--autonomy before a subcommand applies to the interactive session only. For a headless turn use: pancode run --autonomy ${autonomy} "<task>"`,
		);
		return 2;
	}
	if (toolLimits !== undefined && subcommand) {
		// A dropped tool limit would widen what the operator meant to allow.
		printError(
			subcommand === "run" || subcommand === "acp"
				? `--allow-tools, --deny-tools and --delegate-tools before a subcommand apply to the interactive session only; pass them after it: pancode ${subcommand} --allow-tools <names>`
				: `--allow-tools, --deny-tools and --delegate-tools apply to the interactive session, pancode run, and pancode acp; pancode ${subcommand} does not honor them.`,
		);
		return 2;
	}
	if (sessionFile !== undefined && subcommand) {
		printError("--session-file applies to the interactive session only; start pancode without a subcommand.");
		return 2;
	}
	if (resume !== undefined && subcommand) {
		printError(
			subcommand === "run"
				? "--resume and --continue apply to the interactive session only; for a headless turn pass them after run: pancode run --resume <id> or pancode run --continue"
				: "--resume and --continue apply to the interactive session only; start pancode without a subcommand.",
		);
		return 2;
	}
	if (maxContextTokens !== undefined && subcommand) {
		printError(
			subcommand === "run"
				? `--max-context-tokens before a subcommand applies to the interactive session only; pass it after it: pancode run --max-context-tokens ${maxContextTokens} "<task>"`
				: `--max-context-tokens applies to the interactive session and pancode run; pancode ${subcommand} does not honor it.`,
		);
		return 2;
	}
	if (route !== undefined && subcommand) {
		const flags = [
			...(route.target === undefined ? [] : [`--target ${route.target}`]),
			...(route.model === undefined ? [] : [`--model ${route.model}`]),
		].join(" ");
		printError(
			subcommand === "run"
				? `${flags} before a subcommand applies to the interactive session only; pass it after it: pancode run ${flags} "<task>"`
				: `--target and --model before a subcommand apply to the interactive session only; pancode ${subcommand} does not honor them.`,
		);
		return 2;
	}
	if (route?.target !== undefined) {
		const { explicitTargetMissing } = await import("./run.js");
		if (explicitTargetMissing(route.target)) {
			printError(`target '${route.target}' not found in settings.targets`, "pancode targets lists the configured ones.");
			return 2;
		}
	}
	// A `dev` command is judged by the command it names, which is the one that
	// would have received and dropped the options.
	const refusal = unhonoredBootFlag(subcommand === "dev" ? subArgs[0] : subcommand, bootFlags);
	if (refusal !== null) {
		printError(refusal);
		return 2;
	}
	if (!subcommand) {
		await enableBootCompileCache();
		const { runPancodeCommand } = await import("./pancode.js");
		return runPancodeCommand({
			...bootOptions,
			...(demo === undefined ? {} : { demo }),
			...(autonomy === undefined ? {} : { autonomy }),
			...(toolLimits === undefined ? {} : { toolLimits }),
			...(sessionFile === undefined ? {} : { sessionFile }),
			...(maxContextTokens === undefined ? {} : { maxContextTokens }),
			...(resume === undefined ? {} : { resume }),
			...(route === undefined ? {} : { route }),
		});
	}

	return dispatch(subcommand, subArgs, bootOptions, bootFlags);
}

/**
 * Cache the boot-path module graphs' bytecode. Only the three long-lived
 * entrypoints that already write state enable it (interactive, `run`, `acp`);
 * read-only and dry-run commands such as `paths` and bare `doctor` document
 * that they create nothing, and enabling the cache creates its directory, so
 * a dispatch-wide enable would break that promise on every initialized home.
 * A help invocation of a boot command is itself zero-side-effect, so the
 * guard runs before enablement, not after the module's own help check.
 */
async function enableBootCompileCache(subArgs: ReadonlyArray<string> = []): Promise<void> {
	const end = subArgs.indexOf("--");
	const options = end === -1 ? subArgs : subArgs.slice(0, end);
	if (options.includes("--help") || options.includes("-h")) return;
	const { enablePancodeCompileCache } = await import("../core/compile-cache.js");
	enablePancodeCompileCache();
}

/**
 * The dispatcher is also the command-recognition source used by top-level
 * value flags. Every dynamic import stays a literal so tsup can split command
 * graphs, while adding a command in one place cannot leave --api-key/--skill
 * free to swallow it as a value.
 */
const COMMAND_HANDLERS = new Map<string, CommandHandler>([
	[
		"acp",
		async (subArgs, bootOptions) => {
			await enableBootCompileCache(subArgs);
			return (await import("./acp.js")).runAcpCommand(subArgs, bootOptions);
		},
	],
	["auth", async (subArgs) => (await import("./auth.js")).runAuthCommand(subArgs)],
	["config", async (subArgs) => (await import("./config.js")).runConfigCommand(subArgs)],
	["configure", async (subArgs) => (await import("./configure.js")).runConfigureCommand(subArgs)],
	["targets", async (subArgs) => (await import("./targets.js")).runTargetsCommand(subArgs)],
	["models", async (subArgs) => (await import("./models.js")).runModelsCommand(subArgs)],
	["agents", async (subArgs) => (await import("./agents.js")).runAgentsCommand(subArgs)],
	["evidence", async (subArgs) => (await import("./evidence.js")).runEvidenceCommand(subArgs)],
	["memory", async (subArgs) => (await import("./memory.js")).runMemoryCommand(subArgs)],
	["claims", async (subArgs) => (await import("./claims.js")).runClaimsCommand(subArgs)],
	["semantic", async (subArgs) => (await import("./semantic.js")).runSemanticCommand(subArgs)],
	["usage", async (subArgs) => (await import("./usage.js")).runUsageCommand(subArgs)],
	["telemetry", async (subArgs) => (await import("./telemetry.js")).runTelemetryCommand(subArgs)],
	["report", async (subArgs) => (await import("./report.js")).runReport(subArgs)],
	["session", async (subArgs) => (await import("./session.js")).runSessionCommand(subArgs)],
	["systemone", async (subArgs) => (await import("./system-one.js")).runSystemOneCommand(subArgs)],
	[
		"dev",
		async (subArgs) => {
			const devSubcommand = subArgs[0];
			// `pancode dev` is what `--help --all` tells the user to run for this
			// listing, so printing the listing is the command succeeding, not a
			// usage error.
			if (devSubcommand === undefined || devSubcommand === "--help" || devSubcommand === "-h") {
				process.stdout.write(DEV_HELP);
				return 0;
			}
			const command = DEV_COMMANDS.find((entry) => entry.name === devSubcommand);
			if (command === undefined) {
				printError(`unknown dev command: ${devSubcommand}`);
				process.stdout.write(DEV_HELP);
				return 2;
			}
			return command.run(subArgs.slice(1));
		},
	],
	["extensions", async (subArgs) => (await import("./extensions.js")).runExtensionsCommand(subArgs)],
	[
		"fleet",
		async (subArgs) => {
			if (subArgs[0] === "nodes") return (await import("./fleet-nodes.js")).runFleetNodes(subArgs.slice(1));
			if (subArgs[0] === "land") return (await import("./fleet-land.js")).runFleetLand(subArgs.slice(1));
			// The group help answers from a leaf, before fleet.js and its domain graph load.
			const help = (await import("./fleet-help.js")).answerFleetHelp(subArgs);
			if (help !== null) return help;
			// Status answers from a leaf too, ledger rows and their run journals included.
			if (subArgs[0] === "status") return (await import("./fleet-status.js")).runFleetStatus(subArgs.slice(1));
			return (await import("./fleet.js")).runFleetCommand(subArgs);
		},
	],
	["playbook", async (subArgs) => (await import("./playbook.js")).runPlaybookCommand(subArgs)],
	["hub", async (subArgs) => (await import("./hub.js")).runHubCommand(subArgs)],
	["tasks", async (subArgs) => (await import("./tasks.js")).runTasksCommand(subArgs)],
	["mcp", async (subArgs) => (await import("./mcp.js")).runMcpCommand(subArgs)],
	["store", async (subArgs) => (await import("./store.js")).runStoreCommand(subArgs)],
	["verifiers", async (subArgs) => (await import("./verifiers.js")).runVerifiersCommand(subArgs)],
	["gui", async (subArgs) => (await import("./gui.js")).runGuiCommand(subArgs)],
	["share", async (subArgs) => (await import("./share.js")).runShareCommand(subArgs)],
	["context", async (subArgs) => (await import("./context.js")).runContextCommand(subArgs)],
	[
		"run",
		async (subArgs, bootOptions) => {
			const runHelp = await import("./run-help.js");
			const help = runHelp.answerRunHelp(subArgs);
			if (help !== null) return help;
			if (!runWantsJsonOutput(subArgs)) {
				// Text mode refuses usage errors here, from the light parser, before run.js and its graph load.
				// JSON modes go on to run.js, whose writer frames the same refusal as a result document.
				const { parseRunCliArgs } = await import("./args.js");
				const { diagnostics } = parseRunCliArgs(subArgs);
				if (diagnostics.some((diagnostic) => diagnostic.type === "error")) {
					for (const diagnostic of diagnostics) process.stderr.write(`pancode run: ${diagnostic.message}\n`);
					process.stderr.write(runHelp.RUN_USAGE);
					return 2;
				}
			}
			await enableBootCompileCache(subArgs);
			return (await import("./run.js")).runPancodeRun(subArgs, bootOptions);
		},
	],
	["programs", async (subArgs) => (await import("./programs.js")).runProgramsCommand(subArgs)],
	["interop", async (subArgs) => (await import("./interop.js")).runInteropCommand(subArgs)],
	["panes", async (subArgs) => (await import("./panes.js")).runPanesCommand(subArgs)],
	["doctor", async (subArgs) => (await import("./doctor.js")).runDoctorCommand(subArgs)],
	["paths", async (subArgs) => (await import("./paths.js")).runPathsCommand(subArgs)],
	// Hidden: the installers' closing message.
	["setup", async (subArgs) => (await import("./setup-next.js")).runSetupCommand(subArgs)],
	["reset", async (subArgs) => (await import("./reset.js")).runResetCommand(subArgs)],
	["uninstall", async (subArgs) => (await import("./uninstall.js")).runUninstallCommand(subArgs)],
	["upgrade", async (subArgs) => (await import("./upgrade.js")).runUpgradeCommand(subArgs)],
	["version", async (subArgs) => (await import("./version.js")).runVersionCommand(subArgs)],
	["help", async (subArgs) => (await import("./help-command.js")).runHelpCommand(subArgs)],
	["schema", async (subArgs) => (await import("./schema.js")).runSchemaCommand(subArgs)],
	[
		"worker",
		async (subArgs) => {
			if (subArgs.includes("--help") || subArgs.includes("-h")) {
				process.stdout.write(
					"usage: pancode worker\n  internal: reads one WorkerSpec on stdin and streams NDJSON events on stdout\n",
				);
				return 0;
			}
			// Internal: the native worker stream server (WorkerSpec on stdin,
			// NDJSON on stdout). The entry module runs main() on import and owns
			// process exit; this settles only on a pre-run import failure.
			// This is how SSH placement launches a worker on the remote install,
			// where no local spawn boundary injected NODE_COMPILE_CACHE, so the
			// worker graph enables the remote cache itself before it loads. The
			// enable is in-process only: no environment variable is set, so the
			// worker's own children inherit nothing. Nothing on this path
			// injected the provenance pair either, so any marker present is
			// foreign; strip it (and only it) so the entry's consume can never
			// match and delete an operator's own NODE_COMPILE_CACHE.
			Reflect.deleteProperty(process.env, "PANCODE_INJECTED_COMPILE_CACHE");
			await enableBootCompileCache();
			await import("../worker/entry.js");
			return 0;
		},
	],
]);

function isCommandToken(token: string): boolean {
	return COMMAND_HANDLERS.has(token);
}

/**
 * Turn a missing command chunk into a repair instruction.
 *
 * Every subcommand is a dynamic import of a code-split chunk beside this
 * entry, so an install that was interrupted between unpacking the entry and
 * unpacking the rest produces a `pancode` that starts, parses flags, prints
 * `--version`, and then dies on `Cannot find module` the moment it is asked to
 * do anything. That message names an internal build artifact nobody outside
 * this repository can act on. The filter on our own output directory keeps a
 * module error raised by a user's extension or hook reporting itself normally.
 */
/**
 * Route a subcommand to its registered handler, importing only that command's
 * module. Unknown names fail before loading any command graph.
 */
async function dispatch(
	subcommand: string,
	subArgs: string[],
	bootOptions: CliBootOptions,
	bootFlags: ReadonlyArray<string>,
): Promise<number> {
	const handler = COMMAND_HANDLERS.get(subcommand);
	if (handler) {
		installHumanStdoutHandler(subcommand, subArgs);
		try {
			return await handler(subArgs, bootOptions);
		} catch (err) {
			const advice = incompleteInstallationAdvice(err);
			if (advice === null) throw err;
			printError(advice);
			return 1;
		}
	}
	// Task text where a command belongs (`pancode "fix the bug"`) is the common bare-text mistake.
	const bareText = /\s/.test(subcommand.trim());
	// Built-in names always win; an installed extension's verb answers only a name nothing else claims.
	if (!bareText && /^[a-z][a-z0-9-]*$/u.test(subcommand)) {
		installHumanStdoutHandler(subcommand, subArgs);
		const code = await (await import("./extensions.js")).runPackVerb(
			subcommand,
			subArgs,
			formatUnhonoredBootFlag(subcommand, bootFlags),
		);
		if (code !== null) return code;
	}
	printError(
		bareText
			? `unknown subcommand: ${subcommand}; for one headless task use pancode run "<task>"`
			: `unknown subcommand: ${subcommand}${didYouMean(subcommand, COMMAND_HANDLERS.keys())}`,
	);
	process.stderr.write("Run 'pancode --help' for the commands.\n");
	return 2;
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch(async (err) => {
		const reported = (err as { reportedSummary?: unknown } | null)?.reportedSummary;
		printError(typeof reported === "string" ? reported : err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
		// A usage error is the caller's, not a crash; anything else leaves a record the next session can offer to report.
		if (!/UsageError$/u.test((err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "")) {
			try {
				(await import("../domains/report/crash.js")).writeCrashRecord(err, "cli");
			} catch {
				// The record is best effort; the exit status above stands.
			}
		}
	});
