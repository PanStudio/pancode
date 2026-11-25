// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The near-miss suggestion an unknown subcommand or flag ends with: the one
 * known name at edit distance 2 or less, appended as `; did you mean 'run'?`.
 *
 * Leaf of the CLI kit: imports nothing.
 */

const MAX_DISTANCE = 2;

/** Damerau-Levenshtein (optimal string alignment), so a swapped pair such as `rnu` counts as one edit. */
function editDistance(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const d: number[][] = Array.from({ length: rows }, (_, i) =>
		Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < cols; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const row = d[i] as number[];
			const above = d[i - 1] as number[];
			let best = Math.min((above[j] as number) + 1, (row[j - 1] as number) + 1, (above[j - 1] as number) + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				best = Math.min(best, ((d[i - 2] as number[])[j - 2] as number) + 1);
			row[j] = best;
		}
	}
	return (d[a.length] as number[])[b.length] as number;
}

/**
 * The closest of `known` to `input` within edit distance 2, or null when none is that close or two tie. Flags compare
 * without their dashes and come back with them, so `--modle` finds `--model`.
 */
function closestName(input: string, known: Iterable<string>): string | null {
	const bare = (name: string): string => name.replace(/^-+/u, "").split("=")[0] ?? "";
	const wanted = bare(input).toLowerCase();
	if (wanted.length === 0) return null;
	let best: string | null = null;
	let bestDistance = MAX_DISTANCE + 1;
	let tied = false;
	for (const name of new Set(known)) {
		const candidate = bare(name).toLowerCase();
		if (candidate === wanted) continue;
		const distance = editDistance(wanted, candidate);
		// A one-letter input is within two edits of every short name, so the match must be closer than the input is long.
		if (distance >= wanted.length && distance >= candidate.length) continue;
		if (distance < bestDistance) {
			best = name;
			bestDistance = distance;
			tied = false;
		} else if (distance === bestDistance) tied = true;
	}
	return best !== null && !tied ? best : null;
}

/** `; did you mean '<name>'?` for the closest known name, or the empty string. */
export function didYouMean(input: string, known: Iterable<string>): string {
	const name = closestName(input, known);
	return name === null ? "" : `; did you mean '${name}'?`;
}
