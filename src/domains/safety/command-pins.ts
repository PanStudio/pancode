// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import type { ShellPipeline, ShellScript, ShellSimpleCommand, ShellWord, ShellWordPart } from "./shell-syntax.js";
import { parseShellScript, staticWordValue } from "./shell-syntax.js";

/** Names the shell sets, rewrites or reads for its own behaviour: an assignment to one proves nothing a later reference sees. */
const UNPINNABLE_NAME =
	/^(?:BASH\w*|CDPATH|DIRSTACK|ENV|EUID|FUNCNAME|GLOBIGNORE|GROUPS|HIST\w*|IFS|LINENO|OLDPWD|OPTARG|OPTIND|PATH|PIPESTATUS|PPID|PROMPT_COMMAND|PS[0-4]|PWD|RANDOM|REPLY|SECONDS|SHELLOPTS|SRANDOM|TMPDIR|UID|_)$/u;

/**
 * The text a pinned value may be built from: nothing in it quotes, splits, globs, comments, expands, opens a tilde or
 * makes a word an assignment, so the value stands in a reading exactly where the shell puts it. A reference the pins
 * do not resolve rides along as `${NAME}`.
 */
const PIN_PLAIN = /^[\w./@%+,:-]*$/u;

/**
 * A pinned value: plain text, after at most one unresolved reference at its very start to a name that spells PanCode's
 * trees or the home directory (`${HOME}/x`, `${PANCODE_STATE_DIR}`), which the judgment reads as that tree. A
 * reference anywhere else (`$HOME$U/...`, `/home/$USER`) would split a spelling the judgment knows, so it pins nothing.
 */
const PIN_VALUE = /^(?:\$\{(?:HOME|PANCODE_\w+|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME)\})?[\w./@%+,:-]*$/u;

/** The session's TMPDIR as a `$TMPDIR` reference expands it, and the directory a bare `mktemp` uses. */
interface PinTemp {
	param: string | null;
	dir: string | null;
}

/** What a pinned name holds once its statement ran, and what it holds when the `mktemp` it came from failed. */
interface PinValue {
	fresh: string;
	failed: string;
}

/** The leading pins of a command, and the text they apply to. */
export interface PancodePins {
	/** The command with its pins applied: the fresh reading, then the one where a pinning `mktemp` failed. */
	readings: string[];
	/** The same pins applied to other text read from this command (its raw-text candidates). */
	apply: (text: string) => string[];
}

