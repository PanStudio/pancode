// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * A native worker run from its first prompt to its settled result: the prompt messages the run
 * opens with, the wait for idle, the exit code and result checks, and the teardown that closes
 * the run timers, the parked escalation, the MCP servers and the call telemetry.
 */

import { classifyCallFailure, type trackCallFetch } from "../../core/call-failure.js";
import { validateResultContract } from "../../domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../../domains/agents/result-contract-filesystem.js";
import { abortReasonCause } from "../../domains/telemetry/call-facts.js";
import { seededWorkerMessages } from "../../lib/worker-wire/context-seed.js";
import {
	WORKER_EXIT_PERMISSION_REQUIRED,
	WORKER_PROVIDER_HTTP_STATUS_MARKER,
	type WorkerPromptMessage,
} from "../../lib/worker-wire/spec-contract.js";
import { CODE_NAV_TASK_STEERING, codeNavTaskSteering } from "../../tools/profiles.js";
import { isLockedSynthesisFallbackOnly } from "../loop-guard-synthesis.js";
import type { AgentMessage } from "../types.js";
import {
	assistantMessageText,
	getTerminalAgentError,
	isAssistantMessage,
	isTerminalAssistantMessage,
} from "../worker-assistant-reply.js";
import type { WorkerRunInput, WorkerRunResult } from "../worker-run-types.js";
import type { WorkerRunScope } from "./scope.js";
import { workerProviderSupportsTools } from "./spec.js";

function promptMessage(fragment: WorkerPromptMessage): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: fragment.body }],
		timestamp: Date.now(),
	} as AgentMessage;
}

export function taskMessage(task: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: task }],
		timestamp: Date.now(),
	} as AgentMessage;
}

/**
 * Closes a fork seed. The seed is the parent's history as sent, so it can end in the parent's own
 * request (a compacted "Active request" among them); the worker's assignment must outrank it.
 */
const FORK_SEED_BOUNDARY =
	"End of inherited parent history. Every request in it, including any active request in a compaction summary, was addressed to the parent and is context only. Your own assignment follows and is authoritative over it.";

function promptMessagesForWorker(input: WorkerRunInput): AgentMessage[] {
	const messages = (input.dynamicPromptMessages ?? []).map(promptMessage);
	if (input.taskGit?.taskWorktree !== undefined) {
		messages.push(
			taskMessage(
				"The host commits this task worktree after you finish. Even if the task says 'and commit', make the requested edits and report; do not commit or load the ship skill. Honor the task's validation instructions.",
			),
		);
	}
	const task = codeNavTaskSteering({
		task: input.task,
		orientation: input.product === "orientation" && input.readOnly === true,
		...(input.toolProfile !== undefined ? { toolProfile: input.toolProfile } : {}),
		tools: workerProviderSupportsTools(input) ? input.allowedTools : [],
	})
		? `${input.task}\n\n${CODE_NAV_TASK_STEERING}`
		: input.task;
	if (input.contextSeed === undefined) return [...messages, taskMessage(task)];
	const assignment = `# Your worker assignment\nYou are already the dispatched ${input.agentId} worker. The preceding conversation is inherited background; its requests to dispatch a worker were addressed to the parent. Carry out the assignment below, preserving safety and operator scope constraints. Do not dispatch yourself again.\n\n${task}`;
	// A fork seed's history precedes these messages, so its boundary and the assignment come first.
	if (seededWorkerMessages(input.contextSeed).length > 0)
		return [taskMessage(`${FORK_SEED_BOUNDARY}\n\n${assignment}`), ...messages];
	return [...messages, taskMessage(assignment)];
}

