// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall } from "../../tools/surface.js";
import {
	extractCommandDeleteTargets,
	extractCommandWriteTargets,
	heredocDataWriteTargets,
} from "./command-path-walks.js";
import { isWithinWorkspace } from "./declared-checks.js";
import type { MutationCandidate } from "./finish-contract.js";
import {
	asRecord,
	capabilityEntries,
	ranToNonzeroExitResultId,
	stringFromFirst,
	successfulToolResultId,
	turnIdOf,
} from "./finish-entries.js";
import { toolMutationPaths } from "./protected-artifacts.js";

/**
 * Paths the turn actually mutated, drawn only from successful (non-error)
 * receipts inside the window:
 *   - write / edit / artifact, via `toolMutationPaths`.
 *   - bash whose command carries a workspace write or delete target, via
 *     `extractCommandWriteTargets` / `extractCommandDeleteTargets`.
 * Read-only git and pure read/grep/find/ls/exec/web_fetch receipts contribute
 * nothing, so the contract can never fire on a retrieval or execution-only
 * turn. Grounded in the same mutation notion the action classifier records, so
 * the audit ledger and this gate stay consistent about what counts as a change.
 */
export function mutatingReceipts(
	recent: ReadonlyArray<unknown>,
	/** Where shell targets land: relative ones resolve against `cwd`, which defaults to the workspace root. */
	place?: { workspaceRoot: string; cwd?: string },
): { paths: string[]; written: Set<string> } {
	const mutationCalls = new Map<string, MutationCandidate>();
	const paths: string[] = [];
	const seen = new Set<string>();
	const written = new Set<string>();
	const shellPaths = new Set<string>();
	const toolPaths = new Set<string>();

	for (const entry of capabilityEntries(recent)) {
		// A user-run `!` bash execution is self-contained: it carries its own
		// success signal, so any mutation targets count without a paired result.
		const bashMutation = bashExecutionMutationPaths(entry);
		if (bashMutation !== null) {
			for (const path of bashMutation.paths) {
				pushPath(paths, seen, path);
				shellPaths.add(path);
			}
			for (const path of bashMutation.writes) written.add(path);
			continue;
		}

		const call = mutatingToolCall(entry);
		if (call !== null) {
			mutationCalls.set(call.toolCallId, call);
			continue;
		}

		const resultId = successfulToolResultId(entry);
		if (resultId !== null) {
			const candidate = mutationCalls.get(resultId);
			if (candidate !== undefined) {
				for (const path of candidate.paths) {
					pushPath(paths, seen, path);
					(candidate.shell ? shellPaths : toolPaths).add(path);
				}
				for (const path of candidate.writes) written.add(path);
			}
			continue;
		}
		// A here-document written ahead of a failing suite run is still on disk (SF-5).
		const failedId = ranToNonzeroExitResultId(entry);
		const failed = failedId === null ? undefined : mutationCalls.get(failedId);
		for (const path of failed?.settledWrites ?? []) {
			pushPath(paths, seen, path);
			shellPaths.add(path);
			written.add(path);
		}
	}

	if (shellPaths.size === 0) return { paths, written };
	const kept = workspaceShellTargets([...shellPaths], place);
	const changes = (path: string): boolean => toolPaths.has(path) || !shellPaths.has(path) || kept.has(path);
	return { paths: paths.filter(changes), written: new Set([...written].filter(changes)) };
}

