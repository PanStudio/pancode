// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { pancodeStateDir } from "../../core/xdg.js";
import { forkParentSessionId } from "../session/fork-journal.js";
import { listStoredAssignments } from "./assignment-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { ActiveRun } from "./bundle-types.js";
import type { DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { sessionAncestorIds } from "./ownership.js";
import type { RunLineage, RunResult } from "./types.js";

export function createControlRoots(rt: DispatchRuntime) {
	const { options } = rt;
	const { assignments } = rt.core;
	const assignmentRootsByAttempt = new Map<string, string>();
	// Fleet lineage is shared ancestry, not control ownership. Keep each
	// member's retry chain distinct without changing persisted lineage.
	const controlRootsByAttempt = new Map<string, string>();
	const controlAttempts = new Map<
		string,
		{ lineage: RunLineage; reservation: DispatchRequest["reservation"]; maxRetries: number; receipt?: RunResult }
	>();
	const canceledControlRoots = new Set<string>();
	/** Control roots the dispatching session canceled through the steer tool (ns:61). */
	const steerCanceledRoots = new Set<string>();
	const memberWork = new Map<string, Set<Promise<unknown>>>();
	function trackMemberWork(runId: string, operation: Promise<unknown>): void {
		const root = controlRootsByAttempt.get(runId) ?? runId;
		const work = memberWork.get(root) ?? new Set<Promise<unknown>>();
		memberWork.set(root, work);
		work.add(operation);
		const settled = (): void => {
			work.delete(operation);
			if (work.size === 0) memberWork.delete(root);
		};
		operation.then(settled, settled);
	}

	function lineageFor(req: DispatchRequest, runId: string): RunLineage {
		const lineage = req.lineage ? { ...req.lineage } : { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 };
		assignmentRootsByAttempt.set(runId, lineage.rootRunId);
		const parent = lineage.parentRunId === null ? undefined : controlAttempts.get(lineage.parentRunId);
		// Repair ordinals and fleet ancestry do not establish a retry. Only a
		// known consecutive attempt of the same reservation member can do so.
		const continuesParent =
			parent !== undefined &&
			parent.lineage.rootRunId === lineage.rootRunId &&
			parent.lineage.depth === lineage.depth &&
			parent.lineage.attempt + 1 === lineage.attempt &&
			parent.reservation?.ownerId === req.reservation?.ownerId &&
			parent.reservation?.memberId === req.reservation?.memberId;
		const priorControl =
			continuesParent && lineage.parentRunId !== null ? controlRootsByAttempt.get(lineage.parentRunId) : undefined;
		controlRootsByAttempt.set(runId, priorControl ?? runId);
		controlAttempts.set(runId, {
			lineage,
			reservation: req.reservation,
			maxRetries: continuesParent ? parent.maxRetries : rt.retry.assignmentPolicyFor(req).maxRetries,
		});
		return lineage;
	}

	function assignmentRootFor(id: string): string {
		if (assignments.get(id) !== null) return id;
		const live = rt.runs.active.get(id);
		if (live) return live.lineage.rootRunId;
		const local = assignmentRootsByAttempt.get(id);
		if (local !== undefined) return local;
		// After restart the immutable attempt history identifies the logical
		// assignment; a receipt's root may instead name its main host run.
		const stored = listStoredAssignments().find((record) => record.assignmentId === id || record.attempts.includes(id));
		return stored?.assignmentId ?? rt.runs.ledger?.get(id)?.lineage?.rootRunId ?? id;
	}

	/**
	 * A renewal found an assignment's lease gone from the shared store, so its
	 * slot may already run someone else's worker. Every member that owns the
	 * assignment is stopped through its own control root: the assignment id of
	 * a fleet names several members and `abort` refuses it, while a control
	 * root reaches the member's live attempt, its queued retry and a retry
	 * still in admission, and leaves finalization, receipts and settlement to
	 * their usual owners. A run that starts after this sweep is stopped where
	 * it enters `active`, through `lostLeaseDetail`.
	 */
	function stopLostCapacityOwners(assignmentId: string, detail: string): void {
		const roots = new Set<string>();
		for (const [attempt, root] of assignmentRootsByAttempt) {
			if (root === assignmentId) roots.add(controlRootsByAttempt.get(attempt) ?? attempt);
		}
		for (const run of rt.runs.active.values()) {
			if (run.lineage.rootRunId === assignmentId) roots.add(controlRootsByAttempt.get(run.runId) ?? run.runId);
		}
		for (const root of roots) {
			// An aborted or stall-killed run already carries its own cause and its
			// retries are already refused; a run on its merge card has no worker left.
			// Aborting again would relabel or cancel work that holds no endpoint slot.
			const current = currentAssignmentRun(root);
			if (current !== null && (current.aborted || current.stallKilled || current.awaitingOperator === true)) continue;
			try {
				rt.contract.contract.abort(root, { cause: "capacity", detail });
			} catch (error) {
				reportDispatchDiagnostic(`stop member ${root} after lost capacity`, error);
			}
		}
	}

	function controlRootFor(id: string): string {
		const exact = controlRootsByAttempt.get(id);
		if (exact !== undefined) return exact;
		const roots = new Set<string>();
		for (const [attempt, root] of assignmentRootsByAttempt) {
			if (root === id) roots.add(controlRootsByAttempt.get(attempt) ?? root);
		}
		if (roots.size > 1) {
			throw new Error(`dispatch: '${id}' names multiple fleet members; use a concrete member or assignment id`);
		}
		return roots.values().next().value ?? assignmentRootFor(id);
	}

	function currentAssignmentRun(id: string): ActiveRun | null {
		// An exact live attempt is authoritative even if a sibling has a higher
		// attempt ordinal. Completed IDs may follow only their own retry chain.
		const exact = rt.runs.active.get(id);
		if (exact !== undefined) return exact;
		const rootRunId = controlRootFor(id);
		let current: ActiveRun | null = null;
		for (const run of rt.runs.active.values()) {
			if ((controlRootsByAttempt.get(run.runId) ?? run.lineage.rootRunId) !== rootRunId) continue;
			if (current === null || run.lineage.attempt > current.lineage.attempt) current = run;
		}
		return current;
	}

	// A fork's lineage never changes once stamped, so each complete chain is read
	// from disk once; owner() runs on every turn end and wake poll.
	const ancestorChains = new Map<string, string[]>();
	const ownerAncestors = (sessionId: string): string[] => {
		const parentSessionId = options?.getSessionParentId?.() ?? null;
		if (parentSessionId === null) return [];
		const key = `${sessionId}\0${parentSessionId}`;
		const cached = ancestorChains.get(key);
		if (cached !== undefined) return cached;
		// Through a deleted ancestor too, by its telemetry journal's fork record (FL-14).
		const chain = sessionAncestorIds(sessionId, parentSessionId, (id) => forkParentSessionId(pancodeStateDir(), id));
		ancestorChains.set(key, chain);
		return chain;
	};

	return {
		assignmentRootFor,
		canceledControlRoots,
		controlAttempts,
		controlRootFor,
		controlRootsByAttempt,
		currentAssignmentRun,
		lineageFor,
		memberWork,
		ownerAncestors,
		steerCanceledRoots,
		stopLostCapacityOwners,
		trackMemberWork,
	};
}
