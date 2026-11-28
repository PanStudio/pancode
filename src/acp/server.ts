// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { BashCommandProgress } from "../core/bash-exec.js";
import { combineLiveBashOutput } from "../core/bash-exec.js";
import type { ContextOperationStatus } from "../core/context-operation.js";
import {
	ACP_CONTEXT_STATUS_METHOD,
	CONTEXT_OPERATION_CUSTOM_TYPE,
	readContextOperation,
} from "../core/context-operation.js";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../core/defaults.js";
import { MAX_TIMER_DELAY_MS } from "../core/timers.js";
import { ToolNames } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { narrowTurnConstraints, snapshotTurnConstraints, turnAllowsTool } from "../core/turn-constraints.js";
import { isRecord } from "../core/type-guards.js";
import { missingRuntimeComponent } from "../domains/install/components.js";
import { jobIsComplete } from "../domains/scheduling/index.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { liveSessionOwner } from "../domains/session/live-owner.js";
import { runOperatorShellLine } from "../domains/session/operator-shell.js";
import { resumedSessionRoute } from "../domains/session/resumed-route.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { AgentMessage } from "../engine/types.js";
import { DEFAULT_AUTONOMY_LEVEL } from "../lib/autonomy/autonomy.js";
import {
	redactFinalUrlCredentials,
	redactStreamingUrlCredentials,
	redactUrlCredentials,
} from "../lib/secrets/redaction.js";
import { RATE_MIN_WINDOW_MS } from "../session-control/assistant-generation-timing.js";
import { replayCurrentSession, restoreSession as restoreControlledSession } from "../session-control/index.js";
import type {
	MachineTurnProjectionAdmission,
	MachineTurnProjectionRequest,
} from "../session-control/job-turn-types.js";
import { tokenizeLoopLine } from "../session-control/loop-command.js";
import type { McpClientServerSpec } from "../tools/gateway/mcp-capability-types.js";
import {
	ACP_ARTIFACTS_LIST_METHOD,
	ACP_ARTIFACTS_READ_METHOD,
	listAcpArtifacts,
	parseArtifactCategories,
	parseArtifactReadRequest,
	readAcpArtifact,
} from "./artifacts.js";
import {
	ACP_ASIDE_ASK_METHOD,
	ACP_ASIDE_CANCEL_METHOD,
	ACP_ASIDE_DRAFT_COUNTS,
	ACP_ASIDE_DRAFT_METHOD,
	ACP_ASIDE_QUESTION_MAX_CHARS,
	projectAsideAnswer,
	projectDraftOutcome,
} from "./aside.js";
import { ACP_BOARD_METHOD, projectSessionBoard } from "./board.js";
import { ACP_CONTEXT_LEDGER_METHOD, projectContextLedger } from "./context-ledger.js";
import { ACP_TURN_FAILED_MESSAGE, AcpRequestError, acpErrorMessage } from "./errors.js";
import type { AcpFleetControl } from "./fleet-run.js";
import {
	ACP_FLEET_MAX_REASON_BYTES,
	ACP_FLEET_PREVIEW_METHOD,
	ACP_FLEET_RUN_METHOD,
	projectFleetPreview,
} from "./fleet-run.js";
import type { AcpLiveTelemetry } from "./live-telemetry.js";
import { compactUsage, createAcpLiveTelemetry, sessionUsageTotals, turnUsageMeta } from "./live-telemetry.js";
import { ACP_MAX_JOBS } from "./runtime.js";
import {
	boundedText,
	boundString,
	requireBoundedClientString,
	safeConfiguredIdentifier,
	safeIso,
	safeStoredIdentifier,
	safeStoredString,
	utf8Bytes,
} from "./server-bounds.js";
import { createAcpServerCommands } from "./server-commands.js";
import { createAcpServerConfig } from "./server-config.js";
import { createAcpServerControl } from "./server-control.js";
import {
	ACP_MAX_DISPATCH_ID_BYTES,
	jobEventPayload,
	replayDispatchTerminals,
	safeCount,
} from "./server-event-frames.js";
import { createAcpServerEvents } from "./server-events.js";
import { compileFleet, fleetName, fleetResume, fleetVars, requireFleet } from "./server-fleet.js";
import { ACP_MAX_SESSION_ID_BYTES, assertParamKeys, createAcpServerGuards, sessionIdOf } from "./server-guards.js";
import { assertNoAdditionalDirectories, createAcpHandshake, parseClientMcpServers } from "./server-handshake.js";
import { ACP_MAX_SESSION_LIST_RESULT_BYTES, modelsResultMeta, sessionConfig } from "./server-models.js";
import type {
	AcpBoardActions,
	AcpHandoffControl,
	AcpHandshake,
	AcpPromptExpansion,
	AcpRoutingSnapshot,
	AcpServerEvent,
	PancodeAcpServerOptions,
} from "./server-options.js";
import { branchesWired, handoffWired, queueEditWired, shellWired } from "./server-options.js";
import { installPermissionBridge } from "./server-permissions.js";
import {
	attachedNote,
	ceilingMeta,
	promptImages,
	promptResources,
	promptText,
	requestCeiling,
	validatePromptBlocks,
	withResources,
} from "./server-prompt-input.js";
import { createAcpServerReadouts } from "./server-readouts.js";
import type { PreparedAcpReplay } from "./server-replay.js";
import { prepareAcpReplay, sessionResultMeta, withReplayUsage } from "./server-replay.js";
import type { AcpServerScope } from "./server-scope.js";
import { requireShellCommand, shellOutputTail } from "./server-session-input.js";
import {
	clipSnapshotText,
	snapshotFailure,
	snapshotKept,
	snapshotN,
	snapshotPaths,
	snapshotRefs,
	snapshotStore,
} from "./server-snapshots.js";
import type { AcpServerSession, ActivePrompt } from "./server-tool-updates.js";
import {
	ACP_MAX_TOOL_TITLE_BYTES,
	createActivePromptState,
	flushChunkCredentials,
	handleChatEvent,
	loadFailure,
	newestOpenToolCallId,
	ORCHESTRATOR_UPDATE_META,
	observeTelemetry,
	openWireIdFor,
	reportConsentAsk,
	sendTextChunks,
	sendUpdate,
	settleOpenToolCalls,
	textContent,
	toolCallContent,
} from "./server-tool-updates.js";
import {
	ACP_SESSION_FORK_METHOD,
	ACP_SESSION_SWITCH_TURN_METHOD,
	ACP_SESSION_TREE_METHOD,
	isSelectableTreeNode,
	projectSessionTree,
} from "./session-tree.js";
import {
	ACP_TELEMETRY_UPDATE_NOTIFICATION,
	subscribeTelemetryUpdates,
	telemetryRequestHandlers,
} from "./telemetry-methods.js";
import { trustResultMeta } from "./trust-notice.js";
import type { AcpEmptyResult, AcpPromptResponse, AcpToolCallStatus, AcpToolKind } from "./types.js";
import {
	ACP_CEILING_META_KEY,
	ACP_COMMANDS_INVOKE_METHOD,
	ACP_COMMANDS_LIST_METHOD,
	ACP_DECISION_SUPERSEDE_METHOD,
	ACP_HANDOFF_CANCEL_METHOD,
	ACP_HANDOFF_COMMIT_METHOD,
	ACP_HANDOFF_PREPARE_METHOD,
	ACP_JOBS_LIST_METHOD,
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
	ACP_MEMORY_PROPOSE_METHOD,
	ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
	ACP_NOTICE_META_KEY,
	ACP_PERMISSION_WITHDRAW_METHOD,
	ACP_SESSION_LABEL_METHOD,
	ACP_SESSION_LIST_METHOD,
	ACP_SESSION_META_KEY,
	ACP_SESSION_SHELL_METHOD,
	ACP_SHELL_META_KEY,
	ACP_SNAPSHOT_PREVIEW_METHOD,
	ACP_SNAPSHOT_RESTORE_METHOD,
	ACP_SNAPSHOTS_LIST_METHOD,
	ACP_TURN_META_KEY,
	ACP_USAGE_META_KEY,
} from "./types.js";
import type { AcpJob } from "./types-fleet.js";
import type {
	AcpDecisionSupersedeResult,
	AcpHandoffCancelResult,
	AcpHandoffCommitResult,
	AcpHandoffPrepareResult,
	AcpMemoryProposeResult,
	AcpSessionList,
	AcpSessionListRow,
	AcpShellResult,
	AcpSnapshotList,
	AcpSnapshotOutcome,
	AcpSnapshotPlan,
} from "./types-session.js";
import { ACP_SNAPSHOT_LIST_MAX } from "./types-session.js";

const ACP_MAX_LABEL_BYTES = 256;
const ACP_MAX_CORRECTION_BYTES = 2048;
const ACP_MAX_HANDOFF_GOAL_BYTES = 2048;
/** A rendered handoff is bounded list by list; this is the ceiling on a reviewed edit of it. */
const ACP_MAX_HANDOFF_DOCUMENT_BYTES = 128 * 1024;
const ACP_MAX_HANDOFF_REASON_BYTES = 2048;

/** How long teardown waits for accepted work to finish after cancellation. */
const ACP_PROMPT_SETTLE_BOUND_MS = 5000;

