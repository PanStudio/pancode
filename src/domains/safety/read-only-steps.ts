// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { canonicalizeRawPath } from "../../core/path-canonical.js";

/** Read-only inspection commands, each with the arguments that would make it write or run something else. */
export const READ_ONLY_INSPECTION_REFUSALS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["cat", []],
	["ls", []],
	["head", []],
	["tail", []],
	["wc", []],
	["pwd", []],
	["grep", []],
	// `--hostname-bin` runs the named program even with no hyperlink format and stdout piped (x1-3).
	["rg", ["--pre", "--hostname-bin"]],
	["find", ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]],
	["stat", []],
	["which", []],
	["echo", []],
	["printf", []],
	["cut", []],
	["tr", []],
	// `file -C` compiles a magic file into the working directory.
	["file", ["-C", "--compile"]],
	["diff", []],
	["cmp", []],
	["du", []],
	["df", []],
	["tree", ["-o"]],
	["basename", []],
	["dirname", []],
	["realpath", []],
	["readlink", []],
	["date", ["-s", "--set"]],
	["sleep", []],
	["true", []],
	["false", []],
	// Shell control that ends or skips the script writes nothing, so `exit 0; npm test` retires no pass (d).
	["exit", []],
	["return", []],
	[":", []],
	["test", []],
	["[", []],
	// jq has no way to write a file or run a program.
	["jq", []],
]);

/**
 * Stdout filters whose arguments decide whether they only read (x3-4): `sed` with no in-place edit, script file, or
 * `w`/`e`/`r` command, `awk` with no `system`, pipe, redirect, include or program file, `sort` with no output file or
 * compress program, `uniq` with no output operand. Whatever these cannot parse stays a change.
 */
export const READ_ONLY_FILTERS: ReadonlyMap<string, (args: ReadonlyArray<string>) => boolean> = new Map([
	["sed", sedOnlyReads],
	["awk", awkOnlyReads],
	[
		"sort",
		// GNU sort takes any unambiguous prefix of a long option, so `--out=x` is `--output=x` (x4-3).
		(args: ReadonlyArray<string>) =>
			!args.some((arg) => {
				const long = /^--([^=]+)/u.exec(arg)?.[1];
				if (long !== undefined) return "output".startsWith(long) || "compress-program".startsWith(long);
				return /^-[^-]/u.test(arg) && arg.includes("o");
			}),
	],
	["uniq", uniqOnlyReads],
]);

const SED_READ_FLAGS: ReadonlySet<string> = new Set([
	"--quiet",
	"--silent",
	"--regexp-extended",
	"--posix",
	"--separate",
	"--unbuffered",
	"--null-data",
	"--debug",
	"--sandbox",
]);

function sedOnlyReads(args: ReadonlyArray<string>): boolean {
	const scripts = sedScripts(args, false);
	return scripts?.every(sedScriptOnlyReads) === true;
}

/**
 * The inline scripts of a sed invocation. Strict, it answers null for any flag but the read-only ones; lenient, it
 * steps over the others (`-i`, `-s`) and stops at a script read from a file (`-f`), which it does not read.
 */
function sedScripts(args: ReadonlyArray<string>, lenient: boolean): string[] | null {
	const scripts: string[] = [];
	let first: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			first ??= args[index + 1];
			break;
		}
		if (/^-[nErsuz]*e$/u.test(arg) || arg === "--expression") {
			scripts.push(args[index + 1] ?? "");
			index += 1;
		} else if (arg.startsWith("--expression=")) scripts.push(arg.slice("--expression=".length));
		else if (arg === "-l" || arg === "--line-length") index += 1;
		else if (arg.startsWith("-") && arg !== "-") {
			if (/^-[nErsuz]+$/u.test(arg) || SED_READ_FLAGS.has(arg) || arg.startsWith("--line-length=")) continue;
			if (!lenient) return null;
			if (/^-[A-Za-z]*f$/u.test(arg) || arg === "--file" || arg.startsWith("--file=")) return scripts;
		} else first ??= arg;
	}
	if (scripts.length === 0) {
		if (first === undefined) return null;
		scripts.push(first);
	}
	return scripts;
}

