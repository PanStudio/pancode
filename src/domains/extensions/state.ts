// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { ExtensionDiagnostic } from "@pancode/sdk/pack";
import { capabilityEnvelope, envelopeDigest as envelopeDigestOf } from "@pancode/sdk/pack";
import { recordLifecycleReceipt } from "../../core/hub-receipts.js";
import { derivedPublisher, publisherCollision } from "../../core/package-publisher.js";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { isRecord } from "../../core/type-guards.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import { type InstalledPlugin, listInstalledPlugins, pluginPromptNames } from "../plugins/index.js";
import { isExtensionId, loadManifestFromRoot } from "./discovery.js";
import {
	assertUnchangedInstallState,
	auditInstallRecords,
	type DroppedInstallRecord,
	emptyInstallState,
	type InstallRecordReport,
	type InvalidInstallRecord,
	retainRecovery,
	uniqueSibling,
	writeInstallState,
} from "./install-store.js";
import { extensionContentDigest } from "./integrity.js";
import {
	EXTENSION_STATE,
	type ExtensionSessionOverlay,
	extensionBaseDir,
	type InstalledExtensionRecord,
	lexists,
	listExtensionRecords,
	managedBaseError,
	readState,
	scopeRank,
	statePath,
} from "./listing.js";
import { extensionInvocation } from "./operator-commands.js";
import type {
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionModelAssignment,
	ExtensionMutationResult,
	ExtensionScope,
	ExtensionState,
	InstalledExtension,
} from "./types.js";

function writeState(
	scope: ExtensionScope,
	cwd: string,
	state: ExtensionState,
	expected: string | undefined,
	invalid: ReadonlyArray<InvalidInstallRecord>,
): void {
	writeInstallState(EXTENSION_STATE, scope, cwd, state, expected, invalid);
}

function recoveryPath(filePath: string, label: string): string {
	return `${filePath}.${label}-${process.pid}-${Date.now()}.bak`;
}

function packageRecoveryPath(root: string, label: string): string {
	return path.join(path.dirname(root), `.${path.basename(root)}.${label}-${process.pid}-${Date.now()}.bak`);
}

function preserveCorruptState(filePath: string, bytes: string): string {
	const backupPath = recoveryPath(filePath, "corrupt");
	safeResourceWrite(backupPath, bytes, { mode: 0o600 });
	return backupPath;
}

export function readExtensionInstallRecord(
	id: string,
	options: ExtensionListOptions = {},
): ExtensionState["installed"][string] | undefined {
	const cwd = options.cwd ?? process.cwd();
	const read = (scope: ExtensionScope) => {
		const result = readState(scope, cwd);
		if (result.status === "corrupt") throw new Error(`extension install state is corrupt: ${result.message}`);
		return result.state.installed[id];
	};
	return options.scope ? read(options.scope) : (read("project") ?? read("user"));
}

export function listInstalledExtensionRecords(
	cwd = process.cwd(),
	options: ExtensionListOptions = {},
	overlay?: ExtensionSessionOverlay,
): InstalledExtensionRecord[] {
	const records = listExtensionRecords(cwd, options, overlay);
	annotateServedPlugins(
		records.map((record) => record.entry),
		cwd,
	);
	return records;
}

export function listInstalledExtensions(
	cwd = process.cwd(),
	options: ExtensionListOptions = {},
	overlay?: ExtensionSessionOverlay,
): InstalledExtension[] {
	return listInstalledExtensionRecords(cwd, options, overlay).map((record) => record.entry);
}

/**
 * Whether an enabled extension declares `/token` as its own command, as a
 * command's bare alias, or as a `replaces: prompt` takeover of its plugin's prompt, read from manifests
 * alone, so `pancode run` can send the line to the extension runtime rather
 * than refuse it or hand it to the model before any runtime starts (WTF-P F04).
 */
