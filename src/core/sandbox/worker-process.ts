// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { workerSecretPaths } from "../../lib/secrets/secret-paths.js";
import { PANCODE_ARTIFACT_DIR, PANCODE_PROJECT_DIR } from "../artifact-paths.js";
import { canonicalizePath } from "../path-canonical.js";
import { isSameOrDescendant, relativePathEscapes } from "../path-containment.js";
import { pancodeConfigPath } from "../xdg.js";
import { sandboxAvailability, sandboxNetworkIsolation, wslKind } from "./availability.js";
import type { EgressBridgePlan } from "./egress/bridge.js";
import { egressGrants } from "./egress/policy.js";
import { EGRESS_PROXY_PORT, egressProxyEnv } from "./egress/setup.js";
import { planHomeReads } from "./home-reads.js";
import { buildSandboxInvocation } from "./invocation.js";
import type { SandboxPlanFacts } from "./launch-record.js";
import { withMountAliases } from "./mount-aliases.js";
import { missingBaselineLine } from "./seccomp.js";
import { discoverSecretMasks } from "./secret-files.js";
import { holdStartupMountPoints, type StartupPathProtection, startupPathProtection } from "./startup-paths.js";
import type {
	SandboxAvailability,
	SandboxBackend,
	SandboxCommand,
	SandboxEnvPolicy,
	SandboxInvocation,
	SandboxInvocationSpec,
	SandboxMaskedPath,
	WorkerSandboxSpec,
} from "./types.js";
import { sandboxLaunchFilters, unixSocketHostState, unixSocketStateLine } from "./unix-sockets.js";
import { readTaskWorktreeGitLayout } from "./worktree-git.js";

/**
 * Process-wide sandbox policy for a dispatched worker. The worker entry sets
 * it once from its WorkerSpec, the same way it sets commit attribution, and
 * both exec seams (bash-exec and safe-exec) consult it for every child they
 * spawn. The orchestrator never configures it, so main-agent commands keep
 * running unsandboxed.
 */
let active: WorkerSandboxSpec | null = null;
let envelopeConfinesWrites = false;
let unavailableReported = false;
let socketFallbackReported = false;

/**
 * Install this worker's sandbox policy and the host's word on whether it confines the worker's writes, which the
 * envelope sealed (`sandbox.confinesWrites`, fleet M7). The worker never re-derives that fact; a spec that expects a
 * backend this node lacks is refused before any command runs.
 */
export function configureWorkerProcessSandbox(spec: WorkerSandboxSpec | undefined, confinesWrites = false): void {
	active = spec ?? null;
	envelopeConfinesWrites = spec !== undefined && confinesWrites;
	unavailableReported = false;
	socketFallbackReported = false;
}

/** Native edit/write tools run outside the child sandbox, so publication must honor its read-only paths. */
export function workerReadOnlyTargetViolation(
	target: string,
	requiredArtifact?: { cwd: string; path: string },
): string | null {
	if (active === null) return null;
	const candidate = canonicalizePath(target);
	if (candidate === null) return "sandbox: write target could not be resolved";
	// A required artifact is a host-admitted publication, not a writable policy tree.
	// Keep its exact physical destination pinned so a link cannot borrow the exception.
	let artifactPolicyRoot: string | null = null;
	const workspace = requiredArtifact === undefined ? null : canonicalizePath(requiredArtifact.cwd);
	if (workspace !== null && requiredArtifact !== undefined) {
		const artifact = path.resolve(workspace, requiredArtifact.path);
		const relative = path.relative(path.join(workspace, PANCODE_ARTIFACT_DIR), artifact);
		if (
			relative !== "" &&
			!relativePathEscapes(relative) &&
			candidate === artifact &&
			canonicalizePath(artifact) === artifact
		)
			artifactPolicyRoot = path.join(workspace, PANCODE_PROJECT_DIR);
	}
	for (const entry of active.readOnlyPaths) {
		const root = physicalSandboxPath(entry);
		if (root === artifactPolicyRoot) continue;
		if (isSameOrDescendant(candidate, root)) {
			return `sandbox: ${target} is read-only`;
		}
	}
	return null;
}

/**
 * The roots this worker's sandboxed commands may read beyond its workspace: the
 * parent checkout and the dependency trees a RAM task worktree links to. The
 * typed read tools take them as read-exempt so `read node_modules/ms/index.js`
 * reaches what `cat` in the sandbox already can (flywheel s5r2). Empty without
 * a configured sandbox, where no dependency links exist.
 */
