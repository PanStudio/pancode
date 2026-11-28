// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../../core/config.js";
import {
	bindAgentProfileInSettings,
	removeFleetProfileFromSettings,
	removeTargetFromSettings,
	setFleetProfileInSettings,
	useTargetInSettings,
} from "../../core/config.js";
import type { ActiveRoutingPosture, ActiveRoutingRole } from "../../core/defaults.js";
import { ACTIVE_ROUTING_POSTURES, ACTIVE_ROUTING_ROLES } from "../../core/defaults.js";
import { getAtPath, isRoutingPath } from "../../core/session-routing.js";
import { settingsChangeKind } from "../../core/settings-change-kind.js";
/** Applying a setting change to the settings draft, and the change plan with its propagation timing and confirm titles. */
import { applyControlValue, settingControl, settingsPathForRow } from "../../core/settings-controls.js";
import { SettingsValidationError } from "../../core/settings-issues.js";
import { validateSettings } from "../../core/settings-validate.js";
import { isRecord } from "../../core/type-guards.js";
import type { InteropAgentId } from "../../domains/interop/index.js";
import { delegationEntryForKind, interopAgentKind } from "../../domains/interop/index.js";
import { thinkingLevelFromChoiceLabel } from "../../domains/providers/index.js";
import { settingsRuntimeFacts } from "../../domains/providers/settings-facts.js";
import { visibleWidth } from "../../engine/tui.js";
import { GLYPH } from "../theme/index.js";
import {
	AUTO_PLACEMENT_CHOICE,
	type EditableSettingId,
	PROFILE_FIELD_SEPARATOR,
	REMOVE_PROFILE_CHOICE,
	type SettingsCenterItem,
	SHIPPED_ESCALATION,
	SITE_OFF_CHOICE,
	UNBIND_CHOICE,
} from "./settings-center-model.js";
import {
	DELEGATION_ADD_PREFIX,
	DELEGATION_REMOVE_PREFIX,
	parseEnumListSetting,
	parseScopedModelSelection,
} from "./settings-editors.js";
import { formatSettingsValue } from "./settings-presentation.js";

export function formatThreshold(value: number, fallback = "0.8"): string {
	return Number.isFinite(value) ? String(value) : fallback;
}

/**
 * Pure mutation applied in place for Settings Center editable rows.
 */
function applyDelegationAgentChange(settings: PancodeSettings, value: string): void {
	if (value.startsWith(DELEGATION_REMOVE_PREFIX)) {
		const id = value.slice(DELEGATION_REMOVE_PREFIX.length);
		settings.integrations.externalAgents.entries = settings.integrations.externalAgents.entries.filter(
			(agent) => agent.id !== id,
		);
		return;
	}
	if (!value.startsWith(DELEGATION_ADD_PREFIX)) return;
	const kind = interopAgentKind(value.slice(DELEGATION_ADD_PREFIX.length) as InteropAgentId);
	if (kind?.acp === undefined) return;
	const entry = delegationEntryForKind(kind, settings.integrations.externalAgents.defaults);
	if (settings.integrations.externalAgents.entries.some((agent) => agent.id === entry.id)) return;
	settings.integrations.externalAgents.entries.push(entry);
}

