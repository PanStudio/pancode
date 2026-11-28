// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	autonomyRank,
	isAutonomyLevel,
	YOLO_CONFINEMENT_PIN_ENV,
	yoloConfinementPinned,
} from "../lib/autonomy/autonomy.js";

/**
 * Names the autonomy a `pancode` started from a tool command may take at most, so a delegated run never gets more
 * autonomy than the session that started it. `run` and an extension's run service refuse `--autonomy yolo` under it.
 */
export const AUTONOMY_CEILING_ENV = "PANCODE_AUTONOMY_CEILING";

/** How many extension-started `pancode run` invocations deep this process sits; `ctx.runs.start` stops at 2. */
export const EXTENSION_RUN_DEPTH_ENV = "PANCODE_EXTENSION_RUN_DEPTH";
export const MAX_EXTENSION_RUN_DEPTH = 2;

// Non-interactive bash sources BASH_ENV before the script admission read, and
// an inherited CDPATH sends a relative cd somewhere the command does not name,
// while admission resolves cds from the command's text alone. ENV stays: no
// non-interactive shell sources it, and apps read it as ENV=production.
const PANCODE_CONTROL_ENV_KEYS = ["PANCODE_INTERACTIVE", "BASH_ENV", "CDPATH"] as const;

/** The keys PanCode writes into a command's environment from its live state; only `process.env` may carry inherited ones. */
export const GENERATED_TOOL_ENV_KEYS = [
	AUTONOMY_CEILING_ENV,
	YOLO_CONFINEMENT_PIN_ENV,
	EXTENSION_RUN_DEPTH_ENV,
] as const;

/**
 * Coordinates of the terminal that hosts this PanCode: its pane host's socket and pane (herdr, tmux, screen, zellij), the
 * terminal emulator's remote-control socket (kitty, WezTerm) and the tty path pinentry draws on. A tool command that
 * inherits them addresses the operator's own terminal: a nested interactive pancode writes this pane's exit marker
 * and the launcher closes the workspace, `tmux send-keys` types into the composer, `tmux kill-server` hangs it up (M-12).
 */
const HOST_TERMINAL_ENV_KEYS = [
	"TMUX",
	"TMUX_PANE",
	"STY",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
	"ZELLIJ_PANE_ID",
	"KITTY_LISTEN_ON",
	"KITTY_WINDOW_ID",
	"WEZTERM_UNIX_SOCKET",
	"WEZTERM_PANE",
	"GPG_TTY",
	"SSH_TTY",
] as const;

let privateTmuxDir: string | null | undefined;

/** The socket directory a tool command's tmux uses, so a bare `tmux` starts its own server; null when none can be made. */
function toolTmuxDir(): string | null {
	if (privateTmuxDir !== undefined) return privateTmuxDir;
	const dir = path.join(tmpdir(), `pancode-tool-tmux-${process.getuid?.() ?? "user"}`);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		privateTmuxDir = dir;
	} catch {
		privateTmuxDir = null;
	}
	return privateTmuxDir;
}

/**
 * Drops the host terminal's coordinates from a tool command's environment, in place. Under tmux a bare `tmux` would still
 * find the server this PanCode runs in through its default socket, so the command gets a private socket directory instead.
 */
export function dropHostTerminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	for (const key of Object.keys(env)) if (key.startsWith("HERDR_")) Reflect.deleteProperty(env, key);
	for (const key of HOST_TERMINAL_ENV_KEYS) Reflect.deleteProperty(env, key);
	if (process.env.TMUX !== undefined && process.env.TMUX !== "") {
		const dir = toolTmuxDir();
		if (dir !== null) env.TMUX_TMPDIR = dir;
	}
	return env;
}

/**
 * Spawn options that start a child in a session of its own, so it has no controlling terminal: it cannot open the TUI's
 * terminal as `/dev/tty`, read its keys or receive its hangup. Spread into the options of a call whose typings omit
 * `detached` (spawnSync, execFileSync); Node honors it there too.
 */
