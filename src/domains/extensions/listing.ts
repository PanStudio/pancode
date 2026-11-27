// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The installed-extension listing as install state and the package bytes give
 * it. It imports no plugin or hub module, so a worker that loads extension
 * tools reads it without loading the plugin and hub code.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { capabilityEnvelope, envelopeDigest as envelopeDigestOf } from "@pancode/sdk/pack";
import { sha256Hex } from "../../core/hash.js";
import { packRevokedMessage, revokedHubDigests } from "../../core/hub-revocations.js";
import { readPublisher } from "../../core/package-publisher.js";
import { pancodeProjectRoot } from "../../core/project-root.js";
import { isRecord } from "../../core/type-guards.js";
import { projectPackageTrust } from "../../core/workspace-trust.js";
import { pancodeConfigPath } from "../../core/xdg.js";
import { evaluatePancodeCompatibility } from "./compatibility.js";
import { loadManifestFromRoot, trimString } from "./discovery.js";
import {
	assertManagedBase,
	type InstallStateLayout,
	type InstallStateRead,
	installStatePath,
	readInstallState,
} from "./install-store.js";
import { extensionContentDigestWithCapture } from "./integrity.js";
import type {
	ExtensionListOptions,
	ExtensionLoadScope,
	ExtensionModelAssignment,
	ExtensionOrigin,
	ExtensionScope,
	ExtensionState,
	InstalledExtension,
} from "./types.js";

export type ExtensionInstallRecord = ExtensionState["installed"][string];
export type StateReadResult = InstallStateRead<ExtensionInstallRecord>;

export interface InstalledExtensionRecord {
	entry: InstalledExtension;
	/** Exact file bytes captured by the stable tree-digest read. */
	captured?: ReadonlyMap<string, Buffer>;
}

/** Resolves without creating the config root: read-only `doctor` must leave a fresh home empty. */
export function extensionBaseDir(scope: ExtensionScope, cwd = process.cwd()): string {
	return scope === "user"
		? path.join(pancodeConfigPath(), "extensions")
		: path.join(pancodeProjectRoot(cwd, path.join("extensions", "state.json")), ".pancode", "extensions");
}

export const EXTENSION_STATE: InstallStateLayout<ExtensionInstallRecord> = {
	noun: "extension",
	dir: "extensions",
	baseDir: extensionBaseDir,
	readRecord: (_id, raw) => readInstallRecord(raw),
	packRef: (id) => `extension:${id}`,
};

export function statePath(scope: ExtensionScope, cwd: string): string {
	return installStatePath(EXTENSION_STATE, scope, cwd);
}

export function readState(scope: ExtensionScope, cwd: string): StateReadResult {
	return readInstallState(EXTENSION_STATE, scope, cwd);
}

