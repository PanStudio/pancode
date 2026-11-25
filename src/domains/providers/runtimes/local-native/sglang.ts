// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { PANCODE_MIN_CONTEXT_WINDOW, PANCODE_MIN_MAX_OUTPUT_TOKENS } from "../../../../core/context-floor.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import { makeOpenAICompatRuntime } from "../protocol/openai-compat.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: PANCODE_MIN_CONTEXT_WINDOW,
	maxTokens: PANCODE_MIN_MAX_OUTPUT_TOKENS,
};

export default makeOpenAICompatRuntime({
	id: "sglang",
	displayName: "SGLang",
	provider: "sglang",
	auth: "api-key",
	tier: "local-native",
	defaultCapabilities,
});
