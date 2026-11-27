// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	type ChildProcess,
	type ExecFileException,
	type ExecFileOptionsWithBufferEncoding,
	type ExecFileOptionsWithStringEncoding,
	type ExecFileSyncOptions,
	type ExecFileSyncOptionsWithBufferEncoding,
	type ExecFileSyncOptionsWithStringEncoding,
	execFile,
	execFileSync,
	type SpawnOptions,
	type SpawnSyncOptions,
	type SpawnSyncOptionsWithBufferEncoding,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	spawn,
	spawnSync,
} from "node:child_process";
import { promisify } from "node:util";
import { internalGitArgv } from "./internal-git.js";

/**
 * The one place PanCode starts git on its own (`tests/boundaries/check-boundaries.ts` rule 24). Each function is
 * its `node:child_process` namesake with the program fixed to git and `args` passed through {@link internalGitArgv},
 * resolved against `options.cwd`. A refused read throws {@link InternalGitRefusedError} before anything runs, from the
 * sync forms and {@link gitExecFile} and {@link gitSpawn} synchronously, as a rejection from the promise forms.
 *
 * The typed git tool (`src/tools/safe-exec.ts`) is the agent's git and stays outside: it carries its own host config,
 * and its add and commit run the repository's hooks on purpose.
 *
 * @module
 */

type At<T> = Omit<T, "cwd"> & { cwd?: string | undefined };

export function gitExecFileSync(
	args: ReadonlyArray<string>,
	options: At<ExecFileSyncOptionsWithStringEncoding>,
): string;
export function gitExecFileSync(
	args: ReadonlyArray<string>,
	options?: At<ExecFileSyncOptionsWithBufferEncoding>,
): Buffer;
export function gitExecFileSync(args: ReadonlyArray<string>, options: At<ExecFileSyncOptions> = {}): string | Buffer {
	return execFileSync("git", internalGitArgv(args, options.cwd), options);
}

export function gitSpawnSync(
	args: ReadonlyArray<string>,
	options: At<SpawnSyncOptionsWithStringEncoding>,
): SpawnSyncReturns<string>;
export function gitSpawnSync(
	args: ReadonlyArray<string>,
	options?: At<SpawnSyncOptionsWithBufferEncoding>,
): SpawnSyncReturns<Buffer>;
export function gitSpawnSync(
	args: ReadonlyArray<string>,
	options: At<SpawnSyncOptions> = {},
): SpawnSyncReturns<string | Buffer> {
	return spawnSync("git", internalGitArgv(args, options.cwd), options);
}

export function gitExecFile(
	args: ReadonlyArray<string>,
	options: At<ExecFileOptionsWithStringEncoding>,
	callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess {
	return execFile("git", internalGitArgv(args, options.cwd), options, callback);
}

const execFileAsync = promisify(execFile);

export async function gitExecFileAsync(
	args: ReadonlyArray<string>,
	options: At<ExecFileOptionsWithBufferEncoding>,
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function gitExecFileAsync(
	args: ReadonlyArray<string>,
	options?: At<ExecFileOptionsWithStringEncoding>,
): Promise<{ stdout: string; stderr: string }>;
export async function gitExecFileAsync(
	args: ReadonlyArray<string>,
	options: At<ExecFileOptionsWithStringEncoding> | At<ExecFileOptionsWithBufferEncoding> = {},
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
	return execFileAsync("git", internalGitArgv(args, options.cwd), options);
}

export function gitSpawn(args: ReadonlyArray<string>, options: At<SpawnOptions> = {}): ChildProcess {
	return spawn("git", internalGitArgv(args, options.cwd), options);
}

/**
 * Git through another runner that takes a program, its words and options, such as `runCommandVector` or
 * `runStagingCommandSync` (`src/core/safe-exec.ts`): the runner keeps its own sandbox, env and output limits, and this
 * module never loads it.
 */
export function gitVia<O extends { cwd?: string } | undefined, R>(
	run: (file: string, args: ReadonlyArray<string>, options: O) => R,
	args: ReadonlyArray<string>,
	options: NoInfer<O>,
): R {
	return run("git", internalGitArgv(args, options?.cwd), options);
}
