// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { canonicalizeRawPath } from "../../core/path-canonical.js";
import { classifyBashGit, splitGitChdir } from "./git-policy.js";
import { hasSequencingOperators, isUnderOrSame } from "./policy-call-args.js";
import {
	BUILTIN_ALLOWLIST,
	MAKE_CLEAN_COMMAND,
	PROJECT_SCRIPT_COMMANDS,
	quotedStep,
	TEST_RUNNER_COMMANDS,
} from "./policy-command-tables.js";
import { matchingProjectCommand } from "./policy-damage-resort.js";
import { projectScriptPreview } from "./policy-damage-scans.js";
import type { ChainRecognition, ReadScopeInputs } from "./policy-read-only-inspectors.js";
import {
	CHAIN_MAX_SEGMENTS,
	CHAIN_OPERATORS,
	expandOperandGlob,
	hasUnquotedExpansion,
	isDiscardRedirection,
	operandStaysInWorkspace,
	readOnlyInspectionRule,
} from "./policy-read-only-inspectors.js";
import type { LoadedProjectSafetyPolicy } from "./project-policy.js";
import type { ShellToken } from "./shell-scan.js";
import { scanShellLike } from "./shell-scan.js";

/**
 * Recognition for compound commands built from recognized parts: `cd <workspace
 * dir> && <recognized command>`, test runners and project scripts, and
 * read-only inspection joined by `&&`, `||`, `;` or `|` (`ls -la && cat
 * package.json`, `npm test 2>&1 | tail -30`, `find src -name '*.ts' | head`).
 * Every member is checked on its own and the chain takes its most restrictive
 * member's verdict, so the chain can never admit something its members would
 * not. Redirection is admitted only to /dev/null or between descriptors.
 *
 * This exists because the compound form is what a model reaches for first and
 * the flat rule cost more than it bought: in a recorded live drive 34 of 75
 * calls were blocked, nearly all of them `cd x && y`, since an unrecognized
 * execute asks in default mode and a headless run answers every ask with a
 * denial (REPORT-dispatch-drive-1.md S2). The v0.6.0 flywheel showed the same
 * tax on read-only openers (`ls src/ && cat package.json`, `find . -name
 * "*.test.js" | head -5`) parked behind approval cards during a plan-only turn.
 * Meanwhile `sh -c '<anything>'` sailed past the same rail, so the rail was
 * mostly taxing the honest spelling. The `sh -c` half is closed at both ends
 * now: this function recognizes such a command by its inner script, and the
 * shared write-target scanner reads inside the script too.
 */
