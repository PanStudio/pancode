// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The one way an hpc tool runs a site command (`sbatch`, `module`,
 * `lfs`). No server may import `node:child_process` itself; every command goes
 * through `runCommand`, so each one is an argv array and never a shell
 * string, is bounded in time and output, sees only the environment it names,
 * and stops when its call is cancelled.
 *
 * The program is resolved on `PATH` once, before anything starts: a missing
 * program is reported as `not-found` without spawning, and the absolute path
 * found is what runs, so no second lookup can pick a different file.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Variables every command inherits from the server's environment when they are set. */
export const BASE_ENV_ALLOWLIST: ReadonlyArray<string> = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
];

/** An optional program or file a tool group reads when the host has it: found where, or why not. */
export interface ProbeSource {
	name: string;
	found: boolean;
	detail?: string;
}

/** Captured output kept per stream when the caller names no cap. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Time a stopped command gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 1000;

export interface RunCommandOptions {
	/** Wall-clock limit. Required: a site command that hangs must not hang the call. */
	timeoutMs: number;
	/** Bytes kept of each of stdout and stderr; the rest is read and dropped. Defaults to 1 MiB. */
	maxOutputBytes?: number;
	/** Cancels the command; a call's `context.signal`. */
	signal?: AbortSignal;
	cwd?: string;
	/** Further variable names inherited from this process when set, beyond `BASE_ENV_ALLOWLIST`. */
	envAllowlist?: ReadonlyArray<string>;
	/** Values set for the command, over the inherited ones. `PATH` here also decides where the program is found. */
	env?: Readonly<Record<string, string>>;
	/** Written to stdin, which is then closed. Without it stdin is empty. */
	input?: string;
	/**
	 * Decides, line by line, which stdout lines are kept; a dropped line never
	 * counts toward `maxOutputBytes`. Gets each line without its newline. Kept
	 * lines are whole: the first that does not fit ends the capture and marks
	 * the output truncated, as does a line longer than `maxOutputBytes`.
	 * Without it every line is kept.
	 */
	keepLine?: (line: string) => boolean;
}

/**
 * - `ok`: exit status 0.
 * - `exit`: a non-zero status, or a signal the command did not get from this helper.
 * - `timeout`: stopped at `timeoutMs`.
 * - `aborted`: stopped because `signal` aborted, or never started because it already had.
 * - `not-found`: no executable of that name on `PATH`; nothing was spawned.
 * - `error`: the program was found but could not be started.
 */
export type RunCommandKind = "ok" | "exit" | "timeout" | "aborted" | "not-found" | "error";

export interface RunCommandResult {
	kind: RunCommandKind;
	/** The program as given. */
	program: string;
	/** The absolute path that ran, or null when nothing was found. */
	path: string | null;
	/** Whether a process was created. */
	spawned: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	/** True when either stream produced more than `maxOutputBytes`. */
	truncated: boolean;
	durationMs: number;
	/** Why the command did not finish normally, for `not-found`, `timeout`, `aborted` and `error`. */
	message?: string;
}

function executableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The absolute path `program` names on `searchPath`, or null. A name with a separator is taken as a path. */
export function resolveProgram(program: string, searchPath: string | undefined, cwd: string): string | null {
	if (program.length === 0) return null;
	if (program.includes("/") || (process.platform === "win32" && program.includes("\\"))) {
		const path = isAbsolute(program) ? program : resolve(cwd, program);
		return executableFile(path) ? path : null;
	}
	const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
	for (const dir of (searchPath ?? "").split(delimiter)) {
		if (dir.length === 0 || !isAbsolute(dir)) continue;
		for (const extension of extensions) {
			const candidate = join(dir, `${program}${extension}`);
			if (executableFile(candidate)) return candidate;
		}
	}
	return null;
}

/** The command's environment: allowlisted names copied from this process, then the explicit values. */
export function commandEnv(
	allowlist: ReadonlyArray<string> = [],
	values: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of [...BASE_ENV_ALLOWLIST, ...allowlist]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return { ...env, ...values };
}

interface Capture {
	chunks: Buffer[];
	bytes: number;
	truncated: boolean;
}

function capture(limit: number): Capture & { push(chunk: Buffer): void } {
	const state = {
		chunks: [] as Buffer[],
		bytes: 0,
		truncated: false,
		push(chunk: Buffer): void {
			const room = limit - state.bytes;
			if (room <= 0) {
				if (chunk.byteLength > 0) state.truncated = true;
				return;
			}
			const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
			if (kept !== chunk) state.truncated = true;
			state.chunks.push(kept);
			state.bytes += kept.byteLength;
		},
	};
	return state;
}

