// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { canonicalizePath, canonicalizeRawPath, createPathWalkMemo } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { storeReplacedBlob, storeWriteSet } from "../../core/store-paths.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "./action-classifier.js";
import type { AutonomyExposure } from "./autonomy.js";
import { autonomyCallInputs } from "./autonomy-inputs.js";
import { describeBashCallConsequences, type PathKind } from "./command-consequence.js";
import { extractCommandPathWalks, type ShellCommandStep, shellCommandSteps } from "./command-path-walks.js";
import { outwardShellReason } from "./containment.js";
import type { SafetyDecision } from "./contract.js";
import { pathPolicyTargets } from "./policy-bash-paths.js";
import { commandArg } from "./policy-call-args.js";
import { bashOperandRoles } from "./policy-operand-roles.js";
import { readScopeSpellings } from "./read-scope.js";
import { asksToLeaveSandbox } from "./sandbox-escape.js";

/** What exists at `path` once resolved against `cwd`; null when it does not, or cannot be read. */
function pathKindIn(cwd: string): (path: string) => PathKind {
	return (path) => {
		try {
			const stat = statSync(resolve(cwd, path));
			return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
		} catch {
			// A path that cannot be statted is not an existing file to overwrite.
			return null;
		}
	};
}

/**
 * The consequence sentences for a bash ask the main agent made, read from the
 * full command and checked against the filesystem it will run in. Card text
 * only: a failure here is no sentence, never a different admission. Every
 * approval surface (the terminal card and the ACP permission request) reads
 * it here so they describe one command the same way.
 */
export function describeMainCallConsequences(call: ClassifierCall): string[] {
	const cwd = typeof call.args?.cwd === "string" && call.args.cwd.length > 0 ? call.args.cwd : process.cwd();
	const described = describeBashCallConsequences(call.tool, call.args, {
		pathKind: pathKindIn(resolve(process.cwd(), cwd)),
		home: homedir,
	});
	if (described.length > 0) return described;
	// A step the sandbox refuses as outward says why, so a card titled outward names what reaches out.
	const outward = shellOutwardReason(call);
	return outward === null ? [] : [outward];
}

/**
 * What a store put replaces, in plain words, when its admission found the blob already there; the
 * judge reads this line instead of the internal marker admission set on the arguments.
 */
export function storeReplaceConsequences(call: ClassifierCall): string[] {
	const replaced = call.tool === ToolNames.Store ? storeReplacedBlob(call.args) : null;
	if (replaced === null) return [];
	return [`this put replaces the existing blob ${replaced.tag}:${replaced.blob} of ${replaced.bytes} bytes`];
}

const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPM_SCRIPT_ALIASES: Readonly<Record<string, string>> = {
	t: "test",
	tst: "test",
	test: "test",
	start: "start",
	stop: "stop",
	restart: "restart",
};

/**
 * The package.json script bodies a shell call runs through npm, pnpm, yarn or
 * bun, one line per script with its pre and post hooks. `npm run release` names
 * a script, not what it does, so the judge reads the body that executes and
 * judges that against the operator's words. Empty when no step runs a script
 * the manifest defines; a manifest that cannot be read says so.
 */
export function projectScriptConsequences(call: ClassifierCall): string[] {
	if (call.tool !== ToolNames.Bash && call.tool !== ToolNames.RunScript) return [];
	const command = call.args?.command;
	if (typeof command !== "string") return [];
	const names: string[] = [];
	for (const step of shellCommandSteps(command)) {
		if (!PACKAGE_RUNNERS.has(step.executable)) continue;
		const words = step.args.filter((word) => !word.startsWith("-"));
		const verb = words[0];
		if (verb === undefined) continue;
		const name =
			verb === "run" || verb === "run-script" ? words[1] : step.executable === "npm" ? NPM_SCRIPT_ALIASES[verb] : verb;
		if (name !== undefined && !names.includes(name)) names.push(name);
	}
	if (names.length === 0) return [];
	const cwd = typeof call.args?.cwd === "string" && call.args.cwd.length > 0 ? call.args.cwd : process.cwd();
	let scripts: Record<string, unknown> | undefined;
	try {
		const manifest = JSON.parse(readFileSync(resolve(process.cwd(), cwd, "package.json"), "utf8")) as {
			scripts?: Record<string, unknown>;
		};
		scripts = manifest.scripts;
	} catch {
		return ["package.json could not be read, so the project script this runs is unknown repository code"];
	}
	const lines: string[] = [];
	for (const name of names.slice(0, 4)) {
		if (typeof scripts?.[name] !== "string") continue;
		const bodies = [`pre${name}`, name, `post${name}`].flatMap((key) =>
			typeof scripts?.[key] === "string" ? [`${key}: ${scripts[key]}`] : [],
		);
		lines.push(`runs package.json script "${name}", repository data that executes as written: ${bodies.join("; ")}`);
	}
	return lines;
}

