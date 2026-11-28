// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { SessionEntry } from "../../domains/session/entries.js";
import { protectedArtifactStateFromSessionEntries } from "../../domains/session/protected-artifacts.js";
import { replaceEngineMessages } from "../../engine/agent.js";
import type { AgentMessage } from "../../engine/types.js";
import { ensureDetailLedgerForSession } from "../../tools/extension-runtime-tools.js";
import type { ChatLoop, CreateChatLoopDeps } from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import { continuityRenderTime } from "../model-session-replay.js";
import type { ChatLoopSessionResetState } from "../turn-state.js";

/**
 * The session reset: listeners for it, and the reset itself for /new, /resume, /fork and a park, which settles
 * the running submit, clears the turn and replays the next session's messages.
 */
export function createChatLoopSessionReset(
	loop: ChatLoopScope,
	state: ChatLoopSessionResetState,
): Pick<ChatLoop, "onSessionReset" | "resetForSession"> {
	const {
		cancelTriage,
		context,
		continuity,
		deps,
		eggs,
		middleware,
		middlewareToolChoice,
		outcomeCollector,
		prepareNextRequest,
		prewarm,
		queues,
		recovery,
		sessionResetListeners,
		stepStarts,
		turnRuntime,
	} = loop;
	return {
		onSessionReset(handler): () => void {
			sessionResetListeners.add(handler);
			return () => {
				sessionResetListeners.delete(handler);
			};
		},

		resetForSession(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void {
			loop.submitOwner?.abort();
			loop.submitGeneration += 1;
			// An interview another session or branch closed never answers this one's continuations (C-25).
			loop.promptInterview = undefined;
			turnRuntime.cancelRunWatchdog();
			loop.sessionResetSettlement = loop.activeSubmit;
			state.streaming = false;
			loop.pendingPreTurnRead?.abort();
			context.cancelCompaction();
			for (const listener of sessionResetListeners) {
				try {
					listener();
				} catch {
					// A host observer must not interrupt canonical replay and state cleanup.
				}
			}
			// Local shell completion and tree navigation also refresh the same transcript.
			eggs.syncConversation();
			loop.operatorTurnsBefore = null;
			loop.lastHistoricalImageNoticeKey = null;
			loop.pendingVisionSidecar?.abort();
			loop.pendingCompactionPaint?.abort();
			continuity.cancel();
			void continuity.pause();
			state.currentTurnConstraints = loop.sessionToolLimits;
			// The leaf being left is still `state.lastTurnId`; a navigation clears the chain there.
			stepStarts.reset({ sessionId: deps.session?.current()?.id ?? null, leafTurnId: state.lastTurnId }, leafTurnId);
			state.activeSkillSurface = undefined;
			state.currentPendingSkillPolicy = undefined;
			if (state.runtime) {
				state.runtime.agent.abort();
				(state.runtime.agent as { clearAllQueues?: () => void } | undefined)?.clearAllQueues?.();
				turnRuntime.cleanupSessionResources(state.runtime.agent.sessionId);
			}
			recovery.cancelRetryCountdown();
			cancelTriage();
			const sessionId = loop.api.getSessionId();
			if (deps.toolRegistry) ensureDetailLedgerForSession(deps.toolRegistry, sessionId);
			queues.reset({ keepOperator: sessionId !== null && sessionId === loop.queueSessionId });
			loop.queueSessionId = sessionId;
			middleware.clearPendingReminders();
			// The turn the reset cut off never reaches its turn_end hook: what its requests carried settles with it now.
			outcomeCollector.closeSession();
			middlewareToolChoice.reset();
			state.lastTurnId = leafTurnId;
			state.lastRunSnapshot = null;
			// In place before the context resets, so it republishes on the history of the leaf arrived at.
			state.replayedContextMessages = replayMessages ? [...replayMessages] : [];
			state.continuityAtMs = continuityRenderTime(replayMessages) ?? null;
			if (state.runtime) replaceEngineMessages(state.runtime.agent, [...state.replayedContextMessages]);
			// The incoming leaf is the advisory branch identity for the new session.
			// Ordinary appends advance `state.lastTurnId` from here without re-arming
			// an advisory; arriving here at all is the navigation that does.
			context.resetForSession(leafTurnId);
			loop.nextRequestNavigation += 1;
			loop.nextRequestPrepared =
				replayMessages && replayMessages.length > 0 ? prepareNextRequest(loop.nextRequestNavigation) : Promise.resolve();
			// The resumed ledger renders before the first new turn (issue #189),
			// and the window it renders against should be the probed one rather
			// than the catalog's, so the live capability probe the first submit
			// would run runs now, under the same TTL; the footer refreshes on the
			// provider-health event the probe publishes.
			void turnRuntime.ensureLiveCapabilitiesForSelectedModel().catch(() => {});
			if (deps.protectedArtifacts) {
				reloadProtectedArtifactsForSession(deps.protectedArtifacts, deps.readSessionEntries);
			}
			// A resume replays a history the backend has never seen; a fresh session
			// replays nothing but still compiles a prompt and a tool surface. Both
			// leave a prefix the next turn will pay for unless it is sent now.
			prewarm.schedule(replayMessages && replayMessages.length > 0 ? "resume" : "session-start");
		},
	};
}

function reloadProtectedArtifactsForSession(
	protectedArtifacts: NonNullable<CreateChatLoopDeps["protectedArtifacts"]>,
	readSessionEntries: (() => ReadonlyArray<SessionEntry>) | undefined,
): void {
	try {
		const entries = readSessionEntries ? readSessionEntries() : [];
		protectedArtifacts.replace(protectedArtifactStateFromSessionEntries(entries));
	} catch (error) {
		protectedArtifacts.markDegraded(
			`session protection history could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
