// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Dirent } from "node:fs";
import { lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { PathWalkMemo } from "../../core/path-canonical.js";
import { quotedStep, rgConfigRefusal } from "./policy-command-tables.js";
import type { ReadScopeExemptRoot } from "./read-scope.js";
import { readScopeEscape } from "./read-scope.js";
import type { ShellToken } from "./shell-scan.js";
import { scanShellLike } from "./shell-scan.js";

/**
 * Segment ceiling. Models pad inspection chains with `echo "---X---"` headers,
 * and a flywheel chain of twelve such steps parked at a ceiling of eight. Every
 * step is still judged on its own.
 */
export const CHAIN_MAX_SEGMENTS = 16;

/** What read-only recognition needs to hold a path operand to the workspace, as the read tools are. */
export interface ReadScopeInputs {
	exemptRoots: ReadonlyArray<ReadScopeExemptRoot>;
	memo: PathWalkMemo;
	/** False for a path a zero-access entry covers, the way `readablePath` judges it. */
	readable(target: string): boolean;
	/** Directory entries rg recognition may still visit in this one evaluation, across every operand and chain step. */
	walkBudget: { remaining: number };
	/**
	 * Why recognition refused a step, in the order it found them. The first one
	 * leads the guidance an unrecognized decision carries, so a headless denial
	 * names the step to change instead of only the generic recognized forms.
	 */
	notes: string[];
}

export interface ChainRecognition {
	ruleIds: ReadonlyArray<string>;
	/** Explicit project policy confirmation asks in default and is skipped in yolo. */
	requiresConfirmation: boolean;
	/** Built-in project scripts ask in default and run in yolo. */
	requiresAutonomyApproval: boolean;
	/** One step is a built-in test runner, which executes repository code. */
	runsTestRunner: boolean;
	scriptPreviews: ReadonlyArray<string>;
	/** Source spans of the variable references and value list a recognized read-only loop proved. */
	provenSpans: ReadonlyArray<{ start: number; end: number }>;
}

/** Operators that join two commands the recognizer checks one by one. `&`, subshells and here-strings stay out. */
export const CHAIN_OPERATORS: ReadonlySet<string> = new Set(["&&", "||", ";", "|"]);

/**
 * A redirection that only discards output or merges descriptors: `2>/dev/null`,
 * `&>/dev/null`, `2>&1`, `>&2`. Anything that names a file is a write.
 */
export function isDiscardRedirection(operator: string, target: string | undefined): boolean {
	if (target === undefined) return false;
	if ((operator === ">" || operator === ">>" || operator === "&>" || operator === "&>>") && target === "/dev/null")
		return true;
	return operator === ">&" && /^[12]$/u.test(target);
}

/**
 * Commands that only read files or transform their input, each with the options
 * that would make it write, execute, walk a tree, or name an input list or
 * output file. A command outside this table, or one carrying a refused option,
 * leaves the whole compound unrecognized, so the autonomy level decides it as
 * before. The table stays short on purpose: every wider member (jq, diff, du,
 * tree, sort, column) had an option that read a list file, walked a tree,
 * printed the environment or wrote a file, and a per-option denylist over a
 * wide vocabulary kept leaking. The byte and checksum inspectors (M-49) join
 * with those options refused: `file` compiles a magic file, reads a name list,
 * follows links and runs decompressors; the checksums read a check list; xxd
 * writes its second operand ({@link xxdOnlyInspects}). awk, xargs, env and the
 * shells stay out because their arguments are programs.
 */
const READ_ONLY_INSPECTORS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["cat", []],
	["head", []],
	["tail", ["-f", "-F", "--follow", "--retry"]],
	["wc", ["--files0-from"]],
	["nl", []],
	[
		"ls",
		[
			"-L",
			"-H",
			"-R",
			"--recursive",
			"--dereference",
			"--dereference-command-line",
			"--dereference-command-line-symlink-to-dir",
		],
	],
	["pwd", []],
	["stat", []],
	["basename", []],
	["dirname", []],
	["realpath", []],
	["readlink", []],
	["echo", []],
	// printf -v assigns a shell variable, so `printf -v PATH bin && cat a.txt` would run a workspace
	// binary as cat. No other entry here assigns one.
	["printf", ["-v"]],
	["true", []],
	["which", []],
	// -s and --set change the clock, and -f reads a list of dates from a file. A bare operand that is not a `+FORMAT`
	// also sets the clock, which dateOperandsOnlyFormat refuses.
	["date", ["-s", "--set", "-f", "--file"]],
	["cut", []],
	["tr", []],
	["grep", ["-f", "--file", "--exclude-from"]],
	["egrep", ["-f", "--file", "--exclude-from"]],
	["fgrep", ["-f", "--file", "--exclude-from"]],
	["rg", ["-f", "--file", "-L", "--follow", "--pre", "--pre-glob", "-z", "--search-zip", "--hostname-bin"]],
	[
		"find",
		[
			"-L",
			"-follow",
			"-files0-from",
			"-exec",
			"-execdir",
			"-ok",
			"-okdir",
			"-delete",
			"-fprint",
			"-fprint0",
			"-fprintf",
			"-fls",
		],
	],
	["od", []],
	["xxd", []],
	["hexdump", ["-f", "--format-file"]],
	["cmp", []],
	["sha256sum", ["-c", "--check"]],
	["md5sum", ["-c", "--check"]],
	[
		"file",
		[
			"-C",
			"--compile",
			"-f",
			"--files-from",
			"-m",
			"--magic-file",
			"-L",
			"--dereference",
			"-z",
			"--uncompress",
			"-Z",
			"--uncompress-noreport",
		],
	],
]);

