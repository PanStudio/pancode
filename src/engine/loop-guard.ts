// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Unified loop guard, packaged as a middleware hook registration.
 *
 * Both the orchestrator and worker registries register this single module on
 * `before_tool`, so there is exactly one observation seam and no double-count
 * hazard from separate interactive and worker guards. The registry feeds it
 * every tool-call attempt, including safety-blocked ones, via
 * `metadata.callFingerprint`.
 *
 * Parameterization covers both deployments: the orchestrator passes a bus
 * (LoopBlocked visibility) and the per-turn block budget; workers pass the
 * hard tool-call cap so a degenerate model cannot burn through a run by
 * spamming distinct calls. Operator visibility flows over the event bus only;
 * nothing here imports TUI code.
 */

import {
	resolveGuardrail,
	resolveTemplateCeiling,
	templateBudgetLimit,
	workerSynthesisReserveBlockReason,
	workerSynthesisReserveDirective,
	workerToolCallCapExceededReason,
	workerToolCallCapSynthesisReason,
} from "../core/guardrails.js";
import { EXPLORATION_TOOL_NAMES } from "../core/read-only-calls.js";
import { ownerTelemetryContext } from "../core/telemetry/context.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type {
	LoopBlockedDisposition,
	LoopBlockedPayload,
	ToolBudgetExceededPayload,
} from "../core/telemetry/live-events.js";
import { stripDeadToolCallMarkup } from "../core/tool-call-markup.js";
import { isHarnessExtensionToolName, ToolNames } from "../core/tool-names.js";
import type { AgentProduct } from "../domains/agents/spec.js";
import { dispatchMutatedParentWorkspace } from "../domains/dispatch/workspace-mutation.js";
import type { MiddlewareHookRegistration } from "../domains/middleware/runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../domains/middleware/types.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { hashToolCall } from "../domains/safety/loop-detector.js";
import { isGatewayChain } from "../tools/gateway-display.js";
import { gitCallIdentity } from "../tools/git-inspect.js";
import { resolveReadPath } from "../tools/path-utils.js";
import { effectiveToolCall } from "../tools/surface.js";
import { resolveVerifyCall } from "../tools/verify/resolve.js";
import {
	clipFailure,
	crossArgumentResultMessage,
	loopBlockBaseReason,
	parallelStepReason,
	stagnationBlockReason,
	stepPolicyReason,
	synthesisBackstopReason,
	turnBudgetRefusalTail,
} from "./loop-guard-reasons.js";
import { callIdentity, shellCommandOnlyReads, stagnationFingerprint } from "./loop-guard-repeat.js";
import { synthesisLockoutDirective } from "./loop-guard-synthesis.js";

export { stripDeadToolCallMarkup };

export const LOOP_GUARD_REGISTRATION_ID = "guard.loop";

/**
 * Loop blocks tolerated per user turn before the turn is interrupted. Combined
 * with the detector's identical-call threshold, a runaway turn is bounded to a
 * few verbatim repeats (threshold-1 free calls plus this many blocked retries)
 * rather than spinning for tens of seconds before the stop lands.
 */
export const INTERACTIVE_LOOP_BLOCK_BUDGET = 3;

/**
 * Blocks of one call identity in a turn, consecutive or not, that lock the
 * turn's tools on the interactive surface. One block alone never locks: a
 * desk drive lost its last next_step to a single false block (WTF-P 0.8.3 A2).
 */
export const INTERACTIVE_SAME_CALL_BLOCK_LIMIT = 2;

/** A short worker run keeps the two-block bound it had before the interactive budget rose. */
const WORKER_LOOP_BLOCK_FLOOR = 2;

/**
 * Blocks of one identical call in a row, with no other call run between them,
 * that end tool use however much run-wide budget is left. A worker's budget
 * scales with its run length so separate spirals in a long editing pass don't
 * end it, but that let a local model resend one blocked `git diff --stat` 14
 * times, a full model round and ~15k input tokens each, before the lockout.
 * Resending a call the guard has refused twice is not a spiral that recovers.
 */
export const CONSECUTIVE_IDENTICAL_BLOCK_LIMIT = 3;

/** One loop block tolerated per this many admitted calls in a worker run. */
const WORKER_LOOP_BLOCK_CALLS_PER_BLOCK = 10;

/**
 * Loop blocks a worker run tolerates before it is locked to synthesis.
 *
 * A worker has no turns: it never sets a turnId, so every block it collects
 * lands in one bucket that lives for the whole run. Measuring that run-long
 * count against the interactive per-turn budget made the second verbatim
 * spiral anywhere in a ninety-call editing pass end the run, which is a
 * verdict about run length rather than about degeneracy. The detector still
 * blocks each spiral on the spot; this is the separate judgment that the run
 * as a whole is not converging, so it scales with how long the run is allowed
 * to be. The interactive budget stays the floor, so a short worker keeps
 * exactly the bound it has today.
 */
export function workerLoopBlockBudget(toolCalls: number): number {
	if (!Number.isSafeInteger(toolCalls) || toolCalls <= 0) return WORKER_LOOP_BLOCK_FLOOR;
	return Math.max(WORKER_LOOP_BLOCK_FLOOR, Math.ceil(toolCalls / WORKER_LOOP_BLOCK_CALLS_PER_BLOCK));
}

/**
 * Post-lockout tool calls tolerated before the synthesis lockout falls back to
 * a hard turn stop. Once a turn reaches its loop-block budget the guard locks
 * tools for the rest of the turn and tells the model to answer from what it
 * gathered; a model that keeps calling tools instead of answering is stopped
 * after this many further denials so a degenerate model cannot spin forever.
 */
export const LOOP_SYNTHESIS_BACKSTOP_DENIALS = 2;

/**
 * Floor for the run-level denial budget, sized to cover one wide parallel
 * batch. The budget is otherwise the run's own tool-call cap, and a run whose
 * cap is tiny must still be able to steer a full batch of siblings rather than
 * die on it: the per-round bounds exist precisely so a wide batch gets one
 * synthesis round instead of a kill.
 */
export const WIDE_BATCH_DENIAL_FLOOR = 32;

/**
 * Hard ceiling sits this many calls above the soft budget. Reaching it
 * interrupts the turn outright instead of merely nudging, bounding a model
 * that ignores the directive to a small number of blocked retries.
 */
export const ORCH_TURN_TOOL_CALL_HARD_MARGIN = 15;

/** Bounded turn-id memory, matching the registry's dispatch-guard policy. */
const LOOP_GUARD_TURN_LIMIT = 32;
/** Direct `finish` attempts a turn may make past its spent tool-call budget (CLI-P43). */
const FINISH_ATTEMPTS_PAST_BUDGET = 2;

/** Bounded per-fingerprint success memory for the block-reason evidence anchor. */
const SUCCEEDED_FINGERPRINT_LIMIT = 128;

/** Bucket for calls arriving without a turn id (e.g. pre-session probes). */
const NO_TURN_BUCKET = "no-turn";

/** Minimum time a pending collect must have blocked to earn another repeat epoch. */
const COLLECT_BLOCKED_EPOCH_MS = 5_000;

/**
 * A bash call that ran this long spent real time rather than tokens, so a slow
 * identical command is a poll and not a spiral. The maintainer chose this for
 * every autonomy level knowing a slow identical command no longer trips the
 * guard; the tool budget and the cost ceiling still bound it (#445).
 */
const BASH_REPEAT_CREDIT_MS = 5_000;
/**
 * Same-shape calls with byte-identical results tolerated before the next one
 * is blocked. Two identical results already prove the size knobs are not
 * adding information; the third attempt is never productive. Verbatim repeats
 * trip the identical-call detector first; this catches the escalation cycle
 * (limit: 10000 -> 20000 -> 50000 -> ...) that varies args enough to evade it.
 */
export const RESULT_STAGNATION_THRESHOLD = 3;
const CROSS_ARGUMENT_RESULT_MIN_BYTES = 64;

/**
 * Repeat identity of a call. A git call keys on the argv it will run, so two
 * spellings of one inspection (an op alias, limit 20 or none) cannot dodge the
 * detector as ignored log fields once did (DF-4, DF-9).
 */
/** The guard's events belong to the hook's own session or run, turn and tool call, whichever async context emits them. */
function guardEventContext(input: MiddlewareHookInput) {
	return ownerTelemetryContext({
		sessionId: input.sessionId,
		runId: input.runId,
		turnId: input.turnId,
		toolCallId: input.toolCallId,
	});
}

/** What an api 2 extension tool declared about its effect (A1); absent for every other tool. */
export interface DeclaredToolEffect {
	readOnly?: boolean;
	idempotent?: boolean;
}

/**
 * Whether an identical repeat of this call answers from the same state the
 * earlier copy read, by the classes A1 reads as making no change: a builtin
 * read-class tool, a bash command that only reads, a typed git inspection, or
 * an extension tool declared read-only or idempotent. A gateway call is judged
 * as the capability it runs. Anything else, such as a desk's `next_step`, may
 * answer the same arguments with a new state, so its later result is not a
 * fresh copy of the earlier one; the superseded stage never evicts it.
 */
export function callRepeatsAsRead(
	toolName: string,
	args: unknown,
	declared: (tool: string) => DeclaredToolEffect | undefined,
): boolean {
	const call = effectiveToolCall(toolName, args);
	if (call.toolName === ToolNames.Git) return call.args !== undefined && gitCallIdentity(call.args) !== null;
	if (EXPLORATION_TOOL_NAMES.has(call.toolName)) return true;
	if (call.toolName === ToolNames.Bash) return shellCommandOnlyReads(call.args?.command);
	if (!isHarnessExtensionToolName(call.toolName)) return false;
	const effect = declared(call.toolName);
	return effect?.readOnly === true || effect?.idempotent === true;
}

/** Soft/hard per-turn tool-call budget for the interactive orchestrator. */
export interface OrchTurnToolCallBudget {
	/** Calls a turn may make; the next attempt gets the re-plan refusal. */
	soft: number;
	/** Attempts a turn may make; the next one interrupts the turn. */
	hard: number;
}

export function readOrchTurnToolCallBudget(): OrchTurnToolCallBudget {
	const soft = resolveGuardrail("turnToolCallBudget");
	return { soft, hard: soft + ORCH_TURN_TOOL_CALL_HARD_MARGIN };
}

