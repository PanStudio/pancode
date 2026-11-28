// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Dirent } from "node:fs";
import { lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ReadScopeInputs } from "./policy-read-only-inspectors.js";
import {
	expandOperandGlob,
	hasUnquotedExpansion,
	operandStaysInWorkspace,
	readOnlyInspectionRule,
} from "./policy-read-only-inspectors.js";
import type { ShellToken } from "./shell-scan.js";
import { scanShellLike } from "./shell-scan.js";

export const READ_ONLY_LOOP_RULE_ID = "builtin:read-only-loop";

/**
 * Loop body commands. Values are proven when the call is admitted, and a file created before the loop runs (named
 * `x -i`, say) word-splits into a new argument, so a body command must have no option that writes, runs or reads a
 * list file at all: sed, find and every command with an output or in-place flag stay out even where they are a
 * read-only step outside a loop.
 */
const LOOP_BODY_COMMANDS: ReadonlySet<string> = new Set(["cat", "head", "tail", "wc", "echo", "grep", "ls", "stat"]);

/** Lowercase only: PATH, IFS, CDPATH and every other variable the shell reads are uppercase. */
const LOOP_NAME = /^[a-z_][a-z0-9_]*$/u;

/** Characters word splitting and pathname expansion leave alone, so an unquoted value reaches the body as one word. */
const PLAIN_VALUE = /^[A-Za-z0-9._+@%,:=/-]+$/u;

/** find actions that print words other than the paths it visits. */
const FIND_FREE_OUTPUT = /^-(?:printf|print0|ls|fprint|fprint0|fprintf|fls)$/u;

/** find leading options that neither follow symlinks nor take a separate operand. */
const FIND_LEADING_OPTION = /^-(?:P|O\d*)$/u;

/**
 * A double-quoted `echo` label (`"== $f"`, `"=== ${f} ==="`) whose every `$` is strictly `$name` or `${name}` with no
 * escapes, nested quotes, or command substitutions. Returns the word with each reference replaced by `x` for the
 * inspector check, or null.
 */
