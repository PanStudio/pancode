// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { TurnAnswerEntry } from "../../core/answer-segments.js";
import type { CompletionDeclaration } from "../../core/completion.js";
import type { ModelRouteRefusal } from "../../core/response-model-id.js";
import type { PendingSkillRequest, SkillActivation } from "../../core/skill-activation.js";
import type { CallFilter } from "../../core/telemetry/dto.js";
import type { EconomyProjection } from "../../core/telemetry/economy.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import type { RunCallUsage, runUsageFromCalls } from "../../domains/dispatch/run-call-usage.js";
import type { VerifyCallOutcome, VerifyCallStart } from "../../domains/dispatch/run-findings.js";
import type {
	RunResultCostCap,
	RunResultSafetySummary,
	SafetyBlockedAttempt,
	ToolCallStat,
} from "../../domains/dispatch/types.js";
import type { AutonomyHalt, AutonomyReport } from "../../domains/safety/autonomy-window.js";
import type { RunEffectsRecorder } from "../../domains/safety/run-effects.js";
import type { AgentMessage, ImageContent, ToolRoundRecord } from "../../engine/types.js";
import type { HeadlessRunDeadline } from "../../entry/boot-options.js";
import type { ReloadReport, ReloadTarget } from "../../session-control/reload-report.js";
import type { ScriptedAnswers } from "../run-answers.js";

import type { RunJsonMainSessionFrame, RunJsonSegmentUsage } from "./run-json-schema.js";
import type { HeadlessVerifyOptions } from "./run-verify.js";

export interface HeadlessSamplingOverrides {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repeatPenalty?: number;
}

/**
 * The shutdown seam a headless turn needs: somewhere to register the drain
 * hook that records an interrupted run's ledger row, and the exit code that
 * shutdown will report. Defaults to the process termination coordinator.
 */
export interface HeadlessShutdownHooks {
	onDrain(hook: () => void | Promise<void>, options?: { timeoutMs: number }): void;
	/** Hooks run synchronously when a second signal forces the exit; returns an unsubscribe. */
	onForceExit?(hook: () => void): () => void;
	getExitCode(): number;
	/** True once a signal or quit started the coordinated shutdown. */
	isShuttingDown(): boolean;
}

export interface HeadlessMainAgentOptions {
	prompt: string;
	/**
	 * `run --output-schema` (SPEC 6.8): the checked schema. The host validates the final answer, sends one repair
	 * turn with no tools on a mismatch, and fails the run `schema_mismatch` when the repair does not match either.
	 */
	outputSchema?: Record<string, unknown>;
	/** The line the operator typed when `prompt` is its expansion; prompt_submit hooks judge this line. */
	display?: { text: string; note?: string };
	constraints?: TurnConstraints;
	images?: ReadonlyArray<ImageContent>;
	workingContextPaths?: ReadonlyArray<string>;
	sampling?: HeadlessSamplingOverrides;
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	mode?: "text" | "json";
	/** A route borrowed for this run only, written as the first notice frame in JSON mode. */
	routeNotice?: string;
	steerChannel?: string;
	/** A `/reload [target]` line on the steer channel runs this instead of steering. */
	reload?: (target: ReloadTarget) => Promise<ReloadReport>;
	getSessionHeader?: () => RunJsonMainSessionFrame | null;
	shutdown?: HeadlessShutdownHooks;
	/**
	 * Also fail when all attempted tools failed without a block. Blocked runs
	 * without recovery or a successful write, and explicit limitations, fail unconditionally.
	 */
	failOnNoop?: boolean;
	/** `--fail-on-verify`: a `--verify` check that failed or timed out fails the run (`verify_failed`). */
	failOnVerify?: boolean;
	/**
	 * Unpriced routes the run can reach: `main` is chat and compaction, `delegating` adds the fleet's. Read only under
	 * `run --require-priced`, which refuses before the turn when any is listed (SPEC 6.9).
	 */
	unpricedRoutes?: (reach: "main" | "delegating") => string[];
	/** `--on-permission`: `fail` ends the run with exit 3 at the first ask a headless run refuses; `deny` is today's. */
	onPermission?: "deny" | "fail";
	/**
	 * `pancode run --timeout`. When it expired, the shutdown it started seals
	 * outcome `timed_out` instead of `canceled`, so a driver can tell its own
	 * wall-clock limit from an external signal.
	 */
	deadline?: HeadlessRunDeadline;
	/** `pancode run --verify`: acceptance checks the run itself runs once the turn settled. */
	verify?: Omit<HeadlessVerifyOptions, "base" | "scratchDir">;
	/** The session's active path, so the run can say which checks it saw stand (`observed:` on stderr). */
	readEntries?: () => ReadonlyArray<unknown>;
	/** `safety.scratchRoots`: a check logged under one changes no tree (x5-4). */
	scratchRoots?: ReadonlyArray<string>;
	/**
	 * The dispatch ledger. When present, the run waits for the workers it
	 * dispatched before sealing and fails when one did not deliver (D3, D6b).
	 */
	dispatch?: Pick<DispatchContract, "listRuns">;
	/**
	 * Subscribes to dispatch scope notices on the bus. Text mode writes each to
	 * stderr and `--json` carries it as a `dispatch_scope_notice` event, so a
	 * run with no operator still says what a dispatch's scope entry did.
	 */
	scopeNotices?: (listener: (payload: unknown) => void) => () => void;
	/**
	 * The run's usage as the read model folds the session calls it made from `from` on: its turn's calls and the
	 * compactions it ran, which happen outside the turn's event stream. run.settled and the ledger row both settle
	 * from it, so they agree; null when no read model is bound, and the message fold stands for the row (#434).
	 * `roles` widens the fold past the run's own main and compaction calls, for a schema v2 envelope's children.
	 */
	runUsage?: (from: string, roles?: CallFilter["roles"]) => Promise<RunCallUsage | null>;
	/**
	 * The same calls `runUsage` folds, folded by the economy projection (token economy S10): what the envelope's usage
	 * scopes carry as `economics`; null when no read model is bound.
	 */
	runEconomy?: (from: string, roles: CallFilter["roles"]) => Promise<EconomyProjection | null>;
	/** `safety.limits.sessionCostUsd` as this run reads it, for a session-ceiling refusal's basis. */
	sessionCostCeilingUsd?: () => number;
	/**
	 * One agent segment's usage as the read model folds its calls once they are journaled, an interrupted call's
	 * estimate included; null when the read model has none, and the message fold stands (#434).
	 */
	segmentUsage?: (messages: ReadonlyArray<AgentMessage>) => Promise<RunJsonSegmentUsage | null>;
	/** `pancode run --max-cost-usd`: the cap the run ran under. */
	costCap?: RunResultCostCap;
	/** The yolo pause that stopped the run, if any: exit 4 for a cap, 3 for a judge streak (ob-yolo D4, D6). */
	autonomyHalt?: () => AutonomyHalt | null;
	/** The yolo audit for `--json`: null when the run never ran at yolo (ob-yolo D7). */
	autonomy?: () => AutonomyReport | null;
	/** `--answers`: a question the file does not script stops the turn and fails the run with exit 5 (WTF-P 0.8.3 B1). */
	answers?: ScriptedAnswers;
}

