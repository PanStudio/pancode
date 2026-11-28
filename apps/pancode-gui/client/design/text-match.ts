// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Every whitespace-separated query term appears somewhere in the values, case-insensitively. */
export function matchesText(query: string, values: readonly (string | null | undefined)[]): boolean {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
	const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
	return terms.every((term) => text.includes(term));
}
