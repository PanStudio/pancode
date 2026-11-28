// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { endianness, homedir, machine, tmpdir } from "node:os";
import path from "node:path";
import { isSameOrDescendant } from "../path-containment.js";
import { buildBwrapInvocation, DEFAULT_BWRAP_PATH, SECCOMP_FILTER_STDIN } from "./bwrap.js";
import { buildSeatbeltInvocation, SEATBELT_EXECUTABLE } from "./seatbelt.js";
import { SECCOMP_COVERED_MACHINES, sandboxFilterProgram } from "./seccomp.js";
import type { SandboxAvailability, SandboxInvocation, SandboxMode } from "./types.js";

const PROBE_TIMEOUT_MS = 5000;

let cached: SandboxAvailability | null = null;
let cachedNetIsolation: string | null | undefined;

function executable(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		// Missing or not executable; the caller tries the next candidate.
		return false;
	}
}

/**
 * Why a bwrap binary cannot be trusted to build the sandbox, else null. The
 * file and every directory above its real path must be root's and closed to
 * writes by group and others (a sticky directory, such as /nix/store, only
 * lets its root-owned entries be replaced by root). Anything else lets a
 * process of the operator's uid, a sandboxed one included where the path is
 * a writable root, swap in a binary that builds no sandbox at all. Running as
 * root, every path is root's, so a binary under the home, the working
 * directory or a temp directory is refused as well.
 */
