// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The ACP `initialize` handshake: client capability negotiation, client MCP
 * server declarations, and the features the agent advertises back.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { ACP_CONTEXT_STATUS_METHOD } from "../core/context-operation.js";
import { isRecord } from "../core/type-guards.js";
import { mcpDeclaredHeaderRefusal, mcpHeaderValueRefusal, mcpRemoteEndpoint } from "../domains/mcp/index.js";
import { OPERATOR_SHELL_TIMEOUT_MS } from "../domains/session/operator-shell.js";
import type { McpClientServerSpec } from "../tools/gateway/mcp-capability-types.js";
import {
	ACP_ARTIFACT_CATEGORIES,
	ACP_ARTIFACTS_LIST_METHOD,
	ACP_ARTIFACTS_META_KEY,
	ACP_ARTIFACTS_PER_CATEGORY,
	ACP_ARTIFACTS_READ_METHOD,
} from "./artifacts.js";
import {
	ACP_ASIDE_ASK_METHOD,
	ACP_ASIDE_CANCEL_METHOD,
	ACP_ASIDE_DRAFT_COUNTS,
	ACP_ASIDE_DRAFT_METHOD,
	ACP_ASIDE_META_KEY,
} from "./aside.js";
import { ACP_BOARD_META_KEY, ACP_BOARD_METHOD } from "./board.js";
import { ACP_BUDGET_CAPABILITY, ACP_BUDGET_META_KEY } from "./budget-notice.js";
import { ACP_CONTEXT_LEDGER_METHOD, ACP_CONTEXT_META_KEY } from "./context-ledger.js";
import { AcpRequestError } from "./errors.js";
import {
	ACP_EXTENSIONS_LIST_METHOD,
	ACP_EXTENSIONS_META_KEY,
	ACP_EXTENSIONS_RELOAD_METHOD,
	ACP_HUB_META_KEY,
	ACP_HUB_RELOAD_METHOD,
} from "./extensions.js";
import { ACP_FLEET_META_KEY, ACP_FLEET_PREVIEW_METHOD, ACP_FLEET_RUN_METHOD } from "./fleet-run.js";
import { ACP_WORKSPACE_META_KEY } from "./live-telemetry.js";
import { hasControlCharacters, utf8Bytes } from "./server-bounds.js";
import type {
	AcpClientSurface,
	AcpForwardableEventKind,
	AcpHandshake,
	AcpHandshakeFeatures,
} from "./server-options.js";
import { ACP_FORWARDABLE_EVENT_KINDS } from "./server-options.js";
import { ACP_PERMISSION_OPTION_IDS } from "./server-permissions.js";
import { ACP_QUEUE_EDIT_OPS, ACP_STEERING_MODES } from "./server-session-input.js";
import { ACP_SESSION_FORK_METHOD, ACP_SESSION_SWITCH_TURN_METHOD, ACP_SESSION_TREE_METHOD } from "./session-tree.js";
import {
	ACP_TELEMETRY_META_KEY,
	ACP_TELEMETRY_METHODS,
	ACP_TELEMETRY_UPDATE_NOTIFICATION,
} from "./telemetry-methods.js";
import { ACP_TRUST_CAPABILITY, ACP_TRUST_META_KEY } from "./trust-notice.js";
import type { AcpInitializeResponse } from "./types.js";
import {
	ACP_AGENT_META_KEY,
	ACP_BRANCHES_META_KEY,
	ACP_CEILING_FIELDS,
	ACP_CEILING_META_KEY,
	ACP_COMMANDS_INVOKE_METHOD,
	ACP_COMMANDS_META_KEY,
	ACP_DECISION_META_KEY,
	ACP_DECISION_SUPERSEDE_METHOD,
	ACP_DISPATCH_STEER_METHOD,
	ACP_ELICITATION_CANCEL_METHOD,
	ACP_ELICITATION_META_KEY,
	ACP_ELICITATION_REQUEST_METHOD,
	ACP_EVENT_NOTIFICATION,
	ACP_EVENTS_META_KEY,
	ACP_HANDOFF_CANCEL_METHOD,
	ACP_HANDOFF_COMMIT_METHOD,
	ACP_HANDOFF_META_KEY,
	ACP_HANDOFF_PREPARE_METHOD,
	ACP_INTERVIEW_CANCEL_METHOD,
	ACP_INTERVIEW_REQUEST_METHOD,
	ACP_INTERVIEWS_META_KEY,
	ACP_JOBS_LIST_METHOD,
	ACP_JOBS_META_KEY,
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_NEGOTIATED_TIMEOUT_MS,
	ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
	ACP_MEMORY_PROPOSE_METHOD,
	ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
	ACP_PERMISSION_WITHDRAW_METHOD,
	ACP_QUEUE_CHANGED_NOTIFICATION,
	ACP_QUEUE_EDIT_METHOD,
	ACP_QUEUE_META_KEY,
	ACP_SESSION_INTERRUPT_METHOD,
	ACP_SESSION_META_KEY,
	ACP_SESSION_QUEUE_CLEAR_METHOD,
	ACP_SESSION_QUEUE_METHOD,
	ACP_SESSION_SHELL_METHOD,
	ACP_SESSION_STEER_METHOD,
	ACP_SETTINGS_META_KEY,
	ACP_SHELL_META_KEY,
	ACP_SNAPSHOT_PREVIEW_METHOD,
	ACP_SNAPSHOT_RESTORE_METHOD,
	ACP_SNAPSHOTS_LIST_METHOD,
	ACP_SNAPSHOTS_META_KEY,
	ACP_STEERING_META_KEY,
	ACP_TARGETS_META_KEY,
	ACP_TOOL_PROGRESS_META_KEY,
	ACP_TOOLS_META_KEY,
	ACP_USAGE_META_KEY,
	ACP_WORKER_PERMISSIONS_META_KEY,
} from "./types.js";
import { checkAcpAgentCapabilitiesMeta } from "./types-capabilities.js";
import { ACP_READOUTS_CAPABILITY, ACP_READOUTS_META_KEY } from "./types-readouts.js";

