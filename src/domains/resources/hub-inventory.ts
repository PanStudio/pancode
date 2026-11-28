// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readSettings } from "../../core/config.js";
import { discoveryScore, discoveryTermsMatch } from "../../core/harness-discovery.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import { listPlaybooks } from "../agents/playbook.js";
import type { AgentRecipe } from "../agents/recipe.js";
import { type AgentRecipeDiagnostic, discoverAgentRecipes } from "../agents/registry.js";
import type { AgentAudience } from "../agents/spec.js";
import { isSemanticVersion, satisfiesSemVerRange } from "../extensions/compatibility.js";
import { INTEROP_AGENT_KINDS } from "../interop/registry.js";
import { bundledHubIndexPath, parsePluginGithubSource } from "../plugins/catalog.js";
import { withPluginDiscoveryPass } from "../plugins/index.js";
import type { ForeignPackageFormat, InstalledPlugin, PluginInstallRecord, PluginScope } from "../plugins/types.js";
import type { ResourceDiagnostic } from "./collision.js";
import { discoverHub } from "./hub.js";
import {
	hubCopySourceId,
	hubNamespace,
	installedCopiesNamed,
	listInstalledHubPackages as listInstalledPlugins,
	readHubInstallRecord,
} from "./hub-packages.js";
import type {
	HubComponentKind,
	HubEntryKind,
	HubPackageEntry,
	HubProvidedResource,
	HubRequirementRef,
} from "./hub-types.js";
import { clipAtWord, type HubCategory, isHubComponentKind, isHubKind } from "./hub-types.js";
import { type HubValidationPrerequisite, validateHubPackage } from "./hub-validation.js";
import { loadPromptTemplates, type PromptTemplate } from "./prompts/loader.js";
import { loadSkills, type Skill } from "./skills/loader.js";

/**
 * One body-free projection of three separate facts: catalog packages (install
 * targets), installed scoped copies (state), and actual component resources (what
 * the loaders really see). It composes the existing readers and never fetches,
 * executes, reloads or writes. Package and component readers never call back into
 * this module.
 */

/** Where the bytes came from, derived from discovery, install and adoption evidence only. */
export type HubOrigin =
	| { kind: "bundled"; catalog: string }
	| { kind: "remote"; url: string; catalog?: string; host?: string }
	| { kind: "local"; path: string; catalog?: string; host?: string }
	| { kind: "imported"; agent: string; path: string; marketplace?: string }
	| { kind: "core" }
	| { kind: "unknown"; detail?: string };

/**
 * `loadable` means the package engine admits the copy's resource roots. It says
 * nothing about whether every component inside parsed or is trusted; that is the
 * resource row's availability.
 */
export type HubCopyState = "loadable" | "disabled" | "shadowed" | "invalid" | "incompatible" | "damaged" | "untrusted";

/** A newer catalog version, or the same version whose pinned bytes moved. */
export interface HubCopyUpdate {
	version: string;
	reason: "newer-version" | "changed-content";
}

export interface HubCopy {
	ref: HubRequirementRef;
	kind: HubEntryKind;
	name: string;
	scope: PluginScope;
	root: string;
	version: string;
	state: HubCopyState;
	enabled: boolean;
	valid: boolean;
	compatible: boolean;
	effective: boolean;
	loadable: boolean;
	trust: "trusted" | "foreign";
	overriddenBy?: PluginScope;
	origin: HubOrigin;
	format?: ForeignPackageFormat;
	recordedDigest?: string;
	observedDigest?: string;
	installedAt?: string;
	/** Present only for a copy installed from a catalog row that has moved past it. */
	update?: HubCopyUpdate;
	diagnostics: string[];
}

export interface HubPackageRecord {
	ref: HubRequirementRef;
	kind: HubEntryKind;
	name: string;
	description: string;
	version?: string;
	sha256?: string;
	sourceUrl: string;
	requires?: HubRequirementRef[];
	origin: HubOrigin;
	format?: ForeignPackageFormat;
	/** Hints only; absent means contents are unknown until inspection. */
	provides?: HubProvidedResource[];
	/** Which reader produced the row: a catalog, a scoped index, or install state alone. */
	catalogOrigin: HubPackageEntry["origin"];
	/** The copies of this package, each with the version on disk, which an update leaves behind the catalog's. */
	copies: Array<{ scope: PluginScope; state: HubCopyState; version?: string; update?: HubCopyUpdate }>;
	refusal?: string;
}

export type HubComponentSourceClass = "core" | "package" | "user" | "project" | "compat";
export type HubComponentAvailability = "available" | "untrusted" | "invalid" | "shadowed" | "unavailable";

export interface HubComponent {
	/** `${kind}:${name}@${sourceId}#${relativePath}`; two same-name files under one root stay distinct. */
	key: string;
	kind: HubComponentKind;
	/** Actual runtime name: skill frontmatter name, agent file id, prompt path with colons, playbook name. */
	name: string;
	description: string;
	invocation?: string;
	path: string;
	source: { class: HubComponentSourceClass; id: string; scope: "package" | "user" | "project" };
	owner?: { ref: HubRequirementRef; scope: PluginScope; componentId?: string };
	origin: HubOrigin;
	format?: ForeignPackageFormat;
	availability: HubComponentAvailability;
	reason?: string;
	trusted: boolean;
	modelInvocable?: boolean;
	audience?: AgentAudience;
	diagnostics: string[];
}

export interface HubInventory {
	version: 1;
	generatedAt: string;
	cwd: string;
	audience: "operator" | "model";
	packages: HubPackageRecord[];
	copies: HubCopy[];
	resources: HubComponent[];
	diagnostics: string[];
	truncated: { packages: boolean; copies: boolean; resources: boolean };
}

const HUB_INVENTORY_LIMITS = {
	packages: 512,
	copies: 256,
	resources: 1024,
	diagnostics: 64,
	copyDiagnostics: 16,
	resourceDiagnostics: 8,
	description: 512,
	message: 512,
} as const;

