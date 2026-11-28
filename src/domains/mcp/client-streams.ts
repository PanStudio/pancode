// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Event streams: the long-lived requests of one client. A `subscriptions/listen`
 * stream carries list changes; MCP Events adds `events/list`, `events/poll`
 * and the push `events/stream`. A stream request has no timeout; it ends when
 * the server answers it, cancels it, or goes silent, or when this side cancels.
 */

import { clampTimerDelayMs } from "../../core/timers.js";
import { isRecord } from "../../core/type-guards.js";
import type {
	McpEventStream,
	McpEventStreamHandlers,
	McpEventStreamOptions,
	McpSubscription,
	McpSubscriptionFilter,
} from "./client.js";
import type { McpInitialization } from "./client-init.js";
import { errorMessage, type McpSession, serverText } from "./client-session.js";
import {
	MCP_EVENT_LIST_CAP,
	MCP_EVENT_LIST_PAGE_CAP,
	type McpEventListing,
	type McpEventPollResult,
	type McpEventRequest,
	parseEventDescriptor,
	parseEventPollResult,
} from "./events.js";
import { MCP_EVENTS_EXTENSION, McpError } from "./protocol.js";

export interface McpStreams {
	subscribe(filter: McpSubscriptionFilter, handler: (method: string, params: unknown) => void): McpSubscription;
	listEvents(signal?: AbortSignal): Promise<McpEventListing>;
	pollEvents(req: McpEventRequest & { maxEvents?: number }, signal?: AbortSignal): Promise<McpEventPollResult>;
	streamEvents(
		req: McpEventRequest,
		handlers: McpEventStreamHandlers,
		streamOptions?: McpEventStreamOptions,
	): McpEventStream;
}

