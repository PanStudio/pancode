// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isHostPolicyMessage } from "../../core/host-policy-message.js";
import {
	type ContextSnapshot,
	endpointDigest,
	estimateAgentContextBreakdown,
	latestUsableAssistantUsage,
	reconcileSnapshot,
	rehydrationRecord,
} from "../../domains/session/context-accounting.js";
import { type EvictionAnchor, HOST_INSERT_CUSTOM_TYPE, isHostInsertData } from "../../domains/session/entries.js";
import { activePath } from "../../domains/session/tree/active-path.js";
import { engineInitialSystemPrompt } from "../../engine/agent.js";
import type { AgentMessage, Usage } from "../../engine/types.js";
import type { MessageListDigests } from "../message-list-digest.js";
import { continuityContextFromSession, renderModelReplay } from "../model-session-replay.js";
import type { TurnContext } from "../turn-context.js";
import type { AgentRuntime } from "../turn-state.js";
import { anchorModelKey, carriedTokens, sameRoute } from "./helpers.js";
import { sha256Json, type TurnContextScope } from "./scope.js";

export function createTurnContextAnchor(shared: TurnContextScope) {
	/**
	 * Seed the live anchor from the eviction record step 1 selects (ContextFold §4 step 3). The record's figure covers
	 * the history elements whose rows precede it; an element whose row was written later, such as an insert rendered
	 * ahead of it, is priced on top. The history has to be the path's render, byte for byte, or the figure describes
	 * another request and the estimate stays structural.
	 */
	const rehydrateAnchor = (agentRuntime: AgentRuntime, observed: MessageListDigests): boolean => {
		const stream = shared.deps.readSessionEntries?.() ?? [];
		if (stream.length === 0) return false;
		const key = JSON.stringify([stream.length, shared.state.lastTurnId, observed.digest(), anchorModelKey(agentRuntime)]);
		if (shared.rehydrationMiss?.key === key && shared.rehydrationMiss.runtime === agentRuntime) return false;
		shared.rehydrationMiss = { key, runtime: agentRuntime };
		const path = activePath(stream, shared.state.lastTurnId ?? undefined);
		const record = rehydrationRecord(path);
		if (!record || !sameRoute(agentRuntime, record.anchor.route)) return false;
		const render = renderModelReplay(stream, {
			...(shared.state.lastTurnId ? { activeLeafTurnId: shared.state.lastTurnId } : {}),
			continuity: continuityContextFromSession(shared.deps.session),
		});
		const rendered: AgentMessage[] = [];
		const sources: Array<string | null> = [];
		render.messages.forEach((message, index) => {
			if (message.role === "system" && !isHostPolicyMessage(message)) return;
			rendered.push(message);
			sources.push(render.sourceIds[index] ?? null);
		});
		if (rendered.length > observed.messages.length || observed.digest(rendered.length) !== sha256Json(rendered))
			return false;
		const position = new Map<string, number>();
		path.forEach((entry, index) => {
			position.set(entry.turnId, index);
			if (entry.kind === "custom" && entry.customType === HOST_INSERT_CUSTOM_TYPE && isHostInsertData(entry.data))
				position.set(entry.data.id, index);
		});
		const recordIndex = path.indexOf(record);
		// An element with no row of its own, such as a continuity block, is priced on top: the figure may not cover it.
		const written = sources.map((source) => (source === null ? Number.POSITIVE_INFINITY : (position.get(source) ?? -1)));
		let covered = written.length - 1;
		while (covered >= 0 && (written[covered] ?? 0) > recordIndex) covered -= 1;
		let tokens = record.anchor.tokens;
		for (let index = 0; index < covered; index += 1)
			if ((written[index] ?? 0) > recordIndex) tokens += observed.messageTokens[index] ?? 0;
		shared.rehydrationMiss = null;
		shared.reconciledAnchor = {
			tokens,
			anchoredMessages: observed.messages.slice(0, covered + 1),
			contentDigest: observed.digest(covered + 1),
			runtime: agentRuntime,
			model: agentRuntime.agent.state.model,
			modelKey: anchorModelKey(agentRuntime),
			targetId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			wireModelId: agentRuntime.wireModelId,
			systemPromptTokens: record.anchor.sys,
			toolSchemaTokens: record.anchor.tools,
			measured: false,
		};
		return true;
	};

	/**
	 * At a commit with no live anchor, the usage the fallback rehydrated from the replayed history becomes the live
	 * anchor, so the carry has a figure to subtract the saving from; the eviction then invalidates that usage. The
	 * figure is the fallback's own: the usage, its system and tools as they stand, and the elements after it priced.
	 */
	const seedAnchorFromUsage = (agentRuntime: AgentRuntime, observed: MessageListDigests): void => {
		const usage = latestUsableAssistantUsage(observed.messages);
		if (!usage) return;
		const breakdown = estimateAgentContextBreakdown({
			systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
			messages: [],
			tools: agentRuntime.agent.state.tools,
		});
		shared.reconciledAnchor = {
			tokens: usage.tokens,
			anchoredMessages: observed.messages.slice(0, usage.index + 1),
			contentDigest: observed.digest(usage.index + 1),
			runtime: agentRuntime,
			model: agentRuntime.agent.state.model,
			modelKey: anchorModelKey(agentRuntime),
			targetId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			wireModelId: agentRuntime.wireModelId,
			systemPromptTokens: breakdown.systemPromptTokens,
			toolSchemaTokens: breakdown.toolSchemaTokens,
			// Seeded only for the carry that follows, from a usage whose route this does not check.
			measured: false,
		};
	};

	/**
	 * Price appended history separately so eviction can retain it without folding in static growth twice. With no
	 * live anchor, an anchored eviction record on the path seeds one; `commit` also seeds one from a replayed usage.
	 * Elements past the anchor are priced by `messageTokens`, the basis for content no count has measured.
	 */
	const reconciledHistoryTokens = (
		agentRuntime: AgentRuntime,
		history?: MessageListDigests,
		commit = false,
	): number | null => {
		const observed = history ?? shared.observeHistory(agentRuntime);
		if (!shared.reconciledAnchor && !rehydrateAnchor(agentRuntime, observed) && commit)
			seedAnchorFromUsage(agentRuntime, observed);
		const anchor = shared.reconciledAnchor;
		if (!anchor) return null;
		const messages = observed.messages;
		// The identity, route, and length checks are cheap and run first; `||`
		// short-circuits, so the content digest is only computed for a prefix that
		// still looks like the attested one. The digest covers the attested prefix
		// and never the tail, so an append does not invalidate the anchor. The
		// history fold caches each message's bytes and trusts them while the
		// message's identity and key/leaf trace match, so an in-place edit still
		// re-folds from the first changed message.
		if (
			anchor.runtime !== agentRuntime ||
			anchor.model !== agentRuntime.agent.state.model ||
			anchor.modelKey !== anchorModelKey(agentRuntime) ||
			anchor.targetId !== agentRuntime.targetId ||
			anchor.runtimeId !== agentRuntime.runtimeId ||
			anchor.wireModelId !== agentRuntime.wireModelId ||
			anchor.anchoredMessages.length > messages.length ||
			anchor.anchoredMessages.some((message, index) => message !== messages[index]) ||
			observed.digest(anchor.anchoredMessages.length) !== anchor.contentDigest
		) {
			shared.reconciledAnchor = null;
			return null;
		}
		let tail = 0;
		for (let i = anchor.anchoredMessages.length; i < messages.length; i += 1) tail += observed.messageTokens[i] ?? 0;
		return anchor.tokens + tail;
	};

	/**
	 * The provider-measured anchor of this route under `observed`, or null. The live anchor counts when
	 * `reconciledHistoryTokens` (route, prefix identity and digest) kept it and a call measured it: a figure carried
	 * through an eviction or rehydrated from its record priced its tail at chars/4 and does not count (bt-47 D-A).
	 * With no live anchor, as on a resumed session, the newest usable usage counts when the same model, provider,
	 * API and endpoint reported it; an eviction or masking since stamped it unusable.
	 */
	const measuredAnchor = (
		agentRuntime: AgentRuntime,
		observed: MessageListDigests,
	): { tokens: number; covered: number; systemPromptTokens: number; toolSchemaTokens: number } | null => {
		if (reconciledHistoryTokens(agentRuntime, observed) !== null) {
			const anchor = shared.reconciledAnchor;
			return anchor?.measured
				? {
						tokens: anchor.tokens,
						covered: anchor.anchoredMessages.length,
						systemPromptTokens: anchor.systemPromptTokens,
						toolSchemaTokens: anchor.toolSchemaTokens,
					}
				: null;
		}
		if (shared.reconciledAnchor) return null;
		const usage = latestUsableAssistantUsage(observed.messages);
		const message = usage
			? (observed.messages[usage.index] as { api?: unknown; provider?: unknown; model?: unknown; baseUrlDigest?: unknown })
			: null;
		const model = agentRuntime.agent.state.model;
		if (!usage || !message || !model) return null;
		if (message.api !== model.api || message.provider !== model.provider || message.model !== model.id) return null;
		// A reply recorded with its endpoint counts only on that endpoint; one recorded before the stamp keeps the old rule.
		if (message.baseUrlDigest !== undefined && message.baseUrlDigest !== endpointDigest(model.baseUrl)) return null;
		// The usage already covers the system prompt and tools it was sent with; with no record of their size then, none counts as growth.
		const statics = estimateAgentContextBreakdown({
			systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
			messages: [],
			tools: agentRuntime.agent.state.tools,
		});
		return {
			tokens: usage.tokens,
			covered: usage.index + 1,
			systemPromptTokens: statics.systemPromptTokens,
			toolSchemaTokens: statics.toolSchemaTokens,
		};
	};

	/**
	 * The route's tokens per chars/4 token (CTX-1), or 1 where it has no measurement. The provider-measured anchor
	 * `measuredAnchor` admits, live or a resumed reply's usage, sets it: its count over the chars/4 figure of the
	 * request it measured. A held ratio prices the context after a compaction or eviction dropped that anchor, on the
	 * same route only. A ratio outside 0.5 to 2 (8 to 2 characters a token) is a count of something chars/4 never
	 * saw, such as server-side state, not a tokenizer, and leaves chars/4 in place. Without `observed` (a replay
	 * estimate) only the held ratio applies.
	 */
	const routeTokenRatio = (agentRuntime: AgentRuntime, observed?: MessageListDigests): number => {
		const key = JSON.stringify([
			agentRuntime.targetId,
			agentRuntime.runtimeId,
			agentRuntime.wireModelId,
			anchorModelKey(agentRuntime),
		]);
		const anchor = observed ? measuredAnchor(agentRuntime, observed) : null;
		if (observed && anchor) {
			let estimate = anchor.systemPromptTokens + anchor.toolSchemaTokens;
			for (let index = 0; index < anchor.covered; index += 1) estimate += observed.messageTokens[index] ?? 0;
			const ratio = estimate > 0 ? anchor.tokens / estimate : 0;
			shared.routeCalibration = ratio >= 0.5 && ratio <= 2 ? { key, ratio } : null;
		}
		return shared.routeCalibration?.key === key ? shared.routeCalibration.ratio : 1;
	};

	/** The record's copy of what the carry leaves: the same figure, the anchor's system and tools, and its route. */
	const evictionAnchor = (
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	): EvictionAnchor | undefined => {
		const anchor = shared.reconciledAnchor;
		if (!anchor || historyTokens === null) return undefined;
		return {
			tokens: carriedTokens(historyTokens, tokensRemoved),
			sys: anchor.systemPromptTokens,
			tools: anchor.toolSchemaTokens,
			route: {
				targetId: agentRuntime.targetId,
				runtimeId: agentRuntime.runtimeId,
				wireModelId: agentRuntime.wireModelId,
				modelKey: anchorModelKey(agentRuntime),
			},
		};
	};

	const carryReconciledAnchorThroughProjection = (
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	): void => {
		if (!shared.reconciledAnchor || historyTokens === null) return;
		const history = shared.observeHistory(agentRuntime);
		shared.reconciledAnchor = {
			...shared.reconciledAnchor,
			tokens: carriedTokens(historyTokens, tokensRemoved),
			anchoredMessages: history.messages,
			// Re-anchoring on the projected list is the point of this carry, so its
			// content identity is retaken here. Keeping the old digest would fail
			// the next validation and discard the attestation this preserves.
			contentDigest: history.digest(),
			// The carry prices the unmeasured tail and the removed bodies at chars/4 (bt-47 D-A).
			measured: false,
		};
	};
	const methods: Required<Pick<TurnContext, "setCurrentSnapshot" | "flushReconciledSnapshot" | "reconcileUsage">> = {
		setCurrentSnapshot(snapshot: ContextSnapshot): void {
			shared.currentContextSnapshot = snapshot;
			shared.refreshLiveBudget(snapshot.pendingUserInput);
		},
		flushReconciledSnapshot(): void {
			if (shared.snapshotPersistPending && shared.currentContextSnapshot)
				shared.persistContextSnapshot(shared.currentContextSnapshot);
			// Run settlement. Its callers are `agent_end` and submit's finally, so
			// this is where the finished run's accounting is published, not the
			// mid-run tool-batch boundary; that one is `postToolContinuationGuard`.
			shared.refreshLiveBudget();
		},
		reconcileUsage(usage: Usage, call?: { callId: string; attemptId: string }): void {
			// Cached prompt tokens still occupy the window; providers report them
			// outside `input`, so the attested prompt is the three summed.
			const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			const runtime = shared.state.runtime;
			const history = runtime ? shared.observeHistory(runtime) : undefined;
			if (promptTokens > 0 && runtime && history) {
				const breakdown = estimateAgentContextBreakdown({ ...runtime.agent.state, messages: [] });
				// The output of this call is part of the next call's prompt for the
				// same messages, which is why it is folded in here.
				shared.reconciledAnchor = {
					tokens: promptTokens + (usage.output || 0),
					anchoredMessages: history.messages,
					contentDigest: history.digest(),
					runtime,
					model: runtime.agent.state.model,
					modelKey: anchorModelKey(runtime),
					targetId: runtime.targetId,
					runtimeId: runtime.runtimeId,
					wireModelId: runtime.wireModelId,
					systemPromptTokens: breakdown.systemPromptTokens,
					toolSchemaTokens: breakdown.toolSchemaTokens,
					measured: true,
				};
			}
			if (!shared.currentContextSnapshot) {
				// The anchor still moved, and it is what the next request budgets
				// against, so the view is republished with or without a snapshot.
				shared.refreshLiveBudget(undefined, history);
				return;
			}
			// Reconcile in memory on every API call so the live meters
			// track usage; persistence waits for the run to settle.
			if (runtime && history) {
				const messages = history.messages;
				// The just-completed response is output, not part of its own prompt.
				const promptMessages = messages.at(-1)?.role === "assistant" ? messages.slice(0, -1) : messages;
				shared.currentContextSnapshot = shared.captureRuntimeContextSnapshot(
					runtime,
					shared.currentContextSnapshot.turnId,
					shared.deps.getSettings().context.compaction?.threshold ?? null,
					{
						conversationMessages: promptMessages,
						promptSegments: shared.currentContextSnapshot.promptSegments,
						promptHash: shared.currentContextSnapshot.promptHash,
						toolSignature: shared.currentContextSnapshot.toolSignature,
					},
				);
			}
			shared.currentContextSnapshot = {
				...reconcileSnapshot(shared.currentContextSnapshot, usage),
				callId: call?.callId,
				attemptId: call?.attemptId,
			};
			shared.snapshotPersistPending = true;
			// A reconcile moves the anchor and therefore the figure the next
			// request budgets against, so it is a publication point of its own.
			shared.refreshLiveBudget(undefined, history);
		},
	};
	return {
		reconciledHistoryTokens,
		measuredAnchor,
		routeTokenRatio,
		evictionAnchor,
		carryReconciledAnchorThroughProjection,
		methods,
	};
}
