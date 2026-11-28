// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { join } from "node:path";
import type { PancodeSettings } from "../../core/config.js";
import { settingsPath } from "../../core/config.js";
import { tierPolicy } from "../../core/presentation-tier.js";
import { pancodeProjectRoot } from "../../core/project-root.js";
import type { SettingsAreaId as SettingsSectionId } from "../../core/settings-areas.js";
import { resolveSettingsArea, SETTINGS_AREAS as SETTINGS_SECTIONS } from "../../core/settings-areas.js";
import { settingControl, settingsPathForRow } from "../../core/settings-controls.js";
import { SETTINGS_LABELS_BY_ID } from "../../core/settings-copy.js";
import type { SettingsShortcuts } from "../../core/settings-shortcuts.js";
import { listSettingsShortcuts, rememberChangedSetting, setSettingPinned } from "../../core/settings-shortcuts.js";
import type { NotificationLevel } from "../../core/views/notice-words.js";
import {
	applyTargetCredentialPlan,
	getRuntimeRegistry,
	type ProvidersContract,
	planTargetCredentialRemoval,
	type TargetDescriptor,
} from "../../domains/providers/index.js";
import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import { getKeybindings, Input, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { dockBodyRows } from "../dock.js";
import { backOutOneLayer, type EscapeLayers, escapeHintEntry, innermostEscapeLayer } from "../escape-layers.js";
import { localKey } from "../keyboard-owner.js";
import {
	buildResponsiveHint,
	centeredWindow,
	fitRows,
	type HintEntry,
	isRowBudgeted,
	showPancodeOverlayFrame,
} from "../overlay-frame.js";
import { editSettingsFile } from "../settings-file-edit.js";
import { openTargetWizard, type TargetWizardOptions } from "../target-wizard.js";
import { barSep, collapseHomePath, emptyState, GLYPH, padAnsi, pancodeTheme, titleRow } from "../theme/index.js";
import {
	type BuildSettingItemsOptions,
	REMOVE_PROFILE_CHOICE,
	SECTION_LANE_WIDTH,
	SETTINGS_OVERLAY_MARGIN,
	SETTINGS_OVERLAY_MAX_HEIGHT,
	SETTINGS_OVERLAY_WIDTH,
	SETTINGS_SECTION_DESCRIPTIONS,
	type SettingsCenterItem,
	type SettingsCenterLane,
	type SettingsCenterRowId,
	type SettingsCenterSection,
	type SettingsCenterSelection,
	type SettingsNavigationDepth,
	ULTRAWIDE_LAYOUT_MIN_WIDTH,
	WIDE_LAYOUT_MIN_WIDTH,
} from "./settings-center-model.js";
import { createSettingsChangePlan, formatScopeConfirmTitle, type SettingsChangePlan } from "./settings-change-plan.js";
import { parseScopedModelSelection, TYPED_CHARACTER } from "./settings-editors.js";
import { valueProblem } from "./settings-item-rows.js";
import { buildSettingItems } from "./settings-items.js";
import {
	clippedSettingValue,
	effectTiming,
	formatSettingsValue,
	type InspectorContext,
	isModified,
	renderDetailLane,
	renderInspector,
	renderLaneTitle,
	renderNarrowInspector,
	renderRowsPosition,
	renderSectionLane,
	renderSettingRow,
	renderTargetTable,
	type SectionLaneRow,
	type SettingValueOrigin,
	settingRowDemand,
	settingsLabelWidth,
	settingsPathLabel,
} from "./settings-presentation.js";
import {
	buildSettingsSections,
	isShortcutRow,
	placementOf,
	previewable,
	refreshSettingItemsInPlace,
	type SettingsRowPlacement,
	samePlacement,
} from "./settings-sections.js";
import { type ChoiceItem, ChoiceList, isSubmenuSurface, SubmenuWrapper } from "./settings-submenus.js";

export { SETTINGS_LABELS_BY_ID } from "../../core/settings-copy.js";
export type { SettingsSectionId };

export interface SettingsCenterOptions {
	getBodyHeight: () => number;
	prepareChange: (item: SettingsCenterItem, newValue: string) => SettingsChangePlan | null;
	onApply: (plan: SettingsChangePlan, scope: "session" | "project" | "global") => void;
	onCancel: () => void;
	onAddTarget?: () => void;
	/** "Connect by URL": Quick Connect in the docked wizard surface. */
	onConnectByUrl?: () => void;
	/** "Edit settings file": open the chosen settings file in the operator's editor. */
	onEditSettingsFile?: (file: "user" | "project") => void;
	/** "Check setup": close settings and run the doctor. */
	onCheckSetup?: () => void;
	requestRender?: () => void;
	/** Pins and recent changes to build the Recent & Pinned view from; absent means none yet. */
	shortcuts?: SettingsShortcuts;
	/** Persist a pin or unpin and return the resulting shortcuts; absent keeps the pin in memory only. */
	pinSetting?: (id: string, pinned: boolean) => SettingsShortcuts;
	/** Which layer set a row's effective value; absent leaves the origin column empty. */
	originFor?: (item: SettingsCenterItem) => SettingValueOrigin | null;
	/** The file that holds a value set by `origin`, for the detailed pane; absent or null names no file. */
	settingsFileFor?: (origin: SettingValueOrigin) => string | null;
}

/** The rows lane stops growing here; a label, a value and an origin need no more. */
const ROWS_LANE_MAX_WIDTH = 96;
const DETAIL_LANE_MIN_WIDTH = 28;
const DETAIL_LANE_MAX_WIDTH = 72;
/** The inspector strip under two lanes: a rule, up to two description rows and one of facts. */
const INSPECTOR_ROWS = 4;
/** List rows the strip may never take from the lanes above it. */
const MIN_LIST_ROWS = 6;

/**
 * `9 settings`, or `3 connections` for the targets table, where the rows are not
 * settings. Under a filter the section holds only its matching rows, so the size
 * comes from the whole section and the matches are counted beside it: a search
 * for "Add a target" used to say `0 connections` over a table that had two.
 */
function sectionCount(section: SettingsCenterSection, whole: SettingsCenterSection = section): string {
	const matches = section.items.filter((item) => item.presentationKind !== "group-header").length;
	const filtered = whole !== section;
	const count = whole.items.filter((item) => item.presentationKind !== "group-header").length;
	const noun = count === 1 ? "setting" : "settings";
	return filtered ? `${matches} of ${count} ${noun}` : `${count} ${noun}`;
}

/** Where Esc on the scope card returns: the editor or the choice list the value came from. */
interface ScopeCardBack {
	verb: "back to edit" | "back to choices";
	short?: string;
	back: () => void;
}

/** Words a person adds to a phrase that a settings label rarely carries. */
const SETTINGS_FILTER_FILLER = new Set(["a", "an", "the", "to", "for", "of", "my", "new"]);

/** A filter query's terms, lowercased, without filler; a query of filler alone keeps its words. */
function settingsFilterTerms(query: string): string[] {
	const words = query
		.toLowerCase()
		.split(/\s+/u)
		.filter((word) => word.length > 0);
	const meaningful = words.filter((word) => !SETTINGS_FILTER_FILLER.has(word));
	return meaningful.length > 0 ? meaningful : words;
}

export class SettingsCenter implements Component {
	/** The stack level that owns input; "detail" is implied by an open submenu. */
	private level: SettingsCenterLane = "rows";
	/**
	 * Whether the operator reached the rows from the section list. Settings opens on rows, and
	 * an Esc there closes the screen instead of revealing a section list nobody asked for.
	 */
	private rowsFromSections = false;
	/** The body's width at the last render: the rail's own room is narrower, and says nothing about the layout. */
	private renderedWidth = 0;
	private selectedSectionId: SettingsSectionId = SETTINGS_SECTIONS[0].id;
	private readonly rowIndexBySection = new Map<SettingsSectionId, number>();
	/** Semantic anchors survive rows being inserted, removed, or reordered during refresh. */
	private readonly rowIdBySection = new Map<SettingsSectionId, SettingsCenterRowId>();
	private submenuComponent: Component | null = null;
	/** Committed catalog filter; empty means unfiltered. */
	private filterQuery = "";
	/**
	 * Draft while the filter editor owns input; null when it is closed. The
	 * draft narrows the catalog live per keystroke, matching /model and /resume;
	 * Enter commits it and Esc restores the committed query.
	 */
	private filterDraft: string | null = null;
	private readonly filterInput = new Input();
	get keyboardScope(): "edit" | "review" {
		return this.filterDraft !== null ? "edit" : "review";
	}
	undoInput(): boolean {
		if (this.filterDraft === null) return false;
		this.filterInput.applyEdit("undo");
		this.filterDraft = this.filterInput.getValue();
		this.normalizeSelection();
		return true;
	}
	/** Local cycle preview for the selected row; committed on Enter. */
	private pendingValue: string | null = null;

	private shortcuts: SettingsShortcuts;

	constructor(
		private readonly items: SettingsCenterItem[],
		private readonly options: SettingsCenterOptions,
	) {
		this.shortcuts = options.shortcuts ?? { pinned: [], recent: [] };
	}

	/** Adopt shortcuts changed outside the screen, such as a setting that was just saved. */
	setShortcuts(shortcuts: SettingsShortcuts): void {
		this.shortcuts = shortcuts;
		this.normalizeSelection();
	}

	private isPinned(item: SettingsCenterItem): boolean {
		return this.shortcuts.pinned.includes(item.id);
	}

	/** `*` pins or unpins the selected setting. The row keeps its identity, so the cursor follows it between groups. */
	private togglePin(): void {
		const item = this.selectedItem();
		if (!isShortcutRow(item)) return;
		const pinned = !this.isPinned(item);
		this.shortcuts = this.options.pinSetting?.(item.id, pinned) ?? {
			pinned: pinned ? [...this.shortcuts.pinned, item.id] : this.shortcuts.pinned.filter((id) => id !== item.id),
			recent: this.shortcuts.recent,
		};
		this.normalizeSelection();
		this.options.requestRender?.();
	}

	getSelection(): SettingsCenterSelection {
		const section = this.currentSection();
		const rowIndex = section ? this.rowIndex(section.id) : 0;
		const row = section?.items[rowIndex] ?? null;
		return {
			lane: this.level,
			depth: this.depth(),
			section: section?.id ?? this.selectedSectionId,
			rowIndex,
			rowId: row?.id ?? null,
			submenuOpen: this.submenuComponent !== null,
			filter: this.filterQuery,
		};
	}

	setSelection(sectionName: SettingsSectionId, rowIndex: number, lane: SettingsCenterLane = "rows"): void {
		const sectionId = resolveSettingsArea(sectionName) ?? SETTINGS_SECTIONS[0].id;
		if (this.sections().some((section) => section.id === sectionId)) this.selectedSectionId = sectionId;
		const section = this.currentSection();
		if (section) this.setRowIndex(section, this.selectableRowIndex(section, rowIndex));
		this.level = lane;
		this.rowsFromSections = false;
		this.submenuComponent = null;
		this.pendingValue = null;
	}

	refreshItems(): void {
		this.normalizeSelection();
	}

	render(width: number): string[] {
		// Category, filter, and submenu changes share one viewport. Only terminal size changes its height.
		const bodyHeight = Math.max(1, this.options.getBodyHeight());
		this.normalizeSelection();
		this.renderedWidth = width;
		const lines =
			width < WIDE_LAYOUT_MIN_WIDTH
				? this.renderNarrow(width, bodyHeight)
				: width >= ULTRAWIDE_LAYOUT_MIN_WIDTH
					? this.renderUltraWide(width, bodyHeight)
					: this.renderWide(width, bodyHeight);
		return fitRows(lines, width, bodyHeight);
	}

	/**
	 * Settings is component-owned for Esc: the application router forwards it
	 * here instead of closing the overlay, so one press moves up exactly one
	 * level. Every physical encoding (raw, Kitty CSI-u, modifyOtherKeys) is
	 * recognized before any delegation, which is what lets the parent pop a
	 * submenu whose own cancel binding has been customized. Key releases are not
	 * presses and do nothing.
	 */
	handleInput(data: string): void {
		data = localKey(data);
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape")) {
			this.back();
			return;
		}
		if (this.filterDraft !== null) {
			this.handleFilterKey(data);
			return;
		}
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}
		const kb = getKeybindings();
		if (data === "/") {
			// A fresh draft, because typed text appended to a committed query read as `judgesettings`
			// when someone typed /settings with the screen still open. Esc restores the committed one.
			this.filterDraft = "";
			this.filterInput.setValue("");
			return;
		}
		if (matchesKey(data, "tab")) {
			this.toggleLevel();
			return;
		}
		if (matchesKey(data, "left")) {
			this.level = "sections";
			this.pendingValue = null;
			return;
		}
		if (matchesKey(data, "right")) {
			if (this.level === "sections") this.rowsFromSections = true;
			this.level = "rows";
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (data === " " && this.level === "rows") {
			this.cyclePreview();
			return;
		}
		if (data === "*" && this.level === "rows") {
			this.togglePin();
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
			if (this.level === "sections") {
				this.level = "rows";
				this.rowsFromSections = true;
				return;
			}
			this.activateSelectedItem();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.back();
			return;
		}
		// Typing always filters: every printable character but Space and `*` starts the filter, in both lanes.
		if (TYPED_CHARACTER.test(data) && data !== "*") {
			this.filterDraft = "";
			this.filterInput.setValue("");
			this.handleFilterKey(data);
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	/**
	 * One level up, at every width, by the shared Esc rule: cancel the filter
	 * editor, then the open submenu, then the filter, then the rows page, and
	 * only from the section list does Esc close Settings. A pending Space preview
	 * is part of the row context, so leaving rows discards it rather than costing
	 * an extra press. The rail reads its Esc word from this same list.
	 */
	private escapeLayers(): EscapeLayers {
		const submenu = this.submenuComponent;
		const done = (): void => {
			this.pendingValue = null;
			this.options.requestRender?.();
		};
		return [
			this.filterDraft !== null && {
				verb: "cancel filter",
				short: "cancel",
				back: () => {
					this.filterDraft = null;
					this.options.requestRender?.();
				},
			},
			isSubmenuSurface(submenu) &&
				submenu.escape !== null && {
					...submenu.escape,
					back: () => {
						submenu.escape?.back();
						done();
					},
				},
			submenu !== null && {
				verb: isSubmenuSurface(submenu) && submenu.editsText ? "back, keeps draft" : "back to list",
				short: isSubmenuSurface(submenu) && submenu.editsText ? "back" : "to list",
				back: () => {
					// A text editor hears its own Esc, which is what keeps the typed draft for the next visit.
					if (isSubmenuSurface(submenu) && submenu.editsText) submenu.handleInput?.("\x1b");
					this.submenuComponent = null;
					done();
				},
			},
			this.filterQuery.length > 0 && {
				verb: "clear filter",
				short: "clear filter",
				back: () => {
					this.filterQuery = "";
					this.normalizeSelection();
					done();
				},
			},
			this.level === "rows" &&
				this.rowsFromSections &&
				this.sections().length > 0 && {
					verb: "back to sections",
					short: "to sections",
					back: () => {
						this.level = "sections";
						done();
					},
				},
			{ verb: "close settings", short: "close", back: () => this.options.onCancel() },
		];
	}

	private back(): void {
		backOutOneLayer(this.escapeLayers());
	}

	/** What the next Esc does, in the words the rail shows. */
	escapeVerb(): string {
		return innermostEscapeLayer(this.escapeLayers())?.verb ?? "close settings";
	}

	private depth(): SettingsNavigationDepth {
		return this.submenuComponent ? "detail" : this.level;
	}

	/** Where the next key goes, in the order `handleInput` routes it. */
	private keyOwner(): "filter" | "submenu" | SettingsCenterLane {
		if (this.filterDraft !== null) return "filter";
		if (this.submenuComponent) return "submenu";
		return this.level;
	}

	/**
	 * The rail for the lane that owns the keys. It used to list Space and the pin key in the
	 * section lane that ignores them, offer `open` on a read-only row where Enter does
	 * nothing, and lose Tab first at 108 columns, the one key that changes lanes.
	 */
	railHint(innerWidth: number): string {
		// The destination keeps its words on a narrow rail (`to sections`, never a bare `back`), and the
		// short spelling leaves a 40-column rail room for the key that opens the row.
		const esc: HintEntry = escapeHintEntry(this.escapeLayers()) ?? { key: "Esc", verb: this.escapeVerb() };
		const owner = this.keyOwner();
		if (owner === "submenu") {
			const keys = isSubmenuSurface(this.submenuComponent) ? this.submenuComponent.railKeys() : [];
			return buildResponsiveHint(keys, esc)(innerWidth);
		}
		if (owner === "filter") {
			return buildResponsiveHint([{ key: "Enter", verb: "apply filter", short: "apply" }], esc)(innerWidth);
		}
		const twoLanes = this.renderedWidth >= WIDE_LAYOUT_MIN_WIDTH;
		const filter: HintEntry = { key: "type", verb: "filter", critical: false };
		if (owner === "sections") {
			return buildResponsiveHint(
				[
					{ key: "Enter", verb: "open section", short: "open" },
					...(twoLanes ? [{ key: "Tab", verb: "to rows", short: "rows", critical: true }] : []),
					{ key: `${GLYPH.up}${GLYPH.down}`, verb: "section", critical: false },
					filter,
				],
				esc,
			)(innerWidth);
		}
		const item = this.selectedItem();
		const editable = item !== null && !item.readOnly;
		return buildResponsiveHint(
			[
				...(editable ? [{ key: "Enter", verb: "open" }] : []),
				...(twoLanes ? [{ key: "Tab", verb: "to sections", short: "sections", critical: true }] : []),
				{ key: `${GLYPH.up}${GLYPH.down}`, verb: "select", critical: false },
				...(twoLanes && previewable(item) ? [{ key: "Space", verb: "preview", critical: false }] : []),
				...(twoLanes && isShortcutRow(item) ? [{ key: "*", verb: "pin", critical: false }] : []),
				filter,
			],
			esc,
		)(innerWidth);
	}

	private handleFilterKey(data: string): void {
		const draft = this.filterDraft ?? "";
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
			const query = draft.trim();
			this.filterDraft = null;
			// The screen's own command typed into its own filter means home, not a search for the word.
			if (query.toLowerCase() === "settings") {
				this.filterQuery = "";
				this.selectedSectionId = SETTINGS_SECTIONS[0].id;
			} else {
				this.filterQuery = query;
			}
			// Enter hands the keys to the results, so the cursor moving onto a row is the visible answer.
			if (this.level === "sections") this.rowsFromSections = true;
			this.level = "rows";
			this.normalizeSelection();
			this.options.requestRender?.();
			return;
		}
		this.filterInput.handleInput(data);
		this.filterDraft = this.filterInput.getValue();
		this.normalizeSelection();
		this.options.requestRender?.();
	}

	/** The query the catalog is narrowed by right now: the live draft while the
	 * filter editor is open, the committed query otherwise. */
	private effectiveFilterQuery(): string {
		return (this.filterDraft ?? this.filterQuery).trim();
	}

	/**
	 * The area and group names are searchable too, so "delegation" finds what lives under Agents & Delegation. Each
	 * term matches on its own, in any order and any field, and filler words are not required: "Add target" found
	 * nothing while "Add a target" found the wizard (B04).
	 */
	private matchesFilter(item: SettingsCenterItem, context: string): boolean {
		const terms = settingsFilterTerms(this.effectiveFilterQuery());
		if (terms.length === 0) return true;
		const haystack = [item.label ?? "", item.configPath ?? "", item.description ?? "", item.currentValue ?? "", context]
			.join("\n")
			.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	}

	/**
	 * The catalog the operator can currently reach. Group headers survive only as
	 * context for a matching row beneath them, never as results or stops, and a
	 * section with no matching row disappears from the list entirely.
	 */
	private sections(): SettingsCenterSection[] {
		const all = this.wholeSections();
		if (this.effectiveFilterQuery().length === 0) return all;
		// Search reaches every setting at its home; the shortcut view would only repeat those rows.
		return all
			.filter((section) => section.id !== "recent")
			.map((section) => ({ ...section, items: this.filterSectionItems(section.items, section.label) }))
			.filter((section) => section.items.some((item) => this.isSelectableRow(item)));
	}

	/**
	 * The unfiltered catalog, rebuilt only when a row's placement or the shortcuts change.
	 * Rows refresh in place, so the check reads their placement fields; labels and values
	 * reach the sections through the shared row objects.
	 */
	private wholeSections(): SettingsCenterSection[] {
		const built = this.built;
		if (built && built.shortcuts === this.shortcuts && samePlacement(built.rows, this.items)) return built.sections;
		this.built = {
			shortcuts: this.shortcuts,
			rows: this.items.map(placementOf),
			sections: buildSettingsSections(this.items, this.shortcuts),
		};
		return this.built.sections;
	}
	private built:
		| { shortcuts: SettingsShortcuts; rows: SettingsRowPlacement[]; sections: SettingsCenterSection[] }
		| undefined;

	private filterSectionItems(items: readonly SettingsCenterItem[], sectionLabel: string): SettingsCenterItem[] {
		const kept: SettingsCenterItem[] = [];
		let pendingHeader: SettingsCenterItem | null = null;
		let groupLabel = "";
		for (const item of items) {
			if (!this.isSelectableRow(item)) {
				pendingHeader = item;
				groupLabel = item.label;
				continue;
			}
			if (!this.matchesFilter(item, `${sectionLabel} ${groupLabel}`)) continue;
			if (pendingHeader) {
				kept.push(pendingHeader);
				pendingHeader = null;
			}
			kept.push(item);
		}
		return kept;
	}

	/** The section's size, measured on the whole section when a filter has narrowed it. */
	private sectionCount(section: SettingsCenterSection): string {
		if (this.effectiveFilterQuery().length === 0) return sectionCount(section);
		const whole = this.wholeSections().find((entry) => entry.id === section.id);
		return sectionCount(section, whole ?? section);
	}

	private currentSection(): SettingsCenterSection | null {
		const sections = this.sections();
		return sections.find((section) => section.id === this.selectedSectionId) ?? sections[0] ?? null;
	}

	private rowIndex(sectionId: SettingsSectionId): number {
		const section = this.sections().find((entry) => entry.id === sectionId);
		if (!section) return 0;
		const rowId = this.rowIdBySection.get(sectionId);
		const identityIndex = rowId ? section.items.findIndex((item) => item.id === rowId) : -1;
		if (identityIndex >= 0 && this.isSelectableRow(section.items[identityIndex])) return identityIndex;
		return this.selectableRowIndex(section, this.rowIndexBySection.get(sectionId) ?? 0);
	}

	private isSelectableRow(item: SettingsCenterItem | undefined): boolean {
		return item !== undefined && item.presentationKind !== "group-header";
	}

	private selectableRowIndex(section: SettingsCenterSection, rowIndex: number): number {
		if (section.items.length === 0) return 0;
		const clamped = Math.max(0, Math.min(rowIndex, section.items.length - 1));
		if (this.isSelectableRow(section.items[clamped])) return clamped;
		for (let distance = 1; distance < section.items.length; distance += 1) {
			const after = clamped + distance;
			if (this.isSelectableRow(section.items[after])) return after;
			const before = clamped - distance;
			if (this.isSelectableRow(section.items[before])) return before;
		}
		return 0;
	}

	private setRowIndex(section: SettingsCenterSection, rowIndex: number): void {
		const next = this.selectableRowIndex(section, rowIndex);
		this.rowIndexBySection.set(section.id, next);
		const item = section.items[next];
		if (item && this.isSelectableRow(item)) this.rowIdBySection.set(section.id, item.id);
	}

	private normalizeSelection(): void {
		const sections = this.sections();
		// A committed filter that hides everything leaves nowhere to drill into, so
		// the stack sits at its top level and one Esc closes Settings from the
		// empty state. A live draft narrows per keystroke and may pass through the
		// empty state on its way to a match, so it must not disturb the level:
		// Esc's first press cancels the draft and lands back where editing began.
		if (sections.length === 0) {
			if (this.filterDraft === null) this.level = "sections";
			return;
		}
		if (!sections.some((section) => section.id === this.selectedSectionId)) {
			this.selectedSectionId = sections[0]?.id ?? this.selectedSectionId;
		}
		for (const section of sections) {
			this.setRowIndex(section, this.rowIndex(section.id));
		}
	}

	private selectedItem(): SettingsCenterItem | null {
		const section = this.currentSection();
		if (!section) return null;
		return section.items[this.rowIndex(section.id)] ?? null;
	}

	private toggleLevel(): void {
		if (this.level === "sections") this.rowsFromSections = true;
		this.level = this.level === "sections" ? "rows" : "sections";
		this.pendingValue = null;
	}

	private moveSelection(delta: -1 | 1): void {
		this.pendingValue = null;
		if (this.level === "sections") {
			this.moveSection(delta);
			return;
		}
		// Rows are the section's own rows at every width. Flattening the catalog
		// on narrow terminals meant an operator scrolling Retry fell into Terminal
		// with nothing in the frame saying they had left the section they opened.
		const section = this.currentSection();
		if (!section) return;
		const selectable = section.items
			.map((item, index) => (this.isSelectableRow(item) ? index : -1))
			.filter((index) => index >= 0);
		if (selectable.length === 0) return;
		const current = selectable.indexOf(this.rowIndex(section.id));
		const next = selectable[(Math.max(0, current) + delta + selectable.length) % selectable.length];
		if (next !== undefined) this.setRowIndex(section, next);
	}

	private moveSection(delta: -1 | 1): void {
		const sections = this.sections();
		if (sections.length === 0) return;
		const current = Math.max(
			0,
			sections.findIndex((section) => section.id === this.selectedSectionId),
		);
		const next = sections[(current + delta + sections.length) % sections.length];
		if (next) this.selectedSectionId = next.id;
		this.normalizeSelection();
	}

	/** Space cycles a local preview of an enum/bool row without committing. */
	private cyclePreview(): void {
		const item = this.selectedItem();
		if (!previewable(item)) return;
		const base = this.pendingValue ?? item.currentValue;
		const currentIndex = item.values.indexOf(base);
		const nextIndex = (currentIndex + 1) % item.values.length;
		this.pendingValue = item.values[nextIndex] ?? base;
	}

	private activateSelectedItem(): void {
		const item = this.selectedItem();
		if (!item || item.readOnly) return;
		if (item.id === "connections.add-cta") {
			this.options.onAddTarget?.();
			return;
		}
		if (item.id === "connections.url-cta") {
			this.options.onConnectByUrl?.();
			return;
		}
		if (item.id === "maintenance.diagnostics") {
			this.options.onCheckSetup?.();
			return;
		}
		if (item.id === "maintenance.editor") {
			const list = new ChoiceList([
				{ value: "user", label: "Your settings file", description: "Applies to every session." },
				{ value: "project", label: "This project's settings file", description: ".pancode/settings.yaml" },
			]);
			list.onSelect = (choice) => {
				this.submenuComponent = null;
				this.options.onEditSettingsFile?.(choice.value === "project" ? "project" : "user");
				this.options.requestRender?.();
			};
			list.onCancel = () => {
				this.submenuComponent = null;
				this.options.requestRender?.();
			};
			this.submenuComponent = new SubmenuWrapper(item.label, list, [{ key: "Enter", verb: "open" }], "Which file?");
			return;
		}
		if (item.submenu) {
			this.openValueEditor(item, item.editValue ?? item.currentValue);
			return;
		}
		if (item.values && item.values.length > 0) {
			const theme = pancodeTheme();
			const selectedValue = this.pendingValue ?? item.currentValue;
			const choices: ChoiceItem[] = item.values.map((value) => {
				const meaning = item.valueHelp?.[value];
				return {
					value,
					label: formatSettingsValue(item.configPath, value),
					...(value === item.currentValue ? { mark: theme.fg("selectedOption", GLYPH.ok) } : {}),
					...(meaning ? { description: meaning } : {}),
				};
			});
			const list = new ChoiceList(choices);
			list.setSelectedIndex(Math.max(0, item.values.indexOf(selectedValue)));
			list.onSelect = (choice) =>
				this.prepareScopeConfirm(item, choice.value, {
					verb: "back to choices",
					short: "choices",
					back: () => {
						this.pendingValue = choice.value;
						this.activateSelectedItem();
					},
				});
			list.onCancel = () => {
				this.submenuComponent = null;
				this.options.requestRender?.();
			};
			const timing = effectTiming(item);
			this.submenuComponent = new SubmenuWrapper(
				item.label,
				list,
				[{ key: "Enter", verb: "choose" }],
				`Now ${formatSettingsValue(item.configPath, item.currentValue)}${timing === null ? "" : ` ${GLYPH.sep} a change applies ${timing}`}`,
			);
		}
	}

	/** The item's own editor, opened on `value`; what it submits goes to the scope card, and Esc there comes back here. */
	private openValueEditor(item: SettingsCenterItem, value: string): void {
		const submenu = item.submenu;
		if (!submenu) return;
		this.submenuComponent = submenu(value, (selectedValue) => {
			this.submenuComponent = null;
			if (selectedValue !== undefined)
				this.prepareScopeConfirm(item, selectedValue, {
					verb: "back to edit",
					short: "edit",
					back: () => this.openValueEditor(item, selectedValue),
				});
			this.options.requestRender?.();
		});
	}

	private prepareScopeConfirm(item: SettingsCenterItem, value: string, back?: ScopeCardBack): void {
		let plan: SettingsChangePlan | null;
		try {
			plan = this.options.prepareChange(item, value);
		} catch (error) {
			this.showChangeError(item, value, error);
			return;
		}
		if (!plan) {
			this.submenuComponent = null;
			this.pendingValue = null;
			this.options.requestRender?.();
			return;
		}
		this.openScopeConfirm(plan, back);
	}

	private showChangeError(item: SettingsCenterItem, value: string, error: unknown): void {
		const list = new ChoiceList([
			{ value: "edit", label: "Edit the value", description: "Reopen the editor with what you entered" },
			{ value: "cancel", label: "Cancel", description: "Keep the current value" },
		]);
		list.onSelect = (choice) => {
			this.submenuComponent = null;
			if (choice.value === "edit") {
				if (item.submenu) this.openValueEditor(item, value);
				else this.activateSelectedItem();
			}
			this.options.requestRender?.();
		};
		list.onCancel = () => {
			this.submenuComponent = null;
			this.options.requestRender?.();
		};
		const wrapper = new SubmenuWrapper("Change not saved", list, [{ key: "Enter", verb: "choose" }]);
		wrapper.setProblem(valueProblem(error));
		this.submenuComponent = wrapper;
		this.options.requestRender?.();
	}

	/** Hold one immutable plan while the operator chooses its destination. */
	private openScopeConfirm(plan: SettingsChangePlan, back?: ScopeCardBack): void {
		const restart = !plan.sessionCapable && plan.propagation.some((entry) => entry.timing === "next-session");
		const landing = restart ? "applied after a restart" : "live now";
		const options: ChoiceItem[] = [
			...(plan.sessionCapable
				? [
						{
							value: "session",
							label: "Apply this session",
							description: "Live now and not saved; the next session starts from the saved value",
						},
					]
				: []),
			{
				value: "project",
				label: "Apply and save for this project",
				description: `Saved in this project's .pancode/settings.local.yaml, ${landing}`,
			},
			{
				value: "global",
				label: "Apply and save globally",
				description: `Saved in your user settings.yaml for every project, ${landing}`,
			},
			{ value: "cancel", label: "Cancel", description: "Nothing changes" },
		];
		const list = new ChoiceList(options);
		const finish = (chosen: "session" | "project" | "global" | "cancel"): void => {
			try {
				if (chosen === "session" || chosen === "project" || chosen === "global") this.options.onApply(plan, chosen);
			} catch (error) {
				const item = this.items.find((entry) => entry.id === plan.rowId);
				if (item) this.showChangeError(item, plan.selectedValue, error);
				return;
			}
			this.submenuComponent = null;
			this.pendingValue = null;
			this.options.requestRender?.();
		};
		list.onSelect = (opt) => finish(opt.value as "session" | "project" | "global" | "cancel");
		list.onCancel = () => finish("cancel");
		const title = (width: number): string => formatScopeConfirmTitle(plan, width);
		const affectedBindings = plan.leaves
			.filter((leaf) => leaf.path.startsWith("fleet.agentProfiles."))
			.map((leaf) => leaf.path.slice("fleet.agentProfiles.".length));
		const bindingPreflight =
			plan.selectedValue === REMOVE_PROFILE_CHOICE
				? `Affected agent routes: ${affectedBindings.length > 0 ? affectedBindings.join(", ") : "none"} ${GLYPH.sep} `
				: "";
		const targetRemovalPreflight = (() => {
			if (!plan.rowId.startsWith("connections.") || plan.selectedValue !== "remove") return "";
			const paths = (prefix: string): string[] =>
				plan.leaves.filter((leaf) => leaf.path.startsWith(prefix)).map((leaf) => settingsPathLabel(leaf.path));
			const profiles = plan.leaves
				.filter((leaf) => leaf.path.startsWith("fleet.profiles."))
				.map((leaf) => leaf.path.slice("fleet.profiles.".length).split(".")[0] ?? "profile");
			const describe = (label: string, affected: readonly string[]): string =>
				`Affected ${label}: ${affected.length > 0 ? affected.join(", ") : "none"}`;
			return `${describe("chat route", paths("chat."))} ${GLYPH.sep} ${describe("fleet route", paths("fleet.default."))} ${GLYPH.sep} ${describe("memory route", paths("context.memory."))} ${GLYPH.sep} ${describe("profiles", profiles)} ${GLYPH.sep} `;
		})();
		const affected = [...new Set(plan.leaves.map((leaf) => settingsPathLabel(leaf.path)))];
		const note = `${bindingPreflight}${targetRemovalPreflight}Affects ${affected.join(", ")} ${GLYPH.sep} ${plan.impact}`;
		const card = new SubmenuWrapper(title, list, [{ key: "Enter", verb: "choose" }], note);
		// Esc backs out one layer, to the value being reviewed; only the Cancel row ends the change.
		if (back !== undefined) card.escape = back;
		this.submenuComponent = card;
	}

	private displayValueFor(item: SettingsCenterItem, selected: boolean): { value: string; pending: boolean } {
		if (selected && this.pendingValue !== null && this.pendingValue !== item.currentValue) {
			return { value: this.pendingValue, pending: true };
		}
		return { value: item.currentValue, pending: false };
	}

	/** The source column (`user`, `default`) is evidence for the value; compact shows the label and value alone. */
	private sourceColumn(): boolean {
		return tierPolicy().pickerDetail !== "status";
	}

	/**
	 * The label column a section's rows share at `width`. The rows and the inspector both read it, so they agree on
	 * whether a value was cut. Rows are measured at their current value, so a preview never shifts the column.
	 */
	private labelWidthFor(section: SettingsCenterSection, width: number): number {
		const theme = pancodeTheme();
		const sourceColumn = this.sourceColumn();
		return settingsLabelWidth(section.items, {
			width,
			demand: (item) =>
				settingRowDemand(theme, item, {
					selected: false,
					displayValue: item.currentValue,
					pending: false,
					pinned: false,
					origin: sourceColumn ? this.originFor(item) : null,
				}),
		});
	}

	private originFor(item: SettingsCenterItem): SettingValueOrigin | null {
		if (item.presentationKind !== "setting" || item.readOnly) return null;
		return this.options.originFor?.(item) ?? null;
	}

	/**
	 * What the inspector strip and the detail lane describe: the section, or
	 * the row under the cursor. `rowsWidth` is the lane the rows were drawn in,
	 * so the context knows whether that lane cut the focused value.
	 */
	private inspectorContext(rowsWidth: number): InspectorContext | null {
		const sections = this.sections();
		const section = this.currentSection();
		if (!section) return null;
		const item = this.level === "rows" ? this.selectedItem() : null;
		const selectable = section.items.filter((entry) => this.isSelectableRow(entry));
		const home =
			item !== null && section.id === "recent" ? SETTINGS_SECTIONS.find((area) => area.id === item.section) : undefined;
		const origin = item === null ? null : this.originFor(item);
		const fullValue = ((): string | null => {
			if (item === null) return null;
			const display = this.displayValueFor(item, true);
			return clippedSettingValue(pancodeTheme(), item, rowsWidth, this.labelWidthFor(section, rowsWidth), {
				selected: true,
				displayValue: display.value,
				pending: display.pending,
				pinned: this.isPinned(item),
				origin,
			});
		})();
		const detail = tierPolicy().pickerDetail;
		const file = detail === "pane" && origin !== null ? (this.options.settingsFileFor?.(origin) ?? null) : null;
		return {
			sectionLabel: section.label,
			sectionDescription: SETTINGS_SECTION_DESCRIPTIONS[section.id],
			position: `section ${sections.findIndex((entry) => entry.id === section.id) + 1} of ${sections.length}`,
			counts: { label: this.sectionCount(section), changed: selectable.filter((entry) => isModified(entry)).length },
			item,
			...(fullValue === null ? {} : { fullValue }),
			...(item !== null && this.pendingValue !== null && this.pendingValue !== item.currentValue
				? { previewValue: this.pendingValue }
				: {}),
			origin,
			pinned: item !== null && this.isPinned(item),
			pinnable: isShortcutRow(item),
			rowKeysLive: this.keyOwner() === "rows",
			...(home ? { homeLabel: home.label } : {}),
			detail,
			...(file === null ? {} : { file }),
		};
	}

	private laneWidths(width: number): { left: number; separator: string; separatorWidth: number } {
		return {
			left: Math.min(SECTION_LANE_WIDTH, Math.max(16, Math.floor(width * 0.3))),
			separator: barSep(pancodeTheme()),
			separatorWidth: visibleWidth(` ${GLYPH.rail} `),
		};
	}

	private joinLanes(
		lanes: ReadonlyArray<{ lines: ReadonlyArray<string>; width: number }>,
		height: number,
		separator: string,
	): string[] {
		return Array.from({ length: height }, (_, index) =>
			lanes.map((lane) => padAnsi(lane.lines[index] ?? "", lane.width, GLYPH.ellipsis)).join(separator),
		);
	}

	/**
	 * Three lanes at 120 columns and up: sections, the rows, and the row's full
	 * explanation. The rows lane stops growing at `ROWS_LANE_MAX_WIDTH`, because
	 * a label, a value and an origin do not need a hundred cells between them,
	 * and the detail lane takes the room instead, up to a readable measure.
	 */
	private renderUltraWide(width: number, bodyHeight: number): string[] {
		const head = this.filterEditorLines(width);
		const bodyRows = Math.max(1, bodyHeight - head.length);
		if (this.sections().length === 0) return [...head, ...this.emptyFilterLines(width, bodyRows)];
		const { left: leftWidth, separator, separatorWidth } = this.laneWidths(width);
		const left = this.renderSectionLane(leftWidth, bodyRows);
		if (this.submenuComponent) {
			const workWidth = Math.max(1, width - leftWidth - separatorWidth);
			const work = this.renderWorkLane(workWidth, bodyRows);
			return [
				...head,
				...this.joinLanes(
					[
						{ lines: left, width: leftWidth },
						{ lines: work, width: workWidth },
					],
					bodyRows,
					separator,
				),
			];
		}
		const rest = Math.max(2, width - leftWidth - separatorWidth * 2);
		let detailWidth = Math.max(DETAIL_LANE_MIN_WIDTH, Math.min(DETAIL_LANE_MAX_WIDTH, Math.floor(rest * 0.4)));
		let centerWidth = Math.max(1, rest - detailWidth);
		if (centerWidth > ROWS_LANE_MAX_WIDTH) {
			detailWidth = Math.min(DETAIL_LANE_MAX_WIDTH, rest - ROWS_LANE_MAX_WIDTH);
			centerWidth = ROWS_LANE_MAX_WIDTH;
		}
		const center = this.renderRowsLane(centerWidth, bodyRows);
		const context = this.inspectorContext(centerWidth);
		const right = context
			? renderDetailLane(pancodeTheme(), context, detailWidth, bodyRows)
			: fitRows([], detailWidth, bodyRows);
		return [
			...head,
			...this.joinLanes(
				[
					{ lines: left, width: leftWidth },
					{ lines: center, width: centerWidth },
					{ lines: right, width: detailWidth },
				],
				bodyRows,
				separator,
			),
		];
	}

	/** The one-line filter editor, shown at every width while it owns input, or what a committed filter is hiding. */
	private filterEditorLines(width: number): string[] {
		if (this.filterDraft === null) {
			if (this.filterQuery.length === 0) return [];
			const matches = this.sections().reduce(
				(count, section) => count + section.items.filter((item) => this.isSelectableRow(item)).length,
				0,
			);
			// `Esc clears` only while the filter is the next thing Esc backs out of; under an open edit or scope card Esc means that layer.
			const escClears = innermostEscapeLayer(this.escapeLayers())?.verb === "clear filter";
			const text = `filter ${GLYPH.quoteOpen}${this.filterQuery}${GLYPH.quoteClose} ${GLYPH.sep} ${matches} ${matches === 1 ? "match" : "matches"}${escClears ? ` ${GLYPH.sep} Esc clears` : ""} ${GLYPH.sep} / starts over`;
			return [truncateToWidth(pancodeTheme().fg("searchQuery", text), width, GLYPH.ellipsis, false)];
		}
		// The editor draws its own caret, so the row stops faking one with `_`.
		this.filterInput.focused = true;
		const theme = pancodeTheme();
		const title = `${GLYPH.laneOwner} Filter `;
		const room = Math.max(1, width - visibleWidth(title));
		return this.filterInput
			.render(room)
			.map((line) => `${theme.style("selectedOption", title, { bold: true })}${theme.base("searchQuery", line)}`);
	}

	private emptyFilterLines(width: number, height: number): string[] {
		return fitRows(
			emptyState(
				pancodeTheme(),
				`No settings match ${GLYPH.quoteOpen}${this.effectiveFilterQuery()}${GLYPH.quoteClose}`,
				width,
				{
					remedy: `/ edits the filter ${GLYPH.sep} an empty Enter clears it. Not every setting has a row. Edit settings file lists them all.`,
				},
			),
			width,
			height,
		);
	}

	/**
	 * Two lanes from 72 columns: sections and rows, with the inspector strip
	 * under both. The strip takes at most four rows and never more than the list
	 * can spare, so an 80-column terminal shows ten settings where the old
	 * footer left room for four.
	 */
	private renderWide(width: number, bodyHeight: number): string[] {
		const head = this.filterEditorLines(width);
		const available = Math.max(1, bodyHeight - head.length);
		if (this.sections().length === 0) return [...head, ...this.emptyFilterLines(width, available)];
		const { left: leftWidth, separator, separatorWidth } = this.laneWidths(width);
		const rightWidth = Math.max(1, width - leftWidth - separatorWidth);
		if (this.submenuComponent) {
			return [
				...head,
				...this.joinLanes(
					[
						{ lines: this.renderSectionLane(leftWidth, available), width: leftWidth },
						{ lines: this.renderWorkLane(rightWidth, available), width: rightWidth },
					],
					available,
					separator,
				),
			];
		}
		const context = this.inspectorContext(rightWidth);
		// The detailed strip adds one row for the file and the scope a change may be saved to.
		const rows = INSPECTOR_ROWS + (context?.detail === "pane" ? 1 : 0);
		const budget = Math.min(rows, Math.max(0, available - MIN_LIST_ROWS));
		const inspector = context ? renderInspector(pancodeTheme(), context, width, budget) : [];
		const contentHeight = Math.max(1, available - inspector.length);
		return [
			...head,
			...this.joinLanes(
				[
					{ lines: this.renderSectionLane(leftWidth, contentHeight), width: leftWidth },
					{ lines: this.renderRowsLane(rightWidth, contentHeight), width: rightWidth },
				],
				contentHeight,
				separator,
			),
			...inspector,
		];
	}

	private renderSectionLane(width: number, height: number): string[] {
		const theme = pancodeTheme();
		const rows = this.sectionCatalogRows();
		// The lane has room only for `◇1` beside a label, so the word that says what it counts sits above it (F13).
		const anyChanged = !this.effectiveFilterQuery().length && rows.some((row) => row.badge !== undefined);
		const owner = this.keyOwner();
		const header = renderLaneTitle(theme, {
			label: "Sections",
			active: owner === "sections",
			width,
			tabReaches: owner === "rows",
			...(anyChanged ? { meta: theme.fg("changedValue", `${GLYPH.scoped} changed`) } : {}),
		});
		const selectedLine = Math.max(
			0,
			rows.findIndex((row) => row.sectionId === this.selectedSectionId),
		);
		const slots = Math.max(1, height - 1);
		if (rows.length <= slots) {
			return fitRows([header, ...renderSectionLane(theme, rows, width)], width, height);
		}
		// A cut list says what it hid and whether a hidden section carries a change,
		// because at 80x24 the last section and its changed mark fell off unannounced.
		const [start, end] = centeredWindow(rows.length, selectedLine, Math.max(1, slots - 2));
		const marker = (glyph: string, hidden: typeof rows): string => {
			const changed = hidden.some((row) => row.badge !== undefined) && !this.effectiveFilterQuery().length;
			return theme.fg(
				"positionCount",
				`  ${glyph} ${hidden.length} more${changed ? ` ${GLYPH.sep} ${GLYPH.scoped} changed` : ""}`,
			);
		};
		const above = rows.slice(0, start);
		const below = rows.slice(end);
		return fitRows(
			[
				header,
				...(above.length > 0 ? [marker(GLYPH.up, above)] : []),
				...renderSectionLane(theme, rows.slice(start, end), width),
				...(below.length > 0 ? [marker(GLYPH.down, below)] : []),
			],
			width,
			height,
		);
	}

	/**
	 * The section catalog, shared by the wide lane and the narrow sections page.
	 * The current section stays highlighted whichever lane holds the cursor, so
	 * the rows on the right always say which section they belong to.
	 */
	private sectionCatalogRows(wordedBadge = false): Array<SectionLaneRow & { sectionId: SettingsSectionId }> {
		const theme = pancodeTheme();
		const filtering = this.effectiveFilterQuery().length > 0;
		return this.sections().map((section) => {
			const selected = section.id === this.selectedSectionId;
			const matchCount = section.items.filter((item) => this.isSelectableRow(item)).length;
			const modifiedCount = section.items.filter((item) => isModified(item)).length;
			const badge = filtering
				? theme.fg("positionCount", `${matchCount}`)
				: modifiedCount > 0 && section.id !== "recent"
					? theme.fg("changedValue", `${GLYPH.scoped}${modifiedCount}${wordedBadge ? " changed" : ""}`)
					: undefined;
			return {
				sectionId: section.id,
				label: section.label,
				current: selected,
				focused: selected && this.keyOwner() === "sections",
				...(badge === undefined ? {} : { badge }),
			};
		});
	}

	private renderWorkLane(width: number, height: number): string[] {
		const submenu = this.submenuComponent;
		if (!submenu) return fitRows([], width, height);
		if (isRowBudgeted(submenu)) submenu.setBodyRows(height);
		return fitRows(submenu.render(width), width, height);
	}

	private renderRowsLane(width: number, height: number): string[] {
		const theme = pancodeTheme();
		const section = this.currentSection();
		if (!section) return fitRows([], width, height);
		const changed = section.items.filter((item) => isModified(item)).length;
		const meta = changed > 0 ? `${GLYPH.scoped} ${changed} changed` : this.sectionCount(section);
		const owner = this.keyOwner();
		const title = renderLaneTitle(theme, {
			label: section.label,
			active: owner === "rows",
			width,
			meta,
			tabReaches: owner === "sections",
		});
		return fitRows(
			[title, ...this.renderRowsBody(section, width, Math.max(1, height - 1), owner === "rows")],
			width,
			height,
		);
	}

	/**
	 * One section's rows, windowed to `height` around the cursor row, with a
	 * position line in place of the last row whenever rows are hidden. Rows are
	 * the section's own rows at every width. Flattening the catalog on narrow
	 * terminals meant an operator scrolling Retry fell into Terminal with
	 * nothing in the frame saying they had left the section they opened.
	 */
	private renderRowsBody(
		section: SettingsCenterSection,
		width: number,
		height: number,
		cursorVisible: boolean,
	): string[] {
		const theme = pancodeTheme();
		const selected = this.rowIndex(section.id);
		const labelWidth = this.labelWidthFor(section, width);
		const selectedId = cursorVisible ? (section.items[selected]?.id ?? null) : null;
		const sourceColumn = this.sourceColumn();
		const lines: string[] = [];
		const starts: number[] = [];
		{
			// Models opens with the connections table; the rest of the area renders as setting rows.
			const tableItems = section.items.filter((item) => item.id === "connections" || item.targetConsole !== undefined);
			const table =
				tableItems.length > 0 ? renderTargetTable(theme, tableItems, selectedId, width, labelWidth) : undefined;
			section.items.forEach((item, index) => {
				starts.push(lines.length);
				const tableIndex = table ? tableItems.indexOf(item) : -1;
				if (table && tableIndex >= 0) {
					const from = table.starts[tableIndex] ?? table.lines.length;
					const to = table.starts[tableIndex + 1] ?? table.lines.length;
					lines.push(...table.lines.slice(from, to));
					return;
				}
				const isSelected = index === selected && cursorVisible;
				const display = this.displayValueFor(item, isSelected);
				lines.push(
					renderSettingRow(theme, item, width, labelWidth, {
						selected: isSelected,
						displayValue: display.value,
						pending: display.pending,
						pinned: this.isPinned(item),
						origin: sourceColumn ? this.originFor(item) : null,
					}),
				);
			});
		}
		if (lines.length <= height) return lines;
		const visible = Math.max(1, height - 1);
		const [start] = centeredWindow(lines.length, starts[selected] ?? 0, visible);
		const window = lines.slice(start, start + visible);
		// The count is of the rows a cursor can land on, the same thing the section's
		// title counts: lines would add the group headings, so a title of 12 settings
		// sat over `1–10 of 13 rows`.
		const ordinals = section.items.flatMap((item, index) =>
			this.isSelectableRow(item) && item.id !== "connections" ? [starts[index] ?? 0] : [],
		);
		const shown = ordinals.flatMap((line, ordinal) =>
			line >= start && line < start + window.length ? [ordinal + 1] : [],
		);
		return [
			...window,
			renderRowsPosition(
				theme,
				{
					start: shown[0] ?? 0,
					end: shown.at(-1) ?? 0,
					total: ordinals.length,
					unit: "settings",
				},
				width,
			),
		];
	}

	/**
	 * The narrow stack: one page at a time under a breadcrumb. The flattened
	 * catalog it replaces rendered every section and every row into one scroll,
	 * so a 40-column terminal showed six sections' worth of context and no way to
	 * tell which one owned the cursor.
	 */
	private renderNarrow(width: number, bodyHeight: number): string[] {
		const head = [this.breadcrumbLine(width), ...this.filterEditorLines(width)];
		const available = Math.max(1, bodyHeight - head.length);
		if (this.sections().length === 0) return [...head, ...this.emptyFilterLines(width, available)];
		if (this.submenuComponent) return [...head, ...this.renderWorkLane(width, available)];
		// Prose is the first thing a short terminal can spare. Sixteen body rows
		// keep two inspector rows, ten keep one, and anything shorter gives every
		// row to the list; the description stays reachable at wider widths.
		const budget = bodyHeight >= 16 ? 2 : bodyHeight >= 10 ? 1 : 0;
		const context = this.inspectorContext(width);
		const inspector = context ? renderNarrowInspector(pancodeTheme(), context, width, budget) : [];
		const listHeight = Math.max(1, available - inspector.length);
		const list =
			this.level === "sections" ? this.renderSectionsPage(width, listHeight) : this.renderRowsPage(width, listHeight);
		return [...head, ...list, ...inspector];
	}

	private breadcrumbLine(width: number): string {
		const theme = pancodeTheme();
		const sections = this.sections();
		const section = this.currentSection();
		const trail: string[] = ["Settings"];
		if (this.level === "sections" && !this.submenuComponent) trail.push("Sections");
		else if (section) trail.push(section.label);
		if (this.submenuComponent) {
			const item = this.selectedItem();
			if (item) trail.push(item.label);
		}
		const query = this.filterQuery.trim();
		// The page's own size, in the words its position row uses. A bare `1/12` here
		// was the section's index and read as a count of the settings below it.
		const meta =
			query.length > 0
				? `/${query}`
				: this.level === "sections" && !this.submenuComponent
					? `${sections.length} sections`
					: section && !this.submenuComponent
						? this.sectionCount(section)
						: "";
		return titleRow(theme, trail.join(` ${GLYPH.crumb} `), width, meta.length > 0 ? { meta } : {});
	}

	private renderSectionsPage(width: number, height: number): string[] {
		const rows = this.sectionCatalogRows(true);
		const selectedLine = Math.max(
			0,
			rows.findIndex((row) => row.sectionId === this.selectedSectionId),
		);
		if (rows.length <= height) return fitRows(renderSectionLane(pancodeTheme(), rows, width), width, height);
		// A list longer than its rows says how much is below it, the way the rows page does.
		const [start, end] = centeredWindow(rows.length, selectedLine, Math.max(1, height - 1));
		return fitRows(
			[
				...renderSectionLane(pancodeTheme(), rows.slice(start, end), width),
				renderRowsPosition(pancodeTheme(), { start: start + 1, end, total: rows.length, unit: "sections" }, width),
			],
			width,
			height,
		);
	}

	private renderRowsPage(width: number, height: number): string[] {
		const section = this.currentSection();
		if (!section) return fitRows([], width, height);
		return fitRows(this.renderRowsBody(section, width, height, this.keyOwner() === "rows"), width, height);
	}
}

export interface OpenSettingsOverlayDeps {
	getSettings: () => Readonly<PancodeSettings>;
	providers?: ProvidersContract;
	writeSettings: (next: PancodeSettings) => void;
	/**
	 * Scoped commit for a single edit. When present, the overlay routes session
	 * and global saves through it; when absent it falls back to writeSettings
	 * (every edit goes global). It returns false when a
	 * gate held the change instead of applying it (the yolo acceptance card).
	 */
	commitSetting?: (id: string, next: PancodeSettings, scope: "session" | "project" | "global") => unknown;
	notice?: (level: NotificationLevel, text: string, key?: string) => void;
	onClose: () => void;
	/** Open focused on this section (deep link from `/settings <section>`). */
	section?: SettingsSectionId;
	/** Optional semantic row anchor for command deep links. */
	rowId?: SettingsCenterRowId;
	getFleetNodes?: BuildSettingItemsOptions["getFleetNodes"];
	getRouteBreakers?: BuildSettingItemsOptions["getRouteBreakers"];
	connectTarget?: BuildSettingItemsOptions["connectTarget"];
	getInteropProposals?: BuildSettingItemsOptions["getInteropProposals"];
	/**
	 * Which layer set the effective value at a settings path: a session
	 * override, a project or user file, or the built-in default. Absent leaves
	 * the origin column and the inspector's "from" fact empty.
	 */
	settingOrigin?: (path: string) => SettingValueOrigin;
	/** "Check setup": the host closes settings and runs the doctor. */
	checkSetup?: () => void;
	/** Hands the terminal to an external editor; defaults to stopping and restarting this TUI. */
	suspendTerminal?: <T>(run: () => T) => T;
}

function formatSettingChangeNotice(id: string, value: string, scope: "session" | "project" | "global"): string {
	const scopedRefs = id === "chat.modelPicker.cycleSet" ? parseScopedModelSelection(value) : null;
	const path = settingsPathForRow(id);
	// The notice reads the value the way the row does (`$7.50`, `On`), not as it was typed.
	const displayValue = scopedRefs
		? scopedRefs.length > 0
			? scopedRefs.join(", ")
			: "(empty)"
		: formatSettingsValue(path, value);
	const label = settingControl(path)?.label ?? SETTINGS_LABELS_BY_ID[id as keyof typeof SETTINGS_LABELS_BY_ID] ?? path;
	return `${label} set to ${displayValue} (${scope === "global" ? "saved globally" : scope === "project" ? "saved for this project" : "this session"})`;
}

export interface SettingsOverlayHandle extends OverlayHandle {
	/**
	 * Re-derive every row from the live effective settings. Called after each
	 * committed edit and on config change events while the overlay is open, so
	 * dependent rows never go stale.
	 */
	refreshRows(): void;
}

function settingsBodyHeight(tui: TUI): number {
	return dockBodyRows(tui);
}

/**
 * The file each settings layer reads, home collapsed, resolved once per
 * origin while the overlay is open: the project lookup walks the directory
 * tree, and a render must not.
 */
function settingsFileResolver(cwd: string): (origin: SettingValueOrigin) => string | null {
	const files = new Map<SettingValueOrigin, string | null>();
	const resolveFile = (origin: SettingValueOrigin): string | null => {
		if (origin === "user") return settingsPath();
		if (origin !== "project" && origin !== "project.local") return null;
		const name = origin === "project" ? "settings.yaml" : "settings.local.yaml";
		return join(pancodeProjectRoot(cwd, "settings.yaml", "settings.local.yaml"), ".pancode", name);
	};
	return (origin) => {
		if (!files.has(origin)) {
			const file = resolveFile(origin);
			files.set(origin, file === null ? null : collapseHomePath(file));
		}
		return files.get(origin) ?? null;
	};
}

export function openSettingsOverlay(tui: TUI, deps: OpenSettingsOverlayDeps): SettingsOverlayHandle {
	let wizard: OverlayHandle | null = null;
	const launchWizard = (targetId?: string, byUrl = false): void => {
		const target = targetId ? deps.getSettings().connections.find((entry) => entry.id === targetId) : undefined;
		if (targetId && !target) return;
		wizard?.hide();
		const options: TargetWizardOptions = target
			? { mode: "edit", target: structuredClone(target) }
			: byUrl
				? { mode: "url" }
				: { mode: "add" };
		wizard = openTargetWizard(tui, options, () => {
			wizard = null;
			refreshRows();
			// A target just added reads `? unknown` until probed, which the wizard already showed was reachable.
			void deps.providers?.probeAllLive().then(refreshRows, () => {
				// The health cell stays unknown, which is what a failed probe of the probe itself means.
			});
		});
	};
	// A target removed from user settings takes the key it owned, as `pancode connections remove` does;
	// after it is gone no command can name that key.
	const removedTargetCredential = (plan: SettingsChangePlan): string | null => {
		const auth = deps.providers?.auth;
		if (!auth || !plan.rowId.startsWith("connections.") || plan.selectedValue !== "remove") return null;
		const targetId = plan.rowId.slice("connections.".length);
		const removed = plan.original.connections.find((target) => target.id === targetId);
		const remaining = deps.getSettings().connections;
		if (!removed || remaining.some((target) => target.id === targetId)) return null;
		return applyTargetCredentialPlan(
			planTargetCredentialRemoval(removed as TargetDescriptor, remaining, getRuntimeRegistry().list()),
			{
				isStored: (key) => auth.getStored(key) !== null,
				remove: (key) => auth.remove(key),
				damageReason: () => auth.damageReason(),
			},
		);
	};
	const targetOperations = new Map<string, { operation: "connect" | "probe"; token: object }>();
	const buildOptions: BuildSettingItemsOptions = {
		getSettings: deps.getSettings,
		onFleetSettingsChanged: (saved) => {
			const next = structuredClone(deps.getSettings()) as PancodeSettings;
			next.fleet.nodes = saved.fleet.nodes;
			if (deps.commitSetting) deps.commitSetting("fleet.nodes", next, "global");
			else deps.writeSettings(next);
		},
		editTarget: (targetId) => launchWizard(targetId),
		requestRefresh: () => refreshRows(),
		getTargetOperation: (targetId) => {
			const keyboardOwningOperation = targetOperations.entries().next().value as
				| [string, { operation: "connect" | "probe"; token: object }]
				| undefined;
			return keyboardOwningOperation?.[0] === targetId ? keyboardOwningOperation[1].operation : null;
		},
		onTargetOperationChange: (targetId, operation, operationToken) => {
			if (operation) targetOperations.set(targetId, { operation, token: operationToken });
			else if (targetOperations.get(targetId)?.token === operationToken) targetOperations.delete(targetId);
		},
	};
	if (deps.providers) buildOptions.providers = deps.providers;
	if (deps.getFleetNodes) buildOptions.getFleetNodes = deps.getFleetNodes;
	if (deps.getRouteBreakers) buildOptions.getRouteBreakers = deps.getRouteBreakers;
	if (deps.connectTarget) buildOptions.connectTarget = deps.connectTarget;
	if (deps.getInteropProposals) buildOptions.getInteropProposals = deps.getInteropProposals;
	const items = buildSettingItems(deps.getSettings(), buildOptions);
	const center = new SettingsCenter(items, {
		getBodyHeight: () => settingsBodyHeight(tui),
		prepareChange: (item, value) =>
			createSettingsChangePlan(deps.getSettings(), item, value, Boolean(deps.commitSetting)),
		shortcuts: listSettingsShortcuts(),
		pinSetting: setSettingPinned,
		...(deps.settingOrigin ? { originFor: (item) => deps.settingOrigin?.(item.configPath) ?? null } : {}),
		settingsFileFor: settingsFileResolver(process.cwd()),
		onApply: (plan, scope) => {
			if (deps.commitSetting) {
				let held = false;
				for (const leaf of plan.leaves) {
					if (deps.commitSetting(leaf.path, plan.proposed as PancodeSettings, scope) === false) held = true;
				}
				// A held change (turning yolo on waits for its acceptance card, which
				// reports the outcome) is not announced as set (#407).
				if (held) {
					refreshRows();
					return;
				}
			} else deps.writeSettings(plan.proposed as PancodeSettings);
			// Only a committed edit counts: a canceled or refused one never reaches this line.
			if (isShortcutRow(items.find((entry) => entry.id === plan.rowId)))
				center.setShortcuts(rememberChangedSetting(plan.rowId));
			const credential = scope === "global" ? removedTargetCredential(plan) : null;
			deps.notice?.(
				"success",
				`${formatSettingChangeNotice(plan.rowId, plan.selectedValue, scope)}${credential ? `; ${credential}` : ""}`,
				`settings:${plan.rowId}`,
			);
			refreshRows();
		},
		onAddTarget: () => launchWizard(),
		onConnectByUrl: () => launchWizard(undefined, true),
		onEditSettingsFile: (file) => {
			editSettingsFile(file, {
				cwd: process.cwd(),
				suspendTerminal:
					deps.suspendTerminal ??
					(<T>(run: () => T): T => {
						try {
							tui.stop();
							return run();
						} finally {
							tui.start();
							tui.requestRender(true);
						}
					}),
				notice: (level, text) => deps.notice?.(level, text, "settings:file"),
			});
			refreshRows();
		},
		...(deps.checkSetup ? { onCheckSetup: deps.checkSetup } : {}),
		onCancel: () => deps.onClose(),
		requestRender: () => tui.requestRender(),
	});
	if (deps.section) {
		const sectionItems =
			buildSettingsSections(items).find((section) => section.id === resolveSettingsArea(deps.section ?? ""))?.items ?? [];
		const rowIndex = deps.rowId ? sectionItems.findIndex((item) => item.id === deps.rowId) : -1;
		center.setSelection(deps.section, rowIndex >= 0 ? rowIndex : 0);
	}
	const refreshRows = (): void => {
		refreshSettingItemsInPlace(items, buildSettingItems(deps.getSettings(), buildOptions));
		center.refreshItems();
		tui.requestRender();
	};
	const handle = showPancodeOverlayFrame(tui, center, {
		anchor: "top-left",
		width: SETTINGS_OVERLAY_WIDTH,
		maxHeight: SETTINGS_OVERLAY_MAX_HEIGHT,
		// A capturing overlay must own every horizontal cell. Leaving even a
		// two-column compositor margin exposes arbitrary transcript and footer
		// fragments beside the frame, where they read as modal content.
		margin: SETTINGS_OVERLAY_MARGIN,
		markerId: "settings",
		title: "Settings",
		// A submenu's keys and where Esc lands from it both ride this rail.
		footerHint: (innerWidth) => center.railHint(innerWidth),
	});
	return {
		...handle,
		refreshRows,
		hide() {
			wizard?.hide();
			wizard = null;
			handle.hide();
		},
	};
}
