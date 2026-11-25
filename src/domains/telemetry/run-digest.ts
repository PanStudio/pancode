// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { canonicalJsonStrict } from "../../core/canonical-json.js";
import { sha256Hex } from "../../core/hash.js";
import type { RunSettled } from "../../core/telemetry/run-schemas.js";

/**
 * A finished run's identity: the sha256 of its run.settled payload as canonical JSON (#434). The payload names its
 * result object by digest, so the identity commits to what the run delivered too. Gate subjects, Scout sources and
 * plan sources cite it; a reader that acts on one checks it against the sealed record.
 */
export function runSettledDigest(payload: RunSettled): string {
	return sha256Hex(canonicalJsonStrict(payload));
}
