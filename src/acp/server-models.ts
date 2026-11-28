// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Settings, target and model projections the ACP server returns: the safe
 * settings view, target lists, a session's mode and config options, and the
 * model selection errors.
 */

import { sandboxAvailability } from "../core/sandbox/availability.js";
import { mainShellContained, yoloShellState } from "../core/sandbox/main-session.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../core/views/thinking-levels.js";
import { missingRuntimeComponent } from "../domains/install/components.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/eligibility.js";
import { modelIdsForStatus } from "../domains/providers/model-discovery.js";
import { resolveRuntimeTarget } from "../domains/providers/runtime-resolution.js";
import { DEFAULT_AUTONOMY_LEVEL, isAutonomyLevel, type YoloConfinement } from "../lib/autonomy/autonomy.js";
import { sanitizeCallTargetText } from "../lib/call-target/call-target.js";
import { redactSecretString } from "../lib/secrets/redaction.js";
import { AcpRequestError } from "./errors.js";
import {
	boundString,
	safeConfiguredIdentifier,
	safeStoredIdentifier,
	safeStoredString,
	utf8Bytes,
} from "./server-bounds.js";
import type { AcpSafeSettingsSnapshot, PancodeAcpServerOptions } from "./server-options.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import {
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_MODELS_META_KEY,
	ACP_NOTICE_META_KEY,
	ACP_TARGET_MODEL_LIMIT,
	ACP_THINKING_LEVELS_META_KEY,
	ACP_TRUNCATED_META_KEY,
} from "./types.js";
import type { AcpSafeSettings, AcpTarget } from "./types-settings.js";
import { ACP_SAFE_SETTINGS_KEYS } from "./types-settings.js";

export const ACP_THINKING_LEVEL_SET = new Set<ThinkingLevel>(THINKING_LEVELS);
// The frozen client reader ceiling is 256 KiB per JSON-RPC line. Reserve
// 16 KiB for the response envelope/request id and keep this result a stable
// prefix of whole targets/model ids.
export const ACP_MAX_TARGET_LIST_RESULT_BYTES = 240 * 1024;
export const ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES = utf8Bytes(
	JSON.stringify({ targets: [], _meta: { [ACP_TRUNCATED_META_KEY]: true } }),
);
// Session summaries share the same JSON-RPC line ceiling. Keep a
// stable newest-first prefix of whole rows and reserve 16 KiB for the envelope.
export const ACP_MAX_SESSION_LIST_RESULT_BYTES = 240 * 1024;

const SANDBOXED = "Commands run in a sandbox that limits what they can change.";
const ONLY_YOU = "Decisions only you can make ask you directly.";
const YOLO_STILL_APPLIES =
	"PanCode's built-in blocks, your own safety rules and the run's limits still apply, and questions PanCode asks still reach you.";

/**
 * What each autonomy mode does on this host, in the words the GUI menu and an editor's mode picker show: the sandbox
 * and safety check a run records, never a backend name, setting key or internal role (M-19).
 */
function modeDescriptions(
	containment: AcpSafeSettingsSnapshot["containment"],
	confinement: YoloConfinement,
): { default: string; yolo: string } {
	const mode = containment?.sandbox ?? "auto";
	const availability = sandboxAvailability();
	const judge = containment?.judgeEnabled ?? true;
	const riskier = judge
		? "Riskier calls go to an automatic safety check, which runs them, refuses them or asks you."
		: "Riskier calls ask you.";
	const askFirst = `${
		mainShellContained(mode, availability)
			? `Edits and commands inside this workspace go ahead. ${SANDBOXED}`
			: "Edits inside this workspace go ahead. Commands get no sandbox here, so they count as riskier."
	} ${riskier} ${ONLY_YOU}`;
	if (confinement === "unconfined") {
		const shell = yoloShellState(confinement, mode, availability);
		const commands =
			shell === "sandboxed"
				? SANDBOXED
				: shell === "refused"
					? "Commands are refused: your settings require a sandbox and this computer has none."
					: "Commands run directly on this computer, with no sandbox.";
		return {
			default: askFirst,
			yolo: `No approval card waits for you, and the automatic safety check is skipped. ${commands} ${YOLO_STILL_APPLIES}`,
		};
	}
	const commands = mainShellContained(mode, availability) ? SANDBOXED : "Commands get no sandbox here.";
	const refused = judge
		? "The automatic safety check works as it does in default, and anything that would ask you is refused back to PanCode instead."
		: "Anything that would ask you in default is refused back to PanCode instead.";
	return {
		default: askFirst,
		yolo: `No approval card waits for you. ${commands} ${refused} ${YOLO_STILL_APPLIES}`,
	};
}

export function safeSettingsProjection(snapshot: AcpSafeSettingsSnapshot): AcpSafeSettings {
	const thinkingLevel = ACP_THINKING_LEVEL_SET.has(snapshot.thinkingLevel) ? snapshot.thinkingLevel : "off";
	const autonomy = isAutonomyLevel(snapshot.autonomy) ? snapshot.autonomy : DEFAULT_AUTONOMY_LEVEL;
	return {
		settings: {
			chat: {
				target: safeConfiguredIdentifier(snapshot.target, ACP_MAX_TARGET_ID_BYTES),
				model: safeConfiguredIdentifier(snapshot.model, ACP_MAX_MODEL_ID_BYTES),
				thinkingLevel,
			},
			safety: { autonomy },
		},
		editable: [...ACP_SAFE_SETTINGS_KEYS],
	};
}

