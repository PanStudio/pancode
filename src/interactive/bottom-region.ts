// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Neutral bottom-region layout manager.
 *
 * Manages ordered TUI chrome regions (optional header strip slot, above-editor rails,
 * editor, and footer stack) under a per-tier, per-width row budget that always preserves
 * the transcript floor. Replaces `rails-budget.ts` and memoizes region allocation by
 * `(width, terminalRows, tier, skinEpoch, factsRevision, editorRows, footerRows)` so
 * per-keystroke and idle renders do no extra work.
 */

import type { OutputStyle } from "../core/defaults.js";
import { presentationTier, tierPolicy, tierRevision } from "../core/presentation-tier.js";
import type { Component } from "../engine/tui.js";
import { truncateToWidth } from "../engine/tui.js";
import { GLYPH, pancodeTheme, widthClass } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

/** Under this many terminal rows, foldable regions yield all rows so the transcript keeps its floor. */
const REGIONS_FOLD_ROWS = 30;
/** Under this many terminal rows (height class H1), optional header strips drop to zero rows. */
const HEADER_MIN_TERMINAL_ROWS = 20;

function regionsFolded(terminalRows: number): boolean {
	return terminalRows < REGIONS_FOLD_ROWS;
}

/** Rows the transcript keeps regardless of chrome height: a third of the terminal, or up to six on a short one. */
function transcriptFloor(terminalRows: number): number {
	const rows = Math.max(0, Math.floor(terminalRows));
	return regionsFolded(rows) ? Math.min(6, Math.ceil(rows / 4)) : Math.ceil(rows / 3);
}

/** A region that offers whole variants of itself, largest first; the budget grants the first that fits. */
export interface VariantRegion extends Component {
	renderVariants(width: number): string[][];
}

export interface RegionRows {
	lines: readonly string[];
	/** Whole variants, largest first. A region that offers them is granted one whole or none, never a cut. */
	variants?: ReadonlyArray<readonly string[]>;
	/** Lower keeps its rows first when the budget is short. */
	priority: number;
	/** Gives up every row while the terminal is folded. */
	foldable?: boolean;
}

export interface BottomRegionSlot {
	readonly id: string;
	readonly component: Component;
	readonly priority: number;
	readonly foldable: boolean;
	/**
	 * True for regions whose own component cache tracks state outside `factsRevision`
	 * (such as the follow-up queue or an extension workspace band). Their `render(width)`
	 * is already O(1)-memoized and its returned array identity guards the budget cache.
	 */
	readonly selfMemoized?: boolean;
}

export interface RegionRowBudgetInput {
	readonly terminalRows: number;
	readonly width: number;
	readonly tier?: OutputStyle;
	readonly editorRows: number;
	readonly footerRows: number;
	readonly headerRows?: number;
}

export interface RegionRowBudget {
	readonly transcriptFloor: number;
	readonly folded: boolean;
	readonly headerCap: number;
	readonly footerCap: number;
	readonly aboveEditorRoom: number;
}

/** Per-tier, per-width row budget for the header strip, above-editor rails, and footer stack. */
function computeRegionBudget(input: RegionRowBudgetInput): RegionRowBudget {
	const rows = Math.max(0, Math.floor(input.terminalRows));
	const policy = tierPolicy(input.tier ?? presentationTier());
	const folded = regionsFolded(rows);
	const floor = transcriptFloor(rows);
	const kind = widthClass(Math.max(1, Math.floor(input.width)));
	const headerMax = rows < HEADER_MIN_TERMINAL_ROWS || kind === "W1" ? 0 : policy.statusRows;
	const headerCap = Math.min(headerMax, Math.max(0, rows - floor - input.editorRows - 1));
	const headerRows = Math.min(headerCap, Math.max(0, Math.floor(input.headerRows ?? 0)));
	const footerCap = Math.max(1, rows - floor - input.editorRows - headerRows);
	const aboveEditorRoom = Math.max(0, rows - floor - input.editorRows - input.footerRows - headerRows);
	return {
		transcriptFloor: floor,
		folded,
		headerCap,
		footerCap,
		aboveEditorRoom,
	};
}

