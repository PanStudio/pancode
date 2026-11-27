// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { LifecycleContext } from "../../core/hub-receipts.js";
import type { PackageIdentity } from "../../core/package-identity.js";

export type PluginScope = "user" | "project";
export type PluginResourceKind = "skills" | "prompts" | "agents" | "playbooks";
export type PluginComponentKind = "prompt" | "agent" | "skill" | "playbook" | "script" | "resource" | "tool";
export type PluginResources = Partial<Record<PluginResourceKind, string>>;

export interface PluginDiagnostic {
	type: "warning" | "error";
	message: string;
	path?: string;
	/** Machine-readable reason for writer refusals; message text is unchanged. */
	code?: PluginDiagnosticCode;
	/** The reviewed fact that changed, for `stale_plan`. */
	changed?: { scope: PluginScope; id: string; fact: keyof PluginExpectedCopy; expected: unknown; observed: unknown };
}
export type PluginDiagnosticCode = "stale_plan" | "locked" | "dependents";

/**
 * One reviewed copy fact. Every field present is rechecked inside the writer's
 * lock before any write; a mismatch refuses with `stale_plan`.
 */
export interface PluginExpectedCopy {
	scope: PluginScope;
	id: string;
	/**
	 * A full snapshot (default) also fails when a fact appears or disappears.
	 * `partial` checks only the facts listed; reserved for the digest-only
	 * update path that never reviewed the other facts.
	 */
	partial?: boolean;
	/** Install record present in that scope's state.json. */
	recorded: boolean;
	/** Observed full-tree digest, or absent. */
	tree: "absent" | string;
	enabled?: boolean;
	recordedDigest?: string;
	kind?: HubEntryKind;
	trust?: PackageTrust;
	/** Compared JSON-equal, so identical bytes with a different origin still stale a plan. */
	origin?: PluginOrigin;
}
export interface PluginExpectedState {
	copies: PluginExpectedCopy[];
}

export interface PluginComponent {
	kind: PluginComponentKind;
	id: string;
	path: string;
	requires?: string[];
}

export interface PancodePluginConfiguration {
	manifestVersion: 1;
	/** Absent in portable bundles means plugin. All kinds share the package lifecycle. */
	kind?: HubEntryKind;
	requires?: HubRequirementRef[];
	compatibility?: { pancode?: string };
	resources: PluginResources;
	components: PluginComponent[];
}

/** Standard identity stays canonical; `pancode` is the validated runtime projection. */
export interface PluginManifest {
	$schema: string;
	name: string;
	version?: string;
	description?: string;
	author?: { name?: string; email?: string; url?: string };
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	extensions?: Record<string, Record<string, unknown>>;
	pancode: PancodePluginConfiguration;
}

export interface PluginCandidate {
	path: string;
	manifestPath?: string;
	manifest?: PluginManifest;
	valid: boolean;
	diagnostics: PluginDiagnostic[];
	contentDigest?: string;
	manifestDigest?: string;
}

/** Format of a foreign package as it was found on disk; author labels never set this. */
export type ForeignPackageFormat = "portable" | "claude-code" | "codex" | "agent-skill";
/**
 * `interop` is a package imported from an installed local agent; `import` is an
 * explicit source path or GitHub tree. Both always carry foreign trust.
 */
export type PluginOrigin =
	| string
	| { kind: "local" | "catalog" | "github"; source: string; commit?: string }
	| { kind: "interop"; host: string; source: string; format?: ForeignPackageFormat; marketplace?: string }
	| {
			kind: "import";
			source: string;
			transport: "local" | "github";
			format: ForeignPackageFormat;
			/** The exact commit a GitHub import was fetched at. */
			commit?: string;
			host?: string;
			marketplace?: string;
	  };
export function isForeignPluginOrigin(origin: PluginOrigin | undefined): boolean {
	return typeof origin === "object" && (origin.kind === "interop" || origin.kind === "import");
}
export type PackageTrust = "trusted" | "foreign";

export interface PluginProvenance {
	id: string;
	scope: PluginScope;
	sourcePath?: string;
	canonicalRoot: string;
	manifestDigest: string;
	contentDigest: string;
}

export interface InstalledPlugin {
	id: string;
	kind?: HubEntryKind;
	trust?: PackageTrust;
	/** Where the install record says the package came from. */
	origin?: PluginOrigin;
	name: string;
	version: string;
	description: string;
	scope: PluginScope;
	rootPath: string;
	manifestPath: string;
	enabled: boolean;
	valid: boolean;
	compatible: boolean;
	effective: boolean;
	/** Set on a project copy in a workspace whose project plugins the operator has not approved. */
	trustBlocked?: true;
	loadable: boolean;
	resources: PluginResources;
	manifest?: PluginManifest;
	provenance?: PluginProvenance;
	observedContentDigest?: string;
	overriddenBy?: PluginScope;
	diagnostics: PluginDiagnostic[];
}

export interface PluginResourceRoot {
	owner?: PackageIdentity;
	id: string;
	scope: PluginScope;
	path: string;
	rootPath: string;
	source: string;
	provenance: PluginProvenance;
	generation: number;
	trust?: PackageTrust;
}

export interface PluginListOptions {
	cwd?: string;
	scope?: PluginScope;
	all?: boolean;
}

export interface PluginMutationOptions extends PluginListOptions {
	lifecycle?: LifecycleContext;
	expect?: PluginExpectedState;
}

export interface PluginInstallOptions extends PluginMutationOptions {
	force?: boolean;
	expectedDigest?: string;
	expectedId?: string;
	expectedVersion?: string;
	origin?: PluginOrigin;
	trust?: PackageTrust;
	expectedKind?: HubEntryKind;
	/** Who answers for the package; defaults to the GitHub owner of the origin, else local. */
	publisher?: string;
}

/** One kind-aware publication seam for PanHub and interop adapters. */
export interface HubPackageInstallInput extends Omit<PluginInstallOptions, "expectedKind"> {
	kind: HubEntryKind;
	sourcePath: string;
	scope: PluginScope;
	origin: PluginOrigin;
	trust: PackageTrust;
}

export interface PluginMutationResult {
	plugin?: InstalledPlugin;
	/** The content digest an install wrote into its record, for approving exactly that record. */
	contentDigest?: string;
	removed?: { id: string; scope: PluginScope; path: string };
	recovery?: { stateBackup?: string; packageBackup?: string };
	diagnostics: PluginDiagnostic[];
}

export type PluginInstallResult = PluginMutationResult;

interface PluginInstallFacts {
	installedAt: string;
	source: string;
	origin?: PluginOrigin;
	contentDigest: string;
	trust?: PackageTrust;
	publisher: string;
}

export type PluginInstallRecord = PluginInstallFacts & { kind?: HubEntryKind };

export interface PluginState {
	version: 1;
	disabled: string[];
	installed: Record<string, PluginInstallRecord>;
}

export interface PluginSnapshot {
	version: 1;
	generation: number;
	cwd: string;
	digest: string;
	packages: ReadonlyArray<InstalledPlugin>;
	resourceRoots: Readonly<Record<PluginResourceKind, ReadonlyArray<PluginResourceRoot>>>;
}

import type { HubEntryKind, HubRequirementRef } from "../resources/hub-types.js";