/** A client may name at most this many kinds; an over-long list refuses the whole opt-in. */
const ACP_MAX_REQUESTED_EVENT_KINDS = 16;

/** An ACP client's Streamable HTTP server: https (http on localhost), with at most 16 header values. */
function parseClientHttpServer(raw: Record<string, unknown>): McpClientServerSpec {
	const endpoint = typeof raw.url === "string" && Buffer.byteLength(raw.url) <= 2048 ? mcpRemoteEndpoint(raw.url) : null;
	if (
		typeof raw.name !== "string" ||
		raw.name.trim().length === 0 ||
		Buffer.byteLength(raw.name) > 128 ||
		!(endpoint instanceof URL) ||
		!Array.isArray(raw.headers) ||
		raw.headers.length > 16
	) {
		throw new AcpRequestError(
			-32602,
			`invalid http MCP server declaration${typeof endpoint === "string" ? `: its url ${endpoint}` : ""}`,
			{ code: "invalid_params" },
		);
	}
	const headers: Record<string, string> = {};
	for (const entry of raw.headers) {
		if (
			!isRecord(entry) ||
			typeof entry.name !== "string" ||
			mcpDeclaredHeaderRefusal(entry.name) !== null ||
			Object.keys(headers).some((name) => name.toLowerCase() === (entry.name as string).toLowerCase()) ||
			typeof entry.value !== "string" ||
			mcpHeaderValueRefusal(entry.value) !== null
		) {
			throw new AcpRequestError(-32602, "invalid http MCP server header", { code: "invalid_params" });
		}
		headers[entry.name] = entry.value;
	}
	return { name: raw.name, url: endpoint.href, headers };
}