/** Run `program` with `args` and no shell. Never throws for a command's failure; the result says what happened. */
export function runCommand(
	program: string,
	args: ReadonlyArray<string>,
	options: RunCommandOptions,
): Promise<RunCommandResult> {
	const started = performance.now();
	const cwd = options.cwd ?? process.cwd();
	const env = commandEnv(options.envAllowlist, options.env);
	const limit = Math.max(0, Math.floor(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES));
	const unstarted = (kind: RunCommandKind, path: string | null, message: string): Promise<RunCommandResult> =>
		Promise.resolve({
			kind,
			program,
			path,
			spawned: false,
			code: null,
			signal: null,
			stdout: "",
			stderr: "",
			truncated: false,
			durationMs: performance.now() - started,
			message,
		});
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
		throw new Error("runCommand needs a positive timeoutMs");
	if (options.signal?.aborted === true) return unstarted("aborted", null, `${program} was cancelled before it started`);
	const path = resolveProgram(program, env.PATH, cwd);
	if (path === null) return unstarted("not-found", null, `${program} is not on PATH`);

	return new Promise((settle) => {
		const stdout = capture(limit);
		const stderr = capture(limit);
		const group = process.platform !== "win32";
		let stoppedBy: "timeout" | "aborted" | null = null;
		let killTimer: NodeJS.Timeout | undefined;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(path, [...args], {
				cwd,
				env,
				shell: false,
				windowsHide: true,
				detached: group,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			settle({
				kind: "error",
				program,
				path,
				spawned: false,
				code: null,
				signal: null,
				stdout: "",
				stderr: "",
				truncated: false,
				durationMs: performance.now() - started,
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const signalGroup = (signal: NodeJS.Signals): void => {
			try {
				if (group && child.pid !== undefined) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				// Already gone.
			}
		};
		const stop = (reason: "timeout" | "aborted"): void => {
			if (stoppedBy !== null) return;
			stoppedBy = reason;
			signalGroup("SIGTERM");
			killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
			killTimer.unref();
		};
		const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
		const onAbort = (): void => stop("aborted");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const keepLine = options.keepLine;
		let pending: Buffer[] = [];
		let pendingBytes = 0;
		let overlong = false;
		// Kept lines are whole: the first that does not fit ends the capture.
		const keepWhole = (line: Buffer): void => {
			if (stdout.truncated || stdout.bytes + line.byteLength > limit) stdout.truncated = true;
			else stdout.push(line);
		};
		const keepLines = (chunk: Buffer): void => {
			if (keepLine === undefined) {
				stdout.push(chunk);
				return;
			}
			let start = 0;
			for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, start)) {
				const piece = chunk.subarray(start, newline + 1);
				start = newline + 1;
				if (overlong) {
					overlong = false;
					continue;
				}
				const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
				pending = [];
				pendingBytes = 0;
				if (keepLine(line.subarray(0, -1).toString("utf8"))) keepWhole(line);
			}
			const rest = chunk.subarray(start);
			if (rest.byteLength === 0 || overlong) return;
			pending.push(rest);
			pendingBytes += rest.byteLength;
			if (pendingBytes > limit) {
				overlong = true;
				stdout.truncated = true;
				pending = [];
				pendingBytes = 0;
			}
		};
		const flushLines = (): void => {
			if (keepLine === undefined || pending.length === 0) return;
			const line = Buffer.concat(pending);
			pending = [];
			if (keepLine(line.toString("utf8"))) keepWhole(line);
		};
		child.stdout?.on("data", keepLines);
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.input ?? "");
		let done = false;
		const finish = (code: number | null, signal: NodeJS.Signals | null, failure: Error | null): void => {
			if (done) return;
			done = true;
			flushLines();
			clearTimeout(timer);
			if (killTimer !== undefined) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			const kind: RunCommandKind = failure !== null ? "error" : (stoppedBy ?? (code === 0 ? "ok" : "exit"));
			const message =
				kind === "timeout"
					? `${program} did not finish within ${options.timeoutMs} ms`
					: kind === "aborted"
						? `${program} was cancelled`
						: kind === "error"
							? `${program} could not be started: ${failure?.message ?? "unknown error"}`
							: undefined;
			settle({
				kind,
				program,
				path,
				spawned: failure === null,
				code,
				signal,
				stdout: Buffer.concat(stdout.chunks).toString("utf8"),
				stderr: Buffer.concat(stderr.chunks).toString("utf8"),
				truncated: stdout.truncated || stderr.truncated,
				durationMs: performance.now() - started,
				...(message !== undefined ? { message } : {}),
			});
		};
		// A program that was found but cannot be executed (EACCES) fails here, with no process.
		child.on("error", (error) => {
			if (child.pid === undefined) finish(null, null, error);
		});
		child.on("close", (code, signal) => finish(code, signal, null));
	});
}
