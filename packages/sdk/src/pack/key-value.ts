// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

export const RUNTIME_STATE_LIMITS = {
	stateBytes: 256 * 1024,
	storeBytes: 1024 * 1024,
	keys: 256,
} as const;

export type KeyValueScope = "state" | "store";

export interface KeyValueEntry {
	value: unknown;
	version: number;
}

export type KeyValueTable = Record<string, KeyValueEntry>;

/** Host-held values a runtime reaches only by asking: session state and the cross-session store. */
export interface ExtensionKeyValueHost {
	get(scope: KeyValueScope, key: string): { value: unknown; version: number };
	set(scope: KeyValueScope, key: string, value: unknown, ifVersion?: number): { ok: boolean; version: number };
	delete(scope: KeyValueScope, key: string): void;
	keys(scope: KeyValueScope): string[];
}

export function checkKeyValueLimits(scope: KeyValueScope, next: KeyValueTable): void {
	const limit = scope === "state" ? RUNTIME_STATE_LIMITS.stateBytes : RUNTIME_STATE_LIMITS.storeBytes;
	if (Object.keys(next).length > RUNTIME_STATE_LIMITS.keys)
		throw new Error(`${scope} holds at most ${RUNTIME_STATE_LIMITS.keys} keys`);
	if (Buffer.byteLength(JSON.stringify(next)) > limit) throw new Error(`${scope} exceeds ${limit} bytes`);
}

/** Versions and compare-and-set over tables the caller reads and commits. */
export function createKeyValueHost(
	table: (scope: KeyValueScope) => KeyValueTable,
	commit: (scope: KeyValueScope, next: KeyValueTable) => void,
): ExtensionKeyValueHost {
	return {
		get(scope, key) {
			return table(scope)[key] ?? { value: undefined, version: 0 };
		},
		set(scope, key, value, ifVersion) {
			const current = table(scope);
			const version = current[key]?.version ?? 0;
			if (ifVersion !== undefined && ifVersion !== version) return { ok: false, version };
			commit(scope, { ...current, [key]: { value, version: version + 1 } });
			return { ok: true, version: version + 1 };
		},
		delete(scope, key) {
			const current = table(scope);
			if (!Object.hasOwn(current, key)) return;
			const { [key]: _removed, ...rest } = current;
			commit(scope, rest);
		},
		keys(scope) {
			return Object.keys(table(scope));
		},
	};
}

/** The author kit shares version and compare-and-set behavior with durable runtime state. */
export function createMemoryKeyValueHost(): ExtensionKeyValueHost {
	const tables: Record<KeyValueScope, KeyValueTable> = { state: {}, store: {} };
	return createKeyValueHost(
		(scope) => tables[scope],
		(scope, next) => {
			checkKeyValueLimits(scope, next);
			tables[scope] = next;
		},
	);
}
