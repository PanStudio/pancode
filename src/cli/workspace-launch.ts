// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Whether bare `pancode` opens PanCode's private pane host.
 *
 * The decision is made in the outer process before anything boots, and it is a
 * list of reasons not to: every case where taking over the terminal with a pane
 * host would surprise somebody returns null, and the caller boots PanCode in the
 * plain terminal exactly as it always has. Nothing here prompts.
 *
 * The pane host is part of PanCode, not an option of it. It always runs PanCode's
 * own vendored herdr pin, never a herdr on PATH, so the operator's own herdr,
 * its config and its sessions are left exactly as they are. A home that never
 * had the pane host (an install that skipped it, a fresh `npm install -g`)
 * starts in the plain terminal with one notice and no download, so a first
 * launch never waits on the network. When an upgrade moved the pin of a host
 * that was installed, the new pin is installed here with one line of status,
 * and when that fails PanCode says so in one line and carries on.
 *
 * Inside the operator's own herdr, PanCode opens its own host nested in that pane
 * with a prefix that does not collide with the outer one. Inside PanCode's own
 * host it never opens another: that PanCode is the one the host was started for.
 * `--with-panes` keeps its meaning of joining the current host as a guest, so
 * it never opens a host either.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PancodeSettings } from "../core/config.js";
import { relaunchScript } from "../core/relaunch-script.js";
import type { BootOptions } from "../entry/boot-options.js";

/** Multiplexers PanCode will not nest a pane host inside. */
const HOST_MULTIPLEXER_ENV = ["TMUX", "ZELLIJ", "STY"] as const;

export interface WorkspaceEligibilityInput {
	options: Pick<BootOptions, "headless" | "acp" | "panes">;
	env: Readonly<Record<string, string | undefined>>;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	/** Whether `env.HERDR_SOCKET_PATH` names a host PanCode started. */
	insidePancodeHost: boolean;
}

export type WorkspaceEligibility = { kind: "plain"; reason: string } | { kind: "open"; nested: boolean };

/** Whether this boot opens the private host, and nested in another herdr or not. */
export function workspaceEligibility(input: WorkspaceEligibilityInput): WorkspaceEligibility {
	const plain = (reason: string): WorkspaceEligibility => ({ kind: "plain", reason });
	if (input.options.headless || input.options.acp) return plain("not an interactive session");
	if (input.options.panes === "with") return plain("--with-panes joins the current pane host");
	if (!input.stdinIsTTY || !input.stdoutIsTTY) return plain("not a terminal");
	if (input.env.TERM === "dumb") return plain("TERM is dumb");
	for (const name of HOST_MULTIPLEXER_ENV) {
		if (input.env[name]) return plain(`already inside a terminal multiplexer (${name})`);
	}
	const inHerdr = input.env.HERDR_ENV === "1";
	if (inHerdr && input.insidePancodeHost) return plain("already inside PanCode's pane host");
	return { kind: "open", nested: inHerdr };
}

/** The command line that starts this same PanCode inside the pane. */
function pancodeArgv(): string[] {
	const script = process.argv[1];
	const args = process.argv.slice(2);
	return script === undefined ? [process.execPath, ...args] : [process.execPath, relaunchScript(script), ...args];
}

/** A launch waits this long for the download; the installers and `programs install` keep the full timeout. */
const LAUNCH_INSTALL_TIMEOUT_MS = 30_000;
/** After a failed launch-time install, launches skip the retry this long for the same pin. */
const INSTALL_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function installFailureStamp(stateDir: string): string {
	return join(stateDir, "mux", "herdr-install-failed.json");
}

function recentInstallFailure(stamp: string, version: string, now: number): boolean {
	try {
		const record = JSON.parse(readFileSync(stamp, "utf8")) as { version?: unknown; at?: unknown };
		return record.version === version && typeof record.at === "number" && now - record.at < INSTALL_RETRY_AFTER_MS;
	} catch {
		return false;
	}
}

function writeStamp(stamp: string, version: string): void {
	try {
		mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 });
		writeFileSync(stamp, `${JSON.stringify({ version, at: Date.now() })}\n`, { mode: 0o600 });
	} catch {
		// Without the stamp the next launch says it again.
	}
}

/** Whether any herdr pin was ever installed here, so a missing one is an upgrade's new pin rather than none at all. */
function hadPaneHost(versionDir: string): boolean {
	try {
		return readdirSync(dirname(versionDir)).length > 0;
	} catch {
		return false;
	}
}

/**
 * PanCode's own pinned herdr. On a platform with no pinned herdr build, panes are
 * silently unavailable. A home that never had it starts plain, with no notice
 * and no download: a pane feature's refusal names `pancode panes install`,
 * and /doctor warns (bt-11 #4). A pin an upgrade moved is installed on the spot; a failed install
 * warns once and is not retried at launch for a day, or until the pin moves.
 * The installers, `panes install` and doctor always try.
 */
