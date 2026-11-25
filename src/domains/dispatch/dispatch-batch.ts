// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Batch dispatch: admits each request of a batch through the bundle's dispatch, shares one verification
 * barrier and prompt-prefix stagger across them, and merges their event streams into one batch stream.
 * Lifted from createDispatchBundle; the bundle passes dispatch, its contract and the settings reader.
 */

import { type BatchState, createBatch, onRunComplete, snapshotBatch } from "./batch-tracker.js";
import type {
	DispatchAdmissionObserver,
	DispatchContract,
	DispatchPrefixGroup,
	DispatchPreparationOptions,
	DispatchRequest,
} from "./contract.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { type BatchVerificationGate, createBatchVerificationGate } from "./host-verification.js";
import type { RunResult } from "./types.js";

/** What a batch dispatch reads from the dispatch bundle; createDispatchBundle passes its own. */
export interface DispatchBatchScope {
	getEffectiveSettings: () => EffectiveSettings;
	dispatch: (
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	) => Promise<{ runId: string; events: AsyncIterableIterator<unknown>; finalPromise: Promise<RunResult> }>;
	contract: DispatchContract;
}

function mergeBatchEvents(
	batchId: string,
	handles: ReadonlyArray<{
		runId: string;
		agentId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunResult>;
	}>,
	batchRef: { current: BatchState },
): AsyncIterableIterator<unknown> {
	return (async function* batchEvents(): AsyncIterableIterator<unknown> {
		yield { type: "batch_started", batch: snapshotBatch(batchRef.current) };
		const readers = new Map<
			string,
			{
				handle: (typeof handles)[number];
				next: Promise<IteratorResult<unknown>>;
			}
		>();
		for (const handle of handles) {
			readers.set(handle.runId, { handle, next: handle.events.next() });
		}
		while (readers.size > 0) {
			const race = [...readers.entries()].map(async ([runId, reader]) => ({
				runId,
				result: await reader.next,
			}));
			const { runId, result } = await Promise.race(race);
			const reader = readers.get(runId);
			if (!reader) continue;
			if (result.done) {
				readers.delete(runId);
				continue;
			}
			reader.next = reader.handle.events.next();
			yield {
				type: "batch_run_event",
				batchId,
				runId,
				agentId: reader.handle.agentId,
				event: result.value,
			};
		}
		yield { type: "batch_events_drained", batch: snapshotBatch(batchRef.current) };
	})();
}

export async function dispatchBatch(
	{
		contract,
		dispatch,
		getEffectiveSettings,
	}: Pick<DispatchBatchScope, "contract" | "dispatch" | "getEffectiveSettings">,
	reqs: ReadonlyArray<DispatchRequest>,
	preparation?: DispatchPreparationOptions,
): Promise<{
	batchId: string;
	assignmentIds: ReadonlyArray<string>;
	events: AsyncIterableIterator<unknown>;
	finalPromise: Promise<ReadonlyArray<RunResult>>;
}> {
	if (reqs.length === 0) throw new Error("dispatch: batch requires at least one request");
	// Two or more concurrent workers share one checkout, so a declared check
	// run while a sibling is still editing judges a tree neither worker
	// authored. The barrier only exists when there is both something to verify
	// and something that could race it; a one-request batch and a batch with no
	// declared check keep today's per-run path exactly.
	const settlement =
		reqs.length > 1 && reqs.some((req) => (req.resolvedVerification?.length ?? 0) > 0)
			? createBatchVerificationGate()
			: undefined;
	// Workers that share a prompt prefix start after the first one streams, so they read its cache entry.
	const prefixGroups =
		reqs.length > 1 && getEffectiveSettings()?.fleet.staggerSharedPrefix === true
			? new Map<string, DispatchPrefixGroup>()
			: undefined;
	const staggered = prefixGroups === undefined ? preparation : { ...preparation, prefixGroups };
	const releaseGroups = (): void => {
		for (const group of prefixGroups?.values() ?? []) group.release();
	};
	// A follower's handle returns at admission and only its worker start holds, so admission never waits on a leader.
	const handles: Array<Awaited<ReturnType<typeof dispatch>> & { agentId: string }> = [];
	try {
		for (const req of reqs) {
			const handle = await dispatch(req, undefined, staggered, settlement);
			handles.push({ ...handle, agentId: req.agentId });
		}
	} catch (error) {
		// Held followers start (and are aborted) at once rather than waiting out the cap.
		releaseGroups();
		for (const handle of handles) {
			try {
				contract.abort(handle.runId);
			} catch {
				// best-effort cleanup for partially admitted batches
			}
		}
		throw error;
	}
	const batchRef = { current: createBatch(handles.map((handle) => handle.runId)) };
	const finalPromise = Promise.all(
		handles.map(async (handle) => {
			const receipt = await handle.finalPromise;
			batchRef.current = onRunComplete(batchRef.current, handle.runId, receipt.exitCode !== 0);
			return receipt;
		}),
	).then((receipts) => receipts as ReadonlyArray<RunResult>);
	// Only this batch's runs hold, so no group's cap timer outlives the batch's runs.
	if (prefixGroups !== undefined)
		void Promise.allSettled(handles.map((handle) => handle.finalPromise)).then(releaseGroups);
	return {
		batchId: batchRef.current.id,
		assignmentIds: batchRef.current.assignmentIds,
		events: mergeBatchEvents(batchRef.current.id, handles, batchRef),
		finalPromise,
	};
}
