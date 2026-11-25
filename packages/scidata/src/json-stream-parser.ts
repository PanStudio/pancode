// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { DataRefusalError, MAX_NUMBER_LITERAL_CHARS, refusal } from "./shared.js";

export type JsonValueType = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonScalarEvent {
	type: "string" | "number" | "boolean" | "null";
	/** Parsed value; a string that was not captured is "" with `captured: false`. */
	value: string | number | boolean | null;
	/** Source text for numbers; null otherwise. */
	literal: string | null;
	/** False when the string content was skipped because no consumer needed it. */
	captured: boolean;
	/** Decoded length for strings (even when not captured), 0 otherwise. */
	length: number;
	/** True when a captured string or literal was cut at its capture cap. */
	truncated: boolean;
}

/**
 * The event consumer. `depth` is the nesting level of the value the event
 * belongs to: the root value is depth 0, its members and elements depth 1.
 * Each callback may return false to stop the parse after that event; the
 * parser then reports `stopped: true` and reads nothing further.
 */
export interface JsonEventSink {
	onStartObject(depth: number): boolean | undefined;
	onKey(key: string, depth: number, truncated: boolean): boolean | undefined;
	onEndObject(depth: number, memberCount: number): boolean | undefined;
	onStartArray(depth: number): boolean | undefined;
	onEndArray(depth: number, length: number): boolean | undefined;
	onScalar(scalar: JsonScalarEvent, depth: number): boolean | undefined;
	/** Consulted at the start of each string value: capture its content or only measure it. */
	captureStrings(depth: number): boolean;
}

export const JSON_MAX_DEPTH = 1024;
const KEY_CAPTURE_CAP = 1024;
export const STRING_CAPTURE_CAP = 65_536;

enum TokenState {
	None = 0,
	String = 1,
	Number = 2,
	Literal = 3,
}

enum Expect {
	Value = 0,
	KeyOrEnd = 1,
	Key = 2,
	Colon = 3,
	CommaOrEnd = 4,
	ValueOrEnd = 5,
	End = 6,
}

interface Container {
	kind: "object" | "array";
	count: number;
	expect: Expect;
}

const CHAR_QUOTE = 0x22;
const CHAR_BACKSLASH = 0x5c;
const CHAR_LF = 0x0a;

function escapeChar(code: number): string | null {
	switch (code) {
		case CHAR_QUOTE:
			return '"';
		case CHAR_BACKSLASH:
			return "\\";
		case 0x2f:
			return "/";
		case 0x62:
			return "\b";
		case 0x66:
			return "\f";
		case 0x6e:
			return "\n";
		case 0x72:
			return "\r";
		case 0x74:
			return "\t";
		default:
			return null;
	}
}

function isWhitespace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === CHAR_LF || code === 0x0d;
}

function isNumberChar(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x2b || code === 0x2e || code === 0x45 || code === 0x65
	);
}

const NUMBER_GRAMMAR = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * Incremental JSON parser. Feed decoded text with `push`, finish with `end`.
 * Syntax errors throw an `invalid-json` refusal carrying line, column, and
 * byte offset; nesting past JSON_MAX_DEPTH throws `nesting-too-deep`.
 */
export class JsonStreamParser {
	private readonly stack: Container[] = [];
	private expect = Expect.Value;
	private tokenState = TokenState.None;
	private token = "";
	private tokenTruncated = false;
	private stringCapture = false;
	private stringLength = 0;
	private stringIsKey = false;
	private escape = false;
	private unicodeHex: string | null = null;
	private line = 1;
	private column = 0;
	private chunkText = "";
	private chunkByteOffset = 0;
	private chunkIndex = 0;
	private stopped = false;
	private rootComplete = false;
	/** Depth of the deepest container opened so far (root object or array is 0). */
	maxDepth = 0;

	constructor(private readonly sink: JsonEventSink) {}

	get isStopped(): boolean {
		return this.stopped;
	}

	get depth(): number {
		return this.stack.length;
	}

