// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Byte bounds and safe-string helpers shared by every ACP server module.
 * Each one caps or refuses client and stored text before it crosses the wire.
 */

import { isRecord } from "../../core/type-guards.js";
import { WIRE_TRUNCATION_SUFFIX as ACP_TRUNCATION_SUFFIX } from "../../core/views/diff-rows.js";
import { redactCommandOutputSecrets } from "../../domains/evidence/redact.js";
import { redactSecretString, redactToolArgs, redactUrlCredentials } from "../../domains/safety/redaction.js";
import { AcpRequestError } from "./errors.js";
import { ACP_MAX_RAW_DIFF_BYTES, ACP_MAX_RAW_RECORD_BYTES, ACP_MAX_STRING_BYTES } from "./types.js";

const ACP_TRUNCATION_SUFFIX_BYTES = Buffer.byteLength(ACP_TRUNCATION_SUFFIX, "utf8");

/** Depth past which `boundRawRecord` stops walking and elides the subtree. */
const ACP_MAX_RAW_RECORD_DEPTH = 8;

/**
 * The longest prefix of `value` that fits `maxBytes` UTF-8 bytes without
 * splitting a code point. `Buffer.write` stops before a partial sequence, so a
 * surrogate pair is either wholly inside the prefix or wholly outside it and no
 * cut can produce a lone surrogate the peer decodes as a replacement character.
 */
function sliceToBytes(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const buffer = Buffer.allocUnsafe(maxBytes);
	const written = buffer.write(value, 0, maxBytes, "utf8");
	return buffer.toString("utf8", 0, written);
}

/** Bounds one string to `maxBytes` UTF-8 bytes, marker included in the budget. */
export function boundString(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	// The marker is part of what goes on the wire, so it is reserved inside the
	// cap rather than appended past it.
	const budget = maxBytes - ACP_TRUNCATION_SUFFIX_BYTES;
	if (budget <= 0) return sliceToBytes(value, maxBytes);
	return `${sliceToBytes(value, budget)}${ACP_TRUNCATION_SUFFIX}`;
}

/**
 * Splits one delta into wire-sized chunks. Nothing is dropped and no code point
 * is split: the pieces concatenate back to the input, so a client that appends
 * chunks in order reconstructs the model's text exactly.
 */
export function chunkText(text: string, maxBytes: number): string[] {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > 0) {
		const chunk = sliceToBytes(rest, maxBytes);
		// One code point wider than the whole bound cannot be split further, so it
		// travels oversized rather than being dropped or mangled.
		if (chunk.length === 0) {
			chunks.push(rest);
			break;
		}
		chunks.push(chunk);
		rest = rest.slice(chunk.length);
	}
	return chunks;
}

/**
 * The string cap for the value sitting at `key` inside a record sitting at
 * `parentKey`. Everything gets {@link ACP_MAX_STRING_BYTES}; the single
 * exception is the rendered diff an `edit` or `write` result carries, which the
 * engine has already capped for exactly this purpose. The match is on the whole
 * two-segment path and not on the key alone, so a tool that happens to report a
 * top-level `diff` string does not widen itself into the exception.
 */
function rawStringBytes(key: string | undefined, parentKey: string | undefined): number {
	return key === "diff" && parentKey === "details" ? ACP_MAX_RAW_DIFF_BYTES : ACP_MAX_STRING_BYTES;
}

function boundRawValue(
	value: unknown,
	depth: number,
	key?: string,
	parentKey?: string,
	scrub: (text: string) => string = redactUrlCredentials,
): unknown {
	// Redacted ahead of its bound, which could otherwise cut a password into a piece no pattern recognizes (#446).
	if (typeof value === "string") return boundString(scrub(value), rawStringBytes(key, parentKey));
	if (Array.isArray(value)) {
		if (depth >= ACP_MAX_RAW_RECORD_DEPTH) return "[depth]";
		// A member inherits no path: `details.diff` names one string, not a list
		// of them, and a thousand-entry array of wide strings is the payload the
		// record cap exists to stop.
		return value.map((entry) => boundRawValue(entry, depth + 1, undefined, undefined, scrub));
	}
	if (isRecord(value)) {
		if (depth >= ACP_MAX_RAW_RECORD_DEPTH) return "[depth]";
		const bounded: Record<string, unknown> = {};
		for (const [entryKey, entry] of Object.entries(value)) {
			bounded[redactUrlCredentials(entryKey)] = boundRawValue(entry, depth + 1, entryKey, key, scrub);
		}
		return bounded;
	}
	return value;
}

