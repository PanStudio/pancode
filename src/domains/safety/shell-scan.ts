// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { basenameToken, commandTokenIndex } from "./command-token.js";

// `(` and `)` open and close a subshell or group; each side starts a new command.
export const COMMAND_SEPARATORS = new Set([";", "&", "&&", "||", "|", "(", ")"]);

export const SHELL_REDIRECTIONS = new Set([">", ">>", "<", "<<", "<<<", "<&", ">&", "<>", ">|", "&>", "&>>"]);

export const SHELL_WRITE_REDIRECTIONS = new Set([">", ">>", ">&", "<>", ">|", "&>", "&>>"]);

export interface ShellToken {
	value: string;
	operator: boolean;
	quoted: boolean;
	start: number;
	end: number;
	/** Scripts of the `$(...)`, backtick, `<(...)`, and `>(...)` substitutions this word carries. */
	substitutions?: string[];
	/**
	 * The word begins with a reference the shell expands to the home directory:
	 * an unquoted `~`, or `$HOME` and `${HOME}` outside single quotes. `value`
	 * still holds the literal text. Absent for `'~/x'`, `"~/x"` and `'$HOME/x'`.
	 */
	homeRelative?: true;
	hiddenContent?: boolean;
	ansiCQuoted?: boolean;
	/** The command ends inside this word's quote, so the shell reads the rest differently or not at all. */
	unterminated?: true;
}

/** Shells a bare wrapper may name: the bare name only, never a path. */
export const BARE_WRAPPER_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh"]);

/** More here-documents than this in one command are left in place. */
export const MAX_HEREDOCS = 64;

/** The `$(...)` and backtick substitutions an unquoted here-document body runs, each with its offset in `body`. */
export function heredocSubstitutions(body: string): Array<{ start: number; text: string }> {
	const substitutions: Array<{ start: number; text: string }> = [];
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index];
		if (char === "\\" && /[$`\\\n]/u.test(body[index + 1] ?? "")) {
			index += 1;
			continue;
		}
		const close =
			char === "$" && body[index + 1] === "("
				? matchingParen(body, index + 1)
				: char === "`"
					? matchingBacktick(body, index)
					: null;
		if (close === null) continue;
		substitutions.push({ start: index, text: body.slice(index, close + 1) });
		index = close;
	}
	return substitutions;
}

export function shellCommandArguments(segment: ReadonlyArray<ShellToken>): string[] {
	return shellCommandWords(segment).map((token) => token.value);
}

/** {@link shellCommandArguments} with the tokens kept, for a reader that needs more than the text. */
export function shellCommandWords(segment: ReadonlyArray<ShellToken>): ShellToken[] {
	const args: ShellToken[] = [];
	for (let index = 0; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (token.operator && SHELL_REDIRECTIONS.has(token.value)) {
			// A redirection target is consumed by the shell, not passed to PanCode.
			// Only an adjacent, unquoted number is its optional file descriptor.
			const previous = args.at(-1);
			if (previous && previous.end === token.start && !previous.quoted && /^\d+$/.test(previous.value)) args.pop();
			if (segment[index + 1]?.operator === false) index += 1;
			continue;
		}
		args.push(token);
	}
	return args;
}

/** The raw start of a word the shell expands to the home directory; see {@link ShellToken.homeRelative}. */
const HOME_REFERENCE_START = /^(?:~(?=\/|$)|"?\$(?:HOME|\{HOME\})(?=\/|"|$))/u;

