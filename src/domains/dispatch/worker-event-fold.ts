// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Folds a dispatched worker's event stream into its run record: the token meter, model-call and tool-decision
 * folds, finish-contract entries, run effects and verify calls. The dispatch extension calls these from its event
 * pump; none of them holds state of its own.
 */

import { readCallFailure } from "../../core/call-failure.js";
import { gatewayRoutingObservationFromRecord } from "../../core/gateway-routing.js";
import { differingResponseModelId, responseModelIdObservationFromRecord } from "../../core/response-model-id.js";
import { factKnownValue } from "../../core/telemetry/known.js";
import { type RunSpendSums, spendSumsOf } from "../../core/telemetry/pricing.js";
import { ToolNames } from "../../core/tool-names.js";
import { isRecord } from "../../core/type-guards.js";
import type { ToolRoundRecord } from "../../engine/types.js";
import { INTERNAL_HELPER_RESULT_TOOL } from "../../engine/worker-tools.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../tools/surface.js";
import { type RunEffectsRecorder, recordToolExecutionEffects } from "../safety/run-effects.js";
import { callSettlementFromMessage } from "../telemetry/call-facts.js";
import { TOOL_GUARD_REASON_CODE } from "./failure-headline.js";
import { type RunCallUsage, type RunUsageFacts, unobservedRunUsageFacts } from "./run-call-usage.js";
import { settledVerifyCall, type VerifyCallOutcome, type VerifyCallStart, verifyCallStart } from "./run-findings.js";
import {
	type RunResultUpstreamResponse,
	readToolRounds,
	type SafetyBlockedAttempt,
	type ToolCallStat,
} from "./types.js";

/**
 * What a running worker has spent, as its own call telemetry folds it. Absent until the first frame reaches the
 * host: a run whose telemetry never arrives stays unknown, never zero (R1, #434).
 */
export interface RunTokenMeter {
	usage?: RunCallUsage;
	toolRounds?: ToolRoundRecord[];
}

export function meterSpend(meter: RunTokenMeter): RunUsageFacts {
	return meter.usage?.facts ?? unobservedRunUsageFacts();
}

/** The same spend as sums over the meter's calls, so a total across runs keeps a partly priced run's subtotal. */
export function meterSums(meter: RunTokenMeter): RunSpendSums {
	return meter.usage?.sums ?? spendSumsOf(unobservedRunUsageFacts());
}

/** The priced part of a running worker's spend; a budget counts it even while other calls are unpriced. */
export function meterKnownUsd(meter: RunTokenMeter): number {
	return meter.usage ? factKnownValue(meter.usage.sums.usd) : 0;
}

export function readStringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Row for an assistant reply that reports no usage. Usage stays absent rather than a fabricated zero. A reply
 * the engine marked `pancodeSyntheticFault` (an ACP delegation error, for one) never reached a provider and so
 * yields no row. Every other usage-less reply is a real call, even when it names no model, so its row falls
 * back to the dispatch's requested model when the message carries none.
 */
function usagelessUpstreamResponse(
	message: Record<string, unknown>,
	callIndex: number,
	fallbackModelId: string | null,
): RunResultUpstreamResponse | null {
	if (message.pancodeSyntheticFault === true) return null;
	const { usage: _usage, usageScope: _usageScope, ...row } = upstreamResponse(message, callIndex, "call");
	return row.requestedModelId === null && fallbackModelId !== null ? { ...row, requestedModelId: fallbackModelId } : row;
}

function upstreamResponse(
	message: Record<string, unknown>,
	callIndex: number,
	usageScope: "call" | "run-aggregate",
): RunResultUpstreamResponse {
	// The row states the call's usage the way its call.settled does, one fact per field (#434).
	const usage = callSettlementFromMessage(message, "none").usage;
	const gatewayRouting = gatewayRoutingObservationFromRecord(message);
	return {
		...(usageScope === "call" ? { callIndex } : {}),
		...(usage ? { usage } : {}),
		usageScope,
		requestedModelId: readStringOrNull(message.model),
		responseModelIdObservation: responseModelIdObservationFromRecord(message),
		differingResponseModelId: differingResponseModelId(message.model, message.responseModel),
		providerResponseId: readStringOrNull(message.responseId),
		...(gatewayRouting !== null ? { gatewayRouting } : {}),
		...callOutcome(message),
	};
}

