// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { readPancodeVersionLabel } from "../../core/build-info.js";
import type { PancodeSettings } from "../../core/config.js";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../../core/defaults.js";
import { sandboxAvailability } from "../../core/sandbox/availability.js";
import { mainShellContained } from "../../core/sandbox/main-session.js";
import { routingChangeNotices } from "../../core/session-routing.js";
import type { PluginsReloadedPayload } from "../../core/telemetry/live-events.js";
import { pancodeDataDir, pancodeStateDir } from "../../core/xdg.js";
import { createFleetRunLauncher } from "../../domains/dispatch/fleet-run-launcher.js";
import { expandSubmitText } from "../../domains/resources/submit-expansion.js";
import type { SessionEntry } from "../../domains/session/entries.js";
import { resumedSessionRoute } from "../../domains/session/resumed-route.js";
import { probeWorkspaceAsync } from "../../domains/session/workspace/index.js";
import { effectiveYoloConfinement } from "../../lib/autonomy/autonomy.js";
import { resizeImage } from "../../lib/image/image-resize.js";
import { detectSupportedImageMimeType } from "../../tools/file-references.js";
import type { BootOptions } from "../boot-options.js";
import type { BootResult } from "../orchestrator.js";
import { reloadPluginResourcesAndNotify } from "../plugin-reload.js";
import { createSessionExtensionHosting } from "../session-extension-hosting.js";
import { acpCommandHost } from "./acp-commands.js";
import { acpFleetControl } from "./acp-fleet.js";
import type { BootSurfaceInput, BootSurfaceSeams } from "./surface.js";

