// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { request } from "node:http";

/** Never relayed: the worker asks here, with its surrogate, for the credential the upstream rejected to be refreshed. */
export const MODEL_ROUTE_REFRESH_PATH = "/.pancode/model-route/refresh";

/**
 * `refreshed`: a new credential replaces the rejected one, so one retry may succeed. `unchanged`: the host holds the
 * same one (an API key), so a retry would be refused again. `failed`: no credential resolves; the operator must log in.
 */
export type ModelRouteRefreshOutcome = "refreshed" | "unchanged" | "failed";

/** What a routed worker carries in its spec: where its model calls go, and the token that stands in for its key. */
export interface ModelRouteBinding {
	/** The admitted provider origin, `scheme://host[:port]`, as the worker's model and probes address it. */
	origin: string;
	/** The host route, `http://127.0.0.1:<port>`. */
	route: string;
	/** Sent where the API key would be; worthless outside this route. */
	surrogate: string;
}

function originOf(value: string | URL): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

/**
 * Sends every request the worker addresses to the admitted origin over the host route instead, by connection only:
 * the model keeps its real base URL, so request shaping that reads the provider host (pi-ai compat detection, the
 * WebSocket transport choice, cache diagnostics) is the same as a direct call. Fetch, the provider SDKs and the
 * Responses WebSocket all dial through undici's global dispatcher. Call after `installProxyFromEnv`, whose dispatcher
 * keeps every other origin.
 */
export async function installModelRouteDispatcher(binding: ModelRouteBinding): Promise<void> {
	const admitted = originOf(binding.origin);
	const route = originOf(binding.route);
	if (admitted === null || route === null || new URL(route).protocol !== "http:")
		throw new Error(`model route: bad binding ${binding.origin} -> ${binding.route}`);
	const { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } = await import("undici");
	const inner = getGlobalDispatcher();
	// Long model streams and idle WebSockets are the worker's own timeouts' to end, as on a direct connection.
	const routed = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
	class ModelRouteDispatcher extends Dispatcher {
		override dispatch(
			options: Parameters<InstanceType<typeof Dispatcher>["dispatch"]>[0],
			handler: Parameters<InstanceType<typeof Dispatcher>["dispatch"]>[1],
		): boolean {
			if (options.origin !== undefined && originOf(options.origin) === admitted)
				return routed.dispatch({ ...options, origin: route as string }, handler);
			return inner.dispatch(options, handler);
		}
		override async close(): Promise<void> {
			await Promise.all([routed.close(), inner.close()]);
		}
		override async destroy(): Promise<void> {
			await Promise.all([routed.destroy(), inner.destroy()]);
		}
	}
	setGlobalDispatcher(new ModelRouteDispatcher());
}

/**
 * Asks the host route to refresh the credential the provider rejected (#427 under D14). The route alone holds and
 * refreshes it; this process sends its surrogate and learns only the outcome.
 */
export function requestModelRouteRefresh(
	binding: ModelRouteBinding,
	signal?: AbortSignal,
): Promise<ModelRouteRefreshOutcome> {
	return new Promise((resolve, reject) => {
		const req = request(
			new URL(MODEL_ROUTE_REFRESH_PATH, binding.route),
			{
				method: "POST",
				headers: { authorization: `Bearer ${binding.surrogate}`, "content-length": "0" },
				agent: false,
				...(signal !== undefined ? { signal } : {}),
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					if (body.length < 4096) body += chunk;
				});
				res.on("error", reject);
				res.on("end", () => {
					const outcome = res.statusCode === 200 ? parsedOutcome(body) : null;
					if (outcome === null) reject(new Error(`model route: refresh answered ${res.statusCode}: ${body.trim()}`));
					else resolve(outcome);
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function parsedOutcome(body: string): ModelRouteRefreshOutcome | null {
	try {
		const outcome = (JSON.parse(body) as { outcome?: unknown }).outcome;
		return outcome === "refreshed" || outcome === "unchanged" || outcome === "failed" ? outcome : null;
	} catch {
		return null;
	}
}
