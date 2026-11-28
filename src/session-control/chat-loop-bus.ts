// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ChatLoopScope } from "./chat-loop-scope.js";
import { createStepPipeline, createStepStartTracker, sessionStepChainStore } from "./step-start.js";
import type { ChatLoopBusState } from "./turn-state.js";

/** The chat loop's bus subscriptions and the step pipeline they feed. */
export function createChatLoopBus(loop: ChatLoopScope, state: ChatLoopBusState) {
	const { context, deps, requestBudgetRoll, turnRuntime } = loop;

	// --- bus subscriptions --------------------------------------------------

	// A config hot-reload may change prompt fragments or settings that feed
	// the session prompt; invalidate so the next submit recompiles. If the
	// recompiled text is byte-identical, nothing changes and no ledger entry
	// is written.
	const unsubscribeConfigReload =
		deps.bus?.subscribe("config.hot_reloaded", () => {
			context.invalidateSessionPromptCache();
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
		}) ?? null;
	const unsubscribeConfigNextTurn =
		deps.bus?.subscribe("config.next_turn_scheduled", (payload) => {
			if (
				!payload.diff.nextTurn.some(
					(path) => path === "chat" || path.startsWith("chat.") || path === "connections" || path.startsWith("connections."),
				)
			)
				return;
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
		}) ?? null;
	const unsubscribePluginsReload =
		deps.bus?.subscribe("plugin.reloaded", () => {
			context.invalidateSessionPromptCache();
		}) ?? null;
	const unsubscribeSynthesisLock =
		deps.bus?.subscribe("safety.loop_blocked", (payload) => {
			const event = payload as { disposition?: unknown; tool?: unknown; priorFailure?: unknown } | null;
			if (event?.disposition === "lockout") state.synthesisToolLock = true;
			if (
				(event?.disposition === "lockout" || event?.disposition === "stop") &&
				typeof event.tool === "string" &&
				typeof event.priorFailure === "string"
			) {
				loop.loopGuardFailure = { tool: event.tool, failure: event.priorFailure };
			}
		}) ?? null;
	/** Step turns after the first start from a compact state on small or uncached routes (WTF-P 0.8.3 C5). */
	const stepStarts = createStepStartTracker(sessionStepChainStore(deps.session, deps.readSessionEntries));
	const stepPipeline = createStepPipeline();
	const unsubscribeToolBudgetLock =
		deps.bus?.subscribe("safety.tool_budget_exceeded", (payload) => {
			state.toolBudgetLock = true;
			if (payload?.rolled === true) requestBudgetRoll("calls");
			if (typeof payload?.stepTool === "string")
				loop.stepPolicyStop = typeof payload.template === "string" ? { template: payload.template } : {};
		}) ?? null;
	return {
		stepPipeline,
		stepStarts,
		unsubscribeConfigNextTurn,
		unsubscribeConfigReload,
		unsubscribePluginsReload,
		unsubscribeSynthesisLock,
		unsubscribeToolBudgetLock,
	};
}