/**
 * The record's serialized UTF-8 size before any bounding, or null when it does
 * not serialize at all (a cycle, a BigInt, a throwing `toJSON`). This is the
 * figure `{truncated:true,bytes}` reports: the size a client is told about is
 * the payload the engine actually produced, not the size of the shortened copy
 * this process built and then decided not to send.
 */
function originalRawRecordBytes(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
	} catch {
		return null;
	}
}

/**
 * Bounds one `rawInput`/`rawOutput` record for the wire (CONTRACT C001 §3).
 * Strings are capped first, then the whole record: a payload that is still over
 * the record cap after per-string bounding is thousands of small fields, and
 * the honest thing to send is the fact that it was elided plus its size.
 */
export function boundRawRecord(
	value: unknown,
	scrub: (text: string) => string = redactUrlCredentials,
): Record<string, unknown> {
	const bounded = isRecord(value)
		? (boundRawValue(value, 0, undefined, undefined, scrub) as Record<string, unknown>)
		: {};
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(bounded);
	} catch {
		serialized = undefined;
	}
	// Nothing about this record can be measured, so the elision carries whatever
	// size the original could still report and 0 when it could not report one.
	if (serialized === undefined) return { truncated: true, bytes: originalRawRecordBytes(value) ?? 0 };
	const boundedBytes = Buffer.byteLength(serialized, "utf8");
	if (boundedBytes <= ACP_MAX_RAW_RECORD_BYTES) return bounded;
	// The bounded size is the fallback: an unserializable original has no size of
	// its own, and reporting the copy's is closer than reporting nothing.
	return { truncated: true, bytes: originalRawRecordBytes(value) ?? boundedBytes };
}

/** The title's scrub for one string: the call's own credentials, in any shape the title would hide (M-53). */
export function redactCallText(value: string): string {
	return redactCommandOutputSecrets(redactSecretString(value));
}

/**
 * A call's `rawInput`, projected for display as the title is: a secret-named argument or environment block blanked and
 * every string scrubbed with the title's rule before its bound. The `tool_call` card and the permission ask send this one
 * record, so a credential the title hides never rides beside it (M-53). Execution keeps the original arguments.
 */
export function boundRawInput(args: unknown): Record<string, unknown> {
	return boundRawRecord(redactToolArgs(args), redactCallText);
}

export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
	}
	return false;
}

export function requireBoundedClientString(
	value: unknown,
	name: string,
	maxBytes: number,
	options: { allowEmpty?: boolean } = {},
): string {
	if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
		throw new AcpRequestError(-32602, `${name} is required`, { code: "invalid_params" });
	}
	if (utf8Bytes(value) > maxBytes || hasControlCharacters(value)) {
		throw new AcpRequestError(-32602, `${name} is invalid`, { code: "invalid_params" });
	}
	return value;
}

export function safeStoredString(value: unknown, maxBytes: number, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	let safe = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		safe += codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
	}
	// Everything stored that reaches a client passes here, and redacted ahead of its bound, which could cut a password's scheme off (#446).
	return boundString(redactUrlCredentials(safe), maxBytes);
}

export function safeStoredIdentifier(value: unknown, maxBytes: number): string | null {
	if (typeof value !== "string" || value.length === 0 || hasControlCharacters(value) || utf8Bytes(value) > maxBytes) {
		return null;
	}
	return value;
}

/**
 * A selected route cannot be represented as null merely to satisfy the wire
 * bound: null means genuinely unselected in W001. Refuse the affected method
 * instead, with the fixed internal-error envelope, until the operator repairs
 * the local configuration.
 */
export function safeConfiguredIdentifier(value: unknown, maxBytes: number): string | null {
	if (value === null || value === undefined) return null;
	const safe = safeStoredIdentifier(value, maxBytes);
	if (safe === null) {
		throw new AcpRequestError(-32603, "configured route cannot be represented safely", { code: "internal_error" });
	}
	return safe;
}

export function safeIso(value: unknown): string {
	if (typeof value === "string" && !hasControlCharacters(value)) {
		const timestamp = Date.parse(value);
		if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	}
	return new Date(0).toISOString();
}
