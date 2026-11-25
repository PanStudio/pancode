// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Terminal projection of the shared identity; startup never reads a website asset. */
export type ThemeBackground = "dark" | "light";
export type Hex = `#${string}`;
export type Rgb = readonly [number, number, number];

export function relativeLuminance(rgb: Rgb): number {
	const channel = (value: number): number => {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
	const x = relativeLuminance(a);
	const y = relativeLuminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

type Projection = readonly [Hex, number];
type RampColor = readonly [Projection, Projection, Projection];

// Each triplet is unknown, dark, light. The middle-luminance fallback remains visible on either ground.
const subdued: RampColor = [
	["#76746f", 243],
	["#9e9d97", 246],
	["#6a6863", 241],
];
const supporting: RampColor = [
	["#76746f", 243],
	["#a6a297", 247],
	["#53514b", 239],
];
const reading: RampColor = [
	["#76746f", 243],
	["#d6d2c7", 252],
	["#2d2c28", 236],
];
const focal: RampColor = [
	["#767572", 243],
	["#e4e2dc", 254],
	["#1f1e1a", 234],
];
const strong: RampColor = [
	["#767572", 243],
	["#f1eee6", 255],
	["#0f0e0c", 232],
];
const jade: RampColor = [
	// On an unknown ground slot 29 is the only AA green; reserve it for the brand.
	// Success keeps its check and a neutral ink at this depth.
	["#1f836f", 243],
	["#34dbb9", 79],
	["#026b58", 23],
];
const amber: RampColor = [
	["#966e04", 243],
	["#f2b106", 214],
	["#765400", 94],
];
const red: RampColor = [
	["#c15149", 131],
	["#ff6b60", 203],
	["#ac0512", 124],
];
const rule: RampColor = [
	["#76756f", 243],
	["#837f76", 244],
	["#77746b", 243],
];
const violet: RampColor = [
	["#7b6ea0", 98],
	["#c3affe", 147],
	["#6343a6", 61],
];

/** The key names are the published extension skin vocabulary, not instructions to render that hue.
 * Indexed green and jade step down on light so words clear both the selection wash and a cream terminal. */
export const TERMINAL_PALETTE = {
	neutralSubdued: subdued,
	neutralSupporting: supporting,
	neutralReading: reading,
	neutralFocal: focal,
	neutralStrong: strong,
	ivorySubdued: subdued,
	ivorySupporting: supporting,
	ivoryReading: reading,
	ivoryFocal: focal,
	ivoryStrong: strong,
	cyanSupporting: [
		["#06864b", 29],
		["#25b469", 35],
		["#0c562f", 22],
	],
	cyanReading: [
		["#03864a", 29],
		["#18d77c", 42],
		["#137643", 22],
	],
	cyanFocal: [
		["#02874a", 29],
		["#00e884", 42],
		["#137643", 22],
	],
	cyanStrong: [
		["#278550", 29],
		["#57eb95", 78],
		["#0c562f", 22],
	],
	turquoise: [
		["#54789c", 63],
		["#7dbdfd", 111],
		["#0d5d9d", 25],
	],
	cyanDeep: violet,
	orangeSupporting: [
		["#4278ad", 32],
		["#aed5fd", 153],
		["#0d5d9d", 25],
	],
	orangeReading: [
		["#4278ad", 32],
		["#7dbdfd", 111],
		["#0d5d9d", 25],
	],
	// Light steps down to azure700: azure600 measures 4.47:1 on the light composer surface.
	orangeFocal: [
		["#1178c8", 32],
		["#4aa8ff", 75],
		["#0d5d9d", 25],
	],
	orangeStrong: [
		["#4278ad", 32],
		["#aed5fd", 153],
		["#093f6c", 24],
	],
	successSupporting: jade,
	success: jade,
	syntaxLiteral: violet,
	warningSupporting: amber,
	warning: amber,
	errorSupporting: red,
	error: red,
	border: rule,
	meterTrack: rule,
	divider: rule,
	surface: [
		["#0b0b0a", 232],
		["#0b0b0a", 232],
		["#ffffff", 231],
	],
	selectionSurface: [
		["#021a0b", 232],
		["#021a0b", 232],
		["#e1f9e7", 255],
	],
	yoloSurface: [
		["#201300", 233],
		["#201300", 233],
		["#fdf0d9", 230],
	],
	onAccent: [
		["#000000", 16],
		["#000000", 16],
		["#ffffff", 231],
	],
} as const satisfies Record<string, RampColor>;

export type PaletteColor = keyof typeof TERMINAL_PALETTE;

// ANSI slots are operator-defined. Use normal foreground for reading, not bright black;
// tint marks and labels, not the surrounding paragraph. Hue never carries a verdict alone.
const DIM = { sgr: "39;2" } as const;
const INK = { sgr: "39" } as const;
const GREEN = { sgr: "32", dark: "92" } as const;
const PURPLE = { sgr: "35", dark: "95" } as const;
const JADE = { sgr: "36", dark: "96" } as const;
const AMBER = { sgr: "33", dark: "93" } as const;
const RED = { sgr: "31", dark: "91" } as const;
const BLUE = { sgr: "34", dark: "94" } as const;
export const ANSI16: Readonly<Record<PaletteColor, { readonly sgr: string; readonly dark?: string }>> = {
	neutralSubdued: DIM,
	neutralSupporting: INK,
	neutralReading: INK,
	neutralFocal: INK,
	neutralStrong: INK,
	ivorySubdued: DIM,
	ivorySupporting: INK,
	ivoryReading: INK,
	ivoryFocal: INK,
	ivoryStrong: INK,
	cyanSupporting: GREEN,
	cyanReading: GREEN,
	cyanFocal: GREEN,
	cyanStrong: GREEN,
	turquoise: BLUE,
	cyanDeep: PURPLE,
	orangeSupporting: BLUE,
	orangeReading: BLUE,
	orangeFocal: BLUE,
	orangeStrong: BLUE,
	successSupporting: JADE,
	success: JADE,
	syntaxLiteral: PURPLE,
	warningSupporting: AMBER,
	warning: AMBER,
	errorSupporting: RED,
	error: RED,
	border: DIM,
	meterTrack: DIM,
	divider: DIM,
	surface: INK,
	selectionSurface: INK,
	yoloSurface: INK,
	onAccent: INK,
};

export function paletteProjection(color: PaletteColor, background: ThemeBackground | null = null): Projection {
	return TERMINAL_PALETTE[color][background === "dark" ? 1 : background === "light" ? 2 : 0];
}

/** Named color tokens painted by the theme and accepted as configured roster colors. */
export const NAMED_TOKEN_COLOR = {
	editor: "cyanFocal",
	editorDanger: "error",
	editorAction: "orangeFocal",
	editorYoloBackground: "yoloSurface",
	editorYoloText: "ivoryFocal",
	accent: "cyanFocal",
	accentDeep: "cyanReading",
	action: "orangeFocal",
	emphasis: "neutralFocal",
	tool: "neutralReading",
	agent: "turquoise",
	success: "success",
	warning: "warning",
	error: "error",
	info: "turquoise",
	reason: "neutralSupporting",
	dim: "neutralSupporting",
	muted: "neutralReading",
	title: "neutralStrong",
	frame: "border",
	frameStrong: "cyanReading",
} as const satisfies Record<string, PaletteColor>;
export type PancodeToken = keyof typeof NAMED_TOKEN_COLOR;

export function tokenHex(token: PancodeToken, background: ThemeBackground | null = null): Hex {
	return paletteProjection(NAMED_TOKEN_COLOR[token], background)[0];
}
