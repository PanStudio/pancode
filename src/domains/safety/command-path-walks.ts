// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import {
	basenameToken,
	commandTokenIndex,
	isEnvAssignment,
	isRelativeCommandPath,
	SHELL_RESERVED_PREFIXES,
} from "./command-token.js";
import {
	collectInPlaceEditTargets,
	collectInvokedWriteTargets,
	collectRedirectTargets,
	hasSedInPlaceFlag,
	isInterestingWriteTarget,
	redirectWriteTarget,
	sedFileOperands,
} from "./command-write-targets.js";
import type { HeredocReader } from "./heredoc-bodies.js";
import { removeHeredocBodies, withoutHeredocBodies } from "./heredoc-bodies.js";
import { heredocDataTrusted, mayRunHeredocOutputs } from "./heredoc-scan.js";
import type { ShellToken } from "./shell-scan.js";
import {
	COMMAND_SEPARATORS,
	scanShellLike,
	shellCommandArguments,
	shellCommandWords,
	splitSegments,
} from "./shell-scan.js";
import { expandedShellSegments, homeExpanded, INNER_SHELL_MAX_DEPTH, segmentShellScript } from "./shell-segments.js";
import { pathArgs } from "./validation-check-match.js";

/**
 * Returns every path the command would write to: shell redirect targets
 * (`>`, `>>`), all path arguments to `tee`, `mkdir`, and `touch`, the
 * destination argument of `cp`, `mv`, and `ln`, and the file operands of an
 * in-place `sed -i` edit. Standard descriptors like `/dev/null` and fd
 * references like `&1` are filtered out so callers only see real filesystem
 * targets.
 *
 * Used by the action classifier to escalate bash calls that write to a
 * system root or out-of-cwd path through the same confirmation gate as the
 * write tool, and by the finish-contract to decide whether a turn mutated
 * workspace state. Both consumers read the same primitive, so a write pattern
 * this recognizes gates and gate-completes consistently. pi-mono executes the
 * bash command verbatim, so the registry-side check has to happen before the
 * shell runs.
 */
export function extractCommandWriteTargets(command: string): string[] {
	const targets: string[] = [];
	for (const segment of expandedShellSegments(command, 0, true)) {
		collectRedirectTargets(segment, targets);
		const argv = shellCommandArguments(segment);
		collectInvokedWriteTargets(argv, targets);
		collectInPlaceEditTargets(argv, targets);
	}
	return targets.filter(isInterestingWriteTarget);
}

/** One simple command: its executable, the words after it, and the files its redirects truncate. */
export interface ShellCommandStep {
	/** Lowercased basename of the command word, or "" for a redirect with no command. */
	executable: string;
	/** The command word is a relative path such as `./sbatch` or `bin/ssh`: a workspace file, not the CLI on PATH. */
	relativePath?: true;
	/** The command word as written, home expanded, when it names a file by path (`./x.sh`, `/opt/run`, `~/bin/x`). */
	commandPath?: string;
	/** Literal words after the command word, redirections removed. */
	args: string[];
	/** Targets of `>`-style redirects that replace the file's contents. `>>` is not listed. */
	truncatingRedirects: string[];
	/** `NAME=value` words before the command word (after an `env` too), as written; absent when none. */
	assignments?: string[];
}

/**
 * The simple commands of a command line in order, following `sh -c` scripts and
 * substitutions the way the write and delete scanners do. Presentation callers
 * read this instead of re-tokenizing, so the words they describe are the words
 * admission already scanned.
 */
export function shellCommandSteps(command: string, home?: string): ShellCommandStep[] {
	const steps: ShellCommandStep[] = [];
	// A here-document body is data for the command, not commands: admission
	// removes the bodies before it reads, and so does the card. A here-document
	// that survives (inside a substitution or an `sh -c` script) cannot be told
	// from commands, so only the top-level commands are described then.
	const body = withoutHeredocBodies(command);
	const segments = /<<(?!<)/u.test(body) ? splitSegments(scanShellLike(body)) : expandedShellSegments(body);
	for (const segment of segments) {
		const truncatingRedirects: string[] = [];
		for (let index = 0; index < segment.length - 1; index += 1) {
			const operator = segment[index];
			// `<>` opens read-write and does not truncate.
			if (operator === undefined || [">>", "&>>", "<>"].includes(operator.value)) continue;
			const target = redirectWriteTarget(operator, segment[index + 1]);
			const targetToken = segment[index + 1];
			if (target !== null && targetToken !== undefined && isInterestingWriteTarget(target)) {
				truncatingRedirects.push(homeExpanded(targetToken, home));
			}
		}
		const argv = shellCommandWords(segment).map((token) => homeExpanded(token, home));
		const commandIndex = commandTokenIndex(argv);
		if (commandIndex === null) {
			if (truncatingRedirects.length > 0) steps.push({ executable: "", args: [], truncatingRedirects });
			continue;
		}
		const commandWord = argv[commandIndex] ?? "";
		const assignments = argv.slice(0, commandIndex).filter(isEnvAssignment);
		steps.push({
			executable: basenameToken(argv[commandIndex]),
			args: argv.slice(commandIndex + 1),
			truncatingRedirects,
			...(assignments.length > 0 ? { assignments } : {}),
			...(isRelativeCommandPath(argv[commandIndex]) ? { relativePath: true as const } : {}),
			...(commandWord.includes("/") ? { commandPath: commandWord } : {}),
		});
	}
	return steps;
}

