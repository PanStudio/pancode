// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The one fleet-run execution path.
 *
 * A compiled fleet plan is driven here and nowhere else, so every surface that
 * starts a fleet gets identical admission, autonomy, receipts, gate decisions,
 * write-boundary enforcement, and durable ledger rows. The operator surface
 * that calls it owns presentation only: this module writes nothing to stdout
 * and reports progress through callbacks.
 *
 * Everything the run needs is passed in. The module resolves no playbook by
 * itself, loads no domain, and reads no configuration, which is what lets a
 * headless CLI invocation and an interactive approval share it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attributeCommitMessage } from "../../core/commit-attribution.js";
import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { gitCommitAuthorSetting, resolvePancodeCommitAuthorship } from "../../core/git-commit-attribution.js";
import { sha256Hex } from "../../core/hash.js";
import { telemetryContext } from "../../core/telemetry/context.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { telemetryJournalPath, telemetryRunDirectory } from "../../core/telemetry/paths.js";
import { sumPricing, sumRunSpend, sumRunTokens } from "../../core/telemetry/pricing.js";
import { renderPricing } from "../../core/telemetry/render.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { gitCheckoutRoot } from "../../tools/task-worktree.js";
import { mutationReportPaths, resultContractAuthorship } from "../agents/result-contract-builder-report.js";
import { activeDecisionRefs } from "../session/decision-board.js";
import { claimAssignmentVerdict, recordAssignmentAttempt, settleStoredAssignment } from "./assignment-store.js";
import { fleetAdmissionRefusal } from "./capacity-lease.js";
import {
	type CodeStepRunInput,
	codeStepDir,
	commitPointSnapshot,
	newCodeRunId,
	preflightCodeStep,
	readCommitBaseline,
	runCodeStep,
	workspaceChangedPaths,
	workspaceChangeSnapshot,
	writeCommitBaseline,
} from "./code-step.js";
import type { DispatchPlanTaskResolution, DispatchRequest } from "./contract.js";
import { buildDelegationProposalBriefing, validateDelegationPlan } from "./delegation-plan.js";
import {
	type ExecutionPlanCodeStep,
	type ExecutionPlanStep,
	executionPlanAncestors,
	executionPlanIdentityHash,
	executionPlanWaves,
	spliceExecutionPlan,
} from "./execution-plan.js";
import { gateAuthorContractKind, requestRunRole, withRunRole } from "./execution-role.js";
import {
	type ExecutionPlanResult,
	type ExecutionSchedulerAdapter,
	type ExecutionStepResult,
	executePlan,
} from "./execution-scheduler.js";
import { changedCheckFiles, deriveFleetCommitAttribution, isVacuousCheckArgv } from "./fleet-commit-attribution.js";
import { createFleetEventJournal, type FleetEventJournal, fleetStepEntryDigest } from "./fleet-event-journal.js";
import { gateBaselineFailure, gateFailureLines, loopGateNotice } from "./fleet-gate.js";
import type {
	ExecuteFleetRunInput,
	FleetRunOutcome,
	FleetRunStepEvent,
	FleetRunStepOutcome,
} from "./fleet-run-types.js";
import {
	codeStepSettledFacts,
	fleetGateCorrelation,
	fleetPlanWaveIndex,
	fleetStepIntent,
	replayedStepRun,
	type StepRun,
	stepRunOf,
} from "./fleet-step-run.js";
import { keepFleetTaskWorktree, openFleetTaskWorktree } from "./fleet-task-worktree.js";
import { decideReviewGate, materializePendingGateDecision, stagePendingGateDecision } from "./gate-decisions.js";
import { hostVerificationSandbox } from "./host-verification.js";
import { type FleetRootTelemetry, openFleetRootTelemetry } from "./run-telemetry.js";
import { type FleetRunRecord, writeFleetRun, writeFleetRunSync } from "./state.js";
import type { RunResult } from "./types.js";
import { captureWorkspaceCheckpoint, workspaceCheckpointRef } from "./workspace-checkpoint.js";
import type { WriteBoundaryAttribution } from "./write-boundary.js";
import { createWriteBoundaryEnforcer } from "./write-boundary-enforcer.js";
import { joinWriterSet } from "./writer-set.js";

/** Owner id for a plan with no model runs; it holds nothing to release. */
const NO_WORKER_RESERVATION = "fleet-no-worker-reservation";

/**
 * Run a compiled fleet plan to completion.
 *
 * The caller has already compiled the plan, resolved every agent, and passed
 * preflight; this drives the scheduler and seals the durable artifacts. It
 * throws only when the scheduler itself cannot proceed, so a red step is a
 * result rather than an exception.
 */
export async function executeFleetRun(input: ExecuteFleetRunInput): Promise<FleetRunOutcome> {
	// A drained gate refuses the run before the task worktree, the writer set or the root record exists.
	const refusal = fleetAdmissionRefusal();
	if (refusal !== null) throw new Error(refusal);
	if (input.plan.isolation !== "worktree") return executeFleetRunIn(input, { root: input.workspaceRoot });
	// A `worktree` playbook runs every step in one task worktree and never writes the operator's checkout.
	const worktree = openFleetTaskWorktree({
		workspaceRoot: input.workspaceRoot,
		fleetRootId: input.fleetRootId,
		...(input.resume !== undefined ? { resumeWorktree: input.resume.record.worktree ?? input.resume.record.id } : {}),
		...(input.settings?.fleet?.worktrees !== undefined
			? { worktreeRootSetting: input.settings.fleet.worktrees.root }
			: {}),
		remoteEligible: (input.settings?.fleet?.nodes?.length ?? 0) > 0,
		onNotice: (text) => input.onNotice?.(text),
	});
	try {
		return await executeFleetRunIn(input, { root: worktree.path, taskWorktree: worktree.runId });
	} finally {
		const kept = keepFleetTaskWorktree(
			worktree,
			{ fleetRootId: input.fleetRootId, playbookName: input.playbookName },
			(text) => input.onNotice?.(text),
		);
		if (kept !== null) input.onWorktreeKept?.(kept);
	}
}

/** Where a run executes: the checkout it was started in, or its task worktree. */
interface FleetRunPlace {
	root: string;
	/** Run id of the task worktree `root` is, recorded so a resume continues there. */
	taskWorktree?: string;
}

