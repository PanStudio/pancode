// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import {
	bindBoardActions,
	createAcpElicitationChannel,
	createAcpInterviewChannel,
	createHostToolEvents,
	followWorkerRuns,
	oracleBriefingFromEntries,
	runHostDispatch,
} from "../acp/host-members.js";
import type { AcpHandoffControl } from "../acp/server-options.js";
import { createStdioServerTransport } from "../acp/transport.js";
import type { RunJsonMainSessionFrame } from "../cli/modes/run-json-schema.js";
import { RUN_JSON_SCHEMA_VERSION } from "../cli/modes/run-json-schema.js";
import { writeRunDiagnostic } from "../cli/run-failure.js";
import { startLoginEnvCapture } from "../core/bash-exec.js";
import { formatBootTrace } from "../core/boot-trace.js";
import { readPancodeVersionLabel } from "../core/build-info.js";
import { type PancodeSettings, readSettings } from "../core/config.js";
import { setAutonomousCommitProcess } from "../core/git-commit-attribution.js";
import { ensureProjectIgnore } from "../core/project-root.js";
import { StartupTimer } from "../core/startup-timer.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { yieldToEventLoop } from "../core/timers.js";
import { captureProjectSurface, projectSurfaceTrustNotice } from "../core/workspace-trust.js";
import { createWorktreeBootRecovery } from "../domains/dispatch/index.js";
import { ensurePancodeState } from "../domains/install/index.js";
import { prepareBackgroundMemoryModel } from "../domains/memory/background-route.js";
import { createCapabilityGate } from "../domains/middleware/capability-gate.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import {
	type LlmRequestAdmission,
	type OneShotPort,
	oneShotRoundOptions,
	oneShotTokens,
} from "../domains/providers/one-shot.js";
import { resolveModelReference } from "../domains/providers/resolver.js";
import { LOCAL_API_KEY_FALLBACK, resolveSideCallAuth } from "../domains/providers/side-call-auth.js";
import { resolveTarget } from "../domains/providers/unpriced-routes.js";
import { DEFAULT_RECENT_ENTRY_LIMIT } from "../domains/safety/finish-entries.js";
import type { GitHookDriftGuard } from "../domains/safety/hook-drift.js";
import type { FlowRestrictionSet } from "../domains/safety/index.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import type { SafetyJudgeSeat } from "../domains/safety/safety-judge.js";
import type { CompactInput, CompactResult } from "../domains/session/compaction/compact.js";
import {
	type CompactionFlowAdmission,
	type CompactionFlowBudget,
	type CompactionReplay,
	type CompactionTelemetry,
	runCompactionFlow,
} from "../domains/session/compaction/flow.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { commitHandoff, type HandoffServiceDeps, prepareHandoff } from "../domains/session/handoff-service.js";
import {
	declareRuntimeNoticeProducer,
	EXIT_RELEASE_MS,
	releasePancodeLoadedModelsOnExit,
	setProtectedModelsProvider,
} from "../engine/apis/residency.js";
import {
	callRepeatsAsRead,
	createLoopGuardRegistration,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
	readOrchTurnToolCallBudget,
} from "../engine/loop-guard.js";
import { cwdHash, openSession, readSessionTailTurns, sessionCurrentPath, sessionPaths } from "../engine/session.js";
import { wrapTextWithAnsi } from "../engine/text-wrap.js";
import type { AutonomyLevel } from "../lib/autonomy/autonomy.js";
import { createChatLoop, createTurnControlRunner, runOutOfTurnRound } from "../session-control/chat-loop.js";
import {
	answerExtensionLine,
	clampThinkingLevel,
	replayCurrentSession,
	resolvePermission,
	selectModel,
} from "../session-control/index.js";
import {
	buildModelReplayAgentMessagesFromTurns,
	continuityContextFromSession,
} from "../session-control/model-session-replay.js";
import { createTurnOutcomeCollector } from "../session-control/turn-outcome-collector.js";
import type { BootOptions } from "./boot-options.js";
import { FLOW_RESTRICTION_ENTRY_TYPE } from "./flow-ledger.js";
import { applyRouteOverlay } from "./route-overlay.js";

export type { BootOptions, HeadlessSamplingOverrides } from "./boot-options.js";

import {
	actionKeyLabel,
	detectPlatformKeybindingWarnings,
	detectTerminalKeySupport,
	formatInvalidKeybindingNotice,
	formatPlatformKeybindingNotice,
	validateKeybindings,
} from "../interactive/keybinding-manager.js";
import type { BootInteractivity } from "../interactive/terminal-lease.js";
import { createToolProseRegistration } from "../interactive/tool-prose-registration.js";
import { subscribeLoopGuardStop } from "../session-control/loop-guard-interrupt.js";
import {
	BUILTIN_SLASH_COMMANDS,
	BUILTIN_SLASH_NAMES,
	formatExtensionReloadNotice,
	parseSlashCommand,
} from "../session-control/slash-commands.js";
import { runWatchdogReview } from "../session-control/watchdog-run.js";
import { startToolOffloadSweep } from "../tools/result-shaping.js";
import { runAcpSurface } from "./boot/acp-surface.js";
import { buildBootAutonomy } from "./boot/autonomy.js";
import { startBootChat } from "./boot/chat.js";
import { loadBootDomains } from "./boot/domains.js";
import { wireBootExtensions } from "./boot/extension-reload.js";
import { buildBootGuards } from "./boot/guards.js";
import { runHeadlessSurface } from "./boot/headless-surface.js";
import { runInteractiveSurface } from "./boot/interactive-surface.js";
import { wireBootMemory } from "./boot/memory.js";
import { buildBootRegistry } from "./boot/registry.js";
import { resolveBootResume } from "./boot/resume.js";
import { startBootSession } from "./boot/session-start.js";
import { buildBootSettings } from "./boot/settings.js";
import type { BootSurfaceCells, BootSurfaceInput, BootSurfaceSeams } from "./boot/surface.js";
import { buildBootSystemOne } from "./boot/system-one.js";
import { registerBootTools } from "./boot/tools.js";
import { registerBootTurnHooks } from "./boot/turn-hooks.js";

