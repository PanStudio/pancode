// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { SpawnSyncReturns } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gitSpawnSync } from "../../core/internal-git-run.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { isSkippedSecretScanDirectory, SECRET_SCAN_LIMITS } from "../../core/sandbox/secret-files.js";
import { heredocDataText } from "./heredoc-data.js";
import { scanShellLikeDeep, withoutDataHeredocBodies } from "./heredoc-scan.js";
import type { CompiledPathPolicy } from "./path-policy.js";
import { evaluatePathPolicy } from "./path-policy.js";
import { abbreviatesLongOption, recursesDirectories } from "./policy-read-only-inspectors.js";
import type { ShellToken } from "./shell-scan.js";
import { inlineShellScript } from "./shell-segments.js";

export interface BashZeroAccessHit {
	verb: "read" | "write";
	token: string;
	entrySource: string;
	/** How to run the same command without reaching the protected file. */
	hint?: string;
}

export interface BashWriteOperand {
	target: string;
	/** Source operands of cp/mv/install/ln; empty for redirects and tee. */
	sources: string[];
	/** `-t DIR`: the target is a directory the sources land in. */
	intoDirectory: boolean;
}

type RecursiveSearchTool = "grep" | "rg" | "ag" | "ack" | "git grep";

interface RecursiveSearch {
	tool: RecursiveSearchTool;
	roots: string[];
	/** Exclusion globs the command already passes (`--exclude`, `-g '!x'`, `--ignore`, `':!x'`). */
	excludes: string[];
	/** Directory-only exclusions (`--exclude-dir`, `--ignore-dir`). */
	excludeDirs: string[];
	/** git grep without --untracked or --no-index reads tracked files only. */
	trackedOnly: boolean;
}

interface BashOperandRoles {
	/** Words judged as reads: everything that is not a write destination, a search pattern or an exclusion. */
	reads: string[];
	/**
	 * The reads in a path position: an input redirect operand, a file operand of a known reader, a copy source or a
	 * search operand, and any word the shell expands (`$`, a backtick, an unquoted glob). Only these, and words naming
	 * a file that exists, meet glob entries such as `*.key`.
	 */
	pathOperands: Set<string>;
	/**
	 * The words a command opens by their role alone: an input redirect operand, a file operand of a known reader, a
	 * copy operand or a search operand. Unlike `pathOperands`, no word joins for its spelling, so `echo /etc/x` opens
	 * nothing. The approval card reads it to say how far a command reaches; no rail reads it.
	 */
	opened: Set<string>;
	writes: BashWriteOperand[];
	searches: RecursiveSearch[];
}

const ROLE_SEGMENT_SEPARATORS: ReadonlySet<string> = new Set([";", "&", "&&", "||", "|", "(", ")", "\n"]);

const ROLE_WRITE_REDIRECTS: ReadonlySet<string> = new Set([">", ">>", ">&", ">|", "&>", "&>>"]);

const ROLE_OTHER_REDIRECTS: ReadonlySet<string> = new Set(["<", "<<", "<<<", "<&", "<>"]);

const ROLE_PREFIX_WRAPPERS: ReadonlySet<string> = new Set([
	"command",
	"builtin",
	"sudo",
	"doas",
	"env",
	"nohup",
	"time",
	"nice",
	"exec",
]);

/**
 * The role each word of a bash command plays for the zero-access rail.
 * Destinations of cp/mv/install/ln (the last operand, or `-t DIR`), tee files
 * and output redirect targets are writes; the pattern of a grep-family, rg,
 * ag, ack or git grep search and the values of its exclusion options name no
 * file; every other word is judged as a read exactly as
 * {@link bashPathTokenCandidates} judges it. Recursive searches are listed
 * with their roots so their walk can be judged.
 */
export function bashOperandRoles(command: string): BashOperandRoles {
	// C-22: a here-document the parsed call proves is data names no file (row 287).
	command = heredocDataText(command) ?? withoutDataHeredocBodies(command, "stdin-only", "rails");
	const roles: BashOperandRoles = { reads: [], pathOperands: new Set(), opened: new Set(), writes: [], searches: [] };
	const inner = inlineShellScript(command);
	if (inner !== null && inner !== command) {
		const nested = bashOperandRoles(inner);
		roles.reads.push(...nested.reads);
		for (const operand of nested.pathOperands) roles.pathOperands.add(operand);
		for (const operand of nested.opened) roles.opened.add(operand);
		roles.writes.push(...nested.writes);
		roles.searches.push(...nested.searches);
	}
	let segment: ShellToken[] = [];
	const flush = () => {
		if (segment.length > 0) segmentOperandRoles(segment, roles);
		segment = [];
	};
	for (const token of scanShellLikeDeep(command)) {
		if (token.operator && ROLE_SEGMENT_SEPARATORS.has(token.value)) flush();
		else segment.push(token);
	}
	flush();
	return roles;
}

