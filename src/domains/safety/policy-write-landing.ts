// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import { asDirectoryPathBoundary, writeRootsCover } from "../../core/path-boundary.js";
import type { PathWalkMemo } from "../../core/path-canonical.js";
import { canonicalizePath, canonicalizeRawPath, createPathWalkMemo } from "../../core/path-canonical.js";
import { isSameOrDescendant, relativePathEscapes } from "../../core/path-containment.js";
import { mainSandboxGitControlPaths } from "../../core/sandbox/main-session.js";
import { protectedStartupPath } from "../../core/sandbox/startup-paths.js";
import { isSessionAuthoredFile } from "../../core/session-authored-files.js";
import { storeBookkeepingPaths, storeGrantProbes, storeWriteSet } from "../../core/store-paths.js";
import { ToolNames } from "../../core/tool-names.js";
import { expandPath } from "../../tools/path-utils.js";
import type { Classification, ClassifierCall } from "./action-classifier.js";
import { classify, STORE_UNGRANTED_ARG } from "./action-classifier.js";
import { GIT_CONTROL_FILE_RULE_ID, STARTUP_PATH_RULE_ID, startupPathReason } from "./containment.js";
import { commandArg, isUnderOrSame, pathArg } from "./policy-call-args.js";
import type { SafetyPolicyDecision } from "./policy-engine.js";
import type { mutationCandidates } from "./skill-authority.js";

export const EXECUTION_TOOLS = new Set<string>([ToolNames.Bash, ToolNames.Verify]);

/**
 * Whether a tool escapes write-root confinement whatever its arguments: by its
 * own class it runs a project script, a shell, or an unconfined child, so no
 * lexical check can bound where it writes. The envelope reads the same test to
 * withhold such a tool from a run whose roots nothing binds (fleet M7), and the
 * class of the call itself is checked again below.
 */
export function toolEscapesWriteRoots(tool: string): boolean {
	const action = classify({ tool }).actionClass;
	return action === "execute" || action === "dispatch";
}

// Write-class tools (action class "write"). bash is execute class and runs its
// own loop, so it is not covered by the lexical write-root containment below.
export const WRITE_ROOT_TOOLS = new Set<string>([ToolNames.Write, ToolNames.Edit, ToolNames.Artifact]);

/** A call this session may not make writes nothing; the tool refuses it with how to get a grant. */
function storeWriteTargets(call: ClassifierCall, cwd: string): string[] {
	return call.args?.[STORE_UNGRANTED_ARG] === true ? [] : storeWriteSet(cwd, call.args);
}

/**
 * A store write lands where `storeWriteSet` predicts, never at its `path`
 * argument (the source), so the store is judged by that target here. It stays
 * out of WRITE_ROOT_TOOLS, which also drives the git-control check over the
 * call's path arguments.
 */
function writeRootTargetPath(call: ClassifierCall, cwd: string = process.cwd()): string | null {
	if (call.tool === ToolNames.Store) return storeWriteTargets(call, cwd)[0] ?? null;
	if (!WRITE_ROOT_TOOLS.has(call.tool)) return null;
	const target = pathArg(call.args);
	if (target !== null) return target;
	if (call.tool === ToolNames.Artifact) return artifactDefaultPath(call.args?.kind);
	return null;
}

/**
 * Under active write-root confinement, a tool that can write outside the roots
 * without a path argument the lexical check can inspect. Execute-class tools run
 * project scripts or a shell; dispatch spawns a worker not bound to these roots.
 */
export function isWriteConfinementEscape(call: ClassifierCall, actionClass: string, osConfined: boolean): boolean {
	// The typed git tool's add or commit runs a fixed argv that writes only Git
	// metadata, and the task-worktree allowance and hooks guard decide it later.
	// Blocking it as arbitrary bash made typed task commits impossible in any
	// run that also declared write roots.
	if (call.projection === "typed-git") return false;
	// Under the OS sandbox a command's writes land only in the bound roots, so
	// running one is no escape. A dispatched child is not bound by them.
	if (osConfined && call.tool !== ToolNames.Dispatch && actionClass !== "dispatch") return false;
	if (toolEscapesWriteRoots(call.tool)) return true;
	return actionClass === "execute" || actionClass === "dispatch";
}

/**
 * The roots where a write through them lands, walked at the moment of the
 * check. A root that cannot be resolved covers nothing.
 */
function physicalWriteRoots(roots: ReadonlyArray<string>, memo: PathWalkMemo): string[] {
	return roots.flatMap((root) => {
		const directory = root.endsWith("/");
		const resolved = canonicalizePath(directory ? root.slice(0, -1) : root, memo);
		if (resolved === null) return [];
		return [directory ? asDirectoryPathBoundary(resolved) : resolved];
	});
}

