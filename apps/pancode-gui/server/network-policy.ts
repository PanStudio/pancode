// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Each app isolate denies ambient fetch. Only pinned tool downloads retain the capability. */
export function restrictNetwork() {
	const download = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("Web server network requests must use the pinned programs downloader.");
	};
	return download;
}
