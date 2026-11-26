// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { formatCount } from "../core/format-time.js";

export interface CompactionSummaryLineInput {
	/**
	 * How many provider messages the summary replaced, the unit a context snapshot's `messageRange` counts. Not the
	 * ledger entry count, which also holds tool-call rows and bookkeeping.
	 */
	messagesSummarized: number;
	/** Final length in characters of the generated summary text. */
	summaryChars: number;
	/** Context tokens the footer showed before compaction. */
	tokensBefore: number;
	/**
	 * Context tokens the footer shows after compaction. This is the whole next
	 * request (system prompt, tool schemas, summary and retained suffix), not the
	 * summary alone, so the row and the footer name one figure.
	 */
	tokensAfter: number;
	/** True when the cut fell mid-turn; callers may want to annotate. */
	isSplitTurn?: boolean;
}

/**
 * The persistent transcript row an automatic or `/context compact` run leaves.
 * Example:
 *   PanCode compacted 36.2k → 28.6k tokens: 42 earlier messages now read as one summary
 * The `[context engine]` tag and `summarized to 1823 chars` were PanCode's own bookkeeping; the row says what changed for
 * the conversation. A split-turn run says the cut landed inside a turn, so upstream context may need a re-read, and a
 * run that saved nothing says so instead of leaving `13.0k → 13.0k` to be decoded.
 */
/** How the compaction row starts, so a surface that routes it to the footer can tell it apart. */
export const COMPACTION_LINE_LEAD = "PanCode compacted ";

/**
 * The notice key of a context engine status line: the compaction row, the working-set eviction and skip lines and the
 * no-gain line. They report PanCode's own housekeeping, so a protocol surface routes them off the reply by this tag, not
 * by their wording.
 */
export const CONTEXT_STATUS_NOTICE_KEY = "context.status";

export function renderCompactionSummaryLine(input: CompactionSummaryLineInput): string {
	const count = input.messagesSummarized;
	const messages = `${count} earlier message${count === 1 ? "" : "s"} now read${count === 1 ? "s" : ""} as one summary`;
	const flat = input.tokensAfter >= input.tokensBefore ? "; the context is no smaller" : "";
	const tail = input.isSplitTurn ? " (the cut fell inside a turn)" : "";
	return `${COMPACTION_LINE_LEAD}${formatCount(input.tokensBefore)} → ${formatCount(input.tokensAfter)} tokens: ${messages}${flat}${tail}`;
}

/** Why the non-destructive stage had nothing to do before a summary ran. */
export type EvictionSkipReason = "all-protected" | "nothing-evictable" | "disabled";

export interface EvictionSkipLineInput {
	reason: EvictionSkipReason;
	/** Turn starts in the visible slice the policy was offered; 0 when a cut left it starting inside a turn. */
	turns: number;
	protectLastTurns: number;
	protectLastSteps: number;
	policyId: string;
}

/**
 * One line saying the working-set stage was considered and declined, in the
 * same `[context engine] working set:` voice its eviction notice uses. Without
 * it a short session falls from the pressure threshold straight into the
 * destructive summary with nothing in the transcript explaining why the cheap
 * stage did not run (smoke pass 2, G1).
 */
export function renderEvictionSkipLine(input: EvictionSkipLineInput): string {
	const window = `protectLastTurns ${input.protectLastTurns}, protectLastSteps ${input.protectLastSteps}`;
	const cause =
		input.reason === "disabled"
			? "eviction is off (context.workingSet.enabled false)"
			: input.reason === "all-protected"
				? input.turns === 0
					? `nothing evictable, the visible context starts inside a turn and all of its steps are inside the protected window (${window})`
					: `nothing evictable, ${input.turns === 1 ? "the 1 turn is" : `all ${input.turns} turns are`} inside the protected window (${window})`
				: `nothing evictable by ${input.policyId} above the protected window (${window})`;
	return `[context engine] working set: ${cause}; llm_summary runs instead`;
}
