// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export type { StoreBackend } from "./backend.js";
export { registerStoreBackend, resolveStoreBackend, type StoreBackendFactory } from "./registry.js";
export type {
	StoreBackendFacts,
	StoreBackendKind,
	StoreBlobPut,
	StoreBlobStat,
	StorePutMode,
	StoreRefusalReason,
	StoreRootFacts,
	StoreTagClass,
	StoreUsage,
} from "./types.js";
export { compileBlobPattern, STORE_PATTERN_MAX_LENGTH, StoreRefusal } from "./types.js";
