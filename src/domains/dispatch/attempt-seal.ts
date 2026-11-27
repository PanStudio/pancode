// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { relative, resolve as resolvePath } from "node:path";
import { changedCheckoutPaths } from "../../tools/checkout-changes.js";
import { discardIdleTaskWorktree, settleTaskWorktree } from "../../tools/task-worktree.js";
import { LEFT_UNCOMMITTED_LIST_LIMIT } from "../../tools/worktree-commit.js";
import {
	type AcceptedWorkerSlates,
	recordAcceptedWorkerSlates,
	recordHostVerificationClaims,
	snapshotAcceptedWorkerSlates,
} from "../claims/index.js";
import { publishAgentLedgerEntry } from "./agent-ledger-hub.js";
import { appendAgentLedgerReport } from "./agent-ledger-store.js";
import type { FinalizingAttempt, LandedSettlement } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { runSettlementReceiptFields, sealRouteDecision } from "./bundle-support.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import {
	classifyFailure,
	honestWorkerSpecSkewText,
	isContextOverflowFailure,
	nodeComponentRemedy,
} from "./failure-classification.js";
import { cleanupFleetChangeReturn } from "./fleet-change-return.js";
import type { RunVerdict } from "./grading.js";
import { resolveRunTerminalReason, runStatusForOutcome } from "./outcome.js";
import { verificationWithHostVerdict } from "./run-findings.js";
import { emitTerminalDispatchEvent, sealTaskWorktreeReceipt } from "./run-finish.js";
import { idleBuilderOutcome } from "./run-outcome-detail.js";
import { settleRunResult } from "./run-settlement.js";
import type { RunEnvelope } from "./types.js";
import type { WriteBoundaryAttributionDowngrade } from "./write-boundary.js";
import { recordedLimitationsFromEntries } from "./write-root-requests.js";

