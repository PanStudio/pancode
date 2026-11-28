// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../../core/config.js";
import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { getAtPath } from "../../core/session-routing.js";
import type { SettingsAreaId as SettingsSectionId } from "../../core/settings-areas.js";
import { settingsPlacementForRow } from "../../core/settings-areas.js";
import { settingsChangeKind } from "../../core/settings-change-kind.js";
/** Row primitives the item builder composes: setting items, group headers, target calls to action, and the common controls. */
import type { SettingControl } from "../../core/settings-controls.js";
import {
	applyControlValue,
	controlInstructions,
	formatControlValue,
	settingsPathForRow,
} from "../../core/settings-controls.js";
import {
	SETTINGS_DESCRIPTIONS_BY_ID,
	SETTINGS_HELP_BY_ID,
	SETTINGS_LABELS_BY_ID,
	SETTINGS_VALUE_HELP_BY_ID,
} from "../../core/settings-copy.js";
import { SettingsValidationError } from "../../core/settings-issues.js";
import {
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	thinkingLevelDisplayWord,
} from "../../domains/providers/index.js";
import { settingsRuntimeFacts } from "../../domains/providers/settings-facts.js";
import type { Component } from "../../engine/tui.js";
import { Input } from "../../engine/tui.js";
import { TURN_CONTROL_WORKFLOWS } from "../../lib/turn-control/index.js";
import { GLYPH } from "../theme/index.js";
import {
	cycleAffordance,
	defaultValueFor,
	type EditableSettingId,
	type EntrySettingId,
	FALLBACK_THINKING_VALUES,
	type GroupHeaderId,
	type SettingSubmenuBuilder,
	type SettingsCenterItem,
	type SettingsPresentationKind,
	type SettingsValueSegment,
	scopeForId,
	sectionForSetting,
} from "./settings-center-model.js";
import { DRAFT_EDITOR_KEYS, joinNotes, keepDraftOnEscape, keptSettingDrafts } from "./settings-editors.js";
import { ChoiceList, SubmenuWrapper } from "./settings-submenus.js";

interface SettingItemOptions {
	values?: readonly string[];
	submenu?: SettingSubmenuBuilder;
	affordance?: string;
	readOnly?: boolean;
	presentationKind?: SettingsPresentationKind;
	valueSegments?: readonly SettingsValueSegment[];
	label?: string;
	description?: string;
	help?: string;
	editValue?: string;
}

function hasSettingMetadata(id: EditableSettingId): id is keyof typeof SETTINGS_LABELS_BY_ID {
	return Object.hasOwn(SETTINGS_LABELS_BY_ID, id);
}

export function settingItem(
	id: keyof typeof SETTINGS_LABELS_BY_ID,
	currentValue: string,
	options: SettingItemOptions,
): SettingsCenterItem;
export function settingItem(
	id: EntrySettingId,
	currentValue: string,
	options: SettingItemOptions & Pick<SettingsCenterItem, "label" | "description">,
): SettingsCenterItem;
export function settingItem(
	id: EditableSettingId,
	currentValue: string,
	options: SettingItemOptions,
): SettingsCenterItem {
	const catalogId = hasSettingMetadata(id) ? id : null;
	const item: SettingsCenterItem = {
		id,
		label: options.label ?? (catalogId === null ? id : SETTINGS_LABELS_BY_ID[catalogId]),
		currentValue,
		description: options.description ?? (catalogId === null ? "" : SETTINGS_DESCRIPTIONS_BY_ID[catalogId]),
		section: sectionForSetting(id),
		configPath: settingsPathForRow(id),
		affordance:
			options.affordance === "free text"
				? "Enter to edit"
				: options.affordance === "opens picker"
					? "Enter to choose"
					: options.affordance === "edit settings.yaml"
						? "Edit in the settings file"
						: (options.affordance ?? (options.values ? cycleAffordance() : "Enter to edit")),
		scope: scopeForId(id),
		readOnly: options.readOnly ?? false,
		presentationKind: options.presentationKind ?? (options.readOnly ? "read-only-fact" : "setting"),
		valueSegments: options.valueSegments ?? [{ text: currentValue, tone: "neutral" }],
	};
	const help = options.help ?? SETTINGS_HELP_BY_ID[id];
	if (help) item.help = help;
	if (options.editValue !== undefined) item.editValue = options.editValue;
	const valueHelp = SETTINGS_VALUE_HELP_BY_ID[id];
	if (valueHelp) item.valueHelp = valueHelp;
	const def = defaultValueFor(id);
	if (def !== undefined) item.defaultValue = def;
	if (options.values) item.values = [...options.values];
	if (options.submenu) item.submenu = options.submenu;
	return item;
}