async function settleAcpWork(pending: readonly Promise<unknown>[]): Promise<void> {
	if (pending.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(pending),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ACP_PROMPT_SETTLE_BOUND_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function attachClientMcpServers(
	options: PancodeAcpServerOptions,
	servers: ReadonlyArray<McpClientServerSpec>,
	ceiling: TurnConstraints | undefined,
): Promise<void> {
	if (servers.length === 0) return;
	if (!options.mcpCapabilities) {
		throw new AcpRequestError(-32602, "client MCP servers are unavailable in this host", { code: "invalid_params" });
	}
	try {
		// A read-only or no-tools session starts no client server: what one does is unknown until it runs.
		const operator = options.operatorToolLimits;
		const start = !(
			operator?.readOnly === true ||
			ceiling?.readOnly === true ||
			operator?.allowedTools?.length === 0 ||
			ceiling?.allowedTools?.length === 0
		);
		await options.mcpCapabilities.attachClientServers(servers, { start });
	} catch (error) {
		await options.mcpCapabilities.detachClientServers();
		options.diagnostics?.(`client MCP launch failed: ${acpErrorMessage(error)}`);
		throw new AcpRequestError(-32603, "client MCP servers could not start", { code: "internal_error" });
	}
}

function routingSnapshot(options: PancodeAcpServerOptions): AcpRoutingSnapshot {
	const route = options.routing?.() ?? { target: null, model: null };
	return {
		target: safeConfiguredIdentifier(route.target, ACP_MAX_TARGET_ID_BYTES),
		model: safeConfiguredIdentifier(route.model, ACP_MAX_MODEL_ID_BYTES),
	};
}

function assertCeilingEnforceable(options: PancodeAcpServerOptions, ceiling: TurnConstraints | undefined): void {
	if (ceiling !== undefined && options.chat.setToolCeiling === undefined) {
		throw new AcpRequestError(-32602, `this agent cannot enforce ${ACP_CEILING_META_KEY}`, {
			code: "ceiling_unsupported",
		});
	}
}

/**
 * A successor's ceiling: the source session's narrowed by the one sent with
 * the request, so a fork or handoff can tighten what it inherits and never
 * loosen it (Z1).
 */
function successorCeiling(
	options: PancodeAcpServerOptions,
	source: AcpServerSession,
	params: unknown,
): TurnConstraints | undefined {
	const requested = requestCeiling(params);
	assertCeilingEnforceable(options, requested);
	return snapshotTurnConstraints(narrowTurnConstraints(source.ceiling, requested));
}

interface PreparedRestore {
	leafTurnId: string | null;
	replayMessages: ReadonlyArray<AgentMessage>;
	replay: PreparedAcpReplay | undefined;
}

function requireBranches(options: PancodeAcpServerOptions) {
	const session = options.session;
	const resetForSession = options.chat.resetForSession;
	const readEntries = options.readSessionEntries;
	const buildMessages = options.buildReplayMessages;
	if (
		!branchesWired(options) ||
		session === undefined ||
		resetForSession === undefined ||
		readEntries === undefined ||
		buildMessages === undefined
	) {
		throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	}
	return { session, resetForSession: resetForSession.bind(options.chat), readEntries, buildMessages };
}

/**
 * A path that stops hosting a live, loaded session checkpoints it first, so meta.json records why its ledger
 * closed, as shutdown records its own. A failed checkpoint is reported and the close goes on.
 */
async function checkpointBeforeClose(
	options: PancodeAcpServerOptions,
	sessionId: string,
	reason: "close" | "fork" | "handoff",
): Promise<void> {
	const durable = options.session;
	if (durable?.current()?.id !== sessionId) return;
	await durable.checkpoint(reason).catch((err: unknown) => {
		process.stderr.write(
			`[pancode:acp] ${reason} checkpoint failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	});
}

function selectableTurn(contract: SessionContract, sessionId: string, value: unknown): string {
	const turnId = requireBoundedClientString(value, "turnId", ACP_MAX_SESSION_ID_BYTES);
	let kind: string | undefined;
	try {
		kind = contract.tree(sessionId).nodesById[turnId]?.kind;
	} catch {
		throw new AcpRequestError(-32603, "session tree could not be read", { code: "internal_error" });
	}
	if (kind === undefined || !isSelectableTreeNode(kind)) {
		throw new AcpRequestError(-32602, "turn is not in this session", { code: "turn_unknown" });
	}
	return turnId;
}

function handoffRefusal(level: "warn" | "error", code: string, reason: string) {
	return {
		status: "refused" as const,
		level,
		code,
		reason: boundString(reason, ACP_MAX_HANDOFF_REASON_BYTES),
	};
}

function requireHandoff(options: PancodeAcpServerOptions) {
	const control = options.handoff;
	const branches = requireBranches(options);
	if (control === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	return { control, ...branches };
}

/** Reviewed text keeps its line structure; any other control character is refused. */
function handoffDocument(value: unknown): string {
	if (typeof value !== "string" || utf8Bytes(value) > ACP_MAX_HANDOFF_DOCUMENT_BYTES) {
		throw new AcpRequestError(-32602, "document is invalid", { code: "invalid_params" });
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character other than a line break is the refusal.
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
		throw new AcpRequestError(-32602, "document is invalid", { code: "invalid_params" });
	}
	return value;
}

function requireAside(options: PancodeAcpServerOptions) {
	if (options.aside === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	return options.aside;
}

function asideText(value: unknown, field: string) {
	const text = typeof value === "string" ? value.trim() : "";
	if (text.length === 0 || text.length > ACP_ASIDE_QUESTION_MAX_CHARS)
		throw new AcpRequestError(-32602, `${field} must be 1 to ${ACP_ASIDE_QUESTION_MAX_CHARS} characters`, {
			code: "invalid_params",
		});
	return text;
}

function artifactFailure(options: PancodeAcpServerOptions, what: string, error: unknown): never {
	if (error instanceof AcpRequestError) throw error;
	options.diagnostics?.(`artifact ${what} failed: ${acpErrorMessage(error)}`);
	throw new AcpRequestError(-32603, `artifacts could not be ${what === "list" ? "listed" : "read"}`, {
		code: "internal_error",
	});
}

function requireBoardActions(options: PancodeAcpServerOptions): AcpBoardActions {
	if (options.boardActions === undefined || options.board === undefined) {
		throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	}
	return options.boardActions;
}

function acpHandshakeFor(options: PancodeAcpServerOptions): AcpHandshake {
	return (
		options.handshake ??
		createAcpHandshake({
			...(options.version === undefined ? {} : { version: options.version }),
			session: options.session !== undefined,
			loadSession:
				options.session !== undefined &&
				options.readSessionEntries !== undefined &&
				options.buildReplayMessages !== undefined &&
				options.chat.resetForSession !== undefined,
			settings: options.settings !== undefined,
			providers: options.providers !== undefined,
			...(options.commands === undefined
				? {}
				: {
						commandsCapability: {
							version: 1,
							list: ACP_COMMANDS_LIST_METHOD,
							invoke: ACP_COMMANDS_INVOKE_METHOD,
							...(options.chat.whenSettled ? { promptTurns: true } : {}),
						},
					}),
			ceiling: options.chat.setToolCeiling !== undefined,
			steer: options.chat.steer !== undefined,
			dispatch: options.dispatch !== undefined,
			toolRegistry: options.toolRegistry !== undefined,
			bus: options.bus !== undefined,
			board: options.board !== undefined,
			boardActions: options.board !== undefined && options.boardActions !== undefined,
			branches: branchesWired(options),
			handoff: handoffWired(options),
			fleet: options.fleet !== undefined,
			contextLedger: options.contextLedger !== undefined,
			artifacts: options.artifacts !== undefined,
			jobs: options.commands?.jobs !== undefined,
			extensions: options.extensions !== undefined,
			hubReload: options.hubReload !== undefined,
			aside: options.aside !== undefined,
			telemetry: options.telemetryReadModel !== undefined,
			workspace: options.workspace !== undefined,
			images: options.expandPrompt !== undefined,
			interviews: options.interviews !== undefined,
			elicitation: options.elicitation !== undefined,
			workerPermissions: options.workerPermissions !== undefined,
			shell: shellWired(options),
			queueEdit: queueEditWired(options),
		})
	);
}

export async function servePancodeAcpAgent(options: PancodeAcpServerOptions): Promise<number> {
	const handshake = acpHandshakeFor(options);
	const workspaceInstanceId = handshake.workspaceInstanceId;
	const now = options.now ?? Date.now;
	// The launch cwd is the process's one workspace identity: settings, project
	// context, and the session ledger were all resolved against it during boot.
	// It is canonicalized once here so a client that passes a symlinked path, a
	// trailing slash, or a `/.` suffix is recognised rather than refused.
	const canonicalCwd = realpathSync(options.cwd ?? process.cwd());
	const permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS;
	const scope: AcpServerScope = {
		options,
		handshake,
		canonicalCwd,
		workspaceInstanceId,
		now,
		get telemetry() {
			return telemetry;
		},
		get permission() {
			return permission;
		},
		sessions: new Map<string, AcpServerSession>(),
		closedSessionIds: new Set<string>(),
		replacedSessions: new Map<string, string>(),
		closingSessions: new Map<string, Promise<Record<string, never>>>(),
		listingFallbacks: new Map<string, string>(),
		activeSessionId: null,
		boundSessionId: null,
		activePromptState: null,
		machineLease: null,
		sessionCreated: false,
		pendingHandoff: null,
		handoffPreparing: false,
		promptSerial: 0,
		startupHintsSessionId: null,
		promptSettled: null,
		activeShell: null,
		contextActivity: null,
		contextCommandInFlight: null,
		standingLimits: undefined,
		asideRound: null,
		get guards() {
			return guards;
		},
		get commands() {
			return commands;
		},
		get control() {
			return control;
		},
		get events() {
			return events;
		},
		get readoutFeed() {
			return readoutFeed;
		},
		get config() {
			return config;
		},
	};
	const guards = createAcpServerGuards(scope);
	const telemetry: AcpLiveTelemetry = createAcpLiveTelemetry({
		notify: (sessionId, update) => options.transport.notify("session/update", { sessionId, update }),
		sessionId: () => scope.boundSessionId,
		cwd: scope.canonicalCwd,
		...(options.contextLedger !== undefined ? { contextLedger: options.contextLedger } : {}),
		...(options.telemetryReadModel
			? {
					sessionTelemetry: () => guards.liveSessionView(),
					subscribeUsage: (listener: () => void) => options.telemetryReadModel?.subscribe("session", listener) ?? (() => {}),
				}
			: {}),
		...(options.plan !== undefined ? { plan: options.plan } : {}),
		...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
		fullUsage: () => scope.handshake.fullUsageEnabled,
	});
	if (
		!Number.isSafeInteger(permissionTimeoutMs) ||
		permissionTimeoutMs < 1 ||
		permissionTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new Error(`ACP permission timeout must be between 1 and ${MAX_TIMER_DELAY_MS} milliseconds`);
	}
	// A client's negotiated window replaces the configured default. The handshake
	// already answers the operator's explicit --permission-timeout for one, so
	// the flag still wins.
	const permissionWindowMs = (): number => scope.handshake.permissionRequestTimeoutMs ?? permissionTimeoutMs;
	const interviewWindowMs = (): number => scope.handshake.interviewTimeoutMs ?? permissionTimeoutMs;
	const permission = installPermissionBridge({
		transport: options.transport,
		toolRegistry: options.toolRegistry,
		...(options.bus ? { bus: options.bus } : {}),
		activeSessionId: () => scope.activeSessionId,
		resolveToolCallId: (engineToolCallId) =>
			scope.activePromptState === null ? null : openWireIdFor(scope.activePromptState, engineToolCallId),
		soleOpenToolCallId: () => {
			if (scope.activePromptState === null || scope.activePromptState.openToolCalls.size !== 1) return null;
			const [only] = scope.activePromptState.openToolCalls;
			return only ?? null;
		},
		toolCallSnapshot: (wireId) =>
			scope.activePromptState === null ? null : (scope.activePromptState.toolCallSnapshots.get(wireId) ?? null),
		permissionTimeoutMs: permissionWindowMs,
		clientSurface: () => scope.handshake.clientSurface,
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
		...(options.session !== undefined ? { session: options.session } : {}),
		workerAskNotice: (sessionId, text) => {
			const active = scope.activePromptState;
			// Outside a turn there is no message to attach it to; the run's own outcome still says it.
			if (active === null || scope.activeSessionId !== sessionId) {
				options.diagnostics?.(text.trim());
				return;
			}
			sendUpdate(
				options.transport,
				sessionId,
				active,
				{ sessionUpdate: "agent_message_chunk", content: textContent(text) },
				{ ...ORCHESTRATOR_UPDATE_META, [ACP_NOTICE_META_KEY]: { level: "warning" } },
			);
		},
		...(options.workerPermissions !== undefined
			? {
					workerAsks: {
						enabled: () => scope.handshake.initialized && scope.handshake.workerPermissionsEnabled,
						resolve: options.workerPermissions.resolve,
						bindToolCall: (runId: string) => {
							const active = scope.activePromptState;
							if (active === null) return null;
							let attributed: string | null = null;
							for (const wireId of active.openToolCalls) {
								if (active.toolCallSnapshots.get(wireId)?.agents?.some((agent) => agent.runId === runId)) {
									attributed = wireId;
								}
							}
							return attributed ?? newestOpenToolCallId(active);
						},
						withdraw: (sessionId: string, requestId: string) =>
							options.transport.notify(ACP_PERMISSION_WITHDRAW_METHOD, { sessionId, requestId }),
					},
				}
			: {}),
		expireActivePrompt: () => {
			if (scope.activePromptState === null) return;
			scope.activePromptState.permissionExpired = true;
			options.chat.cancel();
		},
		cancelActivePrompt: (reason) => {
			const session = scope.activeSessionId === null ? undefined : scope.sessions.get(scope.activeSessionId);
			if (session) control.cancelSession(session, reason);
		},
	});
	const events = createAcpServerEvents(scope);
	const readoutFeed = createAcpServerReadouts(scope);
	const config = createAcpServerConfig(scope);
	const commands = createAcpServerCommands(scope);

	options.transport.onRequest("initialize", (params) => scope.handshake.initialize(params));
	options.transport.onRequest("authenticate", (params) => scope.handshake.authenticate(params));

	options.transport.onRequest("session/new", async (params) => {
		guards.requireInitialized();
		return guards.withSessionSlot(async () => {
			const request = assertParamKeys(params, new Set(["cwd", "mcpServers", "additionalDirectories"]));
			const ceiling = requestCeiling(request);
			assertCeilingEnforceable(options, ceiling);
			assertNoAdditionalDirectories(request.additionalDirectories);
			const sessionCwd = guards.canonicalSessionCwd(request.cwd);
			const clientMcpServers = parseClientMcpServers(request.mcpServers, true);
			const route = routingSnapshot(options);
			const createInput: { cwd: string; target?: string; model?: string } = { cwd: sessionCwd };
			if (route.target !== null) createInput.target = route.target;
			if (route.model !== null) createInput.model = route.model;
			await attachClientMcpServers(options, clientMcpServers, ceiling);
			let meta: SessionMeta | undefined;
			try {
				meta = options.session?.create(createInput);
			} catch (error) {
				await options.mcpCapabilities?.detachClientServers();
				throw error;
			}
			const id = meta?.id ?? randomUUID();
			if (safeStoredIdentifier(id, ACP_MAX_SESSION_ID_BYTES) === null) {
				await options.mcpCapabilities?.detachClientServers();
				throw new AcpRequestError(-32603, "session creation failed", { code: "internal_error" });
			}
			options.chat.resetForSession?.(null);
			const autonomy = options.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
			const boundTarget = safeConfiguredIdentifier(meta?.target ?? route.target, ACP_MAX_TARGET_ID_BYTES);
			const boundModel = safeConfiguredIdentifier(meta?.model ?? route.model, ACP_MAX_MODEL_ID_BYTES);
			const session: AcpServerSession = {
				id,
				cwd: sessionCwd,
				autonomy,
				autonomySource: "settings",
				target: boundTarget,
				model: boundModel,
				thinkingLevel: options.settings?.read().thinkingLevel ?? "off",
				createdAt: meta?.createdAt ?? new Date().toISOString(),
				activePrompt: null,
				...(ceiling !== undefined ? { ceiling } : {}),
			};
			scope.sessionCreated = true;
			scope.sessions.set(id, session);
			scope.boundSessionId = id;
			options.bindTelemetrySession?.(id);
			const ceilingEcho = guards.applySessionCeiling(session);
			commands.announceCommands(id);
			scope.telemetry.bind(false);
			await config.listTargetModels(session.target);
			config.refreshThinkingOption(session);
			const opened = {
				sessionId: id,
				...sessionConfig(options, scope.listingFallbacks, session),
				_meta: {
					...ceilingEcho,
					...modelsResultMeta(options, session),
					[ACP_SESSION_META_KEY]: sessionResultMeta(session, false),
					...(await guards.workspaceResultMeta()),
					...trustResultMeta(session.cwd),
				},
			};
			// After the result is written, so the client has bound the session id the frame names.
			setImmediate(() => readoutFeed.publishReadouts(id));
			return opened;
		});
	});

	/**
	 * Everything a restore reads, gathered before anything changes, so a read
	 * failure leaves the bound session exactly as it was. `session/load`, a
	 * fork, a /tree switch and a handoff all restore through here: one replay
	 * projection, one provider context builder.
	 */
	const prepareRestore = (
		id: string,
		leafTurnId: string | null,
		replayScope: "leaf" | "upto",
		replayToClient: boolean,
	): PreparedRestore => {
		if (options.readSessionEntries === undefined || options.buildReplayMessages === undefined) {
			throw new Error("session replay is not wired");
		}
		const entries = options.readSessionEntries(id);
		return {
			leafTurnId,
			replayMessages: options.buildReplayMessages(entries, leafTurnId, replayScope),
			replay: replayToClient
				? prepareAcpReplay(
						entries,
						leafTurnId,
						id,
						scope.canonicalCwd,
						options.session?.history().find((meta) => meta.id === id)?.target ?? null,
					)
				: undefined,
		};
	};
	/** A reopened session's replay with each turn's usage; a telemetry read that fails leaves the replay as it was. */
	const replayWithUsage = async (
		replay: PreparedAcpReplay | undefined,
		sessionId: string,
	): Promise<PreparedAcpReplay | undefined> => {
		if (replay === undefined || replay.turns === 0 || options.telemetryReadModel === undefined) return replay;
		try {
			return withReplayUsage(replay, await options.telemetryReadModel.open(sessionId), scope.handshake.fullUsageEnabled);
		} catch (error) {
			options.diagnostics?.(`replay usage read failed: ${acpErrorMessage(error)}`);
			return replay;
		}
	};
	/** Bind `session` as the one this process hosts, then replay its branch to the client. */
	const bindRestored = (session: AcpServerSession, replay: PreparedAcpReplay | undefined): void => {
		scope.sessions.set(session.id, session);
		scope.boundSessionId = session.id;
		options.bindTelemetrySession?.(session.id);
		commands.announceCommands(session.id);
		if (replay !== undefined) {
			for (const replayParams of replay.params) options.transport.notify("session/update", replayParams);
			replayDispatchTerminals(events.forwardEvent, replay.runs);
		}
		// A restored session's meter goes out even when no history replays (session/resume), as session/load sends it.
		scope.telemetry.bind(replay !== undefined, true);
	};

	/** Whether a live process other than this one holds the session's ledger now, read from its record. */
	const heldElsewhere = (id: string): boolean => {
		try {
			const current = guards.workspaceMeta(id);
			return current.endedAt === null && liveSessionOwner(current) !== null;
		} catch {
			return false;
		}
	};
	/**
	 * A reopen of the session this process already hosts serves that session instead of refusing it as a second one:
	 * resume answers its current state, and load replays its branch first. The hosted session keeps the client MCP
	 * servers and ceiling it opened with, and nothing reopens under an active prompt.
	 */
	const reopenHosted = async (params: unknown, session: AcpServerSession, replayToClient: boolean) => {
		const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers", "additionalDirectories"]));
		assertNoAdditionalDirectories(request.additionalDirectories);
		guards.canonicalSessionCwd(request.cwd);
		if (requestCeiling(request) !== undefined) {
			throw new AcpRequestError(-32602, "an open session keeps the ceiling it was opened with", {
				code: "invalid_params",
			});
		}
		if (parseClientMcpServers(request.mcpServers, replayToClient).length > 0) {
			throw new AcpRequestError(-32602, "an open session keeps the client MCP servers it was opened with", {
				code: "invalid_params",
			});
		}
		if (
			options.session === undefined ||
			options.readSessionEntries === undefined ||
			options.buildReplayMessages === undefined ||
			options.chat.resetForSession === undefined
		) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		if (session.activePrompt !== null || options.chat.isStreaming() || scope.contextCommandInFlight !== null) {
			throw new AcpRequestError(-32602, "this session already has an active prompt", { code: "prompt_active" });
		}
		if (scope.activeShell !== null) {
			throw new AcpRequestError(-32602, "a shell line is running; wait for it or cancel it first", {
				code: "shell_active",
			});
		}
		let replay: PreparedAcpReplay | undefined;
		if (replayToClient) {
			try {
				replay = prepareAcpReplay(
					options.readSessionEntries(session.id),
					options.session.leafId(session.id),
					session.id,
					scope.canonicalCwd,
					guards.workspaceMeta(session.id).target,
				);
			} catch (error) {
				throw loadFailure(error);
			}
		}
		// The hosted session's live view, read in the same tick as the prompt check above.
		if (replay !== undefined)
			replay = withReplayUsage(replay, guards.liveSessionView(), scope.handshake.fullUsageEnabled);
		const ceilingEcho = guards.applySessionCeiling(session);
		commands.announceCommands(session.id);
		if (replay !== undefined) {
			for (const replayParams of replay.params) options.transport.notify("session/update", replayParams);
			replayDispatchTerminals(events.forwardEvent, replay.runs);
		}
		const reopened = {
			...sessionConfig(options, scope.listingFallbacks, session),
			_meta: {
				...ceilingEcho,
				...modelsResultMeta(options, session),
				[ACP_SESSION_META_KEY]: sessionResultMeta(
					session,
					true,
					replay !== undefined ? { turns: replay.turns, truncated: replay.truncated } : undefined,
				),
				...(await guards.workspaceResultMeta()),
				...trustResultMeta(session.cwd),
			},
		};
		setImmediate(() => readoutFeed.publishReadouts(session.id));
		return reopened;
	};
	const restoreSession = async (params: unknown, replayToClient: boolean) => {
		guards.requireInitialized();
		const hosted =
			isRecord(params) && scope.boundSessionId !== null && params.sessionId === scope.boundSessionId
				? scope.sessions.get(scope.boundSessionId)
				: undefined;
		if (hosted !== undefined && !scope.closingSessions.has(hosted.id))
			return reopenHosted(params, hosted, replayToClient);
		return guards.withSessionSlot(async () => {
			const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers", "additionalDirectories"]));
			// Composed exactly like session/new; without one the operator's limits apply.
			const ceiling = requestCeiling(request);
			assertCeilingEnforceable(options, ceiling);
			assertNoAdditionalDirectories(request.additionalDirectories);
			const id = sessionIdOf(request);
			guards.canonicalSessionCwd(request.cwd);
			const clientMcpServers = parseClientMcpServers(request.mcpServers, replayToClient);
			const stored = guards.workspaceMeta(id);
			// A record whose owner is gone crashed, and resuming claims it atomically, as the terminal's /resume does.
			if (heldElsewhere(id)) {
				throw new AcpRequestError(-32602, "session may already be open", { code: "session_open" });
			}
			if (
				options.session === undefined ||
				options.readSessionEntries === undefined ||
				options.buildReplayMessages === undefined ||
				options.chat.resetForSession === undefined
			) {
				throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
			}

			// Read and validate the client replay before MCP or session ownership changes.
			let entries: ReadonlyArray<SessionEntry>;
			let replay: PreparedAcpReplay | undefined;
			try {
				entries = options.readSessionEntries(id);
				const leaf = options.session.leafId(id);
				replay = replayToClient ? prepareAcpReplay(entries, leaf, id, scope.canonicalCwd, stored.target) : undefined;
			} catch (error) {
				throw loadFailure(error);
			}
			const recordedRoute = resumedSessionRoute(stored, entries);
			await attachClientMcpServers(options, clientMcpServers, ceiling);
			try {
				const restored = restoreControlledSession(
					{
						session: options.session,
						chat: { resetForSession: options.chat.resetForSession },
						readEntries: options.readSessionEntries,
						buildMessages: options.buildReplayMessages,
					},
					id,
				);
				replay = replayToClient
					? prepareAcpReplay(restored.entries, restored.leafTurnId, id, scope.canonicalCwd, stored.target)
					: undefined;
			} catch (error) {
				await options.mcpCapabilities?.detachClientServers();
				// The session never loaded: nothing was bound or appended, so there is no boundary to checkpoint.
				if (options.session.current()?.id === id) {
					try {
						await options.session.close();
					} catch {
						// Best effort: no replay has been emitted and the slot remains unused.
					}
				}
				// Another process claimed the session between the check above and the
				// resume's locked claim, which refused it. The client gets the same
				// code as the early check rather than a generic load failure.
				if (heldElsewhere(id)) {
					throw new AcpRequestError(-32602, "session may already be open", { code: "session_open" });
				}
				throw loadFailure(error);
			}

			const autonomy = options.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
			const session: AcpServerSession = {
				id,
				cwd: scope.canonicalCwd,
				autonomy,
				autonomySource: "settings",
				target: safeConfiguredIdentifier(recordedRoute.target, ACP_MAX_TARGET_ID_BYTES),
				model: safeConfiguredIdentifier(recordedRoute.model, ACP_MAX_MODEL_ID_BYTES),
				thinkingLevel: options.settings?.read().thinkingLevel ?? "off",
				createdAt: stored.createdAt,
				activePrompt: null,
				...(ceiling !== undefined ? { ceiling } : {}),
			};
			scope.sessionCreated = true;
			// Its first prompt, in whichever process took it, carried the startup notices; a reload does not repeat them.
			if (entries.some((entry) => entry.kind === "message" && entry.role === "user")) scope.startupHintsSessionId = id;
			const ceilingEcho = guards.applySessionCeiling(session);
			replay = await replayWithUsage(replay, id);
			// The first usage frame and the ledger read the view the next request would publish, not the saved snapshot.
			await options.chat.nextRequestReady?.();
			bindRestored(session, replay);
			const loaded = {
				...sessionConfig(options, scope.listingFallbacks, session),
				_meta: {
					...ceilingEcho,
					...modelsResultMeta(options, session),
					[ACP_SESSION_META_KEY]: sessionResultMeta(
						session,
						true,
						replay !== undefined ? { turns: replay.turns, truncated: replay.truncated } : undefined,
					),
					...(await guards.workspaceResultMeta()),
					...trustResultMeta(session.cwd),
				},
			};
			// After the result is written, so the client has bound the session id the frame names.
			setImmediate(() => readoutFeed.publishReadouts(id));
			return loaded;
		});
	};
	options.transport.onRequest("session/load", (params) => restoreSession(params, true));
	options.transport.onRequest("session/resume", (params) => restoreSession(params, false));

	options.transport.onRequest(ACP_SESSION_LIST_METHOD, (params): AcpSessionList => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["cwd", "cursor"]));
		if (options.session === undefined)
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		if (request.cwd !== undefined && request.cwd !== null) {
			if (typeof request.cwd !== "string" || !isAbsolute(request.cwd))
				throw new AcpRequestError(-32602, "cwd must be an absolute path", { code: "invalid_params" });
			let filterCwd: string;
			try {
				filterCwd = realpathSync(request.cwd);
			} catch {
				return { sessions: [] };
			}
			if (filterCwd !== scope.canonicalCwd) return { sessions: [] };
		}
		let start = 0;
		if (request.cursor !== undefined && request.cursor !== null) {
			if (typeof request.cursor !== "string" || request.cursor.length > 512)
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			let decoded: unknown;
			try {
				decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
			} catch {
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			}
			if (
				!isRecord(decoded) ||
				decoded.workspace !== scope.workspaceInstanceId ||
				!Number.isSafeInteger(decoded.start) ||
				(decoded.start as number) < 0 ||
				Buffer.from(JSON.stringify(decoded)).toString("base64url") !== request.cursor
			) {
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			}
			start = decoded.start as number;
		}
		const history = guards.workspaceHistory().filter((meta) => meta.hasModelTurn !== false);
		const projected: AcpSessionListRow[] = [];
		let budgetBytes = utf8Bytes(JSON.stringify({ sessions: [] }));
		for (const meta of history.slice(start, start + 50)) {
			const label = safeStoredString(meta.name, ACP_MAX_LABEL_BYTES).trim();
			const messageCount = safeCount(meta.messageCount);
			const item = {
				sessionId: meta.id,
				cwd: scope.canonicalCwd,
				...(label.length > 0 ? { title: label } : {}),
				updatedAt: safeIso(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt),
				_meta: {
					[ACP_SESSION_META_KEY]: {
						createdAt: safeIso(meta.createdAt),
						endedAt: meta.endedAt === null ? null : safeIso(meta.endedAt),
						target: safeConfiguredIdentifier(meta.currentTarget ?? meta.target, ACP_MAX_TARGET_ID_BYTES),
						model: safeConfiguredIdentifier(meta.currentModel ?? meta.model, ACP_MAX_MODEL_ID_BYTES),
						...(meta.firstMessagePreview !== undefined
							? { firstMessagePreview: safeStoredString(meta.firstMessagePreview, ACP_MAX_LABEL_BYTES) }
							: {}),
						...(messageCount !== null ? { messageCount } : {}),
						...(meta.hasModelTurn !== undefined ? { hasModelTurn: meta.hasModelTurn } : {}),
						...(meta.lastActivityAt !== undefined ? { lastActivityAt: safeIso(meta.lastActivityAt) } : {}),
					},
				},
			};
			const itemBytes = utf8Bytes(JSON.stringify(item));
			const separatorBytes = projected.length > 0 ? 1 : 0;
			if (budgetBytes + separatorBytes + itemBytes > ACP_MAX_SESSION_LIST_RESULT_BYTES) {
				break;
			}
			projected.push(item);
			budgetBytes += separatorBytes + itemBytes;
		}
		return {
			sessions: projected,
			...(start + projected.length < history.length
				? {
						nextCursor: Buffer.from(
							JSON.stringify({ workspace: scope.workspaceInstanceId, start: start + projected.length }),
						).toString("base64url"),
					}
				: {}),
		};
	});

	options.transport.onRequest(ACP_BOARD_METHOD, (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.board === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		guards.getSession(request);
		return projectSessionBoard(options.board());
	});

	// The jobs the bound session owns now. Events carry only changes, so a client that binds or
	// resumes reads this once and folds `job.changed` after it.
	options.transport.onRequest(ACP_JOBS_LIST_METHOD, (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const listJobs = options.commands?.jobs;
		if (listJobs === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = guards.getSession(request);
		if (session.id !== scope.boundSessionId) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		// Live jobs first, then the newest finished ones, so the cap drops history rather than work in flight.
		const ranked = [...listJobs()].sort(
			(left, right) =>
				Number(right.state !== "terminal") - Number(left.state !== "terminal") || right.updatedAt - left.updatedAt,
		);
		const jobs: AcpJob[] = [];
		for (const job of ranked) {
			if (jobs.length >= ACP_MAX_JOBS) break;
			const projected = jobEventPayload(
				job,
				jobIsComplete(job),
				events.jobTurnOpen(job.id),
				options.commands?.jobSpend?.(job.id) ?? null,
			);
			if (projected !== null) jobs.push(projected);
		}
		return { jobs };
	});

	options.transport.onRequest(ACP_SESSION_TREE_METHOD, (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const { session } = requireBranches(options);
		const bound = guards.getSession(request);
		try {
			return projectSessionTree(session.tree(bound.id));
		} catch {
			throw new AcpRequestError(-32603, "session tree could not be read", { code: "internal_error" });
		}
	});

	options.transport.onRequest(ACP_SNAPSHOTS_LIST_METHOD, async (params): Promise<AcpSnapshotList> => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const bound = guards.getSession(request);
		try {
			const store = snapshotStore(options, bound);
			const records = store.list();
			const differences = records.length > 0 ? await store.differences() : null;
			const counts = differences?.kind === "counts" ? differences.counts : null;
			return {
				snapshots: records.slice(0, ACP_SNAPSHOT_LIST_MAX).map((record) => ({
					n: record.n,
					at: clipSnapshotText(record.at, 64),
					reason: clipSnapshotText(record.reason, 512),
					...(record.tool !== undefined ? { tool: clipSnapshotText(record.tool, 128) } : {}),
					...(record.turnId !== undefined && record.turnId.length > 0 && record.turnId.length <= 128
						? { turnId: record.turnId }
						: {}),
					differs: counts?.get(record.n) ?? null,
					skipped: record.skipped.length,
				})),
				truncated: records.length > ACP_SNAPSHOT_LIST_MAX,
			};
		} catch (error) {
			return snapshotFailure(error);
		}
	});

	options.transport.onRequest(ACP_SNAPSHOT_PREVIEW_METHOD, async (params): Promise<AcpSnapshotPlan> => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "n"]));
		const bound = guards.getSession(request);
		const n = snapshotN(request.n);
		try {
			const preview = await snapshotStore(options, bound).preview(n);
			if (preview.kind === "unavailable") return { kind: "unavailable", reason: clipSnapshotText(preview.reason, 512) };
			const restore = snapshotPaths(preview.plan.restore);
			const remove = snapshotPaths(preview.plan.remove);
			const kept = snapshotKept(preview.plan.kept);
			return {
				kind: "plan",
				n: preview.plan.n,
				restore: restore.rows,
				remove: remove.rows,
				kept: kept.rows,
				refs: snapshotRefs(preview.plan.refs),
				truncated: restore.cut || remove.cut || kept.cut,
			};
		} catch (error) {
			return snapshotFailure(error);
		}
	});

	options.transport.onRequest(ACP_SNAPSHOT_RESTORE_METHOD, async (params): Promise<AcpSnapshotOutcome> => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "n"]));
		const bound = guards.getSession(request);
		const n = snapshotN(request.n);
		guards.requireIdle(bound, "rewind");
		try {
			const outcome = await snapshotStore(options, bound).restore(n);
			if (outcome.kind === "unavailable") return { kind: "unavailable", reason: clipSnapshotText(outcome.reason, 512) };
			if (outcome.kind === "failed")
				return { kind: "failed", reason: clipSnapshotText(outcome.reason, 512), undo: outcome.preRewind.n };
			const restored = snapshotPaths(outcome.restored);
			const removed = snapshotPaths(outcome.removed);
			const kept = snapshotKept(outcome.kept);
			const failed = snapshotKept(outcome.failed);
			return {
				kind: "restored",
				n: outcome.n,
				undo: outcome.preRewind.n,
				restored: restored.rows,
				removed: removed.rows,
				kept: kept.rows,
				failed: failed.rows,
				refs: snapshotRefs(outcome.refs),
				truncated: restored.cut || removed.cut || kept.cut || failed.cut,
			};
		} catch (error) {
			return snapshotFailure(error);
		}
	});

	// Enter in /tree: the next request appends under the chosen turn, and the
	// conversation is replayed as that branch. Sibling branches stay on disk.
	options.transport.onRequest(ACP_SESSION_SWITCH_TURN_METHOD, (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "turnId"]));
		const { session, resetForSession } = requireBranches(options);
		const bound = guards.getSession(request);
		guards.requireIdle(bound, "switch branches");
		const turnId = selectableTurn(session, bound.id, request.turnId);
		let restore: PreparedRestore;
		try {
			restore = prepareRestore(bound.id, turnId, "upto", true);
		} catch {
			throw new AcpRequestError(-32603, "branch could not be read", { code: "internal_error" });
		}
		try {
			session.switchTurn(turnId);
		} catch (error) {
			options.diagnostics?.(`branch switch failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "branch switch failed", { code: "internal_error" });
		}
		resetForSession(turnId, restore.replayMessages);
		bindRestored(bound, restore.replay);
		const replay = restore.replay;
		return {
			sessionId: bound.id,
			leafId: turnId,
			_meta: {
				[ACP_SESSION_META_KEY]: sessionResultMeta(
					bound,
					true,
					replay === undefined ? undefined : { turns: replay.turns, truncated: replay.truncated },
				),
			},
		};
	});

	// /fork: a new session carrying the branch up to the chosen turn. The
	// process follows the new session, as the terminal does, and the parent is
	// closed on disk. Workspace files are never rewound. One process hosts one
	// session, so the replacement is stated, never silent: the result carries
	// `parentClosed`, the parent gets a notice, and a later request naming it is
	// refused `session_replaced` with the child's id rather than `session_unknown`.
	/**
	 * Forks the bound session at `turnId` and hosts the child in its place. The extension method replays the child's
	 * branch to the client; standard session/fork does not, since the client already holds that conversation.
	 */
	const forkBoundSession = async (
		request: Record<string, unknown>,
		chooseTurn: "request" | "leaf",
		replayToClient: boolean,
		clientMcpServers?: ReadonlyArray<McpClientServerSpec>,
	) => {
		const { session, resetForSession, readEntries, buildMessages } = requireBranches(options);
		const bound = guards.getSession(request);
		guards.requireIdle(bound, "fork");
		const ceiling = successorCeiling(options, bound, request);
		const requested = chooseTurn === "request" ? request.turnId : session.leafId(bound.id);
		if (requested === null)
			throw new AcpRequestError(-32602, "the session has no turn to fork from", { code: "turn_unknown" });
		const turnId = selectableTurn(session, bound.id, requested);
		// The fork closes the parent's ledger.
		await checkpointBeforeClose(options, bound.id, "fork");
		guards.requireStillIdle(bound, "fork");
		if (clientMcpServers !== undefined) {
			// Standard fork names the child's client servers, so the parent's go first; a launch failure refuses the fork
			// before the session changes, as on an opener.
			await options.mcpCapabilities?.detachClientServers();
			await attachClientMcpServers(options, clientMcpServers, ceiling);
			guards.requireStillIdle(bound, "fork");
		}
		let meta: SessionMeta;
		try {
			meta = session.fork(turnId);
		} catch (error) {
			// The session domain keeps the parent current when a fork throws.
			options.diagnostics?.(`fork failed: ${acpErrorMessage(error)}`);
			if (clientMcpServers !== undefined) await options.mcpCapabilities?.detachClientServers();
			throw new AcpRequestError(-32603, "fork failed", { code: "internal_error" });
		}
		if (
			meta.id === bound.id ||
			session.current()?.id !== meta.id ||
			safeStoredIdentifier(meta.id, ACP_MAX_SESSION_ID_BYTES) === null
		) {
			throw new AcpRequestError(-32603, "fork failed", { code: "internal_error" });
		}
		// Route, autonomy and thinking are this process's, not the ledger's, so
		// the child keeps what the parent's conversation was using.
		const forked: AcpServerSession = {
			...bound,
			id: meta.id,
			createdAt: meta.createdAt,
			activePrompt: null,
			...(ceiling !== undefined ? { ceiling } : {}),
		};
		scope.sessions.delete(bound.id);
		scope.closedSessionIds.add(bound.id);
		scope.replacedSessions.delete(meta.id);
		scope.replacedSessions.set(bound.id, meta.id);
		options.transport.notify("session/update", {
			sessionId: bound.id,
			update: {
				sessionUpdate: "session_info_update",
				_meta: {
					[ACP_NOTICE_META_KEY]: {
						level: "info",
						text: `This session is closed: its fork ${meta.id} now holds this process, which hosts one session at a time. Close ${meta.id}, then load or resume this session to continue it.`,
					},
				},
			},
		});
		let replay: PreparedAcpReplay | undefined;
		let replayFailed = false;
		let forkLeaf: string | null = turnId;
		try {
			const restored = replayCurrentSession(
				{
					session,
					chat: { resetForSession },
					readEntries,
					buildMessages,
				},
				meta.id,
				"leaf",
				undefined,
				turnId,
			);
			forkLeaf = restored.leafTurnId;
			if (replayToClient)
				replay = prepareAcpReplay(restored.entries, restored.leafTurnId, meta.id, scope.canonicalCwd, meta.target);
		} catch (error) {
			options.diagnostics?.(`fork replay failed: ${acpErrorMessage(error)}`);
			resetForSession(forkLeaf, []);
			replayFailed = true;
		}
		const ceilingEcho = guards.applySessionCeiling(forked);
		bindRestored(forked, replay);
		const parent = { parentSessionId: bound.id, parentTurnId: turnId };
		// Standard session/fork answers with exactly the unstable ForkSessionResponse fields, so its parent travels in
		// `_meta`; the extension method keeps it beside the session id.
		return {
			sessionId: forked.id,
			...(replayToClient ? parent : {}),
			...sessionConfig(options, scope.listingFallbacks, forked),
			_meta: {
				...ceilingEcho,
				...modelsResultMeta(options, forked),
				[ACP_SESSION_META_KEY]: {
					...sessionResultMeta(
						forked,
						true,
						replay === undefined ? undefined : { turns: replay.turns, truncated: replay.truncated },
					),
					...(replayToClient ? {} : parent),
					parentClosed: true,
					...(replayFailed ? { replayFailed: true } : {}),
				},
			},
		};
	};
	options.transport.onRequest(ACP_SESSION_FORK_METHOD, (params) => {
		guards.requireInitialized();
		return forkBoundSession(assertParamKeys(params, new Set(["sessionId", "turnId"])), "request", true);
	});
	// Standard ACP fork: the whole active branch, at its leaf, with the client MCP servers the request names in place of
	// the parent's.
	options.transport.onRequest("session/fork", (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers", "additionalDirectories"]));
		assertNoAdditionalDirectories(request.additionalDirectories);
		guards.canonicalSessionCwd(request.cwd);
		const clientMcpServers = parseClientMcpServers(request.mcpServers, false);
		return forkBoundSession(request, "leaf", false, clientMcpServers);
	});

	// /handoff, first half: extract with one repair and render the document a
	// person reviews. Nothing is written; the draft waits here under an id.
	options.transport.onRequest(ACP_HANDOFF_PREPARE_METHOD, async (params): Promise<AcpHandoffPrepareResult> => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "goal"]));
		const { control } = requireHandoff(options);
		const bound = guards.getSession(request);
		guards.requireIdle(bound, "hand off");
		const goal = requireBoundedClientString(request.goal, "goal", ACP_MAX_HANDOFF_GOAL_BYTES, { allowEmpty: true });
		if (scope.handoffPreparing) return handoffRefusal("warn", "busy", "a handoff document is already being drawn up");
		scope.handoffPreparing = true;
		const serial = scope.promptSerial;
		let outcome: Awaited<ReturnType<AcpHandoffControl["prepare"]>>;
		try {
			outcome = await control.prepare(goal);
		} catch (error) {
			options.diagnostics?.(`handoff extraction failed: ${acpErrorMessage(error)}`);
			return handoffRefusal("error", "extraction", "the extraction round failed");
		} finally {
			scope.handoffPreparing = false;
		}
		if (!outcome.ok) {
			// A failed round carries the provider's own words; those stay on the stderr tail.
			if (outcome.code === "provider") {
				options.diagnostics?.(`handoff extraction failed: ${acpErrorMessage(outcome.reason)}`);
				return handoffRefusal(
					outcome.level,
					outcome.code,
					"the model round failed; the agent's diagnostics carry the provider's answer",
				);
			}
			return handoffRefusal(outcome.level, outcome.code, outcome.reason);
		}
		if (serial !== scope.promptSerial || scope.sessions.get(bound.id) !== bound) {
			return handoffRefusal("warn", "stale", "the conversation moved while the document was drawn; nothing was written");
		}
		if (utf8Bytes(outcome.draft.document) > ACP_MAX_HANDOFF_DOCUMENT_BYTES) {
			return handoffRefusal("error", "too_large", "the handoff document is larger than a client can review");
		}
		const handoffId = randomUUID();
		scope.pendingHandoff = { handoffId, sessionId: bound.id, draft: outcome.draft };
		return {
			status: "ready" as const,
			handoffId,
			goal: outcome.draft.goal,
			fromSessionId: outcome.draft.fromSessionId,
			document: outcome.draft.document,
		};
	});

	// /handoff, second half: seed the successor with the reviewed document and
	// move the process binding to it, the same way a fork does.
	options.transport.onRequest(ACP_HANDOFF_COMMIT_METHOD, async (params): Promise<AcpHandoffCommitResult> => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "handoffId", "document"]));
		const { control, session, resetForSession } = requireHandoff(options);
		const bound = guards.getSession(request);
		guards.requireIdle(bound, "hand off");
		const ceiling = successorCeiling(options, bound, request);
		const handoffId = requireBoundedClientString(request.handoffId, "handoffId", ACP_MAX_SESSION_ID_BYTES);
		const document = handoffDocument(request.document);
		const pending = scope.pendingHandoff;
		if (pending === null || pending.handoffId !== handoffId || pending.sessionId !== bound.id) {
			return handoffRefusal(
				"warn",
				"stale",
				"this document no longer describes the conversation; draw it up again. Nothing was written",
			);
		}
		// The successor replaces the bound session, whose ledger closes. An empty review changes nothing.
		if (document.trim().length > 0) {
			await checkpointBeforeClose(options, bound.id, "handoff");
			guards.requireStillIdle(bound, "hand off");
		}
		if (scope.pendingHandoff !== pending) {
			return handoffRefusal(
				"warn",
				"stale",
				"this document no longer describes the conversation; draw it up again. Nothing was written",
			);
		}
		const outcome = control.commit(pending.draft, document);
		if (!outcome.ok) {
			// An empty review is the reviewer's to fix; every other refusal ends the draft.
			if (outcome.code !== "empty") scope.pendingHandoff = null;
			return handoffRefusal(outcome.level, outcome.code, outcome.reason);
		}
		scope.pendingHandoff = null;
		const toSessionId = outcome.toSessionId;
		const current = session.current();
		if (current?.id !== toSessionId || safeStoredIdentifier(toSessionId, ACP_MAX_SESSION_ID_BYTES) === null) {
			throw new AcpRequestError(-32603, "handoff failed", { code: "internal_error" });
		}
		const successor: AcpServerSession = {
			...bound,
			id: toSessionId,
			createdAt: current.createdAt,
			activePrompt: null,
			...(ceiling !== undefined ? { ceiling } : {}),
		};
		scope.sessions.delete(bound.id);
		let replay: PreparedAcpReplay | undefined;
		try {
			const restore = prepareRestore(toSessionId, null, "leaf", true);
			resetForSession(null, restore.replayMessages);
			replay = restore.replay;
		} catch (error) {
			options.diagnostics?.(`handoff replay failed: ${acpErrorMessage(error)}`);
			resetForSession(null);
		}
		for (const warning of outcome.warnings) options.diagnostics?.(`handoff: ${warning}`);
		const ceilingEcho = guards.applySessionCeiling(successor);
		bindRestored(successor, replay);
		return {
			status: "committed" as const,
			sessionId: toSessionId,
			fromSessionId: bound.id,
			warnings: outcome.warnings.slice(0, 8).map((warning) => boundString(warning, ACP_MAX_HANDOFF_REASON_BYTES)),
			...sessionConfig(options, scope.listingFallbacks, successor),
			_meta: {
				...ceilingEcho,
				...modelsResultMeta(options, successor),
				[ACP_SESSION_META_KEY]: sessionResultMeta(successor, false),
			},
		};
	});

	options.transport.onRequest(ACP_HANDOFF_CANCEL_METHOD, (params): AcpHandoffCancelResult => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "handoffId"]));
		requireHandoff(options);
		const bound = guards.getSession(request);
		const handoffId = requireBoundedClientString(request.handoffId, "handoffId", ACP_MAX_SESSION_ID_BYTES);
		const cancelled = scope.pendingHandoff?.handoffId === handoffId && scope.pendingHandoff.sessionId === bound.id;
		if (cancelled) scope.pendingHandoff = null;
		return { cancelled };
	});

	if (options.telemetryReadModel) {
		const handlers = telemetryRequestHandlers({
			model: options.telemetryReadModel,
			...(options.refreshQuota ? { refreshQuota: options.refreshQuota } : {}),
			params: assertParamKeys,
			session: guards.getSession,
		});
		for (const [method, handler] of Object.entries(handlers))
			options.transport.onRequest(method, (params) => {
				guards.requireInitialized();
				return handler(params);
			});
	}

	// /btw and /draft: one round beside the session at a time, cancellable, and
	// never a turn. The chat loop answers beside a turn in flight over a snapshot
	// of its history (#415); a refusal it reports is an outcome, not a protocol
	// error.
	const runAside = async <T>(sessionId: string, round: (signal: AbortSignal) => Promise<T>): Promise<T> => {
		if (scope.closingSessions.has(sessionId) || options.transport.closed)
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		if (scope.asideRound !== null)
			throw new AcpRequestError(-32602, "a side question or draft is already running", { code: "aside_active" });
		const controller = new AbortController();
		let settle: () => void = () => {};
		const active = {
			sessionId,
			abort: controller,
			settled: new Promise<void>((resolve) => {
				settle = resolve;
			}),
		};
		scope.asideRound = active;
		try {
			return await round(controller.signal);
		} finally {
			if (scope.asideRound === active) scope.asideRound = null;
			settle();
		}
	};
	options.transport.onRequest(ACP_ASIDE_ASK_METHOD, async (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "question"]));
		const aside = requireAside(options);
		const session = guards.getSession(request);
		const question = asideText(request.question, "question");
		return projectAsideAnswer(await runAside(session.id, (signal) => aside.ask(question, signal)), options.diagnostics);
	});
	options.transport.onRequest(ACP_ASIDE_DRAFT_METHOD, async (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "request", "count"]));
		const aside = requireAside(options);
		const session = guards.getSession(request);
		const text = asideText(request.request, "request");
		const count = request.count ?? ACP_ASIDE_DRAFT_COUNTS.default;
		if (
			typeof count !== "number" ||
			!Number.isInteger(count) ||
			count < ACP_ASIDE_DRAFT_COUNTS.min ||
			count > ACP_ASIDE_DRAFT_COUNTS.max
		)
			throw new AcpRequestError(-32602, `count must be ${ACP_ASIDE_DRAFT_COUNTS.min} to ${ACP_ASIDE_DRAFT_COUNTS.max}`, {
				code: "invalid_params",
			});
		return projectDraftOutcome(
			await runAside(session.id, (signal) => aside.draft(text, count, signal)),
			options.diagnostics,
		);
	});
	options.transport.onRequest(ACP_ASIDE_CANCEL_METHOD, (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		requireAside(options);
		guards.getSession(request);
		const round = scope.asideRound;
		round?.abort.abort();
		return { cancelled: round !== null };
	});

	options.transport.onRequest(ACP_CONTEXT_STATUS_METHOD, (params): ContextOperationStatus => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (!options.contextLedger) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		const session = guards.getSession(request);
		if (session.id !== scope.boundSessionId)
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		const current =
			scope.contextActivity?.operation?.sessionId === session.id &&
			scope.contextActivity.operation.cwd === scope.canonicalCwd
				? scope.contextActivity
				: null;
		const recorded = [...(options.readSessionEntries?.(session.id) ?? [])].reverse().flatMap((entry) => {
			if (entry.kind !== "custom" || entry.customType !== CONTEXT_OPERATION_CUSTOM_TYPE) return [];
			const operation = readContextOperation(entry.data);
			return operation?.outcome && operation.sessionId === session.id && operation.cwd === scope.canonicalCwd
				? [operation]
				: [];
		});
		return {
			version: 1,
			active: current && !current.operation?.outcome ? current : null,
			latest: current?.operation?.outcome ? current.operation : (recorded[0] ?? null),
		};
	});

	// The terminal's /context window view, read and never recomputed.
	options.transport.onRequest(ACP_CONTEXT_LEDGER_METHOD, (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.contextLedger === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		guards.getSession(request);
		try {
			return projectContextLedger(options.contextLedger());
		} catch (error) {
			options.diagnostics?.(`context ledger failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "context ledger could not be read", { code: "internal_error" });
		}
	});

	// The terminal's /view artifacts, from the overlay's own providers.
	const artifactDeps = (request: Record<string, unknown>) => {
		guards.requireInitialized();
		if (options.artifacts === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = guards.getSession(request);
		const deps = options.artifacts.deps(session.id);
		if (deps === null) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		return deps;
	};
	options.transport.onRequest(ACP_ARTIFACTS_LIST_METHOD, async (params) => {
		const request = assertParamKeys(params, new Set(["sessionId", "categories"]));
		const deps = artifactDeps(request);
		const categories = parseArtifactCategories(request.categories);
		try {
			return await listAcpArtifacts(deps, categories);
		} catch (error) {
			return artifactFailure(options, "list", error);
		}
	});
	options.transport.onRequest(ACP_ARTIFACTS_READ_METHOD, async (params) => {
		const request = assertParamKeys(params, new Set(["sessionId", "id", "offset", "limit", "details"]));
		const deps = artifactDeps(request);
		const read = parseArtifactReadRequest(request);
		try {
			return await readAcpArtifact(deps, read);
		} catch (error) {
			return artifactFailure(options, "read", error);
		}
	});

	// Compile a named playbook for review. Nothing is dispatched, reserved or written.
	options.transport.onRequest(ACP_FLEET_PREVIEW_METHOD, (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "name", "vars", "resume"]));
		const control = requireFleet(options);
		guards.getSession(request);
		return projectFleetPreview(
			compileFleet(options, control, fleetName(request.name), fleetVars(request.vars), fleetResume(request.resume)),
		);
	});

	// Start the plan the client approved, and only that plan: it is compiled
	// again here and refused before any dispatch when its hash moved.
	options.transport.onRequest(ACP_FLEET_RUN_METHOD, async (params) => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "name", "vars", "planHash", "resume"]));
		const control = requireFleet(options);
		const bound = guards.getSession(request);
		// Refused, never queued: an approved plan describes the workspace as it
		// stands, and a turn still in flight is about to change it.
		guards.requireIdle(bound, "start a fleet run");
		const name = fleetName(request.name);
		const vars = fleetVars(request.vars);
		if (typeof request.planHash !== "string" || !/^[0-9a-f]{64}$/u.test(request.planHash)) {
			throw new AcpRequestError(-32602, "planHash is invalid", { code: "invalid_params" });
		}
		// A playbook starts workers outside any tool call, so the session's limits
		// screen it as they screen /run, and every worker it starts carries them (Z1).
		const limits = scope.standingLimits;
		if (limits?.readOnly === true || !turnAllowsTool(limits, ToolNames.Dispatch)) {
			throw new AcpRequestError(
				-32602,
				limits?.readOnly === true
					? "a fleet run starts workers that write and the ceiling is read-only. Nothing was dispatched"
					: "a fleet run starts workers and the ceiling withholds dispatch. Nothing was dispatched",
				{ code: "ceiling_refused" },
			);
		}
		const result = compileFleet(options, control, name, vars, fleetResume(request.resume));
		if (!result.ok) return projectFleetPreview(result);
		if (result.preview.planHash !== request.planHash) {
			return {
				status: "changed" as const,
				name: projectFleetPreview(result).name,
				planHash: result.preview.planHash,
				reason: "the plan changed since it was previewed; review it again. Nothing was dispatched",
			};
		}
		let started: Awaited<ReturnType<AcpFleetControl["run"]>>;
		try {
			started = await control.run(result.preview, limits);
		} catch (error) {
			options.diagnostics?.(`fleet run failed to start: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "fleet run failed to start", { code: "internal_error" });
		}
		if (started.status === "refused") {
			return {
				status: "refused" as const,
				name,
				diagnostics: [boundedText(started.reason, ACP_FLEET_MAX_REASON_BYTES)],
			};
		}
		const fleetRootId = boundString(started.fleetRootId, 128);
		if (started.status === "failed") {
			return {
				status: "failed" as const,
				name,
				planHash: result.preview.planHash,
				fleetRootId,
				reason: boundedText(started.reason, ACP_FLEET_MAX_REASON_BYTES),
			};
		}
		return {
			status: "started" as const,
			name,
			planHash: result.preview.planHash,
			fleetRootId,
			stepCount: result.preview.plan.steps.length,
		};
	});

	// The /decisions overlay's `s` and `c`. The record keeps the decision,
	// marked superseded; a correction's turn is returned for the client to send,
	// so it lands in the conversation as the terminal's does.
	options.transport.onRequest(ACP_DECISION_SUPERSEDE_METHOD, (params): AcpDecisionSupersedeResult => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "interviewId", "key", "correction"]));
		const actions = requireBoardActions(options);
		const bound = guards.getSession(request);
		guards.requireIdle(bound, "revise a decision");
		const interviewId = requireBoundedClientString(request.interviewId, "interviewId", 256);
		const key = requireBoundedClientString(request.key, "key", 1024);
		const correction =
			request.correction === undefined
				? undefined
				: requireBoundedClientString(request.correction, "correction", ACP_MAX_CORRECTION_BYTES).trim();
		if (correction !== undefined && correction.length === 0) {
			throw new AcpRequestError(-32602, "a correction needs the new direction", { code: "invalid_params" });
		}
		// Superseding writes the board's decision record, which a read-only ceiling denies.
		if (scope.standingLimits?.readOnly === true) {
			throw new AcpRequestError(-32602, "superseding a decision writes the board and the ceiling is read-only", {
				code: "ceiling_refused",
			});
		}
		try {
			const outcome = actions.supersedeDecision(interviewId, key, correction);
			return {
				status: outcome.status,
				...(outcome.correctionTurn !== undefined ? { correctionTurn: boundString(outcome.correctionTurn, 4096) } : {}),
			};
		} catch (error) {
			return { status: "refused" as const, reason: boundString(acpErrorMessage(error), 1024) };
		}
	});

	// The /memory overlay's `p` and `g`. A proposal is a candidate for review,
	// never an approval; global scope broadens where a lesson applies, so it is
	// refused until the client says the operator acknowledged that.
	options.transport.onRequest(ACP_MEMORY_PROPOSE_METHOD, async (params): Promise<AcpMemoryProposeResult> => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "entryId", "scope", "acknowledgeGlobal"]));
		const actions = requireBoardActions(options);
		guards.getSession(request);
		const entryId = requireBoundedClientString(request.entryId, "entryId", 256);
		if (request.scope !== "repo" && request.scope !== "global") {
			throw new AcpRequestError(-32602, "scope must be repo or global", { code: "invalid_params" });
		}
		// A proposal writes a memory record, which a read-only ceiling denies.
		if (scope.standingLimits?.readOnly === true) {
			throw new AcpRequestError(-32602, "a memory proposal writes a record and the ceiling is read-only", {
				code: "ceiling_refused",
			});
		}
		if (request.scope === "global" && request.acknowledgeGlobal !== true) {
			return {
				status: "needs_acknowledgement" as const,
				reason: "global scope broadens where this lesson applies; acknowledge it to propose",
			};
		}
		try {
			const outcome = await actions.proposeMemory(entryId, request.scope);
			return { status: outcome.created ? ("proposed" as const) : ("existing" as const), recordId: outcome.recordId };
		} catch (error) {
			return { status: "refused" as const, reason: boundString(acpErrorMessage(error), 1024) };
		}
	});

	options.transport.onRequest(ACP_SESSION_LABEL_METHOD, (params): AcpEmptyResult => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "label"]));
		const id = sessionIdOf(request);
		guards.workspaceMeta(id);
		const label = requireBoundedClientString(request.label, "label", ACP_MAX_LABEL_BYTES, { allowEmpty: true });
		if (options.session === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		try {
			options.session.setName(label, id);
		} catch {
			throw new AcpRequestError(-32603, "session label could not be saved", { code: "internal_error" });
		}
		if (scope.sessions.has(id)) {
			options.transport.notify("session/update", {
				sessionId: id,
				update: { sessionUpdate: "session_info_update", title: label.length > 0 ? label : null },
			});
		}
		return {};
	});

	options.transport.onRequest("session/delete", (params): AcpEmptyResult => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const id = sessionIdOf(request);
		const meta = guards.workspaceMeta(id);
		// Delete never closes a session for the client: the refusal names the step that comes first (bt-12).
		const stillOpen =
			"session is still open; close it first (session/close, or the close action in the client that has it open), then delete it";
		if (scope.sessions.has(id) || meta.endedAt === null) {
			throw new AcpRequestError(-32602, stillOpen, { code: "session_open" });
		}
		if (options.session === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		try {
			options.session.deleteSession(id);
		} catch (error) {
			// The delete re-checks under the claim lock; a resume that won the race reopened it.
			if (error instanceof Error && error.message.includes("may still be open")) {
				throw new AcpRequestError(-32602, stillOpen, { code: "session_open" });
			}
			throw new AcpRequestError(-32603, "session could not be deleted", { code: "internal_error" });
		}
		return {};
	});
	const control = createAcpServerControl(scope);

	options.transport.onRequest(ACP_SESSION_SHELL_METHOD, async (params): Promise<AcpShellResult> => {
		guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "command", "excludeFromContext"]));
		const session = guards.getSession(request);
		const label = options.labelOperatorCommand;
		const durable = options.session;
		const resetForSession = options.chat.resetForSession;
		if (label === undefined || durable === undefined || resetForSession === undefined || !branchesWired(options)) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const command = requireShellCommand(request.command);
		if (request.excludeFromContext !== undefined && typeof request.excludeFromContext !== "boolean") {
			throw new AcpRequestError(-32602, "excludeFromContext must be a boolean", { code: "invalid_params" });
		}
		const excludeFromContext = request.excludeFromContext === true;
		// The line runs outside any tool call, so the session's limits screen it
		// as they screen the model's own bash.
		if (scope.standingLimits?.readOnly === true || !turnAllowsTool(scope.standingLimits, ToolNames.Bash)) {
			throw new AcpRequestError(
				-32602,
				scope.standingLimits?.readOnly === true
					? "a shell line can write and the ceiling is read-only. Nothing ran"
					: "a shell line runs bash and the ceiling withholds it. Nothing ran",
				{ code: "ceiling_refused" },
			);
		}
		if (scope.closingSessions.has(session.id)) {
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		}
		// The terminal's two admission guards. A turn's context would change
		// underneath it when the line's entry lands, and one line runs at a time.
		if (session.activePrompt !== null || options.chat.isStreaming()) {
			throw new AcpRequestError(-32602, "a turn is running; cancel it before running a shell line", {
				code: "prompt_active",
			});
		}
		if (scope.contextCommandInFlight !== null || scope.activeShell !== null) {
			throw new AcpRequestError(-32602, "a shell line is already running; cancel it first", { code: "shell_active" });
		}
		if (durable.current()?.id !== session.id) durable.resume(session.id);
		const abort = new AbortController();
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		scope.activeShell = { sessionId: session.id, abort, settled };
		// The line is the operator's, not the agent's: its frames carry this key
		// instead of agent attribution, and the same call shape a `bash` row has.
		const meta = { [ACP_SHELL_META_KEY]: { version: 1, excludeFromContext } };
		const toolCallId = `shell_${randomUUID()}`;
		const shownCommand = redactUrlCredentials(command);
		const title = boundString(shownCommand, ACP_MAX_TOOL_TITLE_BYTES);
		const notify = (update: Record<string, unknown>): void => {
			try {
				options.transport.notify("session/update", { sessionId: session.id, update, _meta: meta });
			} catch {
				options.diagnostics?.("failed to send a shell line update");
			}
		};
		// The tool-progress opt-in and its bounds, applied to the line's cumulative output tail.
		let frames = 0;
		let lastSentAt = Number.NEGATIVE_INFINITY;
		let lastText = "";
		const onUpdate = (progress: BashCommandProgress): void => {
			const text = shellOutputTail(redactStreamingUrlCredentials(combineLiveBashOutput(progress)));
			const sentAt = scope.now();
			if (
				text.length === 0 ||
				text === lastText ||
				frames >= ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL ||
				sentAt - lastSentAt < ACP_MIN_TOOL_PROGRESS_INTERVAL_MS
			) {
				return;
			}
			frames += 1;
			lastSentAt = sentAt;
			lastText = text;
			notify({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", content: toolCallContent(text) });
		};
		try {
			const parentTurnId = durable.leafId() ?? null;
			notify({
				sessionUpdate: "tool_call",
				toolCallId,
				name: "shell",
				title,
				kind: "execute" satisfies AcpToolKind,
				status: "in_progress" satisfies AcpToolCallStatus,
				rawInput: { command: shownCommand, excludeFromContext },
			});
			let entry: SessionEntry;
			let run: Awaited<ReturnType<typeof runOperatorShellLine>>;
			try {
				run = await runOperatorShellLine({
					command,
					cwd: session.cwd,
					excludeFromContext,
					parentTurnId,
					signal: abort.signal,
					label,
					...(scope.handshake.toolProgressEnabled ? { onUpdate } : {}),
				});
				if (run.unlabeled !== null) options.diagnostics?.(`shell output kept out of context: ${run.unlabeled}`);
				options.beforeShellEntryRecorded?.();
				entry = durable.appendEntry(run.entry);
				// As in the terminal: the entry stays anchored where the line started,
				// and the context is rebuilt from the leaf the session has now.
				const leafTurnId = durable.leafId() ?? parentTurnId;
				resetForSession.call(
					options.chat,
					leafTurnId,
					prepareRestore(session.id, leafTurnId, "leaf", false).replayMessages,
				);
			} catch (err) {
				options.diagnostics?.(`shell line failed: ${acpErrorMessage(err instanceof Error ? err.message : String(err))}`);
				notify({ sessionUpdate: "tool_call_update", toolCallId, title, kind: "execute", status: "failed" });
				throw new AcpRequestError(-32603, "the shell line could not be run or recorded", { code: "shell_failed" });
			}
			const { result } = run;
			const output = shellOutputTail(
				redactFinalUrlCredentials(
					entry.kind === "bashExecution" ? entry.output : run.entry.output,
					!result.aborted && !result.timedOut,
				),
			);
			const settledResult = {
				exitCode: result.exitCode,
				cancelled: result.aborted,
				timedOut: result.timedOut,
				truncated: run.entry.truncated,
				excludedFromContext: run.entry.excludeFromContext === true,
				...(run.unlabeled !== null ? { unlabeled: true } : {}),
			};
			notify({
				sessionUpdate: "tool_call_update",
				toolCallId,
				title,
				kind: "execute",
				status: (result.exitCode === 0 && !result.aborted && !result.timedOut
					? "completed"
					: "failed") satisfies AcpToolCallStatus,
				...(output.length > 0 ? { content: toolCallContent(output) } : {}),
				rawOutput: settledResult,
			});
			return { turnId: entry.turnId, ...settledResult, output, outputBytes: result.outputBytes };
		} finally {
			if (scope.activeShell?.abort === abort) scope.activeShell = null;
			settle();
		}
	});

	options.transport.onRequest("session/close", (params) => {
		guards.requireInitialized();
		const id = sessionIdOf(params);
		// Idempotent: a client tearing down cannot always know whether the server
		// already dropped the session, and a second close is not an error.
		if (!scope.sessions.has(id) && scope.closedSessionIds.has(id)) return {};
		const inFlightClose = scope.closingSessions.get(id);
		if (inFlightClose) return inFlightClose;
		const session = guards.getSession(params);
		const close = (async (): Promise<Record<string, never>> => {
			const aside = scope.asideRound?.sessionId === session.id ? scope.asideRound : null;
			aside?.abort.abort();
			// The prompt writer must settle before the durable session is closed.
			control.cancelSession(session, "session closed");
			if (session.activePrompt) {
				if (scope.promptSettled) await scope.promptSettled;
			}
			if (scope.contextCommandInFlight !== null && session.id === scope.boundSessionId)
				await scope.contextCommandInFlight.catch(() => undefined);
			// The aborted line still appends its entry; the ledger must outlive that write.
			if (scope.activeShell?.sessionId === session.id) await scope.activeShell.settled;
			if (aside !== null) await settleAcpWork([aside.settled]);
			if (options.session?.current()?.id === session.id) {
				await checkpointBeforeClose(options, session.id, "close");
				await options.session.close();
			}
			await options.mcpCapabilities?.detachClientServers();
			scope.sessions.delete(session.id);
			if (scope.boundSessionId === session.id) scope.boundSessionId = null;
			scope.sessionCreated = false;
			scope.closedSessionIds.add(session.id);
			// A reopened fork parent closes as itself, so a later request is no longer told a fork replaced it.
			scope.replacedSessions.delete(session.id);
			return {};
		})();
		scope.closingSessions.set(id, close);
		void close.then(
			() => scope.closingSessions.delete(id),
			() => scope.closingSessions.delete(id),
		);
		return close;
	});

	/** Streams a turn's chat events as frames. A prompt and a scheduled main turn share it, so neither forks the projection. */
	const attachTurnObserver = (sessionId: string, active: ActivePrompt): (() => void) => {
		const onTurnEvent = (event: AcpServerEvent) => {
			handleChatEvent(event, options.transport, sessionId, active, scope.canonicalCwd, options.diagnostics, () => {
				scope.permission.cancelPending("tool call limit exceeded");
				options.toolRegistry?.cancelParkedCalls("tool call limit exceeded");
				options.chat.cancel();
			});
			observeTelemetry(scope.telemetry, event, active);
		};
		const unsubscribeChat = options.chat.onEvent(onTurnEvent);
		const unsubscribeHost = options.hostToolEvents?.onEvent(onTurnEvent);
		return () => {
			unsubscribeChat();
			unsubscribeHost?.();
		};
	};

	/**
	 * A scheduled main turn has no `session/prompt` request to own its frames, its approvals or its
	 * end. The chat loop asks here, synchronously, before it prepares one, and gets the same prompt
	 * state a prompt installs (`ActivePrompt`, the chat observer, the permission binding) or a
	 * deferral it reports back to the job controller. Nothing here runs a turn or answers a request:
	 * the bracket the client sees is `job.changed` with `turn` true from the first frame to the release.
	 * Every check is the same one that refuses a second prompt, so a lease and an operator turn can
	 * never hold the state together, and a release clears only what its own lease installed (#411).
	 */
	const acquireMachineTurn = (request: MachineTurnProjectionRequest): MachineTurnProjectionAdmission => {
		const deferred = (reason: string): MachineTurnProjectionAdmission => ({ status: "deferred", reason });
		const session = scope.boundSessionId === null ? undefined : scope.sessions.get(scope.boundSessionId);
		const jobId = safeStoredIdentifier(request.jobId, ACP_MAX_DISPATCH_ID_BYTES);
		if (!scope.handshake.initialized || session === undefined || jobId === null) {
			return deferred("This ACP connection has no bound session to show a scheduled turn in.");
		}
		if (
			request.sessionId !== session.id ||
			request.cwd !== scope.canonicalCwd ||
			options.session === undefined ||
			options.session.current()?.id !== session.id
		) {
			return deferred("The scheduled turn's session or workspace is not the one this client is bound to.");
		}
		if (request.signal.aborted) return deferred("The occurrence was cancelled before its turn could be shown.");
		if (
			scope.machineLease !== null ||
			session.activePrompt !== null ||
			scope.activePromptState !== null ||
			scope.contextCommandInFlight !== null ||
			scope.activeShell !== null ||
			scope.handoffPreparing ||
			options.chat.isStreaming()
		) {
			return deferred("The conversation is busy; the job keeps its pending delivery.");
		}
		const active = createActivePromptState({ enabled: scope.handshake.toolProgressEnabled, now: scope.now });
		// A queue send-now would resubmit through this lease and strand the successor with no observer.
		active.acceptsContinuation = false;
		const scheduled: NonNullable<ActivePrompt["scheduled"]> = {
			jobId,
			opened: false,
			open: () => {
				scheduled.opened = true;
				events.forwardJobTurn(jobId);
			},
		};
		active.scheduled = scheduled;
		const lease = { jobId, active };
		scope.machineLease = lease;
		session.activePrompt = active;
		scope.activePromptState = active;
		scope.activeSessionId = session.id;
		// A reviewed document describes the conversation as it stood; a scheduled turn moves it too.
		scope.pendingHandoff = null;
		scope.promptSerial++;
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		scope.promptSettled = settled;
		options.onActiveSessionAutonomyChange?.(session.autonomy);
		scope.telemetry.turnStarted(active.turn);
		const detach = attachTurnObserver(session.id, active);
		let released = false;
		return {
			status: "ready",
			release: () => {
				if (released) return;
				released = true;
				active.acceptsContinuation = false;
				detach();
				if (request.signal.aborted) active.cancelled = true;
				flushChunkCredentials(options.transport, session.id, active, false);
				settleOpenToolCalls(
					options.transport,
					session.id,
					active,
					active.permissionExpired ? "permission approval expired" : active.cancelled ? "cancelled" : "turn ended",
				);
				// The last meter frame precedes the bracket that closes the turn; the state stays held until it lands.
				void scope.telemetry
					.turnSettled()
					.catch(() => options.diagnostics?.("a scheduled turn's final telemetry frame failed"))
					.then(() => {
						if (scope.machineLease === lease) scope.machineLease = null;
						if (session.activePrompt === active) session.activePrompt = null;
						if (scope.activePromptState === active) scope.activePromptState = null;
						if (scope.activeSessionId === session.id && scope.activePromptState === null) {
							scope.activeSessionId = null;
							options.onActiveSessionAutonomyChange?.(null);
						}
						if (scope.promptSettled === settled) scope.promptSettled = null;
						if (scheduled.opened) events.forwardJobTurn(jobId);
						settle();
					});
			},
		};
	};
	const unbindMachineTurns = options.chat.bindMachineTurnProjection?.({ acquire: acquireMachineTurn });

	options.transport.onRequest("session/prompt", async (params): Promise<AcpPromptResponse> => {
		guards.requireInitialized();
		const session = guards.getSession(params);
		const promptCeiling = requestCeiling(params, "ACP prompt ceiling");
		assertCeilingEnforceable(options, promptCeiling);
		if (scope.contextCommandInFlight !== null || session.activePrompt || options.chat.isStreaming()) {
			throw new AcpRequestError(-32602, "this session already has an active prompt", { code: "prompt_active" });
		}
		// The line rebuilds the chat's context when it settles, which aborts a
		// run in flight, so a turn waits for it exactly as it waits for a turn.
		if (scope.contextCommandInFlight !== null || scope.activeShell !== null) {
			throw new AcpRequestError(-32602, "a shell line is running; wait for it or cancel it first", {
				code: "shell_active",
			});
		}
		validatePromptBlocks(params);
		const text = promptText(params);
		const resources = promptResources(params);
		if (text.length === 0 && resources.names.length === 0)
			throw new AcpRequestError(-32602, "prompt text is required", { code: "invalid_params" });
		const images = promptImages(params);
		// A line that names an admitted command is invoked below; anything else
		// that looks like one is screened before it can reach the model.
		const typed = /^\/([a-z][a-z0-9_-]*)(?:\s|$)/u.exec(text.trim())?.[1];
		// Before the resume below: a job line for any other session must not move this process's current session first.
		if (typed === "loop" && session.id !== scope.boundSessionId) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		const screened =
			text.length === 0 || (typed !== undefined && commands.availableCommands().some((entry) => entry.name === typed))
				? undefined
				: options.commands?.screenPrompt?.(text);
		if (screened?.kind === "refuse") throw new AcpRequestError(-32602, screened.message, { code: screened.code });
		const sentText = screened?.kind === "send" ? screened.text : text;
		if (images.length > 0 && options.expandPrompt === undefined)
			throw new AcpRequestError(-32602, "this agent does not accept image blocks", { code: "invalid_params" });
		// Check the same credential authority as the runtime, without resolving or
		// echoing a secret. Desktop services do not inherit a terminal's API keys.
		const targetId = routingSnapshot(options).target;
		const target = targetId ? options.providers?.getTarget(targetId) : undefined;
		const runtime = target ? options.providers?.getRuntime(target.runtime) : undefined;
		if (target && runtime && options.providers && !options.providers.auth.statusForTarget(target, runtime).available) {
			throw new AcpRequestError(-32000, "credentials for the selected target are unavailable", {
				code: "prompt_not_admitted",
				reason: "authentication-required",
			});
		}
		if (options.session?.current()?.id !== session.id && options.session) options.session.resume(session.id);
		// A reviewed document describes the conversation as it stood; a new request moves it.
		scope.pendingHandoff = null;
		scope.promptSerial++;
		const active = createActivePromptState({ enabled: scope.handshake.toolProgressEnabled, now: scope.now });
		session.activePrompt = active;
		scope.activePromptState = active;
		scope.activeSessionId = session.id;
		// Transport close waits on this so the session store never stops while the
		// chat loop is still persisting an aborted turn.
		let settle: () => void = () => {};
		scope.promptSettled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		options.onActiveSessionAutonomyChange?.(session.autonomy);
		// Prompt admission also bounds command-injected turns and resubmits,
		// while the session schema ceiling stays fixed (#423).
		const ceilingEcho =
			options.chat.setToolCeiling !== undefined
				? ceilingMeta(guards.applyCeilings([session.ceiling, promptCeiling], "prompt"))
				: undefined;
		const respond = (stopReason: string): AcpPromptResponse =>
			promptResponse(stopReason, active, guards.liveSessionView(), scope.handshake.fullUsageEnabled, ceilingEcho);
		scope.telemetry.turnStarted(active.turn);
		const unsubscribe = attachTurnObserver(session.id, active);
		try {
			// Startup notices are operator advice about the project, not the
			// answer, so they cross as session_info_update metadata the way the
			// memory and eggs state does: a client that ignores `_meta` shows a
			// reply carrying only the model's text. They wait for the first prompt
			// so the client has bound the session id, and they do not count toward
			// admission: a refused prompt must still fail as prompt_not_admitted.
			if (scope.startupHintsSessionId !== session.id) {
				scope.startupHintsSessionId = session.id;
				for (const hint of options.startupHints?.() ?? []) {
					options.transport.notify("session/update", {
						sessionId: session.id,
						update: {
							sessionUpdate: "session_info_update",
							_meta: {
								[ACP_NOTICE_META_KEY]: { level: hint.level, text: safeStoredString(hint.text, ACP_MAX_CHUNK_BYTES) },
							},
						},
					});
				}
			}
			events.runtimeNotices.flush(session.id);
			const trimmed = text.trim();
			const commandMatch = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/u.exec(trimmed);
			const command = commandMatch?.[1];
			if (screened?.kind === "reference") {
				// A display-only template is for the operator: no turn, no session entry, no tokens.
				sendTextChunks(options.transport, session.id, active, "agent_message_chunk", screened.lines.join("\n"));
				active.sawTurnEnd = true;
			} else if (screened?.kind === "extension") {
				// The extension's runtime answers, as in the terminal: no turn, no tokens (WTF-P F04).
				const abort = new AbortController();
				active.expansionAbort = abort;
				if (active.cancelled) abort.abort();
				try {
					const answer = await screened.run(abort.signal);
					if (!active.cancelled)
						sendTextChunks(
							options.transport,
							session.id,
							active,
							"agent_message_chunk",
							answer.ok ? answer.text : answer.message,
						);
				} finally {
					delete active.expansionAbort;
				}
				active.sawTurnEnd = true;
			} else if (
				command !== undefined &&
				resources.names.length === 0 &&
				commands.availableCommands().some((entry) => entry.name === command)
			) {
				let argv = commandMatch?.[2]?.trim().split(/\s+/u) ?? [];
				if (command === "loop") {
					// A whitespace split would cut a quoted task or program argument into words and keep the quotes.
					const words = tokenizeLoopLine(commandMatch?.[2] ?? "");
					if ("error" in words) throw new AcpRequestError(-32602, words.error, { code: "invalid_params" });
					argv = words.tokens;
				}
				if (options.commands !== undefined) guards.assertCommandWithinCeiling(options.commands, command, argv);
				const noticed = new Set<string>();
				active.commandNoticeLines = noticed;
				let result: Awaited<ReturnType<NonNullable<typeof options.commands>["invoke"]>> | undefined;
				try {
					result = await options.commands?.invoke({
						command,
						argv,
						askConsent: reportConsentAsk(options.transport, session.id),
					});
					if (options.commands?.injectsUserTurn(command, argv)) await options.chat.whenSettled?.();
				} finally {
					active.commandNoticeLines = null;
				}
				// A notice the command raised already went out as reply text; the result does not say it again.
				const unsent = result === undefined ? [] : result.lines.filter((line) => !noticed.has(line.trimEnd()));
				if (unsent.length > 0)
					sendTextChunks(
						options.transport,
						session.id,
						active,
						"agent_message_chunk",
						`${active.sentAssistantChars > 0 ? "\n\n" : ""}${unsent.join("\n")}`,
					);
				if (result?.level === "error" && options.commands?.injectsUserTurn(command, argv)) {
					active.errored = true;
					active.errorMessage = result.lines.join("\n");
				}
				active.sawTurnEnd = true;
			} else if (options.chat.discoverOperatorEgg && (await options.chat.discoverOperatorEgg(promptText(params, false)))) {
				active.sawTurnEnd = true;
			} else if (options.expandPrompt === undefined) {
				await options.chat.submit(
					withResources(sentText, resources),
					resources.names.length > 0
						? {
								display: { text: sentText, note: attachedNote(resources.names) },
								...(resources.paths.length > 0 ? { workingContextPaths: resources.paths } : {}),
							}
						: undefined,
				);
			} else {
				let expansion: AcpPromptExpansion | undefined;
				const expansionAbort = new AbortController();
				active.expansionAbort = expansionAbort;
				// A cancel that landed while the egg discovery above awaited has no controller to reach yet.
				if (active.cancelled) expansionAbort.abort();
				try {
					expansion = await options.expandPrompt(sentText, images, expansionAbort.signal);
				} catch (err) {
					// A cancel during expansion is the operator's, not a bad prompt: the
					// response below reports it cancelled and nothing reaches the chat.
					if (!active.cancelled)
						throw new AcpRequestError(-32602, err instanceof Error ? err.message : String(err), {
							code: "invalid_params",
						});
				} finally {
					delete active.expansionAbort;
				}
				if (expansion !== undefined && !active.cancelled) {
					// The transcript paints what the operator typed and names attached files, not their bodies. The typed
					// text is also what the record keeps as the operator's words, so a file attached alone is none.
					if (resources.names.length > 0) {
						const attached = attachedNote(resources.names);
						expansion = {
							...expansion,
							text: withResources(expansion.text, resources),
							workingContextPaths: [...expansion.workingContextPaths, ...resources.paths],
							display: {
								text: expansion.display?.text ?? sentText,
								note: expansion.display?.note ? `${expansion.display.note}; ${attached}` : attached,
							},
						};
					}
					await options.chat.submit(expansion.text, {
						...(expansion.images.length > 0 ? { images: expansion.images } : {}),
						...(expansion.workingContextPaths.length > 0 ? { workingContextPaths: expansion.workingContextPaths } : {}),
						...(expansion.pendingSkillRequests.length > 0 ? { pendingSkillRequests: expansion.pendingSkillRequests } : {}),
						...(expansion.display ? { display: expansion.display } : {}),
						...(expansion.constraints ? { constraints: expansion.constraints } : {}),
					});
				}
			}
			// A queue send-now interrupted the run this request started and
			// resubmitted the entry. This request carries that run to its end, so
			// it is never a turn with no request to report its stop reason on.
			while (active.continuation !== null) {
				const next = active.continuation;
				active.continuation = null;
				await next;
			}
			// A triage stop interrupts the run the same way and starts its delivery itself; this request carries it too (bt-41).
			await options.chat.whenSettled?.();
		} catch (err) {
			if (err instanceof AcpRequestError) throw err;
			active.errored = true;
			active.errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			if (promptCeiling !== undefined) guards.applyCeilings([session.ceiling], "prompt");
			active.acceptsContinuation = false;
			unsubscribe();
			// The last meter and plan frames precede the response they total, and the response repeats their usage.
			active.settledUsage = await scope.telemetry.turnSettled();
			if (session.activePrompt === active) session.activePrompt = null;
			if (scope.activePromptState === active) scope.activePromptState = null;
			if (scope.activeSessionId === session.id) {
				// The turn's closing frame follows its last update and reads the window while the session still holds it.
				const closing = readoutFeed.readoutsSession(session.id);
				if (closing !== null) readoutFeed.readouts.turnEnd(closing);
				scope.activeSessionId = null;
				options.onActiveSessionAutonomyChange?.(null);
			}
			scope.promptSettled = null;
			settle();
		}
		// Expiry is not a delayed denial or an operator cancellation. It aborts
		// the run and fails the prompt so the model cannot react to/retry it.
		if (active.permissionExpired) {
			settleOpenToolCalls(options.transport, session.id, active, "permission approval expired");
			throw new AcpRequestError(-32800, "permission approval expired", { code: "permission_expired" });
		}
		// W001-A1: a peer that holds bounded per-turn state must never see a
		// 129th tool start. This is a normal ACP agent-side request ceiling, not a
		// provider failure or an operator cancellation.
		if (active.toolCallLimitReached) {
			settleOpenToolCalls(options.transport, session.id, active, "tool call limit exceeded");
			return respond("max_turn_requests");
		}
		// Operator cancellation takes precedence over ordinary turn outcomes.
		if (active.cancelled) {
			settleOpenToolCalls(options.transport, session.id, active, "cancelled");
			return respond("cancelled");
		}
		// The empty-success defect: PanCode refused to start the turn, the notice
		// carrying the reason has no ACP equivalent, and nothing else in the turn
		// distinguishes the refusal from a model that chose to say nothing. The
		// reason travels as a code; the notice text carries the settings path and
		// stays off the wire.
		if (active.admissionReason !== undefined && !active.sawTurnEnd && active.updatesSent === 0) {
			throw new AcpRequestError(
				active.admissionReason === "authentication-required" ? -32000 : -32603,
				`PanCode could not admit this prompt: ${active.admissionReason}`,
				{
					code: "prompt_not_admitted",
					reason: active.admissionReason,
				},
			);
		}
		// ACP has no error StopReason: a failed turn is signalled by failing the
		// session/prompt request itself.
		if (active.errored) {
			settleOpenToolCalls(options.transport, session.id, active, "turn failed");
			// Provider prose never reaches the wire. Bounding it was not enough: a
			// provider error body legitimately quotes a request URL, a filesystem
			// path, or the credential it was rejected for, and a bounded copy of a
			// secret is still the secret. The client gets host-authored text plus
			// the `turn_failed` code; the original goes to the stderr tail.
			if (active.errorMessage !== undefined) {
				options.diagnostics?.(`turn failed: ${acpErrorMessage(active.errorMessage)}`);
			}
			// A missing runtime component is the host's own refusal, so its id and remedy may cross (gui-verify 2).
			const component = missingRuntimeComponent(active.errorMessage);
			throw new AcpRequestError(-32603, ACP_TURN_FAILED_MESSAGE, {
				code: "turn_failed",
				...(component !== null ? { reason: "component-missing", component } : {}),
			});
		}
		return respond(active.stopReason);
	});

	// Pushed only after initialize, and only for sessions this server holds; the model coalesces to 10 Hz (#434).
	const unsubscribeTelemetryUpdates = options.telemetryReadModel
		? subscribeTelemetryUpdates(
				options.telemetryReadModel,
				(sessionId) => scope.handshake.initialized && scope.sessions.has(sessionId),
				(update) => options.transport.notify(ACP_TELEMETRY_UPDATE_NOTIFICATION, update),
			)
		: undefined;
	const detachInterviews = options.interviews?.attach({
		transport: options.transport,
		sessionId: () => scope.activeSessionId ?? scope.boundSessionId,
		enabled: () => scope.handshake.initialized && scope.handshake.interviewsEnabled,
		timeoutMs: interviewWindowMs,
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
	});
	const detachElicitation = options.elicitation?.attach({
		transport: options.transport,
		sessionId: () => scope.activeSessionId ?? scope.boundSessionId,
		enabled: () => scope.handshake.initialized && scope.handshake.elicitationEnabled,
		timeoutMs: () => scope.handshake.elicitationTimeoutMs ?? permissionTimeoutMs,
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
	});
	options.onReady?.();
	return await new Promise<number>((resolve) => {
		options.transport.onClose(() => {
			scope.telemetry.dispose();
			unsubscribeTelemetryUpdates?.();
			detachInterviews?.();
			detachElicitation?.();
			// Unbound first: a scheduled turn must be refused, never run where no client can see it.
			unbindMachineTurns?.();
			scope.permission.unregister();
			events.unsubscribeEventStream();
			scope.permission.cancelPending("ACP transport closed");
			readoutFeed.unsubscribeQueueEvents();
			readoutFeed.unsubscribeReadouts();
			readoutFeed.unsubscribeAdmission();
			readoutFeed.unsubscribeToolBodyStart();
			control.unsubscribePromptCancel();
			control.unsubscribeShellCancel();
			const aside = scope.asideRound;
			aside?.abort.abort();
			for (const session of scope.sessions.values()) control.cancelSession(session, "ACP transport closed");
			const settling = [
				scope.promptSettled,
				scope.activeShell?.settled ?? null,
				scope.contextCommandInFlight,
				aside?.settled ?? null,
			].filter((pending): pending is Promise<unknown> => pending !== null);
			// Accepted out-of-turn work owns its finalization just as a prompt does.
			void settleAcpWork(settling).then(() => resolve(0));
		});
	});
}

