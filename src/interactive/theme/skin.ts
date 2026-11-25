// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ExtensionSkin } from "@pancode/sdk/extension";
import { setPaletteSkin } from "./tokens.js";

/** Admission validates the skin; the theme only owns its reversible palette projection. */
export function applySkin(skin: ExtensionSkin | null): void {
	setPaletteSkin(skin?.palette);
}
