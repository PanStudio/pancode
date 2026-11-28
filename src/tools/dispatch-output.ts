// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { workerMcpNoNetworkNotice } from "../core/sandbox/worker-policy.js";
import { sumRunSpend } from "../core/telemetry/pricing.js";
import { renderFactField, renderPricingSum } from "../core/telemetry/render.js";
import { readAgentLedger } from "../domains/dispatch/agent-ledger-store.js";
import { assignmentNotRetried } from "../domains/dispatch/assignment.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { WithheldCapability } from "../domains/dispatch/envelope.js";
import type { PendingGateDecisionHandle } from "../domains/dispatch/gate-decisions.js";
import { explainRouteDecision } from "../domains/dispatch/routing-intent.js";
import type { RunEnvelope, RunResult } from "../domains/dispatch/types.js";
import { extractRunProvenance, provenanceCompactSuffix } from "../domains/evidence/provenance.js";
import { summarizeTrustStatus } from "../domains/evidence/trust-projection.js";
import { runtimeResolutionWarnings } from "../domains/providers/runtime-resolution.js";
import { type FlowRestrictionSet, mergeFlowRestrictions } from "../domains/safety/information-flow.js";
import type { DispatchEventSummary } from "./dispatch-run-events.js";
import { scoutTransitionDetail } from "./dispatch-scout.js";
import type { DispatchResultForm, DispatchToolDeps } from "./dispatch-types.js";
import { FLOW_RESTRICTIONS_DETAIL } from "./registry-verdicts.js";
import type { ToolResultDetails } from "./tool-spec.js";
import { truncateUtf8 } from "./truncate-utf8.js";
import {
	checksAreReviewJudgments,
	compactAnswer,
	compactEvidenceLabels,
	compactHelperResultLines,
	finishedRun,
	finishedRunTrustStatus,
	fullAnswerPointer,
	PRODUCER_INTEGRITY,
	reviewFindingCount,
	runAnswerBudgetBytes,
	runEvidenceLabels,
	runHelperResult,
	SPOT_CHECK_GUIDANCE,
	workerTextLabel,
	workerTextNonEvidenceNotices,
} from "./worker-evidence.js";

const TRUNCATION_MARKER = "\n[agent output truncated]";

export type EventSummary = DispatchEventSummary;

/**
 * The sync counterpart, read back from the run's ledger projection: every capability its envelope withheld, grouped
 * by reason on one line. The remedies are on the plan card and in the worker's prompt; this line stays short because
 * it leads the bounded summary.
 */
function withheldNotice(run: CompletedRun): string | null {
	const withheld = run.withheld ?? [];
	if (withheld.length === 0) return null;
	const groups = new Map<string, string[]>();
	for (const entry of withheld) groups.set(entry.reason, [...(groups.get(entry.reason) ?? []), entry.capability]);
	const listed = [...groups].map(([reason, capabilities]) => `${capabilities.join(", ")} (${reason})`).join("; ");
	const checks = groups.has("write-roots-unconfined")
		? ": its write roots had neither an OS sandbox nor a task worktree binding commands to them, so it ran no checks; run them in the host workspace before reporting them passed"
		: "";
	return `${run.receipt.runId} ran without ${listed}${checks}.`;
}

/**
 * Surfaces a succeeded run's outcomeDetail to the calling model. Today that
 * detail is only set for runs that finished without a successful tool call;
 * the dispatch summary must not flatter such a run as plainly "completed".
 */
function successNote(receipt: RunResult): string | null {
	if (receipt.outcome !== undefined && receipt.outcome !== "succeeded") return null;
	if (receipt.exitCode !== 0) return null;
	return (
		[receipt.outcomeDetail, receipt.worktree?.applied ? receipt.worktree.detail : null].filter(Boolean).join("; ") || null
	);
}

/**
 * The warnings the dispatch side resolved the worker's route with, such as a thinking level the model could not
 * run. The worker feed carries them as `route_warning` events; this hands the same words to the dispatching model.
 */
function routeWarningLines(receipt: RunResult): string[] {
	return runtimeResolutionWarnings(receipt.runtimeResolution?.diagnostics ?? []).map(
		(message) => `route_warning ${receipt.runId}: ${message}`,
	);
}

// The worker's denial for an operator-authority ask nobody can answer (src/engine/worker-escalation.ts).
const OPERATOR_UNAVAILABLE_DENIAL =
	/^permission denied by policy: \S+ raised an operator-authority ask and no operator can answer worker asks/u;

/**
 * One line when the worker had calls denied because they needed an operator and no operator can answer worker asks
 * for this dispatch. The policy stands; the parent learns the worker's own checks were limited, so a pass the
 * worker reports does not cover what those calls would have checked (bt-23).
 */
