// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createLocalStoreBackend as createPackageLocalBackend, type StoreBackend } from "@pancode/store";
import {
	storePlacementRules,
	storeProjectIdFor,
	storeProjectKeyFor,
	storeProjectRoot,
	storeRootSpecs,
} from "../../../core/store-paths.js";
import { pancodeCachePath, pancodeDataDir } from "../../../core/xdg.js";
import { withFileMutationQueue } from "../../../tools/file-mutation-queue.js";

/** The local backend for the project `cwd` belongs to: plain files under the roots settings configure. */
export function createLocalStoreBackend(cwd: string): StoreBackend {
	const projectRoot = storeProjectRoot(cwd);
	const projectId = storeProjectIdFor(projectRoot);
	return createPackageLocalBackend({
		roots: storeRootSpecs(),
		placement: storePlacementRules(),
		cacheDir: pancodeCachePath(),
		projectKey: storeProjectKeyFor(projectRoot),
		...(projectId !== undefined ? { projectId } : {}),
		projectRoot,
		// The store is owner-only like transcripts; this gives a missing data root its 0700 mode and root marker.
		prepareRoot: () => {
			pancodeDataDir();
		},
		serialize: withFileMutationQueue,
	});
}
