// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { AcpHostReport } from "../acp/commands.js";
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
import { modelBootstrapGenerate, resolveBootstrapRoute } from "../cli/bootstrap-generate.js";
import { writeHeadlessNoticesToStderr } from "../cli/headless-notices.js";
import type { RunJsonMainSessionFrame } from "../cli/modes/run-json-schema.js";
import { RUN_JSON_SCHEMA_VERSION } from "../cli/modes/run-json-schema.js";
import { noteMainRunV2, writeRunDiagnostic } from "../cli/run-failure.js";
import { setToolEnvAutonomy, startLoginEnvCapture } from "../core/bash-exec.js";
import { formatBootTrace } from "../core/boot-trace.js";
import { readPancodeVersionLabel } from "../core/build-info.js";
import { type PancodeSettings, readSettings } from "../core/config.js";
import { interfaceGuidanceEnabled, type OutputStyle } from "../core/defaults.js";
import { writeDiagnostic } from "../core/diagnostics.js";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { setAutonomousCommitProcess, setCommitDecisionRefsProvider } from "../core/git-commit-attribution.js";
import { configureGuardrails, guardrailValuesFromSettings } from "../core/guardrails.js";
import { installInternalGitPolicy } from "../core/internal-git.js";
import { flushPackageActivities } from "../core/package-activity.js";
import { readPancodeVersion } from "../core/package-root.js";
import type { CatalogRanker } from "../core/precomputed-rank.js";
import { ensureProjectIgnore } from "../core/project-root.js";
import { hostFramedTexts } from "../core/reminder-framing.js";
import { protectedResidencyModels } from "../core/residency-protection.js";
import { consumeRestartIntent } from "../core/restart-intent.js";
import {
	SAFE_EXEC_DEFAULT_KILL_GRACE_MS,
	SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS,
	SAFE_EXEC_PIPE_DRAIN_BOUND_MS,
} from "../core/safe-exec.js";
import { sandboxAvailability } from "../core/sandbox/availability.js";
import { mainSandboxEnvPolicy } from "../core/sandbox/env-scrub.js";
import { createGitHooksFingerprinter } from "../core/sandbox/git-hooks-fingerprint.js";
import { mainShellContained, mainShellSandboxSettings, yoloScriptSandboxState } from "../core/sandbox/main-session.js";
import { type SessionOverrides, seedSessionRouting } from "../core/session-routing.js";
import { StartupTimer } from "../core/startup-timer.js";
import { captureAdmits } from "../core/telemetry/capture.js";
import { sessionTelemetryContext } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { registerResearchTraceSink } from "../core/telemetry/research-trace.js";
import { getTerminationCoordinator, resolveShutdownHookBudgetMs } from "../core/termination.js";
import { yieldToEventLoop } from "../core/timers.js";
import { ToolNames } from "../core/tool-names.js";
import { surfaceSpecPlacement } from "../core/tool-surface.js";
import { turnAllowsTool } from "../core/turn-constraints.js";
import { captureProjectSurface, projectSurfaceTrustNotice } from "../core/workspace-trust.js";
import { pancodeDataDir, pancodeStateDir } from "../core/xdg.js";
import { autonomyCeilingRefusal, launchAutonomyRefusal, yoloRootRefusal } from "../core/yolo-host.js";
import { renderAgentCatalogSectionsFromSpecs } from "../domains/agents/catalog.js";
import { AgentsDomainModule } from "../domains/agents/module.js";
import {
	createClaimCaptureRegistration,
	createClaimsDeliveryRegistrations,
	createHypothesisCaptureRegistration,
} from "../domains/claims/index.js";
import { PANCODE_KEYBINDINGS, type PancodeKeybinding } from "../domains/config/keybindings.js";
import { ConfigDomainModule, createConfigDomainModule } from "../domains/config/module.js";
import { liveHistoryBudget } from "../domains/context/budget/inspection.js";
import { bootstrapInputFromInitOptions } from "../domains/context/init-options.js";
import { createContextDomainModule } from "../domains/context/module.js";
import { createSessionRereadPort } from "../domains/context/working-set/session-reread.js";
import { createDispatchDedupRegistration } from "../domains/dispatch/dedup.js";
import { agentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import { createWorktreeBootRecovery } from "../domains/dispatch/index.js";
import { createDispatchDomainModule } from "../domains/dispatch/module.js";
import {
	createDetachedDispatchNudgeRegistration,
	createUnbackedWorkerClaimRegistration,
	finishedDetachedBatchIds,
	openDetachedBatchViews,
} from "../domains/dispatch/nudges/dispatch-nudge.js";
import { createPlanCloseRegistration } from "../domains/dispatch/nudges/plan-close.js";
import { createExplorationNudgeRegistrations } from "../domains/dispatch/nudges/scout-nudge.js";
import { configureRunEventJournal } from "../domains/dispatch/run-event-journal.js";
import { createExtensionRuntimeHookBridge, isLoadableExtension } from "../domains/extensions/index.js";
import { ExtensionsDomainModule } from "../domains/extensions/module.js";
import {
	describeUpgradeNotice,
	ensurePancodeState,
	takeContainedYoloNotice,
	takeUpgradeNotice,
} from "../domains/install/index.js";
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
	canonicalMemoryRepositoryIdentity,
	createTaskMemoryTelemetrySink,
	createTaskMemoryTrace,
	loadMemoryRecordsSync,
	MemoryRuntime,
	markMemoryOffRecording,
	memoryRecordStanding,
	primeMemoryRepositoryFingerprint,
	renderTaskMemoryHandoffSource,
	seedTaskMemoryFromNewestHandoff,
	type TaskMemoryHandoffSnapshot,
	taskMemoryHandoffSeedOffer,
} from "../domains/memory/index.js";
import { MEMORY_INTERVENTION_ACTIVITY_LIMIT } from "../domains/memory/intervention.js";
import { createMemoryPromptReader } from "../domains/memory/prompt-cache.js";
import { createMemoryRecallUseRegistration } from "../domains/memory/recall-use.js";
import { createMemorySessionProjection } from "../domains/memory/session-projection.js";
import { readMemoryStoreSnapshot } from "../domains/memory/store.js";
import {
	deleteTaskBankSnapshot,
	loadTaskBankSnapshot,
	saveTaskBankSnapshot,
} from "../domains/memory/task-bank-store.js";
import { createHistoryReviewActivity } from "../domains/memory/task-memory-status.js";
import { type CapabilityMatch, capabilityCorpus, createCapabilityGate } from "../domains/middleware/capability-gate.js";
import { createGuidanceRegistration } from "../domains/middleware/guidance.js";
import {
	type CompletionFact,
	createMarketplaceOfferRegistration,
	createMiddlewareToolChoiceControl,
	createSkillsReminderRegistration,
	createTurnPlanCueRegistration,
	formatRegistrationConflict,
	writeMiddlewareDiagnosticToStderr,
} from "../domains/middleware/index.js";
import { createLocalClockReminderRegistration } from "../domains/middleware/local-clock-reminder.js";
import { createMiddlewareDomain } from "../domains/middleware/module.js";
import { createStaleBuildReminderRegistration } from "../domains/middleware/stale-build-reminder.js";
import { createTaskBoardReminderRegistration } from "../domains/middleware/task-board-reminder.js";
import { createTaskNudgeRegistration } from "../domains/middleware/task-nudge.js";
import { createWatchdogRegistration } from "../domains/middleware/watchdog.js";
import { committedPluginSnapshot } from "../domains/plugins/index.js";
import { PluginsDomainModule } from "../domains/plugins/module.js";
import { createPromptsDomainModule } from "../domains/prompts/module.js";
import { agentRoleToolWarnings } from "../domains/providers/agent-role-warnings.js";
import { credentialsPresent } from "../domains/providers/credentials.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { modelEndpointKey, registerForegroundStream } from "../domains/providers/index.js";
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
import { reportWiring } from "../domains/report/wiring.js";
import {
	discoverMarketplaceSkills,
	installedSkillNames,
	installSkill,
	suggestableSkills,
} from "../domains/resources/index.js";
import { createResourcesDomainModule } from "../domains/resources/module.js";
import { createCitationGroundingRegistration } from "../domains/safety/citation-grounding.js";
import { createFinishContractRegistration } from "../domains/safety/finish-contract-registration.js";
import { DEFAULT_RECENT_ENTRY_LIMIT } from "../domains/safety/finish-entries.js";
import { createGitHookDriftGuard, type GitHookDriftGuard, gitHookDriftNotice } from "../domains/safety/hook-drift.js";
import type { FlowRestrictionSet } from "../domains/safety/index.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	flowUnmediatedAgentRefusal,
	isFlowRestrictionSet,
	mergeFlowRestrictions,
	parseRigorOverride,
	resolveModelDestination,
	resolveRigor,
	sessionChangesTree,
} from "../domains/safety/index.js";
import { workerFlowPolicyInput } from "../domains/safety/information-flow.js";
import { createInternalGitPolicy } from "../domains/safety/internal-git-policy.js";
import { SafetyDomainModule } from "../domains/safety/module.js";
import { createRunGitHelpersRelay, createStandingChecks } from "../domains/safety/observed-checks.js";
import type { ProtectedArtifactState } from "../domains/safety/protected-artifacts.js";
import { createProtectedArtifactsRegistration } from "../domains/safety/protected-artifacts-registration.js";
import { SAFETY_JUDGE_CONSECUTIVE_BLOCKS, type SafetyJudgeSeat } from "../domains/safety/safety-judge.js";
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
import { activeDecisionRefs, createDecisionBoardStore } from "../domains/session/decision-board.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import { commitHandoff, type HandoffServiceDeps, prepareHandoff } from "../domains/session/handoff-service.js";
import { SessionLiveError } from "../domains/session/index.js";
import { SessionDomainModule } from "../domains/session/module.js";
import { reconcilePendingProtectedArtifacts } from "../domains/session/protected-artifact-journal.js";
import {
	appendProtectedArtifactRegistryEvent,
	protectedArtifactStateForCurrentSession,
} from "../domains/session/protected-artifact-recording.js";
import { sessionLedgersForRoots } from "../domains/session/related-ledgers.js";
import {
	appendSkillActivationRegistryEvent,
	foldDispatchSkillActivations,
} from "../domains/session/skill-activation-recording.js";
import { createTaskBoardStore } from "../domains/session/task-board.js";
import { activePath } from "../domains/session/tree/active-path.js";
import { latestUserImages } from "../domains/session/vision-images.js";
import type { SystemOneInstance } from "../domains/system-one/index.js";
import { createSystemOne, parseRouteList } from "../domains/system-one/index.js";
import { createTelemetryDomain } from "../domains/telemetry/module.js";
import { activeUserTaskAcceptance } from "../domains/user-tasks/active-acceptance.js";
import { createUserTasksStore } from "../domains/user-tasks/store.js";
import {
	createWorkspaceSnapshots,
	pruneWorkspaceSnapshots,
	workspaceSnapshotRepositoryPresent,
} from "../domains/workspace-snapshots/index.js";
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
import {
	type AutonomyLevel,
	admissionAutonomy,
	containedYolo,
	effectiveYoloConfinement,
	modelMayActivateSkills,
} from "../lib/autonomy/autonomy.js";
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
import type { RunIo } from "../session-control/slash-command-types.js";
import { createTurnOutcomeCollector } from "../session-control/turn-outcome-collector.js";
import { effectiveToolNames } from "../tools/agent-tools.js";
import { createVisionSidecar } from "../tools/vision-sidecar.js";
import type { BootOptions } from "./boot-options.js";
import { createExtensionReloadCoordinator, extensionHookReceiptSink } from "./extension-reload.js";
import {
	admitHandoffSeedFlow,
	closedSessionLessonSource,
	createFlowLedger,
	FLOW_RESTRICTION_ENTRY_TYPE,
} from "./flow-ledger.js";
import { createJobHost } from "./job-host.js";
import { bindSessionPackageActivity } from "./package-activity.js";
import { resolvePanesEnablement } from "./panes-activation.js";
import { reloadPluginResourcesAndNotify } from "./plugin-reload.js";
import { createReloadClasses } from "./reload-classes.js";
import { retentionPruners } from "./retention-pruners.js";
import { applyRouteOverlay } from "./route-overlay.js";
import { createJudgeScreen, createSafetyJudgeCompletion, createSafetyJudgeHost } from "./safety-judge-host.js";
import { createSessionSettingsView } from "./session-settings-view.js";
import { createSideRequestAdmission } from "./side-request-admission.js";
import { createSystemOneControl } from "./system-one-control.js";
import { bindTaskMemoryLifecycle } from "./task-memory-lifecycle.js";