/** Shell words that can set a variable without naming it in the text, read where the parser cannot place the command. */
const DYNAMIC_ASSIGNERS =
	/(?:^|[\s;&|(){}`\\'"])(?:eval|source|\.|declare|typeset|local|readonly|read|mapfile|readarray|unset|export|let|getopts|alias|enable|builtin|trap)(?=[\s;&|)<>'"]|$)|\bprintf\b|\bwait\b[^\n;&|]*\s-p|\$\{!/u;

/** Programs that run text as shell code with their own variables, or with a changed environment. */
const CODE_RUNNERS: ReadonlySet<string> = new Set([
	"sh",
	"bash",
	"dash",
	"zsh",
	"ksh",
	"mksh",
	"ash",
	"busybox",
	"fish",
	"csh",
	"tcsh",
	"env",
	"eval",
]);

/**
 * Command names after which a pin is not trusted: each runs text as code, sets or unsets a variable the text does not
 * assign, changes how later words expand, or plants a link the same command may write through.
 */
const UNPINNED_COMMANDS: ReadonlySet<string> = new Set([
	...CODE_RUNNERS,
	"exec",
	"source",
	".",
	"trap",
	"command",
	"builtin",
	"enable",
	"alias",
	"fc",
	"read",
	"mapfile",
	"readarray",
	"declare",
	"typeset",
	"local",
	"readonly",
	"export",
	"unset",
	"let",
	"getopts",
	"wait",
	"set",
	"shopt",
	"ln",
]);

/** Every simple command of a script, nested substitutions included; null when one of those does not parse. */
function scriptCommands(script: ShellScript, from = 0, depth = 0): ShellSimpleCommand[] | null {
	const commands: ShellSimpleCommand[] = [];
	for (const item of script.items) {
		for (const pipeline of item.andOr.pipelines) {
			for (const command of pipeline.commands) {
				if (command.end <= from) continue;
				commands.push(command);
				for (const word of commandWords(command)) {
					for (const part of word.parts) {
						if (part.kind !== "command") continue;
						const inner = parseShellScript(part.script, depth + 1);
						const nested = inner === null ? null : scriptCommands(inner, 0, depth + 1);
						if (nested === null) return null;
						commands.push(...nested);
					}
				}
			}
		}
	}
	return commands;
}

function commandWords(command: ShellSimpleCommand): ShellWord[] {
	return [
		...command.words,
		...command.assignments.map((assignment) => assignment.value),
		...command.redirects.map((redirect) => redirect.target),
	];
}

/** Whether `text` spells a reference to `name` (`$NAME` or `${NAME...`). */
function spellsReference(text: string, name: string): boolean {
	return new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`, "u").test(text);
}

/**
 * Whether a command sets a variable at run time from text no assignment spells: `read`, `mapfile`, `printf -v`,
 * `eval`, `declare` and their kin, or a command name the text does not fix. Read by regex where it does not parse.
 */
export function setsVariablesAtRunTime(command: string): boolean {
	const script = parseShellScript(command);
	const commands = script === null ? null : scriptCommands(script);
	// `${NAME:=value}` and `${NAME=value}` assign as they expand.
	if (/\$\{[A-Za-z_]\w*:?=/u.test(command)) return true;
	if (commands === null) return DYNAMIC_ASSIGNERS.test(command);
	return commands.some((step) => {
		const first = step.words[0];
		if (first === undefined) return false;
		const name = staticWordValue(first);
		if (name === null) return true;
		const program = path.basename(name);
		if (program === "printf") return step.words.slice(1).some((word) => staticWordValue(word)?.startsWith("-v") ?? true);
		return UNPINNED_COMMANDS.has(program) && program !== "ln";
	});
}

/**
 * Every variable the command may assign, with its value text as written: plain and prefix assignments and the
 * assignment words of `export` and its kin, every `NAME=` the raw text holds besides (in a substitution, a quote or a
 * here-document a shell may read), and every `${NAME:=value}` or `${NAME=value}`.
 */
export function commandAssignments(command: string): Array<{ name: string; text: string }> {
	const found = [
		...[...command.matchAll(/(?<![\w$])([A-Za-z_]\w*)\+?=(\S*)/gu)],
		...[...command.matchAll(/\$\{([A-Za-z_]\w*):?=([^}]*)\}/gu)],
	].map((match) => ({ name: match[1] as string, text: match[2] as string }));
	const script = parseShellScript(command);
	// Offsets are the top level's; a substitution's own assignments come from the raw text above.
	const commands = (script?.items ?? []).flatMap((item) =>
		item.andOr.pipelines.flatMap((pipeline) => pipeline.commands),
	);
	for (const step of commands) {
		for (const { name, value } of step.assignments) found.push({ name, text: command.slice(value.start, value.end) });
		for (const word of step.words.slice(1)) {
			const first = word.parts[0];
			const named = first?.kind === "literal" && !first.quoted ? /^([A-Za-z_]\w*)\+?=/u.exec(first.text) : null;
			if (named?.[1] !== undefined)
				found.push({ name: named[1], text: command.slice(word.start + named[0].length, word.end) });
		}
	}
	return found;
}

/** What can run after the pins without changing, hiding or misplacing what they hold. */
function pinsHold(commands: ReadonlyArray<ShellSimpleCommand>, pins: ReadonlyMap<string, PinValue>): boolean {
	const names = [...pins.keys()];
	// A pin whose value a failed mktemp moves is not a fixed word.
	const lookup = (name: string): string | undefined => {
		const pin = pins.get(name);
		return pin !== undefined && pin.fresh === pin.failed && !pin.fresh.includes("$") ? pin.fresh : undefined;
	};
	for (const command of commands) {
		if (command.assignments.some(({ name }) => name === "IFS" || pins.has(name))) return false;
		const words = commandWords(command);
		for (const word of words) {
			if (word.parts.some((part) => part.kind === "opaque")) return false;
			// A reference spelled as data (`'$H'`, `\\$H`) is not one the shell expands, yet a raw-text reading of the
			// line would put the pin there.
			const literal = word.parts.map((part) => (part.kind === "literal" ? part.text : "\0")).join("");
			if (names.some((name) => spellsReference(literal, name))) return false;
			const value = staticWordValue(word, lookup);
			if (value !== null && CODE_RUNNERS.has(path.basename(value))) return false;
		}
		for (const redirect of command.redirects) {
			const heredoc = redirect.heredoc;
			if (heredoc === undefined) continue;
			// A quoted body is data a raw-text reading may still put a pin in. An unquoted one expands as the shell
			// reads it, and a `${NAME:=...}` or `${NAME=...}` there assigns the pin.
			const spelled = heredoc.quoted
				? (name: string) => spellsReference(heredoc.body, name)
				: (name: string) => new RegExp(`\\$\\{${name}:?=`, "u").test(heredoc.body);
			if (names.some(spelled)) return false;
		}
		const first = command.words[0];
		if (first === undefined) continue;
		const name = staticWordValue(first, lookup);
		if (name === null) return false;
		const program = path.basename(name);
		if (UNPINNED_COMMANDS.has(program)) return false;
		const args = command.words.slice(1).map((word) => staticWordValue(word, lookup));
		if (program === "printf" && args.some((arg) => arg === null || arg.startsWith("-v"))) return false;
		// `cp -s` plants links as `ln -s` does.
		if (program === "cp" && args.some((arg) => arg === null || /^-[^-]*s|^--symbolic-link$/u.test(arg))) return false;
	}
	return true;
}

/** A statement that does nothing but assign: plain assignments, or `export` of assignment words. */
interface PinStatement {
	assignments: Array<{ name: string; value: ShellWord }>;
	/** Plain assignments holding a substitution exit with its status, so an `&&` after one may skip what follows. */
	canFail: boolean;
}

function pinStatement(pipeline: ShellPipeline): PinStatement | null {
	const command = pipeline.commands[0];
	if (pipeline.negated || pipeline.commands.length !== 1 || command === undefined || command.redirects.length > 0)
		return null;
	if (command.words.length === 0) {
		if (command.assignments.some((assignment) => assignment.append)) return null;
		return {
			assignments: command.assignments.map(({ name, value }) => ({ name, value })),
			canFail: command.assignments.some((assignment) => assignment.value.parts.some((part) => part.kind === "command")),
		};
	}
	const [head, ...rest] = command.words;
	if (command.assignments.length > 0 || head === undefined || rest.length === 0 || staticWordValue(head) !== "export")
		return null;
	const assignments: PinStatement["assignments"] = [];
	for (const word of rest) {
		const first = word.parts[0];
		const named = first?.kind === "literal" && !first.quoted ? /^([A-Za-z_]\w*)=/u.exec(first.text) : null;
		if (first?.kind !== "literal" || named === null || named[1] === undefined) return null;
		const tail = first.text.slice(named[0].length);
		const parts: ShellWordPart[] = [
			...(tail === "" ? [] : [{ kind: "literal" as const, text: tail, quoted: false }]),
			...word.parts.slice(1),
		];
		assignments.push({ name: named[1], value: { parts, start: word.start + named[0].length, end: word.end } });
	}
	return { assignments, canFail: false };
}

/**
 * The exact `$(mktemp -d [-t] [TEMPLATE])` form: it prints a directory it just created, or nothing when it fails. Its
 * words may expand only fixed pins and TMPDIR.
 */
function mktempPin(script: string, pins: ReadonlyMap<string, PinValue>, temp: PinTemp): PinValue | null {
	const parsed = parseShellScript(script, 1);
	const item = parsed?.items.length === 1 ? parsed.items[0] : undefined;
	const pipeline = item !== undefined && !item.background ? item.andOr.pipelines : [];
	const command = pipeline.length === 1 && pipeline[0]?.commands.length === 1 ? pipeline[0].commands[0] : undefined;
	if (command === undefined || pipeline[0]?.negated || command.assignments.length > 0 || command.redirects.length > 0)
		return null;
	const lookup = (name: string): string | undefined => {
		const pin = pins.get(name);
		if (pin !== undefined) return pin.fresh === pin.failed ? pin.fresh : undefined;
		return name === "TMPDIR" && temp.param !== null ? temp.param : undefined;
	};
	const words = command.words.map((word) => staticWordValue(word, lookup));
	if (words.some((word) => word === null)) return null;
	const [program, flag, ...rest] = words as string[];
	if (program !== "mktemp" || flag !== "-d") return null;
	const relative = rest[0] === "-t";
	const operands = relative ? rest.slice(1) : rest;
	const template = operands[0];
	if (operands.length > 1 || (relative && template === undefined)) return null;
	if (template === undefined) return temp.dir === null ? null : { fresh: `${temp.dir}/tmp.XXXXXXXXXX`, failed: "" };
	if (!PIN_PLAIN.test(template) || template.startsWith("-") || !/X{3,}$/u.test(template)) return null;
	if (!relative) return { fresh: template, failed: "" };
	return temp.dir === null || template.includes("/") ? null : { fresh: `${temp.dir}/${template}`, failed: "" };
}

/**
 * The value an assignment word pins, or null when the text does not fix it: its pieces are plain text, earlier pins,
 * TMPDIR, a leading `~` (the home directory) and other plain references, kept as `${NAME}`; or the whole word is the
 * exact mktemp form. A name its own statement assigns is refused: `export A=1 B=$A` expands `$A` before A changes,
 * `A=1 B=$A` after.
 */
function pinWordValue(
	word: ShellWord,
	pins: ReadonlyMap<string, PinValue>,
	statement: ReadonlySet<string>,
	temp: PinTemp,
): { value: PinValue; mktemp: boolean } | null {
	const [only] = word.parts;
	if (word.parts.length === 1 && only?.kind === "command") {
		const made = mktempPin(only.script, pins, temp);
		return made === null ? null : { value: made, mktemp: true };
	}
	let fresh = "";
	let failed = "";
	const add = (pin: PinValue) => {
		fresh += pin.fresh;
		failed += pin.failed;
	};
	const reference = (name: string): PinValue | null => {
		if (statement.has(name)) return null;
		const pin = pins.get(name);
		if (pin !== undefined) return pin;
		if (name === "TMPDIR" && temp.param !== null) return { fresh: temp.param, failed: temp.param };
		return /^[A-Za-z_]\w*$/u.test(name) ? { fresh: `\${${name}}`, failed: `\${${name}}` } : null;
	};
	for (const [index, part] of word.parts.entries()) {
		if (part.kind === "param") {
			const pin = reference(part.name);
			if (pin === null) return null;
			add(pin);
			continue;
		}
		if (part.kind !== "literal") return null;
		let text = part.text;
		if (!part.quoted && index === 0 && (text.startsWith("~/") || (text === "~" && word.parts.length === 1))) {
			const home = reference("HOME");
			if (home === null) return null;
			add(home);
			text = text.slice(1);
		}
		if (!PIN_PLAIN.test(text)) return null;
		add({ fresh: text, failed: text });
	}
	const tidy = { fresh: tidyPinValue(fresh), failed: tidyPinValue(failed) };
	if (tidy.fresh === null || tidy.failed === null) return null;
	return PIN_VALUE.test(tidy.fresh) && PIN_VALUE.test(tidy.failed)
		? { value: { fresh: tidy.fresh, failed: tidy.failed }, mktemp: false }
		: null;
}

/**
 * A value led by an unresolved reference, with the empty and `.` segments after it dropped and `x/..` folded, so it
 * spells a tree the way the judgment's textual spellings do (`${HOME}/` is `${HOME}`, `${HOME}/./.x` is `${HOME}/.x`);
 * null when a `..` climbs above the reference, which no spelling places. Any other value is returned as it is.
 */
function tidyPinValue(value: string): string | null {
	const reference = /^\$\{\w+\}/u.exec(value)?.[0];
	if (reference === undefined) return value;
	const rest = value.slice(reference.length);
	if (rest !== "" && !rest.startsWith("/")) return value;
	const segments: string[] = [];
	for (const segment of rest.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment !== "..") segments.push(segment);
		else if (segments.pop() === undefined) return null;
	}
	return reference + segments.map((segment) => `/${segment}`).join("");
}

