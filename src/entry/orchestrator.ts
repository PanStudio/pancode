// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readFileSync } from "node:fs";
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
import { writeHeadlessNoticesToStderr } from "../cli/headless-notices.js";
import type { RunJsonMainSessionFrame } from "../cli/modes/run-json-schema.js";
import { RUN_JSON_SCHEMA_VERSION } from "../cli/modes/run-json-schema.js";
import { noteMainRunV2, writeRunDiagnostic } from "../cli/run-failure.js";
import { startLoginEnvCapture } from "../core/bash-exec.js";
import { formatBootTrace } from "../core/boot-trace.js";
import { readPancodeVersionLabel } from "../core/build-info.js";
import { type PancodeSettings, readSettings } from "../core/config.js";
import type { OutputStyle } from "../core/defaults.js";
import { writeDiagnostic } from "../core/diagnostics.js";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { setAutonomousCommitProcess } from "../core/git-commit-attribution.js";
import { configureGuardrails, guardrailValuesFromSettings } from "../core/guardrails.js";
import { flushPackageActivities } from "../core/package-activity.js";
import { ensureProjectIgnore } from "../core/project-root.js";
import { consumeRestartIntent } from "../core/restart-intent.js";
import { StartupTimer } from "../core/startup-timer.js";
import { captureAdmits } from "../core/telemetry/capture.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { registerResearchTraceSink } from "../core/telemetry/research-trace.js";
import { getTerminationCoordinator, resolveShutdownHookBudgetMs } from "../core/termination.js";
import { yieldToEventLoop } from "../core/timers.js";
import { captureProjectSurface, projectSurfaceTrustNotice } from "../core/workspace-trust.js";
import { pancodeDataDir, pancodeStateDir } from "../core/xdg.js";
import { AgentsDomainModule } from "../domains/agents/module.js";
import { ConfigDomainModule, createConfigDomainModule } from "../domains/config/module.js";
import { liveHistoryBudget } from "../domains/context/budget/inspection.js";
import { createContextDomainModule } from "../domains/context/module.js";
import { createDispatchDedupRegistration } from "../domains/dispatch/dedup.js";
import { createWorktreeBootRecovery } from "../domains/dispatch/index.js";
import { createDispatchDomainModule } from "../domains/dispatch/module.js";
import { configureRunEventJournal } from "../domains/dispatch/run-event-journal.js";
import { createExtensionRuntimeHookBridge } from "../domains/extensions/index.js";
import { ExtensionsDomainModule } from "../domains/extensions/module.js";
import { describeUpgradeNotice, ensurePancodeState, takeUpgradeNotice } from "../domains/install/index.js";
import { InteropDomainModule } from "../domains/interop/module.js";
import {
	createBackgroundCallJournal,
	createBackgroundMemoryRouting,
	createMemoryFlowAdmission,
	memoryObservationCapacity,
	memoryRouteConfigured,
	prepareBackgroundMemoryModel,
} from "../domains/memory/background-route.js";
import { withDispatchMemory } from "../domains/memory/dispatch-section.js";
import type { MemoryGuardian } from "../domains/memory/guardian.js";
import { createGuardianStatePublisher } from "../domains/memory/guardian-state.js";
import { createHistoryReviewSource } from "../domains/memory/history-review.js";
import {
	createTaskMemoryTelemetrySink,
	createTaskMemoryTrace,
	MemoryRuntime,
	markMemoryOffRecording,
	primeMemoryRepositoryFingerprint,
} from "../domains/memory/index.js";
import { MEMORY_INTERVENTION_ACTIVITY_LIMIT } from "../domains/memory/intervention.js";
import { createMemoryRecallUseRegistration } from "../domains/memory/recall-use.js";
import { createMemorySessionProjection } from "../domains/memory/session-projection.js";
import {
	deleteTaskBankSnapshot,
	loadTaskBankSnapshot,
	saveTaskBankSnapshot,
} from "../domains/memory/task-bank-store.js";
import { createHistoryReviewActivity } from "../domains/memory/task-memory-status.js";
import { createCapabilityGate } from "../domains/middleware/capability-gate.js";
import { formatRegistrationConflict, writeMiddlewareDiagnosticToStderr } from "../domains/middleware/index.js";
import { createLocalClockReminderRegistration } from "../domains/middleware/local-clock-reminder.js";
import { createMiddlewareDomain } from "../domains/middleware/module.js";
import { createStaleBuildReminderRegistration } from "../domains/middleware/stale-build-reminder.js";
import { createTaskBoardReminderRegistration } from "../domains/middleware/task-board-reminder.js";
import { committedPluginSnapshot } from "../domains/plugins/index.js";
import { PluginsDomainModule } from "../domains/plugins/module.js";
import { createPromptsDomainModule } from "../domains/prompts/module.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { createProvidersDomainModule } from "../domains/providers/module.js";
import {
	type LlmRequestAdmission,
	type OneShotPort,
	oneShotRoundOptions,
	oneShotTokens,
} from "../domains/providers/one-shot.js";
import { resolveModelReference } from "../domains/providers/resolver.js";
import { LOCAL_API_KEY_FALLBACK, resolveSideCallAuth } from "../domains/providers/side-call-auth.js";
import { resolveTarget } from "../domains/providers/unpriced-routes.js";
import { anthropicQuotaNotice, onAnthropicQuotaChange, watchCopilotStreamQuota } from "../domains/quota/index.js";
import { createResourcesDomainModule } from "../domains/resources/module.js";
import { DEFAULT_RECENT_ENTRY_LIMIT } from "../domains/safety/finish-entries.js";
import type { GitHookDriftGuard } from "../domains/safety/hook-drift.js";
import type { FlowRestrictionSet } from "../domains/safety/index.js";
import { EMPTY_INFORMATION_FLOW_POLICY, resolveModelDestination } from "../domains/safety/index.js";
import { workerFlowPolicyInput } from "../domains/safety/information-flow.js";
import { SafetyDomainModule } from "../domains/safety/module.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import { createProtectedArtifactsRegistration } from "../domains/safety/protected-artifacts-registration.js";
import type { SafetyJudgeSeat } from "../domains/safety/safety-judge.js";
import { createSessionCodeConsent } from "../domains/safety/session-code-consent.js";
import { unattendedWindowMs } from "../domains/safety/unattended.js";
import { createSchedulingDomainModule } from "../domains/scheduling/module.js";
import type { CompactInput, CompactResult } from "../domains/session/compaction/compact.js";
import {
	type CompactionFlowAdmission,
	type CompactionFlowBudget,
	type CompactionReplay,
	type CompactionTelemetry,
	runCompactionFlow,
} from "../domains/session/compaction/flow.js";
import { collectSessionEntries } from "../domains/session/compaction/session-entries.js";
import { createStaleEditGuardRegistration } from "../domains/session/compaction/stale-edit-guard.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { commitHandoff, type HandoffServiceDeps, prepareHandoff } from "../domains/session/handoff-service.js";
import { SessionLiveError } from "../domains/session/index.js";
import { SessionDomainModule } from "../domains/session/module.js";
import {
	appendProtectedArtifactRegistryEvent,
	protectedArtifactStateForCurrentSession,
} from "../domains/session/protected-artifact-recording.js";
import { sessionLedgersForRoots } from "../domains/session/related-ledgers.js";
import { appendSkillActivationRegistryEvent } from "../domains/session/skill-activation-recording.js";
import { activePath } from "../domains/session/tree/active-path.js";
import { createTelemetryDomain } from "../domains/telemetry/module.js";
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
import { createExtensionReloadCoordinator, extensionHookReceiptSink } from "./extension-reload.js";
import { closedSessionLessonSource, createFlowLedger, FLOW_RESTRICTION_ENTRY_TYPE } from "./flow-ledger.js";
import { bindSessionPackageActivity } from "./package-activity.js";
import { resolvePanesEnablement } from "./panes-activation.js";
import { reloadPluginResourcesAndNotify } from "./plugin-reload.js";
import { createReloadClasses } from "./reload-classes.js";
import { applyRouteOverlay } from "./route-overlay.js";
import { bindTaskMemoryLifecycle } from "./task-memory-lifecycle.js";

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
import { createFileMutationObserver, createSkillActivationObserver } from "../tools/observers.js";
import { startToolOffloadSweep } from "../tools/result-shaping.js";
import { runAcpSurface } from "./boot/acp-surface.js";
import { buildBootAutonomy } from "./boot/autonomy.js";
import { startBootChat } from "./boot/chat.js";
import { runHeadlessSurface } from "./boot/headless-surface.js";
import { runInteractiveSurface } from "./boot/interactive-surface.js";
import { buildBootRegistry } from "./boot/registry.js";
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
		return chalk.yellow("no model target configured. Run `pancode configure` to add one.");
	}
	const model = settings.chat?.model;
	return chalk.dim(`target ${targetId}${model ? ` · model ${model}` : " · no default model"}`);
}

