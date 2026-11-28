// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { PancodeSettings } from "../../core/config.js";
import { settingsChangeKind } from "../../core/settings-change-kind.js";

/**
 * Classifies a version-2 settings change into the effect buckets of `settingsChangeKind`
 * (src/core/settings-change-kind.ts).
 *
 * Output is an exhaustive per-bucket list. A single patch can touch multiple buckets;
 * the caller emits the event(s) for every non-empty bucket.
 */

export interface ConfigDiff {
	hotReload: string[];
	nextTurn: string[];
	restartRequired: string[];
}

export function diffSettings(prev: PancodeSettings, next: PancodeSettings): ConfigDiff {
	const changed = collectChangedPaths(prev, next);
	const diff: ConfigDiff = { hotReload: [], nextTurn: [], restartRequired: [] };
	for (const p of changed) {
		diff[settingsChangeKind(p)].push(p);
	}
	return diff;
}

function collectChangedPaths(a: unknown, b: unknown, prefix = ""): string[] {
	if (Object.is(a, b)) return [];
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
		return [prefix || "(root)"];
	}
	const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
	const paths: string[] = [];
	for (const k of keys) {
		const nextPrefix = prefix ? `${prefix}.${k}` : k;
		const av = (a as Record<string, unknown>)[k];
		const bv = (b as Record<string, unknown>)[k];
		paths.push(...collectChangedPaths(av, bv, nextPrefix));
	}
	return paths;
}
