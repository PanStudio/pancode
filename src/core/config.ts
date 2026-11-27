// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Settings read/validate/write. The config domain wraps this module with
 * watcher, hot-reload, and event emission. Kept in core/ because multiple
 * domains (providers, modes, prompts) need settings access before the domain
 * loader has finished booting.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateStoreProjectId } from "@pancode/store/paths";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS, SETTINGS_FILE_MODE, type ThinkingLevel } from "./defaults.js";
import { writeDiagnostic } from "./diagnostics.js";
import { markUserTargets } from "./project-target-urls.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { readSettingsDocument } from "./settings-document.js";
import {
	formatSettingsFailure,
	issuesKind,
	type SettingsIssue,
	SettingsValidationError,
	settingsFailureHeadline,
	yamlErrorSummary,
} from "./settings-issues.js";
import { type SettingsValidationResult, validateSettings } from "./settings-validate.js";
import { withStateFileLockSync } from "./state-file-lock.js";
import { provideStoreProjectId, provideStoreSettings } from "./store-paths.js";
import { isRecord } from "./type-guards.js";
import { captureProjectSurface } from "./workspace-trust.js";
import { pancodeConfigDir, pancodeConfigPath, resolvePancodeDirs } from "./xdg.js";
import { renderYamlPreservingLayout } from "./yaml-preserve.js";

export type PancodeSettings = typeof DEFAULT_SETTINGS;

export function semanticUsable(
	semantic: PancodeSettings["context"]["semantic"] | undefined,
): semantic is PancodeSettings["context"]["semantic"] & { target: string; model: string; assetIdentity: string } {
	return (
		semantic?.enabled === true &&
		Boolean(semantic.target?.trim() && semantic.model?.trim() && semantic.assetIdentity?.trim())
	);
}

const reportedSettingsWarnings = new Set<string>();

/** Report accepted but inactive configuration once per process (#432). */
export function reportSettingsWarnings(settings: Readonly<PancodeSettings>): void {
	const semantic = settings.context.semantic;
	if (!semantic.enabled || semanticUsable(semantic)) return;
	const missing = (["target", "model", "assetIdentity"] as const)
		.filter((key) => !semantic[key]?.trim())
		.map((key) => `context.semantic.${key}`);
	const warning = `Settings warning: context.semantic.enabled is inactive; missing ${missing.join(", ")}. Run \`pancode semantic configure\` to pin them.`;
	if (reportedSettingsWarnings.has(warning)) return;
	reportedSettingsWarnings.add(warning);
	writeDiagnostic(warning, "warning");
}

export function settingsPath(): string {
	return join(pancodeConfigDir(), "settings.yaml");
}

/** The settings file without creating the config root, for a reader: read-only `doctor` must leave a fresh home empty. */
export function settingsReadPath(): string {
	return join(pancodeConfigPath(), "settings.yaml");
}

/** A rejected settings reload, in the parts each live surface needs. */
export interface SettingsReloadFailure {
	/** The whole {@link formatSettingsFailure} line. */
	message: string;
	/** The failing key and its error, or the failure kind when no key is at fault. */
	headline: string;
	file: string;
	keys: string[];
}

/**
 * {@link formatSettingsFailure} with the failing key split out. The full line
 * leads with its kind, which is right for doctor, but a footer in a narrow
 * pane clamps it to `[config] settings…` and loses the key (M-25). The
 * headline is the part a clamp must keep, so it names the key first.
 */
export function settingsReloadFailure(error: unknown): SettingsReloadFailure {
	const message = formatSettingsFailure(error);
	const file = settingsPath();
	if (!(error instanceof SettingsValidationError) || error.issues.length === 0)
		return { message, headline: message, file, keys: [] };
	const kind = issuesKind(error.issues);
	const first = error.issues[0];
	if (kind !== "schema" || first === undefined)
		return { message, headline: settingsFailureHeadline(kind), file, keys: [] };
	const more = error.issues.length > 1 ? ` (+${error.issues.length - 1} more)` : "";
	return {
		message,
		headline: `${first.path}: ${first.message}${more}`,
		file,
		keys: error.issues.map((issue) => issue.path),
	};
}

