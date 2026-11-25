// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
const SHELL_WRAPPERS = new Set(["command", "builtin", "sudo", "doas"]);

/**
 * Reserved words that can stand before a command in the same segment: a brace
 * group, a negation, and the heads of if, loop, and else bodies. Without them
 * `if true; then cd /x; fi` read `then` as the command and hid the cd.
 */
export const SHELL_RESERVED_PREFIXES: ReadonlySet<string> = new Set([
	"{",
	"!",
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"do",
	"time",
]);

export function commandTokenIndex(segment: ReadonlyArray<string>, start = 0): number | null {
	let index = start;
	while (index < segment.length) {
		const token = segment[index];
		if (token === undefined) return null;
		if (SHELL_RESERVED_PREFIXES.has(token)) {
			// `time -p` is the POSIX spelling of the reserved word.
			index += token === "time" && segment[index + 1] === "-p" ? 2 : 1;
			continue;
		}
		if (isEnvAssignment(token)) {
			index += 1;
			continue;
		}
		if (token === "env") {
			index += 1;
			for (let option = segment[index]; option !== undefined; option = segment[index]) {
				if (option.startsWith("-")) index += ENV_VALUE_OPTIONS.has(option) ? 2 : 1;
				else if (isEnvAssignment(option)) index += 1;
				else break;
			}
			continue;
		}
		if (SHELL_WRAPPERS.has(token)) {
			const wrapperIndex = index;
			index += 1;
			const valued = token === "sudo" || token === "doas" ? PRIVILEGE_VALUE_OPTIONS : undefined;
			for (let option = segment[index]; option?.startsWith("-") === true; option = segment[index]) {
				// `command -v` and `-V` only describe the names after them, so `command` itself is what runs.
				if (token === "command" && /^-[a-zA-Z]*[vV]/u.test(option)) return wrapperIndex;
				index += valued?.has(option) === true ? 2 : 1;
				if (option === "--") break;
			}
			continue;
		}
		const past = pastTransparentWrapper(segment, index);
		if (past !== index) {
			index = past;
			continue;
		}
		return index;
	}
	return null;
}

/** The index past a transparent wrapper standing at `index` and its options, or `index` when none stands there. */
export function pastTransparentWrapper(segment: ReadonlyArray<string>, index: number): number {
	const token = segment[index];
	// `corepack pnpm run lint` runs the pinned pnpm on the same words; corepack's own commands (`enable`, `use`) do not.
	if (token === "corepack") return COREPACK_MANAGERS.has(segment[index + 1] ?? "") ? index + 1 : index;
	const valued = token === undefined ? undefined : TRANSPARENT_WRAPPERS.get(token);
	if (valued === undefined) return index;
	let next = index + 1;
	for (let option = segment[next]; option?.startsWith("-") === true; option = segment[next]) {
		next += valued.has(option) ? 2 : 1;
		if (option === "--") break;
	}
	// timeout's duration stands between its options and the command it runs.
	return token === "timeout" ? next + 1 : next;
}

/**
 * `env` options that take the next word as their value. `-C`/`--chdir` move the command elsewhere and `-S` re-splits a
 * string, which {@link wrapperMovesDirectory} holds against a check.
 */
export const ENV_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-u",
	"--unset",
	"-C",
	"--chdir",
	"-S",
	"--split-string",
]);

/** `sudo` and `doas` options that take the next word as their value (`sudo -u bob npm test` runs npm). */
export const PRIVILEGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-u",
	"--user",
	"-g",
	"--group",
	"-C",
	"--close-from",
	"-D",
	"--chdir",
	"-h",
	"--host",
	"-p",
	"--prompt",
	"-r",
	"--role",
	"-t",
	"--type",
	"-T",
	"--command-timeout",
	"-U",
	"--other-user",
]);

/**
 * Commands that run the rest of their segment unchanged, each with its options that take the next word as a value:
 * `timeout [opts] DURATION`, `nice [-n N | -N]`, `xvfb-run [opts]`, `stdbuf [-i|-o|-e MODE]`, `ionice [-c C] [-n N]`
 * and `nohup` (SF-2). The command after them is the one every reader judges, so `timeout 300 npm test` runs a check
 * and `timeout 5 rm -rf x` deletes.
 */
/** Package managers `corepack <manager>` runs with the rest of the words unchanged (CLI-P24). */
const COREPACK_MANAGERS: ReadonlySet<string> = new Set(["npm", "npx", "pnpm", "yarn"]);

export const TRANSPARENT_WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["timeout", new Set(["-s", "--signal", "-k", "--kill-after"])],
	["nice", new Set(["-n", "--adjustment"])],
	["stdbuf", new Set(["-i", "-o", "-e"])],
	["ionice", new Set(["-c", "--class", "-n", "--classdata"])],
	["nohup", new Set<string>()],
	[
		"xvfb-run",
		new Set([
			"-e",
			"--error-file",
			"-f",
			"--auth-file",
			"-n",
			"--server-num",
			"-p",
			"--xauth-protocol",
			"-s",
			"--server-args",
			"-w",
			"--wait",
		]),
	],
]);

export const NO_WRAPPERS = (): ReadonlyArray<string> => [];

export function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** True for a command word that names a file by a relative path (`./x`, `bin/x`), not a bare name or absolute path. */
export function isRelativeCommandPath(token: string | undefined): boolean {
	if (token === undefined) return false;
	const normalized = token.replace(/\\/g, "/");
	return (
		normalized.includes("/") &&
		!normalized.startsWith("/") &&
		!normalized.startsWith("~") &&
		!/^[A-Za-z]:\//u.test(normalized)
	);
}

export function basenameToken(token: string | undefined): string {
	if (token === undefined) return "";
	const normalized = token.replace(/\\/g, "/");
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	return basename.toLowerCase();
}
