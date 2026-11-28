// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isHostPolicyMessage } from "../../core/host-policy-message.js";
import { requestFits } from "../../domains/context/budget/request-fit.js";
import {
	estimateAgentContextBreakdown,
	estimateAgentMessageTokens,
	usageAnchoredTokens,
} from "../../domains/session/context-accounting.js";
import { engineInitialSystemPrompt, estimateEngineRequestTokens } from "../../engine/agent.js";
import type { AgentMessage } from "../../engine/types.js";
import type { MessageListDigests } from "../message-list-digest.js";
import { resolveFitOutputReserve, turnAdmissionRemedy } from "../output-reserve.js";
import type { LiveContextEstimate } from "../turn-context.js";
import type { TurnContextScope } from "../turn-context-scope.js";
import type { AgentRuntime } from "../turn-state.js";

/** A tool result cut to fit keeps at least this much, so what the model reads still says what to ask for next. */
const BOUNDED_RESULT_MIN_CHARS = 2_048;
/** Room the cut leaves beyond the overflow for the note it inserts and estimate rounding. */
const BOUNDED_RESULT_SLACK_CHARS = 1_024;

/** What bounding the latest tool batch came to: it fits, there was nothing to cut, or even the cut floor overflows. */
export type BoundBatchOutcome = { kind: "fit" } | { kind: "none" } | { kind: "short"; stop: string };

