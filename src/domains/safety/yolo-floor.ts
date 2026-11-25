// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { extractCommandPathWalks, shellCommandSteps } from "./command-path-walks.js";
import type { DamageControlRule } from "./damage-control.js";
import { withoutDataHeredocBodies } from "./heredoc-scan.js";
import { withPrintedArgumentsBlanked } from "./literal-exemption.js";

/**
 * The yolo floor (#407, #419, #421). Yolo is the operator's
 * skip-permissions mode: no approval stops and no built-in rail. What still
 * blocks is this short list of actions nothing in a coding task needs and
 * nobody can undo, plus PanCode's own state and credential store,
 * operator-authored rules and the run's explicit ceilings, which the policy
 * engine applies beside it. The operator's own session at autonomy default
 * meets the same floor before anything else, so no judge can allow it.
 *
 * A floor hit is a hard block returned to the model with its reason; it never
 * parks. The floor reads command text and literal paths only: an interpreter
 * that deletes through its own API, or a path built at run time, is not seen,
 * which is the same reach as any skip-permissions mode.
 */

/** Damage-control pack rules the floor keeps at yolo, by their pack ids. */
export const YOLO_FLOOR_PACK_RULE_IDS: ReadonlySet<string> = new Set([
	"rm-home-or-root",
	"mkfs-any",
	"dd-of-dev",
	"fork-bomb",
]);

/** Floor rule ids for the judgments below and for PanCode's own state. */
export const YOLO_FLOOR_RULE_IDS = {
	deleteTarget: "yolo-floor-delete-target",
	/** Deleting, emptying or moving away the workspace's own `.git`, directory or linked-worktree file (row 261). */
	workspaceGit: "yolo-floor-workspace-git",
	mkfs: "yolo-floor-mkfs",
	wipefs: "yolo-floor-wipefs",
	blockDevice: "yolo-floor-block-device",
	forkBomb: "yolo-floor-fork-bomb",
	/** Existing rail id: a write or delete into PanCode's config, data, state or cache trees. */
	pancodeOwned: "pancode-owned-state",
	/** Existing rail id: a workspace trust grant made from a tool call. */
	trustAuthority: "trust-authority",
	/** PanCode's settings, credential or trust CLI run from a tool call, at every autonomy level. */
	settingsAuthority: "settings-authority",
	/** A read of PanCode's own provider credential store, at every autonomy level. */
	pancodeCredentials: "yolo-floor-pancode-credentials",
	/** A floor command found in a line read as raw text, or a line whose raw-text pieces hold more than the floor reads. */
	rawText: "yolo-floor-raw-text",
} as const;

/** Floor rules that refuse a change only the operator makes: PanCode's trust, settings and own trees (CLI-P31). */
export const YOLO_FLOOR_AUTHORITY_RULE_IDS: ReadonlySet<string> = new Set([
	YOLO_FLOOR_RULE_IDS.trustAuthority,
	YOLO_FLOOR_RULE_IDS.settingsAuthority,
	YOLO_FLOOR_RULE_IDS.pancodeOwned,
]);

/** The remedy an authority-class refusal gives: the operator acts, and no script, file or wrapper stands in for them. */
export const YOLO_FLOOR_AUTHORITY_REMEDY =
	"only the operator makes this change: ask them to run it themselves; a script, a file or any wrapper that runs it is refused the same way";

/** Every reason code a floor block carries starts with this. */
export const YOLO_FLOOR_REASON_PREFIX = "yolo-floor:";

/** Block devices a write must never reach, by their /dev names on Linux and macOS. */
const BLOCK_DEVICE = "/dev/(?:sd|hd|vd|xvd|nvme|mmcblk|loop|dm-|md|nbd|rbd|zram|sr|r?disk|mapper/)";

/**
 * Text rules the floor adds to the kept pack rules. They run through the same
 * matcher, so a match inside an inert quoted argument (a commit message, an
 * echo) does not count.
 */