export interface BootResult {
	exitCode: number;
	bootTimeMs: number;
}

/**
 * The bannered boot is the whole of what a piped or CI invocation of bare
 * `pancode` shows, so it is the entire first impression for a stranger who is not
 * on a TTY. It used to end in a hardcoded `ready`, a word with no relationship
 * to anything: a machine with no target configured at all printed it and
 * exited 0, which is the one state where the installation can do nothing.
 *
 * What the line reports now is the orchestrator target the settings actually
 * declare, and when none is declared it says so and names the command that
 * fixes it. The exit status stays 0 either way, because this path answers
 * "did PanCode boot", which it did, and CI scripts already depend on that
 * answer; the readiness of the configuration is reported in words instead.
 */
function bannerConfigurationLine(): string {
	let settings: PancodeSettings;
	try {
		settings = readSettings();
	} catch {
		return chalk.yellow("settings.yaml is not valid. Run `pancode doctor` for the exact keys.");
	}
	// A dangling chat target normalizes to null in the schema, so a deleted
	// target arrives here as no target at all rather than as a name to report.
	const targetId = settings.chat?.target;
	if (!targetId) {
		return chalk.yellow("no model connection configured. Run `pancode configure` to add one.");
	}
	const model = settings.chat?.model;
	return chalk.dim(`connection ${targetId}${model ? ` · model ${model}` : " · no default model"}`);
}

function buildBanner(): string {
	const pancode = readPancodeVersionLabel();
	return `
  ${chalk.cyan("PanCode")}
  ${chalk.dim(`v${pancode} · PanCode · HPC & scientific software`)}
  ${bannerConfigurationLine()}
`;
}

/** The session frame names the route the run is on, which a resume's --connection or --model may have moved (B-52). */
function printJsonSessionHeader(
	meta: SessionMeta | null,
	active: PancodeSettings["chat"],
): RunJsonMainSessionFrame | null {
	if (!meta) return null;
	return {
		type: "session",
		schemaVersion: RUN_JSON_SCHEMA_VERSION,
		mode: "main",
		version: meta.sessionFormatVersion,
		id: meta.id,
		timestamp: meta.createdAt,
		cwd: meta.cwd,
		target: active.target ?? meta.target,
		model: active.model ?? meta.model,
		pancodeVersion: meta.pancodeVersion,
	};
}

/**
 * One tool-free completion for a System One engine that reads an ordinary chat
 * target, for the runtimes that have no chat-completions wire of their own
 * (subscription and CLI-backed ones). Target and model resolve the way the
 * background memory role resolves them, and the round runs beside the session
 * without ever becoming a turn. The answer is text, so an engine behind this
 * port can vote but cannot read logprobs.
 */
function createSystemOneOneShot(providers: ProvidersContract, admitRequest: LlmRequestAdmission): OneShotPort {
	return async (request) => {
		const target = providers.getTarget(request.targetId);
		const wireModelId = request.model ?? target?.defaultModel ?? null;
		if (target === null || wireModelId === null) {
			throw new Error(`connection '${request.targetId}' names no model to ask`);
		}
		const { model, refined } = prepareBackgroundMemoryModel(providers, request.targetId, wireModelId);
		const sideAuth = await resolveSideCallAuth(
			providers.auth,
			refined.target,
			refined.runtime,
			LOCAL_API_KEY_FALLBACK,
			request.signal,
		);
		let recordUsage: Awaited<ReturnType<LlmRequestAdmission>> | undefined;
		const result = await runOutOfTurnRound({
			model,
			messages: [],
			systemPrompt: request.system,
			userText: request.user,
			maxTokens: request.maxTokens,
			// A vote, resolved for thinking off the way the memory role resolves;
			// the round must ask for the same.
			thinkingLevel: "off",
			signal: request.signal,
			runtimeId: refined.runtime.id,
			beforeRequest: async () => {
				recordUsage = await admitRequest({
					...(request.engine !== undefined ? { engine: request.engine } : {}),
					targetId: request.targetId,
					model: wireModelId,
					signal: request.signal,
				});
				return recordUsage.withContext ? { withContext: recordUsage.withContext } : undefined;
			},
			onUsage: (usage, observation) => recordUsage?.(usage, observation),
			...sideAuth,
			...oneShotRoundOptions(request),
		});
		if (result.aborted) throw new Error("the one-shot round was aborted");
		return {
			text: result.text,
			...(result.usage !== null ? { usage: oneShotTokens(result.usage) } : {}),
			...(result.reportedModel !== undefined ? { model: result.reportedModel } : {}),
		};
	};
}

