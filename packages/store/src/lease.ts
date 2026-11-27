// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Leases: store locks that hosts sharing one store take over from each other. The holder renews its lease every
 * 10 seconds; a lease not renewed for 60 seconds, by the store's own clock, is taken over from any host. A writer
 * confirms the leases it holds before each change it makes under them. A renewal that finds a lease taken
 * over aborts the writer's signal; it cannot retract an operation already accepted by the store.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { StoreRefusal } from "./backend/types.js";

/** A lease not renewed for this long, by the store's clock, is taken over. */
export const STORE_LEASE_EXPIRY_MS = 60 * 1000;
const LEASE_RENEW_MS = 10 * 1000;

/** A lease the current writer holds: confirmed before each change it makes, its signal aborted once it is lost. */
interface HeldLease {
	signal: AbortSignal;
	confirm(): Promise<void>;
}

/** The leases held by the writer running in this async context, outermost first. */
const heldLeases = new AsyncLocalStorage<HeldLease[]>();

/** How a backend keeps one lease it has taken. */
export interface StoreLease {
	/** Renew the lease: true while it is still this writer's, false once it was taken over or broken. */
	renew(): Promise<boolean>;
	/** Give the lease up; called only while it is still this writer's. */
	release(): Promise<void>;
}

function lostRefusal(key: string): StoreRefusal {
	return new StoreRefusal(
		"io",
		`The store lock for ${key} was lost while it was held (it was taken over or broken); look at the change it guarded before relying on it.`,
	);
}

/** Run fn holding `lease` on `key`, renewing it until fn settles; refused when the lease was lost meanwhile. */
export async function withLease<T>(key: string, lease: StoreLease, fn: () => Promise<T>): Promise<T> {
	let lost = false;
	const controller = new AbortController();
	let renewing: Promise<void> = Promise.resolve();
	/** One renewal, after any already queued, so two never race. True while the lease is ours. */
	const renew = (): Promise<boolean> => {
		// A renewal that failed to reach the store does not stop the next one.
		renewing = renewing
			.catch(() => undefined)
			.then(async () => {
				if (lost) return;
				if (await lease.renew()) return;
				lost = true;
				controller.abort();
			});
		return renewing.then(() => !lost);
	};
	const timer = setInterval(() => {
		// A renewal that cannot reach the store is tried again; the lease lapses only by the store's clock.
		renew().catch(() => undefined);
	}, LEASE_RENEW_MS);
	timer.unref();
	const held: HeldLease = {
		signal: controller.signal,
		confirm: async () => {
			if (!(await renew())) throw lostRefusal(key);
		},
	};
	let result: T;
	try {
		result = await heldLeases.run([...(heldLeases.getStore() ?? []), held], fn);
	} finally {
		clearInterval(timer);
		await renewing.catch(() => undefined);
		if (!lost) await lease.release().catch(() => undefined);
	}
	if (lost) throw lostRefusal(key);
	return result;
}

/** Renew every lease this writer holds, refused when one was taken over; nothing to do outside a lease. */
export async function fenceHeldLeases(): Promise<void> {
	for (const held of heldLeases.getStore() ?? []) await held.confirm();
}

/** `signal`, also aborted when a lease this writer holds is taken over. */
export function fencedSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
	const signals = [
		...(signal !== undefined ? [signal] : []),
		...(heldLeases.getStore() ?? []).map((held) => held.signal),
	];
	return signals.length === 0 ? undefined : AbortSignal.any(signals);
}