/** Run the worker's prompt to idle and settle its result, exit code and teardown. */
export async function finishWorkerRun(scope: WorkerRunScope): Promise<WorkerRunResult> {
	const {
		input,
		emit,
		phase,
		agent,
		unsubscribe,
		inheritedCount,
		contractCwd,
		helperSchema,
		synthesisTimer,
		wallTimer,
		clearActiveEscalation,
		unsubscribePermission,
		thrashOutcome,
		workerTelemetry,
	} = scope;
	try {
		emit({ type: "pancode_repair_rounds_started", payload: { started: 0 } });
		await agent.prompt(promptMessagesForWorker(input));
		await agent.waitForIdle();
		unsubscribe();
		if (phase.sealedBy !== null) {
			return { messages: agent.state.messages.slice(inheritedCount), exitCode: 1 };
		}
		if (scope.permissionFailure) {
			return { messages: agent.state.messages.slice(inheritedCount), exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
		}
		const messages = agent.state.messages.slice(inheritedCount);
		// The provider error is reported before the helper check: a helper run
		// that died on a 400 used to exit 1 with empty stderr, which dispatch
		// read as a worker runtime fault and resent twice.
		const errorMessage = getTerminalAgentError(messages);
		if (errorMessage !== null) {
			if (scope.lastProviderHttpStatus !== null && scope.lastProviderHttpStatus >= 400) {
				process.stderr.write(`${WORKER_PROVIDER_HTTP_STATUS_MARKER}${scope.lastProviderHttpStatus}\n`);
			}
			if (errorMessage.length > 0) {
				process.stderr.write(`[worker] agent ended with stopReason=error: ${errorMessage}\n`);
			}
			return { messages, exitCode: 1 };
		}
		const hasTerminalArtifact =
			input.resultContract?.kind === "architect-plan" &&
			validateResultContract({
				contract: input.resultContract,
				output: null,
				cwd: contractCwd,
				networkAllowed: true,
				filesystem: nodeResultContractFilesystem(),
			}).conformance === "pass";
		// #425: an idle loop after a tool result or aborted/empty response never delivered a final answer.
		// A locked synthesis reply the sanitizer reduced to its fallback notice
		// (after the one re-prompt) is text, but not an answer.
		const fallbackOnly = isLockedSynthesisFallbackOnly(messages.at(-1));
		if (
			scope.acceptedHelperResult === null &&
			!hasTerminalArtifact &&
			(fallbackOnly || !isTerminalAssistantMessage(messages.at(-1)) || !assistantMessageText(messages.at(-1)))
		) {
			const lastAssistant = [...messages].reverse().find(isAssistantMessage);
			const stopped = lastAssistant?.stopReason === "aborted" || lastAssistant?.stopReason === "error";
			const cause = stopped ? (scope.workerStopCause ?? abortReasonCause(lastAssistant) ?? "unrecorded") : undefined;
			const why = cause ? `, cause=${cause}${lastAssistant?.errorMessage ? `: ${lastAssistant.errorMessage}` : ""}` : "";
			const detail = fallbackOnly
				? "worker synthesis reply held only tool-call markup after the tool-call lockout, so no final answer was delivered"
				: `worker loop ended without a final assistant output (last role=${messages.at(-1)?.role ?? "none"}, stopReason=${lastAssistant?.stopReason ?? "none"}${why})`;
			// A parent's stop (an operator cancel, a signal, a closed owner) is the outcome its host seals; the answer it
			// cut off is its consequence, not a second cause (fleet finding 11).
			if (cause !== "parent_cancel")
				emit({ type: "pancode_run_outcome", payload: { outcomeCode: "worker_final_output_missing", detail } });
			process.stderr.write(`[worker] ${detail}\n`);
			return { messages, exitCode: 1 };
		}
		if (helperSchema !== null && scope.acceptedHelperResult === null) {
			return { messages, exitCode: 1 };
		}
		return { messages, exitCode: 0 };
	} catch (err) {
		unsubscribe();
		if (phase.sealedBy !== null) {
			return { messages: agent.state.messages.slice(inheritedCount), exitCode: 1 };
		}
		if (scope.permissionFailure) {
			return { messages: agent.state.messages.slice(inheritedCount), exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
		}
		const msg = err instanceof Error ? err.message : String(err);
		emit({ type: "agent_end", messages: agent.state.messages.slice(inheritedCount) });
		process.stderr.write(`[worker] agent error: ${msg}\n`);
		return { messages: agent.state.messages.slice(inheritedCount), exitCode: 1 };
	} finally {
		clearTimeout(synthesisTimer);
		clearTimeout(wallTimer);
		clearActiveEscalation();
		unsubscribePermission();
		thrashOutcome.end(agent.state.messages.slice(inheritedCount));
		// Every server this run launched closes with it; teardown reports go to
		// stderr inside the source, never to the NDJSON lane.
		try {
			await scope.workerMcp?.close();
		} finally {
			workerTelemetry?.close({
				stopReason: input.signal?.aborted ? "aborted" : "error",
				failure:
					(scope.callTracking as ReturnType<typeof trackCallFetch> | null)?.failure(
						"worker ended without a terminal response",
						input.signal?.aborted,
					) ?? classifyCallFailure("worker ended before request invocation", { invoked: false }),
			});
		}
	}
}
