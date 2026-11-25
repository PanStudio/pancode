// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { ToolNames } from "../../core/tool-names.js";
import type { FinishContractEvidence, ToolCallEvidenceCandidate } from "./finish-contract.js";
import {
	asRecord,
	capabilityEntries,
	pushEvidence,
	stringFromFirst,
	successfulToolResultId,
	turnIdOf,
} from "./finish-entries.js";

/**
 * Successful `limitation` receipts over the recent window. A receipt is a
 * `limitation` tool_call whose tool_result in the same window is not an
 * error, judged by the same `successfulToolResultId` rule the mutation and
 * validation scans use. A call the tool rejected (bad reason, empty scope)
 * leaves no receipt, so it cannot settle the contract.
 */
export function collectLimitationEvidence(recent: ReadonlyArray<unknown>): FinishContractEvidence[] {
	const evidence: FinishContractEvidence[] = [];
	const calls = new Map<string, ToolCallEvidenceCandidate>();
	const seen = new Set<string>();

	for (const entry of capabilityEntries(recent)) {
		const call = limitationToolCall(entry);
		if (call !== null) {
			calls.set(call.toolCallId, call);
			continue;
		}
		const resultId = successfulToolResultId(entry);
		if (resultId === null) continue;
		const candidate = calls.get(resultId);
		if (candidate === undefined) continue;
		const item: FinishContractEvidence = {
			kind: "limitation",
			summary: candidate.command,
			...(candidate.paths ? { paths: candidate.paths } : {}),
		};
		if (candidate.turnId !== undefined) item.turnId = candidate.turnId;
		pushEvidence(evidence, seen, item);
	}

	return evidence;
}

/**
 * A verify result in the window whose typed details say the workspace declares and derives no check: the list, or a
 * named check that resolved to nothing and so stays an error that credits no pass.
 */
export function verifyFoundNoChecks(recent: ReadonlyArray<unknown>): boolean {
	const calls = new Set<string>();
	for (const entry of capabilityEntries(recent)) {
		const record = asRecord(entry);
		const payload = asRecord(record?.payload);
		if (payload === null) continue;
		if (record?.role === "tool_call") {
			const id = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
			if (id !== null && stringFromFirst(payload, ["name", "toolName", "tool"]) === ToolNames.Verify) calls.add(id);
			continue;
		}
		if (record?.role !== "tool_result" || payload.outcome === "blocked" || typeof payload.blockReason === "string")
			continue;
		const resultId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
		if (
			resultId !== null &&
			calls.has(resultId) &&
			asRecord(asRecord(payload.result)?.details)?.noChecksDeclared === true
		)
			return true;
	}
	return false;
}

function limitationToolCall(entry: unknown): ToolCallEvidenceCandidate | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_call") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	const toolName = stringFromFirst(payload, ["name", "toolName", "tool"]);
	if (toolName !== ToolNames.Limitation) return null;
	const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
	if (toolCallId === null) return null;
	const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
	const scope = typeof args?.scope === "string" ? args.scope.trim() : "";
	const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
	const candidate: ToolCallEvidenceCandidate = {
		toolCallId,
		paths: Array.isArray(args?.paths)
			? args.paths.filter((item): item is string => typeof item === "string").map((item) => item.trim())
			: [],
		command: `limitation recorded: ${scope.length > 0 ? scope : "unspecified"} (reason=${reason.length > 0 ? reason : "unspecified"})`,
	};
	const turnId = turnIdOf(entry);
	if (turnId !== null) candidate.turnId = turnId;
	return candidate;
}