/**
 * Short option letters that take a value, per command. In a cluster the first
 * such letter ends the flags: everything after it is that option's value
 * (`grep -efoo`, `head -qn20`, `cut -d,`), a number, pattern or format that
 * names no file, so it must not be read as more flags. Letters that would take
 * a file (`grep -f`) are in the refused list instead, and a refused letter is
 * still caught when it is the value-taking one (`grep -f.env`, `grep -nf.env`).
 */
const SHORT_VALUE_LETTERS: ReadonlyMap<string, string> = new Map([
	["head", "nc"],
	["tail", "ncs"],
	["cut", "dfbc"],
	["grep", "efmABCdD"],
	["egrep", "efmABCdD"],
	["fgrep", "efmABCdD"],
	["rg", "eABCmgtT"],
	["ls", "wIT"],
	["stat", "c"],
	["nl", "bdfhilnsvw"],
	["basename", "s"],
	["date", "dfrsI"],
	["hexdump", "efns"],
	["file", "eFfmP"],
]);

/** xxd option words that take the next word as their value; xxd matches whole words, never clusters. */
const XXD_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-c",
	"-cols",
	"-g",
	"-groupsize",
	"-l",
	"-len",
	"-n",
	"-name",
	"-o",
	"-offset",
	"-s",
	"-seek",
	"-R",
]);

/**
 * True when xxd only prints: no revert (`-r`, `-revert`) and at most one file operand, since `xxd in out` writes `out`
 * (M-49). A word that may be an option's value is counted as an operand, so a miscount only refuses.
 */
function xxdOnlyInspects(args: ReadonlyArray<string>): boolean {
	let operands = 0;
	let valueNext = false;
	let ended = false;
	for (const arg of args) {
		if (valueNext) {
			valueNext = false;
			continue;
		}
		if (!ended && arg === "--") {
			ended = true;
			continue;
		}
		if (!ended && arg.startsWith("-") && arg !== "-") {
			if (arg.startsWith("-r")) return false;
			valueNext = XXD_VALUE_OPTIONS.has(arg);
			continue;
		}
		operands += 1;
	}
	return operands <= 1;
}

/** `sed -n` with a print-only line script (`1,80p`, `5p`, `10,$p`); every other sed program can write or execute. */
const SED_PRINT_SCRIPT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/u;

/** `$?` or `${?}`, the previous command's exit status. */
const EXIT_STATUS_PARAMETER = /\$(?:\?|\{\?\})/gu;

/** Commands that only print their operands; `printf -v` is refused by READ_ONLY_INSPECTORS. */
const PRINT_ONLY_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf"]);

