// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/**
 * Pi providers backing PanCode's built-in runtime descriptors. Keep this list in
 * lockstep with CATALOG_PROVIDER_BY_RUNTIME_ID; out-of-tree runtimes join the
 * external compatibility universe before their modules evaluate.
 */
const CONFIGURED_PROVIDER_FACTORIES = [
	anthropicProvider,
	deepseekProvider,
	googleProvider,
	groqProvider,
	mistralProvider,
	openaiProvider,
	openaiCodexProvider,
	openrouterProvider,
] as const;

export const engineModels = createModels();
for (const factory of CONFIGURED_PROVIDER_FACTORIES) engineModels.setProvider(factory());
