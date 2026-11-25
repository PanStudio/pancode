// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../../../core/hash.js";
import type { EmbeddingProfile } from "./types.js";

export function embeddingGemma2Q8Profile(options: {
	model: string;
	assetIdentity: string;
	projectorIdentity?: string;
	canaryFingerprint?: string;
}): EmbeddingProfile {
	return {
		id: "embeddinggemma-2-q8-768",
		model: options.model,
		assetIdentity: options.assetIdentity,
		projectorIdentity: options.projectorIdentity ?? null,
		quantization: "Q8_0",
		dimensions: 768,
		pooling: "mean",
		normalization: "l2",
		queryPrefix: "task: search result | query: ",
		documentPrefix: "title: none | text: ",
		preprocessingVersion: "pancode-embedding-v1",
		canaryFingerprint: options.canaryFingerprint ?? null,
	};
}

export function embeddingProfileIdentity(profile: EmbeddingProfile): string {
	const canonical = Object.fromEntries(
		Object.keys(profile)
			.sort()
			.map((key) => [key, profile[key as keyof EmbeddingProfile]]),
	);
	return sha256Hex(JSON.stringify(canonical));
}

export function embeddingCanaryFingerprint(vectors: readonly (readonly number[])[]): string {
	return sha256Hex(JSON.stringify(vectors.map((vector) => vector.map((value) => Number(value.toFixed(6))))));
}
