// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import {
	type BackendCompletionTimings,
	buildCacheCallObservation,
	type CacheCallTransport,
	type CacheRequestFingerprint,
	uncachedPrefillTokens,
} from "../../core/cache-telemetry.js";
import { sha256Hex } from "../../core/hash.js";
import { residencyTargetKey } from "../../core/residency-target-key.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import type {
	CompactionPayload,
	ContextRecalledPayload,
	MemoryStepCompletedPayload,
	ResidencyMutationPayload,
} from "../../core/telemetry/live-events.js";
import { asRecord } from "../../core/type-guards.js";
import { canonicalEndpointKey, modelEndpointKey } from "../../domains/providers/index.js";
import type { PrewarmStats } from "../../domains/session/context-ledger.js";
import { engineCodexConfiguration, engineInitialSystemPrompt } from "../../engine/agent.js";
import { cacheLifetimeSeconds } from "../../engine/cache-keepalive.js";
import type {
	AnthropicResponseObservation,
	CodexTransportObservation,
	ResponsesCacheDiagnostic,
	Usage,
} from "../../engine/types.js";
import { backendCacheVerdict, extractUserText, sumRunUsage } from "../chat-loop-messages.js";
import { coldCacheNoticeText } from "../cold-reasons.js";
import { extractTurnText } from "../session-replay-messages.js";
import type { ExpectedColdReason, TurnContext } from "../turn-context.js";
import { sha256Json, type TurnContextScope } from "../turn-context-scope.js";
import { TIER_INDEPENDENT_COLD_REASONS } from "./helpers.js";

