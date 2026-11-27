// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DynamicToolName } from "../../core/tool-names.js";
import type {
	McpBuiltinSource,
	McpClient,
	McpClientOptions,
	McpCompletion,
	McpCompletionReference,
	McpPromptListing,
	McpPromptResult,
	McpResourceCount,
	McpResourceListing,
	McpResourceRead,
	McpServerCatalog,
	McpServerSpec,
	McpSkillListing,
	McpSkillsTransport,
	McpSurface,
	McpSurfaceStatus,
	McpTeardownOutcome,
	McpToolDescriptor,
	McpToolListing,
	McpTrustActionClass,
	ResolvedMcpServer,
} from "../../domains/gateway/mcp/index.js";
import type { ActionClass } from "../../domains/safety/action-classifier.js";
import type { WorkerMcpAttestation } from "../../domains/safety/worker-permit.js";
import type { StoreBackend } from "../../domains/store/index.js";
import type { ToolRegistry } from "../registry-contract.js";
import type { ToolSpec } from "../tool-spec.js";
import type { McpStoreAccess } from "./mcp-store-references.js";

/** An ACP client's declaration lives only for its hosted session. */
export interface McpClientServerSpec {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

export type GatewayMcpServer = ResolvedMcpServer | (Omit<ResolvedMcpServer, "scope"> & { scope: "client" });

/**
 * Where a server's tool metadata came from. Deliberately separate from
 * `status`: a catalog read off disk says nothing about whether a process is
 * running, and conflating the two would let an offline answer look like a live
 * connection.
 */
type McpCatalogProvenance = "live" | "cached" | "missing";

/** What the gateway's find listing says about one declared server. */
export interface McpServerListing {
	id: string;
	scope: GatewayMcpServer["scope"];
	/** connected: launched this session; failed: launched and lost; trusted: not launched yet. */
	status: "connected" | "trusted" | "failed" | "untrusted" | "stale";
	actionClass: McpTrustActionClass;
	/** Why the server is not usable, for every status but connected and trusted. */
	reason?: string;
	/** The exact command that makes an untrusted or stale server usable. */
	remedy?: string;
	/** The same remedy for an interactive session. */
	interactiveRemedy?: string;
	/** Registered tool names, for a connected server. */
	tools?: string[];
	/** The server's tool list was cut at the client cap. */
	truncated?: boolean;
	/** Tool names the server offered that cannot be carried as registry names. */
	unregistrable?: string[];
	/** Provenance of this server's tool metadata, for a trusted server only. */
	catalog?: McpCatalogProvenance;
	/** Tools this server's catalog records; the names themselves are in the capability list. */
	catalogCount?: number;
	/** The command that lists this server's tools when its catalog is missing or stale. */
	catalogRemedy?: string;
	/** The cached catalog outlived the server's own `ttlMs`; its tools are shown but may have changed. */
	catalogStale?: true;
	/** The server declares resources, so `mcp_<id>__:list_resources` and `:read_resource` serve it. */
	resources?: true;
	/** What the server's last resources/list gave, live or recorded. */
	resourceCount?: McpResourceCount;
	/** Prompts the server lists, live or recorded; each is the slash command `/<id>:<prompt>`. */
	prompts?: number;
	/** The server's own instructions, live or cached: server-written, at most 2 KiB, never in the system prompt. */
	instructions?: string;
	/**
	 * The second approval of a trusted server, separate from `status` as the
	 * catalog is: `status` says whether a process runs, `surface` whether the
	 * tools it serves may be called. Every status but approved lists the tools
	 * for inspection and refuses each call with `reason` and `remedy`.
	 */
	surface?: McpServerSurfaceListing;
}

/** A trusted server's surface approval as discovery lists it. */
export interface McpServerSurfaceListing extends McpSurfaceStatus {
	/** The command that approves the served surface, for every status but approved. */
	remedy?: string;
	/** This session recorded a user-scope server's surface on first sight. */
	recorded?: true;
}

interface McpListing {
	servers: McpServerListing[];
	/** Config and trust-file problems, verbatim. */
	diagnostics: string[];
}

/** One MCP capability as discovery lists it, from a live listing or a cached catalog. */
export interface McpCatalogEntry {
	name: DynamicToolName;
	description: string;
	actionClass: McpTrustActionClass;
}

interface McpDiscoveryNote {
	serverHint?: "read-only" | "destructive";
	/** Set once the server refused this capability under its own policy this session. */
	unavailable?: string;
}

interface McpCatalog extends McpListing {
	entries: McpCatalogEntry[];
	/** Trusted servers with no usable catalog, so discovery can name what it could not answer. */
	missing: string[];
	/** Running servers that announced a tool change since their last listing; listing one again launches nothing. */
	changed?: string[];
}

/** One MCP capability's full metadata, enough to describe it without a connection. */
interface McpCapabilityMetadata {
	name: string;
	/** The declared server that owns the name, by the longest-prefix rule. */
	serverId: string;
	description: string;
	parameters: Record<string, unknown>;
	actionClass: McpTrustActionClass;
	provenance: "live" | "cached";
	/** The catalog this came from recorded only part of the server's tools. */
	truncated: boolean;
	/** The recorded catalog outlived the server's own `ttlMs`. */
	catalogStale?: true;
}

interface McpMetadataResult {
	metadata: McpCapabilityMetadata | null;
	/** Why the metadata is unavailable when `metadata` is null. */
	reason?: string;
}

interface McpRefreshResult {
	/** The server's listing after the attempt, or null when no such server is declared. */
	listing: McpServerListing | null;
	/** Why the refresh listed nothing new. */
	reason?: string;
}

/** One MCP prompt as a slash command `/<serverId>:<name>`, from a live listing or the recorded catalog. */
export interface McpPromptCommand {
	serverId: string;
	name: string;
	/** Server-written and neutralized, bounded for one menu line. */
	title: string | null;
	description: string;
	arguments: Array<{ name: string; description: string; required: boolean }>;
	/** The recorded list outlived the server's `prompts/list` ttlMs; shown, but it may have changed. */
	stale?: true;
}

/** The answer of a source request that may be refused; `error` reads as one line for the operator or the model. */
export type McpSourceAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

export interface McpLaunchOptions {
	signal?: AbortSignal;
	/**
	 * The calling turn is read-only. Starting a server runs its code before any
	 * call reaches admission, so a server trusted above read is never started (Z1).
	 */
	readOnly?: boolean;
}

export interface McpSkillAccessOptions extends McpLaunchOptions {
	/** List the skills again now, as after a served file failed verification. */
	relist?: boolean;
}

interface McpEnsureResult {
	spec: ToolSpec | null;
	/** Why the capability is unavailable when `spec` is null. */
	reason?: string;
}

export interface McpCapabilitySourceOptions {
	/** Project root the config is resolved against and the launched servers are contained in. */
	cwd: string;
	/** Override of the PanCode config directory that holds the user config and the trust file. */
	configDir?: string;
	/** Override for the builtin server manifest and the CLI that serves it; defaults to the installed package's. */
	builtin?: McpBuiltinSource;
	registry: ToolRegistry;
	/** Request timeout applied when a declaration names none. */
	requestTimeoutMs?: number;
	/** Test seam: the client constructor. */
	clientFactory?: (spec: McpServerSpec, options: McpClientOptions) => McpClient;
	/** False for a worker: it may read recorded catalogs but never writes operator-owned state. */
	persistCatalog?: boolean;
	/**
	 * A worker's admitted MCP surface. Only the attested declarations are
	 * launchable, each only while its digest still matches, and each tool runs
	 * under the class admission sealed into the permit.
	 */
	admitted?: WorkerMcpAttestation;
	/**
	 * The worker's own tree, where its project servers start. A project
	 * declaration's cwd keeps its place relative to the repository but lands
	 * here, inside the sandbox's write roots, instead of in the checkout that
	 * admission read the declaration from.
	 */
	launchRoot?: string;
	/**
	 * An operator attends this session, so the first listing of a user-scope
	 * server with no recorded surface records it. Defaults to the interactive
	 * terminal marker the CLI sets for a TUI launch; a headless run, a worker
	 * and `pancode mcp test` never record one on their own.
	 */
	attended?: boolean;
	/**
	 * What this session may write in the store, for store references in
	 * declared path arguments and the builtin `store` server's options: the main
	 * session every tag, a worker its granted tags. Absent means no access, so
	 * every write reference is refused and the `store` server writes no tag.
	 */
	store?: McpStoreAccess;
	/** Test seam: the store backend references resolve and commit through. */
	openStoreBackend?: (cwd: string) => Promise<StoreBackend>;
}

export interface McpCapabilitySource {
	/**
	 * Connect client supplied stdio servers without persisting their declarations or catalogs. With `start`
	 * false they are registered unstarted; their trust is unknown, so a read-only turn refuses to start them.
	 */
	attachClientServers(servers: ReadonlyArray<McpClientServerSpec>, options?: { start?: boolean }): Promise<void>;
	/** Tear down only the servers supplied by the ACP client for this session. */
	detachClientServers(): Promise<void>;
	/** Launch every trusted server not yet launched, register its tools, and describe every declared server. */
	list(options?: { signal?: AbortSignal }): Promise<McpListing>;
	/**
	 * Every declared server and the capabilities its metadata records, without
	 * constructing a client. A trusted server that has neither been launched this
	 * session nor left a valid catalog is reported as missing, not launched.
	 */
	catalog(): McpCatalog;
	/** One capability's metadata from the registry or the catalog, again without constructing a client. */
	metadata(name: string): McpMetadataResult;
	/**
	 * Launch one declared trusted server, register its tools, and publish its
	 * catalog. With `readOnly`, only a server trusted as read is launched.
	 */
	refresh(id: string, options?: McpLaunchOptions): Promise<McpRefreshResult>;
	/** Ids of every declared server, trusted or not, for validating a scoped discovery request. */
	declaredIds(): string[];
	/**
	 * Make `name`'s server available (launching it when trusted) and return its
	 * registered spec. With `readOnly`, only a server trusted as read is launched.
	 */
	ensure(name: string, options?: McpLaunchOptions): Promise<McpEnsureResult>;
	/**
	 * The pending line naming what the owning server's live listing changed since
	 * its recorded catalog, handed out once, or null.
	 */
	takeCatalogChange(name: string): string | null;
	/**
	 * The instructions of the declared server that owns `name`, live or from its
	 * catalog, already unable to open a host frame; null when it gave none.
	 */
	serverInstructions(name: string): string | null;
	/**
	 * One sentence of provenance and authority for describe, or null for a name this source does not own.
	 * `actionClass` is the class describe shows for the tool (a worker's sealed class); absent, the
	 * tool's own class is resolved from the declaration and its listing.
	 */
	authorityNote(name: string, actionClass?: ActionClass): string | null;
	/**
	 * The declared server that owns `name` under the longest-prefix rule, or
	 * null when no declaration owns it. Callers that scope results to one server
	 * must ask rather than testing the `mcp_<id>__` prefix themselves: server ids
	 * may contain `__`, so with declarations `a` and `a__b` the prefix test
	 * claims `a__b`'s capabilities for `a`.
	 */
	ownerIdOf(name: string): string | null;
	/**
	 * What discovery can add to a capability's enforced action class: the
	 * server's own read-only or destructive annotation, and a refusal under the
	 * server's policy recorded this session. Null for a name this source does not own.
	 */
	discoveryNote(name: string): McpDiscoveryNote | null;
	/** The pinned launch identity of the declared server owning `name`, for information-flow recipients; null when unowned. */
	transportOf(name: string): string | null;
	/** The surface server `id` served at its last listing this session, or null when it has not been listed. */
	servedSurface(id: string): McpSurface | null;
	/**
	 * Every launch-trusted server's prompts, live or from its catalog, without
	 * launching anything. A running server that announced a prompt change lists
	 * them again in the background.
	 */
	promptCommands(): McpPromptCommand[];
	/** Ids of launch-trusted servers that declare resources, live or as recorded, for `@<id>:<uri>` mentions. */
	resourceServerIds(): string[];
	/** The server's resources and templates, for completion; launches a trusted server, cached per its ttlMs. */
	listResources(id: string, options?: McpLaunchOptions): Promise<McpSourceAnswer<McpResourceListing>>;
	/** Read one resource for a mention; the same gates as `mcp_<id>__:read_resource`. */
	readResource(id: string, uri: string, options?: McpLaunchOptions): Promise<McpSourceAnswer<McpResourceRead>>;
	/** `prompts/get` for a slash command; launches a trusted server and needs its approved surface. */
	getPrompt(
		id: string,
		name: string,
		args: Record<string, string>,
		options?: McpLaunchOptions,
	): Promise<McpSourceAnswer<McpPromptResult>>;
	/** `completion/complete` against a connected server that declares completions; never launches. */
	complete(
		id: string,
		ref: McpCompletionReference,
		argument: { name: string; value: string },
		context?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<McpCompletion | null>;
	/**
	 * Skills over MCP on declared server `id`: launch it when trusted, under the
	 * same read-only rule `ensure` applies, list its skills again once the last
	 * listing's `ttlMs` has passed, and return the transport its skill requests
	 * go through. Never reads a skill file.
	 */
	skillAccess(id: string, options?: McpSkillAccessOptions): Promise<McpSkillAccess>;
	/** The skills server `id` listed this session, or null when it has listed none. */
	servedSkills(id: string): McpSkillListing | null;
	/** Ids of the servers launched this session and still open. */
	connectedIds(options?: { readyOnly?: boolean }): string[];
	/**
	 * Close every launched client. Idempotent. A process group that survived
	 * the client's own SIGKILL is reported here and on stderr, with its pgid,
	 * and is never signalled again by the gateway: the client already did
	 * everything it may do, and a second signal from this side could hit a
	 * recycled pid.
	 */
	close(): Promise<McpCloseReport>;
	/** Every teardown outcome recorded so far, for evidence. */
	teardownReports(): ReadonlyArray<McpTeardownReport>;
}

export interface McpTeardownReport {
	id: string;
	outcome: McpTeardownOutcome;
}

export interface McpCloseReport {
	/** Servers whose process group outlived the teardown, with the pgid the client observed. */
	incomplete: Array<{ id: string; pgid: number; boundMs: number }>;
}

export interface OwnedConnection {
	ready: Promise<void>;
	close(): Promise<McpTeardownOutcome>;
}

export interface ServerState {
	recovery?: Promise<void>;
	refreshing?: Promise<void>;
	listed?: boolean;
	declaration: GatewayMcpServer;
	client: McpClient | null;
	connection: OwnedConnection | null;
	tools: McpToolDescriptor[];
	truncated: boolean;
	/** The last tool listing, kept so a later prompt listing republishes the catalog whole. */
	listing?: McpToolListing;
	/** The live prompt list; absent until listed, or when the server declares no prompts. */
	prompts?: McpPromptListing;
	/** The prompt listing in flight, shared by everyone who asks. */
	promptsListing?: Promise<void>;
	/** The last resource listing and when it was taken, for completion within its ttlMs. */
	resourceList?: { listing: McpResourceListing; atMs: number };
	registered: DynamicToolName[];
	unregistrable: string[];
	failure: string | null;
	/**
	 * The catalog read for this declaration, or null for a miss. Undefined until
	 * looked up. Memoized for the same reason the declarations themselves are
	 * snapshotted: one session answers discovery from one consistent view, and a
	 * find is not the place to re-stat every cache file.
	 */
	catalog: McpServerCatalog | null | undefined;
	/**
	 * Tools this session's server refused under its own policy, by tool name,
	 * with the server's code. Discovery reports them as unavailable; a recovered
	 * or relaunched server starts with a clean slate.
	 */
	refused: Map<string, string>;
	/**
	 * What the first live listing changed against the recorded catalog this
	 * session may already have shown, until the server's next result carries it.
	 */
	catalogChange?: string;
	/** The surface of the last listing and how it stands against approval; absent until listed. */
	surface?: { served: McpSurface; status: McpServerSurfaceListing };
	/** The tags the builtin `store` server was started with --write-tag for; absent for any other server. */
	launchWriteTags?: ReadonlyArray<string>;
	/** Set to close the server and start it again at the next discovery, with its options computed afresh. */
	relaunch?: boolean;
	/** This session's skills listing of a server that serves the skills extension; absent until listed. */
	skills?: { listing: McpSkillListing; listedAtMs: number } | { failure: string; listedAtMs: number };
	/** The skills listing in flight, shared by everyone waiting on it. */
	skillsListing?: Promise<void>;
}

/** A declared server's skills transport, launched and listed, or why it has none. */
export type McpSkillAccess =
	| { transport: McpSkillsTransport; listing: McpSkillListing; declaration: ResolvedMcpServer }
	| { transport: null; reason: string };