export function validateSettingsFile(): SettingsValidationResult {
	const path = join(resolvePancodeDirs().config, "settings.yaml");
	if (!existsSync(path)) return { settings: structuredClone(DEFAULT_SETTINGS), issues: [], coercions: [] };
	// The read and the parse fail for separate reasons: reporting `chmod 000` as
	// invalid YAML is a false statement about the file and points at the wrong repair.
	const read = readSettingsDocument(path);
	if (read.kind === "unreadable") {
		return {
			settings: structuredClone(DEFAULT_SETTINGS),
			issues: [
				{
					path: "(root)",
					message: `unreadable: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
					kind: "unreadable",
				},
			],
			coercions: [],
		};
	}
	if (read.kind === "invalid") {
		return {
			settings: structuredClone(DEFAULT_SETTINGS),
			issues: [{ path: "(root)", message: `invalid YAML: ${yamlErrorSummary(read.error)}`, kind: "syntax" }],
			coercions: [],
		};
	}
	const parsed = read.document;
	// An empty file parses as null; it holds no settings, so it reads as an empty map.
	const result = validateSettings(parsed ?? {});
	markUserTargets(result.settings.targets);
	const projectIdIssue = userStoreProjectIdIssue(parsed);
	if (projectIdIssue === null) return result;
	delete result.settings.store.projectId;
	return { ...result, issues: [...result.issues, projectIdIssue] };
}

/** The issue user settings carry when they set `store.projectId`, which only a project's tracked file sets. */
export const STORE_PROJECT_ID_USER_MESSAGE =
	"store.projectId is set only in the project's tracked .pancode/settings.yaml; value ignored";

/** An issue when the user settings document `raw` sets `store.projectId`, else null. */
export function userStoreProjectIdIssue(raw: unknown): SettingsIssue | null {
	if (!isRecord(raw) || !isRecord(raw.store) || !("projectId" in raw.store)) return null;
	return { path: "store.projectId", message: STORE_PROJECT_ID_USER_MESSAGE };
}

// Store roots are user-only, so the user file is the whole answer. An invalid store section refuses rather than
// falling back to the data directory, which would put tags where the operator said not to; so does an unreadable file.
provideStoreSettings(() => {
	const result = validateSettingsFile();
	// A misplaced store.projectId names no root and is reported by the settings read; the roots stand.
	const storeIssues = result.issues.filter(
		(issue) =>
			issue.path === "(root)" ||
			issue.path === "store" ||
			(issue.path.startsWith("store.") && issue.path !== "store.projectId"),
	);
	if (storeIssues.length > 0) throw new SettingsValidationError(storeIssues);
	const { backend, s3, roots, placement } = result.settings.store;
	return { backend, s3, roots, placement };
});

// The project id is the tracked project file's alone, read at the main checkout and only while the operator
// trusts the project's settings: an untrusted checkout must not name another project's store as its own.
provideStoreProjectId((root) => {
	try {
		const snapshot = captureProjectSurface(root, "settings");
		const text = snapshot.verdict === "trusted" ? snapshot.files[0]?.text : null;
		if (text === null || text === undefined) return undefined;
		const parsed: unknown = parseYaml(text);
		if (!isRecord(parsed) || !isRecord(parsed.store)) return undefined;
		const id = parsed.store.projectId;
		return typeof id === "string" && validateStoreProjectId(id) === null ? id : undefined;
	} catch {
		// Settings that cannot be read or parsed give no id; the settings read reports them, and the store keys by path.
		return undefined;
	}
});

export function readSettings(): PancodeSettings {
	const result = validateSettingsFile();
	if (result.issues.length > 0) throw new SettingsValidationError(result.issues);
	reportSettingsWarnings(result.settings);
	return result.settings;
}

/**
 * Whole-file settings write via temp-file + rename. The rename is atomic on
 * POSIX, so a concurrent readSettings never observes a partially written
 * YAML document and readers never need the settings lock. Module-internal:
 * every mutation goes through updateSettings so there is exactly one writer
 * path and it always holds the lock.
 */
function persistSettings(document: unknown): void {
	const path = settingsPath();
	let existing: string | null = null;
	try {
		existing = readFileSync(path, "utf8");
	} catch {
		// No readable file yet, so there is no layout to keep; render it fresh.
	}
	safeResourceWrite(path, renderYamlPreservingLayout(existing, document), {
		encoding: "utf8",
		mode: SETTINGS_FILE_MODE,
	});
}

/**
 * The saved document exactly as YAML parsed it, before defaults are merged in.
 * updateSettings patches this instead of the normalized blob, so the file only
 * ever gains what a mutation actually touched.
 */
function readSavedDocument(): unknown {
	const path = settingsPath();
	if (!existsSync(path)) return {};
	try {
		return parseYaml(readFileSync(path, "utf8")) ?? {};
	} catch {
		return {};
	}
}

/**
 * Write the `before` → `after` delta of two normalized settings blobs onto the
 * raw saved document. Keys the mutation did not change keep their saved form
 * (or stay absent), so materialized defaults such as `workers.profiles: {}`
 * never leak into a file that never had them.
 */
export function applySettingsDelta(saved: unknown, before: unknown, after: unknown): unknown {
	if (!isRecord(before) || !isRecord(after)) return structuredClone(after);
	const out: Record<string, unknown> = isRecord(saved) ? { ...saved } : {};
	for (const [key, next] of Object.entries(after)) {
		// Untouched keys keep whatever the file said, including saying nothing.
		if (deepEquals(before[key], next)) continue;
		out[key] = applySettingsDelta(out[key], before[key], next);
	}
	// A key the mutation removed from a map (a deleted worker profile) goes too.
	for (const key of Object.keys(out)) {
		if (!(key in after)) delete out[key];
	}
	return out;
}

/**
 * Write one dotted leaf of `settings` onto a raw saved document even when the
 * delta skipped it because it equals the inherited value, so an explicit
 * `config set` pins the value in its own scope. An absent leaf pins nothing.
 */
export function pinSettingsLeaf(saved: unknown, settings: unknown, path: string): unknown {
	const keys = path.split(".");
	let value: unknown = settings;
	for (const key of keys) value = isRecord(value) ? value[key] : undefined;
	if (value === undefined) return saved;
	const out: Record<string, unknown> = isRecord(saved) ? saved : {};
	let cursor = out;
	for (const key of keys.slice(0, -1)) {
		const next = cursor[key];
		if (!isRecord(next)) cursor[key] = {};
		cursor = cursor[key] as Record<string, unknown>;
	}
	cursor[keys.at(-1) as string] = structuredClone(value);
	return out;
}

function deepEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEquals(entry, b[index]));
	}
	if (!isRecord(a) || !isRecord(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => key in b && deepEquals(a[key], b[key]));
}

/**
 * Mutation applied to the freshest saved settings under the settings lock.
 * Mutate in place (return nothing) or return a replacement blob.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: in-place mutators legitimately return nothing, including named functions typed `: void`
export type SettingsMutator = (settings: PancodeSettings) => PancodeSettings | undefined | void;

export interface SettingsUpdateOptions {
	/** Total time to wait for the lock before giving up. Default 10s. */
	timeoutMs?: number;
	/** Dotted leaf written even when it equals the inherited value (`config set`). */
	pin?: string;
}

/**
 * Replace the raw user settings document under the same cross-process lock as
 * `updateSettings`. Workspace-aware layering owns the only current caller: it
 * computes and validates the candidate against the project layers before this
 * helper commits the raw user-layer delta.
 */
export function updateSavedSettingsDocument(
	mutate: (saved: unknown) => unknown,
	options: SettingsUpdateOptions = {},
): void {
	withSettingsLock(() => {
		// Keep the strict gate updateSettings has always used. readSavedDocument
		// deliberately degrades parse/read failures to `{}` for recovery callers;
		// writing through that degraded value would erase a malformed, null, or
		// transiently unreadable operator document.
		readSettings();
		const saved = readSavedDocument();
		persistSettings(mutate(structuredClone(saved)));
	}, options);
}

/**
 * Whether the operator's user settings leave `safety.yoloConfinement` unnamed, so the one-time contained-yolo notice
 * still has something to say. Reads only: the notice is remembered in lifecycle state, never in this file.
 */
export function savedYoloConfinementUnnamed(): boolean {
	if (!existsSync(settingsPath())) return false;
	const saved = readSavedDocument();
	if (saved === null || typeof saved !== "object" || Array.isArray(saved)) return false;
	const safety = (saved as { safety?: unknown }).safety;
	if (safety === undefined) return true;
	return safety !== null && typeof safety === "object" && !Array.isArray(safety) && !("yoloConfinement" in safety);
}

/**
 * Run `fn` while holding the settings.yaml advisory lock. Factored out of
 * updateSettings so the other settings writers (doctor --fix repair, the editors) hold the
 * same lock instead of racing updateSettings.
 */
export function withSettingsLock<T>(fn: () => T, options: SettingsUpdateOptions = {}): T {
	return withStateFileLockSync(settingsPath(), fn, { timeoutMs: options.timeoutMs ?? 10_000 });
}

/**
 * Cross-process read-modify-write of settings.yaml under an advisory lock
 * file. Two processes doing naive read → mutate → write can interleave and
 * silently drop one of the writes; this helper re-reads the file *inside*
 * the lock, so the mutation always lands on the freshest saved state.
 * Readers never touch the lock; they only ever see complete files thanks to
 * the rename-based writer.
 *
 * The mutator may modify the settings in place or return a replacement blob.
 * The result is re-validated through the schema before it is persisted, so a
 * mutator cannot write an invalid document. Returns the persisted settings.
 */
export function updateSettings(mutate: SettingsMutator, options: SettingsUpdateOptions = {}): PancodeSettings {
	return withSettingsLock(() => {
		const saved = readSavedDocument();
		const current = readSettings();
		// Snapshot before the mutator runs: in-place mutators alias `current`.
		const before = structuredClone(current);
		const next = mutate(current) ?? current;
		const revalidated = validateSettings(JSON.parse(JSON.stringify(next)));
		if (revalidated.issues.length > 0) throw new SettingsValidationError(revalidated.issues);
		const delta = applySettingsDelta(saved, before, revalidated.settings);
		persistSettings(options.pin !== undefined ? pinSettingsLeaf(delta, revalidated.settings, options.pin) : delta);
		return revalidated.settings;
	}, options);
}

/**
 * Settings mutations shared by the `pancode targets …` CLI (inside
 * updateSettings) and the settings overlay's Fleet and Targets rows (on the
 * effective view, committed per leaf). Registry-backed eligibility checks stay with the caller.
 */
export interface UseTargetOptions {
	model?: string;
	orchestratorModel?: string;
	workerModel?: string;
	workerTargetId?: string;
	backgroundModel?: string;
}

export type TargetSelectionRole = "chat" | "fleet" | "memory";

/**
 * A role flag scopes `targets use` to the roles it names, and `--model` is only
 * the fallback for a selected role that has no model flag of its own. When no
 * selected role falls back to it, it would be dropped without a word, so the
 * call is refused instead. `targets use blade --model X --fleet-target Y
 * --fleet-model Z` changed fleet alone and left chat where it was.
 */
export function unusedSharedModelReason(targetId: string, options: UseTargetOptions): string | null {
	if (options.model === undefined) return null;
	const scoped =
		options.orchestratorModel !== undefined ||
		options.workerModel !== undefined ||
		options.workerTargetId !== undefined ||
		options.backgroundModel !== undefined;
	if (!scoped) return null;
	// Scoped, chat is selected only by --orchestrator-model, which it then uses.
	// Fleet falls back to --model only on this target with no --fleet-model.
	const fleetUsesShared =
		options.workerModel === undefined && options.workerTargetId !== undefined && options.workerTargetId === targetId;
	if (fleetUsesShared) return null;
	const flags = [
		options.orchestratorModel !== undefined ? "--orchestrator-model" : null,
		options.backgroundModel !== undefined ? "--background-model" : null,
		options.workerTargetId !== undefined ? "--fleet-target" : null,
		options.workerModel !== undefined ? "--fleet-model" : null,
	].filter((flag): flag is string => flag !== null);
	return `--model '${options.model}' would not be used: ${flags.join(" and ")} select${flags.length === 1 ? "s" : ""} only the roles named, and none of them falls back to --model. To set the chat model, pass --orchestrator-model '${options.model}', or drop the role flags to set chat and fleet together.`;
}

/** Thrown by {@link useTargetInSettings} when an option would be silently ignored. */
export class TargetUseRefusal extends Error {}

/** Select only explicitly named roles; without role options retain chat/fleet selection. */
export function useTargetInSettings(
	settings: PancodeSettings,
	targetId: string,
	options: UseTargetOptions = {},
): { workerTargetId: string; roles: TargetSelectionRole[]; changedRoles: TargetSelectionRole[] } | null {
	const refusal = unusedSharedModelReason(targetId, options);
	if (refusal !== null) throw new TargetUseRefusal(refusal);
	const target = settings.targets.find((entry) => entry.id === targetId);
	if (!target) return null;
	// A worker target of its own is the split topology; its model defaults to that node's own default.
	const workerTarget =
		options.workerTargetId !== undefined && options.workerTargetId !== target.id
			? settings.targets.find((entry) => entry.id === options.workerTargetId)
			: target;
	if (!workerTarget) return null;
	const scoped =
		options.orchestratorModel !== undefined ||
		options.workerModel !== undefined ||
		options.workerTargetId !== undefined ||
		options.backgroundModel !== undefined;
	const roles: TargetSelectionRole[] = [];
	if (!scoped || options.orchestratorModel !== undefined) roles.push("chat");
	if (!scoped || options.workerModel !== undefined || options.workerTargetId !== undefined) roles.push("fleet");
	if (options.backgroundModel !== undefined) roles.push("memory");
	const changedRoles: TargetSelectionRole[] = [];
	const sharedModel = options.model ?? target.defaultModel ?? null;
	for (const role of roles) {
		const current = role === "chat" ? settings.chat : role === "fleet" ? settings.fleet.default : settings.context.memory;
		const nextTarget = role === "fleet" ? workerTarget.id : target.id;
		const nextModel =
			role === "chat"
				? (options.orchestratorModel ?? sharedModel)
				: role === "fleet"
					? (options.workerModel ?? (workerTarget === target ? sharedModel : (workerTarget.defaultModel ?? null)))
					: (options.backgroundModel ?? null);
		if (current.target !== nextTarget || current.model !== nextModel) changedRoles.push(role);
		current.target = nextTarget;
		current.model = nextModel;
	}
	return { workerTargetId: workerTarget.id, roles, changedRoles };
}

/** Drop a target and every routing field, profile, and scope entry that named it. */
export function removeTargetFromSettings(settings: PancodeSettings, id: string): boolean {
	if (!settings.targets.some((entry) => entry.id === id)) return false;
	settings.targets = settings.targets.filter((entry) => entry.id !== id);
	if (settings.chat.target === id) {
		settings.chat.target = null;
		settings.chat.model = null;
	}
	if (settings.context.memory.target === id) {
		settings.context.memory.target = null;
		settings.context.memory.model = null;
	}
	if (settings.fleet.default.target === id) {
		settings.fleet.default.target = null;
		settings.fleet.default.model = null;
	}
	for (const [name, profile] of Object.entries(settings.fleet.profiles)) {
		if (profile.target === id) delete settings.fleet.profiles[name];
	}
	settings.chat.modelPicker.cycleSet = settings.chat.modelPicker.cycleSet.filter((entry) => entry.split("/")[0] !== id);
	settings.chat.modelPicker.favorites = settings.chat.modelPicker.favorites.filter(
		(entry) => entry.split("/")[0] !== id,
	);
	return true;
}

/** Create or repoint a fleet profile; the model rebases on the target default unless given. */
export function setFleetProfileInSettings(
	settings: PancodeSettings,
	name: string,
	targetId: string,
	options: { model?: string; thinkingLevel?: ThinkingLevel } = {},
): boolean {
	const target = settings.targets.find((entry) => entry.id === targetId);
	if (!target) return false;
	const existing = settings.fleet.profiles[name];
	settings.fleet.profiles[name] = {
		target: target.id,
		model: options.model ?? target.defaultModel ?? null,
		thinkingLevel: options.thinkingLevel ?? existing?.thinkingLevel ?? "off",
	};
	return true;
}

/** Remove a fleet profile and its agent bindings; returns how many bindings went with it. */
export function removeFleetProfileFromSettings(settings: PancodeSettings, name: string): number {
	delete settings.fleet.profiles[name];
	let removedBindings = 0;
	for (const [agentId, profileName] of Object.entries(settings.fleet.agentProfiles)) {
		if (profileName !== name) continue;
		delete settings.fleet.agentProfiles[agentId];
		removedBindings += 1;
	}
	return removedBindings;
}

/** Bind a native agent to a profile. False for an ACP delegation agent, which ignores native routing. */
export function bindAgentProfileInSettings(settings: PancodeSettings, agentId: string, profileName: string): boolean {
	if (settings.integrations.externalAgents.entries.some((agent) => agent.id === agentId)) return false;
	settings.fleet.agentProfiles[agentId] = profileName;
	return true;
}