export const YOLO_FLOOR_TEXT_RULES: ReadonlyArray<DamageControlRule> = [
	{
		id: YOLO_FLOOR_RULE_IDS.blockDevice,
		description: "writes straight to a block device through dd, a redirect or tee",
		pattern: new RegExp(
			String.raw`(?:\bdd\b[^;&|\n]*\bof=["']?${BLOCK_DEVICE}|>>?\|?\s*["']?${BLOCK_DEVICE}|\btee\s+(?:-[A-Za-z]+\s+)*["']?${BLOCK_DEVICE})`,
			"i",
		),
		class: "system_modify",
		block: true,
	},
	{
		id: YOLO_FLOOR_RULE_IDS.forkBomb,
		description: "defines a function that pipes itself into itself in the background (a fork bomb)",
		pattern: /(?:^|[\s;&|({])([\w:.-]+)\s*\(\)\s*\{\s*\1\s*\|\s*\1\s*&/u,
		class: "execute",
		block: true,
	},
];

/** Commands whose every run formats or erases a filesystem signature. */
const FLOOR_EXECUTABLES: ReadonlyArray<{ id: string; description: string; matches: (name: string) => boolean }> = [
	{
		id: YOLO_FLOOR_RULE_IDS.mkfs,
		description: "creates a filesystem (mkfs and its variants)",
		matches: (name) => /^(?:mkfs(?:\.[\w.-]+)?|mke2fs|newfs(?:_[\w]+)?)$/u.test(name),
	},
	{
		id: YOLO_FLOOR_RULE_IDS.wipefs,
		description: "erases filesystem signatures (wipefs)",
		matches: (name) => name === "wipefs",
	},
];

export interface YoloFloorHit {
	ruleId: string;
	reason: string;
}

/**
 * FX-25: a quoted heredoc copied to a file is write content, not shell text. Keep its redirects and surrounding
 * commands. If the path walk also reads the original body because it may run in this call, so does the floor.
 */
export function yoloFloorCommandText(command: string): string {
	const text = withoutDataHeredocBodies(command, "all", "rails");
	return text !== command && extractCommandPathWalks(command).length === 1 ? text : command;
}

/** The floor rule a command's steps run, by executable name: mkfs and wipefs. */
export function yoloFloorExecutableHit(command: string): YoloFloorHit | null {
	for (const step of shellCommandSteps(command)) {
		for (const entry of FLOOR_EXECUTABLES) {
			if (entry.matches(step.executable)) {
				return { ruleId: entry.id, reason: `matched ${entry.id}: ${entry.description}` };
			}
		}
	}
	return null;
}

/** Builtins that print their arguments as data: `echo config trust` names the words, it runs nothing. */
const PRINTING_BUILTINS: ReadonlySet<string> = new Set(["echo", "printf"]);

/** `config` flags whose next word is their value, as `src/cli/config.ts` reads them. */
const CONFIG_VALUE_FLAGS: ReadonlySet<string> = new Set(["--hash", "--scope"]);

/** True when `args[at]` is `config` and the verb `config` reads after it is `trust`, outside a help request. */
function configTrustAt(args: ReadonlyArray<string>, at: number): boolean {
	if (args[at] !== "config") return false;
	for (let index = at + 1; index < args.length; index += 1) {
		const word = args[index] as string;
		if (word === "--") return false;
		if (CONFIG_VALUE_FLAGS.has(word)) {
			index += 1;
			continue;
		}
		if (!word.startsWith("-")) return word === "trust";
	}
	return false;
}

/**
 * One step's argv grants, revokes or pins workspace trust: `config trust` in any program's arguments but a help
 * request. The program name is not trusted, since a symlink, alias or wrapper can be PanCode's launcher by any name.
 * With `verbOnly`, `config` must be the program's own verb: its first positional, or one after only `--flag value`
 * pairs, so a quotes-dropped reading does not take a message's words for an argv.
 */
function stepGrantsTrust(executable: string, args: ReadonlyArray<string>, verbOnly: boolean): boolean {
	if (PRINTING_BUILTINS.has(executable)) return false;
	const end = args.indexOf("--");
	const options = end === -1 ? args : args.slice(0, end);
	if (options.includes("--help") || options.includes("-h")) return false;
	if (!verbOnly) return args.some((_, at) => configTrustAt(args, at));
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] as string;
		if (word === "config") return configTrustAt(args, at);
		if (word.startsWith("-")) continue;
		if (!(args[at - 1] ?? "").startsWith("-")) return false;
	}
	return false;
}

/**
 * True when a command runs PanCode's `config trust` (CLI-P31): a parsed step of any program whose arguments hold
 * `config` with the verb `trust`, not a help request. Words in a `for` list, a `case` pattern, an `echo` or `printf`
 * and a quoted argument are data and never match. Steps follow `sh -c` scripts and substitutions; a here-document
 * that is not data copied to a file is read line by line, since a shell may run it. `rawText` marks a reading with
 * its quotes dropped, where only `config` as the program's verb counts.
 */
export function yoloFloorTrustGrant(command: string, rawText = false): boolean {
	const texts = [command];
	if (/<<(?!<)/u.test(command)) texts.push(...withoutDataHeredocBodies(command, "all", "rails").split(/\r?\n/u));
	return texts.some((text) =>
		shellCommandSteps(text).some((step) => stepGrantsTrust(step.executable, step.args, rawText)),
	);
}

/** A script a command runs without naming a shell: a program run by path, or a file `source` or `.` reads. */
export interface YoloFloorScriptRun {
	path: string;
	sourced: boolean;
}

/** Shells whose scripts the floor's line scan reads. */
const SCRIPT_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "mksh"]);

