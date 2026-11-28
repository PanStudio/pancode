// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFile } from "node:fs/promises";
import type { UsageSnapshot } from "./types.js";

/** Snapshot builder bound to one provider's id, display name and clock. */
export function snapshotFactory(
	providerId: string,
	displayName: string,
	now: () => Date,
): (status: UsageSnapshot["status"], message: string | null, extra?: Partial<UsageSnapshot>) => UsageSnapshot {
	return (status, message, extra = {}) => ({
		providerId,
		displayName,
		status,
		windows: [],
		message,
		fetchedAt: now().toISOString(),
		...extra,
	});
}

/** Read and parse a JSON credentials file; a missing, unreadable or malformed file reads as null. */
export async function readJsonCredentials<T>(path: string, parse: (raw: unknown) => T | null): Promise<T | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		return parse(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Settle with `work`, or reject once `signal` aborts; a body read the abort outran is left to settle unobserved. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	work.catch(() => undefined);
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export function asNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function asIsoString(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function describeError(error: unknown, timeoutMs: number): string {
	if (error instanceof Error) {
		return error.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error.message;
	}
	return String(error);
}

export async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		return;
	}
}
