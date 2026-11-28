// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { canonicalJson } from "../../core/canonical-json.js";
import { sha256Hex } from "../../core/hash.js";
import type { TurnFacts } from "./facts.js";
import type { TurnControlSettings } from "./settings.js";

export type WorkflowDecision =
	| { kind: "none"; reason: "off" | "constraints" | "nothing-finished" }
	| { kind: "collect"; batchIds: ReadonlyArray<string> };

export function decide(facts: TurnFacts, settings: TurnControlSettings): WorkflowDecision {
	if (facts.explicitConstraints) return { kind: "none", reason: "constraints" };
	if (!settings.hooks.includes("detached-collection")) return { kind: "none", reason: "off" };
	if (facts.finishedDetachedBatchIds.length === 0) return { kind: "none", reason: "nothing-finished" };
	return { kind: "collect", batchIds: [...facts.finishedDetachedBatchIds] };
}

export function decisionHash(decision: WorkflowDecision): string {
	return sha256Hex(canonicalJson(decision));
}
