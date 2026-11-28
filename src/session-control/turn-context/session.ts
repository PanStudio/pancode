// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { assistantOutputChars } from "../../core/assistant-output.js";
import { isHostPolicyMessage } from "../../core/host-policy-message.js";
import { mainAgent } from "../../core/telemetry/context.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { pancodeStateDir } from "../../core/xdg.js";
import {
	type CaptureContextSnapshotInput,
	type ContextSnapshot,
	captureContextSnapshot,
	ceilChars,
} from "../../domains/session/context-accounting.js";
import type { SessionEntry } from "../../domains/session/entries.js";
import { readPromptCompileRecords } from "../../domains/session/prompt-manifest.js";
import { readSessionContextSnapshots } from "../../domains/telemetry/index.js";
import { engineInitialSystemPrompt, setEngineCodexConfiguration } from "../../engine/agent.js";
import type { AgentMessage } from "../../engine/types.js";
import { extractUserText } from "../chat-loop-messages.js";
import type { TurnContext } from "../turn-context.js";
import type { TurnContextScope } from "../turn-context-scope.js";
import type { AgentRuntime } from "../turn-state.js";
import { tokenCount } from "./helpers.js";

/** The newest reduction on `path`, in the shape a live commit notes it. */
function compactionEventOnPath(
	path: ReadonlyArray<SessionEntry>,
): { stage: string; tokensBefore: number; tokensAfter: number; trigger: string } | null {
	for (let index = path.length - 1; index >= 0; index -= 1) {
		const entry = path[index];
		if (entry?.kind === "contextEviction") {
			const stage = entry.trigger === "superseded" ? "superseded" : "working_set";
			return { stage, tokensBefore: entry.tokensBefore, tokensAfter: entry.tokensAfter, trigger: entry.trigger };
		}
		if (entry?.kind === "compactionSummary") {
			if (entry.tokensAfter === undefined) return null;
			const stage = entry.trigger === "step" ? "step_checkpoint" : "llm_summary";
			return {
				stage,
				tokensBefore: entry.tokensBefore,
				tokensAfter: entry.tokensAfter,
				trigger: entry.trigger ?? "unknown",
			};
		}
	}
	return null;
}

/** The persisted snapshot's split as a journal record, under the real session and turn (#434). */
function recordContextSnapshot(sessionId: string, snapshot: ContextSnapshot): void {
	const split = snapshot.categories;
	telemetryHub().emit(
		"context.snapshotted",
		{
			snapshotId: snapshot.snapshotId,
			providerId: snapshot.providerId,
			runtimeId: snapshot.runtimeId,
			modelId: snapshot.modelId,
			splits: snapshot.sources.splits,
			...(snapshot.promptSegments ? { promptSegments: snapshot.promptSegments } : {}),
			...(snapshot.promptHash ? { promptHash: snapshot.promptHash } : {}),
			...(snapshot.toolSignature ? { toolSignature: snapshot.toolSignature } : {}),
			...(snapshot.messageRange ? { messageRange: snapshot.messageRange } : {}),
			...(snapshot.divergenceRatio !== undefined ? { divergenceRatio: snapshot.divergenceRatio } : {}),
			categories: {
				system: tokenCount(split.system),
				tools: tokenCount(split.tools),
				...(split.toolResults !== undefined ? { toolResults: tokenCount(split.toolResults) } : {}),
				agents: tokenCount(split.agents),
				skills: tokenCount(split.skills),
				memory: tokenCount(split.memory),
				project: tokenCount(split.project),
				messages: tokenCount(split.messages),
				reserve: tokenCount(split.reserve),
				free: tokenCount(split.free),
				streaming: tokenCount(split.streaming),
			},
			window: {
				desired: tokenCount(snapshot.desiredContextWindow),
				effective: tokenCount(snapshot.effectiveContextWindow),
				source: snapshot.contextWindowSource || "unknown",
			},
			source: snapshot.sources.total,
			...(snapshot.estimatedTokens !== undefined ? { estimatedTokens: tokenCount(snapshot.estimatedTokens) } : {}),
			...(snapshot.reconciledTokens !== undefined ? { reconciledTokens: tokenCount(snapshot.reconciledTokens) } : {}),
		},
		{
			sessionId,
			agent: mainAgent(sessionId),
			...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
			...(snapshot.callId && snapshot.attemptId ? { callId: snapshot.callId, attemptId: snapshot.attemptId } : {}),
		},
	);
}

