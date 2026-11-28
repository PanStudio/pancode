// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { PancodeSettings } from "../../core/config.js";
import { tierPolicy } from "../../core/presentation-tier.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { ProvidersContract, RuntimeResolutionDiagnostic } from "../../domains/providers/index.js";
import { AGENT_ROLE_TOOLS_REQUIRED_REASON, supportsAgentRoleTools } from "../../domains/providers/index.js";
import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import { getKeybindings, Input, matchesKey, wrapTextWithAnsi } from "../../engine/tui.js";
import { localKey } from "../keyboard-owner.js";
import {
	buildResponsiveHint,
	FILTER_HINT,
	formatRuntimeResolutionDiagnostic,
	type HintEntry,
	pancodeError,
	type RowBudgetedBody,
	showPancodeOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import type { SideUnit } from "../theme/index.js";
import { chip, emptyState, fitSides, GLYPH, padAnsi, pancodeTheme, positionRow } from "../theme/index.js";
import { formatModelDetail } from "./model-selector-detail.js";
import type { ModelItemsResult, ModelOverlaySummary, ModelRefreshScope, ModelRow } from "./model-selector-model.js";
import { buildModelItems, filterModelRows } from "./model-selector-model.js";
import { modelTableLines } from "./model-selector-table.js";

const MODEL_OVERLAY_WIDTH = 82;
const MODEL_OVERLAY_MAX_WIDTH = 120;
const MODEL_OVERLAY_TERMINAL_PADDING = 8;
const VISIBLE_ROWS = 10;

const TAB = "\t";

function resolveOverlayWidth(terminalColumns: number): number {
	// Default 82 fits a typical 80-col terminal with margin. On wider
	// terminals grow the overlay so target/runtime columns can stay visible.
	if (!Number.isFinite(terminalColumns) || terminalColumns <= 0) return MODEL_OVERLAY_WIDTH;
	const available = terminalColumns - MODEL_OVERLAY_TERMINAL_PADDING;
	if (available <= MODEL_OVERLAY_WIDTH) return Math.max(1, available);
	return Math.min(MODEL_OVERLAY_MAX_WIDTH, available);
}

export interface ModelSelection {
	target: string;
	model: string;
}

export interface OpenModelOverlayDeps {
	settings: Readonly<PancodeSettings>;
	/** Optional live settings resolver so refreshes pick up target/config edits made while the overlay is open. */
	getSettings?: () => Readonly<PancodeSettings>;
	providers: ProvidersContract;
	bus?: TelemetryHub;
	/** Enter: use the row for this session. */
	onSelect: (ref: ModelSelection) => void;
	/** `s`: save the row as a default, through the scope card. */
	onSave?: (ref: ModelSelection) => void;
	/** What switching to the row costs this session's prompt cache, shown in its detail because Enter does not stop at the card. */
	switchCost?: (ref: ModelSelection) => string | null;
	onToggleFavorite?: (ref: ModelSelection, favorite: boolean) => void;
	onClose: () => void;
	/** What a pick would do to the turn in flight, asked on every frame so it stays true up to the Enter. */
	turnEffect?: () => string | null;
	/** The row to select on open, as `target/model`, when the picker reopens on a pick the operator backed out of. */
	initialSelection?: string;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * The picker's summary row, fitted from whole units so it never ends on a cut chip: the mode leads in the accent
 * because Tab changes it and never drops; the local and cloud split (shown only when both are present) goes first,
 * then the target count, then the current route, and the match count last. The current route is printed whole or
 * not at all; the selection's status row prints whichever route the cursor is on.
 */
function summaryLine(
	summary: ModelOverlaySummary,
	mode: string,
	matches: number,
	active: string,
	width: number,
): string {
	const theme = pancodeTheme();
	const muted = (text: string): string => chip(theme, text, "muted");
	const split = summary.localModels > 0 && summary.cloudModels > 0;
	const units: SideUnit[] = [
		{ text: mode, paint: (text) => chip(theme, text, "accent") },
		{
			text: `${matches} of ${plural(summary.totalModels, "model", "models")}`,
			drop: 5,
			paint: muted,
			shorter: [{ text: `${matches} of ${summary.totalModels}`, rank: 4.5 }],
		},
		{ text: plural(summary.targets, "target", "targets"), drop: 2, paint: muted },
		...(split
			? [
					{ text: `${summary.localModels} local`, drop: 1, paint: muted },
					{ text: `${summary.cloudModels} cloud`, drop: 1, paint: muted },
				]
			: []),
		{ text: `${GLYPH.ok} current ${active}`, drop: 3, paint: muted },
	];
	return fitSides(theme, units, [], width).trimEnd();
}

function refreshStatusLine(
	refreshing: ModelRefreshScope | null | undefined,
	error: RuntimeResolutionDiagnostic | null | undefined,
): string | null {
	if (refreshing)
		return refreshing === "all"
			? `refreshing all targets and model catalogs${GLYPH.ellipsis}`
			: `refreshing selected target models${GLYPH.ellipsis}`;
	return error ? formatRuntimeResolutionDiagnostic(error) : null;
}

/** Rows the body spends outside the table rows: summary, header, divider, blank, two detail rows. */
const MODEL_CHROME_ROWS = 6;
const MODEL_MIN_VISIBLE_ROWS = 3;

function renderModelOverlayLines(input: {
	rows: ReadonlyArray<ModelRow>;
	summary: ModelOverlaySummary;
	selectedIndex: number;
	query: string;
	width: number;
	/** Rows the frame granted, or zero while unknown. */
	bodyRows?: number;
	showAll?: boolean;
	refreshing?: ModelRefreshScope | null;
	refreshError?: RuntimeResolutionDiagnostic | null;
	selectionError?: string | null;
	switchCost?: (ref: ModelSelection) => string | null;
}): string[] {
	const width = Math.max(1, input.width);
	const theme = pancodeTheme();
	const query = input.query.trim();
	const searching = query.length > 0;
	const allMatches = filterModelRows(input.rows, input.query);
	const focusedMatches = allMatches.filter((row) => row.visibleByDefault !== false);
	const filtered = searching || input.showAll ? allMatches : focusedMatches;
	const hidden = searching || input.showAll ? 0 : allMatches.length - focusedMatches.length;
	const selectableFiltered = filtered.filter((row) => row.selectable).length;
	const selectedIndex = Math.max(0, Math.min(input.selectedIndex, Math.max(0, filtered.length - 1)));
	const selected = filtered[selectedIndex] ?? null;
	const active = input.summary.activeRef || "not configured";
	const mode = searching ? `search "${query}"` : input.showAll ? "all" : "focus";
	const detailDepth = tierPolicy().pickerDetail;
	const lines = [summaryLine(input.summary, mode, selectableFiltered, active, width)];
	if (input.summary.newerModelNotice) {
		lines.push(...wrapTextWithAnsi(theme.fg("annotation", input.summary.newerModelNotice), width).slice(0, 1));
	}
	const refreshLine = refreshStatusLine(input.refreshing, input.refreshError);
	if (refreshLine)
		lines.push(
			...wrapTextWithAnsi(input.refreshError ? pancodeError(refreshLine) : theme.fg("annotation", refreshLine), width),
		);
	if (input.selectionError) lines.push(...wrapTextWithAnsi(pancodeError(input.selectionError), width));
	const bodyRows = input.bodyRows !== undefined && input.bodyRows > 0 ? input.bodyRows : 0;
	// The detail is sized before the table: the tier decides how deep it goes (one status row, the key facts, or the
	// full pane), and the table windows into what that leaves, so a deeper tier shows fewer rows rather than a cut pane.
	const cost =
		selected?.selectable && input.switchCost
			? input.switchCost({ target: selected.target, model: selected.model })
			: null;
	const naturalDetail = selected
		? formatModelDetail(selected, width, Number.POSITIVE_INFINITY, cost, detailDepth).length
		: 1;
	// Header, divider, position row and the blank row above the detail.
	const budget =
		bodyRows > 0 ? Math.max(MODEL_MIN_VISIBLE_ROWS, bodyRows - lines.length - 4 - naturalDetail) : VISIBLE_ROWS;
	if (filtered.length === 0) {
		lines.push(
			...emptyState(
				theme,
				searching ? "No models match the filter." : "No focused models.",
				width,
				searching ? { remedy: "Esc clears the filter" } : { remedy: "Type to search, or press Tab to list every model" },
			),
		);
	} else {
		let { window, start, position } = windowRows(filtered, selectedIndex, budget);
		let table = modelTableLines(window, selectedIndex - start, width);
		// A selected row that carries its target or id onto continuation rows takes them from the table, not the detail.
		const extra = table.length - window.length - 2;
		if (bodyRows > 0 && extra > 0 && budget - extra >= MODEL_MIN_VISIBLE_ROWS) {
			({ window, start, position } = windowRows(filtered, selectedIndex, budget - extra));
			table = modelTableLines(window, selectedIndex - start, width);
		}
		lines.push(...table);
		if (position !== null || hidden > 0) {
			lines.push(
				positionRow(
					theme,
					{
						start: position?.start ?? 1,
						end: position?.end ?? filtered.length,
						total: filtered.length,
						unit: "models",
						keys: [
							...(position !== null ? ["PgUp/PgDn page"] : []),
							...(hidden > 0 ? [`Tab shows all ${allMatches.length}`] : []),
						],
					},
					width,
				),
			);
		}
	}
	// With no budget known yet the detail renders whole, the way every other windowed body does. A short
	// dock gives the detail what the table leaves and cuts it with a mark, rather than overfilling the frame
	// and losing the rows below the table to the frame's own cut.
	const spare = bodyRows > 0 ? bodyRows - lines.length : Number.POSITIVE_INFINITY;
	if (spare >= 3) lines.push("");
	if (selected) {
		const room = Math.max(1, spare >= 3 ? spare - 1 : spare);
		lines.push(...formatModelDetail(selected, width, room, cost, detailDepth));
	} else lines.push(theme.fg("menuDescription", "no selected model"));
	return lines.map((line) => padAnsi(line, width, GLYPH.ellipsis));
}

interface ModelRefreshActions {
	selected?: (targetId: string) => Promise<ModelItemsResult>;
	all?: () => Promise<ModelItemsResult>;
	requestRender?: () => void;
}

export class ModelOverlayView implements Component, RowBudgetedBody {
	private selectedIndex = 0;
	private query = "";
	private readonly queryInput = new Input();
	get keyboardScope(): "edit" | "browse" {
		return this.query ? "edit" : "browse";
	}
	undoInput(): boolean {
		this.queryInput.applyEdit("undo");
		this.query = this.queryInput.getValue();
		this.selectedIndex = 0;
		return true;
	}
	private showAll = false;
	private showAllChosen = false;
	private rows: ModelRow[];
	private summary: ModelOverlaySummary;
	private refreshing: ModelRefreshScope | null = null;
	private refreshError: RuntimeResolutionDiagnostic | null = null;
	private selectionError: string | null = null;
	private bodyRows = 0;
	private readonly lifecycle = new AbortController();

	constructor(
		rows: ReadonlyArray<ModelRow>,
		summary: ModelOverlaySummary,
		private readonly onSelect: (ref: ModelSelection) => void,
		private readonly onToggleFavorite: ((ref: ModelSelection, favorite: boolean) => void) | undefined,
		private readonly onClose: () => void,
		private readonly refreshActions: ModelRefreshActions = {},
		private readonly turnEffect?: () => string | null,
		private readonly extras: Pick<OpenModelOverlayDeps, "onSave" | "switchCost"> = {},
	) {
		this.rows = [...rows];
		this.summary = summary;
		this.openOnAllWhenFocusHides();
	}

	/** A focus view of fewer than two rows hides the choice it exists to offer, so the picker lists everything until Tab says otherwise. */
	private openOnAllWhenFocusHides(): void {
		if (this.showAllChosen) return;
		this.showAll = this.rows.filter((row) => row.visibleByDefault !== false).length < 2;
	}

	selectedValue(): string | null {
		return this.selectedRow()?.value ?? null;
	}

	setSelectedValue(value: string): void {
		this.restoreSelection(value);
	}

	replaceItems(result: ModelItemsResult, preferredValue: string | null = this.selectedValue()): void {
		if (this.lifecycle.signal.aborted) return;
		this.rows = [...result.rows];
		this.summary = result.summary;
		this.selectionError = null;
		this.openOnAllWhenFocusHides();
		this.restoreSelection(preferredValue);
	}

	dispose(): void {
		if (!this.lifecycle.signal.aborted) this.lifecycle.abort();
	}

	isDisposed(): boolean {
		return this.lifecycle.signal.aborted;
	}

	private restoreSelection(preferredValue: string | null): void {
		const filtered = this.filteredRows();
		if (preferredValue) {
			const idx = filtered.findIndex((row) => row.value === preferredValue);
			if (idx >= 0) {
				this.selectedIndex = idx;
				return;
			}
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, filtered.length - 1)));
	}

	private filteredRows(): ModelRow[] {
		const matches = filterModelRows(this.rows, this.query);
		if (this.query.trim().length > 0 || this.showAll) return matches;
		return matches.filter((row) => row.visibleByDefault !== false);
	}

	private selectedRow(): ModelRow | null {
		return this.filteredRows()[this.selectedIndex] ?? null;
	}

	private move(delta: number): void {
		this.selectionError = null;
		const count = this.filteredRows().length;
		if (count === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
	}

	private clearQuery(): void {
		if (this.query.length === 0) return;
		this.selectionError = null;
		this.query = "";
		this.queryInput.setValue("");
		this.selectedIndex = 0;
	}

	private toggleShowAll(): void {
		this.selectionError = null;
		this.showAll = !this.showAll;
		this.showAllChosen = true;
		this.selectedIndex = 0;
	}

	private toggleFavorite(): void {
		const row = this.selectedRow();
		if (!row?.selectable || !this.onToggleFavorite) return;
		row.favorite = !row.favorite;
		row.visibleByDefault =
			row.focusPinned === true ||
			row.active ||
			row.favorite === true ||
			row.recent === true ||
			row.scoped === true ||
			row.defaultModel === true;
		this.onToggleFavorite({ target: row.target, model: row.model }, row.favorite === true);
	}

	refresh(scope: ModelRefreshScope): void {
		void this.runRefresh(scope);
	}

	private async runRefresh(scope: ModelRefreshScope): Promise<void> {
		if (this.refreshing || this.lifecycle.signal.aborted) return;
		const signal = this.lifecycle.signal;
		const selected = this.selectedRow();
		const preferredValue = selected?.value ?? null;
		if (scope === "all" && !this.refreshActions.all) return;
		if (scope === "selected" && (!this.refreshActions.selected || !selected?.target)) return;
		this.refreshing = scope;
		this.refreshError = null;
		this.selectionError = null;
		this.refreshActions.requestRender?.();
		try {
			const next =
				scope === "all" ? await this.refreshActions.all?.() : await this.refreshActions.selected?.(selected?.target ?? "");
			if (signal.aborted) return;
			if (next) this.replaceItems(next, preferredValue);
		} catch (err) {
			if (signal.aborted) return;
			this.refreshError = {
				severity: "error",
				code: "probe-failed",
				message: err instanceof Error ? err.message : String(err),
			};
		} finally {
			this.refreshing = null;
			if (!signal.aborted) this.refreshActions.requestRender?.();
		}
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		const effect = this.turnEffect?.() ?? null;
		const list = this.renderList(width, effect === null ? this.bodyRows : Math.max(0, this.bodyRows - 1));
		return effect === null ? list : [padAnsi(pancodeTheme().fg("accent", effect), width, GLYPH.ellipsis), ...list];
	}

	private renderList(width: number, bodyRows: number): string[] {
		return renderModelOverlayLines({
			rows: this.rows,
			summary: this.summary,
			selectedIndex: this.selectedIndex,
			query: this.query,
			width,
			bodyRows,
			showAll: this.showAll,
			refreshing: this.refreshing,
			refreshError: this.refreshError,
			selectionError: this.selectionError,
			...(this.extras.switchCost ? { switchCost: this.extras.switchCost } : {}),
		});
	}

	invalidate(): void {}

	/** While a query is typed, s, r, R and * type into it, and Esc clears it instead of closing. */
	railHint(innerWidth: number): string {
		const use: HintEntry = { key: "Enter", verb: "use this session", short: "use" };
		// A narrow rail keeps its last extras, so r and R lead here to be the first to go.
		return this.query.length > 0
			? buildResponsiveHint([FILTER_HINT, use, { key: "Tab", verb: "focus/all" }], "clear filter")(innerWidth)
			: buildResponsiveHint([
					{ key: "r", verb: "refresh target", short: "refresh" },
					{ key: "R", verb: "refresh all" },
					FILTER_HINT,
					use,
					...(this.extras.onSave ? [{ key: "s", verb: "save as default", short: "save" }] : []),
					{ key: "Tab", verb: "focus/all" },
					{ key: "*", verb: "fav" },
				])(innerWidth);
	}

	handleInput(data: string): void {
		data = localKey(data);
		if (this.lifecycle.signal.aborted) return;
		if (matchesKey(data, "escape")) {
			if (this.query) this.clearQuery();
			else this.onClose();
			this.refreshActions.requestRender?.();
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown")) {
			this.selectionError = null;
			const count = this.filteredRows().length;
			const page = Math.max(MODEL_MIN_VISIBLE_ROWS, this.bodyRows - MODEL_CHROME_ROWS);
			const next = this.selectedIndex + (kb.matches(data, "tui.select.pageDown") ? page : -page);
			this.selectedIndex = Math.max(0, Math.min(next, count - 1));
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter") || data === "\n") {
			const row = this.selectedRow();
			if (row?.selectable) {
				// Close the picker before handing the selection to its owner, which
				// may open another overlay that closing afterwards would dismiss.
				this.onClose();
				this.onSelect({ target: row.target, model: row.model });
				return;
			}
			this.selectionError = row
				? row.model && row.capabilityDecisions && !supportsAgentRoleTools(row.capabilityDecisions)
					? `${row.model} ${AGENT_ROLE_TOOLS_REQUIRED_REASON}`
					: `target ${row.target} has no selectable model id`
				: "no model is selected";
			this.refreshActions.requestRender?.();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			// Esc unwinds one step at a time: an active filter is the thing the
			// user most recently built, so it goes first and the overlay stays
			// open. A second press with no filter left closes. Typing a filter
			// and reaching for Esc used to dump the whole overlay.
			if (this.query.length > 0) {
				this.clearQuery();
				this.refreshActions.requestRender?.();
				return;
			}
			this.onClose();
			return;
		}
		if (data === TAB) {
			this.toggleShowAll();
			return;
		}
		if (data === "r" && this.query.length === 0) {
			this.refresh("selected");
			return;
		}
		if (data === "R" && this.query.length === 0) {
			this.refresh("all");
			return;
		}
		if (data === "*" && this.query.length === 0) {
			this.toggleFavorite();
			return;
		}
		if (data === "s" && this.query.length === 0 && this.extras.onSave) {
			const row = this.selectedRow();
			if (row?.selectable) {
				this.onClose();
				this.extras.onSave({ target: row.target, model: row.model });
			}
			return;
		}
		this.queryInput.handleInput(data);
		const next = this.queryInput.getValue();
		if (next !== this.query) {
			this.query = next;
			this.selectedIndex = 0;
			this.selectionError = null;
			this.refreshActions.requestRender?.();
		}
	}
}

function reloadKnowledgeBaseIfSupported(providers: ProvidersContract): void {
	const knowledgeBase = providers.knowledgeBase;
	const reload = (knowledgeBase as { reload?: unknown } | null)?.reload;
	if (typeof reload === "function") reload.call(knowledgeBase);
}

export function openModelOverlay(tui: TUI, deps: OpenModelOverlayDeps): OverlayHandle {
	const currentSettings = (): Readonly<PancodeSettings> => deps.getSettings?.() ?? deps.settings;
	const build = (options?: { reloadCatalog?: boolean }): ModelItemsResult => {
		if (options?.reloadCatalog) reloadKnowledgeBaseIfSupported(deps.providers);
		return buildModelItems({ settings: currentSettings(), providers: deps.providers });
	};
	const initial = build();
	const overlayWidth = resolveOverlayWidth(tui.terminal?.columns ?? 0);
	const activeTarget = currentSettings().chat?.target?.trim();
	const activeModel = currentSettings().chat?.model?.trim();
	const view = new ModelOverlayView(
		initial.rows,
		initial.summary,
		(ref) => deps.onSelect(ref),
		deps.onToggleFavorite ? (ref, favorite) => deps.onToggleFavorite?.(ref, favorite) : undefined,
		() => deps.onClose(),
		{
			selected: async (targetId) => {
				await deps.providers.probeTarget(targetId);
				return build({ reloadCatalog: true });
			},
			all: async () => {
				await deps.providers.probeAllLive();
				return build({ reloadCatalog: true });
			},
			requestRender: () => tui.requestRender(),
		},
		deps.turnEffect,
		{
			...(deps.onSave ? { onSave: deps.onSave } : {}),
			...(deps.switchCost ? { switchCost: deps.switchCost } : {}),
		},
	);
	if (deps.initialSelection) view.setSelectedValue(deps.initialSelection);
	else if (activeTarget && activeModel) view.setSelectedValue(`${activeTarget}/${activeModel}`);
	const unsubscribeHealth = deps.bus?.subscribe("provider.health_changed", () => {
		if (view.isDisposed()) return;
		view.replaceItems(build());
		tui.requestRender();
	});
	const handle = showPancodeOverlayFrame(tui, view, {
		anchor: "center",
		width: overlayWidth,
		markerId: "model",
		title: "Models",
		footerHint: (innerWidth) => view.railHint(innerWidth),
	});
	view.refresh("all");
	return {
		...handle,
		hide(): void {
			view.dispose();
			unsubscribeHealth?.();
			handle.hide();
		},
	};
}