function applySettingChange(settings: PancodeSettings, id: string, value: string): void {
	if (
		id.startsWith("setting.") ||
		settingControl(settingsPathForRow(id))?.kind === "number" ||
		id === "fleet.concurrency" ||
		["chat.modelPicker.favorites", "interface.keybindings", "fleet.adaptiveRouting.agentRoles"].includes(id)
	) {
		applyControlValue(settings, settingsPathForRow(id), value, settingsRuntimeFacts());
		return;
	}
	if (applyEntrySettingChange(settings, id, value)) return;
	switch (id) {
		case "safety.autonomy":
			if (value === "default") settings.safety.autonomy = "default";
			else if (value === "yolo") settings.safety.autonomy = "yolo";
			return;
		case "fleet.permissions.mode":
			if (value === "deny" || value === "fail" || value === "escalate" || value === "main" || value === "judge")
				settings.fleet.permissions.mode = value;
			return;
		case "integrations.externalAgents.defaults.toolGovernance":
			if (value === "pancode-policy" || value === "agent-managed" || value === "deny-all")
				settings.integrations.externalAgents.defaults.toolGovernance = value;
			return;
		case "integrations.externalAgents.entries":
			applyDelegationAgentChange(settings, value);
			return;
		case "integrations.projectResources.trustProjectImports":
			if (value === "true" || value === "false")
				settings.integrations.projectResources.trustProjectImports = value === "true";
			return;
		case "integrations.git.commitAttribution":
			if (value === "enabled" || value === "disabled") settings.integrations.git.commitAttribution = value === "enabled";
			return;
		case "integrations.git.commitAuthor":
			if (value === "auto" || value === "human") settings.integrations.git.commitAuthor = value;
			return;
		case "chat.thinkingLevel":
			settings.chat.thinkingLevel = thinkingLevelFromChoiceLabel(value) ?? settings.chat.thinkingLevel;
			return;
		case "context.memory.enabled":
			if (value === "true" || value === "false") settings.context.memory.enabled = value === "true";
			return;
		case "fleet.default.thinkingLevel":
			settings.fleet.default.thinkingLevel = thinkingLevelFromChoiceLabel(value) ?? settings.fleet.default.thinkingLevel;
			return;
		case "fleet.staggerSharedPrefix":
			if (value === "true" || value === "false") settings.fleet.staggerSharedPrefix = value === "true";
			return;
		case "interface.panes.notifications":
			if (value === "failures" || value === "all" || value === "off") settings.interface.panes.notifications = value;
			return;
		case "interface.panes.layout":
			if (value === "off" || value === "workers" || value === "cockpit") settings.interface.panes.layout = value;
			return;
		case "fleet.history.journal":
			if (value === "true" || value === "false") settings.fleet.history.journal = value === "true";
			return;
		case "interface.panes.files.enabled":
			if (value === "true" || value === "false") settings.interface.panes.files.enabled = value === "true";
			return;
		case "interface.panes.files.mode":
			if (value === "companion" || value === "chooser") settings.interface.panes.files.mode = value;
			return;
		case "interface.panes.files.profile":
			if (value === "managed" || value === "user") settings.interface.panes.files.profile = value;
			return;
		case "interface.panes.files.followCwd":
			if (value === "true" || value === "false") settings.interface.panes.files.followCwd = value === "true";
			return;
		case "context.compaction.auto":
			if (value === "true" || value === "false") settings.context.compaction.auto = value === "true";
			return;
		case "context.compaction.model": {
			const trimmed = value.trim();
			if (trimmed) settings.context.compaction.model = trimmed;
			else delete settings.context.compaction.model;
			return;
		}
		case "context.compaction.systemPrompt": {
			const trimmed = value.trim();
			if (trimmed) settings.context.compaction.systemPrompt = trimmed;
			else delete settings.context.compaction.systemPrompt;
			return;
		}
		case "chat.retry.enabled":
			if (value === "true" || value === "false") settings.chat.retry.enabled = value === "true";
			return;
		case "interface.terminalProgress":
			if (value === "true" || value === "false") settings.interface.terminalProgress = value === "true";
			return;
		case "interface.outputDetail":
			if (value === "compact" || value === "standard" || value === "detailed") settings.interface.outputDetail = value;
			return;
		case "interface.mode":
			if (value === "regular" || value === "fullscreen") settings.interface.mode = value;
			return;
		case "interface.fullscreenScrollbar":
			if (value === "hidden" || value === "auto" || value === "always") {
				settings.interface.fullscreenScrollbar = value;
			}
			return;
		case "interface.desktopNotifications":
			if (value === "true" || value === "false") settings.interface.desktopNotifications = value === "true";
			return;
		case "safety.review.enabled":
			if (value === "true" || value === "false") settings.safety.review.enabled = value === "true";
			return;
		// The watchdog target is absent by default, and an empty submission is
		// how the operator says "go back to the default" from a text row. Deleting
		// the key rather than storing a blank keeps settings.yaml matching what the
		// config validator accepts.
		case "safety.review.target": {
			const trimmed = value.trim();
			if (trimmed) settings.safety.review.target = trimmed;
			else delete settings.safety.review.target;
			return;
		}
		case "interface.smoothStreaming":
			if (value === "off" || value === "auto" || value === "on") settings.interface.smoothStreaming = value;
			return;
		case "integrations.runtimePlugins":
			settings.integrations.runtimePlugins = value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
			return;
		case "chat.target": {
			const target = value === "(unset)" || value === "" ? null : value;
			// Switching targets re-bases the model on the new target default.
			if (target !== settings.chat.target) {
				settings.chat.model = target ? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null) : null;
			}
			settings.chat.target = target;
			return;
		}
		case "chat.model":
			settings.chat.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "context.memory.target": {
			const target = value.startsWith("(unset") || value === "" ? null : value;
			if (target !== settings.context.memory.target) {
				settings.context.memory.model = target
					? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null)
					: null;
			}
			settings.context.memory.target = target;
			return;
		}
		case "context.memory.model":
			settings.context.memory.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "fleet.default.target": {
			const target = value === "(unset)" || value === "" ? null : value;
			if (target !== settings.fleet.default.target) {
				settings.fleet.default.model = target
					? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null)
					: null;
			}
			settings.fleet.default.target = target;
			return;
		}
		case "fleet.default.model":
			settings.fleet.default.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "chat.modelPicker.cycleSet":
			settings.chat.modelPicker.cycleSet =
				parseScopedModelSelection(value) ??
				value
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
			return;
		case "fleet.permissions.escalation.fallback": {
			if (value !== "deny" && value !== "fail") return;
			settings.fleet.permissions.escalation = {
				...(settings.fleet.permissions.escalation ?? SHIPPED_ESCALATION),
				fallback: value,
			};
			return;
		}
		case "fleet.adaptiveRouting.roles": {
			const outcome = parseEnumListSetting(value, ACTIVE_ROUTING_ROLES);
			if ("values" in outcome) settings.fleet.adaptiveRouting.roles = outcome.values as ActiveRoutingRole[];
			return;
		}
		case "fleet.adaptiveRouting.postures": {
			const outcome = parseEnumListSetting(value, ACTIVE_ROUTING_POSTURES);
			if ("values" in outcome) settings.fleet.adaptiveRouting.postures = outcome.values as ActiveRoutingPosture[];
			return;
		}
		case "chat.prewarm":
			if (value === "true" || value === "false") settings.chat.prewarm = value === "true";
			return;
		case "context.workingSet.enabled":
			if (value === "true" || value === "false") settings.context.workingSet.enabled = value === "true";
			return;
		case "context.workingSet.policy":
			if (value === "structural-v1" || value === "structural-v2" || value === "age-horizon")
				settings.context.workingSet.policy = value;
			return;
		case "context.workingSet.profile":
			if (value === "default" || value === "data-analysis" || value === "web-design")
				settings.context.workingSet.profile = value;
			return;
		case "integrations.hub.catalog":
		case "integrations.hub.remote": {
			const key = id.slice("integrations.hub.".length) as "catalog" | "remote";
			const trimmed = value.trim();
			settings.integrations.hub[key] = trimmed.length > 0 ? trimmed : null;
			return;
		}
		case "integrations.hub.sync":
			if (value === "true" || value === "false") settings.integrations.hub.sync = value === "true";
			return;
	}
}

