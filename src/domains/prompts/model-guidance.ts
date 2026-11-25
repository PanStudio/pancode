// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Model-keyed prompt fragments. A vendor-published behavior note for one model
 * family rides in the session prompt as a fragment, chosen from the wire model
 * id alone so every transport that serves the model gets it. The id is a
 * session constant, so the note changes the prompt only when the model changes.
 */

/**
 * `claude-<tier>-<major>[-.]<minor>` in any transport spelling (Anthropic,
 * OpenRouter, Vertex). A dated snapshot suffix is not a minor version,
 * hence the two-digit cap and the trailing digit guard. Same shape as the
 * sampler check in src/session-control/drafts.ts.
 */
const CLAUDE_GENERATION = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/u;

export const ANTHROPIC_5_5_FRAGMENT_ID = "model.anthropic-5-5";

/** The model fragment id for a wire model id, or null when none applies. */
export function modelGuidanceFragmentId(modelId: string | null | undefined): string | null {
	if (!modelId) return null;
	const match = CLAUDE_GENERATION.exec(modelId.toLowerCase());
	if (!match) return null;
	return Number(match[1]) === 5 && Number(match[2] ?? 0) === 5 ? ANTHROPIC_5_5_FRAGMENT_ID : null;
}

const COPILOT_CLAUDE_FRAGMENT_ID = "model.copilot-claude";

/**
 * The Copilot route note for a session, or null when none applies. Claude on runtime `copilot-sdk` can deliver the
 * prose beside a tool call only as a summary, so the note says where content the operator must read goes. Keyed
 * on the runtime id, not the target id, so every Copilot target gets it.
 */
export function copilotRouteFragmentId(
	runtimeId: string | null | undefined,
	modelId: string | null | undefined,
): string | null {
	if (runtimeId !== "copilot-sdk" || !modelId) return null;
	return CLAUDE_GENERATION.test(modelId.toLowerCase()) ? COPILOT_CLAUDE_FRAGMENT_ID : null;
}
