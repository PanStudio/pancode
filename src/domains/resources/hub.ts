// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { readSettings, updateSettings } from "../../core/config.js";
import { type LifecycleContext, recordLifecycleReceipt } from "../../core/hub-receipts.js";
import { gitVia } from "../../core/internal-git-run.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { pancodeProjectRoot } from "../../core/project-root.js";
import { runCommandVector, type SafeCommandResult } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import {
	installExtension,
	loadManifestFromRoot,
	readExtensionInstallRecord,
	reviewExtensionEnvelope,
} from "../extensions/index.js";
import {
	bundledPluginCatalog,
	fetchPluginCommit,
	fetchPluginSource,
	githubOwnerOf,
	HUB_PUBLISHER_PATTERN,
	type PluginCatalogEntry,
	parsePluginGithubSource,
	pluginLocalPath,
	readPluginCatalog,
} from "../plugins/catalog.js";
import {
	installPlugin,
	type PluginExpectedState,
	type PluginMutationResult,
	type PluginScope,
	pluginContentDigest,
	readPluginInstallRecord,
} from "../plugins/index.js";
import { publisherCollision } from "../plugins/publisher.js";
import { hubEnvelopeDigest, hubMcpDigest } from "./hub-digests.js";
import {
	extensionHubCopy,
	hubPackageBaseDir,
	installedCopiesNamed,
	listInstalledHubPackages as listInstalledPlugins,
	readHubInstallRecord,
} from "./hub-packages.js";
import { packRevokedMessage, revokedHubDigests } from "./hub-revocations.js";
import { remoteIndexRows } from "./hub-trust.js";
import type { HubPackageEntry, HubRequirementRef } from "./hub-types.js";
import {
	bundledServerPackDir,
	type HubPackageValidationResult,
	isBundledServerPack,
	shippedServerPolicy,
	validateHubPackage,
} from "./hub-validation.js";
import { bareSkillRemedy, isBareSkillDirectory } from "./skills/bare-skill.js";

export type HubEntry = HubPackageEntry;

function validationReasons(candidate: HubPackageValidationResult): string {
	return [
		...new Set([
			...candidate.diagnostics.map((item) => item.message),
			...candidate.validation.diagnostics.map((item) => item.message),
		]),
	].join("; ");
}

export interface HubDiscoveryResult {
	entries: HubEntry[];
	diagnostics: string[];
	refusals: Readonly<Record<string, string>>;
}

function catalogPath(): string {
	const configured = readSettings().integrations.hub.catalog;
	return path.resolve(configured ?? path.join(pancodeConfigDir(), "hub.yaml"));
}

function projectCatalogPath(cwd: string = process.cwd()): string {
	return path.join(pancodeProjectRoot(cwd, "hub.yaml"), ".pancode", "hub.yaml");
}

function parseCatalog(filePath: string, diagnostics: string[]): HubEntry[] {
	return readPluginCatalog(filePath, diagnostics).map((entry) => ({ ...entry, origin: "index" }));
}

/** Discovery retains damaged copies even when their provenance record cannot be read. */
function displayInstallRecord(id: string, options: HubScopeOptions, diagnostics: string[], kind?: HubEntry["kind"]) {
	try {
		return readHubInstallRecord(id, options, kind);
	} catch (error) {
		const message = `pack state unavailable (${options.scope}:${id}): ${error instanceof Error ? error.message : String(error)}`;
		if (!diagnostics.includes(message)) diagnostics.push(message);
		return undefined;
	}
}

export function hubEntryRef(entry: Pick<HubEntry, "kind" | "name">): HubRequirementRef {
	return `${entry.kind}:${entry.name}`;
}

/**
 * The verified remote index's rows that may be offered. A first-party row names a tree under this package's
 * `hub/packs/`, so it is offered only when this release ships the same tree; otherwise the operator needs a newer
 * PanCode, and the bundled row stays.
 */
function offeredRemoteRows(bundled: ReadonlyArray<HubEntry>, diagnostics: string[]): HubEntry[] {
	const { rows } = remoteIndexRows(diagnostics, { packsRoot: path.join(resolvePackageRoot(), "hub") });
	return rows.filter((row) => {
		if (row.source) return true;
		const shipped = bundled.find((entry) => entry.kind === row.kind && entry.name === row.name);
		if (shipped?.sha256 === row.sha256) return true;
		diagnostics.push(`update PanCode for ${row.name} ${row.version ?? ""}`.trimEnd());
		return false;
	});
}

/** Who answers for a package: the row's publisher, else the GitHub owner of its source, else local. */
export function hubEntryPublisher(entry: Pick<HubEntry, "publisher" | "sourceUrl" | "source">): string {
	if (entry.publisher) return entry.publisher;
	const owner = entry.source
		? githubOwnerOf(entry.source.repo)
		: parsePluginGithubSource(entry.sourceUrl)?.owner.toLowerCase();
	return owner && HUB_PUBLISHER_PATTERN.test(owner) ? owner : "local";
}

