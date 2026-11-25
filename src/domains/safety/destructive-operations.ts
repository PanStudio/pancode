// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { canonicalizeExistingPath, canonicalizeRawPath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { findRoots } from "./command-path-walks.js";
import { redirectWriteTarget } from "./command-write-targets.js";
import type {
	DestructiveCommandClassification,
	DestructiveCommandOperation,
	NormalizedArtifact,
	ProtectedArtifactCommandMatch,
} from "./protected-artifacts.js";
import { resetLeavesPath } from "./reset-reach.js";
import type { ShellToken } from "./shell-scan.js";
import { SHELL_WRITE_REDIRECTIONS } from "./shell-scan.js";
import { hasUnparsedShellScript } from "./shell-segments.js";
import { pathArgs } from "./validation-check-match.js";

export function classifyRedirect(
	segment: ReadonlyArray<ShellToken>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	for (let index = 0; index < segment.length; index += 1) {
		// Keep the existing distinction between overwriting and appending here.
		if (segment[index]?.value === ">>" || segment[index]?.value === "&>>") continue;
		const target = redirectWriteTarget(segment[index], segment[index + 1]);
		if (target === null) continue;
		const matches = matchesForPaths([target], artifacts, "target", "redirect can overwrite protected artifacts");
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "redirect",
				matches,
			};
		}
	}
	return { kind: "benign", matches: [] };
}

export function classifyGitOperation(
	args: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
	reading: { precise: boolean; moved: boolean },
): DestructiveCommandClassification {
	const subcommand = args[0];
	const at = gitSubcommandIndex(args);
	const rest = args.slice(at + 1);
	// `-C` moves where git runs, which the reading of each path's own repository already covers; any other global
	// option (`--git-dir`, `--work-tree`, `-c core.worktree=`) may point the reset elsewhere.
	const plainGlobals = args.slice(0, at).every((word, index, globals) => word === "-C" || globals[index - 1] === "-C");
	if (args[at] === "reset" && rest.includes("--hard")) {
		const target = reading.precise && plainGlobals ? hardResetTarget(rest) : null;
		const reached =
			target === null ? artifacts : artifacts.filter(({ artifact }) => !resetLeavesPath(artifact.path, target));
		if (reached.length === 0) return { kind: "benign", matches: [] };
		return {
			kind: "destructive",
			operation: "git_reset_hard",
			matches: reached.map(({ artifact }) => ({
				artifactPath: artifact.path,
				commandPath: ".",
				reason: "git reset --hard can overwrite protected artifacts",
			})),
		};
	}

	// `clean -x` and `-X` delete ignored files, where a desk keeps its records (M-27).
	if (args[at] === "clean") {
		const clean = cleanReading(rest);
		if (clean.dryRun || !clean.ignored) return { kind: "benign", matches: [] };
		const reason = "git clean -x or -X can delete protected artifacts";
		// No pathspec, a magic one (`:!src`, `:/`, `:(top)`), a cd or the call's own cwd, or a global option: every path.
		const matches =
			clean.paths.length === 0 || clean.paths.some((spec) => spec.startsWith(":")) || reading.moved || at > 0
				? artifacts.map(({ artifact }) => ({ artifactPath: artifact.path, commandPath: ".", reason }))
				: matchesForPaths(clean.paths, artifacts, "intersects", reason);
		if (matches.length > 0) return { kind: "destructive", operation: "git_clean", matches };
		return { kind: "benign", matches: [] };
	}

	if (subcommand === "checkout" && args.includes("--")) {
		const paths = args.slice(args.indexOf("--") + 1);
		const matches = matchesForPaths(paths, artifacts, "intersects", "git checkout -- can overwrite protected artifacts");
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "git_checkout",
				matches,
			};
		}
		return { kind: "benign", matches: [] };
	}

	if (subcommand === "restore") {
		const matches = matchesForPaths(
			pathArgs(args.slice(1), -1),
			artifacts,
			"intersects",
			"git restore can overwrite protected artifacts",
		);
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "git_restore",
				matches,
			};
		}
	}

	return { kind: "benign", matches: [] };
}

/** Git global options that take the next word as their value. */
const GIT_GLOBAL_VALUED: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--config-env",
	"--exec-path",
]);

/** Where the subcommand stands in git's words, past its global options. */
function gitSubcommandIndex(args: ReadonlyArray<string>): number {
	let index = 0;
	while (index < args.length && (args[index] as string).startsWith("-")) {
		index += GIT_GLOBAL_VALUED.has(args[index] as string) ? 2 : 1;
	}
	return index;
}

