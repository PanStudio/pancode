// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The argument a call that sets `unsandboxed: true` states its reason in; the operator reads it on the approval card. */
export const UNSANDBOXED_REASON_ARG = "unsandboxed_reason";

/** Reason code of the refusal of `unsandboxed: true` with no stated reason, before any review. */
export const UNSANDBOXED_REASON_REQUIRED_CODE = "sandbox-escape-reason-required";

const UNSANDBOXED_REASON_MAX_CHARS = 400;

export const UNSANDBOXED_REASON_DESCRIPTION =
	"Required with unsandboxed: what the sandbox blocked and why; the operator reads it.";

/** The agent's stated reason for leaving the sandbox, trimmed and bounded, or null when the call states none. */
export function unsandboxedReason(args: Readonly<Record<string, unknown>> | undefined): string | null {
	const raw = args?.[UNSANDBOXED_REASON_ARG];
	if (typeof raw !== "string") return null;
	const chars = Array.from(raw.replace(/\s+/gu, " ").trim());
	if (chars.length === 0) return null;
	return chars.length > UNSANDBOXED_REASON_MAX_CHARS
		? `${chars.slice(0, UNSANDBOXED_REASON_MAX_CHARS - 1).join("")}…`
		: chars.join("");
}

/**
 * Why a call that sets `unsandboxed: true` is refused before any review: it states no reason the operator could
 * weigh. Null when the call stays in the sandbox or states one.
 */
export function missingUnsandboxedReason(
	tool: string,
	args: Readonly<Record<string, unknown>> | undefined,
): string | null {
	if (args?.unsandboxed !== true || unsandboxedReason(args) !== null) return null;
	return `${tool}: unsandboxed: true needs ${UNSANDBOXED_REASON_ARG}, one sentence on what the sandbox blocked and why the command must run outside it; the operator reads it on the approval card before approving the escape. The call did not run and was not reviewed.`;
}
