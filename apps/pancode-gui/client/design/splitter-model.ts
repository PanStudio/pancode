// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

export interface SplitterBounds {
	readonly min: number;
	readonly max: number;
	/** The panel never takes more than this share of the host's width. */
	readonly maxShare: number;
}

export function clampWidth(bounds: SplitterBounds, width: number, hostWidth: number): number {
	const ceiling = Math.max(bounds.min, Math.min(bounds.max, hostWidth > 0 ? hostWidth * bounds.maxShare : bounds.max));
	return Math.round(Math.min(ceiling, Math.max(bounds.min, width)));
}

/** A remembered width, capped at the maximum; anything unreadable or below the minimum is no width at all. */
export function storedWidthValue(bounds: SplitterBounds, stored: string | null): number | null {
	const value = Number(stored);
	return Number.isFinite(value) && value >= bounds.min ? Math.min(value, bounds.max) : null;
}