export function managedBaseError(scope: ExtensionScope, cwd: string): string | undefined {
	try {
		assertManagedBase(EXTENSION_STATE, scope, cwd);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function lexists(candidate: string): boolean {
	try {
		lstatSync(candidate);
		return true;
	} catch {
		// Absent or unreadable: nothing installed can be assumed at this path.
		return false;
	}
}

/** A dev package outranks both installed scopes for the session it is loaded in. */
export function scopeRank(scope: ExtensionLoadScope): number {
	return scope === "dev" ? 3 : scope === "project" ? 2 : 1;
}

function readOrigin(value: unknown): ExtensionOrigin | undefined {
	if (!isRecord(value) || (value.kind !== "local" && value.kind !== "catalog" && value.kind !== "github"))
		return undefined;
	const source = trimString(value.source);
	if (value.commit !== undefined && (typeof value.commit !== "string" || !/^[a-f0-9]{40}$/u.test(value.commit)))
		return undefined;
	return source
		? { kind: value.kind, source, ...(typeof value.commit === "string" ? { commit: value.commit } : {}) }
		: undefined;
}

function readModelAssignment(value: unknown): ExtensionModelAssignment | undefined {
	if (!isRecord(value)) throw new Error("services must be an object");
	if (value.model === undefined) return undefined;
	const raw = value.model;
	if (!isRecord(raw)) throw new Error("services.model must be an object");
	const target = trimString(raw.target);
	const model = trimString(raw.model);
	const endpoint = trimString(raw.endpoint);
	const assignedAt = trimString(raw.assignedAt);
	if (!target || !model || !endpoint || !assignedAt)
		throw new Error("services.model needs target, model, endpoint and assignedAt");
	const sessionTokens = raw.sessionTokens;
	if (sessionTokens !== undefined && !(Number.isInteger(sessionTokens) && (sessionTokens as number) > 0))
		throw new Error("services.model.sessionTokens must be a positive whole number");
	return {
		target,
		model,
		endpoint,
		...(sessionTokens !== undefined ? { sessionTokens: sessionTokens as number } : {}),
		assignedAt,
	};
}

/** Throws the reason one stored record is refused. */
function readInstallRecord(raw: unknown): ExtensionInstallRecord {
	if (!isRecord(raw)) throw new Error("the record must be an object");
	const installedAt = trimString(raw.installedAt);
	if (!installedAt) throw new Error("installedAt must be a non-empty string");
	const source = raw.source === undefined ? undefined : trimString(raw.source);
	if (raw.source !== undefined && !source) throw new Error("source must be a non-empty string");
	const contentDigest = raw.contentDigest === undefined ? undefined : trimString(raw.contentDigest);
	if (raw.contentDigest !== undefined && (!contentDigest || !/^[a-f0-9]{64}$/u.test(contentDigest)))
		throw new Error("contentDigest must be a SHA-256 digest");
	const envelopeDigest = raw.envelopeDigest === undefined ? undefined : trimString(raw.envelopeDigest);
	if (raw.envelopeDigest !== undefined && (!envelopeDigest || !/^[a-f0-9]{64}$/u.test(envelopeDigest)))
		throw new Error("envelopeDigest must be a SHA-256 digest");
	const origin = raw.origin === undefined ? undefined : readOrigin(raw.origin);
	if (raw.origin !== undefined && !origin) throw new Error("origin is not a valid origin");
	const model = raw.services === undefined ? undefined : readModelAssignment(raw.services);
	const publisher = readPublisher(raw.publisher);
	return {
		installedAt,
		...(source ? { source } : {}),
		...(origin ? { origin } : {}),
		...(contentDigest ? { contentDigest } : {}),
		...(envelopeDigest ? { envelopeDigest } : {}),
		...(model ? { services: { model } } : {}),
		publisher,
	};
}

function installedFromRoot(
	root: string,
	scope: ExtensionScope,
	stateResult: StateReadResult,
	cwd: string,
	fallbackId: string,
): InstalledExtensionRecord | null {
	const candidate = loadManifestFromRoot(root);
	const manifest = candidate.manifest;
	const diagnostics = [...candidate.diagnostics];
	const id = manifest?.id ?? fallbackId;
	const provenance = stateResult.state.installed[id];
	const expectedDigest = provenance?.contentDigest;
	let observedDigest: string | undefined;
	let captured: ReadonlyMap<string, Buffer> | undefined;
	let contentVerified = false;
	if (stateResult.status === "corrupt") {
		diagnostics.push({
			type: "error",
			message: `extension install state is corrupt: ${stateResult.message}; reinstall with --force or remove the package to preserve the corrupt bytes and recover`,
			path: statePath(scope, cwd),
		});
	} else if (stateResult.status === "absent") {
		diagnostics.push({
			type: "error",
			message: "extension install state is absent; installed content cannot be verified; reinstall with --force",
			path: statePath(scope, cwd),
		});
	} else if (!provenance) {
		const refused = stateResult.invalid.find((entry) => entry.id === id);
		diagnostics.push({
			type: "error",
			message: refused
				? `install record installed.${id} is invalid (${refused.reason}), so the package is not loaded; run \`pancode doctor --fix\` to drop it, then \`pancode hub install ${refused.pack}\``
				: `extension ${id} is not recorded in install state; reinstall with --force`,
			path: statePath(scope, cwd),
		});
	} else if (!expectedDigest) {
		diagnostics.push({
			type: "error",
			message: `extension ${id} install provenance has no content digest; reinstall with --force`,
			path: statePath(scope, cwd),
		});
	} else {
		try {
			const manifestName = candidate.manifestPath ? path.basename(candidate.manifestPath) : undefined;
			const digestResult = extensionContentDigestWithCapture(root, {
				capture: [...(manifestName ? [manifestName] : []), "hooks.yaml"],
			});
			observedDigest = digestResult.digest;
			contentVerified = observedDigest === expectedDigest;
			// Consent is to the envelope. Identical bytes always yield one envelope, so a
			// mismatch means the record was edited or the reviewed envelope no longer
			// describes this package; either way the operator has not approved what would load.
			if (contentVerified && manifest?.runtimeV2) {
				const current = envelopeDigestOf(capabilityEnvelope(manifest.runtimeV2, manifest.plugin));
				if (provenance.envelopeDigest !== current) {
					contentVerified = false;
					diagnostics.push({
						type: "error",
						message: provenance.envelopeDigest
							? `installed extension capability envelope differs from the one recorded at install (recorded ${provenance.envelopeDigest}, current ${current}); reinstall to review it`
							: `extension ${id} has no recorded capability envelope; reinstall to review what it may do`,
						path: root,
					});
				}
			}
			if (contentVerified) captured = digestResult.captured;
			if (!contentVerified) {
				diagnostics.push({
					type: "error",
					message: `installed extension content drift detected (expected ${expectedDigest}, observed ${observedDigest})`,
					path: root,
				});
			}
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: `installed extension content could not be verified: ${error instanceof Error ? error.message : String(error)}`,
				path: root,
			});
		}
	}
	const revokedDigest = expectedDigest ?? observedDigest;
	const revocation = revokedDigest ? revokedHubDigests().get(revokedDigest) : undefined;
	if (revocation) {
		contentVerified = false;
		diagnostics.push({ type: "error", message: packRevokedMessage(id, revocation), path: root });
	}
	const pancodeRange = manifest?.compatibility?.pancode;
	const compatible = pancodeRange === undefined || evaluatePancodeCompatibility(pancodeRange).satisfied;
	const manifestName = candidate.manifestPath ? path.basename(candidate.manifestPath) : undefined;
	const manifestBytes = manifestName ? captured?.get(manifestName) : undefined;
	const extensionProvenance =
		contentVerified && expectedDigest && manifestBytes
			? {
					id,
					scope,
					...(provenance?.source ? { sourcePath: provenance.source } : {}),
					canonicalRoot: realpathSync(root),
					manifestDigest: sha256Hex(manifestBytes),
					contentDigest: expectedDigest,
				}
			: undefined;
	const entry: InstalledExtension = {
		id,
		name: manifest?.name ?? id,
		version: manifest?.version ?? "unknown",
		description: manifest?.description ?? "Installed extension has an invalid manifest.",
		...(manifest?.capabilities ? { capabilities: manifest.capabilities } : {}),
		...(manifest?.runtimeV2 ? { runtimeV2: manifest.runtimeV2 } : {}),
		...(manifest?.plugin ? { plugin: manifest.plugin } : {}),
		scope,
		rootPath: root,
		manifestPath: candidate.manifestPath ?? root,
		enabled: !stateResult.state.disabled.includes(id),
		valid: manifest !== undefined && candidate.valid && contentVerified,
		compatible,
		effective: false,
		loadable: false,
		...(extensionProvenance ? { provenance: extensionProvenance } : {}),
		...(observedDigest ? { observedContentDigest: observedDigest } : {}),
		diagnostics,
	};
	return { entry, ...(extensionProvenance && captured ? { captured } : {}) };
}

