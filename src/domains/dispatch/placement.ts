// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Deterministic placement: explicit node, profile pin, session choice, standing preference, then local. Registration alone never moves work. Durable leases own capacity admission. */

import type { PancodeSettings } from "../../core/config.js";
import type { FleetNodeSettings } from "../../core/defaults.js";
import type { FleetRegistry } from "../scheduling/cluster.js";
import type { DispatchNodePlacement } from "./bundle-types.js";
import type { DispatchRequest } from "./contract.js";
import { sessionFleetNode } from "./fleet-placement-preference.js";
import {
	type FleetNodeSandbox,
	fleetNodeSandbox,
	fleetPreflightVerdict,
	readFleetPreflightRecords,
} from "./fleet-preflight.js";
import { createSshWorkerTransport, LOCAL_NODE_ID, localNodeIdentity, type WorkerTransport } from "./transport.js";
import type { RunNodeIdentity, RunNodeReroute } from "./types.js";

export interface FleetPlacementDeps {
	getSettings: () => Readonly<PancodeSettings> | undefined;
	/** Session identity is also available during plan preview, before requests are stamped. */
	getSessionId?: (() => string | null) | undefined;
	fleet: FleetRegistry | undefined;
	/** Transport seam; contract tests substitute a fake ssh channel. */
	transportForNode?: (node: FleetNodeSettings) => WorkerTransport;
	/** Preflight seam; defaults to the durable doctor store. */
	preflightVerdict?: typeof fleetPreflightVerdict;
	/** The placed node's recorded sandbox; defaults to the durable doctor store. */
	nodeSandbox?: typeof fleetNodeSandbox;
}

/** Side-effect-free placement used to build an immutable approval plan. */
export interface FleetPlacementPreview {
	node: RunNodeIdentity;
	/** An SSH node's recorded OS sandbox, null when it has none; absent for local placement. */
	sandbox?: FleetNodeSandbox | null;
}

function admissionError(reason: string): Error {
	return new Error(`dispatch: admission denied: ${reason}`);
}

function unknownNodeError(requested: string, settings: Readonly<PancodeSettings> | undefined): Error {
	if (Object.hasOwn(settings?.fleet?.profiles ?? {}, requested)) {
		return admissionError(
			`unknown fleet node '${requested}'; '${requested}' is a fleet profile. ` +
				"The dispatch node field takes 'local' or a fleet.nodes id. Select the profile target/model in dispatch, or use --agent-profile in the CLI.",
		);
	}
	if (settings?.targets.some((entry) => entry.id === requested)) {
		return admissionError(
			`unknown fleet node '${requested}'; '${requested}' is a target id. ` +
				`The dispatch node field takes 'local' or a fleet.nodes id. Put '${requested}' in target and omit node.`,
		);
	}
	return admissionError(`unknown fleet node '${requested}'`);
}

/**
 * Fill the placement target into reroute hops the retry path left open
 * (fromNode recorded at requeue time, toNode known only at placement).
 */
function completedReroutes(
	reroutes: ReadonlyArray<RunNodeReroute> | undefined,
	toNode: string,
): RunNodeReroute[] | undefined {
	if (!reroutes || reroutes.length === 0) return undefined;
	return reroutes.map((hop) => (hop.toNode.length === 0 ? { ...hop, toNode } : hop));
}

function requestedNodeId(
	req: DispatchRequest,
	settings: Readonly<PancodeSettings> | undefined,
	sessionId: string | null | undefined,
): string | null {
	if (req.node !== undefined && req.node.trim().length > 0) return req.node.trim();
	const workers = settings?.fleet;
	if (!workers) return null;
	const profileName = req.workerProfile ?? workers.agentProfiles?.[req.agentId];
	const pin = profileName ? workers.profiles?.[profileName]?.node : undefined;
	if (pin !== undefined && pin.trim().length > 0) return pin.trim();
	return sessionFleetNode(req.ownerSessionId ?? sessionId) ?? workers.defaultNode ?? null;
}

/**
 * Resolve which node (local or a preflighted online SSH entry) a request maps to, applying `req.reroutes` node
 * exclusions identically for both preview and launch so failover never seals the failed node's sandbox or refuses
 * failover to local.
 */
