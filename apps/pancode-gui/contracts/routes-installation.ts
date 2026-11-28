// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import { Empty, Id } from "./common.js";
import { NodeAttachment, NodeAttachments, NodeId, NodeMutation, Nodes } from "./nodes.js";
import { Accepted } from "./operations.js";
import { defineRoute, get, operationParams, post } from "./route-schema.js";
import { routes as runtimeRoutes } from "./runtime-routes.js";
import { SetupAnswer, SetupStart, SetupState, SetupStatus } from "./setup.js";
import { Interop, InteropDecided, InteropDecision, InteropQuery, SystemReport } from "./system.js";

/** Nodes, setup, the system report and interop decisions. */
export const installationRoutes = {
	nodes: defineRoute({
		...get,
		params: Type.Object({ id: Id }, { additionalProperties: false }),
		response: Nodes,
		summary: "Read registered SSH nodes and recorded project readiness without probing hosts.",
		...runtimeRoutes.nodes,
	}),
	nodeMutation: defineRoute({
		...post,
		params: Type.Object({ id: Id }, { additionalProperties: false }),
		body: NodeMutation,
		response: Accepted,
		summary: "Register, remove, or explicitly check an SSH node through a serial operation.",
		...runtimeRoutes.nodeMutation,
	}),
	installationNodes: defineRoute({
		...get,
		response: Nodes,
		summary: "Read the registered SSH nodes with no workspace open; readiness is not checked for any project.",
		...runtimeRoutes.installationNodes,
	}),
	installationNodeMutation: defineRoute({
		...post,
		params: Empty,
		body: NodeMutation,
		response: Accepted,
		summary: "Register or remove an SSH node with no workspace open; a readiness check needs a workspace.",
		...runtimeRoutes.installationNodeMutation,
	}),
	nodeAttachments: defineRoute({
		...get,
		response: NodeAttachments,
		summary: "Registered SSH nodes with the state of this app's attachment to each node's own GUI.",
		...runtimeRoutes.nodeAttachments,
	}),
	nodeAttach: defineRoute({
		...post,
		status: 200,
		params: Type.Object({ id: NodeId }, { additionalProperties: false }),
		response: NodeAttachment,
		summary: "Start or resume this app's attachment to the node's own GUI over SSH, answering the current state.",
		...runtimeRoutes.nodeAttach,
	}),
	setupStatus: defineRoute({
		...get,
		query: Type.Object({ workspace: Type.Optional(Id) }, { additionalProperties: false }),
		response: SetupStatus,
		summary: "Read saved chat setup without contacting providers.",
		...runtimeRoutes.setupStatus,
	}),
	setupStart: defineRoute({
		...post,
		params: Empty,
		body: SetupStart,
		response: SetupState,
		status: 200,
		summary: "Host Guided setup from the shared configure wizard.",
		...runtimeRoutes.setupStart,
	}),
	setupState: defineRoute({
		...get,
		params: operationParams,
		response: SetupState,
		summary: "Read the current setup prompt.",
		...runtimeRoutes.setupState,
	}),
	setupAnswer: defineRoute({
		...post,
		params: operationParams,
		body: SetupAnswer,
		response: SetupState,
		status: 200,
		summary: "Answer the current setup prompt.",
		...runtimeRoutes.setupAnswer,
	}),
	setupCancel: defineRoute({
		...post,
		params: operationParams,
		response: SetupState,
		status: 200,
		summary: "Cancel setup before saving.",
		...runtimeRoutes.setupCancel,
	}),

	system: defineRoute({
		...get,
		response: SystemReport,
		summary: "Read-only doctor findings and the four resolved PanCode paths",
		...runtimeRoutes.system,
	}),
	interop: defineRoute({
		...get,
		params: operationParams,
		query: InteropQuery,
		response: Interop,
		summary: "All registered external agents and bounded resource discovery; probe=versions runs each --version",
		...runtimeRoutes.interop,
	}),
	decideInterop: defineRoute({
		...post,
		status: 200,
		params: operationParams,
		body: InteropDecision,
		response: InteropDecided,
		summary: "Accept or decline a proposed delegation peer; accepting adds its settings entry",
		...runtimeRoutes.decideInterop,
	}),
	installationInterop: defineRoute({
		...get,
		query: InteropQuery,
		response: Interop,
		summary: "The same inventory with no workspace open, read where no project layer applies",
		...runtimeRoutes.installationInterop,
	}),
	installationDecideInterop: defineRoute({
		...post,
		status: 200,
		params: Empty,
		body: InteropDecision,
		response: InteropDecided,
		summary: "Accept or decline a proposed delegation peer with no workspace open",
		...runtimeRoutes.installationDecideInterop,
	}),
};
