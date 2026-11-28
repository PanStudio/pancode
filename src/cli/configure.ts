// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { stdin as input, stdout as output } from "node:process";
import { readSettings, settingsPath } from "../core/config.js";
import { resolveSharedSettingsArea } from "../core/settings-areas.js";
import { openAuthStorage, targetRequiresAuth } from "../domains/providers/auth/index.js";
import {
	configuredTargetsForRuntime,
	describeRuntimeModels,
	listProviderSupportEntries,
	resolveRuntimeAuthTarget,
	supportGroupLabel,
} from "../domains/providers/index.js";
import { closestRuntimeId, getRuntimeRegistry } from "../domains/providers/registry.js";
import type { RuntimeDescriptor } from "../domains/providers/types/runtime-descriptor.js";
import { printError, printNote } from "./argv.js";
import { ask } from "./ask.js";
import { HELP, type ParsedArgs, parseSetupArgs } from "./configure-args.js";
import { editSettings } from "./configure-editor.js";
import { runConfigureImport } from "./configure-import.js";
import { runInteropReview } from "./configure-interop.js";
import { formatRuntimeList, type RuntimeListRow } from "./configure-layout.js";
import { canRunOnboarding, runOnboardingWizard } from "./configure-onboarding.js";
import { ConfigureNavigation, ConfigurePrompts } from "./configure-prompts.js";
import { runQuickConnect } from "./configure-quick.js";
import { type ConfigureStreams, SECTIONS, type SectionIo, type SectionSpec } from "./configure-sections.js";
import { contextTierProblem, railPrefix } from "./configure-target.js";
import {
	ensureRegistryPopulated,
	pickRuntimeViaCategory,
	runNonInteractive,
	runTargetSetupInteractive,
} from "./configure-target-setup.js";
import { createInstallPresenter, type InstallPresenter, shortenPath } from "./install-presenter.js";
import { canSelect, promptSelect } from "./select.js";
import { terminalColumns, wrapPlain } from "./text-layout.js";

/** Auth labels for credentials PanCode holds itself; any other label names the tool a runtime logs in through. */
const PANCODE_AUTH_LABELS: ReadonlySet<string> = new Set([
	"connected",
	"login",
	"credential",
	"needs-key",
	"key-optional",
	"none",
]);

function runtimeListCaption(rows: ReadonlyArray<RuntimeListRow>): string {
	const tools = [...new Set(rows.map((row) => row.auth).filter((auth) => !PANCODE_AUTH_LABELS.has(auth)))];
	const rest =
		tools.length > 0
			? `the rest authenticate through their own tool (${tools.join(", ")}) or need no credential`
			: "the rest need no credential";
	return `every registered runtime. run \`pancode auth list\` for the ones PanCode authenticates itself; ${rest}.`;
}

function printRuntimeList(includeHidden: boolean): void {
	const settings = readSettings();
	const auth = openAuthStorage();
	const rows: RuntimeListRow[] = [];
	for (const entry of listProviderSupportEntries(getRuntimeRegistry().list(), { includeHidden })) {
		const runtime = getRuntimeRegistry().get(entry.runtimeId);
		const status =
			runtime && entry.connectable
				? auth.statusForTarget(resolveRuntimeAuthTarget(runtime), {
						includeFallback: false,
					})
				: null;
		const authLabel =
			runtime?.auth === "oauth"
				? status?.available
					? "connected"
					: "login"
				: runtime?.auth === "api-key"
					? status?.available
						? "credential"
						: targetRequiresAuth({ id: entry.runtimeId, runtime: entry.runtimeId }, runtime)
							? "needs-key"
							: "key-optional"
					: (runtime?.externalLogin ?? runtime?.auth ?? "none");
		rows.push({
			group: supportGroupLabel(entry.group),
			runtimeId: entry.runtimeId,
			label: entry.label,
			auth: authLabel,
			targets: configuredTargetsForRuntime(settings, entry.runtimeId).length,
			models: describeRuntimeModels(entry, 2),
		});
	}
	const width = terminalColumns();
	for (const line of formatRuntimeList(rows, width)) {
		process.stdout.write(`${line}\n`);
	}
	// The other half of the pair `pancode auth list` names. This table is every
	// registered runtime; that one is the subset PanCode holds a credential for,
	// and a user who found a name here and could not find it there was reading
	// two screens that each claimed to be the list of what you can connect.
	for (const line of wrapPlain(runtimeListCaption(rows), width)) {
		process.stdout.write(`${line}\n`);
	}
}

