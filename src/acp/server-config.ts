// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's session configuration: modes, trust, config options, models, safe settings, and targets. */

import { isRecord } from "../core/type-guards.js";
import type { ThinkingLevel } from "../core/views/thinking-levels.js";
import { PROVIDER_PROBE_TIMEOUT_MS } from "../domains/providers/contract.js";
import { resolveRuntimeTarget } from "../domains/providers/runtime-resolution.js";
import type { AutonomyLevel } from "../lib/autonomy/autonomy.js";
import { isAutonomyLevel } from "../lib/autonomy/autonomy.js";
import { clampThinkingLevel, selectModel } from "../session-control/index.js";
import { AcpRequestError } from "./errors.js";
import { requireBoundedClientString, safeStoredIdentifier, utf8Bytes } from "./server-bounds.js";
import { assertParamKeys } from "./server-guards.js";
import type { AcpSafeTargetProjection } from "./server-models.js";
import {
	ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES,
	ACP_MAX_TARGET_LIST_RESULT_BYTES,
	ACP_THINKING_LEVEL_SET,
	configOptions,
	listedLive,
	modelNotDeclared,
	modelSelectionErrorText,
	probeMissingComponent,
	safeProbeReason,
	safeSettingsProjection,
	safeTargetProjection,
	sessionThinking,
	targetModelCandidates,
} from "./server-models.js";
import type { PancodeAcpServerOptions } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import { trustResultMeta } from "./trust-notice.js";
import {
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_MAX_TARGETS,
	ACP_SESSION_META_KEY,
	ACP_SESSION_SET_MODEL_METHOD,
	ACP_SESSION_TRUST_METHOD,
	ACP_SETTINGS_GET_SAFE_METHOD,
	ACP_SETTINGS_PATCH_SAFE_METHOD,
	ACP_TARGETS_LIST_METHOD,
	ACP_TARGETS_PROBE_METHOD,
	ACP_TRUNCATED_META_KEY,
} from "./types.js";
import type { AcpSafeSettingsPatch, AcpTargetList, AcpTargetProbe } from "./types-settings.js";
import { ACP_SAFE_SETTINGS_KEYS } from "./types-settings.js";

function refuseYolo(options: PancodeAcpServerOptions, level: AutonomyLevel): void {
	const refusal = level === "yolo" ? (options.yoloRefusal?.() ?? null) : null;
	if (refusal !== null) throw new AcpRequestError(-32602, refusal, { code: "yolo_refused" });
}

