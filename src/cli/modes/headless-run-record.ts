// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readPancodeVersion } from "../../core/package-root.js";
import type { RunOwnerTelemetryContext } from "../../core/telemetry/context.js";
import { mainAgent } from "../../core/telemetry/context.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { telemetryRunDirectory, telemetrySessionDirectory } from "../../core/telemetry/paths.js";
import { WORKER_OUTPUT_MAX_BYTES } from "../../core/worker-output.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { mainAgentTerminalReason } from "../../domains/dispatch/outcome.js";
import { type RunCallUsage, runUsageFromCalls } from "../../domains/dispatch/run-call-usage.js";
import {
	createRunResultQuality,
	creditStandingDispatchRuns,
	deriveRunVerification,
	typedValidationFactsFromObservedEffects,
	typedValidationFactsFromVerifyCalls,
	unclassifiedAfterLastCheck,
	verificationWithHostVerdict,
} from "../../domains/dispatch/run-findings.js";
import { finishRunResult } from "../../domains/dispatch/run-settlement.js";
import { openRunTelemetry } from "../../domains/dispatch/run-telemetry.js";
import { type CreateRunInput, openLedger } from "../../domains/dispatch/state.js";
import type {
	RunEnvelope,
	RunKind,
	RunOutcome,
	RunResultCostCap,
	RunResultDraft,
	RunResultOutput,
	RunStatus,
	ToolCallStat,
} from "../../domains/dispatch/types.js";
import { readPiMonoVersion } from "../../engine/pi-mono-names.js";
import { createRedactionTally, redactSecretsText } from "../../lib/secrets/redact.js";
import { redactSecretString } from "../../lib/secrets/redaction.js";
import type { ChatLoop, ChatLoopRunSnapshot } from "../../session-control/chat-loop.js";
import { truncateUtf8 } from "../../tools/truncate-utf8.js";
import type { HeadlessMainAgentRunStats } from "./headless-run-types.js";
import { changedWorkspace, headlessNoop } from "./headless-run-verdict.js";
import type { RunJsonVerifyResult } from "./run-json-schema.js";
import { acceptanceHostVerification } from "./run-verify.js";

/** How long an agent_end frame waits for the journal to hold its calls before it reports the message fold. */
export const SEGMENT_USAGE_WAIT_MS = 5_000;

function isMainAgentRunKind(value: string): value is RunKind {
	return value === "http" || value === "sdk" || value === "subprocess";
}

/**
 * Terminal accounting for one headless turn. `outcome`/`status` are resolved
 * from how the turn ended, not from the exit code alone: a turn the operator
 * interrupted is `canceled`/`interrupted`, never `failed`.
 */
export interface HeadlessTerminalOutcome {
	exitCode: number;
	outcome: RunOutcome;
	status: RunStatus;
	failureMessage: string | null;
	/** Machine-readable outcome detail; absent means the failure message is the detail. */
	outcomeDetail?: string;
}