function decodeAnsiCQuote(command: string, open: number): { value: string; end: number; hidden: boolean } {
	const bytes: number[] = [];
	let hidden = false;
	let end = open + 1;
	const escapes: Record<string, number> = {
		a: 7,
		b: 8,
		e: 27,
		E: 27,
		f: 12,
		n: 10,
		r: 13,
		t: 9,
		v: 11,
		"\\": 92,
		"'": 39,
		'"': 34,
		"?": 63,
	};
	for (; end < command.length && command[end] !== "'"; end += 1) {
		const char = command[end] ?? "";
		if (char !== "\\") {
			const point = command.codePointAt(end) ?? 0;
			bytes.push(...Buffer.from(String.fromCodePoint(point)));
			if (point > 0xffff) end += 1;
			continue;
		}
		const escapeCode = command[++end] ?? "";
		const simple = escapes[escapeCode];
		if (simple !== undefined) bytes.push(simple);
		else if (/[0-7]/u.test(escapeCode) && escapeCode.length === 1) {
			let digits = escapeCode;
			while (digits.length < 3 && /[0-7]/u.test(command[end + 1] ?? "!")) digits += command[++end];
			bytes.push(Number.parseInt(digits, 8) & 0xff);
		} else if (escapeCode === "x" || escapeCode === "u" || escapeCode === "U") {
			const limit = escapeCode === "x" ? 2 : escapeCode === "u" ? 4 : 8;
			let digits = "";
			while (digits.length < limit && /[a-fA-F0-9]/u.test(command[end + 1] ?? "!")) digits += command[++end];
			const point = Number.parseInt(digits, 16);
			if (digits.length === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) hidden = true;
			else if (escapeCode === "x") bytes.push(point);
			else bytes.push(...Buffer.from(String.fromCodePoint(point)));
		} else if (escapeCode === "c") {
			const control = command[++end];
			if (control === undefined || control === "'" || control.charCodeAt(0) > 0x7f) {
				hidden = true;
				if (control === "'") break;
			} else {
				bytes.push(control === "?" ? 127 : control.charCodeAt(0) & 31);
				if (control === "\\" && command[end + 1] === "\\") end += 1;
			}
		} else hidden = true;
	}
	if (end >= command.length || bytes.includes(0)) hidden = true;
	let value = "";
	try {
		value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
	} catch {
		// Invalid byte sequences cannot be represented faithfully by the string-based path scanners.
		hidden = true;
	}
	return { value: hidden ? command.slice(open + 1, end) : value, end, hidden };
}

/**
 * A here-document body in the command text, from the line after its head through its terminator line and that line's
 * newline, with the `$(...)` and backtick substitutions an unquoted body still runs, each at its offset.
 */
interface HeredocBody {
	start: number;
	end: number;
	substitutions: ReadonlyArray<{ start: number; text: string }>;
}

interface ShellScan {
	tokens: ReadonlyArray<ShellToken>;
	bodies: ReadonlyArray<HeredocBody>;
}

/** The most recent scans, each keyed by its mode and text, so the many readers of one call's command tokenize it once (x6-7). */
const recentScans = new Map<string, ShellScan>();

const RECENT_SCAN_LIMIT = 16;

/**
 * Literal shell words and operators only; no expansion or script execution. A scan is a pure function of the text, so
 * the last few are kept and each caller gets its own array over the shared tokens, which no reader writes to. With
 * `skipHeredocBodies`, a here-document's body is data, not commands: its `<<WORD` head and body yield no tokens but the
 * substitutions an unquoted body runs, and every other token keeps its offset in `command` (S2, S3).
 */
export function scanShellLike(command: string, skipHeredocBodies = false): ShellToken[] {
	return [...cachedShellScan(command, skipHeredocBodies).tokens];
}

export function cachedShellScan(command: string, skipHeredocBodies: boolean): ShellScan {
	if (skipHeredocBodies && !command.includes("<<")) return cachedShellScan(command, false);
	const key = `${skipHeredocBodies ? "b" : "t"}${command}`;
	let scan = recentScans.get(key);
	if (scan === undefined) {
		scan = skipHeredocBodies ? scanSkippingHeredocBodies(command) : { tokens: scanShellText(command), bodies: [] };
		if (recentScans.size >= RECENT_SCAN_LIMIT) recentScans.delete(recentScans.keys().next().value as string);
	} else recentScans.delete(key);
	recentScans.set(key, scan);
	return scan;
}

/** Commands that read a here-document as shell commands, so its body stays commands to every reader. */
const HEREDOC_SHELL_READERS: ReadonlySet<string> = new Set([
	...BARE_WRAPPER_SHELLS,
	"ksh",
	"mksh",
	"ash",
	"busybox",
	"source",
	".",
	"eval",
	"exec",
	"xargs",
]);

/**
 * Whether the here-document at `operatorIndex` may be read as shell: a stage of its pipeline is a shell, a word no
 * literal names, or carries a substitution (`> >(sh)`).
 */
