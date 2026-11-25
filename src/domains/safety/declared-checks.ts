// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { isSameOrDescendant } from "../../core/path-containment.js";
import {
	loadProjectVerifierCatalog,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
	resolveProjectVerifierExecutionCwd,
} from "../../tools/verify/catalog.js";
import type { UserTaskAcceptance } from "../user-tasks/acceptance.js";
import type { FinishContractEvidence, SessionVerifier } from "./finish-contract.js";
import { validationCheckId } from "./finish-entries.js";
import type { CommandStep } from "./shell-command-verdict.js";
import { commandSteps } from "./shell-command-verdict.js";
import { scanShellLike } from "./shell-scan.js";

/** A declared check as the `&&` segments a shell run must contain, in the cwd it must run from. */
export interface DeclaredVerifierCommand {
	id: string;
	segments: string[][];
	cwd: string;
	/** Declared for this session only, so `verify` cannot run it by id. */
	session: boolean;
}

/**
 * Plain `command` checks of the project catalog plus the session's own. A
 * numeric, perf or reproduce check judges more than an exit code, and a sweep
 * check never runs bare, so running their command through the shell proves
 * nothing and they are left out. The shared classifier reads a shell run of one
 * as a check (x7-5).
 */
export function declaredVerifierCommands(
	workspaceRoot: string | undefined,
	sessionVerifiers: ReadonlyArray<SessionVerifier> | undefined,
): DeclaredVerifierCommand[] {
	if (workspaceRoot === undefined) return [];
	const root = resolve(workspaceRoot);
	const declared: DeclaredVerifierCommand[] = [];
	for (const verifier of sessionVerifiers ?? []) {
		const segments = shellAndSegments(verifier.command);
		if (segments !== null) declared.push({ id: verifier.id, segments, cwd: root, session: true });
	}
	try {
		const loaded = loadProjectVerifierCatalog(root);
		for (const check of loaded.ok ? (loaded.source?.checks ?? []) : []) {
			if (check.kind !== "command" || check.runs !== undefined) continue;
			const cwd = resolveProjectVerifierExecutionCwd(check.cwd, root);
			if (cwd instanceof Error) continue;
			declared.push({ id: check.id, segments: [check.command], cwd: resolve(cwd), session: false });
		}
	} catch {
		// An unreadable catalog declares nothing the shell could be credited for.
	}
	return declared;
}

/**
 * The literal words of each segment of a pure `&&` chain, or null when the
 * command is anything else. Exit 0 of such a chain means every segment exited
 * 0, which `;`, `||`, pipes, redirections and background jobs do not promise.
 * Any word the shell would expand ($, backticks, substitutions, `~`, globs) is
 * refused too, since its literal text is not what ran.
 */
