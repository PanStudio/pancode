// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { type Dirent, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isSameOrDescendant } from "../path-containment.js";
import { sandboxFilterFile, sandboxFilterProgram } from "./seccomp.js";
import type { SandboxAvailability, SandboxInvocationSpec, SandboxMaskedPath, UnixSocketMode } from "./types.js";

/**
 * Unix-domain sockets inside the OS sandbox. A contained command keeps the
 * host network namespace and reads most of the filesystem, and Linux lets a
 * process connect to a socket on a read-only mount. A terminal multiplexer's
 * socket (tmux, Herdr), an X11 display or a daemon's control socket each runs
 * commands outside the sandbox, and abstract-namespace sockets (X11, some
 * D-Bus buses) have no path a mount could hide.
 *
 * Under bubblewrap every launch therefore loads the seccomp program with its
 * `block` rules (seccomp.ts), which make `socket(AF_UNIX, ...)` fail with
 * EPERM and keep `socketpair`. Seatbelt denies Unix-socket connects and binds
 * in its profile. Where bubblewrap cannot load the program, each launch masks
 * the user-owned sockets it finds instead, which leaves abstract sockets and
 * sockets created after the launch reachable.
 */

/** Where a launch looks for sockets to mask when the filter cannot load. */
export interface UnixSocketRoots {
	/** Trees the command works in (workspace, worker cwd, worktree, checkouts). Scanned, never masked whole. */
	workspaceRoots: ReadonlyArray<string>;
	/** Writable trees beyond the temp roots, such as `safety.scratchRoots`. */
	scratchRoots?: ReadonlyArray<string>;
	/** A private /tmp hides the host's, so it is not scanned. */
	privateTmp: boolean;
	/** Defaults to the operator's home directory. */
	home?: string;
	/** Read for the pane host's control socket; defaults to this process's environment. */
	env?: NodeJS.ProcessEnv;
}

const HOME_SCAN_DEPTH = 4;
const TREE_SCAN_DEPTH = 3;
/** Entries one discovery may visit before it stops and reports itself capped. */
const SOCKET_WALK_BUDGET = 40_000;
/** Masks past this many are not added; each is one bwrap argument pair. */
const SOCKET_MASK_LIMIT = 256;
/** Sockets come and go with their daemons, so a scan is reused only briefly. */
const SOCKET_SCAN_TTL_MS = 5_000;
/** Large or generated trees that hold no daemon socket worth the walk. */
const SKIPPED_SOCKET_DIRS = new Set([
	"node_modules",
	".git",
	".cache",
	".npm",
	".pnpm-store",
	".cargo",
	".rustup",
	".nvm",
	".pyenv",
	".conda",
	"miniconda3",
	"anaconda3",
	".venv",
	"venv",
	"go",
	".gradle",
	".m2",
	"snap",
	".vscode-server",
	"Trash",
	"__pycache__",
]);

interface UnixSocketMaskScan {
	masks: SandboxMaskedPath[];
	/** True when the walk ran out of budget or more than the mask limit were found. */
	capped: boolean;
}

function physical(entry: string): string | null {
	try {
		return realpathSync(entry);
	} catch {
		return null;
	}
}

interface SocketWalk {
	visited: number;
	capped: boolean;
	found: Set<string>;
	skip: ReadonlyArray<string>;
}

/** Bounded walk for sockets owned by `uid`; links are never followed. */
function walkSockets(root: string, maxDepth: number, uid: number, state: SocketWalk): void {
	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (stack.length > 0 && !state.capped) {
		const frame = stack.pop();
		if (frame === undefined) break;
		let entries: Dirent[];
		try {
			entries = readdirSync(frame.dir, { withFileTypes: true });
		} catch {
			// Unreadable to this process: its sockets are unreachable from the sandbox too.
			continue;
		}
		const later: string[] = [];
		const first: string[] = [];
		for (const entry of entries) {
			if (state.visited >= SOCKET_WALK_BUDGET) {
				state.capped = true;
				return;
			}
			state.visited += 1;
			const child = path.join(frame.dir, entry.name);
			if (entry.isSocket()) {
				try {
					if (lstatSync(child).uid === uid) state.found.add(child);
				} catch {
					// Gone already.
				}
			} else if (
				entry.isDirectory() &&
				frame.depth + 1 < maxDepth &&
				!SKIPPED_SOCKET_DIRS.has(entry.name) &&
				!state.skip.some((masked) => isSameOrDescendant(child, masked))
			) {
				(entry.name.startsWith(".") ? first : later).push(child);
			}
		}
		// Daemons keep their sockets in hidden directories (~/.config, ~/.ssh), so those are visited before a large data tree spends the budget.
		for (const dir of [...later.reverse(), ...first.reverse()]) stack.push({ dir, depth: frame.depth + 1 });
	}
}

/**
 * The control sockets the environment names for the terminal multiplexer this
 * process runs under (`HERDR_SOCKET_PATH`, the first field of `TMUX`). Either
 * runs commands outside the sandbox, so they are found wherever they live.
 */