export function workerSandboxReadableRoots(): string[] {
	return active === null ? [] : [...active.readableRoots];
}

/**
 * True when every command this worker spawns runs under bubblewrap bound to
 * the spec's writable roots: the envelope's `sandbox.confinesWrites`, the same
 * fact dispatch read before it offered shell and verify to a rooted worker.
 */
export function workerSandboxConfinesWrites(): boolean {
	return active !== null && envelopeConfinesWrites;
}

/**
 * True when every command this worker spawns runs under bubblewrap with no
 * writable root but its private /tmp, as a read-only permit's spec has: the
 * command can change no file outside the sandbox.
 */
export function workerSandboxWritesNothing(): boolean {
	return workerSandboxConfinesWrites() && active !== null && active.writableRoots.length === 0;
}

/** True when this process holds a worker sandbox policy, whether or not a backend can enforce it here. */
export function workerSandboxConfigured(): boolean {
	return active !== null;
}

/** True when this process is a worker whose children, MCP servers included, start under an OS sandbox. */
export function workerSandboxApplies(): boolean {
	return (
		active !== null &&
		withNetworkIsolation(sandboxAvailability(), active.network && active.egress === undefined).available
	);
}

/**
 * System daemon sockets that are root-equivalent for their group, reachable
 * under `safety.sandboxUnixSockets: owned` because another user owns them:
 * Docker, rootful Podman, containerd, LXD (snap and package), libvirt, Incus,
 * CRI-O, k3s's containerd and BuildKit. A runtime directory is masked where the
 * daemon keeps several sockets there (libvirt's modular daemons, containerd's
 * ttrpc socket).
 */
/** Variables naming a socket the sandbox masks; left set, they only produce confusing connection errors. */
export const SANDBOX_UNSET_ENV = ["SSH_AUTH_SOCK", "WSL_INTEROP"] as const;

const DAEMON_SOCKET_PATHS = [
	"run/docker.sock",
	"var/run/docker.sock",
	"run/podman",
	"var/run/podman",
	"run/containerd",
	"var/run/containerd",
	"var/snap/lxd/common/lxd/unix.socket",
	"var/lib/lxd/unix.socket",
	"run/libvirt",
	"var/run/libvirt",
	"var/lib/incus/unix.socket",
	"var/lib/incus/unix.socket.user",
	"run/incus",
	"var/run/incus",
	"run/crio",
	"var/run/crio",
	"run/k3s/containerd",
	"var/run/k3s/containerd",
	"run/buildkit",
	"var/run/buildkit",
];

/**
 * WSL2's Windows interop: the socket a Linux process asks to start a Windows
 * program through (`WSL_INTEROP`), and WSLg's directory, whose sockets reach
 * Windows-side services and whose `distro` entry is this distribution's root
 * again. The seccomp baseline denies the vsock interop also uses.
 */
const WSL2_INTEROP_PATHS = ["run/WSL", "mnt/wslg"];

/**
 * Sockets and runtime directories reachable through the read-only root that
 * would let a sandboxed command act outside it: the session bus, agent
 * sockets under the user runtime directory, the container and
 * virtualization daemons, and WSL2's Windows interop. `root` and `wsl` exist for tests.
 */
function runtimeEscapePaths(root = "/", wsl: "wsl1" | "wsl2" | null = hostWslKind()): string[] {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	return [
		...(uid === null ? [] : [path.join(root, "run", "user", String(uid))]),
		...DAEMON_SOCKET_PATHS.map((entry) => path.join(root, entry)),
		...(wsl === "wsl2" ? WSL2_INTEROP_PATHS.map((entry) => path.join(root, entry)) : []),
	];
}

let hostWsl: "wsl1" | "wsl2" | null | undefined;
function hostWslKind(): "wsl1" | "wsl2" | null {
	hostWsl ??= process.platform === "linux" ? wslKind() : null;
	return hostWsl;
}

/** The escape masks for a filesystem rooted at `root`, without the credential paths. */
export function runtimeEscapeMasksUnder(root: string, wsl: "wsl1" | "wsl2" | null = null): SandboxMaskedPath[] {
	return workerSandboxMaskedPaths(runtimeEscapePaths(root, wsl));
}

