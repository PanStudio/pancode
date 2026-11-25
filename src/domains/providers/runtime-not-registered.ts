// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** Problem text for a target whose runtime id resolves to nothing. */
export function runtimeNotRegistered(runtimeId: string): string {
	return `runtime '${runtimeId}' is not registered`;
}
