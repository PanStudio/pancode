// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { FILE_WRITER_COMMANDS } from "../../lib/validation-wrappers/validation-wrappers.js";
import { pastIdentityPrefix } from "./check-prefix.js";
import { extractCommandDeleteTargets, extractCommandWriteTargets } from "./command-path-walks.js";
import { basenameToken } from "./command-token.js";
import { READ_ONLY_FILTERS, READ_ONLY_INSPECTION_REFUSALS, readOnlyInspectionStep } from "./read-only-steps.js";
import { cachedShellScan, scanShellLike, shellCommandWords } from "./shell-scan.js";
import type { ShellStep } from "./shell-segments.js";
import { INNER_SHELL_MAX_DEPTH, SHELL_SETUP_STEPS, segmentShellScript, shellSteps } from "./shell-segments.js";
import {
	checkStepMatch,
	checkWritesTree,
	isortCheckFlag,
	isPythonExecutable,
	moduleArg,
	npxInvocation,
	PACKAGE_WRITES,
	PLAIN_PYTHON_FLAGS,
	packageBinInvocation,
	packageExecInvocation,
	pythonToolModule,
	READ_ONLY_RUNNERS,
	readOnlyCheckMatch,
} from "./validation-check-match.js";

/**
 * How a shell command that runs a recognized check stands against the tree it leaves (x1-1). `pure`: every step is
 * that check, read-only inspection, shell setup (`cd`, `source`, `.`, `export`, `set`, a bare assignment) or output
 * plumbing, so the command changed no tree. `after-change`: every step that may change the tree runs before every
 * check, the last of them hands over through `&&`, `;` or a newline, and nothing but those and `|` joins the steps, so
 * the check judged the changed tree (`npm ci && npm test`, `git apply x.patch; npm test`; bt-46 S2). `mixed`: anything
 * else (`npm ci | npm test`, `npm test && node codemod.mjs`), whose check cannot speak for the tree the command left. A check that rewrites the tree
 * ({@link checkWritesTree}) is a change as well, so its own outcome never lands as a pass. Null when no step is a
 * recognized check.
 */
export type CheckCommandShape = "pure" | "after-change" | "mixed";

/** One step of a shell command as {@link checkCommandShape} indexes it, for the declared-check reader (x7-5). */
export interface CommandStep {
	/** The step's words, its redirections left out. */
	argv: string[];
	/** Where its command starts past a leading `time` and the transparent wrappers (`timeout 600`, `nice`, `xvfb-run`). */
	command: number;
	/** The separator joining it to the next step; `""` where two meet, null for the last step. */
	joinedBy: string | null;
	/** No word is one the shell would rewrite: no expansion, substitution, glob or `~`. */
	literal: boolean;
	/** It opens or closes a subshell. */
	grouped: boolean;
}

