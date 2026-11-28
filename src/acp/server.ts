// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { BashCommandProgress } from "../core/bash-exec.js";
import { combineLiveBashOutput } from "../core/bash-exec.js";
import type { ContextOperationStatus } from "../core/context-operation.js";
import {
	ACP_CONTEXT_STATUS_METHOD,
	CONTEXT_OPERATION_CUSTOM_TYPE,
	readContextOperation,
} from "../core/context-operation.js";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../core/defaults.js";
import { readDispatchScopeNotice } from "../core/dispatch-scope-notice.js";
import type { JobRecord } from "../core/job-types.js";
import type {
	BudgetAlertPayload,
	CompactionPayload,
	ContextActivityPayload,
	ContextWarningPayload,
	DispatchCompletedPayload,
	DispatchEnqueuedPayload,
	DispatchFailedPayload,
	DispatchProgressPayload,
	DispatchStartedPayload,
	EvidenceAssessedPayload,
	LoopBlockedPayload,
	ProviderHealthPayload,
	ToolBudgetExceededPayload,
} from "../core/telemetry/live-events.js";
import { MAX_TIMER_DELAY_MS } from "../core/timers.js";
import { ToolNames } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { narrowTurnConstraints, snapshotTurnConstraints, turnAllowsTool } from "../core/turn-constraints.js";
import { isRecord } from "../core/type-guards.js";
import type { ThinkingLevel } from "../core/views/thinking-levels.js";
import { missingRuntimeComponent } from "../domains/install/components.js";
import { PROVIDER_PROBE_TIMEOUT_MS } from "../domains/providers/contract.js";
import { resolveRuntimeTarget } from "../domains/providers/runtime-resolution.js";
import { jobIsComplete } from "../domains/scheduling/index.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { liveSessionOwner } from "../domains/session/live-owner.js";
import { runOperatorShellLine } from "../domains/session/operator-shell.js";
import { resumedSessionRoute } from "../domains/session/resumed-route.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { AgentMessage } from "../engine/types.js";
import type { AutonomyLevel } from "../lib/autonomy/autonomy.js";
import { DEFAULT_AUTONOMY_LEVEL, isAutonomyLevel } from "../lib/autonomy/autonomy.js";
import {
	redactFinalUrlCredentials,
	redactStreamingUrlCredentials,
	redactUrlCredentials,
} from "../lib/secrets/redaction.js";
import { RATE_MIN_WINDOW_MS } from "../session-control/assistant-generation-timing.js";
import {
	clampThinkingLevel,
	replayCurrentSession,
	restoreSession as restoreControlledSession,
	selectModel,
} from "../session-control/index.js";
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
import { budgetBlockFrame } from "./budget-notice.js";
import type { AcpCommandCatalog, AcpCommandControl } from "./commands.js";
import { ACP_CONTEXT_LEDGER_METHOD, ACP_CONTEXT_META_KEY, projectContextLedger } from "./context-ledger.js";
import { ACP_SESSION_LIMIT_CODE, ACP_TURN_FAILED_MESSAGE, AcpRequestError, acpErrorMessage } from "./errors.js";
import {
	ACP_EXTENSIONS_LIST_METHOD,
	ACP_EXTENSIONS_RELOAD_METHOD,
	ACP_HUB_RELOAD_METHOD,
	projectExtensionReload,
	projectExtensions,
} from "./extensions.js";
import type { AcpFleetControl } from "./fleet-run.js";
import {
	ACP_FLEET_MAX_REASON_BYTES,
	ACP_FLEET_PREVIEW_METHOD,
	ACP_FLEET_RUN_METHOD,
	projectFleetPreview,
} from "./fleet-run.js";
import type { AcpLiveTelemetry } from "./live-telemetry.js";
import {
	ACP_WORKSPACE_META_KEY,
	compactUsage,
	createAcpLiveTelemetry,
	sessionUsageTotals,
	turnUsageMeta,
} from "./live-telemetry.js";
import type { AcpReadoutsSession } from "./readouts.js";
import { createAcpReadoutsEmitter } from "./readouts.js";
import { ACP_MAX_JOBS } from "./runtime.js";
import { createAcpRuntimeNoticeRelay, subscribeAcpNotices } from "./runtime-notice.js";
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
import {
	ACP_MAX_DISPATCH_ID_BYTES,
	ACP_MAX_DISPATCH_PROGRESS_EVENTS,
	ACP_MAX_EVENT_TEXT_BYTES,
	ACP_MAX_EVIDENCE_TAG_BYTES,
	ACP_MAX_EVIDENCE_TAGS,
	ACP_MAX_SCOPE_NOTICE_BYTES,
	type DispatchRunTrack,
	dispatchIdentity,
	jobEventPayload,
	lifecycleFrame,
	readResult,
	replayDispatchTerminals,
	runResultMeta,
	runTokenCoverage,
	safeCount,
	trackDispatchRun,
} from "./server-event-frames.js";
import { compileFleet, fleetName, fleetResume, fleetVars, requireFleet } from "./server-fleet.js";
import { assertNoAdditionalDirectories, createAcpHandshake, parseClientMcpServers } from "./server-handshake.js";
import type { AcpSafeTargetProjection } from "./server-models.js";
import {
	ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES,
	ACP_MAX_SESSION_LIST_RESULT_BYTES,
	ACP_MAX_TARGET_LIST_RESULT_BYTES,
	ACP_THINKING_LEVEL_SET,
	configOptions,
	listedLive,
	modelNotDeclared,
	modelSelectionErrorText,
	modelsResultMeta,
	probeMissingComponent,
	safeProbeReason,
	safeSettingsProjection,
	safeTargetProjection,
	sessionConfig,
	sessionThinking,
	targetModelCandidates,
} from "./server-models.js";
import type {
	AcpBoardActions,
	AcpForwardableEventKind,
	AcpHandoffControl,
	AcpHandoffDraft,
	AcpPromptExpansion,
	AcpQueuedEntryKind,
	AcpRoutingSnapshot,
	AcpServerEvent,
	PancodeAcpServerOptions,
} from "./server-options.js";
import { branchesWired, handoffWired, queueEditWired, shellWired } from "./server-options.js";
import { installPermissionBridge } from "./server-permissions.js";
import {
	attachedNote,
	ceilingBinds,
	ceilingMeta,
	promptImages,
	promptResources,
	promptText,
	requestCeiling,
	validatePromptBlocks,
	withResources,
} from "./server-prompt-input.js";
import type { PreparedAcpReplay } from "./server-replay.js";
import { prepareAcpReplay, sessionResultMeta, withReplayUsage } from "./server-replay.js";
import type { AcpQueueEditOp, AcpSteeringMode } from "./server-session-input.js";
import {
	ACP_MAX_INTERRUPT_REASON_BYTES,
	ACP_MAX_QUEUE_ENTRY_ID_BYTES,
	ACP_MAX_RESTORED_MESSAGES,
	ACP_MAX_STEER_TEXT_BYTES,
	ACP_QUEUE_EDIT_OPS,
	ACP_STEERING_MODES,
	boundedQueueTexts,
	dispatchSteerReason,
	projectQueueEntries,
	requireShellCommand,
	requireSteerText,
	restorableWhole,
	shellOutputTail,
} from "./server-session-input.js";
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
	ACP_MAX_LIVE_TOOL_CALLS,
	ACP_MAX_TOOL_CALL_AGENTS,
	ACP_MAX_TOOL_TITLE_BYTES,
	createActivePromptState,
	eventRecord,
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
	toolCallUpdateMeta,
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
	ACP_DISPATCH_STEER_METHOD,
	ACP_EGGS_META_KEY,
	ACP_EVENT_NOTIFICATION,
	ACP_HANDOFF_CANCEL_METHOD,
	ACP_HANDOFF_COMMIT_METHOD,
	ACP_HANDOFF_PREPARE_METHOD,
	ACP_JOBS_LIST_METHOD,
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_MAX_TARGETS,
	ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
	ACP_MEMORY_META_KEY,
	ACP_MEMORY_PROPOSE_METHOD,
	ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
	ACP_NOTICE_META_KEY,
	ACP_PERMISSION_WITHDRAW_METHOD,
	ACP_QUEUE_CHANGED_NOTIFICATION,
	ACP_QUEUE_EDIT_METHOD,
	ACP_SESSION_CANCEL_METHOD,
	ACP_SESSION_INTERRUPT_METHOD,
	ACP_SESSION_LABEL_METHOD,
	ACP_SESSION_LIST_METHOD,
	ACP_SESSION_META_KEY,
	ACP_SESSION_QUEUE_CLEAR_METHOD,
	ACP_SESSION_QUEUE_METHOD,
	ACP_SESSION_SET_MODEL_METHOD,
	ACP_SESSION_SHELL_METHOD,
	ACP_SESSION_STEER_METHOD,
	ACP_SESSION_TRUST_METHOD,
	ACP_SETTINGS_GET_SAFE_METHOD,
	ACP_SETTINGS_PATCH_SAFE_METHOD,
	ACP_SHELL_META_KEY,
	ACP_SNAPSHOT_PREVIEW_METHOD,
	ACP_SNAPSHOT_RESTORE_METHOD,
	ACP_SNAPSHOTS_LIST_METHOD,
	ACP_TARGETS_LIST_METHOD,
	ACP_TARGETS_PROBE_METHOD,
	ACP_TRUNCATED_META_KEY,
	ACP_TURN_META_KEY,
	ACP_USAGE_META_KEY,
} from "./types.js";
import type { AcpJob } from "./types-fleet.js";
import type { AcpAdmissionMeta } from "./types-readouts.js";
import { ACP_ADMISSION_META_KEY, ACP_READOUTS_NOTIFICATION } from "./types-readouts.js";
import type {
	AcpDecisionSupersedeResult,
	AcpHandoffCancelResult,
	AcpHandoffCommitResult,
	AcpHandoffPrepareResult,
	AcpInterruptResult,
	AcpMemoryProposeResult,
	AcpQueueClearResult,
	AcpQueueEditResult,
	AcpQueueResult,
	AcpSessionList,
	AcpSessionListRow,
	AcpShellResult,
	AcpSnapshotList,
	AcpSnapshotOutcome,
	AcpSnapshotPlan,
	AcpSteerResult,
} from "./types-session.js";
import { ACP_SNAPSHOT_LIST_MAX } from "./types-session.js";
import type { AcpSafeSettingsPatch, AcpTargetList, AcpTargetProbe } from "./types-settings.js";
import { ACP_SAFE_SETTINGS_KEYS } from "./types-settings.js";

const ACP_MAX_SESSION_ID_BYTES = 128;
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

