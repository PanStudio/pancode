// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Resources, prompts, completion and the skills extension: the plain reads of
 * one client. Lists are paged under a cap; a read or prompt may go through
 * input rounds inside one timeout measured from its first send.
 */

import { performance } from "node:perf_hooks";
import { clampTimerDelayMs } from "../../core/timers.js";
import { isRecord } from "../../core/type-guards.js";
import type { McpRequestOptions } from "./client.js";
import type { McpElicitation } from "./client-elicitation.js";
import type { McpInitialization } from "./client-init.js";
import { type ActiveCall, freshnessOf, type McpSession, serverText } from "./client-session.js";
import { MCP_TOOL_LIST_PAGE_CAP } from "./client-tools.js";
import { JSON_RPC_METHOD_NOT_FOUND, McpError } from "./protocol.js";
import {
	MCP_PROMPT_LIST_CAP,
	MCP_RESOURCE_LIST_CAP,
	type McpCompletion,
	type McpCompletionReference,
	type McpPromptDescriptor,
	type McpPromptListing,
	type McpPromptResult,
	type McpResourceDescriptor,
	type McpResourceListing,
	type McpResourceRead,
	type McpResourceTemplateDescriptor,
	parseCompletion,
	parsePromptDescriptor,
	parsePromptResult,
	parseResourceDescriptor,
	parseResourceRead,
	parseResourceTemplate,
} from "./resources.js";
import { MCP_SKILLS_EXTENSION, type McpSkillsTransport, mcpSkillsSettings } from "./skills.js";