function clip(value: string, limit: number = HUB_INVENTORY_LIMITS.description): string {
	return clipAtWord(value, limit);
}

/** Append-only list that refuses rows past its cap so traversal, not a final slice, enforces the bound. */
class Bounded<T> {
	readonly items: T[] = [];
	truncated = false;
	constructor(private readonly limit: number) {}
	push(item: T): boolean {
		if (this.items.length >= this.limit) {
			this.truncated = true;
			return false;
		}
		this.items.push(item);
		return true;
	}
}

export interface HubInventoryOptions {
	cwd?: string;
	catalog?: string;
	/** `model` hides internal/shadow agents and every resource the model may not invoke. Default operator. */
	audience?: "operator" | "model";
	/** Operator only: include shadow/internal agents. */
	all?: boolean;
	/** Packages match their own kind or a provided hint kind; resources match exactly. */
	kinds?: ReadonlyArray<HubCategory>;
	query?: string;
	/** `kind:name` package ref, a resource key, or a bare runtime name. */
	ref?: string;
	sources?: ReadonlyArray<HubComponentSourceClass>;
	/** Skip a whole reader when a caller does not need it. */
	include?: { packages?: boolean; copies?: boolean; resources?: boolean };
	trustProjectCompatRoots?: boolean;
	/** Testing seam: the config dir used for user roots. */
	configDir?: string;
	/** Testing seam: the home directory used for compatibility roots. */
	home?: string;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function hubComponentKey(kind: HubComponentKind, name: string, sourceId: string, relativePath: string): string {
	return `${kind}:${name}@${sourceId}#${relativePath}`;
}

export interface HubComponentKeyParts {
	kind: HubComponentKind;
	name: string;
	sourceId: string;
	/** Absent when a caller addresses every file with that name under that source. */
	relativePath?: string;
}

export function parseHubResourceKey(key: string): HubComponentKeyParts | undefined {
	const hash = key.indexOf("#");
	const head = hash >= 0 ? key.slice(0, hash) : key;
	const at = head.lastIndexOf("@");
	const colon = head.indexOf(":");
	if (at <= 0 || colon <= 0 || colon > at) return undefined;
	const kind = head.slice(0, colon);
	const name = head.slice(colon + 1, at);
	const sourceId = head.slice(at + 1);
	if (!isHubComponentKind(kind) || !name || !sourceId) return undefined;
	const relativePath = hash >= 0 ? key.slice(hash + 1) : undefined;
	return { kind, name, sourceId, ...(relativePath ? { relativePath } : {}) };
}

function keyMatches(key: string, parts: HubComponentKeyParts): boolean {
	const own = parseHubResourceKey(key);
	if (!own) return false;
	return (
		own.kind === parts.kind &&
		own.name === parts.name &&
		own.sourceId === parts.sourceId &&
		(parts.relativePath === undefined || own.relativePath === parts.relativePath)
	);
}

/** Anchors that turn an absolute file path into the contained relative path a key carries. */
interface KeyAnchors {
	cwd: string;
	home: string;
	configDir?: string;
	packageRoot?: string;
}

function relativeTo(anchor: string | undefined, filePath: string): string | undefined {
	if (!anchor) return undefined;
	const relative = path.relative(canonical(anchor), canonical(filePath));
	return isSameOrDescendant(canonical(filePath), canonical(anchor)) ? relative.split(path.sep).join("/") : undefined;
}

function keyPath(anchors: KeyAnchors, sourceId: string, filePath: string, owner: HubCopy | undefined): string {
	const candidate =
		(owner ? relativeTo(owner.root, filePath) : undefined) ??
		(sourceId === "core" ? relativeTo(anchors.packageRoot, filePath) : undefined) ??
		(sourceId === "config" ? relativeTo(anchors.configDir, filePath) : undefined) ??
		(sourceId === "project" || sourceId.endsWith("-project") ? relativeTo(anchors.cwd, filePath) : undefined) ??
		relativeTo(anchors.home, filePath);
	return candidate ?? path.basename(filePath);
}

// ---------------------------------------------------------------------------
// Origin classification
// ---------------------------------------------------------------------------

function bundledHubDir(): string | undefined {
	try {
		return path.join(resolvePackageRoot(), "hub");
	} catch {
		return undefined;
	}
}

function canonical(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

function underBundledHub(candidate: string): boolean {
	const dir = bundledHubDir();
	if (!dir || !path.isAbsolute(candidate)) return false;
	return isSameOrDescendant(canonical(candidate), canonical(dir));
}

function bundledIndex(): string | undefined {
	try {
		return bundledHubIndexPath();
	} catch {
		return undefined;
	}
}

/** Loose-file source ids look like `claude-user`, `codex-project`; the prefix is the local agent. */
function compatHost(sourceId: string): string | undefined {
	const match = /^(.+)-(user|project)$/.exec(sourceId);
	const host = match?.[1];
	return host && host !== "unknown" ? host : undefined;
}

function formatForHost(host: string | undefined): ForeignPackageFormat | undefined {
	if (host === "claude" || host === "claude-code") return "claude-code";
	if (host === "codex") return "codex";
	return undefined;
}

export type HubOriginEvidence =
	| { kind: "catalog-row"; entry: HubPackageEntry }
	| { kind: "install-record"; record: PluginInstallRecord | undefined; rootPath: string }
	| { kind: "resource-root"; sourceId: string; path: string };

/** One rule shared by CLI, context and UI. Author metadata never reaches it. */
export function classifyHubOrigin(evidence: HubOriginEvidence): {
	origin: HubOrigin;
	format?: ForeignPackageFormat;
} {
	if (evidence.kind === "catalog-row") {
		const { entry } = evidence;
		if (entry.origin === "installed") return { origin: { kind: "unknown", detail: "no catalog row" } };
		const catalog = entry.index;
		const bundled = bundledIndex();
		if (catalog && bundled && canonical(catalog) === canonical(bundled))
			return { origin: { kind: "bundled", catalog }, format: "portable" };
		if (parsePluginGithubSource(entry.sourceUrl))
			return { origin: { kind: "remote", url: entry.sourceUrl, ...(catalog ? { catalog } : {}) }, format: "portable" };
		return { origin: { kind: "local", path: entry.sourceUrl, ...(catalog ? { catalog } : {}) }, format: "portable" };
	}
	if (evidence.kind === "install-record") {
		const { record } = evidence;
		if (!record) return { origin: { kind: "unknown", detail: "install record unavailable" } };
		const origin = record.origin;
		if (origin === undefined || typeof origin === "string") {
			const source = origin ?? record.source;
			if (parsePluginGithubSource(source)) return { origin: { kind: "remote", url: source }, format: "portable" };
			if (path.isAbsolute(source))
				return underBundledHub(source)
					? { origin: { kind: "bundled", catalog: bundledIndex() ?? source }, format: "portable" }
					: { origin: { kind: "local", path: source }, format: "portable" };
			return { origin: { kind: "unknown", detail: `unclassified source: ${source}` } };
		}
		switch (origin.kind) {
			case "catalog": {
				if (parsePluginGithubSource(origin.source))
					return { origin: { kind: "remote", url: origin.source }, format: "portable" };
				if (underBundledHub(origin.source))
					return { origin: { kind: "bundled", catalog: bundledIndex() ?? origin.source }, format: "portable" };
				return { origin: { kind: "local", path: origin.source }, format: "portable" };
			}
			case "github":
				return { origin: { kind: "remote", url: origin.source }, format: "portable" };
			case "local":
				return { origin: { kind: "local", path: origin.source }, format: "portable" };
			case "interop":
				return {
					origin: {
						kind: "imported",
						agent: origin.host,
						path: origin.source,
						...(origin.marketplace ? { marketplace: origin.marketplace } : {}),
					},
					format: origin.format ?? "portable",
				};
			case "import":
				return {
					origin:
						origin.transport === "github"
							? { kind: "remote", url: origin.source, ...(origin.host ? { host: origin.host } : {}) }
							: { kind: "local", path: origin.source, ...(origin.host ? { host: origin.host } : {}) },
					format: origin.format,
				};
			default:
				return { origin: { kind: "unknown", detail: "unrecognized origin record" } };
		}
	}
	const { sourceId } = evidence;
	if (sourceId === "core") return { origin: { kind: "core" } };
	if (sourceId.startsWith("plugin:"))
		return { origin: { kind: "unknown", detail: "pack origin requires its installed copy record" } };
	if (sourceId === "config" || sourceId === "project")
		return { origin: { kind: "local", path: evidence.path }, format: "portable" };
	const host = compatHost(sourceId);
	const format = formatForHost(host);
	return {
		origin: { kind: "local", path: evidence.path, ...(host ? { host } : {}) },
		...(format ? { format } : {}),
	};
}

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

/** The one copy-state projection, shared with lifecycle verification. */
export function hubCopyState(plugin: InstalledPlugin): HubCopyState {
	if (plugin.loadable) return "loadable";
	if (!plugin.compatible) return "incompatible";
	// No parsed manifest means the copy is not a package any more; drift only
	// describes a package whose recorded bytes changed.
	if (!plugin.manifest) return "invalid";
	if (plugin.diagnostics.some((item) => item.message.includes("content drift"))) return "damaged";
	if (!plugin.valid) return "invalid";
	if (!plugin.enabled) return "disabled";
	// A project copy awaiting workspace trust is blocked, not shadowed by another copy.
	if (plugin.trustBlocked) return "untrusted";
	if (!plugin.effective) return "shadowed";
	return "invalid";
}

function safeInstallRecord(plugin: InstalledPlugin, cwd: string): PluginInstallRecord | undefined {
	try {
		return readHubInstallRecord(plugin.id, { cwd, scope: plugin.scope }, plugin.kind);
	} catch {
		return undefined;
	}
}

function projectCopy(plugin: InstalledPlugin, cwd: string, record = safeInstallRecord(plugin, cwd)): HubCopy {
	const kind = plugin.kind ?? "plugin";
	const classified = classifyHubOrigin({ kind: "install-record", record, rootPath: plugin.rootPath });
	return {
		ref: `${kind}:${plugin.id}`,
		kind,
		name: plugin.id,
		scope: plugin.scope,
		root: plugin.rootPath,
		version: plugin.version,
		state: hubCopyState(plugin),
		enabled: plugin.enabled,
		valid: plugin.valid,
		compatible: plugin.compatible,
		effective: plugin.effective,
		loadable: plugin.loadable,
		trust: plugin.trust ?? "trusted",
		...(plugin.overriddenBy ? { overriddenBy: plugin.overriddenBy } : {}),
		origin: classified.origin,
		...(classified.format ? { format: classified.format } : {}),
		...(record?.contentDigest ? { recordedDigest: record.contentDigest } : {}),
		...(plugin.observedContentDigest ? { observedDigest: plugin.observedContentDigest } : {}),
		...(record?.installedAt ? { installedAt: record.installedAt } : {}),
		diagnostics: plugin.diagnostics
			.slice(0, HUB_INVENTORY_LIMITS.copyDiagnostics)
			.map((item) => clip(item.message, HUB_INVENTORY_LIMITS.message)),
	};
}

/**
 * What a catalog row offers a copy installed from it. Only a catalog install has
 * a row to compare with: a local or imported copy with the same name is another
 * source, so a matching catalog version says nothing about it. An older catalog
 * version is not an update either, because a downgrade is an explicit install.
 */
function catalogCopyUpdate(copy: HubCopy, entry: HubPackageEntry): HubCopyUpdate | undefined {
	if (entry.origin === "installed" || !entry.version) return undefined;
	if (isSemanticVersion(copy.version) && satisfiesSemVerRange(entry.version, `>${copy.version}`))
		return { version: entry.version, reason: "newer-version" };
	if (entry.version === copy.version && entry.sha256 && copy.recordedDigest && entry.sha256 !== copy.recordedDigest)
		return { version: entry.version, reason: "changed-content" };
	return undefined;
}

const INACTIVE_COPY_STATES: ReadonlySet<HubCopyState> = new Set([
	"damaged",
	"invalid",
	"incompatible",
	"disabled",
	"untrusted",
]);

/**
 * Installed copies the loaders never read, so no resource row can speak for
 * them. A shadowed copy is not one: the winning copy still provides its
 * components under the same names.
 */
export function inactiveHubCopies(copies: ReadonlyArray<HubCopy>): HubCopy[] {
	return copies.filter((copy) => INACTIVE_COPY_STATES.has(copy.state));
}

/** The next operator step for an inactive copy, in the words the CLI accepts. */
export function inactiveCopyRemedy(copy: Pick<HubCopy, "ref" | "scope" | "state">): string {
	switch (copy.state) {
		case "damaged":
			return `local files differ from the pin; review with pancode hub drift ${copy.ref} --${copy.scope}, then replace with pancode hub update ${copy.ref} --${copy.scope} --force`;
		case "disabled":
			return `enable with pancode hub enable ${copy.ref} --${copy.scope}`;
		case "untrusted":
			return "approve with pancode config trust plugins, then /reload hub";
		default:
			return `inspect with pancode hub inspect ${copy.ref} --${copy.scope}`;
	}
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

interface OwnerIndex {
	/** `plugin:<scope>:<id>` for plugin-format packages, `extension:<scope>:<id>` for extensions → copy */
	bySourceId: Map<string, HubCopy>;
	/** canonical root → copy, for readers that only expose a file path */
	roots: Array<{ root: string; copy: HubCopy }>;
	anchors: KeyAnchors;
}

function ownerIndex(copies: ReadonlyArray<HubCopy>, anchors: KeyAnchors): OwnerIndex {
	const bySourceId = new Map<string, HubCopy>();
	const roots: OwnerIndex["roots"] = [];
	for (const copy of copies) {
		bySourceId.set(hubCopySourceId(copy), copy);
		roots.push({ root: canonical(copy.root), copy });
	}
	// Longest root first so a nested package root wins containment.
	roots.sort((a, b) => b.root.length - a.root.length);
	return { bySourceId, roots, anchors };
}

function ownerByPath(index: OwnerIndex, filePath: string): HubCopy | undefined {
	const target = canonical(filePath);
	return index.roots.find((item) => isSameOrDescendant(target, item.root))?.copy;
}

function ownerOf(copy: HubCopy): NonNullable<HubComponent["owner"]> {
	return { ref: copy.ref, scope: copy.scope };
}

function sourceClassFor(sourceId: string): HubComponentSourceClass {
	if (sourceId === "core") return "core";
	if (sourceId.startsWith("plugin:")) return "package";
	if (sourceId === "config") return "user";
	if (sourceId === "project") return "project";
	return "compat";
}

function resourceOrigin(
	sourceId: string,
	filePath: string,
	owner: HubCopy | undefined,
): { origin: HubOrigin; format?: ForeignPackageFormat } {
	if (owner) return { origin: owner.origin, ...(owner.format ? { format: owner.format } : {}) };
	return classifyHubOrigin({ kind: "resource-root", sourceId, path: filePath });
}

function bounded(diagnostics: ReadonlyArray<string>): string[] {
	return diagnostics
		.slice(0, HUB_INVENTORY_LIMITS.resourceDiagnostics)
		.map((message) => clip(message, HUB_INVENTORY_LIMITS.message));
}

function fromSkill(skill: Skill, index: OwnerIndex): HubComponent {
	const sourceId = skill.sourceInfo.source ?? `${skill.source}-${skill.scope}`;
	const owner =
		index.bySourceId.get(sourceId) ?? (skill.scope === "package" ? ownerByPath(index, skill.filePath) : undefined);
	const hard = skill.diagnostics.some((item) => item.type === "error" || item.type === "collision");
	const availability: HubComponentAvailability = hard ? "invalid" : skill.trusted ? "available" : "untrusted";
	const reason = hard
		? skill.diagnostics.find((item) => item.type === "error" || item.type === "collision")?.message
		: !skill.trusted
			? skill.source === "plugin"
				? "imported pack is untrusted; review it and enable integrations.projectResources.trustProjectImports"
				: "discovered only; explicitly import into PanCode with interop adopt or hub import"
			: undefined;
	const scope = skill.scope === "cli" ? "user" : skill.scope;
	return {
		key: hubComponentKey("skill", skill.name, sourceId, keyPath(index.anchors, sourceId, skill.filePath, owner)),
		kind: "skill",
		name: skill.name,
		description: clip(skill.description),
		...(availability === "available" ? { invocation: `/skill ${skill.name}` } : {}),
		path: skill.filePath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, skill.filePath, owner),
		availability,
		...(reason ? { reason: clip(reason, HUB_INVENTORY_LIMITS.message) } : {}),
		trusted: skill.trusted,
		modelInvocable: skill.trusted && !skill.disableModelInvocation && !hard,
		diagnostics: bounded(skill.diagnostics.map((item) => item.message)),
	};
}

function fromPrompt(template: PromptTemplate, index: OwnerIndex): HubComponent {
	const scope = template.sourceInfo.scope === "cli" ? "user" : template.sourceInfo.scope;
	const sourceId = template.sourceInfo.source ?? scope;
	const owner =
		index.bySourceId.get(sourceId) ?? (scope === "package" ? ownerByPath(index, template.filePath) : undefined);
	const availability: HubComponentAvailability = template.unavailable
		? "unavailable"
		: template.trusted
			? "available"
			: "untrusted";
	const reason = template.unavailable
		? template.unavailable
		: !template.trusted
			? scope === "package"
				? "imported pack is untrusted; review it and enable integrations.projectResources.trustProjectImports"
				: "discovered only; explicitly import into PanCode with interop adopt or hub import"
			: undefined;
	return {
		key: hubComponentKey("prompt", template.name, sourceId, keyPath(index.anchors, sourceId, template.filePath, owner)),
		kind: "prompt",
		name: template.name,
		description: clip(template.description),
		...(availability === "available" ? { invocation: `/${template.name}` } : {}),
		path: template.filePath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, template.filePath, owner),
		availability,
		...(reason ? { reason: clip(reason, HUB_INVENTORY_LIMITS.message) } : {}),
		trusted: template.trusted,
		diagnostics: [],
	};
}

function agentSourceId(
	recipe: Pick<AgentRecipe, "source" | "filepath">,
	index: OwnerIndex,
): { sourceId: string; owner?: HubCopy } {
	if (recipe.source === "builtin") return { sourceId: "core" };
	if (recipe.source === "user") return { sourceId: "config" };
	if (recipe.source === "project") return { sourceId: "project" };
	const owner = ownerByPath(index, recipe.filepath);
	return owner ? { sourceId: hubCopySourceId(owner), owner } : { sourceId: "plugin:unknown" };
}

function agentScope(source: AgentRecipe["source"]): "package" | "user" | "project" {
	return source === "user" ? "user" : source === "project" ? "project" : "package";
}

function fromAgent(recipe: AgentRecipe, index: OwnerIndex): HubComponent {
	const { sourceId, owner } = agentSourceId(recipe, index);
	const scope = agentScope(recipe.source);
	return {
		key: hubComponentKey("agent", recipe.id, sourceId, keyPath(index.anchors, sourceId, recipe.filepath, owner)),
		kind: "agent",
		name: recipe.id,
		description: clip(recipe.description),
		invocation: `dispatch(agent="${recipe.id}")`,
		path: recipe.filepath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, recipe.filepath, owner),
		availability: "available",
		trusted: true,
		audience: recipe.audience,
		diagnostics: [],
	};
}

