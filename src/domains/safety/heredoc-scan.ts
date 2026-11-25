// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { basenameToken } from "./command-token.js";
import type { HeredocDataMode, HeredocReader } from "./heredoc-bodies.js";
import { heredocDataOutputs, removeHeredocBodies, withoutHeredocBodies } from "./heredoc-bodies.js";
import { readOnlyInspectionStep } from "./read-only-steps.js";
import type { ShellToken } from "./shell-scan.js";
import {
	cachedShellScan,
	SHELL_REDIRECTIONS,
	SHELL_WRITE_REDIRECTIONS,
	scanShellLike,
	scanShellText,
	shellCommandArguments,
	splitSegments,
} from "./shell-scan.js";
import { INNER_SHELL_MAX_DEPTH, SHELL_SETUP_STEPS, segmentShellScript, shellSteps } from "./shell-segments.js";

/**
 * FX-1: the command's tokens with its quoted here-document bodies skipped, for the redirect reading, or null when every
 * body stays commands: none was skipped, one is unquoted, a shell may read one ({@link scanSkippingHeredocBodies} keeps
 * those, and every body when a function, alias or PATH change may redefine the reader), or `cat` or `tee` copies one into
 * a file a later step may run ({@link mayRunHeredocOutputs}). A redirect on the command line itself stays in the tokens.
 */
export function heredocInertRedirectTokens(text: string): ReadonlyArray<ShellToken> | null {
	if (!text.includes("<<")) return null;
	const scan = cachedShellScan(text, true);
	if (scan.bodies.length === 0) return null;
	const heads = scanShellText(text, scan.bodies);
	const withoutBodies = withoutHeredocBodies(text);
	for (let index = 0; index < heads.length; index += 1) {
		const token = heads[index];
		if (token?.operator !== true || token.value !== "<<") continue;
		const next = heads[index + 1];
		const word = next?.value === "-" && next.start === token.end ? heads[index + 2] : next;
		if (word?.quoted !== true || word.operator) return null;
		const outputs = heredocDataOutputs(heads, index);
		if (outputs !== null && outputs.length > 0 && mayRunHeredocOutputs(withoutBodies, outputs)) return null;
	}
	return scan.tokens;
}

/** Writers that run none of the files they touch, so a data here-document's file stays unrun by them. */
const NON_RUNNING_WRITERS: ReadonlySet<string> = new Set([
	"cat",
	"tee",
	"cp",
	"mv",
	"rm",
	"rmdir",
	"mkdir",
	"touch",
	"ln",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
	"unlink",
]);

/**
 * A file name a step may run as a shell script without naming it (bt-low1): a `.sh`, `.bash`, `.zsh` or `.mk` file,
 * or a name with no extension, such as a Makefile, a git hook, a `bin/` tool or `.envrc`.
 */
function shellRunnableOutput(output: string): boolean {
	const name = basenameToken(output);
	return /\.(?:sh|bash|zsh|ksh|mk)$/iu.test(name) || !name.slice(1).includes(".");
}

/**
 * Whether a step of the command, bodies removed, may run a file it does not name: anything but shell setup, read-only
 * inspection and {@link NON_RUNNING_WRITERS}, or any step with a substitution (`make`, `npm test`, `git commit`'s
 * hooks, `for f in *.sh`).
 */
function mayRunUnnamedFile(command: string): boolean {
	return shellSteps(scanShellLike(command)).some((step) => {
		if (step.tokens.some((token) => (token.substitutions?.length ?? 0) > 0 || token.hiddenContent === true)) return true;
		if (step.index === null) return false;
		const argv = step.argv.slice(step.index);
		const [first = ""] = argv;
		if (SHELL_SETUP_STEPS.has(first)) return first === "source" || first === ".";
		return !NON_RUNNING_WRITERS.has(basenameToken(first)) && !readOnlyInspectionStep(argv, true);
	});
}

/**
 * Whether the command, bodies removed, may run a file a data here-document
 * wrote: another word names the file, a function, alias, or PATH change
 * may make `cat` or `tee` something else, or the file is a script some step
 * may run unnamed ({@link shellRunnableOutput}, {@link mayRunUnnamedFile}).
 */
export function mayRunHeredocOutputs(command: string, outputs: ReadonlyArray<string>): boolean {
	if (mayRedefineHeredocCopier(command)) return true;
	if (outputs.some(shellRunnableOutput) && mayRunUnnamedFile(command)) return true;
	const text = command.toLowerCase();
	const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
	for (const output of outputs) {
		const name = basenameToken(output);
		if (name === "") return true;
		const written = outputs.reduce((sum, other) => sum + count(other.toLowerCase(), name), 0);
		if (count(text, name) > written) return true;
	}
	return false;
}