/**
 * The scripts a command runs by path (`./x.sh`, `/opt/x`) or sources (`source x`, `. x`), in `sh -c` scripts and
 * substitutions too (CLI-P31). `bash x.sh` is not listed: the shell-script scan already reads it. `home` stands in for a
 * leading `~`, `$HOME` or `${HOME}` the shell expands, so a quoted `'$HOME/x'` stays literal (row 215).
 */
export function yoloFloorScriptRuns(command: string, home?: string): YoloFloorScriptRun[] {
	const runs: YoloFloorScriptRun[] = [];
	for (const step of shellCommandSteps(command, home)) {
		if (step.executable === "source" || step.executable === ".") {
			const target = step.args[0] === "--" ? step.args[1] : step.args[0];
			if (target !== undefined && !target.startsWith("-")) runs.push({ path: target, sourced: true });
		} else if (step.commandPath !== undefined && !SCRIPT_SHELLS.has(step.executable)) {
			runs.push({ path: step.commandPath, sourced: false });
		} else if (step.executable === "exec") {
			// `exec -a name ./x.sh` replaces the shell with the file; `-a` takes a value.
			let at = 0;
			while (step.args[at]?.startsWith("-") === true) at += step.args[at] === "-a" ? 2 : 1;
			const target = step.args[at];
			if (target?.includes("/") === true) runs.push({ path: target, sourced: false });
		}
	}
	return runs;
}

/**
 * Whether a file run by path is shell source, read at decision time: a `#!` line naming a shell (directly or through
 * `env`), or no `#!` line at all, which the calling shell runs itself. A binary or another interpreter is not.
 * Null when the file cannot be read.
 */
export function yoloFloorShellScript(file: string): boolean | null {
	let head: string;
	try {
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(256);
			head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("latin1");
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
	if (head.includes("\0")) return false;
	if (!head.startsWith("#!")) return true;
	const words = (head.slice(2).split(/\r?\n/u)[0] ?? "").trim().split(/\s+/u);
	let program = path.basename(words[0] ?? "");
	if (program === "env") program = path.basename(words.slice(1).find((word) => !word.startsWith("-")) ?? "");
	return SCRIPT_SHELLS.has(program);
}

/** Words a raw-text candidate starts at: the floor's executables and the commands that delete, overwrite or archive. */
const RAW_TEXT_START_WORD =
	/^(?:rm|rmdir|unlink|shred|find|rsync|dd|tee|tar|cp|mv|ln|install|truncate|wipefs|mkfs(?:\.[\w.-]+)?|mke2fs|newfs(?:_\w+)?)$/u;

/**
 * Most text the raw-text candidates of one line may hold together. Every candidate runs through the floor's
 * judgments, so the work grows with this sum; a line whose candidates exceed it is blocked.
 */
export const MAX_RAW_TEXT_BYTES = 32 * 1024;

/** What each raw-text candidate costs the budget beyond its text: the floor's judgments have a fixed cost per call. */
const RAW_TEXT_CANDIDATE_BYTES = 64;

const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
};

