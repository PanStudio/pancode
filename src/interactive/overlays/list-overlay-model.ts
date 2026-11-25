// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The rows a list overlay draws: the item, cell and tab shapes callers build, the rows-mode detail builders, and
 * the grouping a search result is drawn in. The view in `list-overlay.ts` owns the keyboard, the layout and the frame.
 */

import { tierRevision } from "../../core/presentation-tier.js";
import { Markdown } from "../../engine/tui.js";
import { markdownTheme, pancodeTheme } from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";

/**
 * Row width at and below which a two-column row draws `narrowLead`. It is the
 * content width of an 80-column terminal, where the help list lost every
 * description to the flags in front of it.
 */
export const NARROW_ROW_WIDTH = 76;

export interface RenderedRow {
	type: "group" | "item";
	groupName?: string;
	item?: ListOverlayItem;
	itemIndex?: number;
}

export interface ListOverlayCells {
	/** The first column: a usage, a key, a name. Shares one width with every other row that has cells. */
	lead: string;
	/** A shorter lead drawn at or below `NARROW_ROW_WIDTH`, so flags go before the description does. */
	narrowLead?: string;
	/** The second column, which takes the rest of the row. */
	text: string;
}

export interface ListOverlayItem {
	id: string;
	/** Left-column text, already themed by the caller. The filter matches this text. */
	label: string;
	/**
	 * Draw the row as two aligned columns instead of `label`. The lead column
	 * is as wide as the widest lead among the rows, at most two fifths of the
	 * row, so a reference list reads as a table without a fixed padding that a
	 * long usage overran and a short one left empty.
	 */
	cells?: ListOverlayCells;
	/** Optional dim right-aligned column (origin, scope, version...). */
	meta?: string;
	/** Group header this item renders under, e.g. "project", "marketplace". */
	group?: string;
	/** False when the group names the rows' owner rather than the row, so search skips it. */
	searchGroup?: boolean;
	/**
	 * Lines for the detail pane, lazily computed at the pane's real width.
	 * Markdown by default; `detailFormat: "rows"` says the lines are already
	 * laid out from the design primitives and the pane only wraps a line that
	 * overruns it. Providers that laid themselves out at a guessed width had
	 * their own wrapped lines re-wrapped by the pane, which repeated the row
	 * label on every continuation line.
	 */
	detail?: (width: number) => string[];
	detailFormat?: "markdown" | "rows";
	/**
	 * The selection in one row, drawn under the list at the compact tier. Absent, it is the first of `facts`, or the
	 * first detail row after the title.
	 */
	summary?: (width: number) => string;
	/**
	 * The selection's key facts, two to four rows, drawn under a list that has no pane at the standard and detailed
	 * tiers. Absent, they are the first detail rows after the title.
	 */
	facts?: (width: number) => string[];
	/**
	 * Rows-mode only: how many leading rows of `detail` stay pinned while the
	 * rest scrolls, so a pane's title, status and keys are on screen at every
	 * scroll offset. Zero or absent scrolls the whole pane.
	 */
	detailHead?: (width: number) => number;
}

/**
 * One tab of a tabbed list overlay.
 *
 * A tab owns its own row set and rebuilds it on demand, so switching tabs
 * re-reads whatever the rows describe rather than serving a snapshot taken when
 * the overlay opened. The counts drawn in the tab bar come from the same call,
 * which is why an install that lands on one tab corrects every tab's count.
 */
export interface ListOverlayTab {
	id: string;
	label: string;
	items: () => ReadonlyArray<ListOverlayItem>;
	/** Optional footer count wording; defaults to the count followed by the tab label. */
	countLabel?: (count: number) => string;
	/**
	 * The count the tab bar states, given the rows the tab holds now; defaults to their number. A tab drilled
	 * into one entry's members states its own catalog here, while the footer still counts the rows on screen.
	 */
	count?: (rows: ReadonlyArray<ListOverlayItem>) => number;
}

/**
 * Best-ranked rows keep their rank inside their group, and the group with the best
 * row comes first, so the cursor starts on the top row and arrows walk the draw order.
 * Rows with no group draw above every group, so they lead here too.
 */
export function groupedByBestMatch(ranked: readonly ListOverlayItem[]): ListOverlayItem[] {
	const groups = new Map<string | undefined, ListOverlayItem[]>([[undefined, []]]);
	for (const item of ranked) {
		const members = groups.get(item.group);
		if (members) members.push(item);
		else groups.set(item.group, [item]);
	}
	return [...groups.values()].flat();
}

/** A rows-mode pane in two parts: the head the engine pins while the rest scrolls. */
export interface DetailParts {
	head: string[];
	rest: string[];
}

/**
 * The detail fields of a rows-mode item from a builder that separates the
 * pinned head from the rest. Built once per width and skin, and served to both
 * the rows and the head count.
 */
export function detailWithHead(
	build: (width: number) => DetailParts,
): Pick<ListOverlayItem, "detail" | "detailHead" | "detailFormat"> {
	let memo: { width: number; epoch: number; tier: number; parts: DetailParts } | null = null;
	const parts = (width: number): DetailParts => {
		if (memo && memo.width === width && memo.epoch === skinEpoch() && memo.tier === tierRevision()) return memo.parts;
		memo = { width, epoch: skinEpoch(), tier: tierRevision(), parts: build(width) };
		return memo.parts;
	};
	return {
		detailFormat: "rows",
		detail: (width) => {
			const built = parts(width);
			return [...built.head, ...built.rest];
		},
		detailHead: (width) => parts(width).head.length,
	};
}

/**
 * Prose under a rows-mode detail: Markdown rendered at the pane's width, so a
 * description's code spans, emphasis and links keep their styling beneath the
 * fact table instead of showing their markup.
 */
export function markdownRows(text: string, width: number): string[] {
	return new Markdown(text, 0, 0, markdownTheme(pancodeTheme())).render(Math.max(1, Math.floor(width)));
}
