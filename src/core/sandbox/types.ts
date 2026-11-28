// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Worker OS sandbox vocabulary. A worker's child processes (bash, run_script, verification checks) run under an OS
 * sandbox modeled on Codex CLI's workspace-write mode: the filesystem is readable, writes land only in the writable
 * roots and a private /tmp, and network is off unless the run was granted it.
 */
import type { EgressBridgeSetup } from "./egress/setup.js";

/** `safety.sandbox` setting values. */
export const SANDBOX_MODES = ["auto", "required", "off"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export const SANDBOX_BACKENDS = ["bwrap", "seatbelt"] as const;
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

/**
 * `safety.sandboxUnixSockets` values. `block` refuses new Unix-domain sockets
 * inside the sandbox, because a socket visible in the filesystem view or the
 * shared network namespace (a terminal multiplexer, X11, a daemon's control
 * socket) runs commands outside it. `owned` masks only the sockets the
 * operator owns, so a system daemon's (MUNGE, SSSD) stays reachable; Seatbelt
 * treats it as `block`. `allow` leaves them reachable.
 */
export const UNIX_SOCKET_MODES = ["block", "owned", "allow"] as const;
export type UnixSocketMode = (typeof UNIX_SOCKET_MODES)[number];

/**
 * `safety.homeReads` modes, per caller. `open` reads the whole filesystem as
 * before; `listed` hides the operator's home and, on WSL2, the Windows drive
 * mounts, and shows back only the roots the sandbox admits, PanCode's own
 * paths and what `safety.homeReads.roots` and `toolchains` name.
 */
export const HOME_READ_MODES = ["open", "listed"] as const;
export type HomeReadMode = (typeof HOME_READ_MODES)[number];

/** Named toolchain installs under the home a `listed` sandbox can show back, each a fixed set of home paths. */
export const HOME_READ_TOOLCHAINS = ["nvm", "pyenv", "rustup", "cargo", "go", "uv"] as const;
export type HomeReadToolchain = (typeof HOME_READ_TOOLCHAINS)[number];

/**
 * What a `listed` sandbox shows back beyond the roots it admits on its own, from the operator's own settings file.
 * A root is absolute or starts with `~/`, which means the home of the host the command runs on.
 */
export interface HomeReadList {
	roots: ReadonlyArray<string>;
	toolchains: ReadonlyArray<HomeReadToolchain>;
}

/**
 * How a sandboxed shell reaches the network (`safety.egress.<caller>.mode`).
 * `off` isolates it with no network; `proxied` isolates it and gives it only
 * PanCode's proxy, which admits the caller's granted origins; `open` leaves it
 * on the host network, unmonitored.
 */
export const EGRESS_MODES = ["off", "proxied", "open"] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];

/** `safety.confine` integration classes that take no name; `mcp:` and `extension:` entries name one. */
export const CONFINE_CLASSES = ["hooks", "git", "jobs"] as const;
export type ConfineClass = (typeof CONFINE_CLASSES)[number];

/** Named exact host/port bundles (`safety.egress.<caller>.presets`); egress/policy.ts lists their origins. */
export const EGRESS_PRESET_NAMES = ["npm", "pypi", "github", "crates", "go"] as const;
export type EgressPresetName = (typeof EGRESS_PRESET_NAMES)[number];

/** Whose process launched: the main session, a read-only main run, or a dispatched worker. */
export const SANDBOX_CALLERS = ["main", "main-read-only", "worker"] as const;
export type SandboxCaller = (typeof SANDBOX_CALLERS)[number];

/**
 * What started the process: the shell and command-vector exec seams, the synchronous staging command, and the
 * integration launchers that pick their own policy (an MCP stdio server, a pack's binary or pane, a YAML hook, typed
 * git, grep and find, the sqlite and PDF readers, a job, a code step).
 */
export const SANDBOX_LAUNCHERS = [
	"shell",
	"command",
	"staging",
	"mcp-stdio",
	"extension-binary",
	"extension-pane",
	"yaml-hook",
	"typed-git",
	"search",
	"sqlite",
	"pdf",
	"job",
	"code-step",
] as const;
export type SandboxLauncher = (typeof SANDBOX_LAUNCHERS)[number];

/**
 * How one launch was confined. `sandboxed` runs under the OS backend; `unconfined` would be sandboxed but runs on
 * the host for the reason `why` gives; `host` runs on the host under the operator's own authority.
 */
