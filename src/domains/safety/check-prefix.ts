// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { realpathSync } from "node:fs";
import path from "node:path";
import {
	isRefusedValidationWrapper,
	validationWrapperProblem,
} from "../../lib/validation-wrappers/validation-wrappers.js";
import {
	basenameToken,
	commandTokenIndex,
	NO_WRAPPERS,
	pastTransparentWrapper,
	TRANSPARENT_WRAPPERS,
} from "./command-token.js";
import { SHELL_REDIRECTIONS, scanShellLike, splitSegments } from "./shell-scan.js";
import { checkStepMatch } from "./validation-check-match.js";

/**
 * `safety.validationWrappers` (FX-44): repository scripts that run a check with the words after them. The safety
 * domain points it at the live settings, so a reader always sees the change a hot reload made, and resets it when it
 * stops; a worker fixes its own list at start.
 */
let validationWrappers: () => ReadonlyArray<string> = NO_WRAPPERS;

export function setValidationWrappers(source: ReadonlyArray<string> | (() => ReadonlyArray<string>)): void {
	if (typeof source === "function") {
		validationWrappers = source;
		return;
	}
	const fixed = [...source];
	validationWrappers = fixed.length === 0 ? NO_WRAPPERS : () => fixed;
}

/** The wrapper list in force, for a cache whose readings depend on it. */
export function validationWrappersInForce(): ReadonlyArray<string> {
	return validationWrappers();
}

/**
 * What a declared wrapper word runs: the file it names by path from the working directory, or the first match for a
 * bare name on PATH, links resolved; null when it names no file this can resolve (a variable, `~`, a glob, none found).
 */