function fromAgentDiagnostic(diagnostic: AgentRecipeDiagnostic, index: OwnerIndex): HubComponent {
	const { sourceId, owner } = agentSourceId({ source: diagnostic.source, filepath: diagnostic.filepath }, index);
	const scope = agentScope(diagnostic.source);
	const name = diagnostic.id ?? path.basename(diagnostic.filepath, ".md");
	const availability: HubComponentAvailability =
		diagnostic.kind === "overridden" ? "shadowed" : diagnostic.kind === "ignored" ? "unavailable" : "invalid";
	return {
		key: hubComponentKey("agent", name, sourceId, keyPath(index.anchors, sourceId, diagnostic.filepath, owner)),
		kind: "agent",
		name,
		description: "",
		path: diagnostic.filepath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, diagnostic.filepath, owner),
		availability,
		reason: clip(diagnostic.message, HUB_INVENTORY_LIMITS.message),
		trusted: true,
		...(diagnostic.audience ? { audience: diagnostic.audience } : {}),
		diagnostics: bounded([diagnostic.message]),
	};
}

function fromFleet(listing: ReturnType<typeof listPlaybooks>[number], index: OwnerIndex): HubComponent {
	const { sourceId, owner } = agentSourceId({ source: listing.source, filepath: listing.path }, index);
	const scope = agentScope(listing.source);
	const name = listing.playbook?.name ?? listing.name;
	const availability: HubComponentAvailability = listing.playbook
		? "available"
		: listing.needsCommands
			? "unavailable"
			: "invalid";
	const reason = listing.error ?? undefined;
	return {
		key: hubComponentKey("playbook", name, sourceId, keyPath(index.anchors, sourceId, listing.path, owner)),
		kind: "playbook",
		name,
		description: clip(listing.playbook?.description ?? ""),
		...(availability === "available" ? { invocation: `/fleet run ${name}` } : {}),
		path: listing.path,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, listing.path, owner),
		availability,
		...(reason ? { reason: clip(reason, HUB_INVENTORY_LIMITS.message) } : {}),
		trusted: true,
		diagnostics: reason ? bounded([reason]) : [],
	};
}

