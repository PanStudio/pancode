// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { CapacityAdmissionController } from "./admission.js";
import { createLeaseSlotGuard } from "./admission.js";
import { AdmissionCanceledError, AdmissionTimedOutError } from "./admission-error.js";
import type { DurableAssignmentRecord } from "./assignment-store.js";
import { cancelStoredAssignment, failQueuedAssignment, timeoutStoredAssignment } from "./assignment-store.js";
import type { CapacityLease } from "./capacity-lease.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import type { Ledger } from "./state.js";

/**
 * Settle a stored assignment whose attempt ended before its run could settle it. Typed errors, not message text,
 * decide: no admission message ever contained "timed_out", so matching text stored a timed-out wait as failed.
 */
export function settleUnstartedAssignment(
	assignmentId: string,
	error: unknown,
	signal?: AbortSignal,
): Promise<DurableAssignmentRecord> {
	if (error instanceof AdmissionTimedOutError) return timeoutStoredAssignment(assignmentId);
	if (error instanceof AdmissionCanceledError || signal?.aborted === true) return cancelStoredAssignment(assignmentId);
	return failQueuedAssignment(assignmentId);
}

export interface LaunchAcquisitionInput {
	/** The capacity step. It settles the stored assignment itself when the wait fails. */
	admit(): Promise<CapacityLease>;
	controller: Pick<CapacityAdmissionController, "release" | "releaseAssignment">;
	requireLedger(): Ledger;
	/** False for a retry or fleet step: the stored assignment and its lease belong to the root. */
	ownsAssignment: boolean;
	signal?: AbortSignal | undefined;
}

export interface LaunchAcquisition {
	readonly lease: CapacityLease;
	readonly ledger: Ledger;
	/** The stored assignment, under `assignmentId` after any rename, owns the lease; its settlement releases it. */
	adopt(assignmentId: string): void;
	/** Hand back a slot no assignment owns yet. Idempotent. */
	release(): void;
	/** Release what the launch holds and settle the stored assignment it opened. Never rejects. */
	fail(error: unknown): Promise<void>;
}

/**
 * The capacity lease, its slot guard and the ledger for a native or ACP launch. Every failure from admission until the
 * run settles itself goes through `fail`, so the stored assignment never stays running with no run behind it.
 */
export async function acquireLaunch(input: LaunchAcquisitionInput): Promise<LaunchAcquisition> {
	const lease = await input.admit();
	const slot = createLeaseSlotGuard(input.controller, lease.leaseId, !input.ownsAssignment);
	let adoptedAs: string | null = null;
	const fail = async (error: unknown): Promise<void> => {
		slot.release();
		if (!input.ownsAssignment) return;
		const assignmentId = adoptedAs ?? lease.assignmentId;
		try {
			await settleUnstartedAssignment(assignmentId, error, input.signal);
		} catch (settleError) {
			reportDispatchDiagnostic(`persist assignment ${assignmentId}:launch`, settleError);
		}
		if (adoptedAs !== null) input.controller.releaseAssignment(adoptedAs);
	};
	let ledger: Ledger;
	try {
		input.signal?.throwIfAborted();
		ledger = input.requireLedger();
	} catch (error) {
		await fail(error);
		throw error;
	}
	return {
		lease,
		ledger,
		adopt: (assignmentId) => {
			adoptedAs = assignmentId;
			slot.transferToAssignment();
		},
		release: () => slot.release(),
		fail,
	};
}