export function createTurnContextCache(shared: TurnContextScope) {
	const loadCacheCallBaseline = (): void => {
		if (!shared.cacheCallBaselineLoaded) {
			shared.cacheCallBaselineLoaded = true;
			// #423: a fresh process resumes only the active branch's last persisted call.
			const entries = shared.activeEntries();
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (!entry) continue;
				if (entry.kind === "compactionSummary" || entry.kind === "contextEviction") break;
				if (entry.kind !== "message" || entry.role !== "assistant") continue;
				const payload = entry.payload as {
					promptCache?: {
						input?: number;
						cacheRead?: number;
						cacheWrite?: number;
						observation?: { requestFingerprint?: CacheRequestFingerprint; transport?: CacheCallTransport };
					};
				} | null;
				const prior = payload?.promptCache;
				const endedAt = Date.parse(entry.timestamp);
				if (typeof prior?.input === "number" && Number.isFinite(endedAt)) {
					const transportRequest = prior.observation?.transport?.request;
					shared.cacheCallBaseline = {
						inclusiveInputTokens: prior.input + (prior.cacheRead ?? 0) + (prior.cacheWrite ?? 0),
						endedAt,
						...(prior.observation?.requestFingerprint ? { requestFingerprint: prior.observation.requestFingerprint } : {}),
						...(transportRequest ? { transportRequest } : {}),
					};
				}
				break;
			}
		}
	};

	const resetCacheCallBaseline = (): void => {
		shared.cacheCallBaseline = null;
		// #423: a generation reset must not reload the pre-reduction ledger baseline.
		shared.cacheCallBaselineLoaded = true;
		shared.cacheGeneration += 1;
	};

	const stampsOnTier = (reason: ExpectedColdReason, runtimeId: string | undefined): boolean =>
		TIER_INDEPENDENT_COLD_REASONS.has(reason) ||
		(runtimeId !== undefined && shared.deps.providers.getRuntime(runtimeId)?.tier === "local-native");

	// An expected cold cache is telemetry about the next response: it goes to
	// the footer's notice slot, and the Detailed receipt names the reasons with
	// the reuse the provider actually reported.
	const noteExpectedCold = (reasons: ReadonlyArray<string>): void => {
		if (shared.deps.emitCacheNotice) shared.deps.emitCacheNotice(reasons);
		else shared.deps.emitNotice(coldCacheNoticeText(reasons));
	};

	const noteColdReason = (reason: ExpectedColdReason): void => {
		if (!shared.state.streaming) {
			shared.pendingColdReasons.add(reason);
			return;
		}
		if (!stampsOnTier(reason, shared.state.runtime?.runtimeId)) return;
		if (!shared.callColdReasons.includes(reason)) shared.callColdReasons.push(reason);
		if (!shared.runExpectedColdReasons.includes(reason)) shared.runExpectedColdReasons.push(reason);
		if (shared.nextAssistantColdReasons.includes(reason)) return;
		shared.nextAssistantColdReasons.push(reason);
		noteExpectedCold(shared.nextAssistantColdReasons);
	};

	const unsubscribeColdReasonSources = [
		...(["run.started", "run.completed", "run.failed"] as const).map(
			(channel) =>
				shared.deps.bus?.subscribe(channel, () => {
					noteColdReason("dispatch");
				}) ?? null,
		),
		...(["compaction.started", "compaction.ended"] as const).map(
			(channel) =>
				shared.deps.bus?.subscribe(channel, (payload: CompactionPayload) => {
					// A step checkpoint makes no provider call, so its own reason, on every tier, is true only once its entry
					// was appended: a checkpoint whose append failed left the context as it was.
					if (payload?.trigger !== "step") noteColdReason("compaction");
					else if (channel === "compaction.ended" && payload.outcome === "completed") noteColdReason("step_checkpoint");
				}) ?? null,
		),
		// A completed compaction rebuilds the context, so the next compile takes
		// the live memory section instead of the frozen one (#423).
		shared.deps.bus?.subscribe("compaction.ended", (payload: CompactionPayload) => {
			if (payload.outcome === "completed") {
				shared.frozenMemorySection = null;
				resetCacheCallBaseline();
				shared.frozenRouteSources = undefined;
			}
		}) ?? null,
		shared.deps.bus?.subscribe("residency.mutated", (payload: ResidencyMutationPayload) => {
			const runtime = shared.state.runtime;
			const model = runtime?.agent.state.model as { baseUrl?: unknown } | undefined;
			const baseUrl = typeof model?.baseUrl === "string" ? model.baseUrl : null;
			if (payload.targetKey !== residencyTargetKey(runtime?.runtimeId ?? "", baseUrl)) return;
			noteColdReason("residency");
		}) ?? null,
		// A memory step on another endpoint disturbs nothing here, so the stamp is
		// gated on the step having called the very server this session streams to.
		shared.deps.bus?.subscribe("memory.step_completed", (payload: MemoryStepCompletedPayload) => {
			const target = shared.state.runtime?.runtimeResolution.target;
			if (target === undefined) return;
			// Behind a model-routed gateway only a step on this session's own model shares its backend.
			const own = [canonicalEndpointKey(target), modelEndpointKey(target, shared.state.runtime?.wireModelId)];
			if (!own.includes(payload.endpointKey)) return;
			noteColdReason("background_memory");
		}) ?? null,
		shared.deps.bus?.subscribe("context.recalled", (payload: ContextRecalledPayload) => {
			shared.middleware.fireCompactionHook("working_set_recall", payload.trigger);
		}) ?? null,
	];
	const methods: Required<
		Pick<
			TurnContext,
			| "consumeExpectedColdReasons"
			| "takeCallColdReasons"
			| "cacheGeneration"
			| "noteCacheRequestToolChoice"
			| "noteCacheRequestSystemPrompt"
			| "promptCachePayloadForAssistant"
			| "notePrewarm"
			| "noteRunCacheSummary"
		>
	> = {
		consumeExpectedColdReasons(runtimeId: string): void {
			// Cache-disturbance honesty (T3.3): consume disturbances since
			// the last settled run. Only single-slot local backends lose their
			// prefix cache to interleaved work, so residency, dispatch, and
			// compaction stamp only on local-native targets. Prefix-byte and
			// reasoning changes stamp every tier (#423; see stampsOnTier).
			shared.runExpectedColdReasons = [];
			shared.nextAssistantColdReasons = [];
			if (shared.pendingColdReasons.size > 0) {
				const reasons = [...shared.pendingColdReasons].filter((reason) => stampsOnTier(reason, runtimeId));
				shared.pendingColdReasons.clear();
				if (reasons.length > 0) {
					shared.runExpectedColdReasons = reasons;
					shared.nextAssistantColdReasons = reasons;
					shared.callColdReasons = [...new Set([...shared.callColdReasons, ...reasons])];
					noteExpectedCold(reasons);
				}
			}
		},
		takeCallColdReasons(): ExpectedColdReason[] {
			const reasons = shared.callColdReasons;
			shared.callColdReasons = [];
			return reasons;
		},
		cacheGeneration: () => shared.cacheGeneration,
		noteCacheRequestToolChoice(toolChoice, afterRejection = false): void {
			shared.cacheRequestToolChoice = toolChoice;
			const route = JSON.stringify([shared.state.runtime?.targetId, shared.state.runtime?.wireModelId]);
			const previous = afterRejection ? shared.priorSentToolChoice : shared.sentToolChoice;
			if (previous?.route === route && previous.toolChoice !== toolChoice) noteColdReason("tool_choice_change");
			if (!afterRejection) shared.priorSentToolChoice = shared.sentToolChoice;
			shared.sentToolChoice = { route, toolChoice };
		},
		noteCacheRequestSystemPrompt(afterRejection = false): void {
			const runtime = shared.state.runtime;
			if (!runtime) return;
			const hash = sha256Hex(engineInitialSystemPrompt(runtime.agent));
			shared.cacheRequestSystemPromptHash = hash;
			const route = JSON.stringify([runtime.targetId, runtime.wireModelId]);
			loadCacheCallBaseline();
			const recorded = shared.cacheCallBaseline?.requestFingerprint;
			const previous = afterRejection
				? shared.priorSentSystemPrompt
				: (shared.sentSystemPrompt ??
					(recorded?.systemPromptHash === undefined
						? undefined
						: { route: JSON.stringify([recorded.targetId, recorded.modelId]), hash: recorded.systemPromptHash }));
			// A recompile already names this change; the reason catches a prefix that moved without one.
			if (previous?.route === route && previous.hash !== hash && !shared.callColdReasons.includes("prompt_recompiled")) {
				noteColdReason("system_prompt_changed");
			}
			if (!afterRejection) shared.priorSentSystemPrompt = shared.sentSystemPrompt;
			shared.sentSystemPrompt = { route, hash };
		},
		promptCachePayloadForAssistant(
			usage: Usage,
			backend?: BackendCompletionTimings,
			anthropicResponse?: AnthropicResponseObservation,
			transport?: CodexTransportObservation,
			responsesDiagnostic?: ResponsesCacheDiagnostic,
		): Record<string, unknown> {
			// Per-call prompt-cache record (T3.2) keeps normalized provider usage
			// beside any timings captured from the server response. The run's first
			// persisted call also carries any expected-cold reasons.
			const input = typeof usage.input === "number" ? usage.input : 0;
			const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
			const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
			loadCacheCallBaseline();
			// #423: fingerprint only truncations verified against their durable operator text.
			// A later fresh connection with the same replayed bytes is not another rewrite.
			const truncated: string[] = [];
			for (const message of shared.state.runtime?.agent.state.messages ?? []) {
				if (message.role !== "user") continue;
				const text = extractUserText(message);
				const marker = /\n\n\[\.\.\. (\d+) more characters truncated from replay context\]$/.exec(text);
				if (!marker) continue;
				const prefix = text.slice(0, marker.index);
				const original = (shared.deps.readSessionEntries?.() ?? []).find(
					(entry) => entry.kind === "message" && entry.role === "user" && Date.parse(entry.timestamp) === message.timestamp,
				);
				if (original?.kind !== "message") continue;
				const source = extractTurnText(original.payload);
				if (source.startsWith(prefix) && source.length === prefix.length + Number(marker[1])) truncated.push(text);
			}
			const replayTruncationHash = truncated.length > 0 ? sha256Json(truncated) : undefined;
			const now = Date.now();
			// #423: on Codex the wire effort is the generation's initial effort for every call; a /thinking change
			// travels as a configuration_update item and keeps the cache (measured 2026-10-30), so it is no break cause.
			const wireEffort = shared.state.runtime
				? engineCodexConfiguration(shared.state.runtime.agent)?.initialEffort
				: undefined;
			// #423: the lifetime the keepalive would have refreshed against is the one idle is judged by.
			const model = shared.state.runtime?.agent.state.model;
			const lifetimeSeconds = model ? cacheLifetimeSeconds(model, undefined) : undefined;
			// A server that omits cache reads from its usage but reports cache_n in its timings is judged by those
			// timings, as the journal judges it, so doctor and /usage count the same breaks (#434).
			const evaluated = usage.cacheReadField === "omitted" ? uncachedPrefillTokens(backend) : null;
			const observation = buildCacheCallObservation(
				evaluated !== null && backend
					? { input: evaluated, cacheRead: backend.promptTokens - evaluated, cacheWrite: 0 }
					: { input, cacheRead: usage.cacheReadField === "omitted" ? null : cacheRead, cacheWrite },
				shared.cacheCallBaseline,
				shared.nextAssistantColdReasons,
				now,
				shared.state.runtime
					? {
							targetId: shared.state.runtime.targetId,
							modelId: shared.state.runtime.wireModelId,
							thinkingLevel: wireEffort ?? shared.state.runtime.runtimeResolution.effectiveThinkingLevel,
							toolChoice: shared.cacheRequestToolChoice,
							...(replayTruncationHash === undefined ? {} : { replayTruncationHash }),
							...(shared.cacheRequestSystemPromptHash === undefined
								? {}
								: { systemPromptHash: shared.cacheRequestSystemPromptHash }),
						}
					: undefined,
				{
					ttlMs: lifetimeSeconds === undefined ? null : lifetimeSeconds * 1000,
					...(transport
						? {
								transport: {
									mode: transport.mode,
									request: transport.request,
									...(transport.reason ? { reason: transport.reason } : {}),
									...(transport.recovery ? { recovery: true } : {}),
								},
							}
						: {}),
				},
			);
			// #423: named provider misses outrank host attribution; pending diagnostics preserve no-break.
			const messageStart = anthropicResponse?.messageStart;
			const miss = asRecord(asRecord(messageStart?.diagnostics)?.cache_miss_reason ?? messageStart?.cache_miss_reason);
			if (typeof miss?.type === "string") {
				observation.providerDiagnostic = {
					provider: "anthropic",
					type: miss.type,
					...(typeof miss.cache_missed_input_tokens === "number"
						? { missedInputTokens: miss.cache_missed_input_tokens }
						: {}),
				};
				const causes = {
					model_changed: "model_changed",
					system_changed: "prompt_recompiled",
					tools_changed: "tools_changed",
					messages_changed: "input_changed",
				} as const;
				if (Object.hasOwn(causes, miss.type)) {
					observation.cause = causes[miss.type as keyof typeof causes];
					observation.causeBasis = "provider";
				}
			} else if (Array.isArray(messageStart?.input_transformations) && messageStart.input_transformations.length > 0) {
				const types = messageStart.input_transformations.flatMap((value) => {
					const transformation = asRecord(value);
					return typeof transformation?.type === "string" ? [transformation.type] : [];
				});
				observation.providerDiagnostic = { provider: "anthropic", type: `input_transformations:${types.join(",")}` };
			} else if (responsesDiagnostic !== undefined) {
				// PV-2: the public Responses verdict against the previous response; only a named miss is a cause.
				observation.providerDiagnostic = {
					provider: responsesDiagnostic.provider,
					type: responsesDiagnostic.reason ?? responsesDiagnostic.type,
					...(responsesDiagnostic.missedInputTokens === undefined
						? {}
						: { missedInputTokens: responsesDiagnostic.missedInputTokens }),
				};
				const causes = {
					model_changed: "model_changed",
					tools_changed: "tools_changed",
					input_changed: "input_changed",
					reasoning_effort_changed: "reasoning_changed",
					context_compacted: "compaction",
				} as const;
				const reason = responsesDiagnostic.type === "cache_miss" ? responsesDiagnostic.reason : undefined;
				if (reason !== undefined && Object.hasOwn(causes, reason)) {
					observation.cause = causes[reason as keyof typeof causes];
					observation.causeBasis = "provider";
				}
			}
			if (observation.cause === "prompt_recompiled" && shared.nextChangedSection !== undefined) {
				observation.changedSection = shared.nextChangedSection;
			}
			shared.nextChangedSection = undefined;
			shared.cacheCallBaseline = {
				inclusiveInputTokens: observation.inclusiveInputTokens,
				endedAt: now,
				...(observation.requestFingerprint ? { requestFingerprint: observation.requestFingerprint } : {}),
				...(observation.transport ? { transportRequest: observation.transport.request } : {}),
			};
			const promptCache: Record<string, unknown> = {
				input,
				cacheRead,
				cacheWrite,
				backendVerdict: backendCacheVerdict(input, cacheRead, cacheWrite, backend, usage.cacheReadField),
				observation,
			};
			if (backend !== undefined) promptCache.backend = { ...backend };
			if (shared.nextAssistantColdReasons.length > 0) {
				promptCache.expectedColdReasons = [...shared.nextAssistantColdReasons];
				shared.nextAssistantColdReasons = [];
			}
			return promptCache;
		},
		notePrewarm(prewarm: PrewarmStats): void {
			shared.lastPrewarm = prewarm;
		},
		noteRunCacheSummary(messages, runFirstCallVerdict): void {
			// The settled run is the answer to the pre-warm's question, so the
			// pre-warm line stops being the newest fact about the prefix here.
			shared.lastPrewarm = null;
			const cacheSummary = sumRunUsage(messages);
			if (cacheSummary.hadUsage) {
				let lastBackend: BackendCompletionTimings | null = null;
				for (let index = messages.length - 1; index >= 0; index -= 1) {
					const message = messages[index];
					if (message?.role !== "assistant") continue;
					lastBackend = (message as { backendTimings?: BackendCompletionTimings }).backendTimings ?? null;
					break;
				}
				const cacheRead = factKnownValue(cacheSummary.totals.usage.cacheRead);
				const cacheWrite = factKnownValue(cacheSummary.totals.usage.cacheWrite);
				const cacheReported = cacheRead > 0 || cacheWrite > 0;
				shared.lastPromptCache = {
					shellReused: shared.lastSystemPromptReused,
					cacheReadTokens: cacheReported ? cacheRead : null,
					cacheWriteTokens: cacheReported ? cacheWrite : null,
					uncachedInputTokens: factKnownValue(cacheSummary.totals.usage.input),
					backend: lastBackend,
					uncachedPrefillTokens: uncachedPrefillTokens(lastBackend),
					backendVerdict: runFirstCallVerdict,
					...(shared.runExpectedColdReasons.length > 0 ? { expectedColdReasons: [...shared.runExpectedColdReasons] } : {}),
				};
			}
		},
	};
	return {
		loadCacheCallBaseline,
		resetCacheCallBaseline,
		noteColdReason,
		unsubscribeColdReasonSources,
		methods,
	};
}
