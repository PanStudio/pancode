// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { headlessRouteFailureText } from "../../core/gateway-routing.js";
import { ToolNames } from "../../core/tool-names.js";
import { runCapStopCode } from "../../core/turn-constraints.js";
import type { ToolCallStat } from "../../domains/dispatch/types.js";
import { SESSION_COST_CEILING_REASON } from "../../domains/scheduling/budget.js";
import { redactUrlCredentials } from "../../lib/secrets/redaction.js";
import type { ChatLoop, ChatLoopEvent } from "../../session-control/chat-loop.js";
import { toolResultText } from "../../tools/result-disposition.js";
import type { HeadlessMainAgentRunStats } from "./headless-run-types.js";

/**
 * Ticket #378: a run whose every write was denied, and whose model then wrote
 * an apology, used to read as a success. The terminal frame now says so in one bit.
 * A run is a no-op when a block remains unresolved and no mutating call succeeded, or
 * when it ran tools and none of them succeeded. A run that called no tool and
 * answered in prose is not a no-op; answering a question is a legitimate run.
 * Neither is a turn the operator marked `--turn-mode answer` or `proposal`:
 * it asked for no change, so a blocked call along the way left nothing unmet.
 */
export function headlessNoop(stats: HeadlessMainAgentRunStats): boolean {
	if (!stats.changeAsked) return false;
	// A completion declaration is no work: a run whose every other call failed is still a no-op.
	const work = new Map([...stats.toolStats].filter(([tool]) => tool !== ToolNames.Finish));
	const totals = toolTotals(work);
	if (unmetWithoutChange(stats)) return true;
	return totals.calls > 0 && totals.succeeded === 0;
}

/**
 * A dispatch whose task worktree merged changed this workspace as surely as
 * an edit did. Counting only the main agent's own write calls failed a
 * delegated change that landed on the branch as a no-op, whenever an earlier
 * exploratory command had been denied.
 */
export function mergedTaskWorktreeCount(result: unknown): number {
	const runs = (result as { details?: { runs?: unknown } } | undefined)?.details?.runs;
	if (!Array.isArray(runs)) return 0;
	return runs.filter((run) => {
		const placement = (run as { placement?: { mode?: unknown; apply?: unknown; applied?: unknown } } | null)?.placement;
		return placement?.mode === "worktree" && placement.apply === "merge" && placement.applied === true;
	}).length;
}

/**
 * What dispatched runs placed in this checkout changed in it. A batch with a failed or canceled run settles as an
 * error, yet its siblings' edits are already in the workspace, so the run did change it.
 */
export function currentPlacementChangedPaths(result: unknown): string[] {
	const runs = (result as { details?: { runs?: unknown } } | undefined)?.details?.runs;
	if (!Array.isArray(runs)) return [];
	return runs.flatMap((run) => {
		const placement = (run as { placement?: { mode?: unknown; changedPaths?: unknown } } | null)?.placement;
		if (placement?.mode !== "current" || !Array.isArray(placement.changedPaths)) return [];
		return placement.changedPaths.filter((target): target is string => typeof target === "string");
	});
}

/** Distinct paths the run's successful calls wrote, an edit or a shell redirect alike (rcsmoke mini N2), less its report. */
export function writtenPaths(stats: HeadlessMainAgentRunStats): number {
	return [...stats.runEffects.snapshot().mutatedPaths].filter((target) => !stats.reportPaths.has(target)).length;
}

export function changedWorkspace(stats: HeadlessMainAgentRunStats): boolean {
	return writtenPaths(stats) > 0 || stats.mergedTaskWorktrees > 0 || stats.delegatedChangedPaths.size > 0;
}

/** A worker's mutating classes less dispatch, which the main run counts by its merged worktrees instead (C-37). */
export const MAIN_MUTATING_CLASSES: ReadonlySet<string> = new Set([
	"write",
	"execute",
	"system_modify",
	"git_destructive",
	"destructive",
]);

/** A blocked call or a failed dispatch remains, and nothing changed the workspace. */
export function unmetWithoutChange(stats: HeadlessMainAgentRunStats): boolean {
	return (stats.unresolvedBlocks.size > 0 || stats.failedDispatch !== null) && !changedWorkspace(stats);
}

/**
 * Whether a failed dispatch started any worker. A thrown tool error reaches this fold with its details replaced by
 * `{}`, so the dispatch summary's `runs=` line is the witness when the details carry no runs (bt-45 H6).
 */