export function heredocFeedsShell(tokens: ReadonlyArray<ShellToken>, operatorIndex: number): boolean {
	const ends = (token: ShellToken | undefined, previous: ShellToken | undefined) =>
		token?.operator === true &&
		COMMAND_SEPARATORS.has(token.value) &&
		token.value !== "|" &&
		!(token.value === "&" && previous?.value === "|" && previous.end === token.start);
	let start = operatorIndex;
	while (start > 0 && !ends(tokens[start - 1], tokens[start - 2])) start -= 1;
	let end = operatorIndex;
	while (end < tokens.length && !ends(tokens[end], tokens[end - 1])) end += 1;
	const pipeline = tokens.slice(start, end);
	if (pipeline.some((token) => (token.substitutions?.length ?? 0) > 0 || token.hiddenContent === true)) return true;
	return splitSegments(pipeline).some((stage) => {
		const argv = shellCommandArguments(stage);
		const index = commandTokenIndex(argv);
		if (index === null) return false;
		const word = argv[index] ?? "";
		return /[$`]/u.test(word) || HEREDOC_SHELL_READERS.has(basenameToken(word));
	});
}

/** An arithmetic `(( x << 2 ))` shifts; it opens no here-document. */
function insideArithmetic(tokens: ReadonlyArray<ShellToken>, operatorIndex: number): boolean {
	for (let index = operatorIndex - 1; index > 0; index -= 1) {
		const token = tokens[index] as ShellToken;
		const previous = tokens[index - 1] as ShellToken;
		if (token.value === "(" && previous.value === "(" && previous.operator && previous.end === token.start) return true;
		if (token.operator && COMMAND_SEPARATORS.has(token.value) && token.value !== "(") return false;
	}
	return false;
}

/**
 * {@link scanShellLike} with here-document bodies skipped. A body starts on the line after its head and ends at the
 * line that is exactly its word (tabs stripped first for `<<-`), or at the end of the command, as in bash; an unquoted
 * word's body joins its backslash-newlines before that comparison, a quoted one's never does. Several here-documents
 * on one line take their bodies in order. A head bash rejects, one whose pipeline may read it as shell
 * ({@link heredocFeedsShell}), or a command that may redefine what reads it (a function, alias or PATH change) leaves
 * that body and every later one read as commands.
 */
function scanSkippingHeredocBodies(command: string): ShellScan {
	const bodies: HeredocBody[] = [];
	const heads = new Set<number>();
	const shifts = new Set<number>();
	for (let pass = 0; pass < MAX_HEREDOCS; pass += 1) {
		const tokens = scanShellText(command, bodies);
		const first = tokens.findIndex(
			(token) => token.operator && token.value === "<<" && !heads.has(token.start) && !shifts.has(token.start),
		);
		if (first === -1) break;
		const lineEnd = tokens.findIndex(
			(token, index) => index > first && token.operator && token.value === ";" && command[token.start] === "\n",
		);
		const docs: Array<{ word: string; stripTabs: boolean; quoted: boolean; head: number[] }> = [];
		let readable = true;
		for (let index = first; index < (lineEnd === -1 ? tokens.length : lineEnd); index += 1) {
			const operator = tokens[index];
			if (operator === undefined || !operator.operator || operator.value !== "<<") continue;
			if (insideArithmetic(tokens, index)) {
				shifts.add(operator.start);
				continue;
			}
			const head = [operator.start];
			let word = tokens[index + 1];
			let stripTabs = false;
			if (word !== undefined && !word.operator && word.start === operator.end && command[word.start] === "-") {
				stripTabs = true;
				if (word.value === "-") {
					head.push(word.start);
					word = tokens[index + 2];
				}
			}
			if (word === undefined || word.operator || heredocFeedsShell(tokens, index)) {
				readable = false;
				break;
			}
			head.push(word.start);
			const delimiter = stripTabs && command[word.start] === "-" ? word.value.slice(1) : word.value;
			docs.push({ word: delimiter, stripTabs, quoted: word.quoted, head });
		}
		if (!readable) break;
		for (const doc of docs) for (const start of doc.head) heads.add(start);
		const newline = lineEnd === -1 ? undefined : tokens[lineEnd];
		if (newline === undefined || docs.length === 0) continue;
		const start = newline.start + 1;
		let cursor = start;
		const substitutions: Array<{ start: number; text: string }> = [];
		for (const doc of docs) {
			const bodyStart = cursor;
			let bodyEnd = cursor;
			while (cursor < command.length) {
				bodyEnd = cursor;
				let line = "";
				for (;;) {
					const lineBreak = command.indexOf("\n", cursor);
					const physical = command.slice(cursor, lineBreak === -1 ? command.length : lineBreak);
					cursor = lineBreak === -1 ? command.length : lineBreak + 1;
					const continued = !doc.quoted && lineBreak !== -1 && /(?:^|[^\\])(?:\\\\)*\\$/u.test(physical);
					line += continued ? physical.slice(0, -1) : physical;
					if (!continued) break;
				}
				if ((doc.stripTabs ? line.replace(/^\t+/u, "") : line) === doc.word) break;
				bodyEnd = cursor;
			}
			if (!doc.quoted)
				for (const found of heredocSubstitutions(command.slice(bodyStart, bodyEnd)))
					substitutions.push({ start: bodyStart + found.start, text: found.text });
		}
		bodies.push({ start, end: cursor, substitutions });
	}
	// A function, alias or PATH change outside the bodies may turn `cat` into a shell, so nothing there is data.
	let outside = "";
	let cursor = 0;
	for (const body of bodies) {
		outside += command.slice(cursor, body.start);
		cursor = body.end;
	}
	outside += command.slice(cursor);
	if (/\bPATH=|\balias\b|\bfunction\b|\(\s*\)/u.test(outside)) return cachedShellScan(command, false);
	return { tokens: scanShellText(command, bodies).filter((token) => !heads.has(token.start)), bodies };
}

export function scanShellText(command: string, bodies: ReadonlyArray<HeredocBody> = []): ShellToken[] {
	const tokens: ShellToken[] = [];
	let current = "";
	let wordStart: number | null = null;
	let quoted = false;
	let hiddenContent = false;
	let ansiCQuoted = false;
	let quote: "'" | '"' | null = null;
	let nextBody = 0;

	let substitutions: string[] = [];
	const pushCurrent = (end: number): void => {
		if (wordStart === null) return;
		const token: ShellToken = { value: current, operator: false, quoted, start: wordStart, end };
		if (substitutions.length > 0) token.substitutions = substitutions;
		if (HOME_REFERENCE_START.test(command.slice(wordStart, end))) token.homeRelative = true;
		if (hiddenContent) token.hiddenContent = true;
		if (ansiCQuoted) token.ansiCQuoted = true;
		tokens.push(token);
		current = "";
		wordStart = null;
		quoted = false;
		hiddenContent = false;
		ansiCQuoted = false;
		substitutions = [];
	};
	const appendBacktick = (open: number, inDouble = false): number | null => {
		const close = matchingBacktick(command, open);
		if (close === null) return null;
		wordStart ??= open;
		current += command.slice(open, close + 1);
		// ORCH-006: escaped ticks inside a backtick script become nested delimiters; inside double quotes bash also
		// drops the backslash before `"`, `$` and `\`, so `\"` is a quote in the script.
		const script = command.slice(open + 1, close);
		substitutions.push(inDouble ? script.replace(/\\([`"$\\])/gu, "$1") : script.replace(/\\`/gu, "`"));
		return close;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (char === undefined) continue;
		while ((bodies[nextBody]?.start ?? command.length) < index) nextBody += 1;
		const body = quote === null && bodies[nextBody]?.start === index ? bodies[nextBody] : undefined;
		if (body !== undefined) {
			pushCurrent(index);
			for (const substitution of body.substitutions) {
				for (const token of scanShellText(substitution.text))
					tokens.push({ ...token, start: token.start + substitution.start, end: token.end + substitution.start });
				tokens.push({ value: ";", operator: true, quoted: false, start: substitution.start, end: substitution.start });
			}
			nextBody += 1;
			index = body.end - 1;
			continue;
		}
		if (quote !== null) {
			if (char === quote) {
				quote = null;
				continue;
			}
			if (quote === '"' && char === "\\" && index + 1 < command.length) {
				const next = command[index + 1] ?? "";
				if (next === "\n" || '$`"\\'.includes(next)) {
					index += 1;
					if (next !== "\n") current += next;
					continue;
				}
			}
			if (quote === '"' && char === "`") {
				const close = appendBacktick(index, true);
				if (close !== null) {
					index = close;
					continue;
				}
			}
			if (quote === '"' && char === "$" && command[index + 1] === "(") {
				// ORCH-005: double quotes preserve the word but still execute $(...).
				const close = matchingParen(command, index + 1);
				current += command.slice(index, close + 1);
				substitutions.push(command.slice(index + 2, close));
				index = close;
				continue;
			}
			current += char;
			continue;
		}

		if (char === "$" && (command[index + 1] === "'" || command[index + 1] === '"')) {
			wordStart ??= index;
			quoted = true;
			if (command[index + 1] === "'") {
				const decoded = decodeAnsiCQuote(command, index + 1);
				current += decoded.value;
				hiddenContent ||= decoded.hidden;
				ansiCQuoted = true;
				index = decoded.end;
			} else {
				hiddenContent = true;
				quote = '"';
				index += 1;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			wordStart ??= index;
			quoted = true;
			quote = char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			// Backslash-newline joins lines before tokenization, even between words.
			if (command[index + 1] !== "\n") {
				wordStart ??= index;
				quoted = true;
				current += command[index + 1] ?? "";
			}
			index += 1;
			continue;
		}
		if (char === "`") {
			const close = appendBacktick(index);
			if (close !== null) {
				index = close;
				continue;
			}
		}
		if (char === "#" && wordStart === null) {
			// A comment starts only at an unquoted word boundary. Leave its newline
			// for normal separation so a following command is still inspected.
			while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
			continue;
		}
		if (/\s/.test(char)) {
			pushCurrent(index);
			if (char === "\n") tokens.push({ value: ";", operator: true, quoted: false, start: index, end: index + 1 });
			continue;
		}
		if (char === "(") {
			// `$(`, `<(`, and `>(` open a substitution that belongs to the word it
			// sits in, so `$(echo)/../x` stays one path; its script is kept for
			// the scanners that read it as a child command.
			const previous = tokens.at(-1);
			const dollar = wordStart !== null && command[index - 1] === "$" && current.endsWith("$");
			const processSubstitution =
				wordStart === null &&
				previous?.operator === true &&
				previous.end === index &&
				(previous.value === "<" || previous.value === ">");
			if (dollar || processSubstitution) {
				const close = matchingParen(command, index);
				if (processSubstitution) {
					tokens.pop();
					wordStart = index - 1;
					current = previous.value;
				}
				current += command.slice(index, close + 1);
				substitutions.push(command.slice(index + 1, close));
				index = close;
				continue;
			}
		}
		if (";&|><()".includes(char)) {
			pushCurrent(index);
			const three = command.slice(index, index + 3);
			const two = command.slice(index, index + 2);
			const value =
				SHELL_REDIRECTIONS.has(three) || COMMAND_SEPARATORS.has(three)
					? three
					: SHELL_REDIRECTIONS.has(two) || COMMAND_SEPARATORS.has(two)
						? two
						: char;
			tokens.push({ value, operator: true, quoted: false, start: index, end: index + value.length });
			index += value.length - 1;
			continue;
		}
		wordStart ??= index;
		current += char;
	}
	const unterminated = quote !== null;
	pushCurrent(command.length);
	const last = tokens.at(-1);
	if (unterminated && last !== undefined) last.unterminated = true;
	return tokens;
}

/** ORCH-006: backticks delimit a child script outside single quotes unless escaped. */
function matchingBacktick(command: string, open: number): number | null {
	for (let index = open + 1; index < command.length; index += 1) {
		if (command[index] === "\\") index += 1;
		else if (command[index] === "`") return index;
	}
	return null;
}

/**
 * The index of the `)` that closes the `(` at `open`, skipping quoted text and
 * escapes, or the last index when the substitution is never closed.
 */
function matchingParen(command: string, open: number): number {
	let depth = 0;
	let quote: "'" | '"' | null = null;
	for (let index = open; index < command.length; index += 1) {
		const char = command[index];
		if (quote !== null) {
			if (char === "\\" && quote === '"') index += 1;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "\\") index += 1;
		else if (char === "'" || char === '"') quote = char;
		else if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return command.length - 1;
}

/** The simple commands of a token run: split at `;`, `&`, `&&`, `||`, `|` and parentheses, redirections kept. */
export function splitSegments(tokens: ReadonlyArray<ShellToken>): ShellToken[][] {
	const segments: ShellToken[][] = [];
	let current: ShellToken[] = [];
	for (const token of tokens) {
		if (token.operator && COMMAND_SEPARATORS.has(token.value)) {
			if (current.length > 0) segments.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) segments.push(current);
	return segments;
}