/** PromptResponse is `{ stopReason, _meta? }`; usage is not an ACP v1 field. */
function promptResponse(
	stopReason: string,
	active: ActivePrompt,
	session: TelemetryView | null,
	fullUsage: boolean,
	ceiling?: Record<string, unknown>,
): AcpPromptResponse {
	// The settled block is the final usage_update's snapshot; only a prompt that never settled reads live.
	const usage = active.settledUsage ?? {
		...turnUsageMeta(session, active.turn),
		...(session ? { session: sessionUsageTotals(session) } : {}),
	};
	return {
		stopReason,
		_meta: {
			...ceiling,
			[ACP_USAGE_META_KEY]: fullUsage ? usage : compactUsage(usage),
			[ACP_TURN_META_KEY]: {
				...(active.model ? { model: active.model } : {}),
				...(active.target ? { target: active.target } : {}),
				...(active.ttftMs !== undefined ? { ttftMs: active.ttftMs } : {}),
				// A rate over less than RATE_MIN_WINDOW_MS of generation measured the delivery, not the model, so it is left out.
				...(active.generationMs !== undefined && active.generationMs >= RATE_MIN_WINDOW_MS && active.timedOutputTokens
					? { outputTokensPerSecond: active.timedOutputTokens / (active.generationMs / 1000) }
					: {}),
			},
		},
	};
}