function sortedToolStats(stats: Map<string, ToolCallStat>): ToolCallStat[] {
	return [...stats.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

export function countToolStats(stats: Map<string, ToolCallStat>): number {
	let count = 0;
	for (const stat of stats.values()) count += stat.count;
	return count;
}
/**
 * The printed answer as a result object holds it, within the bound a worker's output seals under. It is redacted as the
 * object store redacts before the bound: a bound first would cut a secret into a piece no redactor recognizes (#446).
 */
function boundedAnswer(answer: HeadlessStoredAnswer): RunResultOutput {
	const text = redactSecretsText(redactSecretString(answer.text), createRedactionTally());
	const bytes = Buffer.byteLength(text, "utf8");
	// The marker follows the kept bytes, so they leave it room within the bound.
	const marker = "\n[output truncated]";
	const bounded =
		bytes <= WORKER_OUTPUT_MAX_BYTES
			? text
			: truncateUtf8(text, WORKER_OUTPUT_MAX_BYTES - Buffer.byteLength(marker, "utf8"), marker);
	return { state: answer.state, text: bounded, bytes, truncated: bounded !== text };
}

/** What stdout printed as the run's answer; partial when the output token limit stopped it. */
export interface HeadlessStoredAnswer {
	text: string;
	state: RunResultOutput["state"];
}

/**
 * The finish contract decision the run's own turns recorded last: the main loop journals it in the session, not the run
 * scope, so the run's assessment reads it from there (C-11). A worker's decision carries its own run id and is left
 * out; a journal that cannot be read leaves the completion axis unrecorded.
 */
async function sessionCompletion(
	sessionId: string,
	from: string,
): Promise<Pick<TelemetryRecord<"completion.evaluated">, "id" | "t" | "data"> | undefined> {
	try {
		const { readCallJournal } = await import("../../domains/telemetry/call-journal.js");
		const read = await readCallJournal(telemetrySessionDirectory(pancodeStateDir(), sessionId), ["completion.evaluated"]);
		return read.records
			.flatMap(({ record }) =>
				record.k === "completion.evaluated" && record.ctx.runId === undefined && record.t >= from ? [record] : [],
			)
			.sort((left, right) => left.t.localeCompare(right.t))
			.at(-1);
	} catch {
		return undefined;
	}
}

/** The ledger row a headless main-agent run opens with, from the route its loop resolved. */
function mainAgentRow(
	runId: string,
	task: string,
	snapshot: ChatLoopRunSnapshot,
	sessionId: string | null,
): CreateRunInput {
	return {
		id: runId,
		agentId: "main-agent",
		executionRole: "builder",
		requestOrigin: "user",
		task,
		targetId: snapshot.targetId,
		wireModelId: snapshot.wireModelId,
		runtimeId: snapshot.runtimeId,
		runtimeKind: snapshot.runtimeKind,
		sessionId,
		cwd: snapshot.cwd,
	};
}

/**
 * Publish the run's ledger row as running once its loop has resolved a route, before any child it dispatches settles,
 * with this process's pid so recovery can tell a live parent from an abandoned one (C-13). A run whose route is never
 * resolved gets its row at settlement, as before.
 */
export async function openRunningMainAgentRow(
	runId: string,
	chat: ChatLoop,
	task: string,
	startedAt: string,
): Promise<void> {
	const snapshot = chat.lastRunSnapshot?.();
	if (!snapshot || !isMainAgentRunKind(snapshot.runtimeKind)) return;
	const ledger = openLedger();
	if (ledger.get(runId) !== null) return;
	ledger.create(mainAgentRow(runId, task, snapshot, snapshot.sessionId ?? chat.getSessionId()));
	ledger.update(runId, { status: "running", startedAt, pid: process.pid, heartbeatAt: new Date().toISOString() });
	await ledger.persist();
}

/**
 * Settle the main-agent run the way dispatch settles a worker (#434): one result built with its run.settled, the
 * record made durable and the run scope sealed, and only then the ledger row published terminal, so `fleet verify`
 * and `fleet view` read a finished run the same way whoever ran it. A settlement that does not land publishes the row
 * failed with the reason, as a dispatch finalization failure does.
 */
export async function recordHeadlessMainAgentRun(input: {
	runId: string;
	chat: ChatLoop;
	task: string;
	startedAt: string;
	endedAt: string;
	terminal: HeadlessTerminalOutcome;
	stats: HeadlessMainAgentRunStats;
	/** The read model's fold of the session calls the run made; null without one. */
	calls: RunCallUsage | null;
	costCap?: RunResultCostCap;
	/** `run --verify` results; they seal as the run's host verdict. */
	acceptance?: ReadonlyArray<RunJsonVerifyResult> | null;
	/** `run --verify` checks a shutdown stopped before they finished; they seal as not run. */
	stoppedChecks?: ReadonlyArray<{ id: string; command: string }>;
	/** Passing dispatch run records still standing at the end, as the observed line names them (bt-verify7a). */
	dispatchRuns?: ReadonlyArray<string>;
	/** The answer stdout printed for this run; absent when it printed none. */
	answer?: HeadlessStoredAnswer;
}): Promise<void> {
	const snapshot = input.chat.lastRunSnapshot?.();
	if (!snapshot) return;
	if (!isMainAgentRunKind(snapshot.runtimeKind)) return;
	const stepPipeline = input.chat.stepPipeline?.() ?? null;
	// The read model's fold of the run's session calls is its spend; the run's own calls stand without one (#434).
	const { facts: spend, sums: spendSums } = input.calls ?? runUsageFromCalls(input.stats.calls);
	const { exitCode, outcome, status } = input.terminal;
	const outcomeDetail = input.terminal.outcomeDetail ?? input.terminal.failureMessage;
	const outcomeCode = outcome === "failed" ? snapshot.outcomeCode : undefined;
	const sessionId = snapshot.sessionId ?? input.chat.getSessionId();
	const ledger = openLedger();
	// The row the run opened as running when its route was known is the one it settles (C-13).
	const envelope = ledger.get(input.runId) ?? ledger.create(mainAgentRow(input.runId, input.task, snapshot, sessionId));
	const lineage = {
		parentRunId: null,
		rootRunId: envelope.id,
		attempt: 0,
		depth: 0,
	};
	const terminalPatch: Partial<RunEnvelope> = {
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		status,
		outcome,
		outcomeDetail,
		...(outcomeCode === undefined ? {} : { outcomeCode }),
		lineage,
		exitCode,
		spend,
		spendSums,
		...(input.stats.toolRounds.length > 0 ? { toolRounds: input.stats.toolRounds } : {}),
		promptSignature: snapshot.promptSignature,
		toolSignature: snapshot.toolSignature,
	};
	const toolStats = sortedToolStats(input.stats.toolStats);
	const checkFreshness = input.stats.runEffects.checkFreshness();
	const typedValidations = [
		...typedValidationFactsFromVerifyCalls(toolStats, input.stats.verifyCalls, checkFreshness),
		...typedValidationFactsFromObservedEffects(input.stats.runEffects.snapshot()),
	];
	const unclassified = unclassifiedAfterLastCheck(input.stats.runEffects.snapshot());
	const hostVerification = acceptanceHostVerification(input.acceptance ?? [], snapshot.cwd, input.stoppedChecks ?? []);
	const verification = creditStandingDispatchRuns(
		deriveRunVerification({ toolStats, typedValidations }, { checkFreshness }),
		input.dispatchRuns ?? [],
	);
	const draft: RunResultDraft = {
		runId: envelope.id,
		cwd: snapshot.cwd,
		agentId: "main-agent",
		executionRole: "builder",
		requestOrigin: "user",
		task: input.task,
		targetId: snapshot.targetId,
		wireModelId: snapshot.wireModelId,
		runtimeId: snapshot.runtimeId,
		runtimeKind: snapshot.runtimeKind,
		outcome,
		outcomeDetail,
		...(outcomeCode === undefined ? {} : { outcomeCode }),
		lineage,
		// Host checks belong to this run, independently of any worker it dispatched.
		verification: hostVerification === null ? verification : verificationWithHostVerdict(verification, hostVerification),
		...(hostVerification === null ? {} : { hostVerification }),
		routingIntent: {
			posture: "manual",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: createRunResultQuality({ runtimeEnforceable: false, enforcementPassed: null, typedValidations }),
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		exitCode,
		...(input.terminal.failureMessage !== null ? { failureMessage: input.terminal.failureMessage } : {}),
		spend,
		spendSums,
		...(input.stats.toolRounds.length > 0 ? { toolRounds: input.stats.toolRounds } : {}),
		compiledPromptHash: snapshot.compiledPromptHash,
		staticCompositionHash: snapshot.staticCompositionHash,
		promptSignature: snapshot.promptSignature,
		toolSignature: snapshot.toolSignature,
		pancodeVersion: readPancodeVersion(),
		piMonoVersion: readPiMonoVersion(),
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: countToolStats(input.stats.toolStats),
		toolStats,
		skillActivations: input.stats.skillActivations,
		autonomy: snapshot.autonomy,
		// Recorded on every main-agent run, flag or no flag, so a driver can apply its own no-op rule to a run that
		// exited 0.
		safety: {
			decisions: { ...input.stats.decisions },
			blockedAttempts: [...input.stats.blockedAttempts],
			...(input.stats.blockedAttemptsTruncated > 0
				? { blockedAttemptsTruncated: input.stats.blockedAttemptsTruncated }
				: {}),
			...(input.stats.guardBlockedAttempts.length > 0
				? { guardBlockedAttempts: [...input.stats.guardBlockedAttempts] }
				: {}),
			...(input.stats.permissionRequestedAttempts.length > 0
				? { permissionRequestedAttempts: [...input.stats.permissionRequestedAttempts] }
				: {}),
			...(input.stats.judgeAllowedAttempts.length > 0
				? { judgeAllowedAttempts: [...input.stats.judgeAllowedAttempts] }
				: {}),
		},
		noop: headlessNoop(input.stats),
		...(unclassified !== null ? { unclassifiedAfterLastCheck: unclassified } : {}),
		...(input.costCap !== undefined ? { costCap: input.costCap } : {}),
		...(snapshot.runtimeResolution ? { runtimeResolution: snapshot.runtimeResolution } : {}),
		terminalReason: mainAgentTerminalReason(outcome).terminalReason,
		sessionId,
		...(input.calls ? { callIds: input.calls.callIds } : {}),
		// The answer seals in the result object as a worker's does, under the same bound (C-12).
		...(input.answer !== undefined && input.answer.text.length > 0 ? { output: boundedAnswer(input.answer) } : {}),
	};
	try {
		// The run's model calls are journaled in its session; its run scope holds the terminal record and the seal. The
		// run is the main agent's own, so its scope names that agent, not a worker (#434).
		const context: RunOwnerTelemetryContext =
			sessionId === null
				? { sessionId: null, runId: envelope.id, agent: mainAgent(envelope.id) }
				: { sessionId, runId: envelope.id, agent: mainAgent(sessionId) };
		const journal = await openRunTelemetry(context, telemetryRunDirectory(pancodeStateDir(), envelope.id));
		try {
			const finished = finishRunResult(
				draft,
				{ ...envelope, ...terminalPatch },
				{
					terminal: mainAgentTerminalReason(outcome),
					processExitCode: null,
					frameType: null,
					// The run's calls live in its session, so its usage facts are the read model's fold of them (#434).
					usage: input.calls?.facts,
					// Exact past the 50 the receipt lists, so the tools row stops counting the rest as blocked (SC-2).
					askedByTool: input.stats.permissionRequestedByTool,
					// A stalled step pipeline settles `completed` as its turns did; the record says the pipeline stopped (bt-20).
					...(stepPipeline !== null ? { stepPipeline } : {}),
				},
			);
			const completion = sessionId === null ? undefined : await sessionCompletion(sessionId, input.startedAt);
			// What the host saw change that the settled facts cannot carry owes validation as they do (C-37); a --read-only
			// run can change nothing.
			const observedChange = !input.stats.readOnly && (changedWorkspace(input.stats) || input.stats.mutatingSucceeded);
			const assessment = finished.settlement.assessment;
			const settlement =
				assessment !== undefined
					? {
							...finished.settlement,
							assessment: { ...assessment, ...(completion !== undefined ? { completion } : {}), observedChange },
						}
					: finished.settlement;
			await journal.settle(settlement);
		} finally {
			await journal.close();
		}
		ledger.update(envelope.id, terminalPatch);
	} catch (error) {
		const detail = `finalization failure: ${error instanceof Error ? error.message : String(error)}`;
		process.stderr.write(`pancode run: run record write failed: ${detail}\n`);
		ledger.update(envelope.id, { ...terminalPatch, status: "failed", outcome: "failed", outcomeDetail: detail });
	}
	await ledger.persist();
}
