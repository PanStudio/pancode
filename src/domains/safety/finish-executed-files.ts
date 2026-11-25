// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { resolve } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import { SHELL_ASSIGNMENT } from "./declared-checks.js";
import { asRecord, capabilityEntries, stringFromFirst, successfulToolResultId, turnIdOf } from "./finish-entries.js";
import { bashExecutionMutationPaths, mutatingToolCall } from "./finish-mutations.js";
import { scanShellLike, shellCommandWords, splitSegments } from "./shell-scan.js";

/**
 * The changed files a successful command ran after their last edit: the
 * script of an interpreter (`python3 -B src/clean.py`, also under `uv run`), a
 * command word with a path (`./run.sh`), or the manifest a project runner
 * reads (`make`'s makefile, `npm run`'s `package.json`). A call that both edits and runs a file does not count, so
 * the run is known to postdate the edit.
 */
export function changedFilesRunAfterEdit(
	window: ReadonlyArray<unknown>,
	mutatedPaths: ReadonlyArray<string>,
	workspaceRoot: string | undefined,
): string[] {
	const root = resolve(workspaceRoot ?? ".");
	const lastEdit = new Map<string, number>();
	const lastRun = new Map<string, number>();
	const edits = new Map<string, string[]>();
	const runs = new Map<string, string[]>();
	const mark = (marks: Map<string, number>, paths: ReadonlyArray<string>, index: number) => {
		for (const path of paths) marks.set(resolve(root, path), index);
	};
	for (const [index, entry] of capabilityEntries(window).entries()) {
		const bashMutation = bashExecutionMutationPaths(entry);
		if (bashMutation !== null) {
			const record = asRecord(entry);
			mark(lastEdit, bashMutation.paths, index);
			mark(lastRun, executedFiles(String(record?.command), record?.cwd, root), index);
			continue;
		}
		const call = mutatingToolCall(entry);
		if (call !== null) edits.set(call.toolCallId, call.paths);
		const record = asRecord(entry);
		const payload = record?.kind === "message" && record.role === "tool_call" ? asRecord(record.payload) : null;
		if (payload !== null && stringFromFirst(payload, ["name", "toolName", "tool"]) === ToolNames.Bash) {
			const args = asRecord(payload.args ?? payload.arguments ?? payload.input);
			const toolCallId = stringFromFirst(payload, ["toolCallId", "tool_call_id", "id"]) ?? turnIdOf(entry);
			if (typeof args?.command === "string" && toolCallId !== null)
				runs.set(toolCallId, executedFiles(args.command, args.cwd, root));
			continue;
		}
		const resultId = successfulToolResultId(entry);
		if (resultId === null) continue;
		mark(lastEdit, edits.get(resultId) ?? [], index);
		mark(lastRun, runs.get(resultId) ?? [], index);
	}
	return mutatedPaths.filter((path) => {
		const key = resolve(root, path);
		return (lastRun.get(key) ?? -1) > (lastEdit.get(key) ?? Number.POSITIVE_INFINITY);
	});
}

const SCRIPT_INTERPRETERS =
	/^(?:python[0-9.]*|pypy[0-9.]*|node|bash|sh|zsh|dash|ruby|perl|php|Rscript|deno|bun|tsx|ts-node|lua|julia)$/u;

/** Interpreter options that run inline code or a module rather than a script file. */
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "-m", "-p", "--eval", "--print"]);

const RUN_PREFIX_WORDS = new Set(["command", "env", "exec", "nice", "nohup", "time"]);

/** Environment runners whose `run` executes the command after it: `uv run src/clean.py`, `poetry run python x.py`. */
const ENV_RUNNERS = new Set(["uv", "poetry", "pipenv", "pdm"]);

