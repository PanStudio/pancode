// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { initializePancodeHome, recordHomeDowngrade } from "../core/init.js";
import { runCommandVector } from "../core/safe-exec.js";
import { shellQuote } from "../core/shell-quote.js";
import { pancodeDirLayoutProblems, resolvePancodeDirs } from "../core/xdg.js";
import { createUpdateLog, deferredUpdateTarget, installHold } from "../domains/install/deferred-update.js";
import { runDoctor } from "../domains/install/doctor.js";
import type { Installation, UpgradeInvocation } from "../domains/install/install-method.js";
import {
	formatUpgradeInvocation,
	inspectInstallation,
	installationCommand,
	installerPackageRoot,
	installerUpgradeInvocation,
	launcherPathFor,
	npmUpgradeInvocation,
	readInstallerRecord,
} from "../domains/install/install-method.js";
import {
	backgroundPackageRoot,
	describeTracking,
	inactiveInstallerLauncher,
	inactiveInstallerRoots,
	installIdentity,
	launcherWinsOnPath,
} from "../domains/install/install-plan.js";
import type { ReleaseSource } from "../domains/install/release-version.js";
import {
	compareReleaseVersions,
	fetchReleaseVersion,
	parseReleaseVersion,
	releaseVersionUrl,
} from "../domains/install/release-version.js";
import { readStateInfo } from "../domains/install/state.js";
import { updateFingerprint } from "../domains/install/update-check.js";
import { getVersionInfo } from "../domains/install/version.js";
import { printError } from "./argv.js";
import { writeCliFailure } from "./kit/json-out.js";
import type { LifecyclePresenter } from "./lifecycle-presenter.js";
import { createLifecyclePresenter, formatBytes, measurePath, shortenPath } from "./lifecycle-presenter.js";

const CHANNELS = ["latest", "beta"] as const;
type Channel = (typeof CHANNELS)[number];

const HELP = `pancode upgrade [--dry-run] [--channel=<latest|beta>]
                   [--post-install] [--rollback] [--restart] [--json]

Upgrade PanCode. An npm-installed
binary is updated in its existing prefix. An install.sh install gets the new
version, with the Node.js it runs on, in a new directory beside the old one,
then its launcher is switched.
Other package managers and source checkouts receive update instructions for
their installation method.

Flags:
  --dry-run             print planned actions without changing anything
  --channel=<chan>      release channel to install (latest|beta). npm and install.sh installs.
  --post-install        apply local checks after a package-manager update; skip reinstall
  --rollback            native installs: restore the previous working version, disable background updates
  --restart             after success, launch the installed PanCode in this project as a fresh session;
                        pancode --continue picks up the last session instead
  --json                emit machine-readable JSON output
  --help, -h            show this message
`;

/** One wording for the source-update advice. Three paths print it; they used to disagree. */
const SOURCE_UPGRADE_LEAD = "To update the checkout itself (choose a release tag after fetching):";

/**
 * A session is resumed at startup with `pancode --continue` (the last one) or `pancode --resume [id]`
 * (#191), so every hint names the flag. The `--restart` relaunch itself stays bare, a fresh session.
 */
const RESUME_HINT = "run pancode --continue in this project";
const RELAUNCH_PREVIEW =
	"Would relaunch the installed PanCode in this project after success as a fresh session; pancode --continue picks up the last session instead.";

interface UpgradeOptions {
	dryRun: boolean;
	channel: Channel;
	channelExplicit: boolean;
	help: boolean;
	postInstall: boolean;
	json: boolean;
	restart: boolean;
	rollback: boolean;
}

/**
 * Positional scan, not `argv.indexOf`. The previous parser looked each token up
 * by value to find its neighbour, so the second `--channel` in a repeated pair
 * read the first one's value, and a value that happened to equal an earlier
 * token was consumed at the wrong index.
 */
function parseUpgradeArgs(argv: ReadonlyArray<string>): UpgradeOptions {
	let dryRun = false;
	let channel: Channel = "latest";
	let channelExplicit = false;
	let help = false;
	let postInstall = false;
	let json = false;
	let restart = false;
	let rollback = false;

	const toChannel = (value: string | undefined): Channel => {
		if (value === undefined || !(CHANNELS as ReadonlyArray<string>).includes(value)) {
			throw new Error(`--channel must be one of ${CHANNELS.join("|")}, got '${value ?? ""}'`);
		}
		return value as Channel;
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined || arg === "upgrade") continue;
		if (arg === "--help" || arg === "-h") help = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--post-install") postInstall = true;
		else if (arg === "--json") json = true;
		else if (arg === "--restart") restart = true;
		else if (arg === "--rollback") rollback = true;
		else if (arg.startsWith("--channel=")) {
			channel = toChannel(arg.slice("--channel=".length));
			channelExplicit = true;
		} else if (arg === "--channel") {
			channel = toChannel(argv[i + 1]);
			channelExplicit = true;
			i += 1;
		} else throw new Error(`unknown upgrade argument: ${arg}`);
	}
	if (!help && restart && (json || postInstall))
		throw new Error("--restart cannot be combined with --json or --post-install");
	if (rollback && (postInstall || restart))
		throw new Error("--rollback cannot combine with --post-install or --restart");
	return {
		dryRun,
		channel,
		channelExplicit,
		help,
		postInstall,
		json,
		restart,
		rollback,
	};
}

