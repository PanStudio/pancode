// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { prefixScore } from "./prefix-score.js";

/** What the palette ranks: a row's visible words, its hidden keywords, and whether it can run now. */
export interface RankableCommand {
	readonly title: string;
	readonly group: string;
	readonly keywords?: readonly string[];
	readonly available: boolean;
}

/**
 * Prefix-by-word rather than the reference's substring rule, because a palette must feel like a
 * launcher. Ties break on the order the caller composed, then alphabetically, so the ranking is
 * stable between keystrokes.
 */
export function rankCommands<T extends RankableCommand>(commands: readonly T[], query: string): T[] {
	const needle = query.trim();
	return commands
		.filter((command) => command.available)
		.map((command, index) => ({
			command,
			index,
			score: prefixScore([command.title, command.group, ...(command.keywords ?? [])], needle),
		}))
		.filter((scored) => scored.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.index - right.index ||
				left.command.title.localeCompare(right.command.title, "en-US"),
		)
		.map((scored) => scored.command);
}
