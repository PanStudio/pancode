// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { cdTarget, findExpressionFilters, findRoots } from "./command-path-walks.js";
import {
	basenameToken,
	commandTokenIndex,
	ENV_VALUE_OPTIONS,
	isEnvAssignment,
	PRIVILEGE_VALUE_OPTIONS,
} from "./command-token.js";
import { collectRedirectTargets, isInterestingWriteTarget } from "./command-write-targets.js";
import { readOnlyInspectionStep } from "./read-only-steps.js";
import type { CheckCommandShape } from "./shell-command-verdict.js";
import {
	COMPOUND_COMMAND_WORDS,
	inlinePythonVerdict,
	isCheckStep,
	LIST_BENDING_BUILTINS,
	SHELL_STATE_BUILTINS,
	shellGitCwd,
	stepGitCwd,
	stepVerdict,
} from "./shell-command-verdict.js";
import { scanShellLike, shellCommandArguments } from "./shell-scan.js";
import type { ShellStep } from "./shell-segments.js";
import {
	expandedShellSegments,
	hasUnparsedShellScript,
	SHELL_SETUP_STEPS,
	segmentShellScript,
	shellSteps,
} from "./shell-segments.js";
import { checkWritesTree, pathArgs, validationMatch } from "./validation-check-match.js";

/**
 * `isOutput` says a redirect or `tee` target is a log the check's output lands in, not part of the tree (x4-2), so
 * `npm test 2>&1 | tee test.log` stays pure; it is asked only of commands that run a check. `declaredSteps` are the
 * indices of steps that run a declared check (x7-5), which count as check steps. `stepWritesTree` reads a writer step
 * other than a check by its own text, so one that writes only named targets outside the workspace (`cp lcov.info
 * /tmp/`) changes no tree, as the same mutation alone does not (x7-1, x8-5).
 */
export function checkCommandShape(
	command: string,
	gitHelpersConfigured: boolean,
	isOutput: (target: string) => boolean = () => false,
	declaredSteps: ReadonlySet<number> = new Set(),
	stepWritesTree: (step: string) => boolean = () => true,
	/** The directory the check runs in ({@link checkLogTargets}). */
	directory = "",
	recorderCwd?: string,
): CheckCommandShape | null {
	const tokens = scanShellLike(command, true);
	const parsed = shellSteps(tokens);
	const gitCwd = shellGitCwd(parsed, recorderCwd);
	const isCheck = (step: ShellStep, index: number) => isCheckStep(step) || declaredSteps.has(index);
	if (!parsed.some(isCheck)) return null;
	const steps = parsed.map((step, index) => {
		const writes: string[] = [];
		collectRedirectTargets(step.tokens, writes);
		const check = isCheck(step, index);
		const argv = step.index === null ? [] : step.argv.slice(step.index);
		// The check's own words decide what it writes; the step's words, wrapper included, decide everything else (FX-44).
		const checkArgv = step.check === null ? [] : step.argv.slice(step.check);
		// A declared wrapper is a program of the repository's that may write, so its step is never read-only (FX-44).
		const declared = check && step.declared;
		// A report, coverage directory or binary the check writes by its own options is judged as its logs are (SF-2).
		if (check) writes.push(...checkReportTargets(checkArgv, directory));
		const readOnly =
			!declared &&
			(step.index === null ||
				(check && !checkWritesTree(checkArgv) && !updatesGoldensByEnv(step.argv.slice(0, step.check ?? 0))) ||
				SHELL_SETUP_STEPS.has(argv[0] ?? "") ||
				(basenameToken(argv[0]) === "tee" && pathArgs(argv, 0).every(isOutput)) ||
				readOnlyInspectionStep(argv, gitHelpersConfigured, stepGitCwd(step, gitCwd)));
		const changes = readOnly
			? writes.some((target) => isInterestingWriteTarget(target) && !isOutput(target))
			: check || stepWritesTree(command.slice(step.tokens[0]?.start ?? 0, step.tokens.at(-1)?.end ?? 0));
		return { check, changes, joinedBy: step.joinedBy, declared };
	});
	const opaque =
		tokens.some((token) => token.substitutions !== undefined || token.hiddenContent === true || token.unterminated) ||
		hasUnparsedShellScript(command);
	if (opaque) return "mixed";
	let lastChange = steps.length - 1;
	while (lastChange >= 0 && steps[lastChange]?.changes !== true) lastChange -= 1;
	if (lastChange === -1) return "pure";
	const sequential = (joinedBy: string | null | undefined) => joinedBy === "&&" || joinedBy === ";";
	// A declared wrapper's writes come before the check it runs, so the last change may be that check's own step: the
	// call is a change whose check judged the tree it left, and its outcome settles that check (FX-44).
	const ownHandOver = steps[lastChange]?.declared === true;
	const handsOver =
		(ownHandOver || sequential(steps[lastChange]?.joinedBy)) &&
		steps.every((step) => step.joinedBy === null || step.joinedBy === "|" || sequential(step.joinedBy)) &&
		!steps.slice(0, ownHandOver ? lastChange : lastChange + 1).some((step) => step.check);
	return handsOver ? "after-change" : "mixed";
}