export function createAcpServerConfig(scope: AcpServerScope) {
	const { options } = scope;
	const notifyConfigOptions = (session: AcpServerSession) => {
		options.transport.notify("session/update", {
			sessionId: session.id,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: configOptions(options, scope.listingFallbacks, session),
			},
			_meta: { [ACP_SESSION_META_KEY]: { connection: session.target, model: session.model } },
		});
	};
	/**
	 * A runtime whose listing carries each model's capabilities lists live when its cache is cold, stale or keeps no
	 * capabilities, as `run` does, so the model choices and their thinking levels are the account's. The wait is the
	 * provider probe's own timeout; a late listing still updates the session's options when it lands.
	 */
	const listTargetModels = async (targetId: string | null): Promise<void> => {
		const providers = options.providers;
		if (providers === undefined || targetId === null) return;
		const status = providers.list().find((item) => item.target.id === targetId);
		if (!status?.runtime?.listsModelCapabilities || typeof status.runtime.probe !== "function") return;
		if (status.discoveredModelsSource === "probe" || listedLive(status)) return;
		const probe = providers.probeTarget(targetId, { reasoning: false }).then(
			(probed) =>
				listedLive(probed) ? null : `the live model listing failed: ${probed?.reason ?? "it returned no models"}`,
			(error: unknown) => `the live model listing failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), PROVIDER_PROBE_TIMEOUT_MS);
			timer.unref?.();
		});
		const outcome = await Promise.race([probe, timedOut]);
		clearTimeout(timer);
		if (outcome === null) {
			scope.listingFallbacks.delete(targetId);
			return;
		}
		const reason =
			outcome === "timeout"
				? `the live model listing took longer than ${PROVIDER_PROBE_TIMEOUT_MS / 1_000} s`
				: modelSelectionErrorText(outcome, 512);
		scope.listingFallbacks.set(targetId, reason);
		if (outcome !== "timeout") return;
		void probe.then((late) => {
			if (late !== null) return;
			scope.listingFallbacks.delete(targetId);
			for (const session of scope.sessions.values()) if (session.target === targetId) notifyConfigOptions(session);
		});
	};
	/**
	 * A turn probes its target live before it resolves thinking support, as turn-runtime does, so a cold cache can say
	 * unsupported while the route thinks. The same probe here keeps the thinking option in step; it is re-sent on change only.
	 */
	const refreshThinkingOption = (session: AcpServerSession): void => {
		const providers = options.providers;
		const targetId = session.target;
		const runtime = providers?.list().find((item) => item.target.id === targetId)?.runtime;
		if (!providers || targetId === null || !runtime || typeof providers.probeTarget !== "function") return;
		if (runtime.tier === "cloud" && typeof runtime.probeServingWindows !== "function") return;
		const before = JSON.stringify(sessionThinking(options, session));
		void providers.probeTarget(targetId).then(
			() => {
				if (scope.sessions.get(session.id) !== session || session.target !== targetId) return;
				if (JSON.stringify(sessionThinking(options, session)) !== before) notifyConfigOptions(session);
			},
			() => {},
		);
	};
	const setAutonomy = (session: AcpServerSession, level: unknown): void => {
		if (!isAutonomyLevel(level)) throw new AcpRequestError(-32602, "invalid autonomy level", { code: "invalid_params" });
		refuseYolo(options, level);
		if (session.activePrompt !== null)
			throw new AcpRequestError(-32602, "cannot change autonomy during an active prompt", { code: "prompt_active" });
		if (session.autonomy === level) return;
		session.autonomy = level;
		session.autonomySource = "session";
		options.transport.notify("session/update", {
			sessionId: session.id,
			update: { sessionUpdate: "current_mode_update", currentModeId: level },
		});
		notifyConfigOptions(session);
	};

	options.transport.onRequest("session/set_mode", (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "modeId"]));
		const session = scope.guards.getSession(request);
		setAutonomy(session, request.modeId);
		scope.readoutFeed.publishReadouts(session.id);
		return {};
	});

	options.transport.onRequest(ACP_SESSION_TRUST_METHOD, (params) => {
		scope.guards.requireInitialized();
		const session = scope.guards.getSession(assertParamKeys(params, new Set(["sessionId"])));
		return { _meta: trustResultMeta(session.cwd) };
	});

	const setConfigOption = async (params: unknown) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "configId", "value", "type"]));
		const session = scope.guards.getSession(request);
		if (session.activePrompt !== null)
			throw new AcpRequestError(-32602, "cannot change configuration during an active prompt", {
				code: "prompt_active",
			});
		if (request.type !== undefined && request.type !== "select")
			throw new AcpRequestError(-32602, "invalid configuration type", { code: "invalid_params" });
		const value = request.value;
		if (typeof value !== "string")
			throw new AcpRequestError(-32602, "invalid configuration value", { code: "invalid_params" });
		switch (request.configId) {
			case "autonomy":
				setAutonomy(session, value);
				break;
			case "connection":
			case "model": {
				if (request.configId === "model" && options.providers === undefined) {
					const modelOption = configOptions(options, scope.listingFallbacks, session).find(
						(option) => option.id === "model",
					);
					const models =
						modelOption && Array.isArray(modelOption.options)
							? modelOption.options.flatMap((option) =>
									isRecord(option) && typeof option.value === "string" ? [option.value] : [],
								)
							: [];
					if (!models.includes(value)) throw modelNotDeclared(session.target, value, models);
					if (session.model !== value) {
						if (!options.setSessionRouting)
							throw new AcpRequestError(-32601, "model selection is unavailable", { code: "method_not_found" });
						options.setSessionRouting({ model: value }, scope.handshake.clientSurface);
						session.model = value;
						notifyConfigOptions(session);
					}
					break;
				}
				if (!options.setSessionRouting || !options.providers)
					throw new AcpRequestError(-32601, "model selection is unavailable", { code: "method_not_found" });
				const target = request.configId === "connection" ? value : session.target;
				if (request.configId === "connection" && target !== session.target) await listTargetModels(target);
				const status = options.providers.list().find((item) => item.target.id === target);
				if (!target || !status)
					throw new AcpRequestError(-32602, "connection is not available", { code: "invalid_params" });
				const models = targetModelCandidates(status);
				const defaultModel =
					safeStoredIdentifier(status.target.defaultModel, ACP_MAX_MODEL_ID_BYTES) ??
					safeStoredIdentifier(status.runtime?.defaultModel, ACP_MAX_MODEL_ID_BYTES) ??
					undefined;
				const model =
					request.configId === "model"
						? value
						: session.model && models.includes(session.model)
							? session.model
							: defaultModel;
				if (!model || (!models.includes(model) && !(target === session.target && model === session.model)))
					throw modelNotDeclared(target, model, models);
				try {
					const selected = selectModel(
						options.providers,
						{ target, model, thinkingLevel: session.thinkingLevel },
						(selected) => options.setSessionRouting?.(selected, scope.handshake.clientSurface),
					);
					session.target = selected.target;
					session.model = selected.model;
					// The session keeps the level asked for; each model resolves what it does with it, shown as currentValue.
				} catch (error) {
					throw new AcpRequestError(-32602, "connection cannot host this session model", {
						code: "invalid_params",
						reason: modelSelectionErrorText(error instanceof Error ? error.message : String(error), 1024),
					});
				}
				notifyConfigOptions(session);
				// The new route's thinking resolves from a cache that may be cold, so it probes as an opener does.
				refreshThinkingOption(session);
				break;
			}
			case "thinkingLevel": {
				if (!ACP_THINKING_LEVEL_SET.has(value as ThinkingLevel))
					throw new AcpRequestError(-32602, "invalid thinking level", { code: "invalid_params" });
				const requested = value as ThinkingLevel;
				// A level the model has runs; an unlisted one runs at the nearest listed level, returned as currentValue
				// with a notice. A model with no thinking at all refuses any level but off rather than keep it silently.
				const thinking = sessionThinking(options, session, session.model, requested);
				if (options.providers !== undefined && requested !== "off") {
					const levels = thinking?.supportedLevels ?? [];
					if (!levels.some((level) => level !== "off"))
						throw new AcpRequestError(
							-32602,
							`this model cannot run thinking ${requested}; it supports ${levels.length > 0 ? levels.join(", ") : "no thinking levels"}`,
							{ code: "invalid_params", reason: "thinking-unsupported" },
						);
				}
				if (session.thinkingLevel !== requested) {
					if (!options.setSessionRouting)
						throw new AcpRequestError(-32601, "thinking selection is unavailable", { code: "method_not_found" });
					const thinkingLevel =
						thinking?.effectiveLevel ?? clampThinkingLevel(options.providers, session.target, session.model, requested);
					options.setSessionRouting({ thinkingLevel }, scope.handshake.clientSurface);
					session.thinkingLevel = requested;
					notifyConfigOptions(session);
				}
				break;
			}
			default:
				throw new AcpRequestError(-32602, "unknown configuration option", { code: "invalid_params" });
		}
		return { configOptions: configOptions(options, scope.listingFallbacks, session) };
	};
	options.transport.onRequest("session/set_config_option", setConfigOption);
	options.transport.onRequest(ACP_SESSION_SET_MODEL_METHOD, async (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "modelId"]));
		if (typeof request.modelId !== "string")
			throw new AcpRequestError(-32602, "invalid model id", { code: "invalid_params" });
		await setConfigOption({ sessionId: request.sessionId, configId: "model", value: request.modelId });
		return {};
	});

	options.transport.onRequest(ACP_SETTINGS_GET_SAFE_METHOD, (params) => {
		scope.guards.requireInitialized();
		assertParamKeys(params, new Set());
		if (options.settings === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		return safeSettingsProjection(options.settings.read());
	});

	options.transport.onRequest(ACP_SETTINGS_PATCH_SAFE_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["patch"]));
		if (!isRecord(request.patch)) {
			throw new AcpRequestError(-32602, "patch must be an object", { code: "invalid_params" });
		}
		if (scope.activePromptState !== null) {
			throw new AcpRequestError(-32602, "cannot patch settings during an active prompt", { code: "prompt_active" });
		}
		if (options.settings === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const patch: AcpSafeSettingsPatch = {};
		for (const [key, value] of Object.entries(request.patch)) {
			if (!(ACP_SAFE_SETTINGS_KEYS as ReadonlyArray<string>).includes(key)) {
				throw new AcpRequestError(-32602, "patch contains an unknown setting", { code: "invalid_params" });
			}
			switch (key) {
				case "chat.target": {
					if (value === null) {
						patch[key] = null;
						break;
					}
					const target = requireBoundedClientString(value, key, ACP_MAX_TARGET_ID_BYTES);
					if (options.providers?.getTarget(target) === null || options.providers === undefined) {
						throw new AcpRequestError(-32602, "connection is not configured", {
							code: "invalid_params",
							reason: "target-unknown",
						});
					}
					patch[key] = target;
					break;
				}
				case "chat.model":
					patch[key] = value === null ? null : requireBoundedClientString(value, key, ACP_MAX_MODEL_ID_BYTES);
					break;
				case "chat.thinkingLevel":
					if (typeof value !== "string" || !ACP_THINKING_LEVEL_SET.has(value as ThinkingLevel)) {
						throw new AcpRequestError(-32602, "invalid thinking level", { code: "invalid_params" });
					}
					patch[key] = value as ThinkingLevel;
					break;
				case "safety.autonomy":
					if (!isAutonomyLevel(value)) {
						throw new AcpRequestError(-32602, "invalid autonomy level", { code: "invalid_params" });
					}
					refuseYolo(options, value);
					patch[key] = value;
					break;
			}
		}
		const current = options.settings.read();
		const nextTarget = patch["chat.target"] === undefined ? current.target : patch["chat.target"];
		const nextModel = patch["chat.model"] === undefined ? current.model : patch["chat.model"];
		if (nextTarget === null && nextModel !== null) {
			throw new AcpRequestError(-32602, "model requires a configured connection", { code: "invalid_params" });
		}
		try {
			const committed = options.settings.commit(patch, scope.handshake.clientSurface);
			const session = scope.boundSessionId === null ? undefined : scope.sessions.get(scope.boundSessionId);
			if (
				session &&
				(patch["chat.target"] !== undefined ||
					patch["chat.model"] !== undefined ||
					patch["chat.thinkingLevel"] !== undefined)
			) {
				session.target = committed.target;
				session.model = committed.model;
				session.thinkingLevel = committed.thinkingLevel;
				notifyConfigOptions(session);
			}
			return safeSettingsProjection(committed);
		} catch {
			throw new AcpRequestError(-32603, "safe settings could not be updated", { code: "internal_error" });
		}
	});

	options.transport.onRequest(ACP_TARGETS_LIST_METHOD, (params): AcpTargetList => {
		scope.guards.requireInitialized();
		assertParamKeys(params, new Set());
		if (options.providers === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const targets: AcpSafeTargetProjection[] = [];
		let budgetExhausted = false;
		// Budget incrementally from the exact JSON representation. Re-serializing
		// the growing full result for every one of up to 4,096 model ids turns a
		// bounded config list into avoidable quadratic work.
		let budgetBytes = ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES;
		for (const status of options.providers.list()) {
			const projected = safeTargetProjection(status);
			if (projected === null) continue;
			const bounded: AcpSafeTargetProjection = { ...projected, models: [] };
			let boundedBytes = utf8Bytes(JSON.stringify(bounded));
			const targetSeparatorBytes = targets.length > 0 ? 1 : 0;
			if (budgetBytes + targetSeparatorBytes + boundedBytes > ACP_MAX_TARGET_LIST_RESULT_BYTES) {
				budgetExhausted = true;
				break;
			}
			targets.push(bounded);
			budgetBytes += targetSeparatorBytes + boundedBytes;
			for (const model of projected.models) {
				const candidateModels = [...bounded.models, model];
				const resolved = resolveRuntimeTarget(options.providers, {
					targetId: projected.id,
					wireModelId: model,
					requestedThinkingLevel: "off",
					use: "orchestrator",
				});
				const thinkingLevels = {
					...bounded.thinkingLevels,
					...(resolved.ok ? { [model]: Array.from(resolved.target.modelRuntime.thinking.supportedLevels) } : {}),
				};
				const candidate = { ...bounded, models: candidateModels, thinkingLevels };
				const candidateBytes = utf8Bytes(JSON.stringify(candidate));
				if (budgetBytes + candidateBytes - boundedBytes > ACP_MAX_TARGET_LIST_RESULT_BYTES) {
					budgetExhausted = true;
					bounded.modelsTruncated = true;
					break;
				}
				bounded.models.push(model);
				bounded.thinkingLevels = thinkingLevels;
				budgetBytes += candidateBytes - boundedBytes;
				boundedBytes = candidateBytes;
			}
			if (budgetExhausted) break;
			if (targets.length === ACP_MAX_TARGETS) break;
		}
		return {
			targets,
			...(budgetExhausted ? { _meta: { [ACP_TRUNCATED_META_KEY]: true } } : {}),
		};
	});

	options.transport.onRequest(ACP_TARGETS_PROBE_METHOD, async (params): Promise<AcpTargetProbe> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["targetId"]));
		const targetId = requireBoundedClientString(request.targetId, "targetId", ACP_MAX_TARGET_ID_BYTES);
		if (options.providers === undefined)
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		if (options.providers.getTarget(targetId) === null) {
			throw new AcpRequestError(-32602, "connection is not configured", {
				code: "invalid_params",
				reason: "target-unknown",
			});
		}
		try {
			// An operator's check asks the provider itself. A runtime that answers from its cached listing
			// records no health, so a cached answer read as unreachable on a working target.
			const status = await options.providers.probeTarget(targetId, { reasoning: false, fresh: true });
			if (status === null) return { targetId, healthy: false, latencyMs: null, reason: "probe-failed" };
			for (const session of scope.sessions.values()) if (session.target === targetId) notifyConfigOptions(session);
			const reason = safeProbeReason(options.providers, status);
			const latencyMs =
				typeof status.health.latencyMs === "number" &&
				Number.isFinite(status.health.latencyMs) &&
				status.health.latencyMs >= 0
					? Math.round(status.health.latencyMs)
					: null;
			const component = reason === "component-missing" ? probeMissingComponent(status) : null;
			return { targetId, healthy: reason === null, latencyMs, reason, ...(component !== null ? { component } : {}) };
		} catch {
			return { targetId, healthy: false, latencyMs: null, reason: "probe-failed" };
		}
	});
	return { listTargetModels, refreshThinkingOption };
}

export type AcpServerConfig = ReturnType<typeof createAcpServerConfig>;
