// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `runtime` block of an extension manifest at `api: 2`. Everything an
 * extension may do is declared here, so discovery and review stay code-free:
 * registration in code must match these lists exactly.
 */
import type {
	ExtensionContentAccess,
	ExtensionHookPoint,
	ExtensionObservationEventV2,
	WorkspaceRegion,
} from "../extension/public-api-v2.js";

export type ExtensionSlot = "status" | "band" | "card" | "toast" | "panel" | "dock" | "interview";

export interface ExtensionCommandDeclarationV2 {
	name: string;
	description: string;
	timeoutMs: number;
	/** Bundle only: this command owns `/<plugin>:<name>` in place of the package's prompt of that name. */
	replaces?: "prompt";
	/**
	 * A bare `/<alias>` the operator may type for this command. The host refuses it while a built-in
	 * command, a loaded prompt or another extension holds the name.
	 */
	alias?: string;
}

export interface ExtensionHookDeclaration {
	on: ExtensionHookPoint;
	/** Tool names the hook matches; absent means every tool at a tool point. */
	tools?: string[];
	timeoutMs: number;
	/** A gate declares how it fails. `block` makes a missed deadline or a thrown handler refuse the call. */
	onTimeout: "pass" | "block";
	onError: "pass" | "block";
}

export interface ExtensionRuntimeToolDeclaration {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/**
	 * `read` is admitted only when the package declares neither exec nor a write root beyond its store;
	 * `write` only when it declares a workspace write root and no exec, so its runtime can change files
	 * but run no program.
	 */
	actionClass: "read" | "write" | "execute";
	/**
	 * The call changes no state, so a successful one never resets another call's
	 * repeat count in the loop guard. Separate from `actionClass`: a package that
	 * writes its own records must declare every tool `execute`, its readers too.
	 */
	readOnly: boolean;
	/** Identical arguments have the same effect, so an identical repeat is a loop candidate (F-C13). */
	idempotent: boolean;
	timeoutMs: number;
}

export interface ExtensionWorkspaceDeclaration {
	id: string;
	title: string;
	regions: Array<WorkspaceRegion | "islands">;
	/** Where the board region is drawn. */
	board?: "band" | "island";
	/** Package-relative path of the skin JSON, validated at discovery. */
	skin?: string;
	/** Leader menu entries live while the workspace is active. */
	keys?: Array<{ key: string; action: string; label: string }>;
}

export interface ExtensionPermissionsDeclaration {
	fs: {
		/** `package` is always readable. */
		read: Array<"workspace" | "home" | string>;
		write: Array<"store" | string>;
	};
	exec: boolean;
	net: boolean;
}

/** Platforms a pinned binary may name a download for. */
export type ExtensionBinaryPlatform = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";

/** One platform's release asset, verified by the hash of the bytes as downloaded. */
export interface ExtensionBinaryDownload {
	url: string;
	sha256: string;
	archive: "raw" | "zip" | "tar.gz";
	/** Path of the executable inside a zip or tar.gz; absent for `raw`. */
	member?: string;
}

/**
 * A third-party program at one version, downloaded and verified at install and
 * run by the host outside the runtime sandbox, only through `ctx.binaries` and
 * `ctx.pane`. A copy on PATH whose version meets `minimumVersion` is preferred.
 */
export interface ExtensionBinaryDeclaration {
	name: string;
	version: string;
	/** SPDX identifier of the upstream license. */
	license: string;
	homepage: string;
	minimumVersion: string;
	versionArgs: string[];
	/** Environment keys a call may set; every other key is the host's safe tool environment. */
	env: string[];
	downloads: Partial<Record<ExtensionBinaryPlatform, ExtensionBinaryDownload>>;
	/** License or notice files fetched beside the binary, pinned like it. */
	documents: Array<{ name: string; url: string; sha256: string }>;
}

/** A global key that presses one of the package's actions, outside any workspace. */
export interface ExtensionKeyDeclaration {
	/** `alt+<letter>`; the leader menu gets the same letter. */
	key: string;
	action: string;
	label: string;
}