/**
 * What the registry said, and whether it was asked at all.
 *
 * "Not asked" and "asked and could not answer" are different facts, and
 * collapsing both into `null` is what let an offline npm install report itself
 * already current: an unanswered lookup compared nothing, so it cannot conclude
 * the installed version is the newest one.
 */
type RegistryLookup =
	| {
			asked: false;
			reason: "source checkout" | "post-install checks" | "package manager not identified" | "not in the npm registry";
	  }
	| { asked: true; version: string | null };

/** An installer install follows the release's channel file; a package-manager install follows its registry. */
function releaseSource(method: Installation["kind"]): ReleaseSource {
	return method === "installer" ? "bundle" : "registry";
}

async function lookUpAvailableVersion(channel: Channel, method: Installation["kind"]): Promise<RegistryLookup> {
	if (method === "source") return { asked: false, reason: "source checkout" };
	if (method === "local" || method === "unknown") return { asked: false, reason: "package manager not identified" };
	return { asked: true, version: await fetchReleaseVersion(channel, undefined, releaseSource(method)) };
}

/**
 * Run one child to completion, keeping its last output for the failure message.
 *
 * The pipes have to be drained. `npm install -g` writes well past a 64 KB pipe
 * buffer, and a child whose stdout nobody reads blocks on the write and never
 * exits, so the upgrade hung with no output and no way to tell it apart from a
 * slow registry. Draining also gives the failure something to say beyond an
 * exit code.
 */
async function runChild(
	command: string,
	args: ReadonlyArray<string>,
	label: string,
	env: NodeJS.ProcessEnv = process.env,
	run: { log?: string; signal?: AbortSignal; cwd?: string } = {},
): Promise<string> {
	const { log } = run;
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, [...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env,
			...(run.cwd !== undefined ? { cwd: run.cwd } : {}),
			...(run.signal ? { signal: run.signal } : {}),
		});
		let stdout = "";
		let tail = "";
		const keepTail = (chunk: Buffer): void => {
			tail = `${tail}${chunk.toString("utf8")}`.slice(-16384);
			if (log === undefined) return;
			try {
				appendFileSync(log, chunk);
			} catch {
				// The log is for a launch waiting on the lease; the run keeps its own tail.
			}
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = `${stdout}${chunk.toString("utf8")}`.slice(0, 1024 * 1024);
			keepTail(chunk);
		});
		child.stderr?.on("data", keepTail);
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}
			let detail = tail.trim();
			try {
				const report = JSON.parse(stdout) as { errors?: unknown } | null;
				if (Array.isArray(report?.errors)) {
					const errors = report.errors.filter((error: unknown) => typeof error === "string" && error.trim());
					if (errors.length > 0) detail = errors.join("\n");
				}
			} catch {
				// Non-JSON children still provide their captured output on failure.
			}
			reject(new Error(`${label} exited with code ${code ?? -1}${detail ? `:\n${detail}` : ""}`));
		});
	});
}

/** The package version installed in an installer prefix, or null when its metadata cannot be read. */
function installedVersionAt(prefix: string): string | null {
	try {
		const pkg = JSON.parse(readFileSync(join(installerPackageRoot(prefix), "package.json"), "utf8")) as {
			version?: unknown;
		};
		return typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		return null;
	}
}

/** `versions/0.9.0-dev-20261125-4242`, the part of an installer prefix that tells two builds of one version apart. */
function prefixLabel(prefix: string): string {
	return `versions/${basename(prefix)}`;
}

/** `dir` when this user cannot write it, else null. */
function unwritableDir(dir: string): string | null {
	try {
		accessSync(dir, constants.W_OK);
		return null;
	} catch {
		return dir;
	}
}

/** The Node that runs `installation`: its managed runtime for install.sh, else this process's. */
/**
 * The package manager runs from the directory it installs into, never the
 * operator's, so a project .npmrc there cannot choose the registry or version.
 */
function packageManagerCwd(dir: string | null): string {
	return dir !== null && existsSync(dir) ? dir : homedir();
}

function nodeFor(installation: Installation): string {
	const node = installation.installer?.node;
	return node !== undefined && existsSync(node) ? node : process.execPath;
}

async function runNpmInstall(
	installation: Installation,
	invocation: UpgradeInvocation,
	run: { log?: string; signal?: AbortSignal } = {},
): Promise<void> {
	await runChild(
		invocation.command,
		invocation.args,
		`npm install --prefix ${installation.prefix}`,
		{
			...process.env,
			...invocation.env,
		},
		{ ...run, cwd: packageManagerCwd(installation.prefix) },
	);
}

type InstallStake = { holders: string[] } | { log: string; signal: AbortSignal; release(): void };

/**
 * An npm prefix the deferred wrapper could update is replaced in place, so a
 * shell upgrade follows the wrapper's sequence (#436): refuse while any other
 * process or lease holds the install, stake the same lease launches wait on,
 * look once more for a launch that raced it, and keep the lease for the whole
 * manager run. SIGINT and SIGTERM release it; a SIGKILLed holder is reclaimed
 * by pid and birth token like a dead wrapper.
 */
