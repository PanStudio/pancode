// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { AcpHostReport } from "../../acp/commands.js";
import { modelBootstrapGenerate, resolveBootstrapRoute } from "../../cli/bootstrap-generate.js";
import type { PancodeSettings } from "../../core/config.js";
import { hostFramedTexts } from "../../core/reminder-framing.js";
import {
	SAFE_EXEC_DEFAULT_KILL_GRACE_MS,
	SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS,
	SAFE_EXEC_PIPE_DRAIN_BOUND_MS,
} from "../../core/safe-exec.js";
import { sandboxAvailability } from "../../core/sandbox/availability.js";
import { mainShellContained } from "../../core/sandbox/main-session.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import { type getTerminationCoordinator, resolveShutdownHookBudgetMs } from "../../core/termination.js";
import { pancodeDataDir } from "../../core/xdg.js";
import type { ConfigContract } from "../../domains/config/contract.js";
import type { ContextContract } from "../../domains/context/contract.js";
import { bootstrapInputFromInitOptions } from "../../domains/context/init-options.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import type { ExtensionsContract } from "../../domains/extensions/contract.js";
import { isLoadableExtension } from "../../domains/extensions/index.js";
import type { ExtensionRuntimeHookBridge } from "../../domains/extensions/runtime-hook-bridge.js";
import type { MemoryGuardian } from "../../domains/memory/guardian.js";
import { type MemoryRuntime, memoryRecordStanding, renderTaskMemoryHandoffSource } from "../../domains/memory/index.js";
import type { MemoryInterventionRegistration } from "../../domains/memory/intervention-types.js";
import type { MemoryPromptReader } from "../../domains/memory/prompt-cache.js";
import { readMemoryStoreSnapshot } from "../../domains/memory/store.js";
import type { TaskMemoryBank } from "../../domains/memory/task-bank.js";
import type { MiddlewareContract } from "../../domains/middleware/contract.js";
import type { CompletionFact } from "../../domains/middleware/index.js";
import type { MiddlewareToolChoiceControl } from "../../domains/middleware/tool-choice-control.js";
import type { PromptsContract } from "../../domains/prompts/contract.js";
import { modelEndpointKey, type ProvidersContract, registerForegroundStream } from "../../domains/providers/index.js";
import type { AutonomyWindow } from "../../domains/safety/autonomy-window.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import type { ProtectedArtifactsRegistration } from "../../domains/safety/protected-artifacts-registration.js";
import type { SchedulingContract } from "../../domains/scheduling/contract.js";
import type { CompactInput, CompactResult } from "../../domains/session/compaction/compact.js";
import type {
	CompactionFlowAdmission,
	CompactionFlowBudget,
	CompactionTelemetry,
} from "../../domains/session/compaction/flow.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { DecisionBoardStore } from "../../domains/session/decision-board.js";
import type { CompactionTrigger, SessionEntry } from "../../domains/session/entries.js";
import type { SystemOne } from "../../domains/system-one/types.js";
import type { TelemetryContract } from "../../domains/telemetry/contract.js";
import type { EXIT_RELEASE_MS, releasePancodeLoadedModelsOnExit } from "../../engine/apis/residency.js";
import type { createLoopGuardRegistration, readOrchTurnToolCallBudget } from "../../engine/loop-guard.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import type { createChatLoop } from "../../session-control/chat-loop.js";
import type { replayCurrentSession } from "../../session-control/index.js";
import type { RunIo } from "../../session-control/slash-command-types.js";
import type { BUILTIN_SLASH_NAMES } from "../../session-control/slash-commands.js";
import type { TurnControlRunner } from "../../session-control/turn-control-runner.js";
import type { TurnOutcomeCollector } from "../../session-control/turn-outcome-collector.js";
import type { AskUserHandler } from "../../tools/ask-user.js";
import type { ToolBootstrapHandle } from "../../tools/bootstrap.js";
import type { DispatchBackgroundRegistry } from "../../tools/dispatch-background.js";
import { mcpSubmitReader } from "../../tools/gateway/mcp-submit-reader.js";
import type { ToolRegistry } from "../../tools/registry/contract.js";
import type { VisionSidecar } from "../../tools/vision-sidecar.js";
import type { BootOptions } from "../boot-options.js";
import type { ExtensionReloadCoordinator } from "../extension-reload.js";
import type { createFlowLedger } from "../flow-ledger.js";
import type { createJobHost } from "../job-host.js";
import type { createSessionSettingsView } from "../session-settings-view.js";