/**
 * Each region's rows within `room`, in the order given. Regions are served by priority. A region with variants gets
 * the first one that fits whole. A region of plain lines that does not fit whole keeps its head and ends on a row
 * saying how many it holds back, so a cut never reads as the whole list.
 */
export function fitRegionRows(
	regions: ReadonlyArray<RegionRows>,
	room: number,
	folded: boolean,
	width: number,
): string[][] {
	const granted: string[][] = regions.map(() => []);
	let left = Math.max(0, Math.floor(room));
	const order = regions
		.map((region, index) => ({ region, index }))
		.sort((a, b) => a.region.priority - b.region.priority);
	for (const { region, index } of order) {
		if (folded && region.foldable === true) continue;
		if (region.variants !== undefined) {
			const fits = region.variants.find((variant) => variant.length <= left);
			if (fits !== undefined) {
				granted[index] = [...fits];
				left -= fits.length;
			}
			continue;
		}
		const lines = region.lines;
		if (lines.length <= left) {
			granted[index] = [...lines];
			left -= lines.length;
			continue;
		}
		if (left === 0) continue;
		const kept = lines.slice(0, left - 1);
		const held = lines.length - kept.length;
		const marker = pancodeTheme().fg("annotation", `  ${GLYPH.ellipsis} ${held} more ${held === 1 ? "row" : "rows"}`);
		granted[index] = [...kept, truncateToWidth(marker, Math.max(1, width), GLYPH.ellipsis, false)];
		left = 0;
	}
	return granted;
}

interface RenderedRegion {
	readonly lines: readonly string[];
	readonly variants?: ReadonlyArray<readonly string[]>;
}

function renderRegion(component: Component, width: number): RenderedRegion {
	const variants = (component as Partial<VariantRegion>).renderVariants?.(width);
	return variants === undefined ? { lines: component.render(width) } : { lines: variants[0] ?? [], variants };
}

export interface BottomRegionSpec {
	/** Optional header strip slot (pinned at top in fullscreen, top of live region in inline mode). */
	readonly headerStrip?: Component;
	readonly aboveEditor: ReadonlyArray<BottomRegionSlot>;
	readonly editor: Component;
	readonly footerStack: ReadonlyArray<Component>;
	readonly getTerminalRows?: () => number;
	/** O(1) monotonic revision from `HarnessFactsSource`; enables width x tier x revision memoization. */
	readonly getFactsRevision?: () => number;
	/** Cheap key for non-facts state affecting bottom regions (e.g. expanded drawer, dock state, or active spinner). */
	readonly getBottomRegionKey?: () => string;
}

export interface BottomRegionManager {
	/** Render the optional header strip within its per-tier, per-width cap. */
	renderHeader(width: number): string[];
	/** Render all components in the ordered footer stack. */
	renderFooterStack(width: number): string[];
	/** Render and budget all above-editor regions for the given frame geometry. */
	budgetAboveEditor(
		width: number,
		editorRows: number,
		footerRows: number,
		headerRows?: number,
	): ReadonlyArray<readonly string[]>;
	/** Slot component for fullscreen `VStack`, preserving child input/mouse handlers and single-pass allocation. */
	createFullscreenSlot(index: number): Component;
	/** Slot component for a pinned fullscreen header strip. */
	createFullscreenHeaderSlot(): Component | null;
	invalidate(): void;
}

interface AboveEditorCache {
	readonly baseKey: string;
	readonly fullKey: string | null;
	readonly allEmpty: boolean;
	readonly selfRefs: ReadonlyArray<readonly string[]>;
	readonly granted: ReadonlyArray<readonly string[]>;
}

interface HeaderCache {
	readonly key: string;
	readonly lines: string[];
}

