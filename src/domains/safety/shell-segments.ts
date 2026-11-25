// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { checkWordOf } from "./check-prefix.js";
import { basenameToken, commandTokenIndex } from "./command-token.js";
import { withoutHeredocBodies } from "./heredoc-bodies.js";
import type { ShellToken } from "./shell-scan.js";
import {
	BARE_WRAPPER_SHELLS,
	COMMAND_SEPARATORS,
	SHELL_REDIRECTIONS,
	scanShellLike,
	shellCommandArguments,
	shellCommandWords,
	splitSegments,
} from "./shell-scan.js";
import { checkStepMatch } from "./validation-check-match.js";

/** Shells whose `-c` argument is a script this scanner has to read as a command line. */
const INNER_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Depth cap for `sh -c 'sh -c "..."'`; three levels is far past anything real. */
export const INNER_SHELL_MAX_DEPTH = 3;

/**
 * The script a segment hands a shell through `-c`, or null when the segment is
 * not that shape. The tokenizer keeps a quoted script as one token, so without
 * this every scanner here is blind one `sh -c` deep: `sh -c 'echo x >
 * /etc/foo'` exposed no redirect target at all, which is how a recorded drive
 * got a write past the gate that refused the same redirect written plainly
 * (REPORT-dispatch-drive-1.md S1). Flag clusters (`-lc`, `-ec`) count, since
 * the shell reads them the same way.
 */
export function segmentShellScript(segment: ReadonlyArray<string>): string | null | undefined {
	const invocation = segmentShellInvocation(segment);
	if (invocation.kind === "none") return null;
	return invocation.kind === "inline" ? invocation.script : undefined;
}

/**
 * How a segment hands a shell its script: not a shell at all, inline through
 * `-c`, from a named file operand, from standard input, or through a startup
 * option this scanner does not model.
 */
type ShellInvocation =
	| { kind: "none" }
	| { kind: "inline"; script: string | undefined }
	| { kind: "file"; path: string }
	| { kind: "stdin" }
	| { kind: "opaque" };

/**
 * Shells whose `-o` and `-O`, alone or anywhere in a flag cluster, take the next word as the option name. zsh reads
 * `-opipefail` inline and takes no word for `-O`; ksh is not modelled, so a cluster naming an option there is opaque.
 */
const NEXT_WORD_OPTION_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "dash"]);

function segmentShellInvocation(segment: ReadonlyArray<string>): ShellInvocation {
	const commandIndex = commandTokenIndex(segment);
	if (commandIndex === null) return { kind: "none" };
	const shell = basenameToken(segment[commandIndex]);
	if (!INNER_SHELLS.has(shell)) return { kind: "none" };
	const nextWordOptions = NEXT_WORD_OPTION_SHELLS.has(shell);
	for (let index = commandIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) return { kind: "opaque" };
		if (token === "-o" || token === "+o" || (nextWordOptions && (token === "-O" || token === "+O"))) {
			const option = segment[++index];
			if (option === undefined || option.startsWith("-") || option.startsWith("+")) return { kind: "opaque" };
			continue;
		}
		if (["--norc", "--noprofile", "--posix", "--login", "--restricted", "--verbose"].includes(token)) continue;
		// `bash --version` prints and exits without running a script.
		if (token === "--version" || token === "--help") return { kind: "none" };
		if (token === "--rcfile" || token === "--init-file") return { kind: "opaque" };
		if (/^[-+][a-zA-Z]+$/u.test(token)) {
			const cluster = token.slice(1);
			let flags = cluster;
			let named = 0;
			if (nextWordOptions) {
				// bash and dash: each `o` or `O` in a cluster (`-euo pipefail`) takes the next word as its option name.
				named = cluster.replace(/[^oO]/gu, "").length;
			} else if (shell === "zsh") {
				// zsh: `-o` takes the rest of its cluster as the option name (`-opipefail`), or the next word when it ends
				// the cluster (`-eo pipefail`); `-O` is a flag (row 215).
				const inline = cluster.indexOf("o");
				if (inline >= 0) {
					flags = cluster.slice(0, inline);
					named = inline === cluster.length - 1 ? 1 : 0;
				}
			} else if (/[oO]/u.test(cluster)) return { kind: "opaque" };
			if (!/^[abCefhiklmnoprstuvxBDEHILOPTXc]*$/u.test(flags)) return { kind: "opaque" };
			if (named > 0 && flags.includes("c")) return { kind: "opaque" };
			for (let taken = 0; taken < named; taken += 1) {
				const option = segment[++index];
				if (option === undefined || option.startsWith("-") || option.startsWith("+")) return { kind: "opaque" };
			}
			if (token.startsWith("-") && flags.includes("c")) return { kind: "inline", script: segment[index + 1] };
			// `-s` reads the script from standard input even with operands.
			if (token.startsWith("-") && flags.includes("s")) return { kind: "stdin" };
			continue;
		}
		if (token === "--")
			return segment[index + 1] === undefined ? { kind: "stdin" } : { kind: "file", path: segment[index + 1] as string };
		return token.startsWith("-") ? { kind: "opaque" } : { kind: "file", path: token };
	}
	return { kind: "stdin" };
}