function echoLabelReference(source: string, name: string): string | null {
	if (source.length < 4 || !source.startsWith('"') || !source.endsWith('"')) return null;
	const inner = source.slice(1, -1);
	if (/["\\`]/u.test(inner)) return null;
	const bare = `$${name}`;
	const braced = `\${${name}}`;
	let out = "";
	let matched = 0;
	for (let index = 0; index < inner.length; ) {
		if (inner[index] !== "$") {
			out += inner[index];
			index += 1;
			continue;
		}
		if (inner.startsWith(braced, index)) {
			out += "x";
			matched += 1;
			index += braced.length;
			continue;
		}
		if (inner.startsWith(bare, index) && !/[A-Za-z0-9_]/u.test(inner[index + bare.length] ?? "")) {
			out += "x";
			matched += 1;
			index += bare.length;
			continue;
		}
		return null;
	}
	return matched > 0 ? `"${out}"` : null;
}

export interface ReadOnlyLoop {
	/** Segments the loop spans, from its `for` through its `done`. */
	segments: number;
	/** Source spans of the proven words: the value list's substitution and each loop variable reference. */
	provenSpans: ReadonlyArray<{ start: number; end: number }>;
}

/**
 * A `for NAME in LIST; do BODY; done` loop that only reads, starting at `segments[at]`, or null. LIST is literal words,
 * `*`/`?` globs, or one `$(find START... EXPR)` whose find is a recognized read-only find that prints only paths. Every
 * value NAME can take, from every directory the step may run in, is proven before the body is judged: a find's values
 * are START and every entry under it (a superset of what find prints, walked without following links on the shared
 * walk budget), and each must be readable, physically inside the workspace, and spelled so splitting and globbing
 * cannot change it. The body is judged with every whole-word `$NAME` replaced by all values, the way a glob operand's
 * matches are judged.
 */
export function readOnlyLoop(
	segments: ReadonlyArray<ReadonlyArray<ShellToken>>,
	joins: ReadonlyArray<string | undefined>,
	at: number,
	command: string,
	cwds: ReadonlyArray<string>,
	workspaceRoot: string,
	readScope: ReadScopeInputs,
): ReadOnlyLoop | null {
	const head = segments[at] ?? [];
	const [forWord, nameWord, inWord, ...listWords] = head;
	const raw = (token: ShellToken): string => command.slice(token.start, token.end);
	if (forWord === undefined || raw(forWord) !== "for" || nameWord === undefined || inWord === undefined) return null;
	if (raw(inWord) !== "in" || !LOOP_NAME.test(raw(nameWord)) || joins[at + 1] !== ";") return null;
	if (listWords.length === 0 || listWords.some((word) => word.unterminated)) return null;
	const name = nameWord.value;
	const doSegment = segments[at + 1];
	if (doSegment === undefined || doSegment[0] === undefined || raw(doSegment[0]) !== "do") return null;
	const body: Array<{ words: ReadonlyArray<ShellToken>; piped: boolean }> = [];
	let doneAt = -1;
	for (let index = at + 1; index < segments.length; index += 1) {
		const segment = index === at + 1 ? doSegment.slice(1) : (segments[index] ?? []);
		if (index > at + 1 && segment.length === 1 && segment[0] !== undefined && raw(segment[0]) === "done") {
			if (joins[index] !== ";") return null;
			doneAt = index;
			break;
		}
		if (segment.length === 0) {
			// `do` on a line of its own.
			if (index === at + 1 && joins[index + 1] === ";") continue;
			return null;
		}
		body.push({ words: segment, piped: index > at + 1 && joins[index] === "|" });
	}
	if (doneAt === -1 || body.length === 0) return null;

	const provenSpans: Array<{ start: number; end: number }> = [];
	const references = new Set([`$${name}`, `\${${name}}`, `"$${name}"`, `"\${${name}}"`]);
	const echoSubstitutions = new Map<ShellToken, string>();
	for (const { words } of body) {
		const [commandWord] = words;
		const commandName = commandWord === undefined ? "" : raw(commandWord);
		if (!LOOP_BODY_COMMANDS.has(commandName)) return null;
		for (const word of words) {
			if (word.unterminated) return null;
			const source = raw(word);
			if (references.has(source)) {
				provenSpans.push({ start: word.start, end: word.end });
				continue;
			}
			if (commandName === "echo" && word !== commandWord && word.substitutions === undefined) {
				const substituted = echoLabelReference(source, name);
				if (substituted !== null) {
					echoSubstitutions.set(word, substituted);
					provenSpans.push({ start: word.start, end: word.end });
					continue;
				}
			}
			if (word.substitutions !== undefined || /[$`]/u.test(source)) return null;
		}
	}
	const finds = listWords.filter((word) => word.substitutions !== undefined);
	if (finds.length > 1) return null;
	for (const find of finds) provenSpans.push({ start: find.start, end: find.end });

	for (const from of cwds) {
		const values: string[] = [];
		for (const word of listWords) {
			const listed = loopListValues(word, raw(word), from, workspaceRoot, readScope);
			if (listed === null) return null;
			values.push(...listed);
		}
		const proven = values.every(
			(value) =>
				PLAIN_VALUE.test(value) &&
				!value.startsWith("-") &&
				readScope.readable(path.resolve(from, value)) &&
				operandStaysInWorkspace(value, from, workspaceRoot, readScope),
		);
		if (!proven) {
			readScope.notes.push(
				`the \`for ${name}\` loop reaches a path that is outside the workspace, zero-access, or spelled with characters the shell would split or expand; name the files`,
			);
			return null;
		}
		const replacement = values.length > 0 ? values.join(" ") : "x";
		for (const { words, piped } of body) {
			const text = words
				.map((word) => {
					const echoLabel = echoSubstitutions.get(word);
					if (echoLabel !== undefined) return echoLabel;
					return references.has(raw(word)) ? replacement : raw(word);
				})
				.join(" ");
			if (readOnlyInspectionRule(scanShellLike(text), text, from, workspaceRoot, readScope, piped) === null) return null;
		}
	}
	return { segments: doneAt - at + 1, provenSpans };
}

/** The values one LIST word gives the loop variable, or null when they cannot be bounded. */
function loopListValues(
	word: ShellToken,
	source: string,
	cwd: string,
	workspaceRoot: string,
	readScope: ReadScopeInputs,
): string[] | null {
	if (word.substitutions !== undefined) {
		const [inner] = word.substitutions;
		if (word.substitutions.length !== 1 || inner === undefined || source !== `$(${inner})`) return null;
		return findValues(inner, cwd, workspaceRoot, readScope);
	}
	if (/[$`]/u.test(source)) return null;
	if (!hasUnquotedExpansion(source)) return [word.value];
	const matches = expandOperandGlob(source, cwd, readScope);
	if (matches === null) return null;
	return matches.length === 0 ? [word.value] : matches;
}

/** START and every entry under it, for a recognized read-only find that prints only the paths it visits. */
function findValues(inner: string, cwd: string, workspaceRoot: string, readScope: ReadScopeInputs): string[] | null {
	if (inner.includes("#") || inner.includes("\n")) return null;
	const words = scanShellLike(inner);
	if (
		words.length === 0 ||
		words.some((word) => word.operator || word.unterminated || /[$`]/u.test(inner.slice(word.start, word.end)))
	)
		return null;
	if (inner.slice(words[0]?.start, words[0]?.end) !== "find") return null;
	if (
		words.some(
			(word) =>
				FIND_FREE_OUTPUT.test(word.value) ||
				word.value === "--" ||
				word.value === "-H" ||
				word.value === "-f" ||
				word.value.startsWith("-D"),
		)
	)
		return null;
	if (readOnlyInspectionRule(words, inner, cwd, workspaceRoot, readScope) === null) return null;
	let index = 1;
	while (index < words.length && FIND_LEADING_OPTION.test(words[index]?.value ?? "")) index += 1;
	const starts: string[] = [];
	for (; index < words.length; index += 1) {
		const word = words[index];
		if (word === undefined || /^[-(!)]/u.test(word.value) || word.value === ",") break;
		if (hasUnquotedExpansion(inner.slice(word.start, word.end))) return null;
		starts.push(word.value);
	}
	const values: string[] = [];
	for (const start of starts.length === 0 ? ["."] : starts) {
		const root = path.resolve(cwd, start);
		const stats = lstatSync(root, { throwIfNoEntry: false });
		if (stats === undefined) return null;
		if (!operandStaysInWorkspace(start, cwd, workspaceRoot, readScope)) return null;
		values.push(start);
		// Trailing slash or `/.` on a symlink start point makes GNU find traverse it even without -H/-L.
		const walkRoot =
			stats.isDirectory() || (stats.isSymbolicLink() && statSync(root, { throwIfNoEntry: false })?.isDirectory() === true);
		if (!walkRoot) continue;
		const pending = [start];
		for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
			let entries: Dirent[];
			try {
				entries = readdirSync(path.resolve(cwd, current), { withFileTypes: true });
			} catch {
				// A directory that cannot be listed cannot be bounded.
				return null;
			}
			for (const entry of entries) {
				readScope.walkBudget.remaining -= 1;
				if (readScope.walkBudget.remaining < 0) return null;
				const value = current.endsWith("/") ? `${current}${entry.name}` : `${current}/${entry.name}`;
				values.push(value);
				if (entry.isDirectory()) pending.push(value);
			}
		}
	}
	return values;
}