/** Existing secret and escape paths, each with the mount kind that hides it. */
function workerSandboxMaskedPaths(candidates?: ReadonlyArray<string>): SandboxMaskedPath[] {
	const masks: SandboxMaskedPath[] = [];
	for (const entry of candidates ?? [...workerSecretPaths(), ...runtimeEscapePaths()]) {
		try {
			// Mask the link's target: bwrap cannot mount over a symlink, and a
			// dotfile link such as ~/.aws -> /mnt/c/... otherwise failed every
			// sandboxed command. The target is what a read would reach.
			const target = realpathSync(entry);
			const stat = statSync(target);
			masks.push({ path: target, kind: stat.isDirectory() ? "directory" : "file" });
		} catch {
			// Absent paths need no mask, and bwrap cannot mount over them anyway.
		}
	}
	return masks;
}

/**
 * The worker sandbox's credential and escape masks, which the yolo script sandbox reuses as they are. Built at
 * every launch, since a credential path that appears mid-session (`gh auth login`, an installed desktop app) has
 * no mask in a list made earlier; it is a few dozen stat calls.
 */
export function workerSandboxMasks(): ReadonlyArray<SandboxMaskedPath> {
	return workerSandboxMaskedPaths();
}

/**
 * The config subtrees readable inside a masked config directory: those PanCode points the model at (read-scope.ts) and
 * the operator-written recipes a contained read-only `pancode` loads. None holds a secret.
 */
const CONFIG_READ_SUBTREES = ["skills", "plugins", "extensions", "agents", "playbooks", "prompts"] as const;

/**
 * Under bubblewrap, PanCode's config directory as one empty tmpfs with the installed skills, plugins and extensions
 * bound back read-only. PanCode rewrites credentials.yaml and settings.yaml by renaming a new file over them, which
 * detaches a mask mounted on the old file inside a running sandbox and shows the new one; a mount on the directory
 * survives that and also hides mcp.yaml, the backups and every temp file a write leaves. With `revealSettings`,
 * settings.yaml is bound back too, for a launch that would not have masked it: the bind holds the inode it was made
 * from, so a host rewrite by rename leaves the command reading the old content, never the new file. Null when the
 * directory is absent or holds one of the run's roots, whose files the command needs; the file masks stand then.
 */
export function pancodeConfigDirMask(
	roots: ReadonlyArray<string>,
	options: { revealSettings: boolean },
): SandboxMaskedPath | null {
	let config: string;
	try {
		config = realpathSync(pancodeConfigPath());
		if (!statSync(config).isDirectory()) return null;
	} catch {
		return null;
	}
	const holdsRoot = roots.some((root) => {
		const rel = path.relative(config, canonicalizePath(root) ?? path.resolve(root));
		return !relativePathEscapes(rel);
	});
	if (holdsRoot) return null;
	const reveal: Array<{ source: string; target: string }> = [];
	for (const name of CONFIG_READ_SUBTREES) {
		const target = path.join(config, name);
		try {
			const source = realpathSync(target);
			if (statSync(source).isDirectory()) reveal.push({ source, target });
		} catch {
			// Nothing installed of this kind.
		}
	}
	if (options.revealSettings) {
		const target = path.join(config, "settings.yaml");
		try {
			const source = realpathSync(target);
			if (statSync(source).isFile()) reveal.push({ source, target });
		} catch {
			// No settings written yet.
		}
	}
	return { path: config, kind: "directory", ...(reveal.length > 0 ? { reveal } : {}) };
}

/**
 * Mount targets must be physical: bwrap would otherwise mount over whatever a
 * symlinked component points at inside the new root, and the /tmp re-exposure
 * compares spellings.
 */
export function physicalSandboxPath(entry: string): string {
	try {
		return realpathSync(entry);
	} catch {
		// Missing paths keep their spelling; the builder binds them with -try.
		return entry;
	}
}

