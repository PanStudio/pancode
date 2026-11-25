// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { GLYPH } from "./glyphs.js";
import type { PancodeTheme, PancodeToken } from "./tokens.js";
import { onRaisedTheme, paintRaisedSurfaceSpan } from "./yolo-surface.js";

/**
 * Pad or clip a styled string to exactly `width` visible columns.
 *
 * A row that already fits is padded from `visibleWidth`, which reads styled
 * ASCII without segmenting it and caches the rest; `truncateToWidth` walks every
 * escape and grapheme even when nothing is cut, and a dock row passes through
 * here once per enclosing frame (a /settings row is fitted several times a render).
 * Its fits path returns this same string, so only a row that overflows pays for
 * both. `truncateToWidth(…, pad = true)` already returns exactly `width` columns
 * on the cut path, so that result is never measured again.
 */
export function padAnsi(text: string, width: number, ellipsis = ""): string {
	const used = visibleWidth(text);
	if (width > 0 && used <= width) return text + " ".repeat(width - used);
	return truncateToWidth(text, Math.max(0, width), ellipsis, true);
}

/** A row closed on the ellipsis within `width` cells; a row too full for the mark gives up its end to it. */
export function closeWithEllipsis(row: string, width: number): string {
	const mark = visibleWidth(GLYPH.ellipsis);
	if (width <= mark) return GLYPH.ellipsis.slice(0, Math.max(0, width));
	return `${truncateToWidth(row, width - mark, "", false)}${GLYPH.ellipsis}`;
}

/**
 * Join `units` onto `prefix` with the ` · ` separator, fitting the result to
 * `maxWidth` without cutting a unit mid-glyph. A unit that would overflow is
 * dropped whole, along with every later unit, and the line closes with one
 * space plus a dim ellipsis. Room for that marker is reserved while
 * placing every unit except the last. When even the first unit cannot fit,
 * `prefix + first unit` is hard-truncated with an ellipsis so a one-unit line
 * still marks its cut. Width accounting is ANSI-aware via visibleWidth.
 */
export function fitUnits(theme: PancodeTheme, prefix: string, units: readonly string[], maxWidth: number): string {
	return fitUnitsPlan(theme, prefix, units, maxWidth).line;
}

/**
 * How many of `units` the fitted line keeps whole, by the rule `fitUnits`
 * draws by. A first unit that is itself cut counts as not kept, so a caller
 * deciding what else to give up never counts a cut key as shown.
 */
export function fitUnitsKept(theme: PancodeTheme, prefix: string, units: readonly string[], maxWidth: number): number {
	return fitUnitsPlan(theme, prefix, units, maxWidth).kept;
}

function fitUnitsPlan(
	theme: PancodeTheme,
	prefix: string,
	units: readonly string[],
	maxWidth: number,
): { line: string; kept: number } {
	const sep = ` ${GLYPH.sep} `;
	let line = prefix;
	for (let index = 0; index < units.length; index += 1) {
		const candidate = index === 0 ? `${line}${units[index]}` : `${line}${sep}${units[index]}`;
		// Reserve room for the ` …` marker unless this is the last unit.
		const reserve = index < units.length - 1 ? 1 + visibleWidth(GLYPH.ellipsis) : 0;
		if (visibleWidth(candidate) + reserve > maxWidth) {
			if (index === 0) return { line: truncateToWidth(candidate, Math.max(0, maxWidth), GLYPH.ellipsis, false), kept: 0 };
			return { line: `${line} ${theme.fg("annotation", GLYPH.ellipsis)}`, kept: index };
		}
		line = candidate;
	}
	return { line, kept: units.length };
}

export interface RuleOptions {
	left?: string;
	leftToken?: PancodeToken;
	leftRaw?: boolean;
	/**
	 * Cells of fill drawn before the left label, then one space: the overlay title form `━ Models ━━━`. The lead is
	 * drawn the way the rest of the fill is, so a heavy rule leads with heavy cells.
	 */
	leftLead?: number;
	right?: string;
	fillToken?: PancodeToken;
	rightToken?: PancodeToken;
	rightRaw?: boolean;
	rightTail?: string;
	/** Render only the rule's fill, with its absolute starting column. */
	renderFill?: (columns: number, offset: number) => string;
}

