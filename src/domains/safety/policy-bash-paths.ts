// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import type { PathWalkMemo } from "../../core/path-canonical.js";
import { createPathWalkMemo } from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import type { ClassifierCall } from "./action-classifier.js";
import { normalizeCallPaths } from "./action-classifier.js";
import { extractFilteredFindDeleteRoots } from "./check-command-shape.js";
import { extractCommandDeleteTargets, extractCommandWriteTargets } from "./command-path-walks.js";
import { heredocDataText } from "./heredoc-data.js";
import { scanShellLikeDeep, withoutDataHeredocBodies } from "./heredoc-scan.js";
import type { FlowSourceCall } from "./information-flow.js";
import type { CompiledPathPolicy, PathPolicyDecision, PathPolicyOperation } from "./path-policy.js";
import { evaluatePathPolicy } from "./path-policy.js";
import { commandArg, cwdArg, pathArg } from "./policy-call-args.js";
import type { BashWriteOperand, BashZeroAccessHit } from "./policy-operand-roles.js";
import { bashOperandRoles, recursiveSearchHit } from "./policy-operand-roles.js";
import { maskPrintedExitStatus } from "./policy-read-only-inspectors.js";
import { readScopeSpellings } from "./read-scope.js";
import { hasUnparsedShellScript, inlineShellScript } from "./shell-segments.js";

/** Absolute path of PanCode's user skills, when resolvable. */
export function pancodeSkillsRootPaths(): string[] {
	try {
		return [path.join(pancodeConfigDir(), "skills")];
	} catch {
		return [];
	}
}

/**
 * The exact safe presence form: `grep -q` or `grep -sq` (either flag order)
 * with a `^NAME=`-shaped pattern and a single file argument. Exit code only;
 * the value never enters context. Anything broader stays blocked.
 */
const SAFE_PRESENCE_RE = /^\s*grep\s+(?:-(?:q|sq|qs)\s+)('[^']*'|"[^"]*"|\S+)\s+\S+\s*$/;

function isSafePresenceCheck(command: string): boolean {
	const match = SAFE_PRESENCE_RE.exec(command);
	if (!match || match[1] === undefined) return false;
	const pattern = stripQuotes(match[1]);
	// The pattern must end at `=`: anything after it tests the value, and a
	// sequence of such checks reads the secret one character at a time.
	return /^\^[A-Za-z_][A-Za-z0-9_]*=$/.test(pattern);
}

/**
 * A presence check chained into a list (`grep -sq "^NAME=" .env && echo set`)
 * still reads nothing; the rest of the list is judged on its own. Returns the
 * command left after removing leading presence checks, "" when nothing
 * remains, or null when the command does not start with one. Pipes and
 * redirections never bind to the check: only `&&`, `||` and `;` separate it.
 */
const LEADING_PRESENCE_RE =
	/^\s*(grep\s+-(?:q|sq|qs)\s+(?:'[^']*'|"[^"]*"|[^\s;&|<>]+)\s+[^\s;&|<>]+)\s*(?:&&|\|\||;)(?!&|\|)/;

function stripPresenceChecks(command: string): string | null {
	if (isSafePresenceCheck(command)) return "";
	let rest = command;
	let stripped = false;
	for (;;) {
		const match = LEADING_PRESENCE_RE.exec(rest);
		if (!match || match[1] === undefined || !isSafePresenceCheck(match[1])) break;
		rest = rest.slice(match[0].length);
		stripped = true;
		if (isSafePresenceCheck(rest)) return "";
	}
	if (!stripped) return null;
	return rest.trim();
}

function stripQuotes(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1);
	}
	return token;
}

/**
 * Split a bash command into candidate path tokens. Quotes bind: a quoted
 * string is one token, so `git commit -m "handle .env parsing"` yields the
 * whole message (not a path) while `cat ".env"` still yields `.env`. Shell
 * metacharacters outside quotes act as separators. Tokens are matched as
 * paths against the compiled zero-access entries (which handle tilde
 * expansion and globs), never against a list of reader binaries: a
 * zero-access path appearing anywhere in the command is the signal.
 */
export function bashPathTokenCandidates(command: string): string[] {
	// C-22: a here-document the parsed call proves is data names no file (row 287).
	command = heredocDataText(command) ?? withoutDataHeredocBodies(command, "stdin-only", "rails");
	const candidates: string[] = [];
	// `sh -c 'cat .env'` is one whitespace-bearing token below, skipped as prose,
	// yet recognition judges exactly that inner script. Scan it as its own command.
	const inner = inlineShellScript(command);
	if (inner !== null && inner !== command) candidates.push(...bashPathTokenCandidates(inner));
	for (const scanned of scanShellLikeDeep(command)) {
		if (scanned.operator) continue;
		const token = scanned.value;
		if (token.length === 0) continue;
		// A token containing whitespace usually came from a quoted string of
		// prose, not a path argument. One that also holds a slash can still be a
		// path through a directory with a space in its name (`"a b/../.env"`), so
		// it is tested whole. Flags are not paths unless they embed one
		// (--file=~/.aws/credentials).
		if (/\s/.test(token) && !token.includes("/")) continue;
		if (token.startsWith("-") && !token.includes("/") && !token.includes("=")) continue;
		candidates.push(token);
		const eq = token.indexOf("=");
		if (eq > 0 && eq < token.length - 1) candidates.push(token.slice(eq + 1));
	}
	return candidates;
}

