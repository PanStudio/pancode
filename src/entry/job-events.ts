// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The job host's MCP Events subscriptions (`io.modelcontextprotocol/events`,
 * specification 2026-07-28). An active mcp_event job this host owns holds one
 * poll loop or push stream; each new occurrence is deduplicated, checked,
 * neutralized and buffered, and wakes the job, whose next start drains the
 * buffer. Pause, stop, navigation and host close cancel the subscription.
 */

import type { JobRecord, JobRunner } from "../core/job-types.js";
import { neutralizeFraming, neutralizeFramingValue } from "../core/reminder-framing.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import {
	type McpClient,
	type McpEventDescriptor,
	type McpEventOccurrence,
	mcpEventDeliveryMode,
	mcpEventErrorName,
	mcpEventErrorText,
	outputSchemaMismatch,
} from "../domains/gateway/mcp/index.js";
import {
	JOB_EVENT_IDS_LIMIT,
	JOB_JSON_BYTES,
	type JobRunResult,
	matchesJobPredicate,
	projectJobPredicate,
} from "../domains/scheduling/index.js";
import type { McpCapabilitySource } from "../tools/gateway/mcp-capability-types.js";

type EventRunner = Extract<JobRunner, { kind: "mcp_event" }>;

/** Arrivals one job buffers between starts; older ones are dropped and counted. */
const BUFFER_LIMIT = 64;
/** Occurrences one poll asks for. */
const POLL_BATCH = 100;
/** A cursor that only moved is written at most this often; a start writes it at once. */
const CURSOR_WRITE_MS = 10_000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 300_000;
/** Bytes of one occurrence's recorded envelope kept whole; larger payloads project only what until reads. */
const DATA_BYTES = 8192;
const SUMMARY_DATA_CHARS = 600;

export interface JobEventArrival {
	eventId: string;
	timestamp: string;
	data: Record<string, unknown>;
}

export interface JobEventFailure {
	errorClass: "permission" | "execution" | "infrastructure";
	/** The extension's error name, when the server answered with one. */
	error: string | null;
	summary: string;
}

/** What one start takes from a subscription. */
export interface JobEventDrain {
	arrivals: JobEventArrival[];
	/** The server reported occurrences it could not replay, or this host dropped some. */
	gap: boolean;
	dropped: number;
	/** Occurrences whose data did not match the event's payloadSchema. */
	rejected: number;
	failure: JobEventFailure | null;
	/** The subscription works again after a failure it reported. */
	recovered: boolean;
	cursor: string | null;
	eventIds: string[];
}

export interface JobEventHubDeps {
	source(): McpCapabilitySource | null;
	wake(id: string): void;
	recordCursor(id: string, cursor: string): void;
	notice(text: string): void;
	random?: () => number;
}

export interface JobEventHub {
	/** Open, keep or cancel a job's subscription; `live` is whether this host owns the job and it is active. */
	reconcile(job: JobRecord, live: boolean): void;
	drain(id: string): JobEventDrain | null;
	close(): void;
}

