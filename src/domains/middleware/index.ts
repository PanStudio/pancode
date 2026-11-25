// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export { HOOK_BUDGET_STALL_FACTOR } from "./budget.js";
export type { MiddlewareContract, MiddlewareHost, MiddlewareRegistrar } from "./contract.js";
export {
	batchesCollectedElsewhere,
	collectedElsewhereLine,
	type DetachedBatchNudgeView,
	openDetachedBatchViews,
} from "./dispatch-nudge.js";
export { createMiddlewareBundle, createMiddlewareDomain } from "./extension.js";
export { dialectToolNames, isUserHookDialect, type UserHookDialect } from "./hook-dialect.js";
export type { HookReceipt, HookReceiptSink, UserHookCommandRunner, UserHookOrigin } from "./hooks.js";
export { loadUserHooks, USER_HOOK_COMMAND_TIMEOUT_MAX_MS } from "./hooks.js";
export {
	type BuildUserHookRegistrationsResult,
	buildUserHookRegistrations,
	type CapturedHookSourceSet,
	USER_HOOKS_FILENAME,
} from "./hooks-io.js";
export { createMarketplaceOfferRegistration } from "./marketplace-offer.js";
export {
	createReadStreakRegistration,
	READ_STREAK_GATE_EVIDENCE,
	READ_STREAK_REGISTRATION_ID,
	READ_STREAK_SERIAL_EVIDENCE,
	type ReadStreakObserver,
	type ReadStreakStep,
} from "./read-streak.js";
export type {
	MiddlewareRegistrationConflict,
	MiddlewareRegistrationReplacement,
	PrepareRegistrationReplacementResult,
} from "./registrations.js";
export type { MiddlewareDiagnostic, MiddlewareHookRegistration } from "./runtime.js";
export { formatRegistrationConflict, writeMiddlewareDiagnosticToStderr } from "./runtime.js";
export { createExplorationNudgeRegistrations, SCOUT_NUDGE_REGISTRATION_ID } from "./scout-nudge.js";
export { createSkillsReminderRegistration } from "./skills-reminder.js";
export { createMiddlewareHostFromSnapshot } from "./snapshot.js";
export { createMiddlewareToolChoiceControl, type MiddlewareToolChoiceControl } from "./tool-choice-control.js";
export { createTurnPlanCueRegistration } from "./turn-plan-cue.js";
export type {
	CompletionFact,
	MiddlewareEffect,
	MiddlewareEffectKind,
	MiddlewareHook,
	MiddlewareHookInput,
	MiddlewareHookResult,
	MiddlewareMetadataValue,
	MiddlewareReminderSeverity,
	MiddlewareSnapshot,
	ToolCallDispatchRole,
	ToolCallDispatchTask,
	ToolCallLanding,
} from "./types.js";
export { MIDDLEWARE_HOOK_TEXT_MAX_CHARS, turnCanCallTool } from "./types.js";
export { WATCHDOG_TASK, type WatchdogTrigger, watchdogBriefing } from "./watchdog.js";
