// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Tool and permission facts: the dispatch plan meta, the worker-ask
 * withdrawal, and the decision, worker-ask and plan facts a permission ask carries.
 */

import type { Static } from "typebox";
import { Type } from "typebox";
import type { DispatchPlanView } from "../../tools/dispatch-plan.js";
import { closed } from "./types.js";

/** Params of the `_pancode/permission/withdraw` notification. */
export interface AcpPermissionWithdrawParams {
	sessionId: string;
	requestId: string;
}

export interface AcpDispatchPlanMeta {
	version: 1;
	topology: DispatchPlanView["topology"];
	taskCount: number;
	/** True when one approval covers several runs, a remote placement, or a gate. */
	planScale: boolean;
	/** sha256 of the rendered plan; a plan-scale run seals exactly this. */
	hash: string;
	costCeilingUsd?: number;
	deadlineMs?: number;
	tasks: Array<{
		agent: string;
		task: string;
		role?: string;
		position?: number;
		target?: string;
		model?: string;
		node?: string;
		nodeKind?: "local" | "ssh";
		worktree?: true;
		apply?: "merge" | "preserve";
		stepId?: string;
		dependencies: string[];
		wave?: number;
	}>;
	/** True when tasks were cut at {@link ACP_DISPATCH_PLAN_MAX_TASKS}. */
	truncated: boolean;
}

const wirePermissionCopy = Type.String({ maxLength: 512 });

export const AcpPermissionDecisionFactsSchema = Type.Object(
	{
		tier: Type.String({ maxLength: 32 }),
		tierLabel: Type.String({ maxLength: 128 }),
		title: Type.String({ maxLength: 512 }),
		semanticToken: Type.Union([Type.Literal("accent"), Type.Literal("action"), Type.Literal("warning")]),
		authorizationCopy: wirePermissionCopy,
		consequenceCopy: wirePermissionCopy,
		reversibilityCopy: wirePermissionCopy,
		requestedByCopy: wirePermissionCopy,
		actionClass: Type.String({ maxLength: 32 }),
		affectedScope: Type.String({ maxLength: 32 }),
		reversibility: Type.String({ maxLength: 32 }),
		target: Type.Optional(Type.String({ maxLength: 512 })),
		/** What a bash command would do, one sentence per step, written by the agent from the full command. */
		consequenceLines: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 9 })),
		/** Which rule held the call: a safety-net rail, the autonomy level, or an answer the operator owes. */
		axis: Type.Optional(
			Type.Union([
				Type.Object({ kind: Type.Literal("safety-net"), ruleId: Type.String({ maxLength: 128 }) }, closed),
				Type.Object({ kind: Type.Literal("autonomy"), level: Type.String({ maxLength: 128 }) }, closed),
				Type.Object({ kind: Type.Literal("answer") }, closed),
			]),
		),
		exposure: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("outward")])),
		/** Size and truncated SHA-256 of a parked write or edit, binding the decision to the exact call. */
		mutation: Type.Optional(
			Type.Object(
				{
					kind: Type.Union([Type.Literal("write"), Type.Literal("edit")]),
					bytes: Type.Integer({ minimum: 0 }),
					replacements: Type.Integer({ minimum: 0 }),
					digest: Type.String({ pattern: "^[0-9a-f]{1,64}$" }),
				},
				closed,
			),
		),
		/** The operator's own last message, read from the session ledger. */
		task: Type.Optional(
			Type.Object({ text: Type.String({ maxLength: 512 }), via: Type.Optional(Type.String({ maxLength: 64 })) }, closed),
		),
	},
	closed,
);

export const AcpWorkerAskFactsSchema = Type.Object(
	{
		requestId: Type.String({ maxLength: 128 }),
		requestedBy: Type.String({ maxLength: 128 }),
		agentId: Type.String({ maxLength: 128 }),
		approvalAuthority: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("operator")])),
		forwardedByMain: Type.Boolean(),
		fallback: Type.Union([Type.Literal("deny"), Type.Literal("fail")]),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	closed,
);

const wirePermissionPlanField = Type.String({ maxLength: 300 });

export const AcpDispatchPlanFactsSchema = Type.Object(
	{
		topology: Type.String({ maxLength: 32 }),
		taskCount: Type.Integer({ minimum: 0 }),
		planScale: Type.Boolean(),
		hash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		costCeilingUsd: Type.Optional(Type.Number({ minimum: 0 })),
		costCeilingDisplay: Type.Optional(Type.String()),
		deadlineMs: Type.Optional(Type.Integer({ minimum: 0 })),
		tasks: Type.Array(
			Type.Object(
				{
					agent: wirePermissionPlanField,
					task: Type.String({ maxLength: 1100 }),
					role: Type.Optional(Type.String({ maxLength: 32 })),
					position: Type.Optional(Type.Integer({ minimum: 0 })),
					target: Type.Optional(wirePermissionPlanField),
					model: Type.Optional(wirePermissionPlanField),
					node: Type.Optional(wirePermissionPlanField),
					nodeKind: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("ssh")])),
					worktree: Type.Optional(Type.Literal(true)),
					apply: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("preserve")])),
					stepId: Type.Optional(wirePermissionPlanField),
					dependencies: Type.Array(wirePermissionPlanField, { maxItems: 8 }),
					wave: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				closed,
			),
			{ maxItems: 32 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);

export type AcpPermissionDecisionFacts = Static<typeof AcpPermissionDecisionFactsSchema>;

export type AcpWorkerAskFacts = Static<typeof AcpWorkerAskFactsSchema>;

export type AcpDispatchPlanFacts = Static<typeof AcpDispatchPlanFactsSchema>;
