// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { ToolNames } from "../core/tool-names.js";
import { effectiveToolCall } from "../core/tool-surface.js";
import { SIZE_ONLY_ARG_KEYS } from "./loop-guard-repeat.js";

/** formatModelRejection clips each line at 300 characters, so a quoted failure spans at most two lines under that. */
const PRIOR_FAILURE_LINE_CHARS = 280;
const PRIOR_FAILURE_LINES = 2;

export function stagnationBlockReason(
	tool: string,
	args: Record<string, unknown> | undefined,
	identicalResults: number,
): string {
	// Word the refusal by what the call can change (FX-48): a bash or typed git
	// call has a command and no paging, and only a call carrying size arguments
	// can be told that raising them adds nothing.
	const call = effectiveToolCall(tool, args);
	if (call.toolName === ToolNames.Bash || call.toolName === ToolNames.Git) {
		return (
			`loop detected: the same ${call.toolName} command returned byte-identical output ${identicalResults} times in a row. ` +
			"Change the command or stop repeating it, and answer from the result above if it already says what you need."
		);
	}
	const sizeKeys = [...SIZE_ONLY_ARG_KEYS].filter((key) => call.args?.[key] !== undefined);
	if (sizeKeys.length > 0) {
		return (
			`loop detected: the last ${identicalResults} ${tool} calls returned byte-identical results even though ` +
			`size arguments (${sizeKeys.join("/")}) changed. Raising them is not producing new information. ` +
			`Re-read the result above, change the query or tool, or answer from what you have.`
		);
	}
	return (
		`loop detected: the last ${identicalResults} ${tool} calls with the same arguments returned byte-identical results. ` +
		`Repeating the call is not producing new information. ` +
		`Re-read the result above, change the query or tool, or answer from what you have.`
	);
}

export function crossArgumentResultMessage(tool: string, distinctArguments: number): string {
	return (
		`loop guard: ${distinctArguments} distinct ${tool} arguments returned the same substantial result this turn. ` +
		"The tool may be ignoring an argument; re-read the result, change tools, or answer from what you have."
	);
}

/**
 * The concrete next move for a blocked repeat. "Change strategy" alone left a
 * 27B reviewer repeating one git call after its block, and a read-only scout
 * re-reading the same file a third time (DF-4); a small model follows a named
 * call more reliably than an abstract instruction.
 */
function loopNextMove(tool: string): string {
	if (tool === ToolNames.Git) {
		return (
			'For one commit use args={op:"show",rev:"<commit>"}; for a range use op log or diff with rev:"<a>..<b>". ' +
			"If the result above already answers the question, answer from it."
		);
	}
	if (tool === ToolNames.Read) {
		return "Read a different part with offset, grep for the symbol you need, or answer from what you already read.";
	}
	return "Change the arguments, use a different tool, or answer from the results you already have.";
}

/**
 * Base block reason: names the loop and the next move (block #1). When the
 * same call already returned a successful result earlier this run, the reason
 * says so and points the model at that result: for a weak local model "you
 * already have this answer" is the strongest available anchor. It claims the
 * next call returns the same text only when the last two results matched
 * byte for byte; a stateful tool answers the same arguments differently (F-C13).
 */
export function loopBlockBaseReason(
	tool: string,
	repeatCount: number,
	priorSuccesses: number,
	priorFailure?: string,
	resultsMatched = false,
): string {
	const evidence =
		priorSuccesses > 0
			? `This exact call already succeeded ${priorSuccesses} ${priorSuccesses === 1 ? "time" : "times"} this run, ` +
				`and its result is already in the conversation above${resultsMatched ? "; calling it again returns the same text" : ""}. `
			: "";
	return (
		`loop detected: ${tool} was called ${repeatCount} times with identical arguments among this turn's recent ` +
		// formatModelRejection clips each line at 300 characters; the next move needs its own.
		`tool calls. Repeating the exact call is blocked. ${evidence.trimEnd()}${priorFailureLine(priorFailure)}\nNext: ${loopNextMove(tool)}`
	);
}

/**
 * A model that repeats a call which failed for a stated reason has lost that
 * reason; the block says it again so the fix is in front of the model (WTF-P
 * campaign: an extension asked for expect_revision three times).
 */
export function priorFailureLine(priorFailure: string | undefined): string {
	return priorFailure === undefined
		? ""
		: `\nThe identical call failed earlier with:\n${priorFailure}\nFix what that error names before calling it again.`;
}

/**
 * The failure's first paragraph on at most two lines. A validator's header
 * line ends in a colon and names nothing; the fields it rejected follow on
 * their own lines, so quoting only the first line restated "Validation failed
 * for tool ..." and dropped every field (WTF-P campaign). The echoed arguments
 * after the first blank line stay out.
 */
