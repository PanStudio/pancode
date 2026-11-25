// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Both package engines use the same exact-tree framing, so a digest computed
// for one is directly comparable to a digest computed for the other.
export {
	extensionContentDigest as pluginContentDigest,
	extensionContentDigestWithCapture as pluginContentDigestWithCapture,
} from "../extensions/integrity.js";
