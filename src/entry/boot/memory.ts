// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { readFileSync } from "node:fs";
import { type PancodeSettings, readSettings } from "../../core/config.js";
import { writeDiagnostic } from "../../core/diagnostics.js";
import type { DomainContractMap } from "../../core/domain-contracts.js";
import type { LoadResult } from "../../core/domain-loader.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { getTerminationCoordinator } from "../../core/termination.js";
import { pancodeDataDir, pancodeStateDir } from "../../core/xdg.js";
import type { ConfigContract } from "../../domains/config/contract.js";
import { liveHistoryBudget } from "../../domains/context/budget/inspection.js";
import {
	createBackgroundCallJournal,
	createBackgroundMemoryRouting,
	createMemoryFlowAdmission,
	memoryObservationCapacity,
	memoryRouteConfigured,
} from "../../domains/memory/background-route.js";
import type { MemoryGuardian } from "../../domains/memory/guardian.js";
import { createGuardianStatePublisher } from "../../domains/memory/guardian-state.js";
import { createHistoryReviewSource } from "../../domains/memory/history-review.js";
import {
	createTaskMemoryTelemetrySink,
	createTaskMemoryTrace,
	type MemoryRuntime,
	markMemoryOffRecording,
	primeMemoryRepositoryFingerprint,
} from "../../domains/memory/index.js";
import { MEMORY_INTERVENTION_ACTIVITY_LIMIT } from "../../domains/memory/intervention.js";
import { createMemoryRecallUseRegistration } from "../../domains/memory/recall-use.js";
import { createMemorySessionProjection } from "../../domains/memory/session-projection.js";
import {
	deleteTaskBankSnapshot,
	loadTaskBankSnapshot,
	saveTaskBankSnapshot,
} from "../../domains/memory/task-bank-store.js";
import { createHistoryReviewActivity } from "../../domains/memory/task-memory-status.js";
import type { MiddlewareRegistrar } from "../../domains/middleware/contract.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { SessionContract } from "../../domains/session/contract.js";
import { sessionLedgersForRoots } from "../../domains/session/related-ledgers.js";
import type { TelemetryContract } from "../../domains/telemetry/contract.js";
import type { ChatLoop } from "../../session-control/chat-loop.js";
import type { BootOptions } from "../boot-options.js";
import { closedSessionLessonSource, type createFlowLedger } from "../flow-ledger.js";
import { bindTaskMemoryLifecycle } from "../task-memory-lifecycle.js";

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootMemoryCells {
	readonly chat: ChatLoop;
	readonly effectiveSettingsForDispatch: (() => Readonly<PancodeSettings>) | null;
	readonly getCurrentSettings: () => PancodeSettings;
}

/** What wireBootMemory reads from the names bootOrchestrator built before it. */
export interface BootMemoryInput {
	admitModelFlow: (destination: { targetId: string; runtimeId: string; wireModelId: string }) => string | null;
	bus: TelemetryHub;
	config: ConfigContract | undefined;
	flowLedger: ReturnType<typeof createFlowLedger>;
	memoryOwner: MemoryRuntime;
	middlewareRegistrar: MiddlewareRegistrar;
	options: BootOptions;
	providers: ProvidersContract;
	result: LoadResult<DomainContractMap>;
	session: SessionContract | undefined;
	telemetry: TelemetryContract;
	termination: ReturnType<typeof getTerminationCoordinator>;
	cells: BootMemoryCells;
}

/**
 * Stage P4: the task memory bank and its late-bound sinks, the background memory journal, the intervention and the
 * guardian, the memory owner's configuration, and the memory lifecycle with its drain.
 */
export function wireBootMemory(input: BootMemoryInput) {
	const {
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
	} = input;
	const { cells } = input;
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
		(cells.effectiveSettingsForDispatch?.().context.memory ?? memorySettings).enabled;
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
			const memory = cells.effectiveSettingsForDispatch?.().context.memory ?? memorySettings;
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
			() => cells.effectiveSettingsForDispatch?.(),
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
		memoryRouteConfigured(cells.effectiveSettingsForDispatch?.() ?? config?.get() ?? readSettings());
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
			() => cells.effectiveSettingsForDispatch?.(),
			bus,
			admitMemoryFlow,
			false,
			backgroundSessionSpendUsd,
			backgroundCallJournal,
		),
		settings: () => {
			const memory = cells.effectiveSettingsForDispatch?.().context.memory ?? memorySettings;
			return { maxTokens: memory.maxOutputTokens, timeoutMs: memory.timeoutMs };
		},
		workspaceRoot: memoryWorkspaceRoot,
		telemetry: historyReviews.telemetry,
		onStateChange: guardianState.publish,
	});
	const memoryEnabledNow = (): boolean =>
		(cells.effectiveSettingsForDispatch?.() ?? cells.getCurrentSettings()).context.memory.enabled;
	const beforeTurnRecorded = (target: SessionContract): void => {
		if (!memoryEnabledNow()) markMemoryOffRecording(target);
	};
	const beforeShellEntryRecorded = (): void => {
		if (session) beforeTurnRecorded(session);
	};
	const memoryActiveEntries = createMemorySessionProjection(() => session);
	const liveHistory = (): { usable: number; used: number } | null => liveHistoryBudget(cells.chat.inspectLiveBudget());
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
			memoryObservationCapacity(providers, cells.effectiveSettingsForDispatch?.() ?? cells.getCurrentSettings()),
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

		settings: () => cells.effectiveSettingsForDispatch?.().context.memory ?? memorySettings,
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
		foldPlanner: () => ({ live: cells.chat, compaction: cells.getCurrentSettings().context.compaction }),
		client: createBackgroundMemoryRouting(
			providers,
			() => cells.effectiveSettingsForDispatch?.(),
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
	return {
		beforeShellEntryRecorded,
		beforeTurnRecorded,
		guardianState,
		historyReviews,
		memoryEnabledNow,
		memoryIntervention,
		memoryRouteAvailable,
		memoryWorkspaceRoot,
		taskMemoryBank,
		memoryState: {
			get deferredMemoryReminderSink() {
				return deferredMemoryReminderSink;
			},
			set deferredMemoryReminderSink(value: typeof deferredMemoryReminderSink) {
				deferredMemoryReminderSink = value;
			},
			get deferredWatchdogNoticeSink() {
				return deferredWatchdogNoticeSink;
			},
			set deferredWatchdogNoticeSink(value: typeof deferredWatchdogNoticeSink) {
				deferredWatchdogNoticeSink = value;
			},
			get isChatStreaming() {
				return isChatStreaming;
			},
			set isChatStreaming(value: typeof isChatStreaming) {
				isChatStreaming = value;
			},
			get memoryGuardian() {
				return memoryGuardian;
			},
		},
	};
}