/** Materialize admitted directory boundaries without creating through an escaping link. */
function writableRoot(entry: string, workspace: string): string {
	// Exact-file boundaries cannot be replaced with directories or widened to
	// their parent just to make the mount possible.
	if (!entry.endsWith("/")) return physicalSandboxPath(entry);
	const root = realpathSync(workspace);
	const target = canonicalizePath(entry);
	if (target === null || !isSameOrDescendant(target, root)) {
		throw new Error(`sandbox: writable directory ${entry} resolves outside the worker workspace`);
	}
	// Pin each parent while creating its child: a worker replacing an ancestor
	// with a link cannot redirect this host-side mkdir outside the workspace.
	const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	let directory = openSync(root, flags);
	try {
		for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
			const child = `/proc/self/fd/${directory}/${component}`;
			try {
				mkdirSync(child);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const next = openSync(child, flags);
			closeSync(directory);
			directory = next;
		}
		const created = realpathSync(`/proc/self/fd/${directory}`);
		if (!isSameOrDescendant(created, root))
			throw new Error(`sandbox: writable directory ${entry} escaped the worker workspace`);
		return created;
	} finally {
		closeSync(directory);
	}
}

/** Compose the invocation for one command under a worker policy and the probed backend. */
export function composeWorkerSandboxInvocation(
	policy: WorkerSandboxSpec,
	command: SandboxCommand,
	cwd: string,
	availability: SandboxAvailability,
	maskedPaths: ReadonlyArray<SandboxMaskedPath> = workerSandboxMasks(),
	/** Bubblewrap, network off: run the egress setup that hands the proxy its listener. */
	egressBridge = false,
	startup: ((writableRoots: ReadonlyArray<string>, backend: SandboxBackend) => StartupPathProtection) | null = null,
): SandboxInvocation | null {
	if (!availability.available || availability.backend === null || availability.executable === null) return null;
	const writableRoots = policy.writableRoots.map((entry) =>
		availability.backend === "bwrap" ? writableRoot(entry, policy.readableRoots[0] ?? cwd) : physicalSandboxPath(entry),
	);
	// Every launch loads the baseline seccomp program and refuses new Unix-domain
	// sockets unless the operator allowed them: a socket the command can see may
	// run code outside the sandbox.
	const sockets = sandboxLaunchFilters(
		policy.unixSockets ?? "block",
		availability,
		{ workspaceRoots: [cwd, ...policy.readableRoots, ...writableRoots], privateTmp: true },
		maskedPaths,
	);
	const masks = [...maskedPaths, ...sockets.masks];
	const aliased =
		availability.backend === "bwrap"
			? withMountAliases(masks, undefined, [
					physicalSandboxPath(cwd),
					...policy.readableRoots.map(physicalSandboxPath),
					...writableRoots,
					...policy.gitWritablePaths.map(physicalSandboxPath),
				])
			: masks;
	if (aliased instanceof Error)
		throw new Error(`sandbox: no worker sandbox is available (${aliased.message}); the command was not run`);
	const homeReads =
		policy.homeReads === undefined
			? undefined
			: planHomeReads({
					list: policy.homeReads,
					backend: availability.backend,
					admitted: [
						...new Set([
							...policy.readableRoots.map(physicalSandboxPath),
							...writableRoots,
							...policy.gitWritablePaths.map(physicalSandboxPath),
						]),
					],
					cwd: physicalSandboxPath(cwd),
				});
	if (homeReads instanceof Error) throw new Error(`sandbox: ${homeReads.message}`);
	const protectedStartup = startup?.(writableRoots, availability.backend) ?? { readOnlyPaths: [], masks: [] };
	const spec: SandboxInvocationSpec = {
		command,
		cwd: physicalSandboxPath(cwd),
		writableRoots,
		readOnlyPaths: [...policy.readOnlyPaths.map(physicalSandboxPath), ...protectedStartup.readOnlyPaths],
		gitWritablePaths: policy.gitWritablePaths.map(physicalSandboxPath),
		readableRoots: policy.readableRoots.map(physicalSandboxPath),
		network: policy.network,
		maskedPaths: [...aliased, ...protectedStartup.masks, ...(homeReads?.masks ?? [])],
		...sockets.fields,
		...(homeReads !== undefined ? { readRestriction: homeReads.restriction } : {}),
		unsetEnv: SANDBOX_UNSET_ENV,
		...(egressBridge ? { egressBridge: { execPath: process.execPath, port: EGRESS_PROXY_PORT } } : {}),
		// Under bubblewrap the private /tmp is the only scratch space outside the
		// writable roots, and an inherited TMPDIR elsewhere would be read-only.
		// macOS keeps its per-user TMPDIR, which the seatbelt profile allows.
		...(availability.backend === "bwrap"
			? {
					setEnv: {
						TMPDIR: "/tmp",
						TMP: "/tmp",
						TEMP: "/tmp",
						...(egressBridge ? egressProxyEnv(EGRESS_PROXY_PORT) : {}),
					},
				}
			: {}),
	};
	return buildSandboxInvocation(spec, availability.backend, availability.executable);
}

