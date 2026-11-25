// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFileSync } from "node:fs";

/** A JSON file's parsed value, or null when the file is absent, unreadable or not JSON. */
export function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** A JSON file that holds an object; null for anything else, including an array. */
export function readJsonObjectFile(path: string): Record<string, unknown> | null {
	const parsed = readJsonFile(path);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
}