function operatorUnavailableLine(receipt: RunResult): string | null {
	const denied = (receipt.safety?.permissionRequestedAttempts ?? []).filter((attempt) =>
		OPERATOR_UNAVAILABLE_DENIAL.test(attempt.reason ?? ""),
	);
	if (denied.length === 0) return null;
	const tools = [...new Set(denied.map((attempt) => attempt.tool))].join(", ");
	return (
		`verification_limited ${receipt.runId}: ${denied.length} worker ${denied.length === 1 ? "call" : "calls"} (${tools}) ` +
		"needed operator approval that no one can give a worker in this dispatch, so they did not run; " +
		"run any check they covered yourself before relying on the worker's verification."
	);
}

/**
 * Declared expected outputs absent on disk once the run settled. A worker whose contract puts its document elsewhere
 * (an architect plan under .pancode/artifacts) names the path it wrote in its answer, and the caller moves the file
 * where the task wanted it instead of searching for it (row 295). A merged task worktree is removed after merge-back,
 * so the paths its merge added or modified count as written; a path it deleted does not (M-17).
 */
function unwrittenExpectedOutputsLine(receipt: RunResult): string | null {
	const outputs = receipt.intent?.expectedOutputs ?? [];
	const roots = [receipt.worktree?.path, receipt.reproducibility?.cwd].filter((root) => root !== undefined);
	if (outputs.length === 0 || roots.length === 0) return null;
	const deleted = new Set(receipt.worktree?.deletedPaths ?? []);
	const merged = new Set(
		receipt.worktree?.applied === true ? (receipt.worktree.changedPaths ?? []).filter((path) => !deleted.has(path)) : [],
	);
	const missing = outputs.filter(
		(output) => !merged.has(output) && !roots.some((root) => existsSync(resolvePath(root, output))),
	);
	if (missing.length === 0) return null;
	return `expected_outputs ${receipt.runId}: not written ${JSON.stringify(missing)}; its answer names what it wrote, so move or write these where the task needs them`;
}

/**
 * When the host feed recorded calls that errored or were refused, one line with its counts. A worker has reported a
 * malformed attempt the feed never saw and more denials than happened, and the parent repeated the worker's account
 * (bt-23).
 */
function attemptFactsLine(receipt: RunResult): string | null {
	if (receipt.externalTelemetry?.toolTelemetry === "unavailable") return null;
	let errored = 0;
	let refused = 0;
	const tools: string[] = [];
	for (const stat of receipt.toolStats) {
		errored += stat.errors;
		refused += stat.blocked;
		if (stat.errors + stat.blocked > 0) tools.push(stat.tool);
	}
	if (tools.length === 0) return null;
	return (
		`attempts ${receipt.runId}: the host feed recorded ${receipt.toolCalls} ${receipt.toolCalls === 1 ? "call" : "calls"}, ` +
		`${errored} errored and ${refused} refused (${tools.join(", ")}). Report these counts, not the worker's account of its attempts.`
	);
}

export interface CompletedRun {
	recording?: import("../domains/dispatch/index.js").RecordingReference;
	readOnly?: boolean;
	receipt: RunResult;
	/**
	 * New files a compete candidate's commit left out. The candidate's worktree
	 * is the runner's, not the run's, so its sealed receipt carries no worktree.
	 */
	leftUncommitted?: NonNullable<RunResult["worktree"]>["leftUncommitted"];
	summary: EventSummary;
	/** Reviewer/judge output staged before its receipt settlement boundary. */
	pendingGate?: PendingGateDecisionHandle;
	/** Earlier attempts of this assignment that failed before the recovery whose receipt this is, oldest first. */
	failedAttempts?: ReadonlyArray<FailedAttempt>;
	/** Why the assignment settled on this failed attempt with no further attempt, such as a suppressed retry. */
	notRetried?: string;
	/** What the run's envelope withheld, read back from its ledger projection (M7). */
	withheld?: ReadonlyArray<WithheldCapability>;
}

export interface FailedAttempt {
	runId: string;
	attempt: number;
	outcome: string;
	outcomeCode: string | null;
	detail: string | null;
}

/**
 * A recovery attempt's success settles the assignment, but the attempts it replaced stay on the parent's record:
 * each is read back from its own run along the receipt's retry lineage (cf1h-D3).
 */