export function discoverHub(options: { catalog?: string; cwd?: string } = {}): HubDiscoveryResult {
	const diagnostics: string[] = [];
	const bundledPlugins = bundledPluginCatalog(diagnostics);
	const remote = offeredRemoteRows(bundledPlugins, diagnostics);
	const privatePath = catalogPath();
	const primary = options.catalog ? parseCatalog(path.resolve(options.catalog), diagnostics) : [];
	const privateEntries = parseCatalog(privatePath, diagnostics);
	const byRef = new Map<string, HubEntry>();
	const revoked = revokedHubDigests();
	// The first-party core server rows: built into PanCode, so no other row may stand for them.
	const builtinServers = new Set(
		bundledPlugins
			.filter(
				(entry) =>
					entry.kind === "server" && entry.publisher === "pancode" && entry.tier === "core" && entry.source === undefined,
			)
			.map(hubEntryRef),
	);
	for (const entry of [
		...bundledPlugins,
		...remote,
		...privateEntries,
		...parseCatalog(projectCatalogPath(options.cwd), diagnostics),
		...primary,
	]) {
		if (builtinServers.has(hubEntryRef(entry)) && !bundledPlugins.includes(entry)) {
			const message = `${hubEntryRef(entry)} is built into PanCode; a row from another index cannot replace it`;
			if (!diagnostics.includes(message)) diagnostics.push(message);
			continue;
		}
		const revocation = entry.sha256 ? revoked.get(entry.sha256) : undefined;
		if (revocation) {
			const message = `${packRevokedMessage(entry.name, revocation)}; not offered`;
			if (!diagnostics.includes(message)) diagnostics.push(message);
			byRef.delete(hubEntryRef(entry));
			continue;
		}
		byRef.set(hubEntryRef(entry), entry);
	}
	for (const plugin of listInstalledPlugins(options.cwd ?? process.cwd(), { all: true })) {
		const ref = `${plugin.kind ?? "plugin"}:${plugin.id}`;
		if (byRef.has(ref)) continue;
		const record = displayInstallRecord(
			plugin.id,
			{ ...(options.cwd ? { cwd: options.cwd } : {}), scope: plugin.scope },
			diagnostics,
			plugin.kind,
		);
		byRef.set(ref, {
			kind: plugin.kind ?? "plugin",
			name: plugin.id,
			version: plugin.version,
			description: plugin.description,
			sourceUrl: record?.source ?? plugin.rootPath,
			origin: "installed",
			...(plugin.plugin ? { plugin: plugin.plugin } : {}),
		});
	}
	const refusals: Record<string, string> = {};
	const entries = [...byRef.values()];
	for (const entry of entries) {
		try {
			resolveHubRequirements(entry, [...byRef.values()]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			refusals[hubEntryRef(entry)] = message;
			if (!diagnostics.includes(message)) diagnostics.push(message);
		}
	}
	return {
		entries: entries.sort((a, b) => hubEntryRef(a).localeCompare(hubEntryRef(b))),
		diagnostics,
		refusals,
	};
}

const REQUIREMENT_PATTERN = /^(skill|agent|prompt|playbook|plugin|extension):([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function resolveHubRequirements(entry: HubEntry, catalog: ReadonlyArray<HubEntry>): HubEntry[] {
	const byRef = new Map(catalog.map((item) => [hubEntryRef(item), item]));
	const ordered: HubEntry[] = [];
	const visiting: string[] = [];
	const visited = new Set<string>();
	const visit = (current: HubEntry): void => {
		const currentRef = hubEntryRef(current);
		if (visited.has(currentRef)) return;
		const cycleAt = visiting.indexOf(currentRef);
		if (cycleAt >= 0) throw new Error(`hub_requirement_cycle: ${[...visiting.slice(cycleAt), currentRef].join(" -> ")}`);
		visiting.push(currentRef);
		for (const requirement of current.requires ?? []) {
			if (!REQUIREMENT_PATTERN.test(requirement)) throw new Error("hub_requirement_malformed");
			const dependency = byRef.get(requirement);
			if (!dependency) throw new Error(`hub_requirement_missing: ${requirement}`);
			visit(dependency);
		}
		visiting.pop();
		visited.add(currentRef);
		ordered.push(current);
	};
	visit(entry);
	return ordered;
}

export interface HubInstallPlan {
	entry: HubEntry;
	path: string;
	sha256: string;
	/** Plugin source retained until acceptance; release a cancelled plan. */
	sourceRoot?: string;
	cleanup?: () => void;
	cwd?: string;
	scope?: PluginScope;
	force?: boolean;
	/** Receipt attribution for installs the operator did not start, such as the upgrade conversion. */
	lifecycle?: LifecycleContext;
	expectedInstalledDigest?: string;
	/** Reviewed facts rechecked inside the writer's lock. */
	expect?: PluginExpectedState;
	/**
	 * Extension only: the capability envelope digest the operator reviewed, or `null`
	 * when the reviewed package declared none. The writer refuses any other envelope.
	 */
	expectedEnvelopeDigest?: string | null;
	/** The exact commit a remote source was fetched at. */
	commit?: string;
}

export interface HubScopeOptions {
	cwd?: string;
	scope?: PluginScope;
}

/** Installed state remains addressable after its index entry is removed. */
export function resolveInstalledHubEntry(
	ref: string,
	options: HubScopeOptions = {},
): HubEntry & { scope: PluginScope } {
	const item = installedCopiesNamed(
		listInstalledPlugins(options.cwd ?? process.cwd(), { ...options, all: true }),
		ref,
	)[0];
	if (!item) throw new Error(`pack not installed: ${ref}`);
	const saved = readHubInstallRecord(item.id, { ...options, scope: item.scope }, item.kind);
	return {
		scope: item.scope,
		kind: item.kind ?? "plugin",
		name: item.id,
		description: item.description,
		version: item.version,
		sourceUrl: saved?.source ?? item.rootPath,
		origin: "installed",
		...(item.manifest?.pancode.requires ? { requires: item.manifest.pancode.requires } : {}),
	};
}

/** Register verified bytes in one scoped index without installing or enabling them. */
export function registerHubPackage(source: string, options: HubScopeOptions & { force?: boolean } = {}): HubEntry {
	const local = pluginLocalPath(source, options.cwd);
	if (!existsSync(local)) throw new Error(`no pack directory at ${local}`);
	if (isBareSkillDirectory(local)) throw new Error(bareSkillRemedy(local));
	const candidate = validateHubPackage(local);
	if (!candidate.valid || !candidate.manifest || !candidate.contentDigest) throw new Error(validationReasons(candidate));
	const manifest = candidate.manifest;
	if (manifest.pancode.kind === "server" && existsSync(path.join(local, "server.json")))
		throw new Error(`server:${manifest.name} is built into PanCode; only the bundled index names it`);
	const receiptEnvelopeDigest =
		manifest.pancode.kind === "extension" ? (reviewExtensionEnvelope(local)?.digest ?? null) : null;
	const serves = manifest.pancode.kind === "extension" ? loadManifestFromRoot(local).manifest?.plugin : undefined;
	const entry: HubEntry = {
		kind: manifest.pancode.kind ?? "plugin",
		name: manifest.name,
		description: manifest.description ?? "",
		...(manifest.version ? { version: manifest.version } : {}),
		sha256: candidate.contentDigest,
		sourceUrl: local,
		origin: "index",
		...(manifest.pancode.requires ? { requires: manifest.pancode.requires } : {}),
		...(serves ? { plugin: serves } : {}),
	};
	const file = options.scope === "project" ? projectCatalogPath(options.cwd) : catalogPath();
	withStateFileLockSync(file, () => {
		const diagnostics: string[] = [];
		const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
		const entries = readPluginCatalog(file, diagnostics);
		if (diagnostics.length) throw new Error(diagnostics.join("; "));
		const previous = entries.find((item) => item.name === entry.name);
		if (previous && !options.force)
			throw new Error(`pack already registered: ${entry.name}; use --force to replace its pin`);
		const next = [...entries.filter((item) => item.name !== entry.name), entry].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		if ((existsSync(file) ? readFileSync(file, "utf8") : undefined) !== before)
			throw new Error("PanHub index changed during registration");
		safeResourceWrite(file, stringifyYaml({ entries: next.map(({ origin: _origin, index: _index, ...item }) => item) }), {
			encoding: "utf8",
		});
	});
	recordLifecycleReceipt({
		operation: "register",
		kind: entry.kind,
		id: entry.name,
		version: entry.version ?? null,
		contentDigest: entry.sha256 ?? null,
		envelopeDigest: receiptEnvelopeDigest,
		scope: options.scope ?? "user",
		source: local,
	});
	return entry;
}

/** One workspace view includes available packages and every installed scope. */
export function hubWorkspace(options: HubScopeOptions & { catalog?: string } = {}) {
	const discovery = discoverHub(options);
	const installed = listInstalledPlugins(options.cwd ?? process.cwd(), { ...options, all: true });
	return {
		...discovery,
		entries: discovery.entries.map((entry) => ({
			...entry,
			installed: installed
				.filter((item) => item.id === entry.name && (item.kind ?? "plugin") === entry.kind)
				.map((item) => ({
					...item,
					origin: displayInstallRecord(item.id, { ...options, scope: item.scope }, discovery.diagnostics, item.kind)?.origin,
				})),
		})),
	};
}

function installedPlugin(entry: Pick<HubEntry, "kind" | "name">, options: HubScopeOptions = {}) {
	return listInstalledPlugins(options.cwd ?? process.cwd(), {
		all: true,
		...(options.scope ? { scope: options.scope } : {}),
	})
		.filter((plugin) => plugin.id === entry.name && (plugin.kind ?? "plugin") === entry.kind)
		.sort((left, right) => Number(right.scope === "project") - Number(left.scope === "project"))[0];
}

export function hubInstallPath(entry: Pick<HubEntry, "kind" | "name">, options: HubScopeOptions = {}): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) throw new Error(`invalid PanHub entry name: ${entry.name}`);
	return (
		installedPlugin(entry, options)?.rootPath ??
		path.join(hubPackageBaseDir(entry.kind, options.scope ?? "user", options.cwd ?? process.cwd()), entry.name)
	);
}

export interface HubRequirementStatus {
	ordered: HubEntry[];
	satisfied: HubEntry[];
	unsatisfied: HubEntry[];
	/** Installed dependencies requiring explicit enable or repair before use. */
	inactive?: HubEntry[];
}

/**
 * Whether this entry has an installed copy, including disabled or damaged copies.
 * Requirement checks separately require a verified, loadable copy.
 */
export function hubEntryInstalled(entry: Pick<HubEntry, "kind" | "name">, options: HubScopeOptions = {}): boolean {
	return installedPlugin(entry, options) !== undefined;
}

/**
 * The pin recorded for this entry, or undefined when nothing pinned it. A
 * destination can exist without a pin, which is why this is a separate question
 * from `hubEntryInstalled`.
 */
export function hubEntryPin(
	entry: Pick<HubEntry, "kind" | "name">,
	options: HubScopeOptions = {},
): { sha256: string; sourceUrl: string } | undefined {
	const plugin = installedPlugin(entry, options);
	if (!plugin) return undefined;
	const record = displayInstallRecord(entry.name, { ...options, scope: plugin.scope }, [], entry.kind);
	return record ? { sha256: record.contentDigest, sourceUrl: record.source } : undefined;
}

export function classifyHubRequirements(
	entry: HubEntry,
	catalog: ReadonlyArray<HubEntry>,
	options: HubScopeOptions = {},
): HubRequirementStatus {
	const ordered = resolveHubRequirements(entry, catalog).slice(0, -1);
	const inactive = ordered.filter(
		(requirement) =>
			hubEntryInstalled(requirement, options) &&
			!listInstalledPlugins(options.cwd ?? process.cwd(), options).some(
				(plugin) => plugin.id === requirement.name && (plugin.kind ?? "plugin") === requirement.kind && plugin.loadable,
			),
	);
	const inactiveRefs = new Set(inactive.map(hubEntryRef));
	const satisfied = ordered.filter(
		(requirement) => hubEntryInstalled(requirement, options) && !inactiveRefs.has(hubEntryRef(requirement)),
	);
	const satisfiedRefs = new Set(satisfied.map(hubEntryRef));
	return {
		ordered,
		satisfied,
		...(inactive.length ? { inactive } : {}),
		unsatisfied: ordered.filter((requirement) => !satisfiedRefs.has(hubEntryRef(requirement))),
	};
}

export function planHubInstall(
	entry: HubEntry,
	options: { cwd?: string; scope?: PluginScope; force?: boolean; lifecycle?: LifecycleContext } = {},
): HubInstallPlan {
	// Refuse a publisher collision before any network fetch; the state write checks again under its lock.
	const cwd = options.cwd ?? process.cwd();
	const collision = publisherCollision(
		entry.name,
		hubEntryPublisher(entry),
		(["user", "project"] as const).flatMap((scope) => {
			const copy =
				entry.kind === "extension"
					? readExtensionInstallRecord(entry.name, { cwd, scope })
					: readPluginInstallRecord(entry.name, { cwd, scope });
			const sameNamespace = entry.kind === "extension" || !copy || !("kind" in copy) || copy.kind !== "extension";
			return copy && sameNamespace ? [{ scope, publisher: copy.publisher }] : [];
		}),
	);
	if (collision) throw new Error(collision);
	const fetched = entry.source
		? fetchPluginCommit(entry.source, entry.sha256)
		: fetchPluginSource(entry.sourceUrl, options.cwd);
	try {
		const candidate = validateHubPackage(fetched.root);
		if (!candidate.valid || !candidate.manifest) throw new Error(`invalid plugin: ${validationReasons(candidate)}`);
		if ((candidate.manifest.pancode.kind ?? "plugin") !== entry.kind)
			throw new Error(`pack kind mismatch: expected ${entry.kind}`);
		if (candidate.manifest.name !== entry.name)
			throw new Error(`plugin identity mismatch: expected ${entry.name}, found ${candidate.manifest.name}`);
		if (
			entry.kind === "server" &&
			existsSync(path.join(fetched.root, "server.json")) &&
			!isBundledServerPack(fetched.root, entry.name)
		)
			throw new Error(`server:${entry.name} is built into PanCode; only its bundled pack can supply it`);
		if (entry.version && candidate.manifest.version !== entry.version)
			throw new Error(`plugin version mismatch: expected ${entry.version}, found ${candidate.manifest.version}`);
		const declaredRequirements = candidate.manifest.pancode.requires ?? [];
		if (JSON.stringify([...declaredRequirements].sort()) !== JSON.stringify([...(entry.requires ?? [])].sort()))
			throw new Error(`hub_requirement_mismatch: ${entry.name}; index and manifest must declare the same requirements`);
		const sha256 = pluginContentDigest(fetched.root);
		if (entry.sha256 && sha256 !== entry.sha256) throw new Error(`plugin_pin_mismatch: ${entry.name}`);
		const revocation = revokedHubDigests().get(sha256);
		if (revocation) throw new Error(packRevokedMessage(entry.name, revocation));
		// A row from PanCode's own indexes (it has a tier) pins both review digests, absent included.
		const reviewed = entry.tier !== undefined;
		if (
			entry.kind === "extension" &&
			(reviewed || entry.envelopeDigest !== undefined) &&
			hubEnvelopeDigest(fetched.root) !== entry.envelopeDigest
		)
			throw new Error(`hub_envelope_mismatch: ${entry.name}`);
		if (reviewed || entry.mcpDigest !== undefined) {
			let mcp: string | undefined;
			try {
				mcp = hubMcpDigest(fetched.root, sha256);
			} catch (err) {
				throw new Error(`hub_mcp_mismatch: ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (mcp !== entry.mcpDigest) throw new Error(`hub_mcp_mismatch: ${entry.name}`);
		}
		return {
			entry: { ...entry, ...(candidate.manifest.version ? { version: candidate.manifest.version } : {}) },
			path: path.join(hubPackageBaseDir(entry.kind, options.scope ?? "user", options.cwd ?? process.cwd()), entry.name),
			sha256,
			sourceRoot: fetched.root,
			cleanup: fetched.cleanup,
			...(fetched.commit ? { commit: fetched.commit } : {}),
			...options,
		};
	} catch (error) {
		fetched.cleanup();
		throw error;
	}
}

export function releaseHubPlan(plan: HubInstallPlan): void {
	plan.cleanup?.();
}

/** All surfaces commit the reviewed digest, including every bundle asset. */
export interface HubInstallResult {
	recovery?: { stateBackup?: string; packageBackup?: string };
	/** The content digest the install wrote into its record. */
	contentDigest?: string;
}

/**
 * Commit a staged plan through the package writer without releasing it. The
 * destination digest reviewed before the lock is also rechecked inside it when
 * the plan carries `expect`. Returns the writer's structured result.
 */
export function commitHubInstallPlan(plan: HubInstallPlan): PluginMutationResult {
	if (existsSync(plan.path) && !plan.force) throw new Error(`PanHub destination already exists: ${plan.path}`);
	if (!plan.sourceRoot) throw new Error("plugin install plan has no staged source");
	if (plan.expectedInstalledDigest && pluginContentDigest(plan.path) !== plan.expectedInstalledDigest)
		throw new Error(`plugin_destination_changed: ${plan.entry.name}`);
	const expect: PluginExpectedState | undefined =
		plan.expect ??
		(plan.expectedInstalledDigest
			? {
					copies: [
						{
							scope: plan.scope ?? "user",
							id: plan.entry.name,
							partial: true,
							recorded: true,
							tree: plan.expectedInstalledDigest,
						},
					],
				}
			: undefined);
	if (plan.entry.kind === "extension") {
		const result = installExtension(plan.sourceRoot, {
			...(plan.cwd ? { cwd: plan.cwd } : {}),
			...(plan.lifecycle ? { lifecycle: plan.lifecycle } : {}),
			scope: plan.scope ?? "user",
			force: plan.force ?? false,
			expectedDigest: plan.sha256,
			expectedId: plan.entry.name,
			...(plan.entry.version ? { expectedVersion: plan.entry.version } : {}),
			...(plan.expectedEnvelopeDigest !== undefined ? { expectedEnvelopeDigest: plan.expectedEnvelopeDigest } : {}),
			// The staged root is a working copy; the record keeps the catalog or local source an update resolves.
			source: plan.entry.sourceUrl,
			origin: hubPlanOrigin(plan),
			publisher: hubEntryPublisher(plan.entry),
		});
		return { ...result, ...(result.extension ? { plugin: extensionHubCopy(result.extension) } : {}) };
	}
	return installPlugin(plan.sourceRoot, {
		...(plan.cwd ? { cwd: plan.cwd } : {}),
		...(plan.lifecycle ? { lifecycle: plan.lifecycle } : {}),
		scope: plan.scope ?? "user",
		force: plan.force ?? false,
		expectedDigest: plan.sha256,
		expectedId: plan.entry.name,
		expectedKind: plan.entry.kind,
		...(plan.entry.version ? { expectedVersion: plan.entry.version } : {}),
		...(expect ? { expect } : {}),
		origin: hubPlanOrigin(plan),
		publisher: hubEntryPublisher(plan.entry),
		...(plan.entry.kind === "server" && plan.entry.tier ? { tier: plan.entry.tier } : {}),
		// The tier is honoured only on rows from PanCode's own indexes; other rows keep the writer's default.
		...(plan.entry.tier ? { trust: plan.entry.tier === "listed" ? ("foreign" as const) : ("trusted" as const) } : {}),
	});
}

function hubPlanOrigin(plan: HubInstallPlan): {
	kind: "catalog" | "github" | "local";
	source: string;
	commit?: string;
} {
	return {
		kind:
			plan.entry.origin === "catalog" || plan.entry.origin === "index"
				? "catalog"
				: parsePluginGithubSource(plan.entry.sourceUrl)
					? "github"
					: "local",
		source: plan.entry.sourceUrl,
		...(plan.commit ? { commit: plan.commit } : {}),
	};
}

export function installHubPlan(plan: HubInstallPlan): HubInstallResult {
	let recovery: HubInstallResult["recovery"];
	try {
		const result = commitHubInstallPlan(plan);
		if (!result.plugin || result.diagnostics.some((item) => item.type === "error"))
			throw new Error(
				`${result.diagnostics.map((item) => item.message).join("; ") || "plugin install failed"}${result.recovery ? `; recovery: ${JSON.stringify(result.recovery)}` : ""}`,
			);
		recovery = result.recovery;
		return {
			...(recovery ? { recovery } : {}),
			...(result.contentDigest !== undefined ? { contentDigest: result.contentDigest } : {}),
		};
	} finally {
		releaseHubPlan(plan);
	}
}

/** Existing paths beat catalog IDs, including a directory named like a curated plugin. */
export function resolveHubPackage(
	source: string,
	options: { cwd?: string; catalog?: string; catalogOnly?: boolean } = {},
): PluginCatalogEntry {
	const local = pluginLocalPath(source, options.cwd);
	if (!options.catalogOnly && existsSync(local)) {
		if (isBareSkillDirectory(local)) throw new Error(bareSkillRemedy(local));
		const candidate = validateHubPackage(local);
		if (!candidate.valid || !candidate.manifest) throw new Error(`invalid plugin: ${validationReasons(candidate)}`);
		const serves =
			candidate.manifest.pancode.kind === "extension" ? loadManifestFromRoot(local).manifest?.plugin : undefined;
		return {
			kind: candidate.manifest.pancode.kind ?? "plugin",
			name: candidate.manifest.name,
			...(candidate.manifest.pancode.requires ? { requires: candidate.manifest.pancode.requires } : {}),
			...(serves ? { plugin: serves } : {}),
			description: candidate.manifest.description ?? "",
			...(candidate.manifest.version ? { version: candidate.manifest.version } : {}),
			sourceUrl: local,
			origin: "installed",
		};
	}
	const matches = discoverHub(options).entries.filter(
		(item) =>
			(!options.catalogOnly || item.origin !== "installed") &&
			(source.includes(":") ? hubEntryRef(item) === source : item.name === source),
	);
	if (matches.length > 1) {
		const refs = [...new Set(matches.map(hubEntryRef))].sort();
		throw new Error(`ambiguous pack: ${source}; use ${refs.join(" or ")}`);
	}
	const entry = matches[0];
	if (entry) return entry;
	if (parsePluginGithubSource(source))
		throw new Error("remote plugin installation requires a catalog entry with version and full-tree sha256 pin");
	throw new Error(`${source} is not a PanHub pack or a local pack directory; find the name with \`pancode hub search\``);
}

/**
 * A server PanCode carries: its bundled row and the shipped policy its pack holds. It has no installed copy.
 * `damaged` says why the pack's `server.json` cannot be described, and then `tools` and `environment` are empty;
 * `revoked` is the revocation of the row's digest.
 */
export interface BuiltinHubServer {
	ref: HubRequirementRef;
	id: string;
	version: string;
	title: string;
	tools: Array<{ name: string; actionClass: string }>;
	environment: string[];
	entry: HubEntry;
	damaged?: string;
	revoked?: string;
}

/**
 * Whether a row is the canonical bundled core row of a server PanCode carries. The row decides it, so a pack that is
 * damaged or missing stays built in and is reported rather than offered for install.
 */
export function isBuiltinServerRow(entry: HubEntry): boolean {
	return (
		entry.kind === "server" &&
		entry.publisher === "pancode" &&
		entry.tier === "core" &&
		entry.source === undefined &&
		path.resolve(entry.sourceUrl) === bundledServerPackDir(entry.name)
	);
}

/** Why the bundled pack of a built-in server row cannot be described, or undefined when it matches its pin. */
function builtinServerDamage(entry: HubEntry): string | undefined {
	const root = bundledServerPackDir(entry.name);
	if (!existsSync(root)) return `${root} is missing`;
	const candidate = validateHubPackage(root);
	if (!candidate.valid || !candidate.manifest) return `invalid pack: ${validationReasons(candidate)}`;
	if ((candidate.manifest.pancode.kind ?? "plugin") !== "server" || candidate.manifest.name !== entry.name)
		return `${root} is not the pack of server:${entry.name}`;
	if (entry.sha256 && pluginContentDigest(root) !== entry.sha256)
		return `plugin_pin_mismatch: ${entry.name}; ${root} differs from the row's pinned digest`;
	const policy = shippedServerPolicy(root, entry.name);
	return typeof policy === "string" ? policy : undefined;
}

/** The server a canonical built-in row names, with its shipped policy or why its pack cannot supply one. */
export function builtinHubServer(entry: HubEntry): BuiltinHubServer | undefined {
	if (!isBuiltinServerRow(entry)) return undefined;
	const damaged = builtinServerDamage(entry);
	const policy = damaged ?? shippedServerPolicy(bundledServerPackDir(entry.name), entry.name);
	const revocation = entry.sha256 ? revokedHubDigests().get(entry.sha256) : undefined;
	return {
		ref: hubEntryRef(entry),
		id: entry.name,
		version: typeof policy === "string" ? (entry.version ?? "") : policy.version,
		title: typeof policy === "string" ? entry.name : policy.title,
		tools: typeof policy === "string" ? [] : policy.tools,
		environment: typeof policy === "string" ? [] : policy.environment,
		entry,
		...(typeof policy === "string" ? { damaged: policy } : {}),
		...(revocation ? { revoked: packRevokedMessage(entry.name, revocation) } : {}),
	};
}

/**
 * The built-in server a lifecycle reference names: `server:<id>`, a bare id no other pack shares, or the bundled
 * pack directory itself, however the caller spells its path. Anything else is left to the ordinary resolver.
 */
export function builtinHubServerFor(
	source: string,
	options: { cwd?: string; catalog?: string } = {},
): BuiltinHubServer | undefined {
	const rows = bundledPluginCatalog([]).filter(isBuiltinServerRow);
	const local = pluginLocalPath(source, options.cwd);
	if (existsSync(local)) {
		const row = rows.find((entry) => isBundledServerPack(local, entry.name));
		return row ? builtinHubServer(row) : undefined;
	}
	const [kind, name] = source.includes(":") ? source.split(/:(.*)/su, 2) : [undefined, source];
	if (kind !== undefined && kind !== "server") return undefined;
	const row = rows.find((entry) => entry.name === name);
	if (!row) return undefined;
	if (
		kind === undefined &&
		!discoverHub(options).entries.every((item) => item.name !== name || hubEntryRef(item) === hubEntryRef(row))
	)
		return undefined;
	return builtinHubServer(row);
}

export function planHubUpdate(
	id: string,
	options: { cwd?: string; scope?: PluginScope; force?: boolean; catalog?: string } = {},
): HubInstallPlan {
	const identity = resolveInstalledHubEntry(id, options);
	const plugin = installedPlugin(identity, options);
	if (!plugin) throw new Error(`plugin not installed: ${id}`);
	const pin = hubEntryPin(identity, { ...options, scope: plugin.scope });
	if (!options.force && pin && pluginContentDigest(plugin.rootPath) !== pin.sha256)
		throw new Error(`plugin_local_changes: ${id}; use --force to replace local changes`);
	const record = readHubInstallRecord(identity.name, { ...options, scope: plugin.scope }, identity.kind);
	if (typeof record?.origin === "object" && record.origin.kind === "interop")
		throw new Error("interop packs require a new reviewed adoption; remove the installed copy and adopt it again");
	const catalogOrigin = record?.origin && typeof record.origin === "object" && record.origin.kind === "catalog";
	const discovery = discoverHub(options);
	const catalog = catalogOrigin
		? discovery.entries.find(
				(entry) => entry.kind === identity.kind && entry.name === identity.name && entry.origin !== "installed",
			)
		: undefined;
	if (catalogOrigin && !catalog) {
		throw new Error(
			`plugin catalog source unavailable: ${id}; restore its pinned catalog entry or explicitly install a new source`,
		);
	}
	const entry = catalog ?? (pin ? resolveHubPackage(pin.sourceUrl, options) : undefined);
	if (!entry) throw new Error(`plugin has no update source: ${id}`);
	if (entry.name !== identity.name || entry.kind !== identity.kind)
		throw new Error(`pack identity mismatch: expected ${id}, found ${hubEntryRef(entry)}`);
	const requirements = classifyHubRequirements(entry, discovery.entries, options);
	if (requirements.inactive?.length)
		throw new Error(
			`hub_requirement_inactive: ${requirements.inactive.map(hubEntryRef).join(", ")}; enable or repair these plugins explicitly`,
		);
	if (requirements.unsatisfied.length)
		throw new Error(
			`hub_requirement_missing: ${requirements.unsatisfied.map(hubEntryRef).join(", ")}; install required resources before updating`,
		);
	const plan = planHubInstall(entry, { ...options, scope: plugin.scope, force: true });
	if (!options.force) plan.expectedInstalledDigest = pluginContentDigest(plugin.rootPath);
	return plan;
}

export function pinHubEntry(entry: HubEntry, options: HubScopeOptions = {}): { sha256: string; sourceUrl: string } {
	const installed = hubInstallPath(entry, options);
	const pin = hubEntryPin(entry, options);
	if (!pin) throw new Error(`plugin is not installed with a verified pin: ${entry.name}`);
	if (pluginContentDigest(installed) !== pin.sha256)
		throw new Error(`plugin_local_changes: ${entry.name}; reinstall explicitly to accept changed content`);
	return pin;
}

export function hubEntryDrift(
	entry: Pick<HubEntry, "kind" | "name">,
	options: HubScopeOptions = {},
): { status: "clean" | "changed" | "missing" | "unpinned"; expected?: string; observed?: string } {
	const installed = hubInstallPath(entry, options);
	if (!existsSync(installed)) return { status: "missing" };
	const pin = hubEntryPin(entry, options);
	if (!pin) return { status: "unpinned" };
	const observed = pluginContentDigest(installed);
	return { status: observed === pin.sha256 ? "clean" : "changed", expected: pin.sha256, observed };
}

const UNCONFIRMED_REMOTE =
	"hub_remote_unconfirmed: the Git remote named hub must exist beside the user index and match integrations.hub.remote; confirm it with pancode hub remote confirm <url>";

function confirmedRemote(): string {
	const settings = readSettings().integrations.hub;
	if (!settings.remote || settings.remote !== settings.confirmedRemote) throw new Error(UNCONFIRMED_REMOTE);
	return settings.remote;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Why a Git remote URL cannot be confirmed, or undefined when it can. */
function hubRemoteProblem(url: string): string | undefined {
	if (url === "" || url !== url.trim() || /[\s\p{Cc}]/u.test(url)) return "it is empty or contains whitespace";
	if (url.startsWith("-")) return "it starts with -";
	if (/^[A-Za-z][A-Za-z0-9+.-]*::/u.test(url)) return "Git transport helpers (<transport>::<address>) are not accepted";
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(url)) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return "it is not a valid URL";
		}
		if (parsed.password || (parsed.username && parsed.protocol !== "ssh:")) return "it must not carry credentials";
		if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname))
			return "plaintext http:// is accepted only for 127.0.0.1, [::1] or localhost; use https:// or ssh://";
		if (!["https:", "ssh:", "file:", "http:"].includes(parsed.protocol))
			return `${parsed.protocol}// is not accepted; use https://, ssh://, file:// or user@host:path`;
		return undefined;
	}
	if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\\]/u.test(url)) return undefined;
	if (path.isAbsolute(url)) return undefined;
	return "it is not an https://, ssh:// or file:// URL, a user@host:path address or an absolute path";
}