/** The commit a `reset --hard` moves to, or null when its words hold anything else (a flag, a second operand). */
function hardResetTarget(rest: ReadonlyArray<string>): string | null {
	const operands: string[] = [];
	for (const word of rest) {
		if (word === "--hard" || word === "-q" || word === "--quiet") continue;
		if (word.startsWith("-")) return null;
		operands.push(word);
	}
	if (operands.length > 1) return null;
	return operands[0] ?? "HEAD";
}

/** A `git clean`'s dry run, whether it deletes ignored files (`-x`, `-X`), and its pathspecs. */
function cleanReading(rest: ReadonlyArray<string>): { dryRun: boolean; ignored: boolean; paths: string[] } {
	const out = { dryRun: false, ignored: false, paths: [] as string[] };
	for (let index = 0, ended = false; index < rest.length; index += 1) {
		const word = rest[index] as string;
		if (ended || !word.startsWith("-") || word === "-") {
			out.paths.push(word);
			continue;
		}
		if (word === "--") {
			ended = true;
			continue;
		}
		if (word.startsWith("--")) {
			if (word === "--dry-run") out.dryRun = true;
			if (word === "--exclude") index += 1;
			continue;
		}
		for (const [at, flag] of [...word.slice(1)].entries()) {
			if (flag === "n") out.dryRun = true;
			if (flag === "x" || flag === "X") out.ignored = true;
			if (flag === "e") {
				if (at === word.length - 2) index += 1;
				break;
			}
		}
	}
	return out;
}

/** Words that open a loop, a function or a coprocess, whose body may run again before or beside a later step. */
const REPEATING_WORDS: ReadonlySet<string> = new Set(["for", "while", "until", "select", "function", "coproc"]);

/**
 * Whether a command runs its steps once, in the order written: no background job, loop, function, substitution or
 * script the scanner cannot read. Only then does what a step before a hard reset leaves decide what the reset finds.
 */
export function resetShapeHolds(text: string, tokens: ReadonlyArray<ShellToken>): boolean {
	if (hasUnparsedShellScript(text)) return false;
	return tokens.every(
		(token) =>
			!(token.operator && (token.value === "&" || token.value === "|&")) &&
			(token.substitutions?.length ?? 0) === 0 &&
			token.hiddenContent !== true &&
			token.unterminated !== true &&
			(token.operator || token.quoted || !REPEATING_WORDS.has(token.value)),
	);
}

/** Whether the step's output is piped into a later step, which then runs beside it. */
export function pipedOnward(tokens: ReadonlyArray<ShellToken>, step: ReadonlyArray<ShellToken>): boolean {
	const last = step.at(-1);
	if (last === undefined) return false;
	const next = tokens.find((token) => token.start >= last.end && token !== last);
	return next?.operator === true && next.value === "|";
}

/** Plain readers a step before a hard reset may run: none of them changes what git tracks. */
const READER_COMMANDS: ReadonlySet<string> = new Set([
	"cd",
	"pwd",
	"echo",
	"printf",
	"true",
	"false",
	":",
	"test",
	"[",
	"ls",
	"cat",
	"wc",
	"head",
	"tail",
	"grep",
	"sort",
	"uniq",
	"cut",
	"date",
]);

/** Git subcommands a step before a hard reset may run: they read the repository and move no ref or index entry. */
const GIT_READ_STEPS: ReadonlySet<string> = new Set([
	"log",
	"status",
	"diff",
	"show",
	"rev-parse",
	"rev-list",
	"ls-files",
	"cat-file",
	"describe",
]);

/**
 * Whether one step leaves git's state as it found it: a plain reader or a git read, with no prefix, wrapper or
 * assignment, writing only to /dev/null, a descriptor, `$TMPDIR` or a literal path outside any `.git`.
 */
