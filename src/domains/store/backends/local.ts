// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	createLocalStoreBackend as createPackageLocalBackend,
	createSharedStoreBackend as createPackageSharedBackend,
	type StoreBackend,
	type StoreRootSpec,
} from "@pancode/store";
import {
	storePlacementRules,
	storeProjectIdFor,
	storeProjectKeyFor,
	storeProjectRoot,
	storeRootSpecs,
} from "../../../core/store-paths.js";
import { pancodeCachePath, pancodeDataDir } from "../../../core/xdg.js";
import { withFileMutationQueue } from "../../../tools/file-mutation-queue.js";

function projectOptions(cwd: string) {
	const projectRoot = storeProjectRoot(cwd);
	const projectId = storeProjectIdFor(projectRoot);
	return {
		cacheDir: pancodeCachePath(),
		projectKey: storeProjectKeyFor(projectRoot),
		...(projectId !== undefined ? { projectId } : {}),
		projectRoot,
		serialize: withFileMutationQueue,
	};
}

/** The local backend for the project `cwd` belongs to: plain files under the roots settings configure. */
export function createLocalStoreBackend(cwd: string): StoreBackend {
	return createPackageLocalBackend({
		roots: storeRootSpecs(),
		placement: storePlacementRules(),
		...projectOptions(cwd),
		// The store is owner-only like transcripts; this gives a missing data root its 0700 mode and root marker.
		prepareRoot: () => {
			pancodeDataDir();
		},
	});
}

/** The shared backend for the project `cwd` belongs to: plain files in the folder `store.shared` names. */
export function createSharedStoreBackend(cwd: string): StoreBackend {
	return createPackageSharedBackend({ root: (storeRootSpecs()[0] as StoreRootSpec).path, ...projectOptions(cwd) });
}
