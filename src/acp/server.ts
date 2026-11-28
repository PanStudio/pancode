// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { realpathSync } from "node:fs";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../core/defaults.js";
import { MAX_TIMER_DELAY_MS } from "../core/timers.js";
import { missingRuntimeComponent } from "../domains/install/components.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import { RATE_MIN_WINDOW_MS } from "../session-control/assistant-generation-timing.js";
import { tokenizeLoopLine } from "../session-control/loop-command.js";
import { ACP_TURN_FAILED_MESSAGE, AcpRequestError, acpErrorMessage } from "./errors.js";
import type { AcpLiveTelemetry } from "./live-telemetry.js";
import { compactUsage, createAcpLiveTelemetry, sessionUsageTotals, turnUsageMeta } from "./live-telemetry.js";
import { registerAcpServerBoard } from "./server-board.js";
import { safeStoredString } from "./server-bounds.js";
import { registerAcpServerBranches } from "./server-branches.js";
import { registerAcpServerCatalog, settleAcpWork } from "./server-catalog.js";
import { createAcpServerCommands } from "./server-commands.js";
import { createAcpServerConfig } from "./server-config.js";
import { registerAcpServerContext } from "./server-context.js";
import { createAcpServerControl } from "./server-control.js";
import { createAcpServerEvents } from "./server-events.js";
import { assertCeilingEnforceable, createAcpServerGuards } from "./server-guards.js";
import { registerAcpServerHandoff } from "./server-handoff.js";
import { createAcpHandshake } from "./server-handshake.js";
import { createAcpServerMachine } from "./server-machine.js";
import { createAcpServerOpen, routingSnapshot } from "./server-open.js";
import type { AcpHandshake, AcpPromptExpansion, PancodeAcpServerOptions } from "./server-options.js";
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
import type { AcpServerScope } from "./server-scope.js";
import { registerAcpServerShell } from "./server-shell.js";
import type { AcpServerSession, ActivePrompt } from "./server-tool-updates.js";
import {
	createActivePromptState,
	newestOpenToolCallId,
	ORCHESTRATOR_UPDATE_META,
	openWireIdFor,
	reportConsentAsk,
	sendTextChunks,
	sendUpdate,
	settleOpenToolCalls,
	textContent,
} from "./server-tool-updates.js";
import { ACP_TELEMETRY_UPDATE_NOTIFICATION, subscribeTelemetryUpdates } from "./telemetry-methods.js";
import type { AcpPromptResponse } from "./types.js";
import {
	ACP_COMMANDS_INVOKE_METHOD,
	ACP_COMMANDS_LIST_METHOD,
	ACP_MAX_CHUNK_BYTES,
	ACP_NOTICE_META_KEY,
	ACP_PERMISSION_WITHDRAW_METHOD,
	ACP_TURN_META_KEY,
	ACP_USAGE_META_KEY,
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
		const unsubscribe = machine.attachTurnObserver(session.id, active);
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
