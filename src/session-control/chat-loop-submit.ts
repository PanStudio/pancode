// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { commitSubmittedTurn } from "./chat-loop/submit-commit.js";
import { fitSubmittedTurn } from "./chat-loop/submit-fit.js";
import { prepareSubmittedTurn } from "./chat-loop/submit-prepare.js";
import { runSubmittedTurn } from "./chat-loop/submit-run.js";
import { settleSubmittedTurn } from "./chat-loop/submit-settle.js";
import { submitWhileStreaming } from "./chat-loop/submit-streaming.js";
import type { SubmitTurn } from "./chat-loop/submit-turn.js";
import type { ChatLoop, ChatSubmitOptions } from "./chat-loop.js";
import type { ChatLoopScope } from "./chat-loop-scope.js";
import type { ChatLoopSubmitState } from "./turn-state.js";
import { isWorkerShareNote } from "./worker-share.js";

/** The chat loop's `submit`: runs one submitted turn from admission to settlement. */
export function createChatLoopSubmit(loop: ChatLoopScope, state: ChatLoopSubmitState): ChatLoop["submit"] {
	const { deps, messagePath, middleware, operatorMemory, queues } = loop;
	return async function submit(text: string, options: ChatSubmitOptions = {}): Promise<void> {
		let owner: AbortController | null = null;
		// Until the prompt runs there is no foreground stream to release.
		const turn: SubmitTurn = { promptStarted: false, releaseForeground: () => {}, turnLease: undefined };
		const generation = loop.submitGeneration;
		const admissionCurrent = (): boolean =>
			!loop.disposed &&
			generation === loop.submitGeneration &&
			!owner?.signal.aborted &&
			options.isAdmissionCurrent?.() !== false;
		const returnUnstarted = (): void => {
			if (options.queued === undefined || turn.promptStarted || loop.disposed) return;
			if (generation === loop.submitGeneration) queues.requeueUnstarted(options.queued);
			else queues.reportDropped([options.queued]);
		};
		if (!admissionCurrent()) {
			returnUnstarted();
			return;
		}
		const submittedAt = performance.now();
		const submittedWallAt = Date.now();
		const continuedMessage = options.queued ?? options.continuesMessage;
		// Memory hot keywords read only words the operator typed: never a continuation, a machine or peer turn, a
		// queued resubmit (read when it was first submitted), a worker's shared answer, or file and skill bodies
		// an expansion inlined without keeping the typed line.
		const typedWords =
			options.origin !== undefined ||
			options.machineTurn !== undefined ||
			options.requestContinuation === true ||
			options.yoloContinuation === true ||
			continuedMessage !== undefined ||
			isWorkerShareNote(text)
				? null
				: (options.display?.text ??
					((options.workingContextPaths?.length ?? 0) + (options.pendingSkillRequests?.length ?? 0) > 0 ? null : text));
		const memoryCapture = typedWords === null ? null : operatorMemory.handleTyped(typedWords);
		if (memoryCapture !== null) {
			const { captureOnly } = await memoryCapture;
			if (captureOnly) {
				// The statement was the whole submission: it is stored, and no model turn follows.
				options.onAdmitted?.();
				return;
			}
			if (!admissionCurrent()) {
				returnUnstarted();
				return;
			}
		}
		let interrupted = false;
		if (state.streaming) {
			interrupted = await submitWhileStreaming(loop, state, {
				options,
				text,
				continuedMessage,
				admissionCurrent,
				returnUnstarted,
			});
			if (!interrupted) return;
		}

		if (deps.autonomy !== undefined) {
			// A turn PanCode sends itself waits while yolo is paused; the operator's own prompt reopens the window.
			const ownTurn =
				options.requestContinuation === true ||
				options.yoloContinuation === true ||
				options.machineTurn !== undefined ||
				options.origin !== undefined;
			if (!ownTurn) deps.autonomy.operatorSpoke();
			else if (deps.autonomy.halted() !== null) {
				returnUnstarted();
				return;
			}
		}

		owner = new AbortController();
		loop.submitOwner?.abort();
		loop.submitOwner = owner;
		if (options.flushQueue === true) queues.flushOnNextPrompt();
		// A continuation or a machine turn is PanCode's own and no message anyone sent.
		const pathMessage =
			options.requestContinuation === true || options.yoloContinuation === true || options.machineTurn !== undefined
				? null
				: {
						id: continuedMessage?.id ?? `prompt_${randomUUID().slice(0, 8)}`,
						submittedAt: continuedMessage?.enqueuedAt ?? submittedWallAt,
					};
		if (pathMessage && !continuedMessage)
			messagePath.submitted(pathMessage, {
				chars: text.length,
				by: options.origin === undefined ? "operator" : "machine",
				wallMs: submittedWallAt,
				mono: submittedAt,
			});
		/**
		 * What this submit holds for its requests (the taken buffer, an armed tool choice, a flushed continuation, the
		 * awaited gate's effects); a return before a request carries them suppresses their firings.
		 */
		const turnHolds = middleware.beginTurnHolds();
		try {
			const prepared = await prepareSubmittedTurn(loop, state, turn, {
				options,
				text,
				owner,
				generation,
				admissionCurrent,
				submittedAt,
			});
			if (prepared === null) return;
			const {
				previousRunSnapshot,
				previousThinkingLevel,
				previousModel,
				agentRuntime,
				reservedUserTurnId,
				operatorText,
				images,
				referencedPaths,
				turnControlRecord,
				pendingSkillPolicy,
				skillsLoadedBeforeTurn,
				toolSignature,
				askUserPolicy,
				composeSubmittedText,
			} = prepared;
			let { submittedText } = prepared;

			const fitted = await fitSubmittedTurn(loop, {
				options,
				owner,
				generation,
				admissionCurrent,
				submittedAt,
				agentRuntime,
				reservedUserTurnId,
				images,
				turnControlRecord,
				pendingSkillPolicy,
				toolSignature,
				composeSubmittedText,
				submittedText,
			});
			if (fitted === null) return;
			submittedText = fitted.submittedText;
			const { compiledPrompt, turnSnapshot } = fitted;

			const committed = await commitSubmittedTurn(loop, state, turn, {
				options,
				admissionCurrent,
				agentRuntime,
				interrupted,
				previousRunSnapshot,
				previousThinkingLevel,
				previousModel,
				reservedUserTurnId,
				operatorText,
				referencedPaths,
				turnControlRecord,
				pendingSkillPolicy,
				toolSignature,
				askUserPolicy,
				submittedText,
				compiledPrompt,
				turnSnapshot,
			});
			if (committed === null) return;
			const { userTurnId, turnIndex, runtimePromptText, evidence, priorPendingSkillPolicy, priorAskUserPolicy } =
				committed;
			try {
				await runSubmittedTurn(loop, state, turn, {
					options,
					admissionCurrent,
					pathMessage,
					agentRuntime,
					userTurnId,
					runtimePromptText,
					images,
				});
			} finally {
				const superseded = await settleSubmittedTurn(loop, state, turn, {
					options,
					owner,
					generation,
					admissionCurrent,
					submittedAt,
					agentRuntime,
					askUserPolicy,
					userTurnId,
					turnIndex,
					priorPendingSkillPolicy,
					priorAskUserPolicy,
					pendingSkillPolicy,
					skillsLoadedBeforeTurn,
					evidence,
				});
				// biome-ignore lint/correctness/noUnsafeFinally: a superseded submit must not settle into the new generation; its error belongs to a turn nobody owns now.
				if (superseded) return;
			}
		} finally {
			// Settlements land before the lease release flushes, and possibly seals, the session's journal.
			middleware.releaseTurnHolds(turnHolds);
			await turn.turnLease?.release();
			returnUnstarted();
			if (pathMessage && !turn.promptStarted && options.queued === undefined) messagePath.neverStarted(pathMessage);
			if (loop.submitOwner === owner) {
				loop.submitOwner = null;
				// Template bounds end with their turn; prewarm and jobs see only
				// the host's remaining prompt or session ceiling (#423).
				state.currentTurnConstraints = loop.promptToolLimits;
				if (!loop.disposed) queues.settleSubmit(turn.promptStarted);
			}
		}
	};
}
