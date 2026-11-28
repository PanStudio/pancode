// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export { embeddingCanaryFingerprint, embeddingGemma2Q8Profile, embeddingProfileIdentity } from "./profile.js";
export { qualifyEmbeddingProfile } from "./qualification.js";
export type { EmbeddingRoute } from "./service.js";
export { createEmbeddingService } from "./service.js";
export type {
	EmbeddingErrorCode,
	EmbeddingInput,
	EmbeddingPart,
	EmbeddingProfile,
	EmbeddingRequest,
	EmbeddingResponse,
	EmbeddingService,
	EmbeddingTask,
} from "./types.js";
export { EMBEDDING_AUDIO_MIME_TYPES, EMBEDDING_IMAGE_MIME_TYPES, EmbeddingError } from "./types.js";