export function installedExtensionClaims(token: string, cwd = process.cwd()): boolean {
	return listInstalledExtensions(cwd).some(
		(entry) =>
			entry.loadable &&
			entry.runtimeV2?.commands.some(
				(command) =>
					token === extensionInvocation(entry.id, command.name) ||
					command.alias === token ||
					("replaces" in command &&
						command.replaces === "prompt" &&
						entry.plugin !== undefined &&
						token === `${entry.plugin}:${command.name}`),
			) === true,
	);
}

/**
 * Resolve each `plugin:` link against the plugins in effect in this workspace.
 * Plugins are read once per listing, and only when some extension declares a link.
 */
function annotateServedPlugins(entries: InstalledExtension[], cwd: string): void {
	if (!entries.some((entry) => entry.plugin)) return;
	let plugins: InstalledPlugin[] = [];
	try {
		plugins = listInstalledPlugins(cwd);
	} catch {
		// Unreadable plugin state serves no prompts: every takeover stays off and the plain prompts keep working.
	}
	for (const entry of entries) {
		if (!entry.plugin) continue;
		const served = plugins.find((plugin) => plugin.id === entry.plugin && plugin.loadable);
		entry.pluginPrompts = served?.manifest ? pluginPromptNames(served.rootPath, served.manifest) : [];
		if (served?.manifest) entry.pluginSource = `plugin:${served.scope}:${served.id}`;
		else delete entry.pluginSource;
	}
}

type InstalledInScope = InstalledExtension & { scope: ExtensionScope };

/** Install state never holds a dev package; this module's listing has no session overlay. */
function findInstalled(id: string, cwd: string, scope?: ExtensionScope): InstalledInScope | null {
	const entries = listInstalledExtensions(cwd, { ...(scope ? { scope } : {}), all: true }).filter(
		(entry): entry is InstalledInScope => entry.id === id && entry.scope !== "dev",
	);
	if (entries.length === 0) return null;
	return [...entries].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope)).at(-1) ?? null;
}

function refusal(message: string, at?: string): ExtensionInstallResult {
	return { diagnostics: [{ type: "error", message, ...(at ? { path: at } : {}) }] };
}

