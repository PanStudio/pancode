// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import type { TSchema } from "typebox";
import { neutralizeFraming } from "../../core/reminder-framing.js";
import { workerSandboxApplies } from "../../core/sandbox/worker-process.js";
import type { DynamicToolName } from "../../core/tool-names.js";
import { mcpToolName } from "../../core/tool-names.js";
import { mcpToolActionClass, mcpToolConfirmationRule, mcpToolOwner } from "../../domains/gateway/mcp/action-classes.js";
import type {
	McpCatalogIdentity,
	McpClient,
	McpClientOptions,
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
	currentMcpSurfaceApproval,
	judgeMcpSurface,
	McpError,
	mcpBuiltinLaunchArgs,
	mcpBuiltinLaunchEnvironment,
	mcpCatalogDigest,
	mcpCatalogStale,
	mcpOriginOf,
	mcpSurface,
	mcpSurfaceRemedy,
	mcpSurfaceRemedyFor,
	openMcpHeaderCredentialStore,
	pluginServerRevocation,
	readMcpServerCatalog,
	resolveMcpHeaders,
	resolveMcpServers,
	writeMcpServerCatalog,
} from "../../domains/gateway/mcp/index.js";
import { acceptsImageInput } from "../../domains/providers/image-input.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import { mcpRemoteTransportIdentity, mcpTransportIdentity } from "../../domains/safety/information-flow.js";
import type { WorkerMcpAttestation } from "../../domains/safety/worker-permit.js";
import type { StoreBackend } from "../../domains/store/index.js";
import { readMaxBytes } from "../read.js";
import type { ToolResult, ToolSpec } from "../tool-spec.js";
import {
	boundedImageResult,
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
	McpServerListing,
	McpServerSurfaceListing,
	McpTeardownReport,
	OwnedConnection,
	ServerState,
} from "./mcp-capability-types.js";
import { catalogChangeLine, catalogRemedy, withCatalogChange } from "./mcp-catalog-change.js";
import { namedPathArguments, pathArgumentEffects, pathArgumentRefusal } from "./mcp-path-arguments.js";
import {
	builtinStoreWrite,
	builtinStoreWriteCall,
	commitStoreReferences,
	defaultOpenStoreBackend,
	isBuiltinStoreWriteTool,
	launchedWithTag,
	namedStoreReferences,
	type PreparedStoreReferences,
	prepareStoreReferences,
	removeTemporaries,
	storedLines,
	storeReferenceEffects,
	storeReferencesRefusal,
	storeServerLaunchContext,
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

/** Serialize an argv vector for the shell classifier only. No shell executes this text. */
function quoted(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createMcpCapabilitySource(options: McpCapabilitySourceOptions): McpCapabilitySource {
	const registry = options.registry;
	const clientFactory = options.clientFactory ?? createMcpClient;
	const headerCredentials = options.headerCredentials ?? openMcpHeaderCredentialStore;
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
		state.lastUsed = Date.now();
		if (idleSweep !== null) return;
		idleSweep = setInterval(() => {
			const now = Date.now();
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
		...(options.builtin !== undefined ? { builtin: options.builtin } : {}),
	};
	const attended = options.attended ?? (process.env.PANCODE_INTERACTIVE === "1" && process.stdin.isTTY === true);

	const surfaceListing = (
		declaration: GatewayMcpServer,
		status: McpSurfaceStatus,
		recorded = false,
	): McpServerSurfaceListing => ({
		...status,
		...(status.status !== "approved" ? { remedy: mcpSurfaceRemedyFor(declaration) } : {}),
		...(recorded ? { recorded: true as const } : {}),
	});

	/**
	 * Judge a served surface against the approval the trust state holds now. An
	 * attended session records a user-scope server's surface the first time it
	 * sees one; a project or plugin server's surface is only ever approved by the
	 * operator's own command, and a changed surface is never recorded over.
	 */
	const judgeServedSurface = (declaration: ResolvedMcpServer, served: McpSurface): McpServerSurfaceListing => {
		if (options.admitted !== undefined) return judgeAttestedSurface(declaration, served, options.admitted);
		const status = judgeMcpSurface(declaration, currentMcpSurfaceApproval(declaration, trustOptions), served);
		if (
			status.status !== "unapproved" ||
			declaration.scope !== "user" ||
			!attended ||
			options.persistCatalog === false ||
			options.admitted !== undefined
		) {
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
			reason:
				declaration.scope === "builtin"
					? `the tool surface builtin server '${declaration.id}' serves (${served.digest}) is not the policy this PanCode ships, which this run was admitted with (${attested ?? "none"}); ${mcpSurfaceRemedyFor(declaration)}, and dispatch again`
					: `the tool surface MCP server '${declaration.id}' serves (${served.digest}) is not the one this run was admitted with (${attested ?? "none"}); review it, run ${mcpSurfaceRemedy(declaration.id)}, and dispatch again`,
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
		// A builtin server starts in the project root, so in a worker it starts in the worker's tree as a project server does.
		if (options.launchRoot === undefined || (declaration.scope !== "project" && declaration.scope !== "builtin")) {
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
		const attested = admitted.tools.find((entry) => entry.serverId === declaration.id);
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
					reason:
						declaration.scope === "builtin"
							? `builtin server '${declaration.id}' changed since this run was admitted; dispatch again`
							: `declaration of '${declaration.id}' changed since this run was admitted; review it, run pancode mcp trust ${declaration.id}, and dispatch again`,
				},
			};
		}
		return declaration;
	};

	const resolveStates = (): Map<string, ServerState> => {
		if (states !== null) return states;
		const resolved = resolveMcpServers(trustOptions);
		diagnostics = [
			...resolved.diagnostics.map((entry) => `${entry.scope} ${entry.path}: ${entry.message}`),
			...resolved.trustDiagnostics,
		];
		states = new Map(
			resolved.servers.map((declaration) => [
				declaration.id,
				{
					declaration: admittedDeclaration(declaration),
					client: null,
					connection: null,
					tools: [],
					truncated: false,
					registered: [],
					unregistrable: [],
					refused: new Map(),
					failure: null,
					catalog: undefined,
				},
			]),
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
			digest: mcpCatalogDigest(declaration, headerCredentials),
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
	const publishCatalog = (state: ServerState, listing: McpToolListing): void => {
		if (state.declaration.scope === "client" || options.persistCatalog === false) return;
		writeMcpServerCatalog(catalogIdentity(state.declaration), {
			...listing,
			instructions: state.client?.serverInfo()?.instructions ?? null,
		});
		// Drop the memo of whatever the file said before this listing replaced it.
		state.catalog = undefined;
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
		const writesStore = isBuiltinStoreWriteTool(declaration.id, declaration.scope, tool.name);
		const spec: ToolSpec = {
			name,
			description: describeTool(declaration, tool),
			parameters: tool.inputSchema as TSchema,
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
				// A store reference or the builtin store server's own write that the session may not make, or that
				// names a missing tag or blob, is refused before the server starts; the checks repeat before the call.
				const references = pathArguments === undefined ? [] : namedStoreReferences(pathArguments, args);
				if (typeof references === "string") return refusedReference(references);
				const backend = storeBackend();
				const storeWrite = writesStore ? builtinStoreWrite(tool.name, args, pathCwd) : null;
				const storeRefusal = await storeReferencesRefusal({
					references,
					write: storeWrite,
					access: options.store,
					backend,
				});
				if (storeRefusal !== null) return refusedReference(storeRefusal);
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
				let callClient = client;
				if (storeWrite !== null) {
					// A tag created after the server started: start it again once, with the tags the store lists now.
					if (
						options.store?.writable === true &&
						state.launchWriteTags !== undefined &&
						!launchedWithTag(state.launchWriteTags, storeWrite.tag)
					) {
						state.relaunch = true;
						await discover(state, invokeOptions?.signal);
						const relaunched = state.client as McpClient | null;
						if (relaunched === null || relaunched.state().status !== "ready") {
							return {
								kind: "error",
								message: `${name}: mcp server ${declaration.id} did not start again for tag '${storeWrite.tag}'${state.failure ? ` (${state.failure})` : ""}; the next call can retry`,
							};
						}
						callClient = relaunched;
					}
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
				const progress = invokeOptions?.onUpdate === undefined ? null : mcpProgressReporter(name, invokeOptions.onUpdate);
				state.inflight = (state.inflight ?? 0) + 1;
				state.lastUsed = Date.now();
				try {
					const result = await callClient.callTool(tool.name, prepared?.args ?? args, {
						...(invokeOptions?.signal ? { signal: invokeOptions.signal } : {}),
						...(timeoutMs !== undefined ? { timeoutMs } : {}),
						...(progress !== null ? { onProgress: progress.onProgress } : {}),
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
					const rendered = offloadedBinaryText(result, invokeOptions) ?? {
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
					};
					if (result.isError) {
						const refusal = serverPolicyRefusalResult(state, tool, name, trustClass, result);
						if (refusal !== null) return refusal;
						return withCatalogChange(state, {
							kind: "error",
							message: `${name}: ${neutralizeFraming(rendered.text) || "tool error"}`,
							details,
						});
					}
					const images = imageBlocks(result);
					// Server text cannot open or close a host frame (a reminder block or a middleware note), as bash and web_fetch output cannot.
					let output = neutralizeFraming(rendered.text);
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
					if (images.length > 0 && acceptsImageInput({ vision: invokeOptions?.supportsImages }))
						return await boundedImageResult(name, output, details, images, invokeOptions);
					return {
						kind: "ok",
						output,
						details,
						...(images.length > 0 ? { images } : {}),
					};
				} catch (error) {
					const stopped = callClient.state().status === "failed" || callClient.state().status === "closed";
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
					state.lastUsed = Date.now();
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
		if (pathArguments !== undefined || writesStore) {
			spec.hostEffectCalls = (args) => {
				const named = pathArguments === undefined ? [] : namedPathArguments(pathArguments, args, pathCwd);
				const references = pathArguments === undefined ? [] : namedStoreReferences(pathArguments, args);
				// A malformed argument is refused by the body before the server sees it.
				if (typeof named === "string" || typeof references === "string") return [];
				const write = writesStore ? builtinStoreWrite(tool.name, args, pathCwd) : null;
				return [...pathArgumentEffects(named), ...storeReferenceEffects(references, write, options.cwd, options.store)];
			};
		}
		if (trustClass === "execute" && declaration.url === undefined) {
			const launchCall: ClassifierCall = {
				tool: "bash",
				args: { command: [declaration.command, ...declaration.args].map(quoted).join(" ") },
				projection: "mcp-server",
			};
			// The builtin store server writes only the tags it was started with, so its write is admitted as the
			// store tool's own put or note into that tag. Projected to its launch command it was an opaque ask that
			// contained yolo's safety judge could not decide, and so refused every granted write.
			spec.safetyCall = (args): ClassifierCall => {
				const write = writesStore ? builtinStoreWrite(tool.name, args, pathCwd) : null;
				return write === null ? launchCall : builtinStoreWriteCall(write, options.cwd, options.store);
			};
		}
		return spec;
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
		state.listed = true;
		const { declaration } = state;
		if (declaration.scope !== "client") {
			const served = mcpSurface(listing.tools);
			state.surface = { served, status: judgeServedSurface(declaration, served) };
		}
		publishCatalog(state, listing);
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
	};

	const startConnection = (state: ServerState): OwnedConnection => {
		const controller = new AbortController();
		const { declaration } = state;
		const placement = launchPlacement(declaration);
		// Only the attestation grants network; a worker never reads it from the declaration it re-resolves.
		const sandboxNetwork =
			options.admitted?.tools.some((entry) => entry.serverId === declaration.id && entry.network === true) === true;
		// PERF W3: reserve ownership before the lazy import, so close can fence acquisition.
		const loaded = (async () => {
			const { createMcpConnection } = await import("../../domains/gateway/mcp/connection-lifecycle.js");
			// Launch-only options of a builtin server, outside its declaration and digest. A store that
			// cannot be resolved fails the launch with its reason; the acquire step below reports it.
			let launchArgs: string[] = [];
			let launchRefusal: string | null = null;
			if (declaration.scope === "builtin" && declaration.id === "store") {
				try {
					const launch = await storeServerLaunchContext({
						cwd: options.cwd,
						launchCwd: placement.cwd,
						access: options.store,
						backend: storeBackend(),
					});
					launchArgs = mcpBuiltinLaunchArgs(declaration.id, launch.context);
					state.launchWriteTags = launch.writeTags;
				} catch (error) {
					launchRefusal = `the builtin store server cannot start without this session's store: ${errorMessage(error)}`;
				}
			} else if (declaration.scope === "builtin") {
				launchArgs = mcpBuiltinLaunchArgs(declaration.id, {});
			}
			return createMcpConnection({
				signal: controller.signal,
				acquire: () => {
					// Rehash after the lazy import, immediately before acquisition.
					// The snapshot remains the authority; a fresh trust decision cannot
					// silently replace its digest, classes, or network grant.
					if (declaration.scope !== "client") {
						const current = resolveMcpServers(trustOptions).servers.find((entry) => entry.id === declaration.id);
						if (
							current === undefined ||
							current.scope !== declaration.scope ||
							current.path !== declaration.path ||
							current.digest !== declaration.digest ||
							current.trust.status !== "trusted" ||
							current.trust.actionClass !== declaration.trust.actionClass ||
							current.trust.network !== (declaration.trust.status === "trusted" ? declaration.trust.network : undefined)
						) {
							throw new Error(
								`MCP server '${declaration.id}' changed or is no longer trusted since this session admitted it; review its declaration and entry files, then start a new session`,
							);
						}
					}
					if (launchRefusal !== null) throw new Error(launchRefusal);
					const clientOptions: McpClientOptions = {
						workspaceRoot: placement.workspaceRoot,
						...(sandboxNetwork ? { sandboxNetwork: true } : {}),
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
						return clientFactory({ id: declaration.id, url: declaration.url, headers: resolved.headers }, clientOptions);
					}
					return clientFactory(
						{
							id: declaration.id,
							command: declaration.command,
							args: launchArgs.length > 0 ? [...declaration.args, ...launchArgs] : declaration.args,
							cwd: placement.cwd,
							// A builtin server gets the variables its manifest names from this process; no other scope gains any.
							env:
								declaration.builtin !== undefined
									? { ...mcpBuiltinLaunchEnvironment(declaration.builtin.environment), ...declaration.env }
									: declaration.env,
						},
						clientOptions,
					);
				},
				onAcquired: (client) => {
					state.client = client;
					installExitHook();
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
				installListing(state, listing);
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
				for (const name of state.registered) registry.unregister?.(name);
				state.registered = [];
				state.unregistrable = [];
				state.refused.clear();
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
			if (refreshLive || client.toolsChanged() || state.refreshing !== undefined) {
				state.refreshing ??= (async () => {
					// A notification received during tools/list stays dirty for the next
					// discovery; acknowledging after the response would lose it.
					client.acknowledgeToolsChanged();
					try {
						const listing = await client.listTools(signal);
						if (closed || signal?.aborted || state.client !== client || state.failure !== null) return;
						installListing(state, listing);
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
		if (state.client !== null) {
			return {
				...base,
				status: "connected",
				catalog: "live",
				catalogCount: state.registered.length,
				tools: [...state.registered],
				...(state.truncated ? { truncated: true } : {}),
				...(state.unregistrable.length > 0 ? { unregistrable: [...state.unregistrable] } : {}),
				...(state.dropped !== undefined && state.dropped.length > 0 ? { dropped: [...state.dropped] } : {}),
				...guided(state.client.serverInfo()?.instructions),
				...surfaced,
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
			...guided(catalog.instructions),
			...surfaced,
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
			entries.push({
				name,
				description: describeTool(declaration, tool),
				actionClass: actionClassFor(declaration, tool),
			});
		}
		return entries;
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
					declaration,
					client: null,
					connection: null,
					tools: [],
					truncated: false,
					registered: [],
					unregistrable: [],
					refused: new Map(),
					failure: null,
					catalog: null,
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
		async list(invokeOptions) {
			if (invokeOptions?.signal?.aborted) throw new McpError("aborted", "MCP discovery aborted");
			const all = [...resolveStates().values()];
			const results = await Promise.allSettled(all.map((state) => discover(state, invokeOptions?.signal)));
			for (const result of results) {
				if (result.status === "rejected") throw result.reason;
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
				changed: all.filter((state) => state.client?.toolsChanged() === true).map((state) => state.declaration.id),
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
			const tool = catalog.tools.find((entry) => entry.name === toolName);
			if (tool === undefined) {
				return {
					metadata: null,
					reason: `mcp server ${declaration.id} records no tool named ${toolName}${catalog.truncated ? `, and its catalog is incomplete: list it again with ${catalogRemedy(declaration.id)}` : ""}`,
				};
			}
			return {
				metadata: {
					name,
					serverId: declaration.id,
					description: describeTool(declaration, tool),
					parameters: tool.inputSchema,
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
			const refusal = readOnlyLaunchRefusal(
				owner.declaration,
				invokeOptions?.readOnly,
				name.slice(`mcp_${owner.declaration.id}__`.length),
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
						: `mcp server ${owner.declaration.id} offers no tool named ${name.slice(`mcp_${owner.declaration.id}__`.length)}`,
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
				return `Local stdio MCP server ${declaration.id}, supplied by the ACP client for this session. Calls use the unknown action class, ask at default autonomy, and run at yolo. The server closes with the session.`;
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
			const serverClass = declaration.trust.actionClass;
			const effect =
				actionClass === "execute" && isBuiltinStoreWriteTool(declaration.id, declaration.scope, toolName)
					? "calls are admitted as the store tool's own put or note into the named tag, which the session must be allowed to write"
					: actionClass === "read"
						? "calls run as reads at every autonomy level"
						: actionClass === "execute"
							? "calls are admitted like an unrecognized shell command"
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
			return `Local stdio MCP server ${declaration.id} (${declaration.scope} scope, declared in ${declaration.path}), trusted with action class ${serverClass}${
				actionClass === serverClass ? "" : `; this tool runs as ${actionClass}`
			}: ${effect}${confirmation}; ${launchConfinement()}.${unapproved}`;
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