/** A scope whose managed directory is redirected lists as one invalid entry and never as its contents. */
function invalidRootRecord(scope: ExtensionScope, cwd: string, message: string): InstalledExtensionRecord {
	const base = extensionBaseDir(scope, cwd);
	return {
		entry: {
			id: `invalid-${scope}-extension-root`,
			name: "Extension installation directory",
			version: "0.0.0",
			description: "",
			scope,
			rootPath: base,
			manifestPath: statePath(scope, cwd),
			enabled: false,
			valid: false,
			compatible: true,
			effective: false,
			loadable: false,
			diagnostics: [{ type: "error", message: `extension directory cannot be read: ${message}`, path: base }],
		},
	};
}

function listScope(scope: ExtensionScope, cwd = process.cwd()): InstalledExtensionRecord[] {
	const base = extensionBaseDir(scope, cwd);
	if (!lexists(base)) return [];
	const redirected = managedBaseError(scope, cwd);
	if (redirected) return [invalidRootRecord(scope, cwd, redirected)];
	const state = readState(scope, cwd);
	const out: InstalledExtensionRecord[] = [];
	for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const root = path.join(base, entry.name);
		const installed = installedFromRoot(root, scope, state, cwd, entry.name);
		if (installed) out.push(installed);
	}
	return out;
}

