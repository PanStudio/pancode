// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { PancodeSettings } from "./config.js";
import { semanticUsable } from "./config.js";
import {
	DEFAULT_SETTINGS,
	MEMORY_DELIVERY_MODES,
	MEMORY_LESSONS_MODES,
	STORE_BACKEND_KINDS,
	THINKING_LEVELS,
	WORKER_PERMISSION_MODES,
} from "./defaults.js";
import { redactedUpstreamProxy } from "./sandbox/egress/policy.js";
import { getAtPath, setAtPath } from "./session-routing.js";
import {
	SETTINGS_AREA_GROUPS,
	type SettingsAreaId,
	settingsAreaForPath,
	settingsPlacementForPath,
	settingsPlacementForRow,
} from "./settings-areas.js";
import { settingsChangeKind } from "./settings-change-kind.js";
import {
	EXTRA_HELP,
	SETTINGS_DESCRIPTIONS_BY_ID,
	SETTINGS_HELP_BY_ID,
	SETTINGS_LABELS_BY_ID,
	SETTINGS_VALUE_HELP_BY_ID,
} from "./settings-copy.js";
import { SettingsValidationError } from "./settings-issues.js";
import { validateSettings } from "./settings-validate.js";

/**
 * The runtime facts a settings edit is checked against. Providers owns the runtime registry, so each editor passes
 * `settingsRuntimeFacts()` from domains/providers/settings-facts.ts.
 */
export interface SettingsRuntimeFacts {
	/** True when the runtime, registered or built in, is a local native runtime. */
	localNative(runtimeId: string): boolean;
	/** True when the runtime is registered and can only serve worker dispatch, not chat or memory. */
	workerOnly(runtimeId: string): boolean;
}

/** Accepted settings can still be inactive on the configured route (#432). */
export function settingInactiveNote(
	path: string,
	settings: Readonly<PancodeSettings>,
	facts: SettingsRuntimeFacts,
): string | null {
	if (
		path === "context.semantic.enabled" &&
		settings.context.semantic.enabled &&
		!semanticUsable(settings.context.semantic)
	)
		return "Inactive until target, model and assetIdentity are pinned with pancode semantic configure.";
	if (path === "chat.prewarm" && settings.chat.prewarm) {
		const target = settings.targets.find((entry) => entry.id === settings.chat.target);
		const localNative = target ? facts.localNative(target.runtime) : false;
		if (!localNative && !(target?.runtime === "litellm" && target.cache?.deployment))
			return "Inactive on this chat route; prompt pre-warm requires a local native runtime or a declared LiteLLM cache deployment.";
	}
	return null;
}

/**
 * The settings path a Settings Center row edits. A guided row's id is its path; a raw row is `setting.<path>`, so it
 * never collides with the guided row for the same collection.
 */
export function settingsPathForRow(id: string): string {
	return id.startsWith("setting.") ? id.slice("setting.".length) : id;
}

export interface SettingControl {
	path: string;
	label: string;
	description: string;
	help?: string | undefined;
	choices?: readonly string[] | undefined;
	kind: "boolean" | "number" | "string" | "list" | "json";
	optional: boolean;
	readOnly: boolean;
	/** Has a `/settings` row (hand-written or generated). A leaf without it lives only in the file. */
	menu?: true;
}

/**
 * Leaves that earn a generated `/settings` row. Every other leaf without a
 * hand-written row stays valid in settings.yaml, `config inspect` and
 * `configure`, and is reached through "Edit settings file".
 */
const MENU_ROWS = new Set([
	"fleet.defaultNode",
	"fleet.default.node",
	"turnControl.hooks",
	"chat.cacheKeepalive",
	"chat.loopsUntilStopped",
	"chat.steering.triage.enabled",
	"fleet.worktrees.root",
	"context.memory.surfaces.observe",
	"context.memory.surfaces.delivery",
	"context.memory.surfaces.lessons",
	"context.memory.surfaces.correct",
	"context.memory.surfaces.bank",
	"context.memory.sideShare",
	"context.memory.surfaces.history",
	"context.memory.thinkingLevel",
	"context.semantic.enabled",
	"context.semantic.target",
	"context.semantic.model",
	"context.semantic.background",
	"safety.limits.workerResponseTimeoutMs",
	"safety.limits.autonomousToolCalls",
	"safety.limits.autonomousMinutes",
	"safety.limits.autonomousTokens",
	"safety.limits.bashIdleTimeoutMs",
	"fleet.limits.runTimeoutMs",
	"safety.sandbox",
	"safety.egress.main.mode",
	"safety.egress.workers.mode",
	"safety.scratchRoots",
	"safety.sandboxCacheMaxGiB",
	"safety.homeReads.main",
	"safety.homeReads.workers",
	"safety.snapshots",
	"safety.unattendedAfterMs",
	"safety.yoloConfinement",
	"safety.judge.enabled",
	"safety.judge.target",
	"safety.judge.model",
	"interface.exitSummary",
	"interface.demo",
	"interface.autoUpdate",
	"telemetry.mode",
	"report.offers",
	"prompts.profile",
	"systemOne.use",
]);