type SessionSettingsView = ReturnType<typeof createSessionSettingsView>;

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootChatCells {
	readonly declaredCompletionFacts: readonly CompletionFact[];
	deferredMemoryReminderSink: ((message: string, isCurrent?: () => boolean) => void) | null;
	deferredWatchdogNoticeSink: ((text: string) => void) | null;
	isChatStreaming: () => boolean;
	lastMemoryPromptRuntimeId: string | undefined;
	operatorTask: string;
	readonly outcomeSessionId: string | null;
}

/** What startBootChat reads from the names bootOrchestrator built before it. */
export interface BootChatInput {
	acpInterviews: boolean;
	acpMode: boolean;
	admitModelFlow: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	askUserBridge: AskUserHandler;
	autonomyWindow: AutonomyWindow;
	beforeTurnRecorded: (target: SessionContract) => void;
	bootStderr: (text: string) => void;
	BUILTIN_SLASH_NAMES: typeof BUILTIN_SLASH_NAMES;
	bus: TelemetryHub;
	config: ConfigContract | undefined;
	contextDomain: ContextContract | undefined;
	createChatLoop: typeof createChatLoop;
	createProductionAutoCompact: (
		session: SessionContract,
		getSettings: () => PancodeSettings,
		providers: ProvidersContract,
		telemetry?: CompactionTelemetry,
		summarize?: CompactInput["summarize"],
		admission?: CompactionFlowAdmission,
	) => (
		instructions?: string,
		trigger?: CompactionTrigger,
		budget?: CompactionFlowBudget,
	) => Promise<CompactResult | null>;
	decisionBoard: DecisionBoardStore;
	dispatch: DispatchContract;
	dispatchBackground: DispatchBackgroundRegistry;
	EXIT_RELEASE_MS: typeof EXIT_RELEASE_MS;
	extensionReload: ExtensionReloadCoordinator;
	extensions: ExtensionsContract | undefined;
	flowLedger: ReturnType<typeof createFlowLedger>;
	getCurrentSettings: SessionSettingsView["getCurrentSettings"];
	getReadySkillCount: () => number;
	interactive: boolean;
	jobHost: ReturnType<typeof createJobHost>;
	loopGuard: ReturnType<typeof createLoopGuardRegistration>;
	memoryEnabledNow: () => boolean;
	memoryGuardian: MemoryGuardian;
	memoryIntervention: MemoryInterventionRegistration;
	memoryOwner: MemoryRuntime;
	memoryReader: MemoryPromptReader;
	memoryRouteAvailable: () => boolean;
	middleware: MiddlewareContract;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	operatorReturned: () => void;
	options: BootOptions;
	prompts: PromptsContract | undefined;
	protectedArtifactsGuard: ProtectedArtifactsRegistration;
	providers: ProvidersContract;
	readCurrentSessionEntries: () => ReadonlyArray<SessionEntry>;
	readOrchTurnToolCallBudget: typeof readOrchTurnToolCallBudget;
	releasePancodeLoadedModelsOnExit: typeof releasePancodeLoadedModelsOnExit;
	replayCurrentSession: typeof replayCurrentSession;
	resolveEffectiveAutonomy: () => AutonomyLevel;
	resumedSessionAtBoot: boolean;
	routeProvenance: SessionSettingsView["routeProvenance"];
	runtimeHooks: ExtensionRuntimeHookBridge;
	safety: SafetyContract;
	seedOutcomeFromSession: () => void;
	session: SessionContract | undefined;
	sessionScheduling: SchedulingContract | undefined;
	systemOne: SystemOne;
	taskEstablished: () => boolean;
	taskMemoryBank: TaskMemoryBank;
	telemetry: TelemetryContract;
	termination: ReturnType<typeof getTerminationCoordinator>;
	toolBootstrap: ToolBootstrapHandle;
	toolRegistry: ToolRegistry;
	turnControl: TurnControlRunner;
	turnOutcomeCollector: TurnOutcomeCollector;
	visionSidecar: VisionSidecar;
	cells: BootChatCells;
}

