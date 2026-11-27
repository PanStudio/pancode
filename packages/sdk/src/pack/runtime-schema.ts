// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { stripVTControlCharacters } from "node:util";

export const RUNTIME_LIMITS = {
	argumentBytes: 16 * 1024,
	startupMs: 5000,
	commandMs: 30000,
	disposeMs: 250,
	diagnosticsBytes: 64 * 1024,
} as const;

/** Terminal control sequences and C0/C1 controls never reach a host renderer. */
export function extensionPlainText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}
