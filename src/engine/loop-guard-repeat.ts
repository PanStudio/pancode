// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { awkOnlyPrints, commandName, sedOnlyPrints, wrappedCommand } from "../core/command-words.js";
import { withoutLeadingCdTo } from "../core/leading-cd.js";
import { READ_ONLY_SHELL_COMMAND_PATTERN } from "../core/read-only-calls.js";
import { ToolNames } from "../core/tool-names.js";
import { effectiveToolCall } from "../core/tool-surface.js";
import { hashToolCall } from "../domains/safety/loop-detector.js";
import { scanShellLike, shellCommandWords, splitSegments } from "../domains/safety/shell-scan.js";
import { gitCallIdentity } from "../tools/git-inspect.js";

/**
 * Arguments that only change how much of the same answer comes back, never
 * which answer it is. Stripped from the stagnation fingerprint so a model
 * cycling limit/offset escalations on an otherwise identical call is caught,
 * while genuinely different queries (new pattern, new path) reset the streak.
 */
export const SIZE_ONLY_ARG_KEYS = new Set(["limit", "offset", "max_bytes", "context"]);

/**
 * A bash call keyed as the command after a leading `cd` into the directory it already runs in, the base bash itself
 * resolves, so `cd <root> && npm test` and `npm test` are one repeat (XR-9). What runs is untouched.
 */
function repeatArgs(
	tool: string,
	args: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
	if (tool !== ToolNames.Bash || typeof args?.command !== "string") return args;
	const base =
		typeof args.cwd === "string" && args.cwd.length > 0 ? path.resolve(process.cwd(), args.cwd) : process.cwd();
	const command = withoutLeadingCdTo(args.command, base);
	return command === args.command ? args : { ...args, command };
}

export function callIdentity(tool: string, args: Record<string, unknown> | undefined): string {
	const git = tool === ToolNames.Git && args !== undefined ? gitCallIdentity(args) : null;
	return hashToolCall(tool, git ?? repeatArgs(tool, args) ?? {});
}

/**
 * The repeat identity of a call as the model wrote it: a gateway `op=call` is
 * judged as the capability it runs, the same unwrapping the hook applies, so
 * the superseded stage and the loop guard agree on what counts as the same call.
 */
export function effectiveCallIdentity(toolName: string, args: unknown): string {
	const unwrapped = effectiveToolCall(toolName, args);
	return callIdentity(unwrapped.toolName, unwrapped.args);
}

/** Plain inspections outside the shared read list. `env` reads only bare; with words it runs a command (Astra r2-4). */
const SHELL_INSPECTIONS: ReadonlySet<string> = new Set(
	"pwd whoami id uname date which stat file du df echo printenv test [ realpath readlink basename dirname".split(" "),
);
/** Redirections that write a file unless their target is the null device or a descriptor. */
const SHELL_WRITE_REDIRECTIONS: ReadonlySet<string> = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);
/** Read-list programs with an option that writes a file or runs a command. */
const READ_PROGRAM_WRITES: Readonly<Record<string, (args: ReadonlyArray<string>) => boolean>> = {
	find: (args) => args.some((word) => /^-(?:delete|exec(?:dir)?|ok(?:dir)?|fprint\w*|fls)$/.test(word)),
	fd: (args) => args.some((word) => /^(?:-[A-Za-z]*[xX]|--exec(?:-batch)?)(?:=|$)/.test(word)),
	rg: (args) => args.some((word) => /^--(?:pre|hostname-bin)/.test(word)),
	tree: (args) => args.some((word) => word.startsWith("-o")),
	sed: (args) => !sedOnlyPrints(args),
	awk: (args) => !awkOnlyPrints(args),
};
/** Git subcommands that only print, whatever their arguments, save `--output`. */
const GIT_INSPECTIONS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"grep",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"rev-list",
	"describe",
	"shortlog",
	"cat-file",
	"merge-base",
	"name-rev",
	"for-each-ref",
	"show-ref",
	"count-objects",
]);
const GIT_BRANCH_LIST_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--all", "--remotes", "--verbose", "--show-current"]);

/**
 * Whether a git segment only reads: its subcommand, past the global options,
 * is an inspection or the list form of branch, tag, remote, stash or
 * worktree. Every other subcommand, and a `-c` that can configure what runs,
 * may change state. A first-word match once read `git -C . commit` and
 * `git gc` as reads (Astra r2-4).
 */
