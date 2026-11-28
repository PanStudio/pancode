// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { Quantity } from "../../core/telemetry/dto.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import type { ReasoningTokenProvenance } from "../../session-control/status-types.js";

/**
 * One projection of a turn's reasoning spend for every surface that shows it.
 *
 * The call journal records each call's reasoning: the provider's count, or a chars/4 estimate over the thinking it
 * streamed when the provider reported none. The receipt line, the settled thinking marker and the footer chip all read
 * the turn's folded reasoning through this module, so a surface can differ in layout but never in the number or its
 * provenance (#434 §11.3).
 *
 * `unmeasured` means the fold knows of no reasoning: none journaled yet, or none the turn's calls reported or
 * streamed. A count is shown only when it holds something.
 */
export type ReasoningProvenance = ReasoningTokenProvenance | "unmeasured";

export interface ReasoningUsageView {
	tokens: number;
	provenance: ReasoningProvenance;
}

export const UNMEASURED_REASONING: ReasoningUsageView = { tokens: 0, provenance: "unmeasured" };

/**
 * A turn's folded reasoning quantity as a view. The count is the fold's known part; it reads as the provider's only
 * when every call the fold holds measured it, and as `≈` once any part is estimated or some call's reasoning is
 * unknown, since the known part is then not the whole.
 */
export function reasoningFromQuantity(quantity: Quantity | null): ReasoningUsageView {
	if (!quantity) return UNMEASURED_REASONING;
	const fact = quantity.fact;
	if ("kind" in fact) {
		if (fact.kind === "measured") return { tokens: fact.value, provenance: "provider" };
		if (fact.kind === "estimated") return { tokens: fact.value, provenance: "estimated" };
		return UNMEASURED_REASONING;
	}
	const { measured, estimated } = fact.coverage;
	if (measured + estimated === 0) return UNMEASURED_REASONING;
	const provenance: ReasoningTokenProvenance =
		estimated === 0 && fact.unknownCount === 0 ? "provider" : measured === 0 ? "estimated" : "mixed";
	return { tokens: factKnownValue(fact), provenance };
}
