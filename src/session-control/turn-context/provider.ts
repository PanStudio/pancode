// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { providerCheckpointFromMessage, providerFallbackDigests } from "../../core/provider-checkpoint-handle.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import { requestFits } from "../../domains/context/budget/request-fit.js";
import { supersededStageApplies } from "../../domains/context/fold/contract.js";
import { type SessionEntry, withProviderCheckpointMeasurements } from "../../domains/session/entries.js";
import { readPromptCompileRecords } from "../../domains/session/prompt-manifest.js";
import { findLastEntry } from "../../domains/session/tree/active-path.js";
import {
	engineCodexUserTurn,
	setEngineCodexConfiguration,
	setEngineCodexUserTurn,
	setEngineProviderCheckpointObserver,
	setEngineProviderCompactionPolicy,
	setEngineProviderReplayFallback,
} from "../../engine/agent.js";
import type { CodexConfiguration } from "../../engine/types.js";
import { extractUserText } from "../chat-loop-messages.js";
import { codexEffortGeneration, codexEffortUpdates } from "../codex-effort.js";
import { type MessageListDigests, withSettledHistory } from "../message-list-digest.js";
import { resolveFitOutputReserve, turnAdmissionRemedy } from "../output-reserve.js";
import { extractTurnText } from "../session-replay-messages.js";
import type { TurnContext } from "../turn-context.js";
import type { TurnContextScope } from "../turn-context-scope.js";
import type { AgentRuntime } from "../turn-state.js";
import { continuationContextUpdate, oversizedResultStop, toolResultTail } from "./helpers.js";

