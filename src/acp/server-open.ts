// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's session opening: new sessions, and restoring stored ones through load and resume. */

import { randomUUID } from "node:crypto";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { isRecord } from "../core/type-guards.js";
import type { SessionMeta } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { liveSessionOwner } from "../domains/session/live-owner.js";
import { resumedSessionRoute } from "../domains/session/resumed-route.js";
import type { AgentMessage } from "../engine/types.js";
import { DEFAULT_AUTONOMY_LEVEL } from "../lib/autonomy/autonomy.js";
import { restoreSession as restoreControlledSession } from "../session-control/index.js";
import type { McpClientServerSpec } from "../tools/gateway/mcp-capability-types.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import { safeConfiguredIdentifier, safeStoredIdentifier } from "./server-bounds.js";
import { replayDispatchTerminals } from "./server-event-frames.js";
import { ACP_MAX_SESSION_ID_BYTES, assertCeilingEnforceable, assertParamKeys, sessionIdOf } from "./server-guards.js";
import { assertNoAdditionalDirectories, parseClientMcpServers } from "./server-handshake.js";
import { modelsResultMeta, sessionConfig } from "./server-models.js";
import type { AcpRoutingSnapshot, PancodeAcpServerOptions } from "./server-options.js";
import { requestCeiling } from "./server-prompt-input.js";
import type { PreparedAcpReplay } from "./server-replay.js";
import { prepareAcpReplay, sessionResultMeta, withReplayUsage } from "./server-replay.js";
import type { AcpServerScope } from "./server-scope.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import { loadFailure } from "./server-tool-updates.js";
import { trustResultMeta } from "./trust-notice.js";
import { ACP_MAX_MODEL_ID_BYTES, ACP_MAX_TARGET_ID_BYTES, ACP_SESSION_META_KEY } from "./types.js";

export async function attachClientMcpServers(
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

export function routingSnapshot(options: PancodeAcpServerOptions): AcpRoutingSnapshot {
	const route = options.routing?.() ?? { target: null, model: null };
	return {
		target: safeConfiguredIdentifier(route.target, ACP_MAX_TARGET_ID_BYTES),
		model: safeConfiguredIdentifier(route.model, ACP_MAX_MODEL_ID_BYTES),
	};
}

export interface PreparedRestore {
	leafTurnId: string | null;
	replayMessages: ReadonlyArray<AgentMessage>;
	replay: PreparedAcpReplay | undefined;
}

export function createAcpServerOpen(scope: AcpServerScope) {
	const { options } = scope;
	options.transport.onRequest("session/new", async (params) => {
		scope.guards.requireInitialized();
		return scope.guards.withSessionSlot(async () => {
			const request = assertParamKeys(params, new Set(["cwd", "mcpServers", "additionalDirectories"]));
			const ceiling = requestCeiling(request);
			assertCeilingEnforceable(options, ceiling);
			assertNoAdditionalDirectories(request.additionalDirectories);
			const sessionCwd = scope.guards.canonicalSessionCwd(request.cwd);
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
			const ceilingEcho = scope.guards.applySessionCeiling(session);
			scope.commands.announceCommands(id);
			scope.telemetry.bind(false);
			await scope.config.listTargetModels(session.target);
			scope.config.refreshThinkingOption(session);
			const opened = {
				sessionId: id,
				...sessionConfig(options, scope.listingFallbacks, session),
				_meta: {
					...ceilingEcho,
					...modelsResultMeta(options, session),
					[ACP_SESSION_META_KEY]: sessionResultMeta(session, false),
					...(await scope.guards.workspaceResultMeta()),
					...trustResultMeta(session.cwd),
				},
			};
			// After the result is written, so the client has bound the session id the frame names.
			setImmediate(() => scope.readoutFeed.publishReadouts(id));
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
		scope.commands.announceCommands(session.id);
		if (replay !== undefined) {
			for (const replayParams of replay.params) options.transport.notify("session/update", replayParams);
			replayDispatchTerminals(scope.events.forwardEvent, replay.runs);
		}
		// A restored session's meter goes out even when no history replays (session/resume), as session/load sends it.
		scope.telemetry.bind(replay !== undefined, true);
	};

	/** Whether a live process other than this one holds the session's ledger now, read from its record. */
	const heldElsewhere = (id: string): boolean => {
		try {
			const current = scope.guards.workspaceMeta(id);
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
		scope.guards.canonicalSessionCwd(request.cwd);
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
					scope.guards.workspaceMeta(session.id).target,
				);
			} catch (error) {
				throw loadFailure(error);
			}
		}
		// The hosted session's live view, read in the same tick as the prompt check above.
		if (replay !== undefined)
			replay = withReplayUsage(replay, scope.guards.liveSessionView(), scope.handshake.fullUsageEnabled);
		const ceilingEcho = scope.guards.applySessionCeiling(session);
		scope.commands.announceCommands(session.id);
		if (replay !== undefined) {
			for (const replayParams of replay.params) options.transport.notify("session/update", replayParams);
			replayDispatchTerminals(scope.events.forwardEvent, replay.runs);
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
				...(await scope.guards.workspaceResultMeta()),
				...trustResultMeta(session.cwd),
			},
		};
		setImmediate(() => scope.readoutFeed.publishReadouts(session.id));
		return reopened;
	};
	const restoreSession = async (params: unknown, replayToClient: boolean) => {
		scope.guards.requireInitialized();
		const hosted =
			isRecord(params) && scope.boundSessionId !== null && params.sessionId === scope.boundSessionId
				? scope.sessions.get(scope.boundSessionId)
				: undefined;
		if (hosted !== undefined && !scope.closingSessions.has(hosted.id))
			return reopenHosted(params, hosted, replayToClient);
		return scope.guards.withSessionSlot(async () => {
			const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers", "additionalDirectories"]));
			// Composed exactly like session/new; without one the operator's limits apply.
			const ceiling = requestCeiling(request);
			assertCeilingEnforceable(options, ceiling);
			assertNoAdditionalDirectories(request.additionalDirectories);
			const id = sessionIdOf(request);
			scope.guards.canonicalSessionCwd(request.cwd);
			const clientMcpServers = parseClientMcpServers(request.mcpServers, replayToClient);
			const stored = scope.guards.workspaceMeta(id);
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
			const ceilingEcho = scope.guards.applySessionCeiling(session);
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
					...(await scope.guards.workspaceResultMeta()),
					...trustResultMeta(session.cwd),
				},
			};
			// After the result is written, so the client has bound the session id the frame names.
			setImmediate(() => scope.readoutFeed.publishReadouts(id));
			return loaded;
		});
	};
	options.transport.onRequest("session/load", (params) => restoreSession(params, true));
	options.transport.onRequest("session/resume", (params) => restoreSession(params, false));
	return { bindRestored, prepareRestore };
}

export type AcpServerOpen = ReturnType<typeof createAcpServerOpen>;