/**
 * The targets only a check pipeline's own output stream writes (x5-4): a `tee` stage after the check and the last
 * stage's redirects, so `npm test 2>&1 | tee out.txt` and `npm test > out.txt 2>&1` name `out.txt`. Whether such a
 * target is output and not a change is the caller's call. `declaredSteps` count as check steps, as in
 * {@link checkCommandShape}.
 */
export function checkLogTargets(
	command: string,
	declaredSteps: ReadonlySet<number> = new Set(),
	/** The directory the check runs in, which names the binary `go build` leaves there ({@link checkReportTargets}). */
	directory = "",
): ReadonlySet<string> {
	const logs = new Set<string>();
	let checked = false;
	for (const [index, step] of shellSteps(scanShellLike(command, true)).entries()) {
		const check = isCheckStep(step) || declaredSteps.has(index);
		checked ||= check;
		const argv = step.index === null ? [] : step.argv.slice(step.index);
		if (check)
			for (const target of checkReportTargets(step.argv.slice(step.check ?? step.argv.length), directory))
				logs.add(target);
		if (checked && basenameToken(argv[0]) === "tee") for (const target of pathArgs(argv, 0)) logs.add(target);
		if (step.joinedBy === "|") continue;
		if (checked) {
			const writes: string[] = [];
			collectRedirectTargets(step.tokens, writes);
			for (const target of writes) logs.add(target);
		}
		checked = false;
	}
	return logs;
}

/** Default files pytest-cov writes for a `--cov-report` kind named without a destination. */
const COV_REPORT_DEFAULTS: ReadonlyMap<string, string> = new Map([
	["html", "htmlcov"],
	["xml", "coverage.xml"],
	["json", "coverage.json"],
	["lcov", "coverage.lcov"],
]);

/** `go build` options that take the next word as their value. */
const GO_BUILD_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-o",
	"-p",
	"-C",
	"-tags",
	"-ldflags",
	"-gcflags",
	"-asmflags",
	"-mod",
	"-modfile",
	"-overlay",
	"-pkgdir",
	"-buildmode",
	"-compiler",
	"-installsuffix",
	"-toolexec",
	"-pgo",
	"-coverpkg",
	"-covermode",
]);

/**
 * The files a check step writes through its own options (SF-2), for the caller's output reader to judge as it judges a
 * log: a gitignored or newly made untracked target stays output, a tracked or older one is a change. They are an ESLint
 * report (`-o`, `--output-file`), a coverage directory (`--coverage` in any spelling, jest's `--coverageDirectory`,
 * vitest's `--coverage.reportsDirectory`), pytest-cov's `.coverage` and `--cov-report` files, `go test -coverprofile`
 * and `-o`, and the binary `go build` leaves unless it builds several packages: its `-o`, its one package's or `.go`
 * file's name, or for the package in `directory` that directory's name. Without a `directory` that last binary is `.`,
 * the tree itself, so it is a change.
 */