/**
 * What a `~` reads as under a pinned HOME. A value that is HOME itself or below it keeps the tilde (`~` + the rest),
 * which every placement expands to the home directory; `${HOME}` in its place is a name a cd base never resolves.
 */
function tildePin(home: PinValue): PinValue {
	const reference = `\${HOME}`;
	const keep = (value: string) =>
		value === reference || value.startsWith(`${reference}/`) ? `~${value.slice(reference.length)}` : value;
	return { fresh: keep(home.fresh), failed: keep(home.failed) };
}

/** The session's TMPDIR: unset or empty, `$TMPDIR` expands empty and mktemp uses /tmp; anything but a plain absolute path is not read. */
function pinTempDir(): PinTemp {
	const value = process.env.TMPDIR?.replace(/(.)\/+$/u, "$1") ?? "";
	if (value === "") return { param: "", dir: "/tmp" };
	return value.startsWith("/") && PIN_PLAIN.test(value) ? { param: value, dir: value } : { param: null, dir: null };
}

interface ReadPins {
	pins: Map<string, PinValue>;
	/** The offset where the commands the pins apply to start. */
	rest: number;
	/** The mktemp's statement heads an `&&` chain that ends the command, so nothing after it runs when it fails. */
	guarded: boolean;
}

function readPins(command: string, script: ShellScript): ReadPins | null {
	// bash imports IFS from the environment, so a value from there may split any unquoted reference.
	if (process.env.IFS !== undefined) return null;
	const temp = pinTempDir();
	const pins = new Map<string, PinValue>();
	let mktemps = 0;
	let rest: { item: number; pipeline: number } | null = null;
	let conditional: number | null = null;
	let made: { item: number; pipeline: number; canFail: boolean } | null = null;
	outer: for (const [itemIndex, item] of script.items.entries()) {
		if (item.background) {
			rest = { item: itemIndex, pipeline: 0 };
			break;
		}
		const { pipelines, ops } = item.andOr;
		for (const [index, pipeline] of pipelines.entries()) {
			const statement = pinStatement(pipeline);
			const names = new Set(statement?.assignments.map(({ name }) => name));
			const resolved: Array<[string, PinValue]> = [];
			let mktemp = 0;
			for (const { name, value } of statement?.assignments ?? []) {
				if (UNPINNABLE_NAME.test(name)) break;
				if (pins.has(name)) return null;
				const read = pinWordValue(value, pins, names, temp);
				if (read === null) break;
				if (read.mktemp) mktemp += 1;
				resolved.push([name, read.value]);
			}
			if (statement === null || resolved.length !== statement.assignments.length) {
				rest = { item: itemIndex, pipeline: index };
				break outer;
			}
			if (names.size !== resolved.length || (index > 0 && ops[index - 1] === "||")) return null;
			// After `&&` behind a statement that can fail, this one may never run while later statements do.
			if (index > 0 && pipelines.slice(0, index).some((earlier) => pinStatement(earlier)?.canFail))
				conditional = itemIndex;
			mktemps += mktemp;
			if (mktemp > 0) made = { item: itemIndex, pipeline: index, canFail: statement.canFail };
			for (const [name, value] of resolved) pins.set(name, value);
		}
	}
	if (pins.size === 0 || mktemps > 1) return null;
	if (conditional !== null) {
		const chain = script.items[conditional]?.andOr;
		if (conditional !== script.items.length - 1 || chain?.ops.some((op) => op !== "&&")) return null;
	}
	const chain = made === null ? undefined : script.items[made.item]?.andOr;
	const guarded =
		made?.canFail === true &&
		made.item === script.items.length - 1 &&
		chain !== undefined &&
		made.pipeline < chain.pipelines.length - 1 &&
		chain.ops.slice(made.pipeline).every((op) => op === "&&");
	if (rest === null) return { pins, rest: command.length, guarded };
	const first = script.items[rest.item]?.andOr.pipelines[rest.pipeline]?.commands[0];
	if (first === undefined) return null;
	const commands = scriptCommands(script, first.start);
	return commands !== null && pinsHold(commands, pins) ? { pins, rest: first.start, guarded } : null;
}

