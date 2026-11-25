// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { pancodeStateDir } from "../core/xdg.js";
import { projectLedgerAssignments, projectReceiptFindings } from "../domains/dispatch/agent-ledger.js";
import { closeAgentLedger, openAgentLedger, renderAgentLedgerBoard } from "../domains/dispatch/agent-ledger-store.js";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { readVerifiedRun, type SettledRunRecord } from "../domains/telemetry/index.js";
import {
	fallbackProgressBus,
	newGateGroupId,
	PARENT_CANCEL,
	type RegisteredDispatchToolDeps,
} from "./dispatch-call.js";
import { type BackgroundSwitch, DispatchBackgroundedError, watchGrantYield } from "./dispatch-detach.js";
import { isPipelineStepFailure, pipelineFailureReason } from "./dispatch-gate-runs.js";
import { type CompletedRun, completeRun } from "./dispatch-output.js";
import type { DispatchToolDeps } from "./dispatch-types.js";

export class PipelineHaltError extends Error {
	constructor(
		message: string,
		readonly runs: ReadonlyArray<CompletedRun>,
	) {
		super(message);
		this.name = "PipelineHaltError";
	}
}

function ledgerProjectionFor(deps: DispatchToolDeps, ledgerId: string) {
	const runs = deps.dispatch.listRuns().filter((run) => run.projection?.ledgerId === ledgerId);
	const settled = new Map<string, SettledRunRecord | null>();
	// S8: a run whose seal does not verify cannot appear as findings on the board.
	const readRun = (run: RunEnvelope): SettledRunRecord | null => {
		if (!settled.has(run.id)) settled.set(run.id, readVerifiedRun(pancodeStateDir(), run.id));
		return settled.get(run.id) ?? null;
	};
	return {
		assignments: projectLedgerAssignments(runs, readRun),
		// Each run's answer is printed above the board, so its findings are not repeated there.
		answered: projectReceiptFindings(runs, readRun),
	};
}

/**
 * One at a time: each run completes before the next dispatches. Also serves
 * single-task parallel calls, where batching adds nothing. The timeout and
 * abort signal cover the whole sequence; remaining tasks are skipped once
 * either fires and the skip is reported through the thrown error.
 */