/** The text of a `$'...'` body as bash decodes it. */
function decodeAnsiCBody(body: string): string {
	return body.replace(
		/\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|c(.)|([\s\S]))/gu,
		(_all, hex: string, u4: string, u8: string, octal: string, control: string, other: string) => {
			const code =
				hex !== undefined
					? Number.parseInt(hex, 16)
					: u4 !== undefined
						? Number.parseInt(u4, 16)
						: u8 !== undefined
							? Number.parseInt(u8, 16)
							: octal !== undefined
								? Number.parseInt(octal, 8)
								: control !== undefined
									? control.charCodeAt(0) & 0x1f
									: null;
			if (code !== null) return code <= 0x10ffff ? String.fromCodePoint(code) : "";
			return ANSI_C_ESCAPES[other] ?? other;
		},
	);
}

/**
 * Whether a `$(` or backtick in the command is one the shell runs: outside single quotes, `$'...'`, a backslash
 * escape and a comment. Inside double quotes it runs. A here-document body is not told apart, so a quote in one
 * can hide a later substitution; the caller also reads any substitution beside `<<` for that reason.
 */
function holdsSubstitution(command: string): boolean {
	let doubleQuoted = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		const next = command[index + 1];
		// `\x` is a literal character and `$$` the shell's PID, so neither starts a quote or a substitution.
		if (char === "\\" || (char === "$" && next === "$")) {
			index += 1;
			continue;
		}
		if (char === "`" || (char === "$" && next === "(")) return true;
		if (doubleQuoted) {
			if (char === '"') doubleQuoted = false;
			continue;
		}
		if (char === '"') {
			doubleQuoted = true;
		} else if (char === "'" || (char === "$" && next === "'")) {
			const ansiC = char === "$";
			index += ansiC ? 2 : 1;
			while (index < command.length && command[index] !== "'") index += ansiC && command[index] === "\\" ? 2 : 1;
		} else if (char === "#" && (index === 0 || /[\s;&|()<>]/u.test(command[index - 1] ?? ""))) {
			while (index < command.length && command[index] !== "\n") index += 1;
		}
	}
	return false;
}

/** A cd operand the floor's walk cannot place, standing for a cd whose directory the raw text does not say. */
const RAW_TEXT_UNPLACED_CD = "$UNPLACED_CD";

/** Most directories a line's cds may place a raw-text candidate in before its relative cds count as unplaced. */
const RAW_TEXT_RELATIVE_FANOUT = 8;

/**
 * The directory operand of the `cd` or `pushd` at `at` in a raw-text piece, after its options; `~` when it names
 * none. Null when the text does not say where it leaves the shell: run through `eval`, `cd -`, a `pushd` stack
 * rotation or an option the floor does not know.
 */
function rawCdOperand(words: ReadonlyArray<string>, at: number): string | null {
	if (words.slice(0, at).includes("eval")) return null;
	const options = words[at] === "cd" ? /^-[LPe@]+$/u : /^-n$/u;
	let index = at + 1;
	while (index < words.length) {
		const word = words[index] ?? "";
		if (word === "--") {
			index += 1;
			break;
		}
		if (!options.test(word)) break;
		index += 1;
	}
	const operand = words[index];
	if (operand === undefined) return "~";
	return operand === "-" || /^[-+]/u.test(operand) ? null : operand;
}