/** The text with each parsed reference to a pin, and each `~` a pinned HOME moves, replaced by one reading's value. */
function renderPins(
	text: string,
	script: ShellScript,
	from: number,
	pins: ReadonlyMap<string, PinValue>,
	guarded: boolean,
): string[] {
	const pinned = pins.get("HOME");
	const home = pinned === undefined ? undefined : tildePin(pinned);
	const edits: Array<{ start: number; end: number; pin: PinValue }> = [];
	for (const item of script.items) {
		for (const pipeline of item.andOr.pipelines) {
			for (const command of pipeline.commands) {
				for (const word of commandWords(command)) {
					if (word.start < from) continue;
					const first = word.parts[0];
					if (
						home !== undefined &&
						first?.kind === "literal" &&
						!first.quoted &&
						(first.text.startsWith("~/") || (first.text === "~" && word.parts.length === 1))
					)
						edits.push({ start: word.start, end: word.start + 1, pin: home });
					for (const part of word.parts) {
						const pin = part.kind === "param" ? pins.get(part.name) : undefined;
						if (part.kind === "param" && pin !== undefined) edits.push({ start: part.start, end: part.end, pin });
					}
				}
			}
		}
	}
	edits.sort((a, b) => a.start - b.start);
	const reading = (key: keyof PinValue) => {
		let out = "";
		let at = 0;
		for (const edit of edits) {
			out += text.slice(at, edit.start) + edit.pin[key];
			at = edit.end;
		}
		return out + text.slice(at);
	};
	const failing = !guarded && [...pins.values()].some((pin) => pin.fresh !== pin.failed);
	return failing ? [reading("fresh"), reading("failed")] : [reading("fresh")];
}

