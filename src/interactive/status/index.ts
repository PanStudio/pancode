// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export type {
	AgentStatus,
	TurnStopReason,
	TurnSummary,
} from "../../session-control/status-types.js";
export type { StatusController } from "./controller.js";
export { createStatusController } from "./controller.js";
export {
	type ReasoningUsageView,
	UNMEASURED_REASONING,
} from "./reasoning.js";
export {
	humanWaitTotalMs,
	reduceStatus,
	type StatusInputEvent,
} from "./state-machine.js";
export {
	buildSummary,
	isGenerationGuardAbort,
} from "./summary.js";
export {
	resolveFooterVerb,
	retryCountLabel,
	spinnerFrame,
} from "./verbs.js";
export { computeWatchdogTier } from "./watchdog.js";