export type SandboxedSpawnPlan =
	/** `launch` is set when a worker policy let the command run unconfined; absent, no policy applied. */
	| { kind: "direct"; launch?: SandboxPlanFacts }
	| {
			kind: "sandboxed";
			launch: SandboxPlanFacts;
			file: string;
			args: string[];
			env: SandboxEnvPolicy;
			/** Proxied: spawn with `egressStdio` and serve the launch with `bridgeEgress`. */
			egress?: EgressBridgePlan;
			/** Removes the mount points of absent startup paths once the sandbox has exited. */
			afterExit: () => void;
	  }
	| { kind: "refused"; message: string; launch?: SandboxPlanFacts };

/**
 * The trees a worker's command can see that hold the run's own files: its
 * directory write roots and its readable roots (cwd, task worktree, parent
 * checkouts), minus Git metadata, which holds no secret file and is large.
 * A task worktree's repository stands for the checkout it was cut from and
 * every worktree linked to it, whatever the repository directory is named (a
 * bare `repo.git`, a submodule's `.git/modules/<name>`): none is bound, but the
 * sandbox reads the whole filesystem, so their untracked secrets are scanned
 * like the worktree's own. Each linked worktree is its own root, so the
 * checkout's walk skips the ones under `.pancode/worktrees` instead of
 * spending its budget on them.
 */
function workerSecretRoots(policy: WorkerSandboxSpec): string[] {
	const commonDirs = new Set(
		policy.readableRoots.flatMap((root) => {
			const layout = readTaskWorktreeGitLayout(root);
			return layout === null ? [] : [layout.commonDir];
		}),
	);
	const roots = [
		...policy.writableRoots.filter((root) => root.endsWith("/") || isDirectoryPath(root)),
		...policy.readableRoots,
		...[...commonDirs].flatMap((commonDir) => [...mainWorkTree(commonDir), ...linkedWorktrees(commonDir)]),
	];
	return [...new Set(roots)].filter((root) => !root.split(path.sep).includes(".git"));
}

/**
 * The main work tree of a repository directory, read without spawning Git:
 * `core.worktree` when set (a submodule's `.git/modules/<name>`), none for a
 * bare repository, else the directory holding a `.git` directory.
 */
function mainWorkTree(commonDir: string): string[] {
	let config = "";
	try {
		config = readFileSync(path.join(commonDir, "config"), "utf8");
	} catch {
		// No config: Git falls back to the `.git` parent rule below.
	}
	const core = gitConfigSection(config, "core");
	const worktree = core.get("worktree");
	if (worktree !== undefined && worktree.length > 0) return [path.resolve(commonDir, worktree)];
	if (core.get("bare")?.toLowerCase() === "true") return [];
	return path.basename(commonDir) === ".git" ? [path.dirname(commonDir)] : [];
}

/** Lower-cased keys and unquoted values of one plain `[section]` of a Git config file; later entries win. */
function gitConfigSection(config: string, section: string): Map<string, string> {
	const values = new Map<string, string>();
	let inside = false;
	for (const raw of config.split(/\r?\n/u)) {
		const line = raw.trim();
		const header = /^\[\s*([A-Za-z0-9.-]+)\s*\]/u.exec(line);
		if (header !== null) {
			inside = header[1]?.toLowerCase() === section;
			continue;
		}
		if (!inside) continue;
		const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*?))?\s*(?:[#;].*)?$/u.exec(line);
		if (entry?.[1] === undefined) continue;
		values.set(entry[1].toLowerCase(), (entry[2] ?? "true").replace(/^"(.*)"$/u, "$1"));
	}
	return values;
}

/** The work trees linked to a repository, read from each `<common>/worktrees/<id>/gitdir` without spawning Git. */
function linkedWorktrees(commonDir: string): string[] {
	let ids: string[];
	try {
		ids = readdirSync(path.join(commonDir, "worktrees"));
	} catch {
		return [];
	}
	const trees: string[] = [];
	for (const id of ids) {
		try {
			const gitFile = readFileSync(path.join(commonDir, "worktrees", id, "gitdir"), "utf8").trim();
			if (gitFile.length > 0) trees.push(path.dirname(path.resolve(commonDir, "worktrees", id, gitFile)));
		} catch {
			// A pruned or half-made entry names no tree to scan.
		}
	}
	return trees;
}