/** The script files a command or line runs, and whether it also runs a script it does not name. */
export interface ShellScriptRuns {
	sources: ScriptSource[];
	/** A script fed through a pipe, a here-document or here-string, `-s` or a startup option, or nested past the parse. */
	unnamed: boolean;
}

/**
 * Script files a command runs through a shell, for the operator's yolo to scan
 * (#419): `bash x.sh`, `sh -e x.sh` and `bash < x.sh`, also inside an `sh -c`
 * script or a substitution. A script it cannot name never hides one it names
 * beside it (row 215). `home` stands in for a leading `~`, `$HOME` or
 * `${HOME}` the shell expands, so a quoted `'$HOME/x'` stays literal.
 */
export function shellScriptSources(command: string, home?: string): ShellScriptRuns {
	const sources: ScriptSource[] = [];
	const named = collectScriptSources(command, 0, false, sources, home);
	return { sources, unnamed: !named };
}

/**
 * A file one line of a script hands the shell; `program` marks an `exec`
 * target, which may be a binary, `sourced` one that `source` or `.` runs in
 * the script's own shell, and `stdin` one fed to the shell on standard input,
 * where `$0` names the shell rather than the file.
 */
export interface ScriptSource {
	path: string;
	program: boolean;
	stdin: boolean;
	sourced: boolean;
}

/**
 * The files one line of a scanned script runs (#419): what
 * {@link shellScriptSources} names, plus `source x`, `. x` and `exec` of a
 * shell or of a path, with `unnamed` set when the line also runs a script it cannot name.
 */
export function scriptLineSources(line: string): ShellScriptRuns {
	const sources: ScriptSource[] = [];
	const named = collectScriptSources(line, 0, true, sources);
	return { sources, unnamed: !named };
}

/** Options of `exec` that take the next word: `-a name`. */
const EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-a"]);

/**
 * Adds the scripts a command names to `sources`; false when it also runs one it does not name. Every segment is
 * read either way, so `bash x.sh && cat y | bash` still names `x.sh` (row 215).
 */
function collectScriptSources(
	command: string,
	depth: number,
	sourced: boolean,
	sources: ScriptSource[],
	home?: string,
): boolean {
	let named = true;
	const nested = (script: string | undefined): void => {
		if (script === undefined || depth >= INNER_SHELL_MAX_DEPTH) named = false;
		else if (!collectScriptSources(script, depth + 1, sourced, sources, home)) named = false;
	};
	for (const segment of splitSegments(scanShellLike(command))) {
		for (const token of segment) {
			for (const substitution of token.substitutions ?? []) nested(substitution);
		}
		let argv = shellCommandWords(segment).map((token) => homeExpanded(token, home));
		if (sourced) {
			const commandIndex = commandTokenIndex(argv);
			const executable = commandIndex === null ? "" : basenameToken(argv[commandIndex]);
			if (commandIndex !== null && (executable === "source" || executable === ".")) {
				const operands = argv.slice(commandIndex + 1);
				const target = operands[0] === "--" ? operands[1] : operands[0];
				if (target === undefined || target.startsWith("-")) {
					named = false;
					continue;
				}
				sources.push({ path: target, program: false, sourced: true, stdin: false });
				continue;
			}
			if (commandIndex !== null && executable === "exec") {
				let next = commandIndex + 1;
				while (argv[next]?.startsWith("-") === true) next += EXEC_VALUE_OPTIONS.has(argv[next] ?? "") ? 2 : 1;
				const target = argv[next];
				// `exec >log` only redirects; `exec node app.js` runs a program found on PATH.
				if (target === undefined) continue;
				if (!INNER_SHELLS.has(basenameToken(target))) {
					if (target.includes("/")) sources.push({ path: target, program: true, sourced: false, stdin: false });
					continue;
				}
				argv = argv.slice(next);
			}
		}
		const invocation = segmentShellInvocation(argv);
		if (invocation.kind === "none") continue;
		if (invocation.kind === "opaque") named = false;
		else if (invocation.kind === "file")
			sources.push({ path: invocation.path, program: false, sourced: false, stdin: false });
		else if (invocation.kind === "inline") nested(invocation.script);
		else {
			// A shell reading standard input runs a named script only when fd 0 last comes from `< file`; a pipe, a
			// here-document or here-string, or a duplicated descriptor is a script the floor does not place (row 215).
			const input = standardInputFile(segment);
			if (input === null) named = false;
			else sources.push({ path: homeExpanded(input, home), program: false, sourced: false, stdin: true });
		}
	}
	return named;
}