/**
 * A heading row that names the block of settings under it. The id carries the
 * section it belongs to, so one builder serves every section that groups its
 * rows rather than a near-duplicate per section.
 */
export function groupHeader(
	id: GroupHeaderId,
	section: SettingsSectionId,
	label: string,
	description: string,
): SettingsCenterItem {
	return {
		id,
		label,
		currentValue: "",
		description,
		section,
		configPath: id,
		affordance: "group heading",
		scope: "live",
		readOnly: true,
		presentationKind: "group-header",
		valueSegments: [],
	};
}

export function targetAddCta(): SettingsCenterItem {
	return {
		id: "connections.add-cta",
		label: "Add a connection",
		currentValue: "Open connection wizard",
		description: "Add a connection without leaving the TUI. Review and save its runtime, credentials, URL and model.",
		section: "models",
		configPath: "connections.add-cta",
		affordance: "Enter: open connection wizard",
		scope: "live",
		readOnly: false,
		presentationKind: "action",
		valueSegments: [{ text: "Open connection wizard", tone: "neutral" }],
	};
}

export function targetUrlCta(): SettingsCenterItem {
	return {
		id: "connections.url-cta",
		label: "Connect by URL",
		currentValue: "Enter an endpoint URL",
		description:
			"Connect a model server or API by its URL: PanCode reads its model list, asks for a key only when the endpoint needs one, and uses the model you choose for chat.",
		section: "models",
		configPath: "connections.url-cta",
		affordance: "Enter: connect by URL",
		scope: "live",
		readOnly: false,
		presentationKind: "action",
		valueSegments: [{ text: "Enter an endpoint URL", tone: "neutral" }],
	};
}

const TURN_PREPARATION_LABELS: Readonly<Record<(typeof TURN_CONTROL_WORKFLOWS)[number], string>> = {
	"detached-collection": "Collect finished background runs",
};

const turnPreparationSubmenu: SettingSubmenuBuilder = (currentValue, done) => {
	const selected = new Set(currentValue.split(",").map((value) => value.trim()));
	let active: Component;
	const showChoices = (selectedIndex: number): void => {
		const choices = [
			...TURN_CONTROL_WORKFLOWS.map((workflow) => ({
				value: workflow as string,
				label: `${selected.has(workflow) ? GLYPH.ok : GLYPH.hollow} ${TURN_PREPARATION_LABELS[workflow]}`,
			})),
			{ value: "apply", label: "Apply these choices" },
		];
		const list = new ChoiceList(choices);
		list.setSelectedIndex(selectedIndex);
		list.onSelect = (choice) => {
			if (choice.value === "apply") {
				done(TURN_CONTROL_WORKFLOWS.filter((workflow) => selected.has(workflow)).join(", "));
				return;
			}
			if (selected.has(choice.value)) selected.delete(choice.value);
			else selected.add(choice.value);
			showChoices(choices.findIndex((entry) => entry.value === choice.value));
		};
		list.onCancel = () => done();
		active = new SubmenuWrapper(
			"Before PanCode answers",
			list,
			[{ key: "Enter", verb: "toggle or apply" }],
			"Choose which preparation PanCode may start before responding.",
		);
	};
	showChoices(0);
	return {
		render: (width: number) => active.render(width),
		handleInput: (data: string) => active.handleInput?.(data),
		invalidate: () => active.invalidate?.(),
	};
};

export function thinkingChoices(
	providers: ProvidersContract | undefined,
	target: string | null,
	model: string | null,
	level: PancodeSettings["chat"]["thinkingLevel"],
): { display: string; values: readonly string[] } {
	const resolved = providers
		? resolveModelRuntimeCapabilitiesForProviders(providers, target, model, level ?? "off")?.thinking
		: null;
	const display = resolved?.display ?? level ?? "off";
	const values = resolved
		? resolved.supportedLevels.map((entry) => thinkingLevelDisplayWord(resolved.mechanism, entry))
		: FALLBACK_THINKING_VALUES;
	return { display, values };
}

