// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ChildProcess, IOType, StdioOptions } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type net from "node:net";
import { recordedEgressHost } from "../launch-record.js";
import type { EgressReason } from "../types.js";
import type { EgressGrants } from "./policy.js";
import type { EgressAsk, EgressProxy, EgressReceipt } from "./proxy.js";
import { EGRESS_PROXY_PORT, EGRESS_SETUP_FAILED_EXIT, EGRESS_UNGRANTED as UNGRANTED } from "./setup.js";

/** What the plan carries to the exec seam for a proxied launch: the caller's grants, fixed at plan time. */
export interface EgressBridgePlan {
	grants: EgressGrants;
	/** Attended main shell only. */
	ask?: EgressAsk;
	/** The setting a denied origin would need, named in the denial. */
	denyHint: string;
	/** `safety.egress.upstreamProxy`, credentials included; never shown. */
	upstreamProxy?: string;
}

/** The stdio a proxied launch spawns with: the caller's, plus the IPC channel on descriptor 3. */
export function egressStdio(stdio: readonly (IOType | "ignore" | "inherit")[]): StdioOptions {
	return [stdio[0] ?? "ignore", stdio[1] ?? "pipe", stdio[2] ?? "pipe", "ipc"];
}

/** What one proxied launch did with the network, for its tool result. */
export interface EgressReport {
	receipts: EgressReceipt[];
	/** Ports a process in the launch was listening on when it was stopped; nothing outside could reach them. */
	listeningPorts: number[];
	/** The in-sandbox setup never handed over its listener, so the command did not run. */
	setupFailed: boolean;
	/** What would grant a refused origin. */
	denyHint: string;
	/** Connection attempts no receipt lists, past the proxy's receipt bound. */
	dropped?: number;
	/** Connections the proxy closed unread at its connection limit. */
	shed?: number;
}

/** One proxied launch's host side, alive until the command exits. */
export interface EgressSession {
	receipts(): EgressReceipt[];
	/** Loopback ports a process in the launch's namespace is listening on, other than the proxy's. */
	listeningPorts(): number[];
	/** Records the listening ports now, before a stop kills the namespace. */
	sampleListeners(): void;
	report(exitCode: number | null): EgressReport;
	close(): void;
}

const LISTENER_SAMPLE_MS = 500;

/**
 * Serves one proxied launch: takes the listener the in-sandbox setup sends,
 * tells it to finish, and closes the listener and every
 * proxied connection when the command exits. A launch the setup never reaches
 * fails on its own; nothing here can select `open`.
 */
export function bridgeEgress(child: ChildProcess, plan: EgressBridgePlan): EgressSession {
	// The proxy pulls in node:http, so it loads with the first proxied launch, not with the shell tools.
	let proxy: EgressProxy | null = null;
	let closed = false;
	const loading = import("./proxy.js").then(({ createEgressProxy }) => {
		proxy = createEgressProxy({
			grants: plan.grants,
			denyHint: plan.denyHint,
			...(plan.ask !== undefined ? { ask: plan.ask } : {}),
			...(plan.upstreamProxy !== undefined ? { upstreamProxy: plan.upstreamProxy } : {}),
		});
		if (closed) proxy.close();
		return proxy;
	});
	let received = false;
	const onMessage = (message: unknown, handle: unknown): void => {
		if (received || typeof message !== "object" || message === null) return;
		if ((message as { t?: unknown }).t !== "pancode-egress-listener" || handle === undefined) return;
		received = true;
		const listener = handle as net.Server;
		// The host never disconnects the channel itself: Node then never emits the child's 'close', which the
		// executors settle on. The setup disconnects its end, and the channel ends when the launcher exits.
		loading.then(
			(served) => {
				served.serve(listener);
				if (closed || !child.connected) return;
				child.send({ t: "pancode-egress-ready" });
			},
			() => {
				// Without its proxy the setup times out and the launch fails closed.
				listener.close();
			},
		);
	};
	child.on("message", onMessage);
	const close = (): void => {
		if (closed) return;
		closed = true;
		child.removeListener("message", onMessage);
		proxy?.close();
	};
	const listeningPorts = (): number[] =>
		child.pid === undefined ? [] : namespaceListeningPorts(child.pid, EGRESS_PROXY_PORT);
	// The namespace is gone by the time the launch exits, so the servers still listening at its end are the
	// last sample's: one the command started and left behind dies with it, and the result says so.
	let sampled: number[] = [];
	const sampleListeners = (): void => {
		if (!closed) sampled = listeningPorts();
	};
	const sampler = setInterval(sampleListeners, LISTENER_SAMPLE_MS);
	sampler.unref();
	child.once("exit", () => {
		clearInterval(sampler);
		close();
	});
	child.once("error", () => {
		clearInterval(sampler);
		close();
	});
	return {
		receipts: () => proxy?.receipts() ?? [],
		listeningPorts,
		sampleListeners,
		report: (exitCode) => ({
			receipts: proxy?.receipts() ?? [],
			listeningPorts: [...sampled],
			setupFailed: !received && exitCode === EGRESS_SETUP_FAILED_EXIT,
			denyHint: plan.denyHint,
			...(proxy?.overflow() ?? { dropped: 0, shed: 0 }),
		}),
		close,
	};
}