/** A script file a call runs, as the safety judge reads it: the canonical path, its size and its head. */
export interface ScriptFileRun {
	path: string;
	bytes: number;
	head: string;
}

/** Commands whose first operand is a script file they execute. */
const SCRIPT_INTERPRETERS: ReadonlySet<string> = new Set([
	"node",
	"bash",
	"sh",
	"zsh",
	"dash",
	"python",
	"python3",
	"deno",
	"bun",
	"tsx",
	"perl",
	"ruby",
]);
/** Flags after which an interpreter runs inline code or a module, not a file. */
const INLINE_FLAGS: ReadonlySet<string> = new Set(["-c", "-e", "-p", "-m", "--eval", "--print"]);
/** How much of a script the judge reads, and the largest script it opens. */
export const SCRIPT_HEAD_BYTES = 4096;
const SCRIPT_MAX_BYTES = 1024 * 1024;
const SCRIPTS_READ = 2;

/**
 * The script file one shell step executes, as spelled: the command word when it names a file by path, or
 * an interpreter's first operand (`node probe.mjs`, `bun run x.ts`). Undefined for any other step, an
 * inline `-c` script included.
 */
export function stepScriptOperand(step: ShellCommandStep): string | undefined {
	if (step.commandPath !== undefined) return step.commandPath;
	if (!SCRIPT_INTERPRETERS.has(basename(step.executable))) return undefined;
	if (step.args.some((word) => INLINE_FLAGS.has(word))) return undefined;
	const operands = step.args.filter((word) => !word.startsWith("-"));
	return operands[0] === "run" ? operands[1] : operands[0];
}

/**
 * The script files a bash or run_script call executes, read where they lie inside `roots` (the workspace and
 * scratch roots), so approving a directory of scripts is not approving an unread file (M-5). A file outside them,
 * a link out of them, a binary or an inline `-c` script is not read. Each head is raw: the reader redacts it.
 */
export function scriptFilesRun(call: ClassifierCall, roots: ReadonlyArray<string>): ScriptFileRun[] {
	const cwd = resolve(process.cwd(), typeof call.args?.cwd === "string" ? call.args.cwd : ".");
	const spelled: string[] = [];
	if (call.tool === ToolNames.RunScript && typeof call.args?.script === "string") spelled.push(call.args.script);
	else if (call.tool === ToolNames.Bash && typeof call.args?.command === "string") {
		for (const step of shellCommandSteps(call.args.command)) {
			const operand = stepScriptOperand(step);
			if (operand !== undefined) spelled.push(operand);
		}
	}
	const found: ScriptFileRun[] = [];
	for (const raw of spelled) {
		if (found.length >= SCRIPTS_READ) break;
		const file = canonicalizePath(resolve(cwd, raw));
		if (file === null || found.some((script) => script.path === file)) continue;
		if (!roots.some((root) => isSameOrDescendant(file, root))) continue;
		try {
			const stat = statSync(file);
			if (!stat.isFile() || stat.size > SCRIPT_MAX_BYTES) continue;
			const bytes = readFileSync(file);
			const head = bytes.subarray(0, SCRIPT_HEAD_BYTES);
			if (head.includes(0)) continue;
			found.push({ path: file, bytes: stat.size, head: head.toString("utf8") });
		} catch {
			// An unreadable script stays unread; the judge decides on the command alone, as before.
		}
	}
	return found;
}

/**
 * The rail's word for a call whose only known reach is a credentialed CLI, since
 * PanCode cannot say that it has an outward consequence, only what it runs as. Null
 * when the sentences name anything more, and then the tier's word stands.
 */