interface MenuEntry {
	label: string;
	hint?: string | (() => string);
}

type MenuChoice = { kind: "index"; index: number } | { kind: "back" } | { kind: "quit" };

/**
 * Pick one entry, by arrow keys on a terminal and by number everywhere else.
 * The numbered fallback is not a lesser path: it is what a recorded session, a
 * pipe, and a dumb terminal get, and it accepts the same `b`/`q` tokens the rest
 * of this CLI uses.
 */
async function pickEntry(
	rl: ConfigurePrompts,
	io: ConfigureStreams,
	entries: ReadonlyArray<MenuEntry>,
	backLabel: string,
	plain: boolean,
	initialIndex = 0,
): Promise<MenuChoice> {
	const out = io.out;
	if (canSelect(io.in as NodeJS.ReadStream, out as NodeJS.WriteStream)) {
		const result = await promptSelect({
			initialIndex,
			maxLabelWidth: Math.floor((terminalColumns(out as NodeJS.WriteStream) - 8) * 0.75),
			clearOnExit: true,
			choices: entries.map((entry, index) => ({
				value: index,
				label: entry.label,
				...(entry.hint === undefined ? {} : { hint: typeof entry.hint === "function" ? entry.hint() : entry.hint }),
			})),
			railPrefix: railPrefix(plain),
			backLabel,
			input: io.in as NodeJS.ReadStream,
			output: out as NodeJS.WriteStream,
		});
		if (result.kind === "selected") return { kind: "index", index: result.value };
		return result.kind === "quit" ? { kind: "quit" } : { kind: "back" };
	}

	const rail = railPrefix(plain);
	entries.forEach((entry, index) => {
		const hint = typeof entry.hint === "function" ? entry.hint() : entry.hint;
		out.write(`${rail}${index + 1}. ${entry.label}${hint === undefined ? "" : `  (${hint})`}\n`);
	});
	out.write(`${rail}b. ${backLabel}\n${rail}q. Quit\n`);
	const answer = await ask(rl, "\nSelection", "b");
	if (answer === null) return { kind: "quit" };
	const trimmed = answer.trim().toLowerCase();
	if (trimmed === "b" || trimmed === "back" || trimmed.length === 0) return { kind: "back" };
	if (trimmed === "q" || trimmed === "quit") return { kind: "quit" };
	const index = Number.parseInt(trimmed, 10) - 1;
	if (Number.isInteger(index) && index >= 0 && index < entries.length) return { kind: "index", index };
	out.write(`${rail}Not one of the choices: ${answer}\n`);
	return { kind: "back" };
}

/** Header, source file, and current values for one screen. */
function renderSection(spec: SectionSpec, out: NodeJS.WritableStream): InstallPresenter {
	const presenter = createInstallPresenter({ stream: out });
	presenter.header(spec.title, "configure");
	presenter.note(spec.summary);
	presenter.note(`Source: ${shortenPath(settingsPath())} · saves globally`);
	presenter.fields(spec.fields());
	return presenter;
}

