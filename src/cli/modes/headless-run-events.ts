// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { modelRouteRefusalOf } from "../../core/response-model-id.js";
import { skillActivationFromToolDetails } from "../../core/skill-activation.js";
import { type BuiltinToolName, ToolNames } from "../../core/tool-names.js";
import { settledVerifyCall, verifyCallStart } from "../../domains/dispatch/run-findings.js";
import { resultNotExecuted } from "../../domains/dispatch/tool-stats.js";
import type { SafetyBlockedAttempt, ToolCallStat } from "../../domains/dispatch/types.js";
import { describeMissing, missingFromFailedCall } from "../../domains/lifecycle/setup-status.js";
import { CITATION_CHECK_PREFIX } from "../../domains/safety/citation-grounding.js";
import { type RunEffectsRecorder, recordToolExecutionEffects } from "../../domains/safety/run-effects.js";
import { SAFETY_JUDGE_ALLOW_REASON_CODE } from "../../domains/safety/safety-judge.js";
import { callRepeatsAsRead } from "../../engine/loop-guard.js";
import type { AgentMessage } from "../../engine/types.js";
import { redactUrlCredentials } from "../../lib/secrets/redaction.js";
import type { ChatLoopEvent } from "../../session-control/chat-loop.js";
import {
	CONTEXT_OVERFLOW_STOP_NOTICE_KEY,
	classifyTurnEnding,
	isContextGuardStop,
	isThinkingOnlyLengthStop,
	turnCallsNotRunSentence,
	turnNoAnswerSentence,
} from "../../session-control/chat-loop-messages.js";
import { completionOfToolResult } from "../../tools/finish.js";
import { TOOL_PLANES } from "../../tools/policy.js";
import { toolResultText } from "../../tools/result-disposition.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../tools/surface.js";
import { answerAfterCitationCheck, replySegment, type TurnAnswerEntry, turnAnswer } from "./answer-segments.js";
import type { HeadlessMainAgentResult, HeadlessMainAgentRunStats } from "./headless-run-types.js";
import {
	currentPlacementChangedPaths,
	dispatchFailureReason,
	dispatchStartedRuns,
	MAIN_MUTATING_CLASSES,
	mergedTaskWorktreeCount,
} from "./headless-run-verdict.js";
import type { RunJsonMainFrame } from "./run-json-schema.js";

/**
 * Bounds on `safety.blockedAttempts`. A model retrying a denied call appends
 * an entry per attempt, each carrying the full rejection text, so the list is
 * capped and each reason clipped. Attempts past the cap are counted in
 * `safety.blockedAttemptsTruncated`; the per-tool blocked counts in
 * `toolStats` stay exact either way.
 */
export const BLOCKED_ATTEMPTS_LIMIT = 50;
export const BLOCKED_ATTEMPT_REASON_MAX_CHARS = 500;

/** Append one blocked attempt within the bounds above. */
export function recordBlockedAttempt(
	stats: { blockedAttempts: SafetyBlockedAttempt[]; blockedAttemptsTruncated: number },
	attempt: SafetyBlockedAttempt,
): void {
	if (stats.blockedAttempts.length >= BLOCKED_ATTEMPTS_LIMIT) {
		stats.blockedAttemptsTruncated += 1;
		return;
	}
	// A reason can quote the refused call, and redacted ahead of its bound, which could cut a password out of the pattern's sight (#446).
	const reason = attempt.reason === undefined ? undefined : redactUrlCredentials(attempt.reason);
	stats.blockedAttempts.push(
		reason === undefined
			? attempt
			: {
					...attempt,
					reason:
						reason.length > BLOCKED_ATTEMPT_REASON_MAX_CHARS
							? `${reason.slice(0, BLOCKED_ATTEMPT_REASON_MAX_CHARS)}…`
							: reason,
				},
	);
}

/**
 * The run's one answer: what text mode prints, `-o` holds, `--output-schema` judges and the v2 envelope's `result.text`
 * carries (CLI-P43). A turn that ended quietly has none. An artifact's terminating result is the whole answer, so
 * chatter before it is not; `finish` closes the turn's replies, which stand, and its own result (`completion declared:
 * ...`) is never the answer (CLI-P49): a turn that wrote no reply has none, and its declaration carries that.
 */