/**
 * A sed script made only of commands that print, edit the pattern space or branch. `w`, `W`, `e`, `r`, `R`, an `s`
 * flagged `w` or `e`, and anything this cannot parse answer false. A bracket expression in a regex may hold the
 * delimiter (`s/[/]/x/w out`, x4-3), so the scan steps over it whole (x5-5); an unclosed one answers false.
 */
function sedScriptOnlyReads(script: string): boolean {
	let index = 0;
	const at = () => script[index] ?? "";
	const skip = (pattern: RegExp) => {
		while (index < script.length && pattern.test(at())) index += 1;
	};
	// Past a bracket expression's `]`. A leading `]` (after an optional `^`) is literal, `[:class:]`, `[.x.]` and
	// `[=x=]` nest, and a backslash inside is literal, as GNU sed reads it.
	const bracket = (): boolean => {
		index += 1;
		if (at() === "^") index += 1;
		if (at() === "]") index += 1;
		while (index < script.length) {
			const char = at();
			const kind = script[index + 1] ?? "";
			if (char === "]") {
				index += 1;
				return true;
			}
			if (char === "[" && ".:=".includes(kind) && kind !== "") {
				const end = script.indexOf(`${kind}]`, index + 2);
				if (end < 0) return false;
				index = end + 2;
			} else index += 1;
		}
		return false;
	};
	const closes = (delimiter: string, regex = true): boolean => {
		while (index < script.length) {
			const char = at();
			if (regex && char === "[" && char !== delimiter) {
				if (!bracket()) return false;
				continue;
			}
			index += char === "\\" ? 2 : 1;
			if (char === delimiter) return true;
		}
		return false;
	};
	const address = (): boolean => {
		const char = at();
		if (/[0-9]/u.test(char)) skip(/[0-9~]/u);
		else if (char === "$") index += 1;
		else if (char === "/" || char === "\\") {
			const delimiter = char === "/" ? "/" : (script[index + 1] ?? "");
			index += char === "/" ? 1 : 2;
			if (delimiter === "" || !closes(delimiter)) return false;
			skip(/[IM]/u);
		}
		return true;
	};
	while (index < script.length) {
		skip(/[\s;]/u);
		if (index >= script.length) break;
		if (!address()) return false;
		if (at() === ",") {
			index += 1;
			if (at() === "+" || at() === "~") index += 1;
			if (!address()) return false;
		}
		skip(/[\s!]/u);
		const command = at();
		index += 1;
		if ("{}pPdDnNgGhHxzF=".includes(command) && command !== "") continue;
		if (command === "q" || command === "Q" || command === "l") skip(/[ \t0-9]/u);
		else if (command === "s" || command === "y") {
			const delimiter = at();
			if (delimiter === "" || delimiter === "\\" || delimiter === "\n") return false;
			index += 1;
			if (!closes(delimiter, command === "s") || !closes(delimiter, false)) return false;
			// `w` and `e` stop here and parse next as a command, which refuses them.
			if (command === "s") skip(/[gpiImM0-9]/u);
		} else if (command === "b" || command === "t" || command === "T" || command === ":" || command === "#")
			while (index < script.length && at() !== "\n" && (command === "#" || at() !== ";")) index += 1;
		else return false;
	}
	return true;
}

function awkOnlyReads(args: ReadonlyArray<string>): boolean {
	const programs = awkPrograms(args);
	// A comparison spelled `>` reads as a redirect here, which only costs a pass.
	return programs?.every((program) => !/system|[|>@]/u.test(program)) === true;
}

/** The inline programs of an awk invocation, or null when it names a program file or a flag this cannot read. */
function awkPrograms(args: ReadonlyArray<string>): string[] | null {
	const programs: string[] = [];
	let first: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			first ??= args[index + 1];
			break;
		}
		if (arg === "-F" || arg === "-v" || arg === "--field-separator" || arg === "--assign") index += 1;
		else if (/^-[Fv]./u.test(arg) || arg.startsWith("--field-separator=") || arg.startsWith("--assign=")) continue;
		else if (arg === "-e" || arg === "--source") {
			programs.push(args[index + 1] ?? "");
			index += 1;
		} else if (arg.startsWith("--source=")) programs.push(arg.slice("--source=".length));
		else if (arg.startsWith("-") && arg !== "-") return null;
		else first ??= arg;
	}
	if (programs.length === 0) {
		if (first === undefined) return null;
		programs.push(first);
	}
	return programs;
}