function safeTargetModels(status: ReturnType<ProvidersContract["list"]>[number]): string[] {
	return targetModelCandidates(status).slice(0, ACP_TARGET_MODEL_LIMIT);
}

export function targetModelCandidates(status: ReturnType<ProvidersContract["list"]>[number]): string[] {
	const candidates = [
		status.target.defaultModel,
		...(status.target.wireModels ?? []),
		...status.discoveredModels,
		...modelIdsForStatus(status),
		status.runtime?.defaultModel,
	];
	const seen = new Set<string>();
	const models: string[] = [];
	for (const candidate of candidates) {
		const id = safeStoredIdentifier(candidate, ACP_MAX_MODEL_ID_BYTES);
		if (id === null || seen.has(id)) continue;
		seen.add(id);
		models.push(id);
	}
	return models;
}

export function modelSelectionErrorText(value: string, maxBytes: number): string {
	return boundString(redactSecretString(sanitizeCallTargetText(value)), maxBytes);
}

export function modelNotDeclared(
	target: string | null,
	model: string | undefined,
	models: readonly string[],
): AcpRequestError {
	return new AcpRequestError(
		-32602,
		"model is not declared for this connection; choose an available model or update targets[].wireModels in settings.yaml and restart the ACP session",
		{
			code: "invalid_params",
			modelSelection: {
				code: "model_not_declared",
				targetId: target === null ? null : modelSelectionErrorText(target, ACP_MAX_TARGET_ID_BYTES),
				requestedModel: model === undefined ? null : modelSelectionErrorText(model, ACP_MAX_MODEL_ID_BYTES),
				availableModels: models
					.slice(0, ACP_TARGET_MODEL_LIMIT)
					.map((choice) => modelSelectionErrorText(choice, ACP_MAX_MODEL_ID_BYTES)),
				remedy:
					"Add the requested model to targets[].wireModels for this connection in settings.yaml, then restart the ACP session.",
			},
		},
	);
}

export type AcpSafeTargetProjection = AcpTarget;

export function safeTargetProjection(
	status: ReturnType<ProvidersContract["list"]>[number],
): AcpSafeTargetProjection | null {
	const id = safeStoredIdentifier(status.target.id, ACP_MAX_TARGET_ID_BYTES);
	const runtime = safeStoredIdentifier(status.target.runtime, 64);
	if (id === null || runtime === null) return null;
	let url: string | null = null;
	if (status.target.url !== undefined) {
		try {
			const endpoint = new URL(status.target.url);
			if (endpoint.protocol === "http:" || endpoint.protocol === "https:") {
				endpoint.username = "";
				endpoint.password = "";
				endpoint.search = "";
				endpoint.hash = "";
				url = safeStoredString(endpoint.toString(), 2048);
			}
		} catch {
			/* Invalid configured endpoints disclose no raw credentials. */
		}
	}
	const allModels = targetModelCandidates(status);
	const models = allModels.slice(0, ACP_TARGET_MODEL_LIMIT);
	const window = status.capabilities?.contextWindow;
	return {
		id,
		runtime,
		models,
		isOrchestrator: status.runtime !== null && isOrchestratorEligibleRuntime(status.runtime),
		...(status.target.url !== undefined ? { url } : {}),
		...(status.target.defaultModel !== undefined
			? { defaultModel: safeStoredIdentifier(status.target.defaultModel, ACP_MAX_MODEL_ID_BYTES) }
			: {}),
		...(typeof status.available === "boolean" ? { available: status.available } : {}),
		...(status.health?.status !== undefined ? { health: status.health.status } : {}),
		...(status.runtime?.tier !== undefined ? { tier: status.runtime.tier } : {}),
		...(window !== undefined ? { contextWindow: Number.isFinite(window) && window > 0 ? window : null } : {}),
		modelsTruncated: allModels.length > models.length,
	};
}

export function safeProbeReason(
	providers: ProvidersContract,
	status: ReturnType<ProvidersContract["list"]>[number],
): "not-configured" | "unreachable" | "unsupported" | "component-missing" | null {
	if (status.runtime === null || typeof status.runtime.probe !== "function") return "unsupported";
	// A runtime whose separately installed component is missing never asked the provider, so it is no reachability verdict.
	if (!status.available && probeMissingComponent(status) !== null) return "component-missing";
	try {
		if (status.runtime.auth !== "none" && !providers.auth.statusForTarget(status.target, status.runtime).available) {
			return "not-configured";
		}
	} catch {
		return "not-configured";
	}
	// Degraded is reachable with a default the server does not serve; a client
	// that names its own model can still use the target.
	const reachable = status.health.status === "healthy" || status.health.status === "degraded";
	return status.available && reachable ? null : "unreachable";
}

