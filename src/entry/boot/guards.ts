// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { writeHeadlessNoticesToStderr } from "../../cli/headless-notices.js";
import { type PancodeSettings, readSettings } from "../../core/config.js";
import { configureGuardrails, guardrailValuesFromSettings } from "../../core/guardrails.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { getTerminationCoordinator } from "../../core/termination.js";
import type { ConfigContract } from "../../domains/config/contract.js";
import { createDispatchDedupRegistration } from "../../domains/dispatch/dedup.js";
import { configureRunEventJournal } from "../../domains/dispatch/run-event-journal.js";
import { createStaleEditGuardRegistration } from "../../domains/memory/compaction/stale-edit-guard.js";
import type { MiddlewareRegistrar } from "../../domains/middleware/contract.js";
import { formatRegistrationConflict, writeMiddlewareDiagnosticToStderr } from "../../domains/middleware/index.js";
import { createLocalClockReminderRegistration } from "../../domains/middleware/local-clock-reminder.js";
import { createStaleBuildReminderRegistration } from "../../domains/middleware/stale-build-reminder.js";
import { createTaskBoardReminderRegistration } from "../../domains/middleware/task-board-reminder.js";
import { anthropicQuotaNotice, onAnthropicQuotaChange, watchCopilotStreamQuota } from "../../domains/quota/index.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import type { ProtectedArtifactState } from "../../domains/safety/protected-artifacts.js";
import { createProtectedArtifactsRegistration } from "../../domains/safety/protected-artifacts-registration.js";
import type { SessionContract } from "../../domains/session/contract.js";
import {
	appendProtectedArtifactRegistryEvent,
	protectedArtifactStateForCurrentSession,
} from "../../domains/session/protected-artifact-recording.js";
import { appendSkillActivationRegistryEvent } from "../../domains/session/skill-activation-recording.js";
import { activePath } from "../../domains/session/tree/active-path.js";
import type { declareRuntimeNoticeProducer } from "../../engine/apis/residency.js";
import type {
	createLoopGuardRegistration,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	INTERACTIVE_SAME_CALL_BLOCK_LIMIT,
	readOrchTurnToolCallBudget,
} from "../../engine/loop-guard.js";
import { createSkillActivationObserver } from "../../tools/observers.js";

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootGuardsCells {
	readonly effectiveSettingsForDispatch: (() => Readonly<PancodeSettings>) | null;
	protectedArtifactStateForDispatch: (() => ProtectedArtifactState) | null;
}

/** What buildBootGuards reads from the names bootOrchestrator built before it. */
export interface BootGuardsInput {
	acpMode: boolean;
	bus: TelemetryHub;
	config: ConfigContract | undefined;
	createLoopGuardRegistration: typeof createLoopGuardRegistration;
	emitQuotaNotice: ReturnType<typeof declareRuntimeNoticeProducer<"stress">>;
	interactive: boolean;
	INTERACTIVE_LOOP_BLOCK_BUDGET: typeof INTERACTIVE_LOOP_BLOCK_BUDGET;
	INTERACTIVE_SAME_CALL_BLOCK_LIMIT: typeof INTERACTIVE_SAME_CALL_BLOCK_LIMIT;
	middlewareRegistrar: MiddlewareRegistrar;
	readOrchTurnToolCallBudget: typeof readOrchTurnToolCallBudget;
	safety: SafetyContract;
	session: SessionContract | undefined;
	termination: ReturnType<typeof getTerminationCoordinator>;
	cells: BootGuardsCells;
}

/**
 * Stage P3: the middleware diagnostic sink, the headless notice printer and quota drains, the guardrail and run journal
 * policy from the boot settings, then the loop, protected-artifact, dispatch dedup and stale-edit guards, the observers,
 * and the turn reminders, registered in that order.
 */
export function buildBootGuards(input: BootGuardsInput) {
	const {
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
	} = input;
	const { cells } = input;
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
	// The effective session view (session-settings-view.ts) replaces this boot projection once initialized.
	const resolvedSettings = config?.get() ?? readSettings();
	configureGuardrails(guardrailValuesFromSettings(resolvedSettings));

	// The journal sink sits on the dispatch event path, where reading settings
	// would be both a cost and a throw site. The effective session view
	// (session-settings-view.ts) replaces this boot projection once initialized.
	configureRunEventJournal(resolvedSettings.fleet.history.journal);

	// Register the loop and dispatch guards first. The protected-artifact guard
	// is constructed here but registered by orchestrator.ts after user hooks load,
	// so it can absorb their protect_path effects. Workers register their own guards in
	// worker-runtime.ts; these instances carry the bus and session persistence.
	const loopGuard = createLoopGuardRegistration({
		safety,
		bus,
		readResultMaxBytes: () => (cells.effectiveSettingsForDispatch?.() ?? resolvedSettings).context.toolResultMaxBytes,
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
	cells.protectedArtifactStateForDispatch = () => {
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
	return { activePathEntries, loopGuard, protectedArtifactsGuard, resolvedSettings };
}
