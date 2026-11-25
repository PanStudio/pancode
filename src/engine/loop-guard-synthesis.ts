// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { markHostAuthored } from "../core/message-accounting.js";
import { systemReminderBlock, TOOL_RESULT_NOTES_SEPARATOR, toolResultNote } from "../core/reminder-framing.js";
import { stripDeadToolCallMarkup } from "../core/tool-call-markup.js";
import { priorFailureLine } from "./loop-guard-reasons.js";
import type { AgentMessage } from "./types.js";

/** True when a sanitized locked reply holds nothing but the fallback notice. */
export function isLockedSynthesisFallbackOnly(message: AgentMessage | undefined): boolean {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return false;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	const text = content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
		.trim();
	return text === lockedSynthesisFallbackText();
}

export const LOCKED_SYNTHESIS_REPROMPT_TOOL = "pancode_synthesis_reprompt";

const LOCKED_SYNTHESIS_PHASE = "Current execution phase: final synthesis";
const LOCKED_SYNTHESIS_DIRECTIVE =
	"Tools are disabled for the rest of this run. Earlier instructions to use tools apply only to the completed tool phase. Do not emit tool calls or tool-call markup. Return the final result now using the evidence already observed; preserve all safety rules and the required result format. Do not invent missing evidence.";

/**
 * The final-synthesis directive. It retires the earlier tool-use phase while
 * preserving the task and safety contract; a worker's locked round names its
 * required terminal result.
 */
export function lockedSynthesisDirective(requiredResult?: string): string {
	return [
		`${LOCKED_SYNTHESIS_PHASE}. ${LOCKED_SYNTHESIS_DIRECTIVE}`,
		...(requiredResult ? [`Required terminal result: ${requiredResult}`] : []),
	].join("\n\n");
}

type RequestMessage = { role: string; content?: unknown; timestamp?: unknown };

/**
 * A locked round, in the main loop or a worker: the synthesis directive rides
 * the tail of the outgoing copy, so the system prompt and every earlier message keep the bytes
 * an unlocked round sends and a prefix cache survives entering and leaving the
 * round. A trailing tool result, the usual last message after a tool batch,
 * gets it as a host note; a trailing user message gets a `<system-reminder>`
 * block; anything else gets a reminder user message at the end. The copy is
 * request-only and the same on every attempt; the caller never persists it.
 */
export function withLockedSynthesisDirective<C extends { messages: ReadonlyArray<unknown> }>(
	context: C,
	requiredResult?: string,
): C {
	return withRequestTailDirective(context, lockedSynthesisDirective(requiredResult));
}

/** Any request-only host directive, placed on the tail the way the locked-synthesis directive is. */
export function withRequestTailDirective<C extends { messages: ReadonlyArray<unknown> }>(
	context: C,
	directive: string,
): C {
	const messages = [...context.messages] as RequestMessage[];
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role === "system") index -= 1;
	const last = messages[index];
	if (last?.role === "toolResult") {
		const note = toolResultNote("warn", directive);
		const content = Array.isArray(last.content) ? [...(last.content as Array<{ type?: unknown; text?: unknown }>)] : [];
		const tail = content.at(-1);
		if (tail?.type === "text" && typeof tail.text === "string")
			content[content.length - 1] = { ...tail, text: `${tail.text}${TOOL_RESULT_NOTES_SEPARATOR}${note}` };
		else content.push({ type: "text", text: note });
		messages[index] = { ...last, content };
	} else if (last?.role === "user") {
		const block = systemReminderBlock([directive]);
		messages[index] = {
			...last,
			content:
				typeof last.content === "string"
					? `${last.content}\n\n${block}`
					: [...(Array.isArray(last.content) ? last.content : []), { type: "text", text: block }],
		};
	} else {
		messages.push({ role: "user", content: systemReminderBlock([directive]), timestamp: last?.timestamp ?? 0 });
	}
	return { ...context, messages };
}

/**
 * One bounded re-prompt after a locked round came back as tool-call markup
 * only. Delivered as a paired synthetic tool exchange, never a user turn, for
 * the same reason the result-contract repair is (#55: a late user message
 * re-renders every earlier assistant turn on templates keyed off the last
 * user message and invalidates the whole prompt cache).
 */
