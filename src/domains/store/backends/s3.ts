// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createS3StoreBackend as createPackageS3Backend, type StoreBackend, StoreRefusal } from "@pancode/store";
import type { StoreS3Setting } from "../../../core/defaults.js";
import { storeProjectIdFor, storeProjectKeyFor, storeProjectRoot, storeS3Settings } from "../../../core/store-paths.js";
import { pancodeCachePath } from "../../../core/xdg.js";
import { openAuthStorage } from "../../providers/auth/index.js";

/** The credential store entry `pancode store login` keeps the bucket's secret key under. */
export const STORE_S3_CREDENTIAL_ID = "store-s3";

/** The s3 backend for the project `cwd` belongs to, in the bucket settings name, with the stored secret key. */
export function createS3StoreBackend(cwd: string): StoreBackend {
	const credential = openAuthStorage().get(STORE_S3_CREDENTIAL_ID);
	if (credential?.type !== "api_key")
		throw new StoreRefusal(
			"unavailable",
			`No secret key is stored for the S3 access key ${configuredBucket().accessKeyId}; run pancode store login.`,
		);
	return s3BackendWithKey(cwd, credential.key);
}

/** The bucket settings name; refused when they name none. */
export function configuredBucket(): StoreS3Setting {
	const settings = storeS3Settings();
	if (settings === null) throw new StoreRefusal("unavailable", "store.s3 names no bucket; set it in user settings.");
	return settings;
}

/** The s3 backend for `cwd` with `secretAccessKey`, which `pancode store login` checks before storing it. */
export function s3BackendWithKey(cwd: string, secretAccessKey: string): StoreBackend {
	const settings = configuredBucket();
	const projectRoot = storeProjectRoot(cwd);
	const projectId = storeProjectIdFor(projectRoot);
	return createPackageS3Backend({
		...settings,
		secretAccessKey,
		cacheDir: pancodeCachePath(),
		projectKey: storeProjectKeyFor(projectRoot),
		...(projectId !== undefined ? { projectId } : {}),
		projectRoot,
	});
}
