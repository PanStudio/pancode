// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { join } from "node:path";
import { readDispatchScopeNotice } from "../../core/dispatch-scope-notice.js";
import { reminderGist } from "../../core/reminder-gist.js";
import { runOverrides, withRunOverrides } from "../../core/run-overrides.js";
import { isUnreportedUsageNotice } from "../../core/telemetry/pricing.js";
import { getTerminationCoordinator } from "../../core/termination.js";
import { ToolNames } from "../../core/tool-names.js";
import { runCapStopCode } from "../../core/turn-constraints.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { runStatusForOutcome } from "../../domains/dispatch/outcome.js";
import { runUsageFromCalls } from "../../domains/dispatch/run-call-usage.js";
import { newRunId } from "../../domains/dispatch/state.js";
import type { RunResultOutput, ToolCallStat } from "../../domains/dispatch/types.js";
import { readToolRounds } from "../../domains/dispatch/types.js";
import {
	AUTONOMOUS_CAP_EXIT_CODE,
	AUTONOMY_JUDGE_STREAK_EXIT_CODE,
	autonomyHaltReason,
	headlessHaltNotice,
} from "../../domains/safety/autonomy-window.js";
import { standingDispatchRuns } from "../../domains/safety/observed-checks.js";
import { createRunEffectsRecorder, notRunCheckIds } from "../../domains/safety/run-effects.js";
import { SESSION_COST_CEILING_EXIT_CODE, SESSION_COST_CEILING_REASON } from "../../domains/scheduling/budget.js";
import { formatStatedWait } from "../../domains/session/retry.js";
import type { AgentMessage } from "../../engine/types.js";
import { createRedactionTally, redactSecretsText } from "../../lib/secrets/redact.js";
import { redactFinalUrlCredentials, redactSecretString, redactUrlCredentials } from "../../lib/secrets/redaction.js";
import type { ChatLoop } from "../../session-control/chat-loop.js";
import {
	messageCallSpends,
	type StructuredVerdict,
	schemaMismatchMessage,
	structuredRepairConstraints,
	structuredRepairPrompt,
	THINKING_LENGTH_STOP_REASON,
	validateStructuredAnswer,
} from "../../session-control/chat-loop-messages.js";
import { sealCompletion } from "../../tools/finish.js";
import { openSteerChannel } from "../headless-steer.js";
import { EXPLORATION_STALLED_EXIT_CODE } from "../kit/exit-codes.js";
import { flushRawStdout, writeRawStdout } from "../output-guard.js";
import { UNSCRIPTED_EXIT_CODE, unscriptedRunMessage } from "../run-answers.js";
import {
	noteDispatchRunsV2,
	noteDispatchSupersededV2,
	noteMainRunV2,
	noteRunCompletion,
	noteStructuredV2,
	noteTextAnswer,
	runResultV2Active,
	runTextSummaryRequested,
	writeRunRefusal,
} from "../run-failure.js";
import { sealedFactsNotVerified } from "../run-output.js";
import {
	type DispatchedRunsSettlement,
	describeRuns,
	projectDispatchedRunOutcome,
	settleDispatchedRuns,
	settledRunEnvelopes,
	settledRunUsage,
} from "./headless-dispatched-runs.js";
import { formatHeadlessObservedLine, observeHeadlessRun } from "./headless-observed.js";
import {
	printedAnswer,
	recordRunEffect,
	recordToolEnd,
	resultFromEvent,
	turnEndAfterCitationCheck,
} from "./headless-run-events.js";
import {
	countToolStats,
	type HeadlessStoredAnswer,
	type HeadlessTerminalOutcome,
	openRunningMainAgentRow,
	recordHeadlessMainAgentRun,
	SEGMENT_USAGE_WAIT_MS,
} from "./headless-run-record.js";
import type {
	HeadlessMainAgentOptions,
	HeadlessMainAgentResult,
	HeadlessMainAgentRunStats,
	HeadlessShutdownHooks,
} from "./headless-run-types.js";
import { noteRunUsageV2, runTextSummaryLine, runTextSummaryUsage } from "./headless-run-usage.js";
import {
	blockedCallsNotice,
	headlessNoop,
	noopFailureMessage,
	prefixHeadlessFailure,
	toolTotals,
	unmetWithoutChange,
	writtenPaths,
} from "./headless-run-verdict.js";
import { createHeadlessJsonProjector } from "./json-stream.js";
import { writeFrame } from "./jsonl.js";
import type { RunJsonMainFrame, RunJsonMainSessionFrame, RunJsonVerifyResult } from "./run-json-schema.js";
import { RUN_JSON_SCHEMA_VERSION } from "./run-json-schema.js";
import { verifyNotImplicated } from "./run-json-schema-v2.js";
import { formatHeadlessVerifyResult, runHeadlessVerifyChecks, verifyBaseOf } from "./run-verify.js";

/** `--on-permission fail` (SPEC 6.4): the approval-required exit a worker's refused ask already uses. */
const PERMISSION_REQUIRED_EXIT_CODE = 3;

function defaultShutdownHooks(): HeadlessShutdownHooks {
	const coordinator = getTerminationCoordinator();
	return {
		onDrain: (hook, drainOptions) => coordinator.onDrain(hook, drainOptions),
		onForceExit: (hook) => coordinator.onForceExit(hook),
		getExitCode: () => coordinator.getExitCode(),
		isShuttingDown: () => coordinator.getPhase() !== "idle",
	};
}

/** How every line this run writes to stderr starts. */
const RUN_STDERR_PREFIX = "pancode run: ";