function stakeInstall(
	target: NonNullable<ReturnType<typeof deferredUpdateTarget>>,
	installation: Installation,
	cacheDir: string,
): InstallStake {
	const hold = installHold(target);
	const held = hold.holders();
	if (held.length > 0) return { holders: held };
	const log = createUpdateLog(cacheDir, updateFingerprint(installation));
	appendFileSync(
		log,
		`[${new Date().toISOString()}] pancode upgrade pid ${process.pid} on ${hostname()} is replacing ${target.root} with npm\n`,
		{ mode: 0o600 },
	);
	if (!hold.stake({ manager: "npm", log })) return { holders: [hold.lease()?.holder ?? "another update lease"] };
	const late = hold.holders();
	if (late.length > 0) {
		hold.unstake();
		return { holders: late };
	}
	// A signal stops npm before the lease goes, so no launch loads a half-written package.
	const abort = new AbortController();
	const signals = { SIGINT: 130, SIGTERM: 143 } as const;
	const handlers = Object.entries(signals).map(([signal, code]) => {
		const handler = () => {
			abort.abort();
			hold.unstake();
			process.exit(code);
		};
		process.once(signal, handler);
		return [signal, handler] as const;
	});
	const onExit = () => hold.unstake();
	process.once("exit", onExit);
	return {
		log,
		signal: abort.signal,
		release() {
			hold.unstake();
			for (const [signal, handler] of handlers) process.off(signal, handler);
			process.off("exit", onExit);
		},
	};
}

/**
 * Marks the post-install runs an upgrade starts, its own and the installer's,
 * so they leave the background restart to the upgrade, which does it once.
 */
const UPGRADE_CHILD_ENV = { PANCODE_UPGRADE_PARENT: "1" } as const;

async function runInstallerUpgrade(installation: Installation, invocation: UpgradeInvocation): Promise<Installation> {
	const record = installation.installer;
	if (installation.kind !== "installer" || record === undefined)
		throw new Error("installer upgrade needs an install.sh installation");
	await runChild(
		invocation.command,
		invocation.args,
		process.platform === "win32" ? "install.ps1" : "install.sh",
		{
			...process.env,
			...invocation.env,
			...UPGRADE_CHILD_ENV,
		},
		{ cwd: packageManagerCwd(record.root) },
	);
	const updated = readInstallerRecord(record.root);
	if (updated === null) throw new Error(`install.sh finished but ${join(record.root, "install.json")} is unreadable`);
	return inspectInstallation(join(installerPackageRoot(updated.current), "dist", "cli", "index.js"));
}

async function runDoctorFixAfterInstall(_installation: Installation): Promise<void> {
	initializePancodeHome();
	const integrity = new Set([
		"engine runtime",
		"directory layout",
		"config dir",
		"data dir",
		"state dir",
		"cache dir",
		"settings.yaml",
		"state metadata",
	]);
	const failures = runDoctor().filter((finding) => !finding.ok && integrity.has(finding.name));
	if (failures.length) throw new Error(failures.map((finding) => `${finding.name}: ${finding.detail}`).join("\n"));
}

async function runPostInstallUpgrade(
	opts: UpgradeOptions,
	installation: Installation,
	presenter: LifecyclePresenter,
): Promise<void> {
	const args = [installation.entry, "upgrade", "--post-install", `--channel=${opts.channel}`, "--json"];
	const output = await runChild(nodeFor(installation), args, "pancode upgrade --post-install", {
		...process.env,
		...UPGRADE_CHILD_ENV,
	});
	let report: { steps: Array<{ type: string; message: string }>; warnings: string[] };
	try {
		report = JSON.parse(output);
		if (
			!Array.isArray(report?.steps) ||
			!report.steps.every((step) => step && typeof step.type === "string" && typeof step.message === "string") ||
			!Array.isArray(report.warnings) ||
			!report.warnings.every((warning) => typeof warning === "string")
		)
			throw new Error("Invalid post-install report");
	} catch {
		for (const line of output.split(/\r?\n/).filter((line) => line.trim())) presenter.note(line);
		return;
	}
	for (const step of report.steps) {
		if (step.type === "completed") presenter.completedStep(step.message);
		else if (step.type === "substep") presenter.substep(step.message);
		else if (step.type === "note") presenter.note(step.message);
	}
	for (const warning of report.warnings) presenter.warn(warning);
}

/** Whether the default background directory holds an app; a path that cannot be looked at says why. */
function defaultBackground(owner: string): "present" | "absent" | { error: string } {
	try {
		lstatSync(owner);
		return "present";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? "absent" : { error: code ?? String(error) };
	}
}

async function runBackgroundRestart(installation: Installation): Promise<string> {
	const restart = ["gui", "background", "restart", "--if-idle"];
	// An installer install restarts the app the way its launcher does, through the desktop host the manifest
	// names, so a rollback to an older CLI still moves the app to the version now active.
	const args = installation.installer
		? [join(installation.root, "scripts", "native-install.cjs"), "launch", installation.installer.root, ...restart]
		: [installation.entry, ...restart];
	const output = await runChild(nodeFor(installation), args, "pancode gui background restart --if-idle");
	const lines = output.trim().split(/\r?\n/).filter(Boolean);
	if (lines.length !== 1) throw new Error("background restart did not return its one-line result");
	return lines[0] ?? "";
}

/**
 * The command that moves the background app to `installation`. It names this installation's own launcher
 * unless that launcher is the `pancode` a shell finds first, since a bare `pancode` may start the other one.
 */