interface Subscription {
	id: string;
	runner: EventRunner;
	generation: number;
	abort: AbortController;
	cursor: string | null;
	cursorWrittenAt: number;
	seen: string[];
	seenSet: Set<string>;
	buffer: JobEventArrival[];
	gap: boolean;
	dropped: number;
	rejected: number;
	failure: JobEventFailure | null;
	reported: boolean;
	recovered: boolean;
	/** The current attempt reached the server: a poll answered or the stream went active. */
	working: boolean;
	chain: Promise<void>;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		timer.unref?.();
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

/**
 * Whether a job may subscribe to its event: on create and resume the server is
 * declared, trusted, approved and offers the event by poll or push, the
 * arguments match the event's inputSchema, and the task's tool scope admits the
 * server; on run (draining buffered arrivals or subscription failures) only
 * authority and scope are rechecked so a server outage or event removal settles
 * through the job's own failure lifecycle instead of pausing admission.
 */
export async function mcpEventJobRefusal(
	source: McpCapabilitySource | null,
	runner: EventRunner,
	constraints: TurnConstraints | undefined,
	signal?: AbortSignal,
	phase: "create" | "resume" | "run" = "create",
): Promise<string | null> {
	if (source === null) return "This host has no MCP gateway, so an mcp_event job has no server to subscribe to.";
	const allowed = constraints?.allowedTools;
	if (allowed !== undefined && !allowed.some((name) => source.ownerIdOf(name) === runner.server))
		return `MCP server '${runner.server}' is outside the creating or current task's admitted tool scope.`;
	const launch = {
		...(signal === undefined ? {} : { signal }),
		...(constraints?.readOnly === true ? { readOnly: true } : {}),
	};
	if (phase === "run") {
		const refusal = source.eventAuthorityRefusal?.(runner.server, launch) ?? null;
		return refusal === null ? null : neutralizeFraming(refusal);
	}
	const server = await source.eventServer(runner.server, launch);
	if ("refusal" in server) return neutralizeFraming(server.refusal);
	const descriptor = server.events.find((event) => event.name === runner.event);
	if (descriptor === undefined) {
		const names = server.events.slice(0, 20).map((event) => event.name);
		return neutralizeFraming(
			`MCP server '${runner.server}' lists no event type '${runner.event}'${names.length > 0 ? `; it lists: ${names.join(", ")}` : ""}`,
		);
	}
	if (mcpEventDeliveryMode(descriptor) === null)
		return descriptor.delivery.includes("webhook")
			? `Event '${runner.event}' on MCP server '${runner.server}' is delivered only by webhook, which PanCode does not receive.`
			: `Event '${runner.event}' on MCP server '${runner.server}' does not offer poll or push delivery.`;
	const mismatch = await outputSchemaMismatch(descriptor.inputSchema, runner.arguments, undefined, {
		value: "arguments",
		schema: "inputSchema",
	});
	return mismatch === null ? null : neutralizeFraming(`Event '${runner.event}': ${mismatch}`);
}

/** One start's result from the arrivals it drained, read the way the controller reads it. */
export function jobEventRunResult(job: JobRecord, drained: JobEventDrain | null): JobRunResult {
	const runner = job.spec.runner as EventRunner;
	const where = `event '${runner.event}' from MCP server '${runner.server}'`;
	if (drained === null) return { outcome: "noop", summary: `No subscription to ${where} is open.`, costUsd: 0 };
	const persisted = {
		...(drained.cursor !== null ? { eventCursor: drained.cursor } : {}),
		eventIds: drained.eventIds,
	};
	const failure = drained.failure;
	const until = job.spec.until;
	const matching =
		drained.arrivals.length === 0
			? -1
			: until === null
				? 0
				: drained.arrivals.findIndex((arrival) => matchesJobPredicate(until, arrival.data));
	// A matching arrival delivered before stream termination still satisfies the wait; otherwise a permanent refusal ends the job.
	if (matching === -1 && failure !== null && failure.errorClass !== "infrastructure")
		return {
			outcome: "failed",
			summary: failure.summary,
			json: { subscription: "failed", server: runner.server, event: runner.event, error: failure.error },
			jsonComplete: true,
			errorClass: failure.errorClass,
			costUsd: 0,
			...persisted,
		};
	const notes = [
		...(drained.gap ? ["the server reported a gap, so occurrences may have been missed"] : []),
		...(drained.dropped > 0 ? [`${drained.dropped} older arrivals were dropped from a full buffer`] : []),
		...(drained.rejected > 0 ? [`${drained.rejected} arrivals did not match the event's payloadSchema`] : []),
	];
	const noteText = notes.length > 0 ? ` (${notes.join("; ")})` : "";
	if (drained.arrivals.length === 0) {
		if (failure !== null)
			return { outcome: "failed", summary: failure.summary, errorClass: "infrastructure", costUsd: 0, ...persisted };
		return {
			outcome: "noop",
			summary: `${drained.recovered ? `The subscription to ${where} works again` : `No new arrival of ${where}`}${noteText}.`,
			costUsd: 0,
			...persisted,
		};
	}
	const chosen = drained.arrivals[matching === -1 ? drained.arrivals.length - 1 : matching] as JobEventArrival;
	const encoded = JSON.stringify(chosen.data);
	const baseJson = {
		server: runner.server,
		event: runner.event,
		eventId: chosen.eventId,
		timestamp: chosen.timestamp,
		arrivals: drained.arrivals.length,
		...(drained.gap ? { gap: true } : {}),
		...(drained.dropped > 0 ? { dropped: drained.dropped } : {}),
		...(drained.rejected > 0 ? { rejected: drained.rejected } : {}),
	};
	const fullJson = { ...baseJson, data: chosen.data };
	let json: Record<string, unknown> = fullJson;
	if (Buffer.byteLength(JSON.stringify(fullJson)) > Math.min(DATA_BYTES, JOB_JSON_BYTES)) {
		const projected = until === null ? {} : projectJobPredicate(until, chosen.data);
		const compact = { ...baseJson, data: projected, dataTruncated: true };
		if (Buffer.byteLength(JSON.stringify(compact)) <= JOB_JSON_BYTES) {
			json = compact;
		} else {
			const minimal =
				until !== null && matching !== -1
					? until.path.reduceRight<unknown>((inner, segment) => ({ [segment]: inner }), until.op === "eq" ? until.value : {})
					: {};
			json = { ...baseJson, data: minimal, dataTruncated: true };
		}
	}
	const shown = encoded.length > SUMMARY_DATA_CHARS ? `${encoded.slice(0, SUMMARY_DATA_CHARS)}…` : encoded;
	const count = drained.arrivals.length === 1 ? "1 arrival" : `${drained.arrivals.length} arrivals`;
	const verdict = until === null ? "" : matching === -1 ? "; until not met by any" : "; until met";
	return {
		outcome: "succeeded",
		summary: `${count} of ${where}${verdict}${noteText}. eventId ${chosen.eventId} at ${chosen.timestamp}: ${shown}`,
		json,
		jsonComplete: true,
		costUsd: 0,
		...persisted,
	};
}

export function createJobEventHub(deps: JobEventHubDeps): JobEventHub {
	const random = deps.random ?? Math.random;
	const subscriptions = new Map<string, Subscription>();
	let closed = false;

	const jitter = (ms: number): number => Math.round(ms * (0.75 + random() * 0.5));
	const backoff = (attempt: number): number =>
		jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempt - 1)));
	const live = (sub: Subscription): boolean => !closed && !sub.abort.signal.aborted && subscriptions.get(sub.id) === sub;
	const wake = (sub: Subscription): void => {
		if (!live(sub)) return;
		try {
			deps.wake(sub.id);
		} catch (error) {
			deps.notice(`job ${sub.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const enqueue = (sub: Subscription, step: () => Promise<void> | void): void => {
		sub.chain = sub.chain.then(step).catch((error: unknown) => {
			deps.notice(`job ${sub.id}: ${error instanceof Error ? error.message : String(error)}`);
		});
	};
	const setCursor = (sub: Subscription, cursor: string | null): void => {
		// A null cursor means the type does not replay; it is never persisted, and a resubscribe starts from now.
		sub.cursor = cursor;
		if (cursor === null || sub.buffer.length > 0 || !live(sub)) return;
		if (Date.now() - sub.cursorWrittenAt < CURSOR_WRITE_MS) return;
		sub.cursorWrittenAt = Date.now();
		try {
			deps.recordCursor(sub.id, cursor);
		} catch (error) {
			deps.notice(`job ${sub.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const markGap = (sub: Subscription): void => {
		if (!sub.gap)
			deps.notice(
				`job ${sub.id}: MCP server '${sub.runner.server}' reported a gap in event '${sub.runner.event}'; occurrences may have been missed.`,
			);
		sub.gap = true;
	};
	const accept = async (
		sub: Subscription,
		occurrence: McpEventOccurrence,
		descriptor: McpEventDescriptor,
	): Promise<void> => {
		if (!live(sub) || occurrence.name !== sub.runner.event || sub.seenSet.has(occurrence.eventId)) return;
		if (descriptor.payloadSchema !== undefined) {
			const mismatch = await outputSchemaMismatch(descriptor.payloadSchema, occurrence.data, undefined, {
				value: "data",
				schema: "payloadSchema",
			});
			if (!live(sub)) return;
			if (mismatch !== null) {
				sub.rejected += 1;
				return;
			}
		}
		if (sub.seenSet.has(occurrence.eventId)) return;
		sub.seen.push(occurrence.eventId);
		sub.seenSet.add(occurrence.eventId);
		while (sub.seen.length > JOB_EVENT_IDS_LIMIT) sub.seenSet.delete(sub.seen.shift() as string);
		sub.buffer.push({
			eventId: neutralizeFraming(occurrence.eventId),
			timestamp: neutralizeFraming(occurrence.timestamp),
			data: neutralizeFramingValue(occurrence.data) as Record<string, unknown>,
		});
		if (sub.buffer.length > BUFFER_LIMIT) {
			sub.buffer.splice(0, sub.buffer.length - BUFFER_LIMIT);
			sub.dropped += 1;
			sub.gap = true;
		}
		wake(sub);
	};
	const healthy = (sub: Subscription): void => {
		sub.working = true;
		if (!sub.reported) return;
		sub.reported = false;
		sub.recovered = true;
		sub.failure = null;
		wake(sub);
	};
	const fail = (sub: Subscription, failure: JobEventFailure): void => {
		if (!live(sub)) return;
		sub.failure = failure;
		if (failure.errorClass === "infrastructure") sub.reported = true;
		wake(sub);
	};

	const poll = async (sub: Subscription, client: McpClient, descriptor: McpEventDescriptor): Promise<void> => {
		const signal = sub.abort.signal;
		while (live(sub)) {
			const result = await client.pollEvents(
				{ name: sub.runner.event, arguments: { ...sub.runner.arguments }, cursor: sub.cursor, maxEvents: POLL_BATCH },
				signal,
			);
			if (!live(sub)) return;
			healthy(sub);
			// Non-replayable types always carry cursor: null; there is no position to have advanced past (SEP-3415).
			if (result.truncated && result.cursor !== null) markGap(sub);
			for (const occurrence of result.events) enqueue(sub, () => accept(sub, occurrence, descriptor));
			enqueue(sub, () => setCursor(sub, result.cursor));
			await sub.chain;
			if (!result.hasMore) await sleep(result.nextPollMs, signal);
		}
	};
	const push = async (sub: Subscription, client: McpClient, descriptor: McpEventDescriptor): Promise<void> => {
		const stream = client.streamEvents(
			{ name: sub.runner.event, arguments: { ...sub.runner.arguments }, cursor: sub.cursor },
			{
				onActive(cursor, truncated) {
					healthy(sub);
					// Non-replayable types always carry cursor: null; there is no position to have advanced past (SEP-3415).
					if (truncated && cursor !== null) markGap(sub);
					enqueue(sub, () => setCursor(sub, cursor));
				},
				onEvent(occurrence) {
					enqueue(sub, async () => {
						await accept(sub, occurrence, descriptor);
						setCursor(sub, occurrence.cursor);
					});
				},
				onHeartbeat(cursor) {
					enqueue(sub, () => setCursor(sub, cursor));
				},
				onError(error) {
					// A transient error leaves the stream open; the server keeps delivering.
					deps.notice(
						`job ${sub.id}: MCP server '${sub.runner.server}' reported a transient event error: ${neutralizeFraming(mcpEventErrorText(error))}`,
					);
				},
			},
		);
		const onAbort = (): void => stream.cancel();
		sub.abort.signal.addEventListener("abort", onAbort, { once: true });
		try {
			const ended = await stream.ended;
			await sub.chain;
			if (ended !== null) throw ended;
		} finally {
			sub.abort.signal.removeEventListener("abort", onAbort);
		}
	};

	const subscribe = async (sub: Subscription): Promise<void> => {
		const { server: serverId, event } = sub.runner;
		const signal = sub.abort.signal;
		let failures = 0;
		let exhausted = 0;
		let relisted = false;
		let delay = 0;
		while (live(sub)) {
			if (delay > 0) await sleep(delay, signal);
			if (!live(sub)) return;
			const source = deps.source();
			if (source === null) {
				fail(sub, { errorClass: "infrastructure", error: null, summary: "This host has no MCP gateway." });
				delay = backoff(++failures);
				continue;
			}
			const server = await source.eventServer(serverId, { signal });
			if (!live(sub)) return;
			if ("refusal" in server) {
				fail(sub, { errorClass: "infrastructure", error: null, summary: neutralizeFraming(server.refusal) });
				delay = backoff(++failures);
				continue;
			}
			const descriptor = server.events.find((entry) => entry.name === event);
			const mode = descriptor === undefined ? null : mcpEventDeliveryMode(descriptor);
			if (descriptor === undefined || mode === null) {
				fail(sub, {
					errorClass: "execution",
					error: "NotFound",
					summary: `MCP server '${serverId}' no longer lists event '${event}' with poll or push delivery.`,
				});
				return;
			}
			sub.working = false;
			try {
				if (mode === "push") await push(sub, server.client, descriptor);
				else await poll(sub, server.client, descriptor);
				if (!live(sub)) return;
				// The server closed the stream with its empty result; the job still wants the subscription.
				throw new Error("the server closed the event stream");
			} catch (error) {
				if (!live(sub)) return;
				const name = mcpEventErrorName(error);
				const text = neutralizeFraming(mcpEventErrorText(error));
				if (name === "Unsupported" && !relisted) {
					// The event's schema changed: list the types again and resubscribe once.
					relisted = true;
					await source.refresh(serverId, { signal }).catch(() => undefined);
					delay = 0;
					continue;
				}
				if (name === "NotFound" || name === "Unsupported" || name === "InvalidParams" || name === "Forbidden") {
					const what =
						name === "NotFound"
							? `MCP server '${serverId}' does not know event '${event}'`
							: name === "Forbidden"
								? `MCP server '${serverId}' forbids this subscription to event '${event}'`
								: name === "InvalidParams"
									? `MCP server '${serverId}' refused the arguments of event '${event}'`
									: `MCP server '${serverId}' no longer supports this subscription to event '${event}'`;
					fail(sub, {
						errorClass: name === "Forbidden" ? "permission" : "execution",
						error: name,
						summary: `${what}: ${text}`,
					});
					return;
				}
				if (name === "ResourceExhausted") {
					// The server is overloaded, which a later attempt can clear; the job does not fail.
					delay = backoff(++exhausted);
					continue;
				}
				exhausted = 0;
				if (sub.working) {
					// A working subscription ended (the server exited or closed the stream): resubscribe from the cursor.
					failures = 0;
					relisted = false;
					delay = jitter(RECONNECT_MIN_MS);
					continue;
				}
				fail(sub, { errorClass: "infrastructure", error: name, summary: `Event '${event}' on '${serverId}': ${text}` });
				delay = backoff(++failures);
			}
		}
	};

	const stop = (id: string): void => {
		const sub = subscriptions.get(id);
		if (sub === undefined) return;
		subscriptions.delete(id);
		sub.abort.abort(new Error("job subscription closed"));
	};

	return {
		reconcile(job, ownedActive) {
			const runner = job.spec.runner;
			if (closed || !ownedActive || runner.kind !== "mcp_event" || job.state !== "active") {
				stop(job.id);
				return;
			}
			const existing = subscriptions.get(job.id);
			if (existing !== undefined && existing.generation === job.generation) return;
			stop(job.id);
			const seen = (job.eventIds ?? []).slice(-JOB_EVENT_IDS_LIMIT);
			const sub: Subscription = {
				id: job.id,
				runner,
				generation: job.generation,
				abort: new AbortController(),
				cursor: typeof job.eventCursor === "string" ? job.eventCursor : null,
				cursorWrittenAt: 0,
				seen,
				seenSet: new Set(seen),
				buffer: [],
				gap: false,
				dropped: 0,
				rejected: 0,
				failure: null,
				reported: false,
				recovered: false,
				working: false,
				chain: Promise.resolve(),
			};
			subscriptions.set(job.id, sub);
			void subscribe(sub).catch((error: unknown) => {
				fail(sub, {
					errorClass: "infrastructure",
					error: null,
					summary: neutralizeFraming(error instanceof Error ? error.message : String(error)),
				});
			});
		},
		drain(id) {
			const sub = subscriptions.get(id);
			if (sub === undefined) return null;
			const drained: JobEventDrain = {
				arrivals: sub.buffer.splice(0),
				gap: sub.gap,
				dropped: sub.dropped,
				rejected: sub.rejected,
				failure: sub.failure,
				recovered: sub.recovered,
				cursor: sub.cursor,
				eventIds: [...sub.seen],
			};
			sub.gap = false;
			sub.dropped = 0;
			sub.rejected = 0;
			sub.recovered = false;
			if (sub.failure?.errorClass === "infrastructure") sub.failure = null;
			sub.cursorWrittenAt = Date.now();
			return drained;
		},
		close() {
			closed = true;
			for (const id of [...subscriptions.keys()]) stop(id);
		},
	};
}
