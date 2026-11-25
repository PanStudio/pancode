// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { canonicalizePath, canonicalizeRawPath } from "../../core/path-canonical.js";
import type { GitHookChange } from "../../core/sandbox/git-hooks-fingerprint.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ActionClass, Classification, ClassifierCall } from "./action-classifier.js";
import { extractCommandPathWalks } from "./command-path-walks.js";
import { findDeletesNotFollowing, removedAbsolutePaths } from "./command-readings.js";
import type { OutwardPlaces } from "./containment.js";
import {
	cleansIgnoredFiles,
	outwardLineLeaves,
	outwardShellReason,
	SNAPSHOT_RECOVERABLE_GIT_RULE_IDS,
} from "./containment.js";
import type { DamageControlMatch } from "./damage-control.js";
import { commandInvokesGit, describeGitHookChange } from "./hook-drift.js";
import { inertQuotedMatch } from "./literal-exemption.js";
import { commandArg, hasShellOperators, isUnderOrSame } from "./policy-call-args.js";
import type { DeferredAsk, OperatorYoloScope, SafetyPolicySource, SourcedRule } from "./policy-engine.js";
import { runsScriptFile } from "./policy-floor-scripts.js";
import type { LoadedProjectSafetyPolicy, ProjectCommandPolicy } from "./project-policy.js";

/** Commands that print names and metadata, never contents. */
export const NAME_LISTERS: ReadonlySet<string> = new Set(["ls", "stat", "du", "test", "["]);