export async function sealAttemptReceipt(rt: DispatchRuntime, attempt: FinalizingAttempt, settling: LandedSettlement) {
	const { context } = rt;
	const { firstNotice, recordTargetOutcome } = rt.core;
	let worktreeReceipt = settling.worktreeReceipt;
	const {
		activeRun,
		agentLedgerId,
		buildReceiptDraft,
		callUsage,
		checkoutBaseline,
		closeRunJournal,
		envelope,
		finalizing,
		finishContractEntries,
		ledgerRef,
		lifecycle,
		placed,
		remoteReturn,
		req,
	} = attempt;
	const {
		assurance,
		capturedOutput,
		checkoutAfter,
		checkoutBefore,
		claimReleased,
		endedAt,
		evidence,
		finalCallUsage,
		gradeContract,
		hostVerification,
		hypothesisBindings,
		observedRunEffects,
		result,
		sealedResultContractFact,
		steering,
		validationGrounding,
	} = settling;

	if (settling.graded.qualityGateFailure) evidence.qualityGateFailure = true;
	if (settling.graded.retryObligation !== null) evidence.obligationUnmet = settling.graded.retryObligation;
	const runVerdict: RunVerdict = {
		version: 1,
		obligation: gradeContract.obligation,
		rules: settling.graded.rules,
		assurance,
	};
	const status = runStatusForOutcome(settling.finalOutcome);
	const failureClass = classifyFailure(
		evidence,
		result,
		settling.finalOutcome,
		attempt.outcomeCode,
		attempt.providerErrorMessage,
	);
	const contextOverflow = isContextOverflowFailure(
		failureClass,
		result,
		attempt.outcomeCode,
		attempt.providerErrorMessage,
	);
	// A released node's skew refusal asks for a re-dispatch that earns the
	// same refusal; the receipt reports the build skew instead.
	let receiptResult =
		failureClass === "node-version" && typeof result.stderrTail === "string"
			? { ...result, stderrTail: honestWorkerSpecSkewText(result.stderrTail) }
			: result;
	// A node worker missing an SDK component names the install for its own
	// machine; the operator runs the client command that installs it there.
	if (failureClass === "deterministic-task" && placed.kind !== "local") {
		if (attempt.failureMessage !== undefined)
			attempt.failureMessage = nodeComponentRemedy(attempt.failureMessage, placed.id);
		if (settling.finalDetail !== null) settling.finalDetail = nodeComponentRemedy(settling.finalDetail, placed.id);
		if (typeof receiptResult.stderrTail === "string")
			receiptResult = { ...receiptResult, stderrTail: nodeComponentRemedy(receiptResult.stderrTail, placed.id) };
	}
	const receiptDraft = buildReceiptDraft(
		receiptResult,
		endedAt,
		status,
		settling.finalOutcome,
		settling.finalDetail,
		capturedOutput,
		steering,
		sealedResultContractFact,
		validationGrounding === null ? null : { ...validationGrounding, ungrounded: [...validationGrounding.ungrounded] },
	);
	receiptDraft.verdict = runVerdict;
	// What the run's limitation calls recorded, which its own report can leave out (row 371).
	const recordedLimitationCalls = recordedLimitationsFromEntries(finishContractEntries);
	if (recordedLimitationCalls.length > 0) receiptDraft.recordedLimitations = recordedLimitationCalls;
	const terminal = resolveRunTerminalReason(evidence, attempt.outcomeCode);
	attempt.resolvedTerminal = terminal;
	Object.assign(receiptDraft, runSettlementReceiptFields(terminal, callUsage?.snapshot()));
	if (checkoutBaseline !== null) {
		if (checkoutAfter !== null && checkoutAfter.root === checkoutBaseline.root) {
			receiptDraft.checkoutChanges = {
				cwd: checkoutBaseline.root,
				changedPaths: changedCheckoutPaths(checkoutBaseline, checkoutAfter),
				attribution: "observed-delta",
			};
		}
	}
	if (hostVerification !== undefined) {
		receiptDraft.hostVerification = hostVerification;
		receiptDraft.verification = verificationWithHostVerdict(receiptDraft.verification, hostVerification);
	}
	if (remoteReturn && worktreeReceipt) {
		// The remote commit's byproducts stay on the node, so the local commit never saw them.
		const remoteLeft = attempt.remoteImport?.leftUncommitted;
		const localLeft = worktreeReceipt.leftUncommitted;
		worktreeReceipt = {
			...worktreeReceipt,
			...(remoteLeft !== undefined
				? {
						leftUncommitted: {
							count: remoteLeft.count + (localLeft?.count ?? 0),
							paths: [...remoteLeft.paths, ...(localLeft?.paths ?? [])].slice(0, LEFT_UNCOMMITTED_LIST_LIMIT),
						},
					}
				: {}),
			detail: [
				worktreeReceipt.detail,
				`SSH return from ${placed.id}: branch ${remoteReturn.worktree.branch}, path ${remoteReturn.worktree.path}, commit ${attempt.remoteImport?.commit ?? "not imported"}; remote work preserved unless the guarded local application succeeds`,
			]
				.filter(Boolean)
				.join("; "),
		};
	}
	worktreeReceipt = sealTaskWorktreeReceipt(
		{ context },
		req,
		envelope.id,
		worktreeReceipt,
		settling.accounted,
		receiptDraft,
	);
	// The harness read its own files unreconciled; the operator owns them and hears once per process.
	const peerStale = lifecycle.peerStale;
	if (
		peerStale !== undefined &&
		lifecycle.projectContext.peerInstructions?.delivery === "coexist" &&
		firstNotice(`peer-stale\0${peerStale.message}`)
	) {
		context.bus.emit("run.scope_notice_raised", {
			code: "peer_instructions_stale",
			level: "warning",
			agentId: req.agentId,
			runId: envelope.id,
			files: peerStale.files,
			stale: peerStale.stale,
			message: peerStale.message,
		});
	}
	// A hypothesis slate the worker wrote enters the log only once the host accepted the run into the project
	// (#406): a merged task worktree's changed paths, or the observed writes of a run in the checkout that
	// settled succeeded; nothing the worker reported is used. The bytes are read here, in the same synchronous
	// step that accepted the run, and recorded after the receipt is sealed only while the files still hold them.
	let acceptedSlates: AcceptedWorkerSlates = [];
	const checkoutChanges = receiptDraft.checkoutChanges;
	const acceptedPaths =
		settling.finalOutcome !== "succeeded"
			? []
			: req.taskWorktree !== undefined
				? worktreeReceipt?.applied === true
					? (worktreeReceipt.changedPaths ?? []).map((path) => resolvePath(req.taskWorktree?.root ?? lifecycle.cwd, path))
					: []
				: checkoutChanges !== undefined && checkoutBefore !== null
					? checkoutChanges.changedPaths.map((path) => resolvePath(checkoutChanges.cwd, path))
					: [...observedRunEffects.mutatedPaths];
	if (acceptedPaths.some((path) => path.endsWith(".json"))) {
		try {
			acceptedSlates = snapshotAcceptedWorkerSlates({
				projectCwd: req.taskWorktree?.root ?? lifecycle.cwd,
				paths: acceptedPaths,
			});
		} catch (error) {
			reportDispatchDiagnostic(`read hypothesis slates for ${envelope.id}`, error);
		}
	}
	const ledgerPatch: Partial<RunEnvelope> = {
		status,
		outcome: settling.finalOutcome,
		outcomeCode: attempt.outcomeCode,
		outcomeDetail: receiptDraft.outcomeDetail ?? settling.finalDetail,
		...(steering.length > 0 ? { steering: steering.map((entry) => ({ ...entry })) } : {}),
		endedAt,
		exitCode: receiptDraft.exitCode,
		spend: receiptDraft.spend,
		spendSums: receiptDraft.spendSums,
		sessionShellHash: receiptDraft.sessionShellHash ?? null,
		dynamicHash: receiptDraft.dynamicHash ?? null,
		...(activeRun.heartbeatAt ? { heartbeatAt: rt.heartbeat.heartbeatIso(activeRun.heartbeatAt) } : {}),
	};
	activeRun.sealing = true;
	if (attempt.runJournal === undefined) throw new Error(`run ${envelope.id} has no run journal to settle in`);
	const receipt = await settleRunResult(
		ledgerRef,
		envelope.id,
		sealRouteDecision(receiptDraft, attempt.routeObservation.decision),
		ledgerPatch,
		attempt.runJournal,
		{
			terminal,
			processExitCode: result.exitCode,
			frameType: result.channelFailure ?? null,
			usage: finalCallUsage?.facts,
			...(attempt.reportedRepairRounds !== undefined ? { repairRounds: attempt.reportedRepairRounds } : {}),
		},
	);
	// Host-verified reproduce and numeric-compare verdicts become claims in the operator's project, keyed by the
	// sealed receipt (#406). Awaited so a headless run cannot exit first; a failed write never fails the run.
	if (receipt.hostVerification !== undefined && receipt.hostVerification.checks.length > 0) {
		try {
			await recordHostVerificationClaims({
				runId: receipt.runId,
				receiptDigest: receipt.digest,
				checks: receipt.hostVerification.checks,
				projectCwd: req.taskWorktree?.root ?? lifecycle.cwd,
				...(hypothesisBindings !== undefined ? { hypotheses: hypothesisBindings } : {}),
			});
		} catch (error) {
			reportDispatchDiagnostic(`record claims for ${envelope.id}`, error);
		}
	}
	if (acceptedSlates.length > 0) {
		try {
			const ingested = await recordAcceptedWorkerSlates({
				runId: receipt.runId,
				receiptDigest: receipt.digest,
				projectCwd: req.taskWorktree?.root ?? lifecycle.cwd,
				slates: acceptedSlates,
			});
			if (ingested.drifted.length > 0)
				reportDispatchDiagnostic(
					`record hypotheses for ${envelope.id}`,
					new Error(
						`not recorded, changed after the host accepted the run: ${ingested.drifted.map((path) => relative(lifecycle.cwd, path) || path).join(", ")}`,
					),
				);
		} catch (error) {
			reportDispatchDiagnostic(`record hypotheses for ${envelope.id}`, error);
		}
	}
	if (lifecycle.runtimeKind !== "http" && agentLedgerId !== null && attempt.agentLedgerAttribution !== null) {
		void appendAgentLedgerReport(agentLedgerId, attempt.agentLedgerAttribution, receipt)
			.then((posted) => {
				if (posted.ok) publishAgentLedgerEntry(agentLedgerId, posted.entry);
				else reportDispatchDiagnostic(`publish final report for ${envelope.id}`, new Error(posted.reason));
			})
			.catch((error) => reportDispatchDiagnostic(`publish final report for ${envelope.id}`, error));
	}
	// Two independent ways a run's write record can fail to be a closed
	// list, and either one files it as `null` rather than as an empty
	// one. The difference decides whether the write boundary may clear a
	// path it did not see this run touch.
	//
	// The telemetry axis is whether the events were seen at all: a
	// subprocess runtime publishes no tool events, and a partial trail
	// has its holes exactly where an unobserved write would sit.
	//
	// The opacity axis is whether the events that were seen say enough.
	// A run that called bash, verify, dispatch, or steer to a clean exit
	// could have written through a channel no argument names, so nothing
	// in the checkout can be cleared on the strength of its absence from
	// the set. That run's window keeps today's blame-the-whole-diff
	// behaviour; a run that never touched such a tool keeps the
	// protection.
	const toolTelemetryComplete = receipt.safety?.toolTelemetry?.coverage === "complete";
	const downgrades: WriteBoundaryAttributionDowngrade[] = observedRunEffects.writeRecordDowngrades.map((entry) => ({
		reason: entry.reason,
		tool: entry.tool,
		toolCallId: entry.toolCallId,
		runId: envelope.id,
		stepId: null,
	}));
	if (!toolTelemetryComplete) {
		downgrades.push({
			reason: "incomplete_tool_telemetry",
			tool: null,
			toolCallId: null,
			runId: envelope.id,
			stepId: null,
		});
	}
	rt.runs.recordRunWriteAttribution(envelope.id, {
		recorded: [...observedRunEffects.mutatedPaths],
		complete: toolTelemetryComplete && observedRunEffects.writeRecordComplete,
		downgrades,
	});
	await ledgerRef.persist();
	if (worktreeReceipt?.applied === true && req.taskWorktree !== undefined) {
		try {
			if (remoteReturn && attempt.remoteImport) await cleanupFleetChangeReturn(remoteReturn, attempt.remoteImport);
		} catch (cleanupError) {
			reportDispatchDiagnostic(`clean applied task worktree ${req.taskWorktree.runId}`, cleanupError);
		}
	} else if (req.taskWorktree !== undefined && !claimReleased) {
		// The run is over and its worktree stays for the operator (preserve
		// mode, a failed run, a refused merge). Saying so on the claim keeps
		// restart recovery from reading it as a crash.
		try {
			// A canceled run that never produced work leaves nothing to keep. An idle builder that left its
			// obligation unmet keeps the tree until the retry decision below, since its retry runs in it.
			if (
				!(
					(settling.finalOutcome === "canceled" ||
						(idleBuilderOutcome(attempt.outcomeCode) &&
							evidence.obligationUnmet === undefined &&
							!rt.retry.writeRootPark.isStaged(envelope.id))) &&
					discardIdleTaskWorktree(req.taskWorktree)
				)
			) {
				settleTaskWorktree(req.taskWorktree, settling.accounted);
			}
		} catch (settleError) {
			reportDispatchDiagnostic(`settle task worktree ${req.taskWorktree.runId}`, settleError);
		}
	}
	rt.runs.active.delete(envelope.id);
	recordTargetOutcome(
		envelope.id,
		lifecycle.target.target.id,
		lifecycle.target.runtime.id,
		lifecycle.target.wireModelId,
		status,
		receipt.exitCode,
		failureClass,
	);
	attempt.targetOutcomeRecorded = true;
	rt.heartbeat.recordNodeChannelOutcome(activeRun, settling.finalOutcome, failureClass, settling.finalDetail);
	rt.runs.accumulateFinalizedTotals(receipt);
	// A terminal event's readers show the sealed record, so the seal lands first with the feed's last rows in it.
	rt.runs.journalBridge?.closeFeed(settling.finalOutcome, receipt.outcomeDetail, {
		runId: envelope.id,
		agentId: req.agentId,
		exitCode: receipt.exitCode,
	});
	await closeRunJournal();
	attempt.terminalEventEmitted = true;
	emitTerminalDispatchEvent({ context }, finalizing, receipt, settling.finalOutcome);
	const continues = rt.retry.completeAssignmentAttempt(
		activeRun,
		receipt,
		settling.finalOutcome,
		receipt.outcomeDetail ?? settling.finalDetail,
		failureClass,
		contextOverflow,
		evidence.obligationUnmet,
	);
	attempt.assignmentCompleted = true;
	// The idle tree kept above goes once no retry will run in it.
	if (
		!continues &&
		idleBuilderOutcome(attempt.outcomeCode) &&
		evidence.obligationUnmet !== undefined &&
		req.taskWorktree !== undefined &&
		worktreeReceipt?.applied !== true &&
		!claimReleased
	) {
		try {
			discardIdleTaskWorktree(req.taskWorktree);
		} catch (discardError) {
			reportDispatchDiagnostic(`discard idle task worktree ${req.taskWorktree.runId}`, discardError);
		}
	}
	return receipt;
}
