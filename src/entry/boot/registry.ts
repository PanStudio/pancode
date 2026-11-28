// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { AcpInterviewChannel } from "../../acp/server-options.js";
import type { PancodeSettings } from "../../core/config.js";
import { setCommitDecisionRefsProvider } from "../../core/git-commit-attribution.js";
import { sandboxAvailability } from "../../core/sandbox/availability.js";
import {
	mainShellContained,
	mainShellSandboxSettings,
	yoloScriptSandboxState,
} from "../../core/sandbox/main-session.js";
import { emitApproval } from "../../core/telemetry/approvals.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import { pancodeStateDir } from "../../core/xdg.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import type { MiddlewareContract } from "../../domains/middleware/contract.js";
import type { MiddlewareToolChoiceControl } from "../../domains/middleware/tool-choice-control.js";
import type { MuxContract } from "../../domains/mux/contract.js";
import { reportWiring } from "../../domains/report/wiring.js";
import { type AutonomyWindow, describeOpenDecision } from "../../domains/safety/autonomy-window.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import type { EscapeScopeLedger } from "../../domains/safety/escape-scope.js";
import type { GitHookDriftGuard } from "../../domains/safety/hook-drift.js";
import {
	type FlowRestrictionSet,
	flowUnmediatedAgentRefusal,
	isFlowRestrictionSet,
} from "../../domains/safety/index.js";
import { createStandingChecks } from "../../domains/safety/observed-checks.js";
import type { ProtectedArtifactsRegistration } from "../../domains/safety/protected-artifacts-registration.js";
import type { SafetyJudgeSeat } from "../../domains/safety/safety-judge.js";
import type { SessionCodeConsent } from "../../domains/safety/session-code-consent.js";
import type { SessionContract } from "../../domains/session/contract.js";
import { activeDecisionRefs, createDecisionBoardStore } from "../../domains/session/decision-board.js";
import type { SessionEntry } from "../../domains/session/entries.js";
import { foldDispatchSkillActivations } from "../../domains/session/skill-activation-recording.js";
import { createTaskBoardStore } from "../../domains/session/task-board.js";
import { createUserTasksStore } from "../../domains/user-tasks/store.js";
import {
	createWorkspaceSnapshots,
	pruneWorkspaceSnapshots,
	workspaceSnapshotRepositoryPresent,
} from "../../domains/workspace-snapshots/index.js";
import type { createLoopGuardRegistration } from "../../engine/loop-guard.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import { type AskUserHandler, cancelledAskUserResult } from "../../tools/ask-user.js";
import type { ToolBootstrapHandle } from "../../tools/bootstrap.js";
import { createDispatchBackgroundRegistry } from "../../tools/dispatch-background.js";
import { acpHostReadOnlySource } from "../../tools/registry/verdicts.js";
import { createRegistry } from "../../tools/registry.js";
import type { BootOptions } from "../boot-options.js";
import type { createFlowLedger } from "../flow-ledger.js";

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootRegistryCells {
	readonly getCurrentSettings: () => PancodeSettings;
	readonly toolBootstrap: ToolBootstrapHandle;
}

/** What buildBootRegistry reads from the names bootOrchestrator built before it. */
export interface BootRegistryInput {
	acpInterviewChannel: AcpInterviewChannel | undefined;
	acpMode: boolean;
	activePathEntries: () => readonly SessionEntry[];
	autonomyWindow: AutonomyWindow;
	bus: TelemetryHub;
	dispatch: DispatchContract;
	flowLedger: ReturnType<typeof createFlowLedger>;
	flowPort: {
		carried: () => FlowRestrictionSet | null;
		refusal: () => string | null;
		absorb: (set: FlowRestrictionSet, origin: { tool?: string; toolCallId?: string }) => void;
	};
	hookDrift: GitHookDriftGuard;
	loopGuard: ReturnType<typeof createLoopGuardRegistration>;
	middleware: MiddlewareContract;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	mux: MuxContract | undefined;
	operatorReturned: () => void;
	options: BootOptions;
	protectedArtifactsGuard: ProtectedArtifactsRegistration;
	resolveAdmissionAutonomy: () => AutonomyLevel;
	resolveEffectiveAutonomy: () => AutonomyLevel;
	safety: SafetyContract;
	safetyJudge: SafetyJudgeSeat & { escapeScopes: EscapeScopeLedger };
	session: SessionContract | undefined;
	sessionCodeConsent: SessionCodeConsent;
	unattendedYolo: () => boolean;
	withPanes: typeof import("../with-panes.js") | null;
	cells: BootRegistryCells;
}

/**
 * Stage P8: the main tool registry and its permission bridge, the ask_user and report seams, the task and decision
 * boards with their run links, dispatch backgrounding, and the panes runtime.
 */
export function buildBootRegistry(stageInput: BootRegistryInput) {
	const {
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
	} = stageInput;
	const { cells } = stageInput;
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
		scratchRoots: () => cells.getCurrentSettings().safety.scratchRoots,
		scriptSandbox: () => yoloScriptSandboxState(cells.getCurrentSettings().safety.sandbox, sandboxAvailability()),
		containment: () => {
			const safety = cells.getCurrentSettings().safety;
			const availability = sandboxAvailability();
			const sandbox = mainShellContained(safety.sandbox, availability);
			return {
				sandbox,
				snapshots: safety.snapshots !== "off" && workspaceSnapshotRepositoryPresent(process.cwd()),
				readOnlySandbox: sandbox && availability.backend === "bwrap",
			};
		},
		currentSessionId: () => session?.current()?.id,
		...mainShellSandboxSettings(() => cells.getCurrentSettings()),
		mutationEpoch: (turnId) => loopGuard.mutationEpoch(turnId),
		flow: {
			...flowPort,
			// The gateway is registered after this registry; the lookup runs at call time.
			mcpTransport: (tool) => cells.toolBootstrap.mcpCapabilities?.transportOf(tool) ?? null,
		},
		sessionCodeConsent,
		escapeScopes: safetyJudge.escapeScopes,
		safetyJudge,
		hookDrift,
		// Recoverability for the main agent on every surface; workers never snapshot.
		workspaceSnapshot: async ({ sessionId: requested, ...request }) => {
			if (cells.getCurrentSettings().safety.snapshots === "off") return null;
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
		identitySettings: () => ({ targets: cells.getCurrentSettings().targets }),
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
			standingChecks(activePathEntries(), boardId, taskId, process.cwd(), cells.getCurrentSettings().safety.scratchRoots, [
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
					getSettings: () => cells.getCurrentSettings(),
					getDispatchSnapshot: () => dispatch.snapshot(),
					agentRefusal: () => flowUnmediatedAgentRefusal(flowLedger.policy(), null),
					getCwd: () => process.cwd(),
				})
			: null;
	return {
		askUserBridge,
		decisionBoard,
		dispatchBackground,
		panes,
		reportSession,
		taskBoard,
		toolRegistry,
		userTasks,
		registryState: {
			get askUserHandler() {
				return askUserHandler;
			},
			set askUserHandler(value: typeof askUserHandler) {
				askUserHandler = value;
			},
			get reportReviewOpener() {
				return reportReviewOpener;
			},
			set reportReviewOpener(value: typeof reportReviewOpener) {
				reportReviewOpener = value;
			},
		},
	};
}
