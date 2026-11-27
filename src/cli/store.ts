// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pancode store`: the store's command line (`@pancode/store/cli`) hosted by the harness. This file builds the
 * context only the harness knows: the configured roots, PanCode's cache directory, the project a working directory
 * belongs to, the producing run a put's source came from, and the terminal confirmation. `login` and `logout`, which
 * keep an s3 bucket's secret key in PanCode's credential store, are the harness's own.
 */
import type { StoreVerifyResult } from "@pancode/store";
import {
	runStoreCli,
	type StoreCliContext,
	type StoreCliOutput,
	storeCliAdopt,
	storeCliHelp,
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
	storeBackendKind,
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
		...(storeBackendKind() === "shared" ? { shared: true } : {}),
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

const CREDENTIAL_HELP = `
Credentials for an s3 store (store.backend: s3):
  pancode store login     read the secret key of store.s3.accessKeyId from a
                          prompt or stdin, check it against the bucket, and
                          keep it in PanCode's credential store
  pancode store logout    remove the stored secret key
`;

/** `pancode store login`: check the secret key against the configured bucket, then store it. */
async function storeLogin(cwd: string): Promise<number> {
	const [
		{ default: chalk },
		{ readApiKey },
		shared,
		{ configuredBucket, s3BackendWithKey, STORE_S3_CREDENTIAL_ID },
		auth,
	] = await Promise.all([
		import("chalk"),
		import("./auth.js"),
		import("./shared.js"),
		import("../domains/store/backends/s3.js"),
		import("../domains/providers/auth/index.js"),
	]);
	let bucket: ReturnType<typeof configuredBucket>;
	try {
		bucket = configuredBucket();
	} catch (error) {
		shared.printError(`pancode store login: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const key = await readApiKey(`Secret key for S3 access key ${bucket.accessKeyId} (${bucket.endpoint})`);
	if (key === null || key.length === 0) {
		shared.printError(key === null ? "login cancelled" : "empty secret key");
		return 1;
	}
	try {
		await s3BackendWithKey(cwd, key).listTags();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		shared.printError(`pancode store login: ${message.replace(/\.$/u, "")}; the key was not stored`);
		return 1;
	}
	const storage = auth.openAuthStorage();
	try {
		storage.setApiKey(STORE_S3_CREDENTIAL_ID, key);
	} catch (error) {
		shared.printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (shared.credentialWriteFailed(storage, "the S3 secret key was not stored")) return 1;
	shared.printOk(`stored the secret key for ${bucket.accessKeyId}; bucket ${bucket.bucket} answered`);
	process.stderr.write(
		`${chalk.yellow("warning:")} the secret key is stored unencrypted at ${auth.authStoragePath()} (${shared.credentialFileProtection()}); it is readable by any process running as you.\n`,
	);
	return 0;
}

async function storeLogout(): Promise<number> {
	const [shared, { STORE_S3_CREDENTIAL_ID }, auth] = await Promise.all([
		import("./shared.js"),
		import("../domains/store/backends/s3.js"),
		import("../domains/providers/auth/index.js"),
	]);
	const storage = auth.openAuthStorage();
	if (storage.get(STORE_S3_CREDENTIAL_ID) === undefined) {
		shared.printOk("no S3 secret key is stored");
		return 0;
	}
	storage.remove(STORE_S3_CREDENTIAL_ID);
	if (shared.credentialWriteFailed(storage, "the S3 secret key was not removed")) return 1;
	shared.printOk("removed the stored S3 secret key");
	return 0;
}

export async function runStoreCommand(argv: ReadonlyArray<string>): Promise<number> {
	const cwd = process.cwd();
	if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
		const stream = argv.length === 0 ? process.stderr : process.stdout;
		stream.write(`${storeCliHelp("pancode store")}${CREDENTIAL_HELP}`);
		return argv.length === 0 ? 2 : 0;
	}
	if (argv.length === 1 && argv[0] === "login") return storeLogin(cwd);
	if (argv.length === 1 && argv[0] === "logout") return storeLogout();
	return runStoreCli(argv, storeCliContext(cwd));
}
