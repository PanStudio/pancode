// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ThinkingLevel } from "../core/defaults.js";
import type { SideCallAuth } from "../core/oauth-retry.js";
import { pricingBasisFields } from "../core/telemetry/pricing.js";
import type { EffectivePricing } from "../domains/providers/catalog.js";
import { resolveEffectivePricing } from "../domains/providers/catalog.js";
import {
	modelEndpointKey,
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
} from "../domains/providers/index.js";
import { resolveSideCallAuth } from "../domains/providers/side-call-auth.js";
import type { AgentMessage, EngineModel } from "../engine/types.js";
import type { ChatLoopScope } from "./chat-loop-scope.js";
import { LOCAL_SIDE_QUESTION_API_KEY } from "./chat-loop-state-machine.js";
import { runOutOfTurnRound, type SideQuestionResult } from "./side-question.js";
import {
	parseTriageAnswer,
	runTriageRound,
	TRIAGE_RESPONSE_SCHEMA,
	TRIAGE_SCHEMA_NAME,
	TRIAGE_SYSTEM_PROMPT,
	type TriageEntry,
	type TriageVerdict,
	triageFloor,
	triageKindFor,
	triageLabelsFor,
	triageMaxTokens,
	triageMayInterrupt,
	triageSnapshotMatches,
	triageUserText,
} from "./steering-triage.js";
import type { QueuedChatMessage } from "./turn-queues.js";
import type { AgentRuntime, ChatLoopSteeringState } from "./turn-state.js";

/** The latest assistant text in a transcript, or empty: what a mid-run steer is reacting to. */
export function lastAssistantText(messages: ReadonlyArray<AgentMessage>): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((block): block is { type: "text"; text: string } => {
				const candidate = block as { type?: unknown; text?: unknown };
				return candidate?.type === "text" && typeof candidate.text === "string";
			})
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

