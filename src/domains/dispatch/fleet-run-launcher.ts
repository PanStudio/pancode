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
import { ownerTelemetryContext, withTelemetryContext } from "../../core/telemetry/context.js";
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
import type { FleetRunPreview, FleetRunPreviewRoute } from "./fleet-run-preview.js";
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

/** What a surface that shows the session's runs sees of one of them, through to its sealed settlement. */
export interface FleetRunWatch extends FleetRunObserver {
	readonly settled?: (settlement: FleetRunSettlement) => void;
}

/**
 * A surface that shows every run this session starts, whoever started it, so the main agent's run reaches the same
 * board and notices as the operator's. It answers each launch with the hooks it wants, or nothing.
 */
export type FleetRunSurface = (run: {
	readonly rootId: string;
	readonly preview: FleetRunPreview;
	readonly origin: FleetRunOrigin;
}) => FleetRunWatch | undefined;

export interface FleetRunLaunchInput {
	readonly preview: FleetRunPreview;
	readonly origin: FleetRunOrigin;
	readonly turnConstraints?: TurnConstraints;
	/** The main agent's dispatch call that asked for a model-started run. */
	readonly parentToolCallId?: string;
	/**
	 * The caller answers before the run ends, so the root stays uncollected until `monitor` or the turn controller
	 * reads its sealed result.
	 */
	readonly detached?: boolean;
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

/** A detached root whose sealed result the main agent has not read yet. */
export interface FleetRunUncollected {
	readonly rootId: string;
	readonly name: string;
	readonly sealed: boolean;
}

export interface FleetRunLauncherDeps {
	readonly dispatch: DispatchContract;
	readonly agents: FleetRunAgentAccess;
	readonly workspaceRoot: () => string;
	/** Read once per launch, before the guard is taken. */
	readonly getSettings?: () => PancodeSettings;
	readonly getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
	/**
	 * The session that owns the runs this launcher starts, read at launch. The whole run executes in that session's
	 * telemetry context, so the root journal and every step bind it even when the launch comes from a keypress or a
	 * permission reply that carries no context. A standalone `pancode fleet run` has none.
	 */
	readonly sessionId?: () => string | null | undefined;
	/** The runner; tests replace it. */
	readonly run?: (input: ExecuteFleetRunInput) => Promise<FleetRunOutcome>;
}

export interface FleetRunLauncher {
	/** The run this session started and has not seen settle. */
	inFlight(): FleetRunInFlight | null;
	launch(input: FleetRunLaunchInput): FleetRunLaunch;
	/** Detached roots, running or sealed, that nothing has collected. */
	uncollected(): ReadonlyArray<FleetRunUncollected>;
	/** The root's sealed result reached the main agent; it no longer waits to be collected. */
	markCollected(rootId: string): void;
	/** Show every later launch on a surface; the returned function stops it. */
	watch(surface: FleetRunSurface): () => void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createFleetRunLauncher(deps: FleetRunLauncherDeps): FleetRunLauncher {
	let running: FleetRunInFlight | null = null;
	const uncollected = new Map<string, FleetRunUncollected>();
	const surfaces = new Set<FleetRunSurface>();

	const launch = (input: FleetRunLaunchInput): FleetRunLaunch => {
		const { preview } = input;
		// No root is minted for a run that never starts; the running root is named in the reason.
		if (running !== null) {
			return {
				status: "refused",
				reason: `plan ${running.name} (root=${running.rootId}) is still running; a new plan is refused until it settles. Nothing was dispatched`,
			};
		}
		const admissionRefusal = fleetAdmissionRefusal();
		if (admissionRefusal !== null) return { status: "refused", reason: `${admissionRefusal}. Nothing was dispatched` };
		if (input.turnConstraints?.readOnly === true) {
			if (preview.plan.isolation === "worktree") {
				return {
					status: "refused",
					reason: `plan ${preview.name} uses worktree isolation and cannot run under a read-only ceiling. Nothing was dispatched`,
				};
			}
			const disallowed = preview.plan.steps.find(
				(step) => step.kind === "code" || step.scope !== "readonly" || step.plan !== undefined,
			);
			if (disallowed !== undefined) {
				return {
					status: "refused",
					reason: `plan ${preview.name} step '${disallowed.id}' cannot run under a read-only ceiling. Nothing was dispatched`,
				};
			}
		}
		if (input.turnConstraints?.allowedTools !== undefined) {
			if (preview.plan.isolation === "worktree") {
				return {
					status: "refused",
					reason: `plan ${preview.name} uses worktree isolation and cannot run under a capability allowlist. Nothing was dispatched`,
				};
			}
			const codeStep = preview.plan.steps.find((step) => step.kind === "code");
			if (codeStep !== undefined) {
				return {
					status: "refused",
					reason: `plan ${preview.name} step '${codeStep.id}' runs a host command and cannot run under a capability allowlist. Nothing was dispatched`,
				};
			}
		}
		// Read before the guard is taken: a throw here would otherwise refuse every later run in this session.
		const settings = deps.getSettings?.();
		const workspaceRoot = deps.workspaceRoot();
		const sessionId = deps.sessionId?.() ?? null;
		const rootId = `fleet-${randomBytes(6).toString("hex")}`;
		try {
			writeFleetRootRecord({ rootId, playbook: preview.name, cwd: workspaceRoot });
		} catch (error) {
			return {
				status: "refused",
				reason: `cannot record fleet root ${rootId}: ${errorText(error)}. Nothing was dispatched`,
			};
		}
		// Attach surfaces before taking the single-run guard; a faulty surface must never wedge later launches.
		const watches: FleetRunWatch[] = [];
		for (const surface of surfaces) {
			try {
				const watch = surface({ rootId, preview, origin: input.origin });
				if (watch !== null && watch !== undefined) watches.push(watch);
			} catch (error) {
				input.observer?.notice?.(`a fleet surface failed to attach to ${rootId}: ${errorText(error)}`);
			}
		}
		running = { name: preview.name, rootId, origin: input.origin };
		if (input.detached === true) uncollected.set(rootId, { rootId, name: preview.name, sealed: false });
		const observer = joinedObserver([...(input.observer !== undefined ? [input.observer] : []), ...watches]);

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
			// A run that never started is answered by its admission; there is no later result to collect.
			if (admission.status !== "started") uncollected.delete(rootId);
			answer(admission);
		};

		const approvedRoutes = new Map<string, FleetRunPreviewRoute>();
		for (const wave of preview.waves ?? []) {
			for (const step of wave.steps) {
				if (step.kind === "agent" && step.route !== undefined) approvedRoutes.set(step.stepId, step.route);
			}
		}
		const args: ExecuteFleetRunInput = {
			signal: abort.signal,
			stopped: () => stoppedBy !== null,
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
			...(input.parentToolCallId !== undefined ? { parentToolCallId: input.parentToolCallId } : {}),
			...(approvedRoutes.size > 0 ? { approvedRoutes } : {}),
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
			const pending = uncollected.get(rootId);
			if (pending !== undefined) uncollected.set(rootId, { ...pending, sealed: true });
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

		const execute = deps.run ?? executeFleetRun;
		const owner = sessionId ? ownerTelemetryContext({ sessionId }) : undefined;
		let run: Promise<FleetRunOutcome>;
		try {
			run = owner !== undefined ? withTelemetryContext(owner, () => execute(args)) : execute(args);
		} catch (error) {
			run = Promise.reject(error);
		}
		const tell = (settlement: FleetRunSettlement): FleetRunSettlement => {
			for (const watch of watches) {
				try {
					watch.settled?.(settlement);
				} catch (error) {
					observer.notice?.(`a fleet surface failed to show the settled run ${rootId}: ${errorText(error)}`);
				}
			}
			return settlement;
		};
		const settled: Promise<FleetRunSettlement> = run.then(
			(outcome) => tell(seal({ ok: true, outcome })),
			(error: unknown) => tell(seal({ ok: false, error })),
		);
		return { status: "launched", rootId, stop, admitted, settled };
	};

	return {
		inFlight: () => running,
		launch,
		uncollected: () => [...uncollected.values()],
		markCollected: (rootId) => {
			uncollected.delete(rootId);
		},
		watch: (surface) => {
			surfaces.add(surface);
			return () => {
				surfaces.delete(surface);
			};
		},
	};
}

function joinedObserver(observers: ReadonlyArray<FleetRunObserver>): FleetRunObserver {
	if (observers.length <= 1) return observers[0] ?? {};
	return {
		started: (run) => {
			for (const observer of observers) observer.started?.(run);
		},
		stepDispatched: (rootId, event) => {
			for (const observer of observers) observer.stepDispatched?.(rootId, event);
		},
		stepSettled: (rootId, outcome) => {
			for (const observer of observers) observer.stepSettled?.(rootId, outcome);
		},
		...(observers.some((observer) => observer.notice !== undefined)
			? {
					notice: (text: string, kind?: "gate" | "write-boundary") => {
						for (const observer of observers) observer.notice?.(text, kind);
					},
				}
			: {}),
	};
}
