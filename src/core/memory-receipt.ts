// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { MemoryConsumptionReceipt } from "../domains/memory/contract.js";
import { isRecord } from "./type-guards.js";

/**
 * The memory consumption receipt's shape check, below both of its readers: memory issues the receipt with a
 * compaction offer, and the session ledger validates the copy a compaction summary entry carries.
 */

/** The most observation batches one session keeps, so the most one receipt can name. */
export const OBSERVATION_MAX_BATCHES = 64;

export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

export function isMemoryDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isMemoryConsumptionReceipt(value: unknown): value is MemoryConsumptionReceipt {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isRecord(value.scope) ||
		!isMemoryId(value.scope.sessionId) ||
		(value.scope.branchAnchorTurnId !== null && !isMemoryId(value.scope.branchAnchorTurnId)) ||
		!isMemoryId(value.offerId) ||
		!isMemoryDigest(value.coverageDigest) ||
		!Array.isArray(value.batches) ||
		value.batches.length < 1 ||
		value.batches.length > OBSERVATION_MAX_BATCHES ||
		!value.batches.every((batch: unknown) => isRecord(batch) && isMemoryId(batch.id) && isMemoryDigest(batch.digest)) ||
		new Set(value.batches.map((batch: { id: string }) => batch.id)).size !== value.batches.length
	)
		return false;
	return (
		value.checkpoint === null ||
		(isRecord(value.checkpoint) && isMemoryId(value.checkpoint.id) && isMemoryDigest(value.checkpoint.digest))
	);
}