export function lockedSynthesisRepromptMessages(
	attempt: number,
	origin: { provider: string; api: string; model: string },
	requiredResult?: string,
): ReadonlyArray<AgentMessage> {
	const id = `pancode-synthesis-reprompt-${attempt}`;
	const timestamp = Date.now();
	return [
		markHostAuthored({
			role: "assistant",
			content: [{ type: "toolCall", id, name: LOCKED_SYNTHESIS_REPROMPT_TOOL, arguments: {} }],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				// PanCode wrote this message; no provider was called for it. Receipts
				// and journals count only calls that reached one.
				callInvoked: false,
			},
			...origin,
			timestamp,
		} as AgentMessage),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: LOCKED_SYNTHESIS_REPROMPT_TOOL,
			content: [
				{
					type: "text",
					text:
						"Your previous reply contained only tool-call markup, which cannot run: tool calls are disabled for " +
						"the rest of this run. Everything you gathered is already in the conversation above. Write the " +
						"final answer now in the required result format (JSON when a result contract requires it; otherwise prose), with no tool-call " +
						"markup of any kind." +
						(requiredResult ? `\nRequired terminal result: ${requiredResult}` : ""),
				},
			],
			isError: true,
			timestamp,
		},
	] as unknown as ReadonlyArray<AgentMessage>;
}

/**
 * Directive returned when a turn is locked to synthesis: tool use is over, so
 * the model must answer from what it already gathered. Fed back to the model as
 * the blocked call's result; the agent loop ends naturally on the first round
 * that emits text without a tool call.
 */
export function synthesisLockoutDirective(priorFailure?: string): string {
	return (
		// One line per instruction: formatModelRejection clips each line at 300 characters.
		"loop guard: this turn reached its tool-call limit after repeated identical calls, so tool calls are now " +
		`disabled for the rest of this turn. Everything you retrieved is already in the conversation above.${priorFailureLine(priorFailure)}\nAnswer ` +
		"now from what you have gathered, preserving the required result format (JSON for a JSON result contract; otherwise prose).\nDo not write tool-call markup such as " +
		"<tool_call> blocks; tool calls are disabled and will not run."
	);
}

/**
 * Final-answer replacement when a locked turn's reply was nothing but dead
 * tool-call markup. Rendered as the assistant turn (TUI, headless result,
 * session ledger), so it explains the stop the way the loop-guard closing
 * messages do.
 */
export function lockedSynthesisFallbackText(): string {
	return (
		"[PanCode] loop guard: tool calls were disabled for the rest of this turn, but the reply contained only " +
		"tool-call markup, which cannot run and was removed. The turn stopped without a usable answer."
	);
}

/**
 * Sanitize the assistant message a synthesis-locked turn produced: strip dead
 * tool-call markup from its text blocks and fall back to
 * {@link lockedSynthesisFallbackText} when nothing remains. Mutates the message
 * in place; pi stores the same object in agent state before listeners run, so
 * one mutation at the subscribe seam covers the emitted event, the session
 * ledger, receipts, and the next round's provider payload without any surface
 * re-implementing the rule. Returns whether the message changed.
 *
 * Deliberately narrow: only assistant messages that finished ("stop", or
 * "length" for a mid-markup cutoff) with no structured tool call are touched.
 * Aborted and error messages keep their text (their flows carry their own
 * closing messages), and callers gate on the lockout being active so ordinary
 * turns and user text are never sanitized.
 */
export function sanitizeLockedSynthesisMessage(message: AgentMessage | undefined): boolean {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return false;
	const record = message as { content?: unknown; stopReason?: unknown };
	const stopReason = record.stopReason;
	if (stopReason !== undefined && stopReason !== "stop" && stopReason !== "length") return false;
	if (!Array.isArray(record.content)) return false;
	const blocks = record.content as Array<{ type?: unknown; text?: unknown }>;
	if (blocks.some((block) => block?.type === "toolCall")) return false;
	let changed = false;
	for (const block of blocks) {
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const stripped = stripDeadToolCallMarkup(block.text);
		if (stripped !== block.text) {
			block.text = stripped;
			changed = true;
		}
	}
	if (!changed) return false;
	const remaining = blocks
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
		.trim();
	if (remaining.length === 0) {
		const firstText = blocks.find(
			(block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
		);
		if (firstText) firstText.text = lockedSynthesisFallbackText();
		else blocks.push({ type: "text", text: lockedSynthesisFallbackText() });
	}
	return true;
}