export interface HeadlessMainAgentResult {
	/** Latest assistant stop, superseded by subsequent continuation messages. */
	outputExhausted: boolean;
	/** The final user turn's replies (CLI-P43); never narration. Every output reads `printedAnswer`, not this. */
	text: string;
	/** Text the turn wrote beside a tool call, kept only for the ended-quietly diagnostic on stderr. */
	narration: string;
	/** The final user turn's settled assistant messages and citation checks, from which `text` is read (CLI-P43). */
	answerEntries: TurnAnswerEntry[];
	/** The terminating tool was `finish`, which closes the turn's replies instead of replacing them. */
	terminatedByFinish: boolean;
	error: string | null;
	/**
	 * True when the most recent tool result ended the turn via
	 * `ToolResult.terminate` (artifact plan/review/report) with no error. These
	 * tools are the whole turn by design: the agent loop skips the follow-up
	 * call that would otherwise produce assistant text, so an empty `text`
	 * here is the turn completing exactly as intended, not a missing
	 * response.
	 */
	sawTerminatingToolResult: boolean;
	/** The completion the agent declared through `finish` (fleet design 4.3), from the tool's settled result. */
	completion: CompletionDeclaration | null;
	/**
	 * What that terminating tool returned ("wrote plan artifact (572B) to
	 * PLAN.md"). The turn ends there by design, so this text is the whole
	 * answer: without it a text-mode run wrote the artifact, said nothing, and
	 * exited 0, and a run that had chattered before calling the tool printed
	 * that mid-workflow line as if it were the reply.
	 */
	terminatingToolText: string;
	/**
	 * The interrupt reason from a cancelled turn (`notice` event keyed
	 * "turn.interrupted"). An interrupted turn always reports a nonzero exit
	 * with this reason, never a fabricated answer.
	 */
	abortReason: string | null;
	/** Most recent transcript notice; failure detail when the turn never answered. */
	lastNotice: string | null;
	/**
	 * The chat loop's report of a remember or forget it handled itself. A submission that was only that statement
	 * starts no model turn, so this report is the run's whole result.
	 */
	operatorMemory: { refused: boolean; text: string } | null;
	/** Why the last run ended without an answer, when it did. */
	noAnswer: string | null;
	/** The last run did real tool work and wrote no closing message, which is not a provider that went silent. */
	endedQuietly: boolean;
	/** The answer stands, but the calls it ended on were only written out and never ran. */
	callsNotRun: string | null;
	/**
	 * The chat loop refused the turn before any request (an admission notice):
	 * no target, no model, a context window it cannot fit, an image the route
	 * cannot read. Its notice is the failure, and text mode has already printed it.
	 */
	admissionRefused: boolean;
	/** The harness stopped the last reply (a repetition or tool-prose guard), so its error names no route (bt-26). */
	harnessStopped: boolean;
	/**
	 * The last reply ended on the context window, read from typed signals only (FX-22a): `guard` is the post-tool context
	 * guard's stop, which names no route; `recovery` is overflow recovery's notice that compaction could not make the
	 * refused request fit.
	 */
	contextOverflow: "guard" | "recovery" | null;
	/** The last reply was refused because its route names a model the provider does not serve (row 384). */
	modelRouteRefusal: ModelRouteRefusal | null;
	/** The latest assistant stop is a length stop that produced only thinking; the chat loop already spent its one recovery. */
	thinkingOnlyLength: boolean;
	/**
	 * The answer a citation check sent back for corrected line ranges, which a full stream's turn_end after the check
	 * carries (bt-29). The printed answer reads the check from `answerEntries` instead.
	 */
	citationCheckedAnswer: string | null;
}