/** `$PANCODE_CONFIG_DIR`, `$PANCODE_HOME` and `$XDG_CONFIG_HOME` spell the root PanCode's credential store lives under at run time. */
export const PANCODE_CONFIG_VARIABLE = /\$\{?(?:PANCODE_CONFIG_DIR|PANCODE_HOME|XDG_CONFIG_HOME)\b/u;

/** What the operator's default made of a call's damage-control hits (Phase 2c). */
export interface ResortedDamageControl {
	/** The class the rest of the evaluation judges the call by. */
	classification: Classification;
	/** A former hard block, now an ask for the safety judge. */
	ask: DeferredAsk | null;
	/** An authored ask rule no snapshot undoes; its ask rail asks as before. */
	askRule: { match: DamageControlMatch; source: SafetyPolicySource } | null;
	/** The hit a snapshot undoes, or a match-less mark for a recoverable classifier pattern; null when none yielded. */
	recoverable: { match: DamageControlMatch | null } | null;
}

/** Reason every former hard block carries when the operator's default asks for it instead (Phase 2c). */
export const DEFAULT_RESORTED_REASON =
	"at autonomy default this damage-control rule asks instead of blocking, so the safety judge decides it against the operator's request";

/** Reason a contained call carries for a rail the main-session sandbox stands in for (Phase 2c). */
export const CONTAINED_REASON =
	"the call runs in the main-session sandbox, which bounds where it writes and hides credentials, so it needs no approval";

/** Reason a call a workspace snapshot undoes carries (Phase 2c). */
export const SNAPSHOT_RECOVERABLE_REASON =
	"a workspace snapshot is taken right before this call runs, so /rewind undoes it; it needs no approval";

/** Reason a lone delete confined to scratch roots carries: nothing undoes it, and nothing there needs undoing. */
export const SCRATCH_DISPOSABLE_REASON =
	"it deletes only inside scratch roots, whose contents are disposable; no workspace snapshot covers them, so /rewind does not undo it; it needs no approval";

/** Asks only the operator answers; a deferred former block joins their reasons instead of replacing them. */
export const OPERATOR_ONLY_ASKS: ReadonlySet<string> = new Set(["project-settings-confirm", "hub-confirm"]);

/** A single git worktree discard with no global options, which runs nothing else. */
export const LONE_GIT_DISCARD = /^git\s+(?:reset|checkout|restore|clean|stash)\s/u;

/** Rule id of a workspace delete the operator's default asks for because no snapshot can undo it. */
export const DELETE_WITHOUT_SNAPSHOT_RULE_ID = "delete-without-snapshot";

/**
 * Delete targets of a command that only a workspace snapshot could undo: a
 * relative target, which the shell places from wherever it stands, and an
 * absolute one inside the workspace. A scratch root's contents are
 * disposable, and a path elsewhere already meets the delete judge.
 */
export function deletesNeedingSnapshot(command: string, workspace: string): string[] {
	const targets: string[] = [];
	const canonicalWorkspace = canonicalizePath(workspace);
	for (const walk of extractCommandPathWalks(command)) {
		for (const event of walk) {
			if (event.kind !== "delete" || event.scope === "input" || event.scope === "remote") continue;
			if (path.isAbsolute(event.target)) {
				const resolved = canonicalizeRawPath(event.target, "/");
				if (resolved === null || canonicalWorkspace === null || !isUnderOrSame(resolved, canonicalWorkspace)) continue;
			}
			targets.push(event.target);
		}
	}
	return targets;
}

/**
 * True when a command deletes something and every delete target is an
 * absolute path strictly inside a scratch root.
 */
export function deletesOnlyScratch(command: string, roots: ReadonlyArray<string>): boolean {
	let deletes = 0;
	for (const walk of extractCommandPathWalks(command)) {
		// A link planted first may lead a later scratch path anywhere (row 261).
		let linked = false;
		for (const event of walk) {
			if (event.kind === "link" && event.symbolic) linked = true;
			if (event.kind !== "delete" || event.scope === "input" || event.scope === "remote") continue;
			// A delete a row 261 reading adds (an env, xargs or here-document body the base walk skipped) never makes a
			// call scratch-only, so it cannot drop the snapshot a discard beside it needs.
			if (linked || event.added === true || !path.isAbsolute(event.target)) return false;
			const resolved = canonicalizeRawPath(event.target, "/");
			if (resolved === null || !roots.some((root) => resolved !== root && isUnderOrSame(resolved, root))) return false;
			deletes += 1;
		}
	}
	return deletes > 0;
}

/** A single rm, rmdir or unlink, which runs nothing else; the delete judge has already placed its operands. */
export const LONE_DELETE = /^(?:rm|rmdir|unlink)\s/u;

/**
 * True for a call that runs a project command: bash, run_script, and a verify
 * call whose check resolves to an argv (`verifyCommand`). A verify call that
 * lists checks, names an unknown one or validates a frontend artifact runs no
 * project code.
 */
export function runsProjectCommand(call: ClassifierCall, verifyCommand: string | null): boolean {
	if (call.tool === ToolNames.Bash || call.tool === ToolNames.RunScript) return true;
	return call.tool === ToolNames.Verify && verifyCommand !== null;
}

/** True when the call reaches outward (a push, a publish, a code host or cloud CLI, a network write). */
export function reachesOutward(
	call: ClassifierCall,
	classification: Classification,
	verifyCommand: string | null,
): boolean {
	const command = call.tool === ToolNames.Verify ? verifyCommand : commandArg(call.args);
	// The classifier's outward `git push` is read again here, where a line that rebinds `git` stays in (R2-safety-secrets-09).
	if (classification.exposure === "outward" && command === null) return true;
	return command !== null && outwardShellReason(command) !== null;
}

/**
 * True when the operator's default runs this call in the main-session sandbox
 * (Phase 2c): bash, run_script and a verify check that runs a command, unless
 * the call asks to leave it with `unsandboxed: true` or reaches outward, which
 * needs the credentials the sandbox hides. `verifyCommand` is the argv a
 * verify call resolves to, joined, or null.
 */
export function containedShellCall(
	call: ClassifierCall,
	classification: Classification,
	verifyCommand: string | null,
): boolean {
	if (!runsProjectCommand(call, verifyCommand)) return false;
	if (call.args?.unsandboxed === true) return false;
	// An MCP tool runs on its server's own process, which no main-session sandbox holds.
	if (call.projection === "mcp-server") return false;
	return !reachesOutward(call, classification, verifyCommand);
}

/**
 * How `safety.sandbox: required` holds one call of the operator's yolo: a
 * script, and every call the default would contain, runs `sandboxed`, or is
 * `refused` when the host has no backend; such a call that asks to leave the
 * sandbox with `unsandboxed: true` is refused as `unsandboxed`. An outward call
 * that names no script keeps the credentials it needs and runs `free` only when
 * its line is one simple command with literal arguments ({@link outwardLineLeaves});
 * any other outward line is held like a call that reaches nowhere. Every call
 * runs `free` when the operator did not require the sandbox.
 */
export function yoloRequiredSandbox(
	rawCall: ClassifierCall,
	call: ClassifierCall,
	classification: Classification,
	verifyCommand: string | null,
	scope: OperatorYoloScope,
	places: () => OutwardPlaces,
): "sandboxed" | "refused" | "unsandboxed" | "free" {
	const state = scope.scriptSandbox;
	if (state !== "sandboxed" && state !== "refused") return "free";
	// The typed git tool runs a fixed argv, never through the sandbox; its hooks are the hooks guard's to judge.
	// Neither does an MCP tool call, which runs on its server's own process.
	if (call.projection === "typed-git" || call.projection === "mcp-server" || !runsProjectCommand(call, verifyCommand))
		return "free";
	const script = runsScriptFile(rawCall);
	if (!script && reachesOutward(call, classification, verifyCommand)) {
		const command = call.tool === ToolNames.Verify ? verifyCommand : commandArg(call.args);
		if (command === null) return "free";
		const where = places();
		if (outwardLineLeaves(command, where)) {
			const drift = commandInvokesGit(command) ? hookDriftHeld(scope, where.workspace) : null;
			if (drift === null) return "free";
			where.held?.push(drift);
		}
	}
	if (call.args?.unsandboxed === true) return "unsandboxed";
	return state;
}

/** Hook drift entries a held line's explanation names before it counts the rest. */
const HELD_DRIFT_NAMED = 5;

/**
 * Why an outward git or gh line stays inside a required sandbox: the hook
 * files and executable git config added or changed since the drift guard's
 * baseline, or null when there are none or no guard is wired. A check that
 * throws holds the line, since what git would run is then unknown.
 */
function hookDriftHeld(scope: OperatorYoloScope, workspace: string): string | null {
	if (scope.hookDrift === undefined) return null;
	let changes: ReadonlyArray<GitHookChange>;
	try {
		changes = scope.hookDrift.check({ silent: true })?.changes ?? [];
	} catch {
		return "the git hook fingerprint could not be read";
	}
	if (changes.length === 0) return null;
	const named = changes.slice(0, HELD_DRIFT_NAMED).map((change) => describeGitHookChange(change, workspace));
	const more = changes.length > HELD_DRIFT_NAMED ? `; and ${changes.length - HELD_DRIFT_NAMED} more` : "";
	return `git hook files or executable git config changed since the session started, and git would run them outside the sandbox: ${named.join("; ")}${more}`;
}

/** A hard rule blocks; an `ask: true` rule asks. The same test matchSourcedRule ranks by. */
export function isHardMatch(match: DamageControlMatch): boolean {
	return match.block === true || (match.ask !== true && match.actionClass === "git_destructive");
}

/** Pack rules that flag a delete by its shape; the delete judge then places every operand. */
const DELETE_SHAPED_RULES: ReadonlySet<string> = new Set(["rsync-delete", "rmdir-ignore-non-empty"]);

const FIND_FOLLOWS_LINKS = /(?:^|[\s;&|(])-(?:L|H|follow)(?=$|[\s;&|)])/u;

/**
 * True when the workspace snapshot taken right before the call undoes what
 * this damage-control rule flagged (Phase 2c): a worktree discard or stash
 * drop, or a delete the delete judge places inside the workspace or a scratch
 * root. Each delete reading counts the steps it parsed and yields only when
 * that covers every textual match, so a command the parser cannot see keeps
 * the rule (#419).
 */
export function snapshotRecoverableRule(
	ruleId: string,
	pattern: RegExp,
	scans: ReadonlyArray<string>,
	command: string | null,
	scratchRoots: ReadonlyArray<string>,
	workspace: string,
): boolean {
	if (SNAPSHOT_RECOVERABLE_GIT_RULE_IDS.has(ruleId)) {
		return ruleId !== "git-clean-force-directory" || !cleansIgnoredFiles(command ?? "");
	}
	if (command === null) return false;
	// A remote rsync destination is not the workspace's to restore.
	if (DELETE_SHAPED_RULES.has(ruleId)) return outwardShellReason(command) === null;
	if (ruleId === "find-delete") {
		if (scans.some((scan) => FIND_FOLLOWS_LINKS.test(scan))) return false;
		const finds = findDeletesNotFollowing(command);
		return finds !== null && finds >= mostMatches(pattern, scans);
	}
	if (ruleId !== "rm-rf-root") return false;
	// Read both ways: the text for a delete the parser cannot see and the
	// parsed words for one whose quoting hides the path from the text.
	const removed = removedAbsolutePaths(command);
	return (
		removed !== null &&
		removed.steps >= mostMatches(pattern, scans) &&
		everyMatchedPathRecoverable(pattern, scans, scratchRoots, workspace) &&
		removed.paths.every((removedPath) => isRecoverableDeletePath(removedPath, scratchRoots, workspace))
	);
}

function mostMatches(pattern: RegExp, scans: ReadonlyArray<string>): number {
	const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
	return Math.max(0, ...scans.map((scan) => [...scan.matchAll(global)].length));
}

/**
 * `rm-rf-root` flags every `rm -rf /<path>` outside /tmp. Under the operator's
 * default it yields when the path each of its matches names, in every scan,
 * resolves strictly inside the workspace or a scratch root. This reads the
 * text so a delete the parser cannot see keeps the rule; the caller also reads
 * the parsed words, and the delete judge still places every operand.
 */
function everyMatchedPathRecoverable(
	pattern: RegExp,
	scans: ReadonlyArray<string>,
	roots: ReadonlyArray<string>,
	workspace: string,
): boolean {
	const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
	let matched = false;
	for (const scan of scans) {
		for (const found of scan.matchAll(global)) {
			matched = true;
			const start = (found.index ?? 0) + found[0].length - 1;
			const operand = scan[start] === "/" ? /^[^\s;&|()<>'"`]+/u.exec(scan.slice(start))?.[0] : undefined;
			if (operand === undefined || operand.includes("$")) return false;
			if (!isRecoverableDeletePath(operand, roots, workspace)) return false;
		}
	}
	return matched;
}

/** True when an absolute path lies strictly inside a scratch root, or strictly inside the workspace and outside its .git. */
function isRecoverableDeletePath(operand: string, roots: ReadonlyArray<string>, workspace: string): boolean {
	const resolved = canonicalizeRawPath(operand, "/");
	if (resolved === null) return false;
	if (roots.some((root) => resolved !== root && isUnderOrSame(resolved, root))) return true;
	const canonicalWorkspace = canonicalizePath(workspace);
	if (canonicalWorkspace === null || resolved === canonicalWorkspace) return false;
	return isUnderOrSame(resolved, canonicalWorkspace) && !isUnderOrSame(resolved, path.join(canonicalWorkspace, ".git"));
}

/** Whether one rule matches any scan candidate outside an inert quoted argument. */
function ruleMatches(candidates: ReadonlyArray<string>, entry: SourcedRule): boolean {
	return candidates.some(
		(candidate) =>
			entry.rule.pattern.test(candidate) &&
			!(
				inertQuotedMatch(candidates[0] ?? candidate, entry.rule.pattern, entry.rule.id) &&
				inertQuotedMatch(candidate, entry.rule.pattern, entry.rule.id)
			),
	);
}

function ruleMatch(entry: SourcedRule): DamageControlMatch {
	const match: DamageControlMatch = {
		ruleId: entry.rule.id,
		reason: `matched ${entry.rule.id}: ${entry.rule.description}`,
		actionClass: entry.rule.class,
		block: entry.rule.block,
	};
	if (entry.rule.ask !== undefined) match.ask = entry.rule.ask;
	return match;
}

/** Every rule a call matches, in rule order: the operator's default judges each one (Phase 2c). */
export function matchingSourcedRules(
	candidates: ReadonlyArray<string>,
	rules: ReadonlyArray<SourcedRule>,
): Array<{ match: DamageControlMatch; source: SafetyPolicySource; pattern: RegExp }> {
	return rules
		.filter((entry) => ruleMatches(candidates, entry))
		.map((entry) => ({ match: ruleMatch(entry), source: entry.source, pattern: entry.rule.pattern }));
}

/**
 * A hard rule outranks every confirmation rule; within one severity, rule order
 * is precedence. Returning the first match in rule order let an authored ask
 * rule for one segment of a compound command hide a later hard block for
 * another: `gcloud iam policies list; firebase projects:delete x` asked, and a
 * confirmed posture then admitted the project deletion (F1). Every rule is
 * offered every scan candidate, so each segment is judged.
 */
export function matchSourcedRule(candidates: ReadonlyArray<string>, rules: ReadonlyArray<SourcedRule>) {
	let first: { match: DamageControlMatch; source: SourcedRule["source"] } | null = null;
	for (const entry of rules) {
		if (!ruleMatches(candidates, entry)) continue;
		const match = ruleMatch(entry);
		// The same test evaluate() applies before its block rail.
		if (isHardMatch(match)) return { match, source: entry.source };
		first ??= { match, source: entry.source };
	}
	return first;
}

// Excludes "unknown" because damage control overrides must classify actions into concrete, actionable categories.
const ACTION_CLASSES = new Set<ActionClass>([
	"read",
	"write",
	"execute",
	"system_modify",
	"git_destructive",
	"destructive",
	"dispatch",
]);

export function effectiveClassification(
	classification: Classification,
	match: DamageControlMatch | undefined,
): Classification {
	if (!match || !ACTION_CLASSES.has(match.actionClass as ActionClass)) return classification;
	const actionClass = match.actionClass as ActionClass;
	if (actionClass === classification.actionClass) return classification;
	return {
		...classification,
		actionClass,
		reasons: [...classification.reasons, `damage-control:${match.ruleId}`],
	};
}

export function matchingProjectCommand(
	policy: LoadedProjectSafetyPolicy,
	command: string,
	cwd: string,
): ProjectCommandPolicy | null {
	if (!policy.valid || policy.path === null) return null;
	const policyRoot = path.dirname(path.dirname(policy.path));
	for (const entry of policy.commands) {
		if (entry.command !== command) continue;
		if (entry.shellOperators === "deny" && hasShellOperators(command)) continue;
		const allowedCwd = entry.cwd !== undefined ? path.resolve(policyRoot, entry.cwd) : policyRoot;
		if (!isUnderOrSame(cwd, allowedCwd)) continue;
		return entry;
	}
	return null;
}
