// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Per-browser preferences in localStorage. Storage can be missing or refuse access (a private window, a
// blocked site); a preference then reads as unset and a choice holds for this tab only.

/** The stored value, or null when it is unset or storage is unavailable. */
export function readPref(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** Stores the value, or removes the preference when it is null. */
export function writePref(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// The choice holds for this tab.
	}
}
