// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { formatCount, formatElapsed } from "../core/format-time.js";
/** The receipt row under a finished turn: outcome, duration, spend, cache and worker facts. */
import { renderCalls } from "../core/telemetry/render.js";
import { visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { turnNoAnswerSentence, writtenCallsFact } from "../session-control/chat-loop-messages.js";
import { coldReasonList } from "../session-control/cold-reasons.js";
import {
	AMBER_WARN,
	dimLine,
	GREEN_OK,
	hangProseLines,
	PROSE_GUTTER_WIDTH,
	RED_CRIT,
	RESET,
	SECONDARY,
} from "./chat-ink.js";
import { type ChatPanelTurnUsage, reasoningFromTurnUsage } from "./chat-transcript-model.js";
import { wallClockLocal } from "./format-time.js";
import { GLYPH, joinFacts, releaseSpaces } from "./theme/index.js";
import { modelNickname } from "./theme/labels.js";
import type { TranscriptDetailPolicy } from "./transcript-detail.js";
import { turnWorkersFact } from "./turn-spend.js";

/**
 * `in` is the sum of every model call the turn made, not the size of one
 * prompt. A long agentic turn makes dozens of calls that each resend a growing
 * context, so the total runs far past the model's context window and reads as
 * one impossible request unless the call count is beside it. One live turn
 * reported 717676 input tokens against a 500k window; it was 65 calls of about
 * 11k, which the preceding one-call turns had already shown.
 */
export function renderTurnUsageLine(
	usage: ChatPanelTurnUsage,
	width: number,
	receipt: TranscriptDetailPolicy["receipt"],
	nowMs: number,
): string[] {
	const outcome = usage.outcome ?? "Done";
	// Every form leads with the outcome glyph and word; an operator's stop reads as one (`⊘ Stopped`).
	const word = outcome === "Cancelled" ? "Canceled" : outcome;
	// When the turn ended closes every receipt, after the outcome and duration a reader scans for first.
	const ended = usage.endedAtMs === undefined ? null : wallClockLocal(usage.endedAtMs, nowMs);
	const endedFact = ended === null ? [] : [ended];
	const glyph = receiptGlyph(outcome);
	const room = Math.max(1, width - PROSE_GUTTER_WIDTH);
	const quiet =
		usage.ending?.kind === "quiet"
			? "no closing message"
			: usage.ending?.kind === "call_not_run"
				? writtenCallsFact(usage.ending.writtenTools)
				: null;
	// A turn with no answer states why at every tier: compact drops the spend, not this.
	const noAnswer =
		usage.ending?.kind === "no_answer"
			? hangProseLines(
					wrapTextWithAnsi(
						`${SECONDARY()}${turnNoAnswerSentence(usage.ending)} Ask again, or /model switches route.${RESET}`,
						room,
					).map(releaseSpaces),
				)
			: [];
	if (receipt === "outcome") {
		// A written call that did not run is news at every tier too, and the outcome receipt has no other row to carry it.
		if (usage.ending?.kind === "call_not_run")
			return [
				`${glyph}${dimLine(joinFacts([`${word}${receiptDuration(usage)}`, writtenCallsFact(usage.ending.writtenTools), ...endedFact]), room)}`,
			];
		// The outcome receipt states no spend, but a turn still ends visibly: its outcome word, how long it took, when,
		// and why no answer came when none did.
		return [`${glyph}${dimLine(joinFacts([`${word}${receiptDuration(usage)}`, ...endedFact]), room)}`, ...noAnswer];
	}
	const spend = usage.spend;
	// A turn that left workers running states their spend apart and live, so its outcome drops their count frozen at its end.
	const shownOutcome = spend?.workers !== undefined && outcome.startsWith(TURN_ENDED) ? TURN_ENDED : word;
	const workersFact = spend?.workers === undefined ? null : turnWorkersFact(spend.workers);
	// A wait the provider asked for spends no retry, so the receipt keeps it apart: a count of them approached no limit.
	const retries =
		[
			usage.providerWaits ? `${usage.providerWaits} provider wait${usage.providerWaits === 1 ? "" : "s"}` : null,
			usage.retries ? `${usage.retries} ${usage.retries === 1 ? "retry" : "retries"}` : null,
		]
			.filter(Boolean)
			.join(", ") || null;
	const moved = usage.movedTo ? `moved to ${modelNickname(usage.movedTo)}` : null;
	if (receipt === "summary") {
		// The outcome, then how long and how many calls; a call count of one says nothing unless retries explain it.
		// Calls PanCode never sent are part of the count, so they are said inside it: `2 calls · 1 call never sent` read as
		// three calls.
		const unsent = spend?.neverSent ?? 0;
		const calls =
			spend?.calls != null && (spend.calls > 1 || retries !== null || moved !== null)
				? `${renderCalls(String(spend.calls), "call")}${unsent > 0 && spend.calls > unsent ? `, ${unsent} never sent` : ""}`
				: null;
		const coverageNote =
			unsent > 0 &&
			calls !== null &&
			spend?.calls != null &&
			spend.calls > unsent &&
			spend.coverageNote?.endsWith("never sent") === true
				? null
				: (spend?.coverageNote ?? null);
		// A call moved away from has no amounts of its own. The row states the answering call beside the move, and
		// Detailed keeps the sum.
		const stated = moved !== null ? spend?.answer : spend;
		// A narrow row loses the least useful facts whole, so it never ends on half an amount.
		const rowFacts = [
			`${shownOutcome}${receiptDuration(usage)}`,
			...(quiet === null ? [] : [quiet]),
			...(usage.promptRecall === true ? [PROMPT_RECALL_FACT] : []),
		];
		const callsFact =
			calls !== null || retries !== null || moved !== null ? [calls, retries, moved].filter(Boolean).join(", ") : null;
		// `in` is the uncached part, so the cached shares travel with the amounts: a narrow row that dropped them alone
		// read the uncached remainder as the whole prompt. Copilot reports most of a prompt as a cache write, which the row
		// states too (bt finding 6). A route that reports no cache states no cached share; Detailed and /usage keep that
		// unknown.
		const amountParts = [
			stated?.tokens ?? null,
			stated?.cached != null ? `cached ${stated.cached}` : null,
			stated?.cacheWritten !== undefined ? `cache write ${stated.cacheWritten}` : null,
		].filter((part): part is string => part !== null);
		const amounts = amountParts.join(RECEIPT_SEP) || null;
		// Shown in this order; kept by rank, where a bare call count yields to the amounts it qualifies. Amounts too wide
		// for the row keep as many whole facts as fit and a `…` where the rest were cut, so a narrow row never passes its
		// call count or a partial amount off as the whole spend. A turn whose workers are stated apart also states its own
		// cost, and their fact outranks the rest.
		const ordered = [callsFact, coverageNote, amounts, workersFact === null ? null : (spend?.cost ?? null), workersFact];
		const rank = [4, ...(retries === null && moved === null ? [2, 1, 0] : [0, 1, 2]), 3];
		const kept = new Set<number>();
		const fits = (index: number) => {
			const trial = ordered.filter((_, at) => at === index || kept.has(at)) as string[];
			return visibleWidth(joinFacts([...rowFacts, ...trial, ...endedFact])) <= room;
		};
		for (const index of rank) {
			if (ordered[index] == null) continue;
			if (fits(index)) kept.add(index);
			else if (index === 2) {
				for (let count = amountParts.length - 1; count >= 0; count--) {
					ordered[2] = [...amountParts.slice(0, count), GLYPH.ellipsis].join(RECEIPT_SEP);
					if (fits(2)) {
						kept.add(2);
						break;
					}
				}
			}
		}
		rowFacts.push(...(ordered.filter((fact, at) => fact != null && kept.has(at)) as string[]));
		return [`${glyph}${dimLine(releaseSpaces(joinFacts([...rowFacts, ...endedFact])), room)}`, ...noAnswer];
	}
	const facts: string[] = [
		shownOutcome,
		...[quiet, retries, moved].filter((fact): fact is string => fact !== null),
		...receiptDuration(usage).split(RECEIPT_SEP).slice(1),
	];
	// Detailed states what the turn spent, one fact per field, as the read model
	// folds the turn with its workers, so the line and the footer agree: the
	// calls it made, input and output tokens in the compact token format, what
	// the provider served from its prompt cache, the reasoning it reported (`≈`
	// when PanCode estimated it), and why the cache was expected to be cold when
	// nothing was reused. A field with nothing to say is left out, and with no
	// read model the line keeps only what the run itself knows. It wraps only
	// between facts, so no row ends inside one.
	if (usage.promptRecall === true) facts.push(PROMPT_RECALL_FACT);
	if (spend) {
		if (spend.calls !== null && spend.calls > 1) facts.push(`${spend.calls} calls`);
		facts.push(`in ${spend.input}`, `out ${spend.output}`);
		if (spend.cacheRead !== null) facts.push(`cached ${spend.cacheRead}`);
		if (spend.cacheWrite !== null) facts.push(`cache write ${spend.cacheWrite}`);
	}
	const reasoning = reasoningFromTurnUsage(usage);
	if (reasoning.tokens > 0 && reasoning.provenance !== "unmeasured") {
		facts.push(`reasoning ${reasoning.provenance === "provider" ? "" : GLYPH.estimate}${formatCount(reasoning.tokens)}`);
	}
	if (spend?.cost != null) facts.push(spend.cost);
	if (workersFact !== null) facts.push(workersFact);
	if (spend?.cacheRead == null && usage.coldReasons !== undefined && usage.coldReasons.length > 0) {
		facts.push(`prompt read again after ${coldReasonList(usage.coldReasons)}`);
	}
	// How many calls had no usage data closes the line once, after the figures it qualifies (F4).
	if (spend?.coverage) facts.push(spend.coverage);
	facts.push(...endedFact);
	return [
		...hangProseLines(
			factRows(facts, room).map((row) => `${SECONDARY()}${row}${RESET}`),
			glyph,
		),
		...noAnswer,
	];
}

/**
 * Facts packed into rows of `room` cells, broken only at ` · `: a row never ends inside a fact or on a separator. A
 * fact wider than a whole row alone wraps at its own spaces, since nothing else can hold it.
 */
function factRows(facts: readonly string[], room: number): string[] {
	const rows: string[] = [];
	let row: string[] = [];
	for (const fact of facts) {
		if (row.length > 0 && visibleWidth(joinFacts([...row, fact])) > room) {
			rows.push(releaseSpaces(joinFacts(row)));
			row = [];
		}
		row.push(fact);
	}
	if (row.length > 0) rows.push(releaseSpaces(joinFacts(row)));
	return rows.flatMap((line) => (visibleWidth(line) > room ? wrapTextWithAnsi(line, room) : [line]));
}

/**
 * The receipt closes a turn with its outcome glyph in the gutter, like every
 * other block's mark, so where each turn ended and how is scannable down the
 * left edge. Only the glyph carries color; the facts stay dim.
 */
/** A turn that waited on the operator states its work and that wait apart: the sum describes neither. */
function receiptDuration(usage: ChatPanelTurnUsage): string {
	if (usage.elapsedMs === undefined) return "";
	const waited = usage.humanWaitMs ?? 0;
	if (waited < 1000) return `${RECEIPT_SEP}${formatElapsed(usage.elapsedMs)}`;
	return `${RECEIPT_SEP}${formatElapsed(Math.max(0, usage.elapsedMs - waited))} work${RECEIPT_SEP}${formatElapsed(waited)} waiting on you`;
}

/** The separator {@link joinFacts} draws, for facts a receipt joins before the row does. */
const RECEIPT_SEP = ` ${GLYPH.dot} `;

const PROMPT_RECALL_FACT = `${GLYPH.up} recalls your prompt`;

const TURN_ENDED = "Turn ended";

export function turnEndedWithWorkers(count: number): string {
	return `${TURN_ENDED}${RECEIPT_SEP}${count} worker${count === 1 ? "" : "s"} running`;
}

function receiptGlyph(outcome: string): string {
	if (outcome === "Done") return `${GREEN_OK()}${GLYPH.ok}${RESET} `;
	// Nothing went wrong, and the work is not done either: the dispatch mark says where it went.
	if (outcome.startsWith(TURN_ENDED)) return `${SECONDARY()}${GLYPH.phaseDispatch}${RESET} `;
	if (outcome === "Failed") return `${RED_CRIT()}${GLYPH.error}${RESET} `;
	if (outcome === "Cancelled") return `${SECONDARY()}${GLYPH.cancelled}${RESET} `;
	return `${AMBER_WARN()}${GLYPH.warn}${RESET} `;
}
