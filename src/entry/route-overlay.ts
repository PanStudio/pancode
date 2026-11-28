// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../core/config.js";
import type { BootOptions } from "./boot-options.js";

/**
 * Settings as a session started with `--connection`/`--model` (and `run`'s
 * `--thinking`/`--autonomy`) sees them. The caller's copy is untouched, so
 * settings.yaml never learns the session's route.
 */
export function applyRouteOverlay(
	settings: PancodeSettings,
	overrides: Pick<NonNullable<BootOptions["headless"]>, "target" | "model" | "thinking" | "autonomy"> | undefined,
): PancodeSettings {
	const next = structuredClone(settings);
	if (!overrides) return next;
	const previousTarget = next.chat.connection;
	if (overrides.target !== undefined) {
		next.chat.connection = overrides.target;
		if (overrides.model === undefined && (previousTarget !== overrides.target || !next.chat.model)) {
			const target = next.connections.find((entry) => entry.id === overrides.target);
			if (target) next.chat.model = target.defaultModel ?? null;
		}
	}
	if (overrides.model !== undefined) next.chat.model = overrides.model;
	if (overrides.thinking !== undefined) next.chat.thinkingLevel = overrides.thinking;
	if (overrides.autonomy !== undefined) next.safety.autonomy = overrides.autonomy;
	return next;
}
