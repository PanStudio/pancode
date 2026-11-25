// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
globalThis.fetch = async () => {
	throw new Error("Uninjected network access is forbidden in the web test suite.");
};
