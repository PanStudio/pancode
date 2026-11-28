// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ChildProcess } from "node:child_process";
import type net from "node:net";
import { sandboxAvailability, sandboxNetworkIsolation } from "./availability.js";
import { egressGrants } from "./egress/policy.js";
import type { EgressProxy, EgressReceipt } from "./egress/proxy.js";
import { EGRESS_PROXY_PORT, MODEL_ROUTE_PORT, WEB_FETCH_PROXY_PORT } from "./egress/setup.js";
import { scrubSandboxEnv } from "./env-scrub.js";
import { sandboxFilterFile, sandboxFilterProgram } from "./seccomp.js";
import type { SandboxAvailability, WorkerSandboxSpec } from "./types.js";
import { admitPublicOrigin, composeWorkerSandboxInvocation, workerSpawnMasks } from "./worker-process.js";
import { readTaskWorktreeGitLayout, taskWorktreeGitWritablePaths } from "./worktree-git.js";

/**
 * `safety.workerIsolation: process` (D14): the native worker process itself runs under bubblewrap with no network.
 * It reaches its provider through the model route the host serves on the launch's loopback port 3129, and anything
 * else through the host's egress proxy on 3128, which holds the run's sealed child grants. The worker's own children
 * start under their own bwrap inside it, each with the full seccomp baseline.
 */

export interface IsolatedWorkerLaunchInput {
	/** The run's child sandbox policy; the worker gets the same roots and masks, and its settings file masked. */
	policy: WorkerSandboxSpec;
	command: ReadonlyArray<string>;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** What the worker process itself reads beyond the run's roots: the PanCode install, node, the compile cache. */
	exposed: ReadonlyArray<string>;
	/** A task worktree's Git metadata is bound writable, so the worker's typed Git children can commit. */
	taskWorktree?: { path: string; branch: string };
	/** Variables naming the target's credential, dropped even where the operator passes them to children. */
	credentialEnv?: ReadonlyArray<string>;
	availability?: SandboxAvailability;
}

export type IsolatedWorkerLaunch =
	| { kind: "isolated"; file: string; args: string[]; env: NodeJS.ProcessEnv; ports: number[]; executable: string }
	| { kind: "refused"; message: string };

const PROXY_ENV = /^(?:https?|all|no)_proxy$/iu;
const ISOLATED_PORTS = [EGRESS_PROXY_PORT, MODEL_ROUTE_PORT, WEB_FETCH_PROXY_PORT] as const;

