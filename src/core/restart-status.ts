// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
let handingOver = false;

export function isRestartHandoff(): boolean {
	return handingOver;
}

export function markRestartHandoff(): void {
	handingOver = true;
}
