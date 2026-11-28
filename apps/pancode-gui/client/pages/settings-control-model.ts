// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Wording and grouping for the settings write surface. Pure, so it is testable without a browser.

import type { SettingControl, SettingsControls } from "../../contracts/settings-controls.js";
import {
	STRUCTURED_SETTINGS,
	type StructuredField,
	type StructuredSettingEditor,
} from "../../contracts/structured-settings.js";

/** The engine's own three sentences (`controlInstructions`), so the terminal and the app say the same words. */
export const TIMING_SENTENCE: Record<SettingControl["timing"], string> = {
	hotReload: "A running session can apply this immediately.",
	nextTurn: "Used by the next relevant request, dispatch, or explicit open.",
	restartRequired: "Takes effect in the next session.",
};
const TIMING_LABEL: Record<SettingControl["timing"], string> = {
	hotReload: "Applies now",
	nextTurn: "Next request",
	restartRequired: "Next session",
};
/** The classification as a phrase that reads after "·", for the quiet line under a control. */
export const TIMING_PHRASE: Record<SettingControl["timing"], string> = {
	hotReload: "applies now",
	nextTurn: "applies on the next request",
	restartRequired: "applies in the next session",
};
const SOURCE: Record<SettingControl["source"], string> = {
	"built-in": "Default",
	user: "Your settings",
	project: "Project file",
	"project.local": "Local project file",
	cli: "Command line",
};
export const sourceLabel = (source: SettingControl["source"]) => SOURCE[source];

export function matchesControl(control: SettingControl, query: string): boolean {
	const needle = query.trim().toLocaleLowerCase("en-US");
	return (
		!needle ||
		[
			control.path,
			control.label,
			control.description,
			control.group,
			control.section,
			sourceLabel(control.source),
			TIMING_LABEL[control.timing],
			control.access,
			control.help ?? "",
		]
			.join(" ")
			.toLocaleLowerCase("en-US")
			.includes(needle)
	);
}

/**
 * A line under a group whose settings this page shows only in part. System One's
 * engines, sites and cuts are maps the controls cannot edit, so the decision
 * engine group says where they are set.
 */
export function groupNote(controls: ReadonlyArray<Pick<SettingControl, "path">>): string | null {
	if (!controls.some((control) => control.path.startsWith("systemOne."))) return null;
	return "Experimental. Engines are declared under systemOne in the settings file, and systemOne.use names the routes that answer the consult tool, in order. It applies on the next start.";
}

/** Groups in first-seen order, which is the engine's registry order. */
export function groupControls(controls: SettingControl[]): Array<{ group: string; controls: SettingControl[] }> {
	const groups = new Map<string, SettingControl[]>();
	for (const control of controls) groups.set(control.group, [...(groups.get(control.group) ?? []), control]);
	return [...groups].map(([group, rows]) => ({ group, controls: rows }));
}

/** What an empty value means for this control, in the operator's words. */
export function emptyMeaning(control: SettingControl): string {
	if (control.path === "context.memory.target") return "Same as chat";
	if (["chat.model", "fleet.default.model", "context.memory.model"].includes(control.path))
		return "Use connection default";
	if (control.kind === "list") return "None";
	if (control.kind === "json") return "Not set";
	return control.optional ? "Automatic" : "Not set";
}

/** The options of a select, or null when the control is free text. An optional select leads with its automatic choice. */
export function selectOptions(control: SettingControl): Array<{ value: string; label: string }> | null {
	if (control.kind === "boolean")
		return [
			{ value: "true", label: "On" },
			{ value: "false", label: "Off" },
		];
	const values = control.choices ?? (control.kind === "string" ? control.suggestions : undefined);
	if (!values) return null;
	const options = values.map((value) => ({ value, label: value }));
	// A saved value outside the known set stays selectable, so opening the page never rewrites it.
	if (control.value && !values.includes(control.value)) options.unshift({ value: control.value, label: control.value });
	return control.optional ? [{ value: "", label: emptyMeaning(control) }, ...options] : options;
}

/**
 * Controls whose value is one of a few words or an exact value only the operator knows. The engine
 * accepts these words (`src/core/settings-controls.ts`: `parseControlInput` for concurrency, the help
 * text for worktrees) but does not yet publish them as choices, so they are named here until it does.
 */
export interface OpenChoice {
	readonly words: readonly string[];
	/** The select's escape to an exact value, and the field it opens. */
	readonly other: { readonly label: string; readonly field: "whole-number" | "folder" };
}
export const OPEN_CHOICES: Readonly<Record<string, OpenChoice>> = {
	"fleet.concurrency": { words: ["auto"], other: { label: "A fixed number…", field: "whole-number" } },
	"fleet.worktrees.root": {
		words: ["auto", "disk", "tmpfs"],
		other: { label: "A folder you choose…", field: "folder" },
	},
};

