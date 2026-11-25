// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pancode store`: the store's command line (`@pancode/store/cli`) hosted by the harness. This file builds the
 * context only the harness knows: the configured roots, PanCode's cache directory, the project a working directory
 * belongs to, the producing run a put's source came from, and the terminal confirmation.
 */
import type { StoreVerifyResult } from "@pancode/store";
import {
	runStoreCli,
	type StoreCliContext,
	type StoreCliOutput,
	storeCliAdopt,
	storeCliPut,
	storeCliRemoveTag,
	storeCliResult,
	storeCliTags,
	storeCliVerify,
	storeCliWhere,
} from "@pancode/store/cli";
// Settings register the store's roots and the project's store.projectId with store-paths when they load.
import "../core/config.js";
import { RUN_FILE_HASH_MAX_BYTES } from "../core/run-records.js";
import {
	storePlacementRules,
	storeProjectIdFor,
	storeProjectKeyFor,
	storeProjectRoot,
	storeRootSpecs,
} from "../core/store-paths.js";
import { pancodeCachePath } from "../core/xdg.js";
import { openStoreBackend, type StoreBackend } from "../domains/store/index.js";
import { buildPutRecord, putHashObservation } from "../domains/store/provenance.js";
import { confirmAction } from "./kit/confirm.js";

export type VerifyResult = StoreVerifyResult;

/** A command run from a shell writes its records as `standalone`, whoever runs it. */
function storeCliContext(cwd: string, openBackend: (cwd: string) => Promise<StoreBackend> = openStoreBackend) {
	const projectRoot = storeProjectRoot(cwd);
	const projectId = storeProjectIdFor(projectRoot);
	const context: StoreCliContext = {
		cwd,
		roots: storeRootSpecs(),
		placement: storePlacementRules(),
		cacheDir: pancodeCachePath(),
		projectRoot,
		projectKey: storeProjectKeyFor(projectRoot),
		...(projectId !== undefined ? { projectId } : {}),
		actor: { actor: "standalone" },
		command: "pancode store",
		hashMaxBytes: RUN_FILE_HASH_MAX_BYTES,
		provenance: ({ backend, tag, blob, sourceAbs, stored, note }) =>
			buildPutRecord({
				backend,
				cwd,
				tag,
				blob,
				sourceAbs,
				stat: stored,
				hash: putHashObservation(stored),
				receipt: { backend: backend.kind, key: stored.key, version: stored.version },
				actor: "standalone",
				...(note !== undefined ? { note } : {}),
			}),
		// Without --yes a person at a terminal is asked (C8); a decline or no terminal keeps the v1 answer, a preview
		// that deletes nothing and exits 0, since C8's exit 2 and 1 there change an exit code (NIGHT-DECISIONS 2).
		confirm: async (question) => (await confirmAction({ question, yes: false })).proceed,
		openBackend: () => openBackend(cwd),
	};
	return context;
}

export function storeTags(cwd: string) {
	return storeCliTags(storeCliContext(cwd));
}

export function storeVerify(
	cwd: string,
	tag: string,
	options: { pattern?: string; hashLarge?: boolean; recordUnrecorded?: boolean; signal?: AbortSignal } = {},
): Promise<VerifyResult> {
	return storeCliVerify(storeCliContext(cwd), tag, options);
}

export function storePut(
	cwd: string,
	tag: string,
	file: string,
	options: {
		blob?: string;
		note?: string;
		link?: boolean;
		signal?: AbortSignal;
		/** Test seam; production opens the selected backend. */
		openBackend?: (cwd: string) => Promise<StoreBackend>;
	} = {},
) {
	const { openBackend, ...rest } = options;
	return storeCliPut(storeCliContext(cwd, openBackend), tag, file, rest);
}

export function storeRemoveTag(cwd: string, tag: string, yes: boolean) {
	return storeCliRemoveTag(storeCliContext(cwd), tag, yes);
}

/** Bare: store directories whose recorded project root is gone. With a key: move that store to this project. */
export function storeAdopt(cwd: string, key?: string) {
	return storeCliAdopt(storeCliContext(cwd), key);
}

export async function storeWhere(cwd: string) {
	return storeCliWhere(storeCliContext(cwd));
}

/** One store subcommand's exit code and output, from argv already split at the subcommand. */
export async function storeCommandResult(argv: ReadonlyArray<string>, cwd: string): Promise<StoreCliOutput> {
	return storeCliResult(argv, storeCliContext(cwd));
}

export function runStoreCommand(argv: ReadonlyArray<string>): Promise<number> {
	return runStoreCli(argv, storeCliContext(process.cwd()));
}