export function earlierFailedAttempts(
	getRun: (runId: string) => RunEnvelope | null,
	start: RunEnvelope["lineage"],
): FailedAttempt[] {
	const failed: FailedAttempt[] = [];
	let lineage = start;
	while (lineage !== undefined && lineage.attempt > 0 && lineage.parentRunId !== null) {
		const prior = getRun(lineage.parentRunId);
		const attempt = prior?.lineage?.attempt ?? lineage.attempt - 1;
		if (prior === null || attempt >= lineage.attempt) break;
		if (prior.outcome !== "succeeded")
			failed.unshift({
				runId: prior.id,
				attempt,
				outcome: prior.outcome ?? prior.status,
				outcomeCode: prior.outcomeCode ?? null,
				detail: prior.outcomeDetail ?? null,
			});
		lineage = prior.lineage;
	}
	return failed;
}

/**
 * A failed run's assignment states why no further attempt ran; the sealed receipt cannot, since that decision follows
 * it. Settlement lands with the durable writes, so they are flushed first (D3-c). A settlement with no detail is a
 * policy decision, so the line states the outcome and the retries used against maxRetries.
 */
export async function withNotRetried(deps: DispatchToolDeps, runs: readonly CompletedRun[]): Promise<CompletedRun[]> {
	if (!runs.some((run) => run.receipt.exitCode !== 0)) return [...runs];
	await deps.dispatch.assignments?.flushWrites?.();
	return runs.map((run) => {
		if (run.receipt.exitCode === 0) return run;
		// The attempt id resolves to its assignment. A hosted run's published lineage root names the main run, which
		// keys no assignment, so headless `run` printed no not_retried line (bt-45 D3-c).
		const assignment = deps.dispatch.assignments?.get(run.receipt.runId);
		const notRetried = assignmentNotRetried(assignment, run.receipt);
		return notRetried === null ? run : { ...run, notRetried };
	});
}

export function recoveredAttemptLines(terminalRunId: string, failedAttempts: ReadonlyArray<FailedAttempt>): string[] {
	return failedAttempts.map((prior) => {
		const detail = prior.detail && prior.detail.length > 240 ? `${prior.detail.slice(0, 239)}…` : prior.detail;
		return `recovered ${terminalRunId} after attempt ${prior.attempt} ${prior.runId} ${prior.outcome}: ${prior.outcomeCode ?? "no outcome code"}${detail ? ` (${detail})` : ""}`;
	});
}

/**
 * Assemble the parent-facing completion record for a settled run. The result is
 * the one dispatch handed back in memory, so it is authentic as held.
 */
export function completeRun(
	deps: DispatchToolDeps,
	receipt: RunResult,
	summary: EventSummary,
	pendingGate?: PendingGateDecisionHandle,
): CompletedRun {
	const envelope = deps.dispatch.getRun(receipt.runId);
	const failedAttempts = earlierFailedAttempts((id) => deps.dispatch.getRun(id), envelope?.lineage ?? receipt.lineage);
	// The sealed envelope's write mode is the one definition of read-only (M7). An ACP receipt has no envelope, only
	// the record-only permit it states; a receipt with neither never ran a worker, so it changed nothing.
	const mode = receipt.safety?.envelope?.write.mode;
	const readOnly = mode !== undefined ? mode === "none" : (receipt.safety?.permit?.ceiling?.readOnly ?? true);
	return {
		readOnly,
		receipt,
		...(envelope?.recording !== undefined ? { recording: envelope.recording } : {}),
		summary,
		...(pendingGate !== undefined ? { pendingGate } : {}),
		...(failedAttempts.length > 0 ? { failedAttempts } : {}),
		...(envelope?.projection?.withheld !== undefined ? { withheld: envelope.projection.withheld } : {}),
	};
}

/**
 * Whether a run's claimed checks are code checks the host can rerun. Telling
 * the parent to inspect a diff and run verify() for a read-only reviewer's
 * judgments sent it after a tool the session never declared (WTF-P session
 * 3nm95m0q8jfb).
 */
function claimsHostRerunnableChecks(receipt: RunResult, readOnly: boolean): boolean {
	return !checksAreReviewJudgments(readOnly, receipt.quality?.resultContract?.sourceId);
}

/** Name the next host step from sealed facts when a worker claimed checks it never ran. */
export function nextHostValidationAction(receipt: RunResult, readOnly = false): string | null {
	// A host check that collected no test judged nothing, so it does not stand in for the follow-up (CLI-P51).
	if (
		receipt.hostVerification?.status === "verified" ||
		receipt.hostVerification?.checks.some((check) => check.notRun !== "no-tests")
	)
		return null;
	const grounding = receipt.validationGrounding;
	if (grounding?.basis !== "no-command-executed" || grounding.ungrounded.length === 0) return null;
	if (!claimsHostRerunnableChecks(receipt, readOnly)) {
		return `next step for ${receipt.runId}: use the sealed findings; spot-check consequential claims. Its passing checks are review judgments, not commands it ran.`;
	}
	const declared = receipt.intent?.verification.map((check) => check.check) ?? [];
	const action =
		declared.length > 0
			? `run ${declared.map((check) => `verify(check=${JSON.stringify(check)})`).join(", ")} in the host workspace`
			: "inspect the worker diff, list available host checks with verify(), then run the applicable test or build check in the host workspace";
	return `next host validation for ${receipt.runId}: ${action}; inspect the actual exit code and output, and record that result before reporting verified completion. The worker claimed validation but executed no check.`;
}

