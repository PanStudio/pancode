// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { realpathSync } from "node:fs";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../core/defaults.js";
import { MAX_TIMER_DELAY_MS } from "../core/timers.js";
import type { AcpLiveTelemetry } from "./live-telemetry.js";
import { createAcpLiveTelemetry } from "./live-telemetry.js";
import { registerAcpServerBoard } from "./server-board.js";
import { registerAcpServerBranches } from "./server-branches.js";
import { registerAcpServerCatalog, settleAcpWork } from "./server-catalog.js";
import { createAcpServerCommands } from "./server-commands.js";
import { createAcpServerConfig } from "./server-config.js";
import { registerAcpServerContext } from "./server-context.js";
import { createAcpServerControl } from "./server-control.js";
import { createAcpServerEvents } from "./server-events.js";
import { createAcpServerGuards } from "./server-guards.js";
import { registerAcpServerHandoff } from "./server-handoff.js";
import { createAcpHandshake } from "./server-handshake.js";
import { createAcpServerMachine } from "./server-machine.js";
import { createAcpServerOpen } from "./server-open.js";
import type { AcpHandshake, PancodeAcpServerOptions } from "./server-options.js";
import { branchesWired, handoffWired, queueEditWired, shellWired } from "./server-options.js";
import { installPermissionBridge } from "./server-permissions.js";
import { registerAcpServerPrompt } from "./server-prompt.js";
import { createAcpServerReadouts } from "./server-readouts.js";
import type { AcpServerScope } from "./server-scope.js";
import { registerAcpServerShell } from "./server-shell.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import {
	newestOpenToolCallId,
	ORCHESTRATOR_UPDATE_META,
	openWireIdFor,
	sendUpdate,
	textContent,
} from "./server-tool-updates.js";
import { ACP_TELEMETRY_UPDATE_NOTIFICATION, subscribeTelemetryUpdates } from "./telemetry-methods.js";
import {
	ACP_COMMANDS_INVOKE_METHOD,
	ACP_COMMANDS_LIST_METHOD,
	ACP_NOTICE_META_KEY,
	ACP_PERMISSION_WITHDRAW_METHOD,
} from "./types.js";

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
		get open() {
			return open;
		},
		get machine() {
			return machine;
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
	const open = createAcpServerOpen(scope);
	registerAcpServerCatalog(scope);
	registerAcpServerBoard(scope);
	registerAcpServerBranches(scope);
	registerAcpServerHandoff(scope);
	registerAcpServerContext(scope);
	const control = createAcpServerControl(scope);
	registerAcpServerShell(scope);
	const machine = createAcpServerMachine(scope);
	registerAcpServerPrompt(scope);

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
			machine.unbindMachineTurns?.();
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