/** Hand-written rows that left the menu; their leaves stay valid in the file. */
export const OFF_MENU_HAND_ROWS: ReadonlySet<string> = new Set([
	"interface.keybindings",
	"fleet.adaptiveRouting.agentRoles",
	"context.memory.trajectorySteps",
	"context.memory.maxOutputTokens",
	"context.memory.timeoutMs",
	"context.workingSet.policy",
	"context.workingSet.protectLastSteps",
	"context.workingSet.minEvictableTokens",
	"context.workingSet.rearmFraction",
	"fleet.retry.routeCooldownMs",
	"chat.modelPicker.favorites",
	"integrations.hub.confirmedRemote",
]);

const CHOICES: Record<string, readonly string[]> = {
	"integrations.git.commitAuthor": ["auto", "human"],
	"interface.exitSummary": ["on", "off"],
	"telemetry.mode": ["standard", "research"],
	"report.offers": ["ask", "off"],
	"prompts.profile": ["v1", "v2"],
	"safety.autonomy": ["default", "yolo"],
	"safety.yoloConfinement": ["contained", "unconfined"],
	"safety.sandbox": ["auto", "required", "off"],
	"safety.egress.main.mode": ["proxied", "off", "open"],
	"safety.egress.workers.mode": ["off", "proxied", "open"],
	"safety.sandboxUnixSockets": ["block", "owned", "allow"],
	"safety.workerIsolation": ["children", "process"],
	"safety.homeReads.main": ["open", "listed"],
	"safety.homeReads.workers": ["open", "listed"],
	"safety.snapshots": ["auto", "off"],
	"chat.thinkingLevel": THINKING_LEVELS,
	"fleet.default.thinkingLevel": THINKING_LEVELS,
	"chat.steering.triage.thinkingLevel": THINKING_LEVELS,
	"context.memory.thinkingLevel": THINKING_LEVELS,
	"context.memory.surfaces.observe": ["off", "on"],
	"context.memory.surfaces.delivery": MEMORY_DELIVERY_MODES,
	"context.memory.surfaces.lessons": MEMORY_LESSONS_MODES,
	"context.memory.surfaces.correct": ["rules", "model"],
	"context.memory.surfaces.bank": ["rules", "model"],
	"context.memory.surfaces.history": ["off", "on"],
	"fleet.permissions.mode": WORKER_PERMISSION_MODES,
	"fleet.permissions.escalation.fallback": ["deny", "fail"],
	"interface.mode": ["regular", "fullscreen"],
	"interface.outputDetail": ["compact", "standard", "detailed"],
	"interface.fullscreenScrollbar": ["hidden", "auto", "always"],
	"interface.smoothStreaming": ["off", "auto", "on"],
	"interface.panes.layout": ["off", "workers", "cockpit"],
	"interface.panes.notifications": ["failures", "all", "off"],
	"interface.panes.files.mode": ["companion", "chooser"],
	"interface.panes.files.profile": ["managed", "user"],
	"context.compaction.provider": ["off", "native"],
	"context.workingSet.policy": ["structural-v1", "structural-v2", "age-horizon"],
	"context.workingSet.profile": ["default", "data-analysis", "web-design"],
	"integrations.externalAgents.defaults.toolGovernance": ["pancode-policy", "agent-managed", "deny-all"],
	"store.backend": [...STORE_BACKEND_KINDS],
};
const STRUCTURED = new Set([
	"funding",
	"models",
	"context.semantic.inboxes",
	"fleet.profiles",
	"fleet.rosters",
	"fleet.agentProfiles",
	"fleet.nodes",
	"fleet.adaptiveRouting.agentRoles",
	"store.shared",
	"store.s3",
	"store.roots",
	"store.placement.byTag",
	"store.placement.byClass",
	"interface.keybindings",
	"integrations.externalAgents.entries",
]);
const OPTIONAL_NUMBERS = new Set(["safety.review.cadenceToolCalls"]);
const NULLABLE_NUMBERS = new Set<string>([
	"safety.limits.templateToolCallsPerTurnMax",
	"safety.limits.templateObservationBytesPerTurnMax",
	"safety.resources.main.memoryMiB",
	"safety.resources.main.tasks",
	"safety.resources.main.cpuPercent",
	"safety.resources.workers.memoryMiB",
	"safety.resources.workers.tasks",
	"safety.resources.workers.cpuPercent",
]);
const OPTIONAL_STRINGS = new Set([
	"fleet.default.node",
	"safety.review.target",
	"context.compaction.model",
	"context.compaction.systemPrompt",
	"store.projectId",
]);

