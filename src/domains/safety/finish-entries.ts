// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall, expandChainMessages } from "../../tools/surface.js";
import { callVerdict } from "./check-classifier.js";
import type { FinishContractEvidence } from "./finish-contract.js";
import { detectValidationCommand } from "./protected-artifacts.js";

/**
 * The recent-window cap (entries since the last user message). Exported so a
 * tail-scoped reader can size its read as a multiple of this and stay in lockstep
 * with the window the contract actually inspects.
 */
export const DEFAULT_RECENT_ENTRY_LIMIT = 80;

/**
 * Recent entries as the capabilities that ran. The coordinator reaches verify,
 * bash and limitation only through gateway op=call or op=chain, so a scan keyed
 * on the recorded name would never see that evidence and would keep demanding
 * validation the model already ran. Result entries keep their own ids.
 */
export function capabilityEntries(recent: ReadonlyArray<unknown>): unknown[] {
	return expandChainMessages(recent).map((entry) => {
		const record = asRecord(entry);
		if (record?.kind !== "message" || record.role !== "tool_call") return entry;
		const payload = asRecord(record.payload);
		const recorded = payload === null ? null : stringFromFirst(payload, ["name", "toolName", "tool"]);
		if (payload === null || recorded === null) return entry;
		const call = effectiveToolCall(recorded, payload.args ?? payload.arguments ?? payload.input);
		if (!call.viaGateway) return entry;
		return { ...record, payload: { ...payload, name: call.toolName, args: call.args ?? {} } };
	});
}

export function recentEntries(
	entries: ReadonlyArray<unknown>,
	assistantTurnId: string | null,
	recentEntryLimit: number,
	startTurnId?: string,
): ReadonlyArray<unknown> {
	const boundedLimit =
		Number.isFinite(recentEntryLimit) && recentEntryLimit > 0 ? Math.floor(recentEntryLimit) : DEFAULT_RECENT_ENTRY_LIMIT;
	const assistantIndex =
		assistantTurnId === null ? -1 : entries.findIndex((entry) => turnIdOf(entry) === assistantTurnId);
	const endExclusive = assistantIndex >= 0 ? assistantIndex : entries.length;
	const startIndex =
		startTurnId === undefined
			? -1
			: entries.findIndex((entry, index) => index < endExclusive && turnIdOf(entry) === startTurnId);
	if (startIndex >= 0 && isUserMessageEntry(entries[startIndex])) return entries.slice(startIndex + 1, endExclusive);
	let startInclusive = Math.max(0, endExclusive - boundedLimit);
	for (let index = endExclusive - 1; index >= startInclusive; index -= 1) {
		if (isUserMessageEntry(entries[index])) {
			startInclusive = index + 1;
			break;
		}
	}
	return entries.slice(startInclusive, endExclusive);
}

export function successfulToolResultId(entry: unknown): string | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_result") return null;
	const payload = asRecord(record.payload);
	if (payload === null) return null;
	if (payload.isError === true || payload.error === true) return null;
	// A call the safety rails refused or the registry settled as an error ran
	// nothing. The persisted verdict says so even when `isError` is false: a
	// denied write is not a change, and a denied test run is not validation.
	if (payload.outcome === "blocked" || payload.outcome === "error" || typeof payload.blockReason === "string")
		return null;
	const result = asRecord(payload.result);
	const details = asRecord(result?.details);
	if (result?.kind === "error" || details?.kind === "error") return null;
	const chainAdmission = asRecord(details?.chainAdmission);
	if (chainAdmission?.outcome === "blocked" || chainAdmission?.outcome === "error") return null;
	if (typeof details?.exitCode === "number" && details.exitCode !== 0) return null;
	return stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
}

/** The id of a command that ran and exited nonzero; a refused or blocked call has no exit code. */
export function ranToNonzeroExitResultId(entry: unknown): string | null {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "tool_result") return null;
	const payload = asRecord(record.payload);
	if (payload === null || payload.outcome === "blocked" || typeof payload.blockReason === "string") return null;
	const details = asRecord(asRecord(payload.result)?.details);
	if (asRecord(details?.chainAdmission)?.outcome === "blocked") return null;
	if (typeof details?.exitCode !== "number" || details.exitCode === 0) return null;
	return stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]);
}