export function stepOnlyReads(
	tokens: ReadonlyArray<ShellToken>,
	words: ReadonlyArray<string>,
	commandIndex: number | null,
): boolean {
	if (commandIndex !== 0) return false;
	const executable = words[0] ?? "";
	const reads =
		READER_COMMANDS.has(executable) ||
		(executable === "git" &&
			GIT_READ_STEPS.has(words[1] ?? "") &&
			!words.some((word) => word.startsWith("--output") || word.startsWith("--ext-diff")));
	if (!reads) return false;
	return tokens.every((token, index) => {
		if (!token.operator || !SHELL_WRITE_REDIRECTIONS.has(token.value)) return true;
		const target = tokens[index + 1];
		if (target === undefined || target.operator) return false;
		const value = target.value;
		if (value === "/dev/null" || /^(?:\d+|-)$/u.test(value)) return true;
		if (/^\$(?:TMPDIR|\{TMPDIR\})\/[^$`]*$/u.test(value)) return !value.split("/").includes(".git");
		return !/[$`~*?[]/u.test(value) && !value.split("/").some((part) => part === ".git" || part === "..");
	});
}

export function classifyFindDelete(
	args: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	if (!args.includes("-delete")) return { kind: "benign", matches: [] };
	const roots = findRoots(args);
	const matches = matchesForPaths(
		roots.length === 0 ? ["."] : roots,
		artifacts,
		"intersects",
		"find -delete can remove protected artifacts",
	);
	if (matches.length > 0) {
		return {
			kind: "destructive",
			operation: "find_delete",
			matches,
		};
	}
	return { kind: "benign", matches: [] };
}

export function classifyPathOperation(
	operation: DestructiveCommandOperation,
	reason: string,
	paths: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	const matches = matchesForPaths(paths, artifacts, "intersects", reason);
	if (matches.length === 0) return { kind: "benign", matches: [] };
	return {
		kind: "destructive",
		operation,
		matches,
	};
}

function matchesForPaths(
	commandPaths: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
	mode: "target" | "intersects",
	reason: string,
): ProtectedArtifactCommandMatch[] {
	const matches: ProtectedArtifactCommandMatch[] = [];
	const seen = new Set<string>();
	for (const commandPath of commandPaths) {
		for (const artifact of artifacts) {
			if (!pathMatchesArtifact(commandPath, artifact.key, mode)) continue;
			const key = `${artifact.key}\0${commandPath}\0${reason}`;
			if (seen.has(key)) continue;
			seen.add(key);
			matches.push({
				artifactPath: artifact.artifact.path,
				commandPath,
				reason,
			});
		}
	}
	matches.sort(compareMatches);
	return matches;
}

function pathMatchesArtifact(commandPath: string, artifactKey: string, mode: "target" | "intersects"): boolean {
	const wildcardRoot = wildcardRootKey(commandPath);
	if (wildcardRoot !== null) {
		return isSameOrDescendant(artifactKey, wildcardRoot, path.posix);
	}
	const commandKey = normalizePathKey(commandPath);
	if (commandKey === null) return false;
	if (mode === "target") return isSameOrDescendant(commandKey, artifactKey, path.posix);
	return (
		isSameOrDescendant(commandKey, artifactKey, path.posix) || isSameOrDescendant(artifactKey, commandKey, path.posix)
	);
}

export function normalizePathKey(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;
	if (isWindowsAbsolutePath(trimmed) && path.sep !== "\\") {
		return toSlashKey(path.win32.normalize(trimmed));
	}
	// Physical, as the kernel resolves `link/..` in a command's path argument.
	const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
	return toSlashKey(canonicalizeRawPath(trimmed, process.cwd()) ?? canonicalizeExistingPath(resolved));
}

function wildcardRootKey(input: string): string | null {
	const normalizedInput = toSlashKey(input.trim());
	const firstWildcard = firstWildcardIndex(normalizedInput);
	if (firstWildcard === null) return null;
	const prefix = normalizedInput.slice(0, firstWildcard);
	const slash = prefix.lastIndexOf("/");
	const root = slash >= 0 ? prefix.slice(0, slash + 1) : ".";
	return normalizePathKey(root);
}

function firstWildcardIndex(input: string): number | null {
	const indexes = ["*", "?", "["].map((char) => input.indexOf(char)).filter((index) => index >= 0);
	if (indexes.length === 0) return null;
	return Math.min(...indexes);
}

function isWindowsAbsolutePath(input: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(input);
}

function toSlashKey(input: string): string {
	return input.replace(/\\/g, "/");
}

function compareMatches(left: ProtectedArtifactCommandMatch, right: ProtectedArtifactCommandMatch): number {
	return (
		compareStrings(left.artifactPath, right.artifactPath) ||
		compareStrings(left.commandPath, right.commandPath) ||
		compareStrings(left.reason, right.reason)
	);
}

export function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
