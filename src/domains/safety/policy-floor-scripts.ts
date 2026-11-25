// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { bashSearchPath } from "../../core/bash-exec.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { ToolNames } from "../../core/tool-names.js";
import { expandPath } from "../../tools/path-utils.js";
import type { RunScriptInterpreter } from "../../tools/run-script.js";
import type { ClassifierCall } from "./action-classifier.js";
import { extractCommandWriteTargets, shellCommandSteps } from "./command-path-walks.js";
import { downloadedFiles, unpackedTargets } from "./command-readings.js";
import type { DamageControlMatch } from "./damage-control.js";
import { commandArg } from "./policy-call-args.js";
import type { SafetyPolicyDecision, SafetyPolicySource } from "./policy-engine.js";
import type { ScriptLine, ScriptNames, ScriptReader, ScriptShell } from "./script-shell.js";
import {
	advanceScriptShell,
	childScriptShell,
	forkScriptShell,
	newScriptReader,
	newScriptShell,
	readScriptLine,
} from "./script-shell.js";
import type { ScriptSource } from "./shell-segments.js";
import { hasUnparsedShellScript, scriptLineSources, shellScriptSources } from "./shell-segments.js";
import { YOLO_FLOOR_REASON_PREFIX, yoloFloorShellScript } from "./yolo-floor.js";

/** Why the floor reads a line as raw text. */
export const RAW_TEXT_REASON = "a line holding a command substitution is also read as raw text, quotes dropped";

/** Most of a script the floor reads before the call runs (#419, #407). */
const FLOOR_SCRIPT_SCAN_BYTES = 256 * 1024;

export interface ScriptHit {
	file: string;
	line: number;
	text: string;
	match: DamageControlMatch;
	source: SafetyPolicySource;
}

/** True for run_script and for a bash command that hands a shell a script file it names (#419). */
export function runsScriptFile(call: ClassifierCall): boolean {
	if (call.tool === ToolNames.RunScript) return true;
	if (call.tool !== ToolNames.Bash) return false;
	const command = commandArg(call.args);
	return command !== null && hasUnparsedShellScript(command) && shellScriptSources(command).sources.length > 0;
}

/** The `RUN_SCRIPT_INTERPRETERS` entries that read their script as shell source (#421). */
const RUN_SCRIPT_SHELLS: ReadonlySet<string> = new Set<RunScriptInterpreter>(["bash", "sh"]);

/** True when run_script hands its script to a shell, the only interpreter whose lines the floor scan can read. */
export function runsUnderShell(args: Record<string, unknown> | undefined): boolean {
	const interpreter = args?.interpreter;
	return typeof interpreter === "string" && RUN_SCRIPT_SHELLS.has(interpreter.trim());
}

/** Why yolo refuses a command when `safety.sandbox` is `required` and the host has no backend. */
export const YOLO_SANDBOX_REFUSED =
	'safety.sandbox is "required" and no OS sandbox is available, so yolo does not run this command; use a typed tool, or have the operator set safety.sandbox to auto';

/** Why yolo refuses an outward line it would have run inside, when `safety.sandbox` is `required` and the host has no backend. */
export const YOLO_SANDBOX_REFUSED_OUTWARD =
	'safety.sandbox is "required" and no OS sandbox is available, so yolo does not run this command; an outward command runs only alone on its line, with literal arguments and only the options its CLI is allowed, from the workspace repository';

/** Why yolo refuses `unsandboxed: true` when `safety.sandbox` is `required`. */
export const YOLO_SANDBOX_NOT_LEFT =
	'safety.sandbox is "required", so yolo does not run this command outside the sandbox; drop unsandboxed: true, or have the operator set safety.sandbox to auto';

/** Rule id of that refusal, a ceiling the operator set (#407). */
export const YOLO_SANDBOX_REQUIRED_RULE_ID = "yolo-sandbox-required";

/** Reason code prefix of a call yolo admitted past a rail that would have asked or blocked (#407). */
export const YOLO_ADMITTED_REASON_PREFIX = "yolo-admitted:";

/**
 * Net blocks that hold at yolo besides the floor and operator rules: the
 * run's write-root ceiling, a call that cannot run as given, and an approved
 * project policy that no longer parses, whose operator rules cannot be read.
 */
