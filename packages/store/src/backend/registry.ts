// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { StoreBackend } from "./backend.js";
import { type StoreBackendKind, StoreRefusal } from "./types.js";

/** Builds a backend from options only its own kind understands. */
export type StoreBackendFactory<Options = never> = (options: Options) => StoreBackend;

const factories = new Map<StoreBackendKind, StoreBackendFactory<unknown>>();

/** Make a backend kind available to `resolveStoreBackend`. A kind registers once. */
export function registerStoreBackend<Options>(kind: StoreBackendKind, factory: StoreBackendFactory<Options>): void {
	if (factories.has(kind)) throw new StoreRefusal("exists", `A store backend of kind ${kind} is already registered.`);
	factories.set(kind, factory as StoreBackendFactory<unknown>);
}

/** The factory registered for `kind`; refuses `unavailable` naming the kinds that are registered. */
export function resolveStoreBackend<Options>(kind: StoreBackendKind): StoreBackendFactory<Options> {
	const factory = factories.get(kind);
	if (factory === undefined) {
		const known = [...factories.keys()].sort().join(", ") || "none";
		throw new StoreRefusal("unavailable", `No store backend of kind ${kind} is registered (registered: ${known}).`);
	}
	return factory as StoreBackendFactory<Options>;
}