/**
 * A withheld merge keeps the worker's commit on its task branch. The worker's
 * own prose can say it did not commit, so the host states where the work is
 * (flywheel p7/A2).
 */
function withheldMergeNotice(receipt: RunResult): string | null {
	const worktree = receipt.worktree;
	if (receipt.outcomeCode !== "merge_withheld" || worktree === undefined) return null;
	if (worktree.applied || worktree.reason === "operator_discarded") return null;
	const commit = worktree.commit !== undefined ? ` at ${worktree.commit.slice(0, 12)}` : "";
	return `merge withheld for ${receipt.runId}: its work is committed on branch ${worktree.branch}${commit} and is not merged into the operator's branch. Report it as committed there and not merged, whatever the worker's text says about committing.`;
}

/** The admission notice for MCP servers the run's sandbox left without network, read back from the sealed receipt. */
function mcpSandboxNoNetworkNotice(receipt: RunResult): string | null {
	const sandbox = receipt.safety?.sandbox;
	const ceiling = receipt.safety?.permit?.ceiling;
	if (sandbox === undefined || ceiling?.mcp === undefined) return null;
	const offered = ceiling.mcp.tools.filter((entry) => ceiling.tools.includes(`mcp_${entry.serverId}__${entry.tool}`));
	const withheld = (ceiling.mcp.networkWithheld ?? []).filter((entry) =>
		offered.some((server) => server.serverId === entry.serverId),
	);
	return workerMcpNoNetworkNotice(sandbox, offered, withheld);
}

/** Totals from the batch's run results, with opaque external tool use kept separate. */
export function dispatchBatchSummary(runs: ReadonlyArray<CompletedRun>): {
	observedToolCalls: number;
	unobservableToolRuns: number;
	cost: string;
} {
	const trusted = runs.map((run) => run.receipt);
	const observable = trusted.filter((receipt) => receipt.externalTelemetry?.toolTelemetry !== "unavailable");
	return {
		observedToolCalls: observable.reduce((total, receipt) => total + receipt.toolCalls, 0),
		unobservableToolRuns: trusted.length - observable.length,
		cost: renderPricingSum(sumRunSpend(trusted)),
	};
}

/**
 * The settled board, appended after the per-run lines. Its budget is reserved
 * out of the output ceiling rather than taken from it, so the board a topology
 * produced is never the part the truncation drops. A topology with no board
 * passes null and the output is byte-identical to what it was before boards
 * reached the main model at all.
 */
function withAgentLedgerBoard(body: string, board: string | null): string {
	return board === null ? body : `${body}\n\n${board}`;
}

/**
 * The model-facing dispatch result. `compact` (the default) keeps each run's key facts, its trust or verdict line and
 * evidence notices, and an excerpt of its answer, pointing at `monitor(mode="record")` for the rest; `full` returns
 * each answer up to its share of `maxOutputBytes`, the form a caller gets by setting max_output_bytes (WTF-P 0.8.3 C3).
 */
