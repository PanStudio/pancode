// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { CallSettled } from "./telemetry/schemas.js";
import { asRecord } from "./type-guards.js";

// Message lifetime bounds this projection; only call IDs enter the ledger (#434).
const settledCalls = new WeakMap<object, readonly CallSettled[]>();

export function rememberMessageCalls(message: object, calls: readonly CallSettled[]): void {
	settledCalls.set(message, Object.freeze([...calls]));
}

export function messageCallsForAccounting(message: unknown): readonly CallSettled[] | undefined {
	return message !== null && typeof message === "object" ? settledCalls.get(message) : undefined;
}

// Messages PanCode writes into a prompt itself. A run emits them like replies, but no model produced them (#434).
const hostAuthored = new WeakSet<object>();

export function markHostAuthored<T extends object>(message: T): T {
	hostAuthored.add(message);
	return message;
}

export function isHostAuthored(message: unknown): boolean {
	return message !== null && typeof message === "object" && hostAuthored.has(message);
}

/** Read PanCode's annotations separately from immutable provider usage; old ledgers stored them inside usage (#434). */
export function messageUsageForAccounting(message: unknown): Record<string, unknown> | null {
	const raw = asRecord(message);
	const usage = asRecord(raw?.usage);
	if (!raw || !usage) return null;
	const accounting = asRecord(raw.callAccounting);
	const result = { ...usage };
	for (const key of ["usageObserved", "pricedBy", "freeRule", "targetId"] as const) {
		if (accounting?.[key] !== undefined) result[key] = accounting[key];
	}
	if (typeof raw.callInvoked === "boolean") result.callInvoked = raw.callInvoked;
	if (asRecord(raw.failure)?.invoked === false) result.callInvoked = false;
	return result;
}
