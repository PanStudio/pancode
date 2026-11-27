// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** A portable plugin id: the directory name a plugin installs under, so it never names the state file. */
export function isPluginId(value: string): boolean {
	return (
		value.length <= 64 && /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value) && value !== "state.json"
	);
}
