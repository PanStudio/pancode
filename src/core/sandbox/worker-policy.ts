// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { existsSync } from "node:fs";
import path from "node:path";
import { sandboxUsable } from "./availability.js";
import type { SandboxLaunchTally } from "./launch-record.js";
import {
	type EgressMode,
	type HomeReadList,
	type ResourceLimits,
	type SandboxAvailability,
	type SandboxBackend,
	type SandboxEnvPolicy,
	type SandboxMode,
	type UnixSocketMode,
	WORKER_SANDBOX_SPEC_VERSION,
	type WorkerEgressSpec,
	type WorkerSandboxSpec,
} from "./types.js";
import { readTaskWorktreeGitLayout } from "./worktree-git.js";

export interface WorkerSandboxPolicyInput {
	mode: SandboxMode;
	readOnly: boolean;
	/** The worker's working directory (inside the task worktree when it has one). */
	cwd: string;
	/** Canonical dispatch write boundaries; exact files and trailing-slash subtrees. */
	writeBoundaries: ReadonlyArray<string>;
	taskWorktree?: { path: string; branch: string };
	/** Whether a sandboxed worker command may reach the network. */
	network: boolean;
	/** With `network`: reach it only through PanCode's proxy, to these origins. */
	egress?: WorkerEgressSpec;
	/** Parent checkouts supplying shared task dependencies; also visible when under /tmp. */
	dependencyRoots?: ReadonlyArray<string>;
	/** How the worker's sandboxed commands scrub their inherited environment (env-scrub.ts). */
	env?: SandboxEnvPolicy;
	/** `safety.sandboxUnixSockets`; absent blocks them. */
	unixSockets?: UnixSocketMode;
	/** `safety.homeReads` when the workers' mode is `listed`; absent reads the whole home. */
	homeReads?: HomeReadList;
}

/** Paths inside a writable root that stay read-only, as in Codex's workspace-write mode. */
export function protectedInside(root: string): string[] {
	const base = root.length > 1 ? root.replace(/\/+$/u, "") : root;
	return [path.join(base, ".git"), path.join(base, ".pancode")];
}

/**
 * Dispatch-side policy for one native worker run, or undefined when the
 * operator turned the sandbox off. Writable roots are the run's write
 * boundaries, else its task worktree, else its cwd; a read-only run gets none.
 */
export function resolveWorkerSandboxSpec(input: WorkerSandboxPolicyInput): WorkerSandboxSpec | undefined {
	if (input.mode === "off") return undefined;
	const writableRoots = input.readOnly
		? []
		: input.writeBoundaries.length > 0
			? [...input.writeBoundaries]
			: [input.taskWorktree?.path ?? input.cwd];
	const layout = input.taskWorktree === undefined ? null : readTaskWorktreeGitLayout(input.taskWorktree.path);
	const passEnv = input.env?.passEnv ?? [];
	const secretEnv = input.env?.secretNames ?? [];
	const readableRoots = [
		input.cwd,
		...(input.taskWorktree !== undefined ? [input.taskWorktree.path] : []),
		...(layout !== null ? [layout.commonDir] : []),
		...(input.dependencyRoots ?? []),
	];
	return {
		version: WORKER_SANDBOX_SPEC_VERSION,
		mode: input.mode,
		writableRoots,
		// Exact-file boundaries contain no .git to protect, and binding
		// `<file>/.git` fails bwrap with ENOTDIR, which -try does not skip, so
		// every sandboxed command in a run with file write roots failed.
		readOnlyPaths: [
			...new Set([
				...(input.writeBoundaries.length > 0 && !input.readOnly
					? writableRoots.filter((root) => root.endsWith("/"))
					: writableRoots
				).flatMap(protectedInside),
				...(input.dependencyRoots ?? []),
			]),
		],
		gitWritablePaths: [],
		readableRoots: [...new Set(readableRoots)],
		network: input.network,
		...(input.network && input.egress !== undefined
			? {
					egress: {
						origins: [...input.egress.origins],
						...(input.egress.upstreamProxy !== undefined ? { upstreamProxy: input.egress.upstreamProxy } : {}),
					},
				}
			: {}),
		...(passEnv.length > 0 ? { passEnv: [...passEnv] } : {}),
		...(secretEnv.length > 0 ? { secretEnv: [...secretEnv] } : {}),
		...(input.unixSockets !== undefined && input.unixSockets !== "block" ? { unixSockets: input.unixSockets } : {}),
		...(input.env?.maskSettings === true ? { maskSettings: true as const } : {}),
		...(input.homeReads !== undefined
			? { homeReads: { roots: [...input.homeReads.roots], toolchains: [...input.homeReads.toolchains] } }
			: {}),
	};
}