/** Block reason when a physical write target sits outside every physical root. */
export function writeRootViolation(
	roots: ReadonlyArray<string>,
	label: string,
	physical: string | null,
	memo: PathWalkMemo,
): string | null {
	if (physical === null) {
		return `write target '${label}' cannot be resolved (a symbolic link loop or more than 40 links), so it cannot be shown inside the permitted write roots for this run: ${roots.join(", ")}`;
	}
	if (writeRootsCover(physicalWriteRoots(roots, memo), physical)) return null;
	return `write target '${label}' resolves to '${physical}', which is outside the permitted write roots for this run: ${roots.join(", ")}`;
}

/**
 * Write-root containment judges where the typed tool actually writes: the
 * target goes through the same walk as resolveMutationTarget (realpath of the
 * deepest existing ancestor plus the remaining components) and is compared
 * with roots resolved the same way. The former lexical check let
 * `allowed/link/x` through while the write landed wherever `link` pointed (F3).
 * Returns the block reason, or null when allowed.
 */
export function evaluateWriteRoots(
	roots: ReadonlyArray<string>,
	writeRootCwd: string,
	call: ClassifierCall,
): string | null {
	if (roots.length === 0) return null;
	const memo = createPathWalkMemo();
	const violationOf = (target: string): string | null =>
		writeRootViolation(roots, target, canonicalizeRawPath(expandPath(target), writeRootCwd, memo), memo);
	const targets =
		call.tool === ToolNames.Store
			? storeWriteRootTargets(call, writeRootCwd, violationOf)
			: [writeRootTargetPath(call, writeRootCwd)];
	for (const target of targets) {
		if (target === null) continue;
		const violation = violationOf(target);
		if (violation !== null) return violation;
	}
	return null;
}

/**
 * A store write touches its records, project.json and locks besides its
 * target, so each is judged. When the roots hold a grant of the call's tag
 * (they cover the inside of the tag and of its records tag), the store's own
 * bookkeeping for the call is admitted with it: a grant adds only the two tag
 * directories to the roots, so the shell sandbox never gets project.json or
 * the locks. The op's own target is still judged.
 */
function storeWriteRootTargets(
	call: ClassifierCall,
	cwd: string,
	violationOf: (target: string) => string | null,
): string[] {
	const targets = storeWriteTargets(call, cwd);
	if (targets.length === 0) return targets;
	const probes = storeGrantProbes(cwd, call.args);
	if (probes.length === 0 || probes.some((probe) => violationOf(probe) !== null)) return targets;
	const bookkeeping = new Set(storeBookkeepingPaths(cwd, String(call.args?.tag)));
	return targets.filter((target) => !bookkeeping.has(target));
}

/** Typed tools whose writes the operator's default admits inside a scratch root. */
const SCRATCH_WRITE_TOOLS: ReadonlySet<string> = new Set([ToolNames.Write, ToolNames.Edit]);

/**
 * Directories below a scratch root that a typed write still asks for, as the
 * main-session sandbox keeps them read-only: a repository's hooks and config
 * run later outside any sandbox, and `.pancode` holds project authority.
 */
const SCRATCH_WRITE_PROTECTED_DIRS: ReadonlySet<string> = new Set([".git", ".pancode"]);

/**
 * The operator's default admits a typed write or edit that lands strictly
 * inside a scratch root the way it admits one inside the workspace, as the
 * contained shell already may: the classifier's outside-the-workspace
 * system_modify becomes a write, so neither system-modify-confirm nor
 * outside-file-replacement asks and no safety judge call is spent. The target
 * is walked as the tool walks it (resolveMutationTarget), so a link inside a
 * scratch root is judged by where it lands. Every rail that judges the target
 * itself (the floor, path policy, authority rails, write roots) still runs.
 */
export function scratchRootWrite(
	classification: Classification,
	call: ClassifierCall,
	scratchRoots: ReadonlyArray<string> | undefined,
): Classification {
	if (scratchRoots === undefined || scratchRoots.length === 0) return classification;
	if (classification.actionClass !== "system_modify" || !SCRATCH_WRITE_TOOLS.has(call.tool)) return classification;
	// Only the classifier's placement of the target is relaxed, never another reason.
	if (!classification.reasons.every((reason) => reason.startsWith("write-path-"))) return classification;
	const target = pathArg(call.args);
	const landing = target === null ? null : canonicalizeRawPath(expandPath(target), process.cwd());
	if (landing === null) return classification;
	// Scratch roots and the landing are both canonical, so a lexical comparison is exact.
	const inside = scratchRoots
		.map((root) => path.relative(root, landing))
		.filter((rel) => rel !== "" && !relativePathEscapes(rel));
	if (inside.length === 0) return classification;
	if (inside.some((rel) => rel.split(path.sep).some((part) => SCRATCH_WRITE_PROTECTED_DIRS.has(part)))) {
		return classification;
	}
	return { actionClass: "write", reasons: [`scratch-root-write: ${landing}`] };
}