export function dispatchStartedRuns(event: ChatLoopEvent): boolean {
	const result = (event as { result?: { details?: { runs?: unknown }; content?: unknown } }).result;
	const runs = result?.details?.runs;
	if (Array.isArray(runs) && runs.length > 0) return true;
	return /^runs=\S/mu.test(toolResultText(result?.content));
}

/**
 * The first line of a failed dispatch's reason, bounded, for the run's failure message. A batch's header only counts
 * its runs, so its first failed run's line, less its target through trust attributes, stands in for it (B-56). An
 * operator's cancel is no failure, so a failed run's line goes before a canceled one's, and `canceled` says whether
 * every unsuccessful run was canceled.
 */
export function dispatchFailureReason(event: ChatLoopEvent): { reason: string; canceled: boolean } {
	const reason = (event as { reason?: unknown }).reason;
	const content = (event as { result?: { content?: unknown } }).result?.content;
	const lines = (typeof reason === "string" ? reason : toolResultText(content))
		.split("\n")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	const runLines = lines[0]?.startsWith("dispatch (") ? lines.filter((part) => /^- .*\boutcome=/u.test(part)) : [];
	const failedRun = runLines.find((part) => !/\boutcome=canceled\b/u.test(part)) ?? runLines[0];
	const line = failedRun?.slice(2).replace(/ target=.*?(?= outcome=)/u, "") ?? lines[0] ?? "";
	// A run line ends in its worker cause, so a long one loses its middle, not its end.
	return {
		reason: line.length > 200 ? `${line.slice(0, 99)}…${line.slice(-100)}` : line,
		canceled: runLines.length > 0 && runLines.every((part) => /\boutcome=canceled\b/u.test(part)),
	};
}

export function toolTotals(stats: Map<string, ToolCallStat>): { calls: number; succeeded: number; blocked: number } {
	const totals = { calls: 0, succeeded: 0, blocked: 0 };
	for (const stat of stats.values()) {
		// A notice the spent observation pool returned in a call's place ran nothing, so it is no call here (C-17).
		totals.calls += stat.count - (stat.withheld ?? 0);
		totals.succeeded += stat.ok;
		totals.blocked += stat.blocked;
	}
	return totals;
}

/** Names an answer turn's blocked calls, which the run's exit code no longer reports. */
export function blockedCallsNotice(stats: HeadlessMainAgentRunStats): string | null {
	// A refused ask is a blocked call the operator would have decided, so it is named here too.
	const listed = [...stats.blockedAttempts, ...stats.permissionRequestedAttempts];
	const total = listed.length + stats.blockedAttemptsTruncated;
	if (total === 0) return null;
	const named = listed
		.slice(0, 5)
		.map((attempt) => {
			const why = attempt.ruleId ?? attempt.reasonCode;
			return why === undefined ? attempt.tool : `${attempt.tool} (${why})`;
		})
		.join(", ");
	const rest = total > 5 ? `, and ${total - 5} more` : "";
	return `pancode run: answered with ${total} blocked call${total === 1 ? "" : "s"}: ${named}${rest}`;
}

export function noopFailureMessage(stats: HeadlessMainAgentRunStats, failOnNoop: boolean): string {
	const totals = toolTotals(stats.toolStats);
	const cause =
		stats.unresolvedBlocks.size > 0 && !changedWorkspace(stats)
			? `${totals.blocked} tool call${totals.blocked === 1 ? " was" : "s were"} blocked without recovery and no write succeeded`
			: stats.failedDispatch !== null && !changedWorkspace(stats)
				? `the delegated task ${stats.failedDispatch.canceled ? "was canceled" : stats.failedDispatch.started ? "failed" : "never started"} (${stats.failedDispatch.reason || "dispatch failed"}) and no write succeeded`
				: `${totals.calls} tool call${totals.calls === 1 ? "" : "s"} ran and none succeeded`;
	return `pancode run: no-op${failOnNoop ? " under --fail-on-noop" : ""}: ${cause}`;
}

/** Name the route a failure came from; a refusal before the request or a harness stop came from no route. */
export function prefixHeadlessFailure(
	chat: Pick<ChatLoop, "lastRunSnapshot">,
	message: string,
	notFromRoute = false,
): string {
	if (notFromRoute || message.startsWith(`${SESSION_COST_CEILING_REASON}:`) || runCapStopCode(message) !== undefined)
		return message;
	const snapshot = chat.lastRunSnapshot?.();
	if (!snapshot) return message;
	const route = [snapshot.runtimeId, snapshot.targetUrl].filter(Boolean).join(" ");
	return redactUrlCredentials(
		`target '${snapshot.targetId}' (${route}): ${headlessRouteFailureText(message) ?? message}`,
	);
}