export interface ExtensionConfigField {
	key: string;
	type: "string" | "number" | "boolean";
	default: string | number | boolean;
	description: string;
	/** A string field that lists options is a picker over exactly those values. */
	options?: string[];
}

export interface ExtensionRuntimeDeclarationV2 {
	api: 2;
	entrypoint: string;
	commands: ExtensionCommandDeclarationV2[];
	events: Array<Exclude<ExtensionObservationEventV2, "tick">>;
	/** Tick interval in milliseconds, at least 5000; absent when the extension declares no tick. */
	tickMs?: number;
	/** Workspace-relative globs the host watches for `fs_changed`. */
	watch: string[];
	hooks: ExtensionHookDeclaration[];
	tools: ExtensionRuntimeToolDeclaration[];
	/**
	 * Declared tools whose schemas the session attaches to every request in
	 * place of the gateway, so a hook's `require_tool` can pin the provider's
	 * tool choice to one (B2). The set belongs to the extension generation and
	 * never to a turn or a template: a per-turn set would move the provider
	 * prefix each time it changed (#423). Absent when nothing is promoted.
	 */
	promote?: string[];
	ui: ExtensionSlot[];
	workspaces: ExtensionWorkspaceDeclaration[];
	access: ExtensionContentAccess[];
	permissions: ExtensionPermissionsDeclaration;
	state: { session: boolean; store: boolean };
	/** Host services reachable over the extension IPC only after operator consent. */
	services?: ExtensionServicesDeclaration;
	config: ExtensionConfigField[];
	/** Pinned external programs; absent when none, which keeps existing declarations stable. */
	binaries?: ExtensionBinaryDeclaration[];
	/** Global keys; absent when none. */
	keys?: ExtensionKeyDeclaration[];
}

/**
 * A model the operator assigns after install. The package names only the
 * spend it may reach; the target and model are the operator's choice.
 */
export interface ExtensionModelServiceDeclaration {
	/** Input plus output tokens one session may spend across every completion. */
	sessionTokens: number;
	/** The output ceiling one completion may ask for. */
	maxOutputTokens: number;
}

/** Store tags the package may reach. A write tag is readable too. */
export interface ExtensionStoreServiceDeclaration {
	read: string[];
	write: string[];
}

export interface ExtensionServicesDeclaration {
	embedding: boolean;
	/** One terminal pane in the host's dock, running a declared binary. */
	pane?: boolean;
	model?: ExtensionModelServiceDeclaration;
	store?: ExtensionStoreServiceDeclaration;
}

/**
 * The part of a declaration the operator consents to. Its canonical JSON is
 * hashed into the capability envelope: bytes may change freely inside an
 * approved envelope, and a wider one asks again.
 */
export type ExtensionCapabilityEnvelope = Pick<
	ExtensionRuntimeDeclarationV2,
	"hooks" | "ui" | "watch" | "access" | "permissions" | "events" | "tickMs"
> & {
	commands: string[];
	/** `<plugin>:<command>` prompt names the package's commands take over; absent when none. */
	takesOver?: string[];
	/**
	 * Host-held state the package keeps: per-session values and the cross-session
	 * store. Absent when it keeps neither, which keeps those digests stable.
	 */
	state?: ExtensionRuntimeDeclarationV2["state"];
	/** Absent when the package declares no service, which keeps those digests stable. */
	services?: ExtensionServicesDeclaration;
	tools: Array<Pick<ExtensionRuntimeToolDeclaration, "name" | "actionClass">>;
	/** Tools attached to every request; absent when none, which keeps existing digests stable. */
	promote?: string[];
	workspaces: Array<Pick<ExtensionWorkspaceDeclaration, "id" | "regions" | "board" | "keys">>;
	/** Bare command names the package claims; absent when none. */
	aliases?: string[];
	/** Pinned programs by name, version, probe args and per-platform hash/member; absent when none. */
	binaries?: Array<
		Pick<ExtensionBinaryDeclaration, "name" | "version" | "minimumVersion" | "versionArgs" | "env"> & {
			downloads: Record<string, { sha256: string; member?: string }>;
		}
	>;
	/** Global keys; absent when none. */
	keys?: ExtensionKeyDeclaration[];
};