export function credentialedCallKind(consequence: ReadonlyArray<string> | undefined): string | null {
	if (consequence === undefined || consequence.length !== 1) return null;
	const line = consequence[0] ?? "";
	if (/ reads with your credentials$/u.test(line)) return "reads with your credentials";
	if (/ acts with your credentials$/u.test(line)) return "uses your credentials";
	return null;
}

function shellOutwardReason(call: ClassifierCall): string | null {
	if (call.tool !== ToolNames.Bash && call.tool !== ToolNames.RunScript) return null;
	const command = call.args?.command;
	return typeof command === "string" ? outwardShellReason(command) : null;
}

/**
 * Whether a parked main-agent call reaches outside the workspace, for the words
 * and tone of its approval card. The classifier's own exposure comes first, then
 * the shell steps the sandbox already treats as outward, so `npm publish` is not
 * titled a workspace action beside an effect that says otherwise. Card text only:
 * admission reads none of this, and a false match only makes a card warier.
 */
export function mainCallExposure(call: ClassifierCall, decision: SafetyDecision): AutonomyExposure {
	if (autonomyCallInputs(call, decision).exposure === "outward") return "outward";
	return shellOutwardReason(call) === null ? "local" : "outward";
}

/** How far a parked main-agent call reaches, as its approval card states it. */
export type MainCallReach = "workspace" | "outside-workspace" | "unknown";

/** Device files a command writes or reads as plumbing (`> /dev/null`, `2>/dev/stderr`), not as a place it reaches. */
const DEVICE_PLUMBING = /^\/dev\/(?:null|zero|tty|stdin|stdout|stderr|fd\/\d+)$/u;