/** Sentences for a completed write: the requested change first, then every side effect the engine applied. */
export function writtenSentences(
	changed: Array<{ path: string; value: string }>,
	controls: SettingControl[],
	requested: string,
): string[] {
	const label = (path: string) => controls.find((control) => control.path === path)?.label ?? path;
	if (!changed.length) return ["Nothing changed; the value was already in effect."];
	return changed.map(({ path, value }) =>
		path === requested
			? `Saved ${label(path)}.`
			: value
				? `This also set ${label(path)} to ${value}.`
				: `This also cleared ${label(path)}.`,
	);
}

/** The engine writes per-value help as fragments; the page shows them as sentences. */
export function sentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const capital = `${trimmed[0]?.toLocaleUpperCase("en-US")}${trimmed.slice(1)}`;
	return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * The calm pages of Settings. Each takes the runtime registry's own controls by section and group, so
 * nothing here is a setting of the app's own. Whatever no calm page claims is on the Advanced page.
 */
export type SettingsScopeId = "models" | "safety" | "context" | "advanced";

/**
 * The request scope of every settings read and write: the named workspace's layers, or with none open the
 * user layer alone, which is what each write changes either way.
 */
export function settingsScopeInput(workspaceId: string | null) {
	return { params: {}, query: workspaceId ? { workspace: workspaceId } : {}, body: {} };
}

/** The Models page: every control of the shared Models area, plus the default model delegated work uses. */
const MODEL_GROUPS: ReadonlySet<string> = new Set(["workers/Default worker"]);
const keyOf = (control: Pick<SettingControl, "section" | "group">) => `${control.section}/${control.group}`;

const CALM: Readonly<Record<Exclude<SettingsScopeId, "advanced">, (control: SettingControl) => boolean>> = {
	models: (control) => control.section === "models" || MODEL_GROUPS.has(keyOf(control)),
	safety: (control) => control.section === "safety",
	context: (control) => control.section === "context",
};

/** Whether a control belongs on a page. Advanced is everything the calm pages leave out. */
function inScope(scope: SettingsScopeId, control: SettingControl): boolean {
	if (scope !== "advanced") return CALM[scope](control);
	return !Object.values(CALM).some((claims) => claims(control));
}

export function settingsControlSelection(
	report: Pick<SettingsControls, "controls" | "sections"> | undefined,
	discovery: {
		scope: SettingsScopeId | undefined;
		filter: string;
		section: string | null;
		showDrafts: boolean;
		drafts: Readonly<Record<string, string>>;
		compact: boolean;
		selectedControl: string | null;
	},
) {
	const { scope, filter, section, showDrafts, drafts, compact, selectedControl } = discovery;
	const everything = report?.controls ?? [];
	const sections = report?.sections ?? [];
	const controls =
		scope && !(scope === "advanced" && filter.trim())
			? everything.filter((control) => inScope(scope, control))
			: everything;
	const unsaved = controls.filter(
		(control) => drafts[control.path] !== undefined && drafts[control.path] !== control.value,
	);
	const active =
		scope || showDrafts || filter.trim() || (compact && section === "all")
			? null
			: (sections.find((candidate) => candidate.id === section)?.id ?? sections[0]?.id ?? null);
	const visible = showDrafts
		? unsaved
		: controls.filter((control) => (active ? control.section === active : matchesControl(control, filter)));
	const current = sections.find((candidate) => candidate.id === active);
	const chosen = visible.find((control) => control.path === selectedControl) ?? visible[0];
	return { unsaved, active, visible, current, chosen, editorControls: compact && chosen ? [chosen] : visible };
}

/** Collection keys are trimmed on save, so validation compares the same normalized keys. */
export function invalidCollectionNames(names: readonly string[]): boolean {
	const normalized = names.map((name) => name.trim());
	return normalized.some((name, index) => !name || normalized.indexOf(name) !== index);
}

/** Drafts that now equal the saved value are done; the same object comes back when none are. */
export function withoutSavedDrafts(
	drafts: Readonly<Record<string, string>>,
	controls: ReadonlyArray<Pick<SettingControl, "path" | "value">>,
): Readonly<Record<string, string>> {
	const next = { ...drafts };
	let changed = false;
	for (const control of controls) {
		if (next[control.path] !== control.value) continue;
		delete next[control.path];
		changed = true;
	}
	return changed ? next : drafts;
}