function checkReportTargets(argv: ReadonlyArray<string>, directory: string): string[] {
	const targets: string[] = [];
	const valueAt = (index: number, name: string): string | undefined => {
		const arg = argv[index];
		return arg === name ? argv[index + 1] : arg?.startsWith(`${name}=`) === true ? arg.slice(name.length + 1) : undefined;
	};
	const eslint = argv.findIndex((word) => basenameToken(word) === "eslint");
	let coverage = false;
	let coverageDirectory: string | undefined;
	for (const [index, arg] of argv.entries()) {
		if (/^--(?:coverage(?:\.enabled)?|collectCoverage)(?:=true)?$/u.test(arg)) coverage = true;
		coverageDirectory =
			valueAt(index, "--coverageDirectory") ?? valueAt(index, "--coverage.reportsDirectory") ?? coverageDirectory;
		const report = eslint >= 0 && index > eslint ? (valueAt(index, "-o") ?? valueAt(index, "--output-file")) : undefined;
		if (report !== undefined) targets.push(report);
		if (arg === "--cov" || arg.startsWith("--cov=")) targets.push(".coverage");
		const covReport = valueAt(index, "--cov-report");
		if (covReport !== undefined) {
			const [kind = "", destination] = covReport.split(":");
			const target = destination || COV_REPORT_DEFAULTS.get(kind);
			if (target !== undefined) targets.push(target);
		}
	}
	if (coverage) targets.push(coverageDirectory ?? "coverage");
	const go = argv.findIndex((word) => basenameToken(word) === "go");
	const subcommand = go >= 0 ? argv[go + 1] : undefined;
	if (subcommand === "test")
		for (let index = go + 2; index < argv.length; index += 1) {
			const target = valueAt(index, "-coverprofile") ?? valueAt(index, "-o");
			if (target !== undefined) targets.push(target);
		}
	if (subcommand === "build") {
		const operands: string[] = [];
		let output: string | undefined;
		for (let index = go + 2; index < argv.length; index += 1) {
			const arg = argv[index] ?? "";
			if (!arg.startsWith("-")) {
				operands.push(arg);
				continue;
			}
			const name = arg.replace(/^--/u, "-").split("=")[0] ?? "";
			if (name === "-o") output = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1];
			if (!arg.includes("=") && GO_BUILD_VALUE_OPTIONS.has(name)) index += 1;
		}
		const [first] = operands;
		const files = operands.length > 0 && operands.every((operand) => operand.endsWith(".go"));
		if (output !== undefined) targets.push(output);
		else if (first !== undefined && files) targets.push(path.basename(first, ".go"));
		else if (first === undefined || first === "." || first === "./")
			targets.push(operands.length > 1 || directory === "" ? "." : path.basename(directory));
		else if (operands.length === 1 && !first.includes("...")) targets.push(path.basename(first));
	}
	return targets;
}

/**
 * Environment settings that make a test run rewrite its snapshots or goldens instead of comparing against them
 * (`UPDATE_GOLDEN=1 go test`, `INSTA_UPDATE=always cargo test`, `UPDATE_SNAPSHOTS=1 npm test`, SF-2): a name with an
 * update word and a snapshot word set to anything but an off value, insta's `always`/`unseen` and its force-pass, and
 * trybuild's `overwrite`. `NO_UPDATE_NOTIFIER` and the like name no snapshot, so they stay setup.
 */