/** Folds a worker's per-call model report into the receipt's upstream rows. */
export function foldModelCallEvent(
	event: { type?: string; payload?: unknown },
	upstreamResponses: RunResultUpstreamResponse[],
): void {
	if (event.type !== "pancode_model_call" || !isRecord(event.payload)) return;
	const payload = event.payload;
	if (typeof payload.callIndex !== "number") return;
	upstreamResponses.push(
		upstreamResponse(
			{ ...payload, ...(payload.responseModel ? { servedModel: payload.responseModel } : {}) },
			payload.callIndex,
			"call",
		),
	);
}

/**
 * Folds an assistant reply into the run's tool rounds and upstream rows. Returns the provider's error text when the
 * call ended in error, else null.
 */
export function foldAssistantCall(
	message: Record<string, unknown>,
	meter: RunTokenMeter,
	upstreamResponses: RunResultUpstreamResponse[],
	fallbackModelId: string | null,
): string | null {
	const toolRounds = readToolRounds(message);
	if (toolRounds.length > 0) {
		meter.toolRounds ??= [];
		meter.toolRounds.push(...toolRounds);
	}
	// A final ACP reply can omit usage, and an ACP delegation fault never has any. Only the metering and the
	// per-call usage row are skipped then: counting such a message would inflate apiCalls and falsely flag token
	// usage as missing, while its failure text and served-model observations remain real.
	const u = isRecord(message.usage) ? message.usage : null;
	const failure = readCallFailure(message.failure);
	if (failure?.invoked === false || (u !== null && u.callInvoked === false)) {
		// A message PanCode wrote into the loop (a result-contract repair, a
		// synthesis reprompt) never reached a provider and is not a call.
	} else if (u !== null) {
		upstreamResponses.push(
			upstreamResponse(message, upstreamResponses.length + 1, u.pancodeSdkAggregate === true ? "run-aggregate" : "call"),
		);
	} else {
		const row = usagelessUpstreamResponse(message, upstreamResponses.length + 1, fallbackModelId);
		if (row !== null) upstreamResponses.push(row);
	}
	return message.stopReason === "error" ? readStringOrNull(message.errorMessage) : null;
}

/**
 * Counts one finished tool call's safety decision, a tool guard's block apart from a safety refusal, and records it as
 * a blocked attempt when it was refused, in the list of the counter that counted it (bt-15 c12b, c13a). A parked ask
 * the registry denied (`deniedPark`, as when no operator can answer a worker's ask) arrives as a block but is a
 * permission request, as the headless main run counts it.
 */
export function foldToolDecision(
	payload: {
		decision?: unknown;
		outcome?: unknown;
		actionClass?: string;
		ruleId?: string;
		reasonCode?: string;
		policySource?: string;
		reason?: string;
		deniedPark?: unknown;
	},
	tool: string,
	counts: { allowed: number; blocked: number; guardBlocked: number; permissionRequested: number },
	blockedAttempts: SafetyBlockedAttempt[],
	guardBlockedAttempts: SafetyBlockedAttempt[],
	permissionRequestedAttempts: SafetyBlockedAttempt[],
): void {
	const deniedAsk = payload.decision === "blocked" && payload.deniedPark === true;
	const permissionAsk = payload.decision === "permission_requested" || deniedAsk;
	const guardBlock = payload.decision === "blocked" && !deniedAsk && payload.reasonCode === TOOL_GUARD_REASON_CODE;
	if (payload.decision === "allowed") counts.allowed += 1;
	else if (permissionAsk) counts.permissionRequested += 1;
	else if (guardBlock) counts.guardBlocked += 1;
	else if (payload.decision === "blocked") counts.blocked += 1;
	if (payload.outcome !== "blocked" && payload.decision !== "blocked") return;
	const attempt: SafetyBlockedAttempt = { tool };
	if (payload.actionClass !== undefined) attempt.actionClass = payload.actionClass;
	if (payload.ruleId !== undefined) attempt.ruleId = payload.ruleId;
	if (payload.reasonCode !== undefined) attempt.reasonCode = payload.reasonCode;
	if (payload.policySource !== undefined) attempt.policySource = payload.policySource;
	if (payload.reason !== undefined) attempt.reason = payload.reason;
	if (deniedAsk) attempt.permissionRequired = true;
	(guardBlock ? guardBlockedAttempts : permissionAsk ? permissionRequestedAttempts : blockedAttempts).push(attempt);
}