/** One entry of a structured collection; `id` only keys the editor's rows and never reaches the saved value. */
export type StructuredRow = { id: string; name: string; values: Record<string, unknown>; members?: StructuredRow[] };

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The editor's rows for a saved collection; unreadable JSON opens as an empty collection. */
export function structuredRows(path: string, value: string, newId: () => string): StructuredRow[] {
	try {
		const editor = STRUCTURED_SETTINGS[path];
		if (!editor) return [];
		const data: unknown = JSON.parse(value);
		const row = (value: unknown, name = ""): StructuredRow => ({ id: newId(), name, values: record(value) });
		if (editor.kind === "list") return Array.isArray(data) ? data.map((item) => row(item)) : [];
		return Object.entries(record(data)).map(([name, item]) =>
			editor.kind === "values"
				? row({ value: item }, name)
				: editor.kind === "rosters"
					? {
							...row({}, name),
							members: Array.isArray(record(item).members)
								? (record(item).members as unknown[]).map((member) => row(member))
								: [],
						}
					: row(item, name),
		);
	} catch {
		return [];
	}
}

/** The collection as the setting saves it; empty fields are left out so the engine applies its defaults. */
export function structuredJson(kind: StructuredSettingEditor["kind"], rows: readonly StructuredRow[]): string {
	const clean = (values: Record<string, unknown>) =>
		Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== undefined));
	return JSON.stringify(
		kind === "list"
			? rows.map((row) => clean(row.values))
			: Object.fromEntries(
					rows.map((row) => [
						row.name.trim(),
						kind === "values"
							? (row.values.value ?? "")
							: kind === "rosters"
								? { members: row.members?.map((member) => clean(member.values)) ?? [] }
								: clean(row.values),
					]),
				),
	);
}

export const structuredFieldText = (raw: unknown): string =>
	Array.isArray(raw) ? raw.join(", ") : raw === undefined || raw === null ? "" : String(raw);

/** The runtime value a field's typed text stands for. */
export function structuredFieldValue(kind: StructuredField["kind"], input: string): unknown {
	if (kind === "number" && input !== "") return Number(input);
	if (kind === "list")
		return input
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
	return input;
}

/** The first `new-<entry>-N` name no entry uses yet. */
export function newEntryName(entryName: string, names: readonly string[]): string {
	const prefix = `new-${entryName.toLowerCase().replaceAll(" ", "-")}-`;
	let number = 1;
	while (names.includes(`${prefix}${number}`)) number++;
	return `${prefix}${number}`;
}

/** A review applies only to the draft and effective value actually shown to the user. */
export function settingReviewMatches(
	review: { draft: string; current: string } | null,
	draft: string,
	current: string,
) {
	return review !== null && review.draft === draft && review.current === current;
}
export function settingBaselineChanged(draft: string | null, original: string | undefined, current: string) {
	return draft !== null && original !== undefined && original !== current;
}

const figure = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 6 });

/** The range a number control accepts, in words: "of at least 4,096", "from 1 to 16", "above 0 and below 1". */
function rangeWords(control: SettingControl): string {
	const low =
		control.minimum !== undefined
			? { inclusive: true, value: control.minimum }
			: control.exclusiveMinimum !== undefined
				? { inclusive: false, value: control.exclusiveMinimum }
				: null;
	const high =
		control.maximum !== undefined
			? { inclusive: true, value: control.maximum }
			: control.exclusiveMaximum !== undefined
				? { inclusive: false, value: control.exclusiveMaximum }
				: null;
	if (low?.inclusive && high?.inclusive) return ` from ${figure(low.value)} to ${figure(high.value)}`;
	const parts = [
		low ? `${low.inclusive ? "at least" : "above"} ${figure(low.value)}` : null,
		high ? `${high.inclusive ? "at most" : "below"} ${figure(high.value)}` : null,
	].filter(Boolean);
	const words = parts.join(" and ");
	return !words ? "" : words.startsWith("at ") ? ` of ${words}` : ` ${words}`;
}

/**
 * Why a number draft would be refused, checked against the bounds the engine's validation enforces; null when the save
 * would accept it. An empty draft of an optional control clears it, so it is never an issue.
 */
export function numberDraftIssue(control: SettingControl, draft: string): string | null {
	if (control.kind !== "number") return null;
	const text = draft.trim();
	if (!text)
		return control.optional ? null : `Enter ${control.integer ? "a whole number" : "a number"}${rangeWords(control)}.`;
	const value = Number(text);
	const outside =
		!Number.isFinite(value) ||
		(control.integer && !Number.isInteger(value)) ||
		(control.minimum !== undefined && value < control.minimum) ||
		(control.exclusiveMinimum !== undefined && value <= control.exclusiveMinimum) ||
		(control.maximum !== undefined && value > control.maximum) ||
		(control.exclusiveMaximum !== undefined && value >= control.exclusiveMaximum);
	return outside ? `Enter ${control.integer ? "a whole number" : "a number"}${rangeWords(control)}.` : null;
}
