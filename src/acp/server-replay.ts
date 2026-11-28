// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Replaying a restored session's transcript as ACP `session/update` frames,
 * and the session result metadata a restore returns.
 */

import { outputLimitCutOffToolCallIds } from "../core/assistant-output.js";
import { formatCount } from "../core/format-time.js";
import { isRecord } from "../core/type-guards.js";
import type { BashExecutionEntry, MessageEntry, SessionEntry } from "../domains/session/entries.js";
import { IN_RUN_CONTINUATION_ENTRY } from "../domains/session/entries.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import { messageStopCompleted, redactFinalUrlCredentials, redactUrlCredentials } from "../lib/secrets/redaction.js";
import { COMPACTION_LINE_LEAD } from "../session-control/compaction-lines.js";
import { budgetBlockReplayFrame } from "./budget-notice.js";
import { compactUsage, turnUsageMeta } from "./live-telemetry.js";
import {
	boundRawInput,
	boundRawRecord,
	boundString,
	chunkText,
	safeIso,
	safeStoredIdentifier,
	safeStoredString,
} from "./server-bounds.js";
import { ACP_MAX_SHELL_COMMAND_BYTES, shellOutputTail } from "./server-session-input.js";
import type { AcpServerSession, ActivePrompt } from "./server-tool-updates.js";
import {
	ACP_MAX_TOOL_TITLE_BYTES,
	createActivePromptState,
	endToolCallId,
	mapAcpStopReason,
	outputText,
	separatedTextBlocks,
	startToolCallId,
	textContent,
	toolCallContent,
	toolCallPresentation,
	toolKind,
	toolResultContent,
	withoutImageData,
} from "./server-tool-updates.js";
import type { AcpSessionResultMeta, AcpSessionUpdateParams, AcpToolCallStatus, AcpToolKind } from "./types.js";
import {
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_NOTICE_META_KEY,
	ACP_REPLAY_META_KEY,
	ACP_SHELL_META_KEY,
	ACP_TOOL_TIMING_META_KEY,
	ACP_TURN_META_KEY,
	ACP_USAGE_META_KEY,
} from "./types.js";

function payloadRecord(payload: unknown): Record<string, unknown> | null {
	return isRecord(payload) ? payload : null;
}

function replayTextBlocks(entry: MessageEntry): { text: string[]; thinking: string[] } {
	const text: string[] = [];
	const thinking: string[] = [];
	if (typeof entry.payload === "string") text.push(entry.payload);
	const payload = payloadRecord(entry.payload);
	if (payload === null) return { text, thinking };
	if (typeof payload.text === "string") text.push(payload.text);
	if (!Array.isArray(payload.content)) return { text, thinking };
	// A rich payload's `text` is the flattened copy of `content`. Prefer the
	// original blocks so a replay does not duplicate the same prose.
	if (payload.content.length > 0) text.length = 0;
	for (const block of payload.content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") text.push(block.text);
		if (block.type === "thinking") {
			if (typeof block.thinking === "string") thinking.push(block.thinking);
			else if (typeof block.text === "string") thinking.push(block.text);
		}
	}
	return { text, thinking };
}

interface AcpReplayFrame {
	update: Record<string, unknown>;
	meta?: Record<string, unknown>;
}

interface AcpReplayTurn {
	frames: AcpReplayFrame[];
	userTurnId?: string;
	/** Every operator turn the turn ran under, which the telemetry read model sums its usage over. */
	turnIds?: string[];
	stopReason?: string;
	/** The newest recorded assistant model and the route the ledger had when it ran. */
	model?: string;
	target?: string;
	/** An assistant message of this turn sent text, so the next one opens on a blank line as live does. */
	sentAssistantText?: boolean;
	/** The ledger's time for the request that opened the turn, and for the turn's newest entry. */
	startedAt?: string;
	finishedAt?: string;
}