export const SANDBOX_CONFINEMENTS = ["sandboxed", "unconfined", "host"] as const;
export type SandboxConfinement = (typeof SANDBOX_CONFINEMENTS)[number];

/**
 * Why a launch has its confinement. Sandboxed: the main session's policy, the worker's spec, an operator's opt-in to
 * confine the integration (`safety.confine`), or a launcher confined by default. Unconfined: the operator let this
 * caller run without a backend, the integration is not opted in to confinement, `safety.sandbox` is off, or no
 * backend answered. Host: the operator's own authority. `read-admitted`: a main-session read tool (grep, find) runs
 * on the host, and read admission checks every path it reads.
 */
export const SANDBOX_LAUNCH_WHYS = [
	"main-policy",
	"worker-policy",
	"confine-opt-in",
	"confined-by-default",
	"unconfined-opt-in",
	"not-opted-in",
	"sandbox-off",
	"no-backend",
	"operator-authority",
	"read-admitted",
] as const;
export type SandboxLaunchWhy = (typeof SANDBOX_LAUNCH_WHYS)[number];

/**
 * How a launch ended as the sandbox saw it. `refused`: the planner, or a resource ceiling the host cannot enforce,
 * refused it and nothing ran. `launch-failed`: the spawn, its resource scope or the sandbox's own network setup failed
 * before the command ran. `ran`: the command started; its exit code says how it went.
 */
export const SANDBOX_LAUNCH_OUTCOMES = ["ran", "refused", "launch-failed"] as const;
export type SandboxLaunchOutcome = (typeof SANDBOX_LAUNCH_OUTCOMES)[number];

/**
 * What PanCode's egress proxy did with one origin. `allowed`: the upstream connect completed. `denied`: policy
 * refused it before any dial. `failed`: admitted, but the name did not resolve or the dial did not complete.
 */
export const EGRESS_DECISIONS = ["allowed", "denied", "failed"] as const;
export type EgressDecision = (typeof EGRESS_DECISIONS)[number];

/** Why the proxy denied or failed an origin; an allowed origin carries none. */
export const EGRESS_REASONS = [
	"ungranted",
	"operator-denied",
	"private-literal",
	"private-answer",
	"unresolved",
	"dial-error",
	"dial-timeout",
	"upstream-refused",
	"proxy-closed",
] as const;
export type EgressReason = (typeof EGRESS_REASONS)[number];

/**
 * What admitted an origin: the configured grants and presets, an origin the operator approved earlier this session,
 * or the operator's answer while this launch waited.
 */
export const EGRESS_SOURCES = ["grant", "session", "operator"] as const;
export type EgressSource = (typeof EGRESS_SOURCES)[number];

/** At most this many destinations in one launch record; the rest count as `dropped`. */
export const SANDBOX_RECORD_MAX_DESTINATIONS = 32;
/** At most this many listening ports in one launch record. */
export const SANDBOX_RECORD_MAX_LISTENING_PORTS = 16;

/** The heuristic hints a launch's output can raise. `write-denied`: the output reads like a refused write; no kernel event says so. */
export const SANDBOX_LAUNCH_HINTS = ["write-denied"] as const;
export type SandboxLaunchHint = (typeof SANDBOX_LAUNCH_HINTS)[number];

/** A worker's proxied shell egress, present only when its network goes through PanCode's proxy. */
export interface WorkerEgressSpec {
	/** The exact `host:port` origins the run may reach, presets expanded. */
	origins: ReadonlyArray<string>;
	/** The operator's upstream proxy URL, credentials included; never shown. */
	upstreamProxy?: string;
}

export const WORKER_SANDBOX_SPEC_VERSION = 1;

/**
 * Dispatch fills it from settings and the run's write scope; the worker applies it to every child process it spawns
 * through the shared exec seams. Mode `off` never travels: the field is absent.
 */