/** Show one screen and stay on it until the operator leaves or quits. */
async function runSection(
	rl: ConfigurePrompts,
	streams: ConfigureStreams,
	spec: SectionSpec,
	backLabel: string,
	verify = true,
): Promise<"back" | "quit"> {
	let selected = 0;
	let notice: { text: string; warning: boolean } | undefined;
	for (;;) {
		rl.clearScreen();
		const presenter = renderSection(spec, streams.out);
		if (notice) {
			if (notice.warning) presenter.warn(notice.text);
			else presenter.completedStep(notice.text);
			notice = undefined;
		}
		const io: SectionIo = {
			rl,
			out: streams.out,
			streams,
			ok: (text) => {
				notice = { text, warning: false };
			},
			warn: (text) => {
				notice = { text: text.trim(), warning: true };
			},
			verify,
		};
		presenter.blank();
		const choice = await pickEntry(rl, streams, spec.actions, backLabel, presenter.isPlain(), selected);
		if (choice.kind !== "index") return choice.kind;
		selected = choice.index;
		const action = spec.actions[selected];
		try {
			if (action !== undefined) await action.run(io);
		} catch (error) {
			if (error instanceof ConfigureNavigation) {
				if (error.kind === "quit") return "quit";
			} else
				notice = { text: `Change not saved: ${error instanceof Error ? error.message : String(error)}`, warning: true };
		}
	}
}

/** Full settings, opened directly or one level below the launcher. */
async function runConfigSectionsMenu(
	rl: ConfigurePrompts,
	streams: ConfigureStreams,
	backLabel: "back" | "quit" = "quit",
	verify = true,
): Promise<"back" | "quit"> {
	let selected = 0;
	for (;;) {
		rl.clearScreen();
		const presenter = createInstallPresenter({ stream: streams.out });
		presenter.header("PanCode Settings", "configure");
		presenter.note(`Source: ${shortenPath(settingsPath())}`);
		presenter.note("Changes here become your saved defaults.");
		presenter.blank();
		const choice = await pickEntry(
			rl,
			streams,
			SECTIONS.map((section) => ({ label: section.title, hint: section.summary })),
			backLabel,
			presenter.isPlain(),
			selected,
		);
		if (choice.kind !== "index") return choice.kind;
		selected = choice.index;
		const spec = SECTIONS[selected];
		if (spec === undefined) continue;
		if ((await runSection(rl, streams, spec, "back", verify)) === "quit") return "quit";
	}
}

async function runConfigLauncher(rl: ConfigurePrompts, streams: ConfigureStreams, verify = true): Promise<number> {
	let selected = readSettings().connections.length === 0 ? 0 : 2;
	const exitCode = () => (readSettings().chat.connection ? 0 : 130);
	for (;;) {
		rl.clearScreen();
		const presenter = createInstallPresenter({ stream: streams.out });
		presenter.header("PanCode", "configure");
		presenter.note("Start with what you recognize. PanCode explains and checks the technical details.");
		presenter.blank();
		const choice = await pickEntry(
			rl,
			streams,
			[
				{ label: "Guided setup", hint: "choose your app, subscription, provider, or server" },
				{ label: "Connect by endpoint", hint: "shortcut when you already know the server URL" },
				{ label: "Settings", hint: "every saved default, grouped by what it changes" },
			],
			"quit",
			presenter.isPlain(),
			selected,
		);
		if (choice.kind !== "index") return exitCode();
		selected = choice.index;
		if (selected === 0) {
			const first = readSettings().connections.length === 0;
			// Every other launcher entry opens on a clean screen. Without this the
			// launcher's banner stayed stacked above the wizard's own header.
			rl.clearScreen();
			const code = await runOnboardingWizard(streams, {
				mode: first ? "first" : "add",
				verify,
			});
			if (code === 0 && first) return 0;
			if (code === 130 && first) return exitCode();
		} else if (selected === 1) {
			const result = await runQuickConnect(rl);
			if (result === "connected") return 0;
			if (result === "quit") return exitCode();
		} else if (selected === 2) {
			if ((await runConfigSectionsMenu(rl, streams, "back", verify)) === "quit") return exitCode();
		}
	}
}

/** Resolve a `--section` value to the one area whose id it is. */
function findSection(name: string): SectionSpec | undefined {
	const area = resolveSharedSettingsArea(name);
	return SECTIONS.find((section) => section.id === area);
}

const SECTION_IDS: ReadonlyArray<string> = SECTIONS.map((section) => section.id);

/**
 * Leaving setup before any target exists. The user chose to stop, so this is a
 * note and not an error, and it names the way back in; 130 still tells a caller
 * such as the bare `pancode` launch that nothing was configured.
 */