function isDirectoryPath(entry: string): boolean {
	try {
		return statSync(entry).isDirectory();
	} catch {
		return false;
	}
}

/** Secret files under the worker's own trees, on top of the home credential masks. */
function workerSpawnMasks(policy: WorkerSandboxSpec, backend: SandboxBackend | null, cwd: string): SandboxMaskedPath[] {
	const config =
		backend === "bwrap"
			? pancodeConfigDirMask([cwd, ...policy.writableRoots, ...policy.readableRoots], {
					revealSettings: policy.maskSettings !== true,
				})
			: null;
	const base = [
		...workerSandboxMasks(),
		...(config === null && policy.maskSettings === true ? settingsFileMasks() : []),
	];
	// The config mask goes after the scan, which drops a find inside a masked directory, even a revealed one.
	return [
		...base,
		...(config !== null ? [config] : []),
		...discoverSecretMasks({ workspaceRoots: workerSecretRoots(policy) }, base).masks,
	];
}

/**
 * PanCode's settings.yaml and the copies PanCode leaves beside it (`settings.yaml.bak`, `settings.yaml.v1.bak`, an interrupted
 * write's `.settings.yaml.tmp-*`), which hold the same auth headers. Each regular file is masked at its link target,
 * since bubblewrap cannot mount over a symlink; an absent or unreadable config dir needs no mask.
 */
export function settingsFileMasks(): SandboxMaskedPath[] {
	const dir = pancodeConfigPath();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const masks: SandboxMaskedPath[] = [];
	for (const name of names) {
		if (!name.startsWith("settings.yaml") && !name.startsWith(".settings.yaml.tmp-")) continue;
		try {
			const target = realpathSync(path.join(dir, name));
			if (statSync(target).isFile()) masks.push({ path: target, kind: "file" });
		} catch {
			// A file removed since the listing, or a dangling link, needs no mask.
		}
	}
	return masks;
}

/** Once per worker, on stderr like the unconfined line: the seccomp program could not load, so the sandbox is partial. */
function reportSocketFallback(policy: WorkerSandboxSpec, availability: SandboxAvailability): void {
	if (socketFallbackReported || availability.backend !== "bwrap" || availability.degraded === undefined) return;
	socketFallbackReported = true;
	process.stderr.write(`[worker] sandbox partial: ${missingBaselineLine(availability.degraded)}\n`);
	// Owned masks by choice, so only a blocking policy reports the socket fallback.
	if (policy.unixSockets !== undefined) return;
	const state = unixSocketHostState("block", availability);
	if (state.kind === "masks") process.stderr.write(`[worker] sandbox ${unixSocketStateLine(state)}\n`);
}

/**
 * How one worker launch reaches the network. A proxied policy needs
 * bubblewrap's network namespace and a caller that serves the bridge; under
 * seatbelt it stays open, as the worker's line says, and a synchronous caller
 * gets none.
 */
function launchNetwork(
	policy: WorkerSandboxSpec,
	availability: SandboxAvailability,
	options: { network?: boolean; bridge?: boolean },
): "off" | "proxied" | "open" {
	if (options.network === true) return "open";
	if (!policy.network) return "off";
	if (policy.egress === undefined || availability.backend === "seatbelt") return "open";
	return options.bridge === true ? "proxied" : "off";
}

/** A proxied worker launch's grants: its sealed origins, with no asks (headless). */
function workerEgressPlan(policy: WorkerSandboxSpec): EgressBridgePlan {
	return {
		grants: egressGrants(policy.egress?.origins ?? [], []),
		denyHint: "the operator grants it in safety.egress.workers.allow or presets",
		...(policy.egress?.upstreamProxy !== undefined ? { upstreamProxy: policy.egress.upstreamProxy } : {}),
	};
}

/** A network-off command also needs `--unshare-net`; without it the backend counts as unavailable. */
function withNetworkIsolation(availability: SandboxAvailability, network: boolean): SandboxAvailability {
	if (network) return availability;
	const failure = sandboxNetworkIsolation(availability);
	return failure === null ? availability : { available: false, backend: null, executable: null, reason: failure };
}

