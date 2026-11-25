// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The Copilot runtime ends a model call that returned nothing with "No response was returned. Send your message
 * again to retry.", which the copilot-sdk adapter relays as `GitHub Copilot query: ...`. Another attempt is the remedy
 * the runtime itself names, and none of Pi's transient wordings match it, so one such failure ended a run whose work
 * was already done (battletest finding 8). The step carries no tool call when it fails this way (a tool request
 * settles the step as tool use first), and the adapter reseeds the next call from PanCode's transcript, so a retry
 * resends the request without running any tool round again.
 */
const COPILOT_EMPTY_RESPONSE_PATTERN = /\bGitHub Copilot\b[^:]*:.*\bno response was returned\b/i;

/** A copilot-sdk failure that another attempt of the same request may clear. */
export function isCopilotTransientFailure(errorMessage: string | null | undefined): boolean {
	return typeof errorMessage === "string" && COPILOT_EMPTY_RESPONSE_PATTERN.test(errorMessage);
}
