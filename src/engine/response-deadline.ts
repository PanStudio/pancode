// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Internal request option carried through adapter spreads without reaching provider payloads. */
export const RESPONSE_DEADLINE = Symbol("pancode.response-deadline");

type DeadlineOptions = { [RESPONSE_DEADLINE]?: () => () => void };

/** Residency waits and model loads precede the provider's response deadline. */
export function deferResponseDeadline(options: object): () => void {
	return (options as DeadlineOptions)[RESPONSE_DEADLINE]?.() ?? (() => {});
}
