// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pancode mcp serve <server> [options...]`: one of PanCode's built-in MCP
 * servers over stdio, for any MCP client. Each option the command line leaves
 * out is the one a PanCode session starts the server with: the catalog file
 * and reader cache under PanCode's own directories, and for `store` the
 * project's store at the working directory with nothing writable.
 */
import path from "node:path";
import { serveServer } from "@pancode/kit";
// Settings register the store's roots and the project's store.projectId with store-paths when they load.
import "../core/config.js";
import { storeProjectIdFor, storeProjectRoot, storeRootSpecs } from "../core/store-paths.js";
import { pancodeCachePath } from "../core/xdg.js";
import { mcpBuiltinLaunchArgs } from "../domains/gateway/mcp/builtin.js";

/** The option names `argv` uses, `--name=value` counted as `--name`. */
function optionNames(argv: ReadonlyArray<string>): Set<string> {
	return new Set(argv.filter((arg) => arg.startsWith("--")).map((arg) => arg.split("=", 1)[0] as string));
}

function optionValue(argv: ReadonlyArray<string>, name: string): string | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		if (arg === name) return argv[index + 1];
		if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
	}
	return undefined;
}

/** What a session would start server `id` with for the project at `cwd`, before dropping what `given` names. */
function sessionOptions(id: string, given: ReadonlyArray<string>, cwd: string): string[] {
	if (id !== "store") return mcpBuiltinLaunchArgs(id, {});
	const project = storeProjectRoot(path.resolve(cwd, optionValue(given, "--project") ?? "."));
	const projectId = storeProjectIdFor(project);
	return mcpBuiltinLaunchArgs("store", {
		store: {
			roots: storeRootSpecs(),
			cache: pancodeCachePath(),
			project,
			...(projectId !== undefined ? { projectId } : {}),
			writeTags: [],
		},
	});
}

/** The session's options for `id` whose names `given` does not use; every `--root` goes when one is given. */
function mcpServeDefaults(id: string, given: ReadonlyArray<string>, cwd: string = process.cwd()): string[] {
	const named = optionNames(given);
	const options = sessionOptions(id, given, cwd);
	const added: string[] = [];
	for (let index = 0; index < options.length; index += 2) {
		const name = options[index] as string;
		if (!named.has(name)) added.push(name, options[index + 1] as string);
	}
	return added;
}

export function runMcpServe(argv: ReadonlyArray<string>): Promise<number> {
	return serveServer(argv, (id, given) => mcpServeDefaults(id, given));
}