function selectFleetNode(
	settings: Readonly<PancodeSettings> | undefined,
	deps: FleetPlacementDeps,
	projectRoot: string,
	requested: string | null,
	excludedNodeIds: ReadonlySet<string>,
): { config: FleetNodeSettings; sandbox: FleetNodeSandbox | null } | null {
	const nodes = settings?.fleet?.nodes ?? [];
	const fleet = deps.fleet;
	if (requested !== null) {
		if (requested === LOCAL_NODE_ID) return null;
		const node = nodes.find((entry) => entry.id === requested);
		if (!node) throw unknownNodeError(requested, settings);
		if (fleet === undefined) throw admissionError(`fleet registry unavailable; cannot place on node '${requested}'`);
		const snapshot = fleet.get(node.id);
		if (snapshot && snapshot.state !== "online") {
			throw admissionError(
				`fleet node '${node.id}' is ${snapshot.state}${snapshot.stateReason ? ` (${snapshot.stateReason})` : ""}`,
			);
		}
		// A concurrent --record can replace the file. Admit and describe the node from the same snapshot.
		const records = readFleetPreflightRecords();
		const preflight = (deps.preflightVerdict ?? fleetPreflightVerdict)(node, projectRoot, records);
		if (!preflight.ok) throw admissionError(preflight.reason ?? `node '${node.id}' is not preflighted`);
		return { config: node, sandbox: (deps.nodeSandbox ?? fleetNodeSandbox)(node.id, projectRoot, records) };
	}
	// A node exclusion that also excludes local has no eligible node left:
	// fail closed rather than silently re-running on the excluded local node.
	if (excludedNodeIds.has(LOCAL_NODE_ID)) {
		throw admissionError(`no eligible fleet node remains after excluding ${[...excludedNodeIds].join(", ")}`);
	}
	return null;
}

export function createFleetPlacementResolver(
	deps: FleetPlacementDeps,
): (req: DispatchRequest) => DispatchNodePlacement | null {
	const transportForNode = deps.transportForNode ?? ((node: FleetNodeSettings) => createSshWorkerTransport(node));

	return (req: DispatchRequest): DispatchNodePlacement | null => {
		const settings = deps.getSettings();
		const nodes = settings?.fleet?.nodes ?? [];
		// Failover retries record each failed node as a reroute `fromNode`. Those
		// nodes are excluded from re-selection so a node-scoped failure moves to a
		// different eligible node instead of landing back on the failed one.
		const excludedNodeIds = new Set((req.reroutes ?? []).map((hop) => hop.fromNode).filter((id) => id.length > 0));
		// A profile/agent-binding pin that names an excluded node is overridden by
		// the exclusion (an explicit req.node pin is dropped by the retry path
		// before this runs, so any surviving request is a soft pin).
		let requested = requestedNodeId(req, settings, deps.getSessionId?.());
		if (requested !== null && excludedNodeIds.has(requested)) requested = null;
		// No fleet configured and nothing requested: stay on the pre-fleet
		// local path with no node identity recorded at all.
		if (nodes.length === 0 && requested === null && !req.reroutes?.length) return null;

		const projectRoot = req.taskWorktree?.root ?? req.cwd ?? process.cwd();
		const selected = selectFleetNode(settings, deps, projectRoot, requested, excludedNodeIds);
		if (selected === null) {
			const reroutes = completedReroutes(req.reroutes, LOCAL_NODE_ID);
			return { node: localNodeIdentity(), ...(reroutes !== undefined ? { reroutes } : {}) };
		}
		const transport = transportForNode(selected.config);
		const reroutes = completedReroutes(req.reroutes, selected.config.id);
		return {
			node: transport.node,
			spawn: (spec, opts) => transport.spawn(spec, opts),
			sandbox: selected.sandbox,
			...(reroutes !== undefined ? { reroutes } : {}),
		};
	};
}

/**
 * Resolve the node that the normal placement policy would choose without
 * acquiring capacity. The approved request is subsequently pinned to this
 * node, so a capacity/state change fails launch instead of silently drifting
 * to a different node after approval.
 */
export function createFleetPlacementPreviewResolver(
	deps: FleetPlacementDeps,
): (req: DispatchRequest) => FleetPlacementPreview {
	return (req: DispatchRequest): FleetPlacementPreview => {
		const settings = deps.getSettings();
		const excludedNodeIds = new Set((req.reroutes ?? []).map((hop) => hop.fromNode).filter((id) => id.length > 0));
		let requested = requestedNodeId(req, settings, deps.getSessionId?.());
		if (requested !== null && excludedNodeIds.has(requested)) requested = null;
		const projectRoot = req.taskWorktree?.root ?? req.cwd ?? process.cwd();
		const selected = selectFleetNode(settings, deps, projectRoot, requested, excludedNodeIds);
		if (selected === null) return { node: localNodeIdentity() };
		return {
			node: { id: selected.config.id, kind: "ssh", host: selected.config.host },
			sandbox: selected.sandbox,
		};
	};
}