const CALL_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "length", "toolUse", "error", "aborted"]);

const CALL_ERROR_MESSAGE_MAX_CHARS = 512;

/**
 * How the call ended, as the engine reported it. A call that failed or was
 * aborted before its first chunk has no response id or response model, and
 * without this the receipt row could not say why.
 */
function callOutcome(message: Record<string, unknown>): Pick<RunResultUpstreamResponse, "stopReason" | "errorMessage"> {
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
	if (stopReason === null || !CALL_STOP_REASONS.has(stopReason)) return {};
	const errorMessage = readStringOrNull(message.errorMessage);
	return {
		stopReason: stopReason as NonNullable<RunResultUpstreamResponse["stopReason"]>,
		...((stopReason === "error" || stopReason === "aborted") && errorMessage !== null
			? { errorMessage: errorMessage.slice(0, CALL_ERROR_MESSAGE_MAX_CHARS) }
			: {}),
	};
}

export function readStringArrayOrNull(value: unknown): ReadonlyArray<string> | null {
	if (!Array.isArray(value)) return null;
	const strings = value.filter((entry): entry is string => typeof entry === "string");
	return strings.length === value.length ? strings : null;
}

function messageText(value: unknown): string {
	const record = isRecord(value) ? value : null;
	if (record === null) return "";
	const content = record.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (!isRecord(part)) return "";
				const text = part.text;
				return typeof text === "string" ? text : "";
			})
			.join("");
	}
	const text = record.text;
	return typeof text === "string" ? text : "";
}

export function appendDispatchFinishContractEntry(
	entries: unknown[],
	event: Record<string, unknown>,
): { assistantText: string; assistantTurnId: string } | null {
	const eventType = event.type;
	if (eventType === "tool_execution_start") {
		const toolCallId = readStringOrNull(event.toolCallId) ?? `worker-tool-${entries.length + 1}`;
		const toolName = readStringOrNull(event.toolName) ?? readStringOrNull(event.tool) ?? "tool";
		entries.push({
			kind: "message",
			role: "tool_call",
			turnId: toolCallId,
			payload: {
				name: toolName,
				toolCallId,
				args: event.args ?? {},
			},
		});
		return null;
	}
	if (eventType === "tool_execution_end") {
		const toolCallId = readStringOrNull(event.toolCallId) ?? `worker-tool-${entries.length + 1}`;
		const toolName = readStringOrNull(event.toolName) ?? readStringOrNull(event.tool) ?? "tool";
		entries.push({
			kind: "message",
			role: "tool_result",
			turnId: toolCallId,
			payload: {
				toolName,
				toolCallId,
				isError: event.isError === true,
				result: event.result ?? null,
			},
		});
		return null;
	}
	if (eventType !== "message_end") return null;
	const message = isRecord(event.message) ? event.message : null;
	if (message === null) return null;
	const role = readStringOrNull(message.role);
	if (role !== "user" && role !== "assistant") return null;
	const text = messageText(message);
	const turnId = `${role}-${entries.length + 1}`;
	const payload: Record<string, unknown> = { text };
	const stopReason = message.stopReason;
	if (typeof stopReason === "string") payload.stopReason = stopReason;
	entries.push({
		kind: "message",
		role,
		turnId,
		payload,
	});
	return role === "assistant" && text.trim().length > 0 ? { assistantText: text, assistantTurnId: turnId } : null;
}

/**
 * Fold one worker tool event into the run's observed effects. The worker
 * records the same events on its own side for its bounded repair round; this
 * is the orchestrator's copy, so the sealed validation measures a mutation
 * report against the run rather than re-reading the model's word for it.
 */