/** Effective sandbox sealed on a native worker receipt. */
export interface WorkerSandboxReceipt {
	mode: SandboxMode;
	backend: SandboxBackend | null;
	/**
	 * Availability of the OS sandbox where the worker runs (this host's probe for a local worker,
	 * the node's recorded probe for an SSH worker). Null when the mode is off.
	 */
	available: boolean | null;
	reason?: string;
	/** The backend runs without its seccomp baseline, and why. */
	degraded?: string;
	/** No usable backend and the operator allowed this worker's commands to run without one. */
	unconfined?: true;
	writableRoots: ReadonlyArray<string>;
	gitWritablePaths: ReadonlyArray<string>;
	/** Whether the worker's commands could reach any network. */
	network: boolean;
	/**
	 * How they reached it: `proxied` only through PanCode's proxy to the run's
	 * granted origins. Absent on receipts sealed before egress modes.
	 */
	egress?: EgressMode;
	/** What the run's own launch records said happened (sandbox P6); absent on receipts sealed before them. */
	observed?: SandboxLaunchTally;
	/** The sealed `safety.resources.workers` ceilings each command ran under, or was refused for (D13). */
	resources?: { mechanism: "systemd-scope" } & ResourceLimits;
}

/**
 * How a worker's sandboxed commands reach the network on a backend: proxied
 * needs bubblewrap's network namespace, so seatbelt, until the macOS proxy,
 * and a missing backend leave a network grant open.
 */
export function workerEgressMode(spec: WorkerSandboxSpec, availability: SandboxAvailability): EgressMode {
	if (!sandboxUsable(spec.mode, availability)) return spec.unconfined === true ? "open" : "off";
	if (!spec.network) return "off";
	return spec.egress !== undefined && availability.backend === "bwrap" ? "proxied" : "open";
}

export function workerSandboxReceipt(
	spec: WorkerSandboxSpec | undefined,
	availability: SandboxAvailability,
	resources?: ResourceLimits,
): WorkerSandboxReceipt {
	const ceilings = resources === undefined ? {} : { resources: { mechanism: "systemd-scope" as const, ...resources } };
	if (spec === undefined) {
		return {
			mode: "off",
			backend: null,
			available: null,
			writableRoots: [],
			gitWritablePaths: [],
			network: true,
			egress: "open",
			...ceilings,
		};
	}
	const usable = sandboxUsable(spec.mode, availability);
	return {
		mode: spec.mode,
		backend: usable ? availability.backend : null,
		available: availability.available,
		...(availability.reason ? { reason: availability.reason } : {}),
		...(availability.degraded !== undefined ? { degraded: availability.degraded } : {}),
		...(!usable && spec.unconfined === true ? { unconfined: true as const } : {}),
		writableRoots: [...spec.writableRoots],
		gitWritablePaths: [...spec.gitWritablePaths],
		network: spec.network || (!usable && spec.unconfined === true),
		egress: workerEgressMode(spec, availability),
		...ceilings,
	};
}

/**
 * Admitted MCP servers start under the worker's own sandbox, so with network
 * off a server fetched by npx or uvx, or one that reaches a remote API or
 * reads credentials from the masked home, is admitted and then fails on its
 * first call (a proxied worker's servers start with none: the proxy serves only
 * its commands). Admission and the dispatch result say so once, by server, and
 * name the setting; the confinement itself is unchanged. A server the
 * operator granted network starts with it and is not named, unless admission
 * withheld the grant because the run can write the server's code; that one
 * is named with the reason. Null when no admitted server runs confined
 * without network.
 */
