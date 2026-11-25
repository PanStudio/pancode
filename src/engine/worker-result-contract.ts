// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { assistantMessageNeverSent } from "../core/assistant-model.js";
import { parseJsonObjectPayload } from "../core/json-payload.js";
import { systemReminderBlock } from "../core/reminder-framing.js";
import {
	responseFormatFor,
	responseSchemaDialectFor,
	runtimeSpeaksResponseSchemaDialect,
} from "../core/response-schema.js";
import { validateResultContract } from "../domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../domains/agents/result-contract-filesystem.js";
import { RESULT_CONTRACT_REPAIR_TOOL } from "../domains/agents/result-contract-repair.js";
import { resultContractResponseSchema } from "../domains/agents/result-contract-schema.js";
import type {
	ObservedReadRanges,
	ObservedRunEffects,
	ResultContract,
} from "../domains/agents/result-contract-types.js";
import { shouldRequestStalledTurnContinuation } from "../domains/middleware/stalled-turn.js";
import { lockedSynthesisFallbackText } from "./loop-guard-synthesis.js";
import type { AgentMessage } from "./types.js";
import { assistantMessageText, isAssistantMessage } from "./worker-assistant-reply.js";
import type { WorkerRunInput } from "./worker-run-types.js";

/**
 * Why this run's terminal message misses its contract, or null when it holds.
 * A message that announces further work fails even when it parses, because the
 * synthesis lock means no further work will happen.
 */
export function terminalContractViolation(
	contract: ResultContract,
	message: AgentMessage | undefined,
	cwd: string,
	observedReadRanges: ObservedReadRanges,
	observedRunEffects: ObservedRunEffects,
): string | null {
	if (!isAssistantMessage(message)) return null;
	const text = assistantMessageText(message);
	if (text === null || text.length === 0) return "missing final result";
	// The loop guard already replaced this reply with its own notice, so there is
	// no model result here to judge against a shape. Reporting the contract's
	// shape anyway sent the repair directive, the receipt, and the operator after
	// a JSON formatting problem that never existed: a bootstrap run that spiraled
	// through 45 tool calls and lost its answer to the lockout was reported as
	// "result must be valid JSON".
	if (text.trim() === lockedSynthesisFallbackText()) {
		return "the reply after the tool-call lockout held only tool-call markup and was removed; tools are off, so emit the required terminal result format";
	}
	const stopReason = message.stopReason;
	if (
		shouldRequestStalledTurnContinuation({
			hook: "turn_end",
			text,
			metadata: { turnToolCalls: 0, ...(typeof stopReason === "string" ? { stopReason } : {}) },
		})
	) {
		return "the response announced further work instead of stating the final result";
	}
	const validation = validateResultContract({
		contract,
		output: text,
		cwd,
		observedReadRanges,
		observedRunEffects,
		// Repair rounds judge shape and grounding only. Network posture belongs to
		// the orchestrator's sealed validation, which runs again on the receipt.
		networkAllowed: true,
		filesystem: nodeResultContractFilesystem(),
	});
	return validation.conformance === "pass" ? null : (validation.reason ?? "invalid result");
}

function responseSchemaRuntimeRefusal(input: WorkerRunInput): Error {
	return new Error(
		`responseSchema requires a native llamacpp runtime with resolved JSON-schema support; received '${input.runtime.id}'`,
	);
}

export function assertResponseSchemaRuntime(input: WorkerRunInput): void {
	if (input.responseSchema === undefined) return;
	if (
		runtimeSpeaksResponseSchemaDialect(input.runtime) &&
		input.modelCapabilities?.structuredOutputs === "json-schema"
	) {
		return;
	}
	throw responseSchemaRuntimeRefusal(input);
}

/**
 * The `response_format` an admitted schema rides on. Admission
 * ({@link assertResponseSchemaRuntime}) and the dialect table are separate
 * predicates, so a schema with no dialect here means they drifted. The request
 * must not go out unconstrained in that case, because the parent would read a
 * contract it believes was enforced.
 */
