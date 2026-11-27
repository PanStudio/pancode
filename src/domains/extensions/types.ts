// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type {
	ExtensionCapabilities,
	ExtensionDiagnostic,
	ExtensionRuntimeDeclarationV2,
	PancodeExtensionManifest,
} from "@pancode/sdk/pack";

export type ExtensionScope = "user" | "project";

/**
 * Where a loaded package came from. `dev` is a folder the operator develops
 * in: loaded by the terminal for one session after the operator approves its
 * capability envelope, from a private copy taken at each reload, and never
 * written to install state.
 */
export type ExtensionLoadScope = ExtensionScope | "dev";

export interface ExtensionProvenance {
	id: string;
	scope: ExtensionLoadScope;
	/** Path recorded in install state, when known. */
	sourcePath?: string;
	/** Canonical filesystem identity of the installed package root. */
	canonicalRoot: string;
	/** SHA-256 of the manifest bytes covered by the installed-tree digest. */
	manifestDigest: string;
	/** Installed-tree digest recorded at install and reverified on this load. */
	contentDigest: string;
}

export interface InstalledExtension {
	/** The plugin this extension serves; a separate package with its own install and lifecycle. */
	plugin?: string;
	/**
	 * Prompt names the served plugin provides while it is installed and in
	 * effect; the only names a `replaces: prompt` command may take over.
	 */
	pluginPrompts?: readonly string[];
	/**
	 * Source label (`plugin:<scope>:<id>`) the served plugin's prompts carry while
	 * it is loadable. A takeover applies only when the prompt that wins a name
	 * has this source, so an operator or project prompt of that name keeps it.
	 */
	pluginSource?: string;
	runtimeV2?: ExtensionRuntimeDeclarationV2;
	id: string;
	name: string;
	version: string;
	description: string;
	capabilities?: ExtensionCapabilities;
	scope: ExtensionLoadScope;
	rootPath: string;
	manifestPath: string;
	enabled: boolean;
	/** Whether the complete manifest and the installed tree are valid. */
	valid: boolean;
	/** Whether this package admits the running PanCode version. */
	compatible: boolean;
	effective: boolean;
	/** Set on a project copy in a workspace whose project extensions the operator has not approved. */
	trustBlocked?: true;
	/** A dev package whose capability envelope the operator has not approved this session. */
	consentPending?: true;
	/** Unloaded for this session by `/extensions mute`; install state is untouched. */
	muted?: true;
	/** For a dev package, the folder the operator develops in; `rootPath` is the private copy. */
	devSource?: string;
	/** The single admission decision for extension-owned tools and hooks. */
	loadable: boolean;
	/** Present exactly when the installed tree and manifest bytes were reverified. */
	provenance?: ExtensionProvenance;
	/** Digest observed while checking installed content on this load. */
	observedContentDigest?: string;
	overriddenBy?: ExtensionLoadScope;
	diagnostics: ExtensionDiagnostic[];
}

export type LoadableExtension = InstalledExtension & { loadable: true; provenance: ExtensionProvenance };

export function isLoadableExtension(entry: InstalledExtension): entry is LoadableExtension {
	return entry.loadable && entry.provenance !== undefined;
}

