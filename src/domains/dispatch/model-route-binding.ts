// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createServer, isIP } from "node:net";
import { isLoopbackUrl } from "../../core/project-target-urls.js";
import type { ModelRouteBinding } from "../../core/sandbox/egress/model-route-client.js";
import { isDeniedEgressAddress } from "../../core/sandbox/egress/policy.js";
import type { WorkerIsolationMode } from "../../core/sandbox/types.js";
import type { ProvidersContract } from "../providers/index.js";
import { targetRequiresAuth } from "../providers/index.js";
import type { TargetDescriptor } from "../providers/types/target-descriptor.js";
import type { ResolvedTarget } from "./target-resolution.js";

/**
 * `safety.workerIsolation: process` (D14): which launches can run with the credential on the host, behind a model
 * route, and the per-launch route itself. A launch that cannot is refused with the reason, never silently run the
 * old way.
 */

/** The pi-ai APIs whose clients send one bearer- or key-shaped header the route can swap. */
const ROUTED_APIS: ReadonlySet<string> = new Set([
	"openai-codex-responses",
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
]);

const SETTING = "safety.workerIsolation: process";

function unsupported(reason: string): string {
	return `worker isolation unsupported: ${reason}. Set safety.workerIsolation to children in your user settings to run it with the worker holding its credential, or pick another target.`;
}

interface IsolationFacts {
	target: Pick<ResolvedTarget, "target" | "runtime" | "wireModelId">;
	/** Null or a local node. */
	localPlacement: boolean;
	platform?: NodeJS.Platform;
}

/** The provider origin the worker's model and probes address, from the same synthesis the worker runs. */
export function workerModelOrigin(target: IsolationFacts["target"]): { api: string; origin: string } | null {
	try {
		const model = target.runtime.synthesizeModel(target.target, target.wireModelId, null);
		if (!model.baseUrl) return null;
		return { api: model.api, origin: new URL(model.baseUrl).origin };
	} catch {
		return null;
	}
}

/** Why this launch cannot run with process isolation, or null when it can. The check is static; credentials come later. */
export function workerIsolationRefusal(facts: IsolationFacts): string | null {
	const { runtime, target } = facts.target;
	const platform = facts.platform ?? process.platform;
	if (platform !== "linux") return unsupported(`${SETTING} requires Linux bwrap; this host is ${platform}`);
	if (runtime.auth === "claude-cli") return unsupported(`${runtime.id} is a CLI peer that owns its process and login`);
	if (runtime.kind === "sdk") return unsupported(`${runtime.id} is an SDK runtime that holds its own credential`);
	if (runtime.kind !== "http") return unsupported(`${runtime.id} is a CLI peer that owns its process and login`);
	if (!facts.localPlacement)
		return unsupported("this worker is placed on a fleet node, and only workers on this host are routed");
	if (runtime.tier === "local-native")
		return unsupported(`${runtime.id} is a local model server whose residency control needs host loopback`);
	if (!targetRequiresAuth(target, runtime))
		return unsupported(`target ${target.id} needs no credential, so there is nothing to keep on the host`);
	const route = workerModelOrigin(facts.target);
	if (route === null) return unsupported(`target ${target.id} has no model URL to route`);
	if (!ROUTED_APIS.has(route.api))
		return unsupported(`${runtime.id} speaks ${route.api}, whose authentication the model route does not carry`);
	const host = new URL(route.origin).hostname.replace(/^\[|\]$/gu, "");
	if (isLoopbackUrl(route.origin) || (isIP(host) !== 0 && isDeniedEgressAddress(host)))
		return unsupported(`target ${target.id} is served from ${route.origin}, a local or private address`);
	return null;
}

/** Throws the refusal for a native launch under process isolation. */
export function assertWorkerIsolationAdmitted(mode: WorkerIsolationMode | undefined, facts: IsolationFacts): void {
	if (mode !== "process") return;
	const refusal = workerIsolationRefusal(facts);
	if (refusal !== null) throw new Error(`dispatch: ${refusal}`);
}

/** ACP peers run their own agent process with their own login. */
export function assertAcpWorkerIsolationAdmitted(mode: WorkerIsolationMode | undefined, agentId: string): void {
	if (mode === "process")
		throw new Error(`dispatch: ${unsupported(`ACP agent ${agentId} runs its own process with its own login`)}`);
}

/** One launch's route, open on host loopback until the worker exits. */
export interface OpenWorkerModelRoute {
	binding: ModelRouteBinding;
	receipts(): ReturnType<import("../../core/sandbox/egress/model-route.js").ModelRoute["receipts"]>;
	close(): void;
}

function noCredential(target: TargetDescriptor, detail: string | null): Error {
	return new Error(
		`dispatch: worker isolation could not resolve a credential for target ${target.id}${detail ? `: ${detail}` : ""}`,
	);
}

/**
 * Opens the route for one launch and shapes its surrogate from the credential resolved now. The route re-resolves
 * on every request, so an OAuth key refreshed meanwhile is the one sent.
 */
export async function openWorkerModelRoute(
	providers: Pick<ProvidersContract, "auth">,
	target: IsolationFacts["target"],
	signal?: AbortSignal,
): Promise<OpenWorkerModelRoute> {
	const upstream = workerModelOrigin(target);
	if (upstream === null) throw new Error(`dispatch: target ${target.target.id} has no model URL to route`);
	const resolve = async (rejectedApiKey?: string) => {
		const auth = await providers.auth.resolveForTarget(target.target, target.runtime, {
			...(signal !== undefined ? { signal } : {}),
			...(rejectedApiKey !== undefined ? { rejectedApiKey } : {}),
		});
		if (!auth.available || !auth.apiKey) throw noCredential(target.target, auth.detail);
		return {
			apiKey: auth.apiKey,
			...(target.target.auth?.headers !== undefined ? { headers: target.target.auth.headers } : {}),
		};
	};
	const first = await resolve();
	const { createModelRoute, modelRouteSurrogate } = await import("../../core/sandbox/egress/model-route.js");
	const surrogate = modelRouteSurrogate(upstream.api, first.apiKey);
	if (surrogate === null)
		throw new Error(
			`dispatch: worker isolation needs the ChatGPT account in the ${target.runtime.id} login of target ${target.target.id}; sign in again with /login ${target.runtime.id}`,
		);
	const route = createModelRoute({ origin: upstream.origin, surrogate, resolve });
	// Step 1 of D14: the worker still runs on the host, so the route listens on host loopback.
	const listener = createServer().listen(0, "127.0.0.1");
	const port = await new Promise<number>((resolvePort, reject) => {
		listener.once("listening", () => {
			const address = listener.address();
			if (address !== null && typeof address === "object") resolvePort(address.port);
			else reject(new Error("dispatch: the model route listener has no port"));
		});
		listener.once("error", reject);
	}).catch((error: unknown) => {
		route.close();
		listener.close();
		throw error;
	});
	route.serve(listener);
	return {
		binding: { origin: upstream.origin, route: `http://127.0.0.1:${port}`, surrogate },
		receipts: () => route.receipts(),
		close: () => route.close(),
	};
}
