// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Elicitation: putting a server's request for input in front of the operator.
 * One path reads every form and URL, whichever way it arrives: a modern
 * `input_required` result or task, a legacy server's own `elicitation/create`
 * request, or a legacy -32042 error listing URLs. The time the operator takes
 * is added to each waiting call's paused time, which no timeout counts.
 */

import { performance } from "node:perf_hooks";
import { isRecord } from "../../../core/type-guards.js";
import { type ActiveCall, errorMessage, type McpSession, serverText } from "./client-session.js";
import {
	formContentErrors,
	type McpElicitationContext,
	type McpElicitResult,
	parseElicitationRequest,
} from "./elicitation.js";
import type { JsonRpcId } from "./protocol.js";
import { JSON_RPC_INVALID_PARAMS, MCP_URL_ELICITATION_REQUIRED, McpError } from "./protocol.js";
import {
	cutUtf8,
	DEFAULT_RESULT_TEXT_BYTES,
	type McpElicitationOutcome,
	type McpToolCallResult,
} from "./tool-results.js";

/** Retries of one request that the server keeps answering with input_required (basic/patterns/mrtr). */
const MCP_INPUT_REQUIRED_ROUNDS = 8;

export interface McpElicitation {
	answerInputRequired(
		method: string,
		params: Record<string, unknown>,
		result: Record<string, unknown>,
		round: number,
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<Record<string, unknown>>;
	fulfilInputRequests(
		method: string,
		entries: ReadonlyArray<[string, unknown]>,
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<Record<string, McpElicitResult>>;
	urlElicitationsRequired(error: unknown): unknown[] | null;
	answerUrlElicitationsRequired(
		error: McpError,
		elicitations: unknown[],
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<McpToolCallResult | null>;
	answerServerElicitation(requestId: JsonRpcId, params: unknown): Promise<void>;
}

export function createMcpElicitation(session: McpSession): McpElicitation {
	const { id, elicitationHandler, pending, lifetime, activeCalls, serverElicitations, urlCompletions, reply } = session;

	/**
	 * Put one elicitation in front of the operator and read the answer into the
	 * ElicitResult the server is sent. A request PanCode will not show (a field
	 * asking for a secret, a schema richer than a flat form, a link it would not
	 * open) is declined for the operator with the reason, and an accepted form
	 * is checked against its schema before it leaves (client/elicitation, Form
	 * Mode Security). `paused` receives the time the operator took, which no
	 * timeout counts. `invalid` is a request that breaks the protocol.
	 */
	const elicit = async (
		params: unknown,
		legacy: boolean,
		signal: AbortSignal,
		calls: readonly ActiveCall[],
		awaitCompletion: boolean,
	): Promise<{ result: McpElicitResult; outcome: McpElicitationOutcome } | { invalid: string }> => {
		const parsed = parseElicitationRequest(params, legacy);
		if (parsed.kind === "invalid") return { invalid: parsed.reason };
		if (parsed.kind === "declined")
			return { result: { action: "decline" }, outcome: { mode: parsed.mode, action: "decline", reason: parsed.reason } };
		if (elicitationHandler === undefined) return { invalid: "PanCode declared no elicitation capability" };
		const asked = parsed.request;
		const url = asked.mode === "url" ? asked.url : null;
		const completion =
			awaitCompletion && asked.mode === "url" && asked.elicitationId !== undefined ? new AbortController() : null;
		if (completion !== null && asked.mode === "url" && asked.elicitationId !== undefined)
			urlCompletions.set(asked.elicitationId, completion);
		const context: McpElicitationContext = {
			signal,
			awaitCompletion,
			consented: awaitCompletion && url !== null && calls.some((call) => call.consentedUrls.has(url)),
			...(completion !== null ? { completed: completion.signal } : {}),
		};
		const cancelled = (reason: string) => ({
			result: { action: "cancel" as const },
			outcome: { mode: asked.mode, action: "cancel" as const, reason },
		});
		const began = performance.now();
		let answer: McpElicitResult;
		try {
			answer = await elicitationHandler(asked, context);
		} catch (error) {
			if (signal.aborted) throw new McpError("aborted", "elicitation aborted");
			return cancelled(`the prompt failed: ${errorMessage(error)}`);
		} finally {
			const pausedMs = performance.now() - began;
			for (const call of calls) call.pausedMs += pausedMs;
			if (asked.mode === "url" && asked.elicitationId !== undefined) urlCompletions.delete(asked.elicitationId);
		}
		if (signal.aborted) throw new McpError("aborted", "elicitation aborted");
		if (answer.action === "decline" || answer.action === "cancel")
			return { result: { action: answer.action }, outcome: { mode: asked.mode, action: answer.action } };
		if (answer.action !== "accept") return cancelled("the prompt returned no action");
		if (asked.mode === "url") {
			for (const call of calls) call.consentedUrls.add(asked.url);
			return { result: { action: "accept" }, outcome: { mode: "url", action: "accept" } };
		}
		const content = answer.content ?? {};
		const errors = formContentErrors(asked, content);
		if (errors.length > 0) return cancelled(`the answer did not fit the form: ${errors.join("; ")}`);
		return { result: { action: "accept", content }, outcome: { mode: "form", action: "accept" } };
	};

	/**
	 * Fulfil the `inputRequests` of an input_required result or task
	 * (basic/patterns/mrtr), each in turn. Elicitation is the only capability
	 * PanCode declares, so a request for anything else (sampling, roots) breaks
	 * the protocol and fails the call before the operator is asked anything.
	 */
	const fulfilInputRequests = async (
		method: string,
		entries: ReadonlyArray<[string, unknown]>,
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<Record<string, McpElicitResult>> => {
		const methods = [
			...new Set(entries.map(([, entry]) => (isRecord(entry) && typeof entry.method === "string" ? entry.method : "?"))),
		];
		if (elicitationHandler === undefined) {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required asking for ${serverText(methods.join(", "))}, but PanCode declared no client capabilities, so a server must not ask it for input`,
			);
		}
		const foreign = methods.filter((name) => name !== "elicitation/create");
		if (foreign.length > 0) {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required asking for ${serverText(foreign.join(", "))}, but PanCode declared only elicitation, so a server must not ask it for that`,
			);
		}
		const responses: Record<string, McpElicitResult> = {};
		for (const [key, entry] of entries) {
			const answered = await elicit(isRecord(entry) ? entry.params : undefined, false, signal, [call], true);
			if ("invalid" in answered) {
				throw new McpError(
					"protocol",
					`mcp server ${id} answered ${method} with an elicitation PanCode cannot read: ${serverText(answered.invalid)}`,
				);
			}
			responses[key] = answered.result;
			call.outcomes.push(answered.outcome);
		}
		return responses;
	};

	/**
	 * The one place an `input_required` answer (MCP 2026-07-28
	 * basic/patterns/mrtr) is handled; it returns the params of the retry: the
	 * original params with `inputResponses` keyed exactly as the server asked,
	 * and its `requestState` echoed verbatim, or none when it sent none.
	 */
	const answerInputRequired = async (
		method: string,
		params: Record<string, unknown>,
		result: Record<string, unknown>,
		round: number,
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<Record<string, unknown>> => {
		if (result.inputRequests !== undefined && !isRecord(result.inputRequests)) {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required whose inputRequests is not an object`,
			);
		}
		const asked = isRecord(result.inputRequests) ? Object.entries(result.inputRequests) : [];
		if (asked.length === 0 && typeof result.requestState !== "string") {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required carrying neither inputRequests nor a requestState`,
			);
		}
		if (round > MCP_INPUT_REQUIRED_ROUNDS) {
			throw new McpError(
				"protocol",
				`mcp server ${id} answered ${method} with input_required ${round} times in a row; PanCode stops retrying after ${MCP_INPUT_REQUIRED_ROUNDS}`,
			);
		}
		const inputResponses = asked.length > 0 ? await fulfilInputRequests(method, asked, signal, call) : null;
		const { requestState: _previous, inputResponses: _answered, ...base } = params;
		return {
			...base,
			...(inputResponses !== null ? { inputResponses } : {}),
			...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}),
		};
	};

	/** The URL elicitations a legacy server's -32042 error asks for before its request is retried, or null. */
	const urlElicitationsRequired = (error: unknown): unknown[] | null => {
		if (elicitationHandler === undefined || session.era !== "legacy") return null;
		if (!(error instanceof McpError) || error.code !== "server" || !isRecord(error.data)) return null;
		const { code, data } = error.data;
		if (code !== MCP_URL_ELICITATION_REQUIRED || !isRecord(data) || !Array.isArray(data.elicitations)) return null;
		return data.elicitations.length > 0 ? data.elicitations : null;
	};

	/**
	 * Put each URL of a -32042 error in front of the operator (2025-11-25
	 * client/elicitation, URL Elicitation Required Error); null means every one
	 * is done and the request is retried. A URL the operator turns down ends
	 * the call with the server's error, there being no request to answer.
	 */
	const answerUrlElicitationsRequired = async (
		error: McpError,
		elicitations: unknown[],
		signal: AbortSignal,
		call: ActiveCall,
	): Promise<McpToolCallResult | null> => {
		for (const entry of elicitations) {
			const answered =
				isRecord(entry) && entry.mode === "url"
					? await elicit(entry, true, signal, [call], true)
					: { invalid: "an elicitation it lists is not URL mode" };
			if ("invalid" in answered) {
				throw new McpError(
					"protocol",
					`mcp server ${id} answered tools/call with a URL-elicitation-required error PanCode cannot read: ${serverText(answered.invalid)}`,
				);
			}
			call.outcomes.push(answered.outcome);
			if (answered.result.action !== "accept") {
				const text = cutUtf8(error.message, DEFAULT_RESULT_TEXT_BYTES);
				return { content: [{ type: "text", text }], isError: true, text, textTruncated: false };
			}
		}
		return null;
	};

	/**
	 * A legacy server's own `elicitation/create` request (2025-11-25
	 * client/elicitation). It belongs to the tools/call in flight, whose
	 * timeout stops while the operator answers; with none in flight nobody
	 * can tell what asked, so it is cancelled unseen. A malformed request or
	 * an undeclared mode gets -32602.
	 */
	const answerServerElicitation = async (requestId: JsonRpcId, params: unknown): Promise<void> => {
		const calls = [...activeCalls];
		if (calls.length === 0) {
			reply({ jsonrpc: "2.0", id: requestId, result: { action: "cancel" } });
			return;
		}
		const withdrawn = new AbortController();
		serverElicitations.set(requestId, withdrawn);
		const signal = AbortSignal.any([
			withdrawn.signal,
			lifetime.signal,
			...calls.flatMap((call) => (call.signal ? [call.signal] : [])),
		]);
		const releases = [...pending.values()].filter((entry) => entry.method === "tools/call").map((entry) => entry.hold());
		try {
			const answered = await elicit(params, true, signal, calls, false);
			if ("invalid" in answered) {
				reply({ jsonrpc: "2.0", id: requestId, error: { code: JSON_RPC_INVALID_PARAMS, message: answered.invalid } });
				return;
			}
			for (const call of calls) call.outcomes.push(answered.outcome);
			reply({ jsonrpc: "2.0", id: requestId, result: answered.result });
		} catch {
			// The asking call was aborted: it is told the operator dismissed the prompt. A
			// withdrawn request or a closed client is owed nothing.
			if (!withdrawn.signal.aborted && !lifetime.signal.aborted)
				reply({ jsonrpc: "2.0", id: requestId, result: { action: "cancel" } });
		} finally {
			serverElicitations.delete(requestId);
			for (const release of releases) release();
		}
	};

	return {
		answerInputRequired,
		fulfilInputRequests,
		urlElicitationsRequired,
		answerUrlElicitationsRequired,
		answerServerElicitation,
	};
}
