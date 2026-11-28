// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { MiddlewareEffect } from "../../domains/middleware/types.js";
import type { ClassifierCall } from "../../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../domains/safety/contract.js";
import type { WorkspaceSnapshotOutcome } from "../../domains/workspace-snapshots/store.js";
import { type WorkspaceSnapshotTrigger, workspaceSnapshotTrigger } from "../../domains/workspace-snapshots/trigger.js";
import type { ToolSpec } from "../tool-spec.js";
import type { ToolInvokeOptions } from "./contract.js";
import type { RegistryScope } from "./scope.js";

/**
 * The workspace snapshot taken before an admitted call's body runs, which the turn's first mutating call takes.
 */
export function createSnapshotGate(reg: RegistryScope) {
	const { deps } = reg;
	/** The turn whose first mutating call already took its snapshot, or is taking it. */
	let snapshotTurn: { key: string; pending: Promise<WorkspaceSnapshotOutcome | null> } | null = null;

	/**
	 * Snapshot the workspace before an admitted call's body runs, when the
	 * trigger asks for one. `note` is the line for the call's result when the
	 * snapshot, or a ref pin, could not be taken; `missing` says why no
	 * snapshot holding everything the call destroys precedes it. Only a call
	 * admitted because a snapshot undoes it (`recoverable`) is refused for
	 * that; every other call runs either way.
	 */
	const snapshotBeforeBody = async (
		spec: ToolSpec,
		call: ClassifierCall,
		decision: SafetyDecision,
		options: ToolInvokeOptions | undefined,
	): Promise<{ note: MiddlewareEffect | null; missing: string | null }> => {
		const recoverable = decision.policy?.recoverable === true;
		const take = deps.workspaceSnapshot;
		// A read-only call changes no user file, and a snapshot would write refs into the user's repository.
		const readOnly = deps.readOnly === true || options?.turnConstraints?.readOnly === true;
		if (take === undefined || readOnly || (deps.principal ?? "main") !== "main") {
			const why = readOnly ? "a read-only run takes no workspace snapshots" : "this session takes no workspace snapshots";
			return { note: null, missing: recoverable ? why : null };
		}
		let effect: ClassifierCall = call;
		try {
			effect = spec.safetyCall?.(call.args ?? {}) ?? call;
		} catch {
			// Admission already ran this projection; the call's own name still classifies.
		}
		const triggered = workspaceSnapshotTrigger(effect, decision);
		// A call admitted because a snapshot undoes it always gets its own.
		const trigger: WorkspaceSnapshotTrigger =
			recoverable && triggered.kind !== "always" ? { kind: "always", reason: "destructive" } : triggered;
		if (trigger.kind === "none") return { note: null, missing: null };
		const turnKey = options?.turnId === undefined ? null : `${options.sessionId ?? ""}\0${options.turnId}`;
		const request = {
			tool: spec.name,
			...(options?.toolCallId !== undefined && options.toolCallId.length > 0 ? { toolCallId: options.toolCallId } : {}),
			...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
			...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
		};
		let pending: Promise<WorkspaceSnapshotOutcome | null>;
		if (trigger.kind === "always") {
			pending = take({
				...request,
				reason: trigger.reason,
				...(trigger.refs !== undefined ? { refs: trigger.refs } : {}),
			});
			if (turnKey !== null) snapshotTurn = { key: turnKey, pending };
		} else {
			// A turn takes one snapshot before its first mutation; a call without a
			// turn (an operator command) has none to anchor.
			if (turnKey === null) return { note: null, missing: null };
			if (snapshotTurn?.key === turnKey) {
				// A sibling call is still taking the turn's snapshot: mutate only after it lands.
				await snapshotTurn.pending.catch(() => null);
				return { note: null, missing: null };
			}
			pending = take({ ...request, reason: "turn-start" });
			snapshotTurn = { key: turnKey, pending };
		}
		let outcome: WorkspaceSnapshotOutcome | null;
		try {
			outcome = await pending;
		} catch (err) {
			outcome = { kind: "unavailable", reason: err instanceof Error ? err.message : String(err), durationMs: 0 };
		}
		if (outcome === null) {
			return { note: null, missing: recoverable ? "workspace snapshots are off or no session is open" : null };
		}
		if (outcome.kind !== "unavailable") {
			if (outcome.pinNote === undefined && outcome.unpinned === undefined) return { note: null, missing: null };
			const detail = outcome.pinNote ?? "not pinned";
			// A call admitted because the snapshot undoes it is refused when a ref
			// it destroys is not pinned; any other call only hears about it.
			const unpinned = outcome.unpinned ?? [];
			return {
				note: { kind: "annotate_tool_result", message: `snapshot #${outcome.record.n}: ${detail}`, severity: "warn" },
				missing:
					unpinned.length > 0
						? `snapshot #${outcome.record.n} holds the files but could not pin ${unpinned.join(", ")}: ${detail}`
						: null,
			};
		}
		return {
			note: { kind: "annotate_tool_result", message: `no snapshot: ${outcome.reason}`, severity: "warn" },
			missing: outcome.reason,
		};
	};
	return { snapshotBeforeBody };
}