export interface WorkerSandboxSpec {
	version: typeof WORKER_SANDBOX_SPEC_VERSION;
	mode: Exclude<SandboxMode, "off">;
	/** Paths bound writable. Empty for a read-only run. */
	writableRoots: ReadonlyArray<string>;
	/**
	 * Paths re-bound read-only after the writable roots, so a writable root
	 * cannot rewrite its own Git metadata or PanCode project policy.
	 */
	readOnlyPaths: ReadonlyArray<string>;
	/** Git metadata the run may write, applied after `readOnlyPaths`: what `git commit` on a task branch needs. */
	gitWritablePaths: ReadonlyArray<string>;
	/**
	 * Paths re-exposed read-only after the private /tmp is mounted. Only paths
	 * under /tmp need it (a worktree or repository that lives there).
	 */
	readableRoots: ReadonlyArray<string>;
	/** False isolates the command in an empty network namespace. */
	network: boolean;
	/**
	 * With `network`, the command reaches only PanCode's proxy, which admits these
	 * origins (`safety.egress.workers.mode: proxied`); absent, `network` is the host's.
	 */
	egress?: WorkerEgressSpec;
	/** `safety.sandboxPassEnv`: variables the environment scrub keeps. Absent when empty. */
	passEnv?: ReadonlyArray<string>;
	/** Credential variables PanCode's own targets read, scrubbed whatever their names. Absent when empty. */
	secretEnv?: ReadonlyArray<string>;
	/** `safety.sandboxUnixSockets` other than `block`. Absent blocks Unix-domain sockets (unix-sockets.ts). */
	unixSockets?: "owned" | "allow";
	/** A target declares `auth.headers`, so the worker's sandbox masks PanCode's settings.yaml as the main session's does. */
	maskSettings?: true;
	/**
	 * The orchestrator found the backend usable where the worker runs: its own
	 * probe for a local worker, the node's recorded check for a fleet node. A
	 * worker whose own probe then fails refuses the command instead of running it direct.
	 */
	backendExpected?: true;
	/**
	 * A local worker only, with `backendExpected`: the full backend this host's own probes found working, so the
	 * worker takes it instead of probing again. It names only a working backend, so it can add confinement and never
	 * remove any: a launch that then fails fails its command. A degraded or missing backend is never carried.
	 */
	probedBackend?: ProbedSandboxBackend;
	/**
	 * Admission found no backend where the worker runs and the operator allowed
	 * it to run unconfined: `safety.sandboxUnconfinedLocalWorkers` for a local
	 * worker, `fleet.nodes[].allowUnsandboxed` for a fleet node. Without it a
	 * worker with no backend refuses its commands. Never set under `required`.
	 */
	unconfined?: true;
	/**
	 * `safety.homeReads.workers` is `listed`: the worker hides its own host's home and Windows drive mounts from its
	 * commands, showing back its roots and these. Absent reads the whole filesystem.
	 */
	homeReads?: HomeReadList;
}

/**
 * How a sandboxed command's inherited environment is scrubbed before the
 * sandbox starts (env-scrub.ts). Credential variables never reach a contained
 * command, which can reach the network without any judgment.
 */
export interface SandboxEnvPolicy {
	/** `safety.sandboxPassEnv`: names kept even when they look like credentials. */
	passEnv: ReadonlyArray<string>;
	/** Credential variables PanCode's own targets read (`auth.apiKeyEnvVar`), removed whatever they are named. */
	secretNames: ReadonlyArray<string>;
	/** A target declares `auth.headers`, so PanCode's settings.yaml holds literal keys and the main-session sandbox masks it. */
	maskSettings?: true;
	/**
	 * Main session only: credential files its contained commands may read, the login files of the targets
	 * `safety.liveCheckTargets` names. Their masks are left off, so they show read-only; every other mask stays.
	 */
	revealFiles?: ReadonlyArray<string>;
}

/** A path hidden from the sandboxed process. Only existing paths can be masked. */
export interface SandboxMaskedPath {
	path: string;
	kind: "directory" | "file";
	/**
	 * Subtrees of a directory mask bound back on top of its empty tmpfs (or re-allowed under Seatbelt),
	 * each `source` (a physical path) at `target`. Read-only unless `writable` is true.
	 */
	reveal?: ReadonlyArray<{ source: string; target: string; writable?: boolean }>;
	/** Bubblewrap only: a directory mask remounted read-only, so nothing can be created in it. */
	readOnly?: true;
}

export type SandboxCommand = { argv: ReadonlyArray<string> } | { shell: string };

