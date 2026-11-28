// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../../core/config.js";
import type { WorkerEscalationSettings } from "../../core/defaults.js";
import { DEFAULT_SETTINGS, THINKING_LEVELS } from "../../core/defaults.js";
import { getAtPath, isRoutingPath } from "../../core/session-routing.js";
import type { SettingsAreaId as SettingsSectionId } from "../../core/settings-areas.js";
import { SETTINGS_AREAS as SETTINGS_SECTIONS, settingsPlacementForRow } from "../../core/settings-areas.js";
/** The settings center's row, section and item types, its layout constants, and the per-setting scope and default reads. */
import { SETTINGS_LABELS_BY_ID, settingsPathForRow } from "../../core/settings-controls.js";
import type { RouteBreakerView } from "../../domains/dispatch/contract.js";
import type { InteropProposal } from "../../domains/interop/index.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { FleetNodeSnapshot } from "../../domains/scheduling/cluster.js";
import type { SettingItem } from "../../engine/tui.js";

export const SETTINGS_OVERLAY_WIDTH = "100%";
export const SETTINGS_OVERLAY_MAX_HEIGHT = "100%";
export const SETTINGS_OVERLAY_MARGIN = {
	top: 1,
	right: 0,
	bottom: 1,
	left: 0,
} as const;

export const SECTION_LANE_WIDTH = 24;
/**
 * The width at which the live description earns its own column instead of a
 * footer strip. Same arithmetic as WIDE_LAYOUT_MIN_WIDTH below: two nested
 * frames sit above this body, each costing a border and a pad, so the body is
 * the terminal width less eight. A 120-column terminal renders at 112 and a
 * 119-column one at 111, so 112 is the floor that makes three columns start at
 * a real 120-column terminal.
 */
export const ULTRAWIDE_LAYOUT_MIN_WIDTH = 112;
/**
 * The design's degradation matrix wants the two-column layout at an 80-column
 * terminal. Two nested frames sit above this body (the application frame and
 * the overlay's own), each costing a border and a pad, so the body is the
 * terminal width less eight: 72 at an 80-column terminal, 68 at a 76-column
 * one. 72 therefore keeps an 80-column terminal two-column (left lane 24 +
 * divider + rows ~47) while anything narrower stays stacked.
 */
export const WIDE_LAYOUT_MIN_WIDTH = 72;
/** Shown when no runtime is resolvable, so it offers the full vocabulary. */
export const FALLBACK_THINKING_VALUES: ReadonlyArray<string> = THINKING_LEVELS;
export const ROW_GAP = "  ";
/**
 * `workers.escalation` and `workers.resilienceCooldownMs` are optional keys, so
 * the row that shows them and the mutation that writes them both need a
 * definite shipped value to fall back to.
 */
export const SHIPPED_ESCALATION: WorkerEscalationSettings = DEFAULT_SETTINGS.fleet.permissions.escalation ?? {
	timeoutMs: 120_000,
	fallback: "deny",
};
export const SHIPPED_RESILIENCE_COOLDOWN_MS = DEFAULT_SETTINGS.fleet.retry.routeCooldownMs ?? 15_000;
/**
 * The product's cut marker, as the help center and every list overlay use it.
 *
 * A setting key is an identifier the operator types into settings.yaml, and the
 * panel rendered `delegation.defaults.toolGovernanc` for
 * `delegation.defaults.toolGovernance` with nothing to say it was short. An
 * unmarked cut presents a fragment as the whole value, so every cell, row, and
 * explanation line in this overlay carries the marker.
 */
/**
 * Scope tells the operator where an edit lands. Derived from the config-change
 * classification (src/core/settings-change-kind.ts): hotReload/nextTurn knobs can
 * apply to the live session immediately, so they offer "this session only" vs
 * "save as the global default". restartRequired knobs cannot apply live, so the
 * overlay only offers a global save that a restart picks up.
 */
type SettingScope = "live" | "restart";
const RESTART_REQUIRED_IDS = new Set<string>([
	"fleet.concurrency",
	"integrations.runtimePlugins",
	"interface.mode",
	"interface.fullscreenScrollbar",
	// The consult tool is registered once, at startup, with the engine chosen then.
	"systemOne.use",
]);

export const SETTINGS_SECTION_DESCRIPTIONS = Object.fromEntries(
	SETTINGS_SECTIONS.map((section) => [section.id, section.description]),
) as Record<SettingsSectionId, string>;

/**
 * Entry rows (one per fleet profile field, agent binding, target, fleet node)
 * are keyed by the config path they edit; SSH node rows also open management actions.
 */
export type EntrySettingId =
	| `setting.${string}`
	| `fleet.profiles.${string}`
	| `fleet.agentProfiles.${string}`
	| "systemOne.use"
	| `targets.${string}`
	| `fleet.nodes.${string}`
	| `fleet.endpoints.${string}`;
export type EditableSettingId = keyof typeof SETTINGS_LABELS_BY_ID | EntrySettingId;
export type GroupHeaderId = `settings.group.${string}`;
type TargetsCtaId = "targets.add-cta" | "targets.url-cta";
export type SettingsCenterRowId =
	| EditableSettingId
	| GroupHeaderId
	| TargetsCtaId
	| "maintenance.diagnostics"
	| "maintenance.editor";
