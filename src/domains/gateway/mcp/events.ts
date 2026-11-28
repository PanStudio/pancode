// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The wire shapes of the MCP Events extension (`io.modelcontextprotocol/events`,
 * SEP-3415, Beta, specification 2026-07-28): what a server advertises, what
 * `events/list`, `events/poll` and the `events/stream` notifications carry, and
 * the error names the extension defines. Everything here is pure; the client
 * sends the requests and the job host decides what an occurrence means.
 */

import { boundedExternalDiagnostic } from "../../../core/external-diagnostic.js";
import { isRecord } from "../../../core/type-guards.js";
import { MCP_EVENTS_EXTENSION, McpError } from "./protocol.js";

export type McpEventDelivery = "poll" | "push" | "webhook";

export interface McpEventDescriptor {
	name: string;
	title: string | null;
	/** Server-written; bounded. */
	description: string;
	/** Non-empty subset of the three modes, in the server's order. */
	delivery: McpEventDelivery[];
	inputSchema: Record<string, unknown>;
	payloadSchema?: Record<string, unknown>;
}

export interface McpEventListing {
	events: McpEventDescriptor[];
	/** True when the server offered more event types than the cap admits. */
	truncated: boolean;
}

/** One occurrence of an event type, as poll results and push notifications carry it. */
export interface McpEventOccurrence {
	eventId: string;
	name: string;
	timestamp: string;
	data: Record<string, unknown>;
	/** Push only: the position after this occurrence. Null when the type does not replay. */
	cursor: string | null;
}

export interface McpEventPollResult {
	events: McpEventOccurrence[];
	/** Null means the type does not replay: never persist it, resubscribe from now. */
	cursor: string | null;
	truncated: boolean;
	hasMore: boolean;
	/** The server's suggested wait, already held at MCP_EVENT_MIN_POLL_MS or more. */
	nextPollMs: number;
}

export interface McpEventRequest {
	name: string;
	arguments: Record<string, unknown>;
	cursor: string | null;
	maxAgeMs?: number;
}

/** Event types accepted from one server before pagination stops. */
export const MCP_EVENT_LIST_CAP = 200;
/** Pages followed before an events/list cursor that never ends is abandoned. */
export const MCP_EVENT_LIST_PAGE_CAP = 50;
/** Occurrences one poll result may carry before the rest are refused as a protocol error. */
const MCP_EVENT_POLL_CAP = 1000;
/** The least wait between two polls, whatever the server suggests (spec ruling: 1000 ms floor). */
const MCP_EVENT_MIN_POLL_MS = 1000;
/** The largest wait between two polls PanCode honours; a huge suggestion cannot stall a job forever. */
const MCP_EVENT_MAX_POLL_MS = 5 * 60_000;
const NAME_BYTES = 256;
const DESCRIPTION_BYTES = 2048;
const EVENT_ID_BYTES = 512;
const CURSOR_BYTES = 4096;

/**
 * The error names the extension defines, and the provisional codes the
 * specification assigns them. A server is matched by code first and by the
 * name in `error.message` second, so a renumbering of the provisional codes
 * still reads right when the server keeps the name.
 */
const MCP_EVENT_ERRORS = {
	InvalidParams: -32602,
	NotFound: -32023,
	Forbidden: -32024,
	ResourceExhausted: -32025,
	Unsupported: -32026,
	CallbackEndpointError: -32027,
} as const;

export type McpEventErrorName = keyof typeof MCP_EVENT_ERRORS;

/** A JSON-RPC error object carried in an McpError's data, a terminated notification, or an error notification. */
export interface McpEventErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export function mcpEventErrorObject(value: unknown): McpEventErrorObject | null {
	const object = value instanceof McpError ? value.data : value;
	if (!isRecord(object) || typeof object.code !== "number" || typeof object.message !== "string") return null;
	return { code: object.code, message: object.message, ...(object.data !== undefined ? { data: object.data } : {}) };
}

/** The extension's name for an error answer, or null for an error it does not define. */
export function mcpEventErrorName(value: unknown): McpEventErrorName | null {
	const error = mcpEventErrorObject(value);
	if (error === null) return null;
	for (const [name, code] of Object.entries(MCP_EVENT_ERRORS)) {
		if (error.code === code) return name as McpEventErrorName;
	}
	const named = error.message.trim();
	return Object.hasOwn(MCP_EVENT_ERRORS, named) ? (named as McpEventErrorName) : null;
}

/** Bounded, one-line text of an extension error for a job reason. */
export function mcpEventErrorText(value: unknown): string {
	const error = mcpEventErrorObject(value);
	if (error === null) {
		const raw = value instanceof Error ? value.message : String(value);
		return boundedExternalDiagnostic(raw.replace(/\s+/g, " "), 512);
	}
	const data = isRecord(error.data) ? error.data : null;
	const detail = data === null ? "" : Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
	return boundedExternalDiagnostic(`${error.message} (code ${error.code})${detail}`.replace(/\s+/g, " "), 512);
}

/**
 * The server's events settings from its `server/discover` capabilities, or
 * null when it does not offer the initial revision of the extension. Settings
 * must be an object with no `revision` field (SEP-3392: an absent `revision`
 * means the initial revision, and an unknown `revision` MUST NOT enable the
 * extension); `true`, an array, any other non-object value, or any `revision`
 * reads as a revision this client does not know. Other unknown members are
 * additive and ignored.
 */