function paneHostSockets(env: NodeJS.ProcessEnv): string[] {
	return [env.HERDR_SOCKET_PATH, env.TMUX?.split(",")[0]]
		.map((entry) => entry?.trim() ?? "")
		.filter((entry) => path.isAbsolute(entry));
}

/**
 * A daemon's private socket directory directly under a temp root, such as
 * /tmp/tmux-<uid>, is masked whole so a socket made there after the launch is
 * hidden too. It must be the operator's, closed to group and others, and hold
 * no tree the command works in.
 */
function privateSocketDir(
	socket: string,
	tempRoots: ReadonlyArray<string>,
	keep: ReadonlyArray<string>,
	uid: number,
): string | null {
	const dir = path.dirname(socket);
	if (!tempRoots.includes(path.dirname(dir))) return null;
	if (keep.some((root) => isSameOrDescendant(root, dir))) return null;
	try {
		const stat = lstatSync(dir);
		return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0 ? dir : null;
	} catch {
		return null;
	}
}

interface CachedSocketScan {
	at: number;
	scan: UnixSocketMaskScan;
}

const socketScanCache = new Map<string, CachedSocketScan>();

function scanSockets(
	roots: UnixSocketRoots,
	existing: ReadonlyArray<SandboxMaskedPath>,
	uid: number,
): UnixSocketMaskScan {
	const unique = (entries: ReadonlyArray<string>): string[] => [
		...new Set(entries.map(physical).filter((entry): entry is string => entry !== null)),
	];
	const workspaceRoots = unique(roots.workspaceRoots);
	const scratchRoots = unique(roots.scratchRoots ?? []);
	// A private /tmp hides the host's; /var/tmp is visible either way.
	const tempRoots = unique([...(roots.privateTmp ? [] : ["/tmp"]), "/var/tmp", ...(roots.scratchRoots ?? [])]);
	const home = unique([roots.home ?? homedir()]);
	const state: SocketWalk = {
		visited: 0,
		capped: false,
		found: new Set(),
		skip: existing.filter((mask) => mask.kind === "directory").map((mask) => mask.path),
	};
	for (const named of unique(paneHostSockets(roots.env ?? process.env))) {
		if (state.skip.some((masked) => isSameOrDescendant(named, masked))) continue;
		try {
			const stat = lstatSync(named);
			if (stat.isSocket() && stat.uid === uid) state.found.add(named);
		} catch {
			// Not there: nothing to mask.
		}
	}
	// Scan the command's explicit roots before shared trees can exhaust the bounded walk (#434).
	for (const root of unique([...workspaceRoots, ...scratchRoots])) walkSockets(root, TREE_SCAN_DEPTH, uid, state);
	for (const root of home) walkSockets(root, HOME_SCAN_DEPTH, uid, state);
	for (const root of tempRoots) walkSockets(root, TREE_SCAN_DEPTH, uid, state);
	const keep = [...workspaceRoots, ...scratchRoots];
	const taken = new Set(existing.map((mask) => mask.path));
	const masks: SandboxMaskedPath[] = [];
	let capped = state.capped;
	for (const socket of [...state.found].sort()) {
		if (taken.has(socket) || masks.some((mask) => mask.kind === "directory" && isSameOrDescendant(socket, mask.path)))
			continue;
		if (masks.length >= SOCKET_MASK_LIMIT) {
			capped = true;
			break;
		}
		const dir = privateSocketDir(socket, tempRoots, keep, uid);
		const mask: SandboxMaskedPath = dir !== null ? { path: dir, kind: "directory" } : { path: socket, kind: "file" };
		if (taken.has(mask.path)) continue;
		taken.add(mask.path);
		masks.push(mask);
	}
	return { masks, capped };
}

/**
 * Impure: masks for the user-owned sockets a command could reach, for a
 * launch that cannot load the filter. The pane host's control socket named
 * in the environment comes first. Home is walked four levels deep, the temp
 * roots, scratch roots and work trees three, hidden directories before the
 * rest, skipping dependency and cache trees. A scan is reused for 5 s, and a mask whose path is gone by now
 * is dropped, because bwrap fails a mount over a missing path on a read-only
 * tree.
 */
function discoverUnixSocketMasks(
	roots: UnixSocketRoots,
	existing: ReadonlyArray<SandboxMaskedPath> = [],
	now: number = Date.now(),
): UnixSocketMaskScan {
	const uid = typeof process.getuid === "function" ? process.getuid() : -1;
	const { env, ...walked } = roots;
	const key = JSON.stringify([walked, paneHostSockets(env ?? process.env), existing.map((mask) => mask.path).sort()]);
	const cached = socketScanCache.get(key);
	const scan =
		cached !== undefined && now - cached.at < SOCKET_SCAN_TTL_MS ? cached.scan : scanSockets(roots, existing, uid);
	if (cached === undefined || cached.scan !== scan) socketScanCache.set(key, { at: now, scan });
	const present = (mask: SandboxMaskedPath): boolean => {
		try {
			const stat = lstatSync(mask.path);
			return mask.kind === "directory" ? stat.isDirectory() : stat.isSocket();
		} catch {
			return false;
		}
	};
	return { masks: scan.masks.filter(present), capped: scan.capped };
}