/**
 * The pins applied to raw-text candidate text the parser cannot read (the raw-text reading drops quotes, so `node -e
 * "f(1)"` leaves a bare parenthesis). The pins held over the parsed command, so every `$NAME` of a pin in the text is
 * one the shell expands: a reference spelled as data dropped the pins. Values are plain, so none re-tokenizes.
 */
function renderPinsInText(text: string, pins: ReadonlyMap<string, PinValue>, guarded: boolean): string[] {
	const names = [...pins.keys()].join("|");
	const tilde = pins.has("HOME") ? String.raw`|(?<=^|[\s;&|<>])~(?=\/|$|[\s;&|<>])` : "";
	const pattern = new RegExp(String.raw`\$\{(${names})\}|\$(${names})(?![A-Za-z0-9_])${tilde}`, "gu");
	const home = pins.get("HOME");
	const reading = (key: keyof PinValue) =>
		text.replace(pattern, (_all, braced?: string, bare?: string) => {
			const name = braced ?? bare;
			return name === undefined ? tildePin(home as PinValue)[key] : (pins.get(name) as PinValue)[key];
		});
	const failing = !guarded && [...pins.values()].some((pin) => pin.fresh !== pin.failed);
	return failing ? [reading("fresh"), reading("failed")] : [reading("fresh")];
}

