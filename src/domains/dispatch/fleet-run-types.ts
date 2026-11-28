// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { PancodeSettings } from "../../core/config.js";
import type { PricingSum, sumRunTokens } from "../../core/telemetry/pricing.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { PlaybookCommandRegistry } from "../agents/playbook-commands.js";
import type { AgentSpec } from "../agents/spec.js";
import type { DecisionLedgerEntry } from "../session/entries.js";
import type { runCodeStep } from "./code-step.js";
import type { DispatchContract } from "./contract.js";
import type { ExecutionPlan, ExecutionPlanStep } from "./execution-plan.js";
import type { ExecutionPlanResult, ExecutionStepResult } from "./execution-scheduler.js";
import type { FleetKeptWorktree } from "./fleet-task-worktree.js";
import type { FleetRunRecord } from "./state.js";
import type { RunResult } from "./types.js";

/** Recipe lookup for the agents a plan names; the agents domain owns the registry. */
export interface FleetRunAgentAccess {
	getSpec(agentId: string): AgentSpec | null;
}

/** One step reaching a runnable state, reported the moment its identity exists. */
export interface FleetRunStepEvent {
	stepId: string;
	kind: ExecutionPlanStep["kind"];
	/** Index of the plan wave this step belongs to. */
	waveIndex: number;
	/** Assignment id for an agent step, or the deterministic run id for a code step. */
	assignmentId: string;
	agentId?: string;
	commandId?: string;
	/** True when this event projects a result retained from an earlier run. */
	replayed?: true;
}

/** One settled step, after its receipt or deterministic report is sealed. */
export interface FleetRunStepOutcome extends FleetRunStepEvent {
	succeeded: boolean;
	/**
	 * Why a step failed after its own receipt or report succeeded: a gate whose
	 * baseline was green (`gate_not_discriminating`), a missing gate path or
	 * command, or a delegation plan the validator refused (`delegation_plan_*`).
	 */
	failureReason?: string;
	/** Terminal run id, which names the run record for an agent step. */
	terminalRunId: string;
	/**
	 * What the step cost as a sum of priced contributions, so a resumed step keeps the known subtotal of a partly
	 * priced run. A gateway-routed run that nobody priced is unknown, never `$0.00`; a deterministic step made no
	 * model call, so its cost is not applicable (#434).
	 */
	pricing: PricingSum;
	/** The agent run's result when this was an agent step. */
	run?: RunResult;
	/** The durable code-step record when this was a deterministic step. */
	codeStep?: Awaited<ReturnType<typeof runCodeStep>>["record"];
	/** The journal holding the step's `code_step.settled` when this was a deterministic step. */
	recordPath?: string;
	/** The scheduler result retained for a replayed step. */
	result?: ExecutionStepResult;
}

export interface ExecuteFleetRunInput {
	plan: ExecutionPlan;
	/** Playbook name, used for the deterministic commit subject only. */
	playbookName: string;
	/** Registered command bindings; required when the plan carries code steps. */
	commands: PlaybookCommandRegistry | null;
	workspaceRoot: string;
	/** Lineage root every step in this run shares. */
	fleetRootId: string;
	dispatch: DispatchContract;
	/** Active session board captured once before fleet admission, shared by every attempt and proposal. */
	getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
	agents: FleetRunAgentAccess;
	/** Whether a commit node stamps PanCode's attribution trailers. */
	attributionEnabled: boolean;
	/**
	 * The settings that choose the sandbox loop checks and gates run in, as host
	 * verification's checks do; absent reads as `safety.sandbox: auto`.
	 */
	settings?: Readonly<
		Pick<PancodeSettings, "safety" | "connections"> & {
			fleet?: Pick<PancodeSettings["fleet"], "limits"> & Partial<Pick<PancodeSettings["fleet"], "worktrees" | "nodes">>;
		}
	>;
	/** Cancel the fleet, including queued and running proposals. */
	signal?: AbortSignal;
	/**
	 * True once the run was stopped (`fleet stop`, the board, the main agent): a stopped run stays resumable, so its task
	 * worktree is kept for `fleet run --resume` even when no step has written to it yet.
	 */
	stopped?: () => boolean;
	/**
	 * Called synchronously before each step starts. It may abort `signal` (a durable root cancel request), and a step
	 * whose start finds `signal` aborted is refused before it is announced or launched.
	 */
	beforeStepAdmission?: () => void;
	/** Variables rendered into the playbook body and sealed into the run record. */
	vars?: Readonly<Record<string, string>>;
	/** A validated prior run and the successful prefix retained from it. */
	resume?: { record: FleetRunRecord; replayed: ReadonlyMap<string, ExecutionStepResult> };
	/**
	 * The starting session's standing tool limits. Every worker the run starts
	 * carries them, so a session started with `--delegate-tools read` never
	 * hands a playbook step write or bash (Z1).
	 */
	turnConstraints?: TurnConstraints;
	/**
	 * Fires once the workspace lock and the whole-plan reservation are held, so a run the lock or the admission gate
	 * refuses never announces its minted root.
	 */
	onStarted?: () => void;
	registerEmergencySeal?: (seal: () => void) => () => void;
	onStepDispatched?: (event: FleetRunStepEvent) => void;
	onStepSettled?: (outcome: FleetRunStepOutcome) => void;
	/** Operator-facing lines the caller renders wherever it shows the run. */
	onNotice?: (text: string, kind?: "gate" | "write-boundary") => void;
	/** Fires once, after the run settles, when a `worktree` run kept its task worktree with its work committed. */
	onWorktreeKept?: (kept: FleetKeptWorktree) => void;
}

export interface FleetRunOutcome {
	rootId: string;
	planHash: string;
	result: ExecutionPlanResult;
	receipts: ReadonlyArray<RunResult>;
	/** Every receipt's cost, one contribution per run, so an unpriced run keeps the total a lower bound (#434). */
	totalCost: PricingSum;
	/** Every receipt's calls and tokens, one contribution per run, folded the way {@link totalCost} is. */
	totalUsage: ReturnType<typeof sumRunTokens>;
	/** Steps of the live plan that never settled and no resolved loop made unnecessary: the plan stopped before them. */
	notRunStepIds: string[];
	/** Steps that ran unconditionally, excluding nodes a resolved loop skipped. */
	requiredStepCount: number;
	succeededStepCount: number;
	/** Every step the live plan declared, and those that settled; a plan with loops states these (`fleetStepCountText`). */
	plannedStepCount: number;
	ranStepCount: number;
	resolvedLoopCount: number;
	/** True when every required step succeeded and every loop converged. */
	cleanRun: boolean;
}
