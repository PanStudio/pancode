// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The editors a setting row opens: text, target, model, enum-list and scoped-model submenus, draft keeping, and target actions. */
import type { PancodeSettings } from "../../core/config.js";
import type { InteropProposal } from "../../domains/interop/index.js";
import {
	type CapabilityFlags,
	isOrchestratorEligibleRuntime,
	isTargetEligibleRuntime,
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	type TargetStatus,
	targetRequiresAuth,
} from "../../domains/providers/index.js";
import type { Component } from "../../engine/tui.js";
import { getKeybindings, Input, matchesKey, wrapTextWithAnsi } from "../../engine/tui.js";
import { clockLocal } from "../format-time.js";
import { localKey } from "../keyboard-owner.js";
import { centeredWindow, type HintEntry, type RowBudgetedBody } from "../overlay-frame.js";
import { closeWithEllipsis, emptyState, GLYPH, pancodeTheme, sectionRule, selectionRow } from "../theme/index.js";
import { modelsForTarget } from "./model-selector-model.js";
import type {
	BuildSettingItemsOptions,
	SettingSubmenuBuilder,
	SettingsPresentationKind,
} from "./settings-center-model.js";
import { type ChoiceItem, ChoiceList, SubmenuWrapper } from "./settings-submenus.js";

export const DELEGATION_ADD_PREFIX = "add ";
export const DELEGATION_REMOVE_PREFIX = "remove ";

/**
 * The delegation.agents row is read-only until interop has something to offer.
 * Adding writes the same entry `configure --interop` would, and removing names
 * the `/delegate` id that stops resolving, which is the only user-visible
 * consequence a change plan cannot show from a settings diff.
 */
export function delegationAgentsAffordance(
	agents: ReadonlyArray<{ id: string }>,
	proposals: ReadonlyArray<InteropProposal>,
): { affordance: string; readOnly?: boolean; submenu?: SettingSubmenuBuilder } {
	const choices = [
		...proposals.map((proposal) => ({
			value: `${DELEGATION_ADD_PREFIX}${proposal.kind}`,
			label: `Add detected agent ${proposal.entry.id} (${[proposal.entry.command, ...proposal.entry.args].join(" ")})`,
			presentationKind: "action" as const,
		})),
		...agents.map((agent) => ({
			value: `${DELEGATION_REMOVE_PREFIX}${agent.id}`,
			label: `Remove ${agent.id}; /run ${agent.id} stops resolving`,
			presentationKind: "destructive-action" as const,
		})),
	];
	if (choices.length === 0) return { affordance: "edit settings.yaml", readOnly: true };
	return {
		affordance: "opens picker",
		submenu: selectListSubmenu(
			"Delegation agents",
			choices,
			"An added peer runs under pancode-policy governance and inherits projectContext: none.",
		),
	};
}

/**
 * Text typed into a setting's editor and left with Esc, by editor, with the
 * value it was typed against. Esc returns to the list without applying, and
 * the next visit to the same editor offers the text again as long as the
 * saved value has not moved underneath it.
 */
export const keptSettingDrafts = new Map<string, { base: string; text: string }>();

/**
 * Fill an editor from its kept draft or its saved value, and wire Esc to keep
 * what was typed. Returns the sentence that says a draft came back, for the
 * editor's note, or undefined when the field shows the saved value.
 */
export function keepDraftOnEscape(
	key: string,
	input: Input,
	currentValue: string,
	done: (val?: string) => void,
): string | undefined {
	const kept = keptSettingDrafts.get(key);
	const restored = kept !== undefined && kept.base === currentValue && kept.text !== currentValue;
	input.setValue(restored ? kept.text : currentValue);
	input.handleInput("\x1b[F");
	input.onEscape = () => {
		const text = input.getValue();
		if (text !== currentValue && text.trim().length > 0) keptSettingDrafts.set(key, { base: currentValue, text });
		else keptSettingDrafts.delete(key);
		done();
	};
	return restored
		? `This is the text you left with Esc, not yet applied; the saved value is ${currentValue.length > 0 ? `"${currentValue}"` : "empty"}.`
		: undefined;
}

