// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../../core/hash.js";
import { isRecord } from "../../core/type-guards.js";

export interface PinnedPromptPrefix {
	chars: number;
	hash: string;
}

const OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function breakpoints(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((total, child) => total + breakpoints(child), 0);
	if (!isRecord(value)) return 0;
	// Schemas and tool inputs can name cache_control without placing a breakpoint (#423).
	return Number(Object.hasOwn(value, "cache_control")) + breakpoints(value.content);
}

/** Keep the install prefix reusable across projects without exceeding Anthropic's four markers (#423). */
export function splitAnthropicSystem(payload: unknown, prefix: PinnedPromptPrefix): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.system) || !Number.isSafeInteger(prefix.chars) || prefix.chars <= 0) {
		return payload;
	}
	const system = payload.system;
	const index = system.findIndex(
		(block) =>
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string" &&
			block.text.length > prefix.chars &&
			isRecord(block.cache_control) &&
			sha256Hex(block.text.slice(0, prefix.chars)) === prefix.hash,
	);
	if (index < 0) return payload;
	const block = system[index] as Record<string, unknown> & { text: string };
	// Pi's OAuth identity remains before the pinned breakpoint, which covers it (#423).
	const identityIndex = system.findIndex(
		(candidate, at) =>
			at < index && isRecord(candidate) && candidate.type === "text" && candidate.text === OAUTH_IDENTITY,
	);
	const identity = system[identityIndex];
	const removesIdentityMarker = isRecord(identity) && Object.hasOwn(identity, "cache_control");
	const markers = breakpoints(system) + breakpoints(payload.tools) + breakpoints(payload.messages);
	if (markers + 1 - Number(removesIdentityMarker) > 4) return payload;
	const split = system.flatMap((candidate, at) => {
		if (at === index) {
			return [
				{ ...block, text: block.text.slice(0, prefix.chars) },
				{ ...block, text: block.text.slice(prefix.chars) },
			];
		}
		if (at === identityIndex && isRecord(candidate)) {
			const { cache_control: _cacheControl, ...uncached } = candidate;
			return [uncached];
		}
		return [candidate];
	});
	return { ...payload, system: split };
}
