// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { TelemetryContext } from "../core/telemetry/context.js";
import type { AbortReason, DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { packetProvenance } from "../domains/dispatch/evidence-packet.js";
import { gateDeciderAgentId, withRunRole } from "../domains/dispatch/execution-role.js";
import {
	finalizePendingGateDecision,
	type GateDecisionArtifact,
	type GateDecisionCorrelation,
	type GateDecisionDraft,
	materializePendingGateDecision,
	type PendingGateDecisionHandle,
	parseCompeteGateResult,
	readGateDecisionArtifacts,
	reviewerInspectionOf,
	stagePendingGateDecision,
	stagePendingGateOutput,
	verdictCitesDetail,
} from "../domains/dispatch/gate-decisions.js";
import {
	competePresentationOrder,
	competeStanceFor,
	JUDGE_GATE_PROMPT,
} from "../domains/dispatch/gate-role-prompts.js";
import { narrowDispatchIntentToReadOnly } from "../domains/dispatch/intent.js";
import type { RunResult } from "../domains/dispatch/types.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { buildCompeteJudgePacket, renderCompeteJudgeTask } from "./compete-judge-task.js";
import {
	type CandidateWorktree,
	type CompeteGroupOwnership,
	candidateDiff,
	candidateDiffStat,
	candidateVerification,
	claimCompeteGroup,
	cleanupCompeteGroup,
	commitCandidateWork,
	createCandidateWorktreeMapped,
	isGitRepository,
	loadCompeteGroup,
	markCompeteGroupCleanupReady,
	markCompeteGroupWinnerPreserved,
	mergeWinnerBranch,
	protectedPathsChangedByCompeteBranch,
	recoverCleanupReadyCompeteGroups,
	registerCompeteGroupRun,
	removeCandidateWorktreeMapped,
	settleCompeteGroupRun,
} from "./compete-worktrees.js";
import { newGateGroupId, type RegisteredDispatchToolDeps } from "./dispatch-call.js";
import {
	consumeGateSensitiveDispatchEvents,
	dispatchRoleFacts,
	gateCorrelationOf,
	isPipelineStepFailure,
	judgeIntent,
	normalizedAssistantText,
	pipelineFailureReason,
	subjectRef,
} from "./dispatch-gate-runs.js";
import { type CompletedRun, completeRun, dispatchDetails, formatDispatchOutput } from "./dispatch-output.js";
import { withCompeteCandidateRoute, withResolvedPlanTaskPin } from "./dispatch-plan.js";
import type { DispatchCompeteSettings, DispatchResultForm, DispatchToolDeps } from "./dispatch-types.js";
import type { ToolResult, ToolResultDetails } from "./tool-spec.js";
import { runResultPath } from "./worker-evidence.js";
import { leftUncommittedReport } from "./worktree-branch-diff.js";

/**
 * Candidates may run on different routes, so the judge is correlated on a
 * dimension when it shares that dimension with any candidate, and independent
 * only when it is independent of every candidate.
 */
function competeCorrelation(
	candidates: ReadonlyArray<{ receipt: RunResult }>,
	decider: RunResult,
): GateDecisionCorrelation {
	if (candidates.length === 0) throw new Error("compete decision requires at least one candidate run record");
	const each = candidates.map((candidate) => gateCorrelationOf(candidate.receipt, decider));
	const any = (field: Exclude<keyof GateDecisionCorrelation, "independent">) => each.some((entry) => entry[field]);
	return {
		agent: any("agent"),
		target: any("target"),
		modelFamily: any("modelFamily"),
		runtime: any("runtime"),
		node: any("node"),
		independent: each.every((entry) => entry.independent),
	};
}

export const COMPETE_SINGLE_TASK_MESSAGE = "dispatch: compete requires exactly one task";

export const COMPETE_NO_REVIEW_MESSAGE = "dispatch: compete has its own judge and cannot combine with review";

type CompeteSettings = DispatchCompeteSettings;

interface CompeteOutcome {
	runs: CompletedRun[];
	decisions: Array<{ artifact: GateDecisionArtifact; path: string }>;
	group: string;
	winner: { index: number; branch: string; applied: boolean } | null;
	needsDecision?: string;
}

interface OwnedCompeteRun {
	runId: string;
	settled: boolean;
	abortRequested: boolean;
	settlement: Promise<CompletedRun>;
}

interface CompeteStop {
	message: string;
	reason?: AbortReason;
}

export function competeErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function rejectedReasons(results: ReadonlyArray<PromiseSettledResult<unknown>>): unknown[] {
	return results
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map((result) => result.reason as unknown);
}

/**
 * Best-of-N compete: N candidate builders run the same task in isolated
 * scratch git worktrees, each candidate's work is committed on its branch, a
 * read-only judge ranks them, and the winner is applied (yolo) or handed
 * to the operator (supervised: the winner's branch and worktree survive; the
 * apply_winner action routes through plan approval). Losers are always
 * cleaned, including on abort and on any thrown error.
 */
export async function runCompete(
	deps: RegisteredDispatchToolDeps,
	base: DispatchRequest,
	compete: CompeteSettings,
	autonomy: AutonomyLevel,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	gateTelemetry: TelemetryContext | undefined,
): Promise<CompeteOutcome> {
	const requestedRoot = base.cwd !== undefined && base.cwd.length > 0 ? base.cwd : process.cwd();
	if (!isGitRepository(requestedRoot)) {
		throw new Error(`compete requires a git repository at ${requestedRoot}; scratch worktrees isolate the candidates`);
	}
	const protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
	// Startup recovery intentionally sweeps only groups that another lifecycle
	// durably marked cleanup-ready after all of its workers settled. Active,
	// preserved, and malformed crash leftovers remain untouched.
	await recoverCleanupReadyCompeteGroups(requestedRoot);
	const group = newGateGroupId("compete");
	// Compete opens no agent ledger. A shared board let candidates read each
	// other's live posts, which correlates attempts that are meant to be
	// independent, and its runId-grouped entries told the judge which candidate
	// wrote what. The judge sees only sealed receipt evidence.
	let ownership: CompeteGroupOwnership | null = null;
	const worktrees: CandidateWorktree[] = [];
	const runs: CompletedRun[] = [];
	const decisions: Array<{ artifact: GateDecisionArtifact; path: string }> = [];
	const recordDecision = async (draft: GateDecisionDraft, pending?: PendingGateDecisionHandle) => {
		const decision = pending
			? await finalizePendingGateDecision(pending, draft)
			: await materializePendingGateDecision(
					stagePendingGateDecision(draft, {
						...(gateTelemetry === undefined ? {} : { telemetry: gateTelemetry }),
						resourceRoot: requestedRoot,
					}),
				);
		decisions.push(decision);
		return decision;
	};
	const ownedRuns: OwnedCompeteRun[] = [];
	const abortErrors: unknown[] = [];
	let stop: CompeteStop | null = null;
	let primaryError: unknown = null;
	let winner: CompeteOutcome["winner"] = null;
	const currentWinner = (): CompeteOutcome["winner"] => winner;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let signalListenerInstalled = false;

	const abortOwnedRun = (run: OwnedCompeteRun): void => {
		if (run.settled || run.abortRequested || stop === null) return;
		run.abortRequested = true;
		try {
			deps.dispatch.abort(run.runId, stop.reason);
		} catch (err) {
			abortErrors.push(err);
		}
	};
	const requestStop = (next: CompeteStop): void => {
		if (stop === null) stop = next;
		for (const run of ownedRuns) abortOwnedRun(run);
	};
	const onSignalAbort = (): void => requestStop({ message: "compete dispatch aborted" });
	const throwIfStopped = (): void => {
		if (stop !== null) throw new Error(stop.message);
	};
	// A stopped phase still has terminal receipts worth reporting. Keep the
	// ordinary error result and no winner, without discarding those identities
	// through the generic exception path after the settlement barrier.
	const stoppedOutcome = (): CompeteOutcome | null =>
		stop === null ? null : { runs, decisions, group, winner: null, needsDecision: stop.message };
	const settleRun = async (
		handle: Awaited<ReturnType<DispatchContract["dispatch"]>>,
		request: DispatchRequest,
	): Promise<CompletedRun> => {
		const summaryPromise = consumeGateSensitiveDispatchEvents(deps, handle.runId, request.agentId, handle.events).then(
			(summary) => {
				const pendingGate =
					request.gate?.role === "judge"
						? stagePendingGateOutput({
								...(gateTelemetry === undefined ? {} : { telemetry: gateTelemetry }),
								group: request.gate.group,
								topology: "compete",
								cycle: request.gate.cycle,
								subjects: request.gate.subjects ?? [],
								deciderRunId: summary.terminalAttemptRunId,
								finalOutput: normalizedAssistantText(summary),
								// Always recorded, so restart settlement never has to guess the
								// root from whichever process happens to recover the record.
								resourceRoot: request.cwd ?? requestedRoot,
							})
						: undefined;
				return { summary, pendingGate };
			},
		);
		const [summaryResult, receiptResult] = await Promise.allSettled([summaryPromise, handle.finalPromise]);
		const failures = rejectedReasons([summaryResult, receiptResult]);
		if (failures.length > 0) {
			throw new Error(`run ${handle.runId} failed to settle: ${failures.map(competeErrorMessage).join("; ")}`);
		}
		const summaryWithGate = summaryResult.status === "fulfilled" ? summaryResult.value : null;
		const receipt = receiptResult.status === "fulfilled" ? receiptResult.value : null;
		if (summaryWithGate === null || receipt === null) throw new Error(`run ${handle.runId} produced no settled result`);
		return completeRun(deps, receipt, summaryWithGate.summary, summaryWithGate.pendingGate);
	};
	const admitOwnedRun = async (request: DispatchRequest, label: string): Promise<OwnedCompeteRun> => {
		try {
			const handle = await deps.dispatch.dispatch(request, {
				onAdmitted(admission) {
					if (ownership === null) throw new Error(`compete ${group} has no active ownership claim`);
					registerCompeteGroupRun(ownership, admission);
				},
			});
			const owned: OwnedCompeteRun = {
				runId: handle.runId,
				settled: false,
				abortRequested: false,
				settlement: Promise.resolve(null as never),
			};
			ownedRuns.push(owned);
			owned.settlement = (async () => {
				try {
					return await settleRun(handle, request);
				} catch (err) {
					requestStop({ message: `${label} failed to settle: ${competeErrorMessage(err)}` });
					throw err;
				} finally {
					owned.settled = true;
					if (ownership !== null) settleCompeteGroupRun(ownership, owned.runId);
				}
			})();
			// A concurrent admission can fail before this settlement is awaited.
			// Attach a sink immediately while preserving the original promise for
			// the transaction's mandatory all-settled barrier.
			owned.settlement.catch(() => {});
			if (stop !== null) abortOwnedRun(owned);
			return owned;
		} catch (err) {
			requestStop({ message: `${label} admission failed: ${competeErrorMessage(err)}` });
			throw err;
		}
	};
	const settledCompletedRuns = async (owned: ReadonlyArray<OwnedCompeteRun>, phase: string): Promise<CompletedRun[]> => {
		const results = await Promise.allSettled(owned.map((run) => run.settlement));
		const failures = rejectedReasons(results);
		if (failures.length > 0) {
			throw new Error(`${phase} failed: ${failures.map(competeErrorMessage).join("; ")}`);
		}
		return results.map((result) => {
			if (result.status !== "fulfilled") throw new Error(`${phase} produced no completed run`);
			return result.value;
		});
	};

	let outcome: CompeteOutcome | null = null;
	try {
		outcome = await (async (): Promise<CompeteOutcome> => {
			// The owner manifest is the transaction's first group-specific mutation;
			// every branch and worktree created below is covered by finalization.
			ownership = claimCompeteGroup(requestedRoot, group);
			const root = ownership.root;
			for (let index = 1; index <= compete.candidates; index += 1) {
				throwIfStopped();
				const customCreate = deps.competeWorktrees?.createCandidate;
				worktrees.push(
					await (customCreate
						? customCreate(ownership, index, "HEAD")
						: createCandidateWorktreeMapped(ownership, index, "HEAD", deps.competeWorktrees?.mux)),
				);
			}

			if (timeoutMs !== undefined) {
				timer = setTimeout(
					() =>
						requestStop({
							message: `compete dispatch timed out after ${timeoutMs}ms`,
							reason: { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
						}),
					timeoutMs,
				);
			}
			signal?.addEventListener("abort", onSignalAbort, { once: true });
			signalListenerInstalled = signal !== undefined;
			if (signal?.aborted) onSignalAbort();
			throwIfStopped();

			// Candidates run concurrently through the normal per-run admission path;
			// every admission promise is observed to settlement. The first rejection
			// aborts known siblings, and any sibling accepted later sees `stop` and is
			// aborted before it can escape the transaction.
			// Declared checks run in each candidate's own worktree at its own settlement, never across candidates (M10a).
			// They move after the plan pin, which reseals the checks admission resolved in the checkout.
			const candidateRequests = worktrees.map((worktree) => {
				const pinned = withResolvedPlanTaskPin(
					withRunRole(
						{
							...withCompeteCandidateRoute(base, compete.candidateRoutes, worktree.index),
							cwd: worktree.path,
							protectedArtifactRemap: { sourceRoot: root, workerRoot: worktree.path },
							gate: {
								role: "candidate",
								group,
								cycle: worktree.index,
								...(worktree.provenance ? { worktree: worktree.provenance } : {}),
							},
							competeStance: competeStanceFor(group, worktree.index),
						},
						dispatchRoleFacts(deps),
					),
					compete.resolvedTasks?.find((task) => task.role === "candidate" && task.position === worktree.index),
				);
				const checks = pinned.resolvedVerification ?? [];
				return checks.length > 0 ? { ...pinned, ...candidateVerification(root, worktree, checks) } : pinned;
			});
			const admissionResults = await Promise.allSettled(
				worktrees.map((worktree, position) =>
					admitOwnedRun(candidateRequests[position] as DispatchRequest, `candidate ${worktree.index}`),
				),
			);
			const admissionFailures = rejectedReasons(admissionResults);
			if (admissionFailures.length > 0) {
				const admissionMessage = `compete candidate admission failed: ${admissionFailures
					.map(competeErrorMessage)
					.join("; ")}`;
				requestStop({ message: admissionMessage });
				// All admission promises have now settled, including late accepts. Wait
				// for every accepted run before finalization removes any path.
				await Promise.allSettled(ownedRuns.map((run) => run.settlement));
				throw new Error(admissionMessage);
			}
			const candidateOwned = admissionResults.map((result) => {
				if (result.status !== "fulfilled") throw new Error("compete candidate admission produced no handle");
				return result.value;
			});
			const candidateRuns = await settledCompletedRuns(candidateOwned, "candidate settlement");
			runs.push(...candidateRuns);
			const stoppedCandidates = stoppedOutcome();
			if (stoppedCandidates !== null) return stoppedCandidates;
			const stats = worktrees.map((worktree, index) => {
				const receipt = candidateRuns[index]?.receipt;
				const failed = receipt !== undefined && isPipelineStepFailure(receipt);
				if (failed) return "builder failed";
				const candidate = candidateRuns[index];
				if (candidate !== undefined && candidate.readOnly !== true) {
					// Without a write record whose tool trail was complete the host cannot
					// tell the candidate's new files from its byproducts, so it takes them all.
					const attribution = deps.dispatch.observedRunWriteAttribution?.(candidate.receipt.runId) ?? null;
					const recorded =
						attribution === null ||
						(attribution.downgrades ?? []).some((entry) => entry.reason === "incomplete_tool_telemetry")
							? null
							: attribution.recorded;
					const left = leftUncommittedReport(
						commitCandidateWork(worktree, `pancode compete ${group} candidate ${worktree.index}`, recorded).leftUncommitted,
					);
					if (left !== undefined) candidate.leftUncommitted = left;
				}
				return candidateDiffStat(root, worktree.branch);
			});
			const candidateEvidence = candidateRuns.map((run, index) => {
				const worktree = worktrees[index];
				return {
					receipt: run.receipt,
					resultPath: runResultPath(run.receipt),
					diff: worktree === undefined ? null : candidateDiff(root, worktree.branch),
				};
			});
			if (candidateRuns.every((run) => isPipelineStepFailure(run.receipt))) {
				await recordDecision({
					group,
					topology: "compete",
					cycle: 1,
					outcome: "no-winner",
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
					detail: "every candidate builder failed; nothing to judge",
				});
				return { runs, decisions, group, winner: null, needsDecision: "every candidate builder failed; nothing to judge" };
			}
			const judgeRequest: DispatchRequest = {
				agentId: gateDeciderAgentId(compete.judge?.agent),
				...(base.budget === undefined ? {} : { budget: base.budget }),
				...(base.record === undefined ? {} : { record: base.record }),
				executionRole: "judge",
				task: renderCompeteJudgeTask(
					base.task,
					worktrees,
					stats,
					candidateEvidence,
					competePresentationOrder(group, worktrees.length),
				),
				// Candidate prose and receipt locators are evidence, not inferred authority.
				// Read-only execution is enforced by the role/autonomy, not empty write roots.
				// These roots are the subjects' scope, what the judge may read; its obligation is cited evidence, not reads (M1).
				// The judge runs no check: the candidates' host check results are in its task.
				intent: judgeIntent(
					narrowDispatchIntentToReadOnly(
						base.intent ?? {
							version: 2,
							readRoots: [],
							writeRoots: [],
							relevantPaths: [],
							pathProvenance: [],
							expectedOutputs: [],
							verification: [],
						},
					),
				),
				systemPrompt: JUDGE_GATE_PROMPT,
				readOnly: true,
				cwd: root,
				gate: {
					role: "judge",
					group,
					cycle: 1,
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
					packet: packetProvenance(buildCompeteJudgePacket(worktrees, candidateEvidence)),
				},
				...(compete.judge?.model !== undefined ? { model: compete.judge.model } : {}),
				...(compete.judge?.target !== undefined ? { target: compete.judge.target } : {}),
				...(compete.judge?.node !== undefined ? { node: compete.judge.node } : {}),
				...(base.plan !== undefined ? { plan: base.plan } : {}),
				...(base.parentToolCallId !== undefined ? { parentToolCallId: base.parentToolCallId } : {}),
				...(base.rootRequestOrigin !== undefined ? { rootRequestOrigin: base.rootRequestOrigin } : {}),
				...(base.decisionRefs !== undefined ? { decisionRefs: base.decisionRefs } : {}),
				...(base.reservation !== undefined
					? { reservation: { ownerId: base.reservation.ownerId, memberId: base.reservation.memberId } }
					: {}),
			};
			throwIfStopped();
			const judgeOwned = await admitOwnedRun(
				withResolvedPlanTaskPin(
					judgeRequest,
					compete.resolvedTasks?.find((task) => task.role === "judge"),
					{ pinTask: false },
				),
				"judge",
			);
			const judgeRun = (await settledCompletedRuns([judgeOwned], "judge settlement"))[0];
			if (judgeRun === undefined) throw new Error("judge produced no completed run");
			runs.push(judgeRun);
			const stoppedJudge = stoppedOutcome();
			if (stoppedJudge !== null) return stoppedJudge;
			const judgeReceipt = judgeRun.receipt;
			const judgeSummary = judgeRun.summary;
			// Every judged outcome names the same subjects, decider, and correlation;
			// only the reason the gate produced no applicable winner differs.
			const noWinner = (detail: string, outcome: "no-winner" | "exhausted" = "no-winner"): GateDecisionDraft => ({
				group,
				topology: "compete",
				cycle: 1,
				outcome,
				subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
				decider: subjectRef(judgeReceipt),
				correlation: competeCorrelation(candidateRuns, judgeReceipt),
				detail,
			});
			if (isPipelineStepFailure(judgeReceipt)) {
				// A verdict citing none of its evidence packet is not a verdict: the gate is exhausted (M10).
				if (reviewerInspectionOf(judgeReceipt).obligationUnmet) {
					const reason = judgeReceipt.outcomeDetail ?? "obligation cited-evidence unmet";
					await recordDecision(noWinner(reason, "exhausted"), judgeRun.pendingGate);
					return {
						runs,
						decisions,
						group,
						winner: null,
						needsDecision: `compete gate exhausted: judge run ${judgeReceipt.runId} ${reason}; candidate worktrees were cleaned, their run records remain; the operator decides`,
					};
				}
				await recordDecision(noWinner(`judge ended ${pipelineFailureReason(judgeReceipt)}`), judgeRun.pendingGate);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `judge run ${judgeReceipt.runId} ended ${pipelineFailureReason(judgeReceipt)}; candidate worktrees were cleaned, their run records remain; re-run compete or build directly`,
				};
			}
			const judged = parseCompeteGateResult(normalizedAssistantText(judgeSummary), compete.candidates);
			if (!judged.ok) {
				await recordDecision(noWinner(judged.reason), judgeRun.pendingGate);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `${judged.reason}; candidate worktrees were cleaned, their run records remain; re-run compete or build directly`,
				};
			}
			const pick = judged.result.winner;
			const pickedWorktree = worktrees.find((worktree) => worktree.index === pick);
			const pickedRun = candidateRuns[pick - 1];
			if (!pickedWorktree || pickedRun === undefined || isPipelineStepFailure(pickedRun.receipt)) {
				await recordDecision(noWinner(`judge picked failed or missing candidate ${pick}`), judgeRun.pendingGate);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `judge picked candidate ${pick}, whose builder failed; the operator decides`,
				};
			}
			const protectedChanges = protectedPathsChangedByCompeteBranch(root, pickedWorktree.branch, protectedPaths);
			if (protectedChanges.length > 0) {
				await recordDecision(
					noWinner(`judge-selected candidate ${pick} changes protected artifact(s): ${protectedChanges.join(", ")}`),
					judgeRun.pendingGate,
				);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `candidate ${pick} changes protected artifact(s) and cannot be applied: ${protectedChanges.join(", ")}`,
				};
			}
			const winnerRef = {
				index: pick,
				subject: subjectRef(pickedRun.receipt),
				branch: pickedWorktree.branch,
			};
			const winnerDecision = await recordDecision(
				{
					group,
					topology: "compete",
					cycle: 1,
					outcome: "winner",
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
					decider: subjectRef(judgeReceipt),
					correlation: competeCorrelation(candidateRuns, judgeReceipt),
					winner: winnerRef,
					detail: verdictCitesDetail(judged.result.checks),
				},
				judgeRun.pendingGate,
			);
			if (autonomy === "yolo") {
				const merge = (deps.competeWorktrees?.mergeWinner ?? mergeWinnerBranch)(root, pickedWorktree.branch);
				if (!merge.ok) {
					winner = { index: pick, branch: pickedWorktree.branch, applied: false };
					return {
						runs,
						decisions,
						group,
						winner,
						needsDecision: `winner candidate ${pick} merge was refused (${merge.reason}); its branch ${pickedWorktree.branch} is preserved`,
					};
				}
				try {
					await recordDecision({
						group,
						topology: "compete",
						cycle: 1,
						outcome: "yolo-applied",
						subjects: [winnerRef.subject],
						winner: winnerRef,
						confirmation: {
							id: winnerDecision.artifact.id,
							digest: winnerDecision.artifact.integrity.digest,
						},
						detail: `yolo applied ${pickedWorktree.branch} under dispatch plan ${base.plan?.hash ?? "unavailable"}`,
					});
				} catch (error) {
					winner = { index: pick, branch: pickedWorktree.branch, applied: false };
					throw new Error(
						`winner ${pickedWorktree.branch} merged but yolo application evidence failed: ${competeErrorMessage(error)}; branch preserved for recovery`,
					);
				}
				winner = { index: pick, branch: pickedWorktree.branch, applied: true };
				return { runs, decisions, group, winner };
			}
			winner = { index: pick, branch: pickedWorktree.branch, applied: false };
			return { runs, decisions, group, winner };
		})();
	} catch (err) {
		primaryError = err;
	}
	if (timer) clearTimeout(timer);
	if (signalListenerInstalled) signal?.removeEventListener("abort", onSignalAbort);

	// No path may be removed while a worker can still write through it. On
	// every exceptional exit, abort all accepted runs (including late
	// admissions) and await the settlement promise that drains both events
	// and final receipt completion.
	if (ownedRuns.some((run) => !run.settled)) {
		requestStop({ message: "compete lifecycle exited before every worker settled" });
	}
	const finalizationErrors: unknown[] = [];
	await Promise.allSettled(ownedRuns.map((run) => run.settlement));
	finalizationErrors.push(...abortErrors);

	// Losers are always cleaned; the winner's worktree and branch survive
	// only while an operator decision is pending (supervised pick or a
	// failed merge). Every removed candidate is archived under a durable recovery ref. The durable state transition happens after the worker
	// barrier and before deletion, defining the safe restart boundary.
	const winnerAtFinalization = currentWinner();
	if (ownership !== null) {
		if (winnerAtFinalization !== null && !winnerAtFinalization.applied) {
			try {
				ownership = markCompeteGroupWinnerPreserved(ownership, winnerAtFinalization.index);
				for (const worktree of worktrees) {
					if (worktree.index === winnerAtFinalization.index) continue;
					try {
						await removeCandidateWorktreeMapped(ownership, worktree, true, deps.competeWorktrees?.mux);
					} catch (err) {
						finalizationErrors.push(err);
					}
				}
			} catch (err) {
				// Without the preserved-state record, retain every candidate; a
				// later process must not guess which path is safe to remove.
				finalizationErrors.push(err);
			}
		} else {
			try {
				ownership = markCompeteGroupCleanupReady(ownership);
			} catch (err) {
				finalizationErrors.push(err);
			}
			try {
				if (deps.competeWorktrees?.mux) {
					for (const worktree of worktrees) {
						await removeCandidateWorktreeMapped(ownership, worktree, true, deps.competeWorktrees.mux);
					}
				}
				const cleanupGroup = deps.competeWorktrees?.cleanupGroup ?? cleanupCompeteGroup;
				await cleanupGroup(ownership);
			} catch (err) {
				finalizationErrors.push(err);
			}
		}
	}

	if (finalizationErrors.length > 0) {
		const unique = [...new Set(finalizationErrors)];
		const suffix = unique.map(competeErrorMessage).join("; ");
		if (primaryError !== null) {
			throw new Error(`${competeErrorMessage(primaryError)}; compete finalization also failed: ${suffix}`);
		}
		throw new Error(`compete finalization failed: ${suffix}`);
	}
	if (primaryError !== null) throw primaryError;
	if (outcome === null) throw new Error("compete lifecycle produced no outcome");
	return outcome;
}