const SED_NAMES: ReadonlySet<string> = new Set(["sed", "gsed"]);

const AWK_NAMES: ReadonlySet<string> = new Set(["awk", "gawk", "mawk", "nawk"]);

/** A sed `w`/`W` command or an `s` flagged `w`, and the file name it runs to the end of the line with. */
const SED_WRITE_FILE = /(?:^|[\s;{}!$0-9]|[/|#,:@%][gpiImMe0-9]*)[wW][ \t]+(\S[^\n]*)/gu;

/** An awk output redirect to a string literal: `print > "/etc/x"`, `printf ... >> "log"`. */
const AWK_WRITE_FILE = />>?[ \t]*"([^"\\\n]+)"/gu;

/**
 * Files a sed or awk script writes itself (LEAD-1): sed's `w`, `W` and `s///w`, and awk's `>` and `>>` to a string
 * literal. Only a script the read-only parsers above refuse is read, and it is read lexically, so text that merely
 * looks like such a command adds a target rather than hiding one. A program file (`sed -f`, `awk -f`) is not read.
 */
export function collectScriptWriteTargets(name: string, args: ReadonlyArray<string>, out: string[]): void {
	if (SED_NAMES.has(name) && !sedOnlyReads(args)) {
		for (const script of sedScripts(args, true) ?? []) {
			for (const match of script.matchAll(SED_WRITE_FILE)) out.push((match[1] ?? "").trim());
		}
	} else if (AWK_NAMES.has(name) && !awkOnlyReads(args)) {
		for (const program of awkPrograms(args) ?? []) {
			for (const match of program.matchAll(AWK_WRITE_FILE)) out.push(match[1] ?? "");
		}
	}
}

function uniqOnlyReads(args: ReadonlyArray<string>): boolean {
	let operands = 0;
	let options = true;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (options && arg === "--") options = false;
		else if (options && ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"].includes(arg)) index += 1;
		else if (options && arg.startsWith("-") && arg !== "-") continue;
		else operands += 1;
	}
	return operands < 2;
}

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"branch",
	"ls-files",
	"rev-list",
	"describe",
	"cat-file",
	"ls-tree",
	"grep",
	"blame",
]);

/** Read-only git subcommands that only read objects and refs, so no configured helper program can run under them. */
const HELPER_FREE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["rev-parse", "rev-list", "ls-tree", "cat-file"]);

/** Git globals that take no value and change neither the repository nor a program Git runs (x6-2). */
const READ_ONLY_GIT_GLOBALS: ReadonlySet<string> = new Set([
	"--no-pager",
	"-P",
	"--no-optional-locks",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-replace-objects",
	"--no-lazy-fetch",
	"--no-advice",
]);

/**
 * Config keys a `git -c key=value` may set on a read-only step: display settings that name no program. Any other key
 * (`core.pager`, `alias.*`, `diff.external`, `*.textconv`, `core.fsmonitor`, `credential.*`, `include.path`) may run
 * one, so it is refused.
 */
const READ_ONLY_GIT_CONFIG_KEY =
	/^(?:color\.[^=]+|advice\.[^=.]+|column\.ui|core\.quotepath|core\.abbrev|diff\.(?:noprefix|mnemonicprefix|relative|renames|renamelimit|algorithm|indentheuristic|context|interhunkcontext|statgraphwidth)|log\.(?:decorate|abbrevcommit|date|follow)|status\.(?:short|branch|showuntrackedfiles|relativepaths)|grep\.(?:linenumber|patterntype|extendedregexp|column|fullname))$/u;

