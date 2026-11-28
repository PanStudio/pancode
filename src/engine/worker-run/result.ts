// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * A native worker run's terminal result: the helper tool the result is submitted through, the
 * checks that accept or refuse a submission, the batch and phase rules for the call that carries it,
 * and the bounded repair rounds a refused or malformed result gets, by reading first when evidence is
 * missing.
 */

import { Type } from "typebox";
import { parseJsonObjectPayload } from "../../core/json-payload.js";
import { EXPLORATION_TOOL_NAMES } from "../../core/read-only-calls.js";
import { ToolNames } from "../../core/tool-names.js";
import { validateResultContract, validateStructuredHelperResult } from "../../domains/agents/result-contract.js";
import { nonBooleanBaselineReason } from "../../domains/agents/result-contract-builder-report.js";
import { nodeResultContractFilesystem } from "../../domains/agents/result-contract-filesystem.js";
import { gateCitationViolation } from "../../domains/agents/result-contract-gate.js";
import {
	RESULT_CONTRACT_REPAIR_LIMIT,
	resultContractRepairMessages,
	resultContractRepairUserMessage,
	resultContractShape,
} from "../../domains/agents/result-contract-repair.js";
import { MUTATION_FAILURE_RULE } from "../../domains/agents/result-contract-schema.js";
import {
	resultContractEvidenceShortfall,
	unobservedExplorerReportReason,
} from "../../domains/agents/result-contract-scout.js";
import type { resolveAgentTools } from "../../tools/agent-tools.js";
import type { EngineAgentOptions } from "../agent.js";
import { callRepeatsAsRead } from "../loop-guard.js";
import {
	isLockedSynthesisFallbackOnly,
	lockedSynthesisRepromptMessages,
	sanitizeLockedSynthesisMessage,
} from "../loop-guard-synthesis.js";
import { supportsNamedToolChoice } from "../provider-payload.js";
import type { AgentEvent, AgentMessage } from "../types.js";
import { assistantMessageText, isAssistantMessage, isTerminalAssistantMessage } from "../worker-assistant-reply.js";
import { groundingRanges, observedReadAnchors } from "../worker-grounding.js";
import { WORKER_REFUSAL_REPORT_BLOCK } from "../worker-refusals.js";
import { finishedReplyWithoutJsonResult, terminalContractViolation } from "../worker-result-contract.js";
import { INTERNAL_HELPER_RESULT_TOOL } from "../worker-tools.js";
import type { WorkerRunScope } from "./scope.js";

/**
 * Characters of a refused terminal result sent to the parent, well past the
 * feed's own bound so the parent redacts before anything it keeps is cut.
 */
const REJECTED_HELPER_RESULT_MAX_CHARS = 16 * 1024;