export function formatDispatchOutput(
	mode: string,
	runs: ReadonlyArray<CompletedRun>,
	maxOutputBytes: number,
	board: string | null = null,
	form: DispatchResultForm = "compact",
	agentTraits?: DispatchContract["agentTraits"],
): string {
	const failed = runs.filter((run) => run.receipt.exitCode !== 0);
	const recovered = runs.filter((run) => (run.failedAttempts?.length ?? 0) > 0);
	const shareBytes = Math.max(1024, Math.floor(maxOutputBytes / Math.max(1, runs.length)));
	// Integrity failures and the spot-check reminder lead the summary: the
	// truncation below keeps the head and drops the tail, and neither warning
	// may be hidden behind a successful process outcome or a long answer.
	const hostActions = [
		...new Set(
			runs
				.flatMap((run) => [
					nextHostValidationAction(run.receipt, run.readOnly === true),
					withheldNotice(run),
					withheldMergeNotice(run.receipt),
					mcpSandboxNoNetworkNotice(run.receipt),
					...routeWarningLines(run.receipt),
					operatorUnavailableLine(run.receipt),
					attemptFactsLine(run.receipt),
					unwrittenExpectedOutputsLine(run.receipt),
				])
				.filter((action): action is string => action !== null),
		),
	];
	const batch = dispatchBatchSummary(runs);

	const needsSpotCheck = runs.some((run) => {
		const view = finishedRun(run.receipt);
		if (runHelperResult(view, PRODUCER_INTEGRITY) !== null) return false;
		const state = finishedRunTrustStatus(view, PRODUCER_INTEGRITY).validationGrounding.state;
		return state === "absent" || state === "unknown" || state === "ungrounded";
	});
	// An operator cancel is no worker failure, so the header counts it apart.
	const canceled = runs.filter((run) => run.receipt.outcome === "canceled").length;
	const failedNotCanceled = failed.filter((run) => run.receipt.outcome !== "canceled").length;
	const lines = [
		`dispatch (${mode}) total=${runs.length} failed=${failedNotCanceled}${canceled > 0 ? ` canceled=${canceled}` : ""}${recovered.length > 0 ? ` recovered=${recovered.length}` : ""}`,
		`runs=${runs.map((run) => run.receipt.runId).join(", ")}`,
		...recovered.flatMap((run) => recoveredAttemptLines(run.receipt.runId, run.failedAttempts ?? [])),
		...runs.flatMap((run) => (run.notRetried ? [`not_retried ${run.receipt.runId}: ${run.notRetried}`] : [])),
		`batch observed_tool_calls=${batch.observedToolCalls} cost=${batch.cost}${batch.unobservableToolRuns > 0 ? ` unobservable_tool_runs=${batch.unobservableToolRuns}` : ""}`,
		...hostActions,
		...(needsSpotCheck ? [SPOT_CHECK_GUIDANCE] : []),
		"",
	];
	const blocks = runs.map((run, index) => {
		const { receipt } = run;
		const view = finishedRun(receipt);
		// Compact shows the answer budget sealed at dispatch (M3); full is the caller's own max_output_bytes share.
		const perRunOutputBytes = form === "compact" ? runAnswerBudgetBytes(view) : shareBytes;
		const helperLines = compactHelperResultLines(view, PRODUCER_INTEGRITY, perRunOutputBytes);
		const outcome = receipt.outcome ?? (receipt.exitCode === 0 ? "succeeded" : "failed");
		if (helperLines !== null) return { runId: receipt.runId, outcome, answered: true, lines: helperLines };
		const note = successNote(receipt);
		const noteSuffix = note !== null ? ` note=${note}` : "";
		// A non-success outcome is load-bearing evidence (a timeout has no
		// failureMessage at all); render it and its detail on the run line.
		const outcomeSuffix =
			receipt.outcome !== undefined && receipt.outcome !== "succeeded"
				? ` outcome=${receipt.outcome}${receipt.outcomeDetail ? ` detail=${receipt.outcomeDetail}` : ""}`
				: "";
		// The detail usually already carries the failure message; render it once.
		const failure =
			receipt.failureMessage && !(outcomeSuffix && receipt.outcomeDetail?.includes(receipt.failureMessage))
				? ` failure=${receipt.failureMessage}`
				: "";
		// Pipeline runs are an ordered chain, so each line names its step.
		const stepLabel = mode === "pipeline" ? `step ${index + 1}/${runs.length} ` : "";
		// Provenance suffix is empty when a run carries no
		// pipeline/persona/escalation fields, so the line format is unchanged.
		const provenance = provenanceCompactSuffix(extractRunProvenance(receipt));
		// Evidence confidence comes from the run's settled facts, the same ones its run.settled records.
		const trustStatus = finishedRunTrustStatus(view, PRODUCER_INTEGRITY);
		const labels = runEvidenceLabels(view, PRODUCER_INTEGRITY, agentTraits);
		const evidenceSuffix = ` ${(form === "compact" ? compactEvidenceLabels(labels) : labels).join(" ")}`;
		const routingSuffix =
			form === "full" && receipt.routeDecision !== undefined && receipt.routingIntent !== undefined
				? ` route_decision=${receipt.routeDecision.decisionHash} route_mode=${receipt.routeDecision.mode}`
				: "";
		const external = receipt.runtimeKind === "subprocess" || receipt.delegation !== undefined;
		const changedPaths = receipt.worktree?.changedPaths ?? receipt.checkoutChanges?.changedPaths ?? [];
		const changedSuffix =
			receipt.worktree || receipt.checkoutChanges
				? ` changed=${JSON.stringify(changedPaths.slice(0, 20))}${changedPaths.length > 20 ? `(+${changedPaths.length - 20} more)` : ""}`
				: "";
		// Byproducts the host commit kept out of the branch; the main agent decides whether any should ship.
		const leftUncommitted = run.leftUncommitted ?? receipt.worktree?.leftUncommitted;
		const uncommittedSuffix =
			leftUncommitted === undefined
				? ""
				: ` left_uncommitted=${leftUncommitted.count}${JSON.stringify(leftUncommitted.paths)}${leftUncommitted.count > leftUncommitted.paths.length ? `(+${leftUncommitted.count - leftUncommitted.paths.length} more)` : ""}`;
		const placementSuffix = !external
			? ""
			: receipt.worktree
				? ` placement=worktree cwd=${JSON.stringify(receipt.worktree.path)} branch=${JSON.stringify(receipt.worktree.branch)} apply=${receipt.worktree.apply}${receipt.worktree.applied && receipt.worktree.detail ? ` merge=${JSON.stringify(receipt.worktree.detail)}` : ""} diff=${receipt.worktree.diffHash}${changedSuffix}`
				: ` placement=current cwd=${JSON.stringify(receipt.reproducibility?.cwd ?? "unknown")}${changedSuffix}${receipt.checkoutChanges ? " change_attribution=observed-delta" : ""}`;
		// The run's result is authoritative. Live summaries remain useful for
		// monitoring but can contain transient tool-use prose and never override
		// a missing or partial durable answer.
		const answerText =
			receipt.output?.state === "final" || (receipt.outcome !== undefined && receipt.outcome !== "succeeded")
				? (receipt.output?.text ?? "")
				: "";
		const output =
			answerText.length === 0
				? "(no assistant text captured in the run result)"
				: form === "compact"
					? compactAnswer(answerText, receipt.runId, perRunOutputBytes)
					: truncateUtf8(answerText, perRunOutputBytes, TRUNCATION_MARKER);
		return {
			runId: receipt.runId,
			outcome,
			answered: answerText.length > 0,
			lines: [
				`- ${stepLabel}${receipt.runId} agent=${receipt.agentId} exit=${receipt.exitCode} connection=${receipt.targetId} model=${receipt.wireModelId} tokens=${renderFactField(receipt.spend.totalTokens)}${evidenceSuffix}${outcomeSuffix}${noteSuffix}${failure}${provenance}${routingSuffix}${placementSuffix}${uncommittedSuffix}${run.recording ? ` recording_manifest=${JSON.stringify(run.recording.manifestPath)}` : ""}`,
				`  ${workerTextLabel(trustStatus, view)}`,
				...output.split("\n").map((line) => `  ${line}`),
				...workerTextNonEvidenceNotices(view, trustStatus, answerText).map((notice) => `  ${notice}`),
			],
		};
	});
	if (board === null) return fitRunBlocks(lines.join("\n"), blocks, maxOutputBytes);
	const runBudget = Math.max(1024, maxOutputBytes - Buffer.byteLength(board, "utf8") - 2);
	return withAgentLedgerBoard(fitRunBlocks(lines.join("\n"), blocks, runBudget), board);
}