export interface CreateLoopGuardRegistrationOptions {
	safety: SafetyContract;
	/** Enables returned-read coverage only when the caller supplies its result-shaping cap; a getter reads a live cap. */
	readResultMaxBytes?: number | (() => number);
	/** Orchestrator only: LoopBlocked events for the interactive layer. */
	bus?: TelemetryHub;
	/** Loop blocks tolerated per turn before the block reason announces a stop. */
	turnBlockBudget?: number;
	/** Blocks of one call identity in a turn that reach the lockout before the block budget does. */
	sameCallBlockLimit?: number;
	/**
	 * Worker only: the run's estimated tool-call budget. It advises rather than
	 * stops: it sizes the refused-attempt bound, marks the registration as a
	 * worker's, and stands in for {@link toolCallSoftLimit} as the advisory
	 * threshold. Absent for the
	 * orchestrator, which has an operator who can intervene.
	 */
	toolCallCap?: number;
	/** Worker only: hard lifetime ceiling on observed attempts; absent leaves the run unbounded. */
	toolCallCeiling?: number;
	/**
	 * Worker only: attempts after which one tool result carries the advisory to
	 * reassess and finish. Tools stay available up to {@link toolCallCeiling}.
	 */
	toolCallSoftLimit?: number;
	/**
	 * Worker only: tools that carry this agent's deliverable rather than its
	 * exploration, admitted inside a reserve window alongside `read`. The
	 * reserve exists to end broad discovery, not to stop an agent from
	 * finishing: for an agent whose product is a report the tail is reads and
	 * prose, but for one whose product is files the tail is reads and writes,
	 * and blocking those made the last calls of every editing run bounce. Empty
	 * for read-only agents, which keeps the reserve read-only exactly as before.
	 */
	deliveryTools?: ReadonlyArray<string>;
	/**
	 * Worker only: calls held back from the tail of {@link toolCallCeiling} for
	 * verification reads and synthesis. Entering the window annotates one tool
	 * result with a one-shot reserve directive and blocks further non-read
	 * calls; reads still flow through the repetition and stagnation detectors.
	 * Inactive when absent, zero, or not smaller than the cap, so existing
	 * small-cap deployments and tests keep their exact behavior.
	 */
	toolCallReserve?: number;
	/**
	 * Orchestrator only: soft/hard per-turn tool-call budget. Crossing the soft
	 * budget blocks this and every further call in the turn with a
	 * stop-and-summarize directive; the hard ceiling additionally interrupts
	 * the turn over the bus. Absent for workers, which rely on the lifetime
	 * {@link toolCallCeiling} instead.
	 */
	turnToolCallBudget?: OrchTurnToolCallBudget | (() => OrchTurnToolCallBudget);
	/**
	 * When the per-turn loop-block budget is exhausted, lock tool use for the
	 * rest of the turn instead of cancelling it outright. Every further call is
	 * denied with a synthesize-now directive so the model produces a final
	 * answer from what it already gathered; only a bounded backstop of extra
	 * denials ({@link LOOP_SYNTHESIS_BACKSTOP_DENIALS}) falls back to the hard
	 * stop. The orchestrator's stop rides the bus (LoopBlocked "stop" drives
	 * chat.cancel); workers have no bus and instead watch blocked tool-finish
	 * events for {@link isLoopGuardSynthesisBackstopReason} and abort the run,
	 * so a looping worker returns a synthesized report after a bounded number
	 * of denials rather than burning the lifetime {@link toolCallCeiling}.
	 */
	turnSynthesisLockout?: boolean;
	/**
	 * Invoked when a turn enters the synthesis lockout. Surfaces without a bus
	 * (workers) use it to flip their request-level tool-choice lock so the next
	 * model round is text-only; the orchestrator gets the same signal from the
	 * LoopBlocked "lockout" bus event instead.
	 */
	onSynthesisLockout?: () => void;
	now?: () => number;
}

export interface LoopGuardRegistration extends MiddlewareHookRegistration {
	/** Read-only attempt counter for tests and telemetry. */
	callCount(): number;
	/**
	 * The footer's per-turn meter (FX-30): the guard's own calls for the turn it is judging against that turn's
	 * effective soft budget (width scale and template included), so a hand-over or a budget roll that starts a fresh
	 * guard turn shows as one. `settledSinceSubmit` is the autonomy window's count, zero right after a submit.
	 */
	turnMeter(settledSinceSubmit: number, fallbackBudget: number): { toolCalls: number; budget: number };
	/** The turn's parent-workspace mutation epoch, which the registry's denial memory keys on. */
	mutationEpoch(turnId: string): number;
}