export function mcpEventsOffered(capabilities: Record<string, unknown>): { listChanged: boolean } | null {
	const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : null;
	const settings = extensions === null ? undefined : extensions[MCP_EVENTS_EXTENSION];
	if (!isRecord(settings) || settings.revision !== undefined) return null;
	return { listChanged: settings.listChanged === true };
}

function bounded(text: string, bytes: number): string {
	return boundedExternalDiagnostic(text, bytes);
}

const DELIVERIES: ReadonlySet<string> = new Set(["poll", "push", "webhook"]);

export function parseEventDescriptor(value: unknown): McpEventDescriptor | McpError {
	if (!isRecord(value)) return new McpError("protocol", "events/list entry is not an object");
	if (typeof value.name !== "string" || value.name.length === 0 || Buffer.byteLength(value.name) > NAME_BYTES) {
		return new McpError("protocol", "events/list entry lacks a name of at most 256 bytes");
	}
	if (!Array.isArray(value.delivery) || value.delivery.length === 0) {
		return new McpError("protocol", `events/list entry ${bounded(value.name, NAME_BYTES)} lists no delivery mode`);
	}
	const delivery: McpEventDelivery[] = [];
	for (const mode of value.delivery) {
		// An unknown mode is a later revision's; the ones this client knows still serve.
		if (typeof mode === "string" && DELIVERIES.has(mode) && !delivery.includes(mode as McpEventDelivery)) {
			delivery.push(mode as McpEventDelivery);
		}
	}
	if (!isRecord(value.inputSchema)) {
		return new McpError("protocol", `events/list entry ${bounded(value.name, NAME_BYTES)} lacks an inputSchema object`);
	}
	return {
		name: value.name,
		title: typeof value.title === "string" ? bounded(value.title, NAME_BYTES) : null,
		description: typeof value.description === "string" ? bounded(value.description, DESCRIPTION_BYTES) : "",
		delivery,
		inputSchema: value.inputSchema,
		...(isRecord(value.payloadSchema) ? { payloadSchema: value.payloadSchema } : {}),
	};
}

/** The mode PanCode subscribes with: push when offered, else poll. Webhook needs a reachable URL PanCode never runs. */
export function mcpEventDeliveryMode(descriptor: McpEventDescriptor): "push" | "poll" | null {
	if (descriptor.delivery.includes("push")) return "push";
	if (descriptor.delivery.includes("poll")) return "poll";
	return null;
}

/** An absent cursor reads as null; an over-long one is refused rather than persisted cut. */
export function parseEventCursor(value: unknown, where: string): string | null | McpError {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") return new McpError("protocol", `${where} cursor is not a string or null`);
	if (Buffer.byteLength(value) > CURSOR_BYTES) {
		return new McpError("protocol", `${where} cursor is longer than ${CURSOR_BYTES} bytes`);
	}
	return value;
}

export function parseEventOccurrence(value: unknown, where: string): McpEventOccurrence | McpError {
	if (!isRecord(value)) return new McpError("protocol", `${where} occurrence is not an object`);
	if (typeof value.eventId !== "string" || value.eventId.length === 0) {
		return new McpError("protocol", `${where} occurrence lacks an eventId`);
	}
	if (Buffer.byteLength(value.eventId) > EVENT_ID_BYTES) {
		return new McpError("protocol", `${where} occurrence eventId is longer than ${EVENT_ID_BYTES} bytes`);
	}
	if (typeof value.name !== "string" || value.name.length === 0) {
		return new McpError("protocol", `${where} occurrence lacks a name`);
	}
	if (!isRecord(value.data)) return new McpError("protocol", `${where} occurrence data is not an object`);
	const cursor = parseEventCursor(value.cursor, where);
	if (cursor instanceof McpError) return cursor;
	return {
		eventId: value.eventId,
		name: bounded(value.name, NAME_BYTES),
		timestamp: typeof value.timestamp === "string" ? bounded(value.timestamp, 64) : "",
		data: value.data,
		cursor,
	};
}

export function parseEventPollResult(value: unknown): McpEventPollResult | McpError {
	if (!isRecord(value)) return new McpError("protocol", "events/poll result is not an object");
	if (!Array.isArray(value.events)) return new McpError("protocol", "events/poll result lacks an events array");
	if (value.events.length > MCP_EVENT_POLL_CAP) {
		return new McpError(
			"protocol",
			`events/poll returned ${value.events.length} events; PanCode reads at most ${MCP_EVENT_POLL_CAP}`,
		);
	}
	const events: McpEventOccurrence[] = [];
	for (const entry of value.events) {
		const occurrence = parseEventOccurrence(entry, "events/poll");
		if (occurrence instanceof McpError) return occurrence;
		events.push(occurrence);
	}
	const cursor = parseEventCursor(value.cursor, "events/poll");
	if (cursor instanceof McpError) return cursor;
	const suggested =
		typeof value.nextPollMs === "number" && Number.isFinite(value.nextPollMs) ? Math.floor(value.nextPollMs) : 0;
	return {
		events,
		cursor,
		truncated: value.truncated === true,
		hasMore: value.hasMore === true,
		nextPollMs: Math.min(MCP_EVENT_MAX_POLL_MS, Math.max(MCP_EVENT_MIN_POLL_MS, suggested)),
	};
}
