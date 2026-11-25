// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Compatibility entry point; engine preparation is shared with headless callers. */
export {
	PREWARM_MAX_TOKENS,
	PREWARM_USER_TEXT,
	type PrewarmContext,
	type PrewarmRoundInput,
	type PrewarmRoundResult,
	type PrewarmTrigger,
	prewarmPromptTokens,
	runPrewarmRound,
} from "../engine/prewarm.js";