/** Runner options that take the next word as their value. */
const RUNNER_VALUE_OPTIONS = new Set([
	"--with",
	"-w",
	"--with-requirements",
	"--with-editable",
	"--python",
	"-p",
	"--project",
	"--directory",
	"--package",
	"--env-file",
	"--extra",
	"--group",
	"--only-group",
	"--index",
	"--from",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

/** Package-manager subcommands that run a script `package.json` declares. */
const PACKAGE_SCRIPT_COMMANDS = new Set(["run", "run-script", "test", "t", "start"]);

const PACKAGE_DIRECTORY_OPTIONS = new Set(["--prefix", "-C", "--dir", "--cwd"]);

const MAKEFILE_NAMES = ["GNUmakefile", "makefile", "Makefile"];

/** The makefiles a `make` invocation reads: `-f` names them, otherwise the default names in its `-C` directory. */
function makefilesRead(words: ReadonlyArray<string>, from: number, directory: string): string[] {
	let dir = directory;
	const named: string[] = [];
	for (let index = from; index < words.length; index += 1) {
		const word = words[index] as string;
		const value = (long: string, short: string): string | undefined => {
			if (word === short || word === long) {
				index += 1;
				return words[index];
			}
			if (word.startsWith(`${long}=`)) return word.slice(long.length + 1);
			if (word.startsWith(short) && word.length > short.length) return word.slice(short.length);
			return undefined;
		};
		const cd = value("--directory", "-C");
		if (cd !== undefined) {
			dir = resolve(dir, cd);
			continue;
		}
		const file = value("--file", "-f") ?? (word.startsWith("--makefile=") ? word.slice(11) : undefined);
		if (file !== undefined) named.push(file);
	}
	return (named.length > 0 ? named : MAKEFILE_NAMES).map((name) => resolve(dir, name));
}

/** The `package.json` a package manager reads to run one of its scripts, or null when the command runs none. */
function packageScriptManifest(words: ReadonlyArray<string>, from: number, directory: string): string | null {
	let dir = directory;
	for (let index = from; index < words.length; index += 1) {
		const word = words[index] as string;
		if (PACKAGE_DIRECTORY_OPTIONS.has(word)) {
			const value = words[index + 1];
			if (value !== undefined) dir = resolve(dir, value);
			index += 1;
			continue;
		}
		if (word.startsWith("-")) continue;
		return PACKAGE_SCRIPT_COMMANDS.has(word) ? resolve(dir, "package.json") : null;
	}
	return null;
}

/** The files a shell command executes by name, resolved against its cwd and any literal `cd` before them. */
function executedFiles(command: string, cwd: unknown, root: string): string[] {
	let directory = resolve(root, typeof cwd === "string" ? cwd : ".");
	const files: string[] = [];
	for (const segment of splitSegments(scanShellLike(command))) {
		const words = shellCommandWords(segment)
			.filter((token) => !token.substitutions?.length && !token.homeRelative && !/[$`]/u.test(token.value))
			.map((token) => token.value);
		let at = 0;
		while (at < words.length) {
			const word = words[at] as string;
			if (SHELL_ASSIGNMENT.test(word) || RUN_PREFIX_WORDS.has(word)) at += 1;
			else if (word === "timeout") at += 2;
			else break;
		}
		let head = words[at];
		if (head === undefined) continue;
		if (head === "cd") {
			if (words[at + 1] !== undefined) directory = resolve(directory, words[at + 1] as string);
			continue;
		}
		const program = head.slice(head.lastIndexOf("/") + 1);
		if (program === "make" || program === "gmake") {
			files.push(...makefilesRead(words, at + 1, directory));
			continue;
		}
		if (PACKAGE_MANAGERS.has(program)) {
			const manifest = packageScriptManifest(words, at + 1, directory);
			if (manifest !== null) files.push(manifest);
			continue;
		}
		let underRunner = false;
		if (ENV_RUNNERS.has(program) && words[at + 1] === "run") {
			at += 2;
			while (at < words.length && (words[at] as string).startsWith("-")) {
				const option = words[at] as string;
				at += RUNNER_VALUE_OPTIONS.has(option) ? 2 : 1;
			}
			head = words[at];
			if (head === undefined) continue;
			underRunner = true;
		}
		let script: string | undefined;
		if (SCRIPT_INTERPRETERS.test(head.slice(head.lastIndexOf("/") + 1))) {
			for (let index = at + 1; index < words.length; index += 1) {
				const word = words[index] as string;
				if (INLINE_CODE_FLAGS.has(word)) break;
				if (word.startsWith("-") || (index === at + 1 && word === "run")) continue;
				script = word;
				break;
			}
		} else if (head.includes("/") || (underRunner && /\.[A-Za-z]+$/u.test(head))) script = head;
		if (script !== undefined) files.push(resolve(directory, script));
	}
	return files;
}