export function commandSteps(command: string): CommandStep[] {
	return shellSteps(scanShellLike(command, true)).map((step) => {
		let start = 0;
		// Read through the same prefixes a check reader does, so `/usr/bin/timeout 300 npm test` is `npm test` (FX-44).
		for (let past = -1; past !== start; ) {
			past = start;
			start = pastIdentityPrefix(step.argv, start);
		}
		const literal = shellCommandWords(step.tokens).every((token) => {
			if (token.substitutions?.length || token.hiddenContent || token.ansiCQuoted || token.homeRelative) return false;
			const raw = command.slice(token.start, token.end);
			if (/[$`]/u.test(raw) && !/^'[^']*'$/u.test(raw)) return false;
			return token.quoted || !/[*?[]/u.test(token.value);
		});
		return {
			argv: step.argv,
			command: start,
			joinedBy: step.joinedBy,
			literal,
			grouped: step.opens > 0 || step.closes > 0,
		};
	});
}

export function isCheckStep(step: ShellStep): boolean {
	return step.check !== null && checkStepMatch(basenameToken(step.argv[step.check]), step.argv.slice(step.check + 1));
}

/**
 * What one command, or one step of a shell command, does to the tree, as the call classifier
 * (`check-classifier.ts`) reads it: `check` runs a recognized check, `inspection` only reads, `mutation` provably or
 * plausibly writes, and `unknown` cannot be told apart.
 */
export type CommandVerdict = "check" | "inspection" | "mutation" | "unknown";

/** Commands whose run writes, moves, removes or re-permissions files whatever their operands. */
const FILE_WRITERS: ReadonlySet<string> = FILE_WRITER_COMMANDS;

/** Toolchain subcommands that write the tree: dependency edits, generators and in-place formatters. */
const TOOLCHAIN_WRITES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["cargo", new Set(["add", "remove", "fix", "install", "update", "generate-lockfile"])],
	["go", new Set(["generate", "get", "mod", "install", "work"])],
	["uv", new Set(["add", "remove", "sync", "lock", "pip"])],
	["poetry", new Set(["add", "remove", "install", "update", "lock"])],
	["pip", new Set(["install", "uninstall"])],
	["pip3", new Set(["install", "uninstall"])],
]);

/** Formatters that rewrite what they read unless told only to check or diff. */
const CHECKABLE_FORMATTERS: ReadonlySet<string> = new Set(["black", "isort", "rustfmt"]);

/** Interpreter flags that run a script given on the command line. */
const INLINE_SCRIPT_FLAGS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["node", ["-e", "--eval", "-p", "--print"]],
	["bun", ["-e", "--eval", "-p", "--print"]],
	["perl", ["-e", "-E", "-i", "-pi", "-pie"]],
	["ruby", ["-e", "-i"]],
]);

/**
 * A step outside the check and inspection sets that provably or plausibly writes: git beyond read-only inspection
 * (hooks and helpers included), an install, a file writer, a read-only filter or inspection command its own options
 * turned into a writer or runner, an emitting `tsc`, a runner updating snapshots or fixing, an inline script
 * (`node -e`, `python -c`), a formatter in write mode, or a check whose name or flags rewrite the tree
 * ({@link checkWritesTree}). Anything else is unknown.
 */
function writerStep(executable: string, args: ReadonlyArray<string>): boolean {
	if (executable === "git" || FILE_WRITERS.has(executable)) return true;
	if (READ_ONLY_FILTERS.has(executable) || READ_ONLY_INSPECTION_REFUSALS.has(executable)) return true;
	if (executable === "tsc" || READ_ONLY_RUNNERS.has(executable)) return true;
	if (executable === "npx") {
		if (args.some((arg) => arg === "-c" || arg === "--call" || arg.startsWith("--call="))) return true;
		const inner = npxInvocation(args);
		return inner !== null && writerStep(inner.executable, inner.args);
	}
	if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "bun") {
		// A read-only check behind `exec` is the check, not a writer (`npm exec vitest run`).
		const exec = packageExecInvocation(executable, args);
		if (exec !== null) return !readOnlyCheckMatch(exec.executable, exec.args) && writerStep(exec.executable, exec.args);
		if (args[0] === "dlx" && typeof args[1] === "string" && !args[1].startsWith("-"))
			return writerStep(basenameToken(args[1]), args.slice(2));
		if (args[0] !== undefined && PACKAGE_WRITES.has(args[0])) return true;
		// `pnpm prettier -w .` runs the writer `pnpm exec prettier -w .` does (x10-4); anything else falls through, so a
		// write-capable script name (`pnpm format`) still writes.
		const bin = packageBinInvocation(executable, args);
		if (bin !== null && !readOnlyCheckMatch(bin.executable, bin.args) && writerStep(bin.executable, bin.args))
			return true;
	}
	if (TOOLCHAIN_WRITES.get(executable)?.has(args[0] ?? "") === true) return true;
	if (isPythonExecutable(executable)) {
		const module = pythonToolModule(executable, args);
		return (
			args.includes("-c") ||
			(moduleArg(args) === "pip" && args.some((arg) => PACKAGE_WRITES.has(arg))) ||
			(module !== null && writerStep(module.executable, module.args))
		);
	}
	const inline = INLINE_SCRIPT_FLAGS.get(executable);
	if (inline?.some((flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) === true) return true;
	const checksOnly = args.some(
		(arg) =>
			arg === "--check" ||
			arg === "--diff" ||
			arg.startsWith("--check=") ||
			(executable === "isort" && isortCheckFlag(arg)),
	);
	if (CHECKABLE_FORMATTERS.has(executable)) return !checksOnly;
	if ((executable === "cargo" || executable === "go") && args[0] === "fmt") return !checksOnly;
	if (executable === "ruff" && args[0] === "format") return !checksOnly;
	if (executable === "clang-format" || executable === "autopep8")
		return args.some((arg) => arg === "-i" || arg === "--in-place");
	if (executable === "curl")
		return args.some((arg) => /^-[a-zA-Z]*[oO]/u.test(arg) || arg.startsWith("--output") || arg === "--remote-name");
	return checkWritesTree([executable, ...args]);
}

/** Do not reuse the recorder's Git config after shell setup can change cwd, environment or command lookup. */
export function shellGitCwd(steps: ReadonlyArray<ShellStep>, cwd: string | undefined): string | undefined {
	if (cwd === undefined) return undefined;
	return steps.some((step) => {
		const executable = step.index === null ? "" : (step.argv[step.index] ?? "");
		return (
			executable === "export" ||
			LIST_BENDING_BUILTINS.has(executable) ||
			SHELL_STATE_BUILTINS.has(executable) ||
			COMPOUND_COMMAND_WORDS.has(executable) ||
			(step.index === null && step.argv.length > 0)
		);
	})
		? undefined
		: cwd;
}

/** A prefixed Git step or a hidden shell word can select a different repository than its visible argv. */
export function stepGitCwd(step: ShellStep, cwd: string | undefined): string | undefined {
	return cwd !== undefined &&
		step.index === 0 &&
		step.argv[0] === "git" &&
		!step.tokens.some((token) => token.hiddenContent || token.unterminated || token.substitutions || token.ansiCQuoted)
		? cwd
		: undefined;
}

/** A step outside any recognized check: setup and inspection only read, a known writer writes, the rest is unknown. */
export function stepVerdict(
	argv: ReadonlyArray<string>,
	gitHelpersConfigured: boolean,
	gitCwd?: string,
): CommandVerdict {
	const [first] = argv;
	if (first === undefined) return "inspection";
	if (SHELL_SETUP_STEPS.has(first)) return first === "source" || first === "." ? "unknown" : "inspection";
	if (readOnlyInspectionStep(argv, gitHelpersConfigured, gitCwd)) return "inspection";
	return writerStep(basenameToken(first), argv.slice(1)) ? "mutation" : "unknown";
}

/**
 * The verdict of one shell command, the bash half of the call classifier: `check` when any step runs a recognized
 * check (its {@link checkCommandShape} then says whether the call also changed the tree), `mutation` when it names a
 * write or delete target or any step is a known writer, `inspection` when every step, substitution and inline script
 * only reads, and `unknown` otherwise. A check inside a substitution or an inline shell is not this call's check, so
 * there it reads as unknown.
 */
export function shellCommandVerdict(
	command: string,
	gitHelpersConfigured: boolean,
	recorderCwd?: string,
	depth = 0,
): CommandVerdict {
	const tokens = scanShellLike(command, true);
	const steps = shellSteps(tokens);
	if (steps.length === 0) return "unknown";
	if (steps.some(isCheckStep)) return "check";
	if (extractCommandWriteTargets(command).length > 0 || extractCommandDeleteTargets(command).length > 0)
		return "mutation";
	const gitCwd = shellGitCwd(steps, recorderCwd);
	const nested = (script: string | undefined): CommandVerdict => {
		if (script === undefined || depth >= INNER_SHELL_MAX_DEPTH) return "unknown";
		const verdict = shellCommandVerdict(script, gitHelpersConfigured, undefined, depth + 1);
		return verdict === "check" ? "unknown" : verdict;
	};
	const join = (a: CommandVerdict, b: CommandVerdict): CommandVerdict =>
		a === "mutation" || b === "mutation" ? "mutation" : a === "unknown" || b === "unknown" ? "unknown" : "inspection";
	let verdict: CommandVerdict = "inspection";
	for (const step of steps) {
		for (const token of step.tokens) {
			if (token.hiddenContent === true || token.unterminated === true) verdict = join(verdict, "unknown");
			for (const script of token.substitutions ?? []) verdict = join(verdict, nested(script));
		}
		const script = segmentShellScript(step.argv);
		const argv = step.index === null ? [] : step.argv.slice(step.index);
		const inline = script === null ? inlinePythonVerdict(command, step) : null;
		verdict = join(
			verdict,
			inline ?? (script === null ? stepVerdict(argv, gitHelpersConfigured, stepGitCwd(step, gitCwd)) : nested(script)),
		);
		if (verdict === "mutation") return verdict;
	}
	return verdict;
}

/** A write-mode `open`, a file-writing or deleting call, or a call that runs a program or code. */
const PYTHON_WRITE_SHAPE =
	/\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?[rbuf]*['"][rbt]*[wax+]|\b(?:write_text|write_bytes|remove|unlink|rmdir|rmtree|rename|makedirs|mkdir|touch|truncate|copyfile|copytree|move|chmod|symlink|system|popen|subprocess|exec|eval)\b/u;

/**
 * The verdict of a step that runs an inline Python script (c17-a): `python3 -c '<script>'`, or `python3 -` / bare
 * `python3` reading the one quoted here-document its line opens. A change when the literal script shows a
 * write-shaped operation ({@link PYTHON_WRITE_SHAPE}), unknown otherwise: it neither settles nor retires a recorded
 * outcome. A stdin script no reader can see is a change. Null for any other step, including one behind an
 * environment prefix.
 */
export function inlinePythonVerdict(command: string, step: ShellStep): CommandVerdict | null {
	if (step.index !== 0 || !isPythonExecutable(basenameToken(step.argv[0]))) return null;
	const words = shellCommandWords(step.tokens);
	let index = 1;
	while (PLAIN_PYTHON_FLAGS.has(step.argv[index] ?? "")) index += 1;
	const reads = (script: string): CommandVerdict => (PYTHON_WRITE_SHAPE.test(script) ? "mutation" : "unknown");
	if (step.argv[index] === "-c") {
		const word = words[index + 1];
		if (word === undefined) return null;
		const raw = command.slice(word.start, word.end);
		const literal =
			(word.substitutions?.length ?? 0) === 0 &&
			word.hiddenContent !== true &&
			word.unterminated !== true &&
			(/^'[^']*'$/u.test(raw) || !/[$`\\]/u.test(raw));
		return literal ? reads(word.value) : "mutation";
	}
	if (index < step.argv.length && step.argv[index] !== "-") return null;
	const first = step.tokens[0];
	const last = step.tokens.at(-1);
	if (first === undefined || last === undefined || step.tokens.some((token) => token.operator)) return "mutation";
	const lineEnd = command.indexOf("\n", last.end);
	const head = /^[ \t]*<<[ \t]*(?:'(\w+)'|"(\w+)"|(\w+))[ \t]*$/u.exec(
		command.slice(last.end, lineEnd === -1 ? command.length : lineEnd),
	);
	const body = cachedShellScan(command, true).bodies.find((candidate) => candidate.start === lineEnd + 1);
	if (head === null || body === undefined || command.slice(first.start, last.end).includes("<<")) return "mutation";
	const word = head[1] ?? head[2] ?? head[3] ?? "";
	const lines = command.slice(body.start, body.end).replace(/\n$/u, "").split("\n");
	if (lines.pop() !== word) return "mutation";
	const script = lines.join("\n");
	return head[3] !== undefined && /[$`\\]/u.test(script) ? "mutation" : reads(script);
}

/** Writers whose every write is a target {@link extractCommandWriteTargets} or {@link extractCommandDeleteTargets} names. */
const NAMED_TARGET_WRITERS: ReadonlySet<string> = new Set(["tee", "mkdir", "touch", "rm", "cp"]);

/**
 * Whether a command writes only the targets the write and delete extractors name (x7-1): every step only reads, is
 * a bare redirect, or is a writer whose targets those extractors list in full. A here-document body is data unless a
 * shell or interpreter reads it, and either of those, git, a substitution or an inline script stays unenumerable.
 */
export function shellWritesOnlyNamedTargets(
	command: string,
	gitHelpersConfigured: boolean,
	recorderCwd?: string,
): boolean {
	const steps = shellSteps(scanShellLike(command, true));
	if (steps.length === 0) return false;
	const gitCwd = shellGitCwd(steps, recorderCwd);
	return steps.every((step) => {
		if (step.tokens.some((token) => token.substitutions?.length || token.hiddenContent || token.unterminated))
			return false;
		if (segmentShellScript(step.argv) !== null) return false;
		const argv = step.index === null ? [] : step.argv.slice(step.index);
		if (argv.length === 0 || NAMED_TARGET_WRITERS.has(basenameToken(argv[0]))) return true;
		return stepVerdict(argv, gitHelpersConfigured, stepGitCwd(step, gitCwd)) === "inspection";
	});
}

/**
 * Builtins that end, replace, reconfigure or move the shell, so the status or directory of a later list may not be the
 * one it reads: after a failed `cd pkg;` the check runs where the shell already was.
 */
export const LIST_BENDING_BUILTINS: ReadonlySet<string> = new Set([
	"cd",
	"pushd",
	"popd",
	"exit",
	"exec",
	"return",
	"logout",
	"trap",
	"set",
	"shopt",
	"eval",
	"alias",
	"enable",
	"hash",
	"source",
	".",
	"kill",
	"wait",
]);

/**
 * Builtins that set what a later list runs or waits on (variables, functions, jobs) without changing the tree; an
 * unknown step spelled as one is not plain ({@link finalListAfterPlainSteps}).
 */
export const SHELL_STATE_BUILTINS: ReadonlySet<string> = new Set([
	"declare",
	"typeset",
	"readonly",
	"local",
	"unset",
	"let",
	"read",
	"readarray",
	"mapfile",
	"printf",
	"getopts",
	"fg",
	"bg",
	"disown",
	"coproc",
	"function",
	"ulimit",
	"umask",
]);

/** Words that open or close a compound command or a function body; a list holding one is not plain. */
export const COMPOUND_COMMAND_WORDS: ReadonlySet<string> = new Set([
	"{",
	"}",
	"function",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"while",
	"until",
	"for",
	"select",
	"do",
	"done",
	"case",
	"esac",
	"[[",
]);