export interface PreparedAcpReplay {
	params: Array<AcpSessionUpdateParams & { _meta: Record<string, unknown> }>;
	/** Dispatched runs on the replayed branch, in ledger order, for their terminal frames. */
	runs: Array<{ runId: string; agentId: string }>;
	turns: number;
	/** Per replayed turn, in order, the operator turns its usage is read over. */
	turnIds: string[][];
	truncated: boolean;
}

function replayMessageChunks(
	frames: AcpReplayFrame[],
	sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
	texts: ReadonlyArray<string>,
	completed = true,
): void {
	for (const text of texts) {
		const shown = sessionUpdate === "user_message_chunk" ? text : redactFinalUrlCredentials(text, completed);
		for (const chunk of chunkText(shown, ACP_MAX_CHUNK_BYTES)) {
			if (chunk.length === 0) continue;
			frames.push({ update: { sessionUpdate, content: textContent(chunk) } });
		}
	}
}

function replayToolCall(entry: MessageEntry): { engineId: string; name: string; args: unknown } {
	const payload = payloadRecord(entry.payload);
	return {
		engineId:
			typeof payload?.toolCallId === "string" && payload.toolCallId.length > 0
				? payload.toolCallId
				: `persisted-tool-${entry.turnId}`,
		name: safeStoredString(payload?.name ?? payload?.toolName, 64, "tool") || "tool",
		args: payload?.args,
	};
}

function closeUnrecordedReplayCalls(active: ActivePrompt, frames: AcpReplayFrame[]): void {
	for (const toolCallId of active.openToolCalls) {
		frames.push({
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "failed" satisfies AcpToolCallStatus,
				content: toolCallContent("unrecorded"),
			},
		});
		active.terminalToolCalls.add(toolCallId);
	}
	active.openToolCalls.clear();
}

/** The live shell line's call and settled update, rebuilt from what its entry recorded. */
function replayShellLine(entry: BashExecutionEntry): AcpReplayFrame[] {
	const excludeFromContext = entry.excludeFromContext === true;
	const meta = { [ACP_SHELL_META_KEY]: { version: 1, excludeFromContext } };
	const toolCallId = `shell_${entry.turnId}`;
	const stored: unknown = entry.command;
	const command = safeStoredString(stored, ACP_MAX_SHELL_COMMAND_BYTES);
	const title = boundString(command, ACP_MAX_TOOL_TITLE_BYTES);
	const output = shellOutputTail(redactFinalUrlCredentials(entry.output, !entry.cancelled));
	return [
		{
			update: {
				sessionUpdate: "tool_call",
				toolCallId,
				name: "shell",
				title,
				kind: "execute" satisfies AcpToolKind,
				status: "in_progress" satisfies AcpToolCallStatus,
				rawInput: { command, excludeFromContext },
			},
			meta,
		},
		{
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId,
				title,
				kind: "execute",
				status: (entry.exitCode === 0 && !entry.cancelled ? "completed" : "failed") satisfies AcpToolCallStatus,
				...(output.length > 0 ? { content: toolCallContent(output) } : {}),
				rawOutput: {
					exitCode: entry.exitCode,
					cancelled: entry.cancelled,
					truncated: entry.truncated,
					excludedFromContext: excludeFromContext,
				},
			},
			meta,
		},
	];
}

/**
 * Build client-visible replay from original active-branch transcript entries.
 * Provider-only synthetic context never enters this projection.
 */
