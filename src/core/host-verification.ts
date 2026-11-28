// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The feed vocabulary of host verification: dispatch publishes it while a run
 * waits for and holds the verification slot, and progress folds and the fleet
 * board read it.
 */

/** Feed event type a run's host verification publishes; see {@link VerificationSlotState}. */
export const HOST_VERIFICATION_EVENT = "host_verification";
/** The event's `message`: the run waits for the slot, then holds it and runs its checks. */
export type VerificationSlotState = "waiting for a verification slot" | "running host checks";