/** Per-entry rows route to the same mutations the `pancode targets` CLI applies. */
function applyEntrySettingChange(settings: PancodeSettings, id: string, value: string): boolean {
	if (id === "fleet.profiles" || id === "fleet.agentProfiles") {
		// `name -> target` / `agent -> profile`: the encoding the chained add pickers produce.
		const [head = "", tail = ""] = value.split(" -> ").map((part) => part.trim());
		if (!head || !tail) return true;
		if (id === "fleet.profiles") setFleetProfileInSettings(settings, head, tail);
		else bindAgentProfileInSettings(settings, head, tail);
		return true;
	}
	if (id.startsWith("fleet.profiles.")) {
		const encoded = value.split(PROFILE_FIELD_SEPARATOR);
		const name = id.slice("fleet.profiles.".length);
		const field = encoded.shift();
		const fieldValue = encoded.join(PROFILE_FIELD_SEPARATOR);
		const profile = settings.fleet.profiles[name];
		if (!profile) return true;
		if (value === REMOVE_PROFILE_CHOICE) {
			removeFleetProfileFromSettings(settings, name);
		} else if (field === "target") {
			if (fieldValue !== profile.target) setFleetProfileInSettings(settings, name, fieldValue);
		} else if (field === "model") {
			profile.model = fieldValue === "(unset)" || fieldValue === "" ? null : fieldValue;
		} else if (field === "thinkingLevel") {
			profile.thinkingLevel = thinkingLevelFromChoiceLabel(fieldValue) ?? profile.thinkingLevel;
		} else if (field === "node") {
			if (fieldValue === AUTO_PLACEMENT_CHOICE || fieldValue === "") delete profile.node;
			else profile.node = fieldValue;
		}
		return true;
	}
	if (id === "systemOne.use") {
		settings.systemOne.use = value === SITE_OFF_CHOICE || value === "" ? null : value;
		return true;
	}
	if (id.startsWith("fleet.agentProfiles.")) {
		const agentId = id.slice("fleet.agentProfiles.".length);
		if (value === UNBIND_CHOICE) delete settings.fleet.agentProfiles[agentId];
		else bindAgentProfileInSettings(settings, agentId, value);
		return true;
	}
	if (id.startsWith("targets.")) {
		const targetId = id.slice("targets.".length);
		if (value === "use") useTargetInSettings(settings, targetId);
		else if (value === "remove") removeTargetFromSettings(settings, targetId);
		return true;
	}
	return false;
}