export async function servePancodeAcpAgent(options: PancodeAcpServerOptions): Promise<number> {
	const sessions = new Map<string, AcpServerSession>();
	const handshake =
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
		});
	const workspaceInstanceId = handshake.workspaceInstanceId;
	const now = options.now ?? Date.now;
	let eventSequence = 0;
	/**
	 * Per-run progress counters for the forwarded dispatch stream, insertion
	 * ordered. A terminal event removes its run; the cap evicts the oldest live
	 * run rather than refusing the newest, so a leaked run cannot starve the
	 * board of the run an operator is actually watching.
	 */
	const dispatchProgress = new Map<string, DispatchRunTrack>();
	let activeSessionId: string | null = null;
	/**
	 * The one session this process hosts, from the moment it is bound until it is
	 * closed. Distinct from {@link activeSessionId}, which is only set while a
	 * prompt is running: a detached dispatch run legitimately finishes after the
	 * turn that started it, and a client keyed on the bound session still needs
	 * that outcome so its board does not leave the run running forever.
	 */
	let boundSessionId: string | null = null;
	/** The read model's live view of the bound session; null while it holds another session or is still seeding. */
	const liveSessionView = (): TelemetryView | null => {
		const view = options.telemetryReadModel?.live() ?? null;
		return view !== null && !view.seeding && view.sessionId === boundSessionId ? view : null;
	};
	let activePromptState: ActivePrompt | null = null;
	/**
	 * The prompt state a scheduled main turn holds while it runs. Token-owned: only the lease's own
	 * release clears it, and only while it is still the holder, so a stale release never touches a
	 * successor turn (#411).
	 */
	let machineLease: { readonly jobId: string; readonly active: ActivePrompt } | null = null;
	/** The newest record seen per job, so a turn bracket reuses the controller's own figures. Bounded. */
	const lastJobs = new Map<string, JobRecord>();
	let sessionCreated = false;
	let sessionSlotReserved = false;
	const withSessionSlot = async <T>(bind: () => Promise<T>): Promise<T> => {
		// A close in flight frees the slot when it settles, and a client may send its next open without awaiting it.
		if (closingSessions.size > 0) await Promise.allSettled([...closingSessions.values()]);
		if (sessionCreated || sessionSlotReserved) {
			const hosted = boundSessionId === null ? "" : `; close ${boundSessionId} first`;
			throw new AcpRequestError(ACP_SESSION_LIMIT_CODE, `this server hosts one session per process${hosted}`, {
				code: "session_limit",
			});
		}
		sessionSlotReserved = true;
		try {
			return await bind();
		} finally {
			sessionSlotReserved = false;
		}
	};
	/** The one document awaiting review, keyed by the id its client holds. */
	let pendingHandoff: { handoffId: string; sessionId: string; draft: AcpHandoffDraft } | null = null;
	let handoffPreparing = false;
	/** Counts prompts, so a draft drawn while a request started is known to be stale. */
	let promptSerial = 0;
	/** The session the startup notices went to; a load of a session that already took a prompt counts as shown. */
	let startupHintsSessionId: string | null = null;
	let promptSettled: Promise<void> | null = null;
	/** The one operator shell line this process runs at a time, as the terminal runs one. */
	let activeShell: { sessionId: string; abort: AbortController; settled: Promise<void> } | null = null;
	const closedSessionIds = new Set<string>();
	/** A forked parent's id, mapped to the child that took its place in this process. */
	const replacedSessions = new Map<string, string>();
	const closingSessions = new Map<string, Promise<Record<string, never>>>();
	// The launch cwd is the process's one workspace identity: settings, project
	// context, and the session ledger were all resolved against it during boot.
	// It is canonicalized once here so a client that passes a symlinked path, a
	// trailing slash, or a `/.` suffix is recognised rather than refused.
	let contextActivity: ContextActivityPayload | null = null;
	let contextCommandInFlight: Promise<unknown> | null = null;
	const canonicalCwd = realpathSync(options.cwd ?? process.cwd());
	const permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS;
	const telemetry: AcpLiveTelemetry = createAcpLiveTelemetry({
		notify: (sessionId, update) => options.transport.notify("session/update", { sessionId, update }),
		sessionId: () => boundSessionId,
		cwd: canonicalCwd,
		...(options.contextLedger !== undefined ? { contextLedger: options.contextLedger } : {}),
		...(options.telemetryReadModel
			? {
					sessionTelemetry: () => liveSessionView(),
					subscribeUsage: (listener: () => void) => options.telemetryReadModel?.subscribe("session", listener) ?? (() => {}),
				}
			: {}),
		...(options.plan !== undefined ? { plan: options.plan } : {}),
		...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
		fullUsage: () => handshake.fullUsageEnabled,
	});
	const workspaceResultMeta = async (): Promise<Record<string, unknown>> => {
		const view = await telemetry.workspace();
		return view === null ? {} : { [ACP_WORKSPACE_META_KEY]: view };
	};
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
	const permissionWindowMs = (): number => handshake.permissionRequestTimeoutMs ?? permissionTimeoutMs;
	const interviewWindowMs = (): number => handshake.interviewTimeoutMs ?? permissionTimeoutMs;
	const permission = installPermissionBridge({
		transport: options.transport,
		toolRegistry: options.toolRegistry,
		...(options.bus ? { bus: options.bus } : {}),
		activeSessionId: () => activeSessionId,
		resolveToolCallId: (engineToolCallId) =>
			activePromptState === null ? null : openWireIdFor(activePromptState, engineToolCallId),
		soleOpenToolCallId: () => {
			if (activePromptState === null || activePromptState.openToolCalls.size !== 1) return null;
			const [only] = activePromptState.openToolCalls;
			return only ?? null;
		},
		toolCallSnapshot: (wireId) =>
			activePromptState === null ? null : (activePromptState.toolCallSnapshots.get(wireId) ?? null),
		permissionTimeoutMs: permissionWindowMs,
		clientSurface: () => handshake.clientSurface,
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
		...(options.session !== undefined ? { session: options.session } : {}),
		workerAskNotice: (sessionId, text) => {
			const active = activePromptState;
			// Outside a turn there is no message to attach it to; the run's own outcome still says it.
			if (active === null || activeSessionId !== sessionId) {
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
						enabled: () => handshake.initialized && handshake.workerPermissionsEnabled,
						resolve: options.workerPermissions.resolve,
						bindToolCall: (runId: string) => {
							const active = activePromptState;
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
			if (activePromptState === null) return;
			activePromptState.permissionExpired = true;
			options.chat.cancel();
		},
		cancelActivePrompt: (reason) => {
			const session = activeSessionId === null ? undefined : sessions.get(activeSessionId);
			if (session) cancelSession(session, reason);
		},
	});
	/**
	 * Sends one frame of the opt-in stream. Every forwarded channel goes through
	 * here so the envelope, the sequence, and the opt-in check cannot drift per
	 * channel. Nothing is sent before a session exists: the envelope's
	 * `sessionId` is the client's only way to bind a fact to what it is showing.
	 */
	const forwardEvent = (
		kind: AcpForwardableEventKind,
		turnId: string | null,
		terminal: boolean,
		payload: Record<string, unknown>,
		meta?: Record<string, unknown>,
	): void => {
		const sessionId = activeSessionId ?? boundSessionId;
		if (!handshake.initialized || !handshake.enabledEventKinds.has(kind) || sessionId === null) return;
		eventSequence += 1;
		try {
			options.transport.notify(ACP_EVENT_NOTIFICATION, {
				version: 1,
				workspaceInstanceId,
				sessionId,
				turnId,
				sequence: eventSequence,
				kind,
				terminal,
				payload,
				...(meta !== undefined ? { _meta: meta } : {}),
			});
		} catch {
			options.diagnostics?.("failed to send an opted-in ACP event");
		}
	};

	const unsubscribeEvents: Array<() => void> = [];
	// Runtime notices cross as session metadata like startup hints, never on stderr, which a client keeps only as a crash tail.
	const runtimeNotices = createAcpRuntimeNoticeRelay((sessionId, notice) =>
		options.transport.notify("session/update", {
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				_meta: { [ACP_NOTICE_META_KEY]: { ...notice, text: safeStoredString(notice.text, ACP_MAX_CHUNK_BYTES) } },
			},
		}),
	);
	if (options.bus !== undefined) {
		const bus = options.bus;
		const noticeSession = () => (handshake.initialized ? (activeSessionId ?? boundSessionId) : null);
		const sessionMeta = (owner: string | null, meta: Record<string, unknown>) => {
			const sessionId = noticeSession();
			if (sessionId === null || owner !== sessionId) return;
			options.transport.notify("session/update", {
				sessionId,
				update: { sessionUpdate: "session_info_update", _meta: meta },
			});
		};
		unsubscribeEvents.push(
			bus.subscribe("context.pruned", () => telemetry.contextFolded()),
			subscribeAcpNotices(bus, runtimeNotices, noticeSession, (sessionId) => announceCommands(sessionId)),
			bus.subscribe("session.eggs_changed", (event) =>
				sessionMeta(event.sessionId, { [ACP_EGGS_META_KEY]: event.active }),
			),
			bus.subscribe("memory.guardian_changed", (event) =>
				sessionMeta(event.sessionId, { [ACP_MEMORY_META_KEY]: { state: event.state } }),
			),
			bus.subscribe("budget.alerted", (payload: BudgetAlertPayload) => {
				// The stop parks the request inside the running prompt, so it crosses
				// as that prompt's notice chunk, figures beside the text (#424). Between
				// prompts nothing is parked and the alert has no turn to belong to.
				const active = activePromptState;
				const sessionId = activeSessionId ?? boundSessionId;
				if (active === null || active.cancelled || sessionId === null) return;
				const frame = budgetBlockFrame(payload);
				if (frame === null) return;
				sendUpdate(options.transport, sessionId, active, frame.update, { ...ORCHESTRATOR_UPDATE_META, ...frame.meta });
			}),
			bus.subscribe("turn.aborted", (payload) => {
				const active = activePromptState;
				if (active !== null && !active.cancelled && payload.source === "loop_guard") active.guardStopped = true;
			}),
			bus.subscribe("safety.loop_blocked", (payload: LoopBlockedPayload) => {
				// Loop blocks describe the turn that is running, so unlike a dispatch
				// run they are meaningless outside one.
				if (activePromptState === null) return;
				if (
					!Number.isSafeInteger(payload.repeatCount) ||
					payload.repeatCount < 1 ||
					!Number.isSafeInteger(payload.blocksThisTurn) ||
					payload.blocksThisTurn < 1 ||
					!Number.isSafeInteger(payload.budget) ||
					payload.budget < 1 ||
					!(["block", "lockout", "stop"] as ReadonlyArray<string>).includes(payload.disposition) ||
					payload.interrupted !== (payload.disposition === "stop")
				) {
					return;
				}
				const tool = safeStoredString(payload.tool, 64).trim();
				if (tool.length === 0) return;
				forwardEvent("safety.loop_blocked", safeStoredIdentifier(payload.turnId, ACP_MAX_SESSION_ID_BYTES), false, {
					toolCallId: null,
					tool,
					repeatCount: payload.repeatCount,
					blocksThisTurn: payload.blocksThisTurn,
					budget: payload.budget,
					disposition: payload.disposition,
					interrupted: payload.interrupted,
					shape: null,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.enqueued", (payload: DispatchEnqueuedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null || !trackDispatchRun(dispatchProgress, lifecycleFrame("enqueued", identity.runId))) return;
				forwardEvent("run.enqueued", null, false, {
					...identity,
					origin: safeStoredIdentifier(payload.requestOrigin, 64),
					attempt: null,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.started", (payload: DispatchStartedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null || !trackDispatchRun(dispatchProgress, lifecycleFrame("started", identity.runId))) return;
				// A run started by a tool call this turn already put on the wire is
				// the one place the harness knows which agent produced a tool
				// segment. Record it and re-announce the call so a client can label
				// the segment while the worker is still running.
				attributeRunToToolCall(payload.parentToolCallId, identity);
				forwardEvent("run.started", null, false, {
					...identity,
					origin: safeStoredIdentifier(payload.requestOrigin, 64),
					attempt: safeCount(payload.attempt),
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.progressed", (payload: DispatchProgressPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				const state = trackDispatchRun(dispatchProgress, lifecycleFrame("progressed", identity.runId));
				if (state === null || state.capped) return;
				state.count += 1;
				const capped = state.count > ACP_MAX_DISPATCH_PROGRESS_EVENTS;
				if (capped) state.capped = true;
				// The worker/ACP event that triggered this crossed a process boundary
				// and is typed `unknown`; none of it goes on the wire. What a board
				// needs is that the run is alive and roughly how much it has done.
				forwardEvent("run.progressed", null, false, {
					runId: identity.runId,
					agentId: identity.agentId,
					progressCount: state.count,
					truncated: capped,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.completed", (payload: DispatchCompletedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				trackDispatchRun(dispatchProgress, lifecycleFrame("ended", identity.runId, payload.outcome));
				forwardEvent(
					"run.completed",
					null,
					true,
					{
						runId: identity.runId,
						agentId: identity.agentId,
						outcome: safeStoredIdentifier(payload.outcome, 64),
						outcomeCode: safeStoredIdentifier(payload.outcomeCode, 64),
						outcomeDetail: safeStoredString(payload.outcomeDetail, 2048) || null,
						durationMs: safeCount(payload.durationMs),
						...runTokenCoverage(payload.spend),
					},
					runResultMeta(identity.runId, readResult(identity.runId, false)),
				);
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.failed", (payload: DispatchFailedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				trackDispatchRun(dispatchProgress, lifecycleFrame("ended", identity.runId, payload.outcome));
				forwardEvent(
					"run.failed",
					null,
					true,
					{
						runId: identity.runId,
						agentId: identity.agentId,
						outcome: safeStoredIdentifier(payload.outcome, 64),
						reason: safeStoredIdentifier(payload.reason, 64),
						outcomeCode: safeStoredIdentifier(payload.outcomeCode, 64),
						outcomeDetail: safeStoredString(payload.outcomeDetail, 2048) || null,
						durationMs: safeCount(payload.durationMs),
						...(payload.spend ? runTokenCoverage(payload.spend) : {}),
					},
					runResultMeta(identity.runId, readResult(identity.runId, false)),
				);
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("evidence.assessed", (payload: EvidenceAssessedPayload) => {
				// The run's journal owner assesses it before sealing, so this arrives ahead of the run's
				// run.completed or run.failed and is not terminal (#434). Only the summary counters cross;
				// the finding prose stays in the run scope, and the tags are filtered to bounded identifiers
				// rather than truncated into new ones.
				const runId = safeStoredIdentifier(payload.runId, ACP_MAX_DISPATCH_ID_BYTES);
				if (runId === null) return;
				const findings = Array.isArray(payload.findings) ? payload.findings : [];
				const tags = [...new Set(findings.map((finding) => finding.tag))]
					.map((tag) => safeStoredIdentifier(tag, ACP_MAX_EVIDENCE_TAG_BYTES))
					.filter((tag): tag is string => tag !== null)
					.slice(0, ACP_MAX_EVIDENCE_TAGS);
				forwardEvent("evidence.assessed", null, false, {
					runId,
					firstPassSuccess: payload.firstPassSuccess === true,
					findingCount: safeCount(findings.length),
					tags,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("context.activity_changed", (payload) => {
				if (!payload.operation || payload.operation.sessionId !== boundSessionId || payload.operation.cwd !== canonicalCwd)
					return;
				const operation = readContextOperation(payload.operation);
				if (!operation) return;
				contextActivity = {
					kind: payload.kind,
					phase: payload.phase,
					status: payload.status,
					at: payload.at,
					message: safeStoredString(payload.message, 1024),
					operation,
					...(payload.current === undefined ? {} : { current: payload.current }),
					...(payload.total === undefined ? {} : { total: payload.total }),
					...(payload.detail === undefined ? {} : { detail: safeStoredString(payload.detail, 1024) }),
					...(payload.stages === undefined ? {} : { stages: payload.stages }),
					...(payload.timing === undefined ? {} : { timing: payload.timing }),
				};
				forwardEvent("context.activity_changed", null, operation.outcome !== undefined, { ...contextActivity });
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("compaction.ended", (payload: CompactionPayload) => {
				const trigger = safeStoredIdentifier(payload.trigger, 64);
				if (trigger === null) return;
				forwardEvent("compaction.ended", null, false, {
					trigger,
					...(payload.outcome !== undefined ? { outcome: payload.outcome } : {}),
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("context.warning_raised", (payload: ContextWarningPayload) => {
				// Transition-only upstream, so this is a level edge, not a poll:
				// `warning: null` is the clear and has to cross as itself rather than
				// be dropped, or a client's banner never comes down.
				if (payload.warning !== null && typeof payload.warning !== "string") return;
				const warning = payload.warning === null ? null : safeStoredString(payload.warning, ACP_MAX_EVENT_TEXT_BYTES);
				forwardEvent("context.warning_raised", null, false, { warning: warning === "" ? null : warning });
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("run.scope_notice_raised", (payload) => {
				// The same fields every other surface draws. The message is host-authored
				// prose about what a dispatch's scope entry did, so it crosses bounded;
				// the paths a prose-inferred notice lists stay behind.
				const notice = readDispatchScopeNotice(payload);
				if (notice === null) return;
				forwardEvent("run.scope_notice_raised", null, false, {
					code: notice.code,
					level: notice.level,
					message: safeStoredString(notice.message, ACP_MAX_SCOPE_NOTICE_BYTES),
				});
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("safety.tool_budget_exceeded", (payload: ToolBudgetExceededPayload) => {
				// Bound to the turn that is running, like `safety.loop_blocked`: the
				// budget it names is per-turn and means nothing outside one.
				if (activePromptState === null) return;
				const callsThisTurn = safeCount(payload.callsThisTurn);
				const softBudget = safeCount(payload.softBudget);
				const hardCeiling = safeCount(payload.hardCeiling);
				const tool = safeStoredString(payload.tool, 64).trim();
				if (callsThisTurn === null || softBudget === null || hardCeiling === null || tool.length === 0) return;
				forwardEvent(
					"safety.tool_budget_exceeded",
					safeStoredIdentifier(payload.turnId, ACP_MAX_SESSION_ID_BYTES),
					payload.interrupted === true,
					{ tool, callsThisTurn, softBudget, hardCeiling, interrupted: payload.interrupted === true },
				);
			}),
		);
		unsubscribeEvents.push(
			bus.subscribe("provider.health_changed", (payload: ProviderHealthPayload) => {
				// `status.lastError` is provider prose that legitimately quotes URLs,
				// response bodies, and credentials-adjacent detail, so it stays behind
				// exactly as `run.failed`'s `outcomeDetail` does. What crosses is
				// the taxonomy a retry-visibility row needs.
				const targetId = safeStoredIdentifier(payload.id, ACP_MAX_TARGET_ID_BYTES);
				const status = payload.status?.health?.status;
				if (targetId === null || !(["healthy", "degraded", "unknown", "down"] as ReadonlyArray<unknown>).includes(status)) {
					return;
				}
				forwardEvent("provider.health_changed", null, false, {
					targetId,
					status,
					available: payload.status.available === true,
					latencyMs: safeCount(payload.status.health.latencyMs),
				});
			}),
		);
	}
	/** True only while this job's scheduled turn has sent its first frame and not yet released. */
	const jobTurnOpen = (jobId: string): boolean =>
		machineLease !== null && machineLease.jobId === jobId && machineLease.active.scheduled?.opened === true;
	/** Sends one job's canonical record. */
	const forwardJob = (job: JobRecord, complete: boolean): void => {
		const projected = jobEventPayload(job, complete, jobTurnOpen(job.id), options.commands?.jobSpend?.(job.id) ?? null);
		if (projected === null) return;
		forwardEvent("job.changed", null, complete, projected);
	};
	/** Re-sends the held record to open or close the turn bracket; the controller's own change follows when it commits. */
	const forwardJobTurn = (jobId: string): void => {
		const job = lastJobs.get(jobId) ?? options.commands?.jobs?.().find((candidate) => candidate.id === jobId);
		if (job !== undefined) forwardJob(job, jobIsComplete(job));
	};
	if (options.bus !== undefined) {
		unsubscribeEvents.push(
			options.bus.subscribe("job.changed", (payload) => {
				// A job belongs to the session and workspace that created it. The bus is
				// process-wide, so a frame for any other owner is not this client's.
				const owner = payload.job?.owner;
				if (owner === undefined || owner.sessionId !== (activeSessionId ?? boundSessionId) || owner.cwd !== canonicalCwd) {
					return;
				}
				lastJobs.delete(payload.job.id);
				lastJobs.set(payload.job.id, payload.job);
				for (const oldest of lastJobs.keys()) {
					if (lastJobs.size <= ACP_MAX_JOBS * 2) break;
					lastJobs.delete(oldest);
				}
				forwardJob(payload.job, payload.complete === true);
			}),
		);
	}
	const unsubscribeEventStream = (): void => {
		for (const unsubscribe of unsubscribeEvents) unsubscribe();
		unsubscribeEvents.length = 0;
		dispatchProgress.clear();
		lastJobs.clear();
	};
	// The chat loop reports every enqueue, hand-over, edit and drain, mid-turn
	// or not. A client that opted in replaces its queue rows with each list
	// instead of polling `queue` while a turn runs.
	const unsubscribeQueueEvents = queueEditWired(options)
		? options.chat.onEvent((raw) => {
				if (eventRecord(raw).type !== "queue_update") return;
				const sessionId = activeSessionId ?? boundSessionId;
				if (!handshake.initialized || !handshake.queueEventsEnabled || sessionId === null) return;
				try {
					options.transport.notify(ACP_QUEUE_CHANGED_NOTIFICATION, {
						sessionId,
						entries: projectQueueEntries(options.chat.queueEntries?.() ?? []),
					});
				} catch {
					options.diagnostics?.("failed to send a queue change notification");
				}
			})
		: () => {};
	// Readouts go to the session a queue change would name, and only to a client that opted in. The chat's
	// events still reach the emitter without one, so its rate clock stays whole.
	const readouts = createAcpReadoutsEmitter({
		now,
		send: (params) => {
			try {
				options.transport.notify(ACP_READOUTS_NOTIFICATION, params);
			} catch {
				options.diagnostics?.("failed to send a readouts notification");
			}
		},
		...(options.autonomyPosture !== undefined ? { autonomyPosture: options.autonomyPosture } : {}),
		...(options.chat.autonomyStatus !== undefined
			? { autonomyStatus: () => options.chat.autonomyStatus?.() ?? null }
			: {}),
		...(options.chat.activeSkillSurface !== undefined
			? { activeSkillSurface: () => options.chat.activeSkillSurface?.() ?? [] }
			: {}),
	});
	const readoutsSession = (id: string | null): AcpReadoutsSession | null => {
		if (id === null || !handshake.initialized || !handshake.readoutsEnabled) return null;
		const session = sessions.get(id);
		return session === undefined ? null : { id, autonomy: session.autonomy, holdsPrompt: activeSessionId === id };
	};
	const publishReadouts = (id: string): void => {
		const session = readoutsSession(id);
		if (session !== null) readouts.publish(session);
	};
	const unsubscribeReadouts = options.chat.onEvent((raw) =>
		readouts.chatEvent(raw, readoutsSession(activeSessionId ?? boundSessionId)),
	);
	// The judge's hold on a call the client already drew, as a non-terminal update of that row. The terminal
	// update still arrives once, last, and these frames spend none of the call's progress budget.
	const unsubscribeAdmission =
		options.toolRegistry?.onAdmissionReview?.((event) => {
			const active = activePromptState;
			if (!handshake.initialized || !handshake.readoutsEnabled || active === null || activeSessionId === null) return;
			const wireId = openWireIdFor(active, event.toolCallId);
			if (wireId === null) return;
			const admission: AcpAdmissionMeta =
				event.state === "judging"
					? { version: 1, state: "judging", display: "waiting for the safety judge" }
					: { version: 1, state: "admitted" };
			// A call the judge is reviewing still awaits approval; its allow lets the body run.
			const status: AcpToolCallStatus = event.state === "judging" ? "pending" : "in_progress";
			if (status === "in_progress") active.runningToolCalls.add(wireId);
			try {
				sendUpdate(options.transport, activeSessionId, active, {
					sessionUpdate: "tool_call_update",
					toolCallId: wireId,
					status,
					_meta: { [ACP_ADMISSION_META_KEY]: admission },
				});
			} catch {
				options.diagnostics?.("failed to send an admission update");
			}
		}) ?? (() => {});
	// A call goes on the wire `pending` and turns `in_progress` once, when its body starts: after admission, the judge
	// and any approval. A body that starts before its `tool_call` is emitted makes that call announce itself running.
	const unsubscribeToolBodyStart =
		options.toolRegistry?.onToolBodyStart?.((engineId) => {
			const active = activePromptState;
			if (!handshake.initialized || active === null || activeSessionId === null) return;
			if (active.permissionExpired || active.toolCallLimitReached) return;
			const wireId = openWireIdFor(active, engineId);
			if (wireId === null) {
				if (!active.toolCallWireIds.has(engineId) && active.earlyToolBodies.size < ACP_MAX_LIVE_TOOL_CALLS)
					active.earlyToolBodies.add(engineId);
				return;
			}
			if (active.runningToolCalls.has(wireId)) return;
			active.runningToolCalls.add(wireId);
			const snapshot = active.toolCallSnapshots.get(wireId);
			try {
				sendUpdate(
					options.transport,
					activeSessionId,
					active,
					{ sessionUpdate: "tool_call_update", toolCallId: wireId, status: "in_progress" satisfies AcpToolCallStatus },
					toolCallUpdateMeta(snapshot),
				);
			} catch {
				options.diagnostics?.("failed to send a tool start update");
			}
		}) ?? (() => {});

	/**
	 * Records a delegated agent against the tool call that spawned it and
	 * re-announces that call so the attribution reaches the client while the
	 * worker is running. Nothing is minted here: an id with no open call this
	 * turn binds to nothing, exactly as on the permission path.
	 */
	function attributeRunToToolCall(
		parentToolCallId: string | undefined,
		identity: { runId: string; agentId: string; node: string | null },
	): void {
		const active = activePromptState;
		if (active === null || activeSessionId === null) return;
		if (parentToolCallId === undefined || parentToolCallId.length === 0) return;
		const wireId = openWireIdFor(active, parentToolCallId);
		if (wireId === null) return;
		const snapshot = active.toolCallSnapshots.get(wireId);
		if (snapshot === undefined) return;
		const agents = snapshot.agents ?? [];
		if (agents.length >= ACP_MAX_TOOL_CALL_AGENTS) return;
		if (agents.some((agent) => agent.runId === identity.runId)) return;
		agents.push({
			version: 1,
			role: "worker",
			agentId: identity.agentId,
			runId: identity.runId,
			...(identity.node !== null ? { node: identity.node } : {}),
		});
		snapshot.agents = agents;
		sendUpdate(
			options.transport,
			activeSessionId,
			active,
			{
				sessionUpdate: "tool_call_update",
				toolCallId: wireId,
				title: snapshot.title,
				kind: snapshot.kind,
				status: "in_progress" satisfies AcpToolCallStatus,
			},
			toolCallUpdateMeta(snapshot),
		);
	}

	const requireInitialized = (): void => {
		if (!handshake.initialized)
			throw new AcpRequestError(-32600, "initialize must be called first", { code: "not_initialized" });
	};

	const sessionIdOf = (params: unknown): string => {
		return requireBoundedClientString(
			isRecord(params) ? params.sessionId : undefined,
			"sessionId",
			ACP_MAX_SESSION_ID_BYTES,
		);
	};

	const assertParamKeys = (params: unknown, allowed: ReadonlySet<string>): Record<string, unknown> => {
		if (params === undefined) return {};
		if (!isRecord(params) || Object.keys(params).some((key) => key !== "_meta" && !allowed.has(key))) {
			throw new AcpRequestError(-32602, "invalid method parameters", { code: "invalid_params" });
		}
		return params;
	};

	const canonicalSessionCwd = (requested: unknown): string => {
		const mismatch = (): AcpRequestError =>
			new AcpRequestError(-32602, `session cwd does not match bound workspace root ${canonicalCwd}`, {
				code: "session_cwd_mismatch",
			});
		if (typeof requested !== "string" || requested.trim().length === 0 || !isAbsolute(requested)) throw mismatch();
		let sessionCwd: string;
		try {
			sessionCwd = realpathSync(resolvePath(requested));
		} catch {
			throw mismatch();
		}
		if (sessionCwd !== canonicalCwd) throw mismatch();
		return sessionCwd;
	};
	const attachClientMcpServers = async (
		servers: ReadonlyArray<McpClientServerSpec>,
		ceiling: TurnConstraints | undefined,
	): Promise<void> => {
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
	};

	const workspaceHistory = (): SessionMeta[] => {
		const history = options.session?.history() ?? [];
		return history.filter((meta) => {
			if (safeStoredIdentifier(meta.id, ACP_MAX_SESSION_ID_BYTES) === null) return false;
			try {
				return realpathSync(resolvePath(meta.cwd)) === canonicalCwd;
			} catch {
				return false;
			}
		});
	};

	const workspaceMeta = (sessionId: string): SessionMeta => {
		const meta = workspaceHistory().find((candidate) => candidate.id === sessionId);
		if (!meta) throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		return meta;
	};

	const routingSnapshot = (): AcpRoutingSnapshot => {
		const route = options.routing?.() ?? { target: null, model: null };
		return {
			target: safeConfiguredIdentifier(route.target, ACP_MAX_TARGET_ID_BYTES),
			model: safeConfiguredIdentifier(route.model, ACP_MAX_MODEL_ID_BYTES),
		};
	};

	// The limits last applied to the chat. A slash command acts outside the tool
	// calls these bound, so it is screened against them before it runs (Z1).
	let standingLimits: TurnConstraints | undefined;
	const applyCeilings = (
		ceilings: ReadonlyArray<TurnConstraints | undefined>,
		lifetime: "session" | "prompt" = "session",
	): TurnConstraints | undefined => {
		standingLimits = options.chat.setToolCeiling?.(ceilings, lifetime);
		return standingLimits;
	};
	const assertCommandWithinCeiling = (control: AcpCommandControl, command: unknown, argv: unknown): void => {
		if (!ceilingBinds(standingLimits)) return;
		const refusal =
			control.ceilingRefusal === undefined
				? "this agent cannot screen commands against a ceiling"
				: control.ceilingRefusal(command, argv, standingLimits);
		if (refusal !== null) throw new AcpRequestError(-32602, refusal, { code: "ceiling_refused" });
	};
	const assertCeilingEnforceable = (ceiling: TurnConstraints | undefined): void => {
		if (ceiling !== undefined && options.chat.setToolCeiling === undefined) {
			throw new AcpRequestError(-32602, `this agent cannot enforce ${ACP_CEILING_META_KEY}`, {
				code: "ceiling_unsupported",
			});
		}
	};
	/**
	 * Apply the bound session's ceiling as the chat's standing limits and return
	 * the echo for its response. Every way a session becomes bound goes through
	 * here, so a fork, a handoff or a load never runs under limits it did not echo.
	 */
	const applySessionCeiling = (session: AcpServerSession): Record<string, unknown> =>
		options.chat.setToolCeiling !== undefined ? ceilingMeta(applyCeilings([session.ceiling])) : {};
	/**
	 * A successor's ceiling: the source session's narrowed by the one sent with
	 * the request, so a fork or handoff can tighten what it inherits and never
	 * loosen it (Z1).
	 */
	const successorCeiling = (source: AcpServerSession, params: unknown): TurnConstraints | undefined => {
		const requested = requestCeiling(params);
		assertCeilingEnforceable(requested);
		return snapshotTurnConstraints(narrowTurnConstraints(source.ceiling, requested));
	};
	const getSession = (params: unknown): AcpServerSession => {
		const id = sessionIdOf(params);
		const session = sessions.get(id);
		if (session) return session;
		const child = replacedSessions.get(id);
		if (child !== undefined)
			throw new AcpRequestError(-32002, `session ${id} was closed when its fork ${child} took this process`, {
				code: "session_replaced",
			});
		throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
	};
	const notifyConfigOptions = (session: AcpServerSession) => {
		options.transport.notify("session/update", {
			sessionId: session.id,
			update: { sessionUpdate: "config_option_update", configOptions: configOptions(options, listingFallbacks, session) },
			_meta: { [ACP_SESSION_META_KEY]: { target: session.target, model: session.model } },
		});
	};
	/** Why a target's model choices are its configured ones and not the account's live listing. */
	const listingFallbacks = new Map<string, string>();
	/**
	 * A runtime whose listing carries each model's capabilities lists live when its cache is cold, stale or keeps no
	 * capabilities, as `run` does, so the model choices and their thinking levels are the account's. The wait is the
	 * provider probe's own timeout; a late listing still updates the session's options when it lands.
	 */
	const listTargetModels = async (targetId: string | null): Promise<void> => {
		const providers = options.providers;
		if (providers === undefined || targetId === null) return;
		const status = providers.list().find((item) => item.target.id === targetId);
		if (!status?.runtime?.listsModelCapabilities || typeof status.runtime.probe !== "function") return;
		if (status.discoveredModelsSource === "probe" || listedLive(status)) return;
		const probe = providers.probeTarget(targetId, { reasoning: false }).then(
			(probed) =>
				listedLive(probed) ? null : `the live model listing failed: ${probed?.reason ?? "it returned no models"}`,
			(error: unknown) => `the live model listing failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), PROVIDER_PROBE_TIMEOUT_MS);
			timer.unref?.();
		});
		const outcome = await Promise.race([probe, timedOut]);
		clearTimeout(timer);
		if (outcome === null) {
			listingFallbacks.delete(targetId);
			return;
		}
		const reason =
			outcome === "timeout"
				? `the live model listing took longer than ${PROVIDER_PROBE_TIMEOUT_MS / 1_000} s`
				: modelSelectionErrorText(outcome, 512);
		listingFallbacks.set(targetId, reason);
		if (outcome !== "timeout") return;
		void probe.then((late) => {
			if (late !== null) return;
			listingFallbacks.delete(targetId);
			for (const session of sessions.values()) if (session.target === targetId) notifyConfigOptions(session);
		});
	};
	/**
	 * A turn probes its target live before it resolves thinking support, as turn-runtime does, so a cold cache can say
	 * unsupported while the route thinks. The same probe here keeps the thinking option in step; it is re-sent on change only.
	 */
	const refreshThinkingOption = (session: AcpServerSession): void => {
		const providers = options.providers;
		const targetId = session.target;
		const runtime = providers?.list().find((item) => item.target.id === targetId)?.runtime;
		if (!providers || targetId === null || !runtime || typeof providers.probeTarget !== "function") return;
		if (runtime.tier === "cloud" && typeof runtime.probeServingWindows !== "function") return;
		const before = JSON.stringify(sessionThinking(options, session));
		void providers.probeTarget(targetId).then(
			() => {
				if (sessions.get(session.id) !== session || session.target !== targetId) return;
				if (JSON.stringify(sessionThinking(options, session)) !== before) notifyConfigOptions(session);
			},
			() => {},
		);
	};
	const refuseYolo = (level: AutonomyLevel): void => {
		const refusal = level === "yolo" ? (options.yoloRefusal?.() ?? null) : null;
		if (refusal !== null) throw new AcpRequestError(-32602, refusal, { code: "yolo_refused" });
	};
	const setAutonomy = (session: AcpServerSession, level: unknown): void => {
		if (!isAutonomyLevel(level)) throw new AcpRequestError(-32602, "invalid autonomy level", { code: "invalid_params" });
		refuseYolo(level);
		if (session.activePrompt !== null)
			throw new AcpRequestError(-32602, "cannot change autonomy during an active prompt", { code: "prompt_active" });
		if (session.autonomy === level) return;
		session.autonomy = level;
		session.autonomySource = "session";
		options.transport.notify("session/update", {
			sessionId: session.id,
			update: { sessionUpdate: "current_mode_update", currentModeId: level },
		});
		notifyConfigOptions(session);
	};
	// The catalog is rebuilt from `commandReference()` on every call and a
	// palette legitimately re-reads it after a reload, so it is memoized against
	// a client that polls and against every prompt that checks for a typed
	// command. Availability is fixed by the host callbacks wired when this server
	// is created; session/route changes do not alter that wiring.
	let commandCatalog: AcpCommandCatalog | null = null;
	const catalog = () => {
		if (options.commands === undefined) return undefined;
		commandCatalog ??= options.commands.catalog();
		return commandCatalog;
	};
	const availableCommands = () =>
		catalog()
			?.commands.filter(
				(command) =>
					(command.injectsUserTurn !== true || options.chat.whenSettled !== undefined) &&
					(command.streams === undefined || command.injectsUserTurn === true || command.promptTurn === true),
			)
			.map((command) => ({
				name: command.name,
				description: command.summary,
				input: { hint: command.usage },
			})) ?? [];
	// The announcement also names the prompts and extension commands a line may
	// type, so a client's palette offers what the terminal's does (WTF-P F05).
	// They are screened as typed lines, never invoked as built-in commands.
	const announceCommands = (sessionId: string) => {
		if (options.commands === undefined) return;
		const builtIn = availableCommands();
		const typed = (options.commands.typedCommands?.() ?? []).filter(
			(entry) => !builtIn.some((command) => command.name === entry.name),
		);
		options.transport.notify("session/update", {
			sessionId,
			update: { sessionUpdate: "available_commands_update", availableCommands: [...builtIn, ...typed] },
		});
	};

	options.transport.onRequest("initialize", (params) => handshake.initialize(params));
	options.transport.onRequest("authenticate", (params) => handshake.authenticate(params));

	options.transport.onRequest("session/new", async (params) => {
		requireInitialized();
		return withSessionSlot(async () => {
			const request = assertParamKeys(params, new Set(["cwd", "mcpServers", "additionalDirectories"]));
			const ceiling = requestCeiling(request);
			assertCeilingEnforceable(ceiling);
			assertNoAdditionalDirectories(request.additionalDirectories);
			const sessionCwd = canonicalSessionCwd(request.cwd);
			const clientMcpServers = parseClientMcpServers(request.mcpServers, true);
			const route = routingSnapshot();
			const createInput: { cwd: string; target?: string; model?: string } = { cwd: sessionCwd };
			if (route.target !== null) createInput.target = route.target;
			if (route.model !== null) createInput.model = route.model;
			await attachClientMcpServers(clientMcpServers, ceiling);
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
			sessionCreated = true;
			sessions.set(id, session);
			boundSessionId = id;
			options.bindTelemetrySession?.(id);
			const ceilingEcho = applySessionCeiling(session);
			announceCommands(id);
			telemetry.bind(false);
			await listTargetModels(session.target);
			refreshThinkingOption(session);
			const opened = {
				sessionId: id,
				...sessionConfig(options, listingFallbacks, session),
				_meta: {
					...ceilingEcho,
					...modelsResultMeta(options, session),
					[ACP_SESSION_META_KEY]: sessionResultMeta(session, false),
					...(await workspaceResultMeta()),
					...trustResultMeta(session.cwd),
				},
			};
			// After the result is written, so the client has bound the session id the frame names.
			setImmediate(() => publishReadouts(id));
			return opened;
		});
	});

	interface PreparedRestore {
		leafTurnId: string | null;
		replayMessages: ReadonlyArray<AgentMessage>;
		replay: PreparedAcpReplay | undefined;
	}
	/**
	 * Everything a restore reads, gathered before anything changes, so a read
	 * failure leaves the bound session exactly as it was. `session/load`, a
	 * fork, a /tree switch and a handoff all restore through here: one replay
	 * projection, one provider context builder.
	 */
	const prepareRestore = (
		id: string,
		leafTurnId: string | null,
		scope: "leaf" | "upto",
		replayToClient: boolean,
	): PreparedRestore => {
		if (options.readSessionEntries === undefined || options.buildReplayMessages === undefined) {
			throw new Error("session replay is not wired");
		}
		const entries = options.readSessionEntries(id);
		return {
			leafTurnId,
			replayMessages: options.buildReplayMessages(entries, leafTurnId, scope),
			replay: replayToClient
				? prepareAcpReplay(
						entries,
						leafTurnId,
						id,
						canonicalCwd,
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
			return withReplayUsage(replay, await options.telemetryReadModel.open(sessionId), handshake.fullUsageEnabled);
		} catch (error) {
			options.diagnostics?.(`replay usage read failed: ${acpErrorMessage(error)}`);
			return replay;
		}
	};
	/** Bind `session` as the one this process hosts, then replay its branch to the client. */
	const bindRestored = (session: AcpServerSession, replay: PreparedAcpReplay | undefined): void => {
		sessions.set(session.id, session);
		boundSessionId = session.id;
		options.bindTelemetrySession?.(session.id);
		announceCommands(session.id);
		if (replay !== undefined) {
			for (const replayParams of replay.params) options.transport.notify("session/update", replayParams);
			replayDispatchTerminals(forwardEvent, replay.runs);
		}
		// A restored session's meter goes out even when no history replays (session/resume), as session/load sends it.
		telemetry.bind(replay !== undefined, true);
	};

	/** Whether a live process other than this one holds the session's ledger now, read from its record. */
	const heldElsewhere = (id: string): boolean => {
		try {
			const current = workspaceMeta(id);
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
		canonicalSessionCwd(request.cwd);
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
		if (session.activePrompt !== null || options.chat.isStreaming() || contextCommandInFlight !== null) {
			throw new AcpRequestError(-32602, "this session already has an active prompt", { code: "prompt_active" });
		}
		if (activeShell !== null) {
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
					canonicalCwd,
					workspaceMeta(session.id).target,
				);
			} catch (error) {
				throw loadFailure(error);
			}
		}
		// The hosted session's live view, read in the same tick as the prompt check above.
		if (replay !== undefined) replay = withReplayUsage(replay, liveSessionView(), handshake.fullUsageEnabled);
		const ceilingEcho = applySessionCeiling(session);
		announceCommands(session.id);
		if (replay !== undefined) {
			for (const replayParams of replay.params) options.transport.notify("session/update", replayParams);
			replayDispatchTerminals(forwardEvent, replay.runs);
		}
		const reopened = {
			...sessionConfig(options, listingFallbacks, session),
			_meta: {
				...ceilingEcho,
				...modelsResultMeta(options, session),
				[ACP_SESSION_META_KEY]: sessionResultMeta(
					session,
					true,
					replay !== undefined ? { turns: replay.turns, truncated: replay.truncated } : undefined,
				),
				...(await workspaceResultMeta()),
				...trustResultMeta(session.cwd),
			},
		};
		setImmediate(() => publishReadouts(session.id));
		return reopened;
	};
	const restoreSession = async (params: unknown, replayToClient: boolean) => {
		requireInitialized();
		const hosted =
			isRecord(params) && boundSessionId !== null && params.sessionId === boundSessionId
				? sessions.get(boundSessionId)
				: undefined;
		if (hosted !== undefined && !closingSessions.has(hosted.id)) return reopenHosted(params, hosted, replayToClient);
		return withSessionSlot(async () => {
			const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers", "additionalDirectories"]));
			// Composed exactly like session/new; without one the operator's limits apply.
			const ceiling = requestCeiling(request);
			assertCeilingEnforceable(ceiling);
			assertNoAdditionalDirectories(request.additionalDirectories);
			const id = sessionIdOf(request);
			canonicalSessionCwd(request.cwd);
			const clientMcpServers = parseClientMcpServers(request.mcpServers, replayToClient);
			const stored = workspaceMeta(id);
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
				replay = replayToClient ? prepareAcpReplay(entries, leaf, id, canonicalCwd, stored.target) : undefined;
			} catch (error) {
				throw loadFailure(error);
			}
			const recordedRoute = resumedSessionRoute(stored, entries);
			await attachClientMcpServers(clientMcpServers, ceiling);
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
					? prepareAcpReplay(restored.entries, restored.leafTurnId, id, canonicalCwd, stored.target)
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
				cwd: canonicalCwd,
				autonomy,
				autonomySource: "settings",
				target: safeConfiguredIdentifier(recordedRoute.target, ACP_MAX_TARGET_ID_BYTES),
				model: safeConfiguredIdentifier(recordedRoute.model, ACP_MAX_MODEL_ID_BYTES),
				thinkingLevel: options.settings?.read().thinkingLevel ?? "off",
				createdAt: stored.createdAt,
				activePrompt: null,
				...(ceiling !== undefined ? { ceiling } : {}),
			};
			sessionCreated = true;
			// Its first prompt, in whichever process took it, carried the startup notices; a reload does not repeat them.
			if (entries.some((entry) => entry.kind === "message" && entry.role === "user")) startupHintsSessionId = id;
			const ceilingEcho = applySessionCeiling(session);
			replay = await replayWithUsage(replay, id);
			// The first usage frame and the ledger read the view the next request would publish, not the saved snapshot.
			await options.chat.nextRequestReady?.();
			bindRestored(session, replay);
			const loaded = {
				...sessionConfig(options, listingFallbacks, session),
				_meta: {
					...ceilingEcho,
					...modelsResultMeta(options, session),
					[ACP_SESSION_META_KEY]: sessionResultMeta(
						session,
						true,
						replay !== undefined ? { turns: replay.turns, truncated: replay.truncated } : undefined,
					),
					...(await workspaceResultMeta()),
					...trustResultMeta(session.cwd),
				},
			};
			// After the result is written, so the client has bound the session id the frame names.
			setImmediate(() => publishReadouts(id));
			return loaded;
		});
	};
	options.transport.onRequest("session/load", (params) => restoreSession(params, true));
	options.transport.onRequest("session/resume", (params) => restoreSession(params, false));

	options.transport.onRequest(ACP_SESSION_LIST_METHOD, (params): AcpSessionList => {
		requireInitialized();
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
			if (filterCwd !== canonicalCwd) return { sessions: [] };
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
				decoded.workspace !== workspaceInstanceId ||
				!Number.isSafeInteger(decoded.start) ||
				(decoded.start as number) < 0 ||
				Buffer.from(JSON.stringify(decoded)).toString("base64url") !== request.cursor
			) {
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			}
			start = decoded.start as number;
		}
		const history = workspaceHistory().filter((meta) => meta.hasModelTurn !== false);
		const projected: AcpSessionListRow[] = [];
		let budgetBytes = utf8Bytes(JSON.stringify({ sessions: [] }));
		for (const meta of history.slice(start, start + 50)) {
			const label = safeStoredString(meta.name, ACP_MAX_LABEL_BYTES).trim();
			const messageCount = safeCount(meta.messageCount);
			const item = {
				sessionId: meta.id,
				cwd: canonicalCwd,
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
							JSON.stringify({ workspace: workspaceInstanceId, start: start + projected.length }),
						).toString("base64url"),
					}
				: {}),
		};
	});

	options.transport.onRequest(ACP_BOARD_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.board === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		getSession(request);
		return projectSessionBoard(options.board());
	});

	// The jobs the bound session owns now. Events carry only changes, so a client that binds or
	// resumes reads this once and folds `job.changed` after it.
	options.transport.onRequest(ACP_JOBS_LIST_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const listJobs = options.commands?.jobs;
		if (listJobs === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = getSession(request);
		if (session.id !== boundSessionId) {
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
				jobTurnOpen(job.id),
				options.commands?.jobSpend?.(job.id) ?? null,
			);
			if (projected !== null) jobs.push(projected);
		}
		return { jobs };
	});

	const requireBranches = () => {
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
	};
	/** A branch change rewrites the context a running turn is reading, so it waits for the turn. */
	const requireIdle = (session: AcpServerSession, action: string): void => {
		if (activeShell !== null)
			throw new AcpRequestError(-32602, `cannot ${action} while a shell line is running`, { code: "shell_active" });
		if (
			contextCommandInFlight !== null ||
			session.activePrompt !== null ||
			activePromptState !== null ||
			options.chat.isStreaming()
		) {
			throw new AcpRequestError(-32602, `cannot ${action} during an active prompt`, { code: "prompt_active" });
		}
	};
	/**
	 * A path that stops hosting a live, loaded session checkpoints it first, so meta.json records why its ledger
	 * closed, as shutdown records its own. A failed checkpoint is reported and the close goes on.
	 */
	const checkpointBeforeClose = async (sessionId: string, reason: "close" | "fork" | "handoff"): Promise<void> => {
		const durable = options.session;
		if (durable?.current()?.id !== sessionId) return;
		await durable.checkpoint(reason).catch((err: unknown) => {
			process.stderr.write(
				`[pancode:acp] ${reason} checkpoint failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		});
	};
	/** The checkpoint yields, so a request that arrived meanwhile may have closed or started work on the session. */
	const requireStillIdle = (session: AcpServerSession, action: string): void => {
		if (sessions.get(session.id) !== session || closingSessions.has(session.id)) {
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		}
		requireIdle(session, action);
	};
	const selectableTurn = (contract: SessionContract, sessionId: string, value: unknown): string => {
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
	};

	options.transport.onRequest(ACP_SESSION_TREE_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const { session } = requireBranches();
		const bound = getSession(request);
		try {
			return projectSessionTree(session.tree(bound.id));
		} catch {
			throw new AcpRequestError(-32603, "session tree could not be read", { code: "internal_error" });
		}
	});

	options.transport.onRequest(ACP_SNAPSHOTS_LIST_METHOD, async (params): Promise<AcpSnapshotList> => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const bound = getSession(request);
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
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "n"]));
		const bound = getSession(request);
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
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "n"]));
		const bound = getSession(request);
		const n = snapshotN(request.n);
		requireIdle(bound, "rewind");
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
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "turnId"]));
		const { session, resetForSession } = requireBranches();
		const bound = getSession(request);
		requireIdle(bound, "switch branches");
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
		const { session, resetForSession, readEntries, buildMessages } = requireBranches();
		const bound = getSession(request);
		requireIdle(bound, "fork");
		const ceiling = successorCeiling(bound, request);
		const requested = chooseTurn === "request" ? request.turnId : session.leafId(bound.id);
		if (requested === null)
			throw new AcpRequestError(-32602, "the session has no turn to fork from", { code: "turn_unknown" });
		const turnId = selectableTurn(session, bound.id, requested);
		// The fork closes the parent's ledger.
		await checkpointBeforeClose(bound.id, "fork");
		requireStillIdle(bound, "fork");
		if (clientMcpServers !== undefined) {
			// Standard fork names the child's client servers, so the parent's go first; a launch failure refuses the fork
			// before the session changes, as on an opener.
			await options.mcpCapabilities?.detachClientServers();
			await attachClientMcpServers(clientMcpServers, ceiling);
			requireStillIdle(bound, "fork");
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
		sessions.delete(bound.id);
		closedSessionIds.add(bound.id);
		replacedSessions.delete(meta.id);
		replacedSessions.set(bound.id, meta.id);
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
				replay = prepareAcpReplay(restored.entries, restored.leafTurnId, meta.id, canonicalCwd, meta.target);
		} catch (error) {
			options.diagnostics?.(`fork replay failed: ${acpErrorMessage(error)}`);
			resetForSession(forkLeaf, []);
			replayFailed = true;
		}
		const ceilingEcho = applySessionCeiling(forked);
		bindRestored(forked, replay);
		const parent = { parentSessionId: bound.id, parentTurnId: turnId };
		// Standard session/fork answers with exactly the unstable ForkSessionResponse fields, so its parent travels in
		// `_meta`; the extension method keeps it beside the session id.
		return {
			sessionId: forked.id,
			...(replayToClient ? parent : {}),
			...sessionConfig(options, listingFallbacks, forked),
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
		requireInitialized();
		return forkBoundSession(assertParamKeys(params, new Set(["sessionId", "turnId"])), "request", true);
	});
	// Standard ACP fork: the whole active branch, at its leaf, with the client MCP servers the request names in place of
	// the parent's.
	options.transport.onRequest("session/fork", (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers", "additionalDirectories"]));
		assertNoAdditionalDirectories(request.additionalDirectories);
		canonicalSessionCwd(request.cwd);
		const clientMcpServers = parseClientMcpServers(request.mcpServers, false);
		return forkBoundSession(request, "leaf", false, clientMcpServers);
	});

	const handoffRefusal = (level: "warn" | "error", code: string, reason: string) => ({
		status: "refused" as const,
		level,
		code,
		reason: boundString(reason, ACP_MAX_HANDOFF_REASON_BYTES),
	});
	const requireHandoff = () => {
		const control = options.handoff;
		const branches = requireBranches();
		if (control === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		return { control, ...branches };
	};
	/** Reviewed text keeps its line structure; any other control character is refused. */
	const handoffDocument = (value: unknown): string => {
		if (typeof value !== "string" || utf8Bytes(value) > ACP_MAX_HANDOFF_DOCUMENT_BYTES) {
			throw new AcpRequestError(-32602, "document is invalid", { code: "invalid_params" });
		}
		// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character other than a line break is the refusal.
		if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
			throw new AcpRequestError(-32602, "document is invalid", { code: "invalid_params" });
		}
		return value;
	};

	// /handoff, first half: extract with one repair and render the document a
	// person reviews. Nothing is written; the draft waits here under an id.
	options.transport.onRequest(ACP_HANDOFF_PREPARE_METHOD, async (params): Promise<AcpHandoffPrepareResult> => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "goal"]));
		const { control } = requireHandoff();
		const bound = getSession(request);
		requireIdle(bound, "hand off");
		const goal = requireBoundedClientString(request.goal, "goal", ACP_MAX_HANDOFF_GOAL_BYTES, { allowEmpty: true });
		if (handoffPreparing) return handoffRefusal("warn", "busy", "a handoff document is already being drawn up");
		handoffPreparing = true;
		const serial = promptSerial;
		let outcome: Awaited<ReturnType<AcpHandoffControl["prepare"]>>;
		try {
			outcome = await control.prepare(goal);
		} catch (error) {
			options.diagnostics?.(`handoff extraction failed: ${acpErrorMessage(error)}`);
			return handoffRefusal("error", "extraction", "the extraction round failed");
		} finally {
			handoffPreparing = false;
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
		if (serial !== promptSerial || sessions.get(bound.id) !== bound) {
			return handoffRefusal("warn", "stale", "the conversation moved while the document was drawn; nothing was written");
		}
		if (utf8Bytes(outcome.draft.document) > ACP_MAX_HANDOFF_DOCUMENT_BYTES) {
			return handoffRefusal("error", "too_large", "the handoff document is larger than a client can review");
		}
		const handoffId = randomUUID();
		pendingHandoff = { handoffId, sessionId: bound.id, draft: outcome.draft };
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
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "handoffId", "document"]));
		const { control, session, resetForSession } = requireHandoff();
		const bound = getSession(request);
		requireIdle(bound, "hand off");
		const ceiling = successorCeiling(bound, request);
		const handoffId = requireBoundedClientString(request.handoffId, "handoffId", ACP_MAX_SESSION_ID_BYTES);
		const document = handoffDocument(request.document);
		const pending = pendingHandoff;
		if (pending === null || pending.handoffId !== handoffId || pending.sessionId !== bound.id) {
			return handoffRefusal(
				"warn",
				"stale",
				"this document no longer describes the conversation; draw it up again. Nothing was written",
			);
		}
		// The successor replaces the bound session, whose ledger closes. An empty review changes nothing.
		if (document.trim().length > 0) {
			await checkpointBeforeClose(bound.id, "handoff");
			requireStillIdle(bound, "hand off");
		}
		if (pendingHandoff !== pending) {
			return handoffRefusal(
				"warn",
				"stale",
				"this document no longer describes the conversation; draw it up again. Nothing was written",
			);
		}
		const outcome = control.commit(pending.draft, document);
		if (!outcome.ok) {
			// An empty review is the reviewer's to fix; every other refusal ends the draft.
			if (outcome.code !== "empty") pendingHandoff = null;
			return handoffRefusal(outcome.level, outcome.code, outcome.reason);
		}
		pendingHandoff = null;
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
		sessions.delete(bound.id);
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
		const ceilingEcho = applySessionCeiling(successor);
		bindRestored(successor, replay);
		return {
			status: "committed" as const,
			sessionId: toSessionId,
			fromSessionId: bound.id,
			warnings: outcome.warnings.slice(0, 8).map((warning) => boundString(warning, ACP_MAX_HANDOFF_REASON_BYTES)),
			...sessionConfig(options, listingFallbacks, successor),
			_meta: {
				...ceilingEcho,
				...modelsResultMeta(options, successor),
				[ACP_SESSION_META_KEY]: sessionResultMeta(successor, false),
			},
		};
	});

	options.transport.onRequest(ACP_HANDOFF_CANCEL_METHOD, (params): AcpHandoffCancelResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "handoffId"]));
		requireHandoff();
		const bound = getSession(request);
		const handoffId = requireBoundedClientString(request.handoffId, "handoffId", ACP_MAX_SESSION_ID_BYTES);
		const cancelled = pendingHandoff?.handoffId === handoffId && pendingHandoff.sessionId === bound.id;
		if (cancelled) pendingHandoff = null;
		return { cancelled };
	});

	if (options.telemetryReadModel) {
		const handlers = telemetryRequestHandlers({
			model: options.telemetryReadModel,
			...(options.refreshQuota ? { refreshQuota: options.refreshQuota } : {}),
			params: assertParamKeys,
			session: getSession,
		});
		for (const [method, handler] of Object.entries(handlers))
			options.transport.onRequest(method, (params) => {
				requireInitialized();
				return handler(params);
			});
	}

	// /btw and /draft: one round beside the session at a time, cancellable, and
	// never a turn. The chat loop answers beside a turn in flight over a snapshot
	// of its history (#415); a refusal it reports is an outcome, not a protocol
	// error.
	let asideRound: { sessionId: string; abort: AbortController; settled: Promise<void> } | null = null;
	const runAside = async <T>(sessionId: string, round: (signal: AbortSignal) => Promise<T>): Promise<T> => {
		if (closingSessions.has(sessionId) || options.transport.closed)
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		if (asideRound !== null)
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
		asideRound = active;
		try {
			return await round(controller.signal);
		} finally {
			if (asideRound === active) asideRound = null;
			settle();
		}
	};
	const requireAside = () => {
		if (options.aside === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		return options.aside;
	};
	const asideText = (value: unknown, field: string) => {
		const text = typeof value === "string" ? value.trim() : "";
		if (text.length === 0 || text.length > ACP_ASIDE_QUESTION_MAX_CHARS)
			throw new AcpRequestError(-32602, `${field} must be 1 to ${ACP_ASIDE_QUESTION_MAX_CHARS} characters`, {
				code: "invalid_params",
			});
		return text;
	};
	options.transport.onRequest(ACP_ASIDE_ASK_METHOD, async (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "question"]));
		const aside = requireAside();
		const session = getSession(request);
		const question = asideText(request.question, "question");
		return projectAsideAnswer(await runAside(session.id, (signal) => aside.ask(question, signal)), options.diagnostics);
	});
	options.transport.onRequest(ACP_ASIDE_DRAFT_METHOD, async (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "request", "count"]));
		const aside = requireAside();
		const session = getSession(request);
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
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		requireAside();
		getSession(request);
		const round = asideRound;
		round?.abort.abort();
		return { cancelled: round !== null };
	});

	// The /extensions view: what this session loaded, never paths or provenance.
	options.transport.onRequest(ACP_EXTENSIONS_LIST_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.extensions === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		getSession(request);
		return projectExtensions(options.extensions.list());
	});

	// /reload extensions. Hooks and extension resources change together, so a
	// reload waits for a running turn rather than swapping them under it.
	options.transport.onRequest(ACP_EXTENSIONS_RELOAD_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.extensions === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = getSession(request);
		requireIdle(session, "reload extensions");
		const outcome = projectExtensionReload(options.extensions.reload());
		announceCommands(session.id);
		return outcome;
	});

	// /reload hub, so a hub change made outside this session reaches it.
	// A failed reload is reported as failed; the previous resources stay live.
	options.transport.onRequest(ACP_HUB_RELOAD_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.hubReload === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = getSession(request);
		requireIdle(session, "reload the hub");
		try {
			const refreshed = { status: "refreshed" as const, ...options.hubReload() };
			announceCommands(session.id);
			return refreshed;
		} catch (error) {
			options.diagnostics?.(`hub reload failed: ${acpErrorMessage(error)}`);
			return { status: "failed" as const, error: boundString(acpErrorMessage(error), 1024) };
		}
	});

	options.transport.onRequest(ACP_CONTEXT_STATUS_METHOD, (params): ContextOperationStatus => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (!options.contextLedger) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		const session = getSession(request);
		if (session.id !== boundSessionId)
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		const current =
			contextActivity?.operation?.sessionId === session.id && contextActivity.operation.cwd === canonicalCwd
				? contextActivity
				: null;
		const recorded = [...(options.readSessionEntries?.(session.id) ?? [])].reverse().flatMap((entry) => {
			if (entry.kind !== "custom" || entry.customType !== CONTEXT_OPERATION_CUSTOM_TYPE) return [];
			const operation = readContextOperation(entry.data);
			return operation?.outcome && operation.sessionId === session.id && operation.cwd === canonicalCwd ? [operation] : [];
		});
		return {
			version: 1,
			active: current && !current.operation?.outcome ? current : null,
			latest: current?.operation?.outcome ? current.operation : (recorded[0] ?? null),
		};
	});

	// The terminal's /context window view, read and never recomputed.
	options.transport.onRequest(ACP_CONTEXT_LEDGER_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.contextLedger === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		getSession(request);
		try {
			return projectContextLedger(options.contextLedger());
		} catch (error) {
			options.diagnostics?.(`context ledger failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "context ledger could not be read", { code: "internal_error" });
		}
	});

	// The terminal's /view artifacts, from the overlay's own providers.
	const artifactDeps = (request: Record<string, unknown>) => {
		requireInitialized();
		if (options.artifacts === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = getSession(request);
		const deps = options.artifacts.deps(session.id);
		if (deps === null) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		return deps;
	};
	const artifactFailure = (what: string, error: unknown): never => {
		if (error instanceof AcpRequestError) throw error;
		options.diagnostics?.(`artifact ${what} failed: ${acpErrorMessage(error)}`);
		throw new AcpRequestError(-32603, `artifacts could not be ${what === "list" ? "listed" : "read"}`, {
			code: "internal_error",
		});
	};
	options.transport.onRequest(ACP_ARTIFACTS_LIST_METHOD, async (params) => {
		const request = assertParamKeys(params, new Set(["sessionId", "categories"]));
		const deps = artifactDeps(request);
		const categories = parseArtifactCategories(request.categories);
		try {
			return await listAcpArtifacts(deps, categories);
		} catch (error) {
			return artifactFailure("list", error);
		}
	});
	options.transport.onRequest(ACP_ARTIFACTS_READ_METHOD, async (params) => {
		const request = assertParamKeys(params, new Set(["sessionId", "id", "offset", "limit", "details"]));
		const deps = artifactDeps(request);
		const read = parseArtifactReadRequest(request);
		try {
			return await readAcpArtifact(deps, read);
		} catch (error) {
			return artifactFailure("read", error);
		}
	});

	// Compile a named playbook for review. Nothing is dispatched, reserved or written.
	options.transport.onRequest(ACP_FLEET_PREVIEW_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "name", "vars", "resume"]));
		const control = requireFleet(options);
		getSession(request);
		return projectFleetPreview(
			compileFleet(options, control, fleetName(request.name), fleetVars(request.vars), fleetResume(request.resume)),
		);
	});

	// Start the plan the client approved, and only that plan: it is compiled
	// again here and refused before any dispatch when its hash moved.
	options.transport.onRequest(ACP_FLEET_RUN_METHOD, async (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "name", "vars", "planHash", "resume"]));
		const control = requireFleet(options);
		const bound = getSession(request);
		// Refused, never queued: an approved plan describes the workspace as it
		// stands, and a turn still in flight is about to change it.
		requireIdle(bound, "start a fleet run");
		const name = fleetName(request.name);
		const vars = fleetVars(request.vars);
		if (typeof request.planHash !== "string" || !/^[0-9a-f]{64}$/u.test(request.planHash)) {
			throw new AcpRequestError(-32602, "planHash is invalid", { code: "invalid_params" });
		}
		// A playbook starts workers outside any tool call, so the session's limits
		// screen it as they screen /run, and every worker it starts carries them (Z1).
		const limits = standingLimits;
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

	const requireBoardActions = (): AcpBoardActions => {
		if (options.boardActions === undefined || options.board === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		return options.boardActions;
	};

	// The /decisions overlay's `s` and `c`. The record keeps the decision,
	// marked superseded; a correction's turn is returned for the client to send,
	// so it lands in the conversation as the terminal's does.
	options.transport.onRequest(ACP_DECISION_SUPERSEDE_METHOD, (params): AcpDecisionSupersedeResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "interviewId", "key", "correction"]));
		const actions = requireBoardActions();
		const bound = getSession(request);
		requireIdle(bound, "revise a decision");
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
		if (standingLimits?.readOnly === true) {
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
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "entryId", "scope", "acknowledgeGlobal"]));
		const actions = requireBoardActions();
		getSession(request);
		const entryId = requireBoundedClientString(request.entryId, "entryId", 256);
		if (request.scope !== "repo" && request.scope !== "global") {
			throw new AcpRequestError(-32602, "scope must be repo or global", { code: "invalid_params" });
		}
		// A proposal writes a memory record, which a read-only ceiling denies.
		if (standingLimits?.readOnly === true) {
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
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "label"]));
		const id = sessionIdOf(request);
		workspaceMeta(id);
		const label = requireBoundedClientString(request.label, "label", ACP_MAX_LABEL_BYTES, { allowEmpty: true });
		if (options.session === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		try {
			options.session.setName(label, id);
		} catch {
			throw new AcpRequestError(-32603, "session label could not be saved", { code: "internal_error" });
		}
		if (sessions.has(id)) {
			options.transport.notify("session/update", {
				sessionId: id,
				update: { sessionUpdate: "session_info_update", title: label.length > 0 ? label : null },
			});
		}
		return {};
	});

	options.transport.onRequest("session/delete", (params): AcpEmptyResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const id = sessionIdOf(request);
		const meta = workspaceMeta(id);
		// Delete never closes a session for the client: the refusal names the step that comes first (bt-12).
		const stillOpen =
			"session is still open; close it first (session/close, or the close action in the client that has it open), then delete it";
		if (sessions.has(id) || meta.endedAt === null) {
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

	options.transport.onRequest("session/set_mode", (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "modeId"]));
		const session = getSession(request);
		setAutonomy(session, request.modeId);
		publishReadouts(session.id);
		return {};
	});

	options.transport.onRequest(ACP_SESSION_TRUST_METHOD, (params) => {
		requireInitialized();
		const session = getSession(assertParamKeys(params, new Set(["sessionId"])));
		return { _meta: trustResultMeta(session.cwd) };
	});

	const setConfigOption = async (params: unknown) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "configId", "value", "type"]));
		const session = getSession(request);
		if (session.activePrompt !== null)
			throw new AcpRequestError(-32602, "cannot change configuration during an active prompt", {
				code: "prompt_active",
			});
		if (request.type !== undefined && request.type !== "select")
			throw new AcpRequestError(-32602, "invalid configuration type", { code: "invalid_params" });
		const value = request.value;
		if (typeof value !== "string")
			throw new AcpRequestError(-32602, "invalid configuration value", { code: "invalid_params" });
		switch (request.configId) {
			case "autonomy":
				setAutonomy(session, value);
				break;
			case "target":
			case "model": {
				if (request.configId === "model" && options.providers === undefined) {
					const modelOption = configOptions(options, listingFallbacks, session).find((option) => option.id === "model");
					const models =
						modelOption && Array.isArray(modelOption.options)
							? modelOption.options.flatMap((option) =>
									isRecord(option) && typeof option.value === "string" ? [option.value] : [],
								)
							: [];
					if (!models.includes(value)) throw modelNotDeclared(session.target, value, models);
					if (session.model !== value) {
						if (!options.setSessionRouting)
							throw new AcpRequestError(-32601, "model selection is unavailable", { code: "method_not_found" });
						options.setSessionRouting({ model: value }, handshake.clientSurface);
						session.model = value;
						notifyConfigOptions(session);
					}
					break;
				}
				if (!options.setSessionRouting || !options.providers)
					throw new AcpRequestError(-32601, "model selection is unavailable", { code: "method_not_found" });
				const target = request.configId === "target" ? value : session.target;
				if (request.configId === "target" && target !== session.target) await listTargetModels(target);
				const status = options.providers.list().find((item) => item.target.id === target);
				if (!target || !status) throw new AcpRequestError(-32602, "target is not available", { code: "invalid_params" });
				const models = targetModelCandidates(status);
				const defaultModel =
					safeStoredIdentifier(status.target.defaultModel, ACP_MAX_MODEL_ID_BYTES) ??
					safeStoredIdentifier(status.runtime?.defaultModel, ACP_MAX_MODEL_ID_BYTES) ??
					undefined;
				const model =
					request.configId === "model"
						? value
						: session.model && models.includes(session.model)
							? session.model
							: defaultModel;
				if (!model || (!models.includes(model) && !(target === session.target && model === session.model)))
					throw modelNotDeclared(target, model, models);
				try {
					const selected = selectModel(
						options.providers,
						{ target, model, thinkingLevel: session.thinkingLevel },
						(selected) => options.setSessionRouting?.(selected, handshake.clientSurface),
					);
					session.target = selected.target;
					session.model = selected.model;
					// The session keeps the level asked for; each model resolves what it does with it, shown as currentValue.
				} catch (error) {
					throw new AcpRequestError(-32602, "target cannot host this session model", {
						code: "invalid_params",
						reason: modelSelectionErrorText(error instanceof Error ? error.message : String(error), 1024),
					});
				}
				notifyConfigOptions(session);
				// The new route's thinking resolves from a cache that may be cold, so it probes as an opener does.
				refreshThinkingOption(session);
				break;
			}
			case "thinkingLevel": {
				if (!ACP_THINKING_LEVEL_SET.has(value as ThinkingLevel))
					throw new AcpRequestError(-32602, "invalid thinking level", { code: "invalid_params" });
				const requested = value as ThinkingLevel;
				// A level the model has runs; an unlisted one runs at the nearest listed level, returned as currentValue
				// with a notice. A model with no thinking at all refuses any level but off rather than keep it silently.
				const thinking = sessionThinking(options, session, session.model, requested);
				if (options.providers !== undefined && requested !== "off") {
					const levels = thinking?.supportedLevels ?? [];
					if (!levels.some((level) => level !== "off"))
						throw new AcpRequestError(
							-32602,
							`this model cannot run thinking ${requested}; it supports ${levels.length > 0 ? levels.join(", ") : "no thinking levels"}`,
							{ code: "invalid_params", reason: "thinking-unsupported" },
						);
				}
				if (session.thinkingLevel !== requested) {
					if (!options.setSessionRouting)
						throw new AcpRequestError(-32601, "thinking selection is unavailable", { code: "method_not_found" });
					const thinkingLevel =
						thinking?.effectiveLevel ?? clampThinkingLevel(options.providers, session.target, session.model, requested);
					options.setSessionRouting({ thinkingLevel }, handshake.clientSurface);
					session.thinkingLevel = requested;
					notifyConfigOptions(session);
				}
				break;
			}
			default:
				throw new AcpRequestError(-32602, "unknown configuration option", { code: "invalid_params" });
		}
		return { configOptions: configOptions(options, listingFallbacks, session) };
	};
	options.transport.onRequest("session/set_config_option", setConfigOption);
	options.transport.onRequest(ACP_SESSION_SET_MODEL_METHOD, async (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "modelId"]));
		if (typeof request.modelId !== "string")
			throw new AcpRequestError(-32602, "invalid model id", { code: "invalid_params" });
		await setConfigOption({ sessionId: request.sessionId, configId: "model", value: request.modelId });
		return {};
	});

	options.transport.onRequest(ACP_SETTINGS_GET_SAFE_METHOD, (params) => {
		requireInitialized();
		assertParamKeys(params, new Set());
		if (options.settings === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		return safeSettingsProjection(options.settings.read());
	});

	options.transport.onRequest(ACP_SETTINGS_PATCH_SAFE_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["patch"]));
		if (!isRecord(request.patch)) {
			throw new AcpRequestError(-32602, "patch must be an object", { code: "invalid_params" });
		}
		if (activePromptState !== null) {
			throw new AcpRequestError(-32602, "cannot patch settings during an active prompt", { code: "prompt_active" });
		}
		if (options.settings === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const patch: AcpSafeSettingsPatch = {};
		for (const [key, value] of Object.entries(request.patch)) {
			if (!(ACP_SAFE_SETTINGS_KEYS as ReadonlyArray<string>).includes(key)) {
				throw new AcpRequestError(-32602, "patch contains an unknown setting", { code: "invalid_params" });
			}
			switch (key) {
				case "chat.target": {
					if (value === null) {
						patch[key] = null;
						break;
					}
					const target = requireBoundedClientString(value, key, ACP_MAX_TARGET_ID_BYTES);
					if (options.providers?.getTarget(target) === null || options.providers === undefined) {
						throw new AcpRequestError(-32602, "target is not configured", {
							code: "invalid_params",
							reason: "target-unknown",
						});
					}
					patch[key] = target;
					break;
				}
				case "chat.model":
					patch[key] = value === null ? null : requireBoundedClientString(value, key, ACP_MAX_MODEL_ID_BYTES);
					break;
				case "chat.thinkingLevel":
					if (typeof value !== "string" || !ACP_THINKING_LEVEL_SET.has(value as ThinkingLevel)) {
						throw new AcpRequestError(-32602, "invalid thinking level", { code: "invalid_params" });
					}
					patch[key] = value as ThinkingLevel;
					break;
				case "safety.autonomy":
					if (!isAutonomyLevel(value)) {
						throw new AcpRequestError(-32602, "invalid autonomy level", { code: "invalid_params" });
					}
					refuseYolo(value);
					patch[key] = value;
					break;
			}
		}
		const current = options.settings.read();
		const nextTarget = patch["chat.target"] === undefined ? current.target : patch["chat.target"];
		const nextModel = patch["chat.model"] === undefined ? current.model : patch["chat.model"];
		if (nextTarget === null && nextModel !== null) {
			throw new AcpRequestError(-32602, "model requires a configured target", { code: "invalid_params" });
		}
		try {
			const committed = options.settings.commit(patch, handshake.clientSurface);
			const session = boundSessionId === null ? undefined : sessions.get(boundSessionId);
			if (
				session &&
				(patch["chat.target"] !== undefined ||
					patch["chat.model"] !== undefined ||
					patch["chat.thinkingLevel"] !== undefined)
			) {
				session.target = committed.target;
				session.model = committed.model;
				session.thinkingLevel = committed.thinkingLevel;
				notifyConfigOptions(session);
			}
			return safeSettingsProjection(committed);
		} catch {
			throw new AcpRequestError(-32603, "safe settings could not be updated", { code: "internal_error" });
		}
	});

	options.transport.onRequest(ACP_COMMANDS_LIST_METHOD, (params) => {
		requireInitialized();
		assertParamKeys(params, new Set());
		const listed = catalog();
		if (listed === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const prompts = options.commands?.prompts?.();
		const extensionCommands = options.commands?.extensionCommands?.();
		return {
			...listed,
			...(prompts !== undefined ? { prompts } : {}),
			...(extensionCommands !== undefined ? { extensionCommands } : {}),
		};
	});

	options.transport.onRequest(ACP_COMMANDS_INVOKE_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "command", "argv"]));
		const session = getSession(request);
		if (request.command === "context" || request.command === "compact") requireIdle(session, "run a context operation");
		if (options.commands === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		// Jobs belong to the one session this process hosts. The generic path forwards only command and
		// argv, so the requested identity is checked here, before anything is created, listed or stopped.
		if (request.command === "loop" && session.id !== boundSessionId) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		// Four of the thirteen put a user turn into the session. Doing that while
		// a prompt is in flight is the steering path, not the submit path: the
		// turn already running owns the stopReason, and a second unrequested
		// submission folds content into it that the client never asked for. Those
		// four are refused here and the client is told to use
		// `_pancode/session/steer` instead; the other nine are unaffected.
		if (session.activePrompt !== null && options.commands.injectsUserTurn(request.command, request.argv)) {
			throw new AcpRequestError(-32602, "this command submits a user turn and a prompt is active", {
				code: "prompt_active",
				reason: "steer-instead",
			});
		}
		if (activeShell !== null && options.commands.injectsUserTurn(request.command, request.argv)) {
			throw new AcpRequestError(-32602, "this command submits a user turn and a shell line is running", {
				code: "shell_active",
			});
		}
		// A prompt-turn command asks for approvals that bind to a call on the
		// wire, and outside a prompt there is no turn to put that call in. It is
		// refused here with the path that works, rather than admitted and denied.
		if (options.commands.promptTurn?.(request.command, request.argv) === true) {
			throw new AcpRequestError(-32602, "this command runs as a conversation turn; send it as a prompt", {
				code: "prompt_turn_required",
			});
		}
		assertCommandWithinCeiling(options.commands, request.command, request.argv);
		if (request.command !== "context" && request.command !== "compact")
			return options.commands.invoke({
				command: request.command,
				argv: request.argv,
				askConsent: reportConsentAsk(options.transport, session.id),
			});
		if (session.id !== boundSessionId)
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		if (activeShell !== null) throw new AcpRequestError(-32602, "a shell line is running", { code: "shell_active" });
		const command = Promise.resolve().then(() =>
			options.commands?.invoke({ command: request.command, argv: request.argv }),
		);
		contextCommandInFlight = command;
		return command.finally(() => {
			if (contextCommandInFlight === command) contextCommandInFlight = null;
		});
	});

	options.transport.onRequest(ACP_TARGETS_LIST_METHOD, (params): AcpTargetList => {
		requireInitialized();
		assertParamKeys(params, new Set());
		if (options.providers === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const targets: AcpSafeTargetProjection[] = [];
		let budgetExhausted = false;
		// Budget incrementally from the exact JSON representation. Re-serializing
		// the growing full result for every one of up to 4,096 model ids turns a
		// bounded config list into avoidable quadratic work.
		let budgetBytes = ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES;
		for (const status of options.providers.list()) {
			const projected = safeTargetProjection(status);
			if (projected === null) continue;
			const bounded: AcpSafeTargetProjection = { ...projected, models: [] };
			let boundedBytes = utf8Bytes(JSON.stringify(bounded));
			const targetSeparatorBytes = targets.length > 0 ? 1 : 0;
			if (budgetBytes + targetSeparatorBytes + boundedBytes > ACP_MAX_TARGET_LIST_RESULT_BYTES) {
				budgetExhausted = true;
				break;
			}
			targets.push(bounded);
			budgetBytes += targetSeparatorBytes + boundedBytes;
			for (const model of projected.models) {
				const candidateModels = [...bounded.models, model];
				const resolved = resolveRuntimeTarget(options.providers, {
					targetId: projected.id,
					wireModelId: model,
					requestedThinkingLevel: "off",
					use: "orchestrator",
				});
				const thinkingLevels = {
					...bounded.thinkingLevels,
					...(resolved.ok ? { [model]: Array.from(resolved.target.modelRuntime.thinking.supportedLevels) } : {}),
				};
				const candidate = { ...bounded, models: candidateModels, thinkingLevels };
				const candidateBytes = utf8Bytes(JSON.stringify(candidate));
				if (budgetBytes + candidateBytes - boundedBytes > ACP_MAX_TARGET_LIST_RESULT_BYTES) {
					budgetExhausted = true;
					bounded.modelsTruncated = true;
					break;
				}
				bounded.models.push(model);
				bounded.thinkingLevels = thinkingLevels;
				budgetBytes += candidateBytes - boundedBytes;
				boundedBytes = candidateBytes;
			}
			if (budgetExhausted) break;
			if (targets.length === ACP_MAX_TARGETS) break;
		}
		return {
			targets,
			...(budgetExhausted ? { _meta: { [ACP_TRUNCATED_META_KEY]: true } } : {}),
		};
	});

	options.transport.onRequest(ACP_TARGETS_PROBE_METHOD, async (params): Promise<AcpTargetProbe> => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["targetId"]));
		const targetId = requireBoundedClientString(request.targetId, "targetId", ACP_MAX_TARGET_ID_BYTES);
		if (options.providers === undefined)
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		if (options.providers.getTarget(targetId) === null) {
			throw new AcpRequestError(-32602, "target is not configured", {
				code: "invalid_params",
				reason: "target-unknown",
			});
		}
		try {
			// An operator's check asks the provider itself. A runtime that answers from its cached listing
			// records no health, so a cached answer read as unreachable on a working target.
			const status = await options.providers.probeTarget(targetId, { reasoning: false, fresh: true });
			if (status === null) return { targetId, healthy: false, latencyMs: null, reason: "probe-failed" };
			for (const session of sessions.values()) if (session.target === targetId) notifyConfigOptions(session);
			const reason = safeProbeReason(options.providers, status);
			const latencyMs =
				typeof status.health.latencyMs === "number" &&
				Number.isFinite(status.health.latencyMs) &&
				status.health.latencyMs >= 0
					? Math.round(status.health.latencyMs)
					: null;
			const component = reason === "component-missing" ? probeMissingComponent(status) : null;
			return { targetId, healthy: reason === null, latencyMs, reason, ...(component !== null ? { component } : {}) };
		} catch {
			return { targetId, healthy: false, latencyMs: null, reason: "probe-failed" };
		}
	});

	const cancelSession = (session: AcpServerSession, reason: string, operationId?: string): boolean => {
		if (operationId !== undefined) {
			if (session.id !== boundSessionId) return false;
			const operation = contextActivity?.operation;
			if (
				!operation ||
				operation.id !== operationId ||
				operation.sessionId !== session.id ||
				operation.cwd !== canonicalCwd ||
				operation.outcome !== undefined
			)
				return false;
			if (
				operation.kind === "context-init" ||
				operation.kind === "context-refresh" ||
				operation.kind === "context-clear"
			) {
				if (options.cancelContextOperation?.(session.id, canonicalCwd, operationId) !== true) return false;
			} else if (operation.kind !== "compaction" && operation.kind !== "context-recover") return false;
		} else if (session.id === boundSessionId) options.cancelContextOperation?.(session.id, canonicalCwd);
		// A shell line never runs beside a prompt, so this stops whichever of the two is running.
		if (activeShell?.sessionId === session.id) activeShell.abort.abort();
		if (activeSessionId === session.id || activeSessionId === null) permission.cancelPending(reason);
		if ((activeSessionId ?? boundSessionId) === session.id) {
			options.interviews?.cancel();
			options.elicitation?.cancel();
		}
		if (!session.activePrompt) {
			if ((contextCommandInFlight !== null || operationId !== undefined) && session.id === boundSessionId)
				options.chat.cancel();
			return true;
		}
		session.activePrompt.cancelled = true;
		session.activePrompt.expansionAbort?.abort();
		options.chat.cancel();
		return true;
	};

	const contextCancellationId = (params: unknown): string | undefined => {
		if (!isRecord(params) || params._meta === undefined) return undefined;
		if (!isRecord(params._meta))
			throw new AcpRequestError(-32602, "cancel metadata must be an object", { code: "invalid_params" });
		if (!Object.hasOwn(params._meta, ACP_CONTEXT_META_KEY)) return undefined;
		const context = params._meta[ACP_CONTEXT_META_KEY];
		if (!isRecord(context))
			throw new AcpRequestError(-32602, "context cancellation requires operationId", { code: "invalid_params" });
		return requireBoundedClientString(context.operationId, "operationId", 128);
	};
	const cancel = (params: unknown): Record<string, unknown> => {
		requireInitialized();
		const operationId = contextCancellationId(params);
		const cancelled = cancelSession(getSession(params), "prompt cancelled", operationId);
		return operationId === undefined ? {} : { _meta: { [ACP_CONTEXT_META_KEY]: { operationId, cancelled } } };
	};
	// ACP defines session/cancel only as a notification; a client that waits for the stop, or for a context operation's
	// acknowledgement, asks through the extension method.
	options.transport.onRequest(ACP_SESSION_CANCEL_METHOD, cancel);
	// `$/cancel_request` naming a running prompt stops it as session/cancel does, and the prompt answers `cancelled`.
	const unsubscribePromptCancel =
		options.transport.onRequestCancel?.("session/prompt", (params) => {
			if (!handshake.initialized || !isRecord(params) || typeof params.sessionId !== "string") return false;
			const session = sessions.get(params.sessionId);
			if (session === undefined || session.activePrompt === null) return false;
			cancelSession(session, "prompt cancelled");
			return true;
		}) ?? (() => {});
	// `$/cancel_request` naming a running shell line kills it through its abort signal; the line then answers once with
	// `cancelled: true` and closes its tool call as failed, so it never finishes and records after a -32800.
	const unsubscribeShellCancel =
		options.transport.onRequestCancel?.(ACP_SESSION_SHELL_METHOD, (params) => {
			if (!handshake.initialized || !isRecord(params) || typeof params.sessionId !== "string") return false;
			if (activeShell === null || activeShell.sessionId !== params.sessionId) return false;
			activeShell.abort.abort();
			return true;
		}) ?? (() => {});
	options.transport.onNotification("session/cancel", (params) => {
		// A notification has no reply channel, so an ordering or identity error
		// has nowhere to go. Dropping it silently is the only conformant option.
		if (!handshake.initialized) return;
		const id = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null;
		const session = id === null ? undefined : sessions.get(id);
		if (session) {
			try {
				cancelSession(session, "prompt cancelled", contextCancellationId(params));
			} catch {
				/* Malformed scoped notifications have no reply channel and must never become generic cancels. */
			}
		}
	});

	/**
	 * Windows in which a steer must not be queued, or null when it may be.
	 *
	 * The engine resubmits a steer it never drained as a fresh prompt
	 * (`resubmitStrandedSteers`). In a terminal that is the right answer; here it
	 * is a prompt-shaped turn the client never requested, whose stop reason has
	 * no request to ride home on. The two windows where stranding is certain are
	 * knowable from the session, so the server refuses in them and says why,
	 * rather than accepting a steer that would come back as an unrequested turn.
	 */
	const steerRefusal = (session: AcpServerSession): string | null => {
		if (session.activePrompt === null) {
			return "no prompt is active on this session; send session/prompt instead of steering";
		}
		if (session.activePrompt.cancelled) {
			return "this prompt is cancelled and its queues are being cleared; prompt again once it returns";
		}
		// A steer the engine never drains is resubmitted as a fresh turn, and a scheduled turn has no request to carry that one home.
		if (session.activePrompt.scheduled !== undefined) {
			return "a scheduled job turn is running; cancel it, or prompt once it finishes";
		}
		if (!options.chat.isStreaming()) {
			return "the run is not streaming, so the engine has no slot to drain this steer into";
		}
		return null;
	};

	options.transport.onRequest(ACP_SESSION_STEER_METHOD, async (params): Promise<AcpSteerResult> => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "text", "mode"]));
		const session = getSession(request);
		const text = requireSteerText(request.text, "text", ACP_MAX_STEER_TEXT_BYTES);
		if (
			request.mode !== undefined &&
			(typeof request.mode !== "string" || !(ACP_STEERING_MODES as ReadonlyArray<string>).includes(request.mode))
		) {
			throw new AcpRequestError(-32602, "invalid steering mode", { code: "invalid_params" });
		}
		const mode = (request.mode ?? "next-slot") as AcpSteeringMode;
		const queue = mode === "next-slot" ? "steer" : "follow-up";
		const enqueue = mode === "next-slot" ? options.chat.steer : options.chat.queueFollowUp;
		if (enqueue === undefined) {
			return { accepted: false, queue, refusal: "this agent build does not expose the engine steering queues" };
		}
		const refusal = steerRefusal(session);
		if (refusal !== null) return { accepted: false, queue, refusal };
		if (options.chat.discoverOperatorEgg && (await options.chat.discoverOperatorEgg(text)))
			return { accepted: true, queue };
		// The engine's own admission is the last word: it refuses a steer whose
		// run stopped streaming between the check above and this call.
		if (!enqueue.call(options.chat, text)) {
			return { accepted: false, queue, refusal: "the engine refused the message; the run is no longer accepting input" };
		}
		return { accepted: true, queue };
	});

	options.transport.onRequest(ACP_SESSION_QUEUE_METHOD, (params): AcpQueueResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		getSession(request);
		// An empty pair of lists is a fact about the queues, so a build that
		// cannot read them refuses instead of reporting one it did not observe.
		if (options.chat.queuedMessages === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const queued = options.chat.queuedMessages();
		return {
			steer: boundedQueueTexts(queued.steer),
			followUp: boundedQueueTexts(queued.followUp),
			...(options.chat.queueEntries !== undefined ? { entries: projectQueueEntries(options.chat.queueEntries()) } : {}),
		};
	});

	options.transport.onRequest(ACP_SESSION_QUEUE_CLEAR_METHOD, (params): AcpQueueClearResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		getSession(request);
		if (options.chat.clearQueuedFollowUps === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		// Both queues drain together, exactly as the queue navigator's a does in the terminal: the
		// returned texts are what the client now owns and must re-send to deliver. A clear whose texts the
		// response could not carry whole is refused before anything drains, so no queued text is lost.
		const pending = options.chat.restorableQueuedTexts?.();
		if (pending !== undefined && !restorableWhole(pending)) {
			throw new AcpRequestError(
				-32602,
				`the queue holds more than ${ACP_MAX_RESTORED_MESSAGES} entries or ${ACP_MAX_STEER_TEXT_BYTES} bytes in one entry; remove entries one at a time`,
				{ code: "queue_too_large" },
			);
		}
		const restored = options.chat.clearQueuedFollowUps();
		return {
			restored: restored.slice(0, ACP_MAX_RESTORED_MESSAGES).map((text) => boundString(text, ACP_MAX_STEER_TEXT_BYTES)),
		};
	});

	/** The chat loop's per-entry queue operations, bound, or a refusal when this build has none. */
	const queueControl = () => {
		const chat = options.chat;
		if (
			chat.queueEntries === undefined ||
			chat.removeQueuedEntry === undefined ||
			chat.moveQueuedEntry === undefined ||
			chat.setQueuedEntryKind === undefined
		) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		return {
			entries: chat.queueEntries.bind(chat),
			remove: chat.removeQueuedEntry.bind(chat),
			move: chat.moveQueuedEntry.bind(chat),
			setKind: chat.setQueuedEntryKind.bind(chat),
		};
	};

	options.transport.onRequest(ACP_QUEUE_EDIT_METHOD, (params): AcpQueueEditResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "id", "op", "delta", "kind"]));
		const session = getSession(request);
		const queue = queueControl();
		const id = requireBoundedClientString(request.id, "id", ACP_MAX_QUEUE_ENTRY_ID_BYTES);
		if (typeof request.op !== "string" || !(ACP_QUEUE_EDIT_OPS as ReadonlyArray<string>).includes(request.op)) {
			throw new AcpRequestError(-32602, `op must be one of ${ACP_QUEUE_EDIT_OPS.join(", ")}`, {
				code: "invalid_params",
			});
		}
		const op = request.op as AcpQueueEditOp;
		// Each operand belongs to one op. Accepting it on another would promise
		// an effect that op never has.
		if (
			(request.delta !== undefined) !== (op === "move") ||
			(op === "move" && request.delta !== -1 && request.delta !== 1)
		) {
			throw new AcpRequestError(-32602, "move takes delta -1 or 1, and no other op takes delta", {
				code: "invalid_params",
			});
		}
		if (
			(request.kind !== undefined) !== (op === "set_kind") ||
			(op === "set_kind" && request.kind !== "steer" && request.kind !== "follow-up")
		) {
			throw new AcpRequestError(-32602, "set_kind takes kind steer or follow-up, and no other op takes kind", {
				code: "invalid_params",
			});
		}
		// Every answer carries the queue as it now stands, so a client redraws
		// from the reply and never from its own guess at what the op did.
		const answer = (fields: Omit<AcpQueueEditResult, "entries">): AcpQueueEditResult => ({
			...fields,
			entries: projectQueueEntries(queue.entries()),
		});
		const stale = () => answer({ applied: false, reason: "stale-entry" });
		if (!queue.entries().some((entry) => entry.id === id)) return stale();
		switch (op) {
			case "remove":
				return queue.remove(id, "removed") === null ? stale() : answer({ applied: true });
			case "restore": {
				// The terminal's `e`: the entry leaves the queue and its text is the client's draft again.
				const taken = queue.remove(id, "to-editor");
				return taken === null
					? stale()
					: answer({ applied: true, text: boundString(taken.text, ACP_MAX_STEER_TEXT_BYTES) });
			}
			case "move":
				return queue.move(id, request.delta as -1 | 1)
					? answer({ applied: true })
					: answer({ applied: false, reason: "at-edge" });
			case "set_kind":
				return queue.setKind(id, request.kind as AcpQueuedEntryKind) ? answer({ applied: true }) : stale();
			case "send_now": {
				const active = session.activePrompt;
				if (active === null) return answer({ applied: false, reason: "no-active-prompt" });
				if (active.cancelled || !active.acceptsContinuation) return answer({ applied: false, reason: "prompt-ending" });
				if (!options.chat.isStreaming()) return answer({ applied: false, reason: "not-streaming" });
				const refusal = options.chat.interruptRefusal?.() ?? null;
				const taken = queue.remove(id, "sent-now");
				if (taken === null) return stale();
				// The navigator's Enter: the entry leaves the queue and is resubmitted
				// as an interrupt. The chat loop cancels the run, holds the rest of the
				// queue for the fresh prompt and starts it. When it refuses the
				// interrupt (an attached dispatch, a parked permission ask) it puts the
				// text at the head of the steering queue instead, with a notice.
				const run = options.chat.submit(taken.text, {
					steering: "interrupt",
					continuesMessage: { id: taken.id, enqueuedAt: taken.enqueuedAt },
					...(taken.display !== undefined ? { display: taken.display } : {}),
					...(taken.referencedPaths !== undefined && taken.referencedPaths.length > 0
						? { workingContextPaths: [...taken.referencedPaths] }
						: {}),
				});
				// Observed here so a rejection that lands before the prompt handler
				// reaches its continuation is not reported as unhandled; the handler
				// still awaits `run` and records the failure on the turn.
				run.catch(() => {});
				const previous = active.continuation;
				active.continuation = previous === null ? run : Promise.all([previous, run]).then(() => {});
				return answer({
					applied: true,
					delivery: refusal === null ? "interrupt" : "next-slot",
					text: boundString(taken.text, ACP_MAX_STEER_TEXT_BYTES),
					...(refusal !== null ? { refusal } : {}),
				});
			}
		}
	});

	options.transport.onRequest(ACP_SESSION_SHELL_METHOD, async (params): Promise<AcpShellResult> => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "command", "excludeFromContext"]));
		const session = getSession(request);
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
		if (standingLimits?.readOnly === true || !turnAllowsTool(standingLimits, ToolNames.Bash)) {
			throw new AcpRequestError(
				-32602,
				standingLimits?.readOnly === true
					? "a shell line can write and the ceiling is read-only. Nothing ran"
					: "a shell line runs bash and the ceiling withholds it. Nothing ran",
				{ code: "ceiling_refused" },
			);
		}
		if (closingSessions.has(session.id)) {
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		}
		// The terminal's two admission guards. A turn's context would change
		// underneath it when the line's entry lands, and one line runs at a time.
		if (session.activePrompt !== null || options.chat.isStreaming()) {
			throw new AcpRequestError(-32602, "a turn is running; cancel it before running a shell line", {
				code: "prompt_active",
			});
		}
		if (contextCommandInFlight !== null || activeShell !== null) {
			throw new AcpRequestError(-32602, "a shell line is already running; cancel it first", { code: "shell_active" });
		}
		if (durable.current()?.id !== session.id) durable.resume(session.id);
		const abort = new AbortController();
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		activeShell = { sessionId: session.id, abort, settled };
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
			const sentAt = now();
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
					...(handshake.toolProgressEnabled ? { onUpdate } : {}),
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
			if (activeShell?.abort === abort) activeShell = null;
			settle();
		}
	});

	options.transport.onRequest(ACP_SESSION_INTERRUPT_METHOD, (params): AcpInterruptResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "reason"]));
		const session = getSession(request);
		const reason =
			request.reason === undefined
				? null
				: requireBoundedClientString(request.reason, "reason", ACP_MAX_INTERRUPT_REASON_BYTES);
		if (session.activePrompt === null) {
			return { cancelled: false, refusal: "no prompt is active on this session" };
		}
		// An attached dispatch or a parked permission ask refuses the interrupt in
		// the terminal too. Honour that here instead of cancelling anyway: the
		// client gets the reason to show, and `session/cancel` remains the
		// unconditional stop for a client that means to pay the cost.
		const refusal = options.chat.interruptRefusal?.() ?? null;
		if (refusal !== null) return { cancelled: false, refusal };
		// Cancel only. The outstanding `session/prompt` returns
		// `stopReason: "cancelled"`, and the next prompt is the client's to send;
		// a server-side resubmit would start a turn with no request to answer.
		cancelSession(session, reason === null ? "prompt interrupted by client" : `client interrupt: ${reason}`);
		return { cancelled: true };
	});

	options.transport.onRequest(ACP_DISPATCH_STEER_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "runId", "action", "message"]));
		getSession(request);
		const runId = requireBoundedClientString(request.runId, "runId", ACP_MAX_DISPATCH_ID_BYTES);
		if (request.action !== "guide" && request.action !== "cancel") {
			throw new AcpRequestError(-32602, "action must be guide or cancel", { code: "invalid_params" });
		}
		if (request.action === "cancel" && request.message !== undefined) {
			// An abort carries no operator text anywhere in dispatch, so accepting
			// one here would promise the worker a message it never receives.
			throw new AcpRequestError(-32602, "cancel carries no message", { code: "invalid_params" });
		}
		const dispatch = options.dispatch;
		if (dispatch === undefined) return { accepted: false, reason: "dispatch-unavailable" };
		if (request.action === "cancel") {
			// `abort` reports nothing, so the fact has to be established before it
			// is claimed: an abort against an id this fleet never ran would poison
			// that control root for a future attempt and still answer "accepted".
			let live = false;
			try {
				const snapshot = dispatch.snapshot();
				live = snapshot.running.some((run) => run.runId === runId) || snapshot.retrying.some((run) => run.runId === runId);
			} catch {
				return { accepted: false, reason: "fleet-unavailable" };
			}
			if (!live) return { accepted: false, reason: "run-not-active" };
			try {
				dispatch.abort(runId);
			} catch {
				return { accepted: false, reason: "cancel-failed" };
			}
			return { accepted: true };
		}
		const message = requireSteerText(request.message, "message", ACP_MAX_STEER_TEXT_BYTES);
		try {
			dispatch.steer(runId, message);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			options.diagnostics?.(`dispatch steer refused: ${acpErrorMessage(detail)}`);
			return { accepted: false, reason: dispatchSteerReason(detail) };
		}
		// Queued, not delivered. The frame is on the worker's stdin; the worker
		// acknowledges acceptance later with `pancode_steer_received`, and that
		// ack's `sequence` never returns through this contract, so no sequence is
		// reported rather than a guessed one.
		return { accepted: true };
	});

	options.transport.onRequest("session/close", (params) => {
		requireInitialized();
		const id = sessionIdOf(params);
		// Idempotent: a client tearing down cannot always know whether the server
		// already dropped the session, and a second close is not an error.
		if (!sessions.has(id) && closedSessionIds.has(id)) return {};
		const inFlightClose = closingSessions.get(id);
		if (inFlightClose) return inFlightClose;
		const session = getSession(params);
		const close = (async (): Promise<Record<string, never>> => {
			const aside = asideRound?.sessionId === session.id ? asideRound : null;
			aside?.abort.abort();
			// The prompt writer must settle before the durable session is closed.
			cancelSession(session, "session closed");
			if (session.activePrompt) {
				if (promptSettled) await promptSettled;
			}
			if (contextCommandInFlight !== null && session.id === boundSessionId)
				await contextCommandInFlight.catch(() => undefined);
			// The aborted line still appends its entry; the ledger must outlive that write.
			if (activeShell?.sessionId === session.id) await activeShell.settled;
			if (aside !== null) await settleAcpWork([aside.settled]);
			if (options.session?.current()?.id === session.id) {
				await checkpointBeforeClose(session.id, "close");
				await options.session.close();
			}
			await options.mcpCapabilities?.detachClientServers();
			sessions.delete(session.id);
			if (boundSessionId === session.id) boundSessionId = null;
			sessionCreated = false;
			closedSessionIds.add(session.id);
			// A reopened fork parent closes as itself, so a later request is no longer told a fork replaced it.
			replacedSessions.delete(session.id);
			return {};
		})();
		closingSessions.set(id, close);
		void close.then(
			() => closingSessions.delete(id),
			() => closingSessions.delete(id),
		);
		return close;
	});

	/** Streams a turn's chat events as frames. A prompt and a scheduled main turn share it, so neither forks the projection. */
	const attachTurnObserver = (sessionId: string, active: ActivePrompt): (() => void) => {
		const onTurnEvent = (event: AcpServerEvent) => {
			handleChatEvent(event, options.transport, sessionId, active, canonicalCwd, options.diagnostics, () => {
				permission.cancelPending("tool call limit exceeded");
				options.toolRegistry?.cancelParkedCalls("tool call limit exceeded");
				options.chat.cancel();
			});
			observeTelemetry(telemetry, event, active);
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
		const session = boundSessionId === null ? undefined : sessions.get(boundSessionId);
		const jobId = safeStoredIdentifier(request.jobId, ACP_MAX_DISPATCH_ID_BYTES);
		if (!handshake.initialized || session === undefined || jobId === null) {
			return deferred("This ACP connection has no bound session to show a scheduled turn in.");
		}
		if (
			request.sessionId !== session.id ||
			request.cwd !== canonicalCwd ||
			options.session === undefined ||
			options.session.current()?.id !== session.id
		) {
			return deferred("The scheduled turn's session or workspace is not the one this client is bound to.");
		}
		if (request.signal.aborted) return deferred("The occurrence was cancelled before its turn could be shown.");
		if (
			machineLease !== null ||
			session.activePrompt !== null ||
			activePromptState !== null ||
			contextCommandInFlight !== null ||
			activeShell !== null ||
			handoffPreparing ||
			options.chat.isStreaming()
		) {
			return deferred("The conversation is busy; the job keeps its pending delivery.");
		}
		const active = createActivePromptState({ enabled: handshake.toolProgressEnabled, now });
		// A queue send-now would resubmit through this lease and strand the successor with no observer.
		active.acceptsContinuation = false;
		const scheduled: NonNullable<ActivePrompt["scheduled"]> = {
			jobId,
			opened: false,
			open: () => {
				scheduled.opened = true;
				forwardJobTurn(jobId);
			},
		};
		active.scheduled = scheduled;
		const lease = { jobId, active };
		machineLease = lease;
		session.activePrompt = active;
		activePromptState = active;
		activeSessionId = session.id;
		// A reviewed document describes the conversation as it stood; a scheduled turn moves it too.
		pendingHandoff = null;
		promptSerial++;
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		promptSettled = settled;
		options.onActiveSessionAutonomyChange?.(session.autonomy);
		telemetry.turnStarted(active.turn);
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
				void telemetry
					.turnSettled()
					.catch(() => options.diagnostics?.("a scheduled turn's final telemetry frame failed"))
					.then(() => {
						if (machineLease === lease) machineLease = null;
						if (session.activePrompt === active) session.activePrompt = null;
						if (activePromptState === active) activePromptState = null;
						if (activeSessionId === session.id && activePromptState === null) {
							activeSessionId = null;
							options.onActiveSessionAutonomyChange?.(null);
						}
						if (promptSettled === settled) promptSettled = null;
						if (scheduled.opened) forwardJobTurn(jobId);
						settle();
					});
			},
		};
	};
	const unbindMachineTurns = options.chat.bindMachineTurnProjection?.({ acquire: acquireMachineTurn });

	options.transport.onRequest("session/prompt", async (params): Promise<AcpPromptResponse> => {
		requireInitialized();
		const session = getSession(params);
		const promptCeiling = requestCeiling(params, "ACP prompt ceiling");
		assertCeilingEnforceable(promptCeiling);
		if (contextCommandInFlight !== null || session.activePrompt || options.chat.isStreaming()) {
			throw new AcpRequestError(-32602, "this session already has an active prompt", { code: "prompt_active" });
		}
		// The line rebuilds the chat's context when it settles, which aborts a
		// run in flight, so a turn waits for it exactly as it waits for a turn.
		if (contextCommandInFlight !== null || activeShell !== null) {
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
		if (typed === "loop" && session.id !== boundSessionId) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		const screened =
			text.length === 0 || (typed !== undefined && availableCommands().some((entry) => entry.name === typed))
				? undefined
				: options.commands?.screenPrompt?.(text);
		if (screened?.kind === "refuse") throw new AcpRequestError(-32602, screened.message, { code: screened.code });
		const sentText = screened?.kind === "send" ? screened.text : text;
		if (images.length > 0 && options.expandPrompt === undefined)
			throw new AcpRequestError(-32602, "this agent does not accept image blocks", { code: "invalid_params" });
		// Check the same credential authority as the runtime, without resolving or
		// echoing a secret. Desktop services do not inherit a terminal's API keys.
		const targetId = routingSnapshot().target;
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
		pendingHandoff = null;
		promptSerial++;
		const active = createActivePromptState({ enabled: handshake.toolProgressEnabled, now });
		session.activePrompt = active;
		activePromptState = active;
		activeSessionId = session.id;
		// Transport close waits on this so the session store never stops while the
		// chat loop is still persisting an aborted turn.
		let settle: () => void = () => {};
		promptSettled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		options.onActiveSessionAutonomyChange?.(session.autonomy);
		// Prompt admission also bounds command-injected turns and resubmits,
		// while the session schema ceiling stays fixed (#423).
		const ceilingEcho =
			options.chat.setToolCeiling !== undefined
				? ceilingMeta(applyCeilings([session.ceiling, promptCeiling], "prompt"))
				: undefined;
		const respond = (stopReason: string): AcpPromptResponse =>
			promptResponse(stopReason, active, liveSessionView(), handshake.fullUsageEnabled, ceilingEcho);
		telemetry.turnStarted(active.turn);
		const unsubscribe = attachTurnObserver(session.id, active);
		try {
			// Startup notices are operator advice about the project, not the
			// answer, so they cross as session_info_update metadata the way the
			// memory and eggs state does: a client that ignores `_meta` shows a
			// reply carrying only the model's text. They wait for the first prompt
			// so the client has bound the session id, and they do not count toward
			// admission: a refused prompt must still fail as prompt_not_admitted.
			if (startupHintsSessionId !== session.id) {
				startupHintsSessionId = session.id;
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
			runtimeNotices.flush(session.id);
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
				availableCommands().some((entry) => entry.name === command)
			) {
				let argv = commandMatch?.[2]?.trim().split(/\s+/u) ?? [];
				if (command === "loop") {
					// A whitespace split would cut a quoted task or program argument into words and keep the quotes.
					const words = tokenizeLoopLine(commandMatch?.[2] ?? "");
					if ("error" in words) throw new AcpRequestError(-32602, words.error, { code: "invalid_params" });
					argv = words.tokens;
				}
				if (options.commands !== undefined) assertCommandWithinCeiling(options.commands, command, argv);
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
			if (promptCeiling !== undefined) applyCeilings([session.ceiling], "prompt");
			active.acceptsContinuation = false;
			unsubscribe();
			// The last meter and plan frames precede the response they total, and the response repeats their usage.
			active.settledUsage = await telemetry.turnSettled();
			if (session.activePrompt === active) session.activePrompt = null;
			if (activePromptState === active) activePromptState = null;
			if (activeSessionId === session.id) {
				// The turn's closing frame follows its last update and reads the window while the session still holds it.
				const closing = readoutsSession(session.id);
				if (closing !== null) readouts.turnEnd(closing);
				activeSessionId = null;
				options.onActiveSessionAutonomyChange?.(null);
			}
			promptSettled = null;
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
				(sessionId) => handshake.initialized && sessions.has(sessionId),
				(update) => options.transport.notify(ACP_TELEMETRY_UPDATE_NOTIFICATION, update),
			)
		: undefined;
	const detachInterviews = options.interviews?.attach({
		transport: options.transport,
		sessionId: () => activeSessionId ?? boundSessionId,
		enabled: () => handshake.initialized && handshake.interviewsEnabled,
		timeoutMs: interviewWindowMs,
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
	});
	const detachElicitation = options.elicitation?.attach({
		transport: options.transport,
		sessionId: () => activeSessionId ?? boundSessionId,
		enabled: () => handshake.initialized && handshake.elicitationEnabled,
		timeoutMs: () => handshake.elicitationTimeoutMs ?? permissionTimeoutMs,
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
	});
	options.onReady?.();
	return await new Promise<number>((resolve) => {
		options.transport.onClose(() => {
			telemetry.dispose();
			unsubscribeTelemetryUpdates?.();
			detachInterviews?.();
			detachElicitation?.();
			// Unbound first: a scheduled turn must be refused, never run where no client can see it.
			unbindMachineTurns?.();
			permission.unregister();
			unsubscribeEventStream();
			permission.cancelPending("ACP transport closed");
			unsubscribeQueueEvents();
			unsubscribeReadouts();
			unsubscribeAdmission();
			unsubscribeToolBodyStart();
			unsubscribePromptCancel();
			unsubscribeShellCancel();
			const aside = asideRound;
			aside?.abort.abort();
			for (const session of sessions.values()) cancelSession(session, "ACP transport closed");
			const settling = [
				promptSettled,
				activeShell?.settled ?? null,
				contextCommandInFlight,
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