export async function runSequential(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	mode: string,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	background: BackgroundSwitch,
): Promise<CompletedRun[]> {
	const runs: CompletedRun[] = [];
	let expired = false;
	let activeRunId: string | null = null;
	// The operator signal is a cancel; the timer is a timeout. Both stop the
	// sequence, but the timeout carries a cause so the receipt names it.
	const abortActive = (bySignal: boolean): void => {
		expired = true;
		if (activeRunId !== null) {
			deps.dispatch.abort(
				activeRunId,
				bySignal ? PARENT_CANCEL : { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
			);
		}
	};
	const onSignalAbort = (): void => abortActive(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abortActive(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		for (const [index, request] of requests.entries()) {
			if (expired || signal?.aborted) {
				throw new Error(
					`${mode} dispatch stopped after ${runs.length}/${requests.length} task(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
				);
			}
			const handle = await deps.dispatch.dispatch(request);
			activeRunId = handle.runId;
			const registered = deps.runEvents.registerSingle(handle, request.agentId, fallbackProgressBus(deps));
			const completion = registered.completion.then((value) => ({ kind: "completed" as const, value }));
			const grantYield = watchGrantYield(deps.dispatch, () => [handle.runId]);
			const settled = await Promise.race([
				completion,
				background.requested.then(() => ({ kind: "background" as const })),
				grantYield.requested,
			]).finally(() => grantYield.dispose());
			if (settled.kind === "background" || settled.kind === "yield") {
				// activeRunId stays set on purpose: the finally below only clears the
				// timer and the abort listener, and the live step must survive both.
				completion.catch(() => {});
				throw new DispatchBackgroundedError(
					newGateGroupId("batch"),
					[{ runId: handle.runId, assignmentId: handle.runId, agentId: request.agentId }],
					[...runs],
					requests.slice(index + 1).map((later) => later.agentId),
					null,
					settled.kind === "yield" ? settled.views : [],
				);
			}
			activeRunId = null;
			runs.push(completeRun(deps, settled.value.receipt, settled.value.summary));
		}
		return runs;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

/**
 * Chain worker outputs: each step runs to completion, then its final assistant
 * text is threaded to the next step as `pipelineInput` (data, not instruction
 * text). Step 1 receives none. A failed step halts the chain and the thrown
 * error names the step and how many later steps were skipped, mirroring
 * runSequential's "stopped after N/M" phrasing. Whole-sequence timeout and
 * abort handling match runSequential.
 */
export async function runPipeline(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<CompletedRun[]> {
	const runs: CompletedRun[] = [];
	let expired = false;
	let activeRunId: string | null = null;
	// The operator signal is a cancel; the timer is a timeout. Both stop the
	// chain, but the timeout carries a cause so the receipt names it.
	const abortActive = (bySignal: boolean): void => {
		expired = true;
		if (activeRunId !== null) {
			deps.dispatch.abort(
				activeRunId,
				bySignal ? PARENT_CANCEL : { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
			);
		}
	};
	const onSignalAbort = (): void => abortActive(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abortActive(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		let previous: { runId: string; text: string } | null = null;
		for (const [index, base] of requests.entries()) {
			if (expired || signal?.aborted) {
				throw new Error(
					`pipeline dispatch stopped after ${runs.length}/${requests.length} task(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
				);
			}
			// Thread the previous step's output as data; the task string the
			// orchestrator authored is sent verbatim. Step 1 (previous === null)
			// carries no pipeline input.
			const request: DispatchRequest =
				previous === null
					? base
					: { ...base, pipelineInput: { fromRunId: previous.runId, position: index + 1, text: previous.text } };
			const handle = await deps.dispatch.dispatch(request);
			activeRunId = handle.runId;
			const registered = deps.runEvents.registerSingle(handle, request.agentId, fallbackProgressBus(deps));
			const { receipt, summary } = await registered.completion;
			activeRunId = null;
			runs.push(completeRun(deps, receipt, summary));
			// Execution can succeed while a conforming report records a failed
			// check. Keep that receipt truthful, but do not feed failed quality
			// into a dependent step. Review/compete use failure to drive their
			// own repair loops, so this condition belongs only to the pipeline.
			const failedQuality = receipt.quality.resultContract?.quality === "fail";
			if (isPipelineStepFailure(receipt) || failedQuality) {
				const skipped = requests.length - (index + 1);
				const reason = isPipelineStepFailure(receipt) ? pipelineFailureReason(receipt) : "result quality=fail";
				throw new PipelineHaltError(
					`pipeline dispatch halted at step ${index + 1}/${requests.length} (run ${receipt.runId}, ${reason}); skipped ${skipped} later step(s)`,
					[...runs],
				);
			}
			previous = {
				runId: receipt.runId,
				text: receipt.output?.state === "final" ? receipt.output.text : "",
			};
		}
		return runs;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

interface BatchOutcome {
	runs: CompletedRun[];
	/** Rendered board of the batch's shared ledger, null when nothing was posted. */
	board: string | null;
}

export async function runBatch(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	background: BackgroundSwitch,
): Promise<BatchOutcome> {
	// This arm is the concurrent parallel fan-out, so its peers can see each
	// other. The ledger opens before admission and every request carries it, so
	// no worker spawns into a dispatch whose board it cannot reach.
	const ledgerId = newGateGroupId("ledger");
	await openAgentLedger(ledgerId);
	const ledgered = requests.map((request) => ({ ...request, ledger: { id: ledgerId, sequence: 0 } }));
	const handle = await deps.dispatch.dispatchBatch(ledgered);
	const registered = deps.runEvents.registerBatch(
		handle,
		ledgered.map((request) => request.agentId),
		fallbackProgressBus(deps),
	);
	// The operator signal is a cancel; the timer is a timeout. The timeout
	// carries a cause so each killed run's receipt names it.
	const abort = (bySignal: boolean): void => {
		const reason = bySignal ? PARENT_CANCEL : ({ cause: "timeout", detail: `timed out after ${timeoutMs}ms` } as const);
		for (const runId of handle.assignmentIds) deps.dispatch.abort(runId, reason);
	};
	const onSignalAbort = (): void => abort(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abort(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	// The board closes when the batch settles in this call. A backgrounded
	// batch settles elsewhere: its runs are still live and still posting, so
	// the ledger rides on the converted record and closes at collect instead.
	let backgrounded = false;
	try {
		const completion = registered.completion.then((value) => ({ kind: "completed" as const, value }));
		const grantYield = watchGrantYield(deps.dispatch, () => handle.assignmentIds);
		const settled = await Promise.race([
			completion,
			background.requested.then(() => ({ kind: "background" as const })),
			grantYield.requested,
		]).finally(() => grantYield.dispose());
		if (settled.kind === "background" || settled.kind === "yield") {
			// The batch drain keeps metering; only this await unwinds. Every run in
			// a parallel batch is already live, so the whole batch converts.
			completion.catch(() => {});
			backgrounded = true;
			throw new DispatchBackgroundedError(
				handle.batchId,
				handle.assignmentIds.map((runId, index) => ({
					runId,
					assignmentId: runId,
					agentId: ledgered[index]?.agentId ?? "unknown",
				})),
				[],
				[],
				ledgerId,
				settled.kind === "yield" ? settled.views : [],
			);
		}
		const { summaries, receipts } = settled.value;
		await closeAgentLedger(ledgerId);
		// Closing drains queued admissions before the final snapshot is rendered.
		const board = renderAgentLedgerBoard(ledgerId, ledgerProjectionFor(deps, ledgerId));
		return {
			runs: receipts.map((receipt) =>
				completeRun(
					deps,
					receipt,
					summaries.get(receipt.runId) ?? {
						count: 0,
						types: [],
						lastAssistantText: "",
						terminalAttemptRunId: receipt.runId,
					},
				),
			),
			board,
		};
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
		if (!backgrounded) await closeAgentLedger(ledgerId);
	}
}

/** Admit one checkout writer at a time while every read-only peer remains concurrent. */
export async function runWriterLimitedBatch(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<BatchOutcome> {
	const specs = new Map(deps.getAgentSpecs().map((spec) => [spec.id, spec]));
	const readers = requests.filter((request) => specs.get(request.agentId)?.capabilityClass === "read-only");
	const writers = requests.filter((request) => specs.get(request.agentId)?.capabilityClass !== "read-only");
	const ledgerId = newGateGroupId("ledger");
	await openAgentLedger(ledgerId);
	const activeIds = new Set<string>();
	const completed = new Map<DispatchRequest, CompletedRun>();
	const start = async (request: DispatchRequest): Promise<CompletedRun> => {
		const ledgered = { ...request, ledger: { id: ledgerId, sequence: 0 } };
		const handle = await deps.dispatch.dispatch(ledgered);
		activeIds.add(handle.runId);
		const registered = deps.runEvents.registerSingle(handle, request.agentId, fallbackProgressBus(deps));
		const value = await registered.completion;
		activeIds.delete(handle.runId);
		const run = completeRun(deps, value.receipt, value.summary);
		completed.set(request, run);
		return run;
	};
	const abort = (bySignal: boolean): void => {
		const reason = bySignal ? PARENT_CANCEL : ({ cause: "timeout", detail: `timed out after ${timeoutMs}ms` } as const);
		for (const runId of activeIds) deps.dispatch.abort(runId, reason);
	};
	const onSignalAbort = (): void => abort(true);
	const timer = timeoutMs === undefined ? null : setTimeout(() => abort(false), timeoutMs);
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		const readerPromises = readers.map((request) => start(request));
		for (const writer of writers) await start(writer);
		await Promise.all(readerPromises);
		await closeAgentLedger(ledgerId);
		return {
			runs: requests.flatMap((request) => {
				const run = completed.get(request);
				return run === undefined ? [] : [run];
			}),
			board: renderAgentLedgerBoard(ledgerId, ledgerProjectionFor(deps, ledgerId)),
		};
	} finally {
		if (timer !== null) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
		await closeAgentLedger(ledgerId);
	}
}
