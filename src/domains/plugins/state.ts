// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	closeSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { recordLifecycleReceipt } from "../../core/hub-receipts.js";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { isRecord } from "../../core/type-guards.js";
import { projectPackageTrust } from "../../core/workspace-trust.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import { evaluatePancodeCompatibility } from "../extensions/compatibility.js";
import {
	assertManagedBase,
	assertUnchangedInstallState,
	auditInstallRecords,
	type DroppedInstallRecord,
	type InstallRecordReport,
	type InstallStateLayout,
	installStatePath,
	readInstallState,
	retainRecovery,
	uniqueSibling,
	writeInstallState,
} from "../extensions/install-store.js";
import { packRevokedMessage, revokedHubDigests } from "../resources/hub-revocations.js";
import type { HubEntryKind, HubRequirementRef } from "../resources/hub-types.js";
import { HUB_TIERS, isHubKind } from "../resources/hub-types.js";
import { isPluginId, readPluginManifest } from "./discovery.js";
import { passPluginCandidate } from "./discovery-pass.js";
import { pluginContentDigest } from "./integrity.js";
import { pluginBaseDir, pluginDataDir } from "./paths.js";
import { derivedPublisher, publisherCollision, readPublisher } from "./publisher.js";
import type {
	HubPackageInstallInput,
	InstalledPlugin,
	PluginDiagnostic,
	PluginDiagnosticCode,
	PluginExpectedCopy,
	PluginExpectedState,
	PluginInstallOptions,
	PluginInstallRecord,
	PluginListOptions,
	PluginMutationOptions,
	PluginMutationResult,
	PluginScope,
} from "./types.js";
import { isForeignPluginOrigin } from "./types.js";
import { verifiedPluginCandidate } from "./verified-tree.js";

/** sourcePath is a prepared package root containing plugin.json for the declared kind. */
export function installHubPackage(input: HubPackageInstallInput): PluginMutationResult {
	const { kind, sourcePath, ...options } = input;
	return installPlugin(sourcePath, { ...options, expectedKind: kind });
}

export { pluginBaseDir } from "./paths.js";

const PLUGIN_STATE: InstallStateLayout<PluginInstallRecord> = {
	noun: "plugin",
	dir: "plugins",
	baseDir: pluginBaseDir,
	readRecord: readInstallRecord,
	packRef: (id, raw) => `${isRecord(raw) && isHubKind(raw.kind) ? raw.kind : "plugin"}:${id}`,
	isId: isPluginId,
};

export function pluginStatePath(scope: PluginScope, cwd = process.cwd()): string {
	return installStatePath(PLUGIN_STATE, scope, cwd);
}

/** Throws the reason one stored record is refused. */
function readInstallRecord(id: string, entry: unknown): PluginInstallRecord {
	if (!isPluginId(id)) throw new Error("the id is not a valid package id");
	if (!isRecord(entry)) throw new Error("the record must be an object");
	if (typeof entry.installedAt !== "string") throw new Error("installedAt must be a string");
	if (typeof entry.source !== "string") throw new Error("source must be a string");
	if (typeof entry.contentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(entry.contentDigest))
		throw new Error("contentDigest must be a SHA-256 digest");
	if (entry.origin !== undefined && typeof entry.origin !== "string" && !validOrigin(entry.origin))
		throw new Error("origin is not a valid origin");
	if (entry.kind !== undefined && !isHubKind(entry.kind)) throw new Error("kind is not a pack kind");
	if (entry.kind === "server" && entry.tier !== null && !HUB_TIERS.some((tier) => tier === entry.tier))
		throw new Error("a server record requires its catalog tier, or null for an untiered source");
	if (entry.trust !== undefined && entry.trust !== "trusted" && entry.trust !== "foreign")
		throw new Error("trust must be trusted or foreign");
	readPublisher(entry.publisher);
	return entry as unknown as PluginInstallRecord;
}

/** Throws only when the file itself cannot be read; an invalid record is left out and named in `invalid`. */
function readState(scope: PluginScope, cwd: string) {
	const read = readInstallState(PLUGIN_STATE, scope, cwd);
	if (read.status === "corrupt") throw new Error(read.message);
	return read;
}

