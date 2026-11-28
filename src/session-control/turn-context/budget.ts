// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../../core/config.js";
import {
	type LiveBudgetInput,
	type LiveBudgetView,
	resolveLiveBudgetPolicy,
} from "../../domains/context/budget/live-view.js";
import { compactionBudget, getCatalogModelForRuntime } from "../../domains/providers/catalog.js";
import { type ContextSnapshot, snapshotInputTokens } from "../../domains/session/context-accounting.js";
import { engineInitialSystemPrompt } from "../../engine/agent.js";
import { toolSignatureFromState } from "../chat-loop-messages.js";
import type { MessageListDigests } from "../message-list-digest.js";
import { resolveFitOutputReserve } from "../output-reserve.js";
import type { LiveContextEstimate } from "../turn-context.js";
import type { AgentRuntime } from "../turn-state.js";
import { capturedBreakdown, optionalProjection, snapshotWindowSource } from "./helpers.js";
import { sha256Json, type TurnContextScope } from "./scope.js";

/**
 * The token and route facts of one budget publication, separate from the
 * identity fields that name it. Split out so the live and pre-runtime paths
 * produce the same shape and the reduction basis can be keyed over it after it
 * is resolved rather than before.
 */
type LiveBudgetAccounting = Pick<
	LiveBudgetInput,
	| "targetId"
	| "runtimeId"
	| "modelId"
	| "modelApi"
	| "effectiveWindow"
	| "windowSource"
	| "estimatedInputTokens"
	| "anchoredInputTokens"
	| "inputTokens"
	| "inputSource"
	| "historical"
	| "breakdown"
	| "breakdownSource"
	| "outputReserveTokens"
>;