/**
 * What a call reads, as the information-flow evaluator judges it: the path
 * arguments of the read-class tools, and the path operands a bash command
 * names. The exit-code-only presence check reads no content, so it names none.
 */
export function flowSourceCallFor(rawCall: ClassifierCall, cwd: string): FlowSourceCall {
	const call = normalizeCallPaths(rawCall);
	const command = call.tool === ToolNames.Bash ? commandArg(call.args) : null;
	const remaining = command === null ? null : (stripPresenceChecks(command) ?? command);
	const readTokens = remaining === null || remaining === "" ? [] : bashOperandRoles(remaining).reads;
	return {
		tool: call.tool,
		args: call.args,
		cwd: cwdArg(call.args, cwd),
		...(readTokens.length > 0 ? { readTokens } : {}),
	};
}

export function evaluateBashZeroAccessRead(
	zeroAccessPolicy: CompiledPathPolicy,
	command: string,
	callCwd: string,
): BashZeroAccessHit | null {
	if (zeroAccessPolicy.entries.length === 0) return null;
	const remaining = stripPresenceChecks(command);
	if (remaining === "") return null;
	if (remaining !== null) command = remaining;
	const roles = bashOperandRoles(command);
	// A 130 KB heredoc names ~17,000 read candidates, mostly repeats; each walked
	// the filesystem afresh, ~1.6 s of synchronous admission (x6-7b). A token's
	// decision cannot change within one evaluation, so each is judged once.
	const memo = createPathWalkMemo();
	const judged = new Set<string>();
	// A glob entry such as `*.key` names a file by its suffix alone, so it holds a word only in a path position or one
	// that names a file on disk: `event.key` in a sed script, a heredoc or an echo is a field, not a key file (FX-7).
	let literalPolicy: CompiledPathPolicy | null = null;
	for (const token of roles.reads) {
		if (judged.has(token)) continue;
		judged.add(token);
		let decision = evaluatePathPolicy(zeroAccessPolicy, "read", token, callCwd, memo);
		if (
			decision.kind === "block" &&
			!roles.pathOperands.has(token) &&
			!pathExistsAt(token, callCwd) &&
			!(token.startsWith("@") && pathExistsAt(token.slice(1), callCwd))
		) {
			literalPolicy ??= {
				...zeroAccessPolicy,
				entries: zeroAccessPolicy.entries.filter((entry) => entry.pattern === undefined),
			};
			decision = evaluatePathPolicy(literalPolicy, "read", token, callCwd, memo);
		}
		if (decision.kind === "block") {
			return { verb: "read", token, entrySource: `zeroAccessPaths entry ${decision.matchedPath}` };
		}
	}
	// A write names its destination, not content it reads. Creating a new file
	// under a zero-access name (`cp .env.example .env.local`) exposes nothing;
	// truncating, appending to or replacing an existing one stays refused.
	for (const write of roles.writes) {
		for (const target of landedWriteTargets(write, callCwd)) {
			if (!pathExistsAt(target, callCwd)) continue;
			const decision = evaluatePathPolicy(zeroAccessPolicy, "write", target, callCwd);
			if (decision.kind === "block") {
				return { verb: "write", token: target, entrySource: `zeroAccessPaths entry ${decision.matchedPath}` };
			}
		}
	}
	for (const search of roles.searches) {
		const hit = recursiveSearchHit(search, zeroAccessPolicy, callCwd);
		if (hit !== null) return hit;
	}
	return null;
}

/** The reason line both bash zero-access rails report. */
export function bashZeroAccessReason(hit: BashZeroAccessHit): string {
	const base = `bash ${hit.verb} of zero-access path blocked: '${hit.token}' matches ${hit.entrySource}`;
	return hit.hint === undefined ? base : `${base}. ${hit.hint}`;
}

function pathExistsAt(target: string, cwd: string): boolean {
	const expanded = target === "~" ? homedir() : target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target;
	try {
		lstatSync(path.resolve(cwd, expanded));
		return true;
	} catch {
		return false;
	}
}

/** The file a write lands on: into an existing directory destination it is `dir/<source base name>`. */
function landedWriteTargets(write: BashWriteOperand, cwd: string): string[] {
	let directory = write.intoDirectory;
	if (!directory && write.sources.length > 0) {
		try {
			directory = statSync(path.resolve(cwd, write.target)).isDirectory();
		} catch {
			directory = false;
		}
	}
	if (!directory) return [write.target];
	return write.sources.map((source) => path.join(write.target, path.basename(source)));
}

