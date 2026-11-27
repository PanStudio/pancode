// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The stdio transport: one local MCP server process and its pipes. The
 * transport owns exactly one child process and never restarts it. The child
 * gets the allowlisted tool environment and a workspace-contained cwd. Inside
 * a dispatched worker it also runs under the worker's OS sandbox, like every
 * other child the worker starts; in the orchestrator no sandbox policy is
 * configured and it runs directly. Nothing the server prints reaches this
 * process's stdout or stderr.
 *
 * Both directions are bounded. The framer caps inbound lines; an outbound
 * cap bounds the bytes waiting on a server that stopped reading its stdin,
 * and crossing it is a fatal `overload`. Teardown covers the server's whole
 * process group, not only the child it spawned, escalates to SIGKILL for any
 * member that outlives the grace period, and begins the moment the leader is
 * seen to exit, whether or not close() has been called.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { boundedExternalDiagnostic } from "../../../core/external-diagnostic.js";
import { buildSafeToolEnv, resolveSafeCwd } from "../../../core/safe-exec.js";
import { signalSandboxPayload } from "../../../core/sandbox/signal.js";
import { planSandboxedSpawn } from "../../../core/sandbox/worker-process.js";
import { sleep } from "../../../core/timers.js";
import { createLineFramer, encodeJsonRpcMessage, McpError } from "./protocol.js";
import type {
	McpOutboundMessage,
	McpSendOptions,
	McpSendOutcome,
	McpTeardownOutcome,
	McpTransport,
	McpTransportEvents,
} from "./transport.js";

/** Characters of a crashed server's last stderr lines its exit error carries. */
const EXIT_STDERR_CHARS = 600;
/** Wait for a crashed server's stderr to reach end of file, which a descendant holding the pipe can delay. */
const EXIT_STDERR_GRACE_MS = 250;

export interface McpStdioServerSpec {
	id: string;
	command: string;
	args?: ReadonlyArray<string>;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
}

export interface McpStdioTransportOptions {
	workspaceRoot: string;
	stderrTailBytes: number;
	maxLineBytes: number;
	maxOutboundBytes: number;
	killGraceMs: number;
	teardownBoundMs: number;
	sandboxNetwork: boolean;
}

interface OutboundEntry {
	payload: Buffer;
	/** The request this line carries, so a request that settles unsent can be withdrawn. */
	requestId: number | null;
	onSent: (() => void) | undefined;
	onError: ((error: Error) => void) | undefined;
}

/**
 * Lifecycle of the server's process group as this client tracks it. The
 * leader's pid doubles as the group id because the child is spawned detached.
 * The kernel keeps a group id reserved only while some member of that group
 * exists; once the last member is reaped, the number can be handed to an
 * unrelated process, and a signal-0 probe would then report a stranger as
 * alive. Two rules keep this client from ever signalling a stranger:
 *
 *   1. Cleanup starts the moment the leader is seen to exit, not when close()
 *      happens to be called. At that instant the group is still ours or is
 *      already empty, so an arbitrarily late close() never gets to signal a
 *      number that has had time to change hands.
 *   2. Once the group has been observed gone (ESRCH), or cleanup has run to
 *      its bound, the id is `released` and is never probed or signalled
 *      again, whatever a later probe would say. A group that survives SIGKILL
 *      for the confirm window is unreaped zombies or something we cannot end
 *      either way; keeping the number is worth nothing and risks a stranger.
 *
 * The residual exposure is a reuse of the number between two 10 ms polls of
 * one active cleanup, the same window every group-signalling spawner in this
 * codebase accepts. Direct-child signals go through Node's own handle, which
 * knows whether that pid has been reaped, so they carry no such risk.
 */
type GroupPhase = "unspawned" | "live" | "cleaning" | "released";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The canonical directory the server starts in, or why there is none. The cwd
 * must stay inside the workspace root lexically and after every symbolic link
 * is followed, and it must exist as a directory. Checked once at creation for
 * early feedback and again at spawn, which is the boundary that matters.
 */
