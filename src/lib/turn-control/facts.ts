// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { canonicalJson } from "../../core/canonical-json.js";
import { sha256Hex } from "../../core/hash.js";

export interface TurnFacts {
	readonly explicitConstraints: boolean;
	readonly finishedDetachedBatchIds: ReadonlyArray<string>;
}

export function factsDigest(facts: TurnFacts): string {
	return sha256Hex(canonicalJson(facts));
}