export function createTurnContextBudget(shared: TurnContextScope) {
	/** The system prompt rarely changes between publications; hash it again only when it does. */
	const systemPromptDigest = (prompt: string | null): string => {
		if (shared.promptDigest?.prompt !== prompt) shared.promptDigest = { prompt, digest: sha256Json(prompt) };
		return shared.promptDigest.digest;
	};

	/**
	 * Identity of the exact material the next request would carry, plus the
	 * settings that decide its reserve and whether a reduction is even eligible.
	 * This is the pre-accounting half: the reduction basis adds the resolved
	 * estimate, cap, and reservation on top of it.
	 *
	 * Token counts alone cannot do this job: `estimateAgentMessageTokens` prices
	 * by character count, so replacing a message with another of the same length
	 * leaves every figure identical while the request is a different one. The
	 * conversation is therefore hashed by content, not by length or count.
	 */
	const liveBudgetContentFingerprint = (
		agentRuntime: AgentRuntime | null,
		pendingUserText: string | undefined,
		promptFingerprint: string | null,
		toolSignature: string | null,
		history?: MessageListDigests,
	): string => {
		const settings = shared.deps.getSettings();
		const eligibility = {
			compaction: settings.context.compaction ?? null,
			workingSet: settings.context.workingSet ?? null,
			maxOutputTokens: settings.chat?.maxOutputTokens ?? null,
		};
		if (!agentRuntime) {
			const snapshot = shared.currentContextSnapshot;
			return sha256Json([
				"historical/1",
				settings.chat?.target ?? null,
				settings.chat?.model ?? null,
				snapshot?.snapshotId ?? null,
				snapshot ? snapshotInputTokens(snapshot) : null,
				snapshot?.sources.total ?? null,
				shared.windowWithoutRuntime().contextWindow,
				promptFingerprint,
				toolSignature,
				eligibility,
			]);
		}
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		return sha256Json([
			"live/1",
			agentRuntime.targetId,
			agentRuntime.runtimeId,
			agentRuntime.wireModelId,
			agentRuntime.agent.state.model?.api ?? null,
			details.effectiveContextWindow,
			details.contextWindowSource,
			promptFingerprint,
			toolSignature,
			// Same serialization the anchor validates its attested prefix with, so
			// the two cannot disagree about whether the conversation changed.
			(history ?? shared.observeHistory(agentRuntime)).digest(),
			pendingUserText ?? null,
			pendingUserText === undefined ? null : shared.pendingUserImages,
			eligibility,
		]);
	};

	/**
	 * Token facts of the live next request, all from one `liveContextEstimate`
	 * call: the same one admission budgets against. Old snapshot categories are
	 * never summed to reconstruct the total, and streaming output is never added
	 * on top, because the live next-request message list already carries the
	 * completed assistant turn and the estimate already carries the pending
	 * text. Each is charged exactly once.
	 */
	const liveRuntimeAccounting = (
		agentRuntime: AgentRuntime,
		pendingUserText: string | undefined,
		history?: MessageListDigests,
		computed?: LiveContextEstimate,
	): LiveBudgetAccounting => {
		const estimate = computed ?? shared.liveContextEstimate(agentRuntime, pendingUserText, undefined, history);
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		// After an overflow fold that fit, the view publishes the A4 count it fitted, so the card, admission and Pi's
		// clamp read one figure until the request that carries it goes out.
		const inputTokens = shared.overflowPinArmed()
			? shared.overflowFitTokens(agentRuntime, pendingUserText, estimate.tokens)
			: estimate.tokens;
		return {
			targetId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			modelId: agentRuntime.wireModelId,
			modelApi: agentRuntime.agent.state.model?.api ?? null,
			effectiveWindow: details.effectiveContextWindow > 0 ? details.effectiveContextWindow : null,
			windowSource: details.contextWindowSource,
			estimatedInputTokens: estimate.estimatedTokens,
			anchoredInputTokens: estimate.reconciledTokens,
			inputTokens,
			inputSource: estimate.reconciledTokens === null ? "estimated" : "anchored-plus-estimated-tail",
			historical: false,
			breakdown: { ...estimate.breakdown },
			breakdownSource: "live",
			outputReserveTokens: resolveFitOutputReserve(agentRuntime, inputTokens),
		};
	};

	/** Token facts before this process built a runtime: a persisted measurement, labelled as one. */
	const historicalAccounting = (
		snapshot: ContextSnapshot | null,
		settings: Readonly<PancodeSettings>,
	): LiveBudgetAccounting => {
		// Inspection uses already-loaded capture facts, never a diagnostic-ledger scan.
		const sameRoute =
			!snapshot || (snapshot.providerId === settings.chat?.target && snapshot.modelId === settings.chat?.model);
		// A saved request from model A cannot acquire model B's window while
		// retaining A's identity and input measurement. Keep that capture coherent.
		const window =
			snapshot && !sameRoute
				? {
						contextWindow: snapshot.effectiveContextWindow,
						contextWindowSource: snapshotWindowSource(snapshot),
					}
				: shared.windowWithoutRuntime();
		const pendingTokens = shared.pendingUserInputTokens();
		return {
			targetId: snapshot?.providerId ?? settings.chat?.target ?? null,
			runtimeId: snapshot?.runtimeId ?? null,
			modelId: snapshot?.modelId ?? settings.chat?.model ?? null,
			modelApi: null,
			effectiveWindow: window.contextWindow > 0 ? window.contextWindow : null,
			windowSource: window.contextWindowSource,
			estimatedInputTokens: snapshot?.estimatedTokens ?? null,
			anchoredInputTokens: snapshot?.reconciledTokens ?? null,
			inputTokens: snapshot ? snapshotInputTokens(snapshot) + pendingTokens : null,
			inputSource: snapshot ? "historical" : "unknown",
			historical: true,
			breakdown: snapshot ? capturedBreakdown(snapshot, pendingTokens) : null,
			breakdownSource: snapshot ? "captured" : null,
			// No resolved route means no honest output reservation, and an unpriced
			// reserve is unknown rather than zero.
			outputReserveTokens: null,
		};
	};

	/**
	 * Assemble one publication from the live runtime, or from the persisted
	 * capture when this process has not built a runtime yet.
	 */
	const liveBudgetInput = (
		pendingUserText?: string,
		capturedHistory?: MessageListDigests,
		estimate?: LiveContextEstimate,
	): LiveBudgetInput => {
		const settings = shared.deps.getSettings();
		const agentRuntime = shared.state.runtime;
		const history = agentRuntime ? (capturedHistory ?? shared.observeHistory(agentRuntime)) : undefined;
		const snapshot = shared.currentContextSnapshot;
		const promptFingerprint = agentRuntime
			? systemPromptDigest(engineInitialSystemPrompt(agentRuntime.agent) ?? null)
			: (snapshot?.promptHash ?? null);
		const toolSignature = agentRuntime
			? toolSignatureFromState(agentRuntime.agent.state.tools)
			: (snapshot?.toolSignature ?? null);
		const contentFingerprint = liveBudgetContentFingerprint(
			agentRuntime,
			pendingUserText,
			promptFingerprint,
			toolSignature,
			history,
		);
		// Two independent existing settings, not one derived from the other: the
		// reduce point is `context.compaction.threshold` and the working-set
		// target is `context.workingSet.target`. A pair the policy refuses is
		// reported as a refusal rather than repaired into a fabricated setting.
		const policyResolution = resolveLiveBudgetPolicy(
			settings.context.compaction?.threshold,
			settings.context.workingSet?.target,
		);

		// Accounting first, then the identity that describes it. A reduction
		// refusal is only reusable for the request the reducer actually saw, and
		// the resolved anchor, cap, and reservation are part of that request even
		// when not a byte of the conversation moved.
		const accounting = agentRuntime
			? liveRuntimeAccounting(agentRuntime, pendingUserText, history, estimate)
			: historicalAccounting(snapshot, settings);
		const economic = compactionBudget(
			accounting.effectiveWindow ?? 0,
			policyResolution.policy.reduce,
			settings.context.compaction.maxTokens,
			agentRuntime?.agent.state.model ??
				getCatalogModelForRuntime(
					accounting.runtimeId ?? settings.targets.find((target) => target.id === accounting.targetId)?.runtime ?? "",
					accounting.modelId ?? "",
				),
		);
		const configured = policyResolution.policy;
		const policy = {
			...configured,
			notice: configured.notice * (economic.threshold / configured.reduce),
			prepare: configured.prepare * (economic.threshold / configured.reduce),
			reduce: economic.threshold,
			target: configured.target * economic.fractionScale,
		};
		const reductionBasisKey = sha256Json([
			"reduction-basis/1",
			contentFingerprint,
			accounting.effectiveWindow,
			accounting.estimatedInputTokens,
			accounting.anchoredInputTokens,
			accounting.inputTokens,
			accounting.inputSource,
			accounting.outputReserveTokens,
			// The resolved cap can move without moving the reservation, because a
			// route clamp may be the binding constraint. Both belong in the key.
			agentRuntime?.runtimeResolution.capabilityDecisions?.maxTokens ?? null,
			snapshot?.categories.reserve ?? null,
			policy.reduce,
			policy.target,
		]);

		return {
			...accounting,
			sessionId: shared.deps.session?.current()?.id ?? snapshot?.sessionId ?? null,
			branchAnchorTurnId: shared.branchAnchorTurnId,
			activeLeafTurnId: shared.state.lastTurnId,
			activeUserTurnId: shared.state.activeUserTurnId,
			capturedSnapshotId: snapshot?.snapshotId ?? null,
			// Compaction headroom recorded by the capture. Carried under its own
			// name so nothing can mistake it for the output reserve.
			thresholdReserveTokens: snapshot?.categories.reserve ?? null,
			policy,
			policyRejection: policyResolution.rejection,
			// Reduction has not been asked about unless an automatic attempt for
			// this exact basis already came back empty.
			reduction:
				shared.noUsefulCutBasisKey !== null && shared.noUsefulCutBasisKey === reductionBasisKey
					? "no-useful-cut"
					: "unknown",
			reductionBasisKey,
			promptFingerprint,
			toolSignature,
			navigationEpoch: shared.navigationEpoch,
			lastReduction: shared.lastCompactionEvent ? { ...shared.lastCompactionEvent } : null,
			pendingHandoff: optionalProjection(shared.deps.getPendingHandoff),
			lastOutcome: optionalProjection(shared.deps.getLastOutcome),
		};
	};

	// A republish while a reduction runs (the summary stage reading the view) prices the request the fold prices,
	// so the card, the record and every usage frame state one figure (bt-47 D1).
	const refreshLiveBudget = (
		pendingUserText?: string,
		history?: MessageListDigests,
		estimate?: LiveContextEstimate,
	): LiveBudgetView =>
		shared.budgetProducer.publish(
			liveBudgetInput(
				pendingUserText ?? (estimate === undefined ? shared.reductionPendingText : undefined),
				history,
				estimate,
			),
		);
	return {
		liveBudgetInput,
		refreshLiveBudget,
	};
}