/** Command words that can redefine a command, set a variable, or run text as code. */
const HEREDOC_REDEFINERS: ReadonlySet<string> = new Set([
	"alias",
	"unalias",
	"shopt",
	"function",
	"source",
	".",
	"eval",
	"enable",
	"hash",
	"builtin",
	"command",
	"exec",
	"trap",
	"export",
	"declare",
	"typeset",
	"readonly",
	"local",
	"read",
	"mapfile",
	"readarray",
	"unset",
	"coproc",
]);

/** What may run after a here-document is copied into a file: readers that run no file and write none. */
const HEREDOC_INERT_READERS: ReadonlySet<string> = new Set([
	"cat",
	"tee",
	"echo",
	"printf",
	"mkdir",
	"ls",
	"wc",
	"head",
	"tail",
	"grep",
	"diff",
	"cmp",
	"stat",
	"true",
	"false",
	":",
	"pwd",
	"test",
	"[",
]);

/** Variables whose value changes what a later command word runs or how a line splits. */
const HEREDOC_DANGEROUS_NAMES =
	/^(?:PATH|BASH_ENV|ENV|IFS|CDPATH|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|BASH_FUNC_.*|LD_PRELOAD|LD_LIBRARY_PATH)$/u;

/** Words before a command that run nothing themselves: grouping, negation and the reserved words around a command. */
const HEREDOC_LEADING_WORDS: ReadonlySet<string> = new Set([
	"{",
	"}",
	"!",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"time",
]);

/** Declaring words that only set the plain variables they name. */
const HEREDOC_SETTERS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "local", "readonly"]);

/**
 * Whether the rest of a call (`text`, its quoted here-document bodies removed) is read in full, so the bodies it feeds
 * stay data (row 261): an allow-list that only ever keeps a body read as commands, applied on top of the older checks.
 * Every step's command word is written plainly, holds no `$` or backtick, and cannot redefine a command or run text
 * ({@link HEREDOC_REDEFINERS}; `export` and its kin only of plain names, none that steers lookup or splitting); no
 * step opens a subshell or defines a function, and no word is an ANSI-C string. When a body is copied into files
 * (`outputs`), none lands in `.git` or `.husky`, and every step after the first copy is a pure reader
 * ({@link HEREDOC_INERT_READERS}) with no `$`, backtick or substitution, named unlike any copy, writing nowhere but those
 * copies, `/dev/null` or another descriptor; a copy named with `$` is trusted only when nothing runs after it.
 */