export function clipFailure(message: string): string | undefined {
	const paragraph: string[] = [];
	for (const raw of message.split("\n")) {
		const entry = raw.trim();
		if (entry.length === 0) {
			if (paragraph.length > 0) break;
			continue;
		}
		paragraph.push(paragraph.length === 0 ? entry : entry.replace(/^-\s+/, ""));
	}
	if (paragraph.length === 0) return undefined;
	const [head, ...rest] = paragraph;
	const text = rest.length === 0 ? (head as string) : `${head} ${rest.join("; ")}`;
	const budget = PRIOR_FAILURE_LINE_CHARS * PRIOR_FAILURE_LINES;
	const clipped = text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
	const lines: string[] = [];
	for (let start = 0; start < clipped.length; start += PRIOR_FAILURE_LINE_CHARS) {
		lines.push(clipped.slice(start, start + PRIOR_FAILURE_LINE_CHARS));
	}
	return lines.join("\n");
}

/** Blocked-call result text for the backstop stop (the operator sees loopBlockedStopReason). */
export function synthesisBackstopReason(tool: string): string {
	return (
		`loop guard: tool calls stayed disabled and ${tool} was called again instead of answering, so the turn is ` +
		"being stopped. Summarize what you found for the operator."
	);
}

/**
 * Recognizes the synthesis-backstop stop reason on surfaces without a bus.
 * Workers watch blocked tool-finish events for this reason (the same seam as
 * the lifetime cap) and abort the run: without it, the "stop" disposition is
 * bus-only and a worker that ignores the lockout would keep burning calls
 * until the lifetime cap. Measured on a live 35B coder worker: one identical
 * code_nav loop consumed the full 50-call cap (46 blocked calls, ~345k
 * tokens) before this abort path existed.
 */
export function isLoopGuardSynthesisBackstopReason(reason: string): boolean {
	return /^loop guard: tool calls stayed disabled and .+ was called again instead of answering/.test(reason);
}

/** Tools named in the budget refusal; one model-visible line stays under the 300-character clip. */
const BUDGET_BY_TOOL_LIMIT = 6;

/**
 * Where a turn's calls went, most used first. A prompt template that runs a
 * multi-step workflow learns from it which steps spent the budget, so its
 * summary can say where it stopped (WTF-P /wtfp:advance, 2026-11-15).
 */
function turnCallsByTool(byTool: ReadonlyMap<string, number>): string {
	const ranked = [...byTool].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
	const shown = ranked.slice(0, BUDGET_BY_TOOL_LIMIT).map(([tool, calls]) => `${tool} ${calls}`);
	const rest = ranked.slice(BUDGET_BY_TOOL_LIMIT).reduce((sum, [, calls]) => sum + calls, 0);
	return `This turn's calls by tool: ${shown.join(", ")}${rest > 0 ? `, other ${rest}` : ""}.`;
}

/**
 * What a soft-budget refusal asks of the model. When a continuation turn
 * follows (yolo), the reply is a progress note, never a closing summary: a lane
 * that read the old wording ended on "both items are fixed" while the refused
 * checks waited for the continuation (CLI-H1).
 */
export function turnBudgetRefusalTail(continues: boolean, byTool: ReadonlyMap<string, number>): string {
	const next = continues
		? `A continuation turn follows automatically with a fresh tool budget and runs the next calls. End this reply ` +
			`with a short progress note: what is done, and the calls the continuation must run, including any refused here. ` +
			`Do not claim the work is finished.`
		: `Summarize what you have found so far in the required result format, state the single next step you propose, ` +
			`and end your reply.`;
	return (
		`Every further tool call this turn will be blocked, so do not retry these calls and do not substitute ` +
		`others. ${next}\n${turnCallsByTool(byTool)}`
	);
}

/**
 * The refusal a step-policy turn gets once its step tool already ran: the call
 * did not run, tools are locked, and the reply is the state summary the next
 * turn starts from (WTF-P 0.8.3 C5).
 */
export function stepPolicyReason(stepTool: string, template: string | undefined): string {
	return (
		`turn policy: ${template ? `prompt template "${template}"` : "this turn's template"} runs one step per turn, and this turn ` +
		`already ran its ${stepTool} step, so this call did not run and tools are locked for the rest of the turn. ` +
		`End the turn now with a compact state summary: the step you ran, its outcome, what changed, and the after value ` +
		`for the next ${stepTool} call. The next turn starts the next step.`
	);
}

/**
 * The refusal a step-tool call gets while another call of it in the same turn
 * is admitted and not yet finished, as a sibling in one parallel batch is:
 * only one step runs per turn, and the first call's step is the one to run.
 */
export function parallelStepReason(stepTool: string, template: string | undefined): string {
	return (
		`turn policy: ${template ? `prompt template "${template}"` : "this turn's template"} runs one step per turn, and ` +
		`another ${stepTool} call in this turn is already running, so this call did not run. Run the step that call ` +
		"returns, then end the turn with a compact state summary."
	);
}