const emitQuotaNotice = declareRuntimeNoticeProducer("anthropic-quota", ["stress"]);

function readSessionEntriesForCompact(sessionId: string): SessionEntry[] {
	const reader = openSession(sessionId);
	return collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current);
}

/** Only flow custom entries need validation here; message payloads never enter this ledger. */
function readFlowSessionEntries(sessionId: string): ReadonlyArray<unknown> {
	return openSession(sessionId)
		.turns()
		.filter(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"customType" in entry &&
				entry.customType === FLOW_RESTRICTION_ENTRY_TYPE,
		);
}

/**
 * The finish-contract only inspects the window since the last user message
 * (`recentEntries`, capped at 80), so it reads a bounded tail of the ledger
 * instead of parsing the whole file every turn_end. 160 = twice the 80-entry cap
 * leaves ample margin above any entries appended after the assistant turn, so the
 * assessed window is byte-identical to the whole-file read (see the
 * behaviour-equivalence contract test) while cost stays bounded by session
 * *shape*, not session *length*.
 */
const FINISH_CONTRACT_TAIL_ENTRIES = DEFAULT_RECENT_ENTRY_LIMIT * 2;

/** No session reads as none, which disables the finish contract's assessment for the turn. */
function readRecentSessionEntriesForContract(sessionId: string): SessionEntry[];
function readRecentSessionEntriesForContract(sessionId: string | undefined): SessionEntry[] | null;
function readRecentSessionEntriesForContract(sessionId: string | undefined): SessionEntry[] | null {
	if (sessionId === undefined) return null;
	return collectSessionEntries(
		readSessionTailTurns(sessionId, FINISH_CONTRACT_TAIL_ENTRIES).entries,
		sessionCurrentPath(sessionId),
	);
}

/**
 * Compose the production chat-loop compaction callback. Errors intentionally
 * propagate: the chat loop owns activity failure reporting and distinguishes
 * a thrown read/model/persistence failure from the legitimate no-op that
 * `runCompactionFlow` returns: null for an empty session, and a result with no
 * summary and its `emptyReason` for an unavailable cut.
 */
export function createProductionAutoCompact(
	session: SessionContract,
	getSettings: () => PancodeSettings,
	providers: ProvidersContract,
	telemetry?: CompactionTelemetry,
	summarize?: CompactInput["summarize"],
	admission?: CompactionFlowAdmission,
): (
	instructions?: string,
	trigger?: CompactionTrigger,
	budget?: CompactionFlowBudget,
) => Promise<CompactResult | null> {
	return (instructions, trigger, budget) =>
		runCompactionFlow(
			replayCompactionHistory,
			session,
			getSettings(),
			providers,
			instructions,
			trigger,
			telemetry,
			budget,
			summarize,
			admission,
		);
}

/** The session-control replay the compaction flow prices its before and after projections with. */
const replayCompactionHistory: CompactionReplay = (session, history, activeLeafTurnId) =>
	buildModelReplayAgentMessagesFromTurns(history, {
		...(activeLeafTurnId === undefined ? {} : { activeLeafTurnId }),
		continuity: continuityContextFromSession(session),
	});

