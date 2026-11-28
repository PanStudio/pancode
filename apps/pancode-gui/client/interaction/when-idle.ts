// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** Runs `run` once the browser is idle, or after `fallbackMs` where it cannot say. Returns the cancel. */
export function whenIdle(run: () => void, fallbackMs: number): () => void {
	if (typeof requestIdleCallback === "function") {
		const handle = requestIdleCallback(run, { timeout: 3000 });
		return () => cancelIdleCallback(handle);
	}
	const handle = setTimeout(run, fallbackMs);
	return () => clearTimeout(handle);
}