/**
 * The command with each `$?` that is an `echo` or `printf` operand replaced
 * by `0`. Bash expands `$?` to a decimal integer, so as a printed operand it
 * hides no path or option, and `pytest -q; echo $?` is how a model reads an
 * exit code. Fleet repair workers had that compound refused as hidden content
 * at default admission, so the loop could not inspect its own run. Anywhere
 * else `$?` stays hidden content: `cat "a$?"` reads `a0`, not the judged `a$?`.
 */
export function maskPrintedExitStatus(command: string): string {
	if (!command.includes("$")) return command;
	let segmentHead: string | undefined;
	let masked = "";
	let cursor = 0;
	for (const token of scanShellLike(command)) {
		if (token.operator) {
			segmentHead = undefined;
			continue;
		}
		if (segmentHead === undefined) {
			segmentHead = token.value;
			continue;
		}
		if (!PRINT_ONLY_COMMANDS.has(segmentHead) || token.substitutions !== undefined) continue;
		masked +=
			command.slice(cursor, token.start) + command.slice(token.start, token.end).replace(EXIT_STATUS_PARAMETER, "0");
		cursor = token.end;
	}
	return masked + command.slice(cursor);
}

/**
 * True when the source text of one shell word carries an expansion the
 * recognizer does not perform: tilde and brace expansion, pathname globs, and
 * ANSI-C or locale quoting (`$'\x2fetc'`). The word's own `quoted` flag is
 * too coarse for this, because one quoted fragment marks the whole word
 * (`.e*''` is still a glob), so the raw text is walked with its quoting.
 * `revisions` reads the word as a Git argument, where `HEAD~3`, `HEAD@{1}`
 * and `v1^{commit}` are revision spellings: a tilde counts only at the start
 * of the word and a brace only when bash would expand it (a comma or `..`).
 */
export function hasUnquotedExpansion(raw: string, revisions = false): boolean {
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (quote === "'") {
			if (char === "'") quote = null;
			continue;
		}
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (revisions && char === "~" && index > 0) continue;
		if (revisions && char === "{") {
			const close = raw.indexOf("}", index);
			if (close === -1 || /,|\.\./u.test(raw.slice(index + 1, close))) return true;
			continue;
		}
		if (revisions && char === "}") continue;
		if (char !== undefined && "~{}*?[".includes(char)) return true;
		if (char === "$" && (raw[index + 1] === "'" || raw[index + 1] === '"')) return true;
	}
	return false;
}

/**
 * GNU getopt_long accepts any unambiguous prefix of a long option, so `--out`
 * is `--output`. An ambiguous prefix is an error there, which makes refusing
 * every prefix (with or without `=value`) safe: it costs an ask at worst.
 */
export function abbreviatesLongOption(arg: string, option: string): boolean {
	if (!arg.startsWith("--") || arg === "--" || !option.startsWith("--")) return false;
	const name = (arg.split("=", 1)[0] ?? "").slice(2);
	return name.length > 0 && option.slice(2).startsWith(name);
}

const RG_FLAG_LETTERS = /^-[nisSwxvlcHIFNoqa]+$/u;

const RG_VALUE_SHORT = new Set(["-A", "-B", "-C", "-m", "-g", "-t", "-T"]);

const RG_FLAGS: ReadonlySet<string> = new Set([
	"--line-number",
	"--ignore-case",
	"--smart-case",
	"--case-sensitive",
	"--fixed-strings",
	"--word-regexp",
	"--line-regexp",
	"--invert-match",
	"--count",
	"--files-with-matches",
	"--files-without-match",
	"--only-matching",
	"--no-heading",
	"--heading",
	"--with-filename",
	"--no-filename",
	"--no-line-number",
	"--no-messages",
	"--quiet",
	"--text",
]);

const RG_VALUE_LONG = new Set([
	"--regexp",
	"--glob",
	"--type",
	"--max-count",
	"--after-context",
	"--before-context",
	"--context",
]);

/**
 * rg recurses by default, and a directory walk reaches zero-access files
 * (`*.pem`, `kubeconfig`) that naming the directory does not mention. It is
 * recognized only when it names at least one operand after the pattern and
 * every operand is an existing regular file, or a directory
 * {@link directoryHoldsNoProtectedFile} proves cannot reach one. The pattern
 * position shifts with `-e`/`--regexp`, so only flags this parser knows are
 * accepted; any other option, `-f`, or a stdin `-` operand is ambiguous and
 * refused.
 */
