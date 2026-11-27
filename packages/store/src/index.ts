// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export const PACKAGE = "@pancode/store" as const;

export * from "./backend/index.js";
export { hashStoreFile } from "./hash.js";
export { ensureStoreRootId, readStoreRootId, STORE_ROOT_FILE } from "./identity.js";
export { createLocalStoreBackend, type LocalStoreOptions, STORE_CLASS_XATTR } from "./local.js";
export {
	breakStoreLock,
	listStoreLocks,
	readStoreLock,
	type StoreLockOptions,
	storeLockId,
	withStoreLock,
} from "./lock.js";
export * from "./paths/index.js";
export {
	type RecordedPutOptions,
	type RecordedPutResult,
	type RecordedRemoveResult,
	recordedPut,
	recordedRemove,
	type StorePutRecordFields,
	storeBlobLockKey,
} from "./recorded.js";
export {
	appendRecord,
	currentState,
	driftOf,
	readBlobHistory,
	type StoreDrift,
	type StoreRecord,
	type StoreRecordActor,
	type StoreRecordBody,
	type StoreRecordIdentity,
	type StoreRecordProducer,
	type StoreRecordUse,
	summarizeRecords,
} from "./records.js";
export { createS3StoreBackend, S3_LEASE_EXPIRY_MS, S3_PUT_MAX_BYTES, type S3StoreOptions } from "./s3/backend.js";
export {
	allStoreBlobs,
	recordedStoreBlobNames,
	type StoreVerifyOptions,
	type StoreVerifyResult,
	type StoreVerifyStatus,
	verifyStoreTag,
} from "./verify.js";
