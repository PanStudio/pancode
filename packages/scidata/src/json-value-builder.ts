// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { JsonScalarEvent, JsonValueType } from "./json-stream-parser.js";
import { numberLiteralPrecision, type PrecisionIssue } from "./shared.js";

/** A number whose double representation would misstate its literal keeps the literal in place. */
export interface JsonLiteralPlaceholder {
	$literal: string;
	precision: string;
}

/** Stands in for a subtree a builder could not carry within its budget. */
export interface JsonSummaryPlaceholder {
	$summary: { type: JsonValueType; members?: number; length?: number; reason: "budget" };
}

/** A string cut at the capture cap: its true length and the prefix that was kept. */
export interface JsonTruncatedString {
	$truncated: "string";
	length: number;
	text: string;
}

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue }
	| JsonLiteralPlaceholder
	| JsonSummaryPlaceholder
	| JsonTruncatedString;

interface BuildFrame {
	kind: "object" | "array";
	value: Record<string, JsonValue> | JsonValue[];
	key: string | null;
	/** Members or elements seen, including those dropped after the budget ran out. */
	count: number;
}

/**
 * Materialize one subtree from events under a character budget. Once the
 * budget is spent, the subtree's root becomes a `$summary` placeholder and the
 * builder keeps counting so the summary reports the true member count.
 * Numbers with a precision issue become `$literal` placeholders; `issues`
 * collects them with their pointer relative to the subtree root.
 */
export class JsonValueBuilder {
	private readonly frames: BuildFrame[] = [];
	private spent = 0;
	private exceeded = false;
	private summaryType: "object" | "array" = "object";
	private result: JsonValue | undefined;
	private done = false;
	private stringsCut = 0;
	readonly issues: PrecisionIssue[] = [];

	constructor(
		private readonly budgetChars: number,
		private readonly rootPointer: string,
	) {}

	get complete(): boolean {
		return this.done;
	}

	/** The budget ran out; the value is (or contains) a $summary placeholder. */
	get overBudget(): boolean {
		return this.exceeded;
	}

	/** Strings cut at the capture cap, each left as a $truncated placeholder. */
	get cutStrings(): number {
		return this.stringsCut;
	}

	/** Anything in the value stands in for content that was not carried. */
	get truncated(): boolean {
		return this.exceeded || this.stringsCut > 0;
	}

	get value(): JsonValue | undefined {
		return this.result;
	}

	private pointer(): string {
		let pointer = this.rootPointer;
		for (const frame of this.frames) {
			pointer +=
				frame.kind === "object"
					? `/${(frame.key ?? "").replace(/~/gu, "~0").replace(/\//gu, "~1")}`
					: `/${frame.value.length}`;
		}
		return pointer;
	}

	private charge(chars: number): boolean {
		if (this.exceeded) return false;
		this.spent += chars;
		if (this.spent > this.budgetChars) {
			this.exceeded = true;
			return false;
		}
		return true;
	}

	private place(value: JsonValue): void {
		const frame = this.frames[this.frames.length - 1];
		if (frame === undefined) {
			this.result = value;
			this.done = true;
			return;
		}
		if (frame.kind === "array") (frame.value as JsonValue[]).push(value);
		else (frame.value as Record<string, JsonValue>)[frame.key ?? ""] = value;
		frame.count += 1;
	}

	/**
	 * The budget ran out somewhere inside the subtree. Everything built so far
	 * is discarded and the whole subtree becomes one `$summary` placed when its
	 * root closes, carrying the root's true member count from the parser.
	 */
	private exhaust(rootKind: "object" | "array"): void {
		this.exceeded = true;
		this.summaryType = this.frames[0]?.kind ?? rootKind;
		this.frames.length = 0;
	}

	startContainer(kind: "object" | "array", _relativeDepth: number): void {
		if (this.exceeded) return;
		if (!this.charge(2)) {
			this.exhaust(kind);
			return;
		}
		this.frames.push({ kind, value: kind === "object" ? {} : [], key: null, count: 0 });
	}

	key(name: string, _relativeDepth: number): void {
		if (this.exceeded) return;
		const frame = this.frames[this.frames.length - 1];
		if (frame === undefined) return;
		if (!this.charge(name.length + 4)) {
			this.exhaust(frame.kind);
			return;
		}
		frame.key = name;
	}

	endContainer(kind: "object" | "array", relativeDepth: number, count: number): void {
		if (this.exceeded) {
			if (relativeDepth === 0) {
				this.result = {
					$summary:
						this.summaryType === "object"
							? { type: "object", members: count, reason: "budget" }
							: { type: "array", length: count, reason: "budget" },
				};
				this.done = true;
			}
			return;
		}
		const frame = this.frames.pop();
		if (frame === undefined || frame.kind !== kind) return;
		this.place(frame.value);
	}

	scalar(scalar: JsonScalarEvent, _relativeDepth: number): void {
		if (this.exceeded) return;
		const cost = scalar.type === "string" ? scalar.length + 2 : (scalar.literal?.length ?? 4);
		if (!this.charge(cost)) {
			const frame = this.frames[this.frames.length - 1];
			if (frame === undefined) {
				// A scalar root over budget: keep it, the budget exists for containers.
				this.exceeded = false;
				this.spent = 0;
			} else {
				this.exhaust(frame.kind);
				return;
			}
		}
		if (scalar.type === "number") {
			const literal = scalar.literal ?? "";
			const precision = scalar.truncated ? "oversized-literal" : numberLiteralPrecision(literal);
			if (precision !== null) {
				this.issues.push({ kind: precision, literal, path: this.pointer() });
				this.place({ $literal: literal, precision });
				return;
			}
			this.place(scalar.value as number);
			return;
		}
		if (scalar.type === "string") {
			if (scalar.truncated) {
				this.stringsCut += 1;
				this.place({ $truncated: "string", length: scalar.length, text: scalar.value as string });
			} else this.place(scalar.value as string);
			return;
		}
		this.place(scalar.value as boolean | null);
	}
}