const NOTE_ORIGINS = 8;

function listOrigins(receipts: ReadonlyArray<EgressReceipt>): string {
	const shown = receipts.slice(0, NOTE_ORIGINS).map((receipt) => {
		const { host: bounded } = recordedEgressHost(receipt);
		const host = bounded.includes(":") ? `[${bounded}]` : bounded;
		return `${host}:${receipt.port}${receipt.count > 1 ? ` ×${receipt.count}` : ""}`;
	});
	const more = receipts.length - shown.length;
	return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** How the note words an admitted origin the proxy could not reach. */
const FAILED_WORDING: Readonly<Partial<Record<EgressReason, string>>> = {
	unresolved: "the name did not resolve",
	"dial-error": "the connection failed",
	"dial-timeout": "the connection timed out",
	"upstream-refused": "the upstream proxy did not open it",
	"proxy-closed": "the proxy closed first",
};

/**
 * The host's note on a proxied command's network: what it reached, what the
 * proxy refused and why, what it admitted but could not reach, what it did
 * not list, and any server it had started, which nothing outside the sandbox
 * could reach. Null when every connection was granted and reached, and no
 * server was left listening.
 */
export function egressResultNote(report: EgressReport | undefined): string | null {
	if (report === undefined) return null;
	if (report.setupFailed)
		return "[egress] the sandbox's network setup failed before the command started, so it did not run; retry it, and if it fails again report it.";
	const parts: string[] = [];
	const denied = report.receipts.filter((receipt) => receipt.decision === "denied");
	const failed = report.receipts.filter((receipt) => receipt.decision === "failed");
	const dropped = report.dropped ?? 0;
	const shed = report.shed ?? 0;
	// A command whose every connection was granted and reached needs no note; its receipts ride in the result details.
	if (denied.length === 0 && failed.length === 0 && dropped === 0 && shed === 0 && report.listeningPorts.length === 0)
		return null;
	const allowed = report.receipts.filter((receipt) => receipt.decision === "allowed");
	if (allowed.length > 0) parts.push(`reached ${listOrigins(allowed)}`);
	for (const reason of new Set(denied.map((receipt) => receipt.reason ?? "denied"))) {
		const hint = reason === UNGRANTED ? `; ${report.denyHint}` : "";
		parts.push(
			`refused ${listOrigins(denied.filter((receipt) => (receipt.reason ?? "denied") === reason))} (${reason}${hint})`,
		);
	}
	for (const code of new Set(failed.map((receipt) => receipt.code ?? "dial-error"))) {
		const matching = failed.filter((receipt) => (receipt.code ?? "dial-error") === code);
		parts.push(`could not reach ${listOrigins(matching)} (${FAILED_WORDING[code] ?? "the connection failed"})`);
	}
	if (dropped > 0) parts.push(`${dropped} more connection attempt${dropped === 1 ? "" : "s"} not listed`);
	if (shed > 0)
		parts.push(`${shed} connection${shed === 1 ? "" : "s"} closed unread at the proxy's limit of open connections`);
	if (report.listeningPorts.length > 0) {
		const ports = report.listeningPorts.join(", ");
		parts.push(
			`a server it started was listening on port ${ports} inside the sandbox, where no browser or other program can reach it, and it stopped with the command; ask the operator to run a server they need to reach from their own terminal`,
		);
	}
	return parts.length === 0 ? null : `[egress] PanCode's proxy: ${parts.join("; ")}.`;
}

function netNamespace(pid: number | "self"): string | null {
	try {
		return readlinkSync(`/proc/${pid}/ns/net`);
	} catch {
		return null;
	}
}

/** The first descendant of `root` that lives in another network namespace than PanCode. */
function namespacedDescendant(root: number): number | null {
	const own = netNamespace("self");
	const queue = [root];
	for (let seen = 0; queue.length > 0 && seen < 64; seen++) {
		const pid = queue.shift() as number;
		const ns = netNamespace(pid);
		if (ns !== null && own !== null && ns !== own) return pid;
		try {
			for (const task of readdirSync(`/proc/${pid}/task`)) {
				const children = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim();
				for (const child of children.length > 0 ? children.split(/\s+/u) : []) queue.push(Number(child));
			}
		} catch {
			// A process that exited while the tree was read has no children left.
		}
	}
	return null;
}

/** TCP ports in LISTEN state in the namespace of a launch's processes. Linux only; empty elsewhere. */
function namespaceListeningPorts(root: number, exclude: number): number[] {
	if (process.platform !== "linux") return [];
	const pid = namespacedDescendant(root);
	if (pid === null) return [];
	const ports = new Set<number>();
	for (const table of ["tcp", "tcp6"]) {
		let text: string;
		try {
			text = readFileSync(`/proc/${pid}/net/${table}`, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/u);
			// st 0A is TCP_LISTEN.
			if (fields[3] !== "0A") continue;
			const port = Number.parseInt(fields[1]?.split(":")[1] ?? "", 16);
			if (Number.isInteger(port) && port !== exclude) ports.add(port);
		}
	}
	return [...ports].sort((a, b) => a - b);
}