/** The chat loop's steering triage over the queued entries. */
export function createChatLoopSteering(loop: ChatLoopScope, state: ChatLoopSteeringState) {
	const {
		deps,
		emitNotice,
		interruptRefusalReason,
		outcomeCollector,
		queues,
		sideCallAdmission,
		sideCallJournal,
		withEndpointKeySlot,
	} = loop;

	// --- steering triage ----------------------------------------------------
	//
	// Off by default (chat.steering.triage). Once the queue has settled for a
	// moment with enough entries, one detached round reads it, typed picks from a
	// bound route or else the side model, and relabels entries: an unrelated task moves to the end of the turn, a
	// confident stop may interrupt the run when the operator allowed it. The
	// round never holds the engine; a verdict that lands after the queue changed
	// is dropped, and the operator's own toggles pin an entry against it.
	const TRIAGE_DEBOUNCE_MS = 1200;
	let triageTimer: ReturnType<typeof setTimeout> | null = null;
	let triageInFlight = false;

	const cancelTriage = (): void => {
		if (triageTimer !== null) clearTimeout(triageTimer);
		triageTimer = null;
	};

	const scheduleTriage = (): void => {
		const triage = deps.getSettings().chat.steering.triage;
		if (!triage.enabled || queues.entries().length < triageFloor(triage, deps.systemOne)) return;
		cancelTriage();
		triageTimer = setTimeout(() => {
			triageTimer = null;
			void runTriage();
		}, TRIAGE_DEBOUNCE_MS);
		triageTimer.unref?.();
	};

	/** Every surface that queues a steer or follow-up (TUI, headless steer channel, ACP) starts the same round. */
	const queuedForTriage = (entry: QueuedChatMessage | null): boolean => {
		if (entry === null) return false;
		scheduleTriage();
		return true;
	};

	type TriageModel = Omit<SideCallAuth, "apiKey"> & {
		model: EngineModel;
		target: AgentRuntime["runtimeResolution"]["target"];
		targetId: string;
		runtimeId: string;
		wireModelId: string;
		pricedBy: AgentRuntime["runtimeResolution"]["pricedBy"];
		freeRule?: AgentRuntime["runtimeResolution"]["freeRule"];
		rates: EffectivePricing["rates"];
		apiKey: string | undefined;
		thinkingLevel: ThinkingLevel;
	};

	/**
	 * The level the triage round asks for, resolved through the route the way the chat route's level does, so a model
	 * without that level, off included, gets its nearest supported one. A route that no longer resolves keeps the
	 * round at off.
	 */
	const triageThinkingLevel = (
		level: ThinkingLevel,
		targetId: string,
		wireModelId: string,
		model: EngineModel,
	): ThinkingLevel => {
		const resolved = resolveRuntimeTarget(deps.providers, {
			targetId,
			wireModelId,
			requestedThinkingLevel: level,
			requireTools: false,
			requireStreaming: false,
			requireOutputBudget: false,
		});
		if (!resolved.ok) return "off";
		return refineRuntimeTargetWithModelHints(resolved.target, model, deps.providers.knowledgeBase).effectiveThinkingLevel;
	};

	/** The configured triage target, or the session's active runtime when none is named. */
	const resolveTriageModel = async (signal: AbortSignal): Promise<TriageModel | null> => {
		const triage = deps.getSettings().chat.steering.triage;
		const runtime = state.runtime;
		if (!runtime) return null;
		if (!triage.connection) {
			const resolution = runtime.runtimeResolution;
			const sideAuth = await resolveSideCallAuth(
				deps.providers.auth,
				resolution.target,
				resolution.runtime,
				LOCAL_SIDE_QUESTION_API_KEY,
				signal,
			);
			return {
				model: runtime.agent.state.model,
				target: resolution.target,
				targetId: runtime.targetId,
				runtimeId: resolution.runtime.id,
				wireModelId: runtime.wireModelId,
				...pricingBasisFields(resolution),
				rates: resolveEffectivePricing(resolution.target, resolution.runtime, resolution.wireModelId).rates,
				apiKey: sideAuth.apiKey,
				...sideAuth,
				thinkingLevel: triageThinkingLevel(
					triage.thinkingLevel,
					runtime.targetId,
					runtime.wireModelId,
					runtime.agent.state.model,
				),
			};
		}
		const resolved = resolveRuntimeTarget(deps.providers, {
			targetId: triage.connection,
			wireModelId: triage.model,
			requestedThinkingLevel: "off",
			requireTools: false,
			requireStreaming: false,
			requireOutputBudget: false,
		});
		if (!resolved.ok) return null;
		const route = resolved.target;
		const kbHit = deps.providers.knowledgeBase?.lookup(route.wireModelId, route.runtime.id) ?? null;
		const model = route.runtime.synthesizeModel(route.target, route.wireModelId, kbHit);
		const sideAuth = await resolveSideCallAuth(
			deps.providers.auth,
			route.target,
			route.runtime,
			LOCAL_SIDE_QUESTION_API_KEY,
			signal,
		);
		return {
			model,
			target: route.target,
			targetId: route.targetId,
			runtimeId: route.runtimeId,
			wireModelId: route.wireModelId,
			...pricingBasisFields(route),
			rates: resolveEffectivePricing(route.target, route.runtime, route.wireModelId).rates,
			apiKey: sideAuth.apiKey,
			...sideAuth,
			thinkingLevel: triageThinkingLevel(triage.thinkingLevel, route.targetId, route.wireModelId, model),
		};
	};

	const runTriage = async (): Promise<void> => {
		if (triageInFlight || !state.streaming || !state.runtime) return;
		const triage = deps.getSettings().chat.steering.triage;
		const asked: TriageEntry[] = queues.entries().map((entry) => ({ id: entry.id, text: entry.text, kind: entry.kind }));
		if (asked.length < triageFloor(triage, deps.systemOne)) return;
		triageInFlight = true;
		const sessionId = deps.session?.current()?.id;
		try {
			await runTriageRound({
				triage,
				systemOne: deps.systemOne,
				asked,
				task: () => deps.currentOperatorTask?.() ?? "",
				previous: () => (state.runtime ? lastAssistantText(state.runtime.agent.state.messages) : ""),
				current: () => state.streaming && triageSnapshotMatches(asked, queues.entries()),
				apply: (verdicts) =>
					outcomeCollector.settleTriage(sessionId, verdicts, applyTriage(verdicts, triage.autoInterrupt)),
				expired: (verdicts) => outcomeCollector.settleTriage(sessionId, verdicts, null),
				side: () => runSideTriage(asked),
			});
		} catch {
			// A failed round leaves the queue exactly as the operator left it.
		} finally {
			triageInFlight = false;
		}
	};

	/** The side-model round. It has its own deadline, so an ask that spent its bound before falling back does not end it. */
	const runSideTriage = async (asked: ReadonlyArray<TriageEntry>): Promise<void> => {
		if (!state.runtime) return;
		const triage = deps.getSettings().chat.steering.triage;
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(), triage.timeoutMs);
		deadline.unref?.();
		try {
			const resolved = await resolveTriageModel(controller.signal);
			if (resolved === null) return;
			const destination = {
				targetId: resolved.targetId,
				runtimeId: resolved.runtimeId,
				wireModelId: resolved.wireModelId,
			};
			// The queued texts carry whatever the operator inlined into them, so the
			// round is admitted under the session's flow restrictions like any side round.
			if ((deps.admitFlow?.(destination) ?? null) !== null) return;
			const origin = deps.session?.current() ?? null;
			// Each attempt passes the session cost ceiling as `/btw` does, and is refused there rather than parked: an
			// automatic round never waits on the operator, and a refused one leaves the queue as they left it.
			const result: SideQuestionResult = await withEndpointKeySlot(
				modelEndpointKey(resolved.target, resolved.wireModelId),
				(slot) =>
					runOutOfTurnRound({
						...sideCallJournal(resolved, "helper", origin),
						purpose: "triage",
						beforeRequest: sideCallAdmission(origin, slot, controller.signal, false),
						admitFlow: () => deps.admitFlow?.(destination) ?? null,
						model: resolved.model,
						messages: [],
						systemPrompt: TRIAGE_SYSTEM_PROMPT,
						userText: triageUserText({
							task: deps.currentOperatorTask?.() ?? "",
							previous: state.runtime ? lastAssistantText(state.runtime.agent.state.messages) : "",
							entries: asked,
						}),
						maxTokens: triageMaxTokens(resolved.thinkingLevel),
						// A schema-bound classification; reasoning only spends the output budget, so
						// `chat.steering.triage.thinkingLevel` defaults to off, and a raised level gets its own room.
						thinkingLevel: resolved.thinkingLevel,
						responseSchema: { name: TRIAGE_SCHEMA_NAME, schema: TRIAGE_RESPONSE_SCHEMA },
						runtimeId: resolved.runtimeId,
						signal: controller.signal,
						...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
						...(resolved.refreshApiKey ? { refreshApiKey: resolved.refreshApiKey } : {}),
					}),
			);
			if (result.aborted) return;
			const verdicts = parseTriageAnswer(
				result.text,
				asked.map((entry) => entry.id),
			);
			if (!triageSnapshotMatches(asked, queues.entries())) {
				outcomeCollector.settleTriage(origin?.id, verdicts, null);
				return;
			}
			outcomeCollector.settleTriage(origin?.id, verdicts, applyTriage(verdicts, triage.autoInterrupt));
		} finally {
			clearTimeout(deadline);
		}
	};

	/** Applies each verdict once; returns the first queued message it applied to, or null when none was left. */
	const applyTriage = (verdicts: ReadonlyArray<TriageVerdict>, autoInterrupt: boolean): string | null => {
		let applied: string | null = null;
		for (const verdict of verdicts) {
			const entry = queues.entries().find((candidate) => candidate.id === verdict.id);
			if (entry === undefined) continue;
			if (
				autoInterrupt &&
				state.streaming &&
				triageMayInterrupt(verdict, entry, Date.now()) &&
				interruptRefusalReason() === null
			) {
				const taken = queues.removeEntry(entry.id, "sent-now");
				if (taken === null) continue;
				const preview = taken.text.replace(/\s+/g, " ").slice(0, 60);
				emitNotice(`[PanCode] triage read "${preview}" as a stop; interrupting the run to deliver it now.`, "warning");
				void loop
					.submitTracked(taken.text, {
						steering: "interrupt",
						triageInterrupt: true,
						continuesMessage: { id: taken.id, enqueuedAt: taken.enqueuedAt },
						...(taken.display ? { display: taken.display } : {}),
						...(taken.referencedPaths && taken.referencedPaths.length > 0
							? { workingContextPaths: taken.referencedPaths }
							: {}),
					})
					.catch(() => {
						// The interrupt path reports its own refusals; nothing else to do here.
					});
				// One interrupt per round: the rest of the queue is held for the new run.
				return applied ?? taken.id;
			}
			queues.relabel(entry.id, triageLabelsFor(verdict), triageKindFor(verdict));
			applied ??= entry.id;
		}
		return applied;
	};
	return { cancelTriage, queuedForTriage };
}