/** `ensureReady` is read when a stream opens, after the composer has built initialization. */
export function createMcpStreams(session: McpSession, ready: () => McpInitialization["ensureReady"]): McpStreams {
	const { id, transport, pending, subscriptions, eventStreams, requestTimeoutMs, request, send, eventsOffered } =
		session;
	const ensureReady: McpInitialization["ensureReady"] = (signal) => ready()(signal);

	/**
	 * Open one listen stream. The request has no timeout: it is answered only
	 * when the server ends the stream, and close() or cancel() ends it from
	 * this side with `notifications/cancelled`. Over stdio every stream shares
	 * one pipe, so each notification is routed by the subscription id the
	 * server tags it with, which is the listen request's id.
	 */
	const subscribe = (
		filter: McpSubscriptionFilter,
		handler: (method: string, params: unknown) => void,
	): McpSubscription => {
		let streamId: number | null = null;
		let acknowledge: (honored: Record<string, unknown>) => void = () => {};
		let refuse: (error: McpError) => void = () => {};
		const acknowledged = new Promise<Record<string, unknown>>((resolve, reject) => {
			acknowledge = resolve;
			refuse = reject;
		});
		acknowledged.catch(() => {
			// A caller that never awaits the acknowledgement is not told about an ended stream.
		});
		const controller = new AbortController();
		const listening = request("subscriptions/listen", { notifications: filter }, 0, controller.signal, (assigned) => {
			streamId = assigned;
			subscriptions.set(assigned, { acknowledged: false, acknowledge, handler });
		});
		const ended = listening.then(
			() => {
				refuse(new McpError("server", `mcp server ${id} ended the subscription before acknowledging it`));
			},
			(error: unknown) => {
				refuse(error instanceof McpError ? error : new McpError("protocol", errorMessage(error)));
			},
		);
		void ended.finally(() => {
			if (streamId !== null) subscriptions.delete(streamId);
		});
		return {
			get id() {
				return streamId;
			},
			acknowledged,
			ended: ended.then(() => undefined),
			cancel: () => {
				if (streamId === null || !subscriptions.delete(streamId)) return;
				send({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: streamId, reason: "subscription closed by the client" },
				});
				controller.abort();
			},
		};
	};

	/** The extension's fallback rule: no events/* request goes to a server that did not advertise it. */
	const eventsRefusal = (method: string): McpError | null =>
		eventsOffered() === null
			? new McpError("protocol", `mcp server ${id} does not offer ${MCP_EVENTS_EXTENSION}; PanCode sends it no ${method}`)
			: null;

	/** A modern result PanCode reads only when complete; no events/* method defines another resultType. */
	const completeResult = (method: string, result: unknown): Record<string, unknown> => {
		if (!isRecord(result)) throw new McpError("protocol", `${method} result is not an object`);
		if (result.resultType !== undefined && result.resultType !== "complete") {
			throw new McpError(
				"protocol",
				`${method} returned resultType ${serverText(JSON.stringify(result.resultType))}, which this client does not handle`,
			);
		}
		return result;
	};

	const listEvents = async (signal?: AbortSignal): Promise<McpEventListing> => {
		await ensureReady(signal);
		const refused = eventsRefusal("events/list");
		if (refused !== null) throw refused;
		const events: McpEventListing["events"] = [];
		let cursor: string | undefined;
		for (let pages = 1; ; pages += 1) {
			const result = completeResult(
				"events/list",
				await request("events/list", cursor === undefined ? {} : { cursor }, requestTimeoutMs, signal),
			);
			if (!Array.isArray(result.events)) throw new McpError("protocol", "events/list result lacks an events array");
			for (const entry of result.events) {
				if (events.length >= MCP_EVENT_LIST_CAP) return { events, truncated: true };
				const descriptor = parseEventDescriptor(entry);
				if (descriptor instanceof McpError) throw descriptor;
				if (!events.some((known) => known.name === descriptor.name)) events.push(descriptor);
			}
			const next = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
			if (next === undefined) return { events, truncated: false };
			if (pages >= MCP_EVENT_LIST_PAGE_CAP) return { events, truncated: true };
			cursor = next;
		}
	};

	const eventParams = (req: McpEventRequest): Record<string, unknown> => ({
		name: req.name,
		arguments: req.arguments,
		cursor: req.cursor,
		// maxAgeMs bounds replay from a stored cursor; with a null cursor there is nothing to bound.
		...(req.cursor !== null && req.maxAgeMs !== undefined ? { maxAgeMs: req.maxAgeMs } : {}),
	});

	const pollEvents = async (
		req: McpEventRequest & { maxEvents?: number },
		signal?: AbortSignal,
	): Promise<McpEventPollResult> => {
		await ensureReady(signal);
		const refused = eventsRefusal("events/poll");
		if (refused !== null) throw refused;
		const params = { ...eventParams(req), ...(req.maxEvents !== undefined ? { maxEvents: req.maxEvents } : {}) };
		const result = completeResult("events/poll", await request("events/poll", params, requestTimeoutMs, signal));
		const parsed = parseEventPollResult(result);
		if (parsed instanceof McpError) throw parsed;
		return parsed;
	};

	/**
	 * Open one push subscription. Over stdio every notification of the stream
	 * carries the stream request's id as its subscription id. The request has
	 * no timeout: the server answers it only when the stream ends, and cancel()
	 * ends it from this side with `notifications/cancelled`.
	 */
	const streamEvents = (
		req: McpEventRequest,
		handlers: McpEventStreamHandlers,
		streamOptions: McpEventStreamOptions = {},
	): McpEventStream => {
		let streamId: number | null = null;
		let cancelled = false;
		let watchdog: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		let endCause: McpError | null = null;
		const silenceMs = streamOptions.silenceMs !== undefined ? clampTimerDelayMs(streamOptions.silenceMs) : 0;
		const sendCancel = (requestId: number, reason: string): void => {
			if (transport.endReported() !== null) return;
			send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason } });
		};
		const end = (error: McpError, cancel: boolean): void => {
			if (streamId === null || !eventStreams.delete(streamId)) return;
			if (watchdog !== null) clearTimeout(watchdog);
			endCause = error;
			if (cancel) sendCancel(streamId, error.message);
			pending.get(streamId)?.reject(error);
		};
		const touch = (): void => {
			if (silenceMs <= 0) return;
			if (watchdog !== null) clearTimeout(watchdog);
			watchdog = setTimeout(
				() => end(new McpError("timeout", `events/stream went silent for ${silenceMs}ms`), true),
				silenceMs,
			);
			watchdog.unref?.();
		};
		const ended = (async (): Promise<McpError | null> => {
			await ensureReady(controller.signal);
			const refused = eventsRefusal("events/stream");
			if (refused !== null) throw refused;
			const params = {
				...eventParams(req),
				...(streamOptions.heartbeatMs !== undefined ? { heartbeatMs: streamOptions.heartbeatMs } : {}),
			};
			const result = await request("events/stream", params, 0, controller.signal, (assigned) => {
				streamId = assigned;
				eventStreams.set(assigned, { handlers, touch, end });
				touch();
			});
			completeResult("events/stream", result);
			return null;
		})().then(
			(value) => value,
			(error: unknown) => {
				if (cancelled) return null;
				return endCause ?? (error instanceof McpError ? error : new McpError("protocol", errorMessage(error)));
			},
		);
		void ended.finally(() => {
			if (watchdog !== null) clearTimeout(watchdog);
			if (streamId !== null) eventStreams.delete(streamId);
		});
		return {
			get id() {
				return streamId;
			},
			ended,
			cancel: () => {
				if (cancelled) return;
				cancelled = true;
				if (watchdog !== null) clearTimeout(watchdog);
				if (streamId !== null && eventStreams.delete(streamId)) sendCancel(streamId, "subscription closed by the client");
				controller.abort();
			},
		};
	};

	return { subscribe, listEvents, pollEvents, streamEvents };
}
