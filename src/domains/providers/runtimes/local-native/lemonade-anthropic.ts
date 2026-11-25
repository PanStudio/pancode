// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { PANCODE_MIN_CONTEXT_WINDOW, PANCODE_MIN_MAX_OUTPUT_TOKENS } from "../../../../core/context-floor.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import { makeAnthropicCompatRuntime } from "../protocol/anthropic-compat.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: PANCODE_MIN_CONTEXT_WINDOW,
	maxTokens: PANCODE_MIN_MAX_OUTPUT_TOKENS,
};

export default makeAnthropicCompatRuntime({
	id: "lemonade-anthropic",
	displayName: "Lemonade (Anthropic-compat)",
	provider: "lemonade",
	auth: "api-key",
	tier: "local-native",
	defaultCapabilities,
	hidden: true,
});
