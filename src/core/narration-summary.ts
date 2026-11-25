// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Claude on the Copilot route can deliver the prose it wrote before a tool call only as a narration block whose
 * readable text is Anthropic's short summary of that prose; the prose itself never arrives. The reply text the route
 * makes of such a block carries this mark: a replay never hands it back to the model as its own words, and the chat
 * notes on the reasoning rail that the provider summarized it, never on the reply itself.
 */
export interface NarrationSummaryMark {
	pancodeNarrationSummary?: true;
}

/** Whether a content block is a narration summary rather than reply text the model wrote. */
export function isNarrationSummary(block: unknown): boolean {
	return (block as NarrationSummaryMark | null | undefined)?.pancodeNarrationSummary === true;
}