function firstRunCancelled(): number {
	printNote("configuration canceled; no connection saved. Run `pancode configure` when you are ready.");
	return 130;
}

async function runInteractive(
	rl: ConfigurePrompts,
	preselectedRuntime: RuntimeDescriptor | null,
	defaults: ParsedArgs,
	streams: ConfigureStreams,
	startsChat = false,
): Promise<number> {
	if (defaults.quick) {
		if (!canRunOnboarding(streams)) {
			printError("--quick needs a terminal; use --id and --runtime for unattended setup");
			return 2;
		}
		return (await runQuickConnect(rl)) === "connected" ? 0 : 130;
	}
	if (defaults.settings) {
		await runConfigSectionsMenu(rl, streams, "quit", defaults.verify !== false);
		return 0;
	}
	if (preselectedRuntime) {
		if (canRunOnboarding(streams))
			return runOnboardingWizard(streams, {
				mode: readSettings().connections.length === 0 ? "first" : "add",
				runtime: preselectedRuntime,
				verify: defaults.verify !== false,
			});
		return await runTargetSetupInteractive(rl, preselectedRuntime, defaults);
	}

	if (defaults.section !== undefined) {
		const spec = findSection(defaults.section);
		if (spec === undefined) {
			printError(`unknown section: ${defaults.section}. Sections: ${SECTION_IDS.join(", ")}`);
			return 2;
		}
		// Without a terminal there is nobody to answer, and printing a prompt into
		// a pipe is a dead end that reads as a hang. The screen is still worth
		// showing, so a scripted `configure --section workers` is a read of that
		// section rather than a refusal.
		if ((streams.in as { isTTY?: boolean }).isTTY !== true) {
			renderSection(spec, streams.out).done("Done");
			return 0;
		}
		await runSection(rl, streams, spec, "quit", defaults.verify !== false);
		return 0;
	}
	// A first run that the bare `pancode` start sent here has one thing to do. The launcher would put
	// a second welcome above the wizard's own and offer three entries that lead nowhere with no target.
	if (canRunOnboarding(streams) && startsChat && readSettings().connections.length === 0)
		return runOnboardingWizard(streams, { mode: "first", startsChat, verify: defaults.verify !== false });
	if (canRunOnboarding(streams)) return runConfigLauncher(rl, streams, defaults.verify !== false);

	if (readSettings().connections.length === 0) {
		// Dumb terminals retain the numbered setup path.
		const runtime = await pickRuntimeViaCategory(rl);
		if (!runtime) return firstRunCancelled();
		return await runTargetSetupInteractive(rl, runtime, defaults);
	}

	await runConfigSectionsMenu(rl, streams, "quit", defaults.verify !== false);
	return 0;
}