export function evaluateProjectPathPolicy(
	policy: CompiledPathPolicy,
	deletePolicy: CompiledPathPolicy,
	call: ClassifierCall,
	callCwd: string,
	memo: PathWalkMemo,
): Extract<PathPolicyDecision, { kind: "block" }> | null {
	if (policy.entries.length === 0 && deletePolicy.entries.length === 0) return null;
	for (const target of pathPolicyTargets(call, callCwd)) {
		let decision = evaluatePathPolicy(
			target.operation === "delete" ? deletePolicy : policy,
			target.operation,
			target.path,
			callCwd,
			memo,
		);
		// A bash write that creates a new file under a zero-access name
		// (`cp .env.example .env.local`) exposes no secret; overwriting an
		// existing one stays refused. The other path rails still judge it.
		if (
			decision.kind === "block" &&
			decision.policyKind === "zeroAccessPaths" &&
			target.operation === "write" &&
			call.tool === ToolNames.Bash &&
			!pathExistsAt(target.path, callCwd)
		) {
			decision = evaluatePathPolicy(
				{ ...policy, entries: policy.entries.filter((entry) => entry.kind !== "zeroAccessPaths") },
				"write",
				target.path,
				callCwd,
				memo,
			);
		}
		if (decision.kind === "block") return decision;
	}
	return null;
}

export function pathPolicyTargets(
	call: ClassifierCall,
	callCwd: string,
): Array<{ operation: PathPolicyOperation; path: string }> {
	const args = call.args;
	switch (call.tool) {
		case ToolNames.Read:
		case ToolNames.Ls:
		case ToolNames.Count:
		case ToolNames.Grep:
		case ToolNames.Find: {
			const target = pathArg(args) ?? ".";
			return readScopeSpellings(target, callCwd).map((spelling) => ({ operation: "read" as const, path: spelling }));
		}
		case ToolNames.Data: {
			// data streams one named file; a zero-access path is refused here,
			// before the reader opens it, under every spelling a read of the
			// same path is checked against.
			const target = pathArg(args);
			return target === null
				? []
				: readScopeSpellings(target, callCwd).map((spelling) => ({ operation: "read" as const, path: spelling }));
		}
		case ToolNames.Store: {
			// put reads its workspace source the way data reads its file, so a
			// zero-access source is refused before the bytes are copied out.
			const target = args?.op === "put" ? pathArg(args) : null;
			return target === null
				? []
				: readScopeSpellings(target, callCwd).map((spelling) => ({ operation: "read" as const, path: spelling }));
		}
		case ToolNames.Write:
		case ToolNames.Edit: {
			const target = pathArg(args);
			return target === null ? [] : [{ operation: "write", path: target }];
		}
		case ToolNames.Artifact:
			return [{ operation: "write", path: pathArg(args) ?? artifactDefaultPath(args?.kind) }];
		case ToolNames.CredentialPresent:
			// Sanctioned typed presence check: it may inspect secret-shaped paths
			// internally, but its tool contract can return only boolean metadata.
			return [];
		case ToolNames.Bash: {
			const command = commandArg(args);
			if (command === null) return [];
			return [
				...extractCommandWriteTargets(command).map((target) => ({ operation: "write" as const, path: target })),
				...extractCommandDeleteTargets(command).map((target) => ({ operation: "delete" as const, path: target })),
			];
		}
		default:
			return [];
	}
}

/**
 * The operator's default judges a filtered `find -delete` by what lies under
 * its root, so its root reaches the authority rails as a write: a root inside
 * a rail tree still blocks, a root that merely contains one does not (#419).
 */
export function operatorAuthorityTargets(
	targets: Array<{ operation: PathPolicyOperation; path: string }>,
	command: string,
): Array<{ operation: PathPolicyOperation; path: string }> {
	const filtered = extractFilteredFindDeleteRoots(command);
	if (filtered.length === 0) return targets;
	return targets.map((target) => {
		if (target.operation !== "delete") return target;
		const at = filtered.indexOf(target.path);
		if (at < 0) return target;
		filtered.splice(at, 1);
		return { operation: "write", path: target.path };
	});
}

/** Shell variables, an unparsed shell script or interpreter source: what the net cannot see a command touch. */
export function hidesShellContent(command: string, posture: string | undefined): boolean {
	return (
		hasUnparsedShellScript(command) ||
		(posture !== "yolo" &&
			(/\$(?:[A-Za-z_{0-9@*#?!-])/.test(maskPrintedExitStatus(command)) ||
				/(?:^|[\s;&|])(?:python[\d.]*|node|ruby|perl|php|lua)\s+(?:[^\n]*?\s)?-[ce]\b/.test(command)))
	);
}