const YOLO_HELD_RULE_IDS: ReadonlySet<string> = new Set([
	"write-root",
	"bash-empty-command",
	"oversized-path",
	"verify-cwd-invalid",
	"project-policy-invalid",
	YOLO_SANDBOX_REQUIRED_RULE_ID,
]);

/** True for a block the true-yolo evaluation keeps (#407). */
export function holdsAtYolo(decision: SafetyPolicyDecision): boolean {
	if (decision.kind !== "block") return false;
	if (decision.ruleId !== undefined && YOLO_HELD_RULE_IDS.has(decision.ruleId)) return true;
	return decision.reasonCode.startsWith(YOLO_FLOOR_REASON_PREFIX) || decision.reasonCode.startsWith("operator-rule:");
}

/** A script operand as the shell resolves it; a name it expands at run time stays unplaceable. */
export function scriptPath(operand: string, callCwd: string): string | null {
	if (/[$`*?[{]/u.test(operand)) return null;
	const expanded = operand === "~" || operand.startsWith("~/") ? expandPath(operand) : operand;
	return path.resolve(callCwd, expanded);
}

/** Most levels of `source`, `bash` or `exec` a scan follows below the script the command names. */
const FLOOR_SCRIPT_NEST_DEPTH = 3;

/** Bytes left for one command's scripts, shared by every file the scan follows. */
export interface ScriptBudget {
	remaining: number;
	/** Set when a sourced name with no slash was looked up while the bash tool's PATH was still being captured. */
	pathPending: boolean;
	/** The scripts the call runs that the scan could not place or read, each with why and where it is run. */
	unplaced: UnplacedChild[];
}

/** One script the scan could not place or read: its operand or path as written, and why and where it runs. */
interface UnplacedChild {
	name: string;
	note: string;
}

export function newScriptBudget(): ScriptBudget {
	return { remaining: FLOOR_SCRIPT_SCAN_BYTES, pathPending: false, unplaced: [] };
}

/** Rule id of a call the floor could not finish reading because a script it runs cannot be placed or read (row 215). */
export const SCRIPT_UNPLACEABLE_RULE_ID = "script-unplaceable";

/** Most unplaced scripts the reason names before it counts the rest. */
const SCRIPT_UNPLACEABLE_NAMED = 3;

/** The safety judge's longest finding line; the reason fits it, so the judge never sees it cut without a mark. */
const SCRIPT_UNPLACEABLE_REASON_CHARS = 400;

const SCRIPT_UNPLACEABLE_LEAD = "the floor could not place or read a script this call runs, so the judge decides it: ";

/**
 * Text on one line in at most `max` characters. A longer one keeps its head and its tail around a marker naming how
 * many characters were cut, so neither end of an operand is hidden and the judge sees the cut (row 215).
 */
function elided(text: string, max: number): string {
	const folded = text.replace(/\s+/gu, " ");
	if (folded.length <= max) return folded;
	const marker = (cut: number) => `...<${cut} chars>...`;
	const keep = Math.max(0, max - marker(folded.length).length);
	const head = Math.ceil(keep / 2);
	return `${folded.slice(0, head)}${marker(folded.length - keep)}${folded.slice(folded.length - (keep - head))}`;
}

export function scriptUnplaceableReason(unplaced: ReadonlyArray<UnplacedChild>): string {
	const children = [...new Map(unplaced.map((child) => [`${child.name}\n${child.note}`, child])).values()];
	const shown = children.slice(0, SCRIPT_UNPLACEABLE_NAMED);
	const more =
		children.length > SCRIPT_UNPLACEABLE_NAMED ? `; and ${children.length - SCRIPT_UNPLACEABLE_NAMED} more` : "";
	// Each named child gets an equal share of the finding, less the `; ` between them; its name comes first.
	const room =
		Math.floor((SCRIPT_UNPLACEABLE_REASON_CHARS - SCRIPT_UNPLACEABLE_LEAD.length - more.length) / shown.length) - 2;
	const entries = shown.map((child) => {
		if (child.note === "") return elided(child.name, room);
		const name = elided(child.name, room - Math.min(child.note.length, Math.ceil(room / 2)) - 1);
		return `${name} ${elided(child.note, room - name.length - 1)}`;
	});
	return `${SCRIPT_UNPLACEABLE_LEAD}${entries.join("; ")}${more}`;
}

/** True for an operand the shell names at run time: a variable, substitution, glob, process substitution or `~-`/`~user`. */
function runTimeName(operand: string): boolean {
	return (
		/[$`*?[{]/u.test(operand) ||
		/^[<>]\(/u.test(operand) ||
		(operand.startsWith("~") && operand !== "~" && !operand.startsWith("~/"))
	);
}

/**
 * True when a command may set HOME before a script it names runs, so a leading `~` or `$HOME` there may not be the
 * operator's home (row 215): it names HOME other than to read it (`HOME=`, `HOME+=`, `unset HOME`, `read HOME`,
 * `for HOME in`, `${HOME:=x}`), with quotes or not, or runs eval, or hands a builtin that assigns a name it builds.
 */
export function commandMayChangeHome(command: string): boolean {
	const unquoted = command.replace(/["'\\]/gu, "");
	if (/HOME/u.test(unquoted.replace(/\$(?:HOME(?!\w)|\{HOME\})/gu, ""))) return true;
	return shellCommandSteps(command).some((step) => {
		if (step.executable === "eval") return true;
		if (/^(?:declare|typeset|local|export|readonly|let)$/u.test(step.executable))
			return step.args.some((arg) => !arg.startsWith("-") && !/^[A-Za-z_]\w*(?:\+?=|$)/u.test(arg));
		if (/^(?:read|mapfile|readarray|unset|getopts)$/u.test(step.executable))
			return step.args.some((arg) => arg.includes("$") || arg.includes("`"));
		return step.executable === "printf" && step.args.some((arg) => arg.startsWith("-v"));
	});
}

/** True for an operand that starts with the home directory: `~` or `~/`, as the parse writes a placed `$HOME` too. */
function homeOperand(operand: string): boolean {
	return operand === "~" || operand.startsWith("~/");
}

/** Why and where the scan could not place a script operand: a name the shell builds at run time, or a relative name from an unknown directory. */
function unplacedNote(operand: string, where: string): string {
	return `(${runTimeName(operand) ? "named at run time" : "directory unknown"}), ${where}`;
}

/** Records a script the scan could not place or read; the reason names each once. */
export function recordUnplaced(budget: ScriptBudget, name: string, note = ""): void {
	budget.unplaced.push({ name, note });
}

/** Rule id of a call the floor could not place because a bare `source name` waits on the login capture. */
export const LOGIN_PATH_PENDING_RULE_ID = "login-path-pending";

export const LOGIN_PATH_PENDING_REASON =
	"the login environment bash commands run with is still being captured, so which file a bare `source name` loads is unknown; the call is judged instead of resolved on the PATH PanCode was launched with";

/** What unconfined yolo, which has no judge, adds to that reason. */
export const LOGIN_PATH_PENDING_YOLO_HOLD =
	"yolo holds it until the capture settles, which happens once per session; run it again in a moment";

/** The floor a script line meets, judged from `callCwd` where the scan lost the line's own directory. */
type FloorLine = (
	raw: string,
	read: ScriptLine,
	callCwd: string,
) => { match: DamageControlMatch; source: SafetyPolicySource } | null;

/** One scan's shared state: the floor it applies, the call it serves and its byte budget. */
interface ScriptScan {
	floorLine: FloorLine;
	callCwd: string;
	budget: ScriptBudget;
	/** Files earlier lines write or download, which a later line's script may not be read from. */
	written: WrittenPaths;
}

/** Files and trees a command or the script lines so far write before a later script runs. */
interface WrittenPaths {
	files: Set<string>;
	trees: Set<string>;
}

export function newWrittenPaths(): WrittenPaths {
	return { files: new Set(), trees: new Set() };
}

function isWrittenFirst(file: string, written: WrittenPaths): boolean {
	return written.files.has(file) || [...written.trees].some((tree) => isSameOrDescendant(file, tree));
}

function copyWrittenPaths(written: WrittenPaths): WrittenPaths {
	return { files: new Set(written.files), trees: new Set(written.trees) };
}

/** The nearest directory at or above `dir` that holds `.git`, else `dir`. */
function gitWorkTree(dir: string): string {
	for (let current = dir; ; current = path.dirname(current)) {
		try {
			if (statSync(path.join(current, ".git"), { throwIfNoEntry: false }) !== undefined) return current;
		} catch {
			// An unreadable level cannot hold the marker for us; keep walking up.
		}
		if (path.dirname(current) === current) return dir;
	}
}

/**
 * A script a bash command runs through a shell, scanned against the floor
 * from where the command leaves it (#407). A name the shell builds at run time
 * (a variable, a command or process substitution), a file the same command
 * writes or downloads first, and anything but a regular file run unread.
 */
export function scanCommandScript(
	script: ScriptSource,
	floorLine: FloorLine,
	callCwd: string,
	cwds: string[] | null,
	written: WrittenPaths,
	budget: ScriptBudget,
	shellOnly = false,
	homeKnown = true,
): ScriptHit | null {
	const operand = script.path;
	const where = script.sourced ? "sourced by the command" : "run by the command";
	// A program run by its own path may be any binary, so a name the scan cannot place keeps today's rails; a sourced
	// name or one handed to a shell is a script, and the judge decides it (row 215).
	const unplaced = (name = operand, note = unplacedNote(operand, where)) => {
		if (!shellOnly) recordUnplaced(budget, name, note);
		return null;
	};
	// A home the command may move first is not the operator's (row 215).
	if (!homeKnown && homeOperand(operand)) return unplaced(operand, `(HOME may change before it runs), ${where}`);
	const candidates = scriptCandidates(operand, cwds, budget, script.sourced);
	if (candidates.includes(null)) return unplaced();
	// Each candidate is skipped on its own: rewriting one copy leaves another that bash may load (CLI-P31).
	const files = (candidates as string[]).filter((file) => {
		if (isWrittenFirst(file, written)) return false;
		const kind = pathKind(file);
		if (kind === "unreachable") unplaced(file, `(unreadable), ${where}`);
		return kind === "file";
	});
	// `bash x.sh` runs with `$0` as written; on standard input `$0` names the shell.
	const name = homeOperand(operand) ? expandPath(operand) : operand;
	const names: ScriptNames = script.stdin ? { zero: null, source: null } : { zero: name, source: name };
	for (const file of files) {
		// A program run by path is read only when it is shell source; a binary or another interpreter is not (CLI-P31).
		if (shellOnly && yoloFloorShellScript(file) !== true) continue;
		const scan = scanNamedScript(file, floorLine, callCwd, cwds, budget, names, homeKnown);
		if (scan !== null) return scan;
	}
	return null;
}

/**
 * Adds the files a command writes or downloads, and the trees it extracts,
 * clones, checks out or copies into, placed from every directory it may run
 * in, to `into`.
 */
export function commandWrittenPaths(command: string, cwds: ReadonlyArray<string>, into: WrittenPaths): WrittenPaths {
	const place = (target: string): string[] => {
		const expanded = target === "~" || target.startsWith("~/") ? expandPath(target) : target;
		return (path.isAbsolute(expanded) ? ["/"] : cwds).map((cwd) => path.resolve(cwd, expanded));
	};
	if (command === "") return into;
	for (const target of [...extractCommandWriteTargets(command), ...downloadedFiles(command)]) {
		for (const placed of place(target)) into.files.add(placed);
	}
	for (const target of unpackedTargets(command)) {
		for (const placed of place(target.path)) into.trees.add(target.scope === "repository" ? gitWorkTree(placed) : placed);
	}
	return into;
}

/** Scans a script the command or `run_script` names against the floor, starting in `cwds`. */
export function scanNamedScript(
	file: string | null,
	floorLine: FloorLine,
	callCwd: string,
	cwds: string[] | null,
	budget: ScriptBudget,
	names: ScriptNames,
	homeKnown = true,
): ScriptHit | null {
	const scan: ScriptScan = { floorLine, callCwd, budget, written: newWrittenPaths() };
	const shell = newScriptShell(cwds);
	// A HOME the command may set first is not known inside the script either (row 215).
	if (!homeKnown) shell.vars.delete("HOME");
	return scanScript(file, scan, shell, newScriptReader("plain", names));
}

/**
 * The first line of a script the floor refuses (#407). Each line is judged
 * from every directory the script can be in by then, with the literal
 * variables assigned before it substituted, and the scan follows the scripts
 * its lines `source`, run through a shell or `exec` by literal path. What the
 * scan cannot follow (a binary file, a script written first, a nesting deeper
 * than the limit) is skipped, and what it cannot place or read (a name built
 * at run time, a relative name from an unknown directory, an unreadable file,
 * one over the byte budget) is recorded on the budget for the safety judge;
 * neither stops the scan, so a script nothing on the floor touches runs.
 * Backslash continuations join before matching.
 */
function scanScript(
	file: string | null,
	scan: ScriptScan,
	shell: ScriptShell,
	reader: ScriptReader,
	depth = 0,
): ScriptHit | null {
	if (file === null) return null;
	let text: string;
	try {
		const info = statSync(file);
		if (!info.isFile()) return null;
		// A binary `exec` target is a program, not a script to read, and costs none of the budget.
		if (info.size > scan.budget.remaining) {
			if (!binaryHead(file))
				recordUnplaced(scan.budget, file, `(past the floor's ${FLOOR_SCRIPT_SCAN_BYTES}-byte script budget)`);
			return null;
		}
		text = readFileSync(file, "utf8");
		if (text.includes("\0")) return null;
		scan.budget.remaining -= info.size;
	} catch (error) {
		// A missing script fails to run; one the scan cannot read is judged instead of run unread (row 215).
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") recordUnplaced(scan.budget, file, "(unreadable)");
		return null;
	}
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const start = index;
		let logical = lines[index] ?? "";
		while (logical.endsWith("\\") && index + 1 < lines.length) {
			index += 1;
			logical = `${logical.slice(0, -1)} ${lines[index] ?? ""}`;
		}
		const at = { file, line: start + 1, text: logical.trim() };
		const read = readScriptLine(reader, shell, logical);
		const verdict = scan.floorLine(logical, read, scan.callCwd);
		if (verdict !== null) return { ...at, ...verdict };
		if (read.data) continue;
		// A line the scan cannot follow (a loop cd, eval, a name reference, a HOME or CDPATH assignment) leaves the
		// script's directory and its variables unknown, so a later relative child or one built from a variable, HOME
		// included, is judged instead of placed from a stale value (row 215).
		if (advanceScriptShell(reader, shell, logical, read) !== null) {
			shell.cwds = null;
			shell.vars.clear();
		}
		const lineRuns = scriptLineSources(read.expanded);
		const where = `in ${file} line ${start + 1}`;
		if (lineRuns.unnamed) recordUnplaced(scan.budget, "a script the line runs without naming it", where);
		const cwds = read.context === "function" ? null : shell.cwds;
		commandWrittenPaths(read.expanded, cwds ?? [scan.callCwd], scan.written);
		for (const source of lineRuns.sources) {
			// A program `exec` runs by its own path may be any binary: one the scan cannot place keeps today's rails, and
			// only shell source is read (row 215, CLI-P31).
			if (depth >= FLOOR_SCRIPT_NEST_DEPTH) {
				if (!source.program)
					recordUnplaced(scan.budget, source.path, `(nested past ${FLOOR_SCRIPT_NEST_DEPTH} levels), ${where}`);
				continue;
			}
			// Every candidate is scanned for a refusal from its own copy of the shell and of the writes so far; bash
			// loads the first one not written first, so the script continues from that copy alone (CLI-P31).
			let loaded: { shell: ScriptShell; written: WrittenPaths } | null = null;
			const homeLost = !shell.vars.has("HOME") && homeOperand(source.path);
			const candidates = homeLost ? [null] : scriptCandidates(source.path, cwds, scan.budget, source.sourced);
			for (const candidate of candidates) {
				if (candidate === null) {
					if (!source.program) {
						const note = homeLost ? `(HOME unknown here), ${where}` : unplacedNote(source.path, where);
						recordUnplaced(scan.budget, source.path, note);
					}
					continue;
				}
				if (isWrittenFirst(candidate, scan.written)) continue;
				const kind = pathKind(candidate);
				if (kind === "unreachable" && !source.program) recordUnplaced(scan.budget, candidate, `(unreadable), ${where}`);
				if (kind !== "file" || (source.program && yoloFloorShellScript(candidate) !== true)) continue;
				const branch: ScriptScan = { ...scan, written: copyWrittenPaths(scan.written) };
				// `source` runs in this shell; `bash`, `sh` and `exec` start a child that changes nothing here.
				// A sourced file keeps the script's `$0`; a child shell gets the name it was run by.
				const names: ScriptNames = source.stdin
					? { zero: null, source: null }
					: source.sourced
						? { zero: reader.names.zero, source: source.path }
						: { zero: source.path, source: source.path };
				const branchShell = source.sourced ? forkScriptShell(shell) : childScriptShell(shell, read.context);
				const branchReader = newScriptReader(source.sourced ? read.context : "plain", names);
				const inner = scanScript(candidate, branch, branchShell, branchReader, depth + 1);
				if (inner !== null) return inner;
				loaded ??= { shell: branchShell, written: branch.written };
			}
			if (loaded === null) continue;
			for (const file of loaded.written.files) scan.written.files.add(file);
			for (const tree of loaded.written.trees) scan.written.trees.add(tree);
			if (source.sourced) Object.assign(shell, loaded.shell);
		}
	}
	return null;
}

/**
 * The files a script operand can name from the directories the shell may be
 * in: the ones that exist, or the first candidate when none does, so its scan
 * reports it. A dynamic name, or a relative one from an unknown directory, is
 * a null candidate. A sourced name with no slash is looked up as bash does, on
 * every directory of the bash tool's PATH in its order and then the directory,
 * and every regular file found is a candidate, the one bash loads first (CLI-P31).
 * While that PATH is still being captured only the directory is searched, and
 * the budget records it.
 */
function scriptCandidates(
	operand: string,
	cwds: ReadonlyArray<string> | null,
	budget: ScriptBudget,
	sourced = false,
): Array<string | null> {
	if (runTimeName(operand)) return [null];
	if (operand === "~" || operand.startsWith("~/") || path.isAbsolute(operand)) return [scriptPath(operand, "/")];
	const local = cwds === null ? [] : [...new Set(cwds.map((cwd) => path.resolve(cwd, operand)))];
	// A name under a directory the stat cannot enter is kept, so its scan records it as unreadable (row 215).
	const exists = (candidate: string) => pathKind(candidate) !== "missing";
	if (sourced && !operand.includes("/")) {
		const dirs = sourceSearchDirs(cwds);
		if (dirs === null) budget.pathPending = true;
		const found = [...new Set([...(dirs ?? []).map((dir) => path.join(dir, operand)), ...local].filter(regularFile))];
		if (found.length > 0) return found;
	}
	if (cwds === null) return [null];
	const existing = local.filter(exists);
	return existing.length > 0 ? existing : local.slice(0, 1);
}

/**
 * The directories `source name` searches, in bash's order: the PATH bash commands run with, alone, so the first hit is
 * the file bash loads; null while the login capture that sets it is pending, never the PATH PanCode was launched with. A
 * relative entry is placed from every directory the shell may be in.
 */
function sourceSearchDirs(cwds: ReadonlyArray<string> | null): string[] | null {
	const searchPath = bashSearchPath();
	if (searchPath === null) return null;
	const dirs = new Set<string>();
	for (const entry of searchPath.split(path.delimiter)) {
		if (path.isAbsolute(entry)) dirs.add(entry);
		else for (const cwd of cwds ?? []) dirs.add(path.resolve(cwd, entry));
	}
	return [...dirs];
}

/** Whether a path is a regular file now; a path the stat cannot reach is not. */
function regularFile(candidate: string): boolean {
	return pathKind(candidate) === "file";
}

/** What a path is now: a regular file, something else, absent, or behind a directory the stat cannot enter. */
function pathKind(candidate: string): "file" | "other" | "missing" | "unreachable" {
	try {
		const info = statSync(candidate, { throwIfNoEntry: false });
		return info === undefined ? "missing" : info.isFile() ? "file" : "other";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOTDIR" ? "missing" : "unreachable";
	}
}

/** True when the first bytes of a file hold a NUL, the mark of a binary program rather than a script. */
function binaryHead(file: string): boolean {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(8192);
		return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).includes(0);
	} finally {
		closeSync(fd);
	}
}
