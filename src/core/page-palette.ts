// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Hex, PaletteColor, ThemeBackground } from "./theme-token-hex.js";
import { paletteProjection } from "./theme-token-hex.js";

/** Page surfaces the terminal palette leaves to the terminal: black, void2 and void4 on dark; mist1, mist2 and mist3 on light. */
const PAGE_SURFACES = {
	ground: { dark: "#000000", light: "#f5f3ee" },
	well: { dark: "#131312", light: "#ebe8e1" },
	line: { dark: "#292926", light: "#dcd8cf" },
} as const satisfies Record<string, Record<ThemeBackground, Hex>>;

const PAGE_INKS = {
	ink: "neutralStrong",
	muted: "neutralSupporting",
	accent: "cyanFocal",
	success: "success",
	alert: "error",
} as const satisfies Record<string, PaletteColor>;

type PageSurface = keyof typeof PAGE_SURFACES;
export type PageColor = PageSurface | keyof typeof PAGE_INKS;

function isPageSurface(color: PageColor): color is PageSurface {
	return Object.hasOwn(PAGE_SURFACES, color);
}

/** One brand palette for the HTML pages PanCode writes outside the terminal: sign-in results and exports. */
export function pageHex(color: PageColor, background: ThemeBackground): Hex {
	return isPageSurface(color) ? PAGE_SURFACES[color][background] : paletteProjection(PAGE_INKS[color], background)[0];
}

/** CSS custom properties, `--<name>:<hex>;` each, for a page stylesheet. */
export function pageColorVars(names: Readonly<Record<string, PageColor>>, background: ThemeBackground): string {
	return Object.entries(names)
		.map(([name, color]) => `--${name}:${pageHex(color, background)};`)
		.join("");
}
