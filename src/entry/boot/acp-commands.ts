// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { AcpHostReport, acpCommandControl } from "../../acp/commands.js";
import { sessionTelemetryContext } from "../../core/telemetry/context.js";
import { runOperatorRecall } from "../../domains/context/working-set/operator-recall.js";
import { agentRoleFactsResolver } from "../../domains/dispatch/execution-role.js";
import { lazyReportTextHost } from "../../domains/report/wiring.js";
import { mcpPromptSlashRows } from "../../domains/resources/submit-expansion.js";
import { writeTranscriptExport } from "../../domains/session/transcript-export.js";
import { archiveCommandHost, shareArchiver } from "../../domains/share/index.js";
import type { UserTaskAcceptance } from "../../domains/user-tasks/acceptance.js";
import type { ReloadTarget } from "../../session-control/reload-report.js";
import type { createSessionExtensionHosting } from "../session-extension-hosting.js";
import type { BootSurfaceInput, BootSurfaceSeams } from "./surface.js";

/** What acpCommandHost reads from runAcpSurface. */
export type AcpCommandHostInput = Pick<
	BootSurfaceInput,
	| "agents"
	| "bus"
	| "captureRunIo"
	| "chat"
	| "config"
	| "contextDomain"
	| "decisionBoard"
	| "dispatch"
	| "getCurrentSettings"
	| "jobHost"
	| "mcpSubmit"
	| "providers"
	| "readCurrentSessionEntries"
	| "readSessionEntriesForCompact"
	| "reloadClasses"
	| "reportSession"
	| "resolveBaselineAutonomy"
	| "resolveEffectiveAutonomy"
	| "resources"
	| "runContextInit"
	| "seedCurrentTaskMemoryFromHandoff"
	| "session"
	| "toolRegistry"
	| "userTasks"
> &
	Pick<BootSurfaceSeams, "oracleBriefingFromEntries" | "runHostDispatch"> & {
		acpExtensions: ReturnType<typeof createSessionExtensionHosting>;
		acpHostToolEvents: ReturnType<BootSurfaceSeams["createHostToolEvents"]>;
		acpWorkerRuns: ReturnType<BootSurfaceSeams["followWorkerRuns"]>;
	};

