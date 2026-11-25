// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { registerEngineSessionCleanup } from "../ai.js";
import { registerEngineApiProvider } from "../api-registry.js";
import { forgetCopilotConversation } from "../copilot/session-fs.js";
import { copilotSdkApiProvider, disposeCopilotConversations } from "../copilot/stream.js";
import { onSessionDeleted } from "../session.js";
import { ollamaNativeApiProvider } from "./ollama-native.js";
import { openAICompletionsApiProvider } from "./openai-completions.js";

export { ollamaNativeApiProvider } from "./ollama-native.js";
export { openAICompletionsApiProvider } from "./openai-completions.js";
export { setGlobalDefaultMaxOutputTokens } from "./output-budget.js";

let registered = false;

export function registerPancodeApiProviders(): void {
	if (registered) return;
	registered = true;
	registerEngineApiProvider(openAICompletionsApiProvider, "pancode");
	registerEngineApiProvider(ollamaNativeApiProvider, "pancode");
	registerEngineApiProvider(copilotSdkApiProvider, "pancode");
	// A call without a session id used the "default" conversation key.
	registerEngineSessionCleanup((sessionId) => disposeCopilotConversations(sessionId ?? "default"));
	// A deleted PanCode session takes its resumable Copilot conversation with it (bt-10).
	onSessionDeleted(forgetCopilotConversation);
}
