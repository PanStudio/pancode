// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * A turn runtime's route: resolving the selected target, the live capability probe and its poll target, the
 * model-offer check, model synthesis, the reasoning probe, the thinking clamp notice, and previewing or rebinding
 * a route on a settled agent.
 */

import { type ModelRouteRefusal, modelRouteGuarded } from "../../core/response-model-id.js";
import {
	applyModelCapabilityPatch,
	modelOfferForStatus,
	modelResidencyForStatus,
	type ProvidersContract,
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
	runtimeListsModelsLive,
	runtimeResolutionWarningsBesideThinkingNotice,
	synthesizeTargetModel,
	type TargetStatus,
} from "../../domains/providers/index.js";
import type { EngineModel } from "../../engine/types.js";
import { HOST_STATUS_NOTICE_KEY, THINKING_CLAMP_NOTICE_KEY } from "../chat-loop-messages.js";
import type { TurnRuntime } from "../turn-runtime-types.js";
import { coldModelNotice } from "../turn-runtime-wait.js";
import type { ChatLoopTarget } from "../turn-state.js";
import { TurnAdmissionError } from "./errors.js";
import type { TurnRuntimeScope } from "./scope.js";

export function createRouteControl(rt: TurnRuntimeScope) {
	const { deps, state, context, persistence } = rt;

	/**
	 * Resolution warnings the operator has already been shown, keyed by
	 * target+model+message. A resolution runs on every turn, so without this the
	 * same context-window warning would print on every submit; without any
	 * surfacing at all, it printed nowhere. Known template-option limitations
	 * use a brief footer advisory; actionable resolution warnings retain their
	 * transcript notice. Detailed diagnostics remain on the resolution.
	 */
	const announcedResolutionWarnings = new Set<string>();

	const readTarget = (route?: { target: string; model: string }): ChatLoopTarget | null => {
		const settings = deps.getSettings();
		const targetId = (route?.target ?? settings.chat.target)?.trim();
		const wireModelId = (route?.model ?? settings.chat.model)?.trim();
		if (!targetId || !wireModelId) return null;
		const resolved = resolveRuntimeTarget(deps.providers, {
			targetId,
			wireModelId,
			requestedThinkingLevel: settings.chat.thinkingLevel ?? "off",
			use: "orchestrator",
			requireTools: false,
			requireOutputBudget: true,
		});
		if (!resolved.ok) {
			const failure = resolved.diagnostics.find((entry) => entry.severity === "error") ?? resolved.diagnostics[0];
			throw new TurnAdmissionError(
				`[PanCode] ${failure?.message ?? "orchestrator target resolution failed"}`,
				failure?.code ?? "admission-failed",
			);
		}
		for (const entry of resolved.diagnostics) {
			if (entry.code !== "chat-template-kwargs-undeliverable") continue;
			const key = `${targetId}|${wireModelId}|${entry.code}`;
			if (announcedResolutionWarnings.has(key)) continue;
			announcedResolutionWarnings.add(key);
			deps.emitFooterNotice(
				resolved.target.modelRuntime.request.undeliverableChatTemplateKwargs?.declaredUnsupported ? "info" : "warning",
				`${resolved.target.runtime.id} ignores custom template options; continuing.`,
				key,
			);
		}
		// An unverified context window is a fact about the route, not a fault, so it travels as host status.
		const routeStatus = new Set(
			resolved.diagnostics.filter((entry) => entry.code === "context-window-unverified").map((entry) => entry.message),
		);
		// The TUI's thinking indicator owns coercion facts; other surfaces retain their notice.
		for (const message of runtimeResolutionWarningsBesideThinkingNotice(
			resolved.diagnostics.filter((entry) => entry.code !== "chat-template-kwargs-undeliverable"),
			resolved.target.modelRuntime.thinking.notice,
		)) {
			const key = `${targetId}|${wireModelId}|${message}`;
			if (announcedResolutionWarnings.has(key)) continue;
			announcedResolutionWarnings.add(key);
			deps.emitNotice(`[PanCode] ${message}`, "info", routeStatus.has(message) ? HOST_STATUS_NOTICE_KEY : undefined);
		}
		return {
			target: resolved.target.target,
			runtime: resolved.target.runtime,
			wireModelId: resolved.target.wireModelId,
			runtimeResolution: resolved.target,
		};
	};

	/**
	 * Refresh the selected route's server report on a short TTL. The key
	 * includes target settings and wire model, so selection and endpoint edits
	 * refresh immediately on the next poll or submit. A failed probe is retried
	 * after the TTL and never extends a prior serving-window claim.
	 *
	 * Every tier but `cloud` is probed. A self-hosted OpenAI-compatible gateway
	 * serves whatever context it was launched with, and that number lives on the
	 * server. Restricting this to `local-native` meant an `openai-compat`
	 * target ran the whole session on an assumed window while the server was
	 * one HTTP GET away from reporting the real one. A hosted provider is asked
	 * too when its runtime reports windows (`probeServingWindows`); the rest of
	 * the cloud runtimes keep their labeled catalog fallback.
	 */
	const TARGET_PROBE_TTL_MS = 30_000;

	let lastTargetProbe: { key: string; at: number } | null = null;

	const targetProbesInFlight = new Map<string, Promise<void>>();
	const ensureLiveCapabilitiesForSelectedModel = async (options?: { silent?: boolean }): Promise<void> => {
		if (rt.disposed) return;
		const settings = deps.getSettings();
		const targetId = settings.chat.target?.trim();
		const wireModelId = settings.chat.model?.trim();
		if (!targetId || !wireModelId) return;
		const target = deps.providers.getTarget(targetId);
		if (!target) return;
		const runtimeDesc = deps.providers.getRuntime(target.runtime);
		if (!runtimeDesc || (runtimeDesc.tier === "cloud" && typeof runtimeDesc.probeServingWindows !== "function")) return;
		const key = JSON.stringify([targetId, wireModelId, target]);
		const inFlight = targetProbesInFlight.get(key);
		if (inFlight) {
			await inFlight;
			return;
		}
		const now = Date.now();
		if (lastTargetProbe?.key === key && now - lastTargetProbe.at < TARGET_PROBE_TTL_MS) return;
		lastTargetProbe = { key, at: now };
		const probe = (async (): Promise<void> => {
			let status: Awaited<ReturnType<ProvidersContract["probeTarget"]>> = null;
			try {
				status = await deps.providers.probeTarget(targetId);
			} catch {
				// Unexpected provider-contract failures retry after the TTL.
			}
			if (rt.disposed) return;
			// Any probe's word counts for the rail, including the silent one that spends the TTL before a submit.
			const probed = modelResidencyForStatus(status, wireModelId);
			rt.coldAtProbe =
				probed === "absent" || probed === "loading" ? { targetId, modelId: wireModelId, state: probed } : null;
			if (!options?.silent) announceColdModel(status, targetId, wireModelId);
			// A passive refresh must update the attached model and footer budget too;
			// the provider status alone is otherwise invisible until the next submit.
			if (
				state.runtime &&
				!state.streaming &&
				deps.getSettings().chat.target === targetId &&
				deps.getSettings().chat.model === wireModelId
			) {
				rt.ensureRuntime({ silent: true });
			}
			context.refreshLiveBudget();
		})();
		targetProbesInFlight.set(key, probe);
		try {
			await probe;
		} finally {
			if (targetProbesInFlight.get(key) === probe) targetProbesInFlight.delete(key);
		}
	};

	/**
	 * Row 384, before any request: a guarded target whose list lacks the requested model refuses the turn, naming what
	 * it offers. Only the provider's live answer refuses: a cached or absent list is asked live once (`fresh` passes any
	 * runtime cache), and an offered or unknown answer is kept for the session so the check costs one listing.
	 */
	const settledModelOffers = new Set<string>();
	const modelOfferRefusal = async (
		targetId: string,
		modelId: string,
		signal: AbortSignal | undefined,
	): Promise<ModelRouteRefusal | null> => {
		const key = JSON.stringify([targetId, modelId]);
		if (settledModelOffers.has(key)) return null;
		const held = modelOfferForStatus(
			deps.providers.list().find((status) => status.target.id === targetId),
			modelId,
		);
		const runtime = deps.providers.getRuntime(deps.providers.getTarget(targetId)?.runtime ?? "");
		if (held.kind === "offered" || !modelRouteGuarded(runtime) || !runtime || !runtimeListsModelsLive(runtime)) {
			settledModelOffers.add(key);
			return null;
		}
		let live: TargetStatus | null = null;
		try {
			live = await deps.providers.probeTarget(targetId, { fresh: true, ...(signal ? { signal } : {}) });
		} catch {
			// No answer is no evidence: the request goes as it would have.
		}
		const offer = modelOfferForStatus(live, modelId);
		if (offer.kind !== "not-offered") {
			settledModelOffers.add(key);
			return null;
		}
		return { code: "model_unavailable", target: targetId, requested: modelId, available: offer.available };
	};

	/** One notice per target+model+state, so a repeated probe stays quiet. */
	const announcedColdModels = new Set<string>();
	const announceColdModel = (
		status: Awaited<ReturnType<ProvidersContract["probeTarget"]>>,
		targetId: string,
		wireModelId: string,
	): void => {
		const notice = coldModelNotice(status, targetId, wireModelId);
		if (!notice) return;
		if (announcedColdModels.has(notice.key)) return;
		announcedColdModels.add(notice.key);
		deps.emitNotice(notice.message, "info", HOST_STATUS_NOTICE_KEY);
	};

	const synthesizeModel = (target: ChatLoopTarget): EngineModel => {
		const { model, runtimeResolution } = synthesizeTargetModel(target.runtimeResolution, deps.providers.knowledgeBase);
		target.runtimeResolution = runtimeResolution;
		return model;
	};

	const ensureReasoningProbe = (target: ChatLoopTarget): void => {
		if (deps.providers.getDetectedReasoning(target.target.id, target.wireModelId) !== null) return;
		void deps.providers
			.probeReasoningForModel(target.target.id, target.wireModelId)
			.then((reasoning) => {
				if (
					reasoning !== null &&
					state.runtime &&
					state.runtime.targetId === target.target.id &&
					state.runtime.wireModelId === target.wireModelId
				) {
					const refreshed = resolveRuntimeTarget(deps.providers, {
						targetId: target.target.id,
						wireModelId: target.wireModelId,
						requestedThinkingLevel: deps.getSettings().chat.thinkingLevel ?? "off",
						use: "orchestrator",
						requireTools: false,
						requireOutputBudget: true,
					});
					if (!refreshed.ok) return;
					const liveModel = state.runtime.agent.state.model;
					const runtimeResolution = liveModel
						? refineRuntimeTargetWithModelHints(refreshed.target, liveModel, deps.providers.knowledgeBase)
						: refreshed.target;
					if (liveModel) applyModelCapabilityPatch(liveModel, runtimeResolution.capabilities);
					state.runtime.agent.state.thinkingLevel = runtimeResolution.effectiveThinkingLevel;
					state.runtime.runtimeResolution = runtimeResolution;
				}
			})
			.catch(() => {
				// Probe failures are non-fatal; the cache stays cold and /thinking
				// keeps showing the runtime defaults until the next probe attempt.
			});
	};

	/**
	 * One visible line when the requested thinking dial cannot apply as-is
	 * (reasoning-class-never model, always-on model, on/off coercion). Emitted
	 * where the dial takes effect, once per session, model and requested level; the
	 * same facts stay inspectable in receipts via runtimeResolution.thinking.
	 */
	const announcedThinkingNotices = new Set<string>();
	let thinkingNoticeSession: string | undefined;
	const emitThinkingClampNotice = (resolution: ChatLoopTarget["runtimeResolution"]): void => {
		if (deps.interactiveGuidance) return;
		const sessionId = deps.sessionId?.();
		// The first runtime can precede session creation; bind its notices to that session.
		if (sessionId !== thinkingNoticeSession) {
			if (thinkingNoticeSession !== undefined) announcedThinkingNotices.clear();
			thinkingNoticeSession = sessionId;
		}
		const thinking = resolution.modelRuntime.thinking;
		const notice = thinking.notice.trim();
		if (thinking.noticeKind === "applied" || notice.length === 0) return;
		const key = `${resolution.wireModelId}|${resolution.requestedThinkingLevel}`;
		if (announcedThinkingNotices.has(key)) return;
		announcedThinkingNotices.add(key);
		deps.emitNotice(notice, "info", THINKING_CLAMP_NOTICE_KEY);
	};

	const previewRoute: TurnRuntime["previewRoute"] = (route) => {
		const target = readTarget(route);
		return target ? { target, model: synthesizeModel(target) } : null;
	};

	const rebindRoute: TurnRuntime["rebindRoute"] = (target) => {
		const runtime = state.runtime;
		if (!runtime) return;
		// Between turns another target gets a new agent. Mid-turn the submit and the ladder hold this one, and nothing it
		// keeps is the route's own: Pi reads model, thinking, tools and messages from state at each run, and the closures
		// above read the route through `localRuntime`.
		const crossed = runtime.targetId !== target.target.id || runtime.runtimeId !== target.runtime.id;
		const nextModel = synthesizeModel(target);
		if (crossed) {
			rt.cleanupSessionResources(runtime.agent.sessionId);
			const gatewaySession = target.runtime.id === "litellm" ? deps.sessionId?.() : undefined;
			if (gatewaySession !== undefined) runtime.agent.sessionId = gatewaySession;
			else delete runtime.agent.sessionId;
		}
		runtime.agent.state.model = nextModel;
		runtime.agent.state.thinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
		runtime.targetId = target.target.id;
		runtime.runtimeId = target.runtime.id;
		runtime.wireModelId = target.wireModelId;
		runtime.runtimeResolution = target.runtimeResolution;
		delete runtime.lastAuthResolution;
		delete runtime.lastProviderStatus;
		rt.runtimeTargetSettings = JSON.stringify(target.target);
		emitThinkingClampNotice(target.runtimeResolution);
		persistence.appendModelChangeEntry(target);
		ensureReasoningProbe(target);
	};

	return {
		readTarget,
		ensureLiveCapabilitiesForSelectedModel,
		modelOfferRefusal,
		synthesizeModel,
		ensureReasoningProbe,
		emitThinkingClampNotice,
		previewRoute,
		rebindRoute,
	};
}
