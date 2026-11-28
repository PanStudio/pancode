// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { CheckoutSnapshot } from "../../tools/checkout-changes.js";
import type { TaskWorktreeOverlay } from "../../tools/task-worktree-overlay.js";
import type { TaskWorktreePreview } from "../../tools/task-worktree-preview.js";
import type { WorkerHookResultFrame } from "../../worker/protocol.js";
import type { FlowRestrictionSet } from "../safety/information-flow.js";
import type { TelemetrySessionLease } from "../telemetry/session-journals.js";
import type { AgentLedgerAttribution } from "./agent-ledger-store.js";
import type { admitAttemptRoute, openAttemptAdmission } from "./attempt-admit.js";
import type { createAttemptFold } from "./attempt-fold.js";
import type { gradeAttemptResult } from "./attempt-grade.js";
import type { landAttemptWorktree } from "./attempt-land.js";
import type { prepareAttemptWorker } from "./attempt-prepare.js";
import type { createAttemptReceiptDraft } from "./attempt-receipt.js";
import type { openAttemptRun } from "./attempt-run.js";
import type { spawnAttemptWorker } from "./attempt-spawn.js";
import type { verifyAttemptOnHost } from "./attempt-verify.js";
import type { ProbeClaim } from "./bundle-types.js";
import type {
	DispatchAdmissionObserver,
	DispatchPrefixGroup,
	DispatchPreparationOptions,
	DispatchRequest,
} from "./contract.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import type { FleetChangeImport, FleetChangeReturn } from "./fleet-change-return.js";
import type { GradeVerdict } from "./grading.js";
import type { BatchVerificationGate } from "./host-verification.js";
import type { ResolvedTerminalReason } from "./outcome.js";
import type { RouteObservationHandle } from "./route-observer.js";
import type { detectRunIdentity } from "./run-identity.js";
import type { RunTelemetryJournal } from "./run-telemetry.js";
import type { InFlightCall } from "./tool-stats.js";
import type {
	RunEnvelope,
	RunLineage,
	RunOutcome,
	RunOutcomeCode,
	RunResult,
	RunResultContractFact,
	RunResultDraft,
} from "./types.js";
import type { SpawnedWorker, WorkerSpec } from "./worker-spawn.js";

/**
 * One native dispatch attempt, built phase by phase in admitDispatchAttempt
 * (bundle-attempt.ts). The interface holds the attempt's mutable state: the
 * fields closures from several phases read and write. Each phase returns the
 * values it settles, and the stage types below add them to the record, so a
 * phase only ever reads fields an earlier phase set.
 */
export interface NativeAttemptState {
	req: DispatchRequest;
	probeClaims: ProbeClaim[];
	observer: DispatchAdmissionObserver | undefined;
	preparation: DispatchPreparationOptions | undefined;
	settlement: BatchVerificationGate | undefined;
	activeRouteObservation: RouteObservationHandle | null;
	routeObservation: RouteObservationHandle;
	remoteReturn: FleetChangeReturn | undefined;
	remoteImport: FleetChangeImport | undefined;
	specAutonomySettings: EffectiveSettings | undefined;
	escalationDeniedBy: "operator" | "main agent" | "safety judge" | undefined;
	spec: WorkerSpec;
	buildSpec: () => WorkerSpec;
	agentLedgerAttribution: AgentLedgerAttribution | null;
	unsubscribeAgentLedger: (() => void) | null;
	answerHook: ((frame: WorkerHookResultFrame) => boolean) | undefined;
	checkoutBaseline: CheckoutSnapshot | null;
	worker: SpawnedWorker;
	heldFollower: boolean;
	onFollowerStarted: ((started: SpawnedWorker) => void) | null;
	followerWorker: SpawnedWorker | null;
	subscribeHeldBoard: (() => void) | null;
	peerOverlay: TaskWorktreeOverlay | null;
	runJournal: RunTelemetryJournal | undefined;
	parentJournal: TelemetrySessionLease | undefined;
	resolvedTerminal: ResolvedTerminalReason | undefined;
	prefixLeader: DispatchPrefixGroup | undefined;
	sendToWorker: ((value: unknown) => boolean) | undefined;
	callsAtAbort: InFlightCall[] | null;
	toolTelemetryIngestionErrors: number;
	startsCarryIds: boolean;
	runIdForPermissionAudit: string | null;
	finishContractAssistantText: string;
	finishContractAssistantTurnId: string | null;
	failureMessage: string | undefined;
	permissionDenialDetail: string | null;
	refusalLimit: "reached" | "reported" | null;
	providerErrorMessage: string | null;
	externalTelemetry: RunResultDraft["externalTelemetry"];
	outcomeCode: RunOutcomeCode | null;
	reportedRepairRounds: number | undefined;
	trustedFlow: FlowRestrictionSet | null;
	reportedUntrustedOutcome: boolean;
	workerPolicyPermissionCounter: number;
	envelope: RunEnvelope;
	runningRowPersisted: Promise<void>;
	lineage: RunLineage;
	identity: ReturnType<typeof detectRunIdentity>;
	resolveFinal: (receipt: RunResult) => void;
	rejectFinal: (error: unknown) => void;
	targetOutcomeRecorded?: boolean;
	terminalEventEmitted?: boolean;
	assignmentCompleted?: boolean;
}

export type OpenedAttempt = NativeAttemptState & ReturnType<typeof openAttemptAdmission>;

export type AdmittedAttempt = OpenedAttempt & Awaited<ReturnType<typeof admitAttemptRoute>>;

export type PreparedAttempt = AdmittedAttempt & Awaited<ReturnType<typeof prepareAttemptWorker>>;

export type SpawnedAttempt = PreparedAttempt & Awaited<ReturnType<typeof spawnAttemptWorker>>;

export type FoldingAttempt = SpawnedAttempt & ReturnType<typeof createAttemptFold>;

export type RunningAttempt = FoldingAttempt & Awaited<ReturnType<typeof openAttemptRun>>;

export type FinalizingAttempt = RunningAttempt & ReturnType<typeof createAttemptReceiptDraft>;

/** The settlement of a native attempt after its worker exits: grade, host verification, landing, seal. */
export interface AttemptSettlementState {
	graded: GradeVerdict;
	finalOutcome: RunOutcome;
	finalDetail: string | null;
	sealedResultContractFact: RunResultContractFact | null;
	hypothesisBindings: ReadonlyMap<string, ReadonlyArray<string>> | undefined;
	worktreeReceipt: RunResultDraft["worktree"];
	worktreeDiscarded: boolean;
	accounted: TaskWorktreePreview | undefined;
	claimReleased: boolean;
	landingFailure: { code: RunOutcomeCode | null; detail: string } | null;
	operatorMerged: boolean;
}

export type GradedSettlement = AttemptSettlementState & Awaited<ReturnType<typeof gradeAttemptResult>>;

export type VerifiedSettlement = GradedSettlement & Awaited<ReturnType<typeof verifyAttemptOnHost>>;

export type LandedSettlement = VerifiedSettlement & Awaited<ReturnType<typeof landAttemptWorktree>>;
