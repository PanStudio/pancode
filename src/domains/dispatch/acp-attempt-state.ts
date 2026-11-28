// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { AcpDelegationRunHandle } from "../../acp/adapter.js";
import type { admitAcpDelegation } from "./acp-attempt-admit.js";
import type { openAcpRun } from "./acp-attempt-run.js";
import type { spawnAcpPeer } from "./acp-attempt-spawn.js";
import type { DispatchAdmissionObserver, DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import type { ResolvedTerminalReason } from "./outcome.js";
import type { RouteDecisionV1 } from "./route-decision.js";
import type { detectRunIdentity } from "./run-identity.js";
import type { RunTelemetryJournal } from "./run-telemetry.js";
import type { RunEnvelope, RunLineage, RunOutcomeCode, RunPhaseMarks, RunResult } from "./types.js";

/**
 * One ACP delegation, built phase by phase in dispatchAcpDelegation
 * (bundle-acp.ts). Same shape as NativeAttemptState: mutable state here, the
 * values each phase settles added by the stage types below.
 */
export interface AcpDelegationState {
	req: DispatchRequest;
	timing: RunPhaseMarks;
	routeDecision: RouteDecisionV1;
	observer: DispatchAdmissionObserver | undefined;
	hostRun: DispatchPreparationOptions["hostRun"] | undefined;
	runJournal: RunTelemetryJournal | undefined;
	resolvedTerminal: ResolvedTerminalReason | undefined;
	acp: AcpDelegationRunHandle;
	peerQuestionsOpen: number;
	toolTelemetryIngestionErrors: number;
	finishContractAssistantText: string;
	finishContractAssistantTurnId: string | null;
	failureMessage: string | undefined;
	outcomeCode: RunOutcomeCode | null;
	runIdForPermissionAudit: string | null;
	steeringProvenanceClosed: boolean;
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

export type AdmittedDelegation = AcpDelegationState & Awaited<ReturnType<typeof admitAcpDelegation>>;

export type SpawnedDelegation = AdmittedDelegation & Awaited<ReturnType<typeof spawnAcpPeer>>;

export type RunningDelegation = SpawnedDelegation & Awaited<ReturnType<typeof openAcpRun>>;