export function printedAnswer(result: HeadlessMainAgentResult): string {
	if (result.endedQuietly && !result.sawTerminatingToolResult) return "";
	if (!result.sawTerminatingToolResult) return result.text;
	if (result.terminatedByFinish) return result.text;
	return result.terminatingToolText.length > 0 ? result.terminatingToolText : result.text;
}

export function assistantError(message: AgentMessage | undefined): string | null {
	if (!message || typeof message !== "object" || message.role !== "assistant") return null;
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return null;
	const raw = (message as { errorMessage?: unknown }).errorMessage;
	// A request that never reached the endpoint ends with the setup status's sentence, the one the banner and doctor print.
	const route = (message as { failureRoute?: Parameters<typeof missingFromFailedCall>[0] }).failureRoute;
	const unanswered = typeof route?.targetId === "string" ? missingFromFailedCall(route) : null;
	const fix = unanswered !== null ? ` ${describeMissing(unanswered).sentence}` : "";
	// A provider's error can quote the URL it failed on, and from here it reaches stderr, the frame and the run record (#446).
	if (typeof raw === "string" && raw.length > 0)
		return redactUrlCredentials(fix && !/[.!?]$/u.test(raw.trim()) ? `${raw.trim()}.${fix}` : `${raw}${fix}`);
	return stopReason === "aborted" ? "request aborted" : "provider returned an error";
}

/**
 * Fold one chat-loop event into the turn's result. Derivation keys on event
 * types and stop reasons only: notices are typed `notice` events and can
 * never masquerade as the assistant's answer, and an assistant message is
 * the answer only when its stop reason is not a failure.
 */
/**
 * A full stream's answer turn_end, carrying the checked answer by the same rule as stdout and the terminal turn_end:
 * a reply of only "citations confirmed" otherwise left scripts reading `turn_end.message` without the answer (bt-29).
 */
export function turnEndAfterCitationCheck(frame: RunJsonMainFrame, checked: string | null): RunJsonMainFrame {
	if (checked === null || frame.type !== "turn_end" || !("message" in frame) || frame.message.role !== "assistant")
		return frame;
	const content = frame.message.content;
	// A reply beside `finish` is a reply too, by the answer's own rule (CLI-P43).
	if (replySegment(frame.message) === null) return frame;
	const texts = content.flatMap((block) =>
		block.type === "text" && typeof block.text === "string" ? [block.text] : [],
	);
	const reply = texts.join("").trimEnd();
	const answer = answerAfterCitationCheck(checked, reply);
	if (answer === reply || !answer.endsWith(reply)) return frame;
	const prefix = answer.slice(0, answer.length - reply.length);
	const first = content.findIndex((block) => block.type === "text" && typeof block.text === "string");
	const merged = content.map((block, index) => {
		if (index !== first || block.type !== "text") return block;
		const text = `${prefix}${block.text ?? ""}`;
		return { ...block, text, textLength: text.length };
	});
	return { ...frame, message: { ...frame.message, content: merged } };
}