	/** Feed one chunk. Returns false once a sink asked to stop; further pushes are ignored. */
	push(text: string, byteOffset = 0): boolean {
		if (this.stopped) return false;
		this.chunkText = text;
		this.chunkByteOffset = byteOffset;
		const length = text.length;
		let index = 0;
		while (index < length) {
			this.chunkIndex = index;
			const code = text.charCodeAt(index);
			if (code === CHAR_LF) {
				this.line += 1;
				this.column = 0;
			} else {
				this.column += 1;
			}
			switch (this.tokenState) {
				case TokenState.String:
					index = this.scanString(text, index, length);
					break;
				case TokenState.Number:
					if (isNumberChar(code)) {
						this.appendNumberChar(text[index] as string);
						index += 1;
					} else {
						// The terminator belongs to the next token; undo its position bookkeeping.
						this.column -= 1;
						if (code === CHAR_LF) {
							this.line -= 1;
							this.column = 0;
						}
						this.completeNumber();
						this.tokenState = TokenState.None;
					}
					break;
				case TokenState.Literal:
					if (code >= 0x61 && code <= 0x7a) {
						this.token += text[index] as string;
						index += 1;
						if (this.token.length >= 5) this.completeLiteral();
					} else {
						this.column -= 1;
						if (code === CHAR_LF) {
							this.line -= 1;
							this.column = 0;
						}
						this.completeLiteral();
					}
					break;
				default:
					index = this.scanStructural(text, index, code);
					break;
			}
			if (this.stopped) return false;
		}
		return true;
	}

	end(): void {
		if (this.stopped) return;
		this.chunkIndex = this.chunkText.length;
		if (this.tokenState === TokenState.Number) {
			this.completeNumber();
			this.tokenState = TokenState.None;
		} else if (this.tokenState === TokenState.Literal) {
			this.completeLiteral();
		} else if (this.tokenState === TokenState.String) {
			throw this.error("unterminated string at end of input");
		}
		if (this.stopped) return;
		if (!this.rootComplete) {
			throw this.error(this.stack.length === 0 ? "unexpected end of input: no JSON value" : "unexpected end of input");
		}
	}

	private scanStructural(text: string, index: number, code: number): number {
		if (isWhitespace(code)) return index + 1;
		if (this.expect === Expect.End) throw this.error("unexpected content after the JSON value");
		switch (code) {
			case CHAR_QUOTE: {
				const isKey = this.expect === Expect.Key || this.expect === Expect.KeyOrEnd;
				if (!isKey && this.expect !== Expect.Value && this.expect !== Expect.ValueOrEnd) {
					throw this.error(this.describeExpectation());
				}
				this.tokenState = TokenState.String;
				this.stringIsKey = isKey;
				this.stringCapture = isKey || this.sink.captureStrings(this.stack.length);
				this.token = "";
				this.tokenTruncated = false;
				this.stringLength = 0;
				this.escape = false;
				this.unicodeHex = null;
				return index + 1;
			}
			case 0x7b: // {
				this.requireValueExpectation();
				this.openContainer("object");
				return index + 1;
			case 0x5b: // [
				this.requireValueExpectation();
				this.openContainer("array");
				return index + 1;
			case 0x7d: // }
				this.closeContainer("object");
				return index + 1;
			case 0x5d: // ]
				this.closeContainer("array");
				return index + 1;
			case 0x3a: // :
				if (this.expect !== Expect.Colon) throw this.error(this.describeExpectation());
				this.expect = Expect.Value;
				return index + 1;
			case 0x2c: {
				// ,
				if (this.expect !== Expect.CommaOrEnd) throw this.error(this.describeExpectation());
				const top = this.stack[this.stack.length - 1] as Container;
				top.expect = top.kind === "object" ? Expect.Key : Expect.Value;
				this.expect = top.expect;
				return index + 1;
			}
			default:
				this.requireValueExpectation();
				if (isNumberChar(code) && code !== 0x2b && code !== 0x2e && code !== 0x45 && code !== 0x65) {
					this.tokenState = TokenState.Number;
					this.token = text[index] as string;
					this.tokenTruncated = false;
					return index + 1;
				}
				if (code >= 0x61 && code <= 0x7a) {
					this.tokenState = TokenState.Literal;
					this.token = text[index] as string;
					return index + 1;
				}
				throw this.error(`unexpected character ${JSON.stringify(text[index])}`);
		}
	}