/** How one launch treats Unix-domain sockets. */
export type UnixSocketState =
	| { kind: "allowed" }
	| { kind: "filter" }
	| { kind: "profile" }
	| { kind: "owned"; capped: boolean }
	| { kind: "masks"; reason: string; capped: boolean };

export interface SandboxLaunchFilters {
	/** Spread into the launch's invocation spec. */
	fields: Pick<SandboxInvocationSpec, "seccompFilter" | "denyUnixSockets">;
	/** Masks for the sockets found, when bubblewrap cannot load the `block` rules or under `owned`. */
	masks: SandboxMaskedPath[];
	state: UnixSocketState;
	/** Bubblewrap only: why this launch loads no seccomp program, so the baseline is missing. */
	missingBaseline?: string;
}

/**
 * Impure: what one sandbox launch adds for its seccomp program and for
 * Unix-domain sockets. Under bubblewrap every launch loads the program
 * (seccomp.ts): the baseline always, and the AF_UNIX and keyring rules under
 * `block`. Under `owned` it masks the operator's sockets discovered under
 * `roots`, so another user's socket (a system daemon's) stays reachable.
 * Where the program cannot load, `block` masks the same discovered sockets
 * and the launch reports the baseline missing. Seatbelt denies sockets in its
 * profile, under `owned` too; `allow` adds no socket rule anywhere. Discovery
 * skips those `existing` masks already hide.
 */
export function sandboxLaunchFilters(
	mode: UnixSocketMode,
	availability: SandboxAvailability,
	roots: UnixSocketRoots,
	existing: ReadonlyArray<SandboxMaskedPath>,
): SandboxLaunchFilters {
	if (!availability.available || availability.executable === null) {
		return { fields: {}, masks: [], state: { kind: "allowed" } };
	}
	if (availability.backend === "seatbelt") {
		return mode === "allow"
			? { fields: {}, masks: [], state: { kind: "allowed" } }
			: { fields: { denyUnixSockets: true }, masks: [], state: { kind: "profile" } };
	}
	let missing = availability.degraded;
	let seccompFilter: string | undefined;
	if (missing === undefined) {
		const program = sandboxFilterProgram({ unixSockets: mode === "block" });
		if (program === null) missing = "no seccomp filter for this host";
		else {
			try {
				seccompFilter = sandboxFilterFile(program);
			} catch (error) {
				missing = `the filter file could not be written: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	}
	const fields = seccompFilter !== undefined ? { seccompFilter } : {};
	const baseline = missing !== undefined ? { missingBaseline: missing } : {};
	if (mode === "allow") return { fields, masks: [], state: { kind: "allowed" }, ...baseline };
	if (mode === "block" && missing === undefined) return { fields, masks: [], state: { kind: "filter" } };
	const scan = discoverUnixSocketMasks(roots, existing);
	const state: UnixSocketState =
		mode === "owned"
			? { kind: "owned", capped: scan.capped }
			: { kind: "masks", reason: missing ?? "", capped: scan.capped };
	return { fields, masks: scan.masks, state, ...baseline };
}

/** What doctor and the worker diagnostics say about one host's unix-socket treatment. */
export function unixSocketStateLine(state: UnixSocketState): string {
	switch (state.kind) {
		case "allowed":
			return "unix sockets: allowed (safety.sandboxUnixSockets is allow), so a contained command can reach any socket it sees and the login's session keyring";
		case "filter":
			return "unix sockets: a seccomp filter refuses new AF_UNIX sockets (socketpair still works) and the kernel keyring calls";
		case "profile":
			return "unix sockets: the seatbelt profile denies connecting to and binding them (unverified on macOS)";
		case "owned":
			return `unix sockets: safety.sandboxUnixSockets is owned, so only your own sockets found at launch are masked${state.capped ? " up to the search limit" : ""}; other users' sockets (system daemons such as MUNGE), abstract sockets, sockets created later and the login's session keyring stay reachable`;
		case "masks":
			return `unix sockets: the seccomp filter is unavailable (${state.reason}), so the user-owned sockets found at launch are masked${state.capped ? " up to the search limit" : ""}; abstract sockets, sockets created later and the login's session keyring stay reachable`;
	}
}

/** Pure: the treatment the next launch on this host gets, without discovering sockets. */
export function unixSocketHostState(mode: UnixSocketMode, availability: SandboxAvailability): UnixSocketState {
	if (mode === "allow" || !availability.available || availability.executable === null) return { kind: "allowed" };
	if (availability.backend === "seatbelt") return { kind: "profile" };
	if (mode === "owned") return { kind: "owned", capped: false };
	return availability.degraded === undefined
		? { kind: "filter" }
		: { kind: "masks", reason: availability.degraded, capped: false };
}