/**
 * Surface every configurable knob. Editable knobs carry values/submenus;
 * read-only pointer rows (maintenance and safety net) name the
 * surface that owns them so the Center has no dead-but-tappable rows.
 */
function controlTextSubmenu(control: SettingControl, live: () => Readonly<PancodeSettings>): SettingSubmenuBuilder {
	return (current, done) => {
		const input = new Input();
		input.focused = true;
		const restored = keepDraftOnEscape(`control:${control.path}`, input, current, done);
		const wrapper = new SubmenuWrapper(
			control.label,
			input,
			DRAFT_EDITOR_KEYS("review"),
			joinNotes(restored, controlInstructions(control, "settings")),
		);
		input.onSubmit = (value) => {
			try {
				applyControlValue(structuredClone(live()), control.path, value, settingsRuntimeFacts());
				keptSettingDrafts.delete(`control:${control.path}`);
				done(value);
			} catch (error) {
				wrapper.setProblem(valueProblem(error));
			}
		};
		return wrapper;
	};
}

/**
 * Why a typed value was refused, about the value. The validator checks a copy of
 * the whole file with the value in it, and its error is written for a broken
 * file: it named settings.yaml as failing validation and sent the operator to
 * fix keys in it and run doctor, when the file was untouched and only the
 * typed value was wrong.
 */
export function valueProblem(error: unknown): string {
	if (error instanceof SettingsValidationError && error.issues.length > 0) {
		const reasons = error.issues.map((issue) => plainValueReason(issue.message));
		return `Not accepted: ${reasons.join("; ")}. The setting is unchanged.`;
	}
	return error instanceof Error ? error.message : String(error);
}

/** The validator's `expected a number >= 0, got -3` in the operator's words: `it must be 0 or more, and -3 is not`. */
function plainValueReason(message: string): string {
	const bound = /^expected a number (>=|<=|>|<) (\S+), got (.+)$/u.exec(message);
	if (bound) {
		const [, op, limit, got] = bound;
		const words =
			op === ">="
				? `${limit} or more`
				: op === "<="
					? `${limit} or less`
					: op === ">"
						? `more than ${limit}`
						: `less than ${limit}`;
		return `it must be ${words}, and ${got} is not`;
	}
	const kind = /^expected a number, got (.+)$/u.exec(message);
	if (kind) return `it must be a number, and ${kind[1]} is not`;
	return message;
}

export function commonControlItem(control: SettingControl, live: () => Readonly<PancodeSettings>): SettingsCenterItem {
	const id = `setting.${control.path}` as const;
	return {
		id,
		label: control.label,
		description: control.description,
		...(control.help
			? { help: control.help }
			: control.kind === "json"
				? { help: "Edit this collection as JSON." }
				: control.kind === "number"
					? { help: "Enter a number. The change is checked before it is saved." }
					: {}),
		section: settingsPlacementForRow(id, control.path).area,
		configPath: control.path,
		currentValue: "",
		affordance: control.readOnly ? "Managed by its confirmation flow" : "Enter to edit",
		scope: settingsChangeKind(control.path) === "restartRequired" ? "restart" : "live",
		defaultValue: formatControlValue(getAtPath(DEFAULT_SETTINGS, control.path), control.path),
		readOnly: control.readOnly,
		presentationKind: "setting",
		valueSegments: [],
		...(control.path === "turnControl.workflows"
			? { submenu: turnPreparationSubmenu }
			: control.choices || control.kind === "boolean"
				? { values: [...(control.choices ?? ["true", "false"])] }
				: { submenu: controlTextSubmenu(control, live) }),
	};
}

export function maintenanceRows(): SettingsCenterItem[] {
	return [
		{
			id: "maintenance.diagnostics" as const,
			label: "Check setup",
			currentValue: "runs /doctor",
			description: "Close settings and run the doctor: version, directories, connections and settings problems.",
		},
		{
			id: "maintenance.editor" as const,
			label: "Edit settings file",
			currentValue: "opens $EDITOR",
			description:
				"Open your settings file or this project's in your editor. Every setting is there, including ones with no row here. The draft is checked before it is saved.",
		},
	].map((row) => ({
		...row,
		configPath: row.id,
		valueSegments: [],
		section: "advanced",
		affordance: "Enter to run",
		scope: "live",
		readOnly: false,
		presentationKind: "status",
	}));
}