function handoverCommand(installation: Installation): string {
	const launcher = launcherPathFor(installation);
	if (!existsSync(launcher) || launcherWinsOnPath(launcher)) return "pancode gui background install --handover";
	const windows = process.platform === "win32";
	const command = (windows ? /^[A-Za-z0-9_.\\/:@=+-]+$/u : /^[A-Za-z0-9_./:@=+-]+$/u).test(launcher)
		? launcher
		: windows
			? `& '${launcher.replaceAll("'", "''")}'`
			: shellQuote(launcher);
	return `${command} gui background install --handover`;
}

async function runRestart(installation: Installation): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(nodeFor(installation), [installation.entry], { stdio: "inherit" });
		// Both share the foreground process group. Let the new CLI own Ctrl+C.
		const interrupt = () => {};
		const terminate = () => {
			child.kill("SIGTERM");
		};
		const cleanup = () => {
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		};
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code, signal) => {
			cleanup();
			resolve(code ?? (signal === "SIGINT" ? 130 : 1));
		});
	});
}

export interface UpgradeDependencies {
	inspectInstallation: typeof inspectInstallation;
	lookUpAvailableVersion: typeof lookUpAvailableVersion;
	runNpmInstall: typeof runNpmInstall;
	runInstallerUpgrade: typeof runInstallerUpgrade;
	runDoctorFixAfterInstall: typeof runDoctorFixAfterInstall;
	runPostInstallUpgrade: typeof runPostInstallUpgrade;
	runBackgroundRestart: typeof runBackgroundRestart;
	runRestart: typeof runRestart;
	isInteractive: () => boolean;
}