/** Everything the pure invocation builders need. All paths are absolute. */
export interface SandboxInvocationSpec {
	command: SandboxCommand;
	cwd: string;
	writableRoots: ReadonlyArray<string>;
	readOnlyPaths?: ReadonlyArray<string>;
	gitWritablePaths?: ReadonlyArray<string>;
	readableRoots?: ReadonlyArray<string>;
	/** True keeps the host's network namespace (egress `open`); false isolates the command. */
	network: boolean;
	/**
	 * Bubblewrap with `network: false` only: run the egress setup ahead of the
	 * command, which hands a loopback listener in the command's namespace to
	 * the host proxy over the launch's IPC descriptor (egress/bridge.ts).
	 */
	egressBridge?: EgressBridgeSetup;
	maskedPaths: ReadonlyArray<SandboxMaskedPath>;
	/** Variables set inside the sandbox, after the spawn environment. */
	setEnv?: Readonly<Record<string, string>>;
	unsetEnv?: ReadonlyArray<string>;
	/**
	 * False keeps the host's /tmp instead of mounting a private one, so a
	 * writable root under it (the yolo script sandbox binds the real /tmp)
	 * reaches the operator's own files. Default true.
	 */
	privateTmp?: boolean;
	/**
	 * Bubblewrap: the seccomp program file (seccomp.ts). The launch opens it on
	 * a file descriptor bwrap reads with `--seccomp`. Absent loads no filter.
	 */
	seccompFilter?: string;
	/** Seatbelt: deny connecting to and binding Unix-domain sockets. Bubblewrap takes `seccompFilter` instead. */
	denyUnixSockets?: boolean;
	/** Directories hidden from reads, with what shows back inside them (home-reads.ts). Absent hides nothing. */
	readRestriction?: SandboxReadRestriction;
}

/**
 * Directories the command cannot read, and the paths under them it can. All
 * paths are physical. Writable, readable and Git roots under a hidden
 * directory show back as the builders bind them; a read-only path or a mask
 * under a hidden directory and outside every root that shows back is left out,
 * since there is nothing there to protect or hide.
 */
export interface SandboxReadRestriction {
	/** Each covered by an empty tmpfs under bubblewrap, remounted read-only once the roots inside are bound. */
	hidden: ReadonlyArray<string>;
	/** Directories and files under a hidden directory bound back read-only, at their own path. */
	exposed: ReadonlyArray<string>;
	/** Symbolic links recreated under a hidden directory: `path` names a root the operator listed, `target` its physical path. */
	links: ReadonlyArray<{ path: string; target: string }>;
}

export interface SandboxInvocation {
	file: string;
	args: string[];
}

/** A full sandbox backend a host probe found working; `networkIsolation` when bubblewrap also isolated the network. */
export interface ProbedSandboxBackend {
	backend: SandboxBackend;
	executable: string;
	networkIsolation?: true;
}

export interface SandboxAvailability {
	available: boolean;
	backend: SandboxBackend | null;
	executable: string | null;
	/** Why the sandbox is unavailable, or a caveat when it is. */
	reason: string | null;
	/**
	 * Bubblewrap only: why the baseline seccomp filter (seccomp.ts) cannot load
	 * here. The sandbox is partial: `required` refuses it, `auto` runs commands
	 * in it and says what is missing. Absent when the filter loads.
	 */
	degraded?: string;
	/**
	 * Unavailable only: the trusted backend binary that was found but could not
	 * build a sandbox here (a kernel or container that forbids its namespaces).
	 * Absent when no usable binary exists at all.
	 */
	found?: string;
}

export const RESOURCE_LIMIT_KEYS = ["memoryMiB", "tasks", "cpuPercent"] as const;
export type ResourceLimitKey = (typeof RESOURCE_LIMIT_KEYS)[number];
/** The largest value each ceiling takes: 16 TiB of memory, the kernel's pid ceiling, a thousand CPUs. */
export const RESOURCE_LIMIT_MAX: Readonly<Record<ResourceLimitKey, number>> = {
	memoryMiB: 16 * 1024 * 1024,
	tasks: 4_194_304,
	cpuPercent: 100_000,
};

/**
 * Opt-in ceilings on one launch's whole process tree (`safety.resources`, P9). Each is aggregate over every process
 * the command starts: `memoryMiB` bounds resident memory with no swap, `tasks` counts processes and threads, and
 * `cpuPercent` is CPU time per wall second, 100 being one core. An absent field is no ceiling. None is a disk quota.
 */
export interface ResourceLimits {
	memoryMiB?: number;
	tasks?: number;
	cpuPercent?: number;
}

/** One caller's block of `safety.resources`: each ceiling a positive integer, or null for none. */
export interface ResourceLimitSettings {
	memoryMiB: number | null;
	tasks: number | null;
	cpuPercent: number | null;
}