/** A git control path as listed and as resolved, both case-folded where the filesystem usually ignores case. */
interface GitControl {
	path: string;
	forms: ReadonlyArray<string>;
}

/** macOS and Windows volumes usually ignore case, so `.HUSKY/pre-commit` would land in `.husky`. */
const foldPathCase: (location: string) => string =
	process.platform === "darwin" || process.platform === "win32"
		? (location) => location.toLowerCase()
		: (location) => location;

/**
 * Impure: the cwd repository's git control paths, the hooks directories
 * (core.hooksPath included), config and commondir files and `.git` pointer
 * files the main-session sandbox keeps read-only, each as listed and as
 * resolved, so a link on the control side cannot hide one.
 */
function resolveGitControls(cwd: string): GitControl[] {
	return mainSandboxGitControlPaths(cwd).map((control) => {
		const real = canonicalizePath(control);
		const forms = real === null || real === control ? [control] : [control, real];
		return { path: control, forms: forms.map(foldPathCase) };
	});
}

/** Files of a git dir whose contents become code or move the git dir. */
const GIT_DIR_CONTROL_FILES: ReadonlySet<string> = new Set(["config", "config.worktree", "commondir"]);

/** Files of a linked worktree's git dir under `.git/worktrees/<name>/`. */
const GIT_WORKTREE_CONTROL_FILES: ReadonlySet<string> = new Set(["config.worktree", "commondir", "gitdir"]);

/**
 * Pure: whether `location` is a git control path by its name alone, with no
 * filesystem call: a `.git` pointer file, or below a `.git` directory its
 * hooks, `config`, `config.worktree`, `commondir` or `info/attributes`, a
 * linked worktree's `config.worktree`, `commondir` or `gitdir`, and the hooks
 * and those files of a submodule git dir under `modules`. Case is ignored.
 * It covers a repository created after the engine was built, wherever it sits.
 */
function isGitControlName(location: string): boolean {
	const parts = location
		.toLowerCase()
		.split(/[\\/]+/u)
		.filter((part) => part.length > 0);
	if (parts.at(-1) === ".git") return true;
	for (let at = parts.indexOf(".git"); at >= 0; at = parts.indexOf(".git", at + 1)) {
		const rest = parts.slice(at + 1);
		const [first, second] = rest;
		const last = rest.at(-1) ?? "";
		if (first === "hooks") return true;
		if (rest.length === 1 && GIT_DIR_CONTROL_FILES.has(last)) return true;
		if (rest.length === 2 && first === "info" && second === "attributes") return true;
		if (first === "worktrees" && rest.length === 3 && GIT_WORKTREE_CONTROL_FILES.has(last)) return true;
		if (
			first === "modules" &&
			(rest.includes("hooks") ||
				GIT_DIR_CONTROL_FILES.has(last) ||
				last === "gitdir" ||
				(last === "attributes" && rest.at(-2) === "info"))
		) {
			return true;
		}
	}
	return false;
}

/**
 * Captured once when a policy engine is built so typed startup-path checks
 * share `PROTECTED_STARTUP_NAMES` and `PROTECTED_HOME_NAMES` with the shell
 * sandbox (`startup-paths.ts`) and pay zero per-call filesystem calls.
 */
export function createStartupPathChecker(
	cwd: string,
): (
	call: ClassifierCall,
	candidates: ReturnType<typeof mutationCandidates>,
	extraRoots?: ReadonlyArray<string>,
) => string | null {
	const workspaceReal = canonicalizePath(cwd);
	const workspaceForms = workspaceReal === null || workspaceReal === cwd ? [cwd] : [cwd, workspaceReal];
	const initialHome = homedir();
	const homeReal = canonicalizePath(initialHome);
	const initialHomeForms = homeReal === null || homeReal === initialHome ? [initialHome] : [initialHome, homeReal];
	return (call, candidates, extraRoots) => {
		if (EXECUTION_TOOLS.has(call.tool) || call.tool === ToolNames.RunScript || candidates.length === 0) return null;
		const currentHome = homedir();
		const homeForms = currentHome === initialHome ? initialHomeForms : [...initialHomeForms, currentHome];
		const roots = extraRoots !== undefined && extraRoots.length > 0 ? [...workspaceForms, ...extraRoots] : workspaceForms;
		for (const candidate of candidates) {
			for (const location of [candidate.lexical, candidate.resolved]) {
				const hit = protectedStartupPath(location, roots, homeForms);
				if (hit !== null) return hit;
			}
		}
		return null;
	};
}