export interface ExtensionCandidate {
	path: string;
	manifestPath?: string;
	manifest?: PancodeExtensionManifest;
	valid: boolean;
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionHookSource {
	version?: string;
	provenance: ExtensionProvenance;
	/** SHA-256 of the captured hooks.yaml bytes. */
	declarationsDigest: string;
	/** Parsed captured YAML, or an empty list when parsing failed. */
	declarations: unknown;
	parseError?: string;
}

export interface ExtensionSnapshotDiagnostics {
	entries: ReadonlyArray<ExtensionDiagnostic & { extensionId?: string }>;
	truncated: number;
}

export interface ExtensionSnapshot {
	version: 1;
	generation: number;
	cwd: string;
	builtAt: string;
	/** Content identity; generation, timestamp, and diagnostic text are excluded. */
	digest: string;
	packages: ReadonlyArray<InstalledExtension>;
	hookSources: ReadonlyArray<ExtensionHookSource>;
	diagnostics: ExtensionSnapshotDiagnostics;
}

export type ExtensionReloadRejectionReason = "build-failed" | "reentrant" | "stale" | "workspace-changed";

export interface ExtensionReloadRejection {
	status: "rejected";
	reason: ExtensionReloadRejectionReason;
	/** Generation that remains committed. */
	generation: number;
	diagnostics: ExtensionSnapshotDiagnostics;
}

/**
 * A fully built and validated generation that has not been published. The
 * bundle holds at most one candidate at a time. `publish` is one reference
 * assignment that never validates, refuses, throws, or calls out; the caller
 * checks `current()` on the same stack immediately before it. `discard`
 * releases the candidate without any visible change.
 */
export interface ExtensionReloadCandidate {
	generation: number;
	previousGeneration: number;
	snapshot: ExtensionSnapshot;
	/** False when the candidate digest equals the committed digest. */
	changed: boolean;
	added: ReadonlyArray<string>;
	removed: ReadonlyArray<string>;
	modified: ReadonlyArray<string>;
	/** True while this is the in-flight candidate and the committed snapshot it was diffed against is still live. */
	current(): boolean;
	publish(): void;
	discard(): void;
}

export type ExtensionReloadPrepareResult =
	| { status: "prepared"; candidate: ExtensionReloadCandidate }
	| ExtensionReloadRejection;

export interface ExtensionReloadCommitted {
	status: "committed";
	generation: number;
	previousGeneration: number;
	changed: boolean;
	digest: string;
	added: ReadonlyArray<string>;
	removed: ReadonlyArray<string>;
	modified: ReadonlyArray<string>;
	diagnostics: ExtensionSnapshotDiagnostics;
}

export type ExtensionReloadResult = ExtensionReloadCommitted | ExtensionReloadRejection;

export interface ExtensionListOptions {
	lifecycle?: import("../../core/hub-receipts.js").LifecycleContext;
	scope?: ExtensionScope;
	cwd?: string;
	all?: boolean;
}

/** Where an installed extension came from, kept so a later update resolves the durable source and not a staging path. */
export interface ExtensionOrigin {
	kind: "local" | "catalog" | "github";
	source: string;
	/** The exact commit a remote source was fetched at. */
	commit?: string;
}

export interface ExtensionInstallOptions extends ExtensionListOptions {
	force?: boolean;
	/** Optional hub pin, rechecked against the staged tree by the canonical writer. */
	expectedDigest?: string;
	expectedId?: string;
	expectedVersion?: string;
	/**
	 * The capability envelope the operator reviewed. A digest binds the install to
	 * exactly that envelope; `null` says the reviewed package declared none. Absent
	 * means the caller reviewed nothing to bind.
	 */
	expectedEnvelopeDigest?: string | null;
	/** Durable source recorded in install state when the staged `sourcePath` is only a working copy. */
	source?: string;
	origin?: ExtensionOrigin;
	/** Who answers for the package; defaults to the GitHub owner of the origin, else local. */
	publisher?: string;
}

export interface ExtensionInstallResult {
	extension?: InstalledExtension;
	/** The content digest this install wrote into its record, for approving exactly that record. */
	contentDigest?: string;
	recovery?: { stateBackup?: string; packageBackup?: string };
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionMutationResult {
	extension?: InstalledExtension;
	removed?: { id: string; scope: ExtensionScope; path: string };
	recovery?: { stateBackup?: string; packageBackup?: string };
	diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionState {
	version: 1;
	disabled: string[];
	installed: Record<
		string,
		{
			installedAt: string;
			source?: string;
			origin?: ExtensionOrigin;
			contentDigest?: string;
			/** Digest of the capability envelope the operator reviewed at install; absent for a package with no api 2 runtime. */
			envelopeDigest?: string;
			/** The operator's choices for the host services the envelope declares. */
			services?: { model?: ExtensionModelAssignment };
			publisher: string;
		}
	>;
}

/**
 * The model the operator assigned to an extension's `runtime.services.model`, with the endpoint it
 * resolved to when they did. A call whose route resolves anywhere else is refused until they assign again.
 */
export interface ExtensionModelAssignment {
	target: string;
	model: string;
	endpoint: string;
	/** A budget the operator lowered below the declared one. */
	sessionTokens?: number;
	assignedAt: string;
}
