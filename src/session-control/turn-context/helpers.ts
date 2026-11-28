import { isHostPolicyMessage } from "../../core/host-policy-message.js";
import type { LiveBudgetBreakdown } from "../../domains/context/budget/live-view.js";
import type { ContextWindowSource } from "../../domains/providers/index.js";
import type { ContextSnapshot } from "../../domains/session/context-accounting.js";
import type { EvictionAnchor } from "../../domains/session/entries.js";
import type { AgentMessage } from "../../engine/types.js";
import type { ExpectedColdReason } from "../turn-context.js";
import type { AgentRuntime } from "../turn-state.js";

export const memoryOrigin = (runtime: AgentRuntime): string =>
	JSON.stringify([process.cwd(), runtime.targetId, runtime.runtimeId, runtime.wireModelId]);

// #423: prefix-byte and reasoning changes can cool every tier. Residency,
// dispatch traffic, and compaction retain the local-native disturbance gate.
export const TIER_INDEPENDENT_COLD_REASONS: ReadonlySet<ExpectedColdReason> = new Set([
	"working_set_evict",
	"observation_aging",
	"thinking_change",
	"model_changed",
	"input_changed",
	"tool_choice_change",
	"tool_surface_change",
	"prompt_recompiled",
	"system_prompt_changed",
	// The step checkpoint rewrites the history the prefix carried, on every tier.
	"step_checkpoint",
]);

const CONTEXT_WINDOW_SOURCES: ReadonlySet<string> = new Set<ContextWindowSource>([
	"catalog",
	"probe",
	"loaded",
	"target-override",
	"model-hint",
	"descriptor-default",
	"unknown",
]);

/** The snapshot stores its source as a plain string; only a known label is worth repeating. */
export const snapshotWindowSource = (snapshot: ContextSnapshot): ContextWindowSource | null =>
	CONTEXT_WINDOW_SOURCES.has(snapshot.contextWindowSource)
		? (snapshot.contextWindowSource as ContextWindowSource)
		: null;

export const anchorModelKey = (agentRuntime: AgentRuntime): string => {
	const model = agentRuntime.agent.state.model;
	return JSON.stringify([model?.id, model?.provider, model?.api, model?.baseUrl]);
};

export const sameRoute = (agentRuntime: AgentRuntime, route: EvictionAnchor["route"]): boolean =>
	route.targetId === agentRuntime.targetId &&
	route.runtimeId === agentRuntime.runtimeId &&
	route.wireModelId === agentRuntime.wireModelId &&
	route.modelKey === anchorModelKey(agentRuntime);

/**
 * A captured decomposition, labelled as one. The mapping is the same the
 * `/context` overlay already uses, so the two cannot disagree; it is not a
 * fresh measurement of the live agent state and is never presented as one.
 */
export const capturedBreakdown = (snapshot: ContextSnapshot, pendingTokens: number): LiveBudgetBreakdown => ({
	systemPromptTokens: snapshot.categories.system,
	messageTokens: snapshot.categories.messages + (snapshot.categories.toolResults ?? 0),
	pendingUserTokens: pendingTokens,
	toolSchemaTokens: snapshot.categories.tools,
});

export const optionalProjection = <T>(read: (() => T | null) | undefined): T | null => {
	if (!read) return null;
	try {
		return read();
	} catch {
		// A continuity projection is supplemental. Losing it must not stop the
		// budget from being published.
		return null;
	}
};

/**
 * A working-set projection removes tokens from messages the attestation
 * covered; it does not make the attestation wrong about the rest. Subtract
 * what the planner priced out against the same projection and re-anchor on
 * the refreshed list, instead of discarding the figure and falling back to
 * pure chars/4 exactly when the accounting matters most (issue #227).
 * Materialize history before rebuilding the list; otherwise advancing the
 * anchor would lose tool results appended since the last measured call.
 * Static baselines stay tied to that call until the next reconciliation.
 */
export const carriedTokens = (historyTokens: number, tokensRemoved: number): number =>
	Math.max(0, historyTokens - Math.max(0, tokensRemoved));

export const toolResultTail = (agentRuntime: AgentRuntime): boolean => {
	const messages = agentRuntime.agent.state.messages.filter(
		(message) => message.role !== "system" || isHostPolicyMessage(message),
	);
	const tail = messages[messages.length - 1] as AgentMessage | undefined;
	return !!tail && typeof tail === "object" && tail !== null && "role" in tail && tail.role === "toolResult";
};

export const continuationContextUpdate = (agentRuntime: AgentRuntime) => ({
	context: {
		messages: [...agentRuntime.agent.state.messages],
		tools: [...agentRuntime.agent.state.tools],
	},
	model: agentRuntime.agent.state.model,
	thinkingLevel: agentRuntime.agent.state.thinkingLevel,
});

export const tokenCount = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

/**
 * The error name of the post-tool guard's clean stops: one tool result alone still overflows after compaction, the
 * compacted request with its tool results still does not fit the window, or the compaction a fit needed failed. Pi keeps only the message, so the turn runtime reads the name off the throw to journal the harness's own cause.
 */
export const OVERSIZED_RESULT_STOP = "PancodeOversizedResultStop";

export const oversizedResultStop = (message: string): Error =>
	Object.assign(new Error(message), { name: OVERSIZED_RESULT_STOP });