function collectControlPaths(value: unknown, prefix = ""): string[] {
	if (prefix && (STRUCTURED.has(prefix) || value === null || typeof value !== "object" || Array.isArray(value)))
		return [prefix];
	return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
		collectControlPaths(child, prefix ? `${prefix}.${key}` : key),
	);
}

/** The shared UI catalog uses the existing settings schema; it creates no new persisted keys. */
export const SETTING_CONTROLS: readonly SettingControl[] = (() => {
	const metadata = new Map(
		Object.keys(SETTINGS_LABELS_BY_ID).map((id) => [settingsPathForRow(id), id as keyof typeof SETTINGS_LABELS_BY_ID]),
	);
	const paths = new Set([...collectControlPaths(DEFAULT_SETTINGS), ...OPTIONAL_NUMBERS, ...OPTIONAL_STRINGS]);
	return [...paths]
		.filter((path) => path !== "version" && path !== "targets")
		.map((path) => {
			const id = metadata.get(path);
			const raw = getAtPath(DEFAULT_SETTINGS, path);
			const extra = EXTRA_HELP[path];
			const kind: SettingControl["kind"] = STRUCTURED.has(path)
				? "json"
				: Array.isArray(raw)
					? "list"
					: OPTIONAL_NUMBERS.has(path) || NULLABLE_NUMBERS.has(path) || typeof raw === "number"
						? "number"
						: typeof raw === "boolean"
							? "boolean"
							: "string";
			return {
				path,
				label: extra?.[0] ?? (id ? SETTINGS_LABELS_BY_ID[id] : path),
				description:
					extra?.[1] ??
					(id
						? SETTINGS_DESCRIPTIONS_BY_ID[id]
						: `Configure ${path}. Changes are validated against PanCode's settings schema.`),
				help: id ? SETTINGS_HELP_BY_ID[id] : undefined,
				choices: CHOICES[path],
				kind,
				optional: raw === null || OPTIONAL_STRINGS.has(path) || OPTIONAL_NUMBERS.has(path),
				readOnly: path === "integrations.hub.confirmedRemote",
				...(MENU_ROWS.has(path) || (id !== undefined && !OFF_MENU_HAND_ROWS.has(path)) ? { menu: true as const } : {}),
			};
		});
})();

/** One area's complete control catalog, in its group order and then catalog order, as configure and the GUI list it. */
export function orderedAreaControls(area: SettingsAreaId): Array<{ group: string; control: SettingControl }> {
	return orderSettingsEntries(
		area,
		SETTING_CONTROLS.filter((control) => settingsAreaForPath(control.path) === area),
		(control) => control.path,
	).map((control) => ({ group: settingsPlacementForPath(control.path).group, control }));
}

/**
 * Interactive counterpart of `orderSettingsEntries`: rows are ordered by their
 * area's group sequence, then by the control catalog, so guided actions and live
 * entries (profiles, agent routes) stay beside the controls they represent.
 */
export function orderAreaEntries<T>(
	area: SettingsAreaId,
	entries: readonly T[],
	rowFor: (entry: T) => { id: string; path: string },
): T[] {
	const groups = SETTINGS_AREA_GROUPS[area];
	controlIndex ??= firstIndexByPath(SETTING_CONTROLS.map((control) => control.path));
	const catalog = controlIndex;
	return sortByRank(entries, (entry) => {
		const { id, path } = rowFor(entry);
		const group = groups.indexOf(settingsPlacementForRow(id, path).group);
		return [group < 0 ? groups.length : group, catalogRank(catalog, path, SETTING_CONTROLS.length)];
	});
}