export function containedCwd(spec: McpStdioServerSpec, workspaceRoot: string): string | Error {
	let lexical: string;
	try {
		lexical = resolveSafeCwd(spec.cwd, workspaceRoot);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	let realRoot: string;
	let real: string;
	try {
		realRoot = realpathSync(path.resolve(workspaceRoot));
		real = realpathSync(lexical);
		if (!statSync(real).isDirectory()) return new Error(`cwd is not a directory: ${lexical}`);
	} catch (error) {
		return new Error(`cwd cannot be resolved: ${lexical} (${errorMessage(error)})`);
	}
	try {
		resolveSafeCwd(real, realRoot);
	} catch {
		return new Error(`cwd escapes workspace root through a symbolic link: ${lexical} -> ${real}`);
	}
	return real;
}

export function createMcpStdioTransport(
	spec: McpStdioServerSpec,
	options: McpStdioTransportOptions,
	events: McpTransportEvents,
): McpTransport {
	const { stderrTailBytes, maxOutboundBytes, killGraceMs, teardownBoundMs } = options;
	const framer = createLineFramer(options.maxLineBytes);
	let child: ChildProcess | null = null;
	let spawned: Promise<boolean> | null = null;
	let exited: Promise<void> | null = null;
	let leaderExited = false;
	let groupPhase: GroupPhase = "unspawned";
	let sandboxedLauncher = false;
	let groupCleanup: Promise<McpTeardownOutcome> | null = null;
	let teardown: McpTeardownOutcome | null = null;
	let closing = false;
	/** Set by the first fatal error; later frames are not delivered. */
	let stopped = false;
	let closePromise: Promise<McpTeardownOutcome> | null = null;
	const outbound: OutboundEntry[] = [];
	let outboundQueuedBytes = 0;
	let awaitingDrain = false;
	let stderrTailBuffer = Buffer.alloc(0);
	/** Set when the server exits unbidden; settles once its exit error, stderr included, has been reported. */
	let exitReported: Promise<void> | null = null;

	const fatal = (error: McpError, ended: boolean): void => {
		if (stopped) return;
		stopped = true;
		events.fatal(error, ended);
	};

	const isAlive = (): boolean => child !== null && child.exitCode === null && child.signalCode === null;

	/** The group id may be signalled only while the group is known to be ours (see GroupPhase). */
	const groupOwned = (): boolean => groupPhase === "live" || groupPhase === "cleaning";

	const signalGroup = (signalName: NodeJS.Signals): void => {
		const pid = child?.pid;
		if (pid !== undefined && process.platform !== "win32" && groupOwned()) {
			// A sandboxed server runs in its own session inside the sandbox, so TERM
			// goes to it alone and the launcher exits after it; KILL reaches both.
			if (sandboxedLauncher && signalSandboxPayload(pid, signalName) && signalName !== "SIGKILL") return;
			try {
				process.kill(-pid, signalName);
				return;
			} catch (error) {
				// ESRCH: the group is gone, and the number is no longer ours to touch.
				if ((error as NodeJS.ErrnoException).code === "ESRCH") groupPhase = "released";
			}
		}
		// Node's handle knows whether this pid was reaped, so the direct child is always safe to address.
		try {
			child?.kill(signalName);
		} catch {
			// Already exited.
		}
	};

	/** True while any member of the server's process group exists, whether or not the leader does. */
	const groupAlive = (): boolean => {
		const pid = child?.pid;
		if (pid === undefined || !groupOwned()) return false;
		if (process.platform !== "win32") {
			try {
				process.kill(-pid, 0);
				return true;
			} catch (error) {
				// ESRCH means every member is gone; the number is released for good.
				// EPERM means a member exists that this process may not signal;
				// anything else is treated as alive so cleanup never reports a
				// teardown it did not observe.
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
				groupPhase = "released";
				return false;
			}
		}
		return isAlive();
	};

	const terminationObserved = (): boolean => leaderExited && !groupAlive();

	/** Poll until the leader has been reaped and its group is empty, or the bound elapses. */
	const waitForTermination = async (timeoutMs: number): Promise<boolean> => {
		const deadline = performance.now() + timeoutMs;
		while (!terminationObserved()) {
			const remaining = deadline - performance.now();
			if (remaining <= 0) return terminationObserved();
			const nap = sleep(Math.min(10, remaining));
			await (leaderExited || exited === null ? nap : Promise.race([exited, nap]));
		}
		return true;
	};

	const destroyStdio = (): void => {
		for (const stream of [child?.stdin, child?.stdout, child?.stderr]) stream?.destroy();
	};

	/**
	 * Tear the group down once: SIGTERM, the grace period, SIGKILL for whatever
	 * is left, a bounded wait for it to disappear, then release the id for
	 * good. Runs from close() and from the leader's exit, whichever comes first;
	 * the second caller shares the first run. When something survives even
	 * SIGKILL the outcome says so, with the group id, and our pipe ends are
	 * dropped so the survivor cannot pin this process's event loop; otherwise
	 * the pipes drain naturally and the stderr tail stays whole. The outcome is
	 * flagged rather than thrown: a caller's shutdown loop cannot do anything
	 * about a survivor except report it, and the flag carries what to report.
	 */
	const cleanupGroup = (): Promise<McpTeardownOutcome> => {
		if (groupCleanup !== null) return groupCleanup;
		groupCleanup = (async () => {
			let terminated = true;
			const pgid = child?.pid;
			if (groupPhase === "live" && pgid !== undefined) {
				groupPhase = "cleaning";
				if (groupAlive()) signalGroup("SIGTERM");
				terminated = await waitForTermination(killGraceMs);
				if (!terminated) {
					if (groupAlive()) signalGroup("SIGKILL");
					terminated = await waitForTermination(teardownBoundMs);
				}
			} else {
				await (exited ?? Promise.resolve());
			}
			groupPhase = "released";
			const outcome: McpTeardownOutcome =
				terminated || pgid === undefined
					? { complete: true }
					: { complete: false, reason: "group-survived-sigkill", pgid, boundMs: killGraceMs + teardownBoundMs };
			teardown = outcome;
			if (!outcome.complete) destroyStdio();
			return outcome;
		})();
		return groupCleanup;
	};

	/** Bytes accepted for the server but not yet flushed: this queue plus the stream's own buffer. */
	const pendingOutboundBytes = (): number => outboundQueuedBytes + (child?.stdin?.writableLength ?? 0);

	const flushOutbound = (): void => {
		while (!awaitingDrain) {
			const entry = outbound.shift();
			if (entry === undefined) return;
			outboundQueuedBytes -= entry.payload.length;
			const stdin = child?.stdin;
			if (!stdin || stdin.destroyed || !stdin.writable) {
				entry.onError?.(new Error("server stdin is not writable"));
				continue;
			}
			entry.onSent?.();
			const accepted = stdin.write(entry.payload, (error) => {
				if (error) entry.onError?.(error);
			});
			if (!accepted) {
				awaitingDrain = true;
				stdin.once("drain", () => {
					awaitingDrain = false;
					flushOutbound();
				});
			}
		}
	};

	/**
	 * Queue one line for the server. A line larger than the cap is refused on
	 * its own; a line that would push the unflushed total over the cap means the
	 * server stopped reading, which is fatal.
	 */
	const send = (message: McpOutboundMessage, sendOptions: McpSendOptions = {}): McpSendOutcome => {
		const payload = encodeJsonRpcMessage(message);
		if (payload.length > maxOutboundBytes) return { kind: "oversized", bytes: payload.length, cap: maxOutboundBytes };
		const queued = pendingOutboundBytes();
		if (queued + payload.length > maxOutboundBytes) {
			fatal(
				new McpError(
					"overload",
					`mcp server ${spec.id} stopped reading its stdin: ${queued} bytes are queued for it and the outbound cap is ${maxOutboundBytes} bytes`,
				),
				false,
			);
			return { kind: "overloaded" };
		}
		outbound.push({
			payload,
			requestId: sendOptions.requestId ?? null,
			onSent: sendOptions.onSent,
			onError: sendOptions.onError,
		});
		outboundQueuedBytes += payload.length;
		flushOutbound();
		return { kind: "queued" };
	};

	const withdraw = (requestId: number): void => {
		const index = outbound.findIndex((entry) => entry.requestId === requestId);
		if (index === -1) return;
		const [entry] = outbound.splice(index, 1);
		if (entry !== undefined) outboundQueuedBytes -= entry.payload.length;
	};

	const consumeFrames = (frames: ReturnType<typeof framer.push>): void => {
		for (const frame of frames) {
			if (stopped || closing) return;
			if (frame.kind === "message") {
				events.message(frame.message);
				continue;
			}
			fatal(new McpError("protocol", `protocol error from mcp server ${spec.id}: ${frame.error.message}`), false);
			return;
		}
	};

	/** Node may report a child's exit before the last stderr bytes it wrote; wait for end of file, bounded. */
	const stderrEnded = async (proc: ChildProcess): Promise<void> => {
		const stream = proc.stderr;
		if (stream === null || stream.readableEnded || stream.destroyed) return;
		const settled = new AbortController();
		await Promise.race([
			once(stream, "close", { signal: settled.signal }),
			sleep(EXIT_STDERR_GRACE_MS, settled.signal),
		]).catch(() => {
			// Neither side rejects before the race settles; the abort below only releases the loser.
		});
		settled.abort();
	};

	/** The last lines a crashed server wrote to stderr, which usually say why it exited. */
	const stderrEnding = (): string => {
		const lines = stderrTailBuffer
			.toString("utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (lines.length === 0) return "";
		const ending = Array.from(boundedExternalDiagnostic(lines.slice(-3).join(" | "), stderrTailBytes));
		return `; its stderr ends with: ${ending.length > EXIT_STDERR_CHARS ? `…${ending.slice(-EXIT_STDERR_CHARS).join("")}` : ending.join("")}`;
	};

	const spawnChild = (): boolean => {
		const cwd = containedCwd(spec, options.workspaceRoot);
		if (cwd instanceof Error) {
			fatal(new McpError("spawn", `mcp server ${spec.id} failed to start: ${cwd.message}`), true);
			return false;
		}
		// A worker's policy engine admits execute-class calls under write roots on
		// the promise that bwrap binds every child it starts to those roots, so a
		// server must not be the one child that escapes them or the network policy.
		const sandbox = planSandboxedSpawn({ argv: [spec.command, ...(spec.args ?? [])] }, cwd, [], {
			network: options.sandboxNetwork,
		});
		if (sandbox.kind === "refused") {
			fatal(new McpError("spawn", `mcp server ${spec.id} failed to start: ${sandbox.message}`), true);
			return false;
		}
		sandboxedLauncher = sandbox.kind === "sandboxed";
		let proc: ChildProcess;
		try {
			const [file, args] =
				sandbox.kind === "sandboxed" ? [sandbox.file, sandbox.args] : [spec.command, [...(spec.args ?? [])]];
			proc = spawn(file, args, {
				cwd,
				env: buildSafeToolEnv({ ...(spec.env ?? {}) }),
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			fatal(new McpError("spawn", `mcp server ${spec.id} failed to start: ${errorMessage(error)}`), true);
			return false;
		}
		child = proc;
		if (proc.pid !== undefined) groupPhase = "live";
		spawned = new Promise<boolean>((resolve) => {
			proc.once("spawn", () => resolve(true));
			proc.once("error", (error) => {
				fatal(new McpError("spawn", `mcp server ${spec.id} failed to start: ${error.message}`), true);
				resolve(false);
			});
		});
		exited = new Promise<void>((resolve) => {
			proc.once("exit", (code, signal) => {
				leaderExited = true;
				if (!closing && !stopped) {
					const how = signal !== null ? `signal ${signal}` : `code ${code ?? "?"}`;
					exitReported = stderrEnded(proc).then(() =>
						fatal(
							new McpError("closed", `mcp server ${spec.id} exited with ${how} before the client closed it${stderrEnding()}`),
							true,
						),
					);
				}
				resolve();
				// Whatever the leader left in its group is torn down now, while the id is still ours.
				void cleanupGroup();
			});
			proc.once("error", () => {
				if (proc.pid === undefined) {
					leaderExited = true;
					resolve();
				}
			});
		});
		proc.stdin?.on("error", () => {
			// Surfaced through the write callbacks; a bare listener keeps the event from throwing.
		});
		proc.stdout?.on("data", (chunk: Buffer) => consumeFrames(framer.push(chunk)));
		proc.stdout?.on("end", () => consumeFrames(framer.flush()));
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (stderrTailBytes === 0) return;
			const joined = Buffer.concat([stderrTailBuffer, chunk]);
			stderrTailBuffer =
				joined.length > stderrTailBytes ? Buffer.from(joined.subarray(joined.length - stderrTailBytes)) : joined;
		});
		return true;
	};

	/**
	 * End the server: close its stdin, then run (or join) the group teardown.
	 * The leader's exit is not the end of it; a descendant that outlives the
	 * leader is signalled and waited for the same way. Our ends of the pipes
	 * are dropped last, since nobody reads them after close.
	 */
	const close = (): Promise<McpTeardownOutcome> => {
		if (closePromise !== null) return closePromise;
		closePromise = (async () => {
			closing = true;
			outbound.length = 0;
			outboundQueuedBytes = 0;
			if (child === null) {
				teardown ??= { complete: true };
				return teardown;
			}
			try {
				child.stdin?.end();
			} catch {
				// Nothing to flush on a dead pipe.
			}
			const outcome = await cleanupGroup();
			destroyStdio();
			return outcome;
		})();
		return closePromise;
	};

	return {
		get pid() {
			return child?.pid;
		},
		start: async () => {
			if (closing || !spawnChild()) return false;
			return await (spawned ?? Promise.resolve(false));
		},
		started: () => child !== null,
		endReported: () => exitReported,
		send,
		withdraw,
		close,
		killOwnedOnExit: () => {
			// ESRCH releases ownership before the asynchronous teardown record settles.
			// Check the live ownership state, never the retained pid or final outcome.
			if (groupOwned()) signalGroup("SIGKILL");
		},
		teardown: () => teardown,
		stderrTail: () => stderrTailBuffer.toString("utf8"),
	};
}