/** File operands of `sed -i`, or null when these `sed` arguments do not edit in place. */
export function sedInPlaceOperands(args: ReadonlyArray<string>): string[] | null {
	const segment = ["sed", ...args];
	return hasSedInPlaceFlag(segment, 0) ? sedFileOperands(segment, 0) : null;
}

/**
 * Returns the directory each `cd`/`pushd` in the command targets. A bare
 * `cd` (and `cd -`, whose OLDPWD is unset in a fresh shell) is reported as
 * `~`: it goes to the user's home directory. The action classifier resolves
 * these against the workspace root, because a `cd` outside the workspace
 * re-bases every relative path that follows it — the laundering pattern the
 * recorded escape used (`cd /abs/outside && python3 <<EOF ...` writing
 * relative files outside the session workspace).
 */
export function extractCommandCdTargets(command: string): string[] {
	const targets: string[] = [];
	for (const tokens of expandedShellSegments(command)) {
		const target = cdTarget(shellCommandArguments(tokens));
		if (target !== null) targets.push(target);
	}
	return targets;
}

export function cdTarget(segment: ReadonlyArray<string>): string | null {
	const commandIndex = commandTokenIndex(segment);
	if (commandIndex === null) return null;
	const executable = basenameToken(segment[commandIndex]);
	if (executable !== "cd" && executable !== "pushd") return null;
	return pathArgs(segment, commandIndex).at(0) ?? "~";
}

/**
 * A path-bearing step of a shell command, in the order the shell takes them.
 * `link` is a link the command creates: `sources` are what it points at (a
 * symbolic link's text, or the file a hard link shares), and `linkDirs` are the
 * directories it may be created in, relative to where the shell is. A
 * `subshell` opens or closes a child shell: `( ... )`, a substitution, or the
 * script of an `sh -c`. A cd is `unmodeled` when it can run more times than it
 * is written, or resolve somewhere its text does not say: inside a loop, after
 * a function definition, or with CDPATH named.
 */
export type CommandPathEvent =
	| {
			kind: "cd";
			target: string;
			unmodeled: boolean;
	  }
	| { kind: "write"; target: string }
	| {
			kind: "link";
			symbolic: boolean;
			sources: string[];
			linkDirs: string[];
			origin: LinkOrigin;
			/** Where each link itself may land, as written; absent when the command reads them from input. */
			links?: string[];
			/** `mv`: the sources leave where they were. */
			moved?: boolean;
	  }
	| {
			kind: "delete";
			target: string;
			scope: DeleteScope;
			findRoot?: FindRootFilter;
			/** A find root's whole argument list, so a reader can tell what its expression may select. */
			expression?: string[];
			/**
			 * A delete a row 261 reading found where the b1c4855bf walk found none (a here-document body it dropped, an
			 * `env -S` string, an env spelled as a path, `xargs rm` input). It only ever adds judgment: scratch placement
			 * never counts it.
			 */
			added?: true;
	  }
	| { kind: "subshell"; open: boolean };

/**
 * Whether a find root's expression narrows what its delete removes before the
 * delete runs. Only the operator's yolo reads it (#419): there an unfiltered
 * root is judged like `rm -rf` of it, while every other view keeps judging
 * the root's children.
 */
export type FindRootFilter = "filtered" | "unfiltered";

/**
 * What a delete event names. `path` is the operand itself. `children` is a
 * directory whose entries go (the roots of `find ... -exec rm`), so the
 * directory may be the workspace root. `input` is `xargs rm`, whose operands
 * the scanner never sees.
 */
export type DeleteScope = "path" | "children" | "input" | "remote";

/**
 * How a link event knows its sources. `text` is a link made from the words
 * the command names. `copied` is `mv`, or a `cp` that keeps links, whose
 * sources are existing paths: a source that is itself a link is recreated with
 * the same text. `input` is `xargs` or `find -exec`, whose real operands come
 * from input the scanner never sees.
 */
export type LinkOrigin = "text" | "copied" | "input";

