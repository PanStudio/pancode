// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { isRecord } from "./type-guards.js";

/**
 * Byte bound on the assistant output text sealed into a receipt. Large enough
 * for a substantive final answer, small enough that receipts stay cheap to
 * read and render; overflow is recorded explicitly via `truncated`/`bytes`.
 * A run whose result contract implies a larger conforming result raises its
 * own bound through `workerOutputCaptureBytes`; this is the floor.
 */
export const WORKER_OUTPUT_MAX_BYTES = 8192;

export function assistantTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (!isRecord(block)) return "";
			return typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

export function isDurableAssistantMessage(message: Record<string, unknown>): boolean {
	const stopReason = message.stopReason;
	if (stopReason === "toolUse" || stopReason === "error" || stopReason === "aborted" || stopReason === "cancelled") {
		return false;
	}
	if (!Array.isArray(message.content)) return true;
	return !message.content.some((block) => isRecord(block) && block.type === "toolCall");
}

/**
 * Extract text only from a completed, durable assistant answer. Tool-use
 * preambles are intermediate even when an event projection has stripped the
 * structured call block. Known failure messages are outcome detail, not a
 * successful worker answer. All other terminal spellings (including ACP's
 * `end_turn`) remain provider-compatible.
 */
export function durableAssistantTextFromEvent(event: unknown): string {
	if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return "";
	if (event.message.role !== "assistant" || !isDurableAssistantMessage(event.message)) return "";
	return assistantTextFromContent(event.message.content);
}
