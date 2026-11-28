// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Tool calls and tasks: listing a server's tools and following one call to its
 * end. A call may go through input rounds, a HeaderMismatch re-list, a URL
 * elicitation retry, one upload, or a task polled to its terminal state, all
 * inside the one timeout the gateway admitted it with, less the operator's time.
 */

import { performance } from "node:perf_hooks";
import { rememberResolvedSecret } from "../../core/sandbox/env-scrub.js";
import { clampTimerDelayMs, sleep } from "../../core/timers.js";
import { isRecord } from "../../core/type-guards.js";
import type { McpCallToolOptions, McpToolListing } from "./client.js";
import type { McpElicitation } from "./client-elicitation.js";
import type { McpInitialization } from "./client-init.js";
import {
	type ActiveCall,
	DEFAULT_CANCEL_GRACE_MS,
	freshnessOf,
	type McpSession,
	serverAnswerError,
	serverText,
} from "./client-session.js";
import type { McpElicitResult } from "./elicitation.js";
import { isMcpUploadRequired, mcpTargetSecrets, parseMcpDownloads, parseMcpUploadRequest } from "./files.js";
import { mcpParamHeaders } from "./http-headers.js";
import type { JsonRpcErrorObject } from "./protocol.js";
import { JSON_RPC_INVALID_PARAMS, MCP_HEADER_MISMATCH, McpError } from "./protocol.js";
import {
	type McpToolCallResult,
	type McpToolDescriptor,
	outputSchemaMismatch,
	parseToolCallResult,
	parseToolDescriptor,
} from "./tool-results.js";
import type { McpParamHeader } from "./transport.js";

/** Tools accepted from one server before pagination stops. */
export const MCP_TOOL_LIST_CAP = 500;
/** Pages followed before a cursor that never ends is abandoned. */
export const MCP_TOOL_LIST_PAGE_CAP = 100;
/** Poll interval for a task whose server suggests none. */
export const DEFAULT_TASK_POLL_INTERVAL_MS = 1_000;
/** Bounds on a server-suggested poll interval: a zero cannot spin the server, a huge one cannot stall the call. */
export const MIN_TASK_POLL_INTERVAL_MS = 250;
export const MAX_TASK_POLL_INTERVAL_MS = 30_000;

type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/** One observed state of an MCP Tasks task: a CreateTaskResult or a tasks/get result. */
interface McpTaskState {
	taskId: string;
	status: McpTaskStatus;
	statusMessage: string | null;
	ttlMs: number | null;
	pollIntervalMs: number | null;
	result: unknown;
	error: unknown;
	/** The outstanding server-to-client requests of an input_required task. */
	inputRequests: Record<string, unknown> | null;
}

const TASK_STATUSES: ReadonlySet<string> = new Set(["working", "input_required", "completed", "failed", "cancelled"]);

function parseTaskState(value: unknown, method: string, expectedId: string | null): McpTaskState | McpError {
	if (!isRecord(value)) return new McpError("protocol", `${method} result is not an object`);
	if (typeof value.taskId !== "string" || value.taskId.length === 0) {
		return new McpError("protocol", `${method} result lacks a taskId`);
	}
	if (expectedId !== null && value.taskId !== expectedId) {
		return new McpError("protocol", `${method} answered for task ${value.taskId}, not ${expectedId}`);
	}
	if (typeof value.status !== "string" || !TASK_STATUSES.has(value.status)) {
		return new McpError("protocol", `${method} result has an unknown task status ${JSON.stringify(value.status)}`);
	}
	const finite = (field: unknown): number | null =>
		typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : null;
	return {
		taskId: value.taskId,
		status: value.status as McpTaskStatus,
		statusMessage: typeof value.statusMessage === "string" ? serverText(value.statusMessage) : null,
		ttlMs: finite(value.ttlMs),
		pollIntervalMs: finite(value.pollIntervalMs),
		result: value.result,
		error: value.error,
		inputRequests: isRecord(value.inputRequests) ? value.inputRequests : null,
	};
}

/** A JSON-RPC error carried in a task or a reply, worded like a direct error answer to `tools/call`. */
function serverErrorFrom(method: string, error: unknown, fallback: string): McpError {
	if (isRecord(error) && typeof error.code === "number" && typeof error.message === "string") {
		const object: JsonRpcErrorObject = { code: error.code, message: error.message };
		if (error.data !== undefined) object.data = error.data;
		return serverAnswerError(method, object);
	}
	return new McpError("server", `${method}: ${fallback}`);
}