/** A shell word whose path the shell computes when it runs, so its text does not say where it lands. */
const SHELL_COMPUTED = /[$`]/u;

/**
 * One place a call names, and the directory its spelling is read from. A
 * shell word may be computed or device plumbing; a typed argument is literal
 * (`routes/$id.tsx` is a file name).
 */
interface ReachProbe {
	raw: string;
	base: string;
	shellWord: boolean;
}

/** The places a call names, and whether it may reach a place they leave out. */
interface CallReachProbes {
	probes: ReachProbe[];
	unseen: boolean;
}

/** A word that names its place whatever directory the shell is in. */
function rootedWord(word: string): boolean {
	return isAbsolute(word) || word === "~" || word.startsWith("~/");
}

/** The directory a literal cd leaves the shell in. */
function cdInto(cwd: string, target: string): string {
	return target === "~" || target.startsWith("~/") ? join(homedir(), target.slice(1)) : resolve(cwd, target);
}

/**
 * A shell command's places. The cd, write and delete steps are read in shell
 * order with the directory each runs in (a subshell's cd ends with it); after
 * a cd the walk cannot place (in a loop, via CDPATH, or to a computed
 * directory) a relative step's place is unseen. The words a command opens,
 * searches or writes carry no step, so once the command cds anywhere only
 * their rooted spellings are judged.
 */
function shellReachProbes(command: string, callCwd: string): CallReachProbes {
	const probes: ReachProbe[] = [];
	let unseen = false;
	const at = (raw: string, cwd: string | null): void => {
		if (rootedWord(raw)) probes.push({ raw, base: callCwd, shellWord: true });
		else if (cwd === null) unseen = true;
		else probes.push({ raw, base: cwd, shellWord: true });
	};
	const walks = extractCommandPathWalks(command);
	const cds = walks.some((walk) => walk.some((event) => event.kind === "cd"));
	const roles = bashOperandRoles(command);
	for (const word of [
		...roles.opened,
		...roles.writes.map((write) => write.target),
		...roles.searches.flatMap((search) => search.roots),
	]) {
		at(word, cds ? null : callCwd);
	}
	for (const walk of walks) {
		let cwd: string | null = callCwd;
		const outer: Array<string | null> = [];
		for (const event of walk) {
			if (event.kind === "subshell") {
				if (event.open) outer.push(cwd);
				else cwd = outer.pop() ?? cwd;
			} else if (event.kind === "cd") {
				if (event.unmodeled || SHELL_COMPUTED.test(event.target)) {
					unseen = true;
					cwd = null;
					continue;
				}
				at(event.target, cwd);
				cwd = rootedWord(event.target) || cwd !== null ? cdInto(cwd ?? callCwd, event.target) : null;
			} else if (event.kind === "write") {
				at(event.target, cwd);
			} else if (event.kind === "delete") {
				if (event.scope === "input" || event.scope === "remote") unseen = true;
				else at(event.target, cwd);
			}
		}
	}
	return { probes, unseen };
}

/**
 * The places a call names in a path role. A file tool's typed path; every
 * path a store write lands on (any op that also reads other blobs, through
 * `derived_from`, reaches a place this does not resolve); a run_script's
 * script and declared inputs (a `<tag>:<blob>` input is read from the store
 * wherever it lives); a shell command's steps (`shellReachProbes`).
 */
function callReachProbes(call: ClassifierCall, workspace: string, callCwd: string): CallReachProbes {
	const typed = (raw: string, base: string): ReachProbe => ({ raw, base, shellWord: false });
	const named = pathPolicyTargets(call, callCwd).map((target) => typed(target.path, callCwd));
	if (call.tool === ToolNames.Store) {
		// A store write lands under the PanStore data root, never at its `path` source.
		const writes = storeWriteSet(callCwd, call.args).map((path) => typed(path, callCwd));
		const reads = call.args?.op === "get" || call.args?.op === "list";
		const derived = Array.isArray(call.args?.derived_from) && call.args.derived_from.length > 0;
		return { probes: [...named, ...writes], unseen: reads || derived || writes.length === 0 };
	}
	if (call.tool === ToolNames.RunScript) {
		const probes = [...named];
		let unseen = false;
		// run_script resolves its script and inputs against the workspace root, whatever its cwd.
		const script = call.args?.script;
		if (typeof script === "string") probes.push(typed(script, workspace));
		const inputs = Array.isArray(call.args?.inputs) ? call.args.inputs : [];
		for (const input of inputs) {
			if (typeof input !== "string") continue;
			if (!isAbsolute(input) && input.includes(":")) unseen = true;
			else probes.push(typed(input, workspace));
		}
		return { probes, unseen };
	}
	if (call.tool !== ToolNames.Bash) return { probes: named, unseen: named.length === 0 };
	const command = commandArg(call.args);
	if (command === null) return { probes: named, unseen: true };
	const shell = shellReachProbes(command, callCwd);
	return { probes: [...named, ...shell.probes], unseen: shell.unseen };
}

/**
 * How far a parked main-agent call reaches, for the words of its approval card.
 * Outside the workspace: a read the net marked so, a command that leaves the
 * sandbox, or a cwd, script, input or named place that resolves (links
 * followed) outside the canonical workspace. The workspace: a file or store
 * tool whose every place is named and resolves inside. Unknown otherwise,
 * since a shell call can reach what its words do not name (the main-session
 * sandbox still lets it read anywhere and write the scratch roots), so the
 * card never claims the workspace for a reach it cannot see. Card text only:
 * admission reads none of this.
 */
export function mainCallReach(
	call: ClassifierCall,
	decision: SafetyDecision,
	workspace: string = process.cwd(),
): MainCallReach {
	if (decision.policy?.readScope === "outside-workspace" || asksToLeaveSandbox(decision)) return "outside-workspace";
	const memo = createPathWalkMemo();
	const root = canonicalizePath(workspace, memo) ?? resolve(workspace);
	const shell = call.tool === ToolNames.Bash || call.tool === ToolNames.RunScript;
	const cwdArg = call.args?.cwd;
	const callCwd = resolve(workspace, shell && typeof cwdArg === "string" && cwdArg.length > 0 ? cwdArg : ".");
	const found = callReachProbes(call, workspace, callCwd);
	let unseen = found.unseen;
	const cwdProbe: ReachProbe[] = shell ? [{ raw: callCwd, base: workspace, shellWord: false }] : [];
	for (const probe of [...cwdProbe, ...found.probes]) {
		if (probe.shellWord && DEVICE_PLUMBING.test(probe.raw)) continue;
		if (probe.shellWord && SHELL_COMPUTED.test(probe.raw)) {
			unseen = true;
			continue;
		}
		for (const spelling of readScopeSpellings(probe.raw, probe.base)) {
			const real = canonicalizeRawPath(spelling, probe.base, memo);
			if (real === null) unseen = true;
			else if (!isSameOrDescendant(real, root)) return "outside-workspace";
		}
	}
	return shell || unseen ? "unknown" : "workspace";
}
