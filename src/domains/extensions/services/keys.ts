// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * Global keys an extension declares in `runtime.keys`. Each is `alt+<letter>`
 * and also answers the same letter in the actions menu, as PanCode's own Alt
 * actions do. A key that PanCode or the operator already uses is refused, and
 * two extensions claiming one key both lose it, so install order never decides
 * what a key does.
 */

import type { ExtensionKeyDeclaration } from "@pancode/sdk/pack";

export const EXTENSION_KEYS_MAX = 2;

const KEY_PATTERN = /^alt\+([a-z])$/u;

/** One extension's declared keys, as the loaded declaration carries them. */
export interface ExtensionKeyClaims {
	extensionId: string;
	keys: ReadonlyArray<ExtensionKeyDeclaration>;
}

/** A key an extension holds this session. `letter` is its actions-menu letter. */
export interface ExtensionKeyBinding {
	extensionId: string;
	key: string;
	letter: string;
	action: string;
	label: string;
}

export interface ExtensionKeyRefusal {
	extensionId: string;
	key: string;
	reason: string;
}

/** The menu letter a declared key answers, or null when the key is not `alt+<letter>`. */
function extensionKeyLetter(key: string): string | null {
	return KEY_PATTERN.exec(key.trim().toLowerCase())?.[1] ?? null;
}

/**
 * Settles every declared key against what is already bound. `taken` names the
 * holder of a key (a built-in default or the operator's own binding);
 * `takenLetters` names the holder of an actions-menu letter.
 */
export function resolveExtensionKeys(
	claims: ReadonlyArray<ExtensionKeyClaims>,
	taken: ReadonlyMap<string, string>,
	takenLetters: ReadonlyMap<string, string>,
): { bound: ExtensionKeyBinding[]; refused: ExtensionKeyRefusal[] } {
	const claimants = new Map<string, Set<string>>();
	for (const claim of claims)
		for (const declared of claim.keys.slice(0, EXTENSION_KEYS_MAX)) {
			const key = declared.key.trim().toLowerCase();
			claimants.set(key, (claimants.get(key) ?? new Set()).add(claim.extensionId));
		}
	const bound: ExtensionKeyBinding[] = [];
	const refused: ExtensionKeyRefusal[] = [];
	for (const claim of claims) {
		for (const declared of claim.keys.slice(0, EXTENSION_KEYS_MAX)) {
			const key = declared.key.trim().toLowerCase();
			const letter = extensionKeyLetter(key);
			const others = [...(claimants.get(key) ?? [])].filter((id) => id !== claim.extensionId);
			const holder = taken.get(key) ?? (letter === null ? undefined : takenLetters.get(letter));
			const reason =
				letter === null
					? `${declared.key} is not an Alt+letter key`
					: holder !== undefined
						? `${declared.key} already runs ${holder}`
						: others.length > 0
							? `${declared.key} is also claimed by ${others.join(", ")}`
							: undefined;
			if (reason !== undefined || letter === null) {
				refused.push({ extensionId: claim.extensionId, key, reason: reason ?? key });
				continue;
			}
			bound.push({ extensionId: claim.extensionId, key, letter, action: declared.action, label: declared.label });
		}
	}
	return { bound, refused };
}