function refused(reason: string): IsolatedWorkerLaunch {
	return {
		kind: "refused",
		message: `worker isolation unsupported: ${reason}. Set safety.workerIsolation to children in your user settings to run it with the worker holding its credential.`,
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The bwrap launch for one isolated worker, or why this host cannot start it. Never a fallback to an open worker. */
export function planIsolatedWorkerLaunch(input: IsolatedWorkerLaunchInput): IsolatedWorkerLaunch {
	const availability = input.availability ?? sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap" || availability.executable === null)
		return refused(`process isolation needs bubblewrap (${availability.reason ?? "no bwrap sandbox on this host"})`);
	if (availability.degraded !== undefined)
		return refused(`process isolation needs the seccomp baseline (${availability.degraded})`);
	const isolation = sandboxNetworkIsolation(availability);
	if (isolation !== null) return refused(`process isolation needs a network namespace (${isolation})`);
	// Children load their programs from the state directory, which the isolated worker can only read.
	try {
		for (const unixSockets of [true, false]) {
			const program = sandboxFilterProgram({ unixSockets });
			if (program !== null) sandboxFilterFile(program);
		}
	} catch (error) {
		return refused(`the children's seccomp program could not be written (${message(error)})`);
	}
	const { policy, taskWorktree } = input;
	const layout = taskWorktree === undefined ? null : readTaskWorktreeGitLayout(taskWorktree.path);
	const readable = policy.readableRoots.length > 0 ? policy.readableRoots : [input.cwd];
	const masked: WorkerSandboxSpec = { ...policy, maskSettings: true };
	const outer: WorkerSandboxSpec = {
		...masked,
		network: false,
		gitWritablePaths:
			layout === null || taskWorktree === undefined ? [] : taskWorktreeGitWritablePaths(layout, taskWorktree.branch),
		readableRoots: [...readable, ...input.exposed],
	};
	let invocation: ReturnType<typeof composeWorkerSandboxInvocation>;
	try {
		invocation = composeWorkerSandboxInvocation(
			outer,
			{ argv: input.command },
			input.cwd,
			availability,
			workerSpawnMasks(masked, "bwrap", input.cwd),
			true,
			null,
			{ extraPorts: [MODEL_ROUTE_PORT, WEB_FETCH_PROXY_PORT] },
		);
	} catch (error) {
		return refused(message(error));
	}
	if (invocation === null) return refused("no bwrap sandbox on this host");
	const credentialEnv = new Set(input.credentialEnv ?? []);
	const { env } = scrubSandboxEnv(input.env, {
		passEnv: (policy.passEnv ?? []).filter((name) => !credentialEnv.has(name)),
		secretNames: [...(policy.secretEnv ?? []), ...credentialEnv],
	});
	// The host's proxy is unreachable from the launch's namespace; bwrap sets the launch's own.
	for (const key of Object.keys(env)) if (PROXY_ENV.test(key)) Reflect.deleteProperty(env, key);
	return {
		kind: "isolated",
		file: invocation.file,
		args: invocation.args,
		env,
		ports: [...ISOLATED_PORTS],
		executable: availability.executable,
	};
}

/**
 * The child policy the isolated worker itself applies. Its children's egress goes through the worker's proxy to the
 * host's on 3128, which enforces the run's grants and alone holds the operator's upstream proxy. An `open` run keeps
 * reaching every public origin, but through its own namespace, so no child shares the worker's and its model route.
 */
export function isolatedChildPolicy(policy: WorkerSandboxSpec): WorkerSandboxSpec {
	const { egress, ...rest } = policy;
	if (!policy.network) return rest;
	return {
		...rest,
		egress: {
			origins: egress?.origins ?? [],
			...(egress === undefined ? { open: true as const } : {}),
			upstreamProxy: `http://127.0.0.1:${EGRESS_PROXY_PORT}`,
		},
	};
}

/** The host side of one isolated worker, alive until the worker exits. */
export interface IsolatedWorkerSession {
	/** What the worker and its children reached through the egress proxy. */
	egressReceipts(): EgressReceipt[];
	close(): void;
}

/**
 * Takes the listeners the in-sandbox setup hands over: the model route's goes to `serveModelRoute`, the egress
 * proxy's to a host proxy holding the run's sealed child grants, and typed web_fetch's to one admitting public
 * origins. Once all three are served the setup is told to finish and execs the worker; a launch the host never
 * answers fails on its own.
 */
export function serveIsolatedWorker(
	child: ChildProcess,
	policy: WorkerSandboxSpec,
	serveModelRoute: (listener: net.Server) => void,
): IsolatedWorkerSession {
	const proxies: EgressProxy[] = [];
	let closed = false;
	const loading = import("./egress/proxy.js").then(({ createEgressProxy }) => {
		const children = createEgressProxy({
			grants: egressGrants(policy.network ? (policy.egress?.origins ?? []) : [], []),
			...(policy.network && policy.egress === undefined ? { ask: admitPublicOrigin } : {}),
			denyHint: "the operator grants it in safety.egress.workers.allow or presets",
			...(policy.egress?.upstreamProxy !== undefined ? { upstreamProxy: policy.egress.upstreamProxy } : {}),
		});
		// Typed web_fetch reaches public addresses only, as it does outside isolation, and never a private opt-in.
		const webFetch = createEgressProxy({ grants: egressGrants([], []), ask: admitPublicOrigin });
		proxies.push(children, webFetch);
		if (closed) for (const proxy of proxies) proxy.close();
		return { [EGRESS_PROXY_PORT]: children, [WEB_FETCH_PROXY_PORT]: webFetch } as Record<number, EgressProxy>;
	});
	const pending = new Set<number>(ISOLATED_PORTS);
	let unserved = pending.size;
	const onMessage = (value: unknown, handle: unknown): void => {
		if (typeof value !== "object" || value === null || handle === undefined) return;
		const { t, port } = value as { t?: unknown; port?: unknown };
		if (t !== "pancode-egress-listener" || typeof port !== "number" || !pending.delete(port)) return;
		const listener = handle as net.Server;
		const served =
			port === MODEL_ROUTE_PORT
				? Promise.resolve(serveModelRoute(listener))
				: loading.then((byPort) => byPort[port]?.serve(listener));
		served.then(
			() => {
				unserved -= 1;
				if (unserved === 0 && !closed && child.connected) child.send({ t: "pancode-egress-ready" });
			},
			() => listener.close(),
		);
	};
	child.on("message", onMessage);
	const close = (): void => {
		if (closed) return;
		closed = true;
		child.removeListener("message", onMessage);
		for (const proxy of proxies) proxy.close();
	};
	child.once("exit", close);
	child.once("error", close);
	return { egressReceipts: () => proxies.flatMap((proxy) => proxy.receipts()), close };
}