export function pushEvidence(
	evidence: FinishContractEvidence[],
	seen: Set<string>,
	item: FinishContractEvidence,
): void {
	const key = JSON.stringify(item);
	if (seen.has(key)) return;
	seen.add(key);
	evidence.push(item);
}

const DELETION_CLAUSE_SPLIT = /[.;\n]|\b(?:then|but)\b/iu;

const DELETION_VERB = /\b(?:delete|remove|rm|drop|get\s+rid\s+of)\b/iu;

const DELETION_NEGATION = /\b(?:do\s+not|don['’]t|never|without)\s+(?:delete|remove|drop)\b/iu;

/** A clause of the operator's message that asks to delete and names this path or its last segment. */
export function operatorRequestedDeletion(path: string, request: string | null): boolean {
	if (request === null) return false;
	const trimmed = path.replace(/^\.\//u, "").replace(/\/+$/u, "");
	const leaf = trimmed.split("/").pop() ?? "";
	if (leaf.length === 0) return false;
	const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const names = new RegExp(`(?:^|[\\s\`'"(/])(?:${literal(trimmed)}|${literal(leaf)})(?:$|[\\s\`'",;:)/])`, "u");
	return request
		.split(DELETION_CLAUSE_SPLIT)
		.some((clause) => DELETION_VERB.test(clause) && !DELETION_NEGATION.test(clause) && names.test(clause));
}

/** Text of the last real user message before the assessed turn. */
export function latestUserText(entries: ReadonlyArray<unknown>, assistantTurnId: string | null): string | null {
	const assistantIndex =
		assistantTurnId === null ? -1 : entries.findIndex((entry) => turnIdOf(entry) === assistantTurnId);
	for (let index = (assistantIndex >= 0 ? assistantIndex : entries.length) - 1; index >= 0; index -= 1) {
		if (!isUserMessageEntry(entries[index])) continue;
		const payload = asRecord(asRecord(entries[index])?.payload);
		const content = payload?.text ?? payload?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.map((part) => {
					const text = asRecord(part)?.text;
					return typeof text === "string" ? text : "";
				})
				.join("\n");
		return null;
	}
	return null;
}

function isUserMessageEntry(entry: unknown): boolean {
	const record = asRecord(entry);
	if (record?.kind !== "message" || record.role !== "user") return false;
	const payload = asRecord(record.payload);
	return payload?.synthetic !== true;
}

export function turnIdOf(entry: unknown): string | null {
	const record = asRecord(entry);
	return typeof record?.turnId === "string" ? record.turnId : null;
}

export function stringFromFirst(record: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Exact check ids, never substring matches against rendered evidence summaries. */
export function validationCheckId(command: string): string | undefined {
	return (
		/^(?:npm|pnpm|yarn|bun) (?:run )?([a-z0-9][a-z0-9._:-]*)$/.exec(command)?.[1] ??
		/^verify ([a-z0-9][a-z0-9._:-]*)$/.exec(command)?.[1]
	);
}

export function validationCheckFields(command: string): { check?: string } {
	const check = validationCheckId(command);
	return check ? { check } : {};
}

/** Additional package scripts are admitted only by the operator's typed acceptance. */
export function acceptanceValidationCommand(
	command: string,
	checks: ReadonlySet<string>,
): ReturnType<typeof detectValidationCommand> {
	const exact = command.trim();
	const check = /^npm run ([a-z0-9][a-z0-9._:-]*)$/.exec(exact)?.[1];
	if (check && checks.has(check)) return { kind: "validation", matched: exact };
	// The call classifier alone says whether the command ran a check; the finish vocabulary only names it.
	if (callVerdict(ToolNames.Bash, { command }) !== "check") return { kind: "none" };
	return detectValidationCommand(command);
}
