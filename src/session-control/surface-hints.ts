// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Commands a session-control notice names as the way on. The TUI and ACP take slash commands; a headless
 * `pancode run` takes none, so its notices name the CLI verb or flag that does the same thing.
 */

/** The compaction command on this surface; a headless run names its own session when it has one. */
export function compactCommandHint(headless: boolean, sessionId?: string): string {
	return headless ? `pancode session compact ${sessionId ?? "<session>"}` : "/context compact";
}

/** How the operator picks another route on this surface. */
export function routeCommandHint(headless: boolean): string {
	return headless ? "--model" : "/model";
}