export function createTurnContextProvider(shared: TurnContextScope) {
	const bindProviderCompaction = (runtime: AgentRuntime): void => {
		setEngineProviderCompactionPolicy(
			runtime.agent,
			() => shared.deps.getSettings().context.compaction.provider === "native" && runtime.runtimeId === "openai-codex",
		);
		const origin = shared.deps.session?.current()?.id;
		setEngineProviderReplayFallback(runtime.agent, async (reason) => {
			if (origin !== shared.deps.session?.current()?.id) throw new DOMException("Replay ownership changed", "AbortError");
			await resolveProviderReplay(runtime, reason);
		});
		setEngineProviderCheckpointObserver(runtime.agent, (handle, inputTokens) => {
			if (origin !== shared.deps.session?.current()?.id) return;
			const entries = withProviderCheckpointMeasurements(shared.activeEntries());
			const checkpoint = entries.find(
				(entry) => entry.kind === "compactionSummary" && entry.providerCheckpoint?.digest === handle.digest,
			);
			if (checkpoint?.kind !== "compactionSummary" || checkpoint.providerCheckpoint?.replayInputTokens !== undefined)
				return;
			// The full inclusive request is a measured upper bound; it never underprices opaque input (#423).
			shared.deps.session?.appendEntry({
				kind: "custom",
				parentTurnId: shared.state.lastTurnId,
				customType: "pancode_provider_checkpoint_input",
				data: { version: 1, checkpointDigest: handle.digest, inputTokens, measurement: "inclusive-request-upper-bound" },
			});
			shared.deps.session?.flushAppends?.();
			runtime.agent.state.messages = runtime.agent.state.messages.map((message) => {
				const marker = providerCheckpointFromMessage(message);
				return marker?.digest === handle.digest
					? { ...message, pancodeProviderCheckpoint: { ...marker, replayInputTokens: inputTokens } }
					: message;
			});
		});
	};

	// Ledger boundaries, rather than request retries, own Codex effort changes (#423).
	const syncCodexConfiguration = (runtime: AgentRuntime): void => {
		bindProviderCompaction(runtime);
		const model = runtime.agent.state.model;
		shared.thinkingUsesConfigurationUpdate = false;
		if (model?.api !== "openai-codex-responses") {
			setEngineCodexConfiguration(runtime.agent, undefined);
			return;
		}
		const effortFor = (level: string): string => {
			const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
			return map?.[level] ?? (level === "off" ? "none" : level);
		};
		const currentEffort = effortFor(runtime.runtimeResolution.effectiveThinkingLevel);
		const entries = shared.activeEntries();
		const generation = codexEffortGeneration(entries);
		const start = entries.length - generation.length;
		const baseline = generation.find((entry) => entry.kind === "thinkingLevelChange" && entry.configurationInitial);
		let initialEffort = baseline?.kind === "thinkingLevelChange" ? baseline.effectiveEffort : undefined;
		if (initialEffort === undefined) {
			const meta = shared.deps.session?.current();
			const firstCompile = start === 0 && meta ? readPromptCompileRecords(meta)[0] : undefined;
			initialEffort = firstCompile?.thinkingLevel ? effortFor(firstCompile.thinkingLevel) : currentEffort;
			if (meta) {
				shared.deps.session?.appendEntry({
					kind: "thinkingLevelChange",
					parentTurnId: shared.state.lastTurnId,
					thinkingLevel: runtime.runtimeResolution.effectiveThinkingLevel,
					effectiveEffort: initialEffort,
					configurationInitial: true,
				});
			}
		}
		const available = new Set<string>();
		const usersByTime = new Map<number, Array<SessionEntry>>();
		for (const entry of entries) {
			if (entry.kind !== "message" || entry.role !== "user") continue;
			const time = Date.parse(entry.timestamp);
			const group = usersByTime.get(time) ?? [];
			group.push(entry);
			usersByTime.set(time, group);
		}
		// Resume/refresh already built these messages; never construct another replay (#423).
		for (const message of runtime.agent.state.messages) {
			if (message.role !== "user") continue;
			const bound = engineCodexUserTurn(message);
			if (bound) {
				available.add(bound);
				continue;
			}
			const text = extractUserText(message);
			const entry = usersByTime.get(message.timestamp)?.find((candidate) => {
				if (candidate.kind !== "message" || available.has(candidate.turnId)) return false;
				const original = extractTurnText(candidate.payload);
				return text === original;
			});
			if (entry) {
				setEngineCodexUserTurn(message, entry.turnId);
				available.add(entry.turnId);
			}
		}
		// The admitted user is appended to Pi after commitMemoryTurn; message_end binds it (#423).
		if (shared.state.activeUserTurnId) available.add(shared.state.activeUserTurnId);
		const updates = codexEffortUpdates(
			generation,
			initialEffort,
			available,
			(entry) => entry.effectiveEffort ?? effortFor(entry.thinkingLevel),
		);
		const configuration: CodexConfiguration = { initialEffort, updates };
		setEngineCodexConfiguration(runtime.agent, configuration);
		shared.thinkingUsesConfigurationUpdate = updates.at(-1)?.position === shared.state.activeUserTurnId;
	};

	const resolveProviderReplay = async (
		runtime: AgentRuntime,
		reason: string,
		pendingUserText?: string,
		pendingIsOperator = true,
	): Promise<void> => {
		const origin = shared.deps.session?.current()?.id;
		const navigation = shared.navigationEpoch;
		const signal = shared.deps.turnSignal?.();
		const active = shared.activeEntries();
		const checkpoint = findLastEntry(active, (entry) => entry.kind === "compactionSummary");
		if (checkpoint?.kind !== "compactionSummary" || !checkpoint.providerCheckpoint) {
			shared.refreshAgentMessagesFromSession(runtime);
			return;
		}
		if (!providerFallbackDigests(active).has(checkpoint.providerCheckpoint.digest)) {
			let changed = false;
			let resolutionReason = reason;
			try {
				changed = await shared.runAutoCompact(
					runtime,
					true,
					undefined,
					"force",
					pendingUserText,
					undefined,
					signal,
					undefined,
					pendingIsOperator,
					reason,
				);
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				resolutionReason = `${reason}:portable-summary-failed`;
				shared.deps.emitNotice("Portable compaction failed; continuing from the original session history.");
			}
			if (signal?.aborted || origin !== shared.deps.session?.current()?.id || navigation !== shared.navigationEpoch)
				throw new DOMException("Replay ownership changed", "AbortError");
			if (!changed) {
				shared.deps.session?.appendEntry({
					kind: "custom",
					parentTurnId: shared.state.lastTurnId,
					customType: "pancode_provider_fallback",
					data: {
						version: 1,
						checkpointDigest: checkpoint.providerCheckpoint.digest,
						providerFallbackReason: resolutionReason,
					},
				});
				shared.deps.session?.flushAppends?.();
			}
		}
		shared.refreshAgentMessagesFromSession(runtime);
	};
	const methods: Required<Pick<TurnContext, "postToolContinuationGuard">> = {
		async postToolContinuationGuard(
			agentRuntime: AgentRuntime,
			signal?: AbortSignal,
			contextChanged = false,
			settledTail?: () => void,
		) {
			if (signal?.aborted || (!contextChanged && !toolResultTail(agentRuntime))) {
				settledTail?.();
				return undefined;
			}
			// A host tail appended before this guard is a durable insert: a compaction
			// that rebuilds the messages re-issues it after the checkpoint when the
			// cut took its anchor, so the rebuild itself carries it.
			// The tool batch appended results the last publication predates, and the
			// guard is about to decide on them. Publish before that inspection, not
			// after it, from the same history observation and estimate it decides on.
			let history: MessageListDigests | undefined;
			let knownWindow = false;
			let mustFit = false;
			let compacted = false;
			// Eviction rebuilds the messages before the summary call, so a failed summary can still leave them changed.
			const messagesBefore = agentRuntime.agent.state.messages;
			// Until a compaction attempt yields, nothing touches the messages, so the checks read `history` instead of
			// walking every message again; a check after an attempt starts observes afresh (SC-6).
			let attemptStarted = false;
			const settled = (): MessageListDigests | undefined => (attemptStarted ? undefined : history);
			// The A4 count (overflowFitTokens) decides whether the request fits; the fit line's reserve is A5's, read at that count.
			const a4Fits = (view: LiveBudgetView): boolean => {
				const input = shared.overflowFitTokens(agentRuntime, undefined, view.inputTokens ?? 0, settled());
				const reserve = view.outputReserveTokens === null ? null : resolveFitOutputReserve(agentRuntime, input);
				return requestFits(input, reserve, view.effectiveWindow);
			};
			// The view's figures, or with a measured anchor the anchored count admission sends on (bt3 drv-rv5).
			const fitFigures = (view: LiveBudgetView): { input: number | null; reserve: number | null } => {
				const anchored = shared.anchoredInputTokens(agentRuntime, settled());
				if (anchored === null) return { input: view.inputTokens, reserve: view.outputReserveTokens };
				const reserve = view.outputReserveTokens === null ? null : resolveFitOutputReserve(agentRuntime, anchored);
				return { input: anchored, reserve };
			};
			const viewFits = (view: LiveBudgetView): boolean => {
				const { input, reserve } = fitFigures(view);
				return requestFits(input, reserve, view.effectiveWindow);
			};
			const compact = async (requireFit: boolean): Promise<void> => {
				attemptStarted = true;
				try {
					const done = await shared.runAutoCompact(
						agentRuntime,
						requireFit,
						undefined,
						requireFit ? "overflow" : "auto",
						undefined,
						undefined,
						signal,
					);
					compacted = compacted || done;
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					const aborted = signal?.aborted || (err instanceof Error && err.name === "AbortError");
					const oversize = requireFit && !aborted ? shared.overflowStop(agentRuntime) : null;
					// One tool result is what overflows: finish() bounds it, or stops naming it when no cut fits.
					if (oversize !== null) return;
					if (requireFit || aborted) {
						const stop = `[PanCode] post-tool context guard could not compact before continuation: ${reason}`;
						// The request needs a fit it cannot get: the harness's stop, not the route's (FX-22c). A cancel stays a plain error.
						throw aborted ? new Error(stop) : oversizedResultStop(stop);
					}
					// Optional compaction: the request still fits, so the run goes on and the fit check below stays the stop.
					shared.deps.emitNotice(
						`[PanCode] automatic compaction failed: ${reason.replace(/[.\s]+$/u, "")}. This turn goes on without it.`,
					);
				}
			};
			// The mid-run settled tool-batch boundary: whatever the guard did or
			// declined to do, this is the context the continuation will send. The
			// caller's settled tail (the memory install) runs last, in the same
			// stretch as this view's publication, so it reads that walk (SC-6).
			const finish = (afterView: LiveBudgetView): ReturnType<typeof continuationContextUpdate> | undefined => {
				let view = afterView;
				// Compaction is spent and the latest batch is what overflows: bound it rather than end the turn, on every surface.
				const overflowing = (mustFit && shared.overflowStop(agentRuntime) !== null) || (knownWindow && !viewFits(view));
				const bound = overflowing ? shared.boundBatchToFit(agentRuntime) : null;
				if (bound?.kind === "short") throw oversizedResultStop(bound.stop);
				if (bound?.kind === "fit") {
					attemptStarted = true;
					view = shared.refreshLiveBudget();
				}
				const oversize = mustFit ? shared.overflowStop(agentRuntime) : null;
				if (oversize !== null) throw oversizedResultStop(oversize);
				const after = fitFigures(view);
				if (knownWindow && !requestFits(after.input, after.reserve, view.effectiveWindow)) {
					// The guard's own stop, like the oversized-result one: the harness cause, not a route failure (CLI-3).
					// Compaction already ran, so the remedy names what it cannot shrink, in terms every surface accepts.
					throw oversizedResultStop(
						`[PanCode] post-tool context guard stopped continuation before provider call: estimated input ${after.input} plus reserved output ${after.reserve} tokens does not fit context window ${view.effectiveWindow}. ${turnAdmissionRemedy(agentRuntime, after.input ?? 0)} Ask for narrower reads or smaller tool output in a follow-up turn.`,
					);
				}
				const update =
					compacted || agentRuntime.agent.state.messages !== messagesBefore
						? continuationContextUpdate(agentRuntime)
						: undefined;
				settledTail?.();
				return update;
			};
			// One settled stretch from the first observation to the decision; without an attempt the guard never yields or
			// touches the messages, so the first publication already describes the context and the tail runs in it too.
			const decision = withSettledHistory(() => {
				history = shared.observeHistory(agentRuntime);
				const before = shared.liveContextEstimate(agentRuntime, undefined, undefined, history);
				const beforeView =
					agentRuntime === shared.state.runtime
						? shared.refreshLiveBudget(undefined, history, before)
						: shared.refreshLiveBudget();
				knownWindow = before.contextWindow > 0;
				const verdict = shared.routeCompaction(agentRuntime, shared.deps.getSettings()).shouldCompact(before.tokens);
				// An automatic pass the trigger asks for runs first (A5); the A4 count then decides the overflow pass.
				mustFit = knownWindow && (!viewFits(beforeView) || (!verdict.shouldCompact && !a4Fits(beforeView)));
				// S0 commits under the trigger on an uncached route, so the guard asks there too (SPEC §3.4).
				const attempted = mustFit || verdict.shouldCompact || supersededStageApplies(agentRuntime.runtimeResolution);
				return attempted ? { attempted: true as const } : { attempted: false as const, update: finish(beforeView) };
			});
			if (!decision.attempted) return decision.update;
			await compact(mustFit);
			if (!mustFit && knownWindow && !a4Fits(shared.refreshLiveBudget())) {
				mustFit = true;
				await compact(true);
			}
			return withSettledHistory(() => finish(shared.refreshLiveBudget()));
		},
	};
	return {
		bindProviderCompaction,
		syncCodexConfiguration,
		resolveProviderReplay,
		methods,
	};
}