/** ACP stdio and http declarations are client authority for one session, never saved settings. */
export function parseClientMcpServers(value: unknown, required: boolean): McpClientServerSpec[] {
	if (value === undefined && !required) return [];
	if (value === undefined)
		throw new AcpRequestError(-32602, "mcpServers is required; send [] for none", { code: "invalid_params" });
	if (!Array.isArray(value) || value.length > 32) {
		throw new AcpRequestError(-32602, "mcpServers must be an array of at most 32 stdio or http servers", {
			code: "invalid_params",
		});
	}
	return value.map((raw: unknown) => {
		if (isRecord(raw) && raw.type === "http") return parseClientHttpServer(raw);
		if (isRecord(raw) && raw.type === "sse") {
			throw new AcpRequestError(-32602, "the 2024 HTTP+SSE MCP transport is not supported; use type http", {
				code: "invalid_params",
			});
		}
		if (
			!isRecord(raw) ||
			(raw.type !== undefined && raw.type !== "stdio") ||
			typeof raw.name !== "string" ||
			raw.name.trim().length === 0 ||
			Buffer.byteLength(raw.name) > 128 ||
			typeof raw.command !== "string" ||
			!isAbsolute(raw.command) ||
			Buffer.byteLength(raw.command) > 512 ||
			!Array.isArray(raw.args) ||
			raw.args.length > 64 ||
			!raw.args.every((arg: unknown) => typeof arg === "string" && Buffer.byteLength(arg) <= 4096) ||
			!Array.isArray(raw.env) ||
			raw.env.length > 64
		) {
			throw new AcpRequestError(-32602, "invalid stdio MCP server declaration", { code: "invalid_params" });
		}
		const env: Record<string, string> = {};
		for (const entry of raw.env) {
			if (
				!isRecord(entry) ||
				typeof entry.name !== "string" ||
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ||
				typeof entry.value !== "string" ||
				Buffer.byteLength(entry.value) > 4096
			) {
				throw new AcpRequestError(-32602, "invalid stdio MCP server environment", { code: "invalid_params" });
			}
			env[entry.name] = entry.value;
		}
		return { name: raw.name, command: raw.command, args: raw.args as string[], env };
	});
}

export function assertNoAdditionalDirectories(value: unknown): void {
	if (value === undefined || (Array.isArray(value) && value.length === 0)) return;
	throw new AcpRequestError(-32602, "additionalDirectories are not supported by this host", { code: "invalid_params" });
}

/**
 * An opt-in's optional `timeoutMs`: absent, or a whole number of milliseconds
 * the request timer can hold. Anything else refuses the whole opt-in, the rule
 * every attended opt-in follows for a request it cannot honour as written.
 */
function negotiableTimeout(value: unknown): boolean {
	return (
		value === undefined ||
		(typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= ACP_MAX_NEGOTIATED_TIMEOUT_MS)
	);
}