/** The word a segment's last redirect of descriptor 0 opens when that redirect is `< file`, else null. */
function standardInputFile(segment: ReadonlyArray<ShellToken>): ShellToken | null {
	let input: ShellToken | null = null;
	for (let index = 0; index < segment.length; index += 1) {
		const operator = segment[index];
		if (operator === undefined || !operator.operator || !SHELL_REDIRECTIONS.has(operator.value)) continue;
		const previous = segment[index - 1];
		const fd =
			previous !== undefined &&
			!previous.operator &&
			!previous.quoted &&
			previous.end === operator.start &&
			/^\d+$/u.test(previous.value)
				? previous.value
				: operator.value.startsWith("<")
					? "0"
					: "1";
		if (fd !== "0") continue;
		const target = segment[index + 1];
		input = operator.value === "<" && target !== undefined && !target.operator ? target : null;
	}
	return input;
}

/** Shell source that cannot be inspected must keep the one-shot confirmation rail. */
export function hasUnparsedShellScript(command: string, depth = 0): boolean {
	for (const segment of splitSegments(scanShellLike(command))) {
		const script = segmentShellScript(shellCommandArguments(segment));
		if (script === undefined) return true;
		if (script !== null && (depth >= INNER_SHELL_MAX_DEPTH || hasUnparsedShellScript(script, depth + 1))) return true;
		for (const token of segment) {
			for (const substitution of token.substitutions ?? []) {
				if (depth >= INNER_SHELL_MAX_DEPTH || hasUnparsedShellScript(substitution, depth + 1)) return true;
			}
		}
	}
	return false;
}

/**
 * A command's segments, with every `sh -c '<script>'` wrapper followed by the
 * segments of the script it runs. The wrapper segment itself is kept: a
 * scanner that reads its operands (`cp`, `tee`) must still see them.
 */
export function expandedShellSegments(command: string, depth = 0, skipHeredocBodies = false): ShellToken[][] {
	const segments = splitSegments(scanShellLike(skipHeredocBodies ? withoutHeredocBodies(command, true) : command));
	if (depth >= INNER_SHELL_MAX_DEPTH) return segments;
	const out: ShellToken[][] = [];
	for (const segment of segments) {
		out.push(segment, ...substitutionSegments(segment, depth, skipHeredocBodies));
		const script = segmentShellScript(shellCommandArguments(segment));
		if (typeof script === "string") out.push(...expandedShellSegments(script, depth + 1, skipHeredocBodies));
	}
	return out;
}

/**
 * The script when the whole command is one `sh -c '<script>'` invocation and
 * nothing else. The policy engine recognizes such a command by its inner
 * script rather than treating `sh` as an unrecognized executable.
 */
export function inlineShellScript(command: string): string | null {
	const segments = splitSegments(scanShellLike(command));
	if (segments.length !== 1) return null;
	const segment = segments[0];
	if (segment === undefined) return null;
	return segmentShellScript(shellCommandArguments(segment)) ?? null;
}

/**
 * The script when the command is exactly `<shell> [options] -c '<script>'`
 * and nothing else: no leading assignment or `env`, no pathful shell, no
 * operand after the script, no redirect, and no option that runs other code
 * first (`-x` with `PS4`, `-i`, `-l`, `--rcfile`, `--init-file`). Only this
 * form may be judged by its script alone; anything else on the wrapper's line
 * would run unexamined.
 */