export function prepareAcpReplay(
	entries: ReadonlyArray<SessionEntry>,
	leafTurnId: string | null,
	sessionId: string,
	cwd: string,
	createdTarget: string | null = null,
): PreparedAcpReplay {
	const branch = filterEntriesToActivePath(entries, leafTurnId ?? undefined);
	// The header names the target the session was created on; each `modelChange` on the branch moves it.
	let routeTarget = createdTarget;
	const turns: AcpReplayTurn[] = [];
	const ids = createActivePromptState();
	let current: AcpReplayTurn | null = null;
	const cutOffToolCalls = new Set<string>();
	// Each replayed call's presentation, which its terminal update repeats as the live one does.
	const presented = new Map<string, ReturnType<typeof toolCallPresentation>>();
	const runs: Array<{ runId: string; agentId: string }> = [];
	// A refused call never ran: live it opened `pending` and went straight to `failed`, so replay opens it the same way.
	const refusedToolCalls = new Set<string>();
	// A finish the completion protocol refused never reached the live wire (R2-F15), so replay leaves it out too.
	const protocolRetryCalls = new Set<string>();
	for (const entry of branch) {
		if (entry.kind !== "message" || entry.role !== "tool_result") continue;
		const payload = payloadRecord(entry.payload);
		if (typeof payload?.toolCallId !== "string") continue;
		if (payload.outcome === "blocked") refusedToolCalls.add(payload.toolCallId);
		if (payload.protocolRetry === true) protocolRetryCalls.add(payload.toolCallId);
	}
	for (const entry of branch) {
		// Only an entry of the open turn moves its finish; a later request, shell line, run or compaction does not.
		const stamp = Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : undefined;
		if (entry.kind === "workerRun") {
			runs.push({ runId: entry.runId, agentId: entry.agentId });
			continue;
		}
		if (entry.kind === "compactionSummary") {
			if (current === null) {
				current = { frames: [] };
				turns.push(current);
			}
			// The boundary replays as the host information line the live compaction sent, never as reply text: the stored
			// summary is the model's checkpoint (operator-notes and exact-facts blocks, recall instructions), and an agent
			// chunk would join the previous reply in a client that concatenates them (acp-verify round 2 #3).
			const text =
				entry.tokensAfter === undefined
					? `${COMPACTION_LINE_LEAD}${formatCount(entry.tokensBefore)} tokens`
					: `${COMPACTION_LINE_LEAD}${formatCount(entry.tokensBefore)} → ${formatCount(entry.tokensAfter)} tokens`;
			current.frames.push({
				update: {
					sessionUpdate: "session_info_update",
					_meta: { [ACP_NOTICE_META_KEY]: { level: "info", text } },
				},
			});
			continue;
		}
		if (entry.kind === "modelChange") {
			if (typeof entry.target === "string" && entry.target.length > 0) routeTarget = entry.target;
			continue;
		}
		if (entry.kind === "bashExecution") {
			// An operator shell line (terminal `!` or `_pancode/session/shell`)
			// runs only between turns, so the turn before it has ended.
			if (current === null) {
				current = { frames: [] };
				turns.push(current);
			} else {
				closeUnrecordedReplayCalls(ids, current.frames);
			}
			current.frames.push(...replayShellLine(entry));
			continue;
		}
		if (entry.kind === "custom") {
			if (entry.customType === "turnOutcome" && current !== null) {
				const outcome = payloadRecord(entry.data);
				if (outcome?.version === 1 && outcome.turnId === current.userTurnId) {
					if (stamp !== undefined) current.finishedAt = stamp;
					if (typeof outcome.stopReason === "string") current.stopReason = mapAcpStopReason(outcome.stopReason);
					if (payloadRecord(outcome.operator)?.canceled === true) current.stopReason = "cancelled";
				}
				continue;
			}
			if (entry.customType === IN_RUN_CONTINUATION_ENTRY) {
				if (current !== null) {
					current.stopReason = "error";
					if (stamp !== undefined) current.finishedAt = stamp;
				}
				continue;
			}
			// A ceiling stop says why the turn after it waited or ended (#424).
			const frame = budgetBlockReplayFrame(entry);
			if (frame === null || current === null) continue;
			current.frames.push({ update: frame.update, meta: frame.meta });
			continue;
		}
		if (entry.kind !== "message") continue;
		const payload = payloadRecord(entry.payload);
		if (entry.role === "user") {
			// Middleware continuations are provider context, not operator authorship, but they do reopen the turn: the
			// earlier end_turn no longer settles it, and an outcome names the continuation's own id.
			if (payload?.synthetic === true) {
				if (current !== null) {
					current.userTurnId = entry.turnId;
					current.turnIds?.push(entry.turnId);
					current.stopReason = "error";
					if (stamp !== undefined) current.finishedAt = stamp;
				}
				continue;
			}
			// A queued message the engine drained into the running run (a steer between tool batches, a follow-up at its end)
			// arrived inside the prompt that run answered: live that prompt never ended for it, so replay keeps it in the
			// same turn, and the run's outcome names it as the turn's last user message (ACP-5 J9).
			if (current !== null && (payload?.queued === "steer" || payload?.queued === "follow-up")) {
				current.userTurnId = entry.turnId;
				current.turnIds?.push(entry.turnId);
				current.stopReason = "error";
				if (stamp !== undefined) current.finishedAt = stamp;
				replayMessageChunks(current.frames, "user_message_chunk", replayTextBlocks(entry).text);
				continue;
			}
			if (current !== null) closeUnrecordedReplayCalls(ids, current.frames);
			// A crash can leave the request without a terminal assistant or turnOutcome.
			current = {
				frames: [],
				userTurnId: entry.turnId,
				turnIds: [entry.turnId],
				stopReason: "error",
				...(stamp !== undefined ? { startedAt: stamp, finishedAt: stamp } : {}),
			};
			turns.push(current);
			const operatorText =
				typeof payload?.operatorText === "string" ? [payload.operatorText] : replayTextBlocks(entry).text;
			replayMessageChunks(current.frames, "user_message_chunk", operatorText);
			continue;
		}
		if (current === null) continue;
		if (stamp !== undefined) current.finishedAt = stamp;
		if (entry.role === "assistant") {
			// The ledger keeps a cut-off call's error result; the reply before it names the calls that never ran.
			for (const id of outputLimitCutOffToolCallIds(payload)) cutOffToolCalls.add(id);
			current.stopReason = payload?.stopReason === "toolUse" ? "error" : mapAcpStopReason(payload?.stopReason);
			const model = safeStoredIdentifier(payload?.model, ACP_MAX_MODEL_ID_BYTES);
			if (model) current.model = model;
			// A failed call records the target it ran on; any other call ran on the ledger's route.
			const failedOn = safeStoredIdentifier(payloadRecord(payload?.failureRoute)?.targetId, ACP_MAX_TARGET_ID_BYTES);
			const target = failedOn ?? safeStoredIdentifier(routeTarget, ACP_MAX_TARGET_ID_BYTES);
			if (target) current.target = target;
			const blocks = replayTextBlocks(entry);
			// Stored text ends where the live stream did, and a message that stopped short can end inside a URL (#446).
			const completed = messageStopCompleted(payload?.stopReason);
			replayMessageChunks(current.frames, "agent_thought_chunk", blocks.thinking, completed);
			const text = separatedTextBlocks(blocks.text, current.sentAssistantText === true);
			replayMessageChunks(current.frames, "agent_message_chunk", text, completed);
			if (text.length > 0) current.sentAssistantText = true;
			continue;
		}
		if (entry.role === "tool_call") {
			const call = replayToolCall(entry);
			if (protocolRetryCalls.has(call.engineId)) continue;
			const toolCallId = startToolCallId(ids, call.engineId);
			ids.openToolCalls.add(toolCallId);
			ids.lastEmittedToolCallId = toolCallId;
			const presentation = toolCallPresentation(call.name, call.args, cwd);
			presented.set(toolCallId, presentation);
			current.frames.push({
				update: {
					sessionUpdate: "tool_call",
					toolCallId,
					name: call.name,
					title: presentation.title,
					kind: presentation.kind,
					status: (refusedToolCalls.has(call.engineId) ? "pending" : "in_progress") satisfies AcpToolCallStatus,
					rawInput: boundRawInput(call.args),
					...(presentation.locations !== undefined ? { locations: presentation.locations } : {}),
				},
			});
			continue;
		}
		if (entry.role === "tool_result") {
			const engineId = typeof payload?.toolCallId === "string" ? payload.toolCallId : undefined;
			if (engineId !== undefined && protocolRetryCalls.has(engineId)) continue;
			const toolCallId = endToolCallId(ids, engineId);
			if (toolCallId === null || ids.terminalToolCalls.has(toolCallId)) continue;
			ids.openToolCalls.delete(toolCallId);
			ids.terminalToolCalls.add(toolCallId);
			const notRun = typeof engineId === "string" && cutOffToolCalls.has(engineId) ? "output_limit" : undefined;
			const failed =
				notRun === undefined &&
				(payload?.isError === true || payload?.outcome === "error" || payload?.outcome === "blocked");
			const output = boundString(redactUrlCredentials(outputText(payload?.result)), ACP_MAX_CHUNK_BYTES);
			const content = toolResultContent(output, payload?.result);
			const name = safeStoredString(payload?.toolName, 64, "tool") || "tool";
			const started = presented.get(toolCallId);
			current.frames.push({
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					title: started?.title ?? name,
					kind: started?.kind ?? toolKind(name),
					status: (failed ? "failed" : "completed") satisfies AcpToolCallStatus,
					...(content.length > 0 ? { content } : {}),
					rawOutput: boundRawRecord({
						result: withoutImageData(payload?.result),
						isError: failed,
						...(notRun !== undefined ? { notRun } : {}),
					}),
				},
				...(typeof payload?.durationMs === "number" && Number.isFinite(payload.durationMs) && payload.durationMs >= 0
					? { meta: { [ACP_TOOL_TIMING_META_KEY]: { durationMs: Math.round(payload.durationMs) } } }
					: {}),
			});
		}
	}
	if (current !== null) closeUnrecordedReplayCalls(ids, current.frames);

	const params = turns.flatMap((turn, index) => {
		const route = {
			...(turn.model !== undefined ? { model: turn.model } : {}),
			...(turn.target !== undefined ? { connection: turn.target } : {}),
		};
		return turn.frames.map((frame) => ({
			sessionId,
			update: frame.update,
			_meta: {
				[ACP_REPLAY_META_KEY]: {
					turn: index + 1,
					...(turn.stopReason !== undefined ? { stopReason: turn.stopReason } : {}),
					...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
					...(turn.startedAt !== undefined && turn.finishedAt !== undefined ? { finishedAt: turn.finishedAt } : {}),
				},
				...(turn.model !== undefined || turn.target !== undefined ? { [ACP_TURN_META_KEY]: route } : {}),
				...frame.meta,
			},
		}));
	});
	return { params, runs, turns: turns.length, turnIds: turns.map((turn) => turn.turnIds ?? []), truncated: false };
}

