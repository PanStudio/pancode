// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

/**
 * Target eligibility covers runtimes PanCode can drive from at least one target
 * surface. HTTP runtimes remain the only orchestrator/print runtimes; the
 * Claude Code subscription runtimes are worker-dispatch targets with their own
 * worker runners.
 */
export function isTargetEligibleRuntime(runtime: RuntimeDescriptor): boolean {
	return (
		runtime.kind === "http" ||
		runtime.id === "claude-sdk" ||
		runtime.id === "claude-code" ||
		runtime.id === "codex-cli" ||
		runtime.id === "opencode-cli" ||
		runtime.id === "pi-cli" ||
		runtime.id === "antigravity-code"
	);
}

export function isOrchestratorEligibleRuntime(runtime: RuntimeDescriptor): boolean {
	return runtime.kind === "http";
}