interface CommandPathWalkState {
	events: CommandPathEvent[];
	/** Loops open around the current segment; their cds may run any number of times. */
	loopDepth: number;
	/** A function is defined before this point, so a later call can rerun any cd. */
	functionSeen: boolean;
	/** CDPATH is named, so a relative cd may resolve against it instead. */
	cdpath: boolean;
	/** A `case` pattern ends in a bare `)`, so no parenthesis can be trusted as a subshell. */
	caseSeen: boolean;
	/**
	 * A here-document opened before this point that the walk reads with its
	 * body. The scanner reads body lines as commands, so a later cd or
	 * parenthesis may be body text.
	 */
	heredocSeen: boolean;
	/** Whether a top-level here-document counts, or only one inside a substitution or `sh -c`. */
	topLevelHeredocs: boolean;
	/** The words of the segment before the current one, and of the one piped into it, if any. */
	lastArgv: string[];
	pipedFrom: string[] | null;
}

/** Words that open a loop whose condition and body may run more than once; `done` closes it. */
const LOOP_WORDS: ReadonlySet<string> = new Set(["for", "while", "until", "select"]);

/** The reserved words a segment starts with, and a leading for, case, or select. */
function leadingShellWords(argv: ReadonlyArray<string>): string[] {
	const words: string[] = [];
	for (const word of argv) {
		if (SHELL_RESERVED_PREFIXES.has(word)) {
			words.push(word);
			continue;
		}
		if (word === "for" || word === "case" || word === "select") words.push(word);
		break;
	}
	return words;
}

/**
 * The cd, write, and link steps of a command in order, with the child shells
 * around them, so a caller can resolve each write against every directory an
 * earlier cd can leave the shell in. A segment's substitutions and redirects
 * are opened before its command runs, so they come before its cd.
 */
function extractCommandPathWalk(command: string, topLevelHeredocs = true): CommandPathEvent[] {
	const walk: CommandPathWalkState = {
		events: [],
		loopDepth: 0,
		functionSeen: false,
		cdpath: /\bCDPATH\b/u.test(command),
		caseSeen: false,
		heredocSeen: false,
		topLevelHeredocs,
		lastArgv: [],
		pipedFrom: null,
	};
	collectPathWalk(command, 0, walk);
	return walk.caseSeen ? walk.events.filter((event) => event.kind !== "subshell") : walk.events;
}

/**
 * The path walks a caller has to judge a command by. The scanner cannot tell a
 * here-document body line from a command: a body `(` and `)` around a real cd
 * made the walk forget it, and a lone quote in a body swallowed every later
 * command. So a command with a here-document is also read with its bodies
 * removed, and a write escalates when either walk escalates it. A
 * here-document that cannot be removed, because it sits inside a substitution
 * or an `sh -c` script or has no word, leaves every later cd unmodeled.
 *
 * When every here-document is quoted and feeds a known stdin sink or is copied
 * by `cat` or `tee` into a file, only the walk without bodies counts: `=>` in a
 * TypeScript body is not a redirect. A body that may feed a shell or an
 * unknown command is still read as commands, and so is one whose
 * file a later command names, since that command may run it, or a script
 * file a step such as `make` may run without naming it. The safety rails (`reader` "rails") further keep a body as
 * commands unless {@link heredocDataTrusted}; the finish contract reads it as b1c4855bf did ("base").
 */
export function extractCommandPathWalks(command: string, reader: HeredocReader = "rails"): CommandPathEvent[][] {
	const { text: withoutBodies, dataOutputs } = removeHeredocBodies(command, false);
	if (withoutBodies === command) return [extractCommandPathWalk(command)];
	const removedAll = !scanShellLike(withoutBodies).some((token) => token.operator && token.value === "<<");
	const baseStrips = removedAll && dataOutputs !== null && !mayRunHeredocOutputs(withoutBodies, dataOutputs);
	if (baseStrips && (reader === "base" || heredocDataTrusted(withoutBodies, dataOutputs ?? [])))
		return [extractCommandPathWalk(withoutBodies)];
	const full = extractCommandPathWalk(command, !removedAll);
	const stripped = extractCommandPathWalk(withoutBodies);
	if (baseStrips) {
		// Row 261: the base reading dropped these bodies, so a delete only they hold is this reading's own addition.
		const seen = new Set(stripped.flatMap((event) => (event.kind === "delete" ? [event.target] : [])));
		for (const event of full) if (event.kind === "delete" && !seen.has(event.target)) event.added = true;
	}
	return [full, stripped];
}

/**
 * The write targets a quoted here-document is copied into by `cat` or `tee`. That step writes before any later step
 * runs, so the write stands even when the call exits nonzero because a later step, such as the suite run on the file,
 * failed (SF-5).
 */
export function heredocDataWriteTargets(command: string): string[] {
	const { text, dataOutputs } = removeHeredocBodies(command, false);
	if (text === command || dataOutputs === null) return [];
	const outputs = new Set(dataOutputs);
	return extractCommandWriteTargets(command).filter((target) => outputs.has(target));
}