/** Policy input for a typed mutation landing on a protected startup path. */
export function startupPathPolicyInput(startupPath: string): {
	ruleId: string;
	reasonCode: string;
	reasons: string[];
	policySource: "builtin-classifier";
} {
	return {
		ruleId: STARTUP_PATH_RULE_ID,
		reasonCode: STARTUP_PATH_RULE_ID,
		reasons: [startupPathReason(startupPath)],
		policySource: "builtin-classifier",
	};
}

/**
 * The cwd repository's git control paths (resolved once when the engine is
 * built and refreshed only after a call that may have rewritten git config),
 * keeping typed writes at zero per-call filesystem calls.
 */
export function createGitControlChecker(cwd: string): {
	hit: (call: ClassifierCall, candidates: ReturnType<typeof mutationCandidates>) => string | null;
	markStale: () => void;
} {
	let controls = resolveGitControls(cwd);
	let stale = false;
	return {
		markStale: () => {
			stale = true;
		},
		hit: (call, candidates) => {
			if (!WRITE_ROOT_TOOLS.has(call.tool)) return null;
			if (stale) {
				controls = resolveGitControls(cwd);
				stale = false;
			}
			return gitControlLanding(candidates, controls);
		},
	};
}

/**
 * The git control path a typed file mutation lands on, or null. Each target
 * is judged as named and where the admission walk already resolved it, by
 * name and against the resolved set, so this costs no filesystem call.
 */
function gitControlLanding(
	candidates: ReturnType<typeof mutationCandidates>,
	controls: ReadonlyArray<GitControl>,
): string | null {
	for (const candidate of candidates) {
		for (const location of [candidate.lexical, candidate.resolved]) {
			if (isGitControlName(location)) return location;
			const folded = foldPathCase(location);
			for (const control of controls) {
				if (control.forms.some((form) => isSameOrDescendant(folded, form))) return control.path;
			}
		}
	}
	return null;
}

/**
 * Shell commands that may move core.hooksPath or create a repository: git
 * config, init, clone, worktree and submodule, husky, package installs whose
 * scripts run husky, and edits that name a git config file.
 */
const GIT_CONFIG_COMMAND =
	/\bhookspath\b|\bhusky\b|\.gitconfig\b|\.git[\\/]|\bgit\b[^\n]*\b(?:config|init|clone|worktree|submodule)\b|\b(?:npm|pnpm|yarn|bun)\b[^\n]*\b(?:install|i|ci|add)\b/iu;

/**
 * Pure: whether a call the net let through (allowed, or asked and possibly
 * approved later) may rewrite a git config, so the resolved git control set
 * is refreshed before the next typed write is judged: a typed write on a git
 * control path or a global git config, a shell command that names one, and
 * any script, whose source the net does not read.
 */
export function mayRewriteGitConfig(call: ClassifierCall, decision: SafetyPolicyDecision, cwd: string): boolean {
	if (decision.gitControl !== undefined || decision.ruleId === GIT_CONTROL_FILE_RULE_ID) return true;
	if (call.tool === ToolNames.RunScript) return true;
	if (call.tool === ToolNames.Bash) {
		const command = commandArg(call.args);
		return command !== null && GIT_CONFIG_COMMAND.test(command);
	}
	const target = writeRootTargetPath(call, cwd);
	if (target === null) return false;
	const landing = path.resolve(cwd, expandPath(target));
	return (
		isGitControlName(landing) ||
		path.basename(landing) === ".gitconfig" ||
		landing.endsWith(`${path.sep}git${path.sep}config`)
	);
}

/**
 * Write and edit can replace an existing file outside the checkout. The
 * classifier has already resolved where the write lands and files every target
 * outside the workspace under a `write-path-*` reason, so a call it left
 * unmarked is inside and pays no second canonicalization: the admission
 * filesystem-call counts are pinned per call (admission-fs-ops).
 */
export function outsideExistingTypedMutationTarget(
	call: ClassifierCall,
	workspaceRoot: string,
	classification: Classification,
	posture: string | undefined,
): string | null {
	if (call.tool !== ToolNames.Write && call.tool !== ToolNames.Edit) return null;
	if (!classification.reasons.some((reason) => reason.startsWith("write-path-"))) return null;
	const target = pathArg(call.args);
	if (target === null) return null;
	const resolved = canonicalizeRawPath(target, process.cwd());
	if (resolved === null || isUnderOrSame(resolved, workspaceRoot)) return null;
	try {
		const info = statSync(resolved);
		if (!info.isFile()) return null;
		// YOLO revises the session's own outside draft without asking, but only
		// while nothing else has written it since the session's last write.
		if (posture === "yolo" && isSessionAuthoredFile(resolved, info)) return null;
		return resolved;
	} catch {
		return null;
	}
}
