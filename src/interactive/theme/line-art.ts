// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { asciiOnly } from "../../core/terminal-preferences.js";
import { GLYPH } from "./glyphs.js";

// grok-mermaid draws its frames and edges in Unicode only. Under ASCII each line-art cell takes a one-cell ASCII
// glyph, so the diagram keeps its geometry; labels are the model's text and stay as written.
export const MERMAID_LINE_ART: ReadonlyMap<string, string> | null = asciiOnly()
	? new Map([
			...[..."─━"].map((c) => [c, GLYPH.rule] as const),
			...[..."│┃╎"].map((c) => [c, GLYPH.rail] as const),
			["╌", GLYPH.innerDivider],
			...[..."┌┐└┘╭╮╰╯┏┓┗┛├┤┬┴┼┣┫┳┻╋"].map((c) => [c, GLYPH.topLeft] as const),
			...[..."▼▽"].map((c) => [c, GLYPH.down] as const),
			...[..."▲△"].map((c) => [c, GLYPH.up] as const),
			...[..."▶▷"].map((c) => [c, GLYPH.right] as const),
			...[..."◄◁"].map((c) => [c, GLYPH.left] as const),
			...[..."●◇"].map((c) => [c, GLYPH.hollow] as const),
			["◆", GLYPH.workerAgent],
			["×", GLYPH.times],
		])
	: null;