/** Helper config is probed at the recorder's cwd, so only selectors of that same checkout are transparent (x6). */
function sameGitDirectory(cwd: string | undefined, target: string, metadata = false): boolean {
	if (cwd === undefined || target === "" || /[~$`*?[\]{}]/u.test(target)) return false;
	const selected = canonicalizeRawPath(target, cwd);
	const expected = canonicalizeRawPath(metadata ? ".git" : ".", cwd);
	return selected !== null && expected !== null && path.relative(expected, selected) === "";
}

/** The git subcommand and its arguments past the read-only global options; null when a global may run or relocate. */
export function gitSubcommand(
	args: ReadonlyArray<string>,
	gitCwd?: string,
): { subcommand: string; rest: ReadonlyArray<string> } | null {
	let index = 0;
	for (; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (READ_ONLY_GIT_GLOBALS.has(arg)) continue;
		if (arg === "-C") {
			if (!sameGitDirectory(gitCwd, args[index + 1] ?? "")) return null;
			index += 1;
			continue;
		}
		if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
			if (!sameGitDirectory(gitCwd, arg.slice(arg.indexOf("=") + 1), arg.startsWith("--git-dir="))) return null;
			continue;
		}
		if (arg !== "-c") break;
		const setting = args[index + 1] ?? "";
		const key = setting.split("=", 1)[0] ?? "";
		if (!READ_ONLY_GIT_CONFIG_KEY.test(key.toLowerCase()) || setting.includes("!")) return null;
		index += 1;
	}
	const subcommand = args[index];
	if (subcommand === undefined || subcommand.startsWith("-")) return null;
	return { subcommand, rest: args.slice(index + 1) };
}

/** `git cat-file` modes that print an object, its type or its size; `--textconv`, `--filters` and batches stay out. */
const READ_ONLY_CAT_FILE_FLAGS: ReadonlySet<string> = new Set(["-p", "-t", "-s", "-e"]);

/**
 * Where the repository's git config names a helper program (x1-3), `git status` and `git diff` refresh the index
 * and run `core.fsmonitor`, and `git log` and `git show` run an external diff or textconv driver unless both are
 * switched off.
 */
const GIT_HELPER_OPT_OUTS: ReadonlyArray<string> = ["--no-ext-diff", "--no-textconv"];

/** `git branch` flags that only list or name branches; any other argument creates, moves or deletes one. */
const READ_ONLY_GIT_BRANCH_FLAGS: ReadonlySet<string> = new Set([
	"-a",
	"--all",
	"-r",
	"--remotes",
	"-l",
	"--list",
	"-v",
	"-vv",
	"--verbose",
	"--show-current",
	"--no-color",
]);

export function readOnlyInspectionStep(
	argv: ReadonlyArray<string>,
	gitHelpersConfigured: boolean,
	gitCwd?: string,
): boolean {
	const [executable, ...args] = argv;
	if (executable === undefined) return false;
	if (executable === "git") {
		const invocation = gitSubcommand(args, gitCwd);
		if (invocation === null || !READ_ONLY_GIT_SUBCOMMANDS.has(invocation.subcommand)) return false;
		const { subcommand, rest } = invocation;
		if (subcommand === "branch") return rest.every((arg) => READ_ONLY_GIT_BRANCH_FLAGS.has(arg));
		if (subcommand === "rev-parse") return true;
		if (rest.some((arg) => arg.startsWith("--output") || arg === "--ext-diff" || arg === "--textconv")) return false;
		if (subcommand === "cat-file")
			return (
				rest.some((arg) => READ_ONLY_CAT_FILE_FLAGS.has(arg)) &&
				rest.every((arg) => !arg.startsWith("-") || READ_ONLY_CAT_FILE_FLAGS.has(arg))
			);
		// `-O`/`--open-files-in-pager` hands the matches to a program, bundled (`-nOvim`) or not.
		if (subcommand === "grep" && rest.some((arg) => /^-[^-]*O/u.test(arg) || arg.startsWith("--open-files-in-pager")))
			return false;
		if (HELPER_FREE_GIT_SUBCOMMANDS.has(subcommand)) return true;
		if (!gitHelpersConfigured) return true;
		return (subcommand === "log" || subcommand === "show") && GIT_HELPER_OPT_OUTS.every((flag) => rest.includes(flag));
	}
	const filter = READ_ONLY_FILTERS.get(executable);
	if (filter !== undefined) return filter(args);
	const refused = READ_ONLY_INSPECTION_REFUSALS.get(executable);
	if (refused === undefined) return false;
	return !args.some((arg) => refused.some((option) => arg === option || arg.startsWith(`${option}=`)));
}