function shellAndSegments(command: string): string[][] | null {
	const segments: string[][] = [[]];
	for (const token of scanShellLike(command)) {
		const current = segments[segments.length - 1] as string[];
		if (token.operator) {
			if (token.value !== "&&" || current.length === 0) return null;
			segments.push([]);
			continue;
		}
		if (token.substitutions?.length || token.hiddenContent || token.ansiCQuoted || token.homeRelative) return null;
		const raw = command.slice(token.start, token.end);
		if (/[$`]/u.test(raw) && !/^'[^']*'$/u.test(raw)) return null;
		if (!token.quoted && /[*?[]/u.test(token.value)) return null;
		current.push(token.value);
	}
	return segments.every((segment) => segment.length > 0) ? segments : null;
}

/**
 * Words that, leading an earlier `&&` segment, can end the shell, replace it,
 * or change its cwd or what a later word runs, so a later segment that reads
 * like a check may never have run, or ran somewhere or as something else.
 */
const SHELL_STATE_WORDS = new Set([
	".",
	"alias",
	"builtin",
	"cd",
	"command",
	"declare",
	"enable",
	"eval",
	"exec",
	"exit",
	"export",
	"function",
	"hash",
	"kill",
	"local",
	"logout",
	"popd",
	"pushd",
	"readonly",
	"return",
	"set",
	"shopt",
	"source",
	"suspend",
	"trap",
	"typeset",
	"unalias",
	"unset",
]);

/**
 * Words that run the rest of their segment as a command, such as `/usr/bin/time exit 0`
 * or `env cd /`. The guard does not model what they run, so a segment they
 * lead ends the part of the chain that can be credited, as a state change does.
 * A leading `time`, `timeout`, `nice` or `xvfb-run` is read through to the
 * command it runs, as every check reader reads it (x10-1).
 */
const COMMAND_PREFIX_WORDS = new Set([
	"!",
	"busybox",
	"chroot",
	"coproc",
	"doas",
	"env",
	"ionice",
	"nice",
	"nohup",
	"setsid",
	"stdbuf",
	"sudo",
	"taskset",
	"time",
	"timeout",
	"unbuffer",
	"xargs",
]);

export const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/u;

function changesShellState(step: CommandStep): boolean {
	if (!step.literal) return true;
	// A bare assignment persists for the rest of the chain; one before a command applies to that command only.
	const word = step.argv.slice(step.command).find((candidate) => !SHELL_ASSIGNMENT.test(candidate));
	if (word === undefined || SHELL_STATE_WORDS.has(word)) return true;
	const name = word.slice(word.lastIndexOf("/") + 1);
	return COMMAND_PREFIX_WORDS.has(name) || SHELL_STATE_WORDS.has(name);
}

/** A declared check a shell command ran whole, and the indices of the steps that ran it. */
export interface DeclaredCheckRun {
	check: DeclaredVerifierCommand;
	steps: number[];
}

/**
 * Every declared check a shell command runs whole, each as a contiguous `&&` run
 * of the classifier's own steps ({@link commandSteps}) that no earlier step could
 * have skipped, redirected or moved to another cwd. A step runs a declared
 * segment when its words, or the command a leading `time`, `timeout`, `nice` or
 * `xvfb-run` runs, are exactly that segment's, so `make ci FOO=1` runs no `make
 * ci`. A leading `cd <dir> &&` moves where the rest ran. This only names the
 * steps; whether the call settles them (pipes, logs, `2>&1`) and stands after
 * the run's changes is the shared classifier's answer, as for any check (x7-5,
 * x10-1).
 */
export function declaredCheckRuns(
	command: string,
	base: string,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
): DeclaredCheckRun[] {
	if (declared.length === 0) return [];
	let steps = commandSteps(command);
	if (steps.length === 0 || steps.some((step) => step.grouped)) return [];
	let ranIn = resolve(base);
	let offset = 0;
	const [first] = steps;
	if (
		first?.argv[0] === "cd" &&
		first.argv.length === 2 &&
		first.literal &&
		first.joinedBy === "&&" &&
		steps.length > 1 &&
		!first.argv[1]?.startsWith("-")
	) {
		ranIn = resolve(base, first.argv[1] as string);
		offset = 1;
		steps = steps.slice(1);
	}
	const same = (declaredWords: ReadonlyArray<string>, ranWords: ReadonlyArray<string>) => {
		const left = packageScriptWords(declaredWords);
		const right = packageScriptWords(ranWords);
		return left.length === right.length && left.every((word, index) => word === right[index]);
	};
	const runs = (segment: ReadonlyArray<string>, step: CommandStep | undefined) =>
		step?.literal === true && (same(segment, step.argv) || same(segment, step.argv.slice(step.command)));
	const firstStateChange = steps.findIndex(changesShellState);
	const reachable = firstStateChange === -1 ? steps.length : firstStateChange + 1;
	const matches: DeclaredCheckRun[] = [];
	for (const check of declared) {
		if (check.cwd !== ranIn) continue;
		// The last run of a check is the one the fewest later steps can undo.
		let end = -1;
		for (let start = 0; start < reachable && start + check.segments.length <= steps.length; start += 1) {
			const ran = check.segments.every(
				(segment, index) =>
					runs(segment, steps[start + index]) &&
					(index === check.segments.length - 1 || steps[start + index]?.joinedBy === "&&"),
			);
			if (ran) end = start + check.segments.length;
		}
		if (end === -1) continue;
		const indices = check.segments.map((_, index) => end - check.segments.length + index + offset);
		matches.push({ check, steps: indices });
	}
	return matches;
}

const PACKAGE_SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn"]);

/** `npm run test` runs the same script as `npm test` (likewise pnpm and yarn), so both read as the shorthand. */
function packageScriptWords(words: ReadonlyArray<string>): ReadonlyArray<string> {
	const [runner, verb, script] = words;
	if (runner === undefined || !PACKAGE_SCRIPT_RUNNERS.has(runner) || verb !== "run" || script !== "test") return words;
	return [runner, "test", ...words.slice(3)];
}

export function isPancodeConfigurationPath(path: string, workspaceRoot: string | undefined): boolean {
	const root = resolve(workspaceRoot ?? ".");
	const target = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(root, path);
	const local = relative(root, target).split(sep).join("/");
	return /^\.pancode\/(?:settings(?:\.local)?\.yaml|playbooks\/[^/]+\.md)$/u.test(local);
}

/** Relative targets resolve against the workspace; `~` and absolute paths are judged where they land. */
export function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
	const root = resolve(workspaceRoot);
	const target = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(root, path);
	return isSameOrDescendant(target, root);
}

export function acceptanceCheckPassed(
	evidence: FinishContractEvidence,
	required: UserTaskAcceptance["verification"][number],
	workspaceRoot: string | undefined,
): boolean {
	if (evidence.kind !== "validation_command" || evidence.check !== required.check || !workspaceRoot || !evidence.source)
		return false;
	if (evidence.durationMs !== undefined && evidence.durationMs > required.timeoutMs) return false;
	const root = resolve(workspaceRoot);
	if (evidence.source.kind === "project-catalog")
		return evidence.source.path === resolve(root, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH);
	return (
		evidence.source.path === resolve(root, "package.json") &&
		evidence.cwd === root &&
		validationCheckId(evidence.argv?.join(" ") ?? "") === required.check
	);
}
