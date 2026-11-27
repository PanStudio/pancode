// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { TSchema } from "typebox";
import { neutralizeFraming, neutralizeFramingValue } from "../../core/reminder-framing.js";
import { workerSandboxApplies } from "../../core/sandbox/worker-process.js";
import type { DynamicToolName } from "../../core/tool-names.js";
import { isMcpResourceCapability, mcpToolName } from "../../core/tool-names.js";
import { mcpToolActionClass, mcpToolConfirmationRule, mcpToolOwner } from "../../domains/gateway/mcp/action-classes.js";
import type {
	McpCatalogIdentity,
	McpClient,
	McpClientOptions,
	McpElicitationContext,
	McpElicitationRequest,
	McpResourceCount,
	McpServerCatalog,
	McpSurface,
	McpSurfaceStatus,
	McpTeardownOutcome,
	McpToolDescriptor,
	McpToolListing,
	McpTrustActionClass,
	ResolvedMcpServer,
} from "../../domains/gateway/mcp/index.js";
import {
	approveMcpSurface,
	canonicalProjectRoot,
	createMcpClient,
	createMcpOAuthAuthorizer,
	currentMcpSurfaceApproval,
	judgeMcpSurface,
	listMcpSkills,
	McpError,
	type McpFileArgument,
	mcpCatalogDigest,
	mcpCatalogStale,
	mcpClientSkills,
	mcpFileModelSchema,
	mcpFileSchema,
	mcpOAuthGrantFor,
	mcpOriginOf,
	mcpPassedEnvironment,
	mcpSurface,
	mcpSurfaceRemedy,
	openMcpHeaderCredentialStore,
	pluginServerRevocation,
	readMcpServerCatalog,
	resolveMcpHeaders,
	resolveMcpServers,
	writeMcpServerCatalog,
	writeMcpSkillCatalog,
} from "../../domains/gateway/mcp/index.js";
import { openAuthStorage } from "../../domains/providers/auth/index.js";
import { acceptsImageInput } from "../../domains/providers/image-input.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { mcpRemoteTransportIdentity, mcpTransportIdentity } from "../../domains/safety/information-flow.js";
import type { WorkerMcpAttestation } from "../../domains/safety/worker-permit.js";
import type { StoreBackend } from "../../domains/store/index.js";
import { readMaxBytes } from "../read.js";
import { MCP_DOWNLOADS_DIR, toolOffloadDir } from "../result-shaping.js";
import type { ToolResult, ToolSpec } from "../tool-spec.js";
import { formatSize } from "../truncate.js";
import {
	boundedImageResult,
	elicitationNote,
	errorMessage,
	imageBlocks,
	MCP_RESULT_CONTEXT_BYTES,
	mcpCallFailureText,
	mcpProgressReporter,
	offloadedBinaryText,
	serverHintOf,
	serverPolicyRefusalResult,
} from "./mcp-call-results.js";
import type {
	GatewayMcpServer,
	McpCapabilitySource,
	McpCapabilitySourceOptions,
	McpCatalogEntry,
	McpCloseReport,
	McpDeclarationReload,
	McpServerEventListing,
	McpServerListing,
	McpServerSurfaceListing,
	McpTeardownReport,
	OwnedConnection,
	ServerState,
} from "./mcp-capability-types.js";
import { catalogChangeLine, catalogRemedy, withCatalogChange } from "./mcp-catalog-change.js";
import { saveMcpDownloads, transferMcpUploads } from "./mcp-file-transfer.js";
import {
	type McpPreparedFiles,
	mcpFileEffects,
	mcpFileSources,
	mcpOutboundFiles,
	prepareMcpFiles,
} from "./mcp-files.js";
import { namedPathArguments, pathArgumentEffects, pathArgumentRefusal } from "./mcp-path-arguments.js";
import {
	declares,
	getPromptFor,
	listResourcesFor,
	type McpResourceHost,
	promptCommandsOf,
	readResourceFor,
	refreshPrompts,
	refreshResources,
	resourceCapabilityShape,
	resourceCapabilitySpecs,
	resourceLinkFollower,
	visibleResources,
} from "./mcp-resources.js";
import {
	commitStoreReferences,
	defaultOpenStoreBackend,
	namedStoreReferences,
	type PreparedStoreReferences,
	prepareStoreReferences,
	removeTemporaries,
	storedLines,
	storeReferenceEffects,
	storeReferencesRefusal,
} from "./mcp-store-references.js";

/** How long a remote server's client stays open with no call, and how often that is checked. */
const MCP_REMOTE_IDLE_MS = 5 * 60_000;
const MCP_REMOTE_IDLE_SWEEP_MS = 30_000;

function actionClassFor(declaration: GatewayMcpServer, tool: NamedTool): McpTrustActionClass {
	return mcpToolActionClass(declaration, { name: tool.name, annotations: tool.annotations ?? null });
}

/**
 * Local stdio MCP servers as gateway capabilities. The source reads the
 * declared servers once per session, launches a server only when it is
 * trusted and only when the first find, describe, or call needs it, registers
 * each of its tools in the registry as `mcp_<id>__<tool>` (placement gateway,
 * action class from operator policy or advisory hints), and closes every client it opened at
 * session end. In the orchestrator launching a server does not sandbox it, and
 * the trust record is the operator's explicit acceptance of that; a worker's
 * servers start under the worker's OS sandbox when one applies.
 */

/** What confines a launched server, as discovery tells the model. */
function launchConfinement(): string {
	return workerSandboxApplies() ? "it runs under this worker's OS sandbox" : "launching it does not sandbox it";
}

/**
 * Why a read-only turn may not start `declaration`'s server, or null when it
 * may. A call to a tool the operator classes read, through toolActionClasses,
 * may start it too: admission would admit that call by the same rule
 * (f1cae16c5), and the server's own readOnlyHint is unknown before launch.
 */
function readOnlyLaunchRefusal(
	declaration: GatewayMcpServer,
	readOnly: boolean | undefined,
	toolName?: string,
): string | null {
	if (readOnly !== true || declaration.trust.actionClass === "read") return null;
	if (
		toolName !== undefined &&
		mcpToolActionClass(declaration, { name: toolName, annotations: null }, { readOnly: true }) === "read"
	) {
		return null;
	}
	return `mcp server ${declaration.id} is trusted as ${declaration.trust.actionClass}, and a read-only turn starts only servers trusted as read or for a tool the operator classes read`;
}

interface NamedTool {
	name: string;
	description: string;
	annotations?: Record<string, unknown> | null;
}

function objectiveOf(tool: NamedTool): string {
	return tool.description.trim().length > 0 ? tool.description.trim() : `MCP tool ${tool.name}`;
}

/**
 * The description a registered spec and a cached descriptor both carry, so
 * discovery reads identically whether the metadata came off a live listing or
 * off disk and a caller can never tell the two apart by shape alone.
 */
function describeTool(declaration: GatewayMcpServer, tool: NamedTool): string {
	if (declaration.url !== undefined) {
		const where =
			declaration.scope === "client" ? "supplied by the ACP client for this session" : `${declaration.scope} scope`;
		return `${objectiveOf(tool)}\nRemote MCP server ${declaration.id} at ${mcpOriginOf(declaration.url)} (${where}), trusted with action class ${actionClassFor(declaration, tool)}; it runs off this machine, and what a call sends leaves it.`;
	}
	if (declaration.scope === "client") {
		return `${objectiveOf(tool)}\nLocal MCP server ${declaration.id}, supplied by the ACP client for this session. Its calls use the gateway's unknown action class and session autonomy.`;
	}
	return `${objectiveOf(tool)}\nLocal MCP server ${declaration.id} (${declaration.scope} scope), trusted with action class ${actionClassFor(declaration, tool)}; ${launchConfinement()}.`;
}

/** Remedies name the CLI first: it exists in every session, interactive or not. */
function mcpTrustRemedy(id: string): { remedy: string; interactiveRemedy: string } {
	return { remedy: `pancode mcp trust ${id}`, interactiveRemedy: `/mcp trust ${id}` };
}