function collectPathWalk(command: string, depth: number, walk: CommandPathWalkState): void {
	const tokens = scanShellLike(command);
	let segment: ShellToken[] = [];
	for (const [index, token] of tokens.entries()) {
		if (token.operator && COMMAND_SEPARATORS.has(token.value)) {
			collectSegmentPathEvents(segment, depth, walk);
			segment = [];
			walk.pipedFrom = token.value === "|" ? walk.lastArgv : null;
			// `name()` defines a function whose body may run any number of times.
			const next = tokens[index + 1];
			if (token.value === "(" && next?.operator === true && next.value === ")") walk.functionSeen = true;
			// After a here-document a parenthesis may be body text, and a false `)`
			// would restore bases from before a real cd, so none are trusted.
			if ((token.value === "(" || token.value === ")") && !walk.heredocSeen)
				walk.events.push({ kind: "subshell", open: token.value === "(" });
			continue;
		}
		segment.push(token);
	}
	collectSegmentPathEvents(segment, depth, walk);
}

function collectChildScript(script: string, depth: number, walk: CommandPathWalkState): void {
	if (depth >= INNER_SHELL_MAX_DEPTH) return;
	const saved = { lastArgv: walk.lastArgv, pipedFrom: walk.pipedFrom };
	const fresh = (): void => {
		walk.lastArgv = [];
		walk.pipedFrom = null;
	};
	walk.events.push({ kind: "subshell", open: true });
	fresh();
	collectPathWalk(script, depth + 1, walk);
	// A body line can hide a later command from the walk above, as a lone quote does.
	const withoutBodies = withoutHeredocBodies(script);
	fresh();
	if (withoutBodies !== script) collectPathWalk(withoutBodies, depth + 1, walk);
	Object.assign(walk, saved);
	// A here-document body can move where the scanner thinks a substitution
	// ends, so the script may hold commands of the parent: keep its cds.
	if (!walk.heredocSeen) walk.events.push({ kind: "subshell", open: false });
}

function collectSegmentPathEvents(segment: ReadonlyArray<ShellToken>, depth: number, walk: CommandPathWalkState): void {
	if (segment.length === 0) return;
	for (const token of segment) {
		for (const script of token.substitutions ?? []) collectChildScript(script, depth, walk);
	}
	const argv = shellCommandArguments(segment);
	if (argv[0] === "done" && walk.loopDepth > 0) walk.loopDepth -= 1;
	if (argv[0] === "function") walk.functionSeen = true;
	for (const word of leadingShellWords(argv)) {
		if (LOOP_WORDS.has(word)) walk.loopDepth += 1;
		if (word === "case") walk.caseSeen = true;
	}
	const unmodeled = walk.loopDepth > 0 || walk.functionSeen || walk.cdpath || walk.heredocSeen;
	// `env -C DIR cmd` runs cmd in DIR, and `env -S 'cmd args'` runs the words of its string (row 261); cmd, a shell's
	// `-c` script included, runs inside DIR, so the subshell closes after it.
	const env = envInvocation(argv);
	const chdirs = env?.chdirs ?? [];
	if (chdirs.length > 0) {
		walk.events.push({ kind: "subshell", open: true });
		for (const target of chdirs) walk.events.push({ kind: "cd", target, unmodeled });
	}
	const writes: string[] = [];
	collectRedirectTargets(segment, writes);
	collectInvokedWriteTargets(argv, writes);
	collectInPlaceEditTargets(argv, writes);
	for (const target of writes.filter(isInterestingWriteTarget)) walk.events.push({ kind: "write", target });
	collectLinkEvents(argv, walk.events);
	const deletesFrom = walk.events.length;
	collectDeleteEvents(argv, walk.events);
	const addedFrom = walk.events.length;
	// An env spelled as a path (`/usr/bin/env`) or with clustered options (`env -iC ..`) hides the command it runs from
	// the readers above, so it is read again from where env starts it (r261f-1).
	const hidden =
		env !== null &&
		env.split === undefined &&
		env.commandIndex < argv.length &&
		env.commandIndex !== commandTokenIndex(argv)
			? argv.slice(env.commandIndex)
			: null;
	if (hidden !== null) {
		collectLinkEvents(hidden, walk.events);
		collectDeleteEvents(hidden, walk.events);
	}
	// `xargs rm` removes what the stage piped into it prints: an echo's or printf's words, or a find's matches.
	if (
		walk.pipedFrom !== null &&
		walk.events.slice(deletesFrom).some((event) => event.kind === "delete" && event.scope === "input")
	)
		walk.events.push(...pipedDeletes(walk.pipedFrom));
	if (env?.split !== undefined) collectChildScript(env.split, depth, walk);
	const hiddenScript = hidden === null ? null : segmentShellScript(hidden);
	if (typeof hiddenScript === "string") collectChildScript(hiddenScript, depth, walk);
	// What these readings add never counts toward a scratch-only call (r261e-4).
	for (const event of walk.events.slice(addedFrom)) if (event.kind === "delete") event.added = true;
	const cd = cdTarget(argv);
	// `HOME=x cd` lands in x, which nothing here places (r261f-5).
	if (cd !== null) {
		const homeSet = cd.startsWith("~") && argv.some((word) => word.startsWith("HOME="));
		walk.events.push({ kind: "cd", target: cd, unmodeled: unmodeled || homeSet });
	}
	walk.lastArgv = argv;
	const script = segmentShellScript(argv);
	if (typeof script === "string") collectChildScript(script, depth, walk);
	if (chdirs.length > 0 && !walk.heredocSeen) walk.events.push({ kind: "subshell", open: false });
	// The body starts on the next line, so this segment's own cd is real.
	if ((depth > 0 || walk.topLevelHeredocs) && segment.some((token) => token.operator && token.value === "<<"))
		walk.heredocSeen = true;
}

