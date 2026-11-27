// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The store server's options, the ones `pancode store where` prints, and the
 * configuration they give. The server holds one configuration for its
 * process: `configure` sets it once before serving, and without a `--root`
 * there is none and every tool says so.
 */
import os from "node:os";
import path from "node:path";
import {
	parseStoreRootOption,
	type StoreRootSpec,
	storeProjectKey,
	storeProjectKeyForId,
	storeProjectRootOf,
	validateStoreProjectId,
	validateStoreRoots,
	validateTagName,
} from "@pancode/store";
import { ServerUsageError } from "../../registry.js";

export const USAGE = `options: --root [<name>=]<dir> [--root <name>=<dir> ...] [--shared] [--cache <dir>] [--project <dir>] [--project-id <id>] [--write-tag <tag> ...]
  --root       a store root; the first is the primary. Repeat with <name>=<dir> for each further root.
               The first is named default unless given as <name>=<dir> too.
  --shared     the one root is a folder several hosts share (store.backend shared): every write publishes
               through its log, under a lease taken over from any host 60 s after its last renewal by the folder's clock.
  --cache      where store_get keeps its read-only copies; default ~/.cache/panstore.
  --project    any directory of the project; default the directory the server starts in.
  --project-id the project's store.projectId, which keys its store wherever it is checked out;
               without one the store is keyed by the project's path.
  --write-tag  a tag store_put and store_note may write, with the tags nested under it; repeatable.
               Without one the server writes nothing.
pancode store where prints the --root, --shared, --cache and --project options for a project.
`;

export const NO_ROOT_REASON =
	"no store root was named: start the server with --root <dir> (pancode store where prints the options for a project)";

export interface StoreServerConfig {
	/** Non-empty and valid; the first is the primary. */
	roots: StoreRootSpec[];
	cacheDir: string;
	/** The project's main checkout. */
	projectRoot: string;
	projectKey: string;
	/** The `store.projectId` the key comes from, when one was named. */
	projectId?: string;
	/** Tags the server may write, with the tags nested under each. */
	writeTags: string[];
	/** The one root is a folder several hosts share, written through its log. */
	shared: boolean;
}

const OPTIONS = new Set(["--root", "--cache", "--project", "--project-id", "--write-tag"]);

/**
 * The configuration `argv` gives, or null when it names no `--root`.
 * Throws `ServerUsageError` for an unknown option, a missing value, a value
 * that begins with `-`, a further root without a name, a root set the store
 * refuses, `--shared` with more than one root, an invalid project id or a
 * write tag the store would not accept.
 */
export function parseStoreOptions(argv: ReadonlyArray<string>, cwd: string): StoreServerConfig | null {
	const roots: StoreRootSpec[] = [];
	const writeTags: string[] = [];
	let cacheDir: string | undefined;
	let project: string | undefined;
	let projectId: string | undefined;
	let shared = false;
	for (let i = 0; i < argv.length; i++) {
		const option = argv[i] as string;
		if (option === "--shared") {
			shared = true;
			continue;
		}
		if (!OPTIONS.has(option)) throw new ServerUsageError(`unknown option ${option}`);
		const value = argv[i + 1];
		if (value === undefined || value.length === 0) throw new ServerUsageError(`${option} needs a value`);
		if (value.startsWith("-")) throw new ServerUsageError(`${option} needs a value, got ${value}`);
		i++;
		if (option === "--cache") cacheDir = path.resolve(cwd, value);
		else if (option === "--project") project = path.resolve(cwd, value);
		else if (option === "--project-id") {
			const problem = validateStoreProjectId(value);
			if (problem !== null) throw new ServerUsageError(`--project-id ${value}: ${problem}`);
			projectId = value;
		} else if (option === "--write-tag") {
			const problem = validateTagName(value);
			if (problem !== null) throw new ServerUsageError(`--write-tag ${value}: ${problem}`);
			if (!writeTags.includes(value)) writeTags.push(value);
		} else {
			const root = parseStoreRootOption(value, roots.length === 0, cwd);
			if (root === null) throw new ServerUsageError(`each --root after the first is <name>=<dir>, got ${value}`);
			roots.push(root);
		}
	}
	if (roots.length === 0) return null;
	const problem = validateStoreRoots(roots);
	if (problem !== null) throw new ServerUsageError(problem);
	if (shared && roots.length > 1) throw new ServerUsageError("--shared serves one root, the shared folder");
	const projectRoot = storeProjectRootOf(project ?? cwd);
	return {
		roots,
		cacheDir: cacheDir ?? path.join(os.homedir(), ".cache", "panstore"),
		projectRoot,
		projectKey: projectId !== undefined ? storeProjectKeyForId(projectId) : storeProjectKey(projectRoot),
		...(projectId !== undefined ? { projectId } : {}),
		writeTags,
		shared,
	};
}

let current: StoreServerConfig | null = null;

/** Replace the process's configuration; `configure` is the only caller outside tests. */
export function setStoreConfig(config: StoreServerConfig | null): void {
	current = config;
}

export function storeConfig(): StoreServerConfig | null {
	return current;
}

/** Whether `tag` is a write tag or nested under one. */
export function tagWritable(config: StoreServerConfig, tag: string): boolean {
	return config.writeTags.some((allowed) => tag === allowed || tag.startsWith(`${allowed}/`));
}
