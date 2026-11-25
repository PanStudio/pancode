// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
declare const __PANCODE_BUNDLE_VERSION__: string | undefined;

/** The PanCode version this bundle was built from; null where no build stamped it, such as a test run. */
export const BUNDLE_VERSION: string | null =
	typeof __PANCODE_BUNDLE_VERSION__ === "string" ? __PANCODE_BUNDLE_VERSION__ : null;