/** Prefixes that run the command after them unchanged in the same directory, read past to find an `env`. */
const ENV_PREFIXES: ReadonlySet<string> = new Set([
	"!",
	"command",
	"builtin",
	"exec",
	"nohup",
	"time",
	"nice",
	"timeout",
	"stdbuf",
	"ionice",
	"setsid",
	"chrt",
	"taskset",
	"unbuffer",
]);

/**
 * What an `env` does besides setting variables: `-C DIR` (`--chdir`) runs the command in DIR, and `-S STR`
 * (`--split-string`) runs the words of STR followed by the rest. Read past leading assignments and the prefixes that
 * run what follows (`command`, `!`, `timeout 5`, `nice -n 5`), and through nested `env`s, whose chdirs apply in turn.
 * A prefix's options and number-like values are skipped without knowing which take one. `commandIndex` is where the
 * command env runs stands. Null when no env stands there.
 */
function envInvocation(argv: ReadonlyArray<string>): { chdirs: string[]; split?: string; commandIndex: number } | null {
	const out: { chdirs: string[]; split?: string } = { chdirs: [] };
	let index = 0;
	let found = false;
	for (let hop = 0; hop < 16 && index < argv.length; hop += 1) {
		while (index < argv.length && /^[A-Za-z_]\w*=/u.test(argv[index] ?? "")) index += 1;
		const name = basenameToken(argv[index]);
		if (ENV_PREFIXES.has(name)) {
			index += 1;
			while (index < argv.length && /^(?:-.*|[\d.]+[smhd]?)$/u.test(argv[index] ?? "")) index += 1;
			continue;
		}
		if (name !== "env") break;
		found = true;
		for (index += 1; index < argv.length; index += 1) {
			const word = argv[index] ?? "";
			if (word === "--") {
				index += 1;
				break;
			}
			if (word.startsWith("--")) {
				const eq = word.indexOf("=");
				const option = eq === -1 ? word : word.slice(0, eq);
				const takes = option === "--chdir" || option === "--split-string" || option === "--unset";
				const value = eq !== -1 ? word.slice(eq + 1) : takes ? argv[++index] : undefined;
				if (option === "--chdir" && value !== undefined) out.chdirs.push(value);
				if (option === "--split-string" && value !== undefined) out.split = value;
				if (out.split !== undefined) break;
				continue;
			}
			if (word.startsWith("-") && word !== "-") {
				for (let at = 1; at < word.length; at += 1) {
					const flag = word[at] as string;
					if (!"uCS".includes(flag)) continue;
					const rest = word.slice(at + 1);
					const value = rest.length > 0 ? rest : argv[++index];
					if (flag === "C" && value !== undefined) out.chdirs.push(value);
					if (flag === "S" && value !== undefined) out.split = value;
					break;
				}
				if (out.split !== undefined) {
					index += 1;
					break;
				}
				continue;
			}
			if (/^[A-Za-z_]\w*=/u.test(word)) continue;
			break;
		}
		if (out.split !== undefined) break;
	}
	if (!found) return null;
	if (out.split !== undefined) {
		const rest = argv.slice(index).map((word) => `'${word.replaceAll("'", `'\\''`)}'`);
		out.split = [out.split, ...rest].join(" ");
	}
	return { ...out, commandIndex: index };
}

/**
 * The deletes `xargs rm` makes of a piped stage: each literal word an echo or printf prints, a printf's format string
 * included (its `\n` and conversions read as separators), or a find's roots. `printf -v` prints nothing.
 */
function pipedDeletes(producer: ReadonlyArray<string>): CommandPathEvent[] {
	const index = commandTokenIndex(producer);
	if (index === null) return [];
	const name = basenameToken(producer[index]);
	if (name === "find") return findRootDeletes(producer.slice(index + 1));
	if (name !== "echo" && name !== "printf") return [];
	let words = producer.slice(index + 1);
	if (name === "echo") while (/^-[neE]+$/u.test(words[0] ?? "")) words = words.slice(1);
	else {
		if (words[0]?.startsWith("-v") === true) return [];
		if (words[0] === "--") words = words.slice(1);
	}
	return words
		.map((word) => word.replace(/\\[nrtv0]|%[-#0 +']*\d*(?:\.\d+)?[a-zA-Z%]/gu, " "))
		.flatMap((word) => word.split(/\s+/u))
		.filter((word) => word !== "")
		.map((target) => ({ kind: "delete", target, scope: "path" }) as CommandPathEvent);
}

/** Commands that run the command after them, possibly with options and arguments of their own. */
const LINK_WRAPPERS: ReadonlySet<string> = new Set([
	"nice",
	"nohup",
	"timeout",
	"stdbuf",
	"ionice",
	"chrt",
	"xargs",
	"busybox",
	"setsid",
	"taskset",
	"flock",
	"exec",
	"find",
]);

/** Commands that can make a link, or recreate one they move or copy. */
const LINK_COMMANDS: ReadonlySet<string> = new Set(["ln", "link", "cp", "mv"]);

/** Commands that remove the paths they name. */
const DELETE_COMMANDS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink"]);

/**
 * The index of the command in `commands` that a wrapper runs, and whether its
 * operands come from input. A wrapper's own options and arguments are skipped
 * by looking for the next word that names such a command or another wrapper;
 * `find` runs what follows `-exec`, `-execdir`, `-ok`, or `-okdir`.
 */
function wrappedCommandIndex(
	argv: ReadonlyArray<string>,
	commands: ReadonlySet<string>,
): { index: number; fromInput: boolean } | null {
	let index = commandTokenIndex(argv);
	let fromInput = false;
	while (index !== null && LINK_WRAPPERS.has(basenameToken(argv[index]))) {
		const wrapper = basenameToken(argv[index]);
		if (wrapper === "xargs" || wrapper === "find") fromInput = true;
		const from = index;
		const next =
			wrapper === "find"
				? argv.findIndex((word, at) => at > from && /^-(?:exec|execdir|ok|okdir)$/u.test(word)) + 1
				: argv.findIndex(
						(word, at) => at > from && (commands.has(basenameToken(word)) || LINK_WRAPPERS.has(basenameToken(word))),
					);
		index = next > from ? next : null;
	}
	return index === null ? null : { index, fromInput };
}

/**
 * Paths a command removes, whatever flags it spells. Admission judges a delete
 * by where it lands: a flag pattern let `rm -v -r /` through and blocked
 * `rm -f` on scratch files, and it taught the model that dropping `-f` was the
 * way around a block. Behind `find -exec` the roots bound what goes; behind
 * `xargs` nothing does.
 */
function collectDeleteEvents(argv: ReadonlyArray<string>, out: CommandPathEvent[]): void {
	const outerIndex = commandTokenIndex(argv);
	const outerCommand = outerIndex === null ? "" : basenameToken(argv[outerIndex]);
	// `find -delete` and `rsync --delete` remove what lies under their roots, so
	// they are judged by those roots like any other delete (#419). A find root
	// carries whether its expression filters, because an unfiltered one can
	// match every entry: under the operator's yolo `find . -delete` empties the
	// workspace and its .git. Every rsync operand counts, sources included: a
	// misread option value can only add a judged path, never hide the
	// destination. A remote operand cannot be placed.
	if (outerIndex !== null && outerCommand === "find" && argv.includes("-delete")) {
		out.push(...findRootDeletes(argv.slice(outerIndex + 1)));
	}
	if (outerIndex !== null && outerCommand === "rsync" && argv.some((word) => /^--delete(?:-|$)/u.test(word))) {
		for (const operand of pathArgs(argv, outerIndex)) {
			const remote = /^[^/]*:/u.test(operand);
			out.push({ kind: "delete", target: operand, scope: remote ? "remote" : "children" });
		}
	}
	const found = wrappedCommandIndex(argv, DELETE_COMMANDS);
	if (found === null || !DELETE_COMMANDS.has(basenameToken(argv[found.index]))) return;
	if (!found.fromInput) {
		for (const target of pathArgs(argv, found.index).filter(isInterestingWriteTarget))
			out.push({ kind: "delete", target, scope: "path" });
		return;
	}
	const outer = commandTokenIndex(argv);
	if (outer !== null && basenameToken(argv[outer]) === "find") {
		out.push(...findRootDeletes(argv.slice(outer + 1)));
		return;
	}
	out.push({ kind: "delete", target: "<input>", scope: "input" });
}

/**
 * Links a command makes. `ln` (hard unless `-s`), `link` (always hard), `cp -s`,
 * and `cp -l` make one from the words they name. `mv` and a `cp` that keeps
 * links (`-a`, `-P`, `-d`, `--no-dereference`, or a recursive copy without
 * `-L` or `-H`) recreate any source that is itself a link. Behind `xargs` or
 * `find -exec` the operands are unknown. With `-t DIR` every link goes in DIR;
 * with one operand it goes in the current directory; otherwise the last operand
 * is either the link or, when it is a directory, where the links go, unless
 * `-T` says it is never a directory.
 */
function collectLinkEvents(argv: ReadonlyArray<string>, out: CommandPathEvent[]): void {
	const found = wrappedCommandIndex(argv, LINK_COMMANDS);
	if (found === null) return;
	const cmdIndex = found.index;
	const executable = basenameToken(argv[cmdIndex]);
	if (!LINK_COMMANDS.has(executable)) return;
	let symbolic = false;
	let hard = executable === "ln" || executable === "link";
	let keepsLinks = executable === "mv";
	let dereferences = false;
	let targetDirectory: string | null = null;
	let noTargetDirectory = false;
	let endOfOptions = false;
	const operands: string[] = [];
	for (let index = cmdIndex + 1; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		// `find -exec` ends its command at a lone `;` or `+`.
		if (found.fromInput && (token === ";" || token === "+")) break;
		if (endOfOptions || !token.startsWith("-") || token === "-") {
			operands.push(token);
			continue;
		}
		if (token === "--") {
			endOfOptions = true;
			continue;
		}
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			const name = eq === -1 ? token : token.slice(0, eq);
			const value = eq === -1 ? undefined : token.slice(eq + 1);
			if (executable === "mv") {
				if (name === "--target-directory") {
					targetDirectory = value ?? argv[index + 1] ?? null;
					if (value === undefined) index += 1;
				} else if (name === "--no-target-directory") noTargetDirectory = true;
				else if (name === "--suffix" && value === undefined) index += 1;
				continue;
			}
			if (name === "--symbolic" || name === "--symbolic-link") symbolic = true;
			else if (name === "--link") hard = true;
			else if (name === "--archive" || name === "--no-dereference" || name === "--recursive") keepsLinks = true;
			else if (name === "--dereference") dereferences = true;
			else if (name === "--no-target-directory") noTargetDirectory = true;
			else if (name === "--target-directory") {
				targetDirectory = value ?? argv[index + 1] ?? null;
				if (value === undefined) index += 1;
			} else if (name === "--suffix" && value === undefined) index += 1;
			continue;
		}
		for (let at = 1; at < token.length; at += 1) {
			const flag = token[at];
			if (flag === "s" && executable !== "mv") symbolic = true;
			else if (flag === "l" && executable === "cp") hard = true;
			else if (executable === "cp" && flag !== undefined && "aPdrR".includes(flag)) keepsLinks = true;
			else if (executable === "cp" && (flag === "L" || flag === "H")) dereferences = true;
			else if (flag === "T") noTargetDirectory = true;
			else if (flag === "t" || flag === "S") {
				// The rest of the cluster, or the next word, is the option's argument.
				const rest = token.slice(at + 1);
				const value = rest.length > 0 ? rest : argv[index + 1];
				if (rest.length === 0) index += 1;
				if (flag === "t") targetDirectory = value ?? null;
				break;
			}
		}
	}
	const copied = !symbolic && !hard && keepsLinks && !dereferences;
	if (!symbolic && !hard && !copied) return;
	let sources = operands;
	let linkDirs = ["."];
	const named = (dir: string) => (source: string) => path.posix.join(dir, path.posix.basename(source));
	let links = operands.map(named("."));
	if (targetDirectory !== null) {
		linkDirs = [targetDirectory];
		links = operands.map(named(targetDirectory));
		out.push({ kind: "write", target: targetDirectory });
	} else if (operands.length > 1) {
		const destination = operands.at(-1) as string;
		sources = operands.slice(0, -1);
		const parent = path.posix.dirname(destination);
		linkDirs = noTargetDirectory ? [parent] : [parent, destination];
		// The destination is the link, or a directory the links go into.
		links = noTargetDirectory ? [destination] : [destination, ...sources.map(named(destination))];
	}
	const origin: LinkOrigin = found.fromInput ? "input" : copied ? "copied" : "text";
	if (origin === "input") {
		out.push({
			kind: "link",
			symbolic: symbolic || copied,
			sources: operands.length > 0 ? operands : ["<input>"],
			linkDirs,
			origin,
		});
		return;
	}
	if (sources.length > 0)
		out.push({
			kind: "link",
			symbolic: symbolic || copied,
			sources,
			linkDirs,
			origin,
			links,
			...(executable === "mv" ? { moved: true } : {}),
		});
}

/**
 * Returns paths that common shell commands would remove from their current
 * location. This intentionally covers only deterministic, path-bearing
 * patterns; broader command admission remains owned by the policy engine.
 */
/**
 * Write and delete targets of the steps that follow a literal `cd`, spelled
 * from the directory that cd chain leaves the shell in (`cd ..` included).
 * A target written before any cd is not listed: the call cwd already judges it.
 */
export function extractCommandCdScopedTargets(command: string): Array<{ operation: "write" | "delete"; path: string }> {
	const out: Array<{ operation: "write" | "delete"; path: string }> = [];
	let cdDir: string | null = null;
	for (const tokens of expandedShellSegments(command, 0, true)) {
		const argv = shellCommandArguments(tokens);
		const cd = cdTarget(argv);
		if (cd !== null) {
			cdDir = cdDir === null || cd.startsWith("/") || cd.startsWith("~") ? cd : path.posix.join(cdDir, cd);
			continue;
		}
		if (cdDir === null) continue;
		const writes: string[] = [];
		collectRedirectTargets(tokens, writes);
		collectInvokedWriteTargets(argv, writes);
		collectInPlaceEditTargets(argv, writes);
		const deletes: string[] = [];
		const commandIndex = commandTokenIndex(argv);
		if (commandIndex !== null) {
			const executable = basenameToken(argv[commandIndex]);
			const args = pathArgs(argv, commandIndex);
			if (executable === "rm") deletes.push(...args);
			else if (executable === "mv" && args.length >= 2) deletes.push(...args.slice(0, -1));
			else if (executable === "find" && argv.includes("-delete")) deletes.push(...findRoots(argv.slice(commandIndex + 1)));
		}
		const base = cdDir;
		const spell = (target: string) =>
			target.startsWith("/") || target.startsWith("~") ? target : path.posix.join(base, target);
		for (const target of writes.filter(isInterestingWriteTarget)) out.push({ operation: "write", path: spell(target) });
		for (const target of deletes.filter(isInterestingWriteTarget)) out.push({ operation: "delete", path: spell(target) });
	}
	return out;
}

export function extractCommandDeleteTargets(command: string): string[] {
	const targets: string[] = [];
	for (const tokens of expandedShellSegments(command)) {
		const segment = shellCommandArguments(tokens);
		const commandIndex = commandTokenIndex(segment);
		if (commandIndex === null) continue;
		const executable = basenameToken(segment[commandIndex]);
		if (executable === "rm") {
			targets.push(...pathArgs(segment, commandIndex));
			continue;
		}
		if (executable === "mv") {
			const args = pathArgs(segment, commandIndex);
			if (args.length >= 2) targets.push(...args.slice(0, -1));
			continue;
		}
		if (executable === "find" && segment.includes("-delete")) {
			targets.push(...findRoots(segment.slice(commandIndex + 1)));
		}
	}
	return targets.filter(isInterestingWriteTarget);
}

/**
 * Tests that narrow which entries a find expression reaches. `-type`, depth
 * and traversal options do not: `find . -type f -delete` still removes every
 * file.
 */
const FIND_FILTER_TESTS = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-lname",
	"-ilname",
	"-newer",
	"-anewer",
	"-cnewer",
	"-mtime",
	"-mmin",
	"-atime",
	"-amin",
	"-ctime",
	"-cmin",
	"-size",
	"-empty",
	"-user",
	"-group",
	"-uid",
	"-gid",
	"-nouser",
	"-nogroup",
	"-perm",
	"-links",
	"-inum",
	"-samefile",
]);

/**
 * A find expression filters its delete when a narrowing test comes before the
 * first action and nothing can route around it: `-o`, `,` or a negation lets
 * entries the test rejects reach the action (`find . -name x -o -delete`).
 */
export function findExpressionFilters(args: ReadonlyArray<string>): boolean {
	let filtered = false;
	for (const [index, token] of args.entries()) {
		if (/^-(?:delete|exec|execdir|ok|okdir)$/u.test(token)) return filtered;
		if (token === "-o" || token === "-or" || token === "," || token === "!" || token === "-not") return false;
		if (findTestMatchesAll(token, args[index + 1])) continue;
		if (FIND_FILTER_TESTS.has(token) || /^-newer[aBcmt][aBcmt]$/u.test(token)) filtered = true;
	}
	return filtered;
}

/** `-name '*'` and `-regex '.*'` name a test that rejects nothing. */
function findTestMatchesAll(test: string, value: string | undefined): boolean {
	if (value === undefined) return false;
	if (/^-i?(?:name|path|wholename)$/u.test(test)) return /^\**$/u.test(value);
	if (/^-i?regex$/u.test(test)) return /^(?:\.\*)*$/u.test(value);
	return false;
}

function findRootDeletes(args: ReadonlyArray<string>): CommandPathEvent[] {
	const findRoot: FindRootFilter = findExpressionFilters(args) ? "filtered" : "unfiltered";
	return findRoots(args).map((target) => ({
		kind: "delete",
		target,
		scope: "children",
		findRoot,
		expression: [...args],
	}));
}

export function findRoots(args: ReadonlyArray<string>): string[] {
	const roots: string[] = [];
	// find's own leading options (`-L`, `-D tree`, `-O3`) come before the roots;
	// stopping at them judged `find -L /x -delete` by `.` instead of `/x`.
	let start = 0;
	while (start < args.length && /^-(?:[HLP]|O\d*|D)$/u.test(args[start] ?? "")) start += args[start] === "-D" ? 2 : 1;
	for (const token of args.slice(start)) {
		if (token === "-delete" || token.startsWith("-") || token === "(" || token === "!" || token === "not") break;
		if (token === "--") continue;
		roots.push(token);
	}
	return roots.length === 0 ? ["."] : roots;
}