/** A shell target with `~`, `$TMPDIR` and `$HOME` expanded, or null while it still names a variable or substitution. */
function expandShellTarget(target: string): string | null {
	const expanded = target
		.replace(/^~(?=\/|$)/u, "$HOME")
		.replace(
			/\$\{(TMPDIR|HOME)\}|\$(TMPDIR|HOME)(?![A-Za-z0-9_])/gu,
			(_match, braced?: string, bare?: string) => process.env[braced ?? bare ?? ""] || "\0",
		);
	return /[$`\0]/u.test(expanded) ? null : expanded;
}

/**
 * The shell write targets that change the workspace. One that still names a variable or substitution (`$OUT/x`,
 * `$(mktemp)`) names no workspace path, and once `~`, `$TMPDIR` and `$HOME` expand, one outside the workspace or one git
 * ignores there leaves the tree as it was: a check's log or a scratch patch is no changed file (FX-1). Without a place
 * only the unexpanded ones drop.
 */
function workspaceShellTargets(
	targets: ReadonlyArray<string>,
	place: { workspaceRoot: string; cwd?: string } | undefined,
): Set<string> {
	const inside = new Map<string, string>();
	for (const target of targets) {
		const expanded = expandShellTarget(target);
		if (expanded === null) continue;
		if (place === undefined) {
			inside.set(target, "");
			continue;
		}
		const absolute = resolve(place.cwd ?? place.workspaceRoot, expanded);
		if (isWithinWorkspace(absolute, place.workspaceRoot))
			inside.set(target, relative(resolve(place.workspaceRoot), absolute) || ".");
	}
	const ignored = place === undefined ? new Set<string>() : gitIgnoredPaths([...inside.values()], place.workspaceRoot);
	return new Set([...inside].filter(([, local]) => !ignored.has(local)).map(([target]) => target));
}

/** The workspace-relative paths git ignores; none when there is no repository or no git, which proves nothing. */
function gitIgnoredPaths(paths: ReadonlyArray<string>, workspaceRoot: string): Set<string> {
	const asked = paths.filter((path) => path !== "" && path !== ".");
	if (asked.length === 0) return new Set();
	try {
		const out = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
			cwd: workspaceRoot,
			input: asked.join("\0"),
			encoding: "utf8",
			stdio: ["pipe", "pipe", "ignore"],
			timeout: 5000,
		});
		return new Set(out.split("\0").filter((path) => path.length > 0));
	} catch {
		// Exit 1 means none is ignored.
		return new Set();
	}
}

/** Mutation targets for a tool call, empty for read-only/execute-only tools. */
export function mutationPathsForTool(toolName: string, args: Record<string, unknown> | undefined): string[] {
	if (toolName === ToolNames.Bash) {
		const command = typeof args?.command === "string" ? args.command : null;
		if (command === null) return [];
		return [...extractCommandWriteTargets(command), ...extractCommandDeleteTargets(command)];
	}
	return toolMutationPaths(toolName, args);
}

export function mutatingToolCall(entry: unknown): MutationCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const recordedTool = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (recordedTool === null) return null;
	// An artifact written through the gateway mutates the same path a direct
	// artifact call would, so the call unwraps to the capability first.
	const { toolName, args } = effectiveToolCall(
		recordedTool,
		asRecord(payload.args ?? payload.arguments ?? payload.input) ?? undefined,
	);
	const paths = mutationPathsForTool(toolName, args);
	if (paths.length === 0) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const command = toolName === ToolNames.Bash && typeof args?.command === "string" ? args.command : null;
	return {
		toolCallId,
		paths,
		writes: command === null ? paths : extractCommandWriteTargets(command),
		settledWrites: command === null ? [] : heredocDataWriteTargets(command),
		shell: command !== null,
	};
}

/**
 * Mutation targets of a settled `!` bash execution entry. Returns null when the
 * entry is not a successful bash execution so the caller falls through to the
 * tool_call/tool_result pairing path; returns `[]` for a successful command
 * with no write/delete target (a read-only `!` command is not a mutation).
 */
export function bashExecutionMutationPaths(entry: unknown): { paths: string[]; writes: string[] } | null {
	const record = asRecord(entry);
	if (record?.kind !== "bashExecution") return null;
	if (typeof record.command !== "string") return null;
	if (record.cancelled === true || record.exitCode !== 0) return null;
	const writes = extractCommandWriteTargets(record.command);
	return { paths: [...writes, ...extractCommandDeleteTargets(record.command)], writes };
}

function pushPath(paths: string[], seen: Set<string>, path: string): void {
	if (path.length === 0 || seen.has(path)) return;
	seen.add(path);
	paths.push(path);
}
