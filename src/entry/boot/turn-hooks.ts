// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PancodeSettings } from "../../core/config.js";
import { interfaceGuidanceEnabled } from "../../core/defaults.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { getTerminationCoordinator } from "../../core/termination.js";
import { ToolNames } from "../../core/tool-names.js";
import type { AgentsContract } from "../../domains/agents/contract.js";
import {
	createClaimCaptureRegistration,
	createClaimsDeliveryRegistrations,
	createHypothesisCaptureRegistration,
} from "../../domains/claims/index.js";
import { PANCODE_KEYBINDINGS, type PancodeKeybinding } from "../../domains/config/keybindings.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import { agentRoleFactsResolver } from "../../domains/dispatch/execution-role.js";
import {
	createDetachedDispatchNudgeRegistration,
	createUnbackedWorkerClaimRegistration,
	finishedDetachedBatchIds,
	openDetachedBatchViews,
} from "../../domains/dispatch/nudges/dispatch-nudge.js";
import { createPlanCloseRegistration } from "../../domains/dispatch/nudges/plan-close.js";
import { createExplorationNudgeRegistrations } from "../../domains/dispatch/nudges/scout-nudge.js";
import type { MiddlewareRegistrar } from "../../domains/middleware/contract.js";
import { createGuidanceRegistration } from "../../domains/middleware/guidance.js";
import { type CompletionFact, createTurnPlanCueRegistration } from "../../domains/middleware/index.js";
import { createTaskNudgeRegistration } from "../../domains/middleware/task-nudge.js";
import { createWatchdogRegistration } from "../../domains/middleware/watchdog.js";
import type { AutonomyWindow } from "../../domains/safety/autonomy-window.js";
import { createCitationGroundingRegistration } from "../../domains/safety/citation-grounding.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import { createFinishContractRegistration } from "../../domains/safety/finish-contract-registration.js";
import { parseRigorOverride, resolveRigor, sessionChangesTree } from "../../domains/safety/index.js";
import { createRunGitHelpersRelay } from "../../domains/safety/observed-checks.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { SessionEntry } from "../../domains/session/entries.js";
import { reconcilePendingProtectedArtifacts } from "../../domains/session/protected-artifact-journal.js";
import type { TaskBoardStore } from "../../domains/session/task-board.js";
import type { TelemetryContract } from "../../domains/telemetry/contract.js";
import { activeUserTaskAcceptance } from "../../domains/user-tasks/active-acceptance.js";
import type { UserTasksStore } from "../../domains/user-tasks/store.js";
import type { callRepeatsAsRead } from "../../engine/loop-guard.js";
import type { actionKeyLabel } from "../../interactive/keybinding-manager.js";
import type { createToolProseRegistration } from "../../interactive/tool-prose-registration.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import type { ChatLoop, createTurnControlRunner } from "../../session-control/chat-loop.js";
import type { createTurnOutcomeCollector } from "../../session-control/turn-outcome-collector.js";
import type { runWatchdogReview } from "../../session-control/watchdog-run.js";
import type { AskUserHandler } from "../../tools/ask-user.js";
import type { BootOptions } from "../boot-options.js";
import type { createSessionSettingsView } from "../session-settings-view.js";

type SessionSettingsView = ReturnType<typeof createSessionSettingsView>;

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootTurnHooksCells {
	readonly askUserHandler: AskUserHandler | null;
	readonly chat: ChatLoop;
	readonly deferredWatchdogNoticeSink: ((text: string) => void) | null;
}

/** What registerBootTurnHooks reads from the names bootOrchestrator built before it. */
export interface BootTurnHooksInput {
	acpMode: boolean;
	actionKeyLabel: typeof actionKeyLabel;
	agents: AgentsContract | undefined;
	autonomyWindow: AutonomyWindow;
	bootStderr: (text: string) => void;
	bus: TelemetryHub;
	callRepeatsAsRead: typeof callRepeatsAsRead;
	createToolProseRegistration: typeof createToolProseRegistration;
	createTurnControlRunner: typeof createTurnControlRunner;
	createTurnOutcomeCollector: typeof createTurnOutcomeCollector;
	dispatch: DispatchContract;
	effectiveSettingsForDispatch: () => Readonly<PancodeSettings>;
	getCurrentSettings: SessionSettingsView["getCurrentSettings"];
	interactive: boolean;
	memoryWorkspaceRoot: () => string;
	middlewareRegistrar: MiddlewareRegistrar;
	options: BootOptions;
	readRecentSessionEntriesForContract: {
		(sessionId: string): SessionEntry[];
		(sessionId: string | undefined): SessionEntry[] | null;
	};
	resolveEffectiveAutonomy: () => AutonomyLevel;
	restoreResumedRoute: SessionSettingsView["restoreResumedRoute"];
	runWatchdogReview: typeof runWatchdogReview;
	safety: SafetyContract;
	session: SessionContract | undefined;
	taskBoard: TaskBoardStore;
	telemetry: TelemetryContract;
	termination: ReturnType<typeof getTerminationCoordinator>;
	unattendedYolo: () => boolean;
	userTasks: UserTasksStore;
	cells: BootTurnHooksCells;
}

/**
 * Stage P11: the resumed route and usage reseed, the turn outcome collector, and the middleware registrations every
 * turn runs through (claims, nudges, turn control, headless verify credits, citation grounding).
 */
export function registerBootTurnHooks(input: BootTurnHooksInput) {
	const {
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
	} = input;
	const { cells } = input;
	// Every later resume (/resume, ACP session/load) goes through the session
	// domain, which announces it synchronously before the caller replays the
	// transcript. A `/tree` branch switch is a different event and keeps the
	// route the operator is on.
	const unsubscribeResumedRoute = bus.subscribe("session.reattached", (payload) => {
		const event = payload as { sessionId?: unknown; via?: unknown } | null | undefined;
		if (event?.via !== "resume" || session?.current()?.id !== event.sessionId) return;
		const notice = restoreResumedRoute();
		if (notice === null) return;
		if (interactive && cells.deferredWatchdogNoticeSink) {
			cells.deferredWatchdogNoticeSink(notice);
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
		getTurnConstraints: () => cells.chat.currentTurnConstraints?.(),
		finishedDetachedBatchIds: () => finishedDetachedBatchIds(dispatch),
		emitNotice: (text) => {
			if (cells.deferredWatchdogNoticeSink) cells.deferredWatchdogNoticeSink(text);
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
					...(cells.deferredWatchdogNoticeSink ? { emitNotice: cells.deferredWatchdogNoticeSink } : {}),
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
				getTurnConstraints: () => cells.chat.currentTurnConstraints?.(),
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
				canAsk: () => cells.askUserHandler !== null,
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
					const ledger = cells.chat.contextLedger();
					return ledger.contextWindow > 0 ? ledger.usedTokens / ledger.contextWindow : null;
				},
			}),
		);
	}
	return {
		headlessGitHelpers,
		readCurrentSessionEntries,
		seedOutcomeFromSession,
		taskEstablished,
		turnControl,
		turnOutcomeCollector,
		turnHookState: {
			get creditedRunChecks() {
				return creditedRunChecks;
			},
			get declaredCompletionFacts() {
				return declaredCompletionFacts;
			},
			get outcomeSessionId() {
				return outcomeSessionId;
			},
		},
	};
}
