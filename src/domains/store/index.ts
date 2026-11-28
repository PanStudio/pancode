// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { StoreBackend } from "@pancode/store/backend";
import { storeBackendKind } from "../../core/store-paths.js";

export type {
	StoreBackend,
	StoreBlobStat,
	StoreTagClass,
} from "@pancode/store/backend";
export { StoreRefusal } from "@pancode/store/backend";

/**
 * The store backend for this project, of the kind `store.backend` selects: local, plain files under the
 * configured roots; shared, a fenced change log in a folder several hosts mount; or s3, a bucket of an
 * S3-compatible service.
 */
export async function openStoreBackend(cwd: string): Promise<StoreBackend> {
	const kind = storeBackendKind();
	if (kind === "s3") {
		const { createS3StoreBackend } = await import("./backends/s3.js");
		return createS3StoreBackend(cwd);
	}
	const { createLocalStoreBackend, createSharedStoreBackend } = await import("./backends/local.js");
	return kind === "shared" ? createSharedStoreBackend(cwd) : createLocalStoreBackend(cwd);
}

/** Run fn while holding the store lock for key in the project `cwd` belongs to. */
export async function withStoreLock<T>(cwd: string, key: string, fn: () => Promise<T>): Promise<T> {
	return (await openStoreBackend(cwd)).withLock(key, fn);
}
export { workspaceCapabilitySignals, workspaceStoreTags } from "./workspace-signal.js";