function buildBanner(): string {
	const pancode = readPancodeVersionLabel();
	return `
  ${chalk.cyan("PanCode")}
  ${chalk.dim(`v${pancode} · PanCode · HPC & scientific software`)}
  ${bannerConfigurationLine()}
`;
}

/** The session frame names the route the run is on, which a resume's --target or --model may have moved (B-52). */
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
			throw new Error(`target '${request.targetId}' names no model to ask`);
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
	termination.installSignalHandlers();

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

	// Panes are an interactive-surface projection. Headless, ACP, and worker boots
	// gate detection off so they never resolve a socket path or open a descriptor.
	// This mirrors the `interactive` predicate computed after the domains load.
	const muxInteractive = !options.headless && options.acp === undefined && process.env.PANCODE_INTERACTIVE === "1";
	// An ACP client counts as attended only when it advertised so at initialize.
	// The deferred front answers initialize before this boot, so the handshake is
	// already settled here; a plain client advertises nothing and keeps the
	// unattended behavior (no ask_user, no merge card, worker asks denied at once).
	const acpHandshake = options.acp?.handshake;
	const acpInterviews = acpHandshake?.initialized === true && acpHandshake.interviewsEnabled;
	const acpWorkerPermissions = acpHandshake?.initialized === true && acpHandshake.workerPermissionsEnabled;
	const acpElicitationChannel =
		acpHandshake?.initialized === true && acpHandshake.elicitationEnabled ? createAcpElicitationChannel() : undefined;
	const acpInterviewChannel = acpInterviews
		? createAcpInterviewChannel({
				unattendedWindowMs: () => unattendedWindowMs(getCurrentSettings().safety.unattendedAfterSeconds),
			})
		: undefined;
	// The rung is settled once, before the config contract loads, off the
	// `--with-panes` flag and whether this process runs in a pane host. An
	// inactive rung loads nothing: the whole extension, mux domain included,
	// lives behind the dynamic import below.
	const muxEnablement = resolvePanesEnablement(options.panes);
	const withPanes = muxInteractive && muxEnablement !== "off" ? await import("./with-panes.js") : null;
	// Session-only output style toggles, reported to PanCode's pane host so its chrome follows.
	const outputStyleListeners = new Set<(style: OutputStyle) => void>();

	// Assigned once the extension reload coordinator exists, after the domains
	// load; a worker dispatched before that carries no extension hooks.
	let workerHookSource: import("./extension-reload.js").ExtensionReloadCoordinator["workerHooks"] | null = null;
	const memoryOwner = new MemoryRuntime();
	// The loader publishes only the query contract; this root keeps the right to register hooks.
	const middlewareDomain = createMiddlewareDomain();
	const telemetryDomain = createTelemetryDomain();
	// Annotated: the module options close over contracts read from this result.
	const result: LoadResult = await loadDomains(
		[
			options.startupSettings
				? createConfigDomainModule(options.startupSettings, { holdReloads: bootPhaseBoundary !== undefined })
				: ConfigDomainModule,
			ExtensionsDomainModule,
			PluginsDomainModule,
			InteropDomainModule,
			createResourcesDomainModule({
				reservedPromptNames: new Set(BUILTIN_SLASH_COMMANDS.map((entry) => entry.name)),
				skills: () => ({
					disableDiscovery: options.noSkills === true || options.headless?.noSkills === true,
					...(options.skillPaths && options.skillPaths.length > 0
						? { explicitSkillPaths: options.skillPaths }
						: options.headless?.skillPaths && options.headless.skillPaths.length > 0
							? { explicitSkillPaths: options.headless.skillPaths }
							: {}),
				}),
			}),
			createContextDomainModule({
				noContextFiles: options.noContextFiles === true,
				startupHintHost: {
					// ACP advertises `context`, so clients can send the same slash form as the TUI.
					initCommand: options.headless ? "pancode context init" : "/context init",
					// Scripted runs keep suggestions off stderr; malformed-file warnings still flow.
					suggest: options.headless === undefined || (options.headless.mode !== "json" && process.stderr.isTTY === true),
					// TUI and ACP consume the stored hints on their own notice surfaces.
					...(options.acp === undefined && !muxInteractive ? { sink: (hint) => bootStderr(`pancode: ${hint.text}\n`) } : {}),
				},
			}),
			// Live probes exercise this session's chat model once the effective view
			// exists (assigned below with dispatch's); until then, the shared snapshot.
			createProvidersDomainModule({ getSettings: () => effectiveSettingsForDispatch?.() }),
			SafetyDomainModule,
			createPromptsDomainModule({
				noContextFiles: options.noContextFiles === true,
				noSkills: options.noSkills === true || options.headless?.noSkills === true,
			}),
			AgentsDomainModule,
			middlewareDomain.module,
			{
				manifest: { name: "memory", dependsOn: [] },
				createExtension: () => ({
					contract: memoryOwner.contract,
					extension: { start: () => {}, stop: () => memoryOwner.dispose() },
				}),
			},
			SessionDomainModule,
			telemetryDomain.module,
			// Budget alerts and the plan baseline read the ceiling through the
			// session's effective view, where `--max-cost-usd` sets it.
			createSchedulingDomainModule({ getSettings: () => effectiveSettingsForDispatch?.() }),
			...(withPanes
				? [
						withPanes.createMuxDomainModule({
							enabled: muxEnablement,
							log: (level, message) => {
								if (level === "warning") bootStderr(`[mux] ${message}\n`);
							},
							onSessionOutputStyle: (listener) => outputStyleListeners.add(listener),
						}),
					]
				: []),
			// Dispatch resolves worker targets through the session's effective
			// settings view once it exists (assigned below, after the config
			// contract loads); until then it falls back to the shared snapshot.
			createDispatchDomainModule({
				getCapabilityGate: () => capabilityGate,
				budgetWaitForRaise: !options.headless && !options.acp,
				// Only an operator surface answers worker escalations (F9): the TUI
				// overlay, or an ACP client that advertised it forwards them to a person.
				workerPermissionResponder: !options.headless && (!options.acp || acpWorkerPermissions),
				// A headless steer channel reaches the main session only.
				workerSteering: !options.headless,
				// Under fleet.permissions.mode=judge the main session's safety judge
				// reviews native workers' ordinary asks in this process.
				operatorAutonomy: () => workerAskJudgeForDispatch?.operatorAutonomy(),
				workerAskJudge: {
					seat: () => workerAskJudgeForDispatch?.seat(),
					autonomy: () => workerAskJudgeForDispatch?.autonomy() ?? "default",
					hookDrift: () => workerAskJudgeForDispatch?.hookDrift(),
				},
				// The merge card rides the same attended gate, and asks through
				// whichever ask_user handler the TUI or the ACP client has by then.
				...(!options.headless && (!options.acp || acpInterviews)
					? { operatorAsk: { available: () => registryState.askUserHandler !== null, ask: (q, o) => askUserBridge(q, o) } }
					: {}),
				getSettings: () => effectiveSettingsForDispatch?.(),
				// A native worker's tool calls reach this session's extension hooks.
				workerHooks: {
					declarations: () => workerHookSource?.declarations() ?? [],
					dropped: () => workerHookSource?.dropped() ?? [],
					evaluate: async (request, run) => (await workerHookSource?.evaluate(request, run)) ?? [],
					notify: (message) => workerHookSource?.notify(message),
				},
				getProtectedArtifactState: () => protectedArtifactStateForDispatch?.() ?? { artifacts: [] },
				getFlowRestrictions: () => flowRestrictionsForDispatch?.() ?? null,
				getFlowPolicy: () => workerFlowPolicyInput(safety?.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY),
				// Stamps every run with the session that dispatched it, which is what
				// keeps a sibling PanCode process's runs and batches out of this one.
				getSessionId: () => sessionOriginForDispatch?.()?.id ?? null,
				getSessionParentId: () => sessionOriginForDispatch?.()?.parentSessionId ?? null,
				getSessionOrigin: () => sessionOriginForDispatch?.() ?? null,
				// The domain owns the durable journal here, not the dispatch
				// tool's event registry: `/run`, a watchdog run, and a model
				// dispatch all have to leave the same transcript behind, and only
				// the last of the three ever reaches that registry.
				journalRunEvents: true,
				bootRecovery: worktreeRecovery,
			}),
		],
		{ diagnostic: bootStderr, ...(bootPhaseBoundary ? { beforeEach: bootPhaseBoundary } : {}) },
	);
	timer.mark(`domains loaded (${result.loaded.length})`);

	const dispatch = withDispatchMemory(result.getContract("dispatch"), () => effectiveSettingsForDispatch?.());
	let unsubscribeDispatchShutdown: (() => void) | undefined;
	if (dispatch) {
		let dispatchDrain: Promise<void> | undefined;
		const beginDispatchDrain = (): Promise<void> => (dispatchDrain ??= dispatch.drain());
		unsubscribeDispatchShutdown = bus.subscribe("shutdown.requested", () => {
			// Admission closes before sequential drain hooks can wait on another resource.
			void beginDispatchDrain().catch(() => {
				// The awaited drain hook reports this same rejection.
			});
		});
		termination.onDrain(
			async () => {
				unsubscribeDispatchShutdown?.();
				await beginDispatchDrain();
			},
			{
				timeoutMs: Math.min(2 ** 31 - 1, (dispatch.drainAllowanceMs?.() ?? 0) + resolveShutdownHookBudgetMs()),
			},
		);
	}
	// The loader caps each domain separately. The outer hook must allow the
	// whole sequence to finish, including cleanup after a timed-out domain and
	// the dispatch stop's own allowance for its async durable writes (#428).
	termination.onPersist(
		(signal) => {
			// The coordinator's status is set before any hook runs (130 on SIGINT, 143 on SIGTERM); process.exited
			// records it (#434).
			result.getContract("telemetry")?.setExitStatus?.(termination.getExitCode());
			return result.stop(signal);
		},
		{
			timeoutMs: Math.min(
				2 ** 31 - 1,
				(result.loaded.length + 1) * resolveShutdownHookBudgetMs() + (dispatch?.drainAllowanceMs?.() ?? 0),
			),
		},
	);

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

	const middleware = result.getContract("middleware");
	const middlewareRegistrar = middlewareDomain.registrar();
	const telemetry = result.getContract("telemetry");
	const telemetryRunReaders = telemetryDomain.runReaders();
	const safety = result.getContract("safety");
	const session = result.getContract("session");
	telemetry?.resetSession(session?.current()?.id ?? null);
	// Memory and compaction traces run outside any call; they journal into the session current when they fire,
	// the same session background memory calls are journaled under (#434).
	registerResearchTraceSink({
		admits(kind) {
			const origin = session?.current();
			const capture = origin ? telemetry?.telemetryCapture?.(origin) : undefined;
			return capture !== undefined && captureAdmits(capture, kind);
		},
		record(kind, data, preimage) {
			const origin = session?.current();
			if (origin) telemetry?.recordResearchTrace?.(origin, { role: "memory", id: origin.id }, kind, data, preimage);
		},
	});
	// One durable union of restricted sources per session. Every model send,
	// mediated outbound call and System One request is judged against it.
	const flowLedger = createFlowLedger({
		session: session ?? null,
		readEntries: readFlowSessionEntries,
		policy: safety?.policy,
	});
	// The registry and tool `flow` port, shared so both read the one ledger.
	const flowPort = { carried: flowLedger.current, refusal: flowLedger.refusal, absorb: flowLedger.absorb };
	flowRestrictionsForDispatch = () => {
		// A worker launched while the ledger cannot vouch would carry unlabeled
		// context; the refusal surfaces at its first model request instead.
		const refusal = flowLedger.refusal();
		if (refusal !== null) throw new Error(refusal);
		return flowLedger.current();
	};
	/**
	 * Block reason when the session's restricted context may not reach a
	 * configured target as it is configured now, or null. The live target
	 * descriptor is read at every request, so a URL changed behind the id is
	 * judged on what it is now.
	 */
	const admitModelFlow = (destination: { targetId: string; runtimeId: string; wireModelId: string }): string | null =>
		flowLedger.admitDestination(
			resolveModelDestination({
				targetId: destination.targetId,
				runtimeId: destination.runtimeId,
				url: providers?.getTarget(destination.targetId)?.url ?? null,
				model: destination.wireModelId,
			}),
		);
	sessionOriginForDispatch = () => session?.current() ?? null;
	const prompts = result.getContract("prompts");
	const agents = result.getContract("agents");
	const resources = result.getContract("resources");
	const extensions = result.getContract("extensions");
	const mux = result.getContract("mux");
	const contextDomain = result.getContract("context");
	const interop = result.getContract("interop");
	const initialNotices = interactive
		? [...heldTrustNotices, ...(contextDomain?.startupHints() ?? []).map((hint) => hint.text)]
		: [];
	// Once per version, interactive only: headless and ACP have no operator at
	// the keyboard to tell, and the record is left unclaimed for the boot that does.
	const upgrade = interactive ? takeUpgradeNotice() : null;
	if (upgrade !== null) {
		initialNotices.push(describeUpgradeNotice(upgrade));
		// No network: the packaged changelog says whether this upgrade fixes something the operator reported (R-14).
		const { takeFixedReportNotices } = await import("../domains/report/index.js");
		initialNotices.push(...takeFixedReportNotices(pancodeStateDir(), upgrade));
	}
	if (!providers || !dispatch || !telemetry || !safety || !middleware || !middlewareRegistrar) {
		bootStderr(
			"PanCode: chat mode requires safety + middleware + providers + dispatch + telemetry contracts; aborting.\n",
		);
		await termination.shutdown(1);
		return { exitCode: 1, bootTimeMs: timer.snapshot().totalMs };
	}

	if (session) {
		const unbindActivity = bindSessionPackageActivity(session);
		termination.onDrain(unbindActivity);
		termination.onDrain(bus.subscribe("session.reattached", () => flushPackageActivities()));
	}
	// A headless `--resume`/`--continue`, or the interactive `--resume <id>`/`--continue`, resolves here, where the
	// session domain exists. Headless it is a hard requirement: a caller that asked to continue a conversation must not
	// receive an answer written without that conversation's history. Interactive, a miss opens a fresh session.
	const requestedResume = options.headless ? options.headless.resumeSession : options.resume;
	let headlessResumeFailure: string | null = null;
	let headlessResumeSlug: SessionLiveError["slug"] | undefined;
	let resolvedResumeId: string | undefined;
	if (requestedResume !== undefined && requestedResume.kind !== "picker") {
		if (!session) {
			headlessResumeFailure = "session continuation requires the session domain, which is not loaded";
		} else if (requestedResume.kind === "id") {
			const resolved = session.resolveId(requestedResume.id);
			if (typeof resolved === "string") resolvedResumeId = resolved;
			else
				headlessResumeFailure = `session prefix ${requestedResume.id} is ambiguous; matches: ${resolved.ambiguous.join(", ")}`;
		} else {
			const latest = session.history().find((meta) => meta.hasModelTurn !== false);
			if (latest === undefined)
				headlessResumeFailure = `no previous session with a model turn recorded for ${process.cwd()}`;
			else resolvedResumeId = latest.id;
		}
	}
	const resumeId =
		resolvedResumeId ?? (interactive ? consumeRestartIntent(pancodeStateDir(), process.cwd()) : undefined);
	if (options.headless?.sessionName !== undefined) session?.nameSession(options.headless.sessionName);
	let resumedSessionAtBoot = false;
	if (resumeId && session && headlessResumeFailure === null) {
		try {
			// A v2 envelope names the session a fork branched from; a no-op unless --output-format json|stream-json.
			if (requestedResume?.kind !== "picker" && requestedResume?.fork === true)
				noteMainRunV2({ parentSessionId: session.forkFrom(resumeId).parentSessionId ?? resumeId });
			else session.resume(resumeId);
			resumedSessionAtBoot = true;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			if (err instanceof SessionLiveError) headlessResumeSlug = err.slug;
			if (requestedResume !== undefined) headlessResumeFailure = `failed to resume session ${resumeId}: ${detail}`;
			else bootStderr(`PanCode: failed to resume session ${resumeId}: ${detail}\n`);
		}
	}
	if (headlessResumeFailure !== null && !options.headless)
		initialNotices.push(`Nothing resumed: ${headlessResumeFailure}. This is a fresh session.`);
	else if (headlessResumeFailure !== null) {
		writeRunDiagnostic(`pancode run: ${headlessResumeFailure}\n`, headlessResumeSlug);
		await termination.shutdown(2);
		return { exitCode: 2, bootTimeMs: timer.snapshot().totalMs };
	}

	// Hook diagnostics ride the typed bus. The domain loader constructed the
	// bundle with the stderr default; swap in a sink that publishes
	// middleware.hook_failed (the interactive warn notice consumes it) and keep
	// stderr for non-interactive runs, which have no notice subscriber.
	middlewareRegistrar.setDiagnosticSink((diagnostic) => {
		if (diagnostic.kind === "registration_conflict") {
			// Registration bookkeeping has no hook occurrence; the affected owner
			// today declares user hooks, which never run on on_compaction, so the
			// payload's hook slot carries that as the "no evaluation" marker.
			bus.emit("middleware.hook_failed", {
				kind: "registration_conflict",
				registrationId: diagnostic.registrationId,
				hook: "on_compaction",
				at: Date.now(),
				message: formatRegistrationConflict(diagnostic),
			});
			if (!interactive) writeMiddlewareDiagnosticToStderr(diagnostic);
			return;
		}
		bus.emit("middleware.hook_failed", {
			kind: diagnostic.kind,
			registrationId: diagnostic.registrationId,
			hook: diagnostic.hook,
			at: Date.now(),
			...(diagnostic.kind === "hook_failed"
				? { message: diagnostic.message }
				: {
						elapsedMs: diagnostic.elapsedMs,
						budgetMs: diagnostic.budgetMs,
						steadyStateWarn: diagnostic.steadyStateWarn,
						p50Ms: diagnostic.stats.p50Ms,
						p95Ms: diagnostic.stats.p95Ms,
						overCount: diagnostic.stats.overCount,
						windowSamples: diagnostic.stats.window,
					}),
		});
		if (!interactive) writeMiddlewareDiagnosticToStderr(diagnostic);
	});

	// Runtime and session notices: the terminal renders them, ACP sends them as session info, a headless run prints them.
	if (!interactive && !acpMode) writeHeadlessNoticesToStderr(bus);

	termination.onDrain(watchCopilotStreamQuota());
	termination.onDrain(
		onAnthropicQuotaChange((targetId, snapshot) => {
			const notice = anthropicQuotaNotice(snapshot);
			if (notice !== null)
				emitQuotaNotice(
					{
						kind: "stress",
						...notice,
						targetId,
						runtimeId: "anthropic-max",
						model: "",
					},
					bus,
				);
		}),
	);

	// Install guardrail policy before any guard registration or tool reads it.
	// The effective session view replaces this boot projection below.
	const resolvedSettings = config?.get() ?? readSettings();
	configureGuardrails(guardrailValuesFromSettings(resolvedSettings));

	// The journal sink sits on the dispatch event path, where reading settings
	// would be both a cost and a throw site. The effective session view replaces
	// this boot projection below.
	configureRunEventJournal(resolvedSettings.fleet.history.journal);

	// Register the loop and dispatch guards first. The protected-artifact guard
	// is constructed here but registered after user hooks below, so it can
	// absorb their protect_path effects. Workers register their own guards in
	// worker-runtime.ts; these instances carry the bus and session persistence.
	const loopGuard = createLoopGuardRegistration({
		safety,
		bus,
		readResultMaxBytes: () => (effectiveSettingsForDispatch?.() ?? resolvedSettings).context.toolResultMaxBytes,
		turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET,
		sameCallBlockLimit: INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
		turnToolCallBudget: () => readOrchTurnToolCallBudget(),
		// Interactive/headless/ACP all share this orchestrator guard: at the
		// block budget, lock tools for the rest of the turn so the model
		// answers from what it gathered instead of hard-cancelling a turn that
		// may already hold the answer. The bounded backstop still cancels a
		// model that keeps calling tools.
		turnSynthesisLockout: true,
	});
	middlewareRegistrar.registerHook(loopGuard);
	let initialProtectedArtifactState: ProtectedArtifactState | undefined;
	let initialProtectionReadError: string | null = null;
	if (session) {
		try {
			initialProtectedArtifactState = protectedArtifactStateForCurrentSession(session);
		} catch (error) {
			initialProtectionReadError = error instanceof Error ? error.message : String(error);
		}
	}
	const protectedArtifactsGuard = createProtectedArtifactsRegistration({
		...(initialProtectedArtifactState !== undefined ? { initialState: initialProtectedArtifactState } : {}),
		onProtect: (event) => appendProtectedArtifactRegistryEvent(session, event),
		onDurabilityFailure: (health) => {
			bus.emit("middleware.hook_failed", {
				kind: "hook_failed",
				registrationId: "guard.protected-artifacts",
				hook: "before_tool",
				at: Date.now(),
				message: health.reason,
			});
		},
	});
	if (initialProtectionReadError !== null) {
		protectedArtifactsGuard.markDegraded(
			`initial session protection history could not be read: ${initialProtectionReadError}`,
		);
	}
	protectedArtifactStateForDispatch = () => {
		const health = protectedArtifactsGuard.health();
		if (health.kind === "degraded") {
			throw new Error(`dispatch: protected artifact durability degraded: ${health.reason}`);
		}
		return protectedArtifactsGuard.state();
	};
	const dispatchDedup = createDispatchDedupRegistration();
	middlewareRegistrar.registerHook(dispatchDedup.registration);
	// Folding through the active path (not the raw file) is what
	// keeps a /resume from picking up whichever branch happened to write its
	// taskLedger entry last in file order; the task board's readEntries used to
	// skip that filter entirely (issue #94).
	const activePathEntries = () => {
		const meta = session?.current();
		if (!session || !meta) return [];
		return activePath(session.readEntries(), session.leafId(meta.id) ?? undefined);
	};
	middlewareRegistrar.registerHook(
		createStaleEditGuardRegistration({ readEntries: activePathEntries, cwd: () => process.cwd() }),
	);
	// Observers run after the guards; they emit no effects and their sinks are
	// best-effort (session ledger, codewiki refresh).
	middlewareRegistrar.registerHook(
		createSkillActivationObserver((activation) => appendSkillActivationRegistryEvent(session, activation)),
	);
	// Task-board reminder: same user-message-visible channel, fired once per
	// session when a request literally enumerates three or more steps. The
	// static routing line and tasks hint ask for the same board; battery-tested
	// local models only comply when the instruction rides the user message.
	middlewareRegistrar.registerHook(createTaskBoardReminderRegistration());
	middlewareRegistrar.registerHook(createStaleBuildReminderRegistration());
	middlewareRegistrar.registerHook(createLocalClockReminderRegistration());
	const taskMemoryBank = memoryOwner.bank;
	const memorySettings = (config?.get() ?? readSettings()).context.memory;
	// Bound late: the registration is built here, but the buffer a deferred
	// reminder lands in belongs to the chat loop that has not been composed yet.
	let deferredMemoryReminderSink: ((message: string, isCurrent?: () => boolean) => void) | null = null;
	// The watchdog's findings are for the operator, not the model, so they take
	// the transcript-notice path rather than the reminder buffer. Bound late for
	// the same reason: the chat loop that owns the transcript is composed below.
	let deferredWatchdogNoticeSink: ((text: string) => void) | null = null;
	// Content-bearing, so it records only under research capture with consent.
	// The telemetry row says which silence
	// happened; this says what the model wrote (#434).
	const memoryTrace = createTaskMemoryTrace();
	// The route the last resolved memory client would call, kept so the endpoint
	// check and the cost row read the same resolution the step itself used.
	// Each memory step is a journaled call, in its session's journal or the process journal (#434).
	// The spend the scheduling gate admits paid requests against, so a memory
	// step's projected cost meets the same ceiling chat and dispatch do.
	const backgroundSessionSpendUsd = (): number =>
		result.getContract("scheduling")?.preflight().currentUsd ?? telemetry?.sessionSpend().usd ?? 0;
	const backgroundCallJournal = createBackgroundCallJournal(
		providers,
		() => telemetry?.acquireTelemetrySession,
		() => session?.current(),
		() => telemetry,
	);
	// Lesson gate decisions reach the operator through the transcript notice
	// path once the chat loop has bound it; before that, a diagnostic line.
	const memoryNotice = (line: string): void => {
		if (deferredWatchdogNoticeSink) deferredWatchdogNoticeSink(line);
		else writeDiagnostic(`[pancode:memory] ${line}\n`);
	};
	const memoryDiagnostic = (line: string): void => writeDiagnostic(`[pancode:memory] ${line}\n`);
	const admitMemoryFlow = createMemoryFlowAdmission(admitModelFlow, () => session?.current()?.id ?? null, bus);
	const getCurrentMemoryEnabled = (): boolean =>
		(effectiveSettingsForDispatch?.().context.memory ?? memorySettings).enabled;
	const memoryTelemetry = createTaskMemoryTelemetrySink();
	const historyReviews = createHistoryReviewActivity(
		memoryTelemetry,
		() => session?.current()?.id ?? null,
		MEMORY_INTERVENTION_ACTIVITY_LIMIT,
	);
	const memoryWorkspaceRoot = (): string => session?.current()?.cwd || process.cwd();
	primeMemoryRepositoryFingerprint(process.cwd());
	// Bound late: the guardian needs the registration, and the registration
	// reports turn boundaries and step activity to the guardian.
	let memoryGuardian: MemoryGuardian | null = null;
	let isChatStreaming: () => boolean = () => false;
	const guardianState = createGuardianStatePublisher(memoryOwner.contract, bus, () => session?.current()?.id ?? null);
	const memoryIntervention = memoryOwner.createIntervention({
		telemetry: memoryTelemetry,
		workspaceRoot: memoryWorkspaceRoot,
		onTurnBoundary: (kind) => memoryGuardian?.wake(kind === "end" ? "turn-end" : "turn-start"),
		onStepActivity: () => {
			guardianState.publish();
			memoryGuardian?.wake("step-settled");
		},
		onEnvelope: (envelope) => memoryTrace.record(envelope),
		tracesEnvelopes: () => memoryTrace.active(),
		// A headless run submits no further turn, so a detached step could only
		// finish after the process that would have read it has exited.
		deliversDeferredReminders: options.headless === undefined,
		onDeferredReminder: (message, isCurrent) => deferredMemoryReminderSink?.(message, isCurrent),
		getSettings: () => {
			const memory = effectiveSettingsForDispatch?.().context.memory ?? memorySettings;
			return {
				enabled: memory.enabled,
				everyNTools: memory.cadenceToolCalls,
				windowSteps: memory.trajectorySteps,
				maxTokens: memory.maxOutputTokens,
				timeoutMs: memory.timeoutMs,
				surfaces: memory.surfaces,
			};
		},
		...createBackgroundMemoryRouting(
			providers,
			() => effectiveSettingsForDispatch?.(),
			bus,
			admitMemoryFlow,
			true,
			backgroundSessionSpendUsd,
			backgroundCallJournal,
		),
	});
	middlewareRegistrar.registerHook(memoryIntervention);
	middlewareRegistrar.registerHook(
		createMemoryRecallUseRegistration({
			dataDir: pancodeDataDir,
			stateDir: pancodeStateDir,
			enabled: () => memoryEnabledNow(),
			takeRecalled: () => memoryOwner.takeTurnRecalledMemory(),
			workspaceRoot: memoryWorkspaceRoot,
		}),
	);
	const memoryRouteAvailable = (): boolean =>
		memoryRouteConfigured(effectiveSettingsForDispatch?.() ?? config?.get() ?? readSettings());
	memoryGuardian = memoryOwner.startGuardian({
		// A headless run exits after its turn, so there is no idle time to use.
		enabled: () => options.headless === undefined && memoryRouteAvailable(),
		isForegroundActive: () => isChatStreaming(),
		// History review waits for a turn that bound a session (ACP and TUI alike); before it, a review bills none (C-20).
		awaitFirstTurn: true,
		sessionBound: () => (session?.current() ?? null) !== null,
		live: memoryIntervention,
		scopeKey: () => `${session?.current()?.id ?? ""}\u0000${memoryWorkspaceRoot()}`,
		historySource: () =>
			createHistoryReviewSource({
				stateDir: pancodeStateDir(),
				cwd: memoryWorkspaceRoot(),
				currentSessionId: session?.current()?.id ?? null,
			}),
		client: createBackgroundMemoryRouting(
			providers,
			() => effectiveSettingsForDispatch?.(),
			bus,
			admitMemoryFlow,
			false,
			backgroundSessionSpendUsd,
			backgroundCallJournal,
		),
		settings: () => {
			const memory = effectiveSettingsForDispatch?.().context.memory ?? memorySettings;
			return { maxTokens: memory.maxOutputTokens, timeoutMs: memory.timeoutMs };
		},
		workspaceRoot: memoryWorkspaceRoot,
		telemetry: historyReviews.telemetry,
		onStateChange: guardianState.publish,
	});
	const memoryEnabledNow = (): boolean =>
		(effectiveSettingsForDispatch?.() ?? getCurrentSettings()).context.memory.enabled;
	const beforeTurnRecorded = (target: SessionContract): void => {
		if (!memoryEnabledNow()) markMemoryOffRecording(target);
	};
	const beforeShellEntryRecorded = (): void => {
		if (session) beforeTurnRecorded(session);
	};
	const memoryActiveEntries = createMemorySessionProjection(() => session);
	const liveHistory = (): { usable: number; used: number } | null => liveHistoryBudget(chat.inspectLiveBudget());
	memoryOwner.configure({
		stateDir: pancodeStateDir,
		dataDir: pancodeDataDir,
		cwd: memoryWorkspaceRoot,
		currentSession: () => {
			const meta = session?.current();
			return meta ? { id: meta.id, cwd: meta.cwd || process.cwd() } : null;
		},
		notice: memoryNotice,
		diagnostic: memoryDiagnostic,
		observerHistoryTokens: () =>
			memoryObservationCapacity(providers, effectiveSettingsForDispatch?.() ?? getCurrentSettings()),
		lessonSource: () => {
			// A retained lesson carries no label and reaches every later session, whatever route it was reviewed under.
			const meta = session?.current();
			if (meta && flowLedger.isRestricted(meta.id)) return null;
			return memoryActiveEntries()?.lesson ?? null;
		},
		sessionFlowRestricted: (sessionId) => flowLedger.isRestricted(sessionId),
		closedLessonSource: (sessionId) => {
			const ledger = sessionLedgersForRoots(pancodeStateDir(), [memoryWorkspaceRoot()]).find(
				(candidate) => candidate.sessionId === sessionId,
			);
			if (!ledger) return null;
			return closedSessionLessonSource(readFileSync(ledger.path, "utf8"), ledger.path, sessionId, ledger.root);
		},

		settings: () => effectiveSettingsForDispatch?.().context.memory ?? memorySettings,
		source: () => {
			const meta = session?.current();
			const authority = memoryIntervention.captureMemoryAuthority();
			if (!meta || !session || !authority || authority.scope.sessionId !== meta.id) return null;
			const projection = memoryActiveEntries();
			if (!projection) return null;
			return {
				...authority.scope,
				...projection.observation,
			};
		},
		usableHistoryTokens: () => liveHistory()?.usable ?? 0,
		foldPlanner: () => ({ live: chat, compaction: getCurrentSettings().context.compaction }),
		client: createBackgroundMemoryRouting(
			providers,
			() => effectiveSettingsForDispatch?.(),
			bus,
			admitMemoryFlow,
			false,
			backgroundSessionSpendUsd,
			backgroundCallJournal,
		),
	});
	const guardedMemory = memoryGuardian;
	const unsubscribeMemoryLoop = bus.subscribe("safety.loop_blocked", () => memoryIntervention.signalLoop());
	const unsubscribeGuardianWakes = [
		bus.subscribe("session.started", () => guardedMemory.reset()),
		bus.subscribe("config.hot_reloaded", () => {
			memoryOwner.settingsChanged();
			guardedMemory.wake("settings");
		}),
		bus.subscribe("config.next_turn_scheduled", () => {
			memoryOwner.settingsChanged();
			guardedMemory.wake("settings");
		}),
	];
	const disposeMemoryLifecycle = bindTaskMemoryLifecycle(bus, memoryOwner, {
		save: (sessionId) => {
			saveTaskBankSnapshot(pancodeStateDir(), sessionId, taskMemoryBank.snapshot());
		},
		restore: (sessionId) => {
			const snapshot = loadTaskBankSnapshot(pancodeStateDir(), sessionId);
			// Consumed on read: a crash after `/tree` cleared the bank must not find
			// this snapshot again on the next resume.
			deleteTaskBankSnapshot(pancodeStateDir(), sessionId);
			if (snapshot !== null && getCurrentMemoryEnabled()) taskMemoryBank.restore(snapshot);
		},
		discard: (sessionId) => deleteTaskBankSnapshot(pancodeStateDir(), sessionId),
	});
	termination.onDrain(() => {
		unsubscribeMemoryLoop();
		for (const off of unsubscribeGuardianWakes) off();
		disposeMemoryLifecycle();
	});
	// The main agent's first test runner in an attended session asks before it
	// runs repository code, whoever wrote that code (#377 follow-up). The
	// consent is per session: a park or a resume clears it. A headless run
	// denies every ask, so it keeps #377's allow.
	const sessionCodeConsent = createSessionCodeConsent({ headless: options.headless !== undefined });
	bus.subscribe("session.parked", () => sessionCodeConsent.reset());
	bus.subscribe("session.reattached", () => sessionCodeConsent.reset());
	// The codewiki refreshes the written paths when the context domain is loaded.
	middlewareRegistrar.registerHook(
		createFileMutationObserver(({ paths }) => {
			contextDomain?.noteFileChanges(paths);
		}),
	);
	// User-defined hooks: extensions and the project (.pancode/hooks.yaml,
	// .pancode/hooks.local.yaml) declare a conservative, receipted hook set on the
	// same effect machinery. A hook may add effects (including request block_tool)
	// but cannot grant a permission safety would deny. The protected-artifact
	// guard follows them to consume protect_path before tool execution.
	// The coordinator is the only writer of the "user-hooks" owner and the only
	// caller of the extensions reload; it publishes the extension generation
	// and the hook registrations with two adjacent assignments on one stack
	// and reloads plugin resources only after both. The boot generation is
	// published here too (the extensions bundle publishes nothing at start),
	// so no consumer ever sees extension resources paired with hooks from a
	// different generation. The owner slot is anchored here, so user hooks
	// keep evaluating before the protection consumer and assessors below.
	let bootHookNotices = true;
	const reloadPlugins = () =>
		reloadPluginResourcesAndNotify(process.cwd(), (event) => bus.emit("plugin.reloaded", event));
	const chatIdle = () => !chat.isStreaming() && chat.turnPreparation().phase === "idle";
	const reloadClasses = createReloadClasses({
		config,
		bus,
		cwd: () => process.cwd(),
		hub: () => committedPluginSnapshot(process.cwd()),
		reloadHub: reloadPlugins,
		extensions: () => extensions?.snapshot()?.packages ?? [],
		mcp: { source: () => toolBootstrap.mcpCapabilities, idle: chatIdle },
	});
	// Every main session hosts api 2 runtimes: the TUI itself, a headless run
	// and ACP through `startExtensionHost`. Workers never do.
	const runtimeHooks = createExtensionRuntimeHookBridge({ sessionId: () => session?.current()?.id ?? null });
	const extensionReload = createExtensionReloadCoordinator({
		extensions,
		middleware: middlewareRegistrar,
		runtimeHooks,
		// The gateway is registered after this coordinator; the lookup runs at call time.
		mcpOwner: (tool) => toolBootstrap.mcpCapabilities?.ownerIdOf(tool) ?? null,
		cwd: () => process.cwd(),
		...(options.trustCardNotices !== undefined ? { holdBootTrustNotices: true } : {}),
		recordReceipt: extensionHookReceiptSink(() => session?.current()?.id),
		report: (line) => {
			if (reloadClasses.captureIssue(line)) return;
			if (!bootHookNotices) bus.emit("extension.load_failed", { message: line });
			else if (interactive) initialNotices.push(line);
			else process.stderr.write(`${line}\n`);
		},
		onCommitted: () => {
			if (!reloadClasses.active) reloadPlugins();
		},
	});
	workerHookSource = extensionReload.workerHooks;
	const commitExtensionHooks = () => {
		const outcome = extensionReload.reload();
		for (const issue of outcome.diagnostics.entries) reloadClasses.captureIssue(`${issue.type}: ${issue.message}`);
		reloadClasses.captureExtensionCommit(formatExtensionReloadNotice(outcome)[1]);
		return outcome;
	};
	await bootPhaseBoundary?.();
	extensionReload.applyBoot();
	middlewareRegistrar.registerHook(protectedArtifactsGuard);
	bootHookNotices = false;
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
	// `run --target/--model` and the interactive `pancode --target/--model` seed the session route the same way.
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
			const reason = selected.error ?? "--api-key supplied but the model target could not be resolved";
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
		resumedSessionAtBoot,
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
				return deferredWatchdogNoticeSink;
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
			bootStderr("PanCode: --api-key supplied but no active orchestrator target could be resolved; refusing.\n");
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
				return deferredWatchdogNoticeSink;
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
		cells: {
			get declaredCompletionFacts() {
				return turnHookState.declaredCompletionFacts;
			},
			get deferredMemoryReminderSink() {
				return deferredMemoryReminderSink;
			},
			set deferredMemoryReminderSink(value) {
				deferredMemoryReminderSink = value;
			},
			get deferredWatchdogNoticeSink() {
				return deferredWatchdogNoticeSink;
			},
			set deferredWatchdogNoticeSink(value) {
				deferredWatchdogNoticeSink = value;
			},
			get isChatStreaming() {
				return isChatStreaming;
			},
			set isChatStreaming(value) {
				isChatStreaming = value;
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
			return resumedSessionAtBoot;
		},
		get unsubscribeDispatchShutdown() {
			return unsubscribeDispatchShutdown;
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