export function rule(theme: PancodeTheme, width: number, options: RuleOptions = {}): string {
	const safeWidth = Math.max(0, width);
	if (safeWidth === 0) return "";
	const drawFill = (columns: number, offset: number): string =>
		options.renderFill
			? options.renderFill(columns, offset)
			: theme.style(options.fillToken ?? "divider", GLYPH.rule.repeat(columns), {
					bold: options.fillToken === "composerRail",
				});
	// Without a lead, a left label starts flush at column 0 with a single trailing
	// space before the fill, so labeled rules align with the body under them.
	const leftBody = options.leftRaw
		? options.left
		: theme.style(options.leftToken ?? "sectionHeading", options.left ?? "", { bold: true });
	const leadCells = options.left ? Math.max(0, Math.floor(options.leftLead ?? 0)) : 0;
	const lead = leadCells > 0 ? `${drawFill(leadCells, 0)} ` : "";
	const left = options.left ? `${lead}${leftBody} ` : "";
	const rightBody = options.rightRaw ? options.right : theme.fg(options.rightToken ?? "annotation", options.right ?? "");
	const right = options.right ? ` ${rightBody} ${options.rightTail ?? ""}` : "";
	const labelsWidth = visibleWidth(left) + visibleWidth(right);
	if (labelsWidth >= safeWidth) return truncateToWidth(`${left}${right}`.trim(), safeWidth, "", true);
	return `${left}${drawFill(safeWidth - labelsWidth, visibleWidth(left))}${right}`;
}

export interface FrameOptions {
	/**
	 * Dim right-hand metadata placed just before the closing corner with one
	 * space on each side. The dispatch cards pass a run's elapsed time here.
	 */
	rightMeta?: string;
}

/**
 * A closed framed island. First-party surfaces do not draw one: an
 * out-of-flow summary is an open island (`openIsland` in `primitives.ts`), a
 * titled light rule with indented rows. `frame()` stays for extension panels
 * (`src/interactive/surfaces/*`).
 *
 * ```
 * ┌─ Title ──────────────────── meta ─┐
 * │ body line                         │
 * └───────────────────────────────────┘
 * ```
 *
 * Corners and fills carry the `frame` token. A plain `title` is drawn bold in
 * the `heading` role with exactly one space on each side. A title that already
 * carries its own styling is placed verbatim so its escape sequences are never
 * re-wrapped. The optional `rightMeta` renders dim before the closing corner.
 */
export function frame(
	theme: PancodeTheme,
	title: string,
	lines: readonly string[],
	width: number,
	opts: FrameOptions = {},
): string[] {
	const safeWidth = Math.max(4, width);
	const contentWidth = Math.max(0, safeWidth - 4);
	const frameFg = (text: string): string => theme.fg("border", text);

	const hasTitle = title.length > 0;
	// A title that already carries escape sequences is a pre-styled composite;
	// place it verbatim. A plain title uses the bold `heading` role.
	const styledTitle = !hasTitle ? "" : title.includes("\u001b") ? title : theme.style("heading", title, { bold: true });
	const titleWidth = visibleWidth(title);

	const meta = opts.rightMeta ?? "";
	const hasMeta = meta.length > 0;
	const metaWidth = hasMeta ? visibleWidth(meta) : 0;

	// `┌─`, plus ` Title ` when titled, on the left; `┐`, or ` meta ─┐` when a
	// right meta is present, on the right. The fill is whatever keeps the total
	// width exact.
	const leftVisible = 2 + (hasTitle ? titleWidth + 2 : 0);
	const rightVisible = hasMeta ? metaWidth + 4 : 1;
	const fillWidth = Math.max(0, safeWidth - leftVisible - rightVisible);

	const opening = frameFg(`${GLYPH.topLeft}${GLYPH.rule}`);
	const leftStr = hasTitle ? `${opening} ${styledTitle} ` : opening;
	const rightStr = hasMeta
		? ` ${theme.fg("annotation", meta)} ${frameFg(`${GLYPH.rule}${GLYPH.topRight}`)}`
		: frameFg(GLYPH.topRight);
	const composedTop = `${leftStr}${frameFg(GLYPH.rule.repeat(fillWidth))}${rightStr}`;
	// A title or meta wider than the island is clipped before the corner, so the
	// top border keeps the exact width every body row has.
	const top =
		leftVisible + rightVisible > safeWidth
			? `${truncateToWidth(composedTop, safeWidth - 1, GLYPH.ellipsis, false)}${frameFg(GLYPH.topRight)}`
			: composedTop;

	const body = lines.map(
		(line) => `${frameFg(GLYPH.rail)} ${padAnsi(theme.base("body", line), contentWidth)} ${frameFg(GLYPH.rail)}`,
	);
	const bottom = `${frameFg(GLYPH.bottomLeft)}${frameFg(GLYPH.rule.repeat(safeWidth - 2))}${frameFg(GLYPH.bottomRight)}`;
	return [top, ...body, bottom];
}