export function createTurnContextSession(shared: TurnContextScope) {
	const persistContextSnapshot = (snapshot: ContextSnapshot): void => {
		const currentSession = shared.deps.session?.current();
		if (!currentSession) {
			shared.snapshotPersistPending = true;
			return;
		}
		if (snapshot.sessionId !== null && snapshot.sessionId !== currentSession.id) return;
		snapshot.sessionId = currentSession.id;
		recordContextSnapshot(currentSession.id, snapshot);
		shared.snapshotPersistPending = false;
	};

	/**
	 * Capture a context snapshot from the runtime's live agent state. All
	 * capture sites (turn submit, both compaction paths) flow through this
	 * helper so window resolution and category decomposition stay identical.
	 */
	const captureRuntimeContextSnapshot = (
		agentRuntime: AgentRuntime,
		turnId: string,
		compactionThreshold: number | null,
		extra: Partial<CaptureContextSnapshotInput> = {},
	): ContextSnapshot => {
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		const systemPrompt = engineInitialSystemPrompt(agentRuntime.agent);
		// The compiled prompt the agent carries splits itself, so a capture that names no
		// segments (a checkpoint, an eviction) keeps the Agent fleet and Project rows
		// instead of folding the whole prompt into System prompt (bt-48).
		const compiled =
			shared.sessionPrompt !== null && shared.sessionPrompt.systemPrompt === systemPrompt ? shared.sessionPrompt : null;
		// The snapshot row belongs to the named PanCode session whose ledger it is
		// appended to; the engine agent's own sessionId is unset in practice.
		return captureContextSnapshot({
			sessionId: shared.deps.session?.current()?.id ?? null,
			turnId,
			providerId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			modelId: agentRuntime.wireModelId,
			systemPrompt,
			conversationMessages: agentRuntime.agent.state.messages.filter(
				(message) => message.role !== "system" || isHostPolicyMessage(message),
			),
			activeToolSchemas: agentRuntime.agent.state.tools,
			desiredContextWindow: details.desiredContextWindow,
			effectiveContextWindow: details.effectiveContextWindow,
			contextWindowSource: details.contextWindowSource,
			compactionThreshold,
			...extra,
			...(compiled
				? {
						promptSegments: compiled.sections.map((s) => ({ id: s.id, tokenEstimate: s.tokenEstimate })),
						promptHash: compiled.systemPromptHash,
					}
				: {}),
		});
	};

	/**
	 * Output tokens of the in-flight response. While streaming, estimate from
	 * the partial assistant tail; once the turn settles, the reconciled
	 * snapshot carries the provider-reported value.
	 */
	const liveStreamingOutputTokens = (): number => {
		if (!shared.state.runtime) return 0;
		if (shared.state.streaming) {
			const partial = shared.state.runtime.agent.state.streamingMessage;
			if (partial?.role === "assistant") {
				return ceilChars(assistantOutputChars(partial));
			}
			return 0;
		}
		return shared.currentContextSnapshot?.categories.streaming || 0;
	};

	/**
	 * Tokens for the submitted text that the snapshot has not yet counted.
	 * The turn snapshot is captured before the user message joins the
	 * conversation, so until the provider reconciles (or a fresh capture sees
	 * the text in the conversation) the pending input occupies window space
	 * that no category covers. Zero once reconciled or once the text landed.
	 */
	const pendingUserInputTokens = (): number => {
		const snapshot = shared.currentContextSnapshot;
		if (!snapshot?.pendingUserInput) return 0;
		if (snapshot.sources.total === "reconciled") return 0;
		if (snapshot.turnId !== "pending") {
			const pending = snapshot.pendingUserInput;
			const landed = (snapshot.conversationMessages ?? []).some(
				(message) => extractUserText(message as AgentMessage) === pending,
			);
			if (landed) return 0;
		}
		return ceilChars(snapshot.pendingUserInput.length);
	};

	/**
	 * The window the next turn will resolve to, read the way ensureRuntime
	 * reads it but without building an agent. Before the first turn of a
	 * process, /resume included, state.runtime is null, and the ledger and the
	 * footer meter said `context window unknown · 0 tokens` until a turn ran
	 * (issue #189). Null when no target is configured or it does not resolve,
	 * and the overlay's "unknown" is then true.
	 */
	/**
	 * The prompt hash this session last recorded, for the first compile of a
	 * resumed process. Without it a resume reports `previousHash: null`, which
	 * reads as "there was no prompt before" when in fact there was one and it
	 * is exactly what a reader needs to attribute the cold cache to: a layout
	 * bump, a fragment edit, or a moved context window (issue #249).
	 */
	const lastRecordedPromptHash = (): string | null => {
		if (shared.resumedPromptHashRead) return shared.resumedPromptHash;
		shared.resumedPromptHashRead = true;
		const currentSession = shared.deps.session?.current();
		if (!currentSession) {
			// No session to read; leave the lookup open for the next compile.
			shared.resumedPromptHashRead = false;
			return null;
		}
		const records = readPromptCompileRecords(currentSession);
		const previous = records[records.length - 1];
		shared.resumedPromptHash = previous?.systemPromptHash ?? null;
		shared.previousPromptSections = previous?.sections ?? null;
		return shared.resumedPromptHash;
	};
	const methods: Required<Pick<TurnContext, "resetForSession" | "dispose">> = {
		resetForSession(incomingBranchAnchorTurnId: string | null = null): void {
			shared.cacheCallBaseline = null;
			shared.cacheCallBaselineLoaded = false;
			shared.cacheGeneration += 1;
			if (shared.state.runtime) setEngineCodexConfiguration(shared.state.runtime.agent, undefined);
			shared.thinkingUsesConfigurationUpdate = false;
			shared.cacheRequestToolChoice = "auto";
			shared.sentToolChoice = undefined;
			shared.priorSentToolChoice = undefined;
			shared.nextChangedSection = undefined;
			shared.previousPromptSections = null;
			shared.postureGeneration = null;
			shared.postureGenerationPersisted = false;
			shared.pendingPosture = null;
			shared.memoryTurn = null;
			shared.memoryAuthorityEpoch += 1;
			shared.compactionController?.abort();
			// An in-process switch replaces the whole prefix: the backend's slot
			// still holds the outgoing session's prompt and history, so the first
			// turn on the incoming one is expected-cold on every tier, exactly as
			// a recompile is. The manifest can no longer say so on its own once
			// provenance follows the session, because the incoming session's last
			// recorded hash usually equals its fresh compile, so the stamp comes
			// from here. Only when this process had actually applied a prompt:
			// before the first compile there is nothing in the slot to have lost.
			if (shared.sessionPromptHash !== null) shared.noteColdReason("prompt_recompiled");
			shared.frozenMemorySection = null;
			shared.frozenRouteSources = undefined;
			shared.frozenRouteIdentity = "";
			shared.frozenMemorySessionId = "";
			shared.sessionPromptDelta = "";
			shared.lastPromptCache = null;
			shared.lastPrewarm = null;
			shared.lastSystemPromptReused = false;
			shared.sessionPromptHash = null;
			shared.sessionPromptKey = null;
			shared.sessionPromptInvalidated = false;
			shared.resumedPromptHashRead = false;
			shared.resumedPromptHash = null;
			shared.sessionWorkingContextPaths.clear();
			shared.pendingPromptLogEntry = null;
			shared.pendingPromptLogMemory = null;
			shared.memoryRestoredSessionId = null;
			shared.cacheRequestSystemPromptHash = undefined;
			shared.sentSystemPrompt = undefined;
			shared.priorSentSystemPrompt = undefined;
			shared.latestPromptCompile = null;
			shared.emptyAutoCompactContextKey = null;
			shared.autoCompactFailures = 0;
			shared.summaryRearm = null;
			shared.summaryRearmSeededFor = null;
			shared.noGainSummaryDigest = null;
			shared.noUsefulCutBasisKey = null;
			shared.contextFold.resetAutoHold();
			shared.reconciledAnchor = null;
			shared.rehydrationMiss = null;
			// The last reduction /context and ACP name is the one on the path now current, not the branch left.
			shared.lastCompactionEvent = compactionEventOnPath(shared.activeEntries());
			// Real branch navigation. The epoch separates two visits to the same
			// leaf id, so an advisory announced on the branch this session left is
			// re-armed rather than treated as already said.
			shared.branchAnchorTurnId = incomingBranchAnchorTurnId;
			shared.navigationEpoch += 1;
			shared.bindMemoryScope();
			shared.budgetProducer.reset();
			const session = shared.deps.session?.current();
			const snapshots = session ? readSessionContextSnapshots(pancodeStateDir(), session.id) : [];
			const persisted = snapshots.at(-1) ?? null;
			// The figure the session was last measured at, so the journal can set the resumed projection beside it: the
			// newest reconciled snapshot, since a submit cancelled before usage leaves an estimated one after it.
			let measured: (typeof snapshots)[number] | undefined;
			for (let index = snapshots.length - 1; index >= 0 && measured === undefined; index -= 1) {
				const snapshot = snapshots[index];
				if (snapshot?.sources.total === "reconciled" && snapshot.reconciledTokens !== undefined) measured = snapshot;
			}
			shared.resumedBudget = session
				? {
						sessionId: session.id,
						priorTokens:
							measured?.reconciledTokens !== undefined ? measured.reconciledTokens + measured.categories.streaming : null,
					}
				: null;
			// The session's latest capture may describe the branch just left; a runtime captures the history now in place.
			shared.currentContextSnapshot = shared.state.runtime
				? captureRuntimeContextSnapshot(
						shared.state.runtime,
						incomingBranchAnchorTurnId ?? "session",
						shared.deps.getSettings().context.compaction?.threshold ?? null,
					)
				: persisted;
		},
		dispose(): void {
			shared.disposed = true;
			shared.compactionController?.abort();
			for (const unsubscribe of shared.unsubscribeColdReasonSources) unsubscribe?.();
		},
	};
	return {
		persistContextSnapshot,
		captureRuntimeContextSnapshot,
		liveStreamingOutputTokens,
		pendingUserInputTokens,
		lastRecordedPromptHash,
		methods,
	};
}
