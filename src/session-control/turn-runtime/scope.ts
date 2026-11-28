// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The shared state of one turn runtime.
 *
 * createTurnRuntime builds one scope per chat loop and hands it to the turn-runtime modules. A module reads every
 * value it does not own as `rt.x` at the use site, so a read sees the same value at the same moment the closure it
 * came from did. Mutable runtime state lives here as plain fields; functions the runtime defines later are getters
 * over its own bindings.
 */

import type { TurnRuntime, TurnRuntimeDeps } from "../turn-runtime-types.js";

export interface TurnRuntimeScope {
	readonly deps: TurnRuntimeDeps;
	readonly state: TurnRuntimeDeps["state"];
	readonly context: TurnRuntimeDeps["context"];
	readonly persistence: TurnRuntimeDeps["persistence"];
	disposed: boolean;
	/** The last probe's word on the selected model when it was not serving, until the target answers a request on it. */
	coldAtProbe: { targetId: string; modelId: string; state: "absent" | "loading" } | null;
	// A target id/model names the selection, not its current URL, auth, pricing
	// or cache policy. Keep the constructed descriptor identity across calls.
	runtimeTargetSettings: string | null;
	readonly cleanupSessionResources: TurnRuntime["cleanupSessionResources"];
	readonly ensureRuntime: TurnRuntime["ensureRuntime"];
}
