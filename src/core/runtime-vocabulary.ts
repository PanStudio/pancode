// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Runtime descriptor vocabularies the provider registry, settings validation and the worker spec all read.
 * Import-free, so the worker value-imports them without loading the provider domain.
 */

export const RUNTIME_KINDS = ["http", "sdk", "subprocess"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export const RUNTIME_API_FAMILIES = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"ollama-native",
	"rerank-http",
	"embeddings-http",
	"claude-agent-sdk",
	"copilot-sdk",
	"claude-code-subprocess",
	"external-agent-subprocess",
] as const;
export type RuntimeApiFamily = (typeof RUNTIME_API_FAMILIES)[number];

export const RUNTIME_AUTHS = ["api-key", "oauth", "vertex-adc", "claude-cli", "none"] as const;
export type RuntimeAuth = (typeof RUNTIME_AUTHS)[number];

/** The capability flags a target, a profile or a probe states as plain true or false. */
export const BOOLEAN_CAPABILITY_KEYS = [
	"chat",
	"tools",
	"reasoning",
	"vision",
	"audio",
	"embeddings",
	"rerank",
	"fim",
] as const;
export type BooleanCapabilityKey = (typeof BOOLEAN_CAPABILITY_KEYS)[number];
