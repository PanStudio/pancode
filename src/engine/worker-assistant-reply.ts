// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { AgentMessage } from "./types.js";

export function isAssistantMessage(
	message: AgentMessage | undefined,
): message is AgentMessage & { role: "assistant"; stopReason?: string; errorMessage?: string } {
	if (typeof message !== "object" || message === null) return false;
	return "role" in message && message.role === "assistant";
}

/**
 * An assistant turn PanCode wrote itself, such as the result-contract repair exchange: zero usage marked `callInvoked:
 * false` and a tool-use stop. A failed call is marked not invoked too, but it stops on `error` or `aborted`.
 */
export function hostWrittenExchange(message: AgentMessage & { stopReason?: string }): boolean {
	const usage = (message as { usage?: { callInvoked?: unknown } }).usage;
	return usage?.callInvoked === false && message.stopReason === "toolUse" && !("failure" in message);
}

export function getTerminalAgentError(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isAssistantMessage(message)) continue;
		if (message.stopReason !== "error") return null;
		return typeof message.errorMessage === "string" ? message.errorMessage : "";
	}
	return null;
}

export function assistantMessageText(message: AgentMessage | undefined): string | null {
	if (!isAssistantMessage(message) || !Array.isArray(message.content)) return null;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
		.trim();
}

/**
 * Whether this assistant message ends the run. A message that carries tool
 * calls is mid-run and states no result yet; an errored message already fails
 * the run through its own path.
 */
export function isTerminalAssistantMessage(message: AgentMessage | undefined): boolean {
	if (!isAssistantMessage(message)) return false;
	// pi refuses truncated tool calls and continues with their error results.
	// That turn has no final artifact/report to repair yet.
	if (
		message.stopReason === "length" &&
		Array.isArray(message.content) &&
		message.content.some((block) => block.type === "toolCall")
	)
		return false;
	return message.stopReason !== "toolUse" && message.stopReason !== "error" && message.stopReason !== "aborted";
}