export function resultFromEvent(event: ChatLoopEvent, current: HeadlessMainAgentResult): HeadlessMainAgentResult {
	if (event.type === "tool_execution_end") {
		const result = event.result as { terminate?: boolean; content?: unknown } | undefined;
		const terminate = result?.terminate === true && !event.isError;
		const completion = event.isError ? null : completionOfToolResult(event.toolName, event.result);
		// `finish` closes the turn's replies, which stay the answer (CLI-P43); its own result stands only for a turn
		// that wrote nothing.
		return {
			...current,
			...(completion !== null ? { completion } : {}),
			sawTerminatingToolResult: terminate,
			terminatedByFinish: terminate && completion !== null,
			terminatingToolText: terminate ? toolResultText(result?.content) : "",
		};
	}
	if (event.type === "notice") {
		if (event.surface !== "transcript") return current;
		const text = redactUrlCredentials(event.text);
		// Every admission notice ends the turn before the provider is called. Only
		// the image case used to count as a failure, so an empty home's "not
		// configured" notice was chased by "provider stream ended without an
		// assistant response", which blamed a provider nobody had reached.
		if (event.admission !== undefined) {
			// The window refused the request before any call: the run ends on context_overflow, not run_failed.
			const contextOverflow = event.admission.reason === "context-window-exceeded" ? "guard" : current.contextOverflow;
			return { ...current, lastNotice: text, error: text, admissionRefused: true, contextOverflow };
		}
		if (event.memory !== undefined) {
			const refused = event.level === "warning" || event.level === "error";
			return { ...current, lastNotice: text, operatorMemory: { refused, text } };
		}
		if (event.key === "turn.interrupted") {
			// A redirect or a budget roll closes the cut-short run; the run that follows carries the answer (bt-41, XR-6).
			return event.redirect === true
				? { ...current, lastNotice: text }
				: { ...current, lastNotice: text, abortReason: text };
		}
		if (event.text.startsWith(CITATION_CHECK_PREFIX) && current.text.length > 0) {
			return withAnswerEntries({ ...current, lastNotice: text, citationCheckedAnswer: current.text }, [
				...current.answerEntries,
				{ kind: "citation_check" },
			]);
		}
		if (event.key === CONTEXT_OVERFLOW_STOP_NOTICE_KEY)
			return { ...current, lastNotice: text, contextOverflow: "recovery" };
		return { ...current, lastNotice: text };
	}
	if (event.type === "agent_end") {
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const ending = classifyTurnEnding(messages);
		// A round the host forced after a reply (the finish round) that wrote nothing leaves the reply as the answer.
		const answer = turnAnswer(current.answerEntries);
		return {
			...current,
			// A model turn ran, so a remember statement beside it is not the run's result.
			operatorMemory: null,
			// The written calls are stated on stderr; the answer already holds only the prose before them.
			text: answer.text,
			narration: answer.narration,
			noAnswer: ending?.kind === "no_answer" ? turnNoAnswerSentence(ending) : null,
			endedQuietly: ending?.kind === "quiet" && !answer.replied,
			callsNotRun: ending?.kind === "call_not_run" ? turnCallsNotRunSentence(ending) : null,
		};
	}
	if (event.type !== "message_end") return current;
	const message = event.message;
	// The operator's prompt, a steer, a redirect or a repair starts the user turn whose replies are the answer
	// (CLI-P43). A retry or recovery inside the turn sends no user message, and the one that delivers a citation check
	// keeps the turn it checks.
	if (message?.role === "user") {
		if (current.answerEntries.at(-1)?.kind === "citation_check") return current;
		return withAnswerEntries({ ...current, citationCheckedAnswer: null }, []);
	}
	if (message?.role !== "assistant") return current;
	current = {
		...current,
		noAnswer: null,
		endedQuietly: false,
		callsNotRun: null,
		outputExhausted: message.stopReason === "length",
		sawTerminatingToolResult: false,
		admissionRefused: false,
		harnessStopped: (message as { harnessStopped?: unknown }).harnessStopped === true,
		contextOverflow: isContextGuardStop(message) ? "guard" : null,
		modelRouteRefusal: modelRouteRefusalOf(message),
		thinkingOnlyLength: isThinkingOnlyLengthStop(message),
	};
	const entries = [...current.answerEntries, { kind: "message" as const, message }];
	// A successful retry may contain only tool calls. It supersedes the prior
	// provider error even without prose; the terminal tool/answer checks still
	// decide whether the task completed. Tool-result messages cannot clear it.
	return withAnswerEntries({ ...current, error: assistantError(message) }, entries);
}

/** The turn's answer entries and the replies and narration they give; neither is written any other way (CLI-P43). */
function withAnswerEntries(
	current: HeadlessMainAgentResult,
	answerEntries: TurnAnswerEntry[],
): HeadlessMainAgentResult {
	const answer = turnAnswer(answerEntries);
	return { ...current, answerEntries, text: answer.text, narration: answer.narration };
}

function blankToolStat(tool: string): ToolCallStat {
	return { tool, count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0 };
}

