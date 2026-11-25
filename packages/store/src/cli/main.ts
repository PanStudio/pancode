#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `panstore`: the store's command line without PanCode. The package knows nothing of PanCode's data directory,
 * so the store root is always named; `pancode store where` prints the full command line for a project.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseStoreRootOption,
	type StoreRootSpec,
	storeProjectKey,
	storeProjectKeyForId,
	storeProjectRootOf,
	validateStoreProjectId,
	validateStoreRoots,
} from "../paths/index.js";
import { runStoreCli, storeCliHelp } from "./index.js";

const USAGE = `panstore --version
panstore --root [<name>=]<dir> [--root <name>=<dir> ...] [--cache <dir>] [--project <dir>] [--project-id <id>] <command> ...

--root     a store root; the first is the primary. Repeat with <name>=<dir> for each further root.
           The first is named default unless given as <name>=<dir> too.
--cache    where get keeps its read-only copies; default $XDG_CACHE_HOME/panstore.
--project  any directory of the project; default the current directory. Every checkout
           and task worktree of one repository reaches the same store.
--project-id  the project id the project's tracked settings give it (store.projectId);
              default $PANSTORE_PROJECT_ID. The store is keyed by the id, so checkouts at
              different paths on different hosts reach one store.

Records this command writes name the actor standalone. locks lists this project's
store locks and locks break <id> removes one whose writer is gone.

`;

interface PanstoreArgs {
	roots: StoreRootSpec[];
	cacheDir: string;
	project: string;
	projectId?: string;
	rest: string[];
}

class PanstoreUsageError extends Error {}

function defaultCacheDir(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".cache");
	return path.join(base, "panstore");
}

const OPTIONS = new Set(["--root", "--cache", "--project", "--project-id"]);

function parse(argv: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv): PanstoreArgs {
	const roots: StoreRootSpec[] = [];
	let cacheDir: string | undefined;
	let project: string | undefined;
	let projectId: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (!OPTIONS.has(arg)) {
			rest.push(arg);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.length === 0) throw new PanstoreUsageError(`${arg} needs a value`);
		i++;
		if (arg === "--cache") cacheDir = path.resolve(cwd, value);
		else if (arg === "--project") project = path.resolve(cwd, value);
		else if (arg === "--project-id") projectId = value;
		else {
			const root = parseStoreRootOption(value, roots.length === 0, cwd);
			if (root === null) throw new PanstoreUsageError(`each --root after the first is <name>=<dir>, got '${value}'`);
			roots.push(root);
		}
	}
	if (roots.length === 0) {
		throw new PanstoreUsageError("--root is required (pancode store where prints the full command line)");
	}
	const problem = validateStoreRoots(roots);
	if (problem !== null) throw new PanstoreUsageError(problem);
	const envId = env.PANSTORE_PROJECT_ID;
	const id = projectId ?? (envId !== undefined && envId.length > 0 ? envId : undefined);
	if (id !== undefined) {
		const idProblem = validateStoreProjectId(id);
		if (idProblem !== null) {
			throw new PanstoreUsageError(
				`${projectId !== undefined ? "--project-id" : "PANSTORE_PROJECT_ID"} ${id}: ${idProblem}`,
			);
		}
	}
	return {
		roots,
		cacheDir: cacheDir ?? defaultCacheDir(),
		project: project ?? cwd,
		...(id !== undefined ? { projectId: id } : {}),
		rest,
	};
}

/** The nearest package.json above this file: the store's own, or the PanCode package that bundles the CLI. */
function version(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = path.join(dir, "package.json");
		if (existsSync(manifest)) {
			const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
			return typeof parsed.version === "string" ? parsed.version : "unknown";
		}
		const parent = path.dirname(dir);
		if (parent === dir) return "unknown";
		dir = parent;
	}
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
		process.stdout.write(`${version()}\n`);
		return 0;
	}
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(USAGE + storeCliHelp("panstore"));
		return 0;
	}
	if (argv.length === 0) {
		process.stderr.write(USAGE + storeCliHelp("panstore"));
		return 2;
	}
	const cwd = process.cwd();
	let args: PanstoreArgs;
	try {
		args = parse(argv, cwd, process.env);
	} catch (error) {
		if (!(error instanceof PanstoreUsageError)) throw error;
		process.stderr.write(`panstore: ${error.message}\nsee: panstore --help\n`);
		if (argv.includes("--json")) {
			const document = { version: 1, ok: false, message: error.message, error: { code: "usage", message: error.message } };
			process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
		}
		return 2;
	}
	const projectRoot = storeProjectRootOf(args.project);
	return runStoreCli(args.rest, {
		cwd,
		roots: args.roots,
		cacheDir: args.cacheDir,
		projectRoot,
		projectKey: args.projectId !== undefined ? storeProjectKeyForId(args.projectId) : storeProjectKey(projectRoot),
		...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
		actor: { actor: "standalone" },
		command: "panstore",
	});
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`panstore: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