/**
 * Stage P12: the chat loop over everything wired before it, its settlement and shutdown, the resumed transcript
 * replay, and the run helpers the surfaces share (context init, run IO capture, the session extension host).
 */
export function startBootChat(input: BootChatInput) {
	const {
		acpInterviews,
		acpMode,
		admitModelFlow,
		askUserBridge,
		autonomyWindow,
		beforeTurnRecorded,
		bootStderr,
		BUILTIN_SLASH_NAMES,
		bus,
		config,
		contextDomain,
		createChatLoop,
		createProductionAutoCompact,
		decisionBoard,
		dispatch,
		dispatchBackground,
		EXIT_RELEASE_MS,
		extensionReload,
		extensions,
		flowLedger,
		getCurrentSettings,
		getReadySkillCount,
		interactive,
		jobHost,
		loopGuard,
		memoryEnabledNow,
		memoryGuardian,
		memoryIntervention,
		memoryOwner,
		memoryReader,
		memoryRouteAvailable,
		middleware,
		middlewareToolChoice,
		operatorReturned,
		options,
		prompts,
		protectedArtifactsGuard,
		providers,
		readCurrentSessionEntries,
		readOrchTurnToolCallBudget,
		releasePancodeLoadedModelsOnExit,
		replayCurrentSession,
		resolveEffectiveAutonomy,
		resumedSessionAtBoot,
		routeProvenance,
		runtimeHooks,
		safety,
		seedOutcomeFromSession,
		session,
		sessionScheduling,
		systemOne,
		taskEstablished,
		taskMemoryBank,
		telemetry,
		termination,
		toolBootstrap,
		toolRegistry,
		turnControl,
		turnOutcomeCollector,
		visionSidecar,
	} = input;
	const { cells } = input;
	// No boundary from here to `lease.adopt`. The chat loop starts a target probe
	// and a prewarm timer whose notices, like the lease diagnostics taken below,
	// reach only subscribers the interactive application registers; a loop turn
	// in between would deliver them to nobody.
	const chat = createChatLoop({
		...(acpInterviews ? { eggAsk: askUserBridge } : {}),
		turnControl,
		turnOutcomeCollector,
		hostCompletionFacts: () => cells.declaredCompletionFacts,
		...(dispatch ? { outcomeDispatch: dispatch } : {}),
		getTaskEstablished: taskEstablished,
		visionSidecar,
		getReadySkillCount,
		pinnedContext: () => runtimeHooks.pinned(),
		...(options.headless === undefined ? { getRouteSources: () => routeProvenance().active } : {}),
		interactiveGuidance: !options.headless && !options.acp,
		// Headless binds its single task's ceiling after template expansion (#423).
		...(options.headless === undefined && options.toolLimits !== undefined
			? { sessionToolLimits: options.toolLimits }
			: {}),
		...(acpInterviews ? { operatorInterviews: true } : {}),
		headless: options.headless !== undefined,
		// Without a steer channel nothing can reach a headless run mid-turn.
		...(options.headless !== undefined && options.headless.steerChannel === undefined ? { liveSteering: false } : {}),
		sandboxAvailability,
		// The pre-warm holds one slot on its endpoint while it runs, so dispatch
		// admission (#250) sees it exactly as it sees the orchestrator's own turn.
		registerPrewarmEndpointSlot: (runtime) => {
			const key = modelEndpointKey(runtime.runtimeResolution.target, runtime.wireModelId);
			return key === null ? null : registerForegroundStream(key);
		},
		getSettings: getCurrentSettings,
		getAutonomy: resolveEffectiveAutonomy,
		autonomy: {
			halted: () => autonomyWindow.halted(),
			operatorSpoke: operatorReturned,
			turnStarted: () => autonomyWindow.turnStarted(),
			turnSettled: () => autonomyWindow.turnSettled(),
			status: () => {
				const caps = autonomyWindow.caps();
				if (caps === null) return null;
				return {
					usage: autonomyWindow.usage(),
					turn: loopGuard.turnMeter(autonomyWindow.turnToolCalls(), readOrchTurnToolCallBudget().soft),
					caps,
					halted: autonomyWindow.halted(),
					osSandbox: mainShellContained(getCurrentSettings().safety.sandbox, sandboxAvailability()),
				};
			},
		},
		providers,
		middleware,
		// The turn_start observation rides the prompt seam, so it names the line
		// the operator typed (or a hook's rewrite of it), never an expanded
		// template body.
		promptSubmit: async ({ typed, text, origin }) => {
			const gate = extensionReload.promptGate();
			const verdict =
				gate !== null && gate.size > 0
					? await gate.run(typed, typed === text, origin, providers.chatModel?.())
					: { kind: "pass" as const, text: typed, notices: [], advisories: [] };
			const executor = runtimeHooks.current();
			for (const notice of verdict.notices) executor?.notify(notice);
			for (const { text, key } of verdict.advisories) {
				if (executor?.advise) executor.advise(text, key);
				else executor?.notify(text);
			}
			if (verdict.kind === "block") return { kind: "block" as const, reason: verdict.reason };
			executor?.observeTurnStart?.(verdict.text);
			return { kind: "pass" as const, text: verdict.text === typed ? text : verdict.text };
		},
		middlewareToolChoice,
		protectedArtifacts: {
			replace: (state) => protectedArtifactsGuard.replaceState(state),
			markDegraded: (reason) => protectedArtifactsGuard.markDegraded(reason),
		},
		knownTargets: () => new Set(providers.list().map((entry) => entry.target.id)),
		telemetry,
		...(sessionScheduling ? { scheduling: sessionScheduling } : {}),
		bus,
		...(prompts ? { prompts } : {}),
		...(session ? { session } : {}),
		memoryEnabled: memoryEnabledNow,
		beforeTurnRecorded,
		getMemorySection: (request) => {
			cells.lastMemoryPromptRuntimeId = request.runtimeId;
			return memoryReader(request);
		},
		operatorMemory: memoryOwner.operatorStatements,
		getMemoryRecordStatuses: (ids) => {
			try {
				const records = new Map(readMemoryStoreSnapshot(pancodeDataDir()).records.map((record) => [record.id, record]));
				return new Map(ids.map((id) => [id, memoryRecordStanding(records.get(id))] as const));
			} catch {
				// An unreadable store cannot establish a withdrawal (#423).
				return new Map();
			}
		},
		onOperatorTurn: ({ task }) => {
			cells.operatorTask = task;
			if ((session?.current()?.id ?? null) !== cells.outcomeSessionId) seedOutcomeFromSession();
		},
		currentOperatorTask: () => cells.operatorTask,
		systemOne,
		// The skill writes a plain file that a later session reads with no label; /handoff carries the labels.
		refuseHandoffSkill: (inlinedPaths) => {
			// Read through current(): labels absorbed before a session exists have no session id to ask about.
			if ((flowLedger.current()?.restrictions.length ?? 0) === 0 && flowLedger.refusal() === null) {
				const inlinedLabels =
					inlinedPaths.length > 0 ? (safety?.policy?.flowRestrictionsForPaths?.(inlinedPaths, process.cwd()) ?? null) : null;
				return inlinedLabels === null
					? null
					: "context-handoff refused: this request references a file under an information-flow restriction, and a handoff file carries no label. Nothing was sent and this session stays unrestricted. Send the request without that file.";
			}
			return `context-handoff refused: this session carries an information-flow restriction, and a handoff file carries no label. ${
				options.headless
					? "A headless run has no /handoff; hand off from an interactive session, where /handoff <goal> copies the restrictions into the new session."
					: "Use /handoff <goal>, which copies the restrictions into the new session."
			}`;
		},
		getTaskMemoryHandoffSource: () => {
			// Memory off stops handoff seeding, and the empty block still told the model to copy it into the handoff.
			if (!memoryEnabledNow()) return "";
			const meta = session?.current();
			if (!meta) throw new Error("task memory handoff requires an active session");
			const settings = getCurrentSettings();
			const targetId = meta.target ?? settings.chat?.target;
			const runtimeId = targetId ? providers.getTarget(targetId)?.runtime : undefined;
			return renderTaskMemoryHandoffSource(taskMemoryBank.snapshot(), {
				sessionId: meta.id,
				evidenceRefs: [`session-${meta.id}`],
				runtimeIds: runtimeId === undefined ? [] : [runtimeId],
				agentIds: [],
			});
		},
		memoryCommitBridge: memoryIntervention,
		onMemoryRequestSubmitted: (messages, systemPrompt) =>
			memoryOwner.recordSubmittedMemoryContext(hostFramedTexts(messages), systemPrompt),
		registerDeferredReminderSink: (sink) => {
			cells.deferredMemoryReminderSink = sink;
		},
		registerDeferredNoticeSink: (sink) => {
			cells.deferredWatchdogNoticeSink = sink;
		},
		onAskUserFinalized: (policy) => {
			decisionBoard.recordFinalizedInterview(policy);
		},
		...(session
			? {
					readSessionEntries: readCurrentSessionEntries,
					autoCompact: createProductionAutoCompact(session, getCurrentSettings, providers, telemetry, undefined, {
						...(sessionScheduling ? { scheduling: sessionScheduling } : {}),
						headless: options.headless !== undefined,
						getCeilingUsd: () => getCurrentSettings().safety.limits.sessionCostUsd,
						admitFlow: admitModelFlow,
						memory: memoryOwner,
					}),
				}
			: {}),
		toolRegistry,
		admitFlow: admitModelFlow,
		labelReferencedPaths: (paths) => flowLedger.labelPaths(paths, process.cwd(), "file-reference"),
		hasAttachedDispatch: () => dispatchBackground.size() > 0,
		// The pre-warm buys latency for a person about to type the next turn. A
		// headless `run` submits its one prompt immediately and an unattended boot
		// never submits at all, so neither has latency to buy; the ACP surface has
		// an operator on the other end of the client and keeps it.
		isLatencySurface: () => interactive || acpMode,
		isPrewarmBusy: () => Boolean(options.terminalLease?.editor.getText().trim()),
	});
	// The guardian works during a turn only through endpoint admission and
	// reads history shallowly while one streams, so it needs the live answer.
	cells.isChatStreaming = () => chat.isStreaming();
	// `/<id>:<prompt>` and `@<id>:<uri>` read the same servers on every surface; a read-only turn never starts one trusted above read.
	const mcpSubmit = toolBootstrap.mcpCapabilities
		? mcpSubmitReader(toolBootstrap.mcpCapabilities, {
				readOnly: () => options.headless?.constraints?.readOnly === true || chat.toolLimits?.()?.readOnly === true,
			})
		: undefined;
	jobHost.attachChat(chat);
	memoryGuardian.wake("ready");

	// Stop preparation and tool admission synchronously at the shutdown edge;
	// settlement still owns terminal events and accepted session appends.
	let chatSettlement: Promise<void> | undefined;
	const beginChatSettlement = (): Promise<void> => {
		if (chatSettlement) return chatSettlement;
		chat.dispose();
		chatSettlement = (async () => {
			await jobHost.close();
			await chat.whenSettled();
		})();
		return chatSettlement;
	};
	const unsubscribeChatShutdown = bus.subscribe("shutdown.requested", () => {
		void beginChatSettlement().catch(() => {
			// The awaited drain hook reports this same rejection.
		});
	});
	// Safe-exec has the longest local tool grace; external CLI grace is shorter.
	const chatShutdownAllowanceMs =
		SAFE_EXEC_DEFAULT_KILL_GRACE_MS +
		SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS +
		SAFE_EXEC_PIPE_DRAIN_BOUND_MS +
		resolveShutdownHookBudgetMs();
	termination.onDrain(
		async () => {
			unsubscribeChatShutdown();
			// Tool cleanup precedes terminal accounting and accepted writes; the
			// extra hook allowance covers settlement before domain persistence closes.
			await beginChatSettlement();
		},
		{ timeoutMs: chatShutdownAllowanceMs },
	);

	// Every Ollama chat pins its model with keep_alive -1, and the ownership
	// record dies with this process, so release the models this process loaded
	// once the drain above has stopped the turn that could pin them again
	// (#379). Terminate runs on every coordinated exit: a finished or failed
	// headless run, --timeout, SIGINT, SIGTERM, and interactive quit. The
	// release bounds itself, so an unreachable server never stalls the exit.
	termination.onTerminate(() => releasePancodeLoadedModelsOnExit(), { timeoutMs: EXIT_RELEASE_MS + 500 });

	// A boot-time resume (headless --session or --continue) must replay the resumed
	// session into the chat loop the same way the interactive /resume overlay
	// does. Without this, the first submit runs with an empty provider context
	// and parents its user turn at null, appending a second root that silently
	// abandons the resumed session's active path. The leaf id is restored even
	// when rebuilding replay messages fails, so parenting stays correct and
	// only the provider context degrades.
	if (resumedSessionAtBoot && session) {
		const resumedMeta = session.current();
		if (resumedMeta) {
			let leafTurnId: string | null = null;
			try {
				leafTurnId = session.leafId(resumedMeta.id);
			} catch (err) {
				bootStderr(
					`PanCode: failed to read resumed session tree ${resumedMeta.id}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
			try {
				const resumedEntries = readCurrentSessionEntries();
				telemetry?.resetSession(resumedMeta.id);
				// Scoped to the leaf resume landed on for the same reason the /resume
				// overlay is (issue #107): with a /tree pin persisted, the file still
				// holds the abandoned branch after the pinned turn, and replaying it
				// unfiltered seeds the provider with turns the next append does not
				// parent onto.
				replayCurrentSession({ session, chat, readEntries: () => resumedEntries }, resumedMeta.id, "leaf", leafTurnId);
			} catch (err) {
				chat.resetForSession(leafTurnId);
				bootStderr(
					`PanCode: failed to replay resumed session context ${resumedMeta.id}: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}

	const taskMemoryTier = (): "llm" | "rules" => {
		return memoryRouteAvailable() ? "llm" : "rules";
	};

	// One context-init runner for the TUI and ACP hosts.
	const runContextInit = async (
		options: {
			preview?: boolean;
			adopt?: boolean;
			applyPancodeMd?: boolean;
			rewritePancodeMd?: boolean;
			proposePancodeMd?: boolean;
			includeGlobalImports?: boolean;
			heuristic?: boolean;
			depth?: "quick" | "standard" | "deep";
			accept?: boolean;
			acceptRef?: string;
		},
		runIo?: RunIo,
	) => {
		if (options.accept === true) {
			if (!contextDomain?.acceptProposal) throw new Error("context domain unavailable");
			const accepted = contextDomain.acceptProposal({
				cwd: process.cwd(),
				...(options.acceptRef ? { ref: options.acceptRef } : {}),
			});
			if (!accepted.ok) throw new Error(`context init --accept refused: ${accepted.reason}`);
			runIo?.stdout(`Wrote ${accepted.handbookPath} from ${accepted.proposalPath}\n`);
			return accepted;
		}
		// Context init explores the repo with the configured target by
		// default, grounded in the freshly built codewiki, and falls back to the
		// deterministic heuristic when no target is reachable. --heuristic and
		// --preview skip model generation.
		const useModel = options.heuristic !== true && options.preview !== true;
		const bootstrapOptions = bootstrapInputFromInitOptions(options);
		if (!contextDomain) throw new Error("context domain unavailable");
		return contextDomain.runBootstrap({
			cwd: process.cwd(),
			...(runIo ? { io: runIo } : {}),
			adopt: options.adopt === true,
			...bootstrapOptions,
			...(useModel
				? {
						generate: modelBootstrapGenerate({
							dispatch,
							resolveRoute: () => {
								if (!config) throw new Error("context-bootstrap configuration unavailable");
								return resolveBootstrapRoute(config.get());
							},
							// Names the agent that actually ran and reports the throw as
							// what it is. "Scout unavailable" was wrong twice over: the
							// agent is context-bootstrap, and the same line was printed
							// for a worker that failed, a worker whose answer the loop
							// guard removed, and a worker that succeeded and whose
							// payload the reader then refused.
							onFallback: (err, mode) =>
								runIo?.stderr(
									`context init: context-bootstrap did not produce a handbook, using ${mode === "existing" ? "the existing PANCODE.md" : "the heuristic writer"} (${err.message})\n`,
								),
						}),
						modelId: "configured-pancode-target",
					}
				: {}),
		});
	};

	// A context operation that writes progress to a RunIo answers an ACP client with what it wrote.
	const captureRunIo = () => {
		const written: string[] = [];
		let warned = false;
		return {
			io: {
				stdout: (text: string) => {
					written.push(text);
				},
				stderr: (text: string) => {
					warned = true;
					written.push(text);
				},
			} satisfies RunIo,
			report: (fallback: string): AcpHostReport => ({
				level: warned ? "warn" : "success",
				text: written.join("").trim() || fallback,
			}),
		};
	};

	/**
	 * The api 2 runtime host of a headless run or an ACP session; the TUI hosts
	 * its own. Loaded only when an installed api 2 extension could run, so a
	 * session without one pays nothing. Disposed with the drain, which closes
	 * the session for each runtime.
	 */
	const startSessionExtensionHost = async (
		mode: "headless" | "acp",
		ask?: AskUserHandler,
	): Promise<import("../extension-host.js").ExtensionHost | null> => {
		if (!extensions) return null;
		const hostable = (cwd: string) =>
			extensions.list(cwd, { all: true }).filter((entry) => isLoadableExtension(entry) && entry.runtimeV2 !== undefined);
		if (hostable(process.cwd()).length === 0) return null;
		const { startExtensionHost } = await import("../extension-host.js");
		const host = startExtensionHost({
			mode,
			list: hostable,
			runtimeHooks,
			bus,
			chat,
			sessionId: () => session?.current()?.id ?? null,
			targetId: () => options.headless?.target ?? getCurrentSettings().chat.target ?? "",
			frozenTools: toolRegistry.listAll().flatMap((tool) => tool.sourceInfo?.extension || []),
			services: { providers, telemetry, session },
			sandboxUnixSockets: () => getCurrentSettings().safety.sandboxUnixSockets,
			readOnly: () => options.headless?.constraints?.readOnly === true,
			builtinCommandNames: () => BUILTIN_SLASH_NAMES,
			notify: (line) => process.stderr.write(`pancode: ${line}\n`),
			...(ask ? { ask } : {}),
		});
		termination.onDrain(() => host.dispose(), { timeoutMs: 6500 });
		return host;
	};
	return {
		beginChatSettlement,
		captureRunIo,
		chat,
		mcpSubmit,
		runContextInit,
		startSessionExtensionHost,
		taskMemoryTier,
		unsubscribeChatShutdown,
	};
}
