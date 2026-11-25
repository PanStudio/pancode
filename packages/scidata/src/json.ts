// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	type JsonEventSink,
	type JsonScalarEvent,
	JsonStreamParser,
	type JsonValueType,
	STRING_CAPTURE_CAP,
} from "./json-stream-parser.js";
import { type JsonValue, JsonValueBuilder } from "./json-value-builder.js";
import {
	cutView,
	type DataRefusal,
	DataRefusalError,
	type DataViewFlags,
	exactView,
	numberLiteralPrecision,
	type PrecisionIssue,
	refusal,
	refusalFromError,
	resolveMaxRows,
	sampledNotice,
	sampledView,
	statDataFile,
	streamTextChunks,
	type TextStreamStats,
	throwIfAborted,
} from "./shared.js";

/**
 * Streaming JSON reader. A hand-written push parser walks a document as
 * events, so a multi-gigabyte array can be inspected or selected from without
 * being loaded, and numbers keep their source text so precision loss is
 * reported instead of silently rounded. `JSON.parse` never touches a whole
 * data file here.
 */

function escapePointerSegment(segment: string): string {
	return segment.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

/** Parse an RFC 6901 pointer into segments; "" is the whole document. */
export function parseJsonPointer(pointer: string): string[] | Error {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) return new Error("JSON pointer must start with '/' or be empty for the whole document");
	return pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

/** Tracks the pointer of the value about to start, from the events already seen. */
class PathTracker {
	readonly segments: string[] = [];
	private readonly kinds: Array<"object" | "array"> = [];
	private readonly indexes: number[] = [];

	startContainer(kind: "object" | "array"): void {
		this.kinds.push(kind);
		this.indexes.push(0);
		this.segments.push(kind === "array" ? "0" : "");
	}

	key(name: string): void {
		this.segments[this.segments.length - 1] = name;
	}

	endContainer(): void {
		this.kinds.pop();
		this.indexes.pop();
		this.segments.pop();
	}

	/** Advance after a value completes inside the current container. */
	advance(): void {
		const top = this.kinds.length - 1;
		if (top < 0) return;
		if (this.kinds[top] === "array") {
			const next = (this.indexes[top] as number) + 1;
			this.indexes[top] = next;
			this.segments[top] = String(next);
		}
	}

	pointer(): string {
		return this.segments.map((segment) => `/${escapePointerSegment(segment)}`).join("");
	}

	/** Pointer of the innermost open container. */
	containerPointer(): string {
		return this.segments
			.slice(0, -1)
			.map((segment) => `/${escapePointerSegment(segment)}`)
			.join("");
	}
}

export interface JsonDuplicateKeyReport {
	count: number;
	first: { path: string; key: string } | null;
	/** False when an object exceeded the per-object tracking cap, so later duplicates there went unchecked. */
	checkedFully: boolean;
}

export interface JsonPrecisionReport {
	count: number;
	first: PrecisionIssue[];
}

const DUPLICATE_KEY_TRACK_CAP = 10_000;
const KEY_LIST_CAP = 200;
const PRECISION_FIRST_CAP = 20;
const SAMPLE_BUDGET_CHARS = 8192;
const SELECT_BUDGET_CHARS = 1_048_576;

interface ScanFrame {
	seen: Set<string> | null;
	overCap: boolean;
}

/**
 * Structural scan state shared by inspect, validate, and the JSONL line
 * reader: duplicate keys at any depth, precision issues with their pointer,
 * and the pointer tracker every consumer needs.
 */
class StructureScanner {
	readonly path = new PathTracker();
	private readonly frames: ScanFrame[] = [];
	duplicateCount = 0;
	duplicateFirst: { path: string; key: string } | null = null;
	duplicateCheckedFully = true;
	precisionCount = 0;
	readonly precisionFirst: PrecisionIssue[] = [];

	constructor(private readonly pointerPrefix: string = "") {}

	startContainer(kind: "object" | "array"): void {
		this.path.startContainer(kind);
		this.frames.push({ seen: kind === "object" ? new Set() : null, overCap: false });
	}

	key(name: string): void {
		this.path.key(name);
		const frame = this.frames[this.frames.length - 1];
		if (frame?.seen === null || frame === undefined) return;
		if (frame.overCap) return;
		if (frame.seen.has(name)) {
			this.duplicateCount += 1;
			if (this.duplicateFirst === null) {
				this.duplicateFirst = { path: this.pointerPrefix + this.path.containerPointer(), key: name };
			}
			return;
		}
		if (frame.seen.size >= DUPLICATE_KEY_TRACK_CAP) {
			frame.overCap = true;
			frame.seen = null;
			this.duplicateCheckedFully = false;
			return;
		}
		frame.seen.add(name);
	}

	endContainer(): void {
		this.frames.pop();
		this.path.endContainer();
		this.path.advance();
	}

	scalar(scalar: JsonScalarEvent): void {
		if (scalar.type === "number") {
			const literal = scalar.literal ?? "";
			const precision = scalar.truncated ? "oversized-literal" : numberLiteralPrecision(literal);
			if (precision !== null) {
				this.precisionCount += 1;
				if (this.precisionFirst.length < PRECISION_FIRST_CAP) {
					this.precisionFirst.push({ kind: precision, literal, path: this.pointerPrefix + this.path.pointer() });
				}
			}
		}
		this.path.advance();
	}

	duplicates(): JsonDuplicateKeyReport {
		return { count: this.duplicateCount, first: this.duplicateFirst, checkedFully: this.duplicateCheckedFully };
	}

	precision(): JsonPrecisionReport {
		return { count: this.precisionCount, first: [...this.precisionFirst] };
	}
}

export interface JsonSampleMember {
	key: string;
	value: JsonValue;
}

export interface JsonInspectResult {
	ok: true;
	format: "json";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	/** Top-level elements (array) or members (object) scanned; 1 for a scalar root. */
	rowsScanned: number;
	/** Array length or member count; null when the scan stopped at maxRows. */
	rowCount: number | null;
	root: JsonValueType;
	/** Root object member names, in document order, capped. */
	keys?: { names: string[]; truncated: boolean };
	/** Root array element type histogram over the scanned elements. */
	elementTypes?: Record<string, number>;
	/** Root object member value type histogram over the scanned members. */
	memberTypes?: Record<string, number>;
	/** Root scalar value; a number with a precision issue keeps its literal. */
	value?: JsonValue;
	maxDepth: number;
	duplicateKeys: JsonDuplicateKeyReport;
	precision: JsonPrecisionReport;
	/** First elements (array) or members (object), each within an 8 KiB budget. */
	sample: JsonValue[] | JsonSampleMember[];
	notes: string[];
}

export interface JsonInspectOptions {
	sampleRows?: number;
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

export const JSON_DEFAULT_SAMPLE_ROWS = 10;
export const JSON_DEFAULT_MAX_ROWS = 100_000;

class InspectSink implements JsonEventSink {
	readonly scanner = new StructureScanner();
	root: JsonValueType | null = null;
	rows = 0;
	rowCount: number | null = null;
	stoppedAtRows = false;
	readonly keys: string[] = [];
	keysTruncated = false;
	readonly types = new Map<string, number>();
	readonly sample: JsonValue[] | JsonSampleMember[] = [];
	/** Sample values that carry a $summary or $truncated placeholder; the counts stay exact. */
	sampleCuts = 0;
	rootValue: JsonValue | undefined;
	private builder: JsonValueBuilder | null = null;
	private builderDepth = 0;
	private currentKey = "";
	private readonly sampleIssues: PrecisionIssue[] = [];

	constructor(
		private readonly sampleRows: number,
		private readonly maxRows: number,
	) {}

	private countType(type: JsonValueType): void {
		this.types.set(type, (this.types.get(type) ?? 0) + 1);
	}

	/** A depth-1 value begins: count it, decide whether it is sampled, or stop at the row bound. */
	private beginRow(type: JsonValueType): boolean {
		if (this.rows >= this.maxRows) {
			this.stoppedAtRows = true;
			return false;
		}
		this.rows += 1;
		this.countType(type);
		if (this.sample.length < this.sampleRows) {
			const pointer = this.root === "array" ? `/${this.rows - 1}` : `/${escapePointerSegment(this.currentKey)}`;
			this.builder = new JsonValueBuilder(SAMPLE_BUDGET_CHARS, pointer);
			this.builderDepth = 1;
		}
		return true;
	}

	private finishSampled(): void {
		const builder = this.builder;
		if (builder === null || !builder.complete) return;
		this.builder = null;
		if (builder.truncated) this.sampleCuts += 1;
		const value = builder.value as JsonValue;
		if (this.root === "array") (this.sample as JsonValue[]).push(value);
		else (this.sample as JsonSampleMember[]).push({ key: this.currentKey, value });
		this.sampleIssues.push(...builder.issues);
	}

	onStartObject(depth: number): boolean | undefined {
		if (depth === 0) {
			this.root = "object";
			this.scanner.startContainer("object");
			return undefined;
		}
		if (depth === 1 && !this.beginRow("object")) return false;
		this.scanner.startContainer("object");
		this.builder?.startContainer("object", depth - this.builderDepth);
		return undefined;
	}

	onStartArray(depth: number): boolean | undefined {
		if (depth === 0) {
			this.root = "array";
			this.scanner.startContainer("array");
			return undefined;
		}
		if (depth === 1 && !this.beginRow("array")) return false;
		this.scanner.startContainer("array");
		this.builder?.startContainer("array", depth - this.builderDepth);
		return undefined;
	}

	onKey(key: string, depth: number, truncated: boolean): boolean | undefined {
		this.scanner.key(key);
		if (depth === 1) {
			// The row this key introduces is counted when its value starts; the key
			// list and the stop decision belong here so a stop never records a key
			// whose value was never scanned.
			if (this.rows >= this.maxRows) {
				this.stoppedAtRows = true;
				return false;
			}
			this.currentKey = truncated ? `${key}…` : key;
			if (this.keys.length < KEY_LIST_CAP) this.keys.push(this.currentKey);
			else this.keysTruncated = true;
			return undefined;
		}
		this.builder?.key(key, depth - this.builderDepth);
		return undefined;
	}

	onEndObject(depth: number, memberCount: number): boolean | undefined {
		if (depth === 0) {
			this.rowCount = memberCount;
			return undefined;
		}
		this.scanner.endContainer();
		this.builder?.endContainer("object", depth - this.builderDepth, memberCount);
		if (depth === 1) this.finishSampled();
		return undefined;
	}

	onEndArray(depth: number, length: number): boolean | undefined {
		if (depth === 0) {
			this.rowCount = length;
			return undefined;
		}
		this.scanner.endContainer();
		this.builder?.endContainer("array", depth - this.builderDepth, length);
		if (depth === 1) this.finishSampled();
		return undefined;
	}

	onScalar(scalar: JsonScalarEvent, depth: number): boolean | undefined {
		if (depth === 0) {
			this.root = scalar.type;
			this.rows = 1;
			this.rowCount = 1;
			const builder = new JsonValueBuilder(SAMPLE_BUDGET_CHARS, "");
			builder.scalar(scalar, 0);
			this.rootValue = builder.value;
			this.sampleIssues.push(...builder.issues);
			this.scanner.scalar(scalar);
			return undefined;
		}
		if (depth === 1 && !this.beginRow(scalar.type)) return false;
		this.scanner.scalar(scalar);
		this.builder?.scalar(scalar, depth - this.builderDepth);
		if (depth === 1) this.finishSampled();
		return undefined;
	}

	captureStrings(depth: number): boolean {
		if (depth === 0) return true;
		if (depth === 1) return this.rows < this.maxRows && this.sample.length < this.sampleRows;
		return this.builder !== null && !this.builder.overBudget;
	}

	/** Precision issues seen inside sampled values that the scanner already counted; used only for cross-checks. */
	get sampledIssues(): ReadonlyArray<PrecisionIssue> {
		return this.sampleIssues;
	}
}

async function runParser(
	path: string,
	sink: JsonEventSink,
	signal: AbortSignal | undefined,
	stats: TextStreamStats,
): Promise<{ parser: JsonStreamParser; stopped: boolean }> {
	const parser = new JsonStreamParser(sink);
	for await (const chunk of streamTextChunks(path, { signal, stats })) {
		if (!parser.push(chunk.text, chunk.byteOffset)) return { parser, stopped: true };
	}
	parser.end();
	throwIfAborted(signal, path);
	return { parser, stopped: parser.isStopped };
}

export async function inspectJson(
	path: string,
	options: JsonInspectOptions = {},
): Promise<JsonInspectResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const sampleRows = Math.max(0, Math.min(1000, Math.floor(options.sampleRows ?? JSON_DEFAULT_SAMPLE_ROWS)));
	const maxRows = resolveMaxRows(options.maxRows, JSON_DEFAULT_MAX_ROWS);
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const sink = new InspectSink(sampleRows, maxRows);
	let parser: JsonStreamParser;
	try {
		parser = (await runParser(path, sink, options.signal, stats)).parser;
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
	const sampled = sink.stoppedAtRows;
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	if (sampled) notes.push(sampledNotice(sink.rows, sink.root === "object" ? "members" : "elements"));
	if (sink.sampleCuts > 0) {
		notes.push(
			`${sink.sampleCuts} sample value(s) were cut to the preview budget and carry $summary or $truncated placeholders; the counts are exact`,
		);
	}
	if (!sink.scanner.duplicateCheckedFully) {
		notes.push(
			`duplicate-key tracking stopped at ${DUPLICATE_KEY_TRACK_CAP} keys in one object; later duplicates there are unreported`,
		);
	}
	if (sink.keysTruncated) notes.push(`key list capped at ${KEY_LIST_CAP} names`);
	const root = sink.root ?? "null";
	const result: JsonInspectResult = {
		ok: true,
		format: "json",
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: sampled ? sampledView() : exactView(),
		rowsScanned: sink.rows,
		rowCount: sampled ? null : sink.rowCount,
		root,
		maxDepth: parser.maxDepth,
		duplicateKeys: sink.scanner.duplicates(),
		precision: sink.scanner.precision(),
		sample: sink.sample,
		notes,
	};
	const types: Record<string, number> = {};
	for (const [type, count] of sink.types) types[type] = count;
	if (root === "array") result.elementTypes = types;
	else if (root === "object") {
		result.keys = { names: sink.keys, truncated: sink.keysTruncated };
		result.memberTypes = types;
	} else if (sink.rootValue !== undefined) result.value = sink.rootValue;
	return result;
}

export interface JsonSelectOptions {
	/** RFC 6901 pointer; "" selects the whole document. */
	pointer?: string;
	/** Array targets only: first element index to return. */
	offset?: number;
	/** Array targets only: maximum elements to return. */
	limit?: number;
	signal?: AbortSignal | undefined;
}

export const JSON_SELECT_DEFAULT_LIMIT = 50;
export const JSON_SELECT_MAX_LIMIT = 1000;

export interface JsonSelectResult {
	ok: true;
	format: "json";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	pointer: string;
	/** The selected value, unless the target is an array read with offset/limit. */
	value?: JsonValue;
	/** Elements [offset, offset + returned) of the target array. */
	elements?: JsonValue[];
	offset?: number;
	limit?: number;
	returned?: number;
	/** Whether the target array holds elements past the returned window. */
	hasMore?: boolean;
	precision: JsonPrecisionReport;
	/** Duplicate object keys inside the selected value; materialization kept the last value. */
	duplicateKeys: JsonDuplicateKeyReport;
	notes: string[];
}

type SelectPhase = "seeking" | "capturing" | "done";

class SelectSink implements JsonEventSink {
	readonly path = new PathTracker();
	phase: SelectPhase = "seeking";
	targetDepth = -1;
	found = false;
	targetType: JsonValueType | null = null;
	builder: JsonValueBuilder | null = null;
	/** Array-window mode state. */
	windowed = false;
	elementIndex = 0;
	readonly elements: JsonValue[] = [];
	hasMore = false;
	readonly issues: PrecisionIssue[] = [];
	tooLarge = false;
	cutStrings = 0;
	/** Deepest matched prefix length, for the not-found message. */
	deepestMatch = 0;
	/** Per-object key sets inside the captured value; null past the tracking cap. */
	private readonly keySets: Array<Set<string> | null> = [];
	duplicateCount = 0;
	duplicateFirst: { path: string; key: string } | null = null;
	duplicatesCheckedFully = true;

	constructor(
		private readonly segments: string[],
		private readonly windowOffset: number | null,
		private readonly windowLimit: number,
	) {}

	private trackObjectStart(): void {
		if (this.builder !== null) this.keySets.push(new Set());
	}

	private trackKey(key: string): void {
		if (this.builder === null) return;
		const keys = this.keySets[this.keySets.length - 1];
		if (keys === null || keys === undefined) return;
		if (keys.has(key)) {
			this.duplicateCount += 1;
			if (this.duplicateFirst === null) this.duplicateFirst = { path: this.path.containerPointer(), key };
			return;
		}
		if (keys.size >= DUPLICATE_KEY_TRACK_CAP) {
			this.duplicatesCheckedFully = false;
			this.keySets[this.keySets.length - 1] = null;
			return;
		}
		keys.add(key);
	}

	private trackObjectEnd(): void {
		if (this.builder !== null) this.keySets.pop();
	}

	private pointerMatches(): boolean {
		const current = this.path.segments;
		if (current.length !== this.segments.length) return false;
		for (let index = 0; index < current.length; index += 1) {
			if (current[index] !== this.segments[index]) return false;
		}
		return true;
	}

	private prefixMatches(): boolean {
		const current = this.path.segments;
		if (current.length > this.segments.length) return false;
		for (let index = 0; index < current.length; index += 1) {
			if (current[index] !== this.segments[index]) return false;
		}
		if (current.length > this.deepestMatch) this.deepestMatch = current.length;
		return true;
	}

	private beginTarget(type: JsonValueType, depth: number): void {
		this.found = true;
		this.targetType = type;
		this.targetDepth = depth;
		this.phase = "capturing";
		if (type === "array" && this.windowOffset !== null) {
			this.windowed = true;
			return;
		}
		this.builder = new JsonValueBuilder(SELECT_BUDGET_CHARS, this.path.pointer());
	}

	private finishBuilder(): boolean | undefined {
		const builder = this.builder;
		if (builder === null || !builder.complete) return undefined;
		this.builder = null;
		if (builder.overBudget) {
			this.tooLarge = true;
			return false;
		}
		this.cutStrings += builder.cutStrings;
		this.issues.push(...builder.issues);
		if (this.windowed) {
			this.elements.push(builder.value as JsonValue);
			if (this.elements.length >= this.windowLimit) {
				// Keep parsing only far enough to learn whether another element follows.
				return undefined;
			}
			return undefined;
		}
		this.value = builder.value;
		this.phase = "done";
		return false;
	}

	value: JsonValue | undefined;

	private beginElement(type: JsonValueType, depth: number): boolean | undefined {
		if (!this.windowed || depth !== this.targetDepth + 1) return undefined;
		const index = this.elementIndex;
		this.elementIndex += 1;
		const offset = this.windowOffset as number;
		if (index < offset) return undefined;
		if (this.elements.length >= this.windowLimit) {
			this.hasMore = true;
			this.phase = "done";
			return false;
		}
		this.builder = new JsonValueBuilder(SELECT_BUDGET_CHARS, `${this.path.pointer()}`);
		void type;
		return undefined;
	}

	onStartObject(depth: number): boolean | undefined {
		if (this.phase === "seeking") {
			if (this.pointerMatches()) {
				this.beginTarget("object", depth);
				this.builder?.startContainer("object", 0);
			} else this.prefixMatches();
		} else if (this.phase === "capturing") {
			const stop = this.beginElement("object", depth);
			if (stop === false) return false;
			this.builder?.startContainer("object", depth - (this.windowed ? this.targetDepth + 1 : this.targetDepth));
		}
		this.trackObjectStart();
		this.path.startContainer("object");
		return undefined;
	}

	onStartArray(depth: number): boolean | undefined {
		if (this.phase === "seeking") {
			if (this.pointerMatches()) {
				this.beginTarget("array", depth);
				this.builder?.startContainer("array", 0);
			} else this.prefixMatches();
		} else if (this.phase === "capturing") {
			const stop = this.beginElement("array", depth);
			if (stop === false) return false;
			this.builder?.startContainer("array", depth - (this.windowed ? this.targetDepth + 1 : this.targetDepth));
		}
		this.path.startContainer("array");
		return undefined;
	}

	onKey(key: string, depth: number): boolean | undefined {
		this.path.key(key);
		if (this.phase === "seeking") this.prefixMatches();
		else if (this.phase === "capturing") {
			this.trackKey(key);
			this.builder?.key(key, depth - (this.windowed ? this.targetDepth + 1 : this.targetDepth));
		}
		return undefined;
	}

	onEndObject(depth: number, memberCount: number): boolean | undefined {
		this.trackObjectEnd();
		this.path.endContainer();
		this.path.advance();
		if (this.phase !== "capturing") return undefined;
		if (this.windowed) {
			if (depth === this.targetDepth) {
				this.phase = "done";
				return false;
			}
			this.builder?.endContainer("object", depth - (this.targetDepth + 1), memberCount);
			if (depth === this.targetDepth + 1) return this.finishBuilder();
			return undefined;
		}
		this.builder?.endContainer("object", depth - this.targetDepth, memberCount);
		if (depth === this.targetDepth) return this.finishBuilder();
		return undefined;
	}

	onEndArray(depth: number, length: number): boolean | undefined {
		this.path.endContainer();
		this.path.advance();
		if (this.phase !== "capturing") return undefined;
		if (this.windowed) {
			if (depth === this.targetDepth) {
				this.phase = "done";
				return false;
			}
			this.builder?.endContainer("array", depth - (this.targetDepth + 1), length);
			if (depth === this.targetDepth + 1) return this.finishBuilder();
			return undefined;
		}
		this.builder?.endContainer("array", depth - this.targetDepth, length);
		if (depth === this.targetDepth) return this.finishBuilder();
		return undefined;
	}

	onScalar(scalar: JsonScalarEvent, depth: number): boolean | undefined {
		let verdict: boolean | undefined;
		if (this.phase === "seeking") {
			if (this.pointerMatches()) {
				this.beginTarget(scalar.type, depth);
				this.builder?.scalar(scalar, 0);
				verdict = this.finishBuilder();
			} else this.prefixMatches();
		} else if (this.phase === "capturing") {
			const stop = this.beginElement(scalar.type, depth);
			if (stop === false) return false;
			if (this.windowed) {
				this.builder?.scalar(scalar, depth - (this.targetDepth + 1));
				if (depth === this.targetDepth + 1) verdict = this.finishBuilder();
			} else {
				this.builder?.scalar(scalar, depth - this.targetDepth);
			}
		}
		this.path.advance();
		return verdict;
	}

	captureStrings(depth: number): boolean {
		if (this.phase === "seeking") return this.pointerMatches();
		if (this.phase !== "capturing") return false;
		if (this.windowed && depth === this.targetDepth + 1) {
			return this.elementIndex >= (this.windowOffset as number) && this.elements.length < this.windowLimit;
		}
		return this.builder !== null && !this.builder.overBudget;
	}
}

export async function selectJson(
	path: string,
	options: JsonSelectOptions = {},
): Promise<JsonSelectResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const pointer = options.pointer ?? "";
	const segments = parseJsonPointer(pointer);
	if (segments instanceof Error) return refusal("invalid-argument", segments.message, { path });
	const windowed = options.offset !== undefined || options.limit !== undefined;
	const offset = windowed ? Math.max(0, Math.floor(options.offset ?? 0)) : null;
	const limit = Math.max(1, Math.min(JSON_SELECT_MAX_LIMIT, Math.floor(options.limit ?? JSON_SELECT_DEFAULT_LIMIT)));
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const sink = new SelectSink(segments, offset, limit);
	let stopped = false;
	try {
		stopped = (await runParser(path, sink, options.signal, stats)).stopped;
	} catch (error) {
		return refusalFromError(error, path, options.signal);
	}
	if (sink.tooLarge) {
		const where = pointer || "the document root";
		return refusal(
			"selection-too-large",
			windowed
				? `an element of the array at ${where} exceeds the ${SELECT_BUDGET_CHARS}-character selection budget; select a deeper pointer into that element, or a window of 1 to isolate it`
				: `the value at ${where} exceeds the ${SELECT_BUDGET_CHARS}-character selection budget; select a deeper pointer or an array window with offset and limit`,
			{ path },
		);
	}
	if (!sink.found) {
		const matched = segments.slice(0, sink.deepestMatch);
		const matchedPointer = matched.map((segment) => `/${escapePointerSegment(segment)}`).join("");
		return refusal(
			"pointer-not-found",
			`no value at ${pointer}; the deepest existing prefix is ${matchedPointer === "" ? "the document root" : matchedPointer}`,
			{ path },
		);
	}
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	if (stopped) {
		notes.push("reading stopped once the selection was complete; the rest of the document was not checked for syntax");
	}
	if (sink.cutStrings > 0) {
		notes.push(
			`${sink.cutStrings} string(s) longer than ${STRING_CAPTURE_CAP} characters were cut; each is a $truncated placeholder with its full length`,
		);
	}
	if (sink.duplicateCount > 0) {
		notes.push(`${sink.duplicateCount} duplicate object key(s) inside the selection; the last value was kept`);
	}
	const precision: JsonPrecisionReport = {
		count: sink.issues.length,
		first: sink.issues.slice(0, PRECISION_FIRST_CAP),
	};
	const base = {
		ok: true as const,
		format: "json" as const,
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: sink.cutStrings > 0 ? cutView() : exactView(),
		pointer,
		precision,
		duplicateKeys: {
			count: sink.duplicateCount,
			first: sink.duplicateFirst,
			checkedFully: sink.duplicatesCheckedFully,
		} satisfies JsonDuplicateKeyReport,
		notes,
	};
	if (windowed) {
		if (sink.targetType !== "array") {
			return refusal(
				"invalid-argument",
				`offset and limit apply to an array target; the value at ${pointer || "the document root"} is ${sink.targetType ?? "unknown"}`,
				{ path },
			);
		}
		return {
			...base,
			elements: sink.elements,
			offset: offset as number,
			limit,
			returned: sink.elements.length,
			hasMore: sink.hasMore,
		};
	}
	return { ...base, value: sink.value ?? null };
}

export interface JsonValidateResult {
	ok: true;
	format: "json";
	path: string;
	bytes: number;
	bytesScanned: number;
	view: DataViewFlags;
	/** True when the whole document parsed; null when the scan stopped at maxRows before the end. */
	valid: boolean | null;
	complete: boolean;
	rowsScanned: number;
	rowCount: number | null;
	root: JsonValueType | null;
	maxDepth: number;
	duplicateKeys: JsonDuplicateKeyReport;
	precision: JsonPrecisionReport;
	/** The syntax fault, when the document is invalid. */
	syntaxError?: { message: string; line?: number; column?: number; byteOffset?: number };
	notes: string[];
}

export interface JsonValidateOptions {
	maxRows?: number | null;
	signal?: AbortSignal | undefined;
}

class ValidateSink implements JsonEventSink {
	readonly scanner = new StructureScanner();
	root: JsonValueType | null = null;
	rows = 0;
	rowCount: number | null = null;
	stoppedAtRows = false;

	constructor(private readonly maxRows: number) {}

	private beginRow(): boolean {
		if (this.rows >= this.maxRows) {
			this.stoppedAtRows = true;
			return false;
		}
		this.rows += 1;
		return true;
	}

	onStartObject(depth: number): boolean | undefined {
		if (depth === 0) this.root = "object";
		else if (depth === 1 && !this.beginRow()) return false;
		this.scanner.startContainer("object");
		return undefined;
	}

	onStartArray(depth: number): boolean | undefined {
		if (depth === 0) this.root = "array";
		else if (depth === 1 && !this.beginRow()) return false;
		this.scanner.startContainer("array");
		return undefined;
	}

	onKey(key: string, depth: number): boolean | undefined {
		if (depth === 1 && this.rows >= this.maxRows) {
			this.stoppedAtRows = true;
			return false;
		}
		this.scanner.key(key);
		return undefined;
	}

	onEndObject(depth: number, memberCount: number): boolean | undefined {
		if (depth === 0) this.rowCount = memberCount;
		this.scanner.endContainer();
		return undefined;
	}

	onEndArray(depth: number, length: number): boolean | undefined {
		if (depth === 0) this.rowCount = length;
		this.scanner.endContainer();
		return undefined;
	}

	onScalar(scalar: JsonScalarEvent, depth: number): boolean | undefined {
		if (depth === 0) {
			this.root = scalar.type;
			this.rows = 1;
			this.rowCount = 1;
		} else if (depth === 1 && !this.beginRow()) return false;
		this.scanner.scalar(scalar);
		return undefined;
	}

	captureStrings(): boolean {
		return false;
	}
}

export async function validateJson(
	path: string,
	options: JsonValidateOptions = {},
): Promise<JsonValidateResult | DataRefusal> {
	const stat = statDataFile(path);
	if ("ok" in stat) return stat;
	const maxRows = resolveMaxRows(options.maxRows, JSON_DEFAULT_MAX_ROWS);
	const stats: TextStreamStats = { bytesRead: 0, bom: false };
	const sink = new ValidateSink(maxRows);
	const parser = new JsonStreamParser(sink);
	let syntaxError: JsonValidateResult["syntaxError"];
	try {
		let stopped = false;
		for await (const chunk of streamTextChunks(path, { signal: options.signal, stats })) {
			if (!parser.push(chunk.text, chunk.byteOffset)) {
				stopped = true;
				break;
			}
		}
		if (!stopped) parser.end();
		throwIfAborted(options.signal, path);
	} catch (error) {
		if (
			error instanceof DataRefusalError &&
			(error.refusal.reason === "invalid-json" || error.refusal.reason === "nesting-too-deep")
		) {
			syntaxError = {
				message: error.refusal.message,
				...(error.refusal.line !== undefined ? { line: error.refusal.line } : {}),
				...(error.refusal.column !== undefined ? { column: error.refusal.column } : {}),
				...(error.refusal.byteOffset !== undefined ? { byteOffset: error.refusal.byteOffset } : {}),
			};
		} else {
			return refusalFromError(error, path, options.signal);
		}
	}
	const complete = !sink.stoppedAtRows;
	const notes: string[] = [];
	if (stats.bom) notes.push("a UTF-8 byte-order mark was stripped");
	if (!complete) {
		notes.push(
			`validation incomplete: stopped after ${sink.rows} top-level rows; pass maxRows null to validate the whole document`,
		);
	}
	if (sink.scanner.duplicateCount > 0)
		notes.push(`${sink.scanner.duplicateCount} duplicate object key(s); JSON.parse would keep the last value`);
	return {
		ok: true,
		format: "json",
		path,
		bytes: stat.size,
		bytesScanned: stats.bytesRead,
		view: complete ? exactView() : sampledView(),
		valid: syntaxError !== undefined ? false : complete ? true : null,
		complete,
		rowsScanned: sink.rows,
		rowCount: complete && syntaxError === undefined ? sink.rowCount : null,
		root: sink.root,
		maxDepth: parser.maxDepth,
		duplicateKeys: sink.scanner.duplicates(),
		precision: sink.scanner.precision(),
		...(syntaxError !== undefined ? { syntaxError } : {}),
		notes,
	};
}

/**
 * Parse one complete JSON text (a JSONL line) with a structural scan and an
 * optional materialization. Returns the parsed value under the builder budget,
 * the top-level shape, and the precision and duplicate facts the scanner saw.
 */
export interface JsonTextScan {
	root: JsonValueType;
	/** Top-level member names for an object root, in order. */
	keys: string[];
	/** Top-level member value types by key (object root) or element types (array root). */
	memberTypes: Map<string, JsonValueType>;
	maxDepth: number;
	duplicateKeys: number;
	precision: PrecisionIssue[];
	value: JsonValue | undefined;
	valueTruncated: boolean;
}

class TextScanSink implements JsonEventSink {
	readonly scanner: StructureScanner;
	root: JsonValueType | null = null;
	readonly keys: string[] = [];
	readonly memberTypes = new Map<string, JsonValueType>();
	private currentKey = "";
	private readonly builder: JsonValueBuilder | null;

	constructor(pointerPrefix: string, budgetChars: number | null) {
		this.scanner = new StructureScanner(pointerPrefix);
		this.builder = budgetChars === null ? null : new JsonValueBuilder(budgetChars, "");
	}

	get value(): JsonValue | undefined {
		return this.builder?.value;
	}

	get valueTruncated(): boolean {
		return this.builder?.truncated ?? false;
	}

	private noteMember(type: JsonValueType, depth: number): void {
		if (depth !== 1) return;
		if (this.root === "object") {
			if (!this.memberTypes.has(this.currentKey)) this.memberTypes.set(this.currentKey, type);
		}
	}

	onStartObject(depth: number): boolean | undefined {
		if (depth === 0) this.root = "object";
		this.noteMember("object", depth);
		this.scanner.startContainer("object");
		this.builder?.startContainer("object", depth);
		return undefined;
	}

	onStartArray(depth: number): boolean | undefined {
		if (depth === 0) this.root = "array";
		this.noteMember("array", depth);
		this.scanner.startContainer("array");
		this.builder?.startContainer("array", depth);
		return undefined;
	}

	onKey(key: string, depth: number): boolean | undefined {
		this.scanner.key(key);
		if (depth === 1) {
			this.currentKey = key;
			this.keys.push(key);
		}
		this.builder?.key(key, depth);
		return undefined;
	}

	onEndObject(depth: number, memberCount: number): boolean | undefined {
		this.scanner.endContainer();
		this.builder?.endContainer("object", depth, memberCount);
		return undefined;
	}

	onEndArray(depth: number, length: number): boolean | undefined {
		this.scanner.endContainer();
		this.builder?.endContainer("array", depth, length);
		return undefined;
	}

	onScalar(scalar: JsonScalarEvent, depth: number): boolean | undefined {
		if (depth === 0) this.root = scalar.type;
		this.noteMember(scalar.type, depth);
		this.scanner.scalar(scalar);
		this.builder?.scalar(scalar, depth);
		return undefined;
	}

	captureStrings(): boolean {
		return this.builder !== null && !this.builder.overBudget;
	}
}

/** Scan one JSON text. Throws a DataRefusalError for a syntax fault (offsets relative to the text). */
export function scanJsonText(
	text: string,
	options: { pointerPrefix?: string; materializeBudgetChars?: number | null } = {},
): JsonTextScan {
	const sink = new TextScanSink(options.pointerPrefix ?? "", options.materializeBudgetChars ?? null);
	const parser = new JsonStreamParser(sink);
	parser.push(text, 0);
	parser.end();
	return {
		root: sink.root ?? "null",
		keys: sink.keys,
		memberTypes: sink.memberTypes,
		maxDepth: parser.maxDepth,
		duplicateKeys: sink.scanner.duplicateCount,
		precision: [...sink.scanner.precisionFirst],
		value: sink.value,
		valueTruncated: sink.valueTruncated,
	};
}

export { PRECISION_FIRST_CAP as JSON_PRECISION_FIRST_CAP, SAMPLE_BUDGET_CHARS as JSON_SAMPLE_BUDGET_CHARS };