	private scanString(text: string, index: number, length: number): number {
		// Fast path: consume a run of ordinary characters in one slice.
		if (!this.escape && this.unicodeHex === null) {
			let end = index;
			while (end < length) {
				const code = text.charCodeAt(end);
				if (code === CHAR_QUOTE || code === CHAR_BACKSLASH || code < 0x20) break;
				end += 1;
			}
			if (end > index) {
				const run = end - index;
				this.stringLength += run;
				if (this.stringCapture) this.captureString(text.slice(index, end));
				// Position bookkeeping for the run beyond its first character, which push counted.
				this.column += run - 1;
				if (end >= length) return end;
				// The terminator is a quote, a backslash, or a control character; a
				// fault on it must point at it, not at the run's first character.
				index = end;
				this.chunkIndex = index;
				this.column += 1;
			}
		}
		const code = text.charCodeAt(index);
		if (this.unicodeHex !== null) {
			if (!((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66))) {
				throw this.error("invalid \\u escape in string");
			}
			this.unicodeHex += text[index] as string;
			if (this.unicodeHex.length === 4) {
				const decoded = String.fromCharCode(Number.parseInt(this.unicodeHex, 16));
				this.unicodeHex = null;
				this.stringLength += 1;
				if (this.stringCapture) this.captureString(decoded);
			}
			return index + 1;
		}
		if (this.escape) {
			this.escape = false;
			if (code === 0x75) {
				this.unicodeHex = "";
				return index + 1;
			}
			const decoded = escapeChar(code);
			if (decoded === null) throw this.error(`invalid escape \\${text[index]} in string`);
			this.stringLength += 1;
			if (this.stringCapture) this.captureString(decoded);
			return index + 1;
		}
		if (code === CHAR_QUOTE) {
			this.completeString();
			return index + 1;
		}
		if (code === CHAR_BACKSLASH) {
			this.escape = true;
			return index + 1;
		}
		if (code < 0x20) throw this.error("unescaped control character in string");
		this.stringLength += 1;
		if (this.stringCapture) this.captureString(text[index] as string);
		return index + 1;
	}

	private captureString(piece: string): void {
		const cap = this.stringIsKey ? KEY_CAPTURE_CAP : STRING_CAPTURE_CAP;
		if (this.token.length >= cap) {
			this.tokenTruncated = true;
			return;
		}
		if (this.token.length + piece.length <= cap) {
			this.token += piece;
			return;
		}
		this.token += piece.slice(0, cap - this.token.length);
		this.tokenTruncated = true;
	}

	private completeString(): void {
		this.tokenState = TokenState.None;
		if (this.stringIsKey) {
			const top = this.stack[this.stack.length - 1] as Container;
			top.expect = Expect.Colon;
			this.expect = Expect.Colon;
			this.dispatch(this.sink.onKey(this.token, this.stack.length, this.tokenTruncated));
			return;
		}
		this.completeValue({
			type: "string",
			value: this.token,
			literal: null,
			captured: this.stringCapture,
			length: this.stringLength,
			truncated: this.tokenTruncated,
		});
	}

	private appendNumberChar(char: string): void {
		if (this.token.length >= MAX_NUMBER_LITERAL_CHARS) {
			this.tokenTruncated = true;
			return;
		}
		this.token += char;
	}

	private completeNumber(): void {
		if (!this.tokenTruncated && !NUMBER_GRAMMAR.test(this.token)) {
			throw this.error(`invalid number literal ${JSON.stringify(this.token)}`);
		}
		const literal = this.tokenTruncated ? `${this.token}…` : this.token;
		this.completeValue({
			type: "number",
			value: this.tokenTruncated ? Number.NaN : Number(this.token),
			literal,
			captured: true,
			length: 0,
			truncated: this.tokenTruncated,
		});
	}