/**
 * Decide how one worker child process spawns. No policy means the host runs
 * it directly (orchestrator, or `safety.sandbox: off`). Without a backend the
 * command runs directly only when admission sealed `unconfined` on the
 * policy, and says so once on stderr, which the dispatcher keeps as worker
 * diagnostics; otherwise it is refused. `required` also refuses a partial
 * sandbox, one whose baseline seccomp filter cannot load.
 */
export function planSandboxedSpawn(
	command: SandboxCommand,
	cwd: string,
	typedGitWritablePaths: ReadonlyArray<string> = [],
	options: {
		/** An attested MCP network grant: this process keeps the host's network. */
		network?: boolean;
		/**
		 * The caller spawns asynchronously and serves a returned `egress` plan.
		 * Without it a proxied policy runs the command with no network.
		 */
		bridge?: boolean;
	} = {},
): SandboxedSpawnPlan {
	const policy = active;
	if (policy === null) return { kind: "direct" };
	const probe = (): SandboxAvailability => {
		const found = sandboxAvailability();
		return withNetworkIsolation(found, launchNetwork(policy, found, options) === "open");
	};
	let availability = probe();
	// The orchestrator saw the backend work here; one failed local probe (a
	// timeout is not cached) gets one retry before the command is refused.
	if (!availability.available && policy.backendExpected === true) availability = probe();
	const mode = launchNetwork(policy, availability, options);
	const network = mode === "open";
	const launch: SandboxPlanFacts = {
		caller: "worker",
		confinement: "sandboxed",
		why: "worker-policy",
		backend: availability.available ? availability.backend : null,
		network: mode,
	};
	if (policy.mode === "required" && availability.available && availability.degraded !== undefined) {
		return {
			kind: "refused",
			launch,
			message: `sandbox: safety.sandbox is "required" but the worker sandbox is partial (${missingBaselineLine(availability.degraded)}); the command was not run`,
		};
	}
	// v060 review F1: only the typed Git seam supplies metadata writes, scoped
	// to this invocation; ordinary commands cannot inherit them from a spec.
	let invocation: SandboxInvocation | null;
	let startup: StartupPathProtection = { readOnlyPaths: [], masks: [] };
	try {
		invocation = composeWorkerSandboxInvocation(
			// An attested MCP network grant opens only this one process's network;
			// the masks, read-only home and write roots stay as the policy sets them.
			{ ...policy, gitWritablePaths: typedGitWritablePaths, network },
			command,
			cwd,
			availability,
			availability.available ? workerSpawnMasks(policy, availability.backend, cwd) : workerSandboxMasks(),
			mode === "proxied",
			(roots, backend) => {
				startup = startupPathProtection(roots, backend);
				return startup;
			},
		);
	} catch (error) {
		return { kind: "refused", launch, message: error instanceof Error ? error.message : String(error) };
	}
	if (invocation !== null) {
		reportSocketFallback(policy, availability);
		return {
			kind: "sandboxed",
			launch,
			file: invocation.file,
			args: invocation.args,
			env: { passEnv: policy.passEnv ?? [], secretNames: policy.secretEnv ?? [] },
			...(mode === "proxied" ? { egress: workerEgressPlan(policy) } : {}),
			afterExit: holdStartupMountPoints(startup.masks),
		};
	}
	const reason = availability.reason ?? "no sandbox backend";
	if (policy.mode === "required") {
		return {
			kind: "refused",
			launch,
			message: `sandbox: safety.sandbox is "required" but no worker sandbox is available (${reason}); the command was not run`,
		};
	}
	if (policy.backendExpected === true) {
		return {
			kind: "refused",
			launch,
			message: `sandbox: the orchestrator found a worker sandbox on this host but this worker cannot start it (${reason}); the command was not run`,
		};
	}
	if (policy.unconfined !== true) {
		return {
			kind: "refused",
			launch,
			message: `sandbox: no worker sandbox is available (${reason}) and admission did not allow this worker to run unconfined; the command was not run`,
		};
	}
	if (!unavailableReported) {
		unavailableReported = true;
		process.stderr.write(
			`[worker] sandbox unavailable (${reason}); worker commands run unconfined because the operator allowed it\n`,
		);
	}
	return {
		kind: "direct",
		launch: { caller: "worker", confinement: "unconfined", why: "unconfined-opt-in", backend: null, network: "open" },
	};
}
