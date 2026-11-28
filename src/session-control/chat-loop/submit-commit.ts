// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PendingSkillToolPolicy } from "../../core/skill-activation.js";
import { mainAgent } from "../../core/telemetry/context.js";
import type { CompiledSessionPrompt } from "../../domains/prompts/compiler.js";
import { modelEndpointKey, registerForegroundStream, runtimeTargetSnapshot } from "../../domains/providers/index.js";
import type { ContextSnapshot } from "../../domains/session/context-accounting.js";
import { replaceEngineMessages } from "../../engine/agent.js";
import type { AnthropicMessagesCompat } from "../../engine/types.js";
import type { TurnControlRecord } from "../../lib/turn-control/index.js";
import type { AskUserToolPolicy } from "../../tools/registry-contract.js";
import type { ChatSubmitOptions } from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { SubmitEvidence } from "../run-evidence.js";
import { retireActiveUserContextForNextOperator } from "../session-replay-messages.js";
import type { ChatLoopRunSnapshot, ChatLoopSubmitState } from "../turn-state.js";
import { type AgentRuntime, clearActiveInterrupt } from "../turn-state.js";
import type { SubmitTurn } from "./submit-turn.js";

/** What `submit` hands its commit: the admitted request, fitted to the window, and the facts it compares against. */
export interface SubmitCommitInput {
	options: ChatSubmitOptions;
	admissionCurrent: () => boolean;
	agentRuntime: AgentRuntime;
	interrupted: boolean;
	previousRunSnapshot: ChatLoopRunSnapshot | null;
	previousThinkingLevel: string | undefined;
	previousModel: { targetId: string; modelId: string } | undefined;
	reservedUserTurnId: string;
	operatorText: string;
	referencedPaths: readonly string[];
	turnControlRecord: TurnControlRecord | null;
	pendingSkillPolicy: PendingSkillToolPolicy | undefined;
	toolSignature: string;
	askUserPolicy: AskUserToolPolicy | undefined;
	submittedText: string;
	compiledPrompt: CompiledSessionPrompt | null;
	turnSnapshot: ContextSnapshot;
}

/** The committed turn: its ledger identity, the prompt it runs and the policies its settlement restores. */
export interface SubmitCommit {
	userTurnId: string | null;
	turnIndex: number;
	runtimePromptText: string;
	evidence: SubmitEvidence;
	priorPendingSkillPolicy: PendingSkillToolPolicy | undefined;
	priorAskUserPolicy: AskUserToolPolicy | undefined;
}

/**
 * Commits one admitted turn: appends the user turn, stamps and persists its context snapshot, notes the cache
 * disturbances, marks the loop streaming and arms the turn's policies. Resolves null when the turn lost its
 * admission first; `submit` then returns.
 */