interface RgArgs {
	/** Non-option words with their index in the argument list. */
	positionals: ReadonlyArray<{ arg: string; index: number }>;
	explicitPattern: boolean;
	listsFiles: boolean;
}

/** Only the options this parser knows; any other option, or a stdin `-` operand, is null. */
function parseRgArgs(args: ReadonlyArray<string>): RgArgs | null {
	const positionals: Array<{ arg: string; index: number }> = [];
	let explicitPattern = false;
	let listsFiles = false;
	let optionsEnded = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (!optionsEnded && arg === "--files") {
			listsFiles = true;
			continue;
		}
		if (optionsEnded || !arg.startsWith("-") || arg === "-") {
			if (arg === "-") return null;
			positionals.push({ arg, index });
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg : arg.slice(0, eq);
			if (RG_FLAGS.has(arg)) continue;
			if (!RG_VALUE_LONG.has(name)) return null;
			if (name === "--regexp") explicitPattern = true;
			if (eq === -1) {
				if (index + 1 >= args.length) return null;
				index += 1;
			}
			continue;
		}
		if (RG_FLAG_LETTERS.test(arg)) continue;
		const flag = arg.slice(0, 2);
		if (flag === "-e") {
			explicitPattern = true;
			if (arg.length === 2) {
				if (index + 1 >= args.length) return null;
				index += 1;
			}
			continue;
		}
		if (RG_VALUE_SHORT.has(flag)) {
			if (arg.length === 2) {
				if (index + 1 >= args.length) return null;
				index += 1;
			}
			continue;
		}
		return null;
	}
	return { positionals, explicitPattern, listsFiles };
}

function rgSearchStaysReadable(
	args: ReadonlyArray<string>,
	cwd: string,
	piped: boolean,
	readScope: ReadScopeInputs,
): boolean {
	const parsed = parseRgArgs(args);
	if (parsed === null) return false;
	const { explicitPattern, listsFiles } = parsed;
	const positionals = parsed.positionals.map((entry) => entry.arg);
	// `--files` prints the paths rg would search and opens no file, so it lists
	// like `find` does. Its operands are walk roots; the caller holds them to
	// the workspace.
	if (listsFiles) return !explicitPattern;
	const operands = explicitPattern ? positionals : positionals.slice(1);
	if (!explicitPattern && positionals.length === 0) return false;
	// Fed by a pipe and naming no file, rg reads stdin and opens nothing.
	if (operands.length === 0) return piped;
	return operands.every((operand) => {
		try {
			const target = path.resolve(cwd, operand);
			const stats = statSync(target);
			return stats.isFile() || (stats.isDirectory() && directoryHoldsNoProtectedFile(target, readScope));
		} catch {
			// A path that cannot be stat'ed is not an existing file or directory.
			return false;
		}
	});
}

/**
 * Entries the directory walks of one evaluation may visit in total before
 * recognition gives up and the call asks. The walk is synchronous, so an
 * allowance per operand would let a long argument list or a chain of rg steps
 * multiply the time admission blocks the event loop.
 */
export const RG_WALK_BUDGET = 10_000;

/**
 * True when every entry under `dir` is readable, so an rg walk of it cannot
 * print a zero-access file. The walk is a superset of what rg searches: it
 * prunes nothing. Hidden entries stay in because an ignore file's `!.env`
 * line or a `--glob` whitelist makes rg search them without any flag this
 * parser refuses. Symlinks are listed but not followed, as rg without `-L`
 * (refused above) does not follow them either; `readable` still judges one by
 * where it points. A tree larger than the budget, or a directory that cannot
 * be listed, is not proven and asks.
 */
function directoryHoldsNoProtectedFile(dir: string, { readable, walkBudget }: ReadScopeInputs): boolean {
	if (!readable(dir)) return false;
	const pending = [dir];
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			// A directory that cannot be listed cannot be proven free of protected files.
			return false;
		}
		for (const entry of entries) {
			walkBudget.remaining -= 1;
			if (walkBudget.remaining < 0) return false;
			const full = path.join(current, entry.name);
			if (!readable(full)) return false;
			if (entry.isDirectory()) pending.push(full);
		}
	}
	return true;
}

const GREP_FAMILY: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep"]);