export function createWorkerResult(scope: WorkerRunScope) {
	const { input, emit, phase, helperSchema, mutationResult, activeWorkerTools, model, contractCwd, runEffects } = scope;
	let lockedSynthesisReprompts = 0;

	let zeroToolRepairQueued = false;
	/** A gate verdict that cited none of its evidence packet gets one repair naming the ids (M10); a second passes through. */
	let citationRepairQueued = false;
	// M-31: whether the last terminal handoff arrived while work tools were still open, captured before the handoff
	// locks them, and whether a repair reopened the read tools so the run can gather the evidence its result lacked.
	let handoffFromOpenWork = false;
	const readToolsAdmitted = activeWorkerTools.filter((tool) => EXPLORATION_TOOL_NAMES.has(tool));
	/**
	 * A rejected result the run can still ground by reading: work tools were open when it arrived, the envelope admits
	 * a read-class tool, and either nothing has executed yet or the refusal names missing evidence. Withdrawing the
	 * tools there leaves the model nothing to answer with but an empty result (M-31). A mutation report keeps its own
	 * revision path, and a refusal about the result's form after evidence exists keeps the final-only repair.
	 */
	const evidenceRepairFor = (reason: string, workOpen: boolean): boolean =>
		workOpen &&
		!mutationResult &&
		readToolsAdmitted.length > 0 &&
		phase.lastRound === null &&
		(scope.toolExecutionsStarted === 0 || resultContractEvidenceShortfall(reason));
	const evidenceRepairInstruction = (reason: string, resubmit: string): string =>
		`${reason} No evidence backs this result yet. First read the inputs the assignment names with the admitted read tools (${readToolsAdmitted.join(", ")}); only read-class calls run during this repair. Then ${resubmit}, citing only lines you read.`;
	/**
	 * An explorer report that arrives before any tool ran, while the run could still read, is refused here so the
	 * read-first repair runs; past the repair cap the run fails as the dispatch obligation would have failed it (M-31).
	 */
	const unobservedReportReason = (): string | null =>
		input.resultContract !== undefined &&
		readToolsAdmitted.length > 0 &&
		phase.lastRound === null &&
		(handoffFromOpenWork || (!phase.toolsLocked && !phase.resultForced))
			? unobservedExplorerReportReason(input.resultContract.kind, scope.toolExecutionsStarted)
			: null;

	// A tool route hands execute a schema-coerced copy; the arguments the model sent, by call id, keep a baseline honest.
	const submittedHelperArguments = new Map<string, unknown>();
	const acceptHelperResult = (data: unknown, submitted: unknown = data): string | null => {
		if (!input.resultContract) return "missing helper result contract";
		const coerced = mutationResult ? nonBooleanBaselineReason(submitted) : null;
		if (coerced !== null) return coerced;
		const checked = validateStructuredHelperResult({
			contract: input.resultContract,
			data,
			cwd: contractCwd,
			observedReadRanges: groundingRanges(scope.observedReadRanges, scope.observedGrepLines),
			networkAllowed: true,
			filesystem: nodeResultContractFilesystem(),
			observedRunEffects: runEffects.snapshot(),
		});
		if (checked.structured === null) return checked.validation.reason ?? "invalid helper result";
		const unobserved = unobservedReportReason();
		if (unobserved !== null) return unobserved;
		scope.acceptedHelperResult = checked.structured;
		emit({ type: "pancode_helper_result", payload: checked.structured });
		return null;
	};
	// The refusal reason alone cannot show what the model actually submitted.
	const reportRejectedHelperResult = (submitted: unknown, reason: string): void => {
		let text: string;
		try {
			text = JSON.stringify(submitted) ?? String(submitted);
		} catch {
			text = String(submitted);
		}
		emit({
			type: "pancode_helper_result_rejected",
			payload: { reason, submitted: text.slice(0, REJECTED_HELPER_RESULT_MAX_CHARS) },
		});
	};

	// The terminal handoff names its tool in the request, so it keeps the tool
	// surface that a synthesis lock would otherwise remove.
	const terminalHandoffActive = (api: string): boolean =>
		scope.helperToolAvailable && (phase.toolsLocked || phase.resultForced) && supportsNamedToolChoice(api);
	const pushHelperTool = (tools: ReturnType<typeof resolveAgentTools>): void => {
		if (scope.helperToolAvailable) {
			tools.push({
				name: INTERNAL_HELPER_RESULT_TOOL,
				label: "Submit helper result",
				description:
					"Submit the final internal result as this tool's arguments. Call alone, after gathering evidence. A validated submission finishes the run; no prose response follows." +
					(mutationResult ? ` ${MUTATION_FAILURE_RULE}` : ""),
				parameters: Type.Unsafe<Record<string, unknown>>(helperSchema as Record<string, unknown>),
				async execute(id, args) {
					if (scope.acceptedHelperResult !== null || phase.sealedBy !== null) {
						return {
							content: [{ type: "text", text: "The terminal result is already sealed." }],
							details: { kind: "error" },
							isError: true,
							terminate: true,
						};
					}
					phase.forceResult("result");
					phase.lockTools("result");
					const submitted = submittedHelperArguments.has(id) ? submittedHelperArguments.get(id) : args;
					submittedHelperArguments.delete(id);
					scope.helperTurnFailure = acceptHelperResult(args, submitted);
					if (scope.helperTurnFailure !== null) {
						return { content: [{ type: "text", text: scope.helperTurnFailure }], details: { kind: "error" }, isError: true };
					}
					return {
						content: [{ type: "text", text: "Internal result accepted." }],
						details: { kind: "ok" },
						terminate: true,
					};
				},
			});
		}
	};

	const beforeToolCall: NonNullable<EngineAgentOptions["beforeToolCall"]> = async ({ assistantMessage, toolCall }) => {
		if (toolCall.name === INTERNAL_HELPER_RESULT_TOOL) submittedHelperArguments.set(toolCall.id, toolCall.arguments);
		if (phase.lastRound !== null && toolCall.name !== INTERNAL_HELPER_RESULT_TOOL)
			return { block: true, reason: WORKER_REFUSAL_REPORT_BLOCK };
		// The evidence repair reopened reading, not the whole work surface (M-31).
		if (
			scope.evidenceRepairActive &&
			toolCall.name !== INTERNAL_HELPER_RESULT_TOOL &&
			!callRepeatsAsRead(toolCall.name, toolCall.arguments, () => undefined)
		)
			return {
				block: true,
				reason: "Only read-class tools run during this evidence repair. Read the inputs, then submit the result.",
			};
		if (helperSchema === null) return undefined;
		if (scope.acceptedHelperResult !== null || phase.sealedBy !== null)
			return { block: true, reason: "The helper result is sealed.", terminate: true };
		if (mutationResult && toolCall.name === INTERNAL_HELPER_RESULT_TOOL && !scope.helperExposedThisRound) {
			scope.helperTurnFailure = "The terminal handoff is unavailable during work. Finish the work phase first.";
			return { block: true, reason: scope.helperTurnFailure };
		}
		const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
		if (calls.some((call) => call.name === INTERNAL_HELPER_RESULT_TOOL) && calls.length !== 1) {
			scope.helperTurnFailure =
				"Submit exactly one terminal handoff, alone; mixed or duplicate handoff batches are rejected without executing work.";
			return { block: true, reason: scope.helperTurnFailure };
		}
		if ((phase.resultForced || phase.toolsLocked) && toolCall.name !== INTERNAL_HELPER_RESULT_TOOL) {
			scope.helperTurnFailure = "Work tools are disabled. Submit only the internal terminal result.";
			return { block: true, reason: scope.helperTurnFailure };
		}
		return undefined;
	};

	// Pi decides the turn boundary here, before `turn_end` is emitted, so a
	// terminal-handoff repair that exhausts its budget must run here too.
	// Run from a `turn_end` subscriber, the exhausted bound arrived after the
	// decision and cost one extra provider request.
	const finishTurn: NonNullable<EngineAgentOptions["finishTurn"]> = ({ message, toolResults }) => {
		if (phase.lastRound !== null && scope.workerModelRound >= phase.lastRound) return { action: "end" };
		if (
			helperSchema !== null &&
			scope.acceptedHelperResult === null &&
			toolResults.length > 0 &&
			(toolResults.some((result) => result.toolName === INTERNAL_HELPER_RESULT_TOOL) ||
				(scope.helperTerminalRequest && scope.helperTurnFailure !== null)) &&
			(phase.resultForced || phase.toolsLocked)
		) {
			const error = toolResults.find((result) => result.isError);
			const reason =
				scope.helperTurnFailure ??
				error?.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n") ??
				"The terminal handoff was not accepted.";
			// Every refused handoff, whether the contract, the tool schema or the batch rule refused it.
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === INTERNAL_HELPER_RESULT_TOOL)
					reportRejectedHelperResult(block.arguments, reason);
			}
			repairHelperResult(reason);
		}
		return helperSchema !== null && (scope.acceptedHelperResult !== null || phase.sealedBy !== null)
			? { action: "end" }
			: undefined;
	};

	const repairHelperResult = (reason: string): void => {
		const workOpen = handoffFromOpenWork || (!phase.toolsLocked && !phase.resultForced);
		handoffFromOpenWork = false;
		if (!input.resultContract || scope.acceptedHelperResult !== null || phase.sealedBy !== null) return;
		if (phase.lastRound !== null) return;
		phase.forceResult("result");
		phase.lockTools("result");
		if (scope.resultContractRepairsStarted >= RESULT_CONTRACT_REPAIR_LIMIT) {
			phase.sealOver(`result contract failed after ${RESULT_CONTRACT_REPAIR_LIMIT} bounded repair rounds: ${reason}`);
			emit({
				type: "pancode_run_outcome",
				payload: { outcomeCode: "result_contract_exhausted", detail: phase.sealedBy ?? "" },
			});
			return;
		}
		// #425: rejected sibling handoffs share one repair request; queuing it is not running it.
		if (scope.resultContractRepairsQueued > scope.resultContractRepairsStarted) return;
		scope.resultContractRepairsQueued += 1;
		// M-31: a result rejected for missing evidence, or before anything ran, is repaired by reading. The round keeps
		// the work phase's declarations and request shape, so the cached prefix survives; admission narrows it to reads.
		const readFirst = evidenceRepairFor(reason, workOpen);
		if (readFirst) {
			scope.evidenceRepairActive = true;
			phase.releaseResult();
			phase.unlockTools();
		}
		const revisionToolsAvailable = !phase.toolsLocked;
		const instruction = readFirst
			? evidenceRepairInstruction(reason, `submit the result again with ${INTERNAL_HELPER_RESULT_TOOL}`)
			: scope.helperForcedChoiceAvailable && !revisionToolsAvailable
				? `${reason} Work tools remain disabled. Repair the result by calling ${INTERNAL_HELPER_RESULT_TOOL} exactly once, alone, with the complete result object. Do not emit prose.`
				: reason;
		for (const message of resultContractRepairMessages(
			{
				contract: input.resultContract,
				reason: instruction,
				attempt: scope.resultContractRepairsQueued,
				anchors: observedReadAnchors(contractCwd, scope.observedReadRanges),
				toolsAvailable: revisionToolsAvailable,
			},
			{ provider: model.provider, api: model.api, model: model.id },
		)) {
			const repairMessage =
				scope.helperForcedChoiceAvailable && !mutationResult && !revisionToolsAvailable && message.role === "toolResult"
					? {
							...message,
							content: [
								{
									type: "text" as const,
									text: `${instruction}\nRequired arguments schema: ${JSON.stringify(helperSchema)}\nObserved read ranges: ${observedReadAnchors(contractCwd, scope.observedReadRanges).join(", ") || "none"}`,
								},
							],
						}
					: message;
			// A reopened round continues on the rejected handoff's tool result, so its instruction rides the steering
			// queue, which lands before that request; a follow-up would wait for the run to stop (M-31).
			if (readFirst) scope.agent.steer(repairMessage as unknown as AgentMessage);
			else scope.agent.followUp(repairMessage as unknown as AgentMessage);
		}
	};

	const onAssistantBatch = (event: AgentEvent): void => {
		// Detect the whole terminal batch before any call is prepared/executed.
		// beforeToolCall rejects every sibling, regardless of ordering or parallelism.
		if (helperSchema !== null && event.type === "message_end" && isAssistantMessage(event.message)) {
			const calls = event.message.content.filter((block) => block.type === "toolCall");
			if (calls.some((call) => call.name === INTERNAL_HELPER_RESULT_TOOL)) {
				handoffFromOpenWork = !phase.toolsLocked && !phase.resultForced;
				phase.forceResult("result");
				phase.lockTools("result");
				if (calls.length !== 1)
					scope.helperTurnFailure =
						"Submit exactly one terminal handoff, alone; mixed or duplicate batches cannot execute work.";
			}
		}
	};

	const onMessageEnd = (event: AgentEvent): void => {
		// Synthesis-locked run: the round ships no tool surface, so a model that
		// calls a tool anyway lands its chat template's tool-call syntax in the
		// reply as plain text. Sanitize the finished message in place before it
		// hits stdout; pi stores this same object in agent state, so the NDJSON
		// event, the dispatch consumer's answer reconstruction, and any later
		// provider round all see the same text.
		// A markup-only locked reply re-prompted this round; the result-contract
		// check below stands aside so the round costs the one re-prompt, not one
		// of the contract's bounded repair slots (on ornith both were queued for
		// the same message and the run then ran out of repairs on a later
		// grounding violation).
		let repromptedThisMessage = false;
		if (
			phase.sealedBy === null &&
			phase.lastRound === null &&
			phase.toolsLocked &&
			!scope.helperToolAvailable &&
			event.type === "message_end"
		) {
			const stripped = sanitizeLockedSynthesisMessage(event.message);
			// A model that calls a tool anyway hands its markup back as text and
			// the sanitizer leaves only the fallback notice: the training habit
			// survives the strip (Qwen3.8 did it in 1 of 5 stripped runs). One
			// re-prompt, delivered as a tool exchange like the result-contract
			// repair, asks for the required result format; a second markup-only reply
			// keeps the notice.
			if (stripped && lockedSynthesisReprompts < 1 && isLockedSynthesisFallbackOnly(event.message)) {
				lockedSynthesisReprompts += 1;
				repromptedThisMessage = true;
				process.stderr.write(
					"[worker] synthesis lock: reply was tool-call markup only; re-prompting once for the required final format\n",
				);
				const directive = lockedSynthesisRepromptMessages(
					lockedSynthesisReprompts,
					{ provider: model.provider, api: model.api, model: model.id },
					input.resultContract ? resultContractShape(input.resultContract) : undefined,
				).find((message) => message.role === "toolResult");
				if (directive?.role === "toolResult") {
					scope.agent.followUp({ role: "user", content: directive.content, timestamp: Date.now() } as AgentMessage);
				}
			}
		}
		// Bounded terminal-contract repair, on whichever message ends the run.
		// A worker that finishes inside its budget never trips the synthesis
		// lock, so gating this on the lock would skip repair on exactly the
		// well-behaved runs it exists to save. The orchestrator validates the
		// same contract against the sealed receipt; this is the only point at
		// which the model can still act on the validator's reason.
		// The report after the refusal limit gets no repair round; dispatch judges it as it stands.
		const contract = phase.lastRound === null ? input.resultContract : undefined;
		if (
			helperSchema !== null &&
			!mutationResult &&
			contract &&
			!repromptedThisMessage &&
			event.type === "message_end" &&
			isTerminalAssistantMessage(event.message)
		) {
			const text = assistantMessageText(event.message);
			let submitted: unknown;
			let reason: string | null;
			let refused = false;
			try {
				submitted = JSON.parse(text ?? "");
				reason = acceptHelperResult(submitted);
				refused = reason !== null;
			} catch {
				reason = "The internal result must be a JSON object conforming to the declared contract.";
			}
			if (refused && reason !== null) reportRejectedHelperResult(submitted, reason);
			if (reason !== null) repairHelperResult(reason);
		}
		if (
			(helperSchema === null || mutationResult) &&
			scope.acceptedHelperResult === null &&
			contract &&
			!repromptedThisMessage &&
			event.type === "message_end" &&
			isTerminalAssistantMessage(event.message)
		) {
			// A file-scoped coder sometimes ends its first reply with no tool call and a
			// report that it has no edit tool or cannot find the file (p8/S1, p9/C3),
			// then does the same work when asked again. The orchestrator fails every
			// zero-call edit run as obligation_unmet, so one repair round costs nothing
			// the run had left. A second empty reply passes through to that outcome.
			const zeroToolViolation =
				scope.toolExecutionsStarted === 0 &&
				!zeroToolRepairQueued &&
				contract.kind === "mutation-report" &&
				input.readOnly !== true &&
				!phase.toolsLocked &&
				activeWorkerTools.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write)
					? `no tool was called, so none of the assignment was done. The admitted tools are ${activeWorkerTools.join(", ")}, and they include ${activeWorkerTools.filter((tool) => tool === ToolNames.Edit || tool === ToolNames.Write).join(" and ")}. Inspect the workspace and do the assignment with them. If a tool refuses a call, report that refusal as the limitation.`
					: null;
			// A second no-work reply belongs to obligation_unmet, even when its
			// report is malformed. The p8/S1 recovery must not spend shape repairs.
			const contractViolation =
				zeroToolRepairQueued && scope.toolExecutionsStarted === 0
					? null
					: (zeroToolViolation ??
						terminalContractViolation(
							contract,
							event.message,
							contractCwd,
							groundingRanges(scope.observedReadRanges, scope.observedGrepLines),
							runEffects.snapshot(),
						) ??
						(mutationResult ? null : unobservedReportReason()));
			// A well-formed gate verdict that cites none of its packet is asked once, with the ids that exist (M10). The
			// grader still seals a second uncited verdict exhausted, so this round never stands in for that rule.
			const citationViolation =
				contractViolation === null &&
				!citationRepairQueued &&
				!(zeroToolRepairQueued && scope.toolExecutionsStarted === 0) &&
				scope.resultContractRepairsQueued < RESULT_CONTRACT_REPAIR_LIMIT
					? gateCitationViolation(contract, assistantMessageText(event.message))
					: null;
			if (citationViolation !== null) citationRepairQueued = true;
			const violation = contractViolation ?? citationViolation;
			const formatFailure =
				mutationResult &&
				violation !== null &&
				zeroToolViolation === null &&
				validateResultContract({
					contract,
					output: assistantMessageText(event.message),
					cwd: contractCwd,
					networkAllowed: true,
					filesystem: nodeResultContractFilesystem(),
				}).conformance === "fail";
			if (helperSchema !== null && zeroToolRepairQueued && scope.toolExecutionsStarted === 0) {
				// An unsealed helper would otherwise hide the parent's no-work classification behind a generic failed exit.
				// Without a helper the worker exits clean and the parent's grader seals obligation_unmet from the empty tool activity.
				phase.sealOver("obligation change-or-declared unmet: worker executed no tools, so it did none of its assignment");
				emit({
					type: "pancode_run_outcome",
					payload: { outcomeCode: "obligation_unmet", detail: phase.sealedBy ?? "" },
				});
			} else if (violation === null && helperSchema !== null) {
				const parsed = parseJsonObjectPayload(assistantMessageText(event.message) ?? "");
				if (parsed.ok) {
					const reason = acceptHelperResult(parsed.value);
					if (reason !== null) reportRejectedHelperResult(parsed.value, reason);
					if (reason !== null && !(zeroToolRepairQueued && scope.toolExecutionsStarted === 0)) repairHelperResult(reason);
				}
			} else if (violation !== null && formatFailure) {
				repairHelperResult(violation);
			} else if (violation !== null) {
				if (zeroToolViolation !== null || scope.resultContractRepairsStarted < RESULT_CONTRACT_REPAIR_LIMIT) {
					if (zeroToolViolation !== null) zeroToolRepairQueued = true;
					else scope.resultContractRepairsQueued += 1;
					// M-31: missing evidence is repaired by reading, so it never takes the final-only route below.
					const readFirst = zeroToolViolation === null && evidenceRepairFor(violation, !phase.toolsLocked);
					if (readFirst) scope.evidenceRepairActive = true;
					// A finished answer in prose needs no more work, only its form. Where
					// the runtime can bind that form, the repair round goes final-only so
					// the schema can ride it; tools there would keep it unconstrained.
					const constrainedRepair =
						!readFirst &&
						scope.contractResponseFormat !== undefined &&
						zeroToolViolation === null &&
						finishedReplyWithoutJsonResult(event.message);
					if (constrainedRepair) phase.lockTools("result");
					const revisionToolsAvailable = readFirst || !phase.toolsLocked;
					if (!revisionToolsAvailable) phase.lockTools("result");
					// A repair with tools retains the paired tool exchange. Final-only
					// repair starts a fresh user turn to break local tool-call fixation. Templates
					// that key history rendering off the last `user` message re-render
					// every earlier assistant turn when one is appended mid-run, which
					// invalidates the whole prompt cache: Nemotron reprocessed 11,352
					// tokens for this directive as `user` against 407 for the same
					// bytes as a tool result (#55). The synthetic assistant call gives
					// the result a real tool_call_id for strict endpoints (#62).
					const repairInput = {
						contract,
						reason: readFirst ? evidenceRepairInstruction(violation, "emit the required result again") : violation,
						attempt: zeroToolViolation !== null ? 1 : scope.resultContractRepairsQueued,
						anchors: observedReadAnchors(contractCwd, scope.observedReadRanges),
						toolsAvailable: revisionToolsAvailable,
					};
					const repair = revisionToolsAvailable
						? resultContractRepairMessages(repairInput, { provider: model.provider, api: model.api, model: model.id })
						: [resultContractRepairUserMessage(repairInput)];
					for (const message of repair) scope.agent.followUp(message as unknown as AgentMessage);
				} else if (phase.sealedBy === null) {
					phase.seal(`result contract failed after ${RESULT_CONTRACT_REPAIR_LIMIT} bounded repair rounds: ${violation}`);
					emit({
						type: "pancode_run_outcome",
						payload: { outcomeCode: "result_contract_exhausted", detail: phase.sealedBy ?? "" },
					});
				}
			}
		}
	};

	return { terminalHandoffActive, pushHelperTool, beforeToolCall, finishTurn, onAssistantBatch, onMessageEnd };
}
