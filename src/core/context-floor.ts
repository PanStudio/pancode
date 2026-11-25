// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The context placeholder a runtime descriptor states before the server reports a window.
 * Resolution never promotes a descriptor context placeholder to a serving
 * limit; an unreported window remains unknown.
 */
export const PANCODE_MIN_CONTEXT_WINDOW = 131_072;

/** Default requested output budget when no narrower request or model cap exists. */
export const PANCODE_MIN_MAX_OUTPUT_TOKENS = 32_768;