/**
 * The scoped commit persists one dotted leaf per call and an entry action can
 * touch several (`use` moves chat and fleet routing; removing a profile drops
 * its bindings), so diff the blobs. Profile objects and arrays are leaves.
 */
function changedLeafPaths(before: Readonly<PancodeSettings>, after: Readonly<PancodeSettings>): string[] {
	const out: string[] = [];
	const visit = (a: unknown, b: unknown, path: string): void => {
		if (a === b) return;
		const profileLeaf = path.startsWith("fleet.profiles.") && path.split(".").length === 3;
		// These editable JSON maps contain user keys, including dots; commit the collection atomically.
		const collectionLeaf = path === "interface.keybindings" || path === "fleet.rosters";
		if (!isRecord(a) || !isRecord(b) || profileLeaf || collectionLeaf) {
			if (JSON.stringify(a) !== JSON.stringify(b)) out.push(path);
			return;
		}
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
			visit(a[key], b[key], path ? `${path}.${key}` : key);
		}
	};
	visit(before, after, "");
	return out;
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer U)[]
		? readonly DeepReadonly<U>[]
		: T extends object
			? { readonly [K in keyof T]: DeepReadonly<T[K]> }
			: T;

export type SettingsPropagationTiming = "now" | "next-request" | "next-dispatch" | "next-session";

export interface SettingsChangePlan {
	readonly rowId: EditableSettingId;
	readonly label: string;
	readonly originalValue: string;
	readonly selectedValue: string;
	readonly original: DeepReadonly<PancodeSettings>;
	readonly proposed: DeepReadonly<PancodeSettings>;
	readonly leaves: readonly {
		readonly path: string;
		readonly before: unknown;
		readonly after: unknown;
	}[];
	readonly propagation: readonly {
		readonly path: string;
		readonly timing: SettingsPropagationTiming;
	}[];
	readonly impact: string;
	readonly sessionCapable: boolean;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value as DeepReadonly<T>;
}

function propagationTiming(
	id: string,
	selectedValue: string,
	path: string,
	restartRequired: boolean,
): SettingsPropagationTiming {
	if (restartRequired) return "next-session";
	if (id.startsWith("targets.")) {
		if (selectedValue === "remove") return "next-dispatch";
		return path.startsWith("chat.") ? "now" : "next-dispatch";
	}
	if (path.startsWith("fleet.")) return "next-dispatch";
	if (settingsChangeKind(path) === "nextTurn" && !isRoutingPath(path)) return "next-request";
	return "now";
}

function impactFor(propagation: SettingsChangePlan["propagation"]): string {
	const timings = new Set(propagation.map((entry) => entry.timing));
	if (timings.has("next-request")) return "takes effect on the next relevant request or explicit open";
	if (timings.has("now") && timings.has("next-dispatch"))
		return "takes effect for chat now and fleet routing at the next dispatch";
	if (timings.has("next-session")) return "takes effect next session";
	if (timings.has("next-dispatch")) return "takes effect at the next dispatch";
	return "takes effect now";
}

export function createSettingsChangePlan(
	settings: Readonly<PancodeSettings>,
	item: Pick<SettingsCenterItem, "id" | "label" | "currentValue" | "scope">,
	selectedValue: string,
	sessionDestinationAvailable = true,
): SettingsChangePlan | null {
	const rowId = item.id as EditableSettingId;
	const original = structuredClone(settings);
	const proposed = structuredClone(original);
	applySettingChange(proposed, rowId, selectedValue);
	const validation = validateSettings(proposed);
	if (validation.issues.length) throw new SettingsValidationError(validation.issues);
	const paths = changedLeafPaths(original, proposed);
	if (paths.length === 0) return null;
	const restartRequired = item.scope === "restart";
	const sessionCapable = !restartRequired && sessionDestinationAvailable;
	const leaves = paths.map((path) => ({
		path,
		before: getAtPath(original, path),
		after: getAtPath(proposed, path),
	}));
	const propagation = paths.map((path) => ({
		path,
		timing: propagationTiming(rowId, selectedValue, path, restartRequired),
	}));
	return deepFreeze({
		rowId,
		label: item.label,
		originalValue: item.currentValue,
		selectedValue,
		original,
		proposed,
		leaves,
		propagation,
		impact: impactFor(propagation),
		sessionCapable,
	});
}