/** The host an ACP session's slash commands run against (`acpCommandControl`'s argument), bound to the wired session. */
export function acpCommandHost(input: AcpCommandHostInput): Parameters<typeof acpCommandControl>[0] {
	const {
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
	} = input;
	return {
		jobs: jobHost.operations,
		dispatch,
		bus,
		providers,
		cwd: process.cwd(),
		runDoctor: async ({ deep }) => {
			const { collectDoctorFindings, doctorNotice } = await import("../../cli/doctor.js");
			return doctorNotice(
				await collectDoctorFindings({
					workspaceRoot: process.cwd(),
					deep: deep ? { providers, autonomy: resolveBaselineAutonomy() } : false,
				}),
			);
		},
		clearSkillSurface: () => chat.clearSkillSurface(),
		eggsCommand: (action, id) => chat.eggsCommand?.(action, id) ?? "No active eggs.",
		// Narrowed exactly as `interactive-slash-runtime.ts` narrows it:
		// the store's `note` parameter has no command-line spelling, and
		// a handoff is attributed to the session that asked for it.
		userTasks: {
			add: (title: string, acceptance?: UserTaskAcceptance) => userTasks.add(title, undefined, acceptance),
			hand: (id: string) => userTasks.hand(id, chat.getSessionId() ?? undefined),
			done: (id: string) => userTasks.done(id),
			drop: (id: string) => userTasks.drop(id),
		},
		getDecisionBoard: () => decisionBoard.snapshot(),
		isTurnInFlight: () => chat.isStreaming(),
		standingTurnConstraints: () => chat.toolLimits?.(),
		seedTaskMemory: seedCurrentTaskMemoryFromHandoff,
		// Recovery continues the engine without new input. It runs inside the
		// prompt turn that asked for it, so its output streams there, and the
		// reply waits for it so the next prompt cannot race it.
		runHandoffRecovery: async (handoffId: string, action: "reduce" | "deliver"): Promise<AcpHostReport> => {
			if (chat.isStreaming()) return { level: "error", text: "Wait for the current turn to settle before recovery." };
			await chat.recoverHandoff(handoffId, action);
			return {
				level: "success",
				text: action === "deliver" ? "Handoff delivered." : "Handoff reduced; the paused turn continued.",
			};
		},
		// `/council` enters the registry as the dispatch call a model makes, under
		// a call id the turn announces, so its plan approval binds to that call.
		runCouncilDispatch: (args, turnConstraints) =>
			runHostDispatch(toolRegistry, acpHostToolEvents, args, turnConstraints),
		// `/share` picks from the runs this process watched, folded from the
		// dispatch lifecycle exactly as the terminal's worker blocks are.
		listWorkerRuns: () => acpWorkerRuns.list(),
		reloadClasses: async (target: ReloadTarget): Promise<AcpHostReport> => {
			const report = await reloadClasses.run(target, () => acpExtensions.reloadStep());
			return { level: report.failed ? "warn" : "info", text: report.text };
		},
		...(session
			? {
					exportTranscript: (path?: string): AcpHostReport =>
						writeTranscriptExport({
							sessionId: chat.getSessionId(),
							leafTurnId: (id) => session.leafId(id),
							readEntries: readSessionEntriesForCompact,
							cwd: process.cwd(),
							...(path === undefined ? {} : { path }),
						}),
				}
			: {}),
		...archiveCommandHost(shareArchiver),
		// `/report` previews as text and sends only on a second `/report send <id>`.
		reportHost: lazyReportTextHost(reportSession),
		getChatTarget: () => getCurrentSettings().chat.target,
		getChatModel: () => getCurrentSettings().chat.model,
		getFleetAgentProfiles: () => getCurrentSettings().fleet.agentProfiles,
		getAutonomy: resolveEffectiveAutonomy,
		...(session
			? {
					oracleBriefing: () => {
						const sessionId = chat.getSessionId();
						if (sessionId === null) return { decisions: [], tasks: [], compactionSummary: null };
						return oracleBriefingFromEntries(readSessionEntriesForCompact(sessionId), session.leafId(sessionId) ?? undefined);
					},
				}
			: {}),
		// The context verbs the TUI reaches through its hub. Each answers the
		// wire client with how it ended, because nothing else reaches one.
		...(session
			? {
					runCompact: async (instructions: string | undefined): Promise<AcpHostReport> => {
						// Compaction rewrites the context a running turn is reading.
						if (chat.isStreaming()) return { level: "error", text: "Wait for the current turn to finish before compacting." };
						// chat.compact says nothing when it compacts. Every notice it raises
						// is a refusal, a failure, or an empty cut, so none reads as success.
						const notices: string[] = [];
						let failed = false;
						const stop = chat.onEvent((event) => {
							if (event.type !== "notice") return;
							notices.push(event.text);
							if (event.level === "error") failed = true;
						});
						try {
							await chat.compact(instructions);
						} finally {
							stop();
						}
						if (notices.length === 0)
							return { level: "success", text: "Context compacted. The next request starts from the summary." };
						const empty = notices.every((text) => text.includes("nothing to compact"));
						return { level: failed ? "error" : empty ? "info" : "warn", text: notices.join("\n") };
					},
					runContextRecall: async (ref: string): Promise<AcpHostReport> => {
						const outcome = runOperatorRecall(ref, {
							getSessionId: () => session.current()?.id ?? null,
							onActivity: (event) => bus.emit("context.activity_changed", event),
							hasSession: () => session.current() !== null,
							readEntries: readCurrentSessionEntries,
							activeLeafTurnId: () => {
								const meta = session.current();
								return meta ? (session.leafId(meta.id) ?? undefined) : undefined;
							},
							appendEntry: (entry) => session.appendEntry(entry),
							onRecalled: (payload) => bus.emit("context.recalled", payload, sessionTelemetryContext(session.current()?.id)),
						});
						// The body answers the person; like the TUI's replay block it never becomes model context.
						return outcome.ok
							? { level: "success", text: `${outcome.headline}\n${outcome.body}` }
							: { level: "error", text: outcome.message };
					},
				}
			: {}),
		...(contextDomain
			? {
					runContextRefresh: async (): Promise<AcpHostReport> => {
						const capture = captureRunIo();
						await contextDomain.runContextRefresh({ cwd: process.cwd(), io: capture.io });
						return capture.report("Project context refreshed.");
					},
					// The terminal confirms a reset in its chooser; over ACP the operator's
					// confirmation is the --yes flag, checked by the command bridge.
					runContextClear: async (clear: {
						all?: boolean;
						confirmed?: boolean;
						confirmedAll?: boolean;
					}): Promise<AcpHostReport> => {
						// The command bridge refuses an unconfirmed reset before it gets here.
						if (clear.confirmed !== true) return { level: "warn", text: "Nothing was changed." };
						if (chat.isStreaming())
							return { level: "error", text: "Wait for the current turn to finish before resetting context." };
						const capture = captureRunIo();
						await contextDomain.runContextClear({
							cwd: process.cwd(),
							all: clear.all === true,
							io: capture.io,
							confirmContext: () => true,
							confirmAll: () => clear.confirmedAll === true,
						});
						return capture.report(clear.all === true ? "Project context and PANCODE.md reset." : "Project context reset.");
					},
					runInit: async (initOptions: Parameters<typeof runContextInit>[0]): Promise<AcpHostReport> => {
						const capture = captureRunIo();
						await runContextInit(initOptions, capture.io);
						return capture.report("Project context initialized.");
					},
				}
			: {}),
		...(agents ? { getAgentRoleFacts: agentRoleFactsResolver((id: string) => agents.getSpec(id)) } : {}),
		...(config ? { getWorkerRosters: () => config.get().fleet.rosters } : {}),
		...(resources
			? {
					parsePendingSkillRequests: (text: string, commandCwd?: string) =>
						resources.parsePendingSkillRequests(text, commandCwd ?? process.cwd()),
					// The prompt screen asks the same question the terminal editor
					// does before refusing a `/name` line: does a loaded template own it.
					expandPromptTemplate: (text: string, commandCwd?: string) =>
						resources.expandPromptTemplate(text, commandCwd ?? process.cwd()),
					listPromptsForDisplay: () => resources.promptsForDisplay(process.cwd()).items,
					listPrompts: () => resources.prompts(process.cwd()).items,
				}
			: {}),
		operatorExtensions: () => acpExtensions.current?.operator,
		...(mcpSubmit
			? {
					mcpPrompts: () => mcpPromptSlashRows(mcpSubmit, resources?.promptsForDisplay(process.cwd()).items ?? []),
				}
			: {}),
		submitTurn: (text, submitOptions) => {
			void chat
				.submit(
					text,
					submitOptions.pendingSkillRequests === undefined
						? {}
						: { pendingSkillRequests: [...submitOptions.pendingSkillRequests] },
				)
				.catch(() => undefined);
		},
		submitOperatorNote: (text) => {
			void chat.submit(text).catch(() => undefined);
		},
		...(chat.operatorMemory ? { operatorMemory: chat.operatorMemory } : {}),
	};
}