export function installExtension(sourcePath: string, options: ExtensionInstallOptions = {}): ExtensionInstallResult {
	const scope = options.scope ?? "user";
	const cwd = options.cwd ?? process.cwd();
	const source = path.resolve(sourcePath);
	const candidate = loadManifestFromRoot(source);
	if (!candidate.manifest || !candidate.valid) return { diagnostics: candidate.diagnostics };
	const manifest = candidate.manifest;
	if (
		(options.expectedId !== undefined && options.expectedId !== manifest.id) ||
		(options.expectedVersion !== undefined && options.expectedVersion !== manifest.version)
	)
		return refusal("extension source does not match the pinned identity or version");
	const redirected = managedBaseError(scope, cwd);
	if (redirected) return refusal(redirected);
	// The source is hashed before anything is staged, so a hard link, a special file or an
	// escaping link stops here and the managed directory never sees it.
	let sourceDigest: string;
	try {
		sourceDigest = extensionContentDigest(source);
	} catch (error) {
		return refusal(
			`extension source cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
			source,
		);
	}
	if (options.expectedDigest !== undefined && sourceDigest !== options.expectedDigest)
		return refusal("extension source does not match the pinned full-tree digest");
	if (lexists(path.join(source, "state.json")))
		return refusal("extension package must not contain a root state.json, which belongs to install state", source);
	const envelope = manifest.runtimeV2
		? envelopeDigestOf(capabilityEnvelope(manifest.runtimeV2, manifest.plugin))
		: undefined;
	if (options.expectedEnvelopeDigest !== undefined && (options.expectedEnvelopeDigest ?? undefined) !== envelope)
		return refusal("extension capability envelope differs from the one reviewed; review a fresh plan");
	const base = extensionBaseDir(scope, cwd);
	const targetRoot = path.join(base, manifest.id);
	// Copying a source into its own descendant grows recursively; replacing an
	// ancestor would erase the source. Neither is a meaningful install.
	if (
		isSameOrDescendant(canonicalizeExistingPath(base), canonicalizeExistingPath(source)) ||
		isSameOrDescendant(canonicalizeExistingPath(source), canonicalizeExistingPath(targetRoot))
	)
		return refusal("extension source overlaps its managed installation destination");
	if (lexists(targetRoot)) {
		if (lstatSync(targetRoot).isSymbolicLink())
			return refusal("installed extension root must not be a symbolic link", targetRoot);
		if (!options.force) {
			return refusal(`extension ${manifest.id} is already installed; retry with --force to replace it`, targetRoot);
		}
	}
	const stateResult = readState(scope, cwd);
	if (stateResult.status === "corrupt" && stateResult.bytes === undefined) {
		return refusal(`extension install state is corrupt: ${stateResult.message}`, statePath(scope, cwd));
	}
	if (stateResult.status === "corrupt" && !options.force) {
		return refusal(
			`extension install state is corrupt: ${stateResult.message}; retry with --force to back it up and reinstall safely`,
			statePath(scope, cwd),
		);
	}
	const state = stateResult.state;
	const previouslyInstalled = Object.hasOwn(state.installed, manifest.id);
	const origin = options.origin ?? { kind: "local" as const, source };
	const publisher = options.publisher ?? derivedPublisher(origin.source);
	const collision = publisherCollision(
		manifest.id,
		publisher,
		(["user", "project"] as const).flatMap((other) => {
			const copy = (other === scope ? state : readState(other, cwd).state).installed[manifest.id];
			return copy ? [{ scope: other, publisher: copy.publisher }] : [];
		}),
	);
	if (collision) return refusal(collision);
	const previousDigest = state.installed[manifest.id]?.contentDigest;
	const parent = path.dirname(targetRoot);
	const stagingRoot = uniqueSibling(targetRoot, "install");
	const backupRoot = uniqueSibling(targetRoot, "backup");
	let installedReplacement = false;
	let movedExisting = false;
	// Files that differ from the record are the operator's evidence, not ours to discard.
	let preserveBackup = false;
	if (lexists(targetRoot)) {
		try {
			preserveBackup = extensionContentDigest(targetRoot) !== previousDigest;
		} catch {
			// An unreadable tree cannot be proven to match its record.
			preserveBackup = true;
		}
	}
	let stateBackup: string | undefined;
	let packageBackup: string | undefined;
	try {
		// A writer creates the user config root as PanCode owns it (mode 0700) before its first write beneath it.
		if (scope === "user") pancodeConfigDir();
		mkdirSync(parent, { recursive: true });
		cpSync(source, stagingRoot, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
		const stagedCandidate = loadManifestFromRoot(stagingRoot);
		if (!stagedCandidate.valid || !stagedCandidate.manifest) {
			const reasons = stagedCandidate.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
			throw new Error(`staged extension content is invalid${reasons ? `: ${reasons}` : ""}`);
		}
		const stagedManifest = stagedCandidate.manifest;
		if (stagedManifest.id !== manifest.id) {
			throw new Error(`staged extension id changed from ${manifest.id} to ${stagedManifest.id}`);
		}
		const stagedEnvelope = stagedManifest.runtimeV2
			? envelopeDigestOf(capabilityEnvelope(stagedManifest.runtimeV2, stagedManifest.plugin))
			: undefined;
		if (
			extensionContentDigest(stagingRoot) !== sourceDigest ||
			stagedManifest.version !== manifest.version ||
			stagedEnvelope !== envelope
		)
			throw new Error("staged extension differs from the verified source tree");
		if (extensionContentDigest(source) !== sourceDigest) throw new Error("extension source changed while staging");
		assertUnchangedInstallState(EXTENSION_STATE, scope, cwd, stateResult.bytes);
		if (stateResult.status === "corrupt" && stateResult.bytes !== undefined) {
			stateBackup = preserveCorruptState(statePath(scope, cwd), stateResult.bytes);
		}
		if (lexists(targetRoot)) {
			renameSync(targetRoot, backupRoot);
			movedExisting = true;
			packageBackup = backupRoot;
		}
		renameSync(stagingRoot, targetRoot);
		installedReplacement = true;
		if (extensionContentDigest(targetRoot) !== sourceDigest) throw new Error("extension changed during publication");
		// The staged manifest is the one whose bytes were just digested, so the envelope recorded is the one installed.
		// An assigned model stays while the package still asks for one: each call checks its route again.
		const assigned = stagedManifest.runtimeV2?.services?.model ? state.installed[manifest.id]?.services : undefined;
		state.installed[manifest.id] = {
			installedAt: new Date().toISOString(),
			source: options.source ?? source,
			origin,
			contentDigest: sourceDigest,
			...(envelope ? { envelopeDigest: envelope } : {}),
			...(assigned ? { services: assigned } : {}),
			publisher,
		};
		if (!previouslyInstalled) state.disabled = state.disabled.filter((entry) => entry !== manifest.id);
		writeState(scope, cwd, state, stateResult.bytes, stateResult.status === "valid" ? stateResult.invalid : []);
	} catch (error) {
		rmSync(stagingRoot, { recursive: true, force: true });
		if (stateBackup) {
			rmSync(stateBackup, { force: true });
			stateBackup = undefined;
		}
		// Preserve concurrent changes instead of deleting someone else's work.
		let changed = false;
		if (installedReplacement && lexists(targetRoot)) {
			try {
				changed = extensionContentDigest(targetRoot) !== sourceDigest;
			} catch {
				// Unreadable replacement bytes are preserved.
				changed = true;
			}
			if (!changed) rmSync(targetRoot, { recursive: true, force: true });
		}
		if (movedExisting && !changed && existsSync(backupRoot) && !lexists(targetRoot)) {
			renameSync(backupRoot, targetRoot);
			packageBackup = undefined;
		}
		return {
			...(stateBackup || packageBackup
				? { recovery: { ...(stateBackup ? { stateBackup } : {}), ...(packageBackup ? { packageBackup } : {}) } }
				: {}),
			diagnostics: [
				{
					type: "error",
					message: `extension ${manifest.id} install failed: ${error instanceof Error ? error.message : String(error)}`,
					path: targetRoot,
				},
			],
		};
	}
	const diagnostics = [...candidate.diagnostics];
	if (movedExisting && !preserveBackup) preserveBackup = retainRecovery(backupRoot, previousDigest);
	if (movedExisting && preserveBackup) {
		diagnostics.push({
			type: "warning",
			message:
				stateResult.status === "valid"
					? "previous extension files that differed from the install record were preserved"
					: "previous unverifiable extension bytes were preserved during forced reinstall",
			path: backupRoot,
		});
	} else packageBackup = undefined;
	if (stateBackup) {
		diagnostics.push({ type: "warning", message: "corrupt extension install state was preserved", path: stateBackup });
	}
	const installed = findInstalled(manifest.id, cwd, scope);
	recordLifecycleReceipt(
		{
			operation: movedExisting ? "update" : "install",
			kind: "extension",
			id: manifest.id,
			version: manifest.version,
			contentDigest: sourceDigest,
			envelopeDigest: envelope ?? null,
			scope,
			source: options.source ?? source,
		},
		options.lifecycle,
	);
	return {
		...(installed ? { extension: installed } : {}),
		contentDigest: sourceDigest,
		...(stateBackup || packageBackup
			? { recovery: { ...(stateBackup ? { stateBackup } : {}), ...(packageBackup ? { packageBackup } : {}) } }
			: {}),
		diagnostics,
	};
}

/** The diagnostic for an id that is not installed, naming a redirected scope when that is why. */
function notInstalled(id: string, options: ExtensionListOptions, cwd: string): ExtensionMutationResult {
	for (const scope of options.scope ? [options.scope] : (["user", "project"] as const)) {
		const redirected = managedBaseError(scope, cwd);
		if (redirected && (options.scope || !lexists(extensionBaseDir(scope, cwd))))
			return { diagnostics: [{ type: "error", message: redirected }] };
	}
	return { diagnostics: [{ type: "error", message: `extension ${id} is not installed` }] };
}

function mutateEnabled(id: string, enabled: boolean, options: ExtensionListOptions = {}): ExtensionMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const target = findInstalled(id, cwd, options.scope);
	if (!target) return notInstalled(id, options, cwd);
	const redirected = managedBaseError(target.scope, cwd);
	if (redirected) return { diagnostics: [{ type: "error", message: redirected }] };
	const stateResult = readState(target.scope, cwd);
	if (stateResult.status !== "valid") {
		return {
			diagnostics: [
				{
					type: "error",
					message:
						stateResult.status === "corrupt"
							? `extension install state is corrupt: ${stateResult.message}`
							: "extension install state is absent",
					path: statePath(target.scope, cwd),
				},
			],
		};
	}
	const state = stateResult.state;
	if (enabled) state.disabled = state.disabled.filter((entry) => entry !== id);
	else if (!state.disabled.includes(id)) state.disabled.push(id);
	try {
		writeState(target.scope, cwd, state, stateResult.bytes, stateResult.invalid);
	} catch (error) {
		return {
			diagnostics: [
				{
					type: "error",
					message: error instanceof Error ? error.message : String(error),
					path: statePath(target.scope, cwd),
				},
			],
		};
	}
	const extension = findInstalled(id, cwd, target.scope) ?? undefined;
	recordLifecycleReceipt(
		{
			operation: enabled ? "enable" : "disable",
			kind: "extension",
			id,
			version: target.version,
			contentDigest: state.installed[id]?.contentDigest ?? null,
			envelopeDigest: state.installed[id]?.envelopeDigest ?? null,
			scope: target.scope,
			source: state.installed[id]?.source ?? target.rootPath,
		},
		options.lifecycle,
	);
	return { ...(extension ? { extension } : {}), diagnostics: [] };
}

/**
 * Record, or with null clear, the model the operator assigned to an installed extension's model service.
 * The caller resolved `endpoint` from the route the assignment names at this moment.
 */
export function assignExtensionModel(
	id: string,
	assignment: Omit<ExtensionModelAssignment, "assignedAt"> | null,
	options: ExtensionListOptions = {},
): ExtensionMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const target = findInstalled(id, cwd, options.scope);
	if (!target) return notInstalled(id, options, cwd);
	const redirected = managedBaseError(target.scope, cwd);
	if (redirected) return { diagnostics: [{ type: "error", message: redirected }] };
	const stateResult = readState(target.scope, cwd);
	const record = stateResult.state.installed[id];
	if (stateResult.status !== "valid" || !record)
		return {
			diagnostics: [
				{
					type: "error",
					message:
						stateResult.status === "corrupt"
							? `extension install state is corrupt: ${stateResult.message}`
							: `extension ${id} has no install record`,
					path: statePath(target.scope, cwd),
				},
			],
		};
	if (assignment !== null && !target.runtimeV2?.services?.model)
		return { diagnostics: [{ type: "error", message: `extension ${id} declares no runtime.services.model` }] };
	const { services: _services, ...rest } = record;
	stateResult.state.installed[id] =
		assignment === null
			? rest
			: { ...rest, services: { model: { ...assignment, assignedAt: new Date().toISOString() } } };
	try {
		writeState(target.scope, cwd, stateResult.state, stateResult.bytes, stateResult.invalid);
	} catch (error) {
		return {
			diagnostics: [
				{
					type: "error",
					message: error instanceof Error ? error.message : String(error),
					path: statePath(target.scope, cwd),
				},
			],
		};
	}
	const extension = findInstalled(id, cwd, target.scope) ?? undefined;
	return { ...(extension ? { extension } : {}), diagnostics: [] };
}

export function enableExtension(id: string, options: ExtensionListOptions = {}): ExtensionMutationResult {
	return mutateEnabled(id, true, options);
}

export function disableExtension(id: string, options: ExtensionListOptions = {}): ExtensionMutationResult {
	return mutateEnabled(id, false, options);
}

export function removeExtension(id: string, options: ExtensionListOptions = {}): ExtensionMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const target = findInstalled(id, cwd, options.scope);
	if (!target) return notInstalled(id, options, cwd);
	const redirected = managedBaseError(target.scope, cwd);
	if (redirected) return { diagnostics: [{ type: "error", message: redirected }] };
	if (lstatSync(target.rootPath).isSymbolicLink()) {
		return {
			diagnostics: [
				{ type: "error", message: "installed extension root must not be a symbolic link", path: target.rootPath },
			],
		};
	}
	const stateResult = readState(target.scope, cwd);
	const receiptIdentity = {
		operation: "remove" as const,
		kind: "extension",
		id,
		version: target.version,
		contentDigest: stateResult.state.installed[id]?.contentDigest ?? target.provenance?.contentDigest ?? null,
		envelopeDigest: stateResult.state.installed[id]?.envelopeDigest ?? null,
		scope: target.scope,
		source: stateResult.state.installed[id]?.source ?? target.rootPath,
	};
	if (stateResult.status !== "valid") {
		if (stateResult.status === "corrupt" && stateResult.bytes === undefined) {
			return {
				diagnostics: [
					{
						type: "error",
						message: `extension ${id} could not be removed safely: ${stateResult.message}`,
						path: target.rootPath,
					},
				],
			};
		}
		const filePath = statePath(target.scope, cwd);
		const packageBackup = packageRecoveryPath(target.rootPath, "removed-unverifiable");
		let stateBackup: string | undefined;
		try {
			assertUnchangedInstallState(EXTENSION_STATE, target.scope, cwd, stateResult.bytes);
			if (stateResult.status === "corrupt" && stateResult.bytes !== undefined) {
				stateBackup = preserveCorruptState(filePath, stateResult.bytes);
			}
			renameSync(target.rootPath, packageBackup);
			try {
				writeState(target.scope, cwd, emptyInstallState(), stateResult.bytes, []);
			} catch (error) {
				renameSync(packageBackup, target.rootPath);
				throw error;
			}
			const diagnostics: ExtensionDiagnostic[] = [
				{
					type: "warning",
					message: "unverifiable extension bytes were preserved while removing the package from the load path",
					path: packageBackup,
				},
			];
			if (stateBackup) {
				diagnostics.push({ type: "warning", message: "corrupt extension install state was preserved", path: stateBackup });
			}
			recordLifecycleReceipt(receiptIdentity, options.lifecycle);
			return {
				removed: { id, scope: target.scope, path: target.rootPath },
				recovery: { ...(stateBackup ? { stateBackup } : {}), packageBackup },
				diagnostics,
			};
		} catch (error) {
			if (stateBackup) rmSync(stateBackup, { force: true });
			return {
				diagnostics: [
					{
						type: "error",
						message: `extension ${id} could not be removed safely: ${error instanceof Error ? error.message : String(error)}`,
						path: target.rootPath,
					},
				],
			};
		}
	}
	const state = stateResult.state;
	const recordedDigest = state.installed[id]?.contentDigest;
	// Files that differ from the record leave the load path but stay on disk beside it.
	let preserve = false;
	try {
		preserve = extensionContentDigest(target.rootPath) !== recordedDigest;
	} catch {
		preserve = true;
	}
	const backup = uniqueSibling(target.rootPath, "removed");
	let moved = false;
	try {
		assertUnchangedInstallState(EXTENSION_STATE, target.scope, cwd, stateResult.bytes);
		renameSync(target.rootPath, backup);
		moved = true;
		Reflect.deleteProperty(state.installed, id);
		state.disabled = state.disabled.filter((entry) => entry !== id);
		writeState(
			target.scope,
			cwd,
			state,
			stateResult.bytes,
			stateResult.invalid.filter((entry) => entry.id !== id),
		);
	} catch (error) {
		if (moved && lexists(backup) && !lexists(target.rootPath)) renameSync(backup, target.rootPath);
		return {
			diagnostics: [
				{
					type: "error",
					message: `extension ${id} could not be removed safely: ${error instanceof Error ? error.message : String(error)}`,
					path: target.rootPath,
				},
			],
		};
	}
	if (!preserve) preserve = retainRecovery(backup, recordedDigest);
	const packageBackup = preserve ? backup : undefined;
	recordLifecycleReceipt(receiptIdentity, options.lifecycle);
	return {
		removed: { id, scope: target.scope, path: target.rootPath },
		...(packageBackup ? { recovery: { packageBackup } } : {}),
		diagnostics: packageBackup
			? [
					{
						type: "warning",
						message: "removed extension contained changed or unverified files; preserved recovery copy",
						path: packageBackup,
					},
				]
			: [],
	};
}

/** Doctor's read of one scope's install records, or null when that scope has no state file. Throws when the file is unreadable. */
export function auditExtensionInstallRecords(scope: ExtensionScope, cwd = process.cwd()): InstallRecordReport | null {
	return auditInstallRecords(EXTENSION_STATE, scope, cwd);
}

/**
 * `doctor --fix`: drop every invalid record from one scope's state file. A
 * package directory whose bytes hash to the record's contentDigest goes with
 * it; any other directory moves to a recovery copy beside it, as `hub remove`
 * does, so the reinstall path is free and no unmatched byte is deleted.
 */
export function repairExtensionInstallRecords(scope: ExtensionScope, cwd = process.cwd()): InstallRecordReport | null {
	const result = readState(scope, cwd);
	if (result.status === "absent") return null;
	if (result.status === "corrupt") throw new Error(result.message);
	const file = statePath(scope, cwd);
	const moves: Array<{ from: string; to: string }> = [];
	const dropped = result.invalid.map(({ id, pack, reason, raw }): DroppedInstallRecord => {
		const root = path.join(extensionBaseDir(scope, cwd), id);
		if (!isExtensionId(id) || !lexists(root)) return { id, pack, reason };
		if (lstatSync(root).isSymbolicLink()) return { id, pack, reason, kept: root };
		let owned = false;
		try {
			owned = isRecord(raw) && extensionContentDigest(root) === raw.contentDigest;
		} catch {
			// Bytes that cannot be hashed cannot be matched to the record, so they are preserved.
		}
		if (owned) return { id, pack, reason, removed: root };
		const preserved = uniqueSibling(root, "removed");
		moves.push({ from: root, to: preserved });
		return { id, pack, reason, preserved };
	});
	if (result.invalid.length > 0) {
		try {
			for (const move of moves) renameSync(move.from, move.to);
			const gone = new Set(dropped.flatMap((entry) => (entry.kept ? [] : [entry.id])));
			result.state.disabled = result.state.disabled.filter((id) => !gone.has(id));
			writeState(scope, cwd, result.state, result.bytes, []);
		} catch (error) {
			for (const move of moves) if (lexists(move.to)) renameSync(move.to, move.from);
			throw error;
		}
	}
	for (const entry of dropped) if (entry.removed) rmSync(entry.removed, { recursive: true, force: true });
	return { path: file, valid: Object.keys(result.state.installed).length, invalid: [], dropped };
}