/** Create the `${PLUGIN_DATA}` directory (and any declared subdirectory cwd under it) before launch. */
function preparePluginDataDir(declaration: GatewayMcpServer): void {
	if (declaration.plugin === undefined || declaration.command === undefined) return;
	const { dataDir, id } = declaration.plugin;
	try {
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		if (declaration.cwdRoot !== dataDir || declaration.cwd === undefined || declaration.cwd === dataDir) return;
		const relative = path.relative(dataDir, declaration.cwd);
		if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return;
		let cursor = realpathSync(dataDir);
		for (const segment of relative.split(path.sep)) {
			if (segment.length === 0 || segment === ".") continue;
			const next = path.join(cursor, segment);
			let stat: ReturnType<typeof lstatSync> | undefined;
			try {
				stat = lstatSync(next);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (stat === undefined) {
				mkdirSync(next, { mode: 0o700 });
			} else if (stat.isSymbolicLink() || !stat.isDirectory()) {
				// Leave symlink or non-directory refusal to containedCwd at spawn.
				return;
			}
			cursor = next;
		}
	} catch (error) {
		throw new Error(`the data directory of plugin ${id} cannot be created: ${errorMessage(error)}`);
	}
}

/** Serialize an argv vector for the shell classifier only. No shell executes this text. */
function quoted(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function createMcpDeclarationReloader(deps: {
	isClosed: () => boolean;
	trustOptions: Parameters<typeof resolveMcpServers>[0];
	states: () => Map<string, ServerState>;
	close: (state: ServerState) => Promise<unknown> | undefined;
	unregister: (name: DynamicToolName) => void;
	admit: (declaration: ResolvedMcpServer) => GatewayMcpServer;
	setDiagnostics: (next: string[]) => void;
}): () => Promise<McpDeclarationReload | null> {
	let tail: Promise<unknown> = Promise.resolve();
	const run = async (): Promise<McpDeclarationReload | null> => {
		if (deps.isClosed()) throw new Error("MCP capability source is closed");
		const resolved = resolveMcpServers(deps.trustOptions);
		const reload = await swapMcpDeclarations(deps.states(), resolved.servers, deps);
		if (reload === null) return null;
		const nextDiagnostics = resolvedDiagnostics(resolved);
		deps.setDiagnostics(nextDiagnostics);
		return { ...reload, diagnostics: [...nextDiagnostics] };
	};
	return () => {
		const next = tail.then(run, run);
		tail = next.catch(() => undefined);
		return next;
	};
}

function sameStringList(a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

/** Whether `current` admits what the session's snapshot `admitted` did: same file, digest, trust, classes, network grant and file targets. */
function sameMcpAdmission(current: ResolvedMcpServer, admitted: GatewayMcpServer): boolean {
	return (
		current.scope === admitted.scope &&
		current.path === admitted.path &&
		current.digest === admitted.digest &&
		current.trust.status === admitted.trust.status &&
		current.trust.actionClass === admitted.trust.actionClass &&
		(current.trust.status === "trusted" ? current.trust.network : undefined) ===
			(admitted.trust.status === "trusted" ? admitted.trust.network : undefined) &&
		sameStringList(current.fileTargets, admitted.fileTargets)
	);
}

function resolvedDiagnostics(resolved: ReturnType<typeof resolveMcpServers>): string[] {
	return [
		...resolved.diagnostics.map((entry) => `${entry.scope} ${entry.path}: ${entry.message}`),
		...resolved.trustDiagnostics,
	];
}

/** A server not yet launched this session. An ACP client's server has no catalog to read. */
function freshServerState(declaration: GatewayMcpServer): ServerState {
	return {
		declaration,
		client: null,
		connection: null,
		tools: [],
		truncated: false,
		registered: [],
		unregistrable: [],
		refused: new Map(),
		failure: null,
		catalog: declaration.scope === "client" ? null : undefined,
	};
}

/**
 * The swap `/reload mcp` makes: the session's declared servers against a fresh resolve. A removed or changed
 * server closes and its tools unregister; an added or changed one enters unlaunched, with the trust its
 * declaration holds now. Every declared server left untrusted is named, changed or not. Nothing is swapped while
 * a server it would close has a call in flight.
 */
async function swapMcpDeclarations(
	states: Map<string, ServerState>,
	resolved: ReadonlyArray<ResolvedMcpServer>,
	host: {
		close(state: ServerState): Promise<unknown> | undefined;
		unregister(name: DynamicToolName): void;
		admit(declaration: ResolvedMcpServer): GatewayMcpServer;
	},
): Promise<Omit<McpDeclarationReload, "diagnostics"> | null> {
	const reload: Omit<McpDeclarationReload, "diagnostics"> = {
		added: [],
		removed: [],
		changed: [],
		unchanged: [],
		needsTrust: [],
	};
	const retired: ServerState[] = [];
	const entering: ResolvedMcpServer[] = [];
	for (const state of states.values()) {
		if (state.declaration.scope === "client") continue;
		const next = resolved.find((declaration) => declaration.id === state.declaration.id);
		if (next !== undefined && sameMcpAdmission(next, state.declaration)) {
			reload.unchanged.push(next.id);
			continue;
		}
		retired.push(state);
		if (next === undefined) reload.removed.push(state.declaration.id);
		else {
			reload.changed.push(next.id);
			entering.push(next);
		}
	}
	if (retired.some((state) => (state.inflight ?? 0) > 0)) return null;
	for (const declaration of resolved) {
		if (states.has(declaration.id)) continue;
		reload.added.push(declaration.id);
		entering.push(declaration);
	}
	await Promise.all(retired.map((state) => host.close(state)));
	await Promise.all(retired.map((state) => state.connection?.ready));
	for (const state of retired) {
		for (const name of state.registered) host.unregister(name);
		states.delete(state.declaration.id);
	}
	for (const declaration of entering) states.set(declaration.id, freshServerState(host.admit(declaration)));
	for (const state of states.values()) {
		if (state.declaration.scope !== "client" && state.declaration.trust.status !== "trusted")
			reload.needsTrust.push(state.declaration.id);
	}
	for (const ids of Object.values(reload)) ids.sort();
	return reload;
}

export function createMcpCapabilitySource(options: McpCapabilitySourceOptions): McpCapabilitySource {
	const registry = options.registry;
	const clientFactory = options.clientFactory ?? createMcpClient;
	const elicitationHost = options.elicitation;
	const headerCredentials = options.headerCredentials ?? openMcpHeaderCredentialStore;
	const oauthStorage = options.oauth?.storage ?? openAuthStorage;
	const openStoreBackend = options.openStoreBackend ?? defaultOpenStoreBackend;
	/** The project's store backend, opened once for whoever asks first. */
	const storeBackend = (): (() => Promise<StoreBackend>) => {
		let opened: Promise<StoreBackend> | undefined;
		return () => {
			opened ??= openStoreBackend(options.cwd);
			return opened;
		};
	};
	let states: Map<string, ServerState> | null = null;
	let diagnostics: string[] = [];
	let exitHookInstalled = false;
	let closed = false;
	let closePromise: Promise<McpCloseReport> | null = null;
	const teardowns: McpTeardownReport[] = [];

	// A detached child can outlive a parent that never reaches close(). Only
	// the client knows whether its group is still owned during pending cleanup.
	const killLaunchedOnExit = (): void => {
		for (const state of states?.values() ?? []) state.client?.killOwnedOnExit();
	};
	const installExitHook = (): void => {
		if (exitHookInstalled) return;
		exitHookInstalled = true;
		process.once("exit", killLaunchedOnExit);
	};

	const closeClient = (state: ServerState): Promise<McpTeardownOutcome> | undefined => state.connection?.close();

	/** Record why a server stopped; the first reason stands, and a credential refusal reads as needs-auth. */
	const failWith = (state: ServerState, error: unknown): void => {
		if (state.failure !== null) return;
		state.failure = errorMessage(error);
		if (error instanceof McpError && error.code === "auth") state.needsAuth = true;
	};

	/**
	 * A remote server holds no process, but a legacy one holds a session the
	 * server may expire. One left idle closes, and the next discovery
	 * connects afresh, reading its credentials again.
	 */
	let idleSweep: ReturnType<typeof setInterval> | null = null;
	const watchIdle = (state: ServerState): void => {
		state.lastUsed = performance.now();
		if (idleSweep !== null) return;
		idleSweep = setInterval(() => {
			const now = performance.now();
			for (const each of states?.values() ?? []) {
				if (each.declaration.url === undefined || each.client === null || (each.inflight ?? 0) > 0) continue;
				if (now - (each.lastUsed ?? now) < MCP_REMOTE_IDLE_MS) continue;
				each.relaunch = true;
				void closeClient(each);
			}
		}, MCP_REMOTE_IDLE_SWEEP_MS);
		idleSweep.unref();
	};

	const trustOptions = {
		cwd: options.cwd,
		...(options.configDir ? { configDir: options.configDir } : {}),
	};
	const attended = options.attended ?? (process.env.PANCODE_INTERACTIVE === "1" && process.stdin.isTTY === true);

	const surfaceListing = (
		declaration: GatewayMcpServer,
		status: McpSurfaceStatus,
		recorded = false,
	): McpServerSurfaceListing => ({
		...status,
		...(status.status !== "approved" ? { remedy: mcpSurfaceRemedy(declaration.id) } : {}),
		...(recorded ? { recorded: true as const } : {}),
	});

	/**
	 * Judge a served surface against the approval the trust state holds now. An
	 * attended session records a user-scope server's surface the first time it
	 * sees one, and any session records a core plugin's, its files being the
	 * ones PanCode pins; a project or plugin server's surface is otherwise only
	 * ever approved by the operator's own command, and a changed surface is never recorded over.
	 */
	const judgeServedSurface = (declaration: ResolvedMcpServer, served: McpSurface): McpServerSurfaceListing => {
		if (options.admitted !== undefined) return judgeAttestedSurface(declaration, served, options.admitted);
		const status = judgeMcpSurface(declaration, currentMcpSurfaceApproval(declaration, trustOptions), served);
		const recordsFirst = (declaration.scope === "user" && attended) || declaration.plugin?.core === true;
		if (status.status !== "unapproved" || !recordsFirst || options.persistCatalog === false) {
			return surfaceListing(declaration, status);
		}
		const recorded = approveMcpSurface({ ...trustOptions, id: declaration.id, surface: served });
		if (!recorded.ok) {
			return surfaceListing(declaration, {
				...status,
				reason: `${status.reason}; recording it failed: ${recorded.message}`,
			});
		}
		return surfaceListing(declaration, judgeMcpSurface(declaration, recorded.surface, served), true);
	};

	/**
	 * A worker judges a served surface against the digest admission attested,
	 * never against the trust file it may not see. A mismatch means the server
	 * changed what it serves after the operator approved it, or since dispatch.
	 */
	const judgeAttestedSurface = (
		declaration: ResolvedMcpServer,
		served: McpSurface,
		admitted: WorkerMcpAttestation,
	): McpServerSurfaceListing => {
		const attested = admitted.tools.find((entry) => entry.serverId === declaration.id)?.surfaceDigest ?? null;
		if (attested === served.digest) return { status: "approved", digest: served.digest, approvedDigest: attested };
		return surfaceListing(declaration, {
			status: attested === null ? "unapproved" : "changed",
			digest: served.digest,
			approvedDigest: attested,
			reason: `the tool surface MCP server '${declaration.id}' serves (${served.digest}) is not the one this run was admitted with (${attested ?? "none"}); review it, run ${mcpSurfaceRemedy(declaration.id)}, and dispatch again`,
		});
	};

	/** The surface a server's listing shows: the live judgement once listed, else the session snapshot's approval. */
	const surfaceOf = (state: ServerState): McpServerSurfaceListing | null => {
		const { declaration } = state;
		if (declaration.scope === "client" || declaration.trust.status !== "trusted") return null;
		return (
			state.surface?.status ?? surfaceListing(declaration, judgeMcpSurface(declaration, declaration.trust.surface, null))
		);
	};

	/**
	 * Why a call to one of this server's tools is refused for its surface, or
	 * null when the surface is approved. An approval recorded since the listing
	 * counts at once; a refused call never reaches the server.
	 */
	const surfaceRefusal = (state: ServerState, name: string): string | null => {
		const { declaration } = state;
		if (declaration.scope === "client") return null;
		const surface = state.surface;
		if (surface === undefined) return `${name}: mcp server ${declaration.id} has not listed its tools this session`;
		if (surface.status.status === "approved") return null;
		surface.status = judgeServedSurface(declaration, surface.served);
		if (surface.status.status === "approved") return null;
		return `${name}: ${surface.status.reason}`;
	};

	const launchPlacement = (declaration: GatewayMcpServer): { cwd: string; workspaceRoot: string } => {
		if (options.launchRoot === undefined || declaration.scope !== "project") {
			return { cwd: declaration.cwd, workspaceRoot: declaration.cwdRoot };
		}
		const relative = path.relative(declaration.cwdRoot, declaration.cwd);
		return { cwd: path.join(options.launchRoot, relative), workspaceRoot: options.launchRoot };
	};

	/**
	 * A worker keeps every declaration so the owner rule routes exactly as
	 * admission did, but only an attested one at its attested digest can
	 * launch. The others read as untrusted for this run and are never started.
	 */
	const admittedDeclaration = (declaration: ResolvedMcpServer): ResolvedMcpServer => {
		const admitted = options.admitted;
		if (admitted === undefined || declaration.trust.status !== "trusted") return declaration;
		// A server the run binds only skills of launches too; its tools stay uncallable, no surface being attested.
		const attested =
			admitted.tools.find((entry) => entry.serverId === declaration.id) ??
			admitted.skills?.find((entry) => entry.serverId === declaration.id);
		if (attested === undefined) {
			return {
				...declaration,
				trust: {
					status: "untrusted",
					actionClass: "unknown",
					reason: `MCP server '${declaration.id}' was not admitted for this run`,
				},
			};
		}
		if (attested.digest !== declaration.digest) {
			return {
				...declaration,
				trust: {
					status: "stale",
					actionClass: "unknown",
					reason: `declaration of '${declaration.id}' changed since this run was admitted; review it, run pancode mcp trust ${declaration.id}, and dispatch again`,
				},
			};
		}
		return declaration;
	};

	const resolveStates = (): Map<string, ServerState> => {
		if (states !== null) return states;
		const resolved = resolveMcpServers(trustOptions);
		diagnostics = resolvedDiagnostics(resolved);
		states = new Map(
			resolved.servers.map((declaration) => [declaration.id, freshServerState(admittedDeclaration(declaration))]),
		);
		return states;
	};

	// realpathSync touches disk, and every catalog identity in this session must
	// resolve to the same project the trust record bound to.
	let projectRoot: string | null = null;
	const catalogIdentity = (declaration: GatewayMcpServer): McpCatalogIdentity => {
		projectRoot ??= canonicalProjectRoot(options.cwd);
		return {
			projectRoot,
			scope: declaration.scope === "client" ? "user" : declaration.scope,
			declarationPath: declaration.path,
			serverId: declaration.id,
			digest: mcpCatalogDigest(declaration, headerCredentials, oauthStorage),
			cwd: declaration.cwd,
		};
	};

	/**
	 * The recorded catalog for a trusted declaration, read once per session for
	 * the same reason the declarations themselves are snapshotted: one session
	 * answers discovery from one consistent view. An untrusted or stale
	 * declaration never reads one, because a catalog is not an authority record
	 * and listing its tools would suggest they are reachable.
	 */
	const cachedCatalog = (state: ServerState): McpServerCatalog | null => {
		if (state.declaration.scope === "client") return null;
		if (state.catalog !== undefined) return state.catalog;
		state.catalog =
			state.declaration.trust.status === "trusted" ? readMcpServerCatalog(catalogIdentity(state.declaration)) : null;
		return state.catalog;
	};

	/**
	 * Record a live listing so a later session answers find and describe without
	 * launching this server. Best effort by design: a cache that cannot be
	 * written must never fail the connection that produced it.
	 */
	const resourceCountOf = (state: ServerState): McpResourceCount | undefined => {
		if (state.resourceList === undefined) return undefined;
		const listed = visibleResources(state.resourceList.listing);
		return {
			resources: listed.resources.length,
			templates: listed.templates.length,
			...(listed.truncated ? { truncated: true as const } : {}),
		};
	};

	const publishCatalog = (state: ServerState): void => {
		const listing = state.listing;
		if (listing === undefined || state.declaration.scope === "client" || options.persistCatalog === false) return;
		const client = state.client;
		const prior = cachedCatalog(state);
		// Until this connection lists its prompts, the recorded list stands with its own observation time.
		const prompts = !declares(client, "prompts")
			? null
			: state.prompts !== undefined
				? {
						...state.prompts,
						...(state.promptsObservedAt !== undefined ? { observedAt: new Date(state.promptsObservedAt).toISOString() } : {}),
					}
				: prior?.prompts !== undefined
					? { ...prior.prompts, observedAt: prior.prompts.observedAt ?? prior.observedAt }
					: null;
		const resourceCount = resourceCountOf(state) ?? prior?.resourceCount ?? null;
		writeMcpServerCatalog(
			catalogIdentity(state.declaration),
			{
				...listing,
				instructions: client?.serverInfo()?.instructions ?? null,
				resources: declares(client, "resources"),
				resourceCount,
				completions: declares(client, "completions"),
				files: client?.filesOffered() != null,
				prompts,
				...(state.events !== undefined ? { events: state.events.events } : {}),
			},
			state.listingObservedAt === undefined ? {} : { nowMs: state.listingObservedAt },
		);
		// Drop the memo of whatever the file said before this listing replaced it.
		state.catalog = undefined;
	};

	const attestedNetwork = (serverId: string): boolean =>
		options.admitted?.tools.some((entry) => entry.serverId === serverId && entry.network === true) === true;
	/** The main session transfers files out of band; a worker only with the server's attested network grant. */
	const fileTransfersPermitted = (serverId: string): boolean =>
		options.admitted === undefined || attestedNetwork(serverId);

	const toolFilePresentation = (
		declaration: GatewayMcpServer,
		tool: { name: string; description: string; inputSchema: Record<string, unknown> },
		filesOffered: boolean,
	): {
		description: string;
		parameters: Record<string, unknown>;
		fileArguments: ReadonlyArray<McpFileArgument> | null;
	} => {
		const fileSchema = filesOffered ? mcpFileSchema(tool.inputSchema) : null;
		const fileArguments = fileSchema?.kind === "files" ? fileSchema.arguments : null;
		const description =
			fileSchema?.kind === "unsupported"
				? `${describeTool(declaration, tool)}\nPanCode does not send files to this tool: ${fileSchema.reason}.`
				: describeTool(declaration, tool);
		const parameters = fileArguments !== null ? mcpFileModelSchema(tool.inputSchema, fileArguments) : tool.inputSchema;
		return { description, parameters, fileArguments };
	};

	const makeSpec = (state: ServerState, tool: McpToolDescriptor, name: DynamicToolName): ToolSpec => {
		const { declaration } = state;
		const liveClass = actionClassFor(declaration, tool);
		// A worker runs each tool under the class its permit sealed. A server
		// whose live metadata now classes the tool differently is refused below
		// rather than judged again here, where no ceiling can see it.
		const attested = options.admitted?.tools.find(
			(entry) => entry.serverId === declaration.id && entry.tool === tool.name,
		);
		const trustClass = attested?.actionClass ?? liveClass;
		const classDrift =
			attested !== undefined && attested.actionClass !== liveClass
				? `${name}: mcp server ${declaration.id} now gives this tool class ${liveClass}, but this run was admitted with ${attested.actionClass}; dispatch again so admission judges the new class`
				: null;
		// A worker's sealed class stays its class under read-only too; the
		// permit already judged it against the run's ceiling.
		const readOnlyClass =
			attested?.actionClass ??
			mcpToolActionClass(declaration, { name: tool.name, annotations: tool.annotations ?? null }, { readOnly: true });
		const confirmationRuleId = mcpToolConfirmationRule(declaration, tool.name);
		const timeoutMs = declaration.timeoutMs ?? options.requestTimeoutMs;
		const pathArguments =
			declaration.scope !== "client" &&
			declaration.toolPathArguments !== undefined &&
			Object.hasOwn(declaration.toolPathArguments, tool.name)
				? declaration.toolPathArguments[tool.name]
				: undefined;
		// The server resolves a relative path against the cwd it was started in.
		const pathCwd = launchPlacement(declaration).cwd;
		// Experimental MCP files extension: the model names files by path, and PanCode sends their bytes.
		const presentation = toolFilePresentation(declaration, tool, state.client?.filesOffered() != null);
		const { fileArguments } = presentation;
		const fileTargets = declaration.fileTargets ?? [];
		const spec: ToolSpec = {
			name,
			description: presentation.description,
			parameters: presentation.parameters as TSchema,
			baseActionClass: trustClass,
			...(readOnlyClass !== trustClass ? { readOnlyActionClass: readOnlyClass } : {}),
			...(confirmationRuleId !== null ? { confirmationRuleId } : {}),
			executionMode: "sequential",
			placement: "gateway",
			sourceInfo: { path: declaration.path, scope: "domain" },
			metadata: {
				objective: objectiveOf(tool),
				uiLabel: `${declaration.id}/${tool.name}`,
				repeatableRead:
					trustClass === "read" && tool.annotations?.readOnlyHint === true && tool.annotations?.idempotentHint === true,
				// The session cap alone (64 KiB) let one search result spend a sixth
				// of a 131k window. Bound MCP output like the built-in observation
				// tools; the full text is offloaded and stays readable by path.
				resultSizePolicy: {
					kind: "bounded",
					maxBytes: MCP_RESULT_CONTEXT_BYTES,
					// An image is bounded by read's image budget, never by the text bound its base64 cannot fit.
					imageMaxBytes: readMaxBytes(),
					followUpHint:
						"Call again with a narrower query or the server's own limit/page arguments, or read the offloaded file in windows.",
				},
			},
			async run(args, invokeOptions): Promise<ToolResult> {
				if (classDrift !== null) return { kind: "error", message: classDrift };
				const refusedReference = (message: string): ToolResult => ({
					kind: "error",
					message: `${name}: ${message}`,
					details: { refusal: { kind: "mcp_path_argument" } },
				});
				// A store reference the session may not make, or that names a missing tag or blob, is refused
				// before the server starts; the checks repeat before the call.
				const references = pathArguments === undefined ? [] : namedStoreReferences(pathArguments, args);
				if (typeof references === "string") return refusedReference(references);
				const fileSources = fileArguments === null ? [] : mcpFileSources(fileArguments, args, options.cwd);
				if (typeof fileSources === "string") return refusedReference(fileSources);
				const fileReferences = fileSources.flatMap((source) => (source.kind === "store" ? [source.reference] : []));
				const backend = storeBackend();
				const storeRefusal = await storeReferencesRefusal({
					references,
					access: options.store,
					backend,
				});
				if (storeRefusal !== null) return refusedReference(storeRefusal);
				const fileStoreRefusal = await storeReferencesRefusal({
					references: fileReferences,
					access: options.store,
					backend,
				});
				if (fileStoreRefusal !== null) return refusedReference(fileStoreRefusal);
				await discover(state, invokeOptions?.signal);
				const client = state.client;
				if (client === null || client.state().status !== "ready") {
					return {
						kind: "error",
						message: `${name}: mcp server ${declaration.id} is not connected${state.failure ? `: ${state.failure}` : ""}; the next call starts it again${declaration.scope === "client" ? "" : `, and pancode mcp test ${declaration.id} starts it outside the session to show why it fails`}`,
					};
				}
				const currentTool = state.tools.find((entry) => entry.name === tool.name);
				if (currentTool === undefined || JSON.stringify(currentTool) !== JSON.stringify(tool)) {
					return withCatalogChange(state, {
						kind: "error",
						message: `${name}: live tool metadata changed; describe the capability and retry under its current schema and authority`,
					});
				}
				const unapproved = surfaceRefusal(state, name);
				if (unapproved !== null) {
					return { kind: "error", message: unapproved, details: { refusal: { kind: "mcp_surface_unapproved" } } };
				}
				const pathRefusal =
					pathArguments === undefined
						? null
						: pathArgumentRefusal(name, pathArguments, trustClass, args, pathCwd, invokeOptions);
				if (pathRefusal !== null) {
					return { kind: "error", message: pathRefusal, details: { refusal: { kind: "mcp_path_argument" } } };
				}
				let prepared: PreparedStoreReferences | null = null;
				if (references.length > 0) {
					const resolved = await prepareStoreReferences({
						references,
						args,
						cwd: options.cwd,
						access: options.store,
						backend,
						...(invokeOptions?.signal ? { signal: invokeOptions.signal } : {}),
					});
					if (typeof resolved === "string") return refusedReference(resolved);
					prepared = resolved;
				}
				let files: McpPreparedFiles | null = null;
				if (fileArguments !== null) {
					const offered = client.filesOffered();
					if (offered === null) {
						if (prepared !== null) await removeTemporaries(prepared);
						return withCatalogChange(state, {
							kind: "error",
							message: `${name}: mcp server ${declaration.id} no longer offers the files extension; describe the capability and retry under its current schema`,
						});
					}
					const storeCopies = new Map<string, string>();
					if (fileReferences.length > 0) {
						const copies = await prepareStoreReferences({
							references: fileReferences,
							args: {},
							cwd: options.cwd,
							access: options.store,
							backend,
							...(invokeOptions?.signal ? { signal: invokeOptions.signal } : {}),
						});
						if (typeof copies === "string") {
							if (prepared !== null) await removeTemporaries(prepared);
							return refusedReference(copies);
						}
						for (const reference of fileReferences) {
							const copy = copies.args[reference.argument];
							if (typeof copy === "string") storeCopies.set(reference.argument, copy);
						}
					}
					const ready = await prepareMcpFiles({
						fileArguments,
						args: prepared?.args ?? args,
						sources: fileSources,
						storeCopies,
						policy: {
							upload: offered.upload,
							maxInlineBytes: offered.maxInlineBytes,
							transfers: fileTransfersPermitted(declaration.id),
						},
						invokeOptions,
					});
					if (typeof ready === "string") {
						if (prepared !== null) await removeTemporaries(prepared);
						return refusedReference(ready);
					}
					files = ready;
				}
				const progress = invokeOptions?.onUpdate === undefined ? null : mcpProgressReporter(name, invokeOptions.onUpdate);
				state.inflight = (state.inflight ?? 0) + 1;
				state.lastUsed = performance.now();
				let headerMismatchResult: ToolResult | null = null;
				try {
					const held = files?.held;
					const result = await client.callTool(tool.name, files?.args ?? prepared?.args ?? args, {
						...(invokeOptions?.signal ? { signal: invokeOptions.signal } : {}),
						...(files !== null && held !== undefined
							? {
									files: {
										pending: files.pending,
										upload: (request, connection, signal) =>
											transferMcpUploads(request, held, {
												context: { ...connection, fileTargets },
												admitTarget: invokeOptions?.flowAdmitsFileTarget,
												signal,
											}),
									},
								}
							: {}),
						...(timeoutMs !== undefined ? { timeoutMs } : {}),
						...(progress !== null ? { onProgress: progress.onProgress } : {}),
						onHeaderMismatchRelist(listing) {
							installListing(state, listing);
							const unapprovedAfter = surfaceRefusal(state, name);
							if (unapprovedAfter !== null) {
								headerMismatchResult = {
									kind: "error",
									message: unapprovedAfter,
									details: { refusal: { kind: "mcp_surface_unapproved" } },
								};
								return unapprovedAfter;
							}
							const updatedTool = state.tools.find((entry) => entry.name === tool.name);
							if (updatedTool === undefined || JSON.stringify(updatedTool) !== JSON.stringify(tool)) {
								const message = `${name}: live tool metadata changed; describe the capability and retry under its current schema and authority`;
								headerMismatchResult = withCatalogChange(state, { kind: "error", message });
								return message;
							}
							return null;
						},
					});
					progress?.stop();
					const contentTypes = result.content.map((block) => block.type);
					if (result.outputSchemaMismatch !== undefined) {
						return withCatalogChange(state, {
							kind: "error",
							message: `${name}: ${neutralizeFraming(result.outputSchemaMismatch)}; the result is withheld because the server broke its own declared outputSchema, so report it rather than relying on it`,
							details: {
								server: declaration.id,
								tool: tool.name,
								contentTypes,
								outputSchemaMismatch: true,
							},
						});
					}
					const rendered = offloadedBinaryText(result, invokeOptions, resourceLinkFollower(state)) ?? {
						text: result.text,
						truncated: result.textTruncated,
					};
					const details: Record<string, unknown> = {
						server: declaration.id,
						tool: tool.name,
						contentTypes,
						textTruncated: rendered.truncated,
						...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
						...(result.structuredContentJson !== undefined ? { structuredContentJson: result.structuredContentJson } : {}),
						...(result.elicitations !== undefined ? { elicitations: result.elicitations } : {}),
					};
					const note = neutralizeFraming(elicitationNote(declaration.id, result.elicitations));
					if (result.isError) {
						const refusal = serverPolicyRefusalResult(state, tool, name, trustClass, result);
						if (refusal !== null) return refusal;
						const text = neutralizeFraming(rendered.text) || "tool error";
						return withCatalogChange(state, {
							kind: "error",
							message: `${name}: ${note.length > 0 ? `${note}\n${text}` : text}`,
							details,
						});
					}
					const images = imageBlocks(result);
					// Server text cannot open or close a host frame (a reminder block or a middleware note), as bash and web_fetch output cannot.
					let output = neutralizeFraming(rendered.text);
					if (note.length > 0) output = output.length > 0 ? `${note}\n${output}` : note;
					if (prepared !== null && prepared.writes.length > 0) {
						// An interrupted call commits nothing, whatever the server answered.
						if (invokeOptions?.signal?.aborted === true) {
							return { kind: "error", message: `${name}: the call was interrupted, so nothing was stored`, details };
						}
						const commit = await commitStoreReferences({
							prepared,
							serverId: declaration.id,
							backend,
							ids: {
								...(invokeOptions?.sessionId !== undefined ? { sessionId: invokeOptions.sessionId } : {}),
								...(invokeOptions?.turnId !== undefined ? { turnId: invokeOptions.turnId } : {}),
								...(options.store?.grant?.dispatchRunId !== undefined
									? { dispatchRunId: options.store.grant.dispatchRunId }
									: {}),
							},
							...(invokeOptions?.signal ? { signal: invokeOptions.signal } : {}),
						});
						details.store = commit.stored;
						const stored = storedLines(commit.stored);
						if (commit.error !== undefined) {
							return {
								kind: "error",
								message: `${name}: ${[output, stored, commit.error].filter((part) => part.length > 0).join("\n")}`,
								details,
							};
						}
						output = output.length > 0 ? `${output}\n${stored}` : stored;
					}
					if (result.downloads !== undefined) {
						const { saved, dropped } = await saveMcpDownloads(
							result.downloads.targets,
							path.join(toolOffloadDir(invokeOptions?.sessionId), MCP_DOWNLOADS_DIR),
							{
								context: { ...client.fileConnection(), fileTargets },
								admitTarget: invokeOptions?.flowAdmitsFileTarget,
								signal: invokeOptions?.signal,
							},
						);
						const notDownloaded = [...result.downloads.dropped, ...dropped];
						details.downloads = saved;
						if (notDownloaded.length > 0) details.downloadsDropped = notDownloaded;
						const lines = neutralizeFraming(
							[
								...saved.map(
									(file) =>
										`downloaded ${file.name} (${file.mimeType}, ${formatSize(file.size)}) to ${file.path}; its content is the server's, untrusted`,
								),
								...notDownloaded.map((reason) => `not downloaded: ${reason}`),
							].join("\n"),
						);
						if (lines.length > 0) output = output.length > 0 ? `${output}\n${lines}` : lines;
					}
					if (images.length > 0 && acceptsImageInput({ vision: invokeOptions?.supportsImages }))
						return await boundedImageResult(name, output, details, images, invokeOptions);
					return {
						kind: "ok",
						output,
						details,
						...(images.length > 0 ? { images } : {}),
					};
				} catch (error) {
					if (headerMismatchResult !== null) return headerMismatchResult;
					const stopped = client.state().status === "failed" || client.state().status === "closed";
					if (stopped) {
						state.failure = null;
						failWith(state, error);
						await closeClient(state);
					}
					// Server-written text (an error answer's detail, a crashed server's stderr) cannot open or close a host frame.
					const message = `${name}: ${neutralizeFraming(mcpCallFailureText(declaration, error, stopped))}`;
					// A JSON-RPC error answer (invalid params, unknown tool) came from the
					// server, so it carries the server id like any other answer; only a
					// request that got no answer goes without it.
					if (error instanceof McpError && error.code === "server")
						return withCatalogChange(state, {
							kind: "error",
							message,
							details: { server: declaration.id, tool: tool.name },
						});
					return { kind: "error", message };
				} finally {
					state.inflight = (state.inflight ?? 1) - 1;
					state.lastUsed = performance.now();
					progress?.stop();
					if (prepared !== null) await removeTemporaries(prepared);
				}
			},
		};
		// The execute trust class projects the launch vector to a bash command
		// so the policy engine applies the shell rules to it, as an extension
		// command does; read runs everywhere and unknown asks everywhere. The
		// marker keeps the main-session sandbox from vouching for a call that
		// runs on the server's own process.
		if (pathArguments !== undefined || fileArguments !== null) {
			spec.hostEffectCalls = (args) => {
				const named = pathArguments === undefined ? [] : namedPathArguments(pathArguments, args, pathCwd);
				const references = pathArguments === undefined ? [] : namedStoreReferences(pathArguments, args);
				const fileSources = fileArguments === null ? [] : mcpFileSources(fileArguments, args, options.cwd);
				// A malformed argument is refused by the body before the server sees it.
				if (typeof named === "string" || typeof references === "string" || typeof fileSources === "string") return [];
				return [
					...pathArgumentEffects(named),
					...storeReferenceEffects(references, options.cwd, options.store),
					...mcpFileEffects(fileSources, options.cwd, options.store),
				];
			};
		}
		if (fileArguments !== null) {
			spec.outboundFiles = (args) => {
				const sources = mcpFileSources(fileArguments, args, options.cwd);
				return typeof sources === "string" ? [] : mcpOutboundFiles(sources, declaration.id, options.cwd, options.store);
			};
		}
		if (trustClass === "execute" && declaration.url === undefined) {
			const launchCall: ClassifierCall = {
				tool: "bash",
				args: { command: [declaration.command, ...declaration.args].map(quoted).join(" ") },
				projection: "mcp-server",
			};
			spec.safetyCall = (): ClassifierCall => launchCall;
		}
		return spec;
	};

	/**
	 * List the event types of a server that offers MCP Events, before its
	 * catalog is published, so the recording carries them. A failed events/list
	 * leaves the tools serving and names the failure in discovery.
	 */
	const listEventsOf = async (state: ServerState, client: McpClient, signal?: AbortSignal): Promise<void> => {
		// A change notified during events/list stays dirty for the next discovery.
		client.acknowledgeEventsChanged();
		if (client.eventsOffered() === null) {
			delete state.events;
			delete state.eventsFailure;
			return;
		}
		try {
			state.events = await client.listEvents(signal);
			delete state.eventsFailure;
		} catch (error) {
			delete state.events;
			state.eventsFailure = errorMessage(error);
		}
	};

	const installListing = (state: ServerState, listing: McpToolListing): void => {
		for (const name of state.registered) registry.unregister?.(name);
		state.registered = [];
		state.unregistrable = [];
		state.dropped = listing.dropped ?? [];
		// Only the first listing is compared with the recording; a later change
		// on a live server already fails the stale spec's call with its own reason.
		if (state.listed !== true) {
			try {
				const recorded = cachedCatalog(state);
				const change = recorded === null ? null : catalogChangeLine(state.declaration.id, recorded, listing);
				if (change !== null) state.catalogChange = change;
			} catch {
				// An unreadable cache has no recording to compare; the listing still installs.
			}
		}
		state.tools = listing.tools;
		state.truncated = listing.truncated;
		state.listing = listing;
		state.listingObservedAt = Date.now();
		state.listed = true;
		const { declaration } = state;
		if (declaration.scope !== "client") {
			const served = mcpSurface(listing.tools);
			state.surface = { served, status: judgeServedSurface(declaration, served) };
		}
		// The memo is read before the write replaces it, so a recorded prompt list carries over.
		if (declaration.scope !== "client") cachedCatalog(state);
		publishCatalog(state);
		for (const tool of listing.tools) {
			if (closed || state.client === null || state.failure !== null) return;
			const name = mcpToolName(state.declaration.id, tool.name);
			if (name === null || ownerOf(name) !== state || registry.get(name) !== undefined) {
				state.unregistrable.push(tool.name);
				continue;
			}
			registry.register(makeSpec(state, tool, name));
			state.registered.push(name);
		}
		for (const spec of resourceCapabilitySpecs(resourceHost, state)) {
			const name = spec.name as DynamicToolName;
			if (ownerOf(name) !== state || registry.get(name) !== undefined) continue;
			registry.register(spec);
			state.registered.push(name);
		}
		void refreshPrompts(resourceHost, state);
		void refreshResources(resourceHost, state);
	};

	/**
	 * List the skills of a connected server that serves the extension and
	 * record them. Listing reads entries only, never a skill file. A failed
	 * listing leaves the tools alone and is reported when a skill is asked for.
	 */
	const listSkills = (state: ServerState, signal?: AbortSignal): Promise<void> => {
		const client = state.client;
		if (client === null) return Promise.resolve();
		const offered = mcpClientSkills(client, client.serverInfo()?.capabilities);
		if (offered.transport === null) return Promise.resolve();
		const { transport } = offered;
		state.skillsListing ??= (async () => {
			try {
				const listing = await listMcpSkills(transport, signal);
				if (closed || state.client !== client) return;
				state.skills = { listing, listedAtMs: Date.now() };
				if (state.declaration.scope !== "client" && options.persistCatalog !== false) {
					writeMcpSkillCatalog(catalogIdentity(state.declaration), listing);
				}
			} catch (error) {
				if (state.client === client) state.skills = { failure: errorMessage(error), listedAtMs: Date.now() };
			}
		})().finally(() => {
			delete state.skillsListing;
		});
		return state.skillsListing;
	};

	const startConnection = (state: ServerState): OwnedConnection => {
		const controller = new AbortController();
		const { declaration } = state;
		const placement = launchPlacement(declaration);
		// Only the attestation grants network; a worker never reads it from the declaration it re-resolves.
		const sandboxNetwork = attestedNetwork(declaration.id);
		// PERF W3: reserve ownership before the lazy import, so close can fence acquisition.
		const loaded = (async () => {
			const { createMcpConnection } = await import("../../domains/gateway/mcp/connection-lifecycle.js");
			return createMcpConnection({
				signal: controller.signal,
				acquire: () => {
					// Rehash after the lazy import, immediately before acquisition.
					// The snapshot remains the authority; a fresh trust decision cannot
					// silently replace its digest, classes, or network grant.
					if (declaration.scope !== "client") {
						const current = resolveMcpServers(trustOptions).servers.find((entry) => entry.id === declaration.id);
						if (current?.trust.status !== "trusted" || !sameMcpAdmission(current, declaration)) {
							throw new Error(
								`MCP server '${declaration.id}' changed or is no longer trusted since this session admitted it; review its declaration and entry files, then ${options.admitted === undefined ? "run /reload mcp" : "dispatch again"}`,
							);
						}
					}
					preparePluginDataDir(declaration);
					const clientOptions: McpClientOptions = {
						workspaceRoot: placement.workspaceRoot,
						...(sandboxNetwork ? { sandboxNetwork: true } : {}),
						...(fileTransfersPermitted(declaration.id) ? { fileTransfers: true } : {}),
						...(elicitationHost !== undefined
							? {
									elicitation: (request: McpElicitationRequest, context: McpElicitationContext) =>
										elicitationHost(declaration.id, request, context),
								}
							: {}),
						onFailure: (error) => {
							failWith(state, error);
							void closeClient(state);
						},
						...(declaration.timeoutMs !== null
							? { requestTimeoutMs: declaration.timeoutMs }
							: options.requestTimeoutMs !== undefined
								? { requestTimeoutMs: options.requestTimeoutMs }
								: {}),
					};
					if (declaration.url !== undefined) {
						// Read at acquire, for this server's own origin only; nothing is cached across launches.
						// An ACP client's server carries the values the client sent for it.
						const resolved =
							declaration.scope === "client"
								? { headers: state.clientHeaders ?? {} }
								: resolveMcpHeaders(declaration, headerCredentials());
						if ("missing" in resolved) throw new McpError("auth", resolved.missing);
						// A server that sends no headers is sent its OAuth grant, if the operator signed in to it.
						const signedIn =
							declaration.scope !== "client" && Object.keys(declaration.headers).length === 0
								? mcpOAuthGrantFor(declaration, oauthStorage())
								: null;
						return clientFactory(
							{
								id: declaration.id,
								url: declaration.url,
								headers: resolved.headers,
								...(signedIn !== null
									? {
											authorizer: createMcpOAuthAuthorizer(signedIn.ref, signedIn.grant, options.oauth?.fetch, oauthStorage()),
										}
									: {}),
							},
							clientOptions,
						);
					}
					return clientFactory(
						{
							id: declaration.id,
							command: declaration.command,
							args: declaration.args,
							cwd: placement.cwd,
							...(declaration.plugin !== undefined ? { ownNodeFirst: true as const } : {}),
							// A plugin's envVars names pass from this process; no other scope gains any.
							env: {
								...mcpPassedEnvironment(declaration.envVars ?? []),
								...declaration.env,
							},
						},
						clientOptions,
					);
				},
				onAcquired: (client) => {
					state.client = client;
					installExitHook();
					// The slash menu reads prompts synchronously, so a change is listed when it is announced;
					// one announced during a listing is listed again after it.
					client.onListChanged((primitive) => {
						if (primitive !== "prompts") return;
						void (state.promptsListing ?? Promise.resolve()).then(() => {
							if (state.client === client && client.listChanged("prompts")) return refreshPrompts(resourceHost, state);
						});
					});
					if (declaration.url !== undefined) watchIdle(state);
				},
			});
		})();
		let closing: Promise<McpTeardownOutcome> | null = null;
		const close = (): Promise<McpTeardownOutcome> => {
			controller.abort();
			closing ??= loaded
				.then((connection) => connection.close())
				.then((outcome) => {
					teardowns.push({ id: declaration.id, outcome });
					state.client = null;
					if (!outcome.complete) {
						process.stderr.write(
							`[gateway] mcp server ${declaration.id}: process group ${outcome.pgid} survived SIGKILL for ${outcome.boundMs}ms; recorded, not signalled again\n`,
						);
					}
					return outcome;
				});
			return closing;
		};
		const ready = (async () => {
			try {
				const connection = await loaded;
				const { client, listing } = await connection.ready;
				if (closed || controller.signal.aborted || state.client !== client || state.failure !== null) return;
				await listEventsOf(state, client, controller.signal);
				if (closed || controller.signal.aborted || state.client !== client || state.failure !== null) return;
				installListing(state, listing);
				// Listed beside the tools, not before them: a slow skills/list never holds a tool call back.
				void listSkills(state);
			} catch (error) {
				failWith(state, error);
				await close();
			}
		})();
		return { ready, close };
	};

	const discover = async (state: ServerState, signal?: AbortSignal, refresh = false): Promise<void> => {
		const aborted = () => new McpError("aborted", "MCP discovery aborted");
		if (signal?.aborted) throw aborted();
		if (closed || state.declaration.trust.status !== "trusted") return;
		// Declarations are a session snapshot, but a plugin's servers serve only
		// while the plugin still loads the content they were declared from.
		const plugin = state.declaration.plugin;
		const revoked = plugin !== undefined ? pluginServerRevocation(plugin, options.cwd) : null;
		if (revoked !== null || state.failure !== null || state.recovery !== undefined || state.relaunch === true) {
			// Concurrent callers share recovery; never overlap process groups or
			// replay the failed call. Discovery revalidates the live tool list.
			state.recovery ??= (async () => {
				state.relaunch = false;
				await closeClient(state);
				state.connection = null;
				state.client = null;
				state.listed = false;
				state.failure = null;
				delete state.needsAuth;
				delete state.skills;
				for (const name of state.registered) registry.unregister?.(name);
				state.registered = [];
				state.unregistrable = [];
				state.refused.clear();
				delete state.prompts;
				delete state.promptsObservedAt;
				delete state.listingObservedAt;
				delete state.resourceList;
				delete state.events;
				delete state.eventsFailure;
			})();
			await state.recovery;
			delete state.recovery;
			if (revoked !== null) {
				state.failure = revoked;
				return;
			}
			if (closed || signal?.aborted) return;
		}
		const refreshLive = refresh && state.listed === true;
		state.connection ??= startConnection(state);
		const connection = state.connection;
		const onAbort = (): void => {
			state.failure = errorMessage(aborted());
			void connection.close();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await connection.ready;
			if (signal?.aborted) {
				await connection.close();
				throw aborted();
			}
			const client = state.client;
			if (closed || client === null || state.failure !== null) return;
			if (refreshLive || client.toolsChanged() || client.eventsChanged() || state.refreshing !== undefined) {
				state.refreshing ??= (async () => {
					// A notification received during tools/list stays dirty for the next
					// discovery; acknowledging after the response would lose it.
					client.acknowledgeToolsChanged();
					try {
						const listing = await client.listTools(signal);
						if (closed || signal?.aborted || state.client !== client || state.failure !== null) return;
						await listEventsOf(state, client, signal);
						if (closed || signal?.aborted || state.client !== client || state.failure !== null) return;
						installListing(state, listing);
						if (refreshLive) await listSkills(state, signal);
					} catch (error) {
						state.failure ??= errorMessage(error);
						await closeClient(state);
						for (const name of state.registered) registry.unregister?.(name);
						state.registered = [];
						state.listed = false;
					}
				})().finally(() => {
					delete state.refreshing;
				});
				await state.refreshing;
				if (signal?.aborted) throw aborted();
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	const listingFor = (state: ServerState): McpServerListing => {
		const { declaration } = state;
		const base = { id: declaration.id, scope: declaration.scope, actionClass: declaration.trust.actionClass };
		if (declaration.trust.status !== "trusted") {
			return {
				...base,
				status: declaration.trust.status,
				reason: declaration.trust.reason,
				...mcpTrustRemedy(declaration.id),
			};
		}
		if (state.failure !== null) {
			if (state.needsAuth === true) {
				return { ...base, status: "needs-auth", reason: state.failure, remedy: `pancode mcp login ${declaration.id}` };
			}
			return { ...base, status: "failed", reason: state.failure };
		}
		const surface = surfaceOf(state);
		const surfaced = surface !== null ? { surface } : {};
		// Server-written guidance, shown beside its tools and never in the system prompt.
		const guided = (instructions: string | null | undefined): { instructions?: string } =>
			typeof instructions === "string" && instructions.length > 0 ? { instructions: neutralizeFraming(instructions) } : {};
		// Server-written like the instructions, so its text can never open a host frame.
		const eventsOf = (
			events: ReadonlyArray<{
				name: string;
				description: string;
				delivery: string[];
				inputSchema: Record<string, unknown>;
			}>,
		): McpServerEventListing[] =>
			events.map((event) => ({
				name: neutralizeFraming(event.name),
				description: neutralizeFraming(event.description),
				delivery: [...event.delivery],
				arguments: neutralizeFramingValue(event.inputSchema) as Record<string, unknown>,
			}));
		if (state.client !== null) {
			const tools = state.registered.filter(
				(name) => !isMcpResourceCapability(name.slice(`mcp_${declaration.id}__`.length)),
			);
			const prompts = state.prompts?.prompts.length ?? cachedCatalog(state)?.prompts?.prompts.length;
			const resourceCount = resourceCountOf(state) ?? cachedCatalog(state)?.resourceCount;
			const live = state.events;
			return {
				...base,
				status: "connected",
				catalog: "live",
				catalogCount: tools.length,
				tools,
				...(declares(state.client, "resources") ? { resources: true as const } : {}),
				...(declares(state.client, "resources") && resourceCount !== undefined ? { resourceCount } : {}),
				...(declares(state.client, "prompts") && prompts !== undefined ? { prompts } : {}),
				...(state.truncated ? { truncated: true } : {}),
				...(state.unregistrable.length > 0 ? { unregistrable: [...state.unregistrable] } : {}),
				...(state.dropped !== undefined && state.dropped.length > 0 ? { dropped: [...state.dropped] } : {}),
				...guided(state.client.serverInfo()?.instructions),
				...surfaced,
				...(live !== undefined && live.events.length > 0 ? { events: eventsOf(live.events) } : {}),
				...(live?.truncated === true ? { eventsTruncated: true as const } : {}),
				...(state.eventsFailure !== undefined ? { eventsFailure: neutralizeFraming(state.eventsFailure) } : {}),
			};
		}
		// A trusted server that was never launched is still only trusted. Its
		// catalog provenance is a separate field precisely so a cache hit can
		// never read as a running process.
		const catalog = cachedCatalog(state);
		if (catalog === null) {
			return { ...base, status: "trusted", catalog: "missing", catalogRemedy: catalogRemedy(declaration.id), ...surfaced };
		}
		return {
			...base,
			status: "trusted",
			catalog: "cached",
			catalogCount: catalog.tools.length,
			...(catalog.truncated ? { truncated: true } : {}),
			...(mcpCatalogStale(catalog) ? { catalogStale: true, catalogRemedy: catalogRemedy(declaration.id) } : {}),
			...(catalog.resources === true ? { resources: true as const } : {}),
			...(catalog.resources === true && catalog.resourceCount !== undefined
				? { resourceCount: catalog.resourceCount }
				: {}),
			...(catalog.prompts !== undefined ? { prompts: catalog.prompts.prompts.length } : {}),
			...guided(catalog.instructions),
			...surfaced,
			...(catalog.events !== undefined && catalog.events.length > 0 ? { events: eventsOf(catalog.events) } : {}),
		};
	};

	// The owner rule is shared with worker admission, so a dispatch and the
	// session it runs in can never route one name to two servers.
	const ownerOf = (name: string): ServerState | null => {
		const all = resolveStates();
		const owner = mcpToolOwner(
			[...all.values()].map((state) => state.declaration),
			name,
		);
		return owner === null ? null : (all.get(owner.declaration.id) ?? null);
	};

	/**
	 * Every capability a server's metadata records, live or cached. A cached
	 * name goes through the same ownership rule a live one does, so a tool whose
	 * composed name belongs to a longer-named server is dropped here exactly as
	 * discovery drops it, and cache load order can never decide routing.
	 */
	const entriesFor = (state: ServerState): McpCatalogEntry[] => {
		const { declaration } = state;
		if (declaration.trust.status !== "trusted" || state.failure !== null) return [];
		if (state.client !== null) {
			return state.registered.flatMap((name) => {
				const spec = registry.get(name);
				return spec === undefined
					? []
					: [{ name, description: spec.description, actionClass: spec.baseActionClass as McpTrustActionClass }];
			});
		}
		const catalog = cachedCatalog(state);
		if (catalog === null) return [];
		const entries: McpCatalogEntry[] = [];
		for (const tool of catalog.tools) {
			const name = mcpToolName(declaration.id, tool.name);
			// A name the registry already holds is served by that live spec instead;
			// a cached descriptor must never shadow a connected one.
			if (name === null || ownerOf(name) !== state || registry.get(name) !== undefined) continue;
			const presentation = toolFilePresentation(declaration, tool, catalog.files === true);
			entries.push({
				name,
				description: presentation.description,
				actionClass: actionClassFor(declaration, tool),
			});
		}
		if (catalog.resources === true) {
			for (const which of ["list", "read"] as const) {
				const tool = which === "list" ? ":list_resources" : ":read_resource";
				const name = mcpToolName(declaration.id, tool);
				if (name === null || ownerOf(name) !== state || registry.get(name) !== undefined) continue;
				const shape = resourceCapabilityShape(declaration.id, which);
				entries.push({
					name,
					description: shape.description,
					actionClass: actionClassFor(declaration, { ...shape, name: tool }),
				});
			}
		}
		return entries;
	};

	const resourceHost: McpResourceHost = {
		admitted: options.admitted,
		discover: (state, signal) => discover(state, signal),
		surfaceRefusal: (state, name) => surfaceRefusal(state, name),
		launchRefusal: (state, launch) => readOnlyLaunchRefusal(state.declaration, launch?.readOnly),
		closeClient: (state) => closeClient(state),
		publish: (state) => {
			cachedCatalog(state);
			publishCatalog(state);
		},
	};

	const checkEventAuthority = (id: string, launch?: { readOnly?: boolean }): string | null => {
		const state = resolveStates().get(id);
		if (state === undefined) {
			const declared = [...resolveStates().keys()].sort();
			return `no MCP server named '${id}' is declared${declared.length > 0 ? `; declared servers: ${declared.join(", ")}` : ""}`;
		}
		const { declaration } = state;
		if (declaration.scope === "client") {
			return `MCP server '${id}' was supplied by the ACP client for this session only; an event job subscribes only to a server declared in PanCode's MCP config`;
		}
		if (declaration.trust.status !== "trusted") {
			const remedy = mcpTrustRemedy(id);
			return `MCP server '${id}' is ${declaration.trust.status} (${declaration.trust.reason}); run ${remedy.remedy} (${remedy.interactiveRemedy} in an interactive session)`;
		}
		const revoked = declaration.plugin !== undefined ? pluginServerRevocation(declaration.plugin, options.cwd) : null;
		if (revoked !== null) return revoked;
		const readOnly = readOnlyLaunchRefusal(declaration, launch?.readOnly);
		if (readOnly !== null && state.client === null) return readOnly;
		if (state.surface !== undefined) {
			const surface = surfaceRefusal(state, `MCP server '${id}'`);
			if (surface !== null) return surface;
		}
		return null;
	};
	return {
		async attachClientServers(servers, attachOptions) {
			if (closed) throw new Error("MCP capability source is closed");
			if (servers.length > 0 && !registry.unregister) {
				throw new Error("MCP registry cannot remove session scoped tools");
			}
			const all = resolveStates();
			const added: ServerState[] = [];
			for (const server of servers) {
				const slug = server.name
					.toLowerCase()
					.replace(/[^a-z0-9_-]+/g, "_")
					.replace(/^_+|_+$/g, "")
					.slice(0, 24);
				const base = `acp_${slug || "server"}`;
				let id = base;
				for (let suffix = 2; all.has(id); suffix += 1) id = `${base.slice(0, 28)}_${suffix}`;
				const common = {
					id,
					scope: "client" as const,
					path: "ACP client session",
					cwd: options.cwd,
					cwdRoot: options.cwd,
					timeoutMs: null,
					actionClass: "unknown" as const,
					toolActionClasses: {},
					digest: "session-only",
					trust: { status: "trusted" as const, actionClass: "unknown" as const },
				};
				const declaration: GatewayMcpServer =
					"url" in server
						? { ...common, url: server.url, headers: {} }
						: { ...common, command: server.command, args: [...server.args], env: { ...server.env } };
				const state: ServerState = {
					...freshServerState(declaration),
					...("url" in server ? { clientHeaders: { ...server.headers } } : {}),
				};
				all.set(id, state);
				added.push(state);
			}
			if (attachOptions?.start === false) return;
			await Promise.all(added.map((state) => discover(state)));
		},
		async detachClientServers() {
			if (states === null) return;
			const all = states;
			const clients = [...all.values()].filter((state) => state.declaration.scope === "client");
			await Promise.all(clients.map(closeClient));
			await Promise.all(clients.map((state) => state.connection?.ready));
			for (const state of clients) {
				for (const name of state.registered) registry.unregister?.(name);
				all.delete(state.declaration.id);
			}
		},
		reloadDeclarations: createMcpDeclarationReloader({
			isClosed: () => closed,
			trustOptions,
			states: resolveStates,
			close: closeClient,
			unregister: (name) => registry.unregister?.(name),
			admit: admittedDeclaration,
			setDiagnostics: (next) => {
				diagnostics = next;
			},
		}),
		async list(invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const all = [...resolveStates().values()];
			const results = await Promise.allSettled(all.map((state) => discover(state, invokeOptions?.signal)));
			for (const result of results) {
				if (result.status === "rejected") throw result.reason;
			}
			// Wait for initial prompt and resource listings so `mcp list --refresh` records them before closing.
			if (!invokeOptions?.signal?.aborted) {
				await Promise.allSettled(
					all.flatMap((state) => [state.promptsListing, state.resourcesListing].filter((p) => p !== undefined)),
				);
			}
			return { servers: all.map(listingFor), diagnostics: [...diagnostics] };
		},
		catalog() {
			const all = [...resolveStates().values()];
			const servers = all.map(listingFor);
			return {
				servers,
				entries: all.flatMap(entriesFor),
				diagnostics: [...diagnostics],
				missing: servers.filter((server) => server.catalog === "missing").map((server) => server.id),
				changed: all
					.filter((state) => state.client?.toolsChanged() === true || state.client?.eventsChanged() === true)
					.map((state) => state.declaration.id),
			};
		},
		metadata(name) {
			const owner = ownerOf(name);
			if (owner === null) return { metadata: null, reason: `no declared MCP server owns ${name}` };
			const { declaration } = owner;
			const toolName = name.slice(`mcp_${declaration.id}__`.length);

			if (declaration.trust.status !== "trusted") {
				const remedy = mcpTrustRemedy(declaration.id);
				return {
					metadata: null,
					reason: `mcp server ${declaration.id} is ${declaration.trust.status} (${declaration.trust.reason}); it is never launched until trusted: run ${remedy.remedy} (${remedy.interactiveRemedy} in an interactive session)`,
				};
			}
			const registered = registry.get(name as DynamicToolName);
			if (registered !== undefined && owner.registered.includes(registered.name as DynamicToolName)) {
				return {
					metadata: {
						name: registered.name,
						serverId: declaration.id,
						description: registered.description,
						parameters: registered.parameters as Record<string, unknown>,
						actionClass: registered.baseActionClass as McpTrustActionClass,
						provenance: "live",
						truncated: owner.truncated,
					},
				};
			}
			if (owner.failure !== null) {
				return { metadata: null, reason: `mcp server ${declaration.id} failed: ${owner.failure}` };
			}
			// A connected server's own listing is the session's answer; its
			// catalog file describes the same connection and adds nothing.
			if (owner.client !== null) {
				const offered = owner.tools.find((entry) => entry.name === toolName);
				return {
					metadata: null,
					reason:
						offered === undefined
							? `mcp server ${declaration.id} offers no tool named ${toolName}`
							: `mcp server ${declaration.id} offers ${toolName}, but ${name} is not carried as a capability name; another declared server owns that name`,
				};
			}
			const catalog = cachedCatalog(owner);
			if (catalog === null) {
				return {
					metadata: null,
					reason: `no recorded catalog for mcp server ${declaration.id}; list its tools with ${catalogRemedy(declaration.id)}`,
				};
			}
			if (isMcpResourceCapability(toolName) && catalog.resources === true) {
				const shape = resourceCapabilityShape(declaration.id, toolName === ":list_resources" ? "list" : "read");
				return {
					metadata: {
						name,
						serverId: declaration.id,
						description: shape.description,
						parameters: shape.parameters,
						actionClass: actionClassFor(declaration, { ...shape, name: toolName }),
						provenance: "cached",
						truncated: false,
						...(mcpCatalogStale(catalog) ? { catalogStale: true } : {}),
					},
				};
			}
			const tool = catalog.tools.find((entry) => entry.name === toolName);
			if (tool === undefined) {
				return {
					metadata: null,
					reason: `mcp server ${declaration.id} records no tool named ${toolName}${catalog.truncated ? `, and its catalog is incomplete: list it again with ${catalogRemedy(declaration.id)}` : ""}`,
				};
			}
			const presentation = toolFilePresentation(declaration, tool, catalog.files === true);
			return {
				metadata: {
					name,
					serverId: declaration.id,
					description: presentation.description,
					parameters: presentation.parameters,
					actionClass: actionClassFor(declaration, tool),
					provenance: "cached",
					truncated: catalog.truncated,
					...(mcpCatalogStale(catalog) ? { catalogStale: true } : {}),
				},
			};
		},
		async refresh(id, invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const state = resolveStates().get(id);
			if (state === undefined) return { listing: null, reason: `no MCP server named '${id}' is declared` };
			const trust = state.declaration.trust;
			if (trust.status !== "trusted") {
				const remedy = mcpTrustRemedy(id);
				return {
					listing: listingFor(state),
					reason: `mcp server ${id} is ${trust.status} (${trust.reason}); it is never launched until trusted: run ${remedy.remedy} (${remedy.interactiveRemedy} in an interactive session)`,
				};
			}
			// Re-listing an already running server sends tools/list without launching anything.
			const refusal = state.client !== null ? null : readOnlyLaunchRefusal(state.declaration, invokeOptions?.readOnly);
			if (refusal !== null) return { listing: listingFor(state), reason: refusal };
			await discover(state, invokeOptions?.signal, true);
			await Promise.allSettled(
				[state.skillsListing, state.promptsListing, state.resourcesListing].filter((p) => p !== undefined),
			);
			return {
				listing: listingFor(state),
				...(state.failure !== null ? { reason: `mcp server ${id} failed: ${state.failure}` } : {}),
			};
		},
		declaredIds() {
			return [...resolveStates().keys()];
		},
		async ensure(name, invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const owner = ownerOf(name);
			if (owner === null) return { spec: null, reason: `no declared MCP server owns ${name}` };
			const trust = owner.declaration.trust;
			if (trust.status !== "trusted") {
				const remedy = mcpTrustRemedy(owner.declaration.id);
				return {
					spec: null,
					reason: `mcp server ${owner.declaration.id} is ${trust.status} (${trust.reason}); it is never launched until trusted: run ${remedy.remedy} (${remedy.interactiveRemedy} in an interactive session)`,
				};
			}
			// Resource capabilities are read by PanCode's rule, not the operator's, so they never start a server read-only.
			const toolName = name.slice(`mcp_${owner.declaration.id}__`.length);
			const refusal = readOnlyLaunchRefusal(
				owner.declaration,
				invokeOptions?.readOnly,
				isMcpResourceCapability(toolName) ? undefined : toolName,
			);
			if (refusal !== null) return { spec: null, reason: refusal };
			await discover(owner, invokeOptions?.signal);
			const spec = registry.get(name as DynamicToolName);
			if (spec !== undefined && owner.registered.includes(spec.name as DynamicToolName)) return { spec };
			return {
				spec: null,
				reason:
					owner.failure !== null
						? `mcp server ${owner.declaration.id} failed: ${owner.failure}`
						: isMcpResourceCapability(toolName)
							? `mcp server ${owner.declaration.id} declares no resources`
							: `mcp server ${owner.declaration.id} offers no tool named ${toolName}`,
			};
		},
		serverInstructions(name) {
			const owner = ownerOf(name);
			return owner === null ? null : (listingFor(owner).instructions ?? null);
		},
		takeCatalogChange(name) {
			const owner = ownerOf(name);
			const line = owner?.catalogChange;
			if (owner === null || line === undefined) return null;
			delete owner.catalogChange;
			return line;
		},
		authorityNote(name, shownClass) {
			const owner = ownerOf(name);
			if (owner === null) return null;
			const { declaration } = owner;
			if (declaration.scope === "client") {
				return declaration.url !== undefined
					? `Remote MCP server ${declaration.id} at ${mcpOriginOf(declaration.url)}, supplied by the ACP client for this session. Calls use the unknown action class, ask at default autonomy, and run at yolo. What a call sends leaves this machine, and the connection closes with the session.`
					: `Local stdio MCP server ${declaration.id}, supplied by the ACP client for this session. Calls use the unknown action class, ask at default autonomy, and run at yolo. The server closes with the session.`;
			}
			// The server's trust class is only its default: toolActionClasses and
			// the Slurm defaults class tools one by one (K5), so the note names the
			// class this tool is admitted under and any confirmation rule it carries.
			const toolName = name.slice(`mcp_${declaration.id}__`.length);
			const listed =
				owner.tools.find((entry) => entry.name === toolName) ??
				cachedCatalog(owner)?.tools.find((entry) => entry.name === toolName);
			const actionClass =
				shownClass ?? mcpToolActionClass(declaration, { name: toolName, annotations: listed?.annotations ?? null });
			if (isMcpResourceCapability(toolName)) {
				const surface = surfaceOf(owner);
				const unapproved =
					surface === null || surface.status === "approved" ? "" : ` Reads are refused for now: ${surface.reason}.`;
				return `Resources of local stdio MCP server ${declaration.id} (${declaration.scope} scope, declared in ${declaration.path}), trusted with action class ${declaration.trust.actionClass}; listing and reading resources runs as ${actionClass}, and needs the server's tool surface approved; ${launchConfinement()}.${unapproved}`;
			}
			const serverClass = declaration.trust.actionClass;
			const remote = declaration.url !== undefined;
			const effect =
				actionClass === "read"
					? "calls run as reads at every autonomy level"
					: actionClass === "execute"
						? remote
							? "calls run as executing actions (ask at default, run at yolo, and read-only denies them)"
							: "calls are admitted like an unrecognized shell command"
						: actionClass === "destructive"
							? "every call asks at default, runs at yolo, and read-only denies it"
							: "every call asks for approval and read-only denies it";
			const rule = mcpToolConfirmationRule(declaration, toolName);
			const confirmation =
				rule === null
					? ""
					: `; the ${rule} confirmation rule also asks the operator before every call below yolo, and read-only denies it`;
			const surface = surfaceOf(owner);
			const unapproved =
				surface === null || surface.status === "approved" ? "" : ` Calls are refused for now: ${surface.reason}.`;
			const serverLabel = remote
				? `Remote MCP server ${declaration.id} at ${mcpOriginOf(declaration.url)}`
				: `Local stdio MCP server ${declaration.id}`;
			const confinement = remote ? "it runs off this machine, and what a call sends leaves it" : launchConfinement();
			const filesOffered =
				owner.client !== null ? owner.client.filesOffered() !== null : cachedCatalog(owner)?.files === true;
			const sendsFiles =
				listed !== undefined && filesOffered && mcpFileSchema(listed.inputSchema).kind === "files"
					? " A call that names a file sends it to the server and storage it names, so that call is an outward action run as at least execute: the safety judge reviews it against the operator's messages, yolo runs it only when those messages name it, and read-only denies it."
					: "";
			return `${serverLabel} (${declaration.scope} scope, declared in ${declaration.path}), trusted with action class ${serverClass}${
				actionClass === serverClass ? "" : `; this tool runs as ${actionClass}`
			}: ${effect}${confirmation}; ${confinement}.${sendsFiles}${unapproved}`;
		},
		ownerIdOf(name) {
			return ownerOf(name)?.declaration.id ?? null;
		},
		discoveryNote(name) {
			const state = ownerOf(name);
			if (state === null) return null;
			const toolName = name.slice(`mcp_${state.declaration.id}__`.length);
			const tool =
				state.tools.find((entry) => entry.name === toolName) ??
				cachedCatalog(state)?.tools.find((entry) => entry.name === toolName);
			const hint = tool === undefined ? undefined : serverHintOf(tool);
			const refused = state.refused.get(toolName);
			return {
				...(hint !== undefined ? { serverHint: hint } : {}),
				...(refused !== undefined
					? { unavailable: `refused by MCP server ${state.declaration.id} policy (${refused}) this session` }
					: {}),
			};
		},
		transportOf(name) {
			const declaration = ownerOf(name)?.declaration;
			if (declaration === undefined) return null;
			if (declaration.url !== undefined) return mcpRemoteTransportIdentity(declaration.id, declaration.url);
			return mcpTransportIdentity(declaration.id, declaration.command, declaration.args, declaration.cwd, declaration.env);
		},
		servedSurface(id) {
			return resolveStates().get(id)?.surface?.served ?? null;
		},
		promptCommands() {
			return [...resolveStates().values()].flatMap((state) =>
				promptCommandsOf(resourceHost, state, state.declaration.trust.status === "trusted" ? cachedCatalog(state) : null),
			);
		},
		resourceServerIds() {
			return [...resolveStates().values()]
				.filter(
					(state) =>
						state.declaration.trust.status === "trusted" &&
						(state.client !== null ? declares(state.client, "resources") : cachedCatalog(state)?.resources === true),
				)
				.map((state) => state.declaration.id);
		},
		async listResources(id, launch) {
			const state = resolveStates().get(id);
			if (state === undefined) return { ok: false, error: `no MCP server named '${id}' is declared` };
			return listResourcesFor(resourceHost, state, launch);
		},
		async readResource(id, uri, launch) {
			const state = resolveStates().get(id);
			if (state === undefined) return { ok: false, error: `no MCP server named '${id}' is declared` };
			return readResourceFor(resourceHost, state, uri, launch);
		},
		async getPrompt(id, name, args, launch) {
			const state = resolveStates().get(id);
			if (state === undefined) return { ok: false, error: `no MCP server named '${id}' is declared` };
			return getPromptFor(resourceHost, state, name, args, launch);
		},
		async complete(id, ref, argument, context, signal) {
			const state = states?.get(id);
			const client = state?.client ?? null;
			if (state === undefined || client === null || !declares(client, "completions")) return null;
			if (state.surface?.status.status !== "approved" && state.declaration.scope !== "client") return null;
			try {
				return await client.complete(ref, argument, context, signal);
			} catch {
				// Completion is a hint; a server that cannot give one leaves the operator typing.
				return null;
			}
		},
		eventAuthorityRefusal(id, launch) {
			return checkEventAuthority(id, launch);
		},
		async eventServer(id, launch) {
			const authorityRefusal = checkEventAuthority(id, launch);
			if (authorityRefusal !== null) return { refusal: authorityRefusal };
			const state = resolveStates().get(id);
			if (state === undefined) return { refusal: `no MCP server named '${id}' is declared` };
			// A subscriber reconnecting after the server exited gets a relaunch, the way a failed tool call's next call does.
			const exited = state.client?.state().status;
			if (state.failure === null && (exited === "failed" || exited === "closed")) {
				const reason = state.client?.state();
				state.failure = reason?.status === "failed" ? reason.reason : "the server exited";
			}
			try {
				await discover(state, launch?.signal);
			} catch (error) {
				return { refusal: `MCP server '${id}' could not be reached: ${errorMessage(error)}` };
			}
			if (state.failure !== null) return { refusal: `MCP server '${id}' failed: ${state.failure}` };
			const client = state.client;
			if (client === null) return { refusal: `MCP server '${id}' is not running` };
			const surface = surfaceRefusal(state, `MCP server '${id}'`);
			if (surface !== null) return { refusal: surface };
			if (client.eventsOffered() === null) {
				return {
					refusal: `MCP server '${id}' does not offer MCP Events (io.modelcontextprotocol/events) in its server/discover capabilities`,
				};
			}
			if (state.eventsFailure !== undefined) {
				return { refusal: `MCP server '${id}' could not list its event types: ${state.eventsFailure}` };
			}
			return { client, events: state.events?.events ?? [] };
		},
		async skillAccess(id, invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const state = resolveStates().get(id);
			if (state === undefined) return { transport: null, reason: `no MCP server named '${id}' is declared` };
			const prior = state.skills;
			const { declaration } = state;
			if (declaration.scope === "client") {
				return { transport: null, reason: `skills of ACP client server ${id} are not loaded` };
			}
			if (declaration.trust.status !== "trusted") {
				const remedy = mcpTrustRemedy(id);
				return {
					transport: null,
					reason: `mcp server ${id} is ${declaration.trust.status} (${declaration.trust.reason}); it is never launched until trusted: run ${remedy.remedy} (${remedy.interactiveRemedy} in an interactive session)`,
				};
			}
			const refusal = readOnlyLaunchRefusal(declaration, invokeOptions?.readOnly);
			if (refusal !== null) return { transport: null, reason: refusal };
			await discover(state, invokeOptions?.signal);
			const client = state.client;
			if (state.failure !== null || client === null) {
				return { transport: null, reason: `mcp server ${id} failed: ${state.failure ?? "it is not connected"}` };
			}
			const offered = mcpClientSkills(client, client.serverInfo()?.capabilities);
			if (offered.transport === null) {
				return { transport: null, reason: `mcp server ${id} serves no skills: ${offered.reason}` };
			}
			if (state.skillsListing !== undefined) await state.skillsListing;
			const held = state.skills;
			// Listed again lazily, at the first access after the server's ttlMs passed, never on a timer.
			// A listing produced during this access (cold connect or in-flight listSkills) satisfies it without a second RPC.
			if (
				held === undefined ||
				"failure" in held ||
				(held === prior && (invokeOptions?.relist === true || Date.now() - held.listedAtMs >= held.listing.ttlMs))
			) {
				await listSkills(state, invokeOptions?.signal);
			}
			const listed = state.skills;
			if (listed === undefined) return { transport: null, reason: `mcp server ${id} has not listed its skills` };
			if ("failure" in listed) {
				return { transport: null, reason: `mcp server ${id} could not list its skills: ${listed.failure}` };
			}
			return { transport: offered.transport, listing: listed.listing, declaration };
		},
		servedSkills(id) {
			const held = resolveStates().get(id)?.skills;
			return held !== undefined && "listing" in held ? held.listing : null;
		},
		connectedIds(options) {
			return [...(states?.values() ?? [])]
				.filter((state) => state.client !== null && (!options?.readyOnly || state.client.state().status === "ready"))
				.map((state) => state.declaration.id);
		},
		teardownReports() {
			return [...teardowns];
		},
		close() {
			if (closePromise !== null) return closePromise;
			closed = true;
			if (idleSweep !== null) clearInterval(idleSweep);
			closePromise = (async () => {
				const all = [...(states?.values() ?? [])];
				await Promise.all(all.map(closeClient));
				await Promise.all(all.map((state) => state.connection?.ready));
				const report: McpCloseReport = { incomplete: [] };
				for (const { id, outcome } of teardowns) {
					if (!outcome.complete) report.incomplete.push({ id, pgid: outcome.pgid, boundMs: outcome.boundMs });
				}
				if (exitHookInstalled) {
					process.removeListener("exit", killLaunchedOnExit);
					exitHookInstalled = false;
				}
				return report;
			})();
			return closePromise;
		},
	};
}