export function joinNotes(...notes: Array<string | undefined>): string | undefined {
	const present = notes.filter((note): note is string => note !== undefined && note.length > 0);
	return present.length > 0 ? present.join(" ") : undefined;
}

export const DRAFT_EDITOR_KEYS = (verb: string): HintEntry[] => [{ key: "Enter", verb }];

export function textInputSubmenu(title: string, note?: string): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const input = new Input();
		input.focused = true;
		const restored = keepDraftOnEscape(`text:${title}`, input, currentValue, done);
		input.onSubmit = (val) => {
			keptSettingDrafts.delete(`text:${title}`);
			done(val);
		};
		return new SubmenuWrapper(title, input, DRAFT_EDITOR_KEYS("confirm"), joinNotes(restored, note));
	};
}

export function selectTargetSubmenu(providers: ProvidersContract): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const statuses = providers.list();
		if (statuses.length === 0) {
			return textInputSubmenu("Type connection id")(currentValue, done);
		}
		const items = statuses.map((status) => ({
			value: status.target.id,
			label: `${status.target.id} (${status.target.url ?? "no url"})`,
		}));
		return selectListSubmenu("Select connection", items)(currentValue, done);
	};
}

export function selectOptionalBackgroundTargetSubmenu(providers: ProvidersContract): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const statuses = providers.list();
		const items = [
			{ value: "(unset)", label: "Chat route (no memory model set)" },
			...statuses.map((status) => ({
				value: status.target.id,
				label: `${status.target.id} (${status.target.url ?? "no url"})`,
			})),
		];
		const note =
			"Unset uses the active chat route because no memory model is set. Turn proactive memory off to disable it.";
		return selectListSubmenu("Select memory connection", items, note)(currentValue, done);
	};
}

export function selectModelSubmenu(
	providers: ProvidersContract,
	getActiveTarget: () => string | undefined,
): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const targetId = getActiveTarget();
		const status = providers.list().find((s) => s.target.id === targetId);
		const models = status ? modelsForTarget(status) : [];
		if (models.length === 0) {
			return textInputSubmenu(
				"Model override",
				"Leave blank to use the connection default; a typed model id is unverified.",
			)(currentValue, done);
		}
		const items = [
			{ value: "(unset)", label: "Use connection default" },
			...models.map((model) => ({ value: model, label: model })),
		];
		return selectListSubmenu(`Select model for ${targetId}`, items)(currentValue, done);
	};
}

export function editTextSubmenu(title: string, note?: string): SettingSubmenuBuilder {
	return textInputSubmenu(title, note);
}

/**
 * The comma-separated set an activation list holds, refused in place when an
 * entry is not one of the legal values. Silently dropping the unknown entry
 * would leave the operator looking at a list they thought they had activated,
 * so the editor stays open and names both the entry and the vocabulary.
 */
export function parseEnumListSetting(
	value: string,
	legal: readonly string[],
): { values: string[] } | { refusal: string } {
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const unknown = entries.find((entry) => !legal.includes(entry));
	if (unknown !== undefined) {
		return { refusal: `Not applied: '${unknown}' is not one of ${legal.join(", ")}.` };
	}
	const duplicate = entries.find((entry, index) => entries.indexOf(entry) !== index);
	if (duplicate !== undefined) return { refusal: `Not applied: '${duplicate}' is listed twice.` };
	return { values: entries };
}

export function editEnumListSubmenu(title: string, legal: readonly string[]): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const input = new Input();
		input.focused = true;
		const restored = keepDraftOnEscape(`list:${title}`, input, currentValue, done);
		const wrapper = new SubmenuWrapper(
			title,
			input,
			DRAFT_EDITOR_KEYS("confirm"),
			joinNotes(restored, `Comma-separated, from ${legal.join(", ")}; blank activates none.`),
		);
		input.onSubmit = (val) => {
			const outcome = parseEnumListSetting(val, legal);
			if ("refusal" in outcome) {
				wrapper.setProblem(outcome.refusal);
				return;
			}
			wrapper.setProblem(null);
			keptSettingDrafts.delete(`list:${title}`);
			done(outcome.values.join(", "));
		};
		return wrapper;
	};
}