function durationMsFromEvent(event: ChatLoopEvent): number | undefined {
	const value = (event as { durationMs?: unknown }).durationMs;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Fold one tool event into the run's effects; a headless finish carries its registry outcome on the end event. */
export function recordRunEffect(recorder: RunEffectsRecorder, event: ChatLoopEvent): void {
	const outcome = (event as { outcome?: unknown }).outcome;
	if (event.type === "tool_execution_end" && (outcome === "ok" || outcome === "error" || outcome === "blocked"))
		recorder.checkOutcome(event.toolCallId, outcome, (event as { unresolved?: unknown }).unresolved === true);
	recordToolExecutionEffects(recorder, event);
}

/** The typed reason a `limitation` result recorded in its details, or undefined when it carries none. */
function recordedLimitationReason(result: unknown): unknown {
	const details = (result as { details?: { limitation?: { reason?: unknown } } } | null | undefined)?.details;
	return details?.limitation?.reason;
}

export function recordToolEnd(stats: HeadlessMainAgentRunStats, event: ChatLoopEvent): void {
	if (event.type === "tool_execution_start") {
		const call = effectiveToolCall(event.toolName, event.args);
		stats.pendingCapabilities.set(event.toolCallId, call.toolName);
		if (callRepeatsAsRead(event.toolName, event.args, () => undefined)) stats.readingCalls.add(event.toolCallId);
		if (call.toolName === ToolNames.Verify) stats.pendingVerifyCalls.set(event.toolCallId, verifyCallStart(call.args));
		return;
	}
	if (event.type !== "tool_execution_end") return;
	const tool = stats.pendingCapabilities.get(event.toolCallId) ?? event.toolName ?? "tool";
	stats.pendingCapabilities.delete(event.toolCallId);
	const reads = stats.readingCalls.delete(event.toolCallId);
	// A call the output limit cut off never ran: its run's one notice states it, and it is no tool error (bt-39 a).
	if ((event as { notRun?: unknown }).notRun !== undefined) {
		stats.pendingVerifyCalls.delete(event.toolCallId);
		return;
	}
	// Fold completed child operations into accounting only. The provider and
	// session history retain the real aggregate call/result pair.
	const children = gatewayChainReceipts(event.toolName, event.result);
	for (const child of children) {
		const toolCallId = `${event.toolCallId}:${child.id}`;
		if (child.capability === ToolNames.Verify) stats.pendingVerifyCalls.set(toolCallId, verifyCallStart(child.args));
		if (callRepeatsAsRead(child.capability, child.args, () => undefined)) stats.readingCalls.add(toolCallId);
		recordToolEnd(stats, {
			type: "tool_execution_end",
			toolCallId,
			toolName: child.capability,
			isError: child.admission.outcome !== "ok",
			result: { ...child.result, terminate: child.admission.terminate === true },
			...child.admission,
		} as ChatLoopEvent);
	}
	// Registry settlement is authoritative; an event without an outcome exposes only isError.
	const outcome = (event as { outcome?: unknown }).outcome;
	// A chain's settled steps were just counted as the calls they are. Counting
	// the wrapper too made an N-step chain N + 1 calls and one failed step two
	// errors (bt-14); a chain none of whose steps settled still counts once.
	if (children.length === 0) {
		const stat = stats.toolStats.get(tool) ?? blankToolStat(tool);
		const okBefore = stat.ok;
		stat.count += 1;
		const durationMs = durationMsFromEvent(event);
		if (durationMs !== undefined) stat.totalDurationMs += durationMs;
		// A notice the spent observation pool returned in place of the call is withheld, not ok (C-17).
		const withheld = resultNotExecuted(event.result) === "observation_budget";
		if (outcome === "blocked") stat.blocked += 1;
		else if (outcome === "error") stat.errors += 1;
		else if ((outcome === "ok" || (outcome === undefined && !event.isError)) && withheld)
			stat.withheld = (stat.withheld ?? 0) + 1;
		else if (outcome === "ok") stat.ok += 1;
		else if (outcome === undefined) {
			if (event.isError) stat.errors += 1;
			else stat.ok += 1;
		}
		stats.toolStats.set(tool, stat);
		if (tool === ToolNames.Limitation && stat.ok > okBefore && recordedLimitationReason(event.result) !== "no-runner")
			stats.incompleteLimitations += 1;
	}
	if (tool === ToolNames.Verify) {
		stats.verifyCalls.push(
			settledVerifyCall(
				stats.pendingVerifyCalls.get(event.toolCallId),
				// A check name that resolved to nothing ran nothing, as in a worker's receipt, so it seals no failed validation.
				outcome === "error" && (event as { unresolved?: unknown }).unresolved === true
					? "unresolved"
					: outcome === "ok" || outcome === "error" || outcome === "blocked"
						? outcome
						: outcome === undefined
							? event.isError
								? "error"
								: "ok"
							: null,
				event.toolCallId,
			),
		);
		stats.pendingVerifyCalls.delete(event.toolCallId);
	}
	// Safety bookkeeping mirrors a worker's fold of its own tool
	// finish events (domains/dispatch/extension.ts), so the two runs carry
	// the same facts under the same names.
	const detail = event as {
		ruleId?: unknown;
		reasonCode?: unknown;
		policySource?: unknown;
		blockReason?: unknown;
		deniedPark?: unknown;
		redundantRepeat?: unknown;
		denial?: { layer?: unknown; code?: unknown };
	};
	const decision = (event as { decision?: unknown }).decision;
	// A call that parked for approval and was denied because a headless run has
	// no operator arrives as a registry block: parkAnsweredBlockedVerdict
	// rewrites the ask. The summary's contract counts that call as a permission
	// request, which is where a worker's non-interactive denial lands, so the
	// registry's `deniedPark` flag routes it there. The flag, not the reason
	// text, is the signal: the loop guard replaces the reason of a repeated
	// denied call with its own guidance. `decisions.blocked` keeps meaning a
	// hard block by a rule, and a tool guard's block counts as `guardBlocked`.
	const deniedAsk = decision === "blocked" && detail.deniedPark === true;
	const permissionAsk = decision === "permission_requested" || deniedAsk;
	const guardBlock = decision === "blocked" && !deniedAsk && detail.reasonCode === "guard_block";
	if (decision === "allowed") stats.decisions.allowed += 1;
	else if (permissionAsk) stats.decisions.permissionRequested += 1;
	else if (guardBlock) stats.decisions.guardBlocked += 1;
	else if (decision === "blocked") stats.decisions.blocked += 1;
	const actionClass = (event as { actionClass?: unknown }).actionClass;
	// An ask the safety judge allowed ran without anyone answering it; the record names the rule it ran under.
	if (
		decision === "allowed" &&
		typeof detail.reasonCode === "string" &&
		detail.reasonCode.startsWith(`${SAFETY_JUDGE_ALLOW_REASON_CODE}:`)
	) {
		const attempt: SafetyBlockedAttempt = { tool, reasonCode: detail.reasonCode };
		if (typeof actionClass === "string") attempt.actionClass = actionClass;
		if (typeof detail.ruleId === "string") attempt.ruleId = detail.ruleId;
		if (typeof detail.policySource === "string") attempt.policySource = detail.policySource;
		recordBlockedAttempt({ blockedAttempts: stats.judgeAllowedAttempts, blockedAttemptsTruncated: 0 }, attempt);
	}
	if (outcome === "blocked" || decision === "blocked") {
		const attempt: SafetyBlockedAttempt = { tool };
		if (typeof actionClass === "string") attempt.actionClass = actionClass;
		if (typeof detail.ruleId === "string") attempt.ruleId = detail.ruleId;
		if (typeof detail.reasonCode === "string") attempt.reasonCode = detail.reasonCode;
		if (typeof detail.policySource === "string") attempt.policySource = detail.policySource;
		if (typeof detail.blockReason === "string") attempt.reason = detail.blockReason;
		if (permissionAsk) attempt.permissionRequired = true;
		const layer = detail.denial?.layer;
		if (layer === "pancode_policy" || layer === "operator_approval" || layer === "mcp_server_policy")
			attempt.layer = layer;
		// A guard's block lists apart from the safety refusals, the way `decisions` counts it (bt-15 c12b).
		if (guardBlock)
			recordBlockedAttempt({ blockedAttempts: stats.guardBlockedAttempts, blockedAttemptsTruncated: 0 }, attempt);
		// So does a refused ask, such as one a --timeout abort denied before anyone decided (bt-15 c13a).
		else if (permissionAsk) {
			stats.permissionRequestedByTool.set(tool, (stats.permissionRequestedByTool.get(tool) ?? 0) + 1);
			recordBlockedAttempt({ blockedAttempts: stats.permissionRequestedAttempts, blockedAttemptsTruncated: 0 }, attempt);
		} else recordBlockedAttempt(stats, attempt);
	}
	// A terminating result (the artifact tool's plan, review, or report) is the
	// turn's answer written to a file, not the workspace change the task asked
	// for. Counting it let a run whose every edit was blocked seal as a success
	// by writing a report about the failure. `terminate` is the registry's own
	// marker for that kind of result and survives the gateway hop, where the
	// call's tool name is `gateway` rather than `artifact`.
	const terminating = (event.result as { terminate?: unknown } | undefined)?.terminate === true;
	const action = typeof actionClass === "string" ? actionClass : "unknown";
	// A withheld duplicate of a read that already succeeded adds nothing
	// unresolved: its result is in the conversation, and the guard's own advice
	// is to answer from it. Only a guard block of the read class is excused, on
	// the registry's typed flag and never for a refused ask. A repeated command
	// or write is still an unmet attempt, an earlier unresolved read stays
	// unresolved, and the call is counted as blocked everywhere else here.
	const withheldDuplicateRead =
		outcome === "blocked" &&
		detail.redundantRepeat === true &&
		detail.reasonCode === "guard_block" &&
		detail.deniedPark !== true &&
		actionClass === "read";
	// The host's read-only ceiling refuses every call that is not a read, by
	// the operator's own choice: `run --read-only "explain X"` asked for an
	// answer, not a change, so a write or command the model tried is no unmet
	// part of the task. The refusal stays in the run's blocked attempts.
	const readOnlyCeiling = detail.reasonCode === "task:read_only" || detail.denial?.code === "task:read_only";
	if (outcome === "blocked" || decision === "blocked") {
		if (!withheldDuplicateRead && !readOnlyCeiling) stats.unresolvedBlocks.add(action);
	} else if (outcome === "ok" || (outcome === undefined && !event.isError)) {
		// A read-only command reads, and a check is the validation itself, not a change to validate.
		if (!terminating && !reads && tool !== ToolNames.Verify && MAIN_MUTATING_CLASSES.has(action))
			stats.mutatingSucceeded = true;
		const capability =
			tool === ToolNames.Gateway
				? (event.result as { details?: { capability?: unknown } } | undefined)?.details?.capability
				: tool;
		const plane =
			typeof capability === "string" && Object.hasOwn(TOOL_PLANES, capability)
				? TOOL_PLANES[capability as BuiltinToolName].plane
				: undefined;
		// A later alternate read/command can recover its blocked action class.
		// Bookkeeping, discovery, limitation, and terminal reports cannot.
		if (
			!terminating &&
			capability !== ToolNames.Context &&
			capability !== ToolNames.CredentialPresent &&
			(plane === "observe" || plane === "retrieve" || plane === "execute" || plane === "mutate")
		) {
			stats.unresolvedBlocks.delete(action);
			stats.failedDispatch = null;
			// A read may be useful progress after a denied command, but cannot
			// attest that command's requirement (for example a test) was met.
			// An independent task verifier can accept an alternate workflow;
			// this event fold has no authority to infer semantic substitution.
		}
	}
	const reported = (event.result as { details?: { paths?: unknown } } | undefined)?.details?.paths;
	if (terminating && Array.isArray(reported)) for (const target of reported) stats.reportPaths.add(String(target));
	if (outcome === "ok" && tool === ToolNames.Dispatch)
		stats.mergedTaskWorktrees += mergedTaskWorktreeCount(event.result);
	if (tool === ToolNames.Dispatch) {
		for (const target of currentPlacementChangedPaths(event.result)) stats.delegatedChangedPaths.add(target);
		if (outcome === "ok" || (outcome === undefined && !event.isError)) stats.failedDispatch = null;
		else if (outcome === "error" || outcome === undefined)
			stats.failedDispatch = { ...dispatchFailureReason(event), started: dispatchStartedRuns(event) };
	}
	if (tool === ToolNames.Context) {
		const rawTurnId = (event as { turnId?: unknown }).turnId;
		const turnId = typeof rawTurnId === "string" ? rawTurnId : undefined;
		const activation = skillActivationFromToolDetails(
			(event.result as { details?: unknown } | undefined)?.details,
			turnId,
		);
		if (activation) stats.skillActivations.push(activation);
	}
}