/**
 * The raw-text reading of a line the shared scanners may not follow into every command: one holding a command
 * substitution the shell runs, or any `$(` or backtick beside a here-document, a here-string or (for `$(`) a `#`,
 * where the quote context cannot be told from the text. The scanners place a here-document's end, a comment and a
 * substitution's close by bash's rules, and where they read a step as data the floor never judges it. This reading
 * does not parse: it joins backslash-newlines, decodes `$'...'` and `$"..."`, drops every quote, cuts the text at
 * newlines, operators, parentheses, braces and backticks, and yields each piece, the piece without its first word (a
 * here-document delimiter bash reads as the end), and the piece from every floor command word on, for the floor's
 * judgments to read like commands. Every cd on the line is put in front of each candidate, so a relative delete is
 * placed where such a cd can leave the shell; a cd whose directory the text does not say adds a variant judged from
 * an unknown directory. Placement does not charge the budget again for text already read (XR-41). Fail-closed:
 * a floor command quoted as data in such a line blocks too, except in the printed arguments of a plain `echo` or
 * `printf` ({@link withPrintedArgumentsBlanked}). Null when the line has no such shape; `overflow` when its
 * candidates hold more text than the floor reads.
 */
export function yoloFloorRawCandidates(command: string): { candidates: string[]; overflow: boolean } | null {
	const substitution = /\$\(/u.test(command);
	const beside =
		(substitution || command.includes("`")) && (command.includes("<<") || (substitution && command.includes("#")));
	if (!beside && !holdsSubstitution(command)) return null;
	const decoded = (beside ? command : withPrintedArgumentsBlanked(command))
		.replace(/\\\r?\n/gu, "")
		.replace(/\$\$|\$'((?:[^'\\]|\\[\s\S])*)'/gu, (all, body?: string) =>
			body === undefined ? all : decodeAnsiCBody(body),
		)
		.replace(/\$\$|\$"/gu, (all) => (all === "$$" ? all : '"'));
	const stripped = decoded.replace(/["']/gu, "");
	const pieces = stripped.split(/[\n\r;&|(){}`]/u).map((piece) =>
		piece
			.trim()
			.split(/\s+/u)
			.filter((word) => word !== ""),
	);
	const cds = new Set<string>();
	let unplacedCd = false;
	for (const words of pieces) {
		words.forEach((word, at) => {
			if (word !== "cd" && word !== "pushd") return;
			const operand = rawCdOperand(words, at);
			if (operand === null) unplacedCd = true;
			else cds.add(`cd ${operand}`);
		});
	}
	// A cd may or may not run: an absolute one adds a directory, a relative one doubles them. Past a few relative cds
	// they are judged as one cd the text does not say, so the work stays linear in the line.
	let placed = [...cds];
	const fanoutOf = (list: ReadonlyArray<string>) =>
		list.reduce((count, cd) => (/^cd [/~$]/u.test(cd) ? count + 1 : count * 2), 1);
	if (fanoutOf(placed) > RAW_TEXT_RELATIVE_FANOUT) {
		placed = placed.filter((cd) => /^cd [/~$]/u.test(cd));
		unplacedCd = true;
	}
	const literal = placed.length === 0 ? "" : `${placed.join(" && ")} && `;
	const prefixes = unplacedCd ? [literal, `${literal}cd ${RAW_TEXT_UNPLACED_CD} && `] : [literal];
	const candidates = new Set<string>([stripped]);
	const charged = new Set<string>([stripped]);
	let bytes = stripped.length;
	for (const words of pieces) {
		if (words.length === 0) continue;
		const starts = words.flatMap((word, index) => (RAW_TEXT_START_WORD.test(word) ? [index] : []));
		if (starts.length === 0 && !words.some((word) => /[/~$>]/u.test(word))) continue;
		for (const start of new Set([0, 1, ...starts])) {
			if (start >= words.length) continue;
			const text = words.slice(start).join(" ");
			if (!charged.has(text)) {
				charged.add(text);
				bytes += text.length + RAW_TEXT_CANDIDATE_BYTES;
				if (bytes > MAX_RAW_TEXT_BYTES) return { candidates: [], overflow: true };
			}
			for (const prefix of prefixes) candidates.add(`${prefix}${text}`);
		}
	}
	return { candidates: [...candidates], overflow: false };
}