/** Guided actions and live collection entries, keyed by setting path, stay beside the controls they represent. */
export function orderSettingsEntries<T>(
	area: SettingsAreaId,
	entries: readonly T[],
	pathFor: (entry: T) => string,
): T[] {
	const groups = SETTINGS_AREA_GROUPS[area];
	controlIndex ??= firstIndexByPath(SETTING_CONTROLS.map((control) => control.path));
	const catalog = controlIndex;
	return sortByRank(entries, (entry) => {
		const path = pathFor(entry);
		const group = path ? groups.indexOf(settingsPlacementForPath(path).group) : -1;
		return [group < 0 ? groups.length : group, catalogRank(catalog, path, SETTING_CONTROLS.length)];
	});
}

let controlIndex: ReadonlyMap<string, number> | undefined;

function firstIndexByPath(paths: readonly string[]): Map<string, number> {
	const index = new Map<string, number>();
	paths.forEach((path, at) => {
		if (!index.has(path)) index.set(path, at);
	});
	return index;
}

/** The first catalog control at the path or at any dotted ancestor of it; `missing` when none is listed. */
function catalogRank(index: ReadonlyMap<string, number>, path: string, missing: number): number {
	let rank = missing;
	for (let end = path.length; end > 0; end = path.lastIndexOf(".", end - 1)) {
		const at = index.get(path.slice(0, end));
		if (at !== undefined && at < rank) rank = at;
	}
	return rank;
}

/** A stable sort that ranks each entry once; a comparator that ranks per comparison cost /settings a frame. */
function sortByRank<T>(entries: readonly T[], rank: (entry: T) => readonly [number, number]): T[] {
	return entries
		.map((entry) => ({ entry, rank: rank(entry) }))
		.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])
		.map(({ entry }) => entry);
}

export function settingControl(path: string): SettingControl | undefined {
	return SETTING_CONTROLS.find((control) => control.path === path);
}

export const REDACTED_PROXY_PATH = "safety.egress.upstreamProxy";

/** True when a setting value carries credentials that no display or prefill may show. */
export function hasRedactedControlCredentials(path: string, value: unknown): boolean {
	if (path !== REDACTED_PROXY_PATH || typeof value !== "string") return false;
	return redactedUpstreamProxy(value) !== value;
}

export function formatControlValue(value: unknown, path?: string): string {
	if (path === REDACTED_PROXY_PATH && typeof value === "string") return redactedUpstreamProxy(value);
	return value === undefined || value === null
		? "(automatic)"
		: typeof value === "object"
			? JSON.stringify(value)
			: String(value);
}

function parseControlValue(control: SettingControl, text: string): unknown {
	const input = text.trim();
	if (control.readOnly)
		throw new Error("This value is recorded by its dedicated confirmation flow; it cannot be edited here.");
	if (!input && control.optional)
		return OPTIONAL_STRINGS.has(control.path) || OPTIONAL_NUMBERS.has(control.path) ? undefined : null;
	if (control.choices && !control.choices.includes(input))
		throw new Error(`Choose one of: ${control.choices.join(", ")}.`);
	if (control.kind === "boolean") {
		if (input !== "true" && input !== "false") throw new Error("Choose true or false.");
		return input === "true";
	}
	if (control.kind === "number") {
		const value = input ? Number(input) : Number.NaN;
		if (!Number.isFinite(value)) throw new Error("Enter a finite number.");
		return value;
	}
	if (control.path === "fleet.concurrency") {
		if (input === "auto") return "auto";
		const value = Number(input);
		if (!Number.isSafeInteger(value) || value < 1) throw new Error("Use auto or a positive whole number.");
		return value;
	}
	if (control.kind === "json") return JSON.parse(input);
	if (control.kind === "list")
		return input
			? input
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean)
			: [];
	return text;
}

