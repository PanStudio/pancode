// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { canonicalJson } from "../../core/canonical-json.js";
import { sha256Hex } from "../../core/hash.js";

/**
 * The effect descriptor a worker's parked call crosses to the orchestrator
 * for a live grant (Phase D). The grant broker evaluates the descriptor as
 * the main agent's own call and binds the decision to its digest, so the
 * worker can check that a decision names exactly the call it parked.
 *
 * Long string values are replaced by their digest and length. Admission reads
 * paths, commands and short options; bulk content (a file body, an edit's
 * replacement text) never decides a disposition, and hashing it keeps the
 * descriptor inside the control-lane frame bound without dropping the binding.
 */

/** Strings at or under this many UTF-8 bytes cross verbatim; longer ones cross as digests. */
export const GRANT_EFFECT_INLINE_STRING_BYTES = 2048;

export interface GrantEffectDescriptor {
	tool: string;
	args: Record<string, unknown>;
}

function digestLongStrings(value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		const bytes = Buffer.byteLength(value, "utf8");
		return bytes > GRANT_EFFECT_INLINE_STRING_BYTES ? { $sha256: sha256Hex(value), bytes } : value;
	}
	if (depth > 8) return { $sha256: sha256Hex(canonicalJson(value)), bytes: -1 };
	if (Array.isArray(value)) return value.map((entry) => digestLongStrings(entry, depth + 1));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (child === undefined) continue;
			out[key] = digestLongStrings(child, depth + 1);
		}
		return out;
	}
	return value;
}

/** The descriptor for one parked call. Deterministic for equal calls. */
export function grantEffectDescriptor(tool: string, args: Record<string, unknown> | undefined): GrantEffectDescriptor {
	return { tool, args: digestLongStrings(args ?? {}, 0) as Record<string, unknown> };
}

/** The argument digest a decision must name: sha256 over the canonical descriptor. */
export function grantEffectDigest(effect: GrantEffectDescriptor): string {
	return sha256Hex(`pancode.grantEffect:${canonicalJson({ tool: effect.tool, args: effect.args })}`);
}
