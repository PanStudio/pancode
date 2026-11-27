// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DynamicToolName } from "../../core/tool-names.js";
import type {
	McpClient,
	McpClientOptions,
	McpCompletion,
	McpCompletionReference,
	McpElicitationHost,
	McpEventDescriptor,
	McpEventListing,
	McpHeaderCredentialStore,
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
import type { AuthStorage } from "../../domains/providers/auth/index.js";
import type { ActionClass } from "../../domains/safety/action-classifier.js";
import type { WorkerMcpAttestation } from "../../domains/safety/worker-permit.js";
import type { StoreBackend } from "../../domains/store/index.js";
import type { McpSkillLoading } from "../context/mcp-skills.js";
import type { ToolRegistry } from "../registry-contract.js";
import type { ToolSpec } from "../tool-spec.js";
import type { McpStoreAccess } from "./mcp-store-references.js";

/** An ACP client's declaration lives only for its hosted session. */
/** A server the ACP client supplies for one session: a launch vector, or an endpoint with its header values. */
export type McpClientServerSpec =
	| { name: string; command: string; args: string[]; env: Record<string, string> }
	| { name: string; url: string; headers: Record<string, string> };

/** Distributes over the stdio and remote forms, so `url` still tells them apart. */
type ClientScoped<T> = T extends unknown ? Omit<T, "scope"> & { scope: "client" } : never;

export type GatewayMcpServer = ResolvedMcpServer | ClientScoped<ResolvedMcpServer>;

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
	/**
	 * connected: launched this session; failed: launched and lost; needs-auth: a
	 * remote server refused or lacks its credentials; trusted: not launched yet.
	 */
	status: "connected" | "trusted" | "failed" | "needs-auth" | "untrusted" | "stale";
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
	/** Tools a remote server offered with an x-mcp-header PanCode cannot send, and why; never registered. */
	dropped?: Array<{ name: string; reason: string }>;
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
	/**
	 * Event types the server offers through MCP Events, live or recorded, for
	 * an `mcp_event` job. Server-written; a scoped find carries them.
	 */
	events?: McpServerEventListing[];
	/** The server's event list was cut at the client cap. */
	eventsTruncated?: true;
	/** Why the server's event types could not be listed. */
	eventsFailure?: string;
}

/** One event type as discovery lists it. */
export interface McpServerEventListing {
	name: string;
	description: string;
	/** Delivery modes the server offers; PanCode subscribes with push when offered, else poll. */
	delivery: string[];
	/** JSON Schema of the subscription arguments, the job's `arguments`. */
	arguments: Record<string, unknown>;
}

/** A declared server reachable for an event subscription, or why it is not. */
export type McpEventServer = { client: McpClient; events: McpEventDescriptor[] } | { refusal: string };

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
	registry: ToolRegistry;
	/** Request timeout applied when a declaration names none. */
	requestTimeoutMs?: number;
	/** Test seam: the client constructor. */
	clientFactory?: (spec: McpServerSpec, options: McpClientOptions) => McpClient;
	/** Test seam: where a remote server's header credentials are read; defaults to PanCode's credential store. */
	headerCredentials?: () => McpHeaderCredentialStore;
	/** Test seam: where a remote server's OAuth grants are read and renewed, and how it renews them. */
	oauth?: { storage: () => AuthStorage; fetch?: typeof fetch };
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
	 * declared path arguments: the main session every tag, a worker its granted
	 * tags. Absent means no access, so every write reference is refused.
	 */
	store?: McpStoreAccess;
	/** Test seam: the store backend references resolve and commit through. */
	openStoreBackend?: (cwd: string) => Promise<StoreBackend>;
	/**
	 * Where a server's elicitations go: an operator who can answer them (the
	 * TUI, or an ACP client that opted in). Absent, no server is told PanCode
	 * can ask anyone, as on a headless run, a worker or `pancode mcp`.
	 */
	elicitation?: McpElicitationHost;
}