/** A collision loser is a real file the loader read and discarded; it stays inspectable. */
function fromCollisionLoser(
	kind: HubComponentKind,
	diagnostic: ResourceDiagnostic,
	winners: ReadonlyArray<HubComponent>,
	index: OwnerIndex,
	sourceIdFor: (filePath: string, scope: "package" | "user" | "project") => string,
): HubComponent | undefined {
	const collision = diagnostic.collision;
	if (!collision) return undefined;
	if (winners.some((item) => item.path === collision.loserPath)) return undefined;
	const scope = collision.loserScope === "cli" ? "user" : collision.loserScope;
	const owner = scope === "package" ? ownerByPath(index, collision.loserPath) : undefined;
	const sourceId = owner ? hubCopySourceId(owner) : sourceIdFor(collision.loserPath, scope);
	return {
		key: hubComponentKey(kind, collision.name, sourceId, keyPath(index.anchors, sourceId, collision.loserPath, owner)),
		kind,
		name: collision.name,
		description: "",
		path: collision.loserPath,
		source: { class: sourceClassFor(sourceId), id: sourceId, scope },
		...(owner ? { owner: ownerOf(owner) } : {}),
		...resourceOrigin(sourceId, collision.loserPath, owner),
		availability: "shadowed",
		reason: clip(diagnostic.message, HUB_INVENTORY_LIMITS.message),
		trusted: false,
		diagnostics: bounded([diagnostic.message]),
	};
}

