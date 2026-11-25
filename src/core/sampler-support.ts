// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Which models refuse an explicit sampling temperature. A leaf: `/draft` and extension completions both read it. */

/**
 * Claude removed `temperature`, `top_p`, and `top_k` with Opus 4.7. Opus 4.7
 * and 4.8, Sonnet 5, and every Opus, Fable, and Mythos 5 model answer an
 * explicit sampler with HTTP 400. pi-ai drops it only where its catalog says
 * so, and its Sonnet 5 and Fable 5 entries do not. Matching the family in the
 * wire id covers the Anthropic, OpenRouter, and Vertex spellings of one model.
 * A dated snapshot suffix is not a minor version.
 */
const CLAUDE_GENERATION = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/u;

function rejectsSamplingTemperature(modelId: string): boolean {
	const match = CLAUDE_GENERATION.exec(modelId.toLowerCase());
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	return major > 4 || (major === 4 && minor >= 7);
}

/** The fields of a model that decide whether it takes a sampler. Structural so this file stays off the Pi types. */
export interface SamplerModelShape {
	id: string;
	api?: string;
	reasoning?: boolean;
	/** Pi's per-model compat block; only `supportsTemperature` is read. */
	compat?: object;
}

/**
 * OpenAI's reasoning models and the Codex backend answer an explicit
 * `temperature` with `Unsupported parameter: temperature` (HTTP 400). pi-ai
 * forwards the sampler on both Responses transports, so the answer is decided
 * here from the transport and the catalog's reasoning flag. Anything this
 * misses is caught by the one-shot retry `/draft` makes without the sampler.
 */
function transportRefusesTemperature(model: SamplerModelShape): boolean {
	if ((model.compat as { supportsTemperature?: boolean } | undefined)?.supportsTemperature === false) return true;
	if (model.api === "openai-codex-responses") return true;
	return model.api === "openai-responses" && model.reasoning === true;
}

/** The temperature a request is sent with, or undefined where the model refuses one and runs at its default. */
export function samplerTemperature(model: SamplerModelShape | string, temperature: number): number | undefined {
	const shape = typeof model === "string" ? { id: model } : model;
	return rejectsSamplingTemperature(shape.id) || transportRefusesTemperature(shape) ? undefined : temperature;
}
