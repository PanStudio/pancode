// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { engineLiveTurnRequest } from "../../engine/agent.js";
import type {
	ChatLoop,
	DraftCandidate,
	DraftOptions,
	DraftOutcome,
	HandoffRoundOptions,
	SideQuestionOptions,
	SideQuestionOutcome,
} from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import {
	DRAFT_MAX_TOKENS,
	DRAFT_TEMPERATURES,
	draftCandidateFromText,
	draftTemperature,
	runDraftWithSamplerFallback,
} from "../drafts.js";
import { runHandoffRound } from "../handoff-round.js";
import { runOutOfTurnRound, type SideQuestionResult } from "../side-question.js";

/**
 * The out-of-turn rounds the operator runs beside the session: a side question, candidate drafts and a handoff
 * extraction. Each runs on its own request and never enters the running turn.
 */
export function createChatLoopSideRounds(
	loop: ChatLoopScope,
): Pick<ChatLoop, "askSideQuestion" | "draftCandidates" | "extractHandoff"> {
	const { deps, prepareOutOfTurnRound, sideCallAdmission, sideCallJournal, sideQuestionRound, withEndpointSlot } = loop;
	return {
		async askSideQuestion(question: string, options: SideQuestionOptions = {}): Promise<SideQuestionOutcome> {
			const text = question.trim();
			if (text.length === 0) {
				return { status: "refused", reason: "a side question needs a question" };
			}
			// Never queued and, since #415, never refused for a running turn. A side
			// question exists to be answered now, beside a run the operator is
			// watching; holding it until the run settles would deliver it after the
			// moment it was asked in had passed.
			const prepared = await prepareOutOfTurnRound(null, options.signal, false, false);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			const route = { targetId: prepared.runtime.targetId, wireModelId: prepared.runtime.wireModelId };
			options.onRoute?.(route);
			// A snapshot, taken now: a running turn keeps appending to the live list
			// while this round awaits admission and streams.
			const messages = [...prepared.runtime.agent.state.messages];
			let result: SideQuestionResult;
			try {
				result = await withEndpointSlot(prepared.runtime, (slot) =>
					sideQuestionRound({
						...sideCallJournal(prepared.runtime, "btw", prepared.origin),
						beforeRequest: sideCallAdmission(prepared.origin, slot, options.signal),
						admitFlow: () => deps.admitFlow?.(prepared.runtime) ?? null,
						model: prepared.runtime.agent.state.model,
						// Read-only: the round appends its own message to this copy, so
						// the live agent's history is untouched.
						messages,
						question: text,
						midTurn: prepared.inFlight,
						// The turn's own prompt and tools, so the round reads the prefix the turn already cached (S12).
						livePrefix: (history, tail, signal) => engineLiveTurnRequest(prepared.runtime.agent, history, tail, signal),
						// The level the session's own next turn would use.
						thinkingLevel: prepared.runtime.agent.state.thinkingLevel ?? "off",
						...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
						...(prepared.refreshApiKey ? { refreshApiKey: prepared.refreshApiKey } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.onDelta ? { onDelta: options.onDelta } : {}),
					}),
				);
			} catch (err) {
				return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
			}
			return result.aborted
				? { status: "aborted", text: result.text }
				: {
						status: "answered",
						text: result.text,
						route: { ...route, ...(result.reportedModel !== undefined ? { reportedModel: result.reportedModel } : {}) },
					};
		},

		async draftCandidates(request: string, count: number, options: DraftOptions = {}): Promise<DraftOutcome> {
			const text = request.trim();
			if (text.length === 0) return { status: "refused", reason: "a draft needs a request" };
			if (!Number.isInteger(count) || count < 1 || count > DRAFT_TEMPERATURES.length) {
				return { status: "refused", reason: `draft count must be 1 to ${DRAFT_TEMPERATURES.length}` };
			}
			// Never queued, for the side question's reason, and run beside a turn in
			// flight the same way (#415): the drafts answer the session as it stands now.
			const prepared = await prepareOutOfTurnRound(null, options.signal, false, false);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			const route = { targetId: prepared.runtime.targetId, wireModelId: prepared.runtime.wireModelId };
			options.onRoute?.(route);
			const messages = [...prepared.runtime.agent.state.messages];
			const candidates = await Promise.all(
				DRAFT_TEMPERATURES.slice(0, count).map(async (temperature, index): Promise<DraftCandidate> => {
					const samplingTemperature = draftTemperature(prepared.runtime.agent.state.model, temperature);
					try {
						// One endpoint slot per round: each is a full request against the
						// same scheduler, and capacity has to count every one of them.
						const result = await withEndpointSlot(prepared.runtime, (slot) =>
							runDraftWithSamplerFallback(
								index,
								samplingTemperature,
								(sampling) =>
									runOutOfTurnRound({
										...sideCallJournal(prepared.runtime, "helper", prepared.origin),
										purpose: "draft",
										beforeRequest: sideCallAdmission(prepared.origin, slot, options.signal),
										admitFlow: () => deps.admitFlow?.(prepared.runtime) ?? null,
										model: prepared.runtime.agent.state.model,
										// One snapshot for every candidate, read-only as the side question's is.
										messages,
										systemPrompt: sampling.systemPrompt,
										userText: text,
										midTurn: prepared.inFlight,
										maxTokens: DRAFT_MAX_TOKENS,
										thinkingLevel: prepared.runtime.agent.state.thinkingLevel ?? "off",
										...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
										...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
										...(prepared.refreshApiKey ? { refreshApiKey: prepared.refreshApiKey } : {}),
										...(options.signal ? { signal: options.signal } : {}),
										...(options.onCandidate ? { onDelta: (partial: string) => options.onCandidate?.(index, partial) } : {}),
									}),
								options.signal,
							),
						);
						return {
							...draftCandidateFromText(result.text),
							route: { ...route, ...(result.reportedModel !== undefined ? { reportedModel: result.reportedModel } : {}) },
						};
					} catch (err) {
						return { status: "failed", reason: err instanceof Error ? err.message : String(err), route };
					}
				}),
			);
			return { status: "drafted", candidates, aborted: options.signal?.aborted === true };
		},

		async extractHandoff(goal: string, options: HandoffRoundOptions = {}): Promise<SideQuestionOutcome> {
			const text = goal.trim();
			if (text.length === 0) {
				return { status: "refused", reason: "a handoff needs a goal" };
			}
			// Refused, never queued: a handoff describes a session that has stopped
			// working, and a turn still in flight is about to change what the
			// document would say.
			const prepared = await prepareOutOfTurnRound(
				"a turn is in flight; /handoff cannot summarize a session that is still moving",
				options.signal,
				false,
				false,
			);
			if (!prepared.ok) return { status: "refused", reason: prepared.reason };
			options.onRoute?.({ targetId: prepared.runtime.targetId, wireModelId: prepared.runtime.wireModelId });
			let result: SideQuestionResult;
			try {
				result = await withEndpointSlot(prepared.runtime, (slot) =>
					runHandoffRound({
						...sideCallJournal(prepared.runtime, "handoff", prepared.origin),
						beforeRequest: sideCallAdmission(prepared.origin, slot, options.signal),
						admitFlow: () => deps.admitFlow?.(prepared.runtime) ?? null,
						model: prepared.runtime.agent.state.model,
						// Read-only, exactly as the side-question round treats it.
						messages: prepared.runtime.agent.state.messages,
						goal: text,
						// The runtime id is what decides whether the schema can be bound
						// on the wire rather than only stated in the prompt.
						runtimeId: prepared.runtime.runtimeResolution.runtime.id,
						...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
						...(prepared.refreshApiKey ? { refreshApiKey: prepared.refreshApiKey } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.repair ? { repair: options.repair } : {}),
					}),
				);
			} catch (err) {
				return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
			}
			return result.aborted ? { status: "aborted", text: result.text } : { status: "answered", text: result.text };
		},
	};
}