/**
 * The source class of a file a loader diagnostic names: the row loaded from it, else the root that holds it. `--source`
 * narrows diagnostics by it as it narrows rows.
 */
function diagnosticSourceClass(
	filePath: string,
	rows: ReadonlyArray<HubComponent>,
	index: OwnerIndex,
	loose: ReturnType<typeof looseSourceId>,
): HubComponentSourceClass {
	const row = rows.find((item) => item.path === filePath);
	if (row) return row.source.class;
	if (ownerByPath(index, filePath)) return "package";
	if (loose(filePath, "project") === "project") return "project";
	if (loose(filePath, "user") === "config") return "user";
	const core = index.anchors.packageRoot;
	if (core && isSameOrDescendant(canonical(filePath), canonical(core))) return "core";
	return "compat";
}

/**
 * Source id for a file the loaders only named in a collision diagnostic. PanCode's
 * own roots map to `config`/`project`; a compatibility root maps to the id the
 * loader itself assigns (`claude-user` for skills, `claude-code-user` for
 * prompts) by containment in the interop registry's declared roots. A file
 * under no known root gets `unknown-<scope>`, never an invented vendor.
 */
function looseSourceId(anchors: KeyAnchors, kind: "skill" | "prompt") {
	return (filePath: string, scope: "package" | "user" | "project"): string => {
		if (scope === "package") return "plugin:unknown";
		const target = canonical(filePath);
		if (scope === "project" && isSameOrDescendant(target, canonical(path.join(anchors.cwd, ".pancode"))))
			return "project";
		if (scope === "user" && anchors.configDir && isSameOrDescendant(target, canonical(anchors.configDir)))
			return "config";
		const base = scope === "user" ? anchors.home : anchors.cwd;
		for (const agent of INTEROP_AGENT_KINDS) {
			const root =
				kind === "skill"
					? scope === "user"
						? agent.userSkillRoot
						: agent.projectSkillRoot
					: scope === "user"
						? agent.userPromptRoot
						: agent.projectPromptRoot;
			const id = kind === "skill" ? agent.skillSource : agent.id;
			if (root && id && isSameOrDescendant(target, canonical(path.join(base, root)))) return `${id}-${scope}`;
		}
		return `unknown-${scope}`;
	};
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface Selection {
	packageRef?: HubRequirementRef;
	resourceKey?: ReturnType<typeof parseHubResourceKey>;
	name?: string;
}

function parseSelection(ref: string | undefined): Selection {
	if (!ref) return {};
	const key = parseHubResourceKey(ref);
	if (key) return { resourceKey: key };
	const colon = ref.indexOf(":");
	if (colon > 0 && isHubKind(ref.slice(0, colon))) return { packageRef: ref as HubRequirementRef };
	return { name: ref };
}

/**
 * An operator's query narrows a list, so a phrase or every distinctive word must
 * hold across the fields. The model's query scores task vocabulary instead, and
 * ranks the partial hits a narrowing filter would hide.
 */
export function hubQueryMatches(query: string, ...fields: ReadonlyArray<string | undefined>): boolean {
	const needle = query.toLowerCase();
	return (
		fields.some((field) => field?.toLowerCase().includes(needle)) ||
		discoveryTermsMatch(query, fields.filter((field) => field !== undefined).join(" "))
	);
}

function matchesQuery(options: HubInventoryOptions, ...fields: ReadonlyArray<string | undefined>): boolean {
	const query = options.query;
	if (!query) return true;
	if (options.audience === "model") return discoveryScore(query, fields[0] ?? "", fields.slice(1).join(" ")) > 0;
	return hubQueryMatches(query, ...fields);
}

function packageMatches(
	record: HubPackageRecord,
	options: HubInventoryOptions,
	selection: Selection,
	triggers: ReadonlyArray<string> = [],
): boolean {
	if (selection.packageRef && record.ref !== selection.packageRef) return false;
	if (selection.name && record.name !== selection.name && !record.provides?.some((hint) => hint.name === selection.name))
		return false;
	if (selection.resourceKey) {
		// An exact key names one file under one source. Only its owner answers;
		// hints in other packages never match a key that already has an owner.
		const key = selection.resourceKey;
		const [namespace, , owner] = key.sourceId.split(":");
		if (namespace !== hubNamespace(record.kind) || owner !== record.name) return false;
	}
	if (options.kinds?.length) {
		const kinds = options.kinds;
		if (!kinds.includes(record.kind) && !record.provides?.some((hint) => kinds.includes(hint.kind))) return false;
	}
	return matchesQuery(
		options,
		record.name,
		record.description,
		...(record.provides ?? []).map((hint) => hint.name),
		...triggers,
	);
}

function copyMatches(copy: HubCopy, options: HubInventoryOptions, selection: Selection): boolean {
	if (selection.packageRef && copy.ref !== selection.packageRef) return false;
	if (selection.name && copy.name !== selection.name) return false;
	if (selection.resourceKey && selection.resourceKey.sourceId !== hubCopySourceId(copy)) return false;
	if (options.kinds?.length && !options.kinds.includes(copy.kind)) return false;
	return true;
}

function resourceMatches(
	resource: HubComponent,
	options: HubInventoryOptions,
	selection: Selection,
	triggers: ReadonlyArray<string> = [],
): boolean {
	if (selection.packageRef && resource.owner?.ref !== selection.packageRef) {
		const [kind, name] = selection.packageRef.split(":", 2);
		if (!(kind === resource.kind && name === resource.name)) return false;
	}
	if (selection.name && resource.name !== selection.name) return false;
	if (selection.resourceKey && !keyMatches(resource.key, selection.resourceKey)) return false;
	if (options.kinds?.length && !options.kinds.includes(resource.kind)) return false;
	if (options.sources?.length && !options.sources.includes(resource.source.class)) return false;
	return matchesQuery(options, resource.name, resource.description, ...triggers);
}

function audienceAdmits(resource: HubComponent, options: HubInventoryOptions): boolean {
	const model = options.audience === "model";
	if (resource.kind === "agent" && (resource.audience === "shadow" || resource.audience === "internal"))
		return !model && options.all === true;
	if (model) return resource.availability === "available" && resource.modelInvocable !== false;
	return true;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function trustSetting(explicit: boolean | undefined): boolean {
	if (explicit !== undefined) return explicit;
	try {
		return readSettings().integrations.projectResources.trustProjectImports;
	} catch {
		return false;
	}
}

function sortResources(items: HubComponent[]): HubComponent[] {
	const order: Record<HubComponentKind, number> = { skill: 0, agent: 1, prompt: 2, playbook: 3 };
	return items.sort(
		(a, b) =>
			order[a.kind] - order[b.kind] ||
			a.name.localeCompare(b.name) ||
			a.source.id.localeCompare(b.source.id) ||
			a.key.localeCompare(b.key),
	);
}

export function readHubInventory(options: HubInventoryOptions = {}): HubInventory {
	// Copies, catalog discovery, and resource rows each list installed plugins;
	// one discovery pass verifies every tree once for the whole inventory.
	return withPluginDiscoveryPass(() => readHubInventoryInPass(options));
}

function readHubInventoryInPass(options: HubInventoryOptions): HubInventory {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const include = { packages: true, copies: true, resources: true, ...(options.include ?? {}) };
	const selection = parseSelection(options.ref);
	const diagnostics = new Bounded<string>(HUB_INVENTORY_LIMITS.diagnostics);
	const note = (message: string): void => {
		const text = clip(message, HUB_INVENTORY_LIMITS.message);
		if (!diagnostics.items.includes(text)) diagnostics.push(text);
	};
	const wants = (kind: HubComponentKind): boolean => !options.kinds?.length || options.kinds.includes(kind);

	// Copies underpin package state and resource ownership, so they are read
	// whenever either of those is requested. The package engine enumerates every
	// scoped copy for precedence; only the projection is capped here.
	const installed =
		include.copies || include.packages || include.resources ? listInstalledPlugins(cwd, { all: true }) : [];
	const copyRows = new Bounded<HubCopy>(HUB_INVENTORY_LIMITS.copies);
	const catalogInstalled = new Set<string>();
	for (const plugin of installed) {
		const record = safeInstallRecord(plugin, cwd);
		const copy = projectCopy(plugin, cwd, record);
		if (!copyRows.push(copy)) break;
		if (typeof record?.origin === "object" && record.origin.kind === "catalog")
			catalogInstalled.add(`${copy.ref}@${copy.scope}`);
	}
	if (copyRows.truncated) note("installed copies truncated; later copies have no owner rows");
	const copies = copyRows.items;
	const copiesByRef = new Map<string, HubCopy[]>();
	for (const copy of copies) copiesByRef.set(copy.ref, [...(copiesByRef.get(copy.ref) ?? []), copy]);

	const packages = new Bounded<HubPackageRecord>(HUB_INVENTORY_LIMITS.packages);
	if (include.packages) {
		const discovery = discoverHub({ cwd, ...(options.catalog ? { catalog: options.catalog } : {}) });
		for (const message of discovery.diagnostics) note(message);
		for (const entry of discovery.entries) {
			const ref: HubRequirementRef = `${entry.kind}:${entry.name}`;
			const own = copiesByRef.get(ref) ?? [];
			const classified =
				entry.origin === "installed" && own[0]
					? { origin: own[0].origin, ...(own[0].format ? { format: own[0].format } : {}) }
					: classifyHubOrigin({ kind: "catalog-row", entry });
			const refusal = discovery.refusals[ref];
			for (const copy of own) {
				if (!catalogInstalled.has(`${copy.ref}@${copy.scope}`)) continue;
				const update = catalogCopyUpdate(copy, entry);
				if (update) copy.update = update;
			}
			const record: HubPackageRecord = {
				ref,
				kind: entry.kind,
				name: entry.name,
				description: clip(entry.description),
				...(entry.version ? { version: entry.version } : {}),
				...(entry.sha256 ? { sha256: entry.sha256 } : {}),
				sourceUrl: entry.sourceUrl,
				...(entry.requires ? { requires: entry.requires } : {}),
				origin: classified.origin,
				...(classified.format ? { format: classified.format } : {}),
				...(entry.provides ? { provides: entry.provides } : {}),
				catalogOrigin: entry.origin,
				copies: own.map((copy) => ({
					scope: copy.scope,
					state: copy.state,
					...(copy.version ? { version: copy.version } : {}),
					...(copy.update ? { update: copy.update } : {}),
				})),
				...(refusal ? { refusal } : {}),
			};
			// discoverHub already sorts by ref; selection is applied before the cap.
			if (packageMatches(record, options, selection, entry.triggers) && !packages.push(record)) break;
		}
	}

	const resources = new Bounded<HubComponent>(HUB_INVENTORY_LIMITS.resources);
	if (include.resources) {
		let configDir = options.configDir;
		if (!configDir) {
			try {
				configDir = pancodeConfigDir();
			} catch {
				configDir = undefined;
			}
		}
		let packageRoot: string | undefined;
		try {
			packageRoot = resolvePackageRoot();
		} catch {
			packageRoot = undefined;
		}
		const index = ownerIndex(copies, {
			cwd,
			home: options.home ?? homedir(),
			...(configDir ? { configDir } : {}),
			...(packageRoot ? { packageRoot } : {}),
		});
		const trustProjectCompatRoots = trustSetting(options.trustProjectCompatRoots);
		// Each loader enumerates its whole root set because precedence needs every
		// candidate. What is bounded here is which loaders run and what is projected.
		const inSources = (
			filePath: string | undefined,
			rows: ReadonlyArray<HubComponent>,
			loose: ReturnType<typeof looseSourceId>,
		): boolean =>
			!options.sources?.length ||
			filePath === undefined ||
			options.sources.includes(diagnosticSourceClass(filePath, rows, index, loose));
		const skillRows: HubComponent[] = [];
		const skillTriggers = new Map<string, string[]>();
		if (wants("skill")) {
			const skills = loadSkills({
				cwd,
				trustProjectCompatRoots,
				...(options.configDir ? { configDir: options.configDir } : {}),
				...(options.home ? { home: options.home } : {}),
			});
			const loose = looseSourceId(index.anchors, "skill");
			for (const skill of skills.items) {
				const row = fromSkill(skill, index);
				skillRows.push(row);
				// Authored trigger phrases are search vocabulary, never part of the row.
				const triggers = skill.metadata.triggers;
				if (Array.isArray(triggers))
					skillTriggers.set(
						row.key,
						triggers.filter((item): item is string => typeof item === "string"),
					);
			}
			for (const diagnostic of skills.diagnostics) {
				const loser =
					diagnostic.type === "collision" ? fromCollisionLoser("skill", diagnostic, skillRows, index, loose) : undefined;
				if (loser) skillRows.push(loser);
				else if (diagnostic.type !== "collision" && inSources(diagnostic.path, skillRows, loose))
					note(`skill: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
			}
		}
		const promptRows: HubComponent[] = [];
		if (wants("prompt")) {
			const prompts = loadPromptTemplates({
				cwd,
				trustProjectCompatRoots,
				...(options.home ? { home: options.home } : {}),
			});
			const loose = looseSourceId(index.anchors, "prompt");
			for (const template of prompts.items) promptRows.push(fromPrompt(template, index));
			for (const diagnostic of prompts.diagnostics) {
				const loser =
					diagnostic.type === "collision" ? fromCollisionLoser("prompt", diagnostic, promptRows, index, loose) : undefined;
				if (loser) promptRows.push(loser);
				else if (diagnostic.type !== "collision" && inSources(diagnostic.path, promptRows, loose))
					note(`prompt: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
			}
		}
		const agentRows: HubComponent[] = [];
		if (wants("agent")) {
			const agentDiagnostics: AgentRecipeDiagnostic[] = [];
			try {
				for (const recipe of discoverAgentRecipes(cwd, agentDiagnostics)) agentRows.push(fromAgent(recipe, index));
			} catch (error) {
				note(`agent: discovery failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			for (const diagnostic of agentDiagnostics) agentRows.push(fromAgentDiagnostic(diagnostic, index));
		}
		const fleetRows: HubComponent[] = [];
		if (wants("playbook")) {
			try {
				for (const listing of listPlaybooks(cwd)) fleetRows.push(fromFleet(listing, index));
			} catch (error) {
				note(`playbook: discovery failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// Audience and selection are applied per row while collecting, so the cap
		// bounds admitted rows rather than a superset that is sliced afterwards.
		for (const row of sortResources([...skillRows, ...promptRows, ...agentRows, ...fleetRows])) {
			if (!audienceAdmits(row, options) || !resourceMatches(row, options, selection, skillTriggers.get(row.key))) continue;
			if (!resources.push(row)) break;
		}
	}

	const selectedCopies = include.copies
		? copies
				.filter((copy) => copyMatches(copy, options, selection))
				.sort((a, b) => a.ref.localeCompare(b.ref) || a.scope.localeCompare(b.scope))
		: [];
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		cwd,
		audience: options.audience ?? "operator",
		packages: packages.items,
		copies: selectedCopies,
		resources: resources.items,
		diagnostics: diagnostics.items,
		truncated: {
			packages: packages.truncated,
			// Copies also supply package status and resource ownership when omitted
			// from the public copy list. Consumers must know when that evidence is partial.
			copies: copyRows.truncated,
			resources: resources.truncated,
		},
	};
}

// ---------------------------------------------------------------------------
// Explicit deeper read for one copy
// ---------------------------------------------------------------------------

export interface HubCopyInspection {
	copy: HubCopy;
	resources: Array<{
		kind: HubComponentKind;
		name: string;
		path: string;
		componentId?: string;
		description?: string;
		valid: boolean;
		diagnostics: string[];
	}>;
	ancillary: Array<{ kind: string; id: string; path: string; valid: boolean }>;
	prerequisites: HubValidationPrerequisite[];
	diagnostics: string[];
}

/**
 * Enumerate one installed copy's members through the shared validator. This
 * reads a disabled, shadowed or damaged copy too, which the runtime loaders
 * never do; it is the explicit inspection the listing deliberately avoids.
 */
export function inspectHubCopy(ref: string, options: { cwd?: string; scope?: PluginScope } = {}): HubCopyInspection {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	// Resolve precedence across both scopes before selecting the copy to inspect.
	const plugin = installedCopiesNamed(
		listInstalledPlugins(cwd, { all: true }).filter((item) => !options.scope || item.scope === options.scope),
		ref,
	)[0];
	if (!plugin) throw new Error(`pack not installed: ${ref}`);
	const copy = projectCopy(plugin, cwd);
	if (!existsSync(plugin.rootPath))
		return { copy, resources: [], ancillary: [], prerequisites: [], diagnostics: ["pack root is missing"] };
	const result = validateHubPackage(plugin.rootPath, { cwd });
	const components = new Map(
		(result.manifest?.pancode.components ?? []).map((component) => [`${component.kind}:${component.id}`, component.id]),
	);
	const resources: HubCopyInspection["resources"] = [];
	const ancillary: HubCopyInspection["ancillary"] = [];
	for (const record of result.validation.resources) {
		if (isHubComponentKind(record.kind)) {
			const componentId = record.componentRef ? components.get(record.componentRef) : undefined;
			resources.push({
				kind: record.kind,
				name: record.name,
				path: record.path,
				...(componentId && componentId !== record.name ? { componentId } : {}),
				...(record.description !== undefined ? { description: record.description } : {}),
				valid: record.valid,
				diagnostics: bounded(record.diagnostics.map((item) => item.message)),
			});
		} else ancillary.push({ kind: record.kind, id: record.name, path: record.path, valid: record.valid });
	}
	// The loader that listed the copy ran the same validator, so a message the copy already carries is not repeated.
	const onCopy = new Set(copy.diagnostics);
	return {
		copy,
		resources,
		ancillary,
		prerequisites: result.validation.prerequisites,
		diagnostics: [
			...result.diagnostics.map((item) => item.message),
			...result.validation.diagnostics.map((item) => `[${item.code}] ${item.message}`),
		]
			.filter((message) => !onCopy.has(clip(message, HUB_INVENTORY_LIMITS.message)))
			.slice(0, HUB_INVENTORY_LIMITS.copyDiagnostics),
	};
}