export async function runConfigureCommand(
	argv: ReadonlyArray<string>,
	inStream: NodeJS.ReadableStream = input,
	outStream: NodeJS.WritableStream = output,
	/** The bare `pancode` start called this and starts the chat session when it returns 0. */
	startsChat = false,
): Promise<number> {
	// The GUI owns presentation; this fixed child transport keeps provider I/O in the CLI.
	if (argv.length === 1 && argv[0] === "--gui-host") {
		ensureRegistryPopulated();
		return (await import("./configure-browser.js")).runBrowserConfigure(inStream, outStream);
	}
	let args: ParsedArgs;
	try {
		args = parseSetupArgs(argv);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		process.stderr.write(HELP);
		return 2;
	}
	if (args.help) {
		process.stdout.write(HELP);
		return 0;
	}
	ensureRegistryPopulated();
	if (args.import !== undefined) {
		const prompts = (inStream as { isTTY?: boolean }).isTTY ? new ConfigurePrompts(inStream, outStream) : null;
		return runConfigureImport(args.import, {
			yes: args.yes,
			replace: args.replace,
			out: outStream,
			...(prompts
				? { confirm: async (question: string) => /^y(es)?$/iu.test((await prompts.question(question)).trim()) }
				: {}),
		});
	}
	if (args.yes || args.replace) {
		printError("--yes and --replace go with --import");
		return 2;
	}
	if (args.edit) {
		if (!(inStream as { isTTY?: boolean }).isTTY || !(outStream as { isTTY?: boolean }).isTTY) {
			printError("--edit needs a terminal; use configure --json to inspect settings without one");
			return 2;
		}
		try {
			await editSettings(new ConfigurePrompts(inStream, outStream));
			return 0;
		} catch (error) {
			if (error instanceof ConfigureNavigation) return 0;
			printError(error instanceof Error ? error.message : String(error));
			return 1;
		}
	}

	if (args.json) {
		const settings = readSettings();
		outStream.write(`${JSON.stringify(settings, null, 2)}\n`);
		return 0;
	}

	if (args.list) {
		printRuntimeList(args.all);
		return 0;
	}
	if (args.interop) {
		if (!(inStream as { isTTY?: boolean }).isTTY) return runInteropReview({ rl: null });
		const rl = new ConfigurePrompts(inStream, outStream);
		return runInteropReview({ rl, streams: { in: inStream, out: outStream } });
	}

	if (args.positional.length > 0) {
		printError(
			"`pancode configure` accepts flags, not positional runtimes. Use `pancode auth login <runtime>` first when authentication is needed, then `pancode configure --runtime <runtimeId> ...`.",
		);
		return 2;
	}

	const runtimeId = args.runtime;
	let runtime: RuntimeDescriptor | null = null;
	if (runtimeId) {
		runtime = getRuntimeRegistry().get(runtimeId);
		if (!runtime) {
			const suggestion = closestRuntimeId(getRuntimeRegistry(), runtimeId);
			printError(`unknown runtime id: ${runtimeId}${suggestion ? ` (did you mean '${suggestion}'?)` : ""}`);
			process.stdout.write("run `pancode configure --list` to see registered runtimes\n");
			return 2;
		}
	}
	const hasTargetSetupFlag =
		args.id !== undefined ||
		args.url !== undefined ||
		args.model !== undefined ||
		args.workerProfile !== undefined ||
		args.workerProfileModel !== undefined ||
		args.apiKey !== undefined ||
		args.apiKeyEnv !== undefined ||
		args.gateway ||
		args.lifecycle !== undefined ||
		args.setOrchestrator ||
		args.setBackground ||
		args.backgroundModel !== undefined ||
		args.orchestratorModel !== undefined ||
		args.workerModel !== undefined ||
		args.bindAgent !== undefined ||
		args.setWorkerDefault ||
		args.contextWindow !== undefined ||
		args.maxTokens !== undefined ||
		args.reasoning !== undefined ||
		args.contextTier !== undefined;
	// The tier is a copilot-sdk option; no guided path or other runtime would take it.
	const tierProblem = contextTierProblem(runtime, args.contextTier);
	if (tierProblem !== null) {
		printError(tierProblem);
		return 2;
	}
	const nonInteractive = runtime !== null && hasTargetSetupFlag;

	if (nonInteractive && runtime) return runNonInteractive(runtime, args);

	// Setup flags were supplied but the non-interactive spec is incomplete
	// (missing --runtime, or a --runtime with no target flags). On a
	// non-interactive stdin the wizard below would read EOF, take the default
	// answers, write the initial settings template, and exit 0 without
	// configuring the requested target. Reject with the missing half instead.
	if ((runtimeId !== undefined || hasTargetSetupFlag) && !(inStream as { isTTY?: boolean }).isTTY) {
		printError(
			runtime === null
				? "--runtime is required when configuring a connection non-interactively"
				: "--id is required when passing flags non-interactively",
		);
		return 2;
	}

	const rl = new ConfigurePrompts(inStream, outStream);
	try {
		return await runInteractive(rl, runtime, args, { in: inStream, out: outStream }, startsChat);
	} catch (err) {
		if (err instanceof ConfigureNavigation) {
			if (readSettings().connections.length > 0) return 0;
			return firstRunCancelled();
		}
		printError(err instanceof Error ? err.message : String(err));
		return 1;
	}
}