export type { BootOptions, HeadlessSamplingOverrides } from "./boot-options.js";

import { emitApproval } from "../core/telemetry/approvals.js";
import {
	type AutonomyHalt,
	autonomousCaps,
	autonomyHaltNotice,
	autonomyHaltReason,
	createAutonomyWindow,
	describeOpenDecision,
	settledCallTokens,
} from "../domains/safety/autonomy-window.js";
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
import { type AskUserHandler, cancelledAskUserResult } from "../tools/ask-user.js";
import { registerAllTools } from "../tools/bootstrap.js";
import { createDispatchBackgroundRegistry } from "../tools/dispatch-background.js";
import { dispatchSchemaCompositionFor } from "../tools/dispatch-schema.js";
import { mcpSubmitReader } from "../tools/gateway/mcp-submit-reader.js";
import { createFileMutationObserver, createSkillActivationObserver } from "../tools/observers.js";
import { createRegistry } from "../tools/registry.js";
import { acpHostReadOnlySource } from "../tools/registry-verdicts.js";
import { startToolOffloadSweep } from "../tools/result-shaping.js";
import { runAcpSurface } from "./boot/acp-surface.js";
import { runHeadlessSurface } from "./boot/headless-surface.js";
import { runInteractiveSurface } from "./boot/interactive-surface.js";
import type { BootSurfaceCells, BootSurfaceInput, BootSurfaceSeams } from "./boot/surface.js";

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
	(await import("../lib/heartbeat/heartbeat.js")).configureSessionHeartbeat({
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
	const telemetryDomain = createTelemetryDomain({ retention: retentionPruners });
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
					? { operatorAsk: { available: () => askUserHandler !== null, ask: (q, o) => askUserBridge(q, o) } }
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
	// Autonomy is hot-reloaded for interactive and headless admissions. ACP
	// server prompts use the snapshot captured at session/new.
	let activeAcpSessionAutonomy: AutonomyLevel | null = null;
	// Root outside a container never runs yolo (#407). The uid and the
	// container do not change while the process runs, so it is read once.
	const yoloRefusal =
		yoloRootRefusal() ?? launchAutonomyRefusal(options.acp?.autonomyCeiling) ?? autonomyCeilingRefusal();
	// The one effective-autonomy resolution. Every admission surface (registry
	// admission, dispatch plan provenance, ACP session snapshot) resolves
	// through these two functions so a fallback added to one surface cannot
	// silently skip another. The root refusal is enforced here too, so no
	// surface that reaches yolo some other way (a hot-reloaded settings file)
	// runs it.
	const resolveBaselineAutonomy = (): AutonomyLevel => {
		const level =
			effectiveSettingsForDispatch?.().safety.autonomy ??
			(options.headless !== undefined ? (options.headless.autonomy ?? "default") : undefined) ??
			options.autonomy ??
			(config?.get() ?? readSettings()).safety.autonomy ??
			"default";
		return level === "yolo" && yoloRefusal !== null ? "default" : level;
	};
	const resolveEffectiveAutonomy = (): AutonomyLevel => {
		const level = activeAcpSessionAutonomy ?? resolveBaselineAutonomy();
		return level === "yolo" && yoloRefusal !== null ? "default" : level;
	};
	// Contained yolo (ob-yolo D1) admits, judges and permits workers exactly as
	// default does; only where a call would wait for a person does it differ,
	// which `unattendedAsks` tells the registry. Prompts, auto-continuation and
	// the footer keep the operator's level.
	const resolveAdmissionAutonomy = (): AutonomyLevel =>
		admissionAutonomy(resolveEffectiveAutonomy(), effectiveYoloConfinement(getCurrentSettings().safety));
	const unattendedYolo = (): boolean =>
		containedYolo(resolveEffectiveAutonomy(), effectiveYoloConfinement(getCurrentSettings().safety));
	// Every bash command this session runs carries its live level as an autonomy ceiling, and the contained pin while
	// it runs contained yolo, so a pancode it starts cannot take more autonomy or less confinement than it has.
	setToolEnvAutonomy(resolveEffectiveAutonomy, unattendedYolo);
	const skillDiscoveryEnabled = options.noSkills !== true && options.headless?.noSkills !== true;
	let readySkillSnapshot: { key: string; count: number; skills: ReturnType<typeof suggestableSkills> } | undefined;
	const getReadySkillCount = (): number => {
		if (!resources) return 0;
		const cwd = process.cwd();
		// Skill loading reads and hashes the filesystem. Reuse the count across
		// warm/real requests and reminders until the same source epoch that
		// invalidates prompt composition changes (/reload hub, config, etc.).
		// Descriptions from here reach models through the [Skills] reminder and the
		// relevance ranker, so this reads verified trees, never the display listing.
		if (!prompts) {
			const skills = suggestableSkills(resources.skills(cwd).items);
			readySkillSnapshot = { key: cwd, count: skills.length, skills };
			return skills.length;
		}
		const key = JSON.stringify([
			cwd,
			prompts.inputEpoch(),
			skillDiscoveryEnabled,
			config?.get().integrations.projectResources.trustProjectImports === true,
			options.skillPaths ?? options.headless?.skillPaths ?? [],
		]);
		if (readySkillSnapshot?.key === key) return readySkillSnapshot.count;
		const skills = suggestableSkills(resources.skills(cwd).items);
		const count = skills.length;
		readySkillSnapshot = { key, count, skills };
		return count;
	};
	// FW-1: task-ranked advice is cheap enough for attended and headless turns;
	// it names loadable workflows directly and preserves the activation policy.
	if (resources && skillDiscoveryEnabled) {
		const rankReminderCapabilities = (task: string): ReadonlyArray<CapabilityMatch> => {
			const constraints = chat.currentTurnConstraints?.();
			if (!turnAllowsTool(constraints, "gateway")) return [];
			const surface = new Set(
				effectiveToolNames({ registry: toolRegistry, ...(constraints ? { turnConstraints: constraints } : {}) }),
			);
			return capabilityGate.rank({
				kind: "capabilities",
				task,
				limit: 3,
				...capabilityCorpus(
					toolRegistry.listAll().filter((spec) => surface.has(spec.name)),
					(spec) => surfaceSpecPlacement(spec, surface) === "gateway",
				),
			});
		};
		const rankReminderSkills = (task: string): ReadonlyArray<CapabilityMatch> => {
			getReadySkillCount();
			return capabilityGate.rank({
				kind: "skills",
				task,
				workspace: process.cwd(),
				candidates: (readySkillSnapshot?.skills ?? []).map((skill) => ({
					id: skill.name,
					description: skill.description,
					triggers: Array.isArray(skill.metadata.triggers)
						? skill.metadata.triggers.filter((value): value is string => typeof value === "string")
						: [],
				})),
			});
		};
		middlewareRegistrar.registerHook(
			createSkillsReminderRegistration({
				getTurnConstraints: () => chat.currentTurnConstraints?.(),
				contextPlacement: () => {
					const spec = toolRegistry.get(ToolNames.Context);
					return spec ? surfaceSpecPlacement(spec, null) : "direct";
				},
				countModelVisibleSkills: getReadySkillCount,
				loadedSkillNames: () => (session?.current()?.skillActivations ?? []).map((activation) => activation.name),
				rankCapabilities: rankReminderCapabilities,
				rankSkills: rankReminderSkills,
				// The snapshot is verified per epoch and a revocation takes effect on the
				// next read, so what is about to print is checked again. Only the shown
				// skills' trees are walked. An unverifiable match is simply not offered.
				verifyRankedSkills: (matches) => {
					try {
						const skills = readySkillSnapshot?.skills ?? [];
						const shown = skills.filter((skill) => matches.some((match) => match.id === skill.name));
						const verified = new Set(resources.skillsStillVerified(shown, process.cwd()).map((skill) => skill.name));
						return matches.filter((match) => verified.has(match.id));
					} catch {
						return [];
					}
				},
				// Same lookup context(scope="skills") lists under its Marketplace
				// heading, minus what is already installed, so the count the
				// reminder quotes is the count the listing will show.
				countInstallableSkills: () => {
					if (!skillDiscoveryEnabled) return 0;
					const installed = installedSkillNames(resources.skillsForDisplay(process.cwd()).items, process.cwd());
					return discoverMarketplaceSkills({ cwd: process.cwd() }).skills.filter((skill) => !installed.has(skill.name))
						.length;
				},
				modelMayActivateSkills: () => modelMayActivateSkills(),
			}),
		);
	}
	// Marketplace self-promotion: coordinator-only by this wiring (never a dispatch worker), local matcher, no offer
	// under yolo, operator-consented installs only, each offer and outcome journaled as `skill.offer`. The
	// registration also checks the own-marketplace source gate before installing.
	if (resources && skillDiscoveryEnabled) {
		middlewareRegistrar.registerHook(
			createMarketplaceOfferRegistration({
				interactive,
				askAllowed: () => resolveEffectiveAutonomy() !== "yolo",
				record: (payload) => bus.emit("skill.offer", payload, sessionTelemetryContext(session?.current()?.id)),
				listInstalledSkills: () => resources.skillsForDisplay(process.cwd()).items,
				getTurnConstraints: () => chat.currentTurnConstraints?.(),
				listInstalledSkillNames: () => [
					...installedSkillNames(resources.skillsForDisplay(process.cwd()).items, process.cwd()),
				],
				listMarketplaceEntries: () => discoverMarketplaceSkills({ cwd: process.cwd() }).skills,
				installEntry: (entry, scope) => {
					const installed = installSkill({ source: `skill:${entry.name}`, scope, name: entry.name, cwd: process.cwd() });
					return {
						path: installed.path,
						sourceUrl: installed.sourceUrl,
						installedHash: installed.installedHash,
						warnings: installed.warnings,
					};
				},
			}),
		);
	}
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// The autonomous window (ob-yolo D6): at yolo, how far PanCode runs on its own
	// before it pauses for the operator. A halt cancels the turn and latches
	// until the operator speaks; `chat` is built further down, and nothing
	// halts before the first turn runs.
	let lastAutonomyHalt: AutonomyHalt | null = null;
	const autonomyWindow = createAutonomyWindow({
		caps: () => autonomousCaps(resolveEffectiveAutonomy(), getCurrentSettings().safety.limits),
		session: () => session?.current()?.id ?? null,
		confinement: () => effectiveYoloConfinement(getCurrentSettings().safety),
		emit: (name, payload, sessionId) => bus.emit(name, payload, sessionTelemetryContext(sessionId)),
		onHalt: (halt) => {
			lastAutonomyHalt = halt;
			const prefix = autonomyHaltReason(halt);
			// Synchronous, inside the call that crossed the line: the cancel can only reach the turn that halted.
			chat.cancel({
				reason: `[PanCode] ${autonomyHaltNotice(
					halt,
					options.headless !== undefined ? "headless" : "interactive",
					autonomyWindow.openDecisions(true),
				)}`,
				source: "autonomy",
				auditReason: `${prefix}: ${halt.detail}`,
				// A cap lets a started tool call finish and stops before the next request (F-C16); a judge halt is immediate.
				...(halt.kind === "judge" ? {} : { atToolBoundary: true }),
			});
		},
	});
	// After the drain hooks settled the chat, before persist closes the journal: the end carries the final usage.
	bus.subscribe("shutdown.drained", () => autonomyWindow.end());
	bus.subscribe("tool.settled", (payload, context) => {
		if (context?.agent.role === "main" && payload.inner !== true) autonomyWindow.toolCall();
	});
	bus.subscribe("call.settled", (payload, context) => {
		if (context?.agent.role === "main") autonomyWindow.tokens(settledCallTokens(payload.usage));
	});
	// The safety judge reviews what autonomy default would park for the operator
	// against the operator's own messages. Its round goes through System One's
	// one-shot port and request admission, built further down; nothing calls the
	// judge before the first tool call.
	const safetyJudge = createSafetyJudgeHost({
		settings: () => getCurrentSettings(),
		complete: createSafetyJudgeCompletion({
			providers,
			oneShot: () => safetyJudgeOneShot,
			flowRefusal: (destination) => admitModelFlow(destination),
		}),
		session: () => session,
		safety,
		// Past either threshold every later review would refuse in silence, so contained yolo ends the run (D4).
		// A main-session escalation fires inside the review of the block that crossed the line; the window halts once the
		// registry records that block, still inside the call. A worker's block has no such record and halts at once.
		onEscalation: (note) => {
			if (!unattendedYolo()) return;
			autonomyWindow.haltFor(
				"judge",
				note.consecutiveBlocks >= SAFETY_JUDGE_CONSECUTIVE_BLOCKS
					? `blocks under ${note.consecutiveBlocks} different rules in a row`
					: `${note.totalBlocks} blocks this session`,
				note.workerRunId === undefined,
			);
		},
		// `systemOne` and `chat` are built further down; nothing calls the judge before the first tool call.
		screen: createJudgeScreen({
			systemOne: () => systemOne,
			providers,
			liveWindow: () => chat.screenWindow(),
			flow: flowLedger,
		}),
	});
	// The git hook drift guard takes its baseline now, at session start: a hook
	// file added or changed later, however it got there, makes the next git
	// command that would run it outside the sandbox an operator-only ask.
	const hookFingerprinter = createGitHooksFingerprinter(process.cwd());
	const hookDrift = createGitHookDriftGuard({
		workspace: process.cwd(),
		fingerprint: () => hookFingerprinter.fingerprint(),
		// The cheap path PanCode's own status and diff probes check before each run.
		config: (dir) => hookFingerprinter.config(dir),
		onDrift: (changes) =>
			bus.emit("safety.git_hooks_changed", {
				message: gitHookDriftNotice(changes, process.cwd()),
				changes: changes.map(({ path, kind, key, size, firstLine }) => ({
					path,
					kind,
					...(key !== undefined ? { key } : {}),
					size,
					firstLine,
				})),
			}),
	});
	// Git PanCode runs itself (task worktrees, landing worker results) runs
	// outside any sandbox, so after drift it runs with hooks off at default
	// (src/domains/safety/internal-git-policy.ts, src/core/internal-git.ts).
	installInternalGitPolicy(
		createInternalGitPolicy({
			workspace: process.cwd(),
			guard: hookDrift,
			autonomy: resolveAdmissionAutonomy,
			emptyHooksDir: join(pancodeStateDir(), "git", "no-hooks"),
			onDrift: (record) =>
				bus.emit("safety.internal_git_drifted", {
					message: record.message,
					announce: record.announce,
					operation: record.operation,
					hardened: record.hardened,
					outcome: record.outcome,
					changes: record.changes.map(({ path, kind, key }) => ({
						path,
						kind,
						...(key !== undefined ? { key } : {}),
					})),
				}),
		}),
	);
	// The same seat answers dispatched workers' asks, so worker and main-session
	// blocks share one session's escalation counts.
	workerAskJudgeForDispatch = {
		seat: () => safetyJudge,
		autonomy: resolveAdmissionAutonomy,
		operatorAutonomy: resolveEffectiveAutonomy,
		hookDrift: () => hookDrift,
	};
	// The operator spoke, typed or on an ask_user round: a fresh autonomy window.
	const operatorReturned = (): void => {
		const cleared = autonomyWindow.reopen();
		if (cleared === null) return;
		lastAutonomyHalt = null;
		// Resuming after a block streak is the operator's approval to review again.
		if (cleared.kind === "judge") safetyJudge.operatorApproved();
	};
	// Sessions whose snapshot start-of-session prune has run in this process.
	const snapshotPrunedSessions = new Set<string>();
	const toolRegistry = createRegistry({
		safety,
		middleware,
		onMiddlewareEffects: (effects) => middlewareToolChoice.apply(effects),
		// Awaited extension hooks return after the guard's own before_tool step.
		absorbAwaitedEffects: (effects, input) => protectedArtifactsGuard.absorbAwaited(input, effects),
		autonomy: resolveAdmissionAutonomy,
		unattendedAsks: unattendedYolo,
		operatorAttends: () => options.headless === undefined,
		// An operator's own answer reopens a yolo window; the judge reads it from the ledger.
		onOperatorAnswered: () => operatorReturned(),
		onUnattendedRefusal: (call, decision, kind, rule) =>
			autonomyWindow.openDecision(describeOpenDecision(call, decision, kind, rule)),
		// Only this registry carries the operator's own scope (#419): its yolo,
		// and its containment at default, where shell calls run in the
		// main-session sandbox and a snapshot precedes a destructive call.
		scratchRoots: () => getCurrentSettings().safety.scratchRoots,
		scriptSandbox: () => yoloScriptSandboxState(getCurrentSettings().safety.sandbox, sandboxAvailability()),
		containment: () => {
			const safety = getCurrentSettings().safety;
			const availability = sandboxAvailability();
			const sandbox = mainShellContained(safety.sandbox, availability);
			return {
				sandbox,
				snapshots: safety.snapshots !== "off" && workspaceSnapshotRepositoryPresent(process.cwd()),
				readOnlySandbox: sandbox && availability.backend === "bwrap",
			};
		},
		currentSessionId: () => session?.current()?.id,
		...mainShellSandboxSettings(() => getCurrentSettings()),
		mutationEpoch: (turnId) => loopGuard.mutationEpoch(turnId),
		flow: {
			...flowPort,
			// The gateway is registered after this registry; the lookup runs at call time.
			mcpTransport: (tool) => toolBootstrap.mcpCapabilities?.transportOf(tool) ?? null,
		},
		sessionCodeConsent,
		escapeScopes: safetyJudge.escapeScopes,
		safetyJudge,
		hookDrift,
		// Recoverability for the main agent on every surface; workers never snapshot.
		workspaceSnapshot: async ({ sessionId: requested, ...request }) => {
			if (getCurrentSettings().safety.snapshots === "off") return null;
			const sessionId = requested ?? session?.current()?.id;
			if (sessionId === undefined) return null;
			const outcome = await createWorkspaceSnapshots({
				stateDir: pancodeStateDir(),
				sessionId,
				cwd: process.cwd(),
			}).snapshot(request);
			// A session's first snapshot is when it starts holding snapshot state,
			// so it is also when idle sessions' refs and state are pruned.
			if (!snapshotPrunedSessions.has(sessionId)) {
				snapshotPrunedSessions.add(sessionId);
				void pruneWorkspaceSnapshots({ stateDir: pancodeStateDir(), cwd: process.cwd(), keepSessionId: sessionId }).catch(
					() => undefined,
				);
			}
			return outcome;
		},
		// `acp --read-only` arrives as the server's standing tool limits; otherwise only a client ceiling makes its turns read-only.
		...(acpMode ? { hostReadOnlySource: acpHostReadOnlySource(options.toolLimits?.readOnly === true) } : {}),
	});
	// Reloaded settings can change what refused a call, so the memory of it goes.
	bus.subscribe("config.hot_reloaded", () => toolRegistry.forgetRefusals());
	const mainPermissionOrigin = acpMode ? "acp-server" : "main";
	toolRegistry.onPermissionRequired((call, decision, meta) => {
		emitApproval(bus, "approval.requested", {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
			...(meta.turnId !== undefined ? { turnId: meta.turnId } : {}),
			origin: mainPermissionOrigin,
			axis: meta.axis,
			...(decision.kind === "ask" ? { rejection: decision.rejection } : {}),
			...(decision.policy?.ruleId !== undefined ? { ruleId: decision.policy.ruleId } : {}),
			...(decision.policy?.policySource !== undefined ? { policySource: decision.policy.policySource } : {}),
			...(decision.policy?.reasonCode !== undefined ? { reasonCode: decision.policy.reasonCode } : {}),
		});
	});
	let askUserHandler: AskUserHandler | null = acpInterviewChannel?.ask ?? options.headless?.answers?.askUser ?? null;
	// The interactive surface installs this so the report tool can open an agent's draft for review (R-12).
	let reportReviewOpener: ((draftId: string) => void) | null = null;
	const reportSession = reportWiring({
		stateDir: pancodeStateDir(),
		session: () => session?.current(),
		autonomy: resolveEffectiveAutonomy,
		identitySettings: () => ({ targets: getCurrentSettings().targets }),
	});
	// ask_user is a human interview tool, so it is registered only where a person
	// answers: the TUI, an ACP client that advertised interviews, or a run's --answers
	// file, which answers operator_only rounds and refuses the rest. Otherwise it is absent (documented
	// in `pancode run --help`). Skills that interview fall back to their stated
	// defaults when the tool is absent.
	const askUserBridge: AskUserHandler = async (questions, invokeOptions) =>
		askUserHandler ? await askUserHandler(questions, invokeOptions) : cancelledAskUserResult();
	const userTasks = createUserTasksStore({ cwd: process.cwd() });
	const standingChecks = createStandingChecks();
	// One task board per orchestrator: the tasks tool mutates it, the turn-end
	// open-tasks nudge reads it, and the footer/overlay render it. Keyed on the
	// current session id so resume/fork/new refolds it from taskLedger entries.
	const taskBoard = createTaskBoardStore({
		getSessionId: () => session?.current()?.id ?? null,
		readEntries: activePathEntries,
		appendEntry: (entry) => {
			session?.appendEntry(entry);
		},
		observeChecks: (boardId, taskId) =>
			standingChecks(activePathEntries(), boardId, taskId, process.cwd(), getCurrentSettings().safety.scratchRoots, [
				...(options.headless?.verify?.checks ?? []),
			]),
	});
	// Prime the projection once at composition. Interactive repaint paths use
	// cachedSnapshot() below, so a first paint can never become a ledger read.
	taskBoard.snapshot();
	const decisionBoard = createDecisionBoardStore({
		getSessionId: () => session?.current()?.id ?? null,
		readEntries: activePathEntries,
		getActiveLeafTurnId: () => {
			const meta = session?.current();
			return meta ? (session?.leafId(meta.id) ?? null) : null;
		},
		appendEntry: (entry) => {
			if (!session) throw new Error("decision board: no session ledger is available");
			session.appendEntry(entry);
		},
	});
	// Every PanCode-spawned commit from this session is stamped with the decisions
	// active on the board at spawn time, the same way it is stamped as assisted.
	setCommitDecisionRefsProvider(() => activeDecisionRefs(decisionBoard.snapshot()));
	// getSessionId alone never notices a /tree switch: it moves the active
	// append point inside the same session, so the id-keyed cache above kept
	// showing the abandoned branch's board (issue #94). SessionTurnSwitched is
	// the signal that switch actually happened; invalidate() forces the next
	// read to refold from the now-current leaf.
	bus.subscribe("session.turn_switched", () => {
		taskBoard.invalidate();
		// The tree switch is the I/O boundary: refold eagerly here so the 250-ms
		// island ticker remains a cache-only consumer after changing branches.
		taskBoard.snapshot();
		decisionBoard.invalidate();
	});
	// Link in-flight dispatch runs to the live board via the ledger's
	// activeRunIds field: a run is tracked from the moment its child process is
	// live until it finalizes either way. attach/detach are no-ops when no board
	// is declared, so an ambient dispatch never forces a board into existence.
	bus.subscribe("run.started", (payload) => {
		if (typeof payload?.runId === "string") taskBoard.attachRun(payload.runId);
	});
	// The receipt's flow label is absorbed the moment a run settles (its landed record, then its live end), so any
	// later injection of its output (a collect, a continuation, a resume) already finds the session ledger carrying it.
	const absorbDispatchFlow = (payload: { runId?: unknown; flowRestrictions?: unknown } | undefined): void => {
		if (typeof payload?.runId !== "string" || !isFlowRestrictionSet(payload.flowRestrictions)) return;
		flowLedger.absorb(payload.flowRestrictions, { tool: "dispatch", toolCallId: payload.runId });
	};
	bus.subscribe("run.settled", (data, ctx) => absorbDispatchFlow({ ...data, runId: ctx?.runId }));
	bus.subscribe("run.completed", (payload) => {
		if (typeof payload?.runId !== "string") return;
		taskBoard.detachRun(payload.runId);
		absorbDispatchFlow(payload);
		foldDispatchSkillActivations(session, payload);
	});
	bus.subscribe("run.failed", (payload) => {
		if (typeof payload?.runId !== "string") return;
		taskBoard.detachRun(payload.runId);
		absorbDispatchFlow(payload);
		// A run that failed after loading a skill is the case the operator most
		// needs the provenance for, and the receipt already carried it here.
		foldDispatchSkillActivations(session, payload);
	});
	// Operator-initiated backgrounding is a TUI affordance: the registry is the
	// one object the dispatch tool and the keypress both hold.
	const dispatchBackground = createDispatchBackgroundRegistry();
	// One `PanesOperations` instance drives both the `panes` tool and the
	// `/panes` slash command, so the model and the operator cannot be told
	// different things about the same pane. It also owns the no-mux Yazi chooser,
	// while model tool registration below remains gated on a live pane host.
	const panes =
		withPanes && mux
			? withPanes.createPanesRuntime({
					mux,
					getSettings: () => getCurrentSettings(),
					getDispatchSnapshot: () => dispatch.snapshot(),
					agentRefusal: () => flowUnmediatedAgentRefusal(flowLedger.policy(), null),
					getCwd: () => process.cwd(),
				})
			: null;

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
	const sessionRouting = seedSessionRouting(initialRoutingSettings);
	// Non-routing settings a session changed "for this session only" via the
	// /settings overlay. Layered under the routing overlay in the effective
	// view, so the live session reflects them immediately while settings.yaml
	// (the global default for new sessions) stays untouched until the operator
	// chooses to save globally.
	// Overrides are keyed by settings path, the same ids the /settings overlay
	// commits (`setAtPath` walks the dotted path). The headless `--autonomy`
	// flag was keyed by the bare word, which wrote a top-level `autonomy` key
	// nothing reads, so `run --autonomy yolo` compiled and admitted at
	// whatever settings.yaml said.
	// The interactive `pancode --autonomy <level>` seeds the same override.
	// yolo is a grant from a present human to the main agent. A headless run has
	// no human to have granted it, so it runs at default unless its own command
	// line says --autonomy yolo; a settings.yaml yolo does not carry over (D1).
	const startupAutonomy = options.headless !== undefined ? (options.headless.autonomy ?? "default") : options.autonomy;
	if (
		options.headless !== undefined &&
		options.headless.autonomy === undefined &&
		(config?.get() ?? readSettings()).safety.autonomy === "yolo"
	) {
		process.stderr.write(
			"pancode run: autonomy default (settings.yaml sets yolo, which a headless run takes only from --autonomy yolo)\n",
		);
	}
	// An interactive session that would start at yolo holds at default when yolo
	// is refused here, and until the operator has accepted it once; the
	// acceptance card then asks (#407). Headless `--autonomy yolo` and an ACP
	// client's mode choice count as acceptance.
	const savedSafety = (config?.get() ?? readSettings()).safety;
	let bootAutonomy = startupAutonomy;
	let yoloHeldAtBoot = false;
	if (options.headless === undefined && (startupAutonomy ?? savedSafety.autonomy) === "yolo") {
		if (yoloRefusal !== null) {
			bootAutonomy = "default";
			if (interactive) initialNotices.push(`Autonomy is default. ${yoloRefusal}`);
			else process.stderr.write(`pancode: autonomy default. ${yoloRefusal}\n`);
		} else if (interactive && savedSafety.yoloAccepted !== true) {
			bootAutonomy = "default";
			yoloHeldAtBoot = true;
		}
	}
	// Yolo is contained (ob-yolo D1): the lifecycle domain says so once per home (interactive after accepting yolo,
	// headless on a yolo run), remembered in its own state and never in the operator's settings.
	const yoloNotice =
		yoloRefusal === null && (interactive ? savedSafety.yoloAccepted === true : startupAutonomy === "yolo")
			? takeContainedYoloNotice(savedSafety)
			: null;
	if (yoloNotice !== null) {
		if (interactive) initialNotices.push(yoloNotice);
		else process.stderr.write(`pancode: ${yoloNotice}\n`);
	}
	const startupOverrides: SessionOverrides = new Map(
		bootAutonomy === undefined ? [] : [["safety.autonomy", bootAutonomy]],
	);
	if (options.demo !== undefined) startupOverrides.set("interface.demo", options.demo);
	const {
		getCurrentSettings,
		bump: bumpSessionState,
		persistCurrentThinkingLevel,
		routeProvenance,
		settingOrigin,
		persistSavedMutation,
		selectAtScope,
		clampAtScope,
		readAcpSafeSettings,
		commitAcpSafeSettings,
		applySettingsBlob,
		commitSetting,
		routingGestures,
		restoreResumedRoute,
		createRoutedSession,
		start: startSessionSettings,
	} = createSessionSettingsView({
		config,
		providers,
		session,
		bus,
		startupOverrides,
		sessionRouting,
		outputStyleListeners,
		selectModel,
		clampThinkingLevel,
	});
	effectiveSettingsForDispatch = getCurrentSettings;
	void startLoginEnvCapture(); // after getCurrentSettings: building the capture's env reads unattendedYolo
	startSessionSettings((hook) => termination.onDrain(hook));
	// System One: one instance for the process, fixed at startup in what it binds.
	const currentSessionId = (): string | null => session?.current()?.id ?? null;
	const sessionScheduling = result.getContract("scheduling");
	sessionScheduling?.setNeverWaitForRaise?.(unattendedYolo);
	const systemOneAdmissionDeps = {
		providers,
		...(sessionScheduling ? { scheduling: sessionScheduling } : {}),
		...(telemetry ? { telemetry } : {}),
		getCeilingUsd: () => getCurrentSettings().safety.limits.sessionCostUsd,
		currentSession: currentSessionId,
		repoIdentity: () => {
			const meta = session?.current();
			return meta ? meta.cwdHash || cwdHash(meta.cwd || process.cwd()) : null;
		},
	};
	const admitSystemOneRequest = createSideRequestAdmission(systemOneAdmissionDeps);
	const safetyJudgeOneShot = createSystemOneOneShot(
		providers,
		createSideRequestAdmission({ ...systemOneAdmissionDeps, role: "safety-judge" }),
	);
	// `run --systemone` holds for this process and writes nothing.
	const systemOneSettings = (): Readonly<PancodeSettings> => {
		const settings = getCurrentSettings();
		const use = options.headless?.systemOne;
		return use === undefined ? settings : { ...settings, systemOne: { ...settings.systemOne, use: parseRouteList(use) } };
	};
	const systemOneCore = createSystemOne({
		settings: () => systemOneSettings(),
		// Every engine request is judged against the restrictions it inherited
		// before a byte leaves, typed and LLM engines alike. The runner treats a
		// throw as abstention, so this only ever returns.
		flowCheck: (request) => {
			const reason = flowLedger.admitDestination(
				resolveModelDestination({
					targetId: request.destination.targetId,
					runtimeId: request.destination.runtimeId,
					url: request.destination.url ?? null,
					model: request.destination.wireModelId,
				}),
				isFlowRestrictionSet(request.inherited) ? request.inherited : null,
			);
			return reason === null ? { allowed: true } : { allowed: false, reason };
		},
		providers,
		credentialsPresent,
		oneShot: createSystemOneOneShot(providers, admitSystemOneRequest),
		admitLlmRequest: admitSystemOneRequest,
		// Each call is bound to the session it starts in, so a slow answer that settles
		// after /new, /resume or a branch switch files under the session that asked.
		currentSession: currentSessionId,
	});
	// Every caller that reaches System One through this instance inherits the
	// session's restrictions on its request unless it already names a narrower
	// set, so the flow check above sees them whoever asked.
	const systemOne: SystemOneInstance = {
		...systemOneCore,
		ask: (point, object, options) => {
			const flow = options?.flow !== undefined ? options.flow : flowLedger.current();
			const merged = { ...(options ?? {}), ...(flow !== null && flow !== undefined ? { flow } : {}) };
			return systemOneCore.ask(point, object, merged);
		},
	};
	const systemOneControl = createSystemOneControl({
		settings: () => systemOneSettings(),
		runtimes: { get: (id) => providers.getRuntime(id) },
		refusedEngines: () => systemOne.refusedEngines?.() ?? new Map(),
	});
	let lastMemoryPromptRuntimeId: string | undefined;
	const memoryReader = createMemoryPromptReader({
		getDataDir: pancodeDataDir,
		onSelection: (selection) => memoryOwner.recordPromptSelection(selection),
		relevanceGate: { demoted: () => memoryOwner.delivery.demoted() },
		delivery: memoryOwner.delivery,
	});
	// The turn's own words, for a listing asked for without a query and for triage.
	let operatorTask = "";
	// The session's lexical capability gate orders a listing the model asked for. It never shortens one.
	const catalogRanker =
		(kind: "skills" | "capabilities"): CatalogRanker =>
		(request) => {
			const ranked = capabilityGate.rank({
				kind,
				task: request.need || operatorTask,
				candidates: request.candidates.map((candidate) => ({ id: candidate.id, description: candidate.summary })),
				limit: 10,
			});
			return ranked.length > 0
				? { scores: Object.fromEntries(ranked.map((hit) => [hit.id, hit.score])), source: "capability gate" }
				: null;
		};
	const visionSidecar = createVisionSidecar({ getSettings: () => getCurrentSettings(), providers, telemetry, session });
	const jobHost = createJobHost({
		registry: toolRegistry,
		bus,
		...(session ? { session } : {}),
		telemetry: () => telemetry?.read?.live() ?? null,
		cwd: process.cwd(),
		attended: options.headless === undefined,
		safety,
		autonomy: resolveEffectiveAutonomy,
		admissionAutonomy: resolveAdmissionAutonomy,
		sandboxEnv: () => mainSandboxEnvPolicy(getCurrentSettings()),
		confine: () => getCurrentSettings().safety.confine,
		sessionCodeConsentPending: () => sessionCodeConsent.pending(),
		untilStoppedDefault: () => getCurrentSettings().chat.loopsUntilStopped,
		createSession: createRoutedSession,
		mcpEvents: () => toolBootstrap.mcpCapabilities ?? null,
		notice: (text) => {
			(deferredWatchdogNoticeSink ?? ((msg: string) => bootStderr(`${msg}\n`)))(text);
		},
	});
	const toolBootstrap = registerAllTools(toolRegistry, {
		jobTool: jobHost.tool,
		jobs: jobHost.operations,
		flow: flowPort,
		...(resolvedSettings.fleet.profiles.vision?.target
			? {
					visionSidecar,
					getRecentVisionImages: () => {
						const meta = session?.current();
						if (!session || !meta) return [];
						const leaf = session?.leafId(meta.id) ?? undefined;
						return latestUserImages(session.readEntries(), leaf);
					},
				}
			: {}),
		// Discovery shares the pre-turn gate; optional calibrated rankings arrive from its nonblocking cache.
		rankSkills: catalogRanker("skills"),
		rankCapabilities: catalogRanker("capabilities"),
		onSkillLoaded: (name) => capabilityGate.used("skills", name),
		onCapabilityCalled: (name) => capabilityGate.used("capabilities", name),
		// consult exists only when a route is named at startup, so an operator who
		// never named one keeps the registry, tool signature and prompt they had. A
		// route removed mid-session answers "no usable answer". bound() reads the
		// effective settings view built above, which is why that block precedes this call.
		...(systemOne.bound()
			? {
					consult: {
						systemOne,
						cwd: () => process.cwd(),
						// The evidence files consult reads itself never pass a read tool, so
						// they are labeled here before the request; the runner's flow check
						// then judges the labels. A throw makes consult send nothing.
						flowFor: (files) => {
							// Neither an unusable policy nor an unusable ledger may let evidence leave.
							const refusal = flowLedger.policy().refusal ?? flowLedger.refusal();
							if (refusal !== null) throw new Error(refusal);
							const labels = flowLedger.labelPaths(files, process.cwd(), "consult");
							const unlabeled = labels === null ? null : flowLedger.refusal();
							if (unlabeled !== null) throw new Error(unlabeled);
							return mergeFlowRestrictions(labels, flowLedger.current());
						},
					},
				}
			: {}),
		getContextBudget: () => chat.inspectLiveBudget(),
		...(dispatch?.budgetEconomics ? { getBudgetEconomics: dispatch.budgetEconomics } : {}),
		requestSelfCompact: (note, toolCallId, signal) => chat.requestSelfCompact(note, toolCallId, signal),
		// Read-only recall over the stores the main prompt draws from, under the
		// same repository and runtime gates; the agent scope stays with workers.
		memoryRecall: {
			enabled: memoryEnabledNow,
			onRecall: (ids) => memoryOwner.recordRecall(ids),
			bank: () => taskMemoryBank.snapshot(),
			records: () => loadMemoryRecordsSync(pancodeDataDir()),
			eligibility: () => {
				// The session header keeps the target the session was created with;
				// routing changed in the TUI or over ACP only appends ledger entries.
				// The prompt path reports the runtime it actually compiled for.
				const settingsTarget = getCurrentSettings().chat.target;
				const runtimeId =
					lastMemoryPromptRuntimeId ?? (settingsTarget ? providers.getTarget(settingsTarget)?.runtime : undefined);
				return {
					// The session's workspace, which a GUI or resumed session need not share with the process.
					activeRepository: canonicalMemoryRepositoryIdentity(memoryWorkspaceRoot()),
					activeRuntime: runtimeId === undefined ? null : { kind: "runtime", key: runtimeId },
					activeAgent: null,
				};
			},
		},
		...memoryOwner.noteTool(),
		getSettings: () => getCurrentSettings(),
		getRouteProvenance: routeProvenance,
		termination,
		captureWorkerContext: () => chat.captureWorkerContext?.() ?? null,
		...(session
			? {
					session,
					readSessionEntries: () => {
						const meta = session.current();
						return meta ? session.readEntries() : [];
					},
					onContextRecalled: (payload) =>
						bus.emit("context.recalled", payload, sessionTelemetryContext(session.current()?.id)),
					readRecall: createSessionRereadPort(session, bus),
				}
			: {}),
		taskBoard,
		decisionBoard,
		getDecisionBoard: () => decisionBoard.snapshot(),
		userTasks,
		dispatch,
		bus,
		...(interactive || acpInterviews || options.headless?.answers ? { askUser: askUserBridge } : {}),
		...(interactive
			? { mcpElicitation: "ask_user" as const }
			: acpElicitationChannel
				? { mcpElicitation: acpElicitationChannel.elicit }
				: {}),
		// R-12: the agent drafts or offers a PanCode report; the host keeps the budget and never sends.
		report: {
			...reportSession,
			version: readPancodeVersion(),
			surface: interactive ? "tui" : acpMode ? "acp" : "headless",
			offers: () => getCurrentSettings().report?.offers ?? "ask",
			writeOffersOff: () =>
				persistSavedMutation((settings) => {
					settings.report = { ...settings.report, offers: "off" };
				}, "settings-ui"),
			...(interactive || acpInterviews ? { askUser: askUserBridge } : {}),
			attended: () => askUserHandler !== null,
			openReview: () => reportReviewOpener,
		},
		...(agents ? { getAgentCatalog: () => renderAgentCatalogSectionsFromSpecs(agents.listSpecs()).stable } : {}),
		...(agents ? { getAgentSpecs: () => agents.listSpecs() } : {}),
		...(agents ? { getAgentRoleFacts: agentRoleFactsResolver((id: string) => agents.getSpec(id)) } : {}),
		// ask_user, configure_pancode and dispatch read the operator's level, so
		// either yolo runs a dispatch plan without the plan stop; steer reads the
		// level admission runs at, so the main agent's grants to workers agree
		// with the approval surface (contained yolo reads as default there).
		getAutonomy: resolveEffectiveAutonomy,
		getAdmissionAutonomy: resolveAdmissionAutonomy,
		...(interactive ? { dispatchBackground } : {}),
		...(mux ? { competeMuxWorktrees: mux } : {}),
		// Registered only when a pane host answered detection, so the tool is
		// absent from the prompt on a machine with none rather than present and
		// always refusing.
		...(panes && mux?.mode !== "none" ? { panes } : {}),
		getCostCeilingUsd: () => result.getContract("scheduling")?.ceilingUsd() ?? 0,
		...(config ? { getWorkerRosters: () => config.get().fleet.rosters } : {}),
		...(config ? { getDispatchSchemaComposition: () => dispatchSchemaCompositionFor(config.get().fleet) } : {}),
		getSkillLoaderOptions: () => ({
			trustProjectCompatRoots: config?.get().integrations.projectResources.trustProjectImports === true,
			disableDiscovery: options.noSkills === true || options.headless?.noSkills === true,
			...(options.skillPaths && options.skillPaths.length > 0
				? { explicitSkillPaths: options.skillPaths }
				: options.headless?.skillPaths && options.headless.skillPaths.length > 0
					? { explicitSkillPaths: options.headless.skillPaths }
					: {}),
		}),
	});
	// Runtime tools are served after the core and command tools hold their
	// names; the gateway keeps the provider schema set unchanged as each
	// generation swaps them.
	extensionReload.attachRuntimeTools(toolRegistry);

	const getTaskMemorySeedOffer = (): { source: string; count: number } | null => {
		return taskMemoryHandoffSeedOffer(process.cwd(), getCurrentSettings().context.memory.enabled);
	};
	const admitHandoffSeed = (snapshot: TaskMemoryHandoffSnapshot) =>
		admitHandoffSeedFlow(
			{
				ledger: flowLedger,
				ensureSession: () => {
					if (!session || session.current()) return;
					createRoutedSession();
					taskBoard.snapshot();
				},
				hasSourceRules: flowLedger.hasSourceRules,
			},
			snapshot.source.sessionId,
		);
	const seedCurrentTaskMemoryFromHandoff = () => {
		return seedTaskMemoryFromNewestHandoff(
			taskMemoryBank,
			process.cwd(),
			getCurrentSettings().context.memory.enabled,
			admitHandoffSeed,
		);
	};
	if (resumedSessionAtBoot) {
		const offer = getTaskMemorySeedOffer();
		if (offer && offer.count > 0) {
			initialNotices.push(
				`task memory: ${offer.count} handoff entr${offer.count === 1 ? "y" : "ies"} available from ${offer.source}; run /memory seed to import`,
			);
		}
	}
	for (const warning of agentRoleToolWarnings(providers, getCurrentSettings())) {
		if (interactive) initialNotices.push(warning);
		else process.stderr.write(`${warning}\n`);
	}
	// Residency protection follows the live effective settings: the models the
	// operator's config references (orchestrator, worker default/profiles,
	// target defaults) may never be evicted by another PanCode stream, and a
	// routing change updates the set on the next read.
	setProtectedModelsProvider(() => protectedResidencyModels(getCurrentSettings()));

	const validatedKeybindings = validateKeybindings((config?.get() ?? readSettings()).interface.keybindings ?? {});
	const invalidBindings = validatedKeybindings.invalid;
	if (invalidBindings.length > 0) {
		const notice = formatInvalidKeybindingNotice(invalidBindings);
		if (interactive) initialNotices.push(notice);
		else process.stderr.write(notice);
	}
	const platformWarnings = process.stdin.isTTY
		? detectPlatformKeybindingWarnings(validatedKeybindings.valid, detectTerminalKeySupport(process.env))
		: [];
	if (platformWarnings.length > 0) {
		const notice = formatPlatformKeybindingNotice(platformWarnings);
		if (interactive) initialNotices.push(notice);
		else process.stderr.write(notice);
	}
	// A headless `--session`/`--continue` resumed before the route was seeded;
	// restore it now, letting an explicit --target/--model/--thinking win.
	if (resumedSessionAtBoot) {
		const notice = restoreResumedRoute({
			route: options.headless?.target !== undefined || options.headless?.model !== undefined,
			thinking: options.headless?.thinking !== undefined,
		});
		if (notice !== null) bootStderr(`PanCode: ${notice}\n`);
	}
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
	// Every later resume (/resume, ACP session/load) goes through the session
	// domain, which announces it synchronously before the caller replays the
	// transcript. A `/tree` branch switch is a different event and keeps the
	// route the operator is on.
	const unsubscribeResumedRoute = bus.subscribe("session.reattached", (payload) => {
		const event = payload as { sessionId?: unknown; via?: unknown } | null | undefined;
		if (event?.via !== "resume" || session?.current()?.id !== event.sessionId) return;
		const notice = restoreResumedRoute();
		if (notice === null) return;
		if (interactive && deferredWatchdogNoticeSink) {
			deferredWatchdogNoticeSink(notice);
		} else if (options.acp !== undefined) {
			// ACP has no advisory channel outside a prompt; record it where the
			// routing notices already go (see the ConfigNextTurn subscriber below).
			try {
				session?.appendEntry({
					kind: "custom",
					customType: "pancode.routing-notice",
					parentTurnId: null,
					data: { kind: "resumed-route-unavailable", level: "warning", text: notice },
				});
			} catch {
				// Advisory only.
			}
		} else {
			bootStderr(`PanCode: ${notice}\n`);
		}
	});
	termination.onDrain(() => unsubscribeResumedRoute());

	const readCurrentSessionEntries = (): ReadonlyArray<SessionEntry> => {
		if (session === undefined) return [];
		const meta = session.current();
		if (!meta) return [];
		reconcilePendingProtectedArtifacts(session);
		return session.readEntries();
	};

	const reseedUsage = (): void => {
		const meta = session?.current();
		if (!meta || !telemetry) return;
		telemetry.resetSession(meta.id);
	};
	termination.onDrain(bus.subscribe("session.reattached", reseedUsage));
	termination.onDrain(bus.subscribe("session.turn_switched", reseedUsage));

	const turnOutcomeCollector = createTurnOutcomeCollector({ workspaceRoot: memoryWorkspaceRoot });
	let outcomeSessionId: string | null = null;
	const seedOutcomeFromSession = (): void => {
		const meta = session?.current();
		outcomeSessionId = meta?.id ?? null;
		let streak = 0;
		try {
			const latest = meta
				? [...readRecentSessionEntriesForContract(meta.id)]
						.reverse()
						.find((entry) => entry.kind === "custom" && entry.customType === "turnOutcome")
				: undefined;
			if (latest?.kind === "custom") {
				const data = latest.data as { conversation?: { clarificationStreak?: unknown } } | null;
				if (typeof data?.conversation?.clarificationStreak === "number") streak = data.conversation.clarificationStreak;
			}
		} catch {
			// An unreadable tail provides no previous measurement; it must not prevent opening a session.
		}
		turnOutcomeCollector.seedClarificationStreak(streak);
	};
	seedOutcomeFromSession();
	const unsubscribeOutcomeResume = bus.subscribe("session.reattached", seedOutcomeFromSession);
	termination.onDrain(() => unsubscribeOutcomeResume());
	middlewareRegistrar.registerHook(turnOutcomeCollector);
	// Only the main session writes claims (#406): a worker's own verify call judges a tree the worker controls, so its
	// checks reach the log through host verification instead. The verify tool judges against process.cwd(), so the claim
	// is scoped to the project that cwd lies in.
	middlewareRegistrar.registerHook(createClaimCaptureRegistration({ cwd: () => process.cwd() }));
	// A hypothesis slate the main session writes enters the same log at proposed; the check its criterion names moves it.
	middlewareRegistrar.registerHook(createHypothesisCaptureRegistration({ cwd: () => process.cwd() }));
	// Contested and superseded claims reach the main agent in the message tail when the task touches their check (#406).
	// Registered after capture, so the awaited verify delivery reads the claim and edges that call just appended.
	for (const registration of createClaimsDeliveryRegistrations({ cwd: () => process.cwd() }))
		middlewareRegistrar.registerHook(registration);

	// turn_end assessors, fired by the chat-loop when the final assistant
	// message of a run lands. Tool-prose first so its hard-block interruption
	// precedes the finish-contract advisory in effect order.
	middlewareRegistrar.registerHook(createToolProseRegistration());
	middlewareRegistrar.registerHook(createTaskNudgeRegistration({ getBoard: () => taskBoard.snapshot() }));
	const changesTree = sessionChangesTree(getCurrentSettings);
	for (const registration of createExplorationNudgeRegistrations({
		workspaceRoot: memoryWorkspaceRoot,
		readStreak: { repeatsAsRead: callRepeatsAsRead, changesTree },
		readStreakObserver: turnOutcomeCollector,
		readStreakStall: (detail) => autonomyWindow.haltFor("exploration", detail),
	}))
		middlewareRegistrar.registerHook(registration);
	// Main session only (workers never see the turn-plan cue). It names a parallel dispatch only where writing tasks can
	// run: yolo, or an operator (TUI/ACP) to approve them; headless default denies approvals, so it keeps the board part.
	middlewareRegistrar.registerHook(
		createTurnPlanCueRegistration((args) => changesTree(ToolNames.Bash, args, memoryWorkspaceRoot()), {
			dispatchRuns: () => resolveEffectiveAutonomy() === "yolo" || interactive || acpMode,
		}),
	);
	middlewareRegistrar.registerHook(createUnbackedWorkerClaimRegistration());
	middlewareRegistrar.registerHook(
		createDetachedDispatchNudgeRegistration({ getOpenBatches: () => openDetachedBatchViews(dispatch) }),
	);
	const taskEstablished = (): boolean => {
		const board = taskBoard.snapshot();
		return (
			board?.tasks.some((task) => task.status === "active" || task.status === "pending" || task.status === "blocked") ===
				true || userTasks.snapshot().some((task) => task.status === "handed" || task.status === "picked")
		);
	};
	const turnControl = createTurnControlRunner({
		getSettings: getCurrentSettings,
		dispatch,
		getInvokeOptions: () => {
			const sessionId = session?.current()?.id;
			return sessionId === undefined ? {} : { sessionId };
		},
		getTurnConstraints: () => chat.currentTurnConstraints?.(),
		finishedDetachedBatchIds: () => finishedDetachedBatchIds(dispatch),
		emitNotice: (text) => {
			if (deferredWatchdogNoticeSink) deferredWatchdogNoticeSink(text);
			else bootStderr(`${text}\n`);
		},
	});
	// The opt-in turn-end watchdog. Headless and ACP runs pass `false` for the
	// surface: neither has an operator reading a transcript, so a notice they
	// cannot see would be a worker run spent on nothing whatever the setting says.
	middlewareRegistrar.registerHook(
		createWatchdogRegistration({
			firesOnThisSurface: interactive,
			getSettings: () => (effectiveSettingsForDispatch?.() ?? getCurrentSettings()).safety.review,
			getScope: () => {
				const board = taskBoard.snapshot();
				if (board === null) return null;
				const active = board.tasks.find((task) => task.status === "active");
				return active ? `${board.title}: ${active.id} ${active.title}` : board.title;
			},
			run: (trigger) =>
				runWatchdogReview(trigger, {
					dispatch,
					bus,
					...(agents ? { getAgentRoleFacts: agentRoleFactsResolver((id: string) => agents.getSpec(id)) } : {}),
					target: (effectiveSettingsForDispatch?.() ?? getCurrentSettings()).safety.review.target,
					...(deferredWatchdogNoticeSink ? { emitNotice: deferredWatchdogNoticeSink } : {}),
				}),
		}),
	);
	// `run --verify` checks the last finish decision credited to the agent's own run after its last edit.
	const runVerifyChecks = options.headless?.verify?.checks ?? [];
	let creditedRunChecks: ReadonlySet<string> = new Set();
	let declaredCompletionFacts: ReadonlyArray<CompletionFact> = [];
	const headlessGitHelpers = createRunGitHelpersRelay();
	if (session) {
		middlewareRegistrar.registerHook(
			createFinishContractRegistration({
				getTurnConstraints: () => chat.currentTurnConstraints?.(),
				...(runVerifyChecks.length > 0 ? { readSessionVerifiers: () => runVerifyChecks } : {}),
				readRunGitHelpers: headlessGitHelpers.read,
				// Tail-scoped: the contract only needs the last-user-message window, so
				// it parses a bounded ledger tail per turn_end rather than the whole
				// file (which grows unbounded with session length).
				readSessionEntries: () => readRecentSessionEntriesForContract(session.current()?.id),
				resolveRigor: () =>
					resolveRigor({
						cwd: process.cwd(),
						override: parseRigorOverride(process.env.PANCODE_RIGOR),
						containedYolo: unattendedYolo(),
					}),
				reserveVerificationNudge: unattendedYolo,
				readActiveAcceptance: (window) =>
					activeUserTaskAcceptance(userTasks.snapshot(), taskBoard.snapshot(), session.current()?.id ?? null, window),
				recordDecision: (record) => {
					turnOutcomeCollector.recordCompletion(
						record.turnId,
						record.decision,
						record.mutatedPaths.length,
						record.evidenceKinds,
					);
					safety.decisions.recordCompletionContract?.(record);
					creditedRunChecks = new Set(record.verificationScope?.passedChecks ?? []);
				},
				reportDeclaredFacts: (facts) => {
					declaredCompletionFacts = facts;
				},
			}),
		);
	}

	// DF-1: a final answer that cites line numbers no tool printed gets one
	// continuation to re-read with line_numbers. Every surface, headless included.
	middlewareRegistrar.registerHook(createCitationGroundingRegistration());

	if (!options.headless && !options.acp) {
		middlewareRegistrar.registerHook(
			createPlanCloseRegistration({
				// Yolo asks too; an unanswered card takes its recommended option
				// once the unattended window passes, so it never parks a run (#421).
				canAsk: () => askUserHandler !== null,
			}),
		);
		// Demo guidance: operator-only capability tips after a turn. Everything it
		// does, profile writes included, stops while interface.demo is off.
		middlewareRegistrar.registerHook(
			createGuidanceRegistration({
				enabled: () => interfaceGuidanceEnabled(getCurrentSettings().interface),
				autonomy: () => resolveEffectiveAutonomy(),
				keyFor: (actionId) =>
					Object.hasOwn(PANCODE_KEYBINDINGS, actionId) ? actionKeyLabel(actionId as PancodeKeybinding) : null,
				hasProjectContext: () => existsSync(join(process.cwd(), "PANCODE.md")),
				contextPressure: () => {
					const ledger = chat.contextLedger();
					return ledger.contextWindow > 0 ? ledger.usedTokens / ledger.contextWindow : null;
				},
			}),
		);
	}
	// No boundary from here to `lease.adopt`. The chat loop starts a target probe
	// and a prewarm timer whose notices, like the lease diagnostics taken below,
	// reach only subscribers the interactive application registers; a loop turn
	// in between would deliver them to nobody.
	const chat = createChatLoop({
		...(acpInterviews ? { eggAsk: askUserBridge } : {}),
		turnControl,
		turnOutcomeCollector,
		hostCompletionFacts: () => declaredCompletionFacts,
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
			lastMemoryPromptRuntimeId = request.runtimeId;
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
			operatorTask = task;
			if ((session?.current()?.id ?? null) !== outcomeSessionId) seedOutcomeFromSession();
		},
		currentOperatorTask: () => operatorTask,
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
			deferredMemoryReminderSink = sink;
		},
		registerDeferredNoticeSink: (sink) => {
			deferredWatchdogNoticeSink = sink;
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
	isChatStreaming = () => chat.isStreaming();
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
	): Promise<import("./extension-host.js").ExtensionHost | null> => {
		if (!extensions) return null;
		const hostable = (cwd: string) =>
			extensions.list(cwd, { all: true }).filter((entry) => isLoadableExtension(entry) && entry.runtimeV2 !== undefined);
		if (hostable(process.cwd()).length === 0) return null;
		const { startExtensionHost } = await import("./extension-host.js");
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

	// The surface tails in src/entry/boot/ read the wired session through `surface`. `cells` reaches the lets
	// closures here still assign, and `seams` carries what only this file may import (rule6).
	const cells: BootSurfaceCells = {
		get activeAcpSessionAutonomy() {
			return activeAcpSessionAutonomy;
		},
		set activeAcpSessionAutonomy(value) {
			activeAcpSessionAutonomy = value;
		},
		get askUserHandler() {
			return askUserHandler;
		},
		set askUserHandler(value) {
			askUserHandler = value;
		},
		get creditedRunChecks() {
			return creditedRunChecks;
		},
		get lastAutonomyHalt() {
			return lastAutonomyHalt;
		},
		get reportReviewOpener() {
			return reportReviewOpener;
		},
		set reportReviewOpener(value) {
			reportReviewOpener = value;
		},
		get resumedSessionAtBoot() {
			return resumedSessionAtBoot;
		},
		get unsubscribeDispatchShutdown() {
			return unsubscribeDispatchShutdown;
		},
		get yoloHeldAtBoot() {
			return yoloHeldAtBoot;
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
