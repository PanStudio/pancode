// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** Closing notice an operator interrupt leaves in the transcript and the ledger. */
export const INTERRUPT_CANCEL_REASON = "[PanCode] run interrupted by operator; delivering the new message now.";

/** The same redirect when triage read a queued message as a stop; no operator cancelled anything. */
export const TRIAGE_INTERRUPT_REASON =
	"[PanCode] run interrupted because triage read the new message as a stop; delivering it now.";

export const isRedirectReason = (reason: string | null | undefined): boolean =>
	reason === INTERRUPT_CANCEL_REASON || reason === TRIAGE_INTERRUPT_REASON;

/**
 * The submit locals one phase writes and a later phase, or a closure made earlier, reads. Everything else
 * crosses between `submit`'s phases as a value.
 */
export interface SubmitTurn {
	/** The prompt reached the engine, so the submit no longer returns its queued message unstarted. */
	promptStarted: boolean;
	/** Ends the foreground-stream registration of the endpoint the turn runs on now; a route move swaps it. */
	releaseForeground: () => void;
}
