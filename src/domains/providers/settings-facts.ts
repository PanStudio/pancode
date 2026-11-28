// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { SettingsRuntimeFacts } from "../../core/settings-controls.js";
import { isOrchestratorEligibleRuntime } from "./eligibility.js";
import { getRuntimeRegistry } from "./registry.js";
import { findBuiltinRuntimeBootMetadata } from "./runtimes/boot-manifest.js";

/** The runtime facts the settings editors check, read from the live registry and the built-in boot manifest. */
export function settingsRuntimeFacts(): SettingsRuntimeFacts {
	return {
		localNative: (runtimeId) =>
			(getRuntimeRegistry().get(runtimeId) ?? findBuiltinRuntimeBootMetadata(runtimeId))?.tier === "local-native",
		workerOnly: (runtimeId) => {
			const runtime = getRuntimeRegistry().get(runtimeId);
			return runtime !== null && !isOrchestratorEligibleRuntime(runtime);
		},
	};
}
