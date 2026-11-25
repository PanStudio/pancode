// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { SETTINGS_AREAS as SETTINGS_SECTIONS, settingsPlacementForRow } from "../../core/settings-areas.js";
/** buildSettingsSections: suggested and shortcut rows, row placement, and the in-place refresh of built items. */
import { orderAreaEntries } from "../../core/settings-controls.js";
import type { SettingsShortcuts } from "../../core/settings-shortcuts.js";
import type { SettingsCenterItem, SettingsCenterSection } from "./settings-center-model.js";
import { groupHeader } from "./settings-item-rows.js";

/** Curated starting points, in order, for people who have not pinned or changed anything yet. */
const SUGGESTED_SETTING_IDS: readonly string[] = [
	"chat.model",
	"chat.thinkingLevel",
	"chat.maxOutputTokens",
	"safety.autonomy",
	"interface.outputDetail",
	"interface.desktopNotifications",
	"context.compaction.auto",
	"context.compaction.threshold",
	"safety.limits.sessionCostUsd",
	"fleet.default.model",
	"fleet.concurrency",
	"safety.review.enabled",
];
/** The most shortcuts the landing view shows: pins first, then recent, then suggested. */
const SHORTCUT_SLOTS = 12;

/** Only a real, writable setting can be pinned or enter Recent; actions and status rows cannot. */
/**
 * Space previews a choice row's next value in place. A restart-only row has nothing a preview could show before the
 * restart, so it offers Enter alone.
 */
export function previewable(
	item: SettingsCenterItem | null | undefined,
): item is SettingsCenterItem & { values: ReadonlyArray<string> } {
	return (
		item !== null && item !== undefined && !item.readOnly && item.scope !== "restart" && (item.values?.length ?? 0) > 0
	);
}

export function isShortcutRow(item: SettingsCenterItem | null | undefined): item is SettingsCenterItem {
	return item !== undefined && item !== null && item.presentationKind === "setting" && !item.readOnly;
}

/**
 * The Recent & Pinned view: the same row objects as their home areas, so a
 * shortcut opens the same editor and review flow. Suggested rows only fill
 * slots that no pin or real change has taken, and are never called recent.
 */
function shortcutRows(items: readonly SettingsCenterItem[], shortcuts: SettingsShortcuts): SettingsCenterItem[] {
	const available = new Map(items.filter(isShortcutRow).map((item) => [item.id as string, item] as const));
	const taken = new Set<string>();
	const pick = (ids: readonly string[], limit: number): SettingsCenterItem[] => {
		const rows: SettingsCenterItem[] = [];
		for (const id of ids) {
			const item = available.get(id);
			if (!item || taken.has(id) || rows.length >= limit) continue;
			taken.add(id);
			rows.push(item);
		}
		return rows;
	};
	// The landing view shows SHORTCUT_SLOTS rows in all. Pins beyond that stay pinned and marked in their home area.
	const pinned = pick(shortcuts.pinned, SHORTCUT_SLOTS);
	const recent = pick(shortcuts.recent, SHORTCUT_SLOTS - pinned.length);
	const suggested = pick(SUGGESTED_SETTING_IDS, Math.max(0, SHORTCUT_SLOTS - pinned.length - recent.length));
	const heading = (name: string, description: string): SettingsCenterItem =>
		groupHeader(`settings.group.recent.${name.toLowerCase()}`, "recent", name, description);
	return [
		...(pinned.length > 0
			? [heading("Pinned", "Settings you pinned. Press p on a row to pin or unpin it."), ...pinned]
			: []),
		...(recent.length > 0 ? [heading("Recent", "Settings you changed most recently, newest first."), ...recent] : []),
		...(suggested.length > 0
			? [heading("Suggested", "Common settings to start from. Change one and it moves to Recent."), ...suggested]
			: []),
	];
}

/** What `buildSettingsSections` reads from a row to place it; everything else reaches a section through the row object. */
export interface SettingsRowPlacement {
	readonly item: SettingsCenterItem;
	readonly id: string;
	readonly section: SettingsCenterItem["section"];
	readonly kind: SettingsCenterItem["presentationKind"];
	readonly path: string;
	readonly readOnly: boolean;
}

export function placementOf(item: SettingsCenterItem): SettingsRowPlacement {
	return {
		item,
		id: item.id,
		section: item.section,
		kind: item.presentationKind,
		path: item.configPath,
		readOnly: item.readOnly === true,
	};
}

export function samePlacement(rows: readonly SettingsRowPlacement[], items: readonly SettingsCenterItem[]): boolean {
	if (rows.length !== items.length) return false;
	return rows.every((row, index) => {
		const item = items[index];
		return (
			row.item === item &&
			row.id === item.id &&
			row.section === item.section &&
			row.kind === item.presentationKind &&
			row.path === item.configPath &&
			row.readOnly === (item.readOnly === true)
		);
	});
}

export function buildSettingsSections(
	items: readonly SettingsCenterItem[],
	shortcuts: SettingsShortcuts = { pinned: [], recent: [] },
): SettingsCenterSection[] {
	return SETTINGS_SECTIONS.map((section) => {
		if (section.id === "recent") return { id: section.id, label: section.label, items: shortcutRows(items, shortcuts) };
		const rows = orderAreaEntries(
			section.id,
			items.filter(
				(item) => item.section === section.id && (item.id === "targets" || item.presentationKind !== "group-header"),
			),
			(item) => ({ id: item.id, path: item.configPath ?? item.id }),
		);
		const groups = new Map<string, SettingsCenterItem[]>();
		for (const item of rows) {
			const group = settingsPlacementForRow(item.id, item.configPath ?? item.id).group;
			const entries = groups.get(group) ?? [];
			entries.push(item);
			groups.set(group, entries);
		}
		return {
			id: section.id,
			label: section.label,
			items: [...groups].flatMap(([label, entries], index) =>
				label
					? [groupHeader(`settings.group.${section.id}.${index}`, section.id, label, section.description), ...entries]
					: entries,
			),
		};
	});
}

export function refreshSettingItemsInPlace(items: SettingsCenterItem[], next: readonly SettingsCenterItem[]): void {
	const byId = new Map(next.map((item) => [item.id, item] as const));
	// Entry rows come and go with their profiles, bindings, and targets; surviving row objects keep their identity.
	const existing = new Map(items.map((item) => [item.id, item] as const));
	items.splice(0, items.length, ...next.map((item) => existing.get(item.id) ?? item));
	for (const item of items) {
		const updated = byId.get(item.id);
		if (!updated) continue;
		item.label = updated.label;
		item.currentValue = updated.currentValue;
		item.description = updated.description;
		item.section = updated.section;
		item.configPath = updated.configPath;
		item.affordance = updated.affordance;
		item.scope = updated.scope;
		item.readOnly = updated.readOnly;
		item.presentationKind = updated.presentationKind;
		item.valueSegments = updated.valueSegments;
		if (updated.targetConsole) item.targetConsole = updated.targetConsole;
		else delete item.targetConsole;
		if (updated.help) item.help = updated.help;
		else delete item.help;
		if (updated.valueHelp) item.valueHelp = updated.valueHelp;
		else delete item.valueHelp;
		if (updated.defaultValue !== undefined) item.defaultValue = updated.defaultValue;
		else delete item.defaultValue;
		if (updated.values) item.values = updated.values;
		else delete item.values;
		if (updated.submenu) item.submenu = updated.submenu;
		else delete item.submenu;
	}
}
