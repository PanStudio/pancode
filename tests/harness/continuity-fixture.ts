// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { AcceptedNote, HandoffPolicy } from "../../src/domains/session/continuity/contract.js";
import { validateContinuityNote } from "../../src/domains/session/continuity/note.js";

/** Admits `text` through the real note validator, so a fixture note is one the host would accept. */
export function admit(text: string): AcceptedNote {
	const result = validateContinuityNote(text);
	if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to admit, got ${result.reason}`);
	return result.accepted;
}

/** A handoff policy prepared at `preparedAtMs` with an automatic deadline ten minutes later. */
export function handoffPolicy(preparedAtMs: number, over: Partial<HandoffPolicy> = {}): HandoffPolicy {
	return {
		preparedAtMs,
		automaticDeadlineAtMs: preparedAtMs + 600_000,
		maxAttempts: 2,
		maxSummaryCallsPerAttempt: 2,
		additionalSummaryRetriesPerCall: 0,
		maxSummaryStreamInvocations: 4,
		flushRetryLimit: 3,
		...over,
	};
}