export interface HeadlessMainAgentRunStats {
	toolRounds: ToolRoundRecord[];
	toolStats: Map<string, ToolCallStat>;
	pendingCapabilities: Map<string, string>;
	/** In-flight calls the loop guard reads as reads (`callRepeatsAsRead`), such as a read-only shell command (C-37). */
	readingCalls: Set<string>;
	pendingVerifyCalls: Map<string, VerifyCallStart>;
	verifyCalls: VerifyCallOutcome[];
	/** The run's workspace mutations, so a check is judged against the tree it ran on (bt-27c). */
	runEffects: RunEffectsRecorder;
	skillActivations: SkillActivation[];
	/** Every call the run made, as its settlement states it; the run's spend folds these (#434). */
	calls: Parameters<typeof runUsageFromCalls>[0][number][];
	/** Journal attempts already counted, so a call two messages carry counts once. */
	seenAttempts: Set<string>;
	/** The decision axis, counted the way a worker's settled run counts it. */
	decisions: RunResultSafetySummary["decisions"] & { guardBlocked: number };
	/**
	 * Every call whose outcome was blocked, except a tool guard's block and a refused ask, in a worker's settled shape,
	 * up to `BLOCKED_ATTEMPTS_LIMIT`.
	 */
	blockedAttempts: SafetyBlockedAttempt[];
	/** Blocked attempts past `BLOCKED_ATTEMPTS_LIMIT`, counted but not listed. */
	blockedAttemptsTruncated: number;
	/** The calls `decisions.guardBlocked` counts, up to `BLOCKED_ATTEMPTS_LIMIT`; the count stays exact. */
	guardBlockedAttempts: SafetyBlockedAttempt[];
	/** The blocked calls `decisions.permissionRequested` counts, up to `BLOCKED_ATTEMPTS_LIMIT`. */
	permissionRequestedAttempts: SafetyBlockedAttempt[];
	/** Those refused asks per tool, exact past the list's limit, so the sealed tools row subtracts them all (SC-2). */
	permissionRequestedByTool: Map<string, number>;
	/** The asks the safety judge allowed, each reason code naming its rule, up to `BLOCKED_ATTEMPTS_LIMIT`. */
	judgeAllowedAttempts: SafetyBlockedAttempt[];
	/** Paths a terminating result wrote: the turn's answer as a file, not a workspace change. */
	reportPaths: Set<string>;
	/** Dispatched runs whose task worktree merged into this workspace. */
	mergedTaskWorktrees: number;
	/** Paths dispatched runs placed in this checkout were observed to change, whatever each run's outcome. */
	delegatedChangedPaths: Set<string>;
	/** A call of a state-changing class succeeded, the main run's side of a worker's tool activity (C-37). */
	mutatingSucceeded: boolean;
	/** The run's `--read-only` scope: it can change nothing, so it owes no validation for a change (C-37). */
	readOnly: boolean;
	/** Blocked action classes not followed by successful substantive work of that class. */
	unresolvedBlocks: Set<string>;
	/**
	 * Why the last dispatch call failed, until a later dispatch succeeds or other substantive work succeeds. The
	 * delegated task is as unmet as a blocked call whether it never started (c16-B) or its workers started and failed.
	 */
	failedDispatch: { reason: string; started: boolean; canceled: boolean } | null;
	/**
	 * Whether the task asked for a change. An explicit `--turn-mode answer` or
	 * `proposal`, or the `--read-only` ceiling, says it did not; the no-op verdict
	 * applies only when it did.
	 */
	changeAsked: boolean;
	/**
	 * Recorded limitations that leave the task incomplete: every successful `limitation` call except one whose typed
	 * reason is `no-runner`, which says only that no check exists to run (row 382).
	 */
	incompleteLimitations: number;
}