export function selectListSubmenu(
	title: string,
	items: ReadonlyArray<{
		value: string;
		label: string;
		presentationKind?: SettingsPresentationKind;
	}>,
	note?: string,
): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const theme = pancodeTheme();
		const presented: ChoiceItem[] = items.map((item) => ({
			value: item.value,
			label:
				item.presentationKind === "destructive-action"
					? theme.fg("error", `${GLYPH.error} ${item.label}`)
					: item.presentationKind === "action"
						? `${GLYPH.active} ${item.label}`
						: item.label,
			...(item.value === currentValue ? { mark: theme.fg("selectedOption", GLYPH.ok) } : {}),
		}));
		const list = new ChoiceList(presented);
		const currentIndex = items.findIndex((item) => item.value === currentValue);
		if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return new SubmenuWrapper(title, list, undefined, note);
	};
}

interface ScopedModelChecklistEntry {
	kind: "entry";
	key: string;
	ref: string;
	label: string;
	detail: string;
	available: boolean;
}

interface ScopedModelChecklistGroup {
	kind: "group";
	label: string;
}

type ScopedModelChecklistRow = ScopedModelChecklistEntry | ScopedModelChecklistGroup;
const SCOPED_MODEL_SELECTION_PREFIX = "__pancode_scope_v1__:";

function serializeScopedModelSelection(refs: readonly string[]): string {
	return `${SCOPED_MODEL_SELECTION_PREFIX}${JSON.stringify(refs)}`;
}

export function parseScopedModelSelection(value: string): string[] | null {
	if (!value.startsWith(SCOPED_MODEL_SELECTION_PREFIX)) return null;
	try {
		const parsed: unknown = JSON.parse(value.slice(SCOPED_MODEL_SELECTION_PREFIX.length));
		return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null;
	} catch {
		return null;
	}
}

function compactCapabilityCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "unknown";
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return String(Math.round(value));
}

function scopedModelCapabilityDetail(caps: CapabilityFlags, thinking?: string): string {
	const enabled = [
		caps.chat ? "chat" : null,
		caps.tools ? "tools" : null,
		caps.reasoning ? "reasoning" : null,
		caps.vision ? "vision" : null,
		caps.audio ? "audio" : null,
		caps.embeddings ? "embeddings" : null,
		caps.rerank ? "rerank" : null,
		caps.fim ? "fim" : null,
	].filter((value): value is string => value !== null);
	return `Capabilities: ${enabled.length > 0 ? enabled.join(", ") : "none reported"} ${GLYPH.sep} context ${compactCapabilityCount(caps.contextWindow)} ${GLYPH.sep} max output ${compactCapabilityCount(caps.maxTokens)}${thinking ? ` ${GLYPH.sep} thinking ${thinking}` : ""}`;
}

function scopedModelEntryDetail(providers: ProvidersContract, status: TargetStatus, model: string | null): string {
	if (!model) {
		return `${scopedModelCapabilityDetail(status.capabilities)} ${GLYPH.sep} connection-level scope uses this connection's default model when switching connections`;
	}
	const resolved = resolveModelRuntimeCapabilitiesForProviders(providers, status.target.id, model);
	return resolved
		? scopedModelCapabilityDetail(resolved.capabilities, resolved.thinking.display)
		: `${scopedModelCapabilityDetail(status.capabilities)} ${GLYPH.sep} model details unresolved`;
}