/** Validate the whole proposed configuration so cross-field constraints are honored by both editors. */
export function applyControlValue(
	settings: PancodeSettings,
	path: string,
	text: string,
	facts: SettingsRuntimeFacts,
): void {
	const control = settingControl(path);
	if (!control) throw new Error(`Unknown settings control: ${path}`);
	const candidate = structuredClone(settings);
	const value = parseControlValue(control, text);
	setAtPath(candidate, path, value);
	// Startup tolerates stale references. An editor must reject a typo rather than silently discard it.
	const routeRoots = ["chat", "fleet.default", "context.memory"];
	const routeRoot = routeRoots.find((root) => path === `${root}.target`);
	if (routeRoot) {
		if (value !== null && !candidate.targets.some((target) => target.id === value))
			throw new Error("Choose an existing connection id from Connections.");
		const target = candidate.targets.find((target) => target.id === value);
		if (routeRoot !== "fleet.default" && target && facts.workerOnly(target.runtime))
			throw new Error("Chat and memory need an HTTP/native connection; this connection is for workers only.");
		if (getAtPath(settings, path) !== value) setAtPath(candidate, `${routeRoot}.model`, null);
	}
	for (const root of routeRoots) {
		if (path === `${root}.model` && value && !getAtPath(candidate, `${root}.target`))
			throw new Error("Choose a connection for this role before setting a model override.");
	}
	if (
		path === "fleet.default.node" &&
		value !== undefined &&
		value !== "local" &&
		!candidate.fleet.nodes.some((node) => node.id === value)
	)
		throw new Error("Use local, a configured remote node id, or clear the field for automatic placement.");
	if (path === "fleet.profiles") {
		for (const [name, profile] of Object.entries(candidate.fleet.profiles ?? {})) {
			if (!candidate.targets.some((target) => target.id === profile?.target))
				throw new Error(`Profile ${name} must name an existing connection.`);
		}
	}
	if (path === "fleet.profiles" || path === "fleet.agentProfiles") {
		for (const [agent, profile] of Object.entries(candidate.fleet.agentProfiles ?? {})) {
			if (!Object.hasOwn(candidate.fleet.profiles, profile))
				throw new Error(`Agent ${agent} names missing profile ${profile}; remove or change its assignment first.`);
		}
	}
	const result = validateSettings(candidate);
	if (result.issues.length) throw new SettingsValidationError(result.issues);
	if (
		path === "chat.modelPicker.favorites" &&
		JSON.stringify(value) !== JSON.stringify(result.settings.chat.modelPicker.favorites)
	)
		throw new Error("Use target-id/model-id favorites from an existing connection.");
	setAtPath(settings, path, getAtPath(candidate, path));
	if (routeRoot) setAtPath(settings, `${routeRoot}.model`, getAtPath(candidate, `${routeRoot}.model`));
}

export function controlInstructions(control: SettingControl, surface: "configure" | "settings" = "configure"): string {
	const fractional =
		control.path === "context.compaction.threshold" ||
		control.path === "context.workingSet.target" ||
		control.path === "context.workingSet.rearmFraction" ||
		control.path.endsWith(".ratio");
	let entry = "";
	if (control.kind === "json") entry = "Enter JSON for this collection.";
	else if (control.kind === "list") entry = "Enter comma-separated values; clear the field for an empty list.";
	else if (control.path === "fleet.concurrency") entry = "Enter auto or a positive whole number.";
	else if (control.path === "fleet.worktrees.root")
		entry = "Enter disk, tmpfs for memory storage, auto, or an absolute directory.";
	else if (control.path.endsWith(".ratio")) entry = "Enter a fraction up to 0.5, such as 0.3 for 30%.";
	else if (fractional) entry = "Enter a fraction, such as 0.6 for 60%.";
	else if (control.path.endsWith("Ms")) entry = "Enter milliseconds; 1000 means one second.";
	else if (control.path.endsWith("Bytes")) entry = "Enter bytes; 1024 means one KB.";
	else if (control.kind === "number") entry = "Enter a number; invalid values leave the setting unchanged.";
	return [
		control.description,
		control.help,
		...Object.entries(
			SETTINGS_VALUE_HELP_BY_ID[
				Object.keys(SETTINGS_LABELS_BY_ID).find((id) => settingsPathForRow(id) === control.path) ?? ""
			] ?? {},
		).map(([value, help]) => `${value}: ${help}`),
		settingsChangeKind(control.path) === "restartRequired"
			? "Takes effect in the next session."
			: settingsChangeKind(control.path) === "hotReload"
				? "A running session can apply this immediately."
				: "Used by the next relevant request, dispatch, or explicit open.",
		entry,
		control.optional ? "Clear the field to use the automatic/default behavior." : "",
		surface === "configure" ? `Open /settings ${settingsAreaForPath(control.path)} to change this in chat.` : "",
	]
		.filter(Boolean)
		.join("\n");
}