function updatesGoldensByEnv(prefix: ReadonlyArray<string>): boolean {
	return prefix.some((word) => {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(word);
		if (match === null) return false;
		const name = (match[1] ?? "").toUpperCase();
		const value = (match[2] ?? "").replace(/^["']|["']$/gu, "");
		if (/^(?:|0|false|no|off)$/iu.test(value)) return false;
		if (name === "INSTA_UPDATE") return value === "always" || value === "unseen";
		if (name === "INSTA_FORCE_PASS") return true;
		if (name === "TRYBUILD") return value === "overwrite";
		const parts = name.split("_");
		return (
			parts.some((part) => /^(?:UPDATE|REGEN|REGENERATE|BLESS|ACCEPT|OVERWRITE|RECORD)$/u.test(part)) &&
			parts.some((part) =>
				/^(?:SNAPSHOTS?|SNAPS?|GOLDENS?|GOLD|EXPECT|EXPECTED|EXPECTATIONS?|FIXTURES?|BASELINES?)$/u.test(part),
			)
		);
	});
}

/** Pipeline stages that read their input to its end and exit 0, so the pipeline's status is the stage feeding them. */
function drainsInput(step: ShellStep): boolean {
	if (step.index === null) return false;
	const [executable, ...args] = step.argv.slice(step.index);
	if (executable === "cat" || executable === "tee") return true;
	return (
		executable === "tail" &&
		!args.some((arg) => /^-[^-]*[fF]/u.test(arg) || arg.startsWith("--follow") || arg === "--retry")
	);
}

/**
 * Whether a red exit of a command running a recognized check is the check's own red (x3-2). Under `pipefail` a stage
 * after the check fails a green check: `head` closes the pipe so the check dies of SIGPIPE or EPIPE, and `grep`
 * exits 1 when a clean run prints no match. So a check piped onward into anything but `tail`, `cat` or `tee`, which read to
 * the end and exit 0, settles no failure. Its clean exit still speaks for it, since every stage then exited 0.
 * `declaredSteps` count as check steps, as in {@link checkCommandShape}.
 */
export function checkFailureAttributable(command: string, declaredSteps: ReadonlySet<number> = new Set()): boolean {
	const steps = shellSteps(scanShellLike(command, true));
	return steps.every((step, position) => {
		if (!isCheckStep(step) && !declaredSteps.has(position)) return true;
		for (let next = position; ; next += 1) {
			const joinedBy = steps[next]?.joinedBy;
			if (joinedBy !== "|") return joinedBy !== "";
			const stage = steps[next + 1];
			if (stage === undefined || !drainsInput(stage)) return false;
		}
	});
}

/**
 * Whether a step of the command bends a pipeline's exit status away from its commands' own (x4-5): a `!` that inverts
 * a pipeline, a `set` that switches an option off with `+o` (`set +o "pipefail"`), or a `shopt -u` naming pipefail or
 * an expansion. Quoting is read the way the shell reads it, so a quoted option name still counts.
 */
export function shellStatusMasked(command: string): boolean {
	return shellSteps(scanShellLike(command, true)).some((step) => {
		if (step.argv.slice(0, step.index ?? step.argv.length).includes("!")) return true;
		if (step.index === null) return false;
		const [executable, ...args] = step.argv.slice(step.index);
		if (executable === "set") return args.some((arg) => /^\+[A-Za-z]*o/u.test(arg));
		if (executable !== "shopt") return false;
		return args.some((arg) => /^-[A-Za-z]*u/u.test(arg)) && args.some((arg) => arg === "pipefail" || /[$`]/u.test(arg));
	});
}

/**
 * The text of a command's last `;` or newline list when the steps before it cannot touch its exit status (bt-46 S2):
 * none runs a check (`declaredSteps` count as checks), none is grouped or backgrounded, and each is a plain command, so
 * a write by redirect, heredoc, a known writer or a program the step reader cannot place (`./gen.sh; npm test`, SF-2)
 * may come first: a child process cannot end the shell or change what the next list runs. An `exit`, a `trap`, a
 * `set`, a function or alias definition, a builtin that sets variables or jobs, a nested shell or a hidden word returns
 * null, as does a command with no such list.
 */
export function finalListAfterPlainSteps(
	command: string,
	declaredSteps: ReadonlySet<number> = new Set(),
): string | null {
	const steps = shellSteps(scanShellLike(command, true));
	let last = -1;
	for (let position = 1; position < steps.length; position += 1)
		if (steps[position - 1]?.joinedBy === ";") last = position;
	const tail = steps[last]?.tokens[0];
	if (tail === undefined) return null;
	const plain = (step: ShellStep, position: number): boolean => {
		if (step.opens > 0 || step.closes > 0 || step.index === null) return false;
		if (position < last && (step.joinedBy === "&" || step.joinedBy === "")) return false;
		if (position >= last) return true;
		if (isCheckStep(step) || declaredSteps.has(position)) return false;
		if (step.tokens.some((token) => token.hiddenContent === true || token.unterminated === true)) return false;
		const argv = step.argv.slice(step.index);
		if (step.argv.slice(0, step.index + 1).some((word) => COMPOUND_COMMAND_WORDS.has(word))) return false;
		if (LIST_BENDING_BUILTINS.has(argv[0] ?? "") || segmentShellScript(step.argv) !== null) return false;
		return (
			(inlinePythonVerdict(command, step) ?? stepVerdict(argv, false)) !== "unknown" ||
			!SHELL_STATE_BUILTINS.has(argv[0] ?? "")
		);
	};
	return steps.every(plain) ? command.slice(tail.start) : null;
}

/** Unquoted or double-quoted text an echoed status line may carry: no expansion, escape, glob or redirect. */
const STATUS_LINE_TEXT = /^[A-Za-z0-9_.,:=/+@% -]*$/u;

const STATUS_REFERENCE = /\$\?|\$\{\?\}/gu;

/**
 * One word of an echoed status step as the shell prints it, or null when the shell could expand it into anything else.
 * `$?` (or `${?}`) is returned as `\0`, where the status goes; inside single quotes it is literal text.
 */
function statusStepWord(raw: string): string | null {
	if (raw.startsWith("'")) {
		const body = raw.slice(1, -1);
		return raw.length >= 2 && raw.endsWith("'") && !body.includes("'") && !body.includes("\0") ? body : null;
	}
	const body = raw.startsWith('"') ? (raw.length >= 2 && raw.endsWith('"') ? raw.slice(1, -1) : null) : raw;
	if (body === null) return null;
	const marked = body.replace(STATUS_REFERENCE, "\0");
	return STATUS_LINE_TEXT.test(marked.replaceAll("\0", "")) ? marked : null;
}

/** What an `echo`, `printf` or `true` step prints, `\0` where it prints `$?`, or null for any other step or spelling. */
function statusStepOutput(command: string, step: ShellStep): string | null {
	if (step.opens > 0 || step.closes > 0 || step.index !== 0) return null;
	const words: string[] = [];
	for (const token of step.tokens) {
		if (token.operator || token.hiddenContent === true || token.unterminated === true || token.substitutions) return null;
		const raw = command.slice(token.start, token.end);
		if (words.length === 0) {
			words.push(raw);
			continue;
		}
		// A printf format may end in one `\n`, which nothing else may spell.
		const format = words[0] === "printf" && words.length === 1 && /\\n["']?$/u.test(raw);
		const word = statusStepWord(format ? raw.replace(/\\n(["']?)$/u, "$1") : raw);
		if (word === null) return null;
		words.push(format ? `${word}\n` : word);
	}
	const [executable, ...args] = words;
	if (executable === "true") return args.length === 0 ? "" : null;
	if (executable === "echo") return args[0]?.startsWith("-") === true ? null : `${args.join(" ")}\n`;
	if (executable !== "printf" || args.length === 0 || args.length > 2) return null;
	const [format = "", value] = args;
	const percents = format.split("%").length - 1;
	if (value === undefined) return percents === 0 ? format : null;
	// `printf 'EXIT=%d\n' "$?"`: one conversion, fed by the status and nothing else.
	if (percents !== 1 || !/%[disu]/u.test(format) || value !== "\0" || format.includes("\0")) return null;
	return format.replace(/%[disu]/u, "\0");
}

/**
 * The exit status a recognized check reported through an echo after it, read from what the command printed, or null
 * (misc2 item 4). Under `check; echo "EXIT=$?"` the call's own status is echo's, so the check's can only come from the
 * line the shell printed for it. The shape is narrow: the first step is a recognized check joined by `;`, the next is
 * an `echo` or `printf` that prints `$?` once, and any after it are `echo`, `printf` or `true` of literal text joined by
 * `;` or `&&`. No step may be grouped, redirected, piped, backgrounded, prefixed, expanded beyond `$?`, or inverted, and
 * `stdout` must end with exactly what those steps print, the status in its place.
 */
export function echoedCheckStatus(command: string, stdout: string): number | null {
	if (shellStatusMasked(command)) return null;
	const steps = shellSteps(scanShellLike(command, true));
	const [check, reporter, ...rest] = steps;
	if (check === undefined || reporter === undefined || check.joinedBy !== ";") return null;
	if (check.opens > 0 || check.closes > 0 || !isCheckStep(check)) return null;
	if (check.tokens.some((token) => token.hiddenContent === true || token.unterminated === true)) return null;
	const printed: string[] = [];
	for (const step of [reporter, ...rest]) {
		if (step.joinedBy !== null && step.joinedBy !== ";" && step.joinedBy !== "&&") return null;
		const output = statusStepOutput(command, step);
		if (output === null) return null;
		printed.push(output);
	}
	const marks = printed.join("").split("\0");
	if (marks.length !== 2 || !(printed[0] ?? "").includes("\0")) return null;
	const [before = "", after = ""] = marks;
	const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	// The status line starts a line: text the check printed without a newline joins it and the match fails, unless the
	// line opens on the status, where a digit the check left before it can only make a zero read nonzero.
	const line = new RegExp(`(?:^|\\n)${literal(before)}(\\d{1,3})${literal(after.replace(/\n+$/u, ""))}$`, "u");
	const match = line.exec(stdout.replace(/\n+$/u, ""));
	if (match === null) return null;
	const status = Number(match[1]);
	return status <= 255 ? status : null;
}

/**
 * Whether a recognized check in the command runs outside `root` (x3-5). Its directory starts at `base` and follows
 * each `cd` and `pushd` before it, back out of a subshell at its `)` and back along the stack at a `popd` (x4-7). A
 * directory this cannot resolve (home, `-`, a variable, an unbalanced `)` or `popd`) is unknown, which counts as
 * outside, so a sibling checkout's green never stands for this workspace.
 */
export function checkRunsOutside(command: string, base: string, root: string): boolean {
	return someCheckStep(
		command,
		base,
		(argv, directory) =>
			directory === null || !isSameOrDescendant(directory, root) || checkReachesOutside(argv, directory, root),
	);
}

/**
 * Whether a Python test step runs on a bare interpreter (`python3 -m pytest`, `pytest`, `python -m unittest`) rather
 * than through `uv run`, in a directory `unprovisioned` names: there it judged whatever environment that interpreter
 * carries, not the project's locked one, so its pass is not this project's (FL-2). An unknown directory answers false;
 * {@link checkRunsOutside} already reads it.
 */
export function checkRunsBareInterpreter(
	command: string,
	base: string,
	unprovisioned: (directory: string) => boolean,
): boolean {
	return someCheckStep(command, base, (argv, directory) => {
		const label = validationMatch(basenameToken(argv[0]), argv.slice(1));
		return (
			directory !== null &&
			(label === "pytest" || label === "python -m pytest" || label === "python -m unittest") &&
			unprovisioned(directory)
		);
	});
}

/** Whether some check step of `command` passes `test`, given its argv and the directory it runs in (null when unknown). */
function someCheckStep(
	command: string,
	base: string,
	test: (argv: ReadonlyArray<string>, directory: string | null) => boolean,
): boolean {
	let directory: string | null = base;
	let pushed: Array<string | null> = [];
	const subshells: Array<{ directory: string | null; pushed: Array<string | null> }> = [];
	for (const step of shellSteps(scanShellLike(command, true))) {
		for (let open = 0; open < step.opens; open += 1) subshells.push({ directory, pushed: [...pushed] });
		const executable = step.index === null ? "" : basenameToken(step.argv[step.index]);
		const target = cdTarget(step.argv);
		if (isCheckStep(step)) {
			const prefix = step.argv.slice(0, step.check ?? 0);
			if (test(step.argv.slice(step.check ?? 0), wrapperMovesDirectory(prefix) ? null : directory)) return true;
		} else if (executable === "popd")
			directory = step.argv.length > (step.index ?? 0) + 1 ? null : (pushed.pop() ?? null);
		else if (target !== null) {
			if (executable === "pushd") pushed.push(directory);
			directory = directory === null || /^[~+]|[$`]/u.test(target) ? null : path.resolve(directory, target);
		}
		for (let close = 0; close < step.closes; close += 1) {
			const outer = subshells.pop();
			directory = outer?.directory ?? null;
			pushed = outer?.pushed ?? [];
		}
	}
	return false;
}

/**
 * Whether the wrappers before a command run it in another directory or from a re-split string (`env -C dir`,
 * `env -S '...'`, `sudo -D dir`), so where the check ran is unknown (SF-2).
 */
function wrapperMovesDirectory(prefix: ReadonlyArray<string>): boolean {
	let wrapper = "";
	for (let position = 0; position < prefix.length; position += 1) {
		const word = prefix[position] ?? "";
		const name = basenameToken(word);
		if (name === "env" || name === "sudo" || name === "doas") {
			wrapper = name;
			continue;
		}
		if (wrapper === "") continue;
		if (/^--(?:chdir|split-string)(?:=|$)/u.test(word)) return true;
		if (wrapper === "env" && /^-[a-zA-Z]*[CS]/u.test(word)) return true;
		if (wrapper === "sudo" && /^-[a-zA-Z]*D/u.test(word)) return true;
		if (word.startsWith("-")) {
			if ((wrapper === "env" ? ENV_VALUE_OPTIONS : PRIVILEGE_VALUE_OPTIONS).has(word)) position += 1;
			continue;
		}
		if (wrapper === "env" && isEnvAssignment(word)) continue;
		// The wrapper's options end at the command it runs, so a later word's flags are that command's own.
		wrapper = "";
	}
	return false;
}

/** A check's own options that run it in, or read its project from, another directory; `--manifest-path` names a file. */
const CHECK_DIRECTORY_OPTIONS: ReadonlySet<string> = new Set([
	"--prefix",
	"-C",
	"--dir",
	"--cwd",
	"--directory",
	"--working-directory",
	"--manifest-path",
	"--test-dir",
	"--rootdir",
	"--rootDir",
	"--root",
]);

/** Runners whose positional operands are the paths they collect tests from. */
const PATH_OPERAND_RUNNERS: ReadonlySet<string> = new Set(["pytest", "py.test", "jest", "vitest", "mocha", "go"]);

const GO_VALUE_OPTIONS = ["-run", "-bench", "-skip", "-tags", "-timeout", "-count", "-cpu", "-parallel", "-p"];

const JEST_VALUE_OPTIONS = ["-t", "--testNamePattern"];

const PYTEST_VALUE_OPTIONS = ["-k", "-m", "-p", "-o", "-W"];

/** Each runner's options whose separate next argument is a value (a test name, a regex), not a path operand (x5-3). */
const RUNNER_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["go", new Set([...GO_VALUE_OPTIONS, "-coverprofile", "-covermode", "-o"])],
	["jest", new Set(JEST_VALUE_OPTIONS)],
	["vitest", new Set(JEST_VALUE_OPTIONS)],
	["pytest", new Set(PYTEST_VALUE_OPTIONS)],
	["py.test", new Set(PYTEST_VALUE_OPTIONS)],
]);