function pushReadCandidate(token: string, reads: string[], pathOperands: Set<string> | null): void {
	if (token.length === 0) return;
	if (/\s/.test(token) && !token.includes("/")) return;
	if (token.startsWith("-") && !token.includes("/") && !token.includes("=")) return;
	reads.push(token);
	pathOperands?.add(token);
	const eq = token.indexOf("=");
	if (eq > 0 && eq < token.length - 1) {
		reads.push(token.slice(eq + 1));
		pathOperands?.add(token.slice(eq + 1));
	}
}

/**
 * Commands whose operands are files they open and print or hash: a word after one of these names a file even when it
 * does not exist yet (an earlier step may create it). Others reach a glob entry only through a word naming a file.
 */
const FILE_READERS: ReadonlySet<string> = new Set([
	"cat",
	"tac",
	"nl",
	"head",
	"tail",
	"less",
	"more",
	"bat",
	"batcat",
	"wc",
	"sort",
	"uniq",
	"cut",
	"paste",
	"join",
	"comm",
	"diff",
	"cmp",
	"base64",
	"base32",
	"basenc",
	"xxd",
	"od",
	"hexdump",
	"hd",
	"strings",
	"file",
	"stat",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"sha512sum",
	"shasum",
	"b2sum",
	"cksum",
	"source",
	".",
	"openssl",
	"ssh-keygen",
	"ssh-add",
	"gpg",
	"scp",
	"rsync",
	"tar",
	"zip",
	"gzip",
	"zcat",
	"xz",
	"bzip2",
	"zstd",
]);

/** Commands whose quoted patterns name the files they select, so every operand keeps the base judgement (FX-7). */
const FILE_FINDERS: ReadonlySet<string> = new Set(["find", "fd", "fdfind", "locate", "plocate", "mlocate", "slocate"]);

/** Reserved words that may stand before the command word of a segment (`if cat x.key; then`). */
const READER_PREFIX_WORDS: ReadonlySet<string> = new Set([
	"{",
	"!",
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"do",
]);

