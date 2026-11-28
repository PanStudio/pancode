// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { CONTEXT_OPERATION_CUSTOM_TYPE, createContextOperation } from "../../core/context-operation.js";
import { formatCount } from "../../core/format-time.js";
import { runOverrides } from "../../core/run-overrides.js";
import { SMALL_WINDOW_TOKENS } from "../../domains/context/fold/pressure.js";
import { activePath, findLastEntry } from "../../domains/session/tree/active-path.js";
import { continueEngineWithoutInput } from "../../engine/agent.js";
import type { ChatLoop, ChatNoticeEvent } from "../chat-loop.js";
import { notConfiguredNotice } from "../chat-loop-messages.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { ChatLoopContextCommandsState } from "../turn-state.js";
import { type AgentRuntime, clearActiveInterrupt } from "../turn-state.js";
import { compactionFailureReason } from "./submit-fit.js";

/**
 * The operator's context commands between turns: recovering a stored handoff and `/context compact`. A
 * compaction already running refuses the next one.
 */
export function createChatLoopContextCommands(
	loop: ChatLoopScope,
	state: ChatLoopContextCommandsState,
): Pick<ChatLoop, "recoverHandoff" | "compact"> {
	const {
		context,
		continuity,
		deps,
		emit,
		endPreparationCompaction,
		enterPreparation,
		leavePreparation,
		prepareCompactionPaint,
		setTurnPreparation,
		turnRuntime,
	} = loop;
	/** An operator `/context compact` is between its start and its settled card. */
	let operatorCompactionRunning = false;
	return {
		async recoverHandoff(handoffId, action) {
			if (state.streaming || state.turnPreparation !== "idle")
				throw new Error("Wait for the current turn to settle before recovery.");
			const runtime = turnRuntime.ensureRuntime();
			if (!runtime) throw new Error("No native runtime is configured.");
			clearActiveInterrupt(state);
			if (!state.activeUserTurnId) {
				const operator = findLastEntry(
					activePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined),
					(entry) => entry.kind === "message" && entry.role === "user",
				);
				state.activeUserTurnId = operator?.turnId ?? null;
			}
			const operationSession = deps.session?.current()?.id ?? null;
			const operationCwd = process.cwd();
			const operation = createContextOperation(
				{
					kind: "context-recover",
					sessionId: operationSession,
					cwd: operationCwd,
					origin: "operator",
					reason: `handoff ${action}`,
				},
				(event) => {
					if (operationSession !== (deps.session?.current()?.id ?? null) || operationCwd !== process.cwd()) return;
					deps.bus?.emit("context.activity_changed", event);
					if (event.operation?.outcome && operationSession)
						deps.session?.appendEntry({
							kind: "custom",
							customType: CONTEXT_OPERATION_CUSTOM_TYPE,
							parentTurnId: state.lastTurnId,
							data: event.operation,
						});
				},
			);
			state.streaming = true;
			operation.start("state", "Recovering paused handoff");
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (
					state.activeInterruptReason ||
					operationSession !== (deps.session?.current()?.id ?? null) ||
					operationCwd !== process.cwd()
				)
					throw new DOMException("Handoff recovery cancelled", "AbortError");
				await continuity.recover(handoffId, action);
				await continueEngineWithoutInput(runtime.agent);
				operation.finish(state.activeInterruptReason ? "cancelled" : "completed", "Handoff recovery settled");
			} catch (error) {
				operation.finish(
					error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
					error instanceof Error ? error.message : String(error),
				);
				throw error;
			} finally {
				state.streaming = false;
				await continuity.pause();
			}
		},
		async compact(instructions?: string): Promise<void> {
			const reply = (text: string, level: ChatNoticeEvent["level"] = "info"): void =>
				emit({ type: "notice", level, surface: "transcript", text, commandReply: true });
			// Session check runs BEFORE orchestrator-configuration so a fresh
			// TUI with nothing configured still reports the actionable "no
			// current session" message rather than the "not configured"
			// banner.
			if (!deps.session?.current()) {
				reply("[/context compact] no current session to compact; start one with /new or /resume first");
				return;
			}
			let agentRuntime: AgentRuntime | null;
			try {
				await turnRuntime.ensureLiveCapabilitiesForSelectedModel();
				agentRuntime = turnRuntime.ensureRuntime({ silent: true });
			} catch (err) {
				reply(`[/context compact] ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			if (!agentRuntime) {
				reply(`[/context compact] ${notConfiguredNotice(deps.getSettings().chat)}`);
				return;
			}
			// A second request while one runs would join it and report the same ending twice, and drop its own instructions.
			if (operatorCompactionRunning) {
				reply(
					"[/context compact] a compaction is already running; its card reports how it ends. Run /context compact again after that if it is still needed.",
					"warning",
				);
				return;
			}
			operatorCompactionRunning = true;
			let compacted = false;
			const paintCompaction = prepareCompactionPaint();
			enterPreparation();
			setTurnPreparation("compacting");
			try {
				await paintCompaction();
				compacted = await context.runAutoCompact(agentRuntime, true, instructions, "force");
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					// A forced compaction skips every cheaper stage, so a stop before the summary saved left the context as it was.
					// Its card already says so with the size it stayed at; a notice beside it said the same thing twice.
					if (context.lastCompactionCardSettled()) return;
					const tokens = context.contextUsage().tokens;
					reply(
						`[/context compact] cancelled; context unchanged${tokens !== null ? ` at ${formatCount(tokens)} tokens` : ""}`,
					);
					return;
				}
				// A failed summary saved nothing either, and the operator needs that, the reason in words and the way on (HS14).
				const tokens = context.contextUsage().tokens;
				reply(
					`[/context compact] failed; context unchanged${tokens !== null ? ` at ${formatCount(tokens)} tokens` : ""}. ${compactionFailureReason(err)}. /context compact tries again; /model picks another route to summarize on.`,
					"error",
				);
				return;
			} finally {
				operatorCompactionRunning = false;
				leavePreparation();
				endPreparationCompaction();
			}
			if (!compacted && !context.lastCompactionWasNoGain()) {
				const entries = deps.readSessionEntries?.() ?? [];
				const hasMessages =
					entries.some((entry) => entry.kind === "message") || agentRuntime.agent.state.messages.length > 0;
				const usage = context.contextUsage();
				const used = usage.tokens !== null ? `${formatCount(usage.tokens)} tokens` : "unknown usage";
				const budget =
					usage.tokens !== null && usage.contextWindow > 0
						? `${formatCount(usage.tokens)} of ${formatCount(usage.contextWindow)} tokens used`
						: used;
				// Nothing was summarized, so instructions given for the summary went unused, and the operator should know (bt-11).
				const unused = instructions?.trim() ? ". Your compaction instructions were not used" : "";
				// A window this run capped small has no later turn that frees room, so the way on is a larger cap (memory-audit 13).
				const capped =
					usage.contextWindow > 0 &&
					usage.contextWindow < SMALL_WINDOW_TOKENS &&
					runOverrides().maxContextTokens === usage.contextWindow
						? `. This run's --max-context-tokens ${usage.contextWindow} leaves no older history to summarize; start again with a larger --max-context-tokens, or /new`
						: "";
				reply(
					hasMessages
						? `[/context compact] too short to compact (${budget}); every turn is still inside the kept recent window, so no older history can be summarized yet${capped}${unused}`
						: `[/context compact] session is empty; start a conversation first${unused}`,
				);
			}
		},
	};
}