export function untrustedBwrapReason(candidate: string, uid: number = process.getuid?.() ?? -1): string | null {
	let real: string;
	try {
		real = realpathSync(candidate);
	} catch (error) {
		return `${candidate} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`;
	}
	for (let entry = real; ; entry = path.dirname(entry)) {
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(entry);
		} catch (error) {
			return `${entry} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (stat.uid !== 0) return `${entry} is owned by uid ${stat.uid}, not root`;
		if ((Number(stat.mode) & 0o022) !== 0 && !(stat.isDirectory() && (Number(stat.mode) & 0o1000) !== 0)) {
			return `${entry} is writable by group or others`;
		}
		if (entry === path.dirname(entry)) break;
	}
	if (uid === 0) {
		const open = [homedir(), process.cwd(), tmpdir(), "/tmp", "/var/tmp"].find((root) => isSameOrDescendant(real, root));
		if (open !== undefined) return `${real} is under ${open}, which sandboxed commands may write`;
	}
	return null;
}

/** The first trusted bwrap, /usr/bin/bwrap before PATH order, or why none was taken. */
function findBwrap(env: NodeJS.ProcessEnv): { path: string } | { skipped: string[] } {
	const skipped: string[] = [];
	const seen = new Set<string>();
	const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0 && path.isAbsolute(dir));
	for (const candidate of [DEFAULT_BWRAP_PATH, ...dirs.map((dir) => path.join(dir, "bwrap"))]) {
		if (seen.has(candidate) || !executable(candidate)) continue;
		seen.add(candidate);
		const untrusted = untrustedBwrapReason(candidate);
		if (untrusted === null) {
			// Return the verified real path so a symlink in a writable PATH directory cannot be swapped before launch.
			return { path: realpathSync(candidate) };
		}
		if (!skipped.includes(untrusted)) skipped.push(untrusted);
	}
	return { skipped };
}

/** The kind of Windows Subsystem for Linux kernel this is, read from its release string; null off WSL. */
export function wslKind(osrelease?: string): "wsl1" | "wsl2" | null {
	let release = osrelease;
	if (release === undefined) {
		try {
			release = readFileSync("/proc/sys/kernel/osrelease", "utf8");
		} catch {
			return null;
		}
	}
	// WSL1 reports "<build>-Microsoft"; every WSL2 kernel is "<version>-microsoft-standard[-WSL2]".
	if (/microsoft-standard/iu.test(release)) return "wsl2";
	return /Microsoft/u.test(release) ? "wsl1" : null;
}

/**
 * Run the probe directly rather than through safe-exec: safe-exec is the seam
 * that consults this module, and the probe is a fixed argv with no model
 * input and a hard timeout. A timed-out probe says nothing about the host, so
 * callers must not cache it.
 */
function probe(invocation: SandboxInvocation, input?: Buffer): { failure: string | null; timedOut: boolean } {
	const result = spawnSync(invocation.file, invocation.args, {
		stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
		...(input !== undefined ? { input } : {}),
		timeout: PROBE_TIMEOUT_MS,
		encoding: "utf8",
	});
	if (result.error) {
		return { failure: result.error.message, timedOut: (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" };
	}
	if (result.status === 0) return { failure: null, timedOut: false };
	const stderr = (result.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
	return {
		failure: stderr.length > 0 ? stderr : `probe exited with ${result.status ?? result.signal ?? "unknown status"}`,
		timedOut: false,
	};
}

function bwrapProbe(bwrap: string, network: boolean): SandboxInvocation {
	return buildBwrapInvocation(
		{ command: { argv: ["/bin/true"] }, cwd: "/", writableRoots: [], network, maskedPaths: [] },
		bwrap,
	);
}

type Detected = { availability: SandboxAvailability; timedOut: boolean };

/**
 * Null when bubblewrap loads the full seccomp program here, which proves the
 * kernel accepts it; else why not. The program travels on stdin, so the probe
 * writes no file.
 */
function seccompFailure(bwrap: string): { failure: string | null; timedOut: boolean } {
	const program = sandboxFilterProgram({ unixSockets: true });
	if (program === null || !SECCOMP_COVERED_MACHINES.has(machine())) {
		return { failure: `no seccomp filter for ${machine()} (${endianness()})`, timedOut: false };
	}
	const { failure, timedOut } = probe(
		buildBwrapInvocation(
			{
				command: { argv: ["/bin/true"] },
				cwd: "/",
				writableRoots: [],
				network: true,
				maskedPaths: [],
				seccompFilter: SECCOMP_FILTER_STDIN,
			},
			bwrap,
		),
		program,
	);
	return { failure: failure === null ? null : `bubblewrap did not load the seccomp filter: ${failure}`, timedOut };
}

function detect(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, osrelease?: string): Detected {
	if (platform === "linux") {
		if (wslKind(osrelease) === "wsl1") {
			return {
				availability: {
					available: false,
					backend: null,
					executable: null,
					reason: "WSL1 is unsupported: its kernel has no user namespaces for bubblewrap; convert the distribution to WSL2",
				},
				timedOut: false,
			};
		}
		const found = findBwrap(env);
		if (!("path" in found)) {
			const reason =
				found.skipped.length === 0
					? "bubblewrap (bwrap) is not installed"
					: `no trusted bubblewrap (bwrap): ${found.skipped.join("; ")}`;
			return { availability: { available: false, backend: null, executable: null, reason }, timedOut: false };
		}
		const bwrap = found.path;
		// The probe uses the namespaces every sandbox does, so a kernel that
		// forbids unprivileged user namespaces (or an outer container that
		// strips them) reports unavailable here instead of failing every call.
		// The network namespace only a network-off sandbox needs is probed
		// separately (sandboxNetworkIsolation), so a main session, whose network
		// stays on, does not lose its sandbox to it.
		const { failure, timedOut } = probe(bwrapProbe(bwrap, true));
		if (failure !== null) {
			// EPERM is policy, not a broken install: bwrap's own line (often
			// `pivot_root: Operation not permitted` in a container) does not say so.
			const cause = /Operation not permitted/u.test(failure)
				? " (the kernel or an enclosing container forbids the namespaces or mounts bubblewrap needs)"
				: "";
			return {
				availability: {
					available: false,
					backend: null,
					executable: null,
					reason: `bubblewrap cannot create a sandbox here: ${failure}${cause}`,
					found: bwrap,
				},
				timedOut,
			};
		}
		const seccomp = seccompFailure(bwrap);
		return {
			availability: {
				available: true,
				backend: "bwrap",
				executable: bwrap,
				reason: null,
				...(seccomp.failure !== null ? { degraded: seccomp.failure } : {}),
			},
			timedOut: seccomp.timedOut,
		};
	}
	if (platform === "darwin") {
		if (!executable(SEATBELT_EXECUTABLE)) {
			return {
				availability: { available: false, backend: null, executable: null, reason: "sandbox-exec is not present" },
				timedOut: false,
			};
		}
		// The network grant and the unix-socket rules ride along, so a kernel
		// that rejects any rule a real launch uses reports unavailable here.
		const { failure, timedOut } = probe(
			buildSeatbeltInvocation({
				command: { argv: ["/usr/bin/true"] },
				cwd: "/",
				writableRoots: ["/private/tmp"],
				readOnlyPaths: ["/private/tmp/.pancode-probe"],
				network: true,
				maskedPaths: [],
				denyUnixSockets: true,
			}),
		);
		if (failure !== null) {
			return {
				availability: {
					available: false,
					backend: null,
					executable: null,
					reason: `sandbox-exec rejected the worker profile: ${failure}`,
					found: SEATBELT_EXECUTABLE,
				},
				timedOut,
			};
		}
		return {
			availability: {
				available: true,
				backend: "seatbelt",
				executable: SEATBELT_EXECUTABLE,
				reason: "seatbelt profile is unverified on macOS",
			},
			timedOut: false,
		};
	}
	return {
		availability: {
			available: false,
			backend: null,
			executable: null,
			reason: `no worker sandbox backend for platform '${platform}'`,
		},
		timedOut: false,
	};
}

/**
 * Probe once per process; a definite answer does not change while it runs.
 * A probe that timed out is not cached: this call reports unavailable and the
 * next one probes again.
 */
export function sandboxAvailability(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	osrelease?: string,
): SandboxAvailability {
	// Only the real host answer is cached; an explicit platform, env or kernel
	// release is a one-off question and must not poison the process-wide probe.
	if (platform !== process.platform || env !== process.env || osrelease !== undefined)
		return detect(platform, env, osrelease).availability;
	if (cached !== null) return cached;
	const detected = detect(platform, env);
	if (!detected.timedOut) cached = detected.availability;
	return detected.availability;
}

/** The host answer once a probe has landed, else null. Never probes, so a render path can read it. */
export function probedSandboxAvailability(): SandboxAvailability | null {
	return cached;
}

/**
 * Null when bubblewrap can also isolate the network (`--unshare-net`), which
 * a network-off sandbox needs; else why not. Cached like the base probe, a
 * timeout excepted. Other backends answer null.
 */
export function sandboxNetworkIsolation(availability: SandboxAvailability = sandboxAvailability()): string | null {
	if (!availability.available || availability.backend !== "bwrap" || availability.executable === null) return null;
	const cacheable = availability === cached;
	if (cacheable && cachedNetIsolation !== undefined) return cachedNetIsolation;
	const { failure, timedOut } = probe(bwrapProbe(availability.executable, false));
	const result = failure === null ? null : `bubblewrap cannot isolate the network here: ${failure}`;
	if (cacheable && !timedOut) cachedNetIsolation = result;
	return result;
}

/**
 * Whether launches under `mode` may use this backend. `required` takes only a
 * full sandbox, so a partial one (the baseline seccomp filter cannot load)
 * counts as none; `auto` uses it and says what is missing.
 */
export function sandboxUsable(mode: SandboxMode, availability: SandboxAvailability): boolean {
	if (!availability.available || availability.backend === null) return false;
	return mode !== "required" || availability.degraded === undefined;
}
