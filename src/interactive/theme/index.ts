// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createPancodeTheme, type PancodeTheme } from "./tokens.js";

let sharedTheme: PancodeTheme | null = null;

export function pancodeTheme(): PancodeTheme {
	sharedTheme ??= createPancodeTheme();
	return sharedTheme;
}

export * from "./components.js";
export * from "./functions.js";
export * from "./glyphs.js";
export * from "./labels.js";
export * from "./primitives.js";
export * from "./rules.js";
export * from "./segments.js";
export { applySkin } from "./skin.js";
export * from "./tokens.js";
export { onRaisedTheme, paintRaisedSurfaceRow, paintRaisedSurfaceSpan } from "./yolo-surface.js";