export function workerResponseFormatFor(input: WorkerRunInput): Record<string, unknown> | undefined {
	if (input.responseSchema === undefined) return undefined;
	const dialect = responseSchemaDialectFor(input.runtime.id);
	if (dialect === null) throw responseSchemaRuntimeRefusal(input);
	return responseFormatFor(dialect, input.responseSchema, "pancode_result");
}

/**
 * Carry the result-contract reminder after a work round's tool results, as a
 * host `<system-reminder>` user message, never inside a tool result, where the
 * model reads it as text a tool returned. Request-only: stored history,
 * grounding and eviction never see it. Each request ends with the reminder its
 * last batch earns, and every sent answer from `from` on is preceded by the one
 * its own request carried, with its predecessor's timestamp, so a later round's
 * prefix keeps every earlier byte and that answer stays an anchor. A repair
 * round's own result already quotes the exact shape, so it gets none.
 */
export function withResultContractReminder<M extends { role: string; timestamp?: unknown }>(
	messages: M[],
	reminder: string | null,
	from = 0,
): { messages: M[]; reminders: M[] } {
	if (reminder === null) return { messages, reminders: [] };
	const earned = (end: number): M | null => {
		let results = 0;
		for (let index = end - 1; index >= 0 && messages[index]?.role !== "assistant"; index--) {
			const message = messages[index] as unknown as { role: string; toolName?: unknown };
			if (message.role !== "toolResult") continue;
			if (message.toolName === RESULT_CONTRACT_REPAIR_TOOL) return null;
			results += 1;
		}
		if (results === 0) return null;
		const timestamp = messages[end - 1]?.timestamp ?? Date.now();
		return { role: "user", content: systemReminderBlock([reminder]), timestamp } as unknown as M;
	};
	const out: M[] = [];
	const reminders: M[] = [];
	messages.forEach((message, index) => {
		const delivered =
			index >= from && message.role === "assistant" && !assistantMessageNeverSent(message) ? earned(index) : null;
		if (delivered !== null) {
			out.push(delivered);
			reminders.push(delivered);
		}
		out.push(message);
	});
	const tail = earned(messages.length);
	if (tail !== null) {
		out.push(tail);
		reminders.push(tail);
	}
	return { messages: reminders.length === 0 ? messages : out, reminders };
}

/**
 * The `response_format` a prose-parsed result contract's final-only rounds
 * carry, or undefined when this run cannot enforce one. It rides only rounds
 * that ship no tools, because llama-server cannot build a schema grammar
 * beside a tool grammar ({@link responseSchemaConflictsWithTools}); work rounds
 * stay unconstrained. The gate is the measured dialect table plus the resolved
 * model's own `structuredOutputs`, the same pair dispatch `responseSchema`
 * admission reads, so a gateway that would silently ignore the field is never
 * trusted with it. A run that carries `responseSchema` already binds every
 * round.
 */
export function workerContractResponseFormatFor(input: WorkerRunInput): Record<string, unknown> | undefined {
	if (input.responseSchema !== undefined || input.resultContract === undefined) return undefined;
	if (input.runtime.apiFamily !== "openai-completions") return undefined;
	if (input.modelCapabilities?.structuredOutputs !== "json-schema") return undefined;
	const dialect = responseSchemaDialectFor(input.runtime.id);
	if (dialect === null) return undefined;
	const schema = resultContractResponseSchema(input.resultContract);
	return schema === null ? undefined : responseFormatFor(dialect, schema, "pancode_result");
}

/**
 * Whether a terminal reply is a finished answer in the wrong form: prose where
 * the contract's JSON object belongs. A reply announcing more work, or one the
 * tool-call lockout already replaced, is not; those keep their own repairs.
 */
export function finishedReplyWithoutJsonResult(message: AgentMessage): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = assistantMessageText(message)?.trim() ?? "";
	if (text.length === 0 || text === lockedSynthesisFallbackText()) return false;
	if (parseJsonObjectPayload(text).ok) return false;
	const stopReason = message.stopReason;
	return !shouldRequestStalledTurnContinuation({
		hook: "turn_end",
		text,
		metadata: { turnToolCalls: 0, ...(typeof stopReason === "string" ? { stopReason } : {}) },
	});
}