const GREP_VALUELESS_LONG: ReadonlySet<string> = new Set([
	"--line-number",
	"--ignore-case",
	"--word-regexp",
	"--line-regexp",
	"--invert-match",
	"--count",
	"--files-with-matches",
	"--files-without-match",
	"--only-matching",
	"--no-messages",
	"--quiet",
	"--silent",
	"--text",
	"--extended-regexp",
	"--fixed-strings",
	"--perl-regexp",
	"--basic-regexp",
	"--with-filename",
	"--no-filename",
]);

const GREP_ATTACHED_LONG: ReadonlySet<string> = new Set([
	"--include",
	"--exclude",
	"--exclude-dir",
	"--color",
	"--colour",
	"--max-count",
	"--context",
	"--after-context",
	"--before-context",
]);

/**
 * Where the search pattern sits in the arguments of `rg` or a grep-family
 * command, or null when the form is not read with certainty. The pattern is a
 * regular expression, never opened as a path, so the operand checks skip it.
 * A pattern such as `"balance\(|income statement"` carries whitespace and a
 * backslash, which `spacedPathOperand` reads as a path hiding a traversal. An
 * `-e`/`-f`/`--regexp` form has no positional pattern, and any option this
 * parse does not know could take a value that shifts the position, so those
 * stay null and every word keeps the path checks.
 */
function searchPatternIndex(command: string, args: ReadonlyArray<string>): number | null {
	if (command === "rg") {
		const parsed = parseRgArgs(args);
		if (parsed === null || parsed.explicitPattern || parsed.listsFiles) return null;
		return parsed.positionals[0]?.index ?? null;
	}
	if (!GREP_FAMILY.has(command)) return null;
	// GNU grep permutes options, so `grep /etc/passwd -e root` takes its pattern
	// from the later `-e` and every positional is a file.
	if (
		args.some(
			(arg) => abbreviatesLongOption(arg, "--regexp") || abbreviatesLongOption(arg, "--file") || /^-[^-]*[ef]/u.test(arg),
		)
	)
		return null;
	const valueLetters = SHORT_VALUE_LETTERS.get(command) ?? "";
	let optionsEnded = false;
	for (const [index, arg] of args.entries()) {
		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (optionsEnded || !arg.startsWith("-") || arg === "-") return arg === "-" ? null : index;
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq === -1 ? GREP_VALUELESS_LONG.has(arg) : GREP_ATTACHED_LONG.has(arg.slice(0, eq))) continue;
			return null;
		}
		if (!/^-[A-Za-z]+$/u.test(arg) || [...arg.slice(1)].some((letter) => valueLetters.includes(letter))) return null;
	}
	return null;
}

/**
 * grep walks directories with `-r`, `-R`, `--recursive` and `-d recurse`
 * (`--directories=recurse`, also inside a short cluster like `-rn` or `-drecurse`).
 * The walk reaches zero-access files that naming them directly would not.
 */
export function recursesDirectories(args: ReadonlyArray<string>): boolean {
	for (const [index, arg] of args.entries()) {
		if (arg === "--") break;
		if (abbreviatesLongOption(arg, "--recursive") || abbreviatesLongOption(arg, "--dereference-recursive")) return true;
		if (abbreviatesLongOption(arg, "--directories")) {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (args[index + 1] ?? "");
			if (value.startsWith("rec")) return true;
			continue;
		}
		if (/^-[^-]/u.test(arg)) {
			const cluster = arg.slice(1);
			if (/[rR]/u.test(cluster)) return true;
			const dAt = cluster.indexOf("d");
			if (dAt !== -1) {
				const attached = cluster.slice(dAt + 1);
				if ((attached.length > 0 ? attached : (args[index + 1] ?? "")).startsWith("rec")) return true;
			}
		}
	}
	return false;
}

/**
 * A recursive grep walks exactly as rg does, so it is held to the same proof
 * rg got in 63d15ea8e: every operand is an existing regular file or a
 * directory {@link directoryHoldsNoProtectedFile} proves cannot reach a
 * zero-access file. GNU grep -r follows no symlink below the command line,
 * which matches that walk; -R follows them all, so it is never recognized.
 * The pattern must sit where {@link searchPatternIndex} places it with
 * certainty, and with no operand grep -r searches the working directory.
 * Words after the pattern that start with `-` are options, since GNU grep
 * permutes its arguments; an option value spelled as a separate word reads as
 * an operand here, fails the walk check, and costs only an ask.
 */
