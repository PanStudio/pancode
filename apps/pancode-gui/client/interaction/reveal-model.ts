// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Where a horizontally scrolling bar scrolls so its current item is in view. Pure, so node:test covers it;
// `use-reveal-current.ts` reads the DOM and calls it.

/**
 * The bar's next `scrollLeft`: unchanged while the item at `start` (in the bar's scroll coordinates) with
 * width `size` is fully in view, else the least scroll that brings it in. An item wider than the bar shows
 * its start.
 */
export function revealScroll(scrollLeft: number, viewWidth: number, start: number, size: number): number {
	const end = start + size;
	if (start < scrollLeft || size > viewWidth) return Math.max(0, start);
	if (end > scrollLeft + viewWidth) return Math.max(0, end - viewWidth);
	return scrollLeft;
}
