// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { rememberRecentModel } from "../core/recent-models.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { isOrchestratorEligibleRuntime } from "../domains/providers/eligibility.js";
import { resolveModelRuntimeCapabilitiesForProviders } from "../domains/providers/model-runtime-capabilities.js";
import { runtimeNotRegistered } from "../domains/providers/runtime-not-registered.js";
import type { ThinkingLevel } from "../domains/providers/types/capability-flags.js";

export function clampThinkingLevel(
	providers: ProvidersContract | undefined,
	target: string | null,
	model: string | null,
	level: ThinkingLevel,
): ThinkingLevel {
	if (providers === undefined) return level;
	return resolveModelRuntimeCapabilitiesForProviders(providers, target, model, level)?.thinking.effectiveLevel ?? "off";
}

export function selectModel(
	providers: ProvidersContract,
	selection: { target: string; model: string; thinkingLevel: ThinkingLevel },
	apply: (selection: { target: string; model: string; thinkingLevel: ThinkingLevel }) => void,
	recentLimit?: number,
): { target: string; model: string; thinkingLevel: ThinkingLevel } {
	const descriptor = providers.getTarget(selection.target);
	if (!descriptor) throw new Error(`unknown orchestrator connection '${selection.target}'`);
	const runtime = providers.getRuntime(descriptor.runtime);
	if (!runtime)
		throw new Error(
			`cannot use connection '${selection.target}' as orchestrator connection because ${runtimeNotRegistered(descriptor.runtime)}`,
		);
	if (!isOrchestratorEligibleRuntime(runtime))
		throw new Error(
			`cannot use connection '${selection.target}' as orchestrator connection because runtime '${runtime.id}' is not an HTTP/native runtime`,
		);
	// The setting keeps what the operator asked for, and each request resolves what the model does with it. Saving
	// the clamped level left thinking off for good after one stop on a model that has none.
	apply(selection);
	if (recentLimit !== undefined) rememberRecentModel(`${selection.target}/${selection.model}`, recentLimit);
	return {
		...selection,
		thinkingLevel: clampThinkingLevel(providers, selection.target, selection.model, selection.thinkingLevel),
	};
}