export interface McpCapabilitySource {
	/**
	 * Connect client supplied stdio servers without persisting their declarations or catalogs. With `start`
	 * false they are registered unstarted; their trust is unknown, so a read-only turn refuses to start them.
	 */
	attachClientServers(servers: ReadonlyArray<McpClientServerSpec>, options?: { start?: boolean }): Promise<void>;
	/** Tear down only the servers supplied by the ACP client for this session. */
	detachClientServers(): Promise<void>;
	/**
	 * Read the declarations again and swap what changed. A removed or changed server closes and its tools
	 * unregister, an added or changed one enters with the trust its declaration holds now, and an unchanged one
	 * keeps its connection. Null, with nothing swapped, while a removed or changed server has a call in flight.
	 */
	reloadDeclarations(): Promise<McpDeclarationReload | null>;
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
	/**
	 * The context tool's code for loading the skills this source serves. It travels with the source,
	 * so a registry that admits no MCP server never loads it.
	 */
	readonly skillLoading: McpSkillLoading;
	/** Ids of the servers launched this session and still open. */
	connectedIds(options?: { readyOnly?: boolean }): string[];
	/**
	 * Synchronous policy/authority check for an `mcp_event` job without
	 * launching or reconnecting the server: declared, not client-scoped,
	 * trusted, plugin not revoked, read-only launch allowed if unstarted, and
	 * approved surface if already listed. Null when authorized.
	 */
	eventAuthorityRefusal?(id: string, options?: { readOnly?: boolean }): string | null;
	/**
	 * A declared, trusted server with an approved surface that offers MCP
	 * Events, launched when needed, with its current event types; an ACP
	 * client's server, an untrusted or failed one, or one offering no events is
	 * refused with the reason and its remedy.
	 */
	eventServer(id: string, options?: McpLaunchOptions): Promise<McpEventServer>;
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

/** What a declaration reload changed, by server id; ACP client servers are not declarations and never appear. */
export interface McpDeclarationReload {
	added: string[];
	removed: string[];
	changed: string[];
	unchanged: string[];
	/** Declared servers, changed or not, whose declaration is not trusted as it stands now. */
	needsTrust: string[];
	diagnostics: string[];
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
	/** When `listing` was observed, so later prompt/resource writes never reset tool-catalog staleness. */
	listingObservedAt?: number;
	/** The live prompt list; absent until listed, or when the server declares no prompts. */
	prompts?: McpPromptListing;
	/** When `prompts` was observed, so tool-catalog refreshes never reset prompt staleness. */
	promptsObservedAt?: number;
	/** The prompt listing in flight, shared by everyone who asks. */
	promptsListing?: Promise<void>;
	/** The initial resource listing in flight, shared by refresh/list callers. */
	resourcesListing?: Promise<void>;
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
	/** Tools the last listing dropped for an x-mcp-header PanCode cannot send. */
	dropped?: Array<{ name: string; reason: string }>;
	/** Set to close the server and start it again at the next discovery, with its options computed afresh. */
	relaunch?: boolean;
	/** Header values an ACP client sent with its remote server; held for the session, never stored. */
	clientHeaders?: Record<string, string>;
	/** The failure is a remote server's missing or refused credentials. */
	needsAuth?: boolean;
	/** Calls running on the client now, and when the last one started or ended; a remote server closes when idle. */
	inflight?: number;
	lastUsed?: number;
	/** The event types of the last listing, for a server that offers MCP Events. */
	events?: McpEventListing;
	/** Why the last events/list failed; the server's tools still serve. */
	eventsFailure?: string;
	/** This session's skills listing of a server that serves the skills extension; absent until listed. */
	skills?: { listing: McpSkillListing; listedAtMs: number } | { failure: string; listedAtMs: number };
	/** The skills listing in flight, shared by everyone waiting on it. */
	skillsListing?: Promise<void>;
}

/** A declared server's skills transport, launched and listed, or why it has none. */
export type McpSkillAccess =
	| { transport: McpSkillsTransport; listing: McpSkillListing; declaration: ResolvedMcpServer }
	| { transport: null; reason: string };
