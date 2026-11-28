// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { AsyncLocalStorage } from "node:async_hooks";
import type { PancodeSettings } from "../../core/config.js";
import { continuationCountsAgainstCap, TURN_CONTINUATION_CAP } from "../../core/job-types.js";
import { resourceLimitsFromSettings } from "../../core/sandbox/resource-limits.js";
import { observedToolCallOrigin, toolCallBatch } from "../../core/telemetry/context.js";
import { routeCallsPerRound, turnBudgetWidthScale } from "../../core/turn-budget-width.js";
import {
	acceptsImageInput,
	modelCandidatesForStatus,
	resolveModelCapabilities,
} from "../../domains/providers/index.js";
import { absentOutputs, namedOutputs } from "../../domains/session/output-obligations.js";
import type { RetrySettings } from "../../domains/session/retry.js";
import { activePath } from "../../domains/session/tree/active-path.js";
import { createHeadlessObservationPool } from "../../tools/observation.js";
import type { ToolInvokeOptions } from "../../tools/registry/contract.js";
import type { CreateChatLoopDeps } from "../chat-loop.js";
import { normalizeRetrySettings } from "../chat-loop-policy.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { ChatLoopToolOptionsState, TurnStop } from "../turn-state.js";

/**
 * Whether a turn the per-turn tool budget ends now is continued without the operator, as `yoloContinuationDue`
 * decides when it settles: yolo, not a machine turn (its job decides), and the stop it settles on not capped. A plain
 * budget crossing never counts against the cap, so it continues past it; a turn whose tools the loop guard already
 * locked, or that failed, settles on a counted stop and does not once the cap is spent (CLI-H1).
 */
export function budgetCrossingContinues(input: {
	yolo: boolean;
	machineTurn: boolean;
	failure: TurnStop | null;
	locked: boolean;
	continuations: number;
}): boolean {
	const failure = input.failure;
	if (!input.yolo || input.machineTurn || failure?.cause === "wait_past_budget") return false;
	const cause = failure !== null ? failure.cause : input.locked ? "loop_guard" : "tool_budget";
	return !(continuationCountsAgainstCap(cause) && input.continuations >= TURN_CONTINUATION_CAP);
}

/** The per-call bounds settings put on every tool invocation: the bash idle timeout and the main session's resource ceilings. */
function toolLimitOptions(safety: PancodeSettings["safety"]): Pick<ToolInvokeOptions, "bashIdleMs" | "resourceLimits"> {
	const resourceLimits = resourceLimitsFromSettings(safety.resources.main);
	return {
		...(safety.limits.bashIdleSeconds > 0 ? { bashIdleMs: safety.limits.bashIdleSeconds * 1000 } : {}),
		...(resourceLimits === undefined ? {} : { resourceLimits }),
	};
}

/** The chat loop's settings-derived helpers and the per-run context its tool invocations read. */
export function createChatLoopToolOptions(deps: CreateChatLoopDeps, state: ChatLoopToolOptionsState) {
	const visionModelOptions = (): string[] => {
		const options: string[] = [];
		for (const status of deps.providers.list()) {
			for (const candidate of modelCandidatesForStatus(status)) {
				const caps = resolveModelCapabilities(status, candidate.id, deps.providers.knowledgeBase);
				if (!acceptsImageInput({ runtimeId: status.runtime?.id ?? status.target.runtime, vision: caps.vision })) continue;
				options.push(`${status.target.id}/${candidate.id}`);
				if (options.length === 5) return options;
			}
		}
		return options;
	};

	/**
	 * Which of the two settings is actually missing when the runtime resolves to
	 * null. Both halves produce the same operator-facing notice, but a machine
	 * consumer of the reason (the ACP server reports it as `data.reason`) needs
	 * to tell "no orchestrator at all" from "a target that names no model", and
	 * collapsing them sent a client with a configured target to the wrong fix.
	 */
	const nullRuntimeAdmissionReason = (): string => {
		const orchestrator = deps.getSettings().chat;
		const target = orchestrator.connection?.trim() ?? "";
		const model = orchestrator.model?.trim() ?? "";
		return target.length > 0 && model.length === 0 ? "model-not-configured" : "orchestrator-not-configured";
	};

	const retrySettings = (): RetrySettings => normalizeRetrySettings(deps.getSettings().chat.retry);

	const hostRunContext = new AsyncLocalStorage<ToolInvokeOptions["hostRun"]>();
	// A headless run's observation pool rolls once spent instead of capping the run (CLI-P42); attended turns keep theirs.
	const headlessObservation = deps.headless === true ? createHeadlessObservationPool() : null;
	// M-4: the outputs this session's operator prompts named with an `output: <path>` line that do not exist now.
	const missingOutputs = (): string[] =>
		absentOutputs(
			namedOutputs(activePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined)),
			process.cwd(),
		);
	return {
		visionModelOptions,
		nullRuntimeAdmissionReason,
		retrySettings,
		hostRunContext,
		headlessObservation,
		missingOutputs,
	};
}

/** The options one tool call is invoked with, read from the running turn when the call starts. */
export function toolInvokeOptions(
	loop: ChatLoopScope,
	state: ChatLoopToolOptionsState,
	toolCallId?: string,
): Partial<ToolInvokeOptions> {
	const { deps, steerInterrupter, requestBudgetRoll, hostRunContext, headlessObservation } = loop;
	const options: Partial<ToolInvokeOptions> = {
		toolResultMaxBytes: deps.getSettings().context.toolResultMaxBytes,
		abortCause: () => state.activeInterruptReason ?? state.toolProseAbortReason,
		steerInterrupt: steerInterrupter,
		...toolLimitOptions(deps.getSettings().safety),
		...observedToolCallOrigin(state.runtime?.agent.state.messages ?? [], toolCallId),
	};
	const batch = toolCallBatch(state.runtime?.agent.state.messages ?? [], toolCallId);
	if (batch !== undefined) {
		options.correlationId = batch.id;
		options.batchSize = batch.size;
	}
	const yolo = (deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy) === "yolo";
	options.turnBudgetContinues = budgetCrossingContinues({
		yolo,
		machineTurn: loop.machineTurnRunning !== null,
		failure: state.continuation.stop,
		locked: state.synthesisToolLock,
		continuations: state.continuation.yoloContinuations,
	});
	if (options.turnBudgetContinues) options.observationBudgetRoll = () => requestBudgetRoll("observation");
	// Yolo keeps XR-6 exactly, its stops included; the headless roll is never its fallback (CLI-P42).
	else if (!yolo && headlessObservation !== null) Object.assign(options, headlessObservation.invokeOptions(batch?.id));
	// The per-turn budgets follow this route's measured calls per round (CLI-P26).
	const scale = turnBudgetWidthScale(
		routeCallsPerRound(state.runtime?.agent.state.messages ?? [], state.runtime?.agent.state.model?.id),
	);
	if (scale > 1) options.turnBudgetScale = scale;
	const hostRun = hostRunContext.getStore();
	if (hostRun !== undefined) options.hostRun = hostRun;
	const sessionId = deps.session?.current()?.id ?? null;
	if (sessionId) options.sessionId = sessionId;
	const turnId = state.activeUserTurnId ?? state.lastTurnId;
	if (turnId) options.turnId = turnId;
	if (state.currentPendingSkillPolicy) options.pendingSkillPolicy = state.currentPendingSkillPolicy;
	if (state.currentTurnConstraints) options.turnConstraints = state.currentTurnConstraints;
	if (state.currentAskUserPolicy) options.askUserPolicy = state.currentAskUserPolicy;
	return options;
}