/** A word the shell expands before the command sees it, so its literal text is no file name to test. */
function shellExpandsWord(token: ShellToken): boolean {
	return /[$`]/u.test(token.value) || (!token.quoted && /[*?[{]/u.test(token.value));
}

function segmentOperandRoles(tokens: ReadonlyArray<ShellToken>, roles: BashOperandRoles): void {
	const skipped = new Set<ShellToken>();
	const inputs: ShellToken[] = [];
	const words: ShellToken[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (!token.operator) {
			words.push(token);
			continue;
		}
		const next = tokens[index + 1];
		if (next === undefined || next.operator) continue;
		// `2>err.log`: the descriptor number is part of the redirect, not an operand.
		const previous = words.at(-1);
		if (previous !== undefined && /^\d+$/u.test(previous.value) && previous.end === token.start) words.pop();
		if (ROLE_WRITE_REDIRECTS.has(token.value)) {
			skipped.add(next);
			index += 1;
			if (!(token.value === ">&" && /^(?:\d+|-)$/u.test(next.value))) {
				roles.writes.push({ target: next.value, sources: [], intoDirectory: false });
			}
		} else if (ROLE_OTHER_REDIRECTS.has(token.value)) {
			// Input redirects stay reads; they are just not command arguments. `< f` and `<> f` open a file, while a
			// here-document delimiter and a here-string are text.
			if (token.value === "<" || token.value === "<>") inputs.push(next);
			index += 1;
		}
	}
	let at = 0;
	let wrapped = false;
	while (at < words.length) {
		const word = words[at]?.value ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) || (wrapped && word.startsWith("-"))) at += 1;
		else if (ROLE_PREFIX_WRAPPERS.has(word)) {
			wrapped = true;
			at += 1;
		} else break;
	}
	const positioned = new Set<ShellToken>(inputs);
	const head = words[at];
	if (head !== undefined) {
		const name = path.basename(head.value);
		const args = words.slice(at + 1);
		let reader = at;
		while (READER_PREFIX_WORDS.has(words[reader]?.value ?? "")) reader += 1;
		const readerWord = words[reader]?.value ?? "";
		// A program named by path (`./tool`, `bin/run`) is the workspace's own code, so any operand may be a file it opens.
		// A file finder's pattern (`find -name '*.key'`) selects the files its -exec or a later xargs reads.
		const readerName = path.basename(readerWord);
		if (FILE_READERS.has(readerName) || FILE_FINDERS.has(readerName) || readerWord.includes("/")) {
			for (const arg of words.slice(reader + 1)) positioned.add(arg);
		}
		if (name === "cp" || name === "mv" || name === "install" || name === "ln") {
			for (const arg of args) positioned.add(arg);
			copyOperandRoles(name, args, skipped, roles);
		} else if (name === "tee") {
			for (const arg of args) {
				if (arg.value.startsWith("-")) continue;
				skipped.add(arg);
				roles.writes.push({ target: arg.value, sources: [], intoDirectory: false });
			}
		} else if (name === "pancode" && head.value === name) settingsPathOperand(args, skipped);
		else if (searchOperandRoles(name, args, skipped, roles)) {
			// What the search leaves after its pattern and exclusions are the files and roots it opens.
			for (const arg of args) positioned.add(arg);
		}
	}
	for (const token of tokens) {
		if (token.operator || skipped.has(token)) continue;
		// An unquoted word spelled with a separator (`../x.key`) is a path wherever it stands; a quoted script is not.
		const pathPosition = positioned.has(token) || shellExpandsWord(token) || (!token.quoted && token.value.includes("/"));
		pushReadCandidate(token.value, roles.reads, pathPosition ? roles.pathOperands : null);
		if (positioned.has(token) && !token.value.startsWith("-")) roles.opened.add(token.value);
	}
}

/** A dotted settings path such as `safety.scratchRoots`: no slash, so it never names a file below a directory. */
const SETTINGS_PATH = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/u;

/**
 * `pancode config get|set|unset <path>`: the dotted path names a setting, not a file, so `nope.key` is not read as
 * a key file (LEAD-2). Only the bare launcher on PATH counts, since a workspace script of that name could read its
 * argument; the value of `set` stays a read candidate.
 */
function settingsPathOperand(args: ReadonlyArray<ShellToken>, skipped: Set<ShellToken>): void {
	const words = args.filter((token, index) => !token.value.startsWith("-") && args[index - 1]?.value !== "--scope");
	const [command, verb, setting] = words;
	if (command?.value !== "config" || setting === undefined) return;
	if (["get", "set", "unset"].includes(verb?.value ?? "") && SETTINGS_PATH.test(setting.value)) skipped.add(setting);
}

/** Short options of cp/mv/install/ln that take a value. */
const COPY_VALUE_LETTERS: Readonly<Record<string, string>> = { cp: "St", mv: "St", install: "gmoSt", ln: "St" };

const COPY_VALUE_LONG: ReadonlyArray<string> = ["--suffix", "--mode", "--owner", "--group", "--strip-program"];

function copyOperandRoles(
	name: string,
	args: ReadonlyArray<ShellToken>,
	skipped: Set<ShellToken>,
	roles: BashOperandRoles,
): void {
	const operands: ShellToken[] = [];
	let targetDir: string | null = null;
	let optionsEnded = false;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) continue;
		const arg = token.value;
		if (optionsEnded || !arg.startsWith("-") || arg === "-") {
			operands.push(token);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const takesValue =
				abbreviatesLongOption(arg, "--target-directory") ||
				COPY_VALUE_LONG.some((option) => abbreviatesLongOption(arg, option));
			if (!takesValue) continue;
			const valueToken = eq === -1 ? args[index + 1] : token;
			const value = eq === -1 ? valueToken?.value : arg.slice(eq + 1);
			if (eq === -1) index += 1;
			if (abbreviatesLongOption(arg, "--target-directory") && value !== undefined && valueToken !== undefined) {
				targetDir = value;
				skipped.add(valueToken);
			}
			continue;
		}
		const letters = COPY_VALUE_LETTERS[name] ?? "";
		for (let offset = 1; offset < arg.length; offset += 1) {
			const letter = arg[offset] ?? "";
			if (!letters.includes(letter)) continue;
			const attached = arg.slice(offset + 1);
			const valueToken = attached.length > 0 ? token : args[index + 1];
			if (attached.length === 0) index += 1;
			if (letter === "t" && valueToken !== undefined) {
				targetDir = attached.length > 0 ? attached : valueToken.value;
				skipped.add(valueToken);
			}
			break;
		}
	}
	if (targetDir !== null) {
		roles.writes.push({ target: targetDir, sources: operands.map((operand) => operand.value), intoDirectory: true });
		return;
	}
	const destination = operands.at(-1);
	if (destination === undefined || operands.length < 2) return;
	skipped.add(destination);
	roles.writes.push({
		target: destination.value,
		sources: operands.slice(0, -1).map((operand) => operand.value),
		intoDirectory: false,
	});
}

interface SearchSyntax {
	/** Short options that take a value. */
	valueLetters: string;
	/** Long options that take a value (also as an unambiguous prefix). */
	valueLong: ReadonlyArray<string>;
	/** Options whose value is the pattern. */
	patternShort: string;
	patternLong: ReadonlyArray<string>;
	/** Options whose value is a file of patterns: an explicit pattern, the file itself still read. */
	patternFileShort: string;
	patternFileLong: ReadonlyArray<string>;
}

const GREP_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "efmABCdD",
	valueLong: [
		"--regexp",
		"--file",
		"--max-count",
		"--include",
		"--exclude",
		"--exclude-dir",
		"--exclude-from",
		"--context",
		"--after-context",
		"--before-context",
		"--directories",
		"--devices",
		"--label",
		"--binary-files",
	],
	patternShort: "e",
	patternLong: ["--regexp"],
	patternFileShort: "f",
	patternFileLong: ["--file"],
};

const RG_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "efABCmgtTjMrE",
	valueLong: [
		"--regexp",
		"--file",
		"--glob",
		"--iglob",
		"--type",
		"--type-not",
		"--type-add",
		"--type-clear",
		"--max-count",
		"--context",
		"--after-context",
		"--before-context",
		"--max-columns",
		"--threads",
		"--replace",
		"--encoding",
		"--max-depth",
		"--ignore-file",
		"--sort",
		"--sortr",
		"--pre",
		"--pre-glob",
		"--path-separator",
		"--context-separator",
		"--field-match-separator",
		"--colors",
		"--engine",
		"--max-filesize",
	],
	patternShort: "e",
	patternLong: ["--regexp"],
	patternFileShort: "f",
	patternFileLong: ["--file"],
};

const AG_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "ABCGgm",
	valueLong: [
		"--ignore",
		"--ignore-dir",
		"--file-search-regex",
		"--depth",
		"--context",
		"--after",
		"--before",
		"--max-count",
		"--pager",
		"--workers",
	],
	patternShort: "",
	patternLong: [],
	patternFileShort: "",
	patternFileLong: [],
};

const ACK_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "ABCm",
	valueLong: ["--ignore-file", "--ignore-dir", "--ignore-directory", "--type", "--max-count", "--context"],
	patternShort: "",
	patternLong: [],
	patternFileShort: "",
	patternFileLong: [],
};

const GIT_GREP_SEARCH_SYNTAX: SearchSyntax = {
	valueLetters: "efmABC",
	valueLong: ["--max-depth", "--max-count", "--context", "--after-context", "--before-context", "--threads"],
	patternShort: "e",
	patternLong: [],
	patternFileShort: "f",
	patternFileLong: [],
};

interface ParsedSearch {
	positionals: ShellToken[];
	/** Option values with the option that carried them (`--exclude`, `-g`, ...). */
	values: Array<{ option: string; value: string; token: ShellToken; attached: boolean }>;
	explicitPattern: boolean;
	flags: string[];
}

function parseSearchArgs(args: ReadonlyArray<ShellToken>, syntax: SearchSyntax): ParsedSearch {
	const parsed: ParsedSearch = { positionals: [], values: [], explicitPattern: false, flags: [] };
	let optionsEnded = false;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) continue;
		const arg = token.value;
		if (optionsEnded || !arg.startsWith("-") || arg === "-") {
			parsed.positionals.push(token);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		parsed.flags.push(arg);
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const option = syntax.valueLong.find((candidate) =>
				eq === -1 ? arg === candidate : arg.slice(0, eq) === candidate,
			);
			if (option === undefined) continue;
			if (syntax.patternLong.includes(option) || syntax.patternFileLong.includes(option)) parsed.explicitPattern = true;
			if (eq !== -1) parsed.values.push({ option, value: arg.slice(eq + 1), token, attached: true });
			else {
				const next = args[index + 1];
				index += 1;
				if (next !== undefined) parsed.values.push({ option, value: next.value, token: next, attached: false });
			}
			continue;
		}
		for (let offset = 1; offset < arg.length; offset += 1) {
			const letter = arg[offset] ?? "";
			if (!syntax.valueLetters.includes(letter)) continue;
			if (syntax.patternShort.includes(letter) || syntax.patternFileShort.includes(letter)) parsed.explicitPattern = true;
			const attached = arg.slice(offset + 1);
			const option = `-${letter}`;
			if (attached.length > 0) parsed.values.push({ option, value: attached, token, attached: true });
			else {
				const next = args[index + 1];
				index += 1;
				if (next !== undefined) parsed.values.push({ option, value: next.value, token: next, attached: false });
			}
			break;
		}
	}
	return parsed;
}

const GREP_SEARCH_NAMES: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "zgrep"]);

/** Options whose value only narrows what a search reads: it names no file to read. */
const EXCLUSION_OPTIONS: ReadonlySet<string> = new Set([
	"--exclude",
	"--exclude-dir",
	"--include",
	"-g",
	"--glob",
	"--iglob",
	"--ignore",
	"--ignore-dir",
	"--ignore-directory",
	"--ignore-file",
]);

function searchOperandRoles(
	name: string,
	rawArgs: ReadonlyArray<ShellToken>,
	skipped: Set<ShellToken>,
	roles: BashOperandRoles,
): boolean {
	let tool: RecursiveSearchTool;
	let syntax: SearchSyntax;
	let args = rawArgs;
	if (GREP_SEARCH_NAMES.has(name)) {
		tool = "grep";
		syntax = GREP_SEARCH_SYNTAX;
	} else if (name === "rg") {
		tool = "rg";
		syntax = RG_SEARCH_SYNTAX;
	} else if (name === "ag") {
		tool = "ag";
		syntax = AG_SEARCH_SYNTAX;
	} else if (name === "ack") {
		tool = "ack";
		syntax = ACK_SEARCH_SYNTAX;
	} else if (name === "git") {
		// git [-C dir] [-c k=v] [--flags] grep ...
		let index = 0;
		while (index < rawArgs.length) {
			const value = rawArgs[index]?.value ?? "";
			if (value === "-C" || value === "-c") index += 2;
			else if (value.startsWith("-")) index += 1;
			else break;
		}
		if (rawArgs[index]?.value !== "grep") return false;
		tool = "git grep";
		syntax = GIT_GREP_SEARCH_SYNTAX;
		args = rawArgs.slice(index + 1);
	} else return false;
	const parsed = parseSearchArgs(args, syntax);
	// The pattern (and an -e value) is a regular expression, never opened.
	for (const entry of parsed.values) {
		if (entry.attached) {
			if (entry.option === `-${syntax.patternShort}` || syntax.patternLong.includes(entry.option))
				skipped.add(entry.token);
			continue;
		}
		if (
			(syntax.patternShort.length > 0 && entry.option === `-${syntax.patternShort}`) ||
			syntax.patternLong.includes(entry.option) ||
			EXCLUSION_OPTIONS.has(entry.option)
		)
			skipped.add(entry.token);
	}
	for (const entry of parsed.values) {
		if (entry.attached && EXCLUSION_OPTIONS.has(entry.option)) skipped.add(entry.token);
	}
	const listsOnly = tool === "rg" && parsed.flags.includes("--files");
	const positionals = [...parsed.positionals];
	if (!parsed.explicitPattern && !listsOnly) {
		const pattern = positionals.shift();
		if (pattern !== undefined) skipped.add(pattern);
	}
	const recursive = tool === "grep" ? recursesDirectories(args.map((arg) => arg.value)) : tool !== "rg" || !listsOnly;
	if (!recursive) return true;
	const excludes: string[] = [];
	const excludeDirs: string[] = [];
	for (const entry of parsed.values) {
		const value = entry.value;
		if (tool === "grep" && entry.option === "--exclude") excludes.push(value);
		else if (tool === "grep" && entry.option === "--exclude-dir") excludeDirs.push(value);
		else if (tool === "rg" && ["-g", "--glob", "--iglob"].includes(entry.option) && value.startsWith("!"))
			excludes.push(value.slice(1));
		else if (tool === "ag" && entry.option === "--ignore") excludes.push(value);
		else if (tool === "ag" && entry.option === "--ignore-dir") excludeDirs.push(value);
		else if (tool === "ack" && entry.option === "--ignore-file" && value.startsWith("is:")) excludes.push(value.slice(3));
		else if (tool === "ack" && (entry.option === "--ignore-dir" || entry.option === "--ignore-directory"))
			excludeDirs.push(value);
	}
	const roots: string[] = [];
	for (const positional of positionals) {
		const value = positional.value;
		if (tool === "git grep") {
			const exclusion = /^:(?:!|\^|\(exclude\))(.+)$/u.exec(value);
			if (exclusion?.[1] !== undefined) {
				excludes.push(exclusion[1]);
				skipped.add(positional);
				continue;
			}
			if (value.startsWith(":")) continue;
		}
		roots.push(value);
	}
	roles.searches.push({
		tool,
		roots: roots.length === 0 ? ["."] : roots,
		excludes,
		excludeDirs,
		trackedOnly: tool === "git grep" && !parsed.flags.includes("--untracked") && !parsed.flags.includes("--no-index"),
	});
	return true;
}

function globExpression(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index] ?? "";
		if (char === "*") {
			if (glob[index + 1] === "*") {
				source += ".*";
				index += 1;
				if (glob[index + 1] === "/") index += 1;
			} else source += "[^/]*";
		} else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
	}
	return new RegExp(`^${source}$`, "u");
}

/** True when one of `globs` matches the base name or the root-relative path. */
function matchesAnyGlob(globs: ReadonlyArray<string>, name: string, relative: string): boolean {
	return globs.some((glob) => {
		const expression = globExpression(glob.replace(/^\.\//u, "").replace(/\/$/u, ""));
		return expression.test(name) || expression.test(relative);
	});
}

interface ProtectedTreeEntry {
	/** Path relative to the search root, `/`-separated. */
	relative: string;
	absolute: string;
	directory: boolean;
	matchedPath: string;
}

const RECURSIVE_SEARCH_MEMO_TTL_MS = 5_000;

const RECURSIVE_SEARCH_MEMO_LIMIT = 64;

/** Each name costs a path-policy match, about 25 times discovery's name check, so this walk keeps a smaller budget. */
const RECURSIVE_SEARCH_ENTRY_BUDGET = 20_000;

const recursiveSearchMemo = new Map<string, { at: number; stamp: number; entries: ProtectedTreeEntry[] }>();

/**
 * The zero-access files and directories below `root`, found by a walk bounded
 * the way the sandbox's secret discovery is (its depth and skipped dependency
 * trees), judging at most {@link RECURSIVE_SEARCH_ENTRY_BUDGET} names.
 * Memoized briefly per root and policy, keyed on
 * the root's mtime so a secret created beside the project is seen at once.
 * A walk that runs out of budget reports what it found; the rest is the
 * sandbox's to hide.
 */
function protectedEntriesUnder(root: string, policy: CompiledPathPolicy): ProtectedTreeEntry[] {
	let stamp: number;
	try {
		stamp = statSync(root).mtimeMs;
	} catch {
		return [];
	}
	const key = [root, ...policy.entries.map((entry) => `${entry.kind}:${entry.source}:${entry.path}`)].join("\0");
	const now = Date.now();
	const cached = recursiveSearchMemo.get(key);
	if (cached !== undefined && cached.stamp === stamp && now - cached.at < RECURSIVE_SEARCH_MEMO_TTL_MS)
		return cached.entries;
	const entries: ProtectedTreeEntry[] = [];
	const pending: Array<{ relative: string; depth: number }> = [{ relative: "", depth: 0 }];
	let visited = 0;
	walk: for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
		const directory = frame.relative.length === 0 ? root : path.join(root, frame.relative);
		let listing: Dirent[];
		try {
			listing = readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of listing) {
			visited += 1;
			if (visited > RECURSIVE_SEARCH_ENTRY_BUDGET) break walk;
			const relative = frame.relative.length === 0 ? entry.name : `${frame.relative}/${entry.name}`;
			const absolute = path.join(root, relative);
			const decision = evaluatePathPolicy(policy, "read", absolute, root);
			const isDirectory = entry.isDirectory();
			if (decision.kind === "block") {
				entries.push({ relative, absolute, directory: isDirectory, matchedPath: decision.matchedPath });
				continue;
			}
			if (isDirectory && !isSkippedSecretScanDirectory(entry.name) && frame.depth + 1 < SECRET_SCAN_LIMITS.depth) {
				pending.push({ relative, depth: frame.depth + 1 });
			}
		}
	}
	if (recursiveSearchMemo.size >= RECURSIVE_SEARCH_MEMO_LIMIT) recursiveSearchMemo.clear();
	recursiveSearchMemo.set(key, { at: now, stamp, entries });
	return entries;
}

/**
 * The subset of `entries` git tracks in `cwd`'s work tree; all of them when git cannot tell. This runs on the host
 * while a command is judged, in whatever repository `cwd` is in, so it is internal git: ls-files would otherwise run
 * that repository's core.fsmonitor program, which a contained command can write into a repository it creates.
 */
function trackedEntries(entries: ReadonlyArray<ProtectedTreeEntry>, cwd: string): ProtectedTreeEntry[] {
	if (entries.length === 0) return [];
	let result: SpawnSyncReturns<string>;
	try {
		result = gitSpawnSync(["ls-files", "-z", "--", ...entries.map((entry) => entry.absolute)], {
			cwd,
			encoding: "utf8",
			timeout: 2_000,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
	} catch {
		return [...entries];
	}
	if (result.status !== 0 || typeof result.stdout !== "string") return [...entries];
	const tracked = new Set(
		result.stdout
			.split("\0")
			.filter((line) => line.length > 0)
			.map((line) => path.resolve(cwd, line)),
	);
	return entries.filter(
		(entry) => entry.directory || [...tracked].some((file) => isSameOrDescendant(file, entry.absolute)),
	);
}

function exclusionHint(tool: RecursiveSearchTool, name: string, relative: string, directory: boolean): string {
	switch (tool) {
		case "grep":
			return directory ? `--exclude-dir=${name}` : `--exclude=${name}`;
		case "rg":
			return `-g '!${name}'`;
		case "ag":
			return `--ignore=${name}`;
		case "ack":
			return directory ? `--ignore-dir=${name}` : `--ignore-file=is:${name}`;
		case "git grep":
			return `':!${relative}'`;
	}
}

/**
 * A recursive search prints what it finds in every file under its roots, so a
 * root that holds a zero-access file reads it as surely as `cat` would. The
 * first protected entry the command does not already exclude refuses it, with
 * the exclusion that lets the same search run.
 */
export function recursiveSearchHit(
	search: RecursiveSearch,
	policy: CompiledPathPolicy,
	cwd: string,
): BashZeroAccessHit | null {
	for (const raw of search.roots) {
		const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw;
		const root = path.resolve(cwd, expanded);
		let isDirectory: boolean;
		try {
			isDirectory = statSync(root).isDirectory();
		} catch {
			continue;
		}
		// A file root is an operand the read rail already judged.
		if (!isDirectory) continue;
		let found = protectedEntriesUnder(root, policy);
		if (search.trackedOnly) found = trackedEntries(found, cwd);
		for (const entry of found) {
			const segments = entry.relative.split("/");
			const name = segments.at(-1) ?? entry.relative;
			const ancestors = segments.slice(0, -1);
			const excludedByDir =
				ancestors.some((dir) => matchesAnyGlob(search.excludeDirs, dir, dir)) ||
				(entry.directory && matchesAnyGlob(search.excludeDirs, name, entry.relative));
			const excluded =
				excludedByDir ||
				matchesAnyGlob(search.excludes, name, entry.relative) ||
				ancestors.some((dir, index) =>
					search.tool === "grep" ? false : matchesAnyGlob(search.excludes, dir, segments.slice(0, index + 1).join("/")),
				);
			if (excluded) continue;
			const shown = path.relative(cwd, entry.absolute) || entry.relative;
			const exclusion = exclusionHint(search.tool, name, path.relative(cwd, entry.absolute), entry.directory);
			return {
				verb: "read",
				token: shown,
				entrySource: `zeroAccessPaths entry ${entry.matchedPath} (reached by the recursive ${search.tool} search)`,
				hint: `Exclude it so the search never opens it: add ${exclusion}`,
			};
		}
	}
	return null;
}