const FOREIGN_FORMATS = new Set(["portable", "claude-code", "codex", "agent-skill"]);
/** Persisted provenance is validated on every read so a hand-edited record cannot invent an origin. */
function validOrigin(origin: unknown): boolean {
	if (!isRecord(origin) || typeof origin.source !== "string") return false;
	if (origin.commit !== undefined && (typeof origin.commit !== "string" || !/^[a-f0-9]{40}$/u.test(origin.commit)))
		return false;
	const optional =
		(origin.marketplace === undefined || typeof origin.marketplace === "string") &&
		(origin.host === undefined || typeof origin.host === "string");
	switch (origin.kind) {
		case "local":
		case "catalog":
		case "github":
			return true;
		case "interop":
			return (
				typeof origin.host === "string" &&
				path.isAbsolute(origin.source) &&
				optional &&
				(origin.format === undefined || FOREIGN_FORMATS.has(String(origin.format)))
			);
		case "import":
			return (
				FOREIGN_FORMATS.has(String(origin.format)) &&
				optional &&
				((origin.transport === "local" && path.isAbsolute(origin.source)) ||
					(origin.transport === "github" && /^https:\/\/github\.com\//u.test(origin.source)))
			);
		default:
			return false;
	}
}

/** A writer refusal with a machine-readable reason; the message is what operators see. */
export class PluginWriterRefusal extends Error {
	constructor(
		readonly code: PluginDiagnosticCode,
		message: string,
		readonly changed?: {
			scope: PluginScope;
			id: string;
			fact: keyof PluginExpectedCopy;
			expected: unknown;
			observed: unknown;
		},
	) {
		super(message);
		this.name = "PluginWriterRefusal";
	}
}

function acquireScopeLock(scope: PluginScope, cwd: string): () => void {
	assertManagedBase(PLUGIN_STATE, scope, cwd);
	if (scope === "user") pancodeConfigDir();
	mkdirSync(pluginBaseDir(scope, cwd), { recursive: true });
	const lock = path.join(pluginBaseDir(scope, cwd), ".mutation.lock");
	let fd: number;
	try {
		fd = openSync(lock, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new PluginWriterRefusal("locked", "another plugin operation holds the installation lock");
		throw error;
	}
	return () => {
		closeSync(fd);
		rmSync(lock, { force: true });
	};
}

/**
 * Hold one scope's cooperative `.mutation.lock` around `fn`. Non-blocking: a
 * held lock throws a `locked` refusal immediately, so two holders can never
 * deadlock. A composer that reviewed peer-scope facts holds the peer lock here
 * and lets the writer take its own; the same scope must never be nested.
 */
export function withPluginScopeLock<T>(scope: PluginScope, cwd: string, fn: () => T): T {
	const release = acquireScopeLock(scope, cwd);
	try {
		return fn();
	} finally {
		release();
	}
}

function withMutation(scope: PluginScope, cwd: string, work: () => PluginMutationResult): PluginMutationResult {
	try {
		return withPluginScopeLock(scope, cwd, work);
	} catch (error) {
		return {
			diagnostics: [
				{
					type: "error",
					message: error instanceof Error ? error.message : String(error),
					...(error instanceof PluginWriterRefusal ? { code: error.code } : {}),
					...(error instanceof PluginWriterRefusal && error.changed ? { changed: error.changed } : {}),
				},
			],
		};
	}
}

/** Observe the facts a plan reviews for one copy. Throws when that scope's state cannot be read. */
export function observePluginCopy(scope: PluginScope, id: string, cwd: string): PluginExpectedCopy {
	const saved = readState(scope, cwd).state.installed[id];
	const target = path.join(pluginBaseDir(scope, cwd), id);
	let tree: string = "absent";
	if (existsSync(target)) {
		try {
			tree = pluginContentDigest(target);
		} catch {
			tree = "unreadable";
		}
	}
	return {
		scope,
		id,
		recorded: saved !== undefined,
		tree,
		enabled: !readState(scope, cwd).state.disabled.includes(id),
		...(saved ? { recordedDigest: saved.contentDigest } : {}),
		...(saved?.kind ? { kind: saved.kind } : {}),
		...(saved?.trust ? { trust: saved.trust } : {}),
		...(saved?.origin !== undefined ? { origin: saved.origin } : {}),
	};
}

/**
 * Recheck reviewed facts. Called inside the mutated scope's lock; peer-scope
 * facts are only as protected as the lock the composer holds for that scope.
 */
function assertExpectedState(expect: PluginExpectedState | undefined, cwd: string): void {
	for (const expected of expect?.copies ?? []) {
		let observed: PluginExpectedCopy;
		try {
			observed = observePluginCopy(expected.scope, expected.id, cwd);
		} catch (error) {
			throw new PluginWriterRefusal(
				"stale_plan",
				`reviewed state for ${expected.scope}:${expected.id} is no longer readable: ${error instanceof Error ? error.message : String(error)}; review a fresh plan`,
			);
		}
		// A reviewed snapshot is complete: a fact that appears or disappears
		// (absent origin becoming foreign, trust or kind recorded later) is a
		// change, so compare the union of both key sets.
		const facts = new Set(
			expected.partial ? Object.keys(expected) : [...Object.keys(expected), ...Object.keys(observed)],
		) as Set<keyof PluginExpectedCopy>;
		for (const fact of facts) {
			if (fact === "scope" || fact === "id" || fact === "partial") continue;
			const want = JSON.stringify(expected[fact] ?? null);
			const have = JSON.stringify(observed[fact] ?? null);
			if (want !== have)
				throw new PluginWriterRefusal(
					"stale_plan",
					`reviewed ${fact} changed for ${expected.scope}:${expected.id} (expected ${want}, observed ${have}); review a fresh plan`,
					{ scope: expected.scope, id: expected.id, fact, expected: expected[fact], observed: observed[fact] },
				);
		}
	}
}

/**
 * Plugin-format packages share one directory per scope, so their ids compete.
 * A standalone extension lives in its own directory and never competes with a
 * plugin of the same name.
 */
function packageNamespace(kind: HubEntryKind | undefined): "extension" | "plugin" {
	return kind === "extension" ? "extension" : "plugin";
}

/**
 * The one precedence rule: valid, compatible copies compete and project wins.
 * A project copy the operator has not approved sits out, so it neither loads
 * nor shadows a user copy. Copies compete only inside their own namespace.
 */
export function resolvePluginPrecedence(entries: InstalledPlugin[]): void {
	for (const entry of entries) {
		const winner = entries
			.filter(
				(peer) =>
					peer.id === entry.id &&
					packageNamespace(peer.kind) === packageNamespace(entry.kind) &&
					peer.valid &&
					peer.compatible &&
					!peer.trustBlocked,
			)
			.sort((a, b) => Number(a.scope === "project") - Number(b.scope === "project"))
			.at(-1);
		entry.effective = entry === winner;
		entry.loadable = entry.valid && entry.compatible && entry.enabled && entry.effective;
		delete entry.overriddenBy;
		if (winner && winner !== entry && !entry.trustBlocked) entry.overriddenBy = winner.scope;
	}
}

export interface PluginDependentBreak {
	ref: HubRequirementRef;
	scope: PluginScope;
	missing: HubRequirementRef[];
}

function unmetRequirementsOf(entry: InstalledPlugin, entries: ReadonlyArray<InstalledPlugin>): HubRequirementRef[] {
	return (entry.manifest?.pancode.requires ?? []).filter(
		(requirement) => !entries.some((peer) => peer.loadable && `${peer.kind ?? "plugin"}:${peer.id}` === requirement),
	);
}

/**
 * Project the effective set after exactly one disable or removal and report
 * enabled effective dependents that are satisfied now and would not be.
 * Pre-existing breakage is listed separately and never refuses.
 */
export function newlyBrokenDependents(
	entries: ReadonlyArray<InstalledPlugin>,
	mutation: { scope: PluginScope; id: string; operation: "disable" | "remove"; kind?: HubEntryKind },
): { newlyBroken: PluginDependentBreak[]; preexisting: PluginDependentBreak[]; effectiveAfter?: InstalledPlugin } {
	const namespace = packageNamespace(mutation.kind);
	const sameSlot = (entry: InstalledPlugin): boolean =>
		entry.id === mutation.id && entry.scope === mutation.scope && packageNamespace(entry.kind) === namespace;
	const before = entries.map((entry) => ({ ...entry }));
	resolvePluginPrecedence(before);
	const after = before
		.filter((entry) => !(mutation.operation === "remove" && sameSlot(entry)))
		.map((entry) => ({
			...entry,
			enabled: mutation.operation === "disable" && sameSlot(entry) ? false : entry.enabled,
		}));
	resolvePluginPrecedence(after);
	const newlyBroken: PluginDependentBreak[] = [];
	const preexisting: PluginDependentBreak[] = [];
	for (const entry of before) {
		if (sameSlot(entry)) continue;
		const later = after.find(
			(peer) =>
				peer.id === entry.id && peer.scope === entry.scope && packageNamespace(peer.kind) === packageNamespace(entry.kind),
		);
		if (!later?.loadable) continue;
		const missingBefore = entry.loadable ? unmetRequirementsOf(entry, before) : [];
		const missingAfter = unmetRequirementsOf(later, after);
		const ref: HubRequirementRef = `${entry.kind ?? "plugin"}:${entry.id}`;
		const fresh = missingAfter.filter((requirement) => !missingBefore.includes(requirement));
		if (fresh.length) newlyBroken.push({ ref, scope: entry.scope, missing: fresh });
		else if (missingAfter.length) preexisting.push({ ref, scope: entry.scope, missing: missingAfter });
	}
	const effectiveAfter = after.find(
		(entry) => entry.id === mutation.id && packageNamespace(entry.kind) === namespace && entry.effective,
	);
	return { newlyBroken, preexisting, ...(effectiveAfter ? { effectiveAfter } : {}) };
}

function refuseBrokenDependents(
	cwd: string,
	mutation: { scope: PluginScope; id: string; operation: "disable" | "remove" },
): void {
	const { newlyBroken } = newlyBrokenDependents(listInstalledPlugins(cwd, { all: true }), mutation);
	if (newlyBroken.length)
		throw new PluginWriterRefusal(
			"dependents",
			`${mutation.operation} of ${mutation.scope}:${mutation.id} would break ${newlyBroken
				.map((item) => `${item.scope}:${item.ref} (missing ${item.missing.join(", ")})`)
				.join("; ")}; disable or remove those dependents first`,
		);
}

function scopeEntries(scope: PluginScope, cwd: string, onlyId?: string): InstalledPlugin[] {
	const base = pluginBaseDir(scope, cwd);
	if (!existsSync(base)) return [];
	let names: string[];
	try {
		assertManagedBase(PLUGIN_STATE, scope, cwd);
		names = readdirSync(base)
			.sort()
			.filter((name) => isPluginId(name) && (onlyId === undefined || name === onlyId));
	} catch (error) {
		return [
			{
				id: `invalid-${scope}-plugin-root`,
				name: "Plugin installation directory",
				version: "0.0.0",
				description: "",
				scope,
				rootPath: base,
				manifestPath: pluginStatePath(scope, cwd),
				enabled: false,
				valid: false,
				compatible: true,
				effective: false,
				loadable: false,
				resources: {},
				diagnostics: [
					{
						type: "error",
						message: `plugin directory cannot be read: ${error instanceof Error ? error.message : String(error)}`,
						path: base,
					},
				],
			},
		];
	}
	const read = readInstallState(PLUGIN_STATE, scope, cwd);
	const { state } = read;
	const invalid = read.status === "corrupt" ? [] : read.invalid;
	const stateError = read.status === "corrupt" ? read.message : undefined;
	const entries: InstalledPlugin[] = [];
	const revoked = revokedHubDigests();
	for (const id of names) {
		const rootPath = path.join(base, id);
		const candidate = passPluginCandidate(rootPath, (root) => verifiedPluginCandidate(root, readPluginManifest));
		const manifest = candidate.manifest;
		const diagnostics = [...candidate.diagnostics];
		const saved = state.installed[id];
		if (manifest && manifest.name !== id)
			diagnostics.push({
				type: "error",
				message: `installed directory ${id} does not match plugin identity ${manifest.name}`,
				path: rootPath,
			});
		if (stateError)
			diagnostics.push({
				type: "error",
				message: `plugin install state cannot be read: ${stateError}`,
				path: pluginStatePath(scope, cwd),
			});
		else if (!saved) {
			const refused = invalid.find((entry) => entry.id === id);
			diagnostics.push(
				refused
					? {
							type: "error",
							message: `install record installed.${id} is invalid (${refused.reason}), so the package is not loaded; run \`pancode doctor --fix\` to drop it, then \`pancode hub install ${refused.pack}\``,
							path: pluginStatePath(scope, cwd),
						}
					: {
							type: "error",
							message: "plugin is not recorded in install state; install it through plugins install",
							path: rootPath,
						},
			);
		} else if (candidate.contentDigest !== saved.contentDigest)
			diagnostics.push({
				type: "error",
				message: `installed plugin content drift detected (expected ${saved.contentDigest}, observed ${candidate.contentDigest ?? "unreadable"})`,
				path: rootPath,
			});
		const range = manifest?.pancode.compatibility?.pancode;
		const compatible = range === undefined || evaluatePancodeCompatibility(range).satisfied;
		if (!compatible)
			diagnostics.push({
				type: "error",
				message: `plugin requires PanCode ${range}`,
				path: candidate.manifestPath ?? rootPath,
			});
		const revokedDigest = saved?.contentDigest ?? candidate.contentDigest;
		const revocation = revokedDigest ? revoked.get(revokedDigest) : undefined;
		if (revocation) diagnostics.push({ type: "error", message: packRevokedMessage(id, revocation), path: rootPath });
		const valid =
			candidate.valid &&
			!stateError &&
			!!saved &&
			candidate.contentDigest === saved.contentDigest &&
			manifest?.name === id &&
			!revocation;
		entries.push({
			id,
			kind: saved?.kind ?? manifest?.pancode.kind ?? "plugin",
			trust: saved?.trust ?? (isForeignPluginOrigin(saved?.origin) ? "foreign" : "trusted"),
			...(saved?.origin !== undefined ? { origin: saved.origin } : {}),
			name: manifest?.name ?? id,
			version: manifest?.version ?? "0.0.0",
			description: manifest?.description ?? "",
			scope,
			rootPath,
			manifestPath: candidate.manifestPath ?? path.join(rootPath, "plugin.json"),
			enabled: !state.disabled.includes(id),
			valid,
			compatible,
			effective: false,
			loadable: false,
			resources: manifest?.pancode.resources ?? {},
			...(manifest ? { manifest } : {}),
			diagnostics,
			...(candidate.contentDigest ? { observedContentDigest: candidate.contentDigest } : {}),
			...(valid && candidate.manifestDigest && saved
				? {
						provenance: {
							id,
							scope,
							sourcePath: saved.source,
							canonicalRoot: realpathSync(rootPath),
							manifestDigest: candidate.manifestDigest,
							contentDigest: saved.contentDigest,
						},
					}
				: {}),
		});
	}
	return entries;
}

/**
 * A project copy installs from the repository's own state, so its digest check
 * proves integrity and not consent. Workspace trust supplies the consent per
 * record: a copy the operator has not approved, enabled or disabled, neither
 * loads nor shadows a user copy, and user-scoped plugins are unaffected.
 */
function blockUntrustedProjectPlugins(entries: ReadonlyArray<InstalledPlugin>, cwd: string): void {
	const project = entries.filter((entry) => entry.scope === "project");
	if (project.length === 0) return;
	const trust = projectPackageTrust(cwd, "plugins");
	for (const entry of project) {
		if (trust.approvedIds.has(entry.id)) continue;
		entry.trustBlocked = true;
		// Under a trusted surface only a record nobody approved lands here, and a
		// disabled one is named too because it would otherwise shadow a user copy.
		if (entry.valid && entry.compatible && (entry.enabled || trust.verdict === "trusted")) {
			entry.diagnostics.push({
				type: "warning",
				message:
					trust.verdict === "trusted"
						? `project plugin ${entry.id} is not approved for this workspace, so it neither loads nor shadows a user copy; review with pancode config trust plugins, then run /reload hub`
						: "project plugins are not trusted for this workspace and are not loaded; review with pancode config trust plugins, then run /reload hub",
				path: pluginStatePath("project", cwd),
			});
		}
	}
}

/**
 * `id` reads only that plugin's copies. Precedence and workspace trust depend
 * on nothing but same-id peers and the scope, so its entries come out as in a
 * full listing while no other plugin tree is hashed.
 */
export function listInstalledPlugins(
	cwd = process.cwd(),
	options: PluginListOptions & { id?: string } = {},
): InstalledPlugin[] {
	const scopes: PluginScope[] = options.scope ? [options.scope] : ["user", "project"];
	const entries = scopes.flatMap((scope) => scopeEntries(scope, cwd, options.id));
	blockUntrustedProjectPlugins(entries, cwd);
	resolvePluginPrecedence(entries);
	return entries
		.filter((entry) => options.all || entry.effective || entry.trustBlocked || !entry.valid || !entry.compatible)
		.sort((a, b) => a.id.localeCompare(b.id) || a.scope.localeCompare(b.scope));
}

export function readPluginInstallRecord(id: string, options: PluginListOptions = {}): PluginInstallRecord | undefined {
	if (!isPluginId(id)) return undefined;
	const cwd = options.cwd ?? process.cwd();
	if (options.scope) return readState(options.scope, cwd).state.installed[id];
	return readState("project", cwd).state.installed[id] ?? readState("user", cwd).state.installed[id];
}

function selectedScope(id: string, options: PluginListOptions): PluginScope {
	if (options.scope) return options.scope;
	return existsSync(path.join(pluginBaseDir("project", options.cwd), id)) ? "project" : "user";
}

/** How many preserved copies of one package a scope keeps. */
const RECOVERY_COPIES_KEPT = 3;

/**
 * Keep only the newest preserved copies of one package. A recovery copy exists
 * because it held changes no pin could vouch for, so it is kept across runs, but
 * nothing else ever removes one and a package repaired over and over would pile
 * up full trees. Renaming a directory into place sets its ctime, which is why
 * that orders them: mtime still reads when the files last changed.
 */
function sweepRecoveryCopies(target: string): void {
	const base = path.dirname(target);
	const prefixes = ["removed", "backup"].map((purpose) => `.${path.basename(target)}.${purpose}-`);
	try {
		const copies = readdirSync(base)
			.filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
			.map((name) => ({ file: path.join(base, name), changed: lstatSync(path.join(base, name)).ctimeMs }))
			.sort((a, b) => b.changed - a.changed);
		for (const copy of copies.slice(RECOVERY_COPIES_KEPT)) rmSync(copy.file, { recursive: true, force: true });
	} catch {
		// The operation this follows has already committed; a copy left behind only costs disk.
	}
}

/** The other scope's record for `id`; an unreadable state contributes nothing here and fails its own reads. */
function readOtherScopeRecord(scope: PluginScope, cwd: string, id: string): PluginInstallRecord | undefined {
	try {
		return readState(scope, cwd).state.installed[id];
	} catch {
		return undefined;
	}
}

export function installPlugin(sourcePath: string, options: PluginInstallOptions = {}): PluginMutationResult {
	const cwd = options.cwd ?? process.cwd();
	const scope = options.scope ?? "user";
	const source = path.resolve(cwd, sourcePath);
	const candidate = readPluginManifest(source);
	if (!candidate.valid || !candidate.manifest || !candidate.contentDigest) return { diagnostics: candidate.diagnostics };
	const manifest = candidate.manifest;
	const digest = candidate.contentDigest;
	const range = manifest.pancode.compatibility?.pancode;
	if (range && !evaluatePancodeCompatibility(range).satisfied)
		return { diagnostics: [{ type: "error", message: `plugin requires PanCode ${range}` }] };
	if (
		(options.expectedKind !== undefined && options.expectedKind !== (manifest.pancode.kind ?? "plugin")) ||
		(options.expectedDigest !== undefined && options.expectedDigest !== digest) ||
		(options.expectedId !== undefined && options.expectedId !== manifest.name) ||
		(options.expectedVersion !== undefined && options.expectedVersion !== manifest.version)
	)
		return {
			diagnostics: [{ type: "error", message: "plugin source does not match the pinned digest, identity, or version" }],
		};
	const target = path.join(pluginBaseDir(scope, cwd), manifest.name);
	const resolvedBase = pluginBaseDir(scope, cwd);
	// Copying a source into its own descendant grows recursively; replacing an
	// ancestor would erase the source. Neither is a meaningful install.
	if (
		isSameOrDescendant(canonicalizeExistingPath(resolvedBase), canonicalizeExistingPath(source)) ||
		isSameOrDescendant(canonicalizeExistingPath(source), canonicalizeExistingPath(target))
	)
		return { diagnostics: [{ type: "error", message: "plugin source overlaps its managed installation destination" }] };
	return withMutation(scope, cwd, () => {
		const { state, bytes, invalid } = readState(scope, cwd);
		assertExpectedState(options.expect, cwd);
		const previouslyInstalled = Object.hasOwn(state.installed, manifest.name);
		const previousDigest = state.installed[manifest.name]?.contentDigest;
		const previousOrigin = state.installed[manifest.name]?.origin;
		if (isForeignPluginOrigin(previousOrigin))
			throw new Error("interop packs require a new reviewed adoption; remove the installed copy and adopt it again");
		const previousKind = state.installed[manifest.name]?.kind ?? readPluginManifest(target).manifest?.pancode.kind;
		if (previousKind && previousKind !== (manifest.pancode.kind ?? "plugin"))
			throw new Error("pack kind cannot change during replacement; remove it explicitly first");
		const requestedOrigin = options.origin ?? { kind: "local" as const, source };
		const publisher =
			options.publisher ??
			derivedPublisher(typeof requestedOrigin === "string" ? requestedOrigin : requestedOrigin.source);
		const collision = publisherCollision(
			manifest.name,
			publisher,
			(["user", "project"] as const).flatMap((other) => {
				const copy = other === scope ? state.installed[manifest.name] : readOtherScopeRecord(other, cwd, manifest.name);
				return copy && packageNamespace(copy.kind) === packageNamespace(manifest.pancode.kind)
					? [{ scope: other, publisher: copy.publisher }]
					: [];
			}),
		);
		if (collision) throw new Error(collision);
		if (existsSync(target) && !options.force)
			throw new Error(`plugin ${manifest.name} is already installed; use --force to replace it`);
		if (existsSync(target) && lstatSync(target).isSymbolicLink())
			throw new Error("installed plugin root must not be a symbolic link");
		const staging = uniqueSibling(target, "install");
		const backup = uniqueSibling(target, "backup");
		let moved = false;
		let published = false;
		let preserveBackup = false;
		if (existsSync(target)) {
			try {
				preserveBackup = pluginContentDigest(target) !== state.installed[manifest.name]?.contentDigest;
			} catch {
				preserveBackup = true;
			}
		}
		try {
			cpSync(source, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
			const staged = readPluginManifest(staging);
			if (!staged.valid || staged.manifest?.name !== manifest.name || staged.contentDigest !== digest)
				throw new Error("staged plugin differs from the verified source tree");
			if (pluginContentDigest(source) !== digest) throw new Error("plugin source changed while staging");
			assertUnchangedInstallState(PLUGIN_STATE, scope, cwd, bytes);
			if (existsSync(target)) {
				renameSync(target, backup);
				moved = true;
			}
			renameSync(staging, target);
			published = true;
			if (pluginContentDigest(target) !== digest) throw new Error("plugin changed during publication");
			const origin = requestedOrigin;
			// An import is always foreign. Interop adoption decides per source: the operator's own home installs
			// trusted on their reviewed approval, a project directory stays foreign (interop adoptedPackageTrust).
			const trust =
				typeof origin === "object" && origin.kind === "interop"
					? (options.trust ?? "foreign")
					: isForeignPluginOrigin(origin)
						? "foreign"
						: (options.trust ?? state.installed[manifest.name]?.trust ?? "trusted");
			const kind = manifest.pancode.kind ?? "plugin";
			state.installed[manifest.name] = {
				...(kind === "server" ? { kind, tier: options.tier ?? null } : { kind }),
				installedAt: new Date().toISOString(),
				source: typeof origin === "string" ? origin : origin.source,
				origin,
				contentDigest: digest,
				trust,
				publisher,
			};
			if (!previouslyInstalled) state.disabled = state.disabled.filter((id) => id !== manifest.name);
			writeInstallState(PLUGIN_STATE, scope, cwd, state, bytes, invalid);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			if (published && existsSync(target)) {
				// Preserve concurrent changes instead of deleting someone else's work.
				let unchanged = false;
				try {
					unchanged = pluginContentDigest(target) === digest;
				} catch {
					/* Preserve unreadable replacement. */
				}
				if (!unchanged)
					return {
						recovery: { ...(moved ? { packageBackup: backup } : {}) },
						diagnostics: [
							{
								type: "error",
								message: `plugin installation failed and changed content was preserved: ${String(error)}`,
								path: target,
							},
						],
					};
				rmSync(target, { recursive: true, force: true });
			}
			if (moved) renameSync(backup, target);
			throw error;
		}
		if (moved && !preserveBackup) preserveBackup = retainRecovery(backup, previousDigest);
		if (moved && preserveBackup) sweepRecoveryCopies(target);
		recordLifecycleReceipt(
			{
				operation: previouslyInstalled ? "update" : "install",
				kind: manifest.pancode.kind ?? "plugin",
				id: manifest.name,
				version: manifest.version ?? null,
				contentDigest: digest,
				envelopeDigest: null,
				scope,
				source: state.installed[manifest.name]?.source ?? source,
			},
			options.lifecycle,
		);
		const plugin = listInstalledPlugins(cwd, { scope, all: true }).find((entry) => entry.id === manifest.name);
		return {
			...(plugin ? { plugin } : {}),
			contentDigest: digest,
			...(moved && preserveBackup ? { recovery: { packageBackup: backup } } : {}),
			diagnostics: plugin?.diagnostics ?? [],
		};
	});
}

export function updatePlugin(id: string, options: PluginInstallOptions = {}): PluginMutationResult {
	if (!isPluginId(id)) return { diagnostics: [{ type: "error", message: "invalid plugin id" }] };
	try {
		const scope = selectedScope(id, options);
		const installed = readPluginInstallRecord(id, { ...options, scope });
		if (!installed) throw new Error(`plugin ${id} is not installed`);
		if (isForeignPluginOrigin(installed.origin))
			throw new Error("interop packs require a new reviewed adoption; remove the installed copy and adopt it again");
		const current = listInstalledPlugins(options.cwd ?? process.cwd(), { scope, all: true }).find(
			(entry) => entry.id === id,
		);
		if (!options.force && !current?.valid)
			throw new Error(
				`plugin ${id} has changed or unverifiable content; use --force to preserve a recovery copy and replace it`,
			);
		if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(installed.source))
			throw new Error("remote plugin updates must resolve a verified PanHub catalog source");
		return installPlugin(installed.source, {
			...options,
			scope,
			force: true,
			expectedId: id,
			origin: installed.origin ?? installed.source,
			publisher: installed.publisher,
		});
	} catch (error) {
		return { diagnostics: [{ type: "error", message: error instanceof Error ? error.message : String(error) }] };
	}
}

function setEnabled(id: string, enabled: boolean, options: PluginMutationOptions): PluginMutationResult {
	if (!isPluginId(id)) return { diagnostics: [{ type: "error", message: "invalid plugin id" }] };
	const cwd = options.cwd ?? process.cwd();
	const scope = selectedScope(id, options);
	return withMutation(scope, cwd, () => {
		const { state, bytes, invalid } = readState(scope, cwd);
		assertExpectedState(options.expect, cwd);
		const plugin = listInstalledPlugins(cwd, { scope, all: true }).find((entry) => entry.id === id);
		if (!plugin) throw new Error(`plugin ${id} is not installed`);
		if (enabled && (!plugin.valid || !plugin.compatible))
			throw new Error(`plugin ${id} cannot be enabled: ${plugin.diagnostics.map((entry) => entry.message).join("; ")}`);
		if (!enabled && plugin.enabled) refuseBrokenDependents(cwd, { scope, id, operation: "disable" });
		state.disabled = state.disabled.filter((value) => value !== id);
		if (!enabled) state.disabled.push(id);
		writeInstallState(PLUGIN_STATE, scope, cwd, state, bytes, invalid);
		const updated = listInstalledPlugins(cwd, { scope, all: true }).find((entry) => entry.id === id);
		recordLifecycleReceipt(
			{
				operation: enabled ? "enable" : "disable",
				kind: plugin.kind ?? "plugin",
				id,
				version: plugin.version,
				contentDigest: state.installed[id]?.contentDigest ?? null,
				envelopeDigest: null,
				scope,
				source: state.installed[id]?.source ?? plugin.rootPath,
			},
			options.lifecycle,
		);
		return { ...(updated ? { plugin: updated } : {}), diagnostics: [] };
	});
}

export function enablePlugin(id: string, options: PluginMutationOptions = {}): PluginMutationResult {
	return setEnabled(id, true, options);
}
export function disablePlugin(id: string, options: PluginMutationOptions = {}): PluginMutationResult {
	return setEnabled(id, false, options);
}

export function removePlugin(id: string, options: PluginMutationOptions = {}): PluginMutationResult {
	if (!isPluginId(id)) return { diagnostics: [{ type: "error", message: "invalid plugin id" }] };
	const cwd = options.cwd ?? process.cwd();
	const scope = selectedScope(id, options);
	return withMutation(scope, cwd, () => {
		const { state, bytes, invalid } = readState(scope, cwd);
		assertExpectedState(options.expect, cwd);
		const target = path.join(pluginBaseDir(scope, cwd), id);
		const kept = invalid.filter((entry) => entry.id !== id);
		const previousDigest = state.installed[id]?.contentDigest;
		const receiptIdentity = {
			operation: "remove" as const,
			kind: state.installed[id]?.kind ?? "plugin",
			id,
			version: readPluginManifest(target).manifest?.version ?? null,
			contentDigest: previousDigest ?? null,
			envelopeDigest: null,
			scope,
			source: state.installed[id]?.source ?? target,
		};
		if (!existsSync(target) && !state.installed[id] && kept.length === invalid.length)
			throw new Error(`plugin ${id} is not installed`);
		refuseBrokenDependents(cwd, { scope, id, operation: "remove" });
		const backup = uniqueSibling(target, "removed");
		const moved = existsSync(target);
		let preserve = false;
		if (moved) {
			try {
				preserve = pluginContentDigest(target) !== state.installed[id]?.contentDigest;
			} catch {
				preserve = true;
			}
			renameSync(target, backup);
		}
		try {
			delete state.installed[id];
			state.disabled = state.disabled.filter((value) => value !== id);
			writeInstallState(PLUGIN_STATE, scope, cwd, state, bytes, kept);
		} catch (error) {
			if (moved) renameSync(backup, target);
			throw error;
		}
		if (moved && !preserve) preserve = retainRecovery(backup, previousDigest);
		if (moved && preserve) sweepRecoveryCopies(target);
		const diagnostics: PluginDiagnostic[] = preserve
			? [
					{
						type: "warning",
						message: "removed plugin contained changed or unverified files; preserved recovery copy",
						path: backup,
					},
				]
			: [];
		const dataDir = pluginDataDir(scope, target);
		try {
			rmSync(dataDir, { recursive: true, force: true });
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message: `the plugin's data directory was not removed: ${error instanceof Error ? error.message : String(error)}`,
				path: dataDir,
			});
		}
		recordLifecycleReceipt(receiptIdentity, options.lifecycle);
		return {
			removed: { id, scope, path: target },
			...(preserve ? { recovery: { packageBackup: backup } } : {}),
			diagnostics,
		};
	});
}

/** Doctor's read of one scope's install records, or null when that scope has no state file. Throws when the file is unreadable. */
export function auditPluginInstallRecords(scope: PluginScope, cwd = process.cwd()): InstallRecordReport | null {
	return auditInstallRecords(PLUGIN_STATE, scope, cwd);
}

/**
 * `doctor --fix`: drop every invalid record from one scope's state file. A
 * package directory whose bytes hash to the record's contentDigest goes with
 * it; any other directory moves to a recovery copy beside it, as `hub remove`
 * does, so the reinstall path is free and no unmatched byte is deleted.
 */
export function repairPluginInstallRecords(scope: PluginScope, cwd = process.cwd()): InstallRecordReport | null {
	const precheck = readInstallState(PLUGIN_STATE, scope, cwd);
	if (precheck.status === "absent") return null;
	if (precheck.status === "corrupt") throw new Error(precheck.message);
	const file = pluginStatePath(scope, cwd);
	return withPluginScopeLock(scope, cwd, () => {
		const read = readState(scope, cwd);
		if (read.status === "absent") return null;
		const { state, bytes, invalid } = read;
		const moves: Array<{ from: string; to: string }> = [];
		const dropped = invalid.map(({ id, pack, reason, raw }): DroppedInstallRecord => {
			const root = path.join(pluginBaseDir(scope, cwd), id);
			if (!isPluginId(id) || !existsSync(root)) return { id, pack, reason };
			if (lstatSync(root).isSymbolicLink()) return { id, pack, reason, kept: root };
			let owned = false;
			try {
				owned = isRecord(raw) && pluginContentDigest(root) === raw.contentDigest;
			} catch {
				// Bytes that cannot be hashed cannot be matched to the record, so they are preserved.
			}
			if (owned) return { id, pack, reason, removed: root };
			const preserved = uniqueSibling(root, "removed");
			moves.push({ from: root, to: preserved });
			return { id, pack, reason, preserved };
		});
		if (invalid.length > 0) {
			try {
				for (const move of moves) renameSync(move.from, move.to);
				const gone = new Set(dropped.flatMap((entry) => (entry.kept ? [] : [entry.id])));
				state.disabled = state.disabled.filter((id) => !gone.has(id));
				writeInstallState(PLUGIN_STATE, scope, cwd, state, bytes, []);
			} catch (error) {
				for (const move of moves) if (existsSync(move.to)) renameSync(move.to, move.from);
				throw error;
			}
		}
		for (const entry of dropped) if (entry.removed) rmSync(entry.removed, { recursive: true, force: true });
		for (const move of moves) sweepRecoveryCopies(move.from);
		return { path: file, valid: Object.keys(state.installed).length, invalid: [], dropped };
	});
}