function grepWalkStaysReadable(
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	readScope: ReadScopeInputs,
): boolean {
	for (const arg of args) {
		if (arg === "--") break;
		if (abbreviatesLongOption(arg, "--dereference-recursive")) return false;
		if (/^-[^-]/u.test(arg) && arg.slice(1).includes("R")) return false;
	}
	const patternAt = searchPatternIndex(command, args);
	if (patternAt === null) return false;
	const operands: string[] = [];
	let optionsEnded = args.slice(0, patternAt).includes("--");
	for (const arg of args.slice(patternAt + 1)) {
		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && arg.startsWith("-")) {
			if (arg === "-") return false;
			continue;
		}
		operands.push(arg);
	}
	return (operands.length === 0 ? ["."] : operands).every((operand) => {
		try {
			const target = path.resolve(cwd, operand);
			const stats = statSync(target);
			return stats.isFile() || (stats.isDirectory() && directoryHoldsNoProtectedFile(target, readScope));
		} catch {
			// A path that cannot be stat'ed is not an existing file or directory.
			return false;
		}
	});
}

/**
 * The words bash passes for one shell word whose only expansion is `*` or `?`,
 * or null when the expansion cannot be bounded. The matcher is deliberately
 * wider than bash's defaults: `*` and `?` also match a leading dot and ignore
 * case, so an inherited `dotglob`, `GLOBIGNORE` or `nocaseglob` can only
 * narrow what bash passes, and every candidate here is held to the operand
 * checks. A glob component that starts with a literal dot is refused because
 * `.*` matches `..` in older bash. `**` (globstar), brackets, braces, tilde,
 * extglob, quoting escapes and variables are refused rather than modeled.
 * Directory listings draw on the evaluation's shared walk budget.
 */