export function createTurnContextFit(shared: TurnContextScope) {
	const liveContextEstimate = (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
		replayMessages?: ReadonlyArray<AgentMessage>,
		history?: MessageListDigests,
	): LiveContextEstimate => {
		const contextWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
		const observed = replayMessages === undefined ? (history ?? shared.observeHistory(agentRuntime)) : undefined;
		const estimateInput = {
			systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
			messages:
				observed?.messages ??
				(replayMessages ?? []).filter((message) => message.role !== "system" || isHostPolicyMessage(message)),
			...(observed ? { messageTokens: observed.messageTokens } : {}),
			tools: agentRuntime.agent.state.tools,
			...(pendingUserText !== undefined ? { pendingUserText, pendingUserImages: shared.pendingUserImages } : {}),
		};
		const breakdown = estimateAgentContextBreakdown(estimateInput);
		const policyText = pendingUserText === undefined ? null : shared.pendingPolicyText();
		const pendingPolicyTokens =
			policyText === null ? 0 : estimateAgentMessageTokens({ role: "system", content: policyText });
		breakdown.pendingUserTokens += pendingPolicyTokens;
		const historyTokens = observed ? shared.reconciledHistoryTokens(agentRuntime, observed) : null;
		const anchor = shared.reconciledAnchor;
		// Provider usage already includes the old system prompt and schemas.
		// Price only positive growth, separately: shrinking one must not hide
		// growth in the other when the measured prompt exceeds chars/4.
		const reconciledTokens =
			historyTokens !== null && anchor
				? historyTokens +
					breakdown.pendingUserTokens +
					Math.max(0, breakdown.systemPromptTokens - anchor.systemPromptTokens) +
					Math.max(0, breakdown.toolSchemaTokens - anchor.toolSchemaTokens)
				: null;
		// The structural projection (pending policy included) and, with no live anchor (a resume, or an anchor a
		// rewrite dropped), the newest usable usage plus the delta since that call, each walked once.
		const projection =
			breakdown.systemPromptTokens + breakdown.messageTokens + breakdown.pendingUserTokens + breakdown.toolSchemaTokens;
		const usageFloor = reconciledTokens === null ? usageAnchoredTokens(estimateInput, breakdown) : null;
		const estimatedTokens = usageFloor === null ? projection : Math.max(projection, usageFloor);
		const ratio = shared.routeTokenRatio(agentRuntime, observed);
		const priced = (tokens: number): number => (ratio === 1 ? tokens : Math.ceil(tokens * ratio));
		// The usage floor is already a provider count, so only the chars/4 projection takes the ratio (FX-31).
		return {
			// The estimate is a floor, not a competing verdict: it prices material
			// the attested call never saw, so a provider count below it would be
			// answering about a smaller conversation. It is priced at the route's
			// measured chars per token when the route has one, else at chars/4.
			tokens:
				usageFloor === null
					? Math.max(priced(estimatedTokens), reconciledTokens ?? 0)
					: Math.max(priced(projection), usageFloor),
			estimatedTokens,
			reconciledTokens,
			contextWindow,
			breakdown,
		};
	};

	/**
	 * The request priced at this route's measured anchor (bt3 drv-rv5): the anchor, the messages after it and the
	 * pending ask with its policy text each at max(fold estimate, Pi's chars/3.5), and positive growth of the system
	 * prompt and tool schemas, as the reconciled count prices it. Null without a measured anchor.
	 */
	const anchoredFitCount = (
		agentRuntime: AgentRuntime,
		observed: MessageListDigests,
		live: LiveContextEstimate,
		pending: ReadonlyArray<AgentMessage>,
	): number | null => {
		const anchor = shared.measuredAnchor(agentRuntime, observed);
		if (!anchor) return null;
		let foldTail = 0;
		for (let index = anchor.covered; index < observed.messages.length; index += 1)
			foldTail += observed.messageTokens[index] ?? 0;
		// Pi's count of the bare system message and tools, subtracted so only the messages are priced.
		const statics = estimateEngineRequestTokens(agentRuntime.agent, []);
		const piTail = estimateEngineRequestTokens(agentRuntime.agent, observed.messages.slice(anchor.covered)) - statics;
		const piPending = estimateEngineRequestTokens(agentRuntime.agent, pending) - statics;
		const { breakdown } = live;
		return (
			anchor.tokens +
			Math.max(foldTail, piTail) +
			Math.max(breakdown.pendingUserTokens, piPending) +
			Math.max(0, breakdown.systemPromptTokens - anchor.systemPromptTokens) +
			Math.max(0, breakdown.toolSchemaTokens - anchor.toolSchemaTokens)
		);
	};

	/**
	 * The overflow path's one count (A4): the live estimate or Pi's chars/3.5
	 * count of the same request, whichever is larger. The fold evicts until it
	 * fits and the next main request pins it, so admission and Pi's clamp size
	 * the request the fold fitted. With a provider-measured anchor on this
	 * route the count is the anchored one instead, and neither the chars/4
	 * floor over the measured prefix nor the caller's `floor` applies; without
	 * one it is max(floor, A4).
	 */
	const overflowFitTokens = (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
		floor = 0,
		history?: MessageListDigests,
	): number => {
		const observed = history ?? shared.observeHistory(agentRuntime);
		const live = liveContextEstimate(agentRuntime, pendingUserText, undefined, observed);
		const pending: AgentMessage[] = [];
		if (pendingUserText !== undefined) {
			pending.push({
				role: "user",
				content: [{ type: "text", text: pendingUserText }, ...shared.pendingUserImages],
				timestamp: 0,
			} as AgentMessage);
			const policy = shared.pendingPolicyText();
			if (policy !== null) pending.push({ role: "user", content: policy, timestamp: 0 });
		}
		const anchored = anchoredFitCount(agentRuntime, observed, live, pending);
		if (anchored !== null) return anchored;
		const pi = estimateEngineRequestTokens(agentRuntime.agent, [...observed.messages, ...pending]);
		return Math.max(floor, live.tokens, pi);
	};

	/**
	 * The part of the next request no compaction removes, on the A4 terms: the system prompt, tool schemas and pending
	 * ask, at the larger of PanCode's estimate and Pi's chars/3.5 count.
	 */
	const fixedRequestTokens = (agentRuntime: AgentRuntime, pendingUserText?: string): number => {
		const { breakdown } = liveContextEstimate(agentRuntime, pendingUserText, []);
		const pending: AgentMessage[] = [];
		if (pendingUserText !== undefined) {
			pending.push({
				role: "user",
				content: [{ type: "text", text: pendingUserText }, ...shared.pendingUserImages],
				timestamp: 0,
			} as AgentMessage);
			const policy = shared.pendingPolicyText();
			if (policy !== null) pending.push({ role: "user", content: policy, timestamp: 0 });
		}
		return Math.max(
			breakdown.systemPromptTokens + breakdown.toolSchemaTokens + breakdown.pendingUserTokens,
			estimateEngineRequestTokens(agentRuntime.agent, pending),
		);
	};

	/**
	 * The anchored count of the next request with nothing pending, or null when this route has no measured anchor.
	 * `history`, when given, is an observation of the same runtime nothing has changed since.
	 */
	const anchoredInputTokens = (agentRuntime: AgentRuntime, history?: MessageListDigests): number | null => {
		const observed = history ?? shared.observeHistory(agentRuntime);
		const live = liveContextEstimate(agentRuntime, undefined, undefined, observed);
		return anchoredFitCount(agentRuntime, observed, live, []);
	};

	/** After an overflow fold or the requireFit summary: a request that fits on the A4 count pins it for the next main request. */
	const pinOverflowFit = (agentRuntime: AgentRuntime, pendingUserText?: string): boolean => {
		const fitAfter = overflowFitTokens(agentRuntime, pendingUserText);
		const window = liveContextEstimate(agentRuntime, pendingUserText).contextWindow;
		if (!requestFits(fitAfter, resolveFitOutputReserve(agentRuntime, fitAfter), window)) return false;
		shared.overflowInputPin = { sessionId: shared.deps.session?.current()?.id };
		return true;
	};

	/**
	 * Null while the request fits on the A4 count. Otherwise what the overflow fold and the requireFit summary could
	 * not clear: the A4 count, and the sentence naming the largest tool result the request still carries and its size,
	 * left empty unless that result alone is larger than the overflow.
	 */
	const overflowOversize = (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
	): { tokens: number; reserve: number; window: number; largest: string } | null => {
		const window = liveContextEstimate(agentRuntime, pendingUserText).contextWindow;
		if (!(window > 0)) return null;
		const tokens = overflowFitTokens(agentRuntime, pendingUserText);
		const reserve = resolveFitOutputReserve(agentRuntime, tokens);
		if (requestFits(tokens, reserve, window)) return null;
		const messages = agentRuntime.agent.state.messages;
		let largest: { id: string; tool: string; chars: number } | null = null;
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			const chars = message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
			if (largest === null || chars > largest.chars) largest = { id: message.toolCallId, tool: message.toolName, chars };
		}
		if (largest === null || Math.ceil(largest.chars / 3.5) < tokens + reserve - window)
			return { tokens, reserve, window, largest: "" };
		const call = messages
			.flatMap((message) => (message.role === "assistant" ? message.content : []))
			.find((block) => block.type === "toolCall" && block.id === largest.id);
		const target = call?.type === "toolCall" && typeof call.arguments.path === "string" ? ` ${call.arguments.path}` : "";
		return {
			tokens,
			reserve,
			window,
			largest: `The ${largest.tool}${target} result alone is ${largest.chars} characters (about ${Math.ceil(largest.chars / 3.5)} tokens); ask for a narrower ${largest.tool} (an offset and limit).`,
		};
	};

	/**
	 * The turn's last word once the overflow fold and the requireFit summary are spent and one tool result is what
	 * still overflows. Phrased so overflow recovery does not read it as a provider overflow and compact again.
	 */
	const overflowStop = (agentRuntime: AgentRuntime): string | null => {
		const over = overflowOversize(agentRuntime);
		if (over === null || !over.largest) return null;
		return `[PanCode] This turn stopped: after compaction about ${over.tokens} input tokens plus ${over.reserve} reserved for the reply do not fit the ${over.window}-token window. ${over.largest} The session stays usable; send a smaller request.`;
	};

	/**
	 * After compaction, cut the latest tool batch's largest text results (head and tail kept, a note between them) until
	 * the continuation fits, so the model can ask for a narrower range instead of the turn ending on one oversized
	 * observation. Only the outgoing messages change; the session record keeps the full result. Restores the messages and
	 * returns false when no cut makes the request fit, so the guard's stop stands.
	 */
	const boundBatchToFit = (agentRuntime: AgentRuntime): BoundBatchOutcome => {
		const before = agentRuntime.agent.state.messages;
		const batch: number[] = [];
		for (let index = before.length - 1; index >= 0; index -= 1) {
			const message = before[index];
			if (message?.role === "assistant") break;
			if (message?.role === "toolResult") batch.push(index);
		}
		if (batch.length === 0) return { kind: "none" };
		const textChars = (message: AgentMessage): number =>
			message.role === "toolResult"
				? message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0)
				: 0;
		const excessTokens = (): number => {
			const window = liveContextEstimate(agentRuntime).contextWindow;
			if (!(window > 0)) return 0;
			const input = overflowFitTokens(agentRuntime);
			return input + resolveFitOutputReserve(agentRuntime, input) - window;
		};
		const window = liveContextEstimate(agentRuntime).contextWindow;
		// A cut result by its message index: the text block cut, its full text, and how much of it the model sees.
		const cuts = new Map<number, { tool: string; block: number; text: string; chars: number; kept: number }>();
		const shown = (index: number): number =>
			cuts.get(index)?.kept ?? textChars(agentRuntime.agent.state.messages[index] as AgentMessage);
		// Each pass cuts the largest result still above the floor from its full text, priced at Pi's 3.5 characters a token
		// plus slack for the note, until the request fits or every result of the batch is at the floor. Every pass shows
		// one result less, so the loop ends.
		for (;;) {
			const excess = excessTokens();
			if (excess <= 0) break;
			const messages = agentRuntime.agent.state.messages;
			const index = batch.filter((i) => shown(i) > BOUNDED_RESULT_MIN_CHARS).sort((a, b) => shown(b) - shown(a))[0];
			const message = index === undefined ? undefined : messages[index];
			if (index === undefined || message?.role !== "toolResult") break;
			const blocks = message.content;
			let entry = cuts.get(index);
			if (entry === undefined) {
				const largest = blocks.reduce<number>(
					(best, block, i) =>
						block.type === "text" && (best < 0 || block.text.length > (blocks[best] as { text: string }).text.length)
							? i
							: best,
					-1,
				);
				const block = blocks[largest];
				if (block?.type !== "text") break;
				const call = messages
					.flatMap((item) => (item.role === "assistant" ? item.content : []))
					.find((item) => item.type === "toolCall" && item.id === message.toolCallId);
				const target =
					call?.type === "toolCall" && typeof call.arguments.path === "string" ? ` ${call.arguments.path}` : "";
				const chars = block.text.length;
				entry = { tool: `${message.toolName}${target}`, block: largest, text: block.text, chars, kept: chars };
			}
			const keep = Math.max(BOUNDED_RESULT_MIN_CHARS, entry.kept - Math.ceil(excess * 3.5) - BOUNDED_RESULT_SLACK_CHARS);
			if (keep >= entry.kept) break;
			const { tool, text: full, chars } = entry;
			const head = Math.ceil(keep / 2);
			const note = `\n\n[PanCode cut this ${tool} result from ${chars} to ${keep} characters, keeping its start and end, so the request fits the ${window}-token context window. Ask for the part you need in narrower ranges (an offset and limit, or filtered output) instead of repeating this call.]\n\n`;
			const text = `${full.slice(0, head)}${note}${full.slice(chars - (keep - head))}`;
			const next = [...messages];
			next[index] = {
				...message,
				content: blocks.map((item, i) => (i === entry.block && item.type === "text" ? { ...item, text } : item)),
			};
			agentRuntime.agent.state.messages = next;
			cuts.set(index, { ...entry, kept: keep });
		}
		const cut = [...cuts.values()];
		if (cut.length === 0) return { kind: "none" };
		if (excessTokens() > 0) {
			// Even the floor overflows: what is left is the fixed request, which no cut of this batch can shrink.
			const tokens = overflowFitTokens(agentRuntime);
			const reserve = resolveFitOutputReserve(agentRuntime, tokens);
			agentRuntime.agent.state.messages = before;
			const cuts = cut.map((entry) => `the ${entry.tool} result cut to ${entry.kept} characters`).join(" and ");
			return {
				kind: "short",
				stop: `[PanCode] This turn stopped: the context window is too small for it. Even with ${cuts}, about ${tokens} input tokens plus ${reserve} reserved for the reply do not fit the ${window}-token window. ${turnAdmissionRemedy(agentRuntime, tokens)} The session stays usable.`,
			};
		}
		for (const entry of cut) {
			shared.deps.emitNotice(
				`[PanCode] The ${entry.tool} result (${entry.chars} characters) did not fit the ${window}-token window after compaction; the model sees ${entry.kept} of them, from its start and end, and was told to read narrower ranges. The session keeps the full result.`,
				"warning",
			);
		}
		return { kind: "fit" };
	};
	return {
		liveContextEstimate,
		overflowFitTokens,
		fixedRequestTokens,
		anchoredInputTokens,
		pinOverflowFit,
		overflowOversize,
		overflowStop,
		boundBatchToFit,
	};
}
