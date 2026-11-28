// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** Target, fleet node and endpoint rows, with the route breaker words and health segments. */
import type { PancodeSettings } from "../../core/config.js";
import { capacityLeaseUsage } from "../../domains/dispatch/capacity-lease.js";
import type { RouteBreakerView } from "../../domains/dispatch/contract.js";
import {
	endpointCapacitiesForStatuses,
	endpointCapacityForStatus,
	type ProvidersContract,
	type TargetHealth,
} from "../../domains/providers/index.js";
import type { FleetNodeSnapshot } from "../../domains/scheduling/cluster.js";
import { describeLocalCapacity } from "../../domains/scheduling/local-capacity.js";
import { clockLocal } from "../format-time.js";
import { GLYPH } from "../theme/index.js";
import type { FleetNodeSettingsUi } from "./fleet-node-settings.js";
import { fleetNodeSettingsSubmenu } from "./fleet-node-settings.js";
import type { BuildSettingItemsOptions, SettingsCenterItem, SettingsValueSegment } from "./settings-center-model.js";
import { targetActionsSubmenu } from "./settings-editors.js";
import { settingItem } from "./settings-item-rows.js";

/** One short phrase for a route's breaker, keyed by the model it serves. */
export function routeBreakerPhrase(route: RouteBreakerView): string {
	switch (route.state) {
		case "open":
			return `${route.wireModelId} paused ${Math.ceil(route.remainingMs / 1000)}s after ${route.reason}`;
		case "half-open":
			return `${route.wireModelId} recovering after ${route.reason}; the next call tests it`;
		case "probing":
			return `${route.wireModelId} probing after ${route.reason}`;
		case "closed":
			return `${route.wireModelId} ${route.consecutiveFailures} failure${route.consecutiveFailures === 1 ? "" : "s"} (${route.reason})`;
	}
}

/** The health cell a tripped route takes over: paused first, then a probe in flight, then recovering. */
function routeBreakerSegment(routes: ReadonlyArray<RouteBreakerView>): SettingsValueSegment | null {
	const open = routes.filter((route) => route.state === "open");
	if (open.length > 0) {
		const remainingMs = Math.max(...open.map((route) => route.remainingMs));
		return { text: `${GLYPH.hollow} paused ${Math.ceil(remainingMs / 1000)}s`, tone: "unhealthy" };
	}
	if (routes.some((route) => route.state === "probing")) return { text: `${GLYPH.degraded} probing`, tone: "degraded" };
	if (routes.some((route) => route.state === "half-open"))
		return { text: `${GLYPH.degraded} recovering`, tone: "degraded" };
	return null;
}

export function targetRows(
	settings: Readonly<PancodeSettings>,
	options: BuildSettingItemsOptions | undefined,
): SettingsCenterItem[] {
	const providers = options?.providers;
	const statuses = new Map(providers?.list().map((status) => [status.target.id, status] as const) ?? []);
	const breakers = options?.getRouteBreakers?.() ?? [];
	return settings.connections.map((target) => {
		const status = statuses.get(target.id);
		const roles = [
			settings.chat.connection === target.id ? "chat" : null,
			settings.fleet.default.connection === target.id ? "fleet" : null,
			settings.context.memory.connection === target.id ? "memory" : null,
		].filter((role) => role !== null);
		const health = status?.health.status ?? "unknown";
		const operation = options?.getTargetOperation?.(target.id) ?? null;
		const roleText = roles.length > 0 ? roles.join("+") : GLYPH.none;
		const healthSegment = targetHealthSegment(health);
		const activitySegment: SettingsValueSegment | null = operation
			? {
					text: `${GLYPH.running} ${operation === "connect" ? "connecting" : "probing"}`,
					tone: "activity",
				}
			: null;
		const routes = breakers.filter((route) => route.targetId === target.id);
		const liveHealth = activitySegment ?? routeBreakerSegment(routes) ?? healthSegment;
		const breakerText = routes.length > 0 ? ` ${GLYPH.sep} Breaker: ${routes.map(routeBreakerPhrase).join("; ")}` : "";
		const runtime = status?.runtime?.id ?? target.runtime;
		// A down target's latency is how fast the connection was refused, which read as a healthy `2 ms` beside `down`.
		const latency =
			status?.health.latencyMs === null || status?.health.latencyMs === undefined || status.health.status === "down"
				? GLYPH.none
				: `${status.health.latencyMs} ms`;
		const lastProbe = status?.health.lastCheckAt ? clockLocal(status.health.lastCheckAt) : "never";
		const failureReason = status?.health.lastError ?? (!status?.available && status?.reason ? status.reason : null);
		const valueSegments = [
			liveHealth,
			{ text: `  ${target.id}`, tone: "neutral" as const },
			{ text: `  ${roleText}`, tone: "neutral" as const },
			{ text: `  ${runtime}`, tone: "neutral" as const },
			{ text: `  ${latency}`, tone: "neutral" as const },
		];
		const value = `${health} ${GLYPH.sep} ${target.id} ${GLYPH.sep} ${roleText} ${GLYPH.sep} ${runtime} ${GLYPH.sep} ${latency}${breakerText}`;
		const item = settingItem(`connections.${target.id}`, value, {
			label: target.id,
			description: `URL: ${target.url ?? "(none)"} ${GLYPH.sep} Default model: ${target.defaultModel ?? "(none)"}`,
			// A target with no failure says nothing about one; `Failure reason: none` read as a failure at a glance.
			help: `Last probe: ${lastProbe}${failureReason === null ? "" : ` ${GLYPH.sep} Failure reason: ${failureReason}`}${breakerText}`,
			submenu: targetActionsSubmenu(target.id, options),
			affordance: options?.connectTarget ? "Enter: use, connect, probe, edit, remove" : "Enter: use, probe, edit, remove",
			presentationKind: "status",
			valueSegments,
		});
		item.targetConsole = {
			health: liveHealth,
			id: target.id,
			roles: roleText,
			runtime,
			latency,
			url: target.url ?? "(none)",
			defaultModel: target.defaultModel ?? "(none)",
			lastProbe,
			failureReason: failureReason ?? "none",
		};
		return item;
	});
}