function buildScopedModelChecklistRows(
	selectedRefs: readonly string[],
	providers: ProvidersContract | undefined,
): { rows: ScopedModelChecklistRow[]; availableRefs: ReadonlySet<string> } {
	const rows: ScopedModelChecklistRow[] = [];
	const availableRefs = new Set<string>();
	if (providers) {
		for (const status of providers.list()) {
			const targetRef = status.target.id;
			rows.push({ kind: "group", label: `Connection ${GLYPH.sep} ${targetRef}` });
			availableRefs.add(targetRef);
			rows.push({
				kind: "entry",
				key: `available:${targetRef}`,
				ref: targetRef,
				label: `${targetRef} (all models)`,
				detail: scopedModelEntryDetail(providers, status, null),
				available: true,
			});
			for (const model of modelsForTarget(status)) {
				const ref = `${targetRef}/${model}`;
				if (availableRefs.has(ref)) continue;
				availableRefs.add(ref);
				rows.push({
					kind: "entry",
					key: `available:${ref}`,
					ref,
					label: ref,
					detail: scopedModelEntryDetail(providers, status, model),
					available: true,
				});
			}
		}
	}
	const unavailable = [...new Set(selectedRefs.filter((ref) => !availableRefs.has(ref.trim())))];
	if (unavailable.length > 0) {
		rows.push({ kind: "group", label: "Unavailable" });
		for (const ref of unavailable) {
			rows.push({
				kind: "entry",
				key: `unavailable:${ref}`,
				ref,
				label: ref,
				detail:
					"Not present in the current provider catalog. It remains selected and will be preserved unchanged unless you uncheck it.",
				available: false,
			});
		}
	}
	if (rows.length === 0) rows.push({ kind: "group", label: "No configured connections or scoped references" });
	return { rows, availableRefs };
}

class ScopedModelChecklist implements Component, RowBudgetedBody {
	private readonly rows: ScopedModelChecklistRow[];
	private readonly availableRefs: ReadonlySet<string>;
	private readonly selectedKeys = new Set<string>();
	private selectedRow = 0;
	private bodyRows = 0;

	constructor(
		private readonly originalRefs: readonly string[],
		providers: ProvidersContract | undefined,
		private readonly done: (value?: string) => void,
	) {
		const built = buildScopedModelChecklistRows(originalRefs, providers);
		this.rows = built.rows;
		this.availableRefs = built.availableRefs;
		for (const ref of originalRefs) {
			const trimmed = ref.trim();
			this.selectedKeys.add(this.availableRefs.has(trimmed) ? `available:${trimmed}` : `unavailable:${ref}`);
		}
		this.selectedRow = this.nextEntryIndex(0, 1);
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		const theme = pancodeTheme();
		const safe = Math.max(1, width);
		if (!this.rows.some((row) => row.kind === "entry")) {
			return emptyState(theme, "No models are available to select.", safe);
		}
		const selected = this.rows[this.selectedRow];
		// The focused entry's capability sentence sits under the list, three rows
		// at most; a sentence that stops at "context 131" reads as the whole fact,
		// so the line that survives the cut says it is not.
		const detail: string[] = [];
		if (selected?.kind === "entry") {
			const text = selected.available ? selected.detail : `Unavailable ${GLYPH.sep} ${selected.detail}`;
			const wrapped = wrapTextWithAnsi(theme.fg("annotation", text), safe);
			const kept = wrapped.slice(0, 3);
			const last = kept.at(-1);
			detail.push(
				"",
				...(wrapped.length > kept.length && last !== undefined
					? [...kept.slice(0, -1), closeWithEllipsis(last, safe)]
					: kept),
			);
		}
		const visibleRows = Math.max(1, Math.min(this.bodyRows > 0 ? this.bodyRows - detail.length : 10, this.rows.length));
		const [start, end] = centeredWindow(this.rows.length, this.selectedRow, visibleRows);
		const lines = this.rows.slice(start, end).flatMap((row, offset) => {
			if (row.kind === "group") return [sectionRule(theme, safe, row.label)];
			const focused = start + offset === this.selectedRow;
			const checked = this.selectedKeys.has(row.key);
			const box = theme.fg(checked ? "selectedOption" : "annotation", checked ? "[x]" : "[ ]");
			const name = focused
				? theme.style("selectedOption", row.label, { bold: true, bg: "selectionBackground" })
				: theme.fg("menuOption", row.label);
			return selectionRow(theme, { focused, label: `${box} ${name}`, width: safe });
		});
		return [...lines, ...detail];
	}

