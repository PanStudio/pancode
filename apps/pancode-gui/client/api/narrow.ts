// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Readers for wire values whose shape nothing upstream promised. Each returns its fallback instead of throwing.

/** Any object, arrays included; an empty record otherwise. */
export const fields = (value: unknown): Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** A plain object, not an array; undefined otherwise. */
export function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** A non-empty string; null otherwise. */
export const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export const finite = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export const integer = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;

export const flag = (value: unknown): boolean => value === true;

/** A count read with `integer`, worded for an operator. */
export const amount = (value: number | null): string =>
	value === null ? "not reported" : value.toLocaleString("en-US");
