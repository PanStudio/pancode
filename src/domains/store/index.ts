// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { StoreBackend } from "@pancode/store/backend";
import { storeProjectDir } from "../../core/store-paths.js";

export type {
	StoreBackend,
	StoreBackendFacts,
	StoreBackendKind,
	StoreBlobPut,
	StoreBlobStat,
	StoreRefusalReason,
	StoreTagClass,
} from "@pancode/store/backend";
export { compileBlobPattern, StoreRefusal } from "@pancode/store/backend";

/** The store backend for this project: the local backend, plain files under the data directory. */
export async function openStoreBackend(cwd: string): Promise<StoreBackend> {
	const { createLocalStoreBackend } = await import("./backends/local.js");
	return createLocalStoreBackend(cwd);
}

/** Run fn while holding the store lock for key in the project `cwd` belongs to. */
export async function withStoreLock<T>(cwd: string, key: string, fn: () => Promise<T>): Promise<T> {
	const projectDir = storeProjectDir(cwd);
	const { withStoreLock: withProjectLock } = await import("@pancode/store");
	return withProjectLock(projectDir, key, fn);
}
export { workspaceCapabilitySignals, workspaceStoreTags } from "./workspace-signal.js";
