// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { canonicalizePath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { commandAssignments, setsVariablesAtRunTime } from "./command-pins.js";
import { scanShellLikeDeep } from "./heredoc-scan.js";
import { COMMAND_SEPARATORS, type ShellToken, scanShellLike } from "./shell-scan.js";
import { inlineShellScript } from "./shell-segments.js";

/**
 * PanCode's own settings, credentials and trust are the operator's. A model that
 * shells out to the settings CLI (`pancode configure --id ...`) saves
 * settings.yaml with no card and no diff; the sandbox refuses the write, and a
 * rerun with `unsandboxed: true` reached the safety judge, which allowed it
 * because the operator had asked for the setup. The model proposes a change
 * through configure_pancode instead, and the operator runs the credential commands.
 */
export const SETTINGS_AUTHORITY_RULE_ID = "settings-authority";

export const SETTINGS_AUTHORITY_REASON =
	"PanCode's settings, credentials and trust change only through the operator: propose a settings change with configure_pancode, which shows the operator the exact diff, and ask the operator to run credential commands such as `pancode auth login` themselves";

const LAUNCHER_PATH = /(?:^|\/)pancode[^/]*\/(?:.*\/)?(?:dist\/cli\/index\.js|src\/cli\/index\.ts|bin\/pancode\.cjs)$/u;
const PACKAGE_SPEC = /^pancode(?:@\S*)?$/u;
const HELP = new Set(["--help", "-h"]);
const REDIRECT = /^(?:\d*[<>]{1,2}[&|]?|&>>?|<<<?-?)$/u;
/**
 * FX-9: a word that may hand a here-document body to a shell the body scan does not see as its reader: a shell named
 * as an argument (`docker exec -i c sh`), a remote, login or privileged shell (`ssh node`, `su`, `sudo -s`).
 */
const BODY_SHELL_RUNNER =
	/^(?:(?:ba|da|z|k|mk|c|tc|a|fi|y|r)?sh|busybox|source|\.|eval|exec|xargs|ssh|su|runuser|sudo|doas|pkexec|docker|podman|kubectl|lxc|chroot|nsenter|machinectl|script|expect)$/u;