/**
 * The command with each variable its leading statements pin replaced by what it holds, so a write into a scratch
 * home is judged by the path it lands on rather than by a variable's name (CLI-H4, M-1). PanCode's own trees are the
 * operator's real directories the engine captured at session start; a `HOME` or `PANCODE_*` value the command
 * assigns never adds to them, so `H=$(mktemp -d "$TMPDIR/h.XXXX"); export HOME=$H/home PANCODE_HOME=$H/pancode`
 * makes `$PANCODE_HOME/state` and `~/.config` scratch paths.
 *
 * It reads the parsed command (shell-syntax.ts). A pin is a leading statement that only assigns, each name once, a
 * value of plain path characters, earlier pins, TMPDIR and a leading `~`, after at most one leading reference to HOME
 * or a PanCode variable it cannot resolve (kept as `${NAME}`, so `X=$PANCODE_STATE_DIR; echo x > $X/f` still names
 * PanCode's tree), or the exact `$(mktemp -d ...)` form, read as its template and as empty for the run where it fails;
 * at most one mktemp, an `&&` behind it only when nothing after the chain runs, and no failure reading when that
 * chain guards everything after it. A reference is a parsed parameter expansion, replaced at the offsets the parser
 * gives, so a value never re-tokenizes the command. The pins hold only while what follows never assigns a pin or
 * IFS, spells a pin's reference as data, holds an expansion the parser does not read, runs text as code with other
 * variables (`sh -c`, `env`, `eval`, `trap`) or sets a variable unseen (`read`, `printf -v`, `unset`, `export`),
 * an escaped or quoted spelling of any included, or plants a link. Anything else, and any command outside the
 * grammar, leaves the command unchanged, where a PanCode variable's name keeps reading as PanCode's own tree.
 */
export function pinnedPancodeCommand(command: string): PancodePins {
	// A raw-text candidate is not the command: it gets the command's pins, never pins of its own.
	const unchanged: PancodePins = { readings: [command], apply: (text) => [text] };
	const script = parseShellScript(command);
	const read = script === null ? null : readPins(command, script);
	if (script === null || read === null) return unchanged;
	return {
		readings: renderPins(command, script, read.rest, read.pins, read.guarded),
		apply: (text) => {
			const parsed = parseShellScript(text);
			return parsed === null
				? renderPinsInText(text, read.pins, read.guarded)
				: renderPins(text, parsed, 0, read.pins, read.guarded);
		},
	};
}