export const TOOL_SESSION_SPAWN: { detached?: boolean } = process.platform === "win32" ? {} : { detached: true };

let toolEnvAutonomy: (() => string) | null = null;
let toolEnvContainedYolo: (() => boolean) | null = null;

/**
 * Registers the live autonomy of this process's session, and whether it runs contained yolo, read on every command so
 * a level change lands at once.
 */
export function setToolEnvAutonomy(read: (() => string) | null, containedYolo: (() => boolean) | null = null): void {
	toolEnvAutonomy = read;
	toolEnvContainedYolo = containedYolo;
}

/** A session below yolo sets its own level; one at yolo passes on only a ceiling it inherited itself. */
function toolEnvAutonomyCeiling(): string | undefined {
	const live = toolEnvAutonomy?.();
	if (live !== undefined && live !== "yolo") return live;
	const inherited = process.env[AUTONOMY_CEILING_ENV];
	return inherited !== undefined && inherited !== "" ? inherited : undefined;
}

/** The stricter of two ceilings: a caller's is kept only when it names a level below the live one. */
function stricterCeiling(live: string | undefined, given: string | undefined): string | undefined {
	if (given === undefined || !isAutonomyLevel(given)) return live;
	if (live === undefined) return given;
	if (isAutonomyLevel(live) && autonomyRank(given) < autonomyRank(live)) return given;
	return live;
}

/** Parses `PANCODE_EXTENSION_RUN_DEPTH`: empty is 0, non-negative decimal integer is its count, anything else is invalid. */
export function parseExtensionRunDepth(raw: string | undefined): number | "invalid" {
	if (raw === undefined) return 0;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return 0;
	if (!/^\d+$/u.test(trimmed)) return "invalid";
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

/** The stricter of two nesting depths: never lower than the process's own, and any malformed value fails closed. */
function stricterRunDepth(live: string | undefined, given: string | undefined): string | undefined {
	const liveDepth = parseExtensionRunDepth(live);
	const givenDepth = parseExtensionRunDepth(given);
	if (liveDepth === "invalid") return String(MAX_EXTENSION_RUN_DEPTH);
	if (givenDepth === "invalid") return String(Math.max(liveDepth, MAX_EXTENSION_RUN_DEPTH));
	const effective = Math.max(liveDepth, givenDepth);
	return effective > 0 ? String(effective) : undefined;
}

/**
 * Drops the keys that steer a shell or PanCode itself from a tool command's environment, then sets the autonomy ceiling,
 * contained-yolo pin and extension run depth from the live state. The environment given may only tighten them: its
 * ceiling stays when it is stricter than the live one, its pin stays (any value reads as contained), and its run depth
 * stays only when higher than the process's own. Bash commands, run_script, verify and every other safe-exec child share it.
 */
export function applyToolEnvControls(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const givenCeiling = env[AUTONOMY_CEILING_ENV];
	const givenPin = yoloConfinementPinned(env);
	const givenDepth = env[EXTENSION_RUN_DEPTH_ENV];
	for (const key of PANCODE_CONTROL_ENV_KEYS) Reflect.deleteProperty(env, key);
	for (const key of GENERATED_TOOL_ENV_KEYS) Reflect.deleteProperty(env, key);
	dropHostTerminalEnv(env);
	const ceiling = stricterCeiling(toolEnvAutonomyCeiling(), givenCeiling);
	if (ceiling !== undefined) env[AUTONOMY_CEILING_ENV] = ceiling;
	// A contained-yolo session, one launched pinned, or a caller pinning its child holds every pancode to contained yolo.
	if (givenPin || toolEnvContainedYolo?.() === true || yoloConfinementPinned())
		env[YOLO_CONFINEMENT_PIN_ENV] = "contained";
	const depth = stricterRunDepth(process.env[EXTENSION_RUN_DEPTH_ENV], givenDepth);
	if (depth !== undefined) env[EXTENSION_RUN_DEPTH_ENV] = depth;
	return env;
}
