// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Embedding value shapes. The extension public API (public-api-v2.ts) names
// them, so this module imports nothing: an import here would pull its whole
// graph into the bundled declaration build of that API.

export type EmbeddingTask = "query" | "document";
export const EMBEDDING_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const EMBEDDING_AUDIO_MIME_TYPES = ["audio/wav", "audio/mpeg", "audio/flac", "audio/ogg"] as const;
export type EmbeddingPart =
	| { kind: "text"; text: string }
	| { kind: "image"; data: string; mimeType: (typeof EMBEDDING_IMAGE_MIME_TYPES)[number] }
	| { kind: "audio"; data: string; mimeType: (typeof EMBEDDING_AUDIO_MIME_TYPES)[number] };
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
export interface EmbeddingRequest {
	inputs: readonly EmbeddingInput[];
	task: EmbeddingTask;
	profile: EmbeddingProfile;
	signal?: AbortSignal;
	priority?: "foreground" | "background";
	timeoutMs?: number;
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
export interface EmbeddingService {
	embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}
export type EmbeddingErrorCode =
	| "invalid-input"
	| "unsupported"
	| "profile-mismatch"
	| "invalid-response"
	| "unavailable"
	| "paused"
	| "cancelled"
	| "timeout";
export class EmbeddingError extends Error {
	constructor(
		public readonly code: EmbeddingErrorCode,
		message: string,
	) {
		super(message);
		this.name = "EmbeddingError";
	}
}