/**
 * A selection of several model references is a set, not a destination.
 * Spelling it out produced `…-coder-model, node-b/example-…`, a left-chopped ref dump
 * with the row label pushed off the front, so a multi-reference selection is
 * summarized by count and the note beneath the title carries the leaves.
 */
function scopedSelectionSummary(plan: SettingsChangePlan): string | null {
	if (plan.rowId !== "chat.modelPicker.cycleSet") return null;
	const refs = parseScopedModelSelection(plan.selectedValue);
	return refs && refs.length >= 2 ? `${refs.length} changes` : null;
}

/** Keep the destination—the value the operator is about to commit—visible as confirmation titles narrow. */
export function formatScopeConfirmTitle(plan: SettingsChangePlan, width: number): string {
	const summary = scopedSelectionSummary(plan);
	if (summary !== null) {
		const title = `${plan.label}: ${summary}`;
		return visibleWidth(title) <= width ? title : ellipsizeFromLeft(title, width);
	}
	const selectedValue = humanizeChangePlanValue(plan);
	const originalValue = formatSettingsValue(settingsPathForRow(plan.rowId), plan.originalValue);
	const full = plan.originalValue.trim()
		? `${plan.label}: ${originalValue} ${GLYPH.next} ${selectedValue}`
		: `${plan.label}: ${selectedValue}`;
	if (visibleWidth(full) <= width) return full;
	const destinationFirst = plan.originalValue.trim()
		? `${plan.label}: ${GLYPH.next} ${selectedValue}`
		: `${plan.label}: ${selectedValue}`;
	if (visibleWidth(destinationFirst) <= width) return destinationFirst;
	return ellipsizeFromLeft(destinationFirst, width);
}

function humanizeChangePlanValue(plan: SettingsChangePlan): string {
	if (plan.rowId === "chat.modelPicker.cycleSet") {
		const summary = scopedSelectionSummary(plan);
		if (summary !== null) return summary;
		const refs = parseScopedModelSelection(plan.selectedValue);
		if (refs) return refs.length > 0 ? refs.join(", ") : "(empty)";
	}
	const separatorIndex = plan.selectedValue.indexOf(PROFILE_FIELD_SEPARATOR);
	if (separatorIndex < 0) return formatSettingsValue(settingsPathForRow(plan.rowId), plan.selectedValue);
	const head = plan.selectedValue.slice(0, separatorIndex).trim();
	const tail = plan.selectedValue.slice(separatorIndex + PROFILE_FIELD_SEPARATOR.length).trim();
	if (plan.rowId === "fleet.profiles" || plan.rowId === "fleet.agentProfiles") return `${head} ${GLYPH.next} ${tail}`;
	if (!plan.rowId.startsWith("fleet.profiles.")) return plan.selectedValue;
	const label =
		head === "thinkingLevel" ? "thinking" : head === "node" ? "placement" : head === "target" ? "target" : "model";
	return `${label} ${GLYPH.next} ${tail}`;
}

export function truncateProfileFact(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(text) <= safeWidth) return text;
	if (safeWidth <= visibleWidth(GLYPH.ellipsis)) return GLYPH.ellipsis.slice(0, safeWidth);
	const characters: string[] = [];
	let used = 0;
	const contentWidth = safeWidth - visibleWidth(GLYPH.ellipsis);
	for (const character of Array.from(text)) {
		const characterWidth = visibleWidth(character);
		if (used + characterWidth > contentWidth) break;
		characters.push(character);
		used += characterWidth;
	}
	return `${characters.join("")}${GLYPH.ellipsis}`;
}

function ellipsizeFromLeft(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(text) <= safeWidth) return text;
	if (safeWidth <= visibleWidth(GLYPH.ellipsis)) return GLYPH.ellipsis.slice(0, safeWidth);
	const suffixWidth = safeWidth - visibleWidth(GLYPH.ellipsis);
	const suffix: string[] = [];
	let used = 0;
	for (const character of Array.from(text).reverse()) {
		const characterWidth = visibleWidth(character);
		if (used + characterWidth > suffixWidth) break;
		suffix.unshift(character);
		used += characterWidth;
	}
	return `${GLYPH.ellipsis}${suffix.join("")}`;
}