	handleInput(data: string): void {
		data = localKey(data);
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selectedRow = this.nextEntryIndex(this.selectedRow - 1, -1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selectedRow = this.nextEntryIndex(this.selectedRow + 1, 1);
			return;
		}
		if (data === " ") {
			const row = this.rows[this.selectedRow];
			if (row?.kind !== "entry") return;
			if (this.selectedKeys.has(row.key)) this.selectedKeys.delete(row.key);
			else this.selectedKeys.add(row.key);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
			this.done(serializeScopedModelSelection(this.selectedRefs()));
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) this.done();
	}

	invalidate(): void {}

	private nextEntryIndex(from: number, direction: -1 | 1): number {
		if (!this.rows.some((row) => row.kind === "entry")) return 0;
		let index = from;
		for (let attempts = 0; attempts < this.rows.length; attempts += 1) {
			if (index < 0) index = this.rows.length - 1;
			if (index >= this.rows.length) index = 0;
			if (this.rows[index]?.kind === "entry") return index;
			index += direction;
		}
		return 0;
	}

	private selectedRefs(): string[] {
		const preserved = this.originalRefs.filter((ref) => {
			const trimmed = ref.trim();
			const key = this.availableRefs.has(trimmed) ? `available:${trimmed}` : `unavailable:${ref}`;
			return this.selectedKeys.has(key);
		});
		const selectedOriginalRefs = new Set(this.originalRefs.map((ref) => ref.trim()));
		const additions = this.rows
			.filter((row): row is ScopedModelChecklistEntry => row.kind === "entry" && row.available)
			.filter((row) => this.selectedKeys.has(row.key) && !selectedOriginalRefs.has(row.ref))
			.map((row) => row.ref);
		return [...preserved, ...additions];
	}
}

export function scopedModelsSubmenu(
	selectedRefs: readonly string[],
	providers: ProvidersContract | undefined,
): SettingSubmenuBuilder {
	return (_currentValue, done) =>
		new SubmenuWrapper(
			"Choose the model cycle set",
			new ScopedModelChecklist(selectedRefs, providers, done),
			[
				{ key: "Space", verb: "toggle" },
				{ key: "Enter", verb: "continue" },
			],
			"Connection entries cycle by connection, using its default model when switching connections. Model entries pin one exact connection/model reference.",
		);
}

/** One printable character with no modifier: what a person typing a word sends, and no key encoding is. */
export const TYPED_CHARACTER = /^[^\p{Cc}\s]$/u;

/** Two pickers in sequence joined into one committed value; Esc at either step cancels. */
export function chainSubmenus(
	first: SettingSubmenuBuilder,
	second: (firstValue: string) => SettingSubmenuBuilder,
	join: (first: string, second: string) => string,
): SettingSubmenuBuilder {
	return (_currentValue: string, done: (val?: string) => void) => {
		let active: Component = first("", (head) => {
			const trimmed = head?.trim() ?? "";
			if (!trimmed) return done();
			active = second(trimmed)("", (tail) => done(tail?.trim() ? join(trimmed, tail.trim()) : undefined));
		});
		return {
			render: (width: number) => active.render(width),
			handleInput: (data: string) => active.handleInput?.(data),
			invalidate: () => active.invalidate?.(),
		};
	};
}

/** Dispatch-eligible targets for a fleet profile; every configured target when no provider domain is wired. */
export function profileTargetChoices(
	live: () => Readonly<PancodeSettings>,
	providers: ProvidersContract | undefined,
): Array<{ value: string; label: string }> {
	if (!providers)
		return live().targets.map((target) => ({
			value: target.id,
			label: target.id,
		}));
	return providers
		.list()
		.filter((status) => status.runtime !== null && isTargetEligibleRuntime(status.runtime))
		.map((status) => ({
			value: status.target.id,
			label: `${status.target.id} (${status.target.url ?? "no url"})`,
		}));
}

export function profileNameChoices(live: () => Readonly<PancodeSettings>): Array<{ value: string; label: string }> {
	const names = Object.keys(live().fleet.profiles).sort();
	return names.map((name) => ({ value: name, label: name }));
}

/**
 * Per-target actions. Probe and connect are not settings changes: they run,
 * then the rows refresh; only use/remove commit.
 */