export function bareInlineShellScript(command: string): string | null {
	const segments = splitSegments(scanShellLike(command));
	if (segments.length !== 1) return null;
	const segment = segments[0];
	if (segment === undefined || segment.some((token) => token.operator)) return null;
	const words = segment.map((token) => token.value);
	if (!BARE_WRAPPER_SHELLS.has(words[0] ?? "")) return null;
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index] as string;
		if (word === "--norc" || word === "--noprofile") continue;
		if (!/^-[ceufv]+$/u.test(word)) return null;
		if (word.includes("c")) return index === words.length - 2 ? (words[index + 1] as string) : null;
	}
	return null;
}

/**
 * Shell setup that changes the shell, not the tree (x3-1). `source` and `.` run a script, but the one sourced before a
 * check is an environment activation by convention; reading it as a change would let `source .venv/bin/activate &&
 * pytest tests/one.py` clear a standing red.
 */
export const SHELL_SETUP_STEPS: ReadonlySet<string> = new Set(["cd", "pushd", "popd", "source", ".", "export", "set"]);

export interface ShellStep {
	tokens: ShellToken[];
	argv: string[];
	/** The command word: what the step runs as written, wrappers included, for every reader but a check's. */
	index: number | null;
	/**
	 * The word a check reader judges: past every built-in prefix ({@link builtinCommandIndex}), and past a declared
	 * wrapper when the command behind it is a check (FX-44). It names the check only; what the step writes or deletes is
	 * read from `index`.
	 */
	check: number | null;
	/** `check` stands behind a declared wrapper, a program that may write before the check it runs (FX-44). */
	declared: boolean;
	/** The separator joining this step to the next; `""` where two separators meet, null for the last step. */
	joinedBy: string | null;
	/** Subshells `(` opened right before this step, and closed `)` right after it. */
	opens: number;
	closes: number;
}

export function shellSteps(tokens: ReadonlyArray<ShellToken>): ShellStep[] {
	const steps: ShellStep[] = [];
	let current: ShellToken[] = [];
	let separator: string | null = null;
	let opens = 0;
	const endStep = () => {
		if (current.length === 0) return;
		const previous = steps.at(-1);
		if (previous !== undefined) previous.joinedBy = separator;
		separator = null;
		const argv = shellCommandArguments(current);
		const index = commandTokenIndex(argv);
		// A step that runs a check behind a built-in prefix or a declared wrapper is read as that check (FX-44).
		const check = checkWordOf(argv, checkStepMatch);
		steps.push({
			tokens: current,
			argv,
			index,
			check: check.index,
			declared: check.declared,
			joinedBy: null,
			opens,
			closes: 0,
		});
		opens = 0;
		current = [];
	};
	for (const token of tokens) {
		if (token.operator && COMMAND_SEPARATORS.has(token.value)) {
			endStep();
			// A subshell's status is its last command's, so `(cd lib && make) && npm test` joins `make` to the check by `&&`.
			if (token.value === "(") opens += 1;
			else if (token.value === ")") {
				const last = steps.at(-1);
				if (opens > 0) opens -= 1;
				else if (last !== undefined) last.closes += 1;
			}
			if (token.value === "(" || token.value === ")") continue;
			// Two separators in a row (`) ;`) join no simple pair, so neither can hand a change to a check.
			separator = separator === null && steps.length > 0 ? token.value : "";
			continue;
		}
		current.push(token);
	}
	endStep();
	return steps;
}

/** A word with its leading home reference replaced by `home`, when the shell would expand it. */
export function homeExpanded(token: ShellToken, home: string | undefined): string {
	if (home === undefined || token.homeRelative !== true) return token.value;
	const reference = /^(?:\$\{HOME\}|\$HOME|~)/u.exec(token.value)?.[0] ?? "";
	// HOME=/ leaves an empty base, and `~` alone would then expand to nothing.
	return `${home.replace(/\/+$/u, "")}${token.value.slice(reference.length)}` || "/";
}

/**
 * The segments of the substitutions a segment's words carry, read as child
 * commands; they run before the segment's own command does.
 */
export function substitutionSegments(
	tokens: ReadonlyArray<ShellToken>,
	depth: number,
	skipHeredocBodies = false,
): ShellToken[][] {
	if (depth >= INNER_SHELL_MAX_DEPTH) return [];
	return tokens.flatMap((token) =>
		(token.substitutions ?? []).flatMap((script) => expandedShellSegments(script, depth + 1, skipHeredocBodies)),
	);
}