/** The component a probed target's runtime could not load, from the host's own unavailable-component wording. */
export function probeMissingComponent(status: ReturnType<ProvidersContract["list"]>[number]) {
	return missingRuntimeComponent(status.reason) ?? missingRuntimeComponent(status.health.lastError);
}

const modeState = (options: PancodeAcpServerOptions, session: AcpServerSession) => {
	const descriptions = modeDescriptions(
		options.settings?.read().containment,
		options.autonomyPosture?.().confinement ?? "contained",
	);
	return {
		currentModeId: session.autonomy,
		availableModes: [
			{ id: "default", name: "default", description: descriptions.default },
			{ id: "yolo", name: "yolo", description: descriptions.yolo },
		],
	};
};

export const sessionThinking = (
	options: PancodeAcpServerOptions,
	session: AcpServerSession,
	model = session.model,
	level = session.thinkingLevel,
) => {
	if (!options.providers || !session.target || !model) return null;
	const resolved = resolveRuntimeTarget(options.providers, {
		targetId: session.target,
		wireModelId: model,
		requestedThinkingLevel: level,
		use: "orchestrator",
	});
	return resolved.ok ? resolved.target.modelRuntime.thinking : null;
};

const sessionModelChoices = (
	options: PancodeAcpServerOptions,
	session: AcpServerSession,
	current: string,
): string[] => {
	const status = options.providers?.list().find((item) => item.target.id === session.target);
	const models = status === undefined ? [] : safeTargetModels(status);
	if (!models.includes(current)) models.unshift(current);
	return models.slice(0, ACP_TARGET_MODEL_LIMIT);
};

export const configOptions = (
	options: PancodeAcpServerOptions,
	listingFallbacks: Map<string, string>,
	session: AcpServerSession,
) => {
	const optionsList: Array<Record<string, unknown>> = [
		{
			id: "autonomy",
			name: "Autonomy",
			category: "mode",
			type: "select",
			currentValue: session.autonomy,
			options: modeState(options, session).availableModes.map((mode) => ({
				value: mode.id,
				name: mode.name,
				description: mode.description,
			})),
		},
	];
	if (options.providers && options.setSessionRouting) {
		optionsList.push({
			id: "connection",
			name: "Connection",
			// Custom categories start with an underscore. Keeping `model` for the model
			// option alone stops a peer that takes the first model-category option from
			// choosing a target as the model.
			category: "_connection",
			type: "select",
			currentValue: session.target,
			options: options.providers
				.list()
				.filter((status) => status.runtime !== null && isOrchestratorEligibleRuntime(status.runtime))
				.map((status) => ({ value: status.target.id, name: status.target.id })),
		});
	}
	if (session.model !== null) {
		const models = sessionModelChoices(options, session, session.model);
		const fallback = session.target === null ? undefined : listingFallbacks.get(session.target);
		optionsList.push({
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: session.model,
			...(fallback !== undefined ? { description: `Configured models only: ${fallback}.` } : {}),
			options: models.map((model) => {
				const thinking = sessionThinking(options, session, model);
				return {
					value: model,
					name: model,
					...(thinking ? { _meta: { [ACP_THINKING_LEVELS_META_KEY]: thinking.supportedLevels } } : {}),
				};
			}),
		});
	}
	const thinking = sessionThinking(options, session);
	optionsList.push({
		id: "thinkingLevel",
		name: "Thinking level",
		category: "thought_level",
		type: "select",
		currentValue: thinking?.effectiveLevel ?? session.thinkingLevel,
		...(thinking && (thinking.notice || thinking.effectiveLevel !== session.thinkingLevel)
			? {
					_meta: {
						[ACP_NOTICE_META_KEY]: {
							level: "info",
							text: thinking.notice || `Thinking ${session.thinkingLevel} runs as ${thinking.effectiveLevel} on this model.`,
						},
					},
				}
			: {}),
		options: (thinking?.supportedLevels ?? []).map((level) => ({
			value: level,
			name: thinking?.mechanism === "on-off" && level !== "off" ? "on" : level,
		})),
	});
	return optionsList;
};

export const listedLive = (status: ReturnType<ProvidersContract["list"]>[number] | null | undefined): boolean =>
	status !== null &&
	status !== undefined &&
	status.discoveredModels.length > 0 &&
	status.discoveredModelsSource !== "none" &&
	status.probeModelCapabilities !== null &&
	status.probeModelCapabilities !== undefined;

export const sessionConfig = (
	options: PancodeAcpServerOptions,
	listingFallbacks: Map<string, string>,
	session: AcpServerSession,
) => ({
	modes: modeState(options, session),
	configOptions: configOptions(options, listingFallbacks, session),
});

// ACP v1 has no models block, so the choices for a client that picks the model through
// `_pancode/session/set_model` rather than configOptions travel under `_meta`.
export const modelsResultMeta = (options: PancodeAcpServerOptions, session: AcpServerSession) =>
	session.model === null
		? {}
		: {
				[ACP_MODELS_META_KEY]: {
					currentModelId: session.model,
					availableModels: sessionModelChoices(options, session, session.model).map((model) => ({
						modelId: model,
						name: model,
					})),
				},
			};