export function targetActionsSubmenu(
	targetId: string,
	options: BuildSettingItemsOptions | undefined,
): SettingSubmenuBuilder {
	const providers = options?.providers;
	const requestRefresh = options?.requestRefresh;
	const connectTarget = options?.connectTarget;
	return (currentValue: string, done: (val?: string) => void) => {
		const status = providers?.list().find((entry) => entry.target.id === targetId);
		const target = status?.target ?? options?.getSettings?.().targets.find((entry) => entry.id === targetId);
		const runtime = status?.runtime ?? null;
		const chatEligible = !providers || (runtime !== null && isOrchestratorEligibleRuntime(runtime));
		// A key PanCode stored can always be replaced from this menu. Once the target refused it, Connect itself asks for the new one.
		const storedKey =
			target !== undefined &&
			runtime !== null &&
			runtime.auth === "api-key" &&
			targetRequiresAuth(target, runtime) &&
			providers?.auth?.statusForTarget?.(target, runtime).source === "stored-api-key";
		const keyRefused = storedKey && status?.health.credentialRefused === true;
		const items = [
			...(chatEligible
				? [
						{
							value: "use",
							label: "Use for chat and fleet dispatch",
							presentationKind: "action" as const,
						},
					]
				: []),
			...(connectTarget
				? [
						{
							value: "connect",
							label: keyRefused
								? "Connect with a new API key (the stored key was refused), then probe"
								: storedKey
									? "Connect with the stored API key, then probe"
									: "Connect (API key or OAuth), then probe",
							presentationKind: "action" as const,
						},
						...(storedKey && !keyRefused
							? [
									{
										value: "replace-key",
										label: "Replace the stored API key, then probe",
										presentationKind: "action" as const,
									},
								]
							: []),
					]
				: []),
			...(providers
				? [
						{
							value: "probe",
							label: "Probe health now",
							presentationKind: "action" as const,
						},
					]
				: []),
			...(options?.editTarget
				? [{ value: "edit", label: "Edit URL, runtime and default model", presentationKind: "action" as const }]
				: []),
			{
				value: "remove",
				label: "Remove connection",
				presentationKind: "destructive-action" as const,
			},
		];
		const details = `URL: ${target?.url ?? "(none)"} ${GLYPH.sep} Default model: ${target?.defaultModel ?? "(none)"} ${GLYPH.sep} Last probe: ${status?.health.lastCheckAt ? clockLocal(status.health.lastCheckAt) : "never"} ${(() => {
			const reason = status?.health.lastError ?? (!status?.available && status?.reason ? status.reason : null);
			return reason === null ? "" : ` ${GLYPH.sep} Failure reason: ${reason}`;
		})()}`;
		const note = chatEligible ? details : `Not chat-eligible: its runtime is not HTTP/native. ${GLYPH.sep} ${details}`;
		return selectListSubmenu(
			`Connection ${targetId}`,
			items,
			note,
		)(currentValue, (value) => {
			const refresh = (): void => requestRefresh?.();
			if (value === "edit") {
				done();
				options?.editTarget?.(targetId);
				return;
			}
			if ((value === "connect" || value === "replace-key") && connectTarget) {
				done();
				const operationToken = {};
				options?.onTargetOperationChange?.(targetId, "connect", operationToken);
				refresh();
				const settle = (): void => {
					options?.onTargetOperationChange?.(targetId, null, operationToken);
					refresh();
				};
				try {
					const connecting =
						value === "replace-key" ? connectTarget(targetId, { replaceKey: true }) : connectTarget(targetId);
					void Promise.resolve(connecting).then(settle, settle);
				} catch {
					settle();
				}
				return;
			}
			if (value !== "probe" || !providers) return done(value);
			done();
			const operationToken = {};
			options?.onTargetOperationChange?.(targetId, "probe", operationToken);
			refresh();
			const settle = (): void => {
				options?.onTargetOperationChange?.(targetId, null, operationToken);
				refresh();
			};
			try {
				void Promise.resolve(providers.probeTarget(targetId)).then(settle, settle);
			} catch {
				settle();
			}
		});
	};
}