/** One run's part of a batch result: its rendered lines, heading first, and what its stub needs past the cap. */
type RunBlock = { runId: string; outcome: string; answered: boolean; lines: ReadonlyArray<string> };

const textBytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Where a cut run is read: its whole answer, or its run record when it sealed no answer `mode="answer"` returns. */
function cutRunPointer(block: RunBlock): string {
	return block.answered
		? `the whole answer is in ${fullAnswerPointer(block.runId)}`
		: `it sealed no answer; what it recorded is in monitor(mode="record", run_id=${JSON.stringify(block.runId)})`;
}

/**
 * A batch result within `budget` bytes, every run's block whole when they all fit. Past the cap each run keeps its
 * heading and where its answer is read, and a run fills only the room the later runs' headings and pointers leave, so
 * the cap never drops a run without a way back to its answer (M3).
 */
function fitRunBlocks(head: string, blocks: ReadonlyArray<RunBlock>, budget: number): string {
	const bytes = textBytes;
	const texts = blocks.map((block) => block.lines.join("\n"));
	const whole = [head, ...texts].join("\n");
	if (bytes(whole) <= budget) return whole;
	const stubs = blocks.map((block) => ({
		heading: block.lines[0] ?? "",
		pointer: `  [cut by this result's ${budget}-byte cap; ${cutRunPointer(block)}]`,
	}));
	const stubText = ({ heading, pointer }: { heading: string; pointer: string }) => `${heading}\n${pointer}`;
	// Room left once the head and every run's stub, each after a newline, are set aside.
	let room = budget - bytes(head) - stubs.reduce((sum, stub) => sum + bytes(stubText(stub)) + 1, 0);
	if (room < 0) return fitMinimalRuns(head, blocks, stubs.map(stubText), budget);
	const kept = blocks.map((block, index) => {
		const stub = stubs[index] ?? { heading: "", pointer: "" };
		const text = texts[index] ?? "";
		const extra = bytes(text) - bytes(stubText(stub));
		if (extra <= room) {
			room -= extra;
			return text;
		}
		if (room < PARTIAL_RUN_MIN_BYTES) return stubText(stub);
		// The pointer follows as much of the block's body as the room holds.
		const body = truncateUtf8(block.lines.slice(1).join("\n"), room - 1, "");
		room -= bytes(body) + 1;
		return [stub.heading, body, stub.pointer].join("\n");
	});
	return [head, ...kept].join("\n");
}