export function workerMcpNoNetworkNotice(
	sandbox: Pick<WorkerSandboxReceipt, "mode" | "available" | "network" | "egress">,
	servers: ReadonlyArray<{ serverId: string; network?: true }>,
	withheld: ReadonlyArray<{ serverId: string; reason: string }> = [],
): string | null {
	const held = new Set(withheld.map((entry) => entry.serverId));
	const ids = [
		...new Set(
			servers.filter((entry) => entry.network !== true && !held.has(entry.serverId)).map((entry) => entry.serverId),
		),
	];
	if (
		ids.length + withheld.length === 0 ||
		sandbox.mode === "off" ||
		(sandbox.egress ?? (sandbox.network ? "open" : "off")) === "open" ||
		sandbox.available === false
	) {
		return null;
	}
	const parts: string[] = [];
	if (ids.length > 0) {
		const named = ids.map((id) => `'${id}'`).join(", ");
		const subject = ids.length === 1 ? `MCP server ${named} starts` : `MCP servers ${named} start`;
		parts.push(
			`${subject} inside the worker's OS sandbox with no network, a read-only home and credential directories masked, so a server launched through npx or uvx, or one that needs network or stored credentials, fails on its first call. Grant one server network with pancode mcp trust <id> --network (or network: true in a user declaration), or set safety.egress.workers.mode: open for every sandboxed worker command; the home stays read-only.`,
		);
	}
	// A grant the run's write roots voided is not restored by granting it again.
	for (const entry of withheld) {
		parts.push(
			`MCP server '${entry.serverId}' starts without its network grant because ${entry.reason}, so the worker could rewrite the code that would run with network. A project server runs from the run's own tree, so only a read-only dispatch keeps its grant; a user or plugin server keeps it under write roots that exclude its code.`,
		);
	}
	return `[dispatch sandbox] ${parts.join(" ")}`;
}

/** One sentence for the worker's dynamic safety line. */
export function workerSandboxLine(spec: WorkerSandboxSpec | undefined, availability: SandboxAvailability): string {
	if (spec === undefined) return "Shell sandbox: off.";
	if (!sandboxUsable(spec.mode, availability)) {
		const why = availability.available
			? `partial: ${availability.degraded ?? "no seccomp baseline"}`
			: `unavailable (${availability.reason ?? "no backend"})`;
		return spec.unconfined === true
			? `Shell sandbox: ${why}; the operator allowed your commands to run unconfined, with this account's files and network, so keep them inside your task.`
			: `Shell sandbox: ${why}; shell and verification commands are refused.`;
	}
	// Seatbelt has no private mount: its profile admits the shared system temp
	// directories, and the profile is unverified on macOS (seatbelt.ts), so the
	// worker is told both instead of being promised bubblewrap's isolation.
	const seatbelt = availability.backend === "seatbelt";
	const tmp = seatbelt ? "the shared temp directories" : "a private /tmp";
	const writes = spec.writableRoots.length === 0 ? `only ${tmp}` : `only your writable roots and ${tmp}`;
	// bwrap binds a missing exact-file root with --bind-try, which skips it, so
	// a command can never create that file. The native write tool can, inside
	// the same boundary, so the worker is told to seed the file with it first.
	const missing = spec.writableRoots.filter((root) => !root.endsWith("/") && !existsSync(root));
	const seed =
		missing.length === 0
			? ""
			: ` These write-root files do not exist yet and shell commands cannot create them, so create each with the write tool before any command writes to it: ${missing.join(", ")}.`;
	const backend = seatbelt ? "seatbelt (experimental, unverified macOS profile)" : availability.backend;
	const partial =
		availability.degraded !== undefined ? ` It is partial: no seccomp baseline (${availability.degraded}).` : "";
	const home =
		spec.homeReads !== undefined
			? " The home directory is hidden from your commands except your own roots and the paths the operator listed."
			: "";
	return `Shell sandbox: ${backend}.${partial} Commands you run can write ${writes}; .git and .pancode stay read-only; ${workerNetworkPhrase(spec, availability)}; credential variables are unset and secret files such as .env and private keys cannot be read, so name a command that needs one in your result instead of working around it.${home}${seed}`;
}

function workerNetworkPhrase(spec: WorkerSandboxSpec, availability: SandboxAvailability): string {
	switch (workerEgressMode(spec, availability)) {
		case "off":
			return "network is off";
		case "open":
			return availability.backend === "seatbelt" && spec.egress !== undefined
				? "network is open and unmonitored until PanCode's macOS egress proxy"
				: "network is open";
		case "proxied": {
			const origins = spec.egress?.origins ?? [];
			return origins.length === 0
				? "network goes only through PanCode's proxy, which this run grants no host, so every connection is refused"
				: `network goes only through PanCode's proxy (HTTP(S)_PROXY and ALL_PROXY are set) to ${origins.join(", ")}; any other host is refused, and a server a command starts is reachable only inside the sandbox`;
		}
	}
}
