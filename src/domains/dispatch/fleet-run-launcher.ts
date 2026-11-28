// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * One session's fleet runs, whoever starts them: the terminal's `/fleet run`, an ACP session's, or the main agent's
 * `dispatch(playbook=...)`. A launch takes the session's single-run guard, records a durable fleet root (so `fleet
 * wait`, `fleet stop` and `monitor` reach it from any process), runs the approved plan, and seals the root with its
 * fleet_end document. Surfaces only observe: none of them mints a root or writes its result.
 */

import { randomBytes } from "node:crypto";
import type { PancodeSettings } from "../../core/config.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { DecisionLedgerEntry } from "../session/entries.js";
import { clearRootCancelRequest, readRootCancelRequest } from "./cancel-requests.js";
import { fleetAdmissionRefusal } from "./capacity-lease.js";
import type { DispatchContract } from "./contract.js";
import {
	type FleetEndCause,
	type FleetEndStep,
	fleetEndDocument,
	fleetEndStep,
	fleetRunFailedMessage,
	fleetStepFailureReason,
} from "./fleet-end-document.js";
import { writeFleetResult, writeFleetRootRecord } from "./fleet-root-record.js";
import { executeFleetRun } from "./fleet-run.js";
import type { FleetRunPreview } from "./fleet-run-preview.js";
import type {
	ExecuteFleetRunInput,
	FleetRunAgentAccess,
	FleetRunOutcome,
	FleetRunStepEvent,
	FleetRunStepOutcome,
} from "./fleet-run-types.js";
import type { FleetKeptWorktree } from "./fleet-task-worktree.js";
import { WriterSetBusyError } from "./writer-set.js";

/** How often a running root looks for a durable stop request (`fleet stop <root>`, `monitor` on the root). */
const ROOT_STOP_POLL_MS = 250;
/** A first step that waits on proposals or endpoint capacity is running, not failed; admission stops waiting here. */
const ADMISSION_CAP_MS = 30_000;

/** Who started the run: the operator approved it on a surface, or the main agent asked for it and the operator approved. */
export type FleetRunOrigin = "operator" | "model";
/** Who stopped it: a durable root stop request, the operator on this surface, or the main agent. */
export type FleetRunStopper = "fleet_stop" | "operator" | "model";

export interface FleetRunHandle {
	readonly rootId: string;
	readonly stop: (by: FleetRunStopper) => void;
}

/** What a surface sees of a run it started. Every hook is optional; none of them can change the run. */
export interface FleetRunObserver {
	readonly started?: (run: FleetRunHandle) => void;
	readonly stepDispatched?: (rootId: string, event: FleetRunStepEvent) => void;
	readonly stepSettled?: (rootId: string, outcome: FleetRunStepOutcome) => void;
	/** Runner notices, and a fleet result the root could not persist (no kind). */
	readonly notice?: (text: string, kind?: "gate" | "write-boundary") => void;
}

export interface FleetRunLaunchInput {
	readonly preview: FleetRunPreview;
	readonly origin: FleetRunOrigin;
	readonly turnConstraints?: TurnConstraints;
	readonly observer?: FleetRunObserver;
}

/** How the run's start went: its first step dispatched, it threw before starting, or it ended before any step. */
export type FleetRunAdmission =
	| { readonly status: "started" }
	| { readonly status: "refused"; readonly reason: string }
	| { readonly status: "failed"; readonly reason: string };

export type FleetRunSettlement = {
	readonly rootId: string;
	readonly stoppedBy: FleetRunStopper | null;
	/** The exit code the sealed document carries, which `fleet wait` returns. */
	readonly exitCode: number;
	readonly document: Readonly<Record<string, unknown>>;
} & ({ readonly ok: true; readonly outcome: FleetRunOutcome } | { readonly ok: false; readonly error: unknown });

export type FleetRunLaunch =
	| { readonly status: "refused"; readonly reason: string }
	| (FleetRunHandle & {
			readonly status: "launched";
			/** Answers once: at the first step dispatch, 30s after the run starts, or when it ends first. */
			readonly admitted: Promise<FleetRunAdmission>;
			/** Resolves after the root is sealed; never rejects. */
			readonly settled: Promise<FleetRunSettlement>;
	  });

export interface FleetRunInFlight {
	readonly name: string;
	readonly rootId: string;
	readonly origin: FleetRunOrigin;
}

export interface FleetRunLauncherDeps {
	readonly dispatch: DispatchContract;
	readonly agents: FleetRunAgentAccess;
	readonly workspaceRoot: () => string;
	/** Read once per launch, before the guard is taken. */
	readonly getSettings?: () => PancodeSettings;
	readonly getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
	/** The runner; tests replace it. */
	readonly run?: (input: ExecuteFleetRunInput) => Promise<FleetRunOutcome>;
}

export interface FleetRunLauncher {
	/** The run this session started and has not seen settle. */
	inFlight(): FleetRunInFlight | null;
	launch(input: FleetRunLaunchInput): FleetRunLaunch;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createFleetRunLauncher(deps: FleetRunLauncherDeps): FleetRunLauncher {
	let running: FleetRunInFlight | null = null;

	const launch = (input: FleetRunLaunchInput): FleetRunLaunch => {
		const { preview, observer = {} } = input;
		// No root is minted for a run that never starts; the running root is named in the reason.
		if (running !== null) {
			return {
				status: "refused",
				reason: `plan ${running.name} (root=${running.rootId}) is still running; a new plan is refused until it settles. Nothing was dispatched`,
			};
		}
		const admissionRefusal = fleetAdmissionRefusal();
		if (admissionRefusal !== null) return { status: "refused", reason: `${admissionRefusal}. Nothing was dispatched` };
		// Read before the guard is taken: a throw here would otherwise refuse every later run in this session.
		const settings = deps.getSettings?.();
		const workspaceRoot = deps.workspaceRoot();
		const rootId = `fleet-${randomBytes(6).toString("hex")}`;
		try {
			writeFleetRootRecord({ rootId, playbook: preview.name, cwd: workspaceRoot });
		} catch (error) {
			return {
				status: "refused",
				reason: `cannot record fleet root ${rootId}: ${errorText(error)}. Nothing was dispatched`,
			};
		}
		running = { name: preview.name, rootId, origin: input.origin };

		const abort = new AbortController();
		let stoppedBy: FleetRunStopper | null = null;
		const stop = (by: FleetRunStopper): void => {
			if (abort.signal.aborted) return;
			stoppedBy = by;
			abort.abort();
		};
		const checkRootStop = (): void => {
			if (!abort.signal.aborted && readRootCancelRequest(rootId) !== null) stop("fleet_stop");
		};
		const stopPoll = setInterval(checkRootStop, ROOT_STOP_POLL_MS);
		stopPoll.unref?.();

		let started = false;
		let stepDispatched = false;
		let worktree: FleetKeptWorktree | null = null;
		const steps: FleetEndStep[] = [];
		const failures: Array<{ stepId: string; reason: string | null }> = [];

		let answer!: (admission: FleetRunAdmission) => void;
		const admitted = new Promise<FleetRunAdmission>((resolve) => {
			answer = resolve;
		});
		let answered = false;
		let admissionCap: ReturnType<typeof setTimeout> | undefined;
		const admit = (admission: FleetRunAdmission): void => {
			if (answered) return;
			answered = true;
			clearTimeout(admissionCap);
			answer(admission);
		};

		const args: ExecuteFleetRunInput = {
			signal: abort.signal,
			plan: preview.plan,
			playbookName: preview.name,
			commands: preview.commands,
			workspaceRoot,
			fleetRootId: rootId,
			dispatch: deps.dispatch,
			agents: deps.agents,
			...(deps.getDecisionBoard !== undefined ? { getDecisionBoard: deps.getDecisionBoard } : {}),
			attributionEnabled: settings?.integrations.git.commitAttribution ?? true,
			...(settings !== undefined ? { settings } : {}),
			vars: preview.vars,
			...(preview.resume !== undefined
				? { resume: { record: preview.resume.record, replayed: preview.resume.replayed } }
				: {}),
			...(input.turnConstraints !== undefined ? { turnConstraints: input.turnConstraints } : {}),
			beforeStepAdmission: checkRootStop,
			onStarted: () => {
				started = true;
				admissionCap = setTimeout(() => admit({ status: "started" }), ADMISSION_CAP_MS);
				admissionCap.unref?.();
				observer.started?.({ rootId, stop });
			},
			onStepDispatched: (event) => {
				if (event.replayed !== true) stepDispatched = true;
				admit({ status: "started" });
				observer.stepDispatched?.(rootId, event);
			},
			onStepSettled: (outcome) => {
				const step = fleetEndStep(outcome);
				steps.push(step);
				if (step.outcome === "failed") failures.push({ stepId: step.stepId, reason: fleetStepFailureReason(outcome) });
				observer.stepSettled?.(rootId, outcome);
			},
			onWorktreeKept: (kept) => {
				worktree = kept;
			},
			...(observer.notice !== undefined ? { onNotice: observer.notice } : {}),
		};

		const seal = (settledRun: { ok: true; outcome: FleetRunOutcome } | { ok: false; error: unknown }) => {
			clearInterval(stopPoll);
			running = null;
			const outcome = settledRun.ok ? settledRun.outcome : null;
			const refusedBeforeStep = !settledRun.ok && stoppedBy === null && !stepDispatched;
			const cleanRun = outcome?.cleanRun ?? false;
			const notRunStepIds = outcome?.notRunStepIds ?? [];
			const causes: FleetEndCause[] = [];
			let exitCode: number;
			if (settledRun.ok || stoppedBy !== null) {
				if (stoppedBy !== null) causes.push({ code: "interrupted", signal: null, by: stoppedBy });
				if (!cleanRun) {
					const message = fleetRunFailedMessage(failures, notRunStepIds);
					causes.push({ code: "run_failed", ...(message !== null ? { message } : {}) });
				}
				exitCode = cleanRun ? 0 : 1;
			} else {
				const message = errorText(settledRun.error);
				causes.push({ code: started && !refusedBeforeStep ? "run_failed" : "not_started", message });
				exitCode = settledRun.error instanceof WriterSetBusyError ? 1 : 2;
			}
			const budgetUsd = preview.budget.playbookUsd;
			const document = fleetEndDocument(
				{
					rootId,
					playbook: preview.name,
					planHash: outcome?.planHash ?? preview.plan.hash,
					started,
					refusedBeforeStep,
					steps,
					stopCause: stoppedBy !== null ? "stopped" : null,
					cleanRun,
					notRunStepIds,
					totalCost: outcome?.totalCost ?? null,
					totalUsage: outcome?.totalUsage ?? null,
					worktree,
					limits: {
						maxCostUsd: budgetUsd,
						maxCostSource: budgetUsd === null ? null : "playbook",
						enforced: false,
						overshootPossible: false,
						timeoutMs: null,
					},
				},
				exitCode,
				causes,
			);
			try {
				// The result before the sealed mark, so `fleet wait` never sees a sealed root without its document.
				writeFleetResult(rootId, document);
				clearRootCancelRequest(rootId);
			} catch (error) {
				observer.notice?.(`could not persist the fleet result for ${rootId}: ${errorText(error)}`);
			}
			if (settledRun.ok) {
				admit({
					status: "failed",
					reason: `the run ended before dispatching a step: ${settledRun.outcome.succeededStepCount}/${settledRun.outcome.requiredStepCount} steps succeeded`,
				});
			} else {
				// The run never started: another process's fleet holds this workspace, the lock timed out, or admission
				// refused its reservation.
				admit({ status: started ? "failed" : "refused", reason: errorText(settledRun.error) });
			}
			return { rootId, stoppedBy, exitCode, document, ...settledRun };
		};

		let run: Promise<FleetRunOutcome>;
		try {
			run = (deps.run ?? executeFleetRun)(args);
		} catch (error) {
			run = Promise.reject(error);
		}
		const settled: Promise<FleetRunSettlement> = run.then(
			(outcome) => seal({ ok: true, outcome }),
			(error: unknown) => seal({ ok: false, error }),
		);
		return { status: "launched", rootId, stop, admitted, settled };
	};

	return { inFlight: () => running, launch };
}