/** Records `url` as the confirmed PanHub Git remote, and as the remote itself when none is set; returns the URL. */
export function confirmHubRemote(url: string): string {
	const problem = hubRemoteProblem(url);
	if (problem) throw new Error(`hub_remote_invalid: ${JSON.stringify(url)} cannot be a PanHub remote; ${problem}`);
	const current = readSettings().integrations.hub.remote;
	if (current !== null && current !== url)
		throw new Error(
			`hub_remote_mismatch: integrations.hub.remote is ${current}, not ${url}; confirm ${current}, or change it first with pancode config set integrations.hub.remote <url>`,
		);
	updateSettings((settings) => {
		if (settings.integrations.hub.remote === null) settings.integrations.hub.remote = url;
		settings.integrations.hub.confirmedRemote = url;
	});
	return url;
}

export type HubCommandRunner = (
	file: string,
	args: ReadonlyArray<string>,
	options: { cwd: string; workspaceRoot: string },
) => Promise<SafeCommandResult>;

export async function syncHub(direction: "sync" | "push", runner: HubCommandRunner = runCommandVector): Promise<void> {
	const settings = readSettings().integrations.hub;
	if (!settings.sync)
		throw new Error(
			"hub_sync_disabled: PanHub Git sync is off by default; turn it on with pancode config set integrations.hub.sync true, add a Git remote named hub beside the user index, and confirm it with pancode hub remote confirm <url>",
		);
	const remote = confirmedRemote();
	const cwd = path.dirname(catalogPath());
	const remoteResult = await gitVia(runner, ["remote", "get-url", "hub"], {
		cwd,
		workspaceRoot: cwd,
	});
	if (remoteResult.exitCode !== 0 || remoteResult.stdout.trim() !== remote) throw new Error(UNCONFIRMED_REMOTE);
	if (direction === "sync") {
		const fetched = await gitVia(runner, ["fetch", "hub"], { cwd, workspaceRoot: cwd });
		if (fetched.exitCode !== 0) throw new Error(fetched.stderr.trim() || "hub sync failed");
		const advanced = await gitVia(runner, ["merge", "--ff-only", "FETCH_HEAD"], {
			cwd,
			workspaceRoot: cwd,
		});
		if (advanced.exitCode !== 0) throw new Error(advanced.stderr.trim() || "hub sync failed");
		return;
	}
	const result = await gitVia(runner, ["push", "hub"], { cwd, workspaceRoot: cwd });
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `hub ${direction} failed`);
}