async function executeFleetRunIn(input: ExecuteFleetRunInput, place: FleetRunPlace): Promise<FleetRunOutcome> {
	// Taken before the root claims its verdict or writes a record, so a refused
	// run leaves no durable trace and its minted id never reads as a real root.
	// A fleet holds the checkout's writer set for its whole run; another fleet or another process's writer there queues
	// it until the fleet run wall clock passes (DESIGN 4.5).
	const lease = await joinWriterSet({
		checkout: gitCheckoutRoot(place.root) ?? place.root,
		member: {
			group: input.fleetRootId,
			roots: null,
			isolated: false,
			agentId: "fleet",
			runId: input.fleetRootId,
			fleet: true,
		},
		deadlineAt: Date.now() + (input.settings?.fleet ?? DEFAULT_SETTINGS.fleet).limits.runTimeoutMs,
		...(input.signal !== undefined ? { signal: input.signal } : {}),
		onQueued: (waitingOn) =>
			input.onNotice?.(`fleet ${input.fleetRootId} queued behind ${waitingOn}; it starts when that settles`),
	});
	let emergencySeal = (): void => {};
	const unregisterEmergency = input.registerEmergencySeal?.(() => {
		try {
			emergencySeal();
		} catch {
			/* Forced shutdown persistence is best effort. */
		}
		try {
			lease.release();
		} catch {
			/* A dead owner can be reclaimed on the next run. */
		}
	});
	let rootTelemetry: FleetRootTelemetry | undefined;
	try {
		try {
			rootTelemetry = await openFleetRootTelemetry(
				input.fleetRootId,
				telemetryContext()?.sessionId ?? null,
				telemetryRunDirectory(pancodeStateDir(), input.fleetRootId),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`fleet root telemetry journal unavailable: ${message}`, { cause: error });
		}
		return await runFleetHoldingWorkspace(
			input,
			place,
			(seal) => {
				emergencySeal = seal;
			},
			rootTelemetry,
		);
	} finally {
		// The root's seal failing fails the fleet run, after its workspace lock is released (#434).
		try {
			await rootTelemetry?.close();
		} finally {
			try {
				lease.release();
			} catch (error) {
				// The record names this live process, so other processes queue behind
				// it until it exits; say so rather than let the leftover look like a hang.
				const message = error instanceof Error ? error.message : String(error);
				input.onNotice?.(`could not release the checkout's writer set: ${message}`);
			}
			unregisterEmergency?.();
		}
	}
}

/**
 * A fleet's own word on its ledger row. A settle that cannot be written leaves
 * the row `running`, which startup reconciliation resolves to failed, so a lost
 * write never becomes a false success. The event journal lands first, so a
 * settled fleet's journal is on disk through its seal.
 */
async function settleFleetAssignment(
	events: FleetEventJournal,
	fleetRootId: string,
	record: FleetRunRecord,
	cleanRun: boolean,
): Promise<unknown> {
	await events.flush();
	return settleStoredAssignment(
		fleetRootId,
		record.steps.at(-1)?.result.terminalRunId ?? fleetRootId,
		cleanRun ? "succeeded" : "failed",
		"fleet",
	).catch(() => undefined);
}