/**
 * Why the retry that answers an upload request, or a later retry of its
 * call, has an unknown outcome (files, Repeated Retries), or null when the
 * server's own error answer settles it.
 */
function unknownOutcome(error: unknown): string | null {
	if (!(error instanceof McpError)) return "failed before its answer arrived";
	switch (error.code) {
		case "server":
			return isRecord(error.data) && error.data.code === JSON_RPC_INVALID_PARAMS ? "was refused with -32602" : null;
		case "timeout":
			return "got no answer in time";
		case "aborted":
			return "was cancelled before its answer arrived";
		default:
			return "lost its answer";
	}
}

export interface McpToolCalls {
	listTools(signal?: AbortSignal): Promise<McpToolListing>;
	callTool(name: string, args: Record<string, unknown>, callOptions?: McpCallToolOptions): Promise<McpToolCallResult>;
}

export function createMcpToolCalls(
	session: McpSession,
	initialization: McpInitialization,
	elicitation: McpElicitation,
): McpToolCalls {
	const {
		id,
		options,
		transport,
		requestTimeoutMs,
		maxResultTextBytes,
		elicitationHandler,
		fileTransfers,
		lifetime,
		activeCalls,
		request,
		fail,
		close,
		trackProgress,
		filesOffered,
		fileConnection,
	} = session;
	const { ensureReady, withDiscoverySignal } = initialization;
	const { answerInputRequired, fulfilInputRequests, urlElicitationsRequired, answerUrlElicitationsRequired } =
		elicitation;

	/**
	 * Over Streamable HTTP in the modern era, a tool whose `x-mcp-header`
	 * annotations break the Schema Extension rules is left out of the listing
	 * (basic/transports/streamable-http, Custom Headers from Tool Parameters).
	 */
	const mirrorsHeaders = (): boolean => transport.http !== undefined && session.era === "modern";

	const listToolsOnce = async (signal?: AbortSignal): Promise<McpToolListing> => {
		await ensureReady(signal);
		const tools: McpToolDescriptor[] = [];
		const dropped: Array<{ name: string; reason: string }> = [];
		const mirrored = new Map<string, McpParamHeader[]>();
		let cursor: string | undefined;
		let pages = 0;
		// Each page carries its own freshness; the listing is as fresh as its stalest part.
		let ttlMs = session.era === "modern" ? (session.info?.ttlMs ?? 0) : undefined;
		const finish = (truncated: boolean): McpToolListing => {
			session.outputSchemas = new Map(
				tools.flatMap((tool) => (tool.outputSchema ? [[tool.name, tool.outputSchema]] : [])),
			);
			session.paramHeaders = mirrored;
			return {
				tools,
				truncated,
				...(ttlMs !== undefined ? { ttlMs } : {}),
				...(dropped.length > 0 ? { dropped } : {}),
			};
		};
		for (;;) {
			pages += 1;
			const result = await request("tools/list", cursor === undefined ? {} : { cursor }, requestTimeoutMs, signal);
			if (!isRecord(result) || !Array.isArray(result.tools)) {
				throw new McpError("protocol", "tools/list result lacks a tools array");
			}
			if (ttlMs !== undefined) ttlMs = Math.min(ttlMs, freshnessOf(result.ttlMs));
			for (const entry of result.tools) {
				if (tools.length >= MCP_TOOL_LIST_CAP) return finish(true);
				const descriptor = parseToolDescriptor(entry);
				if (descriptor instanceof McpError) throw descriptor;
				if (mirrorsHeaders()) {
					const headers = mcpParamHeaders(descriptor.inputSchema);
					if (typeof headers === "string") {
						dropped.push({ name: descriptor.name, reason: serverText(headers) });
						continue;
					}
					if (headers.length > 0) mirrored.set(descriptor.name, headers);
				}
				tools.push(descriptor);
			}
			const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
			if (next === undefined) return finish(false);
			if (tools.length >= MCP_TOOL_LIST_CAP || pages >= MCP_TOOL_LIST_PAGE_CAP) return finish(true);
			cursor = next;
		}
	};

	const listTools = (signal?: AbortSignal): Promise<McpToolListing> =>
		withDiscoverySignal(signal, () => listToolsOnce(signal));

	/** Read a final tools/call answer and check its structuredContent against the tool's outputSchema. */
	const finishToolResult = async (name: string, value: unknown): Promise<McpToolCallResult> => {
		const parsed = parseToolCallResult(value, maxResultTextBytes);
		if (parsed instanceof McpError) throw parsed;
		if (fileTransfers && filesOffered() !== null && isRecord(value)) {
			const downloads = parseMcpDownloads(value._meta);
			for (const target of downloads.targets)
				for (const secret of mcpTargetSecrets(target)) rememberResolvedSecret(secret);
			if (downloads.targets.length > 0 || downloads.dropped.length > 0) parsed.downloads = downloads;
		}
		const schema = session.outputSchemas.get(name);
		if (parsed.isError || schema === undefined || parsed.structuredContent === undefined) return parsed;
		const mismatch = await outputSchemaMismatch(schema, parsed.structuredContent, parsed.structuredContentJson);
		if (mismatch === null) return parsed;
		return { ...parsed, isError: true, outputSchemaMismatch: serverText(`mcp server ${id}, tool ${name}: ${mismatch}`) };
	};

	const callTool = async (
		name: string,
		args: Record<string, unknown>,
		callOptions: McpCallToolOptions = {},
	): Promise<McpToolCallResult> => {
		const signal = callOptions.signal;
		if (signal?.aborted) throw new McpError("aborted", "tools/call aborted before it was sent");
		await ensureReady(signal);
		const timeoutMs = clampTimerDelayMs(callOptions.timeoutMs ?? requestTimeoutMs);
		const startedAt = performance.now();
		const call: ActiveCall = {
			...(signal !== undefined ? { signal } : {}),
			outcomes: [],
			pausedMs: 0,
			consentedUrls: new Set(),
		};
		const promptSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
		const finished = (result: McpToolCallResult): McpToolCallResult =>
			call.outcomes.length > 0 ? { ...result, elicitations: [...call.outcomes] } : result;
		let params: Record<string, unknown> = { name, arguments: args };
		let relisted = false;
		let urlRetried = false;
		/** Set once the retry that answers an upload request is due; from then on a lost answer is an unknown outcome. */
		let uploaded = false;
		const didNotRun = (reason: string): McpToolCallResult => {
			const text = `mcp server ${id}, tool ${name}: the tool did not run: ${reason}.`;
			return { content: [{ type: "text", text }], isError: true, text, textTruncated: false };
		};
		activeCalls.add(call);
		try {
			for (let round = 1; ; round += 1) {
				let budget = timeoutMs;
				if (round > 1 && timeoutMs > 0) {
					// The operator's time answering an elicitation is not the server's time.
					budget = Math.ceil(startedAt + call.pausedMs + timeoutMs - performance.now());
					if (budget <= 0) throw new McpError("timeout", `tools/call timed out after ${timeoutMs}ms`);
				}
				// Each request round gets its own progressToken so a retry under MRTR starts with a fresh counter.
				const progress = callOptions.onProgress === undefined ? null : trackProgress(callOptions.onProgress);
				try {
					const sent = progress === null ? params : { ...params, _meta: { progressToken: progress.token } };
					let result: unknown;
					try {
						result = await request("tools/call", sent, budget, signal);
					} catch (error) {
						const unknown = uploaded ? unknownOutcome(error) : null;
						if (unknown !== null) {
							const text = `mcp server ${id}, tool ${name}: the outcome is unknown: the files were uploaded and the retry ${unknown}. The tool may have run, in whole or in part; PanCode does not send it again.`;
							return finished({ content: [{ type: "text", text }], isError: true, text, textTruncated: false });
						}
						// A HeaderMismatch means the listing PanCode mirrored from is stale:
						// list again and send the call once more (streamable-http, Server Behavior).
						const answered = error instanceof McpError && error.code === "server" && isRecord(error.data);
						if (answered && !relisted && mirrorsHeaders() && error.data.code === MCP_HEADER_MISMATCH) {
							relisted = true;
							session.toolsChangedFlag = true;
							const listing = await listToolsOnce(signal);
							if (!listing.tools.some((entry) => entry.name === name)) {
								const dropped = listing.dropped?.find((entry) => entry.name === name);
								throw new McpError(
									"server",
									dropped !== undefined
										? `tools/call (${name}) refused after HeaderMismatch relist: tool dropped (${dropped.reason})`
										: `tools/call (${name}) refused after HeaderMismatch relist: server no longer lists tool ${name}`,
									error.data,
								);
							}
							const refusal = callOptions.onHeaderMismatchRelist?.(listing) ?? null;
							if (refusal !== null) throw new McpError("server", refusal, error.data);
							round -= 1;
							continue;
						}
						const elicitations = urlElicitationsRequired(error);
						if (elicitations === null || urlRetried) throw error;
						const declined = await answerUrlElicitationsRequired(error as McpError, elicitations, promptSignal, call);
						if (declined !== null) return finished(declined);
						// One retry once every URL is done; a second -32042 for the call is its error.
						urlRetried = true;
						continue;
					}
					if (
						session.era === "modern" &&
						isRecord(result) &&
						result.resultType !== undefined &&
						result.resultType !== "complete"
					) {
						if (result.resultType === "task")
							return finished(await awaitTask(name, result, startedAt, timeoutMs, signal, call, promptSignal));
						if (result.resultType === "input_required") {
							params = await answerInputRequired("tools/call", params, result, round, promptSignal, call);
							continue;
						}
						if (isMcpUploadRequired(result)) {
							// files, Transfer: one upload request per logical call, checked whole before any byte moves.
							if (uploaded)
								return finished(
									didNotRun("the server asked for the files a second time, after PanCode uploaded them to the storage it named"),
								);
							const files = callOptions.files;
							if (files === undefined || files.pending.size === 0 || filesOffered()?.upload !== true) {
								return finished(didNotRun("the server asked for an upload this call cannot answer"));
							}
							const parsedRequest = parseMcpUploadRequest(result, files.pending);
							if (typeof parsedRequest === "string") {
								return finished(didNotRun(`PanCode rejected the server's upload request: ${serverText(parsedRequest)}`));
							}
							rememberResolvedSecret(parsedRequest.requestState);
							for (const target of parsedRequest.uploads)
								for (const secret of mcpTargetSecrets(target)) rememberResolvedSecret(secret);
							const transferStarted = performance.now();
							const stopped = await files.upload(parsedRequest, fileConnection(), signal);
							call.pausedMs += performance.now() - transferStarted;
							if (stopped !== null) return finished(didNotRun(stopped));
							uploaded = true;
							params = { name, arguments: params.arguments, requestState: parsedRequest.requestState };
							continue;
						}
						throw new McpError(
							"protocol",
							`tools/call returned resultType ${serverText(JSON.stringify(result.resultType))}, which this client does not handle`,
						);
					}
					return finished(await finishToolResult(name, result));
				} finally {
					progress?.release();
				}
			}
		} finally {
			activeCalls.delete(call);
		}
	};

	/**
	 * Ask the server to stop a task PanCode is abandoning. The ack is cooperative
	 * and bounded by the cancel grace; a server that cannot even acknowledge
	 * within it is treated like a wedged direct call and the client is closed.
	 */
	const cancelTask = async (taskId: string, cause: McpError): Promise<void> => {
		try {
			await request("tasks/cancel", { taskId }, Math.max(1, options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS));
		} catch (error) {
			// A JSON-RPC error answer (for example a task that already finished) still proves a live transport.
			if (error instanceof McpError && error.code === "server") return;
			fail(cause);
			await close();
		}
	};

	/**
	 * Follow a task the server created for `tools/call` to its terminal state
	 * (MCP Tasks extension, specification 2026-07-28). The whole task is the one
	 * tool call the gateway admitted: polling shares the call's timeout and abort
	 * signal, and the completed task yields the same McpToolCallResult a direct
	 * answer would. Polling waits the server's pollIntervalMs, held between
	 * MIN_TASK_POLL_INTERVAL_MS and MAX_TASK_POLL_INTERVAL_MS, between tasks/get
	 * requests, stops at a terminal status, and sends tasks/cancel when the turn
	 * aborts, the call times out, the task outlives its ttlMs, or the server
	 * asks for input this client cannot give. An input_required task's
	 * elicitations are put to the operator once per key and answered with
	 * tasks/update; the operator's time does not count against the call.
	 */
	const awaitTask = async (
		name: string,
		created: Record<string, unknown>,
		startedAt: number,
		timeoutMs: number,
		signal: AbortSignal | undefined,
		call: ActiveCall,
		promptSignal: AbortSignal,
	): Promise<McpToolCallResult> => {
		const first = parseTaskState(created, "tools/call", null);
		if (first instanceof McpError) throw first;
		const taskId = first.taskId;
		const deadlineAt = (): number => (timeoutMs > 0 ? startedAt + call.pausedMs + timeoutMs : Number.POSITIVE_INFINITY);
		/** Keys answered over the task's lifetime, which the server never reuses (Tasks, Input Requests). */
		const answered = new Set<string>();
		// The ttl counts from the server's creation; the local receipt time is a
		// conservative stand-in that no clock skew between the two can stretch.
		const expiresAt = first.ttlMs === null ? Number.POSITIVE_INFINITY : performance.now() + first.ttlMs;
		const timedOut = (): McpError => new McpError("timeout", `tools/call timed out after ${timeoutMs}ms`);
		const aborted = (): McpError => new McpError("aborted", "tools/call aborted");
		/** A tasks/* request within what is left of the call's time, failing as the call would. */
		const taskRequest = async (method: string, taskParams: Record<string, unknown>): Promise<unknown> => {
			const left = deadlineAt() - performance.now();
			if (left <= 0) throw timedOut();
			try {
				return await request(method, taskParams, Number.isFinite(left) ? Math.max(1, Math.ceil(left)) : 0, signal);
			} catch (error) {
				if (error instanceof McpError && error.code === "timeout") throw timedOut();
				if (error instanceof McpError && error.code === "aborted") throw aborted();
				throw error;
			}
		};
		let task = first;
		try {
			for (;;) {
				switch (task.status) {
					case "completed":
						return await finishToolResult(name, task.result);
					case "failed":
						throw serverErrorFrom(
							"tools/call",
							task.error,
							`task ${taskId} failed${task.statusMessage ? `: ${task.statusMessage}` : ""}`,
						);
					case "cancelled":
						throw new McpError(
							"server",
							`tools/call: task ${taskId} was cancelled by the server${task.statusMessage ? `: ${task.statusMessage}` : ""}`,
						);
					case "input_required": {
						if (elicitationHandler === undefined) {
							await cancelTask(taskId, new McpError("server", `tools/call: task ${taskId} required input`));
							throw new McpError(
								"server",
								`tools/call: task ${taskId} asked for client input (elicitation or sampling), which this client does not provide; the task was cancelled`,
							);
						}
						// A poll repeats every outstanding request; each key is put to the operator once.
						const fresh = Object.entries(task.inputRequests ?? {}).filter(([key]) => !answered.has(key));
						if (fresh.length === 0) break;
						let inputResponses: Record<string, McpElicitResult>;
						try {
							inputResponses = await fulfilInputRequests("tasks/get", fresh, promptSignal, call);
						} catch (error) {
							if (error instanceof McpError && error.code === "protocol") await cancelTask(taskId, error);
							throw error;
						}
						for (const [key] of fresh) answered.add(key);
						await taskRequest("tasks/update", { taskId, inputResponses });
						break;
					}
					case "working":
						break;
				}
				const now = performance.now();
				if (now >= expiresAt) {
					const expired = new McpError(
						"server",
						`tools/call: task ${taskId} did not finish within its ${first.ttlMs}ms lifetime`,
					);
					await cancelTask(taskId, expired);
					throw expired;
				}
				const remaining = deadlineAt() - now;
				if (remaining <= 0) throw timedOut();
				const interval = Math.min(
					MAX_TASK_POLL_INTERVAL_MS,
					Math.max(MIN_TASK_POLL_INTERVAL_MS, task.pollIntervalMs ?? DEFAULT_TASK_POLL_INTERVAL_MS),
				);
				try {
					await sleep(Math.min(interval, remaining, expiresAt - now), signal);
				} catch {
					throw aborted();
				}
				const polled = await taskRequest("tasks/get", { taskId });
				const next = parseTaskState(polled, "tasks/get", taskId);
				if (next instanceof McpError) throw next;
				task = next;
			}
		} catch (error) {
			if (error instanceof McpError && (error.code === "aborted" || error.code === "timeout")) {
				await cancelTask(taskId, error);
			}
			throw error;
		}
	};

	return { listTools, callTool };
}