export function recognizeCommandChain(
	command: string,
	callCwd: string,
	workspaceRoot: string,
	policy: LoadedProjectSafetyPolicy,
	readScope: ReadScopeInputs,
): ChainRecognition | null {
	const tokens = scanShellLike(command);
	const segments: ShellToken[][] = [];
	// joins[i] is the operator in front of segments[i].
	const joins: Array<string | undefined> = [undefined];
	let current: ShellToken[] = [];
	// Only && makes a later step conditional on a cd having taken effect.
	let onlyAnd = true;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (!token.operator) {
			current.push(token);
			continue;
		}
		if (CHAIN_OPERATORS.has(token.value)) {
			segments.push(current);
			joins.push(token.value);
			current = [];
			if (token.value !== "&&") onlyAnd = false;
			continue;
		}
		const target = tokens[index + 1];
		if (target === undefined || target.operator || !isDiscardRedirection(token.value, target.value)) {
			readScope.notes.push(
				`redirection \`${token.value}${target === undefined ? "" : ` ${target.value}`}\` is recognized only to /dev/null or between descriptors`,
			);
			return null;
		}
		// An adjacent unquoted number is the redirection's descriptor, not an argument.
		const previous = current.at(-1);
		if (previous !== undefined && previous.end === token.start && !previous.quoted && /^\d+$/u.test(previous.value))
			current.pop();
		index += 1;
	}
	segments.push(current);
	if (segments.length > CHAIN_MAX_SEGMENTS) {
		readScope.notes.push(
			`the command has ${segments.length} steps and at most ${CHAIN_MAX_SEGMENTS} are recognized in one call; split it or pass several files to one cat`,
		);
		return null;
	}
	// A lone command keeps its standalone rules; this path adds only what the
	// compound or a discard redirection needs, plus read-only inspection.
	if (segments.length < 2 && tokens.every((token) => !token.operator)) {
		const [only] = segments;
		const rule = only === undefined ? null : readOnlyInspectionRule(only, command, callCwd, workspaceRoot, readScope);
		return rule === null
			? null
			: {
					ruleIds: [rule],
					requiresConfirmation: false,
					requiresAutonomyApproval: false,
					runsTestRunner: false,
					scriptPreviews: [],
				};
	}
	const ruleIds: string[] = [];
	let requiresConfirmation = false;
	let requiresAutonomyApproval = false;
	let runsTestRunner = false;
	let chainCwd = callCwd;
	// Every directory a later step may run in. In a pure && chain a failed cd
	// stops the chain, so there is exactly one. After `||` or `;` a cd may not
	// have taken effect, so each step is judged from every directory it could
	// run in.
	let cwds = [callCwd];
	const scriptPreviews: string[] = [];
	for (const [index, segment] of segments.entries()) {
		if (segment.length === 0) return null;
		if (segment[0]?.value === "cd") {
			// A cd inside a pipeline runs in a subshell and moves nothing.
			if (joins[index] === "|" || joins[index + 1] === "|") return null;
			// Each later command runs in this directory, including project-policy
			// cwd matching and script previews. Keep both logical and physical
			// readings inside the workspace before recognizing the transition.
			if (segment.length !== 2) return null;
			const target = segment[1]?.value ?? "";
			if (target.startsWith("~")) return null;
			// `cd li?` resolves lexically here but the shell expands the glob, which can
			// land in a symlink target outside the workspace.
			const targetWord = segment[1];
			if (targetWord !== undefined && hasUnquotedExpansion(command.slice(targetWord.start, targetWord.end))) return null;
			const reached: string[] = [];
			for (const from of cwds) {
				const nextCwd = path.resolve(from, target);
				if (!isUnderOrSame(nextCwd, workspaceRoot)) return null;
				// A shell `cd` is logical unless `-P` or `set -P` makes it physical;
				// recognize it only when both readings stay inside.
				const physical = canonicalizeRawPath(target, from);
				if (physical === null || !isUnderOrSame(physical, workspaceRoot)) return null;
				reached.push(nextCwd);
			}
			chainCwd = reached.at(-1) ?? chainCwd;
			cwds = onlyAnd ? reached : [...new Set([...cwds, ...reached])];
			ruleIds.push("builtin:cd-workspace");
			continue;
		}
		// Re-rendered from tokens, so quoting is gone: a member that needed its
		// quotes fails the allowlist regex and the whole chain stays unrecognized.
		const rendered = segment.map((word) => word.value).join(" ");
		const projectScript = PROJECT_SCRIPT_COMMANDS.find((entry) => entry.re.test(rendered));
		if (projectScript !== undefined) scriptPreviews.push(projectScriptPreview(rendered, chainCwd));
		const projectMatches = cwds.map((from) => matchingProjectCommand(policy, rendered, from));
		const projectMatch = projectMatches.every((match) => match !== null) ? projectMatches[0] : null;
		if (projectMatch) {
			ruleIds.push(projectMatch.id);
			if (projectMatch.requireConfirmation) requiresConfirmation = true;
			continue;
		}
		const testRunner = TEST_RUNNER_COMMANDS.find((entry) => entry.re.test(rendered));
		if (testRunner !== undefined) {
			ruleIds.push(testRunner.id);
			runsTestRunner = true;
			continue;
		}
		if (MAKE_CLEAN_COMMAND.re.test(rendered)) {
			ruleIds.push(MAKE_CLEAN_COMMAND.id);
			runsTestRunner = true;
			continue;
		}
		if (projectScript !== undefined) {
			ruleIds.push(projectScript.id);
			requiresAutonomyApproval = true;
			continue;
		}
		const builtin = BUILTIN_ALLOWLIST.find((entry) => entry.re.test(rendered));
		if (builtin !== undefined) {
			ruleIds.push(builtin.id);
			continue;
		}
		if (
			!hasSequencingOperators(rendered) &&
			cwds.every((from) => isGitInspection(segment, command, from, workspaceRoot, readScope))
		) {
			ruleIds.push(GIT_INSPECT_RULE_ID);
			continue;
		}
		// Quoted words stay whole here (`find . -name "*.ts"`), which the
		// re-rendered allowlist string above cannot express.
		const inspections = cwds.map((from) =>
			readOnlyInspectionRule(segment, command, from, workspaceRoot, readScope, joins[index] === "|"),
		);
		const inspection = inspections.every((rule) => rule !== null) ? inspections[0] : null;
		if (inspection !== null && inspection !== undefined) {
			ruleIds.push(inspection);
			continue;
		}
		if (readScope.notes.length === 0) readScope.notes.push(`${quotedStep(rendered)} is not a recognized read-only step`);
		return null;
	}
	return { ruleIds, requiresConfirmation, requiresAutonomyApproval, runsTestRunner, scriptPreviews };
}

export const GIT_INSPECT_RULE_ID = "builtin:git-inspect";

/** A glob match Git may receive: plain file-name characters that rejoin and rescan as the same one word. */
const GIT_GLOB_MATCH = /^[A-Za-z0-9_./@%+,=-]+$/u;

/**
 * A plain `git` command the shared Git policy classifies as inspection only.
 * The fixed regexes above recognize `git log --oneline -n 3` but asked for
 * `git log --oneline -3`, and a headless run denied it. The policy already
 * refuses global options, helpers and output files (`-c`, `--ext-diff`,
 * `--output`), so it decides instead of one regex per spelling. An env or
 * path prefix is not plain `git` and stays unrecognized. Leading `-C <dir>`
 * options are the one global option accepted: see {@link gitChdirTarget}.
 */