export interface McpReads {
	listResources(signal?: AbortSignal): Promise<McpResourceListing>;
	readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceRead>;
	listPrompts(signal?: AbortSignal): Promise<McpPromptListing>;
	getPrompt(name: string, args: Record<string, string>, options?: McpRequestOptions): Promise<McpPromptResult>;
	complete(
		ref: McpCompletionReference,
		argument: { name: string; value: string },
		context?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<McpCompletion>;
	skills(): McpSkillsTransport | null;
}

export function createMcpReads(
	session: McpSession,
	initialization: McpInitialization,
	elicitation: McpElicitation,
): McpReads {
	const { id, requestTimeoutMs, lifetime, activeCalls, request } = session;
	const { ensureReady } = initialization;
	const { answerInputRequired } = elicitation;

	/**
	 * Page through one list method, keeping at most `cap` entries; each page
	 * carries its own freshness and the listing is as fresh as its stalest
	 * part. A legacy server's method-not-found reads as an empty list when `optional`.
	 */
	const pagedList = async <T>(
		method: string,
		key: string,
		parse: (value: unknown) => T | McpError,
		cap: number,
		signal: AbortSignal | undefined,
		optional = false,
	): Promise<{ items: T[]; truncated: boolean; ttlMs?: number }> => {
		const items: T[] = [];
		let cursor: string | undefined;
		let pages = 0;
		let ttlMs = session.era === "modern" ? (session.info?.ttlMs ?? 0) : undefined;
		const finish = (truncated: boolean) => ({ items, truncated, ...(ttlMs !== undefined ? { ttlMs } : {}) });
		for (;;) {
			pages += 1;
			let result: unknown;
			try {
				result = await request(method, cursor === undefined ? {} : { cursor }, requestTimeoutMs, signal);
			} catch (error) {
				const missing =
					error instanceof McpError &&
					error.code === "server" &&
					isRecord(error.data) &&
					error.data.code === JSON_RPC_METHOD_NOT_FOUND;
				if (optional && pages === 1 && missing) return finish(false);
				throw error;
			}
			const page = isRecord(result) ? result[key] : undefined;
			if (!isRecord(result) || !Array.isArray(page)) {
				throw new McpError("protocol", `${method} result lacks a ${key} array`);
			}
			if (ttlMs !== undefined) ttlMs = Math.min(ttlMs, freshnessOf(result.ttlMs));
			for (const entry of page) {
				if (items.length >= cap) return finish(true);
				const parsed = parse(entry);
				if (parsed instanceof McpError) throw parsed;
				items.push(parsed);
			}
			const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
			if (next === undefined) return finish(false);
			if (items.length >= cap || pages >= MCP_TOOL_LIST_PAGE_CAP) return finish(true);
			cursor = next;
		}
	};

	const SKILLS_DECLARED = { [MCP_SKILLS_EXTENSION]: {} };
	const skillsSettings = () => (session.info === null ? null : mcpSkillsSettings(session.info.capabilities).settings);

	/** One skills-extension request; a modern answer must be complete, since nothing here follows a task or input round. */
	const skillsRequest = async (
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> => {
		await ensureReady(signal);
		const result = await request(method, params, requestTimeoutMs, signal, undefined, SKILLS_DECLARED);
		if (
			session.era === "modern" &&
			isRecord(result) &&
			result.resultType !== undefined &&
			result.resultType !== "complete"
		) {
			throw new McpError(
				"protocol",
				`${method} returned resultType ${serverText(JSON.stringify(result.resultType))}, which this client does not handle`,
			);
		}
		return result;
	};

	const skills = (): McpSkillsTransport | null => {
		const settings = skillsSettings();
		if (settings === null) return null;
		return {
			settings,
			listSkills: (cursor, signal) => skillsRequest("skills/list", cursor === undefined ? {} : { cursor }, signal),
			getSkill: (uri, signal) => skillsRequest("skills/get", { uri }, signal),
			readResource: (uri, signal) => readResource(uri, { ...(signal ? { signal } : {}), extensions: SKILLS_DECLARED }),
			readDirectory: (uri, cursor, signal) =>
				settings.directoryRead
					? skillsRequest("resources/directory/read", cursor === undefined ? { uri } : { uri, cursor }, signal)
					: Promise.reject(new McpError("protocol", `mcp server ${id} did not declare directoryRead`)),
		};
	};

	const listResources = async (signal?: AbortSignal): Promise<McpResourceListing> => {
		if (signal?.aborted) throw new McpError("aborted", "resources/list aborted before it was sent");
		await ensureReady(signal);
		const resources = await pagedList<McpResourceDescriptor>(
			"resources/list",
			"resources",
			parseResourceDescriptor,
			MCP_RESOURCE_LIST_CAP,
			signal,
		);
		const templates = await pagedList<McpResourceTemplateDescriptor>(
			"resources/templates/list",
			"resourceTemplates",
			parseResourceTemplate,
			MCP_RESOURCE_LIST_CAP - resources.items.length,
			signal,
			true,
		);
		const ttls = [resources.ttlMs, templates.ttlMs].filter((ttl): ttl is number => ttl !== undefined);
		return {
			resources: resources.items,
			templates: templates.items,
			truncated: resources.truncated || templates.truncated,
			...(ttls.length > 0 ? { ttlMs: Math.min(...ttls) } : {}),
		};
	};

	const listPrompts = async (signal?: AbortSignal): Promise<McpPromptListing> => {
		if (signal?.aborted) throw new McpError("aborted", "prompts/list aborted before it was sent");
		await ensureReady(signal);
		const prompts = await pagedList<McpPromptDescriptor>(
			"prompts/list",
			"prompts",
			parsePromptDescriptor,
			MCP_PROMPT_LIST_CAP,
			signal,
		);
		return {
			prompts: prompts.items,
			truncated: prompts.truncated,
			...(prompts.ttlMs !== undefined ? { ttlMs: prompts.ttlMs } : {}),
		};
	};

	/**
	 * One request that may answer `input_required` (resources/read, prompts/get):
	 * retried with the server's requestState until it completes, inside one
	 * timeout measured from the first send.
	 */
	const requestWithRetries = async (
		method: string,
		first: Record<string, unknown>,
		options: McpRequestOptions,
	): Promise<unknown> => {
		const { signal, extensions } = options;
		if (signal?.aborted) throw new McpError("aborted", `${method} aborted before it was sent`);
		await ensureReady(signal);
		const timeoutMs = clampTimerDelayMs(requestTimeoutMs);
		const startedAt = performance.now();
		const call: ActiveCall = {
			...(signal !== undefined ? { signal } : {}),
			outcomes: [],
			pausedMs: 0,
			consentedUrls: new Set(),
		};
		const promptSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
		let params = first;
		activeCalls.add(call);
		try {
			for (let round = 1; ; round += 1) {
				let budget = timeoutMs;
				if (round > 1 && timeoutMs > 0) {
					budget = Math.ceil(startedAt + call.pausedMs + timeoutMs - performance.now());
					if (budget <= 0) throw new McpError("timeout", `${method} timed out after ${timeoutMs}ms`);
				}
				const result = await request(method, params, budget, signal, undefined, extensions);
				if (
					session.era !== "modern" ||
					!isRecord(result) ||
					result.resultType === undefined ||
					result.resultType === "complete"
				) {
					return result;
				}
				if (result.resultType !== "input_required") {
					throw new McpError(
						"protocol",
						`${method} returned resultType ${serverText(JSON.stringify(result.resultType))}, which this client does not handle`,
					);
				}
				params = await answerInputRequired(method, params, result, round, promptSignal, call);
			}
		} finally {
			activeCalls.delete(call);
		}
	};

	const readResource = async (uri: string, options: McpRequestOptions = {}): Promise<McpResourceRead> => {
		const result = await requestWithRetries("resources/read", { uri }, options);
		const contents = parseResourceRead(result);
		if (contents instanceof McpError) throw contents;
		return {
			contents,
			...(session.era === "modern" && isRecord(result) ? { ttlMs: freshnessOf(result.ttlMs) } : {}),
		};
	};

	const getPrompt = async (
		name: string,
		args: Record<string, string>,
		options: McpRequestOptions = {},
	): Promise<McpPromptResult> => {
		const params = Object.keys(args).length > 0 ? { name, arguments: args } : { name };
		const result = await requestWithRetries("prompts/get", params, options);
		const parsed = parsePromptResult(result);
		if (parsed instanceof McpError) throw parsed;
		return parsed;
	};

	const complete = async (
		ref: McpCompletionReference,
		argument: { name: string; value: string },
		context?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<McpCompletion> => {
		await ensureReady(signal);
		const params = {
			ref,
			argument,
			...(context !== undefined && Object.keys(context).length > 0 ? { context: { arguments: context } } : {}),
		};
		const parsed = parseCompletion(await request("completion/complete", params, requestTimeoutMs, signal));
		if (parsed instanceof McpError) throw parsed;
		return parsed;
	};

	return { listResources, readResource, listPrompts, getPrompt, complete, skills };
}
