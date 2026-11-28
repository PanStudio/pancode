// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The read model's fold over the Phase 3 decision facts (#434): approvals, tool and safety decisions, completion
 * evaluations. Run lifecycle and route decisions are entries on the run timeline (`runTimeline` in
 * read-model-timeline.ts); quota is `foldAccountQuota`. The fold reads journal records and nothing else, so every
 * surface that shows these facts counts them the same way. The fold version is `TELEMETRY_FOLD_VERSION` (folds.ts).
 */

import type { EventPayload } from "../../core/telemetry/events.js";
import { countsAsToolCall } from "../../core/telemetry/tool-schemas.js";
import type { AccountabilityEventName, AccountabilityRecord } from "./read-model-runs.js";

// ---------------------------------------------------------------------------
// Decisions: approvals, tool decisions, safety judgments, completion evaluations
// ---------------------------------------------------------------------------

type Counts<K extends string> = Record<K, number>;

/** One accountability record as a surface lists it: what it decided, about which tool, for which run. */
export interface DecisionRow {
	id: string;
	at: string;
	kind: AccountabilityEventName;
	tool: string | null;
	actionClass: string | null;
	/** The decision, status, verdict, source or phase the record states; null for an approval ask. */
	outcome: string | null;
	/** The record's scope run, or the worker run a session record names (`requestedBy`, `workerRunId`). */
	runId: string | null;
	record: AccountabilityRecord;
}

export interface DecisionsFold {
	approvals: {
		/** Distinct asks: a forwarded ask republishes its request, and one request id is one ask. */
		requested: number;
		granted: number;
		denied: number;
		expired: number;
		/** Granted over requested; null with no ask. Resolutions can belong to asks outside the records read. */
		approvalRate: number | null;
	};
	tools: Counts<EventPayload<"tool.decided">["decision"]>;
	safety: Counts<EventPayload<"safety.judged">["verdict"]>;
	completion: Counts<EventPayload<"completion.evaluated">["decision"]>;
	/** Oldest first, as the records were given. */
	rows: DecisionRow[];
}

function decisionOutcome(record: AccountabilityRecord): string | null {
	switch (record.k) {
		case "tool.decided":
		case "completion.evaluated":
			return record.data.decision;
		case "approval.resolved":
			return record.data.status;
		case "safety.judged":
			return record.data.verdict;
		case "run.aborted":
		case "turn.aborted":
			return record.data.source;
		case "job.clock_resumed":
			return "resumed";
		case "turn.continued":
			return record.data.cause;
		case "agent.status_changed":
			return record.data.phase;
		case "session.closed":
			return record.data.reason;
		case "session.resumed":
			return record.data.via;
		case "autonomy.entered":
			return record.data.confinement;
		case "autonomy.open_decision":
		case "autonomy.cap_reached":
			return record.data.kind;
		case "autonomy.resumed":
			return "resumed";
		case "autonomy.ended":
			return record.data.reason;
		case "approval.requested":
			return null;
	}
}

function decisionRunId(record: AccountabilityRecord): string | null {
	if (record.ctx.runId !== undefined) return record.ctx.runId;
	if (record.k === "run.aborted") return record.data.runId;
	if (record.k === "approval.requested" || record.k === "approval.resolved") return record.data.requestedBy ?? null;
	if (record.k === "safety.judged") return record.data.workerRunId ?? null;
	return null;
}

export function decisionRow(record: AccountabilityRecord): DecisionRow {
	const data = record.data as { tool?: unknown; actionClass?: unknown };
	return {
		id: record.id,
		at: record.t,
		kind: record.k,
		tool: typeof data.tool === "string" ? data.tool : null,
		actionClass: typeof data.actionClass === "string" ? data.actionClass : null,
		outcome: decisionOutcome(record),
		runId: decisionRunId(record),
		record,
	};
}

/** Fold accountability records (`accountabilityRecords`) into the counts and rows a decisions surface shows. */
export function foldDecisions(records: Iterable<AccountabilityRecord>): DecisionsFold {
	const approvals = { requested: 0, granted: 0, denied: 0, expired: 0 };
	const tools = { allowed: 0, blocked: 0, permission_requested: 0, denied: 0 };
	const safety = { allow: 0, block: 0, none: 0, escalated: 0 };
	const completion = { ok: 0, engage: 0 };
	const asked = new Set<string>();
	// The grant broker republishes a resolution as its grant executes, so one request id is one resolution: its last.
	const resolvedById = new Map<string, EventPayload<"approval.resolved">["status"]>();
	const rows: DecisionRow[] = [];
	for (const record of records) {
		rows.push(decisionRow(record));
		switch (record.k) {
			case "approval.requested": {
				const id = record.data.requestId;
				if (id === undefined || !asked.has(id)) approvals.requested += 1;
				if (id !== undefined) asked.add(id);
				break;
			}
			case "approval.resolved":
				if (record.data.requestId === undefined) approvals[record.data.status] += 1;
				else resolvedById.set(record.data.requestId, record.data.status);
				break;
			case "tool.decided":
				if (countsAsToolCall(record.data)) tools[record.data.decision] += 1;
				break;
			case "safety.judged":
				safety[record.data.verdict] += 1;
				break;
			case "completion.evaluated":
				completion[record.data.decision] += 1;
				break;
		}
	}
	for (const status of resolvedById.values()) approvals[status] += 1;
	return {
		approvals: {
			...approvals,
			approvalRate: approvals.requested === 0 ? null : approvals.granted / approvals.requested,
		},
		tools,
		safety,
		completion,
		rows,
	};
}