function gitSegmentOnlyReads(words: ReadonlyArray<string>): boolean {
	let index = 1;
	while (index < words.length && words[index]?.startsWith("-")) {
		const option = words[index] ?? "";
		if (option.startsWith("-c") || option.startsWith("--config-env")) return false;
		index += ["-C", "--git-dir", "--work-tree", "--namespace"].includes(option) ? 2 : 1;
	}
	const sub = words[index] ?? "";
	const rest = words.slice(index + 1);
	if (rest.some((word) => word.startsWith("--output"))) return false;
	if (GIT_INSPECTIONS.has(sub)) return true;
	if (sub === "config") return gitConfigOnlyReads(rest);
	if (sub === "branch") return rest.every((word) => GIT_BRANCH_LIST_FLAGS.has(word));
	if (sub === "tag") return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list";
	if (sub === "remote") return rest.length === 0 || ["-v", "--verbose", "get-url", "show"].includes(rest[0] ?? "");
	if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
	return sub === "worktree" && rest[0] === "list";
}

/**
 * Whether `git config` with these words only reads: a get or list action, or
 * one key name with no value.
 */
function gitConfigOnlyReads(words: ReadonlyArray<string>): boolean {
	const operands: string[] = [];
	let read = false;
	for (let index = 0; index < words.length; index++) {
		const word = words[index] ?? "";
		if (["-f", "--file", "--blob", "--type", "--default"].includes(word)) index++;
		else if (/^--(?:get(?:-all|-regexp|-urlmatch)?|list)$|^-l$/.test(word)) read = true;
		else if (word.startsWith("-")) {
			const modifier =
				/^--(?:global|system|local|worktree|show-origin|show-scope|null|name-only|bool|int|bool-or-int|path|expiry-date|includes|no-includes|all|regexp|fixed-value)$|^-z$/;
			if (!modifier.test(word) && !/^--(?:file|blob|type|default|value|url)=/.test(word)) return false;
		} else operands.push(word);
	}
	if (operands[0] === "get" || operands[0] === "list") return true;
	return read || operands.length === 1;
}

/**
 * Whether one simple command only reads, read from its words after the shell
 * split them: leading assignments and wrappers are looked through, a program
 * named by path is judged by its name, and a read-list program is judged by
 * its options (Astra r2-4, SF-4).
 */
function segmentOnlyReads(input: ReadonlyArray<string>): boolean {
	// `cd <one path>` reads nothing and writes nothing, so a cd-prefixed read stays a read (X1). Only the
	// builtin counts: a bare `cd`, or one through `builtin` or `command`, with no leading assignment, since
	// `./cd`, `env cd` or `sudo cd` runs a program, and no `$`, since an expansion such as `${X@P}` can run code.
	const cd = input[0] === "cd" ? 1 : (input[0] === "builtin" || input[0] === "command") && input[1] === "cd" ? 2 : 0;
	if (cd > 0) {
		const operand = input[cd] ?? "-";
		return input.length === cd + 1 && !operand.startsWith("-") && !operand.includes("$");
	}
	let words = input;
	while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words = words.slice(1);
	for (let depth = 0; depth < 8; depth++) {
		const inner = wrappedCommand(words);
		if (inner === undefined) break;
		if (inner === null) return false;
		if (inner.length === 0) return words.length === 1 && commandName(words[0] ?? "") === "env";
		words = inner;
	}
	const program = commandName(words[0] ?? "");
	const args = words.slice(1);
	if (program === "git") return gitSegmentOnlyReads(["git", ...args]);
	const listed = READ_ONLY_SHELL_COMMAND_PATTERN.exec(program)?.[0].trim() === program;
	return (listed || SHELL_INSPECTIONS.has(program)) && READ_PROGRAM_WRITES[program]?.(args) !== true;
}

/**
 * Whether a bash command can only read: every simple command in it reads, by
 * the words the shell would pass it, so an operator inside quotes splits
 * nothing, and no redirection writes a file. A substitution, a here-document
 * or a line the scanner cannot bound may have changed what a later identical
 * read returns.
 */
export function shellCommandOnlyReads(command: unknown): boolean {
	if (typeof command !== "string" || command.trim().length === 0 || command.includes("\n")) return false;
	const tokens = scanShellLike(command);
	if (tokens.some((token) => token.unterminated || token.hiddenContent || token.substitutions !== undefined))
		return false;
	return splitSegments(tokens).every((segment) => {
		for (const [index, token] of segment.entries()) {
			if (!token.operator) continue;
			if (token.value.startsWith("<<")) return false;
			if (!SHELL_WRITE_REDIRECTIONS.has(token.value)) continue;
			const target = segment[index + 1];
			if (target === undefined || target.operator) return false;
			if (target.value !== "/dev/null" && !(token.value === ">&" && /^(?:\d+|-)$/.test(target.value))) return false;
		}
		return segmentOnlyReads(shellCommandWords(segment).map((token) => token.value));
	});
}

export function stagnationFingerprint(tool: string, args: Record<string, unknown> | undefined): string {
	const reduced: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(repeatArgs(tool, args) ?? {})) {
		if (!SIZE_ONLY_ARG_KEYS.has(key)) reduced[key] = value;
	}
	return hashToolCall(tool, reduced);
}