/**
 * Each replayed turn's usage, the same block its live prompt response carried, on the turn's last frame. Without it a
 * reopened session shows no tokens on any turn although the journal holds them (gui-verify 6).
 */
export function withReplayUsage(
	replay: PreparedAcpReplay,
	view: TelemetryView | null,
	fullUsage: boolean,
): PreparedAcpReplay {
	if (view === null) return replay;
	const lastFrame = new Map<number, number>();
	replay.params.forEach((param, index) => {
		const turn = payloadRecord(param._meta[ACP_REPLAY_META_KEY])?.turn;
		if (typeof turn === "number") lastFrame.set(turn, index);
	});
	const params = [...replay.params];
	for (const [turn, index] of lastFrame) {
		const turnIds = replay.turnIds[turn - 1] ?? [];
		const param = params[index];
		if (turnIds.length === 0 || param === undefined) continue;
		const usage = turnUsageMeta(view, { turnIds: new Set(turnIds), attemptIds: new Set() });
		params[index] = {
			...param,
			_meta: { ...param._meta, [ACP_USAGE_META_KEY]: fullUsage ? usage : compactUsage(usage) },
		};
	}
	return { ...replay, params };
}

export function sessionResultMeta(
	session: AcpServerSession,
	resumed: boolean,
	replayed?: { turns: number; truncated: boolean },
): AcpSessionResultMeta {
	return {
		sessionId: session.id,
		connection: session.target,
		model: session.model,
		autonomy: session.autonomy,
		createdAt: safeIso(session.createdAt),
		resumed,
		...(replayed !== undefined ? { replayed } : {}),
	};
}