export function heredocDataTrusted(text: string, outputs: ReadonlyArray<string>): boolean {
	if (outputs.some((output) => output.split("/").some((part) => part.startsWith(".git") || part === ".husky")))
		return false;
	const written = new Set(outputs);
	const names = new Set(outputs.map((output) => basenameToken(output)));
	const tokens = scanShellLike(text);
	if (tokens.some((token) => token.unterminated === true || token.hiddenContent === true)) return false;
	if (tokens.some((token) => token.operator && (token.value === "(" || token.value === ")"))) return false;
	let copied = false;
	for (const segment of splitSegments(tokens)) {
		const words = segment.filter(
			(token, index) =>
				!token.operator &&
				!(segment[index - 1]?.operator === true && SHELL_REDIRECTIONS.has(segment[index - 1]?.value ?? "")),
		);
		const targets = segment.flatMap((token, index) =>
			token.operator && SHELL_WRITE_REDIRECTIONS.has(token.value) ? [segment[index + 1]?.value ?? ""] : [],
		);
		const raw = (token: ShellToken): string => text.slice(token.start, token.end);
		// Read past what runs nothing itself, braces, `!`, reserved words and assignments, to the command (r261f-2).
		let at = 0;
		for (; at < words.length; at += 1) {
			const word = words[at] as ShellToken;
			const assignment = /^([A-Za-z_]\w*)\+?=/u.exec(raw(word));
			if (assignment !== null) {
				if (HEREDOC_DANGEROUS_NAMES.test(assignment[1] ?? "")) return false;
				continue;
			}
			if (raw(word) !== word.value || !HEREDOC_LEADING_WORDS.has(word.value)) break;
		}
		const head = words[at];
		const args = words.slice(at + 1);
		if (head !== undefined) {
			if (raw(head) !== head.value || /[$`]/u.test(head.value)) return false;
			if (HEREDOC_SETTERS.has(head.value)) {
				for (const word of args) {
					if (word.value.startsWith("-")) continue;
					const name = /^([A-Za-z_]\w*)(?:\+?=|$)/u.exec(raw(word));
					if (name === null || HEREDOC_DANGEROUS_NAMES.test(name[1] ?? "")) return false;
				}
			} else if (HEREDOC_REDEFINERS.has(head.value)) return false;
			if (head.value === "printf" && words.some((word) => word.value.startsWith("-v"))) return false;
		}
		const copies =
			targets.some((target) => written.has(target)) ||
			(head?.value === "tee" && args.some((word) => written.has(word.value)));
		if (copied && head !== undefined) {
			// After a copy nothing may run it, rewrite it elsewhere, or be named like it.
			if (segment.some((token) => /[$`]/u.test(raw(token)) || (token.substitutions?.length ?? 0) > 0)) return false;
			if (outputs.some((output) => /[$`]/u.test(output))) return false;
			if (!HEREDOC_INERT_READERS.has(head.value) || names.has(basenameToken(head.value))) return false;
			if (targets.some((target) => !written.has(target) && target !== "/dev/null" && !/^(?:\d+-?|-)$/u.test(target)))
				return false;
			if (head.value === "tee" && args.some((word) => !word.value.startsWith("-") && !written.has(word.value)))
				return false;
		}
		if (copies) copied = true;
	}
	return true;
}

/** A redefined recipient need not treat stdin as data, even when its original command did. */
function mayRedefineHeredocCopier(command: string): boolean {
	return /\bPATH=|\b(?:alias|function|source|eval|enable|hash)\b|\(\s*\)|(?:^|[\s;&|])\.[ \t]/u.test(command);
}

/**
 * Omit quoted data fed to known stdin sinks or copied into files, unless another
 * command may redefine the recipient. The floor needs every body to be known
 * data, including copies by `cat` or `tee` whose output is run separately
 * (SF-5, SF-6). The secret rail leaves file copies and ambiguous readers in
 * place, but can omit known stdin data before them (XR-43). Only the safety rails (`reader` "rails") also require
 * {@link heredocDataTrusted}; every other reader, such as a check's exit scope, keeps b1c4855bf's reading (row 261).
 */
export function withoutDataHeredocBodies(
	command: string,
	mode: HeredocDataMode = "all",
	reader: HeredocReader = "base",
): string {
	if (!command.includes("<<")) return command;
	const { text, dataOutputs } = removeHeredocBodies(command, false, mode);
	if (text === command) return command;
	if (
		mode === "all" &&
		(dataOutputs === null || scanShellLike(text).some((token) => token.operator && token.value === "<<"))
	)
		return command;
	return mayRedefineHeredocCopier(text) || (reader === "rails" && !heredocDataTrusted(text, dataOutputs ?? []))
		? command
		: text;
}

/** scanShellLike with each substitution's tokens appended after a `;`, for scans that read every word. */
/**
 * A command with its locale quotes (`$"..."`) read as the plain double quotes
 * bash runs them as when no message catalog translates them, or null (#419).
 * Every `$"` is rewritten, so the result is accepted only when it scans to the
 * same words and operators as the original and hides nothing: a `$"` that was
 * not a locale opener (inside single quotes, after a backslash) changes a word
 * and is refused, as is an ANSI-C escape that cannot be decoded.
 */
export function decodedLocaleQuoting(command: string): string | null {
	const decoded = command.replaceAll('$"', '"');
	if (decoded === command) return null;
	const before = scanShellLikeDeep(command);
	const after = scanShellLikeDeep(decoded);
	if (after.some((token) => token.hiddenContent) || before.length !== after.length) return null;
	const same = before.every(
		(token, index) => token.value === after[index]?.value && token.operator === after[index]?.operator,
	);
	return same ? decoded : null;
}

/**
 * FX-9: with `skipInertHeredocBodies`, a quoted here-document body no shell may read (`python3 - <<'EOF'`) is input
 * text, not commands, as for the redirect reading ({@link heredocInertRedirectTokens}).
 */
export function scanShellLikeDeep(command: string, depth = 0, skipInertHeredocBodies = false): ShellToken[] {
	const inert = skipInertHeredocBodies ? heredocInertRedirectTokens(command) : null;
	const tokens = inert === null ? scanShellLike(command) : [...inert];
	if (depth >= INNER_SHELL_MAX_DEPTH) return tokens;
	const inner = tokens.flatMap((token) =>
		(token.substitutions ?? []).flatMap((script) => [
			{ value: ";", operator: true, quoted: false, start: token.start, end: token.start },
			...scanShellLikeDeep(script, depth + 1, skipInertHeredocBodies),
		]),
	);
	for (const segment of splitSegments(tokens)) {
		const script = segmentShellScript(shellCommandArguments(segment));
		if (typeof script === "string") {
			inner.push(
				{ value: ";", operator: true, quoted: false, start: 0, end: 0 },
				...scanShellLikeDeep(script, depth + 1, skipInertHeredocBodies),
			);
		}
	}
	return [...tokens, ...inner];
}