export async function bootOrchestrator(options: BootOptions = {}): Promise<BootResult> {
	const { registerRunningBuild } = await import("../core/running-build.js");
	const bootSurface = options.acp ? "acp" : options.headless ? "run" : "tui";
	registerRunningBuild(bootSurface);
	// Only a headless run commits autonomously; TUI and ACP sessions keep the human author at any autonomy.
	setAutonomousCommitProcess(bootSurface === "run");
	// Every session this boot opens names its surface in the live record (#439).
	(await import("../domains/session/heartbeat.js")).configureSessionHeartbeat({
		surface: bootSurface,
		terminate: (notice) => {
			const termination = getTerminationCoordinator();
			termination.notice(notice);
			void termination.shutdown(143);
		},
		signalNotice: (explain) => getTerminationCoordinator().explainSignal(explain),
	});
	const capabilityGate = createCapabilityGate();
	const bootStdout = (text: string): void => {
		if (options.terminalLease) options.terminalLease.writeDiagnostic("stdout", text);
		else process.stdout.write(text);
	};
	const bootStderr = (text: string): void => {
		if (options.terminalLease) options.terminalLease.writeDiagnostic("stderr", text);
		else process.stderr.write(text);
	};
	const timer = new StartupTimer(
		options.terminalLease
			? (phase, detail) => {
					const line = formatBootTrace(phase, detail);
					if (line) options.terminalLease?.deferDiagnostic("stderr", line);
				}
			: undefined,
	);
	/**
	 * The boot timer's phases as process.booted, once, when the surface first answers: the numbers PANCODE_TRACE_BOOT
	 * prints are the ones the process journal keeps (#434). The spilled tool output sweep starts then, off the boot path.
	 */
	let bootRecorded = false;
	const recordBoot = (interactivity?: BootInteractivity): void => {
		if (bootRecorded) return;
		bootRecorded = true;
		termination.onTerminate(startToolOffloadSweep());
		const tenth = (ms: number) => Math.max(0, Math.round(ms * 10) / 10);
		const snapshot = timer.snapshot();
		telemetryHub().emit("process.booted", {
			surface: bootSurface,
			node: process.version,
			platform: `${process.platform}-${process.arch}`,
			totalMs: tenth(snapshot.totalMs),
			phases: snapshot.marks.slice(0, 64).map((mark) => ({ name: mark.name, atMs: tenth(mark.at) })),
			...(interactivity
				? {
						interactivity: {
							stage0Ms: tenth(interactivity.stage0Ms),
							hydratedMs: tenth(interactivity.hydratedMs),
							inputBlockedMaxMs: tenth(interactivity.inputBlockedMaxMs),
						},
					}
				: {}),
		});
	};
	// The Stage 0 shell answers the terminal only when the event loop turns.
	// Boot yields at each phase boundary, so typing, submits, Ctrl+C, resize and
	// signals are handled while Stage 1 hydrates. Once Ctrl+C or a signal closes
	// the lease, hydration stops at the next boundary and the shutdown that
	// closed the lease owns the exit.
	const lease = options.terminalLease;
	const bootPhaseBoundary = lease
		? async (): Promise<void> => {
				await yieldToEventLoop();
				lease.abortSignal.throwIfAborted();
			}
		: undefined;
	const bus = telemetryHub();
	const termination = getTerminationCoordinator();
	termination.installSignalHandlers({ textWrapper: wrapTextWithAnsi });

	ensurePancodeState();
	// A `.pancode/` without PanCode's own ignore file gets one on open.
	if (existsSync(join(process.cwd(), ".pancode"))) ensureProjectIgnore(process.cwd());
	// The leased TUI turns boot diagnostics into transcript notices. Without a
	// lease (instant shell off) stderr would print before the first frame, so
	// the interactive boot holds trust notices for the transcript instead (C-4).
	const holdTrustNotices =
		options.terminalLease === undefined &&
		!options.headless &&
		options.acp === undefined &&
		process.env.PANCODE_INTERACTIVE === "1";
	const heldTrustNotices: string[] = [...(options.trustCardNotices ?? [])];
	for (const surface of ["safety", "settings", "extensions", "plugins"] as const) {
		const snapshot = captureProjectSurface(process.cwd(), surface);
		if (snapshot.verdict === "trusted" || options.trustCardNotices !== undefined) continue;
		for (const file of snapshot.files) {
			if (file.text !== null || file.error !== undefined) {
				const notice = projectSurfaceTrustNotice(snapshot, file.path);
				// The tag tells a stderr reader which program spoke; a notice inside PanCode needs no tag and showed it raw.
				if (holdTrustNotices) heldTrustNotices.push(notice);
				else bootStderr(`[pancode:trust] ${notice}\n`);
			}
		}
	}
	timer.mark("install check");

	// A hard-killed coordinator leaves compete groups and task worktrees behind.
	// Their recovery starts once the first frame is up; dispatch holds its ledger
	// scan and every admission until it settles.
	const worktreeRecovery = createWorktreeBootRecovery({
		cwd: process.cwd(),
		...(options.startupSettings ? { worktreeRootSetting: options.startupSettings.fleet.worktrees.root } : {}),
	});
	// The first turn since the orchestrator graph loaded.
	await bootPhaseBoundary?.();

	let effectiveSettingsForDispatch: (() => Readonly<PancodeSettings>) | null = null;
	let protectedArtifactStateForDispatch: (() => ProtectedArtifactState) | null = null;
	// Bound once the session flow ledger exists; dispatch reads it per request.
	let flowRestrictionsForDispatch: (() => FlowRestrictionSet | null) | null = null;
	let sessionOriginForDispatch: (() => { id: string; cwdHash: string; parentSessionId?: string | null } | null) | null =
		null;
	// Bound once the safety judge and the autonomy resolver exist; a worker ask
	// that arrives before then finds no judge and is denied.
	let workerAskJudgeForDispatch: {
		seat: () => SafetyJudgeSeat;
		autonomy: () => AutonomyLevel;
		operatorAutonomy: () => AutonomyLevel;
		hookDrift: () => GitHookDriftGuard;
	} | null = null;
	const {
		acpElicitationChannel,
		acpInterviewChannel,
		acpInterviews,
		acpWorkerPermissions,
		dispatch,
		memoryOwner,
		middlewareDomain,
		outputStyleListeners,
		result,
		telemetryDomain,
		withPanes,
		domainsState,
	} = await loadBootDomains({
		bootPhaseBoundary,
		bootStderr,
		BUILTIN_SLASH_COMMANDS,
		bus,
		capabilityGate,
		createAcpElicitationChannel,
		createAcpInterviewChannel,
		options,
		termination,
		timer,
		worktreeRecovery,
		cells: {
			get askUserBridge() {
				return askUserBridge;
			},
			get effectiveSettingsForDispatch() {
				return effectiveSettingsForDispatch;
			},
			get flowRestrictionsForDispatch() {
				return flowRestrictionsForDispatch;
			},
			get getCurrentSettings() {
				return getCurrentSettings;
			},
			get protectedArtifactStateForDispatch() {
				return protectedArtifactStateForDispatch;
			},
			get registryState() {
				return registryState;
			},
			get safety() {
				return safety;
			},
			get sessionOriginForDispatch() {
				return sessionOriginForDispatch;
			},
			get workerAskJudgeForDispatch() {
				return workerAskJudgeForDispatch;
			},
		},
	});

	bus.emit("session.started", { at: Date.now() });
	timer.mark("session_start fired");

	const acpMode = options.acp !== undefined;
	const interactive = !options.headless && !acpMode && process.env.PANCODE_INTERACTIVE === "1";
	if (interactive || acpMode) dispatch?.warmRouteHistory?.();
	// Headless and ACP boots paint no frame; recovery starts with the session.
	if (!interactive) void worktreeRecovery.start();
	if (!interactive && !options.headless && !acpMode) {
		bootStdout(buildBanner());
		if (process.env.PANCODE_TIMING === "1") bootStdout(`${timer.report()}\n`);
	}

	const config = result.getContract("config");
	const providers = result.getContract("providers");
	timer.mark("providers resolved");

	if (!interactive && !options.headless && !acpMode) {
		bootStdout(`${chalk.dim("  (non-interactive boot. pass PANCODE_INTERACTIVE=1 to launch the TUI.)")}\n`);
		await termination.shutdown(0);
		return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
	}
	const {
		admitModelFlow,
		agents,
		contextDomain,
		extensions,
		flowLedger,
		flowPort,
		initialNotices,
		interop,
		middleware,
		middlewareRegistrar,
		mux,
		prompts,
		resources,
		safety,
		session,
		telemetry,
		telemetryRunReaders,
	} = await startBootSession({
		heldTrustNotices,
		interactive,
		middlewareDomain,
		providers,
		readFlowSessionEntries,
		result,
		telemetryDomain,
		cells: {
			get flowRestrictionsForDispatch() {
				return flowRestrictionsForDispatch;
			},
			set flowRestrictionsForDispatch(value) {
				flowRestrictionsForDispatch = value;
			},
			get sessionOriginForDispatch() {
				return sessionOriginForDispatch;
			},
			set sessionOriginForDispatch(value) {
				sessionOriginForDispatch = value;
			},
		},
	});
	if (!providers || !dispatch || !telemetry || !safety || !middleware || !middlewareRegistrar) {
		bootStderr(
			"PanCode: chat mode requires safety + middleware + providers + dispatch + telemetry contracts; aborting.\n",
		);
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}
	const { resumeState } = resolveBootResume({ bootStderr, bus, interactive, options, session, termination });
	if (resumeState.headlessResumeFailure !== null && !options.headless)
		initialNotices.push(`Nothing resumed: ${resumeState.headlessResumeFailure}. This is a fresh session.`);
	else if (resumeState.headlessResumeFailure !== null) {
		writeRunDiagnostic(`pancode run: ${resumeState.headlessResumeFailure}\n`, resumeState.headlessResumeSlug);
		await termination.shutdown(2);
		return { exitCode: 2, bootTimeMs: timer.snapshot().totalMs };
	}
	const { activePathEntries, loopGuard, protectedArtifactsGuard, resolvedSettings } = buildBootGuards({
		acpMode,
		bus,
		config,
		createLoopGuardRegistration,
		emitQuotaNotice,
		interactive,
		INTERACTIVE_LOOP_BLOCK_BUDGET,
		INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
		middlewareRegistrar,
		readOrchTurnToolCallBudget,
		safety,
		session,
		termination,
		cells: {
			get effectiveSettingsForDispatch() {
				return effectiveSettingsForDispatch;
			},
			get protectedArtifactStateForDispatch() {
				return protectedArtifactStateForDispatch;
			},
			set protectedArtifactStateForDispatch(value) {
				protectedArtifactStateForDispatch = value;
			},
		},
	});
	const {
		beforeShellEntryRecorded,
		beforeTurnRecorded,
		guardianState,
		historyReviews,
		memoryEnabledNow,
		memoryIntervention,
		memoryRouteAvailable,
		memoryWorkspaceRoot,
		taskMemoryBank,
		memoryState,
	} = wireBootMemory({
		admitModelFlow,
		bus,
		config,
		flowLedger,
		memoryOwner,
		middlewareRegistrar,
		options,
		providers,
		result,
		session,
		telemetry,
		termination,
		cells: {
			get chat() {
				return chat;
			},
			get effectiveSettingsForDispatch() {
				return effectiveSettingsForDispatch;
			},
			get getCurrentSettings() {
				return getCurrentSettings;
			},
		},
	});
	const {
		chatIdle,
		commitExtensionHooks,
		extensionReload,
		reloadClasses,
		reloadPlugins,
		runtimeHooks,
		sessionCodeConsent,
		extensionsState,
	} = wireBootExtensions({
		bus,
		config,
		contextDomain,
		extensions,
		formatExtensionReloadNotice,
		initialNotices,
		interactive,
		middlewareRegistrar,
		options,
		session,
		cells: {
			get chat() {
				return chat;
			},
			get toolBootstrap() {
				return toolBootstrap;
			},
			get workerHookSource() {
				return domainsState.workerHookSource;
			},
			set workerHookSource(value) {
				domainsState.workerHookSource = value;
			},
		},
	});
	await bootPhaseBoundary?.();
	extensionReload.applyBoot();
	middlewareRegistrar.registerHook(protectedArtifactsGuard);
	extensionsState.bootHookNotices = false;
	// The interactive graph loads while Stage 0 takes keys, before the chat loop starts producers whose notices reach
	// only the built application, so the import that starts the application finds it loaded. Fleet history loads later.
	if (lease) await import("../interactive/index.js");
	// A lease closed during that load stops boot here, before anything builds against it.
	await bootPhaseBoundary?.();
	const {
		autonomyWindow,
		getReadySkillCount,
		hookDrift,
		middlewareToolChoice,
		operatorReturned,
		resolveAdmissionAutonomy,
		resolveBaselineAutonomy,
		resolveEffectiveAutonomy,
		safetyJudge,
		unattendedYolo,
		yoloRefusal,
		autonomyState,
	} = buildBootAutonomy({
		admitModelFlow,
		bus,
		capabilityGate,
		config,
		flowLedger,
		interactive,
		middlewareRegistrar,
		options,
		prompts,
		providers,
		resources,
		safety,
		session,
		cells: {
			get chat() {
				return chat;
			},
			get effectiveSettingsForDispatch() {
				return effectiveSettingsForDispatch;
			},
			get getCurrentSettings() {
				return getCurrentSettings;
			},
			get safetyJudgeOneShot() {
				return safetyJudgeOneShot;
			},
			get systemOne() {
				return systemOne;
			},
			get toolRegistry() {
				return toolRegistry;
			},
			get workerAskJudgeForDispatch() {
				return workerAskJudgeForDispatch;
			},
			set workerAskJudgeForDispatch(value) {
				workerAskJudgeForDispatch = value;
			},
		},
	});
	const {
		askUserBridge,
		decisionBoard,
		dispatchBackground,
		panes,
		reportSession,
		taskBoard,
		toolRegistry,
		userTasks,
		registryState,
	} = buildBootRegistry({
		acpInterviewChannel,
		acpMode,
		activePathEntries,
		autonomyWindow,
		bus,
		dispatch,
		flowLedger,
		flowPort,
		hookDrift,
		loopGuard,
		middleware,
		middlewareToolChoice,
		mux,
		operatorReturned,
		options,
		protectedArtifactsGuard,
		resolveAdmissionAutonomy,
		resolveEffectiveAutonomy,
		safety,
		safetyJudge,
		session,
		sessionCodeConsent,
		unattendedYolo,
		withPanes,
		cells: {
			get getCurrentSettings() {
				return getCurrentSettings;
			},
			get toolBootstrap() {
				return toolBootstrap;
			},
		},
	});

	// The effective view has to exist before anything below composes against it.
	// `systemOne.bound()` reads it while the tool registry is assembled,
	// and a `const` declared after that call is still in its temporal dead zone:
	// bound() swallows the ReferenceError, so every start read as an unbound site
	// and the consult tool never registered.
	// Live routing is owned by this process. Seed it once from saved settings
	// (with any headless CLI overrides baked in); from here on every consumer
	// reads the effective view — shared snapshot + session routing overlay — so
	// another process writing settings.yaml can update defaults and the
	// target catalog but never redirect this session's routing.
	// `run --connection/--model` and the interactive `pancode --connection/--model` seed the session route the same way.
	const routeRequest = options.headless ?? options.route;
	const initialRoutingSettings = applyRouteOverlay(config?.get() ?? readSettings(), routeRequest);
	if (routeRequest?.model !== undefined && providers) {
		// An explicit typed model resolves once, before the concrete session route is seeded (#416).
		try {
			await providers.probeAllLive();
		} catch (err) {
			bootStderr(
				`PanCode: model refresh failed; resolving cached catalog: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		const selected = resolveModelReference(
			routeRequest.model,
			routeRequest.target === undefined
				? providers
				: { ...providers, list: () => providers.list().filter((status) => status.target.id === routeRequest.target) },
			{
				use: "chat",
				...(initialRoutingSettings.chat.target ? { preferTarget: initialRoutingSettings.chat.target } : {}),
			},
		);
		if (selected.ref) {
			initialRoutingSettings.chat.target = selected.ref.target;
			initialRoutingSettings.chat.model = selected.ref.model;
			if (options.headless?.thinking === undefined && selected.ref.thinkingLevel) {
				initialRoutingSettings.chat.thinkingLevel = selected.ref.thinkingLevel;
			}
			if (selected.warning) bootStderr(`PanCode: ${selected.warning}\n`);
		} else if (selected.error || options.apiKey) {
			const exitCode = options.apiKey || /^no models match|not chat-eligible/u.test(selected.error ?? "") ? 2 : 1;
			const reason = selected.error ?? "--api-key supplied but the model connection could not be resolved";
			if (options.headless) writeRunDiagnostic(`pancode run: ${reason}\n`);
			else bootStderr(`pancode: ${reason}\n`);
			await termination.shutdown(exitCode);
			return { exitCode, bootTimeMs: timer.snapshot().totalMs };
		}
	}
	const {
		applySettingsBlob,
		bumpSessionState,
		clampAtScope,
		commitAcpSafeSettings,
		commitSetting,
		createRoutedSession,
		getCurrentSettings,
		persistCurrentThinkingLevel,
		persistSavedMutation,
		readAcpSafeSettings,
		restoreResumedRoute,
		routeProvenance,
		routingGestures,
		selectAtScope,
		settingOrigin,
		startSessionSettings,
		startupOverrides,
		settingsState,
	} = buildBootSettings({
		bus,
		clampThinkingLevel,
		config,
		initialNotices,
		initialRoutingSettings,
		interactive,
		options,
		outputStyleListeners,
		providers,
		selectModel,
		session,
		yoloRefusal,
	});
	effectiveSettingsForDispatch = getCurrentSettings;
	void startLoginEnvCapture(); // after getCurrentSettings: building the capture's env reads unattendedYolo
	startSessionSettings((hook) => termination.onDrain(hook));
	const { safetyJudgeOneShot, sessionScheduling, systemOne, systemOneControl } = buildBootSystemOne({
		createSystemOneOneShot,
		cwdHash,
		flowLedger,
		getCurrentSettings,
		options,
		providers,
		result,
		session,
		telemetry,
		unattendedYolo,
	});
	const {
		getTaskMemorySeedOffer,
		jobHost,
		memoryReader,
		seedCurrentTaskMemoryFromHandoff,
		toolBootstrap,
		visionSidecar,
		toolState,
	} = registerBootTools({
		acpElicitationChannel,
		acpInterviews,
		acpMode,
		agents,
		askUserBridge,
		bootStderr,
		bus,
		capabilityGate,
		config,
		createRoutedSession,
		decisionBoard,
		detectPlatformKeybindingWarnings,
		detectTerminalKeySupport,
		dispatch,
		dispatchBackground,
		extensionReload,
		flowLedger,
		flowPort,
		formatInvalidKeybindingNotice,
		formatPlatformKeybindingNotice,
		getCurrentSettings,
		initialNotices,
		interactive,
		memoryEnabledNow,
		memoryOwner,
		memoryWorkspaceRoot,
		mux,
		options,
		panes,
		persistSavedMutation,
		providers,
		reportSession,
		resolveAdmissionAutonomy,
		resolvedSettings,
		resolveEffectiveAutonomy,
		restoreResumedRoute,
		result,
		resumedSessionAtBoot: resumeState.resumedSessionAtBoot,
		routeProvenance,
		safety,
		session,
		sessionCodeConsent,
		setProtectedModelsProvider,
		systemOne,
		taskBoard,
		taskMemoryBank,
		telemetry,
		termination,
		toolRegistry,
		userTasks,
		validateKeybindings,
		cells: {
			get askUserHandler() {
				return registryState.askUserHandler;
			},
			get chat() {
				return chat;
			},
			get deferredWatchdogNoticeSink() {
				return memoryState.deferredWatchdogNoticeSink;
			},
			get reportReviewOpener() {
				return registryState.reportReviewOpener;
			},
		},
	});
	if (options.apiKey) {
		const target = resolveTarget(providers, getCurrentSettings().chat.target);
		const runtime = target ? providers.getRuntime(target.runtime) : null;
		if (!target || !runtime) {
			bootStderr("PanCode: --api-key supplied but no active orchestrator connection could be resolved; refusing.\n");
			await termination.shutdown(2);
			return { exitCode: 2, bootTimeMs: timer.snapshot().totalMs };
		}
		providers.auth.setRuntimeOverrideForTarget(target, runtime, options.apiKey);
	}
	const {
		headlessGitHelpers,
		readCurrentSessionEntries,
		seedOutcomeFromSession,
		taskEstablished,
		turnControl,
		turnOutcomeCollector,
		turnHookState,
	} = registerBootTurnHooks({
		acpMode,
		actionKeyLabel,
		agents,
		autonomyWindow,
		bootStderr,
		bus,
		callRepeatsAsRead,
		createToolProseRegistration,
		createTurnControlRunner,
		createTurnOutcomeCollector,
		dispatch,
		effectiveSettingsForDispatch,
		getCurrentSettings,
		interactive,
		memoryWorkspaceRoot,
		middlewareRegistrar,
		options,
		readRecentSessionEntriesForContract,
		resolveEffectiveAutonomy,
		restoreResumedRoute,
		runWatchdogReview,
		safety,
		session,
		taskBoard,
		telemetry,
		termination,
		unattendedYolo,
		userTasks,
		cells: {
			get askUserHandler() {
				return registryState.askUserHandler;
			},
			get chat() {
				return chat;
			},
			get deferredWatchdogNoticeSink() {
				return memoryState.deferredWatchdogNoticeSink;
			},
		},
	});
	const {
		beginChatSettlement,
		captureRunIo,
		chat,
		mcpSubmit,
		runContextInit,
		startSessionExtensionHost,
		taskMemoryTier,
		unsubscribeChatShutdown,
	} = startBootChat({
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
		memoryGuardian: memoryState.memoryGuardian,
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
		resumedSessionAtBoot: resumeState.resumedSessionAtBoot,
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
		cells: {
			get declaredCompletionFacts() {
				return turnHookState.declaredCompletionFacts;
			},
			get deferredMemoryReminderSink() {
				return memoryState.deferredMemoryReminderSink;
			},
			set deferredMemoryReminderSink(value) {
				memoryState.deferredMemoryReminderSink = value;
			},
			get deferredWatchdogNoticeSink() {
				return memoryState.deferredWatchdogNoticeSink;
			},
			set deferredWatchdogNoticeSink(value) {
				memoryState.deferredWatchdogNoticeSink = value;
			},
			get isChatStreaming() {
				return memoryState.isChatStreaming;
			},
			set isChatStreaming(value) {
				memoryState.isChatStreaming = value;
			},
			get lastMemoryPromptRuntimeId() {
				return toolState.lastMemoryPromptRuntimeId;
			},
			set lastMemoryPromptRuntimeId(value) {
				toolState.lastMemoryPromptRuntimeId = value;
			},
			get operatorTask() {
				return toolState.operatorTask;
			},
			set operatorTask(value) {
				toolState.operatorTask = value;
			},
			get outcomeSessionId() {
				return turnHookState.outcomeSessionId;
			},
		},
	});

	// The surface tails in src/entry/boot/ read the wired session through `surface`. `cells` reaches the lets
	// closures here still assign, and `seams` carries what only this file may import (rule6).
	const cells: BootSurfaceCells = {
		get activeAcpSessionAutonomy() {
			return autonomyState.activeAcpSessionAutonomy;
		},
		set activeAcpSessionAutonomy(value) {
			autonomyState.activeAcpSessionAutonomy = value;
		},
		get askUserHandler() {
			return registryState.askUserHandler;
		},
		set askUserHandler(value) {
			registryState.askUserHandler = value;
		},
		get creditedRunChecks() {
			return turnHookState.creditedRunChecks;
		},
		get lastAutonomyHalt() {
			return autonomyState.lastAutonomyHalt;
		},
		get reportReviewOpener() {
			return registryState.reportReviewOpener;
		},
		set reportReviewOpener(value) {
			registryState.reportReviewOpener = value;
		},
		get resumedSessionAtBoot() {
			return resumeState.resumedSessionAtBoot;
		},
		get unsubscribeDispatchShutdown() {
			return domainsState.unsubscribeDispatchShutdown;
		},
		get yoloHeldAtBoot() {
			return settingsState.yoloHeldAtBoot;
		},
	};
	const surface: BootSurfaceInput = {
		acpElicitationChannel,
		acpInterviewChannel,
		acpInterviews,
		acpWorkerPermissions,
		activePathEntries,
		agents,
		applySettingsBlob,
		askUserBridge,
		autonomyWindow,
		beforeShellEntryRecorded,
		beginChatSettlement,
		bindAcpHandoff,
		bumpSessionState,
		bus,
		captureRunIo,
		chat,
		chatIdle,
		clampAtScope,
		commitAcpSafeSettings,
		commitExtensionHooks,
		commitSetting,
		config,
		contextDomain,
		createRoutedSession,
		decisionBoard,
		dispatch,
		dispatchBackground,
		extensions,
		flowLedger,
		getCurrentSettings,
		getTaskMemorySeedOffer,
		guardianState,
		headlessGitHelpers,
		historyReviews,
		hookDrift,
		initialNotices,
		interop,
		jobHost,
		mcpSubmit,
		memoryIntervention,
		memoryOwner,
		mux,
		options,
		panes,
		persistCurrentThinkingLevel,
		printJsonSessionHeader,
		providers,
		readAcpSafeSettings,
		readCurrentSessionEntries,
		readSessionEntriesForCompact,
		recordBoot,
		reloadClasses,
		reloadPlugins,
		reportSession,
		resolveBaselineAutonomy,
		resolveEffectiveAutonomy,
		resources,
		result,
		routingGestures,
		runContextInit,
		runtimeHooks,
		seedCurrentTaskMemoryFromHandoff,
		selectAtScope,
		session,
		settingOrigin,
		startSessionExtensionHost,
		startupOverrides,
		systemOne,
		systemOneControl,
		taskBoard,
		taskMemoryBank,
		taskMemoryTier,
		telemetry,
		telemetryRunReaders,
		termination,
		timer,
		toolBootstrap,
		toolRegistry,
		unsubscribeChatShutdown,
		userTasks,
		withPanes,
		worktreeRecovery,
		yoloRefusal,
		cells,
	};
	const seams: BootSurfaceSeams = {
		answerExtensionLine,
		bindBoardActions,
		buildModelReplayAgentMessagesFromTurns,
		continuityContextFromSession,
		createHostToolEvents,
		createStdioServerTransport,
		followWorkerRuns,
		loadAcpCommands: () => import("../acp/commands.js"),
		loadAcpServer: () => import("../acp/server.js"),
		loadInteractiveIndex: () => import("../interactive/index.js"),
		oracleBriefingFromEntries,
		parseSlashCommand,
		releasePancodeLoadedModelsOnExit,
		resolvePermission,
		runHostDispatch,
		subscribeLoopGuardStop,
	};

	if (options.acp) return runAcpSurface(surface, seams, options.acp);

	if (options.headless) return runHeadlessSurface(surface, seams, options.headless);
	return runInteractiveSurface(surface, seams);
}

/** The shared handoff service, bound to one host's session and chat for the ACP server. */
function bindAcpHandoff(deps: HandoffServiceDeps): AcpHandoffControl {
	return {
		prepare: (goal) => prepareHandoff(deps, goal),
		commit: (draft, document) => commitHandoff(deps, draft, document),
	};
}