export async function commitSubmittedTurn(
	loop: ChatLoopScope,
	state: ChatLoopSubmitState,
	turn: SubmitTurn,
	input: SubmitCommitInput,
): Promise<SubmitCommit | null> {
	const { context, deps, emit, middlewareToolChoice, operatorTurnIndex, outcomeCollector, persistence, retrySettings } =
		loop;
	const {
		options,
		admissionCurrent,
		agentRuntime,
		interrupted,
		previousRunSnapshot,
		previousThinkingLevel,
		previousModel,
		reservedUserTurnId,
		operatorText,
		referencedPaths,
		turnControlRecord,
		pendingSkillPolicy,
		toolSignature,
		askUserPolicy,
		submittedText,
		compiledPrompt,
	} = input;
	let { turnSnapshot } = input;
	if (!admissionCurrent()) return null;

	if (options.machineTurn !== undefined) {
		if (!options.machineTurn.onStarting() || !admissionCurrent() || state.streaming) return null;
	}

	// 5. Append the user turn, then stamp and persist the snapshot.
	// PendingSkillRequest is intent only; SkillActivation ledger entries
	// are recorded on skill-load success.
	const userTurnId = persistence.appendSubmittedUserTurn(
		agentRuntime,
		submittedText,
		options.images?.length ? options.images : undefined,
		options.requestContinuation === true,
		operatorText,
		options.display?.text,
		reservedUserTurnId,
		options.origin,
		options.operatorAuthored === true,
	);
	// A turn that may only answer and call no tool (`run --output-schema`'s repair) goes out text-only, tool_choice
	// none, with its tool list unchanged so the cached prefix holds (D8, #423). The append above reset the choice.
	if (state.currentTurnConstraints?.mode === "answer" && state.currentTurnConstraints.allowedTools?.length === 0)
		middlewareToolChoice.apply([{ kind: "lock_tools" }]);
	if (referencedPaths.length > 0) deps.labelReferencedPaths?.(referencedPaths);
	const turnIndex = operatorTurnIndex(userTurnId ?? undefined);
	// A continuation is a synthetic user turn, which the count skips.
	if (options.requestContinuation !== true) loop.operatorTurnsBefore = turnIndex + 1;
	context.installMemoryRestoration(agentRuntime, submittedText, userTurnId ?? undefined);
	context.commitMemoryTurn(agentRuntime);
	// An interrupt was submitted while a run was active, so no caller drew
	// it in the transcript; render it here, after the cancel notice and the
	// cancelled run's leftovers, which is the order the ledger has. A queued
	// entry sent from idle has no caller to draw it either.
	if (interrupted || (options.steering === "interrupt" && options.queued !== undefined))
		emit({
			type: "queued_user_turn",
			text: operatorText,
			kind: "interrupt",
			...(options.display ? { display: options.display } : {}),
			...(options.origin !== undefined ? { origin: options.origin } : {}),
		});
	// The first submit creates its session after capture; open its writer before session events land (#434).
	const landedSession = deps.session?.current();
	if (!turn.turnLease && landedSession && deps.telemetry?.acquireTelemetrySession) {
		try {
			turn.turnLease = await deps.telemetry.acquireTelemetrySession(landedSession, mainAgent(landedSession.id));
		} catch {
			// The writer reports its own failure; telemetry cannot abort a submitted turn (#434).
		}
	}
	context.logPromptCompileIfPending();
	if (turnControlRecord) {
		outcomeCollector.recordControl(turnControlRecord);
		if (deps.session?.current()) {
			try {
				deps.session.appendEntry({
					kind: "custom",
					customType: "turnControl",
					parentTurnId: state.lastTurnId,
					display: false,
					data: turnControlRecord,
				});
			} catch {
				/* S6: ledger recording is best effort and never costs the admitted turn. */
			}
		}
	}
	// #423: Pi's native effort and tool updates preserve the cached prefix on capable models.
	const cacheModel = agentRuntime.agent.state.model;
	const cacheCompat =
		cacheModel.api === "anthropic-messages" ? (cacheModel.compat as AnthropicMessagesCompat | undefined) : undefined;
	if (
		previousThinkingLevel !== undefined &&
		previousThinkingLevel !== agentRuntime.runtimeResolution.effectiveThinkingLevel &&
		!context.thinkingUsesConfigurationUpdate() &&
		cacheCompat?.supportsMidConvoEffort !== true
	) {
		context.noteColdReason("thinking_change");
	}
	if (
		typeof previousRunSnapshot?.toolSignature === "string" &&
		previousRunSnapshot.toolSignature !== toolSignature &&
		!(cacheCompat?.supportsMidConvoToolChanges === true && cacheCompat.supportsMidConvoSystemMessages === true)
	) {
		context.noteColdReason("tool_surface_change");
	}
	// A request on another target or wire model shares no cached prefix with the previous call's (#434).
	if (
		previousModel !== undefined &&
		(previousModel.targetId !== agentRuntime.targetId || previousModel.modelId !== agentRuntime.wireModelId)
	) {
		context.noteColdReason("model_changed");
	}
	turnSnapshot = { ...turnSnapshot, turnId: userTurnId ?? "unknown" };
	context.setCurrentSnapshot(turnSnapshot);
	context.persistContextSnapshot(turnSnapshot);
	const promptHash = compiledPrompt?.systemPromptHash ?? null;
	state.lastRunSnapshot = {
		targetId: agentRuntime.targetId,
		targetUrl: agentRuntime.runtimeResolution.target.url ?? null,
		runtimeId: agentRuntime.runtimeId,
		runtimeKind: agentRuntime.runtimeResolution.runtimeKind,
		wireModelId: agentRuntime.wireModelId,
		autonomy: deps.getSettings().safety.autonomy,
		pricedBy: agentRuntime.runtimeResolution.pricedBy,
		compiledPromptHash: promptHash,
		staticCompositionHash: promptHash,
		promptSignature: promptHash,
		toolSignature,
		runtimeResolution: runtimeTargetSnapshot(agentRuntime.runtimeResolution),
		sessionId: deps.session?.current()?.id ?? null,
		cwd: process.cwd(),
	};

	agentRuntime.agent.maxRetryDelayMs = retrySettings().maxDelayMs;
	state.toolProseAbortReason = null;
	state.toolProseAssessedChars = 0;
	state.repetitionAbortReason = null;
	clearActiveInterrupt(state);
	state.interruptedAssistantMessage = null;
	state.interruptedCall = null;

	// 6. Cache-disturbance honesty (T3.3)
	context.consumeExpectedColdReasons(agentRuntime.runtimeId);

	// 7. Run the prompt, then route the settled state through recovery.
	loop.boundaryStop = null;
	loop.budgetRoll = null;
	state.streaming = true;
	deps.autonomy?.turnStarted();
	const foregroundOn = (runtime: AgentRuntime): (() => void) => {
		const endpointKey = modelEndpointKey(runtime.runtimeResolution.target, runtime.wireModelId);
		return endpointKey === null ? () => {} : registerForegroundStream(endpointKey);
	};
	turn.releaseForeground = foregroundOn(agentRuntime);
	loop.moveForeground = (runtime) => {
		turn.releaseForeground();
		turn.releaseForeground = foregroundOn(runtime);
	};
	try {
		options.onAdmitted?.();
	} catch {
		// Admission observers are bookkeeping only and cannot affect the turn.
	}
	const runtimePromptText = submittedText;
	if (options.requestContinuation !== true && deps.readSessionEntries) {
		const prior = agentRuntime.agent.state.messages;
		const retired = retireActiveUserContextForNextOperator(prior, deps.readSessionEntries(), {
			...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
		});
		// Only an unsent block retires, so no request's history is rewritten (bt-40).
		if (retired.length < prior.length) replaceEngineMessages(agentRuntime.agent, retired);
	}
	loop.terminalTurnFailure = undefined;
	loop.turnRetryAttempts = 0;
	loop.providerRetryAttempts = 0;
	const evidence = state.runEvidence.beginSubmit();
	loop.stepTurnScope = { evidence, continuation: options.yoloContinuation === true };
	const priorPendingSkillPolicy = state.currentPendingSkillPolicy;
	const priorAskUserPolicy = state.currentAskUserPolicy;
	state.currentPendingSkillPolicy = pendingSkillPolicy;
	state.currentAskUserPolicy = askUserPolicy;
	return { userTurnId, turnIndex, runtimePromptText, evidence, priorPendingSkillPolicy, priorAskUserPolicy };
}
