// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Host values the extension API carries across the runtime boundary, in the
 * shape PanCode sends them. PanCode holds its own definitions and checks at
 * compile time that they stay assignable to these.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelTier = "small" | "standard" | "frontier";

/** The model a call or turn runs on. */
export interface ModelRunInfo {
	/** Wire model id. */
	id: string;
	/** Target id the model is served through. */
	target: string;
	/** Effective context window in tokens, or null when nothing reported one. */
	contextWindow: number | null;
	/** The thinking level the requests actually carry after the model's limits. */
	thinkingLevel: ThinkingLevel;
	/** False only when the route turns prompt caching off (`cache.retention: none`). */
	promptCaching: boolean;
	tier: ModelTier;
}

/** A sum of facts as it crosses a boundary: the known subtotal and how many contributions were unknown. */
export interface FactSum {
	measured: number;
	estimated: number;
	unknownCount: number;
	absentCount: number;
	coverage: { measured: number; estimated: number; unknown: number };
}

/** Who started a submitted turn. */
export type TurnOriginKind = "operator" | "continuation" | "job" | "peer";

/** A tool call as a continuation's hooks read it, its arguments redacted and clipped. */
export interface TurnToolCall {
	tool: string;
	args?: Record<string, unknown>;
	outcome: "ok" | "error" | "unfinished";
}

export interface TurnOrigin {
	origin: TurnOriginKind;
	/** A yolo continuation's place against its cap; the first continuation is 1. */
	continuation?: { index: number; cap: number };
	/** The prompt template whose tool scope bounds the turn, when one does. */
	template?: string;
	/** The last tool call the stopped turn made, on a continuation's prompt_submit only. */
	lastToolCall?: TurnToolCall;
}

export type EmbeddingTask = "query" | "document";

export type EmbeddingPart =
	| { kind: "text"; text: string }
	| { kind: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }
	| { kind: "audio"; data: string; mimeType: "audio/wav" | "audio/mpeg" | "audio/flac" | "audio/ogg" };

export type EmbeddingInput =
	| EmbeddingPart
	| { kind: "mixed"; parts: readonly EmbeddingPart[] }
	| { kind: "video"; data: string; mimeType: string };

export interface EmbeddingProfile {
	id: string;
	model: string;
	assetIdentity: string;
	projectorIdentity: string | null;
	quantization: string;
	dimensions: number;
	pooling: "mean" | "last";
	normalization: "l2";
	queryPrefix: string;
	documentPrefix: string;
	preprocessingVersion: string;
	canaryFingerprint: string | null;
}

export interface EmbeddingResponse {
	vectors: number[][];
	profile: EmbeddingProfile;
	profileIdentity: string;
	dimensions: number;
	model: string;
	sources: Array<{ index: number; kind: EmbeddingInput["kind"]; bytes: number }>;
	usage: { inputItems: number; inputBytes: number; tokens?: number };
	warnings: string[];
}