/**
 * A project copy installs from the repository's own state, so its digest check
 * proves integrity and not consent. Workspace trust supplies the consent per
 * record: a copy the operator has not approved, enabled or disabled, neither
 * loads nor shadows a user copy, and user-scoped extensions are unaffected.
 */
function blockUntrustedProjectExtensions(records: ReadonlyArray<InstalledExtensionRecord>, cwd: string): void {
	const project = records.filter((record) => record.entry.scope === "project");
	if (project.length === 0) return;
	const trust = projectPackageTrust(cwd, "extensions");
	for (const { entry } of project) {
		if (trust.approvedIds.has(entry.id)) continue;
		entry.trustBlocked = true;
		// Under a trusted surface only a record nobody approved lands here, and a
		// disabled one is named too because it would otherwise shadow a user copy.
		if (entry.valid && entry.compatible && (entry.enabled || trust.verdict === "trusted")) {
			entry.diagnostics.push({
				type: "warning",
				message:
					trust.verdict === "trusted"
						? `project extension ${entry.id} is not approved for this workspace, so it neither loads nor shadows a user copy; review with pancode config trust extensions`
						: "project extensions are not trusted for this workspace and are not loaded; review with pancode config trust extensions",
				path: statePath("project", cwd),
			});
		}
	}
}

/**
 * Session-only additions the terminal applies on top of install state: dev
 * packages and muted ids. Nothing here is ever persisted.
 */
export interface ExtensionSessionOverlay {
	devRecords(): InstalledExtensionRecord[];
	muted(): ReadonlySet<string>;
}

/** The listing with plugin links unresolved: `pluginPrompts` and `pluginSource` stay unset. */
export function listExtensionRecords(
	cwd = process.cwd(),
	options: ExtensionListOptions = {},
	overlay?: ExtensionSessionOverlay,
): InstalledExtensionRecord[] {
	const scopes: ExtensionScope[] = options.scope ? [options.scope] : ["user", "project"];
	const records = scopes.flatMap((scope) => listScope(scope, cwd));
	blockUntrustedProjectExtensions(records, cwd);
	if (overlay && options.scope === undefined) records.push(...overlay.devRecords());
	const byId = new Map<string, InstalledExtensionRecord[]>();
	for (const record of records) {
		const entry = record.entry;
		const list = byId.get(entry.id) ?? [];
		list.push(record);
		byId.set(entry.id, list);
	}
	for (const group of byId.values()) {
		const winner = group
			.filter(
				(record) =>
					record.entry.valid && record.entry.compatible && !record.entry.trustBlocked && !record.entry.consentPending,
			)
			.sort((a, b) => scopeRank(a.entry.scope) - scopeRank(b.entry.scope))
			.at(-1);
		const muted = overlay?.muted().has(group[0]?.entry.id ?? "") === true;
		for (const record of group) {
			const entry = record.entry;
			entry.effective = record === winner;
			entry.loadable = entry.valid && entry.compatible && entry.enabled && entry.effective && !muted;
			if (muted && entry.effective) entry.muted = true;
			if (entry.valid && entry.compatible && !entry.trustBlocked && !entry.consentPending && !entry.effective && winner) {
				entry.overriddenBy = winner.entry.scope;
			}
		}
	}
	// Invalid and incompatible packages remain visible by default so the load
	// refusal and its diagnostic cannot disappear with the capabilities it suppresses.
	const all =
		options.all === true
			? records
			: records.filter(
					({ entry }) => entry.effective || entry.trustBlocked || entry.consentPending || !entry.valid || !entry.compatible,
				);
	return all.sort((a, b) => {
		const id = a.entry.id.localeCompare(b.entry.id);
		if (id !== 0) return id;
		return scopeRank(a.entry.scope) - scopeRank(b.entry.scope);
	});
}

export function listExtensionEntries(cwd = process.cwd(), options: ExtensionListOptions = {}): InstalledExtension[] {
	return listExtensionRecords(cwd, options).map((record) => record.entry);
}
