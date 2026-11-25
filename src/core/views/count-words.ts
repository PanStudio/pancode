// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A count with its noun, singular for one: `1 call`, `2 calls`, `1,204 matches`. Every shared view says a count this
 * way, so no surface reads `1 runs`. Browser-safe: no imports.
 */
export function countNoun(count: number, one: string, many = `${one}s`): string {
	return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}
