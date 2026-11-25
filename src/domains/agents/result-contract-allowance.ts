// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { INTERNAL_HELPER_RESULT_KINDS } from "../../worker/protocol.js";
import { isHoareResultContract, type ResultContract } from "./result-contract-types.js";

/** Shared acceptance/capture ceiling: a worker may not accept a result the parent cannot retain. */
export const STRUCTURED_HELPER_RESULT_MAX_BYTES = 32_768;

/**
 * Bytes of authored commit message a terminal result may carry. A commit
 * subject and a short body fit; a pasted diff does not. This bounds only
 * `commitMessage`; the inline `summary` deliverable has its own allowance.
 */
export const RESULT_COMMIT_MESSAGE_MAX_BYTES = 1_000;

/**
 * Summary allowance a mutation-report contract carries when it declares none.
 * A 1200-word cited explanation is roughly 8-9 KB of UTF-8; this leaves room
 * for citations and a limitation paragraph without inviting a pasted file.
 * The 1000-byte commit bound used to double as this limit, which turned every
 * ordinary 150-word or 1200-word no-file explanation into a forced
 * "cannot deliver" (#350, #361).
 */
export const RESULT_SUMMARY_DEFAULT_MAX_BYTES = 16_384;

/**
 * Hard ceiling for any declared or overridden summary allowance. It bounds
 * what a receipt may have to seal for a conforming result, so a recipe or a
 * caller cannot turn the inline summary into unbounded storage.
 */
export const RESULT_SUMMARY_MAX_BYTES_CEILING = 32_768;

/**
 * Bytes reserved beside the summary and commit message for the rest of a
 * mutation report on the wire: mutatedPaths, validations, key names, and
 * quoting. Practical headroom for an ordinary report, not a guarantee that
 * every legal JSON spelling of a bounded summary fits.
 */
const RESULT_OUTPUT_ENVELOPE_HEADROOM_BYTES = 4_096;

/**
 * The summary allowance this contract validates against. Only a mutation
 * report carries the inline deliverable; every other kind that reads authored
 * prose (architect-plan) keeps the commit-message bound it always had.
 */
export function resultSummaryMaxBytes(contract: ResultContract): number {
	if (contract.kind !== "mutation-report") return RESULT_COMMIT_MESSAGE_MAX_BYTES;
	return contract.maxSummaryBytes ?? RESULT_SUMMARY_DEFAULT_MAX_BYTES;
}

/**
 * Parse one summary allowance from a recipe or a dispatch request. The same
 * rule at both boundaries: a positive integer no larger than the ceiling.
 */
export function parseResultSummaryMaxBytes(value: unknown, label: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > RESULT_SUMMARY_MAX_BYTES_CEILING
	) {
		throw new Error(`${label} must be an integer between 1 and ${RESULT_SUMMARY_MAX_BYTES_CEILING}`);
	}
	return value;
}

/**
 * The contract a dispatch-level summary allowance produces. It only ever
 * narrows or widens a mutation report; every other kind has no summary field
 * and is returned untouched, so the caller decides whether that is an error.
 */
export function withResultSummaryAllowance(contract: ResultContract, maxSummaryBytes: number): ResultContract {
	if (contract.kind !== "mutation-report") return contract;
	return { kind: "mutation-report", maxSummaryBytes: parseResultSummaryMaxBytes(maxSummaryBytes, "maxSummaryBytes") };
}

/**
 * Bytes a receipt must be able to seal for a conforming result under this
 * contract, or null when the contract implies no bound of its own. The summary
 * and commit message are doubled because their bounds are measured on the
 * decoded string and the wire carries them JSON-escaped; the headroom covers
 * the rest of the report. A result larger than this seals truncated and fails
 * validation with the bound named, never as a silently accepted fragment.
 */
export function resultContractOutputBytes(contract: ResultContract | null | undefined): number | null {
	if (contract === null || contract === undefined) return null;
	if (isHoareResultContract(contract)) return 32_768;
	if (contract.kind !== "mutation-report" && (INTERNAL_HELPER_RESULT_KINDS as readonly string[]).includes(contract.kind))
		return STRUCTURED_HELPER_RESULT_MAX_BYTES;
	if (contract.kind !== "mutation-report") return null;
	return (
		2 * resultSummaryMaxBytes(contract) + 2 * RESULT_COMMIT_MESSAGE_MAX_BYTES + RESULT_OUTPUT_ENVELOPE_HEADROOM_BYTES
	);
}