export const REMOVE_PROFILE_CHOICE = "(remove profile)";
export const UNBIND_CHOICE = "(unbind)";
export const AUTO_PLACEMENT_CHOICE = "(auto placement)";
export const PROFILE_FIELD_SEPARATOR = " -> ";
export const PROFILE_SUMMARY_VALUE_BUDGET = 26;

export type SettingSubmenuBuilder = NonNullable<SettingItem["submenu"]>;
export type SettingsCenterLane = "sections" | "rows";
/**
 * Where the operator is in the Settings stack, independent of width. Narrow
 * terminals render one level at a time and wide ones render adjacent context,
 * but both share this state so Esc walks the same chain everywhere.
 */
export type SettingsNavigationDepth = "sections" | "rows" | "detail";

export type SettingsPresentationKind =
	| "setting"
	| "status"
	| "action"
	| "group-header"
	| "read-only-fact"
	| "destructive-action";

type SettingsValueTone = "neutral" | "healthy" | "degraded" | "unhealthy" | "unknown" | "activity";

export interface SettingsValueSegment {
	text: string;
	tone: SettingsValueTone;
}

export interface SettingsCenterItem extends SettingItem {
	id: SettingsCenterRowId;
	label: string;
	description: string;
	section: SettingsSectionId;
	configPath: string;
	affordance: string;
	scope: SettingScope;
	readOnly: boolean;
	presentationKind: SettingsPresentationKind;
	valueSegments: readonly SettingsValueSegment[];
	targetConsole?: {
		health: SettingsValueSegment;
		id: string;
		roles: string;
		runtime: string;
		latency: string;
		url: string;
		defaultModel: string;
		lastProbe: string;
		failureReason: string;
	};
	help?: string;
	valueHelp?: Record<string, string>;
	defaultValue?: string;
	/**
	 * What a free-text editor opens with when it differs from the rendered
	 * value. A row that renders its absence as prose such as `(session target)`
	 * must not hand that prose to the editor, or the operator's typing lands
	 * behind it and the placeholder is written into settings.yaml.
	 */
	editValue?: string;
}

export interface SettingsCenterSection {
	id: SettingsSectionId;
	label: string;
	items: SettingsCenterItem[];
}

export interface SettingsCenterSelection {
	lane: SettingsCenterLane;
	depth: SettingsNavigationDepth;
	section: SettingsSectionId;
	rowIndex: number;
	rowId: SettingsCenterRowId | null;
	submenuOpen: boolean;
	filter: string;
}

export interface BuildSettingItemsOptions {
	onFleetSettingsChanged?: (settings: PancodeSettings) => void;
	providers?: ProvidersContract;
	/**
	 * Live settings source for submenus. The static `settings` snapshot is
	 * captured when the overlay opens; submenus must read through this so
	 * changing target, then picking model lists models for the new target.
	 */
	getSettings?: () => Readonly<PancodeSettings>;
	/** Re-derive rows after an action that changes what they show without a commit (a health probe). */
	requestRefresh?: () => void;
	/** Live fleet node snapshots (scheduling.fleet.list()); absent hides the node rows. */
	getFleetNodes?: () => ReadonlyArray<FleetNodeSnapshot>;
	/** Live in-process dispatch breaker state per route; absent shows no breaker state. */
	getRouteBreakers?: () => ReadonlyArray<RouteBreakerView>;
	/** Run the API-key / OAuth connect flow for a target; absent hides the action. `replaceKey` asks for a new key first. */
	connectTarget?: (targetId: string, options?: { replaceKey?: boolean }) => Promise<void> | void;
	editTarget?: (targetId: string) => void;
	/** The connect/probe operation currently acting on a target, if any. */
	getTargetOperation?: (targetId: string) => "connect" | "probe" | null;
	/** Keeps the row grammar synchronized with the lifetime of connect/probe work. */
	onTargetOperationChange?: (targetId: string, operation: "connect" | "probe" | null, operationToken: object) => void;
	/** Detected agents not yet wired; absent or empty hides the add action on the delegation.agents row. */
	getInteropProposals?: () => ReadonlyArray<InteropProposal>;
}

export function sectionForSetting(id: EditableSettingId): SettingsSectionId {
	return settingsPlacementForRow(id, settingsPathForRow(id)).area;
}

export function cycleAffordance(): string {
	return "Enter to choose a value";
}

export function scopeForId(id: EditableSettingId): SettingScope {
	return RESTART_REQUIRED_IDS.has(id) ? "restart" : "live";
}

/** Shipped default as a display string, for the "default: X" hint and the modified marker. */
export function defaultValueFor(id: EditableSettingId): string | undefined {
	const path = settingsPathForRow(id);
	if (isRoutingPath(path)) return undefined;
	const raw = getAtPath(DEFAULT_SETTINGS, path);
	if (raw === null || raw === undefined || typeof raw === "object") return undefined;
	if (id === "integrations.git.commitAttribution") return raw === true ? "enabled" : "disabled";
	return String(raw);
}

export const SETTINGS_SECTION_ROWS = Object.fromEntries(
	SETTINGS_SECTIONS.map((section) => [
		section.id,
		(Object.keys(SETTINGS_LABELS_BY_ID) as EditableSettingId[]).filter((id) => sectionForSetting(id) === section.id),
	]),
) as unknown as Record<SettingsSectionId, readonly EditableSettingId[]>;

export const SITE_OFF_CHOICE = "(off)";