export function createLoopGuardRegistration(options: CreateLoopGuardRegistrationOptions): LoopGuardRegistration {
	const budget = options.turnBlockBudget ?? INTERACTIVE_LOOP_BLOCK_BUDGET;
	const cap = options.toolCallCeiling;
	let advisoryEmitted = false;
	const synthesisLockout = options.turnSynthesisLockout === true;
	const deliveryTools = [...new Set(options.deliveryTools ?? [])];
	const reserveAdmits = (tool: string | undefined): boolean => isReserveAdmittedTool(tool, deliveryTools);
	/**
	 * Per-round non-compliance inside a reserve window. A reserve block is
	 * steering rather than a runaway signal, so it never spends the lifetime
	 * cap; this is what still bounds it. Reset by every admitted call, so the
	 * total is bounded by the reserve's own remaining calls.
	 */
	let reserveDenials: { denials: number; correlationId?: string } = { denials: 0 };
	/**
	 * Run-level bound on refused attempts, counted per call and blind to
	 * correlation. Every other bound here is per model round, which is correct
	 * for steering a model that keeps answering with tool calls but assumes a
	 * round is a handful of them. A degenerate local model emits one response
	 * whose parsed tool calls number in the hundreds, and every one of those
	 * siblings shares a correlation id, so the per-round bounds see a single
	 * denial while the batch drains. Charging refusals to the lifetime cap used
	 * to stop that by accident, at the cost of killing runs for obeying the
	 * guard. This is the same bound stated directly: a run may be refused as
	 * many calls as it was allowed to execute, and past that it is degenerate
	 * and ends on the backstop the worker already aborts on. The orchestrator
	 * has no cap and no bound here; it has an operator instead.
	 */
	let deniedAttempts = 0;
	const denialBudget =
		options.toolCallCap === undefined ? undefined : Math.max(options.toolCallCap, WIDE_BATCH_DENIAL_FLOOR);
	const boundRunDenials = (
		effects: ReadonlyArray<MiddlewareEffect>,
		input: MiddlewareHookInput,
	): ReadonlyArray<MiddlewareEffect> => {
		if (denialBudget === undefined || !effects.some((effect) => effect.kind === "block_tool")) return effects;
		deniedAttempts += 1;
		if (deniedAttempts <= denialBudget) return effects;
		return [{ kind: "block_tool", reason: synthesisBackstopReason(input.toolName ?? "unknown"), severity: "hard-block" }];
	};
	// Reserve window bounds. Active only when a cap exists and is strictly
	// larger than the reserve; a call is inside the window when its attempt
	// ordinal exceeds this threshold but has not passed the cap itself.
	const reserve = options.toolCallReserve ?? 0;
	const reserveThreshold = cap !== undefined && reserve > 0 && cap > reserve ? cap - reserve : null;
	let reserveDirectiveEmitted = false;
	const blocksByTurn = new Map<string, number>();
	const lastBlockedCallByTurn = new Map<string, string>();
	/** Per turn: the call blocked last and how many times in a row it was blocked. */
	const identicalBlockStreakByTurn = new Map<string, { identity: string; count: number }>();
	const unavailableChecks = new Map<string, string>();
	const callsByTurn = new Map<string, number>();
	/** Per turn: direct `finish` attempts admitted past a spent turn budget (CLI-P43). */
	const finishesPastBudgetByTurn = new Map<string, number>();
	/** Per turn: calls by effective tool (a gateway call counts as its capability), named in the budget refusal. */
	const callsByToolByTurn = new Map<string, Map<string, number>>();
	/**
	 * Per turn: the last parallel batch judged against the soft budget, the
	 * attempts made before it and whether it was refused whole. A batch that
	 * would cross the budget runs none of its calls, so the model never gets a
	 * partial batch it mistakes for finished work (CLI-H1).
	 */
	const budgetBatchByTurn = new Map<
		string,
		{ batch: string; size: number; spent: number; refused: boolean; announced: boolean }
	>();
	/**
	 * Per turn a continuation follows: the call or parallel batch that crossed the
	 * soft budget and was admitted as the turn's last, so the chat loop rolls the
	 * turn at its tool boundary (XR-6).
	 */
	const rolledBatchByTurn = new Map<string, string>();
	/** The turn and effective soft budget the latest budgeted call was judged against, for the footer meter (FX-30). */
	let latestTurnBudget: { key: string; soft: number } | undefined;
	/** Per turn under a step policy: its step tool succeeded ("done"), then a second call locked the turn ("locked"). */
	const stepByTurn = new Map<string, "done" | "locked">();
	/**
	 * Per turn under a step policy: the step-tool call the guard admitted and
	 * whose result has not come back, by its batch and call id. Success is only
	 * known after the call completes, so without this a second call in the same
	 * parallel batch passed admission too and both steps ran (WTF-P 0.8.3 C5).
	 */
	const stepInFlightByTurn = new Map<string, { batch?: string; call?: string }>();
	/**
	 * Calls this guard admitted, by turn and call id, until their result comes
	 * back. The registry judges a call again after an extension rewrites its
	 * input; that second pass checks the new arguments but is the same call, so
	 * it never spends the caps or the turn budget again (Astra r2-3).
	 */
	const admittedCalls = new Map<string, number>();
	/**
	 * Per-turn count of parent-workspace mutations, including sealed delegated
	 * work. The identical-call key carries it, so a check rerun after a change
	 * is fresh while a verbatim repeat with nothing changed still counts.
	 */
	const mutationEpochByTurn = new Map<string, number>();
	/**
	 * Per turn: successful calls that may have changed state, the workspace
	 * writes above plus bash commands that are not plain reads, typed git add
	 * and commit, and extension calls not declared read-only, and how many each
	 * call identity made. A call's repeat key counts only the others', so a
	 * mutating call repeated verbatim still loops while it resets every other
	 * call's count (F-C13).
	 */
	const stateChangesByTurn = new Map<string, number>();
	const stateChangesByIdentityByTurn = new Map<string, Map<string, number>>();
	const repeatEpoch = (turnKey: string, identity: string): number =>
		(stateChangesByTurn.get(turnKey) ?? 0) - (stateChangesByIdentityByTurn.get(turnKey)?.get(identity) ?? 0);
	/** Successful collect snapshots only; a lower pending count advances this call's repeat epoch. */
	const monitorCollectProgress = new Map<string, { pendingCount: number; epoch: number }>();
	/**
	 * Per turn and call identity: the repeat epoch a changed result (or, for
	 * bash, a slow run) earned, the last result seen, and whether that result
	 * matched the one before it. A stateful tool such as an extension's
	 * next_step returns a new answer to the same arguments, which is progress,
	 * so only identical results count toward a repeat (#445, F-C13).
	 */
	const repeatCredit = new Map<string, { epoch: number; lastResult: string | null; repeatedResult: boolean }>();
	/**
	 * Turns whose tool use is locked to synthesis after reaching the block
	 * budget. Key present means locked; the value carries the block that tripped
	 * the lockout (so the backstop's stop message names the looping tool) plus a
	 * running count of denials since the lockout for the backstop threshold.
	 */
	const lockoutByTurn = new Map<
		string,
		{
			tool: string;
			repeatCount: number;
			blocksThisTurn: number;
			denials: number;
			correlationId?: string;
			/** The batch holding the turn's first block, whose other calls the lockout never refuses. */
			exemptBatch?: string;
		}
	>();
	/** Per turn: the model round (correlation id) of the first block since the last recovery. */
	const firstBlockBatchByTurn = new Map<string, string>();
	/** Per turn: blocks by call identity, consecutive or not. */
	const blocksByIdentityByTurn = new Map<string, Map<string, number>>();
	/**
	 * Lifetime-cap synthesis lockout (workers). Entered exactly once when the
	 * observed attempt count crosses the cap while the synthesis lockout is
	 * wired, however many parallel calls cross it in the same batch; further
	 * attempts count denials toward the same bounded backstop the loop lockout
	 * uses. Null until the cap is crossed; without the lockout the cap keeps
	 * its original immediate-abort reason.
	 */
	let capLockout: { denials: number; correlationId?: string } | null = null;
	/**
	 * Per-fingerprint count of successful executions this run, for the evidence
	 * anchor: when a looped call already returned a result, the block reason
	 * points the model at that result instead of only asking for a new strategy.
	 * Bounded LRU (larger than the turn maps because a turn can retrieve from
	 * many distinct calls before it starts repeating one).
	 */
	const succeededFingerprints = new Map<string, number>();
	// Last error text per call identity, so a blocked repeat can restate why it failed.
	const failedResults = new Map<string, string>();
	/**
	 * Per-turn streak of consecutive same-shape calls (size args ignored) whose
	 * outputs hashed identically. Only the latest streak per turn is tracked:
	 * stagnation is a consecutive-call property, so any differently shaped or
	 * differently answered call resets it.
	 */
	const stagnationByTurn = new Map<string, { reducedFingerprint: string; resultFingerprint: string; streak: number }>();
	const eofByTurn = new Map<string, { identity: string; streak: number }>();
	// Actual returned line coverage, not requested limits. File stamps retire old
	// coverage after external changes; successful writes/edits clear it as well.
	const readCoverage = new Map<string, { bytes: number; mtimeMs: number; ranges: Array<[number, number]> }>();
	const redundantReadsByTurn = new Map<string, number>();
	const crossArgumentResultsByTurn = new Map<
		string,
		{ tool: string; resultFingerprint: string; argumentFingerprints: Set<string>; warned: boolean }
	>();
	let count = 0;

	const bumpBoundedCounter = (store: Map<string, number>, key: string, limit = LOOP_GUARD_TURN_LIMIT): number => {
		if (!store.has(key)) {
			while (store.size >= limit) {
				const oldest = store.keys().next().value;
				if (typeof oldest !== "string") break;
				store.delete(oldest);
			}
		}
		const next = (store.get(key) ?? 0) + 1;
		store.set(key, next);
		return next;
	};

	const monitorCollectKey = (turnKey: string, args: MiddlewareHookInput["toolArgs"]): string =>
		`${turnKey}|${hashToolCall(ToolNames.Monitor, args ?? {})}`;

	const observedCollectPendingCount = (input: MiddlewareHookInput): number | null => {
		if (input.toolName !== ToolNames.Monitor || input.toolArgs?.mode !== "collect" || input.metadata?.resultKind !== "ok")
			return null;
		const details = input.toolResultDetails;
		const runCount = details?.runCount;
		if (details?.mode !== "collect" || typeof runCount !== "number" || !Number.isSafeInteger(runCount) || runCount <= 0)
			return null;
		if (details.complete === true) return Array.isArray(details.runs) && details.runs.length === runCount ? 0 : null;
		const pendingCount = details.pendingCount;
		if (
			details.complete !== false ||
			typeof pendingCount !== "number" ||
			!Number.isSafeInteger(pendingCount) ||
			pendingCount <= 0 ||
			pendingCount > runCount ||
			!Array.isArray(details.pendingRunIds) ||
			details.pendingRunIds.length !== pendingCount ||
			!details.pendingRunIds.every((runId) => typeof runId === "string" && runId.length > 0)
		)
			return null;
		return pendingCount;
	};

	const collectBlockedLongEnough = (input: MiddlewareHookInput): boolean => {
		const details = input.toolResultDetails;
		return (
			details?.timedOut === true && typeof details.waitedMs === "number" && details.waitedMs >= COLLECT_BLOCKED_EPOCH_MS
		);
	};

	const repeatCreditKey = (turnKey: string, tool: string, args: Readonly<Record<string, unknown>> | undefined): string =>
		`${turnKey}\0${callIdentity(tool, args as Record<string, unknown> | undefined)}`;

	/**
	 * Grant the next repeat of this call a new epoch when its result changed, or
	 * when a bash call ran long; true when the bash call ran long enough to clear
	 * the stagnation streak too.
	 */
	const recordRepeatCredit = (input: MiddlewareHookInput): boolean => {
		const tool = input.toolName;
		if (typeof tool !== "string" || tool.length === 0) return false;
		const key = repeatCreditKey(input.turnId ?? NO_TURN_BUCKET, tool, input.toolArgs);
		const previous = repeatCredit.get(key);
		const elapsedMs = input.toolResultDetails?.elapsedMs;
		const ranLong = tool === ToolNames.Bash && typeof elapsedMs === "number" && elapsedMs >= BASH_REPEAT_CREDIT_MS;
		const outcome = input.metadata?.outcomeFingerprint;
		const lastResult = typeof outcome === "string" ? outcome : null;
		const changed =
			previous !== undefined && previous.lastResult !== null && lastResult !== null && previous.lastResult !== lastResult;
		if (previous === undefined) {
			while (repeatCredit.size >= SUCCEEDED_FINGERPRINT_LIMIT) {
				const oldest = repeatCredit.keys().next().value;
				if (typeof oldest !== "string") break;
				repeatCredit.delete(oldest);
			}
		}
		repeatCredit.set(key, {
			epoch: (previous?.epoch ?? 0) + (ranLong || changed ? 1 : 0),
			lastResult,
			repeatedResult: previous !== undefined && lastResult !== null && previous.lastResult === lastResult,
		});
		return ranLong;
	};

	const recordMonitorCollectProgress = (input: MiddlewareHookInput): void => {
		const pendingCount = observedCollectPendingCount(input);
		if (pendingCount === null) return;
		const key = monitorCollectKey(input.turnId ?? NO_TURN_BUCKET, input.toolArgs);
		const previous = monitorCollectProgress.get(key);
		// Ignore unchanged or older snapshots. Only a strict decrease can grant
		// another repeat epoch, so one batch permits at most runCount advances.
		// A collect that genuinely blocked for a while also advances: each such
		// poll spends real time rather than tokens, and without it a coordinator
		// waiting on one slow worker loses its tools on the third poll (D3).
		if (previous !== undefined && pendingCount >= previous.pendingCount && !collectBlockedLongEnough(input)) return;
		if (previous === undefined) {
			while (monitorCollectProgress.size >= SUCCEEDED_FINGERPRINT_LIMIT) {
				const oldest = monitorCollectProgress.keys().next().value;
				if (typeof oldest !== "string") break;
				monitorCollectProgress.delete(oldest);
			}
		}
		monitorCollectProgress.set(key, { pendingCount, epoch: previous === undefined ? 0 : previous.epoch + 1 });
	};

	// A result whose observation envelope shows a truncated body with zero
	// items is a cap stub or a budget-exhausted notice: the call technically
	// returned "ok" but the model saw none of the payload. Counting it as a
	// success would make the block reason claim "this exact call already
	// succeeded; re-read that result" about a result that holds nothing.
	const resultCarriesEvidence = (details: MiddlewareHookInput["toolResultDetails"]): boolean => {
		const observation = details?.observation;
		if (observation === null || typeof observation !== "object" || Array.isArray(observation)) return true;
		const record = observation as { truncated?: unknown; shownCount?: unknown };
		return !(record.truncated === true && record.shownCount === 0);
	};

	// after_tool touchpoint: the parent workspace changed. A failed dispatch can
	// still carry a verified receipt for work already applied to that workspace.
	// Also records the wider state changes the repeat key counts (F-C13).
	const recordWorkspaceMutation = (input: MiddlewareHookInput): boolean => {
		const ok = input.metadata?.resultKind === "ok";
		const directWrite = ok && (input.toolName === ToolNames.Write || input.toolName === ToolNames.Edit);
		const delegatedWrite =
			input.toolName === ToolNames.Dispatch && dispatchMutatedParentWorkspace(input.toolResultDetails);
		// A desk read, a desk record write, a desk read: the third read answers
		// from the new record, so it is not a repeat of the first two (F-C13).
		// Any extension tool that did not declare itself read-only may have
		// written, and so may any bash command that is not a plain read, and a
		// typed git add or commit, direct or through the gateway (Astra r2-4).
		// These re-key repeats and forget read coverage; the workspace epoch the
		// registry's denial memory keys on still moves for file writes alone.
		const stateChange =
			ok &&
			input.toolName !== undefined &&
			((input.toolName === ToolNames.Bash && !shellCommandOnlyReads(input.toolArgs?.command)) ||
				(input.toolName === ToolNames.Git && gitCallIdentity(input.toolArgs ?? {}) === null) ||
				(isHarnessExtensionToolName(input.toolName) && input.metadata?.toolReadOnly !== true));
		// A write that republished identical bytes changed nothing. Counting it
		// as a mutation re-keys every later repeat, so a worker that rewrites a
		// committed file and re-runs `git commit` between each attempt never
		// reaches a third identical call and burns the whole tool-call cap.
		const workspaceWrite = delegatedWrite || (directWrite && input.toolResultDetails?.unchanged !== true);
		if (!workspaceWrite && !stateChange) return false;
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		bumpBoundedCounter(stateChangesByTurn, turnKey);
		if (input.toolName !== undefined) {
			let byIdentity = stateChangesByIdentityByTurn.get(turnKey);
			if (byIdentity === undefined) {
				while (stateChangesByIdentityByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
					const oldest = stateChangesByIdentityByTurn.keys().next().value;
					if (typeof oldest !== "string") break;
					stateChangesByIdentityByTurn.delete(oldest);
				}
				byIdentity = new Map();
				stateChangesByIdentityByTurn.set(turnKey, byIdentity);
			}
			// Evicting an identity only raises its epoch, which admits more, never less.
			bumpBoundedCounter(byIdentity, callIdentity(input.toolName, input.toolArgs), SUCCEEDED_FINGERPRINT_LIMIT);
		}
		// Coverage keys on size and mtime, which a state change can keep
		// (an equal-length sed -i in one mtime tick, cp -p, git checkout), and
		// the guard cannot tell which paths a command touched, so forget it all.
		readCoverage.clear();
		redundantReadsByTurn.clear();
		if (!workspaceWrite) return false;
		bumpBoundedCounter(mutationEpochByTurn, turnKey);
		return true;
	};

	// A successful call records a success for its canonical fingerprint.
	// Blocked calls never reach here, so only real results anchor.
	const recordSuccessfulResult = (input: MiddlewareHookInput): void => {
		const identityTool = input.toolName;
		if (typeof identityTool === "string" && identityTool.length > 0) {
			const identity = callIdentity(identityTool, input.toolArgs);
			const failure =
				input.metadata?.resultKind !== "ok" && typeof input.metadata?.errorMessage === "string"
					? clipFailure(input.metadata.errorMessage)
					: undefined;
			failedResults.delete(identity);
			if (failure !== undefined) {
				if (failedResults.size >= SUCCEEDED_FINGERPRINT_LIMIT) {
					const oldest = failedResults.keys().next().value;
					if (oldest !== undefined) failedResults.delete(oldest);
				}
				failedResults.set(identity, failure);
			}
		}
		if (input.metadata?.resultKind !== "ok") return;
		if (!resultCarriesEvidence(input.toolResultDetails)) return;
		const tool = input.toolName;
		if (typeof tool !== "string" || tool.length === 0) return;
		bumpBoundedCounter(succeededFingerprints, callIdentity(tool, input.toolArgs), SUCCEEDED_FINGERPRINT_LIMIT);
	};

	// after_tool touchpoint: extend or reset the per-turn stagnation streak. A
	// result without a fingerprint (errors, non-string outputs) breaks the
	// streak rather than extending it.
	const recordResultForStagnation = (input: MiddlewareHookInput): void => {
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		const tool = input.toolName;
		const resultFingerprint = input.metadata?.resultFingerprint;
		if (
			typeof tool !== "string" ||
			tool.length === 0 ||
			input.metadata?.resultKind !== "ok" ||
			typeof resultFingerprint !== "string"
		) {
			stagnationByTurn.delete(turnKey);
			return;
		}
		// A pending collect that blocked is waiting on workers, not re-reading an
		// unchanged answer, so it never extends a stagnation streak (D3).
		if (collectBlockedLongEnough(input)) {
			stagnationByTurn.delete(turnKey);
			return;
		}
		const reducedFingerprint = stagnationFingerprint(tool, input.toolArgs);
		const previous = stagnationByTurn.get(turnKey);
		if (
			previous !== undefined &&
			previous.reducedFingerprint === reducedFingerprint &&
			previous.resultFingerprint === resultFingerprint
		) {
			previous.streak += 1;
			return;
		}
		if (!stagnationByTurn.has(turnKey)) {
			while (stagnationByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = stagnationByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				stagnationByTurn.delete(oldest);
			}
		}
		stagnationByTurn.set(turnKey, { reducedFingerprint, resultFingerprint, streak: 1 });
	};

	// Diagnostic-only coverage for tools that accept a substantive argument but
	// ignore it. Track one consecutive same-tool/result streak per turn and
	// annotate the third distinct argument shape. Short generic outputs and
	// zero-item cap stubs are deliberately excluded; this path never blocks.
	const crossArgumentResultEffects = (input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> => {
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		const tool = input.toolName;
		const resultFingerprint = input.metadata?.resultFingerprint;
		const resultBytes = input.metadata?.resultBytes;
		if (
			typeof tool !== "string" ||
			tool.length === 0 ||
			input.metadata?.actionClass !== "read" ||
			input.metadata?.resultKind !== "ok" ||
			typeof resultFingerprint !== "string" ||
			typeof resultBytes !== "number" ||
			resultBytes < CROSS_ARGUMENT_RESULT_MIN_BYTES ||
			!resultCarriesEvidence(input.toolResultDetails)
		) {
			crossArgumentResultsByTurn.delete(turnKey);
			return [];
		}
		const argumentFingerprint = stagnationFingerprint(tool, input.toolArgs);
		const previous = crossArgumentResultsByTurn.get(turnKey);
		if (previous?.tool === tool && previous.resultFingerprint === resultFingerprint) {
			if (previous.warned) return [];
			previous.argumentFingerprints.add(argumentFingerprint);
			if (previous.argumentFingerprints.size >= RESULT_STAGNATION_THRESHOLD) {
				previous.warned = true;
				return [
					{
						kind: "annotate_tool_result",
						message: crossArgumentResultMessage(tool, previous.argumentFingerprints.size),
						severity: "warn",
					},
				];
			}
			return [];
		}
		if (!crossArgumentResultsByTurn.has(turnKey)) {
			while (crossArgumentResultsByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = crossArgumentResultsByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				crossArgumentResultsByTurn.delete(oldest);
			}
		}
		crossArgumentResultsByTurn.set(turnKey, {
			tool,
			resultFingerprint,
			argumentFingerprints: new Set([argumentFingerprint]),
			warned: false,
		});
		return [];
	};

	const bumpTurnBlocks = (turnId: string): number => bumpBoundedCounter(blocksByTurn, turnId);

	const enterLockout = (
		input: MiddlewareHookInput,
		turnKey: string,
		state: { tool: string; repeatCount: number; blocksThisTurn: number },
	): void => {
		if (!lockoutByTurn.has(turnKey)) {
			while (lockoutByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = lockoutByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				lockoutByTurn.delete(oldest);
			}
		}
		const firstBatch = firstBlockBatchByTurn.get(turnKey);
		lockoutByTurn.set(turnKey, {
			...state,
			denials: 0,
			...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
			...(firstBatch !== undefined && firstBatch === input.correlationId ? { exemptBatch: firstBatch } : {}),
		});
	};

	/**
	 * Count non-compliance by provider/model round, not by sibling tool call.
	 * Parallel calls share correlationId; only the first call from a new round
	 * spends one denial. Calls without correlation are bounded per call.
	 */
	const reachesLockoutBackstop = (
		state: { denials: number; correlationId?: string },
		input: MiddlewareHookInput,
	): boolean => {
		if (input.correlationId !== undefined && state.correlationId === input.correlationId) return false;
		state.denials += 1;
		if (input.correlationId !== undefined) state.correlationId = input.correlationId;
		else delete state.correlationId;
		return state.denials > LOOP_SYNTHESIS_BACKSTOP_DENIALS;
	};

	const emitLoopBlocked = (
		input: MiddlewareHookInput,
		info: {
			tool: string;
			repeatCount: number;
			blocksThisTurn: number;
			disposition: LoopBlockedDisposition;
			priorFailure?: string;
		},
		at: number,
	): void => {
		const payload: LoopBlockedPayload = {
			tool: info.tool,
			repeatCount: info.repeatCount,
			blocksThisTurn: info.blocksThisTurn,
			budget,
			interrupted: info.disposition === "stop",
			disposition: info.disposition,
			...(info.priorFailure !== undefined ? { priorFailure: info.priorFailure } : {}),
			at,
			...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
		};
		options.bus?.emit("safety.loop_blocked", payload, guardEventContext(input));
	};

	const emitBudgetEvent = (
		input: MiddlewareHookInput,
		turnBudget: OrchTurnToolCallBudget,
		callsThisTurn: number,
		interrupted: boolean,
		at: number,
		bound?: { template?: string; stepTool?: string; rolled?: true },
	): void => {
		const payload: ToolBudgetExceededPayload = {
			tool: input.toolName ?? "unknown",
			callsThisTurn,
			softBudget: turnBudget.soft,
			hardCeiling: turnBudget.hard,
			interrupted,
			at,
			...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
			...(bound?.template !== undefined ? { template: bound.template } : {}),
			...(bound?.stepTool !== undefined ? { stepTool: bound.stepTool } : {}),
			...(bound?.rolled === true ? { rolled: true as const } : {}),
		};
		options.bus?.emit("safety.tool_budget_exceeded", payload, guardEventContext(input));
	};

	/**
	 * The turn's budget under a prompt template's `budget.toolCalls`: the
	 * smaller of that value and the larger of the operator's budget and
	 * `safety.limits.templateToolCallsPerTurnMax`. Lowering always applies;
	 * raising applies up to that ceiling, and not at all without one. The hard
	 * ceiling keeps the operator's margin above the effective soft budget, so a
	 * template budget ends the turn exactly the way the operator's does
	 * (WTF-P 0.8.3 B4). `source` names the bound that applied, for refusal text.
	 */
	const resolveTurnBudget = (
		input: MiddlewareHookInput,
	): { budget: OrchTurnToolCallBudget; template?: string; source: string } | undefined => {
		const budgetSource = options.turnToolCallBudget;
		const configured = typeof budgetSource === "function" ? budgetSource() : budgetSource;
		if (configured === undefined) return undefined;
		// A wide-parallel route keeps the same number of rounds: the chat loop measures its calls per round and
		// passes the multiplier, 1 to 3 (`turn-budget-width.ts`). The ceiling keeps the operator's margin (CLI-P26).
		const width = input.metadata?.turnBudgetScale;
		const scale = typeof width === "number" && width > 1 ? width : 1;
		const scaledSoft = Math.round(configured.soft * scale);
		const operator =
			scaledSoft > configured.soft
				? { soft: scaledSoft, hard: scaledSoft + (configured.hard - configured.soft) }
				: configured;
		const widthNote =
			operator === configured
				? ""
				: `, safety.limits.chatToolCallsPerTurn ${configured.soft} scaled x${scale.toFixed(1)} for this route's measured calls per round`;
		const templateCalls = input.metadata?.templateToolCalls;
		if (typeof templateCalls !== "number" || !(templateCalls >= 1)) return { budget: operator, source: widthNote };
		const name = input.metadata?.templateName;
		const template = typeof name === "string" && name.length > 0 ? name : "unnamed";
		const ceiling = resolveTemplateCeiling("templateTurnToolCallCeiling");
		const { limit, bound } = templateBudgetLimit(templateCalls, operator.soft, ceiling);
		if (bound === "operator")
			return {
				budget: operator,
				source:
					templateCalls > operator.soft
						? `, safety.limits.chatToolCallsPerTurn; prompt template "${template}" asked for ${templateCalls} and safety.limits.templateToolCallsPerTurnMax is unset`
						: "",
			};
		const margin = operator.hard - operator.soft;
		return {
			budget: { soft: limit, hard: limit + margin },
			template,
			source:
				bound === "ceiling"
					? `, safety.limits.templateToolCallsPerTurnMax; prompt template "${template}" asked for ${templateCalls}`
					: limit > operator.soft
						? `, set by prompt template "${template}" budget.toolCalls, raised within safety.limits.templateToolCallsPerTurnMax ${ceiling}`
						: `, set by prompt template "${template}" budget.toolCalls`,
		};
	};

	/**
	 * The batch this call belongs to when the soft budget refuses it whole: a
	 * parallel response judged once, at its first call, by whether all of it
	 * fits the calls the turn has left. A batch wider than the whole budget
	 * can never fit a turn, so it keeps the per-call cut instead of being
	 * refused again in every continuation.
	 */
	const refusedBudgetBatch = (
		input: MiddlewareHookInput,
		turnKey: string,
		soft: number,
	): { size: number; spent: number; announced: boolean } | null => {
		const batch = input.correlationId;
		const size = input.metadata?.batchSize;
		if (batch === undefined || typeof size !== "number" || !(size > 1)) return null;
		let judged = budgetBatchByTurn.get(turnKey);
		if (judged?.batch !== batch) {
			const spent = callsByTurn.get(turnKey) ?? 0;
			while (!budgetBatchByTurn.has(turnKey) && budgetBatchByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = budgetBatchByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				budgetBatchByTurn.delete(oldest);
			}
			judged = { batch, size, spent, refused: spent < soft && spent + size > soft && size <= soft, announced: false };
			budgetBatchByTurn.set(turnKey, judged);
		}
		return judged.refused ? judged : null;
	};

	const evaluateTurnBudget = (input: MiddlewareHookInput, now: number): ReadonlyArray<MiddlewareEffect> | null => {
		const resolved = resolveTurnBudget(input);
		if (resolved === undefined) return null;
		const turnBudget = resolved.budget;
		const bound = resolved.template === undefined ? undefined : { template: resolved.template };
		const source = resolved.source;
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		latestTurnBudget = { key: turnKey, soft: turnBudget.soft };
		// The chat loop says whether a turn this refusal ends continues without
		// the operator, as its settle path will decide (CLI-H1). Then the budget
		// rolls the turn instead of refusing a batch, so no whole-batch judgment.
		const continues = input.metadata?.turnBudgetContinues === true;
		const refusedBatch = continues ? null : refusedBudgetBatch(input, turnKey, turnBudget.soft);
		const callsThisTurn = bumpBoundedCounter(callsByTurn, turnKey);
		let byTool = callsByToolByTurn.get(turnKey);
		if (byTool === undefined) {
			while (callsByToolByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = callsByToolByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				callsByToolByTurn.delete(oldest);
			}
			byTool = new Map();
			callsByToolByTurn.set(turnKey, byTool);
		}
		const effectiveTool = effectiveToolCall(input.toolName ?? "unknown", input.toolArgs).toolName;
		byTool.set(effectiveTool, (byTool.get(effectiveTool) ?? 0) + 1);
		// `callsThisTurn` counts attempts, this one included. A soft budget of N
		// admits N calls, so attempt N + 1 is the first refusal; counting the
		// pending attempt as spent refused the Nth call and a budget of one ran
		// nothing (Astra r6-4). The stop keeps its margin: hard - soft refused
		// attempts, then attempt hard + 1 ends the turn.
		const firstRefusal = turnBudget.soft + 1;
		const stopAttempt = turnBudget.hard + 1;
		if (continues && callsThisTurn >= firstRefusal) {
			// Silent roll (XR-6): a continuation follows with a fresh budget, so the
			// call that crosses the budget runs, with every sibling of its parallel
			// batch, and the chat loop ends the turn at the batch's tool boundary
			// without asking the model for a progress note nobody reads.
			const batch = input.correlationId ?? `attempt:${callsThisTurn}`;
			const rolled = rolledBatchByTurn.get(turnKey);
			if (rolled === undefined) {
				while (rolledBatchByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
					const oldest = rolledBatchByTurn.keys().next().value;
					if (typeof oldest !== "string") break;
					rolledBatchByTurn.delete(oldest);
				}
				rolledBatchByTurn.set(turnKey, batch);
				emitBudgetEvent(input, turnBudget, callsThisTurn, false, now, { ...bound, rolled: true });
				return null;
			}
			if (rolled === batch) return null;
		}
		if (refusedBatch !== null) {
			// The whole batch is refused, its siblings included. It counts as the
			// turn's first refusal attempt and its siblings as nothing more: they
			// were emitted before the model saw any refusal, so they never bring a
			// later call nearer the hard ceiling than one refused call would.
			callsByTurn.set(turnKey, firstRefusal);
			if (!refusedBatch.announced) {
				refusedBatch.announced = true;
				emitBudgetEvent(input, turnBudget, refusedBatch.spent + refusedBatch.size, false, now, bound);
			}
			return [
				{
					kind: "block_tool",
					reason:
						`tool-call budget: this parallel batch of ${refusedBatch.size} tool calls would take the turn past its soft budget ` +
						`of ${turnBudget.soft} (${refusedBatch.spent} made${source}), so no call in the batch ran. ` +
						turnBudgetRefusalTail(continues, byTool),
					severity: "hard-block",
				},
			];
		}
		if (callsThisTurn >= stopAttempt) {
			// Hard ceiling: interrupt the turn the same way the block budget does.
			// The bus event drives chat.cancel() in the interactive layer; the
			// block effect makes the in-flight attempt fail with the same reason.
			if (callsThisTurn === stopAttempt) emitBudgetEvent(input, turnBudget, callsThisTurn, true, now, bound);
			return [
				{
					kind: "block_tool",
					reason:
						`tool-call budget exhausted: ${callsThisTurn} tool-call attempts in this turn passed the hard ceiling ` +
						`(${turnBudget.hard}${source}); the turn is being stopped. Summarize what you found and end your reply.`,
					severity: "hard-block",
				},
			];
		}
		if (callsThisTurn >= firstRefusal) {
			// Soft budget: block this attempt and every further one this turn.
			// The directive must say so plainly — an earlier wording implied a
			// narrower call could still succeed, which sent even compliant
			// models into a retry spiral because no call after the crossing can
			// ever run. The operator sees one warn notice per turn (the first
			// crossing); the model keeps getting the directive on every further
			// over-budget attempt so it cannot quietly resume spraying calls.
			if (callsThisTurn === firstRefusal) emitBudgetEvent(input, turnBudget, callsThisTurn, false, now, bound);
			return [
				{
					kind: "block_tool",
					reason:
						`tool-call budget: this turn has made its ${turnBudget.soft} tool calls (soft budget ${turnBudget.soft}${source}), so this call did not run. ` +
						turnBudgetRefusalTail(continues, byTool),
					severity: "hard-block",
				},
			];
		}
		return null;
	};

	/**
	 * A step-policy turn after its step tool succeeded: a second call to it,
	 * and every call after that, is refused with the step text. The first
	 * refusal locks tools for the turn (`lock_tools`, a text-only round that
	 * keeps the prompt prefix and tool schemas) and raises the tool-budget lock,
	 * so a yolo turn continues into a fresh turn that runs the next step. The
	 * call still counts toward the turn budget, whose hard ceiling stays the
	 * backstop for a model that keeps calling (WTF-P 0.8.3 C5).
	 */
	const evaluateStepPolicy = (
		input: MiddlewareHookInput,
		turnKey: string,
		now: number,
	): ReadonlyArray<MiddlewareEffect> | null => {
		const stepTool = input.metadata?.templateStepTool;
		const step = stepByTurn.get(turnKey);
		const template = typeof input.metadata?.templateName === "string" ? input.metadata.templateName : undefined;
		if (typeof stepTool === "string" && step === undefined && input.toolName === stepTool) {
			// A call admitted in another batch whose result never came back was refused
			// by a later guard; only a sibling of the same batch, or a call with no batch
			// to tell them apart, is still running.
			// The admitted call itself, judged again after a rewrite, is not its own sibling.
			const admitted = stepInFlightByTurn.get(turnKey);
			if (admitted !== undefined && admitted.call !== undefined && admitted.call === input.toolCallId) return null;
			if (admitted !== undefined && (admitted.batch === undefined || admitted.batch === input.correlationId))
				return [{ kind: "block_tool", reason: parallelStepReason(stepTool, template), severity: "hard-block" }];
			return null;
		}
		if (typeof stepTool !== "string" || step === undefined || (step === "done" && input.toolName !== stepTool))
			return null;
		const refusal: MiddlewareEffect = {
			kind: "block_tool",
			reason: stepPolicyReason(stepTool, template),
			severity: "hard-block",
		};
		const budgetBlock = evaluateTurnBudget(input, now);
		if (step === "locked") return budgetBlock ?? [refusal];
		stepByTurn.set(turnKey, "locked");
		if (budgetBlock === null) {
			const calls = callsByTurn.get(turnKey) ?? 1;
			const hard = resolveTurnBudget(input)?.budget.hard ?? calls;
			emitBudgetEvent(input, { soft: calls, hard }, calls, false, now, {
				...(template !== undefined ? { template } : {}),
				stepTool,
			});
		}
		return [...(budgetBlock ?? [refusal]), { kind: "lock_tools" }];
	};

	// Shared loop-block machinery for both detectors: bump the turn's block
	// count, enter the synthesis lockout at the budget, and emit visibility.
	const blockAsLoop = (
		input: MiddlewareHookInput,
		turnKey: string,
		tool: string,
		repeatCount: number,
		baseReason: string,
		now: number,
		/** The identical call already succeeded this run; see `block_tool.redundantRepeat`. */
		redundantRepeat = false,
	): ReadonlyArray<MiddlewareEffect> => {
		const marker = redundantRepeat ? ({ redundantRepeat: true } as const) : {};
		if (!lastBlockedCallByTurn.has(turnKey) && lastBlockedCallByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
			const oldest = lastBlockedCallByTurn.keys().next().value;
			if (oldest !== undefined) lastBlockedCallByTurn.delete(oldest);
		}
		const identity = callIdentity(tool, input.toolArgs);
		lastBlockedCallByTurn.set(turnKey, identity);
		const previous = identicalBlockStreakByTurn.get(turnKey);
		const streak = previous?.identity === identity ? previous.count + 1 : 1;
		if (previous === undefined && identicalBlockStreakByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
			const oldest = identicalBlockStreakByTurn.keys().next().value;
			if (oldest !== undefined) identicalBlockStreakByTurn.delete(oldest);
		}
		identicalBlockStreakByTurn.set(turnKey, { identity, count: streak });
		const blocksThisTurn = bumpTurnBlocks(turnKey);
		if (blocksThisTurn === 1) {
			if (input.correlationId !== undefined) {
				if (!firstBlockBatchByTurn.has(turnKey) && firstBlockBatchByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
					const oldest = firstBlockBatchByTurn.keys().next().value;
					if (oldest !== undefined) firstBlockBatchByTurn.delete(oldest);
				}
				firstBlockBatchByTurn.set(turnKey, input.correlationId);
			} else firstBlockBatchByTurn.delete(turnKey);
		}
		let byIdentity = blocksByIdentityByTurn.get(turnKey);
		if (byIdentity === undefined) {
			while (blocksByIdentityByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
				const oldest = blocksByIdentityByTurn.keys().next().value;
				if (typeof oldest !== "string") break;
				blocksByIdentityByTurn.delete(oldest);
			}
			byIdentity = new Map();
			blocksByIdentityByTurn.set(turnKey, byIdentity);
		}
		const sameCallBlocks = bumpBoundedCounter(byIdentity, identity, SUCCEEDED_FINGERPRINT_LIMIT);
		const reachedBudget =
			blocksThisTurn >= budget ||
			streak >= CONSECUTIVE_IDENTICAL_BLOCK_LIMIT ||
			(options.sameCallBlockLimit !== undefined && sameCallBlocks >= options.sameCallBlockLimit);
		const priorFailure = failedResults.get(identity);
		const failed = priorFailure !== undefined ? { priorFailure } : {};
		// Budget reached with the synthesis lockout wired: enter the lockout
		// instead of stopping the turn. The block reason becomes the
		// synthesize-now directive; the LoopBlocked event carries "lockout"
		// (not "stop") so no surface cancels — the model gets its one bounded
		// chance to answer from what it gathered.
		if (synthesisLockout && reachedBudget) {
			enterLockout(input, turnKey, { tool, repeatCount, blocksThisTurn });
			options.onSynthesisLockout?.();
			emitLoopBlocked(input, { tool, repeatCount, blocksThisTurn, disposition: "lockout", ...failed }, now);
			return [
				{
					kind: "block_tool",
					reason: synthesisLockoutDirective(priorFailure),
					severity: "hard-block",
					...marker,
				},
			];
		}
		// Below budget, or a surface without the lockout (workers): the
		// existing per-block behavior. Reaching the budget without a lockout
		// still stops the turn with the "being stopped" reason.
		emitLoopBlocked(
			input,
			{ tool, repeatCount, blocksThisTurn, disposition: reachedBudget ? "stop" : "block", ...failed },
			now,
		);
		const reason = reachedBudget
			? `${baseReason} Loop budget exhausted (${blocksThisTurn} blocks this turn); the agent is being stopped.`
			: baseReason;
		return [{ kind: "block_tool", reason, severity: "hard-block", ...marker }];
	};

	const readCoverageEffects = (input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> => {
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		const reset = () => {
			redundantReadsByTurn.delete(turnKey);
			return [];
		};
		// Only a read that may have shown new lines ends a redundant run: a
		// grep between two rereads of one range is still a reread (X5). A
		// failed read showed nothing; an ok read this guard cannot measure may
		// have shown new lines, so it resets.
		if (input.toolName !== ToolNames.Read || input.metadata?.resultKind !== "ok") return [];
		const details = input.toolResultDetails;
		const file = details?.file as { bytes?: unknown; mtimeMs?: unknown } | undefined;
		const observation = details?.observation as
			| { tool?: unknown; unit?: unknown; format?: unknown; shownCount?: unknown; truncated?: unknown }
			| undefined;
		const path = input.toolArgs?.path;
		const offset = input.toolArgs?.offset ?? 1;
		const resultBytes = input.metadata?.resultBytes;
		// after_tool precedes the registry's final shaping pass. If that pass
		// could shorten the source, its pre-shaping line count is not evidence.
		// A getter that throws turns coverage off for this read, not the rest of after_tool.
		let shapingCap: number | undefined;
		try {
			shapingCap =
				typeof options.readResultMaxBytes === "function" ? options.readResultMaxBytes() : options.readResultMaxBytes;
		} catch {
			return reset();
		}
		const deliveredCap = Math.min(shapingCap ?? 0, resolveGuardrail("readMaxBytes"));
		if (
			!Number.isFinite(deliveredCap) ||
			deliveredCap <= 0 ||
			typeof resultBytes !== "number" ||
			!Number.isFinite(resultBytes) ||
			resultBytes > deliveredCap ||
			typeof path !== "string" ||
			input.toolArgs?.tail !== undefined ||
			typeof offset !== "number" ||
			!Number.isSafeInteger(offset) ||
			offset < 1 ||
			typeof file?.bytes !== "number" ||
			!Number.isFinite(file.bytes) ||
			typeof file.mtimeMs !== "number" ||
			!Number.isFinite(file.mtimeMs) ||
			details?.fileChange !== undefined ||
			observation?.tool !== ToolNames.Read ||
			observation.unit !== "lines" ||
			observation.format !== "text" ||
			typeof observation.shownCount !== "number" ||
			!Number.isSafeInteger(observation.shownCount) ||
			observation.shownCount <= 0
		)
			return reset();
		// A byte-truncated final line may only be a prefix. Conservatively exclude
		// the last line of any truncated window from previously observed coverage.
		const end = offset + observation.shownCount - 1;
		const coveredEnd = end - (observation.truncated === true ? 1 : 0);
		if (!Number.isSafeInteger(end)) return reset();
		// Use the same path resolution as read (including symlinks and aliases).
		// Numbered output is separate evidence: the first citation reread is useful.
		let canonicalPath: string;
		try {
			canonicalPath = resolveReadPath(path);
		} catch {
			return reset();
		}
		// A PDF page range or an archive member renders its own numbered lines, so
		// each is separate coverage, keyed as read normalizes them.
		const pages = input.toolArgs?.pages;
		const member = input.toolArgs?.member;
		const document = JSON.stringify([
			typeof pages === "string" && pages.trim().length > 0 ? pages : null,
			typeof member === "string" && member.length > 0 ? member : null,
		]);
		const key = `${turnKey}\0${canonicalPath}\0${input.toolArgs?.line_numbers === true}\0${document}`;
		let entry = readCoverage.get(key);
		if (!entry || entry.bytes !== file.bytes || entry.mtimeMs !== file.mtimeMs) {
			entry = { bytes: file.bytes, mtimeMs: file.mtimeMs, ranges: [] };
		}
		const redundant = entry.ranges.some(([start, stop]) => start <= offset && stop >= end);
		// Even a possibly partial one-line result is redundant when an earlier
		// complete read already covered that line. It need not add new coverage.
		const ranges: Array<[number, number]> = [...entry.ranges];
		if (coveredEnd >= offset) ranges.push([offset, coveredEnd]);
		ranges.sort((a, b) => a[0] - b[0]);
		entry.ranges = [];
		for (const range of ranges) {
			const last = entry.ranges.at(-1);
			if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
			else entry.ranges.push(range);
		}
		// Forget excess evidence conservatively instead of retaining unbounded state.
		entry.ranges = entry.ranges.slice(-SUCCEEDED_FINGERPRINT_LIMIT);
		readCoverage.delete(key);
		if (readCoverage.size >= SUCCEEDED_FINGERPRINT_LIMIT) {
			const oldest = readCoverage.keys().next().value;
			if (oldest !== undefined) readCoverage.delete(oldest);
		}
		readCoverage.set(key, entry);
		if (!redundant) return reset();
		const streak = bumpBoundedCounter(redundantReadsByTurn, turnKey);
		if (streak < RESULT_STAGNATION_THRESHOLD || lockoutByTurn.has(turnKey)) return [];
		// The read already ran and remains successful. The threshold is an
		// annotation (DESIGN 3.5): it spends no loop block budget and cannot
		// lock the turn, and the count starts over once it fires. The text is
		// advice: wording a model can read as a block makes it report one (ACP-H5).
		redundantReadsByTurn.delete(turnKey);
		return [
			{
				kind: "annotate_tool_result",
				message: "These lines were already shown in this turn; reuse them unless the file changed.",
				severity: "warn",
			},
		];
	};

	// Read's typed EOF result proves that changing offsets cannot reveal more
	// content in this file version. Error strings contain offsets and therefore
	// cannot use the byte-identical successful-result detector.
	const readEofEffects = (input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> => {
		const turnKey = input.turnId ?? NO_TURN_BUCKET;
		const details = input.toolResultDetails;
		const file = details?.file as { bytes?: unknown; mtimeMs?: unknown } | undefined;
		if (
			input.toolName !== ToolNames.Read ||
			input.metadata?.resultKind !== "error" ||
			details?.code !== "read_past_eof" ||
			typeof input.toolArgs?.path !== "string" ||
			typeof file?.bytes !== "number" ||
			!Number.isFinite(file.bytes) ||
			typeof file.mtimeMs !== "number" ||
			!Number.isFinite(file.mtimeMs) ||
			typeof details.totalLines !== "number" ||
			!Number.isSafeInteger(details.totalLines) ||
			details.totalLines < 0
		) {
			eofByTurn.delete(turnKey);
			return [];
		}
		let path: string;
		try {
			path = resolveReadPath(input.toolArgs.path);
		} catch {
			eofByTurn.delete(turnKey);
			return [];
		}
		const identity = JSON.stringify([path, file.bytes, file.mtimeMs, details.totalLines]);
		const previous = eofByTurn.get(turnKey);
		const streak = previous?.identity === identity ? previous.streak + 1 : 1;
		if (!eofByTurn.has(turnKey) && eofByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
			const oldest = eofByTurn.keys().next().value;
			if (oldest !== undefined) eofByTurn.delete(oldest);
		}
		eofByTurn.set(turnKey, { identity, streak });
		if (streak < 2 || lockoutByTurn.has(turnKey)) return [];
		const reason = `loop detected: ${streak} consecutive reads went past the end of the same unchanged file. Changing offset or limit cannot reveal more content. Reuse the evidence already returned and synthesize the answer.`;
		return blockAsLoop(input, turnKey, ToolNames.Read, streak, reason, options.now?.() ?? Date.now()).map((effect) =>
			effect.kind === "block_tool"
				? { kind: "annotate_tool_result" as const, message: effect.reason, severity: "warn" as const }
				: effect,
		);
	};

	return {
		id: LOOP_GUARD_REGISTRATION_ID,
		description:
			"blocks repeated tool calls, enforces tool-call caps, and annotates substantial identical read results across distinct arguments",
		hooks: ["before_tool", "after_tool", "on_compaction"],
		evidence: "count:repeated-call@tool-args",
		callCount: () => count,
		turnMeter: (settledSinceSubmit, fallbackBudget) => {
			// A fresh submit has settled nothing yet and the guard still holds the last turn: show the new turn at zero.
			if (latestTurnBudget === undefined || settledSinceSubmit === 0) {
				return { toolCalls: settledSinceSubmit, budget: latestTurnBudget?.soft ?? fallbackBudget };
			}
			return { toolCalls: callsByTurn.get(latestTurnBudget.key) ?? 0, budget: latestTurnBudget.soft };
		},
		mutationEpoch: (turnId) => mutationEpochByTurn.get(turnId) ?? 0,
		evaluate(hookInput): ReadonlyArray<MiddlewareEffect> {
			if (hookInput.hook === "on_compaction") {
				// A fold removed results whose lines coverage counts as shown, so a
				// later reread is not redundant (X5). A recall only adds context, and
				// a superseded result leaves the later identical call's lines in place.
				const stage = hookInput.metadata?.stage;
				if (stage !== "working_set_recall" && stage !== "superseded") {
					readCoverage.clear();
					redundantReadsByTurn.clear();
				}
				return [];
			}
			// A nested invocation (the gateway calling the capability the model
			// asked for) is the same model call the outer gateway occurrence
			// already counted and fingerprinted. Counting it again would spend
			// the worker cap and the turn budget twice per gateway call, and its
			// inner fingerprint would never repeat across a model's retries the
			// outer one does not already show.
			// Harness work is independent of the model, so it cannot spend its budget or seed repeat history.
			if (hookInput.metadata?.nested === true || hookInput.metadata?.origin === "harness") return [];
			// Judge that outer op=call as the capability it runs. The coordinator
			// reaches monitor, bash and the search tools only this way, and the
			// collect exemption, size-only stagnation and mutation epochs key on
			// the capability and its own arguments. Unwrapping from arguments
			// alone keeps before_tool and after_tool fingerprints identical, and
			// the repeat fingerprint is re-derived the same way so the repeat
			// detector and the success memory share one identity (#F8). A bash call
			// is re-derived too, so a leading cd into its own directory drops (XR-9).
			const unwrapped = effectiveToolCall(hookInput.toolName ?? "", hookInput.toolArgs);
			const input: MiddlewareHookInput =
				unwrapped.viaGateway || unwrapped.toolName === ToolNames.Git || unwrapped.toolName === ToolNames.Bash
					? {
							...hookInput,
							toolName: unwrapped.toolName,
							toolArgs: unwrapped.args ?? {},
							...(typeof hookInput.metadata?.callFingerprint === "string"
								? {
										metadata: {
											...hookInput.metadata,
											callFingerprint: callIdentity(unwrapped.toolName, unwrapped.args),
										},
									}
								: {}),
						}
					: hookInput;
			if (input.hook === "after_tool" && isGatewayChain(hookInput.toolName ?? "", hookInput.toolArgs)) {
				// A chain's completion is aggregate bookkeeping. Each step already ran
				// its own after_tool as the capability it is, so the steps own the
				// progress signals (stagnation, identical-result streaks, read
				// coverage, EOF streaks, recovery and mutation epochs); letting the
				// aggregate record them would overwrite the streak its steps built,
				// which is how a wrapped grep escaped stagnation (#F4). The wrapper
				// keeps only its success memory for a verbatim repeat of the whole plan.
				recordSuccessfulResult(input);
				return [];
			}
			if (input.hook === "after_tool") {
				const turnKey = input.turnId ?? NO_TURN_BUCKET;
				if (
					typeof input.metadata?.templateStepTool === "string" &&
					input.toolName === input.metadata.templateStepTool &&
					input.metadata.resultKind === "ok" &&
					!stepByTurn.has(turnKey)
				) {
					while (stepByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
						const oldest = stepByTurn.keys().next().value;
						if (typeof oldest !== "string") break;
						stepByTurn.delete(oldest);
					}
					stepByTurn.set(turnKey, "done");
				}
				if (input.toolCallId !== undefined) admittedCalls.delete(`${turnKey}\0${input.toolCallId}`);
				const inFlight = stepInFlightByTurn.get(turnKey);
				if (
					inFlight !== undefined &&
					input.toolName === input.metadata?.templateStepTool &&
					inFlight.call === input.toolCallId
				)
					stepInFlightByTurn.delete(turnKey);
				const judgement = input.toolResultDetails?.judgement as { execution?: unknown } | undefined;
				if (
					options.toolCallCap !== undefined &&
					input.toolName === ToolNames.Verify &&
					judgement?.execution === "unavailable" &&
					// A runner that rejected its arguments runs with others, so only the entry's own startup failure locks it (L10).
					input.toolResultDetails?.usageError !== true
				) {
					for (const id of [input.toolResultDetails?.check, input.toolArgs?.check]) {
						if (typeof id === "string" && id.trim()) {
							unavailableChecks.set(
								`${turnKey}\0${id.trim()}`,
								typeof input.metadata?.errorMessage === "string" ? input.metadata.errorMessage : "runner unavailable",
							);
						}
					}
				}
				const blocked = lastBlockedCallByTurn.get(turnKey);
				// Any other call that ran breaks a run of identical blocks.
				if (
					input.toolName !== undefined &&
					identicalBlockStreakByTurn.get(turnKey)?.identity !== callIdentity(input.toolName, input.toolArgs)
				) {
					identicalBlockStreakByTurn.delete(turnKey);
				}
				const workspaceMutated = recordWorkspaceMutation(input);
				recordMonitorCollectProgress(input);
				if (
					blocked !== undefined &&
					(workspaceMutated || (input.metadata?.resultKind === "ok" && resultCarriesEvidence(input.toolResultDetails))) &&
					input.toolResultDetails?.unchanged !== true &&
					input.toolName !== undefined &&
					input.toolName !== ToolNames.Read &&
					callIdentity(input.toolName, input.toolArgs) !== blocked
				) {
					// A different productive call is evidence of recovery; give the
					// model another chance before a turn-wide synthesis lockout.
					blocksByTurn.delete(turnKey);
					lastBlockedCallByTurn.delete(turnKey);
				}
				recordSuccessfulResult(input);
				recordResultForStagnation(input);
				if (recordRepeatCredit(input)) stagnationByTurn.delete(turnKey);
				const effects = [...crossArgumentResultEffects(input), ...readCoverageEffects(input), ...readEofEffects(input)];
				if (!advisoryEmitted && count >= (options.toolCallSoftLimit ?? options.toolCallCap ?? Infinity)) {
					advisoryEmitted = true;
					effects.push({
						kind: "annotate_tool_result",
						message: `Advisory tool estimate reached (${count} calls). Reassess remaining work and finish the assignment; tools remain available${options.toolCallCeiling !== undefined ? ` until the hard ceiling of ${options.toolCallCeiling} calls` : ""}. Explicit task requirements still apply.`,
						severity: "warn",
					});
				}
				// One-shot reserve directive: the first executed call inside the
				// reserve window carries the steering annotation, so the model is
				// told about the reserve without a blocked call spending budget.
				if (
					reserveThreshold !== null &&
					cap !== undefined &&
					!reserveDirectiveEmitted &&
					count > reserveThreshold &&
					count <= cap
				) {
					reserveDirectiveEmitted = true;
					effects.push({
						kind: "annotate_tool_result",
						message: workerSynthesisReserveDirective(Math.max(0, cap - count), cap),
						severity: "warn",
					});
				}
				return effects;
			}
			const now = options.now?.() ?? Date.now();
			const turnKey = input.turnId ?? NO_TURN_BUCKET;
			const callKey = input.toolCallId === undefined ? undefined : `${turnKey}\0${input.toolCallId}`;
			// A rewrite's second judgement: only the checks that read the arguments run again.
			const rejudge = callKey !== undefined && admittedCalls.has(callKey);
			// Every step of a chain is judged and charged as the capability it runs
			// (the gateway invokes each one with nested: false), so the wrapper is
			// not charged too: an N-step chain spends N units of the worker cap and
			// the turn budget, as N plain calls do, where charging the wrapper made
			// it N + 1 and ran chain-heavy turns into the soft budget (bt-14). The
			// wrapper still passes every lockout, the repeat detector for a verbatim
			// repeat of the whole plan, and the turn budget once that is spent, where
			// a refused wrapper is an attempt like any other refused call.
			const chainWrapper = isGatewayChain(hookInput.toolName ?? "", hookInput.toolArgs);
			const turnBudgetEffects = (): ReadonlyArray<MiddlewareEffect> => {
				if (rejudge) return [];
				// A run that spent its turn's calls can still declare how it ended: a direct `finish` called alone past the soft
				// budget or the hard ceiling runs and spends nothing, at most FINISH_ATTEMPTS_PAST_BUDGET times a turn, so an
				// invalid or varying declaration cannot spin. A gateway-wrapped finish cannot run, and a finish in a wider
				// batch would end the turn over its refused siblings, so both count as any call does; the repeat and
				// stagnation detectors still see every attempt (CLI-P43).
				const batched = typeof input.metadata?.batchSize === "number" && input.metadata.batchSize > 1;
				if (hookInput.toolName === ToolNames.Finish && !batched) {
					const soft = resolveTurnBudget(input)?.budget.soft;
					const spent = callsByTurn.get(turnKey) ?? 0;
					if (
						soft !== undefined &&
						spent >= soft &&
						(finishesPastBudgetByTurn.get(turnKey) ?? 0) < FINISH_ATTEMPTS_PAST_BUDGET
					) {
						bumpBoundedCounter(finishesPastBudgetByTurn, turnKey);
						return [];
					}
				}
				if (chainWrapper) {
					const soft = resolveTurnBudget(input)?.budget.soft;
					if (
						soft === undefined ||
						((callsByTurn.get(turnKey) ?? 0) < soft && refusedBudgetBatch(input, turnKey, soft) === null)
					)
						return [];
				}
				return evaluateTurnBudget(input, now) ?? [];
			};
			const decide = (): ReadonlyArray<MiddlewareEffect> => {
				// DF-10: startup failures belong to the entry, not to its test arguments or cwd.
				let check = typeof input.toolArgs?.check === "string" ? input.toolArgs.check.trim() : "";
				let unavailable = input.toolName === ToolNames.Verify ? unavailableChecks.get(`${turnKey}\0${check}`) : undefined;
				if (input.toolName === ToolNames.Verify && check && unavailable === undefined && unavailableChecks.size > 0) {
					const resolution = resolveVerifyCall(process.cwd(), { ...input.toolArgs });
					if ("check" in resolution) {
						check = resolution.check.id;
						unavailable = unavailableChecks.get(`${turnKey}\0${check}`);
					}
				}
				if (unavailable !== undefined && capLockout === null && !lockoutByTurn.has(turnKey)) {
					return blockAsLoop(
						input,
						turnKey,
						ToolNames.Verify,
						2,
						`verify: unavailable '${check}' was already reported in this run. Rerunning this entry with other arguments or cwd cannot help; follow the previous error. Previous error: ${unavailable}`,
						now,
					);
				}
				// Once a synthesis phase begins, sibling calls from the already-emitted
				// parallel batch are denied without consuming the lifetime cap or the
				// per-round non-compliance backstop.
				if (capLockout !== null && cap !== undefined && !rejudge) {
					if (reachesLockoutBackstop(capLockout, input)) {
						return [
							{ kind: "block_tool", reason: synthesisBackstopReason(input.toolName ?? "unknown"), severity: "hard-block" },
						];
					}
					return [{ kind: "block_tool", reason: workerToolCallCapSynthesisReason(cap), severity: "hard-block" }];
				}

				// Synthesis lockout after repeated calls. Check before counting the
				// attempt so a wide parallel batch cannot turn a graceful lock into a
				// lifetime-cap failure before the model gets its synthesis round.
				const lockout = synthesisLockout && !rejudge ? lockoutByTurn.get(turnKey) : undefined;
				// The other calls of the batch that held the turn's first block were
				// emitted before the model saw any block; refusing them all for one
				// sibling's repeat lost a drive's final next_step (WTF-P 0.8.3 A2).
				const exemptSibling = lockout?.exemptBatch !== undefined && input.correlationId === lockout.exemptBatch;
				if (lockout !== undefined && !exemptSibling) {
					if (reachesLockoutBackstop(lockout, input)) {
						emitLoopBlocked(
							input,
							{
								tool: lockout.tool,
								repeatCount: lockout.repeatCount,
								blocksThisTurn: lockout.blocksThisTurn,
								disposition: "stop",
							},
							now,
						);
						return [{ kind: "block_tool", reason: synthesisBackstopReason(lockout.tool), severity: "hard-block" }];
					}
					return [{ kind: "block_tool", reason: synthesisLockoutDirective(), severity: "hard-block" }];
				}

				const step = evaluateStepPolicy(input, turnKey, now);
				if (step !== null) return step;

				// Synthesis reserve (workers): the tail of the lifetime cap is held for
				// verification reads and delivery. Discovery calls bounce with a
				// steering reason that never carries the cap's machine prefix, so cap
				// telemetry, worker aborts, and A2's cap-exhaustion notice stay
				// untouched; reads and this agent's delivery tools keep flowing through
				// the repetition and stagnation detectors below. The refusal is resolved
				// before the call is counted: a call the harness refused never ran, so it
				// does not spend the lifetime cap. The bound on refusals is reserveDenials
				// and the synthesis backstop, both per model round.
				if (
					reserveThreshold !== null &&
					cap !== undefined &&
					!rejudge &&
					count >= reserveThreshold &&
					!reserveAdmits(input.toolName)
				) {
					if (reachesLockoutBackstop(reserveDenials, input)) {
						if (synthesisLockout) {
							capLockout = {
								denials: 0,
								...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
							};
							options.onSynthesisLockout?.();
						}
						return [{ kind: "block_tool", reason: workerToolCallCapSynthesisReason(cap), severity: "hard-block" }];
					}
					return [
						{
							kind: "block_tool",
							reason: workerSynthesisReserveBlockReason(input.toolName ?? "unknown", Math.max(1, cap - count), cap),
							severity: "hard-block",
						},
					];
				}

				if (!rejudge && !chainWrapper) count += 1;
				reserveDenials = { denials: 0 };
				if (cap !== undefined && count > cap) {
					// No tool body executes past the cap. With the synthesis lockout
					// wired the run is not aborted on the spot: the first crossing flips
					// the request-level tool lock (onSynthesisLockout) and directs the
					// model to answer from what it gathered; a model that keeps emitting
					// tool calls anyway reaches the bounded backstop, whose reason the
					// worker runtime recognizes and aborts on. Parallel calls crossing
					// the cap in one batch enter the lockout exactly once.
					if (!synthesisLockout) {
						return [{ kind: "block_tool", reason: workerToolCallCapExceededReason(cap), severity: "hard-block" }];
					}
					capLockout = {
						denials: 0,
						...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
					};
					options.onSynthesisLockout?.();
					return [{ kind: "block_tool", reason: workerToolCallCapSynthesisReason(cap), severity: "hard-block" }];
				}

				// Idempotent read-only polls may return the same cursor indefinitely.
				// They still spend the worker cap and the per-turn soft/hard budget.
				if (input.metadata?.repeatableRead === true) return turnBudgetEffects();

				// Identical-repeat detection runs BEFORE the volume budget so verbatim
				// retries of budget-blocked calls still reach the detector. Its tighter
				// interrupt (a couple of blocks per turn) is what ends the retry spiral
				// a weak model falls into once the budget starts rejecting calls;
				// checking the budget first starved the detector and let that spiral
				// churn all the way to the hard ceiling.
				const fingerprint = input.metadata?.callFingerprint;
				if (typeof fingerprint !== "string" || fingerprint.length === 0) {
					return turnBudgetEffects();
				}
				// The detector key is turn-scoped: its state lives for the whole
				// session, and the detector now retains the most recent attempts
				// regardless of age, so an unscoped key would let one identical call
				// per user turn (rerunning a build across turns) accumulate into a
				// false loop.
				// The epoch scopes repeats to "since the last parent-workspace
				// mutation": a live session repeated a batch of eleven read-only bash
				// calls five times, every one admitted, because the detector kept
				// only a 30 s window or the last four attempts and no batch ever
				// showed a third repeat inside either.
				const epoch = repeatEpoch(turnKey, callIdentity(input.toolName ?? "", input.toolArgs));
				// A successful collect that observed fewer pending runs restarts only
				// this collect call; other tools retain their normal repeat keys.
				const collectEpoch =
					input.toolName === ToolNames.Monitor && input.toolArgs?.mode === "collect"
						? (monitorCollectProgress.get(monitorCollectKey(turnKey, input.toolArgs))?.epoch ?? 0)
						: null;
				const credit =
					input.toolName !== undefined
						? repeatCredit.get(repeatCreditKey(turnKey, input.toolName, input.toolArgs))
						: undefined;
				const creditEpoch = credit?.epoch ?? 0;
				const repeatKey =
					collectEpoch === null
						? `${turnKey}|${epoch}|${creditEpoch}|${fingerprint}`
						: `${turnKey}|${epoch}|collect:${collectEpoch}|${fingerprint}`;
				// An extension tool declared neither read-only nor idempotent, such as
				// a desk's next_step, answers the same arguments with a new step, so a
				// verbatim repeat is not a loop. Stagnation and the turn budget still
				// bound it (F-C13).
				const repeatCandidate = !(
					input.toolName !== undefined &&
					isHarnessExtensionToolName(input.toolName) &&
					input.metadata?.toolReadOnly === false &&
					input.metadata?.toolIdempotent === false
				);
				const verdict = repeatCandidate ? options.safety.observeLoop(repeatKey, now) : null;
				if (verdict?.looping === true) {
					const tool = input.toolName ?? "unknown";
					const priorSuccesses = succeededFingerprints.get(fingerprint) ?? 0;
					return blockAsLoop(
						input,
						turnKey,
						tool,
						verdict.count,
						loopBlockBaseReason(
							tool,
							verdict.count,
							priorSuccesses,
							failedResults.get(fingerprint),
							credit?.repeatedResult === true,
						),
						now,
						priorSuccesses > 0,
					);
				}

				// Stagnation detection: the incoming call has the same shape (size
				// args ignored) as a streak of calls whose results hashed identical.
				// The escalation cycle (limit: 10k -> 20k -> 50k -> 10k ...) varies
				// arguments enough to evade the verbatim detector while never
				// producing new information; block the attempt the streak proves
				// futile.
				const toolName = input.toolName;
				if (typeof toolName === "string" && toolName.length > 0) {
					const entry = stagnationByTurn.get(turnKey);
					if (
						entry !== undefined &&
						entry.streak >= RESULT_STAGNATION_THRESHOLD - 1 &&
						entry.reducedFingerprint === stagnationFingerprint(toolName, input.toolArgs)
					) {
						return blockAsLoop(
							input,
							turnKey,
							toolName,
							entry.streak + 1,
							stagnationBlockReason(toolName, input.toolArgs, entry.streak),
							now,
						);
					}
				}
				return turnBudgetEffects();
			};
			const verdict = boundRunDenials(decide(), input);
			const admitted = !verdict.some((effect) => effect.kind === "block_tool");
			if (callKey !== undefined) {
				if (!admitted) admittedCalls.delete(callKey);
				else if (!rejudge) bumpBoundedCounter(admittedCalls, callKey, SUCCEEDED_FINGERPRINT_LIMIT);
			}
			const stepTool = input.metadata?.templateStepTool;
			if (typeof stepTool === "string" && input.toolName === stepTool && !stepByTurn.has(turnKey) && admitted) {
				while (!stepInFlightByTurn.has(turnKey) && stepInFlightByTurn.size >= LOOP_GUARD_TURN_LIMIT) {
					const oldest = stepInFlightByTurn.keys().next().value;
					if (typeof oldest !== "string") break;
					stepInFlightByTurn.delete(oldest);
				}
				stepInFlightByTurn.set(turnKey, {
					...(input.correlationId !== undefined ? { batch: input.correlationId } : {}),
					...(input.toolCallId !== undefined ? { call: input.toolCallId } : {}),
				});
			}
			return verdict;
		},
	};
}

function isReserveAdmittedTool(tool: string | undefined, deliveryTools: ReadonlyArray<string>): boolean {
	return tool === ToolNames.Read || (tool !== undefined && deliveryTools.includes(tool));
}

export function resolveDeliveryTools(
	allowedTools: ReadonlyArray<string> | ReadonlySet<string>,
	product?: AgentProduct,
): string[] {
	const candidates: string[] =
		product === "orientation" ? [ToolNames.Write, ToolNames.Edit, ToolNames.CodeNav] : [ToolNames.Write, ToolNames.Edit];
	if (allowedTools instanceof Set) {
		return candidates.filter((tool) => allowedTools.has(tool));
	}
	return candidates.filter((tool) => (allowedTools as ReadonlyArray<string>).includes(tool));
}
