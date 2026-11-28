// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Operator input a session accepts besides prompts: steering text, queued
 * messages and queue edits, and shell lines, each bounded for the wire.
 */
import { AcpRequestError } from "./errors.js";
import { boundString, hasControlCharacters, utf8Bytes } from "./server-bounds.js";
import type { AcpQueuedEntry } from "./server-options.js";
import { ACP_MAX_CHUNK_BYTES } from "./types.js";
import type { AcpQueueEntry } from "./types-session.js";

/**
 * Where a steer lands. `interrupt` is deliberately not admitted here: the
 * engine's interrupt mode cancels the run and resubmits the text as a fresh
 * prompt, and ACP binds a turn to the `session/prompt` request/response pair,
 * so that second turn would have no request to carry its stop reason. A client
 * that wants it cancels through `_pancode/session/interrupt` and prompts again.
 */
export const ACP_STEERING_MODES = ["next-slot", "end-of-turn"] as const;
export type AcpSteeringMode = (typeof ACP_STEERING_MODES)[number];

/** Model-facing steer prose. Wider than a label, far under the transport's line bound. */
export const ACP_MAX_STEER_TEXT_BYTES = 16 * 1024;
/** Host-authored context a client may attach to an interrupt, echoed into the cancel reason. */
export const ACP_MAX_INTERRUPT_REASON_BYTES = 256;
/** Queue entries read back in one response; a deeper queue is reported truncated. */
const ACP_MAX_QUEUED_MESSAGES = 64;

/**
 * Steer text is model-facing prose, not an identifier, so newlines and tabs are
 * content and are admitted where {@link requireBoundedClientString} would refuse
 * the whole message. The remaining C0 controls are still refused rather than
 * stripped: a steer the model saw shortened or rewritten would disagree with the
 * text the client sent and with the copy its own UI is showing.
 */
export function requireSteerText(value: unknown, name: string, maxBytes: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AcpRequestError(-32602, `${name} is required`, { code: "invalid_params" });
	}
	if (utf8Bytes(value) > maxBytes || hasControlCharacters(value.replace(/[\n\r\t]/g, " "))) {
		throw new AcpRequestError(-32602, `${name} is invalid`, { code: "invalid_params" });
	}
	return value;
}

/** Bounded read-back of one engine queue, in enqueue order. */
export function boundedQueueTexts(texts: ReadonlyArray<string>): string[] {
	return texts.slice(0, ACP_MAX_QUEUED_MESSAGES).map((text) => boundString(text, ACP_MAX_STEER_TEXT_BYTES));
}

/** queue_clear restores both queues in one list, so its wire bound is twice one queue's. */
export const ACP_MAX_RESTORED_MESSAGES = 2 * ACP_MAX_QUEUED_MESSAGES;

/** Whether a clear's whole restored list fits the wire, every text intact. */
export function restorableWhole(texts: ReadonlyArray<string>): boolean {
	return (
		texts.length <= ACP_MAX_RESTORED_MESSAGES &&
		texts.every((text) => Buffer.byteLength(text, "utf8") <= ACP_MAX_STEER_TEXT_BYTES)
	);
}

/** The queue navigator's per-entry keys: x, e, Shift+Up/Down, t and Enter. */
export const ACP_QUEUE_EDIT_OPS = ["remove", "restore", "move", "set_kind", "send_now"] as const;
export type AcpQueueEditOp = (typeof ACP_QUEUE_EDIT_OPS)[number];
/** Entry ids are minted by the chat loop (`steer_<8 hex>_<n>`); anything wider is not one. */
export const ACP_MAX_QUEUE_ENTRY_ID_BYTES = 128;

type AcpQueueEntryProjection = AcpQueueEntry;

/** The queue in delivery order, each entry as the client addresses it. */
export function projectQueueEntries(entries: ReadonlyArray<AcpQueuedEntry>): AcpQueueEntryProjection[] {
	return entries.slice(0, ACP_MAX_QUEUED_MESSAGES).map((entry) => ({
		id: entry.id,
		kind: entry.kind,
		text: boundString(entry.text, ACP_MAX_STEER_TEXT_BYTES),
		enqueuedAt: entry.enqueuedAt,
		pinned: entry.pinned === true,
	}));
}

/** One editor line's worth of command; the terminal admits no newline in it either. */
export const ACP_MAX_SHELL_COMMAND_BYTES = 16 * 1024;
/** A shell line's output on the wire is its tail; the whole output is in the session entry. */
const ACP_MAX_SHELL_OUTPUT_BYTES = ACP_MAX_CHUNK_BYTES;
const ACP_SHELL_TRUNCATION_PREFIX = "[truncated]…";

/**
 * A shell line is the terminal's `!` operator: one line, run as typed. A
 * newline would make it a script, which the terminal editor never admits, and
 * the other C0 controls are refused rather than stripped so the command that
 * runs is the command the client shows.
 */
export function requireShellCommand(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AcpRequestError(-32602, "command is required", { code: "invalid_params" });
	}
	if (
		utf8Bytes(value) > ACP_MAX_SHELL_COMMAND_BYTES ||
		/[\n\r]/u.test(value) ||
		hasControlCharacters(value.replace(/\t/g, " "))
	) {
		throw new AcpRequestError(-32602, "command is invalid", { code: "invalid_params" });
	}
	return value.trim();
}

/** The last {@link ACP_MAX_SHELL_OUTPUT_BYTES} of a shell line's output, marked at the front when cut. */
export function shellOutputTail(output: string): string {
	if (utf8Bytes(output) <= ACP_MAX_SHELL_OUTPUT_BYTES) return output;
	const budget = ACP_MAX_SHELL_OUTPUT_BYTES - utf8Bytes(ACP_SHELL_TRUNCATION_PREFIX);
	const bytes = Buffer.from(output, "utf8");
	let start = bytes.length - budget;
	// Step forward off UTF-8 continuation bytes so no code point is split.
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return `${ACP_SHELL_TRUNCATION_PREFIX}${bytes.subarray(start).toString("utf8")}`;
}

/**
 * Refusal codes for `_pancode/dispatch/steer`. `DispatchContract.steer` reports
 * every refusal as an operator-facing Error, so the wire gets the classification
 * and the prose goes to the stderr tail: the message legitimately quotes a
 * runtime id and a worker path, and neither belongs in a client's UI.
 */
export function dispatchSteerReason(message: string): string {
	if (message.includes("empty message")) return "empty-message";
	if (message.includes("does not support live steering")) return "steering-unsupported";
	if (message.includes("has no input channel")) return "no-input-channel";
	if (message.includes("no longer accepts input")) return "input-closed";
	if (message.includes("cannot be steered")) return "run-terminating";
	if (message.includes("is not active")) return "run-not-active";
	return "steer-failed";
}