async function vendoredHerdr(): Promise<{ binaryPath: string; version: string } | null> {
	const { currentProgramPlatform, findPinnedProgram, installProgram, resolveVendoredBinary, programVersionDir } =
		await import("../lib/programs/index.js");
	const present = resolveVendoredBinary("herdr");
	if (present !== null) return present;
	const entry = findPinnedProgram("herdr");
	const platform = currentProgramPlatform();
	if (entry === null || platform === null || entry.downloads[platform] === undefined) return null;
	if (!hadPaneHost(programVersionDir(entry.id, entry.version))) return null;
	const { pancodeStateDir } = await import("../core/xdg.js");
	const stamp = installFailureStamp(pancodeStateDir());
	if (recentInstallFailure(stamp, entry.version, Date.now())) return null;
	process.stderr.write("PanCode: setting up terminal panes (one time)...\n");
	const installed = await installProgram("herdr", { timeoutMs: LAUNCH_INSTALL_TIMEOUT_MS });
	const resolved = installed.ok ? resolveVendoredBinary("herdr") : null;
	if (resolved === null) {
		const why = installed.ok ? "the installed binary was not found" : installed.message.split("\n")[0];
		process.stderr.write(
			`PanCode: terminal panes unavailable (${why}). Continuing in this terminal; run \`pancode panes install\` to retry.\n`,
		);
		writeStamp(stamp, entry.version);
	} else {
		rmSync(stamp, { force: true });
	}
	return resolved;
}

/**
 * The line a failed workspace leaves in the operator's terminal. The pane that printed the cause is gone, so its
 * last stderr lines are repeated here; without them, the way to see the output names the plain boot.
 */
export function workspaceExitNotice(exitCode: number, failure: string | undefined): string {
	const head = `PanCode workspace ended with exit code ${exitCode}`;
	if (failure !== undefined) return `${head}:\n${failure.replace(/^/gmu, "  ")}\n`;
	// A signal exit is the launcher's own hangup or a kill, not a boot failure with output to find.
	if (exitCode >= 128) return `${head}.\n`;
	return `${head}. Its output closed with the pane; run pancode --with-panes to start in this terminal and see it.\n`;
}

/**
 * Open the private pane host when this boot is eligible. Returns the process
 * exit code when the terminal was handed over and has come back, or null when
 * the caller should boot PanCode here.
 */
export async function maybeLaunchWorkspace(
	options: Pick<BootOptions, "headless" | "acp" | "panes">,
	settings: PancodeSettings,
): Promise<number | null> {
	const { isPancodeHostSocket } = await import("../domains/mux/workspace/platform.js");
	const eligibility = workspaceEligibility({
		options,
		env: process.env,
		stdinIsTTY: Boolean(process.stdin.isTTY),
		stdoutIsTTY: Boolean(process.stdout.isTTY),
		insidePancodeHost: isPancodeHostSocket(process.env.HERDR_SOCKET_PATH),
	});
	if (eligibility.kind === "plain") return null;

	const herdr = await vendoredHerdr();
	if (herdr === null) return null;

	const { launchWorkspace } = await import("../domains/mux/workspace/launch.js");
	const { pancodePaneEnv } = await import("../domains/mux/child-env.js");
	// The pane starts PanCode before the host's client is attached, and until then the host cannot say what the
	// terminal paints behind it or how large it is. This process still owns the real terminal, so it asks and
	// hands both on.
	const { probeTerminalBackground, terminalHandover } = await import("../core/terminal-background.js");
	await probeTerminalBackground();
	const result = await launchWorkspace({
		herdrPath: herdr.binaryPath,
		herdrVersion: herdr.version,
		nested: eligibility.nested,
		outputStyle: settings.interface.outputDetail,
		cwd: process.cwd(),
		pancodeArgv: pancodeArgv(),
		pancodeEnv: { ...pancodePaneEnv(process.env, settings.connections), ...terminalHandover() },
		notice: (line) => process.stderr.write(`PanCode: ${line}.\n`),
	});
	if (result.status === "fallback") {
		process.stderr.write(`PanCode: terminal panes unavailable (${result.reason}). Continuing in this terminal.\n`);
		return null;
	}
	// The pane that printed the exit summary is gone; this is the terminal the operator reads.
	if (result.exitSummary !== null) process.stdout.write(result.exitSummary);
	if (result.exitCode !== 0) process.stderr.write(workspaceExitNotice(result.exitCode, result.failure));
	if (result.workspaceLeftRunning) {
		process.stdout.write("PanCode workspaces are still open. Run `pancode` to return to them.\n");
	}
	return result.exitCode;
}
