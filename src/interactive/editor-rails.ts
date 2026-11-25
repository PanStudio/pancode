// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { GLYPH, type PancodeTheme, type PancodeToken, type RuleOptions, rule } from "./theme/index.js";

export interface EditorRailState {
	phase: "idle" | "working" | "attention";
	yolo: boolean;
	animate: boolean;
	now: number;
	/** The rail's own ink while a decision owns the editor; otherwise the composer rail, or the attention rail in yolo. */
	tone?: PancodeToken;
}

/** Presentation only. Reuses the existing render ticker; never owns input or timers. */
export function renderEditorRail(
	theme: PancodeTheme,
	width: number,
	options: RuleOptions,
	state: EditorRailState,
): string {
	const attention = state.phase === "attention";
	const base: PancodeToken = state.tone ?? (state.yolo ? "attentionRail" : "composerRail");
	const pulse: PancodeToken = base === "attentionRail" ? "attention" : "attentionRail";
	const paint = (columns: number, token: PancodeToken): string =>
		theme.style(token, GLYPH.laneRule.repeat(columns), { bold: true });
	if (!attention || !state.animate) {
		return rule(theme, width, {
			...options,
			fillToken: base,
			rightTail: options.rightTail ?? paint(1, base),
			renderFill: (columns) => paint(columns, base),
		});
	}
	// Both rails share a viewport coordinate, so labels never put their pulses out of step.
	const center = Math.floor(((state.now % 3600) / 3600) * (width + 8)) - 4;
	const renderFill = (columns: number, offset: number): string => {
		let output = "";
		let runToken: PancodeToken = base;
		let run = 0;
		for (let column = 0; column < columns; column += 1) {
			let token: PancodeToken = base;
			const distance = state.animate ? Math.abs(column + offset - center) : column + offset;
			if (distance < 4) {
				token = pulse;
			}
			if (run > 0 && runToken !== token) {
				output += paint(run, runToken);
				run = 0;
			}
			runToken = token;
			run += 1;
		}
		return output + (run > 0 ? paint(run, runToken) : "");
	};
	return rule(theme, width, {
		...options,
		fillToken: base,
		rightTail: options.rightTail ?? renderFill(1, Math.max(0, width - 1)),
		renderFill,
	});
}