	private completeLiteral(): void {
		this.tokenState = TokenState.None;
		const scalar: JsonScalarEvent = {
			type: "null",
			value: null,
			literal: null,
			captured: true,
			length: 0,
			truncated: false,
		};
		if (this.token === "true") {
			scalar.type = "boolean";
			scalar.value = true;
		} else if (this.token === "false") {
			scalar.type = "boolean";
			scalar.value = false;
		} else if (this.token !== "null") {
			throw this.error(`unexpected literal ${JSON.stringify(this.token)}`);
		}
		this.completeValue(scalar);
	}

	private requireValueExpectation(): void {
		if (this.expect !== Expect.Value && this.expect !== Expect.ValueOrEnd) throw this.error(this.describeExpectation());
	}

	private openContainer(kind: "object" | "array"): void {
		if (this.stack.length >= JSON_MAX_DEPTH) {
			throw new DataRefusalError(
				refusal("nesting-too-deep", `JSON nesting exceeds ${JSON_MAX_DEPTH} levels at line ${this.line}`, {
					line: this.line,
					column: this.column,
					byteOffset: this.byteOffset(),
				}),
			);
		}
		const depth = this.stack.length;
		if (depth > this.maxDepth) this.maxDepth = depth;
		const container: Container = { kind, count: 0, expect: kind === "object" ? Expect.KeyOrEnd : Expect.ValueOrEnd };
		this.stack.push(container);
		this.expect = container.expect;
		this.dispatch(kind === "object" ? this.sink.onStartObject(depth) : this.sink.onStartArray(depth));
	}

	private closeContainer(kind: "object" | "array"): void {
		const top = this.stack[this.stack.length - 1];
		if (top === undefined || top.kind !== kind) throw this.error(`unexpected ${kind === "object" ? "}" : "]"}`);
		const canClose =
			this.expect === Expect.CommaOrEnd ||
			(kind === "object" && this.expect === Expect.KeyOrEnd) ||
			(kind === "array" && this.expect === Expect.ValueOrEnd);
		if (!canClose) throw this.error(this.describeExpectation());
		this.stack.pop();
		const depth = this.stack.length;
		this.dispatch(kind === "object" ? this.sink.onEndObject(depth, top.count) : this.sink.onEndArray(depth, top.count));
		if (this.stopped) return;
		this.afterValue();
	}

	private completeValue(scalar: JsonScalarEvent): void {
		this.dispatch(this.sink.onScalar(scalar, this.stack.length));
		if (this.stopped) return;
		this.afterValue();
	}

	private afterValue(): void {
		const top = this.stack[this.stack.length - 1];
		if (top === undefined) {
			this.rootComplete = true;
			this.expect = Expect.End;
			return;
		}
		top.count += 1;
		top.expect = Expect.CommaOrEnd;
		this.expect = Expect.CommaOrEnd;
	}

	private dispatch(verdict: boolean | undefined): void {
		if (verdict === false) this.stopped = true;
	}

	private describeExpectation(): string {
		switch (this.expect) {
			case Expect.Value:
				return "expected a JSON value";
			case Expect.ValueOrEnd:
				return "expected a JSON value or ']'";
			case Expect.KeyOrEnd:
				return "expected a string key or '}'";
			case Expect.Key:
				return "expected a string key";
			case Expect.Colon:
				return "expected ':' after object key";
			case Expect.CommaOrEnd:
				return `expected ',' or '${(this.stack[this.stack.length - 1] as Container).kind === "object" ? "}" : "]"}'`;
			default:
				return "unexpected content after the JSON value";
		}
	}

	private byteOffset(): number {
		return this.chunkByteOffset + Buffer.byteLength(this.chunkText.slice(0, this.chunkIndex), "utf8");
	}

	private error(message: string): DataRefusalError {
		const byteOffset = this.byteOffset();
		return new DataRefusalError(
			refusal("invalid-json", `${message} at line ${this.line} column ${this.column} (byte offset ${byteOffset})`, {
				line: this.line,
				column: this.column,
				byteOffset,
			}),
		);
	}
}