export async function runHeadlessMainAgent(chat: ChatLoop, options: HeadlessMainAgentOptions): Promise<number> {
	/** The unscripted question that stopped the turn, and whether its cancel notice already told the operator. */
	let unscriptedStop = null as { text: string; told: boolean } | null;
	if (runOverrides().requirePriced === true) {
		const delegating = options.constraints?.delegation !== "forbidden";
		const unpriced = options.unpricedRoutes?.(delegating ? "delegating" : "main") ?? [];
		if (unpriced.length > 0) {
			writeRunRefusal(
				`pancode run: --require-priced: routes this run can reach have no known pricing: ${unpriced.join(", ")}; declare targets[].pricing for them${delegating ? " or add --no-delegate if only worker routes are listed" : ""}\n`,
				"not_configured",
			);
			return 2;
		}
	}
	// Children need the authoritative parent before submit can invoke dispatch.
	// The terminal writer reuses this identity whichever settlement path wins.
	const runId = newRunId();
	noteMainRunV2({
		runId,
		sessionReady: true,
		...(options.sessionCostCeilingUsd ? { sessionCeilingUsd: options.sessionCostCeilingUsd() } : {}),
	});
	if (options.costCap !== undefined) noteMainRunV2({ unpricedRoutes: options.costCap.unpricedRoutes });
	const mode = options.mode ?? "text";
	const startedAt = new Date().toISOString();
	// CLI-4: the commit the run starts from is the base a failing `--verify` check is replayed on.
	const verifyBase = options.verify !== undefined ? verifyBaseOf(process.cwd()) : null;
	let result: HeadlessMainAgentResult = {
		outputExhausted: false,
		text: "",
		narration: "",
		answerEntries: [],
		terminatedByFinish: false,
		error: null,
		sawTerminatingToolResult: false,
		completion: null,
		terminatingToolText: "",
		abortReason: null,
		lastNotice: null,
		operatorMemory: null,
		noAnswer: null,
		endedQuietly: false,
		callsNotRun: null,
		admissionRefused: false,
		harnessStopped: false,
		contextOverflow: null,
		modelRouteRefusal: null,
		thinkingOnlyLength: false,
		citationCheckedAnswer: null,
	};
	// Schema v2's `result.text` and `-o` read the one printed answer text mode prints (CLI-P43).
	noteMainRunV2({
		answer: () =>
			redactFinalUrlCredentials(printedAnswer(result), result.sawTerminatingToolResult || !result.outputExhausted),
	});
	const runStats: HeadlessMainAgentRunStats = {
		toolRounds: [],
		toolStats: new Map<string, ToolCallStat>(),
		pendingCapabilities: new Map(),
		readingCalls: new Set(),
		pendingVerifyCalls: new Map(),
		verifyCalls: [],
		runEffects: createRunEffectsRecorder(process.cwd(), {
			scratchRoots: options.scratchRoots ?? [],
			...(options.verify ? { sessionVerifiers: options.verify.checks } : {}),
		}),
		skillActivations: [],
		calls: [],
		seenAttempts: new Set(),
		decisions: { allowed: 0, blocked: 0, guardBlocked: 0, permissionRequested: 0 },
		blockedAttempts: [],
		blockedAttemptsTruncated: 0,
		guardBlockedAttempts: [],
		permissionRequestedAttempts: [],
		permissionRequestedByTool: new Map<string, number>(),
		judgeAllowedAttempts: [],
		reportPaths: new Set(),
		mergedTaskWorktrees: 0,
		delegatedChangedPaths: new Set(),
		mutatingSucceeded: false,
		readOnly: options.constraints?.readOnly === true,
		unresolvedBlocks: new Set<string>(),
		failedDispatch: null,
		// A read-only run can change nothing, so like an answer turn it asked for no change (C-1).
		changeAsked:
			options.constraints?.readOnly !== true &&
			options.constraints?.mode !== "answer" &&
			options.constraints?.mode !== "proposal",
		incompleteLimitations: 0,
	};
	options.onRunGitHelpers?.(process.cwd(), runStats.runEffects.gitHelpers);
	// The ledger row is this run's accounting, so it has to exist on the costly
	// failure paths too. Two callers can reach it: the turn's own completion
	// path, and the coordinated shutdown a SIGINT/SIGTERM starts. The signal
	// handler exits the process from inside shutdown, strictly before the
	// awaited submit resumes, so an interrupted run seals here in the drain
	// phase instead of losing the whole run's usage. Whichever caller arrives
	// first seals; the other awaits that same seal.
	let sealed: Promise<void> | null = null;
	let entriesBefore = 0;
	// The running ledger row, opened at the first loop event after the route resolved (C-13).
	let runningRow: Promise<void> | null = null;
	const recordRun = (
		terminal: HeadlessTerminalOutcome,
		acceptance: ReadonlyArray<RunJsonVerifyResult> | null = null,
		stoppedChecks: ReadonlyArray<{ id: string; command: string }> = [],
		answer: HeadlessStoredAnswer | null = null,
	): Promise<void> => {
		if (sealed !== null) return sealed;
		const endedAt = new Date().toISOString();
		sealed = (async () => {
			// Settlement updates the running row, so it waits for that row to be on disk.
			await runningRow;
			// A read model that cannot answer leaves the message fold for the row; the run still settles (#434).
			const calls = (await options.runUsage?.(startedAt).catch(() => null)) ?? null;
			if (calls !== null && runResultV2Active()) await noteRunUsageV2(options, startedAt, calls);
			if (runTextSummaryRequested()) {
				const summary = await runTextSummaryUsage(options, startedAt);
				const usage = summary.total ?? calls ?? runUsageFromCalls(runStats.calls);
				process.stderr.write(runTextSummaryLine(chat.getSessionId(), terminal.outcome, usage, summary.workers));
			}
			const dispatchRuns =
				options.readEntries !== undefined
					? standingDispatchRuns(
							options.readEntries(),
							entriesBefore,
							process.cwd(),
							options.scratchRoots ?? [],
							runStats.runEffects.gitHelpers,
						)
					: [];
			await recordHeadlessMainAgentRun({
				runId,
				chat,
				task: options.prompt,
				startedAt,
				endedAt,
				terminal,
				stats: runStats,
				calls,
				...(options.costCap !== undefined ? { costCap: options.costCap } : {}),
				acceptance,
				stoppedChecks,
				dispatchRuns,
				...(answer !== null ? { answer } : {}),
			});
		})().catch((error: unknown) => {
			process.stderr.write(
				`pancode run: run ledger write failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
		return sealed;
	};
	const termination = options.shutdown ?? defaultShutdownHooks();
	// A shutdown that aborts the turn also resolves the awaited submit, so the
	// completion path and this hook race. Interruption is a fact both read from
	// the coordinator rather than a winner of that race: whichever seals first
	// seals the same canceled outcome.
	const interruptedTerminal = (): HeadlessTerminalOutcome =>
		options.deadline?.expired() === true
			? {
					exitCode: termination.getExitCode(),
					outcome: "timed_out",
					// The status a dispatched worker's timed_out run settles with.
					status: runStatusForOutcome("timed_out"),
					failureMessage: `pancode run: timed out after ${options.deadline.seconds}s (--timeout)`,
				}
			: {
					exitCode: termination.getExitCode(),
					outcome: "canceled",
					status: "interrupted",
					failureMessage: result.abortReason ?? "pancode run: interrupted before the turn completed",
				};
	// Every `--json` frame reaches stdout through this one chain, in the order it was queued. An agent_end frame waits
	// in it for the read model's account of its segment, so nothing behind it can overtake it (#434).
	type QueuedFrame = RunJsonMainFrame | RunJsonMainSessionFrame | (() => Promise<RunJsonMainFrame>);
	let frameChain: Promise<void> = Promise.resolve();
	const queueFrame = (frame: QueuedFrame): void => {
		frameChain = frameChain.then(async () => {
			try {
				writeFrame(typeof frame === "function" ? await frame() : frame);
			} catch (error) {
				process.stderr.write(
					`pancode run: json frame write failed: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			}
		});
	};
	const segmentFrame = (frame: RunJsonMainFrame, messages: ReadonlyArray<AgentMessage>): QueuedFrame => {
		const read = options.segmentUsage;
		if (frame.type !== "agent_end" || read === undefined) return frame;
		return async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			// A journal that cannot flush still lets the stream finish, with the message fold's account (#434).
			const timeout = new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), SEGMENT_USAGE_WAIT_MS);
			});
			try {
				const usage = await Promise.race([read(messages), timeout]).catch(() => null);
				return usage ? { ...frame, usage } : frame;
			} finally {
				clearTimeout(timer);
			}
		};
	};

	// A step pipeline the run left unfinished keeps the outcome and says so here (bt-15).
	const stepPipelineField = () => {
		const stepPipeline = chat.stepPipeline?.() ?? null;
		return stepPipeline === null ? {} : { stepPipeline };
	};
	// The host's verdict, which the JSON stream's run_end carries (S-51).
	const runVerdict = (terminal: HeadlessTerminalOutcome, endedAt: string) => ({
		startedAt,
		endedAt,
		exitCode: terminal.exitCode,
		...(terminal.failureMessage !== null ? { error: terminal.failureMessage } : {}),
		outcome: terminal.outcome,
		...(terminal.outcomeDetail !== undefined ? { outcomeDetail: terminal.outcomeDetail } : {}),
		...stepPipelineField(),
		safety: {
			decisions: { ...runStats.decisions },
			blockedAttempts: [...runStats.blockedAttempts],
			...(runStats.blockedAttemptsTruncated > 0 ? { blockedAttemptsTruncated: runStats.blockedAttemptsTruncated } : {}),
			...(runStats.guardBlockedAttempts.length > 0 ? { guardBlockedAttempts: [...runStats.guardBlockedAttempts] } : {}),
			...(runStats.permissionRequestedAttempts.length > 0
				? { permissionRequestedAttempts: [...runStats.permissionRequestedAttempts] }
				: {}),
			...(runStats.judgeAllowedAttempts.length > 0 ? { judgeAllowedAttempts: [...runStats.judgeAllowedAttempts] } : {}),
		},
	});
	// A full stream's last line says whether the run succeeded, which the model's own turn_end cannot (S-51).
	let runEndWritten = false;
	const writeRunEnd = (terminal: HeadlessTerminalOutcome): void => {
		if (mode !== "json" || runEndWritten) return;
		runEndWritten = true;
		// The v2 envelope's `tools` (CLI audit 8): the main agent's own calls, the ones refused, and the paths it wrote.
		const totals = toolTotals(runStats.toolStats);
		noteMainRunV2({ tools: { calls: totals.calls, refused: totals.blocked, writes: writtenPaths(runStats) } });
		writeJsonHeader(true, true);
		queueFrame({ type: "run_end", ...runVerdict(terminal, new Date().toISOString()) });
	};

	// A shutdown seals the `--verify` checks that finished with their results and the rest as stopped by it. The checks
	// run in flag order and stop at a shutdown, so the finished ones are a prefix. Null: the checks' drain overran its
	// budget, so which finished is unknown and none is sealed.
	const sealInterruptedRun = async (finished: ReadonlyArray<RunJsonVerifyResult> | null = []): Promise<void> => {
		await frameChain;
		const interrupted = interruptedTerminal();
		writeRunEnd(interrupted);
		await frameChain;
		await recordRun(interrupted, finished, finished === null ? [] : stoppedVerifyChecks(finished));
		// A timeout or signal exits after this hook, so a reader that is behind still gets whole lines and the run_end.
		await flushRawStdout();
	};
	// `run --verify` checks, once started; a shutdown during them seals from a hook behind their own drain (CLI-P8).
	let verifyRun: Promise<RunJsonVerifyResult[]> | null = null;
	const stoppedVerifyChecks = (finished: ReadonlyArray<RunJsonVerifyResult>) =>
		options.verify?.checks.slice(finished.length) ?? [];
	// Registered after the composition root's chat drain hook, which disposes
	// the loop and awaits settlement, so the stats folded below are final by
	// the time this runs. Queued frames reach stdout before the seal.
	termination.onDrain(async () => {
		if (verifyRun === null) await sealInterruptedRun();
	});

	// Fresh sessions acquire their identity during submit, after admission notices
	// can arrive. Keep those frames behind their header.
	const pendingJsonFrames: QueuedFrame[] = [];
	let jsonHeaderWritten = false;
	const writeMainFrame = (frame: QueuedFrame): void => {
		if (!jsonHeaderWritten) pendingJsonFrames.push(frame);
		else queueFrame(frame);
	};
	const writeJsonHeader = (allowFallback: boolean, allowPending = false): void => {
		if (jsonHeaderWritten) return;
		const header = options.getSessionHeader?.();
		if (header !== undefined && header !== null) {
			queueFrame(header);
		} else {
			if (!allowFallback) return;
			const sessionId = chat.getSessionId();
			if (sessionId === null) {
				if (!allowPending || pendingJsonFrames.length === 0) return;
				queueFrame({
					type: "session",
					schemaVersion: RUN_JSON_SCHEMA_VERSION,
					mode: "main",
					id: null,
					pending: true,
					timestamp: startedAt,
					cwd: process.cwd(),
				});
			} else {
				queueFrame({
					type: "session",
					schemaVersion: RUN_JSON_SCHEMA_VERSION,
					mode: "main",
					id: sessionId,
					timestamp: startedAt,
					cwd: process.cwd(),
				});
			}
		}
		jsonHeaderWritten = true;
		for (const frame of pendingJsonFrames) queueFrame(frame);
		pendingJsonFrames.length = 0;
	};
	// A full stream's one `verify` frame, ahead of run_end on every path; nothing follows run_end (CLI-P8).
	let verifyFrameWritten = false;
	const writeVerifyFrame = (checks: RunJsonVerifyResult[] | null): void => {
		if (checks === null || mode !== "json" || verifyFrameWritten || runEndWritten) return;
		verifyFrameWritten = true;
		writeJsonHeader(true);
		writeMainFrame({ type: "verify", checks });
	};
	if (mode === "json" && options.routeNotice) {
		writeMainFrame({ type: "notice", level: "info", surface: "transcript", text: options.routeNotice });
	}
	// A text-mode run has no `session` event, so the id a later `--session`
	// would name is written to stderr the moment it exists. Stdout stays the
	// assistant's answer alone.
	let textSessionIdWritten = false;
	const writeTextSessionId = (): void => {
		if (textSessionIdWritten || mode !== "text") return;
		const sessionId = chat.getSessionId();
		if (sessionId === null) return;
		textSessionIdWritten = true;
		process.stderr.write(`pancode run: session ${sessionId}\n`);
	};
	const jsonProjector = createHeadlessJsonProjector();
	// The cost cap's no-usage notice, repeated once in the exit summary when it fired this run.
	let unreportedUsage: string | null = null;
	/** `--on-permission fail`: the message of the first ask this headless run refused. */
	let permissionStop: string | null = null;
	const unsubscribe = chat.onEvent((event) => {
		writeTextSessionId();
		if (runningRow === null && chat.lastRunSnapshot?.()) {
			runningRow = openRunningMainAgentRow(runId, chat, options.prompt, startedAt).catch((error: unknown) => {
				process.stderr.write(
					`pancode run: running ledger row write failed: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			});
		}
		if (mode === "json") {
			const messages = event.type === "agent_end" ? event.messages : [];
			const frames = jsonProjector
				.project(event)
				.map((frame) => segmentFrame(turnEndAfterCitationCheck(frame, result.citationCheckedAnswer), messages));
			writeJsonHeader(true);
			for (const frame of frames) writeMainFrame(frame);
		}
		if (mode === "text" && event.type === "retry_status" && event.status.phase === "scheduled") {
			const { attempt, delayMs = 0, retryAfterMs } = event.status;
			if (delayMs >= 5000 || attempt % 5 === 0) {
				const wait = formatStatedWait(delayMs);
				const what = retryAfterMs !== undefined ? `provider asked to wait ${wait}` : `waiting ${wait}`;
				process.stderr.write(`pancode run: ${what}, retrying (${attempt})\n`);
			}
		}
		if (mode === "text" && event.type === "notice" && event.surface === "transcript") {
			// A reminder is written to the model; the operator gets the one-line gist the TUI shows.
			const text =
				event.source === "reminder"
					? `reminder to the model: ${reminderGist(event.text.replace(/^\s*\[PanCode\]\s*/u, ""))}`
					: event.text;
			// A stop reason this run wrote, such as an unscripted question, already carries the prefix.
			const line = text.startsWith(RUN_STDERR_PREFIX) ? text.slice(RUN_STDERR_PREFIX.length) : text;
			if (unscriptedStop !== null && text.trim() === unscriptedStop.text) unscriptedStop.told = true;
			process.stderr.write(`${RUN_STDERR_PREFIX}${redactUrlCredentials(line)}\n`);
		}
		if (event.type === "notice" && unreportedUsage === null && isUnreportedUsageNotice(event.text))
			unreportedUsage = event.text;
		recordRunEffect(runStats.runEffects, event);
		const asksBefore = runStats.decisions.permissionRequested;
		recordToolEnd(runStats, event);
		// `--on-permission fail`: the first refused ask stops the turn once that call settles (SPEC 6.4).
		if (
			options.onPermission === "fail" &&
			permissionStop === null &&
			runStats.decisions.permissionRequested > asksBefore
		) {
			const tool = (event as { toolName?: unknown }).toolName;
			permissionStop = `pancode run: --on-permission fail: ${typeof tool === "string" ? tool : "a tool call"} needed approval that a headless run cannot give`;
			chat.cancel({ reason: permissionStop, atToolBoundary: true });
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant") runStats.toolRounds.push(...readToolRounds(event.message));
			// Usage is accrued per completed assistant message, the one place a
			// token count appears exactly once. Accruing at `agent_end` instead
			// loses everything the process was told when a run is interrupted
			// mid-segment, and a headless turn spans several agent segments
			// (middleware nudges and finish-contract reprompts start new agent
			// runs), so nothing here may key on the last segment alone.
			for (const call of messageCallSpends(event.message, chat.lastRunSnapshot?.()?.pricedBy ?? "none")) {
				if (call.attemptId !== undefined) {
					if (runStats.seenAttempts.has(call.attemptId)) continue;
					runStats.seenAttempts.add(call.attemptId);
				}
				if (call.disposition !== "never_sent") runStats.calls.push(call);
			}
		}
		result = resultFromEvent(event, result);
	});

	const unsubscribeScopeNotices = options.scopeNotices?.((payload) => {
		const notice = readDispatchScopeNotice(payload);
		if (notice === null) return;
		if (mode === "json") {
			writeJsonHeader(true);
			writeMainFrame({ type: "dispatch_scope_notice", ...notice });
			return;
		}
		process.stderr.write(`pancode run: ${notice.message}\n`);
	});

	// The first question the answers file does not script stops the turn once the call that asked it settles,
	// so an extension still hears its step cancelled as unscripted before the run ends.
	const scripted = options.answers;
	const unsubscribeUnscripted = scripted?.onUnscripted((question) => {
		unscriptedStop = { text: unscriptedRunMessage(scripted, question), told: false };
		chat.cancel({ reason: unscriptedStop.text, atToolBoundary: true });
	});
	const cleanupSteer = options.steerChannel ? openSteerChannel(options.steerChannel, chat, options.reload) : undefined;
	// `--output-schema`: null until judged, and when the turn ended in a way that already has its own cause.
	// Assigned inside the submit callback, so the declared type is kept rather than narrowed to its initial null.
	let structuredVerdict = null as StructuredVerdict | null;
	const structuredCandidate = (): string => redactFinalUrlCredentials(printedAnswer(result), true);
	const structuredAnswerReady = (): boolean =>
		!termination.isShuttingDown() &&
		permissionStop === null &&
		result.abortReason === null &&
		result.error === null &&
		!(result.outputExhausted && !result.sawTerminatingToolResult) &&
		result.noAnswer === null &&
		!(result.endedQuietly && !result.sawTerminatingToolResult) &&
		(result.text.length > 0 || result.sawTerminatingToolResult);
	try {
		const submitOptions = {
			...(options.display ? { display: options.display } : {}),
			...(options.constraints ? { constraints: options.constraints } : {}),
			hostRun: { runId, lineage: { parentRunId: null, rootRunId: runId, depth: 0, attempt: 0 } },
			...(options.images && options.images.length > 0 ? { images: options.images } : {}),
			...(options.workingContextPaths && options.workingContextPaths.length > 0
				? { workingContextPaths: options.workingContextPaths }
				: {}),
			...(options.pendingSkillRequests && options.pendingSkillRequests.length > 0
				? { pendingSkillRequests: options.pendingSkillRequests }
				: {}),
		};
		// Sampling flags ride the scoped run-overrides transport for the turn;
		// see core/run-overrides.ts.
		entriesBefore = options.readEntries?.().length ?? 0;
		await withRunOverrides(
			options.sampling && Object.keys(options.sampling).length > 0 ? { sampling: { ...options.sampling } } : {},
			async () => {
				await chat.submit(options.prompt, Object.keys(submitOptions).length > 0 ? submitOptions : undefined);
				// A triage stop interrupts this submit and delivers its message as a run of its own (bt-41).
				await chat.whenSettled();
				const schema = options.outputSchema;
				if (schema === undefined) return;
				// SPEC 6.8: the host judges only an answer the run would otherwise print; any other ending keeps its cause.
				structuredVerdict = structuredAnswerReady() ? await validateStructuredAnswer(schema, structuredCandidate()) : null;
				if (structuredVerdict === null || structuredVerdict.ok) return;
				// One repair turn in the same run and session, under a tool ceiling of none; its requests count toward
				// --max-requests and its spend toward --max-cost-usd like any other turn of the run.
				await chat.submit(structuredRepairPrompt(structuredVerdict.errors), {
					...submitOptions,
					constraints: structuredRepairConstraints(options.constraints),
				});
				await chat.whenSettled();
				structuredVerdict = structuredAnswerReady() ? await validateStructuredAnswer(schema, structuredCandidate()) : null;
			},
		);
	} finally {
		if (mode === "json") writeJsonHeader(true, true);
		if (cleanupSteer) {
			cleanupSteer();
		}
		unsubscribeScopeNotices?.();
		unsubscribeUnscripted?.();
		unsubscribe();
	}
	// Detached workers outlive the turn but not the process, so wait for them
	// while a deadline can still fire.
	const settlement: DispatchedRunsSettlement = options.dispatch
		? await settleDispatchedRuns(options.dispatch, runId, () => termination.isShuttingDown(), {
				supersede: runResultV2Active(),
			})
		: { runs: [], live: [], undelivered: [], canceled: [], superseded: [] };
	const settledIds = runResultV2Active() ? settlement.runs.map((run) => run.id) : [];
	noteDispatchRunsV2(
		settlement.runs.map(projectDispatchedRunOutcome),
		settledIds.length > 0 ? settledRunEnvelopes(settledIds, pancodeStateDir()) : new Map(),
		settledIds.length > 0 ? settledRunUsage(settledIds, pancodeStateDir()) : new Map(),
	);
	if (settlement.superseded.length > 0) noteDispatchSupersededV2(settlement.superseded.map(projectDispatchedRunOutcome));
	if (mode === "json" && (settlement.live.length > 0 || settlement.undelivered.length > 0)) {
		writeJsonHeader(true);
		writeMainFrame({
			type: "dispatch_settlement",
			live: settlement.live.map(projectDispatchedRunOutcome),
			undelivered: settlement.undelivered.map(projectDispatchedRunOutcome),
		});
	}
	// An interrupted turn has nothing to accept, and a shutdown stops the checks. The deadline stays armed
	// through them: its expiry starts the shutdown, whose drain aborts the check in flight (CLI-P6).
	let verify: RunJsonVerifyResult[] | null = null;
	if (options.verify !== undefined && !termination.isShuttingDown() && result.abortReason === null) {
		const onForceExit = termination.onForceExit?.bind(termination);
		verifyRun = runHeadlessVerifyChecks(
			{ ...options.verify, base: verifyBase, scratchDir: join(pancodeStateDir(), "scratch", runId) },
			{
				onDrain: (hook, drainOptions) => {
					termination.onDrain(hook, drainOptions);
					// That drain has stopped the check in flight, so the frame lists the checks that finished, before
					// run_end (CLI-P8). A drain past its budget leaves the frame out rather than the run_end.
					termination.onDrain(async () => {
						const stopped = new Promise<null>((resolve) => setImmediate(() => resolve(null)));
						const finished = await Promise.race([(verifyRun ?? stopped).catch(() => null), stopped]);
						writeVerifyFrame(finished);
						await sealInterruptedRun(finished);
					});
				},
				...(onForceExit !== undefined ? { onForceExit } : {}),
			},
		);
		verify = await verifyRun;
	}
	// The turn, any repair turn and the checks have settled. Nothing between here and the seal yields to a
	// timer, so a deadline that has not fired by now never will, and one that
	// did has already put the coordinator into shutdown, which the first branch
	// below reads.
	options.deadline?.settle();
	if (verify !== null && mode === "text") {
		for (const check of verify) process.stderr.write(`${formatHeadlessVerifyResult(check)}\n`);
	}

	const observed =
		options.readEntries !== undefined
			? observeHeadlessRun({
					entries: options.readEntries(),
					start: entriesBefore,
					effects: runStats.runEffects.snapshot(),
					toolCalls: countToolStats(runStats.toolStats),
					refused: toolTotals(runStats.toolStats).blocked,
					writes: writtenPaths(runStats),
					workspaceRoot: process.cwd(),
					scratchRoots: options.scratchRoots ?? [],
					gitHelpers: runStats.runEffects.gitHelpers,
				})
			: null;
	// Every exit of the answer. A reply the token limit stopped can end inside a URL, which a terminating tool's result cannot (#446).
	const settledAnswer = (answer: string): string =>
		redactFinalUrlCredentials(answer, result.sawTerminatingToolResult || !result.outputExhausted);
	let terminal: HeadlessTerminalOutcome = {
		exitCode: 0,
		outcome: "succeeded",
		status: "completed",
		failureMessage: null,
	};
	let stderrMessage: string | null = null;
	// The answer a text run prints, computed once: stdout prints it and the result object stores it (C-12).
	let answerMessage: string | null = null;
	let answerState: RunResultOutput["state"] = "final";
	if (termination.isShuttingDown()) {
		// The turn did not fail; a signal ended it. Both this path and the drain
		// hook read interruption from the coordinator, so whichever seals first
		// seals the same canceled outcome with the status the process exits with.
		terminal = interruptedTerminal();
		// The deadline timer reports expiry even if shutdown precedes chat boot.
		// Keep the outcome detail, but emit that diagnostic only at the timer.
		stderrMessage =
			settlement.live.length > 0
				? `pancode run: cancelling ${settlement.live.length} dispatched run(s) still in flight: ${describeRuns(settlement.live)}`
				: null;
		if (options.deadline?.expired() !== true) {
			stderrMessage = [terminal.failureMessage, stderrMessage].filter(Boolean).join("\n") || null;
		}
	} else if (result.abortReason !== null) {
		// An interrupted turn never answered, no matter what partial text or
		// internal error the abort left behind: nonzero exit, abort reason. It
		// was canceled, not failed, and its ledger row says so.
		terminal = { exitCode: 1, outcome: "canceled", status: "interrupted", failureMessage: result.abortReason };
		stderrMessage = result.abortReason;
	} else if (result.error) {
		const budgetCeiling = result.error.startsWith(`${SESSION_COST_CEILING_REASON}:`);
		// `--max-requests`/`--max-tool-calls` fired: a limit exit, as the cost ceiling is.
		const runCap = runCapStopCode(result.error);
		const limitDetail = budgetCeiling ? SESSION_COST_CEILING_REASON : runCap;
		// The window, not the route, ended the run: its own cause (FX-22a). A refused model route names its own (row 384).
		const detail =
			limitDetail ?? result.modelRouteRefusal?.code ?? (result.contextOverflow !== null ? "context_overflow" : undefined);
		terminal = {
			exitCode: limitDetail !== undefined ? SESSION_COST_CEILING_EXIT_CODE : 1,
			outcome: "failed",
			status: "failed",
			failureMessage: result.error,
			...(detail !== undefined ? { outcomeDetail: detail } : {}),
		};
		// Text mode printed the refusal's notice as it arrived; saying it twice
		// reads as two failures.
		stderrMessage =
			mode === "text" && result.admissionRefused
				? null
				: prefixHeadlessFailure(
						chat,
						result.error,
						result.admissionRefused || result.harnessStopped || result.contextOverflow === "guard",
					);
	} else if (result.outputExhausted && !result.sawTerminatingToolResult) {
		// The provider returned normally, but generation exhausted its budget.
		// Earlier chatter and partial prose cannot turn that terminal cause into
		// success. A later assistant message or terminating tool supersedes it.
		const failureMessage = result.thinkingOnlyLength
			? `pancode run: ${THINKING_LENGTH_STOP_REASON}`
			: "pancode run: output token limit reached (stopReason=length); generation incomplete. Consider resuming with a narrower task, lower reasoning effort, or a larger output budget.";
		terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage };
		// Text mode printed the chat loop's notice for a thinking-only stop as it arrived.
		stderrMessage = mode === "text" && result.thinkingOnlyLength ? null : failureMessage;
		if (printedAnswer(result).length > 0) {
			answerMessage = settledAnswer(printedAnswer(result));
			answerState = "partial";
		}
	} else if (result.noAnswer !== null) {
		// Earlier chatter or a line of markup is not the answer the caller asked for, whatever it reads like.
		const failureMessage = `pancode run: the turn ended without an answer. ${result.noAnswer}`;
		terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage };
		stderrMessage = failureMessage;
	} else if (result.endedQuietly && !result.sawTerminatingToolResult) {
		// The classifier saw an empty closing message and the turn has no reply, so the answer is empty; the narration
		// written beside a tool call ("Let me read notes.txt first") goes to stderr for a reader of the log, never stdout.
		const failureMessage =
			"pancode run: the turn's tools ran but the model wrote no closing message, so there is no answer to print";
		terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage };
		const narration = Array.from(settledAnswer(result.narration));
		stderrMessage =
			narration.length > 0
				? `${failureMessage}\npancode run: last text before the tools ran: ${narration.length > 400 ? `${narration.slice(0, 399).join("")}…` : narration.join("")}`
				: failureMessage;
	} else if (result.operatorMemory !== null && result.text.length === 0 && !result.sawTerminatingToolResult) {
		// The prompt was only a remember or forget statement: it was stored (or refused) and no model was asked.
		if (result.operatorMemory.refused) {
			const failureMessage = `pancode run: ${result.operatorMemory.text}`;
			terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage };
			stderrMessage = mode === "text" ? null : failureMessage;
		}
	} else if (result.text.length === 0 && !result.sawTerminatingToolResult) {
		const failureMessage = "pancode run: provider stream ended without an assistant response or terminal tool result";
		terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage };
		stderrMessage = failureMessage;
	} else if (result.terminatedByFinish && printedAnswer(result).length === 0) {
		// M-6: the bare-finish refusal is one-shot, so the second bare finish settles the run partly_done with no reply
		// text (CLI-P49). The typed fact is an empty answer under a finish, never the prompt's wording: there is nothing
		// for the caller to read, so the run did not succeed.
		const failureMessage =
			"pancode run: the agent declared completion through finish without writing a reply, so there is no answer to print";
		terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage, outcomeDetail: "no_reply_text" };
		stderrMessage = failureMessage;
	} else {
		// A normal provider stop does not erase an explicit limitation or a
		// block with no applied change. Judge settled tool outcomes, not prose
		// or the presence of a validation contract. Recovered failures may succeed.
		// A no-runner limitation stays in the declaration's limitations and fails nothing (row 382).
		const limited = runStats.incompleteLimitations > 0;
		const blockedWithoutChange = runStats.changeAsked && unmetWithoutChange(runStats);
		if (limited || blockedWithoutChange || (options.failOnNoop === true && headlessNoop(runStats))) {
			const failureMessage = limited
				? "pancode run: the agent recorded an explicit limitation; the task is incomplete"
				: noopFailureMessage(runStats, options.failOnNoop === true);
			terminal = {
				exitCode: 1,
				outcome: "failed",
				status: "failed",
				failureMessage,
				outcomeDetail: limited ? "limitation" : "noop",
			};
			stderrMessage = failureMessage;
		}
		// CLI-13, schema v2 only: an answer that ends on calls it only wrote out did not finish (the turn-ending reading
		// `call_not_run`), so it fails as `no_answer`, which outranks noop and limitation (SPEC 6.5). v1 keeps exit 0.
		const callsNotRunFail = result.callsNotRun !== null && !result.sawTerminatingToolResult && runResultV2Active();
		if (callsNotRunFail) {
			const failureMessage = `pancode run: ${result.callsNotRun}`;
			terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage, outcomeDetail: "no_answer" };
			stderrMessage = failureMessage;
		}
		if (terminal.exitCode === 0 && settlement.undelivered.length > 0) {
			const failureMessage = `pancode run: ${settlement.undelivered.length} dispatched worker(s) did not deliver: ${describeRuns(settlement.undelivered)}`;
			terminal = {
				exitCode: 1,
				outcome: "failed",
				status: "failed",
				failureMessage,
				outcomeDetail: "dispatched_worker_failed",
			};
			stderrMessage = failureMessage;
		}
		if (terminal.exitCode === 0 && options.failOnVerify === true && verify?.some((check) => !check.passed)) {
			// The operator declared these checks as the run's acceptance gate, so a red one fails the run whoever broke it;
			// the base comparison (CLI-4) only says it was already red at the start.
			const failed = verify
				.filter((check) => !check.passed)
				.map((check) =>
					verifyNotImplicated(check) ? `${check.command} (already failing at the run's start)` : check.command,
				);
			const failureMessage = `pancode run: --fail-on-verify: ${failed.length} check(s) did not pass: ${failed.join("; ")}`;
			terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage, outcomeDetail: "verify_failed" };
			stderrMessage = failureMessage;
		}
		// A terminating tool ends the turn in place of an assistant message, so its
		// result is the answer and any assistant text before it is mid-workflow
		// chatter the model never offered as a reply. Printing that chatter instead
		// hands the operator a dangling "let me try..." for a turn that succeeded.
		const answer = printedAnswer(result);
		answerMessage = answer.length > 0 ? settledAnswer(answer) : null;
		// SPEC 6.8: an answer that still does not match outranks verify, noop and limitation (6.5 order); nothing
		// reaches stdout or `-o`. A match prints the validated JSON alone.
		if (structuredVerdict !== null && !structuredVerdict.ok) {
			const failureMessage = schemaMismatchMessage(structuredVerdict.errors);
			terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage, outcomeDetail: "schema_mismatch" };
			stderrMessage = failureMessage;
			answerMessage = null;
		} else if (structuredVerdict?.ok === true && terminal.exitCode === 0) {
			answerMessage = structuredVerdict.json;
		}
		if (terminal.exitCode === 0 && !runStats.changeAsked) {
			const notice = blockedCallsNotice(runStats);
			if (notice !== null) stderrMessage = [stderrMessage, notice].filter(Boolean).join("\n");
		}
		// The answer stands, so the run still succeeds; the caller still learns that its last calls never ran.
		if (result.callsNotRun !== null && !result.sawTerminatingToolResult && !callsNotRunFail) {
			stderrMessage = [stderrMessage, `pancode run: ${result.callsNotRun}`].filter(Boolean).join("\n");
		}
		// ns:61: a worker the run canceled through steer did not fail it, but stderr still names it.
		if (settlement.canceled.length > 0) {
			const note = `pancode run: ${settlement.canceled.length} dispatched worker(s) canceled through steer: ${describeRuns(settlement.canceled)}`;
			stderrMessage = [stderrMessage, note].filter(Boolean).join("\n");
		}
	}
	// A yolo pause ends the run on purpose, whatever the cancelled turn left behind; a signal still outranks it.
	const halt = terminal.exitCode !== 0 && !termination.isShuttingDown() ? (options.autonomyHalt?.() ?? null) : null;
	if (halt !== null) {
		const failureMessage = `pancode run: ${headlessHaltNotice(halt, options.autonomy?.() ?? null)}`;
		terminal = {
			exitCode:
				halt.kind === "judge"
					? AUTONOMY_JUDGE_STREAK_EXIT_CODE
					: halt.kind === "exploration"
						? EXPLORATION_STALLED_EXIT_CODE
						: AUTONOMOUS_CAP_EXIT_CODE,
			outcome: "failed",
			status: "failed",
			failureMessage,
			outcomeDetail: autonomyHaltReason(halt),
		};
		stderrMessage = failureMessage;
	}
	// The run stopped on a question nobody scripted, whatever the stopped turn left behind; a signal still outranks it.
	if (permissionStop !== null && !termination.isShuttingDown()) {
		terminal = {
			exitCode: PERMISSION_REQUIRED_EXIT_CODE,
			outcome: "failed",
			status: "failed",
			failureMessage: permissionStop,
			outcomeDetail: "permission_required",
		};
		stderrMessage = permissionStop;
		answerMessage = null;
	}
	const unscripted = scripted !== undefined && !termination.isShuttingDown() ? scripted.unscripted() : null;
	if (scripted !== undefined && unscripted !== null) {
		const failureMessage = unscriptedRunMessage(scripted, unscripted);
		terminal = {
			exitCode: UNSCRIPTED_EXIT_CODE,
			outcome: "failed",
			status: "failed",
			failureMessage,
			outcomeDetail: "unscripted",
		};
		// The stop's own notice already told the operator, so the closing line does not say it again.
		stderrMessage = unscriptedStop?.told === true && unscriptedStop.text === failureMessage ? null : failureMessage;
		answerMessage = null;
	}
	const sealedCompletion = chat.lastTurnCompletion?.() ?? sealCompletion(result.completion, []);
	// M-4: an output the operator named is still absent at the seal, so the run did not succeed, whatever it claimed.
	if (terminal.exitCode === 0 && sealedCompletion.facts.includes("missing_output")) {
		const missing = sealedCompletion.unverified.filter((line) => line.startsWith("missing output: "));
		const failureMessage = `pancode run: ${missing.length > 0 ? missing.join("; ") : "missing output"}`;
		terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage, outcomeDetail: "missing_output" };
		stderrMessage = [stderrMessage, failureMessage].filter(Boolean).join("\n");
	}
	const exitCode = terminal.exitCode;
	// A verify check whose latest receipt sealed could-not-run judged nothing: the run lists it as not run (L10).
	const notRunLines = notRunCheckIds(runStats.runEffects.snapshot()).map(
		(check) =>
			`not run: ${ToolNames.Verify} ${redactSecretsText(redactSecretString(redactUrlCredentials(check)), createRedactionTally())}`,
	);
	// Fleet design 4.3: the envelope carries the host's seal of the typed declaration, never a reading of the answer:
	// the claim, its assessment from the turn's facts, and state = assessed, which `--exit-code` maps (ruling 7).
	noteRunCompletion({
		declared: sealedCompletion.declared,
		claimed: sealedCompletion.claimed,
		assessed: sealedCompletion.assessed,
		state: sealedCompletion.assessed,
		...(sealedCompletion.facts.length > 0 ? { facts: sealedCompletion.facts } : {}),
		limitations: sealedCompletion.limitations,
		unverified: [...new Set([...sealedCompletion.unverified, ...notRunLines])],
		...(sealedCompletion.remaining !== undefined ? { remaining: sealedCompletion.remaining } : {}),
	});
	if (options.outputSchema !== undefined) {
		noteStructuredV2({
			enforcedBy: "host",
			...(structuredVerdict?.ok === true && exitCode === 0
				? { structured: structuredVerdict.value, json: structuredVerdict.json }
				: {}),
			...(structuredVerdict !== null && !structuredVerdict.ok ? { errors: structuredVerdict.errors } : {}),
		});
	}
	const autonomy = mode === "json" ? (options.autonomy?.() ?? null) : null;
	if (autonomy !== null) {
		writeJsonHeader(true);
		writeMainFrame({ type: "autonomy", ...autonomy });
	}
	writeVerifyFrame(verify);

	if (answerMessage !== null) {
		// CLI-P42: a run the observation pool stopped says so after its answer, as `run --agent` prints its limits.
		const notVerified = options.outputSchema === undefined ? sealedFactsNotVerified(sealedCompletion.facts) : "";
		if (notVerified.length > 0) answerMessage = `${answerMessage}\n${notVerified.replace(/\n$/u, "")}`;
	}
	const storedAnswer = answerMessage !== null ? { text: answerMessage, state: answerState } : null;

	await frameChain;
	// A shutdown seals what the drain would, whichever of this path and the drain arrives first.
	if (termination.isShuttingDown())
		await recordRun(terminal, verify ?? [], stoppedVerifyChecks(verify ?? []), storedAnswer);
	else await recordRun(terminal, verify, [], storedAnswer);

	if (stderrMessage !== null) {
		process.stderr.write(`${stderrMessage}\n`);
	}
	if (answerMessage !== null && mode === "text") {
		// CLI-P22: text mode's `-o` holds exactly these bytes; a v1 or v2 JSON run reads its answer from its frames.
		noteTextAnswer(answerMessage);
		writeRawStdout(`${answerMessage}\n`);
	}
	// What the harness saw, beside the model's account; stdout stays the answer and the exit code is unchanged.
	const observedLine =
		observed !== null && mode === "text"
			? formatHeadlessObservedLine({
					...observed,
					...(sealedCompletion.assessed !== "unknown" ? { completion: sealedCompletion.assessed } : {}),
				})
			: null;
	if (observedLine !== null) process.stderr.write(`${observedLine}\n`);
	if (unreportedUsage !== null && mode === "text")
		process.stderr.write(`pancode run: ${redactUrlCredentials(unreportedUsage)}\n`);
	if (mode === "json") writeJsonHeader(true, true);
	writeRunEnd(terminal);
	await frameChain;
	await flushRawStdout();
	return exitCode;
}