/**
 * The batch when even every run's heading and pointer overrun `budget`: each run keeps one line with its id, outcome and
 * where it is read, upgraded in order to its heading stub while room lasts. The head's notes give way first, by whole
 * lines after its first. When the run lines overrun anyway, the runs that fit keep them and one closing line names the
 * rest and the collect call that returns them.
 */
function fitMinimalRuns(head: string, blocks: ReadonlyArray<RunBlock>, stubs: ReadonlyArray<string>, budget: number) {
	const bytes = textBytes;
	const lineBytes = (lines: ReadonlyArray<string>) => lines.reduce((sum, line) => sum + bytes(line) + 1, 0);
	// The head within `room` bytes (its join newline included), cut by whole lines and never below its first, or null.
	const headWithin = (room: number): string | null => {
		if (bytes(head) + 1 <= room) return head;
		const marker = `[this batch's remaining notes cut by the ${budget}-byte cap]`;
		const kept: string[] = [];
		let used = bytes(marker) + 1;
		for (const line of head.split("\n")) {
			if (used + bytes(line) + 1 > room) break;
			kept.push(line);
			used += bytes(line) + 1;
		}
		return kept.length > 0 ? [...kept, marker].join("\n") : null;
	};
	const minimal = blocks.map((block) => `- ${block.runId} outcome=${block.outcome} [${cutRunPointer(block)}]`);
	const notice = `[this result's ${budget}-byte cap left some runs only their id, outcome and where they are read]`;
	const headRoom = budget - bytes(notice) - 1 - lineBytes(minimal) + 1;
	const fitted = headWithin(headRoom);
	if (fitted !== null) {
		let room = headRoom - bytes(fitted) - 1;
		const kept = minimal.map((line, index) => {
			const stub = stubs[index] ?? line;
			const extra = bytes(stub) - bytes(line);
			if (extra > room) return line;
			room -= extra;
			return stub;
		});
		return [fitted, notice, ...kept].join("\n");
	}
	const closing = (omitted: ReadonlyArray<RunBlock>) => {
		const ids = omitted.map((block) => block.runId);
		const named = `[${ids.length} of ${blocks.length} runs omitted by this result's ${budget}-byte cap; monitor(mode="collect", run_ids=${JSON.stringify(ids)}) returns them]`;
		return bytes(named) <= budget / 2
			? named
			: `[${ids.length} of ${blocks.length} runs omitted by this result's ${budget}-byte cap, from ${ids[0] ?? "?"} on the runs= line; monitor(mode="collect", run_ids=[...]) returns them]`;
	};
	for (let shown = blocks.length - 1; shown >= 0; shown -= 1) {
		const last = closing(blocks.slice(shown));
		const shownHead = headWithin(budget - lineBytes(minimal.slice(0, shown)) - bytes(last));
		if (shownHead !== null) return [shownHead, ...minimal.slice(0, shown), last].join("\n");
	}
	// Not even the head's first line fits beside the closing line, which then stands alone.
	return truncateUtf8(closing(blocks), Math.max(0, budget - bytes(TRUNCATION_MARKER)), TRUNCATION_MARKER);
}

/** The least spare room worth a partial block; below it a trimmed run shows only its heading and pointer. */
const PARTIAL_RUN_MIN_BYTES = 256;

/** The union of what the collected runs' contexts carried, for the parent ledger to absorb. */
export function flowRestrictionsOfRuns(
	sets: ReadonlyArray<FlowRestrictionSet | null | undefined>,
): FlowRestrictionSet | null {
	return mergeFlowRestrictions(...sets);
}