function targetHealthSegment(status: TargetHealth["status"]): SettingsValueSegment {
	switch (status) {
		case "healthy":
			return { text: `${GLYPH.running} healthy`, tone: "healthy" };
		case "degraded":
			return { text: `${GLYPH.degraded} degraded`, tone: "degraded" };
		case "down":
			return { text: `${GLYPH.hollow} down`, tone: "unhealthy" };
		case "unknown":
			return { text: "? unknown", tone: "unknown" };
	}
}

/** Placement and node management share the live scheduler snapshot. */
export function fleetNodeRows(nodes: ReadonlyArray<FleetNodeSnapshot>, ui?: FleetNodeSettingsUi): SettingsCenterItem[] {
	return nodes.map((node) => {
		const bound =
			node.capacityBound === null ? null : describeLocalCapacity({ limit: node.maxWorkers, bound: node.capacityBound });
		const busy = `${node.maxWorkers > 0 ? `${node.activeWorkers}/${node.maxWorkers} busy` : `${node.activeWorkers} busy`}${bound ? ` ${GLYPH.sep} ${bound}` : ""}`;
		const readiness =
			node.state === "offline"
				? "offline"
				: node.kind === "local"
					? "ready"
					: node.verification?.ok
						? "ready for this project"
						: node.verification?.reason?.includes("has not passed")
							? "not checked"
							: "needs attention";
		return settingItem(`fleet.nodes.${node.id}`, `${readiness} ${GLYPH.sep} ${busy}`, {
			label: `node ${node.id}`,
			description: `${node.kind} ${GLYPH.sep} ${node.host}${node.stateReason ? ` ${GLYPH.sep} ${node.stateReason}` : ""}${node.lastSeenAt ? ` ${GLYPH.sep} seen ${clockLocal(node.lastSeenAt)}` : ""}`,
			affordance:
				node.kind === "ssh" && ui
					? "open evidence, test, install or remove"
					: (node.verification?.reason ?? "Local worker capacity"),
			readOnly: node.kind === "local" || !ui,
			...(node.kind === "ssh" && ui ? { submenu: fleetNodeSettingsSubmenu("manage", ui, node.id) } : {}),
			presentationKind: "status",
			valueSegments: [
				{
					text: `${node.state === "online" && (node.kind === "local" || node.verification?.ok) ? GLYPH.running : GLYPH.hollow} ${readiness}`,
					tone: node.state === "online" && (node.kind === "local" || node.verification?.ok) ? "healthy" : "unhealthy",
				},
				{ text: ` ${GLYPH.sep} ${busy}`, tone: "neutral" },
			],
		});
	});
}

/** Read-only endpoint rows show the independent inference scheduler dimension. */
export function fleetEndpointRows(providers: ProvidersContract | undefined): SettingsCenterItem[] {
	if (providers === undefined) return [];
	let usage: Readonly<Record<string, number>> = {};
	try {
		usage = capacityLeaseUsage().endpoints;
	} catch {
		// A damaged capacity file belongs to admission. Settings still shows the configured limits.
	}
	const capacities = endpointCapacitiesForStatuses(providers.list());
	const targetsByEndpoint = new Map<string, string[]>();
	for (const status of providers.list()) {
		const endpoint = endpointCapacityForStatus(status);
		if (endpoint === null) continue;
		targetsByEndpoint.set(endpoint.key, [...(targetsByEndpoint.get(endpoint.key) ?? []), status.target.id]);
	}
	return Object.entries(capacities).map(([key, endpoint]) => {
		const slots = `slots ${usage[key] ?? 0}/${endpoint.limit}`;
		return settingItem(`fleet.endpoints.${key}`, slots, {
			label: `endpoint ${endpoint.label}`,
			description: `Connections: ${(targetsByEndpoint.get(key) ?? []).join(", ")} ${GLYPH.sep} Limit source: ${endpoint.source}`,
			affordance: "read-only inference endpoint capacity",
			readOnly: true,
			presentationKind: "status",
			valueSegments: [{ text: slots, tone: "neutral" }],
		});
	});
}