/** An ACP-served session (and the GUI, which spawns `pancode acp`): serves the wired session over stdio. */
export async function runAcpSurface(
	surface: BootSurfaceInput,
	seams: BootSurfaceSeams,
	acp: NonNullable<BootOptions["acp"]>,
): Promise<BootResult> {
	const {
		acpElicitationChannel,
		acpInterviewChannel,
		acpInterviews,
		acpWorkerPermissions,
		agents,
		askUserBridge,
		beforeShellEntryRecorded,
		beginChatSettlement,
		bindAcpHandoff,
		bus,
		captureRunIo,
		chat,
		chatIdle,
		clampAtScope,
		commitAcpSafeSettings,
		commitExtensionHooks,
		config,
		contextDomain,
		createRoutedSession,
		decisionBoard,
		dispatch,
		extensions,
		flowLedger,
		getCurrentSettings,
		jobHost,
		mcpSubmit,
		memoryIntervention,
		memoryOwner,
		options,
		persistCurrentThinkingLevel,
		providers,
		readAcpSafeSettings,
		readCurrentSessionEntries,
		readSessionEntriesForCompact,
		recordBoot,
		reloadClasses,
		reportSession,
		resolveBaselineAutonomy,
		resolveEffectiveAutonomy,
		resources,
		result,
		runContextInit,
		seedCurrentTaskMemoryFromHandoff,
		selectAtScope,
		session,
		startSessionExtensionHost,
		taskBoard,
		taskMemoryBank,
		taskMemoryTier,
		telemetry,
		timer,
		toolBootstrap,
		toolRegistry,
		unsubscribeChatShutdown,
		userTasks,
		yoloRefusal,
	} = surface;
	const { cells } = surface;
	const {
		bindBoardActions,
		buildModelReplayAgentMessagesFromTurns,
		continuityContextFromSession,
		createHostToolEvents,
		createStdioServerTransport,
		followWorkerRuns,
		oracleBriefingFromEntries,
		releasePancodeLoadedModelsOnExit,
		runHostDispatch,
		subscribeLoopGuardStop,
	} = seams;
	recordBoot();
	// ACP-served sessions get the same routing isolation as interactive
	// ones, but ACP v1 has no channel for agent-initiated advisory text:
	// the session/update union (agent_message_chunk, agent_thought_chunk,
	// tool_call*, plan, …) carries turn content, and notifications outside
	// an active session/prompt would break strict clients (see the matching
	// note in src/acp/server-tool-updates.ts). The external-divergence and
	// target-removed notices therefore go to the session ledger as `custom`
	// entries, where /resume and session tooling can surface them.
	// ACP is operatorless too: bound a runaway turn with the shared
	// interrupt->stop subscriber, the same way the headless path does.
	const unsubscribeAcpLoopGuardStop = subscribeLoopGuardStop(bus, chat);
	const unsubscribeAcpRoutingNotices = bus.subscribe("config.next_turn_scheduled", (payload) => {
		const evt = payload as { diff?: { nextTurn?: string[] }; settings?: Readonly<PancodeSettings> } | null | undefined;
		if (!evt?.settings || !Array.isArray(evt.diff?.nextTurn)) return;
		if (!session?.current()) return;
		const notices = routingChangeNotices(evt.diff.nextTurn, evt.settings, getCurrentSettings());
		for (const notice of notices) {
			try {
				session.appendEntry({
					kind: "custom",
					customType: "pancode.routing-notice",
					parentTurnId: null,
					data: { kind: notice.kind, level: notice.level, text: notice.text },
				});
			} catch {
				// Advisory only; a ledger write failure must not affect the
				// ACP turn loop.
			}
		}
	});
	const acpWorkerRuns = followWorkerRuns(bus, undefined, (id) => agents?.getSpec(id)?.traits ?? []);
	const acpHostToolEvents = createHostToolEvents();
	// A client that answers no interviews gets each tool interview cancelled
	// with reason headless, the way a run without an operator does.
	const acpExtensionAsk = acpInterviews ? askUserBridge : undefined;
	const acpExtensions = createSessionExtensionHosting({
		start: () => startSessionExtensionHost("acp", acpExtensionAsk),
		commit: commitExtensionHooks,
		idle: chatIdle,
		bus,
		report: (line) => process.stderr.write(`[pancode:acp] ${line}\n`),
	});
	await acpExtensions.ensure();
	let acpQuotaService: import("../../domains/quota/service.js").QuotaService | undefined;
	let acpQuotaRead: Promise<void> | undefined;
	const refreshAcpQuota = (): Promise<void> => {
		acpQuotaRead ??= (async () => {
			const { createQuotaService } = await import("../../domains/quota/service.js");
			acpQuotaService ??= createQuotaService();
			await acpQuotaService.read();
		})().finally(() => {
			acpQuotaRead = undefined;
		});
		return acpQuotaRead;
	};
	// The fleets this ACP agent starts. A second start is refused while one runs, as the terminal's /fleet run refuses
	// it, since two fleets would race over one workspace.
	const fleetRuns = agents
		? createFleetRunLauncher({
				dispatch,
				agents: { getSpec: (agentId) => agents.getSpec(agentId) },
				workspaceRoot: () => process.cwd(),
				getSettings: getCurrentSettings,
				getDecisionBoard: () => decisionBoard.snapshot(),
			})
		: null;
	const [{ acpCommandControl }, { servePancodeAcpAgent }] = await Promise.all([
		seams.loadAcpCommands(),
		seams.loadAcpServer(),
	]);
	try {
		const transport = acp.transport ?? createStdioServerTransport(acp.transportOptions);
		const code = await servePancodeAcpAgent({
			transport,
			...(acp.handshake ? { handshake: acp.handshake } : {}),
			...(acp.onReady ? { onReady: acp.onReady } : {}),
			...(acpInterviewChannel ? { interviews: acpInterviewChannel } : {}),
			...(acpElicitationChannel ? { elicitation: acpElicitationChannel } : {}),
			...(acpWorkerPermissions && dispatch?.resolveWorkerPermission
				? {
						workerPermissions: {
							resolve: (runId: string, requestId: string, decision: "approve" | "deny") =>
								dispatch.resolveWorkerPermission?.(runId, requestId, decision),
						},
					}
				: {}),
			chat,
			...(session
				? {
						session: {
							...session,
							create(input) {
								const meta = session.create(input);
								persistCurrentThinkingLevel();
								return meta;
							},
						},
					}
				: {}),
			...(session
				? {
						readSessionEntries: readSessionEntriesForCompact,
						// Ownership is read at call time, not captured: an ACP client
						// can switch sessions between turns, and a fork opened this way
						// must separate its own transactions from the ones it inherited
						// exactly as the interactive path does.
						// `upto` is the /tree switch's historical cut, the same option the
						// terminal passes there; a live leaf keeps sidecars written after it.
						buildReplayMessages: (
							entries: ReadonlyArray<SessionEntry>,
							leafTurnId: string | null,
							scope: "leaf" | "upto" = "leaf",
						) =>
							buildModelReplayAgentMessagesFromTurns(entries, {
								...(leafTurnId === null
									? {}
									: scope === "upto"
										? { uptoTurnId: leafTurnId }
										: { activeLeafTurnId: leafTurnId }),
								continuity: continuityContextFromSession(session),
							}),
					}
				: {}),
			// /fleet run's approval, split across preview and run. Both compile
			// through the dispatch domain exactly as the terminal overlay does.
			...(agents && fleetRuns ? { fleet: acpFleetControl({ agents, chat, dispatch, launcher: fleetRuns, result }) } : {}),
			// /handoff runs the lifecycle the terminal runs. The successor is minted
			// the way session/new mints one, so its route matches a fresh session.
			...(session
				? {
						handoff: bindAcpHandoff({
							session,
							extract: (goal, extractOptions) => chat.extractHandoff(goal, extractOptions ?? {}),
							readEntries: readSessionEntriesForCompact,
							isTurnInFlight: () => chat.isStreaming(),
							createSession: () => {
								createRoutedSession();
								taskBoard.snapshot();
							},
							getDecisionBoard: () => decisionBoard.snapshot(),
							absorbFlow: (set) => flowLedger.absorb(set, { tool: "handoff" }),
						}),
					}
				: {}),
			providers,
			// The fleet controls `_pancode/dispatch/steer` reaches. The server
			// takes the two operations by structure, never the whole contract, so
			// no ACP client can enqueue or route dispatch work through it.
			dispatch: {
				steer: (runId, text) => {
					dispatch.steer(runId, text);
				},
				abort: (runId) => {
					dispatch.abort(runId);
				},
				snapshot: () => dispatch.snapshot(),
			},
			settings: {
				read: readAcpSafeSettings,
				commit: commitAcpSafeSettings,
			},
			// A request typed in an ACP client means what it means in the terminal: skills,
			// prompt templates and `@path` references expand the same way. Attached images
			// are judged by their bytes, never by the client's label, and resized like a
			// referenced image file before the model sees them.
			expandPrompt: async (text, attached, signal) => {
				const expansion = await expandSubmitText(text, resources, process.cwd(), {
					...(signal ? { signal } : {}),
					...(mcpSubmit ? { mcp: mcpSubmit } : {}),
				});
				// The literal `/name` line of a refused prompt is never sent to the model.
				if (expansion.promptRefusal !== undefined) throw new Error(expansion.promptRefusal);
				const images = [...expansion.images];
				for (const image of attached) {
					const mimeType = detectSupportedImageMimeType(Buffer.from(image.data, "base64"));
					if (!mimeType) throw new Error("An attached file is not a PNG, JPEG, GIF or WebP image.");
					const resized = await resizeImage({ type: "image", mimeType, data: image.data });
					images.push(
						resized
							? { type: "image", mimeType: resized.mimeType, data: resized.data }
							: { type: "image", mimeType, data: image.data },
					);
				}
				return { ...expansion, images };
			},
			// The read half of the terminal's /tasks, /decisions and /memory views.
			board: () => {
				const memory = getCurrentSettings().context.memory;
				return {
					operatorTasks: userTasks.snapshot(),
					plan: taskBoard.cachedSnapshot(),
					decisions: decisionBoard.snapshot(),
					memory: {
						enabled: memory.enabled,
						tier: taskMemoryTier(),
						bank: taskMemoryBank.snapshot(),
						stepInFlight: memoryIntervention.stepInFlight(),
						observations: memoryOwner.contract.observationStatus(),
						retention: memoryOwner.contract.retentionStatus(),
					},
				};
			},
			// The operator-command host. Only the members the thirteen
			// allowlisted commands actually reach are passed; every TUI-only
			// member stays absent, which is what makes the registry take its
			// documented non-TUI fallback instead of trying to draw an overlay.
			//
			// A command that submits a user turn (`/share`, `/oracle`,
			// `/skill <name>`, `/tasks hand`) is refused by the server while a
			// prompt is active. Outside one, the turn is persisted to the ledger
			// and replayed on the next `session/load`, but it emits no live
			// `session/update`: ACP v1 has no channel for agent content outside a
			// prompt, the same constraint recorded above for routing notices.
			...(dispatch && providers
				? {
						commands: acpCommandControl(
							acpCommandHost({
								acpExtensions,
								acpHostToolEvents,
								acpWorkerRuns,
								agents,
								bus,
								captureRunIo,
								chat,
								config,
								contextDomain,
								decisionBoard,
								dispatch,
								getCurrentSettings,
								jobHost,
								mcpSubmit,
								oracleBriefingFromEntries,
								providers,
								readCurrentSessionEntries,
								readSessionEntriesForCompact,
								reloadClasses,
								reportSession,
								resolveBaselineAutonomy,
								resolveEffectiveAutonomy,
								resources,
								runContextInit,
								runHostDispatch,
								seedCurrentTaskMemoryFromHandoff,
								session,
								toolRegistry,
								userTasks,
							}),
						),
					}
				: {}),
			toolRegistry,
			labelOperatorCommand: flowLedger.labelCommand,
			beforeShellEntryRecorded,
			hostToolEvents: acpHostToolEvents,
			...(session
				? {
						boardActions: bindBoardActions({
							decisionBoard,
							taskBank: () => taskMemoryBank.snapshot(),
							currentSession: () => session.current(),
							dataDir: pancodeDataDir(),
							sessionFlowRestricted: (sessionId) => flowLedger.isRestricted(sessionId),
						}),
					}
				: {}),
			contextLedger: () => chat.contextLedger(),
			...(contextDomain
				? {
						startupHints: () => contextDomain.startupHints(),
						cancelContextOperation: (sessionId: string, cwd: string, operationId?: string) =>
							contextDomain.cancelOperation?.(sessionId, cwd, operationId) ?? false,
					}
				: {}),
			// The plan rows the standard `plan` update carries, and the Git facts
			// the terminal footer shows, pushed instead of polled.
			plan: () => taskBoard.snapshot(),
			workspace: (cwd) => probeWorkspaceAsync(cwd),
			// /view's providers, bound to the session this host is running.
			...(session
				? {
						artifacts: {
							deps: (sessionId: string) => {
								const meta = session.current();
								if (!meta || meta.id !== sessionId) return null;
								return {
									stateDir: pancodeStateDir(),
									dataDir: pancodeDataDir(),
									...(dispatch ? { dispatch } : {}),
									sessionMeta: meta,
									readSessionEntries: readCurrentSessionEntries,
								};
							},
						},
					}
				: {}),
			...(extensions
				? {
						extensions: {
							list: () => extensions.list(process.cwd(), { all: true }),
							// The runtimes restart on the generation this commit published.
							reload: () => acpExtensions.reload(),
						},
					}
				: {}),
			...(telemetry?.read
				? {
						telemetryReadModel: telemetry.read,
						bindTelemetrySession: (id: string) => telemetry.resetSession(id),
						refreshQuota: refreshAcpQuota,
					}
				: {}),
			// /btw and /draft run the chat loop's own out-of-turn rounds.
			aside: {
				ask: (question, signal) => chat.askSideQuestion(question, { signal }),
				draft: (request, count, signal) => chat.draftCandidates(request, count, { signal }),
			},
			// The same reload /reload hub runs, with the generation change the
			// PluginsReloaded event reports. A throw is a failed reload.
			hubReload: () => {
				let reloaded: PluginsReloadedPayload | null = null;
				reloadPluginResourcesAndNotify(process.cwd(), (event) => {
					reloaded = event;
					bus.emit("plugin.reloaded", event);
				});
				const event = reloaded as PluginsReloadedPayload | null;
				if (event === null) throw new Error("plugin reload reported no generation");
				return { generation: event.generation, previousGeneration: event.previousGeneration, changed: event.changed };
			},
			...(toolBootstrap.mcpCapabilities ? { mcpCapabilities: toolBootstrap.mcpCapabilities } : {}),
			...(options.toolLimits ? { operatorToolLimits: options.toolLimits } : {}),
			bus,
			autonomy: resolveBaselineAutonomy,
			routing: () => {
				const settings = getCurrentSettings();
				return {
					target: settings.chat.target,
					model: settings.chat.model,
				};
			},
			setSessionRouting: (patch, source) => {
				const current = getCurrentSettings();
				const target = patch.target ?? current.chat.target;
				const model = patch.model ?? current.chat.model;
				if (target && model && (patch.target !== undefined || patch.model !== undefined)) {
					selectAtScope({ target, model, thinkingLevel: patch.thinkingLevel }, "session", source);
					// ACP acknowledges choices before a turn; resume must see them even without inference (Y4 finding 4).
					const meta = session?.current();
					if (session && meta) {
						const recorded = resumedSessionRoute(meta, session.readEntries());
						if (recorded.target !== target || recorded.model !== model) {
							session.appendEntry({
								kind: "modelChange",
								parentTurnId: session.leafId(meta.id),
								provider: providers.getTarget(target)?.runtime ?? target,
								target,
								modelId: model,
							});
							session.flushAppends?.();
						}
					}
				} else {
					clampAtScope(patch, "session", source);
				}
			},
			onActiveSessionAutonomyChange: (level) => {
				cells.activeAcpSessionAutonomy = level;
			},
			yoloRefusal: () => yoloRefusal,
			autonomyPosture: () => ({
				confinement: effectiveYoloConfinement(getCurrentSettings().safety),
				osSandbox: mainShellContained(getCurrentSettings().safety.sandbox, sandboxAvailability()),
			}),
			cwd: process.cwd(),
			version: readPancodeVersionLabel(),
			// Stdout belongs to JSON-RPC. Text this process did not author, such
			// as a provider's failure body, is kept off the wire and written to
			// the unstructured stderr tail instead.
			diagnostics: (line) => {
				process.stderr.write(`[pancode:acp] ${line}\n`);
			},
			permissionTimeoutMs:
				acp.permissionTimeoutMs ??
				config?.get().integrations.externalAgents.defaults.permissionTimeoutMs ??
				DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS,
		});
		// Same ordering the termination drain hook relies on: an aborted turn's
		// tool results still land and persist through the run's subscribers,
		// and the session writer stops in result.stop() below. Awaiting
		// settlement here makes a session append after session stop impossible
		// by ordering rather than by timing.
		await beginChatSettlement();
		// The drain hook that disposes the extension host never runs on this
		// path either, and its runtime children would keep the process alive
		// after the client left. Disposal is idempotent.
		await acpExtensions.dispose();
		unsubscribeChatShutdown();
		cells.unsubscribeDispatchShutdown?.();
		await dispatch.drain();
		await toolBootstrap.close();
		// A client that closes the session ends ACP here, outside the
		// termination coordinator, so its terminate hook never runs. Release
		// the Ollama models this process and its workers loaded on this path
		// too (#379); SIGINT and SIGTERM still reach the hook. The release
		// bounds itself by EXIT_RELEASE_MS and never throws.
		await releasePancodeLoadedModelsOnExit();
		await result.stop();
		return { exitCode: code, bootTimeMs: timer.snapshot().totalMs };
	} finally {
		// A throw from the serve loop or settlement skips the disposal above,
		// and the runtime children would still hold the process open.
		await acpExtensions.dispose();
		acpWorkerRuns.dispose();
		unsubscribeAcpRoutingNotices();
		unsubscribeAcpLoopGuardStop();
	}
}