/** The front and the bound server use one handshake and one capability projection. */
export function createAcpHandshake(features: AcpHandshakeFeatures): AcpHandshake {
	let initialized = false;
	let toolProgressEnabled = false;
	let interviewsEnabled = false;
	let workerPermissionsEnabled = false;
	let interviewTimeoutMs: number | null = null;
	let elicitationEnabled = false;
	let elicitationTimeoutMs: number | null = null;
	let permissionRequestTimeoutMs: number | null = null;
	let queueEventsEnabled = false;
	let readoutsEnabled = false;
	let fullUsageEnabled = false;
	let clientSurface: AcpClientSurface = "acp";
	const enabledEventKinds = new Set<AcpForwardableEventKind>();
	const workspaceInstanceId = randomUUID();
	const requireInitialized = (): void => {
		if (!initialized) throw new AcpRequestError(-32600, "initialize must be called first", { code: "not_initialized" });
	};
	const assertHandshakeParams = (params: unknown, keys: ReadonlySet<string>): Record<string, unknown> => {
		if (params === undefined) return {};
		if (!isRecord(params) || Object.keys(params).some((key) => key !== "_meta" && !keys.has(key))) {
			throw new AcpRequestError(-32602, "invalid method parameters", { code: "invalid_params" });
		}
		return params;
	};
	return {
		get initialized() {
			return initialized;
		},
		get enabledEventKinds() {
			return enabledEventKinds;
		},
		get toolProgressEnabled() {
			return toolProgressEnabled;
		},
		get interviewsEnabled() {
			return interviewsEnabled;
		},
		get workerPermissionsEnabled() {
			return workerPermissionsEnabled;
		},
		get interviewTimeoutMs() {
			return interviewTimeoutMs;
		},
		get elicitationEnabled() {
			return elicitationEnabled;
		},
		get elicitationTimeoutMs() {
			return elicitationTimeoutMs;
		},
		get permissionRequestTimeoutMs() {
			return permissionRequestTimeoutMs;
		},
		get queueEventsEnabled() {
			return queueEventsEnabled;
		},
		get readoutsEnabled() {
			return readoutsEnabled;
		},
		get fullUsageEnabled() {
			return fullUsageEnabled;
		},
		workspaceInstanceId,
		get clientSurface() {
			return clientSurface;
		},
		initialize(params) {
			if (initialized) throw new AcpRequestError(-32600, "already initialized", { code: "already_initialized" });
			if (
				!isRecord(params) ||
				typeof params.protocolVersion !== "number" ||
				!Number.isSafeInteger(params.protocolVersion) ||
				params.protocolVersion < 0 ||
				// ACP's ProtocolVersion is a uint16.
				params.protocolVersion > 65_535
			) {
				throw new AcpRequestError(-32602, "protocolVersion must be an integer from 0 to 65535", {
					code: "invalid_params",
				});
			}
			clientSurface = isRecord(params.clientInfo) && params.clientInfo.name === "pancode-gui" ? "gui" : "acp";
			const clientCapabilities =
				isRecord(params) && isRecord(params.clientCapabilities) ? params.clientCapabilities : null;
			const clientMeta =
				clientCapabilities !== null && isRecord(clientCapabilities._meta) ? clientCapabilities._meta : null;
			const eventRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_EVENTS_META_KEY]) ? clientMeta[ACP_EVENTS_META_KEY] : null;
			const requestedEventKinds = eventRequest !== null ? eventRequest.kinds : null;
			// A malformed request refuses the whole opt-in rather than the offending
			// entry: a client that sent an unrepresentable kind does not know what it
			// asked for, and silently honouring the rest of its list hides that.
			enabledEventKinds.clear();
			if (
				eventRequest !== null &&
				eventRequest.version === 1 &&
				Array.isArray(requestedEventKinds) &&
				requestedEventKinds.length <= ACP_MAX_REQUESTED_EVENT_KINDS &&
				requestedEventKinds.every(
					(kind) => typeof kind === "string" && utf8Bytes(kind) <= 64 && !hasControlCharacters(kind),
				)
			) {
				for (const kind of ACP_FORWARDABLE_EVENT_KINDS) {
					if (requestedEventKinds.includes(kind)) enabledEventKinds.add(kind);
				}
			}
			// Repeated in-progress frames for one call are only useful to a client
			// that collapses them onto the row it already drew. One that appends
			// every frame it receives would grow a tool segment by a full output
			// snapshot several times a second, so nothing streams until it asks.
			const toolProgressRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_TOOL_PROGRESS_META_KEY])
					? clientMeta[ACP_TOOL_PROGRESS_META_KEY]
					: null;
			toolProgressEnabled = toolProgressRequest !== null && toolProgressRequest.version === 1;
			// One switch for "a person is here": the client names the request method it
			// will answer, so a client that advertises an older or different shape is
			// treated as unattended instead of being sent a call it cannot read.
			const interviewRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_INTERVIEWS_META_KEY]) ? clientMeta[ACP_INTERVIEWS_META_KEY] : null;
			interviewsEnabled =
				features.interviews === true &&
				interviewRequest !== null &&
				interviewRequest.version === 1 &&
				interviewRequest.request === ACP_INTERVIEW_REQUEST_METHOD &&
				negotiableTimeout(interviewRequest.timeoutMs);
			interviewTimeoutMs =
				interviewsEnabled && interviewRequest?.timeoutMs !== undefined
					? (features.pinnedTimeoutMs ?? (interviewRequest.timeoutMs as number))
					: null;
			const elicitationRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_ELICITATION_META_KEY]) ? clientMeta[ACP_ELICITATION_META_KEY] : null;
			elicitationEnabled =
				features.elicitation === true &&
				elicitationRequest !== null &&
				elicitationRequest.version === 1 &&
				elicitationRequest.request === ACP_ELICITATION_REQUEST_METHOD &&
				negotiableTimeout(elicitationRequest.timeoutMs);
			elicitationTimeoutMs =
				elicitationEnabled && elicitationRequest?.timeoutMs !== undefined
					? (features.pinnedTimeoutMs ?? (elicitationRequest.timeoutMs as number))
					: null;
			const workerPermissionsRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_WORKER_PERMISSIONS_META_KEY])
					? clientMeta[ACP_WORKER_PERMISSIONS_META_KEY]
					: null;
			workerPermissionsEnabled =
				features.workerPermissions === true &&
				workerPermissionsRequest !== null &&
				workerPermissionsRequest.version === 1 &&
				workerPermissionsRequest.withdraw === ACP_PERMISSION_WITHDRAW_METHOD &&
				negotiableTimeout(workerPermissionsRequest.timeoutMs);
			// A remote person often answers minutes later, so the client may widen
			// (or narrow) the window it is given; the operator's explicit flag still wins.
			permissionRequestTimeoutMs =
				workerPermissionsEnabled && workerPermissionsRequest?.timeoutMs !== undefined
					? (features.pinnedTimeoutMs ?? (workerPermissionsRequest.timeoutMs as number))
					: null;
			// A queue snapshot on every enqueue, hand-over and edit is only worth
			// sending to a client that replaces its list with it instead of polling.
			const queueRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_QUEUE_META_KEY]) ? clientMeta[ACP_QUEUE_META_KEY] : null;
			queueEventsEnabled = features.queueEdit === true && queueRequest !== null && queueRequest.version === 1;
			// Readouts and admission phases are pushed several times a second while a turn runs, so only on request.
			const readoutsRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_READOUTS_META_KEY]) ? clientMeta[ACP_READOUTS_META_KEY] : null;
			readoutsEnabled = readoutsRequest !== null && readoutsRequest.version === 1;
			// Every quantity's fact, coverage and ref runs to hundreds of lines a prompt, so only on request (F23).
			const usageRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_USAGE_META_KEY]) ? clientMeta[ACP_USAGE_META_KEY] : null;
			fullUsageEnabled = usageRequest !== null && usageRequest.version === 1;
			const canLoadSession = features.loadSession;
			initialized = true;
			return {
				protocolVersion: 1,
				agentInfo: {
					name: "pancode",
					title: "PanCode",
					// ACP v1 requires a version on Implementation; an embedder that names none reads as a dev build.
					version: features.version ?? "0.0.0-dev",
				},
				agentCapabilities: {
					loadSession: canLoadSession,
					promptCapabilities: { audio: false, embeddedContext: true, image: features.images === true },
					mcpCapabilities: { http: true, sse: false },
					sessionCapabilities: {
						close: {},
						...(features.session ? { list: {}, delete: {} } : {}),
						...(canLoadSession ? { resume: {} } : {}),
						// ACP v1.34.1 defines fork only in its unstable schema: `SessionCapabilities.fork` in
						// schema/v1/schema.unstable.json and `session_fork` in schema/v1/meta.unstable.json.
						...(features.branches ? { fork: {} } : {}),
					},
					// PanCode mediates every tool through its own safety policy. Extensions
					// are advertised through _meta while stable capabilities use schema fields.
					_meta: checkAcpAgentCapabilitiesMeta({
						[ACP_SESSION_META_KEY]: {
							close: true,
							label: features.session,
						},
						[ACP_SETTINGS_META_KEY]: {
							get_safe: features.settings,
							patch_safe: features.settings,
						},
						[ACP_TARGETS_META_KEY]: {
							list: features.providers,
							probe: features.providers,
						},
						[ACP_TRUST_META_KEY]: ACP_TRUST_CAPABILITY,
						[ACP_BUDGET_META_KEY]: ACP_BUDGET_CAPABILITY,
						...(features.ceiling === true
							? {
									[ACP_CEILING_META_KEY]: {
										version: 1 as const,
										meta: ACP_CEILING_META_KEY,
										fields: ACP_CEILING_FIELDS,
									},
								}
							: {}),
						...(features.commandsCapability !== undefined
							? {
									[ACP_COMMANDS_META_KEY]: {
										version: features.commandsCapability.version,
										list: features.commandsCapability.list,
										invoke: features.commandsCapability.invoke,
										...(features.commandsCapability.promptTurns !== undefined
											? { promptTurns: features.commandsCapability.promptTurns }
											: {}),
									},
								}
							: {}),
						// Steering is announced, never negotiated: every method here is
						// namespaced and additive, so a client that ignores this block
						// keeps the exact v1 surface it had. `main` and `dispatch` report
						// which queues this build actually wired, because an embedder may
						// pass a chat that cannot steer and a server with no fleet.
						[ACP_STEERING_META_KEY]: {
							version: 1,
							main: features.steer,
							dispatch: features.dispatch,
							modes: ACP_STEERING_MODES,
							interrupt: true,
							methods: {
								steer: ACP_SESSION_STEER_METHOD,
								queue: ACP_SESSION_QUEUE_METHOD,
								clear: ACP_SESSION_QUEUE_CLEAR_METHOD,
								interrupt: ACP_SESSION_INTERRUPT_METHOD,
								dispatch: ACP_DISPATCH_STEER_METHOD,
							},
						},
						// Per-frame agent attribution on `session/update`. Announced so a
						// client can tell "this agent produced nothing" apart from "this
						// peer does not report identity at all".
						[ACP_AGENT_META_KEY]: { version: 1, meta: ACP_AGENT_META_KEY },
						[ACP_READOUTS_META_KEY]: ACP_READOUTS_CAPABILITY,
						// The bounds are announced, not just applied: a client sizing a
						// progress buffer needs to know where the stream stops, and a
						// client that never receives a second frame has to be able to
						// tell "the tool printed once" from "the floor suppressed it".
						[ACP_TOOL_PROGRESS_META_KEY]: {
							version: 1,
							minIntervalMs: ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
							maxFramesPerCall: ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
							maxContentBytes: ACP_MAX_CHUNK_BYTES,
						},
						...(features.toolRegistry
							? {
									[ACP_DECISION_META_KEY]: {
										version: 1,
										meta: ACP_DECISION_META_KEY,
										options: ACP_PERMISSION_OPTION_IDS,
									},
								}
							: {}),
						...(features.bus
							? {
									[ACP_EVENTS_META_KEY]: {
										version: 1,
										notification: ACP_EVENT_NOTIFICATION,
										kinds: ACP_FORWARDABLE_EVENT_KINDS,
										workspaceInstanceId,
									},
								}
							: {}),
						...(features.toolRegistry ? { [ACP_TOOLS_META_KEY]: "mediated" } : {}),
						...(features.board
							? {
									[ACP_BOARD_META_KEY]: {
										version: 1,
										method: ACP_BOARD_METHOD,
										...(features.boardActions
											? { supersede: ACP_DECISION_SUPERSEDE_METHOD, proposeMemory: ACP_MEMORY_PROPOSE_METHOD }
											: {}),
									},
								}
							: {}),
						...(features.session
							? {
									[ACP_SNAPSHOTS_META_KEY]: {
										version: 1,
										list: ACP_SNAPSHOTS_LIST_METHOD,
										preview: ACP_SNAPSHOT_PREVIEW_METHOD,
										restore: ACP_SNAPSHOT_RESTORE_METHOD,
									},
								}
							: {}),
						...(features.branches
							? {
									[ACP_BRANCHES_META_KEY]: {
										version: 1,
										tree: ACP_SESSION_TREE_METHOD,
										switchTurn: ACP_SESSION_SWITCH_TURN_METHOD,
										fork: ACP_SESSION_FORK_METHOD,
									},
								}
							: {}),
						...(features.extensions
							? {
									[ACP_EXTENSIONS_META_KEY]: {
										version: 1,
										list: ACP_EXTENSIONS_LIST_METHOD,
										reload: ACP_EXTENSIONS_RELOAD_METHOD,
									},
								}
							: {}),
						...(features.hubReload ? { [ACP_HUB_META_KEY]: { version: 1, reload: ACP_HUB_RELOAD_METHOD } } : {}),
						...(features.telemetry
							? {
									[ACP_TELEMETRY_META_KEY]: {
										version: 1,
										methods: { ...ACP_TELEMETRY_METHODS },
										update: ACP_TELEMETRY_UPDATE_NOTIFICATION,
									},
								}
							: {}),
						...(features.workspace ? { [ACP_WORKSPACE_META_KEY]: { version: 1, update: "session_info_update" } } : {}),
						...(features.aside
							? {
									[ACP_ASIDE_META_KEY]: {
										version: 1,
										ask: ACP_ASIDE_ASK_METHOD,
										draft: ACP_ASIDE_DRAFT_METHOD,
										cancel: ACP_ASIDE_CANCEL_METHOD,
										draftCounts: { ...ACP_ASIDE_DRAFT_COUNTS },
									},
								}
							: {}),
						// Echoed only when the client opted in, so the client's own gate
						// ("the runtime announced it") and the host's agree on one answer.
						...(interviewsEnabled
							? {
									[ACP_INTERVIEWS_META_KEY]: {
										version: 1,
										request: ACP_INTERVIEW_REQUEST_METHOD,
										cancel: ACP_INTERVIEW_CANCEL_METHOD,
										...(interviewTimeoutMs !== null ? { timeoutMs: interviewTimeoutMs } : {}),
									},
								}
							: {}),
						...(elicitationEnabled
							? {
									[ACP_ELICITATION_META_KEY]: {
										version: 1,
										request: ACP_ELICITATION_REQUEST_METHOD,
										cancel: ACP_ELICITATION_CANCEL_METHOD,
										...(elicitationTimeoutMs !== null ? { timeoutMs: elicitationTimeoutMs } : {}),
									},
								}
							: {}),
						...(workerPermissionsEnabled
							? {
									[ACP_WORKER_PERMISSIONS_META_KEY]: {
										version: 1,
										withdraw: ACP_PERMISSION_WITHDRAW_METHOD,
										...(permissionRequestTimeoutMs !== null ? { timeoutMs: permissionRequestTimeoutMs } : {}),
									},
								}
							: {}),
						...(features.contextLedger
							? {
									[ACP_CONTEXT_META_KEY]: {
										version: 1,
										ledger: ACP_CONTEXT_LEDGER_METHOD,
										status: ACP_CONTEXT_STATUS_METHOD,
										...(features.bus ? { activity: "context.activity_changed" } : {}),
										...(features.commandsCapability ? { invoke: ACP_COMMANDS_INVOKE_METHOD } : {}),
									},
								}
							: {}),
						...(features.jobs
							? { [ACP_JOBS_META_KEY]: { version: 1, list: ACP_JOBS_LIST_METHOD, event: "job.changed" } }
							: {}),
						...(features.artifacts
							? {
									[ACP_ARTIFACTS_META_KEY]: {
										version: 1,
										list: ACP_ARTIFACTS_LIST_METHOD,
										read: ACP_ARTIFACTS_READ_METHOD,
										categories: ACP_ARTIFACT_CATEGORIES,
										perCategory: ACP_ARTIFACTS_PER_CATEGORY,
									},
								}
							: {}),
						...(features.fleet
							? {
									[ACP_FLEET_META_KEY]: {
										version: 1,
										preview: ACP_FLEET_PREVIEW_METHOD,
										run: ACP_FLEET_RUN_METHOD,
										// Terminal dispatch frames carry `_meta[ACP_RUN_RESULT_META_KEY]` (#ACP-02).
										runResultFacts: true,
										resume: true,
									},
								}
							: {}),
						...(features.handoff
							? {
									[ACP_HANDOFF_META_KEY]: {
										version: 1,
										prepare: ACP_HANDOFF_PREPARE_METHOD,
										commit: ACP_HANDOFF_COMMIT_METHOD,
										cancel: ACP_HANDOFF_CANCEL_METHOD,
									},
								}
							: {}),
						...(features.shell
							? {
									[ACP_SHELL_META_KEY]: {
										version: 1,
										run: ACP_SESSION_SHELL_METHOD,
										timeoutMs: OPERATOR_SHELL_TIMEOUT_MS,
									},
								}
							: {}),
						// The `queue` read gains `entries` alongside its two text lists. The
						// change notification carries the same list and is sent only to a
						// client that advertised this key, like the tool-progress stream.
						...(features.queueEdit
							? {
									[ACP_QUEUE_META_KEY]: {
										version: 1,
										edit: ACP_QUEUE_EDIT_METHOD,
										ops: ACP_QUEUE_EDIT_OPS,
										notification: ACP_QUEUE_CHANGED_NOTIFICATION,
									},
								}
							: {}),
					}),
				},
				// Older clients and the ACP registry's validator announce terminal auth as
				// `_meta["terminal-auth"]` rather than `auth.terminal` (#418).
				authMethods:
					(isRecord(clientCapabilities?.auth) && clientCapabilities.auth.terminal === true) ||
					clientMeta?.["terminal-auth"] === true
						? [
								{
									id: "pancode-login",
									name: "PanCode Connection Auth & Setup",
									description: "Configure models, API keys, and connection endpoints in terminal",
									type: "terminal",
									args: ["auth", "login"],
								},
							]
						: [],
			} satisfies AcpInitializeResponse;
		},
		authenticate(params) {
			requireInitialized();
			const request = assertHandshakeParams(params, new Set(["methodId"]));
			if (typeof request.methodId !== "string" || request.methodId.length === 0) {
				throw new AcpRequestError(-32602, "unknown authentication method", { code: "invalid_params" });
			}
			// Terminal authentication runs in a separate process.
			throw new AcpRequestError(-32602, "unknown authentication method", { code: "invalid_params" });
		},
	};
}