const DEFAULT_DEPENDENCIES: UpgradeDependencies = {
	inspectInstallation,
	lookUpAvailableVersion,
	runNpmInstall,
	runInstallerUpgrade,
	runDoctorFixAfterInstall,
	runPostInstallUpgrade,
	runBackgroundRestart,
	runRestart,
	isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

// The first-party packs that ship with PanCode load lazily: only a post-install
// reaches them, and the hub modules are heavy for every other upgrade path.
async function previewDefaultPacks(presenter: LifecyclePresenter): Promise<void> {
	const { pendingDefaultPacks } = await import("../domains/resources/hub-defaults.js");
	const pending = pendingDefaultPacks();
	if (pending.length > 0) presenter.note(`Would install the default packs ${pending.join(", ")}.`);
}

async function giveDefaultPacks(presenter: LifecyclePresenter): Promise<void> {
	const { applyDefaultPacks } = await import("../domains/resources/hub-defaults.js");
	await applyDefaultPacks(presenter);
}

export async function runUpgradeCommand(
	argv: ReadonlyArray<string>,
	dependencies: Partial<UpgradeDependencies> = {},
): Promise<number> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	let opts: UpgradeOptions;
	try {
		opts = parseUpgradeArgs(argv);
	} catch (err) {
		// One diagnostic and a pointer at the help (C3); under --json the failure
		// document is the one thing on stdout (C6).
		const message = err instanceof Error ? err.message : String(err);
		writeCliFailure({
			path: ["upgrade"],
			slug: message.startsWith("unknown upgrade argument")
				? "unknown_flag"
				: message.includes("cannot")
					? "flag_conflict"
					: "usage",
			message,
			json: argv.includes("--json"),
		});
		return 2;
	}
	if (opts.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (opts.restart && !opts.dryRun && !deps.isInteractive()) {
		writeCliFailure({
			path: ["upgrade"],
			slug: "confirmation_required",
			message: `--restart requires an interactive terminal; after upgrading, ${RESUME_HINT}`,
			json: opts.json,
		});
		return 2;
	}

	const presenter = createLifecyclePresenter({ json: opts.json, dryRun: opts.dryRun });
	presenter.header("Upgrade", "upgrade");

	const before = getVersionInfo().pancode;
	const dirs = resolvePancodeDirs();
	const layoutProblems = pancodeDirLayoutProblems(dirs);
	if (layoutProblems.length > 0) {
		presenter.fail("unsafe directory layout", layoutProblems.join("; "));
		presenter.commandAdvice(
			"Set four absolute, distinct, non-nesting roots, then inspect them with:",
			"pancode paths\npancode doctor",
		);
		presenter.finish();
		return 2;
	}
	const stateDir = dirs.state;
	// A first install has no home yet; post-install checks create it.
	if (opts.postInstall && !opts.dryRun && ![dirs.config, dirs.data, stateDir].some((dir) => existsSync(dir)))
		initializePancodeHome();
	const installation = deps.inspectInstallation();
	// An installer upgrade moves the entry to a new prefix; the relaunch and the
	// background restart must use the new one.
	let activeInstallation = installation;
	if (installation.installer && !argv.some((arg) => arg === "--channel" || arg.startsWith("--channel="))) {
		const recordedChannel = installation.installer.channel;
		if (CHANNELS.includes(recordedChannel as Channel)) opts.channel = recordedChannel as Channel;
	}
	const method = installation.kind;
	const backgroundOwner = join(stateDir, "gui/background/owner.json");
	if (opts.rollback) {
		const record = installation.installer;
		if (method !== "installer" || !record) {
			presenter.fail("Rollback works only for native installer installs, made by install.sh or install.ps1");
			if (method === "npm" || method === "pnpm" || method === "bun") {
				// The state record keeps the version this home ran before its last version change.
				const previous = readStateInfo()?.upgradedFrom;
				const known = previous !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(previous) && previous !== before;
				presenter.commandAdvice(
					known
						? `Install the previous version, ${previous}, with the original package manager:`
						: "Install the version you want with the original package manager:",
					installationCommand(installation, "upgrade", known ? previous : "<version>"),
				);
			}
			presenter.finish();
			return 2;
		}
		if (!record.previous) {
			presenter.fail("No previous version is installed, so there is nothing to roll back to");
			presenter.finish();
			return 1;
		}
		const previousVersion = installedVersionAt(record.previous) ?? record.previous;
		// Two builds of one -dev version differ only by their prefix, so the labels name it (finding 3).
		const sameVersion = installedVersionAt(record.current) === installedVersionAt(record.previous);
		const fromLabel = sameVersion ? `${before} (${prefixLabel(record.current)})` : before;
		const toLabel = sameVersion ? `${previousVersion} (${prefixLabel(record.previous)})` : previousVersion;
		const unwritable = unwritableDir(record.root);
		if (unwritable !== null) {
			presenter.fail(
				`Rollback stopped; nothing changed. ${unwritable} is not writable by this user, and the rollback rewrites the installer manifest there`,
			);
			presenter.finish();
			return 1;
		}
		const stop = (message: string, detail?: string): number => {
			presenter.fail(message, detail);
			presenter.finish();
			return 1;
		};
		if (opts.dryRun) {
			presenter.note(`Would switch the launcher from ${fromLabel} to ${toLabel} and turn background updates off.`);
			presenter.warn("Dry run: no changes made");
			presenter.done("Done");
			return 0;
		}
		const windows = process.platform === "win32";
		const args = windows
			? [
					"-NoProfile",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					join(installation.root, "scripts", "install.ps1"),
					"-InstallDir",
					record.root,
					"-BinDir",
					dirname(record.launcher),
					"-Rollback",
				]
			: [
					join(installation.root, "scripts", "install.sh"),
					"--install-dir",
					record.root,
					"--bin-dir",
					dirname(record.launcher),
					"--rollback",
				];
		let result: Awaited<ReturnType<typeof runCommandVector>>;
		try {
			result = await runCommandVector(windows ? "powershell.exe" : "sh", args, {
				env: Object.fromEntries(
					Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
				),
				timeoutMs: 60_000,
			});
		} catch (err) {
			return stop("Rollback failed; the active version is unchanged", err instanceof Error ? err.message : String(err));
		}
		if (result.exitCode !== 0)
			return stop("Rollback failed; the active version is unchanged", (result.stderr || result.stdout).trim());
		// The older binary refuses a home a newer version stamped, so a rollback to one records an accepted downgrade.
		let downgradeError: string | null = null;
		if (installedVersionAt(record.previous) !== null) {
			try {
				recordHomeDowngrade(previousVersion, { onlyFromNewer: true });
			} catch (err) {
				downgradeError = err instanceof Error ? err.message : String(err);
			}
		}
		// The installer's own lines, without its tag, are the record of what changed.
		for (const line of result.stdout.split(/\r?\n/)) {
			const text = line.replace(/^\[install\]\s*/, "").trim();
			if (text) presenter.completedStep(`${text.charAt(0).toUpperCase()}${text.slice(1)}`);
		}
		if (downgradeError !== null)
			presenter.warn(
				`Could not record ${previousVersion} as this home's version (${downgradeError}); it asks before opening the home, and headless runs need PANCODE_ALLOW_OLDER=1`,
			);
		// The background app runs the version it started with until it restarts.
		const found = defaultBackground(backgroundOwner);
		const owner = found === "present" ? backgroundPackageRoot(stateDir) : null;
		if (owner !== null && installIdentity(owner) !== installIdentity(installation.root))
			presenter.note(`Left the desktop app running from ${shortenPath(owner)}, the installation it belongs to.`);
		else if (found === "present") {
			try {
				presenter.note(await deps.runBackgroundRestart(installation));
			} catch (error) {
				presenter.warn(
					`Rollback succeeded, but the background app was not checked: ${error instanceof Error ? error.message : String(error)}`,
				);
				presenter.commandAdvice(`Restart it when you want it on ${toLabel}:`, "pancode gui background restart --if-idle");
			}
		}
		// Only the default location is known here; nothing records an app set up in another directory.
		else if (found === "absent")
			presenter.commandAdvice(
				`No desktop app is set up in the default location. One set up with --directory keeps its version until it restarts; to move it to ${toLabel}:`,
				"pancode gui background restart --if-idle --directory <dir>",
			);
		else {
			presenter.warn(
				`Could not look for a desktop app in ${shortenPath(dirname(backgroundOwner))} (${found.error}); one keeps the version it started with until it restarts`,
			);
			presenter.commandAdvice(
				`To move it to ${toLabel}, restart it with --directory <dir> when it was set up elsewhere:`,
				"pancode gui background restart --if-idle",
			);
		}
		presenter.note(
			`Sessions already running keep ${fromLabel}; run pancode --resume in this project to pick one up on ${toLabel}.`,
		);
		presenter.done("Done");
		return 0;
	}
	const methodLabel =
		method === "source"
			? "source checkout"
			: method === "npm"
				? "npm global"
				: method === "installer"
					? "installer"
					: method;
	if (!opts.channelExplicit && installation.installer && CHANNELS.includes(installation.installer.channel as Channel))
		opts.channel = installation.installer.channel as Channel;

	const updateCommand = installationCommand(installation, "upgrade", opts.channel);
	// npm and Bun carry a beta dist-tag only while a pre-release is current, so a hand-run registry command on the
	// beta channel names the version that channel resolves to, the newer of the beta and latest tags.
	const handRunCommand = async (resolved: string | null): Promise<string> => {
		if (opts.channel !== "beta" || !["npm", "pnpm", "bun"].includes(installation.kind)) return updateCommand;
		const lookup = resolved === null ? await deps.lookUpAvailableVersion("beta", installation.kind) : null;
		const version = resolved ?? (lookup?.asked ? lookup.version : null);
		return version === null ? updateCommand : installationCommand(installation, "upgrade", version);
	};
	const sourceAdvice = () => presenter.commandAdvice(SOURCE_UPGRADE_LEAD, updateCommand);
	const finish = async (): Promise<number> => {
		if (!opts.dryRun && opts.postInstall) {
			// The installer root a move to a checkout or a package manager left behind.
			for (const record of inactiveInstallerRoots(activeInstallation)) {
				const size = measurePath(record.root);
				presenter.warn(
					`The installer root at ${shortenPath(record.root)} (${formatBytes(size.bytes ?? 0)}) is no longer used by this installation`,
				);
				const launcher = inactiveInstallerLauncher(record);
				if (launcher !== null && launcherWinsOnPath(launcher))
					presenter.warn(`${shortenPath(launcher)} comes first on PATH and still starts the old installation, not this one`);
				presenter.commandAdvice("To remove only it, run:", "pancode uninstall --inactive");
			}
		}
		// An installer run with --no-gui touches no desktop step, the existing app's restart and Windows shortcut
		// included (F-C17); the app keeps running from where it was.
		const desktopDeclined = opts.postInstall && process.env.PANCODE_INSTALL_GUI === "0";
		// A post-install acts only on an app this installation owns. Another installation's app, a second install
		// beside it included, stays where it is; moving it is the person's choice, by the one command named here.
		const owner = opts.postInstall && existsSync(backgroundOwner) ? backgroundPackageRoot(stateDir) : null;
		const foreignOwner = owner !== null && installIdentity(owner) !== installIdentity(activeInstallation.root);
		if (!opts.dryRun && foreignOwner) {
			presenter.note(`Left the desktop app running from ${shortenPath(owner)}, the installation it belongs to.`);
			presenter.commandAdvice(
				"Move it to this installation when you want it to follow:",
				handoverCommand(activeInstallation),
			);
		} else if (!opts.dryRun && desktopDeclined && existsSync(backgroundOwner)) {
			presenter.note("Left the desktop app as it was, as the installer's --no-gui asked.");
			presenter.commandAdvice("Restart it when you want it on this version:", "pancode gui background restart --if-idle");
		} else if (
			!opts.dryRun &&
			existsSync(backgroundOwner) &&
			!(opts.postInstall && process.env.PANCODE_UPGRADE_PARENT === "1")
		) {
			// The new installation restarts an idle app itself, and an app 0.7.0 started at once; a busy one
			// moves on the next pancode gui after its work is done. Under an upgrade, the upgrade does it.
			try {
				presenter.note(await deps.runBackgroundRestart(activeInstallation));
			} catch (error) {
				presenter.warn(
					`Upgrade succeeded, but the background app was not checked: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		presenter.done("Done");
		return relaunch("Upgrade complete, but relaunch failed");
	};
	// An install already current changes nothing, the desktop app included; a --restart still relaunches the CLI.
	const unchanged = async (): Promise<number> => {
		presenter.done("Done");
		return relaunch("Relaunch failed");
	};
	const relaunch = async (failure: string): Promise<number> => {
		if (!opts.restart || opts.dryRun) return 0;
		try {
			return await deps.runRestart(activeInstallation);
		} catch (error) {
			printError(`${failure}: ${error instanceof Error ? error.message : String(error)}. To continue, ${RESUME_HINT}.`);
			return 1;
		}
	};
	presenter.setMethod(methodLabel);
	if (!opts.postInstall && method !== "npm" && method !== "installer" && method !== "source") {
		// The owning package manager is named only when the channel has a newer version for it to install. Homebrew
		// and WinGet publish on their own schedule, so a newer npm version says nothing about theirs.
		const lookup: RegistryLookup =
			method === "homebrew" || method === "winget"
				? { asked: false, reason: "not in the npm registry" }
				: await deps.lookUpAvailableVersion(opts.channel, method);
		const available = lookup.asked ? lookup.version : null;
		const comparison = available === null ? null : compareReleaseVersions(available, before);
		if (comparison !== null && comparison <= 0) {
			presenter.step(`Installation method: ${methodLabel}`);
			presenter.step(`Current version: ${before}`);
			presenter.step(`Available version: ${available}`);
			if (comparison < 0) presenter.note(`Installed ${before} is newer than ${opts.channel} (${available}); keeping it.`);
			presenter.warn(`Already on ${before}. Nothing to do.`);
			if (opts.dryRun && opts.restart) presenter.note(RELAUNCH_PREVIEW);
			if (opts.dryRun) presenter.warn("Dry run: no changes made");
			return unchanged();
		}
		const newer = comparison !== null && comparison > 0;
		presenter.note(`Installation method: ${methodLabel}`);
		presenter.note(`Package: ${installation.root}`);
		if (newer) presenter.note(`Available version: ${available}`);
		else if (!lookup.asked) presenter.note(`Available version: not checked (${lookup.reason})`);
		else
			presenter.note(
				`Available version: unknown (no version from ${releaseVersionUrl(opts.channel, releaseSource(method))})`,
			);
		if (newer)
			presenter.commandAdvice(
				"Update with the original package manager and its original global directory:",
				await handRunCommand(available),
			);
		else if (method === "local" || method === "unknown")
			presenter.commandAdvice("Ask the package manager that installed it for any newer release:", updateCommand);
		else if (method === "homebrew" || method === "winget") {
			presenter.commandAdvice(
				`See whether ${method === "homebrew" ? "Homebrew" : "WinGet"} has a newer release; this changes nothing:`,
				installationCommand(installation, "check", opts.channel),
			);
			presenter.commandAdvice(`If it names a version newer than ${before}, this updates the package:`, updateCommand);
		} else if (opts.channel === "beta") {
			presenter.commandAdvice(
				"See the versions the latest and beta tags name; this changes nothing:",
				installationCommand(installation, "check", opts.channel),
			);
			presenter.commandAdvice(
				`If the newer of the two is newer than ${before}, put it in place of <version>; this replaces the installed package with it, from its original global directory:`,
				installationCommand(installation, "upgrade", "<version>"),
			);
		} else {
			presenter.commandAdvice(
				"See which version the original package manager would install; this changes nothing:",
				installationCommand(installation, "check", opts.channel),
			);
			presenter.commandAdvice(
				`If it is newer than ${before}, this replaces the installed package with it, from its original global directory:`,
				updateCommand,
			);
		}
		presenter.commandAdvice("Then start pancode on the last session:", "pancode --continue");
		if (opts.dryRun) presenter.warn("Dry run: no changes made");
		else
			presenter.fail(
				newer
					? "This installation needs a package-manager update; no package was replaced."
					: "PanCode could not tell whether a newer release is out; no package was replaced.",
			);
		presenter.finish();
		return opts.dryRun ? 0 : 1;
	}

	// An exact --version or --bundle install is pinned: upgrade holds it at the pin
	// and says how to release it, instead of reporting the pin as a registry answer.
	const pin = opts.postInstall || opts.channelExplicit ? null : installation.installer?.versionPin || null;
	const lookup: RegistryLookup = opts.postInstall
		? { asked: false, reason: "post-install checks" }
		: pin
			? { asked: true, version: pin }
			: await deps.lookUpAvailableVersion(opts.channel, method);
	const availableVersion = lookup.asked ? lookup.version : null;

	presenter.step(`Installation method: ${methodLabel}`);
	presenter.step(`Current version: ${before}`);
	if (installation.prefix) presenter.step(`Install prefix: ${installation.prefix}`);
	// A source checkout is not upgraded from the registry, so the registry is
	// never asked. Reporting that as "registry check failed" told the operator a
	// lookup had gone wrong when none was owed.
	if (pin !== null) presenter.step(`Pinned version: ${pin}`);
	else if (availableVersion !== null) presenter.step(`Available version: ${availableVersion}`);
	else if (!lookup.asked) presenter.step(`Available version: not checked (${lookup.reason})`);
	else
		presenter.step(
			`Available version: unknown (no version from ${releaseVersionUrl(opts.channel, releaseSource(method))})`,
		);
	if ((method === "npm" || method === "installer") && !opts.postInstall && pin === null)
		presenter.step(`Channel: ${opts.channel}`);
	if (installation.installer) {
		const record = installation.installer;
		presenter.step(`Runtime: Node v${record.nodeVersion} ${record.nodeBuild}`);
	}
	presenter.step(`State dir: ${shortenPath(stateDir)}`);
	if (pin !== null)
		presenter.note(`This install is ${describeTracking(installation)}. Upgrade and background updates leave it there.`);

	const recorded = readStateInfo()?.version ?? null;
	const describeRefresh = (): string =>
		recorded === null
			? "state metadata (none recorded)"
			: recorded === before
				? `state metadata (already ${before})`
				: `state metadata ${recorded} -> ${before}`;

	// "Already current" is a claim about a version that was compared. A lookup
	// that was made and came back empty has compared nothing, so it does not get
	// to make it: the run falls through and attempts the install, which is what
	// the operator asked for. A lookup that was never owed for a checkout or
	// post-install checks leaves the recorded state version to decide.
	const comparison = availableVersion === null ? null : compareReleaseVersions(availableVersion, before);
	const leavingPrerelease =
		opts.channelExplicit &&
		opts.channel === "latest" &&
		pin === null &&
		!opts.postInstall &&
		(parseReleaseVersion(before)?.pre.length ?? 0) > 0 &&
		availableVersion !== null &&
		parseReleaseVersion(availableVersion)?.pre.length === 0 &&
		comparison !== 0;
	const channelSelectionNeeded =
		opts.channelExplicit &&
		method === "installer" &&
		comparison === 0 &&
		(installation.installer?.channel !== opts.channel || Boolean(installation.installer?.versionPin));
	const versionIsCurrent =
		!leavingPrerelease &&
		!channelSelectionNeeded &&
		(lookup.asked ? comparison !== null && comparison <= 0 : true) &&
		recorded === before;
	if (leavingPrerelease) {
		presenter.note(`Leaving the pre-release channel: installing stable ${availableVersion} from ${before}.`);
	} else if (comparison !== null && comparison < 0)
		presenter.note(`Installed ${before} is newer than ${opts.channel} (${availableVersion}); keeping it.`);

	if (!opts.postInstall && versionIsCurrent) {
		presenter.warn(`Already on ${before}. Nothing to do.`);
		if (method === "source") sourceAdvice();
		if (opts.dryRun && opts.restart) presenter.note(RELAUNCH_PREVIEW);
		if (opts.dryRun) presenter.warn("Dry run: no changes made");
		return unchanged();
	}

	const prepareInstall = async (): Promise<{ invocation: UpgradeInvocation; version: string | null }> => {
		let invocation: UpgradeInvocation;
		let version: string | null = null;
		if (method === "installer")
			invocation = installerUpgradeInvocation(
				installation,
				{ ...opts, leavePrerelease: leavingPrerelease },
				process.platform === "win32",
			);
		else {
			version = availableVersion ?? (await fetchReleaseVersion(opts.channel));
			if (version === null)
				throw new Error(`Cannot resolve the ${opts.channel} channel; retry when the registry is reachable`);
			const npmCli = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
			invocation = npmUpgradeInvocation(installation, version, {
				windows: process.platform === "win32",
				node: process.execPath,
				npmCli: existsSync(npmCli) ? npmCli : null,
			});
		}
		return { invocation, version };
	};

	if (opts.dryRun) {
		if (opts.postInstall) await previewDefaultPacks(presenter);
		else if (method === "source") sourceAdvice();
		else if (comparison === null || comparison > 0 || leavingPrerelease || channelSelectionNeeded) {
			try {
				const { invocation } = await prepareInstall();
				presenter.note(`Would run: ${formatUpgradeInvocation(invocation)}`);
			} catch (err) {
				presenter.note(`Would run: ${updateCommand}`);
				presenter.warn(
					`The ${opts.channel} channel version is unresolved; showing the hand-run plan. ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		presenter.note(`Would refresh ${describeRefresh()}.`);
		if (opts.restart) presenter.note(RELAUNCH_PREVIEW);
		presenter.warn("Dry run: no changes made");
		presenter.done("Done");
		return 0;
	}

	if (opts.postInstall) {
		presenter.note("Running post-install checks with the active pancode binary.");
	} else if (method === "source") {
		presenter.note("Source checkout: no npm install to run.");
	} else if (comparison === null || comparison > 0 || leavingPrerelease || channelSelectionNeeded) {
		try {
			const plan = await prepareInstall();
			const target = method === "npm" ? deferredUpdateTarget(installation, plan.version ?? before) : null;
			const stake = target === null ? null : stakeInstall(target, installation, dirs.cache);
			if (stake !== null && "holders" in stake) {
				presenter.fail(
					"Other PanCode processes of this install are running; nothing was replaced",
					stake.holders.join("\n"),
				);
				presenter.commandAdvice(
					"npm replaces the install in place under them. Quit them and run this again, or run /upgrade in a session to install after every session quits:",
					"pancode upgrade",
				);
				presenter.finish();
				// EX_TEMPFAIL, as the launcher and install.sh exit for a held install.
				return 75;
			}
			presenter.note(`Installing with: ${formatUpgradeInvocation(plan.invocation)}`);
			let installedVersion = plan.version ?? opts.channel;
			if (method === "installer") {
				activeInstallation = await deps.runInstallerUpgrade(installation, plan.invocation);
				const current = activeInstallation.installer?.current;
				const version = current ? installedVersionAt(current) : null;
				installedVersion = version && parseReleaseVersion(version) ? version : opts.channel;
			} else {
				try {
					await deps.runNpmInstall(installation, plan.invocation, stake ? { log: stake.log, signal: stake.signal } : {});
				} finally {
					stake?.release();
				}
			}
			presenter.completedStep(`Installed PanCode ${installedVersion}`);
		} catch (err) {
			presenter.fail(
				method === "installer" ? "install.sh failed" : "npm install failed",
				err instanceof Error ? err.message : String(err),
			);
			presenter.commandAdvice(
				"To upgrade by hand, run:",
				`${await handRunCommand(availableVersion)}\npancode upgrade --post-install`,
			);
			presenter.finish();
			return 1;
		}
		try {
			await deps.runPostInstallUpgrade(opts, activeInstallation, presenter);
			return finish();
		} catch (err) {
			presenter.fail("post-install checks failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To finish the upgrade by hand, run:", "pancode upgrade --post-install");
			presenter.finish();
			return 1;
		}
	}

	if (method === "source") {
		const refresh = describeRefresh();
		initializePancodeHome();
		presenter.completedStep(`Refreshed ${refresh}`);
	} else {
		try {
			await deps.runDoctorFixAfterInstall(installation);
			presenter.completedStep("Checked installation integrity and initialized local state");
		} catch (err) {
			presenter.fail("installation integrity check failed", err instanceof Error ? err.message : String(err));
			presenter.commandAdvice("To resolve the findings by hand, run:", "pancode doctor --fix");
			presenter.finish();
			return 1;
		}
	}

	if (opts.postInstall) await giveDefaultPacks(presenter);
	else if (method === "source") sourceAdvice();

	const after = getVersionInfo().pancode;
	// One closing word on every path, with the outcome above it as steps. The
	// summary used to carry the version arrow, so three exits printed three
	// different shapes of last line.
	if ((recorded ?? before) !== after) presenter.note(`Now on ${after}.`);
	return finish();
}