export function recordWorkerRunEffect(
	recorder: RunEffectsRecorder,
	event: Record<string, unknown>,
	helperResult: boolean,
): void {
	if (event.type === "pancode_tool_finish" && isRecord(event.payload)) {
		const id = readStringOrNull(event.payload.toolCallId);
		const outcome = event.payload.outcome;
		if (id !== null && (outcome === "ok" || outcome === "error" || outcome === "blocked"))
			recorder.checkOutcome(id, outcome, event.payload.unresolved === true);
		return;
	}
	// In a run that holds the helper result contract, the result submission is the worker's handoff to this process,
	// never a workspace capability, so it neither writes nor opens the write record. A tool of that name in any other
	// run, like any other unknown name, stays opaque (C-14).
	if (helperResult && (event.toolName === INTERNAL_HELPER_RESULT_TOOL || event.tool === INTERNAL_HELPER_RESULT_TOOL))
		return;
	if (typeof event.type === "string") recordToolExecutionEffects(recorder, { ...event, type: event.type });
}

export interface VerifyCallLog {
	/** What each started `verify` call named, by engine call id, until its finish arrives. */
	pending: Map<string, VerifyCallStart>;
	calls: VerifyCallOutcome[];
}

/**
 * Tie each finished `verify` call to the check it ran. The engine start event
 * carries the arguments and the PanCode finish carries the authoritative outcome;
 * the engine's own `isError` cannot tell a blocked call, which never ran the
 * check, from one that ran and failed. The two are joined on the call id.
 * The receipt judges each check by its latest run.
 */
export function recordWorkerVerifyCall(log: VerifyCallLog, event: Record<string, unknown>): void {
	if (event.type === "tool_execution_start") {
		const toolCallId = readStringOrNull(event.toolCallId);
		const call = effectiveToolCall(String(event.toolName), event.args);
		if (toolCallId === null || call.toolName !== ToolNames.Verify) return;
		log.pending.set(toolCallId, verifyCallStart(call.args));
		return;
	}
	if (event.type === "tool_execution_end") {
		const toolCallId = readStringOrNull(event.toolCallId);
		for (const child of gatewayChainReceipts(String(event.toolName), event.result)) {
			if (child.capability === ToolNames.Verify)
				log.calls.push(
					settledVerifyCall(
						verifyCallStart(child.args),
						child.admission.unresolved === true ? "unresolved" : child.admission.outcome,
						toolCallId === null ? null : `${toolCallId}:${child.id}`,
					),
				);
		}
		return;
	}
	if (event.type !== "pancode_tool_finish" || !isRecord(event.payload)) return;
	const toolCallId = readStringOrNull(event.payload.toolCallId);
	if (
		event.payload.tool !== ToolNames.Verify &&
		!(event.payload.tool === ToolNames.Gateway && toolCallId !== null && log.pending.has(toolCallId))
	)
		return;
	const start = toolCallId === null ? undefined : log.pending.get(toolCallId);
	if (toolCallId !== null) log.pending.delete(toolCallId);
	const outcome = event.payload.outcome;
	log.calls.push(
		settledVerifyCall(
			start,
			outcome === "error" && event.payload.unresolved === true
				? "unresolved"
				: outcome === "ok" || outcome === "error" || outcome === "blocked"
					? outcome
					: null,
			toolCallId,
		),
	);
}

/**
 * Successful calls through a channel that could have run a check. It is the
 * denominator that separates "claimed a check and executed nothing" from
 * "executed something the canonical validation detector does not enumerate",
 * and only the first is grounds for taking a sealed quality label away.
 */
export function countCheckingCalls(
	stats: Map<string, ToolCallStat>,
	verifyCalls: ReadonlyArray<VerifyCallOutcome>,
): number {
	let total = 0;
	for (const stat of stats.values()) {
		if (stat.tool === ToolNames.Bash || stat.tool === ToolNames.Verify) total += stat.ok;
	}
	// A verify call that only listed the checks could not have run one (bt-19).
	return total - verifyCalls.filter((call) => call.listing === true && call.outcome === "ok").length;
}