/**
 * Whether a check step's own directory options (`npm test --prefix ../x`, `make -C ../x`, `cargo test --manifest-path
 * ../x/Cargo.toml`) or a test runner's path operands (`pytest ../x`) reach outside `root` from `directory` (x4-4). The
 * test is root containment, so `npm test --prefix packages/a` stays this workspace's check. An operand this cannot
 * resolve (home, a variable) counts as outside.
 */
function checkReachesOutside(argv: ReadonlyArray<string>, directory: string, root: string): boolean {
	const [executable, ...args] = argv;
	const module = args.indexOf("-m");
	const runner = module >= 0 && args[module + 1] === "pytest" ? "pytest" : basenameToken(executable);
	const operands = PATH_OPERAND_RUNNERS.has(runner);
	const values = RUNNER_VALUE_OPTIONS.get(runner);
	const targets: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		const equals = arg.indexOf("=");
		const option = equals > 0 ? arg.slice(0, equals) : arg;
		let target: string | undefined;
		if (CHECK_DIRECTORY_OPTIONS.has(option)) {
			target = equals > 0 ? arg.slice(equals + 1) : args[index + 1];
			if (equals < 0) index += 1;
			if (option === "--manifest-path" && target !== undefined) target = path.dirname(target);
		} else if (/^-C[^-]/u.test(arg)) target = arg.slice(2);
		else if (values?.has(arg)) index += 1;
		else if (operands && !arg.startsWith("-") && equals < 0) target = arg.split("::")[0];
		if (target !== undefined) targets.push(target);
	}
	return targets.some((target) => /^~|[$`]/u.test(target) || !isSameOrDescendant(path.resolve(directory, target), root));
}

/**
 * Roots of the `find -delete` calls in a command whose expression filters
 * what goes. The operator's yolo judges such a root by what lies under it, so
 * the authority rails treat it as a write there rather than a delete of the
 * root and every tree above (#419).
 */
export function extractFilteredFindDeleteRoots(command: string): string[] {
	const roots: string[] = [];
	for (const tokens of expandedShellSegments(command)) {
		const segment = shellCommandArguments(tokens);
		const commandIndex = commandTokenIndex(segment);
		if (commandIndex === null || basenameToken(segment[commandIndex]) !== "find" || !segment.includes("-delete"))
			continue;
		const args = segment.slice(commandIndex + 1);
		if (findExpressionFilters(args)) roots.push(...findRoots(args));
	}
	return roots.filter(isInterestingWriteTarget);
}