export function isGitInspection(
	words: ReadonlyArray<ShellToken>,
	source: string,
	cwd: string,
	workspaceRoot: string,
	readScope: ReadScopeInputs,
): boolean {
	if (words[0]?.value !== "git") return false;
	// Every word is judged as written. One the shell expands or substitutes
	// names files the checks below cannot see.
	if (words.some((word) => (word.substitutions?.length ?? 0) > 0)) return false;
	// A `*` or `?` pathspec glob (`git diff -- *.py`) is expanded the way bash
	// would expand it, as readOnlyInspectionRule does, and Git receives the
	// matches. Every match is judged below like a literal operand; one that
	// would read as an option or reparse as shell is refused. Any other
	// expansion hides the real argument.
	const gitArgs: string[] = [];
	const expanded = new Set<number>();
	for (const word of words.slice(1)) {
		const raw = source.slice(word.start, word.end);
		if (!hasUnquotedExpansion(raw, true)) {
			gitArgs.push(word.value);
			continue;
		}
		const matches = expandOperandGlob(raw, cwd, readScope);
		if (matches === null) return false;
		if (matches.length === 0) {
			// bash passes an unmatched glob through, and Git reads it as a pathspec pattern.
			expanded.add(gitArgs.length);
			gitArgs.push(word.value);
			continue;
		}
		if (matches.some((match) => match.startsWith("-") || !GIT_GLOB_MATCH.test(match))) return false;
		if (matches.some((match) => !readScope.readable(path.resolve(cwd, match)))) return false;
		for (const match of matches) {
			expanded.add(gitArgs.length);
			gitArgs.push(match);
		}
	}
	// `git -C <dir> ...` runs as plain git from <dir>. The directories are held
	// to the workspace like a read path and the rest is judged from the last one.
	const split = splitGitChdir(gitArgs);
	if (split === null) return false;
	let gitCwd = cwd;
	for (const dir of split.dirs) {
		const next = gitChdirTarget(dir, gitCwd, workspaceRoot);
		if (next === null) return false;
		gitCwd = next;
	}
	const values = ["git", ...split.rest];
	const verdict = classifyBashGit(values.join(" "));
	if (verdict === null || verdict.class !== "inspect" || verdict.subcommand === null) return false;
	if (GIT_UNRECOGNIZED_SUBCOMMANDS.has(verdict.subcommand)) return false;
	// Whitespace checks keep their own standalone-only recognition above.
	if (verdict.argv.includes("--check")) return false;
	// Non-option words are revisions, pathspecs and option values. They are held
	// to the workspace as readOnlyInspectionRule holds an operand, so an option
	// value that names a file (`--contents /etc/hosts`, `-S /proc/self/environ`)
	// or a pathspec outside the tree is not recognized.
	const subcommandAt = values.indexOf(verdict.subcommand);
	// A glob is a pathspec: in the global options or the subcommand word it
	// would pick what Git runs. `values` drops the `-C` pairs, so count from the end.
	const earliestFromEnd = Math.max(0, ...[...expanded].map((at) => gitArgs.length - at));
	if (earliestFromEnd >= values.length - subcommandAt) return false;
	const operands = values.slice(subcommandAt + 1);
	for (const value of operands) {
		if (value === "--" || value === "-") continue;
		if (value.startsWith("-")) {
			const attached = value.includes("=") ? value.slice(value.indexOf("=") + 1) : "";
			if (attached.startsWith("/") || attached.startsWith("~") || attached.split("/").includes("..")) return false;
			continue;
		}
		if (!operandStaysInWorkspace(value, gitCwd, workspaceRoot, readScope)) return false;
	}
	return true;
}

/**
 * The physical directory a `git -C <dir>` word lands in, or null when it is not
 * provably inside the workspace. Exempt read roots do not count: they exist so
 * a dependency file can be read, and a repository there carries a `.git/config`
 * (`core.fsmonitor`, `core.pager`) the operator never vetted, which Git runs
 * even for inspection. The word is a literal:
 * a variable, backslash, glob, brace, whitespace or tilde may name something
 * else at run time, so any of them asks. A directory that does not exist is
 * Git's own error. The zero-access scan already covered the whole command
 * string, so a protected path named here is blocked before this runs.
 */
function gitChdirTarget(dir: string, from: string, workspaceRoot: string): string | null {
	if (/[*?[\]{}$`\\\s]/u.test(dir) || dir.startsWith("~")) return null;
	const physical = canonicalizeRawPath(dir, from);
	return physical !== null && isUnderOrSame(physical, workspaceRoot) ? physical : null;
}

/**
 * Read-only for Git, but not for the no-prompt rail. `grep` and `blame` print
 * file contents across the whole tree or read files their options name, and
 * `cat-file` dumps any object. The shared Git policy still classes them as
 * inspection, so workers and the typed Git allowance are unchanged; only bash
 * recognition leaves them to the autonomy level.
 */
const GIT_UNRECOGNIZED_SUBCOMMANDS: ReadonlySet<string> = new Set(["grep", "blame", "annotate", "cat-file"]);