/** The live plan's steps that ran, out of those it planned, and the ones that never ran nor were found unneeded. */
function stepCoverage(
	steps: ReadonlyArray<{ id: string }>,
	result: { results: ReadonlyMap<string, unknown>; unneeded: ReadonlyArray<string> },
): Pick<FleetRunOutcome, "notRunStepIds" | "plannedStepCount" | "ranStepCount"> {
	return {
		notRunStepIds: steps
			.filter((step) => !result.results.has(step.id) && !result.unneeded.includes(step.id))
			.map((step) => step.id),
		plannedStepCount: steps.length,
		ranStepCount: steps.filter((step) => result.results.has(step.id)).length,
	};
}
async function runFleetHoldingWorkspace(
	input: ExecuteFleetRunInput,
	place: FleetRunPlace,
	setEmergencySeal: (seal: () => void) => void,
	rootTelemetry: FleetRootTelemetry,
): Promise<FleetRunOutcome> {
	const { dispatch, agents, fleetRootId } = input;
	// Every step, check, commit and boundary snapshot works here; the record keeps the checkout the run started in.
	const workspaceRoot = place.root;
	/** A start the admission check canceled throws the abort reason, so the plan stops the way a signal stops it. */
	const refuseCanceledAdmission = (): void => {
		if (input.beforeStepAdmission === undefined) return;
		input.beforeStepAdmission();
		if (input.signal?.aborted === true) throw input.signal.reason;
	};
	const decisionRefs = activeDecisionRefs(input.getDecisionBoard?.() ?? []);
	let livePlan = input.plan;
	const replayed = input.resume?.replayed ?? new Map<string, ExecutionStepResult>();
	const notice = (text: string, kind?: "gate" | "write-boundary"): void => input.onNotice?.(text, kind);
	const fleetRunRecord: FleetRunRecord = {
		version: 1,
		id: fleetRootId,
		cwd: input.workspaceRoot,
		fleet: input.playbookName,
		planHash: livePlan.hash,
		planIdentityHash: executionPlanIdentityHash(livePlan),
		stepIds: livePlan.steps.map((step) => step.id),
		planSteps: livePlan.steps.map((step) => structuredClone(step)),
		vars: { ...(input.vars ?? {}) },
		startedAt: new Date().toISOString(),
		endedAt: null,
		resumedFrom: input.resume?.record.id ?? null,
		...(place.taskWorktree !== undefined ? { worktree: place.taskWorktree } : {}),
		steps: [...replayed].map(([stepId, result]) => ({ stepId, result })),
	};
	// Every step of this run dispatches under `fleetRootId` as its lineage root,
	// so every agent step also settles the assignment row of that id. One step is
	// not the run, and letting the last one to finish write the row reported a
	// green step of a run that aborted at step 2 of 7 as `succeeded`. The run
	// claims the verdict here and answers for itself at the end. The claim comes
	// before the root record exists, so a record whose owner is not alive is a
	// run that will never append to its journal (`fleet events --follow`).
	await claimAssignmentVerdict(fleetRootId, "fleet");
	// The digest of the last root record bytes this run wrote, which the final
	// journal line names.
	let sealed = false;
	let manifestDigest = sha256Hex(await writeFleetRun(fleetRunRecord));
	const writeManifest = async (): Promise<string> => {
		if (sealed) return manifestDigest;
		const digest = sha256Hex(await writeFleetRun(fleetRunRecord));
		manifestDigest = digest;
		return digest;
	};
	const events = createFleetEventJournal(fleetRootId);
	// A code step's record is its `code_step.settled` in this root's journal (#434).
	const rootJournalPath = telemetryJournalPath(telemetryRunDirectory(pancodeStateDir(), fleetRootId));
	const stepDispatched = (event: FleetRunStepEvent): void => {
		if (event.replayed !== true) {
			events.append({
				type: "step_dispatched",
				stepId: event.stepId,
				kind: event.kind,
				waveIndex: event.waveIndex,
				assignmentId: event.assignmentId,
				...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
				...(event.commandId !== undefined ? { commandId: event.commandId } : {}),
			});
		}
		input.onStepDispatched?.(event);
	};
	const sealEvents = (outcome: "succeeded" | "failed" | "aborted", forced = false): void => {
		if (sealed) return;
		sealed = true;
		events.append({
			type: "fleet_sealed",
			outcome,
			endedAt: fleetRunRecord.endedAt ?? new Date().toISOString(),
			stepCount: fleetRunRecord.steps.length,
			manifestDigest,
			...(forced ? { forced: true } : {}),
		});
	};
	setEmergencySeal(() => {
		if (sealed) return;
		try {
			fleetRunRecord.endedAt = new Date().toISOString();
			manifestDigest = sha256Hex(writeFleetRunSync(fleetRunRecord));
		} finally {
			sealEvents("aborted", true);
		}
	});
	/**
	 * Stamp the run's end and write the final record. A write that throws puts
	 * `endedAt` back, so the seal never names an end that no record on disk carries.
	 */
	const writeEndedManifest = async (): Promise<void> => {
		if (sealed) return;
		fleetRunRecord.endedAt = new Date().toISOString();
		try {
			await writeManifest();
		} catch (error) {
			fleetRunRecord.endedAt = null;
			throw error;
		}
	};
	/** File one step's terminal run id, whichever kind produced it. */
	const fileStepAttempt = (terminalRunId: string): Promise<unknown> =>
		recordAssignmentAttempt(fleetRootId, terminalRunId);
	const boundaryEnforcer = createWriteBoundaryEnforcer({
		root: workspaceRoot,
		rootId: fleetRootId,
		boundaryFor: (stepId) => livePlan.steps.find((step) => step.id === stepId)?.writes,
		recordedWritesFor: (stepId) => {
			const step = livePlan.steps.find((entry) => entry.id === stepId);
			// A code step runs a registered command in a subprocess. Nothing
			// enumerates what that command wrote, so the step contributes no record
			// and its window falls back to blaming the whole diff.
			if (step === undefined) return null;
			if (step.kind !== "agent") {
				return {
					recorded: [],
					complete: false,
					downgrades: [
						{
							reason: "code_step_untracked",
							tool: null,
							toolCallId: null,
							runId: null,
							stepId,
						},
					],
				} satisfies WriteBoundaryAttribution;
			}
			const receipt = receiptsByStep.get(stepId);
			if (receipt === undefined) return null;
			// A missing record keeps the reason the enforcer would have given it,
			// now naming the attempt rather than only the step.
			const unavailable = (runId: string): WriteBoundaryAttribution => ({
				recorded: [],
				complete: false,
				downgrades: [{ reason: "write_record_unavailable", tool: null, toolCallId: null, runId, stepId }],
			});
			const attempts = (attemptRunIdsByStep.get(stepId) ?? [receipt.runId]).map((runId): WriteBoundaryAttribution => {
				if (dispatch.observedRunWriteAttribution !== undefined) {
					return dispatch.observedRunWriteAttribution(runId) ?? unavailable(runId);
				}
				const recorded = dispatch.observedRunWrites?.(runId) ?? null;
				return recorded === null ? unavailable(runId) : { recorded, complete: true, downgrades: [] };
			});
			return {
				recorded: [...new Set(attempts.flatMap((attempt) => attempt.recorded))],
				complete: attempts.every((attempt) => attempt.complete),
				downgrades: attempts.flatMap((attempt) => attempt.downgrades ?? []),
			};
		},
		onVerdict(verdict, path) {
			// Concurrent changes are reported too. The window did not fail for them
			// and nothing was touched, and an operator whose file changed under a
			// running fleet should hear it from the fleet.
			if (verdict.detail === null) return;
			notice(`write boundary ${verdict.window}: ${verdict.detail} record=${path}`, "write-boundary");
		},
	});
	// A step's verdict is the result the scheduler records, never the run's own:
	// a run can pass and its step still fail (a write-boundary rollback, a
	// cancellation). What the operator hears waits for that record and reads
	// its verdict from the recorded entry, as the events journal does.
	const unrecordedSettles = new Map<
		string,
		{ outcome: FleetRunStepOutcome; announce: (outcome: FleetRunStepOutcome) => void }
	>();
	const announceSettled = (
		step: ExecutionPlanStep,
		outcome: FleetRunStepOutcome,
		announce: (outcome: FleetRunStepOutcome) => void,
	): void => {
		unrecordedSettles.set(step.id, { outcome, announce });
	};
	const receipts: RunResult[] = [];
	const receiptsByStep = new Map<string, StepRun>();
	// Paths a workspace code step created or edited, so a later loop check runs
	// a test it generated exactly as it runs an agent ancestor's changed tests.
	// Null marks a step whose changes could not be measured (no git status).
	const codeChangedPathsByStep = new Map<string, ReadonlyArray<string> | null>();
	const attemptRunIdsByStep = new Map<string, ReadonlyArray<string>>();
	const memberReceipts = async (runId: string, firstReceipt: RunResult) =>
		dispatch.waitForMember ? dispatch.waitForMember(runId) : { receipt: firstReceipt, receipts: [firstReceipt] };
	const recordMemberReceipts = async (
		member: { receipt: RunResult; receipts: ReadonlyArray<RunResult> },
		stepId?: string,
	): Promise<RunResult> => {
		if (stepId !== undefined) {
			const runIds = member.receipts.map((receipt) => receipt.runId);
			attemptRunIdsByStep.set(stepId, runIds);
		}
		// #231 requires the fleet to pay for every attempt while only the final
		// receipt determines the step's verdict and evidence handed to dependents.
		for (const receipt of member.receipts) {
			receipts.push(receipt);
			await fileStepAttempt(receipt.runId);
		}
		return member.receipt;
	};
	const collectMemberReceipts = async (runId: string, firstReceipt: RunResult, stepId?: string) =>
		recordMemberReceipts(await memberReceipts(runId, firstReceipt), stepId);
	// A replayed step is announced after the run's own start, so a stream reads fleet_started before any step line.
	const replayAnnouncements: Array<() => void> = [];
	for (const [stepId, replayedResult] of replayed) {
		try {
			const run = replayedStepRun(replayedResult.terminalRunId, replayedResult.runDigest);
			if (run !== null) receiptsByStep.set(stepId, run);
		} catch {
			// Deterministic results and runs whose scope cannot be read carry no run projection.
		}
		const step = livePlan.steps.find((entry) => entry.id === stepId);
		if (step === undefined) continue;
		const event: FleetRunStepEvent = {
			stepId,
			kind: step.kind,
			waveIndex: fleetPlanWaveIndex(livePlan, stepId),
			assignmentId: replayedResult.assignmentId,
			...(step.kind === "agent" ? { agentId: step.agentId } : { commandId: step.commandId }),
			replayed: true,
		};
		// A replay whose run cannot be read back has no cost claim at all: unknown, never a zero.
		const pricing =
			receiptsByStep.get(stepId)?.pricing ??
			sumPricing([{ usd: { kind: "unknown", reason: "not-observed" }, pricedBy: "none" }]);
		replayAnnouncements.push(() => {
			stepDispatched(event);
			input.onStepSettled?.({
				...event,
				succeeded: true,
				terminalRunId: replayedResult.terminalRunId,
				pricing,
				result: replayedResult,
			});
		});
		await fileStepAttempt(replayedResult.terminalRunId);
	}
	const planStep = (stepId: string) => livePlan.steps.find((entry) => entry.id === stepId);
	const proposalMembers = new Map<string, Array<{ memberId: string; request: DispatchRequest }>>();

	// Freshness is coordinator-owned execution state. Worker prose cannot set
	// either flag: a successful deterministic verification sets the first, and
	// an integrity-valid independent gate decision sets the second. Any later
	// workspace agent invalidates both before a commit may read them.
	let validationFresh = false;
	let independentReviewFresh = false;

	/**
	 * The commit message is the words of the agent that produced the work, and
	 * only that agent's. Candidates are consulted newest first; when none of
	 * them authored one, code writes a deterministic line rather than inventing
	 * a sentence or reusing somebody else's.
	 */
	const commitMessageFor = (
		step: ExecutionPlanCodeStep,
		priorResults: ReadonlyMap<string, { output: string }>,
	): string => {
		for (const candidate of step.commitFrom ?? []) {
			const source = planStep(candidate);
			const result = priorResults.get(candidate);
			if (source === undefined || source.kind !== "agent" || result === undefined) continue;
			const resultContract = agents.getSpec(source.agentId)?.resultContract ?? null;
			if (resultContract === null) continue;
			const authored = resultContractAuthorship(resultContract, result.output);
			if (authored.commitMessage !== null) return authored.commitMessage;
			if (authored.summary !== null) return `pancode(${fleetRootId}): ${authored.summary}`;
		}
		return `pancode(${fleetRootId}): ${input.playbookName} ${step.id}`;
	};

	// A required architect artifact goes in even when ignored: the playbook commits the plan before any code exists.
	const commitArtifactsFor = (
		step: ExecutionPlanCodeStep,
		priorResults: ReadonlyMap<string, { integrityValid: boolean }>,
	): string[] => {
		const artifacts = new Set<string>();
		for (const candidate of step.commitFrom ?? []) {
			const source = planStep(candidate);
			const result = priorResults.get(candidate);
			if (source === undefined || source.kind !== "agent" || result?.integrityValid !== true) continue;
			const contract = agents.getSpec(source.agentId)?.resultContract ?? null;
			if (contract?.kind === "architect-plan") artifacts.add(contract.path);
		}
		return [...artifacts];
	};
	const commitsWork = livePlan.steps.some((step) => step.kind === "code" && step.commitFrom !== undefined);
	let commitBaseline = !commitsWork
		? null
		: input.resume !== undefined
			? readCommitBaseline(codeStepDir(input.resume.record.id))
			: commitPointSnapshot(workspaceRoot);
	if (commitBaseline !== null) writeCommitBaseline(codeStepDir(fleetRootId), commitBaseline);

	// The journal opens only here, after the last await outside the scheduler's
	// try, so every path that writes fleet_started also reaches a seal.
	events.append({
		type: "fleet_started",
		fleet: fleetRunRecord.fleet,
		planHash: fleetRunRecord.planHash,
		vars: fleetRunRecord.vars,
		resumedFrom: fleetRunRecord.resumedFrom,
		replayedStepIds: [...replayed.keys()],
		workspaceRoot,
		stepIds: fleetRunRecord.stepIds,
	});
	let result: ExecutionPlanResult;
	// The run is started once its first whole-plan reservation is held; a splice reserves again and announces nothing.
	let announced = false;
	const reserved = (ownerId: string): { ownerId: string } => {
		if (!announced) {
			announced = true;
			input.onStarted?.();
			for (const announce of replayAnnouncements.splice(0)) announce();
		}
		return { ownerId };
	};
	try {
		const adapter: ExecutionSchedulerAdapter = {
			preflight(step) {
				// The fleet write boundary is deliberately enforced after the step. The enforcer in
				// write-boundary-enforcer.ts snapshots and verifies the step window. Pre-emptive
				// confinement for declared commands would require a command sandbox, which does not exist.
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					cwd: workspaceRoot,
					requestOrigin: "user",
					...(decisionRefs.length > 0 ? { decisionRefs } : {}),
					lineage: {
						parentRunId: input.resume?.record.id ?? fleetRootId,
						rootRunId: fleetRootId,
						attempt: 0,
						depth: 1,
					},
					...(step.scope === "readonly" ? { readOnly: true as const } : {}),
					...(step.target !== undefined ? { target: step.target } : {}),
					...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
				};
				const resolution = dispatch.preview?.(request);
				if (!resolution) throw new Error(`fleet preflight cannot resolve step '${step.id}'`);
				return { step, costUpperBoundUsd: resolution.costUpperBoundUsd, nodeId: resolution.node.id };
			},
			reserve(reservedPlan, admissions) {
				// A fleet of deterministic steps admits no worker and holds no
				// capacity. The reservation authority refuses an empty reservation,
				// correctly: there is nothing to reserve, so nothing is asked of it.
				if (admissions.length === 0) return reserved(NO_WORKER_RESERVATION);
				const tasks: Array<{ memberId: string; resolution: DispatchPlanTaskResolution }> = [];
				const memberIds = new Set(reservedPlan.steps.map((step) => step.id));
				for (const { step } of admissions) {
					const members: Array<{ memberId: string; request: DispatchRequest }> = [];
					if (step.plan?.proposals === true) {
						for (const [index, agentId] of step.plan.roster.entries()) {
							let memberId = `proposal:${step.id}:${index}`;
							while (memberIds.has(memberId)) memberId = `proposal:${memberId}`;
							memberIds.add(memberId);
							const request: DispatchRequest = withRunRole(
								{
									agentId,
									task: step.task,
									cwd: workspaceRoot,
									requestOrigin: "user",
									...(decisionRefs.length > 0 ? { decisionRefs } : {}),
									readOnly: true,
									lineage: { parentRunId: fleetRootId, rootRunId: fleetRootId, attempt: 0, depth: 1 },
									// A proposal is an explorer's prose, not a builder report.
									resultContractOverride: { kind: "text-report" },
									...(input.turnConstraints !== undefined ? { turnConstraints: input.turnConstraints } : {}),
									...(step.target !== undefined ? { target: step.target } : {}),
									...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
								},
								(id) => agents.getSpec(id),
							);
							const resolution = dispatch.preview?.(request);
							if (!resolution) throw new Error(`fleet preflight cannot resolve proposal '${memberId}'`);
							members.push({ memberId, request });
							tasks.push({ memberId, resolution });
						}
					}
					proposalMembers.set(step.id, members);
					tasks.push({
						memberId: step.id,
						resolution: dispatch.preview?.({
							agentId: step.agentId,
							executionRole: step.executionRole,
							task: step.task,
							...(decisionRefs.length > 0 ? { decisionRefs } : {}),
							...(step.target !== undefined ? { target: step.target } : {}),
							...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
						}) as DispatchPlanTaskResolution,
					});
				}
				const resolutions = new Map(tasks.map((task) => [task.memberId, task.resolution]));
				const concurrency = Math.min(reservedPlan.maxWorkers, dispatch.maxWorkers?.() ?? reservedPlan.maxWorkers);
				const waves = reservedPlan.waves.flatMap((wave) => {
					const members = wave.flatMap((stepId) => proposalMembers.get(stepId) ?? []);
					const proposalWaves =
						members.length === 0
							? []
							: executionPlanWaves(
									members.map(({ memberId }) => {
										const endpoint = resolutions.get(memberId)?.endpoint;
										return { id: memberId, dependencies: [], ...(endpoint ? { endpoint } : {}) };
									}),
									concurrency,
								);
					return [...proposalWaves, wave];
				});
				const reservation = dispatch.reservations?.prepare({
					topology: "parallel",
					tasks: tasks.map((task) => ({ ...task, wave: waves.findIndex((wave) => wave.includes(task.memberId)) })),
				});
				if (!reservation) throw new Error("fleet whole-plan reservation is unavailable");
				return reserved(reservation.ownerId);
			},
			async run(step, handoffs, reservation, ledger, signal) {
				refuseCanceledAdmission();
				// A loop repair is attempt n of the same logical work, so it enters
				// the run ledger as one: recovery evidence, not a fresh observation.
				const attempt = step.loop?.role === "repair" ? step.loop.attempt : 0;
				const parentReceipt = step.planParentId === undefined ? undefined : receiptsByStep.get(step.planParentId);
				if (step.planParentId !== undefined && parentReceipt === undefined) {
					throw new Error(`fleet dynamic step '${step.id}' has no terminal plan-step run`);
				}
				// The fleet write boundary is deliberately enforced after the step. The enforcer in
				// write-boundary-enforcer.ts snapshots and verifies the step window. Pre-emptive
				// confinement for declared commands would require a command sandbox, which does not exist.
				//
				// That enforcement split is exactly why a step's declared `writes:` reaches
				// typed intent as `relevant_paths` rather than as `write_roots`. The
				// playbook already said what this position may change and the enforcer
				// already holds it; restating it as intent write roots would mint a second
				// grant enforced at the per-tool worker seam, which refuses outright on the
				// subprocess and ACP runtimes a fleet may legitimately route a step to.
				// Carrying it as declared scope changes no authority and gets the
				// playbook's own paths into project-rule selection and worker context,
				// where prose tokens scraped from the rendered prompt were standing in for
				// a declaration the playbook had already made.
				const stepIntent = fleetStepIntent(step.writes);
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					cwd: workspaceRoot,
					...(stepIntent === null ? {} : { intent: stepIntent }),
					...(input.turnConstraints !== undefined ? { turnConstraints: input.turnConstraints } : {}),
					predecessorHandoffs: handoffs,
					requestOrigin: "user",
					...(decisionRefs.length > 0 ? { decisionRefs } : {}),
					lineage: {
						parentRunId: parentReceipt?.runId ?? input.resume?.record.id ?? fleetRootId,
						rootRunId: fleetRootId,
						attempt,
						depth: parentReceipt === undefined ? 1 : 2,
					},
					reservation,
					...(ledger !== undefined ? { ledger } : {}),
					...(step.loop?.role === "check"
						? {
								gate: {
									role: "reviewer" as const,
									group: `${fleetRootId}:${step.loop.loopId}`,
									cycle: step.loop.attempt,
									subjects: handoffs.map((handoff) => ({
										runId: handoff.terminalRunId,
										digest: handoff.runDigest,
									})),
								},
							}
						: {}),
					...(step.scope === "readonly" ? { readOnly: true as const } : {}),
					...(step.target !== undefined ? { target: step.target } : {}),
					...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
					...(step.plan !== undefined
						? { resultContractOverride: { kind: "delegation-plan" as const } }
						: step.gate !== undefined
							? { resultContractOverride: { kind: gateAuthorContractKind(step.executionRole) } }
							: {}),
				};
				if (step.plan?.proposals === true) {
					const members = await Promise.all(
						(proposalMembers.get(step.id) ?? []).map(async ({ memberId, request: proposalRequest }) => {
							try {
								// Each proposal owns capacity independently; hostRun preserves its published fleet lineage.
								const proposal = await dispatch.dispatch(
									{
										...proposalRequest,
										lineage: {
											parentRunId: fleetRootId,
											rootRunId: `${reservation.ownerId}:${memberId}`,
											attempt: 0,
											depth: 1,
										},
										reservation: { ownerId: reservation.ownerId, memberId },
									},
									undefined,
									{
										...(signal ? { signal } : {}),
										hostRun: {
											runId: fleetRootId,
											lineage: { parentRunId: null, rootRunId: fleetRootId, attempt: 0, depth: 0 },
										},
									},
								);
								const cancel = () => dispatch.abort(proposal.runId);
								signal?.addEventListener("abort", cancel, { once: true });
								if (signal?.aborted) cancel();
								void (async () => {
									for await (const _event of proposal.events) {
										/* Proposal events are drained while their final answers are collected. */
									}
								})().catch(() => {});
								try {
									const member = await memberReceipts(proposal.runId, await proposal.finalPromise);
									return { agent: proposalRequest.agentId, member };
								} finally {
									try {
										await dispatch.drainMember?.(proposal.runId);
									} finally {
										signal?.removeEventListener("abort", cancel);
									}
								}
							} catch {
								// A proposal is advisory; admission or worker failure must not cancel its siblings.
								return { agent: proposalRequest.agentId, member: null };
							}
						}),
					);
					const proposals: Array<{ agent: string; output: string }> = [];
					for (const { agent, member } of members) {
						const receipt = member === null ? null : await recordMemberReceipts(member);
						const output =
							receipt?.exitCode === 0 &&
							(receipt.outcome === undefined || receipt.outcome === "succeeded") &&
							receipt.output?.state === "final"
								? receipt.output.text
								: "[proposal failed]";
						proposals.push({ agent, output });
					}
					request.briefing = buildDelegationProposalBriefing(proposals);
				}
				signal?.throwIfAborted();
				const handle = await dispatch.dispatch(request, undefined, signal ? { signal } : undefined);
				const waveIndex = fleetPlanWaveIndex(livePlan, step.id);
				stepDispatched({
					stepId: step.id,
					kind: "agent",
					waveIndex,
					assignmentId: handle.runId,
					agentId: step.agentId,
				});
				void (async () => {
					for await (const _event of handle.events) {
						/* background display drain */
					}
				})().catch(() => {});
				return {
					assignmentId: handle.runId,
					result: handle.finalPromise.then(async (firstReceipt) => {
						const receipt = await collectMemberReceipts(handle.runId, firstReceipt, step.id);
						if (step.scope === "workspace") {
							validationFresh = false;
							independentReviewFresh = false;
						}
						receiptsByStep.set(step.id, stepRunOf(receipt));
						// The result is the one dispatch handed back in memory: authentic as held.
						const integrityValid = true;
						const succeeded = receipt.exitCode === 0 && (receipt.outcome === undefined || receipt.outcome === "succeeded");
						let stepSucceeded = succeeded;
						let failureReason: string | undefined = succeeded
							? undefined
							: (receipt.outcomeDetail ?? receipt.outcomeCode ?? receipt.outcome ?? "worker failed");
						let gatePathHash: string | undefined;
						let delegationPlanHash: string | undefined;
						let delegationPlan: ExecutionStepResult["delegationPlan"];
						if (step.gate !== undefined && succeeded) {
							let gateBytes = "";
							try {
								gateBytes = readFileSync(join(workspaceRoot, step.gate.path), "utf8");
							} catch {
								gateBytes = "";
							}
							gatePathHash = sha256Hex(gateBytes);
							const command = input.commands?.commands.get(step.gate.commandId);
							if (gateBytes.length === 0 || command === undefined) {
								stepSucceeded = false;
								failureReason = gateBytes.length === 0 ? "gate_path_missing" : "gate_command_missing";
							} else {
								const shellSandbox = hostVerificationSandbox(input.settings, workspaceRoot);
								const baseline = await runCodeStep({
									stepId: `${step.id}.baseline`,
									command,
									workspaceRoot,
									artifactDir: codeStepDir(fleetRootId),
									substitutions: { path: step.gate.path },
									...(shellSandbox !== undefined ? { shellSandbox } : {}),
								});
								const baselineFailure = gateBaselineFailure(baseline.report.passed);
								if (baselineFailure !== null) {
									stepSucceeded = false;
									failureReason = baselineFailure;
								}
							}
						}
						if (step.plan !== undefined && succeeded) {
							let value: unknown = null;
							try {
								value = JSON.parse(receipt.output?.state === "final" ? receipt.output.text : "");
							} catch {
								value = null;
							}
							const validated = validateDelegationPlan({
								value,
								roster: step.plan.roster,
								maxTasks: step.plan.maxTasks,
								writes: step.writes ?? [],
							});
							if (!validated.ok) {
								stepSucceeded = false;
								failureReason = validated.reason;
							} else {
								delegationPlanHash = validated.hash;
								delegationPlan = validated.plan;
							}
						}
						// Settle only after the gate baseline and the delegation-plan
						// validation have run: a receipt that succeeded on its own can
						// still fail the step, and the operator must see that reason.
						announceSettled(
							step,
							{
								stepId: step.id,
								kind: "agent",
								waveIndex,
								assignmentId: handle.runId,
								agentId: step.agentId,
								succeeded: stepSucceeded,
								terminalRunId: receipt.runId,
								pricing: sumRunSpend([receipt]),
								run: receipt,
								...(failureReason !== undefined ? { failureReason } : {}),
							},
							(settled) => {
								if (input.onStepSettled !== undefined) input.onStepSettled(settled);
								else
									notice(
										`step ${step.id} ${step.agentId}: ${settled.succeeded ? "succeeded" : "failed"}${settled.failureReason !== undefined ? ` reason=${settled.failureReason}` : ""} assignment=${handle.runId} terminal-run=${receipt.runId} cost=${renderPricing(receipt.spend.pricing)}`,
									);
							},
						);
						return {
							stepId: step.id,
							assignmentId: handle.runId,
							terminalRunId: receipt.runId,
							runDigest: receipt.digest,
							output: receipt.output?.state === "final" ? receipt.output.text : "",
							succeeded: stepSucceeded,
							integrityValid,
							...(receipt.decisionRefs !== undefined ? { decisionRefs: receipt.decisionRefs } : {}),
							...(failureReason !== undefined ? { failureReason } : {}),
							...(gatePathHash !== undefined ? { gatePathHash } : {}),
							...(delegationPlanHash !== undefined ? { delegationPlanHash } : {}),
							...(delegationPlan !== undefined ? { delegationPlan } : {}),
						};
					}),
				};
			},
			async runCode(step, _handoffs, signal, priorResults) {
				refuseCanceledAdmission();
				const command = input.commands?.commands.get(step.commandId);
				if (command === undefined) throw new Error(`fleet code step '${step.id}' has no registered command`);
				const isCommit = step.commitFrom !== undefined;
				const evidence = isCommit
					? deriveFleetCommitAttribution({ plan: livePlan, step, priorResults, validationFresh, independentReviewFresh })
					: null;
				if (!isCommit && step.scope === "workspace" && step.verification !== true) {
					validationFresh = false;
					independentReviewFresh = false;
				}
				const originalMessage = isCommit ? commitMessageFor(step, priorResults) : null;
				const mutatedPaths = new Set<string>();
				const notes: string[] = [];
				if (step.loop?.role === "check" && step.gate === undefined) {
					const ancestors = executionPlanAncestors(livePlan, step.id);
					for (const source of livePlan.steps) {
						if (source.scope !== "workspace" || !ancestors.has(source.id)) continue;
						const result = priorResults.get(source.id);
						if (result?.integrityValid !== true) continue;
						if (source.kind === "code") {
							// A commit records changes rather than making them, so it is never tracked.
							if (source.commitFrom !== undefined) continue;
							// Absent means the step ran in an earlier process and was replayed on
							// resume; its paths were never persisted, so the check says so.
							const changed = codeChangedPathsByStep.get(source.id);
							if (changed === null || changed === undefined) {
								notes.push(
									`changed tests from code step '${source.id}' not run: its workspace changes could not be measured${changed === undefined ? " after resume" : ""}`,
								);
							}
							for (const filename of changed ?? []) mutatedPaths.add(filename);
							continue;
						}
						const receipt = receiptsByStep.get(source.id);
						const paths =
							source.expectedResultContract === "mutation-report"
								? mutationReportPaths({ kind: "mutation-report" }, result.output)
								: [];
						for (const filename of [...paths, ...(receipt?.changedPaths ?? [])]) {
							mutatedPaths.add(filename);
						}
					}
				}
				const codeRunId = newCodeRunId();
				// A loop check or gate executes what the workers before it wrote, so it runs
				// where host verification runs a check; an action or commit step is the
				// operator's own command and runs as before.
				const shellSandbox =
					!isCommit && (step.loop?.role === "check" || step.gate !== undefined)
						? hostVerificationSandbox(input.settings, workspaceRoot)
						: undefined;
				const commitAuthorship =
					isCommit && input.attributionEnabled && gitCommitAuthorSetting() === "auto"
						? resolvePancodeCommitAuthorship(workspaceRoot)
						: null;
				const runInput: CodeStepRunInput = {
					runId: codeRunId,
					...(mutatedPaths.size > 0 ? { mutatedPaths: [...mutatedPaths] } : {}),
					...(notes.length > 0 ? { notes } : {}),
					...(step.args ? { args: step.args } : {}),
					stepId: step.id,
					command,
					workspaceRoot,
					artifactDir: codeStepDir(fleetRootId),
					signal,
					...(shellSandbox !== undefined ? { shellSandbox } : {}),
					...(step.gate !== undefined ? { substitutions: { path: step.gate.path } } : {}),
					...(isCommit && evidence !== null && originalMessage !== null
						? {
								substitutions: {
									commitMessage: attributeCommitMessage(
										originalMessage,
										evidence,
										input.attributionEnabled,
										commitAuthorship === null ? {} : { pancodeAuthorFor: commitAuthorship.human },
									),
								},
								requireWorkspaceChanges: true,
								stage: { baseline: commitBaseline, artifacts: commitArtifactsFor(step, priorResults) },
								commitAttribution: {
									enabled: input.attributionEnabled,
									evidence,
									...(commitAuthorship === null ? {} : { authorship: commitAuthorship }),
								},
							}
						: {}),
				};
				// Announced before the command runs, as an agent step is at launch, so
				// a code-only fleet reads as running while it runs and an ACP client
				// learns it started without waiting for the first command to finish.
				// Validated first, so a step that cannot start never reads as started.
				preflightCodeStep(runInput);
				const event = {
					stepId: step.id,
					kind: "code" as const,
					waveIndex: fleetPlanWaveIndex(livePlan, step.id),
					assignmentId: codeRunId,
					commandId: command.id,
				};
				stepDispatched(event);
				// Only a later code loop check consumes these paths, so a step with
				// none downstream pays for no git status or hashing.
				const tracksChanges =
					!isCommit &&
					step.scope === "workspace" &&
					livePlan.steps.some(
						(later) =>
							later.kind === "code" &&
							later.loop?.role === "check" &&
							later.gate === undefined &&
							executionPlanAncestors(livePlan, later.id).has(step.id),
					);
				const before = tracksChanges ? workspaceChangeSnapshot(workspaceRoot) : null;
				const outcome = await runCodeStep(runInput);
				if (tracksChanges) {
					const after = before === null ? null : workspaceChangeSnapshot(workspaceRoot);
					codeChangedPathsByStep.set(
						step.id,
						before === null || after === null ? null : workspaceChangedPaths(before, after),
					);
				}
				if (isCommit && outcome.report.passed) {
					commitBaseline = commitPointSnapshot(workspaceRoot);
					if (commitBaseline !== null) writeCommitBaseline(codeStepDir(fleetRootId), commitBaseline);
				}
				if (step.verification === true) {
					// A pass over check files a worker in this run wrote proves only that the worker's check agrees
					// with the worker; it stays a pass but earns no Tested-by, and the run says why.
					const selfWritten: string[] = [];
					const writers: string[] = [];
					if (outcome.report.passed) {
						const ran = [command, ...(outcome.record.commandRuns ?? [])];
						for (const [stepId, receipt] of receiptsByStep) {
							const source = livePlan.steps.find((candidate) => candidate.id === stepId);
							if (source?.kind !== "agent" || source.scope !== "workspace") continue;
							const files = changedCheckFiles(ran, receipt.changedPaths, workspaceRoot);
							if (files.length === 0) continue;
							writers.push(stepId);
							selfWritten.push(...files);
						}
					}
					validationFresh = outcome.report.passed && !isVacuousCheckArgv(command.argv) && writers.length === 0;
					if (writers.length > 0)
						notice(
							`step ${step.id}: check passed without Tested-by: worker step${writers.length === 1 ? "" : "s"} ${writers.map((id) => `'${id}'`).join(", ")} changed the check's own files (${[...new Set(selfWritten)].sort().join(", ")})`,
						);
				}
				if (!telemetryHub().emit("code_step.settled", codeStepSettledFacts(outcome.record), rootTelemetry.context))
					throw new Error(`fleet code step '${step.id}' settlement could not be enqueued`);
				await rootTelemetry.flush();
				const recordPath = rootJournalPath;
				announceSettled(
					step,
					{
						...event,
						succeeded: outcome.report.passed,
						terminalRunId: outcome.record.runId,
						// No model ran, so there was nothing to price.
						pricing: sumPricing([{ usd: { kind: "absent", reason: "not-applicable" }, pricedBy: "none" }]),
						codeStep: outcome.record,
						recordPath,
					},
					(settled) => {
						if (input.onStepSettled !== undefined) input.onStepSettled(settled);
						else
							notice(
								`step ${step.id} code:${command.id}: ${settled.succeeded ? "passed" : "failed"}${settled.failureReason !== undefined ? ` reason=${settled.failureReason}` : ""} exit=${outcome.report.exitCode} ${outcome.record.durationMs}ms record=${recordPath}`,
							);
					},
				);
				return {
					stepId: step.id,
					assignmentId: outcome.record.runId,
					terminalRunId: outcome.record.runId,
					runDigest: outcome.record.reportDigest,
					output: step.gate === undefined ? outcome.output : gateFailureLines(outcome.report.outputExcerpt),
					succeeded: outcome.report.passed,
					// The runner authored this report itself, so its provenance is
					// valid by construction; only the command's verdict can be red.
					integrityValid: true,
					...(outcome.unrepairable ? { unrepairable: true as const } : {}),
				};
			},
			async decideLoop({ loop, step, attempt, terminalAttempt, result: stepResult }) {
				// The coordinator's review policy: pass ends the loop, a failure with
				// attempts left earns one repair, and the same failure at the bound is
				// the terminal answer. `revise` is never a verdict the reviewed model
				// authors.
				const decider = receiptsByStep.get(step.id);
				// The subject is the work under review: the most recent agent run
				// upstream of this verification. A direct dependency is not enough,
				// because a loop's declared dependency is another loop's deterministic
				// check, which produced no receipt at all.
				const ancestors = executionPlanAncestors(livePlan, step.id);
				let subject: StepRun | undefined;
				for (const [stepId, receipt] of receiptsByStep) {
					if (ancestors.has(stepId)) subject = receipt;
				}
				if (decider === undefined || subject === undefined) {
					return {
						resolved: false,
						findings: null,
						needsDecision: `loop '${loop.id}' cycle ${attempt} has no sealed reviewer or subject run record`,
					};
				}
				const correlation = fleetGateCorrelation(subject, decider);
				const decided = decideReviewGate({
					group: `${fleetRootId}:${loop.id}`,
					cycle: attempt,
					terminalCycle: terminalAttempt,
					subjects: [{ runId: subject.runId, digest: subject.digest }],
					decider: { runId: decider.runId, digest: decider.digest },
					correlation,
					output: stepResult.output,
					reviewer: decider.inspection,
				});
				independentReviewFresh = decided.verdict === "pass" && correlation.independent;
				if (!replayed.has(step.id)) {
					const staged = stagePendingGateDecision(decided.draft, { telemetry: rootTelemetry.context });
					const { path: decisionPath } = await materializePendingGateDecision(staged);
					notice(loopGateNotice(loop.id, attempt, decided, decisionPath), "gate");
				}
				return { resolved: decided.verdict === "pass", findings: decided.findings, needsDecision: decided.needsDecision };
			},
			beginWriteBoundary: (window, stepIds) => boundaryEnforcer.begin(window, stepIds),
			verifyWriteBoundary: (window, stepIds) => boundaryEnforcer.verify(window, stepIds),
			cancel: (assignmentId) => dispatch.abort(assignmentId),
			drainMember: (assignmentId) => dispatch.drainMember?.(assignmentId) ?? Promise.resolve(),
			release: (ownerId) => {
				if (ownerId === NO_WORKER_RESERVATION) return;
				dispatch.reservations?.release(ownerId);
			},
			releaseUnconsumed: (ownerId) => {
				if (ownerId === NO_WORKER_RESERVATION) return;
				dispatch.reservations?.rollbackUnconsumed(ownerId);
			},
			onStepSettled: async (step, stepResult) => {
				// A revalidation settles its step again; the cycle's checkpoint stays the
				// tree the cycle itself was checked on.
				const revalidation = fleetRunRecord.steps.some((recorded) => recorded.stepId === step.id);
				if (step.loop?.role === "check" && !revalidation) {
					const ref = workspaceCheckpointRef("loop", `${fleetRootId}:${step.loop.loopId}:${step.loop.attempt}`);
					captureWorkspaceCheckpoint(
						workspaceRoot,
						ref,
						`Fleet ${fleetRootId} loop ${step.loop.loopId} cycle ${step.loop.attempt}`,
					);
					stepResult.workspaceCheckpoint = ref;
					notice(`loop ${step.loop.loopId} cycle ${step.loop.attempt} checkpoint=${ref}`, "gate");
				}
				const entry = { stepId: step.id, result: stepResult };
				fleetRunRecord.steps.push(entry);
				const manifestStepCount = fleetRunRecord.steps.length;
				const writtenDigest = await writeManifest();
				// Each settled step checkpoints the manifest just written. Later settles
				// rewrite the file, so the entry digest and its position are what a
				// reader can still check against any later version of the record.
				events.append({
					type: "step_settled",
					stepId: step.id,
					kind: step.kind,
					succeeded: stepResult.succeeded,
					integrityValid: stepResult.integrityValid,
					terminalRunId: stepResult.terminalRunId,
					runDigest: stepResult.runDigest ?? null,
					recordPath:
						step.kind === "code"
							? rootJournalPath
							: telemetryJournalPath(telemetryRunDirectory(pancodeStateDir(), stepResult.terminalRunId)),
					...(stepResult.failureReason !== undefined ? { failureReason: stepResult.failureReason } : {}),
					stepEntryDigest: fleetStepEntryDigest(entry),
					manifestStepCount,
					manifestDigest: writtenDigest,
				});
				const pending = unrecordedSettles.get(step.id);
				if (pending !== undefined) {
					unrecordedSettles.delete(step.id);
					const { failureReason: _announced, ...outcome } = pending.outcome;
					pending.announce({
						...outcome,
						succeeded: stepResult.succeeded,
						...(stepResult.failureReason !== undefined ? { failureReason: stepResult.failureReason } : {}),
					});
				}
				// The scheduler settles both kinds of step here, so this is where a
				// deterministic step enters the assignment: a code step's `code-*` run
				// id reads exactly like an agent receipt id, and its evidence sits under
				// `code-steps/<fleetRootId>/`.
				await fileStepAttempt(stepResult.terminalRunId);
			},
			spliceAfter(currentPlan, step, stepResult) {
				if (stepResult.delegationPlan === undefined) return null;
				const tasks = stepResult.delegationPlan.tasks.map((task) => {
					const spec = agents.getSpec(task.agent);
					if (spec === null || spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
						throw new Error(`delegation_plan_agent_unavailable:${task.agent}`);
					}
					return {
						id: task.id,
						agentId: task.agent,
						task: task.description,
						dependencies: task.depends_on,
						writes: task.writes,
						...(step.target !== undefined ? { target: step.target } : {}),
						...(step.profile !== undefined ? { profile: step.profile } : {}),
						requestedAuthority: spec.capabilityClass,
						approvedAuthority: spec.capabilityClass,
						expectedResultContract: spec.resultContract.kind,
						resultContract: spec.resultContract,
						// The spliced step runs read-only when it declares no writes (its plan scope), so its role says so.
						executionRole: requestRunRole({ agentId: task.agent, readOnly: task.writes.length === 0 }, () => spec),
					};
				});
				livePlan = spliceExecutionPlan(currentPlan, step.id, tasks);
				return livePlan;
			},
			replayed,
		};
		result = await executePlan(livePlan, adapter, input.signal);
	} catch (error) {
		try {
			await writeEndedManifest();
		} finally {
			sealEvents(input.signal?.aborted === true ? "aborted" : "failed");
		}
		// A run the scheduler could not carry to the end never reached a verdict,
		// and a fleet that threw is not a fleet that worked.
		await settleFleetAssignment(events, fleetRootId, fleetRunRecord, false);
		throw error;
	}
	// A loop is judged by whether it converged, not attempt by attempt: a red
	// verification that a later attempt fixed is the loop working as declared,
	// and a node a resolved loop made unnecessary never had to run at all.
	const required = livePlan.steps.filter((step) => step.loop === undefined && !result.unneeded.includes(step.id));
	const failedLoops = result.loops.filter((loop) => !loop.resolved);
	const succeededStepCount = required.filter((step) => result.results.get(step.id)?.succeeded === true).length;
	// A step a stop policy left unrun is counted but never succeeded, so a run
	// that halted early can never reach the required count.
	const cleanRun =
		input.signal?.aborted !== true &&
		failedLoops.length === 0 &&
		result.skipped.length === 0 &&
		succeededStepCount === required.length;
	let recordWritten = false;
	try {
		await writeEndedManifest();
		recordWritten = true;
	} finally {
		// The seal carries the same verdict the assignment row gets, so a fleet
		// with a red or skipped step never seals as a success. A final record that
		// could not be written skips the settle, and reconciliation fails the row.
		sealEvents(cleanRun && recordWritten ? "succeeded" : input.signal?.aborted === true ? "aborted" : "failed");
	}
	await settleFleetAssignment(events, fleetRootId, fleetRunRecord, cleanRun);
	return {
		rootId: fleetRootId,
		planHash: input.plan.hash,
		result,
		receipts,
		totalCost: sumRunSpend(receipts),
		totalUsage: sumRunTokens(receipts),
		...stepCoverage(livePlan.steps, result),
		requiredStepCount: required.length,
		succeededStepCount,
		resolvedLoopCount: result.loops.length - failedLoops.length,
		cleanRun,
	};
}
