// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Wire model ids the operator's configuration references, each with the role it serves. The residency layer
 * (src/engine/apis/residency.ts) protects them from eviction by any other PanCode stream, in the orchestrator and,
 * through each WorkerSpec, in workers. The role travels with the id so an eviction notice names the plane it stops.
 */

import type { PancodeSettings } from "./config.js";

/**
 * Which plane of the operator's configuration references a model:
 *   - `chat`: the orchestrator model, the one the interactive session talks to.
 *   - `memory`: the background plane for proactive task memory.
 *   - `worker`: the worker default or one of the worker profiles.
 *   - `target-default`: a target's `defaultModel`, the fallback any session picks up.
 */
export type ResidencyRole = "chat" | "memory" | "worker" | "target-default";

export interface ProtectedModelRef {
	modelId: string;
	role: ResidencyRole;
}

/**
 * Configured model ids with their roles. The first role that claims an id wins,
 * ordered chat > memory > worker > target-default, so a model serving both the
 * chat plane and a target default is reported by the more specific role.
 */
export function protectedResidencyModels(settings: PancodeSettings): ProtectedModelRef[] {
	const byId = new Map<string, ResidencyRole>();
	const add = (id: string | null | undefined, role: ResidencyRole): void => {
		const trimmed = id?.trim();
		if (!trimmed || byId.has(trimmed)) return;
		byId.set(trimmed, role);
	};
	add(settings.chat.model, "chat");
	add(settings.context.memory.model, "memory");
	add(settings.fleet.default.model, "worker");
	for (const profile of Object.values(settings.fleet.profiles ?? {})) add(profile.model, "worker");
	for (const target of settings.targets) add(target.defaultModel, "target-default");
	return [...byId].map(([modelId, role]) => ({ modelId, role }));
}
