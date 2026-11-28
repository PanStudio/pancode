// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { firstChangedSection } from "../../core/cache-telemetry.js";
import { activePath } from "../../domains/session/tree/active-path.js";
import { appendEnginePolicyMessage, engineInitialSystemPrompt } from "../../engine/agent.js";
import { effectivePosture, POSTURE_GENERATION, POSTURE_UPDATE } from "../posture-policy.js";
import type { TurnContext } from "../turn-context.js";
import type { AgentRuntime } from "../turn-state.js";
import type { TurnContextScope } from "./scope.js";
import { createTurnContextSessionPrompt } from "./session-prompt.js";

/**
 * Session prompt assembly for one turn context: compiling and pinning the session prompt with its memory section,
 * committing the session posture, and logging the prompt compile.
 */
export function createTurnContextPrompt(
	shared: TurnContextScope,
): Required<
	Pick<
		TurnContext,
		"sessionPromptPending" | "ensureSessionPrompt" | "commitSessionPosture" | "logPromptCompileIfPending"
	>
> {
	const { deps, noteColdReason, state } = shared;

	const ensureSessionPrompt = createTurnContextSessionPrompt(shared);
	return {
		sessionPromptPending(agentRuntime: AgentRuntime): boolean {
			// The automatic pass's own guard: only history it could shrink makes the prompt it prices matter.
			if (!deps.readSessionEntries || (deps.session && !deps.session.current())) return false;
			return engineInitialSystemPrompt(agentRuntime.agent) !== shared.sessionPrompt?.systemPrompt;
		},
		ensureSessionPrompt,
		commitSessionPosture(agentRuntime, userTurnId): void {
			const pending = shared.pendingPosture;
			shared.pendingPosture = null;
			if (!pending || !shared.postureGeneration || !deps.session?.current() || !deps.prompts?.renderSessionPostureUpdate)
				return;
			const autonomy = deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy ?? "default";
			const entries = activePath(deps.readSessionEntries?.() ?? [], userTurnId);
			if (effectivePosture(entries, shared.postureGeneration) === autonomy) return;
			const text = deps.prompts.renderSessionPostureUpdate(autonomy, pending.inputs);
			const entry = deps.session.appendEntry({
				kind: "custom",
				customType: POSTURE_UPDATE,
				parentTurnId: userTurnId,
				data: { version: 1, origin: "host", generationId: shared.postureGeneration.id, userTurnId, autonomy, text },
			});
			deps.session.flushAppends?.();
			appendEnginePolicyMessage(agentRuntime.agent, entry.turnId, text, Date.parse(entry.timestamp));
		},
		/**
		 * Write the queued prompt-compile ledger entry and its full manifest
		 * record. The journal captures the structure when the request cites it (#434).
		 * Deferred until after the user turn is appended so the session exists.
		 */
		logPromptCompileIfPending(): void {
			const currentMeta = deps.session?.current();
			if (currentMeta && shared.postureGeneration && !shared.postureGenerationPersisted) {
				deps.session?.appendEntry({
					kind: "custom",
					customType: POSTURE_GENERATION,
					parentTurnId: state.lastTurnId,
					data: shared.postureGeneration,
				});
				deps.session?.flushAppends?.();
				shared.postureGenerationPersisted = true;
			}
			if (!shared.pendingPromptLogEntry || !currentMeta) return;
			const entry = shared.pendingPromptLogEntry;
			shared.pendingPromptLogEntry = null;
			try {
				deps.session?.appendEntry({
					kind: "custom",
					customType: "promptRecompiled",
					parentTurnId: state.lastTurnId,
					data: {
						previousHash: entry.previousHash,
						hash: entry.systemPromptHash,
						tokenEstimate: entry.tokenEstimate,
						...(shared.pendingPromptLogMemory === null ? {} : { memorySection: shared.pendingPromptLogMemory }),
					},
				});
				// A resumed process names the session's last recorded hash as previousHash (#249), so
				// the stamp requires the hash to have moved, not merely to have a predecessor.
				if (entry.previousHash !== null && entry.previousHash !== entry.systemPromptHash) {
					noteColdReason("prompt_recompiled");
					if (shared.previousPromptSections) {
						shared.nextChangedSection ??= firstChangedSection(shared.previousPromptSections, entry.sections);
					}
				}
			} catch {
				// Ledger logging is diagnostics, not control flow; never abort a turn.
			}
			shared.previousPromptSections = entry.sections;
		},
	};
}