/**
 * A full-width run of the inner-divider glyph in the `frame` token, drawn
 * between rows inside an island. Callers pass the island's inner content width.
 */
export function innerDivider(theme: PancodeTheme, width: number): string {
	return theme.fg("divider", GLYPH.innerDivider.repeat(Math.max(0, width)));
}

export interface BoxIslandOptions {
	readonly title: string;
	readonly titleToken?: PancodeToken;
	readonly borderToken?: PancodeToken;
	readonly rightMeta?: string;
	readonly rightMetaRaw?: boolean;
	readonly lines: readonly string[];
	readonly width: number;
}

/**
 * Boxed console island painted on `raisedSurface` with light-theme contrast lift (`overOwned`)
 * on borders, corners, and interior fills. Uses `GLYPH` box characters so `PANCODE_ASCII`
 * and `NO_COLOR` degrade cleanly without color escapes or non-ASCII bytes.
 */
export function boxIsland(baseTheme: PancodeTheme, opts: BoxIslandOptions): string[] {
	const safeWidth = Math.max(6, Math.floor(opts.width));
	const contentWidth = Math.max(1, safeWidth - 4);
	const theme = onRaisedTheme(baseTheme);
	const border = (text: string): string => theme.fg(opts.borderToken ?? "border", text);

	const titleStyled = opts.title
		? opts.title.includes("\u001b")
			? opts.title
			: theme.style(opts.titleToken ?? "sectionHeading", opts.title, { bold: true })
		: "";
	const titleWidth = visibleWidth(titleStyled);

	const rawMeta = opts.rightMeta ?? "";
	const metaStyled = !rawMeta
		? ""
		: opts.rightMetaRaw || rawMeta.includes("\u001b")
			? rawMeta
			: theme.fg("annotation", rawMeta);
	const metaWidth = visibleWidth(metaStyled);

	const opening = border(`${GLYPH.topLeft}${GLYPH.rule}`);
	const leftStr = titleWidth > 0 ? `${opening} ${titleStyled} ` : opening;
	const leftWidth = 2 + (titleWidth > 0 ? titleWidth + 2 : 0);
	const rightStr = metaWidth > 0 ? ` ${metaStyled} ${border(`${GLYPH.rule}${GLYPH.topRight}`)}` : border(GLYPH.topRight);
	const rightWidth = metaWidth > 0 ? metaWidth + 4 : 1;

	let topRaw: string;
	if (leftWidth + rightWidth <= safeWidth) {
		const fill = safeWidth - leftWidth - rightWidth;
		topRaw = `${leftStr}${border(GLYPH.rule.repeat(fill))}${rightStr}`;
	} else if (titleWidth > 0 && leftWidth + 1 <= safeWidth) {
		// Drop right meta first if tight so title stays readable.
		const fill = Math.max(0, safeWidth - leftWidth - 1);
		topRaw = `${leftStr}${border(GLYPH.rule.repeat(fill))}${border(GLYPH.topRight)}`;
	} else {
		topRaw = `${truncateToWidth(leftStr, safeWidth - 1, GLYPH.ellipsis, false)}${border(GLYPH.topRight)}`;
	}

	const top = paintRaisedSurfaceSpan(baseTheme, topRaw, safeWidth, GLYPH.ellipsis);
	const body = opts.lines.map((line) => {
		const inner = `${border(GLYPH.rail)} ${padAnsi(line, contentWidth, GLYPH.ellipsis)} ${border(GLYPH.rail)}`;
		return paintRaisedSurfaceSpan(baseTheme, inner, safeWidth, GLYPH.ellipsis);
	});
	const bottomRaw = `${border(GLYPH.bottomLeft)}${border(GLYPH.rule.repeat(Math.max(0, safeWidth - 2)))}${border(GLYPH.bottomRight)}`;
	const bottom = paintRaisedSurfaceSpan(baseTheme, bottomRaw, safeWidth, GLYPH.ellipsis);
	return [top, ...body, bottom];
}
