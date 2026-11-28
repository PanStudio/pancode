// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Static } from "typebox";
import { Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const nullableText = Type.Union([Type.String(), Type.Null()]);
export const NodeId = Type.String({ pattern: "^(?!local$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" });
export const NodeAdd = Type.Object(
	{
		id: NodeId,
		host: Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9:][A-Za-z0-9._:-]*$" }),
		user: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*$" })),
		port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
		maxWorkers: Type.Integer({ minimum: 1, maximum: 1024 }),
		labels: Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" }), {
			maxItems: 32,
			uniqueItems: true,
		}),
	},
	closed,
);
export type NodeAdd = Static<typeof NodeAdd>;
export const NodeMutation = Type.Union([
	Type.Object({ action: Type.Literal("add"), node: NodeAdd }, closed),
	Type.Object({ action: Type.Literal("remove"), id: NodeId, confirmed: Type.Literal(true) }, closed),
	Type.Object({ action: Type.Literal("check"), id: NodeId, confirmed: Type.Literal(true) }, closed),
]);
export type NodeMutation = Static<typeof NodeMutation>;
const NodeChecks = Type.Object(
	{
		reachable: Type.Boolean(),
		pancodePresent: Type.Boolean(),
		versionMatch: Type.Boolean(),
		pathParity: Type.Boolean(),
		stateDirWritable: Type.Boolean(),
	},
	closed,
);
export const Node = Type.Object(
	{
		id: NodeId,
		host: Type.String(),
		user: nullableText,
		port: Type.Union([Type.Integer(), Type.Null()]),
		maxWorkers: Type.Integer(),
		labels: Type.Array(Type.String()),
		// The current fleet registry has no enable/disable switch.
		enabled: Type.Null(),
		readiness: Type.Union([
			Type.Literal("not checked"),
			Type.Literal("ready for this project"),
			Type.Literal("needs attention"),
			Type.Literal("offline"),
		]),
		reason: nullableText,
		checkedAt: nullableText,
		ageMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
		checks: Type.Union([NodeChecks, Type.Null()]),
		localVersion: nullableText,
		remoteVersion: nullableText,
		note: nullableText,
		project: Type.Union([
			Type.Null(),
			Type.Object(
				{
					kind: Type.Union([Type.Literal("shared"), Type.Literal("independent"), Type.Literal("unverified")]),
					head: nullableText,
					reason: nullableText,
				},
				closed,
			),
		]),
	},
	closed,
);
export type Node = Static<typeof Node>;
export const Nodes = Type.Object(
	{
		/** Null with no workspace open: the registry is listed, and no project's readiness applies. */
		workspaceId: Type.Union([Id, Type.Null()]),
		projectRoot: Type.Union([Type.String(), Type.Null()]),
		observedAt: Type.String(),
		nodes: Type.Array(Node),
	},
	closed,
);
export type Nodes = Static<typeof Nodes>;

/** How far this app has come in reaching a node's own GUI over SSH. */
export const NodeAttachmentState = Type.Union([
	Type.Literal("detached"),
	Type.Literal("connecting"),
	Type.Literal("ready"),
	Type.Literal("failed"),
	Type.Literal("version-mismatch"),
]);
export type NodeAttachmentState = Static<typeof NodeAttachmentState>;
export const NodeAttachment = Type.Object(
	{
		id: NodeId,
		host: Type.String(),
		state: NodeAttachmentState,
		/** When the state was entered. */
		since: Type.String(),
		/** Why the attachment failed or was refused; null in every other state. */
		detail: nullableText,
		/** Reconnects made since the last explicit open. */
		attempt: Type.Integer({ minimum: 0 }),
		/** When the next reconnect is due, while one is scheduled. */
		retryAt: nullableText,
		/** What the node's own GUI reported about itself once it answered. */
		remote: Type.Union([
			Type.Null(),
			Type.Object({ pancode: Type.String(), build: nullableText, host: Type.String() }, closed),
		]),
	},
	closed,
);
export type NodeAttachment = Static<typeof NodeAttachment>;
export const NodeAttachments = Type.Object({ attachments: Type.Array(NodeAttachment) }, closed);
export type NodeAttachments = Static<typeof NodeAttachments>;