/** Whether a quoted here-document body may be skipped: no word outside the bodies may run one as shell. */
function bodiesStayData(script: string): boolean {
	return !scanShellLike(script, true).some((token) => {
		if (token.operator) return false;
		const word = token.value.replace(/^['"]|['"]$/gu, "");
		return BODY_SHELL_RUNNER.test(word.slice(word.lastIndexOf("/") + 1));
	});
}

function isLauncher(token: ShellToken): boolean {
	const word = token.value.replace(/^['"]|['"]$/gu, "");
	// `PANCODE_HOME=/x/pancode` assigns a variable; only a word after it can launch.
	if (/^[A-Za-z_]\w*\+?=/u.test(word)) return false;
	const base = word.slice(word.lastIndexOf("/") + 1);
	if (base === "pancode" || base === "pancode.cjs") return true;
	if (PACKAGE_SPEC.test(word) || LAUNCHER_PATH.test(word)) return true;
	// `$(which pancode) configure` runs the launcher the substitution names.
	return (token.substitutions ?? []).some((script) => /\bpancode\b/u.test(script));
}

function positional(args: ReadonlyArray<string>): string[] {
	return args.filter((arg) => !arg.startsWith("-"));
}

/** True when the words after the launcher change settings, credentials, trust or PanCode's own state. */
function mutatesSettings(args: ReadonlyArray<string>): boolean {
	if (args.some((arg) => arg === "--api-key" || arg.startsWith("--api-key="))) return true;
	if (args.some((arg) => HELP.has(arg))) return false;
	const words = positional(args);
	const [command, sub, third] = words;
	switch (command) {
		case "configure": {
			// Bare `configure` is the setup wizard; only the listing forms read.
			const rest = args.slice(args.indexOf(command) + 1);
			return rest.length === 0 || !rest.every((arg) => ["--json", "--list", "--all"].includes(arg));
		}
		case "targets":
			if (sub === "profile") return third !== undefined && third !== "list" && third !== "bindings";
			return sub !== undefined && ["add", "use", "convert", "remove", "rename"].includes(sub);
		case "auth":
			return sub === "login" || sub === "logout";
		case "config":
			// `config set` and `config unset` save settings.yaml as `configure` does; a `--scope` value may come first.
			return sub === "trust" || words.slice(1).some((word) => word === "set" || word === "unset");
		case "mcp":
			return sub === "trust" || sub === "untrust";
		case "systemone":
			return sub === "use" || sub === "off";
		case "semantic":
			return sub === "configure";
		case "telemetry":
			return sub === "consent" && !(args.includes("--list") && !args.includes("--revoke"));
		case "reset":
		case "uninstall":
			return !args.includes("--dry-run");
		default:
			return false;
	}
}

/**
 * A home a launch may relocate PanCode into: never one of the session's own trees, always inside a tree the session
 * may write (the workspace and its scratch roots).
 */
export interface SettingsHomeScope {
	ownTrees: ReadonlyArray<string>;
	writableRoots: ReadonlyArray<string>;
}

const ROLE_VARIABLES = {
	config: "PANCODE_CONFIG_DIR",
	data: "PANCODE_DATA_DIR",
	state: "PANCODE_STATE_DIR",
} as const;
const HOME_VARIABLES: ReadonlyArray<string> = ["PANCODE_HOME", ...Object.values(ROLE_VARIABLES)];
/** A literal absolute path the shell assigns as written: no expansion, glob or quote. */
const LITERAL_ASSIGNMENT = /^([A-Z_]+)=(\/[^\s$`~*?[\]{}'"\\]*)$/u;

function inside(dir: string, roots: ReadonlyArray<string>, overlap: boolean): boolean {
	return roots.some((root) => {
		const trees = [path.resolve(root), canonicalizePath(root) ?? path.resolve(root)];
		return trees.some((tree) => isSameOrDescendant(dir, tree) || (overlap && isSameOrDescendant(tree, dir)));
	});
}

/**
 * Whether a settings launch runs against a PanCode home its own words place outside the session's trees (lane
 * pc-rc2, maintainer 2026-11-25): its prefix assigns PANCODE_CONFIG_DIR, or PANCODE_HOME while the session sets no
 * PANCODE_CONFIG_DIR, to a literal absolute path, the line assigns those variables nowhere else and sets none at run
 * time, and the config, data and state trees the launch resolves are each inside the workspace or a scratch root and
 * clear of the session's own trees. Such a launch is a write into that directory, which path policy judges.
 */
function relocatedLaunch(prefix: ReadonlyArray<ShellToken>, command: string, scope: SettingsHomeScope): boolean {
	const assigned = new Map<string, string>();
	for (const token of prefix) {
		if (token.operator || token.quoted || (token.substitutions?.length ?? 0) > 0) continue;
		const match = LITERAL_ASSIGNMENT.exec(token.value);
		if (match?.[1] !== undefined && match[2] !== undefined && HOME_VARIABLES.includes(match[1]))
			assigned.set(match[1], match[2]);
	}
	const inherited = (name: string): string | undefined => process.env[name]?.trim() || undefined;
	if (!assigned.has(ROLE_VARIABLES.config) && !(assigned.has("PANCODE_HOME") && !inherited(ROLE_VARIABLES.config)))
		return false;
	if (setsVariablesAtRunTime(command)) return false;
	const elsewhere = commandAssignments(command).some(
		({ name, text }) => HOME_VARIABLES.includes(name) && assigned.get(name) !== text,
	);
	if (elsewhere) return false;
	const value = (name: string): string | undefined => assigned.get(name) ?? inherited(name);
	const home = value("PANCODE_HOME");
	return Object.entries(ROLE_VARIABLES).every(([role, name]) => {
		const dir = value(name) ?? (home === undefined ? undefined : path.join(home, role));
		if (dir === undefined || !path.isAbsolute(dir)) return false;
		const resolved = canonicalizePath(dir) ?? path.resolve(dir);
		return !inside(resolved, scope.ownTrees, true) && inside(resolved, scope.writableRoots, false);
	});
}

/**
 * Whether the line is one simple command: no separator, newline, substitution, process substitution or
 * here-document. The relocation check resolves links when the line is judged, so nothing else on the line may run
 * first and move the home it names (`ln -s <session config> /gym/h && PANCODE_CONFIG_DIR=/gym/h ...`, pc-rc2).
 */
function singleCommand(command: string): boolean {
	if (/\n|<<|`|\$\(|[<>]\(/u.test(command)) return false;
	return !scanShellLike(command).some((token) => token.operator && COMMAND_SEPARATORS.has(token.value));
}

/**
 * True when a shell command runs PanCode's own CLI in a form that changes its
 * settings, credentials or trust. Read forms (`configure --json`, `targets`,
 * `auth status`, `config inspect`, any `--help`) stay allowed. The launcher is
 * found by name, package spec or source path, behind env assignments, wrappers,
 * substitutions and `sh -c` scripts, so autotools `./configure` never matches.
 * With `homes`, a launch its own prefix relocates out of the session's trees
 * ({@link relocatedLaunch}) is not one.
 */
export function invokesSettingsMutation(command: string, homes: SettingsHomeScope | null = null): boolean {
	const scripts = [command];
	const inline = inlineShellScript(command);
	if (inline !== null && inline !== command) scripts.push(inline);
	for (const script of scripts) {
		let segment: ShellToken[] = [];
		const check = (): boolean => {
			const index = segment.findIndex(isLauncher);
			const hit =
				index >= 0 &&
				mutatesSettings(segment.slice(index + 1).map((token) => token.value.replace(/^['"]|['"]$/gu, ""))) &&
				!(
					homes !== null &&
					script === command &&
					singleCommand(command) &&
					relocatedLaunch(segment.slice(0, index), command, homes)
				);
			segment = [];
			return hit;
		};
		let redirectTarget = false;
		// FX-9: a quoted here-document body only a non-shell reads (`python3 - <<'EOF'`) is that program's text, not a launch.
		for (const token of scanShellLikeDeep(script, 0, bodiesStayData(script))) {
			if (token.operator && REDIRECT.test(token.value)) {
				// `2>&1` and `>out.json` belong to the command: drop the fd number and the target word.
				if (/^\d+$/u.test(segment.at(-1)?.value ?? "")) segment.pop();
				redirectTarget = true;
				continue;
			}
			if (token.operator) {
				redirectTarget = false;
				if (check()) return true;
				continue;
			}
			if (redirectTarget) {
				redirectTarget = false;
				continue;
			}
			segment.push(token);
		}
		if (check()) return true;
	}
	return false;
}