function resolvedWrapperTarget(word: string, cwd: string = process.cwd()): string | null {
	if (/[~$`*?[\]{}]/u.test(word)) return null;
	const normalized = word.replace(/\\/gu, "/");
	const candidates = normalized.includes("/")
		? [path.resolve(cwd, normalized)]
		: (process.env.PATH ?? "")
				.split(path.delimiter)
				.filter((directory) => directory !== "")
				.map((directory) => path.join(directory, normalized));
	for (const candidate of candidates) {
		try {
			return realpathSync(candidate);
		} catch {
			// Not there; a bare name tries the next PATH directory.
		}
	}
	return null;
}

/**
 * Whether `word` names a declared wrapper: a bare entry by basename, an entry with a slash by that path or its tail.
 * The word must resolve to a file whose real name the shared list does not refuse, so a link to `rm` or a word naming
 * no file is no wrapper; a refused entry never matches, whatever the settings say.
 */
function isValidationWrapper(word: string, cwd?: string): boolean {
	const entries = validationWrappers();
	if (entries.length === 0) return false;
	const name = basenameToken(word);
	if (name === "" || isRefusedValidationWrapper(word)) return false;
	const spelled = word.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
	const declared = entries.some((entry) => {
		if (validationWrapperProblem(entry) !== null) return false;
		const wanted = entry.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
		if (!wanted.includes("/")) return wanted.toLowerCase() === name;
		return spelled === wanted || (!wanted.startsWith("/") && spelled.endsWith(`/${wanted}`));
	});
	if (!declared) return false;
	const target = resolvedWrapperTarget(word, cwd);
	return target !== null && !isRefusedValidationWrapper(target);
}

/** GNU time's options a check reader skips; `-o` writes a file, so a `time` that names one is not looked through. */
const TIME_FLAG_OPTIONS: ReadonlySet<string> = new Set(["-p", "--portability", "-v", "--verbose", "-q", "--quiet"]);

const TIME_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-f", "--format"]);

/** Built-in prefixes that run the rest unchanged, by the bare name a path spelling (`/usr/bin/timeout`) stands for. */
const PATH_SPELLED_BUILTINS: ReadonlySet<string> = new Set(["env", "time", "corepack", ...TRANSPARENT_WRAPPERS.keys()]);

/** `argv` with each built-in prefix spelled by a path read as its bare name; only command-word positions read it. */
function withBareBuiltins(argv: ReadonlyArray<string>): string[] {
	return argv.map((word) => {
		const name = basenameToken(word);
		return name !== word && PATH_SPELLED_BUILTINS.has(name) ? name : word;
	});
}

/** Prefixes looked through in one segment; deeper nesting is read as written. */
const CHECK_PREFIX_MAX_HOPS = 8;

/**
 * The command word of `argv` from `start`, past every built-in prefix that runs the rest unchanged, bare or spelled
 * with a path: env words, `time` with its options (`-o FILE` writes, so it stops there), the transparent wrappers and
 * `corepack <manager>`. They carry no program of their own, so a check's step and its identity read past them alike
 * (FX-44).
 */
function builtinCommandIndex(argv: ReadonlyArray<string>, start = 0): number | null {
	const bare = withBareBuiltins(argv);
	let index = commandTokenIndex(bare, start);
	for (let hop = 0; index !== null && hop < CHECK_PREFIX_MAX_HOPS; hop += 1) {
		// After the reserved word `time` (and the `-p` commandTokenIndex consumed with it) its options stand at `index`.
		const afterTime =
			bare[index]?.startsWith("-") === true &&
			(bare[index - 1] === "time" || (bare[index - 1] === "-p" && bare[index - 2] === "time"));
		const past = afterTime ? pastTimeOptions(bare, index) : null;
		if (past === null) break;
		index = commandTokenIndex(bare, past);
	}
	return index;
}

/** The index past GNU time's options from `start`, or null when one is not a reader-safe option (`-o FILE`). */
function pastTimeOptions(segment: ReadonlyArray<string>, start: number): number | null {
	let next = start;
	for (let option = segment[next]; option?.startsWith("-") === true; option = segment[next]) {
		if (option === "--") return next + 1;
		if (TIME_VALUE_OPTIONS.has(option)) next += 2;
		else if (TIME_FLAG_OPTIONS.has(option) || option.startsWith("--format=")) next += 1;
		else return null;
	}
	return next;
}

/** The index past a declared wrapper at `index` and its leading options. */
function pastWrapperOptions(segment: ReadonlyArray<string>, index: number): number {
	let next = index + 1;
	for (let option = segment[next]; option?.startsWith("-") === true; option = segment[next]) {
		next += 1;
		if (option === "--") break;
	}
	return next;
}

/**
 * The index past one prefix a check's identity is read through (FX-44): `time` with its options, a transparent
 * wrapper or `corepack` bare or spelled with a path, and a declared wrapper when a check stands behind it
 * ({@link checkBehindWrapper}, the step reader's own). Environment words stay part of the identity, so
 * `env CI=1 npm test` and `CI=1 npm test` keep their own names (bt-27).
 */
export function pastIdentityPrefix(argv: ReadonlyArray<string>, start: number): number {
	const word = argv[start];
	if (word === undefined) return start;
	const name = basenameToken(word);
	if (name === "time") return pastTimeOptions(argv, start + 1) ?? start;
	if (name !== "env" && PATH_SPELLED_BUILTINS.has(name)) return pastTransparentWrapper(withBareBuiltins(argv), start);
	return checkBehindWrapper(argv, start, checkStepMatch) ?? start;
}

/**
 * The check behind the declared wrappers standing at `index`, each with its leading options and the built-in prefixes
 * after it; null when none stands there or no check passing `isCheck` stands behind them.
 */
function checkBehindWrapper(
	argv: ReadonlyArray<string>,
	index: number,
	isCheck: (executable: string, args: ReadonlyArray<string>) => boolean,
): number | null {
	let current = index;
	for (let hop = 0; hop < CHECK_PREFIX_MAX_HOPS; hop += 1) {
		const word = argv[current];
		if (word === undefined || !isValidationWrapper(word)) break;
		const next = pastDeclaredWrapper(argv, current);
		if (next === null) return null;
		current = next;
	}
	return current !== index && isCheck(basenameToken(argv[current]), argv.slice(current + 1)) ? current : null;
}

/**
 * The shared transparent-prefix reader for a declared wrapper (FX-44, FX-46): the command word past the declared
 * wrapper standing at `index`, its leading options and the built-in prefixes after it, as `timeout` or `nice` is read
 * through; null when no declared wrapper stands there or nothing follows it. An undeclared script stays opaque.
 */
function pastDeclaredWrapper(argv: ReadonlyArray<string>, index: number): number | null {
	const word = argv[index];
	if (word === undefined || !isValidationWrapper(word)) return null;
	return builtinCommandIndex(argv, pastWrapperOptions(argv, index));
}

/** `text` with each span replaced by spaces, so offsets and every other character stay where they were. */
function blankedSpans(text: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
	let out = text;
	for (const { start, end } of [...spans].sort((left, right) => right.start - left.start))
		out = `${out.slice(0, start)}${" ".repeat(end - start)}${out.slice(end)}`;
	return out;
}

/** More candidate command starts than this behind one wrapper are not tried; the last one tried stands for the rest. */
const WRAPPER_START_CANDIDATES = 8;

/**
 * Where the command behind a declared wrapper at `index` may start (r261f-3). Nothing here knows the wrapper's options,
 * so each separate option may take the next plain word as its value or not: every plain word after an option is a
 * candidate, up to the first plain word no option precedes. `-s 1 -q rm -rf .git` may run `1`, `rm` or `.git`.
 */
function wrapperCommandStarts(argv: ReadonlyArray<string>, index: number): number[] {
	const starts: number[] = [];
	let valueNext = false;
	for (let at = index + 1; at < argv.length; at += 1) {
		const word = argv[at] as string;
		if (word === "--") {
			starts.push(at + 1);
			break;
		}
		if (word.startsWith("-") && word !== "-") {
			valueNext = !word.includes("=");
			continue;
		}
		starts.push(at);
		if (!valueNext) break;
		valueNext = false;
	}
	return starts.length > 0 ? starts : [argv.length];
}

/** A word that may stand as a command word in a nested script (`sh -c '...'`, `$(...)`), with the plain words after it. */
const NESTED_COMMAND_WORD = /(^|[\s'"(;&|`])([^\s'"();&|`<>]+)((?:[ \t]+[^\s'"();&|`<>]+)*)/gu;

/**
 * The readings of a command with its declared validation wrappers blanked out, so the rails read what they run (FX-46):
 * `scripts/test-slot.sh rm -rf .git` reads as `rm -rf .git`. A wrapper at a top-level command position is blanked with
 * its leading options up to each place its command may start ({@link wrapperCommandStarts}), one reading per
 * candidate; redirections between them stay. A wrapper word anywhere else, inside `sh -c '...'` or a substitution, is
 * blanked as text the same way. A word is a wrapper by the call's own working directory. Empty when no declared
 * wrapper stands anywhere. Admission judges every reading beside the command as written and merges them, so a reading
 * only tightens.
 */
export function declaredWrapperReadings(command: string, cwd: string = process.cwd()): string[] {
	const entries = validationWrappers();
	if (entries.length === 0) return [];
	const names = new Set(entries.map((entry) => basenameToken(entry.replace(/\\/gu, "/"))));
	const readings = new Set<string>();
	const segments = splitSegments(scanShellLike(command, true));
	const nested = [...command.matchAll(NESTED_COMMAND_WORD)].flatMap((match) => {
		const word = match[2] ?? "";
		if (!names.has(basenameToken(word.replace(/\\/gu, "/"))) || !isValidationWrapper(word, cwd)) return [];
		const start = match.index + (match[1] ?? "").length;
		const tail = match[3] ?? "";
		const after = [...tail.matchAll(/\S+/gu)].map((rest) => ({ value: rest[0], at: start + word.length + rest.index }));
		const end = start + word.length + tail.length;
		const starts = wrapperCommandStarts([word, ...after.map((rest) => rest.value)], 0);
		return [{ start, ends: starts.map((at) => after[at - 1]?.at ?? end) }];
	});
	for (let rank = 0; rank < WRAPPER_START_CANDIDATES; rank += 1) {
		let more = false;
		const blanks: Array<{ start: number; end: number }> = [];
		for (const segment of segments) {
			// Words only: a redirection operator and its target are not argv, and stay in the reading.
			const words = segment.filter(
				(token, at) =>
					!token.operator && !(segment[at - 1]?.operator === true && SHELL_REDIRECTIONS.has(segment[at - 1]?.value ?? "")),
			);
			const argv = words.map((token) => token.value);
			let index = builtinCommandIndex(argv);
			for (let hop = 0; index !== null && hop < CHECK_PREFIX_MAX_HOPS; hop += 1) {
				const word = argv[index];
				if (word === undefined || !isValidationWrapper(word, cwd)) break;
				const starts = wrapperCommandStarts(argv, index);
				if (starts.length > rank + 1) more = true;
				const start = starts[Math.min(rank, starts.length - 1)] as number;
				for (const token of words.slice(index, start)) blanks.push({ start: token.start, end: token.end });
				index = builtinCommandIndex(argv, start);
			}
		}
		if (blanks.length > 0) readings.add(blankedSpans(command, blanks));
		const spans = nested.map(({ start, ends }) => {
			if (ends.length > rank + 1) more = true;
			return { start, end: ends[Math.min(rank, ends.length - 1)] as number };
		});
		if (spans.length > 0) readings.add(blankedSpans(command, spans));
		if (!more) break;
	}
	readings.delete(command);
	return [...readings];
}

/**
 * The word a check reader judges in one simple command, and whether a declared wrapper stood before it: past the
 * built-in prefixes always, and past declared wrappers only to a check passing `isCheck`. So
 * `scripts/test-slot.sh corepack pnpm run test:file x` reads as the pnpm check while `test-slot.sh ls` and
 * `echo pnpm test` stay what they were (FX-44).
 */
export function checkWordOf(
	argv: ReadonlyArray<string>,
	isCheck: (executable: string, args: ReadonlyArray<string>) => boolean,
): { index: number | null; declared: boolean } {
	const index = builtinCommandIndex(argv);
	if (index === null) return { index: null, declared: false };
	const behind = checkBehindWrapper(argv, index, isCheck);
	return behind === null ? { index, declared: false } : { index: behind, declared: true };
}