export function expandOperandGlob(raw: string, cwd: string, readScope: ReadScopeInputs): string[] | null {
	const chars: Array<{ char: string; glob: boolean }> = [];
	let quote: "'" | '"' | null = null;
	for (const char of raw) {
		if (quote !== null) {
			if (char === quote) quote = null;
			else if (quote === '"' && "$`\\".includes(char)) return null;
			else chars.push({ char, glob: false });
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if ("\\$`~{}[]()!@+".includes(char)) return null;
		chars.push({ char, glob: char === "*" || char === "?" });
	}
	if (quote !== null) return null;
	const components: Array<Array<{ char: string; glob: boolean }>> = [[]];
	for (const entry of chars) {
		if (entry.char === "/" && !entry.glob) components.push([]);
		else components.at(-1)?.push(entry);
	}
	const absolute = components[0]?.length === 0 && components.length > 1;
	if (absolute) components.shift();
	// An empty component (`a//b`, a trailing `/`) changes what bash matches; refuse it.
	if (components.some((component) => component.length === 0)) return null;
	let candidates: string[] = [absolute ? "/" : ""];
	for (const [index, component] of components.entries()) {
		const text = component.map((entry) => entry.char).join("");
		const join = (base: string, name: string): string =>
			base === "" ? name : base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
		if (!component.some((entry) => entry.glob)) {
			candidates = candidates.map((base) => join(base, text));
			continue;
		}
		if (component[0]?.char === ".") return null;
		if (component.some((entry, at) => entry.char === "*" && entry.glob && component[at + 1]?.char === "*")) return null;
		const pattern = new RegExp(
			`^${component
				.map((entry) =>
					entry.glob ? (entry.char === "*" ? "[^/]*" : "[^/]") : entry.char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
				)
				.join("")}$`,
			"iu",
		);
		const last = index === components.length - 1;
		const next: string[] = [];
		for (const base of candidates) {
			let entries: Dirent[];
			try {
				entries = readdirSync(path.resolve(cwd, base === "" ? "." : base), { withFileTypes: true });
			} catch {
				// bash matches nothing in a directory it cannot list.
				continue;
			}
			for (const entry of entries) {
				readScope.walkBudget.remaining -= 1;
				if (readScope.walkBudget.remaining < 0) return null;
				if (!pattern.test(entry.name)) continue;
				const candidate = join(base, entry.name);
				if (!last && !entry.isDirectory()) {
					if (!entry.isSymbolicLink()) continue;
					try {
						if (!statSync(path.resolve(cwd, candidate)).isDirectory()) continue;
					} catch {
						// A dangling link is no directory for bash to descend into.
						continue;
					}
				}
				next.push(candidate);
			}
		}
		candidates = next;
	}
	// A literal component after a glob matches only when the path exists.
	return candidates.filter(
		(candidate) => lstatSync(path.resolve(cwd, candidate), { throwIfNoEntry: false }) !== undefined,
	);
}

function refusedOption(arg: string, refused: ReadonlyArray<string>, valueLetters = ""): boolean {
	// The flags of a short cluster end at its first value-taking letter; what
	// follows is that option's value, not more flags.
	let flags = /^-[^-]/u.test(arg) ? arg.slice(1) : "";
	for (let at = 0; at < flags.length; at += 1) {
		if (valueLetters.includes(flags[at] ?? "")) {
			flags = flags.slice(0, at + 1);
			break;
		}
	}
	return refused.some((option) => {
		// GNU tools take any unambiguous prefix of a long option: `wc --files0=x`
		// reads a list file, `tail --fo` follows forever. find's single-dash words do not abbreviate.
		if (abbreviatesLongOption(arg, option)) return true;
		if (arg === option || arg.startsWith(`${option}=`)) return true;
		// A short option can sit anywhere in a cluster (`ls -lR`); a false
		// match only costs an ask.
		return /^-[A-Za-z]$/u.test(option) && flags.includes(option.slice(1));
	});
}

/**
 * The rule id for a read-only inspection segment, or null. Every operand is
 * held to the workspace the way `read` holds its path (readScopeEscape), so
 * `cat ../x` or `grep -r key ~/` asks exactly where `read` would. The search
 * pattern of `rg` and grep is not an operand when {@link searchPatternIndex}
 * places it with certainty; in any form it cannot place, the pattern is
 * checked as if it were a path, and one that looks like an outside path only
 * costs an ask. Zero-access paths were already refused for the whole command
 * string before recognition.
 */
export function readOnlyInspectionRule(
	words: ReadonlyArray<ShellToken>,
	source: string,
	cwd: string,
	workspaceRoot: string,
	readScope: ReadScopeInputs,
	/** The join in front of this segment is `|`, so its stdin is the previous command's output. */
	piped = false,
): string | null {
	const [commandWord, ...argWords] = words;
	const command = commandWord?.value;
	if (commandWord === undefined || command === undefined) return null;
	const refuse = (note: string): null => {
		readScope.notes.push(`${quotedStep(words.map((word) => word.value).join(" "))}: ${note}`);
		return null;
	};
	// The operand check below sees the literal word; the shell sees what the
	// word expands to. A `*` or `?` glob is expanded here the way bash would
	// expand it, and the checks then judge every match. Any other expansion
	// hides the real path, so a word carrying one is never recognized.
	if (hasUnquotedExpansion(source.slice(commandWord.start, commandWord.end))) return null;
	const args: string[] = [];
	for (const word of argWords) {
		// A printed `$?` is an integer; see maskPrintedExitStatus.
		const raw = PRINT_ONLY_COMMANDS.has(command)
			? source.slice(word.start, word.end).replace(EXIT_STATUS_PARAMETER, "0")
			: source.slice(word.start, word.end);
		if (!hasUnquotedExpansion(raw)) {
			args.push(PRINT_ONLY_COMMANDS.has(command) ? word.value.replace(EXIT_STATUS_PARAMETER, "0") : word.value);
			continue;
		}
		const matches = expandOperandGlob(raw, cwd, readScope);
		if (matches === null)
			return refuse(`glob \`${raw}\` is not checked (only * and ?, not after a leading dot); name the files`);
		// bash passes an unmatched glob through as written. Under an inherited
		// nullglob the word disappears instead, which only narrows a read: the
		// walk proofs of rg and grep -r require every operand to exist, so the
		// literal word already fails them, and every other inspector given no
		// operand reads stdin or lists names in the working directory.
		if (matches.length === 0) {
			args.push(word.value);
			continue;
		}
		if (matches.some((match) => !readScope.readable(path.resolve(cwd, match))))
			return refuse(`\`${raw}\` matches a zero-access file`);
		// Glob matches can become options or search patterns and skip the operand loop.
		// Prove containment before that classification, including names after `--`.
		if (matches.some((match) => !operandStaysInWorkspace(match, cwd, workspaceRoot, readScope)))
			return refuse(`\`${raw}\` matches a path outside the workspace`);
		args.push(...matches);
	}
	if (command === "rg" && rgConfigRefusal() !== null) return null;
	if (command === "date" && !dateOperandsOnlyFormat(args)) return null;
	if (command === "xxd" && !xxdOnlyInspects(args)) return null;
	if (command === "sed") {
		if (!args.includes("-n")) return null;
		let sawScript = false;
		for (const arg of args) {
			if (arg === "-n") continue;
			if (!sawScript) {
				if (!SED_PRINT_SCRIPT.test(arg)) return null;
				sawScript = true;
				continue;
			}
			if (arg.startsWith("-") || !operandStaysInWorkspace(arg, cwd, workspaceRoot, readScope) || spacedPathOperand(arg))
				return null;
		}
		return sawScript ? "builtin:read-only:sed" : null;
	}
	const refused = READ_ONLY_INSPECTORS.get(command);
	if (refused === undefined) return null;
	const patternAt = searchPatternIndex(command, args);
	for (const [index, arg] of args.entries()) {
		if (index === patternAt) continue;
		if (arg === "-" || arg === "--") continue;
		if (arg.startsWith("-")) {
			if (refusedOption(arg, refused, SHORT_VALUE_LETTERS.get(command) ?? "")) return null;
			// An option that embeds a path (--file=/x, -f/x) is refused rather than parsed per command.
			if (arg.includes("/") || arg.includes("~")) return null;
			continue;
		}
		if (!operandStaysInWorkspace(arg, cwd, workspaceRoot, readScope) || spacedPathOperand(arg)) return null;
	}
	// Last, so no directory is walked for an operand the workspace hold refuses.
	if (command === "rg" && !rgSearchStaysReadable(args, cwd, piped, readScope))
		return refuse("rg reaches a zero-access file or too many entries");
	if (GREP_FAMILY.has(command) && recursesDirectories(args) && !grepWalkStaysReadable(command, args, cwd, readScope))
		return refuse(
			"recursive grep reaches a zero-access file or too many entries, or uses -R; name the files or use the grep tool",
		);
	return `builtin:read-only:${command}`;
}

/**
 * True when every bare `date` operand is a `+FORMAT`. `date MMDDhhmm` sets the clock with no option at all, so an operand
 * that is neither a format nor the value of `-d` or `-r` is not an inspection.
 */
function dateOperandsOnlyFormat(args: ReadonlyArray<string>): boolean {
	let valueNext = false;
	for (const arg of args) {
		if (valueNext) {
			valueNext = false;
			continue;
		}
		if (arg === "--") continue;
		if (arg.startsWith("--")) {
			valueNext = /^--(?:da|dat|date|r|re|ref|refe|refer|refere|referen|referenc|reference)$/u.test(arg);
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			// A cluster ending in -d or -r takes the next word as its value; attached text is the value itself.
			valueNext = /^-[A-Za-z]*[dr]$/u.test(arg) && !/^-[A-Za-z]*I/u.test(arg);
			continue;
		}
		if (!arg.startsWith("+")) return false;
	}
	return true;
}

/**
 * An operand with whitespace that also reads as a path (`a b/../.env`). The
 * word-level scans treated whitespace as prose and never tested it, so it is
 * not recognized even when the whole-token zero-access test passes. Prose with
 * no path character (`grep "two words" f`) is not one.
 */
function spacedPathOperand(arg: string): boolean {
	return /\s/u.test(arg) && /[/\\$`~]/u.test(arg);
}

export function operandStaysInWorkspace(
	arg: string,
	cwd: string,
	workspaceRoot: string,
	readScope: ReadScopeInputs,
): boolean {
	return readScopeEscape(arg, cwd, workspaceRoot, readScope.exemptRoots, readScope.memo) === null;
}