/**
 * Apply a preserved compete winner. Plan-scale by definition, so default
 * autonomy parks this call for operator confirmation; the approval IS
 * the winner confirmation. After a successful merge scratch worktrees are cleaned up; candidate recovery refs remain.
 */
export async function runApplyWinner(
	input: { branch: string; cwd: string },
	planHash: string,
	authority:
		| { outcome: "operator-confirmed"; requestId: string; requestedBy: string }
		| { outcome: "yolo-applied" }
		| null,
	gateTelemetry: TelemetryContext | undefined,
	mergeWinner: typeof mergeWinnerBranch = mergeWinnerBranch,
	protectedPaths: ReadonlyArray<string> = [],
): Promise<ToolResult> {
	if (authority === null) {
		return {
			kind: "error",
			message: "dispatch: apply_winner requires a registry-authenticated operator approval or yolo authority",
		};
	}
	const branch = input.branch;
	const match = /^(?:pancode|pancode)\/compete\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([1-9]\d*)$/.exec(branch);
	if (!match) {
		return {
			kind: "error",
			message: "dispatch: apply_winner.branch must be a pancode/compete/<group>/<n> branch",
		};
	}
	const group = match[1] ?? "";
	const winnerIndex = Number.parseInt(match[2] ?? "", 10);
	const root = input.cwd;
	if (!isGitRepository(root)) {
		return { kind: "error", message: `dispatch: apply_winner requires a git repository at ${root}` };
	}
	await recoverCleanupReadyCompeteGroups(root);
	const ownership = loadCompeteGroup(root, group);
	if (ownership === null) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} has no matching compete ownership manifest; refusing to merge or delete unproven state`,
		};
	}
	if (ownership.state !== "winner-preserved" || ownership.winnerIndex !== winnerIndex) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} does not match the preserved winner recorded for compete group ${group}`,
		};
	}
	const winnerDecision = readGateDecisionArtifacts(group)
		.filter(
			(entry) =>
				entry.artifact.outcome === "winner" &&
				entry.artifact.winner?.index === winnerIndex &&
				entry.artifact.winner.branch === branch,
		)
		.sort(
			(left, right) =>
				left.artifact.createdAt.localeCompare(right.artifact.createdAt) ||
				left.artifact.id.localeCompare(right.artifact.id),
		)
		.at(-1);
	if (winnerDecision === undefined || winnerDecision.artifact.winner === undefined) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} has no integrity-valid judge decision; refusing an unauditable confirmation`,
		};
	}
	const winnerRef = winnerDecision.artifact.winner;
	const protectedChanges = protectedPathsChangedByCompeteBranch(root, branch, protectedPaths);
	if (protectedChanges.length > 0) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} changes protected artifact(s) and cannot be merged: ${protectedChanges.join(", ")}`,
		};
	}
	const writeConfirmation = (): Promise<{ artifact: GateDecisionArtifact; path: string }> =>
		materializePendingGateDecision(
			stagePendingGateDecision(
				{
					group,
					topology: "compete",
					cycle: 1,
					outcome: authority.outcome,
					subjects: [winnerRef.subject],
					winner: winnerRef,
					confirmation: {
						id: winnerDecision.artifact.id,
						digest: winnerDecision.artifact.integrity.digest,
					},
					detail:
						authority.outcome === "operator-confirmed"
							? `operator confirmation ${authority.requestId} (${authority.requestedBy}) approved ${branch} under dispatch plan ${planHash}`
							: `yolo applied ${branch} under dispatch plan ${planHash}`,
				},
				{ ...(gateTelemetry === undefined ? {} : { telemetry: gateTelemetry }) },
			),
		);
	let confirmation: { artifact: GateDecisionArtifact; path: string } | null = null;
	if (authority.outcome === "operator-confirmed") {
		try {
			confirmation = await writeConfirmation();
		} catch (err) {
			return {
				kind: "error",
				message: `dispatch: could not persist operator confirmation for ${branch}: ${competeErrorMessage(err)}`,
			};
		}
	}
	const merge = mergeWinner(root, branch);
	if (!merge.ok) {
		return {
			kind: "error",
			message: `dispatch: merge of winner branch ${branch} was refused: ${merge.reason}; the branch is preserved`,
			...(confirmation !== null
				? { details: { confirmationPath: confirmation.path, confirmationId: confirmation.artifact.id } }
				: {}),
		};
	}
	if (authority.outcome === "yolo-applied") {
		try {
			confirmation = await writeConfirmation();
		} catch (err) {
			return {
				kind: "error",
				message: `dispatch: winner branch ${branch} was merged, but yolo application evidence failed: ${competeErrorMessage(err)}; branch is preserved for recovery`,
				details: { mode: "apply_winner", branch, group, applied: true, evidencePending: true },
			};
		}
	}
	if (confirmation === null) {
		return { kind: "error", message: `dispatch: winner branch ${branch} was merged without confirmation evidence` };
	}
	try {
		const cleanupOwnership = markCompeteGroupCleanupReady(ownership);
		cleanupCompeteGroup(cleanupOwnership);
	} catch (err) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} was merged, but compete cleanup failed: ${competeErrorMessage(err)}`,
			details: {
				mode: "apply_winner",
				branch,
				group,
				applied: true,
				cleanupPending: true,
				confirmationPath: confirmation.path,
				confirmationId: confirmation.artifact.id,
			},
		};
	}
	return {
		kind: "ok",
		output: `winner ${branch} merged into the current branch; compete group ${group} scratch cleaned up; candidate states remain under refs/pancode/compete/ (list with git for-each-ref)`,
		details: {
			mode: "apply_winner",
			branch,
			group,
			confirmationPath: confirmation.path,
			confirmationId: confirmation.artifact.id,
		},
	};
}

export function competeResult(
	deps: DispatchToolDeps,
	outcome: CompeteOutcome,
	autonomy: AutonomyLevel,
	maxOutputBytes: number,
	form: DispatchResultForm,
): ToolResult {
	const body = formatDispatchOutput(
		"compete",
		outcome.runs,
		maxOutputBytes,
		null,
		form,
		deps.dispatch.agentTraits?.bind(deps.dispatch),
	);
	const details: ToolResultDetails = {
		...dispatchDetails(deps, "compete", outcome.runs),
		compete: {
			group: outcome.group,
			winner: outcome.winner,
			decisions: outcome.decisions.map(({ artifact, path }) => ({
				id: artifact.id,
				outcome: artifact.outcome,
				path,
				digest: artifact.integrity.digest,
			})),
			...(outcome.needsDecision !== undefined ? { needsDecision: outcome.needsDecision } : {}),
		},
	};
	if (outcome.winner?.applied === true) {
		return {
			kind: "ok",
			output: `compete winner candidate ${outcome.winner.index} applied (branch ${outcome.winner.branch} merged); candidate states remain under refs/pancode/compete/ (list with git for-each-ref)\n\n${body}`,
			details,
		};
	}
	if (outcome.winner !== null && outcome.needsDecision === undefined) {
		const lines = [
			`compete winner: candidate ${outcome.winner.index} (branch ${outcome.winner.branch}), preserved for confirmation at autonomy ${autonomy}`,
			`Apply it with dispatch apply_winner={branch: "${outcome.winner.branch}"}; the approval prompt is the winner confirmation. Losing candidate states remain under refs/pancode/compete/; list them with git for-each-ref.`,
		];
		return { kind: "ok", output: `${lines.join("\n")}\n\n${body}`, details };
	}
	return {
		kind: "error",
		message: `dispatch: compete needs an operator decision: ${outcome.needsDecision ?? "no winner"}\n\n${body}`,
		details,
	};
}