export function createBottomRegionManager(spec: BottomRegionSpec): BottomRegionManager {
	const allSelfMemoized = spec.aboveEditor.every((slot) => slot.selfMemoized === true);
	const emptyGranted: ReadonlyArray<readonly string[]> = spec.aboveEditor.map(() => []);
	let aboveCache: AboveEditorCache | null = null;
	let headerCache: HeaderCache | null = null;
	let fullscreenGranted: Array<readonly string[] | null> = [];
	let fullscreenWidth = -1;

	const revisionKey = (width: number, terminalRows: number | undefined): string | null => {
		if (spec.getFactsRevision === undefined) return null;
		const dynamic = spec.getBottomRegionKey?.() ?? "";
		return `${width}|${terminalRows ?? -1}|${tierRevision()}|${skinEpoch()}|${spec.getFactsRevision()}|${dynamic}`;
	};

	const renderHeader = (width: number): string[] => {
		const strip = spec.headerStrip;
		if (!strip) return [];
		const rows = spec.getTerminalRows?.();
		const key = revisionKey(width, rows);
		if (key !== null && headerCache !== null && headerCache.key === key) return headerCache.lines;
		const rendered = strip.render(width);
		const lines =
			rows === undefined
				? rendered
				: rendered.slice(
						0,
						computeRegionBudget({
							terminalRows: rows,
							width,
							editorRows: 3,
							footerRows: 1,
							headerRows: rendered.length,
						}).headerCap,
					);
		if (key !== null) headerCache = { key, lines };
		return lines;
	};

	const renderFooterStack = (width: number): string[] => {
		if (spec.footerStack.length === 1) return spec.footerStack[0]?.render(width) ?? [];
		const out: string[] = [];
		for (const part of spec.footerStack) out.push(...part.render(width));
		return out;
	};

	const budgetWithGeometry = (
		width: number,
		fixedRows: () => { editorRows: number; footerRows: number; headerRows: number },
		geometryKeySuffix?: string,
	): ReadonlyArray<readonly string[]> => {
		if (spec.aboveEditor.length === 0) return emptyGranted;
		if (allSelfMemoized) {
			let allEmpty = true;
			const rendered: RenderedRegion[] = [];
			for (const slot of spec.aboveEditor) {
				const region = renderRegion(slot.component, width);
				rendered.push(region);
				if (region.lines.length > 0) allEmpty = false;
			}
			if (allEmpty) return emptyGranted;
			const terminalRows = spec.getTerminalRows?.();
			const baseKey = `${width}|${terminalRows ?? -1}|${tierRevision()}|${skinEpoch()}`;
			const fullKey = geometryKeySuffix !== undefined ? `${baseKey}|${geometryKeySuffix}` : null;
			if (
				aboveCache !== null &&
				fullKey !== null &&
				aboveCache.fullKey === fullKey &&
				rendered.every((region, index) => aboveCache?.selfRefs[index] === region.lines)
			) {
				return aboveCache.granted;
			}
			const granted: ReadonlyArray<readonly string[]> =
				terminalRows === undefined
					? rendered.map((region) => region.lines)
					: fitRegionRows(
							spec.aboveEditor.map((slot, index) => ({
								priority: slot.priority,
								foldable: slot.foldable,
								...(rendered[index] ?? { lines: [] }),
							})),
							computeRegionBudget({
								terminalRows,
								width,
								...fixedRows(),
							}).aboveEditorRoom,
							regionsFolded(terminalRows),
							width,
						);
			if (fullKey !== null) {
				aboveCache = {
					baseKey,
					fullKey,
					allEmpty: false,
					selfRefs: rendered.map((region) => region.lines),
					granted,
				};
			}
			return granted;
		}
		const terminalRows = spec.getTerminalRows?.();
		const baseKey = revisionKey(width, terminalRows);
		const fullKey = baseKey !== null && geometryKeySuffix !== undefined ? `${baseKey}|${geometryKeySuffix}` : null;
		let selfRendered: Map<number, RenderedRegion> | undefined;
		const cacheHit =
			baseKey !== null &&
			aboveCache !== null &&
			((fullKey !== null && aboveCache.fullKey === fullKey) ||
				(fullKey === null && aboveCache.baseKey === baseKey && aboveCache.allEmpty));
		if (cacheHit && aboveCache !== null) {
			let unchanged = true;
			let selfIndex = 0;
			for (let index = 0; index < spec.aboveEditor.length; index += 1) {
				const slot = spec.aboveEditor[index];
				if (!slot?.selfMemoized) continue;
				const next = renderRegion(slot.component, width);
				if (aboveCache.selfRefs[selfIndex] !== next.lines) {
					unchanged = false;
					if (!selfRendered) selfRendered = new Map();
					selfRendered.set(index, next);
				}
				selfIndex += 1;
			}
			if (unchanged) return aboveCache.granted;
		}
		const rendered = spec.aboveEditor.map(
			(slot, index) => selfRendered?.get(index) ?? renderRegion(slot.component, width),
		);
		const allEmpty = rendered.every((region) => region.lines.length === 0);
		let granted: ReadonlyArray<readonly string[]>;
		if (terminalRows === undefined || allEmpty) {
			granted = rendered.map((region) => region.lines);
		} else {
			const { editorRows, footerRows, headerRows } = fixedRows();
			const budget = computeRegionBudget({
				terminalRows,
				width,
				editorRows,
				footerRows,
				headerRows,
			});
			granted = fitRegionRows(
				spec.aboveEditor.map((slot, index) => ({
					priority: slot.priority,
					foldable: slot.foldable,
					...(rendered[index] ?? { lines: [] }),
				})),
				budget.aboveEditorRoom,
				budget.folded,
				width,
			);
		}
		if (baseKey !== null) {
			const selfRefs: Array<readonly string[]> = [];
			for (let index = 0; index < spec.aboveEditor.length; index += 1) {
				if (spec.aboveEditor[index]?.selfMemoized) selfRefs.push(rendered[index]?.lines ?? []);
			}
			aboveCache = { baseKey, fullKey, allEmpty, selfRefs, granted };
		}
		return granted;
	};

	const budgetAboveEditor = (
		width: number,
		editorRows: number,
		footerRows: number,
		headerRows = 0,
	): ReadonlyArray<readonly string[]> =>
		budgetWithGeometry(
			width,
			() => ({ editorRows, footerRows, headerRows }),
			`${editorRows}|${footerRows}|${headerRows}`,
		);

	const takeFullscreen = (index: number, width: number): string[] => {
		if (fullscreenGranted[index] == null || fullscreenWidth !== width) {
			const granted = budgetWithGeometry(width, () => ({
				editorRows: spec.editor.render(width).length,
				footerRows: renderFooterStack(width).length,
				headerRows: renderHeader(width).length,
			}));
			fullscreenGranted = [...granted];
			fullscreenWidth = width;
		}
		const lines = fullscreenGranted[index] ?? [];
		fullscreenGranted[index] = null;
		return [...lines];
	};

	const invalidate = (): void => {
		aboveCache = null;
		headerCache = null;
		fullscreenGranted = [];
		fullscreenWidth = -1;
		spec.headerStrip?.invalidate();
		for (const slot of spec.aboveEditor) slot.component.invalidate();
		spec.editor.invalidate();
		for (const part of spec.footerStack) part.invalidate();
	};

	return {
		renderHeader,
		renderFooterStack,
		budgetAboveEditor,
		createFullscreenSlot(index: number): Component {
			const inner = spec.aboveEditor[index]?.component;
			const slot: Component = {
				render: (width) => takeFullscreen(index, width),
				invalidate: () => {
					aboveCache = null;
					fullscreenGranted = [];
					inner?.invalidate();
				},
			};
			if (inner?.handleInput) slot.handleInput = (data) => inner.handleInput?.(data);
			if (inner?.handleMouse) slot.handleMouse = (event) => inner.handleMouse?.(event);
			return slot;
		},
		createFullscreenHeaderSlot(): Component | null {
			const strip = spec.headerStrip;
			if (!strip) return null;
			const slot: Component = {
				render: (width) => renderHeader(width),
				invalidate: () => {
					headerCache = null;
					strip.invalidate();
				},
			};
			if (strip.handleInput) slot.handleInput = (data) => strip.handleInput?.(data);
			if (strip.handleMouse) slot.handleMouse = (event) => strip.handleMouse?.(event);
			return slot;
		},
		invalidate,
	};
}