export function dispatchDetails(
	deps: DispatchToolDeps,
	mode: string,
	runs: ReadonlyArray<CompletedRun>,
	board: string | null = null,
): ToolResultDetails {
	const failed = runs.filter((run) => run.receipt.exitCode !== 0);
	const failedAttempts = runs.flatMap((run) =>
		(run.failedAttempts ?? []).map((prior) => ({ ...prior, recoveredBy: run.receipt.runId })),
	);
	const batch = dispatchBatchSummary(runs);
	const carried = mergeFlowRestrictions(
		flowRestrictionsOfRuns(runs.map((run) => run.receipt.safety?.flowRestrictions)),
		...(board === null
			? []
			: runs.flatMap((run) => {
					const id = deps.dispatch.getRun(run.receipt.runId)?.projection?.ledgerId;
					return id ? (readAgentLedger(id)?.entries ?? []).map((entry) => entry.flowRestrictions) : [];
				})),
	);
	let transition: ReturnType<typeof scoutTransitionDetail> = null;
	for (const run of runs) {
		const envelope = deps.dispatch.getRun(run.receipt.runId);
		const candidate =
			envelope !== null
				? scoutTransitionDetail({ receipt: run.receipt, envelope, agentSpecs: deps.getAgentSpecs() })
				: null;
		if (candidate === null) continue;
		if (transition !== null) {
			transition = null;
			break;
		}
		transition = candidate;
	}
	return {
		mode,
		assignmentIds: runs.map(
			(run) =>
				deps.dispatch.assignments?.getStored(run.receipt.runId)?.assignmentId ??
				run.receipt.lineage?.rootRunId ??
				run.receipt.runId,
		),
		terminalRunIds: runs.map((run) => run.receipt.runId),
		...(carried !== null ? { [FLOW_RESTRICTIONS_DETAIL]: carried } : {}),
		runCount: runs.length,
		failedCount: failed.length,
		...(failedAttempts.length > 0
			? { recoveredCount: new Set(failedAttempts.map((entry) => entry.recoveredBy)).size, failedAttempts }
			: {}),
		batchSummary: batch,
		// Same text the output carries, under a stable key, so a surface that
		// renders details can show the board without re-reading the store.
		...(board !== null ? { agentLedgerBoard: board } : {}),
		...(transition !== null ? { scoutTransition: transition } : {}),
		runs: runs.map(({ receipt, summary, readOnly, recording }) => {
			// Additive provenance keys only; folded in when the result carries the
			// field so a run entry without them keeps its exact shape.
			const provenance = extractRunProvenance(receipt);
			const view = finishedRun(receipt);
			const trustStatus = finishedRunTrustStatus(view, PRODUCER_INTEGRITY);
			const helperResult = runHelperResult(view, PRODUCER_INTEGRITY);
			const found = reviewFindingCount(trustStatus, view);
			return {
				...(helperResult !== null ? { helperResult } : {}),
				runId: receipt.runId,
				agentId: receipt.agentId,
				exitCode: receipt.exitCode,
				...(recording !== undefined ? { recording } : {}),
				eventCount: summary.count,
				verification: receipt.verification,
				hostVerification: receipt.hostVerification ?? null,
				readOnly: readOnly === true,
				...(receipt.toolActivity !== undefined ? { toolActivity: receipt.toolActivity } : {}),
				trustStatus,
				// The bounded projection sits shallow and flat on purpose: a
				// depth-capped wire (ACP rawOutput) keeps it whole while the
				// canonical status's nested references fall off the end.
				trust: summarizeTrustStatus(trustStatus),
				...(found !== undefined ? { reviewFindings: found } : {}),
				...(receipt.outcome !== undefined && receipt.outcome !== "succeeded"
					? { outcome: receipt.outcome, outcomeDetail: receipt.outcomeDetail ?? null }
					: {}),
				...(receipt.worktree !== undefined ||
				receipt.checkoutChanges !== undefined ||
				receipt.runtimeKind === "subprocess" ||
				receipt.delegation !== undefined
					? {
							placement: receipt.worktree
								? { mode: "worktree" as const, ...receipt.worktree }
								: {
										mode: "current" as const,
										cwd: receipt.reproducibility?.cwd ?? null,
										...(receipt.checkoutChanges
											? { changedPaths: receipt.checkoutChanges.changedPaths, attribution: receipt.checkoutChanges.attribution }
											: {}),
									},
						}
					: {}),
				...(provenance.pipeline !== undefined ? { pipeline: provenance.pipeline } : {}),
				...(provenance.personaOverride !== undefined ? { personaOverride: provenance.personaOverride } : {}),
				...(provenance.escalation !== undefined ? { escalation: provenance.escalation } : {}),
				...(receipt.routeDecision !== undefined && receipt.routingIntent !== undefined
					? { routing: explainRouteDecision(receipt.routeDecision, receipt.routingIntent) }
					: {}),
				// The route the worker actually ran, as `run --agent` prints it: resolved model id, thinking, windows.
				...(receipt.runtimeResolution !== undefined ? { runtimeResolution: receipt.runtimeResolution } : {}),
			};
		}),
	};
}
